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
import { musicalConfidence } from "./confidence.js";
import { styleProfile } from "../config/styles.js";
import { intentProfile } from "../config/intent.js";
import type { Settings } from "../config/defaults.js";
import { explainUnavailable, type CapabilitySet } from "../platform/capabilities.js";
import type {
  ShapingPlan,
  FadeGeometry,
  FeatureVerdict,
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

/**
 * Below this harmonic score, an overlap is capped at half a phrase.
 *
 * Chosen against the Camelot score table rather than by taste: it passes the
 * ±2 energy moves (0.55–0.62) and an *unknown* key (0.5, which must never be
 * punished), and catches the diagonal (0.42) and distant (≤0.34) relations —
 * the ones that actually beat against each other.
 */
const KEY_CLASH_SCORE = 0.45;
/** Half a phrase. Long enough to be a blend, short enough not to dwell on a clash. */
const KEY_CLASH_OVERLAP_BEATS = 8;

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
    shaping: { enabled: false, shaping: "none", approximated: false },
    gain: { trackA: 0, trackB: 0, perTrackSupported: false },
    curve: input.settings.fadeCurve,
    fade: { outSec: 0, inSec: 0, floor: 1, outBeats: null },
    rationale: [reason],
    caveats: [],
    verdicts: [],
    musicalConfidence: 0,
    musicalConfidenceLabel: "n/a",
    confidenceFactors: [],
  };
}

/**
 * Record what became of every feature the engine considered.
 *
 * This is the source of truth for the debug panel's "why not?" answers and for
 * the capability regression tests. A feature that is unavailable must appear
 * here with the capability layer's own reason — never silently omitted, and
 * never marked used.
 */
function buildVerdicts(input: {
  caps: CapabilitySet;
  settings: Settings;
  overlapping: boolean;
  beatAlignment: boolean;
  phraseAlignment: boolean;
  entryPointSec: number;
  gainApplied: boolean;
  hasGrids: boolean;
}): FeatureVerdict[] {
  const { caps, settings } = input;
  const v: FeatureVerdict[] = [];
  const capReason = (id: Parameters<typeof explainUnavailable>[0]) => explainUnavailable(id);
  const capOf = (id: keyof CapabilitySet["capabilities"]) => caps.capabilities?.[id];

  v.push(
    input.overlapping
      ? {
          feature: "audio-overlap",
          used: true,
          code: "used",
          detail: "Spotify's own mixer is producing a real overlap",
        }
      : {
          feature: "audio-overlap",
          used: false,
          code: "capability-unavailable",
          detail: capReason(capOf("crossfade")),
        },
  );

  v.push({
    feature: "tempo-adjustment",
    used: false,
    code: "capability-unavailable",
    detail: capReason(capOf("playbackRate")),
  });

  if (!settings.beatMatching) {
    v.push({
      feature: "beat-alignment",
      used: false,
      code: "disabled-by-user",
      detail: "beat alignment is switched off in settings",
    });
  } else if (!input.hasGrids) {
    v.push({
      feature: "beat-alignment",
      used: false,
      code: "data-missing",
      detail: "no usable beat grid on one or both tracks",
    });
  } else {
    v.push({
      feature: "beat-alignment",
      used: input.beatAlignment,
      code: input.beatAlignment ? "used" : "not-musically-appropriate",
      detail: input.beatAlignment
        ? "the switch is pulled early by the incoming track's grid phase so the downbeats coincide"
        : "the tempos are too far apart for the pulses to stay together after the downbeat",
    });
  }

  v.push(
    !settings.phraseMatching
      ? {
          feature: "phrase-alignment",
          used: false,
          code: "disabled-by-user",
          detail: "phrase matching is switched off in settings",
        }
      : {
          feature: "phrase-alignment",
          used: input.phraseAlignment,
          code: input.phraseAlignment ? "used" : "data-missing",
          detail: input.phraseAlignment
            ? "the switch lands on a phrase boundary"
            : "no confident phrase grid to land on",
        },
  );

  // Fade shaping is the closest thing to a bass swap available here, and it is
  // only possible on the fade path.
  if (!settings.fadeShaping) {
    v.push({
      feature: "fade-shaping",
      used: false,
      code: "disabled-by-user",
      detail: "fade shaping is switched off in settings",
    });
  } else if (input.overlapping) {
    v.push({
      feature: "fade-shaping",
      used: false,
      code: "capability-unavailable",
      detail:
        "during a native crossfade Spotify owns both streams; " + capReason(capOf("dsp")),
    });
  } else {
    v.push({
      feature: "fade-shaping",
      used: true,
      code: "used",
      detail:
        "the fade is front-loaded so the outgoing track clears out sooner — broadband, not per-band",
    });
  }

  if (!settings.skipDeadIntro) {
    v.push({
      feature: "intro-skip",
      used: false,
      code: "disabled-by-user",
      detail: "intro skipping is switched off in settings",
    });
  } else if (input.overlapping) {
    v.push({
      feature: "intro-skip",
      used: false,
      code: "capability-unavailable",
      detail: "seeking mid-overlap is not possible; intro skipping works on the fade path only",
    });
  } else {
    v.push({
      feature: "intro-skip",
      used: input.entryPointSec > 0.5,
      code: input.entryPointSec > 0.5 ? "used" : "not-musically-appropriate",
      detail:
        input.entryPointSec > 0.5
          ? `starting the incoming track at ${input.entryPointSec.toFixed(1)}s`
          : "the incoming track has no measurably dead opening to skip",
    });
  }

  v.push(
    !settings.loudnessNormalization
      ? {
          feature: "loudness-match",
          used: false,
          code: "disabled-by-user",
          detail: "loudness matching is switched off in settings",
        }
      : input.overlapping
        ? {
            feature: "loudness-match",
            used: false,
            code: "capability-unavailable",
            detail: capReason(capOf("perTrackGain")),
          }
        : {
            feature: "loudness-match",
            used: input.gainApplied,
            code: input.gainApplied ? "used" : "not-musically-appropriate",
            detail: input.gainApplied
              ? "the incoming track is attenuated to match the outgoing level"
              : "the two tracks are already at a comparable level",
          },
  );

  return v;
}

