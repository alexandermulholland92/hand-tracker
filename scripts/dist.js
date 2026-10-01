/**
 * dist.js — builds the desktop app with electron-builder, stamping the build time
 * into the packaged package.json (the app shows it in its header).
 *   node scripts/dist.js portable | nsis   Windows (.exe)
 *   node scripts/dist.js deb               Linux (.deb) for this computer's processor, built on Linux
 *   node scripts/dist.js deb --arm64       Linux (.deb) for 64-bit ARM: Raspberry Pi 4 and 5 (64-bit
 *                                          Raspberry Pi OS) and other ARM boards; built on Linux
 * The .deb's install and removal scripts are electron-builder's own plus build/linux/*-oak.sh
 * (the USB rule OAK cameras need).
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
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

// A script given to electron-builder replaces its own (which links the app into /usr/bin and
// sets up Chromium's sandbox), so ours are its own with the OAK camera part added. (In them,
// "$" + "{Name}" is one of electron-builder's template values: the OAK parts don't use that.)
function linuxScripts() {
  const templates = path.join(path.dirname(require.resolve("app-builder-lib/package.json")), "templates", "linux");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hand-tracker-deb-"));
  const out = [];
  for (const [name, option] of [["after-install", "afterInstall"], ["after-remove", "afterRemove"]]) {
    const own = fs.readFileSync(path.join(templates, `${name}.tpl`), "utf8");
    const oak = fs.readFileSync(path.join(__dirname, "..", "build", "linux", `${name}-oak.sh`), "utf8");
    const file = path.join(dir, `${name}.tpl`);
    fs.writeFileSync(file, `${own.trimEnd()}\n\n${oak}`.replace(/\r\n/g, "\n"));
    out.push(`-c.deb.${option}="${file}"`);
  }
  return out;
}

let status = 1;
try {
  const args = ["electron-builder", PLATFORM[target], target, ...(arm64 ? ["--arm64"] : []), `-c.extraMetadata.buildTime=${new Date().toISOString()}`];
  if (target === "deb") args.push(...linuxScripts());
  const result = spawnSync("npx", args, { stdio: "inherit", shell: true });
  status = result.status === null ? 1 : result.status;
} finally {
  if (swapFfmpeg) {
    fs.rmSync(ffmpeg, { force: true });
    fs.renameSync(ffmpeg + ".host", ffmpeg);
  }
}
process.exit(status);
