/**
 * storage.js — how much room is left where remote recording saves its takes, whether this
 * computer has a battery of its own, and how hot its processor is (remote-record-ui.js shows the
 * space, the hours of recording it holds, the battery's time left and the temperature, here and
 * on the remote recording page).
 *
 *   await space(dir) -> { free, total } in bytes, of the drive dir is on (or the nearest folder
 *     above it that's there yet); null if it can't be told
 *   await hasBattery() -> whether it runs on a battery of its own (a laptop's), looked at once;
 *     a power bank can't be seen (a Raspberry Pi on one says no), nor a mouse's battery counted
 *   await temperature() -> { c, of: "processor" }: the processor's temperature in °C, where the
 *     computer says it without an administrator: Linux from /sys (a Raspberry Pi's, or the
 *     hottest of a PC's processor sensors), Windows from its thermal zones' counters (many PCs
 *     leave them empty: then not looked at again); not a Mac (only with an administrator's
 *     password). null if it can't be told.
 *   memory() -> { total, available } in bytes: this computer's memory, and how much of it a
 *     program could still have (Linux: MemAvailable, which counts what its file cache would give
 *     back; Windows: what's free). null on a Mac (what it calls free leaves out what it would
 *     give back, so it always looks full).
 *
 *   await reserve() -> { on, level?, volts? }: whether a Raspberry Pi with a PiSugar under it is
 *     running on the PiSugar's own cell (its reserve), the power on the PiSugar's own socket gone
 *     (a power bank there run empty, say); null on a computer without one (not looked at again).
 *
 * The battery's level and time left come from the page (navigator.getBattery): this only says
 * whether there's one, as a computer without one says it's full and plugged in.
 */

const { execFile } = require("child_process");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

async function space(dir) {
  let d = path.resolve(String(dir || "."));
  for (;;) {
    try {
      const s = await fs.promises.statfs(d);
      return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
    } catch (err) {
      const up = path.dirname(d);
      if (err.code !== "ENOENT" || up === d) return null;
      d = up;
    }
  }
}

const run = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 15000, windowsHide: true }, (err, out) => resolve(err ? "" : String(out || ""))));

// Linux: a power supply of type Battery that isn't a device's (a mouse's, a game pad's).
function linuxBattery(root = "/sys/class/power_supply") {
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return false;
  }
  const read = (n, f) => {
    try {
      return fs.readFileSync(path.join(root, n, f), "utf8").trim();
    } catch {
      return "";
    }
  };
  return names.some((n) => read(n, "type") === "Battery" && read(n, "scope") !== "Device");
}

