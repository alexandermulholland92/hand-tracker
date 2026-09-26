/**
 * video-recorder.js
 * Records one or more canvases (stacked top-to-bottom) into a video clip with
 * MediaRecorder. Frames are pushed explicitly, so the recording contains
 * exactly the frames the tracker produced — picture and skeleton always match.
 *
 *   VideoRecorder.start({ sources: [stageCanvas, threeCanvas], fps: 30, preferMp4: false });
 *   VideoRecorder.frame();                    // after each new stage frame is drawn
 *   const clip = await VideoRecorder.stop();  // { blob, mimeType, container, duration, width, height, fps, frames }
 *   everyFrame: true keeps every pushed frame (no fps cap) — used when tracking a video
 *   file, so the clip can later be re-timed to the source frame rate.
 *
 * The browser records WebM (VP9/VP8) where possible; the desktop app converts
 * that master clip to other formats with ffmpeg (see electron/exporter.js).
 */

(function (global) {
  const MIME_CANDIDATES = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4;codecs=avc1",
    "video/mp4",
  ];
  const MAX_PIXELS = 1920 * 1080; // keeps real-time encoding affordable on modest CPUs
  const BITS_PER_PIXEL = 0.2;     // generous: this is a master clip that may be re-encoded
  const BACKGROUND = "#0e0f12";

  let rec = null;

  function isSupported() {
    return typeof global.MediaRecorder !== "undefined" && !!global.HTMLCanvasElement.prototype.captureStream;
  }

  // preferMp4: try H.264/MP4 first (phones, where there is no ffmpeg to convert afterwards).
  function pickMimeType(preferMp4) {
    const order = preferMp4
      ? [...MIME_CANDIDATES.filter((t) => t.includes("mp4")), ...MIME_CANDIDATES.filter((t) => !t.includes("mp4"))]
      : MIME_CANDIDATES;
    return order.find((t) => global.MediaRecorder.isTypeSupported(t)) || "";
  }

  function even(n) {
    return Math.max(2, Math.round(n / 2) * 2); // H.264 / yuv420p need even dimensions
  }

  // Stack sources vertically at the width of the first one, then scale the
  // whole frame down if it would be too large to encode in real time.
  function computeLayout(sources) {
    const width = sources[0].width;
    const heights = sources.map((src) => (src.height / src.width) * width);
    const total = heights.reduce((a, b) => a + b, 0);
    const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (width * total)));
    let y = 0;
    const cells = sources.map((src, i) => {
      const cell = { src, y: Math.round(y * scale), h: Math.round(heights[i] * scale) };
      y += heights[i];
      return cell;
    });
    return { width: even(width * scale), height: even(total * scale), cells };
  }

  // Fit a source inside its cell without distorting it (sources can resize mid-recording).
  function drawContained(ctx, src, x, y, w, h) {
    if (!src.width || !src.height) return;
    const s = Math.min(w / src.width, h / src.height);
    const dw = src.width * s;
    const dh = src.height * s;
    ctx.drawImage(src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  function start({ sources, fps = 30, preferMp4 = false, everyFrame = false }) {
    if (rec) throw new Error("A recording is already in progress.");
    if (!isSupported()) throw new Error("Video recording isn't supported in this browser.");
    const usable = (sources || []).filter((s) => s && s.width > 0 && s.height > 0);
    if (!usable.length) throw new Error("Nothing to record yet — wait for the camera to start.");

    const layout = computeLayout(usable);
    const canvas = document.createElement("canvas");
    canvas.width = layout.width;
    canvas.height = layout.height;
    const ctx = canvas.getContext("2d");

    const stream = canvas.captureStream(0); // 0 = only capture when frame() asks
    const track = stream.getVideoTracks()[0];
    const mimeType = pickMimeType(preferMp4);
    const videoBitsPerSecond = Math.round(
      Math.min(16e6, Math.max(2e6, layout.width * layout.height * fps * BITS_PER_PIXEL))
    );
    const recorder = new global.MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond } : { videoBitsPerSecond });
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };

    rec = {
      canvas, ctx, layout, track, recorder, chunks, fps,
      mimeType: recorder.mimeType || mimeType || "video/webm",
      startedAt: performance.now(),
      lastFrameAt: -Infinity,
      everyFrame,
      frames: 0,
    };
    recorder.start(1000); // flush data every second rather than holding it all until stop
    frame();
  }

  function frame() {
    if (!rec) return;
    const now = performance.now();
    // Cap at the target fps even if the camera runs faster.
    if (!rec.everyFrame && now - rec.lastFrameAt < 1000 / rec.fps - 2) return;
    rec.lastFrameAt = now;
    rec.frames++;

    const { ctx, layout } = rec;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, layout.width, layout.height);
    for (const cell of layout.cells) drawContained(ctx, cell.src, 0, cell.y, layout.width, cell.h);
    if (rec.track.requestFrame) rec.track.requestFrame();
  }

  function stop() {
    if (!rec) return Promise.resolve(null);
    const r = rec;
    rec = null;
    const duration = (performance.now() - r.startedAt) / 1000;

    return new Promise((resolve, reject) => {
      r.recorder.onstop = () => {
        r.track.stop();
        const type = r.mimeType.split(";")[0];
        resolve({
          blob: new Blob(r.chunks, { type }),
          mimeType: r.mimeType,
          container: type.includes("mp4") ? "mp4" : "webm",
          duration,
          width: r.layout.width,
          height: r.layout.height,
          fps: r.fps,
          frames: r.frames,
        });
      };
      r.recorder.onerror = (e) => reject(e.error || new Error("Recording failed."));
      r.recorder.stop();
    });
  }

  global.VideoRecorder = {
    start,
    stop,
    frame,
    isSupported,
    isRecording: () => !!rec,
    elapsed: () => (rec ? (performance.now() - rec.startedAt) / 1000 : 0),
  };
})(window);
