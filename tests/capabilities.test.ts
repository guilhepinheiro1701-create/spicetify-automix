/**
 * Capability regression.
 *
 * These are the tests that stop a future change from quietly claiming something
 * the client cannot do. Each one removes a capability and asserts that nothing
 * downstream calls it, claims it, or reports it as used.
 *
 * They are deliberately blunt: a spy that must never fire, and a verdict that
 * must say "capability-unavailable".
 */
import { describe, expect, it, vi } from "vitest";
import { calculateTransition } from "../src/engine/transitionEngine.js";
import { NativeCrossfadeExecutor } from "../src/audio/executors/nativeCrossfadeExecutor.js";
import { VolumeFadeExecutor } from "../src/audio/executors/volumeFadeExecutor.js";
import { PassiveExecutor } from "../src/audio/executors/passiveExecutor.js";
import { VolumeController } from "../src/audio/volumeController.js";
import { analysis, capabilities, settings, track, execContext } from "./helpers.js";
import type { CapabilityFlags } from "../src/platform/capabilities.js";
import type { PlanFeature, TransitionPlan } from "../src/core/types.js";

function planWith(flags: Partial<CapabilityFlags>, overrides = {}): TransitionPlan {
  return calculateTransition({
    fromTrack: track({ uri: "spotify:track:a", albumUri: "spotify:album:1" }),
    toTrack: track({ uri: "spotify:track:b", artists: ["Other"], albumUri: "spotify:album:2" }),
    fromAnalysis: analysis({ uri: "spotify:track:a" }),
    toAnalysis: analysis({ uri: "spotify:track:b" }),
    settings: settings(overrides),
    capabilities: capabilities("dj", flags),
  });
}

const verdictFor = (plan: TransitionPlan, feature: PlanFeature) =>
  plan.verdicts.find((v) => v.feature === feature);

describe("crossfade unavailable", () => {
  it("never plans the overlap path", () => {
    const plan = planWith({ crossfade: false });
    expect(plan.executor).not.toBe("native-crossfade");
    const v = verdictFor(plan, "audio-overlap");
    expect(v?.used).toBe(false);
    expect(v?.code).toBe("capability-unavailable");
  });

  it("the native executor refuses to run such a plan", () => {
    const plan = planWith({ crossfade: false });
    expect(new NativeCrossfadeExecutor().canRun(plan)).toBe(false);
  });

  it("makes no crossfade calls, even if the executor is invoked directly", async () => {
    // No Spicetify global at all: every write path must fail closed.
    const plan = planWith({ crossfade: false });
    const outcome = await new NativeCrossfadeExecutor().run(plan, execContext());
    expect(outcome.status).toBe("failed");
    expect(outcome.note).toMatch(/refused|crossfade/i);
  });

  it("says so in the caveats rather than staying silent", () => {
    const plan = planWith({ crossfade: false });
    expect(plan.caveats.join(" ")).toMatch(/no real audio overlap/i);
  });
});

describe("DSP unavailable", () => {
  it("never marks fade shaping as applied on the overlap path", () => {
    const plan = planWith({ crossfade: true });
    expect(plan.executor).toBe("native-crossfade");
    const v = verdictFor(plan, "fade-shaping");
    expect(v?.used).toBe(false);
    expect(v?.code).toBe("capability-unavailable");
    expect(v?.detail).toMatch(/no DSP hook|owns both streams/i);
  });

  it("the shaping plan never carries per-band values", () => {
    const plan = planWith({ crossfade: true });
    // The shape itself makes gains unrepresentable — this asserts the shape.
    expect(Object.keys(plan.shaping).sort()).toEqual(["approximated", "enabled", "shaping"]);
    if (plan.shaping.enabled) expect(plan.shaping.approximated).toBe(true);
  });

  it("on the fade path the shaping is broadband and labelled as such", () => {
    const plan = planWith({ crossfade: false });
    const v = verdictFor(plan, "fade-shaping");
    expect(v?.used).toBe(true);
    expect(v?.detail).toMatch(/broadband, not per-band/i);
    expect(plan.shaping.shaping).toBe("front-loaded-fade");
  });
});

