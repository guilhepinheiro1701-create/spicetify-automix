/**
 * Realistic pairings.
 *
 * These are the cases the engine actually meets: same-genre pairs that should
 * mix long, cross-genre pairs that should not, and structural extremes where
 * the runway rather than the tempo decides the answer.
 *
 * Each case asserts the *behaviour a listener would notice* — how long, whether
 * it overlaps, which character — rather than an exact number, so the tests stay
 * meaningful when the weights are tuned.
 */
import { describe, expect, it } from "vitest";
import { calculateTransition } from "../src/engine/transitionEngine.js";
import { analysis, capabilities, settings, track, sectionsFor } from "./helpers.js";
import type { Section, TrackAnalysis, TransitionPlan } from "../src/core/types.js";

interface Shape {
  bpm: number;
  key: number;
  mode: number;
  energy: number;
  loudness: number;
  durationSec: number;
  /** Seconds of low-energy opening. */
  introSec: number;
  /** Seconds of low-energy tail. */
  outroSec: number;
}

/** Build an analysis with a real intro/body/outro energy contour. */
function shaped(s: Shape): TrackAnalysis {
  const sections: Section[] = [];
  const energies: number[] = [];
  const push = (start: number, duration: number, energy: number) => {
    if (duration <= 0.5) return;
    sections.push({
      start,
      duration,
      confidence: 0.85,
      loudness: s.loudness,
      tempo: s.bpm,
      key: s.key,
      mode: s.mode,
      timeSignature: 4,
    });
    energies.push(energy);
  };

  const bodyStart = s.introSec;
  const bodyEnd = s.durationSec - s.outroSec;
  if (s.introSec > 0) push(0, s.introSec, s.energy * 0.35);
  const bodyLen = bodyEnd - bodyStart;
  const chunk = bodyLen / 3;
  for (let i = 0; i < 3; i++) push(bodyStart + i * chunk, chunk, s.energy);
  if (s.outroSec > 0) push(bodyEnd, s.outroSec, s.energy * 0.35);

  const a = analysis({
    tempo: s.bpm,
    key: s.key,
    mode: s.mode,
    energy: s.energy,
    loudness: s.loudness,
    durationMs: s.durationSec * 1000,
    sections,
    startOfFadeOut: s.outroSec > 0 ? bodyEnd : s.durationSec - 2,
    endOfFadeIn: 0,
  });
  a.sectionEnergy = energies;
  return a;
}

function plan(
  from: Shape,
  to: Shape,
  opts: { tier?: "dj" | "fade"; settings?: Parameters<typeof settings>[0] } = {},
): TransitionPlan {
  const A = track({ uri: "spotify:track:a", name: "A", albumUri: "spotify:album:1" });
  const B = track({
    uri: "spotify:track:b",
    name: "B",
    artists: ["Other"],
    albumUri: "spotify:album:2",
  });
  const fromAnalysis = shaped(from);
  const toAnalysis = shaped(to);
  fromAnalysis.uri = A.uri;
  toAnalysis.uri = B.uri;
  // The analyzer normally attaches these; here we let the engine derive them.
  fromAnalysis.structure = null;
  toAnalysis.structure = null;
  return calculateTransition({
    fromTrack: A,
    toTrack: B,
    fromAnalysis,
    toAnalysis,
    settings: settings(opts.settings),
    capabilities: capabilities(opts.tier ?? "dj"),
  });
}

// ── Genre archetypes ─────────────────────────────────────────────────────────
const HOUSE: Shape = { bpm: 124, key: 9, mode: 0, energy: 0.78, loudness: -7, durationSec: 330, introSec: 32, outroSec: 32 };
const HOUSE_B: Shape = { ...HOUSE, bpm: 126, key: 4, mode: 0, energy: 0.82 };
const EDM: Shape = { bpm: 128, key: 1, mode: 0, energy: 0.9, loudness: -5, durationSec: 300, introSec: 24, outroSec: 24 };
const EDM_B: Shape = { ...EDM, bpm: 128, key: 8, mode: 0, energy: 0.92 };
const POP: Shape = { bpm: 102, key: 0, mode: 1, energy: 0.66, loudness: -8, durationSec: 200, introSec: 4, outroSec: 5 };
const POP_B: Shape = { ...POP, bpm: 104, key: 7, mode: 1, energy: 0.69 };
const HIPHOP: Shape = { bpm: 88, key: 5, mode: 0, energy: 0.7, loudness: -6, durationSec: 210, introSec: 8, outroSec: 6 };
const HIPHOP_B: Shape = { ...HIPHOP, bpm: 90, key: 0, mode: 0, energy: 0.72 };
const ROCK: Shape = { bpm: 140, key: 4, mode: 1, energy: 0.85, loudness: -6, durationSec: 240, introSec: 6, outroSec: 8 };
const ROCK_B: Shape = { ...ROCK, bpm: 138, key: 11, mode: 1, energy: 0.83 };
const BALLAD: Shape = { bpm: 72, key: 2, mode: 1, energy: 0.25, loudness: -14, durationSec: 250, introSec: 12, outroSec: 20 };

