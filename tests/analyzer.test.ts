import { describe, expect, it, vi } from "vitest";
import { MusicAnalyzer } from "../src/analysis/analyzer.js";
import { QueueIntelligence, quickScore } from "../src/queue/queueIntelligence.js";
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

describe("QueueIntelligence", () => {
  it("ranks the queue and spots a better option further down", async () => {
    const analyzer = new MusicAnalyzer({ storage: memoryStorage() });
    const current = analysis({ tempo: 128, key: 9, mode: 0, energy: 0.8 });

    const bad = track({ uri: "spotify:track:q1", name: "Clash" });
    const good = track({ uri: "spotify:track:q2", name: "Perfect" });
    analyzer.setOverride(bad.uri, { tempo: 90, key: 6, mode: 1, energy: 0.2 });
    analyzer.setOverride(good.uri, { tempo: 128, key: 9, mode: 0, energy: 0.83 });

    const report = await new QueueIntelligence(analyzer).report(current, [bad, good]);
    expect(report.candidates).toHaveLength(2);
    expect(report.best!.track.uri).toBe(good.uri);
    expect(report.betterOptionAvailable).toBe(true);
  });

  it("returns an empty report with nothing queued", async () => {
    const analyzer = new MusicAnalyzer({ storage: memoryStorage() });
    const report = await new QueueIntelligence(analyzer).report(analysis(), []);
    expect(report.candidates).toEqual([]);
    expect(report.best).toBeNull();
    expect(report.betterOptionAvailable).toBe(false);
  });

  it("quickScore stays in range for every extreme", () => {
    const pairs = [
      [analysis({ tempo: 60, key: 0, mode: 1, energy: 0 }), analysis({ tempo: 180, key: 6, mode: 0, energy: 1 })],
      [analysis({ tempo: 128 }), analysis({ tempo: 128 })],
    ] as const;
    for (const [a, b] of pairs) {
      const s = quickScore(a, b);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});
