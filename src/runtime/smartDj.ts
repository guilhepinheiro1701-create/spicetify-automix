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
import { SetlistPlanner, type SetlistReport } from "../queue/setlist.js";
import { TransitionMemory } from "./memory.js";
import { Diagnostics } from "./diagnostics.js";
import * as player from "../platform/spicetify.js";
import { probeCapabilities, type CapabilitySet } from "../platform/capabilities.js";
import { setNativeCrossfade, getCrossfadeState } from "../platform/nativeCrossfade.js";
import type { MusicAnalyzer } from "../analysis/analyzer.js";
import type { SettingsStore } from "../config/settings.js";
import type {
  TrackRef,
  TrackStructure,
  TransitionPlan,
  TransitionStatus,
} from "../core/types.js";

const log = createLogger("smartdj");

/** Which structural section a time sits in, for the session log. */
function sectionRoleAt(structure: TrackStructure | null, timeSec: number): string {
  if (!structure?.known) return "unknown";
  for (const section of structure.sections) {
    if (timeSec >= section.startSec && timeSec < section.endSec) return section.role;
  }
  return timeSec <= 0.5 ? "intro" : "unknown";
}

/** Do not attempt anything on a track shorter than this. */
const MIN_TRACK_SEC = 25;
/** Ignore transitions this close to the very start of a track. */
const MIN_PLAYED_SEC = 5;
/**
 * How far past the planned exit the playhead may be and still count as "now".
 *
 * Covers ordinary scheduling jitter. Anything beyond it means the position
 * moved by something other than playback — a seek — and the plan is stale.
 */
const OVERSHOOT_TOLERANCE_SEC = 1.5;

export interface SmartDjEvents extends Record<string, unknown> {
  status: TransitionStatus;
  plan: { plan: TransitionPlan | null };
  setlist: { report: SetlistReport };
}

export class SmartDj {
  readonly events = new Emitter<SmartDjEvents>();
  readonly audio = new AudioEngine();
  readonly setlist: SetlistPlanner;
  readonly memory: TransitionMemory;
  readonly diagnostics = new Diagnostics();

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
  private lastSetlist: SetlistReport | null = null;
  /** Reorders performed for the currently playing track, to bound the replan loop. */
  private reordersThisTrack = 0;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guards against stacking replan chains when songchange fires repeatedly. */
  private replanPending = false;
  /** URIs we have already promoted, so we never shuffle the same track twice. */
  private promoted = new Set<string>();

