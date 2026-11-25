/**
 * build-transmission-android.js — this phone's own Transmission for the Cluster app (the user, 2026-11-25: phones
 * download for the cluster too): Transmission's library (libtransmission 4.1.4) with curl 8.23.0 and mbedTLS 3.6.8,
 * built for 64-bit ARM phones with the Android NDK, as one library the app loads
 * (android/app/src/cluster/jniLibs/arm64-v8a/libtransmission_jni.so; android/app/src/cluster/cpp has its JNI part).
 *   node scripts/build-transmission-android.js [--force]
 * The sources are downloaded once (their SHA-256 checked) into a cache folder (HT_TR_ANDROID_CACHE, else
 * %LOCALAPPDATA%/Android/transmission-build or ~/.cache/hand-tracker-transmission-android). Needs the NDK
 * (ANDROID_NDK_HOME, else the SDK's ndk/27.3.13750724) and CMake 3.18+ with Ninja (the SDK's cmake/3.22.1, else on
 * the path). Licences: Transmission GPL-2.0-or-later (with the OpenSSL exception), curl's own (MIT-like), mbedTLS
 * Apache-2.0: fine in the app (AGPL-3.0).
 */

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "android", "app", "src", "cluster", "jniLibs", "arm64-v8a", "libtransmission_jni.so");
const JNI = path.join(ROOT, "android", "app", "src", "cluster", "cpp");
const isWin = process.platform === "win32";
const SOURCES = [
  { dir: "mbedtls-3.6.8", file: "mbedtls-3.6.8.tar.bz2", url: "https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.8/mbedtls-3.6.8.tar.bz2",
    sha256: "bc54b818e87f49c0b3281dd85d24adaede0e63b4e822e3fbd49c005a38b9595b" },
  { dir: "curl-8.23.0", file: "curl-8.23.0.tar.xz", url: "https://github.com/curl/curl/releases/download/curl-8_23_0/curl-8.23.0.tar.xz",
    sha256: "8dadd7d2536a314f982ad05a651b713f426bf7d02cc2c76cffb9796f2218e6c5" },
  { dir: "transmission-4.1.4", file: "transmission-4.1.4.tar.xz", url: "https://github.com/transmission/transmission/releases/download/4.1.4/transmission-4.1.4.tar.xz",
    sha256: "86e7aa020cdf64826447034bc85f4d3b7c848d8c0891d9dc9b9fddfb2c805d22" },
];

// Changes Transmission's source needs for Android, made once it's unpacked (each only once): [file, before, after].
const PATCHES = [
  // (disk quotas: Android's C library has their structures but not quotactl itself; a phone has none: "none", as when
  // the call fails)
  ["transmission-4.1.4/libtransmission/file-capacity.cc",
    "#else\n    if (quotactl(QCMD(Q_GETQUOTA, USRQUOTA), device, getuid(), reinterpret_cast<caddr_t>(&dq)) != 0)",
    "#elif defined(__ANDROID__)\n    (void)device;\n    return disk_space;\n#else\n    if (quotactl(QCMD(Q_GETQUOTA, USRQUOTA), device, getuid(), reinterpret_cast<caddr_t>(&dq)) != 0)"],
];

