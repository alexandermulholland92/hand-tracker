/**
 * phone-control.js — the Android app controlling the phone itself (phone-control.html, in
 * the small window PhoneControlService.java keeps over other apps): it tracks your hand
 * with the camera and runs the same hand mouse and gesture actions as the "Control your PC"
 * card (pc-control.js), but what they do happens on this phone, through the app's
 * accessibility service (HandControlService.java): the pointer is drawn over every app,
 * a click is a tap, a right click a long press, a drag a swipe, the wheel scrolls, keys are
 * Back, Home, Recents, volume, media and so on, and text goes into the text box in use.
 *
 * window.HandControl is the service's bridge (addJavascriptInterface); its calls return ""
 * or a reason it couldn't. Settings come from the page's address: ?settings=<JSON>
 *   { hand, reach, actionsOn, rules, allow, deviceId, mouse }
 */

(function (global) {
  const native = global.HandControl;
  const settings = (() => {
    try {
      return JSON.parse(new URLSearchParams(location.search).get("settings") || "{}");
    } catch {
      return {};
    }
  })();
  const message = document.getElementById("message");
  const show = (text) => {
    message.textContent = text;
    message.hidden = !text;
  };

  // desktop.pc, as pc-control.js uses it, carried out on this phone.
  const call = (fn, ...args) => {
    const err = native[fn](...args);
    if (err) throw new Error(err);
  };
  const pc = {
    start: async () => true,
    pointer: (nx, ny) => native.pointer(nx, ny),
    button: async (which, action) => call("button", String(which), String(action)),
    wheel: async (notches) => call("wheel", Number(notches) || 0),
    key: async (combo, action) => call("key", String(combo), String(action || "tap")),
    text: async (text) => call("text", String(text)),
    web: async (req) => {
      const r = JSON.parse(native.web(JSON.stringify(req || {})) || "{}");
      if (r.error) throw new Error(r.error);
      return { ok: r.status >= 200 && r.status < 300, status: r.status };
    },
    setKeyboard: async () => {
      throw new Error("On a phone, its own keyboard opens when you tap a text box.");
    },
    status: (s) => native.status(JSON.stringify(s || {})),
    onStatus: () => () => {},
    toggleMouse: () => {},
    onToggleMouse: () => () => {},
    onKeyboard: () => () => {},
  };

  async function start() {
    if (!native) return show("This page runs in the Android app's phone control window.");
    const prefs = {
      handMouse: { hand: settings.hand || "Right", reach: String(settings.reach || "0.55"), screen: "primary" },
      gestureActions: { rules: Array.isArray(settings.rules) ? settings.rules : [], on: settings.actionsOn === true, allow: settings.allow || {} },
    };
    global.PcControl.init({ desktop: { pc }, prefs, setPref: () => {}, gestureLabels: global.HandGestures.LABELS, touch: true });
    const gestures = global.HandGestures.create();
    // One hand, unless a gesture action is for the hand the mouse doesn't follow: while
    // fewer hands are found than it looks for, the tracker searches the whole picture again
    // on every frame, which halves how often it follows the hand.
    const mouseHand = prefs.handMouse.hand;
    const otherHand = prefs.gestureActions.on && mouseHand !== "either" &&
      prefs.gestureActions.rules.some((r) => r.enabled && (r.hand === "Left" || r.hand === "Right") && r.hand !== mouseHand);
    try {
      await global.HandTracker.init({
        videoEl: document.getElementById("video"),
        canvasEl: document.getElementById("stage"),
        overlay: true,
        mirror: true,
        maxNumHands: otherHand ? 2 : 1,
        modelComplexity: 0, // the Lite model: this runs alongside whatever app is in front
        deviceId: settings.deviceId || null,
        width: 640,
        height: 480,
      });
    } catch (err) {
      show(`The camera couldn't start: ${(err && err.message) || err}`);
      native.status(JSON.stringify({ error: String((err && err.message) || err) }));
      return;
    }
    show("");
    global.HandTracker.onHandLandmarks(({ hands }) => {
      gestures.update(hands);
      const cam = global.HandTracker.getCamera();
      global.PcControl.update(hands, gestures.of, global.HandTracker.isMirrored(), cam.width && cam.height ? cam.width / cam.height : 4 / 3);
    });
    if (settings.mouse !== false) global.PcControl.setMouse(true);
  }

  start();
  global.PhoneControl = { settings, _pc: pc };
})(window);
