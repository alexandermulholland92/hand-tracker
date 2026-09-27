/**
 * check.js — automated end-to-end check of the desktop app.
 *   npm run check
 *
 * Launches the real app with Chromium's built-in fake camera, then:
 *  1. waits for MediaPipe to load and process camera frames,
 *  2. simulates two hands (Left + Right) moving and gripping,
 *  3. records motion capture and a "Camera + 3D" video,
 *  4. exports motion capture to all 7 formats and video to all 27 formats,
 *  5. verifies every output file with independent readers (BVH replayed with
 *     forward kinematics, GLB played in three.js, C3D read from the spec,
 *     NPZ loaded with NumPy, each video decoded by ffmpeg), and recognises
 *     gestures from simulated hand poses,
 *  6. opens video files in 10 formats as the tracking source (native and converted),
 *     re-times a recording made from a video file, and captures a whole video; checks
 *     Mirror is on for selfie cameras and off for rear cameras and video files, and that
 *     Mirrored video flips a mirrored recording back before tracking (by default for
 *     Android front-camera videos, recognised from their metadata),
 *  7. opens the Recording Viewer with JSON, CSV (incl. spreadsheet-saved), C3D, TRC,
 *     Motive CSV and — when OptiTrack Motive is installed — a sample .tak take,
 *  8. opens a WMV with sound in the Recording Viewer and converts it to all 27 formats,
 *  9. OptiTrack: receives a stand-in Motive's NatNet stream (scripts/natnet-sim.js) over
 *     multicast and unicast, records it with motion capture and checks the exported
 *     markers; tracks a crop of the screen picked in the "Screen or window" picker.
 * Output goes to a temp folder that is printed at the end.
 */

const { app, dialog, BrowserWindow } = require("electron");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "hand-tracker-check-"));
// Fresh profile every run, so saved preferences can't change what's tested.
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "hand-tracker-check-profile-")));
// Answer the app's save / folder dialogs automatically.
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [outDir] });
dialog.showSaveDialog = async (_win, opts) => ({ canceled: false, filePath: path.join(outDir, path.basename(opts.defaultPath)) });

