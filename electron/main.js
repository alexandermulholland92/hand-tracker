/**
 * main.js — Electron entry point for the Hand Tracker desktop app.
 *
 * Serves the web app from a private app:// scheme (a secure context, so the
 * camera and WebAssembly work offline), grants camera access only to our own
 * pages, and exposes native save dialogs, ffmpeg video export and OptiTrack
 * .tak support (through the Motive installed on this PC) over IPC.
 */

const { app, BrowserWindow, protocol, session, ipcMain, dialog, shell, Menu, desktopCapturer, screen, globalShortcut, net, safeStorage, nativeImage } = require("electron");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { promisify } = require("util");
const exporter = require("./exporter");
const LabelLayers = require("./label-layers");
const LabelAss = require("../label-ass.js");
const tak = require("./tak");
const transmission = require("./transmission"); // (slowed while a page looks at the cameras)
const { InputDriver } = require("./input");
const { OakCamera } = require("./oak");
const { KinectCamera, KinectTake, SimulatedKinect, is360 } = require("./kinect");
const { writeKinectMcap } = require("./kinect-mcap");
const { Ps4Camera, SimulatedPs4Camera } = require("./ps4cam");
const { OpsClient } = require("./ops");
const { FleetClient } = require("./fleet");
const { Annotator, MODEL: annotateModel, DOLLARS_PER_MINUTE: annotateDollarsPerMinute } = require("./annotate");
const mcapVideo = require("./mcap-video");
const { PhoneLinkServer } = require("./phone-link");
const { RemoteRecordServer, RIG_HOST, RIG_PATH, cleanDetails } = require("./remote-record");
const { RigBluetooth } = require("./bluetooth");
const systemControl = require("./system-control");
const storage = require("./storage");
const FlushOften = require("./flush-often.js");
const busyNow = require("./busy").busy;
const { RoomHistory } = require("./room-history");
const { ImuIn } = require("./imu-in");
const imuIn = new ImuIn(); // (motion sensors other than the OAK cameras': on while remote recording is, if they're wanted)
let imuWanted = false; // (remote recording's Separate motion sensors: the window says, as it starts and when changed)
const { checkPassword: checkBluetoothPassword } = require("./bluetooth-link");
const { createWifi } = require("./wifi");

const APP_ROOT = path.join(__dirname, "..");
const SCHEME = "app";
const HOST = "hand-tracker";
// Which app this is: Hand Tracker, or one of the apps of its own built from it (scripts/dist.js
// --app, which puts appKind in the packaged package.json; from the source folder,
// `electron . --app=mouse`): Hand Mouse (only the hand mouse: hand-mouse.html), Remote
// Recording (controlling camera rigs, or being one: remote-recording.html) or Recording
// Converter (the Recording Converter alone: viewer.html).
const APPS = {
  full: { name: "Hand Tracker", page: "index.html", id: "com.handtracker.app", slug: "hand-tracker", size: { width: 1320, height: 940 } },
  mouse: { name: "Hand Mouse", page: "hand-mouse.html", id: "com.handtracker.mouse", slug: "hand-mouse", size: { width: 600, height: 900 } },
  remote: { name: "Remote Recording", page: "remote-recording.html", id: "com.handtracker.remote", slug: "remote-recording", size: { width: 1320, height: 940 } },
  converter: { name: "Recording Converter", page: "viewer.html", id: "com.handtracker.converter", slug: "recording-converter", size: { width: 920, height: 960 } },
  // (Cluster: the Raspberry Pis running Cluster's service, cluster/node: cluster.html)
  cluster: { name: "Cluster", page: "cluster.html", id: "com.handtracker.cluster", slug: "hand-tracker-cluster", size: { width: 1080, height: 920 } },
  // (Cluster Call: calls between your own devices over Tailscale: cluster-call.html, electron/cluster-call.js)
  clustercall: { name: "Cluster Call", page: "cluster-call.html", id: "com.handtracker.clustercall", slug: "cluster-call", size: { width: 1100, height: 820 } },
};
const APP = (() => {
  const arg = process.argv.find((a) => a.startsWith("--app="));
  let kind = arg ? arg.slice(6) : null;
  if (!APPS[kind]) {
    try {
      kind = require("../package.json").appKind;
    } catch {}
  }
  if (!APPS[kind]) kind = "full";
  return { kind, ...APPS[kind] };
})();
// Its own settings, and its own single instance (a copy of Hand Tracker can run beside it).
if (APP.kind !== "full" && !app.isPackaged) app.setName(APP.name);
// Cluster's settings, its list of Pis and what its page remembers, kept before the rename (2026-11-25: "Pi Cluster"
// became "Cluster") in a folder of that name: moved to the new name once, before anything opens them.
if (APP.kind === "cluster") {
  try {
    const now = app.getPath("userData");
    const was = path.join(path.dirname(now), "Pi Cluster");
    if (path.basename(now) === "Cluster" && fs.existsSync(was) && !fs.existsSync(now)) fs.renameSync(was, now);
  } catch (e) {
    console.warn(`Cluster's folder from before the rename stays where it was: ${e.message}`);
  }
}
// Pages a link can open as an app window of their own, and their size.
const PAGES = new Map([
  ["index.html", { width: 920, height: 960 }],
  ["viewer.html", { width: 920, height: 960 }],
  ["remote.html", { width: 760, height: 820 }],
]);
// Keys that work even while the app is minimized: the hand mouse and the floating keyboard on/off.
const SHORTCUTS = { mouse: "CommandOrControl+Alt+M", keyboard: "CommandOrControl+Alt+K" };
// (bluetooth: remote recording over Bluetooth, remote-client.js, from the app's own pages only.)
const ALLOWED_PERMISSIONS = new Set(["media", "fullscreen", "clipboard-sanitized-write", "bluetooth"]);
// Motion capture exports, and remote recording's and Sentry mode's videos and photos.
// (wav: the baby monitor's sound clips, baby-monitor.js)
const SAVE_EXTENSIONS = new Set(["json", "csv", "bvh", "glb", "c3d", "trc", "npz", "mcap", "webm", "mp4", "jpg", "wav", "mkv"]);
const readFile = promisify(fs.readFile); // callback fs is asar-aware in packaged builds

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", // (ONNX Runtime's WebAssembly loader, a module)
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// On ARM boards (a Raspberry Pi: a rig with 4 GB or so), less memory: sound handled in the app's own
// process rather than a helper of its own (about 25 MB on pi, 2026-11-14; sound still works: microphones
// on the videos, videos played), and each page's JavaScript held to 768 MB, so it's cleared up before it
// grows past that (the page that was killed for memory on 2026-11-13 had reached about 1 GB).
const SMALL_BOARD = process.platform === "linux" && (process.arch === "arm64" || process.arch === "arm");
if (SMALL_BOARD) app.commandLine.appendSwitch("js-flags", "--max-old-space-size=768");
// Windows treats a window that is fully covered by other windows as hidden and
// stops rendering it, which freezes the camera feed and stops tracking and
// recording. Keep working when covered (minimizing still pauses).
// (one disable-features: a second would replace the first)
// (Cluster Call: its own addresses, the Tailscale one among them, offered to the other app as they are, not hidden
// behind made-up names that only a device on the same local network could look up.)
app.commandLine.appendSwitch("disable-features", ["CalculateNativeWinOcclusion", ...(SMALL_BOARD ? ["AudioServiceOutOfProcess"] : []),
  ...(APP.kind === "clustercall" ? ["WebRtcHideLocalIpsWithMdns"] : [])].join(","));
// On ARM boards (a Raspberry Pi), use the GPU even if Chromium's list doubts its driver:
// hand tracking runs on WebGL, and without the GPU it crawls.
if (process.platform === "linux" && process.arch === "arm64") app.commandLine.appendSwitch("ignore-gpu-blocklist");
// On Linux, drawing keeps its own pace (60 a second) rather than the screen's: with the screen
// off (a Raspberry Pi's blanks after 10 minutes), its pace dropped to a frame or two a second,
// and each camera preview, picture read back and video frame waited up to a second for one, so
// a Pi rig's previews and videos (Sentry's too) came at about 1 fps (measured on a Pi 5: 1 -> 30).
if (process.platform === "linux") app.commandLine.appendSwitch("disable-gpu-vsync");

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Only one instance: two copies would fight over the camera.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();

let mainWindow = null;
let keyboardWindow = null; // the floating keyboard
const input = new InputDriver(); // mouse and keyboard input to this computer (see input.js)
// What the hand mouse, gesture actions and the floating keyboard work: this computer, or an
// iPhone or iPad this computer is a Bluetooth mouse and keyboard for (see bt-hid.js).
let pcTarget = "computer";
let btHid = null;
let oak = null; // Luxonis OAK cameras (see oak.js), created once the app is ready
let oakViewer = null; // the window receiving the OAK camera's frames
const oakStreams = new Map(); // several OAK cameras at once (multi-camera.js): id -> { cam, busy }
const kinectStreams = new Map(); // Kinects (kinect.js), as tiles of "Several cameras": id -> { cam, busy, viewer, take, audio }
const ps4Streams = new Map(); // PS4 cameras (ps4cam.js), as tiles of "Several cameras": id -> { cam, busy, viewer }
let ops = null; // capture-session dashboard (see ops.js), created once the app is ready
let fleet = null; // capture-fleet dashboard's live rig pictures (see fleet.js)
const outputFolders = new Map(); // token -> folder the user picked for batch saving
const exportedPaths = new Set(); // files this session wrote; the only ones "show in folder" will reveal
// Opened at login for remote recording (remote-record.js): no camera until the phone asks.
const remoteStandby = process.argv.includes("--remote-standby");
let remoteRecord = null;
let previewsWatched = false, videoWatched = false; // a page is looking at the previews / playing a camera's video (Transmission's turtle)
let rigBluetooth = null; // remote recording over Bluetooth (bluetooth.js), on with it
// Imported videos converted to MP4 for playback: id -> { file, owner: webContents id }, and a take's
// own videos shown as they are (original: never deleted here; type: theirs). Only these are served under /__media/.
const mediaFiles = new Map();
let mediaDir = null;

function isAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === `${SCHEME}:` && url.host === HOST;
  } catch {
    return false;
  }
}

// --- Small persisted settings (last-used folders) ---
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}
function writeSettings(patch) {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...patch }, null, 2));
  } catch {
    // non-fatal: we'll just forget the folder
  }
}

// Serves a converted video with HTTP range support, which video seeking relies on.
async function serveMedia(request, id) {
  const media = mediaFiles.get(id), file = media && media.file;
  if (!file) return new Response("Not found", { status: 404 });
  const size = (await fs.promises.stat(file)).size;
  const headers = { "Content-Type": media.type || "video/mp4", "Accept-Ranges": "bytes" };
  const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get("Range") || "");
  if (!m) return new Response(Readable.toWeb(fs.createReadStream(file)), { headers: { ...headers, "Content-Length": String(size) } });
  let start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
  let end = m[1] !== "" && m[2] !== "" ? Number(m[2]) : size - 1;
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
    status: 206,
    headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
  });
}

function serveAppFiles() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response("Not found", { status: 404 });
  // (A part of an address as written; null when it can't be read: a bad % in it.)
  const plain = (text) => {
    try {
      return decodeURIComponent(text || "");
    } catch {
      return null;
    }
  };
    if (url.pathname.startsWith("/__media/")) return serveMedia(request, url.pathname.slice("/__media/".length));
    if (url.pathname.startsWith("/__ops/") && ops) return ops.serve(request, url.pathname.slice("/__ops/".length));
    if (url.pathname.startsWith("/__fleet/") && fleet) {
      // /__fleet/<rig>/<camera>[?kind=keyframe|jpeg][&full=1]: that camera's latest picture.
      const [host, camera] = url.pathname.slice("/__fleet/".length).split("/").slice(0, 2).map(plain);
      if (host === null || camera === null) return new Response("Not found", { status: 404 });
      return fleet.serveFrame(host || "", camera || "", {
        kind: url.searchParams.get("kind") === "keyframe" ? "keyframe" : "jpeg",
        full: url.searchParams.get("full") === "1",
      });
    }
    let rel = plain(url.pathname);
    if (rel == null) return new Response("Not found", { status: 404 });
    if (rel === "/" || rel === "") rel = "/index.html";
    const filePath = path.normalize(path.join(APP_ROOT, rel));
    if (!filePath.startsWith(APP_ROOT + path.sep)) return new Response("Forbidden", { status: 403 });
    try {
      const data = await readFile(filePath);
      const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
      return new Response(data, { headers: { "Content-Type": type } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

// Web Bluetooth (remote recording over Bluetooth: remote-client.js): the device a page asks for is
// the one with the name it gave (desktop.bluetooth.prefer: a computer's name), else the page lists
// those found to pick from (desktop.bluetooth.choose); nothing picked in 30 s is none.
const btPicks = new Map(); // webContents id -> { name, callback, timer }
function btDone(id, deviceId) {
  const w = btPicks.get(id);
  if (!w) return;
  clearTimeout(w.timer);
  btPicks.delete(id);
  if (w.callback) w.callback(deviceId);
}
function bluetoothPicker() {
  app.on("web-contents-created", (_e, wc) => {
    wc.on("select-bluetooth-device", (event, devices, callback) => {
      event.preventDefault();
      if (!isAppUrl(wc.getURL())) return callback("");
      const w = btPicks.get(wc.id) || { name: "" };
      w.callback = callback;
      if (!w.timer) w.timer = setTimeout(() => btDone(wc.id, ""), 30000);
      btPicks.set(wc.id, w);
      const named = w.name && devices.find((d) => String(d.deviceName || "").toLowerCase() === w.name);
      if (named) return btDone(wc.id, named.deviceId);
      wc.send("bluetooth:devices", devices.map((d) => ({ id: d.deviceId, name: d.deviceName || "" })));
    });
    wc.on("destroyed", () => btDone(wc.id, ""));
  });
  ipcMain.on("bluetooth:prefer", (event, name) => {
    btDone(event.sender.id, "");
    btPicks.set(event.sender.id, { name: String(name || "").toLowerCase().split(".")[0].slice(0, 40) });
  });
  ipcMain.on("bluetooth:choose", (event, id) => btDone(event.sender.id, String(id || "")));
}

function restrictPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl || wc.getURL()));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    return ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingOrigin || (wc ? wc.getURL() : ""));
  });
}

function createWindow(page = "index.html", size = { width: 1320, height: 940 }, show = true) {
  const iconPath = path.join(APP_ROOT, "build", "icon.png");
  const win = new BrowserWindow({
    ...size,
    show, // (Cluster Call opened at login: hidden, waiting for a call)
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#0e0f12",
    title: APP.name,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // keep tracking/recording while the window is behind others
    },
  });

  // Links to our own pages open as app windows; web links go to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) {
      const target = new URL(url).pathname.replace(/^\//, "");
      if (PAGES.has(target)) createWindow(target, PAGES.get(target));
    } else if (/^https?:\/\//.test(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });

  // A page left (Remote Recording going back to its choices from the rig, say): the OAK cameras
  // it started stop, and so does remote recording when the page was Remote Recording's rig.
  win.webContents.on("did-start-navigation", (event, ...old) => {
    const isMainFrame = event.isMainFrame !== undefined ? event.isMainFrame : old[2];
    const isSameDocument = event.isSameDocument !== undefined ? event.isSameDocument : old[1];
    const url = event.url !== undefined ? event.url : old[0];
    if (!isMainFrame || isSameDocument) return;
    for (const [id, stream] of [...oakStreams]) if (stream.viewer === win.webContents) stopOakStream(id);
    for (const [id, stream] of [...kinectStreams]) if (stream.viewer === win.webContents) stopKinectStream(id);
    for (const [id, stream] of [...ps4Streams]) if (stream.viewer === win.webContents) stopPs4Stream(id);
    if (APP.kind === "remote" && win === mainWindow && remoteRecord && !/[?&]rig=1(&|$)/.test(String(url || ""))) {
      if (rigBluetooth) rigBluetooth.stop();
      Promise.resolve(remoteRecord.stop()).catch(() => {});
    }
  });

  win.loadURL(`${SCHEME}://${HOST}/${page}`);
  return win;
}

