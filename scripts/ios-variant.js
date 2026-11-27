/**
 * ios-variant.js — the iPhone and iPad apps of their own, made from the built iPhone app (on a
 * Mac: GitHub's iPhone job, .github/workflows/build-apps.yml): the same app, with its own pages,
 * ID and name, so each installs beside Hand Tracker.
 *   node scripts/ios-variant.js <App.app> mouse|remote|converter|cluster|call <out folder>
 *     mouse:     Hand Mouse — only the hand mouse's files (build-web.js --hand-mouse), its page first
 *     remote:    Remote Recording — all of Hand Tracker's files (its rig is Hand Tracker's page),
 *                opening on remote-recording.html (Capacitor's server.appStartPath)
 *     converter: Recording Converter — all of Hand Tracker's files, opening on
 *                recording-converter.html (the Recording Converter, viewer.html, on its own)
 *     call:      Video Call — all of Hand Tracker's files, opening on video-call.html
 *     cluster:   Cluster — only its own few files (build-web.js --cluster: cluster.html as its
 *                page), for the Raspberry Pis running Cluster's service (RemoteLink.swift's
 *                ClusterPlugin reaches them)
 *       with, for this iPhone as a member of the cluster (ClusterMember.swift), any of:
 *       --python <Python.xcframework>  its own Python and the cluster's service
 *       --ffmpeg <folder>              its ffmpeg (scripts/build-ffmpeg-ios.sh's)
 *       --ort <folder>                 its ONNX Runtime (scripts/build-ort-ios.sh's)
 *       --wheels <folder>              NumPy and Pillow for its Python (scripts/get-ios-wheels.sh's; with --python)
 *       --transmission <folder>        its own Transmission (scripts/build-transmission-ios.sh's)
 *       --libtorrent <folder>          its own libtorrent, a big download's pieces (scripts/build-libtorrent-ios.sh's)
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
  // (Video Call: rings only while the app is open: iOS keeps an app's server only then; VideoCallPlugin, RemoteLink.swift)
  call: { id: "com.handtracker.call", name: "Video Call", camera: "Video Call sends your camera's picture to the device you're calling.",
    microphone: "Video Call sends your voice to the device you're calling.", start: "video-call.html" },
};
const [from, kind, outDir] = process.argv.slice(2);
const own = APPS[kind];
if (!from || !own || !outDir) {
  console.error("node scripts/ios-variant.js <App.app> mouse|remote|converter|cluster|call <out folder>");
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
let dylibTemplate = null; // (BeeWare's Info.plist for compiled modules made frameworks: --python's)
const pyAt = process.argv.indexOf("--python");
if (kind === "cluster" && pyAt > 0) addPython(app, path.resolve(process.argv[pyAt + 1]));
// Its ffmpeg, for a job's conversions, with --ffmpeg <folder> (scripts/build-ffmpeg-ios.sh's: ClusterFFmpeg.framework
// for iPhones and for the simulator).
const ffAt = process.argv.indexOf("--ffmpeg");
if (kind === "cluster" && ffAt > 0) addFramework(app, path.resolve(process.argv[ffAt + 1]), "ClusterFFmpeg");
// The animal model's tools: its ONNX Runtime, with --ort <folder> (scripts/build-ort-ios.sh's: ClusterORT.framework for
// iPhones and for the simulator), and NumPy and Pillow for its Python, with --wheels <folder> (scripts/get-ios-wheels.sh's).
const ortAt = process.argv.indexOf("--ort");
if (kind === "cluster" && ortAt > 0) addFramework(app, path.resolve(process.argv[ortAt + 1]), "ClusterORT");
const wheelsAt = process.argv.indexOf("--wheels");
if (kind === "cluster" && wheelsAt > 0) addWheels(app, path.resolve(process.argv[wheelsAt + 1]));
// Its own Transmission, for the cluster's downloads, with --transmission <folder> (scripts/build-transmission-ios.sh's:
// ClusterTransmission.framework for iPhones and for the simulator).
const trAt = process.argv.indexOf("--transmission");
if (kind === "cluster" && trAt > 0) addFramework(app, path.resolve(process.argv[trAt + 1]), "ClusterTransmission");
// Its own libtorrent, for a big download's pieces, with --libtorrent <folder> (scripts/build-libtorrent-ios.sh's:
// ClusterPieces.framework for iPhones and for the simulator).
const ltAt = process.argv.indexOf("--libtorrent");
if (kind === "cluster" && ltAt > 0) addFramework(app, path.resolve(process.argv[ltAt + 1]), "ClusterPieces");
if (kind === "cluster" && (pyAt > 0 || ffAt > 0 || ortAt > 0 || wheelsAt > 0 || trAt > 0 || ltAt > 0)) signForSimulator(app);

function onSimulator(app) {
  return execFileSync("plutil", ["-extract", "DTPlatformName", "raw", "-o", "-", path.join(app, "Info.plist")]).toString().trim() === "iphonesimulator";
}

function addFramework(app, folder, name) {
  const from = path.join(folder, onSimulator(app) ? "ios-arm64-simulator" : "ios-arm64", `${name}.framework`);
  if (!fs.existsSync(path.join(from, name))) throw new Error(`No ${name}.framework in ${from}`);
  fs.mkdirSync(path.join(app, "Frameworks"), { recursive: true });
  execFileSync("ditto", [from, path.join(app, "Frameworks", `${name}.framework`)]);
  console.log(`Cluster's ${name}: ${path.relative(process.cwd(), from)}`);
}

// A compiled Python module (a .so) made a framework of its own, by its full name (iOS loads code only from frameworks;
// as Python's own build/utils.sh does in an Xcode build): a .fwork file where it was, a .origin file beside it.
function moduleFramework(app, file, name, sim) {
  const folder = path.join(app, "Frameworks", `${name}.framework`);
  fs.mkdirSync(folder, { recursive: true });
  const info = path.join(folder, "Info.plist");
  fs.writeFileSync(info, dylibTemplate);
  execFileSync("plutil", ["-replace", "CFBundleExecutable", "-string", name, info]);
  execFileSync("plutil", ["-replace", "CFBundleIdentifier", "-string", `${own.id}.${name}`.replace(/_/g, "-"), info]);
  execFileSync("plutil", ["-replace", "CFBundleSupportedPlatforms", "-json", sim ? '["iPhoneSimulator"]' : '["iPhoneOS"]', info]);
  fs.renameSync(file, path.join(folder, name));
  const fwork = file.replace(/\.so$/, ".fwork");
  fs.writeFileSync(fwork, `Frameworks/${name}.framework/${name}\n`);
  fs.writeFileSync(path.join(folder, `${name}.origin`), path.relative(app, fwork).split(path.sep).join("/") + "\n");
}

// Wheels for this app's platform (…_arm64_iphoneos.whl, or …_iphonesimulator.whl in the simulator) into its Python's
// site-packages, each compiled module a framework (numpy._core._multiarray_umath.framework, say).
function addWheels(app, folder) {
  const sim = onSimulator(app);
  const lib = path.join(app, "python", "lib");
  const version = dylibTemplate && fs.readdirSync(lib).find((d) => /^python3\.\d+$/.test(d));
  if (!version) throw new Error("--wheels needs --python (the app's own Python) with it");
  const site = path.join(lib, version, "site-packages");
  fs.mkdirSync(site, { recursive: true });
  const wheels = fs.readdirSync(folder).filter((f) => f.endsWith(sim ? "_arm64_iphonesimulator.whl" : "_arm64_iphoneos.whl"));
  if (!wheels.length) throw new Error(`No wheels for ${sim ? "the simulator" : "iPhones"} in ${folder}`);
  for (const w of wheels) execFileSync("unzip", ["-q", "-o", path.join(folder, w), "-d", site]);
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".so")) found.push(p);
    }
  };
  walk(site);
  for (const so of found) {
    const name = path.relative(site, so).split(path.sep).join("/").split(".")[0].replace(/\//g, ".");
    moduleFramework(app, so, name, sim);
  }
  console.log(`Cluster's Python packages: ${wheels.join(", ")} (${found.length} compiled modules as frameworks)`);
}

// (the simulator runs on the Mac, which loads only signed code: each framework added signed as it is, by no one, as
// the app itself is there; on an iPhone Sideloadly or AltStore signs them all with the app)
function signForSimulator(app) {
  if (!onSimulator(app)) return;
  const frameworks = path.join(app, "Frameworks");
  for (const f of fs.readdirSync(frameworks).filter((f) => f.endsWith(".framework"))) {
    execFileSync("codesign", ["--force", "--sign", "-", "--timestamp=none", path.join(frameworks, f)]);
  }
}

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
  dylibTemplate = fs.readFileSync(path.join(xcf, "build", "iOS-dylib-Info-template.plist"));
  let modules = 0;
  for (const file of fs.readdirSync(dynload).filter((f) => f.endsWith(".so"))) {
    moduleFramework(app, path.join(dynload, file), file.split(".")[0], sim);
    modules++;
  }
  // (its HTTPS, a job's model from GitHub, say: checked against Apple's own root certificates, as this Mac has them;
  // an iPhone gives an app's own OpenSSL none. ClusterMember.swift points SSL_CERT_FILE at them.)
  const roots = execFileSync("security", ["find-certificate", "-a", "-p", "/System/Library/Keychains/SystemRootCertificates.keychain"], { maxBuffer: 64 << 20 });
  fs.writeFileSync(path.join(app, "python", "cacert.pem"), roots);
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
if (own.microphone) set("NSMicrophoneUsageDescription", own.microphone);
console.log(`${own.name}: ${path.relative(process.cwd(), app)} (${own.id})`);
