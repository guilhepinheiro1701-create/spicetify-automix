/**
 * Loudness matching and gain compensation.
 *
 * Providers report an integrated loudness figure in dB (Spotify's audio
 * analysis reports a value close to an ITU-R BS.1770 integrated measurement,
 * which is what LUFS is defined against). We use it for two things: penalising
 * pairs that would produce an audible level jump, and computing the trim we
 * would apply if per-track gain were available to us.
 */

import { clamp, clamp01 } from "../core/util.js";

/** Spotify normalises to roughly this level when "Normalize volume" is on. */
export const REFERENCE_LUFS = -14;

export interface LoudnessMatch {
  score: number;
  /** dB difference, B relative to A. */
  deltaDb: number;
  /** Trim we would apply to B to bring it in line with A, in dB. */
  suggestedTrimDb: number;
  detail: string;
}

export function loudnessCompatibility(
  loudA: number | undefined,
  loudB: number | undefined,
): LoudnessMatch {
  if (loudA === undefined || loudB === undefined || !Number.isFinite(loudA) || !Number.isFinite(loudB)) {
    return {
      score: 0.5,
      deltaDb: 0,
      suggestedTrimDb: 0,
      detail: "loudness unknown — neutral score",
    };
  }

  const deltaDb = loudB - loudA;
  const abs = Math.abs(deltaDb);

  // ≤1 dB is inaudible in a blend; ~3 dB is noticeable; ~10 dB is a jump-scare.
  let score: number;
  if (abs <= 1) score = 1;
  else if (abs <= 3) score = 1 - ((abs - 1) / 2) * 0.18; // → 0.82
  else if (abs <= 6) score = 0.82 - ((abs - 3) / 3) * 0.3; // → 0.52
  else if (abs <= 12) score = 0.52 - ((abs - 6) / 6) * 0.42; // → 0.10
  else score = clamp01(0.1 - (abs - 12) * 0.01);

  // Never trim more than this: heavy trims sound like a mistake, not a mix.
  const suggestedTrimDb = clamp(-deltaDb, -6, 6);

  return {
    score: clamp01(score),
    deltaDb,
    suggestedTrimDb,
    detail: `${loudA.toFixed(1)} → ${loudB.toFixed(1)} dB (${deltaDb >= 0 ? "+" : ""}${deltaDb.toFixed(1)} dB)`,
  };
}

/**
 * Convert a provider loudness figure into a 0..1 "perceived level" for the UI.
 * -60 dB → 0, 0 dB → 1.
 */
export const loudnessToUnit = (db: number): number => clamp01((db + 60) / 60);
