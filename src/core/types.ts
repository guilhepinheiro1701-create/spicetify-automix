/**
 * Shared domain types for Smart DJ.
 *
 * Everything that crosses a module boundary is described here so the analysis,
 * engine, audio and UI layers can evolve independently.
 */

import type { TrackStructure } from "../analysis/sections.js";
export type { TrackStructure, SectionRole, ClassifiedSection } from "../analysis/sections.js";

// ─────────────────────────────────────────────────────────────────────────────
// Track identity & analysis
// ─────────────────────────────────────────────────────────────────────────────

export interface TrackRef {
  uri: string;
  /** Base62 id extracted from the URI, when the URI is a Spotify track URI. */
  id: string | null;
  name: string;
  artists: string[];
  albumUri: string | null;
  durationMs: number;
  isLocal: boolean;
  /**
   * Where this entry came from in the player's queue model. Only `"queue"`
   * entries — the ones the user queued by hand — can be reordered; `"context"`
   * entries are the playlist or album playing through, and removing one does
   * not stop it coming round again.
   */
  provider: "queue" | "context" | "autoplay" | "unknown";
}

/** Where a piece of analysis came from. Drives confidence and the UI badge. */
export type AnalysisSource =
  | "spotify-internal" // the client's audio-analysis service (beat grid, sections)
  | "spotify-features" // the client's audio-features service (real energy, valence)
  | "manual" // user-entered override
  | "external" // opt-in third-party provider configured by the user
  | "heuristic" // derived from duration/metadata only — very low confidence
  | "none";

/** A single beat/bar/section marker, times in seconds. */
export interface TimeInterval {
  start: number;
  duration: number;
  confidence: number;
}

export interface Section extends TimeInterval {
  loudness: number;
  tempo: number;
  key: number;
  mode: number;
  timeSignature: number;
}

/**
 * Normalized musical description of a track. Every field is optional because
 * providers differ wildly in what they can supply; `confidence` says how much
 * of it we actually trust.
 */
export interface TrackAnalysis {
  uri: string;
  source: AnalysisSource;
  /** 0..1 — overall trust in this analysis. */
  confidence: number;
  fetchedAt: number;

  durationMs: number;

  /** Beats per minute. */
  tempo?: number;
  tempoConfidence?: number;
  /** Beats per bar. 4 for the overwhelming majority of DJ-able music. */
  timeSignature?: number;
  /** Pitch class 0..11 (C=0), or -1/undefined when unknown. */
  key?: number;
  /** 1 = major, 0 = minor. */
  mode?: number;
  keyConfidence?: number;

  /** Integrated loudness in dBFS-ish units, as reported by the provider. */
  loudness?: number;
  /** Derived 0..1 perceived energy. */
  energy?: number;
  /** Derived 0..1 spectral brightness. */
  brightness?: number;
  /** Derived 0..1 rhythmic regularity, from the beat grid. */
  pulseStrength?: number;

  /**
   * Spotify's own high-level descriptors, when the audio-features service
   * answers. These are the real thing rather than anything we derived, and the
   * analyzer prefers them over the proxies wherever both exist.
   */
  danceability?: number;
  valence?: number;
  acousticness?: number;
  instrumentalness?: number;
  speechiness?: number;
  liveness?: number;

  /** Seconds. Where the recording has faded in / starts fading out. */
  endOfFadeIn?: number;
  startOfFadeOut?: number;

  /** Beat grid, seconds. Empty when the provider gave none. */
  beats?: TimeInterval[];
  bars?: TimeInterval[];
  sections?: Section[];

  /** Per-section derived energy, index-aligned with `sections`. */
  sectionEnergy?: number[];

  /**
   * Phrase grid recovered from the beat data. Kept on the analysis so a cached
   * track stays phrase-aware without having to re-store its whole beat grid.
   */
  grid?: PhraseGrid | null;

