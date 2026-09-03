/**
 * Tier B — no overlap available, so shape the switch instead.
 *
 * When the client will not let us drive its crossfade mixer (most commonly on a
 * Free account on a recent build, where crossfade is gated behind Premium),
 * there is no way to get two tracks sounding at once. What is left is making
 * the *switch* musical, and doing it without ever losing the user's level.
 *
 *   1. Fade down, starting early enough that the switch itself lands on the
 *      phrase boundary the engine chose.
 *   2. Call `next()` — after telling the controller to expect the resulting
 *      `songchange`, so it does not mistake our own switch for a user skip.
 *   3. Wait for the client to actually report the new track.
 *   4. Optionally seek past a dead intro — something the overlap path cannot do.
 *   5. Fade back up to the user's level, matched for loudness.
 *
 * Every step emits an event, so a transition that stops halfway says where.
 */

import { createLogger } from "../../core/logger.js";
import { clamp01, dbToGain } from "../../core/util.js";
import { next as playerNext, seekMs, getProgressMs } from "../../platform/spicetify.js";
import type { TransitionPlan } from "../../core/types.js";
import type { ExecutionContext, ExecutionOutcome, TransitionExecutor } from "./types.js";

const log = createLogger("exec:fade");

/** How long to wait for the client to report the new track before giving up. */
const SWITCH_TIMEOUT_MS = 2500;
export class VolumeFadeExecutor implements TransitionExecutor {
  readonly id = "volume-fade";

  canRun(plan: TransitionPlan): boolean {
    return plan.executor === "volume-fade";
  }

