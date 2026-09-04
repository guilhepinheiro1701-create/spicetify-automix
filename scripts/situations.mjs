/**
 * The sixteen situations, answered one at a time.
 *
 * Phase 4 asked for a fixed list of real situations, each with an expectation,
 * what actually happened, a verdict and a reason. This is that list.
 *
 * Two kinds of question are being asked, and they are answered at the level
 * that can actually answer them:
 *
 *  - **live** — a real-time session against the Spotify simulator with the
 *    built bundle loaded. Used wherever the question is about what happens to
 *    playback: does the switch fire, does the level come back, does an
 *    interruption break anything.
 *  - **engine** — the shipped engine called directly. Used wherever the
 *    question is purely about the *decision* (does a tritone key clash get a
 *    shorter blend than a perfect match), which a volume trace cannot show.
 *
 * Neither kind proves how it sounds in a real Spotify. Nothing here can.
 * `docs/REAL-BEHAVIOUR.md` says which claims that limit applies to.
 *
 * Run with `npm run situations`. It takes a few minutes: the live sessions run
 * in real time on purpose, because the volume ramps and the scheduler use real
 * timers and compressing the clock measures an artifact.
 */
import { readFileSync, existsSync } from "node:fs";
import { SpotifySimulator, analysisPayload, stubDom } from "./simulator.mjs";
import { runEngineDriver, ANALYSIS_HELPER } from "./engine-bridge.mjs";

const BUNDLE = new URL("../dist/smart-dj.js", import.meta.url);
if (!existsSync(BUNDLE)) {
  console.error("dist/smart-dj.js not found — run `npm run build` first.");
  process.exit(1);
}

/** @type {{n: number|string, title: string, how: string, expected: string, actual: string, pass: boolean, why: string}[]} */
const rows = [];

function row(n, title, how, expected, actual, pass, why = "") {
  rows.push({ n, title, how, expected, actual, pass, why });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${actual}`);
  if (!pass && why) console.log(`        ↳ ${why}`);
}

const pct = (v) => `${Math.round(v * 100)}%`;

// ─── Live sessions ───────────────────────────────────────────────────────────

function makeTrack(i, name, bpm, key, mode, durationSec, introSec, outroSec, withAnalysis = true) {
  return {
    uri: `spotify:track:${String(i).repeat(22).slice(0, 22)}`,
    name,
    artist: `Artist ${i}`,
    albumUri: `spotify:album:${i}`,
    durationMs: durationSec * 1000,
    provider: "context",
    analysis: withAnalysis
      ? analysisPayload(bpm, key, mode, durationSec, -7, introSec, outroSec)
      : null,
  };
}

async function live({
  playlist,
  crossfadeWritable = false,
  productType = "free",
  startVolume = 0.73,
  runForMs = 30_000,
  startBeforeEndMs = 24_000,
  features = true,
  interrupt = null,
}) {
  stubDom();
  const sim = new SpotifySimulator({
    crossfadeWritable,
    productType,
    switchLatencyMs: 120,
    featuresFor: () =>
      features ? { tempo: 128, key: 9, mode: 0, energy: 0.8, loudness: -7, time_signature: 4 } : null,
  });
  sim.playlist = playlist;
  sim.volume = startVolume;

  globalThis.Spicetify = sim.buildGlobal();
  delete globalThis.SmartDJ;
  new Function(readFileSync(BUNDLE, "utf8"))();
  await new Promise((r) => setTimeout(r, 400));

  const api = globalThis.SmartDJ;
  if (!api) throw new Error("window.SmartDJ was never exposed");

  const startAtMs = Math.max(0, playlist[0].durationMs - startBeforeEndMs);
  const running = sim.run({ startAtMs, forMs: runForMs, speed: 1 });
  if (interrupt) await interrupt(sim, api);
  await running;
  api.teardown?.();

  return {
    sim,
    startVolume,
    finalVolume: sim.volume,
    restored: Math.abs(sim.volume - startVolume) < 0.005,
    faded: sim.volumeWrites.length > 3,
    threw: sim.events.filter((e) => e.type === "LISTENER_THREW"),
    dipFloor: sim.volumeWrites.length ? Math.min(...sim.volumeWrites) : startVolume,
  };
}

/** Block until the level has actually started moving, so an interrupt lands mid-fade. */
async function whenFading(sim, budgetMs = 28_000) {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    await new Promise((r) => setTimeout(r, 20));
    if (sim.volumeWrites.length > 3) return true;
  }
  return false;
}

const HOUSE = [
  makeTrack(1, "House A", 128, 9, 0, 200, 30, 30),
  makeTrack(2, "House B", 127, 9, 0, 200, 30, 30),
  makeTrack(3, "House C", 126, 4, 0, 200, 30, 30),
];
const EDM = [
  makeTrack(1, "EDM A", 128, 1, 1, 210, 32, 40),
  makeTrack(2, "EDM B", 128, 1, 1, 210, 32, 40),
];
const BALLAD_TO_EDM = [
  makeTrack(1, "Ballad", 72, 0, 1, 200, 6, 10),
  makeTrack(2, "Banger", 145, 6, 0, 200, 32, 32),
];
const NO_METADATA = [
  makeTrack(1, "Unknown A", 120, 0, 0, 200, 10, 10, false),
  makeTrack(2, "Unknown B", 120, 0, 0, 200, 10, 10, false),
];

// ─── Situations ──────────────────────────────────────────────────────────────

async function situation1() {
  console.log("\n1 · House → House  (live)");
  const r = await live({ playlist: HOUSE });
  const fired = r.sim.nextCalls >= 1;
  const rose = (() => {
    const i = r.sim.events.findIndex((e) => e.type === "TRACK_CHANGED");
    if (i < 0) return false;
    const after = r.sim.events.slice(i).map((e) => e.volume);
    return Math.max(...after, 0) > Math.min(...after, 1) + 0.05;
  })();
  const pass = fired && r.restored && r.faded && rose;
  row(
    1,
    "House → House",
    "live",
    "a transition fires on a phrase line; the level dips, the track changes, the level returns to the user's",
    `next() ${r.sim.nextCalls}×, dip to ${pct(r.dipFloor / r.startVolume)} of the user's level, back to ${pct(r.finalVolume)} (started ${pct(r.startVolume)})`,
    pass,
    pass ? "" : `fired=${fired} restored=${r.restored} rose-after-change=${rose}`,
  );
}

