/**
 * bluetooth.js — remote recording over Bluetooth on this computer, the rig's side: the link
 * (bluetooth-link.js) through this platform's Bluetooth (Linux: bluetooth-helper-linux.py, over
 * BlueZ; Windows: bluetooth-helper-win.cs, built the first time by the C# compiler Windows comes
 * with; Mac: bluetooth-helper-mac, built with the app), each request relayed to the remote
 * recording server here (it's then as if from a phone on this computer's hotspot: the password
 * was the key). On while remote recording is, and a password is set: on a Raspberry Pi set up
 * with pi/bluetooth-setup.sh its hotspot's, else the Bluetooth password set in the app.
 *
 *   const bt = new RigBluetooth({ dataDir, name, relay })
 *     relay({ method, path, body, peer }) -> Promise<{ status, type, body }>
 *   bt.available()                   this platform has it (Linux, Windows 10 or later, Mac)
 *   await bt.start(); bt.stop()
 *   bt.status() -> { available, on, error, address, network, password: null | "hotspot" | "set" }
 *     (network: its Bluetooth network is offered to Android phones, pi/bluetooth-setup.sh)
 *   bt.setPassword(text)             the Bluetooth password (8 to 63 characters), kept as its key only
 *   bt.secret()                      { salt, iter, key } or null
 *   bt.on("status", fn)
 */

const { spawn, execFile } = require("child_process");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { BluetoothLink, SERVICE, INFO, RX, TX, makeSecret } = require("./bluetooth-link.js");

const unpacked = (file) => path.join(__dirname, file).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const LINUX_HELPER = unpacked("bluetooth-helper-linux.py");
const MAC_HELPER = unpacked("bluetooth-helper-mac");

// The Windows helper, built once per version of its source into folder (Windows' own C#
// compiler and WinRT metadata, as electron/bt-hid.js's: nothing to install).
function buildWindowsHelper(folder) {
  const src = unpacked("bluetooth-helper-win.cs");
  const hash = crypto.createHash("sha256").update(fs.readFileSync(src)).digest("hex").slice(0, 12);
  const exe = path.join(folder, `bluetooth-helper-win-${hash}.exe`);
  if (fs.existsSync(exe)) return Promise.resolve(exe);
  const win = process.env.SystemRoot || "C:\\Windows";
  const fw = ["Framework64", "Framework"].map((d) => path.join(win, "Microsoft.NET", d, "v4.0.30319")).find((d) => fs.existsSync(path.join(d, "csc.exe")));
  const meta = path.join(win, "System32", "WinMetadata");
  if (!fw || !fs.existsSync(meta)) return Promise.reject(new Error("This Windows is missing .NET Framework 4 or its WinRT metadata, which Bluetooth needs here."));
  fs.mkdirSync(folder, { recursive: true });
  for (const old of fs.readdirSync(folder)) if (/^bluetooth-helper-win-[0-9a-f]+\.exe$/.test(old)) fs.rmSync(path.join(folder, old), { force: true });
  const refs = ["Windows.Devices.winmd", "Windows.Foundation.winmd", "Windows.Storage.winmd"].map((f) => `-r:${path.join(meta, f)}`);
  refs.push(`-r:${path.join(fw, "System.Runtime.dll")}`, `-r:${path.join(fw, "System.Runtime.InteropServices.WindowsRuntime.dll")}`);
  const tmp = `${exe}.tmp.exe`;
  return new Promise((resolve, reject) => {
    execFile(path.join(fw, "csc.exe"), ["-nologo", "-optimize", `-out:${tmp}`, ...refs, src], { windowsHide: true, timeout: 120000 }, (err, stdout) => {
      if (err) return reject(new Error(`The Bluetooth helper didn't build: ${String(stdout || err.message).trim().split(/\r?\n/)[0]}`));
      fs.renameSync(tmp, exe);
      resolve(exe);
    });
  });
}

// Windows 10 or later (Bluetooth Low Energy's peripheral role, WinRT's GATT server).
const windowsOk = () => process.platform === "win32" && Number(os.release().split(".")[0]) >= 10;

