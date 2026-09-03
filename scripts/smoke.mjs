/**
 * Integration smoke test.
 *
 * Boots the built bundle against a stubbed Spotify client. The unit tests cover
 * the engine, which is pure; this covers the parts that are not — capability
 * probing, the analysis chain, scheduling, and the audio executors — without
 * needing a real Spotify install.
 *
 * Two scenarios:
 *   1. A Premium-shaped client with a writable crossfade and a well-matched
 *      pair. Expects a long, phrase-aligned overlap.
 *   2. A Free-shaped client with no crossfade write path and a badly-matched
 *      pair. Expects a short fade, honest caveats, and the user's volume
 *      restored exactly.
 *
 * Run with `npm run smoke` after `npm run build`.
 */
import { readFileSync, existsSync } from "node:fs";

const BUNDLE = new URL("../dist/smart-dj.js", import.meta.url);
if (!existsSync(BUNDLE)) {
  console.error("dist/smart-dj.js not found — run `npm run build` first.");
  process.exit(1);
}

const failures = [];
const check = (ok, message) => {
  console.log(`  ${ok ? "✓" : "✗"} ${message}`);
  if (!ok) failures.push(message);
};

// ── A DOM just large enough for the extension's UI layer ────────────────────
function stubDom() {
  const mkEl = (tag) => {
    const el = {
      tagName: tag, children: [], attrs: {}, style: {}, className: "",
      textContent: "", innerHTML: "", disabled: false, value: "",
      append: (...c) => el.children.push(...c),
      appendChild: (c) => (el.children.push(c), c),
      setAttribute: (k, v) => (el.attrs[k] = String(v)),
      getAttribute: (k) => el.attrs[k] ?? null,
      addEventListener: () => {}, removeEventListener: () => {},
      replaceWith: () => {}, remove: () => {},
    };
    return el;
  };
  globalThis.document = {
    createElement: mkEl,
    createTextNode: (t) => ({ text: t }),
    head: mkEl("head"),
    body: mkEl("body"),
  };
  globalThis.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.get(k) ?? null; },
    setItem(k, v) { this._m.set(k, v); },
  };
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
}

/** A plausible audio-analysis payload for a track. */
function payload(bpm, key, mode, durationSec, loudness) {
  const spb = 60 / bpm;
  return {
    track: {
      duration: durationSec, tempo: bpm, tempo_confidence: 0.9, time_signature: 4,
      key, mode, key_confidence: 0.85, loudness,
      end_of_fade_in: 0, start_of_fade_out: durationSec - 8,
    },
    beats: Array.from({ length: Math.floor(durationSec / spb) }, (_, i) => ({
      start: i * spb, duration: spb, confidence: 0.9,
    })),
    bars: Array.from({ length: Math.floor(durationSec / (spb * 4)) }, (_, i) => ({
      start: i * spb * 4, duration: spb * 4, confidence: 0.85,
    })),
    sections: [0, 30, 80, 130, 170].filter((s) => s < durationSec - 5).map((s) => ({
      start: s, duration: 30, confidence: 0.85, loudness, tempo: bpm, key, mode, time_signature: 4,
    })),
    segments: Array.from({ length: 400 }, (_, i) => ({
      start: i * 0.5, duration: 0.5,
      loudness_start: loudness - 16, loudness_max: loudness,
      timbre: [40, bpm > 120 ? 90 : -50, 5],
    })),
  };
}

