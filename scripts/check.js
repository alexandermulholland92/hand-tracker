/**
 * check.js — automated end-to-end check of the desktop app.
 *   npm run check
 *
 * Launches the real app with Chromium's fake camera (playing a test pattern, fake-camera.js), then:
 *  1. waits for MediaPipe to load and process camera frames,
 *  2. simulates two hands (Left + Right) moving and gripping,
 *  3. records motion capture and a "Camera + 3D" video,
 *  4. exports motion capture to all 8 formats and video to every format (video-formats.js),
 *  5. verifies every output file with independent readers (BVH replayed with
 *     forward kinematics, GLB played in three.js, C3D read from the spec,
 *     NPZ loaded with NumPy, each video decoded by ffmpeg), and recognises
 *     gestures from simulated hand poses,
 *  6. opens video files in 14 formats as the tracking source (native and converted),
 *     re-times a recording made from a video file, and captures a whole video; checks
 *     Mirror is on for selfie cameras and off for rear cameras and video files, and that
 *     Mirrored video flips a mirrored recording back before tracking (by default for
 *     Android front-camera videos, recognised from their metadata); opens several videos
 *     at once: two cameras of one moment are synced from the hand movement (motion capture
 *     on one clock, videos trimmed to start together), a video of something else gets the
 *     error and goes through the motion capture queue and the Recording Viewer's queue,
 *  7. opens the Recording Viewer with JSON, CSV (incl. spreadsheet-saved), C3D, TRC,
 *     Motive CSV and — when OptiTrack Motive is installed — a sample .tak take,
 *  8. opens a WMV with sound in the Recording Viewer and converts it to every format,
 *  9. OptiTrack: receives a stand-in Motive's NatNet stream (scripts/natnet-sim.js) over
 *     multicast and unicast, records it with motion capture and checks the exported
 *     markers; tracks a crop of the screen picked in the "Screen or window" picker.
 * Output goes to a temp folder that is printed at the end.
 */

const { app, dialog, BrowserWindow, shell } = require("electron");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
// The fake camera plays a test pattern from a file: Chromium's own pattern crashes now and then (fake-camera.js).
const fakeCamera = require("./fake-camera.js").fakeCameraFile();
if (fakeCamera) app.commandLine.appendSwitch("use-file-for-fake-video-capture", fakeCamera);

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "hand-tracker-check-"));
// Fresh profile every run, so saved preferences can't change what's tested.
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "hand-tracker-check-profile-")));
// Chromium's fake test camera sometimes crashes its capture process (an access violation
// inside Chromium, now and then at start-up or when the camera is reopened). After that it
// can't be reopened, so the camera checks from then on fail. The run then ends with
// CAMERA_CRASHED (at once if no check has run yet), and scripts/run-checks.js (npm run
// check) runs it again.
const CAMERA_CRASHED = 75;
let cameraCrashedAt = null;
app.on("child-process-gone", (event, details) => {
  // (Chromium also ends that process normally when no camera is open: only a crash counts.)
  if (details.type === "Utility" && /video.?capture/i.test(`${details.serviceName} ${details.name}`) && /crash|abnormal/.test(details.reason) && !cameraCrashedAt) {
    cameraCrashedAt = new Date().toLocaleTimeString();
    console.log(`NOTE  Chromium's fake test camera crashed (its capture process: ${details.reason}, exit code ${details.exitCode}, at ${cameraCrashedAt}); camera checks after this can't pass.`);
    if (!results.length) app.exit(CAMERA_CRASHED);
  }
});
// Answer the app's save / folder dialogs automatically.
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [outDir] });
dialog.showSaveDialog = async (_win, opts) => ({ canceled: false, filePath: path.join(outDir, path.basename(opts.defaultPath)) });

// Luxonis OAK cameras are stood in for by the main process's SimulatedOak: two of them, no
// camera or Python needed (see "Several cameras with Luxonis OAK cameras").
process.env.HAND_TRACKER_OAK_SIMULATE = "1";
// Remote recording's takes go here, not into Documents.
process.env.HAND_TRACKER_REMOTE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hand-tracker-check-remote-"));
require("../electron/main.js");
const exporter = require("../electron/exporter.js");
const validators = require("./motion-validators.js");
const { verifyExports } = require("./video-validators.js");
const { startNatNetSim } = require("./natnet-sim.js");
const fleetSim = require("./fleet-sim.js");
const { PAGE_SIMULATION, gesturePoses, rigSimulation, TAG_HEIGHTS } = require("./simulated-hands.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}


// A page call that hasn't answered in this long means the page is stuck: say so (and what
// Chromium's processes did) instead of waiting forever.
const PAGE_CALL_LIMIT_MS = 4 * 60 * 1000;
const processEvents = [];
app.on("child-process-gone", (_event, d) => processEvents.push(`${new Date().toLocaleTimeString()} ${d.type}${d.name ? ` (${d.name})` : ""} ${d.reason} ${d.exitCode}`));
function withLimit(promise, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`The page didn't answer for ${PAGE_CALL_LIMIT_MS / 60000} minutes (${what}). Chromium's processes: ${processEvents.join("; ") || "none ended"}`)), PAGE_CALL_LIMIT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function run(win) {
  const wc = win.webContents;
  const js = (code) => withLimit(wc.executeJavaScript(code, true), code.replace(/\s+/g, " ").slice(0, 120));
  wc.on("unresponsive", () => console.log(`NOTE  The page stopped responding at ${new Date().toLocaleTimeString()}.`));
  wc.on("render-process-gone", (_event, d) => console.log(`NOTE  The page's process ended (${d.reason}, ${d.exitCode}).`));
  const consoleErrors = [];
  wc.on("console-message", (...args) => {
    const d = args[0] && typeof args[0].message === "string" ? args[0] : { level: args[1], message: args[2] };
    if (d.level === "error" || d.level === 3) consoleErrors.push(d.message);
  });

  await new Promise((r) => wc.once("did-finish-load", r));

  // 1. MediaPipe + camera pipeline
  // Wait for tracking to warm up to a steady rate.
  let fps = 0;
  for (let i = 0; i < 120 && fps < 15; i++) {
    await new Promise((r) => setTimeout(r, 500));
    fps = await js("HandTracker.getFPS()");
  }
  const cam = await js("HandTracker.getCamera()");
  // Chromium's fake test camera occasionally crashes on some machines (its track ends and it
  // disappears from the device list). That's the test device, not the app: say so, and rerun.
  const testCameraCrashed = fps < 15 && (await js(`(async () => {
    const v = document.getElementById("video"), tr = v.srcObject && v.srcObject.getVideoTracks()[0];
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    return (!tr || tr.readyState === "ended") && cams.length === 0;
  })()`));
  check("MediaPipe loads offline and tracks at the camera's frame rate", fps >= 15,
    testCameraCrashed ? "Chromium's fake test camera crashed during this run (track ended, no cameras listed). Rerun the check." : `${fps} fps, ${cam.width}x${cam.height}`);
  check("Camera picker lists the camera", await js("[...document.getElementById('cameraSelect').options].some((o) => o.value)"));
  check("Stage message cleared (no startup error)", await js("document.getElementById('stageMessage').hidden"),
    await js("document.getElementById('stageMessage').hidden ? '' : document.getElementById('stageMessage').textContent"));

  // 2-3. Start recordings, simulate two hands, stop
  await js("document.getElementById('layoutSelect').value = 'camera+3d'; document.getElementById('layoutSelect').dispatchEvent(new Event('change'));");
  await js("document.getElementById('motionBtn').click(); document.getElementById('videoBtn').click();");
  await js(PAGE_SIMULATION);
  check("Both Left and Right hand cards shown", await js("window.__seenBothCards"));
  check("Both-hands panel shown", await js("!document.getElementById('bothHands').hidden"));
  await new Promise((r) => setTimeout(r, 300)); // let the last frame paint
  const shot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, "screenshot.png"), shot.toPNG());

  await js("document.getElementById('videoBtn').click()");
  await js("document.getElementById('motionBtn').click()");
  await sleep(500);

  // Motion capture: export every format, then verify each file with an independent reader.
  check("Motion export panel appears", await js("!document.getElementById('motionExportCard').hidden"));
  await js("document.querySelectorAll('#motionFormatGrid input').forEach((i) => { i.checked = true; }); document.getElementById('motionExportBtn').click();");
  let saved = 0;
  for (let i = 0; i < 80 && saved < 9; i++) {
    await sleep(250);
    saved = await js("document.querySelectorAll('#motionResults li.ok').length");
  }
  const motionFiles = fs.readdirSync(outDir).filter((f) => f.startsWith("robot-motion-"));
  check("All 8 motion formats saved (9 files: one BVH per hand)", saved === 9, motionFiles.map((f) => f.replace(/^robot-motion-[\d_-]+?(?=[-.][a-z])/, "…")).join(" "));
  const mfile = (ending) => {
    const f = motionFiles.find((n) => n.endsWith(ending));
    return f ? path.join(outDir, f) : null;
  };

  const jsonPath = mfile(".json");
  if (jsonPath) {
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const labels = (data.hands || []).map((h) => h.handedness).join("+");
    check("JSON has both hands (format v2) and the image size", data.format_version === 2 && labels === "Left+Right" && Array.isArray(data.image_size), labels);
    check("Every frame has 21 joints", data.hands.every((h) => h.frames.length > 10 && h.frames.every((f) => f.joints.length === 21)));
    check("Every frame has the hand's real shape (21 joints in metres, from MediaPipe's world landmarks)",
      data.hands.every((h) => h.frames.every((f) => Array.isArray(f.world_joints) && f.world_joints.length === 21 && f.world_joints.every((p) => p.length === 3 && p.every(Number.isFinite)))));
    // The simulated hand on the image's right side is the user's left hand, and it closes into a fist.
    const gripping = data.hands.find((h) => h.handedness === "Left");
    check("Gripping hand gets a grasp/manipulate phase", !!gripping && gripping.task_segments.some((s) => s.phase === "grasp" || s.phase === "manipulate"),
      gripping ? gripping.task_segments.map((s) => s.phase).join(",") : "");

    const report = (name, fn) => {
      try {
        const r = fn();
        check(name, r.ok, r.detail);
      } catch (err) {
        check(name, false, err.message);
      }
    };
    report("CSV: one row per hand per frame, values match JSON", () => validators.checkCSV(mfile(".csv"), data));
    report("BVH (left): replayed skeleton matches the recording", () => validators.checkBVH(mfile("-left.bvh"), data, "Left"));
    report("BVH (right): replayed skeleton matches the recording", () => validators.checkBVH(mfile("-right.bvh"), data, "Right"));
    let trc = null;
    report("TRC: OpenSim marker table is well formed", () => validators.checkTRC((trc = validators.parseTRC(mfile(".trc")))));
    report("C3D: header, parameters and data match TRC", () => validators.checkC3D(mfile(".c3d"), trc));
    report("NPZ: loads in NumPy, arrays match JSON", () => validators.checkNPZ(mfile(".npz"), jsonPath, data));
    try {
      const r = await validators.checkMCAP(mfile(".mcap"), data);
      check("MCAP: Foxglove's reader and ROS 2 decoder read every message (each hand's 21 joints a frame, the skeletons, on the take's clock) and the attached recording", r.ok, r.detail);
    } catch (err) {
      check("MCAP: Foxglove's reader and ROS 2 decoder read every message (each hand's 21 joints a frame, the skeletons, on the take's clock) and the attached recording", false, err.message);
    }

    // GLB: parse with three.js's glTF loader, play the animation, compare with TRC.
    const glb = fs.readFileSync(mfile(".glb")).toString("base64");
    const col = trc.labels.indexOf("L_index_tip") * 3;
    const probeFrames = [5, 20, 40].filter((k) => trc.rows[k] && trc.rows[k].values[col] !== null);
    const g = await js(`(async () => {
      if (!THREE.GLTFLoader) await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "node_modules/three/examples/js/loaders/GLTFLoader.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
      const bytes = Uint8Array.from(atob(${JSON.stringify(glb)}), (c) => c.charCodeAt(0));
      const gltf = await new Promise((res, rej) => new THREE.GLTFLoader().parse(bytes.buffer, "", res, rej));
      const clip = gltf.animations[0];
      const mixer = new THREE.AnimationMixer(gltf.scene);
      mixer.clipAction(clip).play();
      const tip = gltf.scene.getObjectByName("L_index_tip");
      const positions = ${JSON.stringify(probeFrames.map((k) => trc.rows[k].t))}.map((t) => {
        mixer.setTime(t);
        gltf.scene.updateMatrixWorld(true);
        return tip.getWorldPosition(new THREE.Vector3()).toArray().map((v) => v * 1000);
      });
      let joints = 0;
      gltf.scene.traverse((o) => { if (/^[LR]_[a-z]+_?[a-z]*$/.test(o.name) && !o.name.includes("-")) joints++; });
      return { tracks: clip.tracks.length, duration: clip.duration, joints, positions };
    })()`);
    const worst = Math.max(0, ...g.positions.map((p, i) => Math.max(...p.map((v, d) => Math.abs(v - trc.rows[probeFrames[i]].values[col + d])))));
    check("GLB: loads in three.js, animation matches TRC", g.tracks === 2 * (1 + 21 + 21 * 3) && g.joints === 42 && probeFrames.length > 0 && worst < 0.5,
      `${g.joints} joints, ${g.tracks} animation tracks, ${g.duration.toFixed(2)} s; max difference from TRC ${worst.toFixed(3)} mm`);
  }

  // 4. Export every format
  check("Export panel appears after recording", await js("!document.getElementById('exportCard').hidden"));
  const videoBase = await js("document.getElementById('exportName').value");
  await js(`document.querySelectorAll('#formatGrid input').forEach((i) => { i.checked = !i.disabled; }); document.getElementById('exportBtn').click();`);
  let rows = 0;
  for (let i = 0; i < 900 && rows < exporter.FORMATS.length; i++) {
    await new Promise((r) => setTimeout(r, 500));
    rows = await js("document.querySelectorAll('#exportResults li').length");
  }
  const okRows = await js("document.querySelectorAll('#exportResults li.ok').length");
  check(`All ${exporter.FORMATS.length} video formats exported`, okRows === exporter.FORMATS.length,
    await js("document.getElementById('exportNote').textContent + ' ' + [...document.querySelectorAll('#exportResults li.fail')].map((l) => l.textContent).join(' | ')"));

  // 5. Each video decodes as the format it claims to be
  const exported = verifyExports(outDir, videoBase, exporter.FORMATS.map((f) => f.id), false);
  check("Every exported video decodes as the right format", exported.ok, exported.summary);

  // Gestures from simulated hand poses, through the real tracking pipeline.
  const curls = (thumb, index, middle, ring, pinky) => ({ thumb, index, middle, ring, pinky });
  const bird = curls(0.5, 1, 0, 1, 1);
  const g = await js(gesturePoses({
    bird: { curls: bird },
    birdSideways: { curls: bird, rotate: 90 },
    birdPointingDown: { curls: bird, flipY: true },
    birdSideOn: { curls: bird, squeezeX: 0.15 },
    peace: { curls: curls(0.5, 0, 0, 1, 1) },
    fist: { curls: curls(1, 1, 1, 1, 1) },
    point: { curls: curls(0.5, 0, 1, 1, 1) },
    rockOn: { curls: curls(0.5, 0, 1, 1, 0) },
    callMe: { curls: curls(0, 1, 1, 1, 0) },
    thumbsUp: { curls: curls(0, 1, 1, 1, 1), rotate: 45 },
    thumbsDown: { curls: curls(0, 1, 1, 1, 1), rotate: -135 },
    thumbSideways: { curls: curls(0, 1, 1, 1, 1) },
    two: { curls: curls(0, 0, 1, 1, 1) },
    three: { curls: curls(0, 0, 0, 1, 1) },
    four: { curls: curls(0, 0, 0, 0, 0), thumbAcross: true },
    fourSideways: { curls: curls(0, 0, 0, 0, 0), thumbAcross: true, rotate: 90 },
    open: { curls: curls(0, 0, 0, 0, 0) },
  }));
  check('Middle finger raised, facing the camera, reads "The Bird" (also on a phone held sideways; nothing else does)',
    g.bird === "The Bird" && g.birdSideways === "The Bird" && g.birdPointingDown !== "The Bird" && g.birdSideOn !== "The Bird" && g.peace === "Peace" && g.fist !== "The Bird",
    JSON.stringify(g));
  check("Finger counting: Two (thumb and index), Three (thumb, index, middle) and Four (thumb folded in), also sideways; an open hand stays Open Palm",
    g.two === "Two" && g.three === "Three" && g.four === "Four" && g.fourSideways === "Four" && g.open === "Open Palm" && g.point === "Point" && g.peace === "Peace",
    JSON.stringify({ two: g.two, three: g.three, four: g.four, fourSideways: g.fourSideways, open: g.open, point: g.point, peace: g.peace }));
  check("Fist, Point, Rock On, Call Me, Thumbs Up and Thumbs Down read as themselves (a thumb out to the side is neither)",
    g.fist === "Fist" && g.point === "Point" && g.rockOn === "Rock On" && g.callMe === "Call Me" && g.thumbsUp === "Thumbs Up" && g.thumbsDown === "Thumbs Down" &&
      !/Thumbs/.test(g.thumbSideways), JSON.stringify(g));

  // The same on real hands: landmarks measured from photos (upright, phone-portrait crops
  // and turned sideways), each fed through the tracker as if from a camera that size, as a
  // hand newly appearing (so smoothing starts fresh). The frames carry their own times (a
  // camera's 30 a second, and a second between photos, longer than the tracker keeps a lost
  // hand), so they needn't wait for the clock: only the hand card's redraw is waited for.
  const real = await js(`(async () => {
    const cases = ${fs.readFileSync(path.join(__dirname, "fixtures", "gesture-hands.json"), "utf8")}.cases;
    const cameraOf = HandTracker.getCamera;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const SPECIAL = ["The Bird", "Thumbs Down", "Live Long and Prosper", "Peace", "OK Sign"];
    const wrong = [], tally = {};
    let clock = performance.now();
    for (const c of cases) {
      clock += 1000; // a new hand
      HandTracker.getCamera = () => ({ ...cameraOf(), width: c.width, height: c.height });
      const frame = Object.assign(document.createElement("canvas"), { width: c.width, height: c.height });
      const landmarks = c.landmarks.map(([x, y, z]) => ({ x, y, z }));
      const show = () => {
        clock += 33;
        HandTracker._processResults({ image: frame, multiHandLandmarks: [landmarks], multiHandedness: [{ label: c.handedness, score: 0.9 }], externalTime: clock });
      };
      for (let f = 0; f < 12; f++) show();
      // The hand cards redraw at most about 15 times a second: one more frame once they can.
      await sleep(70);
      show();
      const side = c.handedness === "Left" ? "Right" : "Left"; // HandTracker swaps MediaPipe's labels
      const badge = document.querySelector("#slot" + side + " .gesture-badge");
      const got = badge ? badge.textContent : "(no card)";
      const right = c.expect === "other" ? !SPECIAL.includes(got) : got === c.expect;
      tally[c.expect] = tally[c.expect] || [0, 0];
      tally[c.expect][1]++;
      if (right) tally[c.expect][0]++;
      else wrong.push(c.photo + " " + c.variant + ": " + got + " (expected " + c.expect + ")");
      clock += 33;
      HandTracker._processResults({ image: frame, multiHandLandmarks: [], multiHandedness: [], externalTime: clock });
    }
    HandTracker.getCamera = cameraOf;
    return { wrong, tally };
  })()`);
  check("Real hands from photos: The Bird, Thumbs Down, Live Long and Prosper, Peace (any tilt) and OK Sign recognised, no other hand taken for them", real.wrong.length === 0,
    real.wrong.length ? real.wrong.join(" | ") : Object.entries(real.tally).map(([k, [ok, n]]) => `${k}: ${ok}/${n}`).join(", "));

  // Readable text: OCR also reads hand shapes as letters; those must never become flipped
  // boxes (they stayed on screen after the hand moved away). Same readings, three scans.
  const ocr = await js(`(() => {
    const word = (text, x0, y0, x1, y1) => ({ text, confidence: 90, bbox: { x0, y0, x1, y1 } });
    const scanOf = (...w) => ({ blocks: [{ paragraphs: [{ lines: [{ words: w }] }] }] });
    const hand = { x: 300, y: 200, w: 220, h: 260 };
    ReadableText.clear();
    for (let i = 0; i < 3; i++) ReadableText._ingest(scanOf(word("OK", 380, 300, 430, 330), word("12:30", 60, 40, 160, 80)), 1280, 720, 1000 + i * 400, [hand]);
    const onHand = ReadableText.getRegions();
    // With Readable text off, only times: a clock (and its AM/PM) but not a sign.
    ReadableText.clear();
    for (let i = 0; i < 3; i++) ReadableText._ingest(scanOf(word("EXIT", 600, 500, 760, 540), word("12:30", 60, 40, 160, 80), word("PM", 168, 40, 210, 80)), 1280, 720, 1000 + i * 400, [], true);
    const onlyTimes = ReadableText.getRegions();
    ReadableText.clear();
    return { onHand, onlyTimes };
  })()`);
  check("Readable text: words read on a hand are ignored, text elsewhere is still kept readable",
    ocr.onHand.length === 1 && ocr.onHand[0].x < 60 && ocr.onHand[0].x + ocr.onHand[0].w > 160, JSON.stringify(ocr.onHand));
  check("Readable text off: a time (with its AM/PM) is still flipped back, other text isn't",
    ocr.onlyTimes.length === 1 && ocr.onlyTimes[0].x < 60 && ocr.onlyTimes[0].x + ocr.onlyTimes[0].w > 210 && ocr.onlyTimes[0].y + ocr.onlyTimes[0].h < 500,
    JSON.stringify(ocr.onlyTimes));

  await checkTagSize(js);

  // Square crop, the pause key and the Show keys. From here on the camera's own frames are
  // tracked again (the gesture checks above had stopped them).
  await js("if (window.__realSend) Hands.prototype.send = window.__realSend; true");
  await new Promise((r) => setTimeout(r, 1500));
  const views = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const key = (k) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    const out = {};
    const before = HandTracker.getCamera();
    document.getElementById("squareToggle").click();
    await sleep(600);
    const sq = HandTracker.getCamera();
    out.square = { cam: sq.width + "x" + sq.height, stage: stage.width + "x" + stage.height, flag: sq.square };
    document.getElementById("squareToggle").click();
    await sleep(600);
    out.unsquare = HandTracker.getCamera().width === before.width;
    let n = 0;
    const off = HandTracker.onHandLandmarks(() => n++);
    key(" ");
    await sleep(300);
    n = 0;
    await sleep(1000);
    out.paused = { frames: n, flag: HandTracker.isPaused(), badge: !document.getElementById("pauseBadge").hidden };
    key(" ");
    await sleep(1000);
    out.resumed = { frames: n, flag: HandTracker.isPaused() };
    const box = () => document.querySelector('[data-show="box"]').classList.contains("active");
    const box0 = box();
    key("1");
    out.boxToggled = box() !== box0;
    key("1");
    key("f");
    out.fpsHidden = document.getElementById("fpsBadge").hidden;
    key("f");
    out.fpsBack = !document.getElementById("fpsBadge").hidden;
    return out;
  })()`);
  check("Square crop tracks the centre square; Space pauses and resumes; the Show keys (1-7, F) switch what's drawn",
    views.square.cam.split("x")[0] === views.square.cam.split("x")[1] && views.square.cam === views.square.stage && views.square.flag && views.unsquare &&
      views.paused.frames === 0 && views.paused.flag && views.paused.badge && views.resumed.frames > 5 && !views.resumed.flag &&
      views.boxToggled && views.fpsHidden && views.fpsBack, JSON.stringify(views));

  // Rotate: the picture is turned before tracking; T steps 90° right; an external source's
  // hands are turned with its picture.
  const rot = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = HandTracker.getCamera();
    rotateSelect.value = "90";
    rotateSelect.dispatchEvent(new Event("change"));
    await sleep(700);
    const r90 = HandTracker.getCamera();
    const out = { before: before.width + "x" + before.height, r90: r90.width + "x" + r90.height, stage90: stage.width + "x" + stage.height };
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
    await sleep(500);
    out.afterT = HandTracker.getRotation() + " " + HandTracker.getCamera().width + "x" + HandTracker.getCamera().height;
    out.remembered = JSON.parse(localStorage.getItem("hand-tracker:prefs")).rotations[before.deviceId || "default"];
    // An external source turned 90° right: a point near the top-left of its picture ends up
    // near the top-right, and a distance's x/y turn with it.
    await HandTracker.useExternalSource("Test");
    rotateSelect.value = "90"; // this source's own rotation
    rotateSelect.dispatchEvent(new Event("change"));
    let got = null;
    HandTracker.onHandLandmarks(({ hands }) => { if (hands.length) got = hands[0]; });
    const img = Object.assign(document.createElement("canvas"), { width: 640, height: 360 });
    const lm = Array.from({ length: 21 }, (_, i) => ({ x: 0.1 + i * 0.002, y: 0.2 + i * 0.004, z: 0 }));
    HandTracker.pushExternalFrame(img, { multiHandLandmarks: [lm], multiHandedness: [{ label: "Left", score: 0.9 }], extras: [{ score: 0.9, xyz: [100, 50, 800] }] }, performance.now());
    await sleep(100);
    out.ext = { size: HandTracker.getCamera().width + "x" + HandTracker.getCamera().height, wrist: got && [+got.imageLandmarks[0].x.toFixed(3), +got.imageLandmarks[0].y.toFixed(3)], xyz: got && got.distance };
    await HandTrackerApp.backToCamera();
    for (let i = 0; i < 40 && HandTracker.getCamera().source !== "camera"; i++) await sleep(250);
    rotateSelect.value = "0";
    rotateSelect.dispatchEvent(new Event("change"));
    await sleep(500);
    out.back = HandTracker.getRotation() + " " + HandTracker.getCamera().width + "x" + HandTracker.getCamera().height;
    return out;
  })()`);
  const [bw, bh] = rot.before.split("x");
  check("Rotate turns the picture before tracking (remembered per camera; T turns it 90° more); an OAK camera's hands turn with its picture",
    rot.r90 === `${bh}x${bw}` && rot.stage90 === rot.r90 && rot.afterT === `180 ${bw}x${bh}` && rot.remembered === 180 &&
      rot.ext.size === "360x640" && rot.ext.wrist && rot.ext.wrist[0] === 0.8 && rot.ext.wrist[1] === 0.1 && JSON.stringify(rot.ext.xyz) === "[-50,100,800]" &&
      rot.back.startsWith("0 ") && rot.back.endsWith(rot.before), JSON.stringify(rot));

  await checkPcControl(js);
  await checkPhoneLink(js);
  await checkCaptureSessions(js);
  await checkOpsStreaming();
  await checkLiveRigs(js);
  await checkSeveralCameras(js);
  await checkSeveralOakCameras(js);
  await checkOakPicturesOff(js);
  await checkOakTileRetry(js);
  await checkRemoteRecording(js);
  await checkRemoteLauncher(js);
  await checkRemoteHotspotWifi();
  await checkRemoteTakes();

  // An external source (a Luxonis OAK camera): pictures and MediaPipe-shaped hands pushed
  // in go through the same tracking, with the camera's confidence and measured distance.
  const ext = await js(`(async () => {
    const T = [[0,0],[-.04,-.03],[-.08,-.07],[-.11,-.10],[-.13,-.13],[-.035,-.12],[-.04,-.17],[-.043,-.20],[-.045,-.23],
      [0,-.125],[0,-.18],[0,-.215],[0,-.245],[.03,-.115],[.035,-.165],[.038,-.195],[.04,-.22],[.055,-.10],[.065,-.135],[.07,-.16],[.075,-.18]];
    const img = Object.assign(document.createElement("canvas"), { width: 1152, height: 648 });
    await HandTracker.useExternalSource("Test OAK");
    let last = null;
    const off = HandTracker.onHandLandmarks(({ hands }) => (last = hands));
    for (let i = 0; i < 10; i++) {
      // MediaPipe's label "Left" is the person's right hand.
      HandTracker.pushExternalFrame(img, {
        multiHandLandmarks: [T.map(([x, y]) => ({ x: 0.5 + x, y: 0.7 + y, z: 0 }))],
        multiHandedness: [{ label: "Left", score: 0.95 }],
        multiHandWorldLandmarks: [T.map(([x, y]) => ({ x: x * 0.75, y: y * 0.75, z: 0 }))],
        extras: [{ score: 0.9, xyz: [100, -50, 850] }],
      }, performance.now());
      await new Promise((r) => setTimeout(r, 40));
    }
    const cam = HandTracker.getCamera();
    const h = last && last[0];
    const out = { source: cam.source, size: cam.width + "x" + cam.height, stage: stage.width + "x" + stage.height,
      side: h && h.handedness, score: h && h.trackingScore, distance: h && h.distance, world: h && h.worldLandmarks && h.worldLandmarks.length };
    await HandTrackerApp.backToCamera();
    for (let i = 0; i < 40 && HandTracker.getCamera().source !== "camera"; i++) await new Promise((r) => setTimeout(r, 250));
    out.back = HandTracker.getCamera().source;
    return out;
  })()`);
  check("External source (OAK camera path): pictures and hands pushed in are tracked, with the camera's confidence and distance",
    ext.source === "external" && ext.size === "1152x648" && ext.stage === "1152x648" && ext.side === "Right" && ext.score === 0.9 &&
      JSON.stringify(ext.distance) === "[100,-50,850]" && ext.world === 21 && ext.back === "camera", JSON.stringify(ext));

  // One hand reported twice (two overlapping detections) counts once; a hand lost for a
  // moment is still shown (held) for up to 150 ms, then goes.
  const dup = await js(`(async () => {
    const T = [[0,0],[-.04,-.03],[-.08,-.07],[-.11,-.10],[-.13,-.13],[-.035,-.12],[-.04,-.17],[-.043,-.20],[-.045,-.23],
      [0,-.125],[0,-.18],[0,-.215],[0,-.245],[.03,-.115],[.035,-.165],[.038,-.195],[.04,-.22],[.055,-.10],[.065,-.135],[.07,-.16],[.075,-.18]];
    const hand = (dx) => T.map(([x, y]) => ({ x: 0.5 + x + dx, y: 0.7 + y, z: 0 }));
    let last = null;
    HandTracker.onHandLandmarks((p) => (last = p.hands));
    HandTracker.setPaused(true); // only these frames
    const image = document.getElementById("video");
    const out = {};
    HandTracker._processResults({ image, multiHandLandmarks: [hand(0), hand(0.004)], multiHandedness: [{ label: "Left", score: 0.95 }, { label: "Right", score: 0.6 }] });
    out.twice = last.length + " " + (last[0] && last[0].handedness);
    HandTracker._processResults({ image, multiHandLandmarks: [hand(0), hand(0.3)], multiHandedness: [{ label: "Left", score: 0.95 }, { label: "Right", score: 0.9 }] });
    out.two = last.length;
    await new Promise((r) => setTimeout(r, 250)); // past the hold for the second hand
    HandTracker._processResults({ image, multiHandLandmarks: [hand(0)], multiHandedness: [{ label: "Left", score: 0.95 }] });
    HandTracker._processResults({ image, multiHandLandmarks: [], multiHandedness: [] });
    out.heldNow = last.length + " " + !!(last[0] && last[0].held);
    await new Promise((r) => setTimeout(r, 250));
    HandTracker._processResults({ image, multiHandLandmarks: [], multiHandedness: [] });
    out.gone = last.length;
    HandTracker.setPaused(false);
    return out;
  })()`);
  check("A hand MediaPipe reports twice counts once; a hand lost for a moment is held on screen briefly, then goes",
    dup.twice === "1 Right" && dup.two === 2 && dup.heldNow === "1 true" && dup.gone === 0, JSON.stringify(dup));

  // Tracking carries on with the window minimized (for the hand mouse).
  const framesIn = async (ms) => {
    await js("window.__frames = 0; if (!window.__countFrames) { window.__countFrames = true; HandTracker.onHandLandmarks(() => window.__frames++); } true");
    await new Promise((r) => setTimeout(r, ms));
    return js("window.__frames");
  };
  const shownFrames = await framesIn(3000);
  win.minimize();
  await new Promise((r) => setTimeout(r, 800));
  const minimizedFrames = await framesIn(3000);
  win.showInactive(); // restored without taking the keyboard focus (typing elsewhere mustn't reach it)
  await new Promise((r) => setTimeout(r, 800));
  check("Tracking keeps going with the window minimized (at least half the usual rate)", shownFrames > 20 && minimizedFrames >= shownFrames / 2,
    `${shownFrames} frames in 3 s shown, ${minimizedFrames} minimized`);

  // MediaPipe losing its graphics (WebGL) context, as in a graphics crash or driver reset:
  // it used to find nothing from then on, and abort for good on its next reset.
  const mediaPipe = () => js("HandTracker._mediaPipe()");
  const mpBefore = await mediaPipe();
  const errorsBefore = consoleErrors.length;
  await js("HandTracker._loseMediaPipeContext(); true");
  await new Promise((r) => setTimeout(r, 1500));
  const lossFrames = await framesIn(3000);
  const mpAfter = await mediaPipe();
  await js("HandTrackerApp.backToCamera().then(() => true)"); // resets MediaPipe, which a lost one didn't survive
  await new Promise((r) => setTimeout(r, 800));
  const resetFrames = await framesIn(3000);
  // A frame in flight at the moment of the loss may fail; that's the point of the check.
  const lossErrors = consoleErrors.splice(errorsBefore).filter((m) => !/Hand tracking frame failed|WebGL|CONTEXT_LOST/i.test(m));
  consoleErrors.push(...lossErrors);
  check("MediaPipe whose graphics (WebGL) context is lost is started again, and tracking carries on (also after a reset)",
    mpBefore.contexts > 0 && !mpBefore.lost && mpAfter.rebuilds === mpBefore.rebuilds + 1 && !mpAfter.lost && lossFrames > 20 && resetFrames > 20,
    JSON.stringify({ before: mpBefore, after: mpAfter, framesAfterLoss: lossFrames, framesAfterReset: resetFrames }));

  const relevantErrors = consoleErrors.filter((m) => !/DevTools|Autofill/i.test(m));
  check("No errors in the page console", relevantErrors.length === 0, relevantErrors.slice(0, 3).join(" | "));

  // 6. Video files as the tracking source: formats the page plays itself and ones
  //    ffmpeg converts; every frame tracked on the video's own clock.
  await js("Hands.prototype.send = window.__realSend; document.getElementById('discardBtn').click();");
  await checkVideoFiles(win, js);
  await checkSeveralVideos(win, js);
  await checkBlackGloves(js);
  await checkMirrorDefaults(js);
  await checkOptiTrack(js);

  if (jsonPath) await checkViewer(jsonPath, { csv: mfile(".csv"), c3d: mfile(".c3d"), trc: mfile(".trc"), glb: mfile(".glb"), npz: mfile(".npz"), bvh: mfile("-left.bvh"), json: jsonPath, markers: path.join(outDir, "motive-take-motive.c3d") });
  await checkViewerVideo();
}

