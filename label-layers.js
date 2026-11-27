/**
 * label-layers.js — a camera's picture recorded clean, with what's drawn over it (the labels) kept as shapes
 * beside it, for label-ass.js to make subtitle tracks of (the user, 2026-11-26: "make the labels able to be a
 * separate layer of the video so you can watch them later either baked in or not baked into the video").
 *
 * The stage canvas is drawn a frame at a time: hand-tracker.js's drawStage clears it, draws the picture, then the
 * skeleton; then the page draws each hand's tag and box, a Kinect's bodies, objects found (stage-overlay.js,
 * body-tracker.js, …). Once attached, the canvas's own drawing context notes each shape drawn after the picture
 * (in the picture's pixels, through the transform then), and a clean copy of the picture is kept (taken just
 * after it's drawn; any picture drawn over it after, as readable text's, is drawn on the copy too).
 *
 *   const cap = LabelLayers.attach(stage)        // once per canvas (the same one again after)
 *   LabelLayers.of(stage)                         // the one attached, or null (hand-tracker.js asks each frame)
 *   cap.begin() / cap.picture()                   // (hand-tracker.js) before the picture is drawn, and just after
 *   LabelLayers.category(stage, "objects")        // what's drawn next: objects found ("hands", the rest, after)
 *   cap.current()                                 // this frame's so far: { t, w, h, shapes }
 *   cap.use() / cap.release()                     // keep the clean copy and the shapes (while recording)
 *   cap.clean                                     // the clean copy (a canvas the size of the stage)
 *
 *   LabelLayers.ready(sink)                       // whether this app can (asked once; pages ask as they start)
 *   const rec = LabelLayers.record(stage, sink)   // a clip's labels, sent on as subtitle lines while it records:
 *     sink = { open() -> id, write(id, { hands, objects }), close(id, { width, height }), discard(id) } (the desktop
 *     app's remote.labels); rec.canvas: the clean picture to record; await rec.stop() -> its id; rec.discard().
 *
 * Phones keep their labels drawn in (no ffmpeg there to put tracks in a video): nothing here is used there.
 */
