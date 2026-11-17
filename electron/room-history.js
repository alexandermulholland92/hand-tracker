/**
 * room-history.js — this computer's readings for the graphs on remote recording's device settings
 * page (2026-11-15): CPU and GPU use (all of it and this app's), memory used (all of it and this
 * app's), the space used where takes are saved, and (2026-11-16) each network adapter's traffic,
 * received and sent in bytes a second. One reading a second: the last hour of them
 * kept as they are (in memory only), and a week of minutes (each minute's average) kept in a file.
 *
 *   const h = new RoomHistory({ file, sample: async () => ({ cpu, appCpu, gpu, appGpu, mem, appMem, disk, net }) });
 *     (each a percentage 0-100, or null where it can't be told; net: [{ name, down, up }] bytes a second, or null)
 *   h.start(); h.stop();
 *   h.get("1h" | "24h" | "7d", since?) -> { span, every (s), points: [[t (ms), cpu, appCpu, gpu, appGpu, mem, appMem, disk, net], …] }
 *     (net: { adapter's name: [down, up] } bytes a second, or null; a minute kept before 2026-11-16 has none)
 *     1h: every second's reading (since: only those after that time, ms, for a page that has the
 *     rest); 24h and 7d: the minutes, averaged over equal stretches (at most MAX_POINTS of them)
 *
 * Small on memory and on the drive (a Raspberry Pi with 4 GB, its drive busy with footage): an
 * hour of seconds is 3,600 short arrays and a week of minutes 10,080 (a few MB at most); the file
 * gets one line a minute (about 60 bytes: under 1 MB for a week) and is written over, without
 * what's more than a week old, once it has a day too many.
 */

const fs = require("fs");
const { leftOut } = require("./busy"); // (the network adapters left out of the graphs)

const EVERY_MS = 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 3600 * 1000;
const KEEP_MS = 7 * 24 * 3600 * 1000;
const MAX_POINTS = 360;
const SPANS = { "1h": HOUR_MS, "24h": 24 * HOUR_MS, "7d": KEEP_MS };
const FIELDS = 7; // cpu, appCpu, gpu, appGpu, mem, appMem, disk
const NET = FIELDS + 1; // then the network's: { name: [down, up] } bytes a second, or null
const MAX_ADAPTERS = 8;

const pct = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);
const rate = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
// [{ name, down, up }] -> { name: [down, up] } (or null: none told)
function netOf(list) {
  if (!Array.isArray(list)) return null;
  const out = {};
  for (const a of list.slice(0, MAX_ADAPTERS)) {
    const name = a && typeof a.name === "string" ? a.name.slice(0, 40) : "";
    if (name && !leftOut(name) && rate(a.down) !== null && rate(a.up) !== null) out[name] = [rate(a.down), rate(a.up)];
  }
  return Object.keys(out).length ? out : null;
}
// A kept point without the adapters left out (busy.js's leftOut: minutes kept before they were).
function withoutLeftOut(p) {
  const net = p[NET];
  if (!net || typeof net !== "object") return p;
  const kept = Object.fromEntries(Object.entries(net).filter(([name]) => !leftOut(name)));
  return [...p.slice(0, NET), Object.keys(kept).length ? kept : null];
}
// The average of each field over some readings ([t, …fields, net]), a field none had left null; each
// adapter's over the readings that have it.
function average(t, ps) {
  const out = [t];
  for (let f = 1; f <= FIELDS; f++) {
    const vs = ps.map((p) => p[f]).filter((v) => v !== null);
    out.push(vs.length ? Math.round(vs.reduce((a, b) => a + b, 0) / vs.length) : null);
  }
  const sums = {};
  for (const p of ps) {
    for (const [name, [down, up]] of Object.entries(p[NET] || {})) {
      const s = (sums[name] = sums[name] || [0, 0, 0]);
      s[0] += down;
      s[1] += up;
      s[2]++;
    }
  }
  const names = Object.keys(sums);
  out.push(names.length ? Object.fromEntries(names.map((n) => [n, [Math.round(sums[n][0] / sums[n][2]), Math.round(sums[n][1] / sums[n][2])]])) : null);
  return out;
}