// The Left/Right tag: its normal size with a hand at arm's length or closer, bigger as the
// hand goes further away (up to 2x). On a phone it starts a little bigger (check-android.js).
async function checkTagSize(js) {
  const r = await js(TAG_HEIGHTS);
  const near = (v, want) => Math.abs(v - want) <= Math.max(4, want * 0.12);
  check("Left/Right tag: normal size with a hand at arm's length or closer, bigger as it goes further away (up to 2x)",
    near(r.veryClose, 32) && near(r.armsLength, 32) && near(r.further, 32 * 1.6) && near(r.far, 32 * 2) && near(r.veryFar, 32 * 2) && r.veryFar <= r.far + 4,
    JSON.stringify(r));
}

// Hand mouse and gesture actions (pc-control.js), with a stand-in for the real mouse and
// keyboard: synthetic hands are fed in, and what would have been sent is recorded.
async function checkPcControl(js) {
  const r = await js(`(async () => {
    const calls = [];
    const fake = {
      start: async () => {}, status: () => {}, setKeyboard: async () => {},
      pointer: (x, y) => calls.push(["pointer", x, y]),
      button: async (w, a) => calls.push(["button", w, a]),
      wheel: async (n) => calls.push(["wheel", n]),
      key: async (c, a) => calls.push(["key", c, a]),
      text: async (t) => calls.push(["text", t]),
      web: async (req) => { calls.push(["web", req.url, req.method, req.body && req.body.gesture]); return { ok: true, status: 200 }; },
    };
    HandTracker.setPaused(true); // only these synthetic hands reach PcControl
    PcControl._setDesktop({ pc: fake });
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const T = [[0,0],[-.04,-.03],[-.08,-.07],[-.11,-.10],[-.13,-.13],[-.035,-.12],[-.04,-.17],[-.043,-.20],[-.045,-.23],
      [0,-.125],[0,-.18],[0,-.215],[0,-.245],[.03,-.115],[.035,-.165],[.038,-.195],[.04,-.22],[.055,-.10],[.065,-.135],[.07,-.16],[.075,-.18]];
    // An open right hand with its wrist at (cx, cy); curled fingers have their tip and last
    // joint pulled back towards the knuckle, keeping "keep" of their length (0.55: a light click).
    const hand = (cx, cy, curled = [], side = "Right", keep = 0.2) => ({ handedness: side, imageLandmarks: T.map(([x, y], i) => {
      const f = { 7: 5, 8: 5, 11: 9, 12: 9 }[i];
      const bent = f !== undefined && curled.includes(f === 5 ? "index" : "middle");
      const [bx, by] = bent ? [T[f][0] + (x - T[f][0]) * keep, T[f][1] + (y - T[f][1]) * keep] : [x, y];
      return { x: cx + bx, y: cy + by, z: 0 };
    }) });
    const none = () => ({ label: "—" });
    const frames = async (n, hands, gestureOf = none, mirrored = false) => {
      for (let i = 0; i < n; i++) { PcControl.update(typeof hands === "function" ? hands(i) : hands, gestureOf, mirrored, 16 / 9); await sleep(30); }
    };
    const out = {};

    // Hand mouse.
    PcControl.setMouse(true);
    await sleep(50);
    calls.length = 0;
    await frames(20, (i) => [hand(0.35 + i * 0.015, 0.6)]);
    const xs = calls.filter((c) => c[0] === "pointer").map((c) => c[1]);
    out.follows = xs.length > 10 && xs[xs.length - 1] > xs[0] + 0.3;
    calls.length = 0;
    await frames(6, [hand(0.65, 0.6)]);
    await frames(3, [hand(0.65, 0.6, ["index"])]);
    await frames(6, [hand(0.65, 0.6)]);
    out.leftClick = calls.filter((c) => c[0] === "button").map((c) => c.slice(1).join(" "));
    calls.length = 0;
    await frames(25, [hand(0.65, 0.6, ["index"])]); // held: drag
    await frames(6, [hand(0.65, 0.6)]);
    out.drag = calls.filter((c) => c[0] === "button").map((c) => c.slice(1).join(" "));
    calls.length = 0;
    await frames(3, [hand(0.65, 0.6, ["middle"])]);
    await frames(6, [hand(0.65, 0.6)]);
    out.rightClick = calls.filter((c) => c[0] === "button").map((c) => c.slice(1).join(" "));
    calls.length = 0;
    await frames(4, [hand(0.65, 0.6, ["index", "middle"])]); // both: hold still, no click
    await frames(6, [hand(0.65, 0.6)]);
    out.bothCurled = calls.filter((c) => c[0] === "button").length;
    // Light clicks, as people make them: the finger only bends a little.
    calls.length = 0;
    await frames(6, [hand(0.65, 0.6)]);
    await frames(5, [hand(0.65, 0.6, ["index"], "Right", 0.55)]);
    await frames(6, [hand(0.65, 0.6)]);
    await frames(5, [hand(0.65, 0.6, ["middle"], "Right", 0.55)]);
    await frames(6, [hand(0.65, 0.6)]);
    out.lightClicks = calls.filter((c) => c[0] === "button").map((c) => c.slice(1).join(" "));
    PcControl.setMouse(false);
    await sleep(50);
    PcControl.setMouse(true);
    await sleep(50);
    calls.length = 0;
    await frames(20, (i) => [hand(0.35 + i * 0.015, 0.6)], none, true); // mirrored view: moving right in the picture is left for you
    const mx = calls.filter((c) => c[0] === "pointer").map((c) => c[1]);
    out.mirrored = mx.length > 10 && mx[mx.length - 1] < mx[0] - 0.3;
    PcControl.setMouse(false);

    // Gesture actions.
    const as = (label) => () => ({ label });
    PcControl._setRules([
      { enabled: true, gesture: "Fist", hand: "any", action: "keys", value: "playpause", trigger: "enter", hold: 0.3, every: 1 },
      { enabled: true, gesture: "Thumbs Up", hand: "Right", action: "keys", value: "volumeup", trigger: "periodic", hold: 0.1, every: 0.2 },
      { enabled: true, gesture: "Peace", hand: "any", action: "hold", trigger: "enter_leave", hold: 0, every: 1 },
      { enabled: true, gesture: "Point", hand: "any", action: "web", value: "http://127.0.0.1:9/hook", method: "POST", trigger: "enter", hold: 0, every: 1 },
      { enabled: false, gesture: "Open Palm", hand: "any", action: "text", value: "no", trigger: "enter", hold: 0, every: 1 },
    ], true);
    const h = [hand(0.5, 0.6)];
    calls.length = 0;
    await frames(6, h, as("Fist")); // 0.18 s: not yet
    out.fistEarly = calls.length;
    await frames(3, [], none); // a short dropout (up to 3 frames) doesn't restart it
    await frames(10, h, as("Fist"));
    out.fist = calls.map((c) => c.slice(1).join(" "));
    await frames(6, [], none);
    calls.length = 0;
    await frames(24, h, as("Thumbs Up")); // about 0.7 s held
    out.thumbs = calls.filter((c) => c[0] === "key").length;
    await frames(6, [], none);
    calls.length = 0;
    await frames(10, [hand(0.5, 0.6, [], "Left")], as("Thumbs Up")); // the left hand isn't this action's
    out.wrongHand = calls.length;
    await frames(6, [], none);
    calls.length = 0;
    await frames(8, h, as("Peace"));
    await frames(6, [], none);
    out.hold = calls.map((c) => c.slice(1).join(" "));
    calls.length = 0;
    await frames(5, h, as("Point"));
    await frames(6, [], none);
    out.web = calls.map((c) => c.slice(1).join(" "));
    calls.length = 0;
    await frames(5, h, as("Open Palm")); // switched off
    out.disabled = calls.length;
    PcControl._state().allow.keyboard = false; // the Keyboard switch off
    await frames(6, [], none);
    calls.length = 0;
    await frames(15, h, as("Fist"));
    out.keyboardOff = calls.length;
    PcControl._state().allow.keyboard = true;
    PcControl._setRules([], false);
    PcControl._setDesktop(window.desktop);
    HandTracker.setPaused(false);
    return { out, visible: !document.getElementById("pcCard").hidden };
  })()`);
  const o = r.out;
  check("Control your PC: the card is shown in the desktop app", r.visible);
  check("Hand mouse: the pointer follows the palm (the other way in mirrored view, so it moves the way your hand does)", o.follows && o.mirrored, JSON.stringify({ follows: o.follows, mirrored: o.mirrored }));
  check("Hand mouse: quick index curl = left click, held = drag, quick middle curl = right click, both curled = no click; light clicks count too",
    o.leftClick.join() === "left click" && o.drag.join() === "left down,left up" && o.rightClick.join() === "right click" && o.bothCurled === 0 &&
      o.lightClicks.join() === "left click,right click",
    JSON.stringify({ leftClick: o.leftClick, drag: o.drag, rightClick: o.rightClick, bothCurled: o.bothCurled, lightClicks: o.lightClicks }));
  check("Gesture actions: hold time, dropouts, repeats, start-and-end, which hand, web requests and the on/off switches work",
    o.fistEarly === 0 && o.fist.join() === "playpause tap" && o.thumbs >= 3 && o.thumbs <= 5 && o.wrongHand === 0 &&
      o.hold.join() === "left down,left up" && o.web.join() === "http://127.0.0.1:9/hook POST Point" && o.disabled === 0 && o.keyboardOff === 0,
    JSON.stringify(o));
}

