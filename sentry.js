/**
 * sentry.js — Sentry mode: watching a camera rig's cameras for movement while nobody's there.
 * It's set up, turned on and off, and its alerts seen on remote recording's page
 * (remote-client.js), where it's hidden: tapping the page's title five times (or Ctrl+Alt+S
 * there) shows it, on every page this computer serves, and hides it again (Sentry keeps
 * watching meanwhile, if it's on). It watches remote recording's cameras (Several cameras).
 *
 * Each camera's picture is split into boxes, rows by columns (the same grid for every
 * camera), drawn over that camera's preview on the page. Every box is watched except the ones
 * tapped there (tap again to watch it again): a window with trees outside, a screen, a fan.
 * Remembered for each camera and grid. Movement in a watched box for a moment is an alert:
 *   - a photo, and a video of that camera until it's been still for a while, into the remote
 *     recording folder (so the page's Takes list has them);
 *   - an alert on the page, with its photo;
 *   - a push notification on a phone: by the Hand Tracker app (it keeps an eye on the
 *     computers it's told to: SentryWatchService.java), by the ntfy app (through ntfy.sh or
 *     your own server), or both.
 * One alert a camera at most every ALERT_GAP_S; the video goes on while there's movement.
 * Ignore pets and animals: movement where a cat, dog, bird or other animal is found (and no
 * person) doesn't count. An OAK camera finds them itself (its object finder is turned on for
 * this); other cameras with an object finder in the app (object-finder.js), run only when
 * something moves.
 *
 * How movement is measured: about eight times a second each camera's picture is shrunk to a
 * small grey picture (64 pixels across; an OAK camera makes it itself). After a light blur, a
 * pixel whose brightness changed by more than CHANGE since the last look moved. A box moves
 * when enough of its pixels did (the sensitivity). When most of the whole picture changes at
 * once, that's the light (a lamp, the camera adjusting), not movement.
 *
 *   Sentry.init({ prefs, setPref, views, host, onWantsChange, hostName, link, looking })
 *     views() -> the cameras now: [{ key, index (its place in remote recording's list), name,
 *       canvas() (the canvas its picture is drawn on: what's recorded), frame() (the picture
 *       tracked), mirrored() (its preview is), rotation() (an OAK camera: the turn its own grey
 *       pictures need), grey() (OAK: its last { w, h, data } grey picture, or null), objects()
 *       (OAK: its last objects), oak, want(on) (draw its pictures often, for a video) }]
 *     host: desktop or mobile (saving into the remote recording folder and deleting Sentry's
 *       files there: host.remote.deleteSentry({ names } or { all }), ntfy)
 *     onWantsChange(): the OAK cameras' options changed (wantsMotion / wantsObjects)
 *     hostName() -> this computer's name, link() -> its remote recording page (for ntfy's alerts)
 *     looking() -> a page is showing the previews now (while it's off, it measures only then)
 *   Sentry.wantsMotion()   // the OAK cameras should send their grey pictures
 *   Sentry.wantsObjects()  // ... and find objects (ignore pets and animals)
 *   Sentry.remoteState()   // for the page: its settings, each camera's boxes, the alerts
 *   await Sentry.command(c) // from the page: { shown, armed, rows, cols, sensitivity,
 *                          //   ignoreAnimals, photo, video, sound, ntfy: { on, server, photo,
 *                          //   newTopic, test }, box: { camera, cell, off }, watchAll,
 *                          //   deleteAlerts: [alert ids] (their photos and videos too),
 *                          //   deleteAll (every Sentry photo and video in the folder) }
 *   Sentry.isArmed()
 *   Sentry._test            // for the checks
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
  const VIDEO_FPS = 30;
  const MAX_EVENTS = 50;
  const MAX_ROWS = 9, MAX_COLS = 16;
  const ANIMALS = new Set(["bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe"]);
  const ANIMAL_MARGIN = 0.25; // an animal's box grown by this much each way (its movement blurs past it)
  const ANIMAL_HOLD_MS = 3000; // an animal found this recently still counts where it was (a finder misses it now and then)
  const LOOSE_STREAK = 2; // ignoring animals: looks in a row with movement no animal explains before it counts
  // ...where an OAK camera finds the objects: it looks 3 times a second (oak_bridge.py's
  // DETECT_GAP_S), so an animal walking in may not be found until up to ~0.45 s later.
  const OAK_LOOSE_STREAK = 4;
  const HEAT_FADE = 0.6; // a box shown moving on the page fades over a few looks

  let prefs = {}, setPref = () => {}, viewsOf = () => [], host = null, onWantsChange = () => {}, hostName = () => "", linkOf = () => "", lookingOf = () => true;
  let cfg = null;
  let timer = null;
  const per = new Map(); // view key -> { prev, streak, levels, heat, session, lastAlertAt, finding }
  const events = [];
  let finderNote = "";

  const errText = (err) => (err && err.message ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);

  function defaults() {
    return {
      shown: false, armed: false, rows: 3, cols: 4, sensitivity: "medium", ignoreAnimals: false,
      photo: true, video: true, sound: true,
      ntfy: { on: false, server: "https://ntfy.sh", topic: "", photo: false },
      excluded: {}, // camera key -> { "3x4": [box numbers, in the camera's own picture] }
    };
  }
  function load() {
    const s = prefs.sentry && typeof prefs.sentry === "object" ? prefs.sentry : {};
    const d = defaults();
    cfg = {
      ...d,
      ...Object.fromEntries(["shown", "armed", "ignoreAnimals", "photo", "video", "sound"].filter((k) => typeof s[k] === "boolean").map((k) => [k, s[k]])),
      rows: clamp(s.rows, 1, MAX_ROWS, d.rows), cols: clamp(s.cols, 1, MAX_COLS, d.cols),
      sensitivity: SENSITIVITY[s.sensitivity] ? s.sensitivity : d.sensitivity,
      ntfy: { ...d.ntfy, ...(s.ntfy || {}) },
      excluded: s.excluded && typeof s.excluded === "object" ? s.excluded : {},
    };
    if (!cfg.ntfy.topic) cfg.ntfy.topic = newTopic();
    cfg.ntfy.server = serverOnly(cfg.ntfy.server, cfg.ntfy.topic);
  }
  // ntfy's server without the topic: its link (https://ntfy.sh/<topic>, as the page shows it)
  // saved as the server would send to <topic>/<topic>.
  function serverOnly(server, topic) {
    let s = String(server || "https://ntfy.sh").replace(/\/+$/, "");
    if (topic && s.toLowerCase().endsWith(`/${topic.toLowerCase()}`)) s = s.slice(0, -topic.length - 1);
    return /^https?:\/\/[^\s/]+/i.test(s) ? s : "https://ntfy.sh";
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

  // A box [x0, y0, x1, y1] (0-1 of the picture) turned as an OAK camera's grey picture is (turn).
  function turnBox(b, rotation) {
    const r = ((rotation % 360) + 360) % 360;
    if (!r) return b;
    const pt = (x, y) => (r === 90 ? [1 - y, x] : r === 180 ? [1 - x, 1 - y] : [y, 1 - x]);
    const [ax, ay] = pt(b[0], b[1]), [bx, by] = pt(b[2], b[3]);
    return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
  }

  // The animals among objects found, remembered (for ANIMAL_HOLD_MS) -> the objects with boxes.
  function remember(st, objects, rotation, now = Date.now()) {
    const found = (objects || []).filter((o) => o && Array.isArray(o.box) && o.box.length === 4);
    st.animals = (st.animals || []).filter((a) => now - a.at < ANIMAL_HOLD_MS);
    for (const o of found) if (ANIMALS.has(String(o.label).toLowerCase())) st.animals.push({ label: String(o.label).toLowerCase(), box: turnBox(o.box, rotation), at: now });
    if (st.animals.length > 40) st.animals.splice(0, st.animals.length - 40);
    return found;
  }

  // Ignoring animals: is the movement in st.mask all where an animal is, or was in the last few
  // seconds (where it walked from; a finder misses one now and then), and no person is? Animals
  // found are remembered in st.animals. rotation: the turn the objects' boxes need.
  function animalsOnly(st, objects, rotation, off, need, rows, cols, now = Date.now()) {
    const found = remember(st, objects, rotation, now);
    if (!st.animals.length || !st.mask) return false;
    const people = found.filter((o) => String(o.label).toLowerCase() === "person").map((o) => ({ label: "person", box: turnBox(o.box, rotation) }));
    const left = withoutAnimals(st.mask, [...st.animals, ...people]);
    return !levels(left.mask, rows, cols).some((l, i) => !off.has(i) && l >= need);
  }

  // ---------- each camera, eight times a second ----------
  function stateOf(key) {
    if (!per.has(key)) per.set(key, { prev: null, streak: 0, levels: [], heat: [], session: null, lastAlertAt: 0, finding: false });
    return per.get(key);
  }

  function sample() {
    // Off, with nobody looking at the boxes on the page: nothing to measure.
    if (!cfg.armed && !lookingOf()) {
      for (const st of per.values()) Object.assign(st, { prev: null, heat: [], streak: 0 });
      return;
    }
    const views = safeViews();
    const keys = new Set(views.map((v) => v.key));
    for (const [key, st] of per) {
      if (keys.has(key)) continue;
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
      // What the page shows as moving: each box's movement, fading over a few looks (the page
      // sees this twice a second).
      st.heat = st.levels.map((l, i) => Math.max(l, (st.heat.length === st.levels.length ? st.heat[i] : 0) * HEAT_FADE));
      const off = excludedOf(v.key);
      const need = SENSITIVITY[cfg.sensitivity];
      const hot = st.levels.some((l, i) => !off.has(i) && l >= need);
      st.streak = hot ? st.streak + 1 : 0;
      if (!hot) st.loose = 0;
      // An OAK camera's objects come with every picture: its animals remembered even before they move.
      if (cfg.armed && cfg.ignoreAnimals && v.objects && st.streak < STREAK) {
        const objects = v.objects();
        if (objects) remember(st, objects, v.rotation ? v.rotation() : 0);
      }
      if (cfg.armed && st.streak >= STREAK) consider(v, st, off, need);
      if (st.session && performance.now() - st.session.lastMovedAt > STILL_S * 1000) endSession(v.key, st);
      else if (st.session && st.session.rec && st.session.rec.elapsed() > MAX_VIDEO_S) endSession(v.key, st);
    }
  }

  // Movement in a watched box: an alert (or more of one going on), unless it's an animal's.
  // An OAK camera finds objects itself (in its own picture, before it's turned); if it isn't
  // (its object finder couldn't run alongside the hands), the app's object finder looks at the
  // picture as shown, as for any other camera.
  async function consider(v, st, off, need) {
    if (cfg.ignoreAnimals) {
      if (st.finding) return;
      let objects = v.objects ? v.objects() : null;
      let rotation = objects && v.rotation ? v.rotation() : 0;
      const loose = objects ? OAK_LOOSE_STREAK : LOOSE_STREAK; // (the app's finder looks at this very picture)
      if (!objects) {
        st.finding = true;
        try {
          objects = await findObjects(v.frame());
        } finally {
          st.finding = false;
        }
        rotation = 0;
      }
      if (objects === undefined) return; // the object finder isn't ready: not yet
      if (objects) {
        if (animalsOnly(st, objects, rotation, off, need, cfg.rows, cfg.cols)) {
          st.loose = 0;
          st.ignoredAt = Date.now();
          return;
        }
        // Not (all) an animal's: it counts once it's so a moment longer.
        st.loose = (st.loose || 0) + 1;
        if (st.loose < loose && !st.session) return;
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
    if (cfg.ntfy.on) {
      sendNtfy(ev, jpeg)
        .then(() => ev.sent.push("ntfy"))
        .catch((err) => (ev.ntfyError = errText(err)));
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
      return;
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
  }

  // Alerts deleted, with their photos and videos in the remote recording folder (ids: those
  // alerts; null: every alert, and every Sentry photo and video there, older ones too).
  async function deleteSaved(ids) {
    const gone = ids ? events.filter((e) => ids.includes(e.id)) : events.slice();
    if (ids && !gone.length) return { ok: false, message: "That alert isn't there any more." };
    const names = [];
    for (const e of gone) for (const f of [e.photo, e.video]) if (f && !f.download && f.name) names.push(f.name);
    const del = host && host.remote && host.remote.deleteSentry;
    let n = 0;
    if (!ids || names.length) {
      if (!del) return { ok: false, message: "This Hand Tracker can't delete its files: update it." };
      let res;
      try {
        res = await del(ids ? { names } : { all: true });
      } catch (err) {
        return { ok: false, message: `Couldn't delete them: ${errText(err)}` };
      }
      n = res.deleted || 0;
      if (res.failed && res.failed.length) return { ok: false, message: `Deleted ${n}; ${res.failed.length} couldn't be: ${res.failed[0]}` };
    }
    for (const e of gone) {
      const i = events.indexOf(e);
      if (i >= 0) events.splice(i, 1);
      for (const s of per.values()) if (s.session && s.session.event === e) s.session.event = null; // its video: not an alert's any more
    }
    const what = ids ? (gone.length === 1 ? "The alert" : `${gone.length} alerts`) : "Every Sentry photo and video";
    return { ok: true, message: `${what} deleted${n ? ` (${n} file${n === 1 ? "" : "s"})` : ""}.` };
  }

  // Saved into the remote recording folder (the desktop app, the phone app), else downloaded.
  // -> { name }
  async function saveFile(baseName, suffix, ext, blob) {
    const data = new Uint8Array(await blob.arrayBuffer());
    if (host && host.remote && host.remote.saveTake) {
      const res = await host.remote.saveTake({ baseName, files: [{ format: ext, suffix, ext, data }] });
      const r = (res.results || [])[0];
      if (!r || !r.ok) throw new Error((r && r.error) || "It couldn't be saved.");
      return { name: r.path.split(/[\\/]/).pop(), dir: res.dir };
    }
    const name = `${baseName}${suffix}.${ext}`;
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { name, download: true };
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

  // A box as shown (mirrored or not) -> the same box in the camera's own picture.
  function toCamera(shown, mirrored, cols = cfg.cols) {
    if (!mirrored) return shown;
    const r = Math.floor(shown / cols), c = shown % cols;
    return r * cols + (cols - 1 - c);
  }

  // ---------- on and off, and what the page sees ----------
  // Watching runs while Sentry is on, or shown on the page (its boxes show what moves).
  function running() {
    const want = cfg.armed || cfg.shown;
    if (want && !timer) timer = setInterval(sample, SAMPLE_MS);
    if (!want && timer) {
      clearInterval(timer);
      timer = null;
      for (const [key, st] of per) if (st.session) endSession(key, st);
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
    if (cfg.armed && cfg.ignoreAnimals && global.ObjectFinder && global.ObjectFinder.load) global.ObjectFinder.load().catch(() => {});
  }

  const wantsMotion = () => !!cfg && (cfg.armed || cfg.shown);
  const wantsObjects = () => !!cfg && cfg.armed && cfg.ignoreAnimals;
  function notifyWants() {
    const key = `${wantsMotion()}${wantsObjects()}`;
    if (key === notifyWants.last) return;
    notifyWants.last = key;
    onWantsChange();
  }

  function statusText(views) {
    const n = views.length;
    const recording = [...per.values()].filter((s) => s.session && s.session.rec).length;
    if (!cfg.armed) return n ? "Off. Tap a box to leave it out: the rest are watched once Sentry is on." : "Off. Start the cameras to see their boxes.";
    if (!n) return "On, but no camera is running.";
    return `Watching ${n} camera${n === 1 ? "" : "s"}${recording ? ` · recording ${recording}` : ""}.${finderNote ? ` ${finderNote}` : ""}`;
  }

  // For remote recording's page (and the Hand Tracker app watching for alerts). While Sentry is
  // hidden and off, only that.
  function remoteState() {
    if (!cfg) return null;
    if (!cfg.shown && !cfg.armed) return { shown: false, armed: false };
    const views = safeViews();
    const need = SENSITIVITY[cfg.sensitivity];
    const boxes = cfg.rows * cfg.cols;
    return {
      shown: cfg.shown, armed: cfg.armed, rows: cfg.rows, cols: cfg.cols, sensitivity: cfg.sensitivity,
      ignoreAnimals: cfg.ignoreAnimals, photo: cfg.photo, video: cfg.video, sound: cfg.sound,
      ntfy: { on: cfg.ntfy.on, server: cfg.ntfy.server, topic: cfg.ntfy.topic, photo: cfg.ntfy.photo },
      note: statusText(views),
      canDelete: !!(host && host.remote && host.remote.deleteSentry), // its photos and videos, from the page
      // Each camera's boxes as its preview shows them (mirrored or not): left out, and moving.
      cameras: views.map((v) => {
        const off = excludedOf(v.key), st = per.get(v.key), mirrored = !!(v.mirrored && v.mirrored());
        const shownOff = [], hot = [];
        for (let shown = 0; shown < boxes; shown++) {
          const cell = toCamera(shown, mirrored);
          if (off.has(cell)) shownOff.push(shown);
          else if (st && (st.heat[cell] || 0) >= need) hot.push(shown);
        }
        return { index: v.index, name: v.name, off: shownOff, hot, recording: !!(st && st.session && st.session.rec) };
      }),
      events: events.slice(0, 20).map((e) => ({
        id: e.id, at: e.at, camera: e.camera,
        photo: e.photo && !e.photo.download ? e.photo.name : null, video: e.video && !e.video.download ? e.video.name : null, seconds: e.seconds || 0,
        problem: [e.photoError && `no photo (${e.photoError})`, e.videoError && `no video (${e.videoError})`, e.ntfyError && `ntfy: ${e.ntfyError}`].filter(Boolean).join(" · "),
      })),
    };
  }

  // From the page (the server has checked each part already; checked again here).
  async function command(c = {}) {
    let message = "";
    if (typeof c.shown === "boolean") cfg.shown = c.shown;
    if (c.rows !== undefined) cfg.rows = clamp(c.rows, 1, MAX_ROWS, cfg.rows);
    if (c.cols !== undefined) cfg.cols = clamp(c.cols, 1, MAX_COLS, cfg.cols);
    if (SENSITIVITY[c.sensitivity]) cfg.sensitivity = c.sensitivity;
    for (const k of ["ignoreAnimals", "photo", "video", "sound"]) if (typeof c[k] === "boolean") cfg[k] = c[k];
    if (c.ntfy && typeof c.ntfy === "object") {
      const n = { ...cfg.ntfy };
      if (typeof c.ntfy.on === "boolean") n.on = c.ntfy.on;
      if (typeof c.ntfy.photo === "boolean") n.photo = c.ntfy.photo;
      if (typeof c.ntfy.server === "string") n.server = /^https?:\/\/[^\s/]+/i.test(c.ntfy.server.trim()) ? c.ntfy.server.trim().replace(/\/+$/, "") : "https://ntfy.sh";
      if (c.ntfy.newTopic === true) n.topic = newTopic();
      n.server = serverOnly(n.server, n.topic);
      cfg.ntfy = n;
    }
    if (c.box && typeof c.box === "object") {
      const v = safeViews().find((x) => x.index === c.box.camera);
      if (!v) return { ok: false, message: "That camera isn't running." };
      const shown = Number(c.box.cell);
      if (!Number.isInteger(shown) || shown < 0 || shown >= cfg.rows * cfg.cols) return { ok: false, message: "No such box." };
      const set = excludedOf(v.key), cell = toCamera(shown, !!(v.mirrored && v.mirrored()));
      if (c.box.off) set.add(cell);
      else set.delete(cell);
      setExcluded(v.key, set);
    }
    if (c.watchAll === true) {
      for (const v of safeViews()) setExcluded(v.key, new Set());
      message = "Every box is watched.";
    }
    if (Array.isArray(c.deleteAlerts) || c.deleteAll === true) {
      const r = await deleteSaved(c.deleteAll === true ? null : c.deleteAlerts.filter((id) => typeof id === "string"));
      if (!r.ok) return r;
      message = r.message;
    }
    if (typeof c.armed === "boolean" && c.armed !== cfg.armed) {
      setArmed(c.armed);
      message = cfg.armed ? "Sentry is on." : "Sentry is off.";
    } else if (c.ignoreAnimals === true && cfg.armed) {
      setArmed(true); // the object finder, made ready
    }
    save();
    running();
    notifyWants();
    if (c.ntfy && c.ntfy.test === true) {
      try {
        await sendNtfy({ at: Date.now(), camera: "Test", photo: null, sent: [] }, null);
        message = "Sent: it should be on your phone in a moment.";
      } catch (err) {
        return { ok: false, message: `Couldn't send it: ${errText(err)}` };
      }
    }
    return { ok: true, message };
  }

  function init(opts) {
    prefs = opts.prefs || {};
    setPref = opts.setPref || setPref;
    viewsOf = opts.views || viewsOf;
    host = opts.host || null;
    onWantsChange = opts.onWantsChange || onWantsChange;
    hostName = opts.hostName || hostName;
    linkOf = opts.link || linkOf;
    lookingOf = opts.looking || lookingOf;
    load();
    notifyWants.last = `${wantsMotion()}${wantsObjects()}`;
    if (cfg.armed) setArmed(true);
    running();
  }

  global.Sentry = {
    init, wantsMotion, wantsObjects, remoteState, command,
    isArmed: () => !!cfg && cfg.armed,
    _test: { shrink, blur, moved, levels, turn, turnBox, withoutAnimals, animalsOnly, serverOnly, sample, events, per, toCamera, config: () => cfg },
  };
})(typeof window !== "undefined" ? window : globalThis);