class RoomHistory {
  constructor({ file, sample, now = () => Date.now() }) {
    this.file = file;
    this.sample = sample;
    this.now = now;
    this.points = []; // a week of minutes
    this.seconds = []; // the last hour of seconds
    this.minute = null; // the minute being gathered (its start, ms)
    this.timer = null;
    this.busy = false;
    this.fileLines = 0; // lines in the file (a week's, and older ones not yet written over)
    this.load();
  }
  load() {
    let text = "";
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    const since = this.now() - KEEP_MS;
    for (const line of text.split("\n")) {
      if (line) this.fileLines++;
      try {
        const p = JSON.parse(line);
        // (a minute from before the network's: no traffic told)
        if (Array.isArray(p) && p.length === FIELDS + 1 && p[0] >= since) this.points.push([...p, null]);
        else if (Array.isArray(p) && p.length === FIELDS + 2 && p[0] >= since) this.points.push(withoutLeftOut(p));
      } catch {
        // (a line cut short by a crash)
      }
    }
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.busy) return; // (a slow reading: the next second's is skipped, not stacked up)
      this.busy = true;
      this.take()
        .catch(() => {})
        .finally(() => (this.busy = false));
    }, EVERY_MS);
    if (this.timer.unref) this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
  async take() {
    const s = (await this.sample()) || {};
    const now = this.now();
    const p = [now, pct(s.cpu), pct(s.appCpu), pct(s.gpu), pct(s.appGpu), pct(s.mem), pct(s.appMem), pct(s.disk), netOf(s.net)];
    if (p.slice(1).every((v) => v === null)) return;
    // A minute that has ended becomes one of the week's points (its average), kept in the file.
    const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    if (this.minute !== null && minute !== this.minute) {
      const done = this.seconds.filter((q) => q[0] >= this.minute && q[0] < this.minute + MINUTE_MS);
      if (done.length) this.keepMinute(average(this.minute + MINUTE_MS / 2, done));
    }
    this.minute = minute;
    this.seconds.push(p);
    const hourAgo = now - HOUR_MS;
    const old = this.seconds.findIndex((q) => q[0] >= hourAgo);
    if (old > 0) this.seconds.splice(0, old);
  }
  keepMinute(p) {
    this.points.push(p);
    const since = this.now() - KEEP_MS;
    const old = this.points.findIndex((q) => q[0] >= since);
    if (old > 0) this.points.splice(0, old);
    try {
      if (this.fileLines + 1 > this.points.length + 24 * 60) {
        fs.writeFileSync(this.file, this.points.map((q) => JSON.stringify(q)).join("\n") + "\n");
        this.fileLines = this.points.length;
      } else {
        fs.appendFileSync(this.file, JSON.stringify(p) + "\n");
        this.fileLines++;
      }
    } catch {
      // (kept in memory meanwhile)
    }
  }
  get(span, after = 0) {
    if (!(span in SPANS)) span = "1h";
    const ms = SPANS[span];
    const since = this.now() - ms;
    if (span === "1h") {
      // Every second (the minutes before the app's last start, from the file, where there are no seconds).
      const first = this.seconds.length ? this.seconds[0][0] : Infinity;
      const minutes = after ? [] : this.points.filter((p) => p[0] >= since && p[0] < first - MINUTE_MS);
      return { span, every: EVERY_MS / 1000, points: [...minutes, ...this.seconds.filter((p) => p[0] >= since && p[0] > after)] };
    }
    const all = this.points.filter((p) => p[0] >= since);
    const every = Math.max(MINUTE_MS, Math.ceil(ms / MAX_POINTS / MINUTE_MS) * MINUTE_MS);
    // Averaged over stretches of `every` (a stretch with no readings is left out: a gap).
    const buckets = new Map();
    for (const p of all) {
      const k = Math.floor((p[0] - since) / every);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(p);
    }
    return { span, every: every / 1000, points: [...buckets.entries()].map(([k, ps]) => average(Math.round(since + (k + 0.5) * every), ps)) };
  }
}

module.exports = { RoomHistory, SPANS, EVERY_MS, NET };
