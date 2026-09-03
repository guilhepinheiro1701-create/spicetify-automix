import type { FadeCurve, TransitionStyle } from "../core/types.js";
import type { LogLevel } from "../core/logger.js";

/** Everything the user can change, in one place. */
export interface Settings {
  enabled: boolean;
  style: TransitionStyle;

  /** 0..1 — how far the engine is allowed to push toward long, obvious mixes. */
  intensity: number;
  minDurationSec: number;
  maxDurationSec: number;

  beatMatching: boolean;
  harmonicMixing: boolean;
  phraseMatching: boolean;
  smartEq: boolean;
  energyMatching: boolean;
  loudnessNormalization: boolean;

  /** Skip a dead intro on the incoming track when one is detected. */
  skipDeadIntro: boolean;
  /** Leave consecutive tracks from the same album alone. */
  preserveAlbumGapless: boolean;
  /** Let the engine pick duration/technique instead of forcing the slider value. */
  autoMode: boolean;

  /** Below this compatibility the engine refuses to blend and cuts cleanly. */
  minCompatibilityForBlend: number;
  fadeCurve: FadeCurve;

  /** Opt-in third-party analysis provider. Off by default: see PRIVACY in the README. */
  externalProviderEnabled: boolean;
  externalProviderUrl: string;

  debugMode: boolean;
  logLevel: LogLevel;
  showNotifications: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  style: "dj",

  intensity: 0.6,
  minDurationSec: 2,
  maxDurationSec: 10,

  beatMatching: true,
  harmonicMixing: true,
  phraseMatching: true,
  smartEq: true,
  energyMatching: true,
  loudnessNormalization: true,

  skipDeadIntro: true,
  preserveAlbumGapless: true,
  autoMode: true,

  minCompatibilityForBlend: 0.35,
  fadeCurve: "equal-power",

  externalProviderEnabled: false,
  externalProviderUrl: "",

  debugMode: false,
  logLevel: "warn",
  showNotifications: false,
};

export const SETTINGS_STORAGE_KEY = "smart-dj:settings:v1";
export const CACHE_STORAGE_KEY = "smart-dj:analysis-cache:v1";
