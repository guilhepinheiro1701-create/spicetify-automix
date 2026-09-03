/**
 * The Spotify desktop client's own audio-attributes service.
 *
 * `Spicetify.getAudioData()` calls
 * `https://spclient.wg.spotify.com/audio-attributes/v1/audio-analysis/{id}`
 * through Cosmos, using the client's internal session rather than a developer
 * app token. This is a different door from the public Web API's
 * `/v1/audio-analysis`, which was closed to new applications in November 2024 —
 * which is why this still works where a third-party app would get a 403.
 *
 * It is undocumented internal API. It can disappear in any client update, and
 * it has no data at all for many tracks (local files always, long tail often).
 * Everything downstream treats a null from here as normal, not as an error.
 */

import { createLogger } from "../../core/logger.js";
import { sp } from "../../platform/spicetify.js";
import { deriveFeatures, type RawInterval, type RawSegment } from "../features.js";
import type { AnalysisProvider } from "./types.js";
import type { Section, TrackAnalysis, TrackRef } from "../../core/types.js";

const log = createLogger("provider:spotify");

interface RawAnalysis {
  track?: {
    duration?: number;
    tempo?: number;
    tempo_confidence?: number;
    time_signature?: number;
    time_signature_confidence?: number;
    key?: number;
    mode?: number;
    key_confidence?: number;
    loudness?: number;
    end_of_fade_in?: number;
    start_of_fade_out?: number;
  };
  beats?: RawInterval[];
  bars?: RawInterval[];
  sections?: (RawInterval & {
    loudness?: number;
    tempo?: number;
    key?: number;
    mode?: number;
    time_signature?: number;
  })[];
  segments?: RawSegment[];
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const intervals = (v: unknown): RawInterval[] =>
  Array.isArray(v)
    ? v
        .filter((i): i is RawInterval => typeof i?.start === "number" && typeof i?.duration === "number")
        .map((i) => ({ start: i.start, duration: i.duration, confidence: num(i.confidence) ?? 0.5 }))
    : [];

export function normalizeRawAnalysis(raw: RawAnalysis, track: TrackRef): TrackAnalysis | null {
  const t = raw?.track;
  if (!t) return null;

  const beats = intervals(raw.beats);
  const bars = intervals(raw.bars);
  const segments = Array.isArray(raw.segments) ? raw.segments : [];

  const sections: Section[] = Array.isArray(raw.sections)
    ? raw.sections
        .filter((s) => typeof s?.start === "number" && typeof s?.duration === "number")
        .map((s) => ({
          start: s.start,
          duration: s.duration,
          confidence: num(s.confidence) ?? 0.5,
          loudness: num(s.loudness) ?? -20,
          tempo: num(s.tempo) ?? num(t.tempo) ?? 120,
          key: num(s.key) ?? -1,
          mode: num(s.mode) ?? -1,
          timeSignature: num(s.time_signature) ?? num(t.time_signature) ?? 4,
        }))
    : [];

  const tempo = num(t.tempo);
  const loudness = num(t.loudness);
  const derived = deriveFeatures(segments, beats, sections, tempo, loudness);

  // Confidence reflects how much the service actually knew about this track.
  const parts = [
    tempo !== undefined ? 1 : 0,
    beats.length > 16 ? 1 : 0,
    sections.length > 1 ? 1 : 0,
    segments.length > 32 ? 1 : 0,
    num(t.key) !== undefined && (num(t.key) as number) >= 0 ? 1 : 0,
  ];
  const coverage = parts.reduce((a, b) => a + b, 0) / parts.length;
  const tempoConf = num(t.tempo_confidence) ?? 0.5;
  const confidence = Math.max(0.15, Math.min(1, coverage * 0.7 + tempoConf * 0.3));

  const rawKey = num(t.key);
  const rawMode = num(t.mode);

  return {
    uri: track.uri,
    source: "spotify-internal",
    confidence,
    fetchedAt: Date.now(),
    durationMs: (num(t.duration) ?? 0) * 1000 || track.durationMs,
    tempo,
    tempoConfidence: tempoConf,
    timeSignature: num(t.time_signature),
    key: rawKey !== undefined && rawKey >= 0 ? rawKey : undefined,
    mode: rawMode === 0 || rawMode === 1 ? rawMode : undefined,
    keyConfidence: num(t.key_confidence),
    loudness,
    energy: derived.energy,
    brightness: derived.brightness,
    pulseStrength: derived.pulseStrength,
    endOfFadeIn: num(t.end_of_fade_in),
    startOfFadeOut: num(t.start_of_fade_out),
    beats,
    bars,
    sections,
    sectionEnergy: derived.sectionEnergy,
  };
}

export class SpotifyInternalProvider implements AnalysisProvider {
  readonly id = "spotify-internal";
  readonly label = "Spotify client audio analysis";

  /** Set once the endpoint has failed in a way that says it is simply gone. */
  private endpointDead = false;
  private consecutiveFailures = 0;

  isAvailable(): boolean {
    return !this.endpointDead && typeof sp()?.getAudioData === "function";
  }

  async fetch(track: TrackRef): Promise<TrackAnalysis | null> {
    if (!this.isAvailable()) return null;
    // Local files never have server-side analysis.
    if (track.isLocal || !track.id) return null;

    try {
      const raw = (await sp().getAudioData(track.uri)) as RawAnalysis;
      const normalized = normalizeRawAnalysis(raw, track);
      if (normalized) {
        this.consecutiveFailures = 0;
        return normalized;
      }
      return null;
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      this.consecutiveFailures++;
      log.debug(`no analysis for ${track.name}: ${message}`);

      // A handful of 404s is normal — plenty of tracks simply have no analysis.
      // A long unbroken run means the endpoint itself went away, so stop asking.
      if (this.consecutiveFailures >= 12) {
        this.endpointDead = true;
        log.warn(
          "audio-attributes endpoint failed 12 times in a row — disabling it for this session",
        );
      }
      return null;
    }
  }

  reset(): void {
    this.endpointDead = false;
    this.consecutiveFailures = 0;
  }
}
