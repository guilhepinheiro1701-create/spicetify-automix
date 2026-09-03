import { describe, expect, it, vi } from "vitest";
import { AnalysisCache, MEMORY_LIMIT, PERSISTENT_LIMIT, compact } from "../src/analysis/cache.js";
import { CACHE_STORAGE_KEY } from "../src/config/defaults.js";
import { analysis, memoryStorage } from "./helpers.js";

const uri = (i: number) => `spotify:track:${String(i).padStart(22, "0")}`;

describe("compaction", () => {
  it("drops the heavy arrays but keeps the derived grid", () => {
    const a = analysis({ tempo: 128 });
    expect(a.beats!.length).toBeGreaterThan(100);
    const c = compact(a);
    expect("beats" in c).toBe(false);
    expect("bars" in c).toBe(false);
    expect("segments" in c).toBe(false);
    expect(c.grid).toBeTruthy();
    expect(c.tempo).toBe(128);
    expect(c.sections!.length).toBeGreaterThan(0);
  });

  it("shrinks the stored payload by an order of magnitude", () => {
    const a = analysis({ tempo: 128 });
    const full = JSON.stringify(a).length;
    const small = JSON.stringify(compact(a)).length;
    expect(small * 5).toBeLessThan(full);
  });
});

describe("AnalysisCache", () => {
  it("round-trips through memory", () => {
    const cache = new AnalysisCache(memoryStorage());
    const a = analysis({ uri: uri(1), tempo: 128 });
    cache.set(uri(1), a);
    expect(cache.get(uri(1))!.tempo).toBe(128);
    expect(cache.has(uri(1))).toBe(true);
    expect(cache.get(uri(2))).toBeNull();
  });

  it("evicts the least recently used from memory but keeps it on disk", () => {
    const storage = memoryStorage();
    const cache = new AnalysisCache(storage);
    for (let i = 0; i < MEMORY_LIMIT + 10; i++) {
      cache.set(uri(i), analysis({ uri: uri(i), tempo: 100 + i }));
    }
    expect(cache.stats().memory).toBeLessThanOrEqual(MEMORY_LIMIT);
    // Evicted entries survive in the compact tier.
    expect(cache.get(uri(0))).not.toBeNull();
    expect(cache.get(uri(0))!.tempo).toBe(100);
  });

  it("caps the persistent tier", () => {
    const cache = new AnalysisCache(memoryStorage());
    for (let i = 0; i < PERSISTENT_LIMIT + 25; i++) {
      cache.set(uri(i), analysis({ uri: uri(i), sections: [], beats: [], bars: [] }));
    }
    expect(cache.stats().persistent).toBeLessThanOrEqual(PERSISTENT_LIMIT);
  });

  it("remembers a negative result so the endpoints are not re-queried forever", () => {
    // A heuristic entry means every provider came back empty. Persisting it is
    // deliberate: otherwise the same track re-queries the internal services on
    // every play, for an answer we already have.
    const storage = memoryStorage();
    const cache = new AnalysisCache(storage);
    cache.set(uri(1), analysis({ uri: uri(1), source: "heuristic" }));
    cache.flush();
    expect(cache.stats().persistent).toBe(1);
    expect(cache.get(uri(1))).not.toBeNull();
  });

  it("never persists a result with no source at all", () => {
    const cache = new AnalysisCache(memoryStorage());
    cache.set(uri(2), analysis({ uri: uri(2), source: "none" }));
    cache.flush();
    expect(cache.stats().persistent).toBe(0);
  });

  it("restores from storage across instances", () => {
    const storage = memoryStorage();
    const first = new AnalysisCache(storage);
    first.set(uri(7), analysis({ uri: uri(7), tempo: 174 }));
    first.flush();

    const second = new AnalysisCache(storage);
    expect(second.get(uri(7))!.tempo).toBe(174);
  });

  it("starts clean when the stored payload is corrupt", () => {
    const storage = memoryStorage();
    storage.map.set(CACHE_STORAGE_KEY, "{{{");
    expect(() => new AnalysisCache(storage)).not.toThrow();
    expect(new AnalysisCache(storage).stats().persistent).toBe(0);
  });

  it("ignores a payload written by a future version", () => {
    const storage = memoryStorage();
    storage.map.set(CACHE_STORAGE_KEY, JSON.stringify({ v: 99, entries: [[uri(1), {}]] }));
    expect(new AnalysisCache(storage).stats().persistent).toBe(0);
  });

  it("trims and retries when storage rejects the write", () => {
    let calls = 0;
    const storage = {
      get: () => null,
      set: () => {
        calls++;
        if (calls === 1) throw new Error("QuotaExceededError");
      },
    };
    const cache = new AnalysisCache(storage);
    for (let i = 0; i < 40; i++) cache.set(uri(i), analysis({ uri: uri(i) }));
    expect(() => cache.flush()).not.toThrow();
    expect(calls).toBe(2);
  });

  it("survives storage that always throws", () => {
    const storage = {
      get: () => null,
      set: () => {
        throw new Error("nope");
      },
    };
    const cache = new AnalysisCache(storage);
    cache.set(uri(1), analysis({ uri: uri(1) }));
    expect(() => cache.flush()).not.toThrow();
    // The in-memory tier keeps working regardless.
    expect(cache.get(uri(1))).not.toBeNull();
  });

  it("works with no storage at all", () => {
    const cache = new AnalysisCache(null);
    cache.set(uri(1), analysis({ uri: uri(1), tempo: 90 }));
    expect(cache.get(uri(1))!.tempo).toBe(90);
    expect(() => cache.flush()).not.toThrow();
  });

  it("clears both tiers", () => {
    const cache = new AnalysisCache(memoryStorage());
    cache.set(uri(1), analysis({ uri: uri(1) }));
    cache.clear();
    expect(cache.stats()).toEqual({ memory: 0, persistent: 0 });
  });

  it("debounces writes rather than hitting storage per track", () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const spy = vi.spyOn(storage, "set");
    const cache = new AnalysisCache(storage);
    for (let i = 0; i < 30; i++) cache.set(uri(i), analysis({ uri: uri(i) }));
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
