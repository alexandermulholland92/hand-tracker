/**
 * system-control.js — restarting this computer, turning it off, and its cameras' USB, for remote
 * recording's device settings page (remote-record-ui.js carries those out, asked from the page).
 *
 *   await capabilities() -> { reboot, powerOff: "yes" | "setup" | null, cameraReset: "power" | "soft" | null }
 *     reboot / powerOff: it can be restarted / turned off from here ("setup": a Linux computer
 *     that needs pi/restart-setup.sh first); cameraReset (Linux): "power" turns the cameras' USB
 *     ports off and on (uhubctl, allowed by pi/restart-setup.sh), as unplugging them would;
 *     "soft" only resets them on the USB (a camera that's stopped answering needs the power)
 *   await reboot() -> { ok, message }          restarts it a moment later
 *   await powerOff() -> { ok, message }        turns it off a moment later
 *   await resetCameras() -> { ok, message, how, count }
 *
 * Linux: "sudo -n" for what pi/restart-setup.sh allows (systemctl reboot and poweroff, uhubctl),
 * else what the person logged in may do anyway. Windows: shutdown. Mac: System Events (it may
 * ask to allow Hand Tracker the first time).
 *
 * USB power: a USB controller's ports are switched as one (its USB 2 and USB 3 halves), and a
 * Raspberry Pi 5's own four ports only together (one switch for all of them: one port alone is
 * only logically off, which leaves a stuck OAK camera stuck, or worse). A camera behind a hub:
 * that hub's port too. Never ports with a USB drive on them (the computer may run from it).
 */

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const USB = "/sys/bus/usb/devices";
const UHUBCTL = ["/usr/sbin/uhubctl", "/usr/bin/uhubctl", "/usr/local/sbin/uhubctl"];
const SYSTEMCTL = "/usr/bin/systemctl";

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, env: { ...process.env, LC_ALL: "C" } }, (err, out, errOut) => resolve({ ok: !err, out: String(out || ""), err: String(errOut || (err && err.message) || "") }));
  });
}

const uhubctl = () => UHUBCTL.find((p) => fs.existsSync(p)) || null;
// Allowed without a password (pi/restart-setup.sh's sudoers rule).
const allowed = async (...cmd) => (await run("sudo", ["-n", "-l", ...cmd], 5000)).ok;

// The cameras on the USB: Luxonis OAK (vendor 03e7) and video-class devices (webcams).
// -> [{ dev: "3-1", node: "/dev/bus/usb/003/004", name }]
function cameraDevices(root = USB) {
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!/^\d+-[\d.]+$/.test(n)) continue; // a device (not a root hub or an interface)
    const dir = path.join(root, n);
    const read = (f) => {
      try {
        return fs.readFileSync(path.join(dir, f), "utf8").trim();
      } catch {
        return "";
      }
    };
    const vendor = read("idVendor");
    let video = false;
    try {
      video = fs.readdirSync(dir).some((i) => i.startsWith(`${n}:`) && read(`${i}/bInterfaceClass`) === "0e");
    } catch {
      // (gone meanwhile)
    }
    if (vendor !== "03e7" && !video) continue;
    out.push({ dev: n, node: `/dev/bus/usb/${read("busnum").padStart(3, "0")}/${read("devnum").padStart(3, "0")}`, name: read("product") || (vendor === "03e7" ? "OAK camera" : "camera") });
  }
  return out;
}

// The hub and port a device is on, as uhubctl names them: "3-1" -> hub "3" port 1; "1-1.4" -> hub "1-1" port 4.
function hubPort(dev) {
  const m = /^(\d+)-([\d.]+)$/.exec(dev);
  if (!m) return null;
  const ports = m[2].split(".");
  const port = ports.pop();
  return { hub: ports.length ? `${m[1]}-${ports.join(".")}` : m[1], port };
}

