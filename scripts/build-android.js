/**
 * build-android.js — builds the Android APK in one step.
 *   npm run android:apk
 *
 * 1. assembles www/ (scripts/build-web.js)
 * 2. copies it into the Android project (cap sync android)
 * 3. runs Gradle (assembleDebug) with Android Studio's bundled JDK and your Android SDK
 * 4. copies the result to dist/HandTracker-<version>.apk
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
// Full path: some shells don't look in the current folder for commands.
run(`"${path.join(ANDROID, isWin ? "gradlew.bat" : "gradlew")}" assembleDebug`, ANDROID);

const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const apk = path.join(ANDROID, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const out = path.join(ROOT, "dist", `HandTracker-${version}.apk`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(apk, out);
console.log(`\nAPK ready: ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
