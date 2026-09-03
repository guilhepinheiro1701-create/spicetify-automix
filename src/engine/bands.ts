/**
 * Transition score bands.
 *
 * The bands are not decoration. Each one names a different decision about how
 * much of the two tracks may be exposed at once, and the engine reads the band
 * — not the raw number — when it picks a strategy and a length.
 *
 * The thresholds are set where the *audible* behaviour should change:
 *
 *  - **Perfect / Excellent** — the two tempos already agree closely enough to
 *    sit together, and the keys do too. A long, obvious mix is safe; anything
 *    shorter wastes it. (Nothing is beatmatched: no rate control exists here.
 *    The tempos have to have arrived compatible on their own.)
 *  - **Good** — one dimension is off. Still worth a real blend, kept to a phrase
 *    so the weak dimension is not exposed for long.
 *  - **Acceptable** — two dimensions are off, or the data is thin. Short blend:
 *    enough to avoid a hard edge, not enough to sound like a mistake.
 *  - **Poor** — do not overlap, but this is still a transition worth making
 *    well: a clean, phrase-timed switch between two tracks that simply do not
 *    beatmatch is a normal DJ move, not a failure.
 *  - **Very poor** — nothing about the pair lines up. Fade out, fade in, and do
 *    not expose either track underneath the other.
 *
 * Note what a band is *not*: a judgement about whether two tracks belong
 * together. It measures how much they can be overlapped. Contrast is a
 * legitimate move, and `musicalConfidence` on the report is what says whether
 * the chosen approach will actually sound good.
 */

export type ScoreBand =
  | "perfect"
  | "excellent"
  | "good"
  | "acceptable"
  | "poor"
  | "very-poor";

export interface BandInfo {
  band: ScoreBand;
  label: string;
  /** Inclusive lower bound as a percentage. */
  min: number;
  /**
   * Ceiling on blend length, as a fraction of both the structural runway and
   * the style's own maximum. This is what makes the band audible rather than
   * decorative: a GOOD pair physically cannot get an EXCELLENT pair's length.
   */
  windowUsage: number;
  /** Whether an overlap is permitted at all in this band. */
  allowsOverlap: boolean;
  description: string;
}

export const BANDS: BandInfo[] = [
  {
    band: "perfect",
    label: "PERFECT",
    min: 96,
    windowUsage: 1,
    allowsOverlap: true,
    description: "tempos and keys already agree — use the whole runway",
  },
  {
    band: "excellent",
    label: "EXCELLENT",
    min: 90,
    windowUsage: 0.85,
    allowsOverlap: true,
    description: "a long mix is safe",
  },
  {
    band: "good",
    label: "GOOD",
    min: 80,
    windowUsage: 0.65,
    allowsOverlap: true,
    description: "one dimension is off — blend for a phrase, no longer",
  },
  {
    band: "acceptable",
    label: "ACCEPTABLE",
    min: 65,
    windowUsage: 0.45,
    allowsOverlap: true,
    description: "keep the overlap short so neither track is exposed",
  },
  {
    band: "poor",
    label: "POOR",
    min: 45,
    windowUsage: 0.35,
    allowsOverlap: false,
    description: "a safe, deliberate switch rather than a blend",
  },
  {
    band: "very-poor",
    label: "VERY POOR",
    min: 0,
    windowUsage: 0.2,
    allowsOverlap: false,
    description: "no overlap at all — fade out, fade in",
  },
];

export function bandFor(overall: number): BandInfo {
  const pct = Math.round(Math.max(0, Math.min(1, overall)) * 100);
  for (const b of BANDS) if (pct >= b.min) return b;
  return BANDS[BANDS.length - 1] as BandInfo;
}

export const bandLabel = (overall: number): string => bandFor(overall).label;