function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        {
          label: "Open Recording Converter",
          visible: !["mouse", "converter", "cluster"].includes(APP.kind), // (the converter's own app is it)
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => createWindow("viewer.html", { width: 920, height: 960 }),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: `About ${APP.name}`,
          click: async () => {
            const ffmpeg = (await exporter.isAvailable()) ? "available" : "not found";
            dialog.showMessageBox({
              type: "info",
              title: `About ${APP.name}`,
              message: `${APP.name} ${app.getVersion()}`,
              detail: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}\nffmpeg: ${ffmpeg}`,
            });
          },
        },
      ],
    },
  ];
  // A Mac's menu bar starts with the app's own menu, and copy and paste in text boxes
  // (Cmd+C, Cmd+V) only work through an Edit menu.
  if (process.platform === "darwin") template.splice(0, 0, { role: "appMenu" }), template.splice(2, 0, { role: "editMenu" });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Every IPC call must come from one of our own pages.
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!event.senderFrame || !isAppUrl(event.senderFrame.url)) throw new Error("Blocked: untrusted sender");
    return fn(event, ...args);
  });
}

// ---------- Cluster (its own app): the Pis running Cluster's service (cluster.js) ----------
if (APP.kind === "cluster") {
  const { Cluster } = require("./cluster");
  let cluster = null;
  const theCluster = () => cluster || (cluster = new Cluster({ file: path.join(app.getPath("userData"), "cluster-pis.json") }));
  handle("cluster:list", () => theCluster().list());
  handle("cluster:settings", (_e, change) => theCluster().settings(change));
  handle("cluster:action", (_e, what) => theCluster().action(what));
  handle("cluster:forget", (_e, name) => theCluster().forget(name));
  // Jobs: files from this computer (only ones picked here are sent), and a job's results saved here.
  const picked = new Set();
  const pick = async (event, options) => {
    const got = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), options);
    if (got.canceled) return [];
    return Promise.all(got.filePaths.map(async (p) => {
      picked.add(p);
      return { path: p, name: path.basename(p), size: (await fs.promises.stat(p)).size };
    }));
  };
  handle("cluster:pick-files", (event) => pick(event, { title: "Files for the job", properties: ["openFile", "multiSelections"] }));
  handle("cluster:pick-model", (event) => pick(event, { title: "A model for the job (ONNX)", properties: ["openFile"], filters: [{ name: "ONNX model", extensions: ["onnx"] }] }));
  handle("cluster:pick-folder", async (event) => {
    const got = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: "Save the results in", properties: ["openDirectory", "createDirectory"] });
    return got.canceled ? null : got.filePaths[0];
  });
  const report = (event) => (p) => !event.sender.isDestroyed() && event.sender.send("cluster:progress", p);
  handle("cluster:upload", (event, what) => {
    const files = ((what && what.files) || []).filter((f) => f && picked.has(f.path)).map((f) => ({ path: f.path, name: String(f.name || path.basename(f.path)) }));
    return theCluster().upload({ ...what, files }, report(event));
  });
  handle("cluster:download", (event, what) => theCluster().download(what, report(event)));
}

// ---------- OptiTrack Motive: live NatNet data ----------
// One connection for the app; every window that asks gets its status and (at most 30 a
// second) its frames. While motion capture records, every frame is kept here, in full.
const { NatNetClient } = require("./natnet");
// A frame in the app's units: millimetres, Z-up (the same as the Android app's).
const { compactFrame } = require("../natnet-parse.js");
const natnet = { client: null, windows: new Set(), lastSent: 0, latest: null, recording: null };

function natnetClient() {
  if (natnet.client) return natnet.client;
  const client = new NatNetClient();
  const send = (channel, payload) => {
    for (const wc of natnet.windows) if (!wc.isDestroyed()) wc.send(channel, payload);
  };
  client.on("status", (s) => send("natnet:status", s));
  client.on("warning", (w) => send("natnet:status", { ...client.lastStatus, warning: w }));
  client.on("frame", (f) => {
    const frame = compactFrame(f);
    natnet.latest = frame;
    if (natnet.recording) natnet.recording.push(frame);
    const now = Date.now();
    if (now - natnet.lastSent >= 33) {
      natnet.lastSent = now;
      send("natnet:frame", frame);
    }
  });
  natnet.client = client;
  return client;
}

// ---------- Controlling this computer: hand mouse, floating keyboard, gesture actions ----------
// The floating keyboard never takes the keyboard focus (focusable: false), so what's typed
// on it goes to the app you were using, like the Windows on-screen keyboard.
function openKeyboard() {
  if (keyboardWindow && !keyboardWindow.isDestroyed()) {
    keyboardWindow.showInactive();
    return;
  }
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(900, workArea.width - 40), height = 320;
  keyboardWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height - 16),
    minWidth: 480,
    minHeight: 200,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#15161a",
    title: `${APP.name} keyboard`,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  keyboardWindow.setAlwaysOnTop(true, "screen-saver");
  keyboardWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  keyboardWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  keyboardWindow.loadURL(`${SCHEME}://${HOST}/keyboard.html`);
  keyboardWindow.once("ready-to-show", () => keyboardWindow && keyboardWindow.showInactive());
  keyboardWindow.on("closed", () => {
    keyboardWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("pc:keyboard-state", false);
  });
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("pc:keyboard-state", true);
}
function closeKeyboard() {
  if (keyboardWindow && !keyboardWindow.isDestroyed()) keyboardWindow.close();
}

// iPhone Mirroring's window on a Mac (its iPhone, worked from the Mac): where it is, looked up
// at most once a second (System Events, with the Accessibility permission the hand mouse has).
let mirroring = { at: 0, bounds: null, busy: false };
function mirroringBounds() {
  if (process.platform !== "darwin") return null;
  if (!mirroring.busy && Date.now() - mirroring.at > 1000) {
    mirroring.busy = true;
    const script = 'tell application "System Events" to tell (first process whose name is "iPhone Mirroring") to get {position, size} of window 1';
    require("child_process").execFile("osascript", ["-e", script], { timeout: 3000 }, (err, stdout) => {
      const v = String(stdout || "").split(",").map((n) => Number(n.trim()));
      mirroring = { at: Date.now(), busy: false, bounds: !err && v.length === 4 && v.every(Number.isFinite) && v[2] > 50 ? { x: v[0], y: v[1], width: v[2], height: v[3] } : null };
    });
  }
  return mirroring.bounds;
}

// A point given as fractions of a screen ("primary", "all" screens together, or "mirroring":
// iPhone Mirroring's window) -> the physical pixels the input helper works in; null if that
// window isn't open.
function screenPoint(nx, ny, which) {
  const displays = screen.getAllDisplays();
  let b = screen.getPrimaryDisplay().bounds;
  if (which === "mirroring") {
    b = mirroringBounds();
    if (!b) return null;
  }
  if (which === "all" && displays.length > 1) {
    const x0 = Math.min(...displays.map((d) => d.bounds.x)), y0 = Math.min(...displays.map((d) => d.bounds.y));
    const x1 = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width)), y1 = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
    b = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
  const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  const dip = { x: Math.round(b.x + clamp(nx) * (b.width - 1)), y: Math.round(b.y + clamp(ny) * (b.height - 1)) };
  return screen.dipToScreenPoint ? screen.dipToScreenPoint(dip) : dip;
}

function registerPcIpc() {
  const { BtHid } = require("./bt-hid");
  btHid = new BtHid({
    folder: path.join(app.getPath("userData"), "bt-hid"),
    onStatus: (s) => {
      for (const w of [mainWindow, keyboardWindow]) if (w && !w.isDestroyed()) w.webContents.send("pc:target-status", { target: pcTarget, ...s });
    },
  });
  // The input goes to this computer, or to the iPhone or iPad (as a Bluetooth mouse and keyboard).
  const toDevice = () => pcTarget === "device";
  const ready = () => (toDevice() ? btHid.start() : input.start());
  handle("pc:start", () => ready());
  // Pointer moves come many times a second: fire-and-forget, from our own pages only.
  ipcMain.on("pc:pointer", (event, { nx, ny, screen: which } = {}) => {
    if (!event.senderFrame || !isAppUrl(event.senderFrame.url)) return;
    if (toDevice()) {
      if (btHid.status().state === "connected") btHid.device.pointer(nx, ny);
      return;
    }
    input
      .start()
      .then(() => {
        const p = screenPoint(nx, ny, which);
        if (p) input.move(p.x, p.y);
      })
      .catch(() => {});
  });
  handle("pc:button", async (event, { which, action }) => {
    await ready();
    (toDevice() ? btHid.device : input).button(which, action);
  });
  handle("pc:wheel", async (event, { notches }) => {
    await ready();
    (toDevice() ? btHid.device : input).wheel(notches);
  });
  handle("pc:key", async (event, { combo, action }) => {
    await ready();
    (toDevice() ? btHid.device : input).key(combo, action);
  });
  handle("pc:text", async (event, { text }) => {
    await ready();
    (toDevice() ? btHid.device : input).text(text);
  });
  // Which to work: { target: "computer" | "device", screen ("iphone", "ipad", ... sideways),
  // speed }. -> { target, state, device, message }. The device: this computer starts
  // advertising as a Bluetooth mouse and keyboard (and stops when it's this computer again).
  handle("pc:target", async (event, { target, screen: kind, speed } = {}) => {
    pcTarget = target === "device" ? "device" : "computer";
    if (pcTarget === "device") {
      btHid.setScreen(kind, speed);
      await btHid.start().catch(() => {}); // (its status says why not)
    } else btHid.stop();
    return { target: pcTarget, ...btHid.status() };
  });
  handle("pc:target-status", () => ({ target: pcTarget, ...btHid.status() }));
  // A Mac: iPhone Mirroring opened (macOS 15 and later).
  handle("pc:open-mirroring", async () => {
    if (process.platform !== "darwin") throw new Error("iPhone Mirroring is on a Mac.");
    const err = await shell.openPath("/System/Applications/iPhone Mirroring.app");
    if (err) throw new Error("iPhone Mirroring isn't on this Mac (it needs macOS 15 and an iPhone with iOS 18).");
    return true;
  });
  // Gesture actions' web requests, from here (no browser cross-site limits), http(s) only.
  handle("pc:web", async (event, { url, method = "GET", body = null } = {}) => {
    let target;
    try {
      target = new URL(String(url));
    } catch {
      throw new Error("That isn't a web address.");
    }
    if (!/^https?:$/.test(target.protocol)) throw new Error("Only http:// and https:// addresses can be called.");
    const m = String(method).toUpperCase();
    if (!["GET", "POST", "PUT"].includes(m)) throw new Error("Unknown request method.");
    const res = await net.fetch(target.href, {
      method: m,
      headers: body !== null && m !== "GET" ? { "Content-Type": "application/json" } : undefined,
      body: body !== null && m !== "GET" ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    return { ok: res.ok, status: res.status };
  });
  handle("pc:keyboard", (event, { show }) => {
    if (show) openKeyboard();
    else closeKeyboard();
    return !!show;
  });
  // Status from the main window to the floating keyboard, and the keyboard's hand-mouse
  // button back to the main window.
  ipcMain.on("pc:status", (event, status) => {
    if (!event.senderFrame || !isAppUrl(event.senderFrame.url)) return;
    if (keyboardWindow && !keyboardWindow.isDestroyed()) keyboardWindow.webContents.send("pc:status", status);
  });
  ipcMain.on("pc:toggle-mouse", (event) => {
    if (!event.senderFrame || !isAppUrl(event.senderFrame.url)) return;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("pc:toggle-mouse");
  });
}

// ---------- Luxonis OAK cameras ----------
function registerOakIpc() {
  oak = new OakCamera(app.getPath("userData"), (url) => net.fetch(url));
  // The automated checks' stand-in OAK cameras need no setup (see SimulatedOak).
  const simulated = !!process.env.HAND_TRACKER_OAK_SIMULATE;
  handle("oak:status", () => (simulated ? { ready: true, simulated: true } : oak.status()));
  handle("oak:setup", (event) =>
    oak.setup((line) => {
      if (!event.sender.isDestroyed()) event.sender.send("oak:setup-progress", line);
    })
  );
  const single = simulated ? new SimulatedOak() : oak; // the main window's OAK camera
  handle("oak:start", (event, options = {}) => {
    oakViewer = event.sender;
    const viewer = event.sender;
    let busy = false; // the page is still showing the last frame: drop this one
    single.stop();
    single.start({ ...options, simulate: simulated }, (msg) => {
      if (viewer.isDestroyed()) return single.stop();
      if (msg.video) return; // (only the tiles' cameras are asked for their H.264)
      if (msg.frame) {
        if (busy) return;
        busy = true;
        viewer.send("oak:frame", { header: msg.frame, jpeg: msg.jpeg ? new Uint8Array(msg.jpeg) : null });
      } else {
        viewer.send("oak:status", msg);
      }
    });
    // The page says when it has shown a frame.
    ipcMain.removeAllListeners("oak:shown");
    ipcMain.on("oak:shown", () => (busy = false));
    return true;
  });
  handle("oak:stop", () => {
    single.stop();
    return true;
  });

  // Several OAK cameras at once (the tiles of "Several cameras", multi-camera.js): a helper
  // each, its frames and statuses tagged with the camera's id. A frame is dropped while the
  // page is still showing that camera's last one.
  // detail: { devices, silent } — silent: the USB ports of OAK cameras plugged in that didn't
  // answer (Linux), to say so rather than leave them out.
  handle("oak:list", async (event, opts) => {
    const detail = !!(opts && opts.detail);
    if (simulated) {
      const devices = [{ name: "sim.1", id: "SIMULATED-OAK-A", state: "X_LINK_UNBOOTED" }, { name: "sim.2", id: "SIMULATED-OAK-B", state: "X_LINK_UNBOOTED" }];
      return detail ? { devices, silent: [] } : devices;
    }
    const msg = await oak.runBridge(["--list"]).catch(() => null);
    const devices = msg && msg.status === "devices" ? msg.devices : [];
    const silent = msg && Array.isArray(msg.silent) ? msg.silent.filter((n) => typeof n === "string" && /^[0-9.]{1,32}$/.test(n)).slice(0, 16) : [];
    return detail ? { devices, silent } : devices;
  });
  handle("oak:stream-start", (event, { id, ...options } = {}) => {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(id || ""))) throw new Error("Which OAK camera?");
    stopOakStream(id);
    const viewer = event.sender;
    const stream = { cam: simulated ? new SimulatedOak() : new OakCamera(app.getPath("userData"), (url) => net.fetch(url)), busy: false, viewer };
    oakStreams.set(id, stream);
    stream.cam.start({ ...options, device: id }, (msg) => {
      if (oakStreams.get(id) !== stream && msg.status !== "stopped") return;
      if (viewer.isDestroyed()) return stopOakStream(id);
      // Its own H.264 (h264: oak_bridge.py --h264): each picture to remote recording's full screen, kept
      // there by its id (the state says which camera that is); its frames' hands and objects while a page
      // plays it.
      if (msg.video) {
        if (remoteRecord && remoteRecord.server && msg.data) remoteRecord.setVideo(id, msg.video, msg.data);
        return;
      }
      if (msg.frame && remoteRecord && remoteRecord.videoWatched(id)) remoteRecord.setOverlay(id, msg.frame);
      if (msg.frame) {
        if (stream.busy) return;
        stream.busy = true;
        viewer.send("oak:stream-frame", { id, header: msg.frame, jpeg: msg.jpeg ? new Uint8Array(msg.jpeg) : null });
      } else if (oakStreams.get(id) === stream || !oakStreams.has(id)) {
        viewer.send("oak:stream-status", { id, ...msg });
      }
    });
    return true;
  });
  ipcMain.on("oak:stream-shown", (event, id) => {
    const stream = oakStreams.get(id);
    if (stream) stream.busy = false;
  });
  handle("oak:stream-stop", (event, id) => {
    for (const key of id ? [id] : [...oakStreams.keys()]) stopOakStream(key);
    return true;
  });
}

function stopOakStream(id) {
  const stream = oakStreams.get(id);
  if (!stream) return;
  oakStreams.delete(id);
  stream.cam.stop();
}

// For the automated checks (HAND_TRACKER_OAK_SIMULATE): an OAK camera without a camera or
// Python, streaming like the helper does: a hand moving across a plain picture.
class SimulatedOak {
  static failedOnce = new Set();
  static frozeOnce = new Set();
  static usbReset = new Set(); // (the cameras whose USB was turned off and on: remote:reset-camera)
  static clip = null; // (h264: its H.264, made once)

  // As oak_bridge.py --h264 sends it: 2 s of H.264 (Main profile, a keyframe a second, no B-frames)
  // of ffmpeg's moving test picture, 640 x 360 at 30 a second, made once by the app's ffmpeg, as its
  // pictures (Annex B, each with its access unit delimiter: [{ key, data }]); null if it can't be made.
  static h264() {
    if (!SimulatedOak.clip) {
      SimulatedOak.clip = new Promise((resolve) => {
        const args = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2",
          "-c:v", "libx264", "-profile:v", "main", "-pix_fmt", "yuv420p", "-g", "30", "-keyint_min", "30", "-sc_threshold", "0", "-bf", "0",
          "-x264-params", "aud=1:repeat-headers=1", "-f", "h264", "pipe:1"];
        let proc;
        try {
          proc = require("child_process").spawn(exporter.ffmpegPath, args, { windowsHide: true });
        } catch {
          return resolve(null);
        }
        const chunks = [];
        proc.stdout.on("data", (c) => chunks.push(c));
        proc.on("error", () => resolve(null));
        proc.on("close", (code) => {
          const all = Buffer.concat(chunks);
          const aud = Buffer.from([0, 0, 0, 1, 9]);
          const starts = [];
          for (let at = all.indexOf(aud); at >= 0; at = all.indexOf(aud, at + 1)) starts.push(at);
          const pictures = starts.map((at, k) => all.subarray(at, k + 1 < starts.length ? starts[k + 1] : all.length));
          const key = (b) => {
            for (let at = b.indexOf(Buffer.from([0, 0, 1])); at >= 0 && at + 3 < b.length; at = b.indexOf(Buffer.from([0, 0, 1]), at + 3)) if ([5, 7].includes(b[at + 3] & 0x1f)) return true;
            return false;
          };
          resolve(code === 0 && pictures.length ? pictures.map((data) => ({ key: key(data), data: Buffer.from(data) })) : null);
        });
      });
    }
    return SimulatedOak.clip;
  }

  start(options, onMessage) {
    // A camera whose id has STUCK doesn't start until its USB has been turned off and on (Restart's last step).
    if (/STUCK/.test(options.device || "") && !SimulatedOak.usbReset.has(options.device)) {
      onMessage({ status: "error", message: "The simulated OAK camera doesn't answer." });
      return;
    }
    // A camera whose id has FAILS-ONCE doesn't start the first time (for the checks' Try again).
    if (/FAILS-ONCE/.test(options.device || "") && !SimulatedOak.failedOnce.has(options.device)) {
      SimulatedOak.failedOnce.add(options.device);
      onMessage({ status: "error", message: "The simulated OAK camera didn't start this time." });
      return;
    }
    const w = 640, h = 360;
    const pixels = Buffer.alloc(w * h * 4, 60);
    // The depth picture: reddish (BGRA), so the checks can tell it from the colour one.
    if (options.picture === "depth") for (let i = 0; i < pixels.length; i += 4) pixels.set([40, 40, 200, 255], i);
    // Side by side: twice as wide (its right half reddish, as the depth picture).
    const side = options.picture === "side";
    const wide = side ? Buffer.concat(Array.from({ length: h }, (_, y) => Buffer.concat([pixels.subarray(y * w * 4, (y + 1) * w * 4), Buffer.alloc(w * 4, 0).fill(Buffer.from([40, 40, 200, 255]))]))) : pixels;
    const jpeg = nativeImage.createFromBitmap(wide, { width: side ? w * 2 : w, height: h }).toJPEG(70);
    const T = [[0, 0], [-0.04, -0.03], [-0.08, -0.07], [-0.11, -0.1], [-0.13, -0.13], [-0.035, -0.12], [-0.04, -0.17], [-0.043, -0.2], [-0.045, -0.23],
      [0, -0.125], [0, -0.18], [0, -0.215], [0, -0.245], [0.03, -0.115], [0.035, -0.165], [0.038, -0.195], [0.04, -0.22], [0.055, -0.1], [0.065, -0.135], [0.07, -0.16], [0.075, -0.18]];
    const t0 = Date.now();
    const frozen = /FREEZES/.test(options.device || "") && !SimulatedOak.frozeOnce.has(options.device);
    const lag = /BEACON-(\d+)/.exec(options.device || "");
    const clockLate = Number((/CLOCK-(\d+)/.exec(options.device || "") || [0, 0])[1]);
    const beacon = lag && {
      lag: Number(lag[1]),
      white: nativeImage.createFromBitmap(Buffer.alloc(64 * 36 * 4, 255), { width: 64, height: 36 }).toJPEG(80),
      black: nativeImage.createFromBitmap(Buffer.alloc(64 * 36 * 4, 0).fill(Buffer.from([0, 0, 0, 255])), { width: 64, height: 36 }).toJPEG(80),
    };
    if (frozen) SimulatedOak.frozeOnce.add(options.device);
    this.onMessage = onMessage;
    // h264: its colour picture's H.264 too (not for the other views), a picture with each frame, from a keyframe.
    const video = { clip: null, at: 0 };
    const h264 = !!options.h264 && !["depth", "blend", "side", "left", "right"].includes(options.picture) && options.night !== "on";
    if (h264) SimulatedOak.h264().then((clip) => (video.clip = clip));
    onMessage({ status: "running", camera: options.device ? `Simulated OAK ${options.device}` : "Simulated OAK", width: w, height: h, depth: true, depthCameras: true, id: options.device || "SIMULATED-OAK", usb: "SUPER",
      far: options.far || null, // (the checks see which far-away mode it was started in)
      detect: !!options.detect, picture: ["depth", "blend", "side", "left", "right"].includes(options.picture) ? options.picture : "color", motion: !!options.motion, fps: options.fps || null, hands: options.hands !== false,
      // (an infrared camera, as an OAK-D Pro: night vision as asked, Automatic taken to be light)
      infrared: true, night: options.night === "on", nightMode: options.night || "off", dots: !!options.dots, lm: options.lm || "lite", twoHands: !!options.twoHands, xyz: !!options.xyz,
      imu: !!options.imu, imuToCamera: options.imu ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]] : null, // (its motion sensor on its camera's own axes)
      h264 }); // (h264: its colour picture's H.264 too, when asked)
    this.timer = setInterval(() => {
      const t = (Date.now() - t0) / 1000;
      const cx = 0.5 + 0.2 * Math.sin(t), cy = 0.75;
      const hand = { lm: T.map(([x, y]) => [cx + x, cy + y, 0]), world: T.map(([x, y]) => [x * 0.75, y * 0.75, 0]), label: "Left", anatomical: false, score: 0.97, lm_score: 0.95, xyz: [120, -40, 850] };
      // (CLOCK-<ms>: its own clock started that long after it did, as a real helper's starts
      // once its camera's running, seconds after its tile opened)
      const frame = { t: Math.round(t * 1000) - clockLate, u: Date.now(), w, h, fps: 30, hands: options.hands === false ? [] : [hand] };
      // Its chip's temperature (one whose id has HOT-<°C>: that hot, for the checks' too-hot alerts).
      frame.chipC = Number((/HOT-(\d+)/.exec(options.device || "") || [])[1]) || 47.5;
      // As oak_bridge.py --simulate: a cat walking along the bottom (moving its ninth of the
      // picture) and a person standing at the left.
      const catX = ((t * 0.25) % 1.2) - 0.1;
      if (options.detect) {
        frame.objects = [{ label: "person", score: 0.85, box: [0.05, 0.1, 0.3, 0.98], xyz: [-1400, 0, 3500] }];
        if (catX > -0.06 && catX < 1.06) frame.objects.unshift({ label: "cat", score: 0.9, box: [Math.max(0, catX - 0.08), 0.72, Math.min(1, catX + 0.08), 0.95], xyz: [Math.round((catX - 0.5) * 3000), 600, 3000] });
      }
      if (options.motion) frame.motion = [0, 0, 0, 0, 0, 0, 0, 1, 2].map((_, i) => (i >= 6 && catX >= 0 && catX < 1 && Math.floor(catX * 3) === i - 6 ? 0.3 : 0));
      // A camera whose id has FREEZES sends nothing after its first second, the first time it
      // runs (for the checks' starting a frozen camera again).
      if (frozen && Date.now() - t0 > 1000) return;
      if (video.clip) {
        const pic = video.clip[video.at++ % video.clip.length];
        onMessage({ video: { u: frame.u, key: pic.key }, data: pic.data });
      }
      if (options.imu) {
        const now = Date.now();
        frame.imu = [];
        for (let k = 3; k >= 1; k--) frame.imu.push([now - k * 10, 0.1, -9.8, 0.2, 0.01, 0.5 * Math.sin(t), 0]);
      }
      // A camera whose id has BEACON-<ms> films a beacon flashing once a second (white for the
      // first half), that many ms late (for the checks' timing check).
      if (beacon) return onMessage({ frame, jpeg: (Date.now() - beacon.lag) % 1000 < 500 ? beacon.white : beacon.black });
      onMessage({ frame, jpeg });
    }, 33);
    // A camera whose id has CRASHES crashes after a second each time it runs, as oak_bridge.py
    // says a camera whose own software crashed did (for the checks' starting it again).
    if (/CRASHES/.test(options.device || "")) {
      const timer = this.timer;
      setTimeout(() => {
        if (this.timer !== timer) return;
        clearInterval(timer);
        this.timer = null;
        onMessage({ status: "error", message: "The OAK camera's own software crashed (not its cable or its USB).", crashed: true });
        onMessage({ status: "stopped", code: 6, detail: "" });
      }, 1000);
    }
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.onMessage({ status: "stopped", code: 0, detail: "" });
  }
}

