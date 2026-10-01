/**
 * phone-link-ui.js — the "Control your PC" card's part for a phone controlling a PC over
 * Wi-Fi (phone-link-protocol.js):
 *   on the PC (Windows and Linux app): "Let a phone control this PC", which shows the QR
 *     code to pair a phone, and which phone is connected;
 *   on the phone (Android app): reading that code with the camera (or typing it in), and
 *     which PC it's connected to. The card's hand mouse, keyboard and gesture actions then
 *     work that PC (mobile.pc). And "Control this phone": the same hand mouse and gesture
 *     actions on the phone itself, over every app (mobile.phoneControl, phone-control.js).
 *
 *   PhoneLinkUI.init({ desktop, mobile, prefs, setPref });
 */

(function (global) {
  const $ = (id) => document.getElementById(id);
  const errText = (err) => (err && err.message ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- on the PC ----------
  function initPc(link, prefs, setPref) {
    $("linkPc").hidden = false;
    const toggle = $("linkToggle");
    let shownCode = "";
    const show = (s) => {
      toggle.classList.toggle("active", s.on);
      toggle.setAttribute("aria-pressed", String(s.on));
      toggle.textContent = `Let a phone control this PC: ${s.on ? "ON" : "OFF"}`;
      $("linkNewKey").hidden = !s.on;
      $("linkPcPair").hidden = !s.on || !s.pairing;
      if (s.on && s.pairing && s.pairing !== shownCode) {
        global.QRCode.draw($("linkQr"), s.pairing, { scale: 5, margin: 3 });
        $("linkCode").textContent = s.pairing;
        shownCode = s.pairing;
      }
      $("linkPcStatus").textContent = !s.on
        ? ""
        : !s.addresses.length
          ? "This PC isn't connected to a network."
          : s.phone
            ? `Connected: ${s.phone.name} (${s.phone.address})`
            : "Waiting for the phone…";
    };
    link.onStatus(show);
    toggle.addEventListener("click", async () => {
      try {
        const s = await link.status();
        const next = s.on ? await link.stop() : await link.start();
        setPref("phoneLink", next.on);
        show(next);
      } catch (err) {
        $("linkPcStatus").textContent = `Couldn't listen for the phone: ${errText(err)}`;
      }
    });
    $("linkNewKey").addEventListener("click", async () => show(await link.newKey()));
    link.status().then(show);
    if (prefs.phoneLink === true) link.start().then(show).catch(() => {});
  }

  // ---------- on the phone ----------
  let scanning = false;
  function initPhone(link) {
    $("linkPhone").hidden = false;
    const status = $("linkPhoneStatus");
    const show = (s) => {
      status.textContent = s.connected
        ? `Connected to ${s.pc || "the PC"} (${s.address}).`
        : s.error
          ? s.error
          : s.paired
            ? `Paired with ${s.pc || s.address}: it connects when you use it.`
            : "Not connected to a PC yet. On the PC: Control your PC → Let a phone control this PC, then scan its code.";
      $("linkForget").hidden = !s.paired;
      if (!scanning) $("linkScan").textContent = s.paired ? "Scan another PC's code" : "Scan the PC's code";
    };
    link.onStatus(show);
    link.status().then(show);
    const pair = async (text) => {
      status.textContent = "Connecting…";
      try {
        show(await link.pair(text));
        $("linkEnterRow").hidden = true;
      } catch (err) {
        status.textContent = errText(err);
      }
    };
    $("linkEnter").addEventListener("click", () => {
      $("linkEnterRow").hidden = !$("linkEnterRow").hidden;
      if (!$("linkEnterRow").hidden) $("linkCodeInput").focus();
    });
    $("linkConnect").addEventListener("click", () => pair($("linkCodeInput").value));
    $("linkForget").addEventListener("click", () => link.forget());
    $("linkScan").addEventListener("click", async () => {
      if (scanning) {
        scanning = false;
        return;
      }
      if (!("BarcodeDetector" in global)) {
        $("linkEnterRow").hidden = false;
        status.textContent = "This phone can't read QR codes in the app: type in the code shown under the QR code on the PC.";
        return;
      }
      scanning = true;
      $("linkScan").textContent = "Stop scanning";
      status.textContent = "Point the camera at the code on the PC's screen…";
      try {
        const detector = new global.BarcodeDetector({ formats: ["qr_code"] });
        const video = $("video");
        for (const until = Date.now() + 90000; scanning && Date.now() < until; await sleep(250)) {
          const found = await detector.detect(video).catch(() => []);
          const code = found.find((c) => /^handtracker-link:/.test(c.rawValue || ""));
          if (code) {
            scanning = false;
            await pair(code.rawValue);
            break;
          }
        }
        if (scanning) status.textContent = "No code found. Hold the phone so the PC's code fills more of the picture, or type the code in.";
      } finally {
        scanning = false;
        link.status().then(show);
      }
    });
  }

  // ---------- controlling the phone itself ----------
  const SELF_SOURCE = "Controlling this phone";
  function initSelf(control, prefs) {
    $("selfControl").hidden = false;
    const status = $("selfStatus");
    let state = { overlay: false, accessibility: false, running: false };
    const show = () => {
      const done = (btn, ok, text) => {
        btn.textContent = ok ? `✓ ${text}` : text;
        btn.classList.toggle("active", ok);
      };
      done($("selfOverlay"), state.overlay, "1. Allow display over other apps");
      done($("selfAccess"), state.accessibility, "2. Turn on hand control in Accessibility");
      $("selfStart").textContent = state.running ? "Stop controlling this phone" : "Start controlling this phone";
      status.textContent = state.running
        ? "Controlling this phone: switch to any app. The camera window's × (or Stop in the notification) ends it."
        : !state.overlay
          ? "First allow Hand Tracker to display over other apps (for the pointer and the camera window)."
          : !state.accessibility
            ? "Then turn on Hand Tracker's hand control in Accessibility, so it can tap, swipe and type."
            : "Ready.";
    };
    const refresh = () => control.status().then((s) => {
      state = s;
      show();
      // Back in the app after it stopped: the camera is the app's again.
      if (!s.running && global.HandTracker.getSource() === "external" && global.HandTracker.getCamera().name === SELF_SOURCE) global.HandTracker.useCamera();
    }).catch(() => {});
    $("selfOverlay").addEventListener("click", () => control.openOverlaySettings());
    $("selfAccess").addEventListener("click", () => control.openAccessibilitySettings());
    $("selfStart").addEventListener("click", async () => {
      if (state.running) {
        state = await control.stop();
        return refresh();
      }
      const mouse = prefs.handMouse || {}, actions = prefs.gestureActions || {};
      const settings = {
        hand: mouse.hand || "Right", reach: mouse.reach || "0.55",
        actionsOn: actions.on === true, rules: actions.rules || [], allow: actions.allow || {},
        deviceId: global.HandTracker.getCamera().deviceId || null,
      };
      try {
        // The camera can only be used by one window at a time: the control window takes it.
        await global.HandTracker.useExternalSource(SELF_SOURCE);
        // (Android starts the service a moment later, so it doesn't say it's running yet.)
        state = { ...(await control.start(settings)), running: true };
      } catch (err) {
        global.HandTracker.useCamera();
        status.textContent = errText(err);
        return;
      }
      show();
    });
    control.onStopped(() => refresh());
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refresh();
    });
    refresh();
  }

  function init({ desktop, mobile, prefs, setPref }) {
    if (desktop && desktop.pc && desktop.pc.link && $("linkPc")) initPc(desktop.pc.link, prefs, setPref);
    else if (mobile && mobile.link && $("linkPhone")) initPhone(mobile.link);
    if (mobile && mobile.phoneControl && $("selfControl")) initSelf(mobile.phoneControl, prefs);
  }

  global.PhoneLinkUI = { init };
})(window);
