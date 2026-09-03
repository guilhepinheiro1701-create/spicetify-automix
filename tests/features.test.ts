import { describe, expect, it } from "vitest";
import {
  computeBrightness,
  computeEnergy,
  computePulseStrength,
  computeSectionEnergy,
  deriveFeatures,
  segmentEnergy,
  type RawSegment,
} from "../src/analysis/features.js";
import { normalizeRawAnalysis } from "../src/analysis/providers/spotifyInternal.js";
import { HeuristicProvider } from "../src/analysis/providers/heuristic.js";
import { mergeAnalysis } from "../src/analysis/analyzer.js";
import { analysis, track } from "./helpers.js";

const seg = (over: Partial<RawSegment> = {}): RawSegment => ({
  start: 0,
  duration: 0.25,
  loudness_start: -20,
  loudness_max: -8,
  timbre: [40, 0, 0],
  ...over,
});

describe("segment energy", () => {
  it("rates a loud, percussive, bright segment above a quiet dull one", () => {
    const loud = segmentEnergy(seg({ loudness_start: -24, loudness_max: -4, timbre: [50, 120] }));
    const quiet = segmentEnergy(seg({ loudness_start: -32, loudness_max: -28, timbre: [10, -120] }));
    expect(loud).toBeGreaterThan(quiet);
    expect(loud).toBeLessThanOrEqual(1);
    expect(quiet).toBeGreaterThanOrEqual(0);
  });

  it("copes with a missing timbre vector", () => {
    const v = segmentEnergy(seg({ timbre: undefined }));
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe("pulse strength", () => {
  it("rates a machine-tight grid above a loose one", () => {
    const tight = Array.from({ length: 64 }, (_, i) => ({
      start: i * 0.5,
      duration: 0.5,
      confidence: 0.9,
    }));
    const loose = Array.from({ length: 64 }, (_, i) => ({
      start: i * 0.5,
      duration: 0.5 + (i % 5) * 0.09,
      confidence: 0.3,
    }));
    expect(computePulseStrength(tight)).toBeGreaterThan(computePulseStrength(loose));
    expect(computePulseStrength(tight)).toBeGreaterThan(0.8);
  });

  it("returns a neutral value with too few beats", () => {
    expect(computePulseStrength([])).toBe(0.5);
    expect(computePulseStrength([{ start: 0, duration: 0.5, confidence: 1 }])).toBe(0.5);
  });
});

describe("track energy", () => {
  it("is driven by the loud part, not the quiet intro", () => {
    const beats = Array.from({ length: 64 }, (_, i) => ({
      start: i * 0.5,
      duration: 0.5,
      confidence: 0.9,
    }));
    const quietIntro = Array.from({ length: 20 }, (_, i) =>
      seg({ start: i * 0.25, loudness_max: -32, loudness_start: -34 }),
    );
    const body = Array.from({ length: 80 }, (_, i) =>
      seg({ start: 5 + i * 0.25, loudness_max: -4, loudness_start: -22, timbre: [50, 90] }),
    );
    const withIntro = computeEnergy([...quietIntro, ...body], beats, 128, -6);
    const bodyOnly = computeEnergy(body, beats, 128, -6);
    // The intro should barely move the number.
    expect(Math.abs(withIntro - bodyOnly)).toBeLessThan(0.12);
  });

  it("falls back to loudness and tempo with no segments", () => {
    const loud = computeEnergy([], [], 170, -4);
    const quiet = computeEnergy([], [], 70, -26);
    expect(loud).toBeGreaterThan(quiet);
    expect(loud).toBeLessThanOrEqual(1);
    expect(quiet).toBeGreaterThanOrEqual(0);
  });

  it("returns something sane with nothing at all", () => {
    const v = computeEnergy([], [], undefined, undefined);
    expect(v).toBeGreaterThan(0.2);
    expect(v).toBeLessThan(0.8);
  });
});

describe("section energy", () => {
  it("aligns one value per section", () => {
    const sections = [
      { start: 0, duration: 10, confidence: 0.8 },
      { start: 10, duration: 10, confidence: 0.8 },
    ];
    const segments = [
      ...Array.from({ length: 40 }, (_, i) => seg({ start: i * 0.25, loudness_max: -30 })),
      ...Array.from({ length: 40 }, (_, i) => seg({ start: 10 + i * 0.25, loudness_max: -4 })),
    ];
    const out = computeSectionEnergy(segments, sections);
    expect(out).toHaveLength(2);
    expect(out[1]!).toBeGreaterThan(out[0]!);
  });

  it("returns neutral values when there are no segments", () => {
    const out = computeSectionEnergy([], [{ start: 0, duration: 10, confidence: 1 }]);
    expect(out).toEqual([0.5]);
  });

  it("returns an empty array with no sections", () => {
    expect(computeSectionEnergy([seg()], [])).toEqual([]);
  });
});

describe("brightness", () => {
  it("separates bright from dark material", () => {
    const bright = computeBrightness([seg({ timbre: [0, 130] })]);
    const dark = computeBrightness([seg({ timbre: [0, -130] })]);
    expect(bright).toBeGreaterThan(0.8);
    expect(dark).toBeLessThan(0.2);
  });

  it("is neutral with no data", () => {
    expect(computeBrightness([])).toBe(0.5);
  });
});

describe("deriveFeatures", () => {
  it("produces a complete, in-range feature set", () => {
    const f = deriveFeatures(
      [seg(), seg({ start: 0.25 })],
      [{ start: 0, duration: 0.5, confidence: 0.9 }],
      [{ start: 0, duration: 5, confidence: 0.8 }],
      128,
      -7,
    );
    for (const v of [f.energy, f.brightness, f.pulseStrength]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(f.sectionEnergy).toHaveLength(1);
  });
});

describe("normalizing the raw Spotify payload", () => {
  const t = track();

  it("maps the documented shape onto our model", () => {
    const a = normalizeRawAnalysis(
      {
        track: {
          duration: 200,
          tempo: 128.04,
          tempo_confidence: 0.9,
          time_signature: 4,
          key: 9,
          mode: 0,
          key_confidence: 0.7,
          loudness: -6.2,
          end_of_fade_in: 0.5,
          start_of_fade_out: 190,
        },
        beats: [{ start: 0, duration: 0.468, confidence: 0.9 }],
        bars: [{ start: 0, duration: 1.875, confidence: 0.8 }],
        sections: [
          { start: 0, duration: 100, confidence: 0.9, loudness: -7, tempo: 128, key: 9, mode: 0, time_signature: 4 },
        ],
        segments: [seg()],
      },
      t,
    )!;

    expect(a.source).toBe("spotify-internal");
    expect(a.tempo).toBeCloseTo(128.04, 3);
    expect(a.key).toBe(9);
    expect(a.mode).toBe(0);
    expect(a.durationMs).toBe(200_000);
    expect(a.startOfFadeOut).toBe(190);
    expect(a.energy).toBeGreaterThan(0);
    expect(a.sectionEnergy).toHaveLength(1);
  });

  it("treats key -1 as unknown rather than as C", () => {
    const a = normalizeRawAnalysis(
      { track: { duration: 100, tempo: 120, key: -1, mode: -1 } },
      t,
    )!;
    expect(a.key).toBeUndefined();
    expect(a.mode).toBeUndefined();
  });

  it("returns null when the payload has no track block", () => {
    expect(normalizeRawAnalysis({}, t)).toBeNull();
    expect(normalizeRawAnalysis({ beats: [] }, t)).toBeNull();
  });

  it("survives a payload with garbage arrays", () => {
    const a = normalizeRawAnalysis(
      {
        track: { duration: 100, tempo: 120 },
        beats: "nope" as never,
        sections: [{ nonsense: true }] as never,
      },
      t,
    )!;
    expect(a).not.toBeNull();
    expect(a.beats).toEqual([]);
    expect(a.sections).toEqual([]);
  });

  it("scores confidence lower for a sparse payload", () => {
    const rich = normalizeRawAnalysis(
      {
        track: { duration: 200, tempo: 128, tempo_confidence: 0.9, key: 9, mode: 0 },
        beats: Array.from({ length: 40 }, (_, i) => ({ start: i, duration: 1, confidence: 0.9 })),
        sections: [
          { start: 0, duration: 100, confidence: 0.9 },
          { start: 100, duration: 100, confidence: 0.9 },
        ],
        segments: Array.from({ length: 60 }, (_, i) => seg({ start: i * 0.25 })),
      },
      t,
    )!;
    const sparse = normalizeRawAnalysis({ track: { duration: 200, tempo: 128 } }, t)!;
    expect(rich.confidence).toBeGreaterThan(sparse.confidence);
  });
});

describe("heuristic provider", () => {
  it("returns a low-confidence record with no tempo or key", async () => {
    const a = await new HeuristicProvider().fetch(track({ durationMs: 200_000 }));
    expect(a.source).toBe("heuristic");
    expect(a.confidence).toBeLessThan(0.2);
    expect(a.tempo).toBeUndefined();
    expect(a.key).toBeUndefined();
  });
});

describe("merging providers", () => {
  it("fills gaps without overwriting a higher-priority field", () => {
    const primary = analysis({ tempo: 128, key: undefined, mode: undefined, beats: [], bars: [] });
    const secondary = analysis({ tempo: 90, key: 4, mode: 1 });
    const merged = mergeAnalysis(primary, secondary);
    expect(merged.tempo).toBe(128);
    expect(merged.key).toBe(4);
    expect(merged.mode).toBe(1);
    expect(merged.beats!.length).toBeGreaterThan(0);
  });
});
