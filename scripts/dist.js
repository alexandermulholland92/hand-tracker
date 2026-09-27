/**
 * dist.js — builds the desktop app with electron-builder, stamping the build time
 * into the packaged package.json (the app shows it in its header).
 *   node scripts/dist.js portable | nsis   Windows (.exe)
 *   node scripts/dist.js deb               Linux (.deb), built on Linux
 */
const { spawnSync } = require("child_process");

const PLATFORM = { portable: "--win", nsis: "--win", deb: "--linux" };
const target = PLATFORM[process.argv[2]] ? process.argv[2] : "portable";
// npm installs the ffmpeg for the computer it runs on, and the app bundles that one.
if (target === "deb" && process.platform !== "linux") {
  console.error("Build the .deb on Linux (or in WSL): the app bundles the ffmpeg npm installed, which here is for " + process.platform + ".");
  process.exit(1);
}
const result = spawnSync("npx", ["electron-builder", PLATFORM[target], target, `-c.extraMetadata.buildTime=${new Date().toISOString()}`], {
  stdio: "inherit",
  shell: true,
});
process.exit(result.status === null ? 1 : result.status);
