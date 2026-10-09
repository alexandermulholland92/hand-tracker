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
    // Back from Accessibility settings and it's still off, on Android 13 or later: likely its
    // "Restricted setting" block (an app installed from a downloaded file), which App info lifts.
    let askedAccessibility = false;
    const show = () => {
      const done = (btn, ok, text) => {
        btn.textContent = ok ? `✓ ${text}` : text;
        btn.classList.toggle("active", ok);
      };
      done($("selfOverlay"), state.overlay, "1. Allow display over other apps");
      done($("selfAccess"), state.accessibility, "2. Turn on hand control in Accessibility");
      $("selfStart").textContent = state.running ? "Stop controlling this phone" : "Start controlling this phone";
      $("selfRestricted").hidden = !(askedAccessibility && !state.accessibility && state.sdk >= 33);
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
    $("selfAccess").addEventListener("click", () => {
      askedAccessibility = true;
      control.openAccessibilitySettings();
    });
    $("selfAppInfo").addEventListener("click", () => control.openAppInfo());
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

  // ---------- the iPhone app: the hand browser ----------
  // A website opened full screen; the hand mouse (pc-control.js, through mobile.pc) works it.
  // While it's open the app is a small window in a corner (HandBrowser.swift) showing just the
  // camera (html.hb-pip), with the browser's buttons: Back, the hand mouse, the app full screen
  // (the website kept behind it; then a bar at the top has the way back) and Close.
  function initBrowser(browser, setPref, prefs) {
    $("handBrowser").hidden = false;
    const label = $("pcCard").querySelector(".section-label");
    if (label) label.textContent = "Hand mouse";
    // (No other screens, and no floating keyboard: on an iPhone the page's own keyboard types.)
    for (const id of ["mouseScreen", "keyboardToggle"]) {
      const el = $(id);
      if (el) (el.closest("label") || el).hidden = true;
    }
    const status = $("hbStatus"), url = $("hbUrl"), bar = $("hbBar"), root = document.documentElement;
    const saved = prefs.handBrowser || {};
    url.value = saved.url || "";
    const small = (on) => root.classList.toggle("hb-pip", !!on);
    // The buttons: symbols in the small window, words over the app.
    const buttons = () => {
      const pip = root.classList.contains("hb-pip");
      const on = !!(global.PcControl && global.PcControl.isMouseOn());
      $("hbMouse").textContent = pip ? "✋" : `Hand mouse: ${on ? "ON" : "OFF"}`;
      $("hbMouse").setAttribute("aria-pressed", String(on));
      $("hbMouse").classList.toggle("active", on);
      $("hbBack").hidden = !pip;
      $("hbApp").textContent = pip ? "⚙" : "Back to the website";
      $("hbClose").textContent = pip ? "✕" : "✕ Close";
    };
    // The small window takes the camera picture's shape.
    const aspect = () => {
      const cam = global.HandTracker && global.HandTracker.getCamera ? global.HandTracker.getCamera() : null;
      return cam && cam.width > 0 && cam.height > 0 ? cam.width / cam.height : 0.75;
    };
    // What was typed -> a web address (a search for anything that isn't one).
    const addressOf = (text) => {
      const t = String(text || "").trim();
      if (/^https?:\/\//i.test(t)) return t;
      if (/^[^\s]+\.[a-z]{2,}(\/.*)?$/i.test(t)) return `https://${t}`;
      return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
    };
    async function open(text) {
      const target = addressOf(text);
      small(true);
      try {
        await browser.open(target, aspect());
        bar.hidden = false;
        setPref("handBrowser", { url: String(text || "").trim() });
        if (global.PcControl && !global.PcControl.isMouseOn()) global.PcControl.setMouse(true);
        buttons();
        return target;
      } catch (err) {
        small(false);
        status.textContent = (err && err.message) || String(err);
        throw err;
      }
    }
    $("hbOpen").addEventListener("click", () => url.value.trim() && open(url.value).catch(() => {}));
    url.addEventListener("keydown", (e) => e.key === "Enter" && url.value.trim() && open(url.value).catch(() => {}));
    $("hbBack").addEventListener("click", () => browser.back());
    $("hbClose").addEventListener("click", () => browser.close());
    $("hbMouse").addEventListener("click", () => {
      if (global.PcControl) global.PcControl.setMouse(!global.PcControl.isMouseOn());
      setTimeout(buttons, 100);
    });
    $("hbApp").addEventListener("click", () => {
      const toApp = root.classList.contains("hb-pip");
      if (!toApp) small(true);
      browser.show(toApp).then(buttons, () => {});
    });
    browser.onPage((s) => {
      bar.hidden = !s.open;
      small(s.open && !s.app);
      $("hbTitle").textContent = s.loading ? "Loading…" : s.title || s.url || "";
      status.textContent = s.error ? `Couldn't open it: ${s.error}` : s.open ? `Open: ${s.title || s.url}` : "";
      buttons();
    });
    // The build's own check in the iPhone simulator (launched with -HTSelfTest <test page>, a
    // page the build serves): open the page, point at its link with the hand mouse's calls and
    // click it; the page it opens is the proof. The result goes to the log the check reads.
    if (global.__htSelfTest) {
      const test = typeof global.__htSelfTest === "string" ? global.__htSelfTest : "https://example.com/";
      (async () => {
        const out = { plugins: Object.keys((global.Capacitor && global.Capacitor.Plugins) || {}).sort() };
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const page = (test, ms = 30000) =>
          new Promise((resolve) => {
            const t = setTimeout(() => (off(), resolve(null)), ms);
            const off = browser.onPage((s) => test(s) && (clearTimeout(t), off(), resolve(s)));
          });
        const pc = global.mobile.pc;
        const drag = async (y0, y1) => {
          pc.pointer(0.5, y0);
          await sleep(150);
          await pc.button("left", "down");
          for (let i = 1; i <= 10; i++) {
            pc.pointer(0.5, y0 + ((y1 - y0) * i) / 10);
            await sleep(30);
          }
          await pc.button("left", "up");
          await sleep(1500);
        };
        try {
          const first = page((s) => s.open && !s.loading && !!s.url && !!s.title);
          out.opened = await open(test);
          out.first = (await first) || (await browser.status());
          await sleep(500);
          // The website fills the screen; the app is a small window over it.
          const L = await browser.layout(), [sw, sh] = L.screen, b = L.browser, a = L.app;
          out.layout = L;
          out.full = !!b && b[2] >= sw - 1 && b[3] >= sh * 0.85;
          out.small = a[2] * a[3] <= sw * sh * 0.15 && a[0] >= 0 && a[1] >= 0 && a[0] + a[2] <= sw && a[1] + a[3] <= sh;
          // The pointer over it: it moves to the other side.
          await pc.start();
          pc.pointer((a[0] + a[2] / 2 - b[0]) / b[2], (a[1] + a[3] / 2 - b[1]) / b[3]);
          await sleep(600);
          const a2 = (await browser.layout()).app;
          out.moved = a2[0] + a2[2] / 2 < sw / 2 !== a[0] + a[2] / 2 < sw / 2;
          // A drag up scrolls the page (and doesn't click); a longer one down scrolls it back to the top.
          const from = out.first.url;
          const y0 = (await browser.where("a")).y;
          await drag(0.8, 0.4);
          out.scrolled = +(y0 - (await browser.where("a")).y).toFixed(3);
          out.stayed = (await browser.status()).url === from;
          await drag(0.1, 0.95);
          const at = await browser.where("a");
          out.link = at;
          out.y0 = y0;
          out.back = Math.abs(at.y - y0) < 0.02;
          const next = page((s) => s.open && !s.loading && !!s.url && s.url !== from);
          pc.pointer(at.x, at.y);
          await sleep(300);
          await pc.button("left", "click");
          out.after = await next;
          out.ok = !!(out.after && out.after.url) && out.full && out.small && out.moved && out.scrolled > 0.2 && out.stayed && out.back;
        } catch (err) {
          out.error = String((err && err.message) || err);
        }
        console.log("HT-SELFTEST " + JSON.stringify(out));
      })();
    }
  }

  function init({ desktop, mobile, prefs, setPref }) {
    if (desktop && desktop.pc && desktop.pc.link && $("linkPc")) initPc(desktop.pc.link, prefs, setPref);
    else if (mobile && mobile.link && $("linkPhone")) initPhone(mobile.link);
    if (mobile && mobile.phoneControl && $("selfControl")) initSelf(mobile.phoneControl, prefs);
    if (mobile && mobile.browser && $("handBrowser")) initBrowser(mobile.browser, setPref, prefs);
  }

  global.PhoneLinkUI = { init };
})(window);
