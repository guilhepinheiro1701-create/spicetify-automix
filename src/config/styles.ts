/**
 * Style presets.
 *
 * A style is a *bias*, not a script: it shapes how long the engine is willing
 * to blend and how aggressively it will act on a mediocre compatibility score.
 * The engine still refuses to blend two tracks that genuinely do not fit.
 */

import type { FadeCurve, TransitionStyle } from "../core/types.js";

export interface StyleProfile {
  id: TransitionStyle;
  label: string;
  description: string;
  /** Preferred transition length in beats when a beat grid exists. */
  preferredBeats: number;
  /** Bounds, in seconds, before the user's own min/max clamp is applied. */
  minSec: number;
  maxSec: number;
  /** Multiplier on the computed duration. */
  lengthBias: number;
  /** How much a poor compatibility score shortens the blend. 0 = ignore, 1 = fully. */
  compatibilitySensitivity: number;
  /** Minimum compatibility this style will still attempt an overlap for. */
  blendFloor: number;
  curve: FadeCurve;
  /** Prefer starting the incoming track past a dead intro. */
  favourIntroSkip: boolean;
}

export const STYLE_PROFILES: Record<TransitionStyle, StyleProfile> = {
  smooth: {
    id: "smooth",
    label: "Smooth",
    description: "Discreet 4–8 s blends. Never draws attention to itself.",
    preferredBeats: 16,
    minSec: 3,
    maxSec: 8,
    lengthBias: 1,
    compatibilitySensitivity: 0.6,
    blendFloor: 0.3,
    curve: "equal-power",
    favourIntroSkip: false,
  },
  dj: {
    id: "dj",
    label: "DJ",
    description:
      "Phrase-aligned mixes on 16/32-beat boundaries with bass-duck shaping. The default.",
    preferredBeats: 32,
    minSec: 4,
    maxSec: 12,
    lengthBias: 1.15,
    compatibilitySensitivity: 0.85,
    blendFloor: 0.45,
    curve: "equal-power",
    favourIntroSkip: true,
  },
  energetic: {
    id: "energetic",
    label: "Energetic",
    description: "Short, punchy switches that land on the downbeat and get out.",
    preferredBeats: 8,
    minSec: 1.5,
    maxSec: 5,
    lengthBias: 0.7,
    compatibilitySensitivity: 0.5,
    blendFloor: 0.25,
    curve: "s-curve",
    favourIntroSkip: true,
  },
  chill: {
    id: "chill",
    label: "Chill",
    description: "Long, slow dissolves. Best for ambient and downtempo listening.",
    preferredBeats: 32,
    minSec: 6,
    maxSec: 12,
    lengthBias: 1.35,
    compatibilitySensitivity: 0.35,
    blendFloor: 0.2,
    curve: "equal-power",
    favourIntroSkip: false,
  },
  seamless: {
    id: "seamless",
    label: "Seamless",
    description:
      "Maximum continuity: never any silence, aggressive intro skipping, tail trimming.",
    preferredBeats: 16,
    minSec: 2,
    maxSec: 10,
    lengthBias: 1,
    compatibilitySensitivity: 0.7,
    blendFloor: 0.15,
    curve: "equal-power",
    favourIntroSkip: true,
  },
  custom: {
    id: "custom",
    label: "Custom",
    description: "Your own numbers. Advanced settings drive everything.",
    preferredBeats: 16,
    minSec: 1,
    maxSec: 12,
    lengthBias: 1,
    compatibilitySensitivity: 0.6,
    blendFloor: 0.3,
    curve: "equal-power",
    favourIntroSkip: true,
  },
};

/**
 * Look up a style, defending against a key that only exists on the prototype.
 *
 * A plain `STYLE_PROFILES[id]` answers with a *function* for "constructor" or
 * "toString", which the `??` fallback does not catch — so the caller ends up
 * reading `lengthBias` off `Object` and getting undefined.
 */
export const styleProfile = (id: TransitionStyle): StyleProfile =>
  Object.prototype.hasOwnProperty.call(STYLE_PROFILES, id)
    ? STYLE_PROFILES[id]
    : STYLE_PROFILES.dj;
