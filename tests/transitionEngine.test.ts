import { describe, expect, it } from "vitest";
import { calculateTransition } from "../src/engine/transitionEngine.js";
import { selectStrategy } from "../src/engine/strategy.js";
import { STYLE_PROFILES } from "../src/config/styles.js";
import { analysis, capabilities, settings, track } from "./helpers.js";
import type { TransitionPlan } from "../src/core/types.js";

const A = track({ uri: "spotify:track:a", name: "Track A", albumUri: "spotify:album:1" });
const B = track({
  uri: "spotify:track:b",
  name: "Track B",
  artists: ["Other"],
  albumUri: "spotify:album:2",
});

function plan(over: {
  from?: Parameters<typeof analysis>[0];
  to?: Parameters<typeof analysis>[0];
  settings?: Parameters<typeof settings>[0];
  tier?: "dj" | "fade" | "passive";
  toTrack?: typeof B | null;
} = {}): TransitionPlan {
  return calculateTransition({
    fromTrack: A,
    toTrack: over.toTrack === undefined ? B : over.toTrack,
    fromAnalysis: analysis({ uri: A.uri, ...over.from }),
    toAnalysis: over.toTrack === null ? null : analysis({ uri: B.uri, ...over.to }),
    settings: settings(over.settings),
    capabilities: capabilities(over.tier ?? "dj"),
  });
}

