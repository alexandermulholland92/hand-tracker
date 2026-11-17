/**
 * busy.js — how busy this computer's processor (CPU) and graphics chip (GPU) are, and this app's
 * share of each (remote-record-ui.js shows them on the Space line with memory, here and on the
 * remote recording page; 2026-11-15: numbers only, no red and no notifications).
 *
 *   await busy(pids) -> { cpu, appCpu, gpu, appGpu, net }: percentages (0-100) since the last call,
 *     each null where it can't be told. pids: this app's processes (app.getAppMetrics()), with
 *     cpuOf: { pid: percent of one core } from the same metrics, for the app's share of the CPU.
 *     net (2026-11-16): each network adapter's traffic, [{ name, down, up }] in bytes a second
 *     (received, sent), or null where it can't be told.
 *
 * CPU: every computer (os.cpus()'s times). GPU: a Raspberry Pi (its v3d chip's gpu_stats, and each
 * of the app's processes' DRM fdinfo for its share), Windows (the GPU Engine counters, as Task
 * Manager: the busiest engine, every process's use of it added up), not a Mac or another Linux
 * GPU yet. Network: Linux (a Raspberry Pi: /proc/net/dev, every adapter but the loopback) and
 * Windows (Get-NetAdapterStatistics, the adapters that are up, asked with the GPU's counters every
 * 5 s), not a Mac yet. The first call measures over half a second; later ones over the time since the last.
 */

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");

const clamp = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);
const nowNs = () => process.hrtime.bigint();

// ---- CPU: the whole computer's, from every core's times
function cpuTimes() {
  let idle = 0, all = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    all += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, all };
}
let lastCpu = null;
function cpuNow() {
  const t = cpuTimes();
  const was = lastCpu;
  lastCpu = t;
  if (!was || t.all <= was.all) return null;
  return clamp((1 - (t.idle - was.idle) / (t.all - was.all)) * 100);
}

// ---- GPU on a Raspberry Pi (v3d): gpu_stats says each queue's runtime (ns) at a timestamp (ns);
// the busiest queue's share of the time is the chip's use. A process's own use: its DRM file
// descriptors' fdinfo ("drm-engine-render: 123 ns"), which only its own user can read.
const V3D_DIRS = ["/sys/devices/platform/axi/1002000000.v3d", "/sys/class/drm/card1/device", "/sys/class/drm/card0/device"];
let v3dFile;
function v3dStats() {
  if (v3dFile === undefined) v3dFile = V3D_DIRS.map((d) => d + "/gpu_stats").find((f) => fs.existsSync(f)) || null;
  if (!v3dFile) return null;
  const out = {};
  for (const line of fs.readFileSync(v3dFile, "utf8").split("\n").slice(1)) {
    const [queue, ts, , runtime] = line.trim().split(/\s+/);
    if (queue && runtime) out[queue] = { ts: Number(ts), runtime: Number(runtime) };
  }
  return Object.keys(out).length ? out : null;
}
function drmEngines(pids) {
  const out = {};
  for (const pid of pids) {
    let fds = [];
    try {
      fds = fs.readdirSync(`/proc/${pid}/fdinfo`);
    } catch {
      continue;
    }
    const seen = new Set();
    for (const fd of fds) {
      let text = "";
      try {
        text = fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8");
      } catch {
        continue;
      }
      if (!/^drm-driver:/m.test(text)) continue;
      const client = (text.match(/^drm-client-id:\s*(\d+)/m) || [])[1];
      if (client && seen.has(client)) continue; // (one client can be open on several fds)
      if (client) seen.add(client);
      for (const [, engine, ns] of text.matchAll(/^drm-engine-([\w-]+):\s*(\d+)\s*ns/gm)) out[engine] = (out[engine] || 0) + Number(ns);
    }
  }
  return out;
}
let lastPi = null;
function piGpu(pids) {
  const stats = v3dStats();
  if (!stats) return null;
  const now = { stats, engines: drmEngines(pids), at: nowNs() };
  const was = lastPi;
  lastPi = now;
  if (!was) return undefined; // (measured from the next call)
  let gpu = null;
  for (const [q, s] of Object.entries(stats)) {
    const w = was.stats[q];
    if (w && s.ts > w.ts) gpu = Math.max(gpu || 0, ((s.runtime - w.runtime) / (s.ts - w.ts)) * 100);
  }
  const wall = Number(now.at - was.at);
  let appGpu = null;
  if (wall > 0 && Object.keys(now.engines).length) {
    appGpu = 0;
    for (const [e, ns] of Object.entries(now.engines)) appGpu = Math.max(appGpu, ((ns - (was.engines[e] || ns)) / wall) * 100);
  }
  return { gpu: clamp(gpu), appGpu: clamp(appGpu) };
}

// ---- GPU on Windows: the GPU Engine counters (one per process and engine:
// "pid_1234_luid_0x0_0x1_phys_0_eng_0_engtype_3D"); each engine's use added up over processes,
// the busiest engine's the GPU's (as Task Manager). Asked in the background (PowerShell takes a
// second or so); the answer before is given meanwhile, at most WIN_MS old.
const WIN_MS = 60000;
const WIN_EVERY_MS = 5000; // (asked at most this often: each ask starts PowerShell, a second of a core or so)
let winGpu = { at: 0, value: null, asking: null, none: false };
const COUNTER = "(Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples | ForEach-Object { $_.InstanceName + ' ' + $_.CookedValue }; " +
  // (and each adapter that's up: its bytes received and sent so far, for the network's traffic, 2026-11-16)
  "Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up' | Get-NetAdapterStatistics -ErrorAction SilentlyContinue | ForEach-Object { 'NET|' + $_.Name + '|' + $_.ReceivedBytes + '|' + $_.SentBytes }";
