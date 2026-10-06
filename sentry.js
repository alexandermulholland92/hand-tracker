/**
 * sentry.js — Sentry mode: watching the cameras for movement while nobody's there. Hidden:
 * Ctrl+Alt+S, or tapping the title five times within three seconds, shows its card (and
 * hides it again; Sentry keeps watching meanwhile, if it's on).
 *
 * Each camera's picture is split into boxes, rows by columns (the same grid for every
 * camera). Every box is watched except the ones tapped (tap again to watch it again): a
 * window with trees outside, a screen, a fan. Remembered for each camera and grid. Movement
 * in a watched box for a moment is an alert:
 *   - a photo, and a video of that camera until it's been still for a while: into the remote
 *     recording folder (so the phone's Takes list has them); on the website, into a folder
 *     picked once (or as downloads);
 *   - an alert on remote recording's page;
 *   - a push notification on a phone: by the Hand Tracker app (it keeps an eye on its
 *     computers), by the ntfy app (through ntfy.sh or your own server), or both.
 * One alert a camera at most every ALERT_GAP_S; the video goes on while there's movement.
 * Ignore animals: movement where a cat, dog, bird or other animal is found (and no person)
 * doesn't count. An OAK camera finds them itself (its object finder is turned on for this);
 * other cameras with an object finder in the app (object-finder.js), run only when something
 * moves.
 *
 * How movement is measured: about eight times a second each camera's picture is shrunk to a
 * small grey picture (64 pixels across; an OAK camera makes it itself). After a light blur, a
 * pixel whose brightness changed by more than CHANGE since the last look moved. A box moves
 * when enough of its pixels did (the sensitivity). When most of the whole picture changes at
 * once, that's the light (a lamp, the camera adjusting), not movement.
 *
 *   Sentry.init({ prefs, setPref, views, host, onWantsChange, hostName, link })
 *     views() -> the cameras now: [{ key, name, container, picture (the element the picture is
 *       shown in), canvas() (the canvas it's drawn on: its size, and what's recorded), frame()
 *       (the picture tracked), mirrored(), rotation() (an OAK camera: the turn its own grey
 *       pictures need), grey() (OAK: its last { w, h, data } grey picture, or null), objects()
 *       (OAK: its last objects), want(on) (OAK: draw its pictures often, for a video) }]
 *     host: desktop or mobile (saving into the remote recording folder, ntfy), or null (website)
 *     onWantsChange(): the OAK cameras' options changed (wantsMotion / wantsObjects)
 *     hostName() -> this computer's name, link() -> its remote recording page (for ntfy's alerts)
 *   Sentry.wantsMotion()   // the OAK cameras should send their grey pictures
 *   Sentry.wantsObjects()  // ... and find objects (ignore animals)
 *   Sentry.remoteState()   // for remote recording's page, or null while it's hidden and off
 *   Sentry.command({ armed })  // from that page
 *   Sentry.setArmed(on); Sentry.toggleShown(); Sentry.isShown(); Sentry.isArmed()
 *   Sentry._test            // for the checks: measure(), alert(), events
 */