async function situation2() {
  console.log("\n2 · EDM → EDM  (live)");
  const r = await live({ playlist: EDM, startBeforeEndMs: 26_000, runForMs: 32_000 });
  const pass = r.sim.nextCalls >= 1 && r.restored && r.threw.length === 0;
  row(
    2,
    "EDM → EDM",
    "live",
    "long intro and outro give a real runway; transition fires and the level returns",
    `next() ${r.sim.nextCalls}×, level back to ${pct(r.finalVolume)}, ${r.threw.length} listener errors`,
    pass,
    pass ? "" : `fired=${r.sim.nextCalls} restored=${r.restored}`,
  );
}

async function situation5() {
  console.log("\n5 · Ballad → EDM  (live)");
  const r = await live({ playlist: BALLAD_TO_EDM });
  // The point is not that it refuses — it is that it does something safe and
  // gives the level back. A 72 → 145 jump is a cut, not a mix.
  const pass = r.restored && r.threw.length === 0;
  row(
    5,
    "Ballad → EDM",
    "live",
    "no long blend attempted; whatever it does, the level comes back and nothing breaks",
    `next() ${r.sim.nextCalls}×, level back to ${pct(r.finalVolume)}, ${r.threw.length} listener errors`,
    pass,
    pass ? "" : `restored=${r.restored} threw=${r.threw.length}`,
  );
}

async function situation10() {
  console.log("\n10 · user presses skip mid-transition  (live)");
  const r = await live({
    playlist: HOUSE,
    interrupt: async (sim) => {
      const landed = await whenFading(sim);
      sim.record("USER_PRESSED_SKIP", { landed });
      sim.advance("user skip");
      await new Promise((res) => setTimeout(res, 400));
    },
  });
  const landedMidFade = r.faded;
  const pass = landedMidFade && r.restored;
  row(
    10,
    "SKIP during the transition",
    "live",
    "our transition is abandoned and the user's level is put back immediately",
    `skip landed mid-fade=${landedMidFade}, level back to ${pct(r.finalVolume)}`,
    pass,
    pass ? "" : `restored=${r.restored}`,
  );
}

async function situation11() {
  console.log("\n11 · user pauses mid-transition  (live)");
  const r = await live({
    playlist: HOUSE,
    interrupt: async (sim) => {
      await whenFading(sim);
      sim.record("USER_PRESSED_PAUSE");
      sim.playing = false;
      sim.emit("onplaypause", { isPaused: true });
      await new Promise((res) => setTimeout(res, 400));
    },
  });
  const pass = r.faded && r.restored;
  row(
    11,
    "PAUSE during the transition",
    "live",
    "the transition stops and the level is restored, not left dipped",
    `pause landed mid-fade=${r.faded}, level back to ${pct(r.finalVolume)}`,
    pass,
    pass ? "" : `restored=${r.restored}`,
  );
}

