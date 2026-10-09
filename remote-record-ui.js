/**
 * remote-record-ui.js — the Record card's "Remote recording" (Windows, Mac and Linux app): a
 * phone's browser starts and stops motion capture here, with a live preview of each camera
 * (made for a camera rig, a Raspberry Pi say, with nobody at its screen). The web server is
 * electron/remote-record.js, the phone's page remote-client.html (and .js); this turns it on,
 * shows its addresses and QR code, and carries out what the phone asks:
 *   scan    — look for the cameras it can start (OAK cameras and webcams): the page lists them
 *             before the cameras start, with any picked one that isn't plugged in;
 *   pick    — one of those: use it or not, and its role (the same picks and roles as Several
 *             cameras; none picked yet, every one found is used);
 *   mode    — Ego (all four roles: head, chest, left and right wrist), Stereo (a head camera;
 *             any others picked run too) or Freeform (any): Start cameras and Start recording
 *             need the cameras the mode does;
 *   settings — whether the take details are needed before recording (a hidden switch on the
 *             page), and whether each camera's video (and sound) is recorded with the take, and
 *             at what quality (videoQuality: low, standard, high or best);
 *   cameras — start Several cameras with the cameras picked that are plugged in;
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
 *             (0, 90, 180 or 270 degrees) or its flip;
 *   sentry  — Sentry mode (sentry.js, hidden on the page until its title is tapped five times):
 *             its settings, each camera's boxes, on and off (on, it starts the cameras if
 *             they're off: it watches them).
 * With each take, each camera's video is recorded too (with sound from this computer's
 * microphone), saved beside the take's motion capture as <take>-video-<role>.webm (.mp4 on a
 * phone): the phone's Takes list has them too.
 * Only cameras that are plugged in get a tile. Nothing starts by itself: the cameras only run once the phone (or someone here) asks.
 * While the phone's page is open, each camera's picture with its hands drawn goes to it, up to
 * about 15 times a second (fewer if making them would take much of this computer's time).
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
  const PREVIEW_MS = 66; // at most; less often if making them takes long (PREVIEW_SHARE)
  const PREVIEW_SHARE = 0.5; // of the time, at most, spent making previews
  const PREVIEW_WIDTH = 400;
  // A camera looked at full screen on the page: that one only, bigger and more often.
  const FOCUS_MS = 66;
  const FOCUS_WIDTH = 960;

  let remote = null, prefs = {}, setPref = () => {}, app = null;
  // The cameras remote recording uses: Several cameras, on a computer and on a phone alike (a
  // phone's own cameras, front and back, and any plugged into it).
  let onPhone = false;
  const cams = () => global.MultiCamera;
  let on = false, pending = "", lastTake = null, settings = {}, lastStatus = null;
  let videos = []; // each camera's video while a take records: { role, rec, view }
  let host = null; // desktop or mobile: saving the videos
  const remoteVideo = () => prefs.remoteVideo !== false;
  const remoteSound = () => prefs.remoteSound !== false;
  const QUALITIES = ["low", "standard", "high", "best"]; // (CameraVideo's)
  const QUALITY_NAMES = { low: "small files", standard: "standard", high: "high", best: "best" };
  const remoteQuality = () => (QUALITIES.includes(prefs.remoteVideoQuality) ? prefs.remoteVideoQuality : "standard");
  let stateTimer = null, previewTimer = null, shownQr = "";

  // ---------- the card ----------
  function show(s) {
    on = s.on;
    lastStatus = s;
    const toggle = $("remoteToggle");
    toggle.classList.toggle("active", s.on);
    toggle.setAttribute("aria-pressed", String(s.on));
    toggle.textContent = `Remote recording: ${s.on ? "ON" : "OFF"}`;
    $("remoteNewKey").hidden = !s.on;
    $("remotePair").hidden = !s.on;
    const keyed = (s.urls || []).find((u) => u.keyed);
    const open = (s.urls || []).filter((u) => !u.keyed && u.kind === "Tailscale");
    const hotspot = (s.urls || []).filter((u) => u.kind === "Hotspot");
    $("remoteQr").hidden = !keyed;
    if (keyed && keyed.url !== shownQr) {
      global.QRCode.draw($("remoteQr"), keyed.url, { scale: 5, margin: 3 });
      shownQr = keyed.url;
    }
    const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    $("remoteUrls").innerHTML = [
      keyed ? `On this ${esc(keyed.kind === "Wi-Fi" ? "Wi-Fi" : "network")}: scan the QR code with a phone's camera, or paste this address into Remote recording (at the top) in Hand Tracker on the other device: <code>${esc(keyed.url)}</code>` : "",
      hotspot.length ? `On this computer's own hotspot, no code needed: ${hotspot.map((u) => `<code>${esc(u.url)}</code>`).join(" or ")}` : "",
      open.length ? `Over Tailscale, no code needed (from your own devices on it): ${open.map((u) => `<code>${esc(u.url)}</code>`).join(" or ")}` : "",
      !(s.urls || []).length ? `This ${onPhone ? "phone" : "computer"} isn't connected to a network.` : "",
    ].filter(Boolean).map((t) => `<div class="remote-row">${t}</div>`).join("");
    $("remoteStatus").textContent = !s.on ? "" : s.viewer ? `${onPhone ? "Connected" : "Phone connected"} (${s.viewer.address})` : onPhone ? "Waiting for the other device…" : "Waiting for the phone…";
    if (s.on) startState();
    else stopState();
  }

  function showSettings() {
    $("remoteFolder").textContent = settings.folder || "";
    const auto = settings.autostart || {};
    $("remoteAutostartRow").hidden = !auto.available;
    $("remoteAutostart").checked = !!auto.on;
    if ($("remoteVideo")) {
      $("remoteVideo").checked = remoteVideo();
      $("remoteSound").checked = remoteSound();
      $("remoteSound").disabled = !remoteVideo();
    }
    if ($("remoteQuality")) {
      $("remoteQuality").value = remoteQuality();
      $("remoteQuality").disabled = !remoteVideo();
    }
  }

  // ---------- the take details ----------
  const DETAILS = ["contributor", "location", "task"];
  const DETAIL_LABELS = { contributor: "Contributor", location: "Location", task: "Task" };
  const details = () => Object.fromEntries(DETAILS.map((k) => [k, String((prefs.remoteDetails || {})[k] || "")]));
  // A take can't start without all three (each take is named after them), unless that's
  // turned off (the page's hidden switch).
  const detailsRequired = () => prefs.remoteDetailsRequired !== false;
  const missingDetails = () => (detailsRequired() ? DETAILS.filter((k) => !details()[k].trim()) : []);
  const listOf = (words) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0] || "");
  // The details a take started with: locked from when recording is asked for until the take is
  // saved (the next take can have others). Recording started at the computer locks them too.
  let takeDetails = null;
  let recordStarting = false; // starting the cameras, then recording
  function detailsLocked() {
    if (takeDetails && !recordStarting && !cams().isRecording()) takeDetails = null; // stopped at the computer
    return !!takeDetails || recordStarting || cams().isRecording();
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
    const st = cams().remoteState();
    const locked = detailsLocked();
    const common = { ...st, pending, lastTake, notice, details: takeDetails || details(), detailsLocked: locked, detailsRequired: detailsRequired() };
    return {
      ...common, kind: "rig", video: remoteVideo(), sound: remoteSound(), videoQuality: remoteQuality(),
      sentry: global.Sentry ? global.Sentry.remoteState() : null,
      // (Pictures on its own screen: OAK cameras only, which a phone doesn't have.)
      mode: modeNow(), requirement: requirement(), screenPictures: onPhone ? undefined : cams().screenPictures(),
      available: { at: scanned.at, scanning: scanned.scanning, note: scanned.note, cameras: available() },
    };
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

  // Each camera's picture (its tracker's canvas, so the hands are drawn), small, while asked
  // for; or only the one looked at full screen, bigger. Each about 15 times a second.
  // want: { on, focus } (or just on/off).
  const small = document.createElement("canvas");
  let focus = null;
  let previewsOn = false, previewMs = PREVIEW_MS, previewRun = 0;
  // How often the cameras' pictures are made (the tiles draw them only as often as needed).
  const wantPictures = () => cams() && cams().setPreviewWant(focus !== null ? { on: previewsOn, focus, ms: PREVIEW_MS, focusMs: previewMs } : { on: previewsOn, focus: null, ms: previewMs, focusMs: FOCUS_MS });
  function setPreviews(want) {
    const w = want && typeof want === "object" ? want : { on: !!want, focus: null };
    focus = w.on && Number.isInteger(w.focus) ? w.focus : null;
    previewsOn = !!w.on;
    previewMs = focus !== null ? FOCUS_MS : PREVIEW_MS;
    wantPictures();
    clearTimeout(previewTimer);
    const run = ++previewRun;
    previewTimer = previewsOn ? setTimeout(() => previewRound(run), 0) : null;
  }
  // A round of previews, then the next as soon as allowed: each camera's about 15 times a
  // second, unless a round takes long (four cameras on a Raspberry Pi): then as often as keeps
  // making them under PREVIEW_SHARE of the time.
  async function previewRound(run) {
    const t0 = performance.now();
    await sendPreviews();
    if (run !== previewRun || !previewsOn) return;
    const took = performance.now() - t0;
    const ms = Math.min(1000, Math.max(focus !== null ? FOCUS_MS : PREVIEW_MS, took / PREVIEW_SHARE));
    const changed = Math.abs(ms - previewMs) > 10;
    previewMs = ms;
    if (changed) wantPictures();
    previewTimer = setTimeout(() => previewRound(run), Math.max(0, ms - took));
  }
  let sending = false;
  async function sendPreviews() {
    if (sending) return;
    sending = true;
    try {
      const out = [];
      for (const { i, canvas } of cams().previewSources()) {
        if (!canvas || !canvas.width || !canvas.height || (focus !== null && i !== focus)) continue;
        small.width = Math.min(focus !== null ? FOCUS_WIDTH : PREVIEW_WIDTH, canvas.width);
        small.height = Math.round((small.width * canvas.height) / canvas.width);
        small.getContext("2d").drawImage(canvas, 0, 0, small.width, small.height);
        const blob = await new Promise((r) => small.toBlob(r, "image/jpeg", focus !== null ? 0.72 : 0.6));
        if (blob) out.push({ i, jpeg: new Uint8Array(await blob.arrayBuffer()) });
      }
      if (out.length) remote.sendPreviews(out);
    } catch {
      // a tile going away meanwhile: the next round has the rest
    } finally {
      sending = false;
    }
  }

  // ---------- the cameras it can start, and the mode ----------
  const MODES = { ego: ["head", "chest", "wrist_left", "wrist_right"], stereo: ["head"], freeform: [] };
  const MODE_NAMES = { ego: "Ego", stereo: "Stereo", freeform: "Freeform" };
  const modeNow = () => (MODES[prefs.remoteMode] ? prefs.remoteMode : "freeform");

  // The last look for cameras: { at, scanning, note, found: [{ id, label }] }.
  let scanned = { at: 0, scanning: false, note: "", found: [] };
  let scanning = null;
  let notice = null; // { at, message }: what went wrong in the background, for the page to say
  const labels = {}; // camera id -> its label when last found (for one picked that's gone)

  const oakLabel = (id, port) => `Luxonis ${(prefs.oakNames || {})[id] || "OAK camera"}${port ? ` (USB ${port})` : ""} …${id.slice(-6)}`;
  const labelOf = (id) => labels[id] || (id.startsWith("oak:") ? oakLabel(id.slice(4)) : id.startsWith("cam:") ? id.slice(4) : "Webcam");
  // Picked: every camera found, up to four (those picked before first, then OAK cameras), except
  // one unticked here or in Several cameras; one picked that isn't plugged in is still listed
  // (if there's room). Only the picked ones start.
  function pickedIds() {
    // (On a phone, cameras picked by a device id from before are gone: it changes every start.)
    const saved = (Array.isArray(prefs.multiCameras) ? prefs.multiCameras : []).filter((id) => !onPhone || /^(cam|oak):/.test(id));
    const off = Array.isArray(prefs.multiCamerasOff) ? prefs.multiCamerasOff : [];
    const found = scanned.found.map((c) => c.id);
    const present = [...saved.filter((id) => found.includes(id)), ...found.filter((id) => !saved.includes(id) && !off.includes(id))];
    return [...present.slice(0, MAX_CAMERAS), ...saved.filter((id) => !found.includes(id))].slice(0, MAX_CAMERAS);
  }

  // The cameras plugged in now: OAK cameras ("oak:<id>", once OAK support is set up), then
  // webcams. What stops OAK cameras being listed is said (it isn't the same as none).
  async function findCameras(wanted) {
    const found = [];
    let note = "";
    if (global.OakSource && OakSource.available() && global.desktop && desktop.oak) {
      let status = null;
      try {
        status = await desktop.oak.status();
      } catch (err) {
        note = `OAK cameras: ${errText(err)}`;
      }
      if (status && !status.ready) note = "OAK cameras need a one-time setup on the computer first (Several cameras… → Set up OAK support).";
      if (status && status.ready) {
        // One the main window is using isn't listed: it's let go first (as Several cameras would).
        if (OakSource.isActive()) {
          OakSource.stop();
          await sleep(2500);
        }
        // A camera just let go restarts for a few seconds and isn't listed meanwhile, so a
        // picked one that's missing is looked for again before it counts as unplugged.
        const wantOak = wanted.filter((id) => id.startsWith("oak:"));
        let devices = [], silent = [];
        for (let tries = 0; tries < 3; tries++) {
          try {
            ({ devices, silent } = await desktop.oak.list({ detail: true }));
            note = "";
          } catch (err) {
            devices = [];
            silent = [];
            note = `OAK cameras: ${errText(err)}`;
          }
          if (wantOak.every((id) => devices.some((d) => `oak:${d.id}` === id))) break;
          await sleep(1500);
        }
        for (const d of devices) found.push({ id: `oak:${d.id}`, label: oakLabel(d.id, d.name) });
        // One plugged in that didn't answer is said, rather than just missing.
        if (silent.length) note = OakSource.silentNote(silent);
      }
    }
    for (const c of await HandTracker.listCameras().catch(() => [])) if (c.deviceId) found.push({ id: cams().keyOf(c), label: c.label });
    for (const c of found) labels[c.id] = c.label;
    return { found, note };
  }

  // A fresh look (not while the cameras run: those are what there is).
  function scan() {
    if (scanning) return scanning;
    if (cams().isActive()) return Promise.resolve();
    scanned = { ...scanned, scanning: true };
    push();
    scanning = findCameras(pickedIds())
      .then(({ found, note }) => (scanned = { at: Date.now(), scanning: false, note, found }))
      .catch((err) => (scanned = { ...scanned, at: Date.now(), scanning: false, note: errText(err) }))
      .finally(() => {
        scanning = null;
        push();
      });
    return scanning;
  }

  // The list the page shows: each camera found and each picked one that isn't, whether it's
  // picked and its role (the picked ones that are plugged in get theirs as Several cameras
  // gives them: saved, else from the name, else the next free one).
  function available() {
    const picked = pickedIds();
    const list = scanned.found.map((c) => ({ ...c, present: true }));
    for (const id of picked) if (!list.some((c) => c.id === id)) list.push({ id, label: labelOf(id), present: false });
    const saved = prefs.multiCameraRoles || {};
    const starting = picked.filter((id) => list.some((c) => c.id === id && c.present));
    const roles = CameraRoles.assign(starting.map((id) => ({ name: labelOf(id), saved: saved[id] })));
    const used = new Set(roles.filter(Boolean));
    return list.map((c) => {
      const i = starting.indexOf(c.id);
      const role = i >= 0 ? roles[i] : saved[c.id] && !used.has(saved[c.id]) ? saved[c.id] : "";
      return { id: c.id, label: c.label, present: c.present, use: picked.includes(c.id), role };
    });
  }

  // One camera picked or not, or given a role (a camera that had that role takes its old one).
  function pick({ id, use, role }) {
    const list = available();
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) return { ok: false, message: "That camera isn't plugged in any more." };
    if (typeof use === "boolean") {
      const picked = pickedIds().filter((x) => x !== id);
      if (use && picked.filter((x) => list.some((c) => c.id === x && c.present)).length >= MAX_CAMERAS) return { ok: false, message: `At most ${MAX_CAMERAS} cameras.` };
      setPref("multiCameras", use ? [...picked, id] : picked);
      // Unticked stays unticked (a camera never unticked is picked by itself when it's found).
      const off = (prefs.multiCamerasOff || []).filter((x) => x !== id);
      setPref("multiCamerasOff", use ? off : [...off, id]);
    }
    if (role !== undefined) {
      const roles = CameraRoles.pick(list.map((c) => c.role), i, role);
      const saved = { ...(prefs.multiCameraRoles || {}) };
      // Only this camera's role and the one it took it from (a camera merely shown with no role
      // isn't set to "No role", which would stay).
      list.forEach((c, j) => {
        if (j === i || roles[j] !== c.role) saved[c.id] = roles[j];
      });
      setPref("multiCameraRoles", saved);
    }
    return { ok: true, message: "" };
  }

  // Whether the cameras are what the mode needs: those picked and plugged in (cameras off),
  // those running (on; running: only the ones already sending pictures).
  function requirement({ running = false } = {}) {
    const mode = modeNow();
    const on = cams().isActive();
    if (!on && (scanned.scanning || !scanned.at)) return { ok: false, missing: [], message: "Looking for cameras…" };
    const roles = on
      ? cams().remoteState().cameras.filter((c) => !c.error && (!running || c.fps > 0)).map((c) => c.roleId)
      : available().filter((c) => c.use && c.present).map((c) => c.role);
    const missing = MODES[mode].filter((r) => !roles.includes(r));
    if (!roles.length) return { ok: false, missing, message: on ? "No camera is running." : "Pick a camera that's plugged in." };
    if (missing.length) {
      const which = listOf(missing.map((r) => CameraRoles.label(r)));
      return { ok: false, missing, message: `${MODE_NAMES[mode]} needs ${missing.length === 1 ? "a" : "the"} ${which} camera${missing.length > 1 ? "s" : ""}${on ? " running" : ""}.` };
    }
    return { ok: true, missing: [], message: "" };
  }

  // ---------- what the phone asks for ----------
  async function startCameras() {
    if (cams().isActive()) return;
    await scan(); // a fresh look: one may have come or gone
    const need = requirement();
    if (!need.ok) throw new Error(need.message);
    await cams().start(available().filter((c) => c.use && c.present).map((c) => c.id));
  }

  // Until every camera runs (or says why it can't).
  async function camerasReady(ms = 90000) {
    for (let t = 0; t < ms; t += 500) {
      const list = cams().remoteState().cameras;
      if (list.length && list.every((c) => c.fps > 0 || c.error)) return list.some((c) => c.fps > 0);
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
    const r = await cams().startRecording();
    if (r.ok) startVideos();
    return r;
  }

  // Each camera's video, while a take records (its picture as drawn, with the hands), at up to
  // VIDEO_FPS: a camera gives as many as its tracking does (each picture is drawn with its hands).
  const VIDEO_FPS = 30;
  function startVideos() {
    stopVideos(false);
    if (!remoteVideo() || !global.CameraVideo || !global.CameraVideo.supported()) return;
    const state = cams().remoteState().cameras;
    const views = cams().sentryViews ? cams().sentryViews() : [];
    for (const src of cams().previewSources()) {
      const cam = state.find((c) => c.index === src.i);
      if (!src.canvas || !cam || cam.error) continue;
      const view = views[src.i];
      try {
        if (view && view.want) view.want(true);
        const rec = global.CameraVideo.start({ canvas: src.canvas, fps: VIDEO_FPS, audio: remoteSound(), preferMp4: onPhone, quality: remoteQuality() });
        videos.push({ role: cam.role || cam.name, rec, view });
      } catch (err) {
        if (view && view.want) view.want(false);
        notice = { at: Date.now(), message: `${cam.role || cam.name}'s video didn't start: ${errText(err)}` };
      }
    }
  }
  // -> [{ role, clip }] (clip null if it failed); keep false: they're thrown away.
  async function stopVideos(keep = true) {
    const list = videos;
    videos = [];
    const out = [];
    for (const v of list) {
      if (v.view && v.view.want) v.view.want(false);
      try {
        const clip = await v.rec.stop();
        if (keep) out.push({ role: v.role, clip });
      } catch {
        if (keep) out.push({ role: v.role, clip: null });
      }
    }
    return out;
  }
  // Saved beside the take: <take>-video-<role>. -> the files' names
  async function saveVideos(baseName, list) {
    const saved = [];
    for (const { role, clip } of list) {
      if (!clip || !clip.blob.size || !host) continue;
      const slug = String(role).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "camera";
      try {
        const data = new Uint8Array(await clip.blob.arrayBuffer());
        const res = await host.remote.saveTake({ baseName, files: [{ format: clip.ext, suffix: `-video-${slug}`.slice(0, 24), ext: clip.ext, data }] });
        const r = (res.results || [])[0];
        if (r && r.ok) saved.push(r.path.split(/[\\/]/).pop());
      } catch {
        // (the take's result says what was saved)
      }
    }
    return saved;
  }

  // The take gets the details it started with (they can't change meanwhile) and its length,
  // from Start to Stop, as metadata and in its name.
  async function stopAndSave() {
    const d = takeDetails || details();
    const seconds = Math.round(cams().remoteState().elapsed_s * 100) / 100;
    const startedAt = Date.now() - seconds * 1000;
    const take = await cams().stopRecording(true, { metadata: { ...d, length: lengthText(seconds), length_s: seconds } });
    const clips = await stopVideos(true);
    const at = new Date().toISOString();
    const name = takeName(d, (take && take.recorded_at) || startedAt, seconds);
    const videoFiles = await saveVideos(name, clips);
    if (!take) {
      takeDetails = null;
      lastTake = videoFiles.length
        ? { ok: true, at, files: videoFiles, duration: seconds, hands: 0, details: d }
        : { ok: false, at, message: "No hands were recorded, so nothing was saved." };
      return { ok: lastTake.ok, message: videoFiles.length ? `No hands were recorded; saved the video: ${videoFiles.join(", ")}` : lastTake.message };
    }
    const saved = await app.saveMotionNow(name);
    takeDetails = null; // saved: the next take can have others
    lastTake = saved && saved.ok
      ? { ok: true, at, files: [...saved.files, ...videoFiles], dir: saved.dir, duration: seconds, hands: take.hands.length, details: d }
      : { ok: false, at, message: `Recorded, but not saved: ${(saved && saved.message) || "export it on the computer"}${videoFiles.length ? ` (the video was: ${videoFiles.join(", ")})` : ""}` };
    return { ok: lastTake.ok, message: lastTake.ok ? `Saved ${lastTake.files.join(", ")}` : lastTake.message };
  }

  // Runs a step in the background (starting cameras takes a while), showing what's going on.
  function inBackground(text, work) {
    pending = text;
    push();
    work()
      .catch((err) => (notice = { at: Date.now(), message: errText(err) }))
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
      if (!cams().remoteState().cameras.some((x) => x.index === c.index)) return { ok: false, message: "That camera isn't running." };
      if (c.role !== undefined) cams().setRole(c.index, c.role);
      if (c.rotation !== undefined || c.mirror !== undefined) cams().setView(c.index, { rotation: c.rotation, mirror: c.mirror });
      return { ok: true, message: "" };
    }
    const recording = cams().isRecording();
    if (action === "scan") {
      if (!cams().isActive()) scan();
      return { ok: true, message: "" };
    }
    if (action === "pick") {
      if (recording) return { ok: false, message: "Stop recording first." };
      return pick(data.pick || {});
    }
    if (action === "mode") {
      if (recording || pending) return { ok: false, message: recording ? "Stop recording first." : `Busy: ${pending}` };
      setPref("remoteMode", data.mode);
      return { ok: true, message: "" };
    }
    if (action === "sentry") {
      if (!global.Sentry || !global.Sentry.remoteState()) return { ok: false, message: "This Hand Tracker has no Sentry mode." };
      const c = data.sentry || {};
      const res = await global.Sentry.command(c);
      // Turned on with the cameras off: they start (Sentry watches remote recording's cameras).
      if (res.ok && c.armed === true && !cams().isActive() && !pending) {
        inBackground("Starting the cameras…", startCameras);
        return { ok: true, message: "Sentry is on: starting the cameras…" };
      }
      return res;
    }
    if (action === "settings") {
      const st = data.settings || {};
      // Each camera's video with the take, its sound and its quality (from the next take).
      if (typeof st.video === "boolean" || typeof st.sound === "boolean" || QUALITIES.includes(st.videoQuality)) {
        if (recording) return { ok: false, message: "Stop recording first." };
        if (typeof st.video === "boolean") setPref("remoteVideo", st.video);
        if (typeof st.sound === "boolean") setPref("remoteSound", st.sound);
        if (QUALITIES.includes(st.videoQuality)) setPref("remoteVideoQuality", st.videoQuality);
        showSettings();
        return { ok: true, message: !remoteVideo() ? "Takes are motion capture only." : `Each camera's video is recorded with the take, ${remoteSound() ? "with" : "without"} sound, at ${QUALITY_NAMES[remoteQuality()]} quality.` };
      }
      // The OAK cameras' pictures on this computer's screen (any time: recording doesn't mind).
      if (typeof st.screenPictures === "boolean" && !onPhone) {
        cams().setScreenPictures(st.screenPictures);
        if (typeof st.detailsRequired !== "boolean") {
          return { ok: true, message: st.screenPictures ? "The cameras' pictures are on its screen." : "The cameras' pictures are off its screen: the hands are still tracked and recorded." };
        }
      }
      if (typeof st.detailsRequired !== "boolean") return { ok: false, message: "Which setting?" };
      if (recording) return { ok: false, message: "Stop recording first." };
      setPref("remoteDetailsRequired", st.detailsRequired);
      return { ok: true, message: detailsRequired() ? "The take details are needed before recording." : "The take details are optional now." };
    }
    if (pending) return { ok: false, message: `Busy: ${pending}` };
    if (action === "cameras") {
      if (cams().isActive()) return { ok: true, message: "The cameras are already running." };
      const need = requirement();
      if (!need.ok) return { ok: false, message: need.message };
      inBackground("Starting the cameras…", startCameras);
      return { ok: true, message: "Starting the cameras…" };
    }
    if (action === "record") {
      if (recording) return { ok: true, message: "Already recording." };
      const missing = missingDetails();
      if (missing.length) return { ok: false, missing, message: `Fill in ${listOf(missing.map((k) => DETAIL_LABELS[k]))} first: each take is named after them.` };
      const need = requirement({ running: cams().isActive() });
      if (!need.ok) return { ok: false, message: need.message };
      // The details are the take's from now on (until it's saved).
      takeDetails = details();
      recordStarting = true;
      const started = (r) => {
        recordStarting = false;
        if (!r.ok) takeDetails = null;
        return r;
      };
      if (cams().isActive()) return started(await startRecording().catch((err) => ({ ok: false, message: errText(err) })));
      inBackground("Starting the cameras, then recording…", async () => {
        let r = { ok: false, message: "No camera started, so recording didn't." };
        try {
          await startCameras();
          if (await camerasReady()) {
            // Every camera the mode needs has to be running, not only started.
            const ready = requirement({ running: true });
            r = ready.ok ? await startRecording() : { ok: false, message: `${ready.message} Recording didn't start.` };
          }
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
      await stopVideos(false);
      cams().close();
      scan(); // the cameras let go are listed again
      return { ok: true, message: "Cameras stopped." };
    }
    return { ok: false, message: `Unknown request: ${action}` };
  }

  function init(opts) {
    // A link to the page for opening a rig's remote page (remote.html): in place on the website
    // and in the Android app (it has a way back), a window of its own in the Windows, Mac and Linux app.
    const link = $("remoteLink");
    if (link) {
      link.hidden = false;
      if (opts.desktop) {
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "Remote recording ↗";
      }
    }
    remote = (opts.desktop && opts.desktop.remote) || (opts.mobile && opts.mobile.remote) || null;
    host = opts.desktop || opts.mobile || null;
    if (!remote || !$("remoteRec")) return;
    onPhone = !opts.desktop;
    // On a phone takes always go to Documents/Hand Tracker, and it doesn't open by itself.
    if (onPhone) {
      $("remoteFolderBtn").hidden = true;
      $("remoteToggle").title = "Lets another device (Hand Tracker on your PC, from its Remote recording page, or any browser) start and stop motion capture with this phone's cameras (picked on its page), with a live preview of each.";
    }
    prefs = opts.prefs;
    setPref = opts.setPref;
    app = opts.app;
    $("remoteRec").hidden = false;
    remote.onStatus(show);
    remote.onWantPreviews(setPreviews);
    remote.onCommand(async ({ id, action, details: d, camera, pick: p, mode, settings: st, sentry }) => {
      let result;
      try {
        result = await carryOut(action, { details: d, camera, pick: p, mode, settings: st, sentry });
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
    $("remoteQuality").addEventListener("change", (e) => {
      if (!cams().isRecording() && QUALITIES.includes(e.target.value)) {
        setPref("remoteVideoQuality", e.target.value);
        push();
      }
      showSettings(); // (from the next take: not halfway through one)
    });
    for (const [id, key] of [["remoteVideo", "remoteVideo"], ["remoteSound", "remoteSound"]]) {
      $(id).addEventListener("change", (e) => {
        if (cams().isRecording()) {
          showSettings(); // (from the next take: not halfway through one)
          return;
        }
        setPref(key, e.target.checked);
        showSettings();
        push();
      });
    }
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

  // This computer's remote recording page over Tailscale (no key in it: only your own devices
  // reach it), for a Sentry alert to link to; "" if it has none.
  function tailnetLink() {
    const u = ((lastStatus && lastStatus.urls) || []).find((x) => !x.keyed && x.kind === "Tailscale");
    return u ? u.url : "";
  }

  // Whether a page is looking at the previews now (Sentry mode measures only then, unless it's on).
  const looking = () => previewsOn;
  global.RemoteRecordUI = { init, tailnetLink, looking, _carryOut: carryOut, _takeName: takeName };
})(window);
