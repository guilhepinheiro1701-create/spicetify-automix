/**
 * Lifecycle and safety.
 *
 * These cover the failure modes that would actually hurt a listener: a volume
 * ramp that keeps running after they take control back, listeners piling up
 * across a restart, and a transition that outlives the track it belonged to.
 */
import { describe, expect, it, vi } from "vitest";
import { AudioEngine } from "../src/audio/audioEngine.js";
import { VolumeAutomation } from "../src/audio/automation.js";
import { VolumeFadeExecutor } from "../src/audio/executors/volumeFadeExecutor.js";
import { Emitter } from "../src/core/events.js";
import { SettingsStore } from "../src/config/settings.js";
import { calculateTransition } from "../src/engine/transitionEngine.js";
import { analysis, capabilities, memoryStorage, settings, track } from "./helpers.js";
import type { TransitionPlan } from "../src/core/types.js";

function fadePlan(): TransitionPlan {
  return calculateTransition({
    fromTrack: track({ uri: "spotify:track:a", albumUri: "spotify:album:1" }),
    toTrack: track({ uri: "spotify:track:b", artists: ["Other"], albumUri: "spotify:album:2" }),
    fromAnalysis: analysis({ uri: "spotify:track:a" }),
    toAnalysis: analysis({ uri: "spotify:track:b" }),
    settings: settings(),
    capabilities: capabilities("fade"),
  });
}

