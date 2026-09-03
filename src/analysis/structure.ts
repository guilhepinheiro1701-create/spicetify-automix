/**
 * Musical structure: phrase grids and cue points.
 *
 * A DJ does not switch tracks at an arbitrary second. They switch on a phrase
 * boundary — the start of a new 8, 16 or 32 beat block — because that is where
 * the music itself turns over. This module recovers that grid from the beat and
 * section data, and then picks the exit point in the outgoing track and the
 * entry point in the incoming one.
 */

import { clamp, clamp01 } from "../core/util.js";
import type { CuePoint, PhraseGrid, TrackAnalysis } from "../core/types.js";

const DEFAULT_BEATS_PER_BAR = 4;
const DEFAULT_BARS_PER_PHRASE = 4; // 16 beats — the safe universal phrase

/**
 * Recover the phrase grid.
 *
 * The beat grid tells us where beats are but not where a *phrase* begins. We
 * recover the phase by testing every possible bar offset and keeping the one
 * whose phrase boundaries best line up with the section boundaries the analysis
 * already found — sections are where the arrangement actually changes, so a
 * grid that agrees with them is the grid the producer wrote to.
 */
export function buildPhraseGrid(analysis: TrackAnalysis): PhraseGrid | null {
  const beatsPerBar =
    analysis.timeSignature && analysis.timeSignature >= 2 && analysis.timeSignature <= 12
      ? analysis.timeSignature
      : DEFAULT_BEATS_PER_BAR;

  const bars = analysis.bars ?? [];
  const beats = analysis.beats ?? [];

  let secPerBeat: number;
  if (analysis.tempo && analysis.tempo > 0) {
    secPerBeat = 60 / analysis.tempo;
  } else if (beats.length > 4) {
    const durations = beats.map((b) => b.duration).sort((a, b) => a - b);
    secPerBeat = durations[durations.length >> 1] as number;
  } else {
    return null;
  }
  if (!Number.isFinite(secPerBeat) || secPerBeat <= 0) return null;

  const barDuration = secPerBeat * beatsPerBar;
  const barsPerPhrase = DEFAULT_BARS_PER_PHRASE;
  const phraseDuration = barDuration * barsPerPhrase;

  // A tempo alone is enough for a usable grid. Manual overrides and most
  // third-party providers give a BPM with no beat list, and a grid anchored at
  // zero still lets us reason about phrase *lengths* — it just cannot claim to
  // know where the producer's downbeats fall, so its confidence stays low.
  const gridSource = bars.length > 0 ? bars : beats;
  const firstDownbeat = gridSource.length > 0 ? (gridSource[0] as { start: number }).start : 0;

  const sections = analysis.sections ?? [];
  let originSec = firstDownbeat;
  let confidence = bars.length > 0 ? 0.6 : beats.length > 0 ? 0.4 : 0.2;

  if (sections.length >= 2 && phraseDuration > 0) {
    // Try each bar-offset within one phrase and keep the best-aligned.
    let bestOffset = 0;
    let bestError = Infinity;
    for (let barOffset = 0; barOffset < barsPerPhrase; barOffset++) {
      const origin = firstDownbeat + barOffset * barDuration;
      let error = 0;
      for (const s of sections) {
        const rel = (s.start - origin) / phraseDuration;
        const distance = Math.abs(rel - Math.round(rel));
        error += distance * (s.confidence ?? 0.5);
      }
      error /= sections.length;
      if (error < bestError) {
        bestError = error;
        bestOffset = barOffset;
      }
    }
    originSec = firstDownbeat + bestOffset * barDuration;
    // bestError is 0 for a perfect fit and 0.5 for a random one.
    confidence = clamp01(1 - bestError * 2) * (bars.length > 0 ? 1 : beats.length > 0 ? 0.8 : 0.5);
  }

  return {
    beatsPerBar,
    barsPerPhrase,
    originSec,
    secPerBeat,
    confidence: clamp01(confidence),
  };
}

export const phraseDurationSec = (grid: PhraseGrid): number =>
  grid.secPerBeat * grid.beatsPerBar * grid.barsPerPhrase;

/** Nearest phrase boundary to `time`. `direction` biases the rounding. */
export function nearestPhraseBoundary(
  grid: PhraseGrid,
  time: number,
  direction: "nearest" | "before" | "after" = "nearest",
): number {
  const p = phraseDurationSec(grid);
  if (p <= 0) return time;
  const rel = (time - grid.originSec) / p;
  const n =
    direction === "before" ? Math.floor(rel) : direction === "after" ? Math.ceil(rel) : Math.round(rel);
  return grid.originSec + n * p;
}

