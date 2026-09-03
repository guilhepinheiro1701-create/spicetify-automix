/**
 * Setlist intelligence.
 *
 * A DJ does not think one transition ahead. They look at the next handful of
 * records and notice that the third one is going to be a problem, then do
 * something about it before it arrives.
 *
 * This module scores the whole upcoming chain — A→B→C→D→E — finds the weak
 * links, and, where the player's queue model actually permits it, proposes a
 * reordering that avoids them.
 *
 * The permission boundary is real and worth stating plainly: Spotify's queue is
 * two things stacked. Entries the user queued by hand carry `provider: "queue"`
 * and can be removed and re-added, which is a genuine reorder. Everything else
 * is the *context* — the playlist or album playing through — and removing one
 * of those does not stop it coming round again in its own position. So Smart DJ
 * reorders user-queued entries only, and for a bad transition inside a playlist
 * it reports the problem rather than pretending it can fix it.
 */

import { createLogger } from "../core/logger.js";
import { clamp01, mean } from "../core/util.js";
import { harmonicCompatibility } from "../music/camelot.js";
import { tempoCompatibility } from "../music/tempo.js";
import { energyCompatibility, progressionSmoothness } from "../music/energy.js";
import { bandFor, type ScoreBand } from "../engine/bands.js";
import type { MusicAnalyzer } from "../analysis/analyzer.js";
import type { TrackAnalysis, TrackRef } from "../core/types.js";

const log = createLogger("setlist");

/** Weights for the cheap pairwise score used to rank a chain. */
const CHAIN_WEIGHTS = { tempo: 0.42, key: 0.31, energy: 0.27 } as const;

export interface ChainLink {
  from: TrackRef;
  to: TrackRef;
  /** 0..1 */
  score: number;
  band: ScoreBand;
  /** Position of `from` in the chain, 0 = the track playing now. */
  index: number;
  tempoDetail: string;
  keyDetail: string;
  energyDetail: string;
}

export interface SetlistReport {
  /** The tracks considered, starting with the one playing now. */
  chain: TrackRef[];
  links: ChainLink[];
  /** Mean link score, 0..1. */
  flowScore: number;
  /** 0..1 — how natural the energy arc reads across the chain. */
  energyFlow: number;
  /** Links scoring below the acceptable band, worst first. */
  weakLinks: ChainLink[];
  /** True when at least one upcoming entry is a user-queued, reorderable track. */
  reorderable: boolean;
  /** Why reordering is or is not possible, for the UI. */
  reorderNote: string;
}

/** The pairwise score used for ranking a chain, without a planned geometry. */
export function linkScore(from: TrackAnalysis, to: TrackAnalysis): number {
  const t = tempoCompatibility(from.tempo, to.tempo);
  const k = harmonicCompatibility(from.key, from.mode, to.key, to.mode);
  const e = energyCompatibility(from.energy, to.energy);
  return clamp01(
    t.score * CHAIN_WEIGHTS.tempo + k.score * CHAIN_WEIGHTS.key + e.score * CHAIN_WEIGHTS.energy,
  );
}

export interface ReorderProposal {
  /** The track to pull forward so it plays next. */
  promote: TrackRef;
  /** Its current position in the chain (1 = next). */
  fromIndex: number;
  /** Score of the transition we are replacing. */
  currentScore: number;
  /** Score of the transition we would get instead. */
  proposedScore: number;
  reason: string;
}

export class SetlistPlanner {
  constructor(private readonly analyzer: MusicAnalyzer) {}

  /** Warm the cache for what is coming, without blocking. */
  prefetch(upcoming: readonly TrackRef[]): void {
    this.analyzer.prefetch(upcoming);
  }

