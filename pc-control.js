/**
 * pc-control.js — controlling this computer with your hands (Windows and Linux app):
 *
 *  - Hand mouse: the pointer follows your palm; a quick curl of the index finger is a left
 *    click (curl and hold to drag), a quick curl of the middle finger a right click. Curl
 *    both (or make a fist) to hold the pointer still while you move your hand back to the
 *    middle. Keeps working with the app minimized; Ctrl+Alt+M turns it on and off anywhere.
 *  - Floating keyboard: an always-on-top keyboard to type into any app (keyboard.html),
 *    Ctrl+Alt+K.
 *  - Gesture actions: a gesture (with a given hand) presses keys, types text, clicks,
 *    scrolls or calls a web address; when it starts, when it starts and ends, repeatedly
 *    while held, or on every frame, after it's been held a moment. Adapted from the
 *    HandController in geaxgx/depthai_hand_tracker (MIT licence, see THIRD_PARTY_NOTICES.md).
 *
 *   PcControl.init({ desktop, prefs, setPref, gestureLabels, touch });   // touch: working a touchscreen
 *   PcControl.update(hands, gestureOf, mirrored);   // every frame
 */

(function (global) {
  const TRIGGERS = {
    enter: "when it starts",
    enter_leave: "when it starts and ends",
    periodic: "repeatedly while held",
    continuous: "on every frame",
  };
  // Action types: [label, category ("keyboard" | "mouse" | "web"), what the value field is]
  const ACTIONS = {
    keys: ["Press keys", "keyboard", "keys, e.g. ctrl+c, volumeup, space"],
    text: ["Type text", "keyboard", "text to type"],
    click: ["Left click", "mouse", null],
    right: ["Right click", "mouse", null],
    double: ["Double click", "mouse", null],
    middle: ["Middle click", "mouse", null],
    hold: ["Hold left button (drag)", "mouse", null],
    scrollUp: ["Scroll up", "mouse", null],
    scrollDown: ["Scroll down", "mouse", null],
    web: ["Web request", "web", "http(s):// address"],
  };
  const EXAMPLES = [
    { enabled: false, gesture: "Thumbs Up", hand: "any", action: "keys", value: "volumeup", method: "GET", trigger: "periodic", hold: 0.3, every: 0.25 },
    { enabled: false, gesture: "Thumbs Down", hand: "any", action: "keys", value: "volumedown", method: "GET", trigger: "periodic", hold: 0.3, every: 0.25 },
    { enabled: false, gesture: "Fist", hand: "any", action: "keys", value: "playpause", method: "GET", trigger: "enter", hold: 0.6, every: 1 },
  ];
  const MAX_MISSING_FRAMES = 3; // brief misreadings don't end a held gesture

  let desktop = null, prefs = {}, setPref = () => {}, gestureLabels = [];
  let touch = false; // the pointer works a touchscreen (the phone itself, phone-control.js)
  let els = {};
  let started = null; // pc.start() promise
  const log = [];

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const errText = (err) => (err && err.message ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  function note(text) {
    log.unshift(`${new Date().toLocaleTimeString()} ${text}`);
    log.length = Math.min(log.length, 4);
    if (els.log) els.log.textContent = log.join("\n");
  }
  function ensureStarted() {
    if (!started) {
      started = desktop.pc.start().catch((err) => {
        started = null;
        throw err;
      });
    }
    return started;
  }
  function setToggle(btn, on, label) {
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.firstChild.textContent = `${label}: ${on ? "ON" : "OFF"}`;
  }

  // Hand geometry in the picture's real proportions, in palm lengths (as in app.js).
  function geometry(hand, aspect) {
    const p = hand.imageLandmarks.map((q) => ({ x: q.x * aspect, y: q.y }));
    const d = (i, j) => Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y);
    const palm = d(0, 9) || 1e-6;
    return { reach: (i) => d(0, i) / palm };
  }

  // ---------- Hand mouse ----------
  // Double exponential smoothing with a jitter radius (after the DoubleExpFilter in
  // geaxgx/depthai_hand_tracker's mouse example): moves smaller than the radius are damped
  // hard, so a still hand keeps the pointer still; bigger ones pass through.
  function pointerFilter({ smoothing = 0.35, correction = 0.3, prediction = 0.1, jitter = 0.012, maxDeviation = 0.05 } = {}) {
    let count = 0, filtered = null, trend = null, raw = null;
    return {
      reset() {
        count = 0;
      },
      update(pos) {
        let f, t;
        if (count === 0) {
          f = pos;
          t = [0, 0];
        } else if (count === 1) {
          f = [(pos[0] + raw[0]) / 2, (pos[1] + raw[1]) / 2];
          t = [(f[0] - filtered[0]) * correction + trend[0] * (1 - correction), (f[1] - filtered[1]) * correction + trend[1] * (1 - correction)];
        } else {
          const dx = pos[0] - filtered[0], dy = pos[1] - filtered[1];
          const len = Math.hypot(dx, dy);
          const a = len <= jitter ? Math.pow(len / jitter, 1.5) : 1;
          f = [pos[0] * a + filtered[0] * (1 - a), pos[1] * a + filtered[1] * (1 - a)];
          f = [f[0] * (1 - smoothing) + smoothing * (filtered[0] + trend[0]), f[1] * (1 - smoothing) + smoothing * (filtered[1] + trend[1])];
          t = [correction * (f[0] - filtered[0]) + (1 - correction) * trend[0], correction * (f[1] - filtered[1]) + (1 - correction) * trend[1]];
        }
        count = Math.min(count + 1, 2);
        let out = [f[0] + prediction * t[0], f[1] + prediction * t[1]];
        const dev = Math.hypot(out[0] - pos[0], out[1] - pos[1]);
        if (dev > maxDeviation) {
          const k = maxDeviation / dev;
          out = [out[0] * k + pos[0] * (1 - k), out[1] * k + pos[1] * (1 - k)];
        }
        raw = pos;
        filtered = f;
        trend = t;
        return out;
      },
    };
  }

  const TAP_MS = 450; // a curl shorter than this is a click; an index curl held longer drags
  const TOUCH_DRAG = 0.04; // on a touchscreen, moving this far (of the screen) with the index curled drags
  const mouse = {
    on: false,
    side: null, // the hand being followed
    lastSeen: 0,
    filter: pointerFilter(),
    last: null, // last pointer sent [nx, ny]
    freezeUntil: 0,
    dragging: false,
    fingers: { index: null, middle: null }, // { base, curled, since, cancelled }
  };

  // A finger's curl, from how far its tip reaches compared with its usual straight reach
  // (learned while it's straight), so it adapts to each hand and camera angle. A quick
  // "click" only bends the finger a little: in recorded clicks the tip came back to 74-84%
  // of its straight reach, so that's what counts as curled.
  function fingerState(f, reach, now) {
    const st = mouse.fingers[f] || (mouse.fingers[f] = { base: reach, curled: false, since: 0, cancelled: false });
    // Follows the straight finger: quickly when it reaches further, slowly when less, so the
    // start of a bend doesn't pull it down with it.
    if (!st.curled) st.base += (reach - st.base) * (reach > st.base ? 0.1 : 0.03);
    st.base = Math.max(st.base, 1.0);
    const wasCurled = st.curled;
    if (!st.curled && reach < 0.84 * st.base) {
      st.curled = true;
      st.since = now;
      st.cancelled = false;
    } else if (st.curled && reach > 0.92 * st.base) {
      st.curled = false;
    }
    return { st, started: !wasCurled && st.curled, ended: wasCurled && !st.curled };
  }

  function mouseStatus(noteText) {
    const s = { mouseOn: mouse.on, hand: mouse.on ? mouse.side : null, dragging: mouse.dragging, note: noteText };
    desktop.pc.status(s);
    if (els.mouseStatus) els.mouseStatus.textContent = noteText;
  }

  function pickHand(hands, now) {
    const want = els.mouseHand.value;
    const candidates = hands.filter((h) => want === "either" || h.handedness === want);
    if (!candidates.length) return null;
    if (want === "either") {
      const same = candidates.find((h) => h.handedness === mouse.side);
      if (same) return same;
      if (mouse.side && now - mouse.lastSeen < 500) return null; // the followed hand blinked out
    }
    return candidates[0];
  }

  function updateMouse(hands, mirrored, aspect, now) {
    const hand = pickHand(hands, now);
    if (!hand) {
      if (mouse.side && now - mouse.lastSeen > 600) {
        if (mouse.dragging) release();
        mouse.side = null;
        mouse.filter.reset();
        mouse.fingers = { index: null, middle: null };
        mouseStatus(`Hand mouse on: show your ${els.mouseHand.value === "either" ? "" : els.mouseHand.value.toLowerCase() + " "}hand to the camera`);
      }
      return;
    }
    if (mouse.side !== hand.handedness) {
      mouse.side = hand.handedness;
      mouse.filter.reset();
      mouse.fingers = { index: null, middle: null };
    }
    mouse.lastSeen = now;
    const g = geometry(hand, aspect);
    const index = fingerState("index", g.reach(8), now);
    const middle = fingerState("middle", g.reach(12), now);
    // Both curled (or a fist): hold the pointer still, no clicks.
    const clutch = index.st.curled && middle.st.curled;
    if (clutch) {
      index.st.cancelled = true;
      middle.st.cancelled = true;
    }

    // The pointer follows the palm's centre (it hardly moves when a finger curls), within a
    // box in the middle of the picture, mapped to the whole screen. On a touchscreen the box
    // goes with your hand: pushed past an edge it slides along, and with a fist it moves
    // with the hand (the pointer stays), so every part of the screen is in reach from
    // wherever your hand is in the picture.
    const lm = hand.imageLandmarks;
    const cx = [0, 5, 9, 13, 17].reduce((s, i) => s + lm[i].x, 0) / 5;
    const cy = [0, 5, 9, 13, 17].reduce((s, i) => s + lm[i].y, 0) / 5;
    const x = mirrored ? 1 - cx : cx; // move your hand right, the pointer goes right
    const span = Number(els.mouseReach.value) || 0.55;
    const clamp = (v) => Math.min(1, Math.max(0, v));
    if (!mouse.box || mouse.box.span !== span) mouse.box = { x: 0.5 - span / 2, y: 0.45 - span / 2, span };
    if (touch && clutch && mouse.last) {
      mouse.box.x = x - mouse.last[0] * span;
      mouse.box.y = cy - mouse.last[1] * span;
    } else if (touch) {
      mouse.box.x = Math.min(Math.max(mouse.box.x, x - span), x);
      mouse.box.y = Math.min(Math.max(mouse.box.y, cy - span), cy);
    }
    const nx = clamp((x - mouse.box.x) / span);
    const ny = clamp((cy - mouse.box.y) / span);

    if (index.started || middle.started) mouse.freezeUntil = Infinity; // clicks land where the pointer was
    if (index.started) index.st.at = [x, cy];
    // Left: a quick curl clicks; held, it drags (button down until the finger straightens).
    // On a touchscreen a press held still is a long press, so there a curl is a tap however
    // long it's held, and drags once the hand moves with the finger curled.
    const drag = touch ? !!index.st.at && Math.hypot(x - index.st.at[0], cy - index.st.at[1]) / span > TOUCH_DRAG : now - index.st.since > TAP_MS;
    if (index.st.curled && !index.st.cancelled && !mouse.dragging && drag) {
      mouse.dragging = true;
      mouse.freezeUntil = 0;
      desktop.pc.button("left", "down").catch((err) => note(errText(err)));
    }
    if (index.ended) {
      if (mouse.dragging) release();
      else if (!index.st.cancelled && (touch || now - index.st.since <= TAP_MS)) desktop.pc.button("left", "click").catch((err) => note(errText(err)));
      mouse.freezeUntil = now + 150;
    }
    if (middle.ended) {
      if (!middle.st.cancelled && now - middle.st.since <= TAP_MS * 1.4) desktop.pc.button("right", "click").catch((err) => note(errText(err)));
      mouse.freezeUntil = now + 150;
    }
    if (!index.st.curled && !middle.st.curled && mouse.freezeUntil === Infinity) mouse.freezeUntil = now + 150;

    if (clutch || now < mouse.freezeUntil) {
      mouse.filter.reset(); // pick up from wherever the hand is when it moves again
    } else {
      const [fx, fy] = mouse.filter.update([nx, ny]);
      const p = [clamp(fx), clamp(fy)];
      if (!mouse.last || Math.hypot(p[0] - mouse.last[0], p[1] - mouse.last[1]) > 0.0005) {
        mouse.last = p;
        desktop.pc.pointer(p[0], p[1], els.mouseScreen.value);
      }
    }
    const state = clutch ? "holding still" : mouse.dragging ? "dragging" : "following";
    mouseStatus(`Hand mouse on: ${state} your ${hand.handedness.toLowerCase()} hand`);
  }

  function release() {
    mouse.dragging = false;
    desktop.pc.button("left", "up").catch((err) => note(errText(err)));
  }

  function setMouse(on) {
    if (on === mouse.on) return;
    if (on) {
      ensureStarted()
        .then(() => {
          mouse.on = true;
          mouse.side = null;
          mouse.filter.reset();
          setToggle(els.mouseToggle, true, "Hand mouse");
          mouseStatus("Hand mouse on: show your hand to the camera");
          note("Hand mouse on");
        })
        .catch((err) => {
          note(`Hand mouse: ${errText(err)}`);
          mouseStatus(errText(err));
        });
      return;
    }
    if (mouse.dragging) release();
    mouse.on = false;
    mouse.side = null;
    setToggle(els.mouseToggle, false, "Hand mouse");
    mouseStatus("Hand mouse off");
    note("Hand mouse off");
  }

  // ---------- Gesture actions ----------
  let rules = [];
  let actionsOn = false;
  const allow = { keyboard: true, mouse: true, web: true };
  const ruleState = new WeakMap(); // rule -> { present, since, missing, triggered, lastFire, hand }

  function saveRules() {
    setPref("gestureActions", { on: actionsOn, allow, rules });
  }

  async function run(rule, phase, hand) {
    const [label, category] = ACTIONS[rule.action] || [];
    if (!label || !allow[category]) return;
    const who = `${rule.gesture}${hand ? ` (${hand.handedness.toLowerCase()})` : ""}`;
    try {
      await ensureStarted();
      switch (rule.action) {
        case "keys":
          // Start and end: keys held down while the gesture lasts.
          await desktop.pc.key(rule.value, rule.trigger === "enter_leave" ? (phase === "leave" ? "up" : "down") : "tap");
          break;
        case "text":
          if (phase !== "leave") await desktop.pc.text(rule.value);
          break;
        case "hold":
          await desktop.pc.button("left", phase === "leave" ? "up" : "down");
          break;
        case "scrollUp":
        case "scrollDown":
          if (phase !== "leave") await desktop.pc.wheel(rule.action === "scrollUp" ? 1 : -1);
          break;
        case "web": {
          const body = { gesture: rule.gesture, hand: hand ? hand.handedness : null, phase, time: new Date().toISOString() };
          const res = await desktop.pc.web({ url: rule.value, method: rule.method || "GET", body });
          if (rule.trigger !== "continuous") note(`${who} → ${rule.method || "GET"} ${rule.value}: ${res.status}`);
          return;
        }
        default:
          if (phase !== "leave") await desktop.pc.button(rule.action === "right" ? "right" : rule.action === "middle" ? "middle" : "left", rule.action === "double" ? "double" : "click");
      }
      if (rule.trigger !== "continuous") note(`${who} → ${label}${rule.value && category === "keyboard" ? ` ${rule.value}` : ""}${phase === "leave" ? " (end)" : ""}`);
    } catch (err) {
      note(`${who}: ${errText(err)}`);
    }
  }

  function updateActions(hands, gestureOf, now) {
    for (const rule of rules) {
      if (!rule.enabled) continue;
      let st = ruleState.get(rule);
      if (!st) ruleState.set(rule, (st = { present: false, since: 0, missing: 0, triggered: false, lastFire: 0, hand: null }));
      const hand = hands.find((h) => gestureOf(h).label === rule.gesture && (rule.hand === "any" || h.handedness === rule.hand));
      if (hand) {
        st.missing = 0;
        st.hand = hand;
        if (!st.present) {
          st.present = true;
          st.since = now;
        }
        const holdMs = Math.max(0, Number(rule.hold) || 0) * 1000;
        if (!st.triggered && now - st.since >= holdMs) {
          st.triggered = true;
          st.lastFire = now;
          run(rule, "enter", hand);
        } else if (st.triggered && rule.trigger === "continuous") {
          run(rule, "repeat", hand);
        } else if (st.triggered && rule.trigger === "periodic" && now - st.lastFire >= Math.max(0.05, Number(rule.every) || 0.5) * 1000) {
          st.lastFire = now;
          run(rule, "repeat", hand);
        }
      } else if (st.present && ++st.missing > MAX_MISSING_FRAMES) {
        const needsEnd = st.triggered && (rule.trigger === "enter_leave" || rule.action === "hold");
        st.present = false;
        st.triggered = false;
        if (needsEnd) run(rule, "leave", st.hand);
      }
    }
  }

  // Ends every held gesture (keys and buttons held down are let go).
  function endAll() {
    for (const rule of rules) {
      const st = ruleState.get(rule);
      if (st && st.present && st.triggered && (rule.trigger === "enter_leave" || rule.action === "hold")) run(rule, "leave", st.hand);
      ruleState.delete(rule);
    }
  }

  function renderRules() {
    const list = els.list;
    list.innerHTML = "";
    if (!rules.length) {
      list.innerHTML = '<div class="note">No actions yet. Add one, pick a gesture and what it does.</div>';
      return;
    }
    rules.forEach((rule, i) => {
      const row = document.createElement("div");
      row.className = "action-row";
      const opt = (values, current) => values.map(([v, l]) => `<option value="${v}"${v === current ? " selected" : ""}>${l}</option>`).join("");
      const [, , valueHint] = ACTIONS[rule.action] || [];
      const esc = (v) => String(v === undefined || v === null ? "" : v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
      row.innerHTML = `
        <label title="On or off"><input type="checkbox" data-f="enabled"${rule.enabled ? " checked" : ""} /></label>
        <select data-f="gesture" title="Gesture">${opt(gestureLabels.map((g) => [g, g]), rule.gesture)}</select>
        <select data-f="hand" title="Which hand">${opt([["any", "either hand"], ["Right", "right hand"], ["Left", "left hand"]], rule.hand)}</select>
        <select data-f="action" title="What it does">${opt(Object.entries(ACTIONS).map(([k, [l]]) => [k, l]), rule.action)}</select>
        ${rule.action === "web" ? `<select data-f="method" title="Request method">${opt([["GET", "GET"], ["POST", "POST"], ["PUT", "PUT"]], rule.method || "GET")}</select>` : ""}
        ${valueHint ? `<input type="text" data-f="value" placeholder="${valueHint}" value="${esc(rule.value)}" spellcheck="false" autocomplete="off" />` : ""}
        <select data-f="trigger" title="When">${opt(Object.entries(TRIGGERS), rule.trigger)}</select>
        <label title="How long the gesture must be held first (seconds)">after <input type="number" data-f="hold" min="0" max="10" step="0.1" value="${esc(rule.hold)}" /> s</label>
        ${rule.trigger === "periodic" ? `<label title="How often while held (seconds)">every <input type="number" data-f="every" min="0.05" max="60" step="0.05" value="${esc(rule.every)}" /> s</label>` : ""}
        <button data-remove title="Remove this action">✕</button>`;
      row.addEventListener("change", (e) => {
        const f = e.target.dataset.f;
        if (!f) return;
        const before = ruleState.get(rule);
        if (before && before.present && before.triggered && (rule.trigger === "enter_leave" || rule.action === "hold")) run(rule, "leave", before.hand);
        ruleState.delete(rule);
        rule[f] = e.target.type === "checkbox" ? e.target.checked : e.target.type === "number" ? Number(e.target.value) : e.target.value;
        saveRules();
        if (f === "action" || f === "trigger") renderRules();
      });
      row.querySelector("[data-remove]").addEventListener("click", () => {
        const st = ruleState.get(rule);
        if (st && st.present && st.triggered && (rule.trigger === "enter_leave" || rule.action === "hold")) run(rule, "leave", st.hand);
        rules.splice(i, 1);
        saveRules();
        renderRules();
      });
      list.appendChild(row);
    });
  }

  function applyActionsToggle() {
    setToggle(els.actionsToggle, actionsOn, "Gesture actions");
    for (const k of Object.keys(allow)) els[`allow_${k}`].checked = allow[k];
  }

  // ---------- setup ----------
  function init(opts) {
    desktop = opts.desktop;
    prefs = opts.prefs;
    setPref = opts.setPref;
    gestureLabels = opts.gestureLabels;
    touch = opts.touch === true;
    const card = $("pcCard");
    if (!desktop || !desktop.pc || !card) return false;
    card.hidden = false;
    els = {
      mouseToggle: $("mouseToggle"), mouseHand: $("mouseHand"), mouseScreen: $("mouseScreen"), mouseReach: $("mouseReach"),
      mouseStatus: $("mouseStatus"), keyboardToggle: $("keyboardToggle"), actionsToggle: $("actionsToggle"),
      allow_keyboard: $("allowKeys"), allow_mouse: $("allowMouse"), allow_web: $("allowWeb"),
      list: $("actionList"), log: $("actionLog"), add: $("addAction"),
    };
    const saved = prefs.handMouse || {};
    if (saved.hand) els.mouseHand.value = saved.hand;
    if (saved.screen) els.mouseScreen.value = saved.screen;
    if (saved.reach) els.mouseReach.value = saved.reach;
    const saveMouse = () => setPref("handMouse", { hand: els.mouseHand.value, screen: els.mouseScreen.value, reach: els.mouseReach.value });
    for (const el of [els.mouseHand, els.mouseScreen, els.mouseReach]) el.addEventListener("change", saveMouse);
    els.mouseToggle.addEventListener("click", () => setMouse(!mouse.on));
    desktop.pc.onToggleMouse(() => setMouse(!mouse.on));

    let keyboardShown = false;
    const showKeyboard = (shown) => {
      keyboardShown = shown;
      setToggle(els.keyboardToggle, shown, "Floating keyboard");
    };
    els.keyboardToggle.addEventListener("click", () => {
      desktop.pc.setKeyboard(!keyboardShown).catch((err) => note(errText(err)));
      if (!keyboardShown) ensureStarted().catch((err) => note(`Keyboard: ${errText(err)}`));
    });
    desktop.pc.onKeyboard((shown) => {
      showKeyboard(shown);
      if (shown) setTimeout(() => mouseStatus(mouse.on ? (els.mouseStatus.textContent || "Hand mouse on") : "Hand mouse off"), 500);
    });

    const saved2 = prefs.gestureActions || {};
    rules = Array.isArray(saved2.rules) ? saved2.rules.filter((r) => r && ACTIONS[r.action]) : EXAMPLES.map((r) => ({ ...r }));
    actionsOn = saved2.on === true;
    Object.assign(allow, saved2.allow || {});
    els.actionsToggle.addEventListener("click", () => {
      actionsOn = !actionsOn;
      if (!actionsOn) endAll();
      else ensureStarted().catch((err) => note(`Gesture actions: ${errText(err)}`));
      saveRules();
      applyActionsToggle();
    });
    for (const k of Object.keys(allow)) {
      els[`allow_${k}`].addEventListener("change", (e) => {
        if (!e.target.checked) endAll();
        allow[k] = e.target.checked;
        saveRules();
      });
    }
    els.add.addEventListener("click", () => {
      rules.push({ enabled: true, gesture: gestureLabels[0], hand: "any", action: "keys", value: "", method: "GET", trigger: "enter", hold: 0.3, every: 0.5 });
      saveRules();
      renderRules();
    });
    applyActionsToggle();
    renderRules();
    setToggle(els.mouseToggle, false, "Hand mouse");
    showKeyboard(false);
    return true;
  }

  function update(hands, gestureOf, mirrored, aspect) {
    if (!desktop || !desktop.pc) return;
    const now = performance.now();
    if (mouse.on) updateMouse(hands, mirrored, aspect, now);
    if (actionsOn) updateActions(hands, gestureOf, now);
  }

  global.PcControl = {
    init,
    update,
    setMouse,
    isMouseOn: () => mouse.on,
    // For the checks.
    _state: () => ({ mouse: { on: mouse.on, side: mouse.side, dragging: mouse.dragging, last: mouse.last }, actionsOn, rules, allow }),
    // The checks swap in a stand-in for desktop.pc, so nothing reaches the real mouse or keyboard.
    _setDesktop: (d) => {
      desktop = d;
      started = null;
    },
    _setRules: (list, on = true) => {
      endAll();
      rules = list;
      actionsOn = on;
      renderRules();
    },
  };
})(window);
