/**
 * remote-client.js — the remote recording page (remote-client.html): start and stop motion
 * capture on a computer running Hand Tracker with Remote recording on (a camera rig on a
 * Raspberry Pi, say). Before the cameras start it lists the ones the computer can start (any
 * kind: OAK cameras and webcams), to pick and give roles; the mode says which it needs (Ego:
 * all four roles; Stereo: a head camera, the others picked too; Freeform: any). Then each
 * camera's live preview, its role, turn and flip, the take details and Start/Stop.
 *
 * Where it runs, and how it reaches the computer:
 *   - served by the computer itself (electron/remote-record.js), in any browser: plain requests
 *     to its own address, with the key from the QR code (#k=…, kept in this browser) unless
 *     it's opened over Tailscale;
 *   - in the Android app and the Windows and Linux app, as remote-client.html?rig=<name>:<port>
 *     (from remote.html): the app makes the requests (Remote.rigRequest on Android,
 *     desktop.rig.request on Windows and Linux), since a page can't reach a device on your
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
  // The 2 × 2 grid by role, as in Hand Tracker: head top left, chest top right, left wrist bottom
  // left, right wrist bottom right; a camera with no role takes the first free block.
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
    const off = !s.running && !s.recording && s.kind !== "phone";
    $("camPanel").hidden = !off;
    if (!off) return;
    // Rebuilt only when something changed (so a select being used isn't swapped under a finger).
    const sig = JSON.stringify(list);
    if (sig !== shownRows && !$("camRows").contains(document.activeElement)) {
      shownRows = sig;
      $("camRows").innerHTML = list.map((c) =>
        `<div class="camrow"><label><input type="checkbox" data-id="${esc(c.id)}"${c.use ? " checked" : ""}${c.present ? "" : " disabled"} /> ` +
        `<span>${esc(c.label)}${c.present ? "" : ' <span class="gone">not plugged in</span>'}</span></label>` +
        `<select data-id="${esc(c.id)}" aria-label="Role of ${esc(c.label)}">${roleOptions(c.role)}</select></div>`).join("");
    }
    const note = $("camNote");
    note.className = "";
    if (a.scanning) note.textContent = "Looking for cameras…";
    else if (!list.length) note.textContent = a.note || "No cameras found. Plug one in, then Refresh.";
    else note.textContent = a.note || "Tick the cameras to start; each one's role is where it's worn.";
    $("scanBtn").disabled = !!a.scanning || sending;
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

  // ---------- the computer's Wi-Fi (from its own hotspot, or over Tailscale) ----------
  // Hand Tracker lists the networks around it; one tapped asks for its password (a saved one
  // doesn't need it), and the computer joins it. Its hotspot moves to that network's channel,
  // so a phone on the hotspot drops off for a moment and comes back.
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
        ? networks.map((n, i) => `<div class="net" data-i="${i}"><button type="button" class="pick" data-i="${i}"><b>${esc(n.ssid)}</b><span>${n.signal}%${n.secure ? " · locked" : ""}${n.saved ? " · saved" : ""}${n.dfs ? " · no hotspot beside it" : ""}</span></button></div>`).join("")
        : '<div class="muted">No networks found.</div>';
      $("wifiNote").textContent = networks.some((n) => n.dfs) ? "A network marked “no hotspot beside it” is on a radar channel: the hotspot is off while the computer's on it." : "";
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
    // A phone recording with its own camera (the Android app): no modes, no list of cameras,
    // and its camera is always on.
    const phone = s.kind === "phone";
    $("modePanel").hidden = phone;
    $("grid").classList.toggle("phone", phone);
    const status = $("status");
    status.className = s.recording ? "rec" : "";
    if (s.recording) status.innerHTML = `<span class="dot"></span>Recording ${clock(s.elapsed_s)}`;
    else if (s.pending) status.textContent = s.pending;
    else if (phone) status.textContent = "The phone's camera is on.";
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

    $("camsBtn").hidden = phone || !!(s.running || s.recording);
    $("camsBtn").disabled = sending || !!s.pending || !need.ok;
    $("offBtn").hidden = phone || !s.running || !!s.recording;
    $("offBtn").disabled = sending || !!s.pending;
    const rec = $("recBtn");
    rec.textContent = s.recording ? "Stop recording" : "Start recording";
    rec.className = s.recording ? "stop" : "record";
    rec.disabled = sending || (!!s.pending && !s.recording) || (!s.recording && !need.ok);

    renderCameras(s);
    renderWifi(s);
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
      const what = c.error ? `<span class="err">${esc(c.error)}</span>` : c.fps > 0 ? `${c.fps} fps · ${c.hands && c.hands.length ? esc(c.hands.join(" + ")) : "no hands"}` : '<span class="muted">starting…</span>';
      box.querySelector(".what").innerHTML = `<span class="muted">${esc(c.label || c.name)}</span><br />${what}`;
      const role = box.querySelector("select");
      if (document.activeElement !== role) role.value = c.roleId || "";
      box.querySelector(".rot").textContent = `⟳ ${c.rotation || 0}°`;
      const flip = box.querySelector(".flip");
      flip.classList.toggle("on", !!c.mirror);
      flip.setAttribute("aria-pressed", String(!!c.mirror));
    });
    ROLES.forEach((r, b) => {
      const el = $(`empty${b}`);
      if (el) el.hidden = !empty.includes(b);
    });

    required = s.detailsRequired !== false;
    $("requiredBtn").textContent = required ? "On" : "Off";
    $("requiredBtn").setAttribute("aria-pressed", String(required));
    $("requiredBtn").disabled = sending || !!s.recording;
    lockDetails(!!s.detailsLocked);
    showNote();
    fillDetails(s.details);

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
  // each with its own preview loop (a few pictures a second, only while this page is visible:
  // the computer makes previews only while they're asked for), its role, turn and flip. The
  // blocks no camera has say so.
  function buildGrid(n) {
    shownCams = n;
    loops.forEach((l) => (l.stop = true));
    loops.length = 0;
    const cams = Array.from({ length: n }, (_, i) =>
      `<div class="cam" id="cam${i}"><div class="pic" title="Full screen"><span>No picture yet</span><img alt="" hidden /></div>` +
      `<div class="cap"><div class="tools"><select data-i="${i}" aria-label="Role">${roleOptions("")}</select>` +
      `<button type="button" class="rot" data-i="${i}" aria-label="Turn 90 degrees clockwise"></button>` +
      `<button type="button" class="flip" data-i="${i}" aria-pressed="false">Flip</button></div><div class="what"></div></div></div>`);
    const holes = n ? ROLES.map(([, label], b) => `<div class="cam empty" id="empty${b}" style="order:${b}" hidden><div class="pic"><span>${label}: no camera</span></div></div>`) : [];
    $("grid").innerHTML = cams.join("") + holes.join("");
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
    const pic = e.target.closest(".cam:not(.empty) .pic");
    if (pic) return openFull(Number(pic.parentElement.id.slice(3)));
    const b = e.target.closest("button");
    const c = b && state && (state.cameras || [])[Number(b.dataset.i)];
    if (!c) return;
    if (b.matches(".rot")) command("camera", { camera: { index: c.index, rotation: ((c.rotation || 0) + 90) % 360 } });
    else if (b.matches(".flip")) command("camera", { camera: { index: c.index, mirror: !c.mirror } });
  });
  async function previewLoop(i, loop) {
    const img = document.querySelector(`#cam${i} img`), note = document.querySelector(`#cam${i} .pic span`);
    let url = null;
    while (!loop.stop) {
      if (document.hidden || full) {
        await sleep(500);
        continue;
      }
      try {
        const res = await api(`/api/preview?i=${i}`);
        if (res.status === 200 && !loop.stop) {
          const next = URL.createObjectURL(new Blob([res.bytes], { type: "image/jpeg" }));
          await new Promise((r) => { img.onload = img.onerror = r; img.src = next; });
          if (url) URL.revokeObjectURL(url);
          url = next;
          img.hidden = false;
          note.hidden = true;
          await sleep(200);
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
  $("full").addEventListener("click", () => closeFull(false));
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
