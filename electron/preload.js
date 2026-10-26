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
  // job = { bytes: ArrayBuffer, container, formats: string[], baseName, duration, fps, retimeFps?, token? }
  // (token: a folder from chooseFolder, instead of asking)
  // resolves { dir, results: [{ format, ok, path?, size?, error? }], canceled }
  exportVideo: (job) => ipcRenderer.invoke("video:export", job),
  cancelExport: () => ipcRenderer.invoke("video:cancel-export"),

  // Any video file on disk (Recording Viewer): what's in it, and converting it.
  // probeVideo resolves { duration, fps, width, height, videoCodec, hasAudio }.
  // convertVideoFile(job = { path, formats, baseName, token?, trim? }) asks for a folder (or
  // uses the one chooseFolder gave token for), then works like exportVideo (same progress
  // events, same result). trim: { start, length } seconds converts just that stretch.
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

  // Saving many results into one folder: pick it once ({ token, dir } or { canceled }),
  // then saveFilesTo(token, { baseName, files }) like saveFiles.
  chooseFolder: (title) => ipcRenderer.invoke("files:choose-folder", { title }),
  saveFilesTo: (token, job) => ipcRenderer.invoke("files:save-to", { token, ...job }),

  // Capture sessions from a capture-operations dashboard (see electron/ops.js).
  ops: {
    status: () => ipcRenderer.invoke("ops:status"),
    configure: (site) => ipcRenderer.invoke("ops:configure", { site }),
    sendCode: (email) => ipcRenderer.invoke("ops:send-code", { email }),
    verifyCode: (email, code) => ipcRenderer.invoke("ops:verify-code", { email, code }),
    signInWithPassword: (email, password) => ipcRenderer.invoke("ops:password", { email, password }),
    signOut: () => ipcRenderer.invoke("ops:sign-out"),
    // Opens the dashboard's own sign-in page; resolves the new status once signed in there.
    signInWithSite: () => ipcRenderer.invoke("ops:sign-in-with-site"),
    // [{ id, when, duration, review, program, device, operator, venue, task }]
    sessions: (query) => ipcRenderer.invoke("ops:sessions", query),
    // { sessionId, window, clock, streams: [{ position, stream, path, bytes, fps, frames, resolution, startNs, device }] }
    manifest: (sessionId) => ipcRenderer.invoke("ops:manifest", { sessionId }),
    // An app:// address the video element can play (and seek) directly.
    stream: (sessionId, path) => ipcRenderer.invoke("ops:stream", { sessionId, path }),
    forget: (url) => ipcRenderer.invoke("ops:forget", { url }),
  },
  // Live pictures from capture rigs on a capture-fleet dashboard (hidden; see fleet.js).
  // Each camera's latest picture is at app://hand-tracker/__fleet/<rig>/<camera>[?full=1].
  // A motion capture's MCAP file with the videos recorded with it (mcap-video.js): videos
  // [{ path | data (bytes) + ext, name, startMs }] -> { ok, frames, message }.
  mcap: {
    addVideos: (mcap, videos) => ipcRenderer.invoke("mcap:add-videos", { mcap, videos }),
  },
  fleet: {
    status: () => ipcRenderer.invoke("fleet:status"),
    configure: (site) => ipcRenderer.invoke("fleet:configure", { site }),
    signIn: () => ipcRenderer.invoke("fleet:sign-in"),
    signOut: () => ipcRenderer.invoke("fleet:sign-out"),
    rigs: () => ipcRenderer.invoke("fleet:rigs"),
    sessions: (host) => ipcRenderer.invoke("fleet:sessions", { host }),
    // The work rigs' Bluetooth password (rig-ble.js), kept encrypted: "" for none.
    blePassword: () => ipcRenderer.invoke("fleet:ble-password"),
    setBlePassword: (password) => ipcRenderer.invoke("fleet:set-ble-password", { password }),
  },

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
    // Several OAK cameras at once ("Several cameras"): [{ name, id, state }] of those plugged
    // in (with { detail: true }, { devices, silent }: silent, the USB ports of ones plugged in
    // that didn't answer), then a stream each by id, its frames and statuses tagged with that id.
    list: (opts) => ipcRenderer.invoke("oak:list", opts && opts.detail ? { detail: true } : undefined),
    streamStart: (id, options) => ipcRenderer.invoke("oak:stream-start", { ...options, id }),
    streamStop: (id) => ipcRenderer.invoke("oak:stream-stop", id || null),
    // cb({ id, header, jpeg }); call streamShown(id) once it's drawn.
    onStreamFrame: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("oak:stream-frame", listener);
      return () => ipcRenderer.removeListener("oak:stream-frame", listener);
    },
    streamShown: (id) => ipcRenderer.send("oak:stream-shown", id),
    // cb({ id, status, message, camera, depth, usb, ... })
    onStreamStatus: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("oak:stream-status", listener);
      return () => ipcRenderer.removeListener("oak:stream-status", listener);
    },
  },

  // Annotating a take or a video (electron/annotate.js; the Recording Viewer's Annotate): path is
  // the take's JSON or a video; its take and cameras' videos are found beside it.
  annotate: {
    status: () => ipcRenderer.invoke("annotate:status"), // { hasKey, model }
    setKey: (key) => ipcRenderer.invoke("annotate:set-key", { key }),
    find: (path) => ipcRenderer.invoke("annotate:find", { path }), // { takePath, takeName, videos: [{ camera, path }] }
    estimate: (path) => ipcRenderer.invoke("annotate:estimate", { path }), // { minutes, chunks, frames, dollars, model }
    run: (path, options) => ipcRenderer.invoke("annotate:run", { ...options, path }), // options: { task, primary } -> annotations
    cancel: () => ipcRenderer.invoke("annotate:cancel"),
    save: (annotations, path) => ipcRenderer.invoke("annotate:save", { annotations, path }),
    load: (path) => ipcRenderer.invoke("annotate:load", { path }), // { file, annotations } | null
    saveCsv: (csv, path) => ipcRenderer.invoke("annotate:save-csv", { csv, path }),
    // A capture session (Capture Sessions): { sessionId, streams: [{ camera, path }], primary, track, task,
    // name, token } -> { file, useful, steps, quality }, saved into the folder chosen for its tracking.
    runSession: (job) => ipcRenderer.invoke("annotate:run-session", job),
    media: (path) => ipcRenderer.invoke("annotate:media", { path }), // { url }: a take's video, to play in the page
    onProgress: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("annotate:progress", listener);
      return () => ipcRenderer.removeListener("annotate:progress", listener);
    },
  },
  // The Kinect for Xbox One (Linux and Windows app, electron/kinect.js): { ok, reason } here, the
  // ones plugged in [{ id, name }], then a stream each by id, as the OAK cameras' streams.
  kinect: {
    available: () => ipcRenderer.invoke("kinect:available"),
    list: () => ipcRenderer.invoke("kinect:list"),
    // options: { source: "color" | "infrared" | "auto", size: "960x540"…, mics, pipeline }
    streamStart: (id, options) => ipcRenderer.invoke("kinect:stream-start", { ...options, id }),
    streamStop: (id) => ipcRenderer.invoke("kinect:stream-stop", id || null),
    // A setting changed as it runs: "source infrared", "exposure auto 0.5", "led 200"…
    command: (id, line) => ipcRenderer.invoke("kinect:command", { id, line }),
    // cb({ id, header, jpeg, depth, body, audio }); call shown(id) once it's been dealt with.
    onFrame: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("kinect:frame", listener);
      return () => ipcRenderer.removeListener("kinect:frame", listener);
    },
    shown: (id) => ipcRenderer.send("kinect:shown", id),
    // cb({ id, status, message, camera, color, ir, mics, pipeline, ... })
    onStatus: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("kinect:status", listener);
      return () => ipcRenderer.removeListener("kinect:status", listener);
    },
    // A take's depth, infrared, colour and sound: recordStart(id, { depth, ir, color, sound }),
    // then recordStop(id, { baseName, role, keep }) -> { dir, files: [{ kind, path, startMs, times }], errors }.
    recordStart: (id, want) => ipcRenderer.invoke("kinect:record-start", { ...want, id }),
    recordEnd: (id) => ipcRenderer.invoke("kinect:record-end", id),
    recordStop: (id, opts) => ipcRenderer.invoke("kinect:record-stop", { ...opts, id }),
  },
  // The PlayStation 4 camera (Windows and Linux app, electron/ps4cam.js): { ok, reason } here, its
  // one-time setup and its firmware file, the ones plugged in [{ id, name, ready }], then a stream
  // each by id, as the Kinect's.
  ps4cam: {
    arch: process.arch, // (its picture size by default: smaller on an ARM board; the page's own navigator says x86 on every Linux)
    available: () => ipcRenderer.invoke("ps4cam:available"),
    status: () => ipcRenderer.invoke("ps4cam:status"), // { ready, firmware, reason }
    setup: (onLine) => {
      const listener = (_event, line) => onLine(line);
      ipcRenderer.on("ps4cam:setup-progress", listener);
      return ipcRenderer.invoke("ps4cam:setup").finally(() => ipcRenderer.removeListener("ps4cam:setup-progress", listener));
    },
    chooseFirmware: () => ipcRenderer.invoke("ps4cam:choose-firmware"), // { ok, size } | { ok: false, reason | canceled }
    list: () => ipcRenderer.invoke("ps4cam:list"),
    // options: { size: "1280x800" | "640x400", fps, view, depth, night }
    streamStart: (id, options) => ipcRenderer.invoke("ps4cam:stream-start", { ...options, id }),
    streamStop: (id) => ipcRenderer.invoke("ps4cam:stream-stop", id || null),
    // A setting changed as it runs: "view side", "depth on", "night auto"…
    command: (id, line) => ipcRenderer.invoke("ps4cam:command", { id, line }),
    // cb({ id, header, jpeg, shown, depth }); call shown(id) once it's been dealt with.
    onFrame: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("ps4cam:frame", listener);
      return () => ipcRenderer.removeListener("ps4cam:frame", listener);
    },
    shown: (id) => ipcRenderer.send("ps4cam:shown", id),
    onStatus: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("ps4cam:status", listener);
      return () => ipcRenderer.removeListener("ps4cam:status", listener);
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
    // What all this works: this computer, or an iPhone or iPad this computer is a Bluetooth
    // mouse and keyboard for (bt-hid.js): { target: "computer" | "device", screen, speed }
    // -> { target, state: "off" | "starting" | "waiting" | "connected" | "error", device, message }
    platform: process.platform,
    setTarget: (opts) => ipcRenderer.invoke("pc:target", opts),
    targetStatus: () => ipcRenderer.invoke("pc:target-status"),
    onTargetStatus: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("pc:target-status", listener);
      return () => ipcRenderer.removeListener("pc:target-status", listener);
    },
    // A Mac: opens iPhone Mirroring (its window can be the hand mouse's screen).
    openMirroring: () => ipcRenderer.invoke("pc:open-mirroring"),
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
    // A phone controlling this computer over Wi-Fi (phone-link.js): start() listens and
    // gives the pairing text for the QR code; status: { on, port, addresses, pairing, phone }.
    link: {
      status: () => ipcRenderer.invoke("link:status"),
      start: () => ipcRenderer.invoke("link:start"),
      stop: () => ipcRenderer.invoke("link:stop"),
      newKey: () => ipcRenderer.invoke("link:new-key"),
      onStatus: (cb) => {
        const listener = (_event, data) => cb(data);
        ipcRenderer.on("link:status", listener);
        return () => ipcRenderer.removeListener("link:status", listener);
      },
    },
    // cb(shown) whenever the floating keyboard opens or closes.
    onKeyboard: (cb) => {
      const listener = (_event, shown) => cb(shown);
      ipcRenderer.on("pc:keyboard-state", listener);
      return () => ipcRenderer.removeListener("pc:keyboard-state", listener);
    },
  },

  // Remote recording (remote-record.js): a phone's browser starts and stops motion capture
  // here. status: { on, port, addresses, urls: [{ kind, url, keyed }], viewer }.
  // Web Bluetooth's device (remote recording over Bluetooth, remote-client.js): the one named
  // (a computer's name), else one of those found, listed for the page to pick from.
  bluetooth: {
    prefer: (name) => ipcRenderer.send("bluetooth:prefer", String(name || "")),
    choose: (id) => ipcRenderer.send("bluetooth:choose", String(id || "")),
    onDevices: (cb) => {
      const listener = (_event, list) => cb(Array.isArray(list) ? list : []);
      ipcRenderer.on("bluetooth:devices", listener);
      return () => ipcRenderer.removeListener("bluetooth:devices", listener);
    },
  },
  remote: {
    status: () => ipcRenderer.invoke("remote:status"),
    start: () => ipcRenderer.invoke("remote:start"),
    stop: () => ipcRenderer.invoke("remote:stop"),
    newKey: () => ipcRenderer.invoke("remote:new-key"),
    // { standby (opened at login, waiting for the phone), folder, autostart: { available, on } }
    settings: () => ipcRenderer.invoke("remote:settings"),
    setAutostart: (on) => ipcRenderer.invoke("remote:set-autostart", on),
    // Over Bluetooth: { available, on, error, address, password: null | "hotspot" | "set" }; its password set.
    bluetooth: () => ipcRenderer.invoke("remote:bluetooth"),
    setBluetoothPassword: (password) => ipcRenderer.invoke("remote:set-bluetooth-password", password),
    onBluetooth: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("remote:bluetooth", listener);
      return () => ipcRenderer.removeListener("remote:bluetooth", listener);
    },
    chooseFolder: () => ipcRenderer.invoke("remote:choose-folder"),
    // Its takes (the remote recording folder's): takes() -> { takes: [{ id, at, size, files }], more };
    // takeDetails(id) -> { ok, details }; editTake(id, details) -> { ok, id, message } (renamed to
    // match); onTakesChanged(cb) when one is changed here or from a phone.
    takes: () => ipcRenderer.invoke("remote:takes"),
    takeDetails: (id) => ipcRenderer.invoke("remote:take-details", id),
    editTake: (id, details) => ipcRenderer.invoke("remote:edit-take", { id, details }),
    onTakesChanged: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("remote:takes-changed", listener);
      return () => ipcRenderer.removeListener("remote:takes-changed", listener);
    },
    // This computer restarted, and its cameras' USB turned off and on, from the device settings
    // page (electron/system-control.js): system() -> { reboot, powerOff, cameraReset }; turned off.
    system: () => ipcRenderer.invoke("remote:system"),
    reboot: () => ipcRenderer.invoke("remote:reboot"),
    powerOff: () => ipcRenderer.invoke("remote:power-off"),
    resetCameras: () => ipcRenderer.invoke("remote:reset-cameras"),
    // The room left where takes are saved, and whether it has a battery (electron/storage.js):
    // -> { free, total, battery }
    storage: () => ipcRenderer.invoke("remote:storage"),
    // A take saved without asking where: { baseName, files } -> { dir, results }
    saveTake: ({ baseName, files }) => ipcRenderer.invoke("files:save-remote", { baseName, files }),
    // Sentry mode's photos and videos deleted from it: { names } or { all: true } -> { deleted, failed }
    deleteSentry: ({ names, all } = {}) => ipcRenderer.invoke("files:delete-sentry", { names, all }),
    onStatus: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("remote:status", listener);
      return () => ipcRenderer.removeListener("remote:status", listener);
    },
    // What the phone's page shows (about twice a second) and the cameras' previews.
    setState: (state) => ipcRenderer.send("remote:state", state),
    sendPreviews: (list) => ipcRenderer.send("remote:previews", list),
    onWantPreviews: (cb) => {
      const listener = (_event, on) => cb(on);
      ipcRenderer.on("remote:want-previews", listener);
      return () => ipcRenderer.removeListener("remote:want-previews", listener);
    },
    // cb({ id, action }) for each request from the phone; answer with result(id, { ok, message }).
    onCommand: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("remote:command", listener);
      return () => ipcRenderer.removeListener("remote:command", listener);
    },
    result: (id, result) => ipcRenderer.send("remote:result", { id, result }),
  },

  // Another computer's remote recording, from this app's remote recording page
  // (remote-client.js): { rig: "pi:47821", path, method, body, key } -> { status, type, body }.
  rig: {
    request: (opts) => ipcRenderer.invoke("rig:request", opts),
  },

  // The Hand Tracker website's hand mouse moving this computer's pointer (electron/web-link.js).
  webLink: {
    status: () => ipcRenderer.invoke("weblink:status"),
    start: () => ipcRenderer.invoke("weblink:start"),
    stop: () => ipcRenderer.invoke("weblink:stop"),
    onStatus: (cb) => {
      const listener = (_event, s) => cb(s);
      ipcRenderer.on("weblink:status", listener);
      return () => ipcRenderer.removeListener("weblink:status", listener);
    },
  },

  // Sentry mode's alerts through ntfy (electron/ntfy.js): { server, topic, title, message,
  // tags, priority, click, photo?, filename? } -> { ok }. Its second look's model (second-look.js):
  // its bytes, downloaded the first time.
  sentry: {
    ntfy: (req) => ipcRenderer.invoke("sentry:ntfy", req),
    secondLookModel: () => ipcRenderer.invoke("sentry:second-look-model"),
  },
});
