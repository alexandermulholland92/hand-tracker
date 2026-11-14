/**
 * imu-in.js — motion sensors (IMUs) other than the OAK cameras' own, from whatever sends them: any device on
 * the network (an ESP32 or Arduino board, a phone app such as Sensor Logger, HyperIMU or "IMU+GPS Stream",
 * a Bluetooth sensor's own bridge), a board on a USB serial port (Linux, Mac and Windows), or the remote
 * recording page on a phone (its own sensors). Their readings, made alike, go to the main window
 * (multi-camera.js), where each sensor gets a posture (imu-body.js), is shown and recorded with the takes.
 *
 *   const imu = new ImuIn();
 *   imu.on("readings", ({ id, name, rows }) => ...); // rows: [tMs (this computer's clock), ax, ay, az, gx, gy, gz]: m/s², rad/s
 *   imu.on("status", (s) => ...);                     // { udp: port | null, serial: [paths], sensors: [{ id, name, hz, units }] }
 *   imu.start(); imu.stop();
 *   imu.ingest(id, name, text | object);              // readings sent some other way (the rig page's POST /api/imu)
 *
 * What's understood (parseImu): JSON, one object, an array of them, or JSON lines: accelerometer as ax/ay/az,
 * accX/accY/accZ, acc_x..., accel/acc/acceleration as [x, y, z] or { x, y, z }; gyroscope as gx/gy/gz,
 * gyrX..., gyro_x..., gyro/gyr/gyroscope/rotationRate as [x, y, z] or { x, y, z } (or alpha/beta/gamma);
 * a time as t, time, timestamp, ts or millis; a name as name, device, id or deviceId; Sensor Logger's
 * { payload: [{ name: "totalacceleration" | "accelerometer" | "gravity" | "gyroscope", time, values }] }.
 * Or text lines of numbers (comma, space, tab or semicolon apart): 6 = ax ay az gx gy gz, 7 = t and those,
 * 9 or 10 = the same with a magnetometer's 3 after; a first line of names (ax,ay,az,... or the words above)
 * says which column is which. Units are told from the readings: an accelerometer at about 1 when still is in
 * g, a gyroscope that goes past 15 is in degrees a second. A sensor that sends its acceleration without
 * gravity (as phones' "linear acceleration") can't tell up: it's said so.
 */
"use strict";

const dgram = require("dgram");
const fs = require("fs");
const { execFile, spawn } = require("child_process");
const EventEmitter = require("events");

const UDP_PORT = 47830;
const G = 9.80665;
const SERIAL_GLOB = /^tty(ACM|USB)\d+$/; // (Linux: USB serial boards)
const SERIAL_BAUD = 115200;
const NOT_IMU_MS = 15000;

// ---------- reading what a sensor sends ----------
const AX = ["ax", "accx", "acc_x", "accelx", "accel_x", "accelerationx", "x_acc"];
const AY = ["ay", "accy", "acc_y", "accely", "accel_y", "accelerationy", "y_acc"];
const AZ = ["az", "accz", "acc_z", "accelz", "accel_z", "accelerationz", "z_acc"];
const GX = ["gx", "gyrx", "gyr_x", "gyrox", "gyro_x", "gyroscopex", "x_gyro", "wx"];
const GY = ["gy", "gyry", "gyr_y", "gyroy", "gyro_y", "gyroscopey", "y_gyro", "wy"];
const GZ = ["gz", "gyrz", "gyr_z", "gyroz", "gyro_z", "gyroscopez", "z_gyro", "wz"];
const T = ["t", "time", "timestamp", "ts", "millis", "ms", "us", "micros"];
const ACC = ["totalacceleration", "accelerationincludinggravity", "accel", "acc", "accelerometer", "acceleration", "a"];
const GYR = ["gyro", "gyr", "gyroscope", "rotationrate", "angularvelocity", "w", "g"];
const NAME = ["name", "device", "devicename", "id", "deviceid", "sensor"];
const key = (k) => String(k).toLowerCase().replace(/[^a-z0-9_]/g, "");
const num = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

function vec(v) {
  if (Array.isArray(v) && v.length >= 3) return v.slice(0, 3).map(num);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[key(k)] = x;
    if ("x" in o) return [num(o.x), num(o.y), num(o.z)];
    if ("alpha" in o) return [num(o.beta), num(o.gamma), num(o.alpha)]; // (a browser's rotationRate: degrees a second)
  }
  return null;
}