/** Nearest downbeat (bar start) to `time`. */
export function nearestDownbeat(grid: PhraseGrid, time: number): number {
  const bar = grid.secPerBeat * grid.beatsPerBar;
  if (bar <= 0) return time;
  const n = Math.round((time - grid.originSec) / bar);
  return grid.originSec + n * bar;
}

/** True when `time` sits within `toleranceSec` of a phrase boundary. */
export function isOnPhrase(grid: PhraseGrid, time: number, toleranceSec = 0.12): boolean {
  return Math.abs(time - nearestPhraseBoundary(grid, time)) <= toleranceSec;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exit cue — where we leave the outgoing track
// ─────────────────────────────────────────────────────────────────────────────

export interface ExitCueOptions {
  /** Length of the blend we intend to run, in seconds. */
  durationSec: number;
  /** Never leave the track before this fraction has played. */
  minPlayedFraction: number;
  /** Prefer to end the blend no later than this many seconds before the end. */
  tailGuardSec: number;
  usePhrases: boolean;
}

const DEFAULT_EXIT_OPTIONS: ExitCueOptions = {
  durationSec: 8,
  minPlayedFraction: 0.5,
  tailGuardSec: 0,
  usePhrases: true,
};

/**
 * Pick where to start the transition out of track A.
 *
 * Candidates come from three places, in descending musical authority:
 * the mastering fade-out, section boundaries near the end, and the phrase grid.
 * Each is scored on how close it is to the ideal exit time — the point where
 * the blend would finish right as the track's own material runs out.
 */
export function findExitCue(
  analysis: TrackAnalysis,
  grid: PhraseGrid | null,
  options: Partial<ExitCueOptions> = {},
): CuePoint {
  const opts = { ...DEFAULT_EXIT_OPTIONS, ...options };
  const durationSec = analysis.durationMs / 1000;
  const earliest = durationSec * opts.minPlayedFraction;

  // Where the blend should ideally begin so it finishes as the track ends.
  const idealExit = Math.max(
    earliest,
    durationSec - opts.tailGuardSec - opts.durationSec,
  );

  const candidates: CuePoint[] = [];

  // 1. The recording's own fade-out. Nothing beats the mastering engineer.
  if (
    typeof analysis.startOfFadeOut === "number" &&
    analysis.startOfFadeOut > earliest &&
    analysis.startOfFadeOut < durationSec
  ) {
    candidates.push({
      time: analysis.startOfFadeOut,
      reason: "fade-out-start",
      strength: 0.95,
    });
  }

  // 2. Section boundaries in the back half — the outro, the last chorus.
  const sections = analysis.sections ?? [];
  const sectionEnergy = analysis.sectionEnergy ?? [];
  for (let i = 1; i < sections.length; i++) {
    const s = sections[i];
    if (!s || s.start < earliest || s.start >= durationSec - 1) continue;
    const prevEnergy = sectionEnergy[i - 1];
    const thisEnergy = sectionEnergy[i];
    let strength = 0.6 + clamp01(s.confidence ?? 0.5) * 0.25;
    let reason: CuePoint["reason"] = "section-boundary";
    // A section that drops in energy is a natural place to leave.
    if (prevEnergy !== undefined && thisEnergy !== undefined) {
      const drop = prevEnergy - thisEnergy;
      if (drop > 0.12) {
        strength += 0.12;
        reason = "energy-drop";
      }
    }
    candidates.push({ time: s.start, reason, strength: clamp01(strength) });
  }

  // 3. The phrase grid — always available once we have a tempo.
  if (opts.usePhrases && grid) {
    const p = phraseDurationSec(grid);
    if (p > 0.5) {
      for (let t = nearestPhraseBoundary(grid, idealExit, "before"); t < durationSec; t += p) {
        if (t < earliest) continue;
        candidates.push({
          time: t,
          reason: "phrase-boundary",
          strength: 0.55 * (0.5 + grid.confidence * 0.5),
          phraseBeats: grid.beatsPerBar * grid.barsPerPhrase,
        });
        if (t > idealExit + p * 2) break;
      }
    }
  }

  // 4. Nothing musical to go on — fall back to a plain offset from the end.
  if (candidates.length === 0) {
    return {
      time: clamp(idealExit, earliest, Math.max(earliest, durationSec - 0.5)),
      reason: "fallback-offset",
      strength: 0.2,
    };
  }

  // Score: musical authority, weighted down by distance from the ideal exit.
  const window = Math.max(4, opts.durationSec * 1.5);
  let best = candidates[0] as CuePoint;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const distance = Math.abs(c.time - idealExit);
    // Leaving late (overrunning the track) is worse than leaving early.
    const lateness = c.time > idealExit ? 1.6 : 1;
    const proximity = Math.exp(-0.5 * ((distance * lateness) / window) ** 2);
    const score = c.strength * 0.55 + proximity * 0.45;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  // Snap to the grid. A phrase line is the real target — leaving on a downbeat
  // that sits mid-phrase is what a listener hears as "cut off early". We only
  // fall back to bar snapping when the nearest phrase line would push the exit
  // outside the window we are allowed to leave in.
  const latest = Math.max(earliest, durationSec - 0.5);
  if (grid && best.reason !== "fallback-offset") {
    const candidates: number[] = [];
    if (opts.usePhrases) {
      candidates.push(
        nearestPhraseBoundary(grid, best.time, "before"),
        nearestPhraseBoundary(grid, best.time, "after"),
      );
    }
    candidates.push(nearestDownbeat(grid, best.time));

    const bar = grid.secPerBeat * grid.beatsPerBar;
    const phrase = phraseDurationSec(grid);
    for (const t of candidates) {
      if (t < earliest || t > latest) continue;
      // A phrase line may move the exit by up to half a phrase; a bar line only
      // by half a bar. Anything further is not a snap, it is a different cue.
      const limit = Math.abs(t - nearestPhraseBoundary(grid, t)) < 1e-6 ? phrase * 0.5 : bar * 0.5;
      if (Math.abs(t - best.time) <= limit) {
        best = { ...best, time: t };
        break;
      }
    }
  }

  return { ...best, time: clamp(best.time, earliest, latest) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry cue — where we come into the incoming track
// ─────────────────────────────────────────────────────────────────────────────

export interface EntryCueOptions {
  /** Allow skipping past a quiet intro. */
  skipDeadIntro: boolean;
  /** Never skip more than this. */
  maxSkipSec: number;
}

/**
 * Pick where to start track B.
 *
 * Usually 0 — dropping into the middle of a track is a strong move that only
 * pays off when the opening is genuinely dead air. We skip only when the intro
 * is measurably quieter than the body of the track, and we always land on a
 * downbeat.
 */
export function findEntryCue(
  analysis: TrackAnalysis,
  grid: PhraseGrid | null,
  options: Partial<EntryCueOptions> = {},
): CuePoint {
  const opts = { skipDeadIntro: true, maxSkipSec: 30, ...options };

  if (!opts.skipDeadIntro) {
    return { time: 0, reason: "fade-in-end", strength: 1 };
  }

  const fadeIn = typeof analysis.endOfFadeIn === "number" ? analysis.endOfFadeIn : 0;
  let target = fadeIn;
  let reason: CuePoint["reason"] = "fade-in-end";
  let strength = 0.5;

  const sections = analysis.sections ?? [];
  const sectionEnergy = analysis.sectionEnergy ?? [];
  if (sections.length >= 2 && sectionEnergy.length === sections.length) {
    const body = [...sectionEnergy].sort((a, b) => b - a)[0] ?? 0.5;
    // Walk forward while the opening sections are clearly below the track's peak.
    for (let i = 0; i < sections.length - 1; i++) {
      const e = sectionEnergy[i];
      const s = sections[i];
      if (e === undefined || !s) break;
      if (e < body * 0.55 && s.start + s.duration <= opts.maxSkipSec) {
        target = s.start + s.duration;
        reason = "energy-rise";
        strength = 0.8;
        continue;
      }
      break;
    }
  }

  if (target > opts.maxSkipSec) target = 0;
  if (target > 0 && grid) {
    const snapped = nearestDownbeat(grid, target);
    if (snapped >= 0 && Math.abs(snapped - target) < grid.secPerBeat * grid.beatsPerBar) {
      target = Math.max(0, snapped);
    }
  }

  return { time: Math.max(0, target), reason, strength };
}

/**
 * How well a blend of `durationSec` starting at `exitTime` sits on the grid.
 * Returns 0..1; used as the phrase component of the compatibility score.
 */
export function phraseAlignmentScore(
  grid: PhraseGrid | null,
  exitTime: number,
  durationSec: number,
): number {
  if (!grid) return 0.35;
  const p = phraseDurationSec(grid);
  if (p <= 0) return 0.35;

  const startOffset = Math.abs(exitTime - nearestPhraseBoundary(grid, exitTime)) / p;
  const startScore = clamp01(1 - startOffset * 4);

  // A blend that spans a whole number of phrases resolves cleanly.
  const phrases = durationSec / p;
  const lengthOffset = Math.abs(phrases - Math.round(phrases));
  const lengthScore = clamp01(1 - lengthOffset * 3);

  return clamp01((startScore * 0.6 + lengthScore * 0.4) * (0.55 + grid.confidence * 0.45));
}

/** Beats to the next phrase boundary from `time`. */
export function beatsToNextPhrase(grid: PhraseGrid, time: number): number {
  const next = nearestPhraseBoundary(grid, time, "after");
  return (next - time) / grid.secPerBeat;
}

/**
 * Round a blend length onto the grid.
 *
 * A blend that spans whole phrases resolves with the music; one that spans a
 * ragged number of bars does not. So whole phrases are tried first and given a
 * clear preference, and whole bars are the fallback for when no phrase multiple
 * fits inside the caller's bounds. If nothing fits, the desired length is
 * returned unchanged rather than forced somewhere musical but wrong.
 */
export function alignDurationToPhrase(
  grid: PhraseGrid,
  desiredSec: number,
  minSec = 0,
  maxSec = Number.POSITIVE_INFINITY,
): number {
  const bar = grid.secPerBeat * grid.beatsPerBar;
  const phrase = phraseDurationSec(grid);
  if (bar <= 0) return desiredSec;

  // DJs count in eights. A whole phrase is best; failing that a power-of-two
  // number of bars (4, 8, 16, 32 beats) still resolves. Three bars does not,
  // which is why plain "nearest whole bar" is not good enough here.
  const candidates: { value: number; bonus: number }[] = [];
  for (let n = 1; n <= 8; n++) {
    const v = phrase * n;
    if (v > maxSec) break;
    candidates.push({ value: v, bonus: 0.45 });
  }
  for (let n = 1; n <= 32; n++) {
    const v = bar * n;
    if (v > maxSec) break;
    const isPowerOfTwo = (n & (n - 1)) === 0;
    candidates.push({ value: v, bonus: isPowerOfTwo ? 0.25 : 0 });
  }

  let best: number | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    if (c.value < minSec || c.value > maxSec) continue;
    const closeness = 1 / (1 + Math.abs(c.value - desiredSec) / Math.max(bar, 0.001));
    const score = closeness + c.bonus;
    if (score > bestScore) {
      bestScore = score;
      best = c.value;
    }
  }

  return best ?? desiredSec;
}


// ─────────────────────────────────────────────────────────────────────────────
// Phase alignment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the incoming track's beat grid sits relative to its own start.
 *
 * This is the number the old code was missing. Snapping the *outgoing* track's
 * exit to one of its own downbeats is only half of a phase-locked switch: the
 * incoming track begins at its position zero, and its first downbeat lands
 * wherever its grid origin says — typically a fraction of a bar in, because of a
 * pickup, a count-in, or a moment of silence before the first hit.
 *
 * Firing the switch that many seconds *early* makes the two grids coincide.
 * Returns a value in [0, one bar).
 */
export function gridPhaseOffsetSec(grid: PhraseGrid | null): number {
  if (!grid) return 0;
  const bar = grid.secPerBeat * grid.beatsPerBar;
  if (!Number.isFinite(bar) || bar <= 0) return 0;
  const phase = ((grid.originSec % bar) + bar) % bar;
  return Number.isFinite(phase) ? phase : 0;
}

/**
 * The instant to trigger the switch so that the incoming track's first downbeat
 * lands on `targetDownbeatSec` of the outgoing one.
 *
 * `latencyCompensationSec` is the user's own correction for however long their
 * client takes to actually change track — we cannot measure that from inside
 * the renderer, so it is exposed as a setting rather than guessed at.
 */
export function phaseAlignedSwitchSec(
  targetDownbeatSec: number,
  incomingGrid: PhraseGrid | null,
  latencyCompensationSec = 0,
): number {
  return targetDownbeatSec - gridPhaseOffsetSec(incomingGrid) - latencyCompensationSec;
}
