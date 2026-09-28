/**
 * rig-live.js — watch a capture rig's camera live, from a capture-fleet dashboard (Windows
 * and Linux app; hidden with Capture Sessions until Ctrl+Alt+P). See electron/fleet.js.
 *
 * The dashboard only passes on each camera's latest picture (a new one every second or two):
 * its latest H.264 keyframe (full size, decoded here with WebCodecs) or, for cameras that
 * have none, a JPEG. This asks twice a second, draws each new picture on a canvas and hands
 * the canvas's stream to the tracker as its source: rotation, crop, recording and motion
 * capture all work as with a camera. A stereo camera's side-by-side picture can be cut to
 * one view. With "Lock onto a rig that starts recording", a rig is watched as soon as it
 * starts recording, and stays watched while it records.
 *
 *   RigLive.init({ desktop, prefs, setPref, app: HandTrackerApp });
 *   RigLive.setShown(true/false);   // the Live Rigs… button
 *   RigLive.open();                 // the dialog
 *   await RigLive.watch({ host, name, camera });  RigLive.stop();
 */

(function (global) {
  const POLL_MS = 500;
  const THUMBNAIL_WIDTH = 320;
  const STEREO_ASPECT = 3; // wider than 3:1 is two views side by side (e.g. 3840 x 1080)
  const REFRESH_MS = 5000;
  const STALE_S = 15; // a latest picture older than this: the camera isn't sending
  const FOLLOW_MS = 5000;
  const RETRY_FAILED_MS = 30000; // a rig camera that couldn't be watched isn't retried sooner

  let desktop = null, prefs = {}, setPref = () => {}, app = null;
  let els = {};
  let active = null; // the camera being watched (see watcher())
  let refreshTimer = null;
  let followTimer = null;
  let following = false;
  let switching = 0; // switches to a rig camera under way (see onSourceChange)
  const failedAt = new Map(); // "host/camera" -> when watching it last failed (lock mode)
  const dismissed = new Set(); // "host/session": recordings you left while locked on (not locked onto again)
  let rigs = [];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const errText = (err) => String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const label = (a) => `${a.name} · ${a.camera}`;
  function ago(s) {
    if (s < 90) return `${Math.round(s)} s`;
    if (s < 5400) return `${Math.round(s / 60)} min`;
    if (s < 172800) return `${Math.round(s / 3600)} h`;
    return `${Math.round(s / 86400)} days`;
  }

  function error(text) {
    if (!els.error) return;
    els.error.textContent = text || "";
    els.error.hidden = !text;
  }

  // ---------- the picture poller ----------
  function watcher({ host, name, camera, locked }) {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const stream = canvas.captureStream(0); // a frame only when a new picture is drawn
    return {
      host, name, camera, locked: !!locked, canvas, ctx: canvas.getContext("2d"), stream, track: stream.getVideoTracks()[0],
      timer: null, kind: null, decoder: null, codec: "", decoded: null, chunks: 0,
      lastKey: "", frames: 0, lastAt: 0, stereo: false, bigSeen: false, problem: "", signedOut: false,
    };
  }

  function frameUrl(a, kind) {
    return `/__fleet/${encodeURIComponent(a.host)}/${encodeURIComponent(a.camera)}?kind=${kind}${kind === "jpeg" && prefs.rigsFull ? "&full=1" : ""}`;
  }

  async function digest(buf) {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-1", buf));
    return Array.from(h.slice(0, 10), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // An H.264 keyframe to a VideoFrame (null if this computer can't decode that codec).
  async function decodeKeyframe(a, buf, codec) {
    if (!global.VideoDecoder) return null;
    codec = codec || "avc1.640028";
    if (!a.decoder || a.codec !== codec || a.decoder.state === "closed") {
      closeDecoder(a);
      const ok = await global.VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true }).then((s) => s.supported, () => false);
      if (!ok) return null;
      a.decoder = new global.VideoDecoder({
        output: (frame) => {
          if (a.decoded) a.decoded.close();
          a.decoded = frame;
        },
        error: () => {},
      });
      a.decoder.configure({ codec, optimizeForLatency: true });
      a.codec = codec;
    }
    a.decoder.decode(new global.EncodedVideoChunk({ type: "key", timestamp: ++a.chunks * 1000, data: buf }));
    await a.decoder.flush();
    const frame = a.decoded;
    a.decoded = null;
    return frame;
  }

  function closeDecoder(a) {
    if (a.decoded) a.decoded.close();
    a.decoded = null;
    if (a.decoder && a.decoder.state !== "closed") {
      try {
        a.decoder.close();
      } catch {
        // already gone
      }
    }
    a.decoder = null;
  }

  // Fetches the camera's latest picture and draws it if it's new. The first time, the
  // keyframe is tried, then the JPEG; after that, whichever worked. Returns false when there
  // was no usable picture (the reason is in a.problem).
  async function fetchFrame(a) {
    const kinds = a.kind ? [a.kind] : ["keyframe", "jpeg"];
    let reason = "";
    for (const kind of kinds) {
      const res = await fetch(frameUrl(a, kind), { cache: "no-store" });
      if (res.status === 401) {
        a.signedOut = true;
        a.problem = "signed out of the fleet dashboard";
        return false;
      }
      const ageMs = Number(res.headers.get("x-frame-age-ms"));
      const age = Number.isFinite(ageMs) && res.headers.has("x-frame-age-ms") ? ageMs / 1000 : null;
      const stale = res.headers.get("x-frame-stale") === "1" || (age !== null && age > STALE_S);
      const buf = await res.arrayBuffer();
      if (!res.ok || !buf.byteLength || stale) {
        const why = stale
          ? `the camera isn't sending new pictures${age !== null ? ` (its latest is ${ago(age)} old)` : ""}`
          : res.status === 503 ? "the camera isn't sending pictures" : res.status === 504 ? "the rig took too long to answer" : `the rig sent no picture (${res.status})`;
        if (!reason || (stale && age !== null)) reason = why; // the most telling of the two
        continue;
      }
      const type = res.headers.get("content-type") || "";
      const key = res.headers.get("x-frame-unix-ns") || (await digest(buf));
      a.problem = "";
      if (key === a.lastKey && a.kind === kind) return true;
      let image = null;
      if (type.startsWith("video/")) {
        image = await decodeKeyframe(a, buf, res.headers.get("x-codec-string")).catch(() => null);
        if (!image) {
          closeDecoder(a);
          reason = "its video can't be decoded here";
          continue; // the JPEG instead
        }
      } else {
        image = await createImageBitmap(new Blob([buf], { type: type || "image/jpeg" }));
      }
      a.kind = kind;
      a.lastKey = key;
      const w = image.displayWidth || image.width;
      // A preview that's just starting answers with a thumbnail (160 x 90) at first; one is
      // shown only until a real picture comes.
      if (w < THUMBNAIL_WIDTH && a.bigSeen) {
        image.close();
        return true;
      }
      if (w >= THUMBNAIL_WIDTH) a.bigSeen = true;
      draw(a, image);
      image.close();
      a.frames++;
      a.lastAt = performance.now();
      return true;
    }
    a.problem = reason || "the rig sent no picture";
    return false;
  }

  function draw(a, image) {
    const iw = image.displayWidth || image.width, ih = image.displayHeight || image.height;
    a.stereo = iw / ih >= STEREO_ASPECT;
    const side = a.stereo ? prefs.rigsSide || "left" : "both";
    const sw = side === "both" ? iw : Math.round(iw / 2);
    const sx = side === "right" ? iw - sw : 0;
    if (a.canvas.width !== sw || a.canvas.height !== ih) {
      a.canvas.width = sw;
      a.canvas.height = ih;
    }
    a.ctx.drawImage(image, sx, 0, sw, ih, 0, 0, sw, ih);
    if (a.track.requestFrame) a.track.requestFrame();
  }

  function schedule(a) {
    a.timer = setTimeout(async () => {
      if (active !== a) return;
      try {
        await fetchFrame(a);
      } catch (err) {
        a.problem = errText(err);
      }
      if (active !== a) return;
      note(a);
      if (!a.signedOut) schedule(a); // signed out: stays on the last picture until watched again
    }, POLL_MS);
  }

  function note(a) {
    const age = a.lastAt ? (performance.now() - a.lastAt) / 1000 : null;
    const view = a.stereo ? ` (${{ left: "left view", right: "right view", both: "both views" }[prefs.rigsSide || "left"]})` : "";
    const rig = rigs.find((r) => r.host === a.host);
    const recording = rig && rig.state === "recording" ? `, recording${a.locked ? " (locked on)" : ""}` : "";
    app.setSourceNote(
      `Live from ${label(a)}${view}${recording}, through the fleet dashboard: a new picture every second or two` +
        (age !== null ? ` (last ${age < 1 ? "under a second" : `${Math.round(age)} s`} ago)` : "") +
        (a.problem ? `. Right now ${a.problem}.` : ".")
    );
  }

  function halt(a) {
    clearTimeout(a.timer);
    closeDecoder(a);
  }
  function endStream(a) {
    for (const t of a.stream.getTracks()) t.stop();
  }

  // Switches to a rig camera. Its first picture is fetched before anything changes, so if
  // it can't be watched, whatever was showing carries on (and the error says why).
  async function watch({ host, name, camera, locked = false }) {
    const a = watcher({ host, name, camera, locked });
    let ok = false;
    try {
      ok = await fetchFrame(a);
    } catch (err) {
      a.problem = errText(err);
    }
    if (!ok) {
      halt(a);
      endStream(a);
      throw new Error(`${label(a)}: ${a.problem}.`);
    }
    const old = active;
    if (old && !locked) dismiss(old); // picked another camera by hand
    active = a;
    if (old) halt(old);
    switching++;
    try {
      await app.useStreamSource({ stream: a.stream, name: label(a) });
    } finally {
      switching--;
    }
    if (old) endStream(old); // only once the tracker has moved on from it
    if (active !== a) return;
    // Something else was picked while switching: that wins.
    const now = HandTracker.getCamera();
    if (!(now.stream && now.name === label(a))) return stop({ leave: false });
    note(a);
    schedule(a);
    render();
  }

  // Stops asking for pictures. leave: also switch the tracker back to the camera (when it's
  // showing the rig), rather than leaving it on the last picture.
  function stop({ leave = true } = {}) {
    const a = active;
    if (!a) return;
    dismiss(a);
    active = null;
    halt(a);
    endStream(a);
    if (leave) app.leaveStreamSource();
    render();
  }

  // Another source was picked (a camera, a video, an OAK): stop asking for pictures, and
  // make sure the tracker's camera is a real one again for "Use Camera".
  function onSourceChange(camera) {
    // During a switch to a rig camera, earlier switches (say, back to the webcam) finish
    // first and announce themselves: those aren't another source being picked. watch()
    // checks what's showing once its own switch is done.
    if (switching) return;
    if (active && !(camera.stream && camera.name === label(active))) {
      stop({ leave: false });
      if (!camera.stream) HandTracker.forgetStream();
    }
  }

  // ---------- locking onto a recording ----------
  const recordingKey = (rig) => `${rig.host}/${rig.session || ""}`;
  // Leaving a recording you were locked onto: don't lock onto that recording again.
  function dismiss(a) {
    const rig = a.locked && rigs.find((r) => r.host === a.host && r.state === "recording");
    if (rig) dismissed.add(recordingKey(rig));
  }

  function setFollow(on) {
    clearInterval(followTimer);
    followTimer = null;
    if (!on) return;
    followTimer = setInterval(followTick, FOLLOW_MS);
    followTick();
  }

  // The camera to watch on a rig: the head camera if it has one (it sees the hands best).
  const pickCamera = (rig) => (rig.cameras.includes("head") ? "head" : rig.cameras[0]);

  async function followTick() {
    if (following || !els.button || els.button.hidden) return;
    following = true;
    try {
      rigs = await desktop.fleet.rigs();
      if (!els.dialog.hidden) render();
      if (active) note(active);
      // Locked onto a rig while it records.
      if (active && rigs.some((r) => r.host === active.host && r.state === "recording")) return;
      const now = Date.now();
      const recording = rigs
        .filter((r) => r.state === "recording" && r.canWatch && r.cameras.length && !dismissed.has(recordingKey(r)))
        .filter((r) => !(now - (failedAt.get(`${r.host}/${pickCamera(r)}`) || 0) < RETRY_FAILED_MS))
        .sort((x, y) => x.recordingS - y.recordingS); // the one that started last
      const rig = recording[0];
      if (!rig) return;
      const camera = pickCamera(rig);
      try {
        await watch({ host: rig.host, name: rig.name, camera, locked: true });
        error("");
      } catch (err) {
        failedAt.set(`${rig.host}/${camera}`, now);
        error(`Couldn't lock onto ${rig.name}: ${errText(err)}`);
      }
    } catch {
      // signed out, or the dashboard didn't answer: try again next time
    } finally {
      following = false;
    }
  }

  // ---------- the dialog ----------
  async function refresh() {
    error("");
    const s = await desktop.fleet.status();
    els.setup.hidden = s.configured;
    els.signIn.hidden = !s.configured || s.signedIn;
    els.browse.hidden = !(s.configured && s.signedIn);
    els.signOut.hidden = !s.signedIn;
    els.who.textContent = s.configured ? s.site.replace(/^https?:\/\//, "") : "";
    if (s.configured && s.signedIn) await loadRigs();
  }

  async function loadRigs() {
    rigs = await desktop.fleet.rigs();
    render();
  }

  function render() {
    if (!els.list) return;
    if (!rigs.length) {
      els.list.innerHTML = '<div class="note" style="padding:10px">No rigs found.</div>';
      return;
    }
    els.list.innerHTML = rigs
      .map((r) => {
        const state = r.state === "recording" ? `Recording ${clock(r.recordingS)}${r.session ? ` · session ${esc(r.session)}` : ""}` : r.online ? esc(r.state) : "Offline";
        const cams = r.cameras
          .map((c) => {
            const on = active && active.host === r.host && active.camera === c;
            return `<button class="rig-cam${on ? " primary" : ""}" data-host="${esc(r.host)}" data-name="${esc(r.name)}" data-cam="${esc(c)}"${r.canWatch ? "" : " disabled"}>${on ? (active.locked ? "Locked on " : "Watching ") : ""}${esc(c)}</button>`;
          })
          .join(" ");
        return `<div class="ops-row rig-row${r.canWatch ? "" : " rig-off"}"><span class="rig-dot rig-${r.state === "recording" ? "rec" : r.canWatch ? "live" : "off"}"></span>` +
          `<div><b>${esc(r.name)}</b><small>${state}${r.canWatch || !r.online ? "" : " · no preview to show"}</small></div>` +
          `<div class="rig-cams">${cams || '<span class="status">no cameras</span>'}</div></div>`;
      })
      .join("");
  }

  function busy(btn, fn) {
    btn.disabled = true;
    error("");
    return Promise.resolve()
      .then(fn)
      .catch((err) => error(errText(err)))
      .finally(() => (btn.disabled = false));
  }

  function open() {
    els.dialog.hidden = false;
    refresh().catch((err) => error(errText(err)));
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (els.dialog.hidden) return clearInterval(refreshTimer);
      if (!els.browse.hidden && !followTimer) loadRigs().catch(() => {});
    }, REFRESH_MS);
  }

  function setShown(on) {
    if (!els.button) return;
    els.button.hidden = !on;
    if (!on) els.dialog.hidden = true;
    setFollow(on && prefs.rigsFollow === true);
  }

  function init(opts) {
    desktop = opts.desktop;
    prefs = opts.prefs;
    setPref = opts.setPref;
    app = opts.app;
    if (!desktop || !desktop.fleet || !$("rigsDialog")) return;
    els = {
      button: $("rigsBtn"), dialog: $("rigsDialog"), who: $("rigsWho"), signOut: $("rigsSignOut"), close: $("rigsClose"),
      setup: $("rigsSetup"), site: $("rigsSite"), connect: $("rigsConnect"),
      signIn: $("rigsSignIn"), signInBtn: $("rigsSignInBtn"),
      browse: $("rigsBrowse"), follow: $("rigsFollow"), full: $("rigsFull"), side: $("rigsSide"), refresh: $("rigsRefresh"), list: $("rigsList"), error: $("rigsError"),
    };
    els.button.addEventListener("click", open);
    els.close.addEventListener("click", () => (els.dialog.hidden = true));
    els.dialog.addEventListener("click", (e) => {
      if (e.target === els.dialog) els.dialog.hidden = true;
    });
    els.connect.addEventListener("click", () => busy(els.connect, async () => {
      await desktop.fleet.configure(els.site.value);
      await refresh();
    }));
    els.signInBtn.addEventListener("click", () => busy(els.signInBtn, async () => {
      await desktop.fleet.signIn();
      await refresh();
    }));
    els.signOut.addEventListener("click", () => busy(els.signOut, async () => {
      stop();
      await desktop.fleet.signOut();
      rigs = [];
      await refresh();
    }));
    els.refresh.addEventListener("click", () => busy(els.refresh, loadRigs));
    els.follow.checked = prefs.rigsFollow === true;
    els.follow.addEventListener("change", () => {
      setPref("rigsFollow", els.follow.checked);
      failedAt.clear();
      setFollow(els.follow.checked && !els.button.hidden);
    });
    els.full.checked = prefs.rigsFull === true;
    els.full.addEventListener("change", () => {
      setPref("rigsFull", els.full.checked);
      if (active) active.lastKey = ""; // the next picture at the new size
    });
    els.side.value = prefs.rigsSide || "left";
    els.side.addEventListener("change", () => {
      setPref("rigsSide", els.side.value);
      if (active) active.lastKey = ""; // redraw the next picture with the chosen view
    });
    els.list.addEventListener("click", (e) => {
      const b = e.target.closest("button.rig-cam");
      if (!b || b.disabled) return;
      if (active && active.host === b.dataset.host && active.camera === b.dataset.cam) {
        stop(); // back to the camera
        return;
      }
      busy(b, async () => {
        await watch({ host: b.dataset.host, name: b.dataset.name, camera: b.dataset.cam });
        els.dialog.hidden = true;
      });
    });
    HandTracker.onSourceChange(onSourceChange);
    setShown(prefs.captureSessions === true);
  }

  global.RigLive = {
    init, setShown, open, watch, stop,
    isActive: () => !!active,
    _state: () => active && { host: active.host, camera: active.camera, kind: active.kind, locked: active.locked, frames: active.frames, stereo: active.stereo, size: `${active.canvas.width}x${active.canvas.height}`, problem: active.problem },
    _followTick: followTick,
  };
})(window);
