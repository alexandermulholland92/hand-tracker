/**
 * ios-variant.js — the iPhone and iPad apps of their own, made from the built iPhone app (on a
 * Mac: GitHub's iPhone job, .github/workflows/build-apps.yml): the same app, with its own pages,
 * ID and name, so each installs beside Hand Tracker.
 *   node scripts/ios-variant.js <App.app> mouse|remote|converter|cluster <out folder>
 *     mouse:     Hand Mouse — only the hand mouse's files (build-web.js --hand-mouse), its page first
 *     remote:    Remote Recording — all of Hand Tracker's files (its rig is Hand Tracker's page),
 *                opening on remote-recording.html (Capacitor's server.appStartPath)
 *     converter: Recording Converter — all of Hand Tracker's files, opening on
 *                recording-converter.html (the Recording Converter, viewer.html, on its own)
 *     cluster:   Cluster — only its own few files (build-web.js --cluster: cluster.html as its
 *                page), for the Raspberry Pis running Cluster's service (RemoteLink.swift's
 *                ClusterPlugin reaches them)
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
  cluster: { id: "com.handtracker.cluster", name: "Cluster", camera: "Cluster doesn't use the camera." },
};
const [from, kind, outDir] = process.argv.slice(2);
const own = APPS[kind];
if (!from || !own || !outDir) {
  console.error("node scripts/ios-variant.js <App.app> mouse|remote|converter|cluster <out folder>");
  process.exit(1);
}

const ROOT = path.join(__dirname, "..");
const app = path.join(path.resolve(outDir), "App.app");
fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(path.dirname(app), { recursive: true });
execFileSync("ditto", [path.resolve(from), app]); // (keeps the bundle as it is: links, permissions)

const pub = path.join(app, "public");
if (kind === "mouse" || kind === "cluster") {
  // Only Hand Mouse's (or Cluster's) files, with Capacitor's own scripts the built app has (cordova*.js).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hand-mouse-www-"));
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-web.js"), kind === "mouse" ? "--hand-mouse" : "--cluster", "--out", tmp], { stdio: "inherit" });
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

// Cluster's own Python and service, for this iPhone as a member of the cluster (ClusterMember.swift), with
// --python <Python.xcframework> (BeeWare's Python 3.13 for iOS): its framework, its standard library and its compiled
// modules, each made a framework of its own (iOS loads code only from frameworks; as Python's own build/utils.sh
// does in an Xcode build: a .fwork file where the module was, a .origin file beside it), and the service's code
// (cluster/node's Python files, as build-android.js puts them in the Android app, and the app's starter).
const pyAt = process.argv.indexOf("--python");
if (kind === "cluster" && pyAt > 0) addPython(app, path.resolve(process.argv[pyAt + 1]));

function addPython(app, xcf) {
  const platform = execFileSync("plutil", ["-extract", "DTPlatformName", "raw", "-o", "-", path.join(app, "Info.plist")]).toString().trim();
  const sim = platform === "iphonesimulator";
  const slice = !sim ? "ios-arm64" : fs.existsSync(path.join(xcf, "ios-arm64-simulator")) ? "ios-arm64-simulator" : "ios-arm64_x86_64-simulator";
  const frameworks = path.join(app, "Frameworks");
  fs.mkdirSync(frameworks, { recursive: true });
  execFileSync("ditto", [path.join(xcf, slice, "Python.framework"), path.join(frameworks, "Python.framework")]);
  const lib = path.join(app, "python", "lib");
  fs.mkdirSync(lib, { recursive: true });
  for (const from of [path.join(xcf, "lib"), path.join(xcf, slice, "lib-arm64")]) {
    execFileSync("rsync", ["-a", "--exclude", "libpython*.dylib", from + "/", lib + "/"]);
  }
  const version = fs.readdirSync(lib).find((d) => /^python3\.\d+$/.test(d));
  const dynload = path.join(lib, version, "lib-dynload");
  const template = fs.readFileSync(path.join(xcf, "build", "iOS-dylib-Info-template.plist"));
  let modules = 0;
  for (const file of fs.readdirSync(dynload).filter((f) => f.endsWith(".so"))) {
    const name = file.split(".")[0];
    const folder = path.join(frameworks, `${name}.framework`);
    fs.mkdirSync(folder, { recursive: true });
    const info = path.join(folder, "Info.plist");
    fs.writeFileSync(info, template);
    execFileSync("plutil", ["-replace", "CFBundleExecutable", "-string", name, info]);
    execFileSync("plutil", ["-replace", "CFBundleIdentifier", "-string", `${own.id}.${name}`.replace(/_/g, "-"), info]);
    execFileSync("plutil", ["-replace", "CFBundleSupportedPlatforms", "-json", sim ? '["iPhoneSimulator"]' : '["iPhoneOS"]', info]);
    fs.renameSync(path.join(dynload, file), path.join(folder, name));
    const fwork = path.join(dynload, file.replace(/\.so$/, ".fwork"));
    fs.writeFileSync(fwork, `Frameworks/${name}.framework/${name}\n`);
    fs.writeFileSync(path.join(folder, `${name}.origin`), path.relative(app, fwork).split(path.sep).join("/") + "\n");
    modules++;
  }
  // (the simulator runs on the Mac, which loads only signed code: each of these signed as they are, by no one, as the
  // app itself is there; on an iPhone Sideloadly or AltStore signs them all with the app)
  if (sim) {
    for (const f of fs.readdirSync(frameworks).filter((f) => f.endsWith(".framework"))) {
      execFileSync("codesign", ["--force", "--sign", "-", "--timestamp=none", path.join(frameworks, f)]);
    }
  }
  const from = path.join(ROOT, "cluster", "node"), code = path.join(app, "cluster-node");
  const files = [...fs.readdirSync(from).filter((f) => f.endsWith(".py")), ...fs.readdirSync(path.join(from, "modules")).filter((f) => f.endsWith(".py")).map((f) => `modules/${f}`)];
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(code, f)), { recursive: true });
    fs.copyFileSync(path.join(from, f), path.join(code, f));
  }
  fs.copyFileSync(path.join(ROOT, "android", "app", "src", "cluster", "python", "htmember.py"), path.join(code, "htmember.py"));
  const sha = process.env.GITHUB_SHA || "";
  fs.writeFileSync(path.join(code, "VERSION"), /^[0-9a-f]{40}$/.test(sha) ? sha : "dev");
  console.log(`Cluster's Python (${slice}, ${version}): ${modules} compiled modules as frameworks; the service: ${files.length + 1} files`);
}

const plist = path.join(app, "Info.plist");
const set = (key, value) => execFileSync("plutil", ["-replace", key, "-string", value, plist]);
set("CFBundleIdentifier", own.id);
set("CFBundleDisplayName", own.name);
set("CFBundleName", own.name);
set("NSCameraUsageDescription", own.camera);
console.log(`${own.name}: ${path.relative(process.cwd(), app)} (${own.id})`);
