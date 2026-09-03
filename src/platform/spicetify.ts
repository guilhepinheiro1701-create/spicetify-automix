/**
 * Typed, defensive façade over the `Spicetify` global.
 *
 * Spicetify's own type definitions declare `Spicetify.Platform` as `any` and
 * explicitly warn that the shape changes between Spotify client versions.
 * Nothing in this file assumes an API exists: every accessor probes first and
 * returns `null`/`false` rather than throwing.
 */

import { createLogger } from "../core/logger.js";
import { trackIdFromUri } from "../core/util.js";
import type { TrackRef } from "../core/types.js";

const log = createLogger("platform");

// The global is injected by the Spotify client at runtime.
declare const Spicetify: any;

export const sp = (): any => (typeof Spicetify === "undefined" ? undefined : Spicetify);

export function isReady(): boolean {
  const s = sp();
  return Boolean(s?.Player?.data !== undefined && s?.Platform && s?.CosmosAsync && s?.URI);
}

/** Resolve when the client has finished wiring up the APIs we need. */
export function waitForSpicetify(timeoutMs = 30_000): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (isReady()) return resolve(true);
      if (Date.now() - started > timeoutMs) {
        log.error("Spicetify APIs never became ready");
        return resolve(false);
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Playback state
// ─────────────────────────────────────────────────────────────────────────────

export function getProgressMs(): number {
  try {
    return sp()?.Player?.getProgress?.() ?? 0;
  } catch {
    return 0;
  }
}

export function getDurationMs(): number {
  try {
    return sp()?.Player?.getDuration?.() ?? 0;
  } catch {
    return 0;
  }
}

export function isPlaying(): boolean {
  try {
    return Boolean(sp()?.Player?.isPlaying?.());
  } catch {
    return false;
  }
}

export function getRepeatMode(): number {
  try {
    return sp()?.Player?.getRepeat?.() ?? 0;
  } catch {
    return 0;
  }
}

export function next(): boolean {
  try {
    sp()?.Player?.next?.();
    return true;
  } catch (err) {
    log.error("Player.next() failed", err);
    return false;
  }
}

export function seekMs(ms: number): boolean {
  try {
    sp()?.Player?.seek?.(Math.max(0, Math.round(ms)));
    return true;
  } catch (err) {
    log.warn("Player.seek() failed", err);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Volume
// ─────────────────────────────────────────────────────────────────────────────

export function getVolume(): number {
  try {
    const v = sp()?.Player?.getVolume?.();
    return typeof v === "number" && Number.isFinite(v) ? v : 1;
  } catch {
    return 1;
  }
}

export function setVolume(v: number): boolean {
  const level = Math.max(0, Math.min(1, v));
  try {
    // Prefer the Platform API directly: it is what Spicetify.Player.setVolume
    // wraps, and it avoids an extra layer that some client builds omit.
    const playback = sp()?.Platform?.PlaybackAPI;
    if (typeof playback?.setVolume === "function") {
      playback.setVolume(level);
      return true;
    }
    if (typeof sp()?.Player?.setVolume === "function") {
      sp().Player.setVolume(level);
      return true;
    }
  } catch (err) {
    log.warn("setVolume failed", err);
  }
  return false;
}

export function canControlVolume(): boolean {
  const s = sp();
  return (
    typeof s?.Platform?.PlaybackAPI?.setVolume === "function" ||
    typeof s?.Player?.setVolume === "function"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tracks & queue
// ─────────────────────────────────────────────────────────────────────────────

function artistsOf(item: any): string[] {
  const list = item?.artists;
  if (Array.isArray(list)) {
    return list.map((a: any) => String(a?.name ?? "")).filter(Boolean);
  }
  const meta = item?.metadata ?? item?.contextTrack?.metadata;
  const single = meta?.artist_name;
  return single ? [String(single)] : [];
}

export function toTrackRef(item: any): TrackRef | null {
  const uri: string | undefined = item?.uri ?? item?.contextTrack?.uri;
  if (!uri) return null;
  const meta = item?.metadata ?? item?.contextTrack?.metadata ?? {};
  const durationMs =
    item?.duration?.milliseconds ??
    (meta.duration ? Number(meta.duration) : undefined) ??
    0;

  return {
    uri,
    id: trackIdFromUri(uri),
    name: String(item?.name ?? meta.title ?? "Unknown"),
    artists: artistsOf(item),
    albumUri: item?.album?.uri ?? meta.album_uri ?? null,
    durationMs: Number.isFinite(durationMs) ? Number(durationMs) : 0,
    isLocal: Boolean(item?.isLocal) || uri.startsWith("spotify:local:"),
  };
}

export function getCurrentTrack(): TrackRef | null {
  try {
    return toTrackRef(sp()?.Player?.data?.item);
  } catch {
    return null;
  }
}

/**
 * The next track, from whichever source the current client exposes.
 * `Player.data.nextItems` is richer when present; `Spicetify.Queue.nextTracks`
 * is the long-standing fallback.
 */
export function getNextTrack(): TrackRef | null {
  const s = sp();
  try {
    const fromState = s?.Player?.data?.nextItems?.[0];
    const ref = toTrackRef(fromState);
    if (ref) return ref;
  } catch {
    /* fall through */
  }
  try {
    return toTrackRef(s?.Queue?.nextTracks?.[0]);
  } catch {
    return null;
  }
}

export function getUpcomingTracks(limit = 5): TrackRef[] {
  const s = sp();
  const out: TrackRef[] = [];
  const push = (raw: any) => {
    const ref = toTrackRef(raw);
    if (ref && !out.some((t) => t.uri === ref.uri)) out.push(ref);
  };
  try {
    for (const raw of s?.Player?.data?.nextItems ?? []) {
      if (out.length >= limit) break;
      push(raw);
    }
  } catch {
    /* ignore */
  }
  try {
    for (const raw of s?.Queue?.nextTracks ?? []) {
      if (out.length >= limit) break;
      push(raw);
    }
  } catch {
    /* ignore */
  }
  return out.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

export type PlayerEvent = "songchange" | "onplaypause" | "onprogress";

export function on(event: PlayerEvent, fn: (e: any) => void): () => void {
  const s = sp();
  try {
    s?.Player?.addEventListener?.(event, fn);
  } catch (err) {
    log.warn(`could not subscribe to ${event}`, err);
  }
  return () => {
    try {
      s?.Player?.removeEventListener?.(event, fn);
    } catch {
      /* ignore */
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Account tier
// ─────────────────────────────────────────────────────────────────────────────

export type ProductTier = "premium" | "free" | "unknown";

/**
 * Read the client's product state. The key was renamed between client
 * versions, so all three known locations are probed.
 */
export async function getProductTier(): Promise<ProductTier> {
  const s = sp();
  const productState =
    s?.Platform?.UserAPI?._product_state ??
    s?.Platform?.UserAPI?._product_state_service ??
    s?.Platform?.ProductStateAPI?.productStateApi;

  if (!productState?.getValues) return "unknown";
  try {
    const res = await productState.getValues();
    const pairs = res?.pairs ?? res;
    const raw = String(pairs?.type ?? pairs?.catalogue ?? "").toLowerCase();
    if (raw.includes("premium")) return "premium";
    if (raw.includes("free") || raw.includes("open")) return "free";
    return "unknown";
  } catch (err) {
    log.debug("product state read failed", err);
    return "unknown";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage & notifications
// ─────────────────────────────────────────────────────────────────────────────

export function storageGet(key: string): string | null {
  try {
    const v = sp()?.LocalStorage?.get?.(key);
    if (typeof v === "string") return v;
  } catch {
    /* ignore */
  }
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    if (typeof sp()?.LocalStorage?.set === "function") {
      sp().LocalStorage.set(key, value);
      return;
    }
  } catch {
    /* ignore */
  }
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function notify(message: string, isError = false, timeoutMs = 2500): void {
  try {
    sp()?.showNotification?.(message, isError, timeoutMs);
  } catch {
    /* ignore */
  }
}

/**
 * A Cosmos GET. Only ever call this with Spotify-internal URLs: CosmosAsync
 * attaches the user's client session token to every request, so pointing it at
 * a third-party host would leak that token.
 */
export async function cosmosGet(url: string): Promise<any> {
  const s = sp();
  if (typeof s?.CosmosAsync?.get !== "function") throw new Error("CosmosAsync unavailable");
  return s.CosmosAsync.get(url);
}