// Capture Sessions' video streaming (electron/ops.js serve), against a stand-in cloud store
// serving an MP4 with its index at the end, as the rigs' are. The video player asks for
// "byte N to the end" and drops the answer when it has enough: that must stop costing
// anything (it used to stall playback a few seconds in), the bytes must be exactly the
// file's, parts just fetched are reused, and the file's end (where the index is) is served.
// Letting a phone control this PC (phone-link.js): the toggle shows a QR code holding the
// pairing code; a stand-in phone pairs from it and connects, its signed requests are carried
// out (here only the floating keyboard, so nothing reaches the real mouse or keys), one signed
// with another key isn't, and turning it off stops listening.
async function checkPhoneLink(js) {
  const dgram = require("dgram");
  const P = require("../phone-link-protocol.js");
  const page = () => js(`({ code: document.getElementById("linkCode").textContent, status: document.getElementById("linkPcStatus").textContent,
    toggle: document.getElementById("linkToggle").textContent, pairShown: !document.getElementById("linkPcPair").hidden,
    shown: !document.getElementById("linkPc").hidden && document.getElementById("linkPhone").hidden })`);
  await js(`document.getElementById("linkToggle").click(); true`);
  let on;
  for (let i = 0; i < 30; i++) {
    on = await page();
    if (on.code) break;
    await sleep(100);
  }
  const out = { shown: on.shown, toggle: on.toggle, pairShown: on.pairShown, waiting: on.status };
  // The QR code reads back as the pairing code: jsQR reads its pixels, as a phone's camera app
  // would (OpenCV's reader, used before, missed some codes that read fine everywhere else).
  const qrPixels = await js(`(() => { const c = document.getElementById("linkQr"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height); return { w: c.width, h: c.height, data: Array.from(d.data) }; })()`);
  const qrRead = require("jsqr")(Uint8ClampedArray.from(qrPixels.data), qrPixels.w, qrPixels.h);
  out.qr = qrRead && qrRead.data === on.code ? "reads back" : `reads "${qrRead ? qrRead.data : ""}"`;
  const pair = P.parsePairing(on.code.replace(/:[0-9.,]+$/, ":127.0.0.1"));
  const sock = dgram.createSocket("udp4");
  await new Promise((r) => sock.bind(0, r));
  const answers = [];
  sock.on("message", async (m) => {
    const d = await P.decode(pair.key, m);
    if (d) answers.push(d);
  });
  const send = async (key, msg) => sock.send(await P.encode(key, msg), pair.port, "127.0.0.1");
  const answer = async (seq) => {
    for (let i = 0; i < 20; i++) {
      const a = answers.find((x) => x.seq === seq);
      if (a) return a.data;
      await sleep(50);
    }
    return null;
  };
  await send(pair.key, { seq: 1, type: "hello", data: { name: "Check phone", id: "attempt-1" } });
  const hello = await answer(1);
  out.connected = !!(hello && hello.session);
  // The same hello again (sent again, or over a second network): the same session.
  answers.length = 0;
  await send(pair.key, { seq: 1, type: "hello", data: { name: "Check phone", id: "attempt-1" } });
  const again = await answer(1);
  out.sameSession = !!(again && hello && again.session === hello.session);
  await sleep(200);
  out.connectedStatus = (await page()).status;
  await send(pair.key, { session: hello && hello.session, seq: 2, type: "keyboard", data: { show: false } });
  out.keyboard = await answer(2);
  await send(P.newKey(), { session: hello && hello.session, seq: 3, type: "keyboard", data: { show: true } });
  out.forged = await answer(3);
  sock.close();
  await js(`document.getElementById("linkToggle").click(); true`);
  await sleep(300);
  const off = await page();
  out.off = { toggle: off.toggle, pairShown: off.pairShown };
  check("Let a phone control this PC: shows a QR code to pair it; a paired phone connects and its signed requests are carried out, others aren't; turning it off stops it",
    out.shown && /ON/.test(out.toggle) && out.pairShown && /Waiting for the phone/.test(out.waiting) && !/reads "/.test(out.qr) && out.connected &&
      /Connected: Check phone/.test(out.connectedStatus) && out.sameSession && out.keyboard && out.keyboard.ok && out.keyboard.result && out.keyboard.result.shown === false &&
      out.forged === null && /OFF/.test(out.off.toggle) && !out.off.pairShown,
    JSON.stringify(out));
}

async function checkOpsStreaming() {
  const { OpsClient } = require("../electron/ops.js");
  const file = path.join(outDir, "session-video.mp4");
  spawnSync(exporter.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "6",
    "-c:v", "libx264", "-b:v", "12M", "-pix_fmt", "yuv420p", file]);
  const video = fs.readFileSync(file);
  const size = video.length;
  const fetched = [];
  const store = async (url, init) => {
    const m = /^bytes=(\d+)-(\d*)$/.exec((init && init.headers && init.headers.Range) || "");
    const from = m ? Number(m[1]) : 0, to = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    fetched.push(`${from}-${to}`);
    return new Response(video.subarray(from, to + 1), { status: 206, headers: { "content-type": "video/mp4", "content-range": `bytes ${from}-${to}/${size}` } });
  };
  const ops = new OpsClient(fs.mkdtempSync(path.join(os.tmpdir(), "ops-check-")), store);
  ops.cfg = { base: "https://db.test", key: "k", bucket: "bucket" };
  ops.sign = async (sessionId, paths) => ({ [paths[0]]: "https://storage.test/video.mp4" });
  const id = ops.stream("00000000-0000-0000-0000-000000000000", "head/rgb/video.mp4");
  const ask = (range) => ops.serve(new Request("app://hand-tracker/__ops/" + id, { headers: { Range: range } }), id);
  const out = {};
  // 1. Read a little, then drop it, as the player does: at most the part read and one ahead.
  let res = await ask("bytes=0-");
  out.first = { status: res.status, length: Number(res.headers.get("content-length")), range: res.headers.get("content-range") };
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 300));
  out.fetchedAfterDropping = fetched.length;
  // 2. Read it all: exactly the file.
  res = await ask("bytes=0-");
  const all = Buffer.from(await res.arrayBuffer());
  out.whole = all.equals(video);
  out.fetchedForWhole = fetched.length;
  // 3. Again from inside a part just fetched: nothing new is fetched for it.
  const before = fetched.length;
  res = await ask(`bytes=${size - 1500000}-`);
  const tail = Buffer.from(await res.arrayBuffer());
  out.tail = { status: res.status, same: tail.equals(video.subarray(size - 1500000)), newFetches: fetched.length - before };
  // 4. The index at the end, as the player asks for it first.
  res = await ask(`bytes=${size - 1000}-`);
  out.end = { range: res.headers.get("content-range"), same: Buffer.from(await res.arrayBuffer()).equals(video.subarray(size - 1000)) };
  const parts = Math.ceil(size / (4 * 1024 * 1024));
  check("Capture Sessions: session videos stream a part at a time (a dropped request stops fetching), byte for byte, reusing parts just fetched",
    out.first.status === 206 && out.first.length === size && out.first.range === `bytes 0-${size - 1}/${size}` && out.fetchedAfterDropping <= 2 &&
      out.whole && out.fetchedForWhole === parts && out.tail.status === 206 && out.tail.same && out.tail.newFetches === 0 && out.end.same && parts >= 2,
    JSON.stringify({ size, parts, ...out }));
}

// Capture Sessions is hidden: it stays out of sight until Ctrl+Alt+P, then asks for a
// dashboard's address (no account is needed to check that), and Ctrl+Alt+P hides it again.
async function checkCaptureSessions(js) {
  const r = await js(`(async () => {
    const $ = (id) => document.getElementById(id);
    const key = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true, altKey: true, bubbles: true }));
    const saved = () => (JSON.parse(localStorage.getItem("hand-tracker:prefs")) || {}).captureSessions;
    const out = { hiddenAtStart: $("opsBtn").hidden && $("opsDialog").hidden };
    key();
    await new Promise((r) => setTimeout(r, 400));
    out.shown = !$("opsBtn").hidden && !$("opsDialog").hidden;
    out.asksForSite = !$("opsSetup").hidden && $("opsSignIn").hidden && $("opsBrowse").hidden;
    out.remembered = saved() === true;
    key();
    out.hiddenAgain = $("opsBtn").hidden && $("opsDialog").hidden && saved() === false;
    out.batch = typeof HandTrackerApp.trackWholeVideo === "function";
    return out;
  })()`);
  check("Capture Sessions stays hidden until Ctrl+Alt+P, then asks for the dashboard's address; Ctrl+Alt+P hides it again (remembered)",
    r.hiddenAtStart && r.shown && r.asksForSite && r.remembered && r.hiddenAgain && r.batch, JSON.stringify(r));
}

// Several cameras at once: a tile per camera (here the test camera twice), each with its own
// tracker; motion capture records them together and merges them, hands named by camera.
async function checkSeveralCameras(js) {
  const r = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const cams = await HandTracker.listCameras();
    await MultiCamera.start([cams[0].deviceId, cams[0].deviceId]);
    let tiles = [];
    for (let i = 0; i < 120; i++) {
      tiles = MultiCamera._tiles();
      if (tiles.length === 2 && tiles.every((t) => t.status && t.status.fps > 0)) break;
      await sleep(250);
    }
    const out = { tiles: tiles.map((t) => t.name + ":" + (t.status ? t.status.fps + "fps " + t.status.width + "x" + t.status.height : "none")), mainPaused: HandTracker.isPaused(),
      card: !document.getElementById("multiCamCard").hidden };
    // Roles: each camera has one; picking one another camera has swaps them.
    const selects = [...document.querySelectorAll("#multiCamGrid select.role")];
    const roles0 = MultiCamera._tiles().map((t) => t.role);
    const choose = (sel, role) => { sel.value = role; sel.dispatchEvent(new Event("change", { bubbles: true })); };
    choose(selects[0], "wrist_left");
    choose(selects[1], "wrist_left");
    out.roles = { before: roles0, after: MultiCamera._tiles().map((t) => t.role), shown: selects.map((s) => s.value) };
    out.expect = [CameraRoles.label(out.roles.after[0]) + " Left", CameraRoles.label(out.roles.after[1]) + " Right"];
    // Hands in each tile (the test camera has none): a left hand in Cam 1, a right one in Cam 2.
    const T = [[0,0],[-.04,-.03],[-.08,-.07],[-.11,-.10],[-.13,-.13],[-.035,-.12],[-.04,-.17],[-.043,-.20],[-.045,-.23],
      [0,-.125],[0,-.18],[0,-.215],[0,-.245],[.03,-.115],[.035,-.165],[.038,-.195],[.04,-.22],[.055,-.10],[.065,-.135],[.07,-.16],[.075,-.18]];
    const hand = (dx) => T.map(([x, y]) => ({ x: 0.5 + x + dx, y: 0.7 + y, z: 0 }));
    const wins = [...document.querySelectorAll("#multiCamGrid iframe")].map((f) => f.contentWindow);
    wins.forEach((w) => w.HandTracker.setPaused(true)); // only these frames
    document.getElementById("multiCamRecord").click();
    await sleep(300);
    for (let k = 0; k < 40; k++) {
      wins.forEach((w, i) => w.HandTracker._processResults({ image: w.document.getElementById("video"), multiHandLandmarks: [hand(0.002 * k)], multiHandedness: [{ label: i ? "Left" : "Right", score: 0.95 }] }));
      await sleep(33);
    }
    document.getElementById("multiCamRecord").click();
    await sleep(500);
    out.export = !document.getElementById("motionExportCard").hidden;
    out.info = document.getElementById("motionInfo").textContent;
    out.note = document.getElementById("multiCamNote").textContent;
    MultiCamera.close();
    await sleep(300);
    out.closed = document.getElementById("multiCamCard").hidden && !HandTracker.isPaused() && document.querySelectorAll("#multiCamGrid iframe").length === 0;
    document.getElementById("motionDiscardBtn").click(); // (an unexported capture would make the next one ask first)
    return out;
  })()`).catch((err) => ({ error: String((err && err.message) || err) }));
  // (MediaPipe's labels are the camera's view; mirrored webcams show them the other way round.)
  check("Several cameras at once: a tile per camera, each tracking on its own; motion capture records them all and merges them on one clock, hands named by camera; closing goes back to one camera",
    r.tiles && r.tiles.length === 2 && r.tiles.every((t) => /:[1-9]\d*fps/.test(t)) && r.mainPaused && r.card && r.export &&
      r.expect && r.info.includes(r.expect[0]) && r.info.includes(r.expect[1]) && /2 cameras/.test(r.note) && r.closed,
    JSON.stringify(r));
  const roles = r.roles || {};
  check("Several cameras: each camera has a role (head, chest, left or right wrist), given in order; picking one another camera has swaps them; hands are named after it (\"Chest Left\")",
    roles.before && roles.before.join() === "head,chest" && roles.after.join() === "chest,wrist_left" && roles.shown.join() === "chest,wrist_left" &&
      r.expect.join() === "Chest Left,Left wrist Right",
    JSON.stringify({ roles, expect: r.expect, info: r.info }));
  const guessed = await js(`({
    guesses: ["rig_head_rgb.mp4", "Chest cam.mov", "wrist_left.mp4", "R-wrist.mp4", "leftWrist.mkv", "WristRight.mp4", "handheld.mp4", "OAK-D Lite"].map(CameraRoles.guess),
    assigned: CameraRoles.assign([{ name: "b_chest.mp4" }, { name: "x.mp4" }, { name: "head.mp4" }]),
    savedNone: CameraRoles.assign([{ name: "head.mp4", saved: "" }, { name: "y.mp4" }]),
    savedTwice: CameraRoles.assign([{ name: "a", saved: "chest" }, { name: "b", saved: "chest" }]),
  })`);
  check("Camera roles are guessed from names (head, chest, left/right wrist), the rest given in order, no role twice, and \"No role\" is kept",
    guessed.guesses.join() === "head,chest,wrist_left,wrist_right,wrist_left,wrist_right,," && guessed.assigned.join() === "chest,wrist_left,head" &&
      guessed.savedNone.join() === ",head" && guessed.savedTwice.join() === "chest,head",
    JSON.stringify(guessed));
}

// Several cameras with Luxonis OAK cameras among them, against two stand-in OAK cameras
// (SimulatedOak in electron/main.js: each streams a moving hand, as the OAK helper does).
async function checkSeveralOakCameras(js) {
  const r = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await MultiCamera.openPicker();
    let boxes = [];
    for (let i = 0; i < 50; i++) {
      boxes = [...document.querySelectorAll("#multiCamPicks input")].map((b) => b.value + " = " + b.parentElement.textContent.trim());
      if (boxes.some((b) => b.startsWith("oak:"))) break;
      await sleep(100);
    }
    document.getElementById("multiCamCancel").click();
    const out = { boxes };
    await MultiCamera.start(["oak:SIMULATED-OAK-A", "oak:SIMULATED-OAK-B"]);
    let tiles = [];
    for (let i = 0; i < 150; i++) {
      tiles = MultiCamera._tiles();
      if (tiles.length === 2 && tiles.every((t) => t.status && t.status.fps > 0 && t.status.hands.length)) break;
      await sleep(200);
    }
    out.tiles = tiles.map((t) => ({ name: t.name, role: t.role, fps: t.status && t.status.fps, hands: t.status && t.status.hands, error: t.status && t.status.error }));
    out.labels = [...document.querySelectorAll("#multiCamGrid .lbl")].map((l) => l.textContent);
    // Running tiles show their picture, not "Starting the OAK camera…" over it.
    out.messages = [...document.querySelectorAll("#multiCamGrid iframe")].map((f) => getComputedStyle(f.contentDocument.getElementById("message")).display);
    document.getElementById("multiCamRecord").click();
    await sleep(1500);
    document.getElementById("multiCamRecord").click();
    await sleep(500);
    out.info = document.getElementById("motionInfo").textContent;
    out.names = JSON.parse(localStorage.getItem("hand-tracker:prefs")).oakNames || {};
    MultiCamera.close();
    await sleep(300);
    out.closed = document.getElementById("multiCamCard").hidden && document.querySelectorAll("#multiCamGrid iframe").length === 0;
    document.getElementById("motionDiscardBtn").click(); // (an unexported capture would make the next one ask first)
    return out;
  })()`).catch((err) => ({ error: String((err && err.message) || err) }));
  check("Several cameras with Luxonis OAK cameras: the picker lists them; each gets a tile, its hands found on the camera; they record together, hands named by role",
    r.boxes && r.boxes.filter((b) => b.startsWith("oak:")).length === 2 &&
      r.tiles.length === 2 && r.tiles.every((t) => t.fps > 0 && t.hands.length === 1 && !t.error) && r.tiles.map((t) => t.role).join() === "head,chest" &&
      r.messages.every((d) => d === "none") &&
      r.labels.every((l) => /Luxonis Simulated OAK SIMULATED-OAK-[AB] · depth/.test(l)) && r.names["SIMULATED-OAK-A"] === "Simulated OAK SIMULATED-OAK-A" &&
      /Head \w+/.test(r.info) && /Chest \w+/.test(r.info) && r.closed,
    JSON.stringify(r));
}

