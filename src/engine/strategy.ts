/**
 * Strategy selection — the character of the mix, and the mechanism behind it.
 *
 * Two separate decisions live here, and keeping them apart is what stops the
 * engine from making promises the client cannot keep:
 *
 *  - **Strategy** is the musical character: what a DJ would call this move.
 *    It is chosen from the score band, the energy direction, the harmonic
 *    relationship and the structural runway.
 *  - **Technique** is the mechanism: whether there is a real overlap, a shaped
 *    switch, or nothing at all. It is chosen from what the client can do.
 *
 * A `LONG` strategy on a client with no crossfade still executes as a fade —
 * the character informs the shape and length, never the claim.
 */

import type {
  CompatibilityReport,
  ExecutorKind,
  TransitionStrategy,
  TransitionTechnique,
  TrackStructure,
} from "../core/types.js";
import type { CapabilitySet } from "../platform/capabilities.js";
import type { StyleProfile } from "../config/styles.js";
import { bandFor, type BandInfo } from "./bands.js";

export interface StrategyInput {
  compatibility: CompatibilityReport;
  capabilities: CapabilitySet;
  profile: StyleProfile;
  /** Both tracks have a usable beat grid. */
  hasBeatGrids: boolean;
  /** Same album, consecutive — the artist may have intended a segue. */
  sameAlbumConsecutive: boolean;
  preserveAlbumGapless: boolean;
  minCompatibilityForBlend: number;
  /** Structural runway available, in seconds, and what limits it. */
  mixableWindowSec: number;
  windowLimitedBy: "outro" | "intro" | "both" | "unknown";
  fromStructure: TrackStructure | null;
  toStructure: TrackStructure | null;
  /** Signed energy change, B relative to A. */
  energyDelta: number;
  /** True when the incoming track is spoken word or a live recording. */
  incomingIsAtypical: boolean;
}

export interface StrategyResult {
  strategy: TransitionStrategy;
  technique: TransitionTechnique;
  executor: ExecutorKind;
  band: BandInfo;
  /** Multiplier applied to the computed length. */
  lengthFactor: number;
  rationale: string[];
  caveats: string[];
}

/** A long runway on both sides is what makes a genuinely long mix possible. */
const LONG_RUNWAY_SEC = 12;
/** Energy moves smaller than this are not a direction, just noise. */
const ENERGY_DIRECTION_THRESHOLD = 0.12;
/** Past this the pair cannot be overlapped: no rate control means two pulses. */
const UNMIXABLE_TEMPO_DELTA = 12;

