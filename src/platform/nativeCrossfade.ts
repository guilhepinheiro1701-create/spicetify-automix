/**
 * Control of Spotify's own crossfade engine.
 *
 * This is the single most important capability in the whole project. Extensions
 * cannot touch Spotify's audio: the stream is decoded and mixed below the web
 * layer, there is no media element to hang a Web Audio graph off, and the
 * client exposes no rate control for music. What the client *does* have is a
 * real crossfade mixer (Settings → Playback → Crossfade) that produces a
 * genuine audio overlap when a track change happens.
 *
 * So Smart DJ drives that mixer: it programs the crossfade length for the
 * specific pair of tracks about to be joined, then triggers the track change at
 * a musically chosen moment. The overlap is real audio, mixed by Spotify.
 *
 * None of the setters below are documented API. Each client version exposes a
 * different subset, so all four known paths are attempted and the first one
 * that does not throw wins. If every path fails we report that honestly and the
 * audio engine falls back to volume automation.
 */

import { createLogger } from "../core/logger.js";
import { sp } from "./spicetify.js";

const log = createLogger("crossfade");

export interface CrossfadeState {
  /** Whether we believe the native mixer is currently enabled. */
  enabled: boolean;
  /** Current crossfade length in seconds, as far as we can tell. */
  durationSec: number;
  /** Which write path last succeeded, for the debug panel. */
  via: string | null;
  /** True once at least one write path has ever succeeded. */
  writable: boolean;
  /** True when a read path confirmed the value rather than us assuming it. */
  verified: boolean;
}

const state: CrossfadeState = {
  enabled: false,
  durationSec: 0,
  via: null,
  writable: false,
  verified: false,
};

export function getCrossfadeState(): Readonly<CrossfadeState> {
  return state;
}

/** Spotify's own UI caps crossfade at 12 s. */
export const MAX_NATIVE_CROSSFADE_SEC = 12;
export const MIN_NATIVE_CROSSFADE_SEC = 1;

type Writer = { name: string; write: (enabled: boolean, sec: number) => Promise<void> };

const WRITERS: Writer[] = [
  {
    name: "ConfigAPI",
    write: async (enabled, sec) => {
      const api = sp()?.Platform?.ConfigAPI;
      if (typeof api?.setAccountSetting !== "function") throw new Error("no ConfigAPI");
      await api.setAccountSetting("audio.crossfade_v2", enabled);
      await api.setAccountSetting("audio.crossfade.time_v2", Math.round(sec * 1000));
    },
  },
  {
    name: "PlayerAPI._prefs",
    write: async (enabled, sec) => {
      const prefs = sp()?.Platform?.PlayerAPI?._prefs;
      if (typeof prefs?.setCrossfade !== "function") throw new Error("no _prefs.setCrossfade");
      await prefs.setCrossfade(enabled, sec);
    },
  },
  {
    name: "Cosmos player/v2/main",
    write: async (enabled, sec) => {
      const cosmos = sp()?.CosmosAsync;
      if (typeof cosmos?.post !== "function") throw new Error("no CosmosAsync");
      await cosmos.post("sp://player/v2/main", {
        crossfade: { enabled, duration_ms: Math.round(sec * 1000) },
      });
    },
  },
  {
    name: "Cosmos connect/v1",
    write: async (enabled, sec) => {
      const cosmos = sp()?.CosmosAsync;
      if (typeof cosmos?.put !== "function") throw new Error("no CosmosAsync.put");
      await cosmos.put("sp://connect/v1/player/crossfade", {
        enabled,
        duration: Math.round(sec * 1000),
      });
    },
  },
];

/** Cache of which writers work, so we stop retrying dead paths every transition. */
const writerHealth = new Map<string, boolean>();

/**
 * Program the native mixer. Returns true when at least one write path accepted
 * the values.
 *
 * Note the honest limit: none of these paths reliably reports back, so a
 * `true` here means "the client accepted the call", not "audio will definitely
 * overlap". `verifyCrossfade()` is the best-effort confirmation.
 */
export async function setNativeCrossfade(enabled: boolean, durationSec: number): Promise<boolean> {
  const sec = Math.max(
    MIN_NATIVE_CROSSFADE_SEC,
    Math.min(MAX_NATIVE_CROSSFADE_SEC, Math.round(durationSec * 10) / 10),
  );

  let ok = false;
  for (const writer of WRITERS) {
    if (writerHealth.get(writer.name) === false) continue;
    try {
      await writer.write(enabled, sec);
      writerHealth.set(writer.name, true);
      if (!ok) {
        state.via = writer.name;
        ok = true;
      }
    } catch (err) {
      writerHealth.set(writer.name, false);
      log.debug(`writer ${writer.name} unavailable:`, (err as Error)?.message ?? err);
    }
  }

  if (ok) {
    state.enabled = enabled;
    state.durationSec = sec;
    state.writable = true;
    log.debug(`native crossfade → ${enabled ? `${sec}s` : "off"} via ${state.via}`);
  } else {
    state.writable = false;
    log.warn("no native crossfade write path available on this client");
  }
  return ok;
}

/** Best-effort read-back. Not all clients expose a getter. */
export async function verifyCrossfade(): Promise<CrossfadeState> {
  const api = sp()?.Platform?.ConfigAPI;
  try {
    if (typeof api?.getAccountSetting === "function") {
      const enabled = await api.getAccountSetting("audio.crossfade_v2");
      const ms = await api.getAccountSetting("audio.crossfade.time_v2");
      if (typeof enabled === "boolean") {
        state.enabled = enabled;
        state.verified = true;
      }
      if (typeof ms === "number" && Number.isFinite(ms)) state.durationSec = ms / 1000;
    }
  } catch (err) {
    log.debug("crossfade read-back unavailable", err);
  }
  return state;
}

/**
 * Probe whether this client will let us drive the mixer at all, without
 * changing anything the user would notice: we write the value the client
 * already has.
 */
export async function probeCrossfadeWritable(): Promise<boolean> {
  await verifyCrossfade();
  const before = state.durationSec || 4;
  const ok = await setNativeCrossfade(state.enabled, before);
  return ok;
}
