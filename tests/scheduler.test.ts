import { describe, expect, it, vi } from "vitest";
import { TransitionScheduler } from "../src/runtime/scheduler.js";

function clock(start = 0, playing = true) {
  const state = { position: start, playing };
  return {
    state,
    clock: {
      position: () => state.position,
      playing: () => state.playing,
    },
  };
}

describe("TransitionScheduler", () => {
  it("fires close to the target position", async () => {
    vi.useFakeTimers();
    const { state, clock: c } = clock(0);
    const scheduler = new TransitionScheduler(c);
    const fired = vi.fn();
    scheduler.arm(10_000, fired);

    // Advance playback and wall clock together.
    for (let t = 0; t < 11_000; t += 50) {
      state.position = t;
      await vi.advanceTimersByTimeAsync(50);
      if (fired.mock.calls.length > 0) break;
    }

    expect(fired).toHaveBeenCalledTimes(1);
    expect(state.position).toBeGreaterThan(9_800);
    expect(state.position).toBeLessThan(10_200);
    vi.useRealTimers();
  });

  it("only ever fires once", async () => {
    vi.useFakeTimers();
    const { state, clock: c } = clock(0);
    const scheduler = new TransitionScheduler(c);
    const fired = vi.fn();
    scheduler.arm(1000, fired);
    for (let t = 0; t < 5000; t += 50) {
      state.position = t;
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(fired).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not fire while paused", async () => {
    vi.useFakeTimers();
    const { state, clock: c } = clock(9_900, false);
    const scheduler = new TransitionScheduler(c);
    const fired = vi.fn();
    scheduler.arm(10_000, fired);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fired).not.toHaveBeenCalled();

    // Resume: now it should fire.
    state.playing = true;
    state.position = 10_050;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fired).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("can be cancelled", async () => {
    vi.useFakeTimers();
    const { state, clock: c } = clock(0);
    const scheduler = new TransitionScheduler(c);
    const fired = vi.fn();
    scheduler.arm(1000, fired);
    expect(scheduler.armed).toBe(true);
    scheduler.cancel();
    expect(scheduler.armed).toBe(false);
    state.position = 2000;
    await vi.advanceTimersByTimeAsync(3000);
    expect(fired).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("re-arming replaces the previous schedule", async () => {
    vi.useFakeTimers();
    const { state, clock: c } = clock(0);
    const scheduler = new TransitionScheduler(c);
    const first = vi.fn();
    const second = vi.fn();
    scheduler.arm(1000, first);
    scheduler.arm(2000, second);
    for (let t = 0; t < 3000; t += 50) {
      state.position = t;
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("reports an ETA that shrinks as playback advances", () => {
    const { state, clock: c } = clock(0);
    const scheduler = new TransitionScheduler(c);
    scheduler.arm(10_000, () => undefined);
    expect(scheduler.etaSec()).toBeCloseTo(10, 1);
    state.position = 7000;
    expect(scheduler.etaSec()).toBeCloseTo(3, 1);
    state.position = 20_000;
    expect(scheduler.etaSec()).toBe(0);
  });

  it("has no ETA when nothing is armed", () => {
    const { clock: c } = clock(0);
    expect(new TransitionScheduler(c).etaSec()).toBeNull();
  });

  it("survives a callback that throws", async () => {
    vi.useFakeTimers();
    const { state, clock: c } = clock(0);
    const scheduler = new TransitionScheduler(c);
    scheduler.arm(500, () => {
      throw new Error("boom");
    });
    state.position = 600;
    await expect(vi.advanceTimersByTimeAsync(1000)).resolves.not.toThrow();
    vi.useRealTimers();
  });
});
