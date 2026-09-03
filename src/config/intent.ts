/**
 * DJ Intent.
 *
 * One control that says what kind of set you want, which the engine reads as a
 * different set of priorities rather than a different set of numbers to clamp.
 *
 * The distinction from *style* matters: style shapes how a transition sounds
 * once chosen (long, short, which curve). Intent shapes what the engine values
 * when deciding *whether and how* to mix at all — which is why it moves the
 * scoring weights.
 */

import type { ScoringWeights } from "../engine/scoring.js";

export type DjIntent = "smooth" | "balanced" | "energetic" | "experimental";

export interface IntentProfile {
  id: DjIntent;
  label: string;
  description: string;
  weights: ScoringWeights;
  /** Multiplier on transition length. */
  lengthBias: number;
  /**
   * Whether a technically poor pair may be cut deliberately (a contrast move)
   * rather than faded apologetically.
   */
  allowContrast: boolean;
  /** Compatibility below which the engine will not overlap. */
  blendFloor: number;
  /** How strongly the energy trajectory of the set steers the strategy. */
  trajectoryInfluence: number;
}

/**
 * Weights per intent. All sum to 1.
 *
 *  - **Smooth** leans hard on tempo and key: it would rather skip a mix than
 *    make a rough one, and it blends long when it does.
 *  - **Balanced** is the researched default from `docs/ALGORITHM.md`.
 *  - **Energetic** cares about the energy arc and about continuity more than
 *    about harmonic purity — closer to how a peak-time set is programmed.
 *  - **Experimental** deliberately relaxes the technical constraints and leans
 *    on structure instead, so contrast moves become available.
 */
export const INTENT_PROFILES: Record<DjIntent, IntentProfile> = {
  smooth: {
    id: "smooth",
    label: "Smooth",
    description:
      "Prioritises compatibility. Long blends where they fit, and no mix at all where they do not.",
    weights: { tempo: 0.32, key: 0.28, energy: 0.14, phrase: 0.14, loudness: 0.08, style: 0.04 },
    lengthBias: 1.2,
    allowContrast: false,
    blendFloor: 0.45,
    trajectoryInfluence: 0.5,
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    description: "The default. Mixes when it should, cuts when it should.",
    weights: { tempo: 0.3, key: 0.22, energy: 0.18, phrase: 0.15, loudness: 0.09, style: 0.06 },
    lengthBias: 1,
    allowContrast: true,
    blendFloor: 0.35,
    trajectoryInfluence: 1,
  },
  energetic: {
    id: "energetic",
    label: "Energetic",
    description:
      "Programmes for the energy arc and for continuity. Shorter, more decisive switches.",
    weights: { tempo: 0.28, key: 0.16, energy: 0.28, phrase: 0.16, loudness: 0.07, style: 0.05 },
    lengthBias: 0.8,
    allowContrast: true,
    blendFloor: 0.3,
    trajectoryInfluence: 1.4,
  },
  experimental: {
    id: "experimental",
    label: "Experimental",
    description:
      "Accepts unconventional pairings when there is a structural moment to land them on. Cuts with intent rather than fading apologetically.",
    weights: { tempo: 0.22, key: 0.16, energy: 0.2, phrase: 0.26, loudness: 0.08, style: 0.08 },
    lengthBias: 0.95,
    allowContrast: true,
    blendFloor: 0.22,
    trajectoryInfluence: 1.2,
  },
};

export const intentProfile = (id: DjIntent): IntentProfile =>
  INTENT_PROFILES[id] ?? INTENT_PROFILES.balanced;
