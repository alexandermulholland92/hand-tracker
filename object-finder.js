/**
 * object-finder.js — finds people, animals and other everyday things in a picture, on this
 * device: the OAK cameras' model (YOLOv8 nano trained further on animals: COCO's 80 kinds and the
 * animals it's been taught, models/kinds.js), by ONNX Runtime's WebAssembly build. Its model (13
 * MB) is downloaded the first time it's wanted and checked (sentry-models.js). For Sentry mode's
 * animals on cameras that don't find objects themselves (OAK cameras do, on the camera). It runs
 * in a worker of its own (object-finder-worker.js), on the processor, so it neither clashes with
 * the hand tracker's MediaPipe nor slows the page.
 *
 *   await ObjectFinder.load();        // downloaded (once) and loaded (find loads it too); tried
 *                                     //   again a minute after it fails
 *   await ObjectFinder.find(image)    // [{ label, score, box: [x0, y0, x1, y1] (0-1 of the picture) }];
 *                                     //   throws while it isn't ready (load's started then)
 *   ObjectFinder.loading()            // it's loading now
 */

(function (global) {
  const RETRY_MS = 60000;
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
    worker = new Worker("object-finder-worker.js");
    worker.onmessage = (e) => {
      const { id, ok, objects, error: why } = e.data || {};
      const w = waiting.get(id);
      if (!w) return;
      waiting.delete(id);
      if (ok) w.resolve(objects || []);
      else w.reject(new Error(why || "The object finder failed."));
    };
    worker.onerror = (e) => {
      const err = new Error((e && e.message) || "The object finder didn't load.");
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

  function load() {
    if (state === "ready") return Promise.resolve();
    if (preparing) return preparing;
    if (state === "failed" && Date.now() - failedAt < RETRY_MS) return Promise.reject(new Error(error));
    state = "loading";
    error = "";
    preparing = (async () => {
      if (!global.SentryModels) throw new Error("its model isn't in this Hand Tracker");
      const model = await SentryModels.bytes("finder");
      const buffer = model.byteOffset === 0 && model.byteLength === model.buffer.byteLength ? model.buffer : model.slice().buffer;
      await ask({ model: buffer }, [buffer]);
      state = "ready";
    })()
      .catch((err) => {
        failed(err);
        throw err;
      })
      .finally(() => (preparing = null));
    return preparing;
  }

  async function find(image) {
    if (state !== "ready") {
      load().catch(() => {});
      throw new Error(state === "failed" ? error : "The object finder isn't ready yet.");
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

  global.ObjectFinder = { load, find, loading: () => state === "loading", state: () => ({ state, error }) };
})(typeof window !== "undefined" ? window : globalThis);
