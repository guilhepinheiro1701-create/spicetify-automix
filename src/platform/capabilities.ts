/**
 * The capability layer.
 *
 * Every claim Smart DJ makes about what it can do is derived from this one
 * object, which probes the live client rather than trusting documentation. No
 * module anywhere else is allowed to test for an API directly — they ask here.
 *
 * That indirection is the whole point. Spotify's internals change without
 * notice; when something disappears, exactly one file needs to notice, and
 * every downstream decision degrades on its own.
 *
 * Each capability carries a machine-readable `reason` when it is unavailable,
 * so the UI can answer "why wasn't that used?" with the truth instead of silence.
 */

import { createLogger } from "../core/logger.js";
import { sp, canControlVolume, canMutateQueue, getProductTier, type ProductTier } from "./spicetify.js";
import { probeCrossfadeWritable, getCrossfadeState } from "./nativeCrossfade.js";

const log = createLogger("caps");

export type Availability = "available" | "partial" | "unavailable";

/**
 * Why a capability is not available. These are stable identifiers the UI and
 * the tests both key off, so a future change cannot quietly alter the meaning.
 */
export type UnavailableReason =
  | "dsp-unavailable" // audio is mixed below the web layer; no hook exists
  | "playback-rate-unavailable" // no rate control for music
  | "crossfade-not-writable" // client refused every write path
  | "crossfade-premium-gated" // as above, and the account is Free
  | "single-fader-only" // one master volume, not per-track
  | "endpoint-missing" // the internal service is not present
  | "endpoint-dead" // it was present and stopped answering
  | "api-missing" // the Spicetify/Platform call is not there
  | "context-tracks-immutable" // playlist entries cannot be reordered
  | "not-applicable"; // meaningless in the current configuration

export interface Capability {
  id: CapabilityId;
  label: string;
  status: Availability;
  /** Present whenever status is not "available". */
  reason: UnavailableReason | null;
  /** Human-readable, shown verbatim in the UI. */
  detail: string;
}

export type CapabilityId =
  | "audioAnalysis"
  | "audioFeatures"
  | "crossfade"
  | "volumeControl"
  | "queueRead"
  | "queueWrite"
  | "preciseTiming"
  | "playbackRate"
  | "dsp"
  | "perTrackGain";

/**
 * The flat, boolean view the rest of the code reasons about. Anything that is
 * merely "partial" reads as available here — partial means "works, with a
 * documented caveat", not "might not work".
 */
export interface CapabilityFlags {
  audioAnalysis: boolean;
  audioFeatures: boolean;
  crossfade: boolean;
  volumeControl: boolean;
  queueRead: boolean;
  queueWrite: boolean;
  preciseTiming: boolean;
  playbackRate: boolean;
  dsp: boolean;
  perTrackGain: boolean;
}

/** Highest transition tier the client can actually deliver. */
export type CapabilityTier = "dj" | "fade" | "passive";

export interface CapabilitySet {
  probedAt: number;
  productTier: ProductTier;
  spicetifyVersion: string | null;
  spotifyVersion: string | null;
  platform: string | null;

  capabilities: Record<CapabilityId, Capability>;
  flags: CapabilityFlags;
  tier: CapabilityTier;
}

let cached: CapabilitySet | null = null;

const cap = (
  id: CapabilityId,
  label: string,
  status: Availability,
  reason: UnavailableReason | null,
  detail: string,
): Capability => ({ id, label, status, reason, detail });

/** Read version strings for the compatibility report. Never throws. */
function readVersions(): Pick<CapabilitySet, "spicetifyVersion" | "spotifyVersion" | "platform"> {
  const s = sp();
  const pick = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  return {
    spicetifyVersion: pick(s?.Config?.version) ?? pick(s?.version),
    spotifyVersion: pick(s?.Platform?.PlatformData?.client_version_triple) ??
      pick(s?.Platform?.PlatformData?.version),
    platform: pick(s?.Platform?.PlatformData?.os_name),
  };
}

