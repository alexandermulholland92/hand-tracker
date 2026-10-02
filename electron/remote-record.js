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
 * A phone on this computer's own hotspot (a Raspberry Pi's, pi/hotspot-setup.sh: interface
 * htap0) needs no code either: the hotspot's password is what keeps others out. Phones there
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
 * { id, use, role }), "mode" ("ego", "stereo" or "freeform") or "settings" ({ detailsRequired, screenPictures }:
 * whether the take details are needed, and whether the OAK cameras' pictures are drawn on its screen).
 * onWantPreviews({ on, focus }): a page is (or stopped) looking at the previews; focus: the
 * camera one is looking at full screen (null for none), which then comes bigger and more often
 * (/api/preview?i=N&full=1: each request waits for that camera's next picture).
 * keyStore: { load() -> key | null, save(key) } (main.js keeps it encrypted by the OS).
 */

const crypto = require("crypto");
const { execFile } = require("child_process");
const http = require("http");
const os = require("os");
const { EventEmitter } = require("events");

const FIRST_PORT = 47821;
const PORTS_TRIED = 10;
const PREVIEW_WANTED_MS = 3000; // previews are made while a page asked for one this recently
const FOCUS_MS = 1500; // a camera stays full screen while a page asked for it this recently
const FULL_WAIT_MS = 400; // a full-screen request waits this long for that camera's next picture
const PREVIEW_STALE_MS = 5000; // an older preview isn't shown (that camera stopped)
const VIEWER_GONE_MS = 10000;
const ACTIONS = new Set(["cameras", "record", "stop", "close", "details", "camera", "scan", "pick", "mode", "settings", "wifi"]);
const DETAILS = ["contributor", "location", "task"];
const DETAIL_CHARS = 200;
const ROLES = ["", "head", "chest", "wrist_left", "wrist_right"];
const MODES = ["ego", "stereo", "freeform"];
// The page's script and style are its own (nothing inline); pictures come as blobs.
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'";

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
  if (ROLES.includes(p.role)) out.role = p.role;
  return out;
}
const cleanMode = (m) => (MODES.includes(m) ? m : null);
// A Wi-Fi network to join: its name (1 to 32 bytes) and password (none, or 8 to 63 characters).
function cleanWifi(w) {
  if (!w || typeof w !== "object" || typeof w.ssid !== "string") return null;
  const ssid = w.ssid, password = typeof w.password === "string" ? w.password : "";
  if (!ssid || Buffer.byteLength(ssid) > 32 || /[\u0000-\u001f\u007f]/.test(ssid)) return null;
  if (password && (password.length < 8 || password.length > 63 || /[\u0000-\u001f\u007f]/.test(password))) return null;
  return { ssid, password };
}
function cleanSettings(s) {
  if (!s || typeof s !== "object") return null;
  const out = {};
  for (const k of ["detailsRequired", "screenPictures"]) if (typeof s[k] === "boolean") out[k] = s[k];
  return Object.keys(out).length ? out : null;
}

// Tailscale's addresses: 100.64.0.0/10.
function isTailscale(address) {
  const [p, q] = String(address || "").replace(/^::ffff:/, "").split(".").map(Number);
  return p === 100 && q >= 64 && q <= 127;
}
// A request that came in over Tailscale, from another device on it (needs no key).
const tailnetPeer = (localAddress, remoteAddress) => isTailscale(localAddress) && isTailscale(remoteAddress);

// This computer's hotspot (pi/hotspot-setup.sh makes it): its interface, and its address now.
const HOTSPOT_IF = "htap0";
function hotspotAddress() {
  const a = (os.networkInterfaces()[HOTSPOT_IF] || []).find((x) => x.family === "IPv4" || x.family === 4);
  return a ? a.address : null;
}

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
      const kind = name === HOTSPOT_IF ? "Hotspot" : isTailscale(a.address) ? "Tailscale" : /^(wl|wi-?fi|wlan)/i.test(name) ? "Wi-Fi" : "local network";
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
  constructor({ keyStore, page, host = os.hostname(), ask, onWantPreviews = () => {}, hotspot = hotspotAddress, wifi = null }) {
    super();
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
    this.previews = new Map(); // camera index -> { jpeg, at }
    this.wantUntil = 0;
    this.focus = null; // the camera a page is looking at full screen
    this.focusUntil = 0;
    this.lastFull = new Map(); // camera index -> when the picture last sent full screen was made
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
    if (Number.isInteger(i) && i >= 0 && i < 16 && jpeg && jpeg.length) this.previews.set(i, { jpeg: Buffer.from(jpeg), at: Date.now() });
  }

  setFocus(i) {
    if (this.focus === i) return;
    this.focus = i;
    // Newly full screen: its next picture is the bigger one (not the small one already here).
    if (i !== null) this.lastFull.set(i, Date.now());
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
  // this computer by its own name or address).
  trusted(req) {
    const local = String(req.socket.localAddress || "").replace(/^::ffff:/, "");
    const hotspot = this.hotspot();
    return (tailnetPeer(req.socket.localAddress, req.socket.remoteAddress) || (!!hotspot && local === hotspot)) && this.ownHost(req);
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
    if (!url.pathname.startsWith("/api/")) return this.send(res, 404, { error: "Not found" });
    if (!this.authorized(req)) return this.send(res, 401, { error: "This page's key isn't the one Hand Tracker shows now." });
    const address = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
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
    if (req.method === "GET" && url.pathname === "/api/preview") {
      const i = Number(url.searchParams.get("i"));
      this.wantUntil = Date.now() + PREVIEW_WANTED_MS;
      // Full screen: that camera only, bigger and more often; each request waits for its next picture.
      const full = url.searchParams.get("full") === "1" && Number.isInteger(i) && i >= 0 && i < 16;
      if (full) {
        this.focusUntil = Date.now() + FOCUS_MS;
        this.setFocus(i);
      }
      this.setWanting(true);
      if (full) {
        const since = this.lastFull.get(i) || 0;
        for (let t = 0; t < FULL_WAIT_MS && !((this.previews.get(i) || {}).at > since); t += 15) await new Promise((r) => setTimeout(r, 15));
        if (this.previews.get(i)) this.lastFull.set(i, this.previews.get(i).at);
      }
      const p = this.previews.get(i);
      if (!p || Date.now() - p.at > PREVIEW_STALE_MS) return this.send(res, 204, "");
      return this.send(res, 200, p.jpeg, "image/jpeg");
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
      let action = "", details = null, camera = null, pick = null, mode = null, settings = null, wifi = null;
      try {
        const msg = JSON.parse(body);
        action = String(msg.action || "");
        details = cleanDetails(msg.details);
        camera = cleanCamera(msg.camera);
        pick = cleanPick(msg.pick);
        mode = cleanMode(msg.mode);
        settings = cleanSettings(msg.settings);
        wifi = cleanWifi(msg.wifi);
      } catch {
        return this.send(res, 400, { error: "Not JSON" });
      }
      if (!ACTIONS.has(action)) return this.send(res, 400, { error: `Unknown action: ${action}` });
      if (action === "camera" && !camera) return this.send(res, 400, { error: "Which camera?" });
      if (action === "pick" && !pick) return this.send(res, 400, { error: "Which camera?" });
      if (action === "mode" && !mode) return this.send(res, 400, { error: "Which mode?" });
      if (action === "settings" && !settings) return this.send(res, 400, { error: "Which setting?" });
      if (action === "wifi") {
        if (!wifiHere) return this.send(res, 403, { error: "The Wi-Fi can be changed only from this computer's hotspot or over Tailscale." });
        if (!wifi) return this.send(res, 400, { error: "That isn't a Wi-Fi network's name and password (8 to 63 characters)." });
        return this.send(res, 200, this.wifi.connect(wifi.ssid, wifi.password));
      }
      const extra = {};
      if (details) extra.details = details;
      if (camera) extra.camera = camera;
      if (pick) extra.pick = pick;
      if (mode) extra.mode = mode;
      if (settings) extra.settings = settings;
      const result = await this.ask(action, extra);
      return this.send(res, 200, result || { ok: true });
    }
    return this.send(res, 404, { error: "Not found" });
  }
}

module.exports = { RemoteRecordServer, addresses, tailnetPeer, hotspotAddress, HOTSPOT_IF, cleanDetails, cleanCamera, cleanPick, cleanWifi };
