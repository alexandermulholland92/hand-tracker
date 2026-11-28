/**
 * electron/cluster-call.js — the Cluster Call app's own service (main process): calls between your own devices over
 * Tailscale are set up through it, while the pictures and sound go straight between the two apps (WebRTC, in
 * cluster-call-page.js). Each device's app listens on port 47860; a call's offer, answer and hang up go from one app's
 * service to the other's as small JSON messages ("signals"), passed on to the page.
 *
 *   const vc = createClusterCall({ name, onSignal });
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
 *
 * Use from hand-tracker.com (web: its switch in the app; the user, 2026-11-27: "can you add integrations to the website
 * for cluster and cluster call?", "Both"): this device's own HTTPS address on Tailscale, https://<its Tailscale
 * name>:47865, with Tailscale's certificate for that name (`tailscale cert`). hand-tracker.com's Cluster Call page, in a
 * browser on a device of your account, calls and is called through it: the page says hello (/vc/web/hello: a "web
 * client", named for the device the browser is on), lists your devices (/vc/web/devices), sends its signals through
 * this device (/vc/web/send) and picks up the ones for it (/vc/web/inbox, a request left waiting until one comes).
 * Your other devices list it (in /vc/hello's "web", passed on to the phones as computers do) and call it here, the
 * offer naming it ("to"); everything after that about the call comes to it by the call's id. Only that site's pages
 * (CORS, each request asked first by the browser), and the same Tailscale account's devices.
 */
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { execFile } = require("child_process");

const PORT = 47860;
const BODY_MAX = 256 * 1024;
const KINDS = new Set(["offer", "answer", "decline", "busy", "cancel", "hangup", "state", "join"]);
const HELLO_MS = 2500;
const SEND_MS = 8000;
const WHOIS_MS = 10 * 60 * 1000;
const WEB_PORT = 47865;
const WEB_ORIGIN = "https://hand-tracker.com";
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const CLIENT_MS = 90 * 1000; // (a page that hasn't asked for its signals this long has closed)
const INBOX_MS = 25 * 1000; // (how long a page's request for its signals waits for one)
const CERT_MS = 24 * 3600 * 1000; // (Tailscale's certificate asked for again once a day: it renews it itself)

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