/**
 * Fade-shaping intent.
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
function planShaping(enabled: boolean, overlapping: boolean): ShapingPlan {
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
 * The fade path's geometry.
 *
 * Deliberately short. With no overlap available the level movement is not the
 * transition — the *switch* is, and it happens at a musically chosen instant.
 * The dip exists only to mask the client's switch gap, so it wants to be about
 * a bar of movement and about a third of the way down, not a five-second
 * dissolve into silence.
 *
 * A track with a real outro can afford a slightly longer dip, because that
 * material is expendable; one that stops dead gets a shorter one.
 */
function planFade(
  from: TrackStructure | null,
  bpm: number | undefined,
  settings: Settings,
): FadeGeometry {
  // One bar is the natural unit: long enough to be smooth, short enough that
  // the listener hears a switch rather than an effect.
  const barSec = bpm ? (60 / bpm) * 4 : 1.6;
  const hasOutro = Boolean(from?.known && from.outroRunwaySec > 6);

  const outSec = clamp(barSec * (hasOutro ? 1 : 0.75), 0.35, 2);
  const inSec = clamp(barSec * 0.75, 0.35, 1.8);

  // Dip far enough to hide the gap, not so far that a hole opens up. Shaping
  // pulls it a little deeper, since front-loading is the point of that setting.
  const floor = settings.fadeShaping ? 0.28 : 0.4;

  return {
    outSec: round(outSec, 3),
    inSec: round(inSec, 3),
    floor,
    outBeats: bpm ? Math.max(1, Math.round((outSec * bpm) / 60)) : null,
  };
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
  const intent = intentProfile(settings.intent);
  // Explicit weights from the caller win; otherwise the user's intent decides
  // what the engine is optimising for.
  const weights = input.weights ?? intent.weights;
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
    weights,
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
    minCompatibilityForBlend: Math.max(settings.minCompatibilityForBlend, intent.blendFloor),
    mixableWindowSec: window.windowSec,
    windowLimitedBy: window.limitedBy,
    fromStructure,
    toStructure,
    energyDelta,
    incomingIsAtypical: isAtypical(toAnalysis),
    allowContrast: intent.allowContrast,
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
    desiredSec =
      beatsSec * intensityFactor * strategy.lengthFactor * profile.lengthBias * intent.lengthBias;
  } else {
    desiredSec = ((settings.minDurationSec + settings.maxDurationSec) / 2) * profile.lengthBias;
  }

  // Two keys can only beat against each other while both are audible, so a
  // clash caps the *overlap* and leaves the cut path alone — on a cut the
  // tonalities never sound together, and shortening it would buy nothing.
  //
  // Without this the band is the only thing keys affect, and a weighted average
  // is too forgiving to act on the project's own stated rule that clashing keys
  // are the most viscerally wrong thing a mix can do: a tritone pair that scores
  // GOOD overall was getting the same full phrase of overlap as a perfect match.
  const keyClash =
    overlapping && settings.harmonicMixing && compatibility.key.score < KEY_CLASH_SCORE;
  const keyClashCapSec = !keyClash
    ? Number.POSITIVE_INFINITY
    : bpmA
      ? beatsToSeconds(KEY_CLASH_OVERLAP_BEATS, bpmA)
      : profile.maxSec * 0.5;

  // Hard caps: the client's own crossfade ceiling, the user's settings, the
  // style, and never more than a fifth of the track. These may not be exceeded.
  const hardMax = Math.min(
    // The band caps length in absolute terms too, not just as a share of the
    // runway — otherwise a mediocre pair with a huge runway outlasts a perfect
    // pair with a modest one.
    profile.maxSec * strategy.band.windowUsage,
    keyClashCapSec,
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
  if (settings.beatMatching && gridA && capabilities.flags.preciseTiming) {
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
    weights,
  });
  const finalBand = bandFor(compatibility.overall);

  const gain = planGain(
    settings.loudnessNormalization,
    fromAnalysis,
    toAnalysis,
    capabilities.flags.perTrackGain,
  );

  const confidence = musicalConfidence({
    compatibility,
    band: finalBand,
    strategy: strategy.strategy,
    mixableWindowSec: window.windowSec,
    durationSec,
    phraseAligned: phraseAlignment,
    fromStructure,
    toStructure,
  });

  const fade = planFade(fromStructure, bpmA, settings);
  // On the fade path the switch happens at the END of the dip, so the executor
  // has to start that much earlier for the switch itself to land on the phrase
  // boundary we picked. The overlap path needs no lead-in: Spotify's mixer
  // begins the blend at the moment of the switch.
  const leadInSec = overlapping ? 0 : fade.outSec;

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
  if (keyClash) {
    rationale.push(
      `keys clash (${compatibility.key.detail}) — overlap held to ` +
        `${KEY_CLASH_OVERLAP_BEATS} beats so the two tonalities are not left ringing together`,
    );
  }
  if (!overlapping) {
    rationale.push(
      `no overlap available, so this is a cut: ${fade.outSec.toFixed(2)}s dip to ` +
        `${Math.round(fade.floor * 100)}% and ${fade.inSec.toFixed(2)}s back, ` +
        "shaped to mask the switch rather than to fade the music out",
    );
  }
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
  if (settings.fadeShaping) {
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
    shaping: planShaping(settings.fadeShaping, overlapping),
    gain,
    curve: settings.style === "custom" ? settings.fadeCurve : profile.curve,
    fade,
    rationale,
    caveats,
    verdicts: buildVerdicts({
      caps: capabilities,
      settings,
      overlapping,
      beatAlignment,
      phraseAlignment,
      entryPointSec: overlapping ? 0 : entryCue.time,
      gainApplied: !overlapping && settings.loudnessNormalization && Math.abs(gain.trackB) > 0.5,
      hasGrids: hasBeatGrids,
    }),
    musicalConfidence: round(confidence.score, 3),
    musicalConfidenceLabel: confidence.label,
    confidenceFactors: confidence.factors,
  };
}
