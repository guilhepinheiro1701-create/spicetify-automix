/**
 * Tier B — no overlap available, so shape the switch instead.
 *
 * When the client will not let us drive its crossfade mixer (most commonly on
 * a Free account on a recent build, where crossfade is gated behind Premium),
 * there is no way to get two tracks sounding at once. Pretending otherwise
 * would be dishonest, so this executor does the next best thing, which is
 * what a DJ does when they cannot beatmatch either: it makes the *switch*
 * musical.
 *
 *  1. Fade the outgoing track down over the tail of the blend, starting from
 *     the phrase boundary the engine picked. Because the plan's EQ intent
 *     wanted the low end out first, the fade is weighted toward the front of
 *     the ramp rather than linear — broadband, but the same gesture.
 *  2. Switch at the chosen instant, silently.
 *  3. Optionally seek past a dead intro on the incoming track — something the
 *     native-overlap path cannot do.
 *  4. Fade back up to the user's level, with the loudness trim applied so the
 *     new track does not arrive louder than the old one left.
 *
 * The result has no overlap, but it starts and ends on the music's own
 * structure and it never jumps in level. That is a real transition, and the UI
 * labels it as a fade rather than a mix.
 */

import { createLogger } from "../../core/logger.js";
import { clamp01, dbToGain } from "../../core/util.js";
import { next as playerNext, seekMs, getVolume, setVolume } from "../../platform/spicetify.js";
import { VolumeAutomation } from "../automation.js";
import type { TransitionPlan } from "../../core/types.js";
import type { ExecutionContext, ExecutionOutcome, TransitionExecutor } from "./types.js";

const log = createLogger("exec:fade");

/** How much of the blend budget goes to the fade-out vs the fade-in. */
const OUT_SHARE = 0.55;
/** Time for the client to actually change track before we start fading up. */
const SWITCH_SETTLE_MS = 220;
/** Never fade the outgoing track to true silence — a hair of level avoids a click. */
const OUT_FLOOR = 0.02;

export class VolumeFadeExecutor implements TransitionExecutor {
  readonly id = "volume-fade";
  private readonly automation: VolumeAutomation;

  constructor(automation?: VolumeAutomation) {
    this.automation =
      automation ?? new VolumeAutomation({ get: getVolume, set: setVolume });
  }

  canRun(plan: TransitionPlan): boolean {
    return plan.executor === "volume-fade";
  }

  async run(plan: TransitionPlan, ctx: ExecutionContext): Promise<ExecutionOutcome> {
    if (ctx.signal.aborted) return { status: "aborted", note: "aborted before start" };

    const baseline = this.automation.captureBaseline();
    const onAbort = () => this.automation.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const totalMs = plan.durationSec * 1000;
      const outMs = Math.max(200, totalMs * OUT_SHARE);
      const inMs = Math.max(200, totalMs * (1 - OUT_SHARE));

      // The EQ plan asked for the low end to come out early. We cannot filter,
      // but we can front-load the fade so the outgoing track clears the space
      // sooner — the same musical intent, applied broadband.
      const curve = plan.eq.enabled ? "exponential" : plan.curve;

      // ── 1. Fade out ──────────────────────────────────────────────────────
      const outcome = await this.automation.ramp({
        from: baseline,
        to: baseline * OUT_FLOOR,
        durationMs: outMs,
        curve,
        direction: "out",
        onTick: (p) => ctx.onProgress(p * OUT_SHARE),
      });

      if (outcome === "user-override") {
        return { status: "aborted", note: "you moved the volume — left it alone" };
      }
      if (outcome === "failed") {
        this.automation.restore();
        return { status: "failed", note: "volume control was rejected mid-fade" };
      }
      if (ctx.signal.aborted) {
        this.automation.restore();
        return { status: "aborted", note: "aborted during fade-out" };
      }

      // ── 2. Switch ────────────────────────────────────────────────────────
      if (!playerNext()) {
        this.automation.restore();
        return { status: "failed", note: "Player.next() was rejected" };
      }
      await sleep(SWITCH_SETTLE_MS, ctx.signal);

      // ── 3. Skip a dead intro, if the plan asked for one ───────────────────
      if (plan.entryPointSec > 0.5 && !ctx.signal.aborted) {
        if (seekMs(plan.entryPointSec * 1000)) {
          log.debug(`seeked into track B at ${plan.entryPointSec.toFixed(1)}s`);
        }
      }

      // ── 4. Fade in, at the loudness-matched level ────────────────────────
      // A positive trim would push past the user's setting, so we only ever
      // attenuate: the incoming track can arrive quieter, never louder.
      const trimGain = clamp01(dbToGain(Math.min(0, plan.gain.trackB)));
      const target = baseline * (plan.gain.perTrackSupported ? 1 : trimGain);

      const inOutcome = await this.automation.ramp({
        from: baseline * OUT_FLOOR,
        to: target,
        durationMs: inMs,
        curve: plan.curve,
        direction: "in",
        onTick: (p) => ctx.onProgress(OUT_SHARE + p * (1 - OUT_SHARE)),
      });

      if (inOutcome === "user-override") {
        return { status: "completed", note: "faded in; you took over the volume" };
      }

      // Settle exactly on the user's baseline so no drift accumulates.
      if (target !== baseline) {
        await this.automation.ramp({
          from: target,
          to: baseline,
          durationMs: 900,
          curve: "linear",
          direction: "in",
        });
      }
      this.automation.releaseBaseline();
      setVolume(baseline);

      log.info(
        `faded through the switch over ${plan.durationSec.toFixed(1)}s ` +
          `(${(plan.compatibility.overall * 100).toFixed(0)}% match)`,
      );
      return {
        status: "completed",
        note: `${plan.durationSec.toFixed(1)}s fade (no overlap available)`,
      };
    } catch (err) {
      this.automation.abort();
      return { status: "failed", note: String((err as Error)?.message ?? err) };
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
      // Belt and braces: whatever happened above, the user's volume comes back.
      if (this.automation.isRunning) this.automation.abort();
      else this.automation.restore();
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
