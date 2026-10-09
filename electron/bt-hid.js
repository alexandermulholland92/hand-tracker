/**
 * bt-hid.js — this computer as a Bluetooth mouse and keyboard for an iPhone or iPad (or
 * anything that takes one), so the hand mouse, gesture actions and the floating keyboard can
 * work it with this computer's cameras. The reports are hid-core.js's; a helper sends them:
 *   - Windows: bt-hid-win.cs, built the first time by the C# compiler Windows comes with;
 *   - Linux (a Raspberry Pi too): bt-hid-linux.py, through BlueZ;
 *   - a Mac can't (macOS keeps Bluetooth mice to itself): there, iPhone Mirroring.
 * On the iPhone: Settings → Bluetooth → pick this computer (shown as "Hand Tracker" or the
 * computer's name), and Settings → Accessibility → Touch → AssistiveTouch on, for the pointer.
 *
 *   const hid = new BtHid({ folder, onStatus });
 *   await hid.start();                 // advertising; rejects with a readable reason
 *   hid.status()                        // { state: "off" | "starting" | "waiting" | "connected" | "error", device, message }
 *   hid.device                          // HidCore's device: pointer, button, wheel, key, text
 *   hid.setScreen("iphone", 1)          // the device's screen and pointer speed
 *   hid.stop();
 */

