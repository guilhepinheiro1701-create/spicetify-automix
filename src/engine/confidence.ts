/**
 * Musical transition confidence — a different question from technical fit.
 *
 * `compatibility.overall` answers: *how much can these two tracks overlap?* It
 * is a technical measure, and a low score there is not a verdict on the pairing.
 * A DJ moving from 90 BPM hip-hop into 145 BPM drum and bass is not making a
 * mistake; they are making a contrast, and they do it with a clean cut on a
 * phrase line rather than a long blend.
 *
 * So this module answers the second question: *given the approach we chose,
 * how confident are we that it will sound good?* A short, well-timed switch
 * between two incompatible records scores high. A long blend over a mediocre
 * match scores low, even though the pair scored better technically.
 *
 * This is what stops the engine being timid. Without it, a POOR technical score
 * produces an apologetic transition; with it, it produces a decisive one.
 */

import { clamp01 } from "../core/util.js";
import type { CompatibilityReport, TransitionStrategy, TrackStructure } from "../core/types.js";
import type { BandInfo } from "./bands.js";

export interface ConfidenceInput {
  compatibility: CompatibilityReport;
  band: BandInfo;
  strategy: TransitionStrategy;
  /** Seconds of structurally mixable overlap available. */
  mixableWindowSec: number;
  /** The blend length actually chosen. */
  durationSec: number;
  /** True when the switch sits on a phrase boundary of the outgoing track. */
  phraseAligned: boolean;
  fromStructure: TrackStructure | null;
  toStructure: TrackStructure | null;
}

export interface ConfidenceResult {
  /** 0..1 — how sure we are this will sound good as executed. */
  score: number;
  /** Short label for the UI. */
  label: string;
  /** The reasons behind the number, best first. */
  factors: string[];
}

/**
 * How much of the technical score matters depends on how exposed the two tracks
 * will be. A four-second switch barely overlaps them, so a poor technical fit
 * costs little; a twelve-second blend puts both records on display.
 */
function exposure(durationSec: number, overlapping: boolean): number {
  if (!overlapping) return 0.25; // a fade never sounds two tracks at once
  return clamp01(durationSec / 12);
}

export function musicalConfidence(input: ConfidenceInput): ConfidenceResult {
  const { compatibility: c, strategy, band } = input;
  const factors: string[] = [];

  const overlapping = strategy !== "safe" && strategy !== "contrast";
  const exposed = exposure(input.durationSec, overlapping);

  // Start from how well the pair fits, then discount that by how much of it is
  // actually on show. A cut exposes almost nothing, so its confidence rests on
  // timing rather than compatibility.
  const technicalWeight = 0.35 + exposed * 0.45;
  let score = c.overall * technicalWeight + (1 - technicalWeight) * 0.75;

  if (strategy === "contrast" || strategy === "safe") {
    // A deliberate switch is a real move. What makes it work is landing it in
    // the right place, not the two tracks matching.
    if (input.phraseAligned) {
      score += 0.18;
      factors.push("the switch lands on a phrase boundary, which is what makes a cut work");
    } else {
      score -= 0.1;
      factors.push("no phrase boundary to land the switch on");
    }
    if (input.fromStructure?.known && input.fromStructure.outroRunwaySec > 3) {
      score += 0.08;
      factors.push("the outgoing track has a real outro to leave from");
    }
  } else {
    // For a blend, the data behind the score matters as much as the score.
    score *= 0.6 + c.confidence * 0.4;
    if (c.confidence < 0.4) {
      factors.push("thin analysis data — the match is a guess as much as a measurement");
    }
    if (input.phraseAligned) {
      score += 0.08;
      factors.push("phrase-aligned");
    }
    // Blending for longer than the structure supports is where mixes go wrong.
    if (input.mixableWindowSec > 0 && input.durationSec > input.mixableWindowSec * 1.15) {
      score -= 0.2;
      factors.push("the blend runs past the available runway");
    }
  }

  if (band.band === "perfect" || band.band === "excellent") {
    factors.unshift(`${band.label.toLowerCase()} technical fit`);
  }

  score = clamp01(score);
  const label =
    score >= 0.85 ? "high" : score >= 0.65 ? "good" : score >= 0.45 ? "moderate" : "low";

  if (factors.length === 0) factors.push("nothing unusual either way");
  return { score, label, factors };
}
