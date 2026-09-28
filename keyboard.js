/**
 * keyboard.js — the floating keyboard (keyboard.html), a window that stays on top and never
 * takes the keyboard focus, so each key goes to the app you're using. Click keys with the
 * hand mouse (a quick index-finger curl) or an ordinary mouse. Letters and symbols are
 * typed as characters; Ctrl, Alt and Win apply to the next key (Ctrl then C copies).
 */

(function () {
  const pc = window.desktop && window.desktop.pc;
  const keysEl = document.getElementById("keys");
  const statusEl = document.getElementById("status");
  const mouseBtn = document.getElementById("mouseBtn");

  // [label, key name, shifted label, width]; a single character's key name is itself.
  const ROWS = [
    [["`", "`", "~"], ["1", "1", "!"], ["2", "2", "@"], ["3", "3", "#"], ["4", "4", "$"], ["5", "5", "%"], ["6", "6", "^"], ["7", "7", "&"], ["8", "8", "*"], ["9", "9", "("], ["0", "0", ")"], ["-", "-", "_"], ["=", "=", "+"], ["⌫", "backspace", null, 1.8]],
    [["Tab", "tab", null, 1.4], ..."qwertyuiop".split("").map((c) => [c, c]), ["[", "[", "{"], ["]", "]", "}"], ["\\", "\\", "|", 1.3]],
    [["Caps", "capslock", null, 1.7], ..."asdfghjkl".split("").map((c) => [c, c]), [";", ";", ":"], ["'", "'", '"'], ["Enter", "enter", null, 2]],
    [["Shift", "shift", null, 2.2], ..."zxcvbnm".split("").map((c) => [c, c]), [",", ",", "<"], [".", ".", ">"], ["/", "/", "?"], ["↑", "up"], ["Del", "delete", null, 1.2]],
    [["Ctrl", "ctrl", null, 1.3], ["Win", "win", null, 1.2], ["Alt", "alt", null, 1.2], ["Esc", "esc", null, 1.2], ["Space", "space", null, 6], ["←", "left"], ["↓", "down"], ["→", "right"]],
  ];
  const MODIFIERS = new Set(["shift", "ctrl", "alt", "win"]);
  const held = { shift: false, ctrl: false, alt: false, win: false }; // apply to the next key
  let caps = false;
  const buttons = [];

  function build() {
    for (const row of ROWS) {
      const rowEl = document.createElement("div");
      rowEl.className = "row";
      for (const [label, name, shifted, width = 1] of row) {
        const b = document.createElement("button");
        b.className = "key" + (MODIFIERS.has(name) || name === "capslock" ? " mod" : "");
        b.style.flexGrow = String(width);
        b.dataset.name = name;
        b.dataset.label = label;
        if (shifted) b.dataset.shifted = shifted;
        b.tabIndex = -1;
        b.addEventListener("mousedown", (e) => e.preventDefault()); // keep any focus where it is
        b.addEventListener("click", () => press(b));
        rowEl.appendChild(b);
        buttons.push(b);
      }
      keysEl.appendChild(rowEl);
    }
    render();
  }

  const isLetter = (name) => /^[a-z]$/.test(name);

  function render() {
    for (const b of buttons) {
      const name = b.dataset.name;
      if (MODIFIERS.has(name)) b.classList.toggle("active", held[name]);
      else if (name === "capslock") b.classList.toggle("active", caps);
      if (isLetter(name)) b.textContent = held.shift !== caps ? name.toUpperCase() : name;
      else if (b.dataset.shifted) b.textContent = held.shift ? b.dataset.shifted : b.dataset.label;
      else b.textContent = b.dataset.label;
    }
  }

  function flash(b) {
    b.classList.add("pressed");
    setTimeout(() => b.classList.remove("pressed"), 120);
  }

  function report(err) {
    statusEl.textContent = err && err.message ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);
    statusEl.className = "";
  }

  async function press(b) {
    if (!pc) return;
    const name = b.dataset.name;
    flash(b);
    if (MODIFIERS.has(name)) {
      held[name] = !held[name];
      render();
      return;
    }
    if (name === "capslock") {
      caps = !caps;
      render();
      return;
    }
    const combo = ["ctrl", "alt", "win"].filter((m) => held[m]);
    try {
      if (combo.length) {
        // A shortcut, like Ctrl+C: the key's own name, with Shift if it's held.
        if (held.shift) combo.push("shift");
        await pc.key([...combo, name].join("+"), "tap");
      } else if (name.length === 1) {
        const shifted = isLetter(name) ? (held.shift !== caps ? name.toUpperCase() : name) : held.shift ? b.dataset.shifted || name : name;
        await pc.text(shifted);
      } else if (name === "space") {
        await pc.text(" ");
      } else {
        await pc.key(held.shift ? `shift+${name}` : name, "tap");
      }
    } catch (err) {
      report(err);
    }
    for (const m of Object.keys(held)) held[m] = false;
    render();
  }

  mouseBtn.addEventListener("mousedown", (e) => e.preventDefault());
  mouseBtn.addEventListener("click", () => pc && pc.toggleMouse());
  document.getElementById("hideBtn").addEventListener("click", () => pc && pc.setKeyboard(false));

  if (pc) {
    pc.start().catch(report); // get the input helper going now, so the first key isn't slow
    pc.onStatus((s) => {
      mouseBtn.classList.toggle("active", !!s.mouseOn);
      statusEl.textContent = s.note || (s.mouseOn ? "Hand mouse on" : "Hand mouse off");
      statusEl.className = s.mouseOn && s.hand ? "on" : "";
    });
  } else {
    statusEl.textContent = "Open this from the Hand Tracker app";
  }
  build();
})();
