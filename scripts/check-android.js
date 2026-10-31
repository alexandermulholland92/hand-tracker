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
 *  5. checks Share and the Recording Converter's Back link,
 *  6. converts with ffmpeg.wasm as a phone would: the recording to other formats, an
 *     AVI opened for tracking, and a WMV (with sound) in the Recording Converter.
 * The native Filesystem/Share plugins themselves can only be tested on a device.
 */

const { app, BrowserWindow, protocol, session, ipcMain } = require("electron");
const { execSync, spawn, spawnSync } = require("child_process");
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
const MOUSE_WWW = path.join(outDir, "hand-mouse-www");
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
// The phone app's end of the Bluetooth link (BtRigProtocol.java, which BtRigLink.java carries
// over Bluetooth) speaks the link bt-link-client.js speaks (the website's and the apps' end): run
// on this computer's Java (Android Studio's, or JAVA_HOME's), a line each way instead of Bluetooth.
async function checkRigProtocolJava() {
  const isWin = process.platform === "win32";
  const home = [process.env.JAVA_HOME, isWin && "C:\\Program Files\\Android\\Android Studio\\jbr", !isWin && "/Applications/Android Studio.app/Contents/jbr/Contents/Home", !isWin && path.join(os.homedir(), "android-studio/jbr")]
    .find((d) => d && fs.existsSync(path.join(d, "bin", isWin ? "javac.exe" : "javac")));
  const name = "The phone app as a rig over Bluetooth (BtRigProtocol.java) and bt-link-client.js speak the same link: the password's key made alike, a session, each request and answer sealed, a long answer deflated in frames that fit, a long request in frames, a picture whole; the wrong password told so; two devices at once";
  if (!home) return check(name, true, "no Java here: skipped");
  const out = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hand-tracker-rig-java-"));
  const bin = (t) => path.join(home, "bin", isWin ? `${t}.exe` : t);
  const javac = spawnSync(bin("javac"), ["-nowarn", "-encoding", "UTF-8", "-d", dir,
    path.join(ROOT, "android/app/src/main/java/com/handtracker/app/BtRigProtocol.java"),
    path.join(__dirname, "jvm/org/json/JSONObject.java"), path.join(__dirname, "jvm/com/handtracker/app/RigProtocolHarness.java")], { encoding: "utf8" });
  out.compiles = javac.status === 0 || String(javac.stderr || javac.error).slice(0, 400);
  if (javac.status !== 0) return check(name, false, JSON.stringify(out));
  const BtLinkClient = require("../bt-link-client.js");
  const password = "correct horse 42";
  const java = spawn(bin("java"), ["-cp", dir, "com.handtracker.app.RigProtocolHarness", password], { stdio: ["pipe", "pipe", "pipe"] });
  let info = null, buf = "", frames = 0, frameMax = 0;
  const clients = [];
  const gotInfo = new Promise((resolve) => {
    java.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const [kind, data] = buf.slice(0, i).trim().split(" ");
        buf = buf.slice(i + 1);
        if (kind === "info") resolve((info = JSON.parse(Buffer.from(data, "base64").toString())));
        if (kind === "tx") {
          const f = Buffer.from(data, "base64");
          frames++;
          frameMax = Math.max(frameMax, f.length);
          for (const c of clients) c.received(new Uint8Array(f)); // (every device hears every notification)
        }
      }
    });
  });
  const MTU = 185;
  const client = (device, pw) => {
    const c = BtLinkClient.create({ password: pw, info, write: async (f) => { java.stdin.write(`rx ${device} ${MTU} ${Buffer.from(f).toString("base64")}\n`); } });
    clients.push(c);
    return c;
  };
  const dec = (r) => Buffer.from(r.bytes).toString();
  try {
    await Promise.race([gotInfo, sleep(30000).then(() => { throw new Error("No INFO from Java"); })]);
    out.info = { name: info.name, iter: info.iter, salt: !!info.salt, key: "key" in info };
    const a = client("AA", password);
    let t = Date.now();
    frames = 0;
    const st = await a.request({ path: "/api/state" });
    const state = JSON.parse(dec(st));
    out.state = { status: st.status, type: st.type, kind: state.kind, host: state.host, filler: state.filler.length, frames, frameMax, ms: Date.now() - t };
    const long = "x".repeat(2000);
    const cmd = await a.request({ method: "POST", path: "/api/command", body: JSON.stringify({ action: "scan", note: long }) });
    out.command = { status: cmd.status, echoed: JSON.parse(JSON.parse(dec(cmd)).got).note === long };
    const pic = await a.request({ path: "/api/preview?i=0" });
    out.picture = { status: pic.status, type: pic.type, bytes: pic.bytes.length, whole: [...pic.bytes].every((v, i) => v === (i * 31) % 251) };
    const b = client("BB", "wrong horse 42");
    out.wrong = await b.request({ path: "/api/state" }).then(() => "let in", (err) => (err.password ? "password" : err.message));
    // A second device with the password: its own session, both work.
    const c = client("CC", password);
    out.two = [(await c.request({ path: "/api/state" })).status, (await a.request({ path: "/api/state" })).status];
  } catch (err) {
    out.error = String((err && err.stack) || err);
  } finally {
    java.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  check(name,
    !out.error && out.compiles === true && out.info.name === "java-rig" && out.info.iter >= 100000 && out.info.salt && !out.info.key &&
      out.state.status === 200 && /json/.test(out.state.type) && out.state.kind === "rig" && out.state.host === "java-rig" && out.state.filler > 2000 &&
      out.state.frameMax <= MTU - 3 && out.state.frames < 10 &&
      out.command.status === 200 && out.command.echoed && out.picture.status === 200 && out.picture.type === "image/jpeg" && out.picture.bytes === 5000 && out.picture.whole &&
      out.wrong === "password" && out.two.join() === "200,200",
    JSON.stringify(out));
}

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
    "/api/preview?i=0&full=1&after=0", "/api/preview?i=3&full=1&after=123456789012", "/api/preview?i=0&full=1&after=1234567890123", "/api/preview?i=0&after=5",
    "/api/preview?i=0&full=1&after=-1", "/api/preview?i=0&full=1&after=", "/api/preview?i=0&full=1&after=1&x=1",
    "/api/take?f=Sam-Smith_2s.json&at=0", "/api/take?f=a%20b%2Fc.mcap&at=2097152", "/api/take?f=a/b.json&at=0", "/api/take?f=a.json", "/api/take?f=a.json&at=-1", "/api/take?f=&at=0",
    "/api/takes/x", "/api/state?x", "/api/../state", "/", "/remote-client.js"];
  out.differ = [...hosts.filter((h) => javaHost.test(h) !== RIG_HOST.test(h)), ...paths.filter((p) => javaPath.test(p) !== RIG_PATH.test(p))];
  out.samePathText = out.path === RIG_PATH.source.replace(/\\\//g, "/");
  // The iPhone app's (RemoteLink.swift), written the same way.
  const swift = fs.readFileSync(path.join(ROOT, "ios/App/App/RemoteLink.swift"), "utf8");
  const swiftPattern = (name) => {
    const m = new RegExp(`static let ${name} = "((?:[^"\\\\]|\\\\.)*)"`).exec(swift);
    return m ? m[1].replace(/\\\\/g, "\\") : null;
  };
  out.swiftSame = swiftPattern("RIG") === out.host && swiftPattern("RIG_PATH") === out.path;
  check("The Android and iPhone apps' rules for reaching a computer (RemotePlugin.java, RemoteLink.swift) match the desktop app's (remote-record.js): the same paths, and the same answer for every address and path tried",
    out.samePathText && !out.differ.length && out.swiftSame, JSON.stringify({ differ: out.differ, samePathText: out.samePathText, swiftSame: out.swiftSame }));
  // A camera picked from another device: on a phone its id is "cam:" and its name, with spaces and
  // commas. The apps' servers (RigServerPlugin.java, RigServer.swift) take the same ids as the
  // desktop app's (PICK_ID).
  const { PICK_ID } = require("../electron/remote-record.js");
  const unquote = (s) => s && s.replace(/\\(.)/g, "$1"); // (a Java or Swift string's text)
  const javaPick = unquote((/String PICK_ID = "((?:[^"\\]|\\.)*)"/.exec(fs.readFileSync(path.join(ROOT, "android/app/src/main/java/com/handtracker/app/RigServerPlugin.java"), "utf8")) || [])[1]);
  const swiftPick = unquote((/static let pickId = "((?:[^"\\]|\\.)*)"/.exec(fs.readFileSync(path.join(ROOT, "ios/App/App/RigServer.swift"), "utf8")) || [])[1]);
  const names = ["cam:camera 0, facing back", "cam:camera 1, facing front", "cam:Back Camera", "cam:Caméra arrière", "cam:USB Camera (046d:0825)", "cam:Camera 1", "cam:C:\\cams\\fake.mjpeg", "oak:1944301011673B2E00", "kinect:000123", "a".repeat(64)];
  const bad = ["", "a\nb", "a\tb", "<b>", 'a"b', "a'b", "a`b", "x".repeat(201)];
  const pick = { java: !!javaPick, swift: !!swiftPick };
  if (javaPick && swiftPick) {
    const javaRe = new RegExp(`^(?:${javaPick})$`), swiftRe = new RegExp(swiftPick); // (Java's matches() is the whole string)
    pick.differ = [...names, ...bad].filter((id) => javaRe.test(id) !== PICK_ID.test(id) || swiftRe.test(id) !== PICK_ID.test(id));
    pick.taken = names.filter((id) => PICK_ID.test(id)).length;
    pick.refused = bad.filter((id) => !PICK_ID.test(id)).length;
  }
  check("A camera picked from another device by its name (a phone's: \"cam:camera 0, facing back\") is taken by the Android and iPhone apps as by the desktop app (PICK_ID); quotes, angle brackets, control characters, nothing and over 200 characters are refused by all three",
    pick.java && pick.swift && !pick.differ.length && pick.taken === names.length && pick.refused === bad.length, JSON.stringify(pick));
  // Every request the remote page and the list of computers make (each ${…} as 0): ones the apps
  // let through, or the page asks and the apps refuse it (as full screen's &after= once was).
  const asked = [];
  for (const file of ["remote-client.js", "remote-launcher.js"]) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const m of src.matchAll(/["`](\/api\/[^"`]*)["`]/g)) asked.push(m[1].replace(/\$\{[^}]*\}/g, "0"));
  }
  const refused = asked.filter((p) => !RIG_PATH.test(p));
  check("Every request the remote page and the list of computers make to a computer is one the apps allow (full screen's included)",
    asked.some((p) => p.includes("&after=")) && !refused.length, JSON.stringify({ asked: asked.length, refused }));
}

