/**
 * check-android.js — automated check of the Android app's web code.
 *   npm run check:android
 *
 * Runs the exact www/ bundle that goes into the APK in a phone-sized window,
 * with Chromium's fake camera and a simulated Capacitor bridge
 * (fake-capacitor.js), then:
 *  1. confirms the page runs in Android mode (mobile bridge, no desktop bridge),
 *  2. simulates two hands while recording motion capture and video,
 *  3. saves the video (MP4 on phones) and all 7 motion formats through the
 *     Android save path, in small chunks to exercise chunked writes,
 *  4. verifies every saved file with the same independent readers as check.js,
 *  5. checks Share and the Recording Viewer's Back link,
 *  6. converts with ffmpeg.wasm as a phone would: the recording to other formats, an
 *     AVI opened for tracking, and a WMV (with sound) in the Recording Viewer.
 * The native Filesystem/Share plugins themselves can only be tested on a device.
 */

const { app, BrowserWindow, protocol, session } = require("electron");
const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const validators = require("./motion-validators.js");
const { verifyExports } = require("./video-validators.js");
const { PAGE_SIMULATION } = require("./simulated-hands.js");

const ROOT = path.join(__dirname, "..");
const WWW = path.join(ROOT, "www");
const HOST = "hand-tracker";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm" };

app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "hand-tracker-android-profile-")));
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
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "hand-tracker-android-check-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// Copies the files the fake Filesystem holds (as the app saved them) to outDir.
async function pullFiles(js) {
  const saved = await js(`(() => {
    const out = {};
    for (const [p, bytes] of window.__fakeCapacitor.files) {
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      out[p] = btoa(s);
    }
    return out;
  })()`);
  const written = {};
  for (const [p, b64] of Object.entries(saved)) {
    const file = path.join(outDir, path.basename(p));
    fs.writeFileSync(file, Buffer.from(b64, "base64"));
    written[path.basename(p)] = file;
  }
  return written;
}

