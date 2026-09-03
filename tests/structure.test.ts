import { describe, expect, it } from "vitest";
import {
  alignDurationToPhrase,
  beatsToNextPhrase,
  buildPhraseGrid,
  findEntryCue,
  findExitCue,
  isOnPhrase,
  nearestDownbeat,
  nearestPhraseBoundary,
  phraseAlignmentScore,
  phraseDurationSec,
} from "../src/analysis/structure.js";
import { analysis, beatGrid, barGrid } from "./helpers.js";

describe("phrase grid recovery", () => {
  it("derives a 16-beat phrase at the track tempo", () => {
    const grid = buildPhraseGrid(analysis({ tempo: 128 }));
    expect(grid).not.toBeNull();
    expect(grid!.beatsPerBar).toBe(4);
    expect(grid!.barsPerPhrase).toBe(4);
    expect(grid!.secPerBeat).toBeCloseTo(60 / 128, 6);
    expect(phraseDurationSec(grid!)).toBeCloseTo((60 / 128) * 16, 6);
  });

  it("recovers the phrase phase from the section boundaries", () => {
    // Sections start one bar late, so the grid origin must shift by one bar.
    const bpm = 120;
    const bar = (60 / bpm) * 4;
    const a = analysis({
      tempo: bpm,
      beats: beatGrid(bpm, 200),
      bars: barGrid(bpm, 200, 4),
      sections: [0, 8, 16, 24].map((phraseIndex) => ({
        start: bar + phraseIndex * bar * 4,
        duration: bar * 4,
        confidence: 0.9,
        loudness: -8,
        tempo: bpm,
        key: 0,
        mode: 1,
        timeSignature: 4,
      })),
      grid: null,
    });
    const grid = buildPhraseGrid(a);
    expect(grid).not.toBeNull();
    expect(grid!.originSec).toBeCloseTo(bar, 3);
    expect(grid!.confidence).toBeGreaterThan(0.8);
  });

  it("still builds a low-confidence grid from tempo alone", () => {
    // Manual overrides and most third-party providers give a BPM with no beat
    // list. That is still enough to reason about phrase lengths.
    const grid = buildPhraseGrid(
      analysis({ tempo: 128, beats: [], bars: [], sections: [], grid: null }),
    );
    expect(grid).not.toBeNull();
    expect(grid!.secPerBeat).toBeCloseTo(60 / 128, 6);
    expect(grid!.originSec).toBe(0);
    // But it must not claim to know where the downbeats actually are.
    expect(grid!.confidence).toBeLessThan(0.35);
  });

  it("returns null when there is neither tempo nor beats", () => {
    expect(
      buildPhraseGrid(analysis({ tempo: undefined, beats: [], bars: [], grid: null })),
    ).toBeNull();
  });

  it("honours an unusual time signature", () => {
    const grid = buildPhraseGrid(analysis({ tempo: 140, timeSignature: 3 }));
    expect(grid!.beatsPerBar).toBe(3);
  });

  it("ignores an impossible time signature", () => {
    const grid = buildPhraseGrid(analysis({ tempo: 140, timeSignature: 99 }));
    expect(grid!.beatsPerBar).toBe(4);
  });
});

describe("grid snapping", () => {
  const grid = buildPhraseGrid(analysis({ tempo: 120 }))!;
  const phrase = phraseDurationSec(grid); // 8 s at 120 BPM

  it("rounds to the nearest phrase line", () => {
    expect(nearestPhraseBoundary(grid, phrase * 3 + 0.4)).toBeCloseTo(phrase * 3, 5);
    expect(nearestPhraseBoundary(grid, phrase * 3 - 0.4)).toBeCloseTo(phrase * 3, 5);
  });

  it("respects a directional bias", () => {
    expect(nearestPhraseBoundary(grid, phrase * 3 + 1, "before")).toBeCloseTo(phrase * 3, 5);
    expect(nearestPhraseBoundary(grid, phrase * 3 + 1, "after")).toBeCloseTo(phrase * 4, 5);
  });

  it("snaps to the bar for downbeats", () => {
    const bar = grid.secPerBeat * grid.beatsPerBar; // 2 s
    expect(nearestDownbeat(grid, bar * 5 + 0.3)).toBeCloseTo(bar * 5, 5);
  });

  it("detects on-phrase positions within tolerance", () => {
    expect(isOnPhrase(grid, phrase * 2)).toBe(true);
    expect(isOnPhrase(grid, phrase * 2 + 0.05)).toBe(true);
    expect(isOnPhrase(grid, phrase * 2 + 1.5)).toBe(false);
  });

  it("counts beats to the next phrase", () => {
    expect(beatsToNextPhrase(grid, phrase * 2)).toBeCloseTo(0, 5);
    expect(beatsToNextPhrase(grid, phrase * 2 - grid.secPerBeat * 4)).toBeCloseTo(4, 5);
  });

  it("prefers a whole phrase over a ragged number of bars", () => {
    // At 120 BPM a bar is 2 s and a phrase is 8 s. Asked for 6.4 s, three bars
    // is closer arithmetically but one phrase is what resolves musically.
    expect(alignDurationToPhrase(grid, 6.4)).toBeCloseTo(phrase, 4);
    expect(alignDurationToPhrase(grid, phrase * 2 + 0.5)).toBeCloseTo(phrase * 2, 4);
  });

  it("falls back to whole bars when no phrase multiple fits the bounds", () => {
    const bar = grid.secPerBeat * grid.beatsPerBar; // 2 s
    // A phrase is 8 s, so with a 5 s ceiling only bar multiples are available.
    const v = alignDurationToPhrase(grid, 4.4, 1, 5);
    expect(v).toBeCloseTo(bar * 2, 4);
  });

  it("respects the caller's bounds", () => {
    const bounds: [number, number][] = [
      [1, 5],
      [3, 9],
      [0.5, 12],
    ];
    for (const [min, max] of bounds) {
      const v = alignDurationToPhrase(grid, 7, min, max);
      expect(v).toBeGreaterThanOrEqual(min);
      expect(v).toBeLessThanOrEqual(max);
    }
  });

  it("returns the desired length unchanged when nothing at all fits", () => {
    // A window narrower than one bar admits no grid-aligned value.
    expect(alignDurationToPhrase(grid, 3.3, 3.2, 3.4)).toBeCloseTo(3.3, 6);
  });

  it("never collapses to zero", () => {
    expect(alignDurationToPhrase(grid, 0.1)).toBeGreaterThan(0);
  });
});

