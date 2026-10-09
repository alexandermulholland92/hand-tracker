/**
 * hid-core.js — Hand Tracker as a Bluetooth mouse and keyboard for another device: an iPhone
 * or iPad (its pointer needs AssistiveTouch on: Settings → Accessibility → Touch →
 * AssistiveTouch), or anything else that takes a Bluetooth mouse. The hand mouse, gesture
 * actions and the floating keyboard then work that device, the way they work a computer.
 *
 * This is the part every app shares: the HID report descriptor (what kind of device it is:
 * a keyboard, a mouse, and media and Home keys) and the reports for each move, click, key and
 * letter. Each app sends them its own way:
 *   - the Windows app: bt-hid-win.exe (Windows' own Bluetooth, nothing to install);
 *   - the Linux app (a Raspberry Pi too): bt-hid-linux.py (BlueZ, through D-Bus);
 *   - the Android app: BtHidPlugin.java (Android's Bluetooth HID device).
 * A Mac can't be one (macOS keeps Bluetooth mice to itself): there, iPhone Mirroring.
 *
 * A Bluetooth mouse moves the pointer by steps, not to a place. So the pointer's place is
 * kept here as the device's own: started by pushing it into the top-left corner, then moved
 * by the difference; at an edge it's pushed a little past, so wherever it drifted to, it's
 * back where it should be (the device stops it at its screen's edge).
 *
 *   HidCore.REPORT_MAP                       // bytes
 *   HidCore.REPORTS                          // { keyboard: { id, size }, mouse, consumer }
 *   const dev = HidCore.create({ send(id, bytes), screen: { w, h } }); // w, h: steps across it
 *   dev.pointer(nx, ny)                      // 0-1 across the device's screen
 *   dev.rehome()                             // the next pointer() starts from the corner again
 *   dev.button("left" | "right" | "middle", "down" | "up" | "click" | "double")
 *   dev.wheel(notches)                       // positive = up
 *   dev.key("cmd+h" | "homescreen" | ..., "tap" | "down" | "up")
 *   dev.text("Hello")                        // letters, digits and symbols on a US keyboard
 *   dev.release()                            // everything held let go
 *   HidCore.parseCombo(combo)                // the key names, checked (throws for unknown)
 *   HidCore.screenFor(kind)                  // steps across: "iphone", "iphone-landscape", "ipad", "ipad-landscape"
 */

