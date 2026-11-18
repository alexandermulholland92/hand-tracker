/**
 * cluster.js — the Pi Cluster app's side in the main process (its own app: APP.kind "cluster").
 * It finds the Pis running Pi Cluster's service (cluster/node: port 47830) among the Linux
 * computers on this computer's Tailscale network, and passes the page's requests on to them. (The
 * page can't ask them itself: it's served from app://, and the service only answers requests
 * that carry its own header.)
 *
 *   const c = new Cluster({ file });  // file: the Pis seen before, shown while they're away
 *   await c.list()      -> { nodes: [{ name, target, online, answering, seen, node, error }], tailscale, at }
 *                          (online: Tailscale has it on; answering: its service answered just now;
 *                          node: what it said, or what it said last time)
 *   await c.settings({ target, module, on } | { target, module, key, value }) -> { status, ...answer }
 *   await c.action({ target, module, action, args })                         -> { status, ...answer }
 *   c.forget(name)
 *
 * HT_CLUSTER_NODES=host:port,… are asked as well (the checks: a simulated Pi on this computer).
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFile } = require("child_process");

const PORT = 47830;
const ASK_MS = 5000;
const NOT_ONE_MS = 60000; // a computer whose port didn't answer (no service there): asked again after this
const KEEP_DAYS = 30; // a Pi not seen for this long is no longer listed

function tailscaleCli() {
  if (process.platform === "win32") return path.join(process.env.ProgramFiles || "C:\\Program Files", "Tailscale", "tailscale.exe");
  const mac = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  if (process.platform === "darwin" && fs.existsSync(mac)) return mac;
  return "tailscale";
}

// The Linux computers on this Tailscale network: [{ name, ip, online }], or null (no Tailscale here).
function tailscalePeers() {
  return new Promise((resolve) => {
    execFile(tailscaleCli(), ["status", "--json"], { timeout: 8000, windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const peers = Object.values(JSON.parse(stdout).Peer || {});
        resolve(
          peers
            .filter((p) => String(p.OS || "").toLowerCase() === "linux")
            .map((p) => ({ name: String(p.HostName || ""), ip: (p.TailscaleIPs || []).find((a) => !String(a).includes(":")), online: !!p.Online }))
            .filter((p) => p.ip),
        );
      } catch {
        resolve(null);
      }
    });
  });
}

// One request to a Pi's service: target is "100.x.y.z" (its port is the service's) or "host:port".
function ask(target, method, urlPath, body) {
  const [host, port] = target.includes(":") ? [target.split(":")[0], Number(target.split(":")[1])] : [target, PORT];
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve) => {
    const req = http.request(
      {
        host, port, path: urlPath, method,
        headers: { "X-HT-Cluster": "1", Host: `${host}:${port}`, ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) },
        timeout: ASK_MS,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let json = {};
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            json = { error: "Its answer wasn't readable." };
          }
          resolve({ status: res.statusCode, ...(json && typeof json === "object" ? json : {}) });
        });
        res.on("error", (err) => resolve({ status: 0, error: err.message }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("No answer")));
    req.on("error", (err) => resolve({ status: 0, error: err.code === "ECONNREFUSED" ? "Its service isn't running." : err.message }));
    if (data) req.write(data);
    req.end();
  });
}

class Cluster {
  constructor({ file, extra = process.env.HT_CLUSTER_NODES } = {}) {
    this.file = file;
    this.extra = String(extra || "").split(",").map((s) => s.trim()).filter(Boolean);
    this.known = {}; // name -> { target, seen, node }
    this.notOne = new Map(); // target -> until when it isn't asked again
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved && typeof saved === "object") this.known = saved;
    } catch {}
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.known));
    } catch {}
  }

  async list() {
    const peers = await tailscalePeers();
    const now = Date.now();
    const online = new Map(); // target -> Tailscale's name for it
    const offline = new Set();
    for (const p of peers || []) (p.online ? online.set(p.ip, p.name) : offline.add(p.ip));
    for (const t of this.extra) online.set(t, t);
    // (Pis seen before that Tailscale doesn't list now: asked anyway, in case it's only the list)
    for (const k of Object.values(this.known)) if (!online.has(k.target) && !offline.has(k.target) && !peers) online.set(k.target, k.target);
    const knownTarget = new Set(Object.values(this.known).map((k) => k.target));
    const targets = [...online.keys()].filter((t) => knownTarget.has(t) || !(this.notOne.get(t) > now));
    const answers = await Promise.all(targets.map((t) => ask(t, "GET", "/api/node").then((a) => [t, a])));
    const nodes = new Map();
    for (const [target, a] of answers) {
      if (a.status === 200 && a.name && Array.isArray(a.modules)) {
        this.notOne.delete(target);
        // (a Pi that moved to another address keeps its place, by its name)
        this.known[a.name] = { target, seen: now, node: a };
        nodes.set(a.name, { name: a.name, target, online: true, answering: true, seen: now, node: a, error: null });
      } else if (knownTarget.has(target)) {
        const name = Object.keys(this.known).find((n) => this.known[n].target === target);
        const k = this.known[name];
        nodes.set(name, { name, target, online: true, answering: false, seen: k.seen, node: k.node, error: a.error || `It answered ${a.status}.` });
      } else if (!this.extra.includes(target)) {
        this.notOne.set(target, now + NOT_ONE_MS);
      }
    }
    for (const [name, k] of Object.entries(this.known)) {
      if (nodes.has(name)) continue;
      if (now - (k.seen || 0) > KEEP_DAYS * 86400000) {
        delete this.known[name];
        continue;
      }
      nodes.set(name, { name, target: k.target, online: !offline.has(k.target) && online.has(k.target), answering: false, seen: k.seen, node: k.node, error: null });
    }
    this.save();
    return { nodes: [...nodes.values()].sort((a, b) => a.name.localeCompare(b.name)), tailscale: !!peers, at: now };
  }

  // (only to a Pi this has found: never an address the page made up)
  target(t) {
    const target = String(t || "");
    if (!Object.values(this.known).some((k) => k.target === target) && !this.extra.includes(target)) throw new Error("That Pi isn't one of the cluster's.");
    return target;
  }

  settings({ target, module, on, key, value } = {}) {
    const body = { module: String(module || "") };
    if (typeof on === "boolean") body.on = on;
    if (key !== undefined) Object.assign(body, { key: String(key), value });
    return ask(this.target(target), "POST", "/api/settings", body);
  }

  action({ target, module, action, args } = {}) {
    return ask(this.target(target), "POST", "/api/action", { module: String(module || ""), action: String(action || ""), args: args && typeof args === "object" ? args : {} });
  }

  forget(name) {
    delete this.known[String(name)];
    this.save();
    return { ok: true };
  }
}

module.exports = { Cluster, PORT };
