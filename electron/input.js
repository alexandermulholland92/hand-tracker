/**
 * input.js — sends mouse and keyboard input to the computer, for the hand mouse, the
 * floating keyboard and gesture actions.
 *
 * Windows: input-helper.ps1, a small PowerShell process using Windows' own SendInput
 * (nothing to install). macOS: input-helper-mac (built from input-helper-mac.m with the app),
 * once Hand Tracker is allowed under Privacy & Security → Accessibility. Linux with an X11
 * desktop: xdotool (sudo apt install xdotool). Linux with a Wayland desktop (Raspberry Pi
 * OS's, GNOME's, KDE's), where no app may move the pointer or type into other apps:
 * input-helper-linux.py, a virtual mouse and keyboard made with the kernel's uinput, which the
 * desktop takes like plugged-in ones (the .deb lets whoever is logged in at the screen use it).
 *
 *   const input = new InputDriver();
 *   await input.start();                 // resolves when ready; rejects with a readable reason
 *   input.move(x, y);                    // physical screen pixels (points on a Mac)
 *   input.button("left" | "right" | "middle", "down" | "up" | "click" | "double");
 *   input.wheel(notches);                // positive = up
 *   input.key("ctrl+shift+s", "tap" | "down" | "up");
 *   input.text("Hello");                 // types it, in any language
 *   input.stop();
 */

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Nothing can run a file from inside app.asar (see "asarUnpack" in package.json).
const unpacked = (file) => path.join(__dirname, file).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const SCRIPT = unpacked("input-helper.ps1");
const MAC_HELPER = unpacked("input-helper-mac");
const LINUX_HELPER = unpacked("input-helper-linux.py");

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

// Key names -> Linux key codes (the kernel's input-event-codes.h), for input-helper-linux.py.
const LINUX_KEYS = {
  enter: 28, return: 28, esc: 1, escape: 1, tab: 15, space: 57, backspace: 14, delete: 111, del: 111,
  insert: 110, home: 102, end: 107, pageup: 104, pagedown: 109, up: 103, down: 108, left: 105, right: 106,
  ctrl: 29, control: 29, shift: 42, alt: 56, win: 125, windows: 125, meta: 125, super: 125, cmd: 125,
  capslock: 58, printscreen: 99, menu: 127,
  volumeup: 115, volumedown: 114, mute: 113, playpause: 164, nexttrack: 163, prevtrack: 165, stop: 166,
  ";": 39, "=": 13, ",": 51, "-": 12, ".": 52, "+": 13, plus: 13, "/": 53, "`": 41, "[": 26, "\\": 43, "]": 27, "'": 40,
};
for (const [row, first] of [["qwertyuiop", 16], ["asdfghjkl", 30], ["zxcvbnm", 44]]) [...row].forEach((c, i) => (LINUX_KEYS[c] = first + i));
for (let d = 1; d <= 9; d++) LINUX_KEYS[String(d)] = d + 1;
LINUX_KEYS["0"] = 11;
for (let f = 1; f <= 24; f++) LINUX_KEYS[`f${f}`] = f <= 10 ? 58 + f : f <= 12 ? 76 + f : 170 + f;

// Key names -> Mac virtual key codes; "media N" for a media key (input-helper-mac.m); null where
// a Mac keyboard has no such key. Win (and Cmd, Meta, Super) is Command, Alt is Option.
const MAC_KEYS = {
  enter: 36, return: 36, esc: 53, escape: 53, tab: 48, space: 49, backspace: 51, delete: 117, del: 117,
  insert: 114, home: 115, end: 119, pageup: 116, pagedown: 121, up: 126, down: 125, left: 123, right: 124,
  ctrl: 59, control: 59, shift: 56, alt: 58, win: 55, windows: 55, meta: 55, super: 55, cmd: 55,
  capslock: 57, printscreen: 105, menu: null,
  volumeup: "media 0", volumedown: "media 1", mute: "media 7", playpause: "media 16", nexttrack: "media 17", prevtrack: "media 18", stop: null,
  ";": 41, "=": 24, ",": 43, "-": 27, ".": 47, "+": 24, plus: 24, "/": 44, "`": 50, "[": 33, "\\": 42, "]": 30, "'": 39,
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46,
  1: 18, 2: 19, 3: 20, 4: 21, 5: 23, 6: 22, 7: 26, 8: 28, 9: 25, 0: 29,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90, f21: null, f22: null, f23: null, f24: null,
};

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

