/**
 * sentry-models.js — Sentry mode's two models for finding animals, downloaded the first time
 * they're wanted from this project's sentry-models-3 release, each checked against its size and
 * SHA-256, then kept: by the Windows, Mac and Linux app itself (electron/sentry-models.js, in
 * its data folder), on a phone by the app's own web request (mobile.fetchBytes: a page can't
 * fetch GitHub's release files) in the app's storage (IndexedDB). Trained for this app (run 8,
 * 2026-11-12): see THIRD_PARTY_NOTICES.md.
 *   finder: the object finder (object-finder.js) for cameras that don't find objects themselves:
 *     YOLOv8 nano trained further on animals (animals8, the OAK cameras' model too), its kinds in
 *     models/kinds.js.
 *   second: the second look (second-look.js): a model of another kind (SSDLite, MobileNetV3) that
 *     finds people and animals in a black-and-white close-up (nightlook6).
 *
 *   await SentryModels.bytes("finder" | "second")   // its bytes (a Uint8Array), downloaded once
 *   SentryModels.MODELS                             // { finder, second: { name, url, size, sha256 } }
 *   SentryModels.OLD                                // the ones before, deleted where they're kept
 */

(function (global) {
  const BASE = "https://github.com/alexandermulholland92/hand-tracker/releases/download/sentry-models-3/";
  const MODELS = {
    finder: { name: "animals8.onnx", url: BASE + "animals8.onnx", size: 13071704, sha256: "62f76d03c90701582d5023240340b0e0d9b5249695033bd2fcd8f6206bce2b27" },
    second: { name: "nightlook6.onnx", url: BASE + "nightlook6.onnx", size: 8982877, sha256: "73b2556b48d20cbeed76323dde60102e5f4eea1a6bdcfa454bb8490228e104eb" },
  };
  const OLD = ["yolov8n_coco.onnx", "animals7.onnx", "nightlook5.onnx"]; // (sentry-models-1's second look, and run 7's: sentry-models-2)
  const DB = "hand-tracker-models"; // (a phone's IndexedDB: each model, by its name)

  // The model whole: its size and SHA-256 as published.
  async function whole(bytes, model) {
    if (!bytes || bytes.length !== model.size) return false;
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("") === model.sha256;
  }

  // A phone's copies, kept in IndexedDB.
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("files");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function stored(fn, mode = "readonly") {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("files", mode);
        const req = fn(tx.objectStore("files"));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }
  const kept = (name) => stored((s) => s.get(name)).then((b) => (b ? new Uint8Array(b) : null));
  const keep = (name, bytes) => stored((s) => s.put(bytes.slice().buffer, name), "readwrite");
  let tidied = false;
  const tidy = () => (tidied ? Promise.resolve() : stored((s) => OLD.forEach((n) => s.delete(n)), "readwrite").then(() => (tidied = true)));

  const fetching = {}; // (one download of each at a time)
  async function bytes(which) {
    const model = MODELS[which];
    if (!model) throw new Error(`no such model (${which})`);
    if (global.desktop && desktop.sentry && desktop.sentry.model) return desktop.sentry.model(which);
    if (!(global.mobile && mobile.fetchBytes)) throw new Error("it needs the Hand Tracker app");
    if (!fetching[which]) {
      fetching[which] = (async () => {
        tidy().catch(() => {});
        const here = await kept(model.name).catch(() => null);
        if (await whole(here, model)) return here;
        const got = await mobile.fetchBytes(model.url);
        if (!(await whole(got, model))) throw new Error("its model didn't download whole (it didn't match its checksum)");
        await keep(model.name, got).catch(() => {}); // (used this time either way)
        return got;
      })().finally(() => delete fetching[which]);
    }
    return fetching[which];
  }

  const api = { bytes, MODELS, OLD };
  if (typeof module === "object" && module.exports) module.exports = api;
  global.SentryModels = api;
})(typeof window !== "undefined" ? window : globalThis);