(function (global) {
  const SAMPLE_MS = 125;
  const SMALL = 64; // the grey picture's longer side
  const CHANGE = 18; // out of 255: brightness change that counts as movement
  const LIGHT_SHARE = 0.6; // more of the whole picture than this at once: the light changed
  const SENSITIVITY = { low: 0.2, medium: 0.08, high: 0.03 }; // share of a box's pixels
  const STREAK = 2; // looks in a row with movement before it counts
  const ALERT_GAP_S = 60;
  const STILL_S = 10; // a video stops once it's been still this long
  const MAX_VIDEO_S = 300;
  const VIDEO_FPS = 15;
  const MAX_EVENTS = 50;
  const MAX_ROWS = 9, MAX_COLS = 16;
  const ANIMALS = new Set(["bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe"]);
  const ANIMAL_MARGIN = 0.15; // an animal's box grown by this much each way (its movement blurs past it)

  let prefs = {}, setPref = () => {}, viewsOf = () => [], host = null, onWantsChange = () => {}, hostName = () => "", linkOf = () => "";
  let cfg = null;
  let timer = null;
  const per = new Map(); // view key -> { prev, w, h, streak, levels, overlay, last, session, lastAlertAt, finding }
  const events = [];
  let finderNote = "";
  let webFolder = null; // the website's folder (File System Access), picked once

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const errText = (err) => (err && err.message ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);

  function defaults() {
    return {
      shown: false, armed: false, rows: 3, cols: 4, sensitivity: "medium", ignoreAnimals: false, bubbles: true,
      photo: true, video: true, sound: true, remote: true,
      pushApp: false, ntfy: { on: false, server: "https://ntfy.sh", topic: "", photo: false },
      excluded: {}, // camera key -> { "3x4": [box numbers, in the camera's own picture] }
    };
  }
  function load() {
    const s = prefs.sentry && typeof prefs.sentry === "object" ? prefs.sentry : {};
    const d = defaults();
    cfg = {
      ...d, ...s,
      rows: clamp(s.rows, 1, MAX_ROWS, d.rows), cols: clamp(s.cols, 1, MAX_COLS, d.cols),
      sensitivity: SENSITIVITY[s.sensitivity] ? s.sensitivity : d.sensitivity,
      ntfy: { ...d.ntfy, ...(s.ntfy || {}) },
      excluded: s.excluded && typeof s.excluded === "object" ? s.excluded : {},
    };
    if (!cfg.ntfy.topic) cfg.ntfy.topic = newTopic();
  }
  function save() {
    setPref("sentry", cfg);
  }
  function newTopic() {
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    return "handtracker-" + Array.from(a, (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
  }

  const gridKey = () => `${cfg.rows}x${cfg.cols}`;
  const excludedOf = (key) => new Set(((cfg.excluded[key] || {})[gridKey()] || []).filter((n) => Number.isInteger(n)));
  function setExcluded(key, set) {
    cfg.excluded = { ...cfg.excluded, [key]: { ...(cfg.excluded[key] || {}), [gridKey()]: [...set].sort((a, b) => a - b) } };
    save();
  }

  // ---------- measuring movement ----------
  let shrinkCanvas = null;
  // The picture as a small grey one: { w, h, data } (64 across its longer side).
  function shrink(image) {
    const iw = image.videoWidth || image.width, ih = image.videoHeight || image.height;
    if (!iw || !ih) return null;
    const w = iw >= ih ? SMALL : Math.max(1, Math.round((SMALL * iw) / ih));
    const h = iw >= ih ? Math.max(1, Math.round((SMALL * ih) / iw)) : SMALL;
    if (!shrinkCanvas) shrinkCanvas = document.createElement("canvas");
    if (shrinkCanvas.width !== w || shrinkCanvas.height !== h) Object.assign(shrinkCanvas, { width: w, height: h });
    const ctx = shrinkCanvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const data = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
    return { w, h, data };
  }

  // An OAK camera's grey picture turned as its picture is (its tracking turns it too).
  function turn(g, rotation) {
    const r = ((rotation % 360) + 360) % 360;
    if (!g || !r) return g;
    const { w, h, data } = g;
    const out = new Uint8Array(w * h);
    const W = r === 180 ? w : h, H = r === 180 ? h : w;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let X, Y;
        if (r === 90) { X = h - 1 - y; Y = x; }
        else if (r === 180) { X = w - 1 - x; Y = h - 1 - y; }
        else { X = y; Y = w - 1 - x; }
        out[Y * W + X] = data[y * w + x];
      }
    }
    return { w: W, h: H, data: out };
  }

  function blur(g) {
    const { w, h, data } = g;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy)) * w;
          for (let dx = -1; dx <= 1; dx++) s += data[yy + Math.min(w - 1, Math.max(0, x + dx))];
        }
        out[y * w + x] = (s / 9) | 0;
      }
    }
    return { w, h, data: out };
  }

  // Which pixels moved since prev (1 each): { w, h, data, share } or null (no earlier look, or
  // the light changed).
  function moved(prev, now) {
    if (!prev || prev.w !== now.w || prev.h !== now.h) return null;
    const mask = new Uint8Array(now.w * now.h);
    let n = 0;
    for (let i = 0; i < mask.length; i++) if (Math.abs(now.data[i] - prev.data[i]) > CHANGE) (mask[i] = 1), n++;
    const share = n / mask.length;
    if (share > LIGHT_SHARE) return null;
    return { w: now.w, h: now.h, data: mask, share };
  }

  // The share of each box's pixels that moved, box by box (row by row, in the
  // camera's own picture).
  function levels(mask, rows, cols) {
    const out = new Array(rows * cols).fill(0);
    if (!mask) return out;
    const { w, h, data } = mask;
    for (let r = 0; r < rows; r++) {
      const y0 = Math.floor((r * h) / rows), y1 = Math.max(y0 + 1, Math.floor(((r + 1) * h) / rows));
      for (let c = 0; c < cols; c++) {
        const x0 = Math.floor((c * w) / cols), x1 = Math.max(x0 + 1, Math.floor(((c + 1) * w) / cols));
        let n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += data[y * w + x];
        out[r * cols + c] = n / ((y1 - y0) * (x1 - x0));
      }
    }
    return out;
  }

  // Movement where an animal is (and no person) left out of the mask. boxes: [x0, y0, x1, y1],
  // 0-1 of the picture.
  function withoutAnimals(mask, objects) {
    const animals = objects.filter((o) => ANIMALS.has(String(o.label).toLowerCase()));
    if (!animals.length) return { mask, animals: 0 };
    const people = objects.filter((o) => String(o.label).toLowerCase() === "person");
    const inside = (b, x, y, grow) => {
      const gw = (b[2] - b[0]) * grow, gh = (b[3] - b[1]) * grow;
      return x >= b[0] - gw && x <= b[2] + gw && y >= b[1] - gh && y <= b[3] + gh;
    };
    const data = mask.data.slice();
    for (let y = 0; y < mask.h; y++) {
      for (let x = 0; x < mask.w; x++) {
        const i = y * mask.w + x;
        if (!data[i]) continue;
        const fx = (x + 0.5) / mask.w, fy = (y + 0.5) / mask.h;
        if (animals.some((a) => inside(a.box, fx, fy, ANIMAL_MARGIN)) && !people.some((p) => inside(p.box, fx, fy, 0))) data[i] = 0;
      }
    }
    return { mask: { ...mask, data }, animals: animals.length };
  }

  // ---------- each camera, eight times a second ----------
  function stateOf(key) {
    if (!per.has(key)) per.set(key, { prev: null, streak: 0, levels: [], overlay: null, session: null, lastAlertAt: 0, finding: false, objects: null, objectsAt: 0 });
    return per.get(key);
  }

  function sample() {
    const views = safeViews();
    const keys = new Set(views.map((v) => v.key));
    for (const [key, st] of per) {
      if (keys.has(key)) continue;
      removeOverlay(st);
      if (st.session) endSession(key, st);
      per.delete(key);
    }
    for (const v of views) {
      const st = stateOf(v.key);
      let now = null;
      try {
        const g = v.grey && v.grey();
        now = g ? turn(g, v.rotation ? v.rotation() : 0) : shrink(v.frame());
      } catch {
        now = null;
      }
      if (!now) continue;
      now = blur(now);
      const mask = moved(st.prev, now);
      st.prev = now;
      st.mask = mask;
      st.levels = levels(mask, cfg.rows, cfg.cols);
      const off = excludedOf(v.key);
      const need = SENSITIVITY[cfg.sensitivity];
      const hot = st.levels.some((l, i) => !off.has(i) && l >= need);
      st.streak = hot ? st.streak + 1 : 0;
      if (cfg.armed && st.streak >= STREAK) consider(v, st, off, need);
      if (st.session && performance.now() - st.session.lastMovedAt > STILL_S * 1000) endSession(v.key, st);
      else if (st.session && st.session.rec && st.session.rec.elapsed() > MAX_VIDEO_S) endSession(v.key, st);
      drawOverlay(v, st, off, need);
    }
    showStatus(views);
  }

  // Movement in a watched box: an alert (or more of one going on), unless it's an animal's.
  async function consider(v, st, off, need) {
    if (cfg.ignoreAnimals) {
      if (st.finding) return;
      let objects = v.objects ? v.objects() : null;
      if (!objects && !v.oak) {
        st.finding = true;
        try {
          objects = await findObjects(v.frame());
        } finally {
          st.finding = false;
        }
      }
      if (objects === undefined) return; // the object finder isn't ready: not yet
      if (objects && st.mask) {
        const left = withoutAnimals(st.mask, objects);
        const still = !levels(left.mask, cfg.rows, cfg.cols).some((l, i) => !off.has(i) && l >= need);
        if (still) {
          st.ignoredAt = Date.now();
          return;
        }
      }
    }
    moving(v, st);
  }

  // The object finder for cameras that don't find objects themselves: undefined while it loads.
  async function findObjects(image) {
    const finder = global.ObjectFinder;
    if (!finder) {
      finderNote = "Ignoring animals needs the object finder, which isn't here.";
      return null;
    }
    try {
      const objects = await finder.find(image);
      finderNote = "";
      return objects;
    } catch (err) {
      if (finder.loading && finder.loading()) {
        finderNote = "Loading the object finder…";
        return undefined;
      }
      finderNote = `The object finder didn't work (${errText(err)}): animals aren't left out.`;
      return null;
    }
  }

  function moving(v, st) {
    const now = performance.now();
    if (st.session) {
      st.session.lastMovedAt = now;
      return;
    }
    const at = new Date();
    const name = baseName(v, at);
    st.session = { lastMovedAt: now, name, at, rec: null };
    if (cfg.video) {
      try {
        const canvas = v.canvas();
        if (v.want) v.want(true);
        st.session.rec = global.CameraVideo.start({ canvas, fps: VIDEO_FPS, audio: !!cfg.sound, preferMp4: !!global.mobile });
      } catch (err) {
        st.session.videoError = errText(err);
      }
    }
    if (Date.now() - st.lastAlertAt < ALERT_GAP_S * 1000) return; // a video, but no new alert yet
    st.lastAlertAt = Date.now();
    raiseAlert(v, st.session).catch((err) => console.warn("Sentry alert:", err));
  }

  function baseName(v, at) {
    const p = (n) => String(n).padStart(2, "0");
    const when = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}_${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}`;
    const cam = String(v.name || "Camera").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "Camera";
    return `Sentry_${cam}_${when}`;
  }

  // ---------- an alert: the photo, the page, the phone ----------
  async function raiseAlert(v, session) {
    const ev = { id: `${session.at.getTime()}-${Math.random().toString(36).slice(2, 7)}`, at: session.at.getTime(), camera: v.name, key: v.key, photo: null, video: null, sent: [] };
    events.unshift(ev);
    events.length = Math.min(events.length, MAX_EVENTS);
    session.event = ev;
    if (session.videoError) ev.videoError = session.videoError;
    let jpeg = null;
    if (cfg.photo) {
      try {
        jpeg = await photoOf(v.frame());
        const saved = await saveFile(session.name, "", "jpg", jpeg);
        ev.photo = saved;
      } catch (err) {
        ev.photoError = errText(err);
      }
    }
    renderEvents();
    if (cfg.ntfy.on) {
      sendNtfy(ev, jpeg)
        .then(() => ev.sent.push("ntfy"))
        .catch((err) => (ev.ntfyError = errText(err)))
        .finally(renderEvents);
    }
    // (The remote page and the Hand Tracker app read it from remoteState.)
  }

  function photoOf(image) {
    const iw = image.videoWidth || image.width, ih = image.videoHeight || image.height;
    const c = document.createElement("canvas");
    Object.assign(c, { width: iw, height: ih });
    c.getContext("2d").drawImage(image, 0, 0, iw, ih);
    return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("The photo couldn't be made."))), "image/jpeg", 0.85));
  }

  async function endSession(key, st) {
    const s = st.session;
    st.session = null;
    const v = safeViews().find((x) => x.key === key);
    if (v && v.want) v.want(false);
    if (!s.rec) {
      if (s.event && s.videoError) s.event.videoError = s.videoError;
      return renderEvents();
    }
    try {
      const clip = await s.rec.stop();
      if (!clip.blob.size) throw new Error("nothing was recorded");
      const saved = await saveFile(s.name, "-video", clip.ext, clip.blob);
      if (s.event) {
        s.event.video = saved;
        s.event.seconds = Math.round(clip.duration);
      } else {
        events.unshift({ id: `${s.at.getTime()}-v`, at: s.at.getTime(), camera: v ? v.name : key, key, photo: null, video: saved, seconds: Math.round(clip.duration), sent: [] });
        events.length = Math.min(events.length, MAX_EVENTS);
      }
    } catch (err) {
      if (s.event) s.event.videoError = errText(err);
    }
    renderEvents();
  }

  // Saved into the remote recording folder (desktop app, phone), else the website's folder or a
  // download. -> { name, url? }
  async function saveFile(baseName, suffix, ext, blob) {
    const data = new Uint8Array(await blob.arrayBuffer());
    if (host && host.remote && host.remote.saveTake) {
      const res = await host.remote.saveTake({ baseName, files: [{ format: ext, suffix, ext, data }] });
      const r = (res.results || [])[0];
      if (!r || !r.ok) throw new Error((r && r.error) || "It couldn't be saved.");
      return { name: r.path.split(/[\\/]/).pop(), dir: res.dir };
    }
    const name = `${baseName}${suffix}.${ext}`;
    if (webFolder) {
      try {
        const f = await webFolder.getFileHandle(name, { create: true });
        const w = await f.createWritable();
        await w.write(blob);
        await w.close();
        return { name, dir: webFolder.name, url: URL.createObjectURL(blob) };
      } catch {
        // permission gone (a reload): downloads instead
      }
    }
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    return { name, url };
  }

  // ntfy: a notification through ntfy.sh (or your own server) to the ntfy app.
  function ntfyMessage(ev) {
    const t = new Date(ev.at);
    const p = (n) => String(n).padStart(2, "0");
    return { title: `Sentry: ${ev.camera}`, message: `Movement at ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}${hostName() ? ` on ${hostName()}` : ""}.` };
  }
  async function sendNtfy(ev, jpeg) {
    const { server, topic, photo } = cfg.ntfy;
    if (!topic) throw new Error("No ntfy topic.");
    const m = ntfyMessage(ev);
    const req = { server: String(server || "https://ntfy.sh").replace(/\/+$/, ""), topic, title: m.title, message: m.message, tags: "rotating_light", priority: 4, click: linkOf() || "" };
    if (photo && jpeg) Object.assign(req, { photo: new Uint8Array(await jpeg.arrayBuffer()), filename: `${(ev.photo && ev.photo.name) || "sentry.jpg"}` });
    if (host && host.sentry && host.sentry.ntfy) return host.sentry.ntfy(req);
    // The website: straight to ntfy.sh (the page may only reach that one). As electron/ntfy.js
    // does: all but the photo in the address, so any language's letters arrive as they are.
    const q = new URLSearchParams({ title: req.title, tags: req.tags, priority: String(req.priority) });
    if (req.click) q.set("click", req.click);
    if (req.photo) {
      q.set("message", req.message);
      q.set("filename", req.filename);
    }
    const url = `${req.server}/${encodeURIComponent(req.topic)}?${q}`;
    const res = await fetch(url, req.photo ? { method: "PUT", body: req.photo } : { method: "POST", body: req.message });
    if (!res.ok) throw new Error(`ntfy answered ${res.status}.`);
  }

  // ---------- the boxes over each picture ----------
  function removeOverlay(st) {
    if (st.overlay) st.overlay.el.remove();
    st.overlay = null;
  }

  function pictureRect(v) {
    const pic = v.picture, box = v.container;
    if (!pic || !box) return null;
    const c = v.canvas ? v.canvas() : null;
    const pr = pic.getBoundingClientRect(), br = box.getBoundingClientRect();
    if (!pr.width || !pr.height) return null;
    const aspect = c && c.width && c.height ? c.width / c.height : pr.width / pr.height;
    let w = pr.width, h = w / aspect;
    if (h > pr.height) (h = pr.height), (w = h * aspect);
    return { left: pr.left - br.left + (pr.width - w) / 2, top: pr.top - br.top + (pr.height - h) / 2, width: w, height: h };
  }

  function drawOverlay(v, st, off, need) {
    const show = cfg.shown && cfg.bubbles;
    if (!show) return removeOverlay(st);
    const rect = pictureRect(v);
    if (!rect) return removeOverlay(st);
    const grid = gridKey();
    if (!st.overlay || st.overlay.grid !== grid || st.overlay.el.parentElement !== v.container) {
      removeOverlay(st);
      if (getComputedStyle(v.container).position === "static") v.container.style.position = "relative";
      const el = document.createElement("div");
      el.className = "sentry-bubbles";
      el.style.gridTemplateColumns = `repeat(${cfg.cols}, 1fr)`;
      el.style.gridTemplateRows = `repeat(${cfg.rows}, 1fr)`;
      el.innerHTML = Array.from({ length: cfg.rows * cfg.cols }, (_, i) => `<button type="button" data-cell="${i}" aria-pressed="false"></button>`).join("");
      el.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-cell]");
        if (!b) return;
        const shown = Number(b.dataset.cell);
        const cell = toCamera(shown, v.mirrored());
        const set = excludedOf(v.key);
        if (set.has(cell)) set.delete(cell);
        else set.add(cell);
        setExcluded(v.key, set);
      });
      v.container.appendChild(el);
      st.overlay = { el, grid };
    }
    Object.assign(st.overlay.el.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    const size = Math.max(10, Math.min(rect.width / cfg.cols, rect.height / cfg.rows) * 0.62);
    st.overlay.el.style.setProperty("--bubble", `${size}px`);
    const buttons = st.overlay.el.children;
    const mirrored = v.mirrored();
    for (let shown = 0; shown < buttons.length; shown++) {
      const cell = toCamera(shown, mirrored);
      const b = buttons[shown];
      const isOff = off.has(cell);
      const level = Math.min(1, (st.levels[cell] || 0) / need);
      b.classList.toggle("off", isOff);
      b.classList.toggle("hot", !isOff && level >= 1);
      b.setAttribute("aria-pressed", String(isOff));
      b.title = isOff ? "Not watched: tap to watch this box" : "Watched: tap to leave this box out";
      b.style.setProperty("--level", isOff ? 0 : level.toFixed(2));
    }
  }

  // A box as shown (mirrored or not) -> the same box in the camera's own picture.
  function toCamera(shown, mirrored, cols = cfg.cols) {
    if (!mirrored) return shown;
    const r = Math.floor(shown / cols), c = shown % cols;
    return r * cols + (cols - 1 - c);
  }

  // ---------- the card ----------
  function setToggle(btn, on, label) {
    if (!btn) return;
    btn.classList.toggle("active", !!on);
    btn.setAttribute("aria-pressed", String(!!on));
    if (label) btn.textContent = label;
  }

  function apply() {
    const card = $("sentryCard");
    if (!card) return;
    card.hidden = !cfg.shown;
    setToggle($("sentryArm"), cfg.armed, cfg.armed ? "Sentry is on" : "Turn Sentry on");
    $("sentryRows").value = String(cfg.rows);
    $("sentryCols").value = String(cfg.cols);
    $("sentrySensitivity").value = cfg.sensitivity;
    setToggle($("sentryAnimals"), cfg.ignoreAnimals);
    setToggle($("sentryBubbles"), cfg.bubbles);
    for (const [id, k] of [["sentryPhoto", "photo"], ["sentryVideo", "video"], ["sentrySound", "sound"], ["sentryRemote", "remote"], ["sentryPushApp", "pushApp"]]) setToggle($(id), cfg[k]);
    $("sentrySound").disabled = !cfg.video;
    setToggle($("sentryNtfy"), cfg.ntfy.on);
    $("sentryNtfyBox").hidden = !cfg.ntfy.on;
    $("sentryNtfyServer").value = cfg.ntfy.server;
    $("sentryNtfyTopic").textContent = cfg.ntfy.topic;
    setToggle($("sentryNtfyPhoto"), cfg.ntfy.photo);
    const link = `${String(cfg.ntfy.server).replace(/\/+$/, "")}/${cfg.ntfy.topic}`;
    $("sentryNtfyLink").href = link;
    $("sentryNtfyLink").textContent = link;
    const qr = $("sentryNtfyQr");
    if (qr && global.QRCode && cfg.ntfy.on && qr.dataset.text !== link) {
      qr.dataset.text = link;
      try {
        global.QRCode.draw(qr, link, { scale: 4, margin: 3 });
      } catch {
        qr.hidden = true;
      }
    }
    const folderRow = $("sentryFolderRow");
    if (folderRow) folderRow.hidden = !!(host && host.remote && host.remote.saveTake);
    for (const st of per.values()) removeOverlay(st); // drawn afresh (the grid may have changed)
    running();
  }

  function showStatus(views) {
    const el = $("sentryStatus");
    if (!el || !cfg.shown) return;
    const n = views.length;
    const recording = [...per.values()].filter((s) => s.session && s.session.rec).length;
    el.textContent = !cfg.armed
      ? `Off. ${n ? `${n} camera${n === 1 ? "" : "s"}: tap a box to leave it out, and it isn't watched.` : "No camera is running."}`
      : !n
        ? "On, but no camera is running."
        : `Watching ${n} camera${n === 1 ? "" : "s"}${recording ? ` · recording ${recording}` : ""}.${finderNote ? ` ${finderNote}` : ""}`;
  }

  function renderEvents() {
    const list = $("sentryEvents");
    if (!list) return;
    const p = (n) => String(n).padStart(2, "0");
    list.innerHTML = events.length
      ? events
          .map((e) => {
            const t = new Date(e.at);
            const when = `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
            const photo = e.photo ? (e.photo.url ? `<a href="${esc(e.photo.url)}" download="${esc(e.photo.name)}">photo</a>` : esc(e.photo.name)) : e.photoError ? `no photo (${esc(e.photoError)})` : "";
            const video = e.video ? (e.video.url ? `<a href="${esc(e.video.url)}" download="${esc(e.video.name)}">video</a>` : esc(e.video.name)) : e.videoError ? `no video (${esc(e.videoError)})` : "";
            const sent = e.ntfyError ? ` · ntfy: ${esc(e.ntfyError)}` : e.sent.length ? ` · sent by ${esc(e.sent.join(", "))}` : "";
            return `<li><b>${when}</b> ${esc(e.camera)}${photo ? ` · ${photo}` : ""}${video ? ` · ${video}` : ""}${e.seconds ? ` (${e.seconds} s)` : ""}${sent}</li>`;
          })
          .join("")
      : '<li class="muted">No alerts yet.</li>';
  }

  // Watching (and the boxes) runs while Sentry is on or its card is shown.
  function running() {
    const want = cfg.armed || cfg.shown;
    if (want && !timer) timer = setInterval(sample, SAMPLE_MS);
    if (!want && timer) {
      clearInterval(timer);
      timer = null;
      for (const [key, st] of per) {
        removeOverlay(st);
        if (st.session) endSession(key, st);
      }
      per.clear();
    }
  }

  const safeViews = () => {
    try {
      return (viewsOf() || []).filter((v) => v && v.key);
    } catch {
      return [];
    }
  };

  function setArmed(on) {
    cfg.armed = !!on;
    if (!cfg.armed) for (const [key, st] of per) if (st.session) endSession(key, st);
    save();
    apply();
    notifyWants();
  }

  function toggleShown() {
    cfg.shown = !cfg.shown;
    save();
    apply();
    notifyWants();
  }

  const wantsMotion = () => !!cfg && (cfg.armed || cfg.shown);
  const wantsObjects = () => !!cfg && cfg.armed && cfg.ignoreAnimals;
  function notifyWants() {
    const key = `${wantsMotion()}${wantsObjects()}`;
    if (key === notifyWants.last) return;
    notifyWants.last = key;
    onWantsChange();
  }

  // For remote recording's page (and the Hand Tracker app watching for alerts): null while Sentry
  // is hidden and off.
  function remoteState() {
    if (!cfg || (!cfg.shown && !cfg.armed)) return null;
    return {
      armed: cfg.armed,
      pushApp: !!cfg.pushApp,
      alerts: !!cfg.remote,
      events: cfg.remote || cfg.pushApp
        ? events.slice(0, 20).map((e) => ({ id: e.id, at: e.at, camera: e.camera, photo: e.photo && !e.photo.url ? e.photo.name : null, video: e.video && !e.video.url ? e.video.name : null, seconds: e.seconds || 0 }))
        : [],
    };
  }
  function command(c = {}) {
    if (typeof c.armed === "boolean") setArmed(c.armed);
    return { ok: true, message: cfg.armed ? "Sentry is on." : "Sentry is off." };
  }

  // The computers in remote recording's list (remote-launcher.js keeps them), each with its code
  // if this phone has one (remote-client.js keeps those): [{ rig: "name:port", key }].
  function watchedComputers() {
    let names = [];
    try {
      names = JSON.parse(localStorage.getItem("hand-tracker-remote-computers") || "[]");
    } catch {
      names = [];
    }
    return (Array.isArray(names) ? names : [])
      .map((n) => String(n).toLowerCase())
      .map((n) => (/:\d{1,5}$/.test(n) ? n : `${n}:47821`))
      .map((rig) => ({ rig, key: localStorage.getItem(`hand-tracker-remote-key:${rig}`) || "" }));
  }

  function init(opts) {
    prefs = opts.prefs || {};
    setPref = opts.setPref || setPref;
    viewsOf = opts.views || viewsOf;
    host = opts.host || null;
    onWantsChange = opts.onWantsChange || onWantsChange;
    hostName = opts.hostName || hostName;
    linkOf = opts.link || linkOf;
    load();
    notifyWants.last = `${wantsMotion()}${wantsObjects()}`;

    // Hidden: Ctrl+Alt+S, or the title tapped five times within three seconds.
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        toggleShown();
      }
    });
    const title = document.querySelector("header h1");
    let taps = [];
    if (title) {
      title.addEventListener("click", () => {
        const now = Date.now();
        taps = [...taps.filter((t) => now - t < 3000), now];
        if (taps.length >= 5) {
          taps = [];
          toggleShown();
        }
      });
    }

    const on = (id, ev, fn) => $(id) && $(id).addEventListener(ev, fn);
    on("sentryArm", "click", () => setArmed(!cfg.armed));
    on("sentryRows", "change", () => {
      cfg.rows = clamp($("sentryRows").value, 1, MAX_ROWS, cfg.rows);
      save();
      apply();
    });
    on("sentryCols", "change", () => {
      cfg.cols = clamp($("sentryCols").value, 1, MAX_COLS, cfg.cols);
      save();
      apply();
    });
    on("sentrySensitivity", "change", () => {
      cfg.sensitivity = SENSITIVITY[$("sentrySensitivity").value] ? $("sentrySensitivity").value : "medium";
      save();
    });
    const flip = (k) => () => {
      cfg[k] = !cfg[k];
      save();
      apply();
      notifyWants();
      if (k === "ignoreAnimals" && cfg[k] && global.ObjectFinder && global.ObjectFinder.load) global.ObjectFinder.load().catch(() => {});
    };
    for (const [id, k] of [["sentryAnimals", "ignoreAnimals"], ["sentryBubbles", "bubbles"], ["sentryPhoto", "photo"], ["sentryVideo", "video"], ["sentrySound", "sound"], ["sentryRemote", "remote"], ["sentryPushApp", "pushApp"]]) on(id, "click", flip(k));
    on("sentryNtfy", "click", () => {
      cfg.ntfy = { ...cfg.ntfy, on: !cfg.ntfy.on };
      save();
      apply();
    });
    on("sentryNtfyPhoto", "click", () => {
      cfg.ntfy = { ...cfg.ntfy, photo: !cfg.ntfy.photo };
      save();
      apply();
    });
    on("sentryNtfyServer", "change", () => {
      const v = $("sentryNtfyServer").value.trim();
      cfg.ntfy = { ...cfg.ntfy, server: /^https?:\/\/[^\s/]+/i.test(v) ? v.replace(/\/+$/, "") : "https://ntfy.sh" };
      save();
      apply();
    });
    on("sentryNtfyNew", "click", () => {
      if (!confirm("Make a new topic? Phones subscribed to the old one stop getting alerts until they subscribe to the new one.")) return;
      cfg.ntfy = { ...cfg.ntfy, topic: newTopic() };
      save();
      apply();
    });
    on("sentryNtfyTest", "click", () => {
      const note = $("sentryNtfyNote");
      note.textContent = "Sending…";
      sendNtfy({ at: Date.now(), camera: "Test", photo: null, sent: [] }, null)
        .then(() => (note.textContent = "Sent: it should be on your phone in a moment."))
        .catch((err) => (note.textContent = `Couldn't send it: ${errText(err)}`));
    });
    on("sentryFolder", "click", async () => {
      try {
        webFolder = await global.showDirectoryPicker({ id: "sentry", mode: "readwrite" });
        $("sentryFolderNote").textContent = `Saving into ${webFolder.name}.`;
      } catch (err) {
        if (err && err.name !== "AbortError") $("sentryFolderNote").textContent = errText(err);
      }
    });
    if ($("sentryFolder")) $("sentryFolder").hidden = typeof global.showDirectoryPicker !== "function";
    // On a phone with the Hand Tracker app: notifications for the alerts of the computers in
    // remote recording's list (SentryWatchService.java).
    const watch = host && host.sentryWatch;
    if (watch && $("sentryWatchRow")) {
      $("sentryWatchRow").hidden = false;
      const showWatch = (s) => {
        setToggle($("sentryWatch"), s.on);
        $("sentryWatchNote").textContent = s.on ? `Watching ${s.rigs.join(", ")}.` : "Off.";
      };
      watch.status().then(showWatch).catch(() => {});
      on("sentryWatch", "click", async () => {
        try {
          const s = await watch.status();
          showWatch(s.on ? await watch.stop() : await watch.start(watchedComputers()));
        } catch (err) {
          $("sentryWatchNote").textContent = errText(err);
        }
      });
    }
    apply();
    renderEvents();
  }

  global.Sentry = {
    init, setArmed, toggleShown, wantsMotion, wantsObjects, remoteState, command,
    isShown: () => !!cfg && cfg.shown, isArmed: () => !!cfg && cfg.armed,
    _test: { shrink, blur, moved, levels, turn, withoutAnimals, sample, events, per, toCamera, config: () => cfg },
  };
})(typeof window !== "undefined" ? window : globalThis);
