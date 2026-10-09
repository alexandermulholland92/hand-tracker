/**
 * check-android.js — automated check of the Android app's web code.
 *   npm run check:android
 *
 * Runs the exact www/ bundle that goes into the APK in a phone-sized window,
 * with Chromium's fake camera and a simulated Capacitor bridge
 * (fake-capacitor.js), then:
 *  1. confirms the page runs in Android mode (mobile bridge, no desktop bridge),
 *  2. simulates two hands while recording motion capture and video,
 *  3. saves the video (MP4 on phones) and all 8 motion formats through the
 *     Android save path, in small chunks to exercise chunked writes,
 *  4. verifies every saved file with the same independent readers as check.js,
 *  5. checks Share and the Recording Viewer's Back link,
 *  6. converts with ffmpeg.wasm as a phone would: the recording to other formats, an
 *     AVI opened for tracking, and a WMV (with sound) in the Recording Viewer.
 * The native Filesystem/Share plugins themselves can only be tested on a device.
 */

const { app, BrowserWindow, protocol, session, ipcMain } = require("electron");
const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const validators = require("./motion-validators.js");
const { verifyExports } = require("./video-validators.js");
const { PAGE_SIMULATION, TAG_HEIGHTS } = require("./simulated-hands.js");
const { startNatNetSim } = require("./natnet-sim.js");
const { startFleetSim } = require("./fleet-sim.js");

const ROOT = path.join(__dirname, "..");
const WWW = path.join(ROOT, "www");
const HOST = "hand-tracker";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm" };

app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
// The fake camera plays a test pattern from a file: Chromium's own pattern crashes now and then (fake-camera.js).
const fakeCamera = require("./fake-camera.js").fakeCameraFile();
if (fakeCamera) app.commandLine.appendSwitch("use-file-for-fake-video-capture", fakeCamera);
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

// Copies the files the fake Filesystem holds (as the app saved them) to outDir, one at a
// time and a few MB per call (uncompressed videos are large), each only once.
const pulled = new Map(); // path -> file on disk
async function pullFiles(js) {
  const paths = await js("[...window.__fakeCapacitor.files.keys()]");
  const written = {};
  for (const p of paths) {
    if (!pulled.has(p)) {
      const size = await js(`window.__fakeCapacitor.files.get(${JSON.stringify(p)}).length`);
      const parts = [];
      for (let at = 0; at < size; at += 8 << 20) {
        parts.push(Buffer.from(await js(`(() => {
          const bytes = window.__fakeCapacitor.files.get(${JSON.stringify(p)}).subarray(${at}, ${at + (8 << 20)});
          let s = "";
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return btoa(s);
        })()`), "base64"));
      }
      const file = path.join(outDir, path.basename(p));
      fs.writeFileSync(file, Buffer.concat(parts));
      pulled.set(p, file);
    }
    written[path.basename(p)] = pulled.get(p);
  }
  return written;
}

