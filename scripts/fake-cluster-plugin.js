/**
 * fake-cluster-plugin.js — preload for check-cluster.js's phone part: stands in for Cluster's
 * phone apps' Cluster plugin (ClusterPlugin.java, RemoteLink.swift's ClusterPlugin) so cluster.js
 * runs its phone way in desktop Chromium: request() and save() as the plugin does them (plain HTTP
 * with the service's header; a file saved a piece at a time), saves into FAKE_CLUSTER_DOWNLOADS,
 * and Tailscale's names here: FAKE_CLUSTER_NAMES={"pi":"127.0.0.1:47901"}. A file box's click()
 * gives it FAKE_CLUSTER_PICK (a file's path) as if picked on the phone. With FAKE_APPS, also the
 * Android app's AppUpdates plugin (this phone's apps; below); FAKE_PLATFORM=ios, the iPhone app.
 */
const fs = require("fs");
const http = require("http");
const path = require("path");

const names = JSON.parse(process.env.FAKE_CLUSTER_NAMES || "{}");
const downloads = process.env.FAKE_CLUSTER_DOWNLOADS || "";
const listeners = new Set();
window.__clusterCalls = [];

function ask({ target, method = "GET", path: p, body, data, timeoutMs = 20000 }) {
  window.__clusterCalls.push([method, target, p]);
  const where = names[target] || target;
  const [host, port] = where.includes(":") ? [where.split(":")[0], Number(where.split(":")[1])] : [where, 47830];
  if (!/^\/api\/[A-Za-z0-9/_.-]{1,80}(\?[A-Za-z0-9%._~!*'()=&+-]{0,4000})?$/.test(p || "")) return Promise.reject(new Error("Not one of the service's requests."));
  const payload = data ? Buffer.from(data, "base64") : body !== undefined ? Buffer.from(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host, port, path: p, method, timeout: timeoutMs,
      headers: { "X-HT-Cluster": "1", Host: `${host}:${port}`, ...(payload ? { "Content-Type": data ? "application/octet-stream" : "application/json", "Content-Length": payload.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const all = Buffer.concat(chunks);
        const type = String(res.headers["content-type"] || "");
        resolve(type.startsWith("application/json") ? { status: res.statusCode, type, body: all.toString("utf8") } : { status: res.statusCode, type, data: all.toString("base64") });
      });
    });
    req.on("timeout", () => req.destroy(new Error("No answer")));
    req.on("error", (e) => reject(new Error(e.code === "ECONNREFUSED" ? "Can't reach it." : e.message)));
    if (payload) req.write(payload);
    req.end();
  });
}

const platform = process.env.FAKE_PLATFORM || "android";
window.Capacitor = {
  isNativePlatform: () => true,
  getPlatform: () => platform,
  Plugins: {
    Cluster: {
      request: ask,
      async save({ target, path: p, name, size }) {
        const out = path.join(downloads, name);
        let got = 0;
        const parts = [];
        for (;;) {
          const a = await ask({ target, method: "GET", path: `${p}${p.includes("?") ? "&" : "?"}at=${got}`, timeoutMs: 120000 });
          if (a.status !== 200 || !a.data) throw new Error(`The Pi answered ${a.status}.`);
          const b = Buffer.from(a.data, "base64");
          parts.push(b);
          got += b.length;
          listeners.forEach((cb) => cb({ name, got, size }));
          if (!b.length || got >= size) break;
        }
        fs.writeFileSync(out, Buffer.concat(parts));
        return { saved: "Downloads/" + name };
      },
      async addListener(event, cb) {
        if (event === "progress") listeners.add(cb);
        return { remove: () => listeners.delete(cb) };
      },
    },
  },
};

// Cluster's AppUpdates plugin (AppUpdatePlugin.java) on Android, when FAKE_APPS is set: this phone's
// apps (FAKE_APPS: [{ pkg, name, installed, commit, updated, ours }], kept here: an install gives an app
// the newest build), GitHub's newest build (FAKE_LATEST), and installs in AppUpdates.APPS' order
// (Cluster last), with its "progress" as they go; recorded in window.__appInstalls, and the notifications
// asked for in window.__notices. window.__appRecording: an app recording now (it refuses then, as the
// plugin does); window.__appAuto: what the hourly look did last. FAKE_PLATFORM=ios: Cluster's iPhone
// app instead (no AppUpdates there).
if (process.env.FAKE_APPS && platform === "android") {
  const ORDER = ["com.handtracker.app", "com.handtracker.mouse", "com.handtracker.remote", "com.handtracker.converter", "com.handtracker.cluster"];
  const apps = JSON.parse(process.env.FAKE_APPS);
  const latest = JSON.parse(process.env.FAKE_LATEST || "null");
  const appListeners = new Set();
  const tellApps = (p) => appListeners.forEach((cb) => cb(p));
  window.__appInstalls = [];
  window.__notices = 0;
  window.Capacitor.Plugins.AppUpdates = {
    async apps() {
      return { apps: apps.map((a) => ({ ...a })), canInstall: true, recording: window.__appRecording || null, auto: window.__appAuto || "", silent: true };
    },
    async latest() {
      if (!latest) throw new Error("GitHub didn't answer.");
      return latest;
    },
    async install({ pkgs, force }) {
      if (window.__appRecording && !force) throw new Error(`${window.__appRecording} is recording or saving a take: the apps update by themselves once it stops.`);
      const list = ORDER.filter((p) => pkgs.includes(p));
      window.__appInstalls.push(list);
      const done = [];
      for (const pkg of list) {
        const size = latest.apps[pkg].size;
        tellApps({ pkg, stage: "download", got: Math.round(size / 2), size });
        await new Promise((r) => setTimeout(r, 50));
        tellApps({ pkg, stage: "install", got: size, size });
        Object.assign(apps.find((a) => a.pkg === pkg), { installed: true, commit: latest.commit, updated: Date.now() });
        done.push(pkg);
        tellApps({ pkg, stage: "done", got: 0, size: 0 });
      }
      return { done, failed: [] };
    },
    async allowInstalls() {},
    async notices() {
      window.__notices++;
      return { granted: true };
    },
    async addListener(event, cb) {
      if (event === "progress") appListeners.add(cb);
      return { remove: () => appListeners.delete(cb) };
    },
  };
}

// This copy's build, as a GitHub build's page says it (build-web.js's meta), when FAKE_BUILD_COMMIT is set.
if (process.env.FAKE_BUILD_COMMIT) {
  const add = () => {
    if (!document.head) return false;
    const m = document.createElement("meta");
    m.name = "hand-tracker-build";
    m.dataset.commit = process.env.FAKE_BUILD_COMMIT;
    document.head.prepend(m);
    return true;
  };
  if (!add()) {
    const watch = new MutationObserver(() => add() && watch.disconnect());
    watch.observe(document, { childList: true, subtree: true });
  }
}

// A file box opened by the page: "picked" at once, as the phone's chooser would.
const click = HTMLInputElement.prototype.click;
HTMLInputElement.prototype.click = function () {
  if (this.type !== "file" || !process.env.FAKE_CLUSTER_PICK) return click.call(this);
  const file = process.env.FAKE_CLUSTER_PICK;
  const dt = new DataTransfer();
  dt.items.add(new File([fs.readFileSync(file)], path.basename(file)));
  this.files = dt.files;
  setTimeout(() => this.dispatchEvent(new Event("change")), 10);
};
