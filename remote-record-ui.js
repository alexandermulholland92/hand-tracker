/**
 * remote-record-ui.js — the Record card's "Remote recording" (Windows and Linux app): a
 * phone's browser starts and stops motion capture here, with a live preview of each camera
 * (made for a camera rig, a Raspberry Pi say, with nobody at its screen). The web server is
 * electron/remote-record.js, the phone's page electron/remote-page.html; this turns it on,
 * shows its addresses and QR code, and carries out what the phone asks:
 *   cameras — start Several cameras with the cameras last picked there;
 *   record  — start motion capture (starting the cameras first, if need be);
 *   stop    — stop it, and save the take into the remote recording folder by itself, in the
 *             export card's formats (a previous take not yet exported is saved the same way
 *             before a new one starts, rather than asking here);
 *   close   — stop the cameras.
 * Nothing starts by itself: the cameras only run once the phone (or someone here) asks.
 * While the phone's page is open, each camera's picture with its hands drawn goes to it a few
 * times a second.
 *
 *   RemoteRecordUI.init({ desktop, prefs, setPref, app: HandTrackerApp });
 */

(function (global) {
  const $ = (id) => document.getElementById(id);
  const errText = (err) => (err && err.message ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MAX_CAMERAS = 4;
  const STATE_MS = 500;
  const PREVIEW_MS = 250;
  const PREVIEW_WIDTH = 400;

  let remote = null, prefs = {}, setPref = () => {}, app = null;
  let on = false, pending = "", lastTake = null, settings = {};
  let stateTimer = null, previewTimer = null, shownQr = "";

  // ---------- the card ----------
  function show(s) {
    on = s.on;
    const toggle = $("remoteToggle");
    toggle.classList.toggle("active", s.on);
    toggle.setAttribute("aria-pressed", String(s.on));
    toggle.textContent = `Remote recording: ${s.on ? "ON" : "OFF"}`;
    $("remoteNewKey").hidden = !s.on;
    $("remotePair").hidden = !s.on;
    const keyed = (s.urls || []).find((u) => u.keyed);
    const open = (s.urls || []).filter((u) => !u.keyed);
    $("remoteQr").hidden = !keyed;
    if (keyed && keyed.url !== shownQr) {
      global.QRCode.draw($("remoteQr"), keyed.url, { scale: 5, margin: 3 });
      shownQr = keyed.url;
    }
    const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    $("remoteUrls").innerHTML = [
      keyed ? `On this ${esc(keyed.kind === "Wi-Fi" ? "Wi-Fi" : "network")}: scan the QR code with your phone's camera.` : "",
      open.length ? `Over Tailscale, no code needed (from your own devices on it): ${open.map((u) => `<code>${esc(u.url)}</code>`).join(" or ")}` : "",
      !(s.urls || []).length ? "This computer isn't connected to a network." : "",
    ].filter(Boolean).map((t) => `<div class="remote-row">${t}</div>`).join("");
    $("remoteStatus").textContent = !s.on ? "" : s.viewer ? `Phone connected (${s.viewer.address})` : "Waiting for the phone…";
    if (s.on) startState();
    else stopState();
  }

  function showSettings() {
    $("remoteFolder").textContent = settings.folder || "";
    const auto = settings.autostart || {};
    $("remoteAutostartRow").hidden = !auto.available;
    $("remoteAutostart").checked = !!auto.on;
  }

  // ---------- what the phone's page shows ----------
  function state() {
    const st = MultiCamera.remoteState();
    return { ...st, pending, lastTake, savedCameras: Array.isArray(prefs.multiCameras) ? prefs.multiCameras.length : 0 };
  }
  const push = () => on && remote.setState(state());
  function startState() {
    if (stateTimer) return;
    push();
    stateTimer = setInterval(push, STATE_MS);
  }
  function stopState() {
    clearInterval(stateTimer);
    stateTimer = null;
    setPreviews(false);
  }

  // Each camera's picture (its tracker's canvas, so the hands are drawn), small, while asked for.
  const small = document.createElement("canvas");
  function setPreviews(want) {
    clearInterval(previewTimer);
    previewTimer = want ? setInterval(sendPreviews, PREVIEW_MS) : null;
  }
  let sending = false;
  async function sendPreviews() {
    if (sending) return;
    sending = true;
    try {
      const out = [];
      for (const { i, canvas } of MultiCamera.previewSources()) {
        if (!canvas || !canvas.width || !canvas.height) continue;
        small.width = Math.min(PREVIEW_WIDTH, canvas.width);
        small.height = Math.round((small.width * canvas.height) / canvas.width);
        small.getContext("2d").drawImage(canvas, 0, 0, small.width, small.height);
        const blob = await new Promise((r) => small.toBlob(r, "image/jpeg", 0.6));
        if (blob) out.push({ i, jpeg: new Uint8Array(await blob.arrayBuffer()) });
      }
      if (out.length) remote.sendPreviews(out);
    } catch {
      // a tile going away meanwhile: the next round has the rest
    } finally {
      sending = false;
    }
  }

  // ---------- what the phone asks for ----------
  // The cameras last picked in Several cameras; failing that, every OAK camera, or every webcam.
  async function cameraIds() {
    if (Array.isArray(prefs.multiCameras) && prefs.multiCameras.length) return prefs.multiCameras.slice(0, MAX_CAMERAS);
    let ids = [];
    if (global.OakSource && OakSource.available() && global.desktop.oak) {
      const status = await desktop.oak.status().catch(() => ({}));
      if (status.ready) ids = (await desktop.oak.list().catch(() => [])).map((d) => `oak:${d.id}`);
    }
    if (!ids.length) ids = (await HandTracker.listCameras()).map((c) => c.deviceId);
    return ids.slice(0, MAX_CAMERAS);
  }

  async function startCameras() {
    if (MultiCamera.isActive()) return;
    const ids = await cameraIds();
    if (!ids.length) throw new Error("No cameras found.");
    await MultiCamera.start(ids);
  }

  // Until every camera runs (or says why it can't).
  async function camerasReady(ms = 90000) {
    for (let t = 0; t < ms; t += 500) {
      const cams = MultiCamera.remoteState().cameras;
      if (cams.length && cams.every((c) => c.fps > 0 || c.error)) return cams.some((c) => c.fps > 0);
      await sleep(500);
    }
    return false;
  }

  async function startRecording() {
    // A take nobody exported is saved first (nobody may be here to say whether to keep it).
    if (app.hasUnsavedMotion()) {
      const saved = await app.saveMotionNow();
      if (saved && !saved.ok) return { ok: false, message: `The last take couldn't be saved, so a new one wasn't started: ${saved.message}` };
    }
    return MultiCamera.startRecording();
  }

  async function stopAndSave() {
    const take = MultiCamera.stopRecording(true);
    const at = new Date().toISOString();
    if (!take) {
      lastTake = { ok: false, at, message: "No hands were recorded, so nothing was saved." };
      return { ok: false, message: lastTake.message };
    }
    const saved = await app.saveMotionNow();
    lastTake = saved && saved.ok
      ? { ok: true, at, files: saved.files, dir: saved.dir, duration: take.duration, hands: take.hands.length }
      : { ok: false, at, message: `Recorded, but not saved: ${(saved && saved.message) || "export it on the computer"}` };
    return { ok: lastTake.ok, message: lastTake.ok ? `Saved ${saved.files.join(", ")}` : lastTake.message };
  }

  // Runs a step in the background (starting cameras takes a while), showing what's going on.
  function inBackground(text, work) {
    pending = text;
    push();
    work()
      .catch((err) => (lastTake = { ok: false, at: new Date().toISOString(), message: errText(err) }))
      .finally(() => {
        pending = "";
        push();
      });
  }

  async function carryOut(action) {
    if (pending) return { ok: false, message: `Busy: ${pending}` };
    const recording = MultiCamera.isRecording();
    if (action === "cameras") {
      if (MultiCamera.isActive()) return { ok: true, message: "The cameras are already running." };
      inBackground("Starting the cameras…", startCameras);
      return { ok: true, message: "Starting the cameras…" };
    }
    if (action === "record") {
      if (recording) return { ok: true, message: "Already recording." };
      if (MultiCamera.isActive()) return startRecording();
      inBackground("Starting the cameras, then recording…", async () => {
        await startCameras();
        if (!(await camerasReady())) throw new Error("No camera started, so recording didn't.");
        const r = await startRecording();
        if (!r.ok) throw new Error(r.message);
      });
      return { ok: true, message: "Starting the cameras, then recording…" };
    }
    if (action === "stop") {
      if (!recording) return { ok: true, message: "Not recording." };
      return stopAndSave();
    }
    if (action === "close") {
      if (recording) return { ok: false, message: "Stop recording first." };
      MultiCamera.close();
      return { ok: true, message: "Cameras stopped." };
    }
    return { ok: false, message: `Unknown request: ${action}` };
  }

  function init(opts) {
    remote = opts.desktop && opts.desktop.remote;
    if (!remote || !$("remoteRec")) return;
    prefs = opts.prefs;
    setPref = opts.setPref;
    app = opts.app;
    $("remoteRec").hidden = false;
    remote.onStatus(show);
    remote.onWantPreviews(setPreviews);
    remote.onCommand(async ({ id, action }) => {
      let result;
      try {
        result = await carryOut(action);
      } catch (err) {
        result = { ok: false, message: errText(err) };
      }
      remote.result(id, result);
      push();
    });
    $("remoteToggle").addEventListener("click", async () => {
      try {
        const s = await remote.status();
        const next = s.on ? await remote.stop() : await remote.start();
        setPref("remoteRecord", next.on);
        show(next);
      } catch (err) {
        $("remoteStatus").textContent = `Couldn't turn it on: ${errText(err)}`;
      }
    });
    $("remoteNewKey").addEventListener("click", async () => show(await remote.newKey()));
    $("remoteFolderBtn").addEventListener("click", async () => {
      settings.folder = await remote.chooseFolder();
      showSettings();
    });
    $("remoteAutostart").addEventListener("change", async (e) => {
      try {
        const turnedOn = await remote.setAutostart(e.target.checked);
        settings.autostart = { ...settings.autostart, on: turnedOn };
        // Opened at login it waits for the phone, so remote recording stays on.
        if (turnedOn) setPref("remoteRecord", true);
      } catch (err) {
        $("remoteStatus").textContent = errText(err);
      }
      showSettings();
    });
    remote.settings().then((s) => {
      settings = s;
      showSettings();
      // On when it was left on, and always when opened at login to wait for the phone.
      if (prefs.remoteRecord === true || s.standby) remote.start().then(show).catch((err) => ($("remoteStatus").textContent = `Couldn't turn it on: ${errText(err)}`));
      else remote.status().then(show);
    });
  }

  global.RemoteRecordUI = { init, _carryOut: carryOut };
})(window);