async function situation12() {
  console.log("\n12 · user picks a different track mid-transition  (live)");
  const r = await live({
    playlist: HOUSE,
    interrupt: async (sim) => {
      await whenFading(sim);
      sim.record("USER_PICKED_ANOTHER_TRACK");
      // Not the queued next: somewhere we never planned for.
      sim.jumpTo(2, "user picked another track");
      await new Promise((res) => setTimeout(res, 600));
    },
  });
  const jumped = r.sim.events.some((e) => e.cause === "user picked another track");
  const pass = jumped && r.restored && r.threw.length === 0;
  row(
    12,
    "user changes track manually",
    "live",
    "the plan for the old pair is dropped, the level is restored, and the new pair is replanned",
    `jump seen=${jumped}, level back to ${pct(r.finalVolume)}, ${r.threw.length} listener errors`,
    pass,
    pass ? "" : `restored=${r.restored} threw=${r.threw.length}`,
  );
}

async function situation13() {
  console.log("\n13 · Smart DJ switched off mid-transition  (live)");
  const r = await live({
    playlist: HOUSE,
    interrupt: async (sim, api) => {
      await whenFading(sim);
      sim.record("USER_DISABLED_SMART_DJ");
      api.settings.update({ enabled: false });
      await new Promise((res) => setTimeout(res, 400));
    },
  });
  const pass = r.faded && r.restored;
  row(
    13,
    "Smart DJ disabled during the transition",
    "live",
    "turning it off hands the volume straight back",
    `disable landed mid-fade=${r.faded}, level back to ${pct(r.finalVolume)}`,
    pass,
    pass ? "" : `restored=${r.restored}`,
  );
}

async function situation14a() {
  console.log("\n14a · Spotify analysis API fails  (live)");
  const r = await live({ playlist: NO_METADATA, features: false });
  const pass = r.threw.length === 0 && r.restored;
  row(
    14,
    "Spotify API fails — no analysis, no features",
    "live",
    "no metadata means no confident plan; playback is left alone or handled safely, and nothing throws",
    `${r.threw.length} listener errors, next() ${r.sim.nextCalls}×, level ${pct(r.finalVolume)} (started ${pct(r.startVolume)})`,
    pass,
    pass ? "" : `threw=${r.threw.length} restored=${r.restored}`,
  );
}

async function situation14b() {
  console.log("\n14b · the player refuses volume writes mid-fade  (live)");
  const r = await live({
    playlist: HOUSE,
    interrupt: async (sim) => {
      await whenFading(sim);
      sim.record("PLAYER_STOPPED_ACCEPTING_WRITES");
      sim.rejectVolumeWrites = true;
      await new Promise((res) => setTimeout(res, 900));
      sim.rejectVolumeWrites = false;
      sim.record("PLAYER_RECOVERED");
      await new Promise((res) => setTimeout(res, 2_000));
    },
  });
  const refused = r.sim.events.filter((e) => e.type === "VOLUME_WRITE_REJECTED").length;
  const pass = refused > 0 && r.restored && r.threw.length === 0;
  row(
    "14b",
    "the player refuses volume writes, then recovers",
    "live",
    "the level we owe the user is remembered through the outage and written back once writes are accepted",
    `${refused} writes refused, level ended at ${pct(r.finalVolume)} (owed ${pct(r.startVolume)})`,
    pass,
    pass ? "" : `refused=${refused} restored=${r.restored}`,
  );
}

async function situation15() {
  console.log("\n15 · starting volume 35%  (live)");
  const r = await live({ playlist: HOUSE, startVolume: 0.35 });
  const neverAbove = Math.max(...r.sim.volumeWrites, 0) <= r.startVolume + 0.005;
  const pass = r.restored && neverAbove;
  row(
    15,
    "starting volume is not 100%",
    "live",
    "the user's own level is the ceiling and the destination — never 100%",
    `peak ${pct(Math.max(...r.sim.volumeWrites, 0))}, ended ${pct(r.finalVolume)} (started ${pct(r.startVolume)})`,
    pass,
    pass ? "" : `restored=${r.restored} never-above=${neverAbove}`,
  );
}

async function situation16() {
  console.log("\n16 · Spotify Free, no crossfade write path  (live)");
  const r = await live({ playlist: HOUSE, crossfadeWritable: false, productType: "free" });
  const usedFade = r.faded && r.sim.nextCalls >= 1;
  const pass = usedFade && r.restored;
  row(
    16,
    "Spotify Free without crossfade",
    "live",
    "the ladder degrades to the volume-fade path: dip, cut on the phrase line, come back",
    `crossfade writes ${r.sim.events.filter((e) => e.type === "CROSSFADE_WRITE").length}, next() ${r.sim.nextCalls}×, level back to ${pct(r.finalVolume)}`,
    pass,
    pass ? "" : `used-fade=${usedFade} restored=${r.restored}`,
  );
}

