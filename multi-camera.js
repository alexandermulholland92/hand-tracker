/**
 * multi-camera.js — several live cameras at once. Each camera runs in a tile of its own
 * (camera-tile.html: its own hand tracker, so each has its own left and right hand), side
 * by side in the "Several cameras" card. Each camera has a role, where it's worn (head,
 * chest, left or right wrist: camera-roles.js), remembered for that camera. Motion capture
 * records every camera together; stopping merges them into one recording on a shared clock,
 * with each hand named after its camera's role ("Head Left", "Chest Right"…, or "Cam 1 Left"
 * for a camera with no role), which then exports like any recording.
 *
 * Luxonis OAK cameras can be among them (Windows and Linux app): the picker lists each one
 * plugged in ("oak:<id>"), the camera finds the hands itself (a helper each, electron/oak.js),
 * and its tile only draws and records them. They're started one after another, which is
 * easier on USB power than all at once.
 *
 *   MultiCamera.init({ prefs, setPref, app: HandTrackerApp, modelOf: () => 0 | 1 });
 *   await MultiCamera.openPicker();          // choose cameras, then start
 *   await MultiCamera.start(deviceIds);      // (the picker's Start; deviceIds may repeat, for checks)
 *   MultiCamera.close();
 *   await MultiCamera.startRecording() / MultiCamera.stopRecording()   // -> { ok, message } / the take (or null)
 *   MultiCamera.remoteState(); MultiCamera.previewSources();           // for remote recording (remote-record-ui.js)
 */

