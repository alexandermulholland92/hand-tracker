/**
 * build-web.js — assembles www/, the self-contained web app used for the Android
 * APK (Capacitor's webDir) and the hosted website. It copies the app's own files
 * plus only the library files the page actually loads, into vendor/ (hosts such
 * as Cloudflare Pages skip folders named node_modules), and points the page at
 * vendor/. index.html gets a "hand-tracker-bundle" meta tag so the page knows it
 * is running from this bundle.
 *   npm run build:web
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "www");

const APP_FILES = [
  "index.html", "viewer.html",
  "app.js", "viewer.js", "mobile-bridge.js", "export-ui.js", "motion-import.js",
  "hand-tracker.js", "far-hands.js", "robot-motion.js", "hand-3d.js",
  "video-recorder.js", "readable-text.js", "motion-export.js", "pc-control.js", "oak-source.js", "ops-sessions.js", "rig-live.js",
  "video-formats.js", "video-convert.js", "video-origin.js", "video-sync.js", "video-queue.js", "multi-video.js",
];

const LIBRARY_FILES = [
  // MediaPipe Hands: loader, wasm builds, packed assets and both models.
  ...fs
    .readdirSync(path.join(ROOT, "node_modules/@mediapipe/hands"))
    .filter((f) => /\.(js|wasm|data|tflite|binarypb)$/.test(f))
    .map((f) => `node_modules/@mediapipe/hands/${f}`),
  // MediaPipe Pose, for far-away hands (loaded only when that's turned on): the lite model only.
  ...fs
    .readdirSync(path.join(ROOT, "node_modules/@mediapipe/pose"))
    .filter((f) => /\.(js|wasm|data|binarypb)$/.test(f) || f === "pose_landmark_lite.tflite")
    .map((f) => `node_modules/@mediapipe/pose/${f}`),
  "node_modules/@mediapipe/drawing_utils/drawing_utils.js",
  "node_modules/three/build/three.min.js",
  "node_modules/three/examples/js/controls/OrbitControls.js",
  // OCR (readable text in mirrored view): the browser worker only loads the LSTM builds.
  "node_modules/tesseract.js/dist/tesseract.min.js",
  "node_modules/tesseract.js/dist/worker.min.js",
  "node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js",
  "node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js",
  "node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js",
  // Video converter for the website and Android app (ffmpeg.wasm, single-threaded build).
  "node_modules/@ffmpeg/ffmpeg/dist/umd/ffmpeg.js",
  "node_modules/@ffmpeg/ffmpeg/dist/umd/814.ffmpeg.js",
  "node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js",
];
// Files over Cloudflare Pages' 25 MiB limit are split into parts listed in <file>.json;
// video-convert.js joins them back together.
const SPLIT_FILES = ["node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm"];
const PART_BYTES = 20 * 1024 * 1024;
// Android's packager un-gzips ".gz" assets (and drops the extension), so the bundle
// ships the OCR language data uncompressed; readable-text.js asks for it that way.
const GUNZIP_FILES = ["node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"];

const vendorPath = (rel) => rel.replace(/^node_modules\//, "vendor/");
let bytes = 0;
let count = 0;

function read(rel) {
  const from = path.join(ROOT, rel);
  if (!fs.existsSync(from)) throw new Error(`Missing ${rel} — run npm install first.`);
  return fs.readFileSync(from);
}

function write(rel, data) {
  const to = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, data);
  bytes += data.length;
  count++;
}

// Shown in the page header, so it's clear which copy a phone or browser is running.
const BUILT = new Date().toISOString();
const VERSION = require("../package.json").version;

fs.rmSync(OUT, { recursive: true, force: true });
for (const rel of APP_FILES) {
  // Library paths in the page and scripts: "node_modules/... -> "vendor/...
  let text = read(rel).toString("utf8").split('"node_modules/').join('"vendor/');
  if (rel === "index.html") {
    text = text.replace(
      '<meta charset="UTF-8" />',
      '<meta charset="UTF-8" />\n<meta name="hand-tracker-bundle" content="1" />\n' +
        `<meta name="hand-tracker-build" content="${BUILT}" data-version="${VERSION}" />`
    );
  }
  write(rel, Buffer.from(text, "utf8"));
}
for (const rel of LIBRARY_FILES) write(vendorPath(rel), read(rel));
for (const rel of GUNZIP_FILES) write(vendorPath(rel).replace(/\.gz$/, ""), zlib.gunzipSync(read(rel)));
for (const rel of SPLIT_FILES) {
  const data = read(rel);
  const parts = [];
  for (let at = 0, n = 1; at < data.length; at += PART_BYTES, n++) {
    const name = `${path.basename(rel)}.part${n}`;
    write(path.join(path.dirname(vendorPath(rel)), name), data.subarray(at, at + PART_BYTES));
    parts.push(name);
  }
  write(`${vendorPath(rel)}.json`, Buffer.from(JSON.stringify({ size: data.length, parts })));
}

console.log(`www/ ready: ${count} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