// ---------- the Kinect for Xbox One (kinect.js) ----------
// Each one a tile of "Several cameras" (multi-camera.js): a helper each, its pictures (with their
// depth) to the page, which finds the hands; a frame is dropped while the page is still on the
// last. While a take records, its depth, infrared, sound (and the colour camera's own pictures,
// when asked for) are written here as they come, and saved with the take when it stops.
const KINECT_ID = /^[A-Za-z0-9._-]{1,64}$/;
// (A Kinect for Xbox 360's own: its tilt motor, -27° to 27°, and its light.)
const KINECT_COMMAND = /^(source (color|infrared|auto)|exposure auto -?\d(\.\d{1,2})?|exposure manual \d{1,2}(\.\d{1,2})? \d(\.\d{1,2})?|whitebalance auto|led \d{1,4}|depthrange \d{1,2}(\.\d{1,2})? \d{1,2}(\.\d{1,2})?|filters (on|off)|tilt -?\d{1,2}|light (off|green|red|yellow|blink-green|blink-red-yellow))$/;
function registerKinectIpc() {
  // (The checks' stand-in Kinect, while HAND_TRACKER_KINECT_SIMULATE is set: read each time, so only the Kinect checks see it;
  // set to "360", a Kinect for Xbox 360.)
  const simulated = () => !!process.env.HAND_TRACKER_KINECT_SIMULATE;
  const u8 = (b) => (b ? new Uint8Array(b) : null); // (a copy: just its own bytes go to the page)
  const nameOf = (id) => (is360(id) ? "Kinect for Xbox 360" : "Kinect for Xbox One");
  handle("kinect:available", () => (simulated() ? { ok: true, simulated: true } : KinectCamera.available()));
  handle("kinect:list", async () => {
    if (simulated()) return process.env.HAND_TRACKER_KINECT_SIMULATE === "360" ? [{ id: "360-SIMULATED360", name: "Kinect for Xbox 360", model: "360" }] : [{ id: "SIMULATED-KINECT", name: "Kinect for Xbox One", model: "one" }];
    // (The other checks find no real Kinect, even one plugged into the computer they run on.)
    const found = process.env.HAND_TRACKER_KINECT_NONE ? [] : await KinectCamera.list(app.getPath("userData")).catch(() => []);
    // (One running is plugged in, even if listing it fails while it's in use.)
    for (const id of kinectStreams.keys()) if (!found.some((k) => k.id === id)) found.push({ id, name: nameOf(id), model: is360(id) ? "360" : "one" });
    return found;
  });
  handle("kinect:stream-start", (event, { id, ...options } = {}) => {
    if (!KINECT_ID.test(String(id || ""))) throw new Error("Which Kinect?");
    stopKinectStream(id);
    const viewer = event.sender;
    const stream = { cam: simulated() ? new SimulatedKinect() : new KinectCamera(app.getPath("userData")), busy: false, viewer, take: null, audio: null };
    kinectStreams.set(id, stream);
    const opts = { device: id, source: options.source, size: options.size, mics: options.mics !== false, pipeline: options.pipeline, tilt: options.tilt, light: options.light };
    stream.cam.start(opts, (msg) => {
      if (kinectStreams.get(id) !== stream && msg.status !== "stopped") return;
      if (viewer.isDestroyed()) return stopKinectStream(id);
      if (msg.frame) {
        if (stream.busy) return;
        stream.busy = true;
        viewer.send("kinect:frame", { id, header: msg.frame, jpeg: u8(msg.jpeg), depth: u8(msg.depth), body: u8(msg.body), audio: stream.audio });
      } else if (msg.raw) {
        if (stream.take) stream.take.raw(msg.raw, msg.depth, msg.ir);
      } else if (msg.rawcolor) {
        if (stream.take) stream.take.color(msg.rawcolor, msg.jpeg);
      } else if (msg.audio) {
        const a = msg.audio;
        stream.audio = { level: a.level, angle: a.angle, confidence: a.confidence, delays: a.delays, u: a.u, beamAngle: a.beamAngle, active: a.active, snr: a.snr };
        if (stream.take) stream.take.audio(a, msg.pcm, msg.beam);
      } else if (kinectStreams.get(id) === stream || !kinectStreams.has(id)) {
        if (msg.status === "running") stream.params = { color: msg.color || null, ir: msg.ir || null }; // (its cameras', for its MCAP file)
        viewer.send("kinect:status", { id, ...msg });
      }
    });
    return true;
  });
  // A Kinect for Xbox 360's audio firmware (Linux and the Mac): the person's copy of Microsoft's audios.bin, chosen here and kept.
  handle("kinect:choose-firmware", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: "Choose the Kinect for Xbox 360's audio firmware (audios.bin)",
      buttonLabel: "Use This",
      properties: ["openFile"],
      filters: [{ name: "Firmware", extensions: ["bin"] }, { name: "All files", extensions: ["*"] }],
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
    return KinectCamera.setFirmware(app.getPath("userData"), filePaths[0]);
  });
  ipcMain.on("kinect:shown", (event, id) => {
    const stream = kinectStreams.get(id);
    if (stream) stream.busy = false;
  });
  handle("kinect:command", (event, { id, line } = {}) => {
    const stream = kinectStreams.get(String(id));
    if (stream && simulated() && (line === "stall" || line === "stuck")) return stream.cam.command(line), true; // (the checks' stand-in Kinect stopping)
    if (!stream || !KINECT_COMMAND.test(String(line || ""))) return false;
    stream.cam.command(String(line));
    return true;
  });
  handle("kinect:stream-stop", (event, id) => {
    for (const key of id ? [id] : [...kinectStreams.keys()]) stopKinectStream(key);
    return true;
  });
  // A take: { depth, ir, color, sound } as wanted.
  handle("kinect:record-start", (event, { id, depth, ir, color, sound } = {}) => {
    const stream = kinectStreams.get(String(id));
    if (!stream) return false;
    if (stream.take) stream.take.abort();
    const folder = path.join(app.getPath("temp"), `hand-tracker-kinect-${process.pid}-${String(id).replace(/[^\w-]/g, "")}-${Date.now()}`);
    stream.take = new KinectTake(folder, { depth: depth !== false, ir: ir !== false, color: !!color, sound: sound !== false });
    stream.cam.command("record on");
    if (color) stream.cam.command("rawcolor on");
    return true;
  });
  // The take's end: no more is kept (saved next, by record-stop, once the take is named).
  handle("kinect:record-end", (event, id) => {
    const stream = kinectStreams.get(String(id));
    if (!stream || !stream.take) return false;
    stream.cam.command("record off");
    stream.cam.command("rawcolor off");
    return true;
  });
  // Its files, saved into remote recording's folder as <take>-<kind>-<role>: { dir, files: [{ kind,
  // path, startMs, times, frames, seconds }], errors }; and its depth, infrared and colour as an
  // MCAP file of their own, <take>-kinect-<role>.mcap (kinect-mcap.js), made after (mcap: "wait":
  // before this answers, with its result as mcap). keep false: thrown away.
  handle("kinect:record-stop", async (event, { id, baseName, role, keep = true, mcap } = {}) => {
    const stream = kinectStreams.get(String(id));
    if (!stream || !stream.take) return { files: [], errors: [] };
    stream.cam.command("record off");
    stream.cam.command("rawcolor off");
    const take = stream.take;
    stream.take = null;
    if (!keep) {
      take.abort();
      return { files: [], errors: [] };
    }
    const made = await take.finish();
    const dir = remoteFolder();
    await fs.promises.mkdir(dir, { recursive: true });
    const base = exporter.sanitizeBaseName(baseName || `Kinect_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}`);
    const slug = String(role || "kinect").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 16) || "kinect";
    const NAMES = { depth: "depth", ir: "infrared", color: "colour", sound: "sound", beam: "sound-beam", direction: "sound-direction" };
    const files = [];
    for (const f of made) {
      const ext = path.extname(f.file).slice(1);
      const out = exporter.uniquePath(dir, `${base}-${NAMES[f.kind] || f.kind}-${slug}`, ext);
      await fs.promises.rename(f.file, out).catch(() => fs.promises.copyFile(f.file, out));
      exportedPaths.add(out);
      let times = null;
      if (f.times) {
        times = out.replace(/\.[^.]+$/, "-times.csv");
        await fs.promises.rename(f.times, times).catch(() => fs.promises.copyFile(f.times, times));
        exportedPaths.add(times);
      }
      files.push({ kind: f.kind, path: out, startMs: f.startMs, times, frames: f.frames, seconds: f.seconds });
    }
    fs.rmSync(take.folder, { recursive: true, force: true });
    let made2 = null;
    const pictures = files.filter((f) => ["depth", "ir", "color"].includes(f.kind));
    if (pictures.length) {
      const out = exporter.uniquePath(dir, `${base}-kinect-${slug}`, "mcap");
      const params = stream.params || {};
      const job = writeKinectMcap(out, { name: role || "kinect", files: pictures, color: params.color, ir: params.ir }).then((r) => {
        if (r.ok) exportedPaths.add(out);
        return { ...r, path: r.ok ? out : null };
      });
      if (mcap === "wait") made2 = await job;
      else job.catch(() => {});
    }
    return { dir, files, errors: take.errors, mcap: made2 };
  });
}