// Several cameras' OAK pictures left off the screen ("Hide pictures"): the hands are still
// tracked and recorded, and pictures are only made as often as remote previews need them
// (a few a second each, or the one looked at full screen, often); back on, every frame.
async function checkOakPicturesOff(js) {
  const r = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await MultiCamera.start(["oak:SIMULATED-OAK-A", "oak:SIMULATED-OAK-B"]);
    for (let i = 0; i < 150; i++) {
      const t = MultiCamera._tiles();
      if (t.length === 2 && t.every((x) => x.status && x.status.fps > 0 && x.status.hands.length)) break;
      await sleep(200);
    }
    const pics = () => MultiCamera._tiles().map((t) => t.status.pictures);
    const drawn = async (ms) => {
      const a = pics();
      await sleep(ms);
      return pics().map((n, i) => n - a[i]);
    };
    const btn = document.getElementById("multiCamScreen");
    const out = { visible: document.visibilityState, shown: !btn.hidden, before: btn.textContent };
    out.onDrawn = await drawn(1000);
    // A picture that takes long to draw (as on a Raspberry Pi with nobody at its screen) doesn't
    // hold up the hands: they still come at the camera's rate, the pictures as they can.
    const wins = [...document.querySelectorAll("#multiCamGrid iframe")].map((f) => f.contentWindow);
    const quick = wins.map((w) => w.Tile.oakPicture);
    wins.forEach((w, k) => (w.Tile.oakPicture = async (...a) => { await sleep(700); return quick[k](...a); }));
    await sleep(2500);
    out.slow = { drawn: await drawn(2000), fps: MultiCamera._tiles().map((t) => t.status.fps) };
    wins.forEach((w, k) => (w.Tile.oakPicture = quick[k]));
    await sleep(800);
    btn.click();
    out.after = btn.textContent;
    out.dimmed = document.querySelectorAll("#multiCamGrid .multi-cam-tile.no-picture").length;
    await sleep(300);
    out.offDrawn = await drawn(2000);
    out.offTiles = MultiCamera._tiles().map((t) => ({ fps: t.status.fps, hands: t.status.hands.length }));
    out.status = [...document.querySelectorAll("#multiCamGrid .st")].map((s) => s.textContent);
    MultiCamera.setPreviewWant({ on: true, focus: null, ms: 250, focusMs: 66 });
    out.previewDrawn = await drawn(2000);
    // The pictures made for the previews have the skeleton on them (its green), as ever.
    out.skeleton = [...document.querySelectorAll("#multiCamGrid iframe")].map((f) => {
      const c = f.contentDocument.getElementById("stage");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let k = 0; k < d.length; k += 4) if (d[k] < 80 && d[k + 1] > 200 && d[k + 2] > 90 && d[k + 2] < 180) n++;
      return n;
    });
    MultiCamera.setPreviewWant({ on: true, focus: 1, ms: 250, focusMs: 66 });
    await sleep(100);
    out.focusDrawn = await drawn(2000);
    MultiCamera.setPreviewWant({ on: false });
    document.getElementById("multiCamRecord").click();
    await sleep(1500);
    document.getElementById("multiCamRecord").click();
    await sleep(500);
    out.info = document.getElementById("motionInfo").textContent;
    document.getElementById("motionDiscardBtn").click();
    btn.click();
    out.back = btn.textContent;
    await sleep(200);
    out.backDrawn = await drawn(1000);
    out.pref = JSON.parse(localStorage.getItem("hand-tracker:prefs")).screenPictures;
    MultiCamera.close();
    await sleep(300);
    return out;
  })()`).catch((err) => ({ error: String((err && err.message) || err) }));
  const all = (list, ok) => Array.isArray(list) && list.length === 2 && list.every(ok);
  check("Several cameras: the OAK cameras' pictures can be left off the screen (hands still tracked and recorded); then they're made only as often as remote previews need them, skeleton drawn; a slow picture never holds up the hands",
    r.shown && r.before === "Hide pictures" && r.after === "Show pictures" && r.dimmed === 2 && all(r.onDrawn, (n) => n >= 10) &&
      r.slow && all(r.slow.drawn, (n) => n >= 1 && n <= 4) && all(r.slow.fps, (f) => f >= 15) &&
      all(r.offDrawn, (n) => n === 0) && all(r.offTiles, (t) => t.fps > 0 && t.hands === 1) && all(r.status, (s) => /picture off/.test(s)) &&
      all(r.previewDrawn, (n) => n >= 3 && n <= 12) && all(r.skeleton, (n) => n > 50) && r.focusDrawn[0] === 0 && r.focusDrawn[1] >= 12 &&
      /Head \w+/.test(r.info) && /Chest \w+/.test(r.info) && r.back === "Hide pictures" && all(r.backDrawn, (n) => n >= 10) && r.pref === true,
    JSON.stringify(r));
}

// Remote recording: a phone's browser (played here by plain requests) starts the cameras (only
// those plugged in) and recording, sees each camera's preview, moves a camera to another role's
// block, turns and flips one, fills in the take details, stops (the take saves itself, named
// after the details and its length, which its metadata holds too) and stops the cameras.
async function checkRemoteRecording(js) {
  const out = {};
  const setup = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // The cameras are picked once in Several cameras (the two simulated OAK cameras, and a third
    // that's since been unplugged), then closed.
    const opening = MultiCamera.openPicker();
    for (let i = 0; i < 50 && !document.querySelector('#multiCamPicks input[value^="oak:"]'); i++) await sleep(100);
    await opening;
    const ticked = [...document.querySelectorAll("#multiCamPicks input:checked")].map((b) => b.value);
    const gone = document.createElement("input");
    gone.type = "checkbox";
    gone.value = "oak:SIMULATED-OAK-UNPLUGGED";
    document.getElementById("multiCamPicks").appendChild(gone);
    document.querySelectorAll("#multiCamPicks input").forEach((b) => (b.checked = b.value.startsWith("oak:")));
    document.getElementById("multiCamPicks").dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("multiCamStart").click();
    for (let i = 0; i < 100 && !(MultiCamera.isActive() && MultiCamera.remoteState().cameras.every((c) => c.fps > 0)); i++) await sleep(100);
    MultiCamera.close();
    await sleep(500);
    document.getElementById("remoteToggle").click();
    let s = null;
    for (let i = 0; i < 50 && !(s && s.on); i++) { await sleep(100); s = await desktop.remote.status(); }
    return { status: s, card: !document.getElementById("remotePair").hidden, running: MultiCamera.isActive(), ticked };
  })()`).catch((err) => ({ error: String((err && err.message) || err) }));
  out.setup = { on: setup.status && setup.status.on, card: setup.card, runningBefore: setup.running, error: setup.error, ticked: setup.ticked };
  const keyed = setup.status && (setup.status.urls || []).find((u) => u.keyed);
  const key = keyed ? new URL(keyed.url).hash.replace("#k=", "") : "";
  const base = setup.status && setup.status.port ? `http://127.0.0.1:${setup.status.port}` : "";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const get = (p, k = key) => fetch(base + p, { headers: { "X-Key": k } });
  const post = (action, extra = {}) => fetch(base + "/api/command", { method: "POST", headers: { "X-Key": key, "Content-Type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
  const grid = () => js(`(() => ({
    orders: [...document.querySelectorAll("#multiCamGrid .multi-cam-tile")].map((el) => el.style.order),
    missing: document.getElementById("multiCamMissing").textContent,
    one: document.getElementById("multiCamGrid").classList.contains("one"),
    shapes: [...document.querySelectorAll("#multiCamGrid iframe")].map((f) => { const c = f.contentDocument.getElementById("stage"); return c.width > c.height ? "wide" : "tall"; }),
  }))()`);
  const state = async () => (await get("/api/state")).json();
  try {
    // The page and its script (nothing inline), as the apps show it too.
    const pageRes = await fetch(base + "/");
    out.page = (await pageRes.text()).includes('src="remote-client.js"') && /script-src 'self'/.test(pageRes.headers.get("content-security-policy") || "");
    const scriptRes = await fetch(base + "/remote-client.js");
    out.script = scriptRes.status === 200 && /javascript/.test(scriptRes.headers.get("content-type") || "") && (await scriptRes.text()).includes("rigRequest");
    out.noKey = (await get("/api/state", "")).status;
    out.wrongKey = (await get("/api/state", key.slice(0, -2) + "xx")).status;
    // A command only from the page itself: JSON, from its own address (not another website's form).
    const sneak = (headers) => fetch(base + "/api/command", { method: "POST", headers: { "X-Key": key, ...headers }, body: '{"action":"record"}' }).then((r) => r.status);
    out.textPlain = await sneak({ "Content-Type": "text/plain" });
    out.otherSite = await sneak({ "Content-Type": "application/json", Origin: "http://evil.example" });
    // The cameras it can start, before they do: both OAK cameras and the test webcam, and the
    // one picked in Several cameras that isn't plugged in any more.
    out.scan = (await (await post("scan")).json()).ok;
    let a = null;
    for (let i = 0; i < 100 && !(a && a.at && !a.scanning); i++) {
      await sleep(200);
      a = (await state()).available;
    }
    const before = await state();
    out.before = { running: before.running, mode: before.mode };
    out.available = a.cameras.map((c) => ({ id: c.id.startsWith("oak:") ? c.id : "webcam", present: c.present, use: c.use, role: c.role }));
    // Any camera can be picked: the webcam gets a free role (a wrist's), is given the other wrist, then left out again.
    const webcam = a.cameras.find((c) => !c.id.startsWith("oak:"));
    out.pickWebcam = (await (await post("pick", { pick: { id: webcam.id, use: true } })).json()).ok;
    const withWebcam = (await state()).available.cameras.find((c) => c.id === webcam.id);
    const otherWrist = withWebcam.role === "wrist_left" ? "wrist_right" : "wrist_left";
    await post("pick", { pick: { id: webcam.id, role: otherWrist } });
    out.webcam = { use: withWebcam.use, role: withWebcam.role, asked: otherWrist, given: (await state()).available.cameras.find((c) => c.id === webcam.id).role };
    await post("pick", { pick: { id: webcam.id, use: false } });
    out.webcamOut = !(await state()).available.cameras.find((c) => c.id === webcam.id).use;
    // Ego needs all four roles (only head and chest are picked): neither Start cameras nor
    // Start recording go. The take details come first; with them made optional (the page's
    // hidden switch), it's the mode that says what's missing. Stereo needs only a head camera.
    await post("mode", { mode: "ego" });
    const ego = await state();
    out.ego = { mode: ego.mode, need: ego.requirement, start: await (await post("cameras")).json() };
    out.egoRecord = await (await post("record")).json();
    out.optional = await (await post("settings", { settings: { detailsRequired: false } })).json();
    out.optionalState = (await state()).detailsRequired;
    out.egoRecordOptional = await (await post("record")).json();
    await post("settings", { settings: { detailsRequired: true } });
    await post("mode", { mode: "stereo" });
    const stereo = await state();
    out.stereo = { mode: stereo.mode, need: stereo.requirement, running: stereo.running };
    // Recording needs all three take details (nothing starts without them), then starts.
    out.refused = await (await post("record", { details: { contributor: "Sam Smith", location: " ", task: "" } })).json();
    await sleep(300);
    const refusedState = await state();
    out.refusedStarted = refusedState.running || refusedState.recording || !!refusedState.pending;
    out.details = await (await post("details", { details: { contributor: "Sam Smith", location: "Lab 2", task: "Pick up cup" } })).json();
    out.detailsKept = (await state()).details;
    out.record = await (await post("record")).json();
    let s = null;
    for (let i = 0; i < 150 && !(s && s.recording); i++) {
      await sleep(200);
      s = await state();
    }
    out.recording = { recording: s.recording, cameras: s.cameras.map((c) => ({ fps: c.fps, hands: c.hands.length, error: c.error, role: c.roleId, mirror: c.mirror, rotation: c.rotation })) };
    out.gridBefore = await grid();
    // The cameras' card is where the main view was (which is hidden meanwhile).
    out.inPlace = await js(`(() => { const card = document.getElementById("multiCamCard"), wrap = document.getElementById("wrap"); return { inPlace: card.classList.contains("in-place"), beforeView: card.nextElementSibling === wrap, viewShown: getComputedStyle(wrap).display !== "none" }; })()`);
    // The first camera to the right wrist's block; the second turned and flipped.
    out.moved = await (await post("camera", { camera: { index: 0, role: "wrist_right" } })).json();
    out.turned = await (await post("camera", { camera: { index: 1, rotation: 90, mirror: false } })).json();
    await sleep(600);
    const changed = await state();
    out.changed = changed.cameras.map((c) => ({ role: c.roleId, rotation: c.rotation, mirror: c.mirror }));
    out.gridAfter = await grid();
    out.badCamera = (await post("camera", { camera: { index: 7 } })).status;
    // Back as they were (so the take's hands are Head and Chest). The details can't be changed
    // while it records (the previews go on).
    await post("camera", { camera: { index: 0, role: "head" } });
    await post("camera", { camera: { index: 1, rotation: 0, mirror: true } });
    out.changedDetails = await (await post("details", { details: { contributor: "Sam Smith", location: "Lab 3", task: "" } })).json();
    const whileRecording = await state();
    out.lockedDetails = { locked: whileRecording.detailsLocked, details: whileRecording.details };
    let pic = null;
    for (let i = 0; i < 40 && !(pic && pic.status === 200); i++) {
      pic = await get("/api/preview?i=1");
      if (pic.status !== 200) await sleep(150);
    }
    const bytes = Buffer.from(await pic.arrayBuffer());
    out.preview = { status: pic.status, type: pic.headers.get("content-type"), jpeg: bytes[0] === 0xff && bytes[1] === 0xd8, kb: Math.round(bytes.length / 1024) };
    // One camera full screen: bigger, and more often (each request waits for its next picture).
    const jpegSize = (b) => {
      for (let k = 2; k < b.length - 9; ) {
        if (b[k] !== 0xff) { k++; continue; }
        if (b[k + 1] >= 0xc0 && b[k + 1] <= 0xc3) return { w: b.readUInt16BE(k + 7), h: b.readUInt16BE(k + 5) };
        k += 2 + b.readUInt16BE(k + 2);
      }
      return null;
    };
    const fulls = [];
    const fullFrom = Date.now();
    for (let n = 0; n < 15; n++) {
      const r = await get("/api/preview?i=1&full=1");
      if (r.status === 200) fulls.push(Buffer.from(await r.arrayBuffer()));
    }
    out.full = { frames: fulls.length, small: jpegSize(bytes), size: fulls.length ? jpegSize(fulls[fulls.length - 1]) : null, fps: Math.round((fulls.length * 1000) / (Date.now() - fullFrom)) };
    await sleep(1500);
    out.stop = await (await post("stop")).json();
    const after = await state();
    out.take = after.lastTake;
    const file = after.lastTake && after.lastTake.ok ? path.join(process.env.HAND_TRACKER_REMOTE_DIR, after.lastTake.files[0]) : null;
    const saved = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    out.savedHands = saved ? saved.hands.map((h) => h.handedness) : null;
    out.metadata = saved ? saved.metadata : null;
    // Its name is final at the computer too (other formats exported there keep it).
    out.nameLocked = await js(`document.getElementById("motionName").readOnly && document.getElementById("motionName").value`);
    // Saved: the next take's details can be filled in.
    out.unlocked = { locked: after.detailsLocked, cleared: (await (await post("details", { details: { contributor: "", location: "", task: "" } })).json()).ok };
    out.close = await (await post("close")).json();
    await sleep(300);
    out.closed = !(await state()).running;
    out.backAfterClose = await js(`(() => { const card = document.getElementById("multiCamCard"), wrap = document.getElementById("wrap"); return !card.classList.contains("in-place") && card.nextElementSibling !== wrap && getComputedStyle(wrap).display !== "none"; })()`);
    await post("mode", { mode: "freeform" });
    out.unknown = (await post("explode")).status;
  } catch (err) {
    out.error = String((err && err.message) || err);
  }
  out.off = await js(`(async () => {
    document.getElementById("remoteToggle").click();
    await new Promise((r) => setTimeout(r, 300));
    return !(await desktop.remote.status()).on;
  })()`).catch(() => false);
  out.refusedWhenOff = await fetch(base + "/").then(() => false, () => true);
  // Over Tailscale no key is needed, but only addressed to this computer by its own name.
  const { tailnetPeer, RemoteRecordServer } = require("../electron/remote-record.js");
  out.tailnet = [tailnetPeer("100.104.1.2", "::ffff:100.90.3.4"), tailnetPeer("192.168.1.5", "100.90.3.4"), tailnetPeer("100.104.1.2", "192.168.1.9")];
  const probe = new RemoteRecordServer({ keyStore: null, page: () => "", ask: async () => ({}) });
  out.ownHost = [probe.ownHost({ headers: { host: "localhost:47821" } }), probe.ownHost({ headers: { host: "evil.example:47821" } })];
  check("Remote recording: the phone's page needs the key (Tailscale peers don't, addressed by this computer's name; no other website's commands); the cameras it can start are listed first (any kind; a picked one that's unplugged says so) and picked, with roles; Ego needs all four roles, Stereo a head camera; Start recording needs all three take details (unless the hidden switch makes them optional; then locked until the take is saved), then starts the cameras picked that are plugged in (nothing runs before; OAK cameras mirrored like webcams; every camera found is ticked unless unticked before), in the main view's place; previews come through (one camera full screen bigger and more often), a role moves a camera to its block, turn and flip, the take details name the take (with its length) and are its metadata, Stop saves it by itself, Stop cameras stops them",
    out.setup.on && out.setup.card && !out.setup.runningBefore && key.length > 10 && out.page && out.noKey === 401 && out.wrongKey === 401 &&
      ["oak:SIMULATED-OAK-A", "oak:SIMULATED-OAK-B"].every((id) => (out.setup.ticked || []).includes(id)) &&
      out.before.running === false && out.script && out.scan &&
      out.available.filter((c) => c.id.startsWith("oak:SIMULATED-OAK-") && c.present && c.use).length === 2 &&
      out.available.some((c) => c.id === "oak:SIMULATED-OAK-UNPLUGGED" && !c.present && c.use) && out.available.some((c) => c.id === "webcam" && c.present && !c.use) &&
      out.pickWebcam && out.webcam.use && /^wrist_/.test(out.webcam.role) && out.webcam.given === out.webcam.asked && out.webcamOut &&
      out.ego.mode === "ego" && !out.ego.need.ok && out.ego.need.missing.join() === "wrist_left,wrist_right" && out.ego.start.ok === false &&
      /Ego needs the Left wrist and Right wrist cameras/.test(out.ego.start.message) && (out.egoRecord.missing || []).length === 3 &&
      out.optional.ok && out.optionalState === false && out.egoRecordOptional.ok === false && /Ego needs/.test(out.egoRecordOptional.message) &&
      out.stereo.mode === "stereo" && out.stereo.need.ok && !out.stereo.running &&
      out.inPlace.inPlace && out.inPlace.beforeView && !out.inPlace.viewShown && out.backAfterClose &&
      out.refused.ok === false && (out.refused.missing || []).join() === "location,task" && /Fill in Location and Task first/.test(out.refused.message) && out.refusedStarted === false &&
      out.record.ok && out.changedDetails.ok === false && out.changedDetails.locked && out.lockedDetails.locked === true &&
      out.lockedDetails.details.location === "Lab 2" && out.lockedDetails.details.task === "Pick up cup" && out.unlocked.locked === false && out.unlocked.cleared && /^Sam-Smith_Lab-2_Pick-up-cup_/.test(out.nameLocked) &&
      out.recording.recording && out.recording.cameras.length === 2 && out.recording.cameras.every((c) => c.fps > 0 && !c.error && c.mirror === true && c.rotation === 0) &&
      out.gridBefore.orders.join() === "0,1" && out.gridBefore.missing === "Not connected: Left wrist, Right wrist" && !out.gridBefore.one &&
      out.moved.ok && out.turned.ok && out.changed.map((c) => `${c.role}/${c.rotation}/${c.mirror}`).join() === "wrist_right/0/true,chest/90/false" &&
      out.gridAfter.orders.join() === "3,1" && out.gridAfter.missing === "Not connected: Head, Left wrist" && out.gridAfter.shapes.join() === "wide,tall" &&
      out.badCamera === 400 && out.details.ok && out.detailsKept.contributor === "Sam Smith" && out.detailsKept.task === "Pick up cup" &&
      out.preview.status === 200 && out.preview.type === "image/jpeg" && out.preview.jpeg && out.preview.kb > 1 &&
      out.full.frames >= 12 && out.full.size && out.full.small && out.full.size.w > out.full.small.w && out.full.fps >= 6 &&
      out.stop.ok && out.take && out.take.ok && /^Sam-Smith_Lab-2_Pick-up-cup_\d+s_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.json$/.test(out.take.files[0]) && out.take.hands === 2 &&
      out.metadata && out.metadata.contributor === "Sam Smith" && out.metadata.location === "Lab 2" && out.metadata.task === "Pick up cup" &&
      /^0:\d\d$/.test(out.metadata.length) && out.metadata.length_s > 1 &&
      out.savedHands && out.savedHands.length === 2 && out.savedHands.some((h) => /^Head /.test(h)) && out.savedHands.some((h) => /^Chest /.test(h)) &&
      out.close.ok && out.closed && out.unknown === 400 && out.off && out.refusedWhenOff && out.tailnet.join() === "true,false,false" &&
      out.textPlain === 403 && out.otherSite === 403 && out.ownHost.join() === "true,false",
    JSON.stringify(out));
}

// The website's Remote recording page (remote.html) from the app's header: a window of its own,
// whose Connect remembers the computer and opens its page in the browser (never in the app).
async function checkRemoteLauncher(js) {
  const opened = [];
  const realOpen = shell.openExternal;
  shell.openExternal = async (url) => {
    opened.push(url);
  };
  const before = new Set(BrowserWindow.getAllWindows().map((w) => w.id));
  const out = {};
  let port = 0;
  try {
    // This computer's own remote recording, reached the way another computer's would be: by
    // the address under its QR code (with its code).
    const s = await js(`(async () => {
      document.getElementById("remoteToggle").click();
      let s = null;
      for (let i = 0; i < 50 && !(s && s.on); i++) { await new Promise((r) => setTimeout(r, 100)); s = await desktop.remote.status(); }
      return s;
    })()`);
    port = s.port;
    const keyed = (s.urls || []).find((u) => u.keyed);
    const address = `http://127.0.0.1:${port}/${new URL(keyed.url).hash}`;
    out.link = await js(`(() => { const a = document.getElementById("remoteLink"); a.click(); return { shown: !a.hidden, target: a.target, text: a.textContent }; })()`);
    let win = null;
    for (let i = 0; i < 50 && !win; i++) {
      await sleep(100);
      win = BrowserWindow.getAllWindows().find((w) => !before.has(w.id));
    }
    if (win) {
      await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once("did-finish-load", r) : r()));
      const wjs = (code) => withLimit(win.webContents.executeJavaScript(code, true), "the Remote recording window");
      out.launcher = await wjs(`(() => {
        document.getElementById("host").value = "not a name!";
        document.querySelector("#connectForm button[type=submit]").click();
        return { error: document.getElementById("error").textContent, backHidden: document.getElementById("back").hidden, where: document.getElementById("whereNote").textContent };
      })()`);
      const loaded = new Promise((r) => win.webContents.once("did-finish-load", r));
      await wjs(`(() => { document.getElementById("host").value = ${JSON.stringify(address)}; document.querySelector("#connectForm button[type=submit]").click(); return true; })()`);
      await loaded;
      // The remote recording page, here in the app, reaching the computer through it.
      out.client = await wjs(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 150 && !(/Hand Tracker on/.test(document.getElementById("title").textContent) && document.querySelectorAll("#camRows .camrow").length); i++) await sleep(200);
        // Its takes: the one the remote recording check saved, into a folder (the checks pick the
        // output folder), then deleted from the computer.
        const rows = () => [...document.querySelectorAll("#takeRows .takerow")];
        for (let i = 0; i < 100 && !rows().length; i++) await sleep(100);
        const takeRows = rows().length;
        const first = rows()[0] && rows()[0].querySelector("input");
        let takes = { rows: takeRows };
        if (first) {
          first.click();
          document.getElementById("takesGet").click();
          for (let i = 0; i < 150 && !/on this device|Nothing came/.test(document.getElementById("takesNote").textContent); i++) await sleep(100);
          takes = { ...takes, id: first.dataset.id, note: document.getElementById("takesNote").textContent, del: !document.getElementById("takesDel").hidden };
          document.getElementById("takesDel").click();
          document.getElementById("takesDel").click();
          for (let i = 0; i < 100 && rows().length >= takeRows; i++) await sleep(100);
          takes.after = rows().length;
        }
        return {
          takes,
          path: location.pathname, rig: new URLSearchParams(location.search).get("rig"), hash: location.hash,
          title: document.getElementById("title").textContent, status: document.getElementById("status").textContent,
          cameras: document.querySelectorAll("#camRows .camrow").length, rows: [...document.querySelectorAll("#camRows .camrow label")].map((r) => r.textContent.trim()), modes: [...document.querySelectorAll("#modes button")].map((b) => b.textContent).join(),
          back: !document.getElementById("back").hidden, saved: JSON.parse(localStorage.getItem("hand-tracker-remote-computers") || "[]"),
          wifiHidden: document.getElementById("wifiPanel").hidden,
        };
      })()`);
      out.stillOpen = !win.isDestroyed() && win.webContents.getURL().replace(/[?#].*/, "");
      win.close();
    }
    out.mainPage = await js("location.pathname");
    await js(`(async () => { document.getElementById("remoteToggle").click(); await new Promise((r) => setTimeout(r, 300)); return true; })()`);
  } finally {
    shell.openExternal = realOpen;
  }
  out.browser = opened;
  const l = out.launcher || {}, c = out.client || {};
  const t = c.takes || {};
  const savedTake = t.id ? fs.readdirSync(outDir).filter((f) => f.startsWith(t.id)) : [];
  const leftTake = t.id ? fs.readdirSync(process.env.HAND_TRACKER_REMOTE_DIR).filter((f) => f.startsWith(t.id)) : ["?"];
  out.takeFiles = { saved: savedTake, left: leftTake };
  check("The Remote recording page (as on the website) opens from the header in a window of its own, and the computer's page opens right there (the app reaching it, its code from the pasted address): its cameras and modes, never a browser",
    out.link.shown && out.link.target === "_blank" && l.backHidden && /doesn't look like/.test(l.error) && /opens here/.test(l.where) &&
      c.path === "/remote-client.html" && c.rig === `127.0.0.1:${port}` && c.hash === "" && /^Hand Tracker on /.test(c.title) && /Cameras off/.test(c.status) &&
      c.cameras >= 2 && c.modes === "Ego,Stereo,Freeform" && c.back && c.saved[0] === (port === 47821 ? "127.0.0.1" : `127.0.0.1:${port}`) && c.wifiHidden &&
      out.stillOpen === "app://hand-tracker/remote-client.html" && out.mainPage === "/index.html" && opened.length === 0 &&
      t.rows >= 1 && /on this device/.test(t.note) && t.del && t.after === t.rows - 1 && savedTake.length >= 1 && leftTake.length === 0,
    JSON.stringify(out));
}

// The takes on a computer, from its remote recording page in a browser: listed (a take is
// its files: JSON, both BVHs…), ticked ("Select all"), and downloaded as one .zip, each file
// checked; only then does "Delete … from <computer>" show, and two taps delete them there.
// Hand Tracker deletes only a take whose every file came whole (by CRC32), and serves nothing
// that isn't a take in its folder.
async function checkRemoteTakes() {
  const { RemoteRecordServer, crc32 } = require("../electron/remote-record.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hand-tracker-check-takes-"));
  const big = Buffer.alloc(5 * 1024 * 1024 + 321); // more than one slice
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 255;
  const SAM = "Sam-Smith_Lab-2_Pick-up-cup_2s_2026-10-02_10-30-24", ANA = "Ana_Lab-1_Wave_1s_2026-10-02_11-00-00";
  fs.writeFileSync(path.join(dir, `${SAM}.json`), big);
  fs.writeFileSync(path.join(dir, `${SAM}-left.bvh`), "HIERARCHY left\n");
  fs.writeFileSync(path.join(dir, `${SAM}-right.bvh`), "HIERARCHY right\n");
  fs.writeFileSync(path.join(dir, `${ANA}.mcap`), Buffer.from([0x89, 0x4d, 0x43, 0x41, 0x50]));
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a take");
  fs.writeFileSync(path.join(path.dirname(dir), "outside.json"), "{}");
  const page = (name) => fs.readFileSync(path.join(__dirname, "..", name === "js" ? "remote-client.js" : "remote-client.html"), "utf8");
  const server = new RemoteRecordServer({ keyStore: null, page, ask: async () => ({ ok: true, message: "" }), host: "rig-test", hotspot: () => null, takes: () => dir });
  server.setState({
    kind: "rig", running: false, recording: false, mode: "freeform", requirement: { ok: true, missing: [], message: "" }, detailsRequired: true,
    details: { contributor: "", location: "", task: "" }, cameras: [], available: { at: 1, scanning: false, note: "", cameras: [] },
  });
  const { port } = await server.start();
  const base = `http://127.0.0.1:${port}`, H = { "X-Key": server.key };
  // (A test computer stopped just before used this port: Node may try its old connection once.)
  const fetch = async (url, opts) => {
    for (let i = 0; ; i++) {
      try {
        return await globalThis.fetch(url, opts);
      } catch (err) {
        if (i >= 2) throw err;
        await sleep(200);
      }
    }
  };
  const out = {};
  let win = null;
  try {
    // Nothing but a take in its folder; and a take isn't deleted without every file whole.
    out.outside = (await fetch(`${base}/api/take?f=${encodeURIComponent("../outside.json")}&at=0`, { headers: H })).status;
    out.notTake = (await fetch(`${base}/api/take?f=notes.txt&at=0`, { headers: H })).status;
    const wrong = await fetch(`${base}/api/command`, { method: "POST", headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "deleteTakes", takes: [{ id: ANA, files: [{ name: `${ANA}.mcap`, size: 5, crc: (crc32(fs.readFileSync(path.join(dir, `${ANA}.mcap`))) + 1) >>> 0 }] }] }) });
    out.wrongCrc = await wrong.json();
    // The page in a browser: the .zip lands in its downloads.
    win = new BrowserWindow({ show: false, width: 420, height: 900, webPreferences: { partition: "check-remote-takes" } });
    const downloads = [];
    win.webContents.session.on("will-download", (_event, item) => {
      const to = path.join(outDir, `downloaded-${item.getFilename()}`);
      item.setSavePath(to);
      item.once("done", (_e, state) => downloads.push({ to, state }));
    });
    await win.loadURL(`${base}/#k=${server.key}`);
    out.page = await withLimit(win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const $ = (id) => document.getElementById(id);
      const rows = () => [...document.querySelectorAll("#takeRows .takerow")];
      for (let i = 0; i < 100 && rows().length < 2; i++) await sleep(100);
      const listed = rows().map((r) => r.textContent.replace(/\\s+/g, " ").trim());
      const before = { title: $("takesTitle").textContent, del: !$("takesDel").hidden, get: $("takesGet").disabled };
      $("takesAll").click();
      const picked = $("takesGet").textContent;
      $("takesGet").click();
      for (let i = 0; i < 150 && !/on this device|Nothing came/.test($("takesNote").textContent); i++) await sleep(100);
      const after = { note: $("takesNote").textContent, del: !$("takesDel").hidden, delText: $("takesDel").textContent, ok: rows().filter((r) => /on this device/.test(r.textContent)).length };
      $("takesDel").click();
      const armed = $("takesDel").textContent;
      $("takesDel").click();
      for (let i = 0; i < 100 && rows().length; i++) await sleep(100);
      return { listed, before, picked, after, armed, end: { rows: rows().length, note: $("takesNote").textContent, empty: $("takeRows").textContent.trim() } };
    })()`, true), "the takes page");
    for (let i = 0; i < 50 && !downloads.length; i++) await sleep(100);
    out.download = downloads.map((d) => ({ name: path.basename(d.to), state: d.state }));
    // The .zip, read by Python's zipfile (every file's CRC checked), against the originals.
    const zipFile = downloads[0] && downloads[0].to;
    const read = zipFile ? spawnSync("python", ["-c", "import sys, zipfile, json; z = zipfile.ZipFile(sys.argv[1]); print(json.dumps({'bad': z.testzip(), 'files': {i.filename: i.file_size for i in z.infolist()}}))", zipFile], { encoding: "utf8" }) : null;
    out.zip = read && read.status === 0 ? JSON.parse(read.stdout) : { error: read ? read.stderr.slice(-200) : "no download" };
    out.left = fs.readdirSync(dir).sort();
  } catch (err) {
    out.error = String((err && err.stack) || err);
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    server.stop();
  }
  const p = out.page || {}, z = out.zip || {};
  check("Remote recording's takes: the page lists them (a take is its files), downloads the ticked ones (as one .zip in a browser, each file checked), and only then offers to delete them there (two taps); a take is deleted only if every file came whole, and nothing outside the folder is served",
    !out.error && out.outside === 404 && out.notTake === 404 && out.wrongCrc.ok === false && /intact/.test((out.wrongCrc.refused[0] || {}).why) &&
      p.listed.length === 2 && p.listed[0].startsWith(ANA) && /JSON/.test(p.listed[1]) && /BVH/.test(p.listed[1]) && p.before.title === "Takes on rig-test" && !p.before.del && p.before.get &&
      p.picked === "Download 2 takes" && /2 takes on this device/.test(p.after.note) && p.after.del && p.after.delText === "Delete 2 from rig-test" && p.after.ok === 2 &&
      p.armed === "Tap again to delete 2 from rig-test" && p.end.rows === 0 && /Deleted 2 from rig-test/.test(p.end.note) &&
      out.download.length === 1 && out.download[0].state === "completed" && z.bad === null && z.files[`${SAM}.json`] === big.length && z.files[`${ANA}.mcap`] === 5 && Object.keys(z.files).length === 4 &&
      out.left.join() === "notes.txt",
    JSON.stringify(out).slice(0, 2500));
}

// A phone on the computer's own hotspot needs no code, and there (as over Tailscale: both are
// encrypted) the page lists the Wi-Fi networks and has the computer join one; with only the
// code (the local network), the Wi-Fi can't be changed.
async function checkRemoteHotspotWifi() {
  const { RemoteRecordServer } = require("../electron/remote-record.js");
  const joined = [];
  const wifi = {
    available: () => true,
    status: () => ({ connecting: null, last: null }),
    list: async () => ({ device: "wlan0", current: { ssid: "Lab", signal: 70 }, networks: [{ ssid: "Lab", signal: 70, secure: true, saved: true, dfs: false }, { ssid: "Field", signal: 40, secure: true, saved: false, dfs: false }] }),
    connect: (ssid, password) => {
      joined.push([ssid, password]);
      return { ok: true, message: `Joining ${ssid}…` };
    },
  };
  const page = (name) => fs.readFileSync(path.join(__dirname, "..", name === "js" ? "remote-client.js" : "remote-client.html"), "utf8");
  const ask = async () => ({ ok: true, message: "" });
  const postTo = (base, body, key) => fetch(base + "/api/command", { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "X-Key": key } : {}) }, body: JSON.stringify(body) });
  const out = {};
  // This computer's hotspot, played by its loopback address; and a computer reached by its code.
  const hot = new RemoteRecordServer({ keyStore: null, page, ask, wifi, hotspot: () => "127.0.0.1" });
  const plain = new RemoteRecordServer({ keyStore: null, page, ask, wifi, hotspot: () => null });
  const hb = `http://127.0.0.1:${(await hot.start()).port}`;
  const pb = `http://127.0.0.1:${(await plain.start()).port}`;
  try {
    const st = await fetch(hb + "/api/state");
    out.hotspot = { status: st.status, wifi: st.status === 200 ? (await st.json()).wifi : null };
    out.list = (await (await fetch(hb + "/api/wifi")).json()).networks.map((n) => n.ssid);
    out.badPassword = (await postTo(hb, { action: "wifi", wifi: { ssid: "Field", password: "short" } })).status;
    out.join = await (await postTo(hb, { action: "wifi", wifi: { ssid: "Field", password: "long enough" } })).json();
    out.plainNoKey = (await fetch(pb + "/api/state")).status;
    out.plainWifi = (await (await fetch(pb + "/api/state", { headers: { "X-Key": plain.key } })).json()).wifi;
    out.plainList = (await fetch(pb + "/api/wifi", { headers: { "X-Key": plain.key } })).status;
    out.plainJoin = (await postTo(pb, { action: "wifi", wifi: { ssid: "Field", password: "long enough" } }, plain.key)).status;
  } catch (err) {
    out.error = String((err && err.message) || err);
  } finally {
    hot.stop();
    plain.stop();
  }
  out.joined = joined;
  check("Remote recording on the computer's own hotspot needs no code, and there (as over Tailscale) the page lists the Wi-Fi networks and has the computer join one; with only the code, the Wi-Fi can't be changed",
    !out.error && out.hotspot.status === 200 && out.hotspot.wifi && out.hotspot.wifi.allowed && out.list.join() === "Lab,Field" &&
      out.badPassword === 400 && out.join.ok && joined.length === 1 && joined[0].join() === "Field,long enough" &&
      out.plainNoKey === 401 && out.plainWifi === null && out.plainList === 403 && out.plainJoin === 403,
    JSON.stringify(out));
}

