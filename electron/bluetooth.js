/**
 * bluetooth.js — remote recording over Bluetooth on this computer, the rig's side: the link
 * (bluetooth-link.js) through this platform's Bluetooth (Linux: bluetooth-helper-linux.py, over
 * BlueZ), each request relayed to the remote recording server here (it's then as if from a phone
 * on this computer's hotspot: the password was the key). On while remote recording is, and a
 * password is set: on a Raspberry Pi set up with pi/bluetooth-setup.sh its hotspot's, else the
 * Bluetooth password set in the app.
 *
 *   const bt = new RigBluetooth({ dataDir, name, relay })
 *     relay({ method, path, body, peer }) -> Promise<{ status, type, body }>
 *   bt.available()                   this platform has it (Linux, for now)
 *   await bt.start(); bt.stop()
 *   bt.status() -> { available, on, error, address, network, password: null | "hotspot" | "set" }
 *     (network: its Bluetooth network is offered to Android phones, pi/bluetooth-setup.sh)
 *   bt.setPassword(text)             the Bluetooth password (8 to 63 characters), kept as its key only
 *   bt.secret()                      { salt, iter, key } or null
 *   bt.on("status", fn)
 */

const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { BluetoothLink, SERVICE, INFO, RX, TX, makeSecret } = require("./bluetooth-link.js");

const unpacked = (file) => path.join(__dirname, file).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const LINUX_HELPER = unpacked("bluetooth-helper-linux.py");

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
    return process.platform === "linux";
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
    if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  start() {
    if (this.proc || !this.available()) return Promise.resolve(this.status());
    if (!this.secret()) {
      this.setState({ on: false, error: "Set a Bluetooth password first." });
      return Promise.resolve(this.status());
    }
    return new Promise((resolve) => {
      let proc;
      try {
        proc = spawn("python3", [LINUX_HELPER], { stdio: ["pipe", "pipe", "pipe"] });
      } catch (err) {
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
    });
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try {
        proc.stdin.end();
      } catch {}
      setTimeout(() => proc.exitCode === null && proc.kill(), 3000);
    }
    this.setState({ on: false, error: "" });
  }
}

module.exports = { RigBluetooth };
