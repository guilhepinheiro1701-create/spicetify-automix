/**
 * The volume state machine.
 *
 * These are the tests that matter most, because the reported failure was a
 * volume that went down and never came back. Each one asserts a rule that must
 * hold no matter what else happens:
 *
 *   - the level always ends where the user had it
 *   - a superseded session cannot move the volume
 *   - the user always wins
 *   - the baseline survives a client that refuses writes
 */
import { describe, expect, it, vi } from "vitest";
import { VolumeController } from "../src/audio/volumeController.js";
import { equalPower, fadeGain, dbToGain, gainToDb } from "../src/core/util.js";

function io(start = 0.73) {
  const state = { volume: start, writes: [] as number[], failing: false };
  return {
    state,
    io: {
      get: () => state.volume,
      set: (v: number) => {
        if (state.failing) return false;
        state.volume = v;
        state.writes.push(Number(v.toFixed(4)));
        return true;
      },
    },
  };
}

describe("fade curves", () => {
  it("equal-power keeps the summed power constant", () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const { out, in: inn } = equalPower(t);
      expect(out * out + inn * inn).toBeCloseTo(1, 10);
    }
  });

  it("every curve runs 0→1 monotonically for a fade in", () => {
    for (const curve of ["equal-power", "linear", "s-curve", "exponential"]) {
      let prev = -Infinity;
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const v = fadeGain(curve, t, "in");
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = v;
      }
      expect(fadeGain(curve, 0, "in")).toBeCloseTo(0, 6);
      expect(fadeGain(curve, 1, "in")).toBeCloseTo(1, 6);
    }
  });

  it("every curve runs 1→0 monotonically for a fade out", () => {
    for (const curve of ["equal-power", "linear", "s-curve", "exponential"]) {
      let prev = Infinity;
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const v = fadeGain(curve, t, "out");
        expect(v).toBeLessThanOrEqual(prev + 1e-9);
        prev = v;
      }
      expect(fadeGain(curve, 0, "out")).toBeCloseTo(1, 6);
      expect(fadeGain(curve, 1, "out")).toBeCloseTo(0, 6);
    }
  });

  it("converts dB and gain reversibly", () => {
    expect(dbToGain(0)).toBeCloseTo(1, 10);
    expect(gainToDb(dbToGain(-3))).toBeCloseTo(-3, 8);
    expect(gainToDb(0)).toBe(-Infinity);
  });
});

describe("the full journey down and back", () => {
  it("73 → down → track change → up → 73", async () => {
    vi.useFakeTimers();
    const { io: adapter, state } = io(0.73);
    const volume = new VolumeController(adapter);

    const session = volume.begin();
    expect(volume.getBaseline()).toBeCloseTo(0.73, 6);

    // Fade out.
    const out = volume.ramp({
      session,
      to: 0.73 * 0.02,
      durationMs: 600,
      curve: "exponential",
      phase: "fading-out",
    });
    await vi.advanceTimersByTimeAsync(700);
    expect(await out).toBe("completed");
    expect(state.volume).toBeLessThan(0.1);

    // The switch happens here.
    volume.awaitSwitch(session);
    expect(volume.getState()).toBe("awaiting-switch");

    // Fade in.
    const back = volume.ramp({
      session,
      to: 0.73,
      durationMs: 600,
      curve: "equal-power",
      phase: "fading-in",
    });
    await vi.advanceTimersByTimeAsync(700);
    expect(await back).toBe("completed");

    volume.end(session);
    expect(state.volume).toBeCloseTo(0.73, 6);
    expect(volume.getState()).toBe("normal");
    expect(volume.getBaseline()).toBeNull();
    vi.useRealTimers();
  });

  it("never overshoots the user's level on the way back", async () => {
    vi.useFakeTimers();
    const { io: adapter, state } = io(0.35);
    const volume = new VolumeController(adapter);
    const session = volume.begin();

    await (async () => {
      const p = volume.ramp({
        session,
        to: 0.35 * 0.02,
        durationMs: 400,
        curve: "linear",
        phase: "fading-out",
      });
      await vi.advanceTimersByTimeAsync(500);
      return p;
    })();
    const up = volume.ramp({
      session,
      to: 0.35,
      durationMs: 400,
      curve: "linear",
      phase: "fading-in",
    });
    await vi.advanceTimersByTimeAsync(500);
    await up;
    volume.end(session);

    expect(Math.max(...state.writes)).toBeLessThanOrEqual(0.35 + 1e-9);
    expect(state.volume).toBeCloseTo(0.35, 6);
    vi.useRealTimers();
  });
});

