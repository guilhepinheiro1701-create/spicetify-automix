/**
 * The volume controller.
 *
 * One object owns the volume. It is an explicit state machine with a session
 * id, and every rule that kept getting broken is now structural rather than a
 * convention someone has to remember:
 *
 *     NORMAL ──begin──► FADING_OUT ──► AWAITING_SWITCH ──► FADING_IN ──► NORMAL
 *        ▲                                                                 │
 *        └──────────────── cancel from any state ──► RESTORING ────────────┘
 *
 * Three invariants it enforces:
 *
 *  1. **The baseline is never lost.** It is captured once when a session opens
 *     and only cleared after a write actually puts it back. If the client
 *     refuses the write, the level is remembered and retried; if it refuses
 *     forever, the level is still remembered for the next explicit restore.
 *  2. **Only one session may move the volume.** Every call carries a session
 *     id, and a call from a superseded session is ignored rather than fighting
 *     the current one. This is what stops an aborted transition from continuing
 *     to drag the volume down underneath its replacement.
 *  3. **The user always wins.** If the level moves anywhere we did not put it,
 *     that was a human: the session is abandoned and their value is adopted as
 *     the new baseline, never overwritten.
 */

import { createLogger } from "../core/logger.js";
import { clamp01, fadeGain } from "../core/util.js";
import type { FadeCurve } from "../core/types.js";

const log = createLogger("volume");

/** Above this difference between expected and actual, assume a human moved it. */
const USER_OVERRIDE_EPSILON = 0.04;
const TICK_MS = 25;
/**
 * Smallest level change worth sending to the client.
 *
 * At 25 ms a seven-second fade would otherwise issue nearly three hundred
 * writes, most of them moving the level by less than a listener can hear. The
 * endpoints of a ramp are always written exactly, so this only drops the
 * redundant middle.
 */
const MIN_WRITE_DELTA = 0.004;
/** Backoff and cap for putting the level back when the client refuses writes. */
const RESTORE_RETRY_MS = 150;
const RESTORE_MAX_ATTEMPTS = 6;

export type VolumeState =
  | "normal"
  | "fading-out"
  | "awaiting-switch"
  | "fading-in"
  | "restoring";

export type RampResult = "completed" | "superseded" | "user-override" | "failed";

export interface VolumeIO {
  get(): number;
  set(v: number): boolean;
}

export interface RampRequest {
  session: number;
  /** Absolute target level, 0..1. */
  to: number;
  durationMs: number;
  curve: FadeCurve;
  /** Which phase this ramp represents, for the state machine and the log. */
  phase: "fading-out" | "fading-in" | "restoring";
  onTick?: (progress: number, volume: number) => void;
}

export class VolumeController {
  private io: VolumeIO;

  private sessionCounter = 0;
  private activeSession = 0;
  private state: VolumeState = "normal";

  private baseline: number | null = null;
  /** The last level we wrote, so an external change is detectable. */
  private expected: number | null = null;

  private rampTimer: ReturnType<typeof setInterval> | null = null;
  private restoreTimer: ReturnType<typeof setTimeout> | null = null;
  private finishRamp: ((result: RampResult) => void) | null = null;

  constructor(io: VolumeIO) {
    this.io = io;
  }

  getState(): VolumeState {
    return this.state;
  }

  getBaseline(): number | null {
    return this.baseline;
  }

  get currentSession(): number {
    return this.activeSession;
  }

  isOwnedBy(session: number): boolean {
    return session === this.activeSession && session !== 0;
  }

  /**
   * Open a session and capture the level to return to.
   *
   * Any session already running is superseded: its ramp stops where it is
   * rather than continuing to fight the new one. The baseline carries over, so
   * a transition that replaces another still restores the level the *user* set,
   * not the mid-fade level the previous transition had reached.
   */
  begin(): number {
    if (this.rampTimer !== null) {
      log.debug("a new session superseded one still running");
      this.stopRamp("superseded");
    }
    this.sessionCounter += 1;
    this.activeSession = this.sessionCounter;

    if (this.baseline === null) {
      this.baseline = this.io.get();
      log.debug(`session ${this.activeSession} opened, baseline ${this.baseline.toFixed(3)}`);
    } else {
      log.debug(
        `session ${this.activeSession} opened, keeping baseline ${this.baseline.toFixed(3)}`,
      );
    }
    this.state = "normal";
    return this.activeSession;
  }

  /** Mark the gap between the fade-out finishing and the track actually changing. */
  awaitSwitch(session: number): void {
    if (!this.isOwnedBy(session)) return;
    this.state = "awaiting-switch";
  }

