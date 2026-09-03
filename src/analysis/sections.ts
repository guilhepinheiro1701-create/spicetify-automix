/**
 * Structural understanding of a track.
 *
 * The analysis service gives us section boundaries with a loudness and a tempo,
 * but no labels — it will not tell you which one is the intro and which is the
 * drop. That labelling is what a DJ actually mixes on, so we infer it from the
 * energy contour, the loudness, and where each section sits in the track.
 *
 * The point of this module is the *runway*: how many seconds of mixable outro
 * the outgoing track has, and how many seconds of intro the incoming one has to
 * come up in. Those two numbers, not the tempo, are what decide how long a
 * blend can musically be.
 */

import { clamp01, percentile } from "../core/util.js";
import type { Section, TrackAnalysis } from "../core/types.js";

export type SectionRole =
  | "intro"
  | "build"
  | "drop" // the loud payoff — a chorus or an EDM drop
  | "body" // verse, or anything unremarkable
  | "breakdown" // a deliberate dip between two loud parts
  | "outro";

export interface ClassifiedSection {
  index: number;
  role: SectionRole;
  startSec: number;
  durationSec: number;
  endSec: number;
  /** 0..1 derived energy for this section. */
  energy: number;
  /** Section loudness in dB, as reported. */
  loudness: number;
  /** Energy change from the previous section. */
  delta: number;
  /** 0..1 — how sure we are of this label. */
  confidence: number;
}

export interface TrackStructure {
  /** False when there were no sections to work with; every field is then null. */
  known: boolean;
  sections: ClassifiedSection[];

  /** The opening low-energy run, if there is one. */
  intro: { startSec: number; endSec: number; durationSec: number } | null;
  /** The closing low-energy run, if there is one. */
  outro: { startSec: number; endSec: number; durationSec: number } | null;

  /**
   * Seconds at the end of the track that can be mixed over without losing
   * anything the listener wants to hear. This is the outro when there is one,
   * otherwise the mastering fade-out, otherwise zero.
   */
  outroRunwaySec: number;
  /**
   * Seconds at the start of the track before it reaches full energy — the room
   * an incoming track has to come up in.
   */
  introRunwaySec: number;

  /** Section index of the loudest payoff, for debugging and cue selection. */
  peakIndex: number | null;
  /** Start of the last big energy payoff, in seconds. */
  lastPeakSec: number | null;
  /** 0..1 median energy across the track. */
  medianEnergy: number;
}

const EMPTY: TrackStructure = {
  known: false,
  sections: [],
  intro: null,
  outro: null,
  outroRunwaySec: 0,
  introRunwaySec: 0,
  peakIndex: null,
  lastPeakSec: null,
  medianEnergy: 0.5,
};

/** Below this fraction of the track's peak energy a section reads as "quiet". */
const QUIET_RATIO = 0.62;
/** An energy change this large between neighbours is a structural event. */
const EVENT_DELTA = 0.1;
/** Longest stretch we will ever call an intro or an outro. */
const MAX_EDGE_RUNWAY_SEC = 45;

/**
 * Label every section.
 *
 * The rules are deliberately simple and explainable, because a wrong label
 * should degrade the mix rather than break it:
 *
 *  - A quiet run at the very start is the intro; at the very end, the outro.
 *  - A local energy maximum near the track's ceiling is a drop.
 *  - A quiet section *between* two loud ones is a breakdown, not an outro.
 *  - A section that climbs steeply into a drop is a build.
 *  - Everything else is body.
 */
