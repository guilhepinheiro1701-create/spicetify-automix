/**
 * Transition Engine — `calculateTransition(trackA, trackB) → TransitionPlan`.
 *
 * Pure computation: it reads analyses and settings and produces a plan. It
 * never touches playback. That separation is what makes the whole algorithm
 * unit-testable without a Spotify client.
 *
 * The plan it produces is a *contract* for the audio layer: a start point, a
 * duration, an entry point, a curve, and a set of intents (EQ shaping, gain
 * trim) that the executor honours as far as its own capabilities allow — and
 * reports honestly when it cannot.
 */

import { clamp, round } from "../core/util.js";
import { beatsToSeconds, secondsToBeats, snapToPhraseLength } from "../music/tempo.js";
import { loudnessCompatibility } from "../music/loudness.js";
import {
  alignDurationToPhrase,
  findEntryCue,
  findExitCue,
  isOnPhrase,
  nearestDownbeat,
} from "../analysis/structure.js";
import { scoreCompatibility, type ScoringWeights } from "./scoring.js";
import { baseBeatsFor, selectStrategy } from "./strategy.js";
import { styleProfile } from "../config/styles.js";
import type { Settings } from "../config/defaults.js";
import type { CapabilitySet } from "../platform/capabilities.js";
import type {
  EqPlan,
  GainPlan,
  TrackAnalysis,
  TrackRef,
  TransitionPlan,
} from "../core/types.js";
import { MAX_NATIVE_CROSSFADE_SEC } from "../platform/nativeCrossfade.js";

export interface TransitionInput {
  fromTrack: TrackRef;
  toTrack: TrackRef | null;
  fromAnalysis: TrackAnalysis;
  toAnalysis: TrackAnalysis | null;
  settings: Settings;
  capabilities: CapabilitySet;
  weights?: ScoringWeights;
}

/** Plan used when there is no next track to mix into. */
function passthroughPlan(input: TransitionInput, reason: string): TransitionPlan {
  const durationSec = input.fromAnalysis.durationMs / 1000;
  return {
    from: input.fromTrack,
    to: input.toTrack,
    compatibility: {
      overall: 0,
      confidence: 0,
      tempo: { score: 0.5, confidence: 0, detail: "n/a" },
      key: { score: 0.5, confidence: 0, detail: "n/a" },
      energy: { score: 0.5, confidence: 0, detail: "n/a" },
      phrase: { score: 0.5, confidence: 0, detail: "n/a" },
      loudness: { score: 0.5, confidence: 0, detail: "n/a" },
      style: { score: 0.5, confidence: 0, detail: "n/a" },
      tempoRatio: 1,
      tempoDeltaPercent: 0,
    },
    technique: "gapless-passthrough",
    executor: "passive",
    style: input.settings.style,
    startPointSec: durationSec,
    durationSec: 0,
    durationBeats: null,
    entryPointSec: 0,
    bpmAdjustmentPercent: 0,
    bpmAdjustmentApplied: false,
    beatAlignment: false,
    phraseAlignment: false,
    eq: { enabled: false, bassDuckDb: 0, midHoldDb: 0, trebleBlendDb: 0, approximated: false },
    gain: { trackA: 0, trackB: 0, perTrackSupported: false },
    curve: input.settings.fadeCurve,
    rationale: [reason],
    caveats: [],
  };
}

/**
 * EQ intent.
 *
 * A real DJ swaps the bass: the outgoing track's low end comes out as the
 * incoming track's comes in, so two kick drums and two basslines never occupy
 * the same space. We cannot filter Spotify's audio — there is no DSP hook — so
 * this is recorded as *intent*, and the volume-fade executor approximates the
 * audible part of it by pulling the outgoing track down faster than a straight
 * crossfade would. The `approximated` flag makes that explicit in the UI.
 */
function planEq(enabled: boolean, compatibility: number): EqPlan {
  if (!enabled) {
    return { enabled: false, bassDuckDb: 0, midHoldDb: 0, trebleBlendDb: 0, approximated: false };
  }
  // The worse the match, the harder we would duck the outgoing low end.
  const duck = -(6 + (1 - compatibility) * 6);
  return {
    enabled: true,
    bassDuckDb: round(duck, 1),
    midHoldDb: 0,
    trebleBlendDb: round(-2 - (1 - compatibility) * 2, 1),
    // With the native mixer we cannot shape anything; with volume automation we
    // can only approximate it broadband.
    approximated: true,
  };
}

function planGain(
  enabled: boolean,
  from: TrackAnalysis,
  to: TrackAnalysis | null,
  perTrackSupported: boolean,
): GainPlan {
  if (!enabled || !to) return { trackA: 0, trackB: 0, perTrackSupported };
  const l = loudnessCompatibility(from.loudness, to.loudness);
  return {
    trackA: 0,
    trackB: round(l.suggestedTrimDb, 1),
    perTrackSupported,
  };
}