// The root hubs switched together with bus `bus`'s (by their place in /sys): one controller's
// halves; a Raspberry Pi 5's own ports (its RP1 chip, 1000120000.pcie) all together.
function rootGroup(bus, root = USB) {
  const where = (n) => {
    try {
      return fs.realpathSync(path.join(root, `usb${n}`));
    } catch {
      return "";
    }
  };
  let pi5 = false;
  try {
    pi5 = /Raspberry Pi 5/.test(fs.readFileSync("/proc/device-tree/model", "utf8"));
  } catch {
    // (not a Pi)
  }
  const key = (p) => (pi5 && p.includes("/1000120000.pcie/") ? "rp1" : path.dirname(p));
  const mine = key(where(bus));
  let buses = [];
  try {
    buses = fs.readdirSync(root).filter((n) => /^usb\d+$/.test(n)).map((n) => n.slice(3));
  } catch {
    return [String(bus)];
  }
  return buses.filter((b) => where(b) && key(where(b)) === mine).sort((a, b) => a - b);
}

// A USB drive (mass storage) anywhere on these buses.
function driveOn(buses, root = USB) {
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return false;
  }
  return names.some((n) => {
    const m = /^(\d+)-[\d.]+:\d+\.\d+$/.exec(n);
    if (!m || !buses.includes(m[1])) return false;
    try {
      return fs.readFileSync(path.join(root, n, "bInterfaceClass"), "utf8").trim() === "08";
    } catch {
      return false;
    }
  });
}

let caps = null, capsAt = 0;
async function capabilities() {
  if (caps && Date.now() - capsAt < 60000) return caps;
  let reboot = null, powerOff = null, cameraReset = null;
  if (process.platform === "win32" || process.platform === "darwin") reboot = powerOff = "yes";
  else if (process.platform === "linux") {
    const ask = (what) => run("busctl", ["call", "org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager", what], 5000);
    reboot = (await allowed(SYSTEMCTL, "reboot")) || /"yes"/.test((await ask("CanReboot")).out) ? "yes" : "setup";
    powerOff = (await allowed(SYSTEMCTL, "poweroff")) || /"yes"/.test((await ask("CanPowerOff")).out) ? "yes" : "setup";
    const hub = uhubctl();
    cameraReset = hub && (await allowed(hub)) ? "power" : "soft";
  }
  caps = { reboot, powerOff, cameraReset };
  capsAt = Date.now();
  return caps;
}

async function reboot() {
  const later = (cmd, args) => setTimeout(() => execFile(cmd, args, () => {}), 1500);
  if (process.platform === "win32") {
    later("shutdown.exe", ["/r", "/t", "3", "/c", "Restarted from Hand Tracker's remote recording page."]);
    return { ok: true, message: "Restarting… This page reconnects when it's back." };
  }
  if (process.platform === "darwin") {
    later("osascript", ["-e", 'tell application "System Events" to restart']);
    return { ok: true, message: "Restarting… (the Mac may ask to allow Hand Tracker to restart it the first time). This page reconnects when it's back." };
  }
  if (process.platform !== "linux") return { ok: false, message: "This computer can't be restarted from here." };
  if (await allowed(SYSTEMCTL, "reboot")) later("sudo", ["-n", SYSTEMCTL, "reboot"]);
  else if ((await capabilities()).reboot === "yes") later(SYSTEMCTL, ["reboot"]);
  else return { ok: false, message: "Hand Tracker isn't allowed to restart this computer yet: on it, run sudo bash restart-setup.sh once (pi/restart-setup.sh)." };
  return { ok: true, message: "Restarting… This page reconnects when it's back (about a minute for a Raspberry Pi)." };
}

async function powerOff() {
  const later = (cmd, args) => setTimeout(() => execFile(cmd, args, () => {}), 1500);
  const off = "Turning off… It stays off until its power is turned on again (a Raspberry Pi 5: its power button, or unplug it and plug it back in).";
  if (process.platform === "win32") {
    later("shutdown.exe", ["/s", "/t", "3", "/c", "Turned off from Hand Tracker's remote recording page."]);
    return { ok: true, message: off };
  }
  if (process.platform === "darwin") {
    later("osascript", ["-e", 'tell application "System Events" to shut down']);
    return { ok: true, message: `${off} (The Mac may ask to allow Hand Tracker to turn it off the first time.)` };
  }
  if (process.platform !== "linux") return { ok: false, message: "This computer can't be turned off from here." };
  if (await allowed(SYSTEMCTL, "poweroff")) later("sudo", ["-n", SYSTEMCTL, "poweroff"]);
  else if ((await capabilities()).powerOff === "yes") later(SYSTEMCTL, ["poweroff"]);
  else return { ok: false, message: "Hand Tracker isn't allowed to turn this computer off yet: on it, run sudo bash restart-setup.sh (pi/restart-setup.sh)." };
  return { ok: true, message: off };
}

