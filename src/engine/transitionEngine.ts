/**
 * Transition Engine — `calculateTransition(trackA, trackB) → TransitionPlan`.
 *
 * Pure computation: it reads analyses and settings and produces a plan. It
 * never touches playback. That separation is what makes the whole algorithm
 * unit-testable without a Spotify client.
 *
 * The order of reasoning mirrors how a DJ actually prepares a mix:
 *
 *     structure of A ─┐
 *     structure of B ─┴─► how much runway is there to mix in?
 *                              │
 *     score the pair ──────────┴─► what band is this, and what strategy?
 *                              │
 *                              ├─► how long, given the runway and the band?
 *                              ├─► where exactly does A leave, on a phrase?
 *                              ├─► how early to fire so B's downbeat lands on A's?
 *                              └─► where does B come in?
 *
 * Crucially the length comes from the *runway* — the outgoing track's outro and
 * the incoming track's intro — not from a tempo formula. Two tracks at the same
 * BPM get very different transitions depending on whether A fades out over
 * thirty seconds or stops dead.
 */

import { clamp, round } from "../core/util.js";
import { beatsToSeconds, secondsToBeats, snapToPhraseLength } from "../music/tempo.js";
import { loudnessCompatibility } from "../music/loudness.js";
import {
  alignDurationToPhrase,
  findEntryCue,
  findExitCue,
  gridPhaseOffsetSec,
  isOnPhrase,
  nearestDownbeat,
} from "../analysis/structure.js";
import { classifySections, mixableWindowSec } from "../analysis/sections.js";
import { scoreCompatibility, type ScoringWeights } from "./scoring.js";
import { baseBeatsFor, selectStrategy } from "./strategy.js";
import { bandFor } from "./bands.js";
import { styleProfile } from "../config/styles.js";
import type { Settings } from "../config/defaults.js";
import type { CapabilitySet } from "../platform/capabilities.js";
import type {
  EqPlan,
  GainPlan,
  TrackAnalysis,
  TrackRef,
  TrackStructure,
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

const NEUTRAL_COMPONENT = { score: 0.5, confidence: 0, detail: "n/a" };

/** Plan used when there is nothing to mix into, or nothing we may do. */
function passthroughPlan(input: TransitionInput, reason: string): TransitionPlan {
  const durationSec = input.fromAnalysis.durationMs / 1000;
  return {
    from: input.fromTrack,
    to: input.toTrack,
    compatibility: {
      overall: 0,
      confidence: 0,
      tempo: { ...NEUTRAL_COMPONENT },
      key: { ...NEUTRAL_COMPONENT },
      energy: { ...NEUTRAL_COMPONENT },
      phrase: { ...NEUTRAL_COMPONENT },
      loudness: { ...NEUTRAL_COMPONENT },
      style: { ...NEUTRAL_COMPONENT },
      tempoRatio: 1,
      tempoDeltaPercent: 0,
    },
    technique: "gapless-passthrough",
    executor: "passive",
    strategy: "safe",
    band: bandFor(0).label,
    style: input.settings.style,
    startPointSec: durationSec,
    leadInSec: 0,
    durationSec: 0,
    durationBeats: null,
    entryPointSec: 0,
    bpmAdjustmentPercent: 0,
    bpmAdjustmentApplied: false,
    beatAlignment: false,
    phraseAlignment: false,
    phaseOffsetSec: 0,
    mixableWindowSec: 0,
    windowLimitedBy: "unknown",
    eq: { enabled: false, shaping: "none", approximated: false },
    gain: { trackA: 0, trackB: 0, perTrackSupported: false },
    curve: input.settings.fadeCurve,
    rationale: [reason],
    caveats: [],
  };
}

/**
 * EQ intent.
 *
 * A DJ swaps the bass: the outgoing track's low end comes out as the incoming
 * one's comes in, so two basslines never occupy the same space. There is no
 * per-band control anywhere in this environment, so the only honest thing this
 * can express is *which gesture* was wanted. The fade executor approximates the
 * audible part of a bass swap by front-loading the outgoing ramp; the overlap
 * path cannot act on it at all.
 *
 * Deliberately no dB figures: numbers nothing applies are theatre.
 */
function planEq(enabled: boolean, overlapping: boolean): EqPlan {
  if (!enabled) return { enabled: false, shaping: "none", approximated: false };
  return {
    enabled: true,
    shaping: overlapping ? "not-applicable" : "front-loaded-fade",
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
  return { trackA: 0, trackB: round(l.suggestedTrimDb, 1), perTrackSupported };
}

/**
 * How much of a fade-path transition is spent on the way out.
 *
 * With no overlap available the budget is split between fading the outgoing
 * track down and bringing the incoming one up. A track with a real outro can
 * afford to spend longer leaving — that material is expendable. A track that
 * stops dead should get out quickly and give the time to the incoming track
 * instead, so the new one is established before the listener notices a gap.
 */
export function fadeOutShare(from: TrackStructure | null): number {
  if (!from?.known) return 0.55;
  if (from.outroRunwaySec >= 8) return 0.65;
  if (from.outroRunwaySec <= 2) return 0.4;
  return 0.55;
}

/** A track that is mostly talking or a live recording will not mix like a record. */
function isAtypical(a: TrackAnalysis | null): boolean {
  if (!a) return false;
  return (a.speechiness ?? 0) > 0.5 || (a.liveness ?? 0) > 0.8;
}

const structureOf = (a: TrackAnalysis): TrackStructure =>
  a.structure ?? classifySections(a);

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

  // ── Structure first: how much room is there actually to mix in? ───────────
  const fromStructure = structureOf(fromAnalysis);
  const toStructure = structureOf(toAnalysis);
  const bpmA = fromAnalysis.tempo;
  const fallbackWindow = bpmA
    ? beatsToSeconds(profile.preferredBeats, bpmA)
    : (profile.minSec + profile.maxSec) / 2;
  const window = mixableWindowSec(fromStructure, toStructure, fallbackWindow);

  // ── A provisional geometry, so the exit cue has something to aim at ───────
  const provisionalSec = Math.min(fallbackWindow, Math.max(window.windowSec, profile.minSec));
  const provisionalExit = findExitCue(fromAnalysis, gridA, {
    durationSec: provisionalSec,
    minPlayedFraction: 0.4,
    usePhrases: settings.phraseMatching,
  });

  const toggles = {
    harmonicMixing: settings.harmonicMixing,
    energyMatching: settings.energyMatching,
    phraseMatching: settings.phraseMatching,
    loudnessNormalization: settings.loudnessNormalization,
  };

  let compatibility = scoreCompatibility({
    fromTrack,
    toTrack,
    from: fromAnalysis,
    to: toAnalysis,
    exitTimeSec: provisionalExit.time,
    durationSec: provisionalSec,
    toggles,
    ...(input.weights ? { weights: input.weights } : {}),
  });

  // ── Strategy: character and mechanism ─────────────────────────────────────
  const hasBeatGrids = Boolean(
    gridA && gridB && (gridA.confidence > 0.25 || gridB.confidence > 0.25),
  );
  const energyDelta =
    fromAnalysis.energy !== undefined && toAnalysis.energy !== undefined
      ? toAnalysis.energy - fromAnalysis.energy
      : 0;

  const strategy = selectStrategy({
    compatibility,
    capabilities,
    profile,
    hasBeatGrids,
    sameAlbumConsecutive,
    preserveAlbumGapless: settings.preserveAlbumGapless,
    minCompatibilityForBlend: settings.minCompatibilityForBlend,
    mixableWindowSec: window.windowSec,
    windowLimitedBy: window.limitedBy,
    fromStructure,
    toStructure,
    energyDelta,
    incomingIsAtypical: isAtypical(toAnalysis),
  });

  if (strategy.technique === "gapless-passthrough" || strategy.executor === "passive") {
    const plan = passthroughPlan(input, strategy.rationale[0] ?? "standing down");
    plan.technique = strategy.technique;
    plan.strategy = strategy.strategy;
    plan.band = strategy.band.label;
    plan.compatibility = compatibility;
    plan.caveats = strategy.caveats;
    plan.rationale = strategy.rationale;
    plan.mixableWindowSec = round(window.windowSec, 1);
    plan.windowLimitedBy = window.limitedBy;
    return plan;
  }

  // ── Length: runway first, tempo second ────────────────────────────────────
  // The structural window is the ceiling. Within it, the band says how much we
  // are allowed to use, the strategy shapes it, and the user's intensity and
  // bounds have the final say.
  const overlapping = strategy.executor === "native-crossfade";

  const structuralCeiling =
    window.limitedBy === "unknown"
      ? profile.maxSec
      : Math.max(profile.minSec, window.windowSec * strategy.band.windowUsage);

  let desiredSec: number;
  if (settings.autoMode) {
    const beats = baseBeatsFor(strategy.technique, profile);
    const intensityFactor = 0.6 + settings.intensity * 0.8;
    const beatsSec = bpmA
      ? beatsToSeconds(beats, bpmA)
      : (profile.minSec + profile.maxSec) / 2;
    desiredSec = beatsSec * intensityFactor * strategy.lengthFactor * profile.lengthBias;
  } else {
    desiredSec = ((settings.minDurationSec + settings.maxDurationSec) / 2) * profile.lengthBias;
  }

  // Hard caps: the client's own crossfade ceiling, the user's settings, the
  // style, and never more than a fifth of the track. These may not be exceeded.
  const hardMax = Math.min(
    // The band caps length in absolute terms too, not just as a share of the
    // runway — otherwise a mediocre pair with a huge runway outlasts a perfect
    // pair with a modest one.
    profile.maxSec * strategy.band.windowUsage,
    profile.maxSec,
    settings.maxDurationSec,
    overlapping ? MAX_NATIVE_CROSSFADE_SEC : Number.POSITIVE_INFINITY,
    Math.max(1, trackDurationSec * 0.2),
  );
  const upperBound = Math.min(structuralCeiling, hardMax);
  // The structural ceiling is a judgement about expendable material, not a
  // wall. Landing on a musical length is worth a few percent of overshoot into
  // it — the hard caps above still hold.
  const alignMax = Math.min(hardMax, structuralCeiling * 1.12);
  const lowerBound = Math.min(
    Math.max(profile.minSec, settings.minDurationSec, 0.5),
    Math.max(0.5, upperBound),
  );

  let durationSec = clamp(desiredSec, lowerBound, upperBound);

  // Round onto the grid: whole phrases where they fit, whole bars otherwise.
  if (settings.phraseMatching && gridA) {
    durationSec = alignDurationToPhrase(gridA, durationSec, lowerBound, alignMax);
  } else if (bpmA && settings.autoMode) {
    const snapped = beatsToSeconds(snapToPhraseLength(secondsToBeats(durationSec, bpmA)), bpmA);
    if (snapped >= lowerBound && snapped <= alignMax) durationSec = snapped;
  }
  durationSec = round(clamp(durationSec, 0.5, 12), 2);

  // ── Exit: where A leaves, now that we know how long the blend is ──────────
  const exitCue = findExitCue(fromAnalysis, gridA, {
    durationSec,
    minPlayedFraction: 0.4,
    usePhrases: settings.phraseMatching,
  });
  let startPointSec = clamp(exitCue.time, 1, Math.max(1, trackDurationSec - 0.5));

  const phraseAlignment = Boolean(
    settings.phraseMatching && gridA && isOnPhrase(gridA, startPointSec, 0.2),
  );

  // ── Phase: pull the trigger early so B's downbeat lands on A's ────────────
  // Snapping A's exit to its own downbeat is only half the job. The incoming
  // track starts at its position zero and its first downbeat lands wherever its
  // grid origin says, so the switch has to be fired that much earlier.
  let phaseOffsetSec = 0;
  let beatAlignment = false;
  if (settings.beatMatching && gridA && capabilities.preciseTiming.status === "available") {
    const onGrid = isOnPhrase(gridA, startPointSec, 0.05)
      ? startPointSec
      : nearestDownbeat(gridA, startPointSec);

    if (onGrid > 1 && onGrid < trackDurationSec - 0.5) {
      const rawOffset = gridPhaseOffsetSec(gridB) + settings.switchLatencyMs / 1000;
      const candidate = onGrid - rawOffset;
      // Only take the compensation if it keeps us inside the track and does not
      // drag the exit back off the phrase we just chose.
      if (candidate > 1 && candidate < trackDurationSec - 0.5) {
        startPointSec = candidate;
        phaseOffsetSec = rawOffset;
      } else {
        startPointSec = onGrid;
      }
      // The claim is only honest when both grids are real and the tempos are
      // close enough that the two pulses stay together after the downbeat.
      beatAlignment =
        hasBeatGrids &&
        Boolean(gridB) &&
        Math.abs(compatibility.tempoDeltaPercent) <= 8 &&
        (gridB?.confidence ?? 0) > 0.25;
    }
  }

  // ── Entry: where B comes in ───────────────────────────────────────────────
  const entryCue = findEntryCue(toAnalysis, gridB, {
    skipDeadIntro: settings.skipDeadIntro && profile.favourIntroSkip,
    maxSkipSec: Math.min(30, (toAnalysis.durationMs / 1000) * 0.25),
  });

  // ── Re-score at the final geometry ────────────────────────────────────────
  compatibility = scoreCompatibility({
    fromTrack,
    toTrack,
    from: fromAnalysis,
    to: toAnalysis,
    exitTimeSec: startPointSec,
    durationSec,
    toggles,
    ...(input.weights ? { weights: input.weights } : {}),
  });
  const finalBand = bandFor(compatibility.overall);

  // ── Explain it ────────────────────────────────────────────────────────────
  const rationale = [...strategy.rationale];
  if (window.limitedBy !== "unknown") {
    rationale.push(
      `mixable runway ${window.windowSec.toFixed(1)}s (limited by the ${window.limitedBy})` +
        (fromStructure.known
          ? ` — A outro ${fromStructure.outroRunwaySec.toFixed(0)}s, B intro ${toStructure.introRunwaySec.toFixed(0)}s`
          : ""),
    );
  } else {
    rationale.push("no structural runway data — falling back to a tempo-derived length");
  }
  rationale.push(
    `exit at ${startPointSec.toFixed(1)}s (${exitCue.reason.replace(/-/g, " ")}, strength ${exitCue.strength.toFixed(2)})`,
  );
  if (bpmA) {
    rationale.push(
      `blend ${durationSec.toFixed(1)}s ≈ ${Math.round(secondsToBeats(durationSec, bpmA))} beats at ${bpmA.toFixed(0)} BPM`,
    );
  }
  if (phraseAlignment) rationale.push("switch lands on a phrase boundary");
  if (beatAlignment && phaseOffsetSec > 0.001) {
    rationale.push(
      `fired ${(phaseOffsetSec * 1000).toFixed(0)} ms early so B's first downbeat lands on A's`,
    );
  }
  if (entryCue.time > 0.5) {
    rationale.push(
      `starting track B at ${entryCue.time.toFixed(1)}s to skip a low-energy intro (${entryCue.reason.replace(/-/g, " ")})`,
    );
  }

  // ── And say what it cannot do ─────────────────────────────────────────────
  const caveats = [...strategy.caveats];
  const bpmAdjustmentPercent = round(-compatibility.tempoDeltaPercent, 2);
  if (compatibility.tempo.confidence > 0 && Math.abs(bpmAdjustmentPercent) > 0.5) {
    caveats.push(
      `a true beatmatch would need ${bpmAdjustmentPercent > 0 ? "+" : ""}${bpmAdjustmentPercent}% on track B — the Spotify client exposes no playback-rate control for music, so this is reported but never applied`,
    );
  }
  if (beatAlignment) {
    caveats.push(
      "downbeat alignment is computed from the beat grids; the residual error is however long this client takes to change track, which cannot be measured from inside it — tune it with Advanced → switch latency",
    );
  }
  if (settings.smartEq) {
    caveats.push(
      overlapping
        ? "no EQ shaping is possible during a native crossfade: Spotify owns both streams and exposes no per-band control"
        : "bass-swap shaping is approximated by front-loading the fade — there is no per-band control available",
    );
  }
  if (entryCue.time > 0.5 && overlapping) {
    caveats.push(
      "intro skipping needs a seek after the track change, which the native crossfade path cannot do mid-overlap — it is applied on the fade path only",
    );
  }

  // On the fade path the switch happens at the END of the fade-out, so the
  // executor has to start that much earlier for the switch itself to land on
  // the phrase boundary we picked. The overlap path needs no lead-in: Spotify's
  // mixer begins the blend at the moment of the switch.
  const leadInSec = overlapping ? 0 : round(durationSec * fadeOutShare(fromStructure), 2);

  return {
    from: fromTrack,
    to: toTrack,
    compatibility,
    technique: strategy.technique,
    executor: strategy.executor,
    strategy: strategy.strategy,
    band: finalBand.label,
    style: settings.style,
    startPointSec: round(startPointSec, 2),
    leadInSec,
    durationSec,
    durationBeats: bpmA ? Math.round(secondsToBeats(durationSec, bpmA)) : null,
    entryPointSec: overlapping ? 0 : round(entryCue.time, 2),
    bpmAdjustmentPercent,
    bpmAdjustmentApplied: false,
    beatAlignment,
    phraseAlignment,
    phaseOffsetSec: round(phaseOffsetSec, 4),
    mixableWindowSec: round(window.windowSec, 1),
    windowLimitedBy: window.limitedBy,
    eq: planEq(settings.smartEq, overlapping),
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
