import type { TransitionPlan } from "../../core/types.js";
import type { TransitionRecord } from "../../runtime/transitionLog.js";
import type { VolumeController } from "../volumeController.js";

export interface ExecutionContext {
  /** Abort signal honoured by every executor. */
  signal: AbortSignal;
  /** The volume session this transition owns. Zero when it needs no volume. */
  session: number;
  /** Shared volume state machine. */
  volume: VolumeController;
  /** Event log for this transition. */
  record: TransitionRecord;
  /**
   * Called immediately before `Player.next()`.
   *
   * The controller needs this: Spotify emits `songchange` for our own track
   * change exactly as it does for a user skip, and without this hook it cannot
   * tell them apart — which is precisely what made it abort its own fade-in.
   */
  expectTrackChange(): void;
  /**
   * Withdraw that expectation, when the switch turned out not to happen.
   *
   * Leaving it set makes the controller read the *user's* next skip as our own
   * and let a dead transition run on, so anything that calls
   * `expectTrackChange` must retract it on the failure path.
   */
  cancelTrackChangeExpectation(): void;
  /** Resolves when the client actually reports the new track, or on timeout. */
  awaitTrackChange(timeoutMs: number): Promise<number | null>;
  /** Called with 0..1 as the transition runs. */
  onProgress(progress: number): void;
}

export type ExecutionOutcome =
  | { status: "completed"; note: string }
  | { status: "skipped"; note: string }
  | { status: "aborted"; note: string }
  | { status: "failed"; note: string };

export interface TransitionExecutor {
  readonly id: string;
  /** Can this executor run this plan on this client right now? */
  canRun(plan: TransitionPlan): boolean;
  run(plan: TransitionPlan, ctx: ExecutionContext): Promise<ExecutionOutcome>;
}
