/**
 * Audio Engine.
 *
 * Owns the fallback ladder, the volume session, and — the thing that was
 * missing — knowledge of whether *we* caused the track change that is about to
 * arrive as a `songchange` event.
 *
 *     native crossfade  (real audio overlap)
 *            ↓ unavailable / refused
 *     volume fade       (musically-timed switch, no overlap)
 *            ↓ unavailable / refused
 *     passive           (Spotify's own behaviour, untouched)
 *
 * Exactly one transition runs at a time, it carries a volume session id, and a
 * superseded one physically cannot move the volume any more.
 */

import { createLogger } from "../core/logger.js";
import { Emitter } from "../core/events.js";
import { getVolume, setVolume, getCurrentTrack } from "../platform/spicetify.js";
import { VolumeController } from "./volumeController.js";
import { NativeCrossfadeExecutor } from "./executors/nativeCrossfadeExecutor.js";
import { VolumeFadeExecutor } from "./executors/volumeFadeExecutor.js";
import { PassiveExecutor } from "./executors/passiveExecutor.js";
import { TransitionLog } from "../runtime/transitionLog.js";
import type { ExecutionContext, ExecutionOutcome, TransitionExecutor } from "./executors/types.js";
import type { TransitionPlan } from "../core/types.js";

const log = createLogger("audio");

/**
 * How long after calling `next()` a `songchange` still counts as ours.
 *
 * Generous, because a slow client can take a while; bounded, because a stale
 * flag would make us ignore a genuine user skip.
 */
const EXPECT_TRACK_CHANGE_WINDOW_MS = 4000;
/** How often to poll for the track actually having changed. */
const TRACK_CHANGE_POLL_MS = 20;

export interface AudioEngineEvents extends Record<string, unknown> {
  start: { plan: TransitionPlan; executor: string };
  progress: { progress: number };
  finish: { plan: TransitionPlan; outcome: ExecutionOutcome; executor: string };
}

export class AudioEngine {
  readonly events = new Emitter<AudioEngineEvents>();
  readonly volume: VolumeController;
  readonly transitionLog = new TransitionLog();

  private readonly ladder: TransitionExecutor[];
  private controller: AbortController | null = null;
  private running = false;
  private lastExecutor: string | null = null;

  /** Set just before our own `next()`; consulted by the runtime controller. */
  private expectingTrackChangeUntil = 0;
  /** The URI playing when we asked for the change, so we can spot the switch. */
  private uriBeforeSwitch: string | null = null;

  constructor(volume?: VolumeController) {
    this.volume = volume ?? new VolumeController({ get: getVolume, set: setVolume });
    this.ladder = [new NativeCrossfadeExecutor(), new VolumeFadeExecutor(), new PassiveExecutor()];
  }

  get isRunning(): boolean {
    return this.running;
  }

  get lastExecutorId(): string | null {
    return this.lastExecutor;
  }

  /**
   * Whether a `songchange` arriving now is one we caused.
   *
   * The runtime controller uses this to avoid aborting its own transition. It
   * is the single most important piece of state in the whole extension: without
   * it, our `next()` looks exactly like the user pressing skip, and every fade
   * gets cancelled halfway through.
   */
  isExpectingTrackChange(): boolean {
    return Date.now() < this.expectingTrackChangeUntil;
  }

