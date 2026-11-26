/**
 * build-libtorrent-android.js — this phone's own libtorrent for the Cluster app (the user, 2026-11-25: phones take
 * pieces of a big download and send them to the device chosen to keep it): libtorrent 2.0.16 with Boost 1.92's headers
 * (no OpenSSL: its own crypto; no HTTPS trackers), built for 64-bit ARM phones with the Android NDK, as one library the
 * app loads (android/app/src/cluster/jniLibs/arm64-v8a/libpieces_jni.so; android/app/src/cluster/cpp-pieces has its
 * JNI part, cluster/pieces-native the part-runner both phone apps share).
 *   node scripts/build-libtorrent-android.js [--force]
 * The sources are downloaded once (their SHA-256 checked: GitHub's own) into a cache folder (HT_LT_ANDROID_CACHE, else
 * %LOCALAPPDATA%/Android/libtorrent-build or ~/.cache/hand-tracker-libtorrent-android). Needs the NDK and CMake with
 * Ninja, as build-transmission-android.js. Licences: libtorrent BSD-3-Clause, Boost BSL-1.0: fine in the app (AGPL-3.0).
 */

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "android", "app", "src", "cluster", "jniLibs", "arm64-v8a", "libpieces_jni.so");
const JNI = path.join(ROOT, "android", "app", "src", "cluster", "cpp-pieces");
const isWin = process.platform === "win32";
const LT = { dir: "libtorrent-rasterbar-2.0.16", file: "libtorrent-rasterbar-2.0.16.tar.gz",
  url: "https://github.com/arvidn/libtorrent/releases/download/v2.0.16/libtorrent-rasterbar-2.0.16.tar.gz",
  sha256: "8463b8d786141c3923dbf54ab34e5c3312af9913b591239cb0e30f66ead34b9b" };
const BOOST = { dir: "boost-1.92.0", file: "boost-1.92.0-b2-nodocs.tar.xz",
  url: "https://github.com/boostorg/boost/releases/download/boost-1.92.0/boost-1.92.0-b2-nodocs.tar.xz",
  sha256: "ea7b982002cc9dfbe59b0b217b206f470dc75f3de0bb2973d844118934d82411" };

function sdkDir() {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (isWin ? path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk") : path.join(os.homedir(), "Android", "Sdk"));
}

let extraPath = "";
function run(cmd, args, opts = {}) {
  console.log(`> ${path.basename(cmd)} ${args.join(" ").slice(0, 300)}`);
  const env = extraPath ? { ...process.env, PATH: extraPath + path.delimiter + (process.env.PATH || process.env.Path || "") } : process.env;
  execFileSync(cmd, args, { stdio: "inherit", env, ...opts });
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function fetchTo(url, file) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  if (fs.existsSync(OUT) && !process.argv.includes("--force")) {
    console.log(`${path.relative(ROOT, OUT)} is there (--force to build it again).`);
    return;
  }
  const ndk = process.env.ANDROID_NDK_HOME || process.env.ANDROID_NDK_ROOT || path.join(sdkDir(), "ndk", "27.3.13750724");
  const toolchain = path.join(ndk, "build", "cmake", "android.toolchain.cmake");
  if (!fs.existsSync(toolchain)) throw new Error(`No Android NDK at ${ndk} (ANDROID_NDK_HOME).`);
  const sdkCmake = path.join(sdkDir(), "cmake", "3.22.1", "bin");
  const cmake = fs.existsSync(path.join(sdkCmake, isWin ? "cmake.exe" : "cmake")) ? path.join(sdkCmake, isWin ? "cmake.exe" : "cmake") : "cmake";
  const ninja = fs.existsSync(path.join(sdkCmake, isWin ? "ninja.exe" : "ninja")) ? path.join(sdkCmake, isWin ? "ninja.exe" : "ninja") : "ninja";
  if (fs.existsSync(sdkCmake)) extraPath = sdkCmake;
  const cache = process.env.HT_LT_ANDROID_CACHE || (isWin ? path.join(process.env.LOCALAPPDATA || "", "Android", "libtorrent-build") : path.join(os.homedir(), ".cache", "hand-tracker-libtorrent-android"));
  const src = path.join(cache, "src");
  fs.mkdirSync(src, { recursive: true });
  for (const s of [LT, BOOST]) {
    const file = path.join(src, s.file);
    if (!fs.existsSync(file) || sha256(file) !== s.sha256) {
      console.log(`Downloading ${s.file}…`);
      await fetchTo(s.url, file);
    }
    if (sha256(file) !== s.sha256) throw new Error(`${s.file} isn't the one expected (its SHA-256 differs).`);
  }
  if (!fs.existsSync(path.join(src, LT.dir, "CMakeLists.txt"))) run("tar", ["-xzf", LT.file], { cwd: src });
  // (Boost: only its headers, all libtorrent needs since Boost 1.69)
  if (!fs.existsSync(path.join(src, BOOST.dir, "boost", "version.hpp"))) run("tar", ["-xJf", BOOST.file, `${BOOST.dir}/boost`], { cwd: src });
  const b = path.join(cache, "build-arm64");
  run(cmake, ["-S", JNI, "-B", b, "-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${ninja}`, `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`, "-DANDROID_ABI=arm64-v8a",
    "-DANDROID_PLATFORM=android-24", "-DANDROID_STL=c++_static", "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
    `-DLT_SRC=${path.join(src, LT.dir)}`, `-DBOOST_INCLUDE=${path.join(src, BOOST.dir)}`,
    "-Dbuild_tests=OFF", "-Dbuild_examples=OFF", "-Dbuild_tools=OFF", "-Dpython-bindings=OFF", "-Dgnutls=OFF",
    "-DCMAKE_DISABLE_FIND_PACKAGE_OpenSSL=ON", "-DCMAKE_DISABLE_FIND_PACKAGE_GnuTLS=ON", "-DCMAKE_DISABLE_FIND_PACKAGE_LibGcrypt=ON"]);
  run(cmake, ["--build", b, "--parallel", "--target", "pieces_jni"]);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.copyFileSync(path.join(b, "libpieces_jni.so"), OUT);
  // (its debugging symbols left out: most of its size, and of no use on a phone)
  const host = isWin ? "windows-x86_64" : process.platform === "darwin" ? "darwin-x86_64" : "linux-x86_64";
  run(path.join(ndk, "toolchains", "llvm", "prebuilt", host, "bin", isWin ? "llvm-strip.exe" : "llvm-strip"), ["--strip-unneeded", OUT]);
  console.log(`Ready: ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
