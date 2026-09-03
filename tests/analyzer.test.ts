import { describe, expect, it, vi } from "vitest";
import { MusicAnalyzer } from "../src/analysis/analyzer.js";
import { SetlistPlanner, linkScore } from "../src/queue/setlist.js";
import { ManualProvider } from "../src/analysis/providers/manual.js";
import { ExternalProvider } from "../src/analysis/providers/external.js";
import { analysis, memoryStorage, track } from "./helpers.js";

describe("MusicAnalyzer", () => {
  it("always returns an analysis, even with no provider data", async () => {
    const a = new MusicAnalyzer({ storage: memoryStorage() });
    const result = await a.analyze(track({ uri: "spotify:track:x1" }));
    expect(result).not.toBeNull();
    expect(result!.source).toBe("heuristic");
    expect(result!.confidence).toBeLessThan(0.2);
  });

  it("returns null for a null track rather than throwing", async () => {
    const a = new MusicAnalyzer({ storage: memoryStorage() });
    expect(await a.analyze(null)).toBeNull();
  });

  it("caches, so a second call does no work", async () => {
    const a = new MusicAnalyzer({ storage: memoryStorage() });
    const t = track({ uri: "spotify:track:x2" });
    const first = await a.analyze(t);
    const second = await a.analyze(t);
    expect(second).toBe(first);
  });

  it("deduplicates concurrent requests for the same track", async () => {
    const a = new MusicAnalyzer({ storage: memoryStorage() });
    const t = track({ uri: "spotify:track:x3" });
    const [p, q] = await Promise.all([a.analyze(t), a.analyze(t)]);
    expect(p).toBe(q);
  });

  it("prefers a manual override over everything else", async () => {
    const a = new MusicAnalyzer({ storage: memoryStorage() });
    const t = track({ uri: "spotify:track:x4" });
    a.setOverride(t.uri, { tempo: 174, key: 4, mode: 0 });
    const result = await a.analyze(t);
    expect(result!.source).toBe("manual");
    expect(result!.tempo).toBe(174);
    expect(result!.confidence).toBeGreaterThan(0.9);
  });

  it("builds a phrase grid whenever a tempo is known", async () => {
    const a = new MusicAnalyzer({ storage: memoryStorage() });
    const t = track({ uri: "spotify:track:x5" });
    a.setOverride(t.uri, { tempo: 128 });
    const result = await a.analyze(t);
    expect(result!.grid).not.toBeNull();
    expect(result!.grid!.secPerBeat).toBeCloseTo(60 / 128, 6);
  });

  it("peek does not trigger a fetch", () => {
    const a = new MusicAnalyzer({ storage: memoryStorage() });
    expect(a.peek("spotify:track:never-seen")).toBeNull();
  });

  it("tracks provider health", async () => {
    const a = new MusicAnalyzer({ storage: memoryStorage() });
    await a.analyze(track({ uri: "spotify:track:x6" }));
    const heuristic = a.getHealth().find((h) => h.id === "heuristic");
    expect(heuristic!.attempts).toBeGreaterThan(0);
    expect(heuristic!.hits).toBeGreaterThan(0);
  });
});

describe("ManualProvider", () => {
  it("persists and restores overrides", async () => {
    const storage = memoryStorage();
    const first = new ManualProvider(storage);
    first.set("spotify:track:m1", { tempo: 140 });

    const second = new ManualProvider(storage);
    expect(second.getOverride("spotify:track:m1")!.tempo).toBe(140);
    expect((await second.fetch(track({ uri: "spotify:track:m1" })))!.tempo).toBe(140);
  });

  it("deletes an override when set to null", () => {
    const p = new ManualProvider(memoryStorage());
    p.set("spotify:track:m2", { tempo: 100 });
    p.set("spotify:track:m2", null);
    expect(p.getOverride("spotify:track:m2")).toBeNull();
    expect(p.isAvailable()).toBe(false);
  });

  it("survives corrupt stored overrides", () => {
    const storage = memoryStorage();
    storage.map.set("smart-dj:overrides:v1", "not json");
    expect(() => new ManualProvider(storage)).not.toThrow();
  });
});

