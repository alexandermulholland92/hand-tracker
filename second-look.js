/**
 * second-look.js — Sentry's second look (sentry.js), for the cameras that don't find objects
 * themselves (a webcam, a phone's camera, a Kinect: any but an OAK camera), turned on under each one's ⚙:
 * before an animal the app's object finder found in that camera's picture is an alert, another
 * model looks at the picture too. YOLOv8 nano trained on COCO (Ultralytics, AGPL-3.0: the model the
 * OAK cameras run; the app's object finder is EfficientDet-Lite0), 13 MB, downloaded the first time
 * it's wanted and checked against its SHA-256: by the Windows, Mac and Linux app itself
 * (electron/second-look.js, into its data folder), on a phone by the app's own web request
 * (mobile.fetchBytes: a page can't fetch GitHub's release files) and kept in the app's storage
 * (IndexedDB). It runs in a worker of its own (second-look-worker.js).
 *
 *   SecondLook.prepare(now)        // downloaded (once) and loaded, if it isn't; tried again a minute after it
 *                                  //   fails (now: at once, as a camera's second look is turned on)
 *   await SecondLook.find(image)   // [{ label, score, box: [x0, y0, x1, y1] (0-1 of the picture) }];
 *                                  //   throws while it isn't ready (prepare's started then)
 *   SecondLook.state()             // { state: "off" | "loading" | "ready" | "failed", error }
 *   SecondLook.MODEL               // { name, url, size, sha256 }
 */

(function (global) {
  const MODEL = {
    name: "yolov8n_coco.onnx",
    url: "https://github.com/alexandermulholland92/hand-tracker/releases/download/sentry-models-1/yolov8n_coco.onnx",
    size: 12988754,
    sha256: "60ffef652cfaaa0478c7ab22cd38c0632787ffe58558d79bb6d37e85248a3d1c",
  };
  const RETRY_MS = 60000;
  const DB = "hand-tracker-models"; // (a phone's IndexedDB: the model, by its name)

  let worker = null;
  let state = "off", error = "", failedAt = 0;
  let preparing = null;
  let nextId = 1;
  const waiting = new Map(); // id -> { resolve, reject }

  const errText = (err) => (err && err.message ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  function failed(err) {
    state = "failed";
    error = errText(err);
    failedAt = Date.now();
    if (worker) worker.terminate();
    worker = null; // (a fresh one next time)
  }

  function start() {
    if (worker) return worker;
    worker = new Worker("second-look-worker.js");
    worker.onmessage = (e) => {
      const { id, ok, objects, error: why } = e.data || {};
      const w = waiting.get(id);
      if (!w) return;
      waiting.delete(id);
      if (ok) w.resolve(objects || []);
      else w.reject(new Error(why || "The second look failed."));
    };
    worker.onerror = (e) => {
      const err = new Error((e && e.message) || "The second look didn't load.");
      for (const w of waiting.values()) w.reject(err);
      waiting.clear();
      failed(err);
    };
    return worker;
  }

  function ask(msg, transfer = []) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      start().postMessage({ id, ...msg }, transfer);
    });
  }

  // The model whole: its size and SHA-256 as published.
  async function whole(bytes) {
    if (!bytes || bytes.length !== MODEL.size) return false;
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("") === MODEL.sha256;
  }

  // A phone's copy, kept in IndexedDB.
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("files");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function kept() {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const req = db.transaction("files").objectStore("files").get(MODEL.name);
        req.onsuccess = () => resolve(req.result ? new Uint8Array(req.result) : null);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }
  async function keep(bytes) {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("files", "readwrite");
        tx.objectStore("files").put(bytes.slice().buffer, MODEL.name);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  // The model's bytes: the computer app's (it downloads and keeps it itself), else a phone's (kept
  // here, downloaded the first time).
  async function modelBytes() {
    if (global.desktop && desktop.sentry && desktop.sentry.secondLookModel) return desktop.sentry.secondLookModel();
    if (global.mobile && mobile.fetchBytes) {
      const here = await kept().catch(() => null);
      if (await whole(here)) return here;
      const got = await mobile.fetchBytes(MODEL.url);
      if (!(await whole(got))) throw new Error("its model didn't download whole (it didn't match its checksum)");
      await keep(got).catch(() => {}); // (used this time either way)
      return got;
    }
    throw new Error("it needs the Hand Tracker app");
  }

  function prepare(now = false) {
    if (state === "ready" || preparing) return preparing || Promise.resolve();
    if (state === "failed" && !now && Date.now() - failedAt < RETRY_MS) return Promise.resolve();
    state = "loading";
    error = "";
    preparing = (async () => {
      const model = await modelBytes();
      const buffer = model.byteOffset === 0 && model.byteLength === model.buffer.byteLength ? model.buffer : model.slice().buffer;
      await ask({ model: buffer }, [buffer]);
      state = "ready";
    })()
      .catch(failed)
      .finally(() => (preparing = null));
    return preparing;
  }

  async function find(image) {
    if (state !== "ready") {
      prepare();
      throw new Error(state === "failed" ? error : "The second look isn't ready yet.");
    }
    const iw = image.videoWidth || image.width, ih = image.videoHeight || image.height;
    if (!iw || !ih) return [];
    const bitmap = await createImageBitmap(image);
    try {
      return await ask({ bitmap }, [bitmap]);
    } catch (err) {
      failed(err);
      throw err;
    }
  }

  const api = { prepare, find, state: () => ({ state, error }), MODEL };
  if (typeof module === "object" && module.exports) module.exports = api;
  global.SecondLook = api;
})(typeof window !== "undefined" ? window : globalThis);
