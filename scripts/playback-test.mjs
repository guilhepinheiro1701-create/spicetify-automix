/**
 * Real-playback test.
 *
 * Loads the built bundle into a Spotify simulator that emits the events a real
 * client emits — crucially, `songchange` in response to our own `next()` — and
 * reports what actually happened to the volume and the timing.
 *
 * This is the harness that should have existed from the start. Run it with
 * `npm run playback`.
 */
import { readFileSync, existsSync } from "node:fs";
import { SpotifySimulator, analysisPayload, stubDom } from "./simulator.mjs";

const BUNDLE = new URL("../dist/smart-dj.js", import.meta.url);
if (!existsSync(BUNDLE)) {
  console.error("dist/smart-dj.js not found — run `npm run build` first.");
  process.exit(1);
}

const failures = [];
const check = (ok, message) => {
  console.log(`    ${ok ? "✓" : "✗"} ${message}`);
  if (!ok) failures.push(message);
};

function makeTrack(i, name, bpm, key, mode, durationSec, introSec, outroSec, provider = "context") {
  const base62 = String(i).repeat(22).slice(0, 22);
  return {
    uri: `spotify:track:${base62}`,
    name,
    artist: `Artist ${i}`,
    albumUri: `spotify:album:${i}`,
    durationMs: durationSec * 1000,
    provider,
    analysis: analysisPayload(bpm, key, mode, durationSec, -7, introSec, outroSec),
  };
}

/**
 * Run one session and return the simulator plus the extension's API.
 *
 * `startAtMs` is set close to the end of track 1 so a transition happens within
 * a short run rather than after four simulated minutes.
 */
async function session({
  name,
  playlist,
  crossfadeWritable = false,
  productType = "free",
  startVolume = 0.73,
  runForMs = 34_000,
  startBeforeEndMs = 26_000,
  switchLatencyMs = 120,
  settings = {},
  interrupt = null,
}) {
  console.log(`\n${name}`);
  stubDom();

  const sim = new SpotifySimulator({
    crossfadeWritable,
    productType,
    switchLatencyMs,
    featuresFor: () => ({ tempo: 128, key: 9, mode: 0, energy: 0.8, loudness: -7, time_signature: 4 }),
  });
  sim.playlist = playlist;
  sim.volume = startVolume;

  globalThis.Spicetify = sim.buildGlobal();
  delete globalThis.SmartDJ;

  // Load a fresh copy of the bundle for each session.
  new Function(readFileSync(BUNDLE, "utf8"))();
  await new Promise((r) => setTimeout(r, 400));

  const api = globalThis.SmartDJ;
  if (!api) throw new Error("window.SmartDJ was never exposed");
  if (Object.keys(settings).length > 0) api.settings.update(settings);

  // Start playback close to the end of the first track. Real time, because the
  // volume ramps and the scheduler both run on real timers — compressing the
  // clock would test something that never happens.
  const first = playlist[0];
  const startAtMs = Math.max(0, first.durationMs - startBeforeEndMs);

  const runPromise = sim.run({ startAtMs, forMs: runForMs, speed: 1 });
  if (interrupt) await interrupt(sim, api, runPromise);
  await runPromise;

  api.teardown?.();
  return { sim, api, startVolume };
}

/**
 * Block until the fade has actually begun.
 *
 * The transition fires around twenty seconds into a run, so an interrupt on a
 * short fixed timer lands before anything has happened and silently tests
 * nothing — which is exactly what the first version of this harness did.
 */
async function waitForFade(sim, budgetMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    await new Promise((r) => setTimeout(r, 20));
    if (sim.volumeWrites.length > 3) return true;
  }
  return false;
}

/** Print the volume as a compact trace so the shape is visible at a glance. */
function volumeTrace(writes, startVolume) {
  if (writes.length === 0) return "(never touched)";
  const shown = [startVolume, ...writes];
  const step = Math.max(1, Math.floor(shown.length / 14));
  const sampled = shown.filter((_, i) => i % step === 0 || i === shown.length - 1);
  return sampled.map((v) => Math.round(v * 100)).join(" → ");
}

