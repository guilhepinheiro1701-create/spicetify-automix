/**
 * Volume automation.
 *
 * Spotify exposes exactly one fader: master volume. Everything here is built
 * around two rules that follow from that.
 *
 *  1. **Always restore.** A ramp that is interrupted — by an error, by a track
 *     change, by the extension being disabled — must put the volume back where
 *     it found it. A stuck-at-zero volume is the worst possible failure mode,
 *     so restoration happens in a `finally` and again on a watchdog.
 *  2. **Never fight the user.** If the volume moves by more than a hair from
 *     where we put it, that was a human, and we abandon the ramp immediately
 *     and leave their setting alone.
 */

import { createLogger } from "../core/logger.js";
import { clamp01, fadeGain } from "../core/util.js";
import type { FadeCurve } from "../core/types.js";

const log = createLogger("automation");

/** Above this difference between expected and actual volume, assume a human moved it. */
const USER_OVERRIDE_EPSILON = 0.04;
const TICK_MS = 25;
/** Backoff and cap for putting the volume back when the client is refusing writes. */
const RESTORE_RETRY_MS = 150;
const RESTORE_MAX_ATTEMPTS = 6;

export interface VolumeIO {
  get(): number;
  set(v: number): boolean;
}

export interface RampOptions {
  from: number;
  to: number;
  durationMs: number;
  curve: FadeCurve;
  direction: "in" | "out";
  onTick?: (progress: number, volume: number) => void;
}

export type RampOutcome = "completed" | "cancelled" | "user-override" | "failed";

/**
 * Runs one volume ramp at a time and guarantees the baseline is restored.
 */
export class VolumeAutomation {
  private timer: ReturnType<typeof setInterval> | null = null;
  private restoreTimer: ReturnType<typeof setTimeout> | null = null;
  private baseline: number | null = null;
  private expected: number | null = null;
  private resolveCurrent: ((outcome: RampOutcome) => void) | null = null;

  constructor(private readonly io: VolumeIO) {}

  get isRunning(): boolean {
    return this.timer !== null;
  }

  /** The volume we will return to. Captured on the first ramp of a sequence. */
  captureBaseline(): number {
    if (this.baseline === null) this.baseline = this.io.get();
    return this.baseline;
  }

  ramp(options: RampOptions): Promise<RampOutcome> {
    this.stop("cancelled");
    this.captureBaseline();

    const { from, to, durationMs, curve, direction } = options;
    if (durationMs <= 0) {
      this.applyVolume(to);
      return Promise.resolve<RampOutcome>("completed");
    }

    const startedAt = Date.now();
    this.applyVolume(from);

    return new Promise<RampOutcome>((resolve) => {
      this.resolveCurrent = resolve;
      this.timer = setInterval(() => {
        // The user grabbed the volume slider — back off entirely.
        if (this.expected !== null) {
          const actual = this.io.get();
          if (Math.abs(actual - this.expected) > USER_OVERRIDE_EPSILON) {
            log.info("volume changed externally — abandoning ramp and leaving it alone");
            this.baseline = actual;
            this.finish("user-override", false);
            return;
          }
        }

        const t = clamp01((Date.now() - startedAt) / durationMs);
        const shaped = fadeGain(curve, t, direction);
        // Map the curve's 0..1 onto the requested endpoints.
        const unit = direction === "in" ? shaped : 1 - shaped;
        const volume = from + (to - from) * unit;

        if (!this.applyVolume(volume)) {
          this.finish("failed", true);
          return;
        }
        options.onTick?.(t, volume);

        if (t >= 1) this.finish("completed", false);
      }, TICK_MS);
    });
  }

  private applyVolume(v: number): boolean {
    const level = clamp01(v);
    const ok = this.io.set(level);
    if (ok) this.expected = level;
    return ok;
  }

  private finish(outcome: RampOutcome, restore: boolean): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (restore) this.restore();
    const resolve = this.resolveCurrent;
    this.resolveCurrent = null;
    resolve?.(outcome);
  }

  /** Stop a ramp in progress without restoring — used when chaining ramps. */
  stop(outcome: RampOutcome = "cancelled"): void {
    if (this.timer === null) return;
    this.finish(outcome, false);
  }

  /** Stop and put the volume back where the user had it. */
  abort(): void {
    if (this.timer !== null) {
      this.finish("cancelled", false);
    }
    this.restore();
  }

  /**
   * Put the volume back where the user had it.
   *
   * The baseline is only forgotten once the write actually succeeds. If the
   * client's volume API is momentarily unavailable — which is exactly when a
   * transition is most likely to be abandoned — discarding it here would leave
   * the listener at whatever level the fade had reached, with nothing left to
   * restore from when the client recovers.
   */
  restore(): void {
    if (this.baseline === null) return;
    const target = this.baseline;

    if (this.io.set(target)) {
      this.baseline = null;
      this.expected = null;
      return;
    }

    log.warn("could not restore volume — retrying while the client recovers");
    this.scheduleRestoreRetry(target, 1);
  }

  private scheduleRestoreRetry(target: number, attempt: number): void {
    if (attempt > RESTORE_MAX_ATTEMPTS) {
      // Stop the retry loop, but deliberately keep the baseline. We have not
      // put the volume back yet, and forgetting where it belongs is how a
      // listener ends up stuck at half level. The next explicit restore — on
      // abort, on teardown, or when the next transition finishes — tries again.
      log.error(
        "the client is still rejecting volume writes; holding the original level for a later attempt",
      );
      return;
    }
    if (this.restoreTimer !== null) clearTimeout(this.restoreTimer);
    this.restoreTimer = setTimeout(
      () => {
        this.restoreTimer = null;
        // A newer ramp may have taken over in the meantime; do not fight it.
        if (this.baseline === null || this.timer !== null) return;
        if (this.io.set(target)) {
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

  /** Forget the baseline without touching the volume. */
  releaseBaseline(): void {
    if (this.restoreTimer !== null) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
    this.baseline = null;
    this.expected = null;
  }
}