  /**
   * Score the chain. `current` plays now; `upcoming` are the next entries in
   * order. Analysis is resolved from the cache where possible.
   */
  async report(
    current: TrackRef | null,
    currentAnalysis: TrackAnalysis | null,
    upcoming: readonly TrackRef[],
  ): Promise<SetlistReport> {
    const empty: SetlistReport = {
      chain: current ? [current] : [],
      links: [],
      flowScore: 1,
      energyFlow: 1,
      weakLinks: [],
      reorderable: false,
      reorderNote: "nothing queued",
    };
    if (!current || !currentAnalysis || upcoming.length === 0) return empty;

    const chain = [current, ...upcoming];
    const analyses: (TrackAnalysis | null)[] = [currentAnalysis];
    for (const t of upcoming) {
      analyses.push(await this.analyzer.analyze(t).catch(() => null));
    }

    const links: ChainLink[] = [];
    for (let i = 0; i < chain.length - 1; i++) {
      const a = analyses[i];
      const b = analyses[i + 1];
      const from = chain[i] as TrackRef;
      const to = chain[i + 1] as TrackRef;
      if (!a || !b) {
        links.push({
          from,
          to,
          score: 0.5,
          band: "acceptable",
          index: i,
          tempoDetail: "unknown",
          keyDetail: "unknown",
          energyDetail: "unknown",
        });
        continue;
      }
      const score = linkScore(a, b);
      links.push({
        from,
        to,
        score,
        band: bandFor(score).band,
        index: i,
        tempoDetail: tempoCompatibility(a.tempo, b.tempo).detail,
        keyDetail: harmonicCompatibility(a.key, a.mode, b.key, b.mode).detail,
        energyDetail: energyCompatibility(a.energy, b.energy).detail,
      });
    }

    const energies = analyses
      .map((a) => a?.energy)
      .filter((v): v is number => typeof v === "number");

    const weakLinks = links
      .filter((l) => l.band === "poor" || l.band === "acceptable")
      .sort((x, y) => x.score - y.score);

    const reorderableCount = upcoming.filter((t) => t.provider === "queue").length;
    const reorderable = reorderableCount >= 1;

    return {
      chain,
      links,
      flowScore: links.length ? mean(links.map((l) => l.score)) : 1,
      energyFlow: progressionSmoothness(energies),
      weakLinks,
      reorderable,
      reorderNote: reorderable
        ? `${reorderableCount} upcoming ${reorderableCount === 1 ? "entry is" : "entries are"} user-queued and can be reordered`
        : upcoming.length > 0
          ? "everything upcoming comes from the playing context — Smart DJ cannot reorder those without duplicating them"
          : "nothing queued",
    };
  }

  /**
   * Would a different upcoming track make a better next transition?
   *
   * Only user-queued entries are candidates, because they are the only ones we
   * can move without leaving a duplicate behind. The improvement has to be
   * clearly worth the intrusion, not a rounding difference.
   */
  async proposeReorder(
    report: SetlistReport,
    minimumGain = 0.15,
  ): Promise<ReorderProposal | null> {
    const nextLink = report.links[0];
    if (!nextLink) return null;
    // Only intervene when the next transition is genuinely weak.
    if (nextLink.band !== "poor" && nextLink.band !== "acceptable") return null;

    const currentAnalysis = await this.analyzer
      .analyze(nextLink.from)
      .catch(() => null);
    if (!currentAnalysis) return null;

    let best: ReorderProposal | null = null;
    for (let i = 1; i < report.chain.length; i++) {
      const candidate = report.chain[i] as TrackRef;
      if (candidate.provider !== "queue") continue;
      if (candidate.uri === nextLink.to.uri) continue;

      const analysis = await this.analyzer.analyze(candidate).catch(() => null);
      if (!analysis) continue;

      const score = linkScore(currentAnalysis, analysis);
      const gain = score - nextLink.score;
      if (gain < minimumGain) continue;
      if (best && score <= best.proposedScore) continue;

      best = {
        promote: candidate,
        fromIndex: i,
        currentScore: nextLink.score,
        proposedScore: score,
        reason:
          `"${candidate.name}" would mix at ${(score * 100).toFixed(0)}% ` +
          `against ${(nextLink.score * 100).toFixed(0)}% for "${nextLink.to.name}"`,
      };
    }

    if (best) log.debug(`reorder candidate: ${best.reason}`);
    return best;
  }
}