require("../electron/main.js");
const exporter = require("../electron/exporter.js");
const validators = require("./motion-validators.js");
const { verifyExports } = require("./video-validators.js");
const { startNatNetSim } = require("./natnet-sim.js");
const { PAGE_SIMULATION, gesturePoses } = require("./simulated-hands.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}


async function run(win) {
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const consoleErrors = [];
  wc.on("console-message", (...args) => {
    const d = args[0] && typeof args[0].message === "string" ? args[0] : { level: args[1], message: args[2] };
    if (d.level === "error" || d.level === 3) consoleErrors.push(d.message);
  });

  await new Promise((r) => wc.once("did-finish-load", r));

  // 1. MediaPipe + camera pipeline
  // Chromium's fake camera runs at 20 fps; wait for tracking to warm up to a steady rate.
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
  for (let i = 0; i < 80 && saved < 8; i++) {
    await sleep(250);
    saved = await js("document.querySelectorAll('#motionResults li.ok').length");
  }
  const motionFiles = fs.readdirSync(outDir).filter((f) => f.startsWith("robot-motion-"));
  check("All 7 motion formats saved (8 files: one BVH per hand)", saved === 8, motionFiles.map((f) => f.replace(/^robot-motion-[\d_-]+?(?=[-.][a-z])/, "…")).join(" "));
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
  }));
  check('Middle finger raised, facing the camera, reads "The Bird" (also on a phone held sideways; nothing else does)',
    g.bird === "The Bird" && g.birdSideways === "The Bird" && g.birdPointingDown !== "The Bird" && g.birdSideOn !== "The Bird" && g.peace === "Peace" && g.fist !== "The Bird",
    JSON.stringify(g));
  check("Fist, Point, Rock On, Call Me, Thumbs Up and Thumbs Down read as themselves (a thumb out to the side is neither)",
    g.fist === "Fist" && g.point === "Point" && g.rockOn === "Rock On" && g.callMe === "Call Me" && g.thumbsUp === "Thumbs Up" && g.thumbsDown === "Thumbs Down" &&
      !/Thumbs/.test(g.thumbSideways), JSON.stringify(g));

  // The same on real hands: landmarks measured from photos (upright, phone-portrait crops
  // and turned sideways), each fed through the tracker as if from a camera that size, as a
  // hand newly appearing (so smoothing starts fresh).
  const real = await js(`(async () => {
    const cases = ${fs.readFileSync(path.join(__dirname, "fixtures", "gesture-hands.json"), "utf8")}.cases;
    const cameraOf = HandTracker.getCamera;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const SPECIAL = ["The Bird", "Thumbs Down", "Live Long and Prosper", "Peace", "OK Sign"];
    const wrong = [], tally = {};
    for (const c of cases) {
      await sleep(300); // longer than the tracker keeps a lost hand, so this is a new hand
      HandTracker.getCamera = () => ({ ...cameraOf(), width: c.width, height: c.height });
      const frame = Object.assign(document.createElement("canvas"), { width: c.width, height: c.height });
      const landmarks = c.landmarks.map(([x, y, z]) => ({ x, y, z }));
      for (let f = 0; f < 12; f++) {
        HandTracker._processResults({ image: frame, multiHandLandmarks: [landmarks], multiHandedness: [{ label: c.handedness, score: 0.9 }] });
        await sleep(20);
      }
      await sleep(80); // hand cards redraw about 15 times a second
      const side = c.handedness === "Left" ? "Right" : "Left"; // HandTracker swaps MediaPipe's labels
      const badge = document.querySelector("#slot" + side + " .gesture-badge");
      const got = badge ? badge.textContent : "(no card)";
      const right = c.expect === "other" ? !SPECIAL.includes(got) : got === c.expect;
      tally[c.expect] = tally[c.expect] || [0, 0];
      tally[c.expect][1]++;
      if (right) tally[c.expect][0]++;
      else wrong.push(c.photo + " " + c.variant + ": " + got + " (expected " + c.expect + ")");
      HandTracker._processResults({ image: frame, multiHandLandmarks: [], multiHandedness: [] });
      await sleep(30);
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

  const relevantErrors = consoleErrors.filter((m) => !/DevTools|Autofill/i.test(m));
  check("No errors in the page console", relevantErrors.length === 0, relevantErrors.slice(0, 3).join(" | "));

  // 6. Video files as the tracking source: formats the page plays itself and ones
  //    ffmpeg converts; every frame tracked on the video's own clock.
  await js("Hands.prototype.send = window.__realSend; document.getElementById('discardBtn').click();");
  await checkVideoFiles(win, js);
  await checkMirrorDefaults(js);
  await checkOptiTrack(js);

  if (jsonPath) await checkViewer(jsonPath, { csv: mfile(".csv"), c3d: mfile(".c3d"), trc: mfile(".trc") });
  await checkViewerVideo();
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
  for (const [name, opts] of TEST_VIDEOS) {
    spawnSync(exporter.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "2", ...opts, path.join(dir, name)]);
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
    const good = r.ok && r.frames === 60 && r.ordered && Math.abs(r.last - 1966.7) < 5 && Math.abs(r.fps - 30) < 0.1 && !r.mirrored;
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
    }
    await disconnect();
    sim.stop();
    await sleep(300);
  }
  check("Connects to Motive's NatNet stream over multicast (Motive's default)", /3 labelled \+ 1 unlabelled markers · 1 rigid body · 1 skeleton \(2 bones\)/.test(results.multicast.info),
    `${results.multicast.status} ${results.multicast.info}`);
  check("…and over unicast", /Connected/.test(results.unicast.status) && /rigid body/.test(results.unicast.info), `${results.unicast.status} ${results.unicast.info}`);

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
  check("Viewer opens a WMV (converted preview) and describes it", opened.width === 640 && opened.converted && /wmv2/.test(opened.meta) && /with sound/.test(opened.meta) && opened.formats === exporter.FORMATS.length && opened.groups === 5,
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
    formats: document.querySelectorAll("#exportGrid input").length,
    error: (document.querySelector("#results .error") || {}).textContent || "",
    text: document.getElementById("results").innerText,
    injected: !!document.querySelector("#results img, #results script") || !!window.__pwned,
  })`;
  const openText = (name, text) => js(`(async () => {
    RecordingViewer.openBytes(${JSON.stringify(name)}, new TextEncoder().encode(${JSON.stringify(text)}).buffer);
    await new Promise((r) => setTimeout(r, 300));
    return ${state};
  })()`);
  const openFile = (name, file) => js(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(fs.readFileSync(file).toString("base64"))}), (c) => c.charCodeAt(0));
    RecordingViewer.openBytes(${JSON.stringify(name)}, bytes.buffer);
    await new Promise((r) => setTimeout(r, 300));
    return ${state};
  })()`);
  // Picks formats in the export panel and clicks Export (the folder dialog is answered by this script).
  const exportAll = (name, expectOk) => js(`(async () => {
    document.getElementById("exportName").value = ${JSON.stringify(name)};
    document.querySelectorAll("#exportGrid input").forEach((i) => { i.checked = !i.disabled; });
    document.getElementById("exportBtn").click();
    for (let i = 0; i < 240 && document.querySelectorAll("#exportResults li").length < ${expectOk}; i++) await new Promise((r) => setTimeout(r, 250));
    return { ok: document.querySelectorAll("#exportResults li.ok").length, note: document.getElementById("exportNote").textContent,
      failed: [...document.querySelectorAll("#exportResults li.fail")].map((li) => li.textContent) };
  })()`);

  // Hand recording (JSON): cards, playback, frame table, export panel.
  const v2 = await openText(path.basename(jsonPath), jsonText);
  check("Viewer shows both hands from a two-hand file", v2.rows === 2 && v2.segs > 0 && v2.tableRows > 0 && v2.formats === 7,
    `${v2.rows} hand rows, ${v2.segs} phase segments, ${v2.tableRows} table rows, ${v2.formats} export formats`);
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
  check("Viewer opens the CSV export", csvView.rows === 2 && csvView.formats === 7 && !csvView.error, csvView.error);
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

  // C3D: view it as markers and convert; the TRC it produces must match the app's own TRC.
  const c3dView = await openFile("rec.c3d", files.c3d);
  check("Viewer opens C3D files as markers", /42\s*Markers/.test(c3dView.text) && c3dView.tableRows > 0 && c3dView.formats === 6, c3dView.error);
  const markerTrc = await js(`MotionExport.buildMarkers(RecordingViewer.current().data, ["trc"], "m")[0].data`);
  fs.writeFileSync(path.join(outDir, "from-c3d.trc"), markerTrc);
  const a = validators.parseTRC(path.join(outDir, "from-c3d.trc")), b = validators.parseTRC(files.trc);
  let worst = 0;
  a.rows.forEach((row, k) => row.values.forEach((v, i) => {
    const w = b.rows[k].values[i];
    if (v === null || w === null) worst = v === w ? worst : Infinity;
    else worst = Math.max(worst, Math.abs(v - w));
  }));
  check("C3D → TRC matches the app's TRC export", a.labels.join() === b.labels.join() && a.rows.length === b.rows.length && worst < 0.01, `max difference ${worst.toFixed(4)} mm`);
  const saved = await exportAll("from-c3d", 6);
  check("Viewer exports C3D markers to all 6 formats", saved.ok === 6, saved.failed.join(" | ") || saved.note);

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
    const takSaved = await exportAll("take5", 7);
    check("Exports the take to C3D, TRC, CSV, FBX (Motive) and GLB, NPZ, JSON", takSaved.ok === 7, takSaved.failed.join(" | ") || takSaved.note);
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
      app.exit(failed ? 1 : 0);
    });
});
