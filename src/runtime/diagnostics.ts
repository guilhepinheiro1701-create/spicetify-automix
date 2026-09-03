/**
 * Diagnostics and the experimental session log.
 *
 * Two things live here, and both answer the same question: *is this actually
 * better than plain Spotify?* Passing tests prove the code is consistent; they
 * say nothing about whether two hours of listening sounds good.
 *
 *  - **Counters** accumulate what happened over a session — how many
 *    transitions were attempted, how many degraded to a lower tier, what the
 *    average score and confidence were, how many were interrupted.
 *  - **The session log** records the decision behind each transition, so a run
 *    can be read back afterwards and judged.
 *
 * Everything is in memory and, optionally, in local storage. Nothing is sent
 * anywhere. There is no telemetry in this project and there is not going to be.
 */

import { createLogger } from "../core/logger.js";
import { mean } from "../core/util.js";
import type { TransitionPlan } from "../core/types.js";

const log = createLogger("diagnostics");

/** The session log is bounded so a long listening session cannot grow forever. */
export const LOG_LIMIT = 300;

export type TransitionOutcomeKind =
  | "completed"
  | "skipped"
  | "aborted"
  | "failed"
  | "degraded";

export interface SessionLogEntry {
  at: number;
  fromName: string;
  toName: string;
  fromArtist: string;
  toArtist: string;

  // What the engine decided.
  score: number;
  band: string;
  confidence: number;
  confidenceLabel: string;
  strategy: string;
  technique: string;
  durationSec: number;
  durationBeats: number | null;
  exitSection: string;
  entrySection: string;
  phraseAligned: boolean;
  beatAligned: boolean;
  mixableWindowSec: number;
  windowLimitedBy: string;

  // Component scores, so a run can be re-judged afterwards.
  tempoScore: number;
  keyScore: number;
  energyScore: number;
  phraseScore: number;
  loudnessScore: number;

  // What actually happened.
  executorRequested: string;
  executorUsed: string | null;
  outcome: TransitionOutcomeKind | null;
  note: string | null;
  /** Milliseconds between firing and the outcome. */
  elapsedMs: number | null;
}

export interface DiagnosticsSnapshot {
  startedAt: number;
  uptimeMs: number;

  transitionsPlanned: number;
  transitionsAttempted: number;
  completed: number;
  skipped: number;
  aborted: number;
  failed: number;
  /** Attempts that fell to a lower rung than the plan asked for. */
  degraded: number;

  crossfadeAvailable: boolean | null;
  crossfadeTransitions: number;
  fadeTransitions: number;
  passiveTransitions: number;

  averageScore: number;
  averageConfidence: number;
  /** Transitions in the POOR or VERY POOR bands. */
  poorTransitions: number;

  queueReorders: number;
  queueFailures: number;
  analysisMisses: number;

  bandCounts: Record<string, number>;
  strategyCounts: Record<string, number>;
}

export class Diagnostics {
  private readonly startedAt = Date.now();
  private entries: SessionLogEntry[] = [];

  private counts = {
    planned: 0,
    attempted: 0,
    completed: 0,
    skipped: 0,
    aborted: 0,
    failed: 0,
    degraded: 0,
    crossfade: 0,
    fade: 0,
    passive: 0,
    reorders: 0,
    queueFailures: 0,
    analysisMisses: 0,
  };
  private scores: number[] = [];
  private confidences: number[] = [];
  private bandCounts: Record<string, number> = {};
  private strategyCounts: Record<string, number> = {};
  private crossfadeAvailable: boolean | null = null;

  setCrossfadeAvailable(available: boolean): void {
    this.crossfadeAvailable = available;
  }

  notePlanned(plan: TransitionPlan): void {
    this.counts.planned++;
    if (!plan.to) return;
    this.scores.push(plan.compatibility.overall);
    this.confidences.push(plan.musicalConfidence);
    this.bandCounts[plan.band] = (this.bandCounts[plan.band] ?? 0) + 1;
    this.strategyCounts[plan.strategy] = (this.strategyCounts[plan.strategy] ?? 0) + 1;
  }

  noteAnalysisMiss(): void {
    this.counts.analysisMisses++;
  }

  noteQueueReorder(succeeded: boolean): void {
    if (succeeded) this.counts.reorders++;
    else this.counts.queueFailures++;
  }

  /** Open a log entry when a transition fires. Returns its index. */
  beginTransition(plan: TransitionPlan, exitSection: string, entrySection: string): number {
    this.counts.attempted++;
    const c = plan.compatibility;
    const entry: SessionLogEntry = {
      at: Date.now(),
      fromName: plan.from.name,
      toName: plan.to?.name ?? "—",
      fromArtist: plan.from.artists[0] ?? "",
      toArtist: plan.to?.artists[0] ?? "",
      score: c.overall,
      band: plan.band,
      confidence: plan.musicalConfidence,
      confidenceLabel: plan.musicalConfidenceLabel,
      strategy: plan.strategy,
      technique: plan.technique,
      durationSec: plan.durationSec,
      durationBeats: plan.durationBeats,
      exitSection,
      entrySection,
      phraseAligned: plan.phraseAlignment,
      beatAligned: plan.beatAlignment,
      mixableWindowSec: plan.mixableWindowSec,
      windowLimitedBy: plan.windowLimitedBy,
      tempoScore: c.tempo.score,
      keyScore: c.key.score,
      energyScore: c.energy.score,
      phraseScore: c.phrase.score,
      loudnessScore: c.loudness.score,
      executorRequested: plan.executor,
      executorUsed: null,
      outcome: null,
      note: null,
      elapsedMs: null,
    };

    this.entries.push(entry);
    while (this.entries.length > LOG_LIMIT) this.entries.shift();
    return this.entries.length - 1;
  }