// Each camera's USB reset (the device's own, a USB port reset): what's possible without the power.
async function softReset(list) {
  if (!list.length) return 0;
  const code = "import fcntl, os, sys\nn = 0\nfor p in sys.argv[1:]:\n    try:\n        fd = os.open(p, os.O_WRONLY)\n        fcntl.ioctl(fd, 0x5514, 0)\n        os.close(fd)\n        n += 1\n    except OSError:\n        pass\nprint(n)\n";
  const r = await run("python3", ["-c", code, ...list.map((c) => c.node)], 20000);
  return Number(r.out.trim()) || 0;
}

async function resetCameras() {
  if (process.platform !== "linux") return { ok: false, message: "Only a Linux computer's cameras (a Raspberry Pi's) can be reset from here.", how: null, count: 0 };
  const list = cameraDevices();
  if (!list.length) return { ok: false, message: "No cameras are plugged in by USB.", how: null, count: 0 };
  const hub = uhubctl();
  if (hub && (await allowed(hub))) {
    // What's switched: each camera's controller's root ports (all a Pi 5's own together), and
    // a camera behind a hub, that hub's port too; not where a USB drive is.
    const roots = new Set(), hubPorts = new Map(), skipped = new Set();
    for (const c of list) {
      const bus = c.dev.split("-")[0];
      const group = rootGroup(bus);
      if (driveOn(group)) group.forEach((b) => skipped.add(b));
      else group.forEach((b) => roots.add(b));
      const hp = hubPort(c.dev);
      if (hp && hp.hub.includes("-")) hubPorts.set(`${hp.hub}:${hp.port}`, hp);
    }
    if (!roots.size && !hubPorts.size) {
      const n = await softReset(list);
      return { ok: n > 0, message: `A USB drive is on the cameras' USB ports, so their power wasn't turned off; ${n} of ${list.length} camera${list.length === 1 ? " was" : "s were"} reset on the USB.`, how: "soft", count: n };
    }
    const sw = (args) => run("sudo", ["-n", hub, ...args], 30000);
    const why = [];
    for (const { hub: h, port } of hubPorts.values()) {
      const r = await sw(["-a", "0", "-l", h, "-p", port]);
      if (!r.ok) why.push(r.err.split("\n")[0]);
    }
    for (const b of roots) {
      const r = await sw(["-a", "0", "-e", "-l", b]);
      if (!r.ok) why.push(r.err.split("\n")[0]);
    }
    await new Promise((res) => setTimeout(res, 3000));
    for (const b of roots) await sw(["-a", "1", "-e", "-l", b]);
    for (const { hub: h, port } of hubPorts.values()) await sw(["-a", "1", "-l", h, "-p", port]);
    if (why.length && why.length >= roots.size + hubPorts.size) {
      const n = await softReset(list);
      return { ok: n > 0, message: `Their USB ports couldn't be turned off (${why[0] || "uhubctl failed"}), so ${n} of ${list.length} camera${list.length === 1 ? " was" : "s were"} only reset on the USB.`, how: "soft", count: n };
    }
    return {
      ok: true, how: "power", count: list.length,
      message: `The cameras' USB was turned off and on: they start fresh, as if unplugged.${skipped.size ? " (Not the ports with a USB drive.)" : ""}`,
    };
  }
  const n = await softReset(list);
  return {
    ok: n > 0,
    message: `${n} of ${list.length} camera${list.length === 1 ? " was" : "s were"} reset on the USB. If one still doesn't answer, it needs its power off and on: run sudo bash restart-setup.sh on this computer once (pi/restart-setup.sh), then Restart cameras turns its USB off and on.`,
    how: "soft", count: n,
  };
}

module.exports = { capabilities, reboot, powerOff, resetCameras, cameraDevices, hubPort, rootGroup, driveOn };