// The phone app's own copy of what it may ask another computer's Hand Tracker for
// (RemotePlugin.java's RIG and RIG_PATH: Java can't load remote-record.js) is the same as the
// list the desktop app and these checks use: the same paths, word for word, and the same
// answer for every address and path tried. (Java and JavaScript read these patterns alike.)
function checkRigRulesMatch() {
  const { RIG_HOST, RIG_PATH } = require("../electron/remote-record.js");
  const java = fs.readFileSync(path.join(ROOT, "android/app/src/main/java/com/handtracker/app/RemotePlugin.java"), "utf8");
  const pattern = (name) => {
    const m = new RegExp(`Pattern ${name} = Pattern\\.compile\\("((?:[^"\\\\]|\\\\.)*)"\\)`).exec(java);
    return m ? m[1].replace(/\\\\/g, "\\") : null; // the Java string's \\ is one backslash
  };
  const out = { host: pattern("RIG"), path: pattern("RIG_PATH") };
  if (!out.host || !out.path) return check("The Android app's rules for reaching a computer match the desktop app's", false, JSON.stringify(out));
  const javaHost = new RegExp(out.host), javaPath = new RegExp(out.path);
  const hosts = ["pi:47821", "PI.tail1234.ts.net:47821", "100.101.2.3:47821", "[fd7a::1]:47821", "[FD7A::1]:1", "pi", "pi:", "pi:123456", "-pi:1", "pi-:1", "a..b:1", "pi :1", "pi:1/x"];
  const paths = ["/api/state", "/api/command", "/api/wifi", "/api/takes", "/api/preview?i=0", "/api/preview?i=3&full=1", "/api/preview?i=4", "/api/preview?i=0&full=2",
    "/api/take?f=Sam-Smith_2s.json&at=0", "/api/take?f=a%20b%2Fc.mcap&at=2097152", "/api/take?f=a/b.json&at=0", "/api/take?f=a.json", "/api/take?f=a.json&at=-1", "/api/take?f=&at=0",
    "/api/takes/x", "/api/state?x", "/api/../state", "/", "/remote-client.js"];
  out.differ = [...hosts.filter((h) => javaHost.test(h) !== RIG_HOST.test(h)), ...paths.filter((p) => javaPath.test(p) !== RIG_PATH.test(p))];
  out.samePathText = out.path === RIG_PATH.source.replace(/\\\//g, "/");
  check("The Android app's rules for reaching a computer (RemotePlugin.java) match the desktop app's (remote-record.js): the same paths, and the same answer for every address and path tried",
    out.samePathText && !out.differ.length, JSON.stringify({ differ: out.differ, samePathText: out.samePathText }));
}

async function run() {
  checkRigRulesMatch();
  execSync("node scripts/build-web.js", { cwd: ROOT, stdio: "inherit" });
  // The phone's /__fleet/<rig>/<camera> (RemotePlugin.java serveFleet): the fake Remote
  // plugin (fake-capacitor.js) says which dashboard and which cookie, as the WebView's would be.
  const fleet = { site: null, cookie: "" };
  ipcMain.on("fake-remote:fleet", (_event, info) => Object.assign(fleet, info));
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__fleet/")) {
      const fm = /^\/__fleet\/([A-Za-z0-9][A-Za-z0-9-]{0,62})\/([A-Za-z0-9_]{1,32})$/.exec(url.pathname);
      if (!fm || !fleet.site) return new Response("Not found", { status: 404 });
      const keyframe = url.searchParams.get("kind") === "keyframe";
      const endpoint = keyframe ? `keyframe/${fm[2]}?` : `frame/${fm[2]}?${url.searchParams.get("full") === "1" ? "quality=full" : "fps=2"}&`;
      const res = await fetch(`${fleet.site}/proxy/${fm[1]}/api/preview/${endpoint}t=${Date.now()}`, { headers: { Cookie: fleet.cookie }, redirect: "manual" });
      const type = res.headers.get("content-type") || "";
      if ((res.ok && !/^(image|video)\//.test(type)) || res.status === 401 || res.status < 200 || (res.status >= 300 && res.status < 400)) return new Response("Signed out", { status: 401 });
      const headers = { "content-type": type || "application/octet-stream", "cache-control": "no-store" };
      for (const h of ["x-codec-string", "x-frame-stale", "x-frame-age-ms", "x-frame-unix-ns"]) if (res.headers.get(h)) headers[h] = res.headers.get(h);
      return new Response(await res.arrayBuffer(), { status: res.status, headers });
    }
    const rel = decodeURIComponent(url.pathname) === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(WWW, rel));
    if (url.host !== HOST || !file.startsWith(WWW + path.sep) || !fs.existsSync(file)) return new Response("Not found", { status: 404 });
    return new Response(fs.readFileSync(file), { headers: { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" } });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media"));
  // npm run check:android -- --only iphone: just the iPhone app's check.
  const only = process.argv.includes("--only") ? String(process.argv[process.argv.indexOf("--only") + 1]) : "";
  if (/iphone/i.test(only)) return checkIphoneApp();

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

  // The Left/Right tag starts a little bigger on a phone (1.3x), then grows with distance
  // as on a PC, but only up to 1.6x (a PC's goes to 2x).
  const tags = await js(TAG_HEIGHTS);
  const near = (v, want) => Math.abs(v - want) <= Math.max(4, want * 0.12);
  check("Left/Right tag: a little bigger on a phone up close, bigger as the hand goes further away (up to 1.6x on a phone)",
    near(tags.veryClose, 32 * 1.3) && near(tags.armsLength, 32 * 1.3) && near(tags.further, 32 * 1.6) && near(tags.far, 32 * 1.6) && near(tags.veryFar, 32 * 1.6),
    JSON.stringify(tags));

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
  // ffmpeg.wasm's formats plus the six video-native.js makes with the device's encoders (all 36 where it has HEVC and AV1 ones, as here).
  const offeredOnPhones = require("../video-formats.js").FORMATS.length;
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
  for (let i = 0; i < 80 && saved < 9; i++) {
    await sleep(250);
    saved = await js("document.querySelectorAll('#motionResults li.ok').length");
  }
  check("All 8 motion formats saved to Documents/Hand Tracker (9 files)", saved === 9, await js("document.getElementById('motionNote').textContent"));

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

  // 6. OptiTrack Motive's live data on the phone: the NatNet plugin's sockets (here Node's, in
  // fake-capacitor.js) and natnet-parse.js, from a stand-in Motive on this computer.
  const motive = {};
  check("The Motive panel is shown on the phone, asking for Motive's PC", await js("!motiveCard.hidden && motiveServer.value === '' && /Motive PC/.test(motiveServer.placeholder)"));
  const motiveState = () => js("({ status: motiveStatus.textContent, info: motiveInfo.textContent, button: motiveConnect.textContent })");
  const motiveWait = async (test) => {
    let st;
    for (let i = 0; i < 60; i++) {
      st = await motiveState();
      if (test(st)) break;
      await sleep(250);
    }
    return st;
  };
  for (const multicast of [true, false]) {
    const sim = await startNatNetSim({ rate: 100, multicast });
    await js(`(() => { motiveServer.value = "127.0.0.1"; motiveMulticast.checked = ${multicast}; motiveConnect.click(); return true; })()`);
    motive[multicast ? "multicast" : "unicast"] = await motiveWait((st) => /Connected to Motive 3\.5 \(NatNet 4\.1\)/.test(st.status) && /rigid body/.test(st.info));
    if (!multicast) {
      await js("document.getElementById('motionBtn').click(); true");
      await sleep(2000);
      await js("document.getElementById('motionBtn').click(); true");
      for (let i = 0; i < 20 && (await js("document.getElementById('motionExportCard').hidden")); i++) await sleep(250);
      motive.export = await js(`(async () => {
        document.getElementById("motionName").value = "phone-motive";
        document.querySelectorAll("#motionFormatGrid input").forEach((i) => { i.checked = i.value === "c3d"; });
        const before = document.querySelectorAll("#motionResults li").length;
        document.getElementById("motionExportBtn").click();
        for (let i = 0; i < 40 && document.querySelectorAll("#motionResults li").length <= before; i++) await new Promise((r) => setTimeout(r, 250));
        await new Promise((r) => setTimeout(r, 300));
        return { info: document.getElementById("motionInfo").textContent, note: document.getElementById("motionNote").textContent,
          reads: window.__fakeCapacitor.calls.filter((c) => c[0] === "natnet.recordRead").length };
      })()`);
    }
    await js("motiveConnect.click(); true");
    motive[multicast ? "stoppedMulticast" : "stoppedUnicast"] = await motiveWait((st) => st.button === "Connect");
    sim.stop();
  }
  check("Connects to Motive's NatNet stream on the phone over multicast and unicast",
    /3 labelled \+ 1 unlabelled markers · 1 rigid body · 1 skeleton \(2 bones\)/.test(motive.multicast.info) && /Connected/.test(motive.unicast.status) && motive.stoppedUnicast.button === "Connect",
    `${motive.multicast.status} ${motive.multicast.info} | ${motive.unicast.status}`);
  const motiveFiles = await pullFiles(js);
  const motiveC3d = Object.keys(motiveFiles).find((n) => /^phone-motive-motive.*\.c3d$/.test(n));
  let motiveDetail = JSON.stringify(motive.export), motiveOk = false;
  if (motiveC3d) {
    const c3d = validators.readC3D(motiveFiles[motiveC3d]);
    const labels = c3d.params["POINT:LABELS"];
    const pivot = labels.indexOf("Wand_pivot");
    const pts = c3d.data.map((f) => f[pivot]).filter((p) => p && p[3] >= 0);
    const radii = pts.map((p) => Math.hypot(p[0], p[1]));
    motiveOk = ["Wand_1", "Wand_pivot", "Performer_Hip"].every((l) => labels.includes(l)) && pts.length > 50 && radii.every((r) => Math.abs(r - 300) < 1) && motive.export.reads > 0;
    motiveDetail = `${labels.length} points, ${c3d.data.length} frames at ${c3d.header.rate.toFixed(1)} Hz; wand radius ${Math.min(...radii).toFixed(1)}–${Math.max(...radii).toFixed(1)} mm; read back in ${motive.export.reads} part(s)`;
  }
  check("Motive's data records with motion capture on the phone (every frame, read back from the plugin) and saves", motiveOk, motiveDetail);

  // 7. Capture Sessions and Live Rigs on the phone: hidden until the version under the title
  // is tapped 7 times; Live Rigs against the stand-in fleet dashboard (fleet-sim.js), through
  // the Remote plugin (here fake-capacitor.js) and the phone's /__fleet/ pictures.
  const fleetSim = await startFleetSim({ ffmpegPath: require("../electron/exporter.js").ffmpegPath, outDir });
  const rigs = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const $ = (id) => document.getElementById(id);
    const until = async (test, ms = 10000) => { for (let t = 0; t < ms && !test(); t += 100) await sleep(100); return test(); };
    const out = { hiddenAtStart: $("opsBtn").hidden && $("rigsBtn").hidden };
    for (let i = 0; i < 7; i++) $("buildInfo").click();
    await sleep(300);
    out.shown = !$("opsBtn").hidden && !$("rigsBtn").hidden;
    out.asksForSite = !$("opsSetup").hidden;
    $("opsDialog").hidden = true;
    $("rigsBtn").click();
    await until(() => !$("rigsSetup").hidden);
    $("rigsSite").value = ${JSON.stringify(fleetSim.site)};
    $("rigsConnect").click();
    await until(() => !$("rigsSignIn").hidden);
    $("rigsSignInBtn").click();
    await until(() => document.querySelectorAll("#rigsList .rig-row").length > 0, 15000);
    out.rows = [...document.querySelectorAll("#rigsList .rig-row")].map((row) => row.querySelector("b").textContent).join(",");
    const pick = async (host, cam = "head") => {
      if ($("rigsDialog").hidden) $("rigsBtn").click();
      const sel = '#rigsList button[data-host="' + host + '"][data-cam="' + cam + '"]';
      await until(() => document.querySelector(sel));
      document.querySelector(sel).click();
    };
    await pick("rig-a");
    await until(() => HandTracker.getCamera().stream && RigLive._state() && RigLive._state().frames >= 3, 10000);
    out.jpeg = { name: HandTracker.getCamera().name, frames: RigLive._state() && RigLive._state().frames };
    await pick("rig-d");
    await until(() => RigLive._state() && RigLive._state().host === "rig-d" && RigLive._state().frames >= 2, 10000);
    out.keyframes = { kind: RigLive._state() && RigLive._state().kind, size: HandTracker.getCamera().width + "x" + HandTracker.getCamera().height };
    await pick("rig-d");
    await until(() => !HandTracker.getCamera().stream, 10000);
    out.back = !HandTracker.getCamera().stream;
    $("rigsDialog").hidden = true;
    for (let i = 0; i < 7; i++) $("buildInfo").click();
    await sleep(300);
    out.hiddenAgain = $("opsBtn").hidden && $("rigsBtn").hidden;
    return out;
  })()`).catch((err) => ({ error: String((err && err.message) || err) }));
  const remoteCalls = await js("window.__fakeCapacitor.calls.filter((c) => c[0].startsWith('remote.')).map((c) => c[0] + ' ' + (typeof c[2] === 'string' ? c[2] : c[2] === true ? 'cookies' : '')).join('; ')");
  check("Capture Sessions and Live Rigs show on the phone after 7 taps on the version (and hide again)", rigs.hiddenAtStart && rigs.shown && rigs.asksForSite && rigs.hiddenAgain, JSON.stringify(rigs));
  check("Live Rigs on the phone: signs in on the dashboard's page, lists the rigs (recording first) and watches a JPEG camera and a keyframe camera through /__fleet/",
    /^Rig A,Rig F/.test(rigs.rows || "") && rigs.jpeg && rigs.jpeg.frames >= 3 && rigs.keyframes && rigs.keyframes.kind === "keyframe" && rigs.keyframes.size === "640x360" && rigs.back &&
      /remote\.signIn cookie/.test(remoteCalls) && fleetSim.writes.length === 0,
    JSON.stringify({ ...rigs, calls: remoteCalls.slice(0, 200), writes: fleetSim.writes }));
  fleetSim.stop();

  // 8. Controlling a PC from the phone over Wi-Fi (mobile.link, mobile.pc): a PC's link
  // (electron/phone-link.js, with a stand-in for its mouse and keyboard) on this computer.
  const { PhoneLinkServer } = require("../electron/phone-link.js");
  const pcGot = [];
  const pcLink = new PhoneLinkServer({ handle: async (type, d) => {
    pcGot.push(`${type} ${JSON.stringify(d)}`);
    return type === "keyboard" ? { shown: !!d.show } : null;
  } });
  const pcCode = (await pcLink.start()).pairing.replace(/:[0-9.,]+$/, ":127.0.0.1");
  const linked = await js(`(async () => {
    const $ = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = { card: !$("pcCard").hidden && !$("linkPhone").hidden && $("linkPc").hidden, before: $("linkPhoneStatus").textContent };
    $("linkEnter").click();
    $("linkCodeInput").value = ${JSON.stringify(pcCode)};
    $("linkConnect").click();
    for (let i = 0; i < 50 && !/Connected to/.test($("linkPhoneStatus").textContent); i++) await sleep(100);
    out.status = $("linkPhoneStatus").textContent;
    mobile.pc.pointer(0.25, 0.75, "primary");
    await mobile.pc.key("ctrl+c", "tap");
    await mobile.pc.button("left", "click");
    out.keyboard = await mobile.pc.setKeyboard(true);
    out.kept = !!localStorage.getItem("hand-tracker-pc-link") && !/[A-Za-z0-9_-]{22}/.test(localStorage.getItem("hand-tracker-pc-link"));
    return out;
  })()`).catch((err) => ({ error: String((err && err.message) || err) }));
  await sleep(300);
  pcLink.stop();
  linked.gone = await js(`mobile.pc.key("a", "tap").then(() => "carried out", (err) => err.message)`);
  linked.got = pcGot;
  check("The phone pairs with a PC from its code and controls it over Wi-Fi: pointer, keys, clicks and the PC's floating keyboard (the key kept in the Keystore)",
    linked.card && /Connected to/.test(linked.status || "") && pcGot.some((g) => g.startsWith('pointer {"nx":0.25')) && pcGot.includes('key {"combo":"ctrl+c","action":"tap"}') &&
      pcGot.includes('button {"which":"left","action":"click"}') && linked.keyboard === true && linked.kept && /didn't answer/.test(linked.gone || ""),
    JSON.stringify(linked));

  // 8b. This phone as an iPhone's Bluetooth mouse and keyboard (the BtHid plugin stood in for:
  // an iPhone connects a moment after it starts): "Controls: an iPhone or iPad" starts it, says
  // when it's connected, and the hand mouse, clicks, Home and typing go to it as HID reports,
  // not to the paired PC; back to the PC it stops.
  const iphone = await js(`(async () => {
    const $ = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const pick = (v) => (($("pcTarget").value = v), $("pcTarget").dispatchEvent(new Event("change")));
    const out = { row: !$("deviceRow").hidden, pcLabel: $("pcTarget").options[0].textContent, visibleButton: !$("deviceVisible").hidden };
    pick("device");
    for (let i = 0; i < 50 && !/Connected to Test iPhone/.test($("deviceNote").textContent); i++) await sleep(100);
    out.note = $("deviceNote").textContent;
    const R = window.__fakeCapacitor.btHidReports;
    R.length = 0;
    mobile.pc.pointer(0.5, 0.5, "primary");
    await mobile.pc.button("left", "click");
    await mobile.pc.key("homescreen", "tap");
    await mobile.pc.text("Hi");
    await sleep(300);
    out.reports = R.map(([id, b]) => id + ":" + b.join(","));
    out.started = window.__fakeCapacitor.calls.filter((c) => c[0] === "btHid.start").map((c) => c[1]);
    pick("computer");
    await sleep(300);
    out.stopped = window.__fakeCapacitor.calls.some((c) => c[0] === "btHid.stop");
    out.noteAfter = $("deviceNote").hidden;
    return out;
  })()`).catch((err) => ({ error: String((err && err.message) || err) }));
  const rep = iphone.reports || [];
  check("The phone as an iPhone's Bluetooth mouse and keyboard: it starts, says when the iPhone's connected, and the hand mouse, clicks, Home and typing go to it as HID reports; back to the PC it stops",
    iphone.row && iphone.pcLabel === "the paired PC" && iphone.visibleButton && /Connected to Test iPhone/.test(iphone.note || "") && iphone.started.length && iphone.started[0] > 100 &&
      rep.filter((r) => r === "2:0,129,129,0").length === 20 && rep.includes("2:1,0,0,0") && rep.includes("3:35,2") && rep.includes("1:2,0,11,0,0,0,0,0") && rep.includes("1:0,0,12,0,0,0,0,0") &&
      iphone.stopped && iphone.noteAfter,
    JSON.stringify({ ...iphone, reports: rep.length }));

  // 9. Controlling the phone itself: "Control this phone" hands the camera to the control
  // window (the PhoneControl plugin stood in for) and takes it back when that stops; and the
  // control window's page (phone-control.html) turns the hand mouse and gesture actions into
  // the accessibility service's taps, swipes and keys (here recorded).
  const self = await js(`(async () => {
    const $ = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = { shown: !$("selfControl").hidden, ready: $("selfStatus").textContent };
    $("selfStart").click();
    for (let i = 0; i < 30 && !/Stop/.test($("selfStart").textContent); i++) await sleep(100);
    out.started = window.__fakeCapacitor.calls.filter((c) => c[0] === "phoneControl.start").map((c) => JSON.parse(c[1]));
    out.cameraReleased = HandTracker.getSource() === "external" && HandTracker.getCamera().name === "Controlling this phone";
    out.button = $("selfStart").textContent;
    window.__fakeCapacitor.stopPhoneControl(); // its × tapped
    for (let i = 0; i < 50 && HandTracker.getSource() !== "camera"; i++) await sleep(100);
    out.cameraBack = HandTracker.getSource() === "camera";
    out.buttonAfter = $("selfStart").textContent;
    return out;
  })()`).catch((err) => ({ error: String((err && err.message) || err) }));
  check("Control this phone: Start hands the camera to the control window (with the hand mouse's settings); when it stops, the app has its camera back",
    self.shown && /Ready/.test(self.ready) && self.started && self.started.length === 1 && self.started[0].hand && self.cameraReleased && /Stop/.test(self.button) &&
      self.cameraBack && /Start/.test(self.buttonAfter),
    JSON.stringify(self));
  // Android 13+'s "Restricted setting": back from Accessibility settings with hand control still
  // off, the card explains it and opens App info (where it's allowed); once on, it's gone.
  const restricted = await js(`(async () => {
    const $ = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const back = async () => { document.dispatchEvent(new Event("visibilitychange")); await sleep(300); };
    window.__fakeCapacitor.setAccessibility(false);
    await back();
    const out = { before: !$("selfRestricted").hidden };
    $("selfAccess").click();
    await back();
    out.shown = !$("selfRestricted").hidden;
    out.text = $("selfRestricted").textContent.replace(/\\s+/g, " ").trim();
    $("selfAppInfo").click();
    out.opened = window.__fakeCapacitor.calls.filter((c) => c[0] === "phoneControl.openAppInfo").length;
    window.__fakeCapacitor.setAccessibility(true);
    await back();
    out.after = !$("selfRestricted").hidden;
    out.button = $("selfAccess").textContent;
    return out;
  })()`).catch((err) => ({ error: String((err && err.message) || err) }));
  check("Hand control blocked by Android 13+'s Restricted setting: back from Accessibility with it still off, the card says how to allow it and opens App info; once it's on, the note goes",
    !restricted.error && restricted.before === false && restricted.shown && /Allow restricted settings/.test(restricted.text) && restricted.opened === 1 && restricted.after === false && /^✓/.test(restricted.button),
    JSON.stringify(restricted));
  const controlWin = new BrowserWindow({
    show: false, width: 320, height: 240,
    webPreferences: { preload: path.join(__dirname, "fake-capacitor.js"), contextIsolation: false, sandbox: false, backgroundThrottling: false },
  });
  const controlSettings = { hand: "Right", reach: "0.55", actionsOn: true, allow: { keyboard: true, mouse: true, web: true },
    rules: [{ enabled: true, gesture: "Thumbs Up", hand: "any", action: "keys", value: "volumeup", method: "GET", trigger: "enter", hold: 0, every: 1 }] };
  await controlWin.loadURL(`app://${HOST}/phone-control.html?settings=${encodeURIComponent(JSON.stringify(controlSettings))}`);
  const cjs = (code) => controlWin.webContents.executeJavaScript(code, true);
  const controlled = await cjs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 100 && !(HandTracker.getCamera().width > 0); i++) await sleep(200);
    const out = { camera: HandTracker.getCamera().width, mouse: PcControl.isMouseOn() };
    HandTracker.setPaused(true); // only these synthetic hands
    const calls = window.__fakeCapacitor.calls;
    const T = [[0,0],[-.04,-.03],[-.08,-.07],[-.11,-.10],[-.13,-.13],[-.035,-.12],[-.04,-.17],[-.043,-.20],[-.045,-.23],
      [0,-.125],[0,-.18],[0,-.215],[0,-.245],[.03,-.115],[.035,-.165],[.038,-.195],[.04,-.22],[.055,-.10],[.065,-.135],[.07,-.16],[.075,-.18]];
    const hand = (cx, cy, curled = []) => ({ handedness: "Right", imageLandmarks: T.map(([x, y], i) => {
      const f = { 7: 5, 8: 5, 11: 9, 12: 9 }[i];
      const bent = f !== undefined && curled.includes(f === 5 ? "index" : "middle");
      const [bx, by] = bent ? [T[f][0] + (x - T[f][0]) * 0.2, T[f][1] + (y - T[f][1]) * 0.2] : [x, y];
      return { x: cx + bx, y: cy + by, z: 0 };
    }) });
    const none = () => ({ label: "—" });
    const frames = async (n, hands, gestureOf = none) => {
      for (let i = 0; i < n; i++) { PcControl.update(typeof hands === "function" ? hands(i) : hands, gestureOf, true, 4 / 3); await sleep(30); }
    };
    await frames(20, (i) => [hand(0.35 + i * 0.015, 0.6)]);
    out.pointers = calls.filter((c) => c[0] === "hand.pointer").length;
    await frames(10, [hand(0.6, 0.6)]);
    await frames(4, [hand(0.6, 0.6, ["index"])]); // a quick index curl: a tap
    await frames(15, [hand(0.6, 0.6)]);
    out.taps = calls.filter((c) => c[0] === "hand.button").map((c) => c.slice(1).join(" "));
    await frames(15, [hand(0.6, 0.6)], () => ({ label: "Thumbs Up" }));
    out.keys = calls.filter((c) => c[0] === "hand.key").map((c) => c.slice(1).join(" "));
    out.maxHands = HandTracker.getMaxHands(); // its one rule is for either hand

    // A touchscreen: a press held still is a long press, so a curl held still is a tap…
    const buttonsSince = (m) => calls.slice(m).filter((c) => c[0] === "hand.button").map((c) => c.slice(1).join(" "));
    let m = calls.length;
    await frames(20, [hand(0.6, 0.6, ["index"])]);
    await frames(10, [hand(0.6, 0.6)]);
    out.heldStill = buttonsSince(m);
    // …and it swipes once the hand moves with the finger curled.
    m = calls.length;
    await frames(4, [hand(0.6, 0.6, ["index"])]);
    await frames(10, (i) => [hand(0.6, 0.6 - i * 0.02, ["index"])]);
    await frames(10, [hand(0.6, 0.42)]);
    out.swipe = buttonsSince(m);
    // A hand kept low in the picture still reaches the top of the screen: pushed past the
    // bottom of the area it moves in, the area slides down with it.
    m = calls.length;
    await frames(10, (i) => [hand(0.6, 0.9 + i * 0.01)]);
    await frames(25, (i) => [hand(0.6, 1.0 - i * 0.022)]);
    await frames(8, [hand(0.6, 0.472)]);
    out.top = Math.min(...calls.slice(m).filter((c) => c[0] === "hand.pointer").map((c) => c[2]));
    return out;
  })()`).catch((err) => ({ error: String((err && err.message) || err) }));
  controlWin.destroy();
  check("The control window tracks with the camera and turns the hand mouse and gesture actions into taps and keys on the phone (a curl taps; Thumbs Up turns the volume up)",
    controlled.camera > 0 && controlled.mouse && controlled.pointers > 10 && (controlled.taps || []).includes("left click") && (controlled.keys || []).some((k) => /^volumeup/.test(k)),
    JSON.stringify(controlled));
  check("Control window on a touchscreen: one hand tracked (quicker); a curl held still taps rather than long-pressing; curled and moving swipes; a hand low in the picture reaches the top",
    controlled.maxHands === 1 && (controlled.heldStill || []).join() === "left click" && (controlled.swipe || []).join() === "left down,left up" && controlled.top < 0.1,
    JSON.stringify({ maxHands: controlled.maxHands, heldStill: controlled.heldStill, swipe: controlled.swipe, top: controlled.top }));

  await js("document.querySelector('a[href=\"viewer.html\"]').click()");
  await sleep(1500);
  check("Recording Viewer opens in place with a Back link", await js("location.pathname.endsWith('viewer.html') && !!document.querySelector('a.back-link[href=\"index.html\"]')"));

  // Viewer on the phone: import the CSV and C3D just saved, convert, and save through Android.
  const viewerOpen = (name, file) => js(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(fs.readFileSync(file).toString("base64"))}), (c) => c.charCodeAt(0));
    await RecordingViewer.openBytes(${JSON.stringify(name)}, bytes.buffer);
    await new Promise((r) => setTimeout(r, 300));
    return { hands: document.querySelectorAll(".hand-row").length, text: document.getElementById("results").innerText,
      error: (document.querySelector("#results .error") || {}).textContent || "" };
  })()`);
  const viewerSave = (name, count) => js(`(async () => {
    document.getElementById("exportName").value = ${JSON.stringify(name)};
    // Every motion format (not the videos: motion capture can be made into those too).
    document.querySelectorAll("#exportGrid input").forEach((i) => { i.checked = !i.disabled && !i.value.startsWith("video:"); });
    document.getElementById("exportBtn").click();
    for (let i = 0; i < 80 && document.querySelectorAll("#exportResults li").length < ${count}; i++) await new Promise((r) => setTimeout(r, 250));
    return { ok: document.querySelectorAll("#exportResults li.ok").length, share: document.querySelectorAll("#exportResults li button").length,
      label: document.getElementById("exportBtn").textContent };
  })()`);
  const csvView = await viewerOpen("rec.csv", find(".csv"));
  check("Viewer imports the CSV on the phone", csvView.hands === 2 && !csvView.error, csvView.error);
  const csvSaved = await viewerSave("phone-from-csv", 9);
  check("…and saves all 8 formats from it through Android (9 files)", csvSaved.ok === 9 && csvSaved.share === 9 && csvSaved.label === "Save", JSON.stringify(csvSaved));
  // The app's own C3D and BVH hold hands: they open as those hands again, with every format.
  const c3dView = await viewerOpen("rec.c3d", find(".c3d"));
  check("Viewer imports the app's C3D on the phone as both hands again", c3dView.hands === 2 && !c3dView.error, c3dView.error);
  const c3dSaved = await viewerSave("phone-from-c3d", 9);
  check("…and saves all 8 formats from it through Android (9 files)", c3dSaved.ok === 9, JSON.stringify(c3dSaved));
  const bvhView = await viewerOpen("rec-left.bvh", find("-left.bvh"));
  check("Viewer imports a BVH on the phone (as its hand)", bvhView.hands === 1 && !bvhView.error, bvhView.error);
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
  // …including the six video-native.js makes (the device's HEVC and AV1 encoders; uncompressed AVI and Y4M saved in parts).
  const viewerFormats = ["mp4", "avi", "mov", "mxf", "dv", "webp", "flv", "rm", "cfhd", "utvideo", "hevc", "av1", "av1mp4", "avif", "y4m", "rawavi"];
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

  await checkRemoteFromPhone(win, js);
  await checkPhoneAsRig(win, js);
  await checkIphoneApp();
}