export async function probeCapabilities(force = false): Promise<CapabilitySet> {
  if (cached && !force) return cached;

  const s = sp();
  const productTier = await getProductTier();

  // ── Analysis services ───────────────────────────────────────────────────
  const analysis =
    typeof s?.getAudioData === "function"
      ? cap(
          "audioAnalysis",
          "Beat grid, bars and sections",
          "partial",
          null,
          "Spicetify.getAudioData present — per-track availability confirmed on first use",
        )
      : cap(
          "audioAnalysis",
          "Beat grid, bars and sections",
          "unavailable",
          "api-missing",
          "Spicetify.getAudioData is not present on this client",
        );

  // The features service is reached through Cosmos, so its presence is the
  // presence of Cosmos; whether it answers is discovered on first use.
  const features =
    typeof s?.CosmosAsync?.get === "function"
      ? cap(
          "audioFeatures",
          "Energy, valence and danceability",
          "partial",
          null,
          "internal audio-features service reachable — per-track availability confirmed on first use",
        )
      : cap(
          "audioFeatures",
          "Energy, valence and danceability",
          "unavailable",
          "api-missing",
          "CosmosAsync is not present, so the internal service cannot be reached",
        );

  // ── Crossfade ───────────────────────────────────────────────────────────
  const writable = await probeCrossfadeWritable().catch(() => false);
  const xf = getCrossfadeState();
  const crossfade = writable
    ? cap(
        "crossfade",
        "Real audio overlap",
        "available",
        null,
        `writable via ${xf.via}${xf.verified ? ", read-back confirmed" : ", no read-back on this client"}`,
      )
    : cap(
        "crossfade",
        "Real audio overlap",
        "unavailable",
        productTier === "free" ? "crossfade-premium-gated" : "crossfade-not-writable",
        productTier === "free"
          ? "no write path accepted — recent clients gate crossfade behind Premium"
          : "no write path accepted on this client version",
      );

  // ── Playback control ────────────────────────────────────────────────────
  const volume = canControlVolume()
    ? cap(
        "volumeControl",
        "Volume automation",
        "partial",
        "single-fader-only",
        "master volume only — Spotify exposes one fader, not per-track gain",
      )
    : cap(
        "volumeControl",
        "Volume automation",
        "unavailable",
        "api-missing",
        "no setVolume on this client",
      );

  const timing =
    typeof s?.Player?.getProgress === "function"
      ? cap(
          "preciseTiming",
          "Millisecond playback position",
          "available",
          null,
          "position is interpolated from the state timestamp, so it is exact between events",
        )
      : cap(
          "preciseTiming",
          "Millisecond playback position",
          "unavailable",
          "api-missing",
          "Player.getProgress is not present",
        );

  // ── Queue ───────────────────────────────────────────────────────────────
  const hasQueue =
    Array.isArray(s?.Queue?.nextTracks) || Array.isArray(s?.Player?.data?.nextItems);
  const queueRead = hasQueue
    ? cap("queueRead", "Next-track lookahead", "available", null, "queue readable before playback")
    : cap(
        "queueRead",
        "Next-track lookahead",
        "unavailable",
        "api-missing",
        "neither Queue.nextTracks nor Player.data.nextItems is present",
      );

  const queueWrite = canMutateQueue()
    ? cap(
        "queueWrite",
        "Queue reordering",
        "partial",
        "context-tracks-immutable",
        "only entries you queued yourself can be moved; playlist order cannot be changed without duplicating tracks",
      )
    : cap(
        "queueWrite",
        "Queue reordering",
        "unavailable",
        "api-missing",
        "this client exposes no queue mutation calls",
      );

  // ── The permanent noes ──────────────────────────────────────────────────
  const setSpeed = s?.Platform?.PlayerAPI?.setSpeed;
  const playbackRate = cap(
    "playbackRate",
    "Playback-rate change (true beatmatching)",
    "unavailable",
    "playback-rate-unavailable",
    typeof setSpeed === "function"
      ? "PlayerAPI.setSpeed exists but applies to podcasts only — it is a no-op for music"
      : "no playback-rate API for music",
  );

  const dsp = cap(
    "dsp",
    "EQ, filters and effects on the stream",
    "unavailable",
    "dsp-unavailable",
    "audio is decoded and mixed below the web layer; there is no media element to route through Web Audio",
  );

  const perTrackGain = cap(
    "perTrackGain",
    "Independent gain per overlapping track",
    "unavailable",
    "single-fader-only",
    "the native mixer owns both streams during a crossfade; only master volume is exposed",
  );

  const capabilities: Record<CapabilityId, Capability> = {
    audioAnalysis: analysis,
    audioFeatures: features,
    crossfade,
    volumeControl: volume,
    queueRead,
    queueWrite,
    preciseTiming: timing,
    playbackRate,
    dsp,
    perTrackGain,
  };

  const flags = Object.fromEntries(
    (Object.keys(capabilities) as CapabilityId[]).map((id) => [
      id,
      (capabilities[id] as Capability).status !== "unavailable",
    ]),
  ) as unknown as CapabilityFlags;

  const tier: CapabilityTier = flags.crossfade ? "dj" : flags.volumeControl ? "fade" : "passive";

  cached = {
    probedAt: Date.now(),
    productTier,
    ...readVersions(),
    capabilities,
    flags,
    tier,
  };

  log.info(
    `capabilities probed — tier "${tier}", account "${productTier}", ` +
      `${Object.values(flags).filter(Boolean).length}/${Object.keys(flags).length} available`,
  );
  return cached;
}

export function getCapabilities(): CapabilitySet | null {
  return cached;
}

/** Reset the cache. Used by tests and by a manual re-probe from the panel. */
export function resetCapabilities(): void {
  cached = null;
}

export function allCapabilities(set: CapabilitySet): Capability[] {
  return Object.values(set.capabilities);
}

export const statusIcon = (s: Availability): string =>
  s === "available" ? "✅" : s === "partial" ? "⚠️" : "❌";

/**
 * Plain-language explanation of why a feature was not used. This is what the
 * debug panel's "why not?" answers come from, so a future change cannot
 * silently start claiming something is available when it is not.
 */
export const REASON_TEXT: Record<UnavailableReason, string> = {
  "dsp-unavailable": "no DSP hook exists — Spotify's audio never reaches the web layer",
  "playback-rate-unavailable": "the client exposes no playback-rate control for music",
  "crossfade-not-writable": "this client refused every crossfade write path",
  "crossfade-premium-gated":
    "this client refused every crossfade write path — recent builds gate crossfade behind Premium",
  "single-fader-only": "Spotify exposes one master fader, not per-track gain",
  "endpoint-missing": "the internal service is not present on this client",
  "endpoint-dead": "the internal service stopped answering and was disabled for this session",
  "api-missing": "the required API is not present on this client version",
  "context-tracks-immutable":
    "playlist entries cannot be reordered without duplicating them; only tracks you queued yourself can move",
  "not-applicable": "not meaningful in this configuration",
};

export function explainUnavailable(c: Capability): string {
  if (c.status === "available") return "available";
  return c.reason ? REASON_TEXT[c.reason] : c.detail;
}
