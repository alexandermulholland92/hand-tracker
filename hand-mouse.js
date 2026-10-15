/**
 * hand-mouse.js — Hand Mouse (the hand-mouse-app branch): the Android app with only the hand
 * mouse. Each time it opens it asks what your hand should control, and starts it:
 *  - this phone: a pointer over every app (PhoneControlService.java's small window, running
 *    phone-control.js), once its two permissions are given;
 *  - a PC over Wi-Fi: paired from the PC's code (phone-link-ui.js), worked through mobile.pc;
 *  - an iPhone or iPad: this phone as its Bluetooth mouse (mobile.pc's "device" target, hid-core.js).
 * The hand mouse, its gestures and gesture actions are pc-control.js's, from the full app's
 * "Control your PC" card's controls (hand-mouse.html has them, with the same ids). Android's
 * Back (or ←) stops it and asks again.
 *
 *   HandMouse.init()   (on load; the checks call it again with a stand-in window.mobile)
 */

(function (global) {
  const $ = (id) => document.getElementById(id);
  const errText = (err) => (err && err.message ? err.message : String(err));
  const NAMES = { phone: "This phone", pc: "A PC", bluetooth: "Bluetooth mouse" };

  // Settings, kept as the full app keeps them: its "Control your PC" card's (handMouse, gestureActions).
  const PREFS_KEY = "hand-tracker:prefs";
  const prefs = (() => {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    } catch {
      return {};
    }
  })();
  function setPref(key, value) {
    prefs[key] = value;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {}
  }

  let mobile = null;
  let ready = null; // the tracker, set up (MediaPipe loaded) but with no camera yet
  let mode = null; // "phone" | "pc" | "bluetooth" while one runs
  let pcMouseStarted = false; // (a PC's hand mouse turned on once it's paired, not again after you turn it off)
  let cameraOn = false;
  const phone = { state: { overlay: false, accessibility: false, running: false }, askedAccessibility: false, autoStart: false };

  // ---------- the camera (a PC or a Bluetooth device; this phone's control has its own) ----------
  const stageMessage = (text, error = false) => {
    const m = $("stageMessage");
    m.textContent = text;
    m.className = error ? "error" : "";
    m.hidden = !text;
  };
  // Both hands only when a gesture action is for the hand the mouse doesn't follow: while fewer
  // hands are found than it looks for, the tracker searches the whole picture on every frame.
  function handsNeeded() {
    const mouseHand = (prefs.handMouse || {}).hand || "Right";
    const actions = prefs.gestureActions || {};
    const other = actions.on === true && mouseHand !== "either" &&
      (actions.rules || []).some((r) => r.enabled && (r.hand === "Left" || r.hand === "Right") && r.hand !== mouseHand);
    return other ? 2 : 1;
  }
  async function startCamera() {
    const forMode = mode;
    stageMessage("Starting the camera…");
    try {
      await ready;
      if (mode !== forMode) return false; // (left before the tracker was ready)
      global.HandTracker.setMaxHands(handsNeeded());
      await global.HandTracker.useCamera();
      if (mode !== forMode) {
        // Left while it started: let go of it, unless what's picked now wants it too.
        if (mode !== "pc" && mode !== "bluetooth") stopCamera();
        return false;
      }
      cameraOn = true;
      stageMessage("");
      return true;
    } catch (err) {
      const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
      stageMessage(denied ? "Hand Mouse needs the camera: allow it when Android asks (or in its App info → Permissions)." : `The camera couldn't start: ${errText(err)}`, true);
      return false;
    }
  }
  function stopCamera() {
    cameraOn = false;
    // (an "external" source has no camera: the camera's let go)
    return global.HandTracker.useExternalSource("Hand Mouse: off").catch(() => {});
  }

  // ---------- the hand mouse's target: the paired PC or the Bluetooth device ----------
  function setTarget(target) {
    const select = $("pcTarget");
    if (select.value === target) return;
    select.value = target;
    select.dispatchEvent(new Event("change")); // (pc-control.js starts or stops the Bluetooth mouse)
  }

  // ---------- this phone ----------
  function showPhone() {
    const s = phone.state;
    const done = (btn, ok, text) => {
      btn.textContent = ok ? `✓ ${text}` : text;
      btn.classList.toggle("active", ok);
    };
    done($("phoneOverlay"), s.overlay, "1. Allow display over other apps");
    done($("phoneAccess"), s.accessibility, "2. Turn on hand control in Accessibility");
    $("phoneStart").textContent = s.running ? "Stop controlling this phone" : "Start controlling this phone";
    $("phoneStart").disabled = !s.running && !(s.overlay && s.accessibility);
    $("phoneRestricted").hidden = !(phone.askedAccessibility && !s.accessibility && s.sdk >= 33);
    $("phoneStatus").textContent = s.running
      ? "Controlling this phone: switch to any app. The camera window's ×, Stop in the notification, or Back here ends it."
      : !s.overlay
        ? "First allow Hand Mouse to display over other apps (for the pointer and the camera window)."
        : !s.accessibility
          ? "Then turn on Hand Mouse's hand control in Accessibility, so it can tap, swipe and type. It starts as soon as it's on."
          : "Ready.";
  }
  async function startPhone() {
    const mouse = prefs.handMouse || {}, actions = prefs.gestureActions || {};
    const settings = {
      hand: mouse.hand || "Right", reach: mouse.reach || "0.55",
      actionsOn: actions.on === true, rules: actions.rules || [], allow: actions.allow || {},
      deviceId: null, // (the front camera)
    };
    try {
      // The camera allowed first (Android asks, the first time): the control window's camera
      // service can't run without it. (Opened and let go at once: the window opens its own.)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
        stream.getTracks().forEach((t) => t.stop());
      } catch (err) {
        const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
        throw new Error(denied ? "Hand Mouse needs the camera: allow it when Android asks (or in its App info → Permissions), then tap Start." : `The camera couldn't start: ${errText(err)}`);
      }
      // (Android starts the service a moment later, so it doesn't say it's running yet.)
      phone.state = { ...(await mobile.phoneControl.start(settings)), running: true };
    } catch (err) {
      showPhone();
      $("phoneStatus").textContent = errText(err);
      return;
    }
    showPhone();
  }
  async function refreshPhone() {
    if (mode !== "phone") return;
    try {
      phone.state = await mobile.phoneControl.status();
    } catch {
      return;
    }
    if (mode !== "phone") return;
    // Picked, and both permissions given (perhaps just now, in Android's settings): it starts.
    if (phone.autoStart && !phone.state.running && phone.state.overlay && phone.state.accessibility) {
      phone.autoStart = false;
      return startPhone();
    }
    showPhone();
  }

  // ---------- picking and stopping ----------
  function show() {
    const on = (m) => mode === m;
    $("chooser").hidden = !!mode;
    $("running").hidden = !mode;
    $("backBtn").hidden = !mode;
    $("title").textContent = mode ? NAMES[mode] : "Hand Mouse";
    $("stageWrap").hidden = !(on("pc") || on("bluetooth"));
    $("phonePart").hidden = !on("phone");
    $("linkPhone").hidden = !on("pc");
    $("deviceRow").hidden = !on("bluetooth");
    $("mouseToggle").hidden = on("phone");
    $("mouseStatus").hidden = on("phone");
    $("mouseScreenLabel").hidden = !on("pc");
    $("keyboardToggle").hidden = !on("pc");
    $("phoneSettingsNote").hidden = !on("phone");
  }

  async function choose(next) {
    if (mode || !NAMES[next]) return;
    mode = next;
    pcMouseStarted = false;
    // Android's Back comes back here (the page before), as does ←.
    history.pushState({ handMouse: next }, "");
    show();
    if (next === "phone") {
      phone.autoStart = true;
      return refreshPhone();
    }
    setTarget(next === "bluetooth" ? "device" : "computer");
    const camera = await startCamera();
    if (mode !== next || !camera) return;
    if (next === "bluetooth") global.PcControl.setMouse(true);
    else {
      const s = await mobile.link.status().catch(() => ({}));
      if (mode === "pc" && s.paired && !pcMouseStarted) {
        pcMouseStarted = true;
        global.PcControl.setMouse(true);
      }
    }
  }

  async function leave() {
    if (!mode) return;
    const was = mode;
    mode = null;
    phone.autoStart = false;
    show();
    global.PcControl.setMouse(false);
    if (was === "phone") {
      if (phone.state.running) phone.state = await mobile.phoneControl.stop().catch(() => phone.state);
      return;
    }
    setTarget("computer"); // (the Bluetooth mouse stops)
    await stopCamera();
  }

  // ---------- starting ----------
  let started = false;
  async function init() {
    mobile = global.mobile || null;
    const build = document.querySelector('meta[name="hand-tracker-build"]');
    if (build) $("buildInfo").textContent = `v${build.dataset.version}`;
    show();
    const app = !!(mobile && mobile.pc && mobile.phoneControl);
    for (const b of document.querySelectorAll(".choice")) b.disabled = !app;
    $("noApp").hidden = app;
    if (!app) return;
    if (started) return;
    started = true;
    // Nothing runs until a choice is made: the Bluetooth mouse waits too (not where it was left).
    prefs.handMouse = { ...(prefs.handMouse || {}), target: "computer" };
    global.PcControl.init({ desktop: mobile, prefs, setPref, gestureLabels: global.HandGestures.LABELS });
    global.PhoneLinkUI.init({ desktop: null, mobile, prefs, setPref });
    show(); // (each part shown only for its choice)

    // The camera: ready, but none opens until a PC or a Bluetooth device is picked.
    const gestures = global.HandGestures.create();
    ready = global.HandTracker.init({
      videoEl: $("video"),
      canvasEl: $("stage"),
      overlay: true,
      mirror: true,
      maxNumHands: 1,
      modelComplexity: 0, // the Lite model: quicker, as on the full app's phone
      noCamera: true,
      width: 640,
      height: 480,
    });
    ready.catch(() => {}); // (said when a camera's wanted)
    global.HandTracker.onHandLandmarks(({ hands }) => {
      gestures.update(hands);
      const cam = global.HandTracker.getCamera();
      global.PcControl.update(hands, gestures.of, global.HandTracker.isMirrored(), cam.width && cam.height ? cam.width / cam.height : 4 / 3);
    });
    global.HandTracker.onCameraStatus((status) => {
      if (!mode || mode === "phone") return;
      if (status === "stalled") stageMessage("The camera stopped sending video. Reconnecting…", true);
      else stageMessage("");
    });

    // A PC paired while it's picked: the hand mouse starts.
    mobile.link.onStatus((s) => {
      if (mode === "pc" && s.paired && !pcMouseStarted && cameraOn) {
        pcMouseStarted = true;
        global.PcControl.setMouse(true);
      }
    });

    for (const b of document.querySelectorAll(".choice")) b.addEventListener("click", () => choose(b.dataset.mode));
    $("backBtn").addEventListener("click", () => history.back());
    global.addEventListener("popstate", () => leave());

    $("phoneOverlay").addEventListener("click", () => mobile.phoneControl.openOverlaySettings());
    $("phoneAccess").addEventListener("click", () => {
      phone.askedAccessibility = true;
      mobile.phoneControl.openAccessibilitySettings();
    });
    $("phoneAppInfo").addEventListener("click", () => mobile.phoneControl.openAppInfo());
    $("phoneStart").addEventListener("click", async () => {
      if (phone.state.running) {
        phone.state = await mobile.phoneControl.stop().catch(() => phone.state);
        phone.state = { ...phone.state, running: false };
        showPhone();
        return;
      }
      await startPhone();
    });
    mobile.phoneControl.onStopped(() => refreshPhone());
    // Back from Android's settings (a permission given), or from another app.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshPhone();
    });
  }

  global.HandMouse = { init, choose, leave, mode: () => mode, _phone: phone };
  init();
})(window);