const report = (name: string, p: TransitionPlan) =>
  `${name}: ${p.band} ${(p.compatibility.overall * 100).toFixed(0)}% · ${p.strategy} · ${p.technique} · ${p.durationSec}s`;

describe("same-genre pairs mix long", () => {
  it("house → house: a real, phrase-locked mix", () => {
    const p = plan(HOUSE, HOUSE_B);
    console.log(report("house→house", p));
    expect(p.executor).toBe("native-crossfade");
    expect(["dj", "long", "smooth", "energy-rise"]).toContain(p.strategy);
    expect(p.durationSec).toBeGreaterThanOrEqual(6);
    expect(["PERFECT", "EXCELLENT", "GOOD"]).toContain(p.band);
    // Both tracks have long intros and outros: the runway should be generous.
    expect(p.mixableWindowSec).toBeGreaterThan(10);
  });

  it("EDM → EDM at identical tempo: top band, downbeat locked", () => {
    const p = plan(EDM, EDM_B);
    console.log(report("edm→edm", p));
    expect(p.beatAlignment).toBe(true);
    expect(["PERFECT", "EXCELLENT"]).toContain(p.band);
    expect(p.durationSec).toBeGreaterThanOrEqual(6);
  });

  it("pop → pop: shorter, because pop has no runway", () => {
    const pop = plan(POP, POP_B);
    const house = plan(HOUSE, HOUSE_B);
    console.log(report("pop→pop", pop));
    // Same quality of match, but 4 s of intro instead of 32 s.
    expect(pop.mixableWindowSec).toBeLessThan(house.mixableWindowSec);
    expect(pop.durationSec).toBeLessThan(house.durationSec);
  });

  it("hip-hop → hip-hop: works, kept tight", () => {
    const p = plan(HIPHOP, HIPHOP_B);
    console.log(report("hiphop→hiphop", p));
    expect(["PERFECT", "EXCELLENT", "GOOD"]).toContain(p.band);
    expect(p.durationSec).toBeLessThanOrEqual(10);
  });

  it("rock → rock: blends, but does not pretend to be a club mix", () => {
    const p = plan(ROCK, ROCK_B);
    console.log(report("rock→rock", p));
    expect(p.compatibility.overall).toBeGreaterThan(0.6);
    expect(p.durationSec).toBeLessThanOrEqual(10);
  });
});

describe("cross-genre and mismatched pairs", () => {
  it("pop → EDM: a tempo gap it cannot hide, so it stays short", () => {
    const p = plan(POP, EDM);
    console.log(report("pop→edm", p));
    expect(p.durationSec).toBeLessThan(plan(EDM, EDM_B).durationSec);
    expect(p.compatibility.tempo.score).toBeLessThan(0.7);
  });

  it("slow → fast (72 → 128): refuses a long overlap", () => {
    const p = plan(BALLAD, EDM);
    console.log(report("ballad→edm", p));
    expect(["safe", "fast", "harmonic"]).toContain(p.strategy);
    expect(p.durationSec).toBeLessThanOrEqual(6);
  });

  it("fast → slow (128 → 72): equally cautious, and settles rather than cuts", () => {
    const p = plan(EDM, BALLAD);
    console.log(report("edm→ballad", p));
    expect(p.compatibility.energy.score).toBeLessThan(0.4);
    expect(p.durationSec).toBeLessThanOrEqual(8);
  });

  it("same key beats different key at equal tempo", () => {
    const base: Shape = { ...HOUSE };
    const sameKey = plan(base, { ...base, bpm: 125, key: base.key, mode: base.mode });
    const clashKey = plan(base, { ...base, bpm: 125, key: (base.key + 6) % 12, mode: 1 });
    console.log(report("house→house same key", sameKey));
    console.log(report("house→house key clash", clashKey));
    expect(sameKey.compatibility.overall).toBeGreaterThan(clashKey.compatibility.overall);
    expect(sameKey.durationSec).toBeGreaterThanOrEqual(clashKey.durationSec);
  });

  it("near-identical BPM beats a wide gap", () => {
    const close = plan(HOUSE, { ...HOUSE, bpm: 125 });
    const far = plan(HOUSE, { ...HOUSE, bpm: 148 });
    expect(close.compatibility.tempo.score).toBeGreaterThan(far.compatibility.tempo.score);
    expect(close.durationSec).toBeGreaterThan(far.durationSec);
  });
});