// An OAK camera that didn't start: its tile says why and has Try again, which starts it.
async function checkOakTileRetry(js) {
  const r = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const st = () => (MultiCamera._tiles()[0] || {}).status;
    const retry = () => document.querySelector("#multiCamGrid button.retry");
    await MultiCamera.start(["oak:SIMULATED-OAK-FAILS-ONCE"]);
    for (let i = 0; i < 100 && !(st() && st().error && retry() && !retry().hidden); i++) await sleep(100);
    const out = { error: st() && st().error, retryShown: !!retry() && !retry().hidden };
    if (retry()) retry().click();
    for (let i = 0; i < 100 && !(st() && st().fps > 0 && st().hands.length); i++) await sleep(100);
    await sleep(700); // the captions update every 0.5 s
    const s = st();
    out.after = s && { fps: s.fps, hands: s.hands, error: s.error };
    out.caption = document.querySelector("#multiCamGrid .st").textContent;
    out.retryHidden = !!retry() && retry().hidden;
    out.message = getComputedStyle(document.querySelector("#multiCamGrid iframe").contentDocument.getElementById("message")).display;
    MultiCamera.close();
    await sleep(300);
    return out;
  })()`).catch((err) => ({ error: String((err && err.message) || err) }));
  check("Several cameras: an OAK camera that didn't start says why and has Try again, which starts it (the others carry on)",
    /didn't start this time/.test(r.error || "") && r.retryShown &&
      r.after && r.after.fps > 0 && r.after.hands.length === 1 && !r.after.error && /fps/.test(r.caption) && r.retryHidden && r.message === "none",
    JSON.stringify(r));
}

// Live Rigs, against the stand-in capture-fleet dashboard (fleet-sim.js, which says what each rig does).
async function checkLiveRigs(js) {
  const sim = await fleetSim.startFleetSim({ ffmpegPath: exporter.ffmpegPath, outDir });
  const r = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const $ = (id) => document.getElementById(id);
    const until = async (test, ms = 10000) => { for (let t = 0; t < ms && !test(); t += 100) await sleep(100); return test(); };
    const pick = async (host, cam = "head") => {
      if ($("rigsDialog").hidden) $("rigsBtn").click();
      const sel = '#rigsList button[data-host="' + host + '"][data-cam="' + cam + '"]';
      await until(() => document.querySelector(sel));
      document.querySelector(sel).click();
    };
    const watching = () => { const c = HandTracker.getCamera(); return c.stream ? c.name + " " + c.width + "x" + c.height : "camera"; };
    const out = {};
    RigLive.setShown(true);
    $("rigsBtn").click();
    await until(() => !$("rigsSetup").hidden);
    $("rigsSite").value = ${JSON.stringify(sim.site)};
    $("rigsConnect").click();
    await until(() => !$("rigsSignIn").hidden);
    out.asksToSignIn = !$("rigsSignIn").hidden && $("rigsBrowse").hidden;
    $("rigsSignInBtn").click(); // the stand-in's sign-in page signs in by itself
    await until(() => document.querySelectorAll("#rigsList .rig-row").length > 0, 15000);
    out.rows = [...document.querySelectorAll("#rigsList .rig-row")].map((row) => row.querySelector("b").textContent + ":" + [...row.querySelectorAll("button.rig-cam")].map((b) => b.textContent + (b.disabled ? "(off)" : "")).join(","));
    $("rigsSide").value = "left";
    $("rigsSide").dispatchEvent(new Event("change"));
    // A stereo JPEG camera: one view, not mirrored.
    await pick("rig-a");
    await until(() => HandTracker.getCamera().stream && RigLive._state() && RigLive._state().frames >= 3, 10000);
    const cam = HandTracker.getCamera();
    out.stereo = { name: cam.name, size: cam.width + "x" + cam.height, mirrored: HandTracker.isMirrored(), state: RigLive._state(), list: $("cameraSelect").selectedOptions[0].textContent, dialogClosed: $("rigsDialog").hidden };
    $("rigsSide").value = "both";
    $("rigsSide").dispatchEvent(new Event("change"));
    await until(() => HandTracker.getCamera().width === 1280, 5000);
    out.both = HandTracker.getCamera().width + "x" + HandTracker.getCamera().height;
    $("rigsSide").value = "left";
    $("rigsSide").dispatchEvent(new Event("change"));
    // A stale camera can't be watched, and what was showing carries on.
    await pick("rig-e");
    await until(() => !$("rigsError").hidden, 8000);
    out.stale = { error: $("rigsError").textContent, still: watching() };
    // A camera with only keyframes: decoded, full size.
    await pick("rig-d");
    await until(() => RigLive._state() && RigLive._state().host === "rig-d" && RigLive._state().frames >= 2, 10000);
    out.keyframes = { watching: watching(), kind: RigLive._state() && RigLive._state().kind, frames: RigLive._state() && RigLive._state().frames };
    // A recording rig with its preview flag off can be watched too.
    await pick("rig-f");
    await until(() => RigLive._state() && RigLive._state().host === "rig-f" && RigLive._state().frames >= 2, 10000);
    out.recording = watching();
    await pick("rig-f"); // again: back to the camera
    await until(() => !HandTracker.getCamera().stream, 10000);
    // Lock onto a rig that starts recording: the one that started last (F, 5 s in); after you
    // leave it, that recording isn't locked onto again.
    if ($("rigsDialog").hidden) $("rigsBtn").click();
    $("rigsFollow").checked = true;
    $("rigsFollow").dispatchEvent(new Event("change"));
    await until(() => RigLive._state() && RigLive._state().locked && /locked on/.test($("sourceNote").textContent), 10000);
    out.locked = RigLive._state() && { host: RigLive._state().host, camera: RigLive._state().camera, locked: RigLive._state().locked, note: $("sourceNote").textContent.includes(", recording (locked on),") };
    await pick("rig-f"); // leave it
    await until(() => !RigLive.isActive() || RigLive._state().host !== "rig-f", 5000);
    await RigLive._followTick();
    await until(() => RigLive.isActive(), 5000);
    out.afterLeaving = RigLive._state() && RigLive._state().host;
    $("rigsFollow").checked = false;
    $("rigsFollow").dispatchEvent(new Event("change"));
    RigLive.stop();
    await until(() => !HandTracker.getCamera().stream && HandTracker.getCamera().width > 0, 10000);
    out.back = { stream: HandTracker.getCamera().stream, active: RigLive.isActive(), width: HandTracker.getCamera().width };
    if ($("rigsDialog").hidden) $("rigsBtn").click();
    await until(() => !$("rigsSignOut").hidden);
    $("rigsSignOut").click();
    await until(() => !$("rigsSignIn").hidden);
    out.signedOut = !$("rigsSignIn").hidden;
    $("rigsClose").click();
    RigLive.setShown(false);
    return out;
  })()`).catch((err) => ({ error: String((err && err.message) || err) }));
  const servedAtEnd = sim.served();
  await new Promise((res) => setTimeout(res, 1500));
  const servedAfter = sim.served() - servedAtEnd;
  sim.stop();
  const st = r.stereo || {};
  check("Live Rigs: signs in on the dashboard's own page and lists rigs (recording first; ones without a preview can't be picked); a stereo camera's JPEGs are tracked as the source (one view, not mirrored)",
    r.asksToSignIn && JSON.stringify(r.rows) === JSON.stringify(["Rig A:head", "Rig F:head,chest", "Rig D:head", "Rig E:head", "Rig B:chest(off)", "Rig C:"]) &&
      st.name === "Rig A · head" && st.size === "640x400" && st.mirrored === false && st.state && st.state.stereo && st.state.kind === "jpeg" && /Live: Rig A/.test(st.list) && st.dialogClosed && r.both === "1280x400",
    JSON.stringify({ rows: r.rows, stereo: st, both: r.both, error: r.error }));
  check("Live Rigs: a camera with only H.264 keyframes is decoded at full size; a stale camera says so and what was showing carries on; a recording rig can be watched even with its preview flag off",
    r.keyframes && r.keyframes.kind === "keyframe" && r.keyframes.watching === "Rig D · head 640x360" && r.keyframes.frames >= 2 &&
      r.stale && /isn't sending new pictures \(its latest is 13 days old\)/.test(r.stale.error) && /^Rig A · head/.test(r.stale.still) && r.recording === "Rig F · head 640x360",
    JSON.stringify({ keyframes: r.keyframes, stale: r.stale, recording: r.recording }));
  check("Live Rigs: locks onto the rig that started recording last and says so; a recording you leave isn't locked onto again; back to the camera, nothing more is asked for, and nothing on the dashboard is changed",
    r.locked && r.locked.host === "rig-f" && r.locked.camera === "head" && r.locked.locked && r.locked.note && r.afterLeaving === "rig-a" &&
      r.back && !r.back.stream && !r.back.active && r.back.width > 0 && r.signedOut && servedAfter === 0 && sim.writes.length === 0,
    JSON.stringify({ locked: r.locked, afterLeaving: r.afterLeaving, back: r.back, signedOut: r.signedOut, servedAfter, writes: sim.writes }));
}

// Test videos made with the bundled ffmpeg: [file name, ffmpeg output options].
const TEST_VIDEOS = [
  ["h264.mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p"]],
  ["vp9.webm", ["-c:v", "libvpx-vp9", "-b:v", "1M"]],
  ["h264.mkv", ["-c:v", "libx264", "-pix_fmt", "yuv420p"]],
  ["mpeg4.avi", ["-c:v", "mpeg4", "-q:v", "4"]],
  ["mpeg2.mpg", ["-c:v", "mpeg2video", "-q:v", "4"]],
  ["wmv2.wmv", ["-c:v", "wmv2", "-q:v", "4"]],
  ["flv1.flv", ["-c:v", "flv1", "-q:v", "4"]],
  ["theora.ogv", ["-c:v", "libtheora", "-q:v", "6"]],
  ["h264.ts", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mpegts"]],
  ["prores.mov", ["-c:v", "prores_ks", "-profile:v", "0"]],
  // Formats known by other names: a GoPro low-res preview (MP4 inside), a camcorder's
  // MPEG-2 .mod, a Windows Media Center recording and RealVideo.
  ["gopro.lrv", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mp4"]],
  ["camcorder.mod", ["-c:v", "mpeg2video", "-q:v", "4", "-f", "vob"]],
  ["media-center.wtv", ["-c:v", "mpeg2video", "-q:v", "4", "-f", "wtv"]],
  ["realvideo.rm", ["-c:v", "rv20", "-q:v", "4"]],
];

// Adds metadata keys to an MP4/MOV the way phones write them: a QuickTime "meta" box
// (hdlr "mdta", keys, ilst) at the end of moov, which must be the file's last box.
function withPhoneMetadata(src, dst, keys) {
  const buf = fs.readFileSync(src);
  let moov = -1;
  for (let pos = 0; pos + 8 <= buf.length; pos += buf.readUInt32BE(pos)) {
    if (buf.toString("latin1", pos + 4, pos + 8) === "moov") moov = pos;
  }
  if (moov < 0 || moov + buf.readUInt32BE(moov) !== buf.length) throw new Error(`${src}: moov isn't the last box`);
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
  const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), typeof type === "number" ? u32(type) : Buffer.from(type, "latin1"), body]); };
  const names = Object.keys(keys);
  const meta = box("meta",
    box("hdlr", u32(0), u32(0), Buffer.from("mdta"), Buffer.alloc(12), Buffer.from([0])),
    box("keys", u32(0), u32(names.length), ...names.map((k) => Buffer.concat([u32(k.length + 8), Buffer.from("mdta"), Buffer.from(k)]))),
    box("ilst", ...names.map((k, i) => box(i + 1, box("data", u32(1), u32(0), Buffer.from(keys[k]))))));
  const out = Buffer.concat([buf, meta]);
  out.writeUInt32BE(buf.readUInt32BE(moov) + meta.length, moov);
  fs.writeFileSync(dst, out);
}