  /** Close the entry opened by `beginTransition`. */
  endTransition(
    index: number,
    outcome: TransitionOutcomeKind,
    executorUsed: string,
    note: string,
  ): void {
    switch (outcome) {
      case "completed":
        this.counts.completed++;
        break;
      case "skipped":
        this.counts.skipped++;
        break;
      case "aborted":
        this.counts.aborted++;
        break;
      case "failed":
        this.counts.failed++;
        break;
      default:
        break;
    }

    if (executorUsed === "native-crossfade") this.counts.crossfade++;
    else if (executorUsed === "volume-fade") this.counts.fade++;
    else if (executorUsed === "passive") this.counts.passive++;

    const entry = this.entries[index];
    if (!entry) return;
    if (entry.executorRequested !== executorUsed && executorUsed !== "none") {
      this.counts.degraded++;
      log.info(`degraded: ${entry.executorRequested} → ${executorUsed} (${note})`);
    }
    entry.executorUsed = executorUsed;
    entry.outcome = outcome;
    entry.note = note;
    entry.elapsedMs = Date.now() - entry.at;
  }

  snapshot(): DiagnosticsSnapshot {
    const poor = (this.bandCounts["POOR"] ?? 0) + (this.bandCounts["VERY POOR"] ?? 0);
    return {
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      transitionsPlanned: this.counts.planned,
      transitionsAttempted: this.counts.attempted,
      completed: this.counts.completed,
      skipped: this.counts.skipped,
      aborted: this.counts.aborted,
      failed: this.counts.failed,
      degraded: this.counts.degraded,
      crossfadeAvailable: this.crossfadeAvailable,
      crossfadeTransitions: this.counts.crossfade,
      fadeTransitions: this.counts.fade,
      passiveTransitions: this.counts.passive,
      averageScore: this.scores.length ? mean(this.scores) : 0,
      averageConfidence: this.confidences.length ? mean(this.confidences) : 0,
      poorTransitions: poor,
      queueReorders: this.counts.reorders,
      queueFailures: this.counts.queueFailures,
      analysisMisses: this.counts.analysisMisses,
      bandCounts: { ...this.bandCounts },
      strategyCounts: { ...this.strategyCounts },
    };
  }

  log(): readonly SessionLogEntry[] {
    return this.entries;
  }

  /**
   * The session as text, for reading back after a listening run.
   *
   * This is the artefact the experimental mode exists to produce: what the
   * engine decided, why, and what happened — enough to judge the algorithm
   * without ever touching the audio.
   */
  formatLog(): string {
    if (this.entries.length === 0) return "No transitions logged yet.";
    const s = this.snapshot();
    const lines: string[] = [
      "SMART DJ — SESSION LOG",
      `${new Date(s.startedAt).toLocaleString()} · ${(s.uptimeMs / 60000).toFixed(0)} min`,
      "",
      `Planned ${s.transitionsPlanned} · attempted ${s.transitionsAttempted} · ` +
        `completed ${s.completed} · aborted ${s.aborted} · failed ${s.failed} · degraded ${s.degraded}`,
      `Average score ${(s.averageScore * 100).toFixed(0)}% · ` +
        `average confidence ${(s.averageConfidence * 100).toFixed(0)}% · poor ${s.poorTransitions}`,
      "",
    ];

    for (const e of this.entries) {
      lines.push(
        `${new Date(e.at).toLocaleTimeString()}  ${e.fromName} → ${e.toName}`,
        `  ${Math.round(e.score * 100)}% ${e.band} · confidence ${Math.round(e.confidence * 100)}% (${e.confidenceLabel})`,
        `  strategy ${e.strategy} · ${e.technique} · ${e.durationBeats ? `${e.durationBeats} beats` : `${e.durationSec}s`}`,
        `  exit ${e.exitSection} → entry ${e.entrySection} · runway ${e.mixableWindowSec}s (${e.windowLimitedBy})`,
        `  phrase ${e.phraseAligned ? "matched" : "free"} · downbeat ${e.beatAligned ? "locked" : "no"}`,
        `  components: tempo ${Math.round(e.tempoScore * 100)} key ${Math.round(e.keyScore * 100)} ` +
          `energy ${Math.round(e.energyScore * 100)} phrase ${Math.round(e.phraseScore * 100)} ` +
          `loudness ${Math.round(e.loudnessScore * 100)}`,
        `  execution: ${e.executorRequested}` +
          (e.executorUsed && e.executorUsed !== e.executorRequested
            ? ` → ${e.executorUsed} (degraded)`
            : "") +
          ` · ${e.outcome ?? "pending"}${e.note ? ` — ${e.note}` : ""}`,
        "",
      );
    }
    return lines.join("\n");
  }

  reset(): void {
    this.entries = [];
    this.scores = [];
    this.confidences = [];
    this.bandCounts = {};
    this.strategyCounts = {};
    for (const k of Object.keys(this.counts) as (keyof typeof this.counts)[]) {
      this.counts[k] = 0;
    }
  }
}
