import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const src = new URL("../dist/smart-dj.js", import.meta.url).pathname;
if (!existsSync(src)) {
  console.error("dist/smart-dj.js not found — run `npm run build` first.");
  process.exit(1);
}

const dir =
  platform() === "win32"
    ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "spicetify", "Extensions")
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "spicetify", "Extensions");

mkdirSync(dir, { recursive: true });
copyFileSync(src, join(dir, "smart-dj.js"));
console.log(`Copied to ${join(dir, "smart-dj.js")}`);

try {
  execSync("spicetify config extensions smart-dj.js", { stdio: "inherit" });
  execSync("spicetify apply", { stdio: "inherit" });
} catch {
  console.log("\nCould not run spicetify automatically. Run these manually:");
  console.log("  spicetify config extensions smart-dj.js");
  console.log("  spicetify apply");
}
