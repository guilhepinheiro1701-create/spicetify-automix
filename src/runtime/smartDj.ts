/**
 * Smart DJ controller.
 *
 * The only stateful piece. It watches playback, keeps the analysis warm, asks
 * the transition engine for a plan whenever the current or next track changes,
 * arms the scheduler, and hands the plan to the audio engine at the right
 * instant.
 *
 * Every path out of here is guarded: if anything at all goes wrong the
 * controller disarms, tells the audio engine to restore whatever it touched,
 * and lets Spotify carry on exactly as it would have without us.
 */

import { createLogger } from "../core/logger.js";
import { Emitter } from "../core/events.js";
import { calculateTransition } from "../engine/transitionEngine.js";
import { AudioEngine } from "../audio/audioEngine.js";
import { TransitionScheduler } from "./scheduler.js";
import { QueueIntelligence } from "../queue/queueIntelligence.js";
import * as player from "../platform/spicetify.js";
import { probeCapabilities, type CapabilitySet } from "../platform/capabilities.js";
import { setNativeCrossfade, getCrossfadeState } from "../platform/nativeCrossfade.js";
import type { MusicAnalyzer } from "../analysis/analyzer.js";
import type { SettingsStore } from "../config/settings.js";
import type { TransitionPlan, TransitionStatus, TrackRef } from "../core/types.js";

const log = createLogger("smartdj");

/** Do not attempt anything on a track shorter than this. */
const MIN_TRACK_SEC = 25;
/** Ignore transitions this close to the very start of a track. */
const MIN_PLAYED_SEC = 5;

export interface SmartDjEvents extends Record<string, unknown> {
  status: TransitionStatus;
  plan: { plan: TransitionPlan | null };
}

export class SmartDj {
  readonly events = new Emitter<SmartDjEvents>();
  readonly audio = new AudioEngine();
  readonly queue: QueueIntelligence;

  private scheduler: TransitionScheduler;
  private capabilities: CapabilitySet | null = null;
  private unsubscribers: (() => void)[] = [];

  private currentTrack: TrackRef | null = null;
  private nextTrack: TrackRef | null = null;
  private plan: TransitionPlan | null = null;
  private status: TransitionStatus = {
    phase: "idle",
    progress: 0,
    plan: null,
    etaSec: null,
    lastError: null,
  };

  /**
   * Tracks we have already transitioned out of, mapped to the playback position
   * we fired at. Keyed this way rather than as a plain set so that *replaying* a
   * track later in the session still gets a transition: on a replay the position
   * restarts near zero, which is behind the recorded one.
   */
  private handled = new Map<string, number>();
  /** Crossfade setting as we found it, restored on teardown. */
  private originalCrossfade: { enabled: boolean; durationSec: number } | null = null;
  private planToken = 0;
  private started = false;

  constructor(
    private readonly analyzer: MusicAnalyzer,
    private readonly settings: SettingsStore,
  ) {
    this.queue = new QueueIntelligence(analyzer);
    this.scheduler = new TransitionScheduler({
      position: () => player.getProgressMs(),
      playing: () => player.isPlaying(),
    });
  }

  getStatus(): Readonly<TransitionStatus> {
    return this.status;
  }

  getCapabilities(): CapabilitySet | null {
    return this.capabilities;
  }

  getPlan(): TransitionPlan | null {
    return this.plan;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.capabilities = await probeCapabilities();
    const xf = getCrossfadeState();
    this.originalCrossfade = { enabled: xf.enabled, durationSec: xf.durationSec };

    this.unsubscribers.push(
      player.on("songchange", () => void this.onSongChange()),
      player.on("onplaypause", () => this.onPlayPause()),
    );

    this.settings.events.on("change", ({ changed }) => {
      if (changed.includes("enabled")) {
        if (this.settings.get().enabled) void this.refreshPlan();
        else this.disarm("disabled by user");
      } else {
        void this.refreshPlan();
      }
    });

    this.analyzer.configureExternal({
      enabled: this.settings.get().externalProviderEnabled,
      url: this.settings.get().externalProviderUrl,
    });
    this.settings.events.on("change", ({ settings }) => {
      this.analyzer.configureExternal({
        enabled: settings.externalProviderEnabled,
        url: settings.externalProviderUrl,
      });
    });

    this.audio.events.on("progress", ({ progress }) => {
      this.setStatus({ phase: "transitioning", progress });
    });

    await this.onSongChange();
    log.info(`started — tier "${this.capabilities.tier}"`);
  }

