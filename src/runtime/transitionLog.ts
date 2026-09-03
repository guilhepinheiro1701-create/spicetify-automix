/**
 * The transition event log.
 *
 * Every transition emits a fixed sequence of events. If one is missing, that
 * is the bug — and it is visible immediately rather than inferred from a
 * volume trace afterwards.
 *
 *     TRANSITION_CREATED
 *     TRANSITION_SCHEDULED
 *     FADE_OUT_STARTED      ┐
 *     FADE_OUT_COMPLETED    │ fade path only
 *     NEXT_TRIGGERED        ┤ both paths
 *     TRACK_CHANGED         │
 *     FADE_IN_STARTED       │
 *     FADE_IN_COMPLETED     ┘
 *     TRANSITION_COMPLETED
 *
 * Anything that goes wrong ends the sequence with `TRANSITION_FAILED` or
 * `TRANSITION_CANCELLED` carrying a reason. This is what the real-playback
 * harness asserts against, and what Debug mode prints live.
 */

import { createLogger } from "../core/logger.js";

const log = createLogger("transition");

export type TransitionEventType =
  | "TRANSITION_CREATED"
  | "TRANSITION_SCHEDULED"
  | "FADE_OUT_STARTED"
  | "FADE_OUT_COMPLETED"
  | "NEXT_TRIGGERED"
  | "TRACK_CHANGED"
  | "FADE_IN_STARTED"
  | "FADE_IN_COMPLETED"
  | "TRANSITION_COMPLETED"
  | "TRANSITION_CANCELLED"
  | "TRANSITION_FAILED";

export interface TransitionEvent {
  at: number;
  /** Milliseconds since the transition was created. */
  elapsedMs: number;
  type: TransitionEventType;
  session: number;
  /** Playback position when this happened, in seconds. */
  positionSec: number | null;
  volume: number | null;
  detail: string;
}

const TERMINAL: TransitionEventType[] = [
  "TRANSITION_COMPLETED",
  "TRANSITION_CANCELLED",
  "TRANSITION_FAILED",
];

/** One transition's worth of events. */
export class TransitionRecord {
  readonly createdAt = Date.now();
  readonly events: TransitionEvent[] = [];

  constructor(
    readonly session: number,
    readonly fromName: string,
    readonly toName: string,
  ) {}

  add(
    type: TransitionEventType,
    detail = "",
    context: { positionSec?: number | null; volume?: number | null } = {},
  ): void {
    const event: TransitionEvent = {
      at: Date.now(),
      elapsedMs: Date.now() - this.createdAt,
      type,
      session: this.session,
      positionSec: context.positionSec ?? null,
      volume: context.volume ?? null,
      detail,
    };
    this.events.push(event);
    log.debug(
      `#${this.session} ${type}` +
        (event.positionSec !== null ? ` @${event.positionSec.toFixed(1)}s` : "") +
        (event.volume !== null ? ` vol ${Math.round(event.volume * 100)}%` : "") +
        (detail ? ` — ${detail}` : ""),
    );
  }

  get isFinished(): boolean {
    const last = this.events[this.events.length - 1];
    return last !== undefined && TERMINAL.includes(last.type);
  }

  get outcome(): TransitionEventType | null {
    const last = this.events[this.events.length - 1];
    return last && TERMINAL.includes(last.type) ? last.type : null;
  }

  has(type: TransitionEventType): boolean {
    return this.events.some((e) => e.type === type);
  }

  /**
   * Which expected events never arrived. The whole point of the fixed sequence
   * is that this list answers "what actually went wrong" directly.
   */
  missing(expectFade: boolean): TransitionEventType[] {
    const required: TransitionEventType[] = expectFade
      ? [
          "TRANSITION_CREATED",
          "TRANSITION_SCHEDULED",
          "FADE_OUT_STARTED",
          "FADE_OUT_COMPLETED",
          "NEXT_TRIGGERED",
          "TRACK_CHANGED",
          "FADE_IN_STARTED",
          "FADE_IN_COMPLETED",
          "TRANSITION_COMPLETED",
        ]
      : [
          "TRANSITION_CREATED",
          "TRANSITION_SCHEDULED",
          "NEXT_TRIGGERED",
          "TRACK_CHANGED",
          "TRANSITION_COMPLETED",
        ];
    return required.filter((t) => !this.has(t));
  }

  format(): string {
    const head = `#${this.session}  ${this.fromName} → ${this.toName}`;
    const lines = this.events.map((e) => {
      const pos = e.positionSec !== null ? ` @${e.positionSec.toFixed(1)}s` : "";
      const vol = e.volume !== null ? ` ${Math.round(e.volume * 100)}%` : "";
      return `  ${String(e.elapsedMs).padStart(6)}ms  ${e.type}${pos}${vol}${e.detail ? `  ${e.detail}` : ""}`;
    });
    return [head, ...lines].join("\n");
  }
}

/** A bounded history of transition records. */
export class TransitionLog {
  private records: TransitionRecord[] = [];

  constructor(private readonly limit = 40) {}

  open(session: number, fromName: string, toName: string): TransitionRecord {
    const record = new TransitionRecord(session, fromName, toName);
    record.add("TRANSITION_CREATED");
    this.records.push(record);
    while (this.records.length > this.limit) this.records.shift();
    return record;
  }

  latest(): TransitionRecord | null {
    return this.records[this.records.length - 1] ?? null;
  }

  all(): readonly TransitionRecord[] {
    return this.records;
  }

  /** Records that did not complete, which is what a bug report needs. */
  incomplete(): TransitionRecord[] {
    return this.records.filter((r) => r.outcome !== "TRANSITION_COMPLETED");
  }

  format(): string {
    if (this.records.length === 0) return "No transitions yet.";
    return this.records.map((r) => r.format()).join("\n\n");
  }

  clear(): void {
    this.records = [];
  }
}
