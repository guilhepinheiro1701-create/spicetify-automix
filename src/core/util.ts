/** Small numeric and timing helpers used across the engine. */

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const clamp01 = (v: number): number => clamp(v, 0, 1);

/** Round to a sane number of decimals for display. */
export const round = (v: number, decimals = 2): number => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};

export const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Percentile of a numeric array. `p` in 0..1. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = clamp(Math.round(p * (s.length - 1)), 0, s.length - 1);
  return s[idx] as number;
}

/** Map a value from one range to 0..1, clamped. */
export const normalize = (v: number, lo: number, hi: number): number =>
  hi === lo ? 0 : clamp01((v - lo) / (hi - lo));

/**
 * Equal-power crossfade pair for a normalized position `t` in 0..1.
 * Keeps perceived loudness roughly constant through the blend, which is what
 * DJ mixers and the classic sine/cosine law do.
 */
export function equalPower(t: number): { out: number; in: number } {
  const x = clamp01(t) * (Math.PI / 2);
  return { out: Math.cos(x), in: Math.sin(x) };
}

export function fadeGain(curve: string, t: number, direction: "in" | "out"): number {
  const x = clamp01(t);
  switch (curve) {
    case "equal-power": {
      const p = equalPower(x);
      return direction === "in" ? p.in : p.out;
    }
    case "exponential": {
      // A -60 dB floor, which is perceptually even rather than linear in gain.
      // Both ends are pinned exactly so a ramp starts and finishes where the
      // caller asked rather than at the floor value.
      if (direction === "in") return x === 0 ? 0 : Math.pow(10, (-60 * (1 - x)) / 20);
      return x === 1 ? 0 : Math.pow(10, (-60 * x) / 20);
    }
    case "s-curve": {
      const s = x * x * (3 - 2 * x);
      return direction === "in" ? s : 1 - s;
    }
    default:
      return direction === "in" ? x : 1 - x;
  }
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => (g <= 0 ? -Infinity : 20 * Math.log10(g));

/** Extract a base62 id from a Spotify URI, or null for anything else. */
export function trackIdFromUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const m = /^spotify:track:([A-Za-z0-9]{22})$/.exec(uri);
  return m ? (m[1] as string) : null;
}