async function checkVideoFiles(win, js) {
  const dir = path.join(outDir, "videos");
  fs.mkdirSync(dir, { recursive: true });
  // A second each (they play in real time), but the last two: the recording check below plays it again.
  const last = TEST_VIDEOS[TEST_VIDEOS.length - 1][0];
  const seconds = (name) => (name === last ? 2 : 1);
  for (const [name, opts] of TEST_VIDEOS) {
    spawnSync(exporter.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", String(seconds(name)), ...opts, path.join(dir, name)]);
  }
  // Opens a file the way the Open Video button does; returns what was tracked.
  const open = (file) => js(`(async () => {
    window.__videoFrames = [];
    if (!window.__videoHook) {
      window.__videoHook = true;
      HandTracker.onHandLandmarks(({ timestamp }) => { if (HandTracker.getSource() === "file") window.__videoFrames.push(timestamp); });
    }
    const bytes = Uint8Array.from(atob(${JSON.stringify(fs.readFileSync(file).toString("base64"))}), (c) => c.charCodeAt(0));
    const ok = await HandTrackerApp.openVideo(${JSON.stringify(path.basename(file))}, URL.createObjectURL(new Blob([bytes])), ${JSON.stringify(file)});
    if (!ok) return { ok, note: document.getElementById("sourceNote").textContent };
    const v = document.getElementById("video");
    for (let i = 0; i < 300 && !v.ended; i++) await new Promise((r) => setTimeout(r, 100));
    const f = window.__videoFrames;
    return { ok, converted: v.currentSrc.startsWith("app:"), frames: f.length, last: f[f.length - 1], ordered: f.every((t, i) => i === 0 || t > f[i - 1]), fps: HandTracker.file.fps(), mirrored: HandTracker.isMirrored() };
  })()`);

  const summary = [];
  let allGood = true;
  for (const [name] of TEST_VIDEOS) {
    const r = await open(path.join(dir, name));
    // Every frame, the last one at its own time (frame 29 at 966.7 ms, or 59 at 1966.7).
    const frames = seconds(name) * 30;
    const good = r.ok && r.frames === frames && r.ordered && Math.abs(r.last - ((frames - 1) * 1000) / 30) < 5 && Math.abs(r.fps - 30) < 0.1 && !r.mirrored;
    allGood = allGood && good;
    summary.push(r.ok ? `${name} ${r.converted ? "converted" : "native"} ${r.frames}f${r.mirrored ? " MIRRORED" : ""}` : `${name} FAILED ${r.note}`);
  }
  check(`${TEST_VIDEOS.length} video formats open (not mirrored) and every frame is tracked in order`, allGood, summary.join(", "));

  // Video recorded while tracking a file is re-timed to the source on export.
  const rec = await js(`(async () => {
    const v = document.getElementById("video");
    document.getElementById("layoutSelect").value = "camera";
    HandTracker.file.pause();
    HandTracker.file.seek(0);
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById("videoBtn").click();
    HandTracker.file.play();
    for (let i = 0; i < 300 && !v.ended; i++) await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 50 && document.getElementById("exportCard").hidden; i++) await new Promise((r) => setTimeout(r, 100));
    const info = document.getElementById("clipInfo").textContent;
    document.querySelectorAll("#formatGrid input").forEach((i) => { i.checked = i.value === "mp4"; });
    document.getElementById("exportName").value = "from-video-file";
    document.getElementById("exportBtn").click();
    for (let i = 0; i < 200 && !document.querySelector("#exportResults li"); i++) await new Promise((r) => setTimeout(r, 150));
    return { info, saved: document.querySelectorAll("#exportResults li.ok").length };
  })()`);
  const outMp4 = path.join(outDir, "from-video-file.mp4");
  const probe = fs.existsSync(outMp4) ? spawnSync(exporter.ffmpegPath, ["-hide_banner", "-i", outMp4, "-f", "null", "-"], { encoding: "utf8" }) : { stderr: "" };
  const dur = /Duration: 00:00:(\d+\.\d+)/.exec(probe.stderr);
  const frames = /frame=\s*(\d+)/g, counts = [...probe.stderr.matchAll(frames)];
  const outFrames = counts.length ? Number(counts[counts.length - 1][1]) : 0;
  check("Video recorded from a file exports at the source's real speed", rec.saved === 1 && dur && Math.abs(Number(dur[1]) - 2) < 0.15 && Math.abs(outFrames - 60) <= 2,
    `${rec.info}; exported ${dur ? dur[1] : "?"} s, ${outFrames} frames`);

  // Motion capture over the whole video (these test videos have no hands, so nothing is captured).
  const cap = await js(`(async () => {
    document.getElementById("vidCapture").click();
    const v = document.getElementById("video");
    await new Promise((r) => setTimeout(r, 300));
    const started = RobotMotion.isRecording();
    for (let i = 0; i < 300 && !v.ended; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
    return { started, stillRecording: RobotMotion.isRecording(), status: document.getElementById("motionStatus").textContent };
  })()`);
  check("Capture Whole Video runs from the start and stops at the end", cap.started && !cap.stillRecording && /No frames captured/.test(cap.status), JSON.stringify(cap));

  // A video recorded mirrored (a selfie video saved as previewed): with Mirrored video on,
  // MediaPipe gets each frame flipped back and the picture shows it that way. Measured as
  // how far the tracked picture and the stage are from the video's frame drawn as it is
  // and drawn flipped (mean difference per colour channel, 0-255).
  await js(`window.__mirrorState = () => {
    const v = document.getElementById("video");
    const w = 160, h = 90;
    const grab = (draw) => {
      const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
      const x = c.getContext("2d");
      draw(x);
      return x.getImageData(0, 0, w, h).data;
    };
    const plain = grab((x) => x.drawImage(v, 0, 0, w, h));
    const flipped = grab((x) => { x.translate(w, 0); x.scale(-1, 1); x.drawImage(v, 0, 0, w, h); });
    const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) if (i % 4 !== 3) s += Math.abs(a[i] - b[i]); return Math.round(s / (a.length * 0.75)); };
    const from = (image) => { const got = grab((x) => x.drawImage(image, 0, 0, w, h)); return { plain: diff(got, plain), flipped: diff(got, flipped) }; };
    return {
      button: document.getElementById("vidMirrored").textContent.trim(),
      on: HandTracker.isFileMirrored(),
      tracked: from(HandTracker.getFrameImage()),
      stage: from(document.getElementById("stage")),
      frames: window.__videoFrames.length,
      saved: JSON.parse(localStorage.getItem("hand-tracker:prefs")).mirroredVideos || {},
      note: document.getElementById("sourceNote").hidden ? "" : document.getElementById("sourceNote").textContent,
    };
  }; true`);
  const mirrorState = () => js("window.__mirrorState()");
  const clickMirrored = () => js(`(async () => {
    document.getElementById("vidMirrored").click();
    await new Promise((r) => setTimeout(r, 500)); // the paused frame is tracked again
    return true;
  })()`);
  const asIs = (s) => s.tracked.plain <= 2 && s.stage.plain <= 2 && s.tracked.flipped >= 20 && s.stage.flipped >= 20;
  const flippedBack = (s) => s.tracked.flipped <= 2 && s.stage.flipped <= 2 && s.tracked.plain >= 20 && s.stage.plain >= 20;
  await open(path.join(dir, "h264.mp4"));
  const before = await mirrorState();
  await clickMirrored();
  const turnedOn = await mirrorState();
  await open(path.join(dir, "vp9.webm"));
  const other = await mirrorState();
  await open(path.join(dir, "h264.mp4"));
  const reopened = await mirrorState();
  await clickMirrored();
  const turnedOff = await mirrorState();
  check("Mirrored video: the picture is flipped back before tracking and shown that way",
    before.button === "Mirrored video: OFF" && !before.on && asIs(before) &&
      turnedOn.button === "Mirrored video: ON" && turnedOn.on && flippedBack(turnedOn) && turnedOn.frames === before.frames + 1,
    JSON.stringify({ before, turnedOn }));
  check("Mirrored video is remembered for that video only",
    !other.on && other.button === "Mirrored video: OFF" && asIs(other) &&
      reopened.on && reopened.button === "Mirrored video: ON" && flippedBack(reopened) && reopened.saved["h264.mp4"] === true &&
      !turnedOff.on && asIs(turnedOff) && turnedOff.saved["h264.mp4"] === false,
    JSON.stringify({ other, reopened, turnedOff }));

  // Phone videos: Android saves front-camera videos mirrored, so they open flipped back
  // unless their rotation says back camera (upright, the front camera's video is turned
  // 270°, the back one's 90°); iPhones don't mirror them. Made like the phones make them:
  // Android's metadata keys in moov/meta, and the rotation in the video track's matrix.
  const h264 = path.join(dir, "h264.mp4");
  const phoneVideos = {
    "android-front.mp4": { rotation: 90, keys: { "com.android.version": "14" }, mirrored: true }, // ffmpeg's rotation is anticlockwise
    "android-back.mp4": { rotation: 270, keys: { "com.android.version": "14" }, mirrored: false },
    "android-sideways.mp4": { keys: { "com.android.version": "14" }, mirrored: true },
    "iphone.mov": { keys: { "com.apple.quicktime.make": "Apple", "com.apple.quicktime.model": "iPhone 15" }, mirrored: false },
    "h264.mp4": { mirrored: false },
  };
  for (const [name, spec] of Object.entries(phoneVideos)) {
    if (!spec.keys) continue;
    const rotated = path.join(dir, `rotated-${name}`);
    spawnSync(exporter.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...(spec.rotation ? ["-display_rotation", String(spec.rotation)] : []), "-i", h264, "-c", "copy", rotated]);
    withPhoneMetadata(rotated, path.join(dir, name), spec.keys);
  }
  const origins = await js(`(async () => {
    const out = {};
    for (const [name, b64] of Object.entries(${JSON.stringify(Object.fromEntries(Object.keys(phoneVideos).map((n) => [n, fs.readFileSync(path.join(dir, n)).toString("base64")])))})) {
      const origin = await VideoOrigin.read(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]));
      out[name] = { ...origin, mirrored: VideoOrigin.mirroredByDefault(origin).mirrored };
    }
    return out;
  })()`);
  check("Phone videos: Android front camera (or held sideways) mirrored, back camera and iPhone not",
    Object.entries(phoneVideos).every(([name, spec]) => origins[name] && origins[name].mirrored === spec.mirrored) &&
      origins["android-front.mp4"].camera === "front" && origins["android-back.mp4"].camera === "back" && origins["iphone.mov"].phone === "iphone",
    JSON.stringify(origins));

  await open(path.join(dir, "android-sideways.mp4"));
  const phoneDefault = await mirrorState();
  await clickMirrored();
  await open(path.join(dir, "android-sideways.mp4"));
  const phoneChosen = await mirrorState();
  check("An Android video opens flipped back, saying why; turning it off is remembered",
    phoneDefault.on && phoneDefault.button === "Mirrored video: ON" && flippedBack(phoneDefault) && /Android phone/.test(phoneDefault.note) &&
      !phoneChosen.on && asIs(phoneChosen) && !phoneChosen.note && phoneChosen.saved["android-sideways.mp4"] === false,
    JSON.stringify({ phoneDefault, phoneChosen }));

  await js("HandTrackerApp.backToCamera()");
  let camera = "";
  for (let i = 0; i < 20 && !/^camera [1-9]/.test(camera); i++) {
    await sleep(500);
    camera = await js("HandTracker.getSource() + ' ' + HandTracker.getCamera().width");
  }
  check("Use Camera returns to the live camera", /^camera [1-9]/.test(camera), camera);
}

// Picks files in a page's file input as if chosen in its file picker (real files, with
// their paths on disk), which fires its change event.
async function pickFiles(wc, selector, files) {
  if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
  const { root } = await wc.debugger.sendCommand("DOM.getDocument", { depth: 0 });
  const { nodeId } = await wc.debugger.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector });
  await wc.debugger.sendCommand("DOM.setFileInputFiles", { nodeId, files });
}

