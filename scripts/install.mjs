/**
 * Installer.
 *
 * Copies the built bundle into Spicetify's Extensions folder and registers it.
 * Written for someone who is not a developer, so it explains what it is about
 * to do, refuses to guess, and never edits anything it did not create.
 *
 * What it touches:
 *   - writes ONE file: <spicetify config>/Extensions/smart-dj.js
 *   - runs `spicetify config extensions smart-dj.js` and `spicetify apply`
 *
 * What it will not do: modify your Spotify install directly, change any other
 * extension, or alter your Spicetify configuration beyond adding this one entry.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, "..", "dist", "smart-dj.js");
const EXTENSION_NAME = "smart-dj.js";

const say = (msg = "") => console.log(msg);
const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const fail = (msg) => console.error(`  ✗ ${msg}`);

say("Smart DJ — installer");
say("");

// ── 1. Is there something to install? ───────────────────────────────────────
if (!existsSync(BUNDLE)) {
  fail("dist/smart-dj.js not found.");
  say("");
  say("  Build it first:");
  say("    npm install");
  say("    npm run build");
  process.exit(1);
}
ok(`found the bundle (${(statSync(BUNDLE).size / 1024).toFixed(0)} KB)`);

// ── 2. Is Spicetify installed? ──────────────────────────────────────────────
function spicetifyVersion() {
  try {
    return execFileSync("spicetify", ["-v"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const version = spicetifyVersion();
if (version) {
  ok(`Spicetify ${version}`);
} else {
  warn("could not run `spicetify` — is it installed and on your PATH?");
  say("");
  say("  Install it first: https://spicetify.app/docs/getting-started");
  say("  The file will still be copied, so you can register it by hand afterwards.");
}

// ── 3. Where does it go? ────────────────────────────────────────────────────
/**
 * Ask Spicetify itself where its config lives rather than guessing. The
 * conventional paths are only a fallback, because a user with a custom
 * XDG_CONFIG_HOME or a portable install would otherwise get a file written
 * somewhere Spotify never reads.
 */
function extensionsDir() {
  try {
    const configPath = execFileSync("spicetify", ["path", "userdata"], {
      encoding: "utf8",
    }).trim();
    if (configPath && existsSync(configPath)) {
      return { dir: join(configPath, "Extensions"), source: "spicetify path userdata" };
    }
  } catch {
    /* fall through to the conventional locations */
  }

  const dir =
    platform() === "win32"
      ? join(
          process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
          "spicetify",
          "Extensions",
        )
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "spicetify", "Extensions");
  return { dir, source: "conventional path" };
}

const { dir, source } = extensionsDir();
const target = join(dir, EXTENSION_NAME);

try {
  mkdirSync(dir, { recursive: true });
  copyFileSync(BUNDLE, target);
  ok(`copied to ${target}`);
  if (source !== "spicetify path userdata") {
    warn(`used the ${source} — if Spotify does not pick it up, see docs/INSTALLATION.md`);
  }
} catch (err) {
  fail(`could not write to ${dir}: ${err?.message ?? err}`);
  say("");
  say("  Copy dist/smart-dj.js into that folder by hand, then run:");
  say(`    spicetify config extensions ${EXTENSION_NAME}`);
  say("    spicetify apply");
  process.exit(1);
}

// ── 4. Register and apply ───────────────────────────────────────────────────
if (!version) {
  say("");
  say("  Once Spicetify is installed, finish with:");
  say(`    spicetify config extensions ${EXTENSION_NAME}`);
  say("    spicetify apply");
  process.exit(0);
}

try {
  // `config extensions` appends; running it twice would list it twice, so check.
  let already = false;
  try {
    already = execFileSync("spicetify", ["config", "extensions"], { encoding: "utf8" }).includes(
      EXTENSION_NAME,
    );
  } catch {
    /* older CLIs may not support reading it back; adding again is harmless */
  }

  if (already) {
    ok("already registered with Spicetify");
  } else {
    execSync(`spicetify config extensions ${EXTENSION_NAME}`, { stdio: "inherit" });
    ok("registered with Spicetify");
  }

  say("");
  say("  Applying — Spotify will restart…");
  execSync("spicetify apply", { stdio: "inherit" });

  say("");
  say("Done. Look for the Smart DJ button in the player bar, on the right.");
  say("If it is not there, see docs/TROUBLESHOOTING.md");
} catch (err) {
  say("");
  fail(`Spicetify would not apply the change: ${err?.message ?? err}`);
  say("");
  say("  Try running these yourself, and read the error it prints:");
  say(`    spicetify config extensions ${EXTENSION_NAME}`);
  say("    spicetify apply");
  say("");
  say("  Common cause: Spotify was updated and Spicetify needs `spicetify backup apply`.");
  say("  See docs/TROUBLESHOOTING.md");
  process.exit(1);
}