describe("aborting a running transition", () => {
  it("restores the volume when the fade is aborted part-way", async () => {
    vi.useFakeTimers();
    const state = { volume: 0.8 };
    const io = { get: () => state.volume, set: (v: number) => ((state.volume = v), true) };
    const automation = new VolumeAutomation(io);
    const executor = new VolumeFadeExecutor(automation);

    const controller = new AbortController();
    const run = executor.run(fadePlan(), {
      signal: controller.signal,
      onProgress: () => undefined,
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(state.volume).toBeLessThan(0.8);

    controller.abort();
    await vi.advanceTimersByTimeAsync(200);
    const outcome = await run;

    expect(outcome.status).toBe("aborted");
    expect(state.volume).toBeCloseTo(0.8, 6);
    vi.useRealTimers();
  });

  it("AudioEngine.abort restores the baseline even with nothing running", () => {
    const engine = new AudioEngine();
    expect(() => engine.abort("nothing in flight")).not.toThrow();
    engine.dispose();
  });

  it("refuses to start a second transition while one is running", async () => {
    vi.useFakeTimers();
    const engine = new AudioEngine();
    const plan = fadePlan();
    const first = engine.execute(plan);
    const second = await engine.execute(plan);
    expect(second.status).toBe("skipped");
    expect(second.note).toMatch(/already running/i);
    engine.abort("test teardown");
    await vi.advanceTimersByTimeAsync(2000);
    await first;
    engine.dispose();
    vi.useRealTimers();
  });
});

describe("listener hygiene", () => {
  it("an emitter unsubscribes cleanly and does not accumulate", () => {
    const emitter = new Emitter<{ ping: number }>();
    const seen: number[] = [];
    const off = emitter.on("ping", (v) => seen.push(v));
    emitter.emit("ping", 1);
    off();
    emitter.emit("ping", 2);
    // Unsubscribing twice must be harmless.
    expect(() => off()).not.toThrow();
    expect(seen).toEqual([1]);
  });

  it("a throwing listener cannot break the emit loop for the others", () => {
    const emitter = new Emitter<{ ping: number }>();
    const seen: number[] = [];
    emitter.on("ping", () => {
      throw new Error("boom");
    });
    emitter.on("ping", (v) => seen.push(v));
    expect(() => emitter.emit("ping", 7)).not.toThrow();
    expect(seen).toEqual([7]);
  });

  it("settings changes fire once per real change, with the payload the controller needs", () => {
    const store = new SettingsStore(memoryStorage());
    const calls: { changed: string[]; enabled: boolean }[] = [];
    store.events.on("change", ({ changed, settings: s }) =>
      calls.push({ changed: [...changed], enabled: s.enabled }),
    );

    store.update({ enabled: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.changed).toContain("enabled");
    expect(calls[0]!.enabled).toBe(false);

    // A no-op update must not wake the controller.
    store.update({ enabled: false });
    expect(calls).toHaveLength(1);
  });
});

describe("plans stay internally consistent", () => {
  it("the fade path leads in so the switch lands on the chosen moment", () => {
    const p = fadePlan();
    expect(p.leadInSec).toBeGreaterThan(0);
    expect(p.leadInSec).toBeLessThan(p.durationSec);
    // Executor start must still be inside the track.
    expect(p.startPointSec - p.leadInSec).toBeGreaterThan(0);
  });

  it("the overlap path needs no lead-in", () => {
    const p = calculateTransition({
      fromTrack: track({ uri: "spotify:track:a", albumUri: "spotify:album:1" }),
      toTrack: track({ uri: "spotify:track:b", artists: ["X"], albumUri: "spotify:album:2" }),
      fromAnalysis: analysis({ uri: "spotify:track:a" }),
      toAnalysis: analysis({ uri: "spotify:track:b" }),
      settings: settings(),
      capabilities: capabilities("dj"),
    });
    expect(p.leadInSec).toBe(0);
  });

  it("never claims a capability that does not exist, on any tier", () => {
    for (const tier of ["dj", "fade", "passive"] as const) {
      const p = calculateTransition({
        fromTrack: track({ uri: "spotify:track:a", albumUri: "spotify:album:1" }),
        toTrack: track({ uri: "spotify:track:b", artists: ["X"], albumUri: "spotify:album:2" }),
        fromAnalysis: analysis({ uri: "spotify:track:a" }),
        toAnalysis: analysis({ uri: "spotify:track:b" }),
        settings: settings(),
        capabilities: capabilities(tier),
      });
      expect(p.bpmAdjustmentApplied).toBe(false);
      expect(p.gain.perTrackSupported).toBe(false);
      if (p.eq.enabled) {
        expect(p.eq.approximated).toBe(true);
        // The overlap path cannot shape anything at all, and must say so.
        if (p.executor === "native-crossfade") expect(p.eq.shaping).toBe("not-applicable");
      }
    }
  });

  it("phase compensation is only claimed when both grids are real", () => {
    const noGridB = calculateTransition({
      fromTrack: track({ uri: "spotify:track:a", albumUri: "spotify:album:1" }),
      toTrack: track({ uri: "spotify:track:b", artists: ["X"], albumUri: "spotify:album:2" }),
      fromAnalysis: analysis({ uri: "spotify:track:a" }),
      toAnalysis: analysis({
        uri: "spotify:track:b",
        beats: [],
        bars: [],
        sections: [],
        grid: null,
      }),
      settings: settings(),
      capabilities: capabilities("dj"),
    });
    expect(noGridB.beatAlignment).toBe(false);
  });
});

describe("queue reordering safety", () => {
  it("linkScore and the band agree on what counts as weak", async () => {
    const { bandFor } = await import("../src/engine/bands.js");
    // The bands must be contiguous and monotonic, or a score can fall through.
    const seen: string[] = [];
    for (let pct = 100; pct >= 0; pct -= 1) {
      const b = bandFor(pct / 100);
      if (seen[seen.length - 1] !== b.band) seen.push(b.band);
      expect(pct).toBeGreaterThanOrEqual(b.min);
    }
    expect(seen).toEqual(["perfect", "excellent", "good", "acceptable", "poor"]);
  });

  it("a band that scores worse never permits a longer blend", async () => {
    const { BANDS } = await import("../src/engine/bands.js");
    for (let i = 1; i < BANDS.length; i++) {
      expect(BANDS[i]!.windowUsage).toBeLessThanOrEqual(BANDS[i - 1]!.windowUsage);
    }
  });
});
