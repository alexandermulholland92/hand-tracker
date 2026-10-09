/**
 * pc-control.js — controlling this computer with your hands (Windows, Mac and Linux app):
 * or, instead of it, an iPhone or iPad this computer (or the Android app's phone) is a
 * Bluetooth mouse and keyboard for (hid-core.js), or on a Mac the iPhone in iPhone
 * Mirroring's window:
 *
 *  - Hand mouse: the pointer follows your palm; a quick curl of the index finger is a left
 *    click, curled and moved straight away it swipes (scrolls what's under the pointer, as a
 *    finger does on a touchscreen), curled and held still a moment it drags; a quick curl of
 *    the middle finger is a right click. Curl both (or make a fist) to hold the pointer still
 *    while you move your hand back to the middle. On a touchscreen (a phone), a flick of the
 *    open hand up or down swipes the page that way. Keeps working with the app minimized;
 *    Ctrl+Alt+M turns it on and off anywhere.
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
  const TOUCH_DRAG = 0.04; // moving this far (of the hand's box) with the index curled swipes
  const SWIPE_NOTCHES = 10; // a swipe's wheel notches for a hand movement across the whole box (about a screen)
  // A flick, on a touchscreen: the open hand moved at least `min` of its box, at `speed` boxes a
  // second or more (well above moving the pointer briskly), mostly up or down, within windowMs,
  // swipes the page that way. The hand must slow below `rest` before the next one, and one the
  // other way within oppositeMs is the hand coming back, not a flick.
  const FLICK = { windowMs: 250, min: 0.2, speed: 2.5, rest: 0.5, oppositeMs: 800, strokeMs: 120 };
  const mouse = {
    on: false,
    side: null, // the hand being followed
    lastSeen: 0,
    filter: pointerFilter(),
    // While dragging (a swipe, on a touchscreen): small moves aren't held back (a slow swipe
    // moves the page all the way), and when the hand stops the pointer runs on past it only a
    // little (otherwise up to 5% of the screen: the swipe went on after the hand stopped).
    dragFilter: pointerFilter({ jitter: 0.004, maxDeviation: 0.02 }),
    last: null, // last pointer sent [nx, ny]
    freezeUntil: 0,
    dragging: false,
    swipe: null, // a swipe under way: { y, acc, trail }
    flick: { trail: [], pointers: [], resting: true, last: null, shown: null }, // flicks (touchscreens)
    glide: 0, // the swipe's glide once let go (its timer)
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
        stopSwipe();
        mouse.flick.trail = [];
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
      stopSwipe();
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
    if (index.started) {
      index.st.at = [x, cy];
      stopGlide();
    }
    // Left: a quick curl clicks. Moved straight away with the finger curled, it swipes: on a
    // touchscreen a drag (the finger's own swipe); on a computer the wheel scrolls what's under
    // the pointer as the hand moves, and glides on when let go while moving. Held still a
    // moment first (a computer), it drags: the button down until the finger straightens. (On a
    // touchscreen a press held still is a long press, so there a curl is a tap however long.)
    const moved = !!index.st.at && Math.hypot(x - index.st.at[0], cy - index.st.at[1]) / span > TOUCH_DRAG;
    if (index.st.curled && !index.st.cancelled && !mouse.dragging && !mouse.swipe) {
      if (!touch && moved) {
        mouse.swipe = { y: cy, acc: 0, trail: [[now, cy]] };
        mouse.freezeUntil = 0;
      } else if (touch ? moved : now - index.st.since > TAP_MS) {
        mouse.dragging = true;
        mouse.freezeUntil = 0;
        mouse.dragFilter.reset();
        desktop.pc.button("left", "down").catch((err) => note(errText(err)));
      }
    }
    if (mouse.swipe) swipeMove(cy, span, now);
    if (touch) flickCheck(x, cy, span, now, !index.st.curled && !middle.st.curled && !mouse.dragging);
    if (index.ended) {
      if (mouse.dragging) release();
      else if (mouse.swipe) swipeEnd(span, now);
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
      const [fx, fy] = (mouse.dragging ? mouse.dragFilter : mouse.filter).update([nx, ny]);
      const p = [clamp(fx), clamp(fy)];
      if (!mouse.last || Math.hypot(p[0] - mouse.last[0], p[1] - mouse.last[1]) > 0.0005) {
        mouse.last = p;
        desktop.pc.pointer(p[0], p[1], els.mouseScreen.value);
        if (touch) {
          const ps = mouse.flick.pointers;
          ps.push([now, p[0], p[1]]);
          while (ps.length > 2 && now - ps[0][0] > 600) ps.shift();
        }
      }
    }
    const flicked = mouse.flick.shown && now - mouse.flick.shown.at < 700 ? `flicked ${mouse.flick.shown.dir} with` : "";
    const state = clutch ? "holding still" : mouse.dragging ? "dragging" : mouse.swipe ? "scrolling with" : flicked || "following";
    mouseStatus(`Hand mouse on: ${state} your ${hand.handedness.toLowerCase()} hand`);
  }

  function release() {
    mouse.dragging = false;
    desktop.pc.button("left", "up").catch((err) => note(errText(err)));
  }

  // A swipe on a computer: the hand's movement up and down, as wheel notches (whole ones, the
  // rest kept for the next), the page moving with the hand (up scrolls down, as on a phone).
  const wheel = (n) => desktop.pc.wheel(n).catch((err) => note(errText(err)));
  function swipeMove(cy, span, now) {
    const s = mouse.swipe;
    s.acc += ((cy - s.y) / span) * SWIPE_NOTCHES;
    s.y = cy;
    s.trail.push([now, cy]);
    while (s.trail.length > 2 && now - s.trail[0][0] > 150) s.trail.shift();
    const n = Math.trunc(s.acc);
    if (n) {
      s.acc -= n;
      wheel(n);
    }
  }
  // Let go while moving, it glides on and slows down (the hand's speed over its last moment).
  function swipeEnd(span, now) {
    const s = mouse.swipe;
    mouse.swipe = null;
    const [t0, y0] = s.trail[0];
    let v = now > t0 ? (((s.y - y0) / span) * SWIPE_NOTCHES) / (now - t0) : 0; // notches a millisecond
    if (Math.abs(v) < 0.012) return;
    let acc = s.acc, last = performance.now();
    stopGlide();
    mouse.glide = setInterval(() => {
      const t = performance.now(), ms = t - last;
      last = t;
      acc += v * ms;
      v *= Math.pow(0.996, ms);
      const n = Math.trunc(acc);
      if (n) {
        acc -= n;
        wheel(n);
      }
      if (Math.abs(v) < 0.004) stopGlide();
    }, 30);
  }
  // A flick (touchscreens): the open hand moved quickly up or down. The page is swiped that
  // way from where the pointer was as the flick began (the pointer itself moves with the hand
  // as usual), further for a quicker flick, as a finger's quick swipe (the page flies on).
  function flickCheck(x, cy, span, now, open) {
    const f = mouse.flick;
    const at = [now, x / span, cy / span];
    if (!open || !desktop.pc.swipe) {
      f.trail = [at];
      return;
    }
    f.trail.push(at);
    while (f.trail.length > 2 && now - f.trail[0][0] > FLICK.windowMs) f.trail.shift();
    // Resting: hardly moving over about the last tenth of a second.
    const recent = f.trail.find((p) => now - p[0] <= 120) || f.trail[0];
    const rdt = (now - recent[0]) / 1000;
    if (rdt >= 0.06 && Math.hypot(at[1] - recent[1], at[2] - recent[2]) / rdt < FLICK.rest) f.resting = true;
    if (!f.resting) return;
    // Far enough, quickly enough, from some moment of the last quarter second (the earliest that
    // is: a flick's whole length, without the stillness before it).
    let hit = null;
    for (const p of f.trail) {
      const dt = (now - p[0]) / 1000;
      if (dt < 0.06) break;
      const dx = at[1] - p[1], dy = at[2] - p[2];
      // ...and seen on its way there, not in one jump (the tracking losing the hand and finding it
      // somewhere else).
      const between = f.trail.some((q) => q[0] > p[0] && q[0] < now && (q[2] - p[2]) / dy >= 0.15 && (q[2] - p[2]) / dy <= 0.85);
      if (between && Math.abs(dy) >= FLICK.min && Math.abs(dy) / dt >= FLICK.speed && Math.abs(dy) >= 2 * Math.abs(dx)) {
        hit = { t0: p[0], dy, speed: Math.abs(dy) / dt };
        break;
      }
    }
    if (!hit) return;
    const { t0, dy, speed } = hit;
    const dir = dy < 0 ? "up" : "down";
    if (f.last && f.last.dir !== dir && now - f.last.at < FLICK.oppositeMs) return; // the hand coming back
    f.resting = false;
    f.last = f.shown = { dir, at: now };
    f.trail = [at];
    const before = f.pointers.filter((p) => p[0] <= t0).pop() || f.pointers[0] || [now, ...(mouse.last || [0.5, 0.5])];
    // A finger's stroke the flick's way (up: the finger moves up, the page with it), kept off
    // the screen's top and bottom edges (where the phone's own swipes start).
    const len = Math.min(0.5, 0.3 + 0.1 * (speed - FLICK.speed));
    let a = dir === "up" ? before[2] + len / 2 : before[2] - len / 2;
    let b = dir === "up" ? a - len : a + len;
    const shift = Math.max(0.15 - Math.min(a, b), 0) - Math.max(Math.max(a, b) - 0.85, 0);
    a += shift;
    b += shift;
    const sx = Math.min(0.9, Math.max(0.1, before[1]));
    desktop.pc.swipe(sx, a, sx, b, FLICK.strokeMs).catch((err) => note(errText(err)));
  }
  function stopGlide() {
    clearInterval(mouse.glide);
    mouse.glide = 0;
  }
  function stopSwipe() {
    mouse.swipe = null;
    stopGlide();
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
    stopSwipe();
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
    // A mouse action's "with keys" (shift, ctrl+shift...): held down around the click or scroll,
    // and for "Hold left button" while it's held.
    const mods = category === "mouse" && rule.mods ? String(rule.mods).trim() : "";
    try {
      await ensureStarted();
      if (mods && rule.action !== "hold" && phase !== "leave") {
        await desktop.pc.key(mods, "down");
        try {
          if (rule.action === "scrollUp" || rule.action === "scrollDown") await desktop.pc.wheel(rule.action === "scrollUp" ? 1 : -1);
          else await desktop.pc.button(rule.action === "right" ? "right" : rule.action === "middle" ? "middle" : "left", rule.action === "double" ? "double" : "click");
        } finally {
          await desktop.pc.key(mods, "up");
        }
        if (rule.trigger !== "continuous") note(`${who} → ${mods} + ${label}`);
        return;
      }
      switch (rule.action) {
        case "keys":
          // Start and end: keys held down while the gesture lasts.
          await desktop.pc.key(rule.value, rule.trigger === "enter_leave" ? (phase === "leave" ? "up" : "down") : "tap");
          break;
        case "text":
          if (phase !== "leave") await desktop.pc.text(rule.value);
          break;
        case "hold":
          if (phase === "leave") {
            try {
              await desktop.pc.button("left", "up");
            } finally {
              if (mods) await desktop.pc.key(mods, "up");
            }
          } else {
            if (mods) await desktop.pc.key(mods, "down");
            await desktop.pc.button("left", "down");
          }
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
        ${(ACTIONS[rule.action] || [])[1] === "mouse" ? `<input type="text" data-f="mods" class="mods" placeholder="with keys, e.g. shift" title="Keys held down with it, e.g. shift, ctrl or ctrl+shift (leave empty for none)" value="${esc(rule.mods)}" spellcheck="false" autocomplete="off" />` : ""}
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
    // A Mac: iPhone Mirroring's window can be the screen (its iPhone, worked from the Mac).
    if (desktop.pc.platform === "darwin" && !els.mouseScreen.querySelector('option[value="mirroring"]')) {
      els.mouseScreen.insertAdjacentHTML("beforeend", '<option value="mirroring">iPhone Mirroring window</option>');
    }
    if (saved.hand) els.mouseHand.value = saved.hand;
    if (saved.screen && els.mouseScreen.querySelector(`option[value="${saved.screen}"]`)) els.mouseScreen.value = saved.screen;
    if (saved.reach) els.mouseReach.value = saved.reach;
    const saveMouse = () => setPref("handMouse", { ...(prefs.handMouse || {}), hand: els.mouseHand.value, screen: els.mouseScreen.value, reach: els.mouseReach.value, ...deviceChoice() });
    for (const el of [els.mouseHand, els.mouseScreen, els.mouseReach]) el.addEventListener("change", saveMouse);
    setupDevice(saved, saveMouse);
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

  // ---------- an iPhone or iPad instead of this computer ----------
  // The computer apps and the Android app can be a Bluetooth mouse and keyboard for one (its
  // pointer needs AssistiveTouch on); a Mac can't, but its iPhone Mirroring window can be the
  // hand mouse's screen.
  const deviceEls = {};
  function deviceChoice() {
    if (!deviceEls.target) return {};
    return { target: deviceEls.target.value, deviceScreen: deviceEls.screen.value, deviceSpeed: deviceEls.speed.value };
  }
  function setupDevice(saved, saveMouse) {
    const pc = desktop.pc;
    const row = $("deviceRow");
    if (!row) return;
    Object.assign(deviceEls, { target: $("pcTarget"), screen: $("deviceScreen"), speed: $("deviceSpeed"), options: $("deviceOptions"), note: $("deviceNote"), visible: $("deviceVisible") });
    if (pc.platform === "darwin") {
      row.hidden = false;
      $("pcTargetLabel").hidden = true;
      const open = $("openMirroring");
      open.hidden = false;
      open.addEventListener("click", () => pc.openMirroring().catch((err) => note(errText(err))));
      deviceEls.note.hidden = false;
      deviceEls.note.textContent = "Your iPhone, worked from this Mac: open iPhone Mirroring (macOS 15 or later, with iOS 18), then choose Screen → iPhone Mirroring window. Your hand then moves the pointer over the iPhone in its window; a click is a tap.";
      return;
    }
    if (!pc.setTarget) return;
    row.hidden = false;
    if (pc.platform === "android") deviceEls.target.querySelector('option[value="computer"]').textContent = "the paired PC";
    deviceEls.target.value = saved.target === "device" ? "device" : "computer";
    if (saved.deviceScreen) deviceEls.screen.value = saved.deviceScreen;
    deviceEls.speed.value = saved.deviceSpeed || "1";
    if (!deviceEls.speed.value) deviceEls.speed.value = "1";
    const apply = () => {
      if (mouse.dragging) release();
      stopSwipe();
      endAll();
      started = null; // the next action starts what it now works
      const device = deviceEls.target.value === "device";
      deviceEls.options.hidden = !device;
      els.mouseScreen.parentElement.hidden = device;
      saveMouse();
      pc.setTarget({ target: deviceEls.target.value, screen: deviceEls.screen.value, speed: Number(deviceEls.speed.value) || 1 })
        .then(showDevice)
        .catch((err) => showDevice({ target: deviceEls.target.value, state: "error", message: errText(err) }));
    };
    for (const el of [deviceEls.target, deviceEls.screen, deviceEls.speed]) el.addEventListener("change", apply);
    if (pc.platform === "android" && pc.deviceVisible) {
      deviceEls.visible.hidden = false;
      deviceEls.visible.addEventListener("click", () => pc.deviceVisible().catch((err) => note(errText(err))));
    }
    pc.onTargetStatus(showDevice);
    apply();
  }
  function showDevice(s) {
    const n = deviceEls.note;
    if (!n) return;
    const device = s && s.target === "device";
    n.hidden = !device;
    if (!device) return;
    const where = desktop.pc.platform === "android" ? "this phone" : "this computer";
    const name = desktop.pc.platform === "android" ? "this phone's name" : "\u201cHand Tracker\u201d (or this computer's name)";
    n.textContent = {
      starting: "Starting Bluetooth…",
      waiting: `Waiting for your iPhone or iPad. On it: Settings → Bluetooth, tap ${name} under Other Devices (the first time; after that it connects by itself), and turn on Settings → Accessibility → Touch → AssistiveTouch for the pointer.`,
      connected: `Connected to ${s.device || "your device"}: the hand mouse, gesture actions${desktop.pc.platform === "android" ? "" : " and the floating keyboard"} work it now (a click is a tap; the right button opens AssistiveTouch's menu). Its keys for gesture actions include homescreen, search, onscreenkeyboard, cmd+space.`,
      error: `Can't be its Bluetooth mouse: ${s.message || "Bluetooth didn't start."}`,
      off: `Bluetooth is off on ${where}.`,
    }[s.state] || "";
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
