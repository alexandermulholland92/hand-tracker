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
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { promisify } = require("util");
const exporter = require("./exporter");
const tak = require("./tak");
const { InputDriver } = require("./input");
const { OakCamera } = require("./oak");
const { OpsClient } = require("./ops");
const { FleetClient } = require("./fleet");
const { PhoneLinkServer } = require("./phone-link");

const APP_ROOT = path.join(__dirname, "..");
const SCHEME = "app";
const HOST = "hand-tracker";
const PAGES = new Set(["index.html", "viewer.html"]);
// Keys that work even while the app is minimized: the hand mouse and the floating keyboard on/off.
const SHORTCUTS = { mouse: "CommandOrControl+Alt+M", keyboard: "CommandOrControl+Alt+K" };
const ALLOWED_PERMISSIONS = new Set(["media", "fullscreen", "clipboard-sanitized-write"]);
const SAVE_EXTENSIONS = new Set(["json", "csv", "bvh", "glb", "c3d", "trc", "npz"]); // motion capture exports
const readFile = promisify(fs.readFile); // callback fs is asar-aware in packaged builds

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// Windows treats a window that is fully covered by other windows as hidden and
// stops rendering it, which freezes the camera feed and stops tracking and
// recording. Keep working when covered (minimizing still pauses).
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
// On ARM boards (a Raspberry Pi), use the GPU even if Chromium's list doubts its driver:
// hand tracking runs on WebGL, and without the GPU it crawls.
if (process.platform === "linux" && process.arch === "arm64") app.commandLine.appendSwitch("ignore-gpu-blocklist");

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Only one instance: two copies would fight over the camera.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();

let mainWindow = null;
let keyboardWindow = null; // the floating keyboard
const input = new InputDriver(); // mouse and keyboard input to this computer (see input.js)
let oak = null; // Luxonis OAK cameras (see oak.js), created once the app is ready
let oakViewer = null; // the window receiving the OAK camera's frames
const oakStreams = new Map(); // several OAK cameras at once (multi-camera.js): id -> { cam, busy }
let ops = null; // capture-session dashboard (see ops.js), created once the app is ready
let fleet = null; // capture-fleet dashboard's live rig pictures (see fleet.js)
const outputFolders = new Map(); // token -> folder the user picked for batch saving
const exportedPaths = new Set(); // files this session wrote; the only ones "show in folder" will reveal
// Imported videos converted to MP4 for playback: id -> { file, owner: webContents id }. Only these are served under /__media/.
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
  const file = mediaFiles.has(id) && mediaFiles.get(id).file;
  if (!file) return new Response("Not found", { status: 404 });
  const size = (await fs.promises.stat(file)).size;
  const headers = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes" };
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
    if (url.pathname.startsWith("/__media/")) return serveMedia(request, url.pathname.slice("/__media/".length));
    if (url.pathname.startsWith("/__ops/") && ops) return ops.serve(request, url.pathname.slice("/__ops/".length));
    if (url.pathname.startsWith("/__fleet/") && fleet) {
      // /__fleet/<rig>/<camera>[?kind=keyframe|jpeg][&full=1]: that camera's latest picture.
      const [host, camera] = url.pathname.slice("/__fleet/".length).split("/");
      return fleet.serveFrame(decodeURIComponent(host || ""), decodeURIComponent(camera || ""), {
        kind: url.searchParams.get("kind") === "keyframe" ? "keyframe" : "jpeg",
        full: url.searchParams.get("full") === "1",
      });
    }
    let rel = decodeURIComponent(url.pathname);
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

function restrictPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl || wc.getURL()));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    return ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingOrigin || (wc ? wc.getURL() : ""));
  });
}

