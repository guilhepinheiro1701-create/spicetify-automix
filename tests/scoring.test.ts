import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, scoreCompatibility } from "../src/engine/scoring.js";
import { analysis, track } from "./helpers.js";
import type { TrackAnalysis } from "../src/core/types.js";

const ALL_ON = {
  harmonicMixing: true,
  energyMatching: true,
  phraseMatching: true,
  loudnessNormalization: true,
};

function score(from: TrackAnalysis, to: TrackAnalysis, exitTimeSec = 200, durationSec = 8) {
  return scoreCompatibility({
    fromTrack: track({ uri: "spotify:track:a", name: "A" }),
    toTrack: track({ uri: "spotify:track:b", name: "B", artists: ["Other"] }),
    from,
    to,
    exitTimeSec,
    durationSec,
    toggles: ALL_ON,
  });
}

describe("scoring weights", () => {
  it("sums to 1", () => {
    const total = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("ranks tempo as the heaviest component", () => {
    const entries = Object.entries(DEFAULT_WEIGHTS).sort((a, b) => b[1] - a[1]);
    expect(entries[0]![0]).toBe("tempo");
    expect(entries[1]![0]).toBe("key");
  });
});

describe("overall compatibility", () => {
  it("scores the brief's good example very high", () => {
    // 128/Am/0.82 → 126/Am/0.79
    const a = analysis({ tempo: 128, key: 9, mode: 0, energy: 0.82, loudness: -7 });
    const b = analysis({ tempo: 126, key: 9, mode: 0, energy: 0.79, loudness: -7.4 });
    const r = score(a, b);
    expect(r.overall).toBeGreaterThan(0.8);
    expect(r.tempo.score).toBeGreaterThan(0.95);
    expect(r.key.score).toBe(1);
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it("scores the brief's bad example low", () => {
    // 90/C major → 145/F# minor
    const a = analysis({ tempo: 90, key: 0, mode: 1, energy: 0.4, loudness: -12 });
    const b = analysis({ tempo: 145, key: 6, mode: 0, energy: 0.9, loudness: -5 });
    const r = score(a, b);
    expect(r.overall).toBeLessThan(0.4);
    expect(r.tempo.score).toBeLessThan(0.3);
    expect(r.key.score).toBeLessThan(0.4);
    expect(r.energy.score).toBeLessThan(0.3);
  });

  it("orders a graded set of pairs sensibly", () => {
    const base = analysis({ tempo: 128, key: 9, mode: 0, energy: 0.8, loudness: -7 });
    const perfect = score(base, analysis({ tempo: 128, key: 9, mode: 0, energy: 0.83, loudness: -7 }));
    const good = score(base, analysis({ tempo: 126, key: 4, mode: 0, energy: 0.78, loudness: -8 }));
    const ok = score(base, analysis({ tempo: 120, key: 2, mode: 1, energy: 0.65, loudness: -10 }));
    const bad = score(base, analysis({ tempo: 90, key: 6, mode: 1, energy: 0.25, loudness: -18 }));

    expect(perfect.overall).toBeGreaterThan(good.overall);
    expect(good.overall).toBeGreaterThan(ok.overall);
    expect(ok.overall).toBeGreaterThan(bad.overall);
  });

  it("always stays inside 0..1", () => {
    const extremes: [number, number][] = [
      [60, 180],
      [40, 250],
      [128, 128],
      [90, 145],
    ];
    for (const [ta, tb] of extremes) {
      for (const [ka, kb] of [
        [0, 6],
        [9, 9],
      ]) {
        const r = score(
          analysis({ tempo: ta, key: ka, mode: 0, energy: 0.05 }),
          analysis({ tempo: tb, key: kb, mode: 1, energy: 0.99 }),
        );
        expect(r.overall).toBeGreaterThanOrEqual(0);
        expect(r.overall).toBeLessThanOrEqual(1);
        expect(r.confidence).toBeGreaterThanOrEqual(0);
        expect(r.confidence).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("missing data is neutral, not a penalty", () => {
  const rich = analysis({ tempo: 128, key: 9, mode: 0, energy: 0.8, loudness: -7 });

  it("reports zero confidence but a mid score when the other track is unknown", () => {
    const unknown: TrackAnalysis = {
      uri: "spotify:track:b",
      source: "heuristic",
      confidence: 0.1,
      fetchedAt: Date.now(),
      durationMs: 200_000,
      beats: [],
      bars: [],
      sections: [],
      sectionEnergy: [],
      grid: null,
    };
    const r = score(rich, unknown);
    expect(r.tempo.score).toBe(0.5);
    expect(r.tempo.confidence).toBe(0);
    expect(r.key.score).toBe(0.5);
    expect(r.overall).toBeGreaterThan(0.3);
    expect(r.overall).toBeLessThan(0.62);
    expect(r.confidence).toBeLessThan(0.25);
  });

  it("scores an unknown pair above an actively incompatible one", () => {
    const unknown: TrackAnalysis = {
      uri: "spotify:track:b",
      source: "heuristic",
      confidence: 0.1,
      fetchedAt: Date.now(),
      durationMs: 200_000,
      beats: [],
      bars: [],
      sections: [],
      sectionEnergy: [],
      grid: null,
    };
    const clash = analysis({ tempo: 60, key: 6, mode: 1, energy: 0.05, loudness: -25 });
    expect(score(rich, unknown).overall).toBeGreaterThan(score(rich, clash).overall);
  });
});

describe("toggles", () => {
  it("drops a disabled component out of the weighted mean", () => {
    const a = analysis({ tempo: 128, key: 9, mode: 0, energy: 0.8 });
    const clashingKey = analysis({ tempo: 128, key: 6, mode: 1, energy: 0.8 });

    const withKey = scoreCompatibility({
      fromTrack: track(),
      toTrack: track({ uri: "spotify:track:b" }),
      from: a,
      to: clashingKey,
      exitTimeSec: 200,
      durationSec: 8,
      toggles: ALL_ON,
    });
    const withoutKey = scoreCompatibility({
      fromTrack: track(),
      toTrack: track({ uri: "spotify:track:b" }),
      from: a,
      to: clashingKey,
      exitTimeSec: 200,
      durationSec: 8,
      toggles: { ...ALL_ON, harmonicMixing: false },
    });

    // Turning harmonic mixing off must stop the key clash from dragging the score down.
    expect(withoutKey.overall).toBeGreaterThan(withKey.overall);
    expect(withoutKey.key.detail).toBe("not evaluated");
  });
});

describe("custom weights", () => {
  it("respects a caller-supplied weight vector", () => {
    const a = analysis({ tempo: 128, key: 9, mode: 0, energy: 0.8 });
    const b = analysis({ tempo: 90, key: 9, mode: 0, energy: 0.8 });

    const tempoHeavy = scoreCompatibility({
      fromTrack: track(),
      toTrack: track({ uri: "spotify:track:b" }),
      from: a,
      to: b,
      exitTimeSec: 200,
      durationSec: 8,
      toggles: ALL_ON,
      weights: { tempo: 1, key: 0, energy: 0, phrase: 0, loudness: 0, style: 0 },
    });
    const tempoIgnored = scoreCompatibility({
      fromTrack: track(),
      toTrack: track({ uri: "spotify:track:b" }),
      from: a,
      to: b,
      exitTimeSec: 200,
      durationSec: 8,
      toggles: ALL_ON,
      weights: { tempo: 0, key: 1, energy: 0, phrase: 0, loudness: 0, style: 0 },
    });

    expect(tempoHeavy.overall).toBeLessThan(0.3);
    expect(tempoIgnored.overall).toBe(1);
  });
});