// First frame of a video (or the frame at `at` seconds), 64x36 grey.
function frameAt(file, at = 0) {
  const r = spawnSync(exporter.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", "scale=64:36", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 20 });
  return r.stdout || Buffer.alloc(0);
}
const frameDiff = (a, b) => (a.length && a.length === b.length ? a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length : Infinity);
function videoSeconds(file) {
  const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(spawnSync(exporter.ffmpegPath, ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

// Several videos opened at once: tracked in turn, then synced from the hand movement.
// Two cameras of one rig (the second started 1.5 s later, further away) line up; a video
// of something else doesn't, and goes to the motion capture queue and the Recording
// Viewer's export queue instead. Hands are simulated (rigSimulation), keyed to each
// video's own clock.
async function checkSeveralVideos(win, js) {
  const wc = win.webContents;
  const dir = path.join(outDir, "rig");
  fs.mkdirSync(dir, { recursive: true });
  const video = (name) => path.join(dir, name);
  for (const name of ["cam-a.mp4", "cam-b.mp4", "other.mp4"]) {
    spawnSync(exporter.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", video(name)]);
  }
  await js(rigSimulation({ "cam-a.mp4": { seed: 11, start: 0, view: 0 }, "cam-b.mp4": { seed: 11, start: 1.5, view: 1 }, "other.mp4": { seed: 97, start: 0, view: 0 } }));
  const state = `({
    message: document.getElementById("multiMessage").hidden ? "" : document.getElementById("multiMessage").textContent,
    ok: document.getElementById("multiMessage").classList.contains("ok"),
    synced: !document.getElementById("multiSynced").hidden,
    failed: !document.getElementById("multiFailed").hidden,
    rows: [...document.querySelectorAll("#multiRows tr")].map((tr) => [...tr.cells].map((c) => c.textContent)),
    note: document.getElementById("multiNote").textContent,
    running: MultiVideo.isRunning(),
  })`;
  const syncVideos = async (names) => {
    await pickFiles(wc, "#videoFileInput", names.map(video));
    for (let i = 0; i < 240; i++) {
      await sleep(500);
      const s = await js(state);
      if (s.message && !s.running) return s;
    }
    return js(state);
  };
  const viewerWin = new BrowserWindow({
    show: false, width: 920, height: 1600,
    webPreferences: { preload: path.join(__dirname, "..", "electron", "preload.js"), sandbox: true, contextIsolation: true },
  });
  await viewerWin.loadURL("app://hand-tracker/viewer.html");
  const viewer = (code) => viewerWin.webContents.executeJavaScript(code, true);
  const viewerQueue = `({
    shown: !document.getElementById("queueCard").hidden,
    items: [...document.querySelectorAll("#queueList li")].map((li) => li.textContent),
    note: document.getElementById("queueNote").textContent,
  })`;
  const viewerHas = async (n) => {
    for (let i = 0; i < 40; i++) {
      const q = await viewer(viewerQueue);
      if (q.items.filter((t) => /Remove$/.test(t)).length === n) return q;
      await sleep(250);
    }
    return viewer(viewerQueue);
  };

  // Two cameras of the same moment.
  const rig = await syncVideos(["cam-a.mp4", "cam-b.mp4"]);
  // Columns: video, role, length, tracked, lines up.
  const offsetOf = (s, name) => {
    const row = s.rows.find((r) => r[0] === name);
    if (!row) return NaN;
    if (row[4] === "reference") return 0;
    const m = /([+−])(\d+\.\d+) s/.exec(row[4]);
    return m ? (m[1] === "−" ? -1 : 1) * Number(m[2]) : NaN;
  };
  const lag = offsetOf(rig, "cam-b.mp4") - offsetOf(rig, "cam-a.mp4");
  check("Two videos of one moment are tracked and synced from the hand movement (the second camera started 1.5 s later)",
    rig.ok && rig.synced && !rig.failed && /^Synced/.test(rig.message) && Math.abs(lag - 1.5) <= 0.05 && rig.rows.every((r) => /Right/.test(r[3])),
    `${rig.message} | ${rig.rows.map((r) => r.join(" / ")).join(" | ")}`);

  // Roles: given in order (the names don't say), and the second camera's changed to the right wrist.
  const rolesGiven = await js(`(() => {
    const sel = document.querySelectorAll("#multiRows select.role");
    const before = [...sel].map((s) => s.value);
    sel[1].value = "wrist_right";
    sel[1].dispatchEvent(new Event("change", { bubbles: true }));
    return { before, after: [...document.querySelectorAll("#multiRows select.role")].map((s) => s.value) };
  })()`);
  await js(`document.getElementById("multiName").value = "rig"; document.getElementById("multiSaveBtn").click(); true`);
  for (let i = 0; i < 40 && (await js(`document.querySelectorAll("#multiResults li").length`)) < 3; i++) await sleep(250);
  const load = (name) => (fs.existsSync(path.join(outDir, name)) ? JSON.parse(fs.readFileSync(path.join(outDir, name), "utf8")) : null);
  const a = load("rig-head.json"), b = load("rig-wrist_right.json"), report = load("rig-sync.json");
  check("Several videos: each has a role (given in order, or picked); the synced files are named after it and say it, as does the report",
    rolesGiven.before.join() === "head,chest" && rolesGiven.after.join() === "head,wrist_right" && a && b && a.camera_role === "head" && b.camera_role === "wrist_right" &&
      report && report.videos.map((v) => v.role).join() === "head,wrist_right",
    JSON.stringify({ rolesGiven, files: fs.readdirSync(outDir).filter((f) => f.startsWith("rig")), roles: [a && a.camera_role, b && b.camera_role], report: report && report.videos }));
  // On the shared clock, both cameras' wrists are in the same place at the same time (the
  // second camera's view mapped back: x = 0.2 + 0.7 x, y = 0.2 + 0.7 y); half a second
  // apart, they aren't.
  const apart = (shift) => {
    const wa = a.hands[0].trajectories.end_effector, wb = b.hands[0].trajectories.end_effector, d = [];
    for (const [t, x, y] of wa) {
      const k = wb.findIndex((p) => p[0] >= t + shift);
      if (k <= 0) continue;
      const [t0, x0, y0] = wb[k - 1], [t1, x1, y1] = wb[k], u = (t + shift - t0) / (t1 - t0 || 1);
      d.push(Math.hypot((x0 + (x1 - x0) * u - 0.2) / 0.7 - x, (y0 + (y1 - y0) * u - 0.2) / 0.7 - y));
    }
    return { n: d.length, mean: d.reduce((sum, v) => sum + v, 0) / (d.length || 1) };
  };
  const same = a && b ? apart(0) : { n: 0, mean: Infinity }, shifted = a && b ? apart(0.5) : { n: 0, mean: 0 };
  const length = report && report.length_s;
  check("Synced motion capture: each video's on one shared clock, trimmed to the stretch both cover, with a -sync.json report",
    a && b && report && Math.abs(length - 6.5) < 0.1 && Math.abs(a.duration - b.duration) < 0.05 && a.hands[0].frames[0].t < 0.25 && b.hands[0].frames[0].t < 0.25 &&
      same.n > 100 && same.mean < 0.01 && shifted.mean > same.mean * 5 && report.videos.length === 2,
    a && b && report ? `${length} s shared; wrists ${same.mean.toFixed(4)} of the picture apart on average (${shifted.mean.toFixed(4)} half a second off), ${same.n} compared; trim starts ${report.videos.map((v) => `${v.name} ${v.trim_start_s}`).join(", ")}` : fs.readdirSync(outDir).filter((f) => f.startsWith("rig")).join(" "));

  const viewerBefore = await viewer(viewerQueue);
  await js(`document.getElementById("multiViewerBtn").click(); true`);
  const syncedQueued = await viewerHas(2);
  check("Synced videos go to the Recording Viewer's queue, trimmed to the shared stretch (an open viewer shows them at once)",
    !viewerBefore.shown && syncedQueued.shown && syncedQueued.items.length === 2 && syncedQueued.items.every((t) => /synced: 0:0\d\.\d\d for 0:06\.[45]\d/.test(t)),
    JSON.stringify({ viewerBefore, syncedQueued }));

  // A video of something else doesn't line up.
  const other = await syncVideos(["cam-a.mp4", "other.mp4"]);
  check("Videos whose hand movement doesn't match aren't synced: an error says the motion capture doesn't line up, and why",
    !other.ok && other.failed && !other.synced && /^The motion capture data doesn't line up/.test(other.message) && /other\.mp4|cam-a\.mp4/.test(other.message),
    other.message);

  // ...so each goes to the motion capture queue (tracked already), plus one more video
  // added to the queue on its own (tracked when the queue runs).
  await js(`document.getElementById("multiQueueBtn").click(); true`);
  await pickFiles(wc, "#queueFileInput", [video("cam-b.mp4")]);
  const queued = await js(`[...document.querySelectorAll("#queueRows li")].map((li) => li.textContent)`);
  await js(`document.getElementById("queueRunBtn").click(); true`);
  let ran = null;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    ran = await js(`({ running: MultiVideo.isRunning(), note: document.getElementById("queueNote").textContent, rows: [...document.querySelectorAll("#queueRows li")].map((li) => li.className + " " + li.textContent) })`);
    if (!ran.running && ran.note) break;
  }
  const motions = ["cam-a", "other", "cam-b"].map((n) => load(`${n}-motion.json`));
  check("The motion capture queue saves each video's motion capture on its own (tracking the ones not tracked yet)",
    queued.length === 3 && /waiting to be tracked/.test(queued[2]) && ran.rows.every((r) => /^ok /.test(r)) && /Saved 3 files/.test(ran.note) &&
      motions.every((m) => m && m.hands.length === 1 && m.hands[0].frames.length > 200),
    JSON.stringify({ queued, ran, frames: motions.map((m) => m && m.hands[0] && m.hands[0].frames.length) }));

  // ...and to the Recording Viewer's queue, each converted on its own.
  await js(`document.getElementById("multiViewerQueueBtn").click(); true`);
  const allQueued = await viewerHas(4);
  const converted = await viewer(`(async () => {
    document.querySelectorAll("#queueGrid input").forEach((i) => { i.checked = i.value === "mp4"; });
    document.getElementById("queueConvertBtn").click();
    for (let i = 0; i < 600 && !/^Converted/.test(document.getElementById("queueNote").textContent); i++) await new Promise((r) => setTimeout(r, 250));
    return ${viewerQueue};
  })()`);
  const out = (name) => path.join(outDir, name);
  const seconds = Object.fromEntries(["cam-a-synced.mp4", "cam-b-synced.mp4", "cam-a.mp4", "other.mp4"].map((n) => [n, fs.existsSync(out(n)) ? videoSeconds(out(n)) : 0]));
  // Each synced video starts where the shared stretch starts in it.
  const starts = report ? Object.fromEntries(report.videos.map((v) => [v.name, v.trim_start_s])) : {};
  const firstA = frameAt(out("cam-a-synced.mp4")), firstB = frameAt(out("cam-b-synced.mp4"));
  const startsRight = [[firstA, "cam-a.mp4"], [firstB, "cam-b.mp4"]].every(([first, name]) => {
    const at = starts[name];
    const here = frameDiff(first, frameAt(video(name), at)), before = frameDiff(first, frameAt(video(name), Math.max(0, at - 0.5))), after = frameDiff(first, frameAt(video(name), at + 0.5));
    return here < 2 && (at < 0.5 || here < before) && here < after;
  });
  check("The Recording Viewer converts its queue one video after another: synced ones trimmed to the shared stretch, the others whole; done ones leave the queue",
    allQueued.items.length === 4 && /^Converted 4 of 4 videos; saved 4 files/.test(converted.note) && !converted.items.some((t) => /Remove$/.test(t)) &&
      Math.abs(seconds["cam-a-synced.mp4"] - length) < 0.1 && Math.abs(seconds["cam-b-synced.mp4"] - length) < 0.1 && Math.abs(seconds["cam-a.mp4"] - 8) < 0.1 && Math.abs(seconds["other.mp4"] - 8) < 0.1 && startsRight,
    JSON.stringify({ note: converted.note, seconds, starts, startsRight }));

  // Several videos chosen in the viewer itself go into its queue.
  await pickFiles(viewerWin.webContents, "#videoInput", [video("cam-a.mp4"), video("other.mp4")]);
  const picked = await viewerHas(2);
  await viewer(`document.getElementById("queueClearBtn").click(); true`);
  const cleared = await viewerHas(0);
  check("Several videos chosen in the Recording Viewer go into its export queue; Clear empties it",
    picked.items.length === 2 && picked.items.every((t) => /Remove$/.test(t) && !/synced/.test(t)) && cleared.items.length === 1 && /empty/.test(cleared.items[0]),
    JSON.stringify({ picked, cleared }));

  viewerWin.destroy();
  if (wc.debugger.isAttached()) wc.debugger.detach();
  await js(`document.getElementById("multiClose").click(); document.getElementById("queueClearBtn").click(); Hands.prototype.send = window.__realSend; true`);
  await js("HandTrackerApp.backToCamera()");
}

// Black gloves: MediaPipe gets the picture with dark things (a glove) turned light and
// skin-coloured and their lighter surroundings dim; the picture on screen stays as it is.
// A dark square on a light background, as MediaPipe gets it with the button off and on.
async function checkBlackGloves(js) {
  const file = path.join(outDir, "videos", "dark-patch.mp4");
  spawnSync(exporter.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0xd8d8d8:size=640x360:rate=30", "-t", "1",
    "-vf", "drawbox=x=270:y=130:w=100:h=100:color=0x181818:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  const r = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const sample = (image) => {
      const c = Object.assign(document.createElement("canvas"), { width: 64, height: 36 }), x = c.getContext("2d");
      x.drawImage(image, 0, 0, 64, 36);
      const d = x.getImageData(0, 0, 64, 36).data, at = (px, py) => [...d.slice((py * 64 + px) * 4, (py * 64 + px) * 4 + 3)];
      return { patch: at(32, 18), around: at(4, 4) };
    };
    let last = null;
    const real = Hands.prototype.send;
    Hands.prototype.send = async function (input) {
      last = sample(input.image);
      return real.call(this, input);
    };
    const bytes = Uint8Array.from(atob(${JSON.stringify(fs.readFileSync(file).toString("base64"))}), (c) => c.charCodeAt(0));
    await HandTrackerApp.openVideo("dark-patch.mp4", URL.createObjectURL(new Blob([bytes])), ${JSON.stringify(file)});
    HandTracker.file.pause();
    const again = async (at) => {
      last = null;
      HandTracker.file.seek(at);
      for (let i = 0; i < 100 && !last; i++) await sleep(100);
      await sleep(300);
      return last;
    };
    const out = { plain: await again(0.2) };
    document.getElementById("glovesToggle").click();
    out.button = document.getElementById("glovesToggle").textContent;
    out.gloved = await again(0.5);
    out.screen = sample(document.getElementById("stage"));
    out.saved = JSON.parse(localStorage.getItem("hand-tracker:prefs")).blackGloves;
    document.getElementById("glovesToggle").click();
    out.off = !HandTracker.getGloves() && JSON.parse(localStorage.getItem("hand-tracker:prefs")).blackGloves === false;
    Hands.prototype.send = real;
    return out;
  })()`);
  const dark = (c) => c && c.every((v) => v < 60), light = (c) => c && c.every((v) => v > 180);
  const skin = (c) => c && c[0] > 150 && c[0] > c[1] && c[1] > c[2], dim = (c) => c && c.every((v) => v < 80);
  check("Black gloves: MediaPipe gets dark things light and skin-coloured, their surroundings dim (the picture on screen unchanged); remembered",
    r.plain && dark(r.plain.patch) && light(r.plain.around) && r.gloved && skin(r.gloved.patch) && dim(r.gloved.around) &&
      dark(r.screen.patch) && light(r.screen.around) && r.button === "Black gloves: ON" && r.saved === true && r.off,
    JSON.stringify(r));
  await js("HandTrackerApp.backToCamera()");
}

// Mirror follows the camera: on for selfie cameras (and webcams that don't say which way
// they face, like the test camera), off for rear ones; the button's choice is remembered.
async function checkMirrorDefaults(js) {
  const state = () => js("({ on: HandTracker.isMirrored(), button: document.getElementById('mirrorToggle').textContent.trim(), facing: HandTracker.getCamera().facing })");
  // Reopens the camera the way changing the resolution does.
  const reopen = () => js(`(async () => {
    document.getElementById("resolutionSelect").dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 100 && !document.getElementById("stageMessage").hidden; i++) await new Promise((r) => setTimeout(r, 100));
    return true;
  })()`);
  const webcam = await state();
  await js(`window.__getSettings = MediaStreamTrack.prototype.getSettings;
    MediaStreamTrack.prototype.getSettings = function () { return { ...window.__getSettings.call(this), facingMode: "environment" }; }; true`);
  await reopen();
  const rear = await state();
  await js(`MediaStreamTrack.prototype.getSettings = function () { return { ...window.__getSettings.call(this), facingMode: "user" }; }; true`);
  await reopen();
  const front = await state();
  await js("MediaStreamTrack.prototype.getSettings = window.__getSettings; true");
  // Browsers that don't report the direction, only a name like "camera2 0, facing back".
  await js(`window.__label = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, "label");
    Object.defineProperty(MediaStreamTrack.prototype, "label", { configurable: true, get() { return "camera2 0, facing back"; } }); true`);
  await reopen();
  const named = await state();
  await js(`Object.defineProperty(MediaStreamTrack.prototype, "label", window.__label); true`);
  await reopen();
  const again = await state();
  check("Mirror is on for selfie cameras and webcams, off for rear cameras",
    webcam.on && webcam.button === "Mirror: ON" && !rear.on && rear.button === "Mirror: OFF" && rear.facing === "environment" && front.on && front.facing === "user" &&
      !named.on && named.facing === "environment" && again.on,
    JSON.stringify({ webcam, rear, front, named }));

  await js("document.getElementById('mirrorToggle').click(); true");
  await reopen();
  const kept = await state();
  await js("document.getElementById('mirrorToggle').click(); true");
  const saved = await js("JSON.parse(localStorage.getItem('hand-tracker:prefs')).mirrorByCamera[HandTracker.getCamera().deviceId]");
  check("The Mirror button's choice is remembered for that camera", !kept.on && kept.button === "Mirror: OFF" && saved === true && (await js("HandTracker.isMirrored()")),
    JSON.stringify(kept));
}

// 7. Recording Viewer: open and convert hand recordings (JSON, CSV), C3D and OptiTrack .tak.
// 9. OptiTrack: Motive's live NatNet data, and a screen/window as the tracking source.
async function checkOptiTrack(js) {
  const status = () => js("({ status: document.getElementById('motiveStatus').textContent, info: document.getElementById('motiveInfo').textContent, button: document.getElementById('motiveConnect').textContent })");
  const waitFor = async (test, tries = 60) => {
    let s;
    for (let i = 0; i < tries; i++) {
      s = await status();
      if (test(s)) return s;
      await sleep(250);
    }
    return s;
  };
  const connect = (multicast) => js(`(() => {
    document.getElementById("motiveServer").value = "127.0.0.1";
    document.getElementById("motiveMulticast").checked = ${multicast};
    document.getElementById("motiveConnect").click();
    return true;
  })()`);
  const disconnect = async () => {
    await js("document.getElementById('motiveConnect').click(); true");
    return waitFor((s) => s.button === "Connect");
  };
  check("The Motive panel is shown in the Windows app", await js("!document.getElementById('motiveCard').hidden"));
  const motiveLayouts = () => js(`(() => {
    const sel = document.getElementById("layoutSelect");
    return { offered: [...sel.options].filter((o) => !o.hidden && !o.disabled).map((o) => o.value).join(","), value: sel.value,
      saved: (JSON.parse(localStorage.getItem("hand-tracker:prefs")) || {}).layout || "" };
  })()`);
  const layoutsBefore = await motiveLayouts();

  // Multicast (Motive's default), then unicast.
  const results = {};
  for (const multicast of [true, false]) {
    const sim = await startNatNetSim({ rate: 100, multicast });
    await connect(multicast);
    results[multicast ? "multicast" : "unicast"] = await waitFor((s) => /Connected to Motive 3\.5 \(NatNet 4\.1\)/.test(s.status) && /rigid body/.test(s.info));
    if (!multicast) {
      // Record with motion capture (the test camera shows no hands, so it's Motive's data only).
      await js("document.getElementById('motionBtn').click(); true");
      await sleep(2000);
      await js("document.getElementById('motionBtn').click(); true");
      for (let i = 0; i < 20 && (await js("document.getElementById('motionExportCard').hidden")); i++) await sleep(250);
      results.export = await js(`(async () => {
        const info = document.getElementById("motionInfo").textContent;
        document.getElementById("motionName").value = "motive-take";
        document.querySelectorAll("#motionFormatGrid input").forEach((i) => { i.checked = ["c3d", "trc", "json"].includes(i.value); });
        document.getElementById("motionExportBtn").click();
        for (let i = 0; i < 40 && document.querySelectorAll("#motionResults li").length < 3; i++) await new Promise((r) => setTimeout(r, 250));
        return { info, saved: document.querySelectorAll("#motionResults li.ok").length, note: document.getElementById("motionNote").textContent };
      })()`);

      // Record Video with Motive's view below the camera's: the clip's lower part is Motive's
      // markers (the rigid body's orange square, labelled markers' blue dots).
      results.layoutsConnected = await motiveLayouts();
      results.video = await js(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const realConfirm = window.confirm;
        window.confirm = () => true; // a previous clip may not have been exported
        try {
          const sel = document.getElementById("layoutSelect");
          sel.value = "camera+motive";
          sel.dispatchEvent(new Event("change"));
          document.getElementById("videoBtn").click();
          await wait(2500);
          document.getElementById("videoBtn").click();
          const v = document.getElementById("clipPreview");
          for (let i = 0; i < 60 && (document.getElementById("exportCard").hidden || v.readyState < 2); i++) await wait(100);
          const stage = document.getElementById("stage");
          const w = v.videoWidth, h = v.videoHeight;
          if (!w || !h) return { size: "0x0", error: document.getElementById("videoStatus").textContent || "no clip" };
          // A frame a second in: the clip's very first frame can come before Motive's view is in it.
          v.currentTime = 1;
          await new Promise((r) => { v.addEventListener("seeked", r, { once: true }); setTimeout(r, 3000); });
          const c = document.createElement("canvas");
          c.width = w; c.height = h;
          const ctx = c.getContext("2d");
          ctx.drawImage(v, 0, 0);
          const split = Math.round((stage.height / stage.width) * w);
          const count = (y0, y1, test) => {
            const d = ctx.getImageData(0, y0, w, y1 - y0).data;
            let n = 0;
            for (let i = 0; i < d.length; i += 4) if (test(d[i], d[i + 1], d[i + 2])) n++;
            return n;
          };
          const orange = (r, g, b) => r > 200 && g > 100 && g < 190 && b < 110;
          const blue = (r, g, b) => b > 200 && g > 150 && r < 160;
          const mv = document.getElementById("motiveView");
          return { size: w + "x" + h, stage: stage.width + "x" + stage.height, motive: mv.width + "x" + mv.height, split, orange: count(split, h, orange), blue: count(split, h, blue),
            info: document.getElementById("clipInfo").textContent };
        } finally {
          window.confirm = realConfirm;
        }
      })()`).catch((err) => ({ error: String(err && err.message || err) }));
    }
    await disconnect();
    sim.stop();
    await sleep(300);
  }
  check("Connects to Motive's NatNet stream over multicast (Motive's default)", /3 labelled \+ 1 unlabelled markers · 1 rigid body · 1 skeleton \(2 bones\)/.test(results.multicast.info),
    `${results.multicast.status} ${results.multicast.info}`);
  check("…and over unicast", /Connected/.test(results.unicast.status) && /rigid body/.test(results.unicast.info), `${results.unicast.status} ${results.unicast.info}`);

  // Motive's view in recorded video: offered only while Motive is connected; the chosen layout
  // comes back when it reconnects (and reads as the same layout without Motive meanwhile).
  const layoutsAfter = await motiveLayouts();
  await js(`(() => { const sel = document.getElementById("layoutSelect"); sel.value = "camera"; sel.dispatchEvent(new Event("change")); return true; })()`);
  const vid = results.video || {};
  const [vw, vh] = String(vid.size || "0x0").split("x").map(Number);
  const [sw, sh] = String(vid.stage || "1x1").split("x").map(Number);
  const [mw, mh] = String(vid.motive || "16x9").split("x").map(Number);
  check("Record Video can include Motive's view below the camera's (offered only while Motive is connected; remembered for when it reconnects)",
    !/motive/.test(layoutsBefore.offered) && results.layoutsConnected && /camera\+motive/.test(results.layoutsConnected.offered) && /camera\+3d\+motive/.test(results.layoutsConnected.offered) &&
      vw > 0 && Math.abs(vh / vw - (sh / sw + mh / mw)) < 0.02 && vid.orange > 100 && vid.blue > 20 &&
      !/motive/.test(layoutsAfter.offered) && layoutsAfter.value === "camera" && layoutsAfter.saved === "camera+motive",
    JSON.stringify({ before: layoutsBefore.offered, connected: results.layoutsConnected && results.layoutsConnected.offered, video: vid, after: layoutsAfter }));

  // The exported Motive markers: names from Motive, its frame rate, and positions in mm, Z-up.
  const c3dFile = path.join(outDir, "motive-take-motive.c3d");
  let detail = results.export ? `${results.export.info}; ${results.export.note}` : "no export";
  let ok = false;
  if (fs.existsSync(c3dFile) && fs.existsSync(path.join(outDir, "motive-take-motive.trc"))) {
    const c3d = validators.readC3D(c3dFile);
    const labels = c3d.params["POINT:LABELS"];
    const pivot = labels.indexOf("Wand_pivot");
    // Wand pivot: a 0.3 m circle 1 m up in Motive (Y-up) -> radius 300 mm around Z, at z = 1000 mm.
    const pts = c3d.data.map((f) => f[pivot]).filter((p) => p && p[3] >= 0);
    const radii = pts.map((p) => Math.hypot(p[0], p[1]));
    const heights = pts.map((p) => p[2]);
    const rate = c3d.header.rate;
    ok = ["Wand_1", "Wand_2", "Wand_3", "Wand_pivot", "Performer_Hip", "Performer_Chest"].every((l) => labels.includes(l)) &&
      pts.length > 50 && radii.every((r) => Math.abs(r - 300) < 1) && heights.every((z) => Math.abs(z - 1000) < 1) && Math.abs(rate - 100) < 40;
    detail = `${labels.length} points (${labels.join(", ")}), ${c3d.data.length} frames at ${rate.toFixed(1)} Hz; wand radius ${Math.min(...radii).toFixed(1)}–${Math.max(...radii).toFixed(1)} mm, height ${Math.min(...heights).toFixed(1)} mm`;
  }
  check("Motive's data records with motion capture and exports (names, rate, mm Z-up)", ok && results.export.saved === 3, detail);

  // A crop of the screen, picked in the picker, as the tracking source.
  const picked = await js(`(async () => {
    HandTrackerApp.openCapturePicker();
    const grid = document.getElementById("captureGrid");
    for (let i = 0; i < 40 && !grid.querySelector("button"); i++) await new Promise((r) => setTimeout(r, 250));
    const screen = [...grid.querySelectorAll("button")].find((b) => /Whole screen/.test(b.textContent));
    if (!screen) return { error: "no screen listed: " + grid.textContent.slice(0, 80) };
    screen.click();
    const v = document.getElementById("capturePreview");
    for (let i = 0; i < 40 && !(v.videoWidth > 0); i++) await new Promise((r) => setTimeout(r, 250));
    // Drag a box over the middle half of the preview.
    const stage = document.getElementById("cropStage"), r = v.getBoundingClientRect();
    const at = (type, fx, fy) => stage.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: r.left + fx * r.width, clientY: r.top + fy * r.height }));
    at("pointerdown", 0.25, 0.25); at("pointermove", 0.5, 0.5); at("pointermove", 0.75, 0.75); at("pointerup", 0.75, 0.75);
    const areaButton = document.getElementById("captureUseArea");
    const enabled = !areaButton.disabled;
    const full = { w: v.videoWidth, h: v.videoHeight };
    areaButton.click();
    for (let i = 0; i < 40 && !HandTracker.getCamera().screen; i++) await new Promise((r) => setTimeout(r, 250));
    await new Promise((r) => setTimeout(r, 2000));
    const cam = HandTracker.getCamera();
    const select = document.getElementById("cameraSelect");
    return { enabled, full, cam: { screen: cam.screen, width: cam.width, height: cam.height, crop: cam.crop }, fps: HandTracker.getFPS(),
      mirrored: HandTracker.isMirrored(), dialogClosed: document.getElementById("captureDialog").hidden,
      selected: select.options[select.selectedIndex].textContent };
  })()`);
  const half = picked.cam && picked.full && Math.abs(picked.cam.width / (picked.full.w || 1) - 0.5) < 0.05;
  check("Tracks the part of a screen dragged out in the picker (not mirrored)",
    !picked.error && picked.enabled && picked.cam.screen && half && picked.fps > 0 && !picked.mirrored && picked.dialogClosed && /^Window: .*\(part\)/.test(picked.selected),
    JSON.stringify(picked));
  // Back to the camera from the list.
  const back = await js(`(async () => {
    const select = document.getElementById("cameraSelect");
    select.value = select.options[0].value;
    select.dispatchEvent(new Event("change"));
    for (let i = 0; i < 40 && HandTracker.getCamera().screen; i++) await new Promise((r) => setTimeout(r, 250));
    await new Promise((r) => setTimeout(r, 1500));
    return { screen: HandTracker.getCamera().screen, width: HandTracker.getCamera().width, mirrored: HandTracker.isMirrored() };
  })()`);
  check("…and back to the camera", !back.screen && back.width > 0 && back.mirrored, JSON.stringify(back));
}

