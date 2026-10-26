/**
 * ps4cam.js — the PlayStation 4 camera (CUH-ZEY1, CUH-ZEY2: two lenses side by side) as one of
 * "Several cameras" (multi-camera.js), in the Windows and Linux app: a helper each
 * (ps4cam/ps4cam_helper.py, run by the Python the app keeps for OAK cameras, electron/oak.js), which
 * sends the camera its firmware when it's been plugged in, then streams the left lens's picture
 * (the page finds the hands on it), the picture its view makes and the depth for each part of it.
 * The firmware is Sony's (firmware.bin, as the PC tools for this camera use): the person chooses
 * their copy once, and it's kept in this app's data folder. It plugs into USB 3 through an adapter
 * (Sony's for the PS5, say); on Windows its start-up mode needs the WinUSB driver (Zadig, once).
 *
 *   Ps4Camera.available()                -> { ok, reason }
 *   await Ps4Camera.status(dataDir)      -> { ready, firmware, reason }   (ready: its Python's set up)
 *   await Ps4Camera.setup(dataDir, progress)   OAK support's Python (set up first if it isn't) and pyusb
 *   Ps4Camera.setFirmware(dataDir, file) -> { ok, size } | { ok: false, reason }  (a copy kept)
 *   await Ps4Camera.list(dataDir)        -> { devices: [{ id, name, ready }], setup, firmware }  (id: its USB
 *                                        port; ready: it has its firmware; setup: one's plugged in and the
 *                                        one-time setup is needed first; firmware: its file's been chosen)
 *   const cam = new Ps4Camera(dataDir);
 *   cam.start(options, onMessage)        options: { device, size: "1280x800" | "640x400", fps, view, depth, night: "auto" | "on" | "off" }
 *                                        onMessage: { status… } | { frame, jpeg, shown, depth }
 *   cam.command(line)                    "view <view>", "depth on|off", "night auto|on|off"
 *   cam.next()                           the next frame wanted: the helper makes one only when asked (the
 *                                        first without), so none is made that would only be dropped
 *   cam.stop()
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { OakCamera, readMessages } = require("./oak");

const HELPER = path.join(__dirname, "..", "ps4cam", "ps4cam_helper.py").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
// pyusb (BSD) and its libusb (libusb-package, Apache 2.0, LGPL libusb inside; and what it needs):
// the firmware goes over USB.
const PACKAGES = ["pyusb==1.3.1", "libusb-package==1.0.30.0", "importlib-resources==7.1.0"];
const VIEWS = ["left", "right", "side", "anaglyph", "blend", "merged", "depth", "depth-blend", "depth-side"];
const ID = /^[0-9]{1,3}-[0-9.]{1,24}$/;
const firmwareFile = (dataDir) => path.join(dataDir, "ps4cam", "firmware.bin");

class Ps4Camera {
  static available() {
    if (!["win32", "linux"].includes(process.platform) || !["x64", "arm64"].includes(process.arch) || (process.platform === "win32" && process.arch !== "x64")) {
      return { ok: false, reason: "The PS4 camera works in the Windows (64-bit) and Linux apps." };
    }
    return { ok: true };
  }

  // Runs the helper once and resolves its first message.
  static run(dataDir, args) {
    const python = new OakCamera(dataDir).paths.python;
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(python)) return reject(new Error("The PS4 camera needs a one-time setup."));
      const proc = spawn(python, ["-u", HELPER, ...args], { windowsHide: true });
      let buf = Buffer.alloc(0), err = "";
      const timer = setTimeout(() => proc.kill(), 20000);
      proc.stdout.on("data", (d) => (buf = Buffer.concat([buf, d])));
      proc.stderr.on("data", (d) => (err += d));
      proc.on("error", reject);
      proc.on("close", () => {
        clearTimeout(timer);
        const msg = readMessages(buf).messages[0];
        if (msg) resolve(msg.header);
        else reject(new Error(err.trim().split("\n").pop() || "The PS4 camera's helper didn't answer."));
      });
    });
  }

  static async status(dataDir) {
    if (!Ps4Camera.available().ok) return { ready: false, firmware: false, reason: Ps4Camera.available().reason };
    const firmware = fs.existsSync(firmwareFile(dataDir));
    const check = await Ps4Camera.run(dataDir, ["--check"]).catch((err) => ({ status: "error", message: err.message }));
    if (check.status !== "check" || !check.usb) return { ready: false, firmware, reason: "The PS4 camera needs a one-time setup (about 150 MB, or 1 MB with OAK support set up)." };
    return { ready: true, firmware, reason: firmware ? "" : "Choose the PS4 camera's firmware file (firmware.bin) once." };
  }

  static async setup(dataDir, progress = () => {}) {
    const oak = new OakCamera(dataDir);
    if (!fs.existsSync(oak.paths.python) || !(await oak.status()).ready) await oak.setup(progress);
    progress(`Installing ${PACKAGES.join(", ")}…`);
    await oak.run(oak.paths.uv, ["pip", "install", "--python", oak.paths.python, ...PACKAGES], progress, oak.uvEnv());
    const s = await Ps4Camera.status(dataDir);
    if (!s.ready) throw new Error(s.reason);
    progress("PS4 camera support is ready.");
    return s;
  }

  // The person's copy of the firmware, kept (a file of a sensible size; what's in it is the camera's to judge).
  static setFirmware(dataDir, file) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return { ok: false, reason: "That file couldn't be read." };
    }
    if (size < 4096 || size > 8 << 20) return { ok: false, reason: "That isn't the PS4 camera's firmware (firmware.bin is tens of kilobytes)." };
    fs.mkdirSync(path.dirname(firmwareFile(dataDir)), { recursive: true });
    fs.copyFileSync(file, firmwareFile(dataDir));
    return { ok: true, size };
  }

  // The PS4 cameras plugged in, listed by the helper; before its setup, only whether one is.
  static async list(dataDir) {
    if (!Ps4Camera.available().ok) return { devices: [], setup: false, firmware: true };
    const status = await Ps4Camera.status(dataDir);
    if (!status.ready) return { devices: [], setup: await Ps4Camera.pluggedIn(), firmware: status.firmware };
    const msg = await Ps4Camera.run(dataDir, ["--list"]).catch(() => null);
    const devices = msg && msg.status === "devices" && Array.isArray(msg.devices) ? msg.devices : [];
    return {
      devices: devices.filter((d) => d && ID.test(String(d.id))).map((d) => ({ id: String(d.id), name: "PlayStation 4 camera", ready: !!d.ready })),
      setup: false,
      firmware: status.firmware,
    };
  }

  // Whether a PS4 camera is plugged in, without the helper: Linux's own list of USB devices, or
  // Windows' (PowerShell's Get-PnpDevice).
  static pluggedIn() {
    if (process.platform === "linux") {
      try {
        return fs.readdirSync("/sys/bus/usb/devices").some((d) => {
          const read = (f) => fs.readFileSync(path.join("/sys/bus/usb/devices", d, f), "utf8").trim().toLowerCase();
          try {
            return read("idVendor") === "05a9" && ["0580", "058a", "058b"].includes(read("idProduct"));
          } catch {
            return false;
          }
        });
      } catch {
        return false;
      }
    }
    return new Promise((resolve) => {
      const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match '^USB\\\\VID_05A9&PID_058[0AB]' } | Select-Object -First 1 -ExpandProperty InstanceId"], { windowsHide: true });
      let out = "";
      ps.stdout.on("data", (d) => (out += d));
      ps.on("error", () => resolve(false));
      ps.on("close", () => resolve(/VID_05A9/i.test(out)));
    });
  }

  constructor(dataDir) {
    this.dataDir = dataDir;
    this.proc = null;
  }

  start(options, onMessage) {
    this.stop();
    const python = new OakCamera(this.dataDir).paths.python;
    const args = ["-u", HELPER, "--firmware", firmwareFile(this.dataDir), "--ffmpeg", require("./exporter").ffmpegPath, "--paced"];
    if (options.simulate) args.push("--simulate");
    if (ID.test(String(options.device || ""))) args.push("--device", options.device);
    if (["1280x800", "640x400"].includes(options.size)) args.push("--size", options.size);
    if (Number.isInteger(options.fps) && options.fps >= 8 && options.fps <= 120) args.push("--fps", String(options.fps));
    if (VIEWS.includes(options.view)) args.push("--view", options.view);
    if (options.depth) args.push("--depth");
    if (["auto", "on", "off"].includes(options.night)) args.push("--night", options.night);
    const proc = spawn(python, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    const log = helperLog(this.dataDir, options.device, args.slice(2));
    let buf = Buffer.alloc(0), err = "";
    proc.stdout.on("data", (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      const { messages, rest } = readMessages(buf);
      buf = Buffer.from(rest);
      for (const m of messages) {
        const h = m.header;
        const part = (name) => (h.parts && Array.isArray(h.parts[name]) && m.jpeg ? m.jpeg.subarray(h.parts[name][0], h.parts[name][0] + h.parts[name][1]) : null);
        if (h.status) onMessage(h);
        else if (h.kind === "frame") onMessage({ frame: h, jpeg: part("jpeg"), shown: part("shown"), depth: part("depth") });
      }
    });
    proc.stderr.on("data", (d) => {
      err = (err + d).slice(-4000);
      log.write(d);
    });
    proc.stdin.on("error", () => {}); // (a helper that's gone)
    proc.on("error", (e) => onMessage({ status: "error", message: `The PS4 camera's helper couldn't start: ${e.message}` }));
    proc.on("close", (code) => {
      if (this.proc === proc) this.proc = null;
      log.end(`--- ${new Date().toISOString()} ended (${code})\n`);
      onMessage({ status: "stopped", code, detail: code ? err.trim().split("\n").filter((l) => l.trim()).slice(-2).join(" ") : "" });
    });
  }

  command(line) {
    if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(`${line}\n`);
  }

  next() {
    this.command("next");
  }

  stop() {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    proc.kill();
  }
}

// The helper's own lines (what went wrong, say), kept in this app's data folder: helper-<port>.log.
function helperLog(dataDir, device, args) {
  try {
    const dir = path.join(dataDir, "ps4cam");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `helper-${ID.test(String(device || "")) ? device : "ps4cam"}.log`);
    if (fs.existsSync(file) && fs.statSync(file).size > 1 << 20) fs.renameSync(file, file.replace(/\.log$/, ".old.log"));
    const out = fs.createWriteStream(file, { flags: "a" });
    out.on("error", () => {});
    out.write(`--- ${new Date().toISOString()} started: ${args.join(" ")}\n`);
    return out;
  } catch {
    return { write() {}, end() {} };
  }
}

// For the automated checks (HAND_TRACKER_PS4CAM_SIMULATE): a PS4 camera without one, streaming as
// the helper does: a grey left picture (the checks give the hand tracker its hands; not sent when
// the view's picture has it), the picture its view makes (twice as wide side by side), and a wall
// 2 m away with a box 850 mm away in the middle.
class SimulatedPs4Camera {
  start(options, onMessage) {
    const { nativeImage } = require("electron");
    this.onMessage = onMessage;
    const [w, h] = options.size === "640x400" ? [640, 400] : [1280, 800];
    let view = VIEWS.includes(options.view) ? options.view : "left", depth = !!options.depth;
    const jpegOf = (ww, hh, v) => nativeImage.createFromBitmap(Buffer.alloc(ww * hh * 4, v), { width: ww, height: hh }).toJPEG(70);
    const left = jpegOf(w, h, 90), single = jpegOf(w, h, 60), double = jpegOf(w * 2, h, 60);
    const [mw, mh] = [320, Math.round((h * 320) / w)];
    const map = Buffer.alloc(mw * mh * 2);
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) map.writeUInt16LE(Math.abs(x / mw - 0.5) < 0.15 && Math.abs(y / mh - 0.5) < 0.2 ? 850 : 2000, (y * mw + x) * 2);
    const f = Math.hypot(w, h) / 2 / Math.tan((42.5 * Math.PI) / 180);
    onMessage({ status: "running", camera: "PlayStation 4 camera", size: `${w}x${h}`, fps: 30, simulated: true, depthSize: `${mw}x${mh}`, nearest: 300 });
    let seq = 0;
    this.timer = setInterval(() => {
      const u = Date.now();
      const withDepth = depth || ["merged", "depth", "depth-blend", "depth-side"].includes(view);
      onMessage({
        frame: { kind: "frame", seq: ++seq, t: u, u, w, h, fps: 30, view, night: options.night === "on", dark: 120, image: { fx: f, fy: f, cx: w / 2, cy: h / 2 },
          ...(withDepth ? { map: { w: mw, h: mh, fx: (f * mw) / w, fy: (f * mw) / w, cx: mw / 2, cy: mh / 2 } } : {}) },
        jpeg: ["side", "depth-side", "merged"].includes(view) ? null : left,
        shown: view === "left" ? null : ["side", "depth-side"].includes(view) ? double : single,
        depth: withDepth ? map : null,
      });
    }, 33);
    this.set = (cmd, a) => {
      if (cmd === "view" && VIEWS.includes(a)) view = a;
      else if (cmd === "depth") depth = a === "on";
    };
  }

  command(line) {
    const [cmd, a] = String(line).split(" ");
    if (this.set) this.set(cmd, a);
    if (this.onMessage) this.onMessage({ status: "note", applied: line });
  }

  next() {} // (its frames come at their own rate; any the page isn't ready for are dropped)

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.onMessage({ status: "stopped", code: 0, detail: "" });
  }
}

module.exports = { Ps4Camera, SimulatedPs4Camera, VIEWS };
