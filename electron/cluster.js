/**
 * cluster.js — the Cluster app's side in the main process (its own app: APP.kind "cluster").
 * It finds the Pis running Cluster's service (cluster/node: port 47830) among the Linux
 * and Windows computers on this computer's Tailscale network (this one too: a Windows PC can be a
 * member), and passes the page's requests on to them. (The page can't ask them itself: it's
 * served from app://, and the service only answers requests that carry its own header.)
 *
 *   const c = new Cluster({ file });  // file: the Pis seen before, shown while they're away
 *   await c.list()      -> { nodes: [{ name, target, online, answering, seen, node, error }], tailscale, at }
 *                          (online: Tailscale has it on; answering: its service answered just now;
 *                          node: what it said, or what it said last time)
 *   await c.settings({ target, module, on } | { target, module, key, value }) -> { status, ...answer }
 *   await c.action({ target, module, action, args })                         -> { status, ...answer }
 *   c.forget(name)
 *   await c.upload({ target, job, files: [{ path, name }] }, onProgress)  files for a job, to the Pi that keeps the list
 *   await c.download({ target, job, dir }, onProgress)                     a job's results, into dir/<its title>/
 *
 * HT_CLUSTER_NODES=host:port,… are asked as well (the checks: a simulated Pi on this computer; with
 * HT_CLUSTER_ONLY=1, only those).
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFile } = require("child_process");

const PORT = 47830;
const ASK_MS = 5000;
const NOT_ONE_MS = 60000; // a computer whose port didn't answer (no service there): asked again after this
const KEEP_DAYS = 30; // a Pi not seen for this long is no longer listed
const UPLOAD_PIECE = 8 << 20; // (the service takes up to 16 MB a piece)
const DOWNLOAD_PIECE = 4 << 20; // (as the service gives them)

function tailscaleCli() {
  if (process.platform === "win32") return path.join(process.env.ProgramFiles || "C:\\Program Files", "Tailscale", "tailscale.exe");
  const mac = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  if (process.platform === "darwin" && fs.existsSync(mac)) return mac;
  return "tailscale";
}

// The Linux and Windows computers on this Tailscale network, this one too (a Windows PC can be a member of the
// cluster itself: cluster/node/windows), and the phones (members too, in the Cluster app: phone true): [{ name, ip,
// online, phone? }], or null (no Tailscale here).
function tailscalePeers() {
  return new Promise((resolve) => {
    execFile(tailscaleCli(), ["status", "--json"], { timeout: 8000, windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const status = JSON.parse(stdout);
        const peers = Object.values(status.Peer || {}).concat(status.Self ? [Object.assign({ Online: true }, status.Self)] : []);
        resolve(
          peers
            .filter((p) => ["linux", "windows", "android", "ios"].includes(String(p.OS || "").toLowerCase()))
            .map((p) => ({ name: String(p.HostName || ""), ip: (p.TailscaleIPs || []).find((a) => !String(a).includes(":")), online: !!p.Online,
              ...(["android", "ios"].includes(String(p.OS || "").toLowerCase()) ? { phone: true } : {}) }))
            .filter((p) => p.ip),
        );
      } catch {
        resolve(null);
      }
    });
  });
}

// One request to a Pi's service: target is "100.x.y.z" (its port is the service's) or "host:port".
// body: JSON; raw: bytes as they are (a piece of a file). An answer that isn't JSON comes back as
// { status, bytes }. to: a phone of the cluster, asked through that Pi (X-HT-Cluster-To: it has the phone's key).
function ask(target, method, urlPath, body, { raw = null, timeout = ASK_MS, to = null } = {}) {
  const [host, port] = target.includes(":") ? [target.split(":")[0], Number(target.split(":")[1])] : [target, PORT];
  const data = raw || (body === undefined ? null : Buffer.from(JSON.stringify(body)));
  const type = raw ? "application/octet-stream" : "application/json";
  return new Promise((resolve) => {
    const req = http.request(
      {
        host, port, path: urlPath, method,
        headers: { "X-HT-Cluster": "1", Host: `${host}:${port}`, ...(to ? { "X-HT-Cluster-To": to } : {}), ...(data ? { "Content-Type": type, "Content-Length": data.length } : {}) },
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const all = Buffer.concat(chunks);
          if (!String(res.headers["content-type"] || "").startsWith("application/json")) return resolve({ status: res.statusCode, bytes: all });
          let json = {};
          try {
            json = JSON.parse(all.toString("utf8") || "{}");
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
    this.phoneVia = new Map(); // a phone's address -> the Pi it's asked through (the Pis have its key)
    // (the checks: phones at these addresses, as Tailscale would list them)
    this.phoneTargets = String(process.env.HT_CLUSTER_PHONES || "").split(",").map((t) => t.trim()).filter(Boolean);
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
    const peers = process.env.HT_CLUSTER_ONLY ? [] : await tailscalePeers(); // (the checks: only HT_CLUSTER_NODES)
    const now = Date.now();
    const online = new Map(); // target -> Tailscale's name for it
    const offline = new Set();
    for (const p of peers || []) (p.online ? online.set(p.ip, p.name) : offline.add(p.ip));
    for (const t of this.extra) online.set(t, t);
    // (Pis seen before that Tailscale doesn't list now: asked anyway, in case it's only the list)
    for (const k of Object.values(this.known)) if (!online.has(k.target) && !offline.has(k.target) && !peers) online.set(k.target, k.target);
    const knownTarget = new Set(Object.values(this.known).map((k) => k.target));
    const phones = new Set((peers || []).filter((p) => p.phone).map((p) => p.ip));
    for (const t of this.phoneTargets) {
      phones.add(t);
      online.set(t, t);
    }
    const targets = [...online.keys()].filter((t) => knownTarget.has(t) || !(this.notOne.get(t) > now));
    // The computers first, then the phones through one of them that answered.
    const answers = await Promise.all(targets.filter((t) => !phones.has(t)).map((t) => ask(t, "GET", "/api/node").then((a) => [t, a])));
    const via = (answers.find(([t, a]) => a.status === 200 && a.name && a.platform !== "android" && a.platform !== "ios") || [])[0];
    for (const t of phones) {
      if (via) this.phoneVia.set(t, via);
      else this.phoneVia.delete(t);
    }
    answers.push(...await Promise.all(targets.filter((t) => phones.has(t) && via).map((t) => this.ask(t, "GET", "/api/node").then((a) => [t, a]))));
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

  // A request to one of the cluster's computers, a phone through a Pi (ask's to).
  ask(target, method, urlPath, body, opts = {}) {
    const via = this.phoneVia.get(target);
    return via ? ask(via, method, urlPath, body, { ...opts, to: target }) : ask(target, method, urlPath, body, opts);
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
    return this.ask(this.target(target), "POST", "/api/settings", body);
  }

  action({ target, module, action, args } = {}) {
    return this.ask(this.target(target), "POST", "/api/action", { module: String(module || ""), action: String(action || ""), args: args && typeof args === "object" ? args : {} });
  }

  forget(name) {
    delete this.known[String(name)];
    this.save();
    return { ok: true };
  }

  // Files from this computer for a job, to the Pi that keeps the job list, a piece at a time:
  // files [{ path, name }] (paths this computer's own file picker gave). onProgress({ name, sent, size }).
  async upload({ target, job, files } = {}, onProgress = () => {}) {
    const t = this.target(target);
    for (const f of files || []) {
      const size = (await fs.promises.stat(f.path)).size;
      const fh = await fs.promises.open(f.path, "r");
      try {
        let at = 0;
        do {
          const buf = Buffer.alloc(Math.min(UPLOAD_PIECE, size - at));
          const { bytesRead } = await fh.read(buf, 0, buf.length, at);
          const last = at + bytesRead >= size ? 1 : 0;
          const q = `job=${encodeURIComponent(job)}&name=${encodeURIComponent(f.name)}&at=${at}&last=${last}`;
          const a = await this.ask(t, "PUT", `/api/jobs/upload?${q}`, undefined, { raw: buf.subarray(0, bytesRead), timeout: 120000 });
          if (a.status !== 200) throw new Error(`${f.name}: ${a.error || `it answered ${a.status}`}`);
          at += bytesRead;
          onProgress({ name: f.name, sent: at, size });
        } while (at < size);
      } finally {
        await fh.close();
      }
    }
    return { ok: true };
  }

  // A job's results, from the Pi that keeps the job list, into dir/<the job's title>/.
  // onProgress({ name, got, files, done }).
  async download({ target, job, dir } = {}, onProgress = () => {}) {
    const t = this.target(target);
    const list = await this.ask(t, "POST", "/api/action", { module: "jobs", action: "results", args: { job } });
    if (list.status !== 200) throw new Error(list.error || "Couldn't list its results.");
    const folder = path.join(dir, String(list.title || job).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || job);
    let done = 0;
    for (const f of list.files || []) {
      const out = path.join(folder, ...f.path.split("/"));
      if (!out.startsWith(folder + path.sep)) continue; // (nothing outside its folder)
      await fs.promises.mkdir(path.dirname(out), { recursive: true });
      const fh = await fs.promises.open(out + ".part", "w");
      try {
        let at = 0;
        for (;;) {
          const a = await this.ask(t, "GET", `/api/jobs/result-file?job=${encodeURIComponent(job)}&path=${encodeURIComponent(f.path)}&at=${at}`, undefined, { timeout: 120000 });
          if (a.status !== 200 || !a.bytes) throw new Error(`${f.path}: ${a.error || `it answered ${a.status}`}`);
          await fh.write(a.bytes, 0, a.bytes.length, at);
          at += a.bytes.length;
          if (a.bytes.length < DOWNLOAD_PIECE || at >= f.size) break;
        }
      } finally {
        await fh.close();
      }
      await fs.promises.rename(out + ".part", out);
      onProgress({ name: f.path, got: ++done, files: list.files.length });
    }
    return { ok: true, folder, files: done };
  }
}

module.exports = { Cluster, PORT };
