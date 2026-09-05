/**
 * Long-run behaviour.
 *
 * The question these answer is not "does it work?" but "is it still the same
 * after two hours?" Every structure that accumulates over a session is driven
 * past its limit here and asserted to be bounded: caches, the session log,
 * transition memory, and the analyser's in-flight map.
 *
 * A leak in any of these would not show up in a normal test — it shows up on
 * track 400, which is exactly when a listener is least willing to forgive it.
 */
import { describe, expect, it, vi } from "vitest";
import { AnalysisCache, MEMORY_LIMIT as ANALYSIS_MEMORY_LIMIT, PERSISTENT_LIMIT } from "../src/analysis/cache.js";
import { MusicAnalyzer } from "../src/analysis/analyzer.js";
import { TransitionMemory, MEMORY_LIMIT as TRANSITION_LIMIT, ALGORITHM_VERSION, MEMORY_STORAGE_KEY } from "../src/runtime/memory.js";
import { Diagnostics, LOG_LIMIT } from "../src/runtime/diagnostics.js";
import { calculateTransition } from "../src/engine/transitionEngine.js";
import { getLogBuffer, clearLogBuffer, createLogger } from "../src/core/logger.js";
import { analysis, capabilities, memoryStorage, settings, track } from "./helpers.js";

const uriFor = (i: number) => `spotify:track:${String(i).padStart(22, "0")}`;

function planFor(i: number) {
  const a = track({ uri: uriFor(i), name: `Track ${i}`, albumUri: `spotify:album:${i}` });
  const b = track({
    uri: uriFor(i + 1),
    name: `Track ${i + 1}`,
    artists: ["Other"],
    albumUri: `spotify:album:${i + 1}`,
  });
  return calculateTransition({
    fromTrack: a,
    toTrack: b,
    // Vary the material so the engine takes different branches across the run.
    fromAnalysis: analysis({ uri: a.uri, tempo: 100 + (i % 60), energy: 0.3 + (i % 7) / 10 }),
    toAnalysis: analysis({ uri: b.uri, tempo: 100 + ((i + 3) % 60), energy: 0.3 + ((i + 2) % 7) / 10 }),
    settings: settings(),
    capabilities: capabilities(i % 3 === 0 ? "fade" : "dj"),
  });
}

describe.each([100, 500, 1000])("a %i-track session", (trackCount) => {
  it("keeps every accumulating structure bounded", () => {
    const storage = memoryStorage();
    const analysisCache = new AnalysisCache(storage);
    const memory = new TransitionMemory(storage);
    const diagnostics = new Diagnostics();

    for (let i = 0; i < trackCount; i++) {
      analysisCache.set(uriFor(i), analysis({ uri: uriFor(i), tempo: 100 + (i % 60) }));
      const plan = planFor(i);
      diagnostics.notePlanned(plan);
      memory.remember(plan, "balanced");
      const idx = diagnostics.beginTransition(plan, "outro", "intro");
      diagnostics.endTransition(idx, "completed", plan.executor, "ok");
    }

    expect(analysisCache.stats().memory).toBeLessThanOrEqual(ANALYSIS_MEMORY_LIMIT);
    expect(analysisCache.stats().persistent).toBeLessThanOrEqual(PERSISTENT_LIMIT);
    expect(memory.size()).toBeLessThanOrEqual(TRANSITION_LIMIT);
    expect(diagnostics.log().length).toBeLessThanOrEqual(LOG_LIMIT);

    // The counters must still be truthful after all that.
    const snap = diagnostics.snapshot();
    expect(snap.transitionsAttempted).toBe(trackCount);
    expect(snap.completed).toBe(trackCount);
    expect(snap.averageScore).toBeGreaterThan(0);
    expect(snap.averageScore).toBeLessThanOrEqual(1);

    memory.dispose();
  });

  it("keeps the stored payload from growing without limit", () => {
    const storage = memoryStorage();
    const cache = new AnalysisCache(storage);
    const memory = new TransitionMemory(storage);

    for (let i = 0; i < trackCount; i++) {
      cache.set(uriFor(i), analysis({ uri: uriFor(i), tempo: 120 }));
      memory.remember(planFor(i), "balanced");
    }
    cache.flush();
    memory.flush();

    let total = 0;
    for (const value of storage.map.values()) total += value.length;
    // Generous, but finite: this must not scale with the session length once
    // the caps are reached.
    expect(total).toBeLessThan(4_000_000);
    memory.dispose();
  });
});