const { spawn, execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const HidCore = require("../hid-core.js");

// Nothing can run a file from inside app.asar (see "asarUnpack" in package.json).
const unpacked = (file) => path.join(__dirname, file).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

const MAC_MESSAGE = "A Mac can't be a Bluetooth mouse (macOS doesn't let apps be one). Use iPhone Mirroring instead: choose \"iPhone Mirroring window\" under Screen.";

// The Windows helper, built once per version of its source into folder (Windows' own C#
// compiler and WinRT metadata: nothing to install).
function buildWindowsHelper(folder) {
  const src = unpacked("bt-hid-win.cs");
  const code = fs.readFileSync(src);
  const hash = crypto.createHash("sha256").update(code).digest("hex").slice(0, 12);
  const exe = path.join(folder, `bt-hid-win-${hash}.exe`);
  if (fs.existsSync(exe)) return Promise.resolve(exe);
  const win = process.env.SystemRoot || "C:\\Windows";
  const fw = ["Framework64", "Framework"].map((d) => path.join(win, "Microsoft.NET", d, "v4.0.30319")).find((d) => fs.existsSync(path.join(d, "csc.exe")));
  const meta = path.join(win, "System32", "WinMetadata");
  if (!fw || !fs.existsSync(meta)) return Promise.reject(new Error("This Windows is missing .NET Framework 4 or its WinRT metadata, which the Bluetooth mouse needs."));
  fs.mkdirSync(folder, { recursive: true });
  for (const old of fs.readdirSync(folder)) if (/^bt-hid-win-[0-9a-f]+\.exe$/.test(old)) fs.rmSync(path.join(folder, old), { force: true });
  const refs = ["Windows.Devices.winmd", "Windows.Foundation.winmd", "Windows.Storage.winmd"].map((f) => `-r:${path.join(meta, f)}`);
  refs.push(`-r:${path.join(fw, "System.Runtime.dll")}`, `-r:${path.join(fw, "System.Runtime.InteropServices.WindowsRuntime.dll")}`);
  const tmp = `${exe}.tmp.exe`;
  return new Promise((resolve, reject) => {
    execFile(path.join(fw, "csc.exe"), ["-nologo", "-optimize", `-out:${tmp}`, ...refs, src], { windowsHide: true, timeout: 120000 }, (err, stdout) => {
      if (err) return reject(new Error(`The Bluetooth mouse helper didn't build: ${String(stdout || err.message).trim().split(/\r?\n/)[0]}`));
      fs.renameSync(tmp, exe);
      resolve(exe);
    });
  });
}

class BtHid {
  constructor({ folder, onStatus = () => {} }) {
    this.folder = folder;
    this.onStatus = onStatus;
    this.proc = null;
    this.ready = null;
    this.state = { state: "off", device: "", message: "" };
    this.device = HidCore.create({ send: (id, bytes) => this.send(id, bytes) });
  }

  status() {
    return { ...this.state };
  }
  setState(s) {
    this.state = { ...this.state, ...s };
    this.onStatus(this.status());
  }

  setScreen(kind, speed) {
    this.device.setScreen(HidCore.screenFor(kind, speed));
  }

  // -> [command, its first arguments, extra environment]
  async command() {
    // The checks: a stand-in device (scripts/fake-bt-hid.js), nothing sent over Bluetooth.
    if (process.env.HAND_TRACKER_BTHID_FAKE) return [process.execPath, [process.env.HAND_TRACKER_BTHID_FAKE], { ELECTRON_RUN_AS_NODE: "1" }];
    if (process.platform === "win32") return [await buildWindowsHelper(this.folder), [], {}];
    if (process.platform === "linux") return ["python3", [unpacked("bt-hid-linux.py")], {}];
    throw new Error(process.platform === "darwin" ? MAC_MESSAGE : "This computer can't be a Bluetooth mouse.");
  }

  start() {
    if (this.ready) return this.ready;
    this.setState({ state: "starting", device: "", message: "" });
    this.ready = (async () => {
      const [cmd, pre, env] = await this.command();
      const map = Buffer.from(HidCore.REPORT_MAP).toString("hex");
      const ids = Object.values(HidCore.REPORTS).map((r) => `${r.id}:${r.size}`).join(",");
      await new Promise((resolve, reject) => {
        const proc = spawn(cmd, [...pre, map, ids], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
        this.proc = proc;
        let buf = "", errText = "", started = false;
        const timer = setTimeout(() => done(new Error("Bluetooth didn't start in time.")), 30000);
        const done = (err) => {
          clearTimeout(timer);
          if (!started) {
            started = true;
            if (err) reject(err);
            else resolve();
          }
        };
        proc.stdout.on("data", (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line === "ready") {
              this.setState({ state: "waiting", message: "" });
              done();
            } else if (line.startsWith("clients ")) {
              const [, n, ...name] = line.split(" ");
              const connected = Number(n) > 0;
              if (connected && this.state.state !== "connected") this.device.rehome(); // a new connection: from the corner again
              this.setState({ state: connected ? "connected" : "waiting", device: connected ? name.join(" ") : "" });
            } else if (line.startsWith("error ")) {
              errText = line.slice(6);
              done(new Error(errText));
            }
          }
        });
        proc.stderr.on("data", (chunk) => (errText = errText || String(chunk).trim().split(/\r?\n/).pop()));
        proc.on("error", (err) => done(new Error(cmd === "python3" ? "Bluetooth here needs python3 (with python3-dbus and python3-gi)." : err.message)));
        proc.on("exit", (code) => {
          this.proc = null;
          this.ready = null;
          const message = errText || (code ? `Bluetooth stopped (${code}).` : "");
          this.setState({ state: message ? "error" : "off", device: "", message });
          done(new Error(message || "Bluetooth stopped."));
        });
      });
    })().catch((err) => {
      this.ready = null;
      this.setState({ state: "error", device: "", message: err.message });
      throw err;
    });
    return this.ready;
  }

  send(id, bytes) {
    if (!this.proc || !this.proc.stdin.writable) return;
    this.proc.stdin.write(`r ${id} ${Buffer.from(bytes).toString("hex")}\n`);
  }

  stop() {
    if (!this.proc) return this.setState({ state: "off", device: "", message: "" });
    try {
      this.device.release();
      this.proc.stdin.write("quit\n");
    } catch {}
    const proc = this.proc;
    setTimeout(() => {
      try {
        proc.kill();
      } catch {}
    }, 1500);
  }
}

module.exports = { BtHid, buildWindowsHelper, MAC_MESSAGE };
