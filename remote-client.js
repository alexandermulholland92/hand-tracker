/**
 * remote-client.js — the remote recording page (remote-client.html): start and stop motion
 * capture on a computer running Hand Tracker with Remote recording on (a camera rig on a
 * Raspberry Pi, say). Before the cameras start it lists the ones the computer can start (any
 * kind: OAK cameras and webcams), to pick and give roles; the mode says which it needs (Ego:
 * all four roles; Stereo: a head camera, the others picked too; Freeform: any). Then each
 * camera's live preview, its role, turn and flip, the take details and Start/Stop. Hidden until
 * the title is tapped five times: Sentry mode (watching the cameras for movement, with boxes
 * over each preview to leave parts of the picture out; while it's on, the hands aren't tracked
 * unless it's asked to).
 *
 * Where it runs, and how it reaches the computer:
 *   - served by the computer itself (electron/remote-record.js), in any browser: plain requests
 *     to its own address, with the key from the QR code (#k=…, kept in this browser) unless
 *     it's opened over Tailscale;
 *   - in the Android app and the Windows, Mac and Linux app, as remote-client.html?rig=<name>:<port>
 *     (from remote.html): the app makes the requests (Remote.rigRequest on Android,
 *     desktop.rig.request on Windows, Mac and Linux), since a page can't reach a device on your
 *     network by itself; a key comes with the address the same way and is kept per computer.
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  // "pi:47821", "100.101.2.3:47821", "[fd7a::1]:47821" (see remote-launcher.js).
  const rig = /^[a-z0-9.\-[\]:]{1,260}$/i.test(params.get("rig") || "") ? params.get("rig") : "";
  const cap = window.Capacitor;
  const onPhoneApp = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const nativeRemote = rig && onPhoneApp ? (typeof cap.registerPlugin === "function" ? cap.registerPlugin("Remote") : cap.Plugins && cap.Plugins.Remote) : null;
  const desktopRig = rig && window.desktop && window.desktop.rig ? window.desktop.rig : null;
  if (rig) $("back").hidden = false;

  // The key from the QR code's address (#k=…), kept for next time (per computer in the apps)
  // and taken out of the address bar.
  const KEY_NAME = rig ? `hand-tracker-remote-key:${rig.toLowerCase()}` : "hand-tracker-remote-key";
  let key = "";
  const fromHash = /[#&]k=([A-Za-z0-9_-]{8,64})/.exec(location.hash);
  try {
    if (fromHash) localStorage.setItem(KEY_NAME, fromHash[1]);
    key = fromHash ? fromHash[1] : localStorage.getItem(KEY_NAME) || "";
  } catch {
    key = fromHash ? fromHash[1] : "";
  }
  if (fromHash) history.replaceState(null, "", location.pathname + location.search);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fromBase64 = (b64) => Uint8Array.from(atob(b64 || ""), (c) => c.charCodeAt(0));
  const answer = (status, type, bytes) => ({ status, type: type || "", bytes, json: () => JSON.parse(new TextDecoder().decode(bytes)) });

  // One request to the computer -> { status, type, bytes, json() }.
  async function call(path, { method = "GET", body = null } = {}) {
    if (desktopRig) {
      const r = await desktopRig.request({ rig, path, method, body, key });
      return answer(r.status, r.type, r.body instanceof Uint8Array ? r.body : new Uint8Array(r.body || []));
    }
    if (nativeRemote) {
      const r = await nativeRemote.rigRequest({ rig, path, method, body: body || "", key });
      return answer(r.status, r.type, fromBase64(r.body));
    }
    if (rig) throw new Error("app only");
    const res = await fetch(path, { method, cache: "no-store", headers: { "X-Key": key, ...(body ? { "Content-Type": "application/json" } : {}) }, body });
    return answer(res.status, res.headers.get("content-type"), new Uint8Array(await res.arrayBuffer()));
  }
  const api = async (path, opts) => {
    const r = await call(path, opts);
    if (r.status === 401) throw Object.assign(new Error("key"), { auth: true });
    return r;
  };
  const post = async (body) => (await api("/api/command", { method: "POST", body: JSON.stringify(body) })).json();

  const clock = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  };
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const listOf = (words) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0] || "");

  // What a button did; it goes after a few seconds (the status line says how things are).
  let sayTimer = null;
  const say = (text, err = false) => {
    clearTimeout(sayTimer);
    $("message").textContent = text || "";
    $("message").className = err ? "err" : "";
    if (text && !err) sayTimer = setTimeout(() => say(""), 5000);
  };

  let state = null, sending = false, shownCams = -1;
  const loops = [];

  // ---------- roles ----------
  const ROLES = [["head", "Head"], ["chest", "Chest"], ["wrist_left", "Left wrist"], ["wrist_right", "Right wrist"]];
  const roleLabel = (id) => (ROLES.find((r) => r[0] === id) || [])[1] || "";
  const roleOptions = (selected) => `<option value=""${selected ? "" : " selected"}>No role</option>` + ROLES.map(([id, label]) => `<option value="${id}"${id === selected ? " selected" : ""}>${label}</option>`).join("");
  // The grid by role, as in Hand Tracker: head, chest, left wrist, right wrist (two to a row; a
  // single camera takes the whole grid); a camera with no role takes the first free role's place.
  // The roles with no camera are listed under it.
  function blocks(roles) {
    const ids = ROLES.map((r) => r[0]);
    const slots = roles.map((r) => ids.indexOf(r));
    const used = new Set(slots.filter((b) => b >= 0));
    slots.forEach((b, i) => {
      if (b >= 0) return;
      const free = ids.findIndex((_, k) => !used.has(k));
      slots[i] = free >= 0 ? free : ids.length + i;
      if (free >= 0) used.add(free);
    });
    return { slots, empty: ids.map((_, k) => k).filter((k) => !used.has(k)) };
  }

  // ---------- the mode ----------
  const MODE_NOTES = {
    ego: "Ego: all four cameras, Head, Chest, Left wrist and Right wrist.",
    stereo: "Stereo: a Head camera; any other cameras picked record with it.",
    freeform: "Freeform: any of the cameras picked, with any roles.",
  };
  $("modes").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (b && state && state.mode !== b.dataset.mode) command("mode", { mode: b.dataset.mode });
  });

  // ---------- the cameras the computer can start ----------
  let lastScanAsked = 0;
  function scan() {
    lastScanAsked = Date.now();
    command("scan", {}, { quiet: true });
  }
  $("scanBtn").addEventListener("click", scan);
  $("camRows").addEventListener("change", (e) => {
    const id = e.target.dataset.id;
    if (!id) return;
    if (e.target.matches("input[type=checkbox]")) command("pick", { pick: { id, use: e.target.checked } }, { quiet: true });
    else if (e.target.matches("select")) command("pick", { pick: { id, role: e.target.value } }, { quiet: true });
  });
  let shownRows = "";
  function renderCameras(s) {
    const a = s.available || {};
    const list = a.cameras || [];
    // Shown while the cameras run too (which ones they are), to change once they're stopped.
    const busy = !!(s.running || s.recording || s.pending);
    // Rebuilt only when something changed (so a select being used isn't swapped under a finger).
    const sig = JSON.stringify(list) + busy;
    if (sig !== shownRows && !$("camRows").contains(document.activeElement)) {
      shownRows = sig;
      $("camRows").innerHTML = list.map((c) =>
        `<div class="camrow"><label><input type="checkbox" data-id="${esc(c.id)}"${c.use ? " checked" : ""}${c.present && !busy ? "" : " disabled"} /> ` +
        `<span>${esc(c.label)}${c.present ? "" : ' <span class="gone">not plugged in</span>'}</span></label>` +
        `<select data-id="${esc(c.id)}" aria-label="Role of ${esc(c.label)}"${busy ? " disabled" : ""}>${roleOptions(c.role)}</select></div>`).join("");
    }
    const note = $("camNote");
    note.className = "";
    if (busy) note.textContent = s.recording ? "Recording with the cameras ticked. Stop recording, then Stop cameras, to choose others." : "The cameras ticked are on. Stop cameras to choose others (each one's role can be changed under its picture).";
    else if (a.scanning) note.textContent = "Looking for cameras…";
    else if (!list.length) note.textContent = a.note || "No cameras found. Plug one in, then Refresh.";
    else note.textContent = a.note || "Tick the cameras to start; each one's role is where it's worn.";
    $("scanBtn").disabled = busy || !!a.scanning || sending;
  }

  // ---------- take details: kept by Hand Tracker (every phone sees the same), sent as typed ----------
  const FIELDS = ["contributor", "location", "task"];
  const LABELS = { contributor: "Contributor", location: "Location", task: "Task" };
  const NOTE = { required: "All three are needed to start recording. Each take is named after them and its length, and keeps them in its file.", optional: "Each take is named after these and its length, and keeps them in its file." };
  const LOCKED_NOTE = "Locked: this take is named after these, and they can't be changed for it.";
  let edits = 0, sentEdits = 0, detailsTimer = null, locked = false, required = true, savedNote = false;
  const readDetails = () => Object.fromEntries(FIELDS.map((k) => [k, $(k).value.trim()]));
  const showNote = () => ($("detailsNote").textContent = locked ? LOCKED_NOTE : savedNote ? "Saved: the next take is named after these." : NOTE[required ? "required" : "optional"]);
  // All three are needed to start recording (unless that's turned off): the empty ones are
  // marked, and the first gets the cursor.
  function markMissing(missing) {
    FIELDS.forEach((k) => $(k).classList.toggle("missing", missing.includes(k)));
    if (missing.length) $(missing[0]).focus();
    return listOf(missing.map((k) => LABELS[k]));
  }
  // From Start recording until the take is saved the details are the take's (Hand Tracker says
  // so); the camera previews and controls stay as they are.
  function lockDetails(on) {
    if (on === locked) return;
    locked = on;
    FIELDS.forEach((k) => {
      $(k).disabled = on;
      if (on) $(k).classList.remove("missing");
    });
    savedNote = false;
    showNote();
  }
  // Hand Tracker's details into the boxes, except while some are typed and not yet sent.
  function fillDetails(d) {
    if (!d || edits !== sentEdits) return;
    for (const k of FIELDS) if (document.activeElement !== $(k) && $(k).value !== (d[k] || "")) $(k).value = d[k] || "";
  }
  async function sendDetails() {
    clearTimeout(detailsTimer);
    if (edits === sentEdits) return true;
    const upTo = edits;
    try {
      const res = await post({ action: "details", details: readDetails() }).catch(() => ({}));
      sentEdits = upTo;
      // A take started meanwhile (from another phone, say): it keeps its details, which come back here.
      if (res.locked) {
        lockDetails(true);
        return true;
      }
      if (edits === sentEdits && !locked) {
        savedNote = true;
        showNote();
      }
      return true;
    } catch {
      $("detailsNote").textContent = "Not saved yet: can't reach Hand Tracker.";
      return false;
    }
  }
  FIELDS.forEach((k, i) => {
    $(k).addEventListener("input", () => {
      if ($(k).value.trim()) $(k).classList.remove("missing");
      if (!FIELDS.some((f) => $(f).classList.contains("missing")) && /^Fill in/.test($("message").textContent)) say("");
      edits++;
      clearTimeout(detailsTimer);
      detailsTimer = setTimeout(sendDetails, 700);
    });
    $(k).addEventListener("change", sendDetails);
    $(k).addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (FIELDS[i + 1]) $(FIELDS[i + 1]).focus();
      else $(k).blur();
    });
  });
  // Hidden: tapping "Take details" five times in a row shows whether they're needed before
  // recording, and turns that on or off (for every phone; Hand Tracker keeps it).
  let taps = [];
  $("detailsTitle").addEventListener("click", () => {
    const now = Date.now();
    taps = taps.filter((t) => now - t < 3000).concat(now);
    if (taps.length >= 5) {
      taps = [];
      $("requiredRow").hidden = false;
    }
  });
  $("requiredBtn").addEventListener("click", () => command("settings", { settings: { detailsRequired: !required } }));

  // The OAK cameras' pictures on the computer's own screen: off leaves its processor for the
  // hands (a Raspberry Pi with four cameras, nobody looking at its screen).
  let screenOn = true;
  $("screenBtn").addEventListener("click", () => command("settings", { settings: { screenPictures: !screenOn } }));

  // Each camera's video saved with the take (beside its motion capture), with sound or not.
  let videoOn = true, soundOn = true;
  $("videoBtn").addEventListener("click", () => command("settings", { settings: { video: !videoOn } }));
  $("soundBtn").addEventListener("click", () => command("settings", { settings: { sound: !soundOn } }));
  // ...and its quality: how much of the picture's detail is kept, and so how big the files are.
  $("qualitySel").addEventListener("change", () => command("settings", { settings: { videoQuality: $("qualitySel").value } }));
  const QUALITY_NOTES = {
    low: " Small files: under half the size of Standard, with a softer picture.",
    standard: "",
    high: " High: sharper, about twice the size of Standard.",
    best: " Best: the sharpest, about four times the size of Standard.",
  };

  // ---------- Sentry mode (sentry.js on the computer) ----------
  // Hidden: tapping the page's title five times (or Ctrl+Alt+S) shows it, on every page the
  // computer serves, and hides it again. Then: on or off (on starts the cameras if they're off),
  // ignoring pets and animals, tracking hands while it's on, the boxes over each camera's preview
  // (tap one to leave it out of what's watched; the grid and the sensitivity for every camera),
  // what an alert saves, the alerts on this phone (in the Hand Tracker app) and through ntfy, and
  // the alerts themselves, each with its photo (a slice of the takes folder, as the takes come).
  let sentry = null; // the computer's Sentry state (null: it has none)
  let titleTaps = [];
  // (A Hand Tracker from before Sentry mode was set up here says nothing while it's hidden.)
  const toggleSentry = () => {
    if (!state) return;
    if (!sentry || (sentry.shown === undefined && !sentry.armed)) return say(`Sentry mode needs a newer Hand Tracker on ${state.host || "this computer"}: update it there.`, true);
    command("sentry", { sentry: { shown: !(sentry.shown || sentry.armed) } }, { quiet: true });
  };
  $("title").addEventListener("click", () => {
    const now = Date.now();
    titleTaps = titleTaps.filter((t) => now - t < 3000).concat(now);
    if (titleTaps.length >= 5) {
      titleTaps = [];
      toggleSentry();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      toggleSentry();
    }
  });
  const sentryCommand = (c, quiet = true) => command("sentry", { sentry: c }, { quiet });
  // Boxes shown over the previews (this page only: hide them to see the pictures).
  const BOXES_KEY = "hand-tracker-sentry-boxes";
  let boxesOn = true;
  try {
    boxesOn = localStorage.getItem(BOXES_KEY) !== "off";
  } catch {}
  const setToggle = (id, on, disabled = false) => {
    const b = $(id);
    b.textContent = on ? "On" : "Off";
    b.classList.toggle("on", !!on);
    b.setAttribute("aria-pressed", String(!!on));
    b.disabled = disabled;
  };
  for (let n = 1; n <= 9; n++) $("sentryRows").insertAdjacentHTML("beforeend", `<option value="${n}">${n}</option>`);
  for (let n = 1; n <= 16; n++) $("sentryCols").insertAdjacentHTML("beforeend", `<option value="${n}">${n}</option>`);
  $("sentryBtn").addEventListener("click", () => sentryCommand({ armed: !(sentry && sentry.armed) }, false));
  $("sentryPets").addEventListener("click", () => sentryCommand({ ignoreAnimals: !(sentry && sentry.ignoreAnimals) }));
  $("sentryHands").addEventListener("click", () => sentryCommand({ handTracking: !(sentry && sentry.handTracking) }, false));
  for (const [id, k] of [["sentryPhoto", "photo"], ["sentryVideo", "video"], ["sentrySound", "sound"]]) {
    $(id).addEventListener("click", () => sentryCommand({ [k]: !(sentry && sentry[k]) }));
  }
  $("sentryRows").addEventListener("change", () => sentryCommand({ rows: Number($("sentryRows").value) }));
  $("sentryCols").addEventListener("change", () => sentryCommand({ cols: Number($("sentryCols").value) }));
  $("sentrySens").addEventListener("change", () => sentryCommand({ sensitivity: $("sentrySens").value }));
  $("sentryAll").addEventListener("click", () => sentryCommand({ watchAll: true }, false));
  $("sentryBoxes").addEventListener("click", () => {
    boxesOn = !boxesOn;
    try {
      localStorage.setItem(BOXES_KEY, boxesOn ? "on" : "off");
    } catch {}
    if (state) renderSentry(state);
  });
  $("sentryNtfy").addEventListener("click", () => sentryCommand({ ntfy: { on: !(sentry && sentry.ntfy && sentry.ntfy.on) } }));
  $("sentryNtfyPhoto").addEventListener("click", () => sentryCommand({ ntfy: { photo: !(sentry && sentry.ntfy && sentry.ntfy.photo) } }));
  $("sentryServerSave").addEventListener("click", () => {
    const v = $("sentryServer").value.trim() || "https://ntfy.sh";
    if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(v)) return say("That isn't a web address (https://…).", true);
    sentryCommand({ ntfy: { server: v } }, false);
  });
  $("sentryTest").addEventListener("click", () => sentryCommand({ ntfy: { test: true } }, false));
  $("sentryNewTopic").addEventListener("click", () => {
    if (confirm("Make a new topic? Phones subscribed to the old one stop getting alerts until they subscribe to the new one.")) sentryCommand({ ntfy: { newTopic: true } }, false);
  });

  // Alerts on this phone, from the Hand Tracker app (SentryWatchService.java): this computer
  // among the ones it watches, or not.
  const watcher = rig && onPhoneApp ? (typeof cap.registerPlugin === "function" ? cap.registerPlugin("SentryWatch") : cap.Plugins && cap.Plugins.SentryWatch) : null;
  let watching = null; // null: not known yet
  async function lookAtWatcher() {
    try {
      const s = await watcher.status();
      watching = !!s.on && (s.rigs || []).includes(rig.toLowerCase());
    } catch {
      watching = false;
    }
    if (state) renderSentry(state);
  }
  if (watcher) {
    $("sentryWatchRow").hidden = false;
    lookAtWatcher();
    $("sentryWatch").addEventListener("click", async () => {
      try {
        const s = await watcher.status();
        const me = rig.toLowerCase();
        const others = (s.on ? s.rigs || [] : []).filter((r) => r !== me);
        const keyOf = (r) => {
          try {
            return localStorage.getItem(`hand-tracker-remote-key:${r}`) || "";
          } catch {
            return "";
          }
        };
        const list = (watching ? others : [...others, me]).map((r) => ({ rig: r, key: keyOf(r) }));
        if (list.length) await watcher.start({ rigs: list });
        else await watcher.stop();
        say(watching ? "This phone no longer gets this computer's alerts." : "This phone gets this computer's alerts now, as notifications.");
      } catch (err) {
        say(String((err && err.message) || err), true);
      }
      lookAtWatcher();
    });
  }

  // Deleting: an alert (its photo and video too), or every Sentry photo and video on the
  // computer, older ones included. Two taps: the first arms it for a few seconds.
  let delArmed = "", delArmedAt = 0;
  const isArmed = (what) => delArmed === what && Date.now() - delArmedAt < 4000;
  async function sentryDelete(what) {
    if (!isArmed(what)) {
      delArmed = what;
      delArmedAt = Date.now();
      if (state) renderSentry(state);
      setTimeout(() => state && renderSentry(state), 4100);
      return;
    }
    delArmed = "";
    await sentryCommand(what === "all" ? { deleteAll: true } : { deleteAlerts: [what] }, false);
    loadTakes();
  }
  $("sentryDelAll").addEventListener("click", () => sentryDelete("all"));
  $("sentryAlerts").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-del]");
    if (b && !b.disabled) sentryDelete(b.dataset.del);
  });

  const sentryPhotos = new Map(); // photo's file name -> its picture here (or "" while it comes)
  async function sentryPhoto(name) {
    sentryPhotos.set(name, "");
    try {
      const r = await api(`/api/take?f=${encodeURIComponent(name)}&at=0`);
      if (r.status === 200 && r.bytes && r.bytes.length) sentryPhotos.set(name, URL.createObjectURL(new Blob([r.bytes], { type: "image/jpeg" })));
    } catch {
      sentryPhotos.delete(name); // tried again next time
    }
    if (state) renderSentry(state);
  }

  // The boxes over one camera's picture: rows by columns, each left out or watched, and moving.
  function drawBoxes(el, cam) {
    const show = !!(sentry && sentry.rows && (sentry.shown || sentry.armed) && boxesOn && cam);
    el.hidden = !show;
    if (!show) return;
    const sig = `${sentry.rows}x${sentry.cols}`;
    if (el.dataset.grid !== sig) {
      el.dataset.grid = sig;
      el.style.gridTemplateColumns = `repeat(${sentry.cols}, 1fr)`;
      el.style.gridTemplateRows = `repeat(${sentry.rows}, 1fr)`;
      el.innerHTML = Array.from({ length: sentry.rows * sentry.cols }, (_, n) => `<button type="button" data-cell="${n}" aria-pressed="false"></button>`).join("");
    }
    el.dataset.camera = String(cam.index);
    const off = new Set(cam.off || []), hot = new Set(cam.hot || []);
    for (const b of el.children) {
      const n = Number(b.dataset.cell);
      const isOff = b.dataset.pending ? b.dataset.pending === "off" : off.has(n);
      if (b.dataset.pending && b.dataset.pending === (off.has(n) ? "off" : "on")) delete b.dataset.pending; // the computer has it now
      b.classList.toggle("off", isOff);
      b.classList.toggle("hot", !isOff && hot.has(n));
      b.setAttribute("aria-pressed", String(isOff));
      b.title = isOff ? "Not watched: tap to watch this box" : "Watched: tap to leave this box out";
    }
  }
  // A box tapped: left out, or watched again (shown at once; the computer confirms).
  function tapBox(b) {
    const el = b.parentElement;
    const camera = Number(el.dataset.camera), cell = Number(b.dataset.cell);
    if (!Number.isInteger(camera) || !Number.isInteger(cell)) return;
    const off = !b.classList.contains("off");
    b.dataset.pending = off ? "off" : "on";
    b.classList.toggle("off", off);
    b.classList.remove("hot");
    sentryCommand({ box: { camera, cell, off } });
  }

  function renderSentry(s) {
    sentry = s.sentry || null;
    const st = sentry;
    const open = !!(st && (st.shown || st.armed));
    $("sentryPanel").hidden = !open;
    const cams = s.cameras || [];
    const camOf = (i) => (st && Array.isArray(st.cameras) ? st.cameras.find((c) => c.index === i) : null);
    cams.forEach((c, i) => {
      const el = document.querySelector(`#cam${i} .boxes`);
      if (el) drawBoxes(el, open ? camOf(i) : null);
    });
    drawBoxes($("fullBoxes"), open && full ? camOf(full.i) : null);
    if (!open) return;
    const where = s.host || "the computer";
    const newer = !!st.rows; // a Hand Tracker from before Sentry's settings came to this page has only on and off
    setToggle("sentryBtn", st.armed, sending);
    $("sentryNote").textContent = !newer
      ? (st.armed ? `Watching ${where}'s cameras for movement. ` : `Off. `) + `Update Hand Tracker on ${where} to set Sentry up from here.`
      : st.note || "";
    $("sentrySettings").hidden = !newer;
    if (newer) {
      setToggle("sentryPets", st.ignoreAnimals, sending);
      // (A Hand Tracker from before this switch tracks hands all the time.)
      $("sentryHandsBox").hidden = typeof st.handTracking !== "boolean";
      setToggle("sentryHands", st.handTracking, sending);
      setToggle("sentryPhoto", st.photo, sending);
      setToggle("sentryVideo", st.video, sending);
      setToggle("sentrySound", st.sound, sending || !st.video);
      setToggle("sentryBoxes", boxesOn);
      $("sentryBoxes").disabled = false;
      for (const [id, v] of [["sentryRows", st.rows], ["sentryCols", st.cols], ["sentrySens", st.sensitivity]]) {
        if (document.activeElement !== $(id)) $(id).value = String(v);
        $(id).disabled = sending;
      }
      const left = (st.cameras || []).reduce((n, c) => n + (c.off || []).length, 0);
      $("sentryAll").disabled = sending || !left;
      if (watcher) setToggle("sentryWatch", !!watching, watching === null);
      const n = st.ntfy || {};
      setToggle("sentryNtfy", n.on, sending);
      $("sentryNtfyBox").hidden = !n.on;
      if (n.on) {
        const server = String(n.server || "https://ntfy.sh").replace(/\/+$/, "");
        $("sentryTopic").textContent = n.topic || "";
        $("sentryServerName").textContent = server.replace(/^https?:\/\//, "");
        const link = $("sentryLink");
        link.href = `${server}/${encodeURIComponent(n.topic || "")}`;
        link.textContent = link.href;
        if (document.activeElement !== $("sentryServer")) $("sentryServer").value = server;
        setToggle("sentryNtfyPhoto", n.photo, sending);
        for (const id of ["sentryTest", "sentryNewTopic", "sentryServerSave"]) $(id).disabled = sending;
      }
    }
    const events = st.events || [];
    for (const e of events) if (e.photo && !sentryPhotos.has(e.photo)) sentryPhoto(e.photo);
    const p = (n) => String(n).padStart(2, "0");
    $("sentryAlerts").innerHTML = events.length
      ? events
          .map((e) => {
            const t = new Date(e.at);
            const when = `${t.toLocaleDateString()} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
            const img = e.photo && sentryPhotos.get(e.photo) ? `<img src="${esc(sentryPhotos.get(e.photo))}" alt="" />` : "";
            const video = e.video ? `<br />Video: ${esc(e.video)}${e.seconds ? ` (${e.seconds} s)` : ""}` : "";
            const problem = e.problem ? `<br /><span class="err">${esc(e.problem)}</span>` : "";
            const armed = isArmed(e.id);
            const del = st.canDelete
              ? `<button type="button" class="small del${armed ? " armed" : ""}" data-del="${esc(e.id)}"${sending ? " disabled" : ""} title="Delete this alert, with its photo and video">${armed ? "Tap again" : "Delete"}</button>`
              : "";
            return `<div class="alert">${img}<div><b>${esc(e.camera)}</b><div class="meta">${esc(when)}${video}${problem}</div></div>${del}</div>`;
          })
          .join("")
      : '<div class="muted">No alerts yet.</div>';
    const delAll = $("sentryDelAll");
    delAll.hidden = !st.canDelete;
    delAll.disabled = sending;
    delAll.classList.toggle("armed", isArmed("all"));
    delAll.textContent = isArmed("all") ? `Tap again to delete them all from ${where}` : "Delete every Sentry photo and video";
  }

  // ---------- the takes on the computer: download them, then delete them from it ----------
  // Hand Tracker lists the takes in its remote recording folder (Hand Tracker on a phone keeps
  // its own, so none are listed there). The ones ticked come to this device a slice at a time
  // (as the apps can carry them too), each file checked by its length and a CRC32: in a browser
  // as one .zip in its downloads; in the Android app into Documents/Hand Tracker/Takes from
  // <computer>; in the Windows, Mac and Linux app into a folder picked for them. Only then can they
  // be deleted from the computer (two taps), which first checks every file against the same
  // CRC32s: one that didn't arrive whole, or changed since, stays.
  let takes = [], takesHere = false, takesAsked = false, takesBusy = false, takesArmed = 0, lastTakeAt = null;
  const picked = new Set();
  const got = new Map(); // take id -> [{ name, size, crc }]: on this device, whole
  const failed = new Map(); // take id -> why it didn't come
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (bytes, crc = 0) => {
    let c = ~crc >>> 0;
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
  };
  const sizeText = (n) => (n < 1e6 ? `${Math.max(1, Math.round(n / 1e3))} KB` : `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`);
  const whenText = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const hostName = () => (state && state.host) || "the computer";
  const localStamp = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}-${String(d.getMinutes()).padStart(2, "0")}`;
  const concat = (parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  const toBase64 = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const takesNote = (text, err = false) => {
    $("takesNote").textContent = text || "";
    $("takesNote").className = err ? "err" : "";
  };

  // A .zip of files as they are (no compression: motion files are a small part of a phone's room).
  function zip(entries) {
    const enc = new TextEncoder(), parts = [], central = [];
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.name), crc = crc32(e.data);
      const head = (size, sig) => {
        const v = new DataView(new ArrayBuffer(size));
        v.setUint32(0, sig, true);
        return v;
      };
      const local = head(30, 0x04034b50);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // names in UTF-8
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, e.data.length, true);
      local.setUint32(22, e.data.length, true);
      local.setUint16(26, name.length, true);
      parts.push(new Uint8Array(local.buffer), name, e.data);
      const c = head(46, 0x02014b50);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(12, time, true);
      c.setUint16(14, date, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, e.data.length, true);
      c.setUint32(24, e.data.length, true);
      c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + e.data.length;
    }
    const size = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
  }

  // Where the downloaded files go: { where, file(name) -> { write(bytes), close() }, finish() }
  // (null if no folder was picked).
  async function takeSaver() {
    const host = hostName().replace(/[^\w.-]+/g, "_").slice(0, 60) || "computer";
    const files = nativeRemote ? (typeof cap.registerPlugin === "function" ? cap.registerPlugin("Filesystem") : cap.Plugins && cap.Plugins.Filesystem) : null;
    if (files) {
      const folder = `Hand Tracker/Takes from ${host}`;
      return {
        where: `Documents/${folder}`,
        file(name) {
          const at = `${folder}/${name}`;
          let first = true;
          return {
            async write(bytes) {
              if (first) await files.writeFile({ path: at, directory: "DOCUMENTS", data: toBase64(bytes), recursive: true });
              else await files.appendFile({ path: at, directory: "DOCUMENTS", data: toBase64(bytes) });
              first = false;
            },
            async close() {
              if (first) await files.writeFile({ path: at, directory: "DOCUMENTS", data: "", recursive: true });
            },
          };
        },
        async finish() {},
      };
    }
    if (desktopRig && window.desktop.chooseFolder && window.desktop.saveFilesTo) {
      const pick = await window.desktop.chooseFolder(`Choose a folder for the takes from ${hostName()}`);
      if (!pick || pick.canceled) return null;
      const saver = {
        where: "",
        file(name) {
          const parts = [];
          return {
            async write(bytes) {
              parts.push(bytes);
            },
            async close() {
              const ext = name.replace(/^.*\./, "").toLowerCase();
              const r = await window.desktop.saveFilesTo(pick.token, { baseName: name.slice(0, -(ext.length + 1)), files: [{ format: ext, suffix: "", ext, data: concat(parts) }] });
              const res = (r.results || [])[0];
              if (!res || !res.ok) throw new Error((res && res.error) || "it wasn't saved");
              saver.where = r.dir;
            },
          };
        },
        async finish() {},
      };
      return saver;
    }
    const entries = [];
    const saver = {
      zip: true,
      where: "",
      file(name) {
        const parts = [];
        return {
          async write(bytes) {
            parts.push(bytes);
          },
          async close() {
            entries.push({ name, data: concat(parts) });
          },
        };
      },
      async finish(label) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(zip(entries));
        a.download = label;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        saver.where = `${label}, in this device's downloads`;
      },
    };
    return saver;
  }

  async function loadTakes() {
    try {
      const r = await api("/api/takes");
      takesHere = r.status === 200;
      if (takesHere) {
        const list = r.json();
        takes = list.takes || [];
        const ids = new Set(takes.map((t) => t.id));
        for (const id of [...picked]) if (!ids.has(id)) picked.delete(id);
        for (const id of [...got.keys()]) if (!ids.has(id)) got.delete(id);
        if (list.more) takesNote(`The newest ${takes.length} are listed (${list.more} older not).`);
      }
    } catch {
      // the status line says when the computer can't be reached
    }
    renderTakes();
  }

  function renderTakes() {
    $("takesPanel").hidden = !takesHere;
    if (!takesHere) return;
    const host = hostName();
    $("takesTitle").textContent = `Takes on ${host}`;
    $("takeRows").innerHTML = takes.length
      ? takes.map((t) => {
        const kinds = [...new Set(t.files.map((f) => f.name.replace(/^.*\./, "").toUpperCase()))].join(", ");
        const status = got.has(t.id) ? ' · <span class="ok">✓ on this device</span>' : failed.has(t.id) ? ` · <span class="err">${esc(failed.get(t.id))}</span>` : "";
        return `<div class="takerow"><label><input type="checkbox" data-id="${esc(t.id)}"${picked.has(t.id) ? " checked" : ""}${takesBusy ? " disabled" : ""} /> <span>${esc(t.id)}</span></label>` +
          `<div class="meta">${esc(whenText(t.at))} · ${esc(sizeText(t.size))} · ${esc(kinds)}${status}</div></div>`;
      }).join("")
      : '<div class="muted">None yet: each take is saved here when recording stops.</div>';
    const all = $("takesAll");
    all.checked = !!takes.length && takes.every((t) => picked.has(t.id));
    all.indeterminate = !all.checked && takes.some((t) => picked.has(t.id));
    all.disabled = takesBusy || !takes.length;
    const n = takes.filter((t) => picked.has(t.id)).length;
    const ready = takes.filter((t) => picked.has(t.id) && got.has(t.id)).length;
    $("takesGet").disabled = takesBusy || !n;
    $("takesGet").textContent = n ? `Download ${n} take${n === 1 ? "" : "s"}` : "Download";
    $("takesRefresh").disabled = takesBusy;
    const del = $("takesDel");
    del.hidden = !ready;
    del.disabled = takesBusy;
    const armed = Date.now() - takesArmed < 4000;
    del.textContent = `${armed ? "Tap again to delete" : "Delete"} ${ready} from ${host}`;
  }

  $("takeRows").addEventListener("change", (e) => {
    const id = e.target.dataset && e.target.dataset.id;
    if (!id) return;
    if (e.target.checked) picked.add(id);
    else picked.delete(id);
    takesArmed = 0;
    renderTakes();
  });
  $("takesAll").addEventListener("change", (e) => {
    for (const t of takes) {
      if (e.target.checked) picked.add(t.id);
      else picked.delete(t.id);
    }
    takesArmed = 0;
    renderTakes();
  });
  $("takesRefresh").addEventListener("click", () => {
    takesNote("");
    loadTakes();
  });

  $("takesGet").addEventListener("click", async () => {
    const chosen = takes.filter((t) => picked.has(t.id));
    if (!chosen.length || takesBusy) return;
    takesBusy = true;
    takesArmed = 0;
    renderTakes();
    let saver = null;
    try {
      saver = await takeSaver();
    } catch (err) {
      takesNote(`Couldn't save here: ${err.message || err}`, true);
    }
    if (!saver) {
      takesBusy = false;
      return renderTakes();
    }
    const total = chosen.reduce((n, t) => n + t.size, 0) || 1;
    let done = 0;
    const came = [];
    for (const t of chosen) {
      failed.delete(t.id);
      const files = [];
      try {
        for (const f of t.files) {
          const out = saver.file(f.name);
          let at = 0, crc = 0;
          while (at < f.size) {
            const r = await api(`/api/take?f=${encodeURIComponent(f.name)}&at=${at}`);
            if (r.status !== 200 || !r.bytes.length) throw new Error(`${f.name} stopped coming`);
            crc = crc32(r.bytes, crc);
            await out.write(r.bytes);
            at += r.bytes.length;
            done += r.bytes.length;
            takesNote(`Downloading… ${Math.min(99, Math.round((done / total) * 100))}%`);
          }
          if (at !== f.size) throw new Error(`${f.name} came the wrong size`);
          await out.close();
          files.push({ name: f.name, size: at, crc });
        }
        came.push({ id: t.id, files });
        if (!saver.zip) got.set(t.id, files);
      } catch (err) {
        failed.set(t.id, `didn't come: ${err.message || err}`);
      }
      renderTakes();
    }
    if (saver.zip && came.length) {
      try {
        await saver.finish(came.length === 1 ? `${came[0].id}.zip` : `${hostName().replace(/[^\w.-]+/g, "_")} takes ${localStamp()}.zip`);
        for (const c of came) got.set(c.id, c.files);
      } catch (err) {
        for (const c of came) failed.set(c.id, `didn't save: ${err.message || err}`);
      }
    }
    takesBusy = false;
    const lost = chosen.length - came.length;
    if (came.length) takesNote(`${came.length} take${came.length === 1 ? "" : "s"} on this device${saver.where ? ` (${saver.where})` : ""}${lost ? `; ${lost} didn't come` : ""}. They can now be deleted from ${hostName()}.`, !!lost);
    else takesNote("Nothing came: try again.", true);
    renderTakes();
  });

  $("takesDel").addEventListener("click", async () => {
    const ready = takes.filter((t) => picked.has(t.id) && got.has(t.id));
    if (!ready.length || takesBusy) return;
    if (Date.now() - takesArmed > 4000) {
      takesArmed = Date.now();
      renderTakes();
      setTimeout(renderTakes, 4100);
      return;
    }
    takesArmed = 0;
    takesBusy = true;
    renderTakes();
    let deleted = 0;
    const refused = [];
    try {
      for (let i = 0; i < ready.length; i += 5) {
        const batch = ready.slice(i, i + 5);
        const res = await post({ action: "deleteTakes", takes: batch.map((t) => ({ id: t.id, files: got.get(t.id) })) });
        for (const id of res.deleted || []) {
          got.delete(id);
          picked.delete(id);
          deleted++;
        }
        for (const r of res.refused || []) {
          failed.set(r.id, r.why);
          refused.push(r.why);
        }
        if (res.error) refused.push(res.error);
      }
    } catch (err) {
      refused.push(err.message || String(err));
    }
    takesBusy = false;
    takesNote(`Deleted ${deleted} from ${hostName()}${refused.length ? `; ${refused.length} not: ${refused[0]}` : "."}`, !!refused.length);
    await loadTakes();
  });

  // ---------- the computer's Wi-Fi (from its own hotspot, or over Tailscale) ----------
  // Hand Tracker lists the networks around it; one tapped asks for its password (a saved one
  // doesn't need it), and the computer joins it. Its hotspot goes off while it's on a network,
  // so a phone on the hotspot then reaches it on that network (or over Tailscale).
  let networks = [], wifiOpen = false, lastWifiAt = null, wifiNow = "";
  async function loadWifi() {
    $("wifiNote").textContent = "Looking for networks…";
    try {
      const r = await api("/api/wifi");
      const w = r.json();
      if (r.status !== 200) throw new Error(w.error || "The networks couldn't be listed.");
      networks = w.networks || [];
      wifiNow = w.current ? `On ${w.current.ssid} (signal ${w.current.signal}%).` : "Not on a Wi-Fi network.";
      $("wifiList").innerHTML = networks.length
        ? networks.map((n, i) => `<div class="net" data-i="${i}"><button type="button" class="pick" data-i="${i}"><b>${esc(n.ssid)}</b><span>${n.signal}%${n.secure ? " · locked" : ""}${n.saved ? " · saved" : ""}</span></button></div>`).join("")
        : '<div class="muted">No networks found.</div>';
      $("wifiNote").textContent = "";
      if (state) render();
    } catch (err) {
      $("wifiNote").textContent = err.auth ? needsKey() : (err && err.message) || unreachable();
    }
  }
  $("wifiBtn").addEventListener("click", () => {
    wifiOpen = !wifiOpen;
    $("wifiList").hidden = !wifiOpen;
    $("wifiBtn").textContent = wifiOpen ? "Close" : "Change";
    if (wifiOpen) loadWifi();
    else $("wifiNote").textContent = "";
  });
  $("wifiList").addEventListener("click", (e) => {
    const pickBtn = e.target.closest("button.pick");
    if (pickBtn) {
      const n = networks[Number(pickBtn.dataset.i)];
      if (!n) return;
      $("wifiList").querySelectorAll(".join").forEach((f) => f.remove());
      const row = pickBtn.parentElement;
      const form = document.createElement("form");
      form.className = "join";
      const ask = n.secure && !n.saved;
      form.innerHTML = (n.secure ? `<input type="password" autocomplete="off" aria-label="Password for ${esc(n.ssid)}" placeholder="${ask ? "Its password" : "Its password (blank: the saved one)"}" />` : "") +
        '<button type="submit">Join</button><button type="button" class="quiet">Cancel</button>';
      row.appendChild(form);
      const pw = form.querySelector("input");
      if (pw) pw.focus();
      form.querySelector(".quiet").addEventListener("click", () => form.remove());
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const password = pw ? pw.value : "";
        if (ask && password.length < 8) return say("A Wi-Fi password is at least 8 characters.", true);
        form.querySelector("button[type=submit]").disabled = true;
        try {
          const res = await post({ action: "wifi", wifi: { ssid: n.ssid, password } });
          say(res.message || res.error || "", res.ok === false || !!res.error);
          if (res.ok) {
            wifiOpen = false;
            $("wifiList").hidden = true;
            $("wifiBtn").textContent = "Change";
          }
        } catch (err) {
          say(err.auth ? needsKey() : unreachable(), true);
        } finally {
          if (pw) pw.value = "";
          form.remove();
        }
      });
    }
  });
  function renderWifi(s) {
    const w = s.wifi;
    $("wifiPanel").hidden = !w;
    if (!w) return;
    // What became of the last network asked for, said once.
    const at = w.last ? w.last.at : 0;
    if (lastWifiAt !== null && at && at !== lastWifiAt) {
      say(w.last.message, !w.last.ok);
      wifiNow = "";
      if (wifiOpen) loadWifi();
    }
    lastWifiAt = at;
    $("wifiNow").textContent = w.connecting ? `Joining ${w.connecting}…` : wifiNow || "Change shows the networks around it.";
    $("wifiBtn").disabled = !!w.connecting;
  }

  // ---------- the page ----------
  let lastNoticeAt = null;
  function render() {
    const s = state;
    $("title").textContent = s.host ? `Hand Tracker on ${s.host}` : "Hand Tracker";
    document.title = s.recording ? `● ${clock(s.elapsed_s)} · Hand Tracker` : "Hand Tracker remote";
    const cams = s.cameras || [];
    const running = cams.filter((c) => c.fps > 0).length;
    const status = $("status");
    status.className = s.recording ? "rec" : "";
    if (s.recording) status.innerHTML = `<span class="dot"></span>Recording ${clock(s.elapsed_s)}`;
    else if (s.pending) status.textContent = s.pending;
    else if (!s.running) status.textContent = "Cameras off.";
    else if (running < cams.length) status.textContent = `Starting cameras… ${running} of ${cams.length} running`;
    else status.textContent = `${cams.length} camera${cams.length === 1 ? "" : "s"} running`;

    // The mode, and whether the cameras (picked, or running) are what it needs.
    const mode = s.mode || "freeform";
    for (const b of $("modes").querySelectorAll("button")) {
      b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
      b.disabled = sending || !!s.recording || !!s.pending;
    }
    const need = s.requirement || { ok: true };
    $("modeNote").textContent = need.ok ? MODE_NOTES[mode] : need.message;
    $("modeNote").className = need.ok ? "" : "err";

    $("camsBtn").hidden = !!(s.running || s.recording);
    $("camsBtn").disabled = sending || !!s.pending || !need.ok;
    $("offBtn").hidden = !s.running || !!s.recording;
    $("offBtn").disabled = sending || !!s.pending;
    const rec = $("recBtn");
    rec.textContent = s.recording ? "Stop recording" : "Start recording";
    rec.className = s.recording ? "stop" : "record";
    rec.disabled = sending || (!!s.pending && !s.recording) || (!s.recording && !need.ok);

    renderCameras(s);
    renderWifi(s);
    renderSentry(s);
    $("videoPanel").hidden = typeof s.video !== "boolean";
    if (typeof s.video === "boolean") {
      videoOn = s.video;
      soundOn = s.sound !== false;
      for (const [id, on] of [["videoBtn", videoOn], ["soundBtn", soundOn]]) {
        $(id).textContent = on ? "On" : "Off";
        $(id).classList.toggle("on", on);
        $(id).setAttribute("aria-pressed", String(on));
        $(id).disabled = sending || !!s.recording;
      }
      $("soundBtn").disabled = $("soundBtn").disabled || !videoOn;
      // (A rig from before the quality setting doesn't say it.)
      const q = typeof s.videoQuality === "string" && s.videoQuality in QUALITY_NOTES ? s.videoQuality : null;
      $("qualityRow").hidden = !q;
      if (q && document.activeElement !== $("qualitySel")) $("qualitySel").value = q;
      $("qualitySel").disabled = sending || !!s.recording || !videoOn;
      $("videoNote").textContent = !videoOn
        ? "Takes are motion capture only."
        : `Each camera's video is saved with the take, in the Takes list below${soundOn ? ", with sound from the computer's microphone" : ""}.${(q && QUALITY_NOTES[q]) || ""}`;
    }
    $("screenPanel").hidden = typeof s.screenPictures !== "boolean";
    if (typeof s.screenPictures === "boolean") {
      screenOn = s.screenPictures;
      const where = s.host || "the computer";
      $("screenBtn").textContent = screenOn ? "On" : "Off";
      $("screenBtn").classList.toggle("on", screenOn);
      $("screenBtn").setAttribute("aria-pressed", String(screenOn));
      $("screenBtn").disabled = sending;
      $("screenNote").textContent = screenOn
        ? `The OAK cameras' pictures are drawn on ${where}'s screen. Off leaves more of its processor for finding hands.`
        : `Not drawn on ${where}'s screen, leaving its processor for the hands: they're still tracked and recorded, and this page still shows the cameras.`;
    }
    // Something that went wrong in the background (cameras that couldn't start, say), said once.
    const noticeAt = s.notice ? s.notice.at : 0;
    if (lastNoticeAt !== null && noticeAt && noticeAt !== lastNoticeAt) say(s.notice.message, true);
    lastNoticeAt = noticeAt;

    if (full && !cams[full.i]) closeFull(false);
    if (cams.length !== shownCams) buildGrid(cams.length);
    const { slots, empty } = blocks(cams.map((c) => c.roleId));
    cams.forEach((c, i) => {
      const box = $(`cam${i}`);
      if (!box) return;
      box.style.order = slots[i];
      const hands = c.tracking === false ? "hand tracking off" : c.hands && c.hands.length ? esc(c.hands.join(" + ")) : "no hands";
      const what = c.error ? `<span class="err">${esc(c.error)}</span>` : c.fps > 0 ? `${c.fps} fps · ${hands}` : '<span class="muted">starting…</span>';
      box.querySelector(".what").innerHTML = `<span class="muted">${esc(c.label || c.name)}</span><br />${what}`;
      const role = box.querySelector("select");
      if (document.activeElement !== role) role.value = c.roleId || "";
      box.querySelector(".rot").textContent = `⟳ ${c.rotation || 0}°`;
      const flip = box.querySelector(".flip");
      flip.classList.toggle("on", !!c.mirror);
      flip.setAttribute("aria-pressed", String(!!c.mirror));
    });
    $("grid").classList.toggle("one", cams.length === 1);
    $("missing").textContent = cams.length && empty.length ? `Not connected: ${empty.map((b) => ROLES[b][1]).join(", ")}` : "";

    required = s.detailsRequired !== false;
    $("requiredBtn").textContent = required ? "On" : "Off";
    $("requiredBtn").setAttribute("aria-pressed", String(required));
    $("requiredBtn").disabled = sending || !!s.recording;
    lockDetails(!!s.detailsLocked);
    showNote();
    fillDetails(s.details);

    // The takes: listed once the page opens, and again when a take has been saved.
    const takeAt = s.lastTake ? s.lastTake.at : null;
    if ((!takesAsked || takeAt !== lastTakeAt) && !takesBusy) {
      takesAsked = true;
      lastTakeAt = takeAt;
      loadTakes();
    }
    const t = s.lastTake;
    $("take").hidden = !t;
    const named = t && t.details ? ["task", "contributor", "location"].map((k) => t.details[k]).filter(Boolean).join(" · ") : "";
    if (t) $("take").innerHTML = t.ok
      ? `Last take: ${clock(t.duration)} · ${t.hands} hand${t.hands === 1 ? "" : "s"}${named ? ` · ${esc(named)}` : ""}, saved on ${esc(s.host || "the computer")} as <b>${esc((t.files || []).join(", "))}</b><br /><span class="muted">${esc(t.dir || "")}</span>`
      : `Last take: <span class="err">${esc(t.message || "not saved")}</span>`;

    // The list of cameras is looked for when the page opens, again now and then while the
    // cameras are off (one plugged in meanwhile shows up), and after they're stopped.
    const a = s.available || {};
    if (!s.running && !s.recording && !s.pending && !a.scanning && !document.hidden && Date.now() - lastScanAsked > 30000) scan();
  }

  // A box per running camera (only those: Hand Tracker starts only the cameras plugged in),
  // each with its own preview loop (each picture as the computer makes it, up to about 15 a
  // second, only while this page is visible: the computer makes previews only while they're
  // asked for), its role, turn and flip.
  function buildGrid(n) {
    shownCams = n;
    loops.forEach((l) => (l.stop = true));
    loops.length = 0;
    const cams = Array.from({ length: n }, (_, i) =>
      `<div class="cam" id="cam${i}"><div class="pic" title="Full screen"><span>No picture yet</span><img alt="" hidden /><div class="boxes" hidden></div></div>` +
      `<div class="cap"><div class="tools"><select data-i="${i}" aria-label="Role">${roleOptions("")}</select>` +
      `<button type="button" class="rot" data-i="${i}" aria-label="Turn 90 degrees clockwise"></button>` +
      `<button type="button" class="flip" data-i="${i}" aria-pressed="false">Flip</button>` +
      `<button type="button" class="big" data-i="${i}" aria-label="Full screen">Full</button></div><div class="what"></div></div></div>`);
    $("grid").innerHTML = cams.join("");
    for (let i = 0; i < n; i++) {
      const loop = { stop: false };
      loops.push(loop);
      previewLoop(i, loop);
    }
  }
  // A running camera's role, turn or flip, from its box.
  $("grid").addEventListener("change", (e) => {
    if (e.target.matches("select")) command("camera", { camera: { index: Number(e.target.dataset.i), role: e.target.value } });
  });
  $("grid").addEventListener("click", (e) => {
    const box = e.target.closest(".boxes button");
    if (box) return tapBox(box);
    const pic = e.target.closest(".cam .pic");
    if (pic) return openFull(Number(pic.parentElement.id.slice(3)));
    const b = e.target.closest("button");
    const c = b && state && (state.cameras || [])[Number(b.dataset.i)];
    if (!c) return;
    if (b.matches(".rot")) command("camera", { camera: { index: c.index, rotation: ((c.rotation || 0) + 90) % 360 } });
    else if (b.matches(".flip")) command("camera", { camera: { index: c.index, mirror: !c.mirror } });
    else if (b.matches(".big")) openFull(c.index);
  });
  // A preview's box in its camera's shape (a phone held upright: tall, not wide with black
  // bars), no taller than most of the screen.
  function shape(img) {
    const w = img.naturalWidth, h = img.naturalHeight, pic = img.parentElement;
    if (!w || !h || pic.dataset.ratio === `${w}/${h}`) return;
    pic.dataset.ratio = `${w}/${h}`;
    pic.style.aspectRatio = `${w} / ${h}`;
    pic.style.maxWidth = `calc(75vh * ${(w / h).toFixed(4)})`;
  }

  const PREVIEW_EVERY_MS = 66;
  async function previewLoop(i, loop) {
    const img = document.querySelector(`#cam${i} img`), note = document.querySelector(`#cam${i} .pic span`);
    let url = null;
    while (!loop.stop) {
      if (document.hidden || full) {
        await sleep(500);
        continue;
      }
      try {
        const asked = performance.now();
        const res = await api(`/api/preview?i=${i}`);
        if (res.status === 200 && !loop.stop) {
          const next = URL.createObjectURL(new Blob([res.bytes], { type: "image/jpeg" }));
          await new Promise((r) => { img.onload = img.onerror = r; img.src = next; });
          if (url) URL.revokeObjectURL(url);
          url = next;
          img.hidden = false;
          note.hidden = true;
          shape(img);
          // (The computer waits for each new picture; one that doesn't is asked at most this often.)
          await sleep(Math.max(0, PREVIEW_EVERY_MS - (performance.now() - asked)));
        } else {
          await sleep(700);
        }
      } catch {
        await sleep(1500);
      }
    }
    if (url) URL.revokeObjectURL(url);
  }

  // ---------- one camera, full screen ----------
  // Tapping a camera's picture shows it alone, as big as the screen and more often (about 15
  // pictures a second: Hand Tracker sends only that one meanwhile, and each request waits for
  // its next picture). Tapping it, ✕, Escape or Back goes back to every camera.
  let full = null; // { i, stop }
  function openFull(i) {
    if (full || !Number.isInteger(i)) return;
    const loop = { i, stop: false };
    full = loop;
    const c = ((state && state.cameras) || [])[i] || {};
    $("fullName").textContent = c.role || c.name || `Camera ${i + 1}`;
    $("fullRate").textContent = "";
    $("fullImg").removeAttribute("src");
    $("full").hidden = false;
    if (state) renderSentry(state);
    try {
      history.pushState({ full: i }, "");
    } catch {}
    const root = document.documentElement;
    if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    fullLoop(loop);
  }
  function closeFull(fromHistory) {
    if (!full) return;
    full.stop = true;
    full = null;
    $("full").hidden = true;
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    if (!fromHistory && history.state && history.state.full !== undefined) history.back();
  }
  window.addEventListener("popstate", () => closeFull(true));
  $("full").addEventListener("click", (e) => {
    const box = e.target.closest(".boxes button");
    if (box) return tapBox(box);
    closeFull(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeFull(false);
  });
  async function fullLoop(loop) {
    const img = $("fullImg");
    let url = null, frames = 0, since = performance.now();
    while (!loop.stop) {
      try {
        const res = await api(`/api/preview?i=${loop.i}&full=1`);
        if (loop.stop) break;
        if (res.status === 200) {
          const next = URL.createObjectURL(new Blob([res.bytes], { type: "image/jpeg" }));
          await new Promise((r) => { img.onload = img.onerror = r; img.src = next; });
          if (url) URL.revokeObjectURL(url);
          url = next;
          frames++;
          const now = performance.now();
          if (now - since >= 1000) {
            $("fullRate").textContent = `${Math.round((frames * 1000) / (now - since))} fps`;
            frames = 0;
            since = now;
          }
        } else {
          await sleep(100);
        }
      } catch {
        await sleep(500);
      }
    }
    if (url) URL.revokeObjectURL(url);
  }

  const unreachable = () => (rig
    ? `Can't reach Hand Tracker at ${rig}. Is it running there, with Remote recording on, and is this device on the same network (or on Tailscale)?`
    : "Can't reach Hand Tracker. Is it still running, with Remote recording on, and is this phone on the same network (or on Tailscale)?");
  const needsKey = () => (rig
    ? "This computer needs its code: use Tailscale, or paste the address under its QR code (with #k=…) on the Computers page."
    : "This page needs Hand Tracker's code: open it over Tailscale, or scan the QR code under Remote recording in Hand Tracker.");

  async function poll() {
    for (;;) {
      try {
        state = (await api("/api/state")).json();
        render();
        if ($("message").className === "err" && /reach|code/.test($("message").textContent)) say("");
      } catch (err) {
        say(err.auth ? needsKey() : unreachable(), true);
      }
      await sleep(document.hidden ? 3000 : 1000);
    }
  }

  // extra: what the action needs ({ camera }, { pick }, { mode }, { settings }). Details being
  // typed go first, so a take that's stopped (or started) has them.
  async function command(action, extra = {}, { quiet = false } = {}) {
    sending = true;
    if (state) render();
    try {
      await sendDetails();
      const res = await post({ action, ...extra });
      if (Array.isArray(res.missing)) markMissing(res.missing.filter((k) => FIELDS.includes(k)));
      if (!quiet || res.ok === false || res.error) say(res.message || (res.ok ? "" : res.error || "That didn't work."), res.ok === false || !!res.error);
    } catch (err) {
      say(err.auth ? "This page's code isn't Hand Tracker's any more: scan the QR code again." : unreachable(), true);
    } finally {
      sending = false;
      try {
        state = (await api("/api/state")).json();
        render();
      } catch {}
    }
  }
  $("camsBtn").addEventListener("click", () => command("cameras"));
  $("offBtn").addEventListener("click", async () => {
    await command("close");
    scan();
  });
  $("recBtn").addEventListener("click", () => {
    if (state && state.recording) return command("stop");
    // Hand Tracker checks too (for every phone), but there's no need to ask it.
    if (required) {
      const d = readDetails();
      const missing = FIELDS.filter((k) => !d[k]);
      if (missing.length) return say(`Fill in ${markMissing(missing)} first: each take is named after them.`, true);
    }
    command("record");
  });
  showNote();
  poll();
})();
