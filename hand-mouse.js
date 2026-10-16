/**
 * hand-mouse.js — Hand Mouse (an app of its own, for Android, iPhone and iPad, Windows, Mac and
 * Linux): only the hand mouse. Each time it opens it asks what your hand should control, and
 * starts it. What each kind of device offers:
 *  - Android (the Android project's "mouse" flavor):
 *    - this phone: a pointer over every app (PhoneControlService.java's small window, running
 *      phone-control.js), once its two permissions are given;
 *    - a PC over Wi-Fi: paired from the PC's code (phone-link-ui.js), worked through mobile.pc;
 *    - an iPhone or iPad: this phone as its Bluetooth mouse (mobile.pc's "device" target, hid-core.js);
 *  - Windows, Mac and Linux (the computer apps' "mouse" build, window.desktop):
 *    - this computer: its own pointer and keys (desktop.pc);
 *    - a phone controls it: the phone's hand mouse works this computer (phone-link-ui.js, on the PC);
 *    - an iPhone or iPad: this computer as its Bluetooth mouse (Windows, Linux), or on a Mac its
 *      iPhone Mirroring window as the screen;
 *  - iPhone and iPad (the iPhone app's "mouse" build): the hand browser (websites full screen,
 *    HandBrowser.swift: iOS lets no app tap inside other apps);
 * and everywhere "My gestures": the camera on, to record gestures of your own (custom-gestures.js).
 * The hand mouse, its gestures and gesture actions are pc-control.js's, from the full app's
 * "Control your PC" card's controls (hand-mouse.html has them, with the same ids). Back (the
 * phone's, or ←) stops it and asks again.
 *
 *   HandMouse.init()   (on load; the checks call it again with a stand-in window.mobile)
 */

