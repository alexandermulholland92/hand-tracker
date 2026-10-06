/**
 * web-pc.js — the website's hand mouse (pc-control.js's PC, for a browser), and the desktop
 * app's side of it.
 *
 * On the website the hand mouse moves either
 *  - this page's own pointer: a pointer drawn over the page that clicks, drags, scrolls and
 *    types into it (any browser, nothing to install), or
 *  - this computer's real pointer, through the Hand Tracker app running on it (minimized is
 *    fine) with "Let the website control this computer" on: the page sends its moves to the
 *    app at http://127.0.0.1:47823 (electron/web-link.js). A website can't move the real
 *    pointer itself; tracking keeps going with the page minimized (hand-tracker.js's
 *    steadyTimer), so this works while you use other windows.
 *
 *   const pc = WebPc.create({ prefs, setPref });   // the pc object pc-control.js takes (desktop.pc's shape)
 *   WebPc.initDesktop({ desktop, prefs, setPref }); // the app's "Let the website control this computer"
 */

(function (global) {
  const APP = "http://127.0.0.1:47823";
  const $ = (id) => document.getElementById(id);

  // ---------- this page's own pointer ----------
  function pagePointer() {
    let el = null, x = 0, y = 0, held = null; // held: { which, target } while a button is down
    const show = () => {
      if (el) return;
      el = document.createElement("div");
      el.id = "handPointer";
      el.setAttribute("aria-hidden", "true");
      document.body.appendChild(el);
    };
    const hide = () => {
      if (el) el.remove();
      el = null;
    };
    const targetAt = () => document.elementFromPoint(x, y) || document.body;
    const BUTTONS = { left: 0, middle: 1, right: 2 };
    const fire = (target, type, which, extra = {}) => {
      const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: BUTTONS[which] || 0, buttons: type.endsWith("down") || type.endsWith("move") ? 1 << (BUTTONS[which] || 0) : 0, view: window, ...extra };
      const ev = type.startsWith("pointer") ? new PointerEvent(type, { pointerId: 1, pointerType: "mouse", isPrimary: true, ...init }) : new MouseEvent(type, init);
      return target.dispatchEvent(ev);
    };
    const focusable = (t) => t.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], button, a[href], [tabindex]");
    function down(which) {
      const t = targetAt();
      held = { which, target: t };
      fire(t, "pointerdown", which);
      fire(t, "mousedown", which);
      const f = focusable(t);
      if (f && f.focus) f.focus({ preventScroll: true });
    }
    function up(which) {
      const t = targetAt();
      fire(t, "pointerup", which);
      fire(t, "mouseup", which);
      const same = held && held.target === t;
      held = null;
      if (!same) return;
      if (which === "right") fire(t, "contextmenu", which);
      else if (which === "left") {
        // The element's own click (links go, buttons press, boxes tick).
        if (typeof t.click === "function") t.click();
        else fire(t, "click", which);
      } else fire(t, "auxclick", which);
    }
    return {
      start: () => (show(), Promise.resolve()),
      stop: hide,
      pointer(nx, ny) {
        show();
        x = Math.max(0, Math.min(window.innerWidth - 1, nx * window.innerWidth));
        y = Math.max(0, Math.min(window.innerHeight - 1, ny * window.innerHeight));
        el.style.transform = `translate(${x}px, ${y}px)`;
        el.classList.toggle("down", !!held);
        const t = targetAt();
        fire(t, "pointermove", held ? held.which : "left");
        fire(t, "mousemove", held ? held.which : "left");
      },
      async button(which, action) {
        if (action === "down") return down(which);
        if (action === "up") return up(which);
        down(which);
        up(which);
        if (action === "double") {
          down(which);
          up(which);
          fire(targetAt(), "dblclick", which);
        }
      },
      async wheel(notches) {
        let t = targetAt();
        while (t && t !== document.body && !(t.scrollHeight > t.clientHeight && /(auto|scroll)/.test(getComputedStyle(t).overflowY))) t = t.parentElement;
        (t && t !== document.body ? t : window).scrollBy({ top: -notches * 100, behavior: "smooth" });
      },
      async key(combo, action = "tap") {
        if (action === "up") return;
        const t = document.activeElement || document.body;
        const k = String(combo).toLowerCase();
        const name = { enter: "Enter", tab: "Tab", backspace: "Backspace", escape: "Escape", esc: "Escape", space: " ", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" }[k] || combo;
        const editable = t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName));
        if (!t.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }))) return;
        if (editable && name === "Backspace") document.execCommand("delete");
        else if (editable && name === " ") document.execCommand("insertText", false, " ");
        else if (name === "Enter" && t.form && t.form.requestSubmit) t.form.requestSubmit();
        t.dispatchEvent(new KeyboardEvent("keyup", { key: name, bubbles: true }));
      },
      async text(text) {
        const t = document.activeElement;
        if (!t || !(t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName))) throw new Error("Click into a box on this page first, to type there.");
        document.execCommand("insertText", false, String(text));
      },
    };
  }

  // ---------- this computer's pointer, through the Hand Tracker app ----------
  function appPointer() {
    let sending = false, nextMove = null;
    const post = async (type, data) => {
      const res = await fetch(`${APP}/input`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, data }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `The Hand Tracker app answered ${res.status}.`);
      return body.result;
    };
    // Pointer moves come many times a second: only the latest is sent once the last arrived.
    const flush = () => {
      if (sending || !nextMove) return;
      const m = nextMove;
      nextMove = null;
      sending = true;
      post("pointer", m)
        .catch(() => {})
        .finally(() => {
          sending = false;
          flush();
        });
    };
    return {
      async start() {
        const res = await fetch(`${APP}/status`).catch(() => null);
        if (!res || !res.ok) throw new Error("The Hand Tracker app isn't answering: open it on this computer and turn on Control your PC → Let the website control this computer.");
      },
      stop() {},
      pointer(nx, ny, screen) {
        nextMove = { nx, ny, screen };
        flush();
      },
      button: (which, action) => post("button", { which, action }),
      wheel: (notches) => post("wheel", { notches: Math.round(notches) }),
      key: (combo, action) => post("key", { combo, action }),
      text: (text) => post("text", { text }),
      keyboard: (show) => post("keyboard", { show }).then((r) => !!(r && r.shown)),
    };
  }

  // ---------- the pc object pc-control.js takes ----------
  function create({ prefs, setPref }) {
    const targets = { page: pagePointer(), computer: appPointer() };
    const which = () => (prefs.webMouseTarget === "computer" ? "computer" : "page");
    let toggleMouse = () => {};
    let keyboardCb = () => {};
    const row = $("webMouseRow");
    if (row) {
      row.hidden = false;
      const select = $("webMouseTarget");
      select.value = which();
      select.addEventListener("change", () => {
        targets.page.stop();
        started.delete("page");
        setPref("webMouseTarget", select.value === "computer" ? "computer" : "page");
        note();
      });
      note();
    }
    function note(text) {
      const el = $("webMouseNote");
      if (!el) return;
      el.textContent = text || (which() === "computer"
        ? "Your hand moves this computer's own pointer, in any window, through the Hand Tracker app (open it, and turn on Control your PC → Let the website control this computer). It keeps working with this page minimized."
        : "Your hand moves a pointer over this page. To move this computer's own pointer in any window, choose “this computer” (it needs the Hand Tracker app).");
    }
    // Each target is started (the app found, the page's pointer drawn) the first time it's used:
    // the choice can change while the hand mouse is on.
    const started = new Map(); // "page" | "computer" -> its start's promise
    const use = () => {
      const w = which();
      if (!started.has(w)) {
        started.set(w, targets[w].start().then(() => note(), (err) => {
          started.delete(w);
          note(err.message);
          throw err;
        }));
      }
      return started.get(w).then(() => targets[w]);
    };
    return {
      start: () => use().then(() => {}),
      pointer: (nx, ny, screen) => {
        use().then((t) => t.pointer(nx, ny, screen)).catch(() => {});
      },
      button: (w, a) => use().then((t) => t.button(w, a)),
      wheel: (n) => use().then((t) => t.wheel(n)),
      key: (c, a) => use().then((t) => t.key(c, a)),
      text: (t) => use().then((x) => x.text(t)),
      web: () => Promise.reject(new Error("Web requests are in the Windows, Mac and Linux app and the Android app.")),
      // The floating keyboard is the app's: through it, with "Moves: this computer".
      setKeyboard: (show) =>
        which() === "computer"
          ? use().then((t) => t.keyboard(show)).then((shown) => (keyboardCb(shown), shown))
          : Promise.reject(new Error("The floating keyboard types into any window through the Hand Tracker app: choose Moves: this computer's pointer.")),
      onKeyboard: (cb) => (keyboardCb = cb),
      onToggleMouse: (cb) => (toggleMouse = cb),
      status: (s) => {
        if (s && s.mouseOn === false) {
          targets.page.stop();
          started.delete("page");
        }
      },
      _toggleMouse: () => toggleMouse(),
    };
  }

  // ---------- the desktop app: letting the website use it ----------
  function initDesktop({ desktop, prefs, setPref }) {
    const box = $("webLinkPc");
    if (!box || !desktop || !desktop.webLink) return;
    box.hidden = false;
    const btn = $("webLinkToggle");
    const show = (s) => {
      btn.classList.toggle("active", s.on);
      btn.setAttribute("aria-pressed", String(s.on));
      btn.textContent = `Let the website control this computer: ${s.on ? "ON" : "OFF"}`;
      const used = s.used ? ` Last used ${new Date(s.used.at).toLocaleTimeString()}.` : "";
      $("webLinkStatus").textContent = s.on ? `On https://hand-tracker.pages.dev, Control your PC → Moves: this computer.${used}` : "";
    };
    desktop.webLink.onStatus(show);
    btn.addEventListener("click", async () => {
      try {
        const s = await desktop.webLink.status();
        const next = s.on ? await desktop.webLink.stop() : await desktop.webLink.start();
        setPref("webLink", next.on);
        show(next);
      } catch (err) {
        $("webLinkStatus").textContent = `Couldn't turn it on: ${err.message || err}`;
      }
    });
    (prefs.webLink === true ? desktop.webLink.start() : desktop.webLink.status()).then(show).catch((err) => ($("webLinkStatus").textContent = String(err.message || err)));
  }

  global.WebPc = { create, initDesktop, _pagePointer: pagePointer };
})(window);
