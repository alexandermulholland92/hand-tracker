/**
 * multi-camera.js — several live cameras at once. Each camera runs in a tile of its own
 * (camera-tile.html: its own hand tracker, so each has its own left and right hand), side
 * by side in the "Several cameras" card, which takes the main view's place while they run (the
 * main camera is paused meanwhile) and goes back when they close. Each camera has a role, where it's worn (head,
 * chest, left or right wrist: camera-roles.js), remembered for that camera. Motion capture
 * records every camera together; stopping merges them into one recording on a shared clock,
 * with each hand named after its camera's role ("Head Left", "Chest Right"…, or "Cam 1 Left"
 * for a camera with no role), which then exports like any recording.
 *
 * The tiles sit in a grid by role: head, chest, left wrist, right wrist (in that order, two to
 * a row; a single camera takes the whole grid); the roles with no camera are listed under it.
 * Changing a camera's role moves it. Each tile takes its camera's shape (a phone held upright
 * gives a tall one, not a wide one with black bars). Each tile can be turned 90° at a time and flipped (mirrored) on its own, remembered
 * for that camera: every camera starts mirrored like a selfie, OAK cameras too.
 *
 * The picker ticks every camera found (up to four, OAK cameras first) except one that was
 * unticked before; only the ticked ones start. Remote recording shares the picks.
 *
 * Luxonis OAK cameras can be among them (Windows and Linux app): the picker lists each one
 * plugged in ("oak:<id>"), the camera finds the hands itself (a helper each, electron/oak.js),
 * and its tile only draws and records them. They're started one after another, which is
 * easier on USB power than all at once. Their pictures can be left off this screen ("Hide
 * pictures", or Remote recording's page): decoding and drawing them is most of what a small
 * computer like a Raspberry Pi does with four cameras, and the hands don't need them. They're
 * then only drawn as often as remote recording's previews need them.
 *
 *   MultiCamera.init({ prefs, setPref, app: HandTrackerApp, modelOf: () => 0 | 1, phone });
 *   MultiCamera.setOptions({ display, overlay, square, far, gloves, paused, oak })   // the main window's
 *     More settings, any of them, for every tile now and every tile started later (Tile.setOptions;
 *     an OAK camera is started again with a new far-away setting or new OAK camera options, oak:
 *     { detect, picture, motion, fps } (OakSource.cameraOptions), which run on the camera)
 *   await MultiCamera.openPicker();          // choose cameras, then start
 *   await MultiCamera.start(ids);            // (the picker's Start; ids may repeat, for checks)
 *   MultiCamera.keyOf(camera)                // a webcam's id for remembering it (see keyOf)
 *   MultiCamera.close();
 *   await MultiCamera.startRecording() / MultiCamera.stopRecording(show, extra)   // -> { ok, message } / the take (or null; extra: added to it)
 *   MultiCamera.remoteState(); MultiCamera.previewSources();           // for remote recording (remote-record-ui.js)
 *   MultiCamera.sentryViews()                                          // each camera, for Sentry mode (sentry.js)
 *   MultiCamera.setRole(i, role); MultiCamera.setView(i, { rotation, mirror })
 *   MultiCamera.setScreenPictures(on); MultiCamera.screenPictures()   // OAK pictures on this screen (remembered)
 *   MultiCamera.setPreviewWant({ on, focus, ms, focusMs })             // remote recording's previews: how often each is made
 */

