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
  // (Also put into other pages as it is, by the Chrome extension and the iPhone app's hand
  // browser: it uses nothing from outside itself.) With dragScrolls (the iPhone's hand browser,
  // a touchscreen), a left drag scrolls what's under the pointer, as a finger does, unless the
  // page takes the press itself (a map, a slider), and glides on when let go while moving.
  function pagePointer({ dragScrolls = false } = {}) {
    let el = null, x = 0, y = 0, held = null; // held: { which, target, pan } while a button is down
    let glide = 0, wheelTo = null; // a drag's glide (its timer); where the wheel's steps add up to
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
    const focus = (t) => {
      const f = focusable(t);
      if (f && f.focus) f.focus({ preventScroll: true });
    };
    // What scrolls along an axis ("x" or "y") at an element: the nearest that does, or the page.
    const scroller = (t, axis) => {
      for (let e = t; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (axis === "y" ? e.scrollHeight > e.clientHeight && /(auto|scroll)/.test(s.overflowY) : e.scrollWidth > e.clientWidth && /(auto|scroll)/.test(s.overflowX)) return e;
      }
      return window;
    };
    const scrollPos = (e) => (e === window ? [window.scrollX, window.scrollY] : [e.scrollLeft, e.scrollTop]);
    const scrollMax = (e) => {
      const d = document.scrollingElement || document.documentElement;
      return e === window ? [d.scrollWidth - window.innerWidth, d.scrollHeight - window.innerHeight] : [e.scrollWidth - e.clientWidth, e.scrollHeight - e.clientHeight];
    };
    const scrollTo = (e, left, top) => e.scrollTo({ left, top, behavior: "instant" });
    // The page has the press to itself: it stopped the pointerdown, or it's in a part that
    // doesn't pan (touch-action: none).
    const owned = (t, taken) => {
      if (taken) return true;
      for (let e = t; e && e.nodeType === 1; e = e.parentElement) if (/^(none|pinch-zoom)$/.test(getComputedStyle(e).touchAction || "")) return true;
      return false;
    };
    const SLOP = 10; // moved more than this (px) with the button down, it isn't a click
    function panMove(p, px = x, py = y) {
      const dx = px - p.x0, dy = py - p.y0;
      if (Math.hypot(dx, dy) > SLOP) p.moved = true;
      if (p.h === p.v) scrollTo(p.h, p.left0 - dx, p.top0 - dy);
      else {
        scrollTo(p.h, p.left0 - dx, scrollPos(p.h)[1]);
        scrollTo(p.v, scrollPos(p.v)[0], p.top0 - dy);
      }
      const now = performance.now();
      p.trail.push([now, px, py]);
      while (p.trail.length > 2 && now - p.trail[0][0] > 150) p.trail.shift();
    }
    function panEnd(p, px = x, py = y) {
      const now = performance.now(), [t0, x0, y0] = p.trail[0];
      let vx = now > t0 ? (px - x0) / (now - t0) : 0, vy = now > t0 ? (py - y0) / (now - t0) : 0; // px a millisecond
      if (Math.hypot(vx, vy) < 0.3) return;
      let left = scrollPos(p.h)[0], top = scrollPos(p.v)[1], last = now;
      const step = () => {
        const t = performance.now(), ms = Math.min(50, t - last);
        last = t;
        left -= vx * ms;
        top -= vy * ms;
        if (p.h === p.v) scrollTo(p.h, left, top);
        else {
          scrollTo(p.h, left, scrollPos(p.h)[1]);
          scrollTo(p.v, scrollPos(p.v)[0], top);
        }
        const k = Math.pow(0.997, ms);
        vx *= k;
        vy *= k;
        glide = Math.hypot(vx, vy) > 0.03 ? setTimeout(step, 16) : 0;
      };
      glide = setTimeout(step, 16); // (a timer: a page out of sight gets no animation frames)
    }
    function down(which) {
      const t = targetAt();
      clearTimeout(glide);
      held = { which, target: t };
      const taken = !fire(t, "pointerdown", which);
      fire(t, "mousedown", which);
      if (dragScrolls && which === "left" && !owned(t, taken)) {
        const h = scroller(t, "x"), v = scroller(t, "y");
        held.pan = { h, v, x0: x, y0: y, left0: scrollPos(h)[0], top0: scrollPos(v)[1], moved: false, trail: [[performance.now(), x, y]] };
      } else focus(t);
    }
    function up(which) {
      const t = targetAt();
      fire(t, "pointerup", which);
      fire(t, "mouseup", which);
      const pan = held && held.pan;
      const same = held && held.target === t;
      held = null;
      if (pan && pan.moved) return panEnd(pan); // a swipe, not a click
      if (pan) focus(t); // a tap: as a click, it focuses
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
        if (held && held.pan) panMove(held.pan);
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
      // A finger's quick swipe (a flick, with dragScrolls) from one place to another (shares of the
      // page) in ms: what's there scrolls with it and glides on. The pointer stays where it is.
      async swipe(nx1, ny1, nx2, ny2, ms = 120) {
        if (!dragScrolls) return;
        const at = (n, size) => Math.max(0, Math.min(size - 1, n * size));
        const x1 = at(nx1, innerWidth), y1 = at(ny1, innerHeight), x2 = at(nx2, innerWidth), y2 = at(ny2, innerHeight);
        const t = document.elementFromPoint(x1, y1) || document.body;
        clearTimeout(glide);
        const h = scroller(t, "x"), v = scroller(t, "y");
        const p = { h, v, x0: x1, y0: y1, left0: scrollPos(h)[0], top0: scrollPos(v)[1], moved: true, trail: [[performance.now(), x1, y1]] };
        for (let i = 1; i <= 4; i++) {
          await new Promise((r) => setTimeout(r, ms / 4));
          panMove(p, x1 + ((x2 - x1) * i) / 4, y1 + ((y2 - y1) * i) / 4);
        }
        panEnd(p, x2, y2);
      },
      async wheel(notches) {
        // Steps close together (a swipe's) add up, rather than each starting again from
        // wherever the last one's smooth scroll had got to.
        const e = scroller(targetAt(), "y"), now = performance.now();
        if (!wheelTo || wheelTo.e !== e || now - wheelTo.at > 400) wheelTo = { e, top: scrollPos(e)[1] };
        wheelTo.top = Math.max(0, Math.min(scrollMax(e)[1], wheelTo.top - notches * 100));
        wheelTo.at = now;
        e.scrollTo({ top: wheelTo.top, behavior: "smooth" });
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