  /** Called by the controller once it has consumed the expected change. */
  clearTrackChangeExpectation(): void {
    this.expectingTrackChangeUntil = 0;
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

    // A passive plan must not open a volume session at all — nothing should be
    // captured or restored for a transition that touches nothing.
    const needsVolume = plan.executor === "volume-fade";
    const session = needsVolume ? this.volume.begin() : 0;

    const record = this.transitionLog.open(
      session,
      plan.from.name,
      plan.to?.name ?? "—",
    );
    record.add(
      "TRANSITION_SCHEDULED",
      `${plan.strategy}/${plan.technique} via ${plan.executor}, ${plan.durationSec.toFixed(1)}s`,
    );

    const ctx: ExecutionContext = {
      signal,
      session,
      volume: this.volume,
      record,
      expectTrackChange: () => {
        this.uriBeforeSwitch = getCurrentTrack()?.uri ?? null;
        this.expectingTrackChangeUntil = Date.now() + EXPECT_TRACK_CHANGE_WINDOW_MS;
      },
      cancelTrackChangeExpectation: () => this.clearTrackChangeExpectation(),
      awaitTrackChange: (timeoutMs) => this.awaitTrackChange(timeoutMs, signal),
      onProgress: (p) => this.events.emit("progress", { progress: p }),
    };

    try {
      // Start at the rung the plan asked for, then walk down on failure.
      //
      // A plan naming an executor this build does not have must stand down, not
      // start at the top: `Math.max(0, -1)` silently promoted such a plan to the
      // most invasive rung available, which is the opposite of what an unknown
      // executor should mean.
      const startIndex = this.ladder.findIndex((e) => e.id === plan.executor);
      if (startIndex < 0) {
        const note = `no executor named "${plan.executor}" on this build`;
        log.error(`${note} — standing down rather than guessing`);
        record.add("TRANSITION_FAILED", note);
        const outcome: ExecutionOutcome = { status: "failed", note };
        this.events.emit("finish", { plan, outcome, executor: "none" });
        return outcome;
      }

      let lastNote = "no executor accepted the plan";
      for (let i = startIndex; i < this.ladder.length; i++) {
        const executor = this.ladder[i] as TransitionExecutor;
        if (!executor.canRun(plan)) {
          log.debug(`${executor.id} declined the plan`);
          continue;
        }

        this.events.emit("start", { plan, executor: executor.id });
        this.lastExecutor = executor.id;
        const outcome = await executor.run(plan, ctx);
        lastNote = outcome.note;

        if (outcome.status !== "failed") {
          this.events.emit("finish", { plan, outcome, executor: executor.id });
          return outcome;
        }

        log.warn(`${executor.id} failed (${outcome.note}) — falling back`);
        if (signal.aborted) break;
      }

      this.lastExecutor = "none";
      record.add("TRANSITION_FAILED", lastNote);
      const fallback: ExecutionOutcome = { status: "failed", note: lastNote };
      this.events.emit("finish", { plan, outcome: fallback, executor: "none" });
      return fallback;
    } catch (err) {
      // Nothing above should throw, but a broken client API could. Playback
      // must survive it.
      const message = String((err as Error)?.message ?? err);
      log.error("transition threw — restoring and standing down", err);
      record.add("TRANSITION_FAILED", message);
      const outcome: ExecutionOutcome = { status: "failed", note: message };
      this.events.emit("finish", { plan, outcome, executor: "none" });
      return outcome;
    } finally {
      // Close the session exactly once, here. `end` puts the level back and is
      // a no-op if this session was already superseded, so a late finally can
      // never undo the transition that replaced it.
      if (session !== 0) this.volume.end(session);
      this.running = false;
      this.controller = null;
    }
  }

  /**
   * Wait until the client reports a different track.
   *
   * Guarded throughout: an exception from the client must not stop the timeout
   * being reached, or this interval would outlive the session.
   */
  private awaitTrackChange(timeoutMs: number, signal: AbortSignal): Promise<number | null> {
    const started = Date.now();
    const before = this.uriBeforeSwitch;
    return new Promise((resolve) => {
      const finish = (value: number | null) => {
        clearInterval(timer);
        resolve(value);
      };
      const timer = setInterval(() => {
        if (signal.aborted || Date.now() - started >= timeoutMs) return finish(null);
        let now: string | null = null;
        try {
          now = getCurrentTrack()?.uri ?? null;
        } catch {
          return; // client unhappy; let the timeout decide
        }
        if (now !== null && now !== before) finish(Date.now() - started);
      }, TRACK_CHANGE_POLL_MS);
    });
  }

  /** Cancel any transition in flight and undo anything it changed. */
  abort(reason = "aborted"): void {
    this.expectingTrackChangeUntil = 0;
    if (this.running) log.info(`aborting transition: ${reason}`);
    this.controller?.abort();
    this.volume.cancel(reason);
  }

  /** Called on teardown. Leaves the client exactly as we found it. */
  dispose(): void {
    this.abort("engine disposed");
    this.volume.dispose();
    this.events.clear();
  }
}
