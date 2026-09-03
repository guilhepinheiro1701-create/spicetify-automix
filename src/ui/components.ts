/** Tiny DOM builders. No framework — the panel is small and mostly static. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

export function toggleRow(
  label: string,
  hint: string,
  checked: boolean,
  onChange: (v: boolean) => void,
  disabled = false,
): HTMLElement {
  const button = el("button", {
    class: "sdj__toggle",
    role: "switch",
    "aria-checked": String(checked),
    "aria-label": label,
  });
  if (disabled) button.disabled = true;
  button.addEventListener("click", () => {
    const next = button.getAttribute("aria-checked") !== "true";
    button.setAttribute("aria-checked", String(next));
    onChange(next);
  });

  const text = el("div", {}, el("div", { class: "sdj__label" }, label));
  if (hint) text.append(el("div", { class: "sdj__hint" }, hint));

  return el("div", { class: "sdj__row" }, text, button);
}

export function sliderRow(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  format: (v: number) => string,
  onChange: (v: number) => void,
): HTMLElement {
  const readout = el("span", { class: "sdj__value" }, format(value));
  const input = el("input", {
    class: "sdj__slider",
    type: "range",
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    "aria-label": label,
  }) as HTMLInputElement;

  input.addEventListener("input", () => {
    const v = Number(input.value);
    readout.textContent = format(v);
    onChange(v);
  });

  return el(
    "div",
    {},
    el("div", { class: "sdj__row" }, el("span", { class: "sdj__label" }, label), readout),
    input,
  );
}

export function selectRow(
  label: string,
  hint: string,
  options: { value: string; label: string }[],
  value: string,
  onChange: (v: string) => void,
): HTMLElement {
  const select = el("select", { class: "sdj__select", "aria-label": label }) as HTMLSelectElement;
  for (const o of options) {
    const opt = el("option", { value: o.value }, o.label) as HTMLOptionElement;
    if (o.value === value) opt.selected = true;
    select.append(opt);
  }
  select.addEventListener("change", () => onChange(select.value));

  const text = el("div", {}, el("div", { class: "sdj__label" }, label));
  if (hint) text.append(el("div", { class: "sdj__hint" }, hint));

  return el("div", { class: "sdj__row" }, text, select);
}

export function meter(value: number): HTMLElement {
  const fill = el("span", {});
  fill.style.width = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
  return el("div", { class: "sdj__meter" }, fill);
}

export function badge(text: string, tone: "ok" | "warn" | "bad" | "neutral" = "neutral"): HTMLElement {
  const cls = tone === "neutral" ? "sdj__badge" : `sdj__badge sdj__badge--${tone}`;
  return el("span", { class: cls }, text);
}

export function facts(pairs: [string, string | Node][]): HTMLElement {
  const dl = el("dl", { class: "sdj__facts" });
  for (const [k, v] of pairs) {
    dl.append(el("dt", {}, k), el("dd", {}, typeof v === "string" ? v : v));
  }
  return dl;
}

export function section(heading: string, ...children: Node[]): HTMLElement {
  return el("div", { class: "sdj__section" }, el("h3", { class: "sdj__heading" }, heading), ...children);
}