function report(sim, startVolume) {
  const finalVolume = sim.volume;
  console.log(`    volume: ${volumeTrace(sim.volumeWrites, startVolume)}`);
  console.log(
    `    next() ${sim.nextCalls}× · seeks ${sim.seekCalls.length} · volume writes ${sim.volumeWrites.length}`,
  );
  const interesting = sim.events.filter(
    (e) => e.type !== "SESSION_START" && e.type !== "SESSION_END",
  );
  for (const e of interesting.slice(0, 12)) {
    console.log(
      `    ${String(e.at).padStart(6)}ms  pos ${(e.positionMs / 1000).toFixed(1)}s  vol ${Math.round(e.volume * 100)}%  ${e.type}${e.cause ? ` (${e.cause})` : ""}`,
    );
  }
  return finalVolume;
}

// ── Playlists ───────────────────────────────────────────────────────────────
const HOUSE_PAIR = [
  makeTrack(1, "House A", 128, 9, 0, 200, 30, 30),
  makeTrack(2, "House B", 127, 9, 0, 200, 30, 30),
  makeTrack(3, "House C", 126, 4, 0, 200, 30, 30),
];

const MISMATCH_PAIR = [
  makeTrack(1, "Ballad", 72, 0, 1, 200, 8, 12),
  makeTrack(2, "Banger", 145, 6, 0, 200, 4, 4),
];

// ── Case 1: the reported bug — Free account, fade path ───────────────────────
async function caseFadePath() {
  const { sim, startVolume } = await session({
    name: "CASE 1 — Free account, no crossfade (the reported bug)",
    playlist: HOUSE_PAIR,
    crossfadeWritable: false,
  });
  const finalVolume = report(sim, startVolume);

  check(sim.nextCalls >= 1, "a transition actually fired");
  check(
    Math.abs(finalVolume - startVolume) < 0.005,
    `volume returned to ${Math.round(startVolume * 100)}% (ended at ${Math.round(finalVolume * 100)}%)`,
  );
  const minVolume = Math.min(...sim.volumeWrites, startVolume);
  check(minVolume < startVolume * 0.6, "the level actually dipped");

  // The dip masks the client's switch gap. It must not be a fade to silence —
  // that is a hole in the music, and it is what made this sound like volume
  // automation rather than a transition.
  check(
    minVolume > startVolume * 0.12,
    `dipped to ${Math.round((minVolume / startVolume) * 100)}% of the user's level, not to silence`,
  );

  // And it must be brief. A dip spanning several seconds is a fade; a dip
  // spanning a bar is a cut.
  const firstWrite = sim.events.find((e) => e.type === "NEXT_CALLED");
  const dipEvents = sim.volumeWrites.length;
  check(
    dipEvents < 200,
    `moved the level ${dipEvents} times, not hundreds`,
  );
  check(Boolean(firstWrite), "the switch was actually reached");

  // The heart of it: did the volume come back up AFTER the track changed?
  const changeIndex = sim.events.findIndex((e) => e.type === "TRACK_CHANGED");
  const afterChange = sim.events.slice(changeIndex).map((e) => e.volume);
  const roseAfterChange =
    changeIndex >= 0 && Math.max(...afterChange, 0) > Math.min(...afterChange, 1) + 0.05;
  check(roseAfterChange, "the volume rose again after the track changed (a real fade-in)");

  return { sim, finalVolume, startVolume };
}

// ── Case 2: crossfade available ─────────────────────────────────────────────
async function caseCrossfade() {
  const { sim, startVolume } = await session({
    name: "CASE 2 — crossfade writable (Premium-shaped)",
    playlist: HOUSE_PAIR,
    crossfadeWritable: true,
    productType: "premium",
  });
  const finalVolume = report(sim, startVolume);

  check(sim.nextCalls >= 1, "a transition fired");
  // The setting is deliberately restored on teardown, so assert that it was
  // driven ON at transition time rather than checking the final state.
  const enabledWrites = sim.events.filter(
    (e) => e.type === "CROSSFADE_WRITE" && e.key === "audio.crossfade_v2" && e.value === true,
  );
  check(
    enabledWrites.length >= 1,
    `the crossfade setting was driven on for the transition (${enabledWrites.length} write(s))`,
  );
  const durationWrites = sim.events.filter(
    (e) => e.type === "CROSSFADE_WRITE" && e.key === "audio.crossfade.time_v2" && e.value > 0,
  );
  check(
    durationWrites.length >= 1,
    `a per-pair crossfade length was programmed (${durationWrites.map((w) => w.value).join(", ")} ms)`,
  );
  check(
    Math.abs(finalVolume - startVolume) < 0.005,
    `volume untouched or restored (${Math.round(finalVolume * 100)}%)`,
  );
  check(
    sim.volumeWrites.length === 0,
    "the overlap path did not touch the volume at all (Spotify's mixer does the work)",
  );
}