describe("phrase alignment scoring", () => {
  const grid = buildPhraseGrid(analysis({ tempo: 120 }))!;
  const phrase = phraseDurationSec(grid);

  it("rewards a blend that starts and ends on the grid", () => {
    const aligned = phraseAlignmentScore(grid, phrase * 4, phrase);
    const offGrid = phraseAlignmentScore(grid, phrase * 4 + phrase / 2, phrase * 1.37);
    expect(aligned).toBeGreaterThan(0.8);
    expect(offGrid).toBeLessThan(0.4);
    expect(aligned).toBeGreaterThan(offGrid);
  });

  it("returns a neutral value with no grid rather than zero", () => {
    expect(phraseAlignmentScore(null, 100, 8)).toBe(0.35);
  });
});

describe("exit cue selection", () => {
  it("prefers the mastering fade-out when it is near the ideal exit", () => {
    const a = analysis({ durationMs: 240_000, tempo: 128, startOfFadeOut: 222 });
    const cue = findExitCue(a, a.grid ?? null, { durationSec: 8, minPlayedFraction: 0.4 });
    // Either the fade-out itself or a phrase line snapped very close to it.
    expect(cue.time).toBeGreaterThan(210);
    expect(cue.time).toBeLessThan(235);
  });

  it("never exits before the minimum played fraction", () => {
    const a = analysis({ durationMs: 240_000, tempo: 128 });
    const cue = findExitCue(a, a.grid ?? null, { durationSec: 8, minPlayedFraction: 0.8 });
    expect(cue.time).toBeGreaterThanOrEqual(240 * 0.8 - 0.001);
  });

  it("never exits past the end of the track", () => {
    const a = analysis({ durationMs: 60_000, tempo: 128, startOfFadeOut: 200 });
    const cue = findExitCue(a, a.grid ?? null, { durationSec: 8, minPlayedFraction: 0.4 });
    expect(cue.time).toBeLessThanOrEqual(60);
  });

  it("falls back to a plain offset with no musical data at all", () => {
    const bare = analysis({
      tempo: undefined,
      beats: [],
      bars: [],
      sections: [],
      sectionEnergy: [],
      startOfFadeOut: undefined,
      grid: null,
      durationMs: 200_000,
    });
    const cue = findExitCue(bare, null, { durationSec: 6, minPlayedFraction: 0.5 });
    expect(cue.reason).toBe("fallback-offset");
    expect(cue.time).toBeGreaterThanOrEqual(100);
    expect(cue.time).toBeLessThan(200);
  });

  it("produces a finite time for a pathologically short track", () => {
    const a = analysis({ durationMs: 3000, tempo: 128 });
    const cue = findExitCue(a, a.grid ?? null, { durationSec: 8, minPlayedFraction: 0.5 });
    expect(Number.isFinite(cue.time)).toBe(true);
    expect(cue.time).toBeGreaterThanOrEqual(0);
    expect(cue.time).toBeLessThanOrEqual(3);
  });
});

describe("entry cue selection", () => {
  it("starts at zero when intro skipping is off", () => {
    const a = analysis({ tempo: 128 });
    expect(findEntryCue(a, a.grid ?? null, { skipDeadIntro: false }).time).toBe(0);
  });

  it("skips a measurably quiet opening", () => {
    const a = analysis({ tempo: 120 });
    // Force a clearly dead first section.
    a.sectionEnergy = (a.sections ?? []).map((_, i) => (i === 0 ? 0.15 : 0.9));
    const cue = findEntryCue(a, a.grid ?? null, { skipDeadIntro: true, maxSkipSec: 60 });
    expect(cue.time).toBeGreaterThan(0);
    expect(cue.reason).toBe("energy-rise");
  });

  it("refuses to skip further than the cap", () => {
    const a = analysis({ tempo: 120 });
    a.sectionEnergy = (a.sections ?? []).map(() => 0.1);
    const cue = findEntryCue(a, a.grid ?? null, { skipDeadIntro: true, maxSkipSec: 5 });
    expect(cue.time).toBeLessThanOrEqual(5);
  });

  it("never returns a negative time", () => {
    const a = analysis({ tempo: 120, endOfFadeIn: -3 });
    expect(findEntryCue(a, a.grid ?? null).time).toBeGreaterThanOrEqual(0);
  });
});
