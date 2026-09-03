/**
 * Runtime capability detection.
 *
 * Every claim Smart DJ makes about what it can do is derived from this module,
 * which probes the live client instead of trusting documentation. The results
 * are shown verbatim in the debug panel so the user always knows which tier
 * they are actually running in.
 */

import { createLogger } from "../core/logger.js";
import { sp, canControlVolume, getProductTier, type ProductTier } from "./spicetify.js";
import { probeCrossfadeWritable, getCrossfadeState } from "./nativeCrossfade.js";

const log = createLogger("caps");

export type Availability = "available" | "partial" | "unavailable";

export interface Capability {
  id: string;
  label: string;
  status: Availability;
  detail: string;
}

export interface CapabilitySet {
  probedAt: number;
  productTier: ProductTier;

  /** Real audio overlap via Spotify's own mixer. */
  nativeCrossfade: Capability;
  /** Our own volume automation around a track change. */
  volumeAutomation: Capability;
  /** Track tempo/key/structure from the client's audio-attributes service. */
  audioAnalysis: Capability;
  /** Reading the upcoming track before it plays. */
  queueLookahead: Capability;
  /** Millisecond-accurate playback position. */
  preciseTiming: Capability;
  /** Changing playback rate to beatmatch. */
  tempoControl: Capability;
  /** Per-band EQ or filters on the Spotify stream. */
  audioDsp: Capability;
  /** Per-deck (independent) gain on the two overlapping tracks. */
  perTrackGain: Capability;

  /** Highest transition tier this client can actually deliver. */
  tier: "dj" | "fade" | "passive";
}

let cached: CapabilitySet | null = null;

const cap = (id: string, label: string, status: Availability, detail: string): Capability => ({
  id,
  label,
  status,
  detail,
});

export async function probeCapabilities(force = false): Promise<CapabilitySet> {
  if (cached && !force) return cached;

  const s = sp();
  const productTier = await getProductTier();

  // ── Native crossfade ────────────────────────────────────────────────────
  let crossfadeCap: Capability;
  const writable = await probeCrossfadeWritable().catch(() => false);
  const xf = getCrossfadeState();
  if (writable) {
    crossfadeCap = cap(
      "nativeCrossfade",
      "Real audio overlap (native crossfade)",
      "available",
      `writable via ${xf.via}${xf.verified ? ", read-back confirmed" : ", no read-back on this client"}`,
    );
  } else {
    crossfadeCap = cap(
      "nativeCrossfade",
      "Real audio overlap (native crossfade)",
      "unavailable",
      productTier === "free"
        ? "no write path accepted — recent clients gate crossfade behind Premium"
        : "no write path accepted on this client version",
    );
  }

  // ── Volume automation ───────────────────────────────────────────────────
  const volumeCap = canControlVolume()
    ? cap(
        "volumeAutomation",
        "Volume automation",
        "partial",
        "master volume only — Spotify exposes one fader, not per-track gain",
      )
    : cap("volumeAutomation", "Volume automation", "unavailable", "no setVolume on this client");

  // ── Audio analysis ──────────────────────────────────────────────────────
  let analysisCap: Capability;
  if (typeof s?.getAudioData === "function") {
    analysisCap = cap(
      "audioAnalysis",
      "Tempo / key / beat grid",
      "partial",
      "Spicetify.getAudioData present — per-track availability confirmed on first use",
    );
  } else {
    analysisCap = cap(
      "audioAnalysis",
      "Tempo / key / beat grid",
      "unavailable",
      "Spicetify.getAudioData missing on this client",
    );
  }

  // ── Queue lookahead ─────────────────────────────────────────────────────
  const hasQueue =
    Array.isArray(s?.Queue?.nextTracks) || Array.isArray(s?.Player?.data?.nextItems);
  const queueCap = hasQueue
    ? cap("queueLookahead", "Next-track lookahead", "available", "queue readable before playback")
    : cap(
        "queueLookahead",
        "Next-track lookahead",
        "unavailable",
        "neither Queue.nextTracks nor Player.data.nextItems present",
      );

  // ── Timing ──────────────────────────────────────────────────────────────
  const timingCap =
    typeof s?.Player?.getProgress === "function"
      ? cap(
          "preciseTiming",
          "Millisecond playback position",
          "available",
          "position is interpolated from the state timestamp, so it is exact between events",
        )
      : cap("preciseTiming", "Millisecond playback position", "unavailable", "no getProgress");

  // ── Tempo control (the honest 'no') ─────────────────────────────────────
  const setSpeed = s?.Platform?.PlayerAPI?.setSpeed;
  const tempoCap = cap(
    "tempoControl",
    "Playback-rate change (true beatmatching)",
    "unavailable",
    typeof setSpeed === "function"
      ? "PlayerAPI.setSpeed exists but applies to podcasts only — it is a no-op for music"
      : "no playback-rate API for music",
  );

  // ── DSP (the other honest 'no') ─────────────────────────────────────────
  const dspCap = cap(
    "audioDsp",
    "EQ / filters on the Spotify stream",
    "unavailable",
    "audio is decoded and mixed below the web layer; there is no media element to route through Web Audio",
  );

  const perTrackGainCap = cap(
    "perTrackGain",
    "Independent gain per overlapping track",
    "unavailable",
    "the native mixer owns both streams during a crossfade; only master volume is exposed",
  );

  const tier: CapabilitySet["tier"] =
    crossfadeCap.status === "available"
      ? "dj"
      : volumeCap.status !== "unavailable"
        ? "fade"
        : "passive";

  cached = {
    probedAt: Date.now(),
    productTier,
    nativeCrossfade: crossfadeCap,
    volumeAutomation: volumeCap,
    audioAnalysis: analysisCap,
    queueLookahead: queueCap,
    preciseTiming: timingCap,
    tempoControl: tempoCap,
    audioDsp: dspCap,
    perTrackGain: perTrackGainCap,
    tier,
  };

  log.info(`capabilities probed — tier "${tier}", account "${productTier}"`);
  return cached;
}

export function getCapabilities(): CapabilitySet | null {
  return cached;
}

export function allCapabilities(set: CapabilitySet): Capability[] {
  return [
    set.nativeCrossfade,
    set.volumeAutomation,
    set.audioAnalysis,
    set.queueLookahead,
    set.preciseTiming,
    set.tempoControl,
    set.audioDsp,
    set.perTrackGain,
  ];
}

export const statusIcon = (s: Availability): string =>
  s === "available" ? "✅" : s === "partial" ? "⚠️" : "❌";