// One JSON object -> { t?, a?: [3], g?: [3], name?, gravityFree? }
function fromObject(o) {
  const k = {};
  for (const [name, v] of Object.entries(o)) k[key(name)] = v;
  const pick = (list) => list.find((n) => n in k);
  const out = {};
  const tk = pick(T);
  if (tk) out.t = num(k[tk]) * (tk === "us" || tk === "micros" ? 0.001 : 1);
  const nk = pick(NAME);
  if (nk && typeof k[nk] !== "object") out.name = String(k[nk]).slice(0, 40);
  const ax = pick(AX), ay = pick(AY), az = pick(AZ);
  if (ax && ay && az) out.a = [num(k[ax]), num(k[ay]), num(k[az])];
  else for (const n of ACC) if (n in k && vec(k[n])) { out.a = vec(k[n]); if (n === "accelerometer" && "gravity" in k && vec(k.gravity)) out.a = out.a.map((v, i) => v + vec(k.gravity)[i]); break; }
  const gx = pick(GX), gy = pick(GY), gz = pick(GZ);
  if (gx && gy && gz) out.g = [num(k[gx]), num(k[gy]), num(k[gz])];
  else for (const n of GYR) if (n in k && vec(k[n])) { out.g = vec(k[n]); if (n === "rotationrate" && k[n] && "alpha" in k[n]) out.gDeg = true; break; }
  return out;
}

// Sensor Logger's (and alike) batches: [{ name, time, values }] -> readings, an accelerometer's and a
// gyroscope's at about the same time put together.
function fromBatch(list) {
  const acc = [], gyr = [], grav = [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const n = key(m.name || m.sensor || "");
    const v = vec(m.values || m.value || m);
    const t = num(m.time ?? m.timestamp ?? m.t);
    if (!v) continue;
    const ms = t > 1e15 ? t / 1e6 : t; // (nanoseconds since 1970 -> ms)
    if (n === "totalacceleration") acc.push({ t: ms, v, total: true });
    else if (n === "accelerometer") acc.push({ t: ms, v, total: false });
    else if (n === "gravity") grav.push({ t: ms, v });
    else if (n === "gyroscope" || n === "gyroscopeuncalibrated") gyr.push({ t: ms, v });
  }
  const total = acc.some((a) => a.total);
  const useAcc = total ? acc.filter((a) => a.total) : acc;
  const near = (list, t) => list.reduce((best, x) => (!best || Math.abs(x.t - t) < Math.abs(best.t - t) ? x : best), null);
  return useAcc.map((a) => {
    const g = near(gyr, a.t), gv = near(grav, a.t);
    const av = !a.total && gv ? a.v.map((x, i) => x + gv.v[i]) : a.v;
    return { t: a.t, a: av, g: g ? g.v : null, gravityFree: !a.total && !gv };
  });
}

// A line of numbers, with the column names a header line gave (or guessed from how many there are).
function fromNumbers(nums, header) {
  if (header) {
    const at = (list) => header.findIndex((h) => list.includes(h));
    const i = { t: at(T), ax: at(AX), ay: at(AY), az: at(AZ), gx: at(GX), gy: at(GY), gz: at(GZ) };
    if (i.ax >= 0 && i.ay >= 0 && i.az >= 0) {
      return { t: i.t >= 0 ? nums[i.t] : undefined, a: [nums[i.ax], nums[i.ay], nums[i.az]], g: i.gx >= 0 ? [nums[i.gx], nums[i.gy], nums[i.gz]] : null };
    }
  }
  if (nums.length === 6 || nums.length === 9) return { a: nums.slice(0, 3), g: nums.slice(3, 6) };
  if (nums.length === 7 || nums.length === 10) return { t: nums[0], a: nums.slice(1, 4), g: nums.slice(4, 7) };
  if (nums.length === 3) return { a: nums };
  return null;
}

