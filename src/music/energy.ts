/**
 * Energy matching.
 *
 * A DJ set has a shape. Small upward steps read as "building"; a large jump in
 * either direction reads as a mistake. The scoring below peaks on a slight rise
 * and is mildly asymmetric — dropping the floor is punished a little harder
 * than lifting it, which matches how sets are actually programmed.
 */

import { clamp01 } from "../core/util.js";

/** The delta that scores best: a gentle lift. */
export const IDEAL_ENERGY_DELTA = 0.04;

export interface EnergyMatch {
  score: number;
  delta: number;
  direction: "rise" | "drop" | "flat";
  /** Qualitative label used in the UI. */
  label: string;
  detail: string;
}

export function energyLabel(e: number): string {
  if (e < 0.3) return "very calm";
  if (e < 0.45) return "low";
  if (e < 0.62) return "medium";
  if (e < 0.8) return "high";
  return "very high";
}

export function energyCompatibility(
  energyA: number | undefined,
  energyB: number | undefined,
): EnergyMatch {
  if (energyA === undefined || energyB === undefined) {
    return {
      score: 0.5,
      delta: 0,
      direction: "flat",
      label: "unknown",
      detail: "energy unknown — neutral score",
    };
  }

  const a = clamp01(energyA);
  const b = clamp01(energyB);
  const delta = b - a;
  const direction = Math.abs(delta) < 0.02 ? "flat" : delta > 0 ? "rise" : "drop";

  // Asymmetric tolerance around the ideal small rise.
  const offset = delta - IDEAL_ENERGY_DELTA;
  const tolerance = offset >= 0 ? 0.22 : 0.18;
  const d = offset / tolerance;
  let score = Math.exp(-0.5 * d * d);

  // A hard cliff past ±0.45: no amount of curve-fitting makes 0.2 → 0.95 fine.
  if (Math.abs(delta) > 0.45) score = Math.min(score, 0.12);

  return {
    score: clamp01(score),
    delta,
    direction,
    label: `${energyLabel(a)} → ${energyLabel(b)}`,
    detail: `${a.toFixed(2)} → ${b.toFixed(2)} (${delta >= 0 ? "+" : ""}${delta.toFixed(2)}, ${direction})`,
  };
}

/**
 * How natural a sequence of energies reads as a set. Used by Queue Intelligence
 * to rank possible next tracks. 1 = a smooth arc, 0 = a rollercoaster.
 */
export function progressionSmoothness(energies: readonly number[]): number {
  if (energies.length < 2) return 1;
  let penalty = 0;
  for (let i = 1; i < energies.length; i++) {
    const prev = energies[i - 1] as number;
    const cur = energies[i] as number;
    const step = cur - prev;
    const offset = Math.abs(step - IDEAL_ENERGY_DELTA);
    penalty += Math.max(0, offset - 0.08);
  }
  return clamp01(1 - penalty / (energies.length - 1) / 0.4);
}