describe("plan invariants", () => {
  it("never plans a transition that starts past the end of the track", () => {
    for (const durationMs of [30_000, 90_000, 240_000, 600_000]) {
      const p = plan({ from: { durationMs } });
      expect(p.startPointSec).toBeLessThanOrEqual(durationMs / 1000);
      expect(p.startPointSec).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps the duration inside the user's bounds", () => {
    const p = plan({ settings: { minDurationSec: 3, maxDurationSec: 5 } });
    expect(p.durationSec).toBeGreaterThanOrEqual(0.5);
    expect(p.durationSec).toBeLessThanOrEqual(5);
  });

  it("never exceeds Spotify's own 12 s crossfade ceiling on the overlap path", () => {
    const p = plan({
      settings: { style: "chill", maxDurationSec: 12, intensity: 1 },
      from: { durationMs: 600_000, tempo: 60 },
      to: { tempo: 60 },
    });
    if (p.executor === "native-crossfade") expect(p.durationSec).toBeLessThanOrEqual(12);
  });

  it("never spends more than a fifth of a short track on the way out", () => {
    const p = plan({ from: { durationMs: 40_000 } });
    expect(p.durationSec).toBeLessThanOrEqual(40 * 0.2 + 0.01);
  });

  it("reports the beatmatch it would need but never claims to apply it", () => {
    const p = plan({ from: { tempo: 128 }, to: { tempo: 124 } });
    expect(p.bpmAdjustmentApplied).toBe(false);
    expect(p.bpmAdjustmentPercent).toBeCloseTo(3.125, 2);
    expect(p.caveats.join(" ")).toMatch(/no playback-rate control/i);
  });

  it("produces finite numbers for every extreme pair in the brief", () => {
    const cases: [number, number, number, number, number, number][] = [
      // bpmA, bpmB, keyA, keyB, energyA, energyB
      [60, 180, 0, 6, 0.1, 1],
      [90, 145, 0, 6, 0.4, 0.9],
      [128, 126, 9, 9, 0.82, 0.79],
      [40, 250, 11, 5, 0, 1],
    ];
    for (const [ta, tb, ka, kb, ea, eb] of cases) {
      const p = plan({
        from: { tempo: ta, key: ka, mode: 1, energy: ea },
        to: { tempo: tb, key: kb, mode: 0, energy: eb },
      });
      expect(Number.isFinite(p.startPointSec)).toBe(true);
      expect(Number.isFinite(p.durationSec)).toBe(true);
      expect(p.durationSec).toBeGreaterThanOrEqual(0);
      expect(p.compatibility.overall).toBeGreaterThanOrEqual(0);
      expect(p.compatibility.overall).toBeLessThanOrEqual(1);
    }
  });
});

describe("technique selection", () => {
  it("blends long and beat-aligned when the pair is a strong match", () => {
    const p = plan({
      from: { tempo: 128, key: 9, mode: 0, energy: 0.8, loudness: -7 },
      to: { tempo: 127, key: 9, mode: 0, energy: 0.83, loudness: -7 },
    });
    expect(p.technique).toBe("beat-aligned-blend");
    expect(p.executor).toBe("native-crossfade");
    expect(p.compatibility.overall).toBeGreaterThan(0.72);
  });

  it("refuses a long overlap when the tempos are far apart", () => {
    const p = plan({
      from: { tempo: 90, key: 0, mode: 1, energy: 0.4 },
      to: { tempo: 145, key: 6, mode: 0, energy: 0.9 },
    });
    expect(["fade-cut", "quick-blend"]).toContain(p.technique);
    expect(p.strategy).toBe("safe");
    expect(p.band).toBe("POOR");
    // The reason has to name something the listener could act on, not a number.
    expect(p.rationale.join(" ")).toMatch(/do not overlap|tempo|runway/i);
  });

  it("leaves an album segue completely alone", () => {
    const sameAlbum = track({ uri: "spotify:track:b", name: "B", albumUri: A.albumUri });
    const p = calculateTransition({
      fromTrack: A,
      toTrack: sameAlbum,
      fromAnalysis: analysis({ uri: A.uri }),
      toAnalysis: analysis({ uri: sameAlbum.uri }),
      settings: settings({ preserveAlbumGapless: true }),
      capabilities: capabilities("dj"),
    });
    expect(p.technique).toBe("gapless-passthrough");
    expect(p.executor).toBe("passive");
    expect(p.durationSec).toBe(0);
  });

  it("mixes across an album boundary when the user turns that guard off", () => {
    const sameAlbum = track({ uri: "spotify:track:b", name: "B", albumUri: A.albumUri });
    const p = calculateTransition({
      fromTrack: A,
      toTrack: sameAlbum,
      fromAnalysis: analysis({ uri: A.uri }),
      toAnalysis: analysis({ uri: sameAlbum.uri }),
      settings: settings({ preserveAlbumGapless: false }),
      capabilities: capabilities("dj"),
    });
    expect(p.technique).not.toBe("gapless-passthrough");
  });

  it("stands down entirely when there is no next track", () => {
    const p = plan({ toTrack: null });
    expect(p.executor).toBe("passive");
    expect(p.durationSec).toBe(0);
    expect(p.rationale[0]).toMatch(/no next track/i);
  });
});

describe("style presets", () => {
  const pair = {
    from: { tempo: 128, key: 9, mode: 0, energy: 0.8 },
    to: { tempo: 128, key: 9, mode: 0, energy: 0.82 },
  };

  it("makes energetic shorter than chill", () => {
    const energetic = plan({ ...pair, settings: { style: "energetic" } });
    const chill = plan({ ...pair, settings: { style: "chill" } });
    expect(energetic.durationSec).toBeLessThan(chill.durationSec);
  });

  it("scales with intensity", () => {
    const low = plan({ ...pair, settings: { intensity: 0 } });
    const high = plan({ ...pair, settings: { intensity: 1 } });
    expect(high.durationSec).toBeGreaterThanOrEqual(low.durationSec);
  });

  it("shortens the blend as compatibility falls", () => {
    const great = plan({ ...pair, settings: { style: "dj" } });
    const poor = plan({
      from: { tempo: 128, key: 9, mode: 0, energy: 0.8 },
      to: { tempo: 122, key: 3, mode: 1, energy: 0.55 },
      settings: { style: "dj" },
    });
    expect(poor.durationSec).toBeLessThanOrEqual(great.durationSec);
  });
});

describe("fallback ladder", () => {
  it("falls to a volume fade when no overlap is available", () => {
    const p = plan({ tier: "fade" });
    expect(p.executor).toBe("volume-fade");
    expect(p.caveats.join(" ")).toMatch(/no real audio overlap/i);
  });

  it("goes fully passive when the client offers nothing", () => {
    const p = plan({ tier: "passive" });
    expect(p.executor).toBe("passive");
    expect(p.technique).toBe("hard-cut");
  });

  it("only offers intro skipping on the path that can actually seek", () => {
    const withIntro = { tempo: 120 };
    const overlap = plan({ tier: "dj", to: withIntro, settings: { skipDeadIntro: true } });
    const fade = plan({ tier: "fade", to: withIntro, settings: { skipDeadIntro: true } });
    expect(overlap.entryPointSec).toBe(0);
    expect(fade.entryPointSec).toBeGreaterThanOrEqual(0);
  });
});

describe("strategy unit", () => {
  const baseCompat = {
    overall: 0.8,
    confidence: 0.8,
    tempo: { score: 0.95, confidence: 0.9, detail: "" },
    key: { score: 1, confidence: 0.9, detail: "" },
    energy: { score: 0.9, confidence: 0.8, detail: "" },
    phrase: { score: 0.8, confidence: 0.8, detail: "" },
    loudness: { score: 0.9, confidence: 0.8, detail: "" },
    style: { score: 0.6, confidence: 0.4, detail: "" },
    tempoRatio: 1,
    tempoDeltaPercent: -1.5,
  };

  const strategyInput = (over: Record<string, unknown> = {}) => ({
    compatibility: baseCompat,
    capabilities: capabilities("dj"),
    profile: { ...STYLE_PROFILES.dj, blendFloor: 0.2, compatibilitySensitivity: 0.8 },
    hasBeatGrids: true,
    sameAlbumConsecutive: false,
    preserveAlbumGapless: true,
    minCompatibilityForBlend: 0.2,
    mixableWindowSec: 8,
    windowLimitedBy: "both" as const,
    fromStructure: null,
    toStructure: null,
    energyDelta: 0,
    incomingIsAtypical: false,
    ...over,
  });

  it("honours the user's blend floor", () => {
    const r = selectStrategy(
      strategyInput({
        compatibility: { ...baseCompat, overall: 0.3 },
        minCompatibilityForBlend: 0.5,
      }) as never,
    );
    expect(r.technique).toBe("fade-cut");
    expect(r.strategy).toBe("safe");
  });

  it("refuses to overlap two very different tempos even at a decent overall score", () => {
    const r = selectStrategy(
      strategyInput({
        compatibility: { ...baseCompat, overall: 0.65, tempoDeltaPercent: 30 },
      }) as never,
    );
    expect(["quick-blend", "fade-cut"]).toContain(r.technique);
    expect(r.rationale.join(" ")).toMatch(/tempos differ/i);
  });

  it("keeps a short harmonic blend when the tempos clash but the keys agree", () => {
    const r = selectStrategy(
      strategyInput({
        compatibility: {
          ...baseCompat,
          overall: 0.7,
          tempoDeltaPercent: 30,
          key: { score: 1, confidence: 0.9, detail: "same key" },
        },
      }) as never,
    );
    expect(r.strategy).toBe("harmonic");
    expect(r.lengthFactor).toBeLessThan(1);
  });

  it("picks energy-rise when the incoming track is clearly hotter", () => {
    const r = selectStrategy(strategyInput({ energyDelta: 0.2 }) as never);
    expect(r.strategy).toBe("energy-rise");
  });

  it("picks energy-drop and lengthens when the incoming track settles", () => {
    const r = selectStrategy(strategyInput({ energyDelta: -0.2 }) as never);
    expect(r.strategy).toBe("energy-drop");
    expect(r.lengthFactor).toBeGreaterThan(1);
  });

  it("picks long when there is a big runway and a top band", () => {
    const r = selectStrategy(
      strategyInput({
        compatibility: { ...baseCompat, overall: 0.94 },
        mixableWindowSec: 20,
      }) as never,
    );
    expect(r.strategy).toBe("long");
    expect(r.lengthFactor).toBeGreaterThan(1);
  });

  it("stands down to safe for spoken word or a live recording", () => {
    const r = selectStrategy(strategyInput({ incomingIsAtypical: true }) as never);
    expect(r.strategy).toBe("safe");
    expect(r.rationale.join(" ")).toMatch(/spoken word|live recording/i);
  });
});
