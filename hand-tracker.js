/**
 * hand-tracker.js
 * Lightweight real-time hand landmark tracker using MediaPipe Hands.
 * Supports up to 2 hands, tracked independently by handedness (Left/Right).
 *
 *   await HandTracker.init({ videoEl, canvasEl, overlay: true, mirror: true, maxNumHands: 2,
 *                            deviceId, width: 1280, height: 720 });
 *   HandTracker.onHandLandmarks((data) => { ... });   // fires every processed frame, even with 0 hands
 *     data = { hands: [{ landmarks, imageLandmarks, rawImageLandmarks, handedness, handednessScore, features, orientation }, ...], timestamp }
 *     imageLandmarks are smoothed (see "Smoothing" below); rawImageLandmarks are MediaPipe's, unfiltered
 *     orientation = { palm: quaternion, palmEuler: {yaw,pitch,roll} degrees, bones: {thumb..pinky: quaternion} }
 *   HandTracker.setOverlay(true/false);   // skeleton on/off (the camera image is always drawn)
 *   HandTracker.setMirror(true/false);    // selfie-style mirrored display; overlays drawn afterwards stay readable
 *   HandTracker.setCamera({ deviceId, width, height });   // switch camera / resolution
 *   HandTracker.setCamera({ desktopSourceId, desktopName, crop }); // track a screen or window (Windows app),
 *                                         // optionally just crop = { x, y, w, h } (fractions of it)
 *   await HandTracker.useVideoFile(url, { name, mirrored }); // track a video file instead of the camera;
 *                                         // mirrored: it was recorded mirrored (see "Mirrored videos")
 *   await HandTracker.setFileMirrored(true/false);         // change that for the open video
 *   HandTracker.file.play() / pause() / seek(s) / setRate(r) / time() / duration() / fps() / playing()
 *   HandTracker.onVideoEnded(() => { ... });               // the video file reached its end
 *   await HandTracker.useCamera();                         // back to the live camera
 *   HandTracker.onCameraStatus((status) => { ... });      // "stalled" while reconnecting, then "ok"
 *   HandTracker.onSourceChange((camera) => { ... });      // a camera or video file was opened, before its
 *                                                         // first frame is drawn; camera = getCamera()
 *   HandTracker.getCamera();              // { source, deviceId, facing: "user" | "environment" | null, width, height,
 *                                         //   screen: true for a screen/window source, name, crop }
 *   HandTracker.listCameras();            // [{ deviceId, label }]
 *   HandTracker.setModelComplexity(0 | 1);   // 0 = lite/fast, 1 = full/accurate
 *   HandTracker.setMaxHands(1 | 2);          // how many hands to track at once
 *   HandTracker.getFeatures("Left" | "Right"); // single hand's features
 *   HandTracker.getFrameImage();          // the picture being tracked (the video, or a flipped/cropped copy)
 *   HandTracker.stop();
 *
 * Pipeline (per hand):
 *   webcam or video file -> MediaPipe Hands inference -> 21 landmarks
 *   -> matched to the hands already being tracked (steady Left/Right labels)
 *   -> One Euro smoothing -> features, orientation, wrist-relative landmarks -> callback
 *
 * Smoothing: MediaPipe's landmarks jitter by a few pixels from frame to frame even
 * when the hand is still. Each landmark goes through a One Euro filter (Casiez et al.,
 * CHI 2012), a low-pass filter whose cutoff rises with speed: a still or slow hand is
 * smoothed strongly, a fast one hardly at all, so there's little lag. Speeds are in
 * hand lengths per second, so near and far hands behave the same. Everything else
 * (the drawn skeleton, gestures, finger curl, palm angles, wrist speed, recordings)
 * is computed from the smoothed landmarks.
 *
 * Handedness is reported as the user's actual (anatomical) hand. MediaPipe
 * assumes a mirrored selfie image, but we feed it the raw camera frame, so its
 * labels are swapped here once instead of in every consumer.
 *
 * Mirrored videos: many phones and camera apps save front-camera videos mirrored, the
 * way the preview looked. In those, every hand looks like the other one, so each would
 * be labelled the wrong side and move the wrong way. With mirrored set, each frame is
 * flipped back before MediaPipe sees it, so labels, positions and everything computed
 * from them are as a normal camera would have seen them.
 */

