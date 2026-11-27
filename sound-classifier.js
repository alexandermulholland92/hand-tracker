/**
 * sound-classifier.js — telling crying from other sound, for the baby monitor's "crying only" (baby-monitor.js):
 * MediaPipe's audio classifier with Google's YAMNet (521 kinds of sound, from AudioSet), its "Baby cry, infant cry"
 * score. The model (4 MB) is downloaded the first time from Google's own MediaPipe models (the user, 2026-11-26:
 * "OK, use it") and kept in the page's cache, so it's there afterwards without the network. Loaded only when it's
 * wanted, and run on a worker of its own (sound-classifier-worker.js: in the page, its runtime clashes with
 * MediaPipe Hands').
 *
 *   await SoundClassifier.load()
 *   await SoundClassifier.cryScore(samples, rate)   // samples: about a second (15,600 at 16 kHz) -> 0..1
 *   SoundClassifier.status()                        // "none" | "loading" | "ready" | "error: …"
 */
(function (global) {
  const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite";
  const CACHE = "hand-tracker-models";
  let worker = null, loading = null, state = "none", asked = 0;
  const waiting = new Map(); // id -> { resolve, reject }

  async function modelBytes() {
    let cache = null;
    try {
      cache = global.caches ? await global.caches.open(CACHE) : null;
      const hit = cache ? await cache.match(MODEL_URL) : null;
      if (hit) return new Uint8Array(await hit.arrayBuffer());
    } catch {
      cache = null; // (no cache here: downloaded each time)
    }
    let bytes;
    try {
      const res = await fetch(MODEL_URL);
      if (!res.ok) throw new Error(`the sound model didn't download (${res.status})`);
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      // (a phone's page that can't fetch it itself: by the app's own request, mobile-bridge.js)
      if (!(global.mobile && global.mobile.fetchBytes)) throw err;
      bytes = await global.mobile.fetchBytes(MODEL_URL);
    }
    // (a TFLite model: "TFL3" at 4; about 4 MB)
    if (bytes.length < 1e6 || String.fromCharCode(...bytes.subarray(4, 8)) !== "TFL3") throw new Error("the sound model that came isn't one");
    if (cache) await cache.put(MODEL_URL, new Response(bytes.slice(), { headers: { "Content-Type": "application/octet-stream" } })).catch(() => {});
    return bytes;
  }

  function load() {
    if (state === "ready") return Promise.resolve();
    if (!loading) {
      state = "loading";
      loading = (async () => {
        const model = await modelBytes();
        if (!worker) {
          worker = new Worker(new URL("sound-classifier-worker.js", global.location.href).href);
          worker.onmessage = (e) => {
            const m = e.data || {};
            const w = waiting.get(m.id);
            if (!w) return;
            waiting.delete(m.id);
            if (m.type === "error") w.reject(new Error(m.message));
            else w.resolve(m);
          };
          worker.onerror = (e) => {
            for (const w of waiting.values()) w.reject(new Error((e && e.message) || "the sound classifier stopped"));
            waiting.clear();
          };
        }
        await ask({ type: "load", model: model.buffer }, [model.buffer]);
        state = "ready";
      })().catch((err) => {
        loading = null;
        state = `error: ${err && err.message ? err.message : err}`;
        throw err;
      });
    }
    return loading;
  }
  // One question to the worker, answered by its message with the same id.
  function ask(msg, transfer = []) {
    const id = ++asked;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker.postMessage({ ...msg, id }, transfer);
    });
  }

  // How sure it is that this sound is crying: the most of the windows it looks at (YAMNet's are 0.975 s).
  async function cryScore(samples, rate = 16000) {
    await load();
    const copy = new Float32Array(samples);
    const m = await ask({ type: "classify", samples: copy.buffer, rate }, [copy.buffer]);
    return Number(m.score) || 0;
  }

  global.SoundClassifier = { load, cryScore, status: () => state };
})(typeof window !== "undefined" ? window : globalThis);
