/**
 * storage.js — how much room is left where remote recording saves its takes, and whether this
 * computer has a battery of its own (remote-record-ui.js shows the space, the hours of
 * recording it holds and the battery's time left, here and on the remote recording page).
 *
 *   await space(dir) -> { free, total } in bytes, of the drive dir is on (or the nearest folder
 *     above it that's there yet); null if it can't be told
 *   await hasBattery() -> whether it runs on a battery of its own (a laptop's), looked at once;
 *     a power bank can't be seen (a Raspberry Pi on one says no), nor a mouse's battery counted
 *
 * The battery's level and time left come from the page (navigator.getBattery): this only says
 * whether there's one, as a computer without one says it's full and plugged in.
 */

const { execFile } = require("child_process");
const fs = require("fs");
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

module.exports = { space, hasBattery, linuxBattery };
