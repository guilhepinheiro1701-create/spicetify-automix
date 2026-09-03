/**
 * Derived features.
 *
 * Spotify's `audio-features` endpoint (the one that gave you a ready-made
 * `energy` number) was closed to new applications in November 2024. What the
 * desktop client still exposes is the lower-level *audio analysis*: a beat
 * grid, sections, and per-segment loudness/timbre vectors. Everything in this
 * file rebuilds the high-level numbers from that raw material.
 *
 * These are proxies, and the code says so — they are labelled "derived" in the
 * UI and never presented as Spotify's own figures. They are, however, computed
 * from the same signal the original features were, and they rank tracks
 * consistently, which is all the transition engine needs.
 */

import { clamp01, mean, median, normalize, percentile } from "../core/util.js";

export interface RawSegment {
  start: number;
  duration: number;
  loudness_start: number;
  loudness_max: number;
  loudness_max_time?: number;
  confidence?: number;
  pitches?: number[];
  timbre?: number[];
}

export interface RawInterval {
  start: number;
  duration: number;
  confidence: number;
}

export interface DerivedFeatures {
  energy: number;
  brightness: number;
  pulseStrength: number;
  /** Per-section energy, index-aligned with the sections passed in. */
  sectionEnergy: number[];
}

/**
 * Timbre coefficient 1 tracks spectral centroid ("brightness") and, in
 * practice, lands roughly in ±150. Coefficient 0 tracks loudness.
 */
const TIMBRE_BRIGHTNESS_RANGE = 150;

/** Perceptually useful loudness window for pop/electronic masters. */
const LOUDNESS_FLOOR_DB = -30;
const LOUDNESS_CEIL_DB = -3;

export function segmentEnergy(seg: RawSegment): number {
  // Level: how loud the segment peaks.
  const level = normalize(seg.loudness_max, LOUDNESS_FLOOR_DB, LOUDNESS_CEIL_DB);
  // Attack: a big jump from onset to peak means a percussive, energetic hit.
  const attack = clamp01((seg.loudness_max - seg.loudness_start) / 24);
  // Brightness: high spectral centroid reads as energetic.
  const timbre1 = seg.timbre?.[1];
  const bright =
    timbre1 === undefined
      ? 0.5
      : clamp01((timbre1 + TIMBRE_BRIGHTNESS_RANGE) / (2 * TIMBRE_BRIGHTNESS_RANGE));

  return clamp01(level * 0.55 + attack * 0.2 + bright * 0.25);
}

/** Regularity of the beat grid — a strong, even pulse is danceable. */
export function computePulseStrength(beats: readonly RawInterval[]): number {
  if (beats.length < 8) return 0.5;
  const durations = beats.map((b) => b.duration).filter((d) => d > 0.05 && d < 2);
  if (durations.length < 8) return 0.5;

  const med = median(durations);
  if (med <= 0) return 0.5;
  // Coefficient of variation: low spread = machine-tight timing.
  const spread = mean(durations.map((d) => Math.abs(d - med) / med));
  const regularity = clamp01(1 - spread * 8);

  const conf = clamp01(mean(beats.map((b) => b.confidence ?? 0.5)));
  return clamp01(regularity * 0.65 + conf * 0.35);
}

export function computeBrightness(segments: readonly RawSegment[]): number {
  const values = segments
    .map((s) => s.timbre?.[1])
    .filter((v): v is number => typeof v === "number");
  if (values.length === 0) return 0.5;
  return clamp01((mean(values) + TIMBRE_BRIGHTNESS_RANGE) / (2 * TIMBRE_BRIGHTNESS_RANGE));
}

/**
 * Track-level energy.
 *
 * Weighted from the loud part of the track rather than its mean, because a
 * quiet intro should not make a banger read as calm. We use the 75th
 * percentile of segment energy as the "how hard does this go" figure and blend
 * in tempo and pulse.
 */
export function computeEnergy(
  segments: readonly RawSegment[],
  beats: readonly RawInterval[],
  tempo: number | undefined,
  trackLoudness: number | undefined,
): number {
  const tempoComponent =
    tempo === undefined ? 0.5 : clamp01(normalize(tempo, 60, 170) * 0.9 + 0.05);

  if (segments.length === 0) {
    const level =
      trackLoudness === undefined
        ? 0.5
        : normalize(trackLoudness, LOUDNESS_FLOOR_DB, LOUDNESS_CEIL_DB);
    return clamp01(level * 0.6 + tempoComponent * 0.4);
  }

  const energies = segments.map(segmentEnergy);
  const loudPart = percentile(energies, 0.75);
  const overall = mean(energies);
  const pulse = computePulseStrength(beats);

  return clamp01(loudPart * 0.45 + overall * 0.2 + tempoComponent * 0.2 + pulse * 0.15);
}

/** Mean segment energy inside each section, for structure-aware cue picking. */
export function computeSectionEnergy(
  segments: readonly RawSegment[],
  sections: readonly RawInterval[],
): number[] {
  if (sections.length === 0) return [];
  if (segments.length === 0) return sections.map(() => 0.5);

  const out: number[] = [];
  let cursor = 0;
  for (const section of sections) {
    const end = section.start + section.duration;
    const bucket: number[] = [];
    // Segments are ordered, so walk them once across all sections.
    let i = cursor;
    while (i < segments.length) {
      const seg = segments[i] as RawSegment;
      if (seg.start >= end) break;
      if (seg.start + seg.duration > section.start) bucket.push(segmentEnergy(seg));
      i++;
    }
    cursor = Math.max(cursor, i - 1);
    out.push(bucket.length ? clamp01(mean(bucket)) : 0.5);
  }
  return out;
}

export function deriveFeatures(
  segments: readonly RawSegment[],
  beats: readonly RawInterval[],
  sections: readonly RawInterval[],
  tempo: number | undefined,
  trackLoudness: number | undefined,
): DerivedFeatures {
  return {
    energy: computeEnergy(segments, beats, tempo, trackLoudness),
    brightness: computeBrightness(segments),
    pulseStrength: computePulseStrength(beats),
    sectionEnergy: computeSectionEnergy(segments, sections),
  };
}