describe("structure decides the length, not the tempo", () => {
  it("long outro into long intro gets a long blend", () => {
    const longRunway = plan(
      { ...HOUSE, outroSec: 40 },
      { ...HOUSE_B, introSec: 40 },
    );
    console.log(report("long outro→long intro", longRunway));
    expect(longRunway.mixableWindowSec).toBeGreaterThan(15);
    // Blend lengths are quantised to whole phrases: at 124 BPM that is 7.7 s or
    // 15.5 s, and the second is past the 10 s default ceiling. So "long" here
    // means a full phrase, not an arbitrary number of seconds.
    expect(longRunway.durationBeats).toBeGreaterThanOrEqual(16);
    expect(["long", "dj", "energy-rise", "smooth"]).toContain(longRunway.strategy);
  });

  it("short outro into short intro gets a short blend at the same tempo", () => {
    const longRunway = plan({ ...HOUSE, outroSec: 40 }, { ...HOUSE_B, introSec: 40 });
    const shortRunway = plan({ ...HOUSE, outroSec: 2 }, { ...HOUSE_B, introSec: 2 });
    console.log(report("short outro→short intro", shortRunway));
    // Identical BPM and key in both cases: only the structure differs.
    expect(shortRunway.durationSec).toBeLessThan(longRunway.durationSec);
    expect(shortRunway.mixableWindowSec).toBeLessThan(longRunway.mixableWindowSec);
  });

  it("names which side capped the runway", () => {
    const introCapped = plan({ ...HOUSE, outroSec: 40 }, { ...HOUSE_B, introSec: 4 });
    const outroCapped = plan({ ...HOUSE, outroSec: 4 }, { ...HOUSE_B, introSec: 40 });
    expect(introCapped.windowLimitedBy).toBe("intro");
    expect(outroCapped.windowLimitedBy).toBe("outro");
  });

  it("a track that stops dead gets a fast strategy, not a long dissolve", () => {
    const p = plan({ ...HOUSE, outroSec: 0 }, { ...HOUSE_B, introSec: 0 });
    console.log(report("abrupt→abrupt", p));
    expect(p.durationSec).toBeLessThanOrEqual(6);
  });
});

describe("energy direction changes the gesture", () => {
  it("a clear rise builds rather than dissolves", () => {
    const p = plan({ ...HOUSE, energy: 0.55 }, { ...HOUSE, bpm: 125, energy: 0.8 });
    console.log(report("energy rise", p));
    expect(p.strategy).toBe("energy-rise");
  });

  it("a clear fall gets a longer, gentler dissolve", () => {
    const rise = plan({ ...HOUSE, energy: 0.55 }, { ...HOUSE, bpm: 125, energy: 0.8 });
    const fall = plan({ ...HOUSE, energy: 0.8 }, { ...HOUSE, bpm: 125, energy: 0.55 });
    console.log(report("energy drop", fall));
    expect(fall.strategy).toBe("energy-drop");
    expect(fall.durationSec).toBeGreaterThanOrEqual(rise.durationSec);
  });
});

describe("the Free-account path", () => {
  it("still picks the same musical moment, and leads in so the switch lands on it", () => {
    const dj = plan(HOUSE, HOUSE_B, { tier: "dj" });
    const free = plan(HOUSE, HOUSE_B, { tier: "fade" });
    console.log(report("free house→house", free));
    expect(free.executor).toBe("volume-fade");
    expect(free.leadInSec).toBeGreaterThan(0);
    // The switch instant is chosen the same way regardless of tier.
    expect(Math.abs(free.startPointSec - dj.startPointSec)).toBeLessThan(free.durationSec + 1);
    expect(dj.leadInSec).toBe(0);
  });

  it("offers intro skipping that the overlap path cannot", () => {
    const free = plan(HOUSE, { ...HOUSE_B, introSec: 30 }, { tier: "fade" });
    const dj = plan(HOUSE, { ...HOUSE_B, introSec: 30 }, { tier: "dj" });
    expect(dj.entryPointSec).toBe(0);
    expect(free.entryPointSec).toBeGreaterThanOrEqual(0);
  });
});

