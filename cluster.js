/**
 * cluster.js — Cluster's page (cluster.html), in its own app. Lists the Pis running
 * Cluster's service (window.desktop.cluster: electron/cluster.js finds them over Tailscale), asked
 * again every few seconds:
 *   Pis — each Pi's modules, the same way for every module (a module this page doesn't know yet
 *     too): its one-line summary, its warnings and its buttons; under ⚙, each module's switch for
 *     that Pi and its settings; and what happened lately (updates and the like).
 *   Camera rigs — each Pi's Hand Tracker: its cameras, recording, Sentry on or off, Start or
 *     Restart, and updating it.
 * A Pi that's away (unplugged, out of battery, off the Wi-Fi) stays listed, faded, with when it
 * was last seen and what it said then, until it's back or forgotten.
 *
 * On a phone (Cluster's Android and iPhone apps: the "cluster" flavor, ios-variant.js cluster)
 * the same page goes through the app's own Cluster plugin (ClusterPlugin.java, RemoteLink.swift)
 * instead: phoneCluster() below, the same calls. A phone has no Tailscale command to list the
 * Pis, so it asks the Pis it knows (the first time: "pi", by its Tailscale name, or one named on
 * Add a Pi) which others there are; and a job's results come as one zip, into Downloads (iPhone:
 * the Files app).
 *
 * This phone in the cluster (the Cluster app on Android: its own switch, at the top): while it's on, the app runs
 * Cluster's own service here (MemberService.java), so this phone is one of the cluster's members, with its health, jobs
 * and downloads, listed with the Pis. Phones are reached through a Pi (only the Pis have each phone's key). A Pi's
 * shared folders (its FTP link: cluster/node/modules/ftp.py) open here too, through the app's Ftp plugin: its folders
 * looked through, a file fetched into Downloads or one sent from the phone, a folder made (not deleting anything).
 *
 * In a browser (on a device on the same Tailscale account): a Pi's own service serves this page at
 * http://<that Pi>:47830/ (cluster/node/ht_cluster.py) and says so in a meta tag; browserCluster()
 * below asks that Pi, which passes a request for another Pi on (X-HT-Cluster-To), and a job's results
 * come as one zip, saved by the browser through a one-time link.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  // What this page remembers on a device, under names from before the rename (2026-11-25: "Pi Cluster" became
  // "Cluster"): copied to the new names the first time (the old ones left, for an older copy of the page).
  try {
    const RENAMED = { piClusterPis: "clusterPis", "piCluster.torrentSort": "cluster.torrentSort", "piCluster.addOn": "cluster.addOn",
      piClusterAskedNotices: "clusterAskedNotices", piClusterSeenBuild: "clusterSeenBuild" };
    for (const [was, now] of Object.entries(RENAMED)) {
      const kept = localStorage.getItem(was);
      if (kept !== null && localStorage.getItem(now) === null) localStorage.setItem(now, kept);
    }
  } catch {}
  const api = (window.desktop && window.desktop.cluster) || phoneCluster() || browserCluster();
  const REFRESH_MS = 4000;

  // ---------- in a browser: the page as a Pi served it, the same calls through that Pi ----------
  function browserCluster() {
    const meta = document.querySelector('meta[name="ht-cluster-page"]');
    if (!meta || !/^https?:$/.test(location.protocol)) return null;
    const SELF = location.host; // (the Pi that served the page: asked directly; the others through it)
    const KEY = "clusterPis";
    const ASK_MS = 8000;
    const PIECE = 8 << 20; // (a file's piece going to a Pi: the service takes up to 16 MB)
    let known = {};
    try {
      known = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
    } catch {}
    const keep = () => {
      try {
        localStorage.setItem(KEY, JSON.stringify(known));
      } catch {}
    };
    const files = new Map(); // picked here: id -> File
    const notOne = new Map(); // a computer whose service didn't answer: not asked again for a minute
    let peers = { at: 0, list: [] };
    const listeners = new Set();
    const tell = (p) => listeners.forEach((cb) => cb(p));

    async function ask(target, method, path, { body, blob, timeoutMs = ASK_MS } = {}) {
      const headers = { "X-HT-Cluster": "1" };
      if (target && target !== SELF) headers["X-HT-Cluster-To"] = target;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      else if (blob) headers["Content-Type"] = "application/octet-stream";
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : blob, signal: ctl.signal, cache: "no-store", credentials: "omit" });
        if ((r.headers.get("Content-Type") || "").startsWith("application/json")) {
          let j = {};
          try {
            j = await r.json();
          } catch {
            j = { error: "Its answer wasn't readable." };
          }
          return { status: r.status, ...(j && typeof j === "object" ? j : {}) };
        }
        return { status: r.status, error: r.ok ? null : (await r.text()).slice(0, 200) || `It answered ${r.status}.` };
      } catch (e) {
        return { status: 0, error: e && e.name === "AbortError" ? "No answer" : (e && e.message) || String(e) };
      } finally {
        clearTimeout(timer);
      }
    }

    async function list() {
      const now = Date.now();
      // The Pis the Pi that served the page sees on Tailscale (asked once a minute).
      if (now - peers.at > 60000) {
        const a = await ask(SELF, "GET", "/api/peers");
        if (a.status === 200 && Array.isArray(a.peers)) peers = { at: now, list: a.peers.filter((p) => p.online && p.ip).map((p) => String(p.ip)) };
      }
      const knownTarget = new Set(Object.values(known).map((k) => k.target));
      const targets = [SELF, ...peers.list.filter((t) => t !== SELF && (knownTarget.has(t) || !(notOne.get(t) > now)))];
      const answers = await Promise.all(targets.map((t) => ask(t, "GET", "/api/node").then((a) => [t, a])));
      const nodes = new Map();
      for (const [target, a] of answers) {
        if (a.status === 200 && a.name && Array.isArray(a.modules)) {
          notOne.delete(target);
          known[a.name] = { target, seen: now, node: a };
          nodes.set(a.name, { name: a.name, target, online: true, answering: true, seen: now, node: a, error: null });
        } else {
          const name = Object.keys(known).find((n) => known[n].target === target);
          if (name && !nodes.has(name)) nodes.set(name, { name, target, online: true, answering: false, seen: known[name].seen, node: known[name].node, error: a.error || `It answered ${a.status}.` });
          else if (!name && target !== SELF) notOne.set(target, now + 60000);
        }
      }
      for (const [name, k] of Object.entries(known)) {
        if (nodes.has(name)) continue;
        if (now - (k.seen || 0) > 30 * 86400000) {
          delete known[name];
          continue;
        }
        nodes.set(name, { name, target: k.target, online: k.target === SELF || peers.list.includes(k.target), answering: false, seen: k.seen, node: k.node, error: null });
      }
      keep();
      return { nodes: [...nodes.values()].sort((a, b) => a.name.localeCompare(b.name)), tailscale: true, browser: true, at: now };
    }

    const post = (target, path, body, timeoutMs = 30000) => ask(target, "POST", path, { body, timeoutMs });
    // (picked on this device, through a file box: the page reads it a piece at a time)
    const pick = (accept) => new Promise((resolve) => {
      const input = Object.assign(document.createElement("input"), { type: "file", multiple: !accept, accept: accept || "" });
      input.onchange = () => {
        resolve([...(input.files || [])].map((f) => {
          const id = `browser:${files.size}:${f.name}`;
          files.set(id, f);
          return { path: id, name: f.name, size: f.size };
        }));
      };
      input.click();
    });

    return {
      browser: true,
      served: meta.content,
      list,
      settings: ({ target, module, on, key, value }) => post(target, "/api/settings", { module, ...(typeof on === "boolean" ? { on } : {}), ...(key !== undefined ? { key, value } : {}) }),
      action: ({ target, module, action, args }) => post(target, "/api/action", { module, action, args: args || {} }),
      forget: async (name) => {
        delete known[name];
        keep();
        return { ok: true };
      },
      pickFiles: () => pick(""),
      pickModel: () => pick(".onnx"),
      pickFolder: async () => "your browser's downloads", // (a browser saves a job's results as one zip, there)
      async upload({ target, job, files: list }) {
        for (const f of list || []) {
          const file = files.get(f.path);
          if (!file) throw new Error(`${f.name} isn't one picked on this device.`);
          let at = 0;
          do {
            const piece = file.slice(at, Math.min(file.size, at + PIECE));
            const last = at + piece.size >= file.size ? 1 : 0;
            const a = await ask(target, "PUT", `/api/jobs/upload?job=${encodeURIComponent(job)}&name=${encodeURIComponent(f.name)}&at=${at}&last=${last}`, { blob: piece, timeoutMs: 120000 });
            if (a.status !== 200) throw new Error(`${f.name}: ${a.error || `it answered ${a.status}`}`);
            at += piece.size;
            tell({ name: f.name, sent: at, size: file.size });
          } while (at < file.size);
        }
        return { ok: true };
      },
      // A job's results as one zip (packed on the Pi that keeps the job list), saved by the browser
      // itself from a one-time link (it can't add the service's header to a download).
      async download({ target, job }) {
        const z = await post(target, "/api/action", { module: "jobs", action: "zip", args: { job } }, 300000);
        if (z.status !== 200 || !z.ok) throw new Error(z.error || "Its results couldn't be packed.");
        const t = await post(SELF, "/api/ticket", { ...(target !== SELF ? { to: target } : {}), path: `/api/jobs/zip-file?job=${encodeURIComponent(job)}&whole=1` });
        if (t.status !== 200 || !t.ok || !/^\/api\/download\?ticket=/.test(t.url || "")) throw new Error(t.error || "The device didn't give a link to save it from.");
        const a = Object.assign(document.createElement("a"), { href: t.url, download: z.name, hidden: true });
        document.body.append(a);
        a.click();
        a.remove();
        return { ok: true, message: `Saving ${z.name} (${(z.size / 1e6).toFixed(1)} MB) in your browser's downloads.` };
      },
      onProgress: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
  }

  // ---------- on a phone: the same calls as electron/cluster.js, through the app's Cluster plugin ----------
  function phoneCluster() {
    const cap = window.Capacitor;
    const P = cap && cap.Plugins && cap.Plugins.Cluster;
    if (!P) return null;
    const KEY = "clusterPis";
    const PIECE = 2 << 20; // (a file's piece going to a Pi, through the app's bridge as base64)
    const ASK_MS = 6000;
    let known = {};
    try {
      known = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
    } catch {}
    const keep = () => {
      try {
        localStorage.setItem(KEY, JSON.stringify(known));
      } catch {}
    };
    const files = new Map(); // picked here: id -> File
    let peers = { at: 0, list: [] };
    const listeners = new Set();
    // The phones of the cluster (members too: their own switch in this app), asked through the Pi whose Tailscale
    // peers they are (the Pis have their keys; this page doesn't): phone address -> that Pi.
    const phoneVia = new Map();

    async function ask(target, method, path, { body, data, timeoutMs = ASK_MS } = {}) {
      try {
        const via = phoneVia.get(target);
        const a = await P.request({ target: via || target, ...(via ? { to: target } : {}), method, path, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...(data ? { data } : {}), timeoutMs });
        if (String(a.type || "").startsWith("application/json")) {
          let j = {};
          try {
            j = JSON.parse(a.body || "{}");
          } catch {
            j = { error: "Its answer wasn't readable." };
          }
          return { status: a.status, ...(j && typeof j === "object" ? j : {}) };
        }
        return { status: a.status, data: a.data || "" };
      } catch (e) {
        return { status: 0, error: (e && e.message) || String(e) };
      }
    }

    async function list() {
      const now = Date.now();
      const targets = new Set(Object.values(known).map((k) => k.target));
      if (!targets.size) targets.add("pi"); // (the first time: the Pi called pi, by its Tailscale name)
      // The Pis the known ones see on Tailscale (asked once a minute).
      if (now - peers.at > 60000) {
        for (const t of targets) {
          if (phoneVia.has(t)) continue; // (a phone: it doesn't list the others)
          const a = await ask(t, "GET", "/api/peers");
          if (a.status === 200 && Array.isArray(a.peers)) {
            peers = { at: now, list: a.peers.filter((p) => p.online).map((p) => p.ip) };
            phoneVia.clear();
            for (const p of a.peers) if (p.phone && p.ip) phoneVia.set(p.ip, t);
            break;
          }
        }
      }
      for (const ip of peers.list) targets.add(ip);
      const answers = await Promise.all([...targets].map((t) => ask(t, "GET", "/api/node").then((a) => [t, a])));
      const nodes = new Map();
      for (const [target, a] of answers) {
        if (a.status === 200 && a.name && Array.isArray(a.modules)) {
          // (a Pi reached by name the first time is kept by its name: it's the same either way)
          const was = known[a.name];
          known[a.name] = { target: was && was.target !== target && /^\d/.test(target) && !/^\d/.test(was.target) ? was.target : target, seen: now, node: a };
          nodes.set(a.name, { name: a.name, target: known[a.name].target, online: true, answering: true, seen: now, node: a, error: null });
        }
      }
      for (const [name, k] of Object.entries(known)) {
        if (nodes.has(name)) continue;
        if (now - (k.seen || 0) > 30 * 86400000) {
          delete known[name];
          continue;
        }
        nodes.set(name, { name, target: k.target, online: false, answering: false, seen: k.seen, node: k.node, error: null });
      }
      keep();
      return { nodes: [...nodes.values()].sort((a, b) => a.name.localeCompare(b.name)), tailscale: true, phone: true, at: now };
    }

    async function addPi(name) {
      const target = String(name || "").trim();
      const a = await ask(target, "GET", "/api/node");
      if (a.status !== 200 || !a.name) return { ok: false, error: a.error || `${target} didn't answer as a device of the cluster (${a.status || "no answer"}).` };
      known[a.name] = { target, seen: Date.now(), node: a };
      keep();
      return { ok: true, name: a.name };
    }

    const post = (target, path, body) => ask(target, "POST", path, { body, timeoutMs: 30000 });
    // (one picked on this phone, through a file box: the page reads it a piece at a time)
    const pick = (accept) => new Promise((resolve) => {
      const input = Object.assign(document.createElement("input"), { type: "file", multiple: !accept, accept: accept || "" });
      input.onchange = () => {
        resolve([...(input.files || [])].map((f) => {
          const id = `phone:${files.size}:${f.name}`;
          files.set(id, f);
          return { path: id, name: f.name, size: f.size };
        }));
      };
      input.click();
    });
    const base64 = (buf) => {
      let s = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    };
    const tell = (p) => listeners.forEach((cb) => cb(p));

    return {
      phone: true,
      list,
      addPi,
      // (the Pis this app knows, as its own member service finds the others through them)
      seeds: () => [...new Set([...Object.values(known).filter((k) => !(k.node && ["android", "ios"].includes(k.node.platform))).map((k) => k.target),
        ...peers.list.filter((ip) => !phoneVia.has(ip))])].slice(0, 32),
      settings: ({ target, module, on, key, value }) => post(target, "/api/settings", { module, ...(typeof on === "boolean" ? { on } : {}), ...(key !== undefined ? { key, value } : {}) }),
      action: ({ target, module, action, args }) => post(target, "/api/action", { module, action, args: args || {} }),
      forget: async (name) => {
        delete known[name];
        keep();
        return { ok: true };
      },
      pickFiles: () => pick(""),
      pickModel: () => pick(".onnx"),
      pickFolder: async () => "Downloads", // (a phone saves a job's results as one zip, there)
      async upload({ target, job, files: list }) {
        for (const f of list || []) {
          const file = files.get(f.path);
          if (!file) throw new Error(`${f.name} isn't one picked on this phone.`);
          let at = 0;
          do {
            const piece = await file.slice(at, Math.min(file.size, at + PIECE)).arrayBuffer();
            const last = at + piece.byteLength >= file.size ? 1 : 0;
            const a = await ask(target, "PUT", `/api/jobs/upload?job=${encodeURIComponent(job)}&name=${encodeURIComponent(f.name)}&at=${at}&last=${last}`, { data: base64(piece), timeoutMs: 120000 });
            if (a.status !== 200) throw new Error(`${f.name}: ${a.error || `it answered ${a.status}`}`);
            at += piece.byteLength;
            tell({ name: f.name, sent: at, size: file.size });
          } while (at < file.size);
        }
        return { ok: true };
      },
      async download({ target, job }) {
        const z = await post(target, "/api/action", { module: "jobs", action: "zip", args: { job } });
        if (z.status !== 200 || !z.ok) throw new Error(z.error || "Its results couldn't be packed.");
        const handle = await P.addListener("progress", (p) => tell({ name: p.name, got: p.got, size: p.size, zip: true }));
        try {
          const got = await P.save({ target, path: `/api/jobs/zip-file?job=${encodeURIComponent(job)}`, name: z.name, size: z.size });
          return { ok: true, message: `Saved ${z.name} (${(z.size / 1e6).toFixed(1)} MB) in ${got.saved}` };
        } finally {
          if (handle && handle.remove) handle.remove();
        }
      },
      onProgress: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
  }
  // ---------- a Pi's shared folders, over its FTP link (the Cluster app on Android: its Ftp plugin) ----------
  const Ftp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Ftp;
  const files = { pi: null, path: "/", entries: [], busy: false, error: "", note: "" };
  const sizeText = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`);
  function filesButton(pi) {
    const f = Ftp && mod(pi.node, "ftp");
    const st = (f && f.on && f.status) || {};
    if (!st.ready || !(st.folders || []).length) return null;
    const b = el("button", { textContent: "Shared folders", title: `${pi.name}'s shared folders (${st.folders.join(", ")}), over its FTP link` });
    b.onclick = () => openFiles(pi, "/");
    return b;
  }
  async function openFiles(pi, path) {
    Object.assign(files, { pi, path, busy: true, error: "", note: files.pi === pi ? files.note : "" });
    renderFiles();
    try {
      const a = await Ftp.list({ host: pi.target, path });
      files.entries = (a.entries || []).sort((x, y) => (x.dir === y.dir ? x.name.localeCompare(y.name) : x.dir ? -1 : 1));
    } catch (e) {
      files.entries = [];
      files.error = (e && e.message) || String(e);
    }
    files.busy = false;
    renderFiles();
  }
  const joinPath = (dir, name) => `${dir.replace(/\/+$/, "")}/${name}`;
  function renderFiles() {
    const box = $("filesBox");
    if (!box) return;
    if (!files.pi) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const close = el("button", { textContent: "✕", title: "Close" });
    close.onclick = () => {
      files.pi = null;
      renderFiles();
    };
    const up = el("button", { textContent: "↑ Up", disabled: files.path === "/" || files.busy });
    up.onclick = () => openFiles(files.pi, files.path.replace(/\/[^/]*\/?$/, "") || "/");
    const send = el("button", { textContent: "Send a file here", disabled: files.path === "/" || files.busy, title: "A file from this phone, into this folder on the device" });
    send.onclick = async () => {
      try {
        const a = await Ftp.upload({ host: files.pi.target, dir: files.path });
        files.note = `Sent ${a.name}${a.size >= 0 ? ` (${sizeText(a.size)})` : ""}.`;
      } catch (e) {
        files.note = (e && e.message) || String(e);
      }
      openFiles(files.pi, files.path);
    };
    const make = el("button", { textContent: "New folder", disabled: files.path === "/" || files.busy });
    make.onclick = async () => {
      const name = (prompt("The new folder's name:") || "").trim();
      if (!name || /[\/\\]/.test(name)) return;
      try {
        await Ftp.mkdir({ host: files.pi.target, path: joinPath(files.path, name) });
      } catch (e) {
        files.note = (e && e.message) || String(e);
      }
      openFiles(files.pi, files.path);
    };
    const rows = files.entries.map((e) => {
      const row = el("button", { className: "fileRow", textContent: e.dir ? `📁 ${e.name}` : `${e.name} · ${sizeText(e.size)}` });
      row.onclick = async () => {
        if (e.dir) return openFiles(files.pi, joinPath(files.path, e.name));
        const into = window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform() === "ios" ? "this iPhone's files (the Files app)" : "this phone's Downloads";
        if (!confirm(`Fetch ${e.name} (${sizeText(e.size)}) into ${into}?`)) return;
        files.note = `Fetching ${e.name}…`;
        renderFiles();
        const handle = await Ftp.addListener("progress", (p) => {
          files.note = `Fetching ${p.name}: ${p.size > 0 ? Math.round((100 * p.got) / p.size) : sizeText(p.got)}${p.size > 0 ? "%" : ""}`;
          renderFiles();
        });
        try {
          const got = await Ftp.download({ host: files.pi.target, path: joinPath(files.path, e.name), name: e.name, size: e.size });
          files.note = `${e.name} is in ${(got && got.saved) || "Downloads"}.`;
        } catch (err) {
          files.note = `${e.name}: ${(err && err.message) || err}`;
        } finally {
          if (handle && handle.remove) handle.remove();
        }
        renderFiles();
      };
      return row;
    });
    box.replaceChildren(
      el("div", { className: "top" }, el("b", {}, `${files.pi.name}'s shared folders`), el("span", { className: "sub" }, files.path), close),
      el("div", { className: "buttons" }, up, send, make),
      files.busy ? el("div", { className: "sub" }, "Looking…") : "",
      files.error ? el("div", { className: "warn-line" }, files.error) : "",
      files.note ? el("div", { className: "sub" }, files.note) : "",
      !files.busy && !files.error && !rows.length ? el("div", { className: "sub" }, "Nothing here.") : "",
      el("div", { className: "fileList" }, rows),
    );
  }

  // ---------- this phone in the cluster (the Cluster app on Android: its own switch) ----------
  const Member = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Member;
  let member = null;
  async function memberStatus() {
    if (!Member) return;
    try {
      member = await Member.status();
    } catch (e) {
      member = { error: (e && e.message) || String(e) };
    }
    renderMember();
  }
  function renderMember() {
    const box = $("memberBox");
    if (!Member || !box) return;
    const m = member || {};
    // (an iPhone app without its own Python, as Hand Tracker's are: nothing to switch on)
    box.hidden = m.available === false;
    if (box.hidden) return;
    const btn = el("button", { textContent: m.on ? "On" : "Off", title: m.on ? "Leave the cluster (this phone only looks at it)" : "Join the cluster: its health, jobs and downloads, as the devices'" });
    btn.setAttribute("aria-pressed", String(!!m.on));
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        member = m.on ? await Member.stop() : await Member.start({ seeds: api && api.seeds ? api.seeds() : [] });
      } catch (e) {
        say(`This phone couldn't ${m.on ? "leave" : "join"}: ${(e && e.message) || e}`, true);
      }
      renderMember();
      setTimeout(memberStatus, 1500);
    };
    const words = !m.on ? "Off: this phone only looks at the cluster."
      : !m.running ? "Starting…"
      : m.address ? `In the cluster as ${m.name} (${m.address}): its health, jobs and downloads, listed with the other devices.`
      : `In the cluster as ${m.name}, but Tailscale isn't on here, so the devices can't reach it.`;
    // (an iPhone: only while the app is open, as an iPhone gives an app no time of its own in the background)
    const iphone = m.platform === "ios" && m.on ? " While this app is open: an iPhone gives an app no time of its own in the background." : "";
    // (its Hand Tracker takes, shared with the cluster as a Pi's are, once Android's All files access is on for this app)
    let takes = "";
    if (m.on && m.takes === false) {
      const allow = el("button", { textContent: "Allow", title: "Android's All files access for this app (in its Settings): this phone's Hand Tracker takes shared with the cluster" });
      allow.onclick = async () => {
        member = await Member.allowTakes();
        renderMember();
      };
      takes = el("div", { className: "sub" }, "This phone's Hand Tracker takes aren't shared yet: turn on All files access for this app. ", allow);
    }
    box.replaceChildren(el("div", { className: "top" }, el("b", {}, "This phone in the cluster"), el("span", { className: "sub" }, words + iphone), el("span", { className: "spans" }, btn)),
      takes, m.error ? el("div", { className: "warn-line" }, m.error) : "");
  }

  const open = new Set(); // Pis whose ⚙ is open
  let data = null;
  let tab = "pis";
  let asking = false;
  let messageTimer = null;

  function el(tag, props = {}, ...kids) {
    const e = Object.assign(document.createElement(tag), props);
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : String(k));
    return e;
  }
  const mod = (node, name) => (node && node.modules ? node.modules.find((m) => m.name === name) : null);
  const short = (c) => (c && /^[0-9a-f]{40}$/.test(c) ? c.slice(0, 7) : c || "");
  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (!ms) return "never";
    if (s < 90) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  }
  const clock = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  function say(text, bad = false) {
    const m = $("message");
    m.textContent = text;
    m.className = bad ? "err" : "";
    m.hidden = !text;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => (m.hidden = true), bad ? 12000 : 6000);
  }

  const recording = (pi) => {
    const r = mod(pi.node, "rig");
    return !!(r && r.on && r.status && (r.status.recording || r.status.saving));
  };

  // A module's button on a Pi. Updating or restarting while it records asks first, and then
  // doesn't wait for the recording to end (the take is saved first).
  async function act(pi, module, action, args = {}) {
    const m = mod(pi.node, module);
    const a = m && (m.actions || []).find((x) => x.name === action);
    const waits = ["updateHandTracker", "updateOS", "reboot"].includes(action);
    if (waits && recording(pi)) {
      const what = action === "reboot" ? "Restart it now anyway" : "Update it now anyway, rather than once it stops";
      if (!confirm(`${pi.name} is recording. ${what}? The take is saved first.`)) return;
      args = { ...args, force: true };
    } else if (a && a.confirm && !confirm(`${pi.name}: ${a.confirm}`)) return;
    const answer = await api.action({ target: pi.target, module, action, args }).catch((e) => ({ error: e.message }));
    say(`${pi.name}: ${answer.message || answer.error || "Done."}`, !!answer.error && !answer.ok);
    setTimeout(refresh, 600);
  }

  async function set(pi, module, change) {
    // (one Pi keeps the job list: choosing one takes it off the others)
    // (one Pi keeps the job list, and one Transmission's files: choosing one takes it off the others)
    if ((module === "jobs" || module === "apps") && change.key === "home" && change.value === true) {
      for (const other of ((data && data.nodes) || []).filter((p) => p.answering && p.name !== pi.name)) {
        const j = mod(other.node, module);
        if (j && j.status && j.status.home) await api.settings({ target: other.target, module, key: "home", value: false }).catch(() => {});
      }
    }
    const answer = await api.settings({ target: pi.target, module, ...change }).catch((e) => ({ error: e.message }));
    if (answer.error) say(`${pi.name}: ${answer.error}`, true);
    refresh();
  }

  function moduleBlock(pi, m) {
    const st = m.status || {};
    const live = pi.answering;
    const block = el("div", { className: "mod" }, el("div", { className: "mod-title" }, m.title));
    if (st.summary) block.append(el("div", { className: "summary" }, st.summary));
    for (const w of st.warnings || []) block.append(el("div", { className: "warn-line" }, "⚠ " + w));
    if (m.error) block.append(el("div", { className: "warn-line" }, `⚠ ${m.title} had a problem: ${m.error}`));
    if (m.name === "rig" && st.cameras && st.cameras.length) block.append(cameraLine(st.cameras));
    if (m.name === "rig" && st.space) block.append(el("div", { className: "cams" }, `Space: ${st.space}`));
    if (m.name === "health" && st.boots && st.boots.length) block.append(bootsBox(st.boots));
    const buttons = (m.actions || []).filter((a) => !a.hidden && actionMakesSense(m, a));
    if (live && buttons.length) {
      block.append(el("div", { className: "buttons" }, buttons.map((a) => {
        const b = el("button", { textContent: a.title, className: m.name === "updates" && a.name === "reboot" && st.os && st.os.rebootNeeded ? "warn" : "" });
        b.onclick = () => act(pi, m.name, a.name);
        return b;
      })));
    }
    return block;
  }

  // (Start only when Hand Tracker isn't running, Restart only when it is)
  function actionMakesSense(m, a) {
    const st = m.status || {};
    if (m.name === "rig" && a.name === "start") return st.app === "not running";
    if (m.name === "rig" && a.name === "restart") return st.app === "running" && st.answering;
    if (m.name === "downloads" && a.name === "getLibtorrent") return st.ready && !st.home && st.pieces === false;
    if (m.name === "downloads" && a.name === "getTransmission") return st.ready === false && !st.home;
    return true;
  }

  // Its last starts and why (health.py: after a restart, a shutdown, its power cut, or a freeze), newest first.
  function bootsBox(boots) {
    const when = (s) => (s ? new Date(s * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "?");
    const box = el("details", { className: "boots" }, el("summary", {}, `Starts: last ${when(boots[0].at)}, after ${boots[0].words}`));
    for (const b of boots) {
      const bad = ["power", "froze", "unknown"].includes(b.cause);
      box.append(el("div", { className: bad ? "warn-line" : "cams" }, `${when(b.at)}: after ${b.words}${b.lastSeen && bad ? ` (last heard from ${when(b.lastSeen)})` : ""}`));
    }
    return box;
  }

  function cameraLine(cams) {
    return el("div", { className: "cams" }, cams.map((c) => `${c.role ? c.role + ": " : ""}${c.name || "camera"}${c.fps ? ` ${Math.round(c.fps)} fps` : ""}${c.chipC ? ` · chip ${Math.round(c.chipC)} °C` : ""}${c.error ? ` · ${c.error}` : ""}`).join(" · "));
  }

  function settingsBlock(pi) {
    const box = el("div", { className: "settings" });
    for (const m of pi.node.modules) {
      const on = el("input", { type: "checkbox", checked: !!m.on });
      on.onchange = () => set(pi, m.name, { on: on.checked });
      box.append(el("h3", {}, el("label", {}, on, m.title)));
      if (!m.on) continue;
      for (const s of m.settings || []) {
        if (Array.isArray(s.choices)) {
          const sel = el("select", {}, s.choices.map(([v, t]) => el("option", { value: v, textContent: t, selected: v === s.value })));
          sel.onchange = () => set(pi, m.name, { key: s.key, value: sel.value });
          box.append(el("label", {}, s.title, sel));
        } else {
          const cb = el("input", { type: "checkbox", checked: !!s.value });
          cb.onchange = () => set(pi, m.name, { key: s.key, value: cb.checked });
          box.append(el("label", {}, cb, s.title));
        }
      }
    }
    return box;
  }

  function header(pi) {
    const node = pi.node || {};
    const health = mod(node, "health");
    const model = health && health.status && health.status.model ? health.status.model.replace(/ Model B| Rev [\d.]+/g, "") : "";
    const dot = el("span", { className: "dot" + (pi.answering ? " on" : pi.online ? " part" : "") });
    const sub = pi.answering
      ? [model, node.version && `service ${short(node.version)}`].filter(Boolean).join(" · ")
      : pi.online
        ? `On Tailscale, but its Cluster service isn't answering${pi.error ? ` (${pi.error})` : ""} · last answered ${ago(pi.seen)}`
        : `Away · last seen ${ago(pi.seen)}`;
    const top = el("div", { className: "top" }, dot, el("span", { className: "name" }, pi.name), el("span", { className: "sub" }, sub));
    if (!pi.answering) {
      const forget = el("button", { textContent: "Forget", title: "Take it off this list (it comes back if its service answers again)" });
      forget.onclick = async () => {
        if (!confirm(`Take ${pi.name} off the list? It comes back by itself if its Cluster service answers again.`)) return;
        await api.forget(pi.name);
        refresh();
      };
      top.append(forget);
    } else {
      const gear = el("button", { textContent: open.has(pi.name) ? "⚙ Close" : "⚙", title: "This device's modules and settings" });
      gear.onclick = () => {
        open.has(pi.name) ? open.delete(pi.name) : open.add(pi.name);
        render();
      };
      const shared = filesButton(pi);
      if (shared) top.append(shared);
      top.append(gear);
    }
    return top;
  }

  function piCard(pi) {
    const card = el("div", { className: "card" + (pi.answering ? "" : " away") }, header(pi));
    const node = pi.node;
    if (!node) return card;
    for (const m of node.modules.filter((x) => x.on)) card.append(moduleBlock(pi, m));
    if (pi.answering && open.has(pi.name)) card.append(settingsBlock(pi));
    const events = (node.events || []).slice(-5).reverse();
    if (events.length) {
      card.append(el("div", { className: "events" }, events.map((e) => el("div", { className: e.bad ? "bad" : "" }, `${clock(e.at)} — ${e.text}`))));
    }
    return card;
  }

  function rigCard(pi) {
    const card = el("div", { className: "card" + (pi.answering ? "" : " away") }, header(pi));
    const rig = mod(pi.node, "rig");
    if (!rig || !rig.on) {
      card.append(el("div", { className: "mod summary" }, "Its camera rig module is off (⚙ on the Devices tab)."));
      return card;
    }
    const st = rig.status || {};
    card.append(el("div", { className: "mod summary" }, st.summary || ""));
    for (const w of st.warnings || []) card.append(el("div", { className: "warn-line" }, "⚠ " + w));
    if (st.cameras && st.cameras.length) card.append(cameraLine(st.cameras));
    const updates = mod(pi.node, "updates");
    if (updates && updates.on && updates.status && updates.status.handTracker) {
      const inst = st.installed || {};
      card.append(el("div", { className: "cams" }, `Hand Tracker ${inst.commit ? short(inst.commit) : inst.version || ""}: ${updates.status.handTracker.state}`));
    }
    if (!pi.answering) return card;
    const buttons = el("div", { className: "buttons" });
    if (st.app === "running" && st.answering) {
      const s = el("button", { textContent: st.sentry ? "Turn Sentry off" : "Turn Sentry on" });
      s.onclick = () => act(pi, "rig", "sentry", { armed: !st.sentry });
      buttons.append(s);
    }
    for (const a of (rig.actions || []).filter((x) => !x.hidden && actionMakesSense(rig, x))) {
      const b = el("button", { textContent: a.title });
      b.onclick = () => act(pi, "rig", a.name);
      buttons.append(b);
    }
    if (updates && updates.on && st.installed) {
      const u = el("button", { textContent: "Update Hand Tracker now" });
      u.onclick = () => act(pi, "updates", "updateHandTracker");
      buttons.append(u);
    }
    card.append(buttons);
    return card;
  }

  function render() {
    // (not while a list is open: it would close under the pointer)
    if (document.activeElement && document.activeElement.tagName === "SELECT") return;
    const nodes = (data && data.nodes) || [];
    const pis = $("pis");
    const rigs = $("rigs");
    if (!nodes.length) {
      const why = data && data.phone ? " Is Tailscale on? Add a device can look for one by its name (pi is tried first)." : data && !data.tailscale ? " Tailscale isn't running on this computer (or isn't installed), so no devices can be found yet." : "";
      pis.replaceChildren(el("div", { className: "empty" }, `No devices yet. Press Add a device to put one in the cluster.${why}`));
      rigs.replaceChildren(el("div", { className: "empty" }, "No devices yet."));
    } else {
      pis.replaceChildren(...nodes.map(piCard));
      rigs.replaceChildren(...nodes.filter((p) => p.node).map(rigCard));
    }
    renderJobs();
    if (!$("runOpts").hidden && !$("newJob").hidden) showRunOptions(); // (its members and where the cluster password is set, as they change)
    renderTransmission();
    const live = nodes.filter((p) => p.answering).length;
    $("note").textContent = data
      ? `${live} of ${nodes.length} device${nodes.length === 1 ? "" : "s"} answering${data.tailscale ? "" : " · Tailscale isn't running on this computer"} · updated ${new Date(data.at).toLocaleTimeString()}`
      : "Looking for devices over Tailscale…";
    $("updateAll").disabled = !live;
  }

  async function refresh() {
    if (asking || !api) return;
    asking = true;
    try {
      data = await api.list();
    } catch (e) {
      say(`Couldn't list the devices: ${e.message}`, true);
    } finally {
      asking = false;
    }
    render();
  }

  // ---------- Transmission: the cluster's (apps.py), run on whichever Pi is free ----------
  const STATUS = ["paused", "waiting to check", "checking", "waiting to download", "downloading", "waiting to seed", "seeding"];
  let torrents = { at: 0, list: [], error: null };
  const add = { folder: null, file: null, browsing: null };

  function trHome() {
    const nodes = (data && data.nodes) || [];
    return nodes.find((p) => p.node && mod(p.node, "apps") && mod(p.node, "apps").on && (mod(p.node, "apps").status || {}).home) || null;
  }

  const rate = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB/s` : `${Math.round((b || 0) / 1e3)} KB/s`);
  const bytes = (b) => (!b ? "0 B" : b >= 1e12 ? `${(b / 1e12).toFixed(2)} TB` : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.round(b / 1e3)} KB`);
  const homeRel = (p, home) => (home && p && p.startsWith(home) ? "~" + p.slice(home.length) : p || "");

  // How much of a torrent is here (the user, 2026-11-22: "show download percentage for each torrent"; their
  // choices: a bar, the number beside its name, one decimal place): rounded down, so it says 100% only once
  // it's all here. [0 to 1, its words]
  function percent(t) {
    const done = Math.max(0, Math.min(1, Number(t.percentDone) || 0));
    return [done, done >= 1 ? "100%" : `${(Math.floor(done * 1000 + 1e-6) / 10).toFixed(1)}%`];
  }

  // Its bar under its name, filled that far, with the number on it (green once it's all here; grey while it's paused).
  function percentBar(t, done, pct) {
    const bar = el("div", { className: "tr-bar" + (done >= 1 ? " done" : t.status === 0 ? " paused" : "") },
      el("div", { className: "fill", style: `width:${(done * 100).toFixed(2)}%` }), el("span", { className: "num" }, pct));
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", `${t.name}: downloaded`);
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", pct.replace("%", ""));
    bar.setAttribute("aria-valuetext", pct);
    return bar;
  }

  // The torrent list's order (the user, 2026-11-24: "sort torrents by alphabetical, activity, age, and by queue";
  // their choices: activity is the fastest now first, age the newest first, a Reverse switch for any of them, and
  // each device remembering the last one chosen, queue at first).
  const TR_SORT_KEY = "cluster.torrentSort";
  const trName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" });
  const trQueue = (a, b) => (a.queuePosition || 0) - (b.queuePosition || 0);
  const trSpeed = (t) => (t.rateDownload || 0) + (t.rateUpload || 0);
  const TR_ORDER = {
    name: trName,
    activity: (a, b) => trSpeed(b) - trSpeed(a) || trQueue(a, b),
    // (when it was added; from a home whose service doesn't say yet, the order Transmission numbered them in)
    age: (a, b) => (b.addedDate || 0) - (a.addedDate || 0) || (b.id || 0) - (a.id || 0) || trName(a, b),
    queue: trQueue,
  };
  function trSort() {
    try {
      const s = JSON.parse(localStorage.getItem(TR_SORT_KEY) || "null");
      if (s && TR_ORDER[s.by]) return { by: s.by, reverse: !!s.reverse };
    } catch {}
    return { by: "queue", reverse: false };
  }
  function setTrSort(change) {
    try {
      localStorage.setItem(TR_SORT_KEY, JSON.stringify({ ...trSort(), ...change }));
    } catch {}
    renderTransmission();
  }
  $("trSort").onchange = () => setTrSort({ by: $("trSort").value });
  $("trReverse").onchange = () => setTrSort({ reverse: $("trReverse").checked });

  // Each torrent's traffic: its drop-down (open ones by the torrent's hash, with their graph's span) and the
  // readings its graph is drawn from (the home keeps them: apps.py's traffic).
  const trOpen = new Map();
  const trGraph = new Map();
  const trAsking = new Set();
  let trSent = null; // (limits just sent: shown until the Pi's word catches up)
  const SPAN_MS = { "1h": 3600e3, "24h": 86400e3, "7d": 7 * 86400e3 };
  const SPAN_AGO = { "1h": "1 h ago", "24h": "24 h ago", "7d": "7 days ago" };

  // Received and sent over the span, scaled to a round number over the most in view (10 KB/s at least); a
  // gap where readings are missing (the Pi off, or Transmission moving).
  function trafficSvg(points, span) {
    const W = 300, H = 84, top = 12, bottom = 70;
    const to = Date.now(), from = to - SPAN_MS[span];
    const pts = points.filter((p) => p[0] >= from);
    const most = Math.max(1e4, ...pts.map((p) => Math.max(p[1] || 0, p[2] || 0)));
    const step = 10 ** Math.floor(Math.log10(most));
    const max = [1, 2, 5, 10].map((m) => m * step).find((m) => m >= most);
    const x = (t) => (((t - from) / (to - from)) * W).toFixed(1);
    const y = (v) => (bottom - (Math.min(v, max) / max) * (bottom - top)).toFixed(1);
    const gap = Math.max(3 * 60000, (SPAN_MS[span] / 360) * 3);
    const line = (i) => {
      let d = "", last = null;
      for (const p of pts) {
        d += `${last === null || p[0] - last > gap ? "M" : "L"}${x(p[0])},${y(p[i] || 0)}`;
        last = p[0];
      }
      return d;
    };
    const grid = [0, max / 2, max].map((v) => `<line class="grid" x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${W - 2}" y="${y(v) - 2}" text-anchor="end">${v ? rate(v) : "0"}</text>`).join("");
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Received and sent since ${SPAN_AGO[span]}">${grid}<path class="down" d="${line(1)}"/><path class="up" d="${line(2)}"/>` +
      `<text class="axis" x="0" y="${H - 2}">${SPAN_AGO[span]}</text><text class="axis" x="${W - 2}" y="${H - 2}" text-anchor="end">now</text></svg>`;
  }

  function drawTraffic(graph, key) {
    const have = trGraph.get(key), span = trOpen.get(key) || "1h";
    if (!have || have.span !== span) return graph.replaceChildren(el("div", { className: "hint" }, "Reading…"));
    if (have.error) return graph.replaceChildren(el("div", { className: "warn-line" }, "⚠ " + have.error));
    if (!have.points.length) return graph.replaceChildren(el("div", { className: "hint" }, "No readings yet: the device keeping Transmission's files reads them every 10 seconds."));
    graph.innerHTML = trafficSvg(have.points, span) + '<div class="legend"><span><i class="sw down"></i>Received ↓</span><span><i class="sw up"></i>Sent ↑</span></div>';
  }

  // A torrent's readings for its graph's span, from the home: the last hour's every 10 s, the others' a minute.
  async function loadTraffic(home, key, now = false) {
    const span = trOpen.get(key);
    if (!span || !home || !home.answering || trAsking.has(key)) return;
    const have = trGraph.get(key);
    if (!now && have && have.span === span && Date.now() - have.at < (span === "1h" ? 10000 : 60000)) return;
    trAsking.add(key);
    const a = await api.action({ target: home.target, module: "apps", action: "traffic", args: { hash: key, span } }).catch((e) => ({ error: e.message }));
    trAsking.delete(key);
    if (trOpen.get(key) !== span) return; // (closed, or another span asked for meanwhile)
    trGraph.set(key, { span, at: Date.now(), points: a.ok ? a.points || [] : [], error: a.ok ? null : a.error || "Couldn't read it." });
    const g = document.querySelector(`#trList [data-traffic="${key}"]`); // (a hash: letters and digits)
    if (g) drawTraffic(g, key);
  }

  // A torrent's drop-down: its speeds now on it (0 too); inside, what it has received and sent in all, its
  // peers, asking for more, its place in the queue while it waits, and its traffic over 1 h, 24 h or 7 days.
  function trafficBox(home, t, key, waiting) {
    const box = el("details", { className: "traffic" });
    box.open = trOpen.has(key);
    const summary = el("summary", {}, `Traffic  ↓ ${rate(t.rateDownload)}  ↑ ${rate(t.rateUpload)}`);
    summary.dataset.fkey = "sum:" + key;
    box.append(summary);
    const peers = typeof t.peersConnected === "number" ? ` · ${t.peersConnected} peer${t.peersConnected === 1 ? "" : "s"} connected` : "";
    box.append(el("div", { className: "cams" }, `In all: ↓ ${bytes(t.downloadedEver)}  ↑ ${bytes(t.uploadedEver)}${peers}`));
    const button = (label, fkey, run, disabled = false) => {
      const b = el("button", { textContent: label, disabled });
      b.dataset.fkey = fkey + ":" + key;
      b.onclick = run;
      return b;
    };
    const buttons = el("div", { className: "buttons" }, button("Ask for more peers", "peers", () => act(home, "apps", "reannounce", { ids: [t.id] }).then(() => loadTorrents(true))));
    if (t.status === 3 || t.status === 5) {
      const line = waiting(t.status);
      const i = line.findIndex((x) => x.id === t.id);
      buttons.append(el("span", { className: "hint", style: "align-self:center" }, `${i + 1} of ${line.length} waiting to ${t.status === 3 ? "download" : "seed"}`));
      for (const [move, label] of [["top", "Top"], ["up", "Up"], ["down", "Down"], ["bottom", "Bottom"]]) {
        const first = move === "top" || move === "up";
        buttons.append(button(label, "q-" + move, () => act(home, "apps", "queue", { id: t.id, move }).then(() => loadTorrents(true)), first ? i <= 0 : i >= line.length - 1));
      }
    }
    box.append(buttons);
    const span = trOpen.get(key) || "1h";
    const spans = el("span", { className: "spans" }, ...[["1h", "1 h"], ["24h", "24 h"], ["7d", "7 days"]].map(([s, label]) => {
      const b = button(label, "span-" + s, () => {
        trOpen.set(key, s);
        loadTraffic(home, key, true);
        renderTransmission();
      });
      b.setAttribute("aria-pressed", String(s === span));
      return b;
    }));
    spans.setAttribute("role", "group");
    spans.setAttribute("aria-label", "Time span");
    const graph = el("div", { className: "graph" });
    graph.dataset.traffic = key;
    box.append(el("div", { className: "graph-head" }, el("span", {}, "Over time"), spans), graph);
    drawTraffic(graph, key);
    box.ontoggle = () => {
      if (box.open) {
        if (!trOpen.has(key)) trOpen.set(key, "1h");
        loadTraffic(home, key);
      } else trOpen.delete(key);
    };
    return box;
  }

  // How many download and seed at once, and how many peers: set from the Transmission tab's first card.
  function renderLimits(home, st) {
    const ses = { ...(st.session || {}), ...(trSent && Date.now() < trSent.until ? trSent.args : {}) };
    $("trLimits").hidden = !Object.keys(st.session || {}).length;
    $("trDlQueue").checked = !!ses.downloadQueue;
    $("trDlSize").value = ses.downloadQueueSize ?? "";
    $("trDlSize").disabled = !ses.downloadQueue;
    $("trSeedQueue").checked = !!ses.seedQueue;
    $("trSeedSize").value = ses.seedQueueSize ?? "";
    $("trSeedSize").disabled = !ses.seedQueue;
    $("trPeerAll").value = ses.peerLimit ?? "";
    $("trPeerOne").value = ses.peerLimitPerTorrent ?? "";
    const send = async (args) => {
      // (with any sent just before, so a second change doesn't show the first one's old value meanwhile)
      trSent = { args: { ...(trSent && Date.now() < trSent.until ? trSent.args : {}), ...args }, until: Date.now() + 15000 };
      const a = await api.action({ target: home.target, module: "apps", action: "limits", args }).catch((e) => ({ error: e.message }));
      say(`${home.name}: ${a.message || a.error || "Done."}`, !a.ok);
      if (!a.ok) trSent = null;
      renderTransmission();
      setTimeout(refresh, 600);
    };
    const n = (id) => Number($(id).value);
    $("trDlQueue").onchange = () => send({ downloadQueue: $("trDlQueue").checked });
    $("trDlSize").onchange = () => send({ downloadQueue: true, downloadQueueSize: n("trDlSize") });
    $("trSeedQueue").onchange = () => send({ seedQueue: $("trSeedQueue").checked });
    $("trSeedSize").onchange = () => send({ seedQueue: true, seedQueueSize: n("trSeedSize") });
    $("trPeerAll").onchange = () => send({ peerLimit: n("trPeerAll") });
    $("trPeerOne").onchange = () => send({ peerLimitPerTorrent: n("trPeerOne") });
    $("trPeersAll").onclick = () => act(home, "apps", "reannounce", {}).then(() => loadTorrents(true));
  }

  async function loadTorrents(now = false) {
    const home = trHome();
    if (!home || !home.answering || (!now && Date.now() - torrents.at < 8000)) return;
    torrents.at = Date.now();
    const a = await api.action({ target: home.target, module: "apps", action: "torrents", args: {} }).catch((e) => ({ error: e.message }));
    torrents = { at: Date.now(), list: a.torrents || [], error: a.ok ? null : a.error };
    if (tab === "transmission") renderTransmission();
  }

  function renderTransmission() {
    // (not while something's being typed or chosen there: it would be put back under the pointer)
    const f = document.activeElement;
    if (f && f.closest && f.closest("#transmission") && /^(INPUT|SELECT|TEXTAREA)$/.test(f.tagName) && f.type !== "checkbox") return;
    const home = trHome();
    const line = $("trHome");
    if (!home) {
      const live = ((data && data.nodes) || []).filter((p) => p.answering && mod(p.node, "apps"));
      $("trMain").hidden = true;
      if (!live.length) return line.replaceChildren("Transmission comes with the next update of the devices' service.");
      const sel = el("select", {}, live.map((p) => el("option", { value: p.name, textContent: p.name, selected: /^pi$/i.test(p.name) })));
      const use = el("button", { textContent: "Keep them there" });
      use.onclick = () => {
        const p = live.find((x) => x.name === sel.value);
        if (p) set(p, "apps", { key: "home", value: true });
      };
      return line.replaceChildren("Which device keeps Transmission's torrents, settings and files? ", sel, " ", use);
    }
    const st = mod(home.node, "apps").status || {};
    if (!st.migrated) {
      $("trMain").hidden = true;
      const go = el("button", { textContent: `Move ${home.name}'s Transmission torrents in`, className: "main" });
      go.onclick = async () => {
        if (!confirm(`Move the Transmission window app's torrents on ${home.name} into the cluster's Transmission? Each keeps its own folder and its progress; the window app closes, and opens empty from then on (Give them back undoes it).`)) return;
        say("Moving them in…");
        const a = await api.action({ target: home.target, module: "apps", action: "migrate", args: {} }).catch((e) => ({ error: e.message }));
        say(a.message || a.error, !a.ok);
        setTimeout(refresh, 800);
      };
      return line.replaceChildren(`${home.name} keeps Transmission's files. Its window app's torrents aren't in the cluster's Transmission yet. `, go);
    }
    line.textContent = `${home.name} keeps Transmission's files${(st.shared || []).length ? ` (shared with the devices running it: ${st.shared.map((n) => "~/" + n).join(", ")})` : ""}.`;
    $("trMain").hidden = false;
    $("trLine").textContent = (mod(home.node, "apps").status || {}).summary || "";
    $("trWarn").textContent = (st.warnings || []).map((w) => "⚠ " + w).join("  ");
    $("trTurtle").textContent = st.turtle ? "Turtle off" : "Turtle on";
    $("trTurtle").onclick = () => act(home, "apps", "turtle", { on: !st.turtle });
    const runners = ((data && data.nodes) || []).filter((p) => p.answering && mod(p.node, "apps") && mod(p.node, "apps").on);
    $("trWhere").replaceChildren(el("option", { value: "", textContent: "wherever's free", selected: !st.prefer }),
      ...runners.map((p) => el("option", { value: p.name, textContent: p.name + ((mod(p.node, "apps").status || {}).canRun ? "" : " (its switch is off)"), selected: st.prefer === p.name })));
    $("trWhere").onchange = () => act(home, "apps", "move", { to: $("trWhere").value || null });
    $("trWeb").onclick = () => window.open(`http://${home.target.split(":")[0]}:9092/transmission/web/`, "_blank");
    $("trFolder").textContent = add.folder ? homeRel(add.folder, add.browsing && add.browsing.home) : "its usual folder (~/Downloads)";
    renderLimits(home, st);
    renderAddOn(home);
    renderSpread(home);
    // (in the order chosen above the list: alphabetical, activity, age or queue, reversed if asked; trSort)
    const byQueue = (a, b) => (a.queuePosition || 0) - (b.queuePosition || 0);
    const sort = trSort();
    $("trSort").value = sort.by;
    $("trReverse").checked = sort.reverse;
    const list = torrents.list.slice().sort(TR_ORDER[sort.by] || byQueue);
    if (sort.reverse) list.reverse();
    const waiting = (status) => list.filter((x) => x.status === status).sort(byQueue);
    const was = document.activeElement && document.activeElement.closest && document.activeElement.closest("#trList") ? document.activeElement.dataset.fkey : null;
    $("trList").replaceChildren(torrents.error ? el("div", { className: "warn-line" }, "⚠ " + torrents.error) : "", ...list.map((t) => {
      const b = el("button", { textContent: t.status === 0 ? "Resume" : "Pause" });
      b.onclick = () => act(home, "apps", "torrent", { do: t.status === 0 ? "start" : "stop", ids: [t.id] }).then(() => loadTorrents(true));
      const bits = [STATUS[t.status] || "", homeRel(t.downloadDir, add.browsing && add.browsing.home)];
      const key = /^[0-9a-f]{40}$/i.test(t.hashString || "") ? t.hashString.toLowerCase() : null;
      const [done, pct] = percent(t);
      return el("div", { className: "card" }, el("div", { className: "top" }, el("span", { className: "summary", style: "flex:1;word-break:break-word" }, t.name), el("span", { className: "tr-pct" }, pct), b),
        percentBar(t, done, pct),
        el("div", { className: "cams" }, bits.filter(Boolean).join(" · ")), t.errorString ? el("div", { className: "warn-line" }, "⚠ " + t.errorString) : "",
        key ? trafficBox(home, t, key, waiting) : el("div", { className: "cams" }, `↓ ${rate(t.rateDownload)}  ↑ ${rate(t.rateUpload)}`));
    }));
    // (the keyboard's place kept, on a list drawn again)
    const back = was && [...$("trList").querySelectorAll("[data-fkey]")].find((e) => e.dataset.fkey === was);
    if (back) back.focus({ preventScroll: true });
    // (drop-downs of torrents gone are forgotten; open ones' graphs read again when due)
    const keys = new Set(list.map((t) => (t.hashString || "").toLowerCase()));
    for (const k of [...trOpen.keys()]) if (!keys.has(k) && torrents.list.length) trOpen.delete(k);
    for (const k of trOpen.keys()) loadTraffic(home, k);
    $("trGiveBack").onclick = async () => {
      if (!confirm(`Give the torrents back to the Transmission window app on ${home.name}? The cluster's Transmission stops and its folders stop being shared; open the window app to go on.`)) return;
      const a = await api.action({ target: home.target, module: "apps", action: "giveBack", args: {} }).catch((e) => ({ error: e.message }));
      say(a.message || a.error, !a.ok);
      setTimeout(refresh, 800);
    };
    loadTorrents();
    loadSpread();
  }

  // ---------- Downloads on other computers (downloads.py; the user, 2026-11-24: "decentralize the transmission
  // downloads from pi so any device can download and seed from that device and send it to pi"). A new download goes
  // to the home (its Transmission, as before), a computer by name, or the one with the most free network; it can be
  // split between computers, by files or by pieces; and once it's copied to the home, the home takes it over or the
  // computer keeps seeding it. Those choices are remembered on each device.
  let spread = { at: 0, list: [], computers: [], error: null, has: false };
  const DL_KEY = "cluster.addOn";
  function dlPrefs() {
    try {
      return JSON.parse(localStorage.getItem(DL_KEY) || "null") || {};
    } catch {
      return {};
    }
  }
  function setDlPrefs(change) {
    try {
      localStorage.setItem(DL_KEY, JSON.stringify({ ...dlPrefs(), ...change }));
    } catch {}
  }
  const hasDownloads = (home) => !!(home && mod(home.node, "downloads") && mod(home.node, "downloads").on);

  async function loadSpread(now = false) {
    const home = trHome();
    if (!hasDownloads(home) || !home.answering || (!now && Date.now() - spread.at < 8000)) return;
    spread.at = Date.now();
    const a = await api.action({ target: home.target, module: "downloads", action: "list", args: {} }).catch((e) => ({ error: e.message }));
    spread = { at: Date.now(), list: a.downloads || [], computers: a.computers || [], error: a.ok ? null : a.error, has: !!a.ok };
    if (tab === "transmission") renderTransmission();
  }

  const freeBytes = (c) => bytes(Math.max(0, (c.room || 0) - (c.reserve || 0)));
  const netWords = (c) => (c.net == null ? "network not read yet" : `network ${rate(c.net)}`);
  function computerWords(c) {
    if (c.home) return `its Transmission · ${freeBytes(c)} free · ${netWords(c)}`;
    if (!c.heard) return "not answering";
    if (!c.ready) return "no Transmission of its own";
    if (!c.free) return `not now: ${c.why || "busy"}`;
    return `${freeBytes(c)} free · ${netWords(c)}${c.pieces ? "" : " · no libtorrent"}`;
  }

  // "Download it on": the home, the computer with the most free network, or a computer by name (its room and how
  // busy its network is beside it); split and hand-over choices only for another computer.
  function renderAddOn(home) {
    const on = $("trOn");
    if (document.activeElement === on) return;
    const prefs = dlPrefs();
    const others = spread.computers.filter((c) => !c.home);
    const me = spread.computers.find((c) => c.home);
    const opts = [el("option", { value: "home", textContent: `${home.name} (${me ? computerWords(me) : "the cluster's Transmission"})` })];
    if (spread.has && others.length) {
      opts.push(el("option", { value: "freest", textContent: "The computer with the most free network" }));
      for (const c of others) opts.push(el("option", { value: c.name, textContent: `${c.name} (${computerWords(c)})`, disabled: !c.heard || !c.ready }));
    }
    on.replaceChildren(...opts);
    on.value = prefs.where && [...on.options].some((o) => o.value === prefs.where && !o.disabled) ? prefs.where : "home";
    const away = on.value !== "home";
    $("trSplitField").hidden = !away;
    $("trAfterField").hidden = !away;
    $("trSplit").value = prefs.split || "";
    for (const r of document.querySelectorAll('input[name="trAfter"]')) r.checked = r.value === (prefs.after || "home");
    $("trAfterTitle").textContent = `Once it's copied to ${home.name}`;
    $("trAfterHome").textContent = `${home.name} takes it over: its Transmission checks its copy and seeds it, and the computer's copy is deleted`;
    $("trOnNote").textContent = !hasDownloads(home) ? `Other computers can download too once ${home.name}'s service is updated.` :
      on.value === "freest" ? `The least busy network right now, among the computers free with room for it: ${home.name} too, and ${home.name} first if it's about as free (nothing to copy then).` :
      away && $("trSplit").value === "pieces" ? "Each computer needs libtorrent (Get libtorrent, under its Downloads on the Devices tab)." : "";
  }
  $("trOn").onchange = () => {
    setDlPrefs({ where: $("trOn").value });
    renderTransmission();
  };
  $("trSplit").onchange = () => {
    setDlPrefs({ split: $("trSplit").value });
    renderTransmission();
  };
  for (const r of document.querySelectorAll('input[name="trAfter"]')) r.onchange = () => setDlPrefs({ after: r.value });

  const pct1 = (x) => `${(Math.floor((x || 0) * 1000 + 1e-6) / 10).toFixed(1)}%`;
  function partLine(home, p) {
    let words;
    if (!p.heard) words = "not answering";
    else if (p.state === "downloading") {
      const peers = typeof p.peers === "number" ? ` · ${p.peers} peer${p.peers === 1 ? "" : "s"}` : "";
      words = `${pct1(p.pct)} · ↓ ${rate(p.down)} ↑ ${rate(p.up)}${peers}${p.free === false ? ` (waiting: ${p.why || "busy"})` : ""}`;
    } else if (p.state === "copying" && p.turn) words = `copying to ${home.name}: ${pct1(p.size ? p.copied / p.size : 0)}${p.copyRate ? ` (${rate(p.copyRate)})` : ""}`;
    else if (p.state === "copied") words = `copied to ${home.name}`;
    else words = `downloaded: waiting its turn to copy to ${home.name}${p.free === false ? ` (${p.why || "busy"})` : ""}`;
    const what = p.files != null ? ` (${p.files} file${p.files === 1 ? "" : "s"})` : p.pieces ? ` (pieces ${p.pieces[0] + 1} to ${p.pieces[1]})` : "";
    return el("div", { className: "cams" }, `${p.device}${what}: ${words}${p.error ? " · ⚠ " + p.error : ""}`);
  }

  function spreadCard(home, d) {
    const [done, pct] = percent({ percentDone: d.pct });
    const who = [...new Set(d.parts.map((p) => p.device))].join(", ");
    const keep = d.parts.length === 1 ? "keeps" : "keep";
    const send = async (action, args, ask) => {
      if (ask && !confirm(ask)) return;
      const a = await api.action({ target: home.target, module: "downloads", action, args: { id: d.id, ...args } }).catch((e) => ({ error: e.message }));
      say(a.message || a.error || "Done.", !a.ok);
      loadSpread(true);
      loadTorrents(true);
    };
    const buttons = [];
    const going = d.state === "downloading" || d.state === "metadata";
    if (going) buttons.push(el("button", { textContent: d.paused ? "Resume" : "Pause", onclick: () => send("pause", { paused: !d.paused }) }));
    if (d.state === "seeding") {
      buttons.push(el("button", { textContent: `Let ${home.name} take it over`,
        onclick: () => send("after", { after: "home" }, `${home.name}'s Transmission checks its copy of ${d.name} and seeds it; then the copies on ${who} are deleted. Go on?`) }));
    } else if (going) {
      buttons.push(el("button", { textContent: d.after === "home" ? `Keep seeding it on ${who} instead` : `Let ${home.name} take it over instead`,
        onclick: () => send("after", { after: d.after === "home" ? "keep" : "home" }) }));
    }
    buttons.push(el("button", { textContent: "Remove",
      onclick: () => send("remove", {}, `Remove ${d.name} from ${who}? Their copies are deleted${d.state === "seeding" ? `; ${home.name} keeps its own` : ""}.`) }));
    const allCopied = d.parts.length && d.parts.every((p) => p.state === "copied");
    const where = {
      metadata: `getting its list of files on ${who}`,
      downloading: allCopied ? `all copied: ${home.name} puts it together` : d.split ? `split between ${who} (${d.split === "files" ? "by files" : "by pieces"})` : `on ${who}`,
      checking: `on ${home.name}: its Transmission checks it${d.check && d.check.status === 2 ? ` (${pct1(d.check.recheck)})` : ""}, then seeds it`,
      seeding: `on ${home.name}, not seeded there; ${who} ${keep} seeding it`,
      failed: "stopped",
    }[d.state] || d.state;
    const then = d.state === "checking" || d.state === "seeding" || d.state === "failed" ? "" : d.after === "home" ? ` · then ${home.name} takes it over` : ` · then ${who} ${keep} seeding it`;
    return el("div", { className: "card" },
      el("div", { className: "top" }, el("span", { className: "summary", style: "flex:1;word-break:break-word" }, d.name), el("span", { className: "tr-pct" }, pct)),
      percentBar({ name: d.name, status: d.paused ? 0 : 4 }, done, pct),
      el("div", { className: "cams" }, `${where}${then} · into ${homeRel(d.folder, add.browsing && add.browsing.home)}${d.paused ? " · paused" : ""}`),
      d.error ? el("div", { className: "warn-line" }, "⚠ " + d.error) : "",
      ...(going ? d.parts.map((p) => partLine(home, p)) : []),
      el("div", { className: "buttons" }, buttons));
  }

  function renderSpread(home) {
    $("dlBox").hidden = !spread.list.length && !spread.error;
    $("dlList").replaceChildren(spread.error ? el("div", { className: "warn-line" }, "⚠ " + spread.error) : "", ...spread.list.map((d) => spreadCard(home, d)));
  }

  async function browseFolders(where) {
    const home = trHome();
    if (!home) return;
    const a = await api.action({ target: home.target, module: "apps", action: "folders", args: { path: where || "" } }).catch((e) => ({ error: e.message }));
    const box = $("trFolders");
    box.hidden = false;
    if (!a.ok) return box.replaceChildren(el("div", { className: "warn-line" }, a.error || "Couldn't look."));
    add.browsing = a;
    const use = el("button", { textContent: `Save it in ${homeRel(a.path, a.home) || "~"}` });
    use.onclick = () => {
      add.folder = a.path;
      box.hidden = true;
      renderTransmission();
    };
    const newName = el("input", { type: "text", placeholder: "or a new folder in it", style: "width:12em" });
    const make = el("button", { textContent: "Use the new folder" });
    make.onclick = () => {
      const n = newName.value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9 _.+()'-]{0,59}$/.test(n)) return say("A folder name: letters, numbers, spaces, - _ . + ( )", true);
      add.folder = a.path.replace(/\/$/, "") + "/" + n;
      box.hidden = true;
      renderTransmission();
    };
    const rows = [];
    if (a.parent) {
      const up = el("div", { className: "folder" }, "↑ " + (homeRel(a.parent, a.home) || "~"));
      up.onclick = () => browseFolders(a.parent);
      rows.push(up);
    }
    for (const f of a.folders) {
      const d = el("div", { className: "folder" }, "📁 " + f);
      d.onclick = () => browseFolders(a.path.replace(/\/$/, "") + "/" + f);
      rows.push(d);
    }
    box.replaceChildren(el("div", { className: "hint" }, `${home.name}: ${homeRel(a.path, a.home) || "~"}`), el("div", { className: "buttons" }, use, newName, make), ...rows);
  }

  $("trBrowse").onclick = () => browseFolders(add.folder || (add.browsing && add.browsing.path) || "");
  $("trTorrentFile").onclick = () => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: ".torrent,application/x-bittorrent" });
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      const bytes = new Uint8Array(await f.arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      add.file = { name: f.name, data: btoa(s) };
      $("trFileName").textContent = f.name;
      $("trMagnet").value = "";
    };
    input.click();
  };
  $("trAdd").onclick = async () => {
    const home = trHome();
    const magnet = $("trMagnet").value.trim();
    if (!home || (!magnet && !add.file)) return say("A magnet link or a .torrent file first.", true);
    say("Adding it…");
    // (to the home's Downloads when it has them: it adds it to its own Transmission itself, or sends it to another
    // computer, as chosen)
    const spreadOn = spread.has && hasDownloads(home);
    const where = spreadOn ? $("trOn").value || "home" : "home";
    const after = (document.querySelector('input[name="trAfter"]:checked') || {}).value || "home";
    const args = { ...(magnet ? { magnet } : { torrent: add.file.data }), ...(add.folder ? { folder: add.folder } : {}),
      ...(spreadOn ? { where, split: where === "home" ? null : $("trSplit").value || null, after } : {}) };
    const a = await api.action({ target: home.target, module: spreadOn ? "downloads" : "apps", action: "add", args }).catch((e) => ({ error: e.message }));
    say(a.message || a.error, !a.ok);
    if (a.ok) {
      $("trMagnet").value = "";
      add.file = null;
      $("trFileName").textContent = "";
      loadTorrents(true);
      loadSpread(true);
    }
  };

  function showTab(which) {
    tab = which;
    for (const t of ["pis", "rigs", "jobs", "transmission"]) {
      $("tab" + t[0].toUpperCase() + t.slice(1)).setAttribute("aria-selected", String(tab === t));
      $(t).hidden = tab !== t;
    }
  }

  // ---------- Jobs: the job list (on the Pi that keeps it), and making a job ----------
  const KINDS = { animals: "Animals in clips", convert: "Converting videos", command: "A command for each file", run: "Any command or script" };
  const shown = new Set(); // jobs whose files are listed
  const itemsOf = new Map(); // job -> its files, as last asked
  const pickedJobs = { recordings: new Map(), files: [], folder: null, model: null, script: null, members: null };
  let browsing = null;

  function homePi() {
    const nodes = (data && data.nodes) || [];
    return nodes.find((p) => p.node && (mod(p.node, "jobs") || {}).status && mod(p.node, "jobs").status.home && mod(p.node, "jobs").on) || null;
  }

  function renderJobs() {
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest("#newJob")) return;
    const home = homePi();
    for (const n of document.querySelectorAll(".homeName")) n.textContent = home ? home.name : "the device that keeps the jobs";
    const line = $("jobsHome");
    $("newJobBtn").disabled = !(home && home.answering);
    if (!home) {
      const live = ((data && data.nodes) || []).filter((p) => p.answering && mod(p.node, "jobs"));
      const sel = el("select", {}, live.map((p) => el("option", { value: p.name, textContent: p.name, selected: /^pi$/i.test(p.name) })));
      const use = el("button", { textContent: "Keep it there" });
      use.onclick = () => {
        const p = live.find((x) => x.name === sel.value);
        if (p) set(p, "jobs", { key: "home", value: true });
      };
      line.replaceChildren("No device keeps the job list yet. Which one should keep it (and the jobs' files)? ", sel, " ", use);
      $("jobList").replaceChildren();
      return;
    }
    const st = mod(home.node, "jobs").status;
    line.textContent = home.answering
      ? `${home.name} keeps the job list and the jobs' files (~/ht-cluster-jobs). Each device takes work when its switches (⚙ on the Devices tab) let it.`
      : `${home.name} keeps the job list, but it isn't answering: what's shown is from ${ago(home.seen)}.`;
    const jobs = st.jobs || [];
    $("jobList").replaceChildren(...(jobs.length ? jobs.map((j) => jobCard(home, j)) : [el("div", { className: "empty" }, "No jobs yet.")]));
  }

  function jobCard(home, j) {
    const c = j.counts || {};
    const finished = (c.done || 0) + (c.failed || 0);
    const parts = [KINDS[j.kind] || j.kind, j.state === "uploading" ? "waiting for its files" : j.state, `${c.done || 0} of ${j.files} done`];
    if (c.failed) parts.push(`${c.failed} failed`);
    if (c.stopped) parts.push(`${c.stopped} stopped`);
    if ((j.working || []).length) parts.push(`working: ${j.working.join(", ")}`);
    if (j.high) parts.push("high priority");
    const card = el("div", { className: "card" },
      el("div", { className: "top" }, el("span", { className: "name" }, j.title), el("span", { className: "sub" }, parts.join(" · "))),
      el("div", { className: "bar" }, el("div", { style: `width:${Math.round((100 * finished) / Math.max(1, j.files))}%` })));
    if (j.kind === "animals" && j.summary && (j.summary.kinds || []).length) {
      const text = j.summary.kinds.slice(0, 12).map(([kind, clips, pictures]) => `${kind} in ${clips} clip${clips === 1 ? "" : "s"} (${pictures} picture${pictures === 1 ? "" : "s"})`).join(" · ");
      card.append(el("div", { className: "mod summary" }, `${j.summary.pictures} pictures, ${j.summary.withAnimal} with an animal: ${text}`));
    } else if (j.kind === "animals" && j.summary) {
      card.append(el("div", { className: "mod summary" }, `${j.summary.pictures} pictures, no animal found yet`));
    }
    if (!home.answering) return card;
    if (j.needsPassword) {  // (a root job whose password the Pi keeping the list forgot as it restarted)
      const pw = el("input", { type: "password", autocomplete: "off", placeholder: "cluster password" });
      const go = el("button", { textContent: "Go on" });
      go.onclick = async () => {
        const a = await api.action({ target: home.target, module: "jobs", action: "jobPassword", args: { job: j.id, password: pw.value } }).catch((e) => ({ error: e.message }));
        pw.value = "";
        say(a.message || a.error, !a.ok);
        setTimeout(refresh, 500);
      };
      card.append(el("div", { className: "warn-line" }, `It runs as root: ${home.name} needs the cluster password again to go on (it restarted). `, pw, " ", go));
    }
    const buttons = el("div", { className: "buttons" });
    const button = (text, fn, cls = "") => {
      const b = el("button", { textContent: text, className: cls });
      b.onclick = fn;
      buttons.append(b);
    };
    if (c.done) button("Save results…", () => saveResults(home, j), "main");
    if (["waiting", "running", "uploading"].includes(j.state)) button("Stop", () => jobAction(home, "stop", j));
    if ((c.failed || c.stopped) && !["waiting", "running"].includes(j.state)) button("Try those again", () => jobAction(home, "again", j));
    if (!c.running) button("Remove", () => confirm(`Remove ${j.title}, and its files and results on ${home.name}?`) && jobAction(home, "remove", j));
    button(shown.has(j.id) ? "Hide its files" : "Its files", async () => {
      if (shown.has(j.id)) shown.delete(j.id);
      else {
        shown.add(j.id);
        await loadItems(home, j.id);
      }
      render();
    });
    card.append(buttons);
    if (shown.has(j.id)) {
      if (["waiting", "running"].includes(j.state)) loadItems(home, j.id); // (as it goes)
      const items = itemsOf.get(j.id) || [];
      card.append(el("div", { className: "items" }, items.map((it) => el("div", { className: it.state === "failed" ? "bad" : "" },
        `${it.name}${it.from && !it.only ? ` (from ${it.from})` : ""}: ${it.state}${it.worker ? ` on ${it.worker}` : ""}${it.state === "running" ? ` ${Math.round(100 * (it.progress || 0))}%` : ""}${it.error ? ` — ${it.error}` : ""}`))));
    }
    return card;
  }

  async function loadItems(home, jid) {
    const a = await api.action({ target: home.target, module: "jobs", action: "items", args: { job: jid } }).catch(() => null);
    if (a && a.job) itemsOf.set(jid, a.job.items || []);
  }

  async function jobAction(home, action, j) {
    const a = await api.action({ target: home.target, module: "jobs", action, args: { job: j.id } }).catch((e) => ({ error: e.message }));
    say(a.message || a.error || "Done.", !!a.error);
    setTimeout(refresh, 400);
  }

  async function saveResults(home, j) {
    const dir = await api.pickFolder();
    if (!dir) return;
    say(`Saving ${j.title}'s results…`);
    try {
      const got = await api.download({ target: home.target, job: j.id, dir });
      say(got.message || `Saved ${got.files} file${got.files === 1 ? "" : "s"} in ${got.folder}`);
    } catch (e) {
      say(`Couldn't save them: ${e.message}`, true);
    }
  }

  // The new job's form
  const kindNow = () => (document.querySelector('input[name="kind"]:checked') || {}).value || "animals";
  function showOptions() {
    $("animalsOpts").hidden = kindNow() !== "animals";
    $("commandOpts").hidden = kindNow() !== "command";
    $("runOpts").hidden = kindNow() !== "run";
    $("filesField").hidden = kindNow() === "run" && runHow() !== "files";
    if (kindNow() === "run") showRunOptions();
    const m = pickedJobs.model;
    const app = window.SentryModels && window.SentryModels.MODELS.finder;
    $("modelName").textContent = m ? `${m.name} (from this computer)` : app ? `the app's own (${app.name})` : "?";
    $("appModel").hidden = !m;
    const n = pickedJobs.recordings.size + pickedJobs.files.length;
    const bits = [];
    if (pickedJobs.recordings.size) bits.push(`${pickedJobs.recordings.size} recording${pickedJobs.recordings.size === 1 ? "" : "s"} on the devices`);
    if (pickedJobs.files.length) bits.push(`${pickedJobs.files.length} file${pickedJobs.files.length === 1 ? "" : "s"} from this ${api && api.phone ? "phone" : api && api.browser ? "device" : "computer"}`);
    if (pickedJobs.folder) bits.push(`the folder ${pickedJobs.folder}`);
    $("chosen").textContent = bits.length ? "Chosen: " + bits.join(", ") + "." : "No files chosen yet.";
    $("startJob").disabled = !(n || pickedJobs.folder) && !(kindNow() === "run" && runHow() !== "files");
  }

  // Any command or script (the run kind; the user, 2026-11-24: "make the cluster do anything together"): once on each
  // chosen member, or split over files, lines or numbers; as root only with the cluster password, set here on every member.
  const runHow = () => (document.querySelector('input[name="runHow"]:checked') || {}).value || "each";
  const members = () => ((data && data.nodes) || []).filter((p) => p.answering && mod(p.node, "jobs") && mod(p.node, "jobs").on);
  const onPhone = (p) => !!(p.node && ["android", "ios"].includes(p.node.platform));
  function showRunOptions() {
    const live = members();
    $("runMembers").replaceChildren(...live.map((p) => {
      const cb = el("input", { type: "checkbox", checked: !pickedJobs.members || pickedJobs.members.has(p.name) });
      cb.onchange = () => {
        if (!pickedJobs.members) pickedJobs.members = new Set(members().map((x) => x.name));
        cb.checked ? pickedJobs.members.add(p.name) : pickedJobs.members.delete(p.name);
      };
      const st = (mod(p.node, "jobs") || {}).status || {};
      return el("label", {}, cb, p.name + (st.runs === false ? " (its Linux isn't set up)" : ""));
    }));
    $("runScriptName").textContent = pickedJobs.script ? pickedJobs.script.name : "";
    $("runNoScript").hidden = !pickedJobs.script;
    $("runCommand").disabled = !!pickedJobs.script;
    $("runPassword").disabled = !$("runRoot").checked;
    // (phones run nothing as root: no cluster password on them)
    const set = live.filter((p) => !onPhone(p) && ((mod(p.node, "jobs") || {}).status || {}).passwordSet);
    const unset = live.filter((p) => !onPhone(p) && !set.includes(p));
    $("passwordState").textContent = !set.length ? "No cluster password set yet." : unset.length
      ? `Set on ${set.map((p) => p.name).join(", ")}; not on ${unset.map((p) => p.name).join(", ")}.` : `Set on every member (${set.length}).`;
  }
  for (const r of document.querySelectorAll('input[name="runHow"]')) r.onchange = showOptions;
  $("runRoot").onchange = showOptions;
  $("runScript").onclick = async () => {
    const got = await api.pickFiles();
    if (got && got[0]) pickedJobs.script = got[0];
    showOptions();
  };
  $("runNoScript").onclick = () => {
    pickedJobs.script = null;
    showOptions();
  };
  $("clusterPassword").onclick = () => {
    $("pwBox").hidden = !$("pwBox").hidden;
    $("pwSaid").textContent = "";
  };
  $("pwSet").onclick = async () => {
    const neu = $("pwNew").value;
    if (neu.length < 8) return ($("pwSaid").textContent = "8 characters or more.");
    if (neu !== $("pwAgain").value) return ($("pwSaid").textContent = "The two new ones aren't the same.");
    const old = $("pwOld").value;
    $("pwSaid").textContent = "Setting it…";
    const said = await Promise.all(members().filter((p) => !onPhone(p)).map((p) => api.action({ target: p.target, module: "jobs", action: "setPassword", args: { new: neu, old } })
      .then((a) => `${p.name}: ${a.ok ? "set" : a.error}`).catch((e) => `${p.name}: ${e.message}`)));
    for (const id of ["pwOld", "pwNew", "pwAgain"]) $(id).value = "";
    $("pwSaid").textContent = said.join(" · ");
    setTimeout(refresh, 600);
  };

  function resetForm() {
    pickedJobs.recordings.clear();
    pickedJobs.files = [];
    pickedJobs.folder = null;
    pickedJobs.model = null;
    pickedJobs.script = null;
    pickedJobs.members = null;
    $("runPassword").value = "";
    $("runRoot").checked = false;
    $("recordingsBox").hidden = true;
    $("browseBox").hidden = true;
    $("jobTitle").value = "";
    $("jobHigh").checked = false;
    showOptions();
  }

  async function showRecordings() {
    const box = $("recordingsBox");
    box.hidden = false;
    box.replaceChildren(el("div", { className: "hint" }, "Asking the devices…"));
    const pis = ((data && data.nodes) || []).filter((p) => p.answering && mod(p.node, "jobs") && mod(p.node, "jobs").on);
    const lists = await Promise.all(pis.map((p) => api.action({ target: p.target, module: "jobs", action: "recordings", args: {} }).then((a) => [p, a]).catch((e) => [p, { error: e.message }])));
    box.replaceChildren(...lists.flatMap(([p, a]) => {
      const recs = a.recordings || [];
      const all = el("input", { type: "checkbox" });
      const rows = recs.map((r) => {
        const key = `${p.name}\n${r.path}`;
        const cb = el("input", { type: "checkbox", checked: pickedJobs.recordings.has(key) });
        cb.onchange = () => {
          cb.checked ? pickedJobs.recordings.set(key, { node: p.name, name: r.name, path: r.path, size: r.size }) : pickedJobs.recordings.delete(key);
          showOptions();
        };
        return el("label", {}, cb, `${r.name} · ${clock(r.at)} · ${(r.size / 1e6).toFixed(r.size < 1e7 ? 1 : 0)} MB`);
      });
      all.onchange = () => {
        for (const row of rows) {
          const cb = row.querySelector("input");
          if (cb.checked !== all.checked) {
            cb.checked = all.checked;
            cb.onchange();
          }
        }
      };
      const head = el("h4", {}, el("label", {}, all, `${p.name}: ${recs.length ? `${recs.length} recording${recs.length === 1 ? "" : "s"}` : a.error ? a.error : "no recordings"}`));
      return [head, ...rows];
    }));
  }

  async function browse(where) {
    const home = homePi();
    if (!home) return;
    const a = await api.action({ target: home.target, module: "jobs", action: "browse", args: { path: where || "" } }).catch((e) => ({ error: e.message }));
    const box = $("browseBox");
    box.hidden = false;
    if (!a.ok) {
      box.replaceChildren(el("div", { className: "hint" }, a.error || "Couldn't look."));
      return;
    }
    browsing = a.path;
    const videos = a.files.filter((f) => f.video).length;
    const use = el("button", { textContent: `Use this folder (${kindNow() === "command" ? `${a.files.length} files` : `${videos} videos`})` });
    use.onclick = () => {
      pickedJobs.folder = browsing;
      box.hidden = true;
      showOptions();
    };
    const up = el("div", { className: "folder" }, "↑ " + a.parent);
    up.onclick = () => browse(a.parent);
    box.replaceChildren(el("div", { className: "hint" }, `${home.name}: ${a.path}`), use, up,
      ...a.folders.map((f) => {
        const d = el("div", { className: "folder" }, "📁 " + f);
        d.onclick = () => browse(a.path.replace(/\/$/, "") + "/" + f);
        return d;
      }));
  }

  // (names on the Pi that keeps the list are unique within a job)
  function uniqueName(name, taken) {
    let n = name, i = 2;
    const dot = name.lastIndexOf(".");
    while (taken.has(n)) n = dot > 0 ? `${name.slice(0, dot)} (${i++})${name.slice(dot)}` : `${name} (${i++})`;
    taken.add(n);
    return n;
  }

  async function startJob() {
    const home = homePi();
    if (!home) return say("No device keeps the job list yet.", true); // (one that's away: its own answer says so)
    const kind = kindNow();
    const params = {};
    if (kind === "animals") {
      const app = window.SentryModels.MODELS.finder;
      params.every = Math.min(60, Math.max(0.2, Number($("every").value) || 1));
      params.score = 0.25;
      params.animals = (window.Kinds && window.Kinds.animals) || [];
      if (pickedJobs.model) params.model = { upload: "model.onnx", name: pickedJobs.model.name };
      else Object.assign(params, { model: { url: app.url, sha256: app.sha256, name: app.name }, names: (window.Kinds && window.Kinds.names) || [] });
      params.modelName = pickedJobs.model ? pickedJobs.model.name : app.name;
    } else if (kind === "convert") {
      const id = $("format").value;
      const f = window.VideoFormats.FORMATS.find((x) => x.id === id);
      Object.assign(params, { format: id, label: f.label, ext: f.ext, suffix: f.suffix || "", args: window.VideoFormats.outputArgs(id, {}) });
    } else if (kind === "run") {
      const how = runHow();
      params.how = how === "each" ? "each" : "split";
      if (pickedJobs.script) params.script = { upload: pickedJobs.script.name };
      else if (!(params.command = $("runCommand").value.trim())) return say("Which command, or which script?", true);
      if (how === "each" && !(params.members = pickedJobs.members ? [...pickedJobs.members] : members().map((p) => p.name)).length) return say("On which members?", true);
      if (how === "lines" && !(params.lines = $("runLines").value.split(/\r?\n/).filter((l) => l.trim())).length) return say("Which lines?", true);
      if (how === "count") params.count = Math.min(10000, Math.max(1, Math.floor(Number($("runCount").value) || 1)));
      if ($("runRoot").checked) {
        params.root = true;
        if (!$("runPassword").value) return say("The cluster password, to run it as root?", true);
      }
    } else {
      params.command = $("command").value.trim();
      if (!params.command) return say("Which command?", true);
    }
    const byFiles = kind !== "run" || runHow() === "files";
    const taken = new Set();
    const uploads = byFiles ? pickedJobs.files.map((f) => ({ ...f, name: uniqueName(f.name, taken) })) : [];
    const files = byFiles ? [...[...pickedJobs.recordings.values()].map((r) => ({ name: r.name, size: r.size, node: r.node, path: r.path })), ...uploads.map((f) => ({ name: f.name, size: f.size, upload: true }))] : [];
    const count = files.length + (pickedJobs.folder ? 1 : 0);
    const what = kind === "run" ? (pickedJobs.script ? pickedJobs.script.name : params.command) : "";
    const title = $("jobTitle").value.trim() || (kind === "animals" ? `Animals in ${files.length || "a folder's"} clip${files.length === 1 ? "" : "s"}` : kind === "convert" ? `Videos to ${params.label}`
      : kind === "run" ? `Run: ${what.length > 48 ? what.slice(0, 47) + "…" : what}` : "A command for each file");
    const password = params.root ? $("runPassword").value : undefined;
    $("runPassword").value = "";
    const made = await api.action({ target: home.target, module: "jobs", action: "create", args: { kind, title, high: $("jobHigh").checked, params, files, folder: byFiles ? pickedJobs.folder : null, password } }).catch((e) => ({ error: e.message }));
    if (!made.ok) return say(made.error || "It wasn't made.", true);
    const sending = [...uploads.map((f) => ({ path: f.path, name: f.name })), ...(pickedJobs.model ? [{ path: pickedJobs.model.path, name: "model.onnx" }] : []),
      ...(kind === "run" && pickedJobs.script ? [{ path: pickedJobs.script.path, name: pickedJobs.script.name }] : [])];
    if (sending.length) {
      try {
        await api.upload({ target: home.target, job: made.job, files: sending });
      } catch (e) {
        return say(`Couldn't send the files to ${home.name}: ${e.message}`, true);
      }
      const started = await api.action({ target: home.target, module: "jobs", action: "start", args: { job: made.job } }).catch((e) => ({ error: e.message }));
      if (!started.ok) return say(started.error || "It didn't start.", true);
    }
    say(`Started ${title}${count ? "" : ""}.`);
    $("newJob").hidden = true;
    resetForm();
    setTimeout(refresh, 500);
  }

  // ---------- this phone's apps: a newer build from GitHub's "Latest build", as the Pis take theirs ----------
  // Android (the app's AppUpdates plugin: AppUpdatePlugin.java): this phone's Hand Tracker apps update
  // by themselves on Wi-Fi (an hourly look, as often as Android lets it: usually within a few hours), Cluster too, unless the phone is recording or saving a
  // take (AppUpdateJob.java); Update does it now, and Install puts on one that isn't here. Android asks
  // once before Cluster updates an app it didn't install itself; until then, those wait for Update.
  // The page looks when it opens and once a day while open, with a notice when there's a newer build.
  // iPhone: an app can't install apps there, so only the notice, for a build with Cluster's iPhone
  // app in it; installing stays with AltServer.
  const RELEASE = "https://api.github.com/repos/alexandermulholland92/hand-tracker/releases/tags/latest-build";
  function phoneApps() {
    const cap = window.Capacitor;
    const U = cap && cap.Plugins && cap.Plugins.AppUpdates;
    const ios = !U && !!cap && typeof cap.getPlatform === "function" && cap.getPlatform() === "ios";
    if (!U && !ios) return;
    const DAY = 86400000;
    const SELF = "com.handtracker.cluster";
    const st = { apps: [], latest: null, canInstall: true, error: "", busy: false, line: {}, looked: 0, recording: "", auto: "", silent: false };
    const mine = () => {
      // (this copy's own build, as a GitHub build's page says it: the iPhone's notice)
      const built = document.querySelector('meta[name="hand-tracker-build"]');
      return (built && built.dataset.commit) || "";
    };
    const day = (iso) => {
      const d = new Date(iso);
      return isNaN(d) ? "" : d.toLocaleDateString([], { month: "short", day: "numeric" });
    };
    const mb = (n) => (n / 1e6).toFixed(n < 1e7 ? 1 : 0);
    // (an app with no build stamp, from before apps had one, counts as newest once put on after the build came out)
    const newer = (a) => !!(a.installed && st.latest && st.latest.apps[a.pkg] && (a.commit ? a.commit !== st.latest.commit : !(a.updated >= Date.parse(st.latest.published))));
    const missing = (a) => !!(!a.installed && st.latest && st.latest.apps[a.pkg]);
    const names = (pkgs) => pkgs.map((p) => (st.apps.find((a) => a.pkg === p) || { name: p }).name).join(", ");
    const build = () => (st.latest ? `build ${short(st.latest.commit)}${st.latest.published ? `, ${day(st.latest.published)}` : ""}` : "");
    const remember = (k, v) => {
      try {
        if (v === undefined) return localStorage.getItem(k);
        localStorage.setItem(k, v);
      } catch {}
      return null;
    };

    async function look(github = true) {
      if (U) {
        try {
          const a = await U.apps();
          st.apps = a.apps || [];
          st.canInstall = a.canInstall !== false;
          st.recording = a.recording || "";
          st.auto = a.auto || "";
          st.silent = !!a.silent;
        } catch (e) {
          st.error = `Couldn't see this phone's apps: ${(e && e.message) || e}`;
        }
        if (github) {
          try {
            st.latest = await U.latest();
            st.looked = Date.now();
            st.error = "";
          } catch (e) {
            st.error = `Couldn't ask GitHub for the newest build: ${(e && e.message) || e}`;
          }
        }
        // (once: Android 13 and later ask whether Cluster may notify, for the daily look's notice)
        if (st.latest && !remember("clusterAskedNotices")) {
          remember("clusterAskedNotices", "1");
          U.notices().catch(() => {});
        }
      } else {
        try {
          const r = await fetch(RELEASE, { headers: { Accept: "application/vnd.github+json" } });
          if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
          const j = await r.json();
          const ipa = (j.assets || []).some((x) => /^(Pi)?Cluster-.*\.ipa$/.test(x.name || ""));
          st.latest = ipa && /^[0-9a-f]{40}$/.test(j.target_commitish || "") ? { commit: j.target_commitish, published: j.published_at, apps: {} } : null;
          st.looked = Date.now();
          st.error = "";
        } catch (e) {
          st.error = `Couldn't ask GitHub for the newest build: ${(e && e.message) || e}`;
        }
      }
      show();
    }

    async function update(pkgs) {
      if (st.busy || !pkgs.length) return;
      if (!st.canInstall) {
        say("Cluster needs Android's OK to install apps first: Allow, under This phone's apps.", true);
        $("phoneAppsBox").hidden = false;
        show();
        return;
      }
      const self = pkgs.includes(SELF);
      if (st.recording) {
        say(`${st.recording} is recording or saving a take: the apps update by themselves once it stops.`, true);
        return;
      }
      if (!confirm(`Update ${names(pkgs)} to ${build()}? Android may ask before each.${self ? " Cluster updates itself last and closes then: open it again afterwards." : ""}`)) return;
      st.busy = true;
      for (const p of pkgs) st.line[p] = { text: "Waiting its turn…" };
      show();
      const handle = await U.addListener("progress", (p) => {
        const text = p.stage === "download" ? `Downloading: ${mb(p.got)} of ${p.size > 0 ? mb(p.size) : "?"} MB`
          : p.stage === "install" ? "Installing… (Android may ask first)"
            : p.stage === "done" ? "Done ✓" : p.stage === "asks" ? "Android asks first: answer its notification" : p.error || "It didn't work.";
        st.line[p.pkg] = { text, bad: p.stage === "failed" };
        show();
      });
      try {
        const r = await U.install({ pkgs });
        const bad = r.failed || [];
        const good = r.done || [];
        say(bad.length ? bad.map((f) => `${names([f.pkg])}: ${f.error}`).join(" · ") : good.length ? `${names(good)}: updated to ${build()}.` : "Android asks first: answer its notification.", bad.length > 0);
      } catch (e) {
        say(`Updating didn't work: ${(e && e.message) || e}`, true);
      } finally {
        if (handle && handle.remove) handle.remove();
        st.busy = false;
        look(false);
      }
    }

    function show() {
      const notice = $("appNotice");
      const box = $("phoneAppsBox");
      if (ios) {
        const fresh = !!(st.latest && mine() && st.latest.commit !== mine() && remember("clusterSeenBuild") !== st.latest.commit);
        notice.hidden = !fresh;
        if (fresh) {
          const ok = el("button", { textContent: "OK" });
          ok.onclick = () => {
            remember("clusterSeenBuild", st.latest.commit);
            show();
          };
          notice.replaceChildren(el("div", {}, `A newer build of the apps is out (${build()}). Install it with AltServer, as before.`), el("div", { className: "buttons" }, ok));
        }
        return;
      }
      const older = st.apps.filter(newer);
      const absent = st.apps.filter(missing);
      $("phoneAppsBtn").hidden = false;
      $("phoneAppsBtn").textContent = older.length ? `This phone's apps (${older.length} newer)` : "This phone's apps";
      $("phoneAppsBtn").className = older.length ? "main" : "";
      notice.hidden = !older.length || !box.hidden;
      if (older.length) {
        const go = el("button", { className: "main", textContent: older.length === 1 ? "Update it" : "Update them", disabled: st.busy });
        go.onclick = () => update(older.map((a) => a.pkg));
        const see = el("button", { textContent: "See all" });
        see.onclick = () => {
          box.hidden = false;
          show();
        };
        const asking = older.filter((a) => !st.silent || !a.ours);
        const how = st.recording ? ` They wait while ${st.recording} is recording or saving a take.`
          : asking.length ? ` Android asks once before Cluster updates ${asking.map((a) => a.name).join(", ")}: tap Update.${asking.length < older.length ? " The others update by themselves on Wi-Fi." : ""}`
            : " They update by themselves on Wi-Fi, usually within a few hours, or now with Update.";
        notice.replaceChildren(el("div", {}, `Newer builds of this phone's apps are out (${build()}): ${older.map((a) => a.name).join(", ")}.${how}`), el("div", { className: "buttons" }, go, see));
      }
      if (box.hidden) return;
      const again = el("button", { textContent: "Look again", disabled: st.busy });
      again.onclick = () => look();
      const rows = st.apps.map((a) => {
        const here = !a.installed ? "not on this phone" : a.commit ? `this phone: build ${short(a.commit)}` : `this phone: an older build${a.updated ? ` (from ${day(a.updated)})` : ""}`;
        const line = st.line[a.pkg];
        let button = null;
        if (newer(a) || missing(a)) {
          button = el("button", { textContent: a.installed ? "Update" : "Install", disabled: st.busy });
          button.onclick = () => update([a.pkg]);
        }
        const state = a.installed && st.latest && !newer(a) && st.latest.apps[a.pkg] ? " · up to date"
          : newer(a) ? (st.silent && a.ours ? " · updates by itself" : " · Android asks once: Update") : "";
        return el("div", { className: "app-row" },
          el("div", { className: "what" }, el("b", {}, a.name), ` — ${here}${state}`, line ? el("div", { className: "line" + (line.bad ? " bad" : "") }, line.text) : null),
          button);
      });
      const all = el("button", { className: "main", textContent: `Update all (${older.length})`, disabled: st.busy || !older.length });
      all.onclick = () => update(older.map((a) => a.pkg));
      const allow = el("button", { textContent: "Allow" });
      allow.onclick = () => U.allowInstalls().catch((e) => say(`Couldn't open Android's settings: ${e.message || e}`, true));
      const close = el("button", { textContent: "Close" });
      close.onclick = () => {
        box.hidden = true;
        show();
      };
      box.replaceChildren(...[
        el("div", { className: "top" }, el("span", { className: "name" }, "This phone's apps"), el("span", { className: "sub" }, st.latest ? `Newest: ${build()}` : st.error ? "" : "Asking GitHub…"), again, close),
        st.error ? el("div", { className: "warn-line" }, "⚠ " + st.error) : null,
        st.canInstall ? null : el("div", { className: "warn-line" }, "Cluster needs Android's OK to install apps: ", allow),
        st.recording ? el("div", { className: "warn-line" }, `Waiting: ${st.recording} is recording or saving a take. The apps update once it stops.`) : null,
        ...rows,
        el("div", { className: "buttons" }, all),
        st.auto ? el("div", { className: "hint" }, `Last hourly look: ${st.auto}`) : null,
        el("div", { className: "hint" }, "The apps update by themselves on Wi-Fi, usually within a few hours of a new build (Android decides how often Cluster may look, by how much it's used), except while this phone records or saves a take. Android asks once before Cluster updates an app it didn't install itself, and before it installs one; after that, from Android 12, they update without asking. Cluster updates itself while it isn't open; with Update, it goes last and closes."),
      ].filter(Boolean));
    }

    if (U) {
      $("phoneAppsBtn").hidden = false;
      $("phoneAppsBtn").onclick = () => {
        $("phoneAppsBox").hidden = !$("phoneAppsBox").hidden;
        show();
        if (!$("phoneAppsBox").hidden && !st.busy) look(Date.now() - st.looked > 60000);
      };
    }
    // (back from Android's settings or its question: the apps again; GitHub again after a day)
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !st.busy) look(Date.now() - st.looked > DAY);
    });
    setInterval(() => {
      if (!document.hidden && !st.busy && Date.now() - st.looked > DAY) look();
    }, 3600000);
    look();
  }

  if (api && api.onProgress) {
    api.onProgress((p) => {
      if (p.zip) say(`Saving ${p.name}: ${Math.round((100 * p.got) / Math.max(1, p.size))}%`);
      else if (p.sent !== undefined) say(`Sending ${p.name}: ${Math.round((100 * p.sent) / Math.max(1, p.size))}%`);
      else if (p.files !== undefined) say(`Saving results: ${p.got} of ${p.files}`);
    });
  }
  if (window.VideoFormats) {
    $("format").replaceChildren(...window.VideoFormats.FORMATS.map((f) => el("option", { value: f.id, textContent: `${f.label} (${f.detail})` })));
  }
  for (const r of document.querySelectorAll('input[name="kind"]')) r.onchange = showOptions;
  $("newJobBtn").onclick = () => {
    $("newJob").hidden = !$("newJob").hidden;
    showOptions();
  };
  $("cancelJob").onclick = () => {
    $("newJob").hidden = true;
    resetForm();
  };
  $("showRecordings").onclick = showRecordings;
  $("browseHome").onclick = () => browse(browsing || "");
  $("pickFiles").onclick = async () => {
    const got = await api.pickFiles();
    for (const f of got || []) if (!pickedJobs.files.some((x) => x.path === f.path)) pickedJobs.files.push(f);
    showOptions();
  };
  $("pickModel").onclick = async () => {
    const got = await api.pickModel();
    if (got && got[0]) pickedJobs.model = got[0];
    showOptions();
  };
  $("appModel").onclick = () => {
    pickedJobs.model = null;
    showOptions();
  };
  $("startJob").onclick = startJob;

  $("tabPis").onclick = () => showTab("pis");
  $("tabRigs").onclick = () => showTab("rigs");
  $("tabJobs").onclick = () => showTab("jobs");
  $("tabTransmission").onclick = () => {
    showTab("transmission");
    loadTorrents(true);
  };
  $("addPi").onclick = () => $("addDialog").showModal();
  $("closeAdd").onclick = () => $("addDialog").close();
  $("copyCmd").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("setupCmd").textContent.trim());
      $("copied").hidden = false;
      setTimeout(() => ($("copied").hidden = true), 3000);
    } catch {
      say("Couldn't copy: select the line and copy it instead.", true);
    }
  };
  $("updateAll").onclick = async () => {
    const live = ((data && data.nodes) || []).filter((p) => p.answering && mod(p.node, "updates") && mod(p.node, "updates").on);
    if (!live.length || !confirm(`Update Hand Tracker on ${live.map((p) => p.name).join(", ")}? Each restarts Hand Tracker when it's done; a device that's recording waits until it stops.`)) return;
    const answers = await Promise.all(live.map((p) => api.action({ target: p.target, module: "updates", action: "updateHandTracker", args: {} }).catch((e) => ({ error: e.message }))));
    const bad = answers.map((a, i) => (a.error ? `${live[i].name}: ${a.error}` : null)).filter(Boolean);
    say(bad.length ? bad.join(" · ") : `Asked ${live.length} device${live.length === 1 ? "" : "s"} to update Hand Tracker.`, bad.length > 0);
    setTimeout(refresh, 600);
  };

  if (window.desktop && window.desktop.getInfo) window.desktop.getInfo().then((i) => i && i.version && ($("buildInfo").textContent = `v${i.version}`), () => {});
  if (!api) {
    $("note").textContent = "Cluster runs in its own app (Cluster), or in a browser on your Tailscale, served by any device of the cluster: http://pi:47830/.";
    return;
  }
  // In a browser: which Pi served the page (the others are asked through it).
  if (api.browser) {
    $("buildInfo").textContent = `through ${api.served}`;
    $("pickFiles").textContent = "Files from this device…";
  }
  // On a phone: a Pi set up already, by its Tailscale name (Add a Pi); this phone's apps.
  if (api.phone) {
    phoneApps();
    $("pickFiles").textContent = "Files from this phone…";
    $("phoneAdd").hidden = false;
    $("findPi").onclick = async () => {
      $("findPiNote").textContent = "Looking…";
      const a = await api.addPi($("piName").value);
      $("findPiNote").textContent = a.ok ? `Found ${a.name}.` : a.error;
      if (a.ok) refresh();
    };
  }
  // The iPhone build's simulator check (-HTSelfTest): a simulated Pi on the build computer, reached
  // through the app's own Cluster plugin (a reading, then a change).
  if (window.__htSelfTest && api.phone) {
    (async () => {
      const target = "127.0.0.1:47830";
      const found = await api.addPi(target);
      const set = found.ok ? await api.settings({ target, module: "health", key: "power", value: "wall" }) : {};
      const out = { ok: !!(found.ok && set.status === 200 && set.ok), found, set: set.status };
      // This iPhone in the cluster, where the app has its own Python (the Cluster app's member service,
      // ClusterMember.swift): started beside the simulated Pi, which it gives its key; then asked through that Pi,
      // as the Pis' page asks a phone: an iPhone, with its own readings; then stopped.
      const has = Member ? await Member.status().catch(() => ({})) : {};
      if (has.available) {
        out.member = await memberSelfTest(target);
        out.ok = out.ok && out.member.ok;
        // its ffmpeg, as a job's conversions use it, where the app has one (ClusterFFmpeg.framework)
        const ff = await Member.selfTestFfmpeg().catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        if (ff.available !== false) {
          out.ffmpeg = ff;
          out.ok = out.ok && !!ff.ok;
        }
        // the animal model's tools, as its jobs use them, where the app has them (ClusterORT.framework, NumPy, Pillow)
        const an = await Member.selfTestAnimals().catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        if (an.available !== false) {
          out.animals = an;
          out.ok = out.ok && !!an.ok;
        }
        // its own Transmission, as the cluster's downloads use it, where the app has one (ClusterTransmission.framework)
        const dl = await Member.selfTestDownloads().catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        if (dl.available !== false) {
          out.downloads = dl;
          out.ok = out.ok && !!dl.ok;
        }
        // its FTP link to a Pi's shared folders (ClusterFtp.swift), where the simulated Pi has its FTP server
        const ftp = Ftp ? await ftpSelfTest(target) : { available: false };
        if (ftp.available !== false) {
          out.ftp = ftp;
          out.ok = out.ok && !!ftp.ok;
        }
      }
      console.log("HT-SELFTEST " + JSON.stringify(out));
    })();
  }
  // The simulated Pi's shared folder over its FTP link, as this iPhone (its name and key, which the member gave the Pi):
  // listed, a folder made, hello.txt fetched, and sent back as sent-from-iphone.txt (the build checks what came).
  async function ftpSelfTest(pi) {
    const r = { ok: false };
    try {
      const a = await window.Capacitor.Plugins.Cluster.request({ target: pi, method: "GET", path: "/api/node", timeoutMs: 8000 });
      const node = a.status === 200 ? JSON.parse(a.body) : {};
      const m = (node.modules || []).find((x) => x.name === "ftp");
      if (!(m && m.status && m.status.ready)) return { available: false };
      const host = "127.0.0.1";
      const top = await Ftp.list({ host, path: "/" });
      const shared = (top.entries || []).find((e) => e.dir);
      r.top = (top.entries || []).map((e) => e.name);
      if (!shared) return r;
      const dir = `/${shared.name}`;
      const inside = await Ftp.list({ host, path: dir });
      const hello = (inside.entries || []).find((e) => e.name === "hello.txt" && !e.dir);
      r.hello = hello || null;
      await Ftp.mkdir({ host, path: `${dir}/made-on-iphone` });
      const got = await Ftp.download({ host, path: `${dir}/hello.txt`, name: "hello.txt", size: hello ? hello.size : -1 });
      const sent = await Ftp.upload({ host, dir, testFile: got.file, testAs: "sent-from-iphone.txt" });
      const after = (await Ftp.list({ host, path: dir })).entries || [];
      r.got = got;
      r.sent = sent;
      r.after = after.map((e) => e.name);
      r.ok = !!(hello && got.size === hello.size && sent.size === hello.size && after.some((e) => e.name === "made-on-iphone" && e.dir) &&
        after.some((e) => e.name === "sent-from-iphone.txt" && e.size === hello.size));
    } catch (e) {
      r.error = String((e && e.message) || e);
    }
    return r;
  }
  async function memberSelfTest(pi) {
    const me = "127.0.0.1:47831";
    const P = window.Capacitor.Plugins.Cluster;
    const r = { ok: false };
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    try {
      r.start = await Member.start({ seeds: [pi], selfTest: { port: 47831 } });
      let node = null;
      for (const until = Date.now() + 120000; Date.now() < until && !node; ) {
        await wait(3000);
        r.status = await Member.status();
        if (r.status.error && !r.status.running) break;
        try {
          const a = await P.request({ target: pi, to: me, method: "GET", path: "/api/node", timeoutMs: 8000 });
          r.asked = a.status;
          if (a.status === 200) node = JSON.parse(a.body);
        } catch (e) {
          r.asked = String((e && e.message) || e);
        }
      }
      const health = node && (node.modules || []).find((m) => m.name === "health");
      const summary = (health && health.status && health.status.summary) || "";
      r.node = node && { name: node.name, platform: node.platform, version: node.version, modules: (node.modules || []).map((m) => m.name), health: summary };
      r.ok = !!(node && node.platform === "ios" && /Memory/.test(summary));
      r.stop = await Member.stop();
      for (let i = 0; i < 10 && (await Member.status()).running; i++) await wait(1000);
      r.stopped = !(await Member.status()).running;
      r.ok = r.ok && r.stopped;
    } catch (e) {
      r.error = String((e && e.message) || e);
    }
    return r;
  }
  refresh();
  memberStatus();
  setInterval(() => {
    if (!document.hidden) memberStatus();
  }, 5000);
  setInterval(() => {
    if (!document.hidden) refresh();
  }, REFRESH_MS);
})();