export function calculateTransition(input: TransitionInput): TransitionPlan {
  const { fromTrack, toTrack, fromAnalysis, toAnalysis, settings, capabilities } = input;

  if (!toTrack || !toAnalysis) {
    return passthroughPlan(input, "no next track known — nothing to mix into");
  }

  const profile = styleProfile(settings.style);
  const gridA = fromAnalysis.grid ?? null;
  const gridB = toAnalysis.grid ?? null;
  const trackDurationSec = fromAnalysis.durationMs / 1000 || fromTrack.durationMs / 1000;

  const sameAlbumConsecutive =
    Boolean(fromTrack.albumUri) && fromTrack.albumUri === toTrack.albumUri;

  // ── Pass 1: a provisional duration, so the exit cue has something to aim at ─
  const bpmA = fromAnalysis.tempo;
  const provisionalBeats = profile.preferredBeats;
  const provisionalSec = bpmA
    ? beatsToSeconds(provisionalBeats, bpmA)
    : (profile.minSec + profile.maxSec) / 2;

  const provisionalExit = findExitCue(fromAnalysis, gridA, {
    durationSec: provisionalSec,
    minPlayedFraction: 0.4,
    usePhrases: settings.phraseMatching,
  });

  // ── Score the pair at that provisional geometry ────────────────────────────
  let compatibility = scoreCompatibility({
    fromTrack,
    toTrack,
    from: fromAnalysis,
    to: toAnalysis,
    exitTimeSec: provisionalExit.time,
    durationSec: provisionalSec,
    toggles: {
      harmonicMixing: settings.harmonicMixing,
      energyMatching: settings.energyMatching,
      phraseMatching: settings.phraseMatching,
      loudnessNormalization: settings.loudnessNormalization,
    },
    ...(input.weights ? { weights: input.weights } : {}),
  });

  // ── Choose the technique ───────────────────────────────────────────────────
  const hasBeatGrids = Boolean(gridA && gridB && (gridA.confidence > 0.25 || gridB.confidence > 0.25));
  const strategy = selectStrategy({
    compatibility,
    capabilities,
    profile,
    hasBeatGrids,
    sameAlbumConsecutive,
    preserveAlbumGapless: settings.preserveAlbumGapless,
    minCompatibilityForBlend: settings.minCompatibilityForBlend,
  });

  if (strategy.technique === "gapless-passthrough" || strategy.executor === "passive") {
    const plan = passthroughPlan(input, strategy.rationale[0] ?? "standing down");
    plan.technique = strategy.technique;
    plan.compatibility = compatibility;
    plan.caveats = strategy.caveats;
    plan.rationale = strategy.rationale;
    return plan;
  }

  // ── Pass 2: the real duration ──────────────────────────────────────────────
  let beats = baseBeatsFor(strategy.technique, profile);

  // Intensity is the user's thumb on the scale; compatibility is the engine's.
  const intensityFactor = 0.6 + settings.intensity * 0.8; // 0.6 … 1.4
  const compatFactor =
    1 - (1 - compatibility.overall) * profile.compatibilitySensitivity * 0.7;

  if (settings.autoMode) {
    beats = beats * intensityFactor * compatFactor * profile.lengthBias;
    if (settings.phraseMatching && hasBeatGrids) beats = snapToPhraseLength(beats);
  } else {
    beats = beats * profile.lengthBias;
  }

  let durationSec = bpmA
    ? beatsToSeconds(beats, bpmA)
    : ((profile.minSec + profile.maxSec) / 2) * intensityFactor * compatFactor;

  // Clamp: style bounds, then the user's own bounds, then what the client allows.
  durationSec = clamp(durationSec, profile.minSec, profile.maxSec);
  durationSec = clamp(durationSec, settings.minDurationSec, settings.maxDurationSec);
  if (strategy.executor === "native-crossfade") {
    durationSec = Math.min(durationSec, MAX_NATIVE_CROSSFADE_SEC);
  }
  // Never spend more than a fifth of the track on the way out of it.
  durationSec = Math.min(durationSec, Math.max(1, trackDurationSec * 0.2));

  // Round the blend to a whole number of bars so it resolves musically.
  if (settings.phraseMatching && gridA) {
    const upper = Math.min(
      settings.maxDurationSec,
      profile.maxSec,
      strategy.executor === "native-crossfade" ? MAX_NATIVE_CROSSFADE_SEC : Infinity,
      Math.max(1, trackDurationSec * 0.2),
    );
    durationSec = alignDurationToPhrase(gridA, durationSec, settings.minDurationSec, upper);
  }
  durationSec = round(clamp(durationSec, 0.5, 12), 2);

  // ── Pass 3: the real exit cue, now that we know how long the blend is ──────
  const exitCue = findExitCue(fromAnalysis, gridA, {
    durationSec,
    minPlayedFraction: 0.4,
    usePhrases: settings.phraseMatching,
  });

  let startPointSec = clamp(exitCue.time, 1, Math.max(1, trackDurationSec - 0.5));

  // ── Beat alignment ─────────────────────────────────────────────────────────
  // We cannot warp tempo, so we cannot beat*match*. What we can do is choose the
  // instant of the switch so track B's first downbeat lands on a downbeat of
  // track A. When the tempos are close that reads as a locked mix; when they are
  // not, it at least starts in the right place.
  let beatAlignment = false;
  if (settings.beatMatching && gridA && capabilities.preciseTiming.status === "available") {
    // findExitCue has already put us on a phrase line where one was reachable.
    // Only nudge to the nearest bar if we are not already on the grid, so this
    // never pulls the exit back off a phrase boundary.
    const snapped = isOnPhrase(gridA, startPointSec, 0.05)
      ? startPointSec
      : nearestDownbeat(gridA, startPointSec);
    if (snapped > 1 && snapped < trackDurationSec - 0.5) {
      startPointSec = snapped;
      beatAlignment = Math.abs(compatibility.tempoDeltaPercent) <= 8 && hasBeatGrids;
    }
  }

  const phraseAlignment = Boolean(
    settings.phraseMatching && gridA && isOnPhrase(gridA, startPointSec, 0.2),
  );

  // ── Entry point in track B ─────────────────────────────────────────────────
  const entryCue = findEntryCue(toAnalysis, gridB, {
    skipDeadIntro: settings.skipDeadIntro && profile.favourIntroSkip,
    maxSkipSec: Math.min(30, (toAnalysis.durationMs / 1000) * 0.25),
  });

  // ── Re-score at the final geometry ─────────────────────────────────────────
  compatibility = scoreCompatibility({
    fromTrack,
    toTrack,
    from: fromAnalysis,
    to: toAnalysis,
    exitTimeSec: startPointSec,
    durationSec,
    toggles: {
      harmonicMixing: settings.harmonicMixing,
      energyMatching: settings.energyMatching,
      phraseMatching: settings.phraseMatching,
      loudnessNormalization: settings.loudnessNormalization,
    },
    ...(input.weights ? { weights: input.weights } : {}),
  });

  const overlapping = strategy.executor === "native-crossfade";

  const rationale = [...strategy.rationale];
  rationale.push(
    `exit at ${startPointSec.toFixed(1)}s (${exitCue.reason.replace(/-/g, " ")}, strength ${exitCue.strength.toFixed(2)})`,
  );
  if (bpmA) {
    rationale.push(
      `blend ${durationSec.toFixed(1)}s ≈ ${Math.round(secondsToBeats(durationSec, bpmA))} beats at ${bpmA.toFixed(0)} BPM`,
    );
  }
  if (entryCue.time > 0.5) {
    rationale.push(
      `starting track B at ${entryCue.time.toFixed(1)}s to skip a low-energy intro (${entryCue.reason.replace(/-/g, " ")})`,
    );
  }
  if (phraseAlignment) rationale.push("switch lands on a phrase boundary");
  if (beatAlignment) rationale.push("first downbeat of B is scheduled onto a downbeat of A");

  const caveats = [...strategy.caveats];
  const bpmAdjustmentPercent = round(-compatibility.tempoDeltaPercent, 2);
  if (compatibility.tempo.confidence > 0 && Math.abs(bpmAdjustmentPercent) > 0.5) {
    caveats.push(
      `a true beatmatch would need ${bpmAdjustmentPercent > 0 ? "+" : ""}${bpmAdjustmentPercent}% on track B — the Spotify client exposes no playback-rate control for music, so this is reported but never applied`,
    );
  }
  if (settings.smartEq) {
    caveats.push(
      overlapping
        ? "EQ shaping is planned but cannot be applied: during a native crossfade Spotify owns both streams and exposes no per-band control"
        : "EQ shaping is approximated with broadband volume automation — there is no per-band control available",
    );
  }
  if (entryCue.time > 0.5 && overlapping) {
    caveats.push(
      "intro skipping needs a seek after the track change, which the native crossfade path cannot do mid-overlap — it is applied on the fade path only",
    );
  }

  return {
    from: fromTrack,
    to: toTrack,
    compatibility,
    technique: strategy.technique,
    executor: strategy.executor,
    style: settings.style,
    startPointSec: round(startPointSec, 2),
    durationSec,
    durationBeats: bpmA ? Math.round(secondsToBeats(durationSec, bpmA)) : null,
    entryPointSec: overlapping ? 0 : round(entryCue.time, 2),
    bpmAdjustmentPercent,
    bpmAdjustmentApplied: false,
    beatAlignment,
    phraseAlignment,
    eq: planEq(settings.smartEq, compatibility.overall),
    gain: planGain(
      settings.loudnessNormalization,
      fromAnalysis,
      toAnalysis,
      capabilities.perTrackGain.status === "available",
    ),
    curve: settings.style === "custom" ? settings.fadeCurve : profile.curve,
    rationale,
    caveats,
  };
}