(function (global) {
  const REPORTS = {
    keyboard: { id: 1, size: 8 }, // modifiers, reserved, six keys
    mouse: { id: 2, size: 4 }, // buttons, x, y, wheel (-127..127 each step)
    consumer: { id: 3, size: 2 }, // one media or system key (16 bits)
  };
  // prettier-ignore
  const REPORT_MAP = [
    // Keyboard (report 1)
    0x05, 0x01, 0x09, 0x06, 0xa1, 0x01, 0x85, 0x01,
    0x05, 0x07, 0x19, 0xe0, 0x29, 0xe7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02,
    0x95, 0x01, 0x75, 0x08, 0x81, 0x01,
    0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x25, 0x73, 0x05, 0x07, 0x19, 0x00, 0x29, 0x73, 0x81, 0x00,
    0xc0,
    // Mouse (report 2): three buttons, x, y and a wheel
    0x05, 0x01, 0x09, 0x02, 0xa1, 0x01, 0x85, 0x02, 0x09, 0x01, 0xa1, 0x00,
    0x05, 0x09, 0x19, 0x01, 0x29, 0x03, 0x15, 0x00, 0x25, 0x01, 0x95, 0x03, 0x75, 0x01, 0x81, 0x02,
    0x95, 0x01, 0x75, 0x05, 0x81, 0x03,
    0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x09, 0x38, 0x15, 0x81, 0x25, 0x7f, 0x75, 0x08, 0x95, 0x03, 0x81, 0x06,
    0xc0, 0xc0,
    // Consumer control (report 3): volume, media, Home, search
    0x05, 0x0c, 0x09, 0x01, 0xa1, 0x01, 0x85, 0x03, 0x15, 0x00, 0x26, 0xff, 0x03, 0x19, 0x00, 0x2a, 0xff, 0x03,
    0x75, 0x10, 0x95, 0x01, 0x81, 0x00, 0xc0,
  ];

  // Key names (the same as the computer apps' gesture actions take: electron/input.js) -> HID
  // keyboard usages; modifiers -> their bit; media and system keys -> consumer usages.
  const KEYS = {
    enter: 0x28, return: 0x28, esc: 0x29, escape: 0x29, backspace: 0x2a, tab: 0x2b, space: 0x2c,
    "-": 0x2d, "=": 0x2e, "+": 0x2e, plus: 0x2e, "[": 0x2f, "]": 0x30, "\\": 0x31, ";": 0x33, "'": 0x34, "`": 0x35,
    ",": 0x36, ".": 0x37, "/": 0x38, capslock: 0x39, printscreen: 0x46, insert: 0x49, home: 0x4a, pageup: 0x4b,
    delete: 0x4c, del: 0x4c, end: 0x4d, pagedown: 0x4e, right: 0x4f, left: 0x50, down: 0x51, up: 0x52, menu: 0x65,
  };
  for (let c = 0; c < 26; c++) KEYS[String.fromCharCode(97 + c)] = 0x04 + c;
  for (let d = 1; d <= 9; d++) KEYS[String(d)] = 0x1d + d;
  KEYS["0"] = 0x27;
  for (let f = 1; f <= 12; f++) KEYS[`f${f}`] = 0x39 + f;
  for (let f = 13; f <= 24; f++) KEYS[`f${f}`] = 0x5b + f;
  const MODS = { ctrl: 0x01, control: 0x01, shift: 0x02, alt: 0x04, option: 0x04, win: 0x08, windows: 0x08, meta: 0x08, super: 0x08, cmd: 0x08 };
  const CONSUMER = {
    volumeup: 0xe9, volumedown: 0xea, mute: 0xe2, playpause: 0xcd, nexttrack: 0xb5, prevtrack: 0xb6, stop: 0xb7,
    homescreen: 0x223, // an iPhone's or iPad's Home
    search: 0x221, // Spotlight
    onscreenkeyboard: 0x1ae, // shows or hides the on-screen keyboard
  };

  // "cmd+shift+4" -> ["cmd", "shift", "4"]; throws for a key it doesn't know.
  function parseCombo(combo) {
    const parts = String(combo || "")
      .toLowerCase()
      .split("+")
      .map((k) => k.trim())
      .map((k) => (k === "" ? "+" : k))
      .filter((k, i, all) => !(k === "+" && all[i - 1] === "+"));
    if (!parts.length) throw new Error("No key given.");
    for (const k of parts) if (!(k in KEYS) && !(k in MODS) && !(k in CONSUMER)) throw new Error(`Unknown key "${k}".`);
    return parts;
  }

  // Typing on a US keyboard layout (the device's hardware keyboard layout should be U.S.).
  const SHIFTED = { "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "~": "`", "<": ",", ">": ".", "?": "/" };
  function keyOfChar(ch) {
    if (ch === "\n") return [KEYS.enter, false];
    if (ch === "\t") return [KEYS.tab, false];
    if (ch === " ") return [KEYS.space, false];
    if (/^[a-z0-9]$/.test(ch) || "-=[]\\;'`,./".includes(ch)) return [KEYS[ch], false];
    if (/^[A-Z]$/.test(ch)) return [KEYS[ch.toLowerCase()], true];
    if (SHIFTED[ch]) return [KEYS[SHIFTED[ch]], true];
    return null;
  }

  // Steps across each kind of screen at iOS's usual pointer speed (about a point a step;
  // the Speed setting scales them).
  const SCREENS = { iphone: { w: 400, h: 870 }, "iphone-landscape": { w: 870, h: 400 }, ipad: { w: 820, h: 1180 }, "ipad-landscape": { w: 1180, h: 820 } };
  const screenFor = (kind, speed = 1) => {
    const s = SCREENS[kind] || SCREENS.iphone;
    const k = Math.min(4, Math.max(0.25, Number(speed) || 1));
    return { w: Math.round(s.w * k), h: Math.round(s.h * k) };
  };

  function create({ send, screen = SCREENS.iphone }) {
    let size = { w: screen.w, h: screen.h };
    let at = null; // where the pointer is, in steps from the top-left corner (null: not known)
    let buttons = 0;
    const mods = new Set(); // modifier names held
    const keys = []; // key usages held (six at most)
    let consumer = 0;

    const clampByte = (v) => Math.max(-127, Math.min(127, v)) & 0xff;
    function sendMouse(dx = 0, dy = 0, wheel = 0) {
      send(REPORTS.mouse.id, [buttons, clampByte(dx), clampByte(dy), clampByte(wheel)]);
    }
    // A move of any size, as steps of at most 127 each way.
    function moveBy(dx, dy) {
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 127));
      let sx = 0, sy = 0;
      for (let i = 1; i <= n; i++) {
        const x = Math.round((dx * i) / n) - sx, y = Math.round((dy * i) / n) - sy;
        sx += x;
        sy += y;
        if (x || y) sendMouse(x, y);
      }
    }
    function sendKeys() {
      let m = 0;
      for (const k of mods) m |= MODS[k];
      const out = [m, 0, 0, 0, 0, 0, 0, 0];
      keys.slice(0, 6).forEach((k, i) => (out[2 + i] = k));
      send(REPORTS.keyboard.id, out);
    }
    function sendConsumer() {
      send(REPORTS.consumer.id, [consumer & 0xff, (consumer >> 8) & 0xff]);
    }

    function pointer(nx, ny) {
      const cx = Math.min(1, Math.max(0, Number(nx) || 0)), cy = Math.min(1, Math.max(0, Number(ny) || 0));
      const pin = Math.round(0.15 * (size.w + size.h));
      if (!at) {
        moveBy(-2 * (size.w + size.h), -2 * (size.w + size.h)); // into the top-left corner
        at = { x: 0, y: 0 };
      }
      const dx = Math.round(cx * size.w - at.x), dy = Math.round(cy * size.h - at.y);
      at = { x: at.x + dx, y: at.y + dy };
      // At an edge: a little past it, so the pointer is surely there.
      moveBy(dx + (cx <= 0 ? -pin : cx >= 1 ? pin : 0), dy + (cy <= 0 ? -pin : cy >= 1 ? pin : 0));
    }

    const BUTTON = { left: 1, right: 2, middle: 4 };
    function button(which, action) {
      const b = BUTTON[which];
      if (!b || !["down", "up", "click", "double"].includes(action)) throw new Error("Unknown mouse button action.");
      const press = () => ((buttons |= b), sendMouse());
      const lift = () => ((buttons &= ~b), sendMouse());
      if (action === "down") return press();
      if (action === "up") return lift();
      press();
      lift();
      if (action === "double") press(), lift();
    }

    function wheel(notches) {
      const n = Math.max(-20, Math.min(20, Math.round(Number(notches) || 0)));
      if (n) sendMouse(0, 0, n);
    }

    function key(combo, action = "tap") {
      if (!["tap", "down", "up"].includes(action)) throw new Error("Unknown key action.");
      const parts = parseCombo(combo);
      const media = parts.some((k) => k in CONSUMER), keyboard = parts.some((k) => !(k in CONSUMER));
      const down = () => {
        for (const k of parts) {
          if (k in MODS) mods.add(k);
          else if (k in CONSUMER) consumer = CONSUMER[k];
          else if (!keys.includes(KEYS[k])) keys.push(KEYS[k]);
        }
        if (keyboard) sendKeys();
        if (media) sendConsumer();
      };
      const up = () => {
        for (const k of parts) {
          if (k in MODS) mods.delete(k);
          else if (k in CONSUMER) consumer = 0;
          else {
            const i = keys.indexOf(KEYS[k]);
            if (i >= 0) keys.splice(i, 1);
          }
        }
        if (keyboard) sendKeys();
        if (media) sendConsumer();
      };
      if (action !== "up") down();
      if (action !== "down") up();
    }

    function text(str) {
      const s = String(str || "");
      if (s.length > 2000) throw new Error("That text is too long to type.");
      const missing = [...new Set([...s].filter((ch) => !keyOfChar(ch)))];
      if (missing.length) throw new Error(`These can't be typed as a Bluetooth keyboard: ${missing.slice(0, 8).join(" ")}`);
      for (const ch of s) {
        const [usage, shift] = keyOfChar(ch);
        let m = 0;
        for (const k of mods) m |= MODS[k];
        send(REPORTS.keyboard.id, [m | (shift ? MODS.shift : 0), 0, usage, 0, 0, 0, 0, 0]);
        send(REPORTS.keyboard.id, [m, 0, 0, 0, 0, 0, 0, 0]);
      }
      if (keys.length) sendKeys(); // keys held down again (each letter's report left them out)
    }

    function release() {
      buttons = 0;
      mods.clear();
      keys.length = 0;
      consumer = 0;
      sendMouse();
      sendKeys();
      sendConsumer();
    }

    return {
      pointer, button, wheel, key, text, release,
      rehome: () => (at = null),
      setScreen: (s) => {
        size = { w: Math.max(50, Math.round(s.w)), h: Math.max(50, Math.round(s.h)) };
        at = null;
      },
      _state: () => ({ at, size: { ...size }, buttons, mods: [...mods], keys: [...keys], consumer }),
    };
  }

  const api = { REPORT_MAP, REPORTS, KEYS, MODS, CONSUMER, parseCombo, create, screenFor, SCREENS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.HidCore = api;
})(typeof window !== "undefined" ? window : globalThis);
