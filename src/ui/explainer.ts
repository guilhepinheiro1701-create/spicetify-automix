/**
 * The Transition Explainer.
 *
 * A checklist of what the engine found and what it decided, in the order a
 * person would ask about it. The point is that every line is derived from the
 * plan's own structured data — the score components and the feature verdicts —
 * so the panel physically cannot claim something the engine did not do.
 *
 * Unavailable and estimated things are marked, not hidden. A user who can see
 * "⚠ structure estimated" understands why a transition was cautious; one who
 * sees only a number does not.
 */

import { badge, el, meter } from "./components.js";
import { describeStructure } from "../analysis/sections.js";
import type { TrackAnalysis, TransitionPlan } from "../core/types.js";

export type CheckState = "yes" | "no" | "warn";

export interface CheckLine {
  state: CheckState;
  text: string;
  /** Shown underneath in smaller type when present. */
  detail?: string;
}

const ICON: Record<CheckState, string> = { yes: "✓", no: "✗", warn: "⚠" };

/**
 * Build the checklist. Pure, so it can be asserted in tests without a DOM —
 * which is how we prove the explainer never contradicts the plan.
 */
export function buildChecklist(
  plan: TransitionPlan,
  fromAnalysis: TrackAnalysis | null,
  toAnalysis: TrackAnalysis | null,
): CheckLine[] {
  const lines: CheckLine[] = [];
  const c = plan.compatibility;

  // ── What the two tracks have in common ──────────────────────────────────
  const known = (component: { confidence: number }) => component.confidence > 0;

  lines.push(
    !known(c.tempo)
      ? { state: "warn", text: "Tempo unavailable", detail: "scored neutrally" }
      : {
          state: c.tempo.score >= 0.75 ? "yes" : c.tempo.score >= 0.5 ? "warn" : "no",
          text: c.tempo.score >= 0.75 ? "BPM compatible" : "BPM differs",
          detail: c.tempo.detail,
        },
  );

  lines.push(
    !known(c.key)
      ? { state: "warn", text: "Key unavailable", detail: "scored neutrally" }
      : {
          state: c.key.score >= 0.8 ? "yes" : c.key.score >= 0.5 ? "warn" : "no",
          text: c.key.score >= 0.8 ? "Harmonic" : "Keys clash",
          detail: c.key.detail,
        },
  );

  lines.push(
    !known(c.energy)
      ? { state: "warn", text: "Energy unavailable", detail: "scored neutrally" }
      : {
          state: c.energy.score >= 0.7 ? "yes" : c.energy.score >= 0.45 ? "warn" : "no",
          text: c.energy.score >= 0.7 ? "Similar energy" : "Energy step",
          detail: c.energy.detail,
        },
  );

  lines.push(
    !known(c.loudness)
      ? { state: "warn", text: "Loudness unavailable" }
      : {
          state: c.loudness.score >= 0.8 ? "yes" : "warn",
          text: c.loudness.score >= 0.8 ? "Levels match" : "Level difference",
          detail: c.loudness.detail,
        },
  );

  // ── What the structure gave us ──────────────────────────────────────────
  const fromStruct = fromAnalysis?.structure;
  const toStruct = toAnalysis?.structure;

  if (!fromStruct?.known) {
    lines.push({ state: "warn", text: "Structure estimated", detail: "no sections for track A" });
  } else if (fromStruct.outro) {
    lines.push({
      state: "yes",
      text: "Outro detected",
      detail: `${fromStruct.outroRunwaySec.toFixed(0)}s of mixable tail`,
    });
  } else {
    lines.push({
      state: "warn",
      text: "No outro",
      detail: "track A ends without a low-energy tail",
    });
  }

  if (!toStruct?.known) {
    lines.push({ state: "warn", text: "Structure estimated", detail: "no sections for track B" });
  } else if (toStruct.intro) {
    lines.push({
      state: "yes",
      text: "Intro detected",
      detail: `${toStruct.introRunwaySec.toFixed(0)}s to come up in`,
    });
  } else {
    lines.push({
      state: "warn",
      text: "No intro",
      detail: "track B starts at full energy",
    });
  }

  // ── What we did about it ────────────────────────────────────────────────
  lines.push(
    plan.phraseAlignment
      ? { state: "yes", text: "Phrase boundary matched" }
      : { state: "warn", text: "Not phrase-aligned", detail: "no confident grid to land on" },
  );

  // Feature verdicts carry the machine-readable reason, so the "why not" here
  // is the engine's own answer rather than a guess made in the UI.
  for (const v of plan.verdicts) {
    if (v.feature === "phrase-alignment") continue; // already covered above
    if (v.used) {
      lines.push({ state: "yes", text: featureLabel(v.feature), detail: v.detail });
    } else if (v.code === "disabled-by-user") {
      continue; // the user turned it off; not a limitation worth flagging
    } else {
      lines.push({
        state: v.code === "capability-unavailable" ? "no" : "warn",
        text: `${featureLabel(v.feature)} not used`,
        detail: v.detail,
      });
    }
  }

  return lines;
}

