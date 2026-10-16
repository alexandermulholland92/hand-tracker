/**
 * body-tracker.js — bodies, as the Kinect's own body tracking gives them (its 25 joints, up to six
 * people, each hand open, closed or "lasso", leaning), for a Kinect in a tile of "Several cameras"
 * on Linux, where the Kinect's own tracking (Microsoft's SDK, Windows only) isn't there: MediaPipe's
 * pose landmarker finds each person in the picture (body-finder-worker.js), and the Kinect's depth
 * puts each joint where it is, in millimetres. On Windows the Kinect's SDK finds the bodies itself
 * and this only draws them.
 *
 *   const bt = BodyTracker.create({ people: 1 });       // the worker starts loading the model
 *   await bt.detect(image, t, { people, faces, poses }) // -> { poses, faces } (MediaPipe's) or null (busy);
 *                                                       //    faces: how many faces to look for (0: none);
 *                                                       //    poses: false for none (the Kinect's own bodies)
 *   BodyTracker.fromPoses(poses, { at3d, hands, previous, faces }) -> bodies
 *   BodyTracker.attachFaces(bodies, faces, previous)    // each face to the body whose head it's at
 *     at3d(u, v) -> [x, y, z] mm from the camera (x right, y down, z ahead) or null;
 *     hands: the hand tracker's hands (their gestures as each hand's state); previous: the last bodies (ids)
 *   BodyTracker.draw(ctx, bodies, toCanvas, unit)        // their skeletons, toCanvas({ x, y }) -> { x, y }
 *   BodyTracker.JOINTS, BodyTracker.BONES
 *
 * A body: { id (0-5, kept while it's seen), joints: [{ name, u, v, x, y, z, state }] (u, v: 0-1 of
 * the picture; x, y, z: mm, where the depth camera sees that joint's surface; state "tracked",
 * "inferred" (from the body model, where the depth didn't fit or wasn't there) or "none"),
 * hands: { left, right } ("open" | "closed" | "lasso" | "unknown" | "notTracked"), lean: [x, y]
 * (-1 to 1: to its right, forwards), face (when faces are looked for, as the Kinect's face
 * tracking gives it: { box, points, rotation: [yaw, pitch, roll] degrees, happy, eyesClosed:
 * [left, right], mouthOpen (0-1 each), mouthMoved, lookingAway, engaged, shapes: MediaPipe's 52
 * expression scores }) }.
 */

