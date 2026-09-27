/**
 * app.js
 * Main page wiring: camera + tracking controls, per-hand cards (up to two
 * hands), the live 3D view, robot motion capture (JSON) and video recording
 * with multi-format export.
 *
 * Motion capture exports to JSON / CSV / BVH / GLB / C3D / TRC / NPZ
 * (motion-export.js, works everywhere). In the desktop app, window.desktop
 * (electron/preload.js) provides native folder dialogs and ffmpeg conversion
 * of video to MP4 / WebM / MOV / MKV / AVI / GIF. In the Android app,
 * window.mobile (mobile-bridge.js) saves into Documents/Hand Tracker and can
 * share files; the phone records MP4 directly. In a plain browser, files are
 * downloaded and video is saved in the format MediaRecorder produced.
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const desktop = window.desktop || null; // Windows app (electron/preload.js)
  const mobile = window.mobile || null;   // Android app (mobile-bridge.js)

  const video = $("video");
  const stage = $("stage");
  const wrap = $("wrap");
  const stageMessage = $("stageMessage");
  const recBadge = $("recBadge");
  const fpsBadge = $("fpsBadge");
  const buildInfo = $("buildInfo");
  const cameraSelect = $("cameraSelect");
  const resolutionSelect = $("resolutionSelect");
  const handsSelect = $("handsSelect");
  const modelSelect = $("modelSelect");
  const overlayToggle = $("overlayToggle");
  const mirrorToggle = $("mirrorToggle");
  const readableToggle = $("readableToggle");
  const legendToggle = $("legendToggle");
  const legendEl = $("legend");
  const videoBtn = $("videoBtn");
  const layoutSelect = $("layoutSelect");
  const videoStatus = $("videoStatus");
  const motionBtn = $("motionBtn");
  const motionStatus = $("motionStatus");
  const slots = { Left: $("slotLeft"), Right: $("slotRight") };
  const bothHandsEl = $("bothHands");
  const openVideoBtn = $("openVideoBtn");
  const videoFileInput = $("videoFileInput");
  const videoBar = $("videoBar");
  const vidRestart = $("vidRestart");
  const vidPlay = $("vidPlay");
  const vidSeek = $("vidSeek");
  const vidTime = $("vidTime");
  const vidRate = $("vidRate");
  const vidCapture = $("vidCapture");
  const vidMirrored = $("vidMirrored");
  const vidCamera = $("vidCamera");
  const vidName = $("vidName");
  const sourceNote = $("sourceNote");

  const exportCard = $("exportCard");
  const clipPreview = $("clipPreview");
  const clipInfo = $("clipInfo");
  const exportName = $("exportName");
  const formatGrid = $("formatGrid");
  const exportBtn = $("exportBtn");
  const cancelExportBtn = $("cancelExportBtn");
  const discardBtn = $("discardBtn");
  const exportProgress = $("exportProgress");
  const progressFill = $("progressFill");
  const progressLabel = $("progressLabel");
  const exportResults = $("exportResults");
  const exportNote = $("exportNote");

  const motionExportCard = $("motionExportCard");
  const motionInfo = $("motionInfo");
  const motionName = $("motionName");
  const motionFormatGrid = $("motionFormatGrid");
  const motionExportBtn = $("motionExportBtn");
  const motionDiscardBtn = $("motionDiscardBtn");
  const motionResults = $("motionResults");
  const motionNote = $("motionNote");

  const SIDE_COLORS = { Left: "#4dabf7", Right: "#ff922b" };
  const PANEL_INTERVAL_MS = 66; // ~15 Hz keeps the numbers readable and the DOM cheap
  const RECORD_FPS = 30;

  // ---------- Preferences (per-machine conveniences; the page works without them) ----------
  const PREFS_KEY = "hand-tracker:prefs";
  const prefs = (() => {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    } catch {
      return {};
    }
  })();
  function setPref(key, value) {
    prefs[key] = value;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // storage unavailable — settings just won't persist
    }
  }

  let overlayOn = prefs.overlay !== undefined ? prefs.overlay : true;
  // All text in the picture shown readable when mirrored: optional, off until turned on.
  // Times (a clock, a timestamp) are kept the right way round either way.
  let readableOn = prefs.readableText === true;
  // Mirror: on for selfie cameras, off for rear cameras and video files (see
  // applyMirrorDefault). Labels are drawn after the flip, and text in the camera
  // picture is detected and flipped back (readable-text.js), so numbers and words
  // always read correctly.
  let mirrorOn = true;
  // Mirror choices made with the button, per camera: deviceId -> on/off.
  const mirrorByCamera = prefs.mirrorByCamera && typeof prefs.mirrorByCamera === "object" ? prefs.mirrorByCamera : {};
  delete prefs.mirror; // the old single setting for every camera
  // Videos marked as recorded mirrored (selfie videos saved as previewed), by file name.
  const mirroredVideos = prefs.mirroredVideos && typeof prefs.mirroredVideos === "object" ? prefs.mirroredVideos : {};
  const MIRRORED_VIDEOS_KEPT = 200;
  if (prefs.resolution) resolutionSelect.value = prefs.resolution;
  if (prefs.hands) handsSelect.value = String(prefs.hands);
  if (prefs.model !== undefined) modelSelect.value = String(prefs.model);
  if (prefs.layout) layoutSelect.value = prefs.layout;

  // ---------- Small helpers ----------
  function pad2(n) {
    return String(n).padStart(2, "0");
  }
  function formatClock(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
  }
  const { formatBytes, downloadBlob, checkedIds, renderResults } = ExportUI; // export-ui.js
  function timestampName() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
  }
  function setToggle(btn, on, label) {
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.firstChild.textContent = `${label}: ${on ? "ON" : "OFF"}`;
  }

  // ---------- Gestures & hand cards ----------

  const NO_GESTURE = { label: "—", color: "#666" };

  // Tracks recent palm-roll angles per hand to detect a genuine "shaka wave"
  // (the wrist rocking back and forth) vs. a hand held steady — the only
  // real difference between Call Me and Shaka, since they're the same
  // finger shape. Not reset on hand loss — a short gap just restarts the window.
  const ROLL_HISTORY_LEN = 12;
  const rollHistory = {};
  function detectWristWave(handKey, rollDeg) {
    const hist = rollHistory[handKey] || (rollHistory[handKey] = []);
    hist.push(rollDeg);
    if (hist.length > ROLL_HISTORY_LEN) hist.shift();
    if (hist.length < 6) return false;
    let reversals = 0, prevDelta = 0;
    for (let i = 1; i < hist.length; i++) {
      // Shortest way round, so roll passing ±180° isn't mistaken for a rock.
      const delta = ((hist[i] - hist[i - 1] + 540) % 360) - 180;
      if (Math.abs(delta) < 3) continue; // ignore small tracking jitter
      if (prevDelta !== 0 && Math.sign(delta) !== Math.sign(prevDelta)) reversals++;
      prevDelta = delta;
    }
    return reversals >= 2; // at least one full back-and-forth rock
  }

  // The hand's shape in the picture: landmarks relative to the wrist, in the picture's
  // real proportions (MediaPipe gives x and y as fractions of its width and height), and
  // distances in palm lengths (wrist to middle knuckle), so near and far hands compare.
  function handShape(landmarks) {
    const cam = HandTracker.getCamera();
    const aspect = cam.width && cam.height ? cam.width / cam.height : 1;
    const pts = landmarks.map((p) => ({ x: p.x * aspect, y: p.y }));
    const palm = Math.hypot(pts[9].x, pts[9].y) || 1e-6;
    const dist = (i, j) => Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) / palm;
    return { pts, palm, dist, reach: (i) => dist(i, 0) };
  }
  const OTHER_FINGERS = ["index", "middle", "ring", "pinky"];

  // The rules below were measured on photos of real hands (scripts/fixtures/gesture-hands.json)
  // and a live session on a webcam. MediaPipe's curl readings for folded fingers run low
  // (often 0.4-0.65, even in a fist), so the rules mostly use how far each fingertip
  // reaches from the wrist, in palm lengths: folded fingertips reach well under 1, straight
  // ones 1.5-2.5. Distances don't depend on how the hand is turned in the picture.
  const TIPS = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
  // Straight: a low curl reading and a long reach. Folded: reaching well short of `than`.
  const straight = ({ reach }, c, f, min = 1.3) => c[f] < 0.35 && reach(TIPS[f]) > min;
  const shorter = ({ reach }, f, than, ratio) => reach(TIPS[f]) < ratio * than;

  // The Bird: only the middle finger up, raised, with the hand facing the camera.
  // Curled fingertips reach under 0.6 of the middle fingertip's distance from the wrist;
  // straight ones over 0.9.
  function isTheBird({ pts, palm, dist, reach }) {
    // (Index up to 0.72: a thumb holding the index down often leaves it half folded.)
    if (!(reach(8) < 0.72 * reach(12) && reach(16) < 0.65 * reach(12) && reach(20) < 0.65 * reach(12))) return false;
    // Raised: up or sideways on screen, just not pointing down. Sideways counts because
    // a phone held on its side with auto-rotate off turns the whole picture. A finger
    // pointing at the camera looks short, and its on-screen direction means little.
    const finger = dist(9, 12);
    const raised = finger > 0.5 && (pts[12].y - pts[9].y) / palm < 0.7 * finger;
    // Facing the camera: side-on, the knuckles line up one behind another and their
    // spread nearly vanishes.
    return raised && dist(5, 17) > 0.4;
  }

  // Thumbs Up / Thumbs Down: thumb straight and sticking out (its tip reaching further than
  // any other fingertip, which are folded), well away from the index finger (so it isn't a
  // pinch), and pointing up (tip well above all four knuckles) or down (well below them).
  // A thumb out to the side of an upright fist, level with the knuckles, is neither.
  function thumbOut(shape, c) {
    const { reach, dist } = shape;
    return c.thumb < 0.35 && reach(4) > 1.1 && dist(4, 8) > 0.5 && OTHER_FINGERS.every((f) => shorter(shape, f, reach(4), 0.8));
  }
  function thumbHeight({ pts, palm }) {
    return (pts[4].y - Math.max(pts[5].y, pts[9].y, pts[13].y, pts[17].y)) / palm; // > 0: below the knuckles
  }
  function isThumbsUp(shape, c) {
    const { pts, palm } = shape;
    return thumbOut(shape, c) && (pts[4].y - Math.min(pts[5].y, pts[9].y, pts[13].y, pts[17].y)) / palm < -0.6;
  }
  function isThumbsDown(shape, c) {
    return thumbOut(shape, c) && thumbHeight(shape) > 0.35 && shape.pts[4].y > shape.pts[2].y;
  }

  // Fist: all four fingertips folded close to the wrist, thumb tucked in (not sticking out
  // as in a thumbs up, a thumbs down or call me).
  function isFist({ reach }) {
    return [8, 12, 16, 20].every((tip) => reach(tip) < 1.0) && reach(4) < 1.15;
  }

  // Point: index straight, the other three fingertips folded well short of it.
  function isPoint(shape, c) {
    const r = shape.reach(8);
    return straight(shape, c, "index") && ["middle", "ring", "pinky"].every((f) => shorter(shape, f, r, 0.6));
  }

  // Rock On: index and little finger straight, middle and ring folded well short of them.
  function isRockOn(shape, c) {
    const r = Math.min(shape.reach(8), shape.reach(20));
    return straight(shape, c, "index") && straight(shape, c, "pinky", 1.1) && ["middle", "ring"].every((f) => shorter(shape, f, r, 0.6));
  }

  // Call Me / Shaka: thumb and little finger out, the other three folded well short of the
  // little finger.
  function isCallMeShape(shape, c) {
    const r = shape.reach(20);
    return c.thumb < 0.35 && shape.reach(4) > 1.1 && straight(shape, c, "pinky", 1.1) && ["index", "middle", "ring"].every((f) => shorter(shape, f, r, 0.75));
  }

  // OK Sign: thumb and index tips touching in a ring, the other three fingers straight.
  // The gap is measured in palm lengths, so big (close) and small (far) hands alike: OK
  // signs in photos were 0.14-0.24 apart, open hands 0.5 and more. The index bends to
  // make the ring (its tip reaches about 2/3 as far as the middle one), unlike a relaxed
  // hand whose thumb just rests against a straight index finger.
  // (The other three reach at least 1.55, 1.45 and 1.25 palm lengths: fully out, not the
  // half-curled fingers of a pinch, which reach about 1.3, 1.15 and 1.05.)
  function isOkSign({ dist, reach }, c) {
    return dist(4, 8) < 0.35 && reach(8) < 0.8 * reach(12) &&
      ["middle", "ring", "pinky"].every((f) => c[f] < 0.35) && reach(12) > 1.55 && reach(16) > 1.45 && reach(20) > 1.25;
  }

  // Peace: index and middle straight, ring and little fingers folded, their tips reaching
  // under 0.65 of the raised two's distance from the wrist (peace signs in photos: at most
  // 0.58; open hands and the Vulcan salute: over 0.85). Only distances, never directions,
  // so the V reads at any angle, upright, leaning or on its side.
  // The two raised fingers are about the same length (a Bird with the index only half
  // folded is not a peace sign).
  function isPeace({ reach }, c) {
    const raised = Math.min(reach(8), reach(12));
    return c.index < 0.35 && c.middle < 0.35 && reach(8) > 0.8 * reach(12) && reach(12) > 0.8 * reach(8) &&
      reach(16) < 0.65 * raised && reach(20) < 0.65 * raised;
  }

  // Live Long and Prosper (the Vulcan salute): all four fingers straight, index and middle
  // together, ring and little together, with a wide V between the middle and ring fingers.
  // An open or relaxed hand spreads its fingers more evenly. Straight means both a low
  // curl reading and fingertips reaching nearly as far as the middle one (a peace sign's
  // folded ring and little fingers can read as only slightly curled).
  function isVulcanSalute({ dist, reach }, c) {
    const gap = dist(12, 16);
    const straight = OTHER_FINGERS.every((f) => c[f] < 0.35) && reach(8) > 0.75 * reach(12) && reach(16) > 0.75 * reach(12) && reach(20) > 0.6 * reach(12);
    return straight && gap > 0.45 && gap > 1.3 * Math.max(dist(8, 12), dist(16, 20));
  }

  // Gesture classifier built from data we already compute (finger curl,
  // thumb-index distance) plus wrist-relative landmark positions for the
  // one gesture (Thumbs Up) that needs a spatial direction, not just curl.
  // Rules are ordered most-specific-first so a more detailed match (e.g.
  // OK Sign) is checked before a looser one that shares the same signal
  // (e.g. Pinch, which also relies on thumb-index distance).
  // Call it once per frame per hand: the wave detector keeps a history.
  function classifyGesture(hand) {
    const f = hand.features;
    const c = f.fingerCurls;
    const avgCurl = (c.thumb + c.index + c.middle + c.ring + c.pinky) / 5;
    const EXTENDED = 0.35;

    // The most specific shapes come first. The Bird: a thumb tucked over the curled
    // index finger would otherwise read as Pinch. Thumbs Up before OK Sign (a thumb up
    // can brush the index finger). Live Long and Prosper would otherwise read as Open
    // Palm. Fist before Pinch (a thumb resting on the fist's index finger).
    const shape = hand.landmarks ? handShape(hand.landmarks) : null;
    if (shape) {
      if (c.middle < EXTENDED && isTheBird(shape)) return { label: "The Bird", color: "#da77f2" };
      if (isThumbsUp(shape, c)) return { label: "Thumbs Up", color: "#69db7c" };
      if (isThumbsDown(shape, c)) return { label: "Thumbs Down", color: "#e64980" };
      if (isVulcanSalute(shape, c)) return { label: "Live Long and Prosper", color: "#748ffc" };
      if (isOkSign(shape, c)) return { label: "OK Sign", color: "#ffd43b" };
      if (isPeace(shape, c)) return { label: "Peace", color: "#66d9e8" };
      if (isRockOn(shape, c)) return { label: "Rock On", color: "#b197fc" };
      // Call Me / Shaka: identical finger shape — the real-world difference is motion, not
      // shape, so a rocking wrist wave means Shaka; held steady means Call Me.
      if (isCallMeShape(shape, c)) {
        const isWaving = detectWristWave(hand.handedness, hand.orientation.palmEuler.roll);
        return isWaving ? { label: "Shaka", color: "#20c997" } : { label: "Call Me", color: "#ff922b" };
      }
      if (isPoint(shape, c)) return { label: "Point", color: "#74c0fc" };
      if (isFist(shape) || avgCurl > 0.7) return { label: "Fist", color: "#ff6b6b" };
      // Pinch: thumb and index tips touching, in palm lengths (so a small, far-away hand
      // isn't a pinch just because everything in it is close together). After Fist, so a
      // thumb resting on a clenched fist's index finger stays a fist.
      if (shape.dist(4, 8) < 0.35) return { label: "Pinch", color: "#f783ac" };
    } else if (avgCurl > 0.7) return { label: "Fist", color: "#ff6b6b" };
    if (avgCurl < 0.15) return { label: "Open Palm", color: "#51cf66" };
    return NO_GESTURE;
  }

  // Holds a gesture label for a few consecutive frames before switching the
  // displayed badge, so a hand sitting near a threshold (e.g. a half-curled
  // finger) doesn't flicker between two labels every frame. Keyed per side
  // (Left/Right) so each hand's hysteresis is independent.
  const GESTURE_HOLD_FRAMES = 4;
  const gestureHold = {};
  function stableGesture(side, rawGesture) {
    let state = gestureHold[side];
    if (!state) {
      state = { label: rawGesture.label, color: rawGesture.color, candidate: rawGesture.label, count: 1 };
      gestureHold[side] = state;
    }
    if (rawGesture.label === state.candidate) {
      state.count++;
    } else {
      state.candidate = rawGesture.label;
      state.count = 1;
    }
    if (state.count >= GESTURE_HOLD_FRAMES) {
      state.label = rawGesture.label;
      state.color = rawGesture.color;
    }
    return { label: state.label, color: state.color };
  }

  // This frame's gesture per side, classified once in the frame handler and
  // shared by the stage labels, hand cards and Both Hands panel.
  let gestures = {};
  function updateGestures(hands) {
    gestures = {};
    for (const hand of hands) {
      if (!gestures[hand.handedness]) gestures[hand.handedness] = stableGesture(hand.handedness, classifyGesture(hand));
    }
  }
  const gestureOf = (hand) => gestures[hand.handedness] || NO_GESTURE;

  function curlRow(name, val) {
    const pct = Math.round(val * 100);
    return `
      <div class="curl-row">
        <span class="curl-label">${name}</span>
        <div class="curl-bar"><div class="curl-fill" style="width:${pct}%"></div></div>
        <span class="curl-pct">${pct}%</span>
      </div>`;
  }

  function renderHandCard(hand, side) {
    const e = hand.orientation.palmEuler;
    const f = hand.features;
    const gesture = gestureOf(hand);
    // Rotate a simple arrow glyph to visualize palm yaw at a glance.
    const arrowRotation = e.yaw.toFixed(0);

    return `
      <div class="hand-card ${side.toLowerCase()}">
        <div class="hand-header">
          <span class="hand-name">${side} Hand</span>
          <span class="gesture-badge" style="background:${gesture.color}22; color:${gesture.color}; border-color:${gesture.color}66">${gesture.label}</span>
          <span class="compass" style="transform: rotate(${arrowRotation}deg)">➤</span>
        </div>

        <div class="section-label">Palm Orientation</div>
        <div class="orientation-row">
          <span><b>Yaw</b>${e.yaw.toFixed(0)}°</span>
          <span><b>Pitch</b>${e.pitch.toFixed(0)}°</span>
          <span><b>Roll</b>${e.roll.toFixed(0)}°</span>
        </div>

        <div class="section-label">Gesture Metrics</div>
        <div class="metric-row">
          Thumb–Index dist: ${f.thumbIndexDistance.toFixed(3)} &nbsp;•&nbsp;
          Wrist speed: ${f.wristVelocity.speed.toFixed(3)}
        </div>

        <div class="section-label">Finger Curl</div>
        ${Object.entries(f.fingerCurls).map(([n, v]) => curlRow(n, v)).join("")}
      </div>`;
  }

  function renderMissingCard(side) {
    const hint = HandTracker.getMaxHands() === 1 ? "Tracking 1 hand — switch Track to 2 hands for both." : `Show your ${side.toLowerCase()} hand to the camera…`;
    return `
      <div class="hand-card ${side.toLowerCase()} missing">
        <div class="hand-header"><span class="hand-name">${side} Hand</span></div>
        <div class="empty-state">${hint}</div>
      </div>`;
  }

  // Two-hand relationship metrics, shown only while both hands are visible.
  function renderBothHands(left, right) {
    if (!left || !right) {
      bothHandsEl.hidden = true;
      return;
    }
    const a = left.features.worldPosition;
    const b = right.features.worldPosition;
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const gl = gestureOf(left).label;
    const gr = gestureOf(right).label;
    bothHandsEl.hidden = false;
    bothHandsEl.innerHTML = `
      <div class="section-label">Both Hands</div>
      <div class="metric-row">
        Wrist-to-wrist distance: ${distance.toFixed(3)}<br />
        Gestures: <span style="color:${SIDE_COLORS.Left}">${gl}</span> + <span style="color:${SIDE_COLORS.Right}">${gr}</span>
      </div>`;
  }

  let lastPanelRender = 0;
  function renderPanels(hands) {
    const now = performance.now();
    if (now - lastPanelRender < PANEL_INTERVAL_MS) return;
    lastPanelRender = now;

    const bySide = { Left: null, Right: null };
    for (const hand of hands) {
      if (hand.handedness in bySide && !bySide[hand.handedness]) bySide[hand.handedness] = hand;
    }
    for (const side of ["Left", "Right"]) {
      slots[side].innerHTML = bySide[side] ? renderHandCard(bySide[side], side) : renderMissingCard(side);
    }
    renderBothHands(bySide.Left, bySide.Right);
  }

  // Handedness + gesture tag drawn next to each wrist, directly on the stage
  // canvas so it also appears in recorded video. Drawn in normal (unflipped)
  // orientation, so the text reads correctly in mirrored view too.
  function drawStageLabels(hands) {
    if (!overlayOn || !hands.length) return;
    const ctx = stage.getContext("2d");
    const unit = Math.max(1, stage.width / 640);
    const h = 22 * unit;
    const padX = 9 * unit;
    ctx.save();
    ctx.font = `600 ${Math.round(12.5 * unit)}px "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    for (const hand of hands) {
      const wrist = HandTracker.toCanvasPoint(hand.imageLandmarks[0]);
      const gesture = gestureOf(hand);
      const text = gesture.label === "—" ? hand.handedness : `${hand.handedness} · ${gesture.label}`;
      const color = SIDE_COLORS[hand.handedness] || "#adb5bd";
      const w = ctx.measureText(text).width + padX * 2;
      const x = Math.min(Math.max(wrist.x - w / 2, 4), stage.width - w - 4);
      const y = Math.min(Math.max(wrist.y + 16 * unit, 4), stage.height - h - 4);

      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, h / 2);
      else ctx.rect(x, y, w, h);
      ctx.fillStyle = "rgba(14, 15, 18, 0.8)";
      ctx.fill();
      ctx.lineWidth = 1.5 * unit;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillText(text, x + padX, y + h / 2);
    }
    ctx.restore();
  }

  // Keep the stage box the same shape as the camera image.
  let stageAspect = "";
  function syncStageAspect() {
    const aspect = `${stage.width} / ${stage.height}`;
    if (aspect !== stageAspect) {
      stageAspect = aspect;
      wrap.style.aspectRatio = aspect;
    }
  }

  // ---------- Camera / tracking controls ----------
  async function populateCameras() {
    const cams = await HandTracker.listCameras();
    const current = HandTracker.getCamera().deviceId;
    cameraSelect.innerHTML = "";
    cams.forEach((cam) => {
      const opt = document.createElement("option");
      opt.value = cam.deviceId;
      opt.textContent = cam.label;
      cameraSelect.appendChild(opt);
    });
    if (!cams.length) {
      // Device lists can briefly come back empty while a camera is starting;
      // a devicechange event refreshes this once they're ready.
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = HandTracker.getCamera().width ? "Current camera" : "No camera found";
      cameraSelect.appendChild(opt);
    }
    if (current && cams.some((c) => c.deviceId === current)) cameraSelect.value = current;
    if (canCaptureScreens) {
      const cam = HandTracker.getCamera();
      if (cam.screen) {
        const opt = document.createElement("option");
        opt.value = "__screen_active";
        opt.textContent = `Window: ${cam.name}${cam.crop ? " (part)" : ""}`;
        cameraSelect.appendChild(opt);
        cameraSelect.value = opt.value;
      }
      const pick = document.createElement("option");
      pick.value = "__screen";
      pick.textContent = "Screen or window…";
      cameraSelect.appendChild(pick);
    }
  }

  function parseResolution(value) {
    const [width, height] = value.split("x").map(Number);
    return { width, height };
  }

  async function switchCamera(opts) {
    stageMessage.hidden = false;
    stageMessage.className = "";
    stageMessage.textContent = opts.desktopSourceId ? "Starting window capture…" : "Switching camera…";
    try {
      await HandTracker.setCamera(opts);
      stageMessage.hidden = true;
    } catch (err) {
      showStageError(err);
    }
  }

  // ---------- A screen or window as the source (Windows app) ----------
  // OptiTrack Motive keeps its cameras to itself, so while it runs the way to track hands
  // in an OptiTrack camera's picture is to capture Motive's window (just that camera's
  // view, with a crop). Works for any other window or screen too.
  const canCaptureScreens = !!(desktop && desktop.listCaptureSources);
  const captureDialog = $("captureDialog"), captureGrid = $("captureGrid"), captureSources = $("captureSources");
  const captureCrop = $("captureCrop"), capturePreview = $("capturePreview"), cropStage = $("cropStage"), cropBox = $("cropBox");
  const captureUseArea = $("captureUseArea");
  let capture = { source: null, stream: null, rect: null };

  function stopCapturePreview() {
    if (capture.stream) for (const t of capture.stream.getTracks()) t.stop();
    capture.stream = null;
    capturePreview.srcObject = null;
  }
  function closeCapturePicker() {
    stopCapturePreview();
    captureDialog.hidden = true;
  }
  async function openCapturePicker() {
    captureDialog.hidden = false;
    captureSources.hidden = false;
    captureCrop.hidden = true;
    captureGrid.textContent = "Looking for screens and windows…";
    try {
      const sources = await desktop.listCaptureSources();
      captureGrid.textContent = "";
      for (const src of sources) {
        const b = document.createElement("button");
        const img = document.createElement("img");
        img.src = src.thumbnail;
        img.alt = "";
        const name = document.createElement("span");
        name.textContent = src.screen ? `Whole screen: ${src.name}` : src.name;
        b.append(img, name);
        b.addEventListener("click", () => chooseCaptureSource(src));
        captureGrid.appendChild(b);
      }
      if (!sources.length) captureGrid.textContent = "No screens or windows were found.";
    } catch (err) {
      captureGrid.textContent = `Couldn't list windows: ${err.message}`;
    }
  }
  async function chooseCaptureSource(src) {
    capture = { source: src, stream: null, rect: null };
    captureSources.hidden = true;
    captureCrop.hidden = false;
    cropBox.hidden = true;
    captureUseArea.disabled = true;
    try {
      capture.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: src.id, maxWidth: 1920, maxHeight: 1080 } },
      });
      capturePreview.srcObject = capture.stream;
      await capturePreview.play();
    } catch (err) {
      captureCrop.querySelector(".note").textContent = `Couldn't capture this window: ${err.message}`;
    }
  }
  // Dragging a box on the preview: the crop, as fractions of the picture.
  let cropDrag = null;
  const cropPoint = (e) => {
    const r = capturePreview.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  function showCropBox(rect) {
    cropBox.hidden = false;
    Object.assign(cropBox.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` });
  }
  cropStage.addEventListener("pointerdown", (e) => {
    cropDrag = cropPoint(e);
    cropStage.setPointerCapture(e.pointerId);
  });
  cropStage.addEventListener("pointermove", (e) => {
    if (!cropDrag) return;
    const p = cropPoint(e);
    capture.rect = { x: Math.min(cropDrag.x, p.x), y: Math.min(cropDrag.y, p.y), w: Math.abs(p.x - cropDrag.x), h: Math.abs(p.y - cropDrag.y) };
    showCropBox(capture.rect);
  });
  cropStage.addEventListener("pointerup", () => {
    cropDrag = null;
    captureUseArea.disabled = !(capture.rect && capture.rect.w > 0.03 && capture.rect.h > 0.03);
  });
  async function useCaptureSource(src, crop) {
    closeCapturePicker();
    await switchCamera({ desktopSourceId: src.id, desktopName: src.name, crop: crop || null });
    populateCameras();
  }
  captureUseArea.addEventListener("click", () => useCaptureSource(capture.source, capture.rect));
  $("captureUseAll").addEventListener("click", () => useCaptureSource(capture.source, null));
  $("captureBack").addEventListener("click", () => {
    stopCapturePreview();
    openCapturePicker();
  });
  $("captureClose").addEventListener("click", closeCapturePicker);
  captureDialog.addEventListener("click", (e) => {
    if (e.target === captureDialog) closeCapturePicker();
  });

  cameraSelect.addEventListener("change", () => {
    if (cameraSelect.value === "__screen") {
      populateCameras(); // back to the current choice until a window is picked
      openCapturePicker();
      return;
    }
    if (cameraSelect.value === "__screen_active") return;
    setPref("cameraId", cameraSelect.value || null);
    switchCamera({ deviceId: cameraSelect.value || null, desktopSourceId: null, desktopName: "", crop: null }).then(populateCameras);
  });
  resolutionSelect.addEventListener("change", () => {
    setPref("resolution", resolutionSelect.value);
    switchCamera(parseResolution(resolutionSelect.value));
  });
  handsSelect.addEventListener("change", () => {
    const n = Number(handsSelect.value);
    setPref("hands", n);
    HandTracker.setMaxHands(n);
  });
  modelSelect.addEventListener("change", () => {
    const m = Number(modelSelect.value);
    setPref("model", m);
    HandTracker.setModelComplexity(m);
  });

  function toggleOverlay() {
    overlayOn = !overlayOn;
    setPref("overlay", overlayOn);
    HandTracker.setOverlay(overlayOn);
    setToggle(overlayToggle, overlayOn, "Overlay");
  }
  overlayToggle.addEventListener("click", toggleOverlay);

  readableToggle.addEventListener("click", () => {
    readableOn = !readableOn;
    setPref("readableText", readableOn);
    setToggle(readableToggle, readableOn, "Readable text");
  });

  function setMirror(on) {
    mirrorOn = on;
    HandTracker.setMirror(on);
    Hand3D.setMirror(on);
    setToggle(mirrorToggle, on, "Mirror");
  }

  // Runs whenever a camera or video opens, before its first frame is drawn. Front
  // cameras are mirrored like a selfie; so are webcams that don't say which way they
  // face, since they almost always face the user. Rear cameras and video files are
  // shown as they are. A camera's own choice from the Mirror button wins.
  function applyMirrorDefault(camera) {
    if (camera.source === "file") return setMirror(false);
    const chosen = camera.deviceId ? mirrorByCamera[camera.deviceId] : undefined;
    // Screens and windows (e.g. Motive's camera view) are shown as they are.
    setMirror(typeof chosen === "boolean" ? chosen : !camera.screen && camera.facing !== "environment");
  }
  HandTracker.onSourceChange(applyMirrorDefault);

  mirrorToggle.addEventListener("click", () => {
    setMirror(!mirrorOn);
    const camera = HandTracker.getCamera();
    if (camera.source === "camera" && camera.deviceId) {
      mirrorByCamera[camera.deviceId] = mirrorOn;
      setPref("mirrorByCamera", mirrorByCamera);
    }
  });

  legendToggle.addEventListener("click", () => {
    const open = legendEl.classList.toggle("open");
    legendToggle.classList.toggle("active", open);
  });

  function setCaptureControlsLocked(locked) {
    // Changing the camera or source mid-recording would change the frames being recorded.
    const busy = locked || VideoRecorder.isRecording() || RobotMotion.isRecording();
    const fileMode = HandTracker.getSource() === "file";
    cameraSelect.disabled = busy || fileMode;
    resolutionSelect.disabled = busy || fileMode;
    layoutSelect.disabled = VideoRecorder.isRecording();
    openVideoBtn.disabled = busy;
    // Recordings must move forward in time, so no seeking while one is running.
    vidSeek.disabled = busy;
    vidRestart.disabled = busy;
    vidCamera.disabled = busy;
    vidCapture.disabled = busy;
    // Flipping the video mid-recording would mirror the rest of the motion.
    vidMirrored.disabled = busy;
  }

  function showStageError(err) {
    const messages = {
      NotAllowedError: mobile
        ? "Camera access was denied. Open Android Settings › Apps › Hand Tracker › Permissions, allow the camera, then press Retry."
        : "Camera access was blocked. In Windows, open Settings › Privacy › Camera and turn on camera access for desktop apps, then press Retry.",
      NotFoundError: "No camera was found. Plug in a webcam and press Retry.",
      NotReadableError: "The camera is being used by another app (Zoom, Teams, OBS…). Close it and press Retry.",
      OverconstrainedError: "This camera doesn't support the selected resolution. Pick another resolution.",
    };
    stageMessage.hidden = false;
    stageMessage.className = "error";
    stageMessage.textContent = messages[err && err.name] || `Couldn't start: ${err && err.message ? err.message : err}`;
    const retry = document.createElement("button");
    retry.textContent = "Retry";
    retry.addEventListener("click", () => location.reload());
    stageMessage.appendChild(retry);
  }

  // ---------- Motion capture (robot JSON) ----------
  function updateMotionStatus() {
    const parts = RobotMotion.getStatus().map((s) => `${s.handedness[0]}: ${s.phase || "—"}`);
    motionStatus.textContent = `${RobotMotion.frameCount()} frames${parts.length ? " · " + parts.join(" · ") : " · waiting for a hand"}`;
  }

  let motion = null; // { data, motive, exported } — the last capture, waiting to be exported

  // ---------- OptiTrack Motive's live data (Windows app, NatNet) ----------
  const natnetApi = desktop && desktop.natnet;
  const motiveCard = $("motiveCard"), motiveServer = $("motiveServer"), motiveMulticast = $("motiveMulticast");
  const motiveConnect = $("motiveConnect"), motiveStatus = $("motiveStatus"), motiveView = $("motiveView"), motiveInfo = $("motiveInfo");
  let motiveState = "stopped";
  let motiveRecording = false;
  let motiveLast = null; // { n, t, at } for the frame rate
  let motiveRate = 0;

  function motiveStatusText(s) {
    if (s.state === "connected") return `Connected to ${s.app || "Motive"} ${s.appVersion ? s.appVersion.split(".").slice(0, 2).join(".") : ""} (NatNet ${s.version}) at ${s.server}.`;
    if (s.state === "waiting")
      return `Waiting for Motive at ${s.server}… In Motive, open View → Streaming Pane and turn on Broadcast Frame Data${motiveMulticast.checked ? "" : " (Transmission Type: Unicast)"}.`;
    return s.error ? `Not connected: ${s.error}` : "Not connected.";
  }

  // Motive's markers seen from the front (x across, z up), scaled to fit.
  function drawMotive(f) {
    const ctx = motiveView.getContext("2d");
    const W = motiveView.width, H = motiveView.height;
    ctx.fillStyle = "#0e0f12";
    ctx.fillRect(0, 0, W, H);
    const pts = [...f.markers.map((m) => m.p), ...f.rigidBodies.map((r) => r.p), ...f.skeletons.flatMap((s) => s.bones.map((b) => b.p))];
    if (!pts.length) return;
    let x0 = Infinity, x1 = -Infinity, z0 = 0, z1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]);
    }
    const span = Math.max(x1 - x0, z1 - z0, 500) * 1.15;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const scale = Math.min(W, H) / span;
    const at = (p) => [W / 2 + (p[0] - cx) * scale, H / 2 - (p[2] - cz) * scale];
    const [, floor] = at([0, 0, 0]);
    ctx.strokeStyle = "#2a2b31";
    ctx.beginPath();
    ctx.moveTo(0, floor);
    ctx.lineTo(W, floor);
    ctx.stroke();
    for (const m of f.markers) {
      const [x, y] = at(m.p);
      ctx.fillStyle = m.model ? "#74c0fc" : "#868e96";
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#63e6be";
    for (const s of f.skeletons) for (const b of s.bones) {
      const [x, y] = at(b.p);
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
    ctx.font = "12px Segoe UI, system-ui, sans-serif";
    for (const r of f.rigidBodies) {
      const [x, y] = at(r.p);
      ctx.fillStyle = r.valid ? "#ff922b" : "#5c3a1a";
      ctx.fillRect(x - 5, y - 5, 10, 10);
      ctx.fillText(r.name, x + 8, y - 6);
    }
  }

  if (natnetApi) {
    motiveCard.hidden = false;
    motiveServer.value = prefs.motiveServer || "127.0.0.1";
    motiveMulticast.checked = prefs.motiveMulticast !== false;
    motiveConnect.addEventListener("click", () => {
      if (motiveState === "stopped") {
        setPref("motiveServer", motiveServer.value.trim() || "127.0.0.1");
        setPref("motiveMulticast", motiveMulticast.checked);
        natnetApi.start({ server: motiveServer.value.trim() || "127.0.0.1", multicast: motiveMulticast.checked }).catch((err) => {
          motiveStatus.textContent = `Couldn't start: ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`;
        });
      } else natnetApi.stop();
    });
    natnetApi.onStatus((s) => {
      motiveState = s.state;
      motiveStatus.textContent = motiveStatusText(s) + (s.warning ? ` ${s.warning}` : "");
      motiveConnect.textContent = s.state === "stopped" ? "Connect" : "Disconnect";
      motiveServer.disabled = motiveMulticast.disabled = s.state !== "stopped";
      motiveView.hidden = s.state !== "connected";
      if (s.state !== "connected") motiveInfo.textContent = "";
    });
    natnetApi.onFrame((f) => {
      const now = performance.now();
      if (motiveLast && f.t > motiveLast.t && now - motiveLast.at > 900) {
        motiveRate = Math.round((f.n - motiveLast.n) / (f.t - motiveLast.t));
        motiveLast = { n: f.n, t: f.t, at: now };
      } else if (!motiveLast || f.t < motiveLast.t) motiveLast = { n: f.n, t: f.t, at: now };
      const labelled = f.markers.filter((m) => m.model).length;
      const bones = f.skeletons.reduce((n, s) => n + s.bones.length, 0);
      motiveInfo.textContent = `${labelled} labelled + ${f.markers.length - labelled} unlabelled markers · ${f.rigidBodies.length} rigid bod${f.rigidBodies.length === 1 ? "y" : "ies"} · ${f.skeletons.length} skeleton${f.skeletons.length === 1 ? "" : "s"}${bones ? ` (${bones} bones)` : ""}${motiveRate ? ` · ${motiveRate} Hz` : ""}${motiveRecording ? " · recording" : ""}`;
      drawMotive(f);
    });
  }

  // Motive's frames, recorded while motion capture ran, as a marker recording in the
  // viewer's format: labelled markers, rigid-body pivots and skeleton bones (mm, Z-up),
  // one row per Motive frame (numbered by Motive, so dropped network packets leave gaps).
  function motiveMarkerData(frames, name) {
    const rbNames = new Map();
    for (const f of frames) for (const rb of f.rigidBodies) rbNames.set(rb.id, rb.name);
    const columns = new Map();
    const labels = [];
    const column = (key, label) => {
      if (!columns.has(key)) {
        columns.set(key, labels.length);
        labels.push(labels.includes(label) ? `${label}_${labels.length}` : label);
      }
      return columns.get(key);
    };
    for (const f of frames) {
      for (const m of f.markers) if (m.model) column(`m${m.model}:${m.id}`, `${rbNames.get(m.model) || `Model${m.model}`}_${m.id}`);
      for (const rb of f.rigidBodies) column(`rb${rb.id}`, `${rb.name}_pivot`);
      for (const sk of f.skeletons) for (const b of sk.bones) column(`sk${sk.id}:${b.name}`, `${sk.name}_${b.name}`);
    }
    const first = frames[0], last = frames[frames.length - 1];
    const rate = last.t > first.t && last.n > first.n ? Math.round(((last.n - first.n) / (last.t - first.t)) * 100) / 100 : 120;
    const count = Math.max(1, last.n - first.n + 1);
    const positions = new Float32Array(count * labels.length * 3).fill(NaN);
    for (const f of frames) {
      const k = f.n - first.n;
      if (k < 0 || k >= count) continue;
      const put = (key, p) => positions.set(p, (k * labels.length + columns.get(key)) * 3);
      for (const m of f.markers) if (m.model) put(`m${m.model}:${m.id}`, m.p);
      for (const rb of f.rigidBodies) if (rb.valid) put(`rb${rb.id}`, rb.p);
      for (const sk of f.skeletons) for (const b of sk.bones) if (b.valid !== false) put(`sk${sk.id}:${b.name}`, b.p);
    }
    return {
      kind: "markers", name, source: "natnet", labels, frame_rate: rate, first_frame: 1, frame_count: count, duration: count / rate, positions,
      notes: ["Recorded live from OptiTrack Motive (NatNet): labelled markers, rigid-body pivots and skeleton bones, in millimetres, Z-up. Unlabelled markers aren't included."],
    };
  }

  function toggleMotion() {
    if (!RobotMotion.isRecording()) {
      if (motion && !motion.exported && !confirm("Discard the previous motion capture? It hasn't been exported yet.")) return;
      discardMotion();
      RobotMotion.start();
      motiveRecording = !!natnetApi && motiveState === "connected";
      if (motiveRecording) natnetApi.recordStart();
      motionBtn.firstChild.textContent = "Stop Motion Capture";
      motionBtn.classList.add("recording");
      setCaptureControlsLocked(false);
      updateMotionStatus();
      return;
    }
    const data = RobotMotion.stop();
    data.display_mirrored = mirrorOn; // lets the viewer draw paths the way they looked on screen
    data.image_size = [stage.width, stage.height]; // landmark x/y are normalized separately; exporters need the aspect
    if (HandTracker.isFileMirrored()) {
      data.notes.push("Tracked from a video recorded mirrored, flipped back before tracking, so Left/Right and positions are as a normal camera would have seen them.");
    }
    motionBtn.firstChild.textContent = "Start Motion Capture";
    motionBtn.classList.remove("recording");
    setCaptureControlsLocked(false);
    const motiveFrames = motiveRecording ? natnetApi.recordStop() : Promise.resolve(null);
    motiveRecording = false;
    return motiveFrames.then((frames) => {
      const motive = frames && frames.length > 1 ? motiveMarkerData(frames, "Motive") : null;
      if (!data.hands.length && !motive) {
        motionStatus.textContent = "No frames captured (no hand was visible).";
        return;
      }
      motionStatus.textContent = "";
      showMotionExport(data, motive);
    });
  }
  motionBtn.addEventListener("click", toggleMotion);

  function showMotionExport(data, motive = null) {
    motion = { data, motive, exported: false };
    const frames = data.hands.reduce((n, h) => n + h.frames.length, 0);
    const names = data.hands.map((h) => h.handedness).join(" + ");
    const handText = data.hands.length
      ? `${formatClock(data.duration)} · ${names} hand${data.hands.length > 1 ? "s" : ""} · ${frames} frames · ${data.frame_rate || "—"} fps`
      : "No hand was visible";
    const motiveText = motive ? ` · Motive: ${motive.labels.length} points × ${motive.frame_count} frames at ${motive.frame_rate} Hz` : "";
    motionInfo.textContent = handText + motiveText;
    motionName.value = `robot-motion-${timestampName()}`;
    motionResults.innerHTML = "";
    if (data.hands.length) renderFormatGrid(motionFormatGrid, MotionExport.FORMATS, "motionFormats", ["json"]);
    else renderFormatGrid(motionFormatGrid, MotionExport.MARKER_FORMATS, "motiveFormats", ["c3d"]);
    motionNote.textContent =
      (data.hands.length ? "BVH, GLB, C3D and TRC are scaled to approximate real-world size, assuming an average adult hand (a single webcam can't measure distance). BVH writes one file per hand." : "") +
      (motive ? ` Motive's data is saved alongside, as <name>-motive.c3d, .trc and so on, in each chosen format that holds markers (not BVH).` : "");
    motionExportCard.hidden = false;
    motionExportCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function discardMotion() {
    motion = null;
    motionExportCard.hidden = true;
  }
  motionDiscardBtn.addEventListener("click", discardMotion);

  async function exportMotion() {
    if (!motion) return;
    const formats = checkedIds(motionFormatGrid);
    if (!formats.length) {
      motionNote.textContent = "Pick at least one format.";
      return;
    }
    const baseName = motionName.value.trim() || `robot-motion-${timestampName()}`;
    let files = [];
    try {
      if (motion.data.hands.length) files = MotionExport.build(motion.data, formats, baseName);
      if (motion.motive) {
        const markerIds = formats.filter((id) => MotionExport.MARKER_FORMATS.some((f) => f.id === id));
        const motiveFiles = MotionExport.buildMarkers(motion.motive, markerIds, `${baseName}-motive`);
        files.push(...motiveFiles.map((f) => ({ ...f, suffix: `-motive${f.suffix}` })));
      }
      if (!files.length) throw new Error("none of the chosen formats can hold this data (pick C3D, TRC, CSV, GLB, NPZ or JSON)");
    } catch (err) {
      motionNote.textContent = `Couldn't convert: ${err.message}`;
      return;
    }

    motionExportBtn.disabled = true;
    motionDiscardBtn.disabled = true;
    try {
      const res = await ExportUI.saveFiles({ title: "Choose a folder for the motion capture files", baseName, files });
      if (res.canceled) {
        motionNote.textContent = "Export canceled.";
        return;
      }
      if (res.downloaded) {
        motion.exported = true;
        motionNote.textContent = `Downloaded ${res.count} file${res.count === 1 ? "" : "s"}.`;
        return;
      }
      renderResults(motionResults, res.results);
      const saved = res.results.filter((r) => r.ok).length;
      if (saved) motion.exported = true;
      motionNote.textContent = saved ? `Saved ${saved} file${saved === 1 ? "" : "s"} to ${res.dir}` : "Nothing was saved.";
    } catch (err) {
      motionNote.textContent = `Export failed: ${err.message}`;
    } finally {
      motionExportBtn.disabled = false;
      motionDiscardBtn.disabled = false;
    }
  }
  motionExportBtn.addEventListener("click", exportMotion);

  // ---------- Video recording ----------
  let clip = null; // { blob, url, container, duration, width, height, fps, exported }
  let recordTimer = null;
  let exporting = false;

  function recordingSources() {
    const sources = [stage];
    if (layoutSelect.value === "camera+3d") sources.push(Hand3D.getCanvas());
    return sources;
  }

  async function toggleVideo() {
    if (exporting) return;
    if (!VideoRecorder.isRecording()) {
      if (clip && !clip.exported && !confirm("Discard the previous clip? It hasn't been exported yet.")) return;
      discardClip();
      try {
        // Phones get MP4 straight from the encoder (there's no ffmpeg on Android to convert later).
        // From a video file, keep every tracked frame so the clip can be re-timed to the source.
        VideoRecorder.start({ sources: recordingSources(), fps: RECORD_FPS, preferMp4: !!mobile, everyFrame: HandTracker.getSource() === "file" });
      } catch (err) {
        videoStatus.textContent = err.message;
        return;
      }
      videoBtn.firstChild.textContent = "Stop Recording";
      videoBtn.classList.add("recording");
      recBadge.hidden = false;
      setCaptureControlsLocked(true);
      const tick = () => {
        const t = formatClock(VideoRecorder.elapsed());
        recBadge.textContent = `REC ${t}`;
        videoStatus.textContent = `Recording… ${t}`;
      };
      tick();
      recordTimer = setInterval(tick, 250);
      return;
    }

    clearInterval(recordTimer);
    videoBtn.firstChild.textContent = "Record Video";
    videoBtn.classList.remove("recording");
    recBadge.hidden = true;
    try {
      const result = await VideoRecorder.stop();
      // Frames from a video file were captured at processing speed; exports re-time
      // them to the source frame rate (with ffmpeg, or ffmpeg.wasm outside the Windows app).
      if (HandTracker.getSource() === "file") result.retimeFps = HandTracker.file.fps();
      videoStatus.textContent = "";
      showExport(result);
    } catch (err) {
      videoStatus.textContent = `Recording failed: ${err.message}`;
    } finally {
      setCaptureControlsLocked(false); // only once the recorder has really stopped
    }
  }
  videoBtn.addEventListener("click", toggleVideo);
  layoutSelect.addEventListener("change", () => setPref("layout", layoutSelect.value));

  // ---------- Export ----------
  let appInfo = null; // desktop capabilities (formats, ffmpeg)

  // Formats offered for a recording: every format in video-formats.js, converted by the
  // Windows app's ffmpeg or, in a browser or on Android, by ffmpeg.wasm (video-convert.js).
  const canConvertHere = () => !desktop && VideoConvert.supported();

  function availableFormats() {
    if (appInfo) {
      return appInfo.formats.map((f) => ({ ...f, available: appInfo.ffmpeg || f.id === clip.container }));
    }
    if (canConvertHere()) return VideoConvert.formats();
    // No converter: only the format MediaRecorder produced can be saved.
    const label = clip.container.toUpperCase();
    const detail = mobile ? "Recorded by the phone's video encoder" : "Recorded directly by the browser";
    return [{ id: clip.container, label, detail, available: true }];
  }

  // Checkbox grid of formats (export-ui.js); the selection is remembered in prefs[prefKey].
  function renderFormatGrid(grid, formats, prefKey, defaults) {
    const selected = Array.isArray(prefs[prefKey]) ? prefs[prefKey] : defaults;
    ExportUI.renderFormatGrid(grid, formats, selected, (ids) => setPref(prefKey, ids));
  }

  function showExport(result) {
    if (!result || !result.blob.size) {
      videoStatus.textContent = "Nothing was recorded.";
      return;
    }
    clip = { ...result, url: URL.createObjectURL(result.blob), exported: false };
    clipPreview.src = clip.url;
    const retimed = clip.retimeFps && (desktop || canConvertHere());
    const shownDuration = retimed ? clip.frames / clip.retimeFps : clip.duration;
    clipInfo.textContent = `${formatClock(shownDuration)} · ${clip.width} × ${clip.height} · ${formatBytes(clip.blob.size)} · recorded as ${clip.mimeType}` +
      (clip.retimeFps ? (retimed ? ` · timed to the video's ${clip.retimeFps} fps` : " · plays at the speed frames were tracked") : "");
    exportName.value = `hand-tracker-${timestampName()}`;
    exportResults.innerHTML = "";
    exportProgress.hidden = true;
    renderFormatGrid(formatGrid, availableFormats(), "formats", ["mp4"]);
    if (mobile) {
      exportNote.textContent = "Saves to Documents/Hand Tracker on this phone. Use Share to send it to Photos, Drive, email or another app." +
        (canConvertHere() ? " Other formats are converted on the phone (the converter downloads once, about 32 MB)." : "");
    } else if (!desktop) {
      exportNote.textContent = canConvertHere()
        ? "Pick one or more formats. They're converted in this browser (nothing is uploaded; the converter downloads once, about 32 MB) and each downloads when it's ready. HEVC and AV1 need the Windows app."
        : "This browser can't run the video converter, so the clip can be saved as recorded. The Windows app exports every format.";
    } else if (appInfo && !appInfo.ffmpeg) {
      exportNote.textContent = "ffmpeg wasn't found, so only the original format can be exported.";
    } else {
      exportNote.textContent = "Pick one or more formats — you'll choose the folder next.";
    }
    exportCard.hidden = false;
    exportCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // MediaRecorder WebM files have no duration header, so the preview's seek
  // bar is broken until the browser has scanned to the end once.
  clipPreview.addEventListener("loadedmetadata", () => {
    if (clipPreview.duration === Infinity) {
      clipPreview.currentTime = 1e9;
      clipPreview.addEventListener("timeupdate", () => (clipPreview.currentTime = 0), { once: true });
    }
  });

  function discardClip() {
    if (!clip) return;
    clipPreview.removeAttribute("src");
    clipPreview.load();
    URL.revokeObjectURL(clip.url);
    clip = null;
    exportCard.hidden = true;
  }
  discardBtn.addEventListener("click", discardClip);

  function setExporting(on) {
    exporting = on;
    exportBtn.disabled = on;
    discardBtn.disabled = on;
    videoBtn.disabled = on;
    cancelExportBtn.hidden = !on || !(desktop || canConvertHere());
    exportProgress.hidden = !on;
    for (const input of formatGrid.querySelectorAll("input")) input.disabled = on || input.closest(".unavailable") !== null;
  }

  function renderProgress({ format, index, total, progress, loading }) {
    const overall = (index + (progress || 0)) / total;
    progressFill.style.width = `${Math.round(overall * 100)}%`;
    progressLabel.textContent = loading
      ? "Loading the video converter (about 32 MB, only the first time)…"
      : `Converting ${String(format).toUpperCase()} (${index + 1} of ${total})… ${Math.round((progress || 0) * 100)}%`;
  }

  // Browser and Android: convert with ffmpeg.wasm; each file is saved (phone) or
  // downloaded (browser) as soon as it's ready.
  async function convertClipHere(formats, baseName) {
    setExporting(true);
    progressFill.style.width = "0%";
    progressLabel.textContent = "Starting…";
    exportResults.innerHTML = "";
    const saves = [];
    try {
      const out = await VideoConvert.convert(clip.blob, formats, {
        name: `recording.${clip.container}`,
        fps: clip.fps,
        retimeFps: clip.retimeFps || 0,
        duration: clip.retimeFps ? clip.frames / clip.retimeFps : clip.duration,
        constantRate: true,
        copyFromWebm: clip.container === "webm",
        onProgress: renderProgress,
        onResult: (r) => {
          if (!r.ok) return saves.push(Promise.resolve(r));
          if (mobile) {
            saves.push(
              mobile
                .saveFiles({ baseName, files: [{ format: r.format, suffix: r.suffix, ext: r.ext, data: r.data }] })
                .then((res) => ({ ...res.results[0], dir: res.dir }))
                .catch((err) => ({ format: r.format, ok: false, error: err.message }))
            );
          } else {
            const fileName = `${baseName}${r.suffix}.${r.ext}`;
            downloadBlob(new Blob([r.data]), fileName);
            saves.push(Promise.resolve({ format: r.format, ok: true, path: fileName, size: r.data.length }));
          }
        },
      });
      const results = await Promise.all(saves);
      renderResults(exportResults, results);
      const saved = results.filter((r) => r.ok).length;
      const failed = results.length - saved;
      if (saved) clip.exported = true;
      const dir = (results.find((r) => r.dir) || {}).dir;
      exportNote.textContent =
        (saved ? (mobile ? `Saved ${saved} file${saved === 1 ? "" : "s"} to ${dir}` : `Downloaded ${saved} file${saved === 1 ? "" : "s"}`) : "Nothing was exported") +
        (out.canceled ? " (canceled)." : failed ? `; ${failed} couldn't be converted.` : ".");
    } catch (err) {
      exportNote.textContent = `Export failed: ${err.message}`;
    } finally {
      setExporting(false);
    }
  }

  async function exportClip() {
    if (!clip || exporting) return;
    const formats = checkedIds(formatGrid);
    if (!formats.length) {
      exportNote.textContent = "Pick at least one format.";
      return;
    }
    const baseName = exportName.value.trim() || `hand-tracker-${timestampName()}`;

    // Anything beyond saving the clip exactly as recorded goes through the converter.
    const asRecorded = formats.length === 1 && formats[0] === clip.container && !clip.retimeFps;
    if (!desktop && canConvertHere() && !asRecorded) return convertClipHere(formats, baseName);

    if (mobile) {
      exportBtn.disabled = true;
      try {
        const data = new Uint8Array(await clip.blob.arrayBuffer());
        const res = await mobile.saveFiles({ baseName, files: [{ format: clip.container, suffix: "", ext: clip.container, data }] });
        renderResults(exportResults, res.results);
        const saved = res.results.filter((r) => r.ok).length;
        if (saved) clip.exported = true;
        exportNote.textContent = saved ? `Saved to ${res.dir}` : "Couldn't save the video.";
      } catch (err) {
        exportNote.textContent = `Save failed: ${err.message}`;
      } finally {
        exportBtn.disabled = false;
      }
      return;
    }
    if (!desktop) {
      downloadBlob(clip.blob, `${baseName}.${clip.container}`);
      clip.exported = true;
      exportNote.textContent = `Downloaded ${baseName}.${clip.container}`;
      return;
    }

    setExporting(true);
    progressFill.style.width = "0%";
    progressLabel.textContent = "Choose a folder…";
    exportResults.innerHTML = "";
    const unsubscribe = desktop.onExportProgress(renderProgress);
    try {
      const res = await desktop.exportVideo({
        bytes: await clip.blob.arrayBuffer(),
        container: clip.container,
        formats,
        baseName,
        duration: clip.retimeFps ? clip.frames / clip.retimeFps : clip.duration,
        retimeFps: clip.retimeFps || 0,
        fps: clip.fps,
      });
      if (res.canceled && !res.results.length) {
        exportNote.textContent = "Export canceled.";
        return;
      }
      renderResults(exportResults, res.results);
      const saved = res.results.filter((r) => r.ok).length;
      if (saved) clip.exported = true;
      exportNote.textContent = saved ? `Saved ${saved} file${saved === 1 ? "" : "s"} to ${res.dir}` : "Nothing was exported.";
    } catch (err) {
      exportNote.textContent = `Export failed: ${err.message}`;
    } finally {
      unsubscribe();
      setExporting(false);
    }
  }
  exportBtn.addEventListener("click", exportClip);
  cancelExportBtn.addEventListener("click", () => (desktop ? desktop.cancelExport() : VideoConvert.cancel()));

  // ---------- Video files as the tracking source ----------
  let videoUrl = null; // object URL of the opened file (revoked when replaced)
  let videoUiTimer = null;

  function showSourceNote(text) {
    sourceNote.textContent = text;
    sourceNote.hidden = !text;
  }

  // A video marked as mirrored is flipped back before tracking (see the Mirrored video button).
  const videoOptions = (name) => ({ name, mirrored: mirroredVideos[name] === true });

  // Converts a video the page can't play into an MP4 it can (ffmpeg.wasm), then tracks that.
  let convertedUrl = null;
  async function openConverted(name, file) {
    const blob = await VideoConvert.toPlayable(file, ({ progress, loading }) => {
      stageMessage.textContent = loading
        ? "Loading the video converter (about 32 MB, only the first time)…"
        : `Converting ${name} to a playable format… ${Math.round(progress * 100)}%`;
    });
    if (convertedUrl) URL.revokeObjectURL(convertedUrl);
    convertedUrl = URL.createObjectURL(blob);
    await HandTracker.useVideoFile(convertedUrl, videoOptions(name));
  }

  // Opens a video to track. url: something the page can play (object URL);
  // filePath: the file on disk (Windows app), used to convert formats the page can't play;
  // sourceFile: the File itself, converted in the page when it can't be played (browser, Android).
  async function openVideo(name, url, filePath, sourceFile) {
    if (VideoRecorder.isRecording() || RobotMotion.isRecording()) {
      showSourceNote("Stop recording before opening a video.");
      return false;
    }
    showSourceNote("");
    stageMessage.hidden = false;
    stageMessage.className = "";
    stageMessage.textContent = `Opening ${name}…`;
    try {
      try {
        await HandTracker.useVideoFile(url, videoOptions(name));
      } catch (err) {
        // Formats the page can't play (AVI, MPEG, WMV, FLV…) are converted: by the Windows
        // app's ffmpeg, or by ffmpeg.wasm in a browser or on Android.
        if (!desktop && canConvertHere() && sourceFile) {
          await openConverted(name, sourceFile);
          stageMessage.hidden = true;
          enterVideoMode(name);
          return true;
        }
        if (!(desktop && desktop.importVideo && filePath)) {
          throw new Error(`${err.message}. ${desktop ? "" : "This browser can't convert it either; the Windows app can open it, or convert the video to MP4 first."}`.trim());
        }
        stageMessage.textContent = `Converting ${name} to a playable format…`;
        const off = desktop.onImportProgress(({ progress }) => {
          stageMessage.textContent = `Converting ${name} to a playable format… ${Math.round(progress * 100)}%`;
        });
        try {
          const converted = await desktop.importVideo(filePath);
          await HandTracker.useVideoFile(converted.url, videoOptions(name));
        } finally {
          off();
        }
      }
    } catch (err) {
      stageMessage.hidden = true;
      // If the switch got as far as stopping the previous source, go back to the camera.
      if (!HandTracker.getCamera().width) await backToCamera();
      showSourceNote(`Couldn't open ${name}: ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`);
      return false;
    }
    stageMessage.hidden = true;
    enterVideoMode(name);
    return true;
  }

  function enterVideoMode(name) {
    videoBar.hidden = false;
    vidName.textContent = name;
    vidRate.value = "1";
    setToggle(vidMirrored, HandTracker.isFileMirrored(), "Mirrored video");
    setCaptureControlsLocked(false);
    clearInterval(videoUiTimer);
    videoUiTimer = setInterval(updateVideoBar, 200);
    updateVideoBar();
  }

  function updateVideoBar() {
    const f = HandTracker.file;
    const d = f.duration();
    vidSeek.max = String(d || 1);
    if (document.activeElement !== vidSeek) vidSeek.value = String(f.time());
    const clock = (s) => `${Math.floor(s / 60)}:${pad2(Math.floor(s % 60))}`;
    vidTime.textContent = `${clock(f.time())} / ${clock(d)}`;
    vidPlay.textContent = f.playing() ? "❚❚ Pause" : "▶ Play";
  }

  async function backToCamera() {
    clearInterval(videoUiTimer);
    videoBar.hidden = true;
    showSourceNote("");
    try {
      await HandTracker.useCamera();
    } catch (err) {
      showStageError(err);
    }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = null;
    if (convertedUrl) URL.revokeObjectURL(convertedUrl);
    convertedUrl = null;
    setCaptureControlsLocked(false);
  }

  openVideoBtn.addEventListener("click", () => videoFileInput.click());
  videoFileInput.addEventListener("change", async () => {
    const f = videoFileInput.files[0];
    videoFileInput.value = "";
    if (!f) return;
    const url = URL.createObjectURL(f);
    const filePath = desktop && desktop.pathForFile ? desktop.pathForFile(f) : "";
    if (await openVideo(f.name, url, filePath, f)) {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      videoUrl = url;
    } else URL.revokeObjectURL(url);
  });
  vidPlay.addEventListener("click", () => {
    if (HandTracker.file.playing()) HandTracker.file.pause();
    else HandTracker.file.play();
    updateVideoBar();
  });
  vidRestart.addEventListener("click", () => {
    HandTracker.file.seek(0);
    HandTracker.file.play();
  });
  vidSeek.addEventListener("input", () => HandTracker.file.seek(Number(vidSeek.value)));
  vidRate.addEventListener("change", () => HandTracker.file.setRate(Number(vidRate.value)));
  // A video recorded mirrored (many phones save front-camera videos the way the preview
  // looked) shows every hand as the other one: flip it back before tracking. Remembered
  // for that video.
  vidMirrored.addEventListener("click", async () => {
    const name = HandTracker.file.name();
    const on = !HandTracker.isFileMirrored();
    delete mirroredVideos[name]; // re-added last, so the oldest names are the ones dropped
    if (on) mirroredVideos[name] = true;
    const names = Object.keys(mirroredVideos);
    for (const old of names.slice(0, Math.max(0, names.length - MIRRORED_VIDEOS_KEPT))) delete mirroredVideos[old];
    setPref("mirroredVideos", mirroredVideos);
    setToggle(vidMirrored, on, "Mirrored video");
    await HandTracker.setFileMirrored(on);
  });
  vidCamera.addEventListener("click", backToCamera);
  // Motion capture over the whole video: rewind, capture, and stop at the end.
  vidCapture.addEventListener("click", () => {
    if (RobotMotion.isRecording()) return;
    HandTracker.file.pause();
    HandTracker.file.seek(0);
    toggleMotion();
    HandTracker.file.play();
  });
  // At the end of the video, finish whatever was being recorded.
  HandTracker.onVideoEnded(() => {
    if (VideoRecorder.isRecording()) toggleVideo();
    if (RobotMotion.isRecording()) toggleMotion();
    updateVideoBar();
  });

  // ---------- Keyboard shortcuts ----------
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const key = e.key.toLowerCase();
    if (key === "r") toggleVideo();
    else if (key === "m") toggleMotion();
    else if (key === "o") toggleOverlay();
    else return;
    e.preventDefault();
  });

  // Which copy is running: "v1.1.0 · built 25 Sep, 14:10". The web/Android bundle
  // carries its build time in a meta tag; the Windows app reports its own.
  function showBuild(version, built) {
    const when = built ? new Date(built) : null;
    const stamp = when && !isNaN(when)
      ? `built ${when.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
      : "development copy";
    buildInfo.textContent = version ? `v${version} · ${stamp}` : stamp;
    buildInfo.title = when && !isNaN(when) ? `Built ${when.toString()}` : "Running from the source folder, not a built copy";
  }

  // ---------- Startup ----------
  async function main() {
    videoFileInput.accept = VideoFormats.IMPORT_ACCEPT;
    setToggle(overlayToggle, overlayOn, "Overlay");
    setToggle(mirrorToggle, mirrorOn, "Mirror");
    setToggle(readableToggle, readableOn, "Readable text");
    renderPanels([]);
    if (!VideoRecorder.isSupported()) {
      videoBtn.disabled = true;
      videoStatus.textContent = "Video recording isn't supported here.";
    }
    if (mobile) {
      // The Android app has a single screen, so the viewer opens in place (it has a Back link).
      const viewerLink = document.querySelector('a[href="viewer.html"]');
      if (viewerLink) {
        viewerLink.removeAttribute("target");
        viewerLink.textContent = "Recording Viewer";
      }
      exportBtn.firstChild.textContent = "Save";
      motionExportBtn.firstChild.textContent = "Save";
    }
    const buildMeta = document.querySelector('meta[name="hand-tracker-build"]');
    if (buildMeta) showBuild(buildMeta.dataset.version, buildMeta.content);
    else if (!desktop) showBuild(null, null);
    if (desktop) {
      desktop
        .getInfo()
        .then((info) => {
          appInfo = info;
          showBuild(info.version, info.built);
        })
        .catch(() => {});
    }

    Hand3D.init($("threeContainer"));
    Hand3D.setMirror(mirrorOn);

    await HandTracker.init({
      videoEl: video,
      canvasEl: stage,
      overlay: overlayOn,
      mirror: mirrorOn,
      maxNumHands: Number(handsSelect.value),
      modelComplexity: Number(modelSelect.value),
      deviceId: prefs.cameraId || null,
      ...parseResolution(resolutionSelect.value),
    });
    stageMessage.hidden = true;
    populateCameras();

    let stallShown = false;
    HandTracker.onCameraStatus((status) => {
      if (status === "stalled") {
        stallShown = true;
        stageMessage.hidden = false;
        stageMessage.className = "error";
        stageMessage.textContent = "The camera stopped sending video. Reconnecting… Check it's plugged in and not in use by another app.";
      } else if (stallShown) {
        stallShown = false;
        stageMessage.hidden = true;
      }
    });
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", populateCameras);
    }

    HandTracker.onHandLandmarks(({ hands, timestamp }) => {
      syncStageAspect();
      updateGestures(hands);
      // Un-flip text in the camera picture, or only times with Readable text off (not with a
      // crop: OCR reads the whole picture).
      if (!HandTracker.getCamera().crop) ReadableText.process(HandTracker.getFrameImage(), stage, mirrorOn, hands, !readableOn);
      drawStageLabels(hands);
      VideoRecorder.frame(); // after labels, so recordings match what's on screen

      Hand3D.update(hands);

      if (RobotMotion.isRecording()) {
        RobotMotion.feed(hands, timestamp);
        updateMotionStatus();
      }

      renderPanels(hands);
      const cam = HandTracker.getCamera();
      const videoFps = cam.source === "file" && HandTracker.file.fps() ? ` · video ${HandTracker.file.fps()} fps` : "";
      fpsBadge.textContent = `FPS: ${HandTracker.getFPS()} · ${cam.width}×${cam.height}${videoFps}`;
    });
  }

  // Entry points for the automated checks (same code paths as the buttons).
  window.HandTrackerApp = { openVideo, backToCamera, openCapturePicker, useCaptureSource };

  main().catch((err) => {
    console.error(err);
    showStageError(err);
  });
})();
