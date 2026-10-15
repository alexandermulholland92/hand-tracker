/**
 * remote-client.js — the remote recording page (remote-client.html): start and stop motion
 * capture on a computer running Hand Tracker with Remote recording on (a camera rig on a
 * Raspberry Pi, say). Before the cameras start it lists the ones the computer can start (any
 * kind: OAK cameras and webcams), to pick and give roles; the mode says which it needs (Ego:
 * all four roles; Stereo: a head camera, the others picked too; Freeform: any). Then each
 * camera's live preview, its role, turn and flip, the take details and Start/Stop. Hidden until
 * the title is tapped five times: Sentry mode (watching the cameras for movement, with boxes
 * over each preview to leave parts of the picture out; while it's on, the hands aren't tracked
 * unless it's asked to, and the take details are hidden).
 *
 * Where it runs, and how it reaches the computer:
 *   - served by the computer itself (electron/remote-record.js), in any browser: plain requests
 *     to its own address, with the key from the QR code (#k=…, kept in this browser) unless
 *     it's opened over Tailscale;
 *   - in the Android and iPhone apps and the Windows, Mac and Linux app, as remote-client.html?rig=<name>:<port>
 *     (from remote.html): the app makes the requests (Remote.rigRequest on Android, RigLink.rigRequest
 *     on an iPhone, desktop.rig.request on Windows, Mac and Linux), since a page can't reach a device on your
 *     network by itself; a key comes with the address the same way and is kept per computer;
 *   - over Bluetooth Low Energy (bt-link-client.js, Web Bluetooth: the website in Chrome, the
 *     Windows, Mac and Linux app; the iPhone app's own, RemoteLink.swift), as
 *     remote-client.html?bt=<its name> from remote.html, or offered
 *     when a computer can't be reached over the network: each request over the link, sealed with
 *     a key made from its password (kept here as that key only, per computer). Bluetooth is slow
 *     (a few KB a second): its state is asked for less often, and a camera's picture only when
 *     its box is tapped;
 *   - in the Android app, over a computer's Bluetooth network (a Raspberry Pi's, set up with
 *     pi/bluetooth-setup.sh; this phone paired with it in Android's Bluetooth settings, its
 *     Internet access on), as remote-client.html?rig=10.43.0.1:47821 from remote.html, or by itself
 *     when the computer can't be reached over the network and the phone is on its Bluetooth
 *     network: the app's requests go over that network, with the computer's Bluetooth password
 *     (asked for here the first time, then kept in the app, per computer). When the phone isn't on
 *     it, or a VPN (such as Tailscale) keeps the app off it: over Bluetooth Low Energy instead, by
 *     itself (the app's own Bluetooth, BtLinkPlugin.java, as above).
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  // "pi:47821", "100.101.2.3:47821", "[fd7a::1]:47821" (see remote-launcher.js).
  const rig = /^[a-z0-9.\-[\]:]{1,260}$/i.test(params.get("rig") || "") ? params.get("rig") : "";
  const cap = window.Capacitor;
  const onPhoneApp = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const onIphone = onPhoneApp && typeof cap.getPlatform === "function" && cap.getPlatform() === "ios";
  const native = (name) => (typeof cap.registerPlugin === "function" ? cap.registerPlugin(name) : cap.Plugins && cap.Plugins[name]);
  const nativeRemote = rig && onPhoneApp ? native(onIphone ? "RigLink" : "Remote") : null;
  const desktopRig = rig && window.desktop && window.desktop.rig ? window.desktop.rig : null;
  // Bluetooth: asked for (?bt=<its name>), or offered when the computer can't be reached.
  const btName = params.get("bt");
  // (The iPhone app: its own Bluetooth, below.)
  const btPossible = !!(window.BtLinkClient && (navigator.bluetooth || onIphone) && window.isSecureContext !== false);
  let bt = null; // { name, request, close } while connected
  // The Android app on a computer's Bluetooth network (its address there, BtNet.java).
  const BT_NET_RIG = "10.43.0.1:47821";
  const btNet = !!nativeRemote && !onIphone && rig.replace(/:\d+$/, "") === BT_NET_RIG.replace(/:\d+$/, "");
  // The phone apps' own Bluetooth Low Energy: the Android app's (BtLinkPlugin.java) when its
  // Bluetooth network can't be used; the iPhone app's (RemoteLink.swift), which has no other.
  const nativeBtLink = (btNet || onIphone) && window.BtLinkClient ? native("BtLink") : null;
  if (rig || btName !== null) $("back").hidden = false;

  // A Sentry alert to show the video of (#alert=<its id>, and its take's name as &take=… for when
  // it's no longer among the computer's latest alerts): a notification's link (ntfy's, or the
  // Android app's own, SentryWatchService.java).
  const alertHash = /[#&]alert=(\d{1,15}-[a-z0-9]{1,8})/.exec(location.hash);
  const takeHash = /[#&]take=([^&]{1,400})/.exec(location.hash);
  const decoded = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return "";
    }
  };
  let wantAlert = alertHash ? { id: alertHash[1], take: takeHash ? decoded(takeHash[1]) : "" } : null;

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
  if (fromHash || wantAlert) history.replaceState(null, "", location.pathname + location.search);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fromBase64 = (b64) => Uint8Array.from(atob(b64 || ""), (c) => c.charCodeAt(0));
  const answer = (status, type, bytes) => ({ status, type: type || "", bytes, json: () => JSON.parse(new TextDecoder().decode(bytes)) });

  // One request to the computer -> { status, type, bytes, json() }.
  async function call(path, { method = "GET", body = null } = {}) {
    if (bt) {
      const r = await bt.request({ path, method, body });
      return answer(r.status, r.type, r.bytes);
    }
    if (btName !== null) throw Object.assign(new Error("bluetooth"), { bluetooth: true });
    if (desktopRig) {
      const r = await desktopRig.request({ rig, path, method, body, key });
      return answer(r.status, r.type, r.body instanceof Uint8Array ? r.body : new Uint8Array(r.body || []));
    }
    if (nativeRemote) {
      let r;
      try {
        r = await nativeRemote.rigRequest({ rig, path, method, body: body || "", key });
      } catch (err) {
        if (err && err.code === "BT_NETWORK_OFF") throw Object.assign(new Error("bluetooth network"), { btNetworkOff: true });
        if (err && err.code === "BT_NETWORK_BLOCKED") throw Object.assign(new Error("bluetooth network"), { btNetworkBlocked: true });
        throw err;
      }
      // (Its Bluetooth password missing, or not the one: asked for here.)
      if (btNet && r.status === 401) throw Object.assign(new Error("bluetooth password"), { btPassword: true, sent: !!r.sentPassword });
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
    // (On the device settings page too.)
    for (const id of ["message", "setMessage"]) {
      $(id).textContent = text || "";
      $(id).className = err ? "err" : "";
    }
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
  // Each OAK camera's own settings, opened under its row (Settings): it starts again with them if
  // it's running (not while recording).
  const openOak = new Set();
  const OAK_CHOICES = {
    model: ["Hand model", [["lite", "Lite"], ["full", "Full"]]],
    hands: ["Hands", [[1, "One"], [2, "Two"]]],
    fps: ["Frame rate", [[0, "Automatic"], [60, "60"]]],
    picture: ["Picture", [["color", "Colour"], ["depth", "Depth"]]],
    night: ["Night vision", [["auto", "Automatic"], ["on", "On"], ["off", "Off"]]],
  };
  const OAK_SWITCHES = { depth: "Depth (each hand's distance)", detect: "Find objects", dots: "Infrared dots (better depth in the dark, dots on the picture)" };
  // A camera's own settings, under its ⚙: Hand tracking (every camera), then an OAK camera's.
  function camSettingsHtml(c, disabled) {
    const id = esc(c.id), on = c.tracking !== false;
    const track = `<div class="row"><span class="grow">Hand tracking</span><button type="button" class="small${on ? " on" : ""}" data-track="${id}" aria-pressed="${on}"${disabled ? " disabled" : ""}>${on ? "On" : "Off"}</button></div>`;
    if (c.oak) return oakSettingsHtml(c, disabled, track);
    return `<div class="oakset" id="oakset-${id}">${track}<div class="sub">Off: a take records this camera's video, without its hands.</div></div>`;
  }
  function oakSettingsHtml(c, disabled, first = "") {
    const o = c.oak, id = esc(c.id), dis = disabled ? " disabled" : "";
    const choice = (k) => `<div class="row"><span class="grow">${OAK_CHOICES[k][0]}</span><select data-oakid="${id}" data-oakset="${k}"${dis}>` +
      OAK_CHOICES[k][1].map(([v, t]) => `<option value="${v}"${String(o[k]) === String(v) ? " selected" : ""}>${t}</option>`).join("") + "</select></div>";
    const sw = (k) => `<div class="row"><span class="grow">${OAK_SWITCHES[k]}</span><button type="button" class="small${o[k] ? " on" : ""}" data-oakid="${id}" data-oakset="${k}" aria-pressed="${!!o[k]}"${dis}>${o[k] ? "On" : "Off"}</button></div>`;
    const depth = o.hasDepth !== false, infrared = o.infrared !== false;
    return `<div class="oakset" id="oakset-${id}">` + first + choice("model") + choice("hands") + (depth ? sw("depth") : "") + choice("fps") + sw("detect") + (depth ? choice("picture") : "") +
      (infrared ? choice("night") + sw("dots") : "") +
      `<div class="sub">${infrared ? (o.infrared === null ? "Night vision needs an infrared light (OAK-D Pro); Automatic turns it on when it's dark. " : "Night vision: Automatic turns it on when it's dark. ") : "This camera has no infrared light, so no night vision. "}` +
      "Changed while the camera runs, it starts again with them (a few seconds).</div></div>";
  }
  $("camRows").addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button");
    if (!b) return;
    if (b.dataset.oakopen) {
      if (openOak.has(b.dataset.oakopen)) openOak.delete(b.dataset.oakopen);
      else openOak.add(b.dataset.oakopen);
      const id = b.dataset.oakopen;
      shownRows = "";
      if (state) renderCameras(state);
      const again = [...$("camRows").querySelectorAll("button[data-oakopen]")].find((x) => x.dataset.oakopen === id);
      if (again) again.focus(); // (the row was drawn again)
    } else if (b.dataset.track) {
      command("pick", { pick: { id: b.dataset.track, tracking: b.getAttribute("aria-pressed") !== "true" } });
    } else if (b.dataset.oakset) {
      command("oak", { oak: { id: b.dataset.oakid, options: { [b.dataset.oakset]: b.getAttribute("aria-pressed") !== "true" } } });
    }
  });
  $("camRows").addEventListener("change", (e) => {
    if (e.target.dataset.oakset) {
      const k = e.target.dataset.oakset, v = e.target.value;
      command("oak", { oak: { id: e.target.dataset.oakid, options: { [k]: k === "hands" || k === "fps" ? Number(v) : v } } });
      return;
    }
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
    $("camPanel").hidden = false;
    const busy = !!(s.running || s.recording || s.pending);
    // Rebuilt only when something changed (so a select being used isn't swapped under a finger).
    // An OAK camera's settings can be changed while the cameras run, not while recording.
    const fixed = !!s.recording || sending;
    const sig = JSON.stringify(list) + busy + fixed + [...openOak].join();
    // (Not while one of its menus is open under a finger; a button tapped there, ⚙ say, has the
    // focus too, and mustn't hold it back.)
    const using = document.activeElement && document.activeElement.tagName === "SELECT" && $("camRows").contains(document.activeElement);
    if (sig !== shownRows && !using) {
      shownRows = sig;
      // One ticked that isn't plugged in can be unticked (it's then off the list) while the others
      // run too: it isn't one of them.
      $("camRows").innerHTML = list.map((c) =>
        `<div class="camrow"><label><input type="checkbox" data-id="${esc(c.id)}"${c.use ? " checked" : ""}${(c.present ? !busy : c.use && !fixed) ? "" : " disabled"} /> ` +
        `<span>${esc(c.label)}${c.present ? "" : ' <span class="gone">not plugged in</span>'}</span></label>` +
        `<select data-id="${esc(c.id)}" aria-label="Role of ${esc(c.label)}"${busy ? " disabled" : ""}>${roleOptions(c.role)}</select>` +
        `<button type="button" class="small" data-oakopen="${esc(c.id)}" aria-expanded="${openOak.has(c.id)}" aria-controls="oakset-${esc(c.id)}" aria-label="Settings of ${esc(c.label)}">⚙</button>` +
        "</div>" + (openOak.has(c.id) ? camSettingsHtml(c, fixed) : "")).join("");
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
  // ignoring pets and animals, tracking hands while it's on (off: a take records videos only),
  // the boxes over each camera's preview (tap one to leave it out of what's watched; the grid and
  // the sensitivity for every camera), what an alert saves, the alerts on this phone (in the Hand
  // Tracker app) and through ntfy, and the alerts themselves, each with its photo (a slice of the
  // takes folder, as the takes come).
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

  // ---------- a video played here: a take's (its ▶ in the takes list) or a Sentry alert's ----------
  // Its file comes a slice at a time, as a download does (whichever way this page reaches the
  // computer; over Bluetooth that's slow, and said), then plays over everything; ✕, Escape or
  // Back closes it. The last one played stays ready. One too big for a phone's memory isn't
  // played: its take can be downloaded instead.
  const VIDEO_FILE = /\.(mp4|webm)$/i;
  const MAX_PLAY = 600e6;
  // "<take>-video-wrist-left.mp4" -> "Left wrist"; Sentry's "<take>-video.mp4" -> "Video".
  function videoLabel(name) {
    const role = (/-video-([a-z0-9-]+)(?: \(\d+\))?\.[a-z0-9]+$/i.exec(name) || [])[1];
    if (!role) return "Video";
    const known = ROLES.find(([id]) => id.replace(/_/g, "-") === role.toLowerCase());
    return known ? known[1] : role.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  }
  let player = null; // { stop } while it's open
  let played = null; // { name, url }: the last video, ready to play again
  let photoUrl = null;
  function showPlayer(title) {
    const wasOpen = !!player;
    if (player) player.stop = true;
    const p = { stop: false };
    player = p;
    const v = $("playerVideo");
    v.pause();
    v.removeAttribute("src");
    v.load();
    v.hidden = true;
    $("playerPhoto").hidden = true;
    $("playerName").textContent = title;
    $("playerNote").textContent = "";
    $("player").hidden = false;
    if (!wasOpen) {
      try {
        history.pushState({ player: true }, "");
      } catch {}
    }
    return p;
  }
  function closePlayer(fromHistory) {
    if (!player) return;
    player.stop = true;
    player = null;
    const v = $("playerVideo");
    v.pause();
    v.removeAttribute("src");
    v.load();
    $("player").hidden = true;
    $("playerPhoto").removeAttribute("src");
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = null;
    if (!fromHistory && history.state && history.state.player) history.back();
  }
  // (Back closes it; a Back that lands on a player's place in the history, a late one, doesn't.)
  window.addEventListener("popstate", (e) => {
    if (!(e.state && e.state.player)) closePlayer(true);
  });
  $("playerClose").addEventListener("click", () => closePlayer(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePlayer(false);
  });
  $("playerVideo").addEventListener("error", () => {
    if (player && $("playerVideo").getAttribute("src")) $("playerNote").textContent = "This device can't play that video: download its take instead.";
  });

  // The takes listed here if one of them is the one wanted, else as the computer lists them now.
  async function takeList(wanted) {
    if (takes.some(wanted)) return takes;
    try {
      const r = await api("/api/takes");
      return r.status === 200 ? r.json().takes || [] : [];
    } catch {
      return [];
    }
  }
  const fileOf = async (name) => (await takeList((t) => t.files.some((f) => f.name === name))).flatMap((t) => t.files).find((f) => f.name === name);
  // A take's file, a slice at a time -> a Blob (null if the player was closed meanwhile).
  async function fetchFile(p, name, size, type, progress) {
    const parts = [];
    let at = 0;
    while (at < size) {
      if (p.stop) return null;
      const r = await api(`/api/take?f=${encodeURIComponent(name)}&at=${at}`);
      if (r.status !== 200 || !r.bytes.length) throw new Error("it stopped coming");
      parts.push(r.bytes);
      at += r.bytes.length;
      if (progress) progress(at);
    }
    return new Blob(parts, { type });
  }
  async function playVideo(name, title, size, p = showPlayer(title)) {
    const v = $("playerVideo"), note = $("playerNote");
    const show = (url) => {
      $("playerPhoto").hidden = true;
      note.textContent = "";
      v.src = url;
      v.hidden = false;
      v.play().catch(() => {}); // (if it may not start by itself: its ▶)
    };
    if (played && played.name === name) return show(played.url);
    if (!size) size = ((await fileOf(name)) || {}).size || 0;
    if (p.stop) return;
    if (!size) {
      note.textContent = `That video isn't on ${hostName()} any more.`;
      return;
    }
    if (size > MAX_PLAY) {
      note.textContent = `It's ${sizeText(size)}: too big to play here. Download its take instead.`;
      return;
    }
    const slow = bt ? " Over Bluetooth this is slow." : "";
    note.textContent = `Loading the video… ${sizeText(size)}${slow}`;
    try {
      const type = /\.webm$/i.test(name) ? "video/webm" : "video/mp4";
      const blob = await fetchFile(p, name, size, type, (at) => {
        if (!p.stop) note.textContent = `Loading the video… ${Math.min(99, Math.round((at / size) * 100))}% of ${sizeText(size)}${slow}`;
      });
      if (!blob || p.stop) return;
      if (played) URL.revokeObjectURL(played.url);
      played = { name, url: URL.createObjectURL(blob) };
      show(played.url);
    } catch (err) {
      if (!p.stop) note.textContent = err.auth ? needsKey() : `The video didn't come: ${err.message || err}. Try again.`;
    }
  }
  async function showPhoto(p, name) {
    try {
      const f = await fileOf(name);
      const blob = f ? await fetchFile(p, name, f.size, "image/jpeg") : null;
      if (!blob || p.stop) return;
      if (photoUrl) URL.revokeObjectURL(photoUrl);
      photoUrl = URL.createObjectURL(blob);
      $("playerPhoto").src = photoUrl;
      $("playerPhoto").hidden = !$("playerVideo").hidden;
    } catch {
      // (the note says why there's no video)
    }
  }

  // A Sentry alert's video, from a notification: once it's saved (Sentry records while there's
  // movement, then saves it), with the alert's photo meanwhile; from its take's own files once
  // the computer no longer lists the alert among its latest.
  async function openAlert({ id, take }) {
    const p = showPlayer("Sentry");
    const note = $("playerNote");
    let photo = false;
    for (let tries = 0; !p.stop; tries++) {
      const sentry = (state && state.sentry) || {};
      const e = (sentry.events || []).find((x) => x.id === id);
      if (!e) break;
      const title = `Sentry: ${e.camera} · ${whenText(e.at)}`;
      $("playerName").textContent = title;
      if (e.video) return playVideo(e.video, title, 0, p);
      if (e.photo && !photo) {
        photo = true;
        showPhoto(p, e.photo);
      }
      const none = /no video/.test(e.problem || "") || sentry.video === false;
      if (none || tries >= 150) {
        note.textContent = none ? "No video was saved for this alert." : "No video came for this alert.";
        return;
      }
      note.textContent = "Sentry is still recording this. Its video plays here once it's saved.";
      await sleep(2000);
    }
    if (p.stop) return;
    const t = take ? (await takeList((x) => x.id === take)).find((x) => x.id === take) : null;
    if (p.stop) return;
    const video = t && t.files.find((f) => VIDEO_FILE.test(f.name));
    if (t) $("playerName").textContent = `Sentry: ${t.id}`;
    if (video) return playVideo(video.name, $("playerName").textContent, video.size, p);
    const still = t && t.files.find((f) => /\.jpg$/i.test(f.name));
    if (still) showPhoto(p, still.name);
    note.textContent = t ? "No video was saved for this alert." : `That alert isn't on ${hostName()} any more.`;
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
        // Each of its videos, to play here.
        const videos = t.files.filter((f) => VIDEO_FILE.test(f.name));
        const plays = videos.map((f) => `<button type="button" class="small" data-play="${esc(f.name)}"${takesBusy ? " disabled" : ""}>▶ ${esc(videoLabel(f.name))}</button>`).join("");
        return `<div class="takerow"><label><input type="checkbox" data-id="${esc(t.id)}"${picked.has(t.id) ? " checked" : ""}${takesBusy ? " disabled" : ""} /> <span>${esc(t.id)}</span></label>` +
          `<div class="meta">${esc(whenText(t.at))} · ${esc(sizeText(t.size))} · ${esc(kinds)}${status}</div>${plays ? `<div class="plays">${plays}</div>` : ""}</div>`;
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
  $("takeRows").addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button[data-play]");
    if (!b || b.disabled) return;
    const t = takes.find((x) => x.files.some((f) => f.name === b.dataset.play));
    const f = t && t.files.find((x) => x.name === b.dataset.play);
    if (f) playVideo(f.name, `${t.id} · ${videoLabel(f.name)}`, f.size);
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

  // ---------- the device settings page ----------
  // Its takes, video, pictures on its screen and Wi-Fi, and restarting it (or its cameras): a page
  // of its own (#settings), from the link under Sentry; back to the cameras at its top (or the
  // phone's Back). The cameras' pictures pause meanwhile.
  let settingsOpen = false;
  function showSettingsPage(open) {
    settingsOpen = open;
    $("mainPage").hidden = open;
    $("settingsPage").hidden = !open;
    window.scrollTo(0, 0);
    if (open) {
      if (!$("takesPanel").hidden) loadTakes();
      if (!$("wifiPanel").hidden) loadSaved();
    }
  }
  $("settingsOpen").addEventListener("click", () => {
    history.pushState({ settings: true }, "", "#settings");
    showSettingsPage(true);
  });
  $("settingsBack").addEventListener("click", () => {
    if (history.state && history.state.settings) history.back();
    else {
      history.replaceState(null, "", location.pathname + location.search);
      showSettingsPage(false);
    }
  });
  window.addEventListener("popstate", () => showSettingsPage(location.hash === "#settings"));

  // A button for something hard to undo asks once more: it says what, and a second tap within
  // 4 seconds does it.
  function tapAgain(btn, question, act) {
    if (btn.dataset.armed) {
      clearTimeout(Number(btn.dataset.armed));
      delete btn.dataset.armed;
      btn.textContent = btn.dataset.label;
      return act();
    }
    btn.dataset.label = btn.textContent;
    btn.textContent = question;
    btn.dataset.armed = String(setTimeout(() => {
      delete btn.dataset.armed;
      btn.textContent = btn.dataset.label;
    }, 4000));
  }

  // Restarting it, or its cameras (their USB off and on): what it can do, from its state.
  function renderRestart(s) {
    const sys = s.system || null;
    $("restartPanel").hidden = !sys || (!sys.reboot && !sys.cameraReset);
    if ($("restartPanel").hidden) return;
    $("resetCamsRow").hidden = !sys.cameraReset;
    $("rebootRow").hidden = !sys.reboot && !sys.powerOff;
    $("rebootBtn").hidden = !sys.reboot;
    $("powerOffBtn").hidden = !sys.powerOff;
    const host = hostName();
    if (!$("rebootBtn").dataset.armed) $("rebootBtn").textContent = `Restart ${host}`;
    if (!$("powerOffBtn").dataset.armed) $("powerOffBtn").textContent = `Turn off ${host}`;
    $("resetCamsBtn").disabled = !!s.recording || !!s.pending;
    $("rebootBtn").disabled = $("powerOffBtn").disabled = !!s.recording;
    const notes = [];
    if (sys.cameraReset === "soft") notes.push("Restart cameras only resets them on the USB for now; a camera that's stopped answering needs its power off and on: run sudo bash restart-setup.sh on it once (pi/restart-setup.sh).");
    if (sys.cameraReset === "power") notes.push("On a Raspberry Pi 5 all its own USB ports go off and on together (a keyboard or hub on them too).");
    if (sys.reboot === "setup" || sys.powerOff === "setup") notes.push("To restart it or turn it off from here, run sudo bash restart-setup.sh on it (pi/restart-setup.sh).");
    if (sys.powerOff) notes.push("Turned off, it stays off until its power is turned on again (a Raspberry Pi 5: its power button, or unplug it and plug it back in): this page can't turn it on.");
    if (s.recording) notes.push("Stop recording first.");
    $("restartNote").textContent = notes.join(" ");
  }
  $("resetCamsBtn").addEventListener("click", (e) => tapAgain(e.currentTarget, "The cameras stop: tap again", () => command("resetCameras")));
  $("rebootBtn").addEventListener("click", (e) => tapAgain(e.currentTarget, `Restart ${hostName()}? Tap again`, () => command("reboot")));
  $("powerOffBtn").addEventListener("click", (e) => tapAgain(e.currentTarget, `Turn off ${hostName()}? Tap again`, () => command("powerOff")));

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
  // The networks it has saved (it joins one by itself when it's in range): listed, forgotten, a
  // new one saved (not joined now).
  let savedNets = [];
  async function loadSaved() {
    try {
      const r = await api("/api/wifi");
      const w = r.json();
      if (r.status !== 200) throw new Error(w.error || "");
      savedNets = w.saved || [];
      $("wifiSaved").innerHTML = savedNets.length
        ? savedNets.map((n, i) => `<div class="row"><span class="grow">${esc(n)}</span><button type="button" class="small" data-forget="${i}">Forget</button></div>`).join("")
        : '<div class="muted">None yet.</div>';
    } catch (err) {
      $("wifiSaved").innerHTML = `<div class="muted">${esc(err.auth ? needsKey() : err.message || unreachable())}</div>`;
    }
  }
  async function wifiOp(wifi) {
    try {
      const res = await post({ action: "wifi", wifi });
      say(res.message || res.error || "", res.ok === false || !!res.error);
      return res;
    } catch (err) {
      say(err.auth ? needsKey() : unreachable(), true);
      return { ok: false };
    }
  }
  $("wifiSaved").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-forget]");
    const ssid = b && savedNets[Number(b.dataset.forget)];
    if (ssid) tapAgain(b, "Forget it? Tap again", async () => {
      await wifiOp({ op: "forget", ssid });
      loadSaved();
    });
  });
  $("wifiAdd").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ssid = $("wifiAddSsid").value.trim(), password = $("wifiAddPw").value;
    if (!ssid) return say("Its network name, please.", true);
    if (password && password.length < 8) return say("A Wi-Fi password is at least 8 characters (or none, for an open network).", true);
    const res = await wifiOp({ op: "save", ssid, password });
    if (res.ok) {
      $("wifiAddSsid").value = "";
      $("wifiAddPw").value = "";
      loadSaved();
    }
  });
  // Hotspot mode: its hotspot on, and it stays on until switched back (or it restarts).
  function renderHotspot(h) {
    $("hotspotBox").hidden = !h || !h.available;
    if ($("hotspotBox").hidden) return;
    const btn = $("hotspotBtn");
    if (h.forced) {
      $("hotspotText").textContent = `Hotspot mode: ${h.ssid} stays on until you switch it back`;
      if (!btn.dataset.armed) btn.textContent = "Back to Wi-Fi";
    } else {
      $("hotspotText").textContent = h.on ? `Its hotspot ${h.ssid} is on (no saved network in range)` : `Its hotspot ${h.ssid} comes on when it isn't on a network`;
      if (!btn.dataset.armed) btn.textContent = "Hotspot mode";
    }
    btn.dataset.on = h.forced ? "1" : "";
    $("hotspotNote").textContent = h.keeper ? (h.forced ? "" : "Hotspot mode keeps the hotspot on, even with a saved network in range, until you switch it back here (or it restarts).")
      : "Hotspot mode needs its hotspot updated first: run sudo bash hotspot-setup.sh --update on it.";
  }
  $("hotspotBtn").addEventListener("click", (e) => {
    const on = !e.currentTarget.dataset.on;
    tapAgain(e.currentTarget, on ? "It leaves its Wi-Fi: tap again" : "Back to Wi-Fi? Tap again", () => wifiOp({ op: "hotspot", on }));
  });

  function renderWifi(s) {
    const w = s.wifi;
    $("wifiPanel").hidden = !w;
    if (!w) return;
    renderHotspot(w.hotspot);
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

  // ---------- over Bluetooth ----------
  // Each computer's password's key, by its salt (what's kept, rather than the password).
  const KEYS = "hand-tracker-bluetooth-keys";
  const keys = () => {
    try {
      return JSON.parse(localStorage.getItem(KEYS) || "{}") || {};
    } catch {
      return {};
    }
  };
  function showBluetooth(why) {
    $("btPanel").hidden = !btPossible || !!bt;
    if ($("btPanel").hidden) return;
    if (!$("btDevices").onclick) $("btNote").textContent = why || ""; // (not while one is being picked)
    $("btJoin").hidden = false;
    $("btNetRow").hidden = true;
  }
  async function connectBluetooth() {
    const password = $("btPassword").value;
    $("btConnect").disabled = true;
    $("btDevices").textContent = "";
    say("Looking for it over Bluetooth…");
    try {
      // (The Windows, Mac and Linux app: which device it is, by name; or a list here to pick from.)
      if (window.desktop && desktop.bluetooth) desktop.bluetooth.prefer(btName || (rig ? rig.replace(/:\d+$/, "") : ""));
      bt = await BtLinkClient.connect({
        password: password || null,
        keys: keys(),
        // (The Android app: its own Bluetooth; the computer asked for by name, else a list here.)
        bluetooth: nativeBtLink ? BtLinkClient.capacitorBluetooth(nativeBtLink, { prefer: params.get("want") || btName || rig.replace(/:\d+$/, ""), pick: pickDevice }) : undefined,
        onGone: () => {
          if (!bt) return; // (not connected yet: the one asking for its password, say)
          bt = null;
          // (The Android app connects again by itself.)
          if (btNet) showBtNet("The Bluetooth connection ended: connecting again…", {});
          else showBluetooth("The Bluetooth connection ended: connect again.");
          say("");
        },
      });
      try {
        localStorage.setItem(KEYS, JSON.stringify({ ...keys(), [bt.saved.salt]: bt.saved.key }));
      } catch {}
      $("btPassword").value = "";
      $("btPanel").hidden = true;
      say(`Connected to ${bt.name} over Bluetooth.`);
      for (const l of loops) l.want = false;
    } catch (err) {
      bt = null;
      if (btNet) showLePassword(err);
      if (err.needPassword) say(`${err.name || "It"} needs its password (on a Raspberry Pi, its hotspot's).`, true);
      else if (err.password) say("That isn't its password (on a Raspberry Pi, its hotspot's).", true);
      else if (err.name === "NotFoundError") say("No Hand Tracker was picked over Bluetooth.", true);
      else say(`Bluetooth: ${err.message}`, true);
    } finally {
      $("btConnect").disabled = false;
    }
  }
  $("btConnect").addEventListener("click", () => (btNet && !leOn ? setBtNetPassword() : connectBluetooth()));

  // ---------- the Android app, over a computer's Bluetooth network ----------
  // The panel: its password (password), or the way to its Bluetooth network (offer: from a
  // computer out of reach; settings: Android's Bluetooth settings).
  function showBtNet(why, { password = false, offer = false, settings = false } = {}) {
    $("btPanel").hidden = false;
    if (!$("btDevices").onclick) $("btDevices").textContent = "";
    $("btNote").textContent = why;
    $("btJoin").hidden = !password;
    $("btNetRow").hidden = !(offer || settings);
    $("btNetOpen").hidden = !offer;
    $("btSettings").hidden = !settings;
  }
  const openBtNet = () => (location.href = `remote-client.html?rig=${encodeURIComponent(BT_NET_RIG)}&want=${encodeURIComponent(rig.replace(/:\d+$/, ""))}`);
  $("btNetOpen").addEventListener("click", openBtNet);
  $("btSettings").addEventListener("click", () => nativeRemote && nativeRemote.openBluetoothSettings().catch(() => {}));
  let btNetChecked = false; // a password just given: the next answer says whether it's the one
  async function setBtNetPassword() {
    const password = $("btPassword").value;
    if (password.length < 8) return say("Its password is 8 characters or more (on a Raspberry Pi, its hotspot's).", true);
    $("btConnect").disabled = true;
    try {
      await nativeRemote.bluetoothSetPassword({ password });
      $("btPassword").value = "";
      btNetChecked = true;
      say("Checking its password…");
    } catch (err) {
      say(err.message, true);
    } finally {
      $("btConnect").disabled = false;
    }
  }
  // Which computer the phone's Bluetooth network is with (asked once, with the Nearby devices
  // permission, so its password is kept for it alone).
  let btNetInfo = null, btNetAskedAt = 0;
  async function btNetwork(ask = false) {
    if (!nativeRemote || !nativeRemote.bluetoothNetwork) return null;
    if (!ask && btNetInfo && btNetInfo.on && Date.now() - btNetAskedAt < 5000) return btNetInfo;
    btNetAskedAt = Date.now();
    try {
      btNetInfo = await nativeRemote.bluetoothNetwork({ ask });
    } catch {
      btNetInfo = null;
    }
    return btNetInfo;
  }
  const sameName = (a, b) => !!a && !!b && String(a).toLowerCase().split(".")[0] === String(b).toLowerCase().split(".")[0];
  // Over Bluetooth Low Energy instead (the Android app's own), by itself: the computer asked for by
  // name, else the only one near by, else a list to pick from; its password the first time.
  let leOn = false, leBusy = false, leNextAt = 0, leWhy = "", leSettings = false;
  function pickDevice(devices) {
    return new Promise((resolve) => {
      if (btNet) showBtNet(`${leWhy} Which computer?`, { settings: leSettings });
      else {
        $("btPanel").hidden = false;
        $("btNote").textContent = "Which computer?";
      }
      $("btDevices").innerHTML = devices.map((d) => `<button type="button" data-leid="${esc(d.id)}">${esc(d.name || d.id)}</button>`).join("");
      $("btDevices").onclick = (e) => {
        const b = e.target.closest("button[data-leid]");
        if (!b) return;
        $("btDevices").textContent = "";
        $("btDevices").onclick = null;
        resolve(devices.find((d) => d.id === b.dataset.leid) || null);
      };
    });
  }
  function showLePassword(err) {
    if (err.needPassword || err.password) {
      showBtNet(`${leWhy} ${err.name && err.needPassword ? err.name : "It"} needs its Bluetooth password (on a Raspberry Pi, its hotspot's). It's kept in this app after the first time.`, { password: true, settings: leSettings });
    } else {
      showBtNet(`${leWhy} ${err.none ? "No Hand Tracker with remote recording on was found near by: trying again." : ""}`, { settings: leSettings });
      leNextAt = Date.now() + 8000;
    }
  }
  async function useLe(why, settings) {
    if (!nativeBtLink || bt || leBusy || Date.now() < leNextAt || (leOn && !$("btJoin").hidden)) return;
    leOn = true;
    leBusy = true;
    leWhy = why;
    leSettings = settings;
    showBtNet(`${why} Looking for it…`, { settings });
    try {
      await connectBluetooth();
    } finally {
      leBusy = false;
    }
  }

  // On it: the answer to each kind of trouble.
  async function btNetTrouble(err) {
    if ((err.btNetworkOff || err.btNetworkBlocked) && nativeBtLink) {
      say("");
      return useLe(err.btNetworkBlocked
        ? "A VPN on this phone (such as Tailscale) keeps Hand Tracker off its Bluetooth network, so it's over Bluetooth Low Energy instead (slower: a camera's picture when its box is tapped)."
        : "Over Bluetooth Low Energy (slower: a camera's picture when its box is tapped). Faster: pair this phone with it in Bluetooth settings and turn on Internet access for it there.", !!err.btNetworkOff);
    }
    if (err.btNetworkBlocked) {
      showBtNet("A VPN on this phone (such as Tailscale) keeps Hand Tracker off the computer's Bluetooth network: pause it while using Bluetooth.", {});
      return say("");
    }
    if (err.btNetworkOff) {
      showBtNet("This phone isn't on a computer's Bluetooth network. Pair it with the computer in Bluetooth settings (once), then turn on Internet access for it there (under its ⚙). Hand Tracker on the computer needs remote recording on.", { settings: true });
      return say("");
    }
    if (err.btPassword) {
      leOn = false; // (its Bluetooth network answers: that, not Bluetooth Low Energy)
      if (err.sent) await nativeRemote.bluetoothForgetPassword().catch(() => {});
      const net = await btNetwork();
      const who = net && net.device ? net.device.name : "The computer";
      showBtNet(`${who} needs its Bluetooth password (on a Raspberry Pi, its hotspot's). It's kept in this app after the first time.`, { password: true });
      return say(err.sent && btNetChecked ? "That isn't its password (on a Raspberry Pi, its hotspot's)." : "", true);
    }
    say(`Can't reach Hand Tracker over this Bluetooth network. Is it running there, with Remote recording on?`, true);
  }
  // A computer out of reach over the network: its Bluetooth network instead, by itself when the
  // phone is on that computer's, else offered.
  async function btNetFallback() {
    if (!nativeRemote || btNet) return;
    const net = await btNetwork();
    const name = rig.replace(/:\d+$/, "");
    if (net && net.on && net.device && sameName(net.device.name, name)) {
      say(`Can't reach ${name} over the network: over its Bluetooth network instead.`);
      return openBtNet();
    }
    showBtNet(`Can't reach ${name} over the network. If it's near by, connect over Bluetooth instead.`, { offer: true });
  }
  // (The Windows, Mac and Linux app: Hand Tracker computers near by, to pick from.)
  if (window.desktop && desktop.bluetooth) {
    desktop.bluetooth.onDevices((list) => {
      $("btDevices").innerHTML = list.map((d) => `<button type="button" data-btid="${esc(d.id)}">${esc(d.name || d.id)}</button>`).join("");
    });
    $("btDevices").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-btid]");
      if (b) {
        desktop.bluetooth.choose(b.dataset.btid);
        $("btDevices").textContent = "";
      }
    });
  }

  // ---------- the page ----------
  let lastNoticeAt = null;
  function render() {
    const s = state;
    $("title").textContent = (s.host ? `Hand Tracker on ${s.host}` : "Hand Tracker") + (bt || btNet ? " (Bluetooth)" : "");
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
    renderRestart(s);
    $("settingsOpen").hidden = false;
    $("settingsHost").textContent = s.host ? `On ${s.host}.` : "";
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
    if (pic && bt) return (loops[Number(pic.parentElement.id.slice(3))] || {}).want = true;
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
      if (document.hidden || full || settingsOpen) {
        await sleep(500);
        continue;
      }
      // Over Bluetooth a picture takes seconds: only when its box is tapped (asked again a few
      // times if the computer has none new yet).
      if (bt && !loop.want) {
        if (img.hidden) note.textContent = "Over Bluetooth: tap for its picture";
        await sleep(300);
        continue;
      }
      if (bt) loop.want = typeof loop.want === "number" ? loop.want - 1 : 4;
      try {
        const asked = performance.now();
        if (bt) note.textContent = "Getting its picture…";
        const res = await api(`/api/preview?i=${i}`);
        if (res.status === 200 && !loop.stop) {
          const next = URL.createObjectURL(new Blob([res.bytes], { type: "image/jpeg" }));
          await new Promise((r) => { img.onload = img.onerror = r; img.src = next; });
          if (url) URL.revokeObjectURL(url);
          url = next;
          img.hidden = false;
          note.hidden = true;
          shape(img);
          loop.want = false;
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
  // Where the computer numbers its pictures ("image/jpeg; seq=N"), FULL_AT_ONCE requests are on
  // their way at once (FULL_AT_ONCE_BT over Bluetooth Low Energy, where the next is asked for
  // while a picture comes), each for the picture after the last one asked for: a new one each
  // time, and up to that many times as many a second over a link that takes a while each way (a
  // phone over Tailscale: ~100 ms; up to the camera's 30). One at a time otherwise (an older
  // Hand Tracker, a phone's own cameras). The newest picture that has come is shown; an older
  // one coming late isn't.
  const FULL_AT_ONCE = 4, FULL_AT_ONCE_BT = 2;
  async function fullLoop(loop) {
    const img = $("fullImg");
    let url = null, frames = 0, since = performance.now();
    let numbered = null, ask = 0, shown = 0, pending = null, drawing = false;
    const seqOf = (type) => {
      const m = /;\s*seq=(\d+)/.exec(type || "");
      return m ? Number(m[1]) : null;
    };
    async function show(bytes, seq) {
      pending = { bytes, seq };
      if (drawing) return;
      drawing = true;
      while (pending && !loop.stop) {
        const p = pending;
        pending = null;
        if (p.seq !== null && p.seq <= shown) continue;
        const next = URL.createObjectURL(new Blob([p.bytes], { type: "image/jpeg" }));
        await new Promise((r) => { img.onload = img.onerror = r; img.src = next; });
        if (url) URL.revokeObjectURL(url);
        url = next;
        if (p.seq !== null) shown = p.seq;
        frames++;
        const now = performance.now();
        if (now - since >= 1000) {
          $("fullRate").textContent = `${Math.round((frames * 1000) / (now - since))} fps`;
          frames = 0;
          since = now;
        }
      }
      drawing = false;
    }
    async function asking(first) {
      while (!loop.stop && (first || numbered)) {
        try {
          const res = await api(`/api/preview?i=${loop.i}&full=1&after=${ask++}`);
          if (loop.stop) break;
          if (res.status === 200) {
            const seq = seqOf(res.type);
            if (numbered === null) {
              numbered = seq !== null;
              if (numbered) for (let n = 1; n < (bt ? FULL_AT_ONCE_BT : FULL_AT_ONCE); n++) asking(false);
            }
            if (seq !== null) ask = Math.max(ask, seq);
            show(res.bytes, seq);
          } else {
            await sleep(100);
          }
        } catch {
          await sleep(500);
        }
      }
    }
    await asking(true);
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
        if (wantAlert) {
          const a = wantAlert;
          wantAlert = null;
          openAlert(a);
        }
        if ($("message").className === "err" && /reach|code|password/.test($("message").textContent)) say("");
        if (btNet && !bt) btConnected();
        else if (btNet && bt) await backToNetwork();
      } catch (err) {
        if (btNet && !bt) {
          await btNetTrouble(err);
        } else if (err.bluetooth) {
          showBluetooth(`Connect to ${btName || "a computer"} over Bluetooth: Hand Tracker on it needs remote recording on. Its password is kept here (as a key) after the first time.`);
          if (!$("message").textContent) say("");
        } else {
          say(err.auth ? needsKey() : unreachable(), true);
          // Out of reach over the network: Bluetooth instead (if it's near by).
          if (!err.auth && rig && !bt) {
            if (nativeRemote && !onIphone) await btNetFallback();
            else showBluetooth(`Can't reach ${rig.replace(/:\d+$/, "")} over the network. If it's near by, connect over Bluetooth instead.`);
          }
        }
      }
      // (Bluetooth is slow: its state less often.)
      await sleep(document.hidden ? (bt ? 6000 : 3000) : bt ? 2000 : 1000);
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
    // Hand Tracker checks too (for every phone), but there's no need to ask it. (With the hands
    // not tracked, it says why there's no take.)
    if (required && !$("detailsPanel").hidden) {
      const d = readDetails();
      const missing = FIELDS.filter((k) => !d[k]);
      if (missing.length) return say(`Fill in ${markMissing(missing)} first: each take is named after them.`, true);
    }
    command("record");
  });
  // Over Bluetooth Low Energy, its Bluetooth network usable now (the VPN off, say): that instead,
  // faster (looked at every 10 s).
  let lookedAt = 0;
  async function backToNetwork() {
    if (Date.now() - lookedAt < 10000) return;
    lookedAt = Date.now();
    const net = await btNetwork();
    if (!net || !net.on || net.blocked || !bt) return;
    const was = bt;
    bt = null;
    was.close();
    leOn = false;
    say("Over its Bluetooth network now (faster).");
  }

  // On a computer's Bluetooth network: connected (the panel goes; the computer asked for by name
  // from remote.html, if this is another one, said once).
  let btNetSaid = false;
  function btConnected() {
    leOn = false;
    $("btPanel").hidden = true;
    if (btNetChecked) {
      btNetChecked = false;
      say(`Connected to ${state.host || "it"} over Bluetooth.`);
    }
    const want = params.get("want");
    if (!btNetSaid && want && state.host && !sameName(want, state.host)) say(`This phone's Bluetooth network is with ${state.host}, not ${want}.`, true);
    btNetSaid = true;
  }

  showNote();
  // (On a computer's Bluetooth network: which computer, asked for once, so its password is its own.)
  if (btNet) btNetwork(true).finally(poll);
  else poll();
})();
