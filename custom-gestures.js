/**
 * custom-gestures.js — gestures you record yourself, as well as the built-in ones (gestures.js):
 *  - a hand shape: held up to the camera for a moment while it's recorded; afterwards a hand
 *    that close to it (either hand: a left hand is matched as the mirror image of a right one)
 *    is that gesture, ahead of the built-in shapes;
 *  - a movement: drawn in the air with the hand three times while it's recorded; afterwards
 *    the hand's palm drawing the same path (about as big, about as quickly, and with the same
 *    hand shape if it kept one while recorded) is that gesture for a moment.
 * Each one is a gesture like the built-in ones: gesture actions can use it (pc-control.js), and
 * a hand shape can be the hand mouse's click, right click or hold-still. They're kept in the
 * settings (prefs.customGestures), and recorded on the "My gestures" part of the hand mouse's
 * card (#myGestures).
 *
 *   CustomGestures.set(list); CustomGestures.list()       // the recorded ones
 *   CustomGestures.matchShape(hand)  -> { label, color } | null
 *   CustomGestures.movements()       -> a tracker: update(hands, builtInLabelOf, now) -> { side: { label, color } }
 *   CustomGestures.names() / shapeNames() / isMovement(label)
 *   CustomGestures.isRecording()     // (the hand mouse and gesture actions wait meanwhile)
 *   CustomGestures.initUI({ prefs, setPref, builtIn, onChange })   // the "My gestures" part
 */

