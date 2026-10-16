/**
 * dist.js — builds the desktop app with electron-builder, stamping the build time
 * into the packaged package.json (the app shows it in its header).
 *   node scripts/dist.js portable | nsis   Windows (.exe)
 *   node scripts/dist.js deb               Linux (.deb) for this computer's processor, built on Linux
 *   node scripts/dist.js deb --arm64       Linux (.deb) for 64-bit ARM: Raspberry Pi 4 and 5 (64-bit
 *                                          Raspberry Pi OS) and other ARM boards; built on Linux
 *   node scripts/dist.js mac               macOS (.dmg) for this Mac's processor, built on a Mac
 *   node scripts/dist.js mac --x64         macOS (.dmg) for Intel Macs (or --arm64: Apple silicon)
 *   ... --app mouse | remote               Hand Mouse or Remote Recording, the apps of their own built
 *                                          from this one: the same files, their own name, ID, start
 *                                          page (electron/main.js reads appKind) and files' names, so
 *                                          each installs beside Hand Tracker
 * The Mac app is signed ad hoc (no Apple Developer ID), so macOS asks before opening it the first
 * time (see the README); it carries electron/input-helper-mac, built here first.
 * The .deb's install and removal scripts are electron-builder's own plus build/linux/*-*.sh
 * (the USB rule OAK cameras need, and the virtual mouse and keyboard's rule for Wayland desktops).
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PLATFORM = { portable: "--win", nsis: "--win", deb: "--linux", mac: "--mac" };
const TARGET = { portable: "portable", nsis: "nsis", deb: "deb", mac: "dmg" };
const target = PLATFORM[process.argv[2]] ? process.argv[2] : "portable";
const arch = process.argv.includes("--arm64") ? "arm64" : process.argv.includes("--x64") ? "x64" : null;
// The apps of their own (--app): their names, and what they say about themselves.
const APPS = {
  mouse: {
    name: "Hand Mouse", id: "com.handtracker.mouse", slug: "hand-mouse", file: "HandMouse",
    synopsis: "Your hand as a mouse: for this computer, from a phone, or for an iPhone",
    camera: "Hand Mouse follows your hand with the camera.",
    rules: ["uinput"], // (the virtual mouse and keyboard on a Wayland desktop; no OAK cameras)
  },
  remote: {
    name: "Remote Recording", id: "com.handtracker.remote", slug: "remote-recording", file: "RemoteRecording",
    synopsis: "Start and stop recording on camera rigs, or be one",
    camera: "Remote Recording records hand motion with the cameras when a phone or browser starts it.",
    rules: ["oak"], // (OAK cameras; no hand mouse)
  },
};
const appAt = process.argv.indexOf("--app");
const appKind = appAt >= 0 ? process.argv[appAt + 1] : null;
if (appAt >= 0 && !APPS[appKind]) {
  console.error("--app is mouse (Hand Mouse) or remote (Remote Recording).");
  process.exit(1);
}
const own = APPS[appKind] || null;
// npm installs the ffmpeg for the computer it runs on, and the app bundles that one.
if (target === "deb" && process.platform !== "linux") {
  console.error("Build the .deb on Linux (or in WSL): the app bundles the ffmpeg npm installed, which here is for " + process.platform + ".");
  process.exit(1);
}
if (target === "mac") {
  if (process.platform !== "darwin") {
    console.error("Build the Mac app on a Mac (GitHub's macOS runners do: .github/workflows/build-apps.yml).");
    process.exit(1);
  }
  try {
    require("./build-mac-helper.js").buildMacHelper();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

// For another processor, the app bundles that processor's ffmpeg instead, for this build only.
const ffmpegDir = path.join(__dirname, "..", "node_modules", "ffmpeg-static");
const ffmpeg = path.join(ffmpegDir, "ffmpeg");
const swapFfmpeg = target !== "portable" && target !== "nsis" && arch && arch !== process.arch;
if (swapFfmpeg) {
  fs.renameSync(ffmpeg, ffmpeg + ".host");
  const got = spawnSync(process.execPath, [path.join(ffmpegDir, "install.js")], {
    stdio: "inherit",
    env: { ...process.env, npm_config_arch: arch, npm_config_platform: process.platform },
  });
  if (got.status !== 0) {
    fs.renameSync(ffmpeg + ".host", ffmpeg);
    console.error(`Couldn't download ffmpeg for ${arch}.`);
    process.exit(1);
  }
}

// A script given to electron-builder replaces its own (which links the app into /usr/bin and
// sets up Chromium's sandbox), so ours are its own with our parts added. (In them,
// "$" + "{Name}" is one of electron-builder's template values: the OAK parts don't use that.)
function linuxScripts() {
  const templates = path.join(path.dirname(require.resolve("app-builder-lib/package.json")), "templates", "linux");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hand-tracker-deb-"));
  const out = [];
  for (const [name, option] of [["after-install", "afterInstall"], ["after-remove", "afterRemove"]]) {
    const own = fs.readFileSync(path.join(templates, `${name}.tpl`), "utf8");
    // build/linux/<name>-*.sh: the OAK cameras' rule, and the virtual mouse and keyboard's.
    const linux = path.join(__dirname, "..", "build", "linux");
    // (An app of its own: only the rules it needs, under its own name, so removing it leaves
    // Hand Tracker's.)
    const ours = fs
      .readdirSync(linux)
      .filter((f) => f.startsWith(`${name}-`) && f.endsWith(".sh"))
      .filter((f) => !own || own.rules.includes(f.slice(name.length + 1, -3)))
      .sort()
      .map((f) => fs.readFileSync(path.join(linux, f), "utf8"))
      .map((text) => (own ? text.replace(/hand-tracker-(oak|uinput)\.rules/g, `${own.slug}-$1.rules`).replace(/Hand Tracker/g, own.name) : text));
    const file = path.join(dir, `${name}.tpl`);
    fs.writeFileSync(file, [own.trimEnd(), ...ours].join("\n\n").replace(/\r\n/g, "\n"));
    out.push(`-c.deb.${option}="${file}"`);
  }
  return out;
}

// An app of its own's settings, over package.json's. (Its files' names are written out here, not
// with electron-builder's \${…} values: the shell would take those for its own.)
function ownApp() {
  const version = require("../package.json").version;
  const builtFor = arch || process.arch;
  const q = (text) => `"${text}"`;
  return [
    `-c.appId=${own.id}`,
    `-c.productName=${q(own.name)}`,
    `-c.extraMetadata.name=${own.slug}`,
    `-c.extraMetadata.productName=${q(own.name)}`,
    `-c.extraMetadata.appKind=${appKind}`,
    `-c.extraMetadata.desktopName=${own.slug}.desktop`,
    `-c.portable.artifactName=${own.file}-${version}-portable.exe`,
    `-c.nsis.artifactName=${own.file}-${version}-setup.exe`,
    `-c.linux.executableName=${own.slug}`,
    `-c.linux.synopsis=${q(own.synopsis)}`,
    `-c.deb.packageName=${own.slug}`,
    `-c.deb.artifactName=${own.slug}_${version}_${builtFor === "arm64" ? "arm64" : "amd64"}.deb`,
    `-c.dmg.artifactName=${own.file}-${version}-mac-${builtFor === "arm64" ? "arm64" : "x64"}.dmg`,
    `-c.mac.extendInfo.NSCameraUsageDescription=${q(own.camera)}`,
  ];
}

let status = 1;
try {
  const args = ["electron-builder", PLATFORM[target], TARGET[target], ...(arch ? [`--${arch}`] : []), `-c.extraMetadata.buildTime=${new Date().toISOString()}`];
  if (target === "deb") args.push(...linuxScripts());
  if (own) args.push(...ownApp());
  const result = spawnSync("npx", args, { stdio: "inherit", shell: true });
  status = result.status === null ? 1 : result.status;
} finally {
  if (swapFfmpeg) {
    fs.rmSync(ffmpeg, { force: true });
    fs.renameSync(ffmpeg + ".host", ffmpeg);
  }
}
process.exit(status);
