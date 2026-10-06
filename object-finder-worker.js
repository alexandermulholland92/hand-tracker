/**
 * object-finder-worker.js — object-finder.js's worker: MediaPipe's object detector
 * (EfficientDet-Lite0) in a worker of its own. On the page it can't load beside the hand
 * tracker's MediaPipe (each brings a WebAssembly runtime that expects to be the only one),
 * and here it's off the page's thread too.
 *
 * Messages in: { id, load: true } (just get ready) or { id, bitmap } (an ImageBitmap, given
 * over). Out: { id, ok, objects: [{ label, score, box: [x0, y0, x1, y1] (0-1) }] } or
 * { id, ok: false, error }.
 */

/* global Vision */
// MediaPipe's runtime writes its "INFO: …" lines (like the XNNPACK one) as errors; they're news.
const logError = console.error.bind(console);
console.error = (...args) => (typeof args[0] === "string" && args[0].startsWith("INFO:") ? console.info(...args) : logError(...args));
importScripts("node_modules/@mediapipe/tasks-vision/vision_bundle.js");

const MIN_SCORE = 0.35;
let detector = null;
let loading = null;

function load() {
  if (detector) return Promise.resolve(detector);
  if (!loading) {
    loading = (async () => {
      const here = (p) => new URL(p, self.location.href).href;
      const files = await Vision.FilesetResolver.forVisionTasks(here("node_modules/@mediapipe/tasks-vision/wasm"));
      detector = await Vision.ObjectDetector.createFromOptions(files, {
        baseOptions: { modelAssetPath: here("models/efficientdet_lite0.tflite"), delegate: "CPU" },
        runningMode: "IMAGE",
        scoreThreshold: MIN_SCORE,
        maxResults: 12,
      });
      return detector;
    })().catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

self.onmessage = async (e) => {
  const { id, bitmap } = e.data || {};
  try {
    const d = await load();
    if (!bitmap) return self.postMessage({ id, ok: true, objects: [] });
    const w = bitmap.width, h = bitmap.height;
    const res = d.detect(bitmap);
    bitmap.close();
    const objects = (res.detections || []).map((det) => {
      const c = (det.categories || [])[0] || {};
      const b = det.boundingBox || { originX: 0, originY: 0, width: 0, height: 0 };
      return {
        label: String(c.categoryName || c.displayName || ""),
        score: Number(c.score) || 0,
        box: [b.originX / w, b.originY / h, (b.originX + b.width) / w, (b.originY + b.height) / h],
      };
    });
    self.postMessage({ id, ok: true, objects });
  } catch (err) {
    if (bitmap && bitmap.close) bitmap.close();
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
