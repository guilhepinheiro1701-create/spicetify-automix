import { describe, expect, it, vi } from "vitest";
import { VolumeAutomation } from "../src/audio/automation.js";
import { equalPower, fadeGain, dbToGain, gainToDb } from "../src/core/util.js";

function fakeIo(start = 0.8) {
  const state = { volume: start, failFrom: Infinity, calls: 0 };
  return {
    state,
    io: {
      get: () => state.volume,
      set: (v: number) => {
        state.calls++;
        if (state.calls >= state.failFrom) return false;
        state.volume = v;
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
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
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
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        prev = v;
      }
      expect(fadeGain(curve, 0, "out")).toBeCloseTo(1, 6);
      expect(fadeGain(curve, 1, "out")).toBeCloseTo(0, 6);
    }
  });

  it("the exponential curve is pinned at both ends, not left at the dB floor", () => {
    // Regression: the endpoints used to leak the -60 dB floor value instead of
    // hitting exactly 0 and 1, so a fade never quite started or finished.
    expect(fadeGain("exponential", 0, "in")).toBe(0);
    expect(fadeGain("exponential", 1, "in")).toBeCloseTo(1, 10);
    expect(fadeGain("exponential", 0, "out")).toBeCloseTo(1, 10);
    expect(fadeGain("exponential", 1, "out")).toBe(0);
    // And it is front-loaded relative to linear, which is the whole point:
    // the outgoing track clears out of the way sooner.
    expect(fadeGain("exponential", 0.5, "out")).toBeLessThan(fadeGain("linear", 0.5, "out"));
  });

  it("clamps input outside 0..1", () => {
    expect(fadeGain("linear", -5, "in")).toBe(0);
    expect(fadeGain("linear", 5, "in")).toBe(1);
  });

  it("converts dB and gain reversibly", () => {
    expect(dbToGain(0)).toBeCloseTo(1, 10);
    expect(dbToGain(-6)).toBeCloseTo(0.5012, 3);
    expect(gainToDb(dbToGain(-3))).toBeCloseTo(-3, 8);
    expect(gainToDb(0)).toBe(-Infinity);
  });
});

describe("VolumeAutomation safety", () => {
  it("ramps to the target and reports completion", async () => {
    vi.useFakeTimers();
    const { io, state } = fakeIo(0.8);
    const auto = new VolumeAutomation(io);
    const done = auto.ramp({
      from: 0.8,
      to: 0.1,
      durationMs: 200,
      curve: "linear",
      direction: "out",
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(await done).toBe("completed");
    expect(state.volume).toBeCloseTo(0.1, 2);
    vi.useRealTimers();
  });

  it("restores the captured baseline on abort", async () => {
    vi.useFakeTimers();
    const { io, state } = fakeIo(0.7);
    const auto = new VolumeAutomation(io);
    void auto.ramp({ from: 0.7, to: 0, durationMs: 1000, curve: "linear", direction: "out" });
    await vi.advanceTimersByTimeAsync(300);
    expect(state.volume).toBeLessThan(0.7);

    auto.abort();
    expect(state.volume).toBeCloseTo(0.7, 6);
    vi.useRealTimers();
  });

  it("backs off and keeps the user's value when they move the slider", async () => {
    vi.useFakeTimers();
    const { io, state } = fakeIo(0.8);
    const auto = new VolumeAutomation(io);
    const done = auto.ramp({
      from: 0.8,
      to: 0.1,
      durationMs: 1000,
      curve: "linear",
      direction: "out",
    });
    await vi.advanceTimersByTimeAsync(200);

    // The human grabs the slider.
    state.volume = 0.35;
    await vi.advanceTimersByTimeAsync(100);

    expect(await done).toBe("user-override");
    // We must not have moved it back or continued the ramp.
    expect(state.volume).toBe(0.35);

    auto.restore();
    expect(state.volume).toBe(0.35);
    vi.useRealTimers();
  });

  it("restores when the volume API starts failing mid-ramp", async () => {
    vi.useFakeTimers();
    const { io, state } = fakeIo(0.9);
    const auto = new VolumeAutomation(io);
    const done = auto.ramp({
      from: 0.9,
      to: 0.1,
      durationMs: 1000,
      curve: "linear",
      direction: "out",
    });
    await vi.advanceTimersByTimeAsync(100);
    state.failFrom = state.calls + 1;
    await vi.advanceTimersByTimeAsync(100);

    expect(await done).toBe("failed");
    vi.useRealTimers();
  });

  it("handles a zero-length ramp without spinning a timer", async () => {
    const { io, state } = fakeIo(0.5);
    const auto = new VolumeAutomation(io);
    expect(await auto.ramp({ from: 0.5, to: 0.2, durationMs: 0, curve: "linear", direction: "out" })).toBe(
      "completed",
    );
    expect(state.volume).toBe(0.2);
    expect(auto.isRunning).toBe(false);
  });

  it("restore is a no-op with no baseline captured", () => {
    const { io, state } = fakeIo(0.6);
    const auto = new VolumeAutomation(io);
    auto.restore();
    expect(state.volume).toBe(0.6);
  });

  it("never lets a ramp push the volume outside 0..1", async () => {
    vi.useFakeTimers();
    const { io, state } = fakeIo(1);
    const auto = new VolumeAutomation(io);
    const done = auto.ramp({ from: 5, to: -3, durationMs: 200, curve: "linear", direction: "out" });
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(25);
      expect(state.volume).toBeGreaterThanOrEqual(0);
      expect(state.volume).toBeLessThanOrEqual(1);
    }
    await done;
    vi.useRealTimers();
  });

  it("replaces an in-flight ramp instead of running two at once", async () => {
    vi.useFakeTimers();
    const { io } = fakeIo(0.8);
    const auto = new VolumeAutomation(io);
    const first = auto.ramp({ from: 0.8, to: 0, durationMs: 1000, curve: "linear", direction: "out" });
    await vi.advanceTimersByTimeAsync(100);
    const second = auto.ramp({ from: 0.4, to: 0.8, durationMs: 200, curve: "linear", direction: "in" });
    expect(await first).toBe("cancelled");
    await vi.advanceTimersByTimeAsync(300);
    expect(await second).toBe("completed");
    vi.useRealTimers();
  });
});