class RigBluetooth extends EventEmitter {
  constructor({ dataDir, name, relay }) {
    super();
    this.file = path.join(dataDir, "bluetooth.json");
    this.name = String(name || "Hand Tracker");
    this.relay = relay;
    this.proc = null;
    this.state = { on: false, error: "", address: "", network: false };
    this.link = new BluetoothLink({ name: this.name, secret: () => this.secret(), relay: (r) => this.relay(r), send: (frame) => this.write({ t: "tx", data: frame.toString("base64") }) });
  }

  available() {
    return process.platform === "linux" || windowsOk() || (process.platform === "darwin" && fs.existsSync(MAC_HELPER));
  }

  // The helper for this platform -> [command, args].
  async helper() {
    if (process.platform === "linux") return ["python3", [LINUX_HELPER]];
    if (process.platform === "darwin") return [MAC_HELPER, []];
    return [await buildWindowsHelper(path.join(path.dirname(this.file), "bluetooth-helper")), []];
  }

  secret() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return s && typeof s.salt === "string" && typeof s.key === "string" && Number.isInteger(s.iter) ? s : null;
    } catch {
      return null;
    }
  }

  setPassword(text) {
    const pw = String(text || "");
    if (pw.length < 8 || pw.length > 63) throw new Error("A Bluetooth password is 8 to 63 characters.");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ ...makeSecret(pw), from: "set" }), { mode: 0o600 });
    if (this.proc) this.write({ t: "info", data: this.link.info().toString("base64") });
    this.emit("status", this.status());
    return this.status();
  }

  status() {
    const s = this.secret();
    return { available: this.available(), on: this.state.on, error: this.state.error, address: this.state.address, network: this.state.network, password: s ? (s.from === "hotspot" ? "hotspot" : "set") : null };
  }

  setState(changes) {
    Object.assign(this.state, changes);
    this.emit("status", this.status());
  }

  write(msg) {
    if (this.proc && this.proc.stdin && this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  start() {
    if (this.proc || !this.available()) return Promise.resolve(this.status());
    if (!this.secret()) {
      this.setState({ on: false, error: "Set a Bluetooth password first." });
      return Promise.resolve(this.status());
    }
    this.proc = "starting";
    return this.helper().then(([cmd, args]) => new Promise((resolve) => {
      let proc;
      try {
        if (this.proc !== "starting") return resolve(this.status()); // (stopped meanwhile)
        proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } catch (err) {
        this.proc = null;
        this.setState({ on: false, error: `Bluetooth: ${err.message}` });
        return resolve(this.status());
      }
      this.proc = proc;
      let pending = "", settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve(this.status());
        }
      };
      proc.on("error", (err) => {
        this.setState({ on: false, error: `Bluetooth: ${err.message}` });
        done();
      });
      proc.on("exit", (code) => {
        if (this.proc === proc) this.proc = null;
        if (this.state.on || !this.state.error) this.setState({ on: false, error: code ? "Bluetooth stopped." : "" });
        done();
      });
      proc.stderr.on("data", () => {});
      proc.stdout.on("data", (d) => {
        pending += d;
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) {
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.t === "rx") this.link.received(String(msg.dev || ""), Buffer.from(String(msg.data || ""), "base64"), Number(msg.mtu) || 23);
          else if (msg.t === "gone") this.link.gone(String(msg.dev || ""));
          else if (msg.t === "ready") {
            this.setState({ on: true, error: "", address: String(msg.address || ""), network: !!msg.network });
            done();
          } else if (msg.t === "error") {
            this.setState({ error: String(msg.message || "Bluetooth didn't start.") });
            done();
          }
        }
      });
      this.write({ t: "info", data: this.link.info().toString("base64") });
      this.write({ t: "start", name: this.name.slice(0, 12), service: SERVICE, info: INFO, rx: RX, tx: TX });
      setTimeout(done, 15000);
    }), (err) => {
      this.proc = null;
      this.setState({ on: false, error: `Bluetooth: ${err.message}` });
      return this.status();
    });
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    if (proc && proc !== "starting") {
      try {
        proc.stdin.end();
      } catch {}
      setTimeout(() => proc.exitCode === null && proc.kill(), 3000);
    }
    this.setState({ on: false, error: "" });
  }
}

module.exports = { RigBluetooth };
