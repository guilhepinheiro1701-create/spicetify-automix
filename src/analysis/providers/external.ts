/**
 * Optional third-party analysis provider.
 *
 * Off by default and off unless you paste in an HTTPS endpoint yourself.
 * Nothing in Smart DJ requires it; it exists because Spotify's own analysis has
 * gaps and some people already run a local or self-hosted service that can fill
 * them (a MusicBrainz/AcousticBrainz mirror, a small Essentia service, a
 * personal library index).
 *
 * What is sent, exactly: one HTTPS GET with the track's Spotify id, title and
 * artist as query parameters. Nothing else. No listening history, no account
 * identifier, no audio.
 *
 * This deliberately uses the browser's own `fetch` and **not**
 * `Spicetify.CosmosAsync`. CosmosAsync attaches the client's session token to
 * every request it makes, so pointing it at a third-party host would hand that
 * host the user's Spotify session. `fetch` sends no Spotify credentials.
 */

import { createLogger } from "../../core/logger.js";
import { clamp01 } from "../../core/util.js";
import type { AnalysisProvider } from "./types.js";
import type { TrackAnalysis, TrackRef } from "../../core/types.js";

const log = createLogger("provider:external");
const TIMEOUT_MS = 4000;

/** The shape a custom endpoint must answer with. All fields optional. */
export interface ExternalPayload {
  tempo?: number;
  bpm?: number;
  key?: number;
  mode?: number;
  energy?: number;
  loudness?: number;
  time_signature?: number;
  timeSignature?: number;
}

export interface ExternalConfig {
  enabled: boolean;
  /** e.g. "https://localhost:8080/analysis" — receives ?id=&title=&artist= */
  url: string;
}

export class ExternalProvider implements AnalysisProvider {
  readonly id = "external";
  readonly label = "Custom analysis endpoint";
  private config: ExternalConfig = { enabled: false, url: "" };
  private failures = 0;

  configure(config: ExternalConfig): void {
    const changed = config.url !== this.config.url || config.enabled !== this.config.enabled;
    this.config = config;
    if (changed) this.failures = 0;
  }

  isAvailable(): boolean {
    return (
      this.config.enabled &&
      this.config.url.startsWith("https://") &&
      this.failures < 5 &&
      typeof fetch === "function"
    );
  }

  async fetch(track: TrackRef): Promise<TrackAnalysis | null> {
    if (!this.isAvailable() || !track.id) return null;

    const url = new URL(this.config.url);
    url.searchParams.set("id", track.id);
    url.searchParams.set("title", track.name);
    url.searchParams.set("artist", track.artists[0] ?? "");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await globalThis.fetch(url.toString(), {
        signal: controller.signal,
        // No cookies, no Spotify token, no referrer.
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as ExternalPayload;
      this.failures = 0;
      return this.normalize(payload, track);
    } catch (err) {
      this.failures++;
      log.debug(`external provider failed (${this.failures}/5)`, (err as Error)?.message ?? err);
      if (this.failures >= 5) log.warn("external provider disabled after 5 failures");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private normalize(p: ExternalPayload, track: TrackRef): TrackAnalysis | null {
    const tempo = numeric(p.tempo ?? p.bpm, 40, 250);
    const key = Number.isInteger(p.key) && (p.key as number) >= 0 && (p.key as number) <= 11 ? p.key : undefined;
    const mode = p.mode === 0 || p.mode === 1 ? p.mode : undefined;
    const energy = p.energy === undefined ? undefined : clamp01(p.energy);
    const loudness = numeric(p.loudness, -60, 5);

    if (tempo === undefined && key === undefined && energy === undefined) return null;

    return {
      uri: track.uri,
      source: "external",
      confidence: 0.6,
      fetchedAt: Date.now(),
      durationMs: track.durationMs,
      tempo,
      tempoConfidence: tempo === undefined ? undefined : 0.6,
      key,
      mode,
      energy,
      loudness,
      timeSignature: numeric(p.time_signature ?? p.timeSignature, 2, 12) ?? 4,
      beats: [],
      bars: [],
      sections: [],
      sectionEnergy: [],
      grid: null,
    };
  }
}

function numeric(v: unknown, lo: number, hi: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return v >= lo && v <= hi ? v : undefined;
}