function createWindow(page = "index.html", size = { width: 1320, height: 940 }) {
  const iconPath = path.join(APP_ROOT, "build", "icon.png");
  const win = new BrowserWindow({
    ...size,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#0e0f12",
    title: "Hand Tracker",
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
      if (PAGES.has(target)) createWindow(target, { width: 920, height: 960 });
    } else if (/^https?:\/\//.test(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
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
          label: "Open Recording Viewer",
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
          label: "About Hand Tracker",
          click: async () => {
            const ffmpeg = (await exporter.isAvailable()) ? "available" : "not found";
            dialog.showMessageBox({
              type: "info",
              title: "About Hand Tracker",
              message: `Hand Tracker ${app.getVersion()}`,
              detail: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}\nffmpeg: ${ffmpeg}`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Every IPC call must come from one of our own pages.
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!event.senderFrame || !isAppUrl(event.senderFrame.url)) throw new Error("Blocked: untrusted sender");
    return fn(event, ...args);
  });
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
    title: "Hand Tracker keyboard",
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

// A point given as fractions of a screen ("primary", or "all" screens together) -> the
// physical pixels the input helper works in.
function screenPoint(nx, ny, which) {
  const displays = screen.getAllDisplays();
  let b = screen.getPrimaryDisplay().bounds;
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
  handle("pc:start", () => input.start());
  // Pointer moves come many times a second: fire-and-forget, from our own pages only.
  ipcMain.on("pc:pointer", (event, { nx, ny, screen: which } = {}) => {
    if (!event.senderFrame || !isAppUrl(event.senderFrame.url)) return;
    input
      .start()
      .then(() => {
        const p = screenPoint(nx, ny, which);
        input.move(p.x, p.y);
      })
      .catch(() => {});
  });
  handle("pc:button", async (event, { which, action }) => {
    await input.start();
    input.button(which, action);
  });
  handle("pc:wheel", async (event, { notches }) => {
    await input.start();
    input.wheel(notches);
  });
  handle("pc:key", async (event, { combo, action }) => {
    await input.start();
    input.key(combo, action);
  });
  handle("pc:text", async (event, { text }) => {
    await input.start();
    input.text(text);
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
  handle("oak:list", async () => {
    if (simulated) return [{ name: "sim.1", id: "SIMULATED-OAK-A", state: "X_LINK_UNBOOTED" }, { name: "sim.2", id: "SIMULATED-OAK-B", state: "X_LINK_UNBOOTED" }];
    const msg = await oak.runBridge(["--list"]).catch(() => null);
    return msg && msg.status === "devices" ? msg.devices : [];
  });
  handle("oak:stream-start", (event, { id, ...options } = {}) => {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(id || ""))) throw new Error("Which OAK camera?");
    stopOakStream(id);
    const viewer = event.sender;
    const stream = { cam: simulated ? new SimulatedOak() : new OakCamera(app.getPath("userData"), (url) => net.fetch(url)), busy: false };
    oakStreams.set(id, stream);
    stream.cam.start({ ...options, device: id }, (msg) => {
      if (oakStreams.get(id) !== stream && msg.status !== "stopped") return;
      if (viewer.isDestroyed()) return stopOakStream(id);
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

  start(options, onMessage) {
    // A camera whose id has FAILS-ONCE doesn't start the first time (for the checks' Try again).
    if (/FAILS-ONCE/.test(options.device || "") && !SimulatedOak.failedOnce.has(options.device)) {
      SimulatedOak.failedOnce.add(options.device);
      onMessage({ status: "error", message: "The simulated OAK camera didn't start this time." });
      return;
    }
    const w = 640, h = 360;
    const pixels = Buffer.alloc(w * h * 4, 60);
    const jpeg = nativeImage.createFromBitmap(pixels, { width: w, height: h }).toJPEG(70);
    const T = [[0, 0], [-0.04, -0.03], [-0.08, -0.07], [-0.11, -0.1], [-0.13, -0.13], [-0.035, -0.12], [-0.04, -0.17], [-0.043, -0.2], [-0.045, -0.23],
      [0, -0.125], [0, -0.18], [0, -0.215], [0, -0.245], [0.03, -0.115], [0.035, -0.165], [0.038, -0.195], [0.04, -0.22], [0.055, -0.1], [0.065, -0.135], [0.07, -0.16], [0.075, -0.18]];
    const t0 = Date.now();
    this.onMessage = onMessage;
    onMessage({ status: "running", camera: options.device ? `Simulated OAK ${options.device}` : "Simulated OAK", width: w, height: h, depth: true, id: options.device || "SIMULATED-OAK", usb: "SUPER" });
    this.timer = setInterval(() => {
      const t = (Date.now() - t0) / 1000;
      const cx = 0.5 + 0.2 * Math.sin(t), cy = 0.75;
      const hand = { lm: T.map(([x, y]) => [cx + x, cy + y, 0]), world: T.map(([x, y]) => [x * 0.75, y * 0.75, 0]), label: "Left", anatomical: false, score: 0.97, lm_score: 0.95, xyz: [120, -40, 850] };
      onMessage({ frame: { t: Math.round(t * 1000), w, h, fps: 30, hands: [hand] }, jpeg });
    }, 33);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.onMessage({ status: "stopped", code: 0, detail: "" });
  }
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
}

function registerFleetIpc() {
  fleet = new FleetClient(app.getPath("userData"), session.fromPartition("persist:capture-fleet"));
  handle("fleet:status", () => fleet.check());
  handle("fleet:configure", (event, { site }) => fleet.configure(site));
  handle("fleet:sign-in", (event) => fleet.signIn(BrowserWindow, BrowserWindow.fromWebContents(event.sender)));
  handle("fleet:sign-out", () => fleet.signOut());
  handle("fleet:rigs", () => fleet.rigs());
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
    console.warn("Couldn't register the Hand Tracker shortcuts:", err.message);
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
        await fs.promises.writeFile(out, typeof file.data === "string" ? file.data : Buffer.from(file.data));
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
      },
      (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send("video:export-progress", progress);
      }
    );
    for (const r of result.results) if (r.ok) exportedPaths.add(r.path);
    return { dir, ...result };
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

  // A video file on disk (Recording Viewer): what's in it, and converting it to other formats.
  function videoFileArg(value) {
    const input = String(value || "");
    if (!input || !fs.existsSync(input) || !fs.statSync(input).isFile()) throw new Error("That video file can't be found.");
    return input;
  }
  handle("video:probe", (_event, { path: inputPath }) => exporter.probe(videoFileArg(inputPath)));
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
      if (media.owner !== owner) continue;
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

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  serveAppFiles();
  restrictPermissions();
  registerIpc();
  registerPcIpc();
  registerOakIpc();
  registerOpsIpc();
  registerFleetIpc();
  registerLinkIpc();
  buildMenu();
  mainWindow = createWindow();
  mainWindow.on("closed", () => {
    mainWindow = null;
    closeKeyboard(); // the keyboard types for the hand mouse, which lives in the main window
  });
  registerShortcuts();
});

app.on("window-all-closed", () => {
  exporter.cancel();
  app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  input.stop();
  if (oak) oak.stop();
  for (const id of [...oakStreams.keys()]) stopOakStream(id);
  if (natnet.client) natnet.client.stop();
  if (phoneLink) phoneLink.stop();
  if (mediaDir) fs.rmSync(mediaDir, { recursive: true, force: true });
});
