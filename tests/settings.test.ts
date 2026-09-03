import { describe, expect, it, vi } from "vitest";
import { SettingsStore, sanitize } from "../src/config/settings.js";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from "../src/config/defaults.js";
import { memoryStorage } from "./helpers.js";

describe("sanitize", () => {
  it("returns the defaults for junk input", () => {
    expect(sanitize(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitize(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitize("not an object")).toEqual(DEFAULT_SETTINGS);
    expect(sanitize(42)).toEqual(DEFAULT_SETTINGS);
  });

  it("clamps numbers into range instead of rejecting them", () => {
    const s = sanitize({ intensity: 99, minDurationSec: -5, maxDurationSec: 900 });
    expect(s.intensity).toBe(1);
    expect(s.minDurationSec).toBeGreaterThanOrEqual(0.5);
    expect(s.maxDurationSec).toBeLessThanOrEqual(12);
  });

  it("keeps min ≤ max by swapping rather than discarding", () => {
    const s = sanitize({ minDurationSec: 9, maxDurationSec: 3 });
    expect(s.minDurationSec).toBe(3);
    expect(s.maxDurationSec).toBe(9);
  });

  it("falls back on an unknown style or curve", () => {
    const s = sanitize({ style: "techno-god", fadeCurve: "warp" });
    expect(s.style).toBe(DEFAULT_SETTINGS.style);
    expect(s.fadeCurve).toBe(DEFAULT_SETTINGS.fadeCurve);
  });

  it("rejects non-boolean flags", () => {
    const s = sanitize({ enabled: "yes", debugMode: 1 });
    expect(s.enabled).toBe(DEFAULT_SETTINGS.enabled);
    expect(s.debugMode).toBe(DEFAULT_SETTINGS.debugMode);
  });

  it("refuses to enable the external provider without an https URL", () => {
    expect(sanitize({ externalProviderEnabled: true, externalProviderUrl: "" }).externalProviderEnabled).toBe(false);
    expect(
      sanitize({ externalProviderEnabled: true, externalProviderUrl: "http://insecure/x" })
        .externalProviderEnabled,
    ).toBe(false);
    expect(
      sanitize({ externalProviderEnabled: true, externalProviderUrl: "https://ok/x" })
        .externalProviderEnabled,
    ).toBe(true);
  });

  it("rejects a NaN or Infinity number", () => {
    const s = sanitize({ intensity: Number.NaN, minCompatibilityForBlend: Infinity });
    expect(s.intensity).toBe(DEFAULT_SETTINGS.intensity);
    expect(s.minCompatibilityForBlend).toBe(DEFAULT_SETTINGS.minCompatibilityForBlend);
  });
});

describe("SettingsStore", () => {
  it("starts from the defaults with empty storage", () => {
    const store = new SettingsStore(memoryStorage());
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it("survives corrupt stored JSON", () => {
    const storage = memoryStorage();
    storage.map.set(SETTINGS_STORAGE_KEY, "{not json");
    const store = new SettingsStore(storage);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it("persists and reloads", () => {
    const storage = memoryStorage();
    new SettingsStore(storage).update({ style: "chill", intensity: 0.9 });
    const reloaded = new SettingsStore(storage);
    expect(reloaded.get().style).toBe("chill");
    expect(reloaded.get().intensity).toBe(0.9);
  });

  it("emits only for real changes and lists what changed", () => {
    const store = new SettingsStore(memoryStorage());
    const spy = vi.fn();
    store.events.on("change", spy);

    store.update({ intensity: store.get().intensity });
    expect(spy).not.toHaveBeenCalled();

    store.update({ intensity: 0.25, style: "smooth" });
    expect(spy).toHaveBeenCalledTimes(1);
    const payload = spy.mock.calls[0]![0] as { changed: string[] };
    expect(new Set(payload.changed)).toEqual(new Set(["intensity", "style"]));
  });

  it("corrects an invalid update instead of throwing", () => {
    const store = new SettingsStore(memoryStorage());
    expect(() => store.update({ intensity: 50 })).not.toThrow();
    expect(store.get().intensity).toBe(1);
  });

  it("resets everything", () => {
    const store = new SettingsStore(memoryStorage());
    store.update({ style: "chill", enabled: false, debugMode: true });
    store.reset();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps working when storage throws on write", () => {
    const storage = {
      get: () => null,
      set: () => {
        throw new Error("quota exceeded");
      },
    };
    const store = new SettingsStore(storage);
    expect(() => store.update({ intensity: 0.4 })).not.toThrow();
    expect(store.get().intensity).toBe(0.4);
  });
});
