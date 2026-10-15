/**
 * build-android.js — builds the Android apps in one step: Hand Tracker and Hand Mouse (the
 * hand mouse alone, hand-mouse.html), two apps from the one project (android/app/build.gradle's
 * flavors "full" and "mouse").
 *   npm run android:apk
 *
 * 1. assembles www/ (scripts/build-web.js) and copies it into the Android project (cap sync android)
 * 2. assembles Hand Mouse's files into android/app/src/mouse/assets (build-web.js --hand-mouse),
 *    with Capacitor's settings
 * 3. runs Gradle (assembleFullDebug, assembleMouseDebug) with Android Studio's bundled JDK and your Android SDK
 * 4. copies the results to dist/HandTracker-<version>.apk and dist/HandMouse-<version>.apk
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
// Full path: some shells don't look in the current folder for commands.
run(`"${path.join(ANDROID, isWin ? "gradlew.bat" : "gradlew")}" assembleFullDebug assembleMouseDebug`, ANDROID);

const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
for (const [flavor, name] of [["full", "HandTracker"], ["mouse", "HandMouse"]]) {
  const apk = path.join(ANDROID, "app", "build", "outputs", "apk", flavor, "debug", `app-${flavor}-debug.apk`);
  const out = path.join(ROOT, "dist", `${name}-${version}.apk`);
  fs.copyFileSync(apk, out);
  console.log(`APK ready: ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
}
