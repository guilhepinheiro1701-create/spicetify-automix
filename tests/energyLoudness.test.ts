import { describe, expect, it } from "vitest";
import {
  energyCompatibility,
  energyLabel,
  progressionSmoothness,
} from "../src/music/energy.js";
import { loudnessCompatibility, loudnessToUnit } from "../src/music/loudness.js";

describe("energy compatibility", () => {
  it("scores a gentle lift highest", () => {
    const lift = energyCompatibility(0.6, 0.64);
    const flat = energyCompatibility(0.6, 0.6);
    const dropABit = energyCompatibility(0.6, 0.56);
    expect(lift.score).toBeGreaterThan(flat.score);
    expect(flat.score).toBeGreaterThan(dropABit.score);
    expect(lift.direction).toBe("rise");
  });

  // The brief's explicit bad case.
  it("rejects the 0.25 → 0.95 jump", () => {
    const r = energyCompatibility(0.25, 0.95);
    expect(r.score).toBeLessThan(0.15);
    expect(r.direction).toBe("rise");
  });

  it("rejects an equally large collapse", () => {
    expect(energyCompatibility(0.95, 0.25).score).toBeLessThan(0.15);
  });

  it("handles the 0.1 → 1.0 extreme safely", () => {
    const r = energyCompatibility(0.1, 1);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThan(0.15);
  });

  it("clamps out-of-range input instead of producing nonsense", () => {
    const r = energyCompatibility(-5, 12);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.delta).toBe(1);
  });

  it("returns neutral when energy is unknown", () => {
    expect(energyCompatibility(undefined, 0.8).score).toBe(0.5);
    expect(energyCompatibility(0.8, undefined).score).toBe(0.5);
  });

  it("labels the bands the way the brief describes", () => {
    expect(energyLabel(0.2)).toBe("very calm");
    expect(energyLabel(0.4)).toBe("low");
    expect(energyLabel(0.6)).toBe("medium");
    expect(energyLabel(0.8)).toBe("very high");
  });

  it("rates a steady climb as a natural progression", () => {
    const natural = progressionSmoothness([0.55, 0.61, 0.68, 0.73, 0.8]);
    const chaotic = progressionSmoothness([0.2, 0.95, 0.3, 0.9, 0.25]);
    expect(natural).toBeGreaterThan(0.6);
    expect(chaotic).toBeLessThan(0.2);
    expect(natural).toBeGreaterThan(chaotic);
  });

  it("treats a single track as perfectly smooth", () => {
    expect(progressionSmoothness([0.5])).toBe(1);
    expect(progressionSmoothness([])).toBe(1);
  });
});

describe("loudness compatibility", () => {
  it("treats a sub-dB difference as inaudible", () => {
    expect(loudnessCompatibility(-8, -8.5).score).toBe(1);
  });

  it("degrades as the jump grows", () => {
    const scores = [1, 3, 6, 12, 20].map((d) => loudnessCompatibility(-14, -14 + d).score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeLessThan(scores[i - 1]!);
    }
    expect(scores.at(-1)!).toBeLessThan(0.15);
  });

  it("is symmetric: a quieter jump is as bad as a louder one", () => {
    expect(loudnessCompatibility(-6, -16).score).toBeCloseTo(
      loudnessCompatibility(-16, -6).score,
      6,
    );
  });

  it("suggests a trim that opposes the difference and stays sane", () => {
    const louder = loudnessCompatibility(-14, -6);
    expect(louder.deltaDb).toBe(8);
    // B is louder, so we would pull it down — and never by more than 6 dB.
    expect(louder.suggestedTrimDb).toBe(-6);

    const quieter = loudnessCompatibility(-6, -14);
    expect(quieter.suggestedTrimDb).toBe(6);

    const tiny = loudnessCompatibility(-8, -10);
    expect(tiny.suggestedTrimDb).toBe(2);
  });

  it("returns neutral for unknown or non-finite loudness", () => {
    expect(loudnessCompatibility(undefined, -8).score).toBe(0.5);
    expect(loudnessCompatibility(-8, Number.NaN).score).toBe(0.5);
    expect(loudnessCompatibility(-Infinity, -8).score).toBe(0.5);
  });

  it("maps dB onto a 0..1 display unit", () => {
    expect(loudnessToUnit(-60)).toBe(0);
    expect(loudnessToUnit(0)).toBe(1);
    expect(loudnessToUnit(-30)).toBeCloseTo(0.5, 6);
    expect(loudnessToUnit(-120)).toBe(0);
  });
});
