/**
 * screen-modes.js — full screen and picture-in-picture for a page's main view (the user, 2026-11-27: "make a fullscreen
 * mode as well as picture in picture to use over other apps"; for both a call in Cluster Call, cluster-call-page.js, and
 * a camera full screen in Hand Tracker and Remote Recording, remote-client.js; on Android, iPhone, the computers' apps
 * and the website).
 *
 * Full screen: on a phone the app's own (Android: its status and navigation bars hidden, ScreenPlugin.java; iPhone: its
 *   status bar, the Screen plugin in RemoteLink.swift); elsewhere the browser's (the Fullscreen API).
 * Picture-in-picture, over other apps:
 *   - Android: the whole app, small (Android's own). Meanwhile the page shows only its main view (class "pip" on <html>),
 *     with up to 3 buttons of its own there (a call's mute, camera and hang up); it can go small by itself as you leave
 *     the app (auto: a call does).
 *   - Elsewhere (the computers' apps, the website, iPhone): the browser's own, of a <video>: a call's picture as it is; a
 *     camera's pictures (an <img>, or a <canvas> its video is drawn on) drawn into one. A call's buttons are there
 *     where the browser shows them (Media Session: microphone, camera, hang up).
 *
 *   ScreenModes.canFull() / isFull()       ScreenModes.setFull(on) -> Promise<on>
 *   await ScreenModes.canPip()             ScreenModes.inPip()
 *   await ScreenModes.pip({ source, aspect, actions, onAction })  -> { ok, error? }
 *       source: a <video>, <canvas> or <img>; aspect: its width / height; actions: [{ id, title, icon }] (icon: "mic",
 *       "micOff", "camera", "cameraOff", "hangup", "close"); onAction(id)
 *   ScreenModes.follow(source)             (the view now shows another element: a camera's video once it plays, its
 *                                           pictures again when it stops; the browser's window keeps going)
 *   ScreenModes.update({ actions })        (a button's look changed: muted, say)
 *   ScreenModes.media({ mic, camera })     (a call's microphone and camera on or off, for the browser's buttons)
 *   await ScreenModes.leavePip({ toApp })  (back to the app's own window; Android: toApp false hides the app instead)
 *   ScreenModes.auto(on, { aspect, actions, onAction })   (Android: small by itself as you leave the app)
 *   ScreenModes.onChange(cb)               cb({ pip, full })
 */
