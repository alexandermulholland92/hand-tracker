/**
 * build-android.js — builds the Android apps in one step: Hand Tracker, Hand Mouse (the hand
 * mouse alone, hand-mouse.html), Remote Recording (remote recording alone: remote-recording.html
 * first) and Recording Converter (the Recording Converter alone: recording-converter.html first),
 * four apps from the one project (android/app/build.gradle's flavors "full", "mouse", "remote"
 * and "converter").
 *   npm run android:apk
 *
 * 1. assembles www/ (scripts/build-web.js) and copies it into the Android project (cap sync android)
 * 2. assembles Hand Mouse's files into android/app/src/mouse/assets (build-web.js --hand-mouse),
 *    with Capacitor's settings
 * 3. copies www/ into android/app/src/remote/assets for Remote Recording, into
 *    android/app/src/converter/assets for Recording Converter and into android/app/src/call/assets for Video
 *    Call, with Capacitor's settings and the page each opens on (remote-recording.html,
 *    recording-converter.html, video-call.html)
 * 4. runs Gradle (assembleFullDebug, assembleMouseDebug, assembleRemoteDebug,
 *    assembleConverterDebug) with Android Studio's bundled JDK and your Android SDK, then the Cluster app on its
 *    own (assembleClusterDebug: only it has Python, for its member service, android/app/build.gradle), with
 *    Cluster's service's code in its assets (cluster/node: assets/cluster-node, with a STAMP of its contents, by
 *    which the phone knows to copy it again, and its VERSION: the commit a GitHub build is made from, else "dev")
 * 5. copies the results to dist/HandTracker-<version>.apk, dist/HandMouse-<version>.apk,
 *    dist/RemoteRecording-<version>.apk, dist/RecordingConverter-<version>.apk and
 *    dist/Cluster-<version>.apk (Cluster: the "cluster" flavor, only its own few files with
 *    cluster.html as index.html, build-web.js --cluster, made as Hand Mouse is)
 *
 * Needs Android Studio (or JAVA_HOME + ANDROID_HOME pointing at a JDK 17+ and an Android SDK).
 */

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ANDROID = path.join(ROOT, "android");
const isWin = process.platform === "win32";

function firstExisting(candidates) {
  return candidates.find((p) => p && fs.existsSync(p));
}

const javaHome = firstExisting([
  process.env.JAVA_HOME,
  isWin && "C:\\Program Files\\Android\\Android Studio\\jbr",
  !isWin && "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
  !isWin && path.join(os.homedir(), "android-studio/jbr"),
]);
const sdk = firstExisting([
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  isWin && path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk"),
  !isWin && path.join(os.homedir(), "Library/Android/sdk"),
  !isWin && path.join(os.homedir(), "Android/Sdk"),
]);
if (!javaHome) throw new Error("No JDK found. Install Android Studio or set JAVA_HOME.");
if (!sdk) throw new Error("No Android SDK found. Install Android Studio or set ANDROID_HOME.");

const run = (cmd, cwd = ROOT) => execSync(cmd, { cwd, stdio: "inherit", env: { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk } });

// Gradle reads the SDK location from local.properties (kept out of version control).
fs.writeFileSync(path.join(ANDROID, "local.properties"), `sdk.dir=${sdk.replace(/\\/g, "\\\\").replace(/:/g, "\\:")}\n`);

