/**
 * second-look-worker.js — second-look.js's worker: Sentry's second look, a model of another kind
 * than the object finder's (SSDLite with MobileNetV3, trained for this app: nightlook5,
 * sentry-models.js) that finds people and animals (any kind: "animal") in a black-and-white
 * picture, by ONNX Runtime's WebAssembly build (MIT), in a worker of its own: off the page's
 * thread, and away from the hand tracker's MediaPipe (each expects its WebAssembly runtime to be
 * the only one).
 *
 * It looks at a close-up around the animal the first look found, not the whole picture: a square
 * CLOSE_UP times the animal's longer side (at least MIN_SIDE pixels of the picture, at most its
 * shorter side), made black and white. Shrunk whole into the model's 384 pixels, a far-off cat
 * (a Kinect's, 13% of its picture across) was too small to tell; close up, it's found (2026-11-07,
 * on the user's own clips and cameras: tools/clips_eval.py, crop_look.py).
 *
 * Messages in: { id, model } (the model's bytes, given over: get ready) or { id, bitmap, box } (an
 * ImageBitmap, given over, and the animal's box in it: [x0, y0, x1, y1], 0-1). Out: { id, ok,
 * objects: [{ label ("person" or "animal"), score, box: [x0, y0, x1, y1] (0-1 of the whole picture) }] }
 * or { id, ok: false, error }.
 */

/* global ort */
importScripts("node_modules/onnxruntime-web/dist/ort.wasm.min.js");

const MIN_SCORE = 0.35;
const MAX_RESULTS = 12;
const CLOSE_UP = 4; // the close-up's side, as many times the animal's longer side
const MIN_SIDE = 160; // (pixels of the picture, at least)
const LABELS = ["person", "animal"];
const SIZE = 384; // (the model's square)
let session = null;
let loading = null;

function load(model) {
  if (session) return Promise.resolve(session);
  if (!loading) {
    if (!model) return Promise.reject(new Error("The second look isn't ready."));
    loading = (async () => {
      ort.env.wasm.wasmPaths = new URL("node_modules/onnxruntime-web/dist/", self.location.href).href;
      session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
      return session;
    })().catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

// The close-up around box (0-1) in a w x h picture -> { x, y, side } (pixels).
function closeUp(box, w, h) {
  const [x0, y0, x1, y1] = box;
  let side = Math.max(MIN_SIDE, CLOSE_UP * Math.max((x1 - x0) * w, (y1 - y0) * h));
  side = Math.min(side, w, h);
  const cx = ((x0 + x1) / 2) * w, cy = ((y0 + y1) / 2) * h;
  const x = Math.floor(Math.max(0, Math.min(w - side, cx - side / 2)));
  const y = Math.floor(Math.max(0, Math.min(h - side, cy - side / 2)));
  return { x, y, side: Math.floor(side) };
}

// A region of the picture as the model's input: SIZE square (its longer side; the rest grey), black
// and white (the brightness JPEG keeps: 0.299 R + 0.587 G + 0.114 B) in all three planes, 0-1
// -> { tensor, nw, nh, dx, dy }.
function input(bitmap, r, size) {
  const s = size / Math.max(r.w, r.h);
  const nw = Math.max(1, Math.round(r.w * s)), nh = Math.max(1, Math.round(r.h * s));
  const dx = Math.floor((size - nw) / 2), dy = Math.floor((size - nh) / 2);
  const canvas = new OffscreenCanvas(size, size);
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "rgb(114, 114, 114)";
  g.fillRect(0, 0, size, size);
  g.imageSmoothingQuality = "high";
  g.drawImage(bitmap, r.x, r.y, r.w, r.h, dx, dy, nw, nh);
  const px = g.getImageData(0, 0, size, size).data;
  const n = size * size, data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const v = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
    data[i] = data[n + i] = data[2 * n + i] = v;
  }
  return { tensor: new ort.Tensor("float32", data, [1, 3, size, size]), nw, nh, dx, dy };
}

// The model's output (each place's box, x0 y0 x1 y1 0-1 of its square, and its person and animal
// scores) -> the surest finds, their boxes as a share of the whole picture (w x h) the region r is in.
function objects(boxes, scores, inp, r, size, w, h) {
  const n = scores.dims[1], b = boxes.data, sc = scores.data;
  const found = [];
  for (let i = 0; i < n; i++) {
    const p = sc[i * 2], a = sc[i * 2 + 1];
    const kind = a > p ? 1 : 0, score = Math.max(p, a);
    if (score < MIN_SCORE) continue;
    const bx = (v) => (r.x + ((v * size - inp.dx) / inp.nw) * r.w) / w;
    const by = (v) => (r.y + ((v * size - inp.dy) / inp.nh) * r.h) / h;
    const clip = (v) => Math.min(1, Math.max(0, v));
    found.push({ label: LABELS[kind], score: Math.round(score * 1000) / 1000, box: [bx(b[i * 4]), by(b[i * 4 + 1]), bx(b[i * 4 + 2]), by(b[i * 4 + 3])].map(clip) });
  }
  return found.sort((x, y) => y.score - x.score).slice(0, MAX_RESULTS);
}

self.onmessage = async (e) => {
  const { id, model, bitmap, box } = e.data || {};
  try {
    const s = await load(model);
    if (!bitmap) return self.postMessage({ id, ok: true, objects: [] });
    const w = bitmap.width, h = bitmap.height;
    const c = Array.isArray(box) && box.length === 4 ? closeUp(box, w, h) : { x: 0, y: 0, side: 0 };
    const r = c.side > 0 ? { x: c.x, y: c.y, w: c.side, h: c.side } : { x: 0, y: 0, w, h };
    const inp = input(bitmap, r, SIZE);
    bitmap.close();
    const res = await s.run({ [s.inputNames[0]]: inp.tensor });
    self.postMessage({ id, ok: true, objects: objects(res.boxes, res.scores, inp, r, SIZE, w, h) });
  } catch (err) {
    if (bitmap && bitmap.close) bitmap.close();
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
