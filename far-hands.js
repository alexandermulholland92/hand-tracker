/**
 * far-hands.js
 * Finds where to look for far-away hands: runs MediaPipe Pose (the lite body model) on a
 * picture and works out a square around the wrists, which hand-tracker.js then gives to
 * the hand detector instead of the whole picture (see "Far-away hands" there).
 *
 * The square's size comes from the body in the picture: the longest visible arm or torso
 * segment, so it shrinks as the person walks away. Adapted from the Body Pre Focusing in
 * geaxgx/depthai_hand_tracker (MIT licence, see THIRD_PARTY_NOTICES.md), which uses the same idea with
 * MoveNet on Luxonis cameras.
 *
 *   FarHands.load();                    // starts loading the body model (only when far mode is on)
 *   await FarHands.detect(image);       // -> { time, wrists, elbows, shoulders, hips } (fractions
 *                                       //    of the picture, anatomical Left/Right) or null
 *   FarHands.zone(body, width, height, { raisedOnly, focus: "both" | "higher" | "left" | "right" })
 *                                       // -> { x, y, s } square in pixels (may run off the edge) or null
 */

(function (global) {
  const POSE_PATH = "node_modules/@mediapipe/pose/";
  const MIN_VISIBILITY = 0.5;
  // Zone size, in lengths of the longest visible body segment. 1.5 found both hands in
  // photos of a person 4-5 m away; 1.0 missed a lowered hand.
  const ZONE_SCALE = 1.5;

  let pose = null;
  let loading = null;
  let latest = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error("the body-pose model couldn't be loaded"));
      document.head.appendChild(el);
    });
  }

  function load() {
    if (loading) return loading;
    loading = (global.Pose ? Promise.resolve() : loadScript(`${POSE_PATH}pose.js`))
      .then(async () => {
        const model = new global.Pose({ locateFile: (file) => `${POSE_PATH}${file}` });
        model.setOptions({
          modelComplexity: 0, // lite: fast, and wrists are all we need
          smoothLandmarks: false, // it only runs now and then, while no hand is tracked
          enableSegmentation: false,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        model.onResults((results) => {
          latest = results;
        });
        await model.initialize();
        pose = model;
      })
      .catch((err) => {
        loading = null; // try again next time far mode is turned on
        throw err;
      });
    return loading;
  }

  // The body's key points in one picture, or null (no body, or the model is still loading:
  // then the whole picture is searched meanwhile).
  async function detect(image) {
    if (!pose) {
      load().catch(() => {});
      return null;
    }
    latest = null;
    await pose.send({ image });
    const P = latest && latest.poseLandmarks;
    if (!P) return null;
    const pt = (i) => (P[i] && (P[i].visibility === undefined || P[i].visibility >= MIN_VISIBILITY) ? { x: P[i].x, y: P[i].y } : null);
    // MediaPipe Pose's left and right are the person's own (checked on photos).
    return {
      time: performance.now(),
      shoulders: { Left: pt(11), Right: pt(12) },
      elbows: { Left: pt(13), Right: pt(14) },
      wrists: { Left: pt(15), Right: pt(16) },
      hips: { Left: pt(23), Right: pt(24) },
    };
  }

  // The square to search, in pixels of a width x height picture.
  function zone(body, width, height, { raisedOnly = true, focus = "both" } = {}) {
    const px = (p) => (p ? { x: p.x * width, y: p.y * height } : null);
    const part = (group, side) => px(body[group][side]);
    const segments = [
      ["shoulders", "Left", "elbows", "Left"],
      ["elbows", "Left", "wrists", "Left"],
      ["shoulders", "Left", "hips", "Left"],
      ["shoulders", "Left", "shoulders", "Right"],
      ["shoulders", "Right", "elbows", "Right"],
      ["elbows", "Right", "wrists", "Right"],
      ["shoulders", "Right", "hips", "Right"],
    ];
    const lengths = [];
    for (const [g1, s1, g2, s2] of segments) {
      const a = part(g1, s1), b = part(g2, s2);
      if (a && b) lengths.push(Math.hypot(a.x - b.x, a.y - b.y));
    }
    if (!lengths.length) return null; // too close to see a body: search the whole picture
    const torso = (body.hips.Left || body.hips.Right) && (body.shoulders.Left || body.shoulders.Right);
    const size = Math.max(...lengths) * (torso ? 1 : 1.5) * ZONE_SCALE;

    // A square around one wrist; with raisedOnly, not for a hand hanging below its elbow.
    const around = (side) => {
      const wrist = part("wrists", side);
      if (!wrist) return null;
      const elbow = part("elbows", side);
      if (raisedOnly && elbow && elbow.y < wrist.y) return null;
      return { x: wrist.x - size / 2, y: wrist.y - size / 2, s: size };
    };

    if (focus === "left" || focus === "right") return around(focus === "left" ? "Left" : "Right");
    if (focus === "higher") {
      const l = part("wrists", "Left"), r = part("wrists", "Right");
      if (!l && !r) return null;
      return around(!r || (l && l.y < r.y) ? "Left" : "Right");
    }
    const a = around("Left"), b = around("Right");
    if (!a || !b) return a || b;
    // Both: one square around the two.
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
    const x1 = Math.max(a.x + a.s, b.x + b.s), y1 = Math.max(a.y + a.s, b.y + b.s);
    const s = Math.max(x1 - x0, y1 - y0);
    return { x: (x0 + x1) / 2 - s / 2, y: (y0 + y1) / 2 - s / 2, s };
  }

  global.FarHands = { load, detect, zone, isReady: () => !!pose };
})(window);