function createClusterCall({ name = "", version = "", port = PORT, sim = null, web: webOpts = null, onSignal = () => ({ ok: true }) } = {}) {
  let server = null;
  let meCache = null, meAt = 0;
  const whois = new Map(); // address -> { user, host, at }
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

  async function whoisOf(addr) {
    const hit = whois.get(addr);
    if (hit && Date.now() - hit.at < (hit.user ? WHOIS_MS : 60000)) return hit;
    const w = await tailscaleJson(["whois", "--json", addr]);
    const node = (w && w.Node) || {};
    const info = {
      user: (w && w.UserProfile && w.UserProfile.ID) || null,
      host: String(node.ComputedName || (node.Hostinfo && node.Hostinfo.Hostname) || String(node.Name || "").split(".")[0] || "").slice(0, 60),
      at: Date.now(),
    };
    whois.set(addr, info);
    return info;
  }
  const userOf = async (addr) => (await whoisOf(addr)).user;

  // A request this service takes: from a device of this one's own Tailscale account (the checks: this computer).
  async function trusted(addr) {
    if (sim) return isLocal(addr);
    if (!isTailnet(addr)) return false;
    const [mine, theirs] = await Promise.all([me(), userOf(addr)]);
    return !!(mine && mine.user && theirs && String(theirs) === String(mine.user));
  }

  function reply(res, code, body, extra = {}) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": data.length, "Cache-Control": "no-store", ...extra });
    res.end(data);
  }

  // ---------- hand-tracker.com's pages here (web clients) ----------
  const clients = new Map(); // id -> { id, name, seen, queue: [{ seq, signal }], seq, waiting: Set<fn> }
  const calls = new Map(); // a call's id -> { client, at }: a call one of them is in
  const live = (id) => {
    const c = clients.get(String(id || ""));
    return c && Date.now() - c.seen < CLIENT_MS ? c : null;
  };
  function forget() {
    const now = Date.now();
    for (const [id, c] of clients) if (now - c.seen > CLIENT_MS * 4) clients.delete(id);
    for (const [call, k] of calls) if (now - k.at > 6 * 3600 * 1000) calls.delete(call);
  }
  function push(c, signal) {
    c.queue.push({ seq: ++c.seq, signal });
    if (c.queue.length > 50) c.queue.splice(0, c.queue.length - 50);
    for (const wake of c.waiting) wake();
  }
  // A signal that came for a web client here: the offer naming it, or anything after about a call it's in.
  function forClient(s, signal) {
    const named = s.to !== undefined ? live(s.to) : null;
    const byCall = !named && calls.has(signal.call) ? live(calls.get(signal.call).client) : null;
    const c = named || byCall;
    if (!c) return s.to !== undefined && clients.has(String(s.to)) ? "gone" : null;
    calls.set(signal.call, { client: c.id, at: Date.now() });
    push(c, signal);
    return c;
  }
  const webList = (except = null) => [...clients.values()].filter((c) => c.id !== except && Date.now() - c.seen < CLIENT_MS).map((c) => ({ id: c.id, name: c.name }));
  // (an address this device answers at: its own Tailscale address, or its port when simulated)
  async function isOwn(address) {
    if (sim) return address === `127.0.0.1:${sim.port}`;
    const m = await me();
    return !!m && (m.ips || []).includes(String(address || "").replace(/:\d+$/, ""));
  }
  async function ownAddress() {
    const m = await me();
    return sim ? `127.0.0.1:${sim.port}` : (m && (m.ips || []).find((a) => !a.includes(":"))) || "";
  }

  async function handle(req, res) {
    const from = clean(req.socket.remoteAddress);
    if (req.headers.origin) return reply(res, 403, { error: "Not from a web page." });
    if (!(await trusted(from))) return reply(res, 403, { error: "Only your own devices." });
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/vc/hello") {
      const m = await me();
      return reply(res, 200, { app: "cluster-call", name: name || (m && m.name) || "", version, os: process.platform, ...(clients.size ? { web: webList() } : {}) });
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
      const client = forClient(s, signal);
      if (client === "gone") return reply(res, 404, { ok: false, error: "That browser page has closed." });
      if (client) return reply(res, 200, { ok: true });
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
      return r.status === 200 && r.json && r.json.app === "cluster-call" ? r.json : null;
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
    const out = list
      .map((d, i) => ({ ...d, app: !!said[i], ...(said[i] && said[i].name ? { name: said[i].name } : {}), ...(said[i] && said[i].os && !d.os ? { os: said[i].os } : {}) }))
      .sort((a, b) => Number(b.app) - Number(a.app) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    // (hand-tracker.com's pages open on your devices: each called through the device it's on, the offer naming it)
    const pages = [];
    list.forEach((d, i) => {
      for (const w of (said[i] && Array.isArray(said[i].web) ? said[i].web : []).slice(0, 8)) {
        if (w && CLIENT_ID.test(String(w.id))) pages.push({ name: String(w.name || "A browser").slice(0, 80), address: d.address, to: String(w.id), os: "web", online: true, app: true });
      }
    });
    const here = await ownAddress();
    if (here) for (const w of webList()) pages.push({ name: w.name, address: here, to: w.id, os: "web", online: true, app: true });
    const all = [...out, ...pages];
    announce(all).catch(() => {});
    return all;
  }

  // Your phones can't ask Tailscale which devices are yours: each phone with Cluster Call is told the list (this
  // device first), at most every 5 minutes.
  const announced = new Map(); // address -> when
  async function announce(list) {
    const phones = list.filter((d) => d.app && /^(android|ios)$/i.test(String(d.os)));
    if (!phones.length) return;
    const m = await me();
    const mine = sim ? `127.0.0.1:${sim.port}` : m && (m.ips || []).find((a) => !a.includes(":"));
    if (!mine) return;
    const all = [{ name: name || (m && m.name) || "", address: mine, os: sim ? "" : process.platform, app: true },
      ...list.map(({ name: n, address, os, app, to }) => ({ name: n, address, os, app, ...(to ? { to } : {}) }))];
    await Promise.all(phones.map(async (p) => {
      if (Date.now() - (announced.get(p.address) || 0) < 5 * 60 * 1000) return;
      announced.set(p.address, Date.now());
      await request(`http://${at(p.address)}/vc/announce`, { method: "POST", body: { devices: all.filter((d) => d.address !== p.address || d.to) }, timeout: 4000 }).catch(() => {});
    }));
  }

  async function send(address, signal) {
    const m = await me();
    if (signal && signal.to !== undefined && (await isOwn(address))) {
      const c = live(signal.to);
      if (!c) return { ok: false, error: "That browser page has closed." };
      calls.set(String(signal.call), { client: c.id, at: Date.now() });
      push(c, { ...normalize(signal), from: { address: await ownAddress(), name: name || (m && m.name) || "" } });
      return { ok: true };
    }
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

  // A signal's own parts, checked (what /vc/signal keeps of one).
  function normalize(s) {
    return {
      kind: String(s.kind),
      call: String(s.call),
      ...(typeof s.sdp === "string" && s.sdp.length <= 200000 ? { sdp: s.sdp } : {}),
      ...(s.state && typeof s.state === "object" ? { state: { muted: !!s.state.muted, camera: s.state.camera !== false } } : {}),
      ...(typeof s.video === "boolean" ? { video: s.video } : {}),
    };
  }

  // ---------- Use from hand-tracker.com: this device's HTTPS address on Tailscale ----------
  const web = { server: null, bound: null, error: null, address: null, certAt: 0, ctx: null };
  const webOrigin = () => (webOpts && webOpts.origin) || WEB_ORIGIN;
  function webWhy(said, host) {
    const low = said.toLowerCase();
    if (/access denied|permission denied/.test(low)) {
      return `Tailscale gives this device's certificate only to its administrator: run this once, then turn it on again: sudo tailscale set --operator=${process.env.USER || "$USER"}`;
    }
    if (/not enabled|does not support|not support|disabled/.test(low)) return "Tailscale's HTTPS certificates are off for your Tailscale network: turn them on in Tailscale's admin console (DNS, HTTPS Certificates).";
    return `Tailscale didn't give this device's certificate (${host}): ${said.split("\n").filter(Boolean).pop() || "no answer"}`;
  }
  function certFor(host) {
    if (sim || (webOpts && webOpts.cert)) return Promise.resolve({ cert: fs.readFileSync(webOpts.cert), key: fs.readFileSync(webOpts.key) });
    const dir = webOpts.dir;
    fs.mkdirSync(dir, { recursive: true });
    const cert = path.join(dir, "cert.pem"), key = path.join(dir, "key.pem");
    return new Promise((resolve, reject) => {
      execFile(tailscaleCommand(), ["cert", "--cert-file", cert, "--key-file", key, host], { timeout: 180000, windowsHide: true }, (err, out, errOut) => {
        if (err) return reject(new Error(webWhy(String(errOut || out || err.message || ""), host)));
        try {
          resolve({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) });
        } catch (e) {
          reject(e);
        }
      });
    });
  }
  // On (or kept going, its certificate asked for again once a day): { on, address, error }.
  async function webOn() {
    if (!webOpts) return { on: false, error: "Not here." };
    let host, ip, wport = webOpts.port || WEB_PORT;
    if (sim) {
      host = "127.0.0.1";
      ip = "127.0.0.1";
    } else {
      const m = await me();
      host = m && m.dns;
      ip = m && (m.ips || []).find((a) => !a.includes(":"));
      if (!host || !ip) return webState("This device isn't on Tailscale (or Tailscale hasn't said its name yet).");
    }
    if (!web.ctx || Date.now() - web.certAt > CERT_MS) {
      try {
        web.ctx = await certFor(host);
        web.certAt = Date.now();
        if (web.server) web.server.setSecureContext(web.ctx);
      } catch (e) {
        if (!web.ctx) return webState(e.message);
      }
    }
    if (web.server && web.bound === `${ip}:${wport}`) return webState(null);
    webOff();
    const srv = https.createServer({ ...web.ctx, minVersion: "TLSv1.2" }, (req, res) => handleWeb(req, res).catch((e) => reply(res, 500, { error: e.message }, cors(req))));
    try {
      await new Promise((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(wport, ip, resolve);
      });
    } catch (e) {
      return webState(e.code === "EADDRINUSE" ? `Something else on this device already uses port ${wport}.` : e.message);
    }
    srv.on("error", () => {});
    web.server = srv;
    web.bound = `${ip}:${wport}`;
    web.address = `${host}:${wport}`;
    return webState(null);
  }
  function webOff() {
    if (web.server) web.server.close();
    web.server = null;
    web.bound = null;
    web.address = null;
    return webState(null);
  }
  function webState(error) {
    web.error = error;
    return { on: !!web.server, address: web.address, error: error || null,
      link: web.server && web.address ? `https://hand-tracker.com/cluster-call.html#via=${web.address}` : null };
  }

  const cors = (req) => (req.headers.origin === webOrigin() ? { "Access-Control-Allow-Origin": webOrigin(), Vary: "Origin" } : {});
  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > BODY_MAX) throw Object.assign(new Error("Too big."), { code: 413 });
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }
  // A request to the HTTPS address: only from hand-tracker.com's page (asked first by the browser), on one of your devices.
  async function handleWeb(req, res) {
    forget();
    const from = clean(req.socket.remoteAddress);
    const origin = req.headers.origin;
    if (origin !== webOrigin()) return reply(res, 403, { error: "Only hand-tracker.com's Cluster Call page." });
    if (!(await trusted(from))) return reply(res, 403, { error: "Only your own devices." });
    const h = cors(req);
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...h, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600",
        ...(String(req.headers["access-control-request-private-network"] || "").toLowerCase() === "true" ? { "Access-Control-Allow-Private-Network": "true" } : {}),
        "Content-Length": 0 });
      return res.end();
    }
    const url = new URL(req.url, "https://localhost");
    const id = url.searchParams.get("client") || "";
    if (req.method === "GET" && url.pathname === "/vc/web/hello") {
      if (!CLIENT_ID.test(id)) return reply(res, 400, { error: "Its id." }, h);
      const host = sim ? "" : (await whoisOf(from)).host;
      const c = clients.get(id) || { id, queue: [], seq: 0, waiting: new Set() };
      c.name = host ? `Browser on ${host}` : "Browser";
      c.seen = Date.now();
      clients.set(id, c);
      const m = await me();
      return reply(res, 200, { app: "cluster-call", me: { name: c.name }, home: { name: name || (m && m.name) || "", address: await ownAddress() }, version }, h);
    }
    const c = live(id);
    if (!c) return reply(res, 410, { error: "Say hello first." }, h);
    c.seen = Date.now();
    if (req.method === "GET" && url.pathname === "/vc/web/devices") {
      const list = await devices();
      const m = await me();
      const here = await ownAddress();
      const self = { name: name || (m && m.name) || "This device", address: here, os: sim ? "" : process.platform, online: true, app: true, home: true };
      return reply(res, 200, { devices: [self, ...list.filter((d) => d.to !== c.id)] }, h);
    }
    if (req.method === "GET" && url.pathname === "/vc/web/inbox") {
      const after = Number(url.searchParams.get("after")) || 0;
      const ready = () => c.queue.filter((q) => q.seq > after);
      if (!ready().length) {
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            c.waiting.delete(done);
            resolve();
          };
          const timer = setTimeout(done, INBOX_MS);
          c.waiting.add(done);
          req.on("close", done);
        });
      }
      c.seen = Date.now();
      const got = ready();
      return reply(res, 200, { seq: got.length ? got[got.length - 1].seq : Math.max(after, c.seq), signals: got.map((q) => q.signal) }, h);
    }
    if (req.method === "POST" && url.pathname === "/vc/web/send") {
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) return reply(res, 415, { error: "JSON only." }, h);
      let b;
      try {
        b = await readJson(req);
      } catch (e) {
        return reply(res, e.code === 413 ? 413 : 400, { error: e.message }, h);
      }
      const sig = b && b.signal;
      const to = String((b && b.address) || "");
      if (!sig || typeof sig !== "object" || !KINDS.has(sig.kind) || !/^[A-Za-z0-9_-]{8,64}$/.test(String(sig.call || "")) || !/^[0-9.:]{7,45}$/.test(to)) {
        return reply(res, 400, { error: "Not a call's signal." }, h);
      }
      calls.set(String(sig.call), { client: c.id, at: Date.now() });
      const signal = { ...normalize(sig), ...(sig.to !== undefined && CLIENT_ID.test(String(sig.to)) ? { to: String(sig.to) } : {}) };
      if (await isOwn(to)) {
        const here = await ownAddress();
        if (signal.to !== undefined) {
          // (another page through this device)
          const other = live(signal.to);
          if (!other) return reply(res, 200, { ok: false, error: "That browser page has closed." }, h);
          calls.set(signal.call, { client: other.id, at: Date.now() });
          push(other, { ...normalize(signal), from: { address: here, name: c.name, to: c.id } });
          return reply(res, 200, { ok: true }, h);
        }
        // (this device's own app: its page told the call comes from that browser, here)
        let out;
        try {
          out = await onSignal({ ...normalize(signal), from: { address: here, name: c.name, to: c.id } });
        } catch (e) {
          return reply(res, 200, { ok: false, error: e.message }, h);
        }
        return reply(res, 200, out || { ok: true }, h);
      }
      const r = await sendAs(to, signal, c.name);
      return reply(res, 200, r, h);
    }
    return reply(res, 404, { error: "Nothing here." }, h);
  }
  // A signal from one of the pages here to another device, in that page's name (its answers come back here by the call).
  async function sendAs(address, signal, as) {
    let r;
    try {
      r = await request(`http://${at(address)}/vc/signal`, { method: "POST", body: { ...signal, name: as, ...(sim ? { port: sim.port } : {}) } });
    } catch (e) {
      return { ok: false, error: `That device didn't answer (${e.message}).` };
    }
    if (r.status !== 200) return { ok: false, error: (r.json && r.json.error) || `It said ${r.status}.` };
    return r.json || { ok: true };
  }

  return { start, stop, me, devices, send, trusted, port: () => listenPort, webOn, webOff, webState: () => webState(web.error), clients: () => webList() };
}