  constructor(
    private readonly analyzer: MusicAnalyzer,
    private readonly settings: SettingsStore,
    storage: { get(k: string): string | null; set(k: string, v: string): void } | null = null,
  ) {
    this.setlist = new SetlistPlanner(analyzer);
    this.memory = new TransitionMemory(storage);
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

  getSetlist(): SetlistReport | null {
    return this.lastSetlist;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.capabilities = await probeCapabilities();
    this.diagnostics.setCrossfadeAvailable(this.capabilities.flags.crossfade);
    const xf = getCrossfadeState();
    this.originalCrossfade = { enabled: xf.enabled, durationSec: xf.durationSec };

    this.unsubscribers.push(
      player.on("songchange", () => void this.onSongChange()),
      player.on("onplaypause", () => this.onPlayPause()),
    );

    this.analyzer.configureExternal({
      enabled: this.settings.get().externalProviderEnabled,
      url: this.settings.get().externalProviderUrl,
    });

    this.unsubscribers.push(
      this.settings.events.on("change", ({ changed, settings }) => {
        this.analyzer.configureExternal({
          enabled: settings.externalProviderEnabled,
          url: settings.externalProviderUrl,
        });

        if (changed.includes("enabled")) {
          if (settings.enabled) {
            void this.refreshPlan();
          } else {
            // Switching Smart DJ off during a transition has to stop the
            // transition, not just prevent the next one — otherwise a volume
            // ramp keeps running against a player the user just took back.
            this.audio.abort("Smart DJ switched off");
            this.disarm("disabled by user");
          }
          return;
        }
        void this.refreshPlan();
      }),
      this.audio.events.on("progress", ({ progress }) => {
        this.setStatus({ phase: "transitioning", progress });
      }),
    );

    await this.onSongChange();
    log.info(`started — tier "${this.capabilities.tier}"`);
  }

  stop(): void {
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.disarm("stopped");
    this.audio.abort("stopped");
    for (const un of this.unsubscribers) un();
    this.unsubscribers = [];
    this.audio.dispose();
    this.memory.dispose();
    this.restoreCrossfade();
    // Leave nothing behind that a later start() would inherit.
    this.plan = null;
    this.lastSetlist = null;
    this.currentTrack = null;
    this.nextTrack = null;
    this.handled.clear();
    this.promoted.clear();
    this.reordersThisTrack = 0;
    this.replanPending = false;
    this.planToken++;
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

  /**
   * A track change arrived.
   *
   * The distinction this makes is the one the whole extension turned on, and
   * getting it wrong is what made Smart DJ useless in practice: Spotify emits
   * `songchange` for **our own** `next()` exactly as it does for a user skip.
   * The old code aborted unconditionally, which cancelled every transition
   * roughly halfway through — the volume faded down, the track changed, and the
   * fade-in never ran. What a listener heard was a track that got quieter and
   * then snapped back to full.
   *
   * So: if the audio engine says it just asked for this change, the transition
   * in flight is allowed to finish. Replanning waits until it does.
   */
  private async onSongChange(): Promise<void> {
    const ours = this.audio.isExpectingTrackChange();

    this.scheduler.cancel();

    if (ours) {
      this.audio.clearTrackChangeExpectation();
      log.debug("track changed because we asked — letting the transition finish");
      // Keep the current-track pointer honest for anything that reads it, but
      // do not touch the audio engine or the plan: the executor is mid-fade-in
      // and owns the volume until it says otherwise.
      this.currentTrack = player.getCurrentTrack();
      this.reordersThisTrack = 0;
      // Replan once the transition has actually finished.
      void this.replanAfterTransition();
      return;
    }

    // Somebody else changed the track: the user, or Spotify running out of
    // material. Whatever we were doing is now wrong.
    this.audio.abort("track changed externally");

    const track = player.getCurrentTrack();
    this.currentTrack = track;
    this.plan = null;
    this.reordersThisTrack = 0;
    this.setStatus({ phase: "analyzing", progress: 0, plan: null, etaSec: null, lastError: null });

    if (!track) {
      this.setStatus({ phase: "idle" });
      return;
    }

    // Keep the handled set from growing without bound over a long session.
    if (this.handled.size > 200) this.handled.clear();

    await this.refreshPlan();
  }

  /**
   * Wait for the in-flight transition to finish, then plan the next one.
   *
   * Bounded: if the executor somehow never finishes, replanning happens anyway
   * rather than the controller sitting idle for the rest of the session.
   */
  private async replanAfterTransition(): Promise<void> {
    // Several songchanges in quick succession must not stack up waiters, each
    // of which would call refreshPlan when the engine finally goes idle.
    if (this.replanPending) return;
    this.replanPending = true;
    const deadline = Date.now() + 15_000;
    while (this.started && this.audio.isRunning && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!this.started) {
      this.replanPending = false;
      return;
    }
    if (this.audio.isRunning) {
      log.warn("the transition did not finish in time — replanning anyway");
      this.audio.abort("transition overran");
    }
    this.replanPending = false;
    this.plan = null;
    this.setStatus({ phase: "analyzing", progress: 0, plan: null, etaSec: null });
    if (this.handled.size > 200) this.handled.clear();
    await this.refreshPlan();
  }

  private onPlayPause(): void {
    if (player.isPlaying() || !this.audio.isRunning) return;
    // Some clients report a momentary pause as the track flips. That is not a
    // user pausing, and cancelling on it would kill our own fade-in.
    if (this.audio.isExpectingTrackChange()) return;
    this.audio.abort("playback paused");
    this.setStatus({ phase: "armed", progress: 0 });
  }

  // ── Planning ──────────────────────────────────────────────────────────────

  /** Recompute the plan for the current pair and re-arm the scheduler. */
  async refreshPlan(): Promise<void> {
    // A replan can be in flight when the controller is torn down: the settle
    // wait in replanAfterTransition, the retry after a queue reorder, or the
    // replan fire() does when the queue moved. Without this, that continuation
    // arms the scheduler *after* stop() — a live timer against a disposed
    // engine, which can still fire a transition.
    if (!this.started) return;

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

    const upcoming = player.getUpcomingTracks(5);
    this.nextTrack = upcoming[0] ?? null;
    this.setlist.prefetch(upcoming);

    try {
      const fromAnalysis = await this.analyzer.analyze(from);
      const toAnalysis = this.nextTrack ? await this.analyzer.analyze(this.nextTrack) : null;
      if (token !== this.planToken) return; // superseded while we awaited
      if (!fromAnalysis) return;

      // Look at the whole chain, not just the next pair. This is also where a
      // poor upcoming transition gets a chance to be avoided rather than
      // merely reported.
      const report = await this.setlist.report(from, fromAnalysis, upcoming);
      if (token !== this.planToken) return;
      this.lastSetlist = report;
      this.events.emit("setlist", { report });

      if (settings.queueReordering && report.reorderable && this.reordersThisTrack < 2) {
        const moved = await this.tryReorder(report);
        this.diagnostics.noteQueueReorder(moved);
        if (moved) {
          this.reordersThisTrack++;
          // The queue changed underneath us; replan against the new next track.
          void this.refreshPlan();
          return;
        }
      }

      // tryReorder above awaits queue mutations and a retry sleep. A skip during
      // that window bumps the token, and without this check the plan computed
      // for the *previous* pair goes on to arm the scheduler.
      if (token !== this.planToken) return;

      const plan = calculateTransition({
        fromTrack: from,
        toTrack: this.nextTrack,
        fromAnalysis,
        toAnalysis,
        settings,
        capabilities: this.capabilities,
      });

      this.plan = plan;
      this.diagnostics.notePlanned(plan);
      this.memory.remember(plan, settings.intent);
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

  /**
   * Pull a better-matching user-queued track forward, when the next transition
   * would be poor and the queue model actually allows the move.
   *
   * Deliberately conservative: it only ever promotes a track the user queued
   * themselves, only when the improvement is large, and never the same track
   * twice in one session.
   */
  private async tryReorder(report: SetlistReport): Promise<boolean> {
    if (!player.canMutateQueue()) {
      log.debug("queue reordering unavailable: this client exposes no queue mutation");
      return false;
    }
    const proposal = await this.setlist.proposeReorder(report);
    if (!proposal || this.promoted.has(proposal.promote.uri)) return false;

    // Move it: take it out of its current slot, then put it back at the front.
    const removed = await player.removeFromQueue(proposal.promote.uri);
    if (!removed) {
      log.debug("queue reordering declined by the client — leaving the order alone");
      return false;
    }
    // From here the track is out of the queue. If we cannot put it back the user
    // has silently lost it, so this retries and, failing that, says so out loud
    // rather than swallowing the loss in a debug log.
    let added = await player.addToQueue(proposal.promote.uri);
    if (!added) {
      await new Promise((r) => setTimeout(r, 150));
      added = await player.addToQueue(proposal.promote.uri);
    }
    if (!added) {
      log.error(
        `could not re-queue "${proposal.promote.name}" after removing it — ` +
          "disabling queue reordering to avoid losing anything else",
      );
      player.notify(
        `Smart DJ could not re-queue "${proposal.promote.name}" — queue reordering turned off`,
        true,
        6000,
      );
      this.settings.update({ queueReordering: false });
      return false;
    }

    this.promoted.add(proposal.promote.uri);
    if (this.promoted.size > 100) this.promoted.clear();
    log.info(`reordered the queue: ${proposal.reason}`);
    if (this.settings.get().showNotifications) {
      player.notify(`Smart DJ · moved "${proposal.promote.name}" up for a better mix`);
    }
    return true;
  }

  private arm(plan: TransitionPlan): void {
    // Fire the executor early enough that the *switch* lands on the musical
    // moment, rather than the executor merely starting there.
    const targetMs = (plan.startPointSec - plan.leadInSec) * 1000;
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
      `armed: ${plan.strategy}/${plan.technique} in ${((targetMs - position) / 1000).toFixed(1)}s ` +
        `— switch at ${plan.startPointSec.toFixed(1)}s` +
        (plan.leadInSec > 0 ? ` (lead-in ${plan.leadInSec.toFixed(1)}s)` : "") +
        `, ${plan.durationSec.toFixed(1)}s, ${plan.band} ${(plan.compatibility.overall * 100).toFixed(0)}%`,
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

    // The playhead can jump between arming and firing. The scheduler treats a
    // target that is already behind as "fire now", so a listener scrubbing into
    // the tail would get the transition at whatever arbitrary point they landed
    // on rather than at the musical moment it was computed for.
    const targetSec = plan.startPointSec - plan.leadInSec;
    const positionSec = player.getProgressMs() / 1000;
    if (positionSec > targetSec + OVERSHOOT_TOLERANCE_SEC) {
      log.info(
        `playhead jumped past the planned exit (${positionSec.toFixed(1)}s vs ` +
          `${targetSec.toFixed(1)}s) — replanning instead of firing late`,
      );
      await this.refreshPlan();
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

    const fromStructure = this.analyzer.peek(plan.from.uri)?.structure ?? null;
    const toStructure = plan.to ? (this.analyzer.peek(plan.to.uri)?.structure ?? null) : null;
    const logIndex = this.diagnostics.beginTransition(
      plan,
      sectionRoleAt(fromStructure, plan.startPointSec),
      sectionRoleAt(toStructure, plan.entryPointSec),
    );

    const token = this.planToken;
    const outcome = await this.audio.execute(plan);
    this.diagnostics.endTransition(
      logIndex,
      outcome.status,
      this.audio.lastExecutorId ?? "none",
      outcome.note,
    );

    // What actually happened, not what was planned. This is the artefact that
    // makes a real listening session diagnosable.
    if (this.settings.get().debugMode) this.printRealTimeline(plan, outcome.note);

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
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.status.phase === "recovering") this.setStatus({ phase: "idle", progress: 0 });
    }, 2500);
  }

  /**
   * Print the transition that just ran: the plan alongside the events that
   * actually fired, and anything that was expected but never happened.
   */
  private printRealTimeline(plan: TransitionPlan, note: string): void {
    const record = this.audio.transitionLog.latest();
    if (!record) return;

    const expectFade = plan.executor === "volume-fade";
    const missing = record.missing(expectFade);

    const lines = [
      "",
      "─".repeat(64),
      `SMART DJ — what actually happened`,
      "─".repeat(64),
      `Current      ${plan.from.name}`,
      `Next         ${plan.to?.name ?? "—"}`,
      `Score        ${Math.round(plan.compatibility.overall * 100)}% ${plan.band} · confidence ${Math.round(plan.musicalConfidence * 100)}%`,
      `Strategy     ${plan.strategy} / ${plan.technique}`,
      `Path         ${plan.executor}` +
        (this.audio.lastExecutorId && this.audio.lastExecutorId !== plan.executor
          ? ` → ${this.audio.lastExecutorId} (DEGRADED)`
          : ""),
      `Planned      switch at ${plan.startPointSec.toFixed(2)}s` +
        (plan.leadInSec > 0 ? `, dip starts ${plan.leadInSec.toFixed(2)}s earlier` : ""),
      expectFade
        ? `Fade         ${plan.fade.outSec.toFixed(2)}s down to ${Math.round(plan.fade.floor * 100)}%, ${plan.fade.inSec.toFixed(2)}s back`
        : `Overlap      ${plan.durationSec.toFixed(2)}s programmed into Spotify's mixer`,
      "",
      record.format(),
      "",
      `Outcome      ${record.outcome ?? "unknown"} — ${note}`,
    ];
    if (missing.length > 0) {
      lines.push(`MISSING      ${missing.join(", ")}`);
    }
    lines.push("─".repeat(64), "");
    // Printed as one block so it survives an interleaved console.
    console.log(lines.join("\n"));
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
