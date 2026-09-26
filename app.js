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
  // Mirror: on for selfie cameras, off for rear cameras and video files (see
  // applyMirrorDefault). Labels are drawn after the flip, and text in the camera
  // picture is detected and flipped back (readable-text.js), so numbers and words
  // always read correctly.
  let mirrorOn = true;
  // Mirror choices made with the button, per camera: deviceId -> on/off.
  const mirrorByCamera = prefs.mirrorByCamera && typeof prefs.mirrorByCamera === "object" ? prefs.mirrorByCamera : {};
  delete prefs.mirror; // the old single setting for every camera
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

  // The Bird's shape, measured from the picture. Landmarks are wrist-relative
  // fractions of the picture's width (x) and height (y), so x is scaled by the aspect
  // ratio to compare real directions and lengths.
  // Checked against photos of the gesture (scripts/fixtures/gesture-hands.json): the
  // curl readings for the other fingers run low in this pose, since the ring finger
  // can't fully curl while the middle one is straight, but how far each fingertip
  // reaches from the wrist separates cleanly. Curled fingertips reach under 0.6 of
  // the middle fingertip's distance; straight ones over 0.9.
  function isTheBird(landmarks) {
    if (!landmarks) return false;
    const cam = HandTracker.getCamera();
    const aspect = cam.width && cam.height ? cam.width / cam.height : 1;
    const at = (i) => ({ x: landmarks[i].x * aspect, y: landmarks[i].y });
    const reach = (i) => Math.hypot(at(i).x, at(i).y);
    // Only the middle finger up: the index, ring and little fingertips fall well short of it.
    const middleReach = reach(12);
    if (![8, 16, 20].every((tip) => reach(tip) < 0.65 * middleReach)) return false;

    const knuckle = at(9), tip = at(12), indexKnuckle = at(5), pinkyKnuckle = at(17);
    const palmLength = Math.hypot(knuckle.x, knuckle.y) || 1e-6; // wrist to middle knuckle
    const fx = tip.x - knuckle.x, fy = tip.y - knuckle.y;
    const fingerLength = Math.hypot(fx, fy);
    // Raised: up or sideways on screen, just not pointing down. Sideways counts because
    // a phone held on its side with auto-rotate off turns the whole picture. A finger
    // pointing at the camera looks short, and its on-screen direction means little.
    const raised = fingerLength > 0.5 * palmLength && fy < 0.7 * fingerLength;
    // Facing the camera: side-on, the knuckles line up one behind another and their
    // spread nearly vanishes.
    const facing = Math.hypot(pinkyKnuckle.x - indexKnuckle.x, pinkyKnuckle.y - indexKnuckle.y) > 0.4 * palmLength;
    return raised && facing;
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
    const EXTENDED = 0.35, CURLED = 0.6;

    // The Bird: only the middle finger up (the thumb can be tucked or out), raised
    // with the hand facing the camera. Checked first: a thumb tucked over the curled
    // index finger would otherwise read as Pinch.
    if (c.middle < EXTENDED && isTheBird(hand.landmarks)) {
      return { label: "The Bird", color: "#da77f2" };
    }

    // OK Sign: thumb+index touching (same signal as Pinch) but with the
    // other three fingers held out — that's what makes it a ring, not a fist.
    if (f.thumbIndexDistance < 0.06 && c.middle < EXTENDED && c.ring < EXTENDED && c.pinky < EXTENDED) {
      return { label: "OK Sign", color: "#ffd43b" };
    }
    if (f.thumbIndexDistance < 0.06) return { label: "Pinch", color: "#f783ac" };

    // Thumbs Up: thumb extended and pointing well above the wrist (screen-up,
    // i.e. negative Y in image space) relative to the hand's own scale, with
    // the other four fingers curled into the palm.
    const landmarks = hand.landmarks;
    if (landmarks) {
      const palmSize = Math.hypot(landmarks[9].x, landmarks[9].y, landmarks[9].z) || 1e-6;
      const thumbUpRatio = -landmarks[4].y / palmSize;
      if (c.thumb < EXTENDED && c.index > CURLED && c.middle > CURLED && c.ring > CURLED && c.pinky > CURLED && thumbUpRatio > 1.0) {
        return { label: "Thumbs Up", color: "#69db7c" };
      }
    }

    if (avgCurl > 0.7) return { label: "Fist", color: "#ff6b6b" };
    if (avgCurl < 0.15) return { label: "Open Palm", color: "#51cf66" };

    // Peace / Victory: index + middle extended, ring + pinky curled.
    if (c.index < EXTENDED && c.middle < EXTENDED && c.ring > CURLED && c.pinky > CURLED) {
      return { label: "Peace", color: "#66d9e8" };
    }
    // Rock and Roll: index + pinky extended, middle + ring curled.
    if (c.index < EXTENDED && c.pinky < EXTENDED && c.middle > CURLED && c.ring > CURLED) {
      return { label: "Rock On", color: "#b197fc" };
    }
    // Call Me / Shaka: identical finger shape (thumb + pinky extended,
    // index/middle/ring curled) — real-world difference is motion, not
    // shape, so a rocking wrist wave means Shaka; held steady means Call Me.
    if (c.thumb < EXTENDED && c.pinky < EXTENDED && c.index > CURLED && c.middle > CURLED && c.ring > CURLED) {
      const isWaving = detectWristWave(hand.handedness, hand.orientation.palmEuler.roll);
      return isWaving ? { label: "Shaka", color: "#20c997" } : { label: "Call Me", color: "#ff922b" };
    }
    if (c.index < 0.3 && c.middle > 0.6 && c.ring > 0.6 && c.pinky > 0.6)
      return { label: "Point", color: "#74c0fc" };
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
  }

  function parseResolution(value) {
    const [width, height] = value.split("x").map(Number);
    return { width, height };
  }

  async function switchCamera(opts) {
    stageMessage.hidden = false;
    stageMessage.className = "";
    stageMessage.textContent = "Switching camera…";
    try {
      await HandTracker.setCamera(opts);
      stageMessage.hidden = true;
    } catch (err) {
      showStageError(err);
    }
  }

  cameraSelect.addEventListener("change", () => {
    setPref("cameraId", cameraSelect.value || null);
    switchCamera({ deviceId: cameraSelect.value || null });
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
    setMirror(typeof chosen === "boolean" ? chosen : camera.facing !== "environment");
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

  let motion = null; // { data, exported } — the last capture, waiting to be exported

  function toggleMotion() {
    if (!RobotMotion.isRecording()) {
      if (motion && !motion.exported && !confirm("Discard the previous motion capture? It hasn't been exported yet.")) return;
      discardMotion();
      RobotMotion.start();
      motionBtn.firstChild.textContent = "Stop Motion Capture";
      motionBtn.classList.add("recording");
      setCaptureControlsLocked(false);
      updateMotionStatus();
      return;
    }
    const data = RobotMotion.stop();
    data.display_mirrored = mirrorOn; // lets the viewer draw paths the way they looked on screen
    data.image_size = [stage.width, stage.height]; // landmark x/y are normalized separately; exporters need the aspect
    motionBtn.firstChild.textContent = "Start Motion Capture";
    motionBtn.classList.remove("recording");
    setCaptureControlsLocked(false);
    if (!data.hands.length) {
      motionStatus.textContent = "No frames captured (no hand was visible).";
      return;
    }
    motionStatus.textContent = "";
    showMotionExport(data);
  }
  motionBtn.addEventListener("click", toggleMotion);

  function showMotionExport(data) {
    motion = { data, exported: false };
    const frames = data.hands.reduce((n, h) => n + h.frames.length, 0);
    const names = data.hands.map((h) => h.handedness).join(" + ");
    motionInfo.textContent = `${formatClock(data.duration)} · ${names} hand${data.hands.length > 1 ? "s" : ""} · ${frames} frames · ${data.frame_rate || "—"} fps`;
    motionName.value = `robot-motion-${timestampName()}`;
    motionResults.innerHTML = "";
    renderFormatGrid(motionFormatGrid, MotionExport.FORMATS, "motionFormats", ["json"]);
    motionNote.textContent =
      "BVH, GLB, C3D and TRC are scaled to approximate real-world size, assuming an average adult hand (a single webcam can't measure distance). BVH writes one file per hand.";
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
    let files;
    try {
      files = MotionExport.build(motion.data, formats, baseName);
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
    await HandTracker.useVideoFile(convertedUrl, { name });
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
        await HandTracker.useVideoFile(url, { name });
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
          await HandTracker.useVideoFile(converted.url, { name });
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
      ReadableText.process(video, stage, mirrorOn, hands); // un-flip text in the camera picture
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
  window.HandTrackerApp = { openVideo, backToCamera };

  main().catch((err) => {
    console.error(err);
    showStageError(err);
  });
})();
