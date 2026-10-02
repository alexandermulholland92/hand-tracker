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
 *   close   — stop the cameras;
 *   details — only the take details (contributor, location, task), which any request can
 *             bring along: kept here (so every phone sees them, and they last), and when a
 *             take is stopped, its name ("Sam_Lab-2_Pick-up-cup_2026-10-01_16-30-00") and
 *             its metadata;
 *   camera  — one running camera's role (which moves it to that block of the grid), its turn
 *             (0, 90, 180 or 270 degrees) or its flip.
 * Only cameras that are plugged in get a tile. Nothing starts by itself: the cameras only run once the phone (or someone here) asks.
 * While the phone's page is open, each camera's picture with its hands drawn goes to it a few
 * times a second.
 *
 *   RemoteRecordUI.init({ desktop, mobile, prefs, setPref, app: HandTrackerApp });
 * (On the website it only shows the header's link to remote.html, which opens a rig's page.)
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

  // ---------- the take details ----------
  const DETAILS = ["contributor", "location", "task"];
  const DETAIL_LABELS = { contributor: "Contributor", location: "Location", task: "Task" };
  const details = () => Object.fromEntries(DETAILS.map((k) => [k, String((prefs.remoteDetails || {})[k] || "")]));
  // A take can't start without all three (each take is named after them).
  const missingDetails = () => DETAILS.filter((k) => !details()[k].trim());
  const listOf = (words) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0] || "");
  // The details a take started with: locked from when recording is asked for until the take is
  // saved (the next take can have others). Recording started at the computer locks them too.
  let takeDetails = null;
  let recordStarting = false; // starting the cameras, then recording
  function detailsLocked() {
    if (takeDetails && !recordStarting && !MultiCamera.isRecording()) takeDetails = null; // stopped at the computer
    return !!takeDetails || recordStarting || MultiCamera.isRecording();
  }
  function setDetails(d) {
    const next = Object.fromEntries(DETAILS.map((k) => [k, String((d && d[k]) || "").slice(0, 200)]));
    if (DETAILS.some((k) => next[k] !== details()[k])) setPref("remoteDetails", next);
  }

  const p2 = (n) => String(n).padStart(2, "0");
  // A recording's length: "1:05" (or "1:02:03") for the metadata; "1m05s" (or "1h02m03s", "42s") for names.
  function lengthText(seconds, forName) {
    const s = Math.max(0, Math.floor(seconds || 0)); // whole seconds, as the timer showed them
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (forName) return h ? `${h}h${p2(m)}m${p2(sec)}s` : m ? `${m}m${p2(sec)}s` : `${sec}s`;
    return h ? `${h}:${p2(m)}:${p2(sec)}` : `${m}:${p2(sec)}`;
  }

  // A take's name: its details and length, then when it started
  // ("Sam_Lab-2_Pick-up-cup_1m05s_2026-10-01_16-30-00"), or "robot-motion_<length>_<when>"
  // without any details. (Each part is kept short, so the length and time always fit.)
  function takeName(d, when, seconds) {
    const part = (v) => String(v || "").trim().replace(/[<>:"/\\|?*]+/g, "-").replace(/\s+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 28).replace(/[-.]+$/, "");
    const parts = DETAILS.map((k) => part(d[k])).filter(Boolean);
    const t = new Date(when);
    const stamp = `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}_${p2(t.getHours())}-${p2(t.getMinutes())}-${p2(t.getSeconds())}`;
    return [...(parts.length ? parts : ["robot-motion"]), lengthText(seconds, true), stamp].join("_");
  }

  // ---------- what the phone's page shows ----------
  function state() {
    const st = MultiCamera.remoteState();
    const locked = detailsLocked();
    return { ...st, pending, lastTake, details: takeDetails || details(), detailsLocked: locked, savedCameras: Array.isArray(prefs.multiCameras) ? prefs.multiCameras.length : 0 };
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
  // The cameras plugged in now: OAK cameras ("oak:<id>", once OAK support is set up), then webcams.
  async function connectedIds() {
    const ids = [];
    if (global.OakSource && OakSource.available() && global.desktop.oak) {
      const status = await desktop.oak.status().catch(() => ({}));
      if (status.ready) {
        // One the main window is using isn't listed: it's let go first (as Several cameras would).
        if (OakSource.isActive()) {
          OakSource.stop();
          await sleep(2500);
        }
        ids.push(...(await desktop.oak.list().catch(() => [])).map((d) => `oak:${d.id}`));
      }
    }
    ids.push(...(await HandTracker.listCameras()).map((c) => c.deviceId));
    return ids;
  }

  // Those of the cameras last picked in Several cameras that are plugged in now (a tile for
  // one that isn't would only say so); with none picked, every OAK camera, else every webcam.
  async function cameraIds() {
    const connected = await connectedIds();
    const picked = Array.isArray(prefs.multiCameras) ? prefs.multiCameras : [];
    if (picked.length) return picked.filter((id) => connected.includes(id)).slice(0, MAX_CAMERAS);
    const oaks = connected.filter((id) => id.startsWith("oak:"));
    return (oaks.length ? oaks : connected).slice(0, MAX_CAMERAS);
  }

  async function startCameras() {
    if (MultiCamera.isActive()) return;
    const ids = await cameraIds();
    if (!ids.length) {
      const picked = Array.isArray(prefs.multiCameras) ? prefs.multiCameras.length : 0;
      throw new Error(picked ? `None of the ${picked} cameras picked in Several cameras is plugged in.` : "No cameras found.");
    }
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

  // The take gets the details it started with (they can't change meanwhile) and its length,
  // from Start to Stop, as metadata and in its name.
  async function stopAndSave() {
    const d = takeDetails || details();
    const seconds = Math.round(MultiCamera.remoteState().elapsed_s * 100) / 100;
    const take = MultiCamera.stopRecording(true, { metadata: { ...d, length: lengthText(seconds), length_s: seconds } });
    const at = new Date().toISOString();
    if (!take) {
      lastTake = { ok: false, at, message: "No hands were recorded, so nothing was saved." };
      return { ok: false, message: lastTake.message };
    }
    const saved = await app.saveMotionNow(takeName(d, take.recorded_at || Date.now(), seconds));
    takeDetails = null; // saved: the next take can have others
    lastTake = saved && saved.ok
      ? { ok: true, at, files: saved.files, dir: saved.dir, duration: seconds, hands: take.hands.length, details: d }
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

  async function carryOut(action, data = {}) {
    const locked = detailsLocked();
    if (data.details && !locked) setDetails(data.details);
    if (action === "details") return locked ? { ok: false, locked: true, message: "The take details can't be changed while recording." } : { ok: true, message: "" };
    if (action === "camera") {
      // One running camera's role (it moves to that block), turn or flip.
      const c = data.camera || {};
      if (!MultiCamera.remoteState().cameras.some((x) => x.index === c.index)) return { ok: false, message: "That camera isn't running." };
      if (c.role !== undefined) MultiCamera.setRole(c.index, c.role);
      if (c.rotation !== undefined || c.mirror !== undefined) MultiCamera.setView(c.index, { rotation: c.rotation, mirror: c.mirror });
      return { ok: true, message: "" };
    }
    if (pending) return { ok: false, message: `Busy: ${pending}` };
    const recording = MultiCamera.isRecording();
    if (action === "cameras") {
      if (MultiCamera.isActive()) return { ok: true, message: "The cameras are already running." };
      inBackground("Starting the cameras…", startCameras);
      return { ok: true, message: "Starting the cameras…" };
    }
    if (action === "record") {
      if (recording) return { ok: true, message: "Already recording." };
      const missing = missingDetails();
      if (missing.length) return { ok: false, missing, message: `Fill in ${listOf(missing.map((k) => DETAIL_LABELS[k]))} first: each take is named after them.` };
      // The details are the take's from now on (until it's saved).
      takeDetails = details();
      recordStarting = true;
      const started = (r) => {
        recordStarting = false;
        if (!r.ok) takeDetails = null;
        return r;
      };
      if (MultiCamera.isActive()) return started(await startRecording().catch((err) => ({ ok: false, message: errText(err) })));
      inBackground("Starting the cameras, then recording…", async () => {
        let r = { ok: false, message: "No camera started, so recording didn't." };
        try {
          await startCameras();
          if (await camerasReady()) r = await startRecording();
        } catch (err) {
          r = { ok: false, message: errText(err) };
        }
        if (!started(r).ok) throw new Error(r.message);
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
    // A link to the page for opening a rig's remote page (remote.html): in place on the website
    // and in the Android app (it has a way back), a window of its own in the Windows and Linux app.
    const link = $("remoteLink");
    if (link) {
      link.hidden = false;
      if (opts.desktop) {
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "Remote recording ↗";
      }
    }
    remote = opts.desktop && opts.desktop.remote;
    if (!remote || !$("remoteRec")) return;
    prefs = opts.prefs;
    setPref = opts.setPref;
    app = opts.app;
    $("remoteRec").hidden = false;
    remote.onStatus(show);
    remote.onWantPreviews(setPreviews);
    remote.onCommand(async ({ id, action, details: d, camera }) => {
      let result;
      try {
        result = await carryOut(action, { details: d, camera });
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

  global.RemoteRecordUI = { init, _carryOut: carryOut, _takeName: takeName };
})(window);