async function run() {
  checkRigRulesMatch();
  await checkRigProtocolJava();
  execSync("node scripts/build-web.js", { cwd: ROOT, stdio: "inherit" });
  // Hand Mouse's files (its own app), served as app://hand-mouse/.
  execSync(`node scripts/build-web.js --hand-mouse --out "${MOUSE_WWW}"`, { cwd: ROOT, stdio: "inherit" });
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
    const root = url.host === "hand-mouse" ? MOUSE_WWW : WWW;
    const file = path.normalize(path.join(root, rel));
    if ((url.host !== HOST && url.host !== "hand-mouse") || !file.startsWith(root + path.sep) || !fs.existsSync(file)) return new Response("Not found", { status: 404 });
    return new Response(fs.readFileSync(file), { headers: { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" } });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media"));
  // npm run check:android -- --only iphone: just the iPhone app's check.
  const only = process.argv.includes("--only") ? String(process.argv[process.argv.indexOf("--only") + 1]) : "";
  if (/iphone/i.test(only)) {
    await checkIphoneApp();
    return checkIphoneRemote();
  }
  // npm run check:android -- --only own: just Hand Mouse's, Remote Recording's and Recording Converter's checks.
  if (/own/i.test(only)) return checkOwnApps();

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
  // npm run check:android -- --only remote: just remote recording from the app (once the app's up).
  if (/remote/i.test(only)) {
    await checkPhoneAsRig(win, js);
    await checkRemoteFromPhone(win, js);
    return checkRemoteBluetoothNetwork(win, js);
  }
  check("Converter link opens in place and buttons say Save",
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
  const motiveHidden = await js("motiveCard.hidden && !motiveToggle.hidden");
  await js("motiveToggle.click(); true");
  check("The Motive panel is hidden on the phone until More settings → OptiTrack Motive shows it, asking for Motive's PC",
    motiveHidden && (await js("!motiveCard.hidden && motiveServer.value === '' && /Motive PC/.test(motiveServer.placeholder)")));
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
    // A flick: the open hand moved quickly up swipes up; brought back down just as quickly
    // straight after, it doesn't swipe down; a moment later, a flick down swipes down. Slow
    // movements don't swipe at all, nor does the hand jumping (here, between these steps).
    await frames(10, [hand(0.6, 0.6)]);
    m = calls.length;
    await frames(14, (i) => [hand(0.6, 0.6 - i * 0.02)]); // (as quick as moving the pointer up the screen in a second)
    await frames(10, [hand(0.6, 0.6)]);
    out.slowFlicks = calls.slice(m).filter((c) => c[0] === "hand.swipe").length;
    m = calls.length;
    await frames(5, (i) => [hand(0.6, 0.6 - i * 0.06)]);
    await frames(10, [hand(0.6, 0.36)]);
    await frames(5, (i) => [hand(0.6, 0.36 + i * 0.06)]);
    await frames(25, [hand(0.6, 0.6)]);
    await frames(5, (i) => [hand(0.6, 0.6 + i * 0.06)]);
    await frames(10, [hand(0.6, 0.84)]);
    const swipes = calls.slice(m).filter((c) => c[0] === "hand.swipe");
    out.flicks = swipes.map((c) => (c[2] > c[4] ? "up" : "down"));
    out.flickTaps = calls.slice(m).filter((c) => c[0] === "hand.button").length;
    out.flickInside = swipes.every((c) => [c[2], c[4]].every((y) => y >= 0.149 && y <= 0.851) && c[1] === c[3]);
    return out;
  })()`).catch((err) => ({ error: String((err && err.message) || err) }));
  controlWin.destroy();
  check("The control window tracks with the camera and turns the hand mouse and gesture actions into taps and keys on the phone (a curl taps; Thumbs Up turns the volume up)",
    controlled.camera > 0 && controlled.mouse && controlled.pointers > 10 && (controlled.taps || []).includes("left click") && (controlled.keys || []).some((k) => /^volumeup/.test(k)),
    JSON.stringify(controlled));
  check("Control window on a touchscreen: one hand tracked (quicker); a curl held still taps rather than long-pressing; curled and moving drags; a hand low in the picture reaches the top",
    controlled.maxHands === 1 && (controlled.heldStill || []).join() === "left click" && (controlled.swipe || []).join() === "left down,left up" && controlled.top < 0.1,
    JSON.stringify({ maxHands: controlled.maxHands, heldStill: controlled.heldStill, swipe: controlled.swipe, top: controlled.top }));
  check("Control window: a quick flick of the open hand up swipes up and one down swipes down (inside the screen, away from its edges, no taps); the hand coming back doesn't swipe back, and slow movements or the hand jumping don't swipe",
    (controlled.flicks || []).join() === "up,down" && controlled.slowFlicks === 0 && controlled.flickTaps === 0 && controlled.flickInside,
    JSON.stringify({ flicks: controlled.flicks, slow: controlled.slowFlicks, taps: controlled.flickTaps, inside: controlled.flickInside }));

  await js("document.querySelector('a[href=\"viewer.html\"]').click()");
  await sleep(1500);
  check("Recording Converter opens in place with a Back link", await js("location.pathname.endsWith('viewer.html') && !!document.querySelector('a.back-link[href=\"index.html\"]')"));

  // The converter on the phone: import the CSV and C3D just saved, convert, and save through Android.
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
  check("The converter imports the CSV on the phone", csvView.hands === 2 && !csvView.error, csvView.error);
  const csvSaved = await viewerSave("phone-from-csv", 9);
  check("…and saves all 8 formats from it through Android (9 files)", csvSaved.ok === 9 && csvSaved.share === 9 && csvSaved.label === "Save", JSON.stringify(csvSaved));
  // The app's own C3D and BVH hold hands: they open as those hands again, with every format.
  const c3dView = await viewerOpen("rec.c3d", find(".c3d"));
  check("The converter imports the app's C3D on the phone as both hands again", c3dView.hands === 2 && !c3dView.error, c3dView.error);
  const c3dSaved = await viewerSave("phone-from-c3d", 9);
  check("…and saves all 8 formats from it through Android (9 files)", c3dSaved.ok === 9, JSON.stringify(c3dSaved));
  const bvhView = await viewerOpen("rec-left.bvh", find("-left.bvh"));
  check("The converter imports a BVH on the phone (as its hand)", bvhView.hands === 1 && !bvhView.error, bvhView.error);
  const takMsg = await js(`(async () => {
    const input = document.getElementById("fileInput"), dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(8)], "Take1.tak"));
    input.files = dt.files;
    input.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 300));
    return (document.querySelector("#results .error") || {}).textContent || "";
  })()`);
  check("A .tak file on the phone explains it needs the Windows app with Motive", /Windows app/.test(takMsg) && /Motive/.test(takMsg), takMsg.slice(0, 90));

  // The converter on the phone: a WMV with sound (no phone plays it) previewed and converted with ffmpeg.wasm.
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
  check(`The converter on the phone previews a WMV (converted) and converts it to ${viewerFormats.length} formats`, vv.width === 640 && vv.ok === viewerFormats.length && vv.share === viewerFormats.length,
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
  await checkRemoteBluetoothNetwork(win, js);
  await checkPhoneAsRig(win, js);
  await checkIphoneApp();
  await checkIphoneRemote();
  await checkOwnApps();
}

// Hand Mouse, Remote Recording and Recording Converter, the apps of their own, as the phone apps
// open them (Capacitor stood in for, with only each Android app's plugins: ?fakeapp=;
// ?fakeplatform=ios for the iPhone's):
//  - Hand Mouse on Android: its four choices (this phone, a PC, Bluetooth mouse, My gestures),
//    none of the computers' or the iPhone's; My gestures starts the camera, Back lets it go;
//    This phone's page has no gesture actions, though those set up on A PC's still run. On
//    an iPhone: the hand browser and My gestures, and its self-test (the hand browser, as in the
//    simulator) passes, with no remote recording in it.
//  - Remote Recording on Android: its two choices; Control a rig opens remote.html with the way
//    back to it; Be a rig opens Hand Tracker's page as a rig: only the cameras, Record and
//    Several cameras (no hand cards, 3D view, hand mouse or video recording), remote recording
//    on, no camera started, and the way back, where remote recording stops. On an iPhone its
//    self-test goes to the rig and passes there (remote recording's part too).
//  - Recording Converter on Android: its first page opens the Recording Converter in its place
//    (Back leaves the app), without the remote recording's or the hand mouse's plugins, without
//    a "Back to tracker", and its own check passes (a recording converted to every motion format
//    and read back). On an iPhone that check is its self-test, run by itself.
async function checkOwnApps() {
  // (landsOn: the page a first page opens straight away in its place, which it waits for.)
  const open = async (url, landsOn = null) => {
    const win = new BrowserWindow({
      show: false, width: 412, height: 915, useContentSize: true,
      webPreferences: { preload: path.join(__dirname, "fake-capacitor.js"), contextIsolation: false, sandbox: false, backgroundThrottling: false },
    });
    const logs = [];
    win.webContents.on("console-message", (...args) => {
      const d = args[0] && typeof args[0].message === "string" ? args[0] : { level: args[1], message: args[2] };
      logs.push(d.message);
    });
    const landed = landsOn && new Promise((resolve) => win.webContents.on("did-finish-load", () => win.webContents.getURL().includes(landsOn) && resolve()));
    await win.loadURL(url).catch((err) => {
      if (!landsOn) throw err; // (the first page's own load is cut short by the next one)
    });
    if (landed) await Promise.race([landed, sleep(15000)]);
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const selfTest = async () => {
      for (let i = 0; i < 160 && !logs.some((m) => /^HT-SELFTEST /.test(m)); i++) await sleep(250);
      const line = logs.find((m) => /^HT-SELFTEST /.test(m));
      return line ? JSON.parse(line.slice(12)) : null;
    };
    return { win, js, selfTest };
  };
  const shownChoices = `[...document.querySelectorAll(".choice")].filter((b) => !b.hidden && !b.disabled).map((b) => b.dataset.mode).join()`;
  const UNTIL = `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 15000) => { for (let t = 0; t < ms; t += 100) { const v = await fn(); if (v) return v; await sleep(100); } return null; };`;
  const out = {};

  // Hand Mouse, Android.
  let w = await open(`app://hand-mouse/index.html?fakeapp=mouse`);
  try {
    out.mouseAndroid = await w.js(`(async () => {
      ${UNTIL}
      const r = { platform: HandMouse.platform(), choices: ${shownChoices}, noApp: document.getElementById("noApp").hidden };
      HandMouse.choose("gestures");
      const video = document.getElementById("video");
      r.camera = !!(await until(() => video.srcObject && video.srcObject.getVideoTracks().some((t) => t.readyState === "live")));
      r.shown = !document.getElementById("stageWrap").hidden && !document.getElementById("gestureNow").hidden && document.getElementById("cameraRow").hidden;
      history.back();
      r.released = !!(await until(() => !HandMouse.mode() && !(video.srcObject && video.srcObject.getVideoTracks().some((t) => t.readyState === "live"))));
      r.chooser = !document.getElementById("chooser").hidden;
      // Gesture actions: set up on A PC's page (turned on there), not on This phone's, where
      // they still run (handed to the control window). The hand mouse's settings are kept there.
      const $ = (id) => document.getElementById(id);
      const seen = (id) => !!$(id).offsetParent;
      HandMouse.choose("pc");
      r.pcActions = seen("actionsToggle") && seen("addAction");
      const turnOn = $("actionsToggle").getAttribute("aria-pressed") !== "true";
      if (turnOn) $("actionsToggle").click();
      history.back();
      await until(() => !HandMouse.mode());
      HandMouse.choose("phone");
      const started = await until(() => window.__fakeCapacitor.calls.find((c) => c[0] === "phoneControl.start"));
      r.phone = { part: seen("phonePart"), actions: seen("actionsToggle") || seen("addAction") || seen("actionList"), hand: seen("mouseHand"),
        actionsRun: !!(started && JSON.parse(started[1]).actionsOn === true && Array.isArray(JSON.parse(started[1]).rules)) };
      history.back();
      await until(() => !HandMouse.mode());
      if (turnOn) $("actionsToggle").click(); // (as it was)
      return r;
    })()`);
  } catch (err) {
    out.mouseAndroid = { error: String((err && err.message) || err) };
  } finally {
    w.win.destroy();
  }

  // Hand Mouse, iPhone: its self-test.
  w = await open(`app://hand-mouse/index.html?fakeplatform=ios&selftest=1`);
  try {
    const st = await w.selfTest();
    out.mouseIos = { ...(await w.js(`({ platform: HandMouse.platform(), choices: ${shownChoices} })`)), selfTest: st && { ok: st.ok, rig: st.rig, full: st.full, small: st.small, moved: st.moved, error: st.error } };
  } catch (err) {
    out.mouseIos = { error: String((err && err.message) || err) };
  } finally {
    w.win.destroy();
  }

  // Remote Recording, Android: control a rig, then be one.
  w = await open(`app://${HOST}/remote-recording.html?fakeapp=remote`);
  try {
    out.remoteAndroid = await w.js(`({ choices: ${shownChoices}, noApp: document.getElementById("noApp").hidden })`);
    const loaded = (page) => new Promise((resolve) => w.win.webContents.once("did-finish-load", () => resolve(w.win.webContents.getURL().includes(page))));
    let next = loaded("remote.html");
    await w.js(`document.querySelector('.choice[data-mode="control"]').click(); true`);
    out.remoteAndroid.control = await next;
    out.remoteAndroid.back = await w.js(`(() => { const a = document.querySelector("#back a"); return { shown: !document.getElementById("back").hidden, text: a.textContent, href: a.getAttribute("href") }; })()`);
    next = loaded("remote-recording.html");
    await w.js(`document.querySelector("#back a").click(); true`);
    out.remoteAndroid.backed = await next;
    next = loaded("index.html?rig=1");
    await w.js(`document.querySelector('.choice[data-mode="rig"]').click(); true`);
    out.remoteAndroid.rig = await next;
    out.remoteAndroid.rigPage = await w.js(`(async () => {
      ${UNTIL}
      const $ = (id) => document.getElementById(id);
      const gone = (el) => !el || getComputedStyle(el).display === "none" || !el.offsetParent;
      const on = !!(await until(() => $("remoteToggle").getAttribute("aria-pressed") === "true", 20000));
      await until(() => /Waiting for the phone|Couldn't/.test($("stageMessage").textContent), 20000); // (once the hand model's loaded)
      const video = $("video");
      return {
        rigClass: document.documentElement.classList.contains("rig-app"), title: document.title, home: !$("rigHome").hidden && $("rigHome").getAttribute("href"),
        hidden: ["pcCard", "viz3dCard", "legend", "panels", "videoRow", "openVideoBtn"].filter((id) => !gone($(id))),
        kept: ["wrap", "motionBtn", "remoteRec", "cameraSelect"].filter((id) => gone($(id))),
        remoteOn: on, noCamera: !(video.srcObject && video.srcObject.getVideoTracks().length), waiting: $("stageMessage").textContent,
      };
    })()`);
    // Back to the choices: remote recording stops there.
    next = loaded("remote-recording.html");
    await w.js(`document.getElementById("rigHome").click(); true`);
    out.remoteAndroid.home = await next;
    out.remoteAndroid.stopped = await w.js(`new Promise((r) => setTimeout(() => r(window.__fakeCapacitor.calls.some((c) => c[0] === "rig.stop")), 500))`);
  } catch (err) {
    out.remoteAndroid = { ...(out.remoteAndroid || {}), error: String((err && err.message) || err) };
  } finally {
    w.win.destroy();
  }

  // Remote Recording, iPhone: its self-test, from its first page to the rig.
  w = await open(`app://${HOST}/remote-recording.html?fakeplatform=ios&selftest=1`);
  try {
    const st = await w.selfTest();
    out.remoteIos = { url: w.win.webContents.getURL().replace(/^app:\/\/[^/]+/, ""), selfTest: st && { ok: st.ok, rig: st.rig && { ok: st.rig.ok, on: st.rig.on, error: st.rig.error }, error: st.error } };
    out.remoteIos.rigClass = await w.js(`document.documentElement.classList.contains("rig-app")`);
  } catch (err) {
    out.remoteIos = { error: String((err && err.message) || err) };
  } finally {
    w.win.destroy();
  }

  // Recording Converter, Android: its first page, then the converter; its own check.
  const converterPage = `(async () => {
    const st = await RecordingViewer.selfTest();
    return { title: document.title, back: !!document.querySelector("a.back-link"), plugins: Object.keys(Capacitor.Plugins).sort().join(),
      selfTest: { ok: st.ok, ownApp: st.ownApp, error: st.error, formats: Object.entries(st.formats).map(([f, x]) => f + ":" + x.frames).join() } };
  })()`;
  w = await open(`app://${HOST}/recording-converter.html?fakeapp=converter`, "viewer.html");
  try {
    out.converterAndroid = { url: w.win.webContents.getURL().replace(/^app:\/\/[^/]+/, ""), ...(await w.js(converterPage)) };
    out.converterAndroid.canGoBack = (w.win.webContents.navigationHistory || w.win.webContents).canGoBack();
  } catch (err) {
    out.converterAndroid = { error: String((err && err.message) || err) };
  } finally {
    w.win.destroy();
  }

  // Recording Converter, iPhone: its self-test, run by itself on the converter.
  w = await open(`app://${HOST}/recording-converter.html?fakeplatform=ios&selftest=1`, "viewer.html");
  try {
    const st = await w.selfTest();
    out.converterIos = { url: w.win.webContents.getURL().replace(/^app:\/\/[^/]+/, ""), selfTest: st && { ok: st.ok, ownApp: st.ownApp, back: st.back, error: st.error } };
  } catch (err) {
    out.converterIos = { error: String((err && err.message) || err) };
  } finally {
    w.win.destroy();
  }

  const ma = out.mouseAndroid || {}, mi = out.mouseIos || {}, ra = out.remoteAndroid || {}, ri = out.remoteIos || {};
  const ca = out.converterAndroid || {}, ci = out.converterIos || {};
  check("Hand Mouse (Android): its four choices only (this phone, a PC, Bluetooth mouse, My gestures); My gestures starts the camera, Back lets it go",
    !ma.error && ma.platform === "android" && ma.choices === "phone,pc,bluetooth,gestures" && ma.noApp && ma.camera && ma.shown && ma.released && ma.chooser, JSON.stringify(ma));
  check("Hand Mouse (Android): This phone's page has no gesture actions (A PC's has), and those set up there still run while it controls the phone; its hand mouse settings stay",
    !ma.error && ma.pcActions && ma.phone && ma.phone.part && !ma.phone.actions && ma.phone.hand && ma.phone.actionsRun, JSON.stringify(ma.phone || ma));
  check("Hand Mouse (iPhone): the hand browser and My gestures, and its self-test (the hand browser full screen, the small window moving off) passes, with no remote recording in it",
    !mi.error && mi.platform === "ios" && mi.choices === "browser,gestures" && mi.selfTest && mi.selfTest.ok === true && mi.selfTest.rig && !!mi.selfTest.rig.skipped, JSON.stringify(mi));
  const rp = ra.rigPage || {};
  check("Remote Recording (Android): Control a rig opens the computers' list with the way back to it; Be a rig opens Hand Tracker's page as a rig: only the cameras, Record and Several cameras, remote recording on, no camera until it's asked, and the way back, where remote recording stops",
    !ra.error && ra.choices === "control,rig" && ra.noApp && ra.control && ra.back && ra.back.shown && ra.back.text === "← Remote Recording" && ra.back.href === "remote-recording.html" && ra.backed && ra.rig && ra.home && ra.stopped &&
      rp.rigClass && rp.title === "Remote Recording" && rp.home === "remote-recording.html" && rp.hidden.length === 0 && rp.kept.length === 0 && rp.remoteOn && rp.noCamera && /Waiting for the phone/.test(rp.waiting),
    JSON.stringify(ra));
  check("Remote Recording (iPhone): its self-test goes from its first page to the rig and passes there (remote recording's part too)",
    !ri.error && ri.url === "/index.html?rig=1" && ri.rigClass && ri.selfTest && ri.selfTest.ok === true && ri.selfTest.rig && ri.selfTest.rig.ok === true, JSON.stringify(ri));
  check("Recording Converter (Android): its first page opens the Recording Converter in its place (Back leaves the app), with only its own plugins and no Back to tracker; a recording converts to every motion format, each read back as the same hand",
    !ca.error && ca.url === "/viewer.html" && !ca.canGoBack && ca.title === "Recording Converter" && !ca.back && ca.plugins === "Filesystem,Remote,Share" &&
      ca.selfTest && ca.selfTest.ok === true && ca.selfTest.ownApp === true, JSON.stringify(ca));
  check("Recording Converter (iPhone): its self-test runs by itself on the converter and passes",
    !ci.error && ci.url === "/viewer.html" && ci.selfTest && ci.selfTest.ok === true && ci.selfTest.ownApp === true && ci.selfTest.back === false, JSON.stringify(ci));
}

