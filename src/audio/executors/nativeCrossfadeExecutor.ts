/**
 * Tier A — real audio overlap.
 *
 * How this works, and why it is the only way to get true overlap out of a
 * Spicetify extension:
 *
 * Spotify's audio never reaches the web layer. It is fetched, decrypted,
 * decoded and mixed below the renderer, so there is no `<audio>` element to
 * hang a Web Audio graph off and no DSP hook of any kind. What the client
 * *does* have is its own crossfade mixer, the one behind Settings → Playback →
 * Crossfade, which produces a genuine overlap whenever a track change happens.
 *
 * So we drive that mixer. Immediately before the switch we program it with the
 * length this specific pair of tracks calls for, then we trigger the track
 * change at the musically-chosen instant. The result is real audio overlap,
 * mixed by Spotify, at a duration and a moment the transition engine decided.
 *
 * The honest limits: the mixer's curve is Spotify's, not ours; we get no
 * per-band or per-deck control during the overlap; and we cannot seek into the
 * incoming track while it is fading in, so intro skipping is unavailable on
 * this path.
 */

import { createLogger } from "../../core/logger.js";
import { next as playerNext } from "../../platform/spicetify.js";
import { setNativeCrossfade, getCrossfadeState } from "../../platform/nativeCrossfade.js";
import type { TransitionPlan } from "../../core/types.js";
import type { ExecutionContext, ExecutionOutcome, TransitionExecutor } from "./types.js";

const log = createLogger("exec:native");

/** How long to wait for the client to report the new track. */
const SWITCH_TIMEOUT_MS = 2500;

export class NativeCrossfadeExecutor implements TransitionExecutor {
  readonly id = "native-crossfade";

  canRun(plan: TransitionPlan): boolean {
    return plan.executor === "native-crossfade" && getCrossfadeState().writable;
  }

  async run(plan: TransitionPlan, ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const { record } = ctx;
    if (ctx.signal.aborted) {
      record.add("TRANSITION_CANCELLED", "aborted before start");
      return { status: "aborted", note: "aborted before start" };
    }

    const programmed = await setNativeCrossfade(true, plan.durationSec);
    if (!programmed) {
      record.add("TRANSITION_FAILED", "the client refused every crossfade write path");
      return { status: "failed", note: "the client refused every crossfade write path" };
    }
    record.add("FADE_OUT_STARTED", `native crossfade programmed to ${plan.durationSec.toFixed(1)}s`);

    if (ctx.signal.aborted) {
      record.add("TRANSITION_CANCELLED", "aborted while programming");
      return { status: "aborted", note: "aborted while programming" };
    }

    // The controller must know this songchange is ours before it can arrive.
    ctx.expectTrackChange();
    if (!playerNext()) {
      record.add("TRANSITION_FAILED", "Player.next() was rejected");
      return { status: "failed", note: "Player.next() was rejected" };
    }
    record.add("NEXT_TRIGGERED", "Spotify's mixer now owns both streams");

    const switchedMs = await ctx.awaitTrackChange(SWITCH_TIMEOUT_MS);
    record.add(
      "TRACK_CHANGED",
      switchedMs === null ? "not observed within the timeout" : `after ${switchedMs} ms`,
    );

    log.info(
      `switched with a ${plan.durationSec.toFixed(1)}s native overlap ` +
        `(${plan.strategy}, ${plan.band} ${(plan.compatibility.overall * 100).toFixed(0)}%)`,
    );

    // Report progress for the length of the overlap so the UI can show it. The
    // mixer is doing the work; we are only narrating it.
    await reportProgress(plan.durationSec * 1000, ctx);

    record.add("TRANSITION_COMPLETED", `${plan.durationSec.toFixed(1)}s native crossfade`);
    return { status: "completed", note: `${plan.durationSec.toFixed(1)}s native crossfade` };
  }
}

async function reportProgress(durationMs: number, ctx: ExecutionContext): Promise<void> {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      const p = Math.min(1, (Date.now() - started) / durationMs);
      // Decide whether this is the last tick before calling out, so a throwing
      // listener cannot strand the interval and leave this promise unresolved.
      const done = p >= 1 || ctx.signal.aborted;
      if (done) {
        clearInterval(tick);
        resolve();
      }
      try {
        ctx.onProgress(p);
      } catch {
        /* a listener's problem, not the transition's */
      }
    }, 50);
  });
}
