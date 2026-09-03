/**
 * Panel styling.
 *
 * Everything is expressed through Spicetify's own CSS custom properties
 * (`--spice-*`), which every theme defines. That way Smart DJ inherits the
 * user's theme instead of imposing a look of its own, and it keeps matching
 * when they change themes.
 */

export const PANEL_STYLES = `
.sdj {
  --sdj-accent: var(--spice-button-active, #1ed760);
  --sdj-text: var(--spice-text, #fff);
  --sdj-subtext: var(--spice-subtext, #b3b3b3);
  --sdj-surface: var(--spice-card, rgba(255,255,255,.06));
  --sdj-line: rgba(255,255,255,.10);
  font-family: var(--font-family, 'CircularSp', 'Spotify Circular', system-ui, sans-serif);
  color: var(--sdj-text);
  min-width: 340px;
}
.sdj *, .sdj *::before, .sdj *::after { box-sizing: border-box; }

.sdj__section { padding: 14px 0; border-bottom: 1px solid var(--sdj-line); }
.sdj__section:last-child { border-bottom: none; }
.sdj__heading {
  font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase;
  color: var(--sdj-subtext); margin: 0 0 12px;
}
.sdj__row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.sdj__row:last-child { margin-bottom: 0; }
.sdj__label { font-size: 14px; font-weight: 500; }
.sdj__hint { font-size: 11px; color: var(--sdj-subtext); margin-top: 2px; line-height: 1.4; }
.sdj__value { font-size: 13px; font-weight: 700; color: var(--sdj-accent); font-variant-numeric: tabular-nums; }

/* Toggle */
.sdj__toggle {
  position: relative; width: 38px; height: 21px; flex: 0 0 auto; padding: 0;
  border: none; border-radius: 11px; cursor: pointer;
  background: var(--spice-button-disabled, #535353); transition: background .18s ease;
}
.sdj__toggle[aria-checked="true"] { background: var(--sdj-accent); }
.sdj__toggle::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 17px; height: 17px;
  border-radius: 50%; background: #fff; transition: transform .18s ease;
  box-shadow: 0 1px 3px rgba(0,0,0,.35);
}
.sdj__toggle[aria-checked="true"]::after { transform: translateX(17px); }
.sdj__toggle:disabled { opacity: .4; cursor: not-allowed; }

/* Slider */
.sdj__slider {
  -webkit-appearance: none; appearance: none; width: 100%; height: 4px; border-radius: 2px;
  background: var(--spice-button-disabled, #535353); outline: none; cursor: pointer; margin: 6px 0 2px;
}
.sdj__slider::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; width: 13px; height: 13px; border-radius: 50%;
  background: var(--sdj-text); cursor: pointer; transition: transform .15s ease, background .15s ease;
}
.sdj__slider:hover::-webkit-slider-thumb { background: var(--sdj-accent); transform: scale(1.2); }

/* Select */
.sdj__select {
  background: var(--sdj-surface); color: var(--sdj-text); border: 1px solid var(--sdj-line);
  border-radius: 4px; padding: 6px 10px; font-size: 13px; font-family: inherit; cursor: pointer;
  min-width: 130px;
}
.sdj__select:focus { outline: 2px solid var(--sdj-accent); outline-offset: 1px; }

/* Text input */
.sdj__input {
  background: var(--sdj-surface); color: var(--sdj-text); border: 1px solid var(--sdj-line);
  border-radius: 4px; padding: 6px 10px; font-size: 12px; font-family: inherit; width: 100%;
}

/* Meter */
.sdj__meter { height: 6px; border-radius: 3px; background: var(--spice-button-disabled, #535353); overflow: hidden; }
.sdj__meter > span { display: block; height: 100%; border-radius: 3px; background: var(--sdj-accent); transition: width .25s ease; }

/* Now/next */
.sdj__pair { display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; align-items: center; margin-bottom: 10px; }
.sdj__track { min-width: 0; }
.sdj__track b { display: block; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sdj__track span { display: block; font-size: 11px; color: var(--sdj-subtext); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sdj__arrow { color: var(--sdj-accent); font-size: 16px; }

/* Facts table */
.sdj__facts { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 12px; }
.sdj__facts dt { color: var(--sdj-subtext); }
.sdj__facts dd { margin: 0; font-variant-numeric: tabular-nums; }

/* Badges */
.sdj__badge {
  display: inline-block; padding: 2px 7px; border-radius: 3px; font-size: 10px; font-weight: 700;
  letter-spacing: .06em; text-transform: uppercase; background: var(--sdj-surface); color: var(--sdj-subtext);
}
.sdj__badge--ok { background: rgba(30,215,96,.16); color: var(--sdj-accent); }
.sdj__badge--warn { background: rgba(255,193,7,.16); color: #ffc107; }
.sdj__badge--bad { background: rgba(244,67,54,.16); color: #ff6b5e; }

.sdj__list { margin: 0; padding-left: 16px; font-size: 11.5px; color: var(--sdj-subtext); line-height: 1.55; }
.sdj__list li { margin-bottom: 3px; }
.sdj__caveats { color: #ffc107; }

.sdj__advanced > summary {
  cursor: pointer; font-size: 11px; font-weight: 700; letter-spacing: .12em;
  text-transform: uppercase; color: var(--sdj-subtext); list-style: none; padding: 4px 0;
}
.sdj__advanced > summary::-webkit-details-marker { display: none; }
.sdj__advanced > summary::before { content: '▸ '; }
.sdj__advanced[open] > summary::before { content: '▾ '; }

.sdj__btn {
  background: transparent; color: var(--sdj-subtext); border: 1px solid var(--sdj-line);
  border-radius: 16px; padding: 5px 14px; font-size: 12px; font-family: inherit; cursor: pointer;
  transition: color .15s, border-color .15s;
}
.sdj__btn:hover { color: var(--sdj-text); border-color: var(--sdj-text); }

/* Debug HUD */
.sdj-hud {
  position: fixed; right: 16px; bottom: 96px; z-index: 9999;
  width: 300px; padding: 12px 14px; border-radius: 8px;
  background: rgba(10,10,10,.92); border: 1px solid rgba(255,255,255,.12);
  backdrop-filter: blur(12px);
  font-family: 'SFMono-Regular', ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px; line-height: 1.6; color: #e8e8e8;
  pointer-events: none; user-select: none;
}
.sdj-hud h4 {
  margin: 0 0 8px; font-size: 10px; letter-spacing: .16em; text-transform: uppercase;
  color: #1ed760; font-family: var(--font-family, sans-serif);
}
.sdj-hud dl { display: grid; grid-template-columns: 74px 1fr; gap: 1px 8px; margin: 0; }
.sdj-hud dt { color: #8a8a8a; }
.sdj-hud dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sdj-hud__bar { height: 3px; margin-top: 8px; border-radius: 2px; background: #303030; overflow: hidden; }
.sdj-hud__bar > span { display: block; height: 100%; background: #1ed760; transition: width .1s linear; }
.sdj-hud__state { color: #1ed760; font-weight: 700; }
.sdj-hud__state--idle { color: #8a8a8a; }
.sdj-hud__state--warn { color: #ffc107; }
`;

let injected = false;

export function injectStyles(): void {
  if (injected || typeof document === "undefined") return;
  const el = document.createElement("style");
  el.id = "smart-dj-styles";
  el.textContent = PANEL_STYLES;
  document.head.appendChild(el);
  injected = true;
}
