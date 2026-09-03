/**
 * The Smart DJ panel.
 *
 * Opened from a button in the playbar, rendered inside Spotify's own modal so
 * it looks like part of the client. Shows what the engine decided for the
 * current pair of tracks, exposes the settings, and — importantly — states
 * plainly which capabilities this client actually has.
 */

import { badge, el, meter, section, selectRow, sliderRow, toggleRow } from "./components.js";
import { injectStyles } from "./styles.js";
import { STYLE_PROFILES } from "../config/styles.js";
import {
  allCapabilities,
  explainUnavailable,
  statusIcon,
  type CapabilitySet,
} from "../platform/capabilities.js";
import { renderExplainer } from "./explainer.js";
import { INTENT_PROFILES } from "../config/intent.js";
import type { DjIntent } from "../config/intent.js";
import type { SetlistReport } from "../queue/setlist.js";
import { DEFAULT_SETTINGS, type Settings } from "../config/defaults.js";
import type { SettingsStore } from "../config/settings.js";
import type { SmartDj } from "../runtime/smartDj.js";
import type { MusicAnalyzer } from "../analysis/analyzer.js";

declare const Spicetify: any;

export interface PanelDeps {
  settings: SettingsStore;
  dj: SmartDj;
  analyzer: MusicAnalyzer;
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

const bandTone = (band: string): "ok" | "warn" | "bad" =>
  band === "PERFECT" || band === "EXCELLENT" ? "ok" : band === "POOR" ? "bad" : "warn";

function statusSection(dj: SmartDj, analyzer: MusicAnalyzer): HTMLElement {
  const plan = dj.getPlan();
  const status = dj.getStatus();

  if (!plan || !plan.to) {
    return section(
      "This transition",
      el("div", { class: "sdj__hint" }, "Nothing queued to mix into yet."),
    );
  }

  const fromAnalysis = analyzer.peek(plan.from.uri);
  const toAnalysis = analyzer.peek(plan.to.uri);

  const children: Node[] = [renderExplainer(plan, fromAnalysis, toAnalysis)];

  children.push(
    el(
      "div",
      { class: "sdj__row", style: "margin-top:12px" },
      el("span", { class: "sdj__label" }, "Status"),
      el(
        "span",
        { class: "sdj__value" },
        status.phase + (status.etaSec !== null ? ` · in ${status.etaSec.toFixed(1)}s` : ""),
      ),
    ),
    meter(status.phase === "transitioning" ? status.progress : 0),
  );

  const why = el("ul", { class: "sdj__list" });
  for (const r of plan.rationale) why.append(el("li", {}, r));
  children.push(why);

  return section("This transition", ...children);
}

function setlistSection(report: SetlistReport | null): HTMLElement {
  if (!report || report.links.length === 0) {
    return section("Coming up", el("div", { class: "sdj__hint" }, "Nothing queued yet."));
  }

  const rows = el("div", { class: "sdj__facts" });
  for (const link of report.links) {
    const tone = bandTone(link.band.toUpperCase());
    rows.append(
      el(
        "dt",
        {},
        `${link.index === 0 ? "next" : `+${link.index}`}`,
      ),
      el(
        "dd",
        {},
        el("span", {}, `${link.from.name} → ${link.to.name} `),
        badge(`${Math.round(link.score * 100)}%`, tone),
      ),
    );
  }

  const children: Node[] = [
    el(
      "div",
      { class: "sdj__row" },
      el("span", { class: "sdj__label" }, "Set flow"),
      el("span", { class: "sdj__value" }, pct(report.flowScore)),
    ),
    meter(report.flowScore),
    rows,
  ];

  if (report.weakLinks.length > 0) {
    const worst = report.weakLinks[0] as SetlistReport["weakLinks"][number];
    children.push(
      el(
        "div",
        { class: "sdj__hint sdj__caveats" },
        `Weakest link: ${worst.from.name} → ${worst.to.name} at ${Math.round(worst.score * 100)}%. ${report.reorderNote}.`,
      ),
    );
  } else {
    children.push(el("div", { class: "sdj__hint" }, report.reorderNote));
  }

  return section("Coming up", ...children);
}

function statTile(value: string, label: string): HTMLElement {
  return el("div", { class: "sdj__stat" }, el("b", {}, value), el("span", {}, label));
}

function diagnosticsSection(dj: SmartDj): HTMLElement {
  const d = dj.diagnostics.snapshot();
  const stats = el(
    "div",
    { class: "sdj__stats" },
    statTile(String(d.transitionsAttempted), "attempted"),
    statTile(String(d.completed), "completed"),
    statTile(`${Math.round(d.averageScore * 100)}%`, "avg score"),
    statTile(`${Math.round(d.averageConfidence * 100)}%`, "avg confidence"),
    statTile(String(d.degraded), "degraded"),
    statTile(String(d.aborted + d.failed), "interrupted"),
    statTile(String(d.poorTransitions), "poor pairs"),
    statTile(String(d.queueFailures), "queue failures"),
  );

  const children: Node[] = [
    el(
      "div",
      { class: "sdj__hint" },
      `${(d.uptimeMs / 60000).toFixed(0)} min of listening · ` +
        `${d.crossfadeTransitions} overlap, ${d.fadeTransitions} fade, ${d.passiveTransitions} passive. ` +
        "Everything here stays on this machine.",
    ),
    stats,
  ];

  const bands = Object.entries(d.bandCounts);
  if (bands.length > 0) {
    children.push(
      el(
        "div",
        { class: "sdj__hint" },
        `Bands: ${bands.map(([b, n]) => `${b} ${n}`).join(" · ")}`,
      ),
    );
  }

  const logText = dj.diagnostics.formatLog();
  children.push(el("div", { class: "sdj__log" }, logText));

  const copy = el("button", { class: "sdj__btn" }, "Copy session log");
  copy.addEventListener("click", () => {
    try {
      void navigator.clipboard?.writeText(logText);
    } catch {
      /* clipboard unavailable — the log is on screen anyway */
    }
  });
  const reset = el("button", { class: "sdj__btn" }, "Reset");
  reset.addEventListener("click", () => dj.diagnostics.reset());
  children.push(el("div", { class: "sdj__row", style: "margin-top:10px" }, copy, reset));

  return section("Diagnostics", ...children);
}

function capabilitySection(caps: CapabilitySet | null): HTMLElement {
  if (!caps) {
    return section("Compatibility", el("div", { class: "sdj__hint" }, "Probing…"));
  }

  const list = el("div", { class: "sdj__facts" });
  for (const cap of allCapabilities(caps)) {
    list.append(
      el("dt", {}, `${statusIcon(cap.status)} ${cap.label}`),
      el("dd", { class: "sdj__hint" }, explainUnavailable(cap)),
    );
  }

  const tierTone = caps.tier === "dj" ? "ok" : caps.tier === "fade" ? "warn" : "bad";
  const tierText =
    caps.tier === "dj"
      ? "Full DJ mode — real audio overlap available"
      : caps.tier === "fade"
        ? "Fade mode — no audio overlap on this client, switches are shaped with volume instead"
        : "Passive — Smart DJ cannot affect playback here";

  const versions = [
    caps.spicetifyVersion ? `Spicetify ${caps.spicetifyVersion}` : null,
    caps.spotifyVersion ? `Spotify ${caps.spotifyVersion}` : null,
    caps.platform,
    `account ${caps.productTier}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return section(
    "Compatibility",
    el(
      "div",
      { class: "sdj__row" },
      el("span", { class: "sdj__label" }, tierText),
      badge(caps.tier, tierTone),
    ),
    el("div", { class: "sdj__hint" }, versions),
    el("div", { style: "height:8px" }),
    list,
  );
}

export function buildPanel(deps: PanelDeps): HTMLElement {
  injectStyles();
  const { settings, dj, analyzer } = deps;
  const s = settings.get();
  const root = el("div", { class: "sdj" });

  const rerender = () => {
    const fresh = buildPanel(deps);
    root.replaceWith(fresh);
  };

  // ── Master ────────────────────────────────────────────────────────────────
  root.append(
    section(
      "Smart DJ",
      toggleRow("Enabled", "Analyse every transition and mix accordingly.", s.enabled, (v) => {
        settings.update({ enabled: v });
      }),
      selectRow(
        "DJ intent",
        INTENT_PROFILES[s.intent]?.description ?? "",
        Object.values(INTENT_PROFILES).map((p) => ({ value: p.id, label: p.label })),
        s.intent,
        (v) => {
          settings.update({ intent: v as DjIntent });
          rerender();
        },
      ),
      selectRow(
        "Style",
        STYLE_PROFILES[s.style]?.description ?? "",
        Object.values(STYLE_PROFILES).map((p) => ({ value: p.id, label: p.label })),
        s.style,
        (v) => {
          settings.update({ style: v as Settings["style"] });
          rerender();
        },
      ),
      sliderRow("Intensity", 0, 1, 0.05, s.intensity, (v) => pct(v), (v) =>
        settings.update({ intensity: v }),
      ),
      el(
        "div",
        { class: "sdj__hint" },
        "How far the engine may push toward long, obvious mixes. It still shortens the blend on its own when two tracks do not fit.",
      ),
    ),
  );

  // ── Techniques ────────────────────────────────────────────────────────────
  const caps = dj.getCapabilities();
  const noOverlap = !caps?.flags.crossfade;

  root.append(
    section(
      "Techniques",
      toggleRow(
        "Beat alignment",
        "Land the switch on a downbeat. True beatmatching is impossible here — see the capability list.",
        s.beatMatching,
        (v) => settings.update({ beatMatching: v }),
      ),
      toggleRow("Harmonic mixing", "Score key compatibility on the Camelot wheel.", s.harmonicMixing, (v) =>
        settings.update({ harmonicMixing: v }),
      ),
      toggleRow(
        "Phrase matching",
        "Only switch on 8/16/32-beat phrase boundaries.",
        s.phraseMatching,
        (v) => settings.update({ phraseMatching: v }),
      ),
      toggleRow(
        "Fade shaping",
        noOverlap
          ? "Front-loads the fade so the outgoing track clears out sooner — the audible half of a bass swap. Not an equaliser: no per-band control exists here."
          : "Only affects the fade path. During a native crossfade Spotify owns both streams and nothing can shape them.",
        s.fadeShaping,
        (v) => settings.update({ fadeShaping: v }),
      ),
      toggleRow("Energy matching", "Prefer a gentle lift over a jarring jump.", s.energyMatching, (v) =>
        settings.update({ energyMatching: v }),
      ),
      toggleRow(
        "Loudness normalization",
        "Attenuate the incoming track when it is markedly louder.",
        s.loudnessNormalization,
        (v) => settings.update({ loudnessNormalization: v }),
      ),
    ),
  );

  // ── Live status ───────────────────────────────────────────────────────────
  root.append(statusSection(dj, analyzer));

  // ── The chain, not just the next pair ────────────────────────────────────
  root.append(setlistSection(dj.getSetlist()));

  // ── Capabilities ──────────────────────────────────────────────────────────
  root.append(capabilitySection(caps));

  // ── Diagnostics, when the user has asked to see them ─────────────────────
  if (s.debugMode) root.append(diagnosticsSection(dj));

  // ── Advanced ──────────────────────────────────────────────────────────────
  const advanced = el("details", { class: "sdj__advanced" }, el("summary", {}, "Advanced settings"));

  advanced.append(
    sliderRow("Minimum length", 0.5, 12, 0.5, s.minDurationSec, (v) => `${v.toFixed(1)}s`, (v) =>
      settings.update({ minDurationSec: v }),
    ),
    sliderRow("Maximum length", 1, 12, 0.5, s.maxDurationSec, (v) => `${v.toFixed(1)}s`, (v) =>
      settings.update({ maxDurationSec: v }),
    ),
    sliderRow(
      "Blend floor",
      0,
      0.9,
      0.05,
      s.minCompatibilityForBlend,
      (v) => pct(v),
      (v) => settings.update({ minCompatibilityForBlend: v }),
    ),
    el(
      "div",
      { class: "sdj__hint" },
      "Below this compatibility the engine refuses to overlap and switches cleanly instead.",
    ),
    selectRow(
      "Fade curve",
      "Used when the style is Custom, and on the fade path.",
      [
        { value: "equal-power", label: "Equal power" },
        { value: "s-curve", label: "S-curve" },
        { value: "linear", label: "Linear" },
        { value: "exponential", label: "Exponential" },
      ],
      s.fadeCurve,
      (v) => settings.update({ fadeCurve: v as Settings["fadeCurve"] }),
    ),
    toggleRow("Auto mode", "Let the engine size each transition itself.", s.autoMode, (v) =>
      settings.update({ autoMode: v }),
    ),
    sliderRow(
      "Switch latency",
      -300,
      300,
      10,
      s.switchLatencyMs,
      (v) => `${v} ms`,
      (v) => settings.update({ switchLatencyMs: v }),
    ),
    el(
      "div",
      { class: "sdj__hint" },
      "How long your client takes to actually change track. Not measurable from inside Spotify, so dial it in by ear if downbeat alignment sounds early or late.",
    ),
    toggleRow(
      "Reorder the queue",
      "Pull a better-matching track forward when the next transition would be poor. Only affects tracks you queued yourself — playlist order is never changed.",
      s.queueReordering,
      (v) => settings.update({ queueReordering: v }),
    ),
    toggleRow(
      "Skip dead intros",
      "Start the incoming track past a measurably quiet opening. Fade path only.",
      s.skipDeadIntro,
      (v) => settings.update({ skipDeadIntro: v }),
    ),
    toggleRow(
      "Preserve album segues",
      "Never mix between consecutive tracks from the same album.",
      s.preserveAlbumGapless,
      (v) => settings.update({ preserveAlbumGapless: v }),
    ),
    toggleRow("Notifications", "Show a bubble on each transition.", s.showNotifications, (v) =>
      settings.update({ showNotifications: v }),
    ),
    toggleRow(
      "Debug mode",
      "Verbose logging and a live heads-up display over the player.",
      s.debugMode,
      (v) => settings.update({ debugMode: v }),
    ),
  );

  // ── External provider (privacy-sensitive, so it explains itself) ──────────
  const providerUrl = el("input", {
    class: "sdj__input",
    type: "url",
    placeholder: "https://your-analysis-service/analysis",
    value: s.externalProviderUrl,
  }) as HTMLInputElement;
  providerUrl.addEventListener("change", () =>
    settings.update({ externalProviderUrl: providerUrl.value.trim() }),
  );

  advanced.append(
    el("div", { style: "height:10px" }),
    el("div", { class: "sdj__heading" }, "Custom analysis endpoint"),
    el(
      "div",
      { class: "sdj__hint" },
      "Off by default. When enabled, Smart DJ sends one HTTPS GET per unknown track containing only its Spotify id, title and artist — no account identifier, no listening history, no audio. It uses the browser's fetch, never Spicetify's Cosmos client, so your Spotify session token is never attached.",
    ),
    providerUrl,
    toggleRow(
      "Use custom endpoint",
      "Requires an https:// URL above.",
      s.externalProviderEnabled,
      (v) => settings.update({ externalProviderEnabled: v }),
    ),
  );

  const cacheStats = analyzer.cache.stats();
  advanced.append(
    el("div", { style: "height:10px" }),
    el(
      "div",
      { class: "sdj__row" },
      el(
        "div",
        {},
        el("div", { class: "sdj__label" }, "Analysis cache"),
        el(
          "div",
          { class: "sdj__hint" },
          `${cacheStats.persistent} tracks stored, ${cacheStats.memory} hot. Stored locally only.`,
        ),
      ),
      (() => {
        const btn = el("button", { class: "sdj__btn" }, "Clear");
        btn.addEventListener("click", () => {
          analyzer.cache.clear();
          rerender();
        });
        return btn;
      })(),
    ),
    el(
      "div",
      { class: "sdj__row" },
      el("div", { class: "sdj__label" }, "Reset all settings"),
      (() => {
        const btn = el("button", { class: "sdj__btn" }, "Reset");
        btn.addEventListener("click", () => {
          settings.update({ ...DEFAULT_SETTINGS });
          rerender();
        });
        return btn;
      })(),
    ),
  );

  root.append(el("div", { class: "sdj__section" }, advanced));
  return root;
}

export function openPanel(deps: PanelDeps): void {
  try {
    Spicetify.PopupModal.display({
      title: "Smart DJ",
      content: buildPanel(deps),
      isLarge: true,
    });
  } catch (err) {
    console.error("[SmartDJ] could not open the panel", err);
  }
}