// A helper process that takes one command a line (input-helper.ps1 on Windows,
// input-helper-mac on a Mac): the same commands, each with its own key codes.
class HelperDriver {
  constructor(command, args, codeOf) {
    this.command = command;
    this.args = args;
    this.codeOf = codeOf; // key name -> key code
    this.proc = null;
    this.ready = null;
    this.waiting = []; // resolvers for answers (pos, pong), in order
  }
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const proc = spawn(this.command, this.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
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
    const codes = names.map((k) => this.codeOf(k));
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

class WindowsDriver extends HelperDriver {
  constructor() {
    super("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT], (k) => KEYS[k][0]);
  }
}

class MacDriver extends HelperDriver {
  constructor() {
    super(MAC_HELPER, [], (k) => {
      if (MAC_KEYS[k] == null) throw new Error(`A Mac keyboard has no ${k} key.`);
      return MAC_KEYS[k];
    });
    this.asked = 0;
  }
  start() {
    if (this.ready) return this.ready;
    if (!fs.existsSync(MAC_HELPER)) return Promise.reject(new Error("The Mac input helper isn't built: node scripts/build-mac-helper.js"));
    // macOS asks the person (in System Settings) before an app may move the pointer or type;
    // the question once a minute at most, as this is tried with each pointer move.
    const { systemPreferences } = require("electron");
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      if (Date.now() - this.asked > 60000) {
        this.asked = Date.now();
        systemPreferences.isTrustedAccessibilityClient(true);
      }
      return Promise.reject(new Error("macOS needs your permission first: System Settings → Privacy & Security → Accessibility, turn on Hand Tracker, then try again."));
    }
    return super.start();
  }
  keys(names, action) {
    // A media key is pressed whole (on its down, or a tap); there's nothing to hold.
    const media = names.map((k) => this.codeOf(k)).find((c) => typeof c === "string");
    if (media) {
      if (action !== "up") this.send(media);
      return;
    }
    super.keys(names, action);
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

// A Wayland desktop: no app may move the pointer or type into other apps there (xdotool only
// reaches the X server Wayland keeps for older apps, so it seemed to work and did nothing), so a
// virtual mouse and keyboard do it (input-helper-linux.py, with the kernel's uinput).
class UinputDriver extends HelperDriver {
  constructor() {
    super("python3", [LINUX_HELPER], (k) => LINUX_KEYS[k]);
  }
  start() {
    if (this.ready) return this.ready;
    try {
      fs.accessSync("/dev/uinput", fs.constants.W_OK);
    } catch {
      const user = require("os").userInfo().username;
      return Promise.reject(new Error(`This is a Wayland desktop, where apps can't move the pointer or type into other apps themselves, so Hand Tracker uses a virtual mouse and keyboard, which needs permission for /dev/uinput. Hand Tracker's package gives it to whoever is logged in at the screen when it's installed: reinstall it (sudo apt install --reinstall hand-tracker), or for now run: sudo setfacl -m u:${user}:rw /dev/uinput`));
    }
    return super.start();
  }
  // The helper takes a point as shares of the whole desktop (every screen together), as its
  // mouse gives positions like a drawing tablet's.
  move(x, y) {
    const displays = require("electron").screen.getAllDisplays();
    const x0 = Math.min(...displays.map((d) => d.bounds.x)), y0 = Math.min(...displays.map((d) => d.bounds.y));
    const x1 = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width)), y1 = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
    this.send(`move ${((x - x0) / Math.max(1, x1 - x0 - 1)).toFixed(5)} ${((y - y0) / Math.max(1, y1 - y0 - 1)).toFixed(5)}`);
  }
}

class InputDriver {
  constructor() {
    const wayland = process.platform === "linux" && (process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY);
    const Driver = { win32: WindowsDriver, darwin: MacDriver, linux: wayland ? UinputDriver : XdotoolDriver }[process.platform];
    this.driver = Driver ? new Driver() : null;
  }
  start() {
    if (!this.driver) return Promise.reject(new Error("Controlling the mouse and keyboard works in the Windows, Mac and Linux apps."));
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

module.exports = { LINUX_KEYS, InputDriver, parseCombo, KEYS, MAC_KEYS, MODIFIERS };