function stopKinectStream(id) {
  const stream = kinectStreams.get(id);
  if (!stream) return;
  kinectStreams.delete(id);
  if (stream.take) stream.take.abort();
  stream.cam.stop();
}

// ---------- the PlayStation 4 camera (ps4cam.js) ----------
// Each one a tile of "Several cameras" (multi-camera.js): a helper each, its left lens's picture,
// the picture its view makes and its depth to the page, which finds the hands. The helper makes the
// next frame as each one goes to the page; it waits while the page is still on that one, and goes
// as soon as it's done.
const PS4_ID = /^[0-9]{1,3}-[0-9.]{1,24}$/;
const PS4_COMMAND = /^(view (left|right|side|anaglyph|blend|merged|depth|depth-blend|depth-side)|depth (on|off)|night (auto|on|off))$/;
function registerPs4Ipc() {
  // (The checks' stand-in PS4 camera, while HAND_TRACKER_PS4CAM_SIMULATE is set: read each time, so only its checks see it.)
  const simulated = () => !!process.env.HAND_TRACKER_PS4CAM_SIMULATE;
  const u8 = (b) => (b ? new Uint8Array(b) : null);
  handle("ps4cam:available", () => (simulated() ? { ok: true, simulated: true } : Ps4Camera.available()));
  handle("ps4cam:status", () => (simulated() ? { ready: true, firmware: true, simulated: true } : Ps4Camera.status(app.getPath("userData"))));
  handle("ps4cam:setup", (event) =>
    Ps4Camera.setup(app.getPath("userData"), (line) => {
      if (!event.sender.isDestroyed()) event.sender.send("ps4cam:setup-progress", line);
    })
  );
  // Its firmware: the person's copy of Sony's firmware.bin, chosen here and kept.
  handle("ps4cam:choose-firmware", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: "Choose the PS4 camera's firmware (firmware.bin)",
      buttonLabel: "Use This",
      properties: ["openFile"],
      filters: [{ name: "Firmware", extensions: ["bin"] }, { name: "All files", extensions: ["*"] }],
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
    return Ps4Camera.setFirmware(app.getPath("userData"), filePaths[0]);
  });
  handle("ps4cam:list", async () => {
    if (simulated()) return { devices: [{ id: "0-1", name: "PlayStation 4 camera", ready: true }], setup: false, firmware: true };
    // (The other checks find no real PS4 camera, even one plugged into the computer they run on.)
    if (process.env.HAND_TRACKER_PS4CAM_NONE) return { devices: [], setup: false, firmware: true };
    const found = await Ps4Camera.list(app.getPath("userData")).catch(() => ({ devices: [], setup: false, firmware: true }));
    // (One running is plugged in, even if listing it fails while it's in use.)
    for (const id of ps4Streams.keys()) if (!found.devices.some((c) => c.id === id)) found.devices.push({ id, name: "PlayStation 4 camera", ready: true });
    return found;
  });
  handle("ps4cam:stream-start", (event, { id, ...options } = {}) => {
    if (!PS4_ID.test(String(id || ""))) throw new Error("Which PS4 camera?");
    stopPs4Stream(id);
    const viewer = event.sender;
    const stream = { cam: simulated() ? new SimulatedPs4Camera() : new Ps4Camera(app.getPath("userData")), busy: false, next: null, viewer };
    ps4Streams.set(id, stream);
    const opts = { device: id, size: options.size, fps: options.fps, view: options.view, depth: !!options.depth, night: options.night };
    stream.cam.start(opts, (msg) => {
      if (ps4Streams.get(id) !== stream && msg.status !== "stopped") return;
      if (viewer.isDestroyed()) return stopPs4Stream(id);
      if (msg.frame) {
        const frame = { id, header: msg.frame, jpeg: u8(msg.jpeg), shown: u8(msg.shown), depth: u8(msg.depth) };
        if (stream.busy) {
          stream.next = frame;
          return;
        }
        stream.busy = true;
        viewer.send("ps4cam:frame", frame);
        stream.cam.next();
      } else if (ps4Streams.get(id) === stream || !ps4Streams.has(id)) {
        viewer.send("ps4cam:status", { id, ...msg });
      }
    });
    return true;
  });
  ipcMain.on("ps4cam:shown", (event, id) => {
    const stream = ps4Streams.get(id);
    if (!stream) return;
    const next = stream.next;
    stream.next = null;
    if (next && !stream.viewer.isDestroyed()) {
      stream.viewer.send("ps4cam:frame", next);
      stream.cam.next();
    } else stream.busy = false;
  });
  handle("ps4cam:command", (event, { id, line } = {}) => {
    const stream = ps4Streams.get(String(id));
    if (!stream || !PS4_COMMAND.test(String(line || ""))) return false;
    stream.cam.command(String(line));
    return true;
  });
  handle("ps4cam:stream-stop", (event, id) => {
    for (const key of id ? [id] : [...ps4Streams.keys()]) stopPs4Stream(key);
    return true;
  });
}

function stopPs4Stream(id) {
  const stream = ps4Streams.get(id);
  if (!stream) return;
  ps4Streams.delete(id);
  stream.cam.stop();
}

// ---------- Capture sessions from a capture-operations dashboard (hidden feature) ----------
function registerOpsIpc() {
  ops = new OpsClient(app.getPath("userData"), (url, init) => net.fetch(url, init), safeStorage);
  handle("ops:status", () => ops.status());
  handle("ops:configure", (event, { site }) => ops.configure(site));
  handle("ops:send-code", (event, { email }) => ops.sendCode(email));
  handle("ops:verify-code", (event, { email, code }) => ops.verifyCode(email, code));
  handle("ops:password", (event, { email, password }) => ops.signInWithPassword(email, password));
  handle("ops:sign-out", () => ops.signOut());
  // Sign in on the dashboard's own page, in a window of its own (a separate, private
  // browser profile with no access to the app), then take the session it keeps.
  handle("ops:sign-in-with-site", (event) => signInWithSite(BrowserWindow.fromWebContents(event.sender)));
  handle("ops:sessions", (event, query) => ops.sessions(query || {}));
  handle("ops:manifest", (event, { sessionId }) => ops.manifest(String(sessionId)));
  handle("ops:stream", (event, { sessionId, path: rel }) => ({ url: `${SCHEME}://${HOST}/__ops/${ops.stream(String(sessionId), String(rel))}` }));
  handle("ops:forget", (event, { url }) => {
    const id = String(url || "").split("/__ops/")[1];
    if (id) ops.forget(id);
  });
}

// ---------- A phone controlling this computer (the Android app, over Wi-Fi) ----------
// Only while "Let a phone control this PC" is on; the pairing key is kept encrypted by the
// operating system (or for this run only, where it can't be).
let phoneLink = null;
let webLink = null;
function registerLinkIpc() {
  const file = path.join(app.getPath("userData"), "phone-link.json");
  const keyStore = {
    load: () => {
      try {
        const saved = JSON.parse(fs.readFileSync(file, "utf8"));
        return saved.key && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(saved.key, "base64")) : null;
      } catch {
        return null;
      }
    },
    save: (key) => {
      if (!safeStorage.isEncryptionAvailable()) return;
      fs.writeFileSync(file, JSON.stringify({ key: safeStorage.encryptString(key).toString("base64") }));
    },
  };
  // What the phone asks for, carried out like this app's own hand mouse and keyboard.
  const handlePhone = async (type, d) => {
    if (type === "keyboard") {
      if (d.show) openKeyboard();
      else closeKeyboard();
      return { shown: !!d.show };
    }
    await input.start();
    if (type === "pointer") {
      const p = screenPoint(d.nx, d.ny, d.screen);
      input.move(p.x, p.y);
    } else if (type === "button") input.button(String(d.which), String(d.action));
    else if (type === "wheel") input.wheel(Math.max(-20, Math.min(20, Math.round(Number(d.notches) || 0))));
    else if (type === "key") input.key(String(d.combo), String(d.action || "tap"));
    else if (type === "text") input.text(String(d.text || "").slice(0, 2000));
    else throw new Error(`Unknown request: ${type}`);
    return null;
  };
  phoneLink = new PhoneLinkServer({ handle: handlePhone, keyStore });
  phoneLink.on("status", (s) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("link:status", s);
  });
  handle("link:status", () => phoneLink.status());
  handle("link:start", () => phoneLink.start());
  handle("link:stop", () => phoneLink.stop());
  handle("link:new-key", () => phoneLink.newKey());

  // The Hand Tracker website's hand mouse, through this app (electron/web-link.js): only while
  // "Let the website control this computer" is on, from this computer only.
  const { WebLink } = require("./web-link");
  webLink = new WebLink({ handle: (type, d) => handlePhone(type, d) });
  webLink.on("status", (st) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("weblink:status", st);
  });
  handle("weblink:status", () => webLink.status());
  handle("weblink:start", () => webLink.start());
  handle("weblink:stop", () => webLink.stop());
}

// ---------- Remote recording: a phone starts and stops motion capture (remote-record.js) ----------
function remoteFolder() {
  return process.env.HAND_TRACKER_REMOTE_DIR || readSettings().remoteDir || path.join(app.getPath("documents"), "Hand Tracker recordings");
}

// Clips being recorded, each written to its own file as it comes (clip:open/write/discard; files:save-remote's
// clipId moves it into place).
const CLIP_PART = /^\.recording-[\w-]{1,40}\.(mp4|webm)\.part$/;
const clips = {
  live: new Map(), // id -> { file, handle, size, writing }
  next: 0,
  async open(ext) {
    if (!["mp4", "webm"].includes(ext)) throw new Error("Unsupported clip type");
    const dir = remoteFolder();
    await fs.promises.mkdir(dir, { recursive: true });
    const id = `${process.pid}-${Date.now().toString(36)}-${++this.next}`;
    const file = path.join(dir, `.recording-${id}.${ext}.part`);
    this.live.set(id, { file, handle: await fs.promises.open(file, "w"), size: 0, writing: Promise.resolve(), flushed: {} });
    return id;
  },
  async write(id, data) {
    const c = this.live.get(String(id));
    if (!c) throw new Error("That clip isn't being recorded.");
    const buf = Buffer.from(data);
    // (on the drive every 2 s, so a power cut loses seconds, not the take: flush-often.js)
    c.writing = c.writing.then(() => c.handle.write(buf, 0, buf.length, c.size)).then(() => (c.size += buf.length)).then(() => FlushOften.handle(c.flushed, c.handle));
    await c.writing;
    return c.size;
  },
  async close(id) {
    const c = this.live.get(String(id));
    if (!c) throw new Error("That clip isn't being recorded.");
    this.live.delete(String(id));
    await c.writing.catch(() => {});
    await c.handle.datasync().catch(() => {});
    await c.handle.close().catch(() => {});
    return c;
  },
  async finish(id, out) {
    const c = await this.close(id);
    if (!c.size) {
      await fs.promises.rm(c.file, { force: true });
      throw new Error("nothing was recorded");
    }
    await fs.promises.rename(c.file, out);
  },
  async discard(id) {
    const c = await this.close(id).catch(() => null);
    if (c) await fs.promises.rm(c.file, { force: true }).catch(() => {});
    return true;
  },
  // Ones left by a crash (this app closed while a clip recorded): kept as Recovered_<when>-video.<ext>.
  async recover() {
    const dir = remoteFolder();
    let names = [];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return;
    }
    for (const name of names.filter((n) => CLIP_PART.test(n))) {
      const file = path.join(dir, name);
      if ([...this.live.values()].some((c) => c.file === file)) continue;
      try {
        const st = await fs.promises.stat(file);
        if (!st.size) {
          await fs.promises.rm(file, { force: true });
          continue;
        }
        const ext = CLIP_PART.exec(name)[1];
        const t = st.mtime, p = (n) => String(n).padStart(2, "0");
        const out = exporter.uniquePath(dir, `Recovered_${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}_${p(t.getHours())}-${p(t.getMinutes())}-${p(t.getSeconds())}-video`, ext);
        await fs.promises.rename(file, out);
        if (ext === "mp4") await exporter.finishClip(out, "video/mp4").catch(() => {});
      } catch {}
    }
  },
};