// The iPhone app (ios/: the same bundle, with Capacitor's iOS bridge, stood in for here with
// ?fakeplatform=ios): only its own plugins are used (Filesystem, Share, HandBrowser) and the
// Android-only parts stay hidden. The card is the hand mouse's, with the hand browser: a website
// opens full screen with the hand-mouse pointer on it, the app shrunk to just its camera (and
// the browser's buttons); the hand mouse's calls point at its link and click it (the next page
// opens), click into its text box and type; the ⚙ button shows the app over the website and
// back; Back goes back, Close closes it. Its self-test (what the build runs in the iPhone
// simulator: the layout, the small window moving out of the pointer's way, a drag scrolling,
// the website and the app ending at the keyboard's top) passes too.
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
        noKeyboard: $("keyboardToggle").hidden, noRemote: !mobile.link && !mobile.phoneControl && !mobile.natnet,
        rigCard: !!mobile.remote && !$("remoteRec").hidden,
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
  check("The iPhone app: only its own plugins, the Android-only parts hidden, remote recording on it there (its self-test: the server, the key needed, its state and a command through the app's own requests; its Bluetooth link with the right password and a wrong one); the hand browser opens a website full screen with the hand-mouse pointer on it and the app as just its camera, and the hand mouse's calls click its link (the next page opens), click into a box and type; the app shows over it and back; Back and Close work; and its self-test (as in the iPhone simulator: full screen, the small window moving off, a drag scrolling, the website and the app ending at the keyboard's top while it's up) passes",
    !out.error && st.ok === true && st.plugins.join() === "BtLink,Filesystem,HandBrowser,RigLink,RigServer,Share" && pg.platform === "ios" && pg.label === "Hand mouse" && pg.shown &&
      st.rig && st.rig.ok === true && pg.android.every(Boolean) && pg.noKeyboard && pg.noRemote && pg.rigCard && pg.opened && pg.mouseOn && /Example Domain/.test(pg.barTitle) && pg.small && pg.appShown && pg.siteShown && pg.followed && pg.typed === "hello" && pg.back && pg.closed &&
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
  // Over Bluetooth too, once a Bluetooth password is set (too short a one refused).
  out.bluetooth = await js(`(async () => {
    const $ = (id) => document.getElementById(id);
    const wait = () => new Promise((r) => setTimeout(r, 300));
    const before = { row: !$("remoteBtRow").hidden, status: $("remoteBtStatus").textContent };
    $("remoteBtPassword").value = "short";
    $("remoteBtSet").click();
    await wait();
    const short = $("remoteBtStatus").textContent;
    $("remoteBtPassword").value = "a long enough one";
    $("remoteBtSet").click();
    await wait();
    return { before, short, after: $("remoteBtStatus").textContent, cleared: $("remoteBtPassword").value === "", asked: window.__fakeCapacitor.calls.filter((c) => c[0] === "rig.setBluetoothPassword").length };
  })()`);
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
    // The room left on the phone, its battery and its temperature, there and in the app (RigServer's storage()).
    out.room = { storage: st.storage && st.storage.text, battery: st.battery && st.battery.text, temperature: st.temperature, card: await js(`document.getElementById("remoteRoomRow").hidden ? "" : document.getElementById("remoteRoom").textContent`) };
    // The phone's cameras, listed before they start (a new one ticked by itself).
    await post({ action: "scan" });
    let a = null;
    for (let i = 0; i < 60 && !(a && a.at && !a.scanning); i++) {
      await sleep(200);
      a = (await state()).available;
    }
    // (Listed by name: Android gives cameras new ids every start, so picks and roles kept by id would be lost.)
    out.available = (a.cameras || []).map((c) => ({ present: c.present, use: c.use, byName: c.id.startsWith("cam:") }));
    // (About how many hours of takes the phone's cameras leave room for; once picked (from here: its
    // id is its name), still so after a look that couldn't list them, as one before the camera's
    // first opened can't.)
    out.roomTakes = ((await state()).storage || {}).text;
    out.pickId = a.cameras[0].id;
    out.picked = await post({ action: "pick", pick: { id: a.cameras[0].id, use: true } });
    out.roomUnlisted = await js(`RemoteRecordUI._room.unlisted().storage.text`);
    out.mode = await post({ action: "mode", mode: "freeform" });
    // (The take details are optional; with the page's hidden switch on, needed first.)
    out.defaultRequired = (await state()).detailsRequired;
    await post({ action: "settings", settings: { detailsRequired: true } });
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
    await post({ action: "settings", settings: { detailsRequired: false } });
    out.close = await post({ action: "close" });
    await sleep(500);
    out.closed = !(await state()).running;
  } catch (err) {
    out.error = String((err && err.stack) || err);
  }
  out.off = await js(`(async () => { document.getElementById("remoteToggle").click(); await new Promise((r) => setTimeout(r, 300)); return !(await mobile.remote.status()).on; })()`);
  const t = out.take || {};
  check("Remote recording on the phone: over Bluetooth too once its password is set (too short refused); the space left (and about how many hours of takes its cameras have room for), its battery and its battery's temperature shown, there and in the app; another device lists the phone's cameras (new ones ticked), picks the mode, starts them and recording (the take details optional; with the hidden switch on, needed; locked while recording), sees each camera (bigger full screen), and the take is saved on the phone, named after its details",
    !out.error && out.on.card && out.on.on && out.on.pair && out.on.pasteable && !out.on.folderBtn && out.page && out.noKey === 401 &&
      out.bluetooth.before.row && /set a password/.test(out.bluetooth.before.status) && /8 to 63/.test(out.bluetooth.short) &&
      out.bluetooth.after === "on, with its password" && out.bluetooth.cleared && out.bluetooth.asked === 1 &&
      out.state.kind === "rig" && !out.state.running && out.state.screenPictures === undefined &&
      /^52\.0 GB free of 128 GB/.test(out.room.storage || "") && out.room.battery === "Battery 62%: about 6 h left" &&
      out.room.card.startsWith("Space: 52.0 GB free of 128 GB") && out.room.card.endsWith(" · Battery 62%: about 6 h left · Battery temperature: 31 °C") &&
      out.room.temperature && out.room.temperature.text === "Battery temperature: 31 °C" && out.room.temperature.hot === false &&
      out.available.length >= 1 && out.available.every((c) => c.present && c.use && c.byName) &&
      /^52\.0 GB free of 128 GB · about .+ of takes \(\d+ cameras?, /.test(out.roomTakes || "") && (out.roomTakes || "").includes(` of takes (${out.available.length} camera`) && out.picked.ok && out.roomUnlisted === out.roomTakes &&
      out.mode.ok && out.defaultRequired === false && out.refused.ok === false && (out.refused.missing || []).length === 3 &&
      out.record.ok && out.recording.recording && out.recording.locked && out.recording.cameras === out.available.length &&
      out.preview.status === 200 && out.preview.full === 200 && out.preview.big > out.preview.small &&
      out.stop.ok && t.ok && /^Sam-Smith_Lab-2_Pick-up-cup_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_\d+s[.-]/.test((t.files || [])[0] || "") && out.saved.length >= 1 && out.close.ok && out.closed && out.off,
    JSON.stringify(out));
}