export function classifySections(analysis: TrackAnalysis): TrackStructure {
  const sections = analysis.sections ?? [];
  const energies = analysis.sectionEnergy ?? [];
  if (sections.length === 0 || energies.length !== sections.length) return { ...EMPTY };

  const durationSec = analysis.durationMs / 1000;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return { ...EMPTY };

  const peak = percentile(energies, 0.9);
  const medianEnergy = percentile(energies, 0.5);
  const quietThreshold = peak * QUIET_RATIO;

  const isQuiet = (i: number) => (energies[i] as number) < quietThreshold;
  const isLoud = (i: number) => (energies[i] as number) >= peak * 0.88;

  // How many sections from the start are quiet, and from the end.
  let introRun = 0;
  while (introRun < sections.length && isQuiet(introRun)) introRun++;
  let outroRun = 0;
  while (outroRun < sections.length - introRun && isQuiet(sections.length - 1 - outroRun)) outroRun++;

  const classified: ClassifiedSection[] = sections.map((s: Section, i: number) => {
    const energy = energies[i] as number;
    const prev = i > 0 ? (energies[i - 1] as number) : energy;
    const next = i < energies.length - 1 ? (energies[i + 1] as number) : energy;
    const delta = energy - prev;

    let role: SectionRole = "body";
    let confidence = 0.4;

    if (i < introRun) {
      role = "intro";
      confidence = 0.75;
    } else if (i >= sections.length - outroRun) {
      role = "outro";
      confidence = 0.75;
    } else if (isQuiet(i)) {
      // Quiet, but with loud material on both sides: a deliberate dip.
      role = "breakdown";
      confidence = 0.6;
    } else if (isLoud(i) && energy >= prev && energy >= next) {
      role = "drop";
      confidence = 0.65;
    } else if (next - energy > EVENT_DELTA && energy > prev) {
      role = "build";
      confidence = 0.55;
    }

    return {
      index: i,
      role,
      startSec: s.start,
      durationSec: s.duration,
      endSec: s.start + s.duration,
      energy,
      loudness: s.loudness,
      delta,
      confidence: clamp01(confidence * (0.6 + (s.confidence ?? 0.5) * 0.4)),
    };
  });

  const intro =
    introRun > 0
      ? {
          startSec: 0,
          endSec: (classified[introRun - 1] as ClassifiedSection).endSec,
          durationSec: (classified[introRun - 1] as ClassifiedSection).endSec,
        }
      : null;

  const outroStart =
    outroRun > 0 ? (classified[sections.length - outroRun] as ClassifiedSection).startSec : null;
  const outro =
    outroStart !== null
      ? {
          startSec: outroStart,
          endSec: durationSec,
          durationSec: Math.max(0, durationSec - outroStart),
        }
      : null;

  // Runways. The outro is the honest one; failing that, the mastering fade-out
  // is a real, measured signal that the track is on its way out.
  let outroRunwaySec = outro ? outro.durationSec : 0;
  if (outroRunwaySec <= 0 && typeof analysis.startOfFadeOut === "number") {
    outroRunwaySec = Math.max(0, durationSec - analysis.startOfFadeOut);
  }
  outroRunwaySec = Math.min(outroRunwaySec, MAX_EDGE_RUNWAY_SEC, durationSec * 0.4);

  let introRunwaySec = intro ? intro.durationSec : 0;
  if (introRunwaySec <= 0 && typeof analysis.endOfFadeIn === "number") {
    introRunwaySec = Math.max(0, analysis.endOfFadeIn);
  }
  introRunwaySec = Math.min(introRunwaySec, MAX_EDGE_RUNWAY_SEC, durationSec * 0.4);

  // The last real payoff — a DJ times the exit against this, not against the end.
  let peakIndex: number | null = null;
  let lastPeakSec: number | null = null;
  for (const c of classified) {
    if (c.role === "drop") {
      peakIndex = c.index;
      lastPeakSec = c.startSec;
    }
  }
  if (peakIndex === null && classified.length > 0) {
    let best = classified[0] as ClassifiedSection;
    for (const c of classified) if (c.energy > best.energy) best = c;
    peakIndex = best.index;
    lastPeakSec = best.startSec;
  }

  return {
    known: true,
    sections: classified,
    intro,
    outro,
    outroRunwaySec,
    introRunwaySec,
    peakIndex,
    lastPeakSec,
    medianEnergy,
  };
}

/**
 * How long a blend the two tracks can musically support.
 *
 * This is the number the transition engine builds on instead of a tempo
 * formula. Overlapping longer than the outgoing track's outro means mixing over
 * material the listener still wants; longer than the incoming track's intro
 * means its first real moment lands underneath the old track.
 *
 * Both runways are unknown for plenty of tracks, so a floor keeps the answer
 * usable rather than collapsing to zero.
 */
export function mixableWindowSec(
  from: TrackStructure,
  to: TrackStructure,
  fallbackSec: number,
): { windowSec: number; limitedBy: "outro" | "intro" | "both" | "unknown" } {
  const haveOut = from.known && from.outroRunwaySec > 1;
  const haveIn = to.known && to.introRunwaySec > 1;

  if (!haveOut && !haveIn) return { windowSec: fallbackSec, limitedBy: "unknown" };
  if (haveOut && !haveIn) return { windowSec: from.outroRunwaySec, limitedBy: "outro" };
  if (!haveOut && haveIn) return { windowSec: to.introRunwaySec, limitedBy: "intro" };

  const out = from.outroRunwaySec;
  const inn = to.introRunwaySec;
  return {
    windowSec: Math.min(out, inn),
    limitedBy: Math.abs(out - inn) < 0.75 ? "both" : out < inn ? "outro" : "intro",
  };
}

/** Human-readable structure summary for the debug panel. */
export function describeStructure(s: TrackStructure): string {
  if (!s.known) return "structure unknown";
  const shape = s.sections.map((c) => c.role[0]?.toUpperCase() ?? "?").join("");
  return `${shape} · intro ${s.introRunwaySec.toFixed(0)}s · outro ${s.outroRunwaySec.toFixed(0)}s`;
}
