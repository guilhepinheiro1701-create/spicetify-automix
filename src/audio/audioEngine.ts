/**
 * Audio Engine.
 *
 * Owns the fallback ladder and guarantees that a failure at any rung degrades
 * to the next one rather than breaking playback:
 *
 *     native crossfade  (real audio overlap)
 *            ↓ unavailable / refused
 *     volume fade       (musically-timed switch, no overlap)
 *            ↓ unavailable / refused
 *     passive           (Spotify's own behaviour, untouched)
 *
 * Exactly one transition can be in flight at a time, and it is always
 * abortable — a user skip, a pause, or the extension being switched off cancels
 * it and restores anything that was changed.
 */

import { createLogger } from "../core/logger.js";
import { Emitter } from "../core/events.js";
import { getVolume, setVolume } from "../platform/spicetify.js";
import { VolumeAutomation } from "./automation.js";
import { NativeCrossfadeExecutor } from "./executors/nativeCrossfadeExecutor.js";
import { VolumeFadeExecutor } from "./executors/volumeFadeExecutor.js";
import { PassiveExecutor } from "./executors/passiveExecutor.js";
import type { ExecutionOutcome, TransitionExecutor } from "./executors/types.js";
import type { TransitionPlan } from "../core/types.js";

const log = createLogger("audio");

export interface AudioEngineEvents extends Record<string, unknown> {
  start: { plan: TransitionPlan; executor: string };
  progress: { progress: number };
  finish: { plan: TransitionPlan; outcome: ExecutionOutcome; executor: string };
}

export class AudioEngine {
  readonly events = new Emitter<AudioEngineEvents>();

  private readonly automation: VolumeAutomation;
  private readonly ladder: TransitionExecutor[];
  private readonly passive = new PassiveExecutor();
  private controller: AbortController | null = null;
  private running = false;

  constructor() {
    this.automation = new VolumeAutomation({ get: getVolume, set: setVolume });
    this.ladder = [
      new NativeCrossfadeExecutor(),
      new VolumeFadeExecutor(this.automation),
      this.passive,
    ];
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Run a plan. Returns the outcome of whichever rung actually executed.
   * Never throws.
   */
  async execute(plan: TransitionPlan): Promise<ExecutionOutcome> {
    if (this.running) {
      return { status: "skipped", note: "a transition is already running" };
    }

    this.running = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const ctx = {
      signal,
      onProgress: (p: number) => this.events.emit("progress", { progress: p }),
    };

    try {
      // Start at the rung the plan asked for, then walk down on failure.
      const startIndex = Math.max(
        0,
        this.ladder.findIndex((e) => e.id === plan.executor),
      );

      let lastNote = "no executor accepted the plan";
      for (let i = startIndex; i < this.ladder.length; i++) {
        const executor = this.ladder[i] as TransitionExecutor;
        if (!executor.canRun(plan)) {
          log.debug(`${executor.id} declined the plan`);
          continue;
        }

        this.events.emit("start", { plan, executor: executor.id });
        const outcome = await executor.run(plan, ctx);
        lastNote = outcome.note;

        if (outcome.status === "completed" || outcome.status === "skipped") {
          this.events.emit("finish", { plan, outcome, executor: executor.id });
          return outcome;
        }
        if (outcome.status === "aborted") {
          this.events.emit("finish", { plan, outcome, executor: executor.id });
          return outcome;
        }

        // Failed — degrade to the next rung, but only if we still have time to.
        log.warn(`${executor.id} failed (${outcome.note}) — falling back`);
        if (signal.aborted) break;
      }

      const fallback: ExecutionOutcome = { status: "failed", note: lastNote };
      this.events.emit("finish", { plan, outcome: fallback, executor: "none" });
      return fallback;
    } catch (err) {
      // Nothing above should throw, but a broken client API could. Playback
      // must survive it.
      log.error("transition threw — restoring and standing down", err);
      this.automation.abort();
      const outcome: ExecutionOutcome = {
        status: "failed",
        note: String((err as Error)?.message ?? err),
      };
      this.events.emit("finish", { plan, outcome, executor: "none" });
      return outcome;
    } finally {
      this.running = false;
      this.controller = null;
    }
  }

  /** Cancel any transition in flight and undo anything it changed. */
  abort(reason = "aborted"): void {
    if (!this.running) {
      this.automation.restore();
      return;
    }
    log.info(`aborting transition: ${reason}`);
    this.controller?.abort();
    this.automation.abort();
  }

  /** Called on teardown. Leaves the client exactly as we found it. */
  dispose(): void {
    this.abort("engine disposed");
    this.automation.restore();
    this.events.clear();
  }
}