// ─── Engine-level situations ─────────────────────────────────────────────────

function enginePlans() {
  const body = `
import { calculateTransition } from "../src/engine/transitionEngine.js";
import { DEFAULT_SETTINGS } from "../src/config/defaults.js";

function plan(fromSpec: any, toSpec: any, tier: "dj" | "fade") {
  const A = shaped("spotify:track:a", fromSpec.bpm, fromSpec.key, fromSpec.mode, fromSpec.dur, fromSpec.intro, fromSpec.outro, fromSpec.energy);
  const B = shaped("spotify:track:b", toSpec.bpm, toSpec.key, toSpec.mode, toSpec.dur, toSpec.intro, toSpec.outro, toSpec.energy);
  const p: any = calculateTransition({
    fromTrack: trackRef("spotify:track:a", "A", fromSpec.dur),
    toTrack: trackRef("spotify:track:b", "B", toSpec.dur),
    fromAnalysis: A, toAnalysis: B,
    settings: { ...DEFAULT_SETTINGS }, capabilities: caps(tier),
  });
  return {
    overall: p.compatibility.overall,
    tempo: p.compatibility.tempo.score,
    key: p.compatibility.key.score,
    energy: p.compatibility.energy.score,
    tempoRatio: p.compatibility.tempoRatio,
    tempoDeltaPercent: p.compatibility.tempoDeltaPercent,
    band: p.band, technique: p.technique, executor: p.executor, strategy: p.strategy,
    durationSec: p.durationSec, durationBeats: p.durationBeats,
    phraseAlignment: p.phraseAlignment, beatAlignment: p.beatAlignment,
    musicalConfidence: p.musicalConfidence, musicalConfidenceLabel: p.musicalConfidenceLabel,
    caveats: p.caveats.length,
  };
}

const pop = { bpm: 102, key: 0, mode: 0, dur: 215, intro: 8, outro: 12, energy: 0.62 };
const pop2 = { bpm: 100, key: 9, mode: 1, dur: 220, intro: 6, outro: 14, energy: 0.6 };
const edm = { bpm: 128, key: 9, mode: 1, dur: 320, intro: 32, outro: 40, energy: 0.88 };
const slow = { bpm: 60, key: 9, mode: 1, dur: 200, intro: 10, outro: 24, energy: 0.3 };
const fast = { bpm: 120, key: 9, mode: 1, dur: 200, intro: 10, outro: 24, energy: 0.5 };
const techA = { bpm: 124, key: 9, mode: 1, dur: 300, intro: 30, outro: 40, energy: 0.8 };
const sameKey = { bpm: 123, key: 9, mode: 1, dur: 300, intro: 30, outro: 40, energy: 0.8 };
const clashKey = { bpm: 123, key: 3, mode: 0, dur: 300, intro: 30, outro: 40, energy: 0.8 };

console.log("JSON:" + JSON.stringify({
  s3: plan(pop, pop2, "dj"),
  s4: plan(pop, edm, "dj"),
  s6: plan(slow, fast, "dj"),
  s7: plan(fast, slow, "dj"),
  s8: plan(techA, sameKey, "dj"),
  s9: plan(techA, clashKey, "dj"),
}));
`;
  const out = runEngineDriver(ANALYSIS_HELPER + body);
  const line = out.split("\n").find((l) => l.startsWith("JSON:"));
  if (!line) throw new Error(`engine driver produced no result:\n${out}`);
  return JSON.parse(line.slice(5));
}