(function (global) {
  const COLORS = ["#ffa94d", "#a9e34b", "#63e6be", "#4dabf7", "#e599f7", "#ff8787", "#ffd43b", "#91a7ff"];
  // A hand shape: how far (on average over the hand's 21 points, in palm lengths: wrist to the
  // middle finger's knuckle) a hand may be from the recorded one. The recording's own spread
  // widens it, between these.
  const SHAPE_TOL = { least: 0.12, most: 0.2, spread: 2, extra: 0.08 };
  const SHAPE_RECORD_MS = 1500;
  // A movement: its path, resampled to this many points, and how close (on average, its size
  // being 1) a path drawn later must be to one of the three recorded.
  const MOVE_POINTS = 32;
  const MOVE_TOL = { least: 0.12, most: 0.3, spread: 1.6 };
  const FLAT_TOL = 0.2; // and how much flatter or rounder (its narrow side over its wide side)
  const DIR_TOL = { least: 0.16, most: 0.3, spread: 1.5 }; // and how differently it heads along the way (0-1)
  const MOVE_TAKES = 3;
  const MOVE_MAX_MS = 3000;
  const MOVE_SHOWN_MS = 600; // a movement's gesture lasts this long (for gesture actions to see it)
  // A movement starts when the palm moves faster than MOVE_START (palm lengths a second) and
  // ends once it's been slower than MOVE_STOP for MOVE_STOP_MS: recorded so, and watched so.
  const MOVE_START = 1.2, MOVE_STOP = 0.5, MOVE_STOP_MS = 200;
  const SPEED_MS = 120;
  const COUNTDOWN_S = 3;

  let gestures = [];
  let recording = null; // what's being recorded now (the recorder's state)

  // ---------- a hand shape ----------
  // The hand's 21 points from its wrist, in palm lengths, in the picture's real proportions;
  // a left hand mirrored, so it reads as a right one.
  function shapeOf(landmarks, aspect, left) {
    const pts = landmarks.map((p) => [(left ? -1 : 1) * p.x * aspect, p.y]);
    const palm = Math.hypot(pts[9][0] - pts[0][0], pts[9][1] - pts[0][1]) || 1e-6;
    return pts.map(([x, y]) => [(x - pts[0][0]) / palm, (y - pts[0][1]) / palm]);
  }
  function shapeDistance(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]);
    return s / a.length;
  }
  // The same, with the hand turned about its wrist (up to SHAPE_TURN either way) to line up
  // best with the recorded one: a hand held a little tilted is still the shape, but a thumb
  // down isn't a thumb up.
  const SHAPE_TURN = (35 * Math.PI) / 180;
  function shapeDistanceTurned(a, b) {
    let cross = 0, dot = 0;
    for (let i = 0; i < a.length; i++) {
      cross += a[i][0] * b[i][1] - a[i][1] * b[i][0];
      dot += a[i][0] * b[i][0] + a[i][1] * b[i][1];
    }
    const t = Math.max(-SHAPE_TURN, Math.min(SHAPE_TURN, Math.atan2(cross, dot)));
    const c = Math.cos(t), s = Math.sin(t);
    return shapeDistance(a.map(([x, y]) => [x * c - y * s, x * s + y * c]), b);
  }
  function meanShape(samples) {
    return samples[0].map((_, i) => [
      samples.reduce((s, p) => s + p[i][0], 0) / samples.length,
      samples.reduce((s, p) => s + p[i][1], 0) / samples.length,
    ]);
  }
  function shapeTemplate(samples) {
    const points = meanShape(samples);
    const spread = samples.reduce((s, p) => s + shapeDistance(p, points), 0) / samples.length;
    const tol = Math.min(SHAPE_TOL.most, Math.max(SHAPE_TOL.least, spread * SHAPE_TOL.spread + SHAPE_TOL.extra));
    return { points: points.map(([x, y]) => [round(x), round(y)]), tol: round(tol) };
  }
  const aspectNow = () => {
    const cam = global.HandTracker && global.HandTracker.getCamera ? global.HandTracker.getCamera() : {};
    return cam.width && cam.height ? cam.width / cam.height : 4 / 3;
  };
  const handShapeOf = (hand) => (hand && hand.landmarks ? shapeOf(hand.landmarks, aspectNow(), hand.handedness === "Left") : null);

  function matchShape(hand) {
    let best = null;
    let shape = null;
    for (const g of gestures) {
      if (g.kind !== "shape") continue;
      shape = shape || handShapeOf(hand);
      if (!shape) return null;
      const d = shapeDistanceTurned(shape, g.points);
      if (d <= g.tol && (!best || d < best.d)) best = { d, g };
    }
    return best ? { label: best.g.name, color: best.g.color } : null;
  }

  // ---------- a movement ----------
  // The palm's centre (the middle of the wrist and the four knuckles), in the picture's real
  // proportions, as you see it (mirrored when the picture is), and the palm's length.
  function palmOf(hand, aspect, mirrored) {
    const lm = hand.imageLandmarks || hand.landmarks;
    const cx = [0, 5, 9, 13, 17].reduce((s, i) => s + lm[i].x, 0) / 5;
    const cy = [0, 5, 9, 13, 17].reduce((s, i) => s + lm[i].y, 0) / 5;
    const palm = Math.hypot((lm[9].x - lm[0].x) * aspect, lm[9].y - lm[0].y) || 1e-6;
    return { x: (mirrored ? 1 - cx : cx) * aspect, y: cy, palm };
  }
  const pathLength = (pts) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0);
  // Evenly spaced along the path, centred, and scaled so its larger side is 1 (its direction
  // and proportions kept: a line across isn't a line up, a circle isn't an oval).
  function normalize(pts, n = MOVE_POINTS) {
    const total = pathLength(pts);
    if (pts.length < 2 || total <= 0) return null;
    const step = total / (n - 1);
    const out = [[pts[0].x, pts[0].y]];
    let acc = 0;
    for (let i = 1; i < pts.length && out.length < n; i++) {
      let [px, py] = [pts[i - 1].x, pts[i - 1].y];
      let d = Math.hypot(pts[i].x - px, pts[i].y - py);
      while (acc + d >= step && out.length < n) {
        const t = (step - acc) / d;
        px += t * (pts[i].x - px);
        py += t * (pts[i].y - py);
        out.push([px, py]);
        d = Math.hypot(pts[i].x - px, pts[i].y - py);
        acc = 0;
      }
      acc += d;
    }
    while (out.length < n) out.push([pts[pts.length - 1].x, pts[pts.length - 1].y]);
    const xs = out.map((p) => p[0]), ys = out.map((p) => p[1]);
    const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1e-6;
    const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
    return out.map(([x, y]) => [(x - mx) / size, (y - my) / size]);
  }
  // How big a path is, in palm lengths (its larger side), so a twitch isn't a small circle.
  // How differently two paths head along the way: the angle between their directions at each
  // step, on average, as a part of a half turn (0 the same way, 1 the opposite).
  function directionDistance(a, b) {
    let s = 0;
    for (let i = 1; i < a.length; i++) {
      const t1 = Math.atan2(a[i][1] - a[i - 1][1], a[i][0] - a[i - 1][0]);
      const t2 = Math.atan2(b[i][1] - b[i - 1][1], b[i][0] - b[i - 1][0]);
      s += Math.abs(((t1 - t2 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    }
    return s / (a.length - 1) / Math.PI;
  }
  // How flat a path is: its narrower side over its wider (a line 0, a circle 1).
  function flatnessOf(path) {
    const xs = path.map((p) => p[0]), ys = path.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    return Math.min(w, h) / (Math.max(w, h) || 1e-6);
  }
  function sizeOf(pts) {
    const palm = pts.reduce((s, p) => s + p.palm, 0) / pts.length;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / palm;
  }
  // The most common built-in shape while it moved, if the hand kept one most of the time.
  function keptShape(labels) {
    const counts = {};
    for (const l of labels) counts[l] = (counts[l] || 0) + 1;
    const [top, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || ["", 0];
    return top && top !== "—" && n >= labels.length * 0.6 ? top : "";
  }
  function movementTemplate(takes) {
    const paths = takes.map((t) => normalize(t.points));
    let worst = 0, worstDir = 0;
    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        worst = Math.max(worst, shapeDistance(paths[i], paths[j]));
        worstDir = Math.max(worstDir, directionDistance(paths[i], paths[j]));
      }
    }
    return {
      takes: paths.map((p) => p.map(([x, y]) => [round(x), round(y)])),
      ms: Math.round(takes.reduce((s, t) => s + t.ms, 0) / takes.length),
      size: round(takes.reduce((s, t) => s + sizeOf(t.points), 0) / takes.length),
      flat: paths.map((p) => round(flatnessOf(p))),
      shape: keptShape(takes.flatMap((t) => t.points.map((p) => p.shape))),
      tol: round(Math.min(MOVE_TOL.most, Math.max(MOVE_TOL.least, worst * MOVE_TOL.spread))),
      dirTol: round(Math.min(DIR_TOL.most, Math.max(DIR_TOL.least, worstDir * DIR_TOL.spread))),
    };
  }
  // Cuts a hand's path into movements: fed each frame's palm ({ t, x, y, palm, shape }), it
  // gives a movement's points once it has ended (null meanwhile). One longer than maxMs is let
  // go, and the next starts only once the hand has been still.
  function segmenter(maxMs) {
    let seg = null, stillSince = 0, waitStill = false;
    const recent = []; // the last SPEED_MS of points: speed over that, so the tracking's jitter isn't movement
    return (p) => {
      const before = recent[recent.length - 1] || null;
      recent.push(p);
      while (recent.length > 2 && p.t - recent[1].t >= SPEED_MS) recent.shift();
      const from = recent[0];
      // (none until it has watched that long: one frame to the next is mostly jitter)
      const speed = p.t - from.t >= SPEED_MS * 0.7 ? (Math.hypot(p.x - from.x, p.y - from.y) / p.palm / (p.t - from.t)) * 1000 : 0;
      if (waitStill) {
        if (speed < MOVE_STOP) stillSince = stillSince || p.t;
        else stillSince = 0;
        if (stillSince && p.t - stillSince >= MOVE_STOP_MS) waitStill = false;
        return null;
      }
      if (!seg) {
        if (before && speed > MOVE_START) {
          seg = [before, p];
          stillSince = 0;
        }
        return null;
      }
      seg.push(p);
      if (speed < MOVE_STOP) stillSince = stillSince || p.t;
      else stillSince = 0;
      if (stillSince && p.t - stillSince >= MOVE_STOP_MS) {
        const pts = seg.filter((q) => q.t <= stillSince); // (not the moment it stood still at the end)
        seg = null;
        stillSince = 0;
        return pts;
      }
      if (p.t - seg[0].t > maxMs) {
        seg = null;
        stillSince = 0;
        waitStill = true;
      }
      return null;
    };
  }
  // How close a movement just made is to a recorded one (null if it isn't): about as long, as
  // big, with the same hand shape if it was recorded with one, and the same path.
  function matchMovement(g, pts) {
    const ms = pts[pts.length - 1].t - pts[0].t;
    if (pts.length < 4 || ms < g.ms * 0.5 || ms > g.ms * 2) return null;
    const size = sizeOf(pts);
    if (size < g.size * 0.5 || size > g.size * 2) return null;
    if (g.shape && pts.filter((p) => p.shape === g.shape).length < pts.length * 0.5) return null;
    const path = normalize(pts);
    if (!path) return null;
    if (Array.isArray(g.flat) && !g.flat.some((f) => Math.abs(f - flatnessOf(path)) <= FLAT_TOL)) return null;
    let best = null;
    for (const take of g.takes) {
      const d = shapeDistance(path, take);
      if (d <= g.tol && (!g.dirTol || directionDistance(path, take) <= g.dirTol) && (best === null || d < best)) best = d;
    }
    return best;
  }
  // Each window (gestures.js's create()) has its own: each hand's movements.
  function movements() {
    const cut = {}, shown = {};
    return {
      update(hands, builtInLabelOf, now = performance.now()) {
        const moves = gestures.filter((g) => g.kind === "movement");
        const out = {};
        if (!moves.length) return out;
        const longest = Math.max(...moves.map((g) => g.ms)) * 2;
        const aspect = aspectNow();
        const mirrored = !!(global.HandTracker && global.HandTracker.isMirrored && global.HandTracker.isMirrored());
        for (const hand of hands) {
          const side = hand.handedness;
          const feed = cut[side] || (cut[side] = segmenter(longest));
          const pts = feed({ t: now, ...palmOf(hand, aspect, mirrored), shape: builtInLabelOf(hand) });
          if (pts) {
            let best = null;
            for (const g of moves) {
              const d = matchMovement(g, pts);
              if (d !== null && (!best || d < best.d)) best = { d, g };
            }
            if (best) shown[side] = { label: best.g.name, color: best.g.color, until: now + MOVE_SHOWN_MS };
          }
          if (shown[side] && now < shown[side].until) out[side] = shown[side];
        }
        for (const side of Object.keys(cut)) if (!hands.some((h) => h.handedness === side)) delete cut[side];
        return out;
      },
    };
  }

  const round = (v) => Math.round(v * 1000) / 1000;
  const valid = (g) =>
    g && typeof g.name === "string" && g.name &&
    ((g.kind === "shape" && Array.isArray(g.points) && g.points.length === 21 && g.tol > 0) ||
      (g.kind === "movement" && Array.isArray(g.takes) && g.takes.length && g.ms > 0 && g.size > 0 && g.tol > 0));

  // ---------- the recorder ("My gestures") ----------
  let ui = null; // { prefs, setPref, builtIn, onChange, els }
  const $ = (id) => document.getElementById(id);
  const say = (text) => ui && (ui.els.status.textContent = text);

  function save(list) {
    gestures = list.filter(valid);
    if (ui) {
      ui.setPref("customGestures", gestures);
      renderList();
      ui.onChange();
    }
  }
  function nameProblem(name) {
    if (!name) return "Give it a name first.";
    if (name.length > 40) return "That name's too long.";
    const taken = [...(ui.builtIn || []), ...gestures.map((g) => g.name)].some((n) => n.toLowerCase() === name.toLowerCase());
    return taken ? `There's a gesture called “${name}” already.` : "";
  }
  function nextColor() {
    return COLORS[gestures.length % COLORS.length];
  }

  // The hand being recorded: the one seen most clearly (the biggest, the nearest), and the same
  // side as before once it's chosen.
  function handFor(hands) {
    if (!hands.length) return null;
    if (recording.side) return hands.find((h) => h.handedness === recording.side) || null;
    const aspect = aspectNow();
    const pick = hands.slice().sort((a, b) => palmOf(b, aspect, false).palm - palmOf(a, aspect, false).palm)[0];
    recording.side = pick.handedness;
    return pick;
  }

  function startRecording(kind) {
    if (recording) return;
    const name = ui.els.name.value.trim();
    const problem = nameProblem(name);
    if (problem) return say(problem);
    recording = { kind, name, phase: "countdown", until: performance.now() + COUNTDOWN_S * 1000, take: 0, takes: [], samples: [], side: null };
    showRecording();
    feed([]); // (says what to do now, before the next frame)
  }
  function stopRecording(text) {
    recording = null;
    showRecording();
    if (text) say(text);
  }
  function showRecording() {
    const on = !!recording;
    ui.els.shape.disabled = on;
    ui.els.move.disabled = on;
    ui.els.name.disabled = on;
    ui.els.cancel.hidden = !on;
  }
  const countdownText = (now) => Math.max(1, Math.ceil((recording.until - now) / 1000));

  // Every frame, while recording.
  function feed(hands) {
    if (!recording) return;
    const now = performance.now();
    const r = recording;
    if (r.phase === "countdown") {
      const takeText = r.kind === "movement" ? `Take ${r.take + 1} of ${MOVE_TAKES}: ` : "";
      const what = r.kind === "shape" ? `make your hand shape for “${r.name}” and hold it` : `get ready to draw “${r.name}” in the air`;
      if (now < r.until) return say(`${takeText}${what}… ${countdownText(now)}`);
      r.phase = "recording";
      r.started = now;
      r.samples = [];
      r.cut = segmenter(MOVE_MAX_MS);
      r.seen = 0;
    }
    const hand = handFor(hands);
    if (r.kind === "shape") {
      say(`Recording “${r.name}”: hold still…`);
      if (hand) r.samples.push(handShapeOf(hand));
      if (now - r.started < SHAPE_RECORD_MS) return;
      if (r.samples.length < 8) return stopRecording("Couldn't see your hand well enough. Try again with your hand in the picture.");
      const t = shapeTemplate(r.samples);
      save([...gestures, { id: `g${Date.now()}`, name: r.name, kind: "shape", color: nextColor(), ...t }]);
      ui.els.name.value = "";
      return stopRecording(`Saved “${r.name}”: it's in gesture actions now (and can be the hand mouse's click).`);
    }
    // A movement: from when the hand starts moving until it stops, as it's watched for later.
    say(`Take ${r.take + 1} of ${MOVE_TAKES}: draw “${r.name}” now, then hold still…`);
    const mirrored = !!(global.HandTracker && global.HandTracker.isMirrored && global.HandTracker.isMirrored());
    const pts = hand ? r.cut({ t: now, ...palmOf(hand, aspectNow(), mirrored), shape: ui.builtInLabelOf ? ui.builtInLabelOf(hand) : "" }) : null;
    const again = (why) => {
      r.phase = "countdown";
      r.until = now + COUNTDOWN_S * 1000;
      say(`Take ${r.take + 1}: ${why} Again in ${COUNTDOWN_S}…`);
    };
    if (!pts) {
      if (now - r.started > MOVE_MAX_MS + COUNTDOWN_S * 1000) again("no movement seen (or it went on too long). Move your whole hand, then hold still.");
      return;
    }
    if (pts.length < 4 || sizeOf(pts) < 0.8) return again("too small. Move your whole hand, further.");
    r.takes.push({ points: pts, ms: pts[pts.length - 1].t - pts[0].t });
    r.take++;
    if (r.take < MOVE_TAKES) {
      r.phase = "countdown";
      r.until = now + COUNTDOWN_S * 1000;
      return;
    }
    const t = movementTemplate(r.takes);
    save([...gestures, { id: `g${Date.now()}`, name: r.name, kind: "movement", color: nextColor(), ...t }]);
    ui.els.name.value = "";
    stopRecording(`Saved “${r.name}”: it's in gesture actions now.${t.shape ? ` (Draw it with your hand as ${t.shape}, as you recorded it.)` : ""}`);
  }

  function renderList() {
    const list = ui.els.list;
    list.innerHTML = "";
    if (!gestures.length) {
      list.innerHTML = '<div class="note">None yet.</div>';
      return;
    }
    for (const g of gestures) {
      const row = document.createElement("div");
      row.className = "action-row";
      const dot = document.createElement("span");
      dot.textContent = "●";
      dot.style.color = g.color;
      const name = document.createElement("b");
      name.textContent = g.name;
      const kind = document.createElement("span");
      kind.textContent = g.kind === "shape" ? "hand shape" : `movement${g.shape ? ` (as ${g.shape})` : ""}`;
      kind.style.opacity = "0.6";
      const del = document.createElement("button");
      del.textContent = "Delete";
      del.addEventListener("click", () => {
        if (del.dataset.armed !== "1") {
          del.dataset.armed = "1";
          del.textContent = "Tap again to delete";
          return;
        }
        save(gestures.filter((x) => x !== g));
        say(`Deleted “${g.name}”.`);
      });
      row.append(dot, name, kind, del);
      list.appendChild(row);
    }
  }

  function initUI({ prefs, setPref, builtIn = [], builtInLabelOf = null, onChange = () => {} }) {
    gestures = (Array.isArray(prefs.customGestures) ? prefs.customGestures : []).filter(valid);
    const root = $("myGestures");
    if (!root || ui) return false;
    root.innerHTML = `
      <div class="section-label">My gestures</div>
      <div class="note">Record your own: a hand shape you hold up, or a movement you draw in the air (three times). Then it's a gesture like the others: in gesture actions, and a hand shape can be the hand mouse's click.</div>
      <div class="toolbar">
        <input id="myGestureName" type="text" placeholder="Its name" maxlength="40" spellcheck="false" autocomplete="off" />
        <button id="myGestureShape">Record a hand shape</button>
        <button id="myGestureMove">Record a movement</button>
        <button id="myGestureCancel" hidden>Cancel</button>
      </div>
      <div id="myGestureStatus" class="note"></div>
      <div id="myGestureList"></div>`;
    ui = {
      prefs, setPref, builtIn, builtInLabelOf, onChange,
      els: { name: $("myGestureName"), shape: $("myGestureShape"), move: $("myGestureMove"), cancel: $("myGestureCancel"), status: $("myGestureStatus"), list: $("myGestureList") },
    };
    ui.els.shape.addEventListener("click", () => startRecording("shape"));
    ui.els.move.addEventListener("click", () => startRecording("movement"));
    ui.els.cancel.addEventListener("click", () => stopRecording("Cancelled."));
    if (global.HandTracker && global.HandTracker.onHandLandmarks) global.HandTracker.onHandLandmarks(({ hands }) => feed(hands));
    renderList();
    return true;
  }

  global.CustomGestures = {
    set: (list) => {
      gestures = (Array.isArray(list) ? list : []).filter(valid);
    },
    list: () => gestures.slice(),
    names: () => gestures.map((g) => g.name),
    shapeNames: () => gestures.filter((g) => g.kind === "shape").map((g) => g.name),
    isMovement: (label) => gestures.some((g) => g.kind === "movement" && g.name === label),
    matchShape,
    movements,
    isRecording: () => !!recording,
    initUI,
    // For the checks.
    _feed: feed,
    _shapeOf: shapeOf,
    _shapeDistance: shapeDistance,
    _shapeDistanceTurned: shapeDistanceTurned,
    _shapeTemplate: shapeTemplate,
    _movementTemplate: movementTemplate,
    _normalize: normalize,
    _segmenter: segmenter,
    _directionDistance: directionDistance,
  };
})(typeof window !== "undefined" ? window : globalThis);
