/**
 * Regressions.
 *
 * One test per bug that was actually found in the code, each named for the
 * wrong behaviour rather than for the fix, so a reintroduction is obvious from
 * the failure line alone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitize } from "../src/config/settings.js";
import { styleProfile } from "../src/config/styles.js";
import { intentProfile } from "../src/config/intent.js";
import * as platform from "../src/platform/spicetify.js";
import { AudioEngine } from "../src/audio/audioEngine.js";
import { VolumeController } from "../src/audio/volumeController.js";
import { VolumeFadeExecutor } from "../src/audio/executors/volumeFadeExecutor.js";
import { calculateTransition } from "../src/engine/transitionEngine.js";
import { analysis, capabilities, settings, track, execContext } from "./helpers.js";
import type { TransitionPlan } from "../src/core/types.js";

const setGlobal = (value: unknown) => {
  (globalThis as Record<string, unknown>).Spicetify = value;
};
afterEach(() => {
  delete (globalThis as Record<string, unknown>).Spicetify;
});

/** Run `work` while driving the clock, so a real-time fade does not cost seconds. */
async function withClock<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const promise = work();
    // Well past the longest fade the executor can ask for.
    await vi.advanceTimersByTimeAsync(20_000);
    return await promise;
  } finally {
    vi.useRealTimers();
  }
}

function fadePlan(over = {}): TransitionPlan {
  return calculateTransition({
    fromTrack: track({ uri: "spotify:track:a", albumUri: "spotify:album:1" }),
    toTrack: track({ uri: "spotify:track:b", artists: ["Other"], albumUri: "spotify:album:2" }),
    fromAnalysis: analysis({ uri: "spotify:track:a" }),
    toAnalysis: analysis({ uri: "spotify:track:b" }),
    settings: settings(over),
    capabilities: capabilities("fade"),
  });
}

describe("stored settings cannot name a prototype key", () => {
  // `"constructor" in INTENT_PROFILES` is true, so this passed validation and
  // the profile lookup returned a Function — not undefined, so the `??`
  // fallback missed it too. The plan came out with a zero-second blend and
  // Smart DJ did nothing at all, silently.
  it("falls back to the defaults instead of accepting them", () => {
    const s = sanitize({ intent: "constructor", style: "toString" });
    expect(s.intent).toBe("balanced");
    expect(s.style).not.toBe("toString");
  });

  it("the profile lookups never return a Function", () => {
    for (const key of ["constructor", "toString", "valueOf", "__proto__"]) {
      expect(typeof styleProfile(key as never)).toBe("object");
      expect(typeof intentProfile(key as never)).toBe("object");
      expect(typeof styleProfile(key as never).lengthBias).toBe("number");
      expect(typeof intentProfile(key as never).lengthBias).toBe("number");
    }
  });

  it("a corrupt style still produces a usable blend", () => {
    const plan = calculateTransition({
      fromTrack: track({ uri: "spotify:track:a", albumUri: "spotify:album:1" }),
      toTrack: track({ uri: "spotify:track:b", artists: ["Other"], albumUri: "spotify:album:2" }),
      fromAnalysis: analysis({ uri: "spotify:track:a" }),
      toAnalysis: analysis({ uri: "spotify:track:b" }),
      settings: sanitize({ style: "toString", intent: "constructor" }),
      capabilities: capabilities("dj"),
    });
    expect(Number.isFinite(plan.durationSec)).toBe(true);
    expect(plan.durationSec).toBeGreaterThan(0);
  });
});

describe("the platform layer does not report success for calls it never made", () => {
  // `sp()?.Player?.next?.()` evaluates to undefined when the method is absent,
  // which is indistinguishable from a void call that worked. The executor then
  // waited for a track change that was never coming.
  it("next() is false when Player.next does not exist", () => {
    setGlobal({ Player: {} });
    expect(platform.next()).toBe(false);
  });

  it("next() is true only when the method is really there", () => {
    const spy = vi.fn();
    setGlobal({ Player: { next: spy } });
    expect(platform.next()).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
  });

  it("seekMs() is false when Player.seek does not exist", () => {
    setGlobal({ Player: {} });
    expect(platform.seekMs(1000)).toBe(false);
  });

  it("queue mutation is false when the client exposes none", async () => {
    setGlobal({ Player: {} });
    expect(await platform.addToQueue("spotify:track:x")).toBe(false);
    expect(await platform.removeFromQueue("spotify:track:x")).toBe(false);
  });

  it("with no client at all, nothing claims to have worked", async () => {
    expect(platform.next()).toBe(false);
    expect(platform.seekMs(1)).toBe(false);
    expect(await platform.addToQueue("spotify:track:x")).toBe(false);
  });
});

/**
 * A volume IO that remembers what was written.
 *
 * A stub whose `get` ignores `set` looks to the controller exactly like a human
 * grabbing the slider, so every fade aborts as a user override.
 */
function statefulVolume(start = 0.8) {
  const state = { level: start };
  return {
    state,
    controller: new VolumeController({
      get: () => state.level,
      set: (v: number) => {
        state.level = v;
        return true;
      },
    }),
  };
}

