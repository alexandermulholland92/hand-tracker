/**
 * oak-source.js — a Luxonis OAK camera (OAK-D, OAK-D Lite, OAK-1...) as the tracking source,
 * in the Windows and Linux app. The hands are found on the camera itself (electron/oak.js,
 * oak/oak_bridge.py); its frames and hands arrive here and go through HandTracker like any
 * camera's (smoothing, gestures, recording), and an OAK-D adds each hand's distance.
 *
 *   OakSource.available()                 // true in the desktop app
 *   await OakSource.start(settings)       // sets it up first if needed (asks), then streams
 *   OakSource.stop()
 *   OakSource.isActive()
 *   await OakSource.ensureReady()         // the one-time setup if it's needed (asks); false if canceled
 *   OakSource.toResults(header)           // a helper frame's hands, shaped as HandTracker takes them
 *                                         // (and its objects, as results.objects)
 *   OakSource.objects() / OakSource.motion()  // the last frame's objects found and motion (each ninth
 *                                         // of the picture, 0-1), with Find objects / Sentry mode on
 *   OakSource.onFrameInfo(cb)             // cb({ objects, motion, t }) each frame
 *   OakSource.cameraOptions(settings.oak) // { detect, picture, motion, fps } as the helper takes them
 *   OakSource.silentNote(ports)           // what to say of OAK cameras plugged in that didn't answer
 *                                         // (also for "Several cameras", multi-camera.js)
 */

(function (global) {
  const desktop = global.desktop;
  let active = false;
  let unsubscribe = [];
  let lastBitmap = null;
  let onChange = () => {};
  let info = { camera: "", depth: false, fps: 0 };
  let lastObjects = null, lastMotion = null;
  let frameInfo = () => {};

  const $ = (id) => document.getElementById(id);
  const errText = (err) => (err && err.message ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

  // The one-time setup, in a dialog: what it does, then its progress.
  function askSetup(reason) {
    const dialog = $("oakDialog"), log = $("oakLog"), go = $("oakSetup"), cancel = $("oakCancel");
    $("oakReason").textContent = reason || "";
    log.textContent = "";
    log.hidden = true;
    go.disabled = false;
    go.textContent = "Set up OAK support";
    dialog.hidden = false;
    return new Promise((resolve) => {
      const close = (ok) => {
        dialog.hidden = true;
        go.onclick = cancel.onclick = null;
        resolve(ok);
      };
      cancel.onclick = () => close(false);
      go.onclick = async () => {
        go.disabled = true;
        go.textContent = "Setting up…";
        log.hidden = false;
        const lines = [];
        try {
          await desktop.oak.setup((line) => {
            lines.push(line);
            if (lines.length > 12) lines.shift();
            log.textContent = lines.join("\n");
          });
          close(true);
        } catch (err) {
          log.textContent += `\n\nSetup failed: ${errText(err)}`;
          go.disabled = false;
          go.textContent = "Try again";
        }
      };
    });
  }

  function toResults(header) {
    const hands = header.hands || [];
    const swap = (l) => (l === "Left" ? "Right" : "Left");
    return {
      multiHandLandmarks: hands.map((h) => h.lm.map(([x, y, z]) => ({ x, y, z }))),
      // HandTracker expects MediaPipe's own labels (it turns them into the person's side).
      multiHandedness: hands.map((h) => ({ label: h.anatomical ? swap(h.label) : h.label, score: h.score })),
      multiHandWorldLandmarks: hands.map((h) => (Array.isArray(h.world) && h.world.length === 21 ? h.world.map(([x, y, z]) => ({ x, y, z })) : [])),
      extras: hands.map((h) => ({ score: h.lm_score, xyz: h.xyz })),
      objects: Array.isArray(header.objects) ? header.objects : null,
    };
  }
  // The OAK camera's own options (More settings → OAK camera): find objects, the depth
  // picture, its frame rate; and motion for each ninth of the picture while Sentry mode watches.
  function cameraOptions(oak = {}) {
    return {
      detect: !!oak.detect,
      picture: oak.picture === "depth" ? "depth" : "color",
      motion: !!oak.motion,
      fps: Number(oak.fps) > 0 ? Number(oak.fps) : undefined,
    };
  }

  async function show({ header, jpeg }) {
    try {
      if (!active || !jpeg) return;
      const bitmap = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
      if (!active) return bitmap.close();
      lastObjects = Array.isArray(header.objects) ? header.objects : null;
      lastMotion = Array.isArray(header.motion) ? header.motion : null;
      HandTracker.pushExternalFrame(bitmap, toResults(header), header.t);
      frameInfo({ objects: lastObjects, motion: lastMotion, t: header.t });
      if (lastBitmap) lastBitmap.close();
      lastBitmap = bitmap;
      info.fps = header.fps;
    } catch (err) {
      console.warn("OAK frame:", err);
    } finally {
      desktop.oak.shown();
    }
  }

  async function ensureReady() {
    let status = await desktop.oak.status();
    if (status.ready) return true;
    if (!(await askSetup(status.reason))) return false;
    status = await desktop.oak.status();
    if (!status.ready) throw new Error(status.reason);
    return true;
  }

  async function start(settings) {
    if (!(await ensureReady())) throw Object.assign(new Error("OAK setup canceled"), { canceled: true });
    stop();
    await HandTracker.useExternalSource("OAK camera");
    active = true;
    info = { camera: "OAK camera", depth: false, fps: 0 };
    unsubscribe = [
      desktop.oak.onFrame(show),
      desktop.oak.onStatus((s) => {
        if (s.status === "running") info = { camera: s.camera || "OAK camera", depth: !!s.depth, fps: 0 };
        onChange(s);
      }),
    ];
    await desktop.oak.start({
      lm: settings.model === 1 ? "full" : "lite",
      twoHands: settings.hands === 2,
      xyz: true, // measured on depth cameras (OAK-D); ignored on others
      far: settings.far && settings.far.enabled ? settings.far.focus : null,
      allHands: settings.far && settings.far.enabled && !settings.far.raisedOnly,
      ...cameraOptions(settings.oak),
    });
  }

  function stop() {
    if (!active) return;
    active = false;
    for (const off of unsubscribe) off();
    unsubscribe = [];
    lastObjects = lastMotion = null;
    desktop.oak.stop().catch(() => {});
    if (lastBitmap) lastBitmap.close();
    lastBitmap = null;
  }

  // Switching to anything else (a webcam, a window, a video file) ends the OAK stream.
  if (global.HandTracker) {
    HandTracker.onSourceChange((camera) => {
      if (camera.source !== "external") stop();
    });
  }

  // OAK cameras plugged in that didn't answer when listed (USB ports, from desktop.oak.list's
  // silent): stuck, until they're unplugged and plugged back in.
  function silentNote(ports) {
    if (!ports || !ports.length) return "";
    const one = ports.length === 1;
    return `${one ? "An OAK camera is" : `${ports.length} OAK cameras are`} plugged in (USB ${ports.join(", ")}) but not answering, so ${one ? "it isn't" : "they aren't"} listed: unplug ${one ? "it" : "them"} and plug ${one ? "it" : "them"} back in (a powered hub is best).`;
  }

  global.OakSource = {
    silentNote,
    available: () => !!(desktop && desktop.oak),
    start,
    stop,
    isActive: () => active,
    ensureReady,
    toResults,
    cameraOptions,
    objects: () => (active ? lastObjects : null),
    motion: () => (active ? lastMotion : null),
    onFrameInfo: (cb) => (frameInfo = cb || (() => {})),
    info: () => ({ ...info }),
    onStatus: (cb) => (onChange = cb),
  };
})(window);