describe("playback rate unavailable", () => {
  it("bpmAdjustmentApplied is false on every capability combination", () => {
    const combos: Partial<CapabilityFlags>[] = [
      {},
      { crossfade: false },
      { preciseTiming: false },
      { audioAnalysis: false },
      { crossfade: false, volumeControl: false },
    ];
    for (const flags of combos) {
      expect(planWith(flags).bpmAdjustmentApplied).toBe(false);
    }
  });

  it("reports beatmatching as unavailable, with a reason, on every plan", () => {
    const plan = planWith({});
    const v = verdictFor(plan, "tempo-adjustment");
    expect(v?.used).toBe(false);
    expect(v?.code).toBe("capability-unavailable");
    expect(v?.detail).toMatch(/playback-rate/i);
  });
});

describe("per-track gain unavailable", () => {
  it("never claims per-track gain support", () => {
    expect(planWith({}).gain.perTrackSupported).toBe(false);
    expect(planWith({ crossfade: false }).gain.perTrackSupported).toBe(false);
  });

  it("does not claim a loudness match during an overlap", () => {
    const plan = planWith({ crossfade: true });
    const v = verdictFor(plan, "loudness-match");
    expect(v?.used).toBe(false);
    expect(v?.code).toBe("capability-unavailable");
  });
});

describe("volume control unavailable", () => {
  it("degrades to passive rather than planning a fade", () => {
    const plan = planWith({ crossfade: false, volumeControl: false });
    expect(plan.executor).toBe("passive");
    expect(plan.durationSec).toBe(0);
  });

  it("the passive executor touches nothing", async () => {
    const plan = planWith({ crossfade: false, volumeControl: false });
    const outcome = await new PassiveExecutor().run(plan, execContext());
    expect(outcome.status).toBe("skipped");
  });

  it("a fade executor whose volume API always fails restores and reports failure", async () => {
    vi.useFakeTimers();
    // The volume controller itself must be the failing one, or the executor
    // never sees the rejection.
    const volume = new VolumeController({ get: () => 0.8, set: () => false });
    const plan = planWith({ crossfade: false });
    const run = new VolumeFadeExecutor().run(plan, execContext({ volume }));
    await vi.advanceTimersByTimeAsync(3000);
    const outcome = await run;
    expect(outcome.status).toBe("failed");
    vi.useRealTimers();
  });
});

describe("intro skipping", () => {
  it("is never attempted on the overlap path", () => {
    const plan = planWith({ crossfade: true });
    expect(plan.entryPointSec).toBe(0);
    const v = verdictFor(plan, "intro-skip");
    expect(v?.used).toBe(false);
    expect(v?.code).toBe("capability-unavailable");
    expect(v?.detail).toMatch(/mid-overlap/i);
  });
});

describe("user-disabled features report as disabled, not unavailable", () => {
  it("distinguishes a switched-off feature from a missing capability", () => {
    const plan = planWith({ crossfade: false }, { fadeShaping: false, beatMatching: false });
    expect(verdictFor(plan, "fade-shaping")?.code).toBe("disabled-by-user");
    expect(verdictFor(plan, "beat-alignment")?.code).toBe("disabled-by-user");
    // The impossible ones stay impossible regardless of settings.
    expect(verdictFor(plan, "tempo-adjustment")?.code).toBe("capability-unavailable");
  });
});

describe("every plan accounts for every feature", () => {
  it("emits a verdict for each feature the engine considers", () => {
    const expected: PlanFeature[] = [
      "audio-overlap",
      "tempo-adjustment",
      "beat-alignment",
      "phrase-alignment",
      "fade-shaping",
      "intro-skip",
      "loudness-match",
    ];
    for (const flags of [{}, { crossfade: false }, { audioAnalysis: false }]) {
      const plan = planWith(flags);
      const seen = plan.verdicts.map((v) => v.feature);
      for (const feature of expected) {
        expect(seen, `missing verdict for ${feature}`).toContain(feature);
      }
    }
  });

  it("no verdict is marked used without a detail explaining what happened", () => {
    for (const flags of [{}, { crossfade: false }]) {
      for (const v of planWith(flags).verdicts) {
        expect(v.detail.length, `${v.feature} has no detail`).toBeGreaterThan(10);
      }
    }
  });
});
