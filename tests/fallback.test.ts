import { describe, expect, it, vi } from "vitest";
import { PassiveExecutor } from "../src/audio/executors/passiveExecutor.js";
import { calculateTransition } from "../src/engine/transitionEngine.js";
import { analysis, capabilities, settings, track, execContext } from "./helpers.js";
import type {
  ExecutionContext,
  ExecutionOutcome,
  TransitionExecutor,
} from "../src/audio/executors/types.js";
import type { TransitionPlan } from "../src/core/types.js";

/**
 * The audio engine's ladder logic, exercised against stub executors so the test
 * does not need a Spotify client. This mirrors `AudioEngine.execute`'s contract:
 * start at the requested rung, walk down on failure, never throw.
 */
async function runLadder(
  ladder: TransitionExecutor[],
  plan: TransitionPlan,
): Promise<{ outcome: ExecutionOutcome; ranBy: string }> {
  const ctx: ExecutionContext = execContext();
  const startIndex = Math.max(0, ladder.findIndex((e) => e.id === plan.executor));
  let last: ExecutionOutcome = { status: "failed", note: "nothing accepted the plan" };
  for (let i = startIndex; i < ladder.length; i++) {
    const ex = ladder[i]!;
    if (!ex.canRun(plan)) continue;
    last = await ex.run(plan, ctx);
    if (last.status !== "failed") return { outcome: last, ranBy: ex.id };
  }
  return { outcome: last, ranBy: "none" };
}

const stub = (
  id: string,
  behaviour: "ok" | "fail" | "decline",
): TransitionExecutor & { calls: number } => {
  const impl = {
    id,
    calls: 0,
    canRun: () => behaviour !== "decline",
    run: async (): Promise<ExecutionOutcome> => {
      impl.calls++;
      return behaviour === "ok"
        ? { status: "completed", note: `${id} ran` }
        : { status: "failed", note: `${id} failed` };
    },
  };
  return impl;
};

function planFor(tier: "dj" | "fade" | "passive"): TransitionPlan {
  return calculateTransition({
    fromTrack: track({ uri: "spotify:track:a", albumUri: "spotify:album:1" }),
    toTrack: track({ uri: "spotify:track:b", artists: ["Other"], albumUri: "spotify:album:2" }),
    fromAnalysis: analysis({ uri: "spotify:track:a" }),
    toAnalysis: analysis({ uri: "spotify:track:b" }),
    settings: settings(),
    capabilities: capabilities(tier),
  });
}

describe("fallback ladder", () => {
  it("uses the top rung when it works", async () => {
    const top = stub("native-crossfade", "ok");
    const mid = stub("volume-fade", "ok");
    const { ranBy } = await runLadder([top, mid, new PassiveExecutor()], planFor("dj"));
    expect(ranBy).toBe("native-crossfade");
    expect(mid.calls).toBe(0);
  });

  it("degrades to the fade path when the overlap fails", async () => {
    const top = stub("native-crossfade", "fail");
    const mid = stub("volume-fade", "ok");
    const { ranBy, outcome } = await runLadder([top, mid, new PassiveExecutor()], planFor("dj"));
    expect(ranBy).toBe("volume-fade");
    expect(outcome.status).toBe("completed");
  });

  it("degrades all the way to passive rather than failing", async () => {
    const top = stub("native-crossfade", "fail");
    const mid = stub("volume-fade", "fail");
    const { ranBy, outcome } = await runLadder([top, mid, new PassiveExecutor()], planFor("dj"));
    expect(ranBy).toBe("passive");
    expect(outcome.status).toBe("skipped");
  });

  it("skips a rung that declines the plan", async () => {
    const top = stub("native-crossfade", "decline");
    const mid = stub("volume-fade", "ok");
    const { ranBy } = await runLadder([top, mid, new PassiveExecutor()], planFor("dj"));
    expect(ranBy).toBe("volume-fade");
    expect(top.calls).toBe(0);
  });

  it("starts at the rung the plan asked for, never above it", async () => {
    const top = stub("native-crossfade", "ok");
    const mid = stub("volume-fade", "ok");
    const { ranBy } = await runLadder([top, mid, new PassiveExecutor()], planFor("fade"));
    expect(ranBy).toBe("volume-fade");
    expect(top.calls).toBe(0);
  });

  it("passive is always runnable — the ladder can never run out", async () => {
    const passive = new PassiveExecutor();
    expect(passive.canRun()).toBe(true);
    const outcome = await passive.run(planFor("passive"), execContext());
    expect(outcome.status).toBe("skipped");
  });

  it("labels an album segue distinctly from a client with no capabilities", async () => {
    const passive = new PassiveExecutor();
    const ctx = execContext();
    const segue = { ...planFor("dj"), technique: "gapless-passthrough" as const };
    const dead = { ...planFor("passive"), technique: "hard-cut" as const };
    expect((await passive.run(segue, ctx)).note).toMatch(/album segue/i);
    expect((await passive.run(dead, ctx)).note).toMatch(/no playback control/i);
  });
});

describe("plans degrade rather than disappear", () => {
  it("still produces a usable plan at every capability tier", () => {
    for (const tier of ["dj", "fade", "passive"] as const) {
      const p = planFor(tier);
      expect(p.from).toBeTruthy();
      expect(Number.isFinite(p.startPointSec)).toBe(true);
      expect(Number.isFinite(p.durationSec)).toBe(true);
      expect(p.compatibility.overall).toBeGreaterThanOrEqual(0);
    }
  });

  it("names the limitation whenever it downgrades", () => {
    expect(planFor("fade").caveats.join(" ")).toMatch(/no real audio overlap/i);
    expect(planFor("passive").caveats.join(" ")).toMatch(/cannot affect playback|no real audio overlap/i);
  });

  it("never silently claims a capability it does not have", () => {
    for (const tier of ["dj", "fade", "passive"] as const) {
      const p = planFor(tier);
      // Beatmatching is impossible on every tier and must never be marked applied.
      expect(p.bpmAdjustmentApplied).toBe(false);
      // EQ is never truly applied, so it must always be flagged as approximated.
      if (p.shaping.enabled) expect(p.shaping.approximated).toBe(true);
      // Per-track gain is not available on any current client.
      expect(p.gain.perTrackSupported).toBe(false);
    }
  });
});
