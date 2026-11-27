/**
 * label-ass.js — a video's labels as subtitle tracks (ASS: Advanced SubStation Alpha), so a player can
 * switch them on and off over the clean picture, and ffmpeg can draw them in for the labelled copy
 * (the user, 2026-11-26: "make the labels able to be a separate layer of the video"). The same in the
 * page (label-layers.js makes each frame's lines) and in the desktop app (electron/label-layers.js puts
 * the tracks together, moves them into a grid, adds the steps).
 *
 * Tracks (each a whole ASS file, in a .mkv): All labels, Hand points (the skeleton, each hand's tag and box,
 * a Kinect's bodies and sound, far-away mode's square: everything drawn on the picture but objects found),
 * Sentry's boxes (the objects an OAK camera finds), Steps (Annotate's steps, all but rejected ones; those not
 * yet reviewed marked "?"), and in a grid, Camera names.
 *
 *   LabelAss.TRACKS                                  // { all, hands, objects, steps, names }: the tracks' titles
 *   LabelAss.frameLines(shapes, start, end, size)    // one frame's shapes (label-layers.js) -> { hands: [lines], objects: [lines] }
 *                                                    //   size: { w, h } the shapes' picture, scaled to the track's own
 *                                                    //   { width, height } (its PlayRes)
 *   LabelAss.file(lines, { width, height, font })    // a whole ASS file of those lines (font: its styles' family)
 *   LabelAss.parse(text)                             // -> { width, height, lines } (one of these files read back)
 *   LabelAss.move(lines, { scale, dx, dy, shift, length, clip }) // into another picture: scaled, moved, later
 *                                                    //   (shift s), cut to [0, length] and to clip [x0, y0, x1, y1]
 *   LabelAss.stepLines(annotations, { shift, width, height, length })  // the Steps track's lines (shift: the
 *                                                    //   steps' video's start in this one's time)
 *   LabelAss.nameLines(names, { width, height, length })   // the Camera names track ([{ x, y, text }]: corners)
 *   LabelAss.merge(...lists)                         // several tracks' lines as one (All labels), in time order
 *   LabelAss.retime(lines, start, end)               // the same lines, shown from start to end instead
 *   LabelAss.time(s) / LabelAss.seconds("0:00:01.50")
 *
 * A shape (label-layers.js, in the picture's pixels, colours already ASS's): { k: "line", c, pts, closed, w,
 * col, a } (stroked), { k: "fill", c, polys, col, a }, { k: "dot", c, x, y, r, col, a } (a filled circle),
 * { k: "ring", c, x, y, r, w, col, a } (a circle's outline), { k: "text", c, x, y, size, bold, an, text, col, a, rot,
 * flip, ow, ocol, oa }.
 * c is the category ("hands" | "objects"); col an ASS colour "&HBBGGRR&", a an alpha "&HAA&" (00 opaque).
 */
