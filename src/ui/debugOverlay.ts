/**
 * Debug heads-up display.
 *
 * A small always-on-top readout of exactly what the engine is doing right now.
 * It updates on status changes plus a slow tick for the countdown, so it costs
 * essentially nothing when nothing is happening.
 */

import { injectStyles } from "./styles.js";
import { camelotToString, toCamelot } from "../music/camelot.js";
import { describeStructure } from "../analysis/sections.js";
import type { MusicAnalyzer } from "../analysis/analyzer.js";
import type { SmartDj } from "../runtime/smartDj.js";
import type { TrackAnalysis } from "../core/types.js";

const TICK_MS = 500;

const fmtBpm = (a: TrackAnalysis | null): string =>
  a?.tempo ? a.tempo.toFixed(0) : "?";

const fmtKey = (a: TrackAnalysis | null): string => {
  if (!a || a.key === undefined || a.mode === undefined) return "?";
  return camelotToString(toCamelot(a.key, a.mode));
};

const fmtEnergy = (a: TrackAnalysis | null): string =>
  a?.energy !== undefined ? a.energy.toFixed(2) : "?";

export class DebugOverlay {
  private root: HTMLElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly dj: SmartDj,
    private readonly analyzer: MusicAnalyzer,
  ) {}

  show(): void {
    if (this.root || typeof document === "undefined") return;
    injectStyles();

    this.root = document.createElement("div");
    this.root.className = "sdj-hud";
    document.body.appendChild(this.root);

    this.unsubscribe = this.dj.events.on("status", () => this.render());
    this.timer = setInterval(() => {
      this.dj.refreshEta();
      this.render();
    }, TICK_MS);
    this.render();
  }

  hide(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.root?.remove();
    this.root = null;
  }

  get visible(): boolean {
    return this.root !== null;
  }

  private render(): void {
    if (!this.root) return;

    const plan = this.dj.getPlan();
    const status = this.dj.getStatus();
    const caps = this.dj.getCapabilities();

    const from = plan ? this.analyzer.peek(plan.from.uri) : null;
    const to = plan?.to ? this.analyzer.peek(plan.to.uri) : null;

    const stateClass =
      status.phase === "transitioning"
        ? "sdj-hud__state"
        : status.phase === "idle" || status.phase === "disabled"
          ? "sdj-hud__state sdj-hud__state--idle"
          : "sdj-hud__state sdj-hud__state--warn";

    const setlist = this.dj.getSetlist();
    const chain = setlist
      ? setlist.links.map((l) => `${Math.round(l.score * 100)}`).join(" · ")
      : "—";

    const rows: [string, string][] = [
      ["Current", plan?.from.name ?? "—"],
      ["Next", plan?.to?.name ?? "—"],
      ["BPM", `${fmtBpm(from)} → ${fmtBpm(to)}`],
      ["Key", `${fmtKey(from)} → ${fmtKey(to)}`],
      ["Energy", `${fmtEnergy(from)} → ${fmtEnergy(to)}`],
      [
        "Match",
        plan
          ? `${Math.round(plan.compatibility.overall * 100)}% ${plan.band} (conf ${Math.round(plan.compatibility.confidence * 100)}%)`
          : "—",
      ],
      ["Strategy", plan ? plan.strategy.toUpperCase() : "—"],
      [
        "Plan",
        plan
          ? `${plan.technique} / ${plan.durationBeats ? `${plan.durationBeats} beats` : `${plan.durationSec.toFixed(1)}s`}`
          : "—",
      ],
      [
        "Runway",
        plan
          ? plan.windowLimitedBy === "unknown"
            ? "unknown"
            : `${plan.mixableWindowSec.toFixed(1)}s (${plan.windowLimitedBy})`
          : "—",
      ],
      ["Structure", from?.structure ? describeStructure(from.structure) : "—"],
      ["Phrase", plan ? (plan.phraseAlignment ? "matched" : "free") : "—"],
      [
        "Downbeat",
        plan
          ? plan.beatAlignment
            ? `locked −${(plan.phaseOffsetSec * 1000).toFixed(0)}ms`
            : "no"
          : "—",
      ],
      ["Chain", chain],
      ["Path", plan?.executor ?? caps?.tier ?? "—"],
      ["Source", from ? from.source : "—"],
      ["ETA", status.etaSec !== null ? `${status.etaSec.toFixed(1)}s` : "—"],
    ];

    const dl = rows
      .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
      .join("");

    const progress = status.phase === "transitioning" ? status.progress : 0;

    this.root.innerHTML =
      `<h4>Smart DJ · debug</h4>` +
      `<dl>${dl}<dt>Status</dt><dd class="${stateClass}">${escapeHtml(status.phase.toUpperCase())}</dd></dl>` +
      `<div class="sdj-hud__bar"><span style="width:${Math.round(progress * 100)}%"></span></div>` +
      (status.lastError ? `<div style="margin-top:6px;color:#ff6b5e">${escapeHtml(status.lastError)}</div>` : "");
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
