/**
 * remote-record.js — start and stop motion capture on this computer from a phone's browser
 * (Windows and Linux app; made for a camera rig, a Raspberry Pi say, with nobody at its
 * screen). While "Remote recording" is on, a small web server on the local network (and on
 * Tailscale, if this computer is on it) serves a page (remote-client.html and .js) with the
 * cameras it can start, the mode, Start/Stop, each camera's status and a live preview of each
 * camera; the Android app and the Windows and Linux app use the same page, asking through the
 * app. The main window does the work (remote-record-ui.js): this only passes things along.
 *
 * Over Tailscale no code is needed: only your own devices can reach this computer there, and
 * Tailscale encrypts everything, so a phone with Tailscale on just opens http://<name>:47821
 * (a Raspberry Pi with no screen, say). On the local network the page's address carries a
 * random key (shown here as a QR code), and every request must carry it, so only a phone that
 * has read the code can see the cameras or start anything. That page is plain HTTP, like most
 * devices' own pages on a home network: the key and the previews aren't encrypted on the way.
 * A phone on this computer's own hotspot (a Raspberry Pi's, pi/hotspot-setup.sh: the computer
 * is 10.42.0.1 on it) needs no code either: the hotspot's password is what keeps others out. Phones there
 * and over Tailscale (both encrypted on the way) can also see the Wi-Fi networks around and
 * have this computer join one (wifi, from main.js: NetworkManager's), password and all.
 * Without the key, a request must be addressed to this computer by its own name or address (so
 * a website can't reach it through a name of its own, "DNS rebinding"), and a command must
 * come from the page itself (JSON, from this address: not a form another website sends).
 *
 *   const remote = new RemoteRecordServer({ keyStore, page: (name) => text, host, ask, onWantPreviews, wifi, hotspot });
 *     wifi: { available(), status() -> { connecting, last }, list() -> { current, networks },
 *             connect(ssid, password) -> { ok, message } } or null; hotspot() -> its address or null
 *     (page("html") / page("js"): remote-client.html / remote-client.js)
 *   await remote.start();   // -> status { on, port, addresses: [{ address, kind }], urls: [{ kind, url, keyed }], viewer }
 *   remote.on("status", (s) => …); remote.newKey(); remote.stop();
 *   remote.setState(state); // what the page shows, from the main window (about twice a second)
 *   remote.setPreview(i, jpeg); // camera i's latest preview (only sent while a page asks for them)
 *
 * ask(action, { details, camera, pick, mode, settings }) -> Promise<{ ok, message }>: the main
 * window carries out "cameras" (start the cameras), "record" (start recording, starting the
 * cameras first if need be), "stop" (stop and save the take), "close" (stop the cameras),
 * "details" (only the take details: { contributor, location, task }, which any request can
 * bring along, and which go into the takes), "camera" (one running camera's { index, role,
 * rotation, mirror }), "scan" (look for the cameras it can start), "pick" (one of those:
 * { id, use, role }), "mode" ("ego", "stereo" or "freeform") or "settings" ({ detailsRequired, screenPictures,
 * video, sound, videoQuality, photo }: whether the take details are needed, whether the OAK cameras' pictures
 * are drawn on its screen, each camera's video with a take, its sound and its quality, and each
 * camera's photo as a take starts),
 * "sentry" (Sentry mode's settings, boxes and on/off: cleanSentry), "oak" (one OAK camera's own
 * settings: cleanOak) or "kinect" (one Kinect's own settings: cleanKinect).
 * onWantPreviews({ on, focus }): a page is (or stopped) looking at the previews; focus: the
 * camera one is looking at full screen (null for none), which then comes bigger
 * (/api/preview?i=N&full=1). Each preview request waits for that camera's next picture; each
 * picture is numbered (its type is "image/jpeg; seq=N"), and a page asking with &after=N gets the
 * first after that, so it can have a few requests on their way at once (full screen, faster).
 * keyStore: { load() -> key | null, save(key) } (main.js keeps it encrypted by the OS).
 *
 * takes: () => the remote recording folder (or null: none listed). Its takes (each the files
 * saved for it) are listed at /api/takes, downloaded in slices (/api/take?f=<file>&at=<byte>:
 * every way of reaching this computer carries those, the apps' included), and deleted by the
 * "deleteTakes" command only with each file's size and CRC32 as a page received them, which
 * must match the files here (so a take is deleted only once it's safely on that device). A take's
 * details can be changed after recording: "takeDetails" ({ take: { id } }) gives them, and
 * "editTake" ({ take: { id, details } }) changes them in its files and renames them to match
 * (take-names.js); editTake(id, details) does the same for this computer's own screen.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const http = require("http");
const os = require("os");
const { EventEmitter } = require("events");
const TakeNames = require("../take-names.js");
// (MCAP files' metadata, read and changed only when a take's details are: mcap-video.js)
const readMetadata = (...a) => require("./mcap-video.js").readMetadata(...a);
const setMetadata = (...a) => require("./mcap-video.js").setMetadata(...a);

const FIRST_PORT = 47821;
const PORTS_TRIED = 10;
const PREVIEW_WANTED_MS = 3000; // previews are made while a page asked for one this recently
const FOCUS_MS = 1500; // a camera stays full screen while a page asked for it this recently
const NEXT_WAIT_MS = 400; // a preview request waits this long for that camera's next picture
const PREVIEW_STALE_MS = 5000; // an older preview isn't shown (that camera stopped)
const VIEWER_GONE_MS = 10000;
const ACTIONS = new Set(["cameras", "record", "stop", "close", "details", "camera", "scan", "pick", "mode", "settings", "wifi", "deleteTakes", "takeDetails", "editTake", "sentry", "oak", "kinect", "resetCameras", "reboot", "powerOff", "timing"]);
const DETAILS = ["contributor", "location", "task"];
const DETAIL_CHARS = 200;
const ROLES = ["", "head", "chest", "wrist_left", "wrist_right", "north", "south", "east", "west"]; // (camera-roles.js's)
const MODES = ["ego", "stereo", "freeform"];
const VIDEO_QUALITIES = ["low", "standard", "high", "best"]; // (camera-video.js's)
// The page's script and style are its own (nothing inline); pictures come as blobs.
// What the apps may ask another computer's Hand Tracker for, for its remote recording page
// (a page can't reach a device on the network itself): a computer by name or address and port,
// and only the page's own requests (its state, a command, a camera's preview, the Wi-Fi
// networks, the takes and a slice of one). The one list: main.js and the Android checks' stand-in
// use it, and the checks compare RemotePlugin.java's copy (Java can't load this) with it.
const RIG_HOST = /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*):(\d{1,5})$/i;
const RIG_PATH = /^\/api\/(state|command|wifi|takes|preview\?i=[0-3](&full=1(&after=\d{1,12})?)?|take\?f=[A-Za-z0-9%._~!*'()-]{1,800}&at=\d{1,12})$/;

const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src blob:; media-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'";

// The take details from a request: those three, as short single-line text.
function cleanDetails(d) {
  if (!d || typeof d !== "object") return null;
  return Object.fromEntries(DETAILS.map((k) => [k, String(d[k] == null ? "" : d[k]).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, DETAIL_CHARS)]));
}

// One camera's settings from a request: which (0-3), and any of role, rotation and mirror.
function cleanCamera(c) {
  if (!c || typeof c !== "object" || !Number.isInteger(c.index) || c.index < 0 || c.index > 3) return null;
  const out = { index: c.index };
  if (ROLES.includes(c.role)) out.role = c.role;
  if ([0, 90, 180, 270].includes(c.rotation)) out.rotation = c.rotation;
  if (typeof c.mirror === "boolean") out.mirror = c.mirror;
  return out;
}

// A camera to start, from a request: its id ("oak:<id>" or a webcam's), and whether to use it
// and its role.
function cleanPick(p) {
  if (!p || typeof p !== "object" || typeof p.id !== "string" || !/^[A-Za-z0-9:._+/=-]{1,200}$/.test(p.id)) return null;
  const out = { id: p.id };
  if (typeof p.use === "boolean") out.use = p.use;
  if (typeof p.tracking === "boolean") out.tracking = p.tracking;
  if (ROLES.includes(p.role)) out.role = p.role;
  return out;
}
// One OAK camera's own settings, from a request: which ("oak:<id>"), and any of its hand model,
// one or two hands, depth, frame rate, finding objects, picture, night vision and infrared dots.
const OAK_CHOICES = { model: ["lite", "full"], hands: [1, 2], fps: [0, 60], picture: ["color", "depth", "blend", "side", "left", "right"], night: ["auto", "on", "off"] };
function cleanOak(o) {
  if (!o || typeof o !== "object" || typeof o.id !== "string" || !/^oak:[A-Za-z0-9._-]{1,64}$/.test(o.id) || !o.options || typeof o.options !== "object") return null;
  const options = {};
  for (const [k, allowed] of Object.entries(OAK_CHOICES)) if (allowed.includes(o.options[k])) options[k] = o.options[k];
  for (const k of ["depth", "detect", "dots"]) if (typeof o.options[k] === "boolean") options[k] = o.options[k];
  return Object.keys(options).length ? { id: o.id, options } : null;
}
// A Kinect's own settings (multi-camera.js's KINECT_OWN).
const KINECT_CHOICES = { model: ["lite", "full"], hands: [1, 2], picture: ["color", "depth", "blend", "side"], night: ["auto", "on", "off"], size: ["960x540", "1440x810", "1920x1080"],
  people: [1, 2, 3, 4, 5, 6], exposure: [-2, -1, 0, 1, 2], led: ["on", "dim", "off"], range: [3, 4.5, 8], processing: ["auto", "gpu", "cpu"] };
const KINECT_SWITCHES = ["bodies", "faces", "depth", "filters", "saveDepth", "saveColor", "saveSound", "mics"];
function cleanKinect(o) {
  if (!o || typeof o !== "object" || typeof o.id !== "string" || !/^kinect:[A-Za-z0-9._-]{1,64}$/.test(o.id) || !o.options || typeof o.options !== "object") return null;
  const options = {};
  for (const [k, allowed] of Object.entries(KINECT_CHOICES)) if (allowed.includes(o.options[k])) options[k] = o.options[k];
  for (const k of KINECT_SWITCHES) if (typeof o.options[k] === "boolean") options[k] = o.options[k];
  return Object.keys(options).length ? { id: o.id, options } : null;
}
const cleanMode = (m) => (MODES.includes(m) ? m : null);
// A Wi-Fi network to join: its name (1 to 32 bytes) and password (none, or 8 to 63 characters).
// The Wi-Fi asked of it: join a network now, save one (to join by itself later), forget a saved
// one, or hotspot mode on or off.
function cleanWifi(w) {
  if (!w || typeof w !== "object") return null;
  const op = w.op === undefined ? "join" : w.op;
  if (op === "hotspot") return typeof w.on === "boolean" ? { op, on: w.on } : null;
  if (!["join", "save", "forget"].includes(op) || typeof w.ssid !== "string") return null;
  const ssid = w.ssid, password = op !== "forget" && typeof w.password === "string" ? w.password : "";
  if (!ssid || Buffer.byteLength(ssid) > 32 || /[\u0000-\u001f\u007f]/.test(ssid)) return null;
  if (password && (password.length < 8 || password.length > 63 || /[\u0000-\u001f\u007f]/.test(password))) return null;
  return { op, ssid, password };
}
function cleanSettings(s) {
  if (!s || typeof s !== "object") return null;
  const out = {};
  for (const k of ["detailsRequired", "screenPictures", "video", "sound", "photo"]) if (typeof s[k] === "boolean") out[k] = s[k];
  if (VIDEO_QUALITIES.includes(s.videoQuality)) out.videoQuality = s.videoQuality;
  return Object.keys(out).length ? out : null;
}

// Sentry mode from the page (sentry.js): shown or not, on or off, its settings, a box of a
// running camera left out or watched again, or every box watched; ntfy's server (a web address),
// a new topic or a test. Only those, each checked.
const SENTRY_FLAGS = ["shown", "armed", "ignoreAnimals", "handTracking", "photo", "video", "sound"];
function cleanSentry(s) {
  if (!s || typeof s !== "object") return null;
  const out = {};
  for (const k of SENTRY_FLAGS) if (typeof s[k] === "boolean") out[k] = s[k];
  if (Number.isInteger(s.rows) && s.rows >= 1 && s.rows <= 9) out.rows = s.rows;
  if (Number.isInteger(s.cols) && s.cols >= 1 && s.cols <= 16) out.cols = s.cols;
  if (["low", "medium", "high"].includes(s.sensitivity)) out.sensitivity = s.sensitivity;
  if (s.ntfy && typeof s.ntfy === "object") {
    const n = {};
    for (const k of ["on", "photo"]) if (typeof s.ntfy[k] === "boolean") n[k] = s.ntfy[k];
    for (const k of ["newTopic", "test"]) if (s.ntfy[k] === true) n[k] = true;
    if (typeof s.ntfy.server === "string" && s.ntfy.server.length <= 200 && /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(s.ntfy.server.trim())) n.server = s.ntfy.server.trim();
    if (Object.keys(n).length) out.ntfy = n;
  }
  const b = s.box;
  if (b && typeof b === "object" && Number.isInteger(b.camera) && b.camera >= 0 && b.camera < 16 && Number.isInteger(b.cell) && b.cell >= 0 && b.cell < 9 * 16 && typeof b.off === "boolean") {
    out.box = { camera: b.camera, cell: b.cell, off: b.off };
  }
  if (s.watchAll === true) out.watchAll = true;
  // Alerts deleted, with their photos and videos; or every Sentry photo and video.
  const ids = s.deleteAlerts;
  if (Array.isArray(ids) && ids.length >= 1 && ids.length <= 50 && ids.every((id) => typeof id === "string" && /^\d{1,15}-[a-z0-9]{1,8}$/.test(id))) out.deleteAlerts = [...ids];
  if (s.deleteAll === true) out.deleteAll = true;
  return Object.keys(out).length ? out : null;
}

// Tailscale's addresses: 100.64.0.0/10.
// ---------- the takes in the remote recording folder ----------
// A take is the files saved for it: its name, then "-left"/"-right" (BVH), "-motive" (Motive's
// markers), "-video-<role>" (a camera's video), "-photo-<role>" (its photo as the take started),
// and " (2)" if the name was taken; the formats
// Hand Tracker saves, and a Kinect's "-depth-<role>", "-infrared-<role>", "-colour-<role>" (.mkv),
// "-sound-<role>", "-sound-beam-<role>" (.wav) with their "-times" (.csv), "-kinect-<role>" (.mcap). Sentry mode's photo and
// video of a moment are a take too.
const TAKE_FILE = /^[^/\\:*?"<>|\u0000-\u001f]{1,240}\.(json|csv|bvh|glb|c3d|trc|npz|mcap|webm|mp4|jpg|mkv|wav)$/i;
const TAKE_SLICE = 2 << 20; // bytes per download request (the apps carry up to 4 MB an answer)
const MAX_TAKES = 500;
const EDIT_QUIET_MS = 8000; // a take whose files were written this recently may still be being saved
const EDIT_MCAP_MAX = 400e6; // an MCAP file read for a take's details (one with its videos can be big)
const takeOf = (file) =>
  file.replace(/\.[a-z0-9]+$/i, "").replace(/ \(\d+\)$/, "").replace(/-(depth|infrared|colour|kinect|sound(-beam|-direction)?)-[a-z0-9-]+?(-times)?( \(\d+\))?$/i, "")
    .replace(/-(video|photo)(-[a-z0-9-]+)?$/i, "").replace(/(-motive)?(-left|-right)?$/, "");

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
async function fileCrc(file) {
  let crc = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) crc = crc32(chunk, crc);
  return crc;
}

class Takes {
  constructor(folder) {
    this.folder = folder;
    this.edited = new Map(); // take -> when its files were last written by a change of its details here
  }
  // -> [{ id, at (ms, its newest file), size, files: [{ name, size }] }], newest first.
  async all() {
    const dir = this.folder();
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const byId = new Map();
    for (const e of entries) {
      if (!e.isFile() || !TAKE_FILE.test(e.name)) continue;
      let st;
      try {
        st = await fs.promises.stat(path.join(dir, e.name));
      } catch {
        continue;
      }
      const id = takeOf(e.name);
      const t = byId.get(id) || { id, at: 0, size: 0, files: [] };
      t.files.push({ name: e.name, size: st.size });
      t.size += st.size;
      t.at = Math.max(t.at, st.mtimeMs);
      byId.set(id, t);
    }
    for (const t of byId.values()) t.files.sort((a, b) => a.name.localeCompare(b.name));
    return [...byId.values()].sort((a, b) => b.at - a.at);
  }
  async list() {
    const all = await this.all();
    return { takes: all.slice(0, MAX_TAKES), more: Math.max(0, all.length - MAX_TAKES) };
  }
  // A file of a take, by its name (in the folder itself, nowhere else), from byte at.
  async slice(name, at) {
    if (!TAKE_FILE.test(name) || !Number.isInteger(at) || at < 0) return null;
    let fh;
    try {
      fh = await fs.promises.open(path.join(this.folder(), name), "r");
      const st = await fh.stat();
      if (!st.isFile()) return null;
      const buf = Buffer.alloc(Math.max(0, Math.min(TAKE_SLICE, st.size - at)));
      const { bytesRead } = await fh.read(buf, 0, buf.length, at);
      return buf.subarray(0, bytesRead);
    } catch {
      return null;
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }
  // Its files: those listed for it, and the others named after it (Annotate's <take>.annotations.json).
  async filesOf(id) {
    let names = [];
    try {
      names = await fs.promises.readdir(this.folder());
    } catch {
      return [];
    }
    return names.filter((n) => TAKE_FILE.test(n) && (takeOf(n) === id || n.startsWith(`${id}.`)));
  }

  // The details a take was saved with: from its JSON (the capture's metadata), else its MCAP
  // file's ("hand_tracker"), else none. -> { ok, details } or { ok: false, message }
  async details(id) {
    const files = await this.filesOf(id);
    if (!files.length) return { ok: false, message: "That take isn't there any more." };
    const dir = this.folder();
    const pick = (m) => Object.fromEntries(DETAILS.map((k) => [k, String((m && m[k]) || "")]));
    for (const name of files.filter((n) => /\.json$/i.test(n)).sort((a, b) => a.length - b.length)) {
      try {
        const m = JSON.parse(await fs.promises.readFile(path.join(dir, name), "utf8")).metadata;
        if (m && typeof m === "object") return { ok: true, details: pick(m) };
      } catch {
        // (not a capture's JSON)
      }
    }
    for (const name of files.filter((n) => /\.mcap$/i.test(n))) {
      try {
        const st = await fs.promises.stat(path.join(dir, name));
        if (st.size > EDIT_MCAP_MAX) continue;
        const m = readMetadata(path.join(dir, name), "hand_tracker");
        if (m) return { ok: true, details: pick(m) };
      } catch {
        // (unreadable: none from it)
      }
    }
    return { ok: true, details: pick(null) };
  }

  // A take's details changed after recording: in its files (its JSON's metadata, its MCAP file's
  // "hand_tracker" record, a TRC file's own name inside it), then every file renamed to match
  // (take-names.js: its length and time kept). Not while it's being saved (busy: the computer is
  // in the middle of a step, or one of its files was written in the last few seconds).
  // -> { ok, id (its name now), message }
  async edit(id, wanted, busy = false) {
    const dir = this.folder();
    const files = await this.filesOf(id);
    if (!files.length) return { ok: false, message: "That take isn't there any more." };
    const d = Object.fromEntries(DETAILS.map((k) => [k, String((wanted && wanted[k]) || "")]));
    const next = TakeNames.renamed(id, d);
    if (!next) return { ok: false, message: "This take's name isn't one Hand Tracker gave it, so its details can't be changed here." };
    let all = [];
    try {
      all = await fs.promises.readdir(dir);
    } catch {
      return { ok: false, message: "The takes folder can't be read." };
    }
    const newest = Math.max(...(await Promise.all(files.map((n) => fs.promises.stat(path.join(dir, n)).then((s) => s.mtimeMs, () => 0)))));
    // (written just now by a change here, not a save: it can be changed again at once)
    const ours = newest <= (this.edited.get(id) || 0);
    if (busy || (!ours && Date.now() - newest < EDIT_QUIET_MS) || all.some((n) => n.startsWith(`.${id}`) && n.endsWith(".tmp"))) {
      return { ok: false, message: "It's still being saved: try again in a moment." };
    }
    const moves = files.map((n) => [n, next + n.slice(id.length)]);
    const taken = new Set(all);
    if (next !== id && moves.some(([, to]) => taken.has(to))) return { ok: false, message: "A take with those details and that time is there already." };
    try {
      for (const [from, to] of moves) {
        const file = path.join(dir, from);
        if (/\.json$/i.test(from)) {
          let data = null;
          try {
            data = JSON.parse(await fs.promises.readFile(file, "utf8"));
          } catch {
            data = null; // (not JSON Hand Tracker can read: renamed only)
          }
          if (data && data.metadata && typeof data.metadata === "object") {
            Object.assign(data.metadata, d);
            await writeInPlace(file, JSON.stringify(data, null, 2));
          }
        } else if (/\.mcap$/i.test(from)) {
          setMetadata(file, "hand_tracker", d);
        } else if (/\.trc$/i.test(from) && to !== from) {
          const text = await fs.promises.readFile(file, "utf8");
          const fixed = text.replace(/^(PathFileType\t4\t\(X\/Y\/Z\)\t).*$/m, (_, head) => head + to);
          if (fixed !== text) await writeInPlace(file, fixed);
        }
      }
    } catch (err) {
      return { ok: false, message: `Its details couldn't be changed: ${err.message}` };
    }
    const done = [];
    try {
      for (const [from, to] of moves) {
        if (from === to) continue;
        await fs.promises.rename(path.join(dir, from), path.join(dir, to));
        done.push([from, to]);
      }
    } catch (err) {
      // Put back as it was (its details inside are the new ones either way).
      for (const [from, to] of done.reverse()) await fs.promises.rename(path.join(dir, to), path.join(dir, from)).catch(() => {});
      return { ok: false, message: `Its files couldn't be renamed: ${err.message}` };
    }
    // (When its files were last written by a change here.)
    const at = Math.max(...(await Promise.all(moves.map(([, to]) => fs.promises.stat(path.join(dir, to)).then((s) => s.mtimeMs, () => 0)))));
    this.edited.delete(id);
    this.edited.set(next, at);
    if (this.edited.size > 50) this.edited.delete(this.edited.keys().next().value);
    return { ok: true, id: next, renamed: done.length, message: next === id ? "Its details are changed." : `Its details are changed, and it's now ${next}.` };
  }

  // Deletes the takes whose every file a page has, as it received them:
  // [{ id, files: [{ name, size, crc }] }]; each file's size and CRC32 must match the one here.
  async remove(wanted) {
    const all = new Map((await this.all()).map((t) => [t.id, t]));
    const deleted = [], refused = [];
    for (const w of wanted) {
      const t = all.get(w.id);
      if (!t) {
        refused.push({ id: w.id, why: "It isn't there any more." });
        continue;
      }
      const sent = new Map(w.files.map((f) => [f.name, f]));
      if (t.files.length !== sent.size || !t.files.every((f) => sent.has(f.name))) {
        refused.push({ id: w.id, why: "It has files this device didn't get: download it again." });
        continue;
      }
      let whole = true;
      for (const f of t.files) {
        const got = sent.get(f.name);
        if (got.size !== f.size || got.crc !== (await fileCrc(path.join(this.folder(), f.name)))) whole = false;
      }
      if (!whole) {
        refused.push({ id: w.id, why: "Not every file arrived intact: download it again." });
        continue;
      }
      try {
        for (const f of t.files) await fs.promises.unlink(path.join(this.folder(), f.name));
        deleted.push(w.id);
      } catch (err) {
        refused.push({ id: w.id, why: err.message });
      }
    }
    const n = deleted.length;
    return { ok: !refused.length, deleted, refused, message: `Deleted ${n} take${n === 1 ? "" : "s"}${refused.length ? `; ${refused.length} not` : ""}.` };
  }
}
// A file written again: beside it first, then put in its place.
async function writeInPlace(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  await fs.promises.writeFile(tmp, text);
  await fs.promises.rename(tmp, file);
}

// A take whose details a page asks for, or changes: { id[, details] }.
function cleanTake(t) {
  if (!t || typeof t.id !== "string" || !t.id || t.id.length > 240 || /[/\\]/.test(t.id)) return null;
  return t.details === undefined ? { id: t.id } : { id: t.id, details: cleanDetails(t.details) || cleanDetails({}) };
}

// The takes a page asks to delete, with what it received of each file.
function cleanTakes(list) {
  if (!Array.isArray(list) || !list.length || list.length > 20) return null;
  const out = [];
  for (const t of list) {
    if (!t || typeof t.id !== "string" || !t.id || t.id.length > 240 || !Array.isArray(t.files) || !t.files.length || t.files.length > 24) return null;
    const files = [];
    for (const f of t.files) {
      if (!f || typeof f.name !== "string" || !TAKE_FILE.test(f.name) || !Number.isInteger(f.size) || f.size < 0 || !Number.isInteger(f.crc) || f.crc < 0 || f.crc > 0xffffffff) return null;
      files.push({ name: f.name, size: f.size, crc: f.crc });
    }
    out.push({ id: t.id, files });
  }
  return out;
}

function isTailscale(address) {
  const [p, q] = String(address || "").replace(/^::ffff:/, "").split(".").map(Number);
  return p === 100 && q >= 64 && q <= 127;
}
// A request that came in over Tailscale, from another device on it (needs no key).
const tailnetPeer = (localAddress, remoteAddress) => isTailscale(localAddress) && isTailscale(remoteAddress);

// This computer's hotspot (pi/hotspot-setup.sh makes it, on the Wi-Fi when that isn't on a
// network): its address while it's on, else null.
const HOTSPOT_ADDR = "10.42.0.1";
function hotspotAddress() {
  const on = Object.values(os.networkInterfaces()).some((list) => (list || []).some((a) => (a.family === "IPv4" || a.family === 4) && a.address === HOTSPOT_ADDR));
  return on ? HOTSPOT_ADDR : null;
}
// The same /24 (a phone on the hotspot, by the address it came from).
const sameNet = (a, b) => String(a).split(".").slice(0, 3).join(".") === String(b).split(".").slice(0, 3).join(".");

// This computer's Bluetooth network (pi/bluetooth-setup.sh makes it, for Android phones): its
// address. A phone on it gets in with the Bluetooth password (X-Bluetooth-Password), not the key.
const BLUETOOTH_ADDR = "10.43.0.1";
const BLUETOOTH_OK_MS = 10 * 60 * 1000; // a phone's password, once checked, for this long

// This computer's addresses a phone could use: the local network's first, then Tailscale's,
// which works from anywhere the phone has Tailscale on.
function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family !== "IPv4" && a.family !== 4) || a.internal || a.address.startsWith("169.254.")) continue;
      const [p, q] = a.address.split(".").map(Number);
      const local = p === 10 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168);
      if (!isTailscale(a.address) && !local) continue;
      const kind = a.address === HOTSPOT_ADDR ? "Hotspot" : a.address === BLUETOOTH_ADDR ? "Bluetooth" : isTailscale(a.address) ? "Tailscale" : /^(wl|wi-?fi|wlan)/i.test(name) ? "Wi-Fi" : "local network";
      out.push({ address: a.address, kind });
    }
  }
  const rank = { Hotspot: 1, Tailscale: 2 };
  return out.sort((a, b) => (rank[a.kind] || 0) - (rank[b.kind] || 0));
}
// The kinds of address a phone needs no code on.
const OPEN_KINDS = new Set(["Tailscale", "Hotspot"]);

// This computer's name on Tailscale ("pi.tailnet-name.ts.net"), from the tailscale command
// (null without it).
function tailscaleName() {
  return new Promise((resolve) => {
    execFile("tailscale", ["status", "--json"], { timeout: 4000, windowsHide: true, maxBuffer: 4 << 20 }, (err, out) => {
      try {
        resolve(err ? null : String(JSON.parse(out).Self.DNSName || "").replace(/\.$/, "") || null);
      } catch {
        resolve(null);
      }
    });
  });
}

const newKey = () => crypto.randomBytes(16).toString("base64url");

class RemoteRecordServer extends EventEmitter {
  constructor({ keyStore, page, host = os.hostname(), ask, onWantPreviews = () => {}, hotspot = hotspotAddress, wifi = null, takes = null, bluetoothPassword = null }) {
    super();
    // Bluetooth: requests the link relays (bluetooth.js) carry this, known only in this app;
    // phones on the Bluetooth network give the password (bluetoothPassword(text) -> its check).
    this.relayToken = crypto.randomBytes(24).toString("hex");
    this.bluetoothPassword = bluetoothPassword;
    this.bluetoothOk = new Map(); // address -> until when its password holds
    this.takes = takes ? new Takes(takes) : null;
    this.hotspot = hotspot;
    this.wifi = wifi;
    this.keyStore = keyStore;
    this.page = page;
    this.host = host;
    this.ask = ask;
    this.onWantPreviews = onWantPreviews;
    this.key = (keyStore && keyStore.load()) || null;
    this.server = null;
    this.port = null;
    this.state = {};
    this.previews = new Map(); // camera index -> { jpeg, at, seq }
    this.previewSeq = new Map(); // camera index -> its last picture's number
    this.focusFrom = new Map(); // camera index -> its first picture's number since full screen
    this.previewWaiters = new Set(); // requests waiting for a camera's next picture
    this.wantUntil = 0;
    this.focus = null; // the camera a page is looking at full screen
    this.focusUntil = 0;
    this.lastSent = new Map(); // camera index -> when the picture last sent was made
    this.wanting = false;
    this.viewer = null; // { address, seen }
    this.timer = null;
    this.tsName = null;
  }

  // The page's addresses: over Tailscale by name (no key needed), then each address of this
  // computer (with the key, except Tailscale's).
  status() {
    const list = this.server ? addresses() : [];
    const urls = [];
    if (this.server && this.tsName && list.some((a) => a.kind === "Tailscale")) urls.push({ kind: "Tailscale", url: `http://${this.tsName}:${this.port}/`, keyed: false });
    for (const a of list) {
      const keyed = !OPEN_KINDS.has(a.kind);
      urls.push({ kind: a.kind, url: `http://${a.address}:${this.port}/${keyed ? `#k=${this.key}` : ""}`, keyed });
    }
    return {
      on: !!this.server,
      port: this.port,
      addresses: list,
      urls,
      viewer: this.viewer && Date.now() - this.viewer.seen < VIEWER_GONE_MS ? this.viewer : null,
    };
  }

  emitStatus() {
    this.emit("status", this.status());
  }

  // A take's details changed (from a page, or this computer's own screen): not while the main
  // window is in the middle of a step (saving a take, say). Every list of takes shown is told.
  async editTake(id, details) {
    const busy = !!(this.state && (this.state.pending || this.state.saving));
    const r = await this.takes.edit(id, details, busy);
    if (r.ok) this.emit("takes", { changed: id, id: r.id });
    return r;
  }

  ensureKey() {
    if (this.key) return;
    this.key = newKey();
    if (this.keyStore) this.keyStore.save(this.key);
  }

  // A new key: pages opened with the old one stop working.
  newKey() {
    this.key = null;
    this.ensureKey();
    this.viewer = null;
    this.emitStatus();
    return this.status();
  }

  async start() {
    if (this.server) return this.status();
    this.ensureKey();
    let lastErr = null;
    for (let port = FIRST_PORT; port < FIRST_PORT + PORTS_TRIED; port++) {
      const server = http.createServer((req, res) => this.handle(req, res).catch((err) => this.send(res, 500, { error: err.message })));
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "0.0.0.0", resolve);
        });
        this.server = server;
        this.port = port;
        break;
      } catch (err) {
        lastErr = err;
        server.close();
      }
    }
    if (!this.server) throw new Error(`No free port for the remote page (${lastErr && lastErr.code}).`);
    tailscaleName().then((name) => {
      this.tsName = name;
      if (name && this.server) this.emitStatus();
    });
    // Previews stop being made once no page has asked for one for a while; the viewer "goes".
    this.timer = setInterval(() => {
      if (this.focus !== null && Date.now() > this.focusUntil) this.setFocus(null);
      if (this.wanting && Date.now() > this.wantUntil) this.setWanting(false);
      if (this.viewer && Date.now() - this.viewer.seen > VIEWER_GONE_MS && !this.viewer.gone) {
        this.viewer.gone = true;
        this.emitStatus();
      }
    }, 1000);
    this.emitStatus();
    return this.status();
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server.closeAllConnections && this.server.closeAllConnections();
    }
    this.server = null;
    this.port = null;
    clearInterval(this.timer);
    this.timer = null;
    this.setWanting(false);
    this.previews.clear();
    this.viewer = null;
    this.emitStatus();
    return this.status();
  }

  setState(state) {
    this.state = state && typeof state === "object" ? state : {};
  }

  setPreview(i, jpeg) {
    if (!(Number.isInteger(i) && i >= 0 && i < 16 && jpeg && jpeg.length)) return;
    const seq = (this.previewSeq.get(i) || 0) + 1;
    this.previewSeq.set(i, seq);
    this.previews.set(i, { jpeg: Buffer.from(jpeg), at: Date.now(), seq });
    for (const check of [...this.previewWaiters]) check();
  }

  // Until camera i's preview is one that's wanted (wanted(preview) -> true), or ms have gone.
  nextPreview(i, wanted, ms) {
    if (wanted(this.previews.get(i))) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.previewWaiters.delete(check);
        resolve();
      };
      const check = () => wanted(this.previews.get(i)) && done();
      const timer = setTimeout(done, ms);
      this.previewWaiters.add(check);
    });
  }

  setFocus(i) {
    if (this.focus === i) return;
    this.focus = i;
    // Newly full screen: its next picture is the bigger one (not the small one already here).
    if (i !== null) {
      this.lastSent.set(i, Date.now());
      this.focusFrom.set(i, (this.previewSeq.get(i) || 0) + 1);
    }
    if (this.wanting) this.onWantPreviews({ on: true, focus: i });
  }

  setWanting(on) {
    if (this.wanting === on) return;
    this.wanting = on;
    this.onWantPreviews({ on, focus: on ? this.focus : null });
  }

  // The names this computer goes by: its addresses, its name, and its Tailscale name.
  ownHost(req) {
    const host = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (!host) return false;
    const names = new Set(["localhost", os.hostname().toLowerCase(), `${os.hostname().toLowerCase()}.local`]);
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) names.add(String(a.address).toLowerCase());
    if (this.tsName) {
      names.add(this.tsName.toLowerCase());
      names.add(this.tsName.toLowerCase().split(".")[0]);
    }
    return names.has(host);
  }

  // Over Tailscale, or on this computer's own hotspot: trusted without the key (addressed to
  // this computer by its own name or address). On the hotspot: to its address, from a phone on it.
  // Over Bluetooth too: relayed by the link (which checked the password), or from a phone on the
  // Bluetooth network that gives the password.
  trusted(req) {
    const local = String(req.socket.localAddress || "").replace(/^::ffff:/, "");
    const remote = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    const hotspot = this.hotspot();
    return (tailnetPeer(req.socket.localAddress, req.socket.remoteAddress) || (!!hotspot && local === hotspot && sameNet(remote, hotspot)) ||
      this.relayed(req) || this.bluetoothPeer(req, local, remote)) && this.ownHost(req);
  }

  // A request the Bluetooth link relayed (from this computer itself, with its token).
  relayed(req) {
    const remote = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    if (remote !== "127.0.0.1" && remote !== "::1") return false;
    const given = Buffer.from(String(req.headers["x-ht-relay"] || ""));
    const token = Buffer.from(this.relayToken);
    return given.length === token.length && crypto.timingSafeEqual(given, token);
  }

  // A phone on this computer's Bluetooth network, with the Bluetooth password (checked once in a while).
  bluetoothPeer(req, local, remote) {
    if (!this.bluetoothPassword || local !== BLUETOOTH_ADDR || !sameNet(remote, BLUETOOTH_ADDR)) return false;
    const given = String(req.headers["x-bluetooth-password"] || "");
    const ok = this.bluetoothOk.get(remote);
    if (ok && ok.until > Date.now() && ok.password === given) return true;
    if (!given || !this.bluetoothPassword(given)) return false;
    this.bluetoothOk.set(remote, { password: given, until: Date.now() + BLUETOOTH_OK_MS });
    return true;
  }

  // One request from the Bluetooth link, to this server (as a phone's would be): -> { status, type, body }.
  relay({ method, path: where, body, peer }) {
    if (!this.server) return Promise.resolve({ status: 503, type: "application/json", body: Buffer.from('{"error":"Remote recording is off."}') });
    return new Promise((resolve, reject) => {
      const data = body ? Buffer.from(body) : null;
      const req = http.request({
        host: "127.0.0.1", port: this.port, path: where, method,
        headers: { Host: "localhost", "X-HT-Relay": this.relayToken, "X-HT-Peer": String(peer || "").slice(-17), ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"] || "", body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.setTimeout(60000, () => req.destroy(new Error("No answer")));
      if (data) req.write(data);
      req.end();
    });
  }

  authorized(req) {
    if (this.trusted(req)) return true;
    const given = Buffer.from(String(req.headers["x-key"] || ""));
    const key = Buffer.from(this.key || "");
    return key.length > 0 && given.length === key.length && crypto.timingSafeEqual(given, key);
  }

  send(res, code, body, type = "application/json; charset=utf-8") {
    if (res.headersSent) return;
    const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    res.writeHead(code, {
      "Content-Type": type,
      "Content-Length": data.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(data);
  }

  async handle(req, res) {
    const url = new URL(req.url, "http://remote");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      // The page itself holds nothing: it shows anything only with the key.
      res.setHeader("Content-Security-Policy", PAGE_CSP);
      return this.send(res, 200, this.page("html"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/remote-client.js") return this.send(res, 200, this.page("js"), "text/javascript; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/bt-link-client.js") return this.send(res, 200, this.page("bt"), "text/javascript; charset=utf-8");
    if (!url.pathname.startsWith("/api/")) return this.send(res, 404, { error: "Not found" });
    if (!this.authorized(req)) return this.send(res, 401, { error: "This page's key isn't the one Hand Tracker shows now." });
    const address = this.relayed(req) ? "Bluetooth" : String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    const wasGone = !this.viewer || this.viewer.gone || this.viewer.address !== address;
    this.viewer = { address, seen: Date.now() };
    if (wasGone) this.emitStatus();

    // Changing this computer's Wi-Fi: only for phones on its hotspot or over Tailscale.
    const wifiHere = !!(this.wifi && this.wifi.available() && this.trusted(req));
    if (req.method === "GET" && url.pathname === "/api/state") {
      return this.send(res, 200, { ...this.state, host: this.host, wifi: wifiHere ? { allowed: true, ...this.wifi.status() } : null });
    }
    if (req.method === "GET" && url.pathname === "/api/wifi") {
      if (!wifiHere) return this.send(res, 403, { error: "The Wi-Fi can be changed only from this computer's hotspot or over Tailscale." });
      return this.send(res, 200, await this.wifi.list());
    }
    // The takes saved here: listed, and downloaded a slice at a time.
    if (req.method === "GET" && url.pathname === "/api/takes") {
      if (!this.takes) return this.send(res, 404, { error: "No takes here." });
      return this.send(res, 200, await this.takes.list());
    }
    if (req.method === "GET" && url.pathname === "/api/take") {
      const data = this.takes && (await this.takes.slice(String(url.searchParams.get("f") || ""), Number(url.searchParams.get("at") || 0)));
      if (!data) return this.send(res, 404, { error: "No such file." });
      return this.send(res, 200, data, "application/octet-stream");
    }
    if (req.method === "GET" && url.pathname === "/api/preview") {
      const i = Number(url.searchParams.get("i"));
      this.wantUntil = Date.now() + PREVIEW_WANTED_MS;
      // Full screen: that camera only, bigger. Each request waits for that camera's next picture
      // (so a page asks again as soon as it has one, and gets each picture once).
      const full = url.searchParams.get("full") === "1" && Number.isInteger(i) && i >= 0 && i < 16;
      if (full) {
        this.focusUntil = Date.now() + FOCUS_MS;
        this.setFocus(i);
      }
      this.setWanting(true);
      // The next picture after the one numbered &after= (full screen: a bigger one), else after
      // the one last sent to any page.
      const after = Number(url.searchParams.get("after"));
      if (url.searchParams.has("after") && Number.isInteger(after) && after >= 0) {
        const from = full ? Math.max(after + 1, this.focusFrom.get(i) || 0) : after + 1;
        await this.nextPreview(i, (p) => p && p.seq >= from, NEXT_WAIT_MS);
      } else {
        const since = this.lastSent.get(i) || 0;
        await this.nextPreview(i, (p) => p && p.at > since, NEXT_WAIT_MS);
        if (this.previews.get(i)) this.lastSent.set(i, this.previews.get(i).at);
      }
      const p = this.previews.get(i);
      if (!p || Date.now() - p.at > PREVIEW_STALE_MS) return this.send(res, 204, "");
      return this.send(res, 200, p.jpeg, `image/jpeg; seq=${p.seq}`);
    }
    if (req.method === "POST" && url.pathname === "/api/command") {
      // From the page itself: JSON (another website's form can't send that without asking
      // first, which this never allows) and, if the browser says where from, this address.
      const origin = req.headers.origin;
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] || "")) || (origin && origin !== `http://${req.headers.host}`)) {
        return this.send(res, 403, { error: "Only Hand Tracker's own page can do that." });
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192) return this.send(res, 413, { error: "Too long" });
      }
      let action = "", details = null, camera = null, pick = null, mode = null, settings = null, wifi = null, takes = null, take = null, sentry = null, oak = null, kinect = null;
      try {
        const msg = JSON.parse(body);
        action = String(msg.action || "");
        details = cleanDetails(msg.details);
        camera = cleanCamera(msg.camera);
        pick = cleanPick(msg.pick);
        mode = cleanMode(msg.mode);
        settings = cleanSettings(msg.settings);
        wifi = cleanWifi(msg.wifi);
        takes = cleanTakes(msg.takes);
        take = cleanTake(msg.take);
        sentry = cleanSentry(msg.sentry);
        oak = cleanOak(msg.oak);
        kinect = cleanKinect(msg.kinect);
      } catch {
        return this.send(res, 400, { error: "Not JSON" });
      }
      if (!ACTIONS.has(action)) return this.send(res, 400, { error: `Unknown action: ${action}` });
      if (action === "camera" && !camera) return this.send(res, 400, { error: "Which camera?" });
      if (action === "pick" && !pick) return this.send(res, 400, { error: "Which camera?" });
      if (action === "mode" && !mode) return this.send(res, 400, { error: "Which mode?" });
      if (action === "settings" && !settings) return this.send(res, 400, { error: "Which setting?" });
      if (action === "sentry" && !sentry) return this.send(res, 400, { error: "Which Sentry setting?" });
      if (action === "oak" && !oak) return this.send(res, 400, { error: "Which OAK camera setting?" });
      if (action === "kinect" && !kinect) return this.send(res, 400, { error: "Which Kinect setting?" });
      // Takes this page has safely: deleted here (checked file by file).
      if (action === "deleteTakes") {
        if (!this.takes) return this.send(res, 404, { error: "No takes here." });
        if (!takes) return this.send(res, 400, { error: "Which takes?" });
        return this.send(res, 200, await this.takes.remove(takes));
      }
      // A take's details: asked for (to change them), or changed (its files renamed to match).
      if (action === "takeDetails" || action === "editTake") {
        if (!this.takes) return this.send(res, 404, { error: "No takes here." });
        if (!take || (action === "editTake" && !take.details)) return this.send(res, 400, { error: "Which take?" });
        return this.send(res, 200, action === "takeDetails" ? await this.takes.details(take.id) : await this.editTake(take.id, take.details));
      }
      if (action === "wifi") {
        if (!wifiHere) return this.send(res, 403, { error: "The Wi-Fi can be changed only from this computer's hotspot or over Tailscale." });
        if (!wifi) return this.send(res, 400, { error: "That isn't a Wi-Fi network's name and password (8 to 63 characters)." });
        if (wifi.op === "join") return this.send(res, 200, this.wifi.connect(wifi.ssid, wifi.password));
        try {
          if (wifi.op === "save") return this.send(res, 200, await this.wifi.save(wifi.ssid, wifi.password));
          if (wifi.op === "forget") return this.send(res, 200, await this.wifi.forget(wifi.ssid));
          return this.send(res, 200, await this.wifi.hotspotMode(wifi.on));
        } catch (err) {
          return this.send(res, 200, { ok: false, message: String((err && err.message) || err).split("\n")[0] });
        }
      }
      const extra = {};
      if (details) extra.details = details;
      if (camera) extra.camera = camera;
      if (pick) extra.pick = pick;
      if (mode) extra.mode = mode;
      if (settings) extra.settings = settings;
      if (sentry) extra.sentry = sentry;
      if (oak) extra.oak = oak;
      if (kinect) extra.kinect = kinect;
      const result = await this.ask(action, extra);
      return this.send(res, 200, result || { ok: true });
    }
    return this.send(res, 404, { error: "Not found" });
  }
}

module.exports = { RemoteRecordServer, addresses, tailnetPeer, hotspotAddress, HOTSPOT_ADDR, BLUETOOTH_ADDR, cleanDetails, cleanCamera, cleanPick, cleanWifi, cleanSentry, cleanOak, crc32, RIG_HOST, RIG_PATH };
