import type { TransitionPlan } from "../../core/types.js";

export interface ExecutionContext {
  /** Abort signal honoured by every executor. */
  signal: AbortSignal;
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
