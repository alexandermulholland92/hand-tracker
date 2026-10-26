/**
 * second-look-worker.js — second-look.js's worker: Sentry's second look, YOLOv8 nano trained on
 * COCO (Ultralytics, AGPL-3.0: the model the OAK cameras run) by ONNX Runtime's WebAssembly build
 * (MIT), in a worker of its own: off the page's thread, and away from the hand tracker's and the
 * object finder's MediaPipe (each expects its WebAssembly runtime to be the only one).
 *
 * Messages in: { id, model } (the model's bytes, given over: get ready) or { id, bitmap } (an
 * ImageBitmap, given over). Out: { id, ok, objects: [{ label, score, box: [x0, y0, x1, y1] (0-1) }] }
 * or { id, ok: false, error }.
 */

/* global ort */
importScripts("node_modules/onnxruntime-web/dist/ort.wasm.min.js");

// (Behind the app's object finder, on 2,400 people-only pictures and 134 of a cat: an animal still told
// of in the same 3 people-only pictures from 0.25 to 0.5, and the cat most often at 0.25-0.3.)
const MIN_SCORE = 0.3;
const IOU = 0.5; // a box overlapping a surer one of its kind this much is the same thing
const MAX_RESULTS = 20;
const SIZE = 640; // a picture's longer side as the model sees it
const STRIDE = 32; // (its sides, in multiples of this)
// COCO's 80 kinds, in the model's order.
const NAMES = ["person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
  "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard",
  "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana",
  "apple", "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop",
  "mouse", "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush"];
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

// The picture at most SIZE on its longer side, in the middle of grey sides up to multiples of
// STRIDE (as the model was trained), as the model's input (RGB, 0-1, planes) -> { tensor, scale, dx, dy }.
function input(bitmap) {
  const w = bitmap.width, h = bitmap.height;
  const scale = Math.min(SIZE / w, SIZE / h);
  const nw = Math.round(w * scale), nh = Math.round(h * scale);
  const W = Math.ceil(nw / STRIDE) * STRIDE, H = Math.ceil(nh / STRIDE) * STRIDE;
  const dx = Math.floor((W - nw) / 2), dy = Math.floor((H - nh) / 2);
  const canvas = new OffscreenCanvas(W, H);
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "rgb(114, 114, 114)";
  g.fillRect(0, 0, W, H);
  g.drawImage(bitmap, dx, dy, nw, nh);
  const px = g.getImageData(0, 0, W, H).data;
  const n = W * H, data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    data[i] = px[i * 4] / 255;
    data[n + i] = px[i * 4 + 1] / 255;
    data[2 * n + i] = px[i * 4 + 2] / 255;
  }
  return { tensor: new ort.Tensor("float32", data, [1, 3, H, W]), scale, dx, dy };
}

const overlap = (a, b) => {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - w * h;
  return u > 0 ? (w * h) / u : 0;
};

// The model's output ([1, 84, places]: each place's box middle and size, then each kind's score)
// -> the surest of each thing found, its box as a share of the picture.
function objects(out, { scale, dx, dy }, w, h) {
  const [, rows, places] = out.dims, d = out.data;
  const found = [];
  for (let i = 0; i < places; i++) {
    let best = -1, score = MIN_SCORE;
    for (let c = 4; c < rows; c++) {
      const s = d[c * places + i];
      if (s > score) (score = s), (best = c - 4);
    }
    if (best < 0) continue;
    const cx = d[i], cy = d[places + i], bw = d[2 * places + i], bh = d[3 * places + i];
    const clip = (v) => Math.min(1, Math.max(0, v));
    found.push({ kind: best, score, box: [clip((cx - bw / 2 - dx) / scale / w), clip((cy - bh / 2 - dy) / scale / h), clip((cx + bw / 2 - dx) / scale / w), clip((cy + bh / 2 - dy) / scale / h)] });
  }
  found.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const f of found) {
    if (kept.length >= MAX_RESULTS) break;
    if (!kept.some((k) => k.kind === f.kind && overlap(k.box, f.box) > IOU)) kept.push(f);
  }
  return kept.map((k) => ({ label: NAMES[k.kind] || String(k.kind), score: Math.round(k.score * 1000) / 1000, box: k.box }));
}

self.onmessage = async (e) => {
  const { id, model, bitmap } = e.data || {};
  try {
    const s = await load(model);
    if (!bitmap) return self.postMessage({ id, ok: true, objects: [] });
    const w = bitmap.width, h = bitmap.height;
    const inp = input(bitmap);
    bitmap.close();
    const res = await s.run({ [s.inputNames[0]]: inp.tensor });
    self.postMessage({ id, ok: true, objects: objects(res[s.outputNames[0]], inp, w, h) });
  } catch (err) {
    if (bitmap && bitmap.close) bitmap.close();
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