// Bytes from a URL (a camera's picture): { status, type, data } (a Buffer).
function fetchBytes(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > 16 << 20) req.destroy(new Error("too much"));
        else chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode, type: String(res.headers["content-type"] || ""), data: Buffer.concat(chunks) }));
    });
    req.on("timeout", () => req.destroy(new Error("it didn't answer")));
    req.on("error", reject);
  });
}

// Hand Tracker on this device (its rig service, port 47821, asked over this device's own Tailscale address, which it
// trusts as its own): its cameras as a call's camera (an OAK, a Kinect, a PS4 camera: ones a browser can't open).
// Listed; started when a call wants one (someone here chose it: a Pi never opens a camera by itself); their pictures
// one after another, full size; and stopped after the call if this started them, unless Hand Tracker is recording or
// Sentry mode is on.
//   const rig = createRig({ base: async () => "http://100.x.y.z:47821" | null });
//   await rig.list()                 // [{ index, name, role, running }]
//   await rig.start()                // { ok, message }
//   await rig.frame(index, after)    // { seq, data } (a JPEG), or null (none newer yet)
//   await rig.stop()
function createRig({ base }) {
  let started = false;
  async function state() {
    const b = await base();
    if (!b) return null;
    try {
      const r = await request(`${b}/api/state`, { timeout: 4000 });
      return r.status === 200 && r.json && typeof r.json === "object" ? r.json : null;
    } catch {
      return null;
    }
  }
  async function list() {
    const s = await state();
    if (!s || !Array.isArray(s.cameras)) return [];
    return s.cameras.map((c, i) => ({
      index: i,
      name: String((c && c.name) || `Camera ${i + 1}`).slice(0, 60),
      role: String((c && c.role) || "").slice(0, 40),
      running: !!(c && Number(c.fps) > 0),
    }));
  }
  async function start() {
    const b = await base();
    if (!b || !(await state())) return { ok: false, message: "Hand Tracker isn't running on this device." };
    let r;
    try {
      r = await request(`${b}/api/command`, { method: "POST", body: { action: "cameras" } });
    } catch (e) {
      return { ok: false, message: e.message };
    }
    const ok = r.status === 200 && !!(r.json && r.json.ok);
    if (ok && !/already running/i.test(String(r.json.message || ""))) started = true;
    return { ok, message: String((r.json && (r.json.message || r.json.error)) || "") };
  }
  async function frame(index, after) {
    const b = await base();
    if (!b || !Number.isInteger(index) || index < 0) return null;
    const q = `i=${index}&full=1${Number.isInteger(after) && after >= 0 ? `&after=${after}` : ""}`;
    const r = await fetchBytes(`${b}/api/preview?${q}`).catch(() => null);
    if (!r || r.status !== 200 || !r.data.length) return null;
    const m = /seq=(\d+)/.exec(r.type);
    return { seq: m ? Number(m[1]) : (Number(after) || 0) + 1, data: r.data };
  }
  async function stop() {
    if (!started) return;
    started = false;
    const s = await state();
    const sentry = s && (s.sentry === true || (s.sentry && typeof s.sentry === "object" && (s.sentry.on || s.sentry.armed)));
    if (!s || s.recording || s.saving || sentry) return; // (in use: left running)
    const b = await base();
    await request(`${b}/api/command`, { method: "POST", body: { action: "close" } }).catch(() => {});
  }
  return { list, start, frame, stop };
}

module.exports = { createClusterCall, createRig, PORT, isTailnet };
