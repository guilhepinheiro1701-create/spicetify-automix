/**
 * Transition memory.
 *
 * The analysis cache remembers what a track *is*. This remembers what we
 * decided about a *pair* — so replaying a playlist does not recompute the same
 * plan, and so the diagnostics can tell you whether the same pairing keeps
 * coming out badly.
 *
 * Every entry is stamped with `ALGORITHM_VERSION`. When the engine's behaviour
 * changes, that number changes, and every stored decision is discarded rather
 * than being served stale — a remembered plan from an older algorithm is worse
 * than no plan at all.
 */

import { createLogger } from "../core/logger.js";
import type { TransitionPlan, TransitionStrategy } from "../core/types.js";

const log = createLogger("memory");

/**
 * Bump this whenever a change would make a previously stored decision wrong.
 *
 *   1 — Phase 1: initial engine
 *   2 — Phase 2: runway sizing, bands, phase alignment, hard-constraint caps
 *   3 — Phase 3: DJ intent weights, musical confidence, contrast strategy
 */
export const ALGORITHM_VERSION = 3;

export const MEMORY_STORAGE_KEY = "smart-dj:transitions:v1";
export const MEMORY_LIMIT = 400;

export interface RememberedTransition {
  fromUri: string;
  toUri: string;
  /** Technical compatibility, 0..1. */
  score: number;
  /** Musical confidence in the approach taken, 0..1. */
  confidence: number;
  band: string;
  strategy: TransitionStrategy;
  durationSec: number;
  durationBeats: number | null;
  executor: string;
  /** Which intent produced this decision — a different intent means a different plan. */
  intent: string;
  algorithmVersion: number;
  at: number;
  /** How many times this pairing has come round. */
  timesSeen: number;
}

export interface MemoryStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const keyFor = (fromUri: string, toUri: string, intent: string): string =>
  `${fromUri} ${toUri} ${intent}`;

export class TransitionMemory {
  private entries = new Map<string, RememberedTransition>();
  private dirty = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly storage: MemoryStorage | null,
    private readonly key: string = MEMORY_STORAGE_KEY,
  ) {
    this.restore();
  }

  private restore(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.get(this.key);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { v?: number; entries?: RememberedTransition[] };
      if (!Array.isArray(parsed?.entries)) return;

      let dropped = 0;
      for (const e of parsed.entries) {
        // A decision made by an older algorithm is not worth serving.
        if (!e || e.algorithmVersion !== ALGORITHM_VERSION) {
          dropped++;
          continue;
        }
        this.entries.set(keyFor(e.fromUri, e.toUri, e.intent), e);
      }
      if (dropped > 0) {
        log.info(`discarded ${dropped} decisions from an earlier algorithm version`);
        this.dirty = true;
      }
      log.debug(`restored ${this.entries.size} remembered transitions`);
    } catch (err) {
      log.warn("transition memory unreadable — starting empty", err);
    }
  }

  recall(fromUri: string, toUri: string, intent: string): RememberedTransition | null {
    return this.entries.get(keyFor(fromUri, toUri, intent)) ?? null;
  }

  remember(plan: TransitionPlan, intent: string): void {
    if (!plan.to) return;
    const k = keyFor(plan.from.uri, plan.to.uri, intent);
    const previous = this.entries.get(k);

    const entry: RememberedTransition = {
      fromUri: plan.from.uri,
      toUri: plan.to.uri,
      score: plan.compatibility.overall,
      confidence: plan.musicalConfidence,
      band: plan.band,
      strategy: plan.strategy,
      durationSec: plan.durationSec,
      durationBeats: plan.durationBeats,
      executor: plan.executor,
      intent,
      algorithmVersion: ALGORITHM_VERSION,
      at: Date.now(),
      timesSeen: (previous?.timesSeen ?? 0) + 1,
    };

    // Refresh LRU position.
    this.entries.delete(k);
    this.entries.set(k, entry);
    while (this.entries.size > MEMORY_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.scheduleWrite();
  }

  /** Pairings seen more than once that keep scoring badly — the recurring problems. */
  recurringWeakPairs(limit = 5): RememberedTransition[] {
    return [...this.entries.values()]
      .filter((e) => e.timesSeen > 1 && e.score < 0.65)
      .sort((a, b) => a.score - b.score)
      .slice(0, limit);
  }

  size(): number {
    return this.entries.size;
  }

  private scheduleWrite(): void {
    this.dirty = true;
    if (!this.storage || this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 5000);
  }

  flush(): void {
    if (!this.storage || !this.dirty) return;
    try {
      this.storage.set(
        this.key,
        JSON.stringify({ v: ALGORITHM_VERSION, entries: [...this.entries.values()] }),
      );
      this.dirty = false;
    } catch (err) {
      log.warn("could not persist transition memory — halving it", err);
      const keep = [...this.entries.entries()].slice(-Math.floor(MEMORY_LIMIT / 2));
      this.entries = new Map(keep);
      try {
        this.storage.set(
          this.key,
          JSON.stringify({ v: ALGORITHM_VERSION, entries: keep.map(([, e]) => e) }),
        );
        this.dirty = false;
      } catch {
        log.error("transition memory disabled for this session — storage rejected the write");
        this.dirty = false;
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.dirty = true;
    this.flush();
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
  }

  dispose(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.flush();
  }
}