// Remote recording from the Android app: Remote recording at the top opens remote.html in
// place, and a computer's address (pasted with its code) opens that computer's page right here
// (remote-client.html), the app reaching it (Remote.rigRequest). The computer is played by a
// remote recording server here, with a stand-in for its main window.
async function checkRemoteFromPhone(win, js) {
  const { RemoteRecordServer } = require("../electron/remote-record.js");
  const wc = win.webContents;
  // From the app's main page (a check before may have left the Recording Converter open).
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
  fs.writeFileSync(path.join(takesDir, "Phone-Take_2026-10-02_12-00-00_1s.json"), JSON.stringify({ format_version: 2, hands: [] }));
  const server = new RemoteRecordServer({
    keyStore: null, host: "rig-test", hotspot: () => null, takes: () => takesDir,
    page: (name) => fs.readFileSync(path.join(ROOT, name === "js" ? "remote-client.js" : name === "bt" ? "bt-link-client.js" : "remote-client.html"), "utf8"),
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
      out.takes.saved.join() === "Hand Tracker/Takes from rig-test/Phone-Take_2026-10-02_12-00-00_1s.json" && out.takes.after === 0 && out.takesLeft.length === 0 &&
      out.one && out.one.one && out.one.boxes === 1 && out.one.missing === "Not connected: Chest, Left wrist, Right wrist" && out.one.ratio === "180 / 320" && out.one.h > out.one.w * 1.5,
    JSON.stringify(out));
}

// Remote recording from the iPhone app (?fakeplatform=ios): remote.html offers Bluetooth (not a
// Bluetooth network: an iPhone has none), a computer's address opens its page right here, the
// app reaching it (RigLink, RemoteLink.swift); and over Bluetooth Low Energy (BtLink, the
// computer's link electron/bluetooth-link.js running here): its password the first time, the
// computer asked for by name picked from those near by, a camera's picture when tapped.
async function checkIphoneRemote() {
  const { RemoteRecordServer } = require("../electron/remote-record.js");
  const { BluetoothLink, makeSecret } = require("../electron/bluetooth-link.js");
  const win = new BrowserWindow({
    show: false, width: 390, height: 844, useContentSize: true,
    webPreferences: { preload: path.join(__dirname, "fake-capacitor.js"), contextIsolation: false, sandbox: false, backgroundThrottling: false },
  });
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const state = {
    running: true, recording: false, mode: "freeform", requirement: { ok: true, missing: [], message: "" }, detailsRequired: false,
    details: { contributor: "", location: "", task: "" },
    cameras: [{ index: 0, name: "Cam 1", roleId: "head", role: "Head", label: "camera 0", rotation: 0, mirror: false, fps: 30, hands: [], error: "" }],
    available: { at: 1, scanning: false, note: "", cameras: [] },
  };
  const server = new RemoteRecordServer({
    keyStore: null, host: "rig-test", hotspot: () => null,
    page: (name) => fs.readFileSync(path.join(ROOT, name === "js" ? "remote-client.js" : name === "bt" ? "bt-link-client.js" : "remote-client.html"), "utf8"),
    ask: async () => ({ ok: true, message: "" }),
  });
  server.setState(state);
  server.setPreview(0, require("electron").nativeImage.createFromBitmap(Buffer.alloc(64 * 48 * 4, 120), { width: 64, height: 48 }).toJPEG(70));
  const { port } = await server.start();
  const secret = { ...makeSecret("correct horse 42"), from: "hotspot" };
  const link = new BluetoothLink({ name: "rig-test", secret: () => secret, relay: (r) => server.relay(r), send: (frame) => !wc.isDestroyed() && wc.send("fake-btlink:notify", frame.toString("base64")) });
  ipcMain.handle("fake-btlink:info", () => link.info().toString("base64"));
  ipcMain.handle("fake-btlink:write", (_e, b64) => link.received("/dev/fake-iphone", Buffer.from(b64, "base64"), 185));
  const navigated = (step) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No page loaded (still at ${wc.getURL()})`)), 20000);
    wc.once("did-finish-load", () => {
      clearTimeout(timer);
      resolve();
    });
    Promise.resolve(step()).catch(() => {});
  });
  const PAGE = `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const $ = (id) => document.getElementById(id);
    const until = async (fn, ms = 15000) => { for (let t = 0; t < ms; t += 100) { const v = fn(); if (v) return v; await sleep(100); } return null; };
    const shown = (id) => !!$(id) && !$(id).hidden && !$(id).closest("[hidden]");
  `;
  const out = {};
  try {
    await win.loadURL(`app://${HOST}/remote.html?fakeplatform=ios`);
    await js(`localStorage.setItem("__fakeBtLe", ${JSON.stringify(JSON.stringify([{ id: "1F0E-OTHER", name: "Other" }, { id: "1F0E-RIG", name: "rig-test" }]))}); localStorage.removeItem("hand-tracker-bluetooth-keys"); true`);
    out.launcher = await js(`(async () => {
      ${PAGE}
      return { platform: Capacitor.getPlatform(), card: shown("btCard"), web: shown("btWeb"), android: shown("btAndroid"), settings: shown("btSettings"), where: $("whereNote").textContent };
    })()`);
    await navigated(() => js(`document.getElementById("host").value = ${JSON.stringify(`http://127.0.0.1:${port}/#k=${server.key}`)}; document.querySelector("#connectForm button[type=submit]").click(); true`));
    out.network = await js(`(async () => {
      ${PAGE}
      const title = await until(() => /rig-test/.test($("title").textContent) && $("title").textContent);
      return { path: location.pathname + location.search, title, riglink: window.__fakeCapacitor.calls.filter((c) => c[0] === "riglink.rigRequest").length };
    })()`);
    // Its Bluetooth button (beside the computer saved on remote.html) opens it over Bluetooth.
    await wc.loadURL(`app://${HOST}/remote.html`);
    await navigated(() => js(`[...document.querySelectorAll("#saved button")].find((b) => b.textContent === "Bluetooth").click(); true`));
    out.ble = await js(`(async () => {
      ${PAGE}
      const panel = await until(() => shown("btPanel") && shown("btPassword"));
      $("btPassword").value = "correct horse 42";
      $("btConnect").click();
      // (Saved as 127.0.0.1, it's "rig-test" over Bluetooth: picked from the two near by.)
      const pick = await until(() => [...$("btDevices").querySelectorAll("button")].find((b) => b.textContent === "rig-test"));
      const listed = [...$("btDevices").querySelectorAll("button")].map((b) => b.textContent);
      const asked = $("btNote").textContent;
      if (pick) pick.click();
      const title = await until(() => /[(]Bluetooth[)]/.test($("title").textContent) && $("title").textContent);
      if (!title) return { path: decodeURIComponent(location.search), panel: !!panel, title: $("title").textContent, message: $("message").textContent, note: $("btNote").textContent, calls: window.__fakeCapacitor.calls.filter((c) => c[0].startsWith("btlink.")).map((c) => c.join(" ")) };
      await until(() => document.querySelector("#cam0 .pic span") && /tap for its picture/.test(document.querySelector("#cam0 .pic span").textContent));
      if (!document.querySelector("#cam0 .pic")) return { title, noCam: true, status: $("status").textContent };
      document.querySelector("#cam0 .pic").click();
      const picture = !!(await until(() => !document.querySelector("#cam0 img").hidden && document.querySelector("#cam0 img").naturalWidth === 64));
      const calls = window.__fakeCapacitor.calls.filter((c) => c[0].startsWith("btlink.")).map((c) => c.join(" "));
      return { path: decodeURIComponent(location.search), panel: !!panel, listed, asked, title, picture, calls, kept: (localStorage.getItem("hand-tracker-bluetooth-keys") || "").length };
    })()`);
  } catch (err) {
    out.error = String((err && err.stack) || err);
  } finally {
    ipcMain.removeHandler("fake-btlink:info");
    ipcMain.removeHandler("fake-btlink:write");
    server.stop();
    win.destroy();
  }
  const l = out.launcher || {}, n = out.network || {}, b = out.ble || {};
  check("Remote recording from the iPhone app: remote.html offers Bluetooth (no Bluetooth network), a computer's address opens its page right here (the app reaching it), and its Bluetooth button connects over Bluetooth Low Energy (picked from those near by when its name there isn't the one saved, its password once, a camera's picture when tapped)",
    !out.error && l.platform === "ios" && l.card && l.web && !l.android && !l.settings && /opens here/.test(l.where) &&
      /remote-client\.html\?rig=127\.0\.0\.1/.test(n.path) && n.title === "Hand Tracker on rig-test" && n.riglink > 0 &&
      /bt=127\.0\.0\.1/.test(b.path) && b.panel && (b.listed || []).join() === "Other,rig-test" && /Which computer/.test(b.asked) && b.title === "Hand Tracker on rig-test (Bluetooth)" && b.picture &&
      (b.calls || []).includes("btlink.connect 1F0E-RIG") && b.kept > 40,
    JSON.stringify(out));
}

// Remote recording from the Android app over a computer's Bluetooth network (BtNet.java; the
// stand-in plugin's network is set in localStorage "__fakeBtNet"): remote.html says how to join
// it and opens Bluetooth settings; with the phone on none the computer's page says so; on it, the
// computer asks for its Bluetooth password (the wrong one is said), the right one connects (the
// page over Bluetooth), and it's kept: the page connects again without it. A computer out of
// reach over the network: its Bluetooth network by itself when the phone is on that computer's
// (by name), else offered; a computer asked for that isn't the one on it is said. The computer
// is a remote recording server here that takes these requests as from its Bluetooth network.
// With a VPN keeping the app off that network (or the phone on none), over Bluetooth Low Energy
// instead, by itself (the app's BtLink plugin; the computer's link, electron/bluetooth-link.js,
// runs here): its password the first time (only its key kept), the computer asked for by name
// picked from those near by, a camera's picture when its box is tapped.
async function checkRemoteBluetoothNetwork(win, js) {
  const { RemoteRecordServer } = require("../electron/remote-record.js");
  const { BluetoothLink, makeSecret } = require("../electron/bluetooth-link.js");
  const wc = win.webContents;
  const state = {
    running: false, recording: false, mode: "freeform", requirement: { ok: true, missing: [], message: "" }, detailsRequired: false,
    details: { contributor: "", location: "", task: "" }, cameras: [],
    available: { at: 1, scanning: false, note: "", cameras: [{ id: "oak:BT-TEST", label: "Luxonis OAK-D …T-TEST", present: true, use: true, role: "head" }] },
  };
  // Its requests marked by the stand-in plugin are from its Bluetooth network (a phone at 10.43.0.7).
  class BluetoothNetworkServer extends RemoteRecordServer {
    bluetoothPeer(req) {
      return !!req.headers["x-fake-bt"] && super.bluetoothPeer(req, "10.43.0.1", "10.43.0.7");
    }
  }
  const tried = [];
  const server = new BluetoothNetworkServer({
    keyStore: null, host: "rig-test", hotspot: () => null,
    bluetoothPassword: (text) => (tried.push(text.length), text === "correct horse 42"),
    page: (name) => fs.readFileSync(path.join(ROOT, name === "js" ? "remote-client.js" : name === "bt" ? "bt-link-client.js" : "remote-client.html"), "utf8"),
    ask: async () => ({ ok: true, message: "" }),
  });
  server.setState(state);
  const { port } = await server.start();
  const out = {};
  // The computer's Bluetooth Low Energy link, its frames to and from the stand-in plugin.
  const secret = { ...makeSecret("correct horse 42"), from: "hotspot" };
  const link = new BluetoothLink({ name: "rig-test", secret: () => secret, relay: (r) => server.relay(r), send: (frame) => !wc.isDestroyed() && wc.send("fake-btlink:notify", frame.toString("base64")) });
  ipcMain.handle("fake-btlink:info", () => link.info().toString("base64"));
  // (A write's done when the computer has it, not when it has answered: as the platform helpers do.)
  ipcMain.handle("fake-btlink:write", (_e, b64) => void link.received("/dev/fake-phone", Buffer.from(b64, "base64"), 247));
  const navigated = (step) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No page loaded (still at ${wc.getURL()})`)), 20000);
    wc.once("did-finish-load", () => {
      clearTimeout(timer);
      resolve();
    });
    Promise.resolve(step()).catch(() => {});
  });
  const setNet = (net) => js(`localStorage.setItem("__fakeBtNet", ${JSON.stringify(JSON.stringify(net))}); Object.keys(localStorage).filter((k) => k.startsWith("__fakeBtPw:")).length`);
  const PAGE = `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const $ = (id) => document.getElementById(id);
    const until = async (fn, ms = 15000) => { for (let t = 0; t < ms; t += 100) { const v = fn(); if (v) return v; await sleep(100); } return null; };
    const shown = (id) => !$(id).hidden && !$(id).closest("[hidden]");
  `;
  const on = { on: true, port, device: { name: "rig-test", id: "AA:BB:CC:DD:EE:01" } };
  try {
    await wc.loadURL(`app://${HOST}/remote.html`);
    await setNet({ on: false });
    for (const k of await js(`Object.keys(localStorage).filter((k) => k.startsWith("__fakeBtPw:"))`)) await js(`localStorage.removeItem(${JSON.stringify(k)})`);
    await wc.loadURL(`app://${HOST}/remote.html`);
    out.launcher = await js(`(async () => {
      ${PAGE}
      await until(() => !$("btNow").hidden);
      $("btSettings").click();
      await sleep(200);
      return { card: shown("btCard"), android: shown("btAndroid"), web: shown("btWeb"), now: $("btNow").textContent, settings: window.__fakeCapacitor.calls.some((c) => c[0] === "remote.openBluetoothSettings") };
    })()`);
    await navigated(() => js(`document.getElementById("btOpen").click(); true`));
    out.off = await js(`(async () => {
      ${PAGE}
      await until(() => shown("btPanel") && /Bluetooth Low Energy/.test($("btNote").textContent) && shown("btSettings"));
      return { url: location.search, note: $("btNote").textContent, settings: shown("btSettings"), password: shown("btJoin"), asked: window.__fakeCapacitor.calls.some((c) => c[0] === "remote.bluetoothNetwork" && c[1]) };
    })()`);
    await setNet(on);
    out.connect = await js(`(async () => {
      ${PAGE}
      const asked = await until(() => shown("btJoin") && $("btNote").textContent);
      $("btPassword").value = "wrong horse 42";
      $("btConnect").click();
      const wrong = await until(() => /isn't its password/.test($("message").textContent) && $("message").textContent);
      $("btPassword").value = "correct horse 42";
      $("btConnect").click();
      const title = await until(() => /[(]Bluetooth[)]/.test($("title").textContent) && $("title").textContent);
      return { asked, wrong, title, message: $("message").textContent, panelGone: $("btPanel").hidden, rows: document.querySelectorAll("#camRows .camrow").length };
    })()`);
    out.kept = await js(`Object.keys(localStorage).filter((k) => k.startsWith("__fakeBtPw:")).join()`);
    // A new page: the password kept, connects without it.
    await wc.loadURL(`app://${HOST}/remote-client.html?rig=10.43.0.1%3A47821`);
    out.again = await js(`(async () => {
      ${PAGE}
      const title = await until(() => /[(]Bluetooth[)]/.test($("title").textContent) && $("title").textContent);
      return { title, panel: !$("btPanel").hidden };
    })()`);
    // Out of reach over the network, the phone on that computer's Bluetooth network (by name): there by itself.
    await setNet({ ...on, device: { name: "localhost", id: "AA:BB:CC:DD:EE:01" } });
    await wc.loadURL(`app://${HOST}/remote-client.html?rig=localhost%3A1`);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 20000);
      const look = () => (/10\.43\.0\.1/.test(decodeURIComponent(wc.getURL())) ? (clearTimeout(timer), resolve()) : setTimeout(look, 200));
      look();
    });
    out.auto = await js(`(async () => {
      ${PAGE}
      const title = await until(() => /[(]Bluetooth[)]/.test($("title").textContent) && $("title").textContent);
      const other = await until(() => /not localhost/.test($("message").textContent) && $("message").textContent);
      return { url: decodeURIComponent(location.search), title, other };
    })()`);
    // Another computer out of reach: offered, not by itself.
    await wc.loadURL(`app://${HOST}/remote-client.html?rig=127.0.0.1%3A1`);
    out.offer = await js(`(async () => {
      ${PAGE}
      await until(() => shown("btNetOpen"));
      await sleep(1500);
      return { url: location.search, note: $("btNote").textContent, open: shown("btNetOpen"), password: shown("btJoin") };
    })()`);
    await navigated(() => js(`document.getElementById("btNetOpen").click(); true`));
    out.offered = await js(`(async () => {
      ${PAGE}
      const title = await until(() => /[(]Bluetooth[)]/.test($("title").textContent) && $("title").textContent);
      return { url: decodeURIComponent(location.search), title };
    })()`);
    // A VPN keeps the app off the Bluetooth network: Bluetooth Low Energy by itself, to the
    // computer asked for (two near by), its password the first time.
    await setNet({ ...on, blocked: true });
    await js(`localStorage.setItem("__fakeBtLe", ${JSON.stringify(JSON.stringify([{ id: "AA:00:00:00:00:02", name: "Other" }, { id: "AA:00:00:00:00:01", name: "rig-test" }]))}); localStorage.removeItem("hand-tracker-bluetooth-keys"); true`);
    server.setState({ ...state, running: true, cameras: [{ index: 0, name: "Cam 1", roleId: "head", role: "Head", label: "camera 0", rotation: 0, mirror: false, fps: 30, hands: [], error: "" }] });
    server.setPreview(0, require("electron").nativeImage.createFromBitmap(Buffer.alloc(64 * 48 * 4, 120), { width: 64, height: 48 }).toJPEG(70));
    await wc.loadURL(`app://${HOST}/remote-client.html?rig=10.43.0.1%3A47821&want=rig-test`);
    out.le = await js(`(async () => {
      ${PAGE}
      const asked = await until(() => shown("btJoin") && $("btNote").textContent);
      $("btPassword").value = "correct horse 42";
      $("btConnect").click();
      const title = await until(() => /[(]Bluetooth[)]/.test($("title").textContent) && $("title").textContent);
      const tap = await until(() => document.querySelector("#cam0 .pic span") && /tap for its picture/.test(document.querySelector("#cam0 .pic span").textContent));
      document.querySelector("#cam0 .pic").click();
      const picture = !!(await until(() => !document.querySelector("#cam0 img").hidden && document.querySelector("#cam0 img").naturalWidth === 64));
      const calls = window.__fakeCapacitor.calls.filter((c) => c[0].startsWith("btlink.")).map((c) => c.join(" "));
      return { asked, title, message: $("message").textContent, panelGone: $("btPanel").hidden, tap: !!tap, picture, calls, kept: (localStorage.getItem("hand-tracker-bluetooth-keys") || "").length };
    })()`);
    // Again: the key kept, no password asked.
    await wc.loadURL(`app://${HOST}/remote-client.html?rig=10.43.0.1%3A47821&want=rig-test`);
    out.leAgain = await js(`(async () => {
      ${PAGE}
      const title = await until(() => /[(]Bluetooth[)]/.test($("title").textContent) && $("title").textContent);
      return { title, password: shown("btJoin") };
    })()`);
    // Full screen over it: pictures (30 a second at the computer), two requests on their way at
    // once (the notifications passed on together, as the Android app does).
    const fullNow = { n: 0, most: 0, asked: 0 };
    const relay = server.relay.bind(server);
    server.relay = async (r) => {
      const isFull = /full=1/.test(r.path || "");
      if (isFull) (fullNow.n++, fullNow.asked++, (fullNow.most = Math.max(fullNow.most, fullNow.n)));
      try {
        return await relay(r);
      } finally {
        if (isFull) fullNow.n--;
      }
    };
    const pic = require("electron").nativeImage.createFromBitmap(Buffer.alloc(64 * 48 * 4, 90), { width: 64, height: 48 }).toJPEG(70);
    const feed = setInterval(() => server.setPreview(0, pic), 33);
    try {
      out.leFull = await js(`(async () => {
        ${PAGE}
        // (The first tap gets its picture; a tap on that picture opens it full screen.)
        const pic = await until(() => document.querySelector("#cam0 .pic")), img = pic.querySelector("img");
        if (img.hidden) pic.click();
        const got = !!(await until(() => !img.hidden, 15000));
        pic.click();
        const rate = await until(() => /^[1-9]\\d* fps$/.test($("fullRate").textContent) && $("fullRate").textContent, 8000);
        await sleep(1500);
        const shownNow = !$("full").hidden && $("fullImg").naturalWidth === 64;
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        return { got, rate, shown: shownNow };
      })()`);
    } finally {
      clearInterval(feed);
      server.relay = relay;
    }
    out.leFull.atOnce = fullNow.most;
    out.leFull.asked = fullNow.asked;
  } catch (err) {
    out.error = String((err && err.stack) || err);
  } finally {
    ipcMain.removeHandler("fake-btlink:info");
    ipcMain.removeHandler("fake-btlink:write");
    await js(`localStorage.removeItem("__fakeBtLe"); localStorage.removeItem("hand-tracker-bluetooth-keys"); true`).catch(() => {});
    server.stop();
    await js(`localStorage.removeItem("__fakeBtNet"); Object.keys(localStorage).filter((k) => k.startsWith("__fakeBtPw:")).forEach((k) => localStorage.removeItem(k)); true`).catch(() => {});
  }
  out.tried = tried;
  const l = out.launcher || {}, off = out.off || {}, c = out.connect || {};
  check("Remote recording from the app over a computer's Bluetooth network: remote.html says how to join it and opens Bluetooth settings; on none, the computer's page says so; on it, its Bluetooth password is asked for (the wrong one said), the right one connects (over Bluetooth) and is kept; a computer out of reach goes over its Bluetooth network by itself (by name), another one's is offered, and a different computer on it is said; with a VPN keeping the app off it, Bluetooth Low Energy by itself (the computer asked for, its password once, a camera's picture on a tap, full screen from a tap on that picture, with two requests on their way at once)",
    !out.error && l.card && l.android && !l.web && /isn't on/.test(l.now) && l.settings &&
      /rig=10\.43\.0\.1/.test(decodeURIComponent(off.url || "")) && /Bluetooth Low Energy.*Faster: pair/.test(off.note) && off.settings && !off.password && off.asked &&
      /rig-test needs its Bluetooth password/.test(c.asked || "") && c.wrong && c.title === "Hand Tracker on rig-test (Bluetooth)" && c.panelGone && /Connected to rig-test over Bluetooth/.test(c.message) && c.rows === 1 &&
      out.kept === "__fakeBtPw:AA:BB:CC:DD:EE:01" && out.again && out.again.title === "Hand Tracker on rig-test (Bluetooth)" && !out.again.panel &&
      out.auto && /rig=10\.43\.0\.1:47821&want=localhost/.test(out.auto.url) && out.auto.title && out.auto.other &&
      out.offer && /rig=127/.test(decodeURIComponent(out.offer.url)) && out.offer.open && !out.offer.password && /Can't reach 127\.0\.0\.1/.test(out.offer.note) &&
      out.offered && /want=127\.0\.0\.1/.test(out.offered.url) && out.offered.title &&
      out.le && /VPN/.test(out.le.asked || "") && /needs its Bluetooth password/.test(out.le.asked || "") && out.le.title === "Hand Tracker on rig-test (Bluetooth)" &&
      out.le.panelGone && out.le.tap && out.le.picture && out.le.calls.includes("btlink.connect AA:00:00:00:00:01") && !out.le.calls.includes("btlink.connect AA:00:00:00:00:02") && out.le.kept > 40 &&
      out.leAgain && out.leAgain.title === "Hand Tracker on rig-test (Bluetooth)" && !out.leAgain.password &&
      out.leFull && out.leFull.got && out.leFull.rate && out.leFull.shown && out.leFull.atOnce === 2 && out.leFull.asked > 4,
    JSON.stringify(out));
}

// (A check's window closing, with none left, isn't the end: the run says when it's done.)
app.on("window-all-closed", () => {});
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