describe("a failed switch withdraws the track-change expectation", () => {
  // Left set, the controller reads the *user's* next skip as our own and never
  // aborts the dead transition.
  it("cancels it when Player.next() is rejected", async () => {
    setGlobal({ Player: {} }); // next() will fail
    const expected = vi.fn();
    const cancelled = vi.fn();
    const { controller } = statefulVolume();
    const ctx = execContext({
      volume: controller,
      onExpect: expected,
      onCancelExpect: cancelled,
    });
    const plan = fadePlan();
    const outcome = await withClock(() => new VolumeFadeExecutor().run(plan, ctx));

    expect(outcome.status).toBe("failed");
    expect(expected).toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalled();
    controller.dispose();
  });
});

describe("no seek when the track change was never observed", () => {
  // Seeking then jumps the *outgoing* track, in the middle of the music the
  // listener is actually hearing.
  it("skips the entry seek on an unconfirmed switch", async () => {
    const seek = vi.fn();
    setGlobal({ Player: { next: () => undefined, seek } });
    const plan = fadePlan();
    expect(plan.entryPointSec).toBeGreaterThan(0.5); // the test is only meaningful then

    const { controller } = statefulVolume();
    const ctx = execContext({ volume: controller, trackChangeMs: null });
    await withClock(() => new VolumeFadeExecutor().run(plan, ctx));
    expect(seek).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("still seeks when the client confirms the new track", async () => {
    const seek = vi.fn();
    setGlobal({ Player: { next: () => undefined, seek } });
    const plan = fadePlan();

    const { controller } = statefulVolume();
    const ctx = execContext({ volume: controller, trackChangeMs: 90 });
    await withClock(() => new VolumeFadeExecutor().run(plan, ctx));
    expect(seek).toHaveBeenCalledWith(Math.round(plan.entryPointSec * 1000));
    controller.dispose();
  });
});

describe("an unknown executor stands down instead of escalating", () => {
  // findIndex returns -1 for an executor this build does not have, and
  // Math.max(0, -1) started the ladder at the *most* invasive rung.
  it("does not promote the plan to the overlap path", async () => {
    const plan = fadePlan();
    (plan as { executor: string }).executor = "something-this-build-lacks";
    const engine = new AudioEngine();
    const outcome = await withClock(() => engine.execute(plan));

    expect(outcome.status).toBe("failed");
    expect(outcome.note).toMatch(/no executor named/i);
    expect(engine.lastExecutorId).not.toBe("native-crossfade");
    engine.dispose();
  });
});

describe("a throwing progress listener cannot strand a ramp", () => {
  // The interval would keep firing against a promise that never resolves,
  // holding the volume wherever the fade had reached.
  it("still resolves, and still lands on the target", async () => {
    let level = 0.8;
    const volume = new VolumeController({
      get: () => level,
      set: (v) => {
        level = v;
        return true;
      },
    });
    const session = volume.begin();
    const result = await withClock(() =>
      volume.ramp({
        session,
        to: 0.3,
        durationMs: 120,
        curve: "linear",
        phase: "fading-out",
        onTick: () => {
          throw new Error("a listener blew up");
        },
      }),
    );

    expect(result).toBe("completed");
    expect(level).toBeCloseTo(0.3, 2);
    volume.dispose();
  });
});

describe("the memory counts playthroughs, not replans", () => {
  // remember() runs on every replan — songchange, settings change, queue edit —
  // so counting calls reported a pairing met once as recurring.
  it("repeated planning of one pair is a single sighting", async () => {
    const { TransitionMemory } = await import("../src/runtime/memory.js");
    const store = new Map<string, string>();
    const memory = new TransitionMemory({
      get: (k: string) => store.get(k) ?? null,
      set: (k: string, v: string) => void store.set(k, v),
    });

    const plan = fadePlan();
    (plan as { compatibility: { overall: number } }).compatibility.overall = 0.4;
    for (let i = 0; i < 4; i++) memory.remember(plan, "balanced");

    expect(memory.recall(plan.from.uri, plan.to!.uri, "balanced")?.timesSeen).toBe(1);
    expect(memory.recurringWeakPairs()).toHaveLength(0);
    memory.dispose();
  });

  it("a sighting in a later session still counts", async () => {
    const { TransitionMemory, MEMORY_STORAGE_KEY } = await import("../src/runtime/memory.js");
    const store = new Map<string, string>();
    const io = {
      get: (k: string) => store.get(k) ?? null,
      set: (k: string, v: string) => void store.set(k, v),
    };
    const plan = fadePlan();
    (plan as { compatibility: { overall: number } }).compatibility.overall = 0.4;

    const first = new TransitionMemory(io);
    first.remember(plan, "balanced");
    first.dispose();

    // Age the stored sighting well past the same-playthrough window.
    const raw = JSON.parse(store.get(MEMORY_STORAGE_KEY) ?? "{}");
    for (const e of raw.entries ?? []) e.at -= 60 * 60 * 1000;
    store.set(MEMORY_STORAGE_KEY, JSON.stringify(raw));

    const second = new TransitionMemory(io);
    second.remember(plan, "balanced");
    expect(second.recall(plan.from.uri, plan.to!.uri, "balanced")?.timesSeen).toBe(2);
    second.dispose();
  });
});