(function (global) {
  // The Kinect's joints, in its own order (Microsoft's JointType).
  const JOINTS = [
    "SpineBase", "SpineMid", "Neck", "Head", "ShoulderLeft", "ElbowLeft", "WristLeft", "HandLeft", "ShoulderRight", "ElbowRight", "WristRight", "HandRight",
    "HipLeft", "KneeLeft", "AnkleLeft", "FootLeft", "HipRight", "KneeRight", "AnkleRight", "FootRight", "SpineShoulder", "HandTipLeft", "ThumbLeft", "HandTipRight", "ThumbRight",
  ];
  const J = Object.fromEntries(JOINTS.map((n, i) => [n, i]));
  const BONES = [
    ["Head", "Neck"], ["Neck", "SpineShoulder"], ["SpineShoulder", "SpineMid"], ["SpineMid", "SpineBase"], ["SpineShoulder", "ShoulderRight"], ["SpineShoulder", "ShoulderLeft"],
    ["SpineBase", "HipRight"], ["SpineBase", "HipLeft"], ["ShoulderRight", "ElbowRight"], ["ElbowRight", "WristRight"], ["WristRight", "HandRight"], ["HandRight", "HandTipRight"],
    ["WristRight", "ThumbRight"], ["ShoulderLeft", "ElbowLeft"], ["ElbowLeft", "WristLeft"], ["WristLeft", "HandLeft"], ["HandLeft", "HandTipLeft"], ["WristLeft", "ThumbLeft"],
    ["HipRight", "KneeRight"], ["KneeRight", "AnkleRight"], ["AnkleRight", "FootRight"], ["HipLeft", "KneeLeft"], ["KneeLeft", "AnkleLeft"], ["AnkleLeft", "FootLeft"],
  ].map(([a, b]) => [J[a], J[b]]);
  const COLORS = ["#4dabf7", "#ffa94d", "#69db7c", "#f783ac", "#ffd43b", "#b197fc"];

  // MediaPipe's pose landmarks (anatomical sides).
  const P = { nose: 0, lEar: 7, rEar: 8, lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16, lPinky: 17, rPinky: 18, lIndex: 19, rIndex: 20,
    lThumb: 21, rThumb: 22, lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28, lFoot: 31, rFoot: 32 };
  const MIN_VISIBLE = 0.5;
  let SHAPES = []; // MediaPipe's expression scores' names (from the worker)

  // A face as the Kinect's face tracking describes one, from MediaPipe's expression scores and
  // its direction (prev: the same body's face on the frame before, for mouthMoved).
  function faceOf(f, prev) {
    const at = (name) => {
      const i = SHAPES.indexOf(name);
      return i >= 0 ? f.shapes[i] || 0 : 0;
    };
    const r2 = (v) => Math.round(v * 100) / 100;
    const happy = r2((at("mouthSmileLeft") + at("mouthSmileRight")) / 2);
    const eyesClosed = [r2(at("eyeBlinkLeft")), r2(at("eyeBlinkRight"))];
    const mouthOpen = r2(at("jawOpen"));
    const [yaw, pitch] = f.rotation || [0, 0, 0];
    const lookingAway = Math.abs(yaw) > 30 || Math.abs(pitch) > 25;
    const mouthMoved = !!prev && (Math.abs(prev.mouthOpen - mouthOpen) > 0.08 || Math.abs(prev.happy - happy) > 0.1);
    return { box: f.box, points: f.points, rotation: f.rotation, happy, eyesClosed, mouthOpen, mouthMoved, lookingAway, engaged: !lookingAway && eyesClosed[0] < 0.6 && eyesClosed[1] < 0.6, shapes: f.shapes };
  }

  // Each face to the body whose head (its Head joint, or its Neck's) is inside it, or nearest.
  function attachFaces(bodies, faces, previous = []) {
    const free = [...(faces || [])];
    for (const b of bodies) {
      const head = b.joints[J.Head] && b.joints[J.Head].u !== null ? b.joints[J.Head] : b.joints[J.Neck];
      let best = null;
      if (head && head.u !== null) {
        for (const f of free) {
          const cx = (f.box[0] + f.box[2]) / 2, cy = (f.box[1] + f.box[3]) / 2, size = Math.max(0.02, f.box[2] - f.box[0]);
          const d = Math.hypot(cx - head.u, cy - head.v);
          if (d < size * 1.5 && (!best || d < best.d)) best = { d, f };
        }
      }
      if (best) {
        free.splice(free.indexOf(best.f), 1);
        const prev = previous.find((p) => p.id === b.id);
        b.face = faceOf(best.f, prev && prev.face);
      } else delete b.face;
    }
    return bodies;
  }

  function create(opts = {}) {
    let worker = null, busy = false, nextId = 0, failed = "";
    const waiting = new Map();
    const start = () => {
      worker = new Worker("body-finder-worker.js");
      worker.onmessage = (e) => {
        const { id, ok, poses, faces, shapeNames, error } = e.data || {};
        const done = waiting.get(id);
        waiting.delete(id);
        if (!ok) failed = error || "the body model didn't load";
        if (shapeNames) SHAPES = shapeNames;
        if (done) done(ok ? { poses: poses || [], faces: faces || [] } : null);
      };
      worker.onerror = (e) => (failed = (e && e.message) || "the body model stopped");
      worker.postMessage({ id: nextId++, load: true, people: opts.people || 1 });
    };
    start();
    return {
      // One picture (an ImageBitmap of it is made here); null while the last one's still going.
      async detect(image, t, { people = opts.people || 1, faces = 0, poses = true } = {}) {
        if (busy) return null;
        busy = true;
        try {
          const bitmap = await createImageBitmap(image);
          const id = nextId++;
          const got = new Promise((r) => waiting.set(id, r));
          worker.postMessage({ id, bitmap, t, people, faces, poses }, [bitmap]);
          return await got;
        } finally {
          busy = false;
        }
      },
      error: () => failed,
      close() {
        if (worker) worker.terminate();
        worker = null;
        for (const done of waiting.values()) done(null);
        waiting.clear();
      },
    };
  }

  const mid = (a, b) => (a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, Math.min(a[3], b[3])] : null);
  const lerp = (a, b, k) => (a && b ? [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, Math.min(a[3], b[3])] : null);

  // The 25 joints in the picture (u, v, visibility) from MediaPipe's 33; the hand tracker's hand,
  // where one is at that wrist, places the hand, its tip and thumb more exactly.
  function jointsInPicture(lm, handAt) {
    const g = (i) => lm[i] || null;
    const base = mid(g(P.lHip), g(P.rHip)), top = mid(g(P.lShoulder), g(P.rShoulder));
    const head = mid(g(P.lEar), g(P.rEar)) || g(P.nose);
    const side = (wrist, index, pinky, thumb, which) => {
      const hand = handAt(g(wrist), which);
      if (hand) {
        const p = (i) => [hand[i].x, hand[i].y, 0, 1];
        return { hand: lerp(p(0), p(9), 0.5), tip: p(8), thumb: p(4) };
      }
      const knuckles = mid(g(index), g(pinky));
      const palm = lerp(g(wrist), knuckles, 0.6);
      return { hand: palm, tip: lerp(g(wrist), g(index), 1.8), thumb: g(thumb) };
    };
    const L = side(P.lWrist, P.lIndex, P.lPinky, P.lThumb, "Left"), R = side(P.rWrist, P.rIndex, P.rPinky, P.rThumb, "Right");
    const out = new Array(25).fill(null);
    out[J.SpineBase] = base;
    out[J.SpineShoulder] = top;
    out[J.SpineMid] = lerp(base, top, 0.5);
    out[J.Neck] = lerp(top, head, 0.35);
    out[J.Head] = head;
    out[J.ShoulderLeft] = g(P.lShoulder);
    out[J.ElbowLeft] = g(P.lElbow);
    out[J.WristLeft] = g(P.lWrist);
    out[J.HandLeft] = L.hand;
    out[J.HandTipLeft] = L.tip;
    out[J.ThumbLeft] = L.thumb;
    out[J.ShoulderRight] = g(P.rShoulder);
    out[J.ElbowRight] = g(P.rElbow);
    out[J.WristRight] = g(P.rWrist);
    out[J.HandRight] = R.hand;
    out[J.HandTipRight] = R.tip;
    out[J.ThumbRight] = R.thumb;
    out[J.HipLeft] = g(P.lHip);
    out[J.KneeLeft] = g(P.lKnee);
    out[J.AnkleLeft] = g(P.lAnkle);
    out[J.FootLeft] = g(P.lFoot);
    out[J.HipRight] = g(P.rHip);
    out[J.KneeRight] = g(P.rKnee);
    out[J.AnkleRight] = g(P.rAnkle);
    out[J.FootRight] = g(P.rFoot);
    return out;
  }

  // The same joints in MediaPipe's own body space (metres, about the hips), for joints the depth misses.
  function jointsInWorld(w) {
    if (!w || w.length < 33) return null;
    const g = (i) => [...w[i], 1];
    const base = mid(g(P.lHip), g(P.rHip)), top = mid(g(P.lShoulder), g(P.rShoulder)), head = mid(g(P.lEar), g(P.rEar));
    const out = new Array(25).fill(null);
    const set = (name, v) => (out[J[name]] = v);
    set("SpineBase", base); set("SpineShoulder", top); set("SpineMid", lerp(base, top, 0.5)); set("Neck", lerp(top, head, 0.35)); set("Head", head);
    for (const [s, k] of [["Left", "l"], ["Right", "r"]]) {
      set(`Shoulder${s}`, g(P[`${k}Shoulder`])); set(`Elbow${s}`, g(P[`${k}Elbow`])); set(`Wrist${s}`, g(P[`${k}Wrist`]));
      set(`Hand${s}`, lerp(g(P[`${k}Wrist`]), mid(g(P[`${k}Index`]), g(P[`${k}Pinky`])), 0.6)); set(`HandTip${s}`, lerp(g(P[`${k}Wrist`]), g(P[`${k}Index`]), 1.8)); set(`Thumb${s}`, g(P[`${k}Thumb`]));
      set(`Hip${s}`, g(P[`${k}Hip`])); set(`Knee${s}`, g(P[`${k}Knee`])); set(`Ankle${s}`, g(P[`${k}Ankle`])); set(`Foot${s}`, g(P[`${k}Foot`]));
    }
    return out;
  }

  // A hand's state as the Kinect gives it, from what the hand tracker makes of its shape.
  function handState(gesture) {
    if (!gesture) return "notTracked";
    if (/^(Open Palm|Four|Five)$/i.test(gesture)) return "open";
    if (/^Fist$/i.test(gesture)) return "closed";
    if (/^(Peace|Two)$/i.test(gesture)) return "lasso";
    return "unknown";
  }

  // poses: body-finder-worker.js's. at3d(u, v): the depth there as a point (mm) or null.
  // hands: [{ imageLandmarks, handedness, gesture }] (anatomical sides).
  function fromPoses(poses, { at3d = () => null, hands = [], previous = [], faces = null } = {}) {
    const used = new Set();
    const bodies = (poses || []).map((pose) => {
      const lm = pose.landmarks || [];
      if (lm.length < 33) return null;
      // A hand the hand tracker found at this wrist (within a hand's length), for its shape and place.
      const handAt = (wrist, side) => {
        if (!wrist || wrist[3] < MIN_VISIBLE) return null;
        let best = null;
        for (const h of hands) {
          if (!h || !h.imageLandmarks || h.handedness !== side) continue;
          const w = h.imageLandmarks[0], m = h.imageLandmarks[9];
          const size = Math.hypot(m.x - w.x, m.y - w.y) * 2.2 || 0.05;
          const d = Math.hypot(w.x - wrist[0], w.y - wrist[1]);
          if (d < size && (!best || d < best.d)) best = { d, h };
        }
        return best ? best.h.imageLandmarks : null;
      };
      const pic = jointsInPicture(lm, handAt);
      const world = jointsInWorld(pose.world);
      // Each joint's place from the depth where it fits the body (within 0.9 m of its spine's), else
      // from the body model about the hips, else none.
      const at = pic.map((p) => (p && p[3] >= MIN_VISIBLE ? at3d(p[0], p[1]) : null));
      const spine = at[J.SpineMid] || at[J.SpineBase] || at[J.SpineShoulder];
      const anchor = at[J.SpineBase] || (spine && world ? [spine[0] - (world[J.SpineMid][0] - world[J.SpineBase][0]) * 1000, spine[1] - (world[J.SpineMid][1] - world[J.SpineBase][1]) * 1000, spine[2]] : null);
      const joints = pic.map((p, i) => {
        const name = JOINTS[i];
        if (!p) return { name, u: null, v: null, x: null, y: null, z: null, state: "none" };
        const q = at[i];
        if (q && (!spine || Math.abs(q[2] - spine[2]) < 900)) return { name, u: p[0], v: p[1], x: q[0], y: q[1], z: q[2], state: p[3] >= MIN_VISIBLE ? "tracked" : "inferred" };
        if (anchor && world && world[i] && world[J.SpineBase]) {
          const o = world[J.SpineBase];
          return { name, u: p[0], v: p[1], x: anchor[0] + (world[i][0] - o[0]) * 1000, y: anchor[1] + (world[i][1] - o[1]) * 1000, z: anchor[2] + (world[i][2] - o[2]) * 1000, state: "inferred" };
        }
        return { name, u: p[0], v: p[1], x: null, y: null, z: null, state: p[3] >= MIN_VISIBLE ? "inferred" : "none" };
      });
      for (const j of joints) for (const k of ["u", "v"]) if (j[k] !== null) j[k] = Math.round(j[k] * 1e4) / 1e4;
      for (const j of joints) for (const k of ["x", "y", "z"]) if (j[k] !== null) j[k] = Math.round(j[k]);
      // Its hands' states, from the hand tracker's hand at each wrist.
      const sideHand = (side) => {
        const lmh = handAt(pic[J[`Wrist${side}`]], side);
        const h = lmh && hands.find((x) => x.imageLandmarks === lmh);
        return h ? handState(h.gesture) : "notTracked";
      };
      // Leaning: its spine's tilt to its right and forwards (the Kinect's -1 to 1).
      let lean = [0, 0];
      const b = joints[J.SpineBase], s = joints[J.SpineShoulder];
      if (b.z !== null && s.z !== null) {
        const dy = b.y - s.y || 1;
        lean = [Math.max(-1, Math.min(1, Math.atan2(b.x - s.x, dy) / (Math.PI / 4))), Math.max(-1, Math.min(1, Math.atan2(b.z - s.z, dy) / (Math.PI / 4)))].map((v) => Math.round(v * 100) / 100);
      }
      return { id: -1, joints, hands: { left: sideHand("Left"), right: sideHand("Right") }, lean, centre: [pic[J.SpineMid] ? pic[J.SpineMid][0] : 0.5, pic[J.SpineMid] ? pic[J.SpineMid][1] : 0.5] };
    }).filter(Boolean);
    // Ids kept while each body stays about where it was (the nearest of the last ones).
    for (const body of bodies) {
      let best = null;
      for (const p of previous) {
        if (used.has(p.id)) continue;
        const d = Math.hypot(p.centre[0] - body.centre[0], p.centre[1] - body.centre[1]);
        if (d < 0.25 && (!best || d < best.d)) best = { d, id: p.id };
      }
      if (best) {
        body.id = best.id;
        used.add(best.id);
      }
    }
    for (const body of bodies) {
      if (body.id >= 0) continue;
      let id = 0;
      while (used.has(id)) id++;
      body.id = id;
      used.add(id);
    }
    if (faces) attachFaces(bodies, faces, previous);
    return bodies;
  }

  function draw(ctx, bodies, toCanvas, unit = 1) {
    for (const body of bodies || []) {
      const color = COLORS[body.id % COLORS.length];
      const pt = (j) => (j && j.u !== null && j.state !== "none" ? toCanvas({ x: j.u, y: j.v }) : null);
      ctx.save();
      ctx.lineWidth = 3 * unit;
      ctx.lineCap = "round";
      for (const [a, b] of BONES) {
        const p = pt(body.joints[a]), q = pt(body.joints[b]);
        if (!p || !q) continue;
        ctx.strokeStyle = color;
        ctx.globalAlpha = body.joints[a].state === "tracked" && body.joints[b].state === "tracked" ? 0.9 : 0.4;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (const j of body.joints) {
        const p = pt(j);
        if (!p) continue;
        ctx.fillStyle = j.state === "tracked" ? color : "#ffffff88";
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.5 * unit, 0, 2 * Math.PI);
        ctx.fill();
      }
      // Its face: a box, and what it shows (in normal reading order on a mirrored picture too).
      if (body.face && body.face.box) {
        const [x0, y0, x1, y1] = body.face.box;
        const a = toCanvas({ x: x0, y: y0 }), z = toCanvas({ x: x1, y: y1 });
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 * unit;
        ctx.strokeRect(Math.min(a.x, z.x), Math.min(a.y, z.y), Math.abs(z.x - a.x), Math.abs(z.y - a.y));
        const f = body.face, words = [];
        if (f.happy > 0.5) words.push("happy");
        if (f.eyesClosed[0] > 0.6 && f.eyesClosed[1] > 0.6) words.push("eyes closed");
        if (f.mouthOpen > 0.3) words.push("mouth open");
        words.push(f.lookingAway ? "looking away" : "engaged");
        ctx.font = `${12 * unit}px sans-serif`;
        ctx.fillStyle = color;
        ctx.fillText(words.join(" · "), Math.min(a.x, z.x), Math.max(a.y, z.y) + 14 * unit);
      }
      // Each hand's state, as the Kinect draws it: green open, red closed, blue lasso.
      for (const [side, name] of [["left", "HandLeft"], ["right", "HandRight"]]) {
        const fill = { open: "#51cf6688", closed: "#ff6b6b88", lasso: "#4dabf788" }[body.hands[side]];
        const p = fill && pt(body.joints[J[name]]);
        if (!p) continue;
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 16 * unit, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // (setShapes: the expression scores' names, as the worker gives them; the checks give them here.)
  global.BodyTracker = { create, fromPoses, attachFaces, draw, handState, JOINTS, BONES, shapes: () => SHAPES, setShapes: (names) => (SHAPES = Array.isArray(names) ? names.slice() : []) };
})(window);
