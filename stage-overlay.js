/**
 * stage-overlay.js — what's drawn over the picture besides the skeleton: the tag at each
 * wrist (which hand, its gesture, how sure, how far), a box around each hand, and in
 * far-away mode the body found and the square searched. Drawn on the stage canvas so
 * recorded video has it too, in normal (unflipped) orientation so text reads the right way
 * round in mirrored view. Shared by the main window (app.js) and each camera of "Several
 * cameras" (camera-tile.js), so More settings' Show buttons work the same in both.
 *
 *   const overlay = StageOverlay.create(stageCanvas, { phone });
 *   overlay.draw(hands, { display, far, gestureOf, objects });
 *     display: the Show buttons ({ box, side, scores, gesture, distance, focus, objects });
 *     far: far-away hands is on (the search area is drawn with display.focus);
 *     gestureOf(hand) -> { label } (gestures.js);
 *     objects: what an OAK camera found ([{ label, score, box: [x0, y0, x1, y1] (0-1 of its own
 *       picture), xyz: [x, y, z] mm }]), drawn with display.objects.
 */

(function (global) {
  const SIDE_COLORS = { Left: "#4dabf7", Right: "#ff922b" };
  // How big a hand's tag is drawn, from how big the hand looks, i.e. how far away it is. Its
  // palm (wrist to middle knuckle) is about a fifth of the picture's height at arm's length
  // from a webcam: there and closer, the tag is its normal size (scale 1). Further away it
  // grows as the hand shrinks (twice as far, twice as big, up to TAG_MAX_SCALE), so it stays
  // readable from across the room. On a phone it starts a little bigger (its screen is small)
  // and grows less (so does its picture).
  const TAG_MAX_SCALE = 2;
  const TAG_MAX_SCALE_PHONE = 1.6;
  const pct = (v) => `${Math.round(v * 100)}%`;

  // The tag drawn next to each wrist: which hand, its gesture, and (when shown) how sure
  // the tracker is and how far the hand is from a depth camera.
  function labelText(hand, display, gestureOf) {
    const parts = [];
    if (display.side) parts.push(display.scores && hand.handednessConfidence ? `${hand.handedness} ${pct(hand.handednessConfidence)}` : hand.handedness);
    const gesture = gestureOf ? gestureOf(hand) : null;
    if (display.gesture && gesture && gesture.label !== "—") parts.push(gesture.label);
    if (display.scores && hand.trackingScore !== null && hand.trackingScore !== undefined) parts.push(`hand ${pct(hand.trackingScore)}`);
    if (display.distance && hand.distance) parts.push(`${(hand.distance[2] / 1000).toFixed(2)} m`);
    return parts.join(" · ");
  }

  // A box around the hand, turned with it (wrist to middle knuckle is "up"), like the
  // region MediaPipe tracks each hand in.
  function drawHandBox(ctx, hand, unit) {
    const p = hand.imageLandmarks.map((q) => HandTracker.toCanvasPoint(q));
    let ux = p[9].x - p[0].x, uy = p[9].y - p[0].y;
    const len = Math.hypot(ux, uy) || 1;
    ux /= len;
    uy /= len;
    const vx = -uy, vy = ux;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of p) {
      const u = q.x * ux + q.y * uy, v = q.x * vx + q.y * vy;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u);
      v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const mu = (u1 - u0) * 0.1, mv = (v1 - v0) * 0.1;
    const corner = (u, v) => [u * ux + v * vx, u * uy + v * vy];
    const pts = [corner(u0 - mu, v0 - mv), corner(u1 + mu, v0 - mv), corner(u1 + mu, v1 + mv), corner(u0 - mu, v1 + mv)];
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.lineWidth = 2 * unit;
    ctx.strokeStyle = SIDE_COLORS[hand.handedness] || "#adb5bd";
    ctx.setLineDash([8 * unit, 5 * unit]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Far-away hands: the body the pose model found and the square searched for hands.
  function drawFocus(ctx, unit) {
    const { region, body } = HandTracker.getFocus();
    if (body && performance.now() - body.time < 1500) {
      ctx.fillStyle = "#fcc419";
      ctx.strokeStyle = "rgba(252, 196, 25, 0.7)";
      ctx.lineWidth = 2 * unit;
      const pt = (q) => (q ? HandTracker.toCanvasPoint(q) : null);
      for (const side of ["Left", "Right"]) {
        const chain = [body.shoulders[side], body.elbows[side], body.wrists[side]].map(pt);
        ctx.beginPath();
        let started = false;
        for (const q of chain) {
          if (!q) { started = false; continue; }
          if (started) ctx.lineTo(q.x, q.y);
          else ctx.moveTo(q.x, q.y);
          started = true;
        }
        ctx.stroke();
        for (const q of chain) if (q) ctx.fillRect(q.x - 3 * unit, q.y - 3 * unit, 6 * unit, 6 * unit);
      }
    }
    if (region) {
      const a = HandTracker.toCanvasPoint({ x: region.x, y: region.y });
      const b = HandTracker.toCanvasPoint({ x: region.x + region.w, y: region.y + region.h });
      ctx.lineWidth = 2 * unit;
      ctx.strokeStyle = "#fcc419";
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    }
  }

  // Objects an OAK camera found: a box each, with what it is (how sure, with Scores) and how
  // far away (with Distance, from a depth camera). People yellow, animals purple, the rest grey.
  const OBJECT_NAMES = { diningtable: "table", pottedplant: "plant", tvmonitor: "screen", motorbike: "motorbike", aeroplane: "plane" };
  const objectColor = (label) => (label === "person" ? "#fcc419" : ["cat", "dog", "bird", "horse", "sheep", "cow"].includes(label) ? "#da77f2" : "#adb5bd");
  function drawObjects(ctx, objects, display, unit) {
    for (const o of objects) {
      if (!o || !Array.isArray(o.box)) continue;
      const [x0, y0, x1, y1] = o.box;
      const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => HandTracker.sourceToCanvas({ x, y }));
      const left = Math.min(...pts.map((p) => p.x)), right = Math.max(...pts.map((p) => p.x));
      const top = Math.min(...pts.map((p) => p.y)), bottom = Math.max(...pts.map((p) => p.y));
      const color = objectColor(o.label);
      ctx.lineWidth = 2 * unit;
      ctx.strokeStyle = color;
      ctx.strokeRect(left, top, right - left, bottom - top);
      const parts = [OBJECT_NAMES[o.label] || o.label];
      if (display.scores && typeof o.score === "number") parts.push(pct(o.score));
      if (display.distance && Array.isArray(o.xyz) && o.xyz[2] > 0) parts.push(`${(o.xyz[2] / 1000).toFixed(1)} m`);
      const text = parts.join(" · ");
      ctx.font = `600 ${Math.round(14 * unit)}px "Segoe UI", system-ui, sans-serif`;
      const tw = ctx.measureText(text).width + 12 * unit, th = 22 * unit;
      const ty = top - th >= 0 ? top - th : top;
      ctx.fillStyle = "rgba(14, 15, 18, 0.8)";
      ctx.fillRect(left, ty, tw, th);
      ctx.fillStyle = color;
      ctx.textBaseline = "middle";
      ctx.fillText(text, left + 6 * unit, ty + th / 2);
    }
  }

  function create(stage, { phone = false } = {}) {
    const labelScales = {}; // smoothed per side, so a tag doesn't flicker with small movements
    function labelScale(hand) {
      const a = HandTracker.toCanvasPoint(hand.imageLandmarks[0]), b = HandTracker.toCanvasPoint(hand.imageLandmarks[9]);
      const palm = Math.hypot(b.x - a.x, b.y - a.y) / stage.height;
      const target = Math.min(TAG_MAX_SCALE, Math.max(1, 0.2 / Math.max(palm, 1e-3)));
      const prev = labelScales[hand.handedness];
      const k = prev === undefined ? target : prev + (target - prev) * 0.25;
      labelScales[hand.handedness] = k;
      return k;
    }

    function draw(hands, { display, far = false, gestureOf = null, objects = null }) {
      const ctx = stage.getContext("2d");
      const unit = Math.max(1, stage.width / 640);
      ctx.save();
      if (objects && objects.length && display.objects !== false) drawObjects(ctx, objects, display, unit);
      if (display.focus && far) drawFocus(ctx, unit);
      if (display.box) for (const hand of hands) drawHandBox(ctx, hand, unit);
      ctx.textBaseline = "middle";
      for (const hand of hands) {
        const text = labelText(hand, display, gestureOf);
        if (!text) continue;
        const wrist = HandTracker.toCanvasPoint(hand.imageLandmarks[0]);
        const color = SIDE_COLORS[hand.handedness] || "#adb5bd";
        // Normal size up close (a little bigger on a phone's small screen), bigger as the hand
        // goes further away so it can still be read, never more than TAG_MAX_SCALE (less on a
        // phone, where the picture is small).
        const k = unit * Math.min(phone ? TAG_MAX_SCALE_PHONE : TAG_MAX_SCALE, (phone ? 1.3 : 1) * labelScale(hand));
        const h = 30 * k;
        const padX = 12 * k;
        ctx.font = `600 ${Math.round(17 * k)}px "Segoe UI", system-ui, sans-serif`;
        const w = ctx.measureText(text).width + padX * 2;
        const x = Math.min(Math.max(wrist.x - w / 2, 4), stage.width - w - 4);
        const y = Math.min(Math.max(wrist.y + 16 * unit, 4), stage.height - h - 4); // just below the wrist, however big

        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, w, h, h / 2);
        else ctx.rect(x, y, w, h);
        ctx.fillStyle = "rgba(14, 15, 18, 0.8)";
        ctx.fill();
        ctx.lineWidth = 2 * k;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.fillText(text, x + padX, y + h / 2);
      }
      ctx.restore();
    }

    return { draw };
  }

  global.StageOverlay = { create, SIDE_COLORS };
})(window);
