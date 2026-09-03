/**
 * Harmonic mixing via the Camelot wheel.
 *
 * The wheel is the circle of fifths relabelled 1..12 with a letter for the
 * mode: `A` = minor, `B` = major. Two tracks mix harmonically when their codes
 * are identical, differ by one step around the wheel, or are relative
 * major/minor of one another (same number, other letter).
 *
 * Reference: Mixed In Key's harmonic mixing rules, the de-facto standard used
 * by Rekordbox, Serato, Traktor and Mixxx.
 */

export type Mode = 0 | 1; // 0 = minor, 1 = major

export interface CamelotKey {
  /** 1..12 */
  number: number;
  /** "A" = minor, "B" = major */
  letter: "A" | "B";
}

const PITCH_NAMES = [
  "C",
  "C♯/D♭",
  "D",
  "D♯/E♭",
  "E",
  "F",
  "F♯/G♭",
  "G",
  "G♯/A♭",
  "A",
  "A♯/B♭",
  "B",
] as const;

/**
 * Camelot number for each pitch class, per mode.
 * Index = pitch class (C=0 … B=11).
 */
const MAJOR_CAMELOT = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const MINOR_CAMELOT = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

/** Convert a Spotify-style (pitch class, mode) pair to a Camelot code. */
export function toCamelot(pitchClass: number, mode: number): CamelotKey | null {
  if (!Number.isInteger(pitchClass) || pitchClass < 0 || pitchClass > 11) return null;
  if (mode !== 0 && mode !== 1) return null;
  const table = mode === 1 ? MAJOR_CAMELOT : MINOR_CAMELOT;
  const number = table[pitchClass];
  if (number === undefined) return null;
  return { number, letter: mode === 1 ? "B" : "A" };
}

export function camelotToString(k: CamelotKey | null): string {
  return k ? `${k.number}${k.letter}` : "—";
}

/** Human-readable key name, e.g. "A minor". */
export function keyName(pitchClass: number | undefined, mode: number | undefined): string {
  if (pitchClass === undefined || pitchClass < 0 || pitchClass > 11) return "—";
  const name = PITCH_NAMES[pitchClass];
  if (!name) return "—";
  if (mode === undefined) return name;
  return `${name} ${mode === 1 ? "major" : "minor"}`;
}

/** Shortest distance around the 12-position wheel, 0..6. */
export function wheelDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 12;
  return Math.min(raw, 12 - raw);
}

export type HarmonicRelation =
  | "same-key"
  | "relative" // 8A ↔ 8B
  | "adjacent" // ±1, same letter — a perfect fifth away
  | "energy-boost" // +2, same letter — deliberate lift
  | "energy-drop" // -2, same letter
  | "diagonal" // ±1 and a letter change — usable but exposed
  | "distant";

export interface HarmonicResult {
  relation: HarmonicRelation;
  /** 0..1 compatibility. */
  score: number;
  from: CamelotKey | null;
  to: CamelotKey | null;
  detail: string;
}

/**
 * Score values are deliberately not linear in wheel distance: DJs treat the
 * "perfect" moves (same / relative / ±1) as effectively interchangeable and
 * everything past +2 as a clash regardless of how far around the wheel it is.
 */
const SCORES: Record<HarmonicRelation, number> = {
  "same-key": 1.0,
  relative: 0.92,
  adjacent: 0.88,
  "energy-boost": 0.62,
  "energy-drop": 0.55,
  diagonal: 0.42,
  distant: 0.18,
};

export function harmonicCompatibility(
  aPitch: number | undefined,
  aMode: number | undefined,
  bPitch: number | undefined,
  bMode: number | undefined,
): HarmonicResult {
  const from = aPitch === undefined || aMode === undefined ? null : toCamelot(aPitch, aMode);
  const to = bPitch === undefined || bMode === undefined ? null : toCamelot(bPitch, bMode);

  if (!from || !to) {
    return {
      relation: "distant",
      score: 0.5, // unknown must be neutral, never a penalty
      from,
      to,
      detail: "key unknown — neutral score",
    };
  }

  const sameLetter = from.letter === to.letter;
  const diff = ((to.number - from.number + 12) % 12 + 12) % 12;
  const signedDiff = diff > 6 ? diff - 12 : diff;
  const dist = wheelDistance(from.number, to.number);

  let relation: HarmonicRelation;
  if (sameLetter && dist === 0) relation = "same-key";
  else if (!sameLetter && dist === 0) relation = "relative";
  else if (sameLetter && dist === 1) relation = "adjacent";
  else if (sameLetter && signedDiff === 2) relation = "energy-boost";
  else if (sameLetter && signedDiff === -2) relation = "energy-drop";
  else if (!sameLetter && dist === 1) relation = "diagonal";
  else relation = "distant";

  // Beyond the named relations, decay gently with wheel distance so a 6-step
  // clash still scores below a 3-step one.
  let score = SCORES[relation];
  if (relation === "distant") {
    score = Math.max(0.05, 0.34 - (dist - 2) * 0.05);
  }

  const detail =
    relation === "distant"
      ? `${camelotToString(from)} → ${camelotToString(to)} (${dist} steps apart)`
      : `${camelotToString(from)} → ${camelotToString(to)} (${relation.replace("-", " ")})`;

  return { relation, score, from, to, detail };
}

/** Codes that mix cleanly with the given one — used by Queue Intelligence. */
export function compatibleCodes(k: CamelotKey): CamelotKey[] {
  const up = (k.number % 12) + 1;
  const down = ((k.number + 10) % 12) + 1;
  const other: "A" | "B" = k.letter === "A" ? "B" : "A";
  return [
    { number: k.number, letter: k.letter },
    { number: k.number, letter: other },
    { number: up, letter: k.letter },
    { number: down, letter: k.letter },
  ];
}
