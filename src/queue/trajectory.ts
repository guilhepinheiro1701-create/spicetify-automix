/**
 * Energy trajectory.
 *
 * A DJ does not judge a transition only by the two records either side of it.
 * The same move — 0.72 into 0.84 — reads as a build when the set has been
 * climbing and as an overshoot when it has just peaked. This module gives the
 * engine that context: where the set has been, where it appears to be going,
 * and whether the next step continues the shape or breaks it.
 */

import { clamp01, mean } from "../core/util.js";

export type TrajectoryShape = "building" | "peaking" | "releasing" | "steady" | "erratic";

export interface EnergyTrajectory {
  shape: TrajectoryShape;
  /** Mean signed step across the window, per track. */
  slope: number;
  /** 0..1 — how consistent the direction has been. */
  consistency: number;
  /** The energies used, oldest first, current track last. */
  window: number[];
  /** Plain-language summary for the UI. */
  summary: string;
}

const UNKNOWN: EnergyTrajectory = {
  shape: "steady",
  slope: 0,
  consistency: 0,
  window: [],
  summary: "not enough energy data to read the set's shape",
};

/** A step smaller than this is noise, not a direction. */
const STEP_NOISE = 0.03;
/** Above this the set is unmistakably going somewhere. */
const CLEAR_SLOPE = 0.045;

/**
 * Read the shape from recent energies. `history` is oldest first and should end
 * with the currently playing track.
 */
export function readTrajectory(history: readonly (number | undefined)[]): EnergyTrajectory {
  const window = history.filter((v): v is number => typeof v === "number").map(clamp01);
  if (window.length < 2) return { ...UNKNOWN, window };

  const steps: number[] = [];
  for (let i = 1; i < window.length; i++) {
    steps.push((window[i] as number) - (window[i - 1] as number));
  }

  const slope = mean(steps);
  const meaningful = steps.filter((s) => Math.abs(s) > STEP_NOISE);
  const rising = meaningful.filter((s) => s > 0).length;
  const falling = meaningful.filter((s) => s < 0).length;
  const directional = rising + falling;
  const consistency =
    directional === 0 ? 1 : Math.abs(rising - falling) / directional;

  const current = window[window.length - 1] as number;

  let shape: TrajectoryShape;
  if (directional >= 2 && consistency < 0.34) {
    shape = "erratic";
  } else if (slope > CLEAR_SLOPE) {
    shape = current >= 0.78 ? "peaking" : "building";
  } else if (slope < -CLEAR_SLOPE) {
    shape = "releasing";
  } else {
    shape = current >= 0.8 ? "peaking" : "steady";
  }

  const summaries: Record<TrajectoryShape, string> = {
    building: `climbing steadily (${slope >= 0 ? "+" : ""}${slope.toFixed(2)} per track)`,
    peaking: `at the top of the set (energy ${current.toFixed(2)})`,
    releasing: `coming down (${slope.toFixed(2)} per track)`,
    steady: `holding level around ${current.toFixed(2)}`,
    erratic: "jumping around — no clear direction",
  };

  return { shape, slope, consistency: clamp01(consistency), window, summary: summaries[shape] };
}

/**
 * How well a proposed next energy continues the shape, 0..1.
 *
 * This is what makes the trajectory actionable: a rise into a set that is
 * already building is the obvious move; the same rise on top of a peak is
 * where sets fall apart, and a release after a peak is exactly right.
 */
export function fitsTrajectory(trajectory: EnergyTrajectory, nextEnergy: number | undefined): {
  score: number;
  note: string;
} {
  if (nextEnergy === undefined || trajectory.window.length < 2) {
    return { score: 0.5, note: "no trajectory to judge against" };
  }
  const current = trajectory.window[trajectory.window.length - 1] as number;
  const step = clamp01(nextEnergy) - current;

  switch (trajectory.shape) {
    case "building":
      if (step > STEP_NOISE) return { score: 0.95, note: "continues the build" };
      if (step < -0.12) return { score: 0.3, note: "kills a build that was working" };
      return { score: 0.65, note: "flattens the build" };
    case "peaking":
      if (step > 0.1) return { score: 0.35, note: "pushes past a peak that has already landed" };
      if (step < -0.08) return { score: 0.9, note: "releases after the peak, which is the move" };
      return { score: 0.7, note: "holds at the top" };
    case "releasing":
      if (step < STEP_NOISE) return { score: 0.85, note: "continues the comedown" };
      if (step > 0.15) return { score: 0.45, note: "re-ignites a set that was winding down" };
      return { score: 0.7, note: "steadies the comedown" };
    case "erratic":
      return {
        score: Math.abs(step) < 0.1 ? 0.75 : 0.5,
        note: Math.abs(step) < 0.1 ? "steadies an erratic run" : "adds to the churn",
      };
    default:
      if (Math.abs(step) < 0.08) return { score: 0.8, note: "keeps the level" };
      if (step > 0) return { score: 0.85, note: "lifts a steady stretch" };
      return { score: 0.7, note: "eases a steady stretch down" };
  }
}