  /**
   * Labelled structure — intro, drops, breakdown, outro — plus the intro and
   * outro runways the transition engine sizes blends against. Computed once and
   * cached alongside the grid so it survives without the raw section arrays.
   */
  structure?: TrackStructure | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Structure / phrasing
// ─────────────────────────────────────────────────────────────────────────────

/** A musically meaningful moment we could start or end a transition on. */
export interface CuePoint {
  /** Seconds into the track. */
  time: number;
  /** Why we picked it — surfaced in debug mode. */
  reason:
    | "phrase-boundary"
    | "section-boundary"
    | "downbeat"
    | "fade-out-start"
    | "fade-in-end"
    | "energy-drop"
    | "energy-rise"
    | "fallback-offset";
  /** 0..1 — how strong a musical landmark this is. */
  strength: number;
  /** Beat index in the track's beat grid, when known. */
  beatIndex?: number;
  /** Phrase length in beats this point sits on (8/16/32), when known. */
  phraseBeats?: number;
}

export interface PhraseGrid {
  /** Beats per bar. */
  beatsPerBar: number;
  /** Bars per phrase (usually 4 → 16 beats, or 8 → 32 beats). */
  barsPerPhrase: number;
  /** Seconds — the estimated first downbeat. */
  originSec: number;
  /** Seconds per beat at the track's mean tempo. */
  secPerBeat: number;
  /** 0..1 confidence in this grid. */
  confidence: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compatibility scoring
// ─────────────────────────────────────────────────────────────────────────────

export interface ScoreComponent {
  /** 0..1 */
  score: number;
  /** 0..1 — how much real data backed this component. */
  confidence: number;
  /** Human-readable explanation for the debug panel. */
  detail: string;
}

export interface CompatibilityReport {
  /** 0..1 weighted overall compatibility. */
  overall: number;
  /** 0..1 — how much of the score rests on real data rather than defaults. */
  confidence: number;
  tempo: ScoreComponent;
  key: ScoreComponent;
  energy: ScoreComponent;
  phrase: ScoreComponent;
  loudness: ScoreComponent;
  style: ScoreComponent;
  /** Effective tempo relation used (1 = direct, 2 = double-time, 0.5 = half-time). */
  tempoRatio: number;
  /** Percent tempo difference after ratio folding. Signed: B relative to A. */
  tempoDeltaPercent: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transition plan
// ─────────────────────────────────────────────────────────────────────────────

export type TransitionStyle =
  | "smooth"
  | "dj"
  | "energetic"
  | "chill"
  | "seamless"
  | "custom";

/**
 * The musical character of the move, as a DJ would name it. Chosen by the
 * engine from the score band, the energy direction and the structural runway —
 * independent of the user's style preference and of what the client can do.
 */
export type TransitionStrategy =
  | "smooth"
  | "dj"
  | "fast"
  | "long"
  | "energy-rise"
  | "energy-drop"
  | "harmonic"
  | "contrast" // deliberately incompatible, cut decisively on a phrase line
  | "safe";

/**
 * The concrete mechanism chosen for one specific pair of tracks. This is not
 * the user's style preference — it is what the engine decided is achievable
 * and musically right here.
 */
export type TransitionTechnique =
  | "gapless-passthrough" // do nothing: consecutive album tracks, preserve artist intent
  | "beat-aligned-blend" // overlap, downbeats aligned within the client's switch latency
  | "phrase-blend" // overlap starting on a phrase boundary
  | "quick-blend" // short overlap, incompatible-ish pair
  | "fade-cut" // no overlap available: fade A out, cut, fade B in
  | "hard-cut"; // last resort: let Spotify do its normal thing

/** How the plan will actually be produced at the audio layer. */
export type ExecutorKind =
  | "native-crossfade" // real audio overlap via Spotify's own mixer
  | "volume-fade" // no overlap: our own volume automation around the skip
  | "passive"; // we do not touch playback at all

/**
 * What gesture the transition wanted, not what it filtered — there is no
 * equaliser anywhere in this environment. Named for what it is.
 */
export interface ShapingPlan {
  enabled: boolean;
  /**
   * Which gesture was wanted, not a set of gains — there is no per-band control
   * anywhere in this environment, so dB figures here would be decoration.
   * `front-loaded-fade` is the bass-swap approximation the fade executor can
   * actually perform; `not-applicable` means the overlap path cannot act at all.
   */
  shaping: "none" | "front-loaded-fade" | "not-applicable";
  /** Always true when enabled: nothing here is a real filter. */
  approximated: boolean;
}

export interface GainPlan {
  /** dB applied to the outgoing track to match loudness. */
  trackA: number;
  /** dB applied to the incoming track to match loudness. */
  trackB: number;
  /** Whether the executor can actually apply per-track gain (usually false). */
  perTrackSupported: boolean;
}

export interface TransitionPlan {
  from: TrackRef;
  to: TrackRef | null;

