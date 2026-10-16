/**
 * kinect-view.js — a Kinect's pictures in its tile of "Several cameras" (camera-tile.js): where
 * each part of the picture is (its depth map: millimetres for each part of the picture, from
 * the helper), the depth as colours, and the views a tile shows: the picture, the depth, the two
 * laid over each other, or side by side. Also the microphones: where the sound comes from, drawn
 * over the picture.
 *
 *   const v = KinectView.create();
 *   v.frame(header, depthBytes)            // a frame's depth map and its camera's parameters
 *   v.at3d(u, v)                           // -> [x, y, z] mm (x right, y down, z ahead) at that
 *                                          //    point of the (unturned) picture, or null
 *   v.picture(bitmap, view)                // -> { image, side } for HandTracker.drawExternalPicture
 *                                          //    (view: "color" | "depth" | "blend" | "side")
 *   KinectView.unturn(u, v, rotation)      // a point of the turned picture in the unturned one
 *   KinectView.drawSound(ctx, audio, w, h, unit)   // the sound's direction and loudness
 */

(function (global) {
  const NEAR = 500, FAR = 4500; // the depth colours' range, mm

  // Colours for depth: near red, through yellow and green, to far blue (a turbo-like ramp);
  // nothing there, black.
  const RAMP = (() => {
    const stops = [[0, [255, 40, 40]], [0.25, [255, 200, 40]], [0.5, [80, 220, 80]], [0.75, [40, 170, 255]], [1, [60, 60, 200]]];
    const out = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let k = 0;
      while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
      const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
      const f = (t - t0) / (t1 - t0);
      for (let c = 0; c < 3; c++) out[i * 3 + c] = c0[c] + (c1[c] - c0[c]) * f;
    }
    return out;
  })();

  function unturn(u, v, rotation) {
    if (rotation === 90) return [v, 1 - u];
    if (rotation === 180) return [1 - u, 1 - v];
    if (rotation === 270) return [1 - v, u];
    return [u, v];
  }

  function create() {
    let map = null, mw = 0, mh = 0, intr = null, colored = null, coloredFor = null;
    const depthCanvas = document.createElement("canvas");
    const out = document.createElement("canvas");

    function frame(header, bytes) {
      if (!header || !header.map || !bytes || !bytes.byteLength) return;
      const m = header.map;
      const n = m.w * m.h;
      if (bytes.byteLength < n * 2) return;
      map = new Uint16Array(bytes.buffer, bytes.byteOffset, n);
      if (bytes.byteOffset % 2) map = new Uint16Array(new Uint8Array(bytes).buffer, 0, n);
      mw = m.w;
      mh = m.h;
      intr = m;
    }

    // The depth at a point: the middle of the nearest readings in a little square around it
    // (a reading can be missing at an edge).
    function depthAt(u, v) {
      if (!map) return 0;
      const cx = Math.round(u * mw - 0.5), cy = Math.round(v * mh - 0.5);
      const vals = [];
      for (let r = 0; r <= 3 && vals.length < 5; r++) {
        for (let y = cy - r; y <= cy + r; y++) {
          if (y < 0 || y >= mh) continue;
          for (let x = cx - r; x <= cx + r; x++) {
            if (x < 0 || x >= mw || (Math.abs(x - cx) !== r && Math.abs(y - cy) !== r)) continue;
            const d = map[y * mw + x];
            if (d > 0) vals.push(d);
          }
        }
      }
      if (!vals.length) return 0;
      vals.sort((a, b) => a - b);
      return vals[vals.length >> 1];
    }

    function at3d(u, v) {
      if (!intr || !Number.isFinite(u) || !Number.isFinite(v)) return null;
      const z = depthAt(u, v);
      if (!z) return null;
      const px = u * mw - 0.5, py = v * mh - 0.5;
      return [Math.round(((px - intr.cx) * z) / intr.fx), Math.round(((py - intr.cy) * z) / intr.fy), z];
    }

    function depthPicture() {
      if (!map) return null;
      if (coloredFor === map) return depthCanvas;
      if (depthCanvas.width !== mw || depthCanvas.height !== mh) {
        depthCanvas.width = mw;
        depthCanvas.height = mh;
        colored = null;
      }
      const ctx = depthCanvas.getContext("2d");
      if (!colored) colored = ctx.createImageData(mw, mh);
      const px = colored.data;
      for (let i = 0; i < mw * mh; i++) {
        const d = map[i];
        if (!d) {
          px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 0;
        } else {
          const k = Math.max(0, Math.min(255, Math.round(((d - NEAR) / (FAR - NEAR)) * 255))) * 3;
          px[i * 4] = RAMP[k];
          px[i * 4 + 1] = RAMP[k + 1];
          px[i * 4 + 2] = RAMP[k + 2];
        }
        px[i * 4 + 3] = 255;
      }
      ctx.putImageData(colored, 0, 0);
      coloredFor = map;
      return depthCanvas;
    }

    // What the tile shows, the picture's size (or twice as wide, side by side).
    function picture(bitmap, view) {
      const w = bitmap.width, h = bitmap.height;
      const depth = view === "color" ? null : depthPicture();
      if (!depth) return { image: bitmap, side: false };
      const side = view === "side";
      if (out.width !== (side ? w * 2 : w) || out.height !== h) {
        out.width = side ? w * 2 : w;
        out.height = h;
      }
      const ctx = out.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      if (view === "depth") ctx.drawImage(depth, 0, 0, w, h);
      else if (view === "blend") {
        ctx.drawImage(bitmap, 0, 0, w, h);
        ctx.globalAlpha = 0.5;
        ctx.drawImage(depth, 0, 0, w, h);
        ctx.globalAlpha = 1;
      } else {
        ctx.drawImage(bitmap, 0, 0, w, h);
        ctx.drawImage(depth, w, 0, w, h);
      }
      return { image: out, side };
    }

    return { frame, at3d, depthAt, picture, hasDepth: () => !!map };
  }

  // Where the loudest sound comes from (roughly: the Kinect's microphone array, turned to the
  // picture as seen), and how loud it is, at the picture's top.
  function drawSound(ctx, audio, w, h, unit = 1, mirrored = false) {
    if (!audio || !Array.isArray(audio.level)) return;
    const level = Math.max(...audio.level.map((v) => Number(v) || 0));
    const db = level > 0 ? 20 * Math.log10(level) : -100;
    const loud = Math.max(0, Math.min(1, (db + 70) / 50)); // -70 dB quiet, -20 dB loud
    const cx = w / 2, cy = 8 * unit, r = 34 * unit;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.beginPath();
    ctx.moveTo(cx - r, cy);
    ctx.arc(cx, cy, r, 0, Math.PI);
    ctx.closePath();
    ctx.fill();
    // The angle: 0 straight ahead, positive to the camera's right (as the picture shows it, unless mirrored).
    if (Number.isFinite(audio.angle) && (audio.confidence || 0) > 0.2 && loud > 0.15) {
      const a = (((mirrored ? -1 : 1) * audio.angle) * Math.PI) / 180;
      ctx.strokeStyle = "#ffd43b";
      ctx.lineWidth = 3 * unit;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.sin(a) * r * 0.95, cy + Math.cos(a) * r * 0.95);
      ctx.stroke();
    }
    ctx.fillStyle = "#51cf66";
    ctx.fillRect(cx - r, cy + r + 3 * unit, 2 * r * loud, 3 * unit);
    ctx.restore();
  }

  global.KinectView = { create, unturn, drawSound, NEAR, FAR };
})(window);