// A clip's labels as a layer of their own (electron/label-layers.js): the clips of the remote recording folder
// (takes' cameras, Sentry's) made into <name>.mkv with the labels as tracks and <name> (labels).mp4 with them drawn
// in, in the background, held while a clip records; the steps followed in the folders takes are in.
let labelLayersOne = null;
function labelLayers() {
  if (!labelLayersOne) {
    labelLayersOne = new LabelLayers({
      folder: remoteFolder,
      stateFile: path.join(app.getPath("userData"), "label-layers.json"),
      busy: () => labelLayersOne.live.size > 0,
      // (a clip as recorded is kept while a page is playing or downloading it)
      inUse: (file) => !!(remoteRecord && remoteRecord.takes && remoteRecord.takes.readLately(path.basename(file))),
      onDone: (d) => {
        for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("labels:done", d);
      },
    });
  }
  return labelLayersOne;
}

// Opening the app at login, waiting for the phone (--remote-standby): the desktop's autostart
// entry on Linux, a login item on Windows, a launch agent on a Mac (a login item there can't be
// given --remote-standby). Only for the installed app. Each app has its own (Remote Recording's
// opens as its rig).
const autostart = {
  file: () =>
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "LaunchAgents", `${APP.id}.standby.plist`)
      : path.join(os.homedir(), ".config", "autostart", `${APP.slug}.desktop`),
  available: () => app.isPackaged && ["linux", "win32", "darwin"].includes(process.platform),
  // Windows: the portable .exe itself (it runs from a copy it unpacks, deleted when it closes).
  login: () => ({ path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: ["--remote-standby"] }),
  get() {
    if (!this.available()) return false;
    if (process.platform !== "win32") return fs.existsSync(this.file());
    return app.getLoginItemSettings(this.login()).openAtLogin;
  },
  set(on) {
    if (!this.available()) throw new Error("Only the installed app can open at login.");
    // A Mac app opened from the disk image, or from where it was downloaded (macOS runs that from
    // a copy it moves each time), isn't there at login.
    if (process.platform === "darwin" && on && /^\/Volumes\/|\/AppTranslocation\//.test(process.execPath)) {
      throw new Error(`Move ${APP.name} into Applications and open it from there first: from where it's open now, it can't open at login.`);
    }
    if (process.platform === "win32") {
      app.setLoginItemSettings({ openAtLogin: !!on, ...this.login() });
    } else if (process.platform === "darwin" && on) {
      const xml = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const plist = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0"><dict>',
        `<key>Label</key><string>${APP.id}.standby</string>`,
        `<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>--remote-standby</string></array>`,
        "<key>RunAtLoad</key><true/>",
        "<key>ProcessType</key><string>Interactive</string>",
        "</dict></plist>",
      ];
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      fs.writeFileSync(this.file(), plist.join("\n") + "\n");
    } else if (on) {
      const exe = process.env.APPIMAGE || process.execPath;
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      // (Inside the Exec line's quotes, ", `, $ and \ are escaped with a \.)
      const exec = `"${exe.replace(/["`$\\]/g, (c) => `\\${c}`)}" --remote-standby`;
      const entry = ["[Desktop Entry]", "Type=Application", `Name=${APP.name}`, "Comment=Waits for remote recording from a phone", `Exec=${exec}`, "Terminal=false", "X-GNOME-Autostart-enabled=true"];
      fs.writeFileSync(this.file(), entry.join("\n") + "\n");
    } else {
      fs.rmSync(this.file(), { force: true });
    }
    return this.get();
  },
};

// One request from this app's remote recording page to another computer's Hand Tracker
// (a page can't reach a device on the network itself): only what RIG_HOST and RIG_PATH allow
// (remote-record.js).
const RIG_ANSWER_BYTES = 4 << 20;
function rigRequest({ rig, path: where, method = "GET", body = null, key = "" } = {}) {
  const m = RIG_HOST.exec(String(rig || ""));
  const port = m ? Number(m[5]) : 0;
  if (!m || port < 1 || port > 65535) throw new Error("That isn't a computer's name and port.");
  if (!RIG_PATH.test(String(where || "")) || (method === "POST") !== (where === "/api/command" || where === "/api/talk" || /^\/api\/imu/.test(where)) || !["GET", "POST"].includes(method)) throw new Error("Not a remote recording request.");
  if (body != null && (typeof body !== "string" || body.length > 8192)) throw new Error("Too long.");
  const headers = {};
  if (/^[A-Za-z0-9_-]{8,64}$/.test(String(key || ""))) headers["X-Key"] = key;
  if (body) Object.assign(headers, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: m[1].replace(/^\[|\]$/g, ""), port, path: where, method, headers, timeout: 10000 }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > RIG_ANSWER_BYTES) req.destroy(new Error("The answer was too big."));
        else chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode, type: String(res.headers["content-type"] || ""), body: new Uint8Array(Buffer.concat(chunks)) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("No answer.")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function registerRemoteIpc() {
  const file = path.join(app.getPath("userData"), "remote-record.json");
  const keyStore = {
    load: () => {
      try {
        const saved = JSON.parse(fs.readFileSync(file, "utf8"));
        return saved.key && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(saved.key, "base64")) : null;
      } catch {
        return null;
      }
    },
    save: (key) => {
      if (!safeStorage.isEncryptionAvailable()) return;
      fs.writeFileSync(file, JSON.stringify({ key: safeStorage.encryptString(key).toString("base64") }));
    },
  };
  const toWindow = (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
  };
  // What the phone asks for, carried out by the main window (remote-record-ui.js).
  const pending = new Map();
  let asked = 0;
  const ask = (action, extra = {}) =>
    new Promise((resolve) => {
      // The app itself closed and opened again: done here, so it works when the window's page has
      // died (a computer out of memory) and nothing there answers.
      if (action === "restartApp") return resolve(restartApp());
      if (!mainWindow || mainWindow.isDestroyed()) return resolve({ ok: false, message: "Hand Tracker's window isn't open." });
      const id = ++asked;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, message: "Hand Tracker didn't answer." });
      }, 30000);
      pending.set(id, (result) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(result);
      });
      toWindow("remote:command", { ...extra, id, action });
    });
  // Over Bluetooth too, where this computer has it (Linux, for now) and a password is set: each
  // request the link carries goes to the remote recording server here.
  rigBluetooth = new RigBluetooth({ dataDir: app.getPath("userData"), name: os.hostname(), relay: (r) => remoteRecord.relay(r) });
  remoteRecord = new RemoteRecordServer({
    keyStore,
    page: (name) => fs.readFileSync(path.join(APP_ROOT, name === "js" ? "remote-client.js" : name === "bt" ? "bt-link-client.js" : "remote-client.html"), "utf8"),
    ask,
    onWantPreviews: (on) => {
      toWindow("remote:want-previews", on);
      previewsWatched = !!(on && on.on);
      transmission.watching(previewsWatched || videoWatched);
    },
    wifi: createWifi(), // a phone on the hotspot (or over Tailscale) can change the Wi-Fi
    takes: () => remoteFolder(), // its takes: listed, downloaded, and deleted once downloaded
    bluetoothPassword: (text) => checkBluetoothPassword(rigBluetooth.secret(), text), // a phone on the Bluetooth network
    imu: (id, name, text) => (imuWanted ? imuIn.ingest(id, name, text) : -1), // a motion sensor's readings sent to the page (electron/imu-in.js); -1: they're off
    history: (span, after) => roomHistory.get(span, after), // the device settings page's graphs (room-history.js)
  });
  // CPU, GPU, memory and space read every second for those graphs (the last hour of seconds, a week of
  // minutes: kept while the app runs); the Space line's CPU, GPU and memory are the latest reading.
  let lastRoom = null;
  const roomHistory = new RoomHistory({
    file: path.join(app.getPath("userData"), "room-history.jsonl"),
    sample: async () => {
      const { memory, busy } = (lastRoom = await roomMetrics());
      const space = await storage.space(remoteFolder()).catch(() => null);
      const b = busy || {};
      return {
        ...b,
        mem: memory && memory.total ? (1 - memory.available / memory.total) * 100 : null,
        appMem: memory && memory.total && memory.app ? (memory.app / memory.total) * 100 : null,
        disk: space && space.total ? (1 - space.free / space.total) * 100 : null,
      };
    },
  });
  roomHistory.start();
  // Motion sensors other than the OAK cameras' (electron/imu-in.js): on while remote recording is, their
  // readings to the window (multi-camera.js), which gives each a posture and records it with the takes.
  imuIn.on("readings", (r) => toWindow("imu:readings", r));
  imuIn.on("status", (s) => toWindow("imu:status", s));
  handle("imu:status", () => imuIn.status());
  handle("imu:enable", (event, on) => {
    if (!fromApp(event)) return false;
    imuWanted = !!on;
    if (imuWanted && remoteRecord.server) imuIn.start();
    else if (!imuWanted) imuIn.stop();
    return imuWanted;
  });
  remoteRecord.on("status", (s) => toWindow("remote:status", s));
  // (someone listening to the baby monitor live, or not any more: baby-monitor.js sends its sound meanwhile)
  remoteRecord.on("want-listen", (on) => toWindow("remote:want-listen", !!on));
  // (someone talking to the baby: a quarter of a second of their voice, or { stop }, for baby-monitor.js to play)
  remoteRecord.on("talk", (t) => toWindow("remote:talk", t && t.stop ? { stop: true } : { seq: t.seq, data: new Uint8Array(t.data) }));
  // (A page playing a camera's video wants the network as one looking at its pictures does.)
  remoteRecord.on("video-watch", (on) => {
    videoWatched = !!on;
    transmission.watching(previewsWatched || videoWatched);
  });
  rigBluetooth.on("status", (s) => toWindow("remote:bluetooth", s));
  const startBluetooth = () => (rigBluetooth.available() && remoteRecord.server ? rigBluetooth.start().catch(() => {}) : null);
  const fromApp = (event) => event.senderFrame && isAppUrl(event.senderFrame.url);
  handle("remote:status", () => remoteRecord.status());
  handle("remote:start", async () => {
    const s = await remoteRecord.start();
    startBluetooth();
    if (imuWanted) imuIn.start();
    return s;
  });
  handle("remote:stop", () => {
    rigBluetooth.stop();
    imuIn.stop();
    return remoteRecord.stop();
  });
  // Bluetooth: how it is ({ available, on, error, address, password: null | "hotspot" | "set" }),
  // and its password set here (8 to 63 characters; kept as its key only).
  handle("remote:bluetooth", () => rigBluetooth.status());
  handle("remote:set-bluetooth-password", (event, password) => {
    const s = rigBluetooth.setPassword(password);
    startBluetooth();
    return s;
  });
  // This computer restarted, its cameras' USB turned off and on (the device settings page). The
  // checks (HAND_TRACKER_SYSTEM_SIMULATE) only note what was asked, in global.__systemAsked.
  const simulateSystem = !!process.env.HAND_TRACKER_SYSTEM_SIMULATE;
  global.__systemAsked = [];
  handle("remote:system", async () => ({ ...(simulateSystem ? { reboot: "yes", powerOff: "yes", cameraReset: "power" } : await systemControl.capabilities()), restartApp: "yes" }));
  // This app closed and opened again, as it was opened (waiting for the phone, if it was): the
  // remote recording page's Restart the app, and the button here. While recording, the take is
  // stopped and saved first, as Stop would (its page is asked, and waited for while it saves:
  // SAVE_WAIT_MS at most, so an app stuck recording restarts all the same). A page that has died
  // has nothing left to save.
  const SAVE_WAIT_MS = 120000;
  const state = () => (remoteRecord && remoteRecord.state) || {};
  const saveThenRelaunch = async () => {
    const until = Date.now() + SAVE_WAIT_MS;
    if (state().recording) await ask("stop").catch(() => null);
    while (Date.now() < until && (state().recording || state().saving)) await new Promise((r) => setTimeout(r, 500));
    relaunchApp();
  };
  restartApp = () => {
    const dead = !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isCrashed();
    const taking = !dead && !!(state().recording || state().saving);
    if (simulateSystem) global.__systemAsked.push(taking ? "restartApp after saving" : "restartApp");
    else if (taking) saveThenRelaunch();
    else setTimeout(relaunchApp, 1200); // (after the answer has gone)
    return { ok: true, message: `${taking ? "Saving the take, then restarting" : "Restarting"} ${APP.name}… This page reconnects when it's back.${simulateSystem ? " (simulated)" : ""}` };
  };
  handle("remote:restart-app", () => restartApp());
  // The room left where takes are saved, whether this computer has a battery, and how hot its
  // processor is (storage.js).
  handle("remote:storage", async () => ({ ...((await storage.space(remoteFolder())) || {}), battery: await storage.hasBattery(), temperature: await storage.temperature(), reserve: await storage.reserve(), uptime: os.uptime(), ...(lastRoom || (await roomMetrics())) }));
  // This computer's memory ({ total, available }, storage.js) and this app's own: what all its
  // processes hold (app) and the most one of its pages does (page), in bytes; and how busy its CPU
  // and GPU are, with this app's share (busy.js: { cpu, appCpu, gpu, appGpu } percentages).
  async function roomMetrics() {
    let all = [];
    try {
      all = app.getAppMetrics();
    } catch {
      // (not told)
    }
    const cpuOf = Object.fromEntries(all.filter((p) => p.cpu).map((p) => [p.pid, p.cpu.percentCPUUsage]));
    const busy = await busyNow(all.map((p) => p.pid), cpuOf).catch(() => null);
    return { memory: memoryNow(all), busy };
  }
  function memoryNow(all) {
    const out = { ...(storage.memory() || {}) };
    try {
      const of = (p) => ((p.memory && p.memory.workingSetSize) || 0) * 1024;
      out.app = all.reduce((sum, p) => sum + of(p), 0);
      out.page = Math.max(0, ...all.filter((p) => p.type === "Tab").map(of));
    } catch {
      // (not told)
    }
    return out;
  }
  handle("remote:power-off", () => {
    if (!simulateSystem) return systemControl.powerOff();
    global.__systemAsked.push("powerOff");
    return { ok: true, message: "Turning off… (simulated)" };
  });
  handle("remote:reboot", () => {
    if (!simulateSystem) return systemControl.reboot();
    global.__systemAsked.push("reboot");
    return { ok: true, message: "Restarting… (simulated)" };
  });
  handle("remote:reset-cameras", () => {
    if (!simulateSystem) return systemControl.resetCameras();
    global.__systemAsked.push("resetCameras");
    return { ok: true, message: "The cameras' USB was turned off and on (simulated).", how: "power", count: 1 };
  });
  // One camera's (its tile's Restart): { serial, usb, dev } (system-control.js's resetCamera).
  handle("remote:reset-camera", (event, match = {}) => {
    const m = {};
    for (const k of ["serial", "usb", "dev"]) if (match && typeof match[k] === "string" && /^[\w.,:-]{1,80}$/.test(match[k])) m[k] = match[k];
    if (!simulateSystem) return systemControl.resetCamera(m);
    global.__systemAsked.push(`resetCamera ${m.dev || m.usb || m.serial}`);
    if (m.serial) SimulatedOak.usbReset.add(m.serial);
    return { ok: true, message: "Its USB was turned off and on (simulated).", how: "power", others: [] };
  });
  // Where one camera is on the USB, for a take's record (multi-camera.js): { serial, usb, dev } as above ->
  // { port, serial, usb, ports } or null (system-control.js's cameraUsb). The checks: each camera asked for
  // in turn on ports 1-1.1, 1-1.2…
  const simulatedPorts = new Map();
  handle("remote:camera-usb", (event, match = {}) => {
    const m = {};
    for (const k of ["serial", "usb", "dev"]) if (match && typeof match[k] === "string" && /^[\w.,:-]{1,80}$/.test(match[k])) m[k] = match[k];
    if (!simulateSystem) return systemControl.cameraUsb(m);
    const key = m.dev || m.serial || m.usb;
    if (!key) return null;
    if (!simulatedPorts.has(key)) simulatedPorts.set(key, `1-1.${simulatedPorts.size + 1}`);
    const port = simulatedPorts.get(key);
    return { port, serial: m.serial || "", usb: m.serial ? "03e7:f63b" : (m.usb || "").split(",")[0], ports: [port] };
  });
  handle("remote:new-key", () => remoteRecord.newKey());
  // The takes in the remote recording folder, on this computer's own screen too: listed, and
  // their details asked for and changed (their files renamed to match: remote-record.js).
  handle("remote:takes", () => remoteRecord.takes.list());
  handle("remote:take-details", (event, id) => remoteRecord.takes.details(String(id || "")));
  handle("remote:edit-take", (event, { id, details } = {}) => remoteRecord.editTake(String(id || ""), cleanDetails(details) || cleanDetails({})));
  remoteRecord.on("takes", (x) => toWindow("remote:takes-changed", x));
  handle("remote:settings", () => ({ standby: remoteStandby, folder: remoteFolder(), autostart: { available: autostart.available(), on: autostart.get() } }));
  handle("remote:set-autostart", (event, on) => autostart.set(!!on));
  // The remote recording page in this app (remote-client.html?rig=…, opened from remote.html)
  // reaches another computer's Hand Tracker through here.
  handle("rig:request", (event, opts) => rigRequest(opts));
  ipcMain.on("remote:state", (event, state) => fromApp(event) && remoteRecord.setState(state));
  // The baby monitor's sound, live: a tenth of a second of 16 kHz mono 16-bit PCM at a time (remote-record.js's /api/listen).
  ipcMain.on("remote:listen-chunk", (event, data) => fromApp(event) && data instanceof Uint8Array && remoteRecord.listenChunk(Buffer.from(data)));
  ipcMain.on("remote:previews", (event, list) => {
    if (!fromApp(event) || !Array.isArray(list)) return;
    for (const p of list) if (p && p.jpeg) remoteRecord.setPreview(Number(p.i), p.jpeg);
  });
  // A webcam's H.264 for full screen (made in the window while a page plays it: camera-tile.js startVideo), one
  // picture with its hands; and which cameras' video pages are playing, for the window.
  ipcMain.on("remote:video", (event, p) => {
    if (!fromApp(event) || !p || typeof p.id !== "string" || !(p.data instanceof Uint8Array) || p.data.length > 4 * 1024 * 1024) return;
    remoteRecord.setVideo(p.id, { u: Number(p.u), key: !!p.key }, Buffer.from(p.data));
    if (remoteRecord.videoWatched(p.id)) remoteRecord.setOverlay(p.id, { u: Number(p.u), hands: Array.isArray(p.hands) ? p.hands : [], objects: [] });
  });
  remoteRecord.on("video-want", (ids) => toWindow("remote:video-want", ids));
  ipcMain.on("remote:result", (event, { id, result } = {}) => {
    const done = fromApp(event) && pending.get(id);
    if (!done) return;
    if (!result || typeof result !== "object") return done({ ok: true });
    const out = { ok: !!result.ok, message: String(result.message || "") };
    // Which take details recording needs first, and whether they're locked (a take has them).
    if (Array.isArray(result.missing)) out.missing = result.missing.filter((k) => ["contributor", "location", "task"].includes(k));
    if (result.locked) out.locked = true;
    done(out);
  });
}

