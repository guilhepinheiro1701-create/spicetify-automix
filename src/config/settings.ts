/** Settings store: validated, persisted, observable. */

import { Emitter } from "../core/events.js";
import { createLogger, setLogLevel, type LogLevel } from "../core/logger.js";
import { clamp, clamp01 } from "../core/util.js";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, type Settings } from "./defaults.js";
import { STYLE_PROFILES } from "./styles.js";
import { INTENT_PROFILES } from "./intent.js";
import type { DjIntent } from "./intent.js";
import type { TransitionStyle, FadeCurve } from "../core/types.js";

const log = createLogger("settings");

const VALID_CURVES: FadeCurve[] = ["equal-power", "linear", "exponential", "s-curve"];
const VALID_LEVELS: LogLevel[] = ["silent", "error", "warn", "info", "debug"];

/**
 * Coerce anything read from storage into a valid Settings object. A corrupt or
 * out-of-date stored value must never be able to break playback, so every
 * field falls back to its default rather than throwing.
 */
export function sanitize(raw: unknown): Settings {
  const input = (raw ?? {}) as Partial<Settings>;
  const d = DEFAULT_SETTINGS;

  const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === "boolean" ? v : fallback;
  const num = (v: unknown, fallback: number, lo: number, hi: number): number =>
    typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;

  const intent: DjIntent =
    typeof input.intent === "string" && input.intent in INTENT_PROFILES
      ? (input.intent as DjIntent)
      : d.intent;

  const style: TransitionStyle =
    typeof input.style === "string" && input.style in STYLE_PROFILES
      ? (input.style as TransitionStyle)
      : d.style;

  let minDurationSec = num(input.minDurationSec, d.minDurationSec, 0.5, 12);
  let maxDurationSec = num(input.maxDurationSec, d.maxDurationSec, 1, 12);
  if (minDurationSec > maxDurationSec) {
    // Keep the pair coherent rather than rejecting the whole object.
    [minDurationSec, maxDurationSec] = [maxDurationSec, minDurationSec];
  }

  const externalProviderUrl =
    typeof input.externalProviderUrl === "string" ? input.externalProviderUrl.trim() : "";

  return {
    enabled: bool(input.enabled, d.enabled),
    intent,
    style,
    intensity: clamp01(num(input.intensity, d.intensity, 0, 1)),
    minDurationSec,
    maxDurationSec,
    beatMatching: bool(input.beatMatching, d.beatMatching),
    harmonicMixing: bool(input.harmonicMixing, d.harmonicMixing),
    phraseMatching: bool(input.phraseMatching, d.phraseMatching),
    fadeShaping: bool(input.fadeShaping, d.fadeShaping),
    energyMatching: bool(input.energyMatching, d.energyMatching),
    loudnessNormalization: bool(input.loudnessNormalization, d.loudnessNormalization),
    skipDeadIntro: bool(input.skipDeadIntro, d.skipDeadIntro),
    preserveAlbumGapless: bool(input.preserveAlbumGapless, d.preserveAlbumGapless),
    autoMode: bool(input.autoMode, d.autoMode),
    queueReordering: bool(input.queueReordering, d.queueReordering),
    minCompatibilityForBlend: clamp01(
      num(input.minCompatibilityForBlend, d.minCompatibilityForBlend, 0, 1),
    ),
    switchLatencyMs: num(input.switchLatencyMs, d.switchLatencyMs, -500, 500),
    fadeCurve: VALID_CURVES.includes(input.fadeCurve as FadeCurve)
      ? (input.fadeCurve as FadeCurve)
      : d.fadeCurve,
    // A provider is only ever considered enabled with a usable https URL.
    externalProviderEnabled:
      bool(input.externalProviderEnabled, d.externalProviderEnabled) &&
      externalProviderUrl.startsWith("https://"),
    externalProviderUrl,
    debugMode: bool(input.debugMode, d.debugMode),
    logLevel: VALID_LEVELS.includes(input.logLevel as LogLevel)
      ? (input.logLevel as LogLevel)
      : d.logLevel,
    showNotifications: bool(input.showNotifications, d.showNotifications),
  };
}

export interface SettingsEvents extends Record<string, unknown> {
  change: { settings: Settings; changed: (keyof Settings)[] };
}

export interface StorageAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export class SettingsStore {
  readonly events = new Emitter<SettingsEvents>();
  private current: Settings;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly key: string = SETTINGS_STORAGE_KEY,
  ) {
    this.current = this.load();
    setLogLevel(this.current.debugMode ? "debug" : this.current.logLevel);
  }

  private load(): Settings {
    try {
      const raw = this.storage.get(this.key);
      if (!raw) return { ...DEFAULT_SETTINGS };
      return sanitize(JSON.parse(raw));
    } catch (err) {
      log.warn("stored settings unreadable, using defaults", err);
      return { ...DEFAULT_SETTINGS };
    }
  }

  get(): Readonly<Settings> {
    return this.current;
  }

  /** Apply a partial update. Invalid values are corrected, not rejected. */
  update(patch: Partial<Settings>): Settings {
    const next = sanitize({ ...this.current, ...patch });
    const changed = (Object.keys(next) as (keyof Settings)[]).filter(
      (k) => next[k] !== this.current[k],
    );
    if (changed.length === 0) return this.current;

    this.current = next;
    setLogLevel(next.debugMode ? "debug" : next.logLevel);
    this.persist();
    this.events.emit("change", { settings: next, changed });
    return next;
  }

  reset(): Settings {
    return this.update({ ...DEFAULT_SETTINGS });
  }

  private persist(): void {
    try {
      this.storage.set(this.key, JSON.stringify(this.current));
    } catch (err) {
      log.warn("could not persist settings", err);
    }
  }
}
