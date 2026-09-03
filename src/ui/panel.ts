/**
 * The Smart DJ panel.
 *
 * Opened from a button in the playbar, rendered inside Spotify's own modal so
 * it looks like part of the client. Shows what the engine decided for the
 * current pair of tracks, exposes the settings, and — importantly — states
 * plainly which capabilities this client actually has.
 */

import { badge, el, facts, meter, section, selectRow, sliderRow, toggleRow } from "./components.js";
import { injectStyles } from "./styles.js";
import { STYLE_PROFILES } from "../config/styles.js";
import { camelotToString, toCamelot } from "../music/camelot.js";
import { allCapabilities, statusIcon, type CapabilitySet } from "../platform/capabilities.js";
import { DEFAULT_SETTINGS, type Settings } from "../config/defaults.js";
import type { SettingsStore } from "../config/settings.js";
import type { SmartDj } from "../runtime/smartDj.js";
import type { TrackAnalysis, TransitionPlan } from "../core/types.js";
import type { MusicAnalyzer } from "../analysis/analyzer.js";

declare const Spicetify: any;

export interface PanelDeps {
  settings: SettingsStore;
  dj: SmartDj;
  analyzer: MusicAnalyzer;
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

function trackSummary(analysis: TrackAnalysis | null): string {
  if (!analysis) return "not analysed";
  const bits: string[] = [];
  bits.push(analysis.tempo ? `${analysis.tempo.toFixed(0)} BPM` : "BPM ?");
  const cam = analysis.key !== undefined && analysis.mode !== undefined
    ? toCamelot(analysis.key, analysis.mode)
    : null;
  bits.push(cam ? camelotToString(cam) : "key ?");
  bits.push(analysis.energy !== undefined ? `E ${analysis.energy.toFixed(2)}` : "E ?");
  return bits.join(" · ");
}

function statusSection(dj: SmartDj, analyzer: MusicAnalyzer): HTMLElement {
  const plan = dj.getPlan();
  const status = dj.getStatus();

  if (!plan || !plan.to) {
    return section(
      "Current transition",
      el("div", { class: "sdj__hint" }, "Nothing queued to mix into yet."),
    );
  }

  const fromAnalysis = analyzer.peek(plan.from.uri);
  const toAnalysis = analyzer.peek(plan.to.uri);
  const c = plan.compatibility;

  const pair = el(
    "div",
    { class: "sdj__pair" },
    el(
      "div",
      { class: "sdj__track" },
      el("b", {}, plan.from.name),
      el("span", {}, trackSummary(fromAnalysis)),
    ),
    el("div", { class: "sdj__arrow" }, "→"),
    el(
      "div",
      { class: "sdj__track" },
      el("b", {}, plan.to.name),
      el("span", {}, trackSummary(toAnalysis)),
    ),
  );

  const tone = c.overall >= 0.7 ? "ok" : c.overall >= 0.45 ? "warn" : "bad";
  const header = el(
    "div",
    { class: "sdj__row" },
    el("span", { class: "sdj__label" }, "Compatibility"),
    el("span", { class: "sdj__value" }, pct(c.overall)),
  );

  const breakdown = facts([
    ["Tempo", `${pct(c.tempo.score)} — ${c.tempo.detail}`],
    ["Key", `${pct(c.key.score)} — ${c.key.detail}`],
    ["Energy", `${pct(c.energy.score)} — ${c.energy.detail}`],
    ["Phrase", `${pct(c.phrase.score)} — ${c.phrase.detail}`],
    ["Loudness", `${pct(c.loudness.score)} — ${c.loudness.detail}`],
    ["Confidence", pct(c.confidence)],
  ]);

  const planFacts = facts([
    ["Technique", el("span", {}, plan.technique.replace(/-/g, " "), " ", badge(plan.executor.replace(/-/g, " "), tone))],
    [
      "Length",
      plan.durationBeats
        ? `${plan.durationSec.toFixed(1)}s · ${plan.durationBeats} beats`
        : `${plan.durationSec.toFixed(1)}s`,
    ],
    ["Starts at", `${plan.startPointSec.toFixed(1)}s`],
    [
      "Alignment",
      [plan.phraseAlignment ? "phrase" : null, plan.beatAlignment ? "downbeat" : null]
        .filter(Boolean)
        .join(" + ") || "none",
    ],
    ["Status", status.phase + (status.etaSec !== null ? ` · in ${status.etaSec.toFixed(1)}s` : "")],
  ]);

  const progress = meter(status.phase === "transitioning" ? status.progress : 0);

  const why = el("ul", { class: "sdj__list" });
  for (const r of plan.rationale) why.append(el("li", {}, r));

  const children: Node[] = [pair, header, meter(c.overall), breakdown, planFacts, progress, why];

  if (plan.caveats.length > 0) {
    const caveats = el("ul", { class: "sdj__list sdj__caveats" });
    for (const c2 of plan.caveats) caveats.append(el("li", {}, c2));
    children.push(caveats);
  }

  return section("Current transition", ...children);
}

function capabilitySection(caps: CapabilitySet | null): HTMLElement {
  if (!caps) {
    return section("What this client can do", el("div", { class: "sdj__hint" }, "Probing…"));
  }

  const list = el("div", { class: "sdj__facts" });
  for (const cap of allCapabilities(caps)) {
    list.append(
      el("dt", {}, `${statusIcon(cap.status)} ${cap.label}`),
      el("dd", { class: "sdj__hint" }, cap.detail),
    );
  }

  const tierTone = caps.tier === "dj" ? "ok" : caps.tier === "fade" ? "warn" : "bad";
  const tierText =
    caps.tier === "dj"
      ? "Full DJ mode — real audio overlap available"
      : caps.tier === "fade"
        ? "Fade mode — no audio overlap on this client, switches are shaped with volume instead"
        : "Passive — Smart DJ cannot affect playback here";

  return section(
    "What this client can do",
    el("div", { class: "sdj__row" }, el("span", { class: "sdj__label" }, tierText), badge(caps.tier, tierTone)),
    el("div", { class: "sdj__hint" }, `Account: ${caps.productTier}`),
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
  const noOverlap = caps?.nativeCrossfade.status !== "available";

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
        "Smart EQ",
        noOverlap
          ? "Approximated with broadband volume shaping — no per-band control exists."
          : "Planned, but not applicable during a native crossfade. Kept for the fade path.",
        s.smartEq,
        (v) => settings.update({ smartEq: v }),
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

  // ── Capabilities ──────────────────────────────────────────────────────────
  root.append(capabilitySection(caps));

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
