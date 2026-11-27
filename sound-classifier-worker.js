/**
 * sound-classifier-worker.js — MediaPipe's audio classifier (YAMNet) on a worker of its own (sound-classifier.js
 * asks it): in the page itself its WebAssembly runtime clashes with MediaPipe Hands' (both are Emscripten
 * modules: "Module.noExitRuntime has been replaced…", 2026-11-26). Only the "Baby cry, infant cry" score.
 *
 *   { type: "load", id, model: ArrayBuffer }  -> { type: "ready", id } | { type: "error", id, message }
 *   { type: "classify", id, samples, rate }   -> { type: "score", id, score } | { type: "error", id, message }
 */
/* global Audio */
importScripts("node_modules/@mediapipe/tasks-audio/audio_bundle.js");

const CRY = "Baby cry, infant cry";
const WASM = "node_modules/@mediapipe/tasks-audio/wasm/";
let classifier = null;

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === "load") {
    try {
      if (!classifier) {
        // (the SIMD build only: every browser and Android WebView of the last few years has SIMD)
        const fileset = { wasmLoaderPath: new URL(`${WASM}audio_wasm_internal.js`, self.location.href).href, wasmBinaryPath: new URL(`${WASM}audio_wasm_internal.wasm`, self.location.href).href };
        classifier = await Audio.AudioClassifier.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: new Uint8Array(m.model) },
          categoryAllowlist: [CRY], // (YAMNet's scores are each their own: the others don't change crying's)
          maxResults: 1,
        });
      }
      self.postMessage({ type: "ready", id: m.id });
    } catch (err) {
      self.postMessage({ type: "error", id: m.id, message: String((err && err.message) || err) });
    }
  } else if (m.type === "classify") {
    try {
      let best = 0;
      for (const r of classifier.classify(new Float32Array(m.samples), m.rate || 16000) || []) {
        for (const cl of r.classifications || []) for (const cat of cl.categories || []) if (cat.categoryName === CRY) best = Math.max(best, cat.score);
      }
      self.postMessage({ type: "score", id: m.id, score: best });
    } catch (err) {
      self.postMessage({ type: "error", id: m.id, message: String((err && err.message) || err) });
    }
  }
};