function featureLabel(feature: TransitionPlan["verdicts"][number]["feature"]): string {
  switch (feature) {
    case "audio-overlap":
      return "Real audio overlap";
    case "beat-alignment":
      return "Downbeat alignment";
    case "phrase-alignment":
      return "Phrase alignment";
    case "fade-shaping":
      return "Fade shaping";
    case "intro-skip":
      return "Intro skip";
    case "loudness-match":
      return "Loudness match";
    case "tempo-adjustment":
      return "Beatmatching";
    default:
      return feature;
  }
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** Render the explainer. */
export function renderExplainer(
  plan: TransitionPlan,
  fromAnalysis: TrackAnalysis | null,
  toAnalysis: TrackAnalysis | null,
): HTMLElement {
  const root = el("div", { class: "sdj__explainer" });

  const tone =
    plan.band === "PERFECT" || plan.band === "EXCELLENT"
      ? "ok"
      : plan.band === "POOR" || plan.band === "VERY POOR"
        ? "bad"
        : "warn";

  root.append(
    el(
      "div",
      { class: "sdj__pair" },
      el("div", { class: "sdj__track" }, el("b", {}, plan.from.name)),
      el("div", { class: "sdj__arrow" }, "→"),
      el("div", { class: "sdj__track" }, el("b", {}, plan.to?.name ?? "—")),
    ),
    el(
      "div",
      { class: "sdj__headline" },
      el("span", { class: "sdj__headline-score" }, pct(plan.compatibility.overall)),
      badge(plan.band, tone),
    ),
    meter(plan.compatibility.overall),
  );

  // Musical confidence is a different question from technical fit, so it gets
  // its own line rather than being folded into the headline number.
  root.append(
    el(
      "div",
      { class: "sdj__row", style: "margin-top:10px" },
      el(
        "div",
        {},
        el("div", { class: "sdj__label" }, "Will it sound good?"),
        el("div", { class: "sdj__hint" }, plan.confidenceFactors.join("; ")),
      ),
      el(
        "span",
        { class: "sdj__value" },
        `${pct(plan.musicalConfidence)} ${plan.musicalConfidenceLabel}`,
      ),
    ),
  );

  const list = el("ul", { class: "sdj__checks" });
  for (const line of buildChecklist(plan, fromAnalysis, toAnalysis)) {
    const li = el("li", { class: `sdj__check sdj__check--${line.state}` });
    li.append(
      el("span", { class: "sdj__check-icon" }, ICON[line.state]),
      el("span", {}, line.text),
    );
    if (line.detail) li.append(el("span", { class: "sdj__check-detail" }, line.detail));
    list.append(li);
  }
  root.append(list);

  root.append(
    el(
      "div",
      { class: "sdj__facts", style: "margin-top:12px" },
      el("dt", {}, "Strategy"),
      el("dd", {}, plan.strategy.replace(/-/g, " ").toUpperCase()),
      el("dt", {}, "Duration"),
      el(
        "dd",
        {},
        plan.durationBeats ? `${plan.durationBeats} beats` : `${plan.durationSec.toFixed(1)}s`,
      ),
      el("dt", {}, "Structure"),
      el(
        "dd",
        {},
        `${fromAnalysis?.structure ? describeStructure(fromAnalysis.structure) : "A unknown"} → ${
          toAnalysis?.structure ? describeStructure(toAnalysis.structure) : "B unknown"
        }`,
      ),
    ),
  );

  return root;
}
