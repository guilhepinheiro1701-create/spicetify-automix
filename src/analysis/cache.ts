/**
 * Analysis cache.
 *
 * Analysing a track is the only expensive thing Smart DJ does, so it happens
 * once per track, ever. Two tiers:
 *
 *  - **Memory** keeps the full analysis, beat grid and all, for the handful of
 *    tracks around the playhead.
 *  - **Persistent** keeps a compact record — everything except the raw beat,
 *    bar and segment arrays, which are megabytes per hundred tracks and are
 *    only needed to derive the phrase grid and the section energies, both of
 *    which are stored instead.
 *
 * The persistent tier is written back debounced, so a long listening session
 * touches storage a handful of times rather than once per track.
 */

import { createLogger } from "../core/logger.js";
import type { TrackAnalysis } from "../core/types.js";
import { CACHE_STORAGE_KEY } from "../config/defaults.js";

const log = createLogger("cache");

export const MEMORY_LIMIT = 60;
export const PERSISTENT_LIMIT = 600;
const WRITE_DEBOUNCE_MS = 4000;

/**
 * How long a "nothing knows about this track" result stands before the
 * providers are asked again.
 *
 * Without this, a track the analysis services have no data for is re-queried
 * every single time it plays — a stream of 404s against internal endpoints for
 * an answer we already have. With it, the negative result is remembered like
 * any other, but not forever: Spotify does backfill analysis, so a week later
 * it is worth another try.
 */
export const NEGATIVE_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Fields dropped before persisting. */
type Heavy = "beats" | "bars" | "segments";
export type CompactAnalysis = Omit<TrackAnalysis, Heavy>;

export function compact(analysis: TrackAnalysis): CompactAnalysis {
  const { beats: _b, bars: _r, segments: _s, ...rest } = analysis as TrackAnalysis & {
    segments?: unknown;
  };
  return rest as CompactAnalysis;
}

export interface CacheStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

interface Persisted {
  v: 1;
  entries: [string, CompactAnalysis][];
}

export class AnalysisCache {
  private memory = new Map<string, TrackAnalysis>();
  private disk = new Map<string, CompactAnalysis>();
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(
    private readonly storage: CacheStorage | null,
    private readonly key: string = CACHE_STORAGE_KEY,
  ) {
    this.restore();
  }

  private restore(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.get(this.key);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Persisted;
      if (parsed?.v !== 1 || !Array.isArray(parsed.entries)) return;
      for (const [uri, entry] of parsed.entries) {
        if (typeof uri === "string" && entry && typeof entry === "object") {
          this.disk.set(uri, entry);
        }
      }
      log.debug(`restored ${this.disk.size} cached analyses`);
    } catch (err) {
      log.warn("cache restore failed — starting empty", err);
    }
  }

  get(uri: string): TrackAnalysis | null {
    const hot = this.memory.get(uri);
    if (hot) {
      // Refresh LRU position.
      this.memory.delete(uri);
      this.memory.set(uri, hot);
      return hot;
    }
    const cold = this.disk.get(uri);
    if (!cold) return null;
    if (this.isStaleNegative(cold)) {
      this.disk.delete(uri);
      this.dirty = true;
      return null;
    }
    return cold as TrackAnalysis;
  }

  /** A remembered "no data" result that has aged out and deserves another try. */
  private isStaleNegative(entry: CompactAnalysis): boolean {
    return (
      entry.source === "heuristic" && Date.now() - (entry.fetchedAt ?? 0) > NEGATIVE_RESULT_TTL_MS
    );
  }

  has(uri: string): boolean {
    if (this.memory.has(uri)) return true;
    const cold = this.disk.get(uri);
    return cold !== undefined && !this.isStaleNegative(cold);
  }

  set(uri: string, analysis: TrackAnalysis): void {
    this.memory.set(uri, analysis);
    while (this.memory.size > MEMORY_LIMIT) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }

    // A heuristic result means every provider came back empty. That is worth
    // remembering — otherwise the same track re-queries the internal endpoints
    // every time it plays, for an answer we already have. It is remembered with
    // a TTL rather than permanently, because Spotify does backfill analysis.
    if (analysis.source === "none") return;

    this.disk.delete(uri);
    this.disk.set(uri, compact(analysis));
    while (this.disk.size > PERSISTENT_LIMIT) {
      const oldest = this.disk.keys().next().value;
      if (oldest === undefined) break;
      this.disk.delete(oldest);
    }
    this.scheduleWrite();
  }

  private scheduleWrite(): void {
    this.dirty = true;
    if (!this.storage || this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, WRITE_DEBOUNCE_MS);
  }

  flush(): void {
    if (!this.storage || !this.dirty) return;
    try {
      const payload: Persisted = { v: 1, entries: [...this.disk.entries()] };
      this.storage.set(this.key, JSON.stringify(payload));
      this.dirty = false;
      log.debug(`flushed ${this.disk.size} entries`);
    } catch (err) {
      // Storage full is the common case: halve the cache and try once more.
      log.warn("cache flush failed, trimming", err);
      const keep = [...this.disk.entries()].slice(-Math.floor(PERSISTENT_LIMIT / 2));
      this.disk = new Map(keep);
      try {
        this.storage.set(this.key, JSON.stringify({ v: 1, entries: keep } satisfies Persisted));
        this.dirty = false;
      } catch {
        log.error("cache disabled for this session — storage rejected the write");
        this.dirty = false;
      }
    }
  }

  clear(): void {
    this.memory.clear();
    this.disk.clear();
    this.dirty = true;
    this.flush();
  }

  /** Flush and stop, leaving no timer running against a discarded cache. */
  dispose(): void {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.flush();
  }

  stats(): { memory: number; persistent: number } {
    return { memory: this.memory.size, persistent: this.disk.size };
  }
}
