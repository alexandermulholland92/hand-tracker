/**
 * second-look.js — Sentry's second look (sentry.js): before an animal a camera's first look found
 * is an alert, another model looks at it too. The first look is the OAK cameras' model (YOLOv8
 * nano trained further on animals), on the camera or, for the others, in the app (object-finder.js);
 * the second is a model of another kind, so the two don't make the same mistakes: SSDLite with
 * MobileNetV3 (nightlook5), which finds people and animals in a black-and-white close-up around
 * the animal (second-look-worker.js says how). An OAK camera's animals always have it; another
 * camera's when its ⚙ turns it on. Its model (9 MB) is downloaded the first time it's wanted and
 * checked (sentry-models.js). It runs in a worker of its own (second-look-worker.js).
 *
 *   SecondLook.prepare(now)        // downloaded (once) and loaded, if it isn't; tried again a minute after it
 *                                  //   fails (now: at once, as a camera's second look is turned on)
 *   await SecondLook.find(image, box)  // what it finds close up around box ([x0, y0, x1, y1], 0-1 of
 *                                  //   the picture): [{ label ("person" or "animal"), score, box (0-1 of
 *                                  //   the picture) }]; throws while it isn't ready (prepare's started then)
 *   SecondLook.state()             // { state: "off" | "loading" | "ready" | "failed", error }
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

  function prepare(now = false) {
    if (state === "ready" || preparing) return preparing || Promise.resolve();
    if (state === "failed" && !now && Date.now() - failedAt < RETRY_MS) return Promise.resolve();
    state = "loading";
    error = "";
    preparing = (async () => {
      if (!global.SentryModels) throw new Error("its model isn't in this Hand Tracker");
      const model = await SentryModels.bytes("second");
      const buffer = model.byteOffset === 0 && model.byteLength === model.buffer.byteLength ? model.buffer : model.slice().buffer;
      await ask({ model: buffer }, [buffer]);
      state = "ready";
    })()
      .catch(failed)
      .finally(() => (preparing = null));
    return preparing;
  }

  async function find(image, box) {
    if (state !== "ready") {
      prepare();
      throw new Error(state === "failed" ? error : "The second look isn't ready yet.");
    }
    const iw = image.videoWidth || image.width, ih = image.videoHeight || image.height;
    if (!iw || !ih) return [];
    const bitmap = await createImageBitmap(image);
    try {
      return await ask({ bitmap, box: Array.isArray(box) ? box.slice(0, 4) : null }, [bitmap]);
    } catch (err) {
      failed(err);
      throw err;
    }
  }

  const api = { prepare, find, state: () => ({ state, error }) };
  if (typeof module === "object" && module.exports) module.exports = api;
  global.SecondLook = api;
})(typeof window !== "undefined" ? window : globalThis);