(function (global) {
  const $ = (id) => document.getElementById(id);
  const errText = (err) => (err && err.message ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  const NAMES = {
    phone: "This phone", pc: "A PC", bluetooth: "Bluetooth mouse", computer: "This computer", linked: "A phone controls it",
    browser: "Hand browser", gestures: "My gestures",
  };
  // The choices that use this device's camera (this phone's control has its own; a phone that
  // controls this computer, its own).
  const CAMERA_MODES = ["pc", "bluetooth", "computer", "browser", "gestures"];
  const DENIED = {
    android: "Hand Mouse needs the camera: allow it when Android asks (or in its App info → Permissions).",
    ios: "Hand Mouse needs the camera: allow it in Settings → Hand Mouse → Camera.",
    desktop: "Hand Mouse needs the camera: allow apps to use it (Windows: Settings → Privacy → Camera; Mac: System Settings → Privacy & Security → Camera).",
  };

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
  let platform = null; // "android" | "ios" | "desktop" (null: not in the app)
  let host = null; // what the hand mouse works through: window.mobile, or window.desktop
  let mirroring = false; // a Mac: its iPhone Mirroring window is the iPhone's "Bluetooth mouse"
  let ready = null; // the tracker, set up (MediaPipe loaded) but with no camera yet
  let mode = null; // the choice running now
  let pcMouseStarted = false; // (a PC's hand mouse turned on once it's paired, not again after you turn it off)
  let cameraOn = false;
  const phone = { state: { overlay: false, accessibility: false, running: false }, askedAccessibility: false, autoStart: false };

  const nameOf = (m) => (m === "bluetooth" && mirroring ? "iPhone or iPad" : NAMES[m]);

  // ---------- the camera ----------
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
        if (!CAMERA_MODES.includes(mode)) stopCamera();
        return false;
      }
      cameraOn = true;
      stageMessage("");
      populateCameras();
      return true;
    } catch (err) {
      const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
      stageMessage(denied ? DENIED[platform] : `The camera couldn't start: ${errText(err)}`, true);
      return false;
    }
  }
  function stopCamera() {
    cameraOn = false;
    // (an "external" source has no camera: the camera's let go)
    return global.HandTracker.useExternalSource("Hand Mouse: off").catch(() => {});
  }
  // A computer's cameras, to pick from (remembered).
  async function populateCameras() {
    if (platform !== "desktop") return;
    const sel = $("cameraPick");
    const cams = await global.HandTracker.listCameras().catch(() => []);
    const now = (global.HandTracker.getCamera() || {}).deviceId || prefs.cameraId || "";
    sel.textContent = "";
    for (const c of cams) {
      const o = document.createElement("option");
      o.value = c.deviceId;
      o.textContent = c.label;
      sel.appendChild(o);
    }
    if (cams.some((c) => c.deviceId === now)) sel.value = now;
  }

  // ---------- what the hand mouse works: the paired PC or this computer, or the Bluetooth device ----------
  function setTarget(target) {
    const select = $("pcTarget");
    if (select.value === target) return;
    select.value = target;
    select.dispatchEvent(new Event("change")); // (pc-control.js starts or stops the Bluetooth mouse)
  }
  // A Mac's iPhone (iPhone Mirroring's window as the hand mouse's screen), or its own screens.
  function setScreen(forIphone) {
    const sel = $("mouseScreen");
    const want = forIphone ? "mirroring" : sel.value === "mirroring" ? "primary" : sel.value;
    if (sel.value === want || !sel.querySelector(`option[value="${want}"]`)) return;
    sel.value = want;
    sel.dispatchEvent(new Event("change"));
  }

  // ---------- this phone (Android) ----------
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
      customGestures: prefs.customGestures || [], mouseGestures: mouse.gestures || {},
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

  // ---------- a phone controlling this computer (Windows, Mac, Linux) ----------
  // Its switch is phone-link-ui.js's (which shows the code to pair with): on while this is picked.
  async function setLinked(on) {
    const s = await host.pc.link.status().catch(() => ({}));
    if (!!s.on !== on) $("linkToggle").click();
  }

  // ---------- picking and stopping ----------
  function show() {
    const on = (m) => mode === m;
    $("chooser").hidden = !!mode;
    $("running").hidden = !mode;
    $("backBtn").hidden = !mode;
    $("title").textContent = mode ? nameOf(mode) : "Hand Mouse";
    $("stageWrap").hidden = !CAMERA_MODES.includes(mode);
    $("cameraRow").hidden = !(platform === "desktop" && CAMERA_MODES.includes(mode));
    $("phonePart").hidden = !on("phone");
    $("linkPhone").hidden = !on("pc");
    $("linkPc").hidden = !on("linked");
    $("handBrowser").hidden = !on("browser");
    $("deviceRow").hidden = !on("bluetooth");
    $("mouseParts").hidden = on("linked");
    $("mouseToggle").hidden = on("phone") || on("gestures");
    $("mouseStatus").hidden = on("phone") || on("gestures");
    $("myGestures").hidden = on("phone"); // (recorded with the camera here: My gestures)
    $("gestureNow").hidden = !on("gestures");
    $("mouseScreenLabel").hidden = !(on("pc") || on("computer") || (on("bluetooth") && mirroring));
    $("keyboardToggle").hidden = !(on("pc") || on("computer"));
    $("phoneSettingsNote").hidden = !on("phone");
  }

  async function choose(next) {
    if (mode || !NAMES[next]) return;
    mode = next;
    pcMouseStarted = false;
    // The phone's Back comes back here (the page before), as does ←.
    history.pushState({ handMouse: next }, "");
    show();
    if (next === "phone") {
      phone.autoStart = true;
      return refreshPhone();
    }
    if (next === "linked") return setLinked(true);
    if (platform !== "ios") setTarget(next === "bluetooth" && !mirroring ? "device" : "computer");
    if (platform === "desktop") setScreen(next === "bluetooth" && mirroring);
    show(); // (the target's change shows and hides some of the hand mouse's own controls)
    const camera = await startCamera();
    // The hand mouse starts at once; in the hand browser, once a website's open (phone-link-ui.js).
    if (mode !== next || !camera || next === "gestures" || next === "browser") return;
    if (next === "pc") {
      const s = await mobile.link.status().catch(() => ({}));
      if (mode === "pc" && s.paired && !pcMouseStarted) {
        pcMouseStarted = true;
        global.PcControl.setMouse(true);
      }
    } else global.PcControl.setMouse(true);
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
    if (was === "linked") return setLinked(false);
    if (was === "browser") await host.browser.close().catch(() => {});
    if (platform !== "ios") setTarget("computer"); // (the Bluetooth mouse stops)
    show();
    await stopCamera();
  }

  // ---------- starting ----------
  let started = false;
  async function init() {
    mobile = global.mobile || null;
    const desktop = global.desktop && global.desktop.pc ? global.desktop : null;
    platform = desktop ? "desktop" : mobile && mobile.platform === "ios" && mobile.browser ? "ios" : mobile && mobile.pc && mobile.phoneControl ? "android" : null;
    host = desktop || mobile;
    mirroring = !!desktop && desktop.pc.platform === "darwin";
    document.documentElement.classList.toggle("desktop", platform === "desktop");
    const build = document.querySelector('meta[name="hand-tracker-build"]');
    if (build) $("buildInfo").textContent = `v${build.dataset.version}`;
    else if (desktop && desktop.getInfo) desktop.getInfo().then((i) => i && i.version && ($("buildInfo").textContent = `v${i.version}`), () => {});
    // This device's choices (not in the app: Android's, greyed out).
    for (const b of document.querySelectorAll(".choice")) {
      b.hidden = !b.dataset.for.split(" ").includes(platform || "android");
      b.disabled = !platform;
    }
    if (mirroring) $("desktopBluetooth").innerHTML = "<b>iPhone or iPad</b><span>Through iPhone Mirroring: your hand works your iPhone in its window on this Mac.</span>";
    show();
    $("noApp").hidden = !!platform;
    if (!platform) return;
    if (started) return;
    started = true;
    // Nothing runs until a choice is made: the Bluetooth mouse waits too (not where it was left),
    // and so does a phone's control of this computer.
    prefs.handMouse = { ...(prefs.handMouse || {}), target: "computer" };
    prefs.phoneLink = false;
    global.PcControl.init({ desktop: host, prefs, setPref, gestureLabels: global.HandGestures.LABELS, touch: platform === "ios" });
    global.PhoneLinkUI.init({ desktop, mobile: desktop ? null : mobile, prefs, setPref });
    const gestures = global.HandGestures.create();
    // Gestures you record yourself: for gesture actions, and as the hand mouse's buttons.
    global.CustomGestures.initUI({
      prefs, setPref, builtIn: global.HandGestures.LABELS, builtInLabelOf: (h) => gestures.builtIn(h).label,
      onChange: () => global.PcControl.gesturesChanged(),
    });
    global.PcControl.gesturesChanged();
    show(); // (each part shown only for its choice)

    // The camera: ready, but none opens until something that uses it is picked.
    ready = global.HandTracker.init({
      videoEl: $("video"),
      canvasEl: $("stage"),
      overlay: true,
      mirror: true,
      maxNumHands: 1,
      modelComplexity: 0, // the Lite model: quicker, as on the full app's phone
      noCamera: true,
      deviceId: platform === "desktop" ? prefs.cameraId || null : null,
      width: 640,
      height: 480,
    });
    ready.catch(() => {}); // (said when a camera's wanted)
    let shownAt = 0;
    global.HandTracker.onHandLandmarks(({ hands }) => {
      gestures.update(hands);
      // My gestures: what each hand is now (to try the recorded ones), and nothing done with it.
      if (mode === "gestures") {
        const now = performance.now();
        if (now - shownAt > 150) {
          shownAt = now;
          $("gestureNow").textContent = hands.length ? hands.map((h) => `${h.handedness === "Left" ? "Left" : "Right"} hand: ${gestures.of(h).label}`).join(" · ") : "Show your hand to the camera.";
        }
        return;
      }
      const cam = global.HandTracker.getCamera();
      global.PcControl.update(hands, gestures.of, global.HandTracker.isMirrored(), cam.width && cam.height ? cam.width / cam.height : 4 / 3);
    });
    global.HandTracker.onCameraStatus((status) => {
      if (!CAMERA_MODES.includes(mode)) return;
      if (status === "stalled") stageMessage("The camera stopped sending video. Reconnecting…", true);
      else stageMessage("");
    });

    for (const b of document.querySelectorAll(".choice")) b.addEventListener("click", () => choose(b.dataset.mode));
    $("backBtn").addEventListener("click", () => history.back());
    global.addEventListener("popstate", () => leave());

    if (platform === "desktop") {
      $("cameraPick").addEventListener("change", (e) => {
        setPref("cameraId", e.target.value);
        if (cameraOn) global.HandTracker.setCamera({ deviceId: e.target.value, width: 640, height: 480 }).catch((err) => stageMessage(`The camera couldn't start: ${errText(err)}`, true));
      });
    }
    if (platform !== "android") return;

    // A PC paired while it's picked: the hand mouse starts.
    mobile.link.onStatus((s) => {
      if (mode === "pc" && s.paired && !pcMouseStarted && cameraOn) {
        pcMouseStarted = true;
        global.PcControl.setMouse(true);
      }
    });
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

  global.HandMouse = { init, choose, leave, mode: () => mode, platform: () => platform, _phone: phone };
  init();
})(window);