function registerFleetIpc() {
  fleet = new FleetClient(app.getPath("userData"), session.fromPartition("persist:capture-fleet"), safeStorage);
  handle("fleet:status", () => fleet.check());
  handle("fleet:configure", (event, { site }) => fleet.configure(site));
  handle("fleet:sign-in", (event) => fleet.signIn(BrowserWindow, BrowserWindow.fromWebContents(event.sender)));
  handle("fleet:sign-out", () => fleet.signOut());
  handle("fleet:rigs", () => fleet.rigs());
  handle("fleet:sessions", (event, { host }) => fleet.sessions(host));
  // The videos recorded with a motion capture, added to its MCAP file (mcap-video.js): saved
  // ones by their path, one only in the page (its bytes) through a file of its own for a moment.
  handle("mcap:add-videos", async (event, { mcap, videos }) => {
    const list = [];
    const temps = [];
    try {
      for (const v of Array.isArray(videos) ? videos : []) {
        if (!v || !Number.isFinite(v.startMs)) continue;
        if (typeof v.path === "string") list.push({ path: v.path, name: String(v.name || "camera"), startMs: v.startMs });
        else if (v.data instanceof Uint8Array && v.data.length) {
          const file = path.join(app.getPath("temp"), `hand-tracker-mcap-${process.pid}-${temps.length}.${v.ext === "mp4" ? "mp4" : "webm"}`);
          fs.writeFileSync(file, v.data);
          temps.push(file);
          list.push({ path: file, name: String(v.name || "camera"), startMs: v.startMs });
        }
      }
      return await mcapVideo.addVideos(String(mcap || ""), list);
    } finally {
      for (const f of temps) fs.rmSync(f, { force: true });
    }
  });
  handle("fleet:ble-password", () => fleet.blePassword());
  handle("fleet:set-ble-password", (event, { password }) => fleet.setBlePassword(password));
}

// ---------- annotating a take or a video (annotate.js; the Recording Converter's Annotate) ----------
// A take (its JSON) or a video opened there: the take and its cameras' videos beside it
// (<take>.json and <take>-video-<camera>.mp4), Claude's look at the main one (the user's own API
// key, kept encrypted), and the annotations saved beside them.
const VIDEO_EXT = /\.(mp4|webm|mkv|mov|m4v|avi)$/i;
function annotateFiles(file) {
  const f = String(file || "");
  if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) throw new Error("That file isn't there any more.");
  const dir = path.dirname(f), name = path.basename(f);
  const m = name.match(/^(.*)-video-([a-z0-9-]+)\.[^.]+$/i);
  const base = /\.json$/i.test(name) ? name.replace(/\.json$/i, "") : m ? m[1] : null;
  if (!base) return { takePath: "", takeName: "", videos: [{ camera: "", path: f }] };
  const takePath = path.join(dir, `${base}.json`);
  const videos = fs.readdirSync(dir)
    .map((n) => n.match(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-video-([a-z0-9-]+)\\.[^.]+$`, "i")) && VIDEO_EXT.test(n) ? { camera: n.slice(base.length + 7).replace(/\.[^.]+$/, ""), path: path.join(dir, n) } : null)
    .filter(Boolean);
  if (!videos.length && VIDEO_EXT.test(name)) videos.push({ camera: m ? m[2] : "", path: f });
  return { takePath: fs.existsSync(takePath) ? takePath : "", takeName: base, videos };
}
function registerAnnotateIpc() {
  const annotator = new Annotator(app.getPath("userData"), safeStorage);
  handle("annotate:status", () => ({ hasKey: annotator.hasKey(), model: annotateModel, dollarsPerMinute: annotateDollarsPerMinute }));
  handle("annotate:set-key", (event, { key } = {}) => annotator.setKey(key));
  handle("annotate:find", (event, { path: file } = {}) => annotateFiles(file));
  handle("annotate:estimate", (event, { path: file } = {}) => annotator.estimate(annotateFiles(file)));
  handle("annotate:run", async (event, { path: file, task, primary } = {}) => {
    const found = annotateFiles(file);
    let take = null;
    if (found.takePath) {
      try {
        take = JSON.parse(fs.readFileSync(found.takePath, "utf8"));
      } catch {
        take = null; // (not Hand Tracker's JSON: the hands then come from Claude's look)
      }
    }
    const job = { ...found, take, task: String(task || (take && take.metadata && take.metadata.task) || "").slice(0, 300), primary: String(primary || "") };
    return annotator.run(job, (p) => !event.sender.isDestroyed() && event.sender.send("annotate:progress", p));
  });
  // A capture session's (Capture Sessions, ops.js): its cameras' videos streamed from the dashboard's
  // storage (signed afresh for each look), the hands as just tracked (track: annotate-core's
  // handTrack of the main camera's), and the annotations saved into the folder chosen for its
  // tracking (token), as <name>.annotations.json, with where its videos are for the review.
  handle("annotate:run-session", async (event, { sessionId, streams, primary, track, task, name, token } = {}) => {
    if (!ops || !ops.status().signedIn) throw new Error("Sign in to the capture dashboard first.");
    const dir = outputFolders.get(String(token || ""));
    if (!dir) throw new Error("Choose the folder again.");
    const list = (Array.isArray(streams) ? streams : []).filter((x) => x && typeof x.path === "string" && typeof x.camera === "string").slice(0, 8);
    const videos = list.map((x) => ({ camera: x.camera, name: x.camera, url: async () => (await ops.sign(String(sessionId), [ops.videoPath(String(sessionId), x.path)]))[ops.videoPath(String(sessionId), x.path)] }));
    const job = { videos, primary: String(primary || ""), track: track && Array.isArray(track.visible) ? track : null, task: String(task || "").slice(0, 300), takeName: String(name || "") };
    const a = await annotator.run(job, (p) => !event.sender.isDestroyed() && event.sender.send("annotate:progress", p));
    a.source.session = { id: String(sessionId), streams: list };
    const file = path.join(dir, `${exporter.sanitizeBaseName(String(name || "session"))}.annotations.json`);
    fs.writeFileSync(file, JSON.stringify(a, null, 2));
    return { file, useful: a.useful, steps: a.segments.length, quality: a.quality.cameras.map((c) => ({ camera: c.camera, verdict: c.verdict })) };
  });
  handle("annotate:cancel", () => annotator.cancel());
  handle("annotate:save", (event, { annotations, path: file } = {}) => {
    if (!annotations || annotations.format !== "hand-tracker-annotations" || !Array.isArray(annotations.segments)) throw new Error("Those aren't annotations.");
    return Annotator.save(annotations, file);
  });
  handle("annotate:load", (event, { path: file } = {}) => Annotator.load(file));
  // The segments as a table, beside the take (<take>.annotations.csv).
  handle("annotate:save-csv", (event, { csv, path: file } = {}) => Annotator.saveCsv(String(csv || ""), file));
  // One of a take's videos, to play in the page as it is (no copy made).
  handle("annotate:media", (event, { path: file } = {}) => {
    const f = String(file || "");
    if (!VIDEO_EXT.test(f) || !fs.existsSync(f) || !fs.statSync(f).isFile()) throw new Error("That video isn't there.");
    const ext = path.extname(f).slice(1).toLowerCase();
    const id = `original-${Date.now()}-${mediaFiles.size}.${ext}`;
    mediaFiles.set(id, { file: f, owner: event.sender.id, original: true, type: ext === "webm" ? "video/webm" : ext === "mkv" ? "video/x-matroska" : ext === "mov" ? "video/quicktime" : "video/mp4" });
    return { url: `${SCHEME}://${HOST}/__media/${id}` };
  });
}

function signInWithSite(parent) {
  const site = ops.status().site;
  if (!site) throw new Error("Connect to the dashboard first.");
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      parent: parent || undefined,
      width: 480,
      height: 720,
      title: "Sign in to your dashboard",
      autoHideMenuBar: true,
      webPreferences: { partition: "ops-sign-in", sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      if (!win.isDestroyed()) win.close();
      err ? reject(err) : resolve(value);
    };
    // Links away from the dashboard open in the real browser, not here.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    const timer = setInterval(async () => {
      if (win.isDestroyed()) return;
      try {
        const saved = await win.webContents.executeJavaScript(`(() => {
          const k = Object.keys(localStorage).find((x) => /^sb-.*-auth-token$/.test(x));
          if (!k) return null;
          const v = JSON.parse(localStorage.getItem(k));
          return v && v.access_token && v.refresh_token ? { access_token: v.access_token, refresh_token: v.refresh_token, expires_at: v.expires_at, user: { email: v.user && v.user.email } } : null;
        })()`);
        if (saved) {
          const status = ops.adoptSession(saved);
          // Sign that window's own copy out of this browser profile; the app keeps its own.
          await win.webContents.session.clearStorageData().catch(() => {});
          finish(null, status);
        }
      } catch {
        // the page is still loading or navigating
      }
    }, 1000);
    win.on("closed", () => finish(new Error("Sign-in window closed before signing in.")));
    win.loadURL(`${site}/`); // the dashboard shows its sign-in page when signed out
  });
}

function registerShortcuts() {
  try {
    globalShortcut.register(SHORTCUTS.mouse, () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("pc:toggle-mouse");
    });
    globalShortcut.register(SHORTCUTS.keyboard, () => {
      if (keyboardWindow && !keyboardWindow.isDestroyed()) closeKeyboard();
      else openKeyboard();
    });
  } catch (err) {
    console.warn(`Couldn't register the ${APP.name} shortcuts:`, err.message);
  }
}