// 8. Recording Viewer: open a video the page can't play (WMV, with sound) and convert it to every format.
async function checkViewerVideo() {
  const src = path.join(outDir, "viewer-source.wmv");
  spawnSync(exporter.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "2", "-c:v", "wmv2", "-b:v", "2M", "-c:a", "wmav2", "-shortest", src]);
  const win = new BrowserWindow({
    show: false, width: 920, height: 1600,
    webPreferences: { preload: path.join(__dirname, "..", "electron", "preload.js"), sandbox: true, contextIsolation: true },
  });
  await win.loadURL("app://hand-tracker/viewer.html");
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const opened = await js(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(fs.readFileSync(src).toString("base64"))}), (c) => c.charCodeAt(0));
    await RecordingViewer.openVideo(new File([bytes], "viewer-source.wmv"), ${JSON.stringify(src)});
    const v = document.getElementById("videoPreview");
    for (let i = 0; i < 100 && !(v.videoWidth > 0); i++) await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 50 && !/sound/.test(document.getElementById("videoMeta").textContent); i++) await new Promise((r) => setTimeout(r, 100));
    return { width: v.videoWidth, converted: v.currentSrc.startsWith("app://hand-tracker/__media/"), meta: document.getElementById("videoMeta").textContent,
      formats: document.querySelectorAll("#exportGrid input:not(:disabled)").length, groups: document.querySelectorAll("#exportGrid .format-group").length };
  })()`);
  check("Viewer opens a WMV (converted preview) and describes it", opened.width === 640 && opened.converted && /wmv2/.test(opened.meta) && /with sound/.test(opened.meta) && opened.formats === exporter.FORMATS.length && opened.groups === new Set(exporter.FORMATS.map((f) => f.group)).size,
    `${opened.meta}; ${opened.formats} formats in ${opened.groups} groups`);
  const done = await js(`(async () => {
    document.getElementById("exportName").value = "viewer-converted";
    [...document.querySelectorAll("#exportGrid .format-tools button")].find((b) => b.textContent === "Select all").click();
    document.getElementById("exportBtn").click();
    for (let i = 0; i < 1200 && document.querySelectorAll("#exportResults li").length < ${exporter.FORMATS.length}; i++) await new Promise((r) => setTimeout(r, 250));
    return { ok: document.querySelectorAll("#exportResults li.ok").length, note: document.getElementById("exportNote").textContent,
      failed: [...document.querySelectorAll("#exportResults li.fail")].map((l) => l.textContent) };
  })()`);
  check(`Viewer converts the video to all ${exporter.FORMATS.length} formats`, done.ok === exporter.FORMATS.length, done.failed.join(" | ") || done.note);
  const verified = verifyExports(outDir, "viewer-converted", exporter.FORMATS.map((f) => f.id), true);
  check("…each decodes as the right format, with the sound kept", verified.ok, verified.summary);
  win.destroy();
}

// Motion files convert to every other format: each of the app's own hand exports (C3D, TRC,
// GLB, NPZ, BVH, CSV, JSON) reads back as hands, and its C3D export again matches the
// original C3D; a marker recording round-trips through every marker format.
async function checkMotionConversion(vjs, files) {
  const b64 = (f) => JSON.stringify(fs.readFileSync(f).toString("base64"));
  const r = await vjs(`(async () => {
    const bytes = (s) => { const u = Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); return u.buffer; };
    const files = { c3d: ${b64(files.c3d)}, trc: ${b64(files.trc)}, glb: ${b64(files.glb)}, npz: ${b64(files.npz)}, csv: ${b64(files.csv)}, json: ${b64(files.json)}, bvh: ${b64(files.bvh)}, markers: ${b64(files.markers)} };
    const ref = MotionImport.fromC3D(bytes(files.c3d), "ref.c3d").data;
    // Largest difference (mm) between two marker recordings with the same labels; Infinity if they don't line up.
    const diff = (a, b) => {
      if (a.labels.join() !== b.labels.join() || a.frame_count !== b.frame_count) return Infinity;
      let worst = 0;
      for (let i = 0; i < a.positions.length; i++) {
        const x = a.positions[i], y = b.positions[i];
        if (Number.isNaN(x) !== Number.isNaN(y)) return Infinity;
        if (!Number.isNaN(x)) worst = Math.max(worst, Math.abs(x - y));
      }
      return worst;
    };
    const asC3D = (data) => MotionImport.fromC3D(MotionExport.build(data, ["c3d"], "rt")[0].data.slice().buffer, "rt.c3d").data;
    const out = {};
    for (const ext of ["c3d", "trc", "glb", "npz", "csv", "json"]) {
      try {
        const { data } = await MotionImport.parseFileAsync("rec." + ext, bytes(files[ext]));
        out[ext] = { hands: data.hands ? data.hands.map((h) => h.handedness).join("+") : data.kind, worstMm: data.hands ? +diff(ref, asC3D(data)).toFixed(4) : null,
          formats: data.hands ? MotionExport.build(data, MotionExport.FORMATS.map((f) => f.id), "all").length : 0 };
      } catch (err) {
        out[ext] = { error: String(err.message || err) };
      }
    }
    // MCAP: Hand Tracker's own reads back exactly (its attached recording), and still as both
    // hands from its ROS 2 messages alone (as after a ROS tool dropped the attachment).
    try {
      const rec = (await MotionImport.parseFileAsync("rec.json", bytes(files.json))).data;
      const mcap = MotionExport.build(rec, ["mcap"], "rt")[0].data;
      const own = (await MotionImport.parseFileAsync("rec.mcap", mcap.slice().buffer)).data;
      const bare = MotionImport.fromMCAP(mcap.slice().buffer, "rec.mcap", { useAttachment: false }).data;
      out.mcap = { hands: own.hands.map((h) => h.handedness).join("+"), exact: JSON.stringify(own) === JSON.stringify(rec),
        bareHands: bare.hands ? bare.hands.map((h) => h.handedness).join("+") : bare.kind, worstMm: bare.hands ? +diff(asC3D(rec), asC3D(bare)).toFixed(4) : null,
        formats: MotionExport.build(own, MotionExport.FORMATS.map((f) => f.id), "all").length };
    } catch (err) {
      out.mcap = { error: String(err.message || err) };
    }
    // BVH: one hand; it comes back as that hand, and converts to BVH again identically.
    try {
      const a = (await MotionImport.parseFileAsync("rec-left.bvh", bytes(files.bvh))).data;
      const again = MotionExport.build(a, ["bvh"], "rt")[0].data;
      const b = (await MotionImport.parseFileAsync("rt-left.bvh", new TextEncoder().encode(again).buffer)).data;
      out.bvh = { hands: a.hands.map((h) => h.handedness).join("+"), frames: a.hands[0].frames.length, worstMm: +diff(asC3D(a), asC3D(b)).toFixed(4),
        formats: MotionExport.build(a, MotionExport.FORMATS.map((f) => f.id), "all").length };
    } catch (err) {
      out.bvh = { error: String(err.message || err) };
    }
    // Markers (an OptiTrack take): through every marker format and back.
    const md = MotionImport.fromC3D(bytes(files.markers), "take.c3d").data;
    out.markers = { labels: md.labels.length, frames: md.frame_count };
    for (const id of MotionExport.MARKER_FORMATS.map((f) => f.id)) {
      try {
        const f = MotionExport.buildMarkers(md, [id], "take")[0];
        const buf = typeof f.data === "string" ? new TextEncoder().encode(f.data).buffer : f.data.slice().buffer;
        const back = (await MotionImport.parseFileAsync("take." + f.ext, buf)).data;
        out.markers[id] = back.kind === "markers" ? +diff(md, back).toFixed(4) : "not markers";
      } catch (err) {
        out.markers[id] = String(err.message || err);
      }
    }
    return out;
  })()`).catch((err) => ({ error: String((err && err.message) || err) }));
  // Within 0.05 mm: exports scale each hand to the standard hand size, measured over its frames,
  // and a re-export measures it over the resampled frames, a few parts per million apart.
  const handOk = (x, hands, tol) => x && !x.error && x.hands === hands && x.worstMm <= tol && x.formats >= 8;
  check("Hand Tracker's own C3D, TRC, GLB and NPZ (and CSV, JSON) read back as both hands and convert to all 8 formats; C3D again matches the original",
    ["c3d", "trc", "glb", "npz", "csv", "json"].every((ext) => handOk(r[ext], "Left+Right", 0.05)),
    JSON.stringify(Object.fromEntries(["c3d", "trc", "glb", "npz", "csv", "json"].map((k) => [k, r[k]]))));
  check("A BVH reads back as its hand (fingertips from its end sites) and converts to all 8 formats; BVH → hands → BVH keeps every joint",
    r.bvh && !r.bvh.error && r.bvh.hands === "Left" && r.bvh.frames > 10 && r.bvh.worstMm <= 0.05 && r.bvh.formats >= 8, JSON.stringify(r.bvh));
  check("MCAP (ROS 2): Hand Tracker's own reads back exactly, and as both hands from its ROS 2 messages alone; it converts to all 8 formats",
    r.mcap && !r.mcap.error && r.mcap.hands === "Left+Right" && r.mcap.exact && r.mcap.bareHands === "Left+Right" && r.mcap.worstMm <= 1 && r.mcap.formats >= 8, JSON.stringify(r.mcap));
  const m = r.markers || {};
  check("A marker recording goes through every marker format (C3D, TRC, CSV, GLB, NPZ, JSON, MCAP) and back unchanged",
    m.labels > 0 && ["c3d", "trc", "csv", "glb", "npz", "json", "mcap"].every((id) => typeof m[id] === "number" && m[id] <= 0.01), JSON.stringify(m));
}

async function checkViewer(jsonPath, files) {
  const win = new BrowserWindow({
    show: false, width: 920, height: 1600,
    webPreferences: { preload: path.join(__dirname, "..", "electron", "preload.js"), sandbox: true, contextIsolation: true },
  });
  await win.loadURL("app://hand-tracker/viewer.html");
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const jsonText = fs.readFileSync(jsonPath, "utf8");
  const data = JSON.parse(jsonText);
  const state = `({
    rows: document.querySelectorAll(".hand-row").length,
    segs: document.querySelectorAll(".timeline-seg").length,
    tableRows: document.querySelectorAll("#tableBody tr").length,
    formats: document.querySelectorAll('#exportGrid input:not([value^="video:"])').length,
    videoFormats: document.querySelectorAll('#exportGrid input[value^="video:"]').length,
    error: (document.querySelector("#results .error") || {}).textContent || "",
    text: document.getElementById("results").innerText,
    injected: !!document.querySelector("#results img, #results script") || !!window.__pwned,
  })`;
  const openText = (name, text) => js(`(async () => {
    await RecordingViewer.openBytes(${JSON.stringify(name)}, new TextEncoder().encode(${JSON.stringify(text)}).buffer);
    await new Promise((r) => setTimeout(r, 300));
    return ${state};
  })()`);
  const openFile = (name, file) => js(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(fs.readFileSync(file).toString("base64"))}), (c) => c.charCodeAt(0));
    await RecordingViewer.openBytes(${JSON.stringify(name)}, bytes.buffer);
    await new Promise((r) => setTimeout(r, 300));
    return ${state};
  })()`);
  // Picks every motion format in the export panel (not the videos) and clicks Export (the folder dialog is answered by this script).
  const exportAll = (name, expectOk) => js(`(async () => {
    document.getElementById("exportName").value = ${JSON.stringify(name)};
    document.querySelectorAll("#exportGrid input").forEach((i) => { i.checked = !i.disabled && !i.value.startsWith("video:"); });
    document.getElementById("exportBtn").click();
    for (let i = 0; i < 240 && document.querySelectorAll("#exportResults li").length < ${expectOk}; i++) await new Promise((r) => setTimeout(r, 250));
    return { ok: document.querySelectorAll("#exportResults li.ok").length, note: document.getElementById("exportNote").textContent,
      failed: [...document.querySelectorAll("#exportResults li.fail")].map((li) => li.textContent) };
  })()`);

  // Hand recording (JSON): cards, playback, frame table, export panel.
  const v2 = await openText(path.basename(jsonPath), jsonText);
  check("Viewer shows both hands from a two-hand file", v2.rows === 2 && v2.segs > 0 && v2.tableRows > 0 && v2.formats === 8 && v2.videoFormats >= 30,
    `${v2.rows} hand rows, ${v2.segs} phase segments, ${v2.tableRows} table rows, ${v2.formats} motion + ${v2.videoFormats} video export formats`);
  const played = await js(`(async () => {
    document.querySelector("#tableBody tr:nth-child(40)").click(); // jump playback to that frame
    await new Promise((r) => setTimeout(r, 100));
    const c = document.getElementById("playCanvas"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 60 || d[i + 1] > 60 || d[i + 2] > 60) lit++;
    return { lit, time: document.getElementById("playTime").textContent };
  })()`);
  check("Playback draws the skeletons and follows the frame table", played.lit > 500 && !played.time.startsWith("0.00 "), `${played.lit} lit pixels at ${played.time}`);
  const table = await js(`({ selected: document.getElementById("columnSelect").selectedOptions[0].textContent,
    wrist: document.getElementById("columnSelect").options[0].textContent, note: !!document.querySelector(".table-note"),
    head: [...document.querySelectorAll("#tableHead th")].map((th) => th.textContent).slice(-1)[0] })`);
  check("Frame table explains the wrist origin and opens on a fingertip", table.selected === "index_tip" && /origin/.test(table.wrist) && table.note && /from wrist/.test(table.head), JSON.stringify(table));
  fs.writeFileSync(path.join(outDir, "viewer.png"), (await win.webContents.capturePage()).toPNG());

  const frame = (i) => ({ frame_index: i, t: i / 30, joints: [] });
  const v1 = {
    frame_rate: 30, handedness: "Right", frames: [0, 1, 2, 3].map(frame),
    trajectories: { end_effector: [[0, 0.4, 0.5, 0], [0.1, 0.5, 0.45, 0]], palm_orientation: [] },
    task_segments: [{ phase: "reach", start_frame: 0, end_frame: 3 }],
  };
  const old = await openText("old.json", JSON.stringify(v1));
  check("Viewer still opens old single-hand files", old.rows === 1 && old.segs === 1 && !old.error, old.error);
  const hostile = { ...v1, handedness: '<img src=x onerror="window.__pwned=1">', notes: ['<script>window.__pwned=1</script>'] };
  const bad = await openText("bad.json", JSON.stringify(hostile));
  check("Viewer escapes HTML inside recording files", !bad.injected && bad.text.includes("<img"));

  // CSV: view it, round-trip it exactly, and rebuild a correct skeleton from it.
  const csvText = fs.readFileSync(files.csv, "utf8");
  const csvView = await openText("rec.csv", csvText);
  check("Viewer opens the CSV export", csvView.rows === 2 && csvView.formats === 8 && !csvView.error, csvView.error || JSON.stringify(csvView).slice(0, 200));
  const rt = await js(`(() => {
    const csv = ${JSON.stringify(csvText)};
    const { data, warnings } = MotionImport.parse(csv, "rec.csv");
    const [left, right] = MotionExport.build(data, ["bvh"], "rt");
    return { same: MotionExport.build(data, ["csv"], "rt")[0].data === csv, warnings, left: left.data, right: right.data };
  })()`);
  check("CSV → import → CSV is byte-identical", rt.same && rt.warnings.length === 0, rt.warnings.join(" | "));
  fs.writeFileSync(path.join(outDir, "from-csv-left.bvh"), rt.left);
  fs.writeFileSync(path.join(outDir, "from-csv-right.bvh"), rt.right);
  for (const hand of ["Left", "Right"]) {
    const r = validators.checkBVH(path.join(outDir, `from-csv-${hand.toLowerCase()}.bvh`), data, hand);
    check(`BVH rebuilt from the CSV matches the original recording (${hand})`, r.ok, r.detail);
  }
  // As saved by a spreadsheet in many regions: semicolons, decimal commas, BOM, CRLF.
  const excel = "\uFEFF" + csvText.trim().split("\n").map((line) => line.split(",").map((c) => (/^-?\d+\.\d+$/.test(c) ? c.replace(".", ",") : c)).join(";")).join("\r\n") + "\r\n";
  const ex = await js(`(() => {
    const { data } = MotionImport.parse(${JSON.stringify(excel)}, "excel.csv");
    const left = data.hands.find((h) => h.handedness === "Left");
    return { hands: data.hands.length, v: left.frames[3].joints[8].position[1], frames: data.hands.map((h) => h.frames.length) };
  })()`);
  const want = data.hands.find((h) => h.handedness === "Left").frames[3].joints[8].position[1];
  check("Spreadsheet-style CSV (; separators, decimal commas) imports correctly", ex.hands === 2 && Math.abs(ex.v - want) < 1e-6, `index tip y ${ex.v} vs ${want}`);
  const wrong = await openText("wrong.csv", "name,value\na,1\nb,2\n");
  check("A CSV that isn't motion capture gets a clear message", /missing columns/.test(wrong.error), wrong.error.slice(0, 80));

  // C3D: the app's own C3D holds hands, so it opens as those hands again; the TRC they
  // produce must match the app's own TRC.
  const c3dView = await openFile("rec.c3d", files.c3d);
  check("Viewer opens the app's own C3D as both hands again (all 8 formats)", c3dView.rows === 2 && c3dView.tableRows > 0 && c3dView.formats === 8, c3dView.error || JSON.stringify(c3dView).slice(0, 200));
  const markerTrc = await js(`MotionExport.build(RecordingViewer.current().data, ["trc"], "m")[0].data`);
  fs.writeFileSync(path.join(outDir, "from-c3d.trc"), markerTrc);
  const a = validators.parseTRC(path.join(outDir, "from-c3d.trc")), b = validators.parseTRC(files.trc);
  let worst = 0;
  a.rows.forEach((row, k) => row.values.forEach((v, i) => {
    const w = b.rows[k].values[i];
    if (v === null || w === null) worst = v === w ? worst : Infinity;
    else worst = Math.max(worst, Math.abs(v - w));
  }));
  check("C3D → TRC matches the app's TRC export", a.labels.join() === b.labels.join() && a.rows.length === b.rows.length && worst < 0.05, `max difference ${worst.toFixed(4)} mm`);
  const saved = await exportAll("from-c3d", 9);
  check("Viewer exports the C3D's hands to all 8 formats (9 files: one BVH per hand)", saved.ok === 9, saved.failed.join(" | ") || saved.note);
  // Other C3Ds (here OptiTrack Motive's markers) open as markers, with the 7 marker formats.
  const markerView = await openFile("take.c3d", files.markers);
  check("Viewer opens other C3D files as markers", /6\s*Markers/.test(markerView.text) && markerView.tableRows > 0 && markerView.formats === 7, markerView.error || markerView.text.slice(0, 120));
  const markerSaved = await exportAll("from-take-c3d", 7);
  check("Viewer exports C3D markers to all 7 formats", markerSaved.ok === 7, markerSaved.failed.join(" | ") || markerSaved.note);

  // Every motion format to every other, and several recordings converted at once.
  await checkMotionConversion(js, files);
  const batch = await js(`(async () => {
    const file = (name, b64) => new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name);
    RecordingViewer.queueRecordings([
      file("batch.c3d", ${JSON.stringify(fs.readFileSync(files.c3d).toString("base64"))}),
      file("batch-left.bvh", ${JSON.stringify(fs.readFileSync(files.bvh).toString("base64"))}),
      file("batch.npz", ${JSON.stringify(fs.readFileSync(files.npz).toString("base64"))}),
      file("batch-take.c3d", ${JSON.stringify(fs.readFileSync(files.markers).toString("base64"))}),
    ]);
    const listed = document.querySelectorAll("#motionQueueList li button").length;
    document.querySelectorAll("#motionQueueGrid input").forEach((i) => { i.checked = ["csv", "glb", "bvh"].includes(i.value); });
    document.getElementById("motionQueueConvertBtn").click();
    for (let i = 0; i < 200 && !/^Converted/.test(document.getElementById("motionQueueNote").textContent); i++) await new Promise((r) => setTimeout(r, 150));
    return { listed, ok: document.querySelectorAll("#motionQueueResults li.ok").length, fail: [...document.querySelectorAll("#motionQueueResults li.fail")].map((li) => li.textContent),
      note: document.getElementById("motionQueueNote").textContent, left: document.querySelectorAll("#motionQueueList li button").length };
  })()`);
  // Motion capture as video: the recording's playback drawn frame by frame, converted to MP4.
  const asVideo = await js(`(async () => {
    const bytes = new TextEncoder().encode(${JSON.stringify(fs.readFileSync(files.json, "utf8"))});
    await RecordingViewer.openBytes("as-video.json", bytes.buffer);
    document.getElementById("exportName").value = "motion-as-video";
    document.querySelectorAll("#exportGrid input").forEach((i) => { i.checked = i.value === "video:mp4"; });
    const offered = [...document.querySelectorAll("#exportGrid input")].filter((i) => i.value.startsWith("video:")).length;
    document.getElementById("exportBtn").click();
    for (let i = 0; i < 400 && !document.querySelector("#exportResults li"); i++) await new Promise((r) => setTimeout(r, 250));
    return { offered, ok: document.querySelectorAll("#exportResults li.ok").length, note: document.getElementById("exportNote").textContent,
      duration: RecordingViewer.current().data.duration };
  })()`);
  const mp4 = path.join(outDir, "motion-as-video.mp4");
  const probe = fs.existsSync(mp4) ? spawnSync(exporter.ffmpegPath, ["-hide_banner", "-i", mp4, "-f", "null", "-"], { encoding: "utf8" }).stderr : "";
  const vDur = /Duration: 00:00:(\d+\.\d+)/.exec(probe);
  const vSize = /, (\d+)x(\d+)/.exec((/Video: [^\n]+/.exec(probe) || [""])[0]);
  check("Motion capture converts to video too (all the video formats are offered; the playback is drawn frame by frame, here to MP4, as long as the recording)",
    asVideo.offered >= 30 && asVideo.ok === 1 && vDur && Math.abs(Number(vDur[1]) - asVideo.duration) < 0.15 && vSize && vSize[1] === "1280",
    JSON.stringify({ ...asVideo, video: vDur ? `${vDur[1]} s ${vSize ? vSize[1] + "x" + vSize[2] : ""}` : "none" }));

  // c3d (two hands): csv, glb, 2 bvh; bvh (one hand): csv, glb; npz (two hands): csv, glb, 2 bvh; take (markers): csv, glb, and BVH can't be made.
  check("Several recordings convert at once (hands to any format, markers to the marker formats; BVH from markers is refused with a reason)",
    batch.listed === 4 && batch.ok === 12 && batch.fail.length === 1 && /skeleton/.test(batch.fail[0]) && /Converted 4 of 4/.test(batch.note),
    JSON.stringify(batch));

  // OptiTrack .tak, through the Motive installed on this PC (skipped without Motive).
  const info = await js("desktop.getInfo()");
  const sample = "C:\\Program Files\\OptiTrack\\Motive\\Samples\\NMotive\\Data\\Take5.tak";
  if (!info.motive || !fs.existsSync(sample)) {
    console.log("SKIP  OptiTrack .tak checks (Motive or its sample takes aren't installed)");
  } else {
    const opened = await js(`RecordingViewer.openTake(${JSON.stringify(sample)}, "Take5.tak").then((ok) => ({ ok, ...${state}, md: RecordingViewer.current() && RecordingViewer.current().data && { labels: RecordingViewer.current().data.labels.length, frames: RecordingViewer.current().data.frame_count, rate: RecordingViewer.current().data.frame_rate } }))`);
    check("Opens an OptiTrack .tak take through Motive", opened.ok && opened.md && opened.md.labels === 3 && opened.md.frames === 1000 && opened.md.rate === 120,
      opened.error || `${opened.md.labels} markers × ${opened.md.frames} frames at ${opened.md.rate} fps`);
    await js(`document.getElementById("labelsToggle").click()`);
    fs.writeFileSync(path.join(outDir, "viewer-tak.png"), (await win.webContents.capturePage()).toPNG());
    const takSaved = await exportAll("take5", 8);
    check("Exports the take to C3D, TRC, CSV, FBX (Motive) and GLB, NPZ, JSON, MCAP", takSaved.ok === 8, takSaved.failed.join(" | ") || takSaved.note);
    const out = (ext) => path.join(outDir, `take5.${ext}`);
    const c3d = validators.readC3D(out("c3d"));
    const trc = validators.parseTRC(out("trc"));
    const fbxHead = fs.existsSync(out("fbx")) ? fs.readFileSync(out("fbx")).subarray(0, 18).toString("latin1") : "";
    const csvHead = fs.existsSync(out("csv")) ? fs.readFileSync(out("csv"), "utf8").slice(0, 14) : "";
    const json = JSON.parse(fs.readFileSync(out("json"), "utf8"));
    const glb = fs.readFileSync(out("glb"));
    const npz = spawnSync("python", ["-c", "import sys, numpy as np; z = np.load(sys.argv[1]); print(z['positions'].shape, list(z['labels']))", out("npz")], { encoding: "utf8" });
    check("Take exports are valid files",
      c3d.header.points === 3 && c3d.data.length === 1000 && trc.nMarkers === 3 && trc.nFrames === 1000 && fbxHead === "Kaydara FBX Binary" &&
        csvHead === "Format Version" && json.labels.length === 3 && json.frames.length === 1000 && glb.readUInt32LE(0) === 0x46546c67 && /\(1000, 3, 3\)/.test(npz.stdout),
      `C3D ${c3d.header.points}×${c3d.data.length}, TRC ${trc.nMarkers}×${trc.nFrames}, FBX "${fbxHead}", CSV "${csvHead}", NPZ ${npz.stdout.trim().split(" [")[0]}`);
    // BVH isn't offered for this take: it has no skeleton.
    check("BVH is disabled for takes without a skeleton", await js(`document.querySelector('#exportGrid input[value="bvh"]').disabled`));

    // Motive's own CSV and TRC exports of the take open too, and agree with its C3D.
    const openBack = async (name) => {
      const r = await openFile(name, out(name.split(".").pop()));
      const same = await js(`(() => {
        const md = RecordingViewer.current().data;
        return { labels: md.labels, frames: md.frame_count, rate: md.frame_rate, source: md.source };
      })()`);
      return { ...r, ...same };
    };
    const csvBack = await openBack("take5.csv");
    check("Opens Motive's CSV export (markers, rigid body and its solved markers)", !csvBack.error && csvBack.labels.length === 7 && csvBack.frames === 1000 && csvBack.rate === 120 && csvBack.source === "motive-csv",
      csvBack.error || `${csvBack.labels.length} points × ${csvBack.frames} frames`);
    const diff = await js(`(async () => {
      const load = async (b64, name) => { const u = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); return MotionImport.parseFile(name, u.buffer).data; };
      const csv = await load(${JSON.stringify(fs.readFileSync(out("csv")).toString("base64"))}, "take5.csv");
      const c3d = await load(${JSON.stringify(fs.readFileSync(out("c3d")).toString("base64"))}, "take5.c3d");
      const key = (l) => l.replace(/[^A-Za-z0-9]+/g, "_");
      let worst = 0, n = 0;
      c3d.labels.forEach((l, m) => {
        const j = csv.labels.findIndex((x) => key(x) === key(l));
        for (let k = 0; j >= 0 && k < c3d.frame_count; k++) {
          const a = c3d.positions.subarray((k * c3d.labels.length + m) * 3, (k * c3d.labels.length + m) * 3 + 3);
          const b = csv.positions.subarray((k * csv.labels.length + j) * 3, (k * csv.labels.length + j) * 3 + 3);
          if (a.every(Number.isFinite) && b.every(Number.isFinite)) { n++; worst = Math.max(worst, ...[0, 1, 2].map((d) => Math.abs(a[d] - b[d]))); }
        }
      });
      return { worst, n };
    })()`);
    check("Motive CSV lines up with the same take's C3D (not mirrored)", diff.n > 2500 && diff.worst < 1, `${diff.n} samples, max difference ${diff.worst.toFixed(3)} mm`);
    const trcBack = await openBack("take5.trc");
    check("Opens Motive's TRC export", !trcBack.error && trcBack.labels.length === 3 && trcBack.frames === 1000 && trcBack.source === "trc", trcBack.error || `${trcBack.labels.length} markers × ${trcBack.frames} frames`);
  }
  win.destroy();
}

let started = false;
app.on("browser-window-created", (_event, win) => {
  if (started) return;
  started = true;
  run(win)
    .catch((err) => check("Check run finished without crashing", false, err.stack || String(err)))
    .finally(() => {
      const failed = results.filter((r) => !r.ok).length;
      console.log(`\n${results.length - failed}/${results.length} checks passed. Output: ${outDir}`);
      if (cameraCrashedAt) console.log(`(Chromium's fake test camera crashed at ${cameraCrashedAt}: camera checks after that couldn't pass.)`);
      app.exit(failed ? (cameraCrashedAt ? CAMERA_CRASHED : 1) : 0);
    });
});
