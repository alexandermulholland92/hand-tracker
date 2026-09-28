/**
 * input.js — sends mouse and keyboard input to the computer, for the hand mouse, the
 * floating keyboard and gesture actions.
 *
 * Windows: input-helper.ps1, a small PowerShell process using Windows' own SendInput
 * (nothing to install). Linux: xdotool (sudo apt install xdotool), which works with X11
 * desktops; Wayland desktops don't let apps move the pointer or type into other apps.
 *
 *   const input = new InputDriver();
 *   await input.start();                 // resolves when ready; rejects with a readable reason
 *   input.move(x, y);                    // physical screen pixels
 *   input.button("left" | "right" | "middle", "down" | "up" | "click" | "double");
 *   input.wheel(notches);                // positive = up
 *   input.key("ctrl+shift+s", "tap" | "down" | "up");
 *   input.text("Hello");                 // types it, in any language
 *   input.stop();
 */

const { spawn, execFileSync } = require("child_process");
const path = require("path");

// PowerShell can't run a script from inside app.asar (see "asarUnpack" in package.json).
const SCRIPT = path.join(__dirname, "input-helper.ps1").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

// Key names -> [Windows virtual-key code, xdotool key name].
const KEYS = {
  enter: [0x0d, "Return"], return: [0x0d, "Return"], esc: [0x1b, "Escape"], escape: [0x1b, "Escape"],
  tab: [0x09, "Tab"], space: [0x20, "space"], backspace: [0x08, "BackSpace"], delete: [0x2e, "Delete"], del: [0x2e, "Delete"],
  insert: [0x2d, "Insert"], home: [0x24, "Home"], end: [0x23, "End"], pageup: [0x21, "Prior"], pagedown: [0x22, "Next"],
  up: [0x26, "Up"], down: [0x28, "Down"], left: [0x25, "Left"], right: [0x27, "Right"],
  ctrl: [0x11, "ctrl"], control: [0x11, "ctrl"], shift: [0x10, "shift"], alt: [0x12, "alt"],
  win: [0x5b, "super"], windows: [0x5b, "super"], meta: [0x5b, "super"], super: [0x5b, "super"], cmd: [0x5b, "super"],
  capslock: [0x14, "Caps_Lock"], printscreen: [0x2c, "Print"], menu: [0x5d, "Menu"],
  volumeup: [0xaf, "XF86AudioRaiseVolume"], volumedown: [0xae, "XF86AudioLowerVolume"], mute: [0xad, "XF86AudioMute"],
  playpause: [0xb3, "XF86AudioPlay"], nexttrack: [0xb0, "XF86AudioNext"], prevtrack: [0xb1, "XF86AudioPrev"], stop: [0xb2, "XF86AudioStop"],
  ";": [0xba, "semicolon"], "=": [0xbb, "equal"], ",": [0xbc, "comma"], "-": [0xbd, "minus"], ".": [0xbe, "period"],
  "+": [0xbb, "plus"], plus: [0xbb, "plus"],
  "/": [0xbf, "slash"], "`": [0xc0, "grave"], "[": [0xdb, "bracketleft"], "\\": [0xdc, "backslash"], "]": [0xdd, "bracketright"], "'": [0xde, "apostrophe"],
};
for (let c = 0; c < 26; c++) KEYS[String.fromCharCode(97 + c)] = [0x41 + c, String.fromCharCode(97 + c)];
for (let d = 0; d <= 9; d++) KEYS[String(d)] = [0x30 + d, String(d)];
for (let f = 1; f <= 24; f++) KEYS[`f${f}`] = [0x6f + f, `F${f}`];
const MODIFIERS = new Set(["ctrl", "control", "shift", "alt", "win", "windows", "meta", "super", "cmd"]);

// "Ctrl+Shift+S" -> ["ctrl", "shift", "s"]; throws for a key it doesn't know.
function parseCombo(combo) {
  const parts = String(combo || "")
    .toLowerCase()
    .split("+")
    .map((k) => k.trim())
    .map((k) => (k === "" ? "+" : k))
    .filter((k, i, all) => !(k === "+" && all[i - 1] === "+"));
  if (!parts.length) throw new Error("No key given.");
  for (const k of parts) if (!KEYS[k]) throw new Error(`Unknown key "${k}".`);
  return parts;
}