export function selectStrategy(input: StrategyInput): StrategyResult {
  const rationale: string[] = [];
  const caveats: string[] = [];
  const { compatibility: c, capabilities: caps, profile } = input;
  const band = bandFor(c.overall);

  const stand = (
    strategy: TransitionStrategy,
    technique: TransitionTechnique,
    executor: ExecutorKind,
    lengthFactor = 1,
  ): StrategyResult => ({ strategy, technique, executor, band, lengthFactor, rationale, caveats });

  // ── 1. Album segues are sacred ────────────────────────────────────────────
  if (input.sameAlbumConsecutive && input.preserveAlbumGapless) {
    rationale.push("consecutive tracks from the same album — leaving the artist's segue intact");
    return stand("safe", "gapless-passthrough", "passive", 0);
  }

  // ── 2. What can this client physically do? ────────────────────────────────
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
    rationale.push("neither crossfade nor volume control is available — standing down");
    caveats.push("Smart DJ cannot affect playback on this client");
    return stand("safe", "hard-cut", "passive", 0);
  }

  // ── 3. Hard refusals ──────────────────────────────────────────────────────
  const floor = Math.max(input.minCompatibilityForBlend, profile.blendFloor * 0.6);
  const absTempoDelta = Math.abs(c.tempoDeltaPercent);
  const tempoKnown = c.tempo.confidence > 0;

  if (!band.allowsOverlap || c.overall < floor) {
    rationale.push(
      `${band.label} (${(c.overall * 100).toFixed(0)}%) — ${band.description}`,
    );
    return stand("safe", "fade-cut", canFade ? "volume-fade" : "passive", 0.6);
  }

  if (tempoKnown && absTempoDelta > UNMIXABLE_TEMPO_DELTA) {
    rationale.push(
      `tempos differ by ${absTempoDelta.toFixed(1)}% and playback rate is not controllable — overlapping would produce two competing pulses`,
    );
    // A strong harmonic relationship can still carry a brief blend.
    if (canOverlap && c.key.score >= 0.85 && c.key.confidence > 0) {
      rationale.push("but the keys agree, so a short harmonic blend is still worth it");
      return stand("harmonic", "quick-blend", "native-crossfade", 0.55);
    }
    return stand("fast", "fade-cut", canFade ? "volume-fade" : "passive", 0.5);
  }

  if (input.incomingIsAtypical) {
    rationale.push(
      "the incoming track reads as spoken word or a live recording — a beat-locked mix would not land",
    );
    return stand("safe", "quick-blend", canOverlap ? "native-crossfade" : "volume-fade", 0.5);
  }

  // ── 4. Pick the character ─────────────────────────────────────────────────
  const executor: ExecutorKind = canOverlap ? "native-crossfade" : "volume-fade";
  if (!canOverlap) {
    rationale.push("shaping the switch with volume automation instead of an overlap");
  }

  const beatLocked =
    input.hasBeatGrids && tempoKnown && absTempoDelta <= 6 && c.phrase.confidence > 0.2;
  const longRunway =
    input.mixableWindowSec >= LONG_RUNWAY_SEC && input.windowLimitedBy !== "unknown";
  const rising = input.energyDelta >= ENERGY_DIRECTION_THRESHOLD;
  const falling = input.energyDelta <= -ENERGY_DIRECTION_THRESHOLD;

  rationale.push(`${band.label} (${(c.overall * 100).toFixed(0)}%) — ${band.description}`);

  // Energy direction takes precedence when it is pronounced: a set that climbs
  // or settles wants a different gesture from one that stays level.
  if (rising && band.band !== "acceptable") {
    rationale.push(
      `energy climbs ${input.energyDelta.toFixed(2)} — building into the incoming track rather than dissolving into it`,
    );
    return stand(
      "energy-rise",
      beatLocked ? "beat-aligned-blend" : "phrase-blend",
      executor,
      0.8,
    );
  }
  if (falling && band.band !== "acceptable") {
    rationale.push(
      `energy settles ${input.energyDelta.toFixed(2)} — a longer, gentler dissolve suits the drop in level`,
    );
    return stand("energy-drop", "phrase-blend", executor, 1.25);
  }

  if (longRunway && (band.band === "perfect" || band.band === "excellent")) {
    rationale.push(
      `${input.mixableWindowSec.toFixed(0)}s of mixable runway (limited by the ${input.windowLimitedBy}) — using it`,
    );
    return stand("long", beatLocked ? "beat-aligned-blend" : "phrase-blend", executor, 1.3);
  }

  if (beatLocked && (band.band === "perfect" || band.band === "excellent")) {
    rationale.push(
      `beat grids on both tracks and only ${absTempoDelta.toFixed(1)}% tempo difference — phase-locking the switch`,
    );
    return stand("dj", "beat-aligned-blend", executor, 1.1);
  }

  if (c.key.score >= 0.88 && c.key.confidence > 0 && !beatLocked) {
    rationale.push("keys agree but the grids do not — leaning on the harmony instead of the beat");
    return stand("harmonic", "phrase-blend", executor, 1);
  }

  if (band.band === "acceptable" || input.mixableWindowSec < 4) {
    rationale.push(
      input.mixableWindowSec < 4
        ? `only ${input.mixableWindowSec.toFixed(1)}s of runway — keeping it brief`
        : "keeping the overlap short so neither track is exposed for long",
    );
    return stand("fast", "quick-blend", executor, 0.65);
  }

  return stand("smooth", "phrase-blend", executor, 1);
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