(function (global) {
  const cap = global.Capacitor;
  const native = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const plugin = native && cap.Plugins ? cap.Plugins.Screen : null;
  const android = !!plugin && cap.getPlatform && cap.getPlatform() === "android";
  const listeners = new Set();
  let full = false;
  let nativePip = false;
  let webPip = null; // { video, stop }
  let onAction = null;
  let last = { aspect: 16 / 9, actions: [] };

  const tell = () => {
    for (const cb of listeners) {
      try {
        cb({ pip: inPip(), full: isFull() });
      } catch {}
    }
  };
  if (android) {
    plugin.addListener("pip", (e) => {
      nativePip = !!(e && e.on);
      document.documentElement.classList.toggle("pip", nativePip);
      tell();
    });
    plugin.addListener("action", (e) => {
      if (onAction && e && e.id) onAction(e.id);
    });
  }
  document.addEventListener("fullscreenchange", tell);

  // ---------- full screen ----------
  const canFull = () => !!plugin || !!document.fullscreenEnabled;
  const isFull = () => (plugin ? full : !!document.fullscreenElement);
  async function setFull(on) {
    if (plugin) {
      const r = await plugin.fullScreen({ on: !!on });
      full = !!(r && r.on);
      tell();
      return full;
    }
    if (on && !document.fullscreenElement && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else if (!on && document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
    return !!document.fullscreenElement;
  }

  // ---------- picture-in-picture ----------
  const inPip = () => (android ? nativePip : !!webPip);
  async function canPip() {
    if (android) {
      try {
        return !!(await plugin.state()).pipSupported;
      } catch {
        return false;
      }
    }
    const v = document.createElement("video");
    return !!(document.pictureInPictureEnabled || (v.webkitSupportsPresentationMode && v.webkitSupportsPresentationMode("picture-in-picture")));
  }

  // A stream of what an element shows: a canvas's own; an <img>'s pictures drawn into a canvas as each comes (and
  // again each second: a canvas's stream sends nothing while nothing is drawn on it).
  function streamOf(el) {
    let canvas = el, draw = null, timer = null;
    if (el instanceof HTMLImageElement) {
      canvas = document.createElement("canvas");
      const g = canvas.getContext("2d");
      draw = () => {
        if (!el.naturalWidth) return;
        if (canvas.width !== el.naturalWidth || canvas.height !== el.naturalHeight) {
          canvas.width = el.naturalWidth;
          canvas.height = el.naturalHeight;
        }
        g.drawImage(el, 0, 0);
      };
      canvas.width = el.naturalWidth || 640;
      canvas.height = el.naturalHeight || 360;
      draw();
      el.addEventListener("load", draw);
      timer = setInterval(draw, 1000);
    }
    const stream = canvas.captureStream(30);
    return {
      stream,
      stop() {
        if (draw) el.removeEventListener("load", draw);
        clearInterval(timer);
        for (const t of stream.getTracks()) t.stop();
      },
    };
  }

  // The <video> the browser takes into picture-in-picture: a video as it is; for a canvas or an <img>, one of its own,
  // playing that element's stream (another element's, follow(), in the same window).
  function videoOf(source) {
    if (source instanceof HTMLVideoElement) return { video: source, follow() {}, stop() {} };
    const video = Object.assign(document.createElement("video"), { muted: true, playsInline: true, autoplay: true });
    video.setAttribute("playsinline", "");
    // (in the page, but out of sight: a video a browser takes into picture-in-picture must be playing)
    video.style.cssText = "position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:0;pointer-events:none";
    document.body.appendChild(video);
    let cur = null;
    const follow = (el) => {
      if (!el || (cur && cur.el === el)) return;
      const next = { el, ...streamOf(el) };
      video.srcObject = next.stream;
      video.play().catch(() => {});
      if (cur) cur.stop();
      cur = next;
    };
    follow(source);
    return {
      video,
      follow,
      stop() {
        if (cur) cur.stop();
        video.remove();
      },
    };
  }

  // The browser's buttons in its picture-in-picture window, for a call (where it has them).
  const MEDIA = { mute: "togglemicrophone", camera: "togglecamera", hangup: "hangup" };
  function mediaActions(actions) {
    const ms = navigator.mediaSession;
    if (!ms || !ms.setActionHandler) return;
    for (const name of Object.values(MEDIA)) {
      try {
        ms.setActionHandler(name, null);
      } catch {}
    }
    for (const a of actions || []) {
      const name = MEDIA[a.id];
      if (!name) continue;
      try {
        ms.setActionHandler(name, () => onAction && onAction(a.id));
      } catch {}
    }
  }
  function media({ mic, camera } = {}) {
    const ms = navigator.mediaSession;
    if (!ms) return;
    try {
      if (ms.setMicrophoneActive && mic !== undefined) ms.setMicrophoneActive(!!mic);
    } catch {}
    try {
      if (ms.setCameraActive && camera !== undefined) ms.setCameraActive(!!camera);
    } catch {}
  }

  async function pip({ source, aspect, actions = [], onAction: cb } = {}) {
    onAction = cb || null;
    last = { aspect: aspect || last.aspect, actions };
    if (android) {
      try {
        return (await plugin.pip({ aspect: last.aspect, actions })) || { ok: false };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    if (webPip) return { ok: true };
    if (!source) return { ok: false, error: "Nothing to show." };
    let made;
    try {
      made = videoOf(source);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const v = made.video;
    try {
      if (v.readyState < 1) {
        await new Promise((resolve, reject) => {
          v.addEventListener("loadedmetadata", resolve, { once: true });
          setTimeout(() => reject(new Error("Its picture didn't come.")), 4000);
        });
      }
      await v.play().catch(() => {});
      if (v.requestPictureInPicture && document.pictureInPictureEnabled) await v.requestPictureInPicture();
      else if (v.webkitSetPresentationMode) v.webkitSetPresentationMode("picture-in-picture");
      else throw new Error("This browser has no picture-in-picture.");
    } catch (e) {
      made.stop();
      return { ok: false, error: e.message };
    }
    webPip = made;
    const left = () => {
      if (webPip !== made) return;
      webPip = null;
      made.stop();
      mediaActions([]);
      tell();
    };
    v.addEventListener("leavepictureinpicture", left, { once: true });
    v.addEventListener("webkitpresentationmodechanged", () => {
      if (v.webkitPresentationMode !== "picture-in-picture") left();
    });
    mediaActions(actions);
    tell();
    return { ok: true };
  }

  function follow(source) {
    if (webPip && source) webPip.follow(source);
  }

  function update({ actions } = {}) {
    if (actions) last.actions = actions;
    if (android) plugin.auto({ on: autoOn, aspect: last.aspect, actions: last.actions }).catch(() => {});
    else if (webPip) mediaActions(last.actions);
  }

  async function leavePip({ toApp = true } = {}) {
    if (android) {
      if (nativePip) await plugin.leave({ toApp: !!toApp }).catch(() => {});
      return;
    }
    if (!webPip) return;
    const v = webPip.video;
    try {
      if (document.pictureInPictureElement && document.exitPictureInPicture) await document.exitPictureInPicture();
      else if (v.webkitSetPresentationMode) v.webkitSetPresentationMode("inline");
    } catch {}
  }

  let autoOn = false;
  function auto(on, { aspect, actions, onAction: cb } = {}) {
    autoOn = !!on;
    if (cb) onAction = cb;
    if (aspect) last.aspect = aspect;
    if (actions) last.actions = actions;
    if (!android) return;
    plugin.auto({ on: autoOn, aspect: last.aspect, actions: last.actions }).catch(() => {});
  }

  global.ScreenModes = {
    canFull,
    isFull,
    setFull,
    canPip,
    inPip,
    pip,
    follow,
    update,
    media,
    leavePip,
    auto,
    android,
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
})(window);