async function run() {
  execSync("node scripts/build-web.js", { cwd: ROOT, stdio: "inherit" });
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname) === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(WWW, rel));
    if (url.host !== HOST || !file.startsWith(WWW + path.sep) || !fs.existsSync(file)) return new Response("Not found", { status: 404 });
    return new Response(fs.readFileSync(file), { headers: { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" } });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media"));

  // Phone-sized window (a typical 412×915 dp Android screen).
  const win = new BrowserWindow({
    width: 412, height: 915, useContentSize: true,
    webPreferences: { preload: path.join(__dirname, "fake-capacitor.js"), contextIsolation: false, sandbox: false, backgroundThrottling: false },
  });
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const errors = [];
  wc.on("console-message", (...args) => {
    const d = args[0] && typeof args[0].message === "string" ? args[0] : { level: args[1], message: args[2] };
    if (d.level === "error" || d.level === 3) errors.push(d.message);
  });
  await win.loadURL(`app://${HOST}/index.html`);

  // 1. Android mode
  check("Runs in Android mode (mobile bridge on, desktop bridge off)", await js("!!window.mobile && !window.desktop && mobile.platform === 'android'"));
  let fps = 0;
  for (let i = 0; i < 120 && fps < 15; i++) {
    await sleep(500);
    fps = await js("HandTracker.getFPS()");
  }
  check("MediaPipe loads from the APK bundle and tracks", fps >= 15, `${fps} fps`);
  check("Viewer link opens in place and buttons say Save",
    await js("!document.querySelector('a[href=\"viewer.html\"]').hasAttribute('target') && exportBtn.textContent.startsWith('Save') && motionExportBtn.textContent.startsWith('Save')"));
  const build = await js("document.getElementById('buildInfo').textContent");
  check("Header shows which build is running", /^v\d+\.\d+\.\d+ · built /.test(build), build);
  // Readable text (all text) is optional and off by default, but times stay the right way
  // round either way: in mirrored view, the fake camera's clock (0:00:05:123) must be found
  // by OCR so it can be flipped back.
  const waitForRegions = async () => {
    let regions = 0;
    for (let i = 0; i < 40 && !regions; i++) { // text is shown once 3 scans agree
      await sleep(500);
      regions = await js("ReadableText.getRegions().length");
    }
    return regions;
  };
  const offLabel = await js("readableToggle.textContent");
  let regions = await waitForRegions();
  check("Readable text is off by default, and OCR from the APK bundle still keeps the camera's clock readable",
    /OFF/.test(offLabel) && regions > 0 && (await js("ReadableText.getStatus()")) === "ready", `${offLabel}, status ${await js("ReadableText.getStatus()")}, ${regions} text region(s)`);
  await js("readableToggle.click()");
  const onLabel = await js("readableToggle.textContent");
  regions = await waitForRegions();
  await js("readableToggle.click()");
  check("The Readable text button turns all-text un-mirroring on and off", /ON/.test(onLabel) && regions > 0 && /OFF/.test(await js("readableToggle.textContent")),
    `${onLabel}, ${regions} text region(s)`);
  check("Layout fits a phone screen (no sideways scrolling)", await js("document.documentElement.scrollWidth <= window.innerWidth + 1"),
    await js("`page ${document.documentElement.scrollWidth}px wide, screen ${window.innerWidth}px`"));

  // 2. Record while two hands are simulated
  await js("mobile.chunkBytes = 64 * 1024"); // small chunks so saving exercises chunked writes
  await js("document.getElementById('motionBtn').click(); document.getElementById('videoBtn').click();");
  await js(PAGE_SIMULATION);
  await sleep(300);
  fs.writeFileSync(path.join(outDir, "phone-screenshot.png"), (await win.webContents.capturePage()).toPNG());
  await js("document.getElementById('videoBtn').click()");
  await js("document.getElementById('motionBtn').click()");
  await sleep(800);

  // 3a. Video
  const clipInfo = await js("document.getElementById('clipInfo').textContent");
  check("Video is recorded as MP4 on phones", /video\/mp4/.test(clipInfo), clipInfo);
  await js("document.getElementById('exportBtn').click()");
  for (let i = 0; i < 40 && !(await js("document.querySelectorAll('#exportResults li.ok').length")); i++) await sleep(250);
  // 3a'. The recording converted on the phone (ffmpeg.wasm) to formats the phone doesn't record in.
  const phoneFormats = ["webm", "mpg", "gif", "wmv", "ogv"];
  const offeredOnPhones = require("../video-formats.js").FORMATS.filter((f) => f.wasm).length;
  const converted = await js(`(async () => {
    document.getElementById("exportName").value = "phone-converted";
    document.querySelectorAll("#formatGrid input").forEach((i) => { i.checked = ${JSON.stringify(phoneFormats)}.includes(i.value); });
    const before = document.querySelectorAll("#exportResults li").length;
    document.getElementById("exportBtn").click();
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i < 600 && !document.getElementById("exportProgress").hidden; i++) await new Promise((r) => setTimeout(r, 250));
    return { offered: document.querySelectorAll("#formatGrid input:not(:disabled)").length, ok: document.querySelectorAll("#exportResults li.ok").length,
      note: document.getElementById("exportNote").textContent };
  })()`);
  check("The recording converts on the phone to WebM, MPG, GIF, WMV and OGV", converted.ok === phoneFormats.length && converted.offered === offeredOnPhones, `${converted.note} (${converted.offered} formats offered)`);

  // 3b. Motion capture, all formats
  await js("document.querySelectorAll('#motionFormatGrid input').forEach((i) => { i.checked = true; }); document.getElementById('motionExportBtn').click();");
  let saved = 0;
  for (let i = 0; i < 80 && saved < 8; i++) {
    await sleep(250);
    saved = await js("document.querySelectorAll('#motionResults li.ok').length");
  }
  check("All 7 motion formats saved to Documents/Hand Tracker (8 files)", saved === 8, await js("document.getElementById('motionNote').textContent"));

  const files = await pullFiles(js);
  const calls = await js("window.__fakeCapacitor.calls");
  const appends = calls.filter((c) => c[0] === "appendFile").length;
  const texts = calls.filter((c) => c[0] === "writeFile" && c[2] === "utf8").length;
  check("Large binary files are written in chunks, text files as UTF-8", appends > 0 && texts >= 4, `${appends} chunk appends, ${texts} text writes`);
  check("Every file lands in the Hand Tracker folder", (await js("[...window.__fakeCapacitor.files.keys()]")).every((p) => p.startsWith("Hand Tracker/")));

  // 4. Verify contents with the independent readers
  const phoneExports = verifyExports(outDir, "phone-converted", phoneFormats, false);
  check("…each decodes as the right format", phoneExports.ok, phoneExports.summary);
  const find = (ending) => {
    const name = Object.keys(files).find((n) => n.endsWith(ending));
    return name ? files[name] : null;
  };
  const video = find(".mp4") || find(".webm");
  if (video) {
    const probe = spawnSync(require("../electron/exporter.js").ffmpegPath, ["-hide_banner", "-i", video, "-f", "null", "-"], { encoding: "utf8" });
    const stream = /Stream #0:0.*Video: (\w+).*?, (\d+x\d+)/.exec(probe.stderr);
    check("Saved video decodes", probe.status === 0 && !!stream, stream ? `${path.basename(video)}: ${stream[1]} ${stream[2]}, ${(fs.statSync(video).size / 1024).toFixed(0)} KB` : probe.stderr.slice(-200));
  } else check("Saved video decodes", false, "no video file saved");

  const jsonPath = find(".json");
  if (jsonPath) {
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    check("Motion JSON has both hands", data.hands.map((h) => h.handedness).join("+") === "Left+Right");
    const report = (name, fn) => {
      try {
        const r = fn();
        check(name, r.ok, r.detail);
      } catch (err) {
        check(name, false, err.message);
      }
    };
    report("CSV matches the recording", () => validators.checkCSV(find(".csv"), data));
    report("BVH (left) replays correctly", () => validators.checkBVH(find("-left.bvh"), data, "Left"));
    report("BVH (right) replays correctly", () => validators.checkBVH(find("-right.bvh"), data, "Right"));
    let trc = null;
    report("TRC is well formed", () => validators.checkTRC((trc = validators.parseTRC(find(".trc")))));
    report("C3D matches TRC", () => validators.checkC3D(find(".c3d"), trc));
    report("NPZ loads in NumPy and matches JSON", () => validators.checkNPZ(find(".npz"), jsonPath, data));
    const glb = fs.readFileSync(find(".glb"));
    check("GLB is a valid glTF 2.0 binary", glb.readUInt32LE(0) === 0x46546c67 && glb.readUInt32LE(4) === 2 && glb.readUInt32LE(8) === glb.length);
  } else check("Motion JSON saved", false);

  // 5. Share + viewer
  await js("document.querySelector('#motionResults li.ok button').click()");
  await sleep(200);
  const shared = await js("window.__fakeCapacitor.shared");
  check("Share hands the saved file to Android's share sheet", shared.length === 1 && /^file:\/\/.*Hand%20Tracker\//.test(shared[0].files[0]), shared[0] && shared[0].files[0]);

  const relevant = errors.filter((m) => !/DevTools|Autofill/i.test(m));
  check("No errors in the page console", relevant.length === 0, relevant.slice(0, 3).join(" | "));

  // Video files on the phone: formats the phone plays itself open directly; others are converted (ffmpeg.wasm).
  await js("Hands.prototype.send = window.__realSend; true");
  const vids = {};
  for (const [name, opts] of [["phone.mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p"]], ["phone.avi", ["-c:v", "mpeg4", "-q:v", "4"]]]) {
    vids[name] = path.join(outDir, name);
    spawnSync(require("../electron/exporter.js").ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "2", ...opts, vids[name]]);
  }
  const openPhoneVideo = (name) => js(`(async () => {
    window.__videoFrames = [];
    if (!window.__videoHook) {
      window.__videoHook = true;
      HandTracker.onHandLandmarks(({ timestamp }) => { if (HandTracker.getSource() === "file") window.__videoFrames.push(timestamp); });
    }
    const bytes = Uint8Array.from(atob(${JSON.stringify(fs.readFileSync(vids[name]).toString("base64"))}), (c) => c.charCodeAt(0));
    const file = new File([bytes], ${JSON.stringify(name)}); // as the Open Video button passes it
    const ok = await HandTrackerApp.openVideo(${JSON.stringify(name)}, URL.createObjectURL(file), "", file);
    const v = document.getElementById("video");
    for (let i = 0; ok && i < 300 && !v.ended; i++) await new Promise((r) => setTimeout(r, 100));
    return { ok, frames: window.__videoFrames.length, note: document.getElementById("sourceNote").textContent,
      barFits: document.documentElement.scrollWidth <= window.innerWidth + 1 };
  })()`);
  const mp4 = await openPhoneVideo("phone.mp4");
  check("An MP4 opens on the phone and every frame is tracked", mp4.ok && mp4.frames === 60 && mp4.barFits, JSON.stringify(mp4));
  fs.writeFileSync(path.join(outDir, "phone-video.png"), (await win.webContents.capturePage()).toPNG());
  const avi = await openPhoneVideo("phone.avi");
  check("An AVI on the phone is converted and every frame is tracked", avi.ok && avi.frames === 60, JSON.stringify(avi));
  await js("HandTrackerApp.backToCamera()");

  await js("document.querySelector('a[href=\"viewer.html\"]').click()");
  await sleep(1500);
  check("Recording Viewer opens in place with a Back link", await js("location.pathname.endsWith('viewer.html') && !!document.querySelector('a.back-link[href=\"index.html\"]')"));

  // Viewer on the phone: import the CSV and C3D just saved, convert, and save through Android.
  const viewerOpen = (name, file) => js(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(fs.readFileSync(file).toString("base64"))}), (c) => c.charCodeAt(0));
    RecordingViewer.openBytes(${JSON.stringify(name)}, bytes.buffer);
    await new Promise((r) => setTimeout(r, 300));
    return { hands: document.querySelectorAll(".hand-row").length, text: document.getElementById("results").innerText,
      error: (document.querySelector("#results .error") || {}).textContent || "" };
  })()`);
  const viewerSave = (name, count) => js(`(async () => {
    document.getElementById("exportName").value = ${JSON.stringify(name)};
    document.querySelectorAll("#exportGrid input").forEach((i) => { i.checked = !i.disabled; });
    document.getElementById("exportBtn").click();
    for (let i = 0; i < 80 && document.querySelectorAll("#exportResults li").length < ${count}; i++) await new Promise((r) => setTimeout(r, 250));
    return { ok: document.querySelectorAll("#exportResults li.ok").length, share: document.querySelectorAll("#exportResults li button").length,
      label: document.getElementById("exportBtn").textContent };
  })()`);
  const csvView = await viewerOpen("rec.csv", find(".csv"));
  check("Viewer imports the CSV on the phone", csvView.hands === 2 && !csvView.error, csvView.error);
  const csvSaved = await viewerSave("phone-from-csv", 8);
  check("…and saves all 7 formats from it through Android (8 files)", csvSaved.ok === 8 && csvSaved.share === 8 && csvSaved.label === "Save", JSON.stringify(csvSaved));
  const c3dView = await viewerOpen("rec.c3d", find(".c3d"));
  check("Viewer imports C3D markers on the phone", /42\s*Markers/.test(c3dView.text) && !c3dView.error, c3dView.error);
  const c3dSaved = await viewerSave("phone-from-c3d", 6);
  check("…and saves all 6 marker formats through Android", c3dSaved.ok === 6, JSON.stringify(c3dSaved));
  const takMsg = await js(`(async () => {
    const input = document.getElementById("fileInput"), dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(8)], "Take1.tak"));
    input.files = dt.files;
    input.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 300));
    return (document.querySelector("#results .error") || {}).textContent || "";
  })()`);
  check("A .tak file on the phone explains it needs the Windows app with Motive", /Windows app/.test(takMsg) && /Motive/.test(takMsg), takMsg.slice(0, 90));

  // Viewer on the phone: a WMV with sound (no phone plays it) previewed and converted with ffmpeg.wasm.
  const wmv = path.join(outDir, "phone-source.wmv");
  spawnSync(require("../electron/exporter.js").ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "2", "-c:v", "wmv2", "-b:v", "2M", "-c:a", "wmav2", "-shortest", wmv]);
  const viewerFormats = ["mp4", "avi", "mov", "mxf", "dv", "webp", "flv", "rm", "cfhd", "utvideo"];
  const vv = await js(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(fs.readFileSync(wmv).toString("base64"))}), (c) => c.charCodeAt(0));
    await RecordingViewer.openVideo(new File([bytes], "phone-source.wmv"));
    const v = document.getElementById("videoPreview");
    for (let i = 0; i < 200 && !(v.videoWidth > 0); i++) await new Promise((r) => setTimeout(r, 100));
    const preview = { width: v.videoWidth, meta: document.getElementById("videoMeta").textContent, label: document.getElementById("exportBtn").textContent };
    document.getElementById("exportName").value = "phone-viewer";
    document.querySelectorAll("#exportGrid input").forEach((i) => { i.checked = ${JSON.stringify(viewerFormats)}.includes(i.value); });
    document.getElementById("exportBtn").click();
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i < 600 && !document.getElementById("exportProgress").hidden; i++) await new Promise((r) => setTimeout(r, 250));
    return { ...preview, ok: document.querySelectorAll("#exportResults li.ok").length, share: document.querySelectorAll("#exportResults li button").length,
      note: document.getElementById("exportNote").textContent };
  })()`);
  check(`Viewer on the phone previews a WMV (converted) and converts it to ${viewerFormats.length} formats`, vv.width === 640 && vv.ok === viewerFormats.length && vv.share === viewerFormats.length,
    JSON.stringify(vv));
  const phoneFiles = await pullFiles(js);
  const viewerExports = verifyExports(outDir, "phone-viewer", viewerFormats, true);
  check("…each decodes as the right format, with the sound kept", viewerExports.ok && Object.keys(phoneFiles).some((n) => n.startsWith("phone-viewer")), viewerExports.summary);

  // A video chosen with the recordings picker (or dropped) opens as a video, not as motion data.
  const routed = await js(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(fs.readFileSync(vids["phone.mp4"]).toString("base64"))}), (c) => c.charCodeAt(0));
    const input = document.getElementById("fileInput"), dt = new DataTransfer();
    dt.items.add(new File([bytes], "Holiday Clip.MP4", { type: "video/mp4" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change"));
    const v = () => document.getElementById("videoPreview");
    for (let i = 0; i < 100 && !(v() && v().videoWidth > 0); i++) await new Promise((r) => setTimeout(r, 100));
    return { video: !!v() && v().videoWidth, error: (document.querySelector("#results .error") || {}).textContent || "", accepts: /\.mp4/.test(input.accept) && /\.csv/.test(input.accept) };
  })()`);
  check("A video picked with Choose Recording opens as a video (no motion-data error)", routed.video === 640 && !routed.error && routed.accepts, JSON.stringify(routed));
}

app.whenReady().then(() =>
  run()
    .catch((err) => check("Check run finished without crashing", false, err.stack || String(err)))
    .finally(() => {
      const failed = results.filter((r) => !r.ok).length;
      console.log(`\n${results.length - failed}/${results.length} checks passed. Output: ${outDir}`);
      if (cameraCrashedAt) console.log(`(Chromium's fake test camera crashed at ${cameraCrashedAt}: camera checks after that couldn't pass.)`);
      app.exit(failed ? (cameraCrashedAt ? CAMERA_CRASHED : 1) : 0);
    })
);