(function (global) {
  const TAU = Math.PI * 2;

  // ---------- colours: a canvas's CSS colour as ASS's &HBBGGRR& and alpha &HAA& ----------
  let normCtx = null;
  const colours = new Map();
  function colour(css, globalAlpha = 1) {
    if (typeof css !== "string") return null; // (a gradient or pattern: left out)
    let c = colours.get(css);
    if (!c) {
      if (!normCtx) normCtx = document.createElement("canvas").getContext("2d");
      normCtx.fillStyle = "#000";
      normCtx.fillStyle = css;
      const v = String(normCtx.fillStyle);
      let r = 0, g = 0, b = 0, a = 1;
      let m;
      if ((m = /^#([0-9a-f]{6})$/i.exec(v))) [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
      else if ((m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v))) {
        [r, g, b] = [m[1], m[2], m[3]].map((x) => Math.round(Number(x)));
        a = m[4] === undefined ? 1 : Number(m[4]);
      }
      const hex = (n) => Math.max(0, Math.min(255, n)).toString(16).toUpperCase().padStart(2, "0");
      c = { col: `&H${hex(b)}${hex(g)}${hex(r)}&`, alpha: a };
      if (colours.size > 500) colours.clear();
      colours.set(css, c);
    }
    const ga = Math.max(0, Math.min(1, Number(globalAlpha)));
    const a = Math.round((1 - c.alpha * (Number.isFinite(ga) ? ga : 1)) * 255);
    return { col: c.col, a: `&H${Math.max(0, Math.min(255, a)).toString(16).toUpperCase().padStart(2, "0")}&` };
  }

  // ---------- Path2D: its pieces noted (in its own coordinates) while any capture is in use ----------
  // (MediaPipe draws each hand's points as Path2D circles: fill(path), stroke(path).) The canvas's own window's
  // (a camera's tile is a page of its own, in a frame).
  const PIECES = Symbol("labelPieces");
  function notePath2D(win) {
    const P = win && win.Path2D && win.Path2D.prototype;
    if (!P || P.__labelLayers) return;
    P.__labelLayers = true;
    const wrap = (name, note) => {
      const orig = P[name];
      if (typeof orig !== "function") return;
      P[name] = function (...args) {
        if ((win.__labelLayersUsers || 0) > 0) {
          if (!this[PIECES]) this[PIECES] = [];
          note(this[PIECES], args);
        }
        return orig.apply(this, args);
      };
    };
    wrap("moveTo", (p, [x, y]) => p.push({ m: [x, y] }));
    wrap("lineTo", (p, [x, y]) => p.push({ l: [x, y] }));
    wrap("closePath", (p) => p.push({ z: true }));
    wrap("rect", (p, a) => p.push({ rect: a.slice(0, 4) }));
    wrap("arc", (p, a) => p.push({ arc: a.slice(0, 6) }));
    wrap("ellipse", (p, a) => p.push({ ellipse: a.slice(0, 8) }));
  }

  // ---------- one canvas ----------
  function create(canvas) {
    const ctx = canvas.getContext("2d");
    const cap = { canvas, clean: null, shown: 0 };
    // (its window's captures in use: Path2D's pieces are noted only then)
    const win = (canvas.ownerDocument && canvas.ownerDocument.defaultView) || global;
    const users = (d) => (win.__labelLayersUsers = Math.max(0, (win.__labelLayersUsers || 0) + d));
    let using = 0;
    let phase = "idle"; // "picture": the picture's being drawn; "overlay": what's drawn over it
    let cat = "hands";
    let frame = null; // { t, w, h, shapes }
    let subs = []; // the path being made: [{ pts: [x, y, …] (picture pixels), closed, circle: { x, y, r } }]
    const listeners = new Set();
    let cleanCtx = null;
    const active = () => using > 0 || listeners.size > 0;

    // The transform now, as a function of a point; how much it scales; whether it flips; its turn (degrees).
    const tf = () => {
      const m = ctx.getTransform();
      const det = m.a * m.d - m.b * m.c;
      return { at: (x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f], k: Math.sqrt(Math.abs(det)) || 1, flip: det < 0, rot: (Math.atan2(m.b, m.a) * 180) / Math.PI };
    };
    const cur = () => {
      if (!subs.length) subs.push({ pts: [], closed: false });
      return subs[subs.length - 1];
    };
    // An arc's points (picture pixels), from a0 to a1 (radians), every 12° or so.
    const arcPts = (T, x, y, rx, ry, rotation, a0, a1, ccw) => {
      let sweep = a1 - a0;
      if (!ccw && sweep < 0) sweep = (sweep % TAU) + TAU;
      if (ccw && sweep > 0) sweep = (sweep % TAU) - TAU;
      if (Math.abs(a1 - a0) >= TAU - 1e-9) sweep = ccw ? -TAU : TAU;
      const n = Math.max(2, Math.ceil(Math.abs(sweep) / (TAU / 30)));
      const cos = Math.cos(rotation), sin = Math.sin(rotation);
      const out = [];
      for (let i = 0; i <= n; i++) {
        const a = a0 + (sweep * i) / n;
        const px = rx * Math.cos(a), py = ry * Math.sin(a);
        out.push(...T.at(x + px * cos - py * sin, y + px * sin + py * cos));
      }
      return out;
    };
    const fullCircle = (r0, r1, a0, a1) => Math.abs(r0 - r1) < 1e-6 && Math.abs(a1 - a0) >= TAU - 1e-6;
    const addArc = (T, list, x, y, rx, ry, rot, a0, a1, ccw) => {
      if (fullCircle(rx, ry, a0, a1)) {
        const [cx, cy] = T.at(x, y);
        list.push({ circle: { x: cx, y: cy, r: rx * T.k }, pts: [], closed: true });
        list.push({ pts: [], closed: false });
        return;
      }
      const pts = arcPts(T, x, y, rx, ry, rot, a0, a1, ccw);
      if (!list.length || list[list.length - 1].circle) list.push({ pts: [], closed: false });
      list[list.length - 1].pts.push(...pts);
    };
    const rectSub = (T, x, y, w, h) => ({ pts: [...T.at(x, y), ...T.at(x + w, y), ...T.at(x + w, y + h), ...T.at(x, y + h)], closed: true });
    // A Path2D's pieces as sub-paths, through the transform now.
    function fromPath2D(path) {
      const pieces = path && path[PIECES];
      if (!pieces) return null;
      const T = tf();
      const list = [];
      for (const p of pieces) {
        if (p.m) list.push({ pts: [...T.at(p.m[0], p.m[1])], closed: false });
        else if (p.l) {
          if (!list.length) list.push({ pts: [], closed: false });
          list[list.length - 1].pts.push(...T.at(p.l[0], p.l[1]));
        } else if (p.z && list.length) list[list.length - 1].closed = true;
        else if (p.rect) list.push(rectSub(T, ...p.rect));
        else if (p.arc) addArc(T, list, p.arc[0], p.arc[1], p.arc[2], p.arc[2], 0, p.arc[3], p.arc[4], !!p.arc[5]);
        else if (p.ellipse) addArc(T, list, p.ellipse[0], p.ellipse[1], p.ellipse[2], p.ellipse[3], p.ellipse[4], p.ellipse[5], p.ellipse[6], !!p.ellipse[7]);
      }
      return list;
    }

    const push = (s) => {
      if (frame && frame.shapes.length < 4000) frame.shapes.push({ ...s, c: cat });
      return frame ? frame.shapes[frame.shapes.length - 1] : null;
    };
    // The circles just filled (their dots, by where they are), for a stroke of the same circles straight after.
    let lastDots = new Map();
    const where = (o) => `${o.x.toFixed(1)},${o.y.toFixed(1)},${o.r.toFixed(2)}`;
    function filled(list) {
      const c = colour(ctx.fillStyle, ctx.globalAlpha);
      lastDots = new Map();
      if (!c) return;
      const polys = [];
      for (const s of list) {
        if (s.circle) lastDots.set(where(s.circle), push({ k: "dot", x: s.circle.x, y: s.circle.y, r: s.circle.r, ...c }));
        else if (s.pts.length >= 6) polys.push(s.pts.slice());
      }
      if (polys.length) push({ k: "fill", polys, ...c });
    }
    function stroked(list) {
      const c = colour(ctx.strokeStyle, ctx.globalAlpha);
      const dots = lastDots;
      lastDots = new Map();
      if (!c) return;
      const w = ctx.lineWidth * tf().k;
      for (const s of list) {
        if (s.circle) {
          // A circle filled and outlined in one colour (MediaPipe's points) is one bigger dot; else a ring.
          const dot = dots.get(where(s.circle));
          if (dot && dot.col === c.col && dot.a === c.a) dot.r = s.circle.r + w / 2;
          else push({ k: "ring", x: s.circle.x, y: s.circle.y, r: s.circle.r, w, ...c });
        } else if (s.pts.length >= 4) push({ k: "line", pts: s.pts.slice(), closed: !!s.closed, w, ...c });
      }
    }
    // Text: where it's anchored (ASS's \an: 1-3 bottom, 4-6 middle, 7-9 top; left, centre, right).
    function text(str, x, y, outline) {
      const font = String(ctx.font || "10px sans-serif");
      const size = Number((/(\d+(?:\.\d+)?)px/.exec(font) || [])[1]) || 10;
      const bold = /\bbold\b|\b[6-9]00\b/.test(font);
      const align = ctx.textAlign, base = ctx.textBaseline;
      const col = align === "center" ? 2 : align === "right" || align === "end" ? 3 : 1;
      const row = base === "top" || base === "hanging" ? 2 : base === "middle" ? 1 : 0;
      const yy = base === "alphabetic" || base === "ideographic" ? y + size * 0.21 : y;
      const T = tf();
      const [px, py] = T.at(x, yy);
      const fill = outline ? null : colour(ctx.fillStyle, ctx.globalAlpha);
      const line = outline ? colour(ctx.strokeStyle, ctx.globalAlpha) : null;
      if (!fill && !line) return;
      const s = { k: "text", x: px, y: py, size: size * T.k, bold, an: row * 3 + col, text: String(str), rot: Math.abs(T.rot) > 0.5 ? -T.rot : 0, flip: T.flip };
      if (fill) Object.assign(s, { col: fill.col, a: fill.a });
      else Object.assign(s, { col: "&H000000&", a: "&HFF&", ow: ctx.lineWidth * T.k, ocol: line.col, oa: line.a });
      push(s);
    }
    // A picture drawn over the picture (readable text's patches): the clean copy gets it too.
    function overPicture(fn) {
      if (!cleanCtx) return;
      try {
        cleanCtx.save();
        cleanCtx.setTransform(ctx.getTransform());
        cleanCtx.globalAlpha = ctx.globalAlpha;
        fn(cleanCtx);
      } catch {
        // (a picture that can't be drawn there)
      } finally {
        cleanCtx.restore();
      }
    }

    // The drawing context's own methods, noting what's drawn over the picture (only while in use).
    const note = {
      beginPath: () => (subs = []),
      moveTo: (x, y) => subs.push({ pts: [...tf().at(x, y)], closed: false }),
      lineTo: (x, y) => cur().pts.push(...tf().at(x, y)),
      closePath: () => {
        const s = cur();
        s.closed = true;
        if (s.pts.length >= 2) subs.push({ pts: s.pts.slice(0, 2), closed: false });
      },
      rect: (x, y, w, h) => subs.push(rectSub(tf(), x, y, w, h)),
      roundRect: (x, y, w, h, radii) => {
        const r = Math.max(0, Math.min(Math.abs(w) / 2, Math.abs(h) / 2, Number(Array.isArray(radii) ? radii[0] : radii) || 0));
        if (!r) return subs.push(rectSub(tf(), x, y, w, h));
        const T = tf();
        const pts = [
          ...arcPts(T, x + w - r, y + r, r, r, 0, -Math.PI / 2, 0, false), ...arcPts(T, x + w - r, y + h - r, r, r, 0, 0, Math.PI / 2, false),
          ...arcPts(T, x + r, y + h - r, r, r, 0, Math.PI / 2, Math.PI, false), ...arcPts(T, x + r, y + r, r, r, 0, Math.PI, Math.PI * 1.5, false),
        ];
        subs.push({ pts, closed: true });
      },
      arc: (x, y, r, a0, a1, ccw) => addArc(tf(), subs, x, y, r, r, 0, a0, a1, !!ccw),
      ellipse: (x, y, rx, ry, rot, a0, a1, ccw) => addArc(tf(), subs, x, y, rx, ry, rot, a0, a1, !!ccw),
      arcTo: (x1, y1) => cur().pts.push(...tf().at(x1, y1)),
      quadraticCurveTo: (cx, cy, x, y) => cur().pts.push(...tf().at(cx, cy), ...tf().at(x, y)),
      bezierCurveTo: (c1x, c1y, c2x, c2y, x, y) => cur().pts.push(...tf().at(c1x, c1y), ...tf().at(c2x, c2y), ...tf().at(x, y)),
      fill: (a) => filled(a && typeof a === "object" ? fromPath2D(a) || [] : subs),
      stroke: (a) => stroked(a && typeof a === "object" ? fromPath2D(a) || [] : subs),
      fillRect: (x, y, w, h) => filled([rectSub(tf(), x, y, w, h)]),
      strokeRect: (x, y, w, h) => stroked([rectSub(tf(), x, y, w, h)]),
      fillText: (t, x, y) => text(t, x, y, false),
      strokeText: (t, x, y) => text(t, x, y, true),
      drawImage: (...a) => overPicture((c) => c.drawImage(...a)),
      putImageData: (...a) => {
        if (cleanCtx) cleanCtx.putImageData(...a);
      },
    };
    for (const name of Object.keys(note)) {
      const orig = ctx[name];
      if (typeof orig !== "function") continue;
      ctx[name] = function (...args) {
        if (phase === "overlay" && active()) {
          try {
            note[name](...args);
          } catch {
            // (noting never stops the drawing)
          }
        }
        return orig.apply(ctx, args);
      };
    }

    function end(at) {
      const f = frame;
      frame = null;
      if (!f) return;
      f.end = at;
      for (const fn of listeners) {
        try {
          fn(f);
        } catch {
          // (one listener's trouble isn't the others')
        }
      }
    }
    cap.begin = () => {
      if (!active()) return;
      end(performance.now());
      phase = "picture";
    };
    cap.picture = () => {
      if (!active()) {
        phase = "idle";
        return;
      }
      phase = "overlay";
      cat = "hands";
      subs = [];
      frame = { t: performance.now(), w: canvas.width, h: canvas.height, shapes: [] };
      if (using > 0) {
        if (!cap.clean) {
          cap.clean = document.createElement("canvas");
          cleanCtx = cap.clean.getContext("2d");
        }
        if (cap.clean.width !== canvas.width || cap.clean.height !== canvas.height) {
          cap.clean.width = canvas.width;
          cap.clean.height = canvas.height;
        }
        cleanCtx.drawImage(canvas, 0, 0);
        cap.shown++;
      }
    };
    cap.category = (name) => (cat = name === "objects" ? "objects" : "hands");
    cap.current = () => frame;
    cap.use = () => {
      using++;
      users(1);
      notePath2D(win);
      // (a clean copy at once, so a recording started now has a picture before the next frame)
      if (!cap.clean) {
        cap.clean = document.createElement("canvas");
        cleanCtx = cap.clean.getContext("2d");
      }
      if (cap.clean.width !== canvas.width || cap.clean.height !== canvas.height) {
        cap.clean.width = canvas.width;
        cap.clean.height = canvas.height;
      }
      return cap.clean;
    };
    cap.release = () => {
      if (using > 0) {
        using--;
        users(-1);
      }
      if (!active()) {
        frame = null;
        phase = "idle";
      }
    };
    cap.listen = (fn) => {
      listeners.add(fn);
      users(1);
      notePath2D(win);
      return () => {
        if (listeners.delete(fn)) users(-1);
      };
    };
    cap.flush = () => end(performance.now());
    return cap;
  }

  function attach(canvas) {
    if (!canvas || typeof canvas.getContext !== "function") return null;
    if (!canvas.__labelLayers) canvas.__labelLayers = create(canvas);
    return canvas.__labelLayers;
  }
  const of = (canvas) => (canvas && canvas.__labelLayers) || null;
  const category = (canvas, name) => {
    const c = of(canvas);
    if (c) c.category(name);
  };

  // Whether this app can make the layer (the desktop app with its ffmpeg): asked once (pages ask early, as they
  // start: LabelLayers.ready(sink)); not until it's known.
  let can = null;
  function ready(sink) {
    if (!sink || typeof sink.available !== "function") return false;
    if (can === null) {
      can = false;
      Promise.resolve()
        .then(() => sink.available())
        .then((v) => (can = !!v))
        .catch(() => (can = false));
    }
    return can;
  }

  // ---------- a clip's labels, sent on while it records ----------
  // sink: the desktop app's remote.labels. Each frame's lines go when the next frame starts (that's when its
  // picture stops showing); written a second at a time. -> null where it can't be (a phone: the picture is recorded
  // as drawn, labels and all).
  function record(canvas, sink) {
    const cap = attach(canvas);
    if (!cap || !sink || !global.LabelAss || !ready(sink)) return null;
    const clean = cap.use();
    const width = clean.width, height = clean.height;
    const t0 = performance.now();
    let id = null, failed = false, stopped = false;
    const opening = Promise.resolve().then(() => sink.open()).then((v) => (id = v)).catch(() => (failed = true));
    let buf = { hands: [], objects: [] };
    let writing = Promise.resolve();
    const send = () => {
      if (failed || (!buf.hands.length && !buf.objects.length)) return writing;
      const out = { hands: buf.hands.join("\n"), objects: buf.objects.join("\n") };
      buf = { hands: [], objects: [] };
      writing = writing.then(() => opening).then(() => (failed || id === null ? null : sink.write(id, out))).catch(() => (failed = true));
      return writing;
    };
    // A frame's lines just like the one before (nothing moved) make that one's last longer, rather than lines of
    // their own: { key, lines, start, end } for each kind, sent once something changes.
    const pend = { hands: null, objects: null };
    const flushPending = () => {
      for (const c of ["hands", "objects"]) {
        const p = pend[c];
        if (p && p.lines.length) buf[c].push(...global.LabelAss.retime(p.lines, p.start, p.end));
        pend[c] = null;
      }
    };
    const off = cap.listen((f) => {
      if (stopped) return;
      const start = Math.max(0, (f.t - t0) / 1000), end = Math.max(start + 0.01, (f.end - t0) / 1000);
      const lines = global.LabelAss.frameLines(f.shapes, 0, 1, { w: f.w, h: f.h, width, height });
      for (const c of ["hands", "objects"]) {
        const key = lines[c].join("\n");
        const p = pend[c];
        if (p && p.key === key) {
          p.end = end;
          continue;
        }
        if (p && p.lines.length) buf[c].push(...global.LabelAss.retime(p.lines, p.start, p.end));
        pend[c] = { key, lines: lines[c], start, end };
      }
    });
    const timer = setInterval(send, 1000);
    const finish = () => {
      stopped = true;
      off();
      clearInterval(timer);
      cap.release();
    };
    return {
      canvas: clean,
      width, height,
      async stop() {
        if (stopped) return id;
        cap.flush();
        finish();
        flushPending();
        await send();
        await opening;
        if (failed || id === null) return null;
        await sink.close(id, { width, height });
        return id;
      },
      async discard() {
        if (!stopped) finish();
        await opening;
        if (id !== null) await Promise.resolve(sink.discard(id)).catch(() => {});
      },
    };
  }

  global.LabelLayers = { attach, of, category, record, ready, colour };
})(typeof window !== "undefined" ? window : globalThis);