function sdkDir() {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (isWin ? path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk") : path.join(os.homedir(), "Android", "Sdk"));
}

// (Ninja's folder on the path too: Transmission's bundled libraries are CMake projects of their own, which look for
// it there rather than being told where it is)
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
  const cache = process.env.HT_TR_ANDROID_CACHE || (isWin ? path.join(process.env.LOCALAPPDATA || "", "Android", "transmission-build") : path.join(os.homedir(), ".cache", "hand-tracker-transmission-android"));
  const src = path.join(cache, "src");
  fs.mkdirSync(src, { recursive: true });
  for (const s of SOURCES) {
    const file = path.join(src, s.file);
    if (!fs.existsSync(file) || sha256(file) !== s.sha256) {
      console.log(`Downloading ${s.file}…`);
      await fetchTo(s.url, file);
    }
    if (sha256(file) !== s.sha256) throw new Error(`${s.file} isn't the one expected (its SHA-256 differs).`);
    if (!fs.existsSync(path.join(src, s.dir))) {
      try {
        run("tar", ["-xf", s.file], { cwd: src });
      } catch (e) {
        // (Transmission's macOS framework links can't be made on Windows: not needed here)
        if (!fs.existsSync(path.join(src, s.dir, "CMakeLists.txt"))) throw e;
      }
    }
  }
  for (const [rel, before, after] of PATCHES) {
    const file = path.join(src, rel);
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    if (text.includes(after)) continue;
    if (!text.includes(before)) throw new Error(`${rel} isn't as expected: its Android change can't be made.`);
    fs.writeFileSync(file, text.replace(before, after));
    console.log(`Changed for Android: ${rel}`);
  }
  const prefix = path.join(cache, "prefix-arm64");
  const build = path.join(cache, "build-arm64");
  const common = ["-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${ninja}`, `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`, "-DANDROID_ABI=arm64-v8a", "-DANDROID_PLATFORM=android-24",
    "-DANDROID_STL=c++_static", "-DCMAKE_BUILD_TYPE=Release", `-DCMAKE_INSTALL_PREFIX=${prefix}`, `-DCMAKE_PREFIX_PATH=${prefix}`, `-DCMAKE_FIND_ROOT_PATH=${prefix}`,
    "-DCMAKE_POSITION_INDEPENDENT_CODE=ON"];
  const lib = (n) => path.join(prefix, "lib", n);
  const steps = [
    ["mbedtls-3.6.8", ["-DENABLE_TESTING=OFF", "-DENABLE_PROGRAMS=OFF", "-DUSE_SHARED_MBEDTLS_LIBRARY=OFF", "-DUSE_STATIC_MBEDTLS_LIBRARY=ON", "-DGEN_FILES=OFF"]],
    ["curl-8.23.0", ["-DBUILD_SHARED_LIBS=OFF", "-DBUILD_STATIC_LIBS=ON", "-DBUILD_CURL_EXE=OFF", "-DBUILD_LIBCURL_DOCS=OFF", "-DBUILD_MISC_DOCS=OFF", "-DENABLE_CURL_MANUAL=OFF",
      "-DBUILD_TESTING=OFF", "-DBUILD_EXAMPLES=OFF", "-DCURL_USE_MBEDTLS=ON", "-DCURL_USE_OPENSSL=OFF", "-DCURL_USE_LIBPSL=OFF", "-DUSE_LIBIDN2=OFF", "-DCURL_USE_LIBSSH2=OFF",
      "-DCURL_BROTLI=OFF", "-DCURL_ZSTD=OFF", "-DUSE_NGHTTP2=OFF", "-DCURL_DISABLE_LDAP=ON", "-DCURL_CA_BUNDLE=none", "-DCURL_CA_PATH=none",
      `-DMBEDTLS_INCLUDE_DIR=${path.join(prefix, "include")}`, `-DMBEDTLS_LIBRARY=${lib("libmbedtls.a")}`, `-DMBEDX509_LIBRARY=${lib("libmbedx509.a")}`,
      `-DMBEDCRYPTO_LIBRARY=${lib("libmbedcrypto.a")}`]],
  ];
  for (const [dir, args] of steps) {
    const b = path.join(build, dir);
    run(cmake, ["-S", path.join(src, dir), "-B", b, ...common, ...args]);
    run(cmake, ["--build", b, "--parallel"]);
    run(cmake, ["--install", b]);
  }
  // Transmission's library and the JNI part, in one: Transmission's own CMake inside ours (its options: the library alone).
  const b = path.join(build, "transmission-jni");
  run(cmake, ["-S", JNI, "-B", b, ...common, `-DTR_SRC=${path.join(src, "transmission-4.1.4")}`,
    "-DENABLE_DAEMON=OFF", "-DENABLE_GTK=OFF", "-DENABLE_QT=OFF", "-DENABLE_MAC=OFF", "-DENABLE_UTILS=OFF", "-DENABLE_CLI=OFF", "-DENABLE_TESTS=OFF",
    "-DENABLE_NLS=OFF", "-DINSTALL_DOC=OFF", "-DINSTALL_WEB=OFF", "-DREBUILD_WEB=OFF", "-DRUN_CLANG_TIDY=OFF", "-DWITH_CRYPTO=mbedtls", "-DWITH_SYSTEMD=OFF",
    "-DWITH_APPINDICATOR=OFF", "-DWITH_KQUEUE=OFF", ...["EVENT2", "DEFLATE", "DHT", "MINIUPNPC", "NATPMP", "UTP", "B64", "PSL"].map((n) => `-DUSE_SYSTEM_${n}=OFF`),
    `-DCURL_INCLUDE_DIR=${path.join(prefix, "include")}`, `-DCURL_LIBRARY=${lib("libcurl.a")}`,
    `-DMBEDTLS_INCLUDE_DIR=${path.join(prefix, "include")}`, `-DMBEDTLS_LIBRARY=${lib("libmbedtls.a")}`, `-DMBEDCRYPTO_LIBRARY=${lib("libmbedcrypto.a")}`]);
  run(cmake, ["--build", b, "--parallel", "--target", "transmission_jni"]);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.copyFileSync(path.join(b, "libtransmission_jni.so"), OUT);
  // (its debugging symbols left out: most of its size, and of no use on a phone)
  const host = isWin ? "windows-x86_64" : process.platform === "darwin" ? "darwin-x86_64" : "linux-x86_64";
  run(path.join(ndk, "toolchains", "llvm", "prebuilt", host, "bin", isWin ? "llvm-strip.exe" : "llvm-strip"), ["--strip-unneeded", OUT]);
  console.log(`Ready: ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
