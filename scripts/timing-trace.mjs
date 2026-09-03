/**
 * Musical timing trace.
 *
 * Shows, for a given tempo, exactly where the engine decides to switch and how
 * that lands against the beat grid: which beat, which phrase, how much of the
 * track is left, and where the incoming track's first downbeat ends up.
 *
 * This is the "show your working" view asked for in the Phase 4 brief. It uses
 * the real engine, not a reimplementation.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The engine is TypeScript; compile a tiny driver through esbuild and run it.
const driver = `
import { calculateTransition } from "../src/engine/transitionEngine.js";
import { buildPhraseGrid, gridPhaseOffsetSec } from "../src/analysis/structure.js";
import { classifySections } from "../src/analysis/sections.js";
import { DEFAULT_SETTINGS } from "../src/config/defaults.js";

function analysisFor(uri, bpm, key, mode, durationSec, introSec, outroSec, energy) {
  const spb = 60 / bpm;
  const bodyEnd = durationSec - outroSec;
  const sections = [];
  const energies = [];
  const push = (start, duration, e) => {
    if (duration <= 0.5) return;
    sections.push({ start, duration, confidence: 0.85, loudness: -7, tempo: bpm, key, mode, timeSignature: 4 });
    energies.push(e);
  };
  if (introSec > 0) push(0, introSec, energy * 0.35);
  const bodyLen = bodyEnd - introSec;
  for (let i = 0; i < 3; i++) push(introSec + (i * bodyLen) / 3, bodyLen / 3, energy);
  if (outroSec > 0) push(bodyEnd, outroSec, energy * 0.35);

  const a = {
    uri, source: "spotify-internal", confidence: 0.9, fetchedAt: Date.now(),
    durationMs: durationSec * 1000, tempo: bpm, tempoConfidence: 0.9, timeSignature: 4,
    key, mode, keyConfidence: 0.85, loudness: -7, energy,
    endOfFadeIn: 0, startOfFadeOut: bodyEnd,
    beats: Array.from({ length: Math.floor(durationSec / spb) }, (_, i) => ({ start: i * spb, duration: spb, confidence: 0.9 })),
    bars: Array.from({ length: Math.floor(durationSec / (spb * 4)) }, (_, i) => ({ start: i * spb * 4, duration: spb * 4, confidence: 0.85 })),
    sections, sectionEnergy: energies, segments: [],
  };
  a.grid = buildPhraseGrid(a);
  a.structure = classifySections(a);
  return a;
}

const capabilities = (tier) => ({
  probedAt: Date.now(), productTier: tier === "dj" ? "premium" : "free",
  spicetifyVersion: null, spotifyVersion: null, platform: null,
  capabilities: {}, tier,
  flags: {
    audioAnalysis: true, audioFeatures: true, crossfade: tier === "dj",
    volumeControl: true, queueRead: true, queueWrite: false,
    preciseTiming: true, playbackRate: false, dsp: false, perTrackGain: false,
  },
});

const track = (uri, name) => ({
  uri, id: uri.split(":")[2], name, artists: ["X"],
  albumUri: "spotify:album:" + name, durationMs: 0, isLocal: false, provider: "context",
});

function trace(label, bpmA, bpmB, keyA, keyB, tier) {
  const durA = 210, durB = 210;
  const A = analysisFor("spotify:track:a", bpmA, keyA, 0, durA, 30, 30, 0.8);
  const B = analysisFor("spotify:track:b", bpmB, keyB, 0, durB, 30, 30, 0.82);
  const ta = track("spotify:track:a", "A"); ta.durationMs = durA * 1000;
  const tb = track("spotify:track:b", "B"); tb.durationMs = durB * 1000;

  const plan = calculateTransition({
    fromTrack: ta, toTrack: tb, fromAnalysis: A, toAnalysis: B,
    settings: { ...DEFAULT_SETTINGS }, capabilities: capabilities(tier),
  });

  const spb = 60 / bpmA;
  const grid = A.grid;
  const phraseSec = grid.secPerBeat * grid.beatsPerBar * grid.barsPerPhrase;
  const switchAt = plan.startPointSec;
  const beatIndex = switchAt / spb;
  const phraseIndex = (switchAt - grid.originSec) / phraseSec;
  const offsetInPhrase = ((switchAt - grid.originSec) % phraseSec) / spb;
  const phaseB = gridPhaseOffsetSec(B.grid);

  console.log("");
  console.log("═".repeat(72));
  console.log(label);
  console.log("═".repeat(72));
  console.log("Track A: " + bpmA + " BPM, 4/4, " + durA + "s  (intro 30s, outro 30s)");
  console.log("Track B: " + bpmB + " BPM, 4/4, " + durB + "s");
  console.log("Grid:    1 beat = " + spb.toFixed(4) + "s   1 bar = " + (spb * 4).toFixed(3) + "s   1 phrase (16 beats) = " + phraseSec.toFixed(3) + "s");
  console.log("");
  console.log("  executor            " + plan.executor);
  console.log("  strategy            " + plan.strategy + " / " + plan.technique + " (" + plan.band + " " + Math.round(plan.compatibility.overall * 100) + "%)");
  console.log("");
  console.log("  runway              " + plan.mixableWindowSec.toFixed(1) + "s, limited by the " + plan.windowLimitedBy);
  console.log("  blend length        " + plan.durationSec.toFixed(2) + "s = " + plan.durationBeats + " beats = " + (plan.durationBeats / 4).toFixed(1) + " bars");
  console.log("");
  console.log("  SWITCH lands at     " + switchAt.toFixed(3) + "s");
  console.log("    → beat            " + beatIndex.toFixed(2) + "  (" + (Math.abs(beatIndex - Math.round(beatIndex)) < 0.02 ? "ON the beat" : "OFF the beat by " + (Math.abs(beatIndex - Math.round(beatIndex)) * spb * 1000).toFixed(0) + "ms") + ")");
  console.log("    → phrase          " + Math.floor(phraseIndex) + ", beat " + offsetInPhrase.toFixed(2) + " of 16  (" + (plan.phraseAlignment ? "PHRASE ALIGNED" : "not phrase aligned") + ")");
  console.log("    → time left in A  " + (durA - switchAt).toFixed(2) + "s");
  console.log("");
  if (plan.leadInSec > 0) {
    console.log("  fade-out STARTS at  " + (switchAt - plan.leadInSec).toFixed(3) + "s  (lead-in " + plan.leadInSec.toFixed(2) + "s)");
    console.log("    so that next() is called exactly at " + switchAt.toFixed(3) + "s");
  } else {
    console.log("  no lead-in: Spotify's mixer begins the overlap at the switch itself");
  }
  console.log("");
  console.log("  B's grid phase      " + (phaseB * 1000).toFixed(0) + "ms after its own start");
  console.log("  phase compensation  " + (plan.phaseOffsetSec * 1000).toFixed(0) + "ms fired early");
  console.log("    → B's first downbeat lands at " + (switchAt + phaseB - plan.phaseOffsetSec).toFixed(3) + "s of A's timeline");
  const landsOnBeat = ((switchAt + phaseB - plan.phaseOffsetSec) / spb);
  console.log("    → which is beat " + landsOnBeat.toFixed(2) + " of A  (" + (Math.abs(landsOnBeat - Math.round(landsOnBeat)) < 0.03 ? "COINCIDES with A's downbeat" : "off by " + (Math.abs(landsOnBeat - Math.round(landsOnBeat)) * spb * 1000).toFixed(0) + "ms") + ")");
  console.log("  downbeat claimed    " + plan.beatAlignment);
}

trace("128 BPM → 126 BPM, same key (the canonical case)", 128, 126, 9, 9, "dj");
trace("128 BPM → 126 BPM, same key, FADE PATH (Spotify Free)", 128, 126, 9, 9, "fade");
trace("174 BPM → 172 BPM (drum and bass)", 174, 172, 9, 9, "dj");
trace("90 BPM → 89 BPM (hip-hop)", 90, 89, 9, 9, "dj");
trace("128 BPM → 145 BPM (unmixable tempo gap)", 128, 145, 9, 9, "dj");
trace("120 BPM → 60 BPM (half time)", 120, 60, 9, 9, "dj");
`;

// The driver imports engine modules by relative path, so it has to live inside
// the repo for esbuild to resolve them.
const root = fileURLToPath(new URL("..", import.meta.url));
const dir = join(root, ".trace-tmp");
mkdirSync(dir, { recursive: true });
const entry = join(dir, "trace.ts");
const out = join(dir, "trace.mjs");
writeFileSync(entry, driver);

try {
  execFileSync(
    "npx",
    ["esbuild", entry, "--bundle", "--platform=node", "--format=esm", `--outfile=${out}`, "--log-level=error"],
    { cwd: root, stdio: "inherit" },
  );
  execFileSync("node", [out], { stdio: "inherit" });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