describe("cancellation always restores", () => {
  it("from fading-out", async () => {
    vi.useFakeTimers();
    const { io: adapter, state } = io(0.73);
    const volume = new VolumeController(adapter);
    const session = volume.begin();
    void volume.ramp({
      session,
      to: 0,
      durationMs: 2000,
      curve: "linear",
      phase: "fading-out",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(state.volume).toBeLessThan(0.73);

    volume.cancel("user skipped");
    expect(state.volume).toBeCloseTo(0.73, 6);
    expect(volume.getState()).toBe("normal");
    vi.useRealTimers();
  });

  it("from awaiting-switch", () => {
    const { io: adapter, state } = io(0.6);
    const volume = new VolumeController(adapter);
    const session = volume.begin();
    adapter.set(0.05);
    volume.awaitSwitch(session);

    volume.cancel("aborted between the fade and the switch");
    expect(state.volume).toBeCloseTo(0.6, 6);
  });

  it("from fading-in", async () => {
    vi.useFakeTimers();
    const { io: adapter, state } = io(0.9);
    const volume = new VolumeController(adapter);
    const session = volume.begin();
    adapter.set(0.02);
    void volume.ramp({
      session,
      to: 0.9,
      durationMs: 2000,
      curve: "linear",
      phase: "fading-in",
    });
    await vi.advanceTimersByTimeAsync(400);

    volume.cancel("aborted mid fade-in");
    expect(state.volume).toBeCloseTo(0.9, 6);
    vi.useRealTimers();
  });

  it("cancelling twice is harmless", () => {
    const { io: adapter, state } = io(0.5);
    const volume = new VolumeController(adapter);
    volume.begin();
    volume.cancel("once");
    volume.cancel("twice");
    expect(state.volume).toBeCloseTo(0.5, 6);
  });
});

describe("sessions", () => {
  it("a superseded session cannot move the volume", async () => {
    vi.useFakeTimers();
    const { io: adapter, state } = io(0.8);
    const volume = new VolumeController(adapter);

    const first = volume.begin();
    const stale = volume.ramp({
      session: first,
      to: 0,
      durationMs: 2000,
      curve: "linear",
      phase: "fading-out",
    });
    await vi.advanceTimersByTimeAsync(300);

    // A new transition takes over.
    const second = volume.begin();
    expect(await stale).toBe("superseded");

    const beforeStaleAttempt = state.volume;
    // The old session tries to keep going. It must be ignored entirely.
    expect(await volume.ramp({
      session: first,
      to: 0,
      durationMs: 500,
      curve: "linear",
      phase: "fading-out",
    })).toBe("superseded");
    await vi.advanceTimersByTimeAsync(600);
    expect(state.volume).toBe(beforeStaleAttempt);

    // And a late `end` from the old session must not undo the new one.
    volume.end(first);
    expect(volume.isOwnedBy(second)).toBe(true);

    volume.end(second);
    expect(state.volume).toBeCloseTo(0.8, 6);
    vi.useRealTimers();
  });

  it("a replacement session restores the user's level, not the mid-fade level", async () => {
    vi.useFakeTimers();
    const { io: adapter, state } = io(0.73);
    const volume = new VolumeController(adapter);

    const first = volume.begin();
    void volume.ramp({
      session: first,
      to: 0,
      durationMs: 2000,
      curve: "linear",
      phase: "fading-out",
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(state.volume).toBeLessThan(0.6);

    const second = volume.begin();
    // The baseline carried over from the first session.
    expect(volume.getBaseline()).toBeCloseTo(0.73, 6);
    volume.end(second);
    expect(state.volume).toBeCloseTo(0.73, 6);
    vi.useRealTimers();
  });

  it("session zero owns nothing", () => {
    const { io: adapter } = io();
    const volume = new VolumeController(adapter);
    expect(volume.isOwnedBy(0)).toBe(false);
  });
});

describe("the user always wins", () => {
  it("abandons the ramp and adopts their level", async () => {
    vi.useFakeTimers();
    const { io: adapter, state } = io(0.8);
    const volume = new VolumeController(adapter);
    const session = volume.begin();

    const ramp = volume.ramp({
      session,
      to: 0,
      durationMs: 2000,
      curve: "linear",
      phase: "fading-out",
    });
    await vi.advanceTimersByTimeAsync(300);

    // A human grabs the slider.
    state.volume = 0.31;
    await vi.advanceTimersByTimeAsync(100);

    expect(await ramp).toBe("user-override");
    expect(state.volume).toBe(0.31);

    // Even ending the session must not put the old level back.
    volume.end(session);
    expect(state.volume).toBeCloseTo(0.31, 6);
    vi.useRealTimers();
  });
});

describe("a client that refuses writes", () => {
  it("holds the level and restores once it recovers", async () => {
    vi.useFakeTimers();
    const { io: adapter, state } = io(0.8);
    const volume = new VolumeController(adapter);
    const session = volume.begin();

    void volume.ramp({
      session,
      to: 0.1,
      durationMs: 600,
      curve: "linear",
      phase: "fading-out",
    });
    await vi.advanceTimersByTimeAsync(700);
    expect(state.volume).toBeLessThan(0.8);

    state.failing = true;
    volume.cancel("client refusing");
    expect(state.volume).toBeLessThan(0.8); // could not be restored yet

    state.failing = false;
    await vi.advanceTimersByTimeAsync(400);
    expect(state.volume).toBeCloseTo(0.8, 6);
    vi.useRealTimers();
  });

  it("keeps the baseline when it gives up, so a later cancel still works", async () => {
    vi.useFakeTimers();
    const { io: adapter, state } = io(0.65);
    const volume = new VolumeController(adapter);
    const session = volume.begin();
    void volume.ramp({
      session,
      to: 0.1,
      durationMs: 400,
      curve: "linear",
      phase: "fading-out",
    });
    await vi.advanceTimersByTimeAsync(500);

    state.failing = true;
    volume.cancel("client down");
    // Long enough that every retry has been exhausted.
    await vi.advanceTimersByTimeAsync(10_000);

    state.failing = false;
    volume.cancel("client back");
    expect(state.volume).toBeCloseTo(0.65, 6);
    vi.useRealTimers();
  });
});

describe("dispose", () => {
  it("restores and is idempotent", async () => {
    vi.useFakeTimers();
    const { io: adapter, state } = io(0.44);
    const volume = new VolumeController(adapter);
    const session = volume.begin();
    void volume.ramp({
      session,
      to: 0,
      durationMs: 2000,
      curve: "linear",
      phase: "fading-out",
    });
    await vi.advanceTimersByTimeAsync(400);

    volume.dispose();
    volume.dispose();
    expect(state.volume).toBeCloseTo(0.44, 6);
    expect(volume.getState()).toBe("normal");
    vi.useRealTimers();
  });
});
