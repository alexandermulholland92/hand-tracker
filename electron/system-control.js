/**
 * system-control.js — restarting this computer, and its cameras' USB, for remote recording's
 * device settings page (remote-record-ui.js carries those out, asked from the page).
 *
 *   await capabilities() -> { reboot: "yes" | "setup" | null, cameraReset: "power" | "soft" | null }
 *     reboot: it can be restarted from here ("setup": a Linux computer that needs
 *     pi/restart-setup.sh first); cameraReset (Linux): "power" turns the cameras' USB ports off
 *     and on (uhubctl, allowed by pi/restart-setup.sh), as unplugging them would; "soft" only
 *     resets them on the USB (a camera that's stopped answering may need the power)
 *   await reboot() -> { ok, message }          restarts it a moment later
 *   await resetCameras() -> { ok, message, how, count }
 *
 * Linux: "sudo -n" for what pi/restart-setup.sh allows (systemctl reboot, uhubctl), else what
 * the person logged in may do anyway. Windows: shutdown /r. Mac: System Events (it may ask to
 * allow Hand Tracker the first time).
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

let caps = null, capsAt = 0;
async function capabilities() {
  if (caps && Date.now() - capsAt < 60000) return caps;
  let reboot = null, cameraReset = null;
  if (process.platform === "win32" || process.platform === "darwin") reboot = "yes";
  else if (process.platform === "linux") {
    const can = await run("busctl", ["call", "org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager", "CanReboot"], 5000);
    reboot = (await allowed(SYSTEMCTL, "reboot")) || /"yes"/.test(can.out) ? "yes" : "setup";
    const hub = uhubctl();
    cameraReset = hub && (await allowed(hub)) ? "power" : "soft";
  }
  caps = { reboot, cameraReset };
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
    // Each port with a camera, off and on (uhubctl does a USB 3 port's USB 2 side too; a hub
    // that switches all its ports at once, a Pi 5's own, does them all).
    const ports = new Map();
    for (const c of list) {
      const hp = hubPort(c.dev);
      if (hp) ports.set(`${hp.hub}:${hp.port}`, hp);
    }
    let done = 0;
    const why = [];
    for (const { hub: h, port } of ports.values()) {
      const r = await run("sudo", ["-n", hub, "-a", "cycle", "-d", "2", "-l", h, "-p", port], 30000);
      if (r.ok) done++;
      else why.push(r.err.split("\n")[0]);
    }
    if (done) return { ok: true, message: `The cameras' USB was turned off and on (${done} port${done === 1 ? "" : "s"}): they start fresh, as if unplugged.`, how: "power", count: list.length };
    const n = await softReset(list);
    return { ok: n > 0, message: `Their USB ports couldn't be turned off (${why[0] || "uhubctl failed"}), so ${n} of ${list.length} camera${list.length === 1 ? " was" : "s were"} only reset on the USB.`, how: "soft", count: n };
  }
  const n = await softReset(list);
  return {
    ok: n > 0,
    message: `${n} of ${list.length} camera${list.length === 1 ? " was" : "s were"} reset on the USB. If one still doesn't answer, it needs its power off and on: run sudo bash restart-setup.sh on this computer once (pi/restart-setup.sh), then Restart cameras turns its USB off and on.`,
    how: "soft", count: n,
  };
}

module.exports = { capabilities, reboot, resetCameras, cameraDevices, hubPort };
