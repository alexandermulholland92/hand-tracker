/**
 * electron/video-call.js — the Video Call app's own service (main process): calls between your own devices over
 * Tailscale are set up through it, while the pictures and sound go straight between the two apps (WebRTC, in
 * video-call-page.js). Each device's app listens on port 47860; a call's offer, answer and hang up go from one app's
 * service to the other's as small JSON messages ("signals"), passed on to the page.
 *
 *   const vc = createVideoCall({ name, onSignal });
 *   await vc.start();
 *   await vc.me();                    // { name, user, ips } (this device on Tailscale), or null
 *   await vc.devices();               // your other devices: [{ name, address, os, online, app, busy }]
 *   await vc.send(address, signal);   // to that device's app: its reply ({ ok } or { ok: false, error })
 *   vc.stop();
 *
 * Only your own devices: a request is taken when it comes over Tailscale from a device of this device's own
 * Tailscale account (`tailscale whois`). JSON only (a web page can't post one here without asking first), no
 * page may ask from another site, and at most 256 KB.
 *
 * Simulated (the checks: sim = { peers: [{ name, address }] }): several on this computer, each on its own port,
 * taking requests from this computer only, each signal saying the port its sender listens on.
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFile } = require("child_process");

const PORT = 47860;
const BODY_MAX = 256 * 1024;
const KINDS = new Set(["offer", "answer", "decline", "busy", "cancel", "hangup", "state", "join"]);
const HELLO_MS = 2500;
const SEND_MS = 8000;
const WHOIS_MS = 10 * 60 * 1000;

const clean = (a) => String(a || "").replace(/^::ffff:/, "");
const isTailnet = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(ip) || /^fd7a:115c:a1e0:/i.test(ip);
const isLocal = (ip) => ip === "127.0.0.1" || ip === "::1";

function tailscaleCommand() {
  const tries =
    process.platform === "win32"
      ? [path.join(process.env.ProgramFiles || "C:\\Program Files", "Tailscale", "tailscale.exe")]
      : process.platform === "darwin"
        ? ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]
        : [];
  return tries.find((p) => fs.existsSync(p)) || "tailscale";
}

function tailscaleJson(args) {
  return new Promise((resolve) => {
    execFile(tailscaleCommand(), args, { timeout: 8000, windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve(null);
      }
    });
  });
}

function request(url, { method = "GET", body = null, timeout = SEND_MS } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(url, {
      method,
      timeout,
      headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {},
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > BODY_MAX) req.destroy(new Error("too much"));
        else chunks.push(c);
      });
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
        } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("it didn't answer")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function createVideoCall({ name = "", version = "", port = PORT, sim = null, onSignal = () => ({ ok: true }) } = {}) {
  let server = null;
  let meCache = null, meAt = 0;
  const whois = new Map(); // address -> { user, at }
  const listenPort = sim ? sim.port : port;

  async function me() {
    if (sim) return { name: sim.name, user: "sim", ips: ["127.0.0.1"] };
    if (meCache && Date.now() - meAt < 5 * 60 * 1000) return meCache;
    const s = await tailscaleJson(["status", "--json", "--peers=false"]);
    const self = s && s.Self;
    if (!self) return meCache;
    meCache = {
      name: String(self.HostName || "").trim() || null,
      dns: String(self.DNSName || "").replace(/\.$/, ""),
      user: self.UserID,
      ips: (self.TailscaleIPs || []).map(String),
    };
    meAt = Date.now();
    return meCache;
  }

  async function userOf(addr) {
    const hit = whois.get(addr);
    if (hit && Date.now() - hit.at < (hit.user ? WHOIS_MS : 60000)) return hit.user;
    const w = await tailscaleJson(["whois", "--json", addr]);
    const user = (w && w.UserProfile && w.UserProfile.ID) || null;
    whois.set(addr, { user, at: Date.now() });
    return user;
  }

  // A request this service takes: from a device of this one's own Tailscale account (the checks: this computer).
  async function trusted(addr) {
    if (sim) return isLocal(addr);
    if (!isTailnet(addr)) return false;
    const [mine, theirs] = await Promise.all([me(), userOf(addr)]);
    return !!(mine && mine.user && theirs && String(theirs) === String(mine.user));
  }

  function reply(res, code, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": data.length, "Cache-Control": "no-store" });
    res.end(data);
  }

  async function handle(req, res) {
    const from = clean(req.socket.remoteAddress);
    if (req.headers.origin) return reply(res, 403, { error: "Not from a web page." });
    if (!(await trusted(from))) return reply(res, 403, { error: "Only your own devices." });
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/vc/hello") {
      const m = await me();
      return reply(res, 200, { app: "video-call", name: name || (m && m.name) || "", version, os: process.platform });
    }
    if (req.method === "POST" && url.pathname === "/vc/signal") {
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) return reply(res, 415, { error: "JSON only." });
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > BODY_MAX) return reply(res, 413, { error: "Too big." });
        chunks.push(c);
      }
      let s;
      try {
        s = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reply(res, 400, { error: "Not JSON." });
      }
      if (!s || typeof s !== "object" || !KINDS.has(s.kind) || !/^[A-Za-z0-9_-]{8,64}$/.test(String(s.call || ""))) {
        return reply(res, 400, { error: "Not a call's signal." });
      }
      if (s.sdp !== undefined && (typeof s.sdp !== "string" || s.sdp.length > 200000)) return reply(res, 400, { error: "Bad description." });
      // (Its sender's address: where this came from, and the port it listens on when simulated.)
      const back = sim ? `${from}:${Number(s.port) || PORT}` : from;
      const signal = {
        kind: s.kind,
        call: String(s.call),
        from: { address: back, name: String(s.name || "").slice(0, 80) || back },
        ...(s.sdp !== undefined ? { sdp: s.sdp } : {}),
        ...(s.state && typeof s.state === "object" ? { state: { muted: !!s.state.muted, camera: s.state.camera !== false } } : {}),
        ...(Array.isArray(s.members) ? { members: s.members.slice(0, 16).map((m) => ({ address: String(m.address || "").slice(0, 80), name: String(m.name || "").slice(0, 80) })) } : {}),
        ...(typeof s.video === "boolean" ? { video: s.video } : {}),
      };
      let out;
      try {
        out = await onSignal(signal);
      } catch (e) {
        return reply(res, 500, { ok: false, error: e.message });
      }
      return reply(res, 200, out || { ok: true });
    }
    return reply(res, 404, { error: "Nothing here." });
  }

  async function start() {
    if (server) return;
    server = http.createServer((req, res) => handle(req, res).catch((e) => reply(res, 500, { error: e.message })));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort, sim ? "127.0.0.1" : undefined, resolve);
    });
  }

  function stop() {
    if (server) server.close();
    server = null;
  }

  // (An address with its port when simulated, an IPv4 Tailscale address otherwise.)
  const at = (address) => (/:\d+$/.test(address) ? address : `${address}:${PORT}`);

  async function hello(address) {
    try {
      const r = await request(`http://${at(address)}/vc/hello`, { timeout: HELLO_MS });
      return r.status === 200 && r.json && r.json.app === "video-call" ? r.json : null;
    } catch {
      return null;
    }
  }

  // Your other devices on Tailscale (your own account's), and whether each has the app.
  async function devices() {
    let list;
    if (sim) list = sim.peers.map((p) => ({ name: p.name, address: p.address, os: "", online: true }));
    else {
      const s = await tailscaleJson(["status", "--json"]);
      const mine = s && s.Self && s.Self.UserID;
      list = Object.values((s && s.Peer) || {})
        .filter((p) => mine && p.UserID === mine)
        .map((p) => ({
          name: String(p.HostName || "").trim() || String(p.DNSName || "").split(".")[0],
          address: ((p.TailscaleIPs || []).map(String).find((a) => !a.includes(":")) || ""),
          os: String(p.OS || ""),
          online: !!p.Online,
        }))
        .filter((d) => d.address);
    }
    const said = await Promise.all(list.map((d) => (d.online ? hello(d.address) : null)));
    return list
      .map((d, i) => ({ ...d, app: !!said[i], ...(said[i] && said[i].name ? { name: said[i].name } : {}) }))
      .sort((a, b) => Number(b.app) - Number(a.app) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }

  async function send(address, signal) {
    const m = await me();
    let r;
    try {
      r = await request(`http://${at(address)}/vc/signal`, {
        method: "POST",
        body: { ...signal, name: name || (m && m.name) || "", ...(sim ? { port: sim.port } : {}) },
      });
    } catch (e) {
      return { ok: false, error: `That device didn't answer (${e.message}).` };
    }
    if (r.status !== 200) return { ok: false, error: (r.json && r.json.error) || `It said ${r.status}.` };
    return r.json || { ok: true };
  }

  return { start, stop, me, devices, send, trusted, port: () => listenPort };
}

module.exports = { createVideoCall, PORT, isTailnet };
