import type { Section, TrackAnalysis, TrackRef } from "../src/core/types.js";
import { buildPhraseGrid } from "../src/analysis/structure.js";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/defaults.js";
import type { CapabilitySet } from "../src/platform/capabilities.js";

export function track(over: Partial<TrackRef> = {}): TrackRef {
  return {
    uri: "spotify:track:0000000000000000000000",
    id: "0000000000000000000000",
    name: "Test Track",
    artists: ["Tester"],
    albumUri: "spotify:album:aaa",
    durationMs: 240_000,
    isLocal: false,
    provider: "context",
    ...over,
  };
}

/** Build a synthetic but internally consistent analysis. */
export function analysis(over: Partial<TrackAnalysis> = {}): TrackAnalysis {
  const durationMs = over.durationMs ?? 240_000;
  const tempo = over.tempo ?? 128;
  const base: TrackAnalysis = {
    uri: over.uri ?? "spotify:track:0000000000000000000000",
    source: "spotify-internal",
    confidence: 0.9,
    fetchedAt: Date.now(),
    durationMs,
    tempo,
    tempoConfidence: 0.9,
    timeSignature: 4,
    key: 9, // A
    mode: 0, // minor → 8A
    keyConfidence: 0.8,
    loudness: -7,
    energy: 0.8,
    brightness: 0.5,
    pulseStrength: 0.8,
    endOfFadeIn: 0,
    startOfFadeOut: durationMs / 1000 - 10,
    beats: [],
    bars: [],
    sections: [],
    sectionEnergy: [],
    ...over,
  };

  // Only synthesise what the caller did not explicitly provide — a test that
  // passes `beats: []` wants an empty grid, not a generated one.
  if (!("beats" in over) && tempo) {
    base.beats = beatGrid(tempo, durationMs / 1000);
    base.bars = barGrid(tempo, durationMs / 1000, base.timeSignature ?? 4);
  }
  if (!("sections" in over)) {
    base.sections = sectionsFor(durationMs / 1000, tempo, base.timeSignature ?? 4);
    base.sectionEnergy = (base.sections ?? []).map((_, i, arr) =>
      i === 0 ? 0.3 : i === arr.length - 1 ? 0.5 : 0.8,
    );
  }
  base.grid = over.grid !== undefined ? over.grid : buildPhraseGrid(base);
  return base;
}

export function beatGrid(bpm: number, durationSec: number, offset = 0) {
  const step = 60 / bpm;
  const out = [];
  for (let t = offset; t < durationSec; t += step) {
    out.push({ start: Number(t.toFixed(4)), duration: step, confidence: 0.85 });
  }
  return out;
}

export function barGrid(bpm: number, durationSec: number, beatsPerBar: number, offset = 0) {
  const step = (60 / bpm) * beatsPerBar;
  const out = [];
  for (let t = offset; t < durationSec; t += step) {
    out.push({ start: Number(t.toFixed(4)), duration: step, confidence: 0.8 });
  }
  return out;
}

/** Sections placed exactly on 16-beat phrase lines, so the grid is recoverable. */
export function sectionsFor(durationSec: number, bpm: number, beatsPerBar: number): Section[] {
  const phrase = (60 / bpm) * beatsPerBar * 4;
  const out: Section[] = [];
  let t = 0;
  let i = 0;
  while (t < durationSec - phrase) {
    const len = phrase * (i === 0 ? 4 : 8);
    out.push({
      start: Number(t.toFixed(4)),
      duration: Math.min(len, durationSec - t),
      confidence: 0.8,
      loudness: -8,
      tempo: bpm,
      key: 9,
      mode: 0,
      timeSignature: beatsPerBar,
    });
    t += len;
    i++;
  }
  return out;
}

export function settings(over: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...over };
}

const capability = (status: "available" | "partial" | "unavailable") => ({
  id: "x",
  label: "x",
  status,
  detail: "",
});

export function capabilities(tier: "dj" | "fade" | "passive" = "dj"): CapabilitySet {
  return {
    probedAt: Date.now(),
    productTier: tier === "dj" ? "premium" : "free",
    nativeCrossfade: capability(tier === "dj" ? "available" : "unavailable"),
    volumeAutomation: capability(tier === "passive" ? "unavailable" : "partial"),
    audioAnalysis: capability("partial"),
    queueLookahead: capability("available"),
    preciseTiming: capability("available"),
    tempoControl: capability("unavailable"),
    audioDsp: capability("unavailable"),
    perTrackGain: capability("unavailable"),
    tier,
  };
}

/** In-memory storage adapter for cache/settings tests. */
export function memoryStorage() {
  const map = new Map<string, string>();
  return {
    get: (k: string) => map.get(k) ?? null,
    set: (k: string, v: string) => void map.set(k, v),
    map,
  };
}