(function (global) {
  const MAX_CAMERAS = 4;
  const STATUS_MS = 500;

  let prefs = {}, setPref = () => {}, app = null, modelOf = () => 1;
  let els = {};
  let tiles = []; // { name, deviceId, role, label, frame, el, oak (its id, for an OAK camera), oakState }
  let statusTimer = null;
  let recording = false;
  let recordingSince = 0;
  let oakOff = []; // the OAK stream listeners, while OAK tiles run
  let restoreOak = false; // the main window's OAK camera was in use: back to it when the tiles close
  let oakPorts = {}; // OAK camera id -> its USB port, from the last listing

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const errText = (err) => (err && err.message ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isOak = (id) => String(id).startsWith("oak:");
  const oakAvailable = () => !!(global.OakSource && OakSource.available() && global.desktop && desktop.oak && desktop.oak.list);
  // An OAK camera by its model once it's been seen ("OAK-D-W"), and its USB port.
  const oakLabel = (id) => `Luxonis ${(prefs.oakNames || {})[id] || "OAK camera"}${oakPorts[id] ? ` (USB ${oakPorts[id]})` : ""}`;

  // ---------- picking cameras ----------
  async function openPicker() {
    const cams = await HandTracker.listCameras();
    const chosen = Array.isArray(prefs.multiCameras) ? prefs.multiCameras : [];
    const box = (value, label) => `<label class="multi-cam-pick"><input type="checkbox" value="${esc(value)}"${chosen.includes(value) ? " checked" : ""} /> ${esc(label)}</label>`;
    els.pickList.innerHTML = cams.map((c) => box(c.deviceId, c.label)).join("") + (oakAvailable() ? '<div id="multiCamOak" class="note">Looking for Luxonis OAK cameras…</div>' : "");
    els.dialog.hidden = false;
    updatePickButton();
    if (oakAvailable()) await listOak(box);
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
      const devices = await desktop.oak.list();
      if (!area.isConnected) return; // the picker went meanwhile
      oakPorts = Object.fromEntries(devices.map((d) => [d.id, d.name]));
      area.outerHTML = devices.length ? devices.map((d) => box(`oak:${d.id}`, oakLabel(d.id))).join("") : '<div class="note">No Luxonis OAK cameras found.</div>';
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
  async function start(deviceIds) {
    close(true);
    const cams = await HandTracker.listCameras();
    const labelOf = (id) => (isOak(id) ? oakLabel(id.slice(4)) : (cams.find((c) => c.deviceId === id) || {}).label || "Camera");
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
    els.grid.className = `multi-cam-grid n${Math.min(deviceIds.length, MAX_CAMERAS)}`;
    const model = modelOf();
    const ids = deviceIds.slice(0, MAX_CAMERAS);
    const saved = prefs.multiCameraRoles || {};
    const roles = CameraRoles.assign(ids.map((id) => ({ name: labelOf(id), saved: saved[id] })));
    tiles = ids.map((id, i) => {
      const name = `Cam ${i + 1}`;
      const el = document.createElement("div");
      el.className = "multi-cam-tile";
      el.innerHTML = `<iframe title="${esc(name)}" allow="camera"></iframe><div class="multi-cam-caption"><b>${esc(name)}</b> <select class="role" data-i="${i}" title="Where this camera is worn: its hands are named after it">${CameraRoles.options(roles[i])}</select> <span class="lbl">${esc(labelOf(id))}</span> <span class="st"></span> <button type="button" class="retry" data-i="${i}" hidden>Try again</button></div>`;
      const frame = el.querySelector("iframe");
      // Webcams are mirrored like a selfie, as in the main window (an OAK camera too).
      frame.src = isOak(id)
        ? `camera-tile.html?oak=${encodeURIComponent(id.slice(4))}&mirror=1&name=${encodeURIComponent(name)}`
        : `camera-tile.html?device=${encodeURIComponent(id)}&label=${encodeURIComponent(labelOf(id))}&mirror=1&model=${model}&name=${encodeURIComponent(name)}`;
      els.grid.appendChild(el);
      return { name, deviceId: id, role: roles[i], label: labelOf(id), frame, el, oak: isOak(id) ? id.slice(4) : null, oakState: "" };
    });
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
    const roles = CameraRoles.pick(tiles.map((t) => t.role), i, role);
    const saved = { ...(prefs.multiCameraRoles || {}) };
    tiles.forEach((t, j) => {
      t.role = roles[j];
      t.el.querySelector("select.role").value = t.role;
      saved[t.deviceId] = t.role;
    });
    setPref("multiCameraRoles", saved);
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
      t.el.querySelector(".st").textContent = !st ? "starting…" : st.error ? st.error : `${st.fps} fps · ${st.hands.length ? st.hands.join(" + ") : "no hands"}${st.recording ? " · recording" : ""}`;
      t.el.querySelector(".retry").hidden = !(t.oak && st && st.error && t.oakState !== "starting");
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
        await desktop.oak.streamStart(t.oak, { lm: model === 1 ? "full" : "lite", twoHands: true, xyz: true });
      } catch (err) {
        t.oakState = "error";
        api.oakStatus({ status: "error", message: errText(err) });
        continue;
      }
      for (let i = 0; i < 300 && tiles.includes(t) && t.oakState === "starting"; i++) await sleep(100);
    }
  }

  function onOakFrame({ id, header, jpeg }) {
    const t = tiles.find((x) => x.oak === id);
    const api = t && tileApi(t);
    if (!api || !api.oakFrame) return desktop.oak.streamShown(id);
    api
      .oakFrame(jpeg, OakSource.toResults(header), header.t)
      .catch(() => {})
      .finally(() => desktop.oak.streamShown(id));
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
    if (hadOak) desktop.oak.streamStop().catch(() => {});
    for (const off of oakOff) off();
    oakOff = [];
    if (els.card) els.card.hidden = true;
    if (els.grid) els.grid.innerHTML = "";
    HandTracker.setPaused(false);
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
  function stopRecording(show = true) {
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
      cameras: tiles.map((t) => {
        const api = tileApi(t);
        const st = api ? api.status() : null;
        return { name: t.name, role: CameraRoles.label(t.role) || "", label: t.label, fps: st ? st.fps : 0, hands: st ? st.hands : [], error: st ? st.error || "" : "" };
      }),
      note: els.note ? els.note.textContent : "",
    };
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
    els = {
      dialog: $("multiCamDialog"), pickList: $("multiCamPicks"), pickNote: $("multiCamPickNote"), start: $("multiCamStart"), cancel: $("multiCamCancel"),
      card: $("multiCamCard"), grid: $("multiCamGrid"), record: $("multiCamRecord"), closeBtn: $("multiCamClose"), note: $("multiCamNote"),
    };
    if (!els.dialog) return;
    els.pickList.addEventListener("change", updatePickButton);
    els.cancel.addEventListener("click", () => {
      els.dialog.hidden = true;
      if (restoreOak && !tiles.length) close(); // the main window's OAK camera, let go to list it
    });
    els.start.addEventListener("click", () => {
      const ids = picked();
      setPref("multiCameras", ids);
      start(ids);
    });
    els.record.addEventListener("click", () => toggleRecording());
    els.grid.addEventListener("change", (e) => {
      if (e.target.matches && e.target.matches("select.role")) setRole(Number(e.target.dataset.i), e.target.value);
    });
    els.grid.addEventListener("click", (e) => {
      if (e.target.matches && e.target.matches("button.retry")) retryOak(tiles[Number(e.target.dataset.i)]);
    });
    els.closeBtn.addEventListener("click", () => close());
  }

  global.MultiCamera = { init, openPicker, start, close, startRecording, stopRecording, remoteState, previewSources, isActive: () => tiles.length > 0, isRecording: () => recording, _tiles: () => tiles.map((t) => ({ name: t.name, role: t.role, status: tileApi(t) ? tileApi(t).status() : null })) };
})(window);
