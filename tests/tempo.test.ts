import { describe, expect, it } from "vitest";
import {
  beatsToSeconds,
  isUsableBpm,
  secondsToBeats,
  snapToPhraseLength,
  tempoCompatibility,
  tempoScoreFromDelta,
} from "../src/music/tempo.js";

describe("tempo scoring curve", () => {
  it("is monotonically non-increasing as the gap widens", () => {
    let prev = Infinity;
    for (let d = 0; d <= 40; d += 0.5) {
      const s = tempoScoreFromDelta(d);
      expect(s).toBeLessThanOrEqual(prev + 1e-9);
      prev = s;
    }
  });

  it("stays in 0..1 for absurd inputs", () => {
    for (const d of [0, 6, 50, 200, 1000]) {
      const s = tempoScoreFromDelta(d);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it("treats the vinyl ±6% window as a clean mix", () => {
    expect(tempoScoreFromDelta(0)).toBe(1);
    expect(tempoScoreFromDelta(3)).toBeGreaterThan(0.9);
    expect(tempoScoreFromDelta(6)).toBeGreaterThan(0.7);
    expect(tempoScoreFromDelta(8)).toBeGreaterThan(0.55);
  });

  it("collapses past the point no DJ would attempt a blend", () => {
    expect(tempoScoreFromDelta(20)).toBeLessThan(0.15);
    expect(tempoScoreFromDelta(60)).toBeLessThan(0.05);
  });

  it("is symmetric in sign", () => {
    expect(tempoScoreFromDelta(-5)).toBe(tempoScoreFromDelta(5));
  });
});

describe("tempo compatibility", () => {
  it("scores the worked example (128 → 126) as a strong match", () => {
    const r = tempoCompatibility(128, 126);
    expect(r.ratio).toBe(1);
    expect(r.deltaPercent).toBeCloseTo(-1.5625, 3);
    expect(r.score).toBeGreaterThan(0.95);
    // The engine reports the adjustment it would need but never applies it.
    expect(r.requiredAdjustPercent).toBeCloseTo(1.5625, 3);
  });

  it("finds the double-time relationship", () => {
    const r = tempoCompatibility(70, 140);
    expect(r.ratio).toBe(2);
    expect(r.usesTempoFolding).toBe(true);
    expect(Math.abs(r.deltaPercent)).toBeLessThan(0.001);
    // Folding is a real technique, so it scores high — but below a direct match.
    expect(r.score).toBeGreaterThan(0.85);
    expect(r.score).toBeLessThan(1);
  });

  it("finds the half-time relationship", () => {
    const r = tempoCompatibility(174, 87);
    expect(r.ratio).toBe(0.5);
    expect(r.usesTempoFolding).toBe(true);
    expect(r.score).toBeGreaterThan(0.85);
  });

  it("prefers a direct match over a folded one at equal error", () => {
    const direct = tempoCompatibility(128, 128);
    const folded = tempoCompatibility(64, 128);
    expect(direct.score).toBeGreaterThan(folded.score);
  });

  // The extreme case from the brief.
  it("scores the 90 → 145 mismatch as unblendable", () => {
    const r = tempoCompatibility(90, 145);
    expect(r.score).toBeLessThan(0.3);
    expect(Math.abs(r.deltaPercent)).toBeGreaterThan(12);
  });

  it("handles the 60 → 180 extreme by folding, not by breaking", () => {
    const r = tempoCompatibility(60, 180);
    // 60 doubles to 120, still 50% off; 60 halves to 30, worse. Best is +50%.
    expect(Number.isFinite(r.score)).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThan(0.2);
  });

  it("returns neutral for unknown or nonsense tempos", () => {
    expect(tempoCompatibility(undefined, 128).score).toBe(0.5);
    expect(tempoCompatibility(128, undefined).score).toBe(0.5);
    expect(tempoCompatibility(0, 128).score).toBe(0.5);
    expect(tempoCompatibility(NaN, 128).score).toBe(0.5);
    expect(tempoCompatibility(1000, 128).score).toBe(0.5);
    expect(tempoCompatibility(-120, 128).score).toBe(0.5);
  });

  it("validates the usable BPM range", () => {
    expect(isUsableBpm(128)).toBe(true);
    expect(isUsableBpm(39)).toBe(false);
    expect(isUsableBpm(251)).toBe(false);
    expect(isUsableBpm(undefined)).toBe(false);
    expect(isUsableBpm(Infinity)).toBe(false);
  });
});

describe("beat maths", () => {
  it("converts beats and seconds consistently", () => {
    expect(beatsToSeconds(32, 128)).toBeCloseTo(15, 6);
    expect(secondsToBeats(15, 128)).toBeCloseTo(32, 6);
    expect(secondsToBeats(beatsToSeconds(16, 174), 174)).toBeCloseTo(16, 6);
  });

  it("snaps to the phrase lengths DJs actually use", () => {
    expect(snapToPhraseLength(15)).toBe(16);
    expect(snapToPhraseLength(30)).toBe(32);
    expect(snapToPhraseLength(9)).toBe(8);
    expect(snapToPhraseLength(3)).toBe(4);
    expect(snapToPhraseLength(200)).toBe(64);
    expect(snapToPhraseLength(0.5)).toBe(2);
  });
});
