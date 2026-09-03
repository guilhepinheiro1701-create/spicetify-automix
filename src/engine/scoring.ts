/**
 * Compatibility scoring.
 *
 * Weights are not arbitrary. They follow the order of operations a DJ actually
 * works in:
 *
 *  1. **Tempo (30%)** is the hard constraint. Two tracks at incompatible tempos
 *     cannot be blended at all — and because the Spotify client gives us no
 *     rate control, we cannot fix a mismatch by pitching either deck. Tempo is
 *     therefore worth more here than it would be in a real DJ tool.
 *  2. **Key (22%)** is the classic harmonic-mixing constraint. Clashing keys
 *     during an overlap is the most viscerally wrong thing a mix can do.
 *  3. **Energy (18%)** is what makes a set feel programmed rather than shuffled.
 *  4. **Phrase (15%)** decides whether the switch lands on the music's own
 *     structure. Weighted below key because a phrase-perfect transition between
 *     clashing keys still sounds wrong, while a slightly-off transition between
 *     compatible tracks mostly does not.
 *  5. **Loudness (9%)** catches the level jumps that read as a mistake.
 *  6. **Style (6%)** is a light nudge from shared artists and derived timbre.
 *
 * Missing data always scores 0.5 — neutral — and lowers `confidence`. An
 * unanalysed track must never be treated as an incompatible one.
 */

import { clamp01 } from "../core/util.js";
import { harmonicCompatibility } from "../music/camelot.js";
import { tempoCompatibility } from "../music/tempo.js";
import { energyCompatibility } from "../music/energy.js";
import { loudnessCompatibility } from "../music/loudness.js";
import { phraseAlignmentScore } from "../analysis/structure.js";
import type {
  CompatibilityReport,
  ScoreComponent,
  TrackAnalysis,
  TrackRef,
} from "../core/types.js";

export interface ScoringWeights {
  tempo: number;
  key: number;
  energy: number;
  phrase: number;
  loudness: number;
  style: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  tempo: 0.3,
  key: 0.22,
  energy: 0.18,
  phrase: 0.15,
  loudness: 0.09,
  style: 0.06,
};

/** Which components the user has switched off. Disabled ones drop out of the mean. */
export interface ScoringToggles {
  harmonicMixing: boolean;
  energyMatching: boolean;
  phraseMatching: boolean;
  loudnessNormalization: boolean;
}

const NEUTRAL: ScoreComponent = { score: 0.5, confidence: 0, detail: "not evaluated" };

export interface ScoringInput {
  fromTrack: TrackRef;
  toTrack: TrackRef;
  from: TrackAnalysis;
  to: TrackAnalysis;
  /** Planned exit time in track A, seconds. Needed for the phrase component. */
  exitTimeSec: number;
  /** Planned blend length, seconds. */
  durationSec: number;
  toggles: ScoringToggles;
  weights?: ScoringWeights;
}

/**
 * Shared artists and similar timbre are a weak but real signal that two tracks
 * belong in the same set. Genre tags are not exposed to extensions, so this is
 * what we have.
 */
function styleAffinity(input: ScoringInput): ScoreComponent {
  const a = new Set(input.fromTrack.artists.map((x) => x.toLowerCase()));
  const shared = input.toTrack.artists.some((x) => a.has(x.toLowerCase()));

  const bA = input.from.brightness;
  const bB = input.to.brightness;
  const pA = input.from.pulseStrength;
  const pB = input.to.pulseStrength;

  const haveTimbre = bA !== undefined && bB !== undefined;
  const havePulse = pA !== undefined && pB !== undefined;

  if (!shared && !haveTimbre && !havePulse) {
    return { score: 0.5, confidence: 0, detail: "no style signal available" };
  }

  let score = 0.5;
  const notes: string[] = [];
  if (shared) {
    score = 0.85;
    notes.push("shared artist");
  }
  if (haveTimbre) {
    const d = Math.abs((bA as number) - (bB as number));
    const timbreScore = clamp01(1 - d * 1.8);
    score = shared ? score * 0.6 + timbreScore * 0.4 : timbreScore;
    notes.push(`timbre Δ${d.toFixed(2)}`);
  }
  if (havePulse) {
    const d = Math.abs((pA as number) - (pB as number));
    score = score * 0.8 + clamp01(1 - d * 1.5) * 0.2;
    notes.push(`pulse Δ${d.toFixed(2)}`);
  }

  return {
    score: clamp01(score),
    confidence: shared ? 0.6 : haveTimbre ? 0.4 : 0.2,
    detail: notes.join(", "),
  };
}