  stop(): void {
    this.disarm("stopped");
    for (const un of this.unsubscribers) un();
    this.unsubscribers = [];
    this.audio.dispose();
    this.restoreCrossfade();
    this.started = false;
    this.setStatus({ phase: "disabled", progress: 0, plan: null, etaSec: null });
  }

  /** Put the client's crossfade setting back the way the user had it. */
  private restoreCrossfade(): void {
    if (!this.originalCrossfade) return;
    const { enabled, durationSec } = this.originalCrossfade;
    void setNativeCrossfade(enabled, durationSec || 4).catch(() => undefined);
    this.originalCrossfade = null;
  }

  // ── Playback events ───────────────────────────────────────────────────────

  private async onSongChange(): Promise<void> {
    this.scheduler.cancel();
    this.audio.abort("track changed");

    const track = player.getCurrentTrack();
    this.currentTrack = track;
    this.plan = null;
    this.setStatus({ phase: "analyzing", progress: 0, plan: null, etaSec: null, lastError: null });

    if (!track) {
      this.setStatus({ phase: "idle" });
      return;
    }

    // Keep the handled set from growing without bound over a long session.
    if (this.handled.size > 200) this.handled.clear();

    await this.refreshPlan();
  }

  private onPlayPause(): void {
    if (!player.isPlaying() && this.audio.isRunning) {
      this.audio.abort("playback paused");
      this.setStatus({ phase: "armed", progress: 0 });
    }
  }

  // ── Planning ──────────────────────────────────────────────────────────────

  /** Recompute the plan for the current pair and re-arm the scheduler. */
  async refreshPlan(): Promise<void> {
    const token = ++this.planToken;
    const settings = this.settings.get();

    if (!settings.enabled) {
      this.disarm("disabled");
      return;
    }
    if (!this.capabilities) return;

    const from = this.currentTrack ?? player.getCurrentTrack();
    if (!from) return;
    this.currentTrack = from;

    const durationSec = (from.durationMs || player.getDurationMs()) / 1000;
    if (durationSec < MIN_TRACK_SEC) {
      this.disarm(`track is only ${durationSec.toFixed(0)}s — too short to mix out of`);
      return;
    }
    if (player.getRepeatMode() === 2) {
      this.disarm("repeat-one is on — leaving the loop alone");
      return;
    }
    const firedAt = this.handled.get(from.uri);
    if (firedAt !== undefined && player.getProgressMs() >= firedAt) {
      this.disarm("already transitioned out of this playthrough");
      return;
    }

    const upcoming = player.getUpcomingTracks(4);
    this.nextTrack = upcoming[0] ?? null;
    this.queue.prefetch(upcoming);

    try {
      const fromAnalysis = await this.analyzer.analyze(from);
      const toAnalysis = this.nextTrack ? await this.analyzer.analyze(this.nextTrack) : null;
      if (token !== this.planToken) return; // superseded while we awaited
      if (!fromAnalysis) return;

      const plan = calculateTransition({
        fromTrack: from,
        toTrack: this.nextTrack,
        fromAnalysis,
        toAnalysis,
        settings,
        capabilities: this.capabilities,
      });

      this.plan = plan;
      this.events.emit("plan", { plan });

      if (plan.executor === "passive" || plan.durationSec <= 0) {
        this.disarm(plan.rationale[0] ?? "nothing to do");
        this.plan = plan;
        this.setStatus({ plan });
        return;
      }

      this.arm(plan);
    } catch (err) {
      log.error("planning failed — standing down for this track", err);
      this.disarm("planning failed");
      this.setStatus({ lastError: String((err as Error)?.message ?? err) });
    }
  }