function registerIpc() {
  // When this copy was built (stamped into package.json by scripts/dist.js); null when
  // running from the source folder.
  function buildTime() {
    try {
      return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).buildTime || null;
    } catch {
      return null;
    }
  }

  handle("app:info", async () => ({
    version: app.getVersion(),
    built: buildTime(),
    ffmpeg: await exporter.isAvailable(),
    motive: !!tak.motive(), // OptiTrack Motive installed: .tak files can be opened
    formats: exporter.FORMATS.map(({ id, label, detail, group, ext, suffix }) => ({ id, label, detail, group, ext, suffix })),
  }));

  // Asks for an output folder (remembered between exports).
  async function chooseFolder(event, title) {
    const settings = readSettings();
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: String(title || "Choose a folder"),
      buttonLabel: "Save Here",
      defaultPath: settings.lastMotionDir || app.getPath("documents"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (canceled || !filePaths || !filePaths[0]) return null;
    writeSettings({ lastMotionDir: filePaths[0] });
    return filePaths[0];
  }

  // Writes page-generated files as <base><suffix>.<ext> in dir, never overwriting.
  async function writeFiles(dir, baseName, files) {
    const base = exporter.sanitizeBaseName(baseName);
    const results = [];
    for (const file of Array.isArray(files) ? files : []) {
      const format = String(file.format);
      const ext = String(file.ext);
      if (!SAVE_EXTENSIONS.has(ext)) {
        results.push({ format, ok: false, error: "Unsupported file type" });
        continue;
      }
      const suffix = String(file.suffix || "").replace(/[^-\w]/g, "").slice(0, 24);
      const out = exporter.uniquePath(dir, base + suffix, ext);
      try {
        // (a clip written to disk as it was recorded, clip:open: moved into place)
        if (file.clipId != null) await clips.finish(file.clipId, out);
        else await fs.promises.writeFile(out, typeof file.data === "string" ? file.data : Buffer.from(file.data));
        // A camera's clip as recorded (mimeType given): a plain MP4 with AAC sound.
        if (ext === "mp4" && typeof file.mimeType === "string") await exporter.finishClip(out, file.mimeType);
        // Its labels recorded as a layer of their own (label-layers.js): made into its .mkv and labelled copy once
        // its take is saved too (labels:finish).
        if (typeof file.labels === "string") await labelLayers().claim(file.labels, out, base).catch(() => {});
        exportedPaths.add(out);
        results.push({ format, ok: true, path: out, size: (await fs.promises.stat(out)).size });
      } catch (err) {
        results.push({ format, ok: false, error: err.message });
      }
    }
    return results;
  }

  handle("files:save", async (event, { title, baseName, files }) => {
    const dir = await chooseFolder(event, title);
    if (!dir) return { canceled: true, results: [] };
    return { dir, results: await writeFiles(dir, baseName, files) };
  });

  // A camera's clip (remote recording's videos, Sentry's) written to disk a second at a time as it's
  // recorded, rather than kept in the window's memory until it ends (2026-11-14: Sentry's clips on pi were
  // 340-480 MB, each held whole in the window, then copied twice more to be saved: the window was killed for
  // memory at about 1 GB). Into the remote recording folder as .recording-<n>.<ext>.part; saved (files:save-remote's
  // clipId) by moving it into place; thrown away by discard. One left by a crash is kept as Recovered_….
  handle("clip:open", async (event, ext) => clips.open(String(ext)));
  handle("clip:write", async (event, id, data) => clips.write(id, data));
  handle("clip:discard", async (event, id) => clips.discard(id));
  // A clip's labels, sent as it records (label-layers.js): open -> id, write, close, discard; finish once the clip
  // and its take are saved (files:save-remote's labels: id), then made in the background (labels:done).
  // (only where this app's ffmpeg can draw them in: its libass; elsewhere clips keep them drawn in)
  const labelsPossible = async () => (await exporter.isAvailable()) && (await LabelLayers.drawable());
  handle("labels:available", async () => labelsPossible());
  handle("labels:open", async () => {
    if (!(await labelsPossible())) throw new Error("This app's ffmpeg can't draw labels, so they can't be a layer of their own.");
    return labelLayers().open();
  });
  handle("labels:write", async (event, id, lines) => labelLayers().write(id, lines && typeof lines === "object" ? lines : {}));
  handle("labels:close", async (event, id, info) => labelLayers().close(id, info && typeof info === "object" ? info : {}));
  handle("labels:discard", async (event, id) => labelLayers().discard(id));
  handle("labels:finish", async (event, job = {}) =>
    labelLayers().finish({ paths: Array.isArray(job.paths) ? job.paths.map(String).slice(0, 50) : [], json: typeof job.json === "string" ? job.json : null }));

  // Remote recording's takes: saved without asking, into its folder (nobody may be at this screen).
  handle("files:save-remote", async (event, { baseName, files }) => {
    const dir = remoteFolder();
    await fs.promises.mkdir(dir, { recursive: true });
    return { dir, results: await writeFiles(dir, baseName, files) };
  });
  // Sentry mode's photos and videos deleted from the remote recording folder: the ones named,
  // or every one there ({ all: true }). Only Sentry's own files (sentry.js names them).
  // (baby: the baby monitor's instead, baby-monitor.js: its sound clips and videos)
  handle("files:delete-sentry", async (event, { names, all, baby } = {}) => {
    // (a clip's .mkv and labelled copy too: <name>.mkv, <name> (labels).mp4, electron/label-layers.js)
    const SENTRY_FILE = baby === true
      ? /^Baby_[A-Za-z0-9-]{1,80}_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d-(sound|video)( \(\d{1,4}\))?( \(labels\))?\.(wav|webm|mp4|mkv)$/
      : /^Sentry_[A-Za-z0-9-]{1,80}_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d(-video)?( \(\d{1,4}\))?( \(labels\))?\.(jpg|webm|mp4|mkv)$/;
    const dir = remoteFolder();
    const list = all === true ? (await fs.promises.readdir(dir).catch(() => [])).filter((n) => SENTRY_FILE.test(n)) : Array.isArray(names) ? names.filter((n) => typeof n === "string" && SENTRY_FILE.test(n)).slice(0, 200) : [];
    let deleted = 0;
    const failed = [];
    for (const name of list) {
      try {
        await fs.promises.unlink(path.join(dir, name));
        deleted++;
      } catch (err) {
        if (err.code !== "ENOENT") failed.push(`${name}: ${err.message}`);
      }
    }
    return { deleted, failed };
  });
  // Sentry mode's alerts through ntfy (checked in electron/ntfy.js first).
  handle("sentry:ntfy", async (event, req) => {
    const { cleanNtfy, sendNtfy } = require("./ntfy");
    return sendNtfy(cleanNtfy(req));
  });
  // An alert to Home Assistant's webhook (the user, 2026-11-26: alert clips "Webhook"): its words as JSON, with a signed
  // link to each of its files (remote-record.js's haLink: that file only, by this computer's address Home Assistant
  // reaches it at). { url, payload, files: { photo, video, sound } } -> { ok, status }
  handle("ha:webhook", async (event, job = {}) => {
    const url = String(job.url || "").trim();
    if (url.length > 400 || !/^https?:\/\/[^\s/?#]+\/api\/webhook\/[A-Za-z0-9_-]{1,200}$/i.test(url)) throw new Error("That isn't a Home Assistant webhook's address (http://…/api/webhook/…).");
    const p = job.payload && typeof job.payload === "object" ? job.payload : {};
    const text = (v, n = 200) => (typeof v === "string" ? v.slice(0, n) : typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const body = {
      source: "hand_tracker",
      ...Object.fromEntries(["kind", "event", "id", "at", "camera", "animal", "sound", "host", "seconds"].map((k) => [k, text(p[k])]).filter(([, v]) => v !== undefined)),
    };
    const files = job.files && typeof job.files === "object" ? job.files : {};
    for (const k of ["photo", "video", "sound"]) {
      const name = typeof files[k] === "string" ? files[k] : "";
      if (name && remoteRecord) {
        body[`${k}_url`] = remoteRecord.haLink(name);
        body[`${k}_file`] = name;
      }
    }
    const res = await net.fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return { ok: res.ok, status: res.status };
  });
  // Sentry's models (electron/sentry-models.js: "finder" or "second"): its bytes, downloaded the first time.
  handle("sentry:model", async (event, which) => {
    const { sentryModel } = require("./sentry-models");
    if (which !== "finder" && which !== "second") throw new Error("Which model?");
    return new Uint8Array(await sentryModel(app.getPath("userData"), (url) => net.fetch(url), which));
  });
  handle("remote:choose-folder", async (event) => {
    const dir = await chooseFolder(event, "Choose a folder for remote recordings");
    if (dir) writeSettings({ remoteDir: dir });
    return remoteFolder();
  });

  // For saving many results into one folder: pick it once, then save into it by token.
  handle("files:choose-folder", async (event, { title }) => {
    const dir = await chooseFolder(event, title);
    if (!dir) return { canceled: true };
    const token = require("crypto").randomBytes(12).toString("hex");
    outputFolders.set(token, dir);
    return { token, dir };
  });
  handle("files:save-to", async (event, { token, baseName, files }) => {
    const dir = outputFolders.get(String(token));
    if (!dir) throw new Error("Choose the folder again.");
    return { dir, results: await writeFiles(dir, baseName, files) };
  });

  // OptiTrack takes: open for viewing (markers as C3D) and export with Motive's exporters,
  // plus any files the page generated itself (extraFiles), into one chosen folder.
  handle("tak:open", async (event, { path: takePath }) => {
    const { info, c3d } = await tak.openTake(String(takePath));
    return { info, c3d: new Uint8Array(c3d) };
  });

  handle("tak:export", async (event, { path: takePath, formats, baseName, title, extraFiles }) => {
    const dir = await chooseFolder(event, title);
    if (!dir) return { canceled: true, results: [] };
    const motiveResults = await tak.exportTake(String(takePath), Array.isArray(formats) ? formats.map(String) : [], dir, baseName);
    for (const r of motiveResults) if (r.ok) exportedPaths.add(r.path);
    return { dir, results: [...motiveResults, ...(await writeFiles(dir, baseName, extraFiles))] };
  });

  handle("video:export", async (event, job) => {
    const settings = readSettings();
    const win = BrowserWindow.fromWebContents(event.sender);
    // A folder already picked with chooseFolder (several things saved together), or ask.
    let dir = job.token ? outputFolders.get(String(job.token)) : null;
    if (job.token && !dir) throw new Error("Choose the folder again.");
    if (!dir) {
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: "Choose a folder for the exported video",
        buttonLabel: "Export Here",
        defaultPath: settings.lastExportDir || app.getPath("videos"),
        properties: ["openDirectory", "createDirectory"],
      });
      if (canceled || !filePaths || !filePaths[0]) return { canceled: true, results: [] };
      dir = filePaths[0];
    }
    writeSettings({ lastExportDir: dir });

    // The Record card's labels as a layer of their own (2026-11-26; label-layers.js): job.labels { width, height,
    // hands, objects } (subtitle lines, the clip's time): each format gets them drawn in, as <name> (labels)…, and
    // <name>.mkv is the clean picture with them as tracks.
    let bundle = null;
    const lab = job.labels && typeof job.labels === "object" ? job.labels : null;
    if (lab && (await exporter.isAvailable()) && (await LabelLayers.drawable())) {
      const lines = (v) => (Array.isArray(v) ? v.filter((l) => typeof l === "string" && l.startsWith("Dialogue: ")).slice(0, 2e6) : []);
      const width = Math.max(2, Math.min(8192, Math.round(Number(lab.width) || 0))), height = Math.max(2, Math.min(8192, Math.round(Number(lab.height) || 0)));
      bundle = await labelLayers().bundle({ hands: lines(lab.hands), objects: lines(lab.objects) }, { width, height });
      bundle.args = LabelLayers.trackArgs(bundle, 1);
      bundle.filter = LabelLayers.assFilter(bundle);
    }
    try {
      const result = await exporter.exportVideo(
        {
          data: Buffer.from(job.bytes),
          container: job.container,
          formats: Array.isArray(job.formats) ? job.formats.map(String) : [],
          dir,
          baseName: job.baseName,
          duration: Number(job.duration) || 0,
          fps: Number(job.fps) || 30,
          retimeFps: Number(job.retimeFps) > 0 ? Number(job.retimeFps) : 0,
          layers: bundle,
        },
        (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send("video:export-progress", progress);
        }
      );
      for (const r of result.results) if (r.ok) exportedPaths.add(r.path);
      // (its steps, once Annotate gives it some, made into it too)
      if (bundle) labelLayers().watch(dir);
      return { dir, ...result };
    } finally {
      if (bundle) bundle.done();
    }
  });

  handle("video:cancel-export", () => exporter.cancel());

  // Screens and windows that can be used as the tracking source (e.g. Motive's camera
  // view, since Motive keeps the OptiTrack cameras to itself). This window is left out.
  handle("capture:sources", async (event) => {
    const own = BrowserWindow.fromWebContents(event.sender);
    const ownId = own ? own.getMediaSourceId() : "";
    const sources = await desktopCapturer.getSources({ types: ["window", "screen"], thumbnailSize: { width: 320, height: 200 } });
    return sources
      .filter((s) => s.id !== ownId && !s.thumbnail.isEmpty())
      .map((s) => ({ id: s.id, name: s.name, screen: s.id.startsWith("screen:"), thumbnail: s.thumbnail.toDataURL() }));
  });

  // OptiTrack Motive's NatNet stream.
  handle("natnet:start", (event, opts = {}) => {
    natnet.windows.add(event.sender);
    event.sender.once("destroyed", () => natnet.windows.delete(event.sender));
    const server = String(opts.server || "127.0.0.1").trim();
    if (!/^[\w.-]+$/.test(server)) throw new Error("That isn't a valid address for Motive's PC.");
    natnetClient().start({ server, multicast: opts.multicast !== false });
    return true;
  });
  handle("natnet:stop", () => {
    if (natnet.client) natnet.client.stop();
    natnet.latest = null;
    return true;
  });
  handle("natnet:record-start", () => {
    natnet.recording = [];
    return true;
  });
  handle("natnet:record-stop", () => {
    const frames = natnet.recording || [];
    natnet.recording = null;
    return frames;
  });

  // A video file on disk (Recording Converter): what's in it, and converting it to other formats.
  function videoFileArg(value) {
    const input = String(value || "");
    if (!input || !fs.existsSync(input) || !fs.statSync(input).isFile()) throw new Error("That video file can't be found.");
    return input;
  }
  handle("video:probe", (_event, { path: inputPath }) => exporter.probe(videoFileArg(inputPath)));

  // A take's camera videos, beside its JSON (the Recording Converter's Grid video): those its JSON lists, each
  // with when it started on the take's clock (remote recording's takes, since 2026-11-24), else the videos named
  // after it (<take>-video-<role>.mp4 or .webm: taken as started with it).
  // -> { ok, name, videos: [{ file, camera, role, start, hasAudio }], length (s), timed } or { ok: false, message }
  async function takeVideos(jsonPath) {
    const file = String(jsonPath || "");
    if (!/\.json$/i.test(file) || !fs.existsSync(file)) return { ok: false, message: "Open the take's JSON file: its videos are beside it." };
    let data = null;
    try {
      data = JSON.parse(await fs.promises.readFile(file, "utf8"));
    } catch {
      return { ok: false, message: "That take's JSON can't be read." };
    }
    const dir = path.dirname(file);
    const name = path.basename(file).replace(/\.json$/i, "");
    let names = [];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return { ok: false, message: "The take's folder can't be read." };
    }
    const here = new Set(names);
    const timed = !!data && Array.isArray(data.videos) && data.videos.length > 0;
    let list;
    if (timed) {
      list = data.videos
        .filter((v) => v && typeof v.file === "string" && path.basename(v.file) === v.file && here.has(v.file) && /\.(mp4|webm|mkv|mov)$/i.test(v.file))
        .map((v) => ({ file: v.file, camera: String(v.camera || "").slice(0, 60), role: typeof v.role === "string" ? v.role : "", start: Number.isFinite(Number(v.start_s)) ? Number(v.start_s) : 0 }));
    } else {
      // (its clips' .mkv, with their labels as tracks, too; never a labelled copy: <name> (labels).mp4)
      const own = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-video-([a-z0-9-]+)\\.(mp4|webm|mkv)$`, "i");
      list = names
        .map((n) => [n, own.exec(n)])
        .filter(([, m]) => m && m[1].toLowerCase() !== "grid")
        .map(([n, m]) => ({ file: n, camera: m[1].replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()), role: "", start: 0 }));
    }
    const videos = [];
    for (const v of list) {
      try {
        videos.push({ ...v, hasAudio: !!(await exporter.probe(path.join(dir, v.file))).hasAudio });
      } catch {
        // (not a video ffmpeg can read: left out)
      }
    }
    const length = Number(data && data.metadata && data.metadata.length_s) || 0;
    // (its steps followed from now on: when Annotate's change, its videos get them: electron/label-layers.js)
    labelLayers().watch(dir);
    return { ok: true, name, videos, length, timed };
  }
  handle("video:take-videos", (_event, { path: jsonPath } = {}) => takeVideos(jsonPath));
  // The grid video: { path: the take's JSON, videos: [{ file, name, label: its label as a PNG }] in the grid's
  // order } -> made beside the take (exporter.js's gridVideo; progress as a conversion's), with its labels as a layer
  // of their own (2026-11-26): <take>-video-grid.mkv, the clean grid with the labels as tracks (Camera names, and
  // each camera's own tracks, moved into its block, and the take's Steps), and <take>-video-grid (labels).mp4 with
  // them drawn in. (job.layers false: one MP4 with the names drawn in, as before.)
  // -> { ok, path, size, layout, sound, labelled, labelledSize } or { ok: false, message }
  handle("video:grid", async (event, job = {}) => {
    const take = await takeVideos(job.path);
    if (!take.ok) return take;
    const byFile = new Map(take.videos.map((v) => [v.file, v]));
    const chosen = (Array.isArray(job.videos) ? job.videos : []).filter((a) => a && byFile.has(a.file)).slice(0, 6);
    if (chosen.length < 2) return { ok: false, message: "A grid needs two of the take's videos or more." };
    const dir = path.dirname(String(job.path));
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hand-tracker-grid-"));
    let bundle = null;
    try {
      const videos = [];
      for (const [i, a] of chosen.entries()) {
        const png = a.label instanceof Uint8Array ? Buffer.from(a.label) : null;
        let label = null;
        if (png && png.length < 1 << 20 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          label = path.join(tmp, `label-${i}.png`);
          await fs.promises.writeFile(label, png);
        }
        videos.push({ path: path.join(dir, a.file), start: byFile.get(a.file).start, label });
      }
      const progress = (p) => {
        if (!event.sender.isDestroyed()) event.sender.send("video:export-progress", { format: "grid", index: 0, total: 1, progress: p });
      };
      // (as before where this app's ffmpeg can't draw labels: the names drawn in, one MP4)
      if (job.layers === false || !(await LabelLayers.drawable())) {
        const out = exporter.uniquePath(dir, `${take.name}-video-grid`, "mp4");
        const r = await exporter.gridVideo({ videos, length: take.length, out }, progress);
        exportedPaths.add(r.path);
        return { ok: true, ...r };
      }
      // The labels: each camera's own tracks (a clip recorded with them as a layer: its .mkv) moved into its
      // block, on the take's clock; each camera's name in its block's corner; the take's steps.
      const infos = [];
      for (const v of videos) infos.push(await exporter.probe(v.path));
      const length = Number(take.length) > 0 ? Number(take.length) : Math.max(...videos.map((v, i) => (Number(v.start) || 0) + (infos[i].duration || 0)));
      const places = exporter.gridPlaces(videos.length, infos);
      const tracks = { hands: [], objects: [], names: [], steps: [] };
      const names = [];
      for (const [i, a] of chosen.entries()) {
        const at = places[i], start = Number(videos[i].start) || 0;
        names.push({ x: at.x0 + 28, y: at.y0 + 28, text: String(a.name || byFile.get(a.file).camera || "Camera").slice(0, 40) });
        if (!/\.mkv$/i.test(a.file)) continue;
        const own = await labelLayers().trackLines(videos[i].path);
        const scale = at.k * (infos[i].width && own.width ? infos[i].width / own.width : 1);
        const into = { scale, dx: at.x, dy: at.y, shift: start, length, clip: [at.x0, at.y0, at.x0 + at.w, at.y0 + at.h] };
        for (const k of ["hands", "objects"]) if (own.tracks[k]) tracks[k].push(...LabelAss.move(own.tracks[k], into));
      }
      tracks.hands = LabelAss.merge(tracks.hands);
      tracks.objects = LabelAss.merge(tracks.objects);
      tracks.names = LabelAss.nameLines(names, { length });
      tracks.steps = await labelLayers().stepsFor(dir, `${take.name}-video-grid.mkv`, { grid: true, length, height: 1080 });
      bundle = await labelLayers().bundle(tracks, { width: 1920, height: 1080 });
      bundle.args = LabelLayers.trackArgs(bundle, videos.length);
      bundle.filter = LabelLayers.assFilter(bundle);
      const out = exporter.uniquePath(dir, `${take.name}-video-grid`, "mkv");
      const labelled = exporter.uniquePath(dir, `${take.name}-video-grid${LabelLayers.LABELLED}`, "mp4");
      const r = await exporter.gridVideo({ videos, length, out, layers: bundle, labelled }, progress);
      exportedPaths.add(r.path);
      exportedPaths.add(r.labelled);
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, message: err.canceled ? "Canceled." : `The grid video couldn't be made: ${err.message}` };
    } finally {
      fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
      if (bundle) bundle.done();
    }
  });
  // job.token: a folder already chosen (files:choose-folder), for converting a queue of videos
  // into one; job.trim: { start, length } seconds, for synced videos.
  handle("video:convert-file", async (event, job) => {
    const inputPath = videoFileArg(job.path);
    const trim = job.trim && Number.isFinite(Number(job.trim.start)) && Number(job.trim.length) > 0
      ? { start: Math.max(0, Number(job.trim.start)), length: Number(job.trim.length) }
      : null;
    let dir = job.token ? outputFolders.get(String(job.token)) : null;
    if (job.token && !dir) throw new Error("Choose the folder again.");
    if (!dir) {
      const settings = readSettings();
      const win = BrowserWindow.fromWebContents(event.sender);
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: "Choose a folder for the converted video",
        buttonLabel: "Export Here",
        defaultPath: settings.lastExportDir || app.getPath("videos"),
        properties: ["openDirectory", "createDirectory"],
      });
      if (canceled || !filePaths || !filePaths[0]) return { canceled: true, results: [] };
      dir = filePaths[0];
      writeSettings({ lastExportDir: dir });
    }
    const result = await exporter.convertFile(
      { inputPath, formats: Array.isArray(job.formats) ? job.formats.map(String) : [], dir, baseName: job.baseName, trim },
      (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send("video:export-progress", progress);
      }
    );
    for (const r of result.results) if (r.ok) exportedPaths.add(r.path);
    return { dir, ...result };
  });

  // Imported videos the page can't play (AVI, MPEG, WMV, FLV…): convert to MP4 with
  // ffmpeg and hand back an app:// address to play it from. One at a time.
  handle("video:import", async (event, { path: inputPath }) => {
    const input = String(inputPath || "");
    if (!input || !fs.existsSync(input) || !fs.statSync(input).isFile()) throw new Error("That video file can't be found.");
    if (!mediaDir) mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "hand-tracker-media-"));
    // Each window keeps only its latest copy (the viewer's preview mustn't delete the video the main window tracks).
    const owner = event.sender.id;
    for (const [id, media] of mediaFiles) {
      if (media.owner !== owner || media.original) continue;
      fs.rm(media.file, { force: true }, () => {});
      mediaFiles.delete(id);
    }
    const out = await exporter.convertForPlayback(input, mediaDir, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send("video:import-progress", { progress });
    });
    const id = `${Date.now()}.mp4`;
    mediaFiles.set(id, { file: out, owner });
    return { url: `${SCHEME}://${HOST}/__media/${id}` };
  });

  handle("shell:show-item", (event, filePath) => {
    if (exportedPaths.has(filePath)) shell.showItemInFolder(filePath);
  });
}