run("node scripts/build-web.js");
run("npx cap sync android");
const MAIN_ASSETS = path.join(ANDROID, "app", "src", "main", "assets");
const MOUSE_ASSETS = path.join(ANDROID, "app", "src", "mouse", "assets");
run(`node scripts/build-web.js --hand-mouse --out "${path.join(MOUSE_ASSETS, "public")}"`);
for (const f of ["capacitor.config.json", "capacitor.plugins.json"]) fs.copyFileSync(path.join(MAIN_ASSETS, f), path.join(MOUSE_ASSETS, f));
// Remote Recording (its rig is Hand Tracker's page) and Recording Converter: all of Hand Tracker's
// files, each opening on its own page (Capacitor's server.appStartPath).
// Cluster: its page as index.html and the few files it loads (build-web.js --cluster).
const CLUSTER_ASSETS = path.join(ANDROID, "app", "src", "cluster", "assets");
fs.rmSync(CLUSTER_ASSETS, { recursive: true, force: true });
run(`node scripts/build-web.js --cluster --out "${path.join(CLUSTER_ASSETS, "public")}"`);
for (const f of ["capacitor.config.json", "capacitor.plugins.json"]) fs.copyFileSync(path.join(MAIN_ASSETS, f), path.join(CLUSTER_ASSETS, f));
// The member service's code (Cluster's own service, run on the phone: MemberService.java): its Python files.
{
  const from = path.join(ROOT, "cluster", "node"), to = path.join(CLUSTER_ASSETS, "cluster-node");
  const files = [...fs.readdirSync(from).filter((f) => f.endsWith(".py")), ...fs.readdirSync(path.join(from, "modules")).filter((f) => f.endsWith(".py")).map((f) => `modules/${f}`)];
  const hash = require("crypto").createHash("sha256");
  for (const f of files.sort()) {
    const data = fs.readFileSync(path.join(from, f));
    fs.mkdirSync(path.dirname(path.join(to, f)), { recursive: true });
    fs.writeFileSync(path.join(to, f), data);
    hash.update(f).update(data);
  }
  const sha = process.env.GITHUB_SHA || "";
  fs.writeFileSync(path.join(to, "VERSION"), /^[0-9a-f]{40}$/.test(sha) ? sha : "dev");
  fs.writeFileSync(path.join(to, "STAMP"), hash.digest("hex").slice(0, 16));
}
for (const [flavor, page] of [["remote", "/remote-recording.html"], ["converter", "/recording-converter.html"], ["call", "/video-call.html"]]) {
  const assets = path.join(ANDROID, "app", "src", flavor, "assets");
  fs.rmSync(assets, { recursive: true, force: true });
  fs.cpSync(path.join(MAIN_ASSETS, "public"), path.join(assets, "public"), { recursive: true });
  fs.copyFileSync(path.join(MAIN_ASSETS, "capacitor.plugins.json"), path.join(assets, "capacitor.plugins.json"));
  const capConfig = JSON.parse(fs.readFileSync(path.join(MAIN_ASSETS, "capacitor.config.json"), "utf8"));
  capConfig.server = { ...(capConfig.server || {}), appStartPath: page };
  fs.writeFileSync(path.join(assets, "capacitor.config.json"), JSON.stringify(capConfig, null, "\t"));
}
// Full path: some shells don't look in the current folder for commands.
const gradlew = `"${path.join(ANDROID, isWin ? "gradlew.bat" : "gradlew")}"`;
run(`${gradlew} assembleFullDebug assembleMouseDebug assembleRemoteDebug assembleConverterDebug assembleCallDebug`, ANDROID);
// (on its own: only the Cluster app has Python, which Gradle adds to every app it builds in the same run; its own
// Transmission first, built once: scripts/build-transmission-android.js, the NDK's)
run("node scripts/build-transmission-android.js");
// (and its own libtorrent, for a big download's pieces: scripts/build-libtorrent-android.js)
run("node scripts/build-libtorrent-android.js");
run(`${gradlew} assembleClusterDebug`, ANDROID);

const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
for (const [flavor, name] of [["full", "HandTracker"], ["mouse", "HandMouse"], ["remote", "RemoteRecording"], ["converter", "RecordingConverter"], ["call", "VideoCall"], ["cluster", "Cluster"]]) {
  const apk = path.join(ANDROID, "app", "build", "outputs", "apk", flavor, "debug", `app-${flavor}-debug.apk`);
  const out = path.join(ROOT, "dist", `${name}-${version}.apk`);
  fs.copyFileSync(apk, out);
  console.log(`APK ready: ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
}
