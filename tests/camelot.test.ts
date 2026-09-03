import { describe, expect, it } from "vitest";
import {
  camelotToString,
  compatibleCodes,
  harmonicCompatibility,
  keyName,
  toCamelot,
  wheelDistance,
} from "../src/music/camelot.js";

describe("Camelot conversion", () => {
  it("maps the canonical keys", () => {
    // A minor is 8A, C major is 8B — the classic relative pair.
    expect(camelotToString(toCamelot(9, 0))).toBe("8A");
    expect(camelotToString(toCamelot(0, 1))).toBe("8B");
    // G major is 9B, E minor is 9A.
    expect(camelotToString(toCamelot(7, 1))).toBe("9B");
    expect(camelotToString(toCamelot(4, 0))).toBe("9A");
    // F major 7B, D minor 7A.
    expect(camelotToString(toCamelot(5, 1))).toBe("7B");
    expect(camelotToString(toCamelot(2, 0))).toBe("7A");
  });

  it("covers all 24 keys without collisions", () => {
    const seen = new Set<string>();
    for (let pitch = 0; pitch < 12; pitch++) {
      for (const mode of [0, 1]) {
        const code = camelotToString(toCamelot(pitch, mode));
        expect(code).not.toBe("—");
        seen.add(code);
      }
    }
    expect(seen.size).toBe(24);
  });

  it("rejects out-of-range input", () => {
    expect(toCamelot(-1, 1)).toBeNull();
    expect(toCamelot(12, 1)).toBeNull();
    expect(toCamelot(5, 2)).toBeNull();
    expect(toCamelot(1.5, 1)).toBeNull();
  });

  it("measures wheel distance as the shorter arc", () => {
    expect(wheelDistance(1, 12)).toBe(1);
    expect(wheelDistance(12, 1)).toBe(1);
    expect(wheelDistance(1, 7)).toBe(6);
    expect(wheelDistance(3, 3)).toBe(0);
  });
});

describe("harmonic compatibility", () => {
  it("scores the same key highest", () => {
    const r = harmonicCompatibility(9, 0, 9, 0);
    expect(r.relation).toBe("same-key");
    expect(r.score).toBe(1);
  });

  it("scores relative major/minor near the top", () => {
    // A minor (8A) → C major (8B)
    const r = harmonicCompatibility(9, 0, 0, 1);
    expect(r.relation).toBe("relative");
    expect(r.score).toBeGreaterThan(0.85);
  });

  it("scores a neighbouring wheel step near the top", () => {
    // A minor (8A) → E minor (9A)
    const r = harmonicCompatibility(9, 0, 4, 0);
    expect(r.relation).toBe("adjacent");
    expect(r.score).toBeGreaterThan(0.8);
  });

  it("wraps around the wheel", () => {
    // 12A → 1A is one step, not eleven.
    const from = toCamelot(1, 0); // C# minor = 12A
    expect(camelotToString(from)).toBe("12A");
    const r = harmonicCompatibility(1, 0, 8, 0); // 12A → 1A
    expect(r.relation).toBe("adjacent");
  });

  it("distinguishes an energy boost from an energy drop", () => {
    const up = harmonicCompatibility(9, 0, 2, 0); // 8A → 7A? check direction
    const boost = harmonicCompatibility(9, 0, 11, 0); // 8A → 10A (+2)
    expect(boost.relation).toBe("energy-boost");
    expect(boost.score).toBeGreaterThan(0.5);
    expect(boost.score).toBeLessThan(0.8);
    expect(up.score).toBeGreaterThan(0);
  });

  it("penalises the tritone clash", () => {
    // The user's own example: C major → F# something is maximally distant.
    const r = harmonicCompatibility(0, 1, 6, 0);
    expect(r.score).toBeLessThan(0.35);
  });

  it("ranks a clash strictly below every good relation", () => {
    const same = harmonicCompatibility(9, 0, 9, 0).score;
    const relative = harmonicCompatibility(9, 0, 0, 1).score;
    const adjacent = harmonicCompatibility(9, 0, 4, 0).score;
    const clash = harmonicCompatibility(0, 1, 6, 1).score;
    expect(clash).toBeLessThan(adjacent);
    expect(adjacent).toBeLessThan(relative);
    expect(relative).toBeLessThan(same);
  });

  it("returns a neutral 0.5 when a key is unknown, not a penalty", () => {
    expect(harmonicCompatibility(undefined, undefined, 9, 0).score).toBe(0.5);
    expect(harmonicCompatibility(9, 0, undefined, undefined).score).toBe(0.5);
    expect(harmonicCompatibility(undefined, undefined, undefined, undefined).score).toBe(0.5);
  });

  it("names keys readably", () => {
    expect(keyName(9, 0)).toBe("A minor");
    expect(keyName(0, 1)).toBe("C major");
    expect(keyName(undefined, undefined)).toBe("—");
  });

  it("lists exactly the four classic compatible moves", () => {
    const codes = compatibleCodes({ number: 8, letter: "A" }).map(camelotToString);
    expect(new Set(codes)).toEqual(new Set(["8A", "8B", "9A", "7A"]));
  });

  it("wraps compatible codes at the seam", () => {
    const codes = compatibleCodes({ number: 12, letter: "B" }).map(camelotToString);
    expect(new Set(codes)).toEqual(new Set(["12B", "12A", "1B", "11B"]));
  });
});
