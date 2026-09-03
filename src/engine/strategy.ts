/**
 * Technique selection.
 *
 * Given a compatibility report and what the client can actually do, decide
 * *how* to join the two tracks. This is where the project's central honesty
 * lives: if the pair does not fit, the right answer is a short, clean switch,
 * not a long crossfade that smears two incompatible records together.
 */

import type {
  CompatibilityReport,
  ExecutorKind,
  TransitionTechnique,
} from "../core/types.js";
import type { CapabilitySet } from "../platform/capabilities.js";
import type { StyleProfile } from "../config/styles.js";

export interface StrategyInput {
  compatibility: CompatibilityReport;
  capabilities: CapabilitySet;
  profile: StyleProfile;
  /** Both tracks have a usable beat grid. */
  hasBeatGrids: boolean;
  /** Same album, consecutive — the artist may have intended a segue. */
  sameAlbumConsecutive: boolean;
  preserveAlbumGapless: boolean;
  /** User floor below which we never attempt an overlap. */
  minCompatibilityForBlend: boolean | number;
}

export interface StrategyResult {
  technique: TransitionTechnique;
  executor: ExecutorKind;
  rationale: string[];
  caveats: string[];
}

export function selectStrategy(input: StrategyInput): StrategyResult {
  const rationale: string[] = [];
  const caveats: string[] = [];
  const { compatibility: c, capabilities: caps, profile } = input;
  const floor =
    typeof input.minCompatibilityForBlend === "number" ? input.minCompatibilityForBlend : 0.35;

  // 1. Album segues are sacred. Two tracks the artist sequenced to run together
  //    must not be crossfaded — that is the one case where doing nothing is the
  //    musically correct choice.
  if (input.sameAlbumConsecutive && input.preserveAlbumGapless) {
    return {
      technique: "gapless-passthrough",
      executor: "passive",
      rationale: ["consecutive tracks from the same album — leaving the artist's segue intact"],
      caveats: [],
    };
  }

  // 2. What can this client physically do?
  const canOverlap = caps.nativeCrossfade.status === "available";
  const canFade = caps.volumeAutomation.status !== "unavailable";

  if (!canOverlap) {
    caveats.push(
      caps.productTier === "free"
        ? "no real audio overlap: this client refused every crossfade write path (recent builds gate crossfade behind Premium)"
        : "no real audio overlap: this client exposes no writable crossfade setting",
    );
  }
  if (!canOverlap && !canFade) {
    return {
      technique: "hard-cut",
      executor: "passive",
      rationale: ["neither crossfade nor volume control is available — standing down"],
      caveats: [...caveats, "Smart DJ cannot affect playback on this client"],
    };
  }

  // 3. Compatibility gates.
  const effectiveFloor = Math.max(floor, profile.blendFloor * 0.6);

  if (c.overall < effectiveFloor) {
    rationale.push(
      `compatibility ${(c.overall * 100).toFixed(0)}% is below the ${(effectiveFloor * 100).toFixed(0)}% blend floor — a long overlap would smear these two`,
    );
    return {
      technique: "fade-cut",
      executor: canFade ? "volume-fade" : "passive",
      rationale,
      caveats,
    };
  }

  // A tempo mismatch this wide cannot be rescued: we have no rate control, so
  // an overlap would just play two different pulses at once.
  const absTempoDelta = Math.abs(c.tempoDeltaPercent);
  const tempoKnown = c.tempo.confidence > 0;
  if (tempoKnown && absTempoDelta > 12) {
    rationale.push(
      `tempos differ by ${absTempoDelta.toFixed(1)}% and playback rate is not controllable — overlapping would produce two competing pulses`,
    );
    return {
      technique: canOverlap && c.overall > 0.5 ? "quick-blend" : "fade-cut",
      executor: canOverlap && c.overall > 0.5 ? "native-crossfade" : canFade ? "volume-fade" : "passive",
      rationale,
      caveats,
    };
  }

  if (!canOverlap) {
    rationale.push("shaping the switch with volume automation instead of an overlap");
    return { technique: "fade-cut", executor: "volume-fade", rationale, caveats };
  }

  // 4. We can overlap. How ambitious should we be?
  if (c.overall >= 0.72 && input.hasBeatGrids && tempoKnown && absTempoDelta <= 6) {
    rationale.push(
      `strong match (${(c.overall * 100).toFixed(0)}%) with beat grids on both tracks and only ${absTempoDelta.toFixed(1)}% tempo difference`,
    );
    return {
      technique: "beat-aligned-blend",
      executor: "native-crossfade",
      rationale,
      caveats,
    };
  }

  if (c.overall >= 0.55) {
    rationale.push(
      `workable match (${(c.overall * 100).toFixed(0)}%) — blending on a phrase boundary`,
    );
    return { technique: "phrase-blend", executor: "native-crossfade", rationale, caveats };
  }

  rationale.push(
    `modest match (${(c.overall * 100).toFixed(0)}%) — keeping the overlap short so neither track is exposed for long`,
  );
  return { technique: "quick-blend", executor: "native-crossfade", rationale, caveats };
}

/** Base transition length in beats for a technique, before style and score scaling. */
export function baseBeatsFor(technique: TransitionTechnique, profile: StyleProfile): number {
  switch (technique) {
    case "beat-aligned-blend":
      return profile.preferredBeats;
    case "phrase-blend":
      return Math.max(8, profile.preferredBeats / 2);
    case "quick-blend":
      return 8;
    case "fade-cut":
      return 4;
    default:
      return 0;
  }
}