// ── Case 3: user skips mid-transition ───────────────────────────────────────
async function caseUserSkip() {
  const { sim, startVolume } = await session({
    name: "CASE 3 — user skips during the transition",
    playlist: HOUSE_PAIR,
    crossfadeWritable: false,
    interrupt: async (s) => {
      await waitForFade(s);
      s.record("USER_PRESSED_SKIP");
      s.advance("user skip");
    },
  });
  const finalVolume = report(sim, startVolume);
  check(sim.volumeWrites.length > 3, "the skip landed while a fade was actually running");
  check(
    Math.abs(finalVolume - startVolume) < 0.005,
    `volume restored after a user skip (${Math.round(finalVolume * 100)}%)`,
  );
}

// ── Case 4: user pauses mid-transition ──────────────────────────────────────
async function casePause() {
  const { sim, startVolume } = await session({
    name: "CASE 4 — user pauses during the transition",
    playlist: HOUSE_PAIR,
    crossfadeWritable: false,
    interrupt: async (s) => {
      await waitForFade(s);
      s.record("USER_PRESSED_PAUSE");
      s.playing = false;
      s.emit("onplaypause", { isPaused: true });
      await new Promise((r) => setTimeout(r, 300));
    },
  });
  const finalVolume = report(sim, startVolume);
  check(sim.volumeWrites.length > 3, "the pause landed while a fade was actually running");
  check(
    Math.abs(finalVolume - startVolume) < 0.005,
    `volume restored after a pause (${Math.round(finalVolume * 100)}%)`,
  );
}

// ── Case 5: Smart DJ switched off mid-transition ────────────────────────────
async function caseDisable() {
  const { sim, startVolume } = await session({
    name: "CASE 5 — Smart DJ switched off during the transition",
    playlist: HOUSE_PAIR,
    crossfadeWritable: false,
    interrupt: async (s, api) => {
      await waitForFade(s);
      s.record("USER_DISABLED_SMART_DJ");
      api.settings.update({ enabled: false });
      await new Promise((r) => setTimeout(r, 300));
    },
  });
  const finalVolume = report(sim, startVolume);
  check(sim.volumeWrites.length > 3, "the disable landed while a fade was actually running");
  check(
    Math.abs(finalVolume - startVolume) < 0.005,
    `volume restored after disabling (${Math.round(finalVolume * 100)}%)`,
  );
}

// ── Case 6: a pair the engine should refuse to blend ────────────────────────
async function caseMismatch() {
  const { sim, startVolume } = await session({
    name: "CASE 6 — incompatible pair (72 BPM → 145 BPM, C → F#m)",
    playlist: MISMATCH_PAIR,
    crossfadeWritable: false,
  });
  const finalVolume = report(sim, startVolume);
  check(
    Math.abs(finalVolume - startVolume) < 0.005,
    `volume restored (${Math.round(finalVolume * 100)}%)`,
  );
}

// ── Case 7: starting volume is not 100% ─────────────────────────────────────
async function caseLowVolume() {
  const { sim, startVolume } = await session({
    name: "CASE 7 — starting volume 35%",
    playlist: HOUSE_PAIR,
    crossfadeWritable: false,
    startVolume: 0.35,
  });
  const finalVolume = report(sim, startVolume);
  check(
    Math.abs(finalVolume - startVolume) < 0.005,
    `restored to 35%, not to 100% (ended at ${Math.round(finalVolume * 100)}%)`,
  );
  check(
    Math.max(...sim.volumeWrites, 0) <= startVolume + 0.005,
    "never pushed the volume above where the user had it",
  );
}

// ── Run ─────────────────────────────────────────────────────────────────────
console.log("Smart DJ — real playback test");
console.log("(a Spotify simulator that emits songchange for our own next(), as the real client does)");

await caseFadePath();
await caseCrossfade();
await caseUserSkip();
await casePause();
await caseDisable();
await caseMismatch();
await caseLowVolume();

console.log("");
if (failures.length === 0) {
  console.log("All playback checks passed.");
  process.exit(0);
}
console.log(`${failures.length} playback check(s) FAILED:`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(1);