  async run(plan: TransitionPlan, ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const { volume, session, record } = ctx;
    // Reading the position is for the log only. A client that throws here must
    // not take the transition down with it — and worse, must not abort the
    // fallback ladder before the passive rung gets a chance to stand down
    // cleanly.
    const posSec = (): number | null => {
      try {
        return getProgressMs() / 1000;
      } catch {
        return null;
      }
    };

    if (ctx.signal.aborted) {
      record.add("TRANSITION_CANCELLED", "aborted before start");
      return { status: "aborted", note: "aborted before start" };
    }

    const baseline = volume.getBaseline();
    if (baseline === null) {
      record.add("TRANSITION_FAILED", "no volume baseline was captured");
      return { status: "failed", note: "no volume baseline" };
    }

    // The fade path has its own geometry, and it is deliberately short. The
    // overlap duration would be five seconds down and three back — eight
    // seconds of music spent hiding a switch gap of a tenth of a second, which
    // is what made this sound like automation rather than a mix.
    const outMs = Math.max(250, plan.fade.outSec * 1000);
    const inMs = Math.max(250, plan.fade.inSec * 1000);
    const outShare = outMs / (outMs + inMs);
    // Dip part-way, never to silence: a hole in the music is more audible than
    // the gap it was meant to mask.
    const dipTo = baseline * plan.fade.floor;

    // The plan wanted the low end out of the way first. We cannot filter, but
    // front-loading the ramp clears the outgoing track sooner, which is the
    // audible half of the same gesture.
    const outCurve = plan.shaping.shaping === "front-loaded-fade" ? "exponential" : plan.curve;

    // ── 1. Fade out ────────────────────────────────────────────────────────
    record.add(
      "FADE_OUT_STARTED",
      `${(outMs / 1000).toFixed(2)}s dip to ${Math.round(plan.fade.floor * 100)}%, ${outCurve}` +
        (plan.fade.outBeats ? ` (${plan.fade.outBeats} beats)` : ""),
      { positionSec: posSec(), volume: baseline },
    );

    const outResult = await volume.ramp({
      session,
      to: dipTo,
      durationMs: outMs,
      curve: outCurve,
      phase: "fading-out",
      onTick: (p) => ctx.onProgress(p * outShare),
    });

    if (outResult === "user-override") {
      record.add("TRANSITION_CANCELLED", "you moved the volume");
      return { status: "aborted", note: "you moved the volume — left it alone" };
    }
    if (outResult === "superseded" || ctx.signal.aborted) {
      record.add("TRANSITION_CANCELLED", "superseded during fade-out");
      return { status: "aborted", note: "superseded during fade-out" };
    }
    if (outResult === "failed") {
      record.add("TRANSITION_FAILED", "the client rejected a volume write");
      return { status: "failed", note: "volume control was rejected mid-fade" };
    }
    record.add("FADE_OUT_COMPLETED", "", { positionSec: posSec(), volume: dipTo });

    // ── 2. Switch ──────────────────────────────────────────────────────────
    volume.awaitSwitch(session);
    // Tell the controller before the call, not after: the songchange can arrive
    // synchronously on some clients.
    ctx.expectTrackChange();
    if (!playerNext()) {
      record.add("TRANSITION_FAILED", "Player.next() was rejected");
      return { status: "failed", note: "Player.next() was rejected" };
    }
    record.add("NEXT_TRIGGERED", "", { positionSec: posSec() });

    const switchedMs = await ctx.awaitTrackChange(SWITCH_TIMEOUT_MS);
    if (switchedMs === null) {
      record.add("TRACK_CHANGED", "not observed within the timeout — continuing anyway");
      log.debug("track change not observed within the timeout");
    } else {
      record.add("TRACK_CHANGED", `after ${switchedMs} ms`, { positionSec: posSec() });
    }

    if (ctx.signal.aborted) {
      record.add("TRANSITION_CANCELLED", "aborted during the switch");
      return { status: "aborted", note: "aborted during the switch" };
    }

    // ── 3. Land on a downbeat ──────────────────────────────────────────────
    if (plan.entryPointSec > 0.5) {
      if (seekMs(plan.entryPointSec * 1000)) {
        record.add("SEEK" as never, `${plan.entryPointSec.toFixed(1)}s into the incoming track`);
      }
    }

    // ── 4. Fade in ─────────────────────────────────────────────────────────
    // A positive trim would push past the user's setting, so we only attenuate.
    const trimGain = clamp01(dbToGain(Math.min(0, plan.gain.trackB)));
    const target = baseline * (plan.gain.perTrackSupported ? 1 : trimGain);

    record.add("FADE_IN_STARTED", `${(inMs / 1000).toFixed(1)}s → ${Math.round(target * 100)}%`, {
      positionSec: posSec(),
    });

    const inResult = await volume.ramp({
      session,
      to: target,
      durationMs: inMs,
      curve: plan.curve,
      phase: "fading-in",
      onTick: (p) => ctx.onProgress(outShare + p * (1 - outShare)),
    });

    if (inResult === "user-override") {
      record.add("TRANSITION_COMPLETED", "faded in; you took over the volume");
      return { status: "completed", note: "faded in; you took over the volume" };
    }
    if (inResult === "superseded") {
      record.add("TRANSITION_CANCELLED", "superseded during fade-in");
      return { status: "aborted", note: "superseded during fade-in" };
    }
    if (inResult === "failed") {
      record.add("TRANSITION_FAILED", "the client rejected a volume write during fade-in");
      return { status: "failed", note: "volume control was rejected during fade-in" };
    }
    record.add("FADE_IN_COMPLETED", "", { positionSec: posSec(), volume: target });

    // Settle exactly on the user's level so no drift accumulates.
    if (Math.abs(target - baseline) > 0.001) {
      await volume.ramp({
        session,
        to: baseline,
        durationMs: 900,
        curve: "linear",
        phase: "fading-in",
      });
    }

    log.info(
      `faded through the switch over ${plan.durationSec.toFixed(1)}s ` +
        `(${plan.strategy}, ${plan.band} ${(plan.compatibility.overall * 100).toFixed(0)}%)`,
    );
    record.add("TRANSITION_COMPLETED", `${plan.durationSec.toFixed(1)}s fade`, {
      positionSec: posSec(),
      volume: baseline,
    });
    return {
      status: "completed",
      note: `${plan.durationSec.toFixed(1)}s fade (no overlap available)`,
    };
  }
}
