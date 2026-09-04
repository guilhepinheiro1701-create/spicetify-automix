/**
 * Run a TypeScript driver against the real engine sources.
 *
 * Some checks are about the *decision* the engine makes rather than about what
 * the player does with it, and those are better asked of the engine directly
 * than inferred from a playback trace. The driver is bundled with esbuild and
 * executed, so it exercises the same code the extension ships — not a
 * reimplementation of it.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * @param {string} source TypeScript importing engine modules by relative path
 *   from a directory one level below the repo root.
 * @param {{stdio?: "inherit"|"pipe"}} [options]
 * @returns {string} the driver's stdout when piped, otherwise an empty string
 */
export function runEngineDriver(source, options = {}) {
  const stdio = options.stdio ?? "pipe";
  // The driver imports by relative path, so it has to live inside the repo.
  const dir = join(root, ".engine-driver");
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "driver.ts");
  const out = join(dir, "driver.mjs");
  writeFileSync(entry, source);

  try {
    execFileSync(
      "npx",
      ["esbuild", entry, "--bundle", "--platform=node", "--format=esm", `--outfile=${out}`, "--log-level=error"],
      { cwd: root, stdio: "inherit" },
    );
    const result = execFileSync("node", [out], { stdio: stdio === "inherit" ? "inherit" : "pipe" });
    return stdio === "inherit" ? "" : result.toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Source shared by drivers: build a shaped analysis for a track. */
export const ANALYSIS_HELPER = `
import { buildPhraseGrid } from "../src/analysis/structure.js";
import { classifySections } from "../src/analysis/sections.js";

export function shaped(uri: string, bpm: number, key: number, mode: number, durationSec: number, introSec: number, outroSec: number, energy: number, loudness = -7) {
  const spb = 60 / bpm;
  const bodyEnd = durationSec - outroSec;
  const sections: any[] = [];
  const energies: number[] = [];
  const push = (start: number, duration: number, e: number) => {
    if (duration <= 0.5) return;
    sections.push({ start, duration, confidence: 0.85, loudness, tempo: bpm, key, mode, timeSignature: 4 });
    energies.push(e);
  };
  if (introSec > 0) push(0, introSec, energy * 0.35);
  const bodyLen = bodyEnd - introSec;
  for (let i = 0; i < 3; i++) push(introSec + (i * bodyLen) / 3, bodyLen / 3, energy);
  if (outroSec > 0) push(bodyEnd, outroSec, energy * 0.35);

  const a: any = {
    uri, source: "spotify-internal", confidence: 0.9, fetchedAt: Date.now(),
    durationMs: durationSec * 1000, tempo: bpm, tempoConfidence: 0.9, timeSignature: 4,
    key, mode, keyConfidence: 0.85, loudness, energy,
    endOfFadeIn: 0, startOfFadeOut: bodyEnd,
    beats: Array.from({ length: Math.floor(durationSec / spb) }, (_, i) => ({ start: i * spb, duration: spb, confidence: 0.9 })),
    bars: Array.from({ length: Math.floor(durationSec / (spb * 4)) }, (_, i) => ({ start: i * spb * 4, duration: spb * 4, confidence: 0.85 })),
    sections, sectionEnergy: energies, segments: [],
  };
  a.grid = buildPhraseGrid(a);
  a.structure = classifySections(a);
  return a;
}

export function trackRef(uri: string, name: string, durationSec: number) {
  return { uri, id: uri.split(":")[2], name, artists: ["X"], albumUri: "spotify:album:" + name, durationMs: durationSec * 1000, isLocal: false, provider: "context" };
}

export function caps(tier: "dj" | "fade") {
  return {
    probedAt: Date.now(), productTier: tier === "dj" ? "premium" : "free",
    spicetifyVersion: null, spotifyVersion: null, platform: null,
    capabilities: {}, tier,
    flags: {
      audioAnalysis: true, audioFeatures: true, crossfade: tier === "dj",
      volumeControl: true, queueRead: true, queueWrite: false,
      preciseTiming: true, playbackRate: false, dsp: false, perTrackGain: false,
    },
  };
}
`;
