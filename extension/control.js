// control.js — the Chrome extension's control page: the camera and the hand tracking
// (hand-tracker.js), the gestures (gestures.js) and the hand mouse with its gesture actions
// (pc-control.js), as in the app. What the hand mouse works is the tab in front: each move,
// click, scroll and key goes through background.js to that tab's pointer (content.js). With
// this page itself in front, its own pointer (web-pc.js's page pointer) works it.

(function () {
  const $ = (id) => document.getElementById(id);
  const PREFS_KEY = "handTrackerExtension";
  let prefs = {};
  try {
    prefs = JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {}
  const setPref = (key, value) => {
    prefs[key] = value;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {}
  };

  const manifest = chrome.runtime.getManifest();
  $("buildInfo").textContent = `v${manifest.version}`;

  // ---------- what the hand mouse works: the tab in front ----------
  const own = WebPc._pagePointer(); // this page, when it's in front
  let toggleMouse = () => {};
  let lastNote = "";
  const pageNote = (text) => {
    if (text === lastNote) return;
    lastNote = text;
    $("pageNote").textContent = text;
  };
  async function toTab(msg) {
    const r = await chrome.runtime.sendMessage({ to: "tab", ...msg });
    if (r && r.self) {
      pageNote("");
      const args = { pointer: [msg.nx, msg.ny], button: [msg.which, msg.action], wheel: [msg.notches], key: [msg.combo, msg.action], text: [msg.text], stop: [] }[msg.cmd];
      return own[msg.cmd](...args);
    }
    own.stop(); // (another tab in front: this page's own pointer goes)
    if (r && r.error) {
      if (msg.cmd === "pointer") pageNote(r.error);
      throw new Error(r.error);
    }
    if (msg.cmd === "pointer") pageNote("");
    return r ? r.result : null;
  }
  // Pointer moves come many times a second: only the latest goes once the last one arrived.
  let moving = false, nextMove = null;
  function flushMove() {
    if (moving || !nextMove) return;
    const m = nextMove;
    nextMove = null;
    moving = true;
    toTab({ cmd: "pointer", nx: m[0], ny: m[1] })
      .catch(() => {})
      .finally(() => {
        moving = false;
        flushMove();
      });
  }
  const pc = {
    platform: "chrome-extension",
    start: () => Promise.resolve(),
    pointer(nx, ny) {
      nextMove = [nx, ny];
      flushMove();
    },
    button: (which, action) => toTab({ cmd: "button", which, action }),
    wheel: (notches) => toTab({ cmd: "wheel", notches }),
    key: (combo, action) => toTab({ cmd: "key", combo, action }),
    text: (text) => toTab({ cmd: "text", text }),
    web: () => Promise.reject(new Error("Web requests are in the Hand Tracker app (Windows, Mac, Linux and Android).")),
    setKeyboard: () => Promise.reject(new Error("The floating keyboard is in the Hand Tracker app.")),
    onKeyboard: () => {},
    onToggleMouse: (cb) => (toggleMouse = cb),
    status(s) {
      if (s && s.mouseOn === false) {
        own.stop();
        nextMove = null;
        chrome.runtime.sendMessage({ to: "tab", cmd: "stop" }).catch(() => {});
        pageNote("");
      }
    },
  };
  // Alt+Shift+M, from anywhere in Chrome (background.js).
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.to === "control" && msg.cmd === "toggle") toggleMouse();
  });

  // ---------- the hand mouse and gesture actions (pc-control.js), fed by the tracking ----------
  const handGestures = HandGestures.create();
  PcControl.init({ desktop: { pc }, prefs, setPref, gestureLabels: HandGestures.LABELS });

  const video = $("video"), stage = $("stage"), message = $("stageMessage");
  const modelSelect = $("modelSelect"), mirrorToggle = $("mirrorToggle"), cameraSelect = $("cameraSelect");
  modelSelect.value = prefs.model === 0 ? "0" : "1";
  mirrorToggle.checked = prefs.mirror !== false;

  const say = (text, error) => {
    message.hidden = !text;
    message.className = error ? "error" : "";
    message.textContent = text || "";
  };

  async function fillCameras() {
    const cams = await HandTracker.listCameras().catch(() => []);
    const current = (HandTracker.getCamera() || {}).deviceId || prefs.cameraId || "";
    cameraSelect.innerHTML = "";
    for (const c of cams) {
      const o = document.createElement("option");
      o.value = c.deviceId;
      o.textContent = c.label;
      cameraSelect.appendChild(o);
    }
    if (cams.some((c) => c.deviceId === current)) cameraSelect.value = current;
  }
  cameraSelect.addEventListener("change", async () => {
    setPref("cameraId", cameraSelect.value);
    try {
      await HandTracker.setCamera({ deviceId: cameraSelect.value });
      say("");
    } catch (err) {
      say(`That camera didn't start: ${err.message || err}`, true);
    }
  });
  modelSelect.addEventListener("change", () => {
    const m = Number(modelSelect.value);
    setPref("model", m);
    HandTracker.setModelComplexity(m);
  });
  mirrorToggle.addEventListener("change", () => {
    setPref("mirror", mirrorToggle.checked);
    HandTracker.setMirror(mirrorToggle.checked);
  });

  HandTracker.onHandLandmarks(({ hands }) => {
    handGestures.update(hands);
    const cam = HandTracker.getCamera();
    PcControl.update(hands, (hand) => handGestures.of(hand), mirrorToggle.checked, cam.width && cam.height ? cam.width / cam.height : 16 / 9);
  });
  HandTracker.onCameraStatus((status) => {
    if (status === "stalled") say("The camera stopped sending video. Reconnecting… Check it's plugged in and not in use by another app.", true);
    else say("");
  });
  setInterval(() => ($("fpsBadge").textContent = `${HandTracker.getFPS()} fps`), 1000);
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", fillCameras);

  (async () => {
    say("Starting the camera… (Chrome asks once whether this extension may use it.)");
    try {
      await HandTracker.init({
        videoEl: video,
        canvasEl: stage,
        overlay: true,
        mirror: mirrorToggle.checked,
        maxNumHands: 2,
        modelComplexity: Number(modelSelect.value),
        deviceId: prefs.cameraId || null,
        width: 1280,
        height: 720,
      });
      say("");
    } catch (err) {
      const denied = err && /NotAllowed|Permission/i.test(`${err.name} ${err.message}`);
      say(denied
        ? "The camera isn't allowed for this extension. Click the camera icon in the address bar (or Site settings) and allow it, then reload this page."
        : `The camera didn't start: ${(err && err.message) || err}`, true);
    }
    fillCameras();
  })();

  // For the checks (scripts/check-extension.js): the hand mouse, fed made-up hands.
  window.__handMouse = { pc, PcControl, HandTracker, handGestures };
})();
