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
import { tempoCompatibility, TEMPO_UNMIXABLE_PERCENT } from "../music/tempo.js";
import { energyCompatibility, progressionSmoothness } from "../music/energy.js";
import { bandFor, type ScoreBand } from "../engine/bands.js";
import { readTrajectory, type EnergyTrajectory } from "./trajectory.js";
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

/** A structural problem in the sequence, not just a weak pair. */
export type SetlistIssueKind =
  | "energy-cliff"
  | "bpm-cliff"
  | "key-clash"
  | "repeated-style"
  | "weak-transition";

export interface SetlistIssue {
  kind: SetlistIssueKind;
  /** Index of the link, 0 = the transition out of the track playing now. */
  index: number;
  from: TrackRef;
  to: TrackRef;
  /** 0..1 — how bad, for ordering. */
  severity: number;
  detail: string;
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
  /** Structural problems detected across the sequence, worst first. */
  issues: SetlistIssue[];
  /** The energy shape of the run leading into the current track. */
  trajectory: EnergyTrajectory;
  /** 0..1 overall quality of the sequence as programmed. */
  overallSetScore: number;
  /** Analyses index-aligned with `chain`, so callers need not re-resolve them. */
  analyses: (TrackAnalysis | null)[];
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
      issues: [],
      trajectory: readTrajectory([]),
      overallSetScore: 1,
      analyses: [],
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
      .filter((l) => l.band === "very-poor" || l.band === "poor" || l.band === "acceptable")
      .sort((x, y) => x.score - y.score);

    const issues = detectIssues(chain, analyses, links);
    const trajectory = readTrajectory(analyses.map((a) => a?.energy));

    const reorderableCount = upcoming.filter((t) => t.provider === "queue").length;
    const reorderable = reorderableCount >= 1;

