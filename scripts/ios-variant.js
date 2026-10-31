/**
 * ios-variant.js — the iPhone and iPad apps of their own, made from the built iPhone app (on a
 * Mac: GitHub's iPhone job, .github/workflows/build-apps.yml): the same app, with its own pages,
 * ID and name, so each installs beside Hand Tracker.
 *   node scripts/ios-variant.js <App.app> mouse|remote|converter <out folder>
 *     mouse:     Hand Mouse — only the hand mouse's files (build-web.js --hand-mouse), its page first
 *     remote:    Remote Recording — all of Hand Tracker's files (its rig is Hand Tracker's page),
 *                opening on remote-recording.html (Capacitor's server.appStartPath)
 *     converter: Recording Converter — all of Hand Tracker's files, opening on
 *                recording-converter.html (the Recording Converter, viewer.html, on its own)
 * Writes <out folder>/App.app. The app isn't signed (nor is Hand Tracker's): Sideloadly or
 * AltStore sign it with the user's own Apple ID when they install it.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APPS = {
  mouse: { id: "com.handtracker.mouse", name: "Hand Mouse", camera: "Hand Mouse follows your hand with the camera." },
  remote: { id: "com.handtracker.remote", name: "Remote Recording", camera: "Remote Recording records hand motion with the cameras when a phone or browser starts it.", start: "remote-recording.html" },
  converter: { id: "com.handtracker.converter", name: "Recording Converter", camera: "Recording Converter doesn't use the camera.", start: "recording-converter.html" },
};
const [from, kind, outDir] = process.argv.slice(2);
const own = APPS[kind];
if (!from || !own || !outDir) {
  console.error("node scripts/ios-variant.js <App.app> mouse|remote|converter <out folder>");
  process.exit(1);
}

const ROOT = path.join(__dirname, "..");
const app = path.join(path.resolve(outDir), "App.app");
fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(path.dirname(app), { recursive: true });
execFileSync("ditto", [path.resolve(from), app]); // (keeps the bundle as it is: links, permissions)

const pub = path.join(app, "public");
if (kind === "mouse") {
  // Only Hand Mouse's files, with Capacitor's own scripts the built app has (cordova*.js).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hand-mouse-www-"));
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-web.js"), "--hand-mouse", "--out", tmp], { stdio: "inherit" });
  for (const f of fs.readdirSync(pub)) if (/^cordova.*\.js$/.test(f)) fs.copyFileSync(path.join(pub, f), path.join(tmp, f));
  fs.rmSync(pub, { recursive: true, force: true });
  execFileSync("ditto", [tmp, pub]);
  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  const file = path.join(app, "capacitor.config.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.server = { ...(config.server || {}), appStartPath: own.start };
  fs.writeFileSync(file, JSON.stringify(config, null, "\t"));
}

const plist = path.join(app, "Info.plist");
const set = (key, value) => execFileSync("plutil", ["-replace", key, "-string", value, plist]);
set("CFBundleIdentifier", own.id);
set("CFBundleDisplayName", own.name);
set("CFBundleName", own.name);
set("NSCameraUsageDescription", own.camera);
console.log(`${own.name}: ${path.relative(process.cwd(), app)} (${own.id})`);