/** text or a parsed object -> [{ t?, a, g, name?, gravityFree? }]; header: a source's column names, kept between calls. */
function parseImu(input, state = {}) {
  const out = [];
  const take = (r) => r && r.a && r.a.every(Number.isFinite) && out.push(r);
  const fromJson = (j) => {
    if (Array.isArray(j)) {
      if (j.length && j.every((x) => x && typeof x === "object" && ("values" in x || "value" in x) && "name" in x)) fromBatch(j).forEach(take);
      else if (j.length && j.every((x) => typeof x === "number")) take(fromNumbers(j, state.header));
      else j.forEach(fromJson);
    } else if (j && typeof j === "object") {
      if (Array.isArray(j.payload)) return fromJson(j.payload);
      if (Array.isArray(j.readings)) return j.readings.forEach((r) => fromJson(typeof r === "object" ? { ...r, name: r.name || j.name } : r));
      take(fromObject(j));
    }
  };
  if (input && typeof input === "object") {
    fromJson(input);
    return out;
  }
  const text = String(input || "");
  const trimmed = text.trim();
  if (/^[[{]/.test(trimmed)) {
    try {
      fromJson(JSON.parse(trimmed));
      return out;
    } catch {
      // (JSON lines, or not JSON)
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    if (/^[[{]/.test(l)) {
      try {
        fromJson(JSON.parse(l));
      } catch {
        // (a broken line)
      }
      continue;
    }
    const parts = l.split(/[,;\t ]+/).filter(Boolean);
    const nums = parts.map(Number);
    if (nums.every(Number.isFinite)) take(fromNumbers(nums, state.header));
    else if (parts.length >= 3 && parts.every((p) => /^[A-Za-z_][\w.-]*$/.test(p))) state.header = parts.map(key);
    else if (parts.length > 3 && nums.slice(1).every(Number.isFinite)) take(fromNumbers(nums.slice(1), state.header && state.header.slice(1))); // (a name first)
  }
  return out;
}

// ---------- each sensor: its units, its clock ----------
class Sensor {
  constructor(id, name) {
    this.id = id;
    this.name = name || id;
    this.accScale = null; // (1 m/s², or G for g)
    this.gyroDeg = false;
    this.gyroMax = 0;
    this.seen = [];
    this.offset = null; // (this computer's ms minus the sensor's own)
    this.count = 0;
    this.since = Date.now();
    this.gravityFree = false;
  }

  rows(readings) {
    const now = Date.now();
    const out = [];
    for (const r of readings) {
      if (r.name) this.name = r.name;
      if (r.gravityFree) this.gravityFree = true;
      const an = Math.hypot(...r.a);
      if (this.accScale === null) {
        this.seen.push(an);
        if (this.seen.length >= 20) {
          const m = this.seen.slice().sort((a, b) => a - b)[10];
          this.accScale = m > 0.5 && m < 2 ? G : 1;
          if (m < 0.5) this.gravityFree = true;
        }
      }
      const g = r.g && r.g.every(Number.isFinite) ? r.g : [0, 0, 0];
      this.gyroMax = Math.max(this.gyroMax, ...g.map(Math.abs));
      if (r.gDeg || this.gyroMax > 15) this.gyroDeg = true;
      // Its own clock, on this computer's: kept close to when the readings come (late ones aren't moved back).
      let t = now;
      if (Number.isFinite(r.t)) {
        const own = r.t; // (ms: a board's millis(), or a phone's ms since 1970)
        if (this.offset === null || Math.abs(own + this.offset - now) > 300) this.offset = now - own;
        t = own + this.offset;
      }
      const s = this.accScale || (an > 0.5 && an < 2 ? G : 1);
      const k = this.gyroDeg ? Math.PI / 180 : 1;
      out.push([Math.round(t), r.a[0] * s, r.a[1] * s, r.a[2] * s, g[0] * k, g[1] * k, g[2] * k]);
      this.count++;
    }
    return out;
  }

  info() {
    const secs = Math.max(1, (Date.now() - this.since) / 1000);
    return { id: this.id, name: this.name, hz: Math.round(this.count / secs), units: `${this.accScale === G ? "g" : "m/s²"}, ${this.gyroDeg ? "°/s" : "rad/s"}`, gravityFree: this.gravityFree };
  }
}

class ImuIn extends EventEmitter {
  constructor({ port = UDP_PORT, serial = true } = {}) {
    super();
    this.port = port;
    this.serialOn = serial;
    this.sensors = new Map();
    this.states = new Map(); // (each source's column names)
    this.udp = null;
    this.serial = new Map(); // port -> its reading helper
    this.notImu = new Set(); // ports that send something else
    this.watch = null;
  }

  start() {
    if (this.udp) return;
    try {
      const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      sock.on("message", (msg, from) => this.ingest(`udp:${from.address}:${from.port}`, `${from.address}`, msg.toString("utf8")));
      sock.on("error", () => {
        try { sock.close(); } catch {}
        this.udp = null;
        this.emitStatus();
      });
      sock.bind(this.port, () => this.emitStatus());
      this.udp = sock;
    } catch {
      this.udp = null;
    }
    if (this.serialOn) {
      this.lookForSerial();
      this.watch = setInterval(() => this.lookForSerial(), 5000);
    }
    this.statusTimer = setInterval(() => this.emitStatus(), 5000);
  }

  stop() {
    if (this.udp) try { this.udp.close(); } catch {}
    this.udp = null;
    clearInterval(this.watch);
    clearInterval(this.statusTimer);
    for (const s of this.serial.values()) try { s.kill(); } catch {}
    this.serial.clear();
  }

  // USB serial boards, on any of the three: found every 5 seconds, each read by a small helper the system
  // has (Linux and Mac: sh, stty and cat on the port itself, so its speed holds; Windows: PowerShell's
  // SerialPort), at SERIAL_BAUD, DTR on (some boards only send with it). A port that sends but nothing a
  // motion sensor would is let go after NOT_IMU_MS and left alone until it's unplugged.
  async serialPorts() {
    if (process.platform === "win32") {
      const out = await new Promise((resolve) => execFile("reg", ["query", "HKLM\HARDWARE\DEVICEMAP\SERIALCOMM"], { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? "" : String(stdout))));
      // (USB ones only: not a Bluetooth link's ports, nor a computer's own)
      return out.split(/\r?\n/).map((l) => /^\s*(\S+)\s+REG_SZ\s+(COM\d+)\s*$/i.exec(l)).filter((m) => m && !/Bth|Serial0$|Serial1$/i.test(m[1]) && /USB|VCP|Silab|CH34|cdc|FTDI|Prolific|wch/i.test(m[1])).map((m) => m[2].toUpperCase());
    }
    let names = [];
    try {
      names = fs.readdirSync("/dev");
    } catch {
      return [];
    }
    const pattern = process.platform === "darwin" ? /^cu\.(usbmodem|usbserial|wchusbserial|SLAB_USBtoUART)/ : SERIAL_GLOB;
    return names.filter((n) => pattern.test(n)).map((n) => `/dev/${n}`);
  }

  async lookForSerial() {
    const ports = await this.serialPorts();
    for (const p of [...this.notImu]) if (!ports.includes(p)) this.notImu.delete(p); // (unplugged: tried again when it's back)
    for (const path of ports) {
      if (this.serial.has(path) || this.notImu.has(path)) continue;
      const helper = process.platform === "win32"
        ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
            `$p = New-Object System.IO.Ports.SerialPort '${path}', ${SERIAL_BAUD}; $p.DtrEnable = $true; $p.RtsEnable = $true; $p.Open(); ` +
            "$o = [Console]::OpenStandardOutput(); while ($p.IsOpen) { $s = $p.ReadExisting(); if ($s) { $b = [Text.Encoding]::UTF8.GetBytes($s); $o.Write($b, 0, $b.Length); $o.Flush() } else { Start-Sleep -Milliseconds 15 } }"],
            { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
        : spawn("sh", ["-c", `exec <"$1"; stty ${SERIAL_BAUD} raw -echo 2>/dev/null; exec cat`, "sh", path], { stdio: ["ignore", "pipe", "ignore"] });
      const name = path.replace(/^\/dev\/(cu\.)?/, "");
      const id = `serial:${path}`;
      const since = Date.now();
      let rest = "", understood = 0, heard = 0;
      helper.stdout.setEncoding("utf8");
      helper.stdout.on("data", (chunk) => {
        heard += chunk.length;
        rest += chunk;
        const cut = rest.lastIndexOf("\n");
        if (cut >= 0) {
          understood += this.ingest(id, name, rest.slice(0, cut));
          rest = rest.slice(cut + 1);
        } else if (rest.length > 8192) rest = "";
        if (!understood && heard > 2000 && Date.now() - since > NOT_IMU_MS) {
          this.notImu.add(path); // (something else on that port: let go)
          helper.kill();
        }
      });
      helper.on("error", () => {});
      helper.on("exit", () => {
        this.serial.delete(path);
        this.emitStatus();
      });
      this.serial.set(path, helper);
      this.emitStatus();
    }
  }

  ingest(id, name, input) {
    const state = this.states.get(id) || {};
    this.states.set(id, state);
    let readings;
    try {
      readings = parseImu(input, state);
    } catch {
      return 0;
    }
    if (!readings.length) return 0;
    let s = this.sensors.get(id);
    if (!s) {
      s = new Sensor(id, name);
      s.last = Date.now();
      this.sensors.set(id, s);
      this.emitStatus();
    }
    const rows = s.rows(readings);
    s.last = Date.now();
    this.emit("readings", { id, name: s.name, rows, gravityFree: s.gravityFree });
    return rows.length;
  }

  status() {
    const now = Date.now();
    for (const [id, s] of this.sensors) if (now - (s.last || 0) > 30000) this.sensors.delete(id); // (gone quiet)
    return { udp: this.udp ? this.port : null, serial: [...this.serial.entries()].filter(([, s]) => s).map(([p]) => p), sensors: [...this.sensors.values()].map((s) => s.info()) };
  }

  emitStatus() {
    this.emit("status", this.status());
  }
}

module.exports = { ImuIn, parseImu, UDP_PORT };