// The iPhone app (ios/: the same bundle, with Capacitor's iOS bridge, stood in for here with
// ?fakeplatform=ios): only its own plugins are used (Filesystem, Share, HandBrowser) and the
// Android-only parts stay hidden. The card is the hand mouse's, with the hand browser: a website
// opens full screen with the hand-mouse pointer on it, the app shrunk to just its camera (and
// the browser's buttons); the hand mouse's calls point at its link and click it (the next page
// opens), click into its text box and type; the ⚙ button shows the app over the website and
// back; Back goes back, Close closes it. Its self-test (what the build runs in the iPhone
// simulator: the layout, the small window moving out of the pointer's way, a drag scrolling)
// passes too.
async function checkIphoneApp() {
  const win = new BrowserWindow({
    show: false, width: 390, height: 844, useContentSize: true,
    webPreferences: { preload: path.join(__dirname, "fake-capacitor.js"), contextIsolation: false, sandbox: false, backgroundThrottling: false },
  });
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const logs = [];
  wc.on("console-message", (...args) => {
    const d = args[0] && typeof args[0].message === "string" ? args[0] : { level: args[1], message: args[2] };
    logs.push(d.message);
  });
  let out = {};
  try {
    await win.loadURL(`app://${HOST}/index.html?fakeplatform=ios&selftest=1`);
    for (let i = 0; i < 120 && !logs.some((m) => /^HT-SELFTEST /.test(m)); i++) await sleep(250);
    const line = logs.find((m) => /^HT-SELFTEST /.test(m));
    out.selfTest = line ? JSON.parse(line.slice(12)) : null;
    out.page = await js(`(async () => {
      const $ = (id) => document.getElementById(id);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const until = async (fn, ms = 10000) => { for (let t = 0; t < ms; t += 100) { const v = await fn(); if (v) return v; await sleep(100); } return null; };
      const out = {
        platform: mobile.platform, label: $("pcCard").querySelector(".section-label").textContent,
        shown: !$("pcCard").hidden && !$("handBrowser").hidden, android: [$("linkPhone").hidden, $("selfControl").hidden, $("deviceRow").hidden],
        noKeyboard: $("keyboardToggle").hidden, noRemote: !mobile.remote && !mobile.link && !mobile.phoneControl && !mobile.natnet,
      };
      await mobile.browser.close();
      $("hbUrl").value = "example.com";
      $("hbOpen").click();
      out.opened = !!(await until(async () => { const s = await mobile.browser.status(); return s.open && /Example Domain/.test(s.title) && !$("hbBar").hidden && s; }));
      out.mouseOn = PcControl.isMouseOn();
      out.barTitle = $("hbTitle").textContent;
      const pip = () => document.documentElement.classList.contains("hb-pip");
      out.small = pip() && getComputedStyle($("wrap")).position === "fixed" && $("hbMouse").textContent === "✋";
      $("hbApp").click();
      out.appShown = !!(await until(async () => (await mobile.browser.status()).app && !pip() && /Hand mouse: ON/.test($("hbMouse").textContent) && $("hbBack").hidden));
      $("hbApp").click();
      out.siteShown = !!(await until(async () => !(await mobile.browser.status()).app && pip() && !$("hbBack").hidden));
      await sleep(300);
      const link = await mobile.browser.where("#more");
      mobile.pc.pointer(link.x, link.y);
      await sleep(200);
      await mobile.pc.button("left", "click");
      out.followed = !!(await until(async () => /Example Domains/.test((await mobile.browser.status()).title)));
      const box = await mobile.browser.where("#box");
      mobile.pc.pointer(box.x, box.y);
      await sleep(200);
      await mobile.pc.button("left", "click");
      await mobile.pc.text("hello");
      out.typed = document.querySelector("iframe").contentDocument.getElementById("box").value;
      $("hbBack").click();
      out.back = !!(await until(async () => /Example Domain$/.test((await mobile.browser.status()).title)));
      $("hbClose").click();
      out.closed = !!(await until(async () => !(await mobile.browser.status()).open && $("hbBar").hidden && !pip()));
      out.opens = window.__fakeCapacitor.calls.filter((c) => c[0] === "handBrowser.open").map((c) => [c[1], c[2], c[3] > 1000]);
      return out;
    })()`);
  } catch (err) {
    out.error = String((err && err.message) || err);
  } finally {
    win.destroy();
  }
  const st = out.selfTest || {}, pg = out.page || {};
  check("The iPhone app: only its own plugins, the Android-only parts hidden; the hand browser opens a website full screen with the hand-mouse pointer on it and the app as just its camera, and the hand mouse's calls click its link (the next page opens), click into a box and type; the app shows over it and back; Back and Close work; and its self-test (as in the iPhone simulator: full screen, the small window moving off, a drag scrolling) passes",
    !out.error && st.ok === true && st.plugins.join() === "Filesystem,HandBrowser,Share" && pg.platform === "ios" && pg.label === "Hand mouse" && pg.shown &&
      pg.android.every(Boolean) && pg.noKeyboard && pg.noRemote && pg.opened && pg.mouseOn && /Example Domain/.test(pg.barTitle) && pg.small && pg.appShown && pg.siteShown && pg.followed && pg.typed === "hello" && pg.back && pg.closed &&
      pg.opens.length >= 2 && pg.opens.every(([url, aspect, script]) => /^https:\/\/example\.com\/?$/.test(url) && aspect > 0 && script),
    JSON.stringify(out));
}