describe("ExternalProvider", () => {
  it("stays unavailable until explicitly configured with https", () => {
    const p = new ExternalProvider();
    expect(p.isAvailable()).toBe(false);
    p.configure({ enabled: true, url: "http://insecure.example/x" });
    expect(p.isAvailable()).toBe(false);
    p.configure({ enabled: true, url: "https://ok.example/x" });
    expect(p.isAvailable()).toBe(true);
    p.configure({ enabled: false, url: "https://ok.example/x" });
    expect(p.isAvailable()).toBe(false);
  });

  it("sends only the id, title and artist — no credentials", async () => {
    const p = new ExternalProvider();
    p.configure({ enabled: true, url: "https://ok.example/analysis" });
    const spy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ bpm: 128, key: 9, mode: 0 }),
    }));
    vi.stubGlobal("fetch", spy);

    const result = await p.fetch(track({ uri: "spotify:track:e1", id: "e1", name: "Song" }));
    expect(result!.tempo).toBe(128);
    expect(result!.source).toBe("external");

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect([...parsed.searchParams.keys()].sort()).toEqual(["artist", "id", "title"]);
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
    vi.unstubAllGlobals();
  });

  it("disables itself after repeated failures instead of retrying forever", async () => {
    const p = new ExternalProvider();
    p.configure({ enabled: true, url: "https://ok.example/analysis" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    const t = track({ uri: "spotify:track:e2", id: "e2" });
    for (let i = 0; i < 5; i++) expect(await p.fetch(t)).toBeNull();
    expect(p.isAvailable()).toBe(false);
    vi.unstubAllGlobals();
  });

  it("rejects an out-of-range payload rather than trusting it", async () => {
    const p = new ExternalProvider();
    p.configure({ enabled: true, url: "https://ok.example/analysis" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ bpm: 9000, key: 99 }) })),
    );
    expect(await p.fetch(track({ uri: "spotify:track:e3", id: "e3" }))).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("SetlistPlanner", () => {
  it("scores the chain and finds the weak link", async () => {
    const analyzer = new MusicAnalyzer({ storage: memoryStorage() });
    const a = track({ uri: "spotify:track:s0", name: "A" });
    const b = track({ uri: "spotify:track:s1", name: "B" });
    const c = track({ uri: "spotify:track:s2", name: "C" });

    analyzer.setOverride(a.uri, { tempo: 128, key: 9, mode: 0, energy: 0.8 });
    analyzer.setOverride(b.uri, { tempo: 127, key: 9, mode: 0, energy: 0.82 });
    analyzer.setOverride(c.uri, { tempo: 85, key: 6, mode: 1, energy: 0.25 });

    const aAnalysis = (await analyzer.analyze(a))!;
    const report = await new SetlistPlanner(analyzer).report(a, aAnalysis, [b, c]);

    expect(report.chain).toHaveLength(3);
    expect(report.links).toHaveLength(2);
    // A→B is strong, B→C is the problem.
    expect(report.links[0]!.score).toBeGreaterThan(0.85);
    expect(report.links[1]!.score).toBeLessThan(0.45);
    expect(report.weakLinks[0]!.index).toBe(1);
    expect(report.flowScore).toBeGreaterThan(0);
    expect(report.flowScore).toBeLessThan(1);
  });

  it("reports honestly that context tracks cannot be reordered", async () => {
    const analyzer = new MusicAnalyzer({ storage: memoryStorage() });
    const a = track({ uri: "spotify:track:s0" });
    const b = track({ uri: "spotify:track:s1", provider: "context" });
    const aAnalysis = (await analyzer.analyze(a))!;
    const report = await new SetlistPlanner(analyzer).report(a, aAnalysis, [b]);

    expect(report.reorderable).toBe(false);
    expect(report.reorderNote).toMatch(/playing context|cannot reorder/i);
  });

  it("proposes promoting a user-queued track over a poor next transition", async () => {
    const analyzer = new MusicAnalyzer({ storage: memoryStorage() });
    const a = track({ uri: "spotify:track:s0", name: "Now" });
    const bad = track({ uri: "spotify:track:s1", name: "Clash", provider: "queue" });
    const good = track({ uri: "spotify:track:s2", name: "Fits", provider: "queue" });

    analyzer.setOverride(a.uri, { tempo: 128, key: 9, mode: 0, energy: 0.8 });
    analyzer.setOverride(bad.uri, { tempo: 82, key: 6, mode: 1, energy: 0.2 });
    analyzer.setOverride(good.uri, { tempo: 128, key: 9, mode: 0, energy: 0.83 });

    const planner = new SetlistPlanner(analyzer);
    const aAnalysis = (await analyzer.analyze(a))!;
    const report = await planner.report(a, aAnalysis, [bad, good]);
    expect(report.reorderable).toBe(true);

    const proposal = await planner.proposeReorder(report);
    expect(proposal).not.toBeNull();
    expect(proposal!.promote.uri).toBe(good.uri);
    expect(proposal!.proposedScore).toBeGreaterThan(proposal!.currentScore + 0.15);
  });

  it("proposes nothing when the next transition is already good", async () => {
    const analyzer = new MusicAnalyzer({ storage: memoryStorage() });
    const a = track({ uri: "spotify:track:s0" });
    const b = track({ uri: "spotify:track:s1", provider: "queue" });
    const c = track({ uri: "spotify:track:s2", provider: "queue" });
    analyzer.setOverride(a.uri, { tempo: 128, key: 9, mode: 0, energy: 0.8 });
    analyzer.setOverride(b.uri, { tempo: 128, key: 9, mode: 0, energy: 0.82 });
    analyzer.setOverride(c.uri, { tempo: 128, key: 9, mode: 0, energy: 0.84 });

    const planner = new SetlistPlanner(analyzer);
    const aAnalysis = (await analyzer.analyze(a))!;
    const report = await planner.report(a, aAnalysis, [b, c]);
    expect(await planner.proposeReorder(report)).toBeNull();
  });

  it("never promotes a context track, even when it would mix better", async () => {
    const analyzer = new MusicAnalyzer({ storage: memoryStorage() });
    const a = track({ uri: "spotify:track:s0" });
    const bad = track({ uri: "spotify:track:s1", provider: "queue" });
    const goodButContext = track({ uri: "spotify:track:s2", provider: "context" });
    analyzer.setOverride(a.uri, { tempo: 128, key: 9, mode: 0, energy: 0.8 });
    analyzer.setOverride(bad.uri, { tempo: 82, key: 6, mode: 1, energy: 0.2 });
    analyzer.setOverride(goodButContext.uri, { tempo: 128, key: 9, mode: 0, energy: 0.82 });

    const planner = new SetlistPlanner(analyzer);
    const aAnalysis = (await analyzer.analyze(a))!;
    const report = await planner.report(a, aAnalysis, [bad, goodButContext]);
    expect(await planner.proposeReorder(report)).toBeNull();
  });

  it("linkScore stays in range for every extreme", () => {
    const pairs = [
      [analysis({ tempo: 60, key: 0, mode: 1, energy: 0 }), analysis({ tempo: 180, key: 6, mode: 0, energy: 1 })],
      [analysis({ tempo: 128 }), analysis({ tempo: 128 })],
    ] as const;
    for (const [x, y] of pairs) {
      const v = linkScore(x, y);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("sequence analysis", () => {
  it("detects an energy cliff, a BPM cliff and a key clash", async () => {
    const { detectIssues } = await import("../src/queue/setlist.js");
    const a = track({ uri: "spotify:track:i0", name: "Calm" });
    const b = track({ uri: "spotify:track:i1", name: "Banger" });
    const analyses = [
      analysis({ tempo: 82, key: 0, mode: 1, energy: 0.2 }),
      analysis({ tempo: 140, key: 6, mode: 0, energy: 0.95 }),
    ];
    const links = [
      {
        from: a,
        to: b,
        score: 0.2,
        band: "very-poor" as const,
        index: 0,
        tempoDetail: "",
        keyDetail: "",
        energyDetail: "",
      },
    ];
    const issues = detectIssues([a, b], analyses, links);
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain("energy-cliff");
    expect(kinds).toContain("bpm-cliff");
    expect(kinds).toContain("key-clash");
    expect(kinds).toContain("weak-transition");
    // Sorted worst first.
    expect(issues[0]!.severity).toBeGreaterThanOrEqual(issues[issues.length - 1]!.severity);
  });

  it("flags a run of tracks by the same artist", async () => {
    const { detectIssues } = await import("../src/queue/setlist.js");
    const chain = [0, 1, 2, 3].map((i) =>
      track({ uri: `spotify:track:r${i}`, artists: ["Same Artist"] }),
    );
    const issues = detectIssues(chain, [null, null, null, null], []);
    expect(issues.some((i) => i.kind === "repeated-style")).toBe(true);
  });

  it("optimizeSequence proposes a better order without touching context tracks", async () => {
    const { optimizeSequence } = await import("../src/queue/setlist.js");
    const _now = track({ uri: "spotify:track:o0" });
    const clash = track({ uri: "spotify:track:o1", provider: "queue" });
    const fits = track({ uri: "spotify:track:o2", provider: "queue" });

    const nowA = analysis({ tempo: 128, key: 9, mode: 0, energy: 0.8 });
    const clashA = analysis({ tempo: 82, key: 6, mode: 1, energy: 0.2 });
    const fitsA = analysis({ tempo: 128, key: 9, mode: 0, energy: 0.82 });

    const plan = optimizeSequence(nowA, [clash, fits], [clashA, fitsA]);
    expect(plan.applicable).toBe(true);
    expect(plan.proposed[0]!.uri).toBe(fits.uri);
    expect(plan.proposedScore).toBeGreaterThan(plan.currentScore);
    expect(plan.moves.length).toBeGreaterThan(0);
  });

  it("optimizeSequence refuses when nothing is movable", async () => {
    const { optimizeSequence } = await import("../src/queue/setlist.js");
    const _now = track({ uri: "spotify:track:c0" });
    const a = track({ uri: "spotify:track:c1", provider: "context" });
    const b = track({ uri: "spotify:track:c2", provider: "context" });
    const plan = optimizeSequence(analysis(), [a, b], [analysis(), analysis()]);
    expect(plan.applicable).toBe(false);
    expect(plan.moves).toEqual([]);
    expect(plan.note).toMatch(/playing context/i);
    // And it must never silently change the order.
    expect(plan.proposed.map((t) => t.uri)).toEqual([a.uri, b.uri]);
  });
});

describe("energy trajectory", () => {
  it("reads a building set and rewards continuing it", async () => {
    const { readTrajectory, fitsTrajectory } = await import("../src/queue/trajectory.js");
    const t = readTrajectory([0.5, 0.58, 0.66, 0.72]);
    expect(t.shape).toBe("building");
    expect(t.slope).toBeGreaterThan(0);
    expect(fitsTrajectory(t, 0.8).score).toBeGreaterThan(0.8);
    expect(fitsTrajectory(t, 0.45).score).toBeLessThan(0.5);
  });

  it("reads a peak and prefers a release over another push", async () => {
    const { readTrajectory, fitsTrajectory } = await import("../src/queue/trajectory.js");
    const t = readTrajectory([0.7, 0.8, 0.88, 0.92]);
    expect(t.shape).toBe("peaking");
    expect(fitsTrajectory(t, 0.75).score).toBeGreaterThan(fitsTrajectory(t, 0.99).score);
  });

  it("reads a comedown and an erratic run", async () => {
    const { readTrajectory } = await import("../src/queue/trajectory.js");
    expect(readTrajectory([0.9, 0.8, 0.7, 0.6]).shape).toBe("releasing");
    expect(readTrajectory([0.2, 0.9, 0.25, 0.85, 0.3]).shape).toBe("erratic");
  });

  it("is neutral with too little data", async () => {
    const { readTrajectory, fitsTrajectory } = await import("../src/queue/trajectory.js");
    const t = readTrajectory([0.5]);
    expect(t.window).toHaveLength(1);
    expect(fitsTrajectory(t, 0.9).score).toBe(0.5);
  });
});
