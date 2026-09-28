/**
 * rig-live.js — watch a capture rig's camera live, from a capture-fleet dashboard (Windows
 * and Linux app; hidden with Capture Sessions until Ctrl+Alt+P). See electron/fleet.js.
 *
 * The dashboard only passes on each camera's latest picture (a new one every second or two),
 * so this asks for it twice a second, draws each new picture on a canvas and hands the
 * canvas's stream to the tracker as its source: rotation, crop, recording and motion capture
 * all work as with a camera. A stereo camera's side-by-side picture can be cut to one view.
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

  let desktop = null, prefs = {}, setPref = () => {}, app = null;
  let els = {};
  let active = null; // { host, name, camera, canvas, ctx, stream, track, timer, lastKey, frames, lastAt, stereo }
  let refreshTimer = null;
  let rigs = [];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const errText = (err) => String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  function error(text) {
    els.error.textContent = text || "";
    els.error.hidden = !text;
  }

  // ---------- the picture poller ----------
  function frameUrl(host, camera) {
    return `/__fleet/${encodeURIComponent(host)}/${encodeURIComponent(camera)}${prefs.rigsFull ? "?full=1" : ""}`;
  }

  async function digest(buf) {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-1", buf));
    return Array.from(h.slice(0, 10), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Fetches the camera's latest picture; draws it if it's new. Returns false when the
  // dashboard sent none (with the reason in a.problem).
  async function fetchFrame(a) {
    const res = await fetch(frameUrl(a.host, a.camera), { cache: "no-store" });
    if (res.status === 401) {
      a.problem = "signed out of the fleet dashboard";
      a.signedOut = true;
      return false;
    }
    if (!res.ok) {
      a.problem = `the rig sent no picture (${res.status})`;
      return false;
    }
    const buf = await res.arrayBuffer();
    const key = await digest(buf);
    a.problem = "";
    if (key === a.lastKey) return true;
    a.lastKey = key;
    const bmp = await createImageBitmap(new Blob([buf], { type: res.headers.get("content-type") || "image/jpeg" }));
    // A preview that's just starting answers with a thumbnail (160 x 90) at first; one is
    // shown only until a real picture comes.
    if (bmp.width < THUMBNAIL_WIDTH && a.bigSeen) {
      bmp.close();
      return true;
    }
    if (bmp.width >= THUMBNAIL_WIDTH) a.bigSeen = true;
    draw(a, bmp);
    bmp.close();
    a.frames++;
    a.lastAt = performance.now();
    return true;
  }

  function draw(a, bmp) {
    a.stereo = bmp.width / bmp.height >= STEREO_ASPECT;
    const side = a.stereo ? prefs.rigsSide || "left" : "both";
    const sw = side === "both" ? bmp.width : Math.round(bmp.width / 2);
    const sx = side === "right" ? bmp.width - sw : 0;
    if (a.canvas.width !== sw || a.canvas.height !== bmp.height) {
      a.canvas.width = sw;
      a.canvas.height = bmp.height;
    }
    a.ctx.drawImage(bmp, sx, 0, sw, bmp.height, 0, 0, sw, bmp.height);
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
      if (a.signedOut) {
        note(a);
        return; // stays on the last picture; signing in again and watching restarts it
      }
      note(a);
      schedule(a);
    }, POLL_MS);
  }

  function note(a) {
    const age = a.lastAt ? (performance.now() - a.lastAt) / 1000 : null;
    const view = a.stereo ? ` (${{ left: "left view", right: "right view", both: "both views" }[prefs.rigsSide || "left"]})` : "";
    app.setSourceNote(
      `Live from ${a.name} · ${a.camera}${view}, through the fleet dashboard: a new picture every second or two` +
        (age !== null ? ` (last ${age < 1 ? "under a second" : `${Math.round(age)} s`} ago)` : "") +
        (a.problem ? `. Right now ${a.problem}.` : ".")
    );
  }

  async function watch({ host, name, camera }) {
    stop();
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const stream = canvas.captureStream(0); // a frame only when a new picture is drawn
    const a = { host, name, camera, canvas, ctx: canvas.getContext("2d"), stream, track: stream.getVideoTracks()[0], timer: null, lastKey: "", frames: 0, lastAt: 0, stereo: false, problem: "" };
    // The first picture before switching over, so the tracker starts on a real one.
    if (!(await fetchFrame(a))) throw new Error(`${name} · ${camera}: ${a.problem}.`);
    active = a;
    await app.useStreamSource({ stream, name: `${name} · ${camera}` });
    if (active !== a) return;
    note(a);
    schedule(a);
    render();
  }

  // Stops asking for pictures. leave: also switch the tracker back to the camera (when it's
  // showing the rig), rather than leaving it on the last picture.
  function stop({ leave = true } = {}) {
    const a = active;
    if (!a) return;
    active = null;
    clearTimeout(a.timer);
    for (const t of a.stream.getTracks()) t.stop();
    if (leave) app.leaveStreamSource();
    render();
  }

  // Another source was picked (a camera, a video, an OAK): stop asking for pictures, and
  // make sure the tracker's camera is a real one again for "Use Camera".
  function onSourceChange(camera) {
    if (active && !(camera.stream && camera.name === `${active.name} · ${active.camera}`)) {
      stop({ leave: false });
      if (!camera.stream) HandTracker.forgetStream();
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
            return `<button class="rig-cam${on ? " primary" : ""}" data-host="${esc(r.host)}" data-name="${esc(r.name)}" data-cam="${esc(c)}"${r.canWatch ? "" : " disabled"}>${on ? "Watching " : ""}${esc(c)}</button>`;
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
      if (!els.browse.hidden) loadRigs().catch(() => {});
    }, REFRESH_MS);
  }

  function setShown(on) {
    if (!els.button) return;
    els.button.hidden = !on;
    if (!on) els.dialog.hidden = true;
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
      browse: $("rigsBrowse"), full: $("rigsFull"), side: $("rigsSide"), refresh: $("rigsRefresh"), list: $("rigsList"), error: $("rigsError"),
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

  global.RigLive = { init, setShown, open, watch, stop, isActive: () => !!active, _state: () => active && { host: active.host, camera: active.camera, frames: active.frames, stereo: active.stereo, size: `${active.canvas.width}x${active.canvas.height}`, problem: active.problem } };
})(window);
