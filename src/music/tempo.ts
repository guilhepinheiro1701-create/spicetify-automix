/**
 * Tempo compatibility.
 *
 * DJ practice: a pitch fader of ±6% is the vinyl-era standard and roughly one
 * semitone of pitch shift; ±8% is the usual limit for same-genre mixing.
 * Because the Spotify client exposes no playback-rate control for music we can
 * never actually warp a track — so this module's job is to say how well two
 * tempos already agree, and to spot the half/double-time relationships that let
 * a 70 BPM track sit convincingly under a 140 BPM one.
 */

import { clamp01 } from "../core/util.js";

/** Comfortable beatmatch window, in percent. */
export const TEMPO_TOLERANCE_COMFORT = 3;
/** Vinyl-standard window — still a clean mix. */
export const TEMPO_TOLERANCE_GOOD = 6;
/** Outer limit of same-genre mixing. */
export const TEMPO_TOLERANCE_MAX = 8;

export interface TempoMatch {
  /** 0..1 */
  score: number;
  /** 1 = direct, 2 = B plays at double A's felt tempo, 0.5 = half-time. */
  ratio: number;
  /** Signed percent difference of B against the ratio-folded A. */
  deltaPercent: number;
  /** Tempo change that *would* be needed for a true beatmatch. */
  requiredAdjustPercent: number;
  /** True when the match relies on a half/double-time reading. */
  usesTempoFolding: boolean;
  detail: string;
}

const UNKNOWN: TempoMatch = {
  score: 0.5,
  ratio: 1,
  deltaPercent: 0,
  requiredAdjustPercent: 0,
  usesTempoFolding: false,
  detail: "tempo unknown — neutral score",
};

/**
 * Map a percentage difference to a 0..1 score.
 * Flat-ish inside the comfort window, steep past the vinyl limit, effectively
 * zero once you are far enough apart that no DJ would attempt a blend.
 */
export function tempoScoreFromDelta(absDeltaPercent: number): number {
  const d = Math.abs(absDeltaPercent);
  if (d <= TEMPO_TOLERANCE_COMFORT) {
    // 1.00 → 0.94 across the comfort window
    return 1 - (d / TEMPO_TOLERANCE_COMFORT) * 0.06;
  }
  if (d <= TEMPO_TOLERANCE_GOOD) {
    // 0.94 → 0.76
    return 0.94 - ((d - TEMPO_TOLERANCE_COMFORT) / (TEMPO_TOLERANCE_GOOD - TEMPO_TOLERANCE_COMFORT)) * 0.18;
  }
  if (d <= TEMPO_TOLERANCE_MAX) {
    // 0.76 → 0.62
    return 0.76 - ((d - TEMPO_TOLERANCE_GOOD) / (TEMPO_TOLERANCE_MAX - TEMPO_TOLERANCE_GOOD)) * 0.14;
  }
  if (d <= 20) {
    // 0.62 → 0.10, the "you need a creative transition" zone
    return 0.62 - ((d - TEMPO_TOLERANCE_MAX) / (20 - TEMPO_TOLERANCE_MAX)) * 0.52;
  }
  // Past 20% nothing blends; decay to a small floor so ordering stays sane.
  return clamp01(0.1 - (d - 20) * 0.002);
}

/** Half/double-time matching costs a little: it works, but it is a choice. */
const FOLDING_PENALTY = 0.94;

export function tempoCompatibility(
  bpmA: number | undefined,
  bpmB: number | undefined,
): TempoMatch {
  if (!isUsableBpm(bpmA) || !isUsableBpm(bpmB)) return { ...UNKNOWN };

  const a = bpmA as number;
  const b = bpmB as number;

  const candidates: { ratio: number; effectiveA: number }[] = [
    { ratio: 1, effectiveA: a },
    { ratio: 2, effectiveA: a * 2 },
    { ratio: 0.5, effectiveA: a / 2 },
  ];

  let best = candidates[0] as { ratio: number; effectiveA: number };
  let bestAbs = Infinity;
  for (const c of candidates) {
    const abs = Math.abs((b - c.effectiveA) / c.effectiveA) * 100;
    if (abs < bestAbs) {
      bestAbs = abs;
      best = c;
    }
  }

  const deltaPercent = ((b - best.effectiveA) / best.effectiveA) * 100;
  const usesTempoFolding = best.ratio !== 1;
  const raw = tempoScoreFromDelta(deltaPercent);
  const score = usesTempoFolding ? raw * FOLDING_PENALTY : raw;

  const detail = usesTempoFolding
    ? `${a.toFixed(1)} → ${b.toFixed(1)} BPM via ${best.ratio === 2 ? "double" : "half"}-time (${deltaPercent >= 0 ? "+" : ""}${deltaPercent.toFixed(1)}%)`
    : `${a.toFixed(1)} → ${b.toFixed(1)} BPM (${deltaPercent >= 0 ? "+" : ""}${deltaPercent.toFixed(1)}%)`;

  return {
    score,
    ratio: best.ratio,
    deltaPercent,
    // To beatmatch you would slow/speed B onto A's grid.
    requiredAdjustPercent: -deltaPercent,
    usesTempoFolding,
    detail,
  };
}

export function isUsableBpm(bpm: number | undefined): boolean {
  return typeof bpm === "number" && Number.isFinite(bpm) && bpm >= 40 && bpm <= 250;
}

/** Seconds per beat. */
export const beatDuration = (bpm: number): number => 60 / bpm;

/** Seconds occupied by `beats` beats at `bpm`. */
export const beatsToSeconds = (beats: number, bpm: number): number => (beats * 60) / bpm;

/** Beats spanned by `seconds` at `bpm`. */
export const secondsToBeats = (seconds: number, bpm: number): number => (seconds * bpm) / 60;

/**
 * Snap a beat count to the nearest musically sensible phrase length.
 * DJs think in 8s: 4, 8, 16, 32, 64.
 */
export function snapToPhraseLength(beats: number): number {
  const options = [2, 4, 8, 16, 32, 64];
  let best = options[0] as number;
  let bestDist = Infinity;
  for (const o of options) {
    const d = Math.abs(Math.log2(beats / o));
    if (d < bestDist) {
      bestDist = d;
      best = o;
    }
  }
  return best;
}
