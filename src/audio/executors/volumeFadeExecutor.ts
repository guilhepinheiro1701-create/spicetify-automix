/**
 * Tier B — no overlap available, so shape the switch instead.
 *
 * When the client will not let us drive its crossfade mixer (most commonly on
 * a Free account on a recent build, where crossfade is gated behind Premium),
 * there is no way to get two tracks sounding at once. Pretending otherwise
 * would be dishonest, so this executor does the next best thing, which is what
 * a DJ does when they cannot beatmatch either: it makes the *switch* musical.
 *
 *   1. Fade the outgoing track down, starting early enough that the switch
 *      itself lands on the phrase boundary the engine chose. The split between
 *      fading out and fading in follows the outgoing track's structure — a real
 *      outro is expendable, a track that stops dead is not.
 *   2. Switch, and wait for the client to *actually* change track rather than
 *      guessing at a fixed delay. This is what closes the audible gap.
 *   3. Land the incoming track on a downbeat, seeking past a dead intro when
 *      the plan asked for one — something the overlap path cannot do.
 *   4. Fade back up at the loudness-matched level, so the new track does not
 *      arrive louder than the old one left.
 *
 * There is no overlap. But it starts and ends on the music's own structure and
 * it never jumps in level, and the UI calls it a fade rather than a mix.
 */

import { createLogger } from "../../core/logger.js";
import { clamp01, dbToGain } from "../../core/util.js";
import {
  next as playerNext,
  seekMs,
  getVolume,
  setVolume,
  getCurrentTrack,
} from "../../platform/spicetify.js";
import { VolumeAutomation } from "../automation.js";
import type { TransitionPlan } from "../../core/types.js";
import type { ExecutionContext, ExecutionOutcome, TransitionExecutor } from "./types.js";

const log = createLogger("exec:fade");

/** Give up waiting for the track change and fade up anyway. */
const SWITCH_TIMEOUT_MS = 1200;
/** How often to check whether the client has actually changed track. */
const SWITCH_POLL_MS = 20;
/** Never fade the outgoing track to true silence — a hair of level avoids a click. */
const OUT_FLOOR = 0.02;

export class VolumeFadeExecutor implements TransitionExecutor {
  readonly id = "volume-fade";
  private readonly automation: VolumeAutomation;

  constructor(automation?: VolumeAutomation) {
    this.automation = automation ?? new VolumeAutomation({ get: getVolume, set: setVolume });
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
      // The engine already sized the lead-in from the same split, so the fade
      // out has to match it exactly or the switch drifts off the phrase.
      const outMs = Math.max(
        200,
        plan.leadInSec > 0 ? plan.leadInSec * 1000 : totalMs * 0.55,
      );
      const inMs = Math.max(200, totalMs - outMs);

      // The plan wanted the low end out of the way first. We cannot filter, but
      // front-loading the ramp clears the outgoing track sooner, which is the
      // audible half of the same gesture.
      const outCurve = plan.shaping.shaping === "front-loaded-fade" ? "exponential" : plan.curve;

      // ── 1. Fade out ──────────────────────────────────────────────────────
      const outcome = await this.automation.ramp({
        from: baseline,
        to: baseline * OUT_FLOOR,
        durationMs: outMs,
        curve: outCurve,
        direction: "out",
        onTick: (p) => ctx.onProgress(p * (outMs / (outMs + inMs))),
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

      // ── 2. Switch, and wait for it to actually happen ─────────────────────
      const before = getCurrentTrack()?.uri ?? null;
      if (!playerNext()) {
        this.automation.restore();
        return { status: "failed", note: "Player.next() was rejected" };
      }

      const switchedMs = await waitForTrackChange(before, ctx.signal);
      if (switchedMs === null) {
        log.debug("track change not observed within the timeout — fading up anyway");
      } else {
        log.debug(`client changed track after ${switchedMs} ms`);
      }
      if (ctx.signal.aborted) {
        this.automation.restore();
        return { status: "aborted", note: "aborted during the switch" };
      }

      // ── 3. Land on a downbeat ────────────────────────────────────────────
      // Only the fade path can do this: seeking mid-overlap is not possible.
      if (plan.entryPointSec > 0.5) {
        if (seekMs(plan.entryPointSec * 1000)) {
          log.debug(`seeked into track B at ${plan.entryPointSec.toFixed(1)}s`);
        }
      }

      // ── 4. Fade in, at the loudness-matched level ─────────────────────────
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
        onTick: (p) => ctx.onProgress(outMs / (outMs + inMs) + p * (inMs / (outMs + inMs))),
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
          `(${plan.strategy}, ${plan.band} ${(plan.compatibility.overall * 100).toFixed(0)}%)`,
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

/**
 * Wait until the client reports a different track.
 *
 * The old code slept for a fixed 220 ms, which is either a wasted gap or too
 * early depending on the machine. Polling the player's own state closes the
 * gap on a fast client without risking fading up into the tail of the old
 * track on a slow one. Returns the observed delay, or null on timeout.
 */
function waitForTrackChange(
  previousUri: string | null,
  signal: AbortSignal,
): Promise<number | null> {
  const started = Date.now();
  return new Promise((resolve) => {
    const finish = (value: number | null) => {
      clearInterval(timer);
      resolve(value);
    };
    const timer = setInterval(() => {
      // The timeout check has to come first and the read has to be guarded: if
      // the client's API throws, an unguarded read would escape the callback,
      // the timeout would never be reached, and this interval would run for the
      // rest of the session against a promise nobody ever resolves.
      if (signal.aborted || Date.now() - started >= SWITCH_TIMEOUT_MS) {
        return finish(null);
      }
      let now: string | null = null;
      try {
        now = getCurrentTrack()?.uri ?? null;
      } catch {
        return; // client is unhappy; wait it out and let the timeout decide
      }
      if (now !== null && now !== previousUri) finish(Date.now() - started);
    }, SWITCH_POLL_MS);
  });
}