  private arm(plan: TransitionPlan): void {
    const targetMs = plan.startPointSec * 1000;
    const position = player.getProgressMs();

    if (targetMs <= position + 500) {
      // We are already past the ideal exit — either the user seeked into the
      // tail, or planning took too long. Better to leave this one alone than to
      // fire a transition at a musically arbitrary point.
      this.disarm("already past the planned exit point");
      this.setStatus({ plan });
      return;
    }
    if (position < MIN_PLAYED_SEC * 1000 && targetMs - position < 2000) {
      this.disarm("too close to the start of the track");
      return;
    }

    this.scheduler.arm(targetMs, () => void this.fire(plan));
    this.setStatus({
      phase: "armed",
      progress: 0,
      plan,
      etaSec: this.scheduler.etaSec(),
      lastError: null,
    });
    log.debug(
      `armed: ${plan.technique} in ${((targetMs - position) / 1000).toFixed(1)}s ` +
        `(${plan.durationSec.toFixed(1)}s, ${(plan.compatibility.overall * 100).toFixed(0)}% match)`,
    );
  }

  private disarm(reason: string): void {
    this.scheduler.cancel();
    if (this.status.phase !== "idle") log.debug(`disarmed: ${reason}`);
    this.setStatus({ phase: "idle", progress: 0, etaSec: null });
  }

  // ── Firing ────────────────────────────────────────────────────────────────

  private async fire(plan: TransitionPlan): Promise<void> {
    if (!this.settings.get().enabled) return;
    if (!player.isPlaying()) {
      this.disarm("paused at the moment of the switch");
      return;
    }

    const live = player.getCurrentTrack();
    if (!live || live.uri !== plan.from.uri) {
      this.disarm("track changed underneath the plan");
      return;
    }

    // The queue can change between arming and firing. If the next track is no
    // longer the one we planned for, the plan is wrong — replan rather than
    // running a transition computed for a different record.
    const liveNext = player.getUpcomingTracks(1)[0] ?? null;
    if ((liveNext?.uri ?? null) !== (plan.to?.uri ?? null)) {
      log.info("queue changed since arming — replanning");
      await this.refreshPlan();
      return;
    }

    this.handled.set(plan.from.uri, player.getProgressMs());
    this.setStatus({ phase: "transitioning", progress: 0, plan, etaSec: 0 });

    if (this.settings.get().showNotifications) {
      player.notify(
        `Smart DJ · ${plan.technique.replace(/-/g, " ")} · ${(plan.compatibility.overall * 100).toFixed(0)}%`,
      );
    }

    const token = this.planToken;
    const outcome = await this.audio.execute(plan);

    // The songchange that follows a successful switch replans, which supersedes
    // this run. Do not stamp stale status over the fresh plan.
    if (token !== this.planToken) return;

    if (outcome.status === "failed") {
      log.warn(`transition failed: ${outcome.note}`);
      this.setStatus({ lastError: outcome.note });
    }
    this.setStatus({ phase: "recovering", progress: 1 });

    // The songchange event that follows the switch will reset everything; this
    // is just so the UI does not sit on "transitioning" if that event is late.
    setTimeout(() => {
      if (this.status.phase === "recovering") this.setStatus({ phase: "idle", progress: 0 });
    }, 2500);
  }

  // ── Status plumbing ───────────────────────────────────────────────────────

  private setStatus(patch: Partial<TransitionStatus>): void {
    this.status = { ...this.status, ...patch };
    if (this.status.phase === "armed") this.status.etaSec = this.scheduler.etaSec();
    this.events.emit("status", this.status);
  }

  /** Recompute the ETA — called by the UI on a slow tick. */
  refreshEta(): void {
    if (this.status.phase !== "armed") return;
    const eta = this.scheduler.etaSec();
    if (eta !== this.status.etaSec) this.setStatus({ etaSec: eta });
  }
}
