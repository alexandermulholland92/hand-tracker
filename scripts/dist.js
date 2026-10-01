/**
 * dist.js — builds the desktop app with electron-builder, stamping the build time
 * into the packaged package.json (the app shows it in its header).
 *   node scripts/dist.js portable | nsis   Windows (.exe)
 *   node scripts/dist.js deb               Linux (.deb) for this computer's processor, built on Linux
 *   node scripts/dist.js deb --arm64       Linux (.deb) for 64-bit ARM: Raspberry Pi 4 and 5 (64-bit
 *                                          Raspberry Pi OS) and other ARM boards; built on Linux
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PLATFORM = { portable: "--win", nsis: "--win", deb: "--linux" };
const target = PLATFORM[process.argv[2]] ? process.argv[2] : "portable";
const arm64 = process.argv.includes("--arm64");
// npm installs the ffmpeg for the computer it runs on, and the app bundles that one.
if (target === "deb" && process.platform !== "linux") {
  console.error("Build the .deb on Linux (or in WSL): the app bundles the ffmpeg npm installed, which here is for " + process.platform + ".");
  process.exit(1);
}

// For another processor, the app bundles that processor's ffmpeg instead, for this build only.
const ffmpegDir = path.join(__dirname, "..", "node_modules", "ffmpeg-static");
const ffmpeg = path.join(ffmpegDir, "ffmpeg");
const swapFfmpeg = arm64 && process.arch !== "arm64";
if (swapFfmpeg) {
  fs.renameSync(ffmpeg, ffmpeg + ".host");
  const got = spawnSync(process.execPath, [path.join(ffmpegDir, "install.js")], {
    stdio: "inherit",
    env: { ...process.env, npm_config_arch: "arm64", npm_config_platform: "linux" },
  });
  if (got.status !== 0) {
    fs.renameSync(ffmpeg + ".host", ffmpeg);
    console.error("Couldn't download ffmpeg for 64-bit ARM.");
    process.exit(1);
  }
}

let status = 1;
try {
  const args = ["electron-builder", PLATFORM[target], target, ...(arm64 ? ["--arm64"] : []), `-c.extraMetadata.buildTime=${new Date().toISOString()}`];
  const result = spawnSync("npx", args, { stdio: "inherit", shell: true });
  status = result.status === null ? 1 : result.status;
} finally {
  if (swapFfmpeg) {
    fs.rmSync(ffmpeg, { force: true });
    fs.renameSync(ffmpeg + ".host", ffmpeg);
  }
}
process.exit(status);
