/**
 * motion-video.js — turns an animation drawn frame by frame (a motion capture recording's
 * playback, in the Recording Viewer) into a video: every frame encoded with WebCodecs
 * (VP8) at its exact time and written to a WebM file, which the video converters then turn
 * into any of the video formats. Nothing is recorded in real time, so no frame is dropped
 * and it runs as fast as the computer can draw and encode.
 *
 *   const blob = await MotionVideo.render({ width, height, fps, frames, draw, onProgress, canceled });
 *     draw(ctx, k)        draws frame k (of `frames`) on a width x height canvas
 *     onProgress(0..1), canceled() -> true to stop (the promise then rejects with .canceled)
 *   MotionVideo.supported()   whether this browser can encode video (WebCodecs VP8)
 */

(function (global) {
  const KEY_EVERY_S = 2;

  function supported() {
    return typeof global.VideoEncoder === "function" && typeof global.VideoFrame === "function";
  }

  // ---------- WebM (Matroska) writing ----------
  // Elements are [id bytes, payload]; sizes are written in the 8-byte form, which every
  // reader accepts, so the file can be assembled in one pass once all frames are known.
  function vintSize(n) {
    const out = new Uint8Array(8);
    out[0] = 0x01;
    let v = n;
    for (let i = 7; i >= 1; i--) {
      out[i] = v % 256;
      v = Math.floor(v / 256);
    }
    return out;
  }
  const concat = (parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  const el = (id, ...payload) => {
    const body = concat(payload);
    return concat([Uint8Array.from(id), vintSize(body.length), body]);
  };
  const uint = (n) => {
    const bytes = [];
    do {
      bytes.unshift(n % 256);
      n = Math.floor(n / 256);
    } while (n > 0);
    return Uint8Array.from(bytes);
  };
  const float64 = (x) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, x);
    return b;
  };
  const text = (s) => new TextEncoder().encode(s);

  // chunks: [{ timeMs, key, data: Uint8Array }] in order.
  function webm({ width, height, durationMs, chunks }) {
    const header = el([0x1a, 0x45, 0xdf, 0xa3],
      el([0x42, 0x86], uint(1)), el([0x42, 0xf7], uint(1)), el([0x42, 0xf2], uint(4)), el([0x42, 0xf3], uint(8)),
      el([0x42, 0x82], text("webm")), el([0x42, 0x87], uint(2)), el([0x42, 0x85], uint(2)));
    const info = el([0x15, 0x49, 0xa9, 0x66],
      el([0x2a, 0xd7, 0xb1], uint(1000000)), // timestamps in milliseconds
      el([0x4d, 0x80], text("Hand Tracker")), el([0x57, 0x41], text("Hand Tracker")),
      el([0x44, 0x89], float64(durationMs)));
    const tracks = el([0x16, 0x54, 0xae, 0x6b],
      el([0xae], el([0xd7], uint(1)), el([0x73, 0xc5], uint(1)), el([0x83], uint(1)), el([0x86], text("V_VP8")),
        el([0xe0], el([0xb0], uint(width)), el([0xba], uint(height)))));
    // A cluster per keyframe (every KEY_EVERY_S), so block times stay within 16 bits.
    const clusters = [];
    let group = null;
    const flush = () => {
      if (!group) return;
      clusters.push(el([0x1f, 0x43, 0xb6, 0x75], el([0xe7], uint(group.start)), ...group.blocks));
      group = null;
    };
    for (const c of chunks) {
      if (!group || c.key || c.timeMs - group.start > 30000) {
        flush();
        group = { start: c.timeMs, blocks: [] };
      }
      const rel = c.timeMs - group.start;
      const head = Uint8Array.from([0x81, (rel >> 8) & 0xff, rel & 0xff, c.key ? 0x80 : 0x00]);
      group.blocks.push(el([0xa3], head, c.data));
    }
    flush();
    const segment = el([0x18, 0x53, 0x80, 0x67], info, tracks, ...clusters);
    return new Blob([header, segment], { type: "video/webm" });
  }

  // ---------- rendering ----------
  async function render({ width, height, fps, frames, draw, onProgress, canceled }) {
    if (!supported()) throw new Error("This browser can't make videos here (it has no WebCodecs video encoder). Use the Windows or Linux app, the Android app, or Chrome or Edge.");
    width = Math.max(2, Math.round(width / 2) * 2);
    height = Math.max(2, Math.round(height / 2) * 2);
    const config = { codec: "vp8", width, height, bitrate: Math.min(16e6, Math.max(2e6, width * height * fps * 0.15)), framerate: fps };
    const support = await global.VideoEncoder.isConfigSupported(config);
    if (!support.supported) throw new Error("This computer can't encode VP8 video here.");
    const canvas = typeof global.OffscreenCanvas === "function" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
    const ctx = canvas.getContext("2d");
    const chunks = [];
    let failure = null;
    const encoder = new global.VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push({ timeMs: Math.round(chunk.timestamp / 1000), key: chunk.type === "key", data });
      },
      error: (err) => (failure = err),
    });
    encoder.configure(config);
    const keyEvery = Math.max(1, Math.round(fps * KEY_EVERY_S));
    try {
      for (let k = 0; k < frames; k++) {
        if (failure) throw failure;
        if (canceled && canceled()) throw Object.assign(new Error("Canceled."), { canceled: true });
        draw(ctx, k);
        const frame = new global.VideoFrame(canvas, { timestamp: Math.round((k * 1e6) / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(frame, { keyFrame: k % keyEvery === 0 });
        frame.close();
        // Let the encoder keep up (and the page stay responsive).
        if (encoder.encodeQueueSize > 4 || k % 15 === 14) {
          await new Promise((r) => setTimeout(r, 0));
          if (onProgress) onProgress(k / frames);
        }
      }
      await encoder.flush();
      if (failure) throw failure;
    } finally {
      if (encoder.state !== "closed") encoder.close();
    }
    if (onProgress) onProgress(1);
    chunks.sort((a, b) => a.timeMs - b.timeMs);
    return webm({ width, height, durationMs: (frames * 1000) / fps, chunks });
  }

  global.MotionVideo = { render, supported };
})(typeof window !== "undefined" ? window : self);