export function scoreCompatibility(input: ScoringInput): CompatibilityReport {
  const weights = input.weights ?? DEFAULT_WEIGHTS;
  const { from, to, toggles } = input;

  // ── Tempo ────────────────────────────────────────────────────────────────
  const tempoMatch = tempoCompatibility(from.tempo, to.tempo);
  const tempoKnown = from.tempo !== undefined && to.tempo !== undefined;
  const tempo: ScoreComponent = {
    score: tempoMatch.score,
    confidence: tempoKnown
      ? clamp01(Math.min(from.tempoConfidence ?? 0.7, to.tempoConfidence ?? 0.7) + 0.2)
      : 0,
    detail: tempoMatch.detail,
  };

  // ── Key ──────────────────────────────────────────────────────────────────
  let key: ScoreComponent = NEUTRAL;
  if (toggles.harmonicMixing) {
    const h = harmonicCompatibility(from.key, from.mode, to.key, to.mode);
    const known = h.from !== null && h.to !== null;
    key = {
      score: h.score,
      confidence: known
        ? clamp01(Math.min(from.keyConfidence ?? 0.6, to.keyConfidence ?? 0.6) + 0.2)
        : 0,
      detail: h.detail,
    };
  }

  // ── Energy ───────────────────────────────────────────────────────────────
  let energy: ScoreComponent = NEUTRAL;
  if (toggles.energyMatching) {
    const e = energyCompatibility(from.energy, to.energy);
    energy = {
      score: e.score,
      confidence: from.energy !== undefined && to.energy !== undefined ? 0.75 : 0,
      detail: e.detail,
    };
  }

  // ── Phrase ───────────────────────────────────────────────────────────────
  let phrase: ScoreComponent = NEUTRAL;
  if (toggles.phraseMatching) {
    const gridA = from.grid ?? null;
    const gridB = to.grid ?? null;
    const alignment = phraseAlignmentScore(gridA, input.exitTimeSec, input.durationSec);
    // Both tracks need a grid for a genuinely phrase-locked blend.
    const bothGridded = Boolean(gridA && gridB);
    const meterMatch =
      from.timeSignature !== undefined && to.timeSignature !== undefined
        ? from.timeSignature === to.timeSignature
          ? 1
          : 0.55
        : 0.8;
    phrase = {
      score: clamp01(alignment * (bothGridded ? 1 : 0.8) * meterMatch),
      confidence: bothGridded
        ? clamp01(((gridA?.confidence ?? 0) + (gridB?.confidence ?? 0)) / 2)
        : gridA
          ? 0.3
          : 0,
      detail: bothGridded
        ? `grid confidence ${((gridA as { confidence: number }).confidence).toFixed(2)}/${((gridB as { confidence: number }).confidence).toFixed(2)}`
        : "no beat grid on one or both tracks",
    };
  }

  // ── Loudness ─────────────────────────────────────────────────────────────
  let loudness: ScoreComponent = NEUTRAL;
  if (toggles.loudnessNormalization) {
    const l = loudnessCompatibility(from.loudness, to.loudness);
    loudness = {
      score: l.score,
      confidence: from.loudness !== undefined && to.loudness !== undefined ? 0.8 : 0,
      detail: l.detail,
    };
  }

  // ── Style ────────────────────────────────────────────────────────────────
  const style = styleAffinity(input);

  // ── Weighted mean over the components that are actually in play ──────────
  const parts: [ScoreComponent, number][] = [
    [tempo, weights.tempo],
    [key, weights.key],
    [energy, weights.energy],
    [phrase, weights.phrase],
    [loudness, weights.loudness],
    [style, weights.style],
  ];

  let weighted = 0;
  let totalWeight = 0;
  let confidenceAcc = 0;
  for (const [component, weight] of parts) {
    if (weight <= 0) continue;
    weighted += component.score * weight;
    totalWeight += weight;
    confidenceAcc += component.confidence * weight;
  }

  let overall = totalWeight > 0 ? clamp01(weighted / totalWeight) : 0.5;
  const confidence = totalWeight > 0 ? clamp01(confidenceAcc / totalWeight) : 0;

  // A weighted mean is the wrong shape for a catastrophic failure in a hard
  // constraint. Two tracks 50% apart in tempo do not become mixable because
  // they happen to share a key and a loudness — and with no rate control here,
  // that gap cannot be closed at all. So a badly failing constraint caps the
  // result rather than being averaged against the ones that passed.
  const vetoes: [ScoreComponent, number, number, number][] = [
    // component, its weight, the score below which it vetoes, the resulting cap
    [tempo, weights.tempo, 0.15, 0.5],
    [key, weights.key, 0.2, 0.72],
    [energy, weights.energy, 0.15, 0.7],
  ];
  for (const [component, weight, threshold, cap] of vetoes) {
    if (weight > 0 && component.confidence > 0 && component.score < threshold) {
      overall = Math.min(overall, cap);
    }
  }

  return {
    overall,
    confidence,
    tempo,
    key,
    energy,
    phrase,
    loudness,
    style,
    tempoRatio: tempoMatch.ratio,
    tempoDeltaPercent: tempoMatch.deltaPercent,
  };
}