// ---------- Cluster Call (its own app): calls between your own devices over Tailscale (cluster-call-page.js) ----------
// Its service (electron/cluster-call.js) passes each call's signals to the page; a call coming in brings the window
// up, with a notification. With "Ring when closed" (on unless turned off) the app stays open in the background when
// its window is closed, and opens at login with its window hidden, so a call rings any time.
// HT_CLUSTER_CALL_SIM (the checks): several devices on this computer, [{ name, port }], each page saying which it is.
let clusterCall = null;
if (APP.kind === "clustercall") {
  const { Notification, Tray } = require("electron");
  const { createClusterCall, createRig } = require("./cluster-call");
  let sim = null;
  try {
    sim = process.env.HT_CLUSTER_CALL_SIM ? JSON.parse(process.env.HT_CLUSTER_CALL_SIM) : null;
  } catch {}
  const file = () => path.join(app.getPath("userData"), "cluster-call.json");
  const saved = () => {
    try {
      return JSON.parse(fs.readFileSync(file(), "utf8")) || {};
    } catch {
      return {};
    }
  };
  const save = (s) => fs.writeFileSync(file(), JSON.stringify(s, null, 1));
  const pages = new Map(), waiting = new Map();
  const deliver = (i, signal) => {
    const wc = pages.get(i);
    if (wc && !wc.isDestroyed()) wc.send("call:signal", signal);
    else waiting.set(i, [...(waiting.get(i) || []), signal].slice(-20));
  };
  const comeUp = (i, signal) => {
    if (i !== 0 || !["offer", "join"].includes(signal.kind) || !mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    if (!sim && Notification.isSupported()) new Notification({ title: `${signal.from.name} is calling`, body: APP.name, silent: true }).show();
  };
  // (when simulated, an "external" device is one running elsewhere, a phone's service say: a peer, not served here)
  const devices = sim ? sim.filter((d) => !d.external) : [{ name: "" }];
  const services = devices.map((d, i) =>
    createClusterCall({
      name: d.name || "",
      version: app.getVersion(),
      sim: sim ? { name: d.name, port: d.port, peers: sim.filter((p) => p !== d).map((p) => ({ name: p.name, address: `127.0.0.1:${p.port}` })) } : null,
      onSignal: (signal) => {
        comeUp(i, signal);
        deliver(i, signal);
        return { ok: true };
      },
    }));
  const index = (i) => (sim ? Math.max(0, Math.min(services.length - 1, Number(i) || 0)) : 0);
  // Each device's Hand Tracker, for its cameras (when simulated: HT_CLUSTER_CALL_RIG, a stand-in, for the second device).
  const rigs = services.map((s, i) =>
    createRig({
      base: async () => {
        if (sim) return i === 1 && process.env.HT_CLUSTER_CALL_RIG ? `http://${process.env.HT_CLUSTER_CALL_RIG}` : null;
        const m = await s.me();
        const ip = m && (m.ips || []).find((a) => !a.includes(":"));
        return ip ? `http://${ip}:47821` : null;
      },
    }));
  let started = null, startError = "";
  clusterCall = {
    quitting: false,
    tray: null,
    start: () =>
      started ||
      (started = Promise.all(services.map((s) => s.start())).catch((e) => {
        startError = e.code === "EADDRINUSE" ? `Something else on this computer already uses port ${services[0].port()}, so calls can't come in.` : e.message;
      })),
    ringWhenClosed: () => saved().ringWhenClosed !== false,
    lookAround: () => {
      if (!sim) services[0].devices().catch(() => {});
    },
    settings() {
      return { ringWhenClosed: this.ringWhenClosed(), atLogin: autostart.available() ? autostart.get() : null };
    },
    // (The first time: opened at login too, so it rings after a restart; turned off with Ring when closed.)
    firstRun() {
      const s = saved();
      if (s.loginSet || sim) return;
      try {
        if (autostart.available()) autostart.set(true);
      } catch {}
      save({ ...s, loginSet: true });
    },
  };
  // Whether a page's window is in view (a page kept going in a hidden window still counts itself as visible): told to it
  // as that changes, so it opens a camera only while someone can see it.
  const shown = (win) => !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
  const watched = new WeakSet();
  const watch = (wc) => {
    const win = BrowserWindow.fromWebContents(wc);
    if (!win || watched.has(win)) return;
    watched.add(win);
    const tell = () => !wc.isDestroyed() && wc.send("call:shown", shown(win));
    for (const e of ["show", "hide", "minimize", "restore"]) win.on(e, tell);
  };
  handle("call:hello", async (event, i) => {
    const n = index(i);
    pages.set(n, event.sender);
    watch(event.sender);
    await clusterCall.start();
    const w = waiting.get(n) || [];
    waiting.delete(n);
    return { me: await services[n].me(), waiting: w, settings: clusterCall.settings(), error: startError, sim: !!sim, shown: shown(BrowserWindow.fromWebContents(event.sender)) };
  });
  handle("call:devices", (_e, i) => services[index(i)].devices());
  handle("call:rig", (_e, i, what) => {
    const rig = rigs[index(i)];
    const w = what && typeof what === "object" ? what : {};
    if (w.do === "list") return rig.list();
    if (w.do === "start") return rig.start();
    if (w.do === "frame") return rig.frame(Number(w.camera), Number(w.after));
    if (w.do === "stop") return rig.stop();
    return null;
  });
  handle("call:send", (_e, i, address, signal) => services[index(i)].send(String(address || ""), signal && typeof signal === "object" ? signal : {}));
  handle("call:settings", (_e, change) => {
    if (change && typeof change.ringWhenClosed === "boolean") {
      save({ ...saved(), ringWhenClosed: change.ringWhenClosed, loginSet: true });
      try {
        if (autostart.available()) autostart.set(change.ringWhenClosed);
      } catch (e) {
        return { ...clusterCall.settings(), error: e.message };
      }
    }
    return clusterCall.settings();
  });
}

// Cluster Call's window: closed, it goes on in the background (Ring when closed), in the tray where there is one.
function clusterCallWindow() {
  mainWindow.on("close", (e) => {
    if (!clusterCall.quitting && clusterCall.ringWhenClosed()) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  app.on("before-quit", () => (clusterCall.quitting = true));
  const open = () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  };
  try {
    const icon = nativeImage.createFromPath(path.join(APP_ROOT, "build", "icon.png"));
    clusterCall.tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }));
    clusterCall.tray.setToolTip("Cluster Call: ready for calls");
    clusterCall.tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open Cluster Call", click: open },
      { type: "separator" },
      { label: "Quit (no calls come in)", click: () => ((clusterCall.quitting = true), app.quit()) },
    ]));
    clusterCall.tray.on("click", open);
  } catch {
    // (no tray here: opening the app again shows its window)
  }
  clusterCall.firstRun();
  clusterCall.start();
  // (your phones told your device list now and then, even with the window closed: electron/cluster-call.js announce)
  setInterval(() => clusterCall.lookAround(), 5 * 60 * 1000).unref();
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show(); // (Cluster Call waiting for calls with its window closed)
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  serveAppFiles();
  restrictPermissions();
  bluetoothPicker();
  registerIpc();
  clips.recover().catch(() => {}); // (a clip left by a crash)
  // (clips saved but not yet made into their .mkv and labelled copy, the app closed meanwhile: made now)
  labelLayers().recover().catch(() => {});
  registerPcIpc();
  registerOakIpc();
  registerKinectIpc();
  registerPs4Ipc();
  registerOpsIpc();
  registerFleetIpc();
  registerAnnotateIpc();
  registerLinkIpc();
  registerRemoteIpc();
  buildMenu();
  // Remote Recording opened at login is the rig, waiting for the phone (its choices otherwise).
  mainWindow = createWindow(APP.kind === "remote" && remoteStandby ? "index.html?rig=1" : APP.page, APP.size, !(APP.kind === "clustercall" && remoteStandby));
  mainWindow.on("closed", () => {
    mainWindow = null;
    closeKeyboard(); // the keyboard types for the hand mouse, which lives in the main window
  });
  if (APP.kind === "clustercall") clusterCallWindow();
  if (APP.kind === "full" || APP.kind === "mouse") registerShortcuts(); // (the hand mouse's and its keyboard's)
});

// The app opened again as this one closes, with what it was opened with (--remote-standby). On
// Linux inside a systemd service of its own (started with systemd-run), a program it starts is
// stopped with it, so the new one is started as a service of its own a few seconds on; if that
// can't be done, and everywhere else, Electron starts it as this one goes.
let restartApp = () => ({ ok: false, message: "Not ready yet." });
function relaunchApp() {
  const execPath = process.env.APPIMAGE || process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const args = process.argv.slice(1);
  let started = false;
  if (process.platform === "linux") {
    try {
      const group = fs.readFileSync("/proc/self/cgroup", "utf8");
      // (a desktop's own app-….service lasts as long as anything in it does)
      if (/\.service\s*$/m.test(group) && !/\/app-[^/]*\.service\s*$/m.test(group)) {
        const skip = /^(INVOCATION_ID|JOURNAL_STREAM|SYSTEMD_EXEC_PID|NOTIFY_SOCKET|MANAGERPID|MEMORY_PRESSURE_\w+|LISTEN_\w+)$/;
        const env = Object.entries(process.env)
          .filter(([k, v]) => !skip.test(k) && typeof v === "string" && !/[\n\r]/.test(v))
          .map(([k, v]) => `--setenv=${k}=${v}`);
        const run = require("child_process").spawnSync("systemd-run", ["--user", "--collect", "--on-active=4", "--timer-property=AccuracySec=100ms", `--unit=${APP.slug}-restart-${Date.now()}`, ...env, execPath, ...args], { timeout: 8000 });
        started = run.status === 0;
      }
    } catch {
      started = false;
    }
  }
  if (!started) app.relaunch({ execPath, args });
  setTimeout(() => app.exit(0), 2500).unref(); // (a window that doesn't close: a page that died)
  app.quit();
}

app.on("window-all-closed", () => {
  exporter.cancel();
  app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  transmission.restore();
  input.stop();
  if (btHid) btHid.stop();
  if (oak) oak.stop();
  for (const id of [...oakStreams.keys()]) stopOakStream(id);
  for (const id of [...kinectStreams.keys()]) stopKinectStream(id);
  for (const id of [...ps4Streams.keys()]) stopPs4Stream(id);
  if (natnet.client) natnet.client.stop();
  if (phoneLink) phoneLink.stop();
  if (webLink) webLink.stop();
  if (rigBluetooth) rigBluetooth.stop();
  if (remoteRecord) remoteRecord.stop();
  imuIn.stop();
  if (mediaDir) fs.rmSync(mediaDir, { recursive: true, force: true });
});
