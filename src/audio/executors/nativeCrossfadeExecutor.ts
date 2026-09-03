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

/** Let the mixer settle after a settings write before triggering the switch. */
const SETTLE_MS = 60;

export class NativeCrossfadeExecutor implements TransitionExecutor {
  readonly id = "native-crossfade";

  canRun(plan: TransitionPlan): boolean {
    return plan.executor === "native-crossfade" && getCrossfadeState().writable;
  }

  async run(plan: TransitionPlan, ctx: ExecutionContext): Promise<ExecutionOutcome> {
    if (ctx.signal.aborted) return { status: "aborted", note: "aborted before start" };

    const programmed = await setNativeCrossfade(true, plan.durationSec);
    if (!programmed) {
      return {
        status: "failed",
        note: "the client refused every crossfade write path",
      };
    }

    if (ctx.signal.aborted) return { status: "aborted", note: "aborted while programming" };

    await sleep(SETTLE_MS, ctx.signal);
    if (ctx.signal.aborted) return { status: "aborted", note: "aborted before switch" };

    if (!playerNext()) {
      return { status: "failed", note: "Player.next() was rejected" };
    }

    log.info(
      `switched with a ${plan.durationSec.toFixed(1)}s native overlap ` +
        `(${plan.technique}, ${(plan.compatibility.overall * 100).toFixed(0)}% match)`,
    );

    // Report progress for the duration of the overlap so the UI can show it.
    await reportProgress(plan.durationSec * 1000, ctx);

    return {
      status: "completed",
      note: `${plan.durationSec.toFixed(1)}s native crossfade`,
    };
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

async function reportProgress(durationMs: number, ctx: ExecutionContext): Promise<void> {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      const p = Math.min(1, (Date.now() - started) / durationMs);
      ctx.onProgress(p);
      if (p >= 1 || ctx.signal.aborted) {
        clearInterval(tick);
        resolve();
      }
    }, 50);
  });
}