    return {
      chain,
      links,
      flowScore: links.length ? mean(links.map((l) => l.score)) : 1,
      energyFlow: progressionSmoothness(energies),
      weakLinks,
      issues,
      trajectory,
      analyses,
      // The set score is the flow, penalised by structural problems that a
      // pairwise mean cannot see — a single energy cliff ruins a set of
      // otherwise decent transitions.
      overallSetScore: clamp01(
        (links.length ? mean(links.map((l) => l.score)) : 1) -
          issues.reduce((acc, i) => acc + i.severity * 0.12, 0),
      ),
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
    if (
      nextLink.band !== "very-poor" &&
      nextLink.band !== "poor" &&
      nextLink.band !== "acceptable"
    ) {
      return null;
    }

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


// ─────────────────────────────────────────────────────────────────────────────
// Structural problems across a sequence
// ─────────────────────────────────────────────────────────────────────────────

/** An energy step this large is a cliff, not a transition. */
const ENERGY_CLIFF = 0.35;

/** This many consecutive tracks by the same artist reads as a rut. */
const REPEAT_RUN = 3;

export function detectIssues(
  chain: readonly TrackRef[],
  analyses: readonly (TrackAnalysis | null)[],
  links: readonly ChainLink[],
): SetlistIssue[] {
  const issues: SetlistIssue[] = [];

  for (const link of links) {
    const a = analyses[link.index];
    const b = analyses[link.index + 1];
    if (!a || !b) continue;

    if (a.energy !== undefined && b.energy !== undefined) {
      const step = b.energy - a.energy;
      if (Math.abs(step) >= ENERGY_CLIFF) {
        issues.push({
          kind: "energy-cliff",
          index: link.index,
          from: link.from,
          to: link.to,
          severity: clamp01(Math.abs(step) / 0.7),
          detail: `energy ${step > 0 ? "jumps" : "collapses"} ${a.energy.toFixed(2)} → ${b.energy.toFixed(2)}`,
        });
      }
    }

    const t = tempoCompatibility(a.tempo, b.tempo);
    if (a.tempo !== undefined && b.tempo !== undefined && Math.abs(t.deltaPercent) >= TEMPO_UNMIXABLE_PERCENT) {
      issues.push({
        kind: "bpm-cliff",
        index: link.index,
        from: link.from,
        to: link.to,
        severity: clamp01(Math.abs(t.deltaPercent) / 50),
        detail: `${a.tempo.toFixed(0)} → ${b.tempo.toFixed(0)} BPM, ${Math.abs(t.deltaPercent).toFixed(0)}% apart`,
      });
    }

    const k = harmonicCompatibility(a.key, a.mode, b.key, b.mode);
    if (k.from && k.to && k.score < 0.35) {
      issues.push({
        kind: "key-clash",
        index: link.index,
        from: link.from,
        to: link.to,
        severity: clamp01(1 - k.score),
        detail: k.detail,
      });
    }

    if (link.band === "poor" || link.band === "very-poor") {
      issues.push({
        kind: "weak-transition",
        index: link.index,
        from: link.from,
        to: link.to,
        severity: clamp01(1 - link.score),
        detail: `${Math.round(link.score * 100)}% — ${link.band.replace("-", " ")}`,
      });
    }
  }

  // A run by one artist is not a transition problem, it is a programming one.
  let runStart = 0;
  for (let i = 1; i <= chain.length; i++) {
    const sameAsPrev =
      i < chain.length &&
      (chain[i] as TrackRef).artists[0] !== undefined &&
      (chain[i] as TrackRef).artists[0] === (chain[i - 1] as TrackRef).artists[0];
    if (!sameAsPrev) {
      const runLength = i - runStart;
      if (runLength >= REPEAT_RUN) {
        issues.push({
          kind: "repeated-style",
          index: runStart,
          from: chain[runStart] as TrackRef,
          to: chain[i - 1] as TrackRef,
          severity: clamp01(runLength / 6),
          detail: `${runLength} tracks in a row by ${(chain[runStart] as TrackRef).artists[0]}`,
        });
      }
      runStart = i;
    }
  }

  return issues.sort((a, b) => b.severity - a.severity);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sequence optimisation
// ─────────────────────────────────────────────────────────────────────────────

export interface SequenceMove {
  track: TrackRef;
  fromIndex: number;
  toIndex: number;
  reason: string;
}

export interface SetlistPlan {
  /** The order as it stands. */
  current: TrackRef[];
  /** The order this plan proposes. */
  proposed: TrackRef[];
  /** Set score before and after. */
  currentScore: number;
  proposedScore: number;
  moves: SequenceMove[];
  /** True when every move is actually performable on this client. */
  applicable: boolean;
  /** Why it is or is not applicable. */
  note: string;
}

/**
 * Propose a better order for the upcoming tracks.
 *
 * Greedy nearest-neighbour over the pairwise score, restricted to tracks that
 * can actually be moved. It is not a global optimum and does not try to be —
 * the queue is short, the user can override, and a plan nobody can execute is
 * worse than a modest one that works.
 *
 * **Nothing is applied here.** This returns a proposal; applying it is a
 * separate, explicit step, off by default.
 */
export function optimizeSequence(
  currentAnalysis: TrackAnalysis,
  upcoming: readonly TrackRef[],
  analyses: readonly (TrackAnalysis | null)[],
): SetlistPlan {
  const scoreOrder = (order: readonly TrackRef[]): number => {
    const byUri = new Map<string, TrackAnalysis | null>();
    upcoming.forEach((t, i) => byUri.set(t.uri, analyses[i] ?? null));
    let total = 0;
    let count = 0;
    let prev: TrackAnalysis | null = currentAnalysis;
    for (const t of order) {
      const next = byUri.get(t.uri) ?? null;
      if (prev && next) {
        total += linkScore(prev, next);
        count++;
      }
      prev = next ?? prev;
    }
    return count ? total / count : 1;
  };

  const movable = upcoming.filter((t) => t.provider === "queue");
  const fixed = upcoming.filter((t) => t.provider !== "queue");
  const currentScore = scoreOrder(upcoming);

  if (movable.length < 2) {
    return {
      current: [...upcoming],
      proposed: [...upcoming],
      currentScore,
      proposedScore: currentScore,
      moves: [],
      applicable: false,
      note:
        movable.length === 0
          ? "nothing upcoming can be moved — every entry comes from the playing context"
          : "only one movable entry, so there is nothing to reorder",
    };
  }

  // Greedy: repeatedly take the movable track that mixes best from where we are.
  const byUri = new Map<string, TrackAnalysis | null>();
  upcoming.forEach((t, i) => byUri.set(t.uri, analyses[i] ?? null));

  const remaining = [...movable];
  const ordered: TrackRef[] = [];
  let prev: TrackAnalysis | null = currentAnalysis;
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = byUri.get((remaining[i] as TrackRef).uri) ?? null;
      const score = prev && candidate ? linkScore(prev, candidate) : 0.5;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    const picked = remaining.splice(bestIndex, 1)[0] as TrackRef;
    ordered.push(picked);
    prev = byUri.get(picked.uri) ?? prev;
  }

  // Rebuild the full order, leaving immovable entries where they were.
  const proposed: TrackRef[] = [];
  let movableCursor = 0;
  for (const t of upcoming) {
    if (t.provider === "queue") {
      proposed.push(ordered[movableCursor++] as TrackRef);
    } else {
      proposed.push(t);
    }
  }

  const moves: SequenceMove[] = [];
  proposed.forEach((t, toIndex) => {
    const fromIndex = upcoming.findIndex((u) => u.uri === t.uri);
    if (fromIndex !== toIndex) {
      moves.push({
        track: t,
        fromIndex,
        toIndex,
        reason: `moves from position ${fromIndex + 1} to ${toIndex + 1}`,
      });
    }
  });

  const proposedScore = scoreOrder(proposed);
  return {
    current: [...upcoming],
    proposed,
    currentScore,
    proposedScore,
    moves,
    applicable: moves.length > 0 && proposedScore > currentScore + 0.02,
    note:
      moves.length === 0
        ? "the queue is already in the best order these tracks allow"
        : proposedScore > currentScore + 0.02
          ? `set score ${(currentScore * 100).toFixed(0)}% → ${(proposedScore * 100).toFixed(0)}%` +
            (fixed.length > 0
              ? `, leaving ${fixed.length} playlist ${fixed.length === 1 ? "entry" : "entries"} in place`
              : "")
          : "reordering would not meaningfully improve the set",
  };
}