(function (global) {
  const MAX_CAMERAS = 4;
  const STATUS_MS = 500;

  let prefs = {}, setPref = () => {}, app = null, modelOf = () => 1, phone = false, onClose = () => {};
  let tileOptions = {}; // the main window's More settings, for every tile (setOptions)
  let els = {};
  let tiles = []; // { name, deviceId, role, view: { rotation, mirror }, label, frame, el, oak (its id, for an OAK camera), oakState }
  let statusTimer = null;
  let recording = false;
  let recordingSince = 0;
  let oakOff = []; // the OAK stream listeners, while OAK tiles run
  let restoreOak = false; // the main window's OAK camera was in use: back to it when the tiles close
  let oakPorts = {}; // OAK camera id -> its USB port, from the last listing
  let home = null; // where the card goes back to when the cameras close: { parent, next }
  let previewWant = { on: false, focus: null, ms: 250, focusMs: 66 }; // remote recording's previews

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const errText = (err) => (err && err.message ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isOak = (id) => String(id).startsWith("oak:");
  // A webcam's id for remembering it (picks, roles, turn and flip): its device id, but on Android
  // each start of the app gives the cameras new ids, so there it's the camera's name
  // ("cam:camera 0, facing back"), which stays the same. OAK cameras are "oak:<id>".
  const keyOf = (c) => (global.mobile ? `cam:${c.label}` : c.deviceId);
  const oakAvailable = () => !!(global.OakSource && OakSource.available() && global.desktop && desktop.oak && desktop.oak.list);
  // An OAK camera by its model once it's been seen ("OAK-D-W"), and its USB port.
  const oakLabel = (id) => `Luxonis ${(prefs.oakNames || {})[id] || "OAK camera"}${oakPorts[id] ? ` (USB ${oakPorts[id]})` : ""}`;

  // ---------- picking cameras ----------
  async function openPicker() {
    const cams = await HandTracker.listCameras();
    const chosen = Array.isArray(prefs.multiCameras) ? prefs.multiCameras : [];
    const box = (value, label) => `<label class="multi-cam-pick"><input type="checkbox" value="${esc(value)}"${chosen.includes(value) ? " checked" : ""} /> ${esc(label)}</label>`;
    els.pickList.innerHTML = cams.map((c) => box(keyOf(c), c.label)).join("") + (oakAvailable() ? '<div id="multiCamOak" class="note">Looking for Luxonis OAK cameras…</div>' : "");
    els.dialog.hidden = false;
    updatePickButton();
    if (oakAvailable()) await listOak(box);
    tickNew();
    updatePickButton();
  }

  // Every camera found is ticked, up to four (OAK cameras first), except one unticked before
  // (here or in Remote recording) or meanwhile.
  function tickNew() {
    const off = Array.isArray(prefs.multiCamerasOff) ? prefs.multiCamerasOff : [];
    const boxes = [...els.pickList.querySelectorAll("input")];
    let n = boxes.filter((b) => b.checked).length;
    for (const b of [...boxes.filter((x) => isOak(x.value)), ...boxes.filter((x) => !isOak(x.value))]) {
      if (n >= MAX_CAMERAS) break;
      if (b.checked || b.dataset.touched || off.includes(b.value)) continue;
      b.checked = true;
      n++;
    }
  }

  // The OAK cameras plugged in, once OAK support is set up. One the main window is using
  // isn't free to list: it's let go first (and taken back if the picker is canceled).
  async function listOak(box) {
    const area = $("multiCamOak");
    try {
      const status = await desktop.oak.status();
      if (!status.ready) {
        area.innerHTML = 'Luxonis OAK cameras need a one-time setup first. <button id="multiCamOakSetup">Set up OAK support…</button>';
        $("multiCamOakSetup").onclick = async () => {
          try {
            if (await OakSource.ensureReady()) openPicker();
          } catch (err) {
            area.textContent = errText(err);
          }
        };
        return;
      }
      if (OakSource.isActive()) {
        OakSource.stop();
        restoreOak = true;
        await sleep(2500); // the camera resets before it can be listed again
      }
      const { devices, silent } = await desktop.oak.list({ detail: true });
      if (!area.isConnected) return; // the picker went meanwhile
      oakPorts = Object.fromEntries(devices.map((d) => [d.id, d.name]));
      // One plugged in that didn't answer is said, rather than just missing.
      const stuck = silent.length ? `<div class="note">${esc(OakSource.silentNote(silent))}</div>` : "";
      area.outerHTML = (devices.length ? devices.map((d) => box(`oak:${d.id}`, oakLabel(d.id))).join("") : stuck ? "" : '<div class="note">No Luxonis OAK cameras found.</div>') + stuck;
    } catch (err) {
      if (area.isConnected) area.textContent = `Luxonis OAK cameras: ${errText(err)}`;
    }
    updatePickButton();
  }

  function picked() {
    return [...els.pickList.querySelectorAll("input:checked")].map((i) => i.value);
  }
  function updatePickButton() {
    const n = picked().length;
    const available = els.pickList.querySelectorAll("input").length;
    els.pickNote.textContent = !available ? "No cameras found." : available < 2 ? "Only one camera is connected: plug in another to track several at once." : `Pick up to ${MAX_CAMERAS}.`;
    els.start.disabled = n < 2 || n > MAX_CAMERAS;
    els.start.textContent = n > MAX_CAMERAS ? `At most ${MAX_CAMERAS} cameras` : `Start ${n >= 2 ? n : ""} cameras`.replace("  ", " ");
  }

  // ---------- the tiles ----------
  // The card in the main view's place (before any tile's page loads: moving one reloads it),
  // or back where it was.
  function inPlace(on) {
    const wrap = $("wrap");
    if (!wrap || !els.card) return;
    if (on && !home) {
      home = { parent: els.card.parentNode, next: els.card.nextSibling };
      wrap.parentNode.insertBefore(els.card, wrap);
      els.card.classList.add("in-place");
      wrap.hidden = true;
    } else if (!on && home) {
      home.parent.insertBefore(els.card, home.next);
      home = null;
      els.card.classList.remove("in-place");
      wrap.hidden = false;
    }
  }

  async function start(deviceIds) {
    close(true);
    inPlace(true);
    const cams = await HandTracker.listCameras();
    const find = (id) => cams.find((c) => c.deviceId === id || keyOf(c) === id);
    const labelOf = (id) => (isOak(id) ? oakLabel(id.slice(4)) : (find(id) || {}).label || (id.startsWith("cam:") ? id.slice(4) : "Camera"));
    // (A camera by name that isn't found by its id is looked for by its name in its tile.)
    const deviceOf = (id) => (find(id) || {}).deviceId || id;
    // An OAK camera the main window is using can't be a tile too.
    if (deviceIds.some(isOak) && global.OakSource && OakSource.isActive()) {
      OakSource.stop();
      restoreOak = true;
      await sleep(2500);
    }
    // The main camera's tracking pauses while the tiles track (they'd compete for the same computer).
    HandTracker.setPaused(true);
    els.dialog.hidden = true;
    els.card.hidden = false;
    els.grid.className = "multi-cam-grid";
    const model = modelOf();
    const ids = deviceIds.slice(0, MAX_CAMERAS);
    const saved = prefs.multiCameraRoles || {};
    const roles = CameraRoles.assign(ids.map((id) => ({ name: labelOf(id), saved: saved[id] })));
    tiles = ids.map((id, i) => {
      const name = `Cam ${i + 1}`;
      const view = viewOf(id);
      const el = document.createElement("div");
      el.className = "multi-cam-tile";
      el.innerHTML =
        `<iframe title="${esc(name)}" allow="camera"></iframe><div class="multi-cam-caption"><b>${esc(name)}</b> ` +
        `<select class="role" data-i="${i}" title="Where this camera is worn: its hands are named after it, and its picture goes in that block">${CameraRoles.options(roles[i])}</select> ` +
        `<button type="button" class="rot" data-i="${i}" title="Turn this camera's picture (and its tracking) 90° clockwise"></button> ` +
        `<button type="button" class="flip" data-i="${i}" aria-pressed="false" title="Show this camera's picture mirrored (only the look: the left hand stays the left)">Flip</button> ` +
        `<span class="lbl">${esc(labelOf(id))}</span> <span class="st"></span> <button type="button" class="retry" data-i="${i}" hidden>Try again</button></div>`;
      const frame = el.querySelector("iframe");
      const look = `mirror=${view.mirror ? 1 : 0}&rot=${view.rotation}${phone ? "&phone=1" : ""}`;
      frame.src = isOak(id)
        ? `camera-tile.html?oak=${encodeURIComponent(id.slice(4))}&${look}&name=${encodeURIComponent(name)}`
        : `camera-tile.html?device=${encodeURIComponent(deviceOf(id))}&label=${encodeURIComponent(labelOf(id))}&${look}&model=${model}&name=${encodeURIComponent(name)}`;
      els.grid.appendChild(el);
      return { name, deviceId: id, role: roles[i], view, label: labelOf(id), frame, el, oak: isOak(id) ? id.slice(4) : null, oakState: "" };
    });
    tiles.forEach(showView);
    tiles.forEach(applyOptions);
    layout();
    showPictures();
    if (tiles.some((t) => t.oak)) startOakTiles(tiles.filter((t) => t.oak));
    els.record.disabled = false;
    els.note.textContent = "Each camera has its own hand tracker. With several cameras each one runs slower than a single camera would.";
    clearInterval(statusTimer);
    statusTimer = setInterval(showStatus, STATUS_MS);
    els.card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // A camera's name in its hands' names and the recording: its role, or "Cam 1".
  const nameOf = (t) => CameraRoles.label(t.role) || t.name;

  // A role picked for one camera: a camera that had it takes this one's old role.
  function setRole(i, role) {
    if (!tiles[i] || (role && !CameraRoles.ROLES.some((r) => r.id === role))) return;
    const roles = CameraRoles.pick(tiles.map((t) => t.role), i, role);
    const saved = { ...(prefs.multiCameraRoles || {}) };
    tiles.forEach((t, j) => {
      t.role = roles[j];
      t.el.querySelector("select.role").value = t.role;
      saved[t.deviceId] = t.role;
    });
    setPref("multiCameraRoles", saved);
    layout();
  }

  // Each tile in its role's block (by CSS order, so no tile's page reloads), the rest "no camera".
  function layout() {
    const { slots, empty } = CameraRoles.blocks(tiles.map((t) => t.role));
    tiles.forEach((t, i) => (t.el.style.order = slots[i]));
    els.grid.classList.toggle("one", tiles.length === 1);
    if (els.missing) els.missing.textContent = tiles.length && empty.length ? `Not connected: ${empty.map((b) => CameraRoles.ROLES[b].label).join(", ")}` : "";
  }

  // A tile in its camera's shape (once its size is known), no taller than most of the window.
  function shape(t, st) {
    if (!st || !st.width || !st.height) return;
    const ratio = st.width / st.height;
    if (t.ratio === ratio) return;
    t.ratio = ratio;
    t.frame.style.aspectRatio = `${st.width} / ${st.height}`;
    t.frame.style.maxWidth = `calc(75vh * ${ratio.toFixed(4)})`;
  }

  // A camera's turn and flip, remembered for it: every camera starts mirrored like a selfie.
  function viewOf(id) {
    const v = (prefs.multiCameraView || {})[id] || {};
    return { rotation: [0, 90, 180, 270].includes(v.rotation) ? v.rotation : 0, mirror: typeof v.mirror === "boolean" ? v.mirror : true };
  }
  function setView(i, change) {
    const t = tiles[i];
    if (!t) return;
    const next = { ...t.view };
    if (change.rotation !== undefined) next.rotation = (((Math.round(Number(change.rotation) / 90) * 90) % 360) + 360) % 360;
    if (change.mirror !== undefined) next.mirror = !!change.mirror;
    t.view = next;
    const api = tileApi(t);
    if (api && api.setView) api.setView(next);
    setPref("multiCameraView", { ...(prefs.multiCameraView || {}), [t.deviceId]: next });
    showView(t);
  }
  function showView(t) {
    t.el.querySelector("button.rot").textContent = `⟳ ${t.view.rotation}°`;
    const flip = t.el.querySelector("button.flip");
    flip.classList.toggle("active", t.view.mirror);
    flip.setAttribute("aria-pressed", String(t.view.mirror));
  }

  // ---------- More settings in every tile ----------
  // A tile gets the main window's settings once its page is up (Pause only when on: a tile
  // starts tracking), and every change after that.
  async function applyOptions(t) {
    let api = null;
    for (let i = 0; i < 100 && tiles.includes(t) && !(api = tileApi(t)); i++) await sleep(100);
    if (!api || !api.setOptions || !tiles.includes(t)) return;
    await api.ready.catch(() => {});
    if (!tiles.includes(t)) return;
    const { paused, ...rest } = tileOptions;
    api.setOptions(paused ? tileOptions : rest);
  }
  function setOptions(o = {}) {
    const farChanged = (o.far && JSON.stringify(oakFar(o.far)) !== JSON.stringify(oakFar(tileOptions.far))) ||
      (o.oak && JSON.stringify(OakSource.cameraOptions(o.oak)) !== JSON.stringify(OakSource.cameraOptions(tileOptions.oak)));
    tileOptions = { ...tileOptions, ...o };
    for (const t of tiles) {
      const api = tileApi(t);
      if (api && api.setOptions) api.setOptions(o);
    }
    // An OAK camera's far-away mode and options are its own: started again with the new ones.
    if (farChanged) for (const t of tiles.filter((x) => x.oak && x.oakState !== "starting")) restartOak(t);
  }
  // Far-away hands as an OAK camera's helper takes it.
  const oakFar = (far) => (far && far.enabled ? { far: far.focus || "both", allHands: far.raisedOnly === false } : { far: null, allHands: false });
  async function restartOak(t) {
    t.oakState = "starting";
    const api = tileApi(t);
    if (api && api.oakStatus) api.oakStatus({ status: "starting", message: "Starting the OAK camera again with the new settings…" });
    await desktop.oak.streamStop(t.oak).catch(() => {});
    await sleep(2500); // until the camera is let go
    if (tiles.includes(t)) startOakTiles([t]);
  }

  const tileApi = (t) => {
    try {
      return t.frame.contentWindow && t.frame.contentWindow.Tile;
    } catch {
      return null;
    }
  };

  function showStatus() {
    for (const t of tiles) {
      const api = tileApi(t);
      const st = api ? api.status() : null;
      t.el.querySelector(".st").textContent = !st ? "starting…" : st.error ? st.error : `${st.fps} fps · ${st.hands.length ? st.hands.join(" + ") : "no hands"}${st.recording ? " · recording" : ""}${t.oak && !screenPictures() ? " · picture off" : ""}`;
      t.el.querySelector(".retry").hidden = !(t.oak && st && st.error && t.oakState !== "starting");
      if (st && !st.error) shape(t, st);
    }
  }

  // An OAK camera that didn't start (or stopped) is started again, the others carry on.
  function retryOak(t) {
    if (!t || !t.oak || t.oakState === "starting") return;
    t.el.querySelector(".retry").hidden = true;
    const api = tileApi(t);
    if (api && api.oakStatus) api.oakStatus({ status: "starting" });
    startOakTiles([t]);
  }

  // ---------- OAK cameras in tiles ----------
  // One after another: each is started once its tile is ready, and the next once it runs
  // (or failed, or 30 s went by).
  async function startOakTiles(list) {
    if (!oakOff.length) oakOff = [desktop.oak.onStreamFrame(onOakFrame), desktop.oak.onStreamStatus(onOakStatus)];
    const model = modelOf();
    for (const t of list) {
      let api = null;
      for (let i = 0; i < 100 && tiles.includes(t) && !(api = tileApi(t)); i++) await sleep(100);
      if (!api || !tiles.includes(t)) continue;
      await api.ready.catch(() => {});
      if (!tiles.includes(t)) return;
      t.oakState = "starting";
      try {
        await desktop.oak.streamStart(t.oak, { lm: model === 1 ? "full" : "lite", twoHands: true, xyz: true, ...oakFar(tileOptions.far), ...OakSource.cameraOptions(tileOptions.oak) });
      } catch (err) {
        t.oakState = "error";
        api.oakStatus({ status: "error", message: errText(err) });
        continue;
      }
      for (let i = 0; i < 300 && tiles.includes(t) && t.oakState === "starting"; i++) await sleep(100);
    }
  }

  // ---------- an OAK camera's pictures ----------
  // Each frame's hands go to its tile at once, and the next frame is asked for straight away:
  // its picture follows when one's due and the last one is drawn (decoding and drawing a
  // picture can take far longer than a frame on a Raspberry Pi, and the hands don't wait).
  // Pictures are due on this screen (unless they're off, or the window is hidden); otherwise
  // only as often as remote recording's previews need them.
  const screenPictures = () => prefs.screenPictures !== false;
  const screenShows = () => screenPictures() && document.visibilityState !== "hidden";
  function pictureDue(t, i) {
    if (!t.lastPicture || screenShows()) return true; // (the first one: the tile shows something)
    if (t.wants > 0 && performance.now() - t.lastPicture >= 60) return true; // its video's being recorded
    const w = previewWant;
    const every = !w.on ? Infinity : w.focus !== null ? (w.focus === i ? w.focusMs : Infinity) : w.ms;
    return performance.now() - t.lastPicture >= every - 15;
  }

  function onOakFrame({ id, header, jpeg }) {
    const i = tiles.findIndex((x) => x.oak === id);
    const t = tiles[i];
    const api = t && tileApi(t);
    if (!api || !api.oakHands) return desktop.oak.streamShown(id);
    let hands = null;
    try {
      hands = api.oakHands(header.w, header.h, OakSource.toResults(header), header.t);
    } catch {
      // its page going away meanwhile
    }
    desktop.oak.streamShown(id);
    // For Sentry mode: the camera's small grey picture, and what it found.
    if (header.grey) t.grey = OakSource.decodeGrey(header.grey) || t.grey;
    t.objects = Array.isArray(header.objects) ? header.objects : null;
    if (!hands || !jpeg || t.drawing || !pictureDue(t, i)) return;
    t.drawing = true;
    t.lastPicture = performance.now();
    api
      .oakPicture(jpeg, hands)
      .catch(() => {})
      .finally(() => (t.drawing = false));
  }

  function setScreenPictures(on) {
    setPref("screenPictures", !!on);
    showPictures();
  }

  function setPreviewWant(w = {}) {
    previewWant = { ...previewWant, ...w, on: !!w.on, focus: w.on && Number.isInteger(w.focus) ? w.focus : null };
  }

  // The card's button, and each OAK tile dimmed (its picture is old) while they're off.
  function showPictures() {
    if (!els.screenBtn) return;
    const oak = tiles.some((t) => t.oak);
    els.screenBtn.hidden = !oak;
    els.screenBtn.textContent = screenPictures() ? "Hide pictures" : "Show pictures";
    els.screenBtn.setAttribute("aria-pressed", String(!screenPictures()));
    for (const t of tiles) t.el.classList.toggle("no-picture", !!t.oak && !screenPictures());
  }

  function onOakStatus(s) {
    const t = tiles.find((x) => x.oak === s.id);
    if (!t) return;
    if (s.status === "running") {
      t.oakState = "running";
      // Remembered by model, so the picker can name it next time.
      if (s.camera && (prefs.oakNames || {})[s.id] !== s.camera) setPref("oakNames", { ...(prefs.oakNames || {}), [s.id]: s.camera });
      t.label = `Luxonis ${s.camera || "OAK camera"}${s.depth ? " · depth" : ""}${s.usb === "HIGH" ? " · USB 2" : ""}`;
      t.el.querySelector(".lbl").textContent = t.label;
    } else if (s.status === "error" || s.status === "stopped") {
      t.oakState = s.status;
    }
    const api = tileApi(t);
    if (api && api.oakStatus) api.oakStatus(s);
  }

  // keepOak: another set of tiles comes next (the main window's OAK camera isn't taken back yet).
  function close(keepOak) {
    if (recording) stopRecording(false);
    clearInterval(statusTimer);
    const hadOak = tiles.some((t) => t.oak);
    for (const t of tiles) t.el.remove(); // a tile's page going away releases its camera
    tiles = [];
    if (els.missing) els.missing.textContent = "";
    if (hadOak) desktop.oak.streamStop().catch(() => {});
    for (const off of oakOff) off();
    oakOff = [];
    if (els.card) els.card.hidden = true;
    if (els.grid) els.grid.innerHTML = "";
    inPlace(false);
    HandTracker.setPaused(false);
    tileOptions.paused = false; // the next tiles start tracking
    onClose();
    if (restoreOak && keepOak !== true) {
      restoreOak = false;
      if (app && app.useOak) setTimeout(() => app.useOak(), hadOak ? 2500 : 0); // once the cameras are let go
    }
  }

  // ---------- motion capture from every camera ----------
  async function toggleRecording() {
    if (!recording) return startRecording();
    stopRecording(true);
  }

  async function startRecording() {
    if (recording) return { ok: true, message: "Already recording." };
    const fail = (message) => {
      els.note.textContent = message;
      return { ok: false, message };
    };
    if (!tiles.length) return fail("No cameras are running.");
    const apis = tiles.map(tileApi);
    if (apis.some((a) => !a)) return fail("Wait for every camera to start.");
    if (app.readyForNewMotion && !app.readyForNewMotion()) return { ok: false, message: "The last capture hasn't been exported." }; // kept unless you say otherwise
    await Promise.all(apis.map((a) => a.ready.catch(() => {})));
    const live = apis.filter((a) => !a.status().error);
    if (!live.length) return fail("No camera is running.");
    for (const a of live) a.startRecording();
    recording = true;
    recordingSince = Date.now();
    els.record.textContent = "Stop Motion Capture";
    els.record.classList.add("recording");
    els.note.textContent = "Recording every camera's hands…";
    return { ok: true, message: `Recording ${live.length} camera${live.length === 1 ? "" : "s"}.` };
  }

  // Returns the take (null if no hands were recorded); show: hand it to the export card.
  // extra: more for the take (remote recording's take details).
  function stopRecording(show = true, extra = null) {
    if (!recording) return null;
    recording = false;
    els.record.textContent = "Start Motion Capture";
    els.record.classList.remove("recording");
    const parts = tiles
      .map((t) => {
        const api = tileApi(t);
        return api && api.status().recording ? { tile: t, data: api.stopRecording() } : null;
      })
      .filter(Boolean);
    if (!show) return null;
    const merged = merge(parts);
    if (!merged) {
      els.note.textContent = "No hands were recorded.";
      return null;
    }
    if (extra) Object.assign(merged, extra);
    els.note.textContent = `Recorded ${merged.hands.length} hand${merged.hands.length === 1 ? "" : "s"} from ${parts.length} camera${parts.length === 1 ? "" : "s"}: export below.`;
    app.showMotionExport(merged);
    return merged;
  }

  // ---------- for remote recording (remote-record-ui.js) ----------
  function remoteState() {
    return {
      running: tiles.length > 0,
      recording,
      elapsed_s: recording ? (Date.now() - recordingSince) / 1000 : 0,
      cameras: tiles.map((t, i) => {
        const api = tileApi(t);
        const st = api ? api.status() : null;
        return {
          index: i, name: t.name, roleId: t.role || "", role: CameraRoles.label(t.role) || "", label: t.label, rotation: t.view.rotation, mirror: t.view.mirror,
          fps: st ? st.fps : 0, hands: st ? st.hands : [], error: st ? st.error || "" : "",
        };
      }),
      note: els.note ? els.note.textContent : "",
    };
  }

  // For Sentry mode (sentry.js): each tile's camera (its place in remoteState's list), its
  // picture and what it tracks.
  function sentryViews() {
    return tiles.map((t, i) => ({
      key: t.deviceId,
      index: i,
      name: nameOf(t),
      canvas: () => t.frame.contentDocument && t.frame.contentDocument.getElementById("stage"),
      frame: () => t.frame.contentWindow.HandTracker.getFrameImage(),
      mirrored: () => !!t.view.mirror,
      rotation: () => t.view.rotation || 0,
      grey: t.oak ? () => t.grey || null : null,
      objects: t.oak ? () => t.objects || null : null,
      oak: !!t.oak,
      want: (on) => (t.wants = Math.max(0, (t.wants || 0) + (on ? 1 : -1))),
    }));
  }

  // Each tile's picture, with its hands drawn (its tracker's canvas).
  function previewSources() {
    return tiles.map((t, i) => {
      try {
        return { i, canvas: t.frame.contentDocument && t.frame.contentDocument.getElementById("stage") };
      } catch {
        return { i, canvas: null };
      }
    });
  }

  // The cameras' recordings as one: each camera's clock shifted onto the earliest one's,
  // each hand named after its camera.
  function merge(parts) {
    const withHands = parts.filter((p) => p.data && p.data.hands && p.data.hands.length && p.data.clock_origin_ms !== null);
    if (!withHands.length) return null;
    const origin = Math.min(...withHands.map((p) => p.data.clock_origin_ms));
    const sizes = new Set(withHands.map((p) => (p.data.image_size || []).join("x")));
    const hands = [];
    for (const p of withHands) {
      const shift = (p.data.clock_origin_ms - origin) / 1000;
      for (const h of p.data.hands) {
        const at = (t) => Math.round((t + shift) * 1e6) / 1e6;
        hands.push({
          ...h,
          handedness: `${nameOf(p.tile)} ${h.handedness}`,
          frames: h.frames.map((f) => ({ ...f, t: at(f.t) })),
          trajectories: Object.fromEntries(Object.entries(h.trajectories || {}).map(([k, rows]) => [k, rows.map((r) => [at(r[0]), ...r.slice(1)])])),
        });
      }
    }
    const first = withHands[0].data;
    const duration = Math.max(...hands.map((h) => (h.frames.length ? h.frames[h.frames.length - 1].t : 0)));
    return {
      ...first,
      duration,
      hands,
      recorded_at: new Date(origin).toISOString(),
      time_origin_s: null,
      cameras: withHands.map((p) => ({ name: nameOf(p.tile), role: p.tile.role || null, camera: p.tile.label, offset_s: Math.round(((p.data.clock_origin_ms - origin) / 1000) * 1e6) / 1e6, image_size: p.data.image_size })),
      notes: [
        ...(first.notes || []),
        `Recorded from ${withHands.length} cameras at once (${withHands.map((p) => `${nameOf(p.tile)}: ${p.tile.label}`).join("; ")}); every hand's t is on one shared clock, and each hand is named after its camera${withHands.some((p) => p.tile.role) ? "'s role (where it's worn)" : ""}.`,
        ...(sizes.size > 1 ? ["The cameras' pictures were different sizes: 3D exports use the first camera's proportions."] : []),
      ],
    };
  }

  function init(opts) {
    prefs = opts.prefs;
    setPref = opts.setPref;
    app = opts.app;
    modelOf = opts.modelOf || modelOf;
    phone = !!opts.phone;
    onClose = opts.onClose || onClose;
    els = {
      dialog: $("multiCamDialog"), pickList: $("multiCamPicks"), pickNote: $("multiCamPickNote"), start: $("multiCamStart"), cancel: $("multiCamCancel"),
      card: $("multiCamCard"), grid: $("multiCamGrid"), record: $("multiCamRecord"), closeBtn: $("multiCamClose"), note: $("multiCamNote"),
      screenBtn: $("multiCamScreen"), missing: $("multiCamMissing"),
    };
    if (!els.dialog) return;
    // OAK cameras used to start not mirrored, and a camera turned then kept that: it's let go
    // once, so they're mirrored like the others (a flip from now on is remembered as ever).
    if (!prefs.oakMirrored) {
      const views = { ...(prefs.multiCameraView || {}) };
      for (const [id, v] of Object.entries(views)) {
        if (isOak(id) && v && v.mirror === false) views[id] = { rotation: v.rotation };
      }
      setPref("multiCameraView", views);
      setPref("oakMirrored", true);
    }
    els.pickList.addEventListener("change", (e) => {
      if (e.target && e.target.dataset) e.target.dataset.touched = "1";
      updatePickButton();
    });
    els.cancel.addEventListener("click", () => {
      els.dialog.hidden = true;
      if (restoreOak && !tiles.length) close(); // the main window's OAK camera, let go to list it
    });
    els.start.addEventListener("click", () => {
      const ids = picked();
      // Those left unticked stay that way next time (a new camera is ticked by itself).
      const left = [...els.pickList.querySelectorAll("input:not(:checked)")].map((b) => b.value);
      setPref("multiCameras", ids);
      setPref("multiCamerasOff", [...new Set([...(prefs.multiCamerasOff || []).filter((id) => !ids.includes(id)), ...left])]);
      start(ids);
    });
    els.record.addEventListener("click", () => toggleRecording());
    els.grid.addEventListener("change", (e) => {
      if (e.target.matches && e.target.matches("select.role")) setRole(Number(e.target.dataset.i), e.target.value);
    });
    els.grid.addEventListener("click", (e) => {
      const b = e.target.closest && e.target.closest("button");
      if (!b) return;
      const i = Number(b.dataset.i);
      if (b.matches("button.retry")) retryOak(tiles[i]);
      else if (b.matches("button.rot") && tiles[i]) setView(i, { rotation: tiles[i].view.rotation + 90 });
      else if (b.matches("button.flip") && tiles[i]) setView(i, { mirror: !tiles[i].view.mirror });
    });
    els.closeBtn.addEventListener("click", () => close());
    if (els.screenBtn) els.screenBtn.addEventListener("click", () => setScreenPictures(!screenPictures()));
  }

  global.MultiCamera = {
    init, openPicker, start, close, keyOf, setOptions, options: () => ({ ...tileOptions }), startRecording, stopRecording, remoteState, previewSources, sentryViews, setRole, setView, setScreenPictures, screenPictures, setPreviewWant,
    isActive: () => tiles.length > 0, isRecording: () => recording,
    _tiles: () => tiles.map((t) => ({ name: t.name, role: t.role, status: tileApi(t) ? tileApi(t).status() : null })),
  };
})(window);