class WindowsDriver {
  constructor() {
    this.proc = null;
    this.ready = null;
    this.waiting = []; // resolvers for answers (pos, pong), in order
  }
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      this.proc = proc;
      let buf = "", errText = "", started = false;
      const timer = setTimeout(() => fail(new Error("The input helper didn't start in time.")), 30000);
      const fail = (err) => {
        clearTimeout(timer);
        if (!started) reject(err);
        this.stopped(err);
      };
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line === "ready") {
            started = true;
            clearTimeout(timer);
            resolve();
          } else if (line.startsWith("error ")) {
            console.warn("input helper:", line.slice(6));
          } else if (this.waiting.length) {
            this.waiting.shift()(line);
          }
        }
      });
      proc.stderr.on("data", (d) => (errText += d));
      proc.on("error", (err) => fail(err));
      proc.on("exit", (code) => fail(new Error(`The input helper stopped (${code})${errText ? ": " + errText.trim().split("\n").pop() : ""}`)));
    });
    return this.ready;
  }
  stopped() {
    this.proc = null;
    this.ready = null;
    for (const w of this.waiting.splice(0)) w(null);
  }
  send(line) {
    if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(`${line}\n`);
  }
  ask(line) {
    return new Promise((resolve) => {
      if (!this.proc) return resolve(null);
      this.waiting.push(resolve);
      this.send(line);
    });
  }
  move(x, y) {
    this.send(`move ${Math.round(x)} ${Math.round(y)}`);
  }
  button(which, action) {
    this.send(`${action} ${which}`);
  }
  wheel(n) {
    this.send(`wheel ${Math.round(n)}`);
  }
  keys(names, action) {
    const codes = names.map((k) => KEYS[k][0]);
    if (action === "down") for (const c of codes) this.send(`keydown ${c}`);
    else if (action === "up") for (const c of [...codes].reverse()) this.send(`keyup ${c}`);
    else {
      // Modifiers held, the key tapped, modifiers released.
      const mods = codes.slice(0, -1);
      for (const c of mods) this.send(`keydown ${c}`);
      this.send(`tap ${codes[codes.length - 1]}`);
      for (const c of mods.reverse()) this.send(`keyup ${c}`);
    }
  }
  text(str) {
    this.send(`text ${Buffer.from(String(str), "utf8").toString("base64")}`);
  }
  async cursor() {
    const answer = await this.ask("pos");
    const m = /^pos (-?\d+) (-?\d+)$/.exec(answer || "");
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  }
  stop() {
    if (this.proc) this.proc.stdin.end();
  }
}

class XdotoolDriver {
  constructor() {
    this.ready = null;
    this.queue = []; // argument lists, run one at a time
    this.running = false;
  }
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      try {
        execFileSync("xdotool", ["version"], { stdio: "ignore" });
      } catch {
        this.ready = null;
        return reject(new Error("Controlling the mouse and keyboard needs xdotool: sudo apt install xdotool"));
      }
      if (process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) {
        this.ready = null;
        return reject(new Error("This is a Wayland desktop, which doesn't let apps move the pointer or type into other apps. Log in with an X11 (Xorg) session to use this."));
      }
      resolve();
    });
    return this.ready;
  }
  run(args) {
    // A pointer move replaces any move still waiting, so the pointer never lags behind.
    if (args[0] === "mousemove") this.queue = this.queue.filter((a) => a[0] !== "mousemove");
    this.queue.push(args);
    this.next();
  }
  next() {
    if (this.running || !this.queue.length) return;
    this.running = true;
    const args = this.queue.shift();
    const proc = spawn("xdotool", args, { stdio: "ignore" });
    const done = () => {
      this.running = false;
      this.next();
    };
    proc.on("exit", done);
    proc.on("error", done);
  }
  move(x, y) {
    this.run(["mousemove", String(Math.round(x)), String(Math.round(y))]);
  }
  button(which, action) {
    const b = which === "right" ? "3" : which === "middle" ? "2" : "1";
    if (action === "down") this.run(["mousedown", b]);
    else if (action === "up") this.run(["mouseup", b]);
    else this.run(["click", "--repeat", action === "double" ? "2" : "1", b]);
  }
  wheel(n) {
    const count = Math.abs(Math.round(n));
    if (count) this.run(["click", "--repeat", String(count), n > 0 ? "4" : "5"]);
  }
  keys(names, action) {
    const combo = names.map((k) => KEYS[k][1]).join("+");
    this.run([action === "down" ? "keydown" : action === "up" ? "keyup" : "key", combo]);
  }
  text(str) {
    this.run(["type", "--delay", "0", "--", String(str)]);
  }
  async cursor() {
    try {
      const out = execFileSync("xdotool", ["getmouselocation", "--shell"], { encoding: "utf8" });
      const x = /X=(-?\d+)/.exec(out), y = /Y=(-?\d+)/.exec(out);
      return x && y ? { x: Number(x[1]), y: Number(y[1]) } : null;
    } catch {
      return null;
    }
  }
  stop() {}
}

class InputDriver {
  constructor() {
    this.driver = process.platform === "win32" ? new WindowsDriver() : process.platform === "linux" ? new XdotoolDriver() : null;
  }
  start() {
    if (!this.driver) return Promise.reject(new Error("Controlling the mouse and keyboard works in the Windows and Linux apps."));
    return this.driver.start();
  }
  move(x, y) {
    this.driver.move(x, y);
  }
  button(which, action) {
    if (!["left", "right", "middle"].includes(which) || !["down", "up", "click", "double"].includes(action)) throw new Error("Unknown mouse button action.");
    this.driver.button(which, action);
  }
  wheel(n) {
    this.driver.wheel(Math.max(-20, Math.min(20, Number(n) || 0)));
  }
  key(combo, action = "tap") {
    if (!["tap", "down", "up"].includes(action)) throw new Error("Unknown key action.");
    this.driver.keys(parseCombo(combo), action);
  }
  text(str) {
    const s = String(str || "");
    if (s.length > 2000) throw new Error("That text is too long to type.");
    if (s) this.driver.text(s);
  }
  cursor() {
    return this.driver.cursor();
  }
  stop() {
    if (this.driver) this.driver.stop();
  }
}

module.exports = { InputDriver, parseCombo, KEYS, MODIFIERS };
