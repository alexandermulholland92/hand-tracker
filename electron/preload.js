/**
 * preload.js — the only bridge between the page and the desktop app.
 * Exposes a small, explicit API as window.desktop; the page never gets Node access.
 */

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  // { version, built, ffmpeg: boolean, formats: [{ id, label, detail, group, ext, suffix }] }
  getInfo: () => ipcRenderer.invoke("app:info"),

  // Asks for a folder, then writes each file as <baseName><suffix>.<ext> (never overwriting).
  // job = { title, baseName, files: [{ format, suffix, ext, data: string | Uint8Array }] }
  // resolves { dir, results: [{ format, ok, path?, size?, error? }] } or { canceled: true }
  saveFiles: (job) => ipcRenderer.invoke("files:save", job),

  // Asks for an output folder, then converts the clip to each format.
  // job = { bytes: ArrayBuffer, container, formats: string[], baseName, duration, fps, retimeFps? }
  // resolves { dir, results: [{ format, ok, path?, size?, error? }], canceled }
  exportVideo: (job) => ipcRenderer.invoke("video:export", job),
  cancelExport: () => ipcRenderer.invoke("video:cancel-export"),

  // Any video file on disk (Recording Viewer): what's in it, and converting it.
  // probeVideo resolves { duration, fps, width, height, videoCodec, hasAudio }.
  // convertVideoFile(job = { path, formats, baseName }) asks for a folder, then works like
  // exportVideo (same progress events, same result).
  probeVideo: (videoPath) => ipcRenderer.invoke("video:probe", { path: videoPath }),
  convertVideoFile: (job) => ipcRenderer.invoke("video:convert-file", job),

  // cb({ format, index, total, progress 0..1 }); returns an unsubscribe function.
  onExportProgress: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on("video:export-progress", listener);
    return () => ipcRenderer.removeListener("video:export-progress", listener);
  },

  showInFolder: (filePath) => ipcRenderer.invoke("shell:show-item", filePath),

  // Imported videos the page can't play: converts to MP4 with ffmpeg and resolves
  // { url } to play it from. cb({ progress 0..1 }) while converting.
  importVideo: (videoPath) => ipcRenderer.invoke("video:import", { path: videoPath }),
  onImportProgress: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on("video:import-progress", listener);
    return () => ipcRenderer.removeListener("video:import-progress", listener);
  },

  // Screens and windows usable as the tracking source: [{ id, name, screen, thumbnail (data URL) }].
  // The page opens one with getUserMedia({ video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: id } } }).
  listCaptureSources: () => ipcRenderer.invoke("capture:sources"),

  // OptiTrack Motive's live NatNet stream: labelled markers, rigid bodies and skeletons,
  // in millimetres, Z-up. start({ server, multicast }) keeps trying until Motive answers.
  natnet: {
    start: (opts) => ipcRenderer.invoke("natnet:start", opts),
    stop: () => ipcRenderer.invoke("natnet:stop"),
    // While motion capture records: every frame, returned by recordStop().
    recordStart: () => ipcRenderer.invoke("natnet:record-start"),
    recordStop: () => ipcRenderer.invoke("natnet:record-stop"),
    // cb({ state: "waiting" | "connected" | "stopped", server, app, appVersion, version, error, warning })
    onStatus: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("natnet:status", listener);
      return () => ipcRenderer.removeListener("natnet:status", listener);
    },
    // cb({ t, markers: [{ id, model, p }], rigidBodies: [{ id, name, p, q, valid }], skeletons: [{ id, name, bones: [{ name, p, valid }] }] }), up to 30/s
    onFrame: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("natnet:frame", listener);
      return () => ipcRenderer.removeListener("natnet:frame", listener);
    },
  },

  // OptiTrack .tak takes, read through the Motive installed on this PC.
  // pathForFile(file) gives the on-disk path of a file the user picked or dropped.
  pathForFile: (file) => webUtils.getPathForFile(file),
  // resolves { info: { name, frameRate, frameCount, markers, rigidBodies, skeletons, motiveVersion }, c3d: Uint8Array }
  openTake: (takePath) => ipcRenderer.invoke("tak:open", { path: takePath }),
  // job = { path, formats (Motive's: c3d/trc/csv/fbx/bvh), baseName, title, extraFiles: [{ format, suffix, ext, data }] }
  exportTake: (job) => ipcRenderer.invoke("tak:export", job),

  // Luxonis OAK cameras (OAK-D, OAK-D Lite, OAK-1...): hand tracking on the camera itself.
  oak: {
    // { ready, python, models, reason, versions }
    status: () => ipcRenderer.invoke("oak:status"),
    // The one-time setup (about 150 MB); cb(line) with progress. Resolves the new status.
    setup: (cb) => {
      const listener = (_event, line) => cb(line);
      ipcRenderer.on("oak:setup-progress", listener);
      return ipcRenderer.invoke("oak:setup").finally(() => ipcRenderer.removeListener("oak:setup-progress", listener));
    },
    // options = { lm: "lite" | "full", twoHands, xyz, far: null | "both" | "higher" | "left" | "right", allHands }
    start: (options) => ipcRenderer.invoke("oak:start", options),
    stop: () => ipcRenderer.invoke("oak:stop"),
    // cb({ header: { t, w, h, fps, hands }, jpeg: Uint8Array }); call shown() once it's drawn.
    onFrame: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("oak:frame", listener);
      return () => ipcRenderer.removeListener("oak:frame", listener);
    },
    shown: () => ipcRenderer.send("oak:shown"),
    // cb({ status: "running" | "error" | "stopped", message, camera, width, height, depth })
    onStatus: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("oak:status", listener);
      return () => ipcRenderer.removeListener("oak:status", listener);
    },
  },

  // Controlling this computer: the hand mouse, the floating keyboard and gesture actions.
  pc: {
    // Starts sending input; resolves, or rejects with why it can't (e.g. xdotool missing).
    start: () => ipcRenderer.invoke("pc:start"),
    // The pointer to (nx, ny), fractions of the chosen screen ("primary" or "all" screens).
    pointer: (nx, ny, screen) => ipcRenderer.send("pc:pointer", { nx, ny, screen }),
    // which: "left" | "right" | "middle"; action: "down" | "up" | "click" | "double"
    button: (which, action) => ipcRenderer.invoke("pc:button", { which, action }),
    wheel: (notches) => ipcRenderer.invoke("pc:wheel", { notches }),
    // combo like "ctrl+shift+s" or "volumeup"; action: "tap" | "down" | "up"
    key: (combo, action) => ipcRenderer.invoke("pc:key", { combo, action }),
    text: (text) => ipcRenderer.invoke("pc:text", { text }),
    // A web request (http/https): resolves { ok, status } or rejects.
    web: (req) => ipcRenderer.invoke("pc:web", req),
    // The floating keyboard window: show or hide it.
    setKeyboard: (show) => ipcRenderer.invoke("pc:keyboard", { show }),
    // Hand mouse status, from the main window to the floating keyboard: { mouseOn, hand, dragging, note }
    status: (s) => ipcRenderer.send("pc:status", s),
    onStatus: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("pc:status", listener);
      return () => ipcRenderer.removeListener("pc:status", listener);
    },
    // Asks the main window to turn the hand mouse on/off (from the keyboard or Ctrl+Alt+M).
    toggleMouse: () => ipcRenderer.send("pc:toggle-mouse"),
    onToggleMouse: (cb) => {
      const listener = () => cb();
      ipcRenderer.on("pc:toggle-mouse", listener);
      return () => ipcRenderer.removeListener("pc:toggle-mouse", listener);
    },
    // cb(shown) whenever the floating keyboard opens or closes.
    onKeyboard: (cb) => {
      const listener = (_event, shown) => cb(shown);
      ipcRenderer.on("pc:keyboard-state", listener);
      return () => ipcRenderer.removeListener("pc:keyboard-state", listener);
    },
  },
});
