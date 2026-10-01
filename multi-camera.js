/**
 * multi-camera.js — several live cameras at once. Each camera runs in a tile of its own
 * (camera-tile.html: its own hand tracker, so each has its own left and right hand), side
 * by side in the "Several cameras" card. Each camera has a role, where it's worn (head,
 * chest, left or right wrist: camera-roles.js), remembered for that camera. Motion capture
 * records every camera together; stopping merges them into one recording on a shared clock,
 * with each hand named after its camera's role ("Head Left", "Chest Right"…, or "Cam 1 Left"
 * for a camera with no role), which then exports like any recording.
 *
 *   MultiCamera.init({ prefs, setPref, app: HandTrackerApp, modelOf: () => 0 | 1 });
 *   await MultiCamera.openPicker();          // choose cameras, then start
 *   await MultiCamera.start(deviceIds);      // (the picker's Start; deviceIds may repeat, for checks)
 *   MultiCamera.close();
 */

(function (global) {
  const MAX_CAMERAS = 4;
  const STATUS_MS = 500;

  let prefs = {}, setPref = () => {}, app = null, modelOf = () => 1;
  let els = {};
  let tiles = []; // { name, deviceId, role, label, frame, el }
  let statusTimer = null;
  let recording = false;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---------- picking cameras ----------
  async function openPicker() {
    const cams = await HandTracker.listCameras();
    const chosen = Array.isArray(prefs.multiCameras) ? prefs.multiCameras : [];
    els.pickList.innerHTML = cams.length
      ? cams.map((c) => `<label class="multi-cam-pick"><input type="checkbox" value="${esc(c.deviceId)}"${chosen.includes(c.deviceId) ? " checked" : ""} /> ${esc(c.label)}</label>`).join("")
      : '<div class="note">No cameras found.</div>';
    els.pickNote.textContent = cams.length < 2 ? "Only one camera is connected: plug in another to track several at once." : `Pick up to ${MAX_CAMERAS}.`;
    els.dialog.hidden = false;
    updatePickButton();
  }

  function picked() {
    return [...els.pickList.querySelectorAll("input:checked")].map((i) => i.value);
  }
  function updatePickButton() {
    const n = picked().length;
    els.start.disabled = n < 2 || n > MAX_CAMERAS;
    els.start.textContent = n > MAX_CAMERAS ? `At most ${MAX_CAMERAS} cameras` : `Start ${n >= 2 ? n : ""} cameras`.replace("  ", " ");
  }

  // ---------- the tiles ----------
  async function start(deviceIds) {
    close();
    const cams = await HandTracker.listCameras();
    const labelOf = (id) => (cams.find((c) => c.deviceId === id) || {}).label || "Camera";
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
      el.innerHTML = `<iframe title="${esc(name)}" allow="camera"></iframe><div class="multi-cam-caption"><b>${esc(name)}</b> <select class="role" data-i="${i}" title="Where this camera is worn: its hands are named after it">${CameraRoles.options(roles[i])}</select> <span class="lbl">${esc(labelOf(id))}</span> <span class="st"></span></div>`;
      const frame = el.querySelector("iframe");
      // Webcams are mirrored like a selfie, as in the main window.
      frame.src = `camera-tile.html?device=${encodeURIComponent(id)}&mirror=1&model=${model}&name=${encodeURIComponent(name)}`;
      els.grid.appendChild(el);
      return { name, deviceId: id, role: roles[i], label: labelOf(id), frame, el };
    });
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
    }
  }

  function close() {
    if (recording) stopRecording(false);
    clearInterval(statusTimer);
    for (const t of tiles) t.el.remove(); // a tile's page going away releases its camera
    tiles = [];
    if (els.card) els.card.hidden = true;
    if (els.grid) els.grid.innerHTML = "";
    HandTracker.setPaused(false);
  }

  // ---------- motion capture from every camera ----------
  async function toggleRecording() {
    if (!recording) {
      const apis = tiles.map(tileApi);
      if (apis.some((a) => !a)) return (els.note.textContent = "Wait for every camera to start.");
      if (app.readyForNewMotion && !app.readyForNewMotion()) return; // an unexported capture is kept unless you say otherwise
      await Promise.all(apis.map((a) => a.ready.catch(() => {})));
      for (const a of apis) if (!a.status().error) a.startRecording();
      recording = true;
      els.record.textContent = "Stop Motion Capture";
      els.record.classList.add("recording");
      els.note.textContent = "Recording every camera's hands…";
      return;
    }
    stopRecording(true);
  }

  function stopRecording(show) {
    recording = false;
    els.record.textContent = "Start Motion Capture";
    els.record.classList.remove("recording");
    const parts = tiles
      .map((t) => {
        const api = tileApi(t);
        return api && api.status().recording ? { tile: t, data: api.stopRecording() } : null;
      })
      .filter(Boolean);
    if (!show) return;
    const merged = merge(parts);
    if (!merged) return (els.note.textContent = "No hands were recorded.");
    els.note.textContent = `Recorded ${merged.hands.length} hand${merged.hands.length === 1 ? "" : "s"} from ${parts.length} camera${parts.length === 1 ? "" : "s"}: export below.`;
    app.showMotionExport(merged);
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
    els.cancel.addEventListener("click", () => (els.dialog.hidden = true));
    els.start.addEventListener("click", () => {
      const ids = picked();
      setPref("multiCameras", ids);
      start(ids);
    });
    els.record.addEventListener("click", () => toggleRecording());
    els.grid.addEventListener("change", (e) => {
      if (e.target.matches && e.target.matches("select.role")) setRole(Number(e.target.dataset.i), e.target.value);
    });
    els.closeBtn.addEventListener("click", close);
  }

  global.MultiCamera = { init, openPicker, start, close, isActive: () => tiles.length > 0, _tiles: () => tiles.map((t) => ({ name: t.name, role: t.role, status: tileApi(t) ? tileApi(t).status() : null })) };
})(window);
