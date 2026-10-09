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
  // A phone (the Android app, or the website on a touch screen narrower than a tablet's).
  const onPhone = !!mobile || (matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 600);

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
  const rotateSelect = $("rotateSelect");
  const overlayToggle = $("overlayToggle");
  const mirrorToggle = $("mirrorToggle");
  const readableToggle = $("readableToggle");
  const legendToggle = $("legendToggle");
  const pauseToggle = $("pauseToggle");
  const pauseBadge = $("pauseBadge");
  const squareToggle = $("squareToggle");
  const farToggle = $("farToggle");
  const glovesToggle = $("glovesToggle");
  const farFocus = $("farFocus");
  const farRaised = $("farRaised");
  const showBar = $("showBar");
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
  // Mirrored video choices made with the button, by file name: name -> on/off.
  const mirroredVideos = prefs.mirroredVideos && typeof prefs.mirroredVideos === "object" ? prefs.mirroredVideos : {};
  const MIRRORED_VIDEOS_KEPT = 200;
  if (prefs.resolution) resolutionSelect.value = prefs.resolution;
  if (prefs.hands) handsSelect.value = String(prefs.hands);
  // Full by default: on real hands it lost them in a third as many frames as Lite, for a
  // few ms more a frame on a PC. Phones and ARM boards (a Raspberry Pi) keep Lite: they're
  // slower. A choice made is kept.
  const slowDevice = !!mobile || /aarch64|arm/i.test(navigator.userAgent);
  if (prefs.model !== undefined) modelSelect.value = String(prefs.model);
  else modelSelect.value = slowDevice ? "0" : "1";
  if (prefs.layout) layoutSelect.value = prefs.layout;
  let squareOn = prefs.squareCrop === true;
  let glovesOn = prefs.blackGloves === true;
  // Far-away hands (see far-hands.js): off by default; which hands to look for.
  const farPrefs = { enabled: false, raisedOnly: true, focus: "both", ...(prefs.far && typeof prefs.far === "object" ? prefs.far : {}) };
  // What's drawn on the picture (the Show buttons and keys 1-7, F).
  const DISPLAY_DEFAULTS = { box: false, skeleton: true, side: true, scores: false, gesture: true, distance: true, focus: true, objects: true, fps: true };
  const display = { ...DISPLAY_DEFAULTS, ...(prefs.display && typeof prefs.display === "object" ? prefs.display : {}) };

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

  const NO_GESTURE = HandGestures.NONE;
  // Every label a gesture can have (for gesture actions).
  const GESTURE_LABELS = HandGestures.LABELS;
  // This frame's gesture per side (gestures.js), classified once in the frame handler and
  // shared by the stage labels, hand cards and Both Hands panel.
  const handGestures = HandGestures.create();
  const updateGestures = (hands) => handGestures.update(hands);
  const gestureOf = (hand) => handGestures.of(hand);

  function curlRow(name, val) {
    const pct = val === null ? 0 : Math.round(val * 100);
    return `
      <div class="curl-row">
        <span class="curl-label">${name}</span>
        <div class="curl-bar"><div class="curl-fill" style="width:${pct}%"></div></div>
        <span class="curl-pct">${val === null ? "—" : `${pct}%`}</span>
      </div>`;
  }
  const FINGERS = ["thumb", "index", "middle", "ring", "pinky"];

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

  // A hand that isn't in view keeps its card, the same size with every row in place (its
  // values blank), so the cards don't jump about as hands come and go.
  function renderMissingCard(side) {
    const hint = HandTracker.getMaxHands() === 1 ? "Tracking 1 hand: switch Track to 2 hands for both" : "Not in view";
    return `
      <div class="hand-card ${side.toLowerCase()} missing">
        <div class="hand-header">
          <span class="hand-name">${side} Hand</span>
          <span class="gesture-badge" style="color:#adb5bd; border-color:#adb5bd55">${hint}</span>
          <span class="compass">➤</span>
        </div>

        <div class="section-label">Palm Orientation</div>
        <div class="orientation-row">
          <span><b>Yaw</b>—</span>
          <span><b>Pitch</b>—</span>
          <span><b>Roll</b>—</span>
        </div>

        <div class="section-label">Gesture Metrics</div>
        <div class="metric-row">
          Thumb–Index dist: — &nbsp;•&nbsp;
          Wrist speed: —
        </div>

        <div class="section-label">Finger Curl</div>
        ${FINGERS.map((n) => curlRow(n, null)).join("")}
      </div>`;
  }

  // Two-hand relationship metrics: always shown (blank until both hands are in view), so
  // the panel doesn't appear and disappear.
  function renderBothHands(left, right) {
    bothHandsEl.hidden = false;
    if (!left || !right) {
      bothHandsEl.innerHTML = `
      <div class="section-label">Both Hands</div>
      <div class="metric-row">
        Wrist-to-wrist distance: —<br />
        Gestures: <span style="color:${SIDE_COLORS.Left}">${left ? gestureOf(left).label : "—"}</span> + <span style="color:${SIDE_COLORS.Right}">${right ? gestureOf(right).label : "—"}</span>
      </div>`;
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

  // Tags, boxes and the search area over the picture (stage-overlay.js, shared with each
  // camera of "Several cameras").
  const stageOverlay = StageOverlay.create(stage, { phone: onPhone });
  function drawStageLabels(hands) {
    if (!overlayOn) return;
    stageOverlay.draw(hands, { display, far: farPrefs.enabled, gestureOf, objects: OakSource.objects() });
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
    // (OAK cameras can be several cameras too: the picker lists them.)
    if ((cams.length >= 2 || OakSource.available()) && window.MultiCamera) {
      const opt = document.createElement("option");
      opt.value = "__multi";
      opt.textContent = "Several cameras at once…";
      cameraSelect.appendChild(opt);
    }
    if (OakSource.available()) {
      const opt = document.createElement("option");
      opt.value = "__oak";
      opt.textContent = "Luxonis OAK camera";
      cameraSelect.appendChild(opt);
      if (OakSource.isActive()) cameraSelect.value = "__oak";
    }
    const current2 = HandTracker.getCamera();
    if (current2.stream) {
      // A capture rig watched live (rig-live.js).
      const opt = document.createElement("option");
      opt.value = "__stream_active";
      opt.textContent = `Live: ${current2.name}`;
      cameraSelect.appendChild(opt);
      cameraSelect.value = opt.value;
    }
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
    await switchCamera({ desktopSourceId: src.id, desktopName: src.name, stream: null, streamName: "", crop: crop || null });
    populateCameras();
  }
  captureUseArea.addEventListener("click", () => useCaptureSource(capture.source, capture.rect));

  // A picture stream from the page as the source: a capture rig watched live (rig-live.js).
  async function useStreamSource({ stream, name }) {
    OakSource.stop();
    await switchCamera({ stream, streamName: name, desktopSourceId: null, desktopName: "", crop: null });
    populateCameras();
  }
  // Back from it to the camera picked in the list.
  async function leaveStreamSource() {
    if (HandTracker.getCamera().stream) {
      showSourceNote("");
      await switchCamera({ deviceId: prefs.cameraId || null, stream: null, streamName: "", desktopSourceId: null, desktopName: "", crop: null });
    } else {
      HandTracker.forgetStream();
    }
    populateCameras();
  }
  $("captureUseAll").addEventListener("click", () => useCaptureSource(capture.source, null));
  $("captureBack").addEventListener("click", () => {
    stopCapturePreview();
    openCapturePicker();
  });
  $("captureClose").addEventListener("click", closeCapturePicker);
  captureDialog.addEventListener("click", (e) => {
    if (e.target === captureDialog) closeCapturePicker();
  });

  // ---------- A Luxonis OAK camera as the source (Windows, Mac and Linux app) ----------
  // OAK cameras' own options (More settings → OAK camera): find objects, the depth picture,
  // the frame rate. Remembered; a camera running is started again with them. Sentry mode also
  // has them send a small grey picture, and find objects for "ignore pets and animals".
  const oakPrefs = { detect: false, picture: "color", fps: 0, ...(prefs.oakOptions && typeof prefs.oakOptions === "object" ? prefs.oakOptions : {}) };
  const oakOptions = () => ({
    ...oakPrefs,
    detect: oakPrefs.detect || !!(window.Sentry && Sentry.wantsObjects()),
    motion: !!(window.Sentry && Sentry.wantsMotion()),
  });
  const oakSettings = () => ({ model: Number(modelSelect.value), hands: Number(handsSelect.value), far: { ...farPrefs }, oak: oakOptions() });
  function applyOakOptions() {
    $("oakOptions").hidden = !OakSource.available();
    setToggle($("oakDetect"), oakPrefs.detect, "Find objects");
    $("oakPicture").value = oakPrefs.picture;
    $("oakFps").value = oakPrefs.fps ? String(oakPrefs.fps) : "";
  }
  function saveOakOptions() {
    setPref("oakOptions", oakPrefs);
    applyOakOptions();
    restartOak();
    syncTiles();
  }
  $("oakDetect").addEventListener("click", () => {
    oakPrefs.detect = !oakPrefs.detect;
    saveOakOptions();
  });
  $("oakPicture").addEventListener("change", () => {
    oakPrefs.picture = $("oakPicture").value === "depth" ? "depth" : "color";
    saveOakOptions();
  });
  $("oakFps").addEventListener("change", () => {
    oakPrefs.fps = Number($("oakFps").value) || 0;
    saveOakOptions();
  });
  async function useOak() {
    stageMessage.hidden = false;
    stageMessage.className = "";
    stageMessage.textContent = "Starting the OAK camera…";
    try {
      await OakSource.start(oakSettings());
    } catch (err) {
      if (err.canceled) {
        stageMessage.hidden = true;
        populateCameras();
        return;
      }
      showStageError(err);
    }
  }
  // Model, hands and far-away settings are the camera's own: restart it with the new ones.
  const restartOak = () => OakSource.isActive() && useOak();
  OakSource.onStatus((s) => {
    if (s.status === "running") {
      stageMessage.hidden = true;
      const also = [s.detect ? "objects found on the camera too (Show → Objects)" : "", s.picture === "depth" ? "showing the depth picture" : ""].filter(Boolean);
      showSourceNote(`${s.camera || "OAK camera"}: hands found on the camera${s.depth ? ", with each hand's distance (Show → Distance)" : ""}${also.length ? `; ${also.join("; ")}` : ""}.` +
        (s.usb === "HIGH" ? " It's connected over USB 2, so pictures come a little slower: if it's a USB 3 camera, another cable or port may help." : "") +
        (s.warning ? ` ${s.warning}` : ""));
    } else if (s.status === "error") {
      showStageError(new Error(s.message));
    } else if (s.status === "stopped" && OakSource.isActive() && s.code) {
      showStageError(new Error(`The OAK camera stopped${s.detail ? `: ${s.detail}` : "."}`));
    }
  });

  cameraSelect.addEventListener("change", () => {
    if (cameraSelect.value === "__screen") {
      populateCameras(); // back to the current choice until a window is picked
      openCapturePicker();
      return;
    }
    if (cameraSelect.value === "__screen_active" || cameraSelect.value === "__stream_active") return;
    if (cameraSelect.value === "__multi") {
      populateCameras(); // back to the current camera; the tiles are a card of their own
      MultiCamera.openPicker();
      return;
    }
    if (cameraSelect.value === "__oak") {
      useOak();
      return;
    }
    OakSource.stop();
    showSourceNote("");
    setPref("cameraId", cameraSelect.value || null);
    switchCamera({ deviceId: cameraSelect.value || null, desktopSourceId: null, desktopName: "", stream: null, streamName: "", crop: null }).then(populateCameras);
  });
  resolutionSelect.addEventListener("change", () => {
    setPref("resolution", resolutionSelect.value);
    switchCamera(parseResolution(resolutionSelect.value));
  });
  handsSelect.addEventListener("change", () => {
    const n = Number(handsSelect.value);
    setPref("hands", n);
    HandTracker.setMaxHands(n);
    restartOak();
  });
  modelSelect.addEventListener("change", () => {
    const m = Number(modelSelect.value);
    setPref("model", m);
    HandTracker.setModelComplexity(m);
    restartOak();
  });

  function toggleOverlay() {
    overlayOn = !overlayOn;
    setPref("overlay", overlayOn);
    HandTracker.setOverlay(overlayOn && display.skeleton);
    setToggle(overlayToggle, overlayOn, "Overlay");
    syncTiles();
  }

  // Several cameras: every camera's tile follows the Overlay button and More settings too.
  const tileSettings = () => ({ display: { ...display }, overlay: overlayOn, square: squareOn, far: { ...farPrefs }, gloves: glovesOn, readable: readableOn, oak: oakOptions() });
  function syncTiles() {
    if (window.MultiCamera && MultiCamera.setOptions) MultiCamera.setOptions(tileSettings());
  }
  overlayToggle.addEventListener("click", toggleOverlay);

  // ---------- What's shown, pause, square crop, far-away hands ----------
  function applyDisplay() {
    for (const btn of showBar.querySelectorAll("button[data-show]")) {
      const on = !!display[btn.dataset.show];
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", String(on));
    }
    HandTracker.setOverlay(overlayOn && display.skeleton);
    fpsBadge.hidden = !display.fps;
    syncTiles();
  }
  function toggleShow(key) {
    display[key] = !display[key];
    setPref("display", display);
    applyDisplay();
  }
  showBar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-show]");
    if (btn) toggleShow(btn.dataset.show);
  });

  function showPaused(paused) {
    pauseBadge.hidden = !paused;
    pauseToggle.classList.toggle("active", paused);
    pauseToggle.firstChild.textContent = paused ? "▶ Resume" : "❚❚ Pause";
  }
  function applyPaused(paused) {
    HandTracker.setPaused(paused);
    showPaused(paused);
  }
  function togglePause() {
    if (HandTracker.getSource() === "file") {
      // A video file: the same as its own play/pause button.
      vidPlay.click();
      return;
    }
    // Several cameras: every tile pauses (the main camera stays paused under them).
    if (window.MultiCamera && MultiCamera.isActive()) {
      const paused = !MultiCamera.options().paused;
      MultiCamera.setOptions({ paused });
      showPaused(paused);
      return;
    }
    applyPaused(!HandTracker.isPaused());
  }
  pauseToggle.addEventListener("click", togglePause);

  function applySquare() {
    HandTracker.setSquareCrop(squareOn);
    setToggle(squareToggle, squareOn, "Square crop");
    syncTiles();
  }
  squareToggle.addEventListener("click", () => {
    squareOn = !squareOn;
    setPref("squareCrop", squareOn);
    applySquare();
  });

  // Hands in black gloves: MediaPipe is shown them light and skin-coloured (hand-tracker.js).
  function applyGloves() {
    HandTracker.setGloves(glovesOn);
    setToggle(glovesToggle, glovesOn, "Black gloves");
    syncTiles();
  }
  glovesToggle.addEventListener("click", () => {
    glovesOn = !glovesOn;
    setPref("blackGloves", glovesOn);
    applyGloves();
  });

  function applyFar() {
    HandTracker.setFarMode({ ...farPrefs });
    setToggle(farToggle, farPrefs.enabled, "Far-away hands");
    $("farFocusLabel").hidden = !farPrefs.enabled;
    $("farRaisedLabel").hidden = !farPrefs.enabled;
    farFocus.value = farPrefs.focus;
    farRaised.checked = farPrefs.raisedOnly;
    syncTiles();
  }
  function saveFar() {
    setPref("far", farPrefs);
    applyFar();
    restartOak();
  }
  farToggle.addEventListener("click", () => {
    farPrefs.enabled = !farPrefs.enabled;
    saveFar();
  });
  farFocus.addEventListener("change", () => {
    farPrefs.focus = farFocus.value;
    saveFar();
  });
  farRaised.addEventListener("change", () => {
    farPrefs.raisedOnly = farRaised.checked;
    saveFar();
  });

  readableToggle.addEventListener("click", () => {
    readableOn = !readableOn;
    setPref("readableText", readableOn);
    setToggle(readableToggle, readableOn, "Readable text");
    syncTiles();
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
    setMirror(typeof chosen === "boolean" ? chosen : !camera.screen && !camera.stream && camera.facing !== "environment");
  }
  HandTracker.onSourceChange(applyMirrorDefault);

  // ---------- Rotation: each camera and video keeps its own ----------
  const rotations = prefs.rotations && typeof prefs.rotations === "object" ? prefs.rotations : {};
  const ROTATIONS_KEPT = 200;
  function rotationKey(camera) {
    if (camera.source === "file") return `file:${HandTracker.file.name()}`;
    return camera.deviceId || "default";
  }
  function applyRotation(camera) {
    const r = rotations[rotationKey(camera)] || 0;
    rotateSelect.value = String(r);
    HandTracker.setRotation(r); // no-op when unchanged (it announces a source change otherwise)
  }
  HandTracker.onSourceChange(applyRotation);
  function setRotation(r) {
    const key = rotationKey(HandTracker.getCamera());
    if (r) rotations[key] = r;
    else delete rotations[key];
    const keys = Object.keys(rotations);
    if (keys.length > ROTATIONS_KEPT) delete rotations[keys[0]];
    setPref("rotations", rotations);
    rotateSelect.value = String(r);
    HandTracker.setRotation(r);
  }
  rotateSelect.addEventListener("change", () => setRotation(Number(rotateSelect.value)));

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
        : /Macintosh/.test(navigator.userAgent)
          ? "Camera access was blocked. Open System Settings › Privacy & Security › Camera, turn on Hand Tracker, then open Hand Tracker again."
          : "Camera access was blocked. In Windows, open Settings › Privacy › Camera and turn on camera access for desktop apps, then press Retry.",
      NotFoundError: OakSource.available()
        ? "No webcam was found. For a Luxonis OAK camera, pick it in the camera list (or Several cameras at once…); for a webcam, plug it in and press Retry."
        : "No camera was found. Plug in a webcam and press Retry.",
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

  // ---------- OptiTrack Motive's live data (NatNet; the Windows, Linux and Android apps) ----------
  const natnetApi = (desktop && desktop.natnet) || (mobile && mobile.natnet);
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

  // Motive's markers seen from the front (x across, z up), scaled to fit. Sizes are in
  // 640-wide units (k), so the view looks the same in the panel and stays sharp in recordings.
  function drawMotive(f) {
    const ctx = motiveView.getContext("2d");
    const W = motiveView.width, H = motiveView.height, k = W / 640;
    ctx.fillStyle = "#0e0f12";
    ctx.fillRect(0, 0, W, H);
    ctx.font = `${12 * k}px Segoe UI, system-ui, sans-serif`;
    ctx.fillStyle = "#868e96";
    ctx.fillText(`OptiTrack Motive · front view${motiveRate ? ` · ${motiveRate} Hz` : ""}`, 8 * k, 18 * k);
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
    ctx.lineWidth = k;
    ctx.beginPath();
    ctx.moveTo(0, floor);
    ctx.lineTo(W, floor);
    ctx.stroke();
    for (const m of f.markers) {
      const [x, y] = at(m.p);
      ctx.fillStyle = m.model ? "#74c0fc" : "#868e96";
      ctx.beginPath();
      ctx.arc(x, y, 3 * k, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#63e6be";
    for (const s of f.skeletons) for (const b of s.bones) {
      const [x, y] = at(b.p);
      ctx.fillRect(x - 2 * k, y - 2 * k, 4 * k, 4 * k);
    }
    for (const r of f.rigidBodies) {
      const [x, y] = at(r.p);
      ctx.fillStyle = r.valid ? "#ff922b" : "#5c3a1a";
      ctx.fillRect(x - 5 * k, y - 5 * k, 10 * k, 10 * k);
      ctx.fillText(r.name, x + 8 * k, y - 6 * k);
    }
  }

  // Motive's view is drawn at the size it's shown (sharp on any screen, never stretched).
  // While a recording that includes it runs, its size stays put.
  function fitMotiveView() {
    if (motiveView.hidden || VideoRecorder.isRecording()) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(Math.min(2560, motiveView.clientWidth * dpr)), h = Math.round(motiveView.clientHeight * dpr);
    if (w > 0 && h > 0 && (motiveView.width !== w || motiveView.height !== h)) {
      motiveView.width = w;
      motiveView.height = h;
    }
  }
  if (window.ResizeObserver) new ResizeObserver(fitMotiveView).observe(motiveView);

  function drawMotiveMessage(text) {
    const ctx = motiveView.getContext("2d");
    const k = motiveView.width / 640;
    ctx.fillStyle = "#0e0f12";
    ctx.fillRect(0, 0, motiveView.width, motiveView.height);
    ctx.fillStyle = "#868e96";
    ctx.font = `${14 * k}px Segoe UI, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(text, motiveView.width / 2, motiveView.height / 2);
    ctx.textAlign = "start";
  }

  if (natnetApi) {
    motiveCard.hidden = false;
    // On a phone Motive is always on another computer, on the same Wi-Fi.
    if (mobile) motiveServer.placeholder = "Motive PC's address, e.g. 192.168.1.20";
    motiveServer.value = prefs.motiveServer || (mobile ? "" : "127.0.0.1");
    motiveMulticast.checked = prefs.motiveMulticast !== false;
    motiveConnect.addEventListener("click", () => {
      if (motiveState === "stopped") {
        if (mobile && !motiveServer.value.trim()) {
          motiveStatus.textContent = "Enter the address of the PC running Motive (on the same Wi-Fi as this phone).";
          return;
        }
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
      fitMotiveView();
      if (s.state !== "connected") {
        motiveInfo.textContent = "";
        drawMotiveMessage(s.state === "waiting" ? "Waiting for Motive…" : "Motive isn't connected");
      }
      updateLayoutChoices();
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

  // Set while trackWholeVideo waits for a Capture Whole Video run: gets the motion data
  // instead of the export panel.
  let captureWaiter = null;

  // Before a new motion capture: an unexported one is only dropped if you say so.
  function readyForNewMotion() {
    if (motion && !motion.exported && !confirm("Discard the previous motion capture? It hasn't been exported yet.")) return false;
    discardMotion();
    return true;
  }

  function toggleMotion() {
    if (!RobotMotion.isRecording()) {
      if (!readyForNewMotion()) return;
      RobotMotion.start();
      motiveRecording = !!natnetApi && motiveState === "connected";
      if (motiveRecording) natnetApi.recordStart();
      motionBtn.firstChild.textContent = "Stop Motion Capture";
      motionBtn.classList.add("recording");
      setCaptureControlsLocked(false);
      updateMotionStatus();
      return;
    }
    if (captureWaiter) {
      const done = captureWaiter;
      captureWaiter = null;
      done(stopMotionData());
      return;
    }
    return stopMotionNow();
  }
  motionBtn.addEventListener("click", toggleMotion);

  // The capture stopped, as its data.
  function stopMotionData() {
    const data = RobotMotion.stop();
    data.display_mirrored = mirrorOn; // lets the viewer draw paths the way they looked on screen
    data.image_size = [stage.width, stage.height]; // landmark x/y are normalized separately; exporters need the aspect
    if (HandTracker.isFileMirrored()) {
      data.notes.push("Tracked from a video recorded mirrored, flipped back before tracking, so Left/Right and positions are as a normal camera would have seen them.");
    }
    motionBtn.firstChild.textContent = "Start Motion Capture";
    motionBtn.classList.remove("recording");
    setCaptureControlsLocked(false);
    return data;
  }

  // Stop Motion Capture: the export card (with Motive's markers, if it recorded too). extra is
  // added to the capture (remote recording's take details). -> the capture (null if no hand
  // was seen and Motive had nothing).
  async function stopMotionNow(extra = null) {
    if (!RobotMotion.isRecording()) return null;
    const data = stopMotionData();
    if (extra) Object.assign(data, extra);
    const frames = motiveRecording ? await natnetApi.recordStop() : null;
    motiveRecording = false;
    const motive = frames && frames.length > 1 ? motiveMarkerData(frames, "Motive") : null;
    if (!data.hands.length && !motive) {
      motionStatus.textContent = "No frames captured (no hand was visible).";
      return null;
    }
    motionStatus.textContent = "";
    showMotionExport(data, motive);
    return data;
  }

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
    motionName.readOnly = false;
    motionName.title = "";
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

  // The capture's files in the export card's formats, named as it says (throws if none fit).
  function motionFiles() {
    const formats = checkedIds(motionFormatGrid);
    if (!formats.length) throw new Error("pick at least one format");
    const baseName = motionName.value.trim() || `robot-motion-${timestampName()}`;
    let files = [];
    if (motion.data.hands.length) files = MotionExport.build(motion.data, formats, baseName);
    if (motion.motive) {
      const markerIds = formats.filter((id) => MotionExport.MARKER_FORMATS.some((f) => f.id === id));
      const motiveFiles = MotionExport.buildMarkers(motion.motive, markerIds, `${baseName}-motive`);
      files.push(...motiveFiles.map((f) => ({ ...f, suffix: `-motive${f.suffix}` })));
    }
    if (!files.length) throw new Error("none of the chosen formats can hold this data (pick C3D, TRC, CSV, GLB, NPZ or JSON)");
    return { baseName, files };
  }

  async function exportMotion() {
    if (!motion) return;
    if (!checkedIds(motionFormatGrid).length) {
      motionNote.textContent = "Pick at least one format.";
      return;
    }
    let baseName, files;
    try {
      ({ baseName, files } = motionFiles());
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

  // A capture saved without asking where (remote recording: nobody may be at this screen):
  // the export card's formats, into the remote recording folder, named baseName if given (the
  // card shows it too). -> { ok, dir, files, message }
  async function saveMotionNow(baseName) {
    if (!motion || motion.exported) return null;
    if (baseName) motionName.value = baseName;
    try {
      const { baseName, files } = motionFiles();
      const res = await (desktop || mobile).remote.saveTake({ baseName, files });
      renderResults(motionResults, res.results);
      const saved = res.results.filter((r) => r.ok);
      if (saved.length) {
        motion.exported = true;
        // Its name (and the details in it) are final: other formats exported here keep it.
        motionName.readOnly = true;
        motionName.title = "A remote recording take keeps the name it was saved with.";
      }
      motionNote.textContent = saved.length ? `Saved ${saved.length} file${saved.length === 1 ? "" : "s"} to ${res.dir}` : "Nothing was saved.";
      const failed = res.results.find((r) => !r.ok);
      return { ok: saved.length > 0, dir: res.dir, files: saved.map((r) => r.path.split(/[\\/]/).pop()), message: failed ? failed.error : "" };
    } catch (err) {
      const message = (err && err.message) || String(err);
      motionNote.textContent = `Couldn't save: ${message}`;
      return { ok: false, message };
    }
  }

  // ---------- Video recording ----------
  let clip = null; // { blob, url, container, duration, width, height, fps, exported }
  let recordTimer = null;
  let exporting = false;

  // Layouts stack their views top to bottom: camera, then the 3D view, then Motive's view.
  function recordingSources() {
    const parts = layoutSelect.value.split("+");
    const sources = [stage];
    if (parts.includes("3d")) sources.push(Hand3D.getCanvas());
    if (parts.includes("motive") && motiveState === "connected") sources.push(motiveView);
    return sources;
  }

  // The Motive layouts are offered only while Motive is connected. Without it, a saved Motive
  // layout shows as the same layout without Motive, and comes back when Motive reconnects.
  function updateLayoutChoices() {
    const connected = motiveState === "connected";
    for (const o of layoutSelect.options) {
      if (!o.value.includes("motive")) continue;
      o.hidden = !connected;
      o.disabled = !connected;
    }
    if (VideoRecorder.isRecording()) return; // the recording keeps the views it started with
    const wanted = prefs.layout || "camera";
    const usable = connected ? wanted : wanted.replace("+motive", "");
    if ([...layoutSelect.options].some((o) => o.value === usable)) layoutSelect.value = usable;
  }
  updateLayoutChoices();

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
            saves.push(Promise.resolve({ format: r.format, ok: true, path: fileName, size: r.data.size === undefined ? r.data.length : r.data.size }));
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

  // Whether to flip a video back before tracking (see the Mirrored video button): as last
  // chosen for it, or else flipped if it's a phone's selfie video (video-origin.js).
  async function mirroredDefault(name, url, sourceFile) {
    if (typeof mirroredVideos[name] === "boolean") return { mirrored: mirroredVideos[name], note: "" };
    const file = sourceFile || (await fetch(url).then((r) => r.blob()).catch(() => null));
    return file ? VideoOrigin.mirroredByDefault(await VideoOrigin.read(file)) : { mirrored: false, note: "" };
  }

  // Converts a video the page can't play into an MP4 it can (ffmpeg.wasm), then tracks that.
  let convertedUrl = null;
  async function openConverted(name, file, options) {
    const blob = await VideoConvert.toPlayable(file, ({ progress, loading }) => {
      stageMessage.textContent = loading
        ? "Loading the video converter (about 32 MB, only the first time)…"
        : `Converting ${name} to a playable format… ${Math.round(progress * 100)}%`;
    });
    if (convertedUrl) URL.revokeObjectURL(convertedUrl);
    convertedUrl = URL.createObjectURL(blob);
    await HandTracker.useVideoFile(convertedUrl, options);
  }

  // Opens a video to track. url: something the page can play (object URL);
  // filePath: the file on disk (Windows app), used to convert formats the page can't play;
  // sourceFile: the File itself, converted in the page when it can't be played (browser, Android);
  // mirrored: whether it was recorded mirrored, when that's known (else it's worked out from
  // the file, which for a video streamed from elsewhere means downloading all of it).
  async function openVideo(name, url, filePath, sourceFile, { mirrored } = {}) {
    if (VideoRecorder.isRecording() || RobotMotion.isRecording()) {
      showSourceNote("Stop recording before opening a video.");
      return false;
    }
    showSourceNote("");
    stageMessage.hidden = false;
    stageMessage.className = "";
    stageMessage.textContent = `Opening ${name}…`;
    const flip = typeof mirrored === "boolean" ? { mirrored, note: "" } : await mirroredDefault(name, url, sourceFile);
    const options = { name, mirrored: flip.mirrored };
    try {
      try {
        await HandTracker.useVideoFile(url, options);
      } catch (err) {
        // Formats the page can't play (AVI, MPEG, WMV, FLV…) are converted: by the Windows
        // app's ffmpeg, or by ffmpeg.wasm in a browser or on Android.
        if (!desktop && canConvertHere() && sourceFile) {
          await openConverted(name, sourceFile, options);
          stageMessage.hidden = true;
          enterVideoMode(name, flip.note);
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
          await HandTracker.useVideoFile(converted.url, options);
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
    enterVideoMode(name, flip.note);
    return true;
  }

  // note: why the video was flipped back without being asked, if it was.
  function enterVideoMode(name, note) {
    showSourceNote(note);
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
    const files = [...videoFileInput.files];
    videoFileInput.value = "";
    // Several videos of the same moment: tracked in turn and synced (multi-video.js).
    if (files.length > 1) return MultiVideo.open(files);
    const f = files[0];
    if (!f || MultiVideo.isRunning()) return; // (it's tracking its videos one by one)
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
  // looked) shows every hand as the other one: flip it back before tracking. On or off,
  // the choice is remembered for that video, over the phone default (see mirroredDefault).
  vidMirrored.addEventListener("click", async () => {
    const name = HandTracker.file.name();
    const on = !HandTracker.isFileMirrored();
    delete mirroredVideos[name]; // re-added last, so the oldest names are the ones dropped
    mirroredVideos[name] = on;
    showSourceNote(""); // any note about the default no longer applies
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
  // Tracks every frame of a video (by address) and resolves with its motion capture, the
  // same way as Capture Whole Video; for batch tracking of capture sessions (ops-sessions.js)
  // and of several videos (multi-video.js). filePath / file: as for openVideo, so formats the
  // page can't play are converted first. onProgress(seconds done, seconds total); stop() ends
  // it early (resolving with what's done).
  async function trackWholeVideo(name, url, { onProgress, rate = 2, filePath, file, mirrored } = {}) {
    if (!(await openVideo(name, url, filePath, file, { mirrored }))) throw new Error(sourceNote.textContent || `Couldn't open ${name}`);
    HandTracker.file.setRate(rate); // every frame is still tracked; this only shortens the waits
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => onProgress && onProgress(HandTracker.file.time(), HandTracker.file.duration()), 500);
      captureWaiter = (data) => {
        clearInterval(timer);
        resolve(data);
      };
      HandTracker.file.pause();
      HandTracker.file.seek(0);
      toggleMotion();
      if (!RobotMotion.isRecording()) {
        // Asked whether to discard a motion capture that hasn't been exported, the user kept it.
        clearInterval(timer);
        captureWaiter = null;
        reject(new Error("The last motion capture hasn't been exported yet: export or discard it, then try again."));
        return;
      }
      HandTracker.file.play();
    });
  }
  function stopTracking() {
    if (RobotMotion.isRecording()) {
      HandTracker.file.pause();
      toggleMotion();
    }
  }

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
    const SHOW_KEYS = { 1: "box", 2: "skeleton", 3: "side", 4: "scores", 5: "gesture", 6: "distance", 7: "focus", 8: "objects", f: "fps" };
    if (key === "r") toggleVideo();
    else if (key === "m") toggleMotion();
    else if (key === "o") toggleOverlay();
    else if (key === " " && e.target.tagName !== "BUTTON") togglePause();
    else if (key === "t") setRotation((HandTracker.getRotation() + 90) % 360);
    else if (SHOW_KEYS[key]) toggleShow(SHOW_KEYS[key]);
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
    setToggle(squareToggle, squareOn, "Square crop");
    applyGloves(); // (before the camera starts, so a video opened after a camera error has it too)
    applyOakOptions();
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
    // Hand mouse, floating keyboard and gesture actions: this computer (Windows, Mac and Linux app),
    // or from the Android app, a PC it's paired with over Wi-Fi.
    // The website's hand mouse: this page's pointer, or this computer's through the app (web-pc.js).
    const webPc = !desktop && !mobile ? { pc: WebPc.create({ prefs, setPref }) } : null;
    // (The iPhone app's hand browser is a touchscreen: a drag there is a finger's swipe.)
    PcControl.init({ desktop: desktop || (mobile && mobile.pc ? mobile : null) || webPc, prefs, setPref, gestureLabels: GESTURE_LABELS, touch: !!(mobile && mobile.pc && mobile.pc.platform === "ios") });
    if (desktop) WebPc.initDesktop({ desktop, prefs, setPref });
    // A phone controlling a PC over Wi-Fi: pairing it (the phone's side, and the PC's).
    PhoneLinkUI.init({ desktop, mobile, prefs, setPref });
    // Several videos at once: tracked in turn, synced from the hand movement, or queued.
    MultiVideo.init({ desktop, prefs, setPref });
    // Several live cameras at once, each with its own tracker.
    MultiCamera.init({
      prefs, setPref, app: window.HandTrackerApp, modelOf: () => Number(modelSelect.value), phone: onPhone,
      onClose: () => showPaused(HandTracker.isPaused()), // (Pause was the tiles' while they ran)
    });
    syncTiles();
    // A phone's browser starting and stopping recording with those cameras (Windows, Mac and Linux app).
    RemoteRecordUI.init({ desktop, mobile, prefs, setPref, app: window.HandTrackerApp });
    // Sentry mode, set up and seen from remote recording's page (hidden there): it watches
    // remote recording's cameras, Several cameras. Only where remote recording is (the apps).
    if (desktop || mobile) Sentry.init({
      prefs, setPref,
      host: desktop || mobile,
      views: () => (MultiCamera.isActive() ? MultiCamera.sentryViews() : []),
      onWantsChange: () => {
        restartOak();
        syncTiles();
      },
      looking: () => RemoteRecordUI.looking(),
      link: () => RemoteRecordUI.tailnetLink(),
      hostName: () => {
        const link = RemoteRecordUI.tailnetLink();
        return link ? new URL(link).hostname.split(".")[0] : "";
      },
    });
    // Capture sessions from a capture-operations dashboard: hidden until Ctrl+Alt+P (on a
    // phone: tapping the version under the title 7 times). So is watching a capture rig live,
    // from a capture-fleet dashboard. (The phone's bridge has the same ops/fleet/saving calls.)
    const remoteHost = desktop && desktop.ops ? desktop : mobile && mobile.ops ? mobile : null;
    if (remoteHost) {
      OpsSessions.init({ desktop: remoteHost, prefs, setPref });
      RigLive.init({ desktop: remoteHost, prefs, setPref, app: window.HandTrackerApp });
      const toggleHidden = () => {
        OpsSessions.toggleShown();
        RigLive.setShown(prefs.captureSessions === true);
      };
      document.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.altKey && !e.shiftKey && e.key.toLowerCase() === "p") {
          e.preventDefault();
          toggleHidden();
        }
      });
      let taps = [];
      buildInfo.addEventListener("click", () => {
        const now = Date.now();
        taps = [...taps.filter((t) => now - t < 3000), now];
        if (taps.length >= 7) {
          taps = [];
          toggleHidden();
        }
      });
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
    const shape3d = $("shape3d"), spin3d = $("spin3d");
    if (prefs.shape3d) shape3d.value = prefs.shape3d;
    if (prefs.spin3d) spin3d.value = prefs.spin3d;
    const apply3d = () => Hand3D.setOptions({ shape: shape3d.value, spin: spin3d.value });
    apply3d();
    shape3d.addEventListener("change", () => { setPref("shape3d", shape3d.value); apply3d(); });
    spin3d.addEventListener("change", () => { setPref("spin3d", spin3d.value); apply3d(); });

    // Opened at login for remote recording (--remote-standby): no camera until the phone
    // asks for them (or one is picked here).
    const standby = !!(desktop && desktop.remote && (await desktop.remote.settings().catch(() => ({}))).standby);
    // Without a webcam (a computer with only OAK cameras, say) everything else still starts:
    // the camera list offers the OAK camera and Several cameras at once, and the message says so.
    let cameraError = null;
    try {
      await HandTracker.init({
        videoEl: video,
        canvasEl: stage,
        overlay: overlayOn,
        mirror: mirrorOn,
        maxNumHands: Number(handsSelect.value),
        modelComplexity: Number(modelSelect.value),
        deviceId: prefs.cameraId || null,
        noCamera: standby,
        ...parseResolution(resolutionSelect.value),
      });
      stageMessage.hidden = !standby;
      if (standby) {
        stageMessage.className = "";
        stageMessage.textContent = "Waiting for the phone: Remote recording starts the cameras. (Or pick a camera above.)";
      }
    } catch (err) {
      cameraError = err;
    }
    applyDisplay();
    applySquare();
    applyFar();
    applyRotation(HandTracker.getCamera());
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
      const camNow = HandTracker.getCamera();
      PcControl.update(hands, gestureOf, mirrorOn, camNow.width && camNow.height ? camNow.width / camNow.height : 16 / 9);

      if (RobotMotion.isRecording()) {
        RobotMotion.feed(hands, timestamp);
        updateMotionStatus();
      }

      renderPanels(hands);
      const cam = HandTracker.getCamera();
      const videoFps = cam.source === "file" && HandTracker.file.fps() ? ` · video ${HandTracker.file.fps()} fps` : "";
      fpsBadge.textContent = `FPS: ${HandTracker.getFPS()} · ${cam.width}×${cam.height}${videoFps}`;
    });
    if (cameraError) throw cameraError; // shown with a Retry button (main().catch)
  }

  // Entry points for the automated checks (same code paths as the buttons).
  window.HandTrackerApp = {
    openVideo, backToCamera, openCapturePicker, useCaptureSource, trackWholeVideo, stopTracking,
    useStreamSource, leaveStreamSource, setSourceNote: (text) => showSourceNote(text),
    showMotionExport: (data) => showMotionExport(data),
    readyForNewMotion: () => readyForNewMotion(),
    hasUnsavedMotion: () => !!(motion && !motion.exported),
    saveMotionNow: (baseName) => saveMotionNow(baseName),
    useOak: () => useOak(),
  };

  main().catch((err) => {
    console.error(err);
    showStageError(err);
  });
})();