function stubSpicetify({ crossfadeWritable, productType, a, b, io }) {
  const configApi = crossfadeWritable
    ? {
        _s: {},
        setAccountSetting: async (k, v) => { configApi._s[k] = v; },
        getAccountSetting: async (k) => configApi._s[k],
      }
    : undefined;

  const reject = async () => { throw new Error("Resolver not found"); };

  globalThis.Spicetify = {
    Player: {
      data: { item: a.track, nextItems: [b.track] },
      getProgress: () => io.position,
      getDuration: () => a.track.duration.milliseconds,
      isPlaying: () => true,
      getRepeat: () => 0,
      getVolume: () => io.volume,
      setVolume: (v) => { io.volume = v; io.volumeTrace.push(v); },
      next: () => { io.nextCalls++; },
      seek: (ms) => { io.seekedTo = ms; },
      addEventListener: () => {}, removeEventListener: () => {},
    },
    Platform: {
      PlaybackAPI: { setVolume: (v) => { io.volume = v; io.volumeTrace.push(v); }, _volume: io.volume },
      PlayerAPI: {},
      ...(configApi ? { ConfigAPI: configApi } : {}),
      UserAPI: { _product_state: { getValues: async () => ({ pairs: { type: productType } }) } },
    },
    CosmosAsync: { get: async () => ({}), post: reject, put: reject },
    Queue: { nextTracks: [b.track], prevTracks: [], queueRevision: "1", track: a.track },
    URI: { Type: { TRACK: "track" }, from: (u) => ({ Type: "track", getBase62Id: () => u.split(":")[2] }) },
    LocalStorage: {
      get: (k) => globalThis.localStorage.getItem(k),
      set: (k, v) => globalThis.localStorage.setItem(k, v),
    },
    Playbar: { Button: class { deregister() {} } },
    PopupModal: { display: () => {} },
    showNotification: () => {},
    getAudioData: async (uri) => (uri === a.track.uri ? a.analysis : b.analysis),
  };
}

const mkTrack = (id, name, albumId, durationMs) => ({
  uri: `spotify:track:${String(id).repeat(22).slice(0, 22)}`,
  name, artists: [{ name: `Artist ${id}` }],
  album: { uri: `spotify:album:${albumId}` },
  duration: { milliseconds: durationMs }, metadata: {},
});

async function boot() {
  new Function(readFileSync(BUNDLE, "utf8"))();
  await new Promise((r) => setTimeout(r, 800));
  const api = globalThis.SmartDJ;
  if (!api) throw new Error("window.SmartDJ was never exposed");
  return api;
}

// ── Scenario 1 — overlap available, well-matched pair ──────────────────────
async function scenarioOverlap() {
  console.log("\nScenario 1 — writable crossfade, well-matched pair");
  stubDom();
  const io = { volume: 0.8, volumeTrace: [], position: 0, nextCalls: 0, seekedTo: null };
  stubSpicetify({
    crossfadeWritable: true,
    productType: "premium",
    a: { track: mkTrack(1, "Track A", "1", 240000), analysis: payload(128, 9, 0, 240, -6.5) },
    b: { track: mkTrack(2, "Track B", "2", 210000), analysis: payload(126, 9, 0, 210, -6.5) },
    io,
  });

  const api = await boot();
  const caps = api.dj.getCapabilities();
  check(caps.tier === "dj", `capability tier is "dj" (got "${caps.tier}")`);
  check(caps.tempoControl.status === "unavailable", "tempo control correctly reported unavailable");
  check(caps.audioDsp.status === "unavailable", "audio DSP correctly reported unavailable");

  await api.replan();
  const plan = api.dj.getPlan();
  console.log(`    → ${(plan.compatibility.overall * 100).toFixed(0)}% · ${plan.technique} · ${plan.durationSec}s / ${plan.durationBeats} beats at ${plan.startPointSec}s`);

  check(plan.executor === "native-crossfade", "uses the real-overlap path");
  check(plan.technique === "beat-aligned-blend", "picks a beat-aligned blend");
  check(plan.compatibility.overall > 0.85, "scores the pair above 85%");
  check(plan.phraseAlignment, "switch lands on a phrase boundary");
  check(plan.beatAlignment, "downbeat alignment enabled");
  check(plan.durationBeats % 8 === 0, `blend is a multiple of 8 beats (${plan.durationBeats})`);
  check(plan.durationSec <= 12, "stays inside Spotify's 12 s crossfade ceiling");
  check(plan.startPointSec < 240, "exits before the end of the track");
  check(plan.bpmAdjustmentApplied === false, "never claims to have applied a tempo change");

  api.teardown();
}

