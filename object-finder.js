/**
 * object-finder.js — finds people, animals and other everyday things (COCO's 80 kinds) in a
 * picture, on this device: MediaPipe's object detector with EfficientDet-Lite0 (Apache-2.0),
 * which comes with the app (about 18 MB, loaded only the first time it's needed; nothing is
 * downloaded). For Sentry mode's "ignore animals" on cameras that don't find objects
 * themselves (OAK cameras do, on the camera). It runs in a worker of its own
 * (object-finder-worker.js), on the processor, so it neither clashes with the hand tracker's
 * MediaPipe nor slows the page.
 *
 *   await ObjectFinder.load();        // (find loads it too)
 *   await ObjectFinder.find(image)    // [{ label, score, box: [x0, y0, x1, y1] (0-1 of the picture) }]
 *   ObjectFinder.loading()            // it's loading now
 */

(function (global) {
  let worker = null;
  let ready = false;
  let loadingNow = false;
  let nextId = 1;
  const waiting = new Map(); // id -> { resolve, reject }

  function start() {
    if (worker) return worker;
    worker = new Worker("object-finder-worker.js");
    worker.onmessage = (e) => {
      const { id, ok, objects, error } = e.data || {};
      const w = waiting.get(id);
      if (!w) return;
      waiting.delete(id);
      if (ok) {
        ready = true;
        loadingNow = false;
        w.resolve(objects || []);
      } else {
        loadingNow = false;
        w.reject(new Error(error || "The object finder failed."));
      }
    };
    worker.onerror = (e) => {
      const err = new Error((e && e.message) || "The object finder didn't load.");
      for (const w of waiting.values()) w.reject(err);
      waiting.clear();
      worker = null;
      ready = false;
      loadingNow = false;
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
    if (!ready) loadingNow = true;
    return ask({ load: true });
  }

  async function find(image) {
    const iw = image.videoWidth || image.width, ih = image.videoHeight || image.height;
    if (!iw || !ih) return [];
    if (!ready) loadingNow = true;
    const bitmap = await createImageBitmap(image);
    return ask({ bitmap }, [bitmap]);
  }

  global.ObjectFinder = { load, find, loading: () => loadingNow && !ready };
})(typeof window !== "undefined" ? window : globalThis);
