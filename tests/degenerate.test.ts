/**
 * Degenerate input.
 *
 * The engine is fed whatever the analysis services happen to return, and those
 * are undocumented internal endpoints. A missing field, a zero tempo, a section
 * starting before the track does — none of it may produce a NaN, a negative
 * length, an exit point past the end of the track, or a throw.
 *
 * This sweeps every shape that has ever looked plausible against both tiers and
 * every style, and asserts the plan is arithmetically sane. It is a net, not a
 * set of examples: a new field with a bad default gets caught here.
 */
import { describe, expect, it } from "vitest";
import { calculateTransition } from "../src/engine/transitionEngine.js";
import { buildPhraseGrid } from "../src/analysis/structure.js";
import { classifySections } from "../src/analysis/sections.js";
import { DEFAULT_SETTINGS } from "../src/config/defaults.js";
import { capabilities, track } from "./helpers.js";
import type { TrackAnalysis, TransitionStyle } from "../src/core/types.js";

interface Shape {
  dur?: number;
  bpm?: number;
  ts?: number;
  key?: number;
  mode?: number;
  loud?: number;
  energy?: number;
  sfo?: number;
  beats?: { start: number; duration: number; confidence: number }[];
  sections?: unknown[];
  se?: number[];
}

function build(uri: string, o: Shape): TrackAnalysis {
  const dur = o.dur ?? 200;
  const a = {
    uri,
    source: "spotify-internal",
    confidence: 0.9,
    fetchedAt: Date.now(),
    durationMs: dur * 1000,
    tempo: o.bpm,
    tempoConfidence: 0.9,
    timeSignature: o.ts ?? 4,
    key: o.key,
    mode: o.mode,
    keyConfidence: 0.8,
    loudness: o.loud,
    energy: o.energy,
    endOfFadeIn: 0,
    startOfFadeOut: o.sfo ?? dur,
    beats: o.beats ?? [],
    bars: [],
    sections: o.sections ?? [],
    sectionEnergy: o.se ?? [],
    segments: [],
  } as unknown as TrackAnalysis;
  a.grid = buildPhraseGrid(a);
  a.structure = classifySections(a);
  return a;
}

const section = (start: number, duration: number) => ({
  start,
  duration,
  confidence: 1,
  loudness: -7,
  tempo: 120,
  key: 1,
  mode: 0,
  timeSignature: 4,
});

const CASES: [string, Shape, Shape][] = [
  ["no data at all", {}, {}],
  ["zero-length outgoing track", { dur: 0 }, {}],
  ["zero-length incoming track", {}, { dur: 0 }],
  ["negative tempo", { bpm: -120 }, { bpm: 120 }],
  ["zero tempo", { bpm: 0 }, { bpm: 120 }],
  ["absurd tempo", { bpm: 100_000 }, { bpm: 120 }],
  ["NaN tempo", { bpm: NaN }, { bpm: 120 }],
  ["infinite tempo", { bpm: Infinity }, { bpm: 120 }],
  ["zero time signature", { bpm: 120, ts: 0 }, { bpm: 120 }],
  ["absurd time signature", { bpm: 120, ts: 1000 }, { bpm: 120 }],
  ["impossible loudness", { bpm: 120, loud: -999 }, { bpm: 120, loud: 0 }],
  ["energy outside 0..1", { bpm: 120, energy: 5 }, { bpm: 120, energy: -3 }],
  ["key and mode outside range", { bpm: 120, key: 99, mode: 7 }, { bpm: 120, key: -5, mode: -1 }],
  ["fade-out marked past the end", { bpm: 120, dur: 100, sfo: 5000 }, { bpm: 120 }],
  ["fade-out marked before the start", { bpm: 120, dur: 100, sfo: -50 }, { bpm: 120 }],
  ["one-second track", { bpm: 120, dur: 1 }, { bpm: 120 }],
  ["three-hour track", { bpm: 120, dur: 10_800 }, { bpm: 120 }],
  ["section starting before the track", { bpm: 120, sections: [section(-50, 30)], se: [0.5] }, { bpm: 120 }],
  ["zero-length section", { bpm: 120, sections: [section(0, 0)], se: [0.5] }, { bpm: 120 }],
  [
    "beats out of order",
    {
      bpm: 120,
      beats: [
        { start: 90, duration: 0.5, confidence: 1 },
        { start: 1, duration: 0.5, confidence: 1 },
      ],
    },
    { bpm: 120 },
  ],
];

const STYLES: TransitionStyle[] = ["dj", "smooth", "energetic", "chill", "seamless", "custom"];

describe.each(["dj", "fade"] as const)("degenerate analysis on the %s tier", (tier) => {
  it.each(CASES)("survives: %s", (_label, from, to) => {
    const durA = from.dur ?? 200;
    const durB = to.dur ?? 200;

    for (const style of STYLES) {
      const plan = calculateTransition({
        fromTrack: track({ uri: "spotify:track:a", durationMs: durA * 1000 }),
        toTrack: track({
          uri: "spotify:track:b",
          artists: ["Other"],
          albumUri: "spotify:album:2",
          durationMs: durB * 1000,
        }),
        fromAnalysis: build("spotify:track:a", from),
        toAnalysis: build("spotify:track:b", to),
        settings: { ...DEFAULT_SETTINGS, style },
        capabilities: capabilities(tier),
      });

      const finite = [
        plan.durationSec,
        plan.startPointSec,
        plan.leadInSec,
        plan.entryPointSec,
        plan.mixableWindowSec,
        plan.phaseOffsetSec,
        plan.musicalConfidence,
        plan.bpmAdjustmentPercent,
        plan.compatibility.overall,
        plan.fade.outSec,
        plan.fade.inSec,
        plan.fade.floor,
      ];
      for (const n of finite) expect(Number.isFinite(n)).toBe(true);

      expect(plan.durationSec).toBeGreaterThanOrEqual(0);
      expect(plan.leadInSec).toBeGreaterThanOrEqual(0);
      expect(plan.entryPointSec).toBeGreaterThanOrEqual(0);
      expect(plan.startPointSec).toBeGreaterThanOrEqual(0);
      expect(plan.fade.floor).toBeGreaterThanOrEqual(0);
      expect(plan.fade.floor).toBeLessThanOrEqual(1);

      // A transition we intend to run must exit inside the track it is leaving,
      // and enter inside the track it is joining.
      if (plan.executor !== "passive") {
        expect(plan.startPointSec).toBeLessThanOrEqual(durA + 0.001);
      }
      if (durB > 0) expect(plan.entryPointSec).toBeLessThanOrEqual(durB);
    }
  });
});
