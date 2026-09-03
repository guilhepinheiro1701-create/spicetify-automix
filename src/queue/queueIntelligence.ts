/**
 * Queue Intelligence.
 *
 * Looks a few tracks ahead, makes sure their analysis is warm before it is
 * needed, and scores each candidate against the track playing now. Spotify's
 * queue is the user's — Smart DJ does not reorder it — so this surfaces
 * recommendations rather than acting on them: which upcoming track would mix
 * best, and whether the one that is actually next is worth a long blend.
 */

import { createLogger } from "../core/logger.js";
import { harmonicCompatibility } from "../music/camelot.js";
import { tempoCompatibility } from "../music/tempo.js";
import { energyCompatibility, progressionSmoothness } from "../music/energy.js";
import type { MusicAnalyzer } from "../analysis/analyzer.js";
import type { TrackAnalysis, TrackRef } from "../core/types.js";

const log = createLogger("queue");

export interface QueueCandidate {
  track: TrackRef;
  /** Position in the queue, 0 = next. */
  position: number;
  analysis: TrackAnalysis | null;
  /** Rough 0..1 compatibility, computed without the full engine. */
  score: number;
  tempoDetail: string;
  keyDetail: string;
  energyDetail: string;
}

export interface QueueReport {
  candidates: QueueCandidate[];
  /** Best-scoring candidate, or null when the queue is empty. */
  best: QueueCandidate | null;
  /** True when a track further down the queue would mix better than the next one. */
  betterOptionAvailable: boolean;
  /** 0..1 — how natural the energy arc of the upcoming tracks is. */
  energyFlow: number;
}

/**
 * A lightweight score used only for ranking the queue. The full weighted model
 * in `engine/scoring.ts` needs a planned exit time and duration, which we do
 * not have for tracks that are several positions away.
 */
export function quickScore(from: TrackAnalysis, to: TrackAnalysis): number {
  const t = tempoCompatibility(from.tempo, to.tempo);
  const k = harmonicCompatibility(from.key, from.mode, to.key, to.mode);
  const e = energyCompatibility(from.energy, to.energy);
  return t.score * 0.42 + k.score * 0.31 + e.score * 0.27;
}

export class QueueIntelligence {
  constructor(private readonly analyzer: MusicAnalyzer) {}

  /** Warm the cache for what is coming, without blocking. */
  prefetch(upcoming: readonly TrackRef[]): void {
    this.analyzer.prefetch(upcoming);
  }

  async report(current: TrackAnalysis | null, upcoming: readonly TrackRef[]): Promise<QueueReport> {
    if (!current || upcoming.length === 0) {
      return { candidates: [], best: null, betterOptionAvailable: false, energyFlow: 1 };
    }

    const candidates: QueueCandidate[] = [];
    for (let i = 0; i < upcoming.length; i++) {
      const track = upcoming[i] as TrackRef;
      const analysis = await this.analyzer.analyze(track).catch(() => null);
      if (!analysis) {
        candidates.push({
          track,
          position: i,
          analysis: null,
          score: 0.5,
          tempoDetail: "unknown",
          keyDetail: "unknown",
          energyDetail: "unknown",
        });
        continue;
      }
      const t = tempoCompatibility(current.tempo, analysis.tempo);
      const k = harmonicCompatibility(current.key, current.mode, analysis.key, analysis.mode);
      const e = energyCompatibility(current.energy, analysis.energy);
      candidates.push({
        track,
        position: i,
        analysis,
        score: t.score * 0.42 + k.score * 0.31 + e.score * 0.27,
        tempoDetail: t.detail,
        keyDetail: k.detail,
        energyDetail: e.detail,
      });
    }

    let best = candidates[0] ?? null;
    for (const c of candidates) if (best && c.score > best.score) best = c;

    const nextScore = candidates[0]?.score ?? 0;
    const betterOptionAvailable = Boolean(best && best.position > 0 && best.score > nextScore + 0.12);

    const energies = [current.energy, ...candidates.map((c) => c.analysis?.energy)].filter(
      (v): v is number => typeof v === "number",
    );
    const energyFlow = progressionSmoothness(energies);

    if (betterOptionAvailable && best) {
      log.debug(
        `"${best.track.name}" (position ${best.position + 1}) would mix better than the next track`,
      );
    }

    return { candidates, best, betterOptionAvailable, energyFlow };
  }
}