(function (global) {
  const LM = {
    WRIST: 0,
    THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
    INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
    MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
    RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
    PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
  };

  // One Euro filter settings, tuned on MediaPipe landmarks from real hand videos:
  // cutoff (Hz) = MIN_CUTOFF + BETA × speed (hand lengths/s), speed low-passed at D_CUTOFF.
  const SMOOTHING = { minCutoff: 1.0, beta: 3.0, dCutoff: 1.0 };
  // Landmarks that move more than this (average, in hand lengths) between two frames
  // have jumped (a re-detection or a tracking glitch): the filter restarts there
  // rather than sliding across.
  const JUMP_HAND_LENGTHS = 1.5;
  // MediaPipe must call a hand the other side this many frames in a row before its label changes.
  const LABEL_FLIP_FRAMES = 6;
  const HANDS_ASSET_PATH = "node_modules/@mediapipe/hands/";
  // A hand unseen for longer than this is treated as a brand-new hand when it
  // returns, so smoothing/velocity never blend with a stale pose.
  const STALE_MS = 250;
  // A running camera that delivers no new frame for STALL_MS has stalled (driver
  // hiccup, unplugged): it's reopened and retried until it's back. Before the
  // first frame arrives, allow longer: some webcams take seconds to start.
  const STALL_MS = 4000;
  const FIRST_FRAME_MS = 15000;

  let hands = null;
  let videoEl = null;
  let canvasEl = null;
  let ctx = null;
  let stream = null;
  let overlay = true;
  let mirror = true;
  let callbacks = [];
  let statusCallbacks = [];
  let sourceCallbacks = [];
  let cameraStalled = false;
  let maxHands = 2;
  let modelComplexity = 0;
  // desktopSourceId: a screen or window (Electron desktopCapturer id) instead of a camera;
  // crop: the part of the picture to track, as fractions { x, y, w, h }.
  let cameraOpts = { deviceId: null, width: 1280, height: 720, facing: null, desktopSourceId: null, desktopName: "", crop: null };
  let frameCanvas = null; // the cropped or flipped picture, when MediaPipe doesn't see the video as it is
  let lastFrame = null; // the picture MediaPipe was last given
  let fileMirrored = false; // the video file was recorded mirrored: flip it back (see "Mirrored videos")
  let restartTracking = false; // the picture changed abruptly: forget the hands MediaPipe was following
  let loopId = 0; // bumping this cancels the running capture loop
  let source = "camera"; // "camera" | "file"
  let frameTime = null; // ms timestamp of the video-file frame being processed (null: use the clock)
  let file = null; // { name, playing, rate, lastMediaTime, intervals } while a video file is the source
  let endedCallbacks = [];
  let inflight = Promise.resolve(); // the frame MediaPipe is working on right now
  let switching = false; // while swapping camera/file, late results from the old source are dropped

  // Per-hand state, keyed by handedness label ("Left" / "Right"), so
  // smoothing/velocity stay stable even if MediaPipe's array order
  // changes between frames.
  const state = {}; // { Left: { filter, flipVotes, lastFeatures, lastSeen }, Right: {...} }

  function freshState() {
    return { filter: null, flipVotes: 0, lastFeatures: null, lastSeen: null };
  }

  // A hand seen recently enough to carry on smoothing from (not after a gap or a seek back).
  function isLive(s, timestamp) {
    return !!s && s.lastSeen !== null && timestamp >= s.lastSeen && timestamp - s.lastSeen <= STALE_MS;
  }

  function getState(label, timestamp) {
    if (!isLive(state[label], timestamp) && !(state[label] && state[label].lastSeen === null)) {
      state[label] = freshState();
    }
    state[label].lastSeen = timestamp;
    return state[label];
  }

  // ---------- One Euro smoothing ----------
  const lowPassAlpha = (cutoffHz, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoffHz * dt));

  // Hand size in the picture: wrist to middle-finger knuckle.
  const handLength = (lm) => Math.max(1e-3, Math.hypot(lm[LM.MIDDLE_MCP].x - lm[LM.WRIST].x, lm[LM.MIDDLE_MCP].y - lm[LM.WRIST].y));

  // raw: MediaPipe's 21 landmarks this frame -> the smoothed landmarks.
  // s.filter keeps each landmark's smoothed position and speed (hand lengths/s).
  function smoothLandmarks(raw, timestamp, s) {
    const scale = handLength(raw);
    const f = s.filter;
    if (f && timestamp <= f.t) return f.pos.map(([x, y, z]) => ({ x, y, z })); // the same frame again
    let jumped = false;
    if (f) {
      let moved = 0;
      for (let i = 0; i < raw.length; i++) moved += Math.hypot(raw[i].x - f.pos[i][0], raw[i].y - f.pos[i][1]) / scale;
      jumped = moved / raw.length > JUMP_HAND_LENGTHS;
    }
    if (!f || jumped) {
      s.filter = { t: timestamp, scale, pos: raw.map((p) => [p.x, p.y, p.z]), vel: raw.map(() => [0, 0, 0]) };
      return raw.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    }
    const dt = (timestamp - f.t) / 1000;
    const aD = lowPassAlpha(SMOOTHING.dCutoff, dt);
    for (let i = 0; i < raw.length; i++) {
      const pos = f.pos[i], vel = f.vel[i];
      const now = [raw[i].x, raw[i].y, raw[i].z];
      for (let k = 0; k < 3; k++) vel[k] += aD * ((now[k] - pos[k]) / dt / scale - vel[k]);
      const cutoff = SMOOTHING.minCutoff + SMOOTHING.beta * Math.hypot(vel[0], vel[1], vel[2]);
      const a = lowPassAlpha(cutoff, dt);
      for (let k = 0; k < 3; k++) pos[k] += a * (now[k] - pos[k]);
    }
    f.t = timestamp;
    f.scale = scale;
    return f.pos.map(([x, y, z]) => ({ x, y, z }));
  }

  // ---------- Which hand is which ----------
  // MediaPipe labels each hand Left or Right on every frame, and now and then flips a
  // label for a frame or two, which swapped the hand cards and restarted smoothing.
  // Each detection is matched to the hands tracked on the previous frames, mostly by
  // where it is (MediaPipe's label breaks ties), and a tracked hand only changes label
  // once MediaPipe has called it the other side LABEL_FLIP_FRAMES frames in a row.
  function assignLabels(rawList, handednessList, timestamp) {
    const dets = rawList.map((raw, i) => {
      const h = handednessList[i];
      return { raw, said: h ? swapLabel(h.label) : null, score: h ? h.score : 0, scale: handLength(raw) };
    });
    const cost = (d, label) => {
      const s = state[label];
      const tracked = isLive(s, timestamp) && s.filter;
      const distance = tracked
        ? Math.hypot(d.raw[LM.WRIST].x - s.filter.pos[LM.WRIST][0], d.raw[LM.WRIST].y - s.filter.pos[LM.WRIST][1]) / d.scale
        : 3; // starting a new hand
      return Math.min(distance, 3) + (d.said && d.said !== label ? 1.5 : 0);
    };
    let best = null;
    const options = dets.length === 1 ? [["Left"], ["Right"]] : dets.length === 2 ? [["Left", "Right"], ["Right", "Left"]] : [];
    for (const labels of options) {
      const total = labels.reduce((sum, label, i) => sum + cost(dets[i], label), 0);
      if (!best || total < best.total) best = { labels, total };
    }
    const labels = best ? best.labels : dets.map((_, i) => `Hand${i}`);

    return dets.map((d, i) => {
      let label = labels[i];
      const s = state[label];
      if (d.said && d.said !== label && isLive(s, timestamp)) {
        // MediaPipe disagrees: count it, and follow MediaPipe once it keeps disagreeing.
        s.flipVotes++;
        const other = swapLabel(label);
        if (s.flipVotes >= LABEL_FLIP_FRAMES && !labels.includes(other)) {
          s.flipVotes = 0;
          state[other] = s;
          delete state[label];
          label = other;
        }
      } else if (s) {
        s.flipVotes = 0;
      }
      return { label, score: d.score };
    });
  }

  // --- FPS: processed (inferred) frames per second, measured continuously ---
  let frameCount = 0, fpsLastTime = performance.now(), fps = 0;

  function tickFps() {
    frameCount++;
    const now = performance.now();
    if (now - fpsLastTime >= 500) {
      fps = Math.round((frameCount * 1000) / (now - fpsLastTime));
      frameCount = 0;
      fpsLastTime = now;
    }
  }

  function distance3D(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
  }

  // Angle (degrees) at point b, formed by rays b->a and b->c
  function angleAt(a, b, c) {
    const v1 = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
    const v2 = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
    const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
    const mag1 = Math.hypot(v1.x, v1.y, v1.z);
    const mag2 = Math.hypot(v2.x, v2.y, v2.z);
    if (mag1 === 0 || mag2 === 0) return 180;
    const cos = Math.min(1, Math.max(-1, dot / (mag1 * mag2)));
    return (Math.acos(cos) * 180) / Math.PI;
  }

  // 0 = straight, 1 = fully curled
  function curlFromAngle(angleDeg) {
    return Math.min(1, Math.max(0, 1 - angleDeg / 180));
  }

  // --- Orientation math (position-only landmarks -> rotation quaternions) ---
  function subVec(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  function crossVec(a, b) {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
  }
  function dotVec(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function normVec(v) {
    const len = Math.hypot(v.x, v.y, v.z) || 1e-6;
    return { x: v.x / len, y: v.y / len, z: v.z / len };
  }

  // Shortest-arc quaternion that rotates unit vector u onto unit vector v.
  function quatFromVectors(u, v) {
    const d = dotVec(u, v);
    if (d > 0.999999) return { w: 1, x: 0, y: 0, z: 0 };
    if (d < -0.999999) {
      let axis = crossVec({ x: 1, y: 0, z: 0 }, u);
      if (Math.hypot(axis.x, axis.y, axis.z) < 1e-6) axis = crossVec({ x: 0, y: 1, z: 0 }, u);
      axis = normVec(axis);
      return { w: 0, x: axis.x, y: axis.y, z: axis.z };
    }
    const axis = crossVec(u, v);
    const s = Math.sqrt((1 + d) * 2);
    return { w: s * 0.5, x: axis.x / s, y: axis.y / s, z: axis.z / s };
  }

  // Rotation matrix (given as 3 orthonormal axes) -> quaternion.
  function matrixToQuat(xAxis, yAxis, zAxis) {
    const m00 = xAxis.x, m10 = xAxis.y, m20 = xAxis.z;
    const m01 = yAxis.x, m11 = yAxis.y, m21 = yAxis.z;
    const m02 = zAxis.x, m12 = zAxis.y, m22 = zAxis.z;
    const trace = m00 + m11 + m22;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1);
      return { w: 0.25 / s, x: (m21 - m12) * s, y: (m02 - m20) * s, z: (m10 - m01) * s };
    } else if (m00 > m11 && m00 > m22) {
      const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
      return { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s };
    } else if (m11 > m22) {
      const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
      return { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s };
    } else {
      const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
      return { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s };
    }
  }

  // Quaternion -> Euler angles (degrees) for human-readable display.
  function quatToEuler(q) {
    const sinr_cosp = 2 * (q.w * q.x + q.y * q.z);
    const cosr_cosp = 1 - 2 * (q.x * q.x + q.y * q.y);
    const roll = Math.atan2(sinr_cosp, cosr_cosp);

    const sinp = 2 * (q.w * q.y - q.z * q.x);
    const pitch = Math.abs(sinp) >= 1 ? (Math.sign(sinp) * Math.PI) / 2 : Math.asin(sinp);

    const siny_cosp = 2 * (q.w * q.z + q.x * q.y);
    const cosy_cosp = 1 - 2 * (q.y * q.y + q.z * q.z);
    const yaw = Math.atan2(siny_cosp, cosy_cosp);

    const toDeg = 180 / Math.PI;
    return { roll: roll * toDeg, pitch: pitch * toDeg, yaw: yaw * toDeg };
  }

  // Palm orientation from 3 landmarks -> a local coordinate frame -> quaternion.
  function computePalmOrientation(raw) {
    const wrist = raw[LM.WRIST];
    const indexMcp = raw[LM.INDEX_MCP];
    const pinkyMcp = raw[LM.PINKY_MCP];
    const middleMcp = raw[LM.MIDDLE_MCP];

    const xAxis = normVec(subVec(pinkyMcp, indexMcp));       // across the palm
    const yGuess = normVec(subVec(middleMcp, wrist));        // up the hand
    const zAxis = normVec(crossVec(xAxis, yGuess));          // palm normal
    const yAxis = normVec(crossVec(zAxis, xAxis));           // re-orthogonalized

    return matrixToQuat(xAxis, yAxis, zAxis);
  }

  const FINGER_BONES = {
    thumb: [LM.THUMB_CMC, LM.THUMB_MCP],
    index: [LM.INDEX_MCP, LM.INDEX_PIP],
    middle: [LM.MIDDLE_MCP, LM.MIDDLE_PIP],
    ring: [LM.RING_MCP, LM.RING_PIP],
    pinky: [LM.PINKY_MCP, LM.PINKY_PIP],
  };
  const UP = { x: 0, y: 1, z: 0 };

  // One quaternion per finger's proximal bone, relative to a fixed reference axis.
  function computeBoneOrientations(raw) {
    const out = {};
    for (const [name, [a, b]] of Object.entries(FINGER_BONES)) {
      const dir = normVec(subVec(raw[b], raw[a]));
      out[name] = quatFromVectors(UP, dir);
    }
    return out;
  }

  function normalizeRelativeToWrist(raw) {
    const wrist = raw[LM.WRIST];
    return raw.map((p) => ({
      x: p.x - wrist.x,
      y: p.y - wrist.y,
      z: p.z - wrist.z,
    }));
  }

  // Gesture-ready helper features computed from the smoothed image-space (0-1,
  // not wrist-relative) landmarks, so distances and speeds are in a stable frame.
  function computeFeatures(rawLandmarks, timestamp, s) {
    const thumbIndexDistance = distance3D(
      rawLandmarks[LM.THUMB_TIP],
      rawLandmarks[LM.INDEX_TIP]
    );

    const wrist = rawLandmarks[LM.WRIST];
    // Wrist velocity in image units per second: the One Euro filter's own low-passed
    // speed estimate, which is far steadier than differencing two noisy frames.
    const v = s.filter ? s.filter.vel[LM.WRIST].map((c) => c * s.filter.scale) : [0, 0, 0];
    const velocity = { x: v[0], y: v[1], z: v[2], speed: Math.hypot(v[0], v[1], v[2]) };

    // The (smoothed) wrist in the picture — the closest thing to a "world"
    // trajectory reference we have from a single camera.
    // NOTE: this is camera-frame, not true calibrated 3D world space; a
    // monocular webcam cannot fully achieve camera-position invariance.
    const worldWrist = { x: wrist.x, y: wrist.y, z: wrist.z };

    const fingerCurls = {
      thumb: curlFromAngle(
        angleAt(rawLandmarks[LM.THUMB_CMC], rawLandmarks[LM.THUMB_MCP], rawLandmarks[LM.THUMB_TIP])
      ),
      index: curlFromAngle(
        angleAt(rawLandmarks[LM.INDEX_MCP], rawLandmarks[LM.INDEX_PIP], rawLandmarks[LM.INDEX_TIP])
      ),
      middle: curlFromAngle(
        angleAt(rawLandmarks[LM.MIDDLE_MCP], rawLandmarks[LM.MIDDLE_PIP], rawLandmarks[LM.MIDDLE_TIP])
      ),
      ring: curlFromAngle(
        angleAt(rawLandmarks[LM.RING_MCP], rawLandmarks[LM.RING_PIP], rawLandmarks[LM.RING_TIP])
      ),
      pinky: curlFromAngle(
        angleAt(rawLandmarks[LM.PINKY_MCP], rawLandmarks[LM.PINKY_PIP], rawLandmarks[LM.PINKY_TIP])
      ),
    };

    s.lastFeatures = {
      thumbIndexDistance,
      wristVelocity: velocity,
      fingerCurls,
      worldPosition: worldWrist, // approximate camera-frame trajectory reference
    };
    return s.lastFeatures;
  }

  // Draws the exact frame MediaPipe processed plus (optionally) the skeleton,
  // so the picture and landmarks are always in sync — this canvas is also
  // what gets recorded to video.
  function drawStage(image, rawLandmarksList) {
    if (!ctx || !canvasEl) return;
    // The picture MediaPipe processed: the video, or its cropped part.
    const crop = cropPixels();
    const w = (crop && crop.w) || videoEl.videoWidth || canvasEl.width;
    const h = (crop && crop.h) || videoEl.videoHeight || canvasEl.height;
    if (canvasEl.width !== w || canvasEl.height !== h) {
      canvasEl.width = w;
      canvasEl.height = h;
    }

    ctx.save();
    ctx.clearRect(0, 0, w, h);
    if (mirror) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    if (image) ctx.drawImage(image, 0, 0, w, h);
    // Only the camera image and skeleton are flipped. Text drawn by consumers
    // afterwards (see toCanvasPoint) is in normal orientation, so it stays readable.

    if (overlay && rawLandmarksList && global.drawConnectors && global.HAND_CONNECTIONS) {
      const unit = Math.max(1, w / 640); // keep line weight consistent across resolutions
      for (const raw of rawLandmarksList) {
        global.drawConnectors(ctx, raw, global.HAND_CONNECTIONS, {
          color: "#00FF88",
          lineWidth: 2 * unit,
        });
        global.drawLandmarks(ctx, raw, {
          color: "#FF3355",
          lineWidth: unit,
          radius: 3 * unit,
        });
      }
    }
    ctx.restore();
  }

  function swapLabel(label) {
    if (label === "Left") return "Right";
    if (label === "Right") return "Left";
    return label;
  }

  function onResults(results) {
    if (switching) return;
    // Video files are timed by the video's own clock, so motion data matches the
    // footage however fast or slow the frames were processed.
    const timestamp = frameTime !== null ? frameTime : performance.now();
    const rawList = results.multiHandLandmarks || [];
    const handednessList = results.multiHandedness || [];

    tickFps();

    const labels = assignLabels(rawList, handednessList, timestamp);
    const outHands = [];
    for (let i = 0; i < rawList.length; i++) {
      const raw = rawList[i];
      const { label, score } = labels[i];
      const s = getState(label, timestamp);
      const smoothed = smoothLandmarks(raw, timestamp, s);

      const features = computeFeatures(smoothed, timestamp, s);
      const palm = computePalmOrientation(smoothed);
      const palmEuler = quatToEuler(palm);
      const bones = computeBoneOrientations(smoothed);

      outHands.push({
        landmarks: normalizeRelativeToWrist(smoothed),
        imageLandmarks: smoothed, // smoothed 0-1 image coordinates (unmirrored), for drawing
        rawImageLandmarks: raw, // MediaPipe's, unfiltered
        handedness: label,
        handednessScore: score,
        features,
        orientation: { palm, palmEuler, bones },
      });
    }
    // The skeleton is drawn from the smoothed landmarks, so it doesn't shake.
    drawStage(results.image || videoEl, outHands.map((h) => h.imageLandmarks));

    // Always notify — including with zero hands — so consumers can clear
    // their UI when hands leave the frame.
    const payload = { hands: outHands, timestamp };
    for (const cb of callbacks) cb(payload);
  }

  async function openCamera() {
    closeCamera();
    if (cameraOpts.desktopSourceId) {
      // A screen or window (e.g. OptiTrack Motive's camera view), captured at full size.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: cameraOpts.desktopSourceId, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60 } },
      });
    } else {
      const video = {
        width: { ideal: cameraOpts.width },
        height: { ideal: cameraOpts.height },
      };
      if (cameraOpts.deviceId) video.deviceId = { exact: cameraOpts.deviceId };
      else video.facingMode = "user";
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    }
    videoEl.srcObject = stream;
    await videoEl.play();
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    if (cameraOpts.desktopSourceId) {
      cameraOpts.facing = null;
    } else {
      cameraOpts.deviceId = settings.deviceId || cameraOpts.deviceId;
      cameraOpts.facing = cameraFacing(track, settings);
    }
    notifySource();
  }

  // The crop, in pixels of the source picture (even sizes), or null for the whole picture.
  function cropPixels() {
    const c = source === "camera" && cameraOpts.crop;
    const vw = videoEl ? videoEl.videoWidth : 0, vh = videoEl ? videoEl.videoHeight : 0;
    if (!c || !vw || !vh) return null;
    const x = Math.max(0, Math.round(c.x * vw)), y = Math.max(0, Math.round(c.y * vh));
    const w = Math.max(16, Math.min(vw - x, Math.round((c.w * vw) / 2) * 2));
    const h = Math.max(16, Math.min(vh - y, Math.round((c.h * vh) / 2) * 2));
    return { x, y, w, h };
  }

  // What MediaPipe sees: the video, just the cropped part of it, or a mirrored video
  // file flipped back.
  function frameImage() {
    const c = cropPixels();
    const flip = source === "file" && fileMirrored;
    if (!c && !flip) return videoEl;
    const w = c ? c.w : videoEl.videoWidth;
    const h = c ? c.h : videoEl.videoHeight;
    if (!frameCanvas) frameCanvas = document.createElement("canvas");
    if (frameCanvas.width !== w || frameCanvas.height !== h) {
      frameCanvas.width = w;
      frameCanvas.height = h;
    }
    const fctx = frameCanvas.getContext("2d");
    fctx.save();
    if (flip) {
      fctx.translate(w, 0);
      fctx.scale(-1, 1);
    }
    if (c) fctx.drawImage(videoEl, c.x, c.y, c.w, c.h, 0, 0, w, h);
    else fctx.drawImage(videoEl, 0, 0, w, h);
    fctx.restore();
    return frameCanvas;
  }

  // Which way a camera points: "user" (front / selfie), "environment" (rear), or null
  // when the browser doesn't say, as with most desktop webcams. Phones report it;
  // otherwise the name can tell ("camera2 0, facing back", "Microsoft Camera Rear").
  function cameraFacing(track, settings) {
    let facing = settings.facingMode;
    if (!facing && track.getCapabilities) {
      try {
        const modes = track.getCapabilities().facingMode;
        if (Array.isArray(modes) && modes.length === 1) facing = modes[0];
      } catch {
        // capabilities unavailable — fall back to the name
      }
    }
    if (facing === "user" || facing === "environment") return facing;
    const label = track.label || "";
    if (/\b(back|rear|environment|world)\b/i.test(label)) return "environment";
    if (/\b(front|user|selfie|facetime)\b/i.test(label)) return "user";
    return null;
  }

  function notifySource() {
    const camera = getCamera();
    for (const cb of sourceCallbacks) cb(camera);
  }

  function closeCamera() {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
  }

  // Feed each new camera frame to MediaPipe. Skips frames the camera hasn't
  // advanced (rAF can run faster than the camera) so FPS reflects real work.
  function setStalled(stalled) {
    if (stalled === cameraStalled) return;
    cameraStalled = stalled;
    for (const cb of statusCallbacks) cb(stalled ? "stalled" : "ok");
  }

  function startLoop() {
    const id = ++loopId;
    let lastTime = -1;
    let lastNewFrame = performance.now();
    let gotFrame = false;
    let reopening = false;
    const tick = async () => {
      if (id !== loopId) return;
      if (videoEl.readyState >= 2 && videoEl.videoWidth > 0 && videoEl.currentTime !== lastTime) {
        lastTime = videoEl.currentTime;
        lastNewFrame = performance.now();
        gotFrame = true;
        setStalled(false);
        await sendFrame();
      } else if (!reopening && !cameraOpts.desktopSourceId && performance.now() - lastNewFrame > (gotFrame ? STALL_MS : FIRST_FRAME_MS)) {
        // (Screens and windows only send a frame when something in them changes, so a
        // still one isn't a stalled camera.)
        reopening = true;
        setStalled(true);
        console.warn("Camera stopped delivering frames; reopening it.");
        openCamera()
          .catch((err) => console.warn("Camera reopen failed:", err.name || err))
          .finally(() => {
            reopening = false;
            gotFrame = false; // the reopened camera gets the longer start-up allowance
            lastNewFrame = performance.now();
          });
      }
      if (id === loopId) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }


  function sendFrame() {
    if (restartTracking) {
      // MediaPipe follows each hand from where it was on the last frame. After the picture
      // flips, that finds nothing (the hands moved, and are now the other way round).
      restartTracking = false;
      hands.reset();
      resetHands();
    }
    lastFrame = frameImage();
    inflight = hands.send({ image: lastFrame }).catch((err) => console.error("Hand tracking frame failed:", err));
    return inflight;
  }

  // Stops the current loop and waits for its last frame, whose result is dropped.
  async function haltLoop() {
    loopId++;
    switching = true;
    await inflight;
    switching = false;
  }

  // ---------- video file source ----------
  function mediaErrorText(err) {
    const code = err && err.code;
    if (code === 4) return "this browser can't play this video format";
    if (code === 3) return "the video couldn't be decoded";
    if (code === 2) return "the video couldn't be read";
    return "the video couldn't be opened";
  }

  // Loads url into a video element; rejects if the browser can't show its picture.
  function loadVideo(el, url) {
    return new Promise((resolve, reject) => {
      const done = (fn, arg) => {
        clearTimeout(timer);
        el.removeEventListener("loadeddata", onData);
        el.removeEventListener("error", onError);
        fn(arg);
      };
      const onData = () => (el.videoWidth > 0 ? done(resolve) : done(reject, new Error("the file has no video picture this browser can show")));
      const onError = () => done(reject, new Error(mediaErrorText(el.error)));
      const timer = setTimeout(() => done(reject, new Error("the video took too long to open")), 20000);
      el.addEventListener("loadeddata", onData);
      el.addEventListener("error", onError);
      el.srcObject = null;
      el.loop = false;
      el.muted = true;
      el.src = url;
      el.load();
    });
  }

  function resetHands() {
    for (const key of Object.keys(state)) delete state[key];
  }

  // Tracks every frame of a video file: playback pauses while MediaPipe works on a
  // frame and resumes afterwards, so no frame is skipped however slow the device is.
  function startFileLoop() {
    const id = ++loopId;
    const track = async (t) => {
      if (file.lastMediaTime !== null) {
        const dt = t - file.lastMediaTime;
        if (dt < 0) resetHands(); // seeked backwards / restarted
        else if (dt > 0 && dt < 0.5) {
          file.intervals.push(dt);
          if (file.intervals.length > 240) file.intervals.shift();
        }
      }
      file.lastMediaTime = t;
      frameTime = t * 1000;
      await sendFrame();
      frameTime = null;
    };
    const typicalInterval = () => {
      if (!file.intervals.length) return 0;
      const sorted = [...file.intervals].sort((x, y) => x - y);
      return sorted[Math.floor(sorted.length / 2)];
    };
    const onFrame = async (now, meta) => {
      if (id !== loopId || source !== "file") return;
      videoEl.pause(); // hold this frame while it's processed
      const t = meta.mediaTime;
      const step = typicalInterval();
      const dt = file.lastMediaTime === null ? null : t - file.lastMediaTime;
      const userSeek = file.seeking;
      file.seeking = false;
      // Resuming playback can present the same frame again (timestamps may be
      // rounded to the millisecond): track each frame once.
      const sameFrame = dt !== null && Math.abs(dt) < Math.max(0.002, step * 0.25);
      if (!sameFrame) {
        // Playback can skip a frame (usually while it warms up): go back for it once.
        if (!userSeek && !file.refilling && step && dt > step * 1.5 && dt < step * 4) {
          file.refilling = true;
          videoEl.requestVideoFrameCallback(onFrame);
          videoEl.currentTime = file.lastMediaTime + step * 1.25;
          return;
        }
        file.refilling = false;
        await track(t);
      }
      if (id !== loopId) return;
      videoEl.requestVideoFrameCallback(onFrame);
      // The first frames play slowly: until the frame interval is known, a frame the
      // decoder delivers late (while warming up) couldn't be noticed and fetched again.
      videoEl.playbackRate = file.intervals.length < 3 ? Math.min(file.rate, 0.25) : file.rate;
      if (file.playing && !videoEl.ended) videoEl.play().catch(() => {});
    };
    // The first frame is already on screen, so track it before playback starts.
    return track(videoEl.currentTime).then(() => {
      if (id === loopId) videoEl.requestVideoFrameCallback(onFrame);
    });
  }

  async function useVideoFile(url, { name = "video", mirrored = false } = {}) {
    if (!hands) throw new Error("The tracker isn't ready yet.");
    if (!videoEl.requestVideoFrameCallback) throw new Error("This browser can't step through video frames (it needs requestVideoFrameCallback).");
    // Check the browser can show it before touching the camera, which keeps running if not.
    const probe = document.createElement("video");
    try {
      await loadVideo(probe, url);
    } finally {
      probe.removeAttribute("src");
      probe.load();
    }
    await haltLoop(); // stop the camera (or previous video) loop
    closeCamera();
    await loadVideo(videoEl, url);
    source = "file";
    file = { name, playing: true, rate: 1, lastMediaTime: null, intervals: [], seeking: false, refilling: false };
    fileMirrored = !!mirrored;
    notifySource();
    videoEl.playbackRate = 0.25; // warm-up, see startFileLoop
    resetHands();
    restartTracking = true;
    setStalled(false);
    await startFileLoop();
    await videoEl.play();
  }

  // Whether the open video file is flipped back before tracking (see "Mirrored videos").
  // A paused video's frame is tracked again, so the picture and labels change at once.
  async function setFileMirrored(value) {
    if (!!value === fileMirrored) return;
    fileMirrored = !!value;
    if (source !== "file" || !file) return;
    restartTracking = true;
    if (file.playing && !videoEl.ended) return; // the next frame is tracked the new way
    await inflight;
    frameTime = videoEl.currentTime * 1000;
    await sendFrame();
    frameTime = null;
  }

  async function useCamera() {
    await haltLoop();
    if (source === "file") {
      videoEl.pause();
      videoEl.removeAttribute("src");
      videoEl.load();
    }
    source = "camera";
    file = null;
    fileMirrored = false;
    resetHands();
    restartTracking = true;
    await openCamera();
    startLoop();
  }

  const fileControls = {
    play() {
      if (!file) return;
      file.playing = true;
      if (videoEl.ended) videoEl.currentTime = 0; // play again from the start
      videoEl.play().catch(() => {});
    },
    pause() {
      if (!file) return;
      file.playing = false;
      videoEl.pause();
    },
    seek(seconds) {
      if (!file) return;
      file.seeking = true; // a deliberate jump, not a skipped frame
      videoEl.currentTime = Math.min(Math.max(0, seconds), videoEl.duration || 0);
    },
    setRate(rate) {
      if (!file) return;
      file.rate = rate;
      if (file.intervals.length >= 3) videoEl.playbackRate = rate;
    },
    time: () => (file ? videoEl.currentTime : 0),
    duration: () => (file && Number.isFinite(videoEl.duration) ? videoEl.duration : 0),
    playing: () => !!(file && file.playing && !videoEl.ended),
    name: () => (file ? file.name : ""),
    // Frame rate measured from the frames seen so far: the mean frame interval,
    // ignoring outliers (seeks), which also averages out millisecond-rounded timestamps.
    fps() {
      if (!file || !file.intervals.length) return 0;
      const sorted = [...file.intervals].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const typical = sorted.filter((dt) => dt > median * 0.5 && dt < median * 1.5);
      const mean = typical.reduce((a, b) => a + b, 0) / typical.length;
      return Math.round((1 / mean) * 100) / 100;
    },
  };

  function onVideoEnded(callback) {
    if (typeof callback === "function") endedCallbacks.push(callback);
  }

  async function init(options = {}) {
    videoEl = options.videoEl;
    canvasEl = options.canvasEl || null;
    overlay = options.overlay !== undefined ? !!options.overlay : options.debug !== undefined ? !!options.debug : true;
    mirror = options.mirror !== undefined ? !!options.mirror : true;
    maxHands = options.maxNumHands || 2;
    modelComplexity = options.modelComplexity === 1 ? 1 : 0;
    cameraOpts = {
      deviceId: options.deviceId || null,
      width: options.width || 1280,
      height: options.height || 720,
    };
    if (canvasEl) ctx = canvasEl.getContext("2d");
    videoEl.addEventListener("ended", () => {
      if (source !== "file" || !file) return;
      file.playing = false;
      for (const cb of endedCallbacks) cb();
    });

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Camera access isn't available here. Run the desktop app, or serve this page over http://localhost.");
    }
    if (!global.Hands) {
      throw new Error("MediaPipe Hands failed to load. Run `npm install` so node_modules/@mediapipe is present.");
    }

    hands = new global.Hands({
      locateFile: (file) => `${HANDS_ASSET_PATH}${file}`,
    });

    hands.setOptions({
      maxNumHands: maxHands,
      modelComplexity,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.7,
    });

    hands.onResults(onResults);
    await hands.initialize();

    try {
      await openCamera();
    } catch (err) {
      // A remembered camera may have been unplugged — fall back to the default one.
      if (cameraOpts.deviceId && (err.name === "OverconstrainedError" || err.name === "NotFoundError")) {
        cameraOpts.deviceId = null;
        await openCamera();
      } else {
        throw err;
      }
    }
    startLoop();
    return true;
  }

  async function setCamera(opts = {}) {
    cameraOpts = { ...cameraOpts, ...opts };
    await haltLoop(); // pause processing while the stream is swapped
    try {
      await openCamera();
    } finally {
      if (hands) startLoop();
    }
  }

  async function listCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === "videoinput")
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  }

  function getCamera() {
    const crop = cropPixels();
    return {
      source,
      deviceId: cameraOpts.desktopSourceId ? `screen:${cameraOpts.desktopName}` : cameraOpts.deviceId,
      facing: source === "camera" ? cameraOpts.facing : null,
      screen: source === "camera" && !!cameraOpts.desktopSourceId,
      name: cameraOpts.desktopName,
      crop: source === "camera" ? cameraOpts.crop : null,
      // The size of the picture being tracked (the cropped part, when cropped).
      width: crop ? crop.w : videoEl ? videoEl.videoWidth : 0,
      height: crop ? crop.h : videoEl ? videoEl.videoHeight : 0,
    };
  }

  function stop() {
    loopId++;
    closeCamera();
    callbacks = [];
  }

  function onCameraStatus(callback) {
    if (typeof callback === "function") statusCallbacks.push(callback);
  }

  function onSourceChange(callback) {
    if (typeof callback === "function") sourceCallbacks.push(callback);
  }

  function onHandLandmarks(callback) {
    if (typeof callback === "function") callbacks.push(callback);
  }

  function setOverlay(value) {
    overlay = !!value;
  }

  function setMirror(value) {
    mirror = !!value;
  }

  function setModelComplexity(value) {
    modelComplexity = value === 1 ? 1 : 0;
    if (hands) hands.setOptions({ modelComplexity });
  }

  function setMaxHands(value) {
    maxHands = value === 1 ? 1 : 2;
    if (hands) hands.setOptions({ maxNumHands: maxHands });
  }

  // Map a raw 0-1 image landmark to stage-canvas pixels, honoring the mirror setting.
  function toCanvasPoint(p) {
    const w = canvasEl ? canvasEl.width : 0;
    const h = canvasEl ? canvasEl.height : 0;
    return { x: (mirror ? 1 - p.x : p.x) * w, y: p.y * h };
  }

  // Pass "Left" or "Right" to get that hand's features; omit for a map of both.
  // Hands that haven't been seen recently report null.
  function getFeatures(label) {
    const now = performance.now();
    const live = (s) => (s && s.lastSeen !== null && now - s.lastSeen <= STALE_MS ? s.lastFeatures : null);
    if (label) return live(state[label]);
    const out = {};
    for (const key of Object.keys(state)) out[key] = live(state[key]);
    return out;
  }

  global.HandTracker = {
    init,
    stop,
    onHandLandmarks,
    onCameraStatus,
    onSourceChange,
    setOverlay,
    setDebug: setOverlay, // backwards-compatible alias
    setMirror,
    isMirrored: () => mirror,
    setCamera,
    useVideoFile,
    setFileMirrored,
    isFileMirrored: () => source === "file" && fileMirrored,
    useCamera,
    file: fileControls,
    onVideoEnded,
    getSource: () => source,
    listCameras,
    getCamera,
    setModelComplexity,
    setMaxHands,
    getMaxHands: () => maxHands,
    toCanvasPoint,
    getFeatures,
    getFrameImage: () => lastFrame || videoEl,
    getFPS: () => fps,
    quaternionToEuler: quatToEuler,
    LANDMARK_INDEX: LM,
    // Exposed for robot-motion.js (kinematic chain construction):
    _math: { subVec, crossVec, dotVec, normVec, quatFromVectors },
    // Feed MediaPipe-shaped results directly (replaying data, automated checks).
    _processResults: onResults,
  };
})(window);