// The phone as a rig, like a computer: another device (the PC's Hand Tracker, played here by
// plain requests) sees the phone's cameras listed (any new one ticked), picks the mode, starts
// the cameras (Several cameras, on the phone) and recording, sees the previews (bigger full
// screen), and the take is saved on the phone, named after its details.
async function checkPhoneAsRig(win, js) {
  const wc = win.webContents;
  await wc.loadURL(`app://${HOST}/index.html`);
  for (let i = 0; i < 60 && !(await js("!!(window.HandTracker && HandTracker.getCamera().width > 0)")); i++) await sleep(250);
  const out = {};
  const on = await js(`(async () => {
    const card = document.getElementById("remoteRec");
    document.getElementById("remoteToggle").click();
    let s = null;
    for (let i = 0; i < 50 && !(s && s.on); i++) { await new Promise((r) => setTimeout(r, 100)); s = await mobile.remote.status(); }
    await new Promise((r) => setTimeout(r, 300));
    return { card: !card.hidden, status: s, pair: !document.getElementById("remotePair").hidden, urls: document.getElementById("remoteUrls").textContent, folderBtn: !document.getElementById("remoteFolderBtn").hidden };
  })()`);
  out.on = { card: on.card, on: on.status && on.status.on, pair: on.pair, pasteable: /paste this address/.test(on.urls), folderBtn: on.folderBtn };
  const keyed = ((on.status && on.status.urls) || []).find((u) => u.keyed);
  const key = keyed ? new URL(keyed.url).hash.replace("#k=", "") : "";
  const base = `http://127.0.0.1:${on.status && on.status.port}`;
  const get = (p) => fetch(base + p, { headers: { "X-Key": key } });
  const post = async (body) => (await fetch(base + "/api/command", { method: "POST", headers: { "X-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  const state = async () => (await get("/api/state")).json();
  try {
    out.page = (await (await fetch(base + "/")).text()).includes('src="remote-client.js"');
    out.noKey = (await fetch(base + "/api/state")).status;
    const st = await state();
    out.state = { kind: st.kind, running: st.running, mode: st.mode, screenPictures: st.screenPictures };
    // The phone's cameras, listed before they start (a new one ticked by itself).
    await post({ action: "scan" });
    let a = null;
    for (let i = 0; i < 60 && !(a && a.at && !a.scanning); i++) {
      await sleep(200);
      a = (await state()).available;
    }
    // (Listed by name: Android gives cameras new ids every start, so picks and roles kept by id would be lost.)
    out.available = (a.cameras || []).map((c) => ({ present: c.present, use: c.use, byName: c.id.startsWith("cam:") }));
    out.mode = await post({ action: "mode", mode: "freeform" });
    out.refused = await post({ action: "record" });
    await post({ action: "details", details: { contributor: "Sam Smith", location: "Lab 2", task: "Pick up cup" } });
    // Start recording starts the cameras picked first.
    out.record = await post({ action: "record" });
    let rec = null;
    for (let i = 0; i < 100 && !(rec && rec.recording && rec.cameras.length && rec.cameras.every((c) => c.fps > 0)); i++) {
      await sleep(200);
      rec = await state();
    }
    out.recording = { recording: rec.recording, locked: rec.detailsLocked, cameras: rec.cameras.length, fps: rec.cameras.map((c) => c.fps) };
    // Hands in each camera's tile (the test camera shows none).
    await js(`Promise.all([...document.querySelectorAll("#multiCamGrid iframe")].map((f) => f.contentWindow.eval(${JSON.stringify(PAGE_SIMULATION)})))`);
    let pic = null;
    for (let i = 0; i < 30 && !(pic && pic.status === 200); i++) {
      pic = await get("/api/preview?i=0");
      if (pic.status !== 200) await sleep(150);
    }
    const small = Buffer.from(await pic.arrayBuffer());
    const fullRes = await get("/api/preview?i=0&full=1");
    const big = Buffer.from(await fullRes.arrayBuffer());
    const width = (b) => {
      for (let k = 2; k < b.length - 9; ) {
        if (b[k] !== 0xff) { k++; continue; }
        if (b[k + 1] >= 0xc0 && b[k + 1] <= 0xc3) return b.readUInt16BE(k + 7);
        k += 2 + b.readUInt16BE(k + 2);
      }
      return 0;
    };
    out.preview = { status: pic.status, small: width(small), full: fullRes.status, big: width(big) };
    out.stop = await post({ action: "stop" });
    const after = await state();
    out.take = after.lastTake;
    out.saved = await js(`[...window.__fakeCapacitor.files.keys()].filter((k) => /Sam-Smith_Lab-2_Pick-up-cup_/.test(k))`);
    out.close = await post({ action: "close" });
    await sleep(500);
    out.closed = !(await state()).running;
  } catch (err) {
    out.error = String((err && err.stack) || err);
  }
  out.off = await js(`(async () => { document.getElementById("remoteToggle").click(); await new Promise((r) => setTimeout(r, 300)); return !(await mobile.remote.status()).on; })()`);
  const t = out.take || {};
  check("Remote recording on the phone: another device lists the phone's cameras (new ones ticked), picks the mode, starts them and recording (the take details needed and locked), sees each camera (bigger full screen), and the take is saved on the phone, named after its details",
    !out.error && out.on.card && out.on.on && out.on.pair && out.on.pasteable && !out.on.folderBtn && out.page && out.noKey === 401 &&
      out.state.kind === "rig" && !out.state.running && out.state.screenPictures === undefined &&
      out.available.length >= 1 && out.available.every((c) => c.present && c.use && c.byName) &&
      out.mode.ok && out.refused.ok === false && (out.refused.missing || []).length === 3 &&
      out.record.ok && out.recording.recording && out.recording.locked && out.recording.cameras === out.available.length &&
      out.preview.status === 200 && out.preview.full === 200 && out.preview.big > out.preview.small &&
      out.stop.ok && t.ok && /^Sam-Smith_Lab-2_Pick-up-cup_\d+s_/.test((t.files || [])[0] || "") && out.saved.length >= 1 && out.close.ok && out.closed && out.off,
    JSON.stringify(out));
}

// Remote recording from the Android app: Remote recording at the top opens remote.html in
// place, and a computer's address (pasted with its code) opens that computer's page right here
// (remote-client.html), the app reaching it (Remote.rigRequest). The computer is played by a
// remote recording server here, with a stand-in for its main window.
async function checkRemoteFromPhone(win, js) {
  const { RemoteRecordServer } = require("../electron/remote-record.js");
  const wc = win.webContents;
  // From the app's main page (a check before may have left the Recording Viewer open).
  await wc.loadURL(`app://${HOST}/index.html`);
  for (let i = 0; i < 60 && !(await js("!!(window.HandTracker && HandTracker.getCamera().width > 0)")); i++) await sleep(250);
  const state = {
    running: false, recording: false, mode: "stereo", requirement: { ok: true, missing: [], message: "" }, detailsRequired: true,
    details: { contributor: "", location: "", task: "" }, cameras: [],
    available: { at: 1, scanning: false, note: "", cameras: [{ id: "oak:PHONE-TEST", label: "Luxonis OAK-D …E-TEST", present: true, use: true, role: "head" }] },
  };
  const asked = [];
  // Its takes folder: one take, to download to the phone and then delete from the computer.
  const takesDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "hand-tracker-android-takes-"));
  fs.writeFileSync(path.join(takesDir, "Phone-Take_1s_2026-10-02_12-00-00.json"), JSON.stringify({ format_version: 2, hands: [] }));
  const server = new RemoteRecordServer({
    keyStore: null, host: "rig-test", hotspot: () => null, takes: () => takesDir,
    page: (name) => fs.readFileSync(path.join(ROOT, name === "js" ? "remote-client.js" : "remote-client.html"), "utf8"),
    ask: async (action, extra) => {
      asked.push(action);
      if (action === "mode") state.mode = extra.mode;
      server.setState(state);
      return { ok: true, message: "" };
    },
  });
  server.setState(state);
  const { port } = await server.start();
  const out = {};
  // A step that leaves the page (its own answer may never come: the page goes first).
  const navigated = (step) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No page loaded (still at ${wc.getURL()})`)), 20000);
    wc.once("did-finish-load", () => {
      clearTimeout(timer);
      resolve();
    });
    Promise.resolve(step()).catch(() => {});
  });
  try {
    await navigated(() => js("document.getElementById('remoteLink').click(); true"));
    out.launcher = await js(`({ path: location.pathname, back: !document.getElementById("back").hidden, where: document.getElementById("whereNote").textContent })`);
    const address = `http://127.0.0.1:${port}/#k=${server.key}`;
    await navigated(() => js(`document.getElementById("host").value = ${JSON.stringify(address)}; document.querySelector("#connectForm button[type=submit]").click(); true`));
    out.client = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 100 && !/rig-test/.test(document.getElementById("title").textContent); i++) await sleep(150);
      const pressed = () => [...document.querySelectorAll("#modes button")].find((b) => b.getAttribute("aria-pressed") === "true").textContent;
      const before = pressed();
      document.querySelector('#modes button[data-mode="ego"]').click();
      for (let i = 0; i < 40 && pressed() !== "Ego"; i++) await sleep(150);
      return { path: location.pathname, hash: location.hash, title: document.getElementById("title").textContent, status: document.getElementById("status").textContent,
        rows: [...document.querySelectorAll("#camRows .camrow label")].map((r) => r.textContent.trim()), before, after: pressed(), back: !document.getElementById("back").hidden,
        calls: window.__fakeCapacitor.calls.filter((c) => c[0] === "remote.rigRequest").length, fits: document.documentElement.scrollWidth <= innerWidth + 1 };
    })()`);
    // Its takes, saved into Documents/Hand Tracker/Takes from <computer>, then deleted there.
    out.takes = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.getElementById("takesRefresh").click();
      const rows = () => [...document.querySelectorAll("#takeRows .takerow")];
      for (let i = 0; i < 100 && !rows().length; i++) await sleep(100);
      const listed = rows().length;
      rows()[0].querySelector("input").click();
      document.getElementById("takesGet").click();
      for (let i = 0; i < 100 && !/on this device|Nothing came/.test(document.getElementById("takesNote").textContent); i++) await sleep(100);
      const note = document.getElementById("takesNote").textContent;
      const saved = [...window.__fakeCapacitor.files.keys()].filter((k) => k.startsWith("Hand Tracker/Takes from rig-test/"));
      document.getElementById("takesDel").click();
      document.getElementById("takesDel").click();
      for (let i = 0; i < 100 && rows().length; i++) await sleep(100);
      return { listed, note, saved, after: rows().length };
    })()`);
    out.takesLeft = fs.readdirSync(takesDir);
    // One camera running, held upright (a phone's): it takes the whole grid, in its own tall
    // shape (no black bars), and the roles with no camera are listed under it.
    state.running = true;
    state.cameras = [{ index: 0, name: "Cam 1", roleId: "head", role: "Head", label: "camera 0, facing back", rotation: 0, mirror: true, fps: 30, hands: [], error: "" }];
    server.setState(state);
    const { nativeImage } = require("electron");
    const portrait = nativeImage.createFromBitmap(Buffer.alloc(180 * 320 * 4, 120), { width: 180, height: 320 }).toJPEG(70);
    const feed = setInterval(() => server.setPreview(0, portrait), 150);
    try {
      out.one = await js(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const img = () => document.querySelector("#cam0 img");
        for (let i = 0; i < 100 && !(img() && !img().hidden && img().naturalWidth); i++) await sleep(150);
        await sleep(300);
        const pic = document.querySelector("#cam0 .pic"), r = pic.getBoundingClientRect();
        return { one: document.getElementById("grid").classList.contains("one"), missing: document.getElementById("missing").textContent,
          ratio: pic.style.aspectRatio, w: Math.round(r.width), h: Math.round(r.height), boxes: document.querySelectorAll("#grid .cam").length };
      })()`);
    } finally {
      clearInterval(feed);
    }
  } catch (err) {
    out.error = String((err && err.stack) || err);
  } finally {
    server.stop();
  }
  out.asked = [...new Set(asked)];
  const c = out.client || {};
  check("Remote recording from the app: its page opens in place, and a computer's page opens right here, reaching the computer through the app (its cameras, a mode changed); one camera fills the grid in its own shape, the roles with none listed",
    !out.error && out.launcher.path === "/remote.html" && out.launcher.back && /opens here/.test(out.launcher.where) &&
      c.path === "/remote-client.html" && c.hash === "" && c.title === "Hand Tracker on rig-test" && /Cameras off/.test(c.status) && c.rows.length === 1 &&
      c.before === "Stereo" && c.after === "Ego" && c.back && c.calls > 2 && c.fits && out.asked.includes("mode") &&
      out.takes && out.takes.listed === 1 && /on this device \(Documents\/Hand Tracker\/Takes from rig-test\)/.test(out.takes.note) &&
      out.takes.saved.join() === "Hand Tracker/Takes from rig-test/Phone-Take_1s_2026-10-02_12-00-00.json" && out.takes.after === 0 && out.takesLeft.length === 0 &&
      out.one && out.one.one && out.one.boxes === 1 && out.one.missing === "Not connected: Chest, Left wrist, Right wrist" && out.one.ratio === "180 / 320" && out.one.h > out.one.w * 1.5,
    JSON.stringify(out));
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