let battery = null;
function hasBattery() {
  if (!battery) {
    battery = (async () => {
      if (process.platform === "linux") return linuxBattery();
      if (process.platform === "darwin") return /InternalBattery/.test(await run("pmset", ["-g", "batt"]));
      if (process.platform === "win32") return Number((await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance -ClassName Win32_Battery | Measure-Object).Count"])).trim()) > 0;
      return false;
    })().catch(() => false);
  }
  return battery;
}

// Linux: the processor's thermal zones (a Pi's "cpu-thermal"; a PC's "x86_pkg_temp"), else
// every zone's, else the processor's sensors (hwmon: coretemp, k10temp): the hottest, in °C.
function linuxTemperature(root = "/sys/class") {
  const read = (...p) => {
    try {
      return fs.readFileSync(path.join(root, ...p), "utf8").trim();
    } catch {
      return "";
    }
  };
  const list = (d) => {
    try {
      return fs.readdirSync(path.join(root, d));
    } catch {
      return [];
    }
  };
  const c = (v) => (v !== "" && Number(v) / 1000 > -40 && Number(v) / 1000 < 150 ? Number(v) / 1000 : null);
  const zones = list("thermal").filter((z) => z.startsWith("thermal_zone")).map((z) => ({ type: read("thermal", z, "type"), c: c(read("thermal", z, "temp")) })).filter((z) => z.c !== null);
  const cpu = zones.filter((z) => /cpu|soc|x86_pkg|package/i.test(z.type));
  let all = (cpu.length ? cpu : zones).map((z) => z.c);
  if (!all.length) {
    for (const h of list("hwmon")) {
      if (!/^(coretemp|k10temp|zenpower|cpu_thermal|soc_thermal)$/.test(read("hwmon", h, "name"))) continue;
      for (const f of list(path.join("hwmon", h))) if (/^temp\d+_input$/.test(f) && c(read("hwmon", h, f)) !== null) all.push(c(read("hwmon", h, f)));
    }
  }
  return all.length ? { c: Math.round(Math.max(...all) * 10) / 10, of: "processor" } : null;
}

// Windows: the thermal zones' counters (tenths of a kelvin), at most once a minute.
const WIN_MS = 60000;
let winTemp = { at: 0, value: null, none: false };
async function windowsTemperature(now = Date.now()) {
  if (winTemp.none || now - winTemp.at < WIN_MS) return winTemp.value;
  const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation | ForEach-Object { $_.HighPrecisionTemperature }"]);
  const all = out.split(/\s+/).map((v) => Number(v) / 10 - 273.15).filter((v) => v > -40 && v < 150);
  winTemp = { at: now, value: all.length ? { c: Math.round(Math.max(...all) * 10) / 10, of: "processor" } : null, none: !all.length && !winTemp.value };
  return winTemp.value;
}

// A PiSugar (pisugar-server installed): one that says whether its socket has power (PiSugar 2 and
// 3: "battery_power_plugged", with its cell's level) is asked. A PiSugar S Pro says nothing while
// its socket has power: it holds the I2C clock low then (its jumper), so the bus is dead and the
// server answers "I2C not connected"; with that power gone the bus works, and its power monitor
// (an INA219 at 0x40, its bus voltage in register 2) answers: that is "on its reserve" (seen on
// piradise, 2026-11-11). Looked at every RESERVE_MS at most.
const RESERVE_MS = 10000;
const PISUGAR = { server: "/usr/bin/pisugar-server", bus: "/dev/i2c-1", port: 8423 };
const INA219 = 'import fcntl,os\nf=os.open("/dev/i2c-1",os.O_RDWR)\nfcntl.ioctl(f,0x0703,0x40)\nos.write(f,bytes([2]))\nb=os.read(f,2)\nprint(((b[0]<<8|b[1])>>3)*0.004)';
let reserved = { at: 0, value: null, none: false };
// What pisugar-server answers to a question ("battery: 87.5"), "" if it doesn't.
const askPisugar = (question) =>
  new Promise((resolve) => {
    let out = "";
    const socket = net.connect({ host: "127.0.0.1", port: PISUGAR.port });
    const done = () => (socket.destroy(), resolve(out.split("\n")[0].trim()));
    socket.setTimeout(2000, done);
    socket.on("connect", () => socket.write(question + "\n"));
    socket.on("data", (d) => ((out += d), /\n/.test(out) && done()));
    socket.on("error", done);
    socket.on("close", done);
  });
// (answers: what pisugar-server says to each question; probe: the power monitor's volts, "" unanswered)
async function pisugarReserve(answers = askPisugar, probe = () => run("python3", ["-c", INA219])) {
  const plugged = await answers("get battery_power_plugged");
  const said = /:\s*(true|false)\s*$/i.exec(plugged);
  if (said) {
    const level = Number((/:\s*([\d.]+)/.exec(await answers("get battery")) || [])[1]);
    return { on: said[1].toLowerCase() === "false", ...(level >= 0 && level <= 100 ? { level: Math.round(level) } : {}) };
  }
  if (!/I2C not connected/i.test(plugged)) return null; // (the server isn't answering: not told)
  const volts = Number((await probe()).trim());
  return volts > 0 ? { on: true, volts: Math.round(volts * 100) / 100 } : { on: false };
}
async function reserve(now = Date.now()) {
  if (process.platform !== "linux" || reserved.none) return null;
  if (now - reserved.at < RESERVE_MS) return reserved.value;
  if (!fs.existsSync(PISUGAR.server) || !fs.existsSync(PISUGAR.bus)) {
    reserved.none = true;
    return null;
  }
  reserved = { at: now, value: await pisugarReserve().catch(() => null), none: false };
  return reserved.value;
}

function memory(file = "/proc/meminfo") {
  try {
    if (process.platform === "linux") {
      const text = fs.readFileSync(file, "utf8");
      const kb = (name) => Number((text.match(new RegExp("^" + name + ":\\s+(\\d+) kB", "m")) || [])[1]);
      const total = kb("MemTotal") * 1024, available = kb("MemAvailable") * 1024;
      return total > 0 && available >= 0 ? { total, available } : null;
    }
    if (process.platform === "win32") return { total: os.totalmem(), available: os.freemem() };
  } catch {
    // (not told)
  }
  return null;
}

async function temperature() {
  try {
    if (process.platform === "linux") return linuxTemperature();
    if (process.platform === "win32") return await windowsTemperature();
  } catch {
    // (not told)
  }
  return null;
}

module.exports = { space, hasBattery, linuxBattery, temperature, linuxTemperature, reserve, pisugarReserve, memory };
