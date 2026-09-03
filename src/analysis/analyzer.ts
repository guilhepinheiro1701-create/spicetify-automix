/**
 * Music Analyzer.
 *
 * Resolves one normalized `TrackAnalysis` per track by walking a priority chain
 * of providers and merging what each one knows. Results are cached, in-flight
 * requests are deduplicated, and a track is never analysed twice.
 *
 * Priority: manual overrides → Spotify's own analysis → optional custom
 * endpoint → duration heuristics. Later providers only fill gaps; they never
 * overwrite a higher-priority field.
 */

import { createLogger } from "../core/logger.js";
import { clamp01 } from "../core/util.js";
import type { TrackAnalysis, TrackRef } from "../core/types.js";
import { AnalysisCache, type CacheStorage } from "./cache.js";
import { buildPhraseGrid } from "./structure.js";
import { HeuristicProvider } from "./providers/heuristic.js";
import { ManualProvider, type TrackOverride } from "./providers/manual.js";
import { SpotifyInternalProvider } from "./providers/spotifyInternal.js";
import { ExternalProvider, type ExternalConfig } from "./providers/external.js";
import type { AnalysisProvider, ProviderHealth } from "./providers/types.js";

const log = createLogger("analyzer");

/** Merge `patch` into `base`, filling only fields `base` does not already have. */
export function mergeAnalysis(base: TrackAnalysis, patch: TrackAnalysis): TrackAnalysis {
  const out: TrackAnalysis = { ...base };
  const fill = <K extends keyof TrackAnalysis>(k: K) => {
    if (out[k] === undefined || out[k] === null) {
      const v = patch[k];
      if (v !== undefined && v !== null) out[k] = v;
    }
  };

  (
    [
      "tempo",
      "tempoConfidence",
      "timeSignature",
      "key",
      "mode",
      "keyConfidence",
      "loudness",
      "energy",
      "brightness",
      "pulseStrength",
      "endOfFadeIn",
      "startOfFadeOut",
    ] as (keyof TrackAnalysis)[]
  ).forEach(fill);

  const emptyArray = (v: unknown): boolean => !Array.isArray(v) || v.length === 0;
  if (emptyArray(out.beats) && !emptyArray(patch.beats)) out.beats = patch.beats;
  if (emptyArray(out.bars) && !emptyArray(patch.bars)) out.bars = patch.bars;
  if (emptyArray(out.sections) && !emptyArray(patch.sections)) {
    out.sections = patch.sections;
    out.sectionEnergy = patch.sectionEnergy;
  }
  if (!out.durationMs && patch.durationMs) out.durationMs = patch.durationMs;

  // Confidence is dominated by the richer source but nudged by agreement.
  out.confidence = clamp01(Math.max(base.confidence, patch.confidence * 0.8));
  return out;
}

export interface AnalyzerOptions {
  storage: CacheStorage | null;
}

export class MusicAnalyzer {
  readonly cache: AnalysisCache;
  readonly manual: ManualProvider;
  readonly spotify: SpotifyInternalProvider;
  readonly external: ExternalProvider;
  private readonly heuristic: HeuristicProvider;
  private readonly chain: AnalysisProvider[];

  private inflight = new Map<string, Promise<TrackAnalysis>>();
  private health = new Map<string, ProviderHealth>();

  constructor(options: AnalyzerOptions) {
    this.cache = new AnalysisCache(options.storage);
    this.manual = new ManualProvider(options.storage);
    this.spotify = new SpotifyInternalProvider();
    this.external = new ExternalProvider();
    this.heuristic = new HeuristicProvider();
    this.chain = [this.manual, this.spotify, this.external, this.heuristic];
    for (const p of this.chain) {
      this.health.set(p.id, { id: p.id, attempts: 0, hits: 0, failures: 0, lastError: null });
    }
  }

  configureExternal(config: ExternalConfig): void {
    this.external.configure(config);
  }

  setOverride(uri: string, override: TrackOverride | null): void {
    this.manual.set(uri, override);
    // Force a re-resolve for this track on next use.
    this.inflight.delete(uri);
  }

  getHealth(): ProviderHealth[] {
    return [...this.health.values()];
  }

  /** Cached analysis if we already have it, without triggering a fetch. */
  peek(uri: string): TrackAnalysis | null {
    return this.cache.get(uri);
  }

  async analyze(track: TrackRef | null): Promise<TrackAnalysis | null> {
    if (!track) return null;

    const cached = this.cache.get(track.uri);
    if (cached) return cached;

    const pending = this.inflight.get(track.uri);
    if (pending) return pending;

    const job = this.resolve(track).finally(() => this.inflight.delete(track.uri));
    this.inflight.set(track.uri, job);
    return job;
  }

  private async resolve(track: TrackRef): Promise<TrackAnalysis> {
    let result: TrackAnalysis | null = null;

    for (const provider of this.chain) {
      // Once we have a tempo *and* a beat grid there is nothing left to gain.
      if (result?.tempo !== undefined && (result.beats?.length ?? 0) > 16) break;
      if (!provider.isAvailable() && provider.id !== "heuristic") continue;

      const stat = this.health.get(provider.id);
      if (stat) stat.attempts++;

      try {
        const partial = await provider.fetch(track);
        if (!partial) continue;
        if (stat) stat.hits++;
        result = result ? mergeAnalysis(result, partial) : partial;
      } catch (err) {
        if (stat) {
          stat.failures++;
          stat.lastError = String((err as Error)?.message ?? err);
        }
        log.debug(`provider ${provider.id} threw`, err);
      }
    }

    // The heuristic provider cannot fail, so this is defensive only.
    const analysis = result ?? (await this.heuristic.fetch(track));
    analysis.grid = buildPhraseGrid(analysis);

    this.cache.set(track.uri, analysis);
    log.debug(
      `analysed "${track.name}" via ${analysis.source} — ` +
        `${analysis.tempo ? `${analysis.tempo.toFixed(1)} BPM` : "no tempo"}, ` +
        `confidence ${analysis.confidence.toFixed(2)}`,
    );
    return analysis;
  }

  /** Warm the cache for upcoming tracks without blocking anything. */
  prefetch(tracks: readonly TrackRef[]): void {
    for (const t of tracks) {
      if (this.cache.has(t.uri) || this.inflight.has(t.uri)) continue;
      void this.analyze(t).catch(() => undefined);
    }
  }

  dispose(): void {
    this.cache.flush();
    this.inflight.clear();
  }
}
