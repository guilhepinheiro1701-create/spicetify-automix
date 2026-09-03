/**
 * Transition score bands.
 *
 * The bands are not decoration. Each one names a different decision about how
 * much of the two tracks may be exposed at once, and the engine reads the band
 * — not the raw number — when it picks a strategy and a length.
 *
 * The thresholds are set where the *audible* behaviour should change:
 *
 *  - **Perfect / Excellent** — the pair beatmatches by luck and agrees
 *    harmonically. A long, obvious mix is safe; anything shorter wastes it.
 *  - **Good** — one dimension is off. Still worth a real blend, kept to a phrase
 *    so the weak dimension is not exposed for long.
 *  - **Acceptable** — two dimensions are off, or the data is thin. Short blend:
 *    enough to avoid a hard edge, not enough to sound like a mistake.
 *  - **Poor** — do not overlap. Get out cleanly and start the next track fresh.
 */

export type ScoreBand = "perfect" | "excellent" | "good" | "acceptable" | "poor";

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
    description: "beatmatched and harmonically locked — use the whole runway",
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
    min: 0,
    windowUsage: 0.35,
    allowsOverlap: false,
    description: "do not overlap — switch cleanly instead",
  },
];

export function bandFor(overall: number): BandInfo {
  const pct = Math.round(Math.max(0, Math.min(1, overall)) * 100);
  for (const b of BANDS) if (pct >= b.min) return b;
  return BANDS[BANDS.length - 1] as BandInfo;
}

export const bandLabel = (overall: number): string => bandFor(overall).label;
