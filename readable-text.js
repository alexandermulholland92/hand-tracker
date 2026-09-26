/**
 * readable-text.js
 * Keeps text that is part of the camera picture (clock digits, numbers on a
 * screen, signs, printing on clothes) readable when the view is mirrored.
 *
 * Mirroring flips every pixel, so text in the scene would read backwards. A
 * background OCR worker (tesseract.js, bundled locally so it works offline)
 * finds text in the raw, unmirrored camera frame; each found region is then
 * pasted back unflipped at its mirrored position. Hands are never patched, so
 * the skeleton always lines up with the picture.
 *
 * OCR also "reads" text in textures (cloth, shadows, stripes), which used to flip
 * small boxes of the picture for seconds at a time. So a region is only shown once
 * the same place has been read as text in CONFIRMATIONS scans running, with a
 * confident, word-like reading each time: real text stays put, noise doesn't. On
 * frames of real videos without text this showed no false boxes at all (against
 * boxes on screen over 90% of the time before), at the cost of text un-flipping
 * about a second after it appears.
 *
 *   ReadableText.process(sourceEl, stageCanvas, mirrored, hands);  // once per drawn frame
 *   ReadableText.getRegions();  // current text regions (raw pixel coords), for debugging
 */

(function (global) {
  const OCR_INTERVAL_MS = 400; // minimum time between scans; each scan takes ~100-300 ms on a PC worker thread
  const HOLD_MS = 2000;        // keep a region this long after it was last confirmed (OCR confidence varies per frame)
  const MIN_CONFIDENCE = 75;   // tesseract word confidence (0-100); noise mostly reads 60-75
  const MIN_CHARS = 2;         // single characters are mostly noise (edges, corners)
  const CONFIRMATIONS = 3;     // scans in a row that must find text in the same place before it's shown
  const CONFIRM_WINDOW_MS = 1600; // ...each within this long of the last (longer on slow devices)
  const TESSERACT_PATHS = {
    workerPath: "node_modules/tesseract.js/dist/worker.min.js",
    corePath: "node_modules/tesseract.js-core",
    langPath: "node_modules/@tesseract.js-data/eng/4.0.0_best_int",
  };

  let worker = null;
  let workerState = "idle"; // idle | starting | ready | failed
  let busy = false;
  let lastScan = 0;
  let lastScanMs = 0; // how long the previous scan took; slow devices (phones) scan less often
  let regions = []; // { x, y, w, h, seen } — shown
  let candidates = []; // { x, y, w, h, hits, seen, scan } — found, not yet confirmed
  let scanCount = 0;
  let quickScans = 0; // confirming scans run back to back (capped)
  let grabCanvas = null;
  let grabCtx = null;

  async function startWorker() {
    if (workerState !== "idle") return;
    if (!global.Tesseract) {
      workerState = "failed";
      console.warn("readable-text: tesseract.js isn't loaded; mirrored text will read backwards.");
      return;
    }
    workerState = "starting";
    try {
      // Paths must be absolute: the worker resolves them relative to its own URL.
      const abs = (p) => new URL(p, global.location.href).href;
      worker = await global.Tesseract.createWorker("eng", 1, {
        workerPath: abs(TESSERACT_PATHS.workerPath),
        corePath: abs(TESSERACT_PATHS.corePath),
        langPath: abs(TESSERACT_PATHS.langPath),
        workerBlobURL: false,
        cacheMethod: "none",
        // The web bundle (Android app, website) ships the language data uncompressed,
        // because Android's packager un-gzips .gz files; see scripts/build-web.js.
        gzip: !document.querySelector('meta[name="hand-tracker-bundle"]'),
      });
      await worker.setParameters({
        tessedit_pageseg_mode: "11", // sparse text: find scattered words anywhere in the frame
        user_defined_dpi: "96",      // silences "Estimating resolution" warnings
      });
      workerState = "ready";
    } catch (err) {
      workerState = "failed";
      console.warn("readable-text: OCR worker failed to start:", err);
    }
  }

  function scan(source, width, height) {
    busy = true;
    lastScan = performance.now();
    if (!grabCanvas) {
      grabCanvas = document.createElement("canvas");
      grabCtx = grabCanvas.getContext("2d", { willReadFrequently: true });
    }
    if (grabCanvas.width !== width || grabCanvas.height !== height) {
      grabCanvas.width = width;
      grabCanvas.height = height;
    }
    grabCtx.drawImage(source, 0, 0, width, height);
    const started = performance.now();
    worker
      .recognize(grabCanvas, {}, { blocks: true })
      .then(({ data }) => ingest(data, width, height))
      .catch((err) => console.warn("readable-text: scan failed:", err))
      .finally(() => {
        lastScanMs = performance.now() - started;
        busy = false;
      });
  }

  function words(data) {
    const out = [];
    for (const block of data.blocks || [])
      for (const para of block.paragraphs || [])
        for (const line of para.lines || [])
          for (const word of line.words || []) out.push(word);
    return out;
  }

  function overlaps(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  function union(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  }

  // A confident reading that looks like a word or a number, of a plausible size.
  function looksLikeText(word, width, height) {
    const text = (word.text || "").trim();
    const alnum = text.replace(/[^A-Za-z0-9]/g, "");
    if (alnum.length < MIN_CHARS || word.confidence < MIN_CONFIDENCE) return false;
    if (alnum.length / text.replace(/\s/g, "").length < 0.75) return false; // mostly symbols
    if (/^[Il1|iLjJtf!]+$/.test(alnum)) return false; // stripes and edges read as I, l, 1...
    const digits = alnum.replace(/[^0-9]/g, "").length;
    if (Math.min(digits, alnum.length - digits) > 1 && !/\d{1,2}[:.]\d{2}/.test(text)) return false; // letter-digit jumble
    const { x0, y0, x1, y1 } = word.bbox;
    const h = y1 - y0;
    return h >= 6 && h <= height * 0.3 && x1 - x0 <= width * 0.7;
  }

  function ingest(data, width, height, now = performance.now()) {
    const scan = ++scanCount;
    const window = Math.max(CONFIRM_WINDOW_MS, 4 * Math.max(OCR_INTERVAL_MS, lastScanMs * 3));
    candidates = candidates.filter((c) => now - c.seen <= window);
    for (const word of words(data)) {
      if (!looksLikeText(word, width, height)) continue;
      const { x0, y0, x1, y1 } = word.bbox;
      const h = y1 - y0;
      // Pad so neighbouring words (e.g. a clock and its counter) merge into one region.
      const padX = Math.round(h * 0.35);
      const padY = Math.round(h * 0.2);
      let box = { x: Math.max(0, x0 - padX), y: Math.max(0, y0 - padY) };
      box.w = Math.min(width, x1 + padX) - box.x;
      box.h = Math.min(height, y1 + padY) - box.y;

      // Already shown: merge with the regions it touches (keeping the merged area from
      // growing without bound when text moves around).
      const touching = regions.filter((r) => overlaps(r, box));
      if (touching.length) {
        regions = regions.filter((r) => !touching.includes(r));
        let merged = touching.reduce(union, box);
        if (merged.w * merged.h > 4 * box.w * box.h) merged = box;
        regions.push({ ...merged, seen: now });
        continue;
      }
      // New: only shown once the next scans find text there too.
      const cand = candidates.find((c) => overlaps(c, box));
      if (!cand) {
        candidates.push({ ...box, hits: 1, seen: now, scan });
        continue;
      }
      if (cand.scan === scan) continue; // another word of it in this same scan
      let merged = union(cand, box);
      if (merged.w * merged.h > 4 * box.w * box.h) merged = box;
      Object.assign(cand, merged, { hits: cand.hits + 1, seen: now, scan });
      if (cand.hits >= CONFIRMATIONS) {
        candidates = candidates.filter((c) => c !== cand);
        regions.push({ x: cand.x, y: cand.y, w: cand.w, h: cand.h, seen: now });
      }
    }
    regions = regions.filter((r) => now - r.seen <= HOLD_MS);
  }

  // Bounding boxes of the hands (raw pixel coords) with a margin.
  function handBoxes(hands, width, height) {
    return (hands || []).map((hand) => {
      const xs = hand.imageLandmarks.map((p) => p.x * width);
      const ys = hand.imageLandmarks.map((p) => p.y * height);
      const x = Math.min(...xs), y = Math.min(...ys);
      const w = Math.max(...xs) - x, h = Math.max(...ys) - y;
      const m = Math.max(w, h) * 0.15;
      return { x: x - m, y: y - m, w: w + 2 * m, h: h + 2 * m };
    });
  }

  function process(source, canvas, mirrored, hands) {
    if (!mirrored) {
      regions = [];
      candidates = [];
      return;
    }
    const width = canvas.width;
    const height = canvas.height;
    if (!width || !height) return;

    if (workerState === "idle") startWorker();
    // Keep OCR to at most about a third of one core, however slow the device is — except
    // just after the last scan found something that might be text: then up to two
    // confirming scans follow straight away, so real text is shown about a second after
    // it appears (and a busy, textured scene can't keep OCR running flat out).
    const quick = candidates.some((c) => c.scan === scanCount) && quickScans < CONFIRMATIONS - 1;
    const cooldown = quick ? Math.max(OCR_INTERVAL_MS, lastScanMs * 1.2) : Math.max(OCR_INTERVAL_MS, lastScanMs * 3);
    if (workerState === "ready" && !busy && performance.now() - lastScan >= cooldown) {
      quickScans = quick ? quickScans + 1 : 0;
      scan(source, width, height);
    }

    const now = performance.now();
    const avoid = handBoxes(hands, width, height);
    const ctx = canvas.getContext("2d");
    for (const r of regions) {
      if (now - r.seen > HOLD_MS || avoid.some((b) => overlaps(b, r))) continue;
      // Copy the raw (unflipped) pixels to where the mirror put this region.
      ctx.drawImage(source, r.x, r.y, r.w, r.h, width - r.x - r.w, r.y, r.w, r.h);
    }
  }

  global.ReadableText = {
    process,
    getRegions: () => regions.map(({ x, y, w, h }) => ({ x, y, w, h })),
    getStatus: () => workerState,
    clear() {
      regions = [];
      candidates = [];
    },
    // For the checks: feed an OCR result as if a scan had returned it.
    _ingest: ingest,
  };
})(window);