// ── Scenario 2 — no overlap, badly-matched pair ────────────────────────────
async function scenarioFallback() {
  console.log("\nScenario 2 — no crossfade write path, incompatible pair");
  stubDom();
  const START_VOLUME = 0.73;
  const io = { volume: START_VOLUME, volumeTrace: [], position: 0, nextCalls: 0, seekedTo: null };
  stubSpicetify({
    crossfadeWritable: false,
    productType: "free",
    a: { track: mkTrack(1, "Slow Ballad", "1", 180000), analysis: payload(90, 0, 1, 180, -13) },
    b: { track: mkTrack(2, "Fast Banger", "2", 200000), analysis: payload(145, 6, 0, 200, -5) },
    io,
  });

  const api = await boot();
  const caps = api.dj.getCapabilities();
  check(caps.tier === "fade", `capability tier is "fade" (got "${caps.tier}")`);

  await api.replan();
  const plan = api.dj.getPlan();
  console.log(`    → ${(plan.compatibility.overall * 100).toFixed(0)}% · ${plan.technique} · ${plan.durationSec}s`);

  check(plan.executor === "volume-fade", "falls back to the fade path");
  check(plan.compatibility.overall < 0.45, "scores the mismatched pair below 45%");
  check(plan.durationSec <= 5, `keeps the transition short (${plan.durationSec}s)`);
  check(
    plan.caveats.some((c) => /no real audio overlap/i.test(c)),
    "states that no audio overlap is available",
  );
  check(
    plan.caveats.some((c) => /no playback-rate control/i.test(c)),
    "states that beatmatching is impossible",
  );

  const outcome = await api.dj.audio.execute(plan);
  console.log(`    → ${outcome.status}: ${outcome.note}`);
  check(outcome.status === "completed", "the fade executes");
  check(io.nextCalls === 1, `next() called exactly once (got ${io.nextCalls})`);
  check(Math.min(...io.volumeTrace) < START_VOLUME * 0.2, "actually faded down");
  check(
    Math.abs(io.volume - START_VOLUME) < 1e-6,
    `volume restored exactly (${io.volume} vs ${START_VOLUME})`,
  );
  check(
    io.volumeTrace.every((v) => v >= 0 && v <= 1),
    "volume never left the 0..1 range",
  );

  api.teardown();
}

// ── Scenario 3 — album segue is left alone ─────────────────────────────────
async function scenarioAlbumSegue() {
  console.log("\nScenario 3 — consecutive tracks from one album");
  stubDom();
  const io = { volume: 0.8, volumeTrace: [], position: 0, nextCalls: 0, seekedTo: null };
  stubSpicetify({
    crossfadeWritable: true,
    productType: "premium",
    a: { track: mkTrack(1, "Side A/1", "same", 240000), analysis: payload(120, 9, 0, 240, -7) },
    b: { track: mkTrack(2, "Side A/2", "same", 200000), analysis: payload(120, 9, 0, 200, -7) },
    io,
  });

  const api = await boot();
  await api.replan();
  const plan = api.dj.getPlan();
  console.log(`    → ${plan.technique} via ${plan.executor}`);
  check(plan.technique === "gapless-passthrough", "leaves the album segue intact");
  check(plan.executor === "passive", "does not touch playback");
  check(plan.durationSec === 0, "plans no transition at all");
  check(io.nextCalls === 0, "never calls next()");

  api.teardown();
}

console.log("Smart DJ — integration smoke test");
await scenarioOverlap();
await scenarioFallback();
await scenarioAlbumSegue();

console.log(
  failures.length === 0
    ? "\nAll smoke checks passed."
    : `\n${failures.length} smoke check(s) failed.`,
);
process.exit(failures.length === 0 ? 0 : 1);