describe("the ring buffers really are rings", () => {
  it("the session log discards the oldest entries, not the newest", () => {
    const diagnostics = new Diagnostics();
    for (let i = 0; i < LOG_LIMIT + 50; i++) {
      const plan = planFor(i);
      const idx = diagnostics.beginTransition(plan, "outro", "intro");
      diagnostics.endTransition(idx, "completed", plan.executor, "ok");
    }
    const entries = diagnostics.log();
    expect(entries).toHaveLength(LOG_LIMIT);
    // The last entry must be the most recent one.
    expect(entries[entries.length - 1]!.fromName).toBe(`Track ${LOG_LIMIT + 49}`);
  });

  it("the log ring buffer is bounded", () => {
    clearLogBuffer();
    const log = createLogger("longrun");
    for (let i = 0; i < 1000; i++) log.debug(`entry ${i}`);
    expect(getLogBuffer().length).toBeLessThanOrEqual(200);
    clearLogBuffer();
  });
});

describe("no work is repeated", () => {
  it("analyses each track exactly once across a long run, even past the hot cache", async () => {
    const analyzer = new MusicAnalyzer({ storage: memoryStorage() });
    const spy = vi.spyOn(analyzer.cache, "set");

    // Far more tracks than the in-memory tier holds, so the second pass has to
    // be served from the compact tier or not at all.
    const tracks = Array.from({ length: 200 }, (_, i) => track({ uri: uriFor(i) }));
    for (const t of tracks) await analyzer.analyze(t);
    for (const t of tracks) await analyzer.analyze(t);

    // Every track resolves heuristically here (no client present), which is
    // exactly the case that used to re-query the internal endpoints forever.
    expect(spy).toHaveBeenCalledTimes(200);
    spy.mockRestore();
  });

  it("retries a remembered negative result once it has aged out", async () => {
    const { AnalysisCache, NEGATIVE_RESULT_TTL_MS } = await import("../src/analysis/cache.js");
    const cache = new AnalysisCache(memoryStorage());
    const uri = uriFor(7);

    cache.set(uri, analysis({ uri, source: "heuristic", fetchedAt: Date.now() }));
    expect(cache.get(uri)).not.toBeNull();

    // Age the stored entry past the retry window.
    const stale = new AnalysisCache(memoryStorage());
    stale.set(uri, analysis({ uri, source: "heuristic", fetchedAt: Date.now() - NEGATIVE_RESULT_TTL_MS - 1 }));
    // Evict it from the hot tier so the aged copy is what answers.
    for (let i = 100; i < 100 + 70; i++) stale.set(uriFor(i), analysis({ uri: uriFor(i) }));
    expect(stale.get(uri)).toBeNull();
    expect(stale.has(uri)).toBe(false);
  });

  it("keeps a real analysis indefinitely, unlike a negative result", async () => {
    const { AnalysisCache, NEGATIVE_RESULT_TTL_MS } = await import("../src/analysis/cache.js");
    const cache = new AnalysisCache(memoryStorage());
    const uri = uriFor(8);
    cache.set(
      uri,
      analysis({ uri, source: "spotify-internal", fetchedAt: Date.now() - NEGATIVE_RESULT_TTL_MS * 4 }),
    );
    for (let i = 200; i < 200 + 70; i++) cache.set(uriFor(i), analysis({ uri: uriFor(i) }));
    expect(cache.get(uri)).not.toBeNull();
  });

  it("deduplicates concurrent requests rather than stacking promises", async () => {
    const analyzer = new MusicAnalyzer({ storage: memoryStorage() });
    const t = track({ uri: uriFor(1) });
    const results = await Promise.all(Array.from({ length: 50 }, () => analyzer.analyze(t)));
    // All fifty callers must share one analysis object.
    expect(new Set(results).size).toBe(1);
  });

  it("prefetch does not queue duplicate work for tracks already cached", async () => {
    const analyzer = new MusicAnalyzer({ storage: memoryStorage() });
    const tracks = Array.from({ length: 20 }, (_, i) => track({ uri: uriFor(i) }));
    for (const t of tracks) await analyzer.analyze(t);

    const spy = vi.spyOn(analyzer.cache, "set");
    analyzer.prefetch(tracks);
    await new Promise((r) => setTimeout(r, 10));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("transition memory versioning", () => {
  it("discards decisions made by an earlier algorithm", () => {
    const storage = memoryStorage();
    storage.map.set(
      MEMORY_STORAGE_KEY,
      JSON.stringify({
        v: ALGORITHM_VERSION - 1,
        entries: [
          {
            fromUri: uriFor(1),
            toUri: uriFor(2),
            score: 0.9,
            confidence: 0.9,
            band: "EXCELLENT",
            strategy: "dj",
            durationSec: 8,
            durationBeats: 16,
            executor: "native-crossfade",
            intent: "balanced",
            algorithmVersion: ALGORITHM_VERSION - 1,
            at: Date.now(),
            timesSeen: 3,
          },
        ],
      }),
    );

    const memory = new TransitionMemory(storage);
    expect(memory.size()).toBe(0);
    expect(memory.recall(uriFor(1), uriFor(2), "balanced")).toBeNull();
    memory.dispose();
  });

  it("keeps decisions from the current version, and counts repeats", () => {
    const storage = memoryStorage();
    const first = new TransitionMemory(storage);
    const plan = planFor(1);

    // Two *sightings*, not two replans of the same one: remember() runs on
    // every replan, so back-to-back calls are one encounter by design.
    vi.useFakeTimers();
    try {
      first.remember(plan, "balanced");
      vi.advanceTimersByTime(30 * 60 * 1000);
      first.remember(plan, "balanced");
    } finally {
      vi.useRealTimers();
    }
    first.flush();

    const second = new TransitionMemory(storage);
    const recalled = second.recall(plan.from.uri, plan.to!.uri, "balanced");
    expect(recalled).not.toBeNull();
    expect(recalled!.timesSeen).toBe(2);
    expect(recalled!.algorithmVersion).toBe(ALGORITHM_VERSION);

    // A different intent is a different decision, so it must not be served.
    expect(second.recall(plan.from.uri, plan.to!.uri, "energetic")).toBeNull();
    first.dispose();
    second.dispose();
  });

  it("surfaces pairings that keep coming out badly", () => {
    const memory = new TransitionMemory(null);
    const bad = calculateTransition({
      fromTrack: track({ uri: uriFor(90), albumUri: "spotify:album:x" }),
      toTrack: track({ uri: uriFor(91), artists: ["Z"], albumUri: "spotify:album:y" }),
      fromAnalysis: analysis({ uri: uriFor(90), tempo: 82, key: 0, mode: 1, energy: 0.2 }),
      toAnalysis: analysis({ uri: uriFor(91), tempo: 148, key: 6, mode: 0, energy: 0.95 }),
      settings: settings(),
      capabilities: capabilities("dj"),
    });
    vi.useFakeTimers();
    try {
      memory.remember(bad, "balanced");
      vi.advanceTimersByTime(30 * 60 * 1000);
      memory.remember(bad, "balanced");
    } finally {
      vi.useRealTimers();
    }
    const weak = memory.recurringWeakPairs();
    expect(weak).toHaveLength(1);
    expect(weak[0]!.timesSeen).toBe(2);
    memory.dispose();
  });
});

describe("planning stays fast over a long run", () => {
  it("computes a thousand plans well inside a frame budget each", () => {
    const started = Date.now();
    for (let i = 0; i < 1000; i++) planFor(i);
    const elapsed = Date.now() - started;
    // Generous for CI, but it would catch an accidental O(n^2) or a re-analysis
    // creeping into the hot path.
    expect(elapsed).toBeLessThan(5000);
  });
});
