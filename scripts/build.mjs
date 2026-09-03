import { build, context } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const watch = process.argv.includes("--watch");
const dev = watch || process.argv.includes("--dev");

/**
 * Spicetify loads extensions as plain classic scripts concatenated into the
 * client bundle. The output therefore has to be a single self-contained IIFE
 * with no module syntax and no external imports.
 */
const options = {
  entryPoints: ["src/index.ts"],
  outfile: "dist/smart-dj.js",
  bundle: true,
  format: "iife",
  target: ["chrome108"],
  platform: "browser",
  minify: !dev,
  sourcemap: false,
  legalComments: "none",
  define: { __SMART_DJ_VERSION__: JSON.stringify(pkg.version) },
  banner: {
    js:
      `// NAME: Smart DJ\n` +
      `// AUTHOR: spicetify-smart-dj\n` +
      `// VERSION: ${pkg.version}\n` +
      `// DESCRIPTION: Musically-aware automatic DJ transitions for Spotify.\n`,
  },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("[smart-dj] watching…");
} else {
  await build(options);
  console.log(`[smart-dj] built dist/smart-dj.js (v${pkg.version})`);
}