  compatibility: CompatibilityReport;

  technique: TransitionTechnique;
  executor: ExecutorKind;
  /** The musical character the engine chose for this pair. */
  strategy: TransitionStrategy;
  /** PERFECT / EXCELLENT / GOOD / ACCEPTABLE / POOR. */
  band: string;
  /** The user-facing style this plan was derived under. */
  style: TransitionStyle;

  /**
   * Seconds into track A at which the *switch itself* happens — the musical
   * moment we chose, on a phrase boundary.
   */
  startPointSec: number;
  /**
   * How long before `startPointSec` the executor has to begin work so that the
   * switch lands on the moment above. Zero for the overlap path, where
   * Spotify's mixer starts the blend at the switch; on the fade path it is the
   * length of the fade-out, which otherwise pushes the switch off the phrase.
   */
  leadInSec: number;
  /** Length of the transition in seconds. */
  durationSec: number;
  /** Length expressed in beats of track A, when a beat grid exists. */
  durationBeats: number | null;

  /** Seconds into track B to start from. 0 unless we skip a dead intro. */
  entryPointSec: number;

  /**
   * Tempo change we would need for a true beatmatch. Always reported, never
   * applied — the Spotify client exposes no rate control for music.
   */
  bpmAdjustmentPercent: number;
  bpmAdjustmentApplied: false;

  /** True when the first downbeat of B is scheduled to land on a downbeat of A. */
  beatAlignment: boolean;
  /** True when the transition begins on a phrase boundary of A. */
  phraseAlignment: boolean;
  /**
   * Seconds the switch was pulled earlier so the incoming track's first
   * downbeat coincides with a downbeat of the outgoing one.
   */
  phaseOffsetSec: number;

  /** Seconds of musically mixable overlap the two tracks' structures allow. */
  mixableWindowSec: number;
  /** Which side of the pair capped that window. */
  windowLimitedBy: "outro" | "intro" | "both" | "unknown";

  shaping: ShapingPlan;
  gain: GainPlan;

  /** Shape of the outgoing/incoming volume ramps. */
  curve: FadeCurve;

  /** Ordered, human-readable reasoning for the debug panel. */
  rationale: string[];
  /** Anything the user should know we could not do. */
  caveats: string[];
  /** Structured record of every feature considered, and why. */
  verdicts: FeatureVerdict[];
  /**
   * How confident we are that this transition, as planned, will sound good —
   * a different question from how technically compatible the two tracks are.
   */
  musicalConfidence: number;
  musicalConfidenceLabel: string;
  confidenceFactors: string[];
}

export type FadeCurve = "equal-power" | "linear" | "exponential" | "s-curve";

/** A feature the engine considered, and what became of it. */
export type PlanFeature =
  | "audio-overlap"
  | "beat-alignment"
  | "phrase-alignment"
  | "fade-shaping"
  | "intro-skip"
  | "loudness-match"
  | "tempo-adjustment";

export type VerdictCode =
  | "used"
  | "capability-unavailable"
  | "disabled-by-user"
  | "data-missing"
  | "not-musically-appropriate";

/**
 * Why a feature was or was not used on this transition.
 *
 * This exists so the debug panel can answer "why wasn't EQ used?" with a real
 * reason, and so a regression test can assert that an unavailable capability
 * was never claimed. Prose caveats are derived from these, not the other way
 * round.
 */
export interface FeatureVerdict {
  feature: PlanFeature;
  used: boolean;
  code: VerdictCode;
  detail: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime status
// ─────────────────────────────────────────────────────────────────────────────

export type TransitionPhase =
  | "idle"
  | "analyzing"
  | "armed"
  | "transitioning"
  | "recovering"
  | "disabled";

export interface TransitionStatus {
  phase: TransitionPhase;
  /** 0..1 progress through the current transition. */
  progress: number;
  plan: TransitionPlan | null;
  /** Seconds until the armed transition fires. */
  etaSec: number | null;
  lastError: string | null;
}
