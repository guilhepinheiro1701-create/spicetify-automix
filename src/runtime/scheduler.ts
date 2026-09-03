/**
 * Firing a transition at the right millisecond.
 *
 * `Player.getProgress()` is interpolated from the client's state timestamp, so
 * it is exact between events — but `onprogress` only fires every 100 ms, which
 * is far too coarse when the plan says "switch on this downbeat".
 *
 * So we do it in two stages: a cheap poll gets us near the target without
 * burning CPU, then a self-correcting timer chain closes the last stretch,
 * re-reading the real position on every hop so drift never accumulates.
 */

import { createLogger } from "../core/logger.js";

const log = createLogger("scheduler");

/** Coarse polling interval while the target is far away. */
const COARSE_MS = 250;
/** Inside this window we switch to fine-grained self-correction. */
const FINE_WINDOW_MS = 1500;
/** Below this we stop re-checking and just wait it out. */
const COMMIT_MS = 30;

export interface SchedulerClock {
  /** Current playback position in ms. */
  position(): number;
  /** Whether playback is running. */
  playing(): boolean;
}

export class TransitionScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private targetMs: number | null = null;
  private fired = false;

  constructor(private readonly clock: SchedulerClock) {}

  get armed(): boolean {
    return this.timer !== null;
  }

  get target(): number | null {
    return this.targetMs;
  }

  /** Seconds until the armed transition, or null when nothing is armed. */
  etaSec(): number | null {
    if (this.targetMs === null) return null;
    return Math.max(0, (this.targetMs - this.clock.position()) / 1000);
  }

  /**
   * Fire `onFire` when playback reaches `targetMs`. Re-arming replaces any
   * previous schedule.
   */
  arm(targetMs: number, onFire: () => void): void {
    this.cancel();
    this.targetMs = targetMs;
    this.fired = false;

    const step = () => {
      this.timer = null;
      if (this.fired) return;

      if (!this.clock.playing()) {
        // Paused: check back occasionally rather than firing into a paused player.
        this.timer = setTimeout(step, COARSE_MS * 2);
        return;
      }

      const remaining = targetMs - this.clock.position();

      if (remaining <= COMMIT_MS) {
        this.fired = true;
        this.targetMs = null;
        try {
          onFire();
        } catch (err) {
          log.error("scheduled callback threw", err);
        }
        return;
      }

      // Sleep most of the remaining time, then re-measure. Each hop halves the
      // error, so we land within a few milliseconds without polling hard.
      const sleep =
        remaining > FINE_WINDOW_MS
          ? Math.min(COARSE_MS, remaining - FINE_WINDOW_MS)
          : Math.max(COMMIT_MS / 2, remaining * 0.6);

      this.timer = setTimeout(step, sleep);
    };

    step();
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.targetMs = null;
    this.fired = false;
  }
}
