/**
 * Tier C — do nothing, deliberately.
 *
 * Used for album segues the artist sequenced themselves, and as the final rung
 * of the fallback ladder when the client exposes neither a crossfade setting
 * nor volume control. Spotify's own behaviour is left completely untouched,
 * which is always a safe outcome.
 */

import type { TransitionPlan } from "../../core/types.js";
import type { ExecutionContext, ExecutionOutcome, TransitionExecutor } from "./types.js";

export class PassiveExecutor implements TransitionExecutor {
  readonly id = "passive";

  canRun(): boolean {
    return true;
  }

  async run(plan: TransitionPlan, ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const note =
      plan.technique === "gapless-passthrough"
        ? "album segue left intact"
        : "no playback control available — standing down";
    // A passive transition is a real outcome, not an absence of one: it is
    // recorded so the log shows a deliberate decision rather than a gap.
    ctx.record.add("TRANSITION_COMPLETED", note);
    return { status: "skipped", note };
  }
}