function askWindowsGpu() {
  return new Promise((resolve) =>
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", COUNTER], { timeout: 15000, windowsHide: true }, (err, out) => resolve(err ? "" : String(out || ""))),
  );
}
function windowsGpuOf(text, pids) {
  const mine = new Set(pids.map(Number)), all = {}, app = {};
  let any = false;
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^pid_(\d+)_(luid_\w+?_phys_\d+_eng_\d+)\w*\s+([\d.]+)$/i);
    if (!m) continue;
    any = true;
    const [, pid, engine, v] = m;
    all[engine] = (all[engine] || 0) + Number(v);
    if (mine.has(Number(pid))) app[engine] = (app[engine] || 0) + Number(v);
  }
  if (!any) return null;
  return { gpu: clamp(Math.max(0, ...Object.values(all))), appGpu: clamp(Math.max(0, ...Object.values(app))) };
}
function windowsGpu(pids) {
  if (winGpu.none) return null;
  if (!winGpu.asking && Date.now() - winGpu.at >= WIN_EVERY_MS) {
    winGpu.asking = askWindowsGpu().then((text) => {
      const value = windowsGpuOf(text, pids);
      const counters = netCountersOf(text);
      winNet = counters ? netRates(counters, Date.now()) : null;
      winGpu = { at: Date.now(), value, asking: null, none: !value && !counters && !winGpu.value && !text.trim() };
      return value;
    });
  }
  return Date.now() - winGpu.at < WIN_MS ? winGpu.value : undefined;
}

// ---- Network: each adapter's bytes received and sent so far, and from two of those, a second's.
// "NET|Wi-Fi|123|456" lines (Windows' ask above), or /proc/net/dev (Linux).
function netCountersOf(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^NET\|(.{1,60})\|(\d+)\|(\d+)$/);
    if (m) out[m[1]] = { rx: Number(m[2]), tx: Number(m[3]) };
  }
  return Object.keys(out).length ? out : null;
}
// A Linux adapter's name as people know it: wlan0 -> Wi-Fi, eth0 -> Ethernet, tailscale0 -> Tailscale.
function friendlyName(dev) {
  if (/^(wlan|wlp|wl)/.test(dev)) return "Wi-Fi";
  if (/^(eth|enp|eno|ens|end)/.test(dev)) return "Ethernet";
  if (/^tailscale/.test(dev)) return "Tailscale";
  if (/^usb/.test(dev)) return "USB";
  return dev;
}
function linuxNetCounters(text) {
  const out = {}, raw = [];
  for (const line of text.split("\n").slice(2)) {
    const m = line.match(/^\s*([^:\s]+):\s*(\d+)(?:\s+\d+){7}\s+(\d+)/);
    if (!m || m[1] === "lo") continue;
    raw.push([m[1], Number(m[2]), Number(m[3])]);
  }
  // (two adapters of one kind, wlan0 and wlan1: each with its own name after)
  const count = {};
  for (const [dev] of raw) count[friendlyName(dev)] = (count[friendlyName(dev)] || 0) + 1;
  for (const [dev, rx, tx] of raw) out[count[friendlyName(dev)] > 1 ? `${friendlyName(dev)} (${dev})` : friendlyName(dev)] = { rx, tx };
  return Object.keys(out).length ? out : null;
}
let lastNetCounters = null;
// [{ name, down, up }] bytes a second since the counters before (an adapter new since then, or whose
// counters went back, as after a restart of it, is left out until the next).
function netRates(counters, at) {
  const was = lastNetCounters;
  lastNetCounters = { counters, at };
  if (!was || at <= was.at) return null;
  const s = (at - was.at) / 1000, out = [];
  for (const [name, c] of Object.entries(counters)) {
    const w = was.counters[name];
    if (!w || c.rx < w.rx || c.tx < w.tx) continue;
    out.push({ name, down: Math.round((c.rx - w.rx) / s), up: Math.round((c.tx - w.tx) / s) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
let winNet = null;
function netNow() {
  if (process.platform === "win32") return Date.now() - winGpu.at >= WIN_MS ? null : winNet;
  if (process.platform !== "linux") return null;
  let text = "";
  try {
    text = fs.readFileSync("/proc/net/dev", "utf8");
  } catch {
    return null;
  }
  const counters = linuxNetCounters(text);
  return counters ? netRates(counters, Date.now()) : null;
}

let first = true;
async function busy(pids = [], cpuOf = {}) {
  let gpu = null;
  try {
    if (first) {
      // (a first measure over half a second, so the line isn't empty for the room's first look)
      first = false;
      cpuNow();
      netNow();
      if (process.platform === "linux") piGpu(pids);
      if (process.platform === "win32") windowsGpu(pids);
      await new Promise((r) => setTimeout(r, 500));
      if (process.platform === "win32") await Promise.race([winGpu.asking, new Promise((r) => setTimeout(r, 4000))]);
    }
    if (process.platform === "linux") gpu = piGpu(pids);
    else if (process.platform === "win32") gpu = windowsGpu(pids);
  } catch {
    gpu = null;
  }
  let net = null;
  try {
    net = netNow();
  } catch {
    net = null;
  }
  const cores = os.cpus().length || 1;
  const own = Object.values(cpuOf).filter(Number.isFinite);
  return {
    cpu: cpuNow(),
    appCpu: own.length ? clamp(own.reduce((a, b) => a + b, 0) / cores) : null,
    gpu: gpu ? gpu.gpu : null,
    appGpu: gpu ? gpu.appGpu : null,
    net,
  };
}

module.exports = { busy, windowsGpuOf, netCountersOf, linuxNetCounters, netRates, _reset: () => ((lastCpu = null), (lastPi = null), (first = true), (v3dFile = undefined), (lastNetCounters = null), (winNet = null)) };
