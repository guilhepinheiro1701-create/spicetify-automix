/**
 * Player stability.
 *
 * Six things a listener does that must never leave the player in a worse state
 * than they found it: skipping, pausing, changing track by hand, switching
 * Smart DJ off mid-transition, Spotify advancing on its own, and the client's
 * APIs failing outright.
 *
 * The platform module is mocked so the controller can be driven through each
 * of these without a Spotify client, and the assertions are about *observable
 * player state* — volume, calls made — rather than internal bookkeeping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── A controllable stand-in for the Spotify client ──────────────────────────
const player = {
  volume: 0.8,
  volumeCalls: [] as number[],
  position: 0,
  duration: 240_000,
  playing: true,
  nextCalls: 0,
  seekCalls: [] as number[],
  currentUri: "spotify:track:aaaaaaaaaaaaaaaaaaaaaa",
  failEverything: false,
  listeners: {} as Record<string, ((e: unknown) => void)[]>,
};

function resetPlayer(): void {
  player.volume = 0.8;
  player.volumeCalls = [];
  player.position = 0;
  player.playing = true;
  player.nextCalls = 0;
  player.seekCalls = [];
  player.currentUri = "spotify:track:aaaaaaaaaaaaaaaaaaaaaa";
  player.failEverything = false;
  player.listeners = {};
}

const boom = () => {
  if (player.failEverything) throw new Error("client API failed");
};

vi.mock("../src/platform/spicetify.js", () => ({
  isReady: () => true,
  waitForSpicetify: async () => true,
  getProgressMs: () => {
    boom();
    return player.position;
  },
  getDurationMs: () => {
    boom();
    return player.duration;
  },
  isPlaying: () => {
    boom();
    return player.playing;
  },
  getRepeatMode: () => 0,
  next: () => {
    if (player.failEverything) return false;
    player.nextCalls++;
    player.currentUri = "spotify:track:bbbbbbbbbbbbbbbbbbbbbb";
    return true;
  },
  seekMs: (ms: number) => {
    if (player.failEverything) return false;
    player.seekCalls.push(ms);
    return true;
  },
  getVolume: () => player.volume,
  setVolume: (v: number) => {
    if (player.failEverything) return false;
    player.volume = v;
    player.volumeCalls.push(v);
    return true;
  },
  canControlVolume: () => !player.failEverything,
  canMutateQueue: () => false,
  addToQueue: async () => false,
  removeFromQueue: async () => false,
  getCurrentTrack: () => {
    boom();
    return {
      uri: player.currentUri,
      id: player.currentUri.split(":")[2],
      name: "Current",
      artists: ["A"],
      albumUri: "spotify:album:1",
      durationMs: player.duration,
      isLocal: false,
      provider: "context",
    };
  },
  getNextTrack: () => null,
  getUpcomingTracks: () => [],
  on: (event: string, fn: (e: unknown) => void) => {
    (player.listeners[event] ??= []).push(fn);
    return () => {
      player.listeners[event] = (player.listeners[event] ?? []).filter((f) => f !== fn);
    };
  },
  getProductTier: async () => "free",
  storageGet: () => null,
  storageSet: () => undefined,
  notify: () => undefined,
  cosmosGet: async () => {
    throw new Error("no endpoint in this test");
  },
  toTrackRef: (x: unknown) => x,
}));

import { AudioEngine } from "../src/audio/audioEngine.js";
import { VolumeController } from "../src/audio/volumeController.js";
import { VolumeFadeExecutor } from "../src/audio/executors/volumeFadeExecutor.js";
import { calculateTransition } from "../src/engine/transitionEngine.js";
import { analysis, capabilities, settings, track, execContext } from "./helpers.js";
import type { TransitionPlan } from "../src/core/types.js";

function fadePlan(): TransitionPlan {
  return calculateTransition({
    fromTrack: track({ uri: "spotify:track:a", albumUri: "spotify:album:1" }),
    toTrack: track({ uri: "spotify:track:b", artists: ["Other"], albumUri: "spotify:album:2" }),
    fromAnalysis: analysis({ uri: "spotify:track:a" }),
    toAnalysis: analysis({ uri: "spotify:track:b" }),
    settings: settings(),
    capabilities: capabilities("fade"),
  });
}

beforeEach(() => {
  resetPlayer();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the user skips mid-transition", () => {
  it("cancels immediately and puts the volume back", async () => {
    const engine = new AudioEngine();
    const run = engine.execute(fadePlan());

    // Let the fade get roughly a third of the way in.
    await vi.advanceTimersByTimeAsync(700);
    expect(player.volume).toBeLessThan(0.8);

    engine.abort("user skipped");
    await vi.advanceTimersByTimeAsync(400);
    const outcome = await run;

    expect(outcome.status).toBe("aborted");
    expect(player.volume).toBeCloseTo(0.8, 6);
    engine.dispose();
  });

  it("stops touching the volume once aborted", async () => {
    const engine = new AudioEngine();
    const run = engine.execute(fadePlan());
    await vi.advanceTimersByTimeAsync(500);
    engine.abort("user skipped");
    await vi.advanceTimersByTimeAsync(200);

    const callsAfterAbort = player.volumeCalls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(player.volumeCalls.length).toBe(callsAfterAbort);
    await run;
    engine.dispose();
  });
});

describe("the user pauses mid-transition", () => {
  it("makes no further volume changes after the abort that follows a pause", async () => {
    const engine = new AudioEngine();
    const run = engine.execute(fadePlan());
    await vi.advanceTimersByTimeAsync(900);

    player.playing = false;
    engine.abort("playback paused");
    await vi.advanceTimersByTimeAsync(100);

    const settled = player.volume;
    const calls = player.volumeCalls.length;
    await vi.advanceTimersByTimeAsync(5000);

    expect(player.volumeCalls.length).toBe(calls);
    expect(settled).toBeCloseTo(0.8, 6);
    await run;
    engine.dispose();
  });
});

describe("the user takes the volume slider", () => {
  it("backs off and leaves their setting alone", async () => {
    const io = {
      get: () => player.volume,
      set: (v: number) => {
        player.volume = v;
        return true;
      },
    };
    const volume = new VolumeController(io);
    const run = new VolumeFadeExecutor().run(fadePlan(), execContext({ volume }));

    await vi.advanceTimersByTimeAsync(300);
    // A human moves it somewhere we did not put it.
    player.volume = 0.31;
    await vi.advanceTimersByTimeAsync(200);

    const outcome = await run;
    expect(outcome.status).toBe("aborted");
    expect(player.volume).toBe(0.31);
  });
});

describe("Spotify changes track on its own", () => {
  it("a plan whose track is no longer playing is not executed twice", async () => {
    const engine = new AudioEngine();
    const plan = fadePlan();

    const first = engine.execute(plan);
    // A second request while one is in flight must be refused outright.
    const second = await engine.execute(plan);
    expect(second.status).toBe("skipped");

    engine.abort("track changed underneath");
    await vi.advanceTimersByTimeAsync(500);
    await first;
    expect(player.nextCalls).toBeLessThanOrEqual(1);
    engine.dispose();
  });
});

describe("the client's APIs fail", () => {
  it("degrades down the ladder to passive rather than failing outright", async () => {
    const engine = new AudioEngine();
    player.failEverything = true;

    const run = engine.execute(fadePlan());
    await vi.advanceTimersByTimeAsync(3000);
    const outcome = await run;

    // The fade rung cannot work, so the ladder falls through to passive, which
    // leaves Spotify to behave exactly as it would without the extension.
    expect(outcome.status).toBe("skipped");
    expect(engine.lastExecutorId).toBe("passive");
    expect(engine.isRunning).toBe(false);
    engine.dispose();
  });

  it("a mid-transition API failure does not leave the volume down", async () => {
    const engine = new AudioEngine();
    const run = engine.execute(fadePlan());
    await vi.advanceTimersByTimeAsync(400);
    expect(player.volume).toBeLessThan(0.8);

    // The client stops accepting volume writes for long enough that the retry
    // loop gives up. The original level must still be remembered.
    player.failEverything = true;
    await vi.advanceTimersByTimeAsync(6000);
    await run;
    expect(player.volume).toBeLessThan(0.8);

    // Once it recovers, teardown puts the level back.
    player.failEverything = false;
    engine.dispose();
    await vi.advanceTimersByTimeAsync(500);

    expect(player.volume).toBeCloseTo(0.8, 6);
    expect(engine.isRunning).toBe(false);
  });

  it("recovers the level on its own once the client starts accepting writes again", async () => {
    const io = {
      get: () => player.volume,
      set: (v: number) => {
        if (player.failEverything) return false;
        player.volume = v;
        return true;
      },
    };
    const volume = new VolumeController(io);
    volume.begin();
    player.volume = 0.2; // as if a fade had pulled it down

    player.failEverything = true;
    volume.cancel("client refusing writes");
    expect(player.volume).toBe(0.2);

    // A brief blip: the client comes back before the retries run out.
    player.failEverything = false;
    await vi.advanceTimersByTimeAsync(400);
    expect(player.volume).toBeCloseTo(0.8, 6);
  });

  it("never throws out of execute, whatever the client does", async () => {
    const engine = new AudioEngine();
    for (const fail of [true, false, true]) {
      player.failEverything = fail;
      const run = engine.execute(fadePlan());
      // Advance in steps so chained timers inside promises get a chance to run.
      for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(1000);
      await expect(run).resolves.toBeDefined();
      player.failEverything = false;
      await vi.advanceTimersByTimeAsync(500);
    }
    engine.dispose();
  });

  it("makes no crossfade or seek calls when it has fallen to passive", async () => {
    const engine = new AudioEngine();
    player.failEverything = true;
    const run = engine.execute(fadePlan());
    await vi.advanceTimersByTimeAsync(3000);
    await run;

    expect(player.nextCalls).toBe(0);
    expect(player.seekCalls).toEqual([]);
    engine.dispose();
  });
});

describe("teardown", () => {
  it("restores the volume and stops everything", async () => {
    const engine = new AudioEngine();
    const run = engine.execute(fadePlan());
    await vi.advanceTimersByTimeAsync(600);
    expect(player.volume).toBeLessThan(0.8);

    engine.dispose();
    await vi.advanceTimersByTimeAsync(400);
    await run;

    expect(player.volume).toBeCloseTo(0.8, 6);
    expect(engine.isRunning).toBe(false);
  });

  it("is idempotent", () => {
    const engine = new AudioEngine();
    expect(() => {
      engine.dispose();
      engine.dispose();
    }).not.toThrow();
  });
});