(function (global) {
  const TRACKS = { all: "All labels", hands: "Hand points", objects: "Sentry's boxes", steps: "Steps", names: "Camera names" };
  const FONT = "Arial"; // (the styles' font: the desktop app says which one it has, and puts it beside the tracks)

  const pad = (n, d = 2) => String(n).padStart(d, "0");
  function time(s) {
    const cs = Math.max(0, Math.round(Number(s) * 100) || 0);
    return `${Math.floor(cs / 360000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
  }
  function seconds(t) {
    const m = /^(\d+):(\d\d):(\d\d)[.,](\d\d)$/.exec(String(t).trim());
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100 : 0;
  }
  // A number in a drawing: half pixels (\p2), whole.
  const half = (v) => String(Math.round(v * 2));
  const px = (v) => String(Math.round(v * 10) / 10);
  // Text can't hold { } or a line break of its own; \N is ASS's.
  const plain = (t) => String(t || "").replace(/[{}\\]/g, "").replace(/\r?\n/g, "\\N").slice(0, 300);
  const dialogue = (layer, start, end, style, text) => `Dialogue: ${layer},${time(start)},${time(end)},${style},,0,0,0,,${text}`;

  // ---------- one frame ----------
  // Shapes of one look (a kind, colour, alpha and width) are one line: a drawing of several pieces; the lines
  // keep the order things were drawn in (each its own layer, so later ones are on top). A line is drawn as its
  // outline (\bord, half its width, round ends) around a shape with no area; a dot likewise around a speck.
  function frameLines(shapes, start, end, size = {}) {
    const out = { hands: [], objects: [] };
    if (!Array.isArray(shapes) || !shapes.length || !(end > start)) return out;
    const sx = size.w && size.width ? size.width / size.w : 1, sy = size.h && size.height ? size.height / size.h : sx;
    const k = (sx + sy) / 2;
    const groups = new Map();
    let layer = 0;
    const group = (key, c, make) => {
      let g = groups.get(key);
      if (!g) {
        g = { c, layer: layer++, head: make(), parts: [] };
        groups.set(key, g);
      }
      return g;
    };
    for (const s of shapes) {
      const c = s.c === "objects" ? "objects" : "hands";
      if (s.k === "line" && Array.isArray(s.pts) && s.pts.length >= 4) {
        const w = Math.max(0.5, (Number(s.w) || 1) * k);
        const g = group(`${c}|l|${s.col}|${s.a}|${Math.round(w * 4)}`, c, () => `{\\an7\\pos(0,0)\\bord${px(w / 2)}\\shad0\\1a&HFF&\\3c${s.col}\\3a${s.a}\\p2}`);
        const p = [];
        for (let i = 0; i < s.pts.length; i += 2) p.push(`${half(s.pts[i] * sx)} ${half(s.pts[i + 1] * sy)}`);
        // (there and back again, so it has no area and its outline is the whole line, as wide on both sides; a
        // closed one back to its start first)
        const seq = s.closed ? [...p, p[0]] : p;
        g.parts.push(`m ${seq[0]} l ${[...seq.slice(1), ...seq.slice(1, -1).reverse()].join(" ")}`);
      } else if (s.k === "fill" && Array.isArray(s.polys)) {
        const g = group(`${c}|f|${s.col}|${s.a}`, c, () => `{\\an7\\pos(0,0)\\bord0\\shad0\\1c${s.col}\\1a${s.a}\\p2}`);
        for (const poly of s.polys) {
          if (!Array.isArray(poly) || poly.length < 6) continue;
          const p = [];
          for (let i = 0; i < poly.length; i += 2) p.push(`${half(poly[i] * sx)} ${half(poly[i + 1] * sy)}`);
          g.parts.push(`m ${p[0]} l ${p.slice(1).join(" ")}`);
        }
      } else if (s.k === "dot") {
        const r = Math.max(0.5, (Number(s.r) || 1) * k);
        const g = group(`${c}|d|${s.col}|${s.a}|${Math.round(r * 4)}`, c, () => `{\\an7\\pos(0,0)\\bord${px(r)}\\shad0\\1a&HFF&\\3c${s.col}\\3a${s.a}\\p2}`);
        const x = Math.round(s.x * sx * 2), y = Math.round(s.y * sy * 2);
        g.parts.push(`m ${x} ${y} l ${x + 1} ${y}`);
      } else if (s.k === "ring") {
        // A circle's outline: a circle (four curves) just inside it, whose outline (outside a shape, its width)
        // is the ring.
        const w = Math.max(0.5, (Number(s.w) || 1) * k), r = Math.max(0.5, (Number(s.r) || 1) * k - w / 2);
        const g = group(`${c}|r|${s.col}|${s.a}|${Math.round(w * 4)}`, c, () => `{\\an7\\pos(0,0)\\bord${px(w)}\\shad0\\1a&HFF&\\3c${s.col}\\3a${s.a}\\p2}`);
        const x = s.x * sx * 2, y = s.y * sy * 2, R = r * 2, q = R * 0.5523;
        const n = (v) => String(Math.round(v));
        g.parts.push(`m ${n(x + R)} ${n(y)} b ${n(x + R)} ${n(y + q)} ${n(x + q)} ${n(y + R)} ${n(x)} ${n(y + R)} b ${n(x - q)} ${n(y + R)} ${n(x - R)} ${n(y + q)} ${n(x - R)} ${n(y)}` +
          ` b ${n(x - R)} ${n(y - q)} ${n(x - q)} ${n(y - R)} ${n(x)} ${n(y - R)} b ${n(x + q)} ${n(y - R)} ${n(x + R)} ${n(y - q)} ${n(x + R)} ${n(y)}`);
      } else if (s.k === "text" && s.text) {
        const size = Math.max(4, (Number(s.size) || 12) * k);
        const tags = [`\\an${s.an || 7}`, `\\pos(${px(s.x * sx)},${px(s.y * sy)})`, `\\fs${px(size * 1.15)}`, `\\b${s.bold ? 1 : 0}`, "\\shad0",
          `\\1c${s.col}`, `\\1a${s.a}`, s.ow ? `\\bord${px(s.ow * k / 2)}\\3c${s.ocol}\\3a${s.oa}` : "\\bord0"];
        if (s.rot) tags.push(`\\frz${px(s.rot)}`);
        if (s.flip) tags.push("\\fscx-100");
        out[c].push({ layer: layer++, text: `{${tags.join("")}}${plain(s.text)}` });
      }
    }
    for (const g of groups.values()) if (g.parts.length) out[g.c].push({ layer: g.layer, text: g.head + g.parts.join(" ") });
    for (const c of ["hands", "objects"]) out[c] = out[c].sort((a, b) => a.layer - b.layer).map((l) => dialogue(l.layer, start, end, "Default", l.text));
    return out;
  }

  // ---------- whole files ----------
  function header({ width = 1280, height = 720, font = FONT } = {}) {
    const fs = Math.round(height / 22);
    return [
      "[Script Info]", "; Hand Tracker's labels (label-ass.js)", "ScriptType: v4.00+", `PlayResX: ${Math.round(width)}`, `PlayResY: ${Math.round(height)}`,
      "ScaledBorderAndShadow: yes", "WrapStyle: 2", "YCbCr Matrix: None", "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      `Style: Default,${font},${fs},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
      // The steps: white on a dark box, at the bottom; the camera names: likewise, in each one's corner.
      `Style: Steps,${font},${fs},&H00FFFFFF,&H00FFFFFF,&H55000000,&H55000000,1,0,0,0,100,100,0,0,3,${Math.max(4, Math.round(fs / 3))},0,2,${Math.round(width / 20)},${Math.round(width / 20)},${Math.round(height / 24)},1`,
      `Style: Names,${font},${Math.round(height / 28)},&H00FFFFFF,&H00FFFFFF,&H66000000,&H66000000,1,0,0,0,100,100,0,0,3,${Math.max(4, Math.round(height / 90))},0,7,0,0,0,1`,
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ].join("\n");
  }
  function file(lines, size = {}) {
    return `${header(size)}\n${(lines || []).join("\n")}\n`;
  }
  function parse(text) {
    const s = String(text || "");
    const num = (re, d) => {
      const m = re.exec(s);
      return m ? Number(m[1]) : d;
    };
    const lines = s.split(/\r?\n/).filter((l) => l.startsWith("Dialogue:"));
    return { width: num(/^PlayResX:\s*(\d+)/m, 1280), height: num(/^PlayResY:\s*(\d+)/m, 720), lines };
  }
  // A line's parts: [layer, start, end, style, name, ml, mr, mv, effect, text].
  function split(line) {
    const body = line.replace(/^Dialogue:\s*/, "");
    const parts = [];
    let at = 0;
    for (let i = 0; i < 9; i++) {
      const c = body.indexOf(",", at);
      if (c < 0) return null;
      parts.push(body.slice(at, c));
      at = c + 1;
    }
    parts.push(body.slice(at));
    return parts;
  }
  const join = (p) => `Dialogue: ${p.join(",")}`;
  // The same lines at another time.
  function retime(lines, start, end) {
    const out = [];
    for (const l of lines || []) {
      const p = split(l);
      if (!p || !(end > start)) continue;
      p[1] = time(start);
      p[2] = time(end);
      out.push(join(p));
    }
    return out;
  }
  function merge(...lists) {
    const all = [];
    for (const list of lists) for (const l of list || []) all.push(l);
    return all.map((l, i) => ({ l, i, t: seconds((split(l) || [])[1] || "0:00:00.00") })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.l);
  }

  // ---------- moved into another picture (a grid's block), later, cut ----------
  function move(lines, { scale = 1, dx = 0, dy = 0, shift = 0, length = Infinity, clip = null } = {}) {
    const out = [];
    const k = Number(scale) || 1;
    const X = (v) => Number(v) * k + dx, Y = (v) => Number(v) * k + dy;
    for (const line of lines || []) {
      const p = split(line);
      if (!p) continue;
      let start = seconds(p[1]) + shift, end = seconds(p[2]) + shift;
      if (end <= 0 || start >= length) continue;
      start = Math.max(0, start);
      end = Math.min(length, end);
      if (!(end > start)) continue;
      // Its tags (positions, sizes, widths) and its drawing's points (half pixels after \p2). A clip (a grid's
      // block) goes on its first tags.
      const clipTag = clip ? `\\clip(${clip.map((v) => Math.round(v)).join(",")})` : "";
      let text = p[9];
      let drawing = false, clipped = false;
      text = text.replace(/\{([^}]*)\}|([^{]+)/g, (all, tags, body) => {
        if (tags !== undefined) {
          const t = tags
            .replace(/\\pos\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/g, (_, x, y) => `\\pos(${px(X(x))},${px(Y(y))})`)
            .replace(/\\(bord|fs)(-?[\d.]+)/g, (_, n, v) => `\\${n}${px(Number(v) * k)}`)
            .replace(/\\clip\([^)]*\)/g, "");
          const pm = /\\p(\d)/.exec(t);
          if (pm) drawing = Number(pm[1]) > 0;
          const first = !clipped;
          clipped = true;
          return `{${t}${first ? clipTag : ""}}`;
        }
        // (a drawing's points are from its \pos, which moved: they're only scaled)
        if (!drawing) return body;
        return body.replace(/-?\d+(\.\d+)?/g, (v) => String(Math.round(Number(v) * k)));
      });
      if (clipTag && !clipped) text = `{${clipTag}}${text}`;
      p[1] = time(start);
      p[2] = time(end);
      p[9] = text;
      out.push(join(p));
    }
    return out;
  }

  // ---------- the steps ----------
  // Annotate's steps (annotations.segments: { start, end, label, review, parent }), all but rejected ones, at the
  // bottom; those not yet reviewed with a "?"; a step's sub-steps (parent: its id) on a second, smaller line while
  // they're on. Times: the annotated video's, shift seconds later here.
  function stepLines(annotations, { shift = 0, length = Infinity } = {}) {
    const segs = ((annotations && annotations.segments) || []).filter((s) => s && s.review !== "rejected" && Number.isFinite(Number(s.start)) && Number(s.end) > Number(s.start));
    const name = (s) => `${plain(s.label || s.kind || "Step")}${s.review === "approved" ? "" : " ?"}`;
    const tops = segs.filter((s) => !s.parent);
    const out = [];
    for (const top of tops) {
      const subs = segs.filter((s) => s.parent === top.id).sort((a, b) => a.start - b.start);
      // The step's time cut where its sub-steps start and end: each piece with the ones then.
      const cuts = new Set([Number(top.start), Number(top.end)]);
      for (const s of subs) {
        cuts.add(Math.max(Number(top.start), Math.min(Number(top.end), Number(s.start))));
        cuts.add(Math.max(Number(top.start), Math.min(Number(top.end), Number(s.end))));
      }
      const t = [...cuts].sort((a, b) => a - b);
      for (let i = 0; i + 1 < t.length; i++) {
        const a = t[i], b = t[i + 1];
        if (!(b > a)) continue;
        const on = subs.filter((s) => s.start < b && s.end > a).map(name);
        let start = a + shift, end = b + shift;
        if (end <= 0 || start >= length) continue;
        start = Math.max(0, start);
        end = Math.min(length, end);
        const text = on.length ? `${name(top)}\\N{\\fs${"$SMALL"}\\b0}${on.join(" · ")}` : name(top);
        out.push(dialogue(0, start, end, "Steps", text));
      }
    }
    return out;
  }
  // (the sub-steps' size: the Steps style's, a fifth smaller, set per file)
  function sized(lines, { height = 720 } = {}) {
    const small = Math.round((height / 22) * 0.8);
    return lines.map((l) => l.split("$SMALL").join(String(small)));
  }

  // ---------- camera names (a grid) ----------
  function nameLines(names, { length = 1 } = {}) {
    return (names || []).filter((n) => n && n.text).map((n) => dialogue(0, 0, Math.max(0.01, length), "Names", `{\\an7\\pos(${px(n.x)},${px(n.y)})}${plain(n.text)}`));
  }

  const api = {
    TRACKS, time, seconds, frameLines, header, file, parse, merge, move, retime,
    stepLines: (annotations, o = {}) => sized(stepLines(annotations, o), o),
    nameLines,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else global.LabelAss = api;
})(typeof window !== "undefined" ? window : globalThis);
