/**
 * User-supplied overrides.
 *
 * Highest priority of all providers: if you have told Smart DJ that a track is
 * 128 BPM in A minor, that is what it is. Useful for local files, for tracks
 * the analysis service has never heard of, and for correcting the occasional
 * half-time tempo reading.
 *
 * Stored locally; never sent anywhere.
 */

import { createLogger } from "../../core/logger.js";
import type { AnalysisProvider } from "./types.js";
import type { TrackAnalysis, TrackRef } from "../../core/types.js";
import type { CacheStorage } from "../cache.js";

const log = createLogger("provider:manual");
const STORAGE_KEY = "smart-dj:overrides:v1";

export interface TrackOverride {
  tempo?: number;
  key?: number;
  mode?: number;
  energy?: number;
  loudness?: number;
  timeSignature?: number;
}

export class ManualProvider implements AnalysisProvider {
  readonly id = "manual";
  readonly label = "Manual overrides";
  private overrides = new Map<string, TrackOverride>();

  constructor(private readonly storage: CacheStorage | null) {
    this.restore();
  }

  private restore(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.get(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, TrackOverride>;
      for (const [uri, o] of Object.entries(parsed ?? {})) {
        if (o && typeof o === "object") this.overrides.set(uri, o);
      }
    } catch (err) {
      log.warn("overrides unreadable", err);
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.set(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.overrides)));
    } catch (err) {
      log.warn("could not persist overrides", err);
    }
  }

  set(uri: string, override: TrackOverride | null): void {
    if (override === null) this.overrides.delete(uri);
    else this.overrides.set(uri, override);
    this.persist();
  }

  getOverride(uri: string): TrackOverride | null {
    return this.overrides.get(uri) ?? null;
  }

  size(): number {
    return this.overrides.size;
  }

  isAvailable(): boolean {
    return this.overrides.size > 0;
  }

  async fetch(track: TrackRef): Promise<TrackAnalysis | null> {
    const o = this.overrides.get(track.uri);
    if (!o) return null;
    return {
      uri: track.uri,
      source: "manual",
      confidence: 0.95,
      fetchedAt: Date.now(),
      durationMs: track.durationMs,
      tempo: o.tempo,
      tempoConfidence: o.tempo === undefined ? undefined : 1,
      key: o.key,
      mode: o.mode,
      keyConfidence: o.key === undefined ? undefined : 1,
      energy: o.energy,
      loudness: o.loudness,
      timeSignature: o.timeSignature ?? 4,
      beats: [],
      bars: [],
      sections: [],
      sectionEnergy: [],
      grid: null,
    };
  }
}