  /**
   * Ramp to an absolute level. Resolves with why it ended.
   *
   * A ramp belonging to a superseded session resolves immediately without
   * touching anything.
   */
  ramp(request: RampRequest): Promise<RampResult> {
    if (!this.isOwnedBy(request.session)) {
      return Promise.resolve<RampResult>("superseded");
    }
    this.stopRamp("superseded");

    const from = this.expected ?? this.io.get();
    const { to, durationMs, curve, phase } = request;
    this.state = phase;

    if (durationMs <= 0) {
      const ok = this.write(to);
      return Promise.resolve<RampResult>(ok ? "completed" : "failed");
    }

    const startedAt = Date.now();
    return new Promise<RampResult>((resolve) => {
      this.finishRamp = resolve;
      this.rampTimer = setInterval(() => {
        // Superseded mid-ramp: stop immediately and let the new session lead.
        if (!this.isOwnedBy(request.session)) return this.stopRamp("superseded");

        if (this.detectUserOverride()) return this.stopRamp("user-override");

        const t = clamp01((Date.now() - startedAt) / durationMs);
        const shaped = fadeGain(curve, t, phase === "fading-out" ? "out" : "in");
        const unit = phase === "fading-out" ? 1 - shaped : shaped;
        const level = from + (to - from) * unit;

        // Always write the final value exactly; skip inaudible intermediate steps.
        const isFinal = t >= 1;
        const changedEnough =
          this.expected === null || Math.abs(level - this.expected) >= MIN_WRITE_DELTA;
        if ((isFinal || changedEnough) && !this.write(level)) {
          return this.stopRamp("failed");
        }

        // Stop the ramp *before* handing control to the caller's callback. If
        // that callback throws, this interval would otherwise keep firing
        // forever against a promise that can never resolve — which is how the
        // ramp would hold the volume down for the rest of the session.
        if (isFinal) this.stopRamp("completed");
        try {
          request.onTick?.(t, level);
        } catch (err) {
          log.warn("a progress listener threw during the ramp", err);
        }
      }, TICK_MS);
    });
  }

  /**
   * Close a session cleanly: put the level back and return to normal.
   *
   * Safe to call from a superseded session — it becomes a no-op, so a late
   * `finally` cannot undo the session that replaced it.
   */
  end(session: number): void {
    if (!this.isOwnedBy(session)) return;
    this.stopRamp("superseded");
    this.state = "restoring";
    this.restore();
    this.activeSession = 0;
    this.state = "normal";
  }

  /**
   * Abandon whatever is happening and put the level back.
   *
   * `session` may be omitted to cancel unconditionally — that is what teardown
   * and a user skip do.
   */
  cancel(reason: string, session?: number): void {
    if (session !== undefined && !this.isOwnedBy(session)) return;
    if (this.rampTimer !== null || this.state !== "normal") {
      log.debug(`cancelling session ${this.activeSession}: ${reason}`);
    }
    this.stopRamp("superseded");
    this.state = "restoring";
    this.restore();
    this.activeSession = 0;
    this.state = "normal";
  }

  /**
   * Give up the baseline without moving the volume.
   *
   * Used when a session has already settled the level exactly where it wants
   * it, so a restore afterwards would be a redundant write.
   */
  release(session: number): void {
    if (!this.isOwnedBy(session)) return;
    this.clearRestoreTimer();
    this.baseline = null;
    this.expected = null;
    this.activeSession = 0;
    this.state = "normal";
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private write(level: number): boolean {
    const v = clamp01(level);
    const ok = this.io.set(v);
    if (ok) this.expected = v;
    return ok;
  }

  private detectUserOverride(): boolean {
    if (this.expected === null) return false;
    const actual = this.io.get();
    if (Math.abs(actual - this.expected) <= USER_OVERRIDE_EPSILON) return false;

    log.info("volume changed externally — abandoning the ramp and adopting your level");
    // Their value becomes the truth. Nothing may put the old one back.
    this.baseline = actual;
    this.expected = actual;
    return true;
  }

  private stopRamp(result: RampResult): void {
    if (this.rampTimer !== null) {
      clearInterval(this.rampTimer);
      this.rampTimer = null;
    }
    const resolve = this.finishRamp;
    this.finishRamp = null;
    resolve?.(result);
  }

  /**
   * Put the level back, keeping the baseline until a write actually succeeds.
   *
   * Forgetting where the volume belongs before the write lands is how a
   * listener ends up stuck at half level when the client's API blips.
   */
  private restore(): void {
    if (this.baseline === null) return;
    const target = this.baseline;

    if (this.write(target)) {
      this.clearRestoreTimer();
      this.baseline = null;
      this.expected = null;
      return;
    }

    log.warn("could not restore the volume — retrying while the client recovers");
    this.scheduleRestoreRetry(target, 1);
  }

  private scheduleRestoreRetry(target: number, attempt: number): void {
    if (attempt > RESTORE_MAX_ATTEMPTS) {
      // Stop retrying, but deliberately keep the baseline: we have not put the
      // level back yet, and the next explicit cancel or teardown must try again.
      log.error("the client is still refusing volume writes; holding the level for a later attempt");
      return;
    }
    this.clearRestoreTimer();
    this.restoreTimer = setTimeout(
      () => {
        this.restoreTimer = null;
        if (this.baseline === null || this.rampTimer !== null) return;
        if (this.write(target)) {
          this.baseline = null;
          this.expected = null;
          log.info("volume restored once the client recovered");
          return;
        }
        this.scheduleRestoreRetry(target, attempt + 1);
      },
      RESTORE_RETRY_MS * attempt,
    );
  }

  private clearRestoreTimer(): void {
    if (this.restoreTimer !== null) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
  }

  /** Stop everything and put the level back. Idempotent. */
  dispose(): void {
    this.cancel("disposed");
    this.clearRestoreTimer();
  }
}
