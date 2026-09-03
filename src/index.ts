/**
 * Smart DJ for Spicetify — entry point.
 *
 * Boots in this order: wait for the client APIs, load settings, probe what this
 * client can actually do, start the controller, then add the UI. Any failure at
 * any step leaves Spotify exactly as it was.
 */

import { createLogger, setLogLevel } from "./core/logger.js";
import { SettingsStore } from "./config/settings.js";
import { MusicAnalyzer } from "./analysis/analyzer.js";
import { SmartDj } from "./runtime/smartDj.js";
import { openPanel } from "./ui/panel.js";
import { DebugOverlay } from "./ui/debugOverlay.js";
import { injectStyles } from "./ui/styles.js";
import { storageGet, storageSet, waitForSpicetify, notify } from "./platform/spicetify.js";

declare const Spicetify: any;
declare const __SMART_DJ_VERSION__: string;

const log = createLogger("boot");

const VERSION = typeof __SMART_DJ_VERSION__ === "string" ? __SMART_DJ_VERSION__ : "dev";

/** Exposed on `window.SmartDJ` for debugging and for other extensions. */
export interface SmartDjApi {
  version: string;
  settings: SettingsStore;
  analyzer: MusicAnalyzer;
  dj: SmartDj;
  open(): void;
  /** Recompute the plan for the current pair right now. */
  replan(): Promise<void>;
  /** Dump the current plan to the console. */
  explain(): void;
  /** The event timeline of every transition this session. */
  transitions(): void;
  teardown(): void;
}

async function boot(): Promise<void> {
  const ready = await waitForSpicetify();
  if (!ready) {
    log.error("Spicetify never became ready — Smart DJ is not starting");
    return;
  }

  const storage = { get: storageGet, set: storageSet };
  const settings = new SettingsStore(storage);
  setLogLevel(settings.get().debugMode ? "debug" : settings.get().logLevel);

  const analyzer = new MusicAnalyzer({ storage });
  const dj = new SmartDj(analyzer, settings, storage);

  try {
    await dj.start();
  } catch (err) {
    log.error("controller failed to start — standing down", err);
    notify("Smart DJ could not start — playback is unaffected", true, 4000);
    return;
  }

  injectStyles();

  // ── Playbar button ────────────────────────────────────────────────────────
  const deps = { settings, dj, analyzer };
  let button: any = null;
  try {
    button = new Spicetify.Playbar.Button(
      "Smart DJ",
      djIcon(),
      () => openPanel(deps),
      false,
      settings.get().enabled,
    );
  } catch (err) {
    log.warn("could not add the playbar button — the panel is still available via window.SmartDJ.open()", err);
  }

  settings.events.on("change", ({ settings: s }) => {
    if (button) button.active = s.enabled;
  });

  // ── Debug overlay ─────────────────────────────────────────────────────────
  const overlay = new DebugOverlay(dj, analyzer);
  const syncOverlay = (debugMode: boolean) => {
    if (debugMode && !overlay.visible) overlay.show();
    else if (!debugMode && overlay.visible) overlay.hide();
  };
  syncOverlay(settings.get().debugMode);
  settings.events.on("change", ({ settings: s }) => syncOverlay(s.debugMode));

  // ── Housekeeping ──────────────────────────────────────────────────────────
  const flush = () => analyzer.cache.flush();
  globalThis.addEventListener?.("beforeunload", flush);

  const api: SmartDjApi = {
    version: VERSION,
    settings,
    analyzer,
    dj,
    open: () => openPanel(deps),
    replan: () => dj.refreshPlan(),
    explain: () => {
      const plan = dj.getPlan();
      if (!plan) {
        console.log("[SmartDJ] no plan — nothing queued, or Smart DJ is disabled");
        return;
      }
      console.group(`[SmartDJ] ${plan.from.name} → ${plan.to?.name ?? "—"}`);
      console.log("technique:", plan.technique, "via", plan.executor);
      console.log(
        "compatibility:",
        `${(plan.compatibility.overall * 100).toFixed(0)}%`,
        `(confidence ${(plan.compatibility.confidence * 100).toFixed(0)}%)`,
      );
      console.table({
        tempo: plan.compatibility.tempo,
        key: plan.compatibility.key,
        energy: plan.compatibility.energy,
        phrase: plan.compatibility.phrase,
        loudness: plan.compatibility.loudness,
        style: plan.compatibility.style,
      });
      console.log("plan:", plan);
      if (plan.rationale.length) console.log("why:", plan.rationale);
      if (plan.caveats.length) console.warn("limits:", plan.caveats);
      console.groupEnd();
    },
    transitions: () => {
      const log = dj.audio.transitionLog;
      const incomplete = log.incomplete();
      console.log(log.format());
      if (incomplete.length > 0) {
        console.warn(
          `[SmartDJ] ${incomplete.length} transition(s) did not complete — ` +
            "each one's last event says where it stopped",
        );
      }
    },
    teardown: () => {
      dj.stop();
      overlay.hide();
      button?.deregister?.();
      analyzer.dispose();
      globalThis.removeEventListener?.("beforeunload", flush);
      delete (globalThis as Record<string, unknown>).SmartDJ;
      log.info("torn down");
    },
  };

  (globalThis as Record<string, unknown>).SmartDJ = api;
  log.info(`Smart DJ ${VERSION} ready — window.SmartDJ.explain() for the current plan`);
}

function djIcon(): string {
  // Spicetify accepts a raw SVG path/markup string for custom icons.
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
    <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Z"/>
    <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM4 8a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z"/>
    <path d="M12.7 3.3a.75.75 0 0 1 0 1.06l-1.6 1.6a.75.75 0 1 1-1.05-1.06l1.59-1.6a.75.75 0 0 1 1.06 0ZM5.95 10.04a.75.75 0 0 1 0 1.06l-1.6 1.6a.75.75 0 0 1-1.05-1.06l1.59-1.6a.75.75 0 0 1 1.06 0Z"/>
  </svg>`;
}

// Spicetify loads extensions as classic scripts into the client bundle.
void boot().catch((err) => console.error("[SmartDJ] fatal boot error", err));