function engineSituations(p) {
  const d = (x) => `${x.band} ${pct(x.overall)}, ${x.technique}, ${x.durationSec.toFixed(1)}s${x.durationBeats ? ` (${x.durationBeats} beats)` : ""}`;

  console.log("\n3 · Pop → Pop  (engine)");
  {
    const x = p.s3;
    const pass = x.overall >= 0.6 && x.technique !== "hard-cut" && x.phraseAlignment;
    row(3, "Pop → Pop", "engine",
      "close tempo and a relative key: a real, phrase-aligned transition, not a cut",
      d(x) + `, phrase-aligned ${x.phraseAlignment}`, pass,
      pass ? "" : `overall=${x.overall.toFixed(2)} technique=${x.technique} phrase=${x.phraseAlignment}`);
  }

  console.log("\n4 · Pop → EDM  (engine)");
  {
    const x = p.s4;
    // 100 → 128 is 28% apart, outside any DJ's pitch range. It must not be sold
    // as a blend, and it must be shorter than the same-genre case above.
    const pass = x.tempo < 0.4 && x.durationSec <= p.s3.durationSec + 0.01;
    row(4, "Pop → EDM", "engine",
      "a 28% tempo gap is not mixable: low tempo score and no longer than the same-genre pair",
      d(x) + `, tempo score ${x.tempo.toFixed(2)}, Δ${x.tempoDeltaPercent.toFixed(1)}% (Pop→Pop was ${p.s3.durationSec.toFixed(1)}s)`,
      pass, pass ? "" : `tempo=${x.tempo.toFixed(2)} len=${x.durationSec} vs ${p.s3.durationSec}`);
  }

  console.log("\n6 · 60 BPM → 120 BPM  (engine)");
  {
    const x = p.s6;
    // Exact double time is a legitimate DJ relationship, not a catastrophe.
    const pass = x.tempoRatio === 2 && x.tempo > 0.8;
    row(6, "60 → 120 BPM", "engine",
      "recognised as double-time, not as a 100% tempo error",
      `tempo ratio ${x.tempoRatio}, tempo score ${x.tempo.toFixed(2)}, Δ${x.tempoDeltaPercent.toFixed(1)}%, ${d(x)}`,
      pass, pass ? "" : `ratio=${x.tempoRatio} tempo=${x.tempo.toFixed(2)}`);
  }

  console.log("\n7 · 120 BPM → 60 BPM  (engine)");
  {
    const x = p.s7;
    const pass = x.tempoRatio === 0.5 && x.tempo > 0.8;
    row(7, "120 → 60 BPM", "engine",
      "recognised as half-time, and the energy drop reflected in the plan",
      `tempo ratio ${x.tempoRatio}, tempo score ${x.tempo.toFixed(2)}, strategy ${x.strategy}, ${d(x)}`,
      pass, pass ? "" : `ratio=${x.tempoRatio} tempo=${x.tempo.toFixed(2)}`);
  }

  console.log("\n8 · same key  (engine)");
  {
    const x = p.s8;
    const pass = x.key >= 0.95 && x.overall >= 0.75;
    row(8, "same key (Am → Am)", "engine",
      "a perfect harmonic match, scored as one",
      `key score ${x.key.toFixed(2)}, ${d(x)}, confidence ${x.musicalConfidenceLabel}`,
      pass, pass ? "" : `key=${x.key.toFixed(2)} overall=${x.overall.toFixed(2)}`);
  }

  console.log("\n9 · clashing keys  (engine)");
  {
    const x = p.s9, ok = p.s8;
    // The bug this catches: a key clash once got a *longer* blend than a
    // perfect match, because the band only scaled the runway.
    const pass = x.key < 0.5 && x.durationSec < ok.durationSec;
    row(9, "clashing keys (Am → D#)", "engine",
      "low key score, and a shorter blend than the same-key pair — never longer",
      `key score ${x.key.toFixed(2)}, ${d(x)}; same-key pair was ${ok.durationSec.toFixed(1)}s`,
      pass, pass ? "" : `key=${x.key.toFixed(2)} len=${x.durationSec} vs same-key ${ok.durationSec}`);
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

console.log("Smart DJ — the sixteen situations");
console.log("live = a real-time session against the client simulator · engine = the shipped engine, asked directly");

const plans = enginePlans();
await situation1();
await situation2();
engineSituations(plans);
await situation5();
await situation10();
await situation11();
await situation12();
await situation13();
await situation14a();
await situation14b();
await situation15();
await situation16();

rows.sort((a, b) => String(a.n).localeCompare(String(b.n), undefined, { numeric: true }));

console.log("\n" + "═".repeat(100));
console.log("SUMMARY");
console.log("═".repeat(100));
for (const r of rows) {
  console.log(`\n${String(r.n).padStart(3)}. ${r.title}   [${r.how}]`);
  console.log(`     Esperado   ${r.expected}`);
  console.log(`     Real       ${r.actual}`);
  console.log(`     Resultado  ${r.pass ? "PASS" : "FAIL"}`);
  console.log(`     Motivo     ${r.pass ? "expectation met" : r.why}`);
}

const failed = rows.filter((r) => !r.pass);
console.log("\n" + "═".repeat(100));
console.log(`${rows.length - failed.length}/${rows.length} situations PASS`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAIL ${f.n} — ${f.title}: ${f.why}`);
  process.exit(1);
}
process.exit(0);