describe("extremes stay safe", () => {
  const extremes: [string, Shape, Shape][] = [
    [
      "60 → 180 BPM",
      { ...POP, bpm: 60 },
      { ...POP, bpm: 180 },
    ],
    [
      "C → F# tritone",
      { ...POP, key: 0, mode: 1 },
      { ...POP, key: 6, mode: 1 },
    ],
    [
      "energy 0.1 → 1.0",
      { ...POP, energy: 0.1 },
      { ...POP, energy: 1 },
    ],
    [
      "40 → 250 BPM, everything wrong",
      { bpm: 40, key: 11, mode: 0, energy: 0, loudness: -30, durationSec: 60, introSec: 0, outroSec: 0 },
      { bpm: 250, key: 5, mode: 1, energy: 1, loudness: -2, durationSec: 400, introSec: 0, outroSec: 0 },
    ],
  ];

  for (const [name, a, b] of extremes) {
    it(`survives ${name}`, () => {
      const p = plan(a, b);
      console.log(report(name, p));
      expect(Number.isFinite(p.startPointSec)).toBe(true);
      expect(Number.isFinite(p.durationSec)).toBe(true);
      expect(p.durationSec).toBeGreaterThanOrEqual(0);
      expect(p.startPointSec).toBeLessThanOrEqual(a.durationSec);
      expect(p.compatibility.overall).toBeGreaterThanOrEqual(0);
      expect(p.compatibility.overall).toBeLessThanOrEqual(1);
      expect(p.bpmAdjustmentApplied).toBe(false);
      // Nothing this mismatched should get a long, exposed overlap.
      if (p.band === "POOR") expect(p.durationSec).toBeLessThanOrEqual(6);
    });
  }
});

describe("a harmonic clash shortens the overlap, not the cut", () => {
  // 8A. Same tempo, same structure, same energy: key is the only variable, so
  // any difference in length is attributable to it.
  const TECH: Shape = { bpm: 124, key: 9, mode: 0, energy: 0.8, loudness: -7, durationSec: 300, introSec: 30, outroSec: 40 };
  const SAME_KEY: Shape = { ...TECH, bpm: 123 };
  const CLASH: Shape = { ...SAME_KEY, key: 3, mode: 1 };
  const ENERGY_MOVE: Shape = { ...SAME_KEY, key: 11 };

  it("a distant key overlaps for less time than a perfect match", () => {
    const ok = plan(TECH, SAME_KEY);
    const bad = plan(TECH, CLASH);
    console.log(report("same key", ok), "|", report("clashing key", bad));
    expect(bad.compatibility.key.score).toBeLessThan(0.45);
    // The defect this locks: both used to get a full sixteen-beat phrase,
    // because key only reached length through the overall band.
    expect(bad.durationSec).toBeLessThan(ok.durationSec);
    expect(bad.durationBeats).toBeLessThanOrEqual(8);
  });

  it("says so in the rationale rather than silently shortening", () => {
    const bad = plan(TECH, CLASH);
    expect(bad.rationale.some((r) => r.includes("keys clash"))).toBe(true);
  });

  it("leaves the cut path alone — a clash costs nothing when nothing overlaps", () => {
    const okFade = plan(TECH, SAME_KEY, { tier: "fade" });
    const badFade = plan(TECH, CLASH, { tier: "fade" });
    expect(badFade.executor).toBe("volume-fade");
    expect(badFade.fade.outSec).toBeCloseTo(okFade.fade.outSec, 2);
  });

  it("does not punish a ±2 energy move, which is a legitimate DJ step", () => {
    const ok = plan(TECH, SAME_KEY);
    const move = plan(TECH, ENERGY_MOVE);
    expect(move.compatibility.key.score).toBeGreaterThanOrEqual(0.45);
    expect(move.durationSec).toBeGreaterThanOrEqual(ok.durationSec * 0.9);
  });

  it("does not punish an unknown key", () => {
    const unknownKey = plan(TECH, { ...SAME_KEY, key: -1, mode: -1 });
    const ok = plan(TECH, SAME_KEY);
    expect(unknownKey.durationBeats).toBeGreaterThan(8);
    expect(unknownKey.durationSec).toBeGreaterThanOrEqual(ok.durationSec * 0.75);
  });

  it("respects the harmonic mixing switch", () => {
    const off = plan(TECH, CLASH, { settings: { harmonicMixing: false } });
    expect(off.durationBeats ?? 0).toBeGreaterThan(8);
  });
});
