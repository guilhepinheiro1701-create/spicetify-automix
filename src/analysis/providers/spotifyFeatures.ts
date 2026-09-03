/**
 * The Spotify client's internal *audio-features* service.
 *
 * `https://spclient.wg.spotify.com/audio-attributes/v1/audio-features/{id}`
 *
 * This is the internal twin of the public Web API's `/v1/audio-features`, which
 * was closed to new applications in November 2024. Spicetify's own bundled
 * lyrics-plus app calls this endpoint through Cosmos to read a track's tempo,
 * which is how we know it exists and still answers on current clients.
 *
 * It matters a great deal for transition quality: it returns Spotify's *real*
 * `energy`, `danceability` and `valence`, rather than the proxies we otherwise
 * have to rebuild from the raw segment data. Where it answers, those values are
 * used in preference to anything derived.
 *
 * It is undocumented internal API on an internal host and can be withdrawn in
 * any client update, so it is probed, counted, and abandoned if it dies.
 */

import { clamp01 } from "../../core/util.js";
import { InternalEndpoint } from "./internalEndpoint.js";
import type { AnalysisProvider } from "./types.js";
import type { TrackAnalysis, TrackRef } from "../../core/types.js";

/** The flat payload shape, mirroring the old public audio-features object. */
interface FeaturesPayload {
  danceability?: number;
  energy?: number;
  key?: number;
  loudness?: number;
  mode?: number;
  speechiness?: number;
  acousticness?: number;
  instrumentalness?: number;
  liveness?: number;
  valence?: number;
  tempo?: number;
  time_signature?: number;
  duration_ms?: number;
}

const unit = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;

const ranged = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined;

export function normalizeFeatures(
  payload: FeaturesPayload,
  track: TrackRef,
): TrackAnalysis | null {
  const tempo = ranged(payload.tempo, 40, 250);
  const energy = unit(payload.energy);
  const danceability = unit(payload.danceability);
  const valence = unit(payload.valence);
  const key = ranged(payload.key, 0, 11);
  const mode = payload.mode === 0 || payload.mode === 1 ? payload.mode : undefined;
  const loudness = ranged(payload.loudness, -60, 5);

  // A payload with none of the fields we care about is not worth caching.
  if (tempo === undefined && energy === undefined && key === undefined) return null;

  return {
    uri: track.uri,
    source: "spotify-features",
    // Spotify's own numbers, but with no beat grid or sections attached — so a
    // little below a full analysis, well above anything we derive ourselves.
    confidence: 0.8,
    fetchedAt: Date.now(),
    durationMs: ranged(payload.duration_ms, 1000, 3_600_000) ?? track.durationMs,
    tempo,
    tempoConfidence: tempo === undefined ? undefined : 0.85,
    timeSignature: ranged(payload.time_signature, 2, 12),
    key: key === undefined ? undefined : Math.round(key),
    mode,
    keyConfidence: key === undefined ? undefined : 0.8,
    loudness,
    energy,
    danceability,
    valence,
    acousticness: unit(payload.acousticness),
    instrumentalness: unit(payload.instrumentalness),
    // `liveness` and `speechiness` are read but only used as a guard: a spoken
    // -word or live recording is a poor candidate for a beat-locked mix.
    speechiness: unit(payload.speechiness),
    liveness: unit(payload.liveness),
    brightness: valence === undefined ? undefined : clamp01(valence),
    beats: [],
    bars: [],
    sections: [],
    sectionEnergy: [],
    grid: null,
  };
}

export class SpotifyFeaturesProvider implements AnalysisProvider {
  readonly id = "spotify-features";
  readonly label = "Spotify client audio features";

  readonly endpoint = new InternalEndpoint(
    "audio-features",
    (id) => `https://spclient.wg.spotify.com/audio-attributes/v1/audio-features/${id}?format=json`,
  );

  isAvailable(): boolean {
    return this.endpoint.isAlive;
  }

  async fetch(track: TrackRef): Promise<TrackAnalysis | null> {
    if (track.isLocal || !track.id) return null;
    const payload = await this.endpoint.fetch<FeaturesPayload>(track.id);
    return payload ? normalizeFeatures(payload, track) : null;
  }
}
