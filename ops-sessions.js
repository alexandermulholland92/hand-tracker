/**
 * ops-sessions.js — "Capture Sessions": track recorded sessions from a capture-operations
 * dashboard (Windows and Linux app; hidden until Ctrl+Alt+P). Sign in with your own
 * dashboard account, pick sessions and the cameras to track, and every frame of each
 * camera's video is tracked (Capture Whole Video) and saved as motion capture files into one
 * folder, named by session and camera. The videos stream from the dashboard's storage as
 * they're tracked; nothing is downloaded first. See electron/ops.js.
 *
 *   OpsSessions.init({ desktop, prefs, setPref });
 *   OpsSessions.toggleShown();   // shows or hides the Capture Sessions button (remembered)
 */

(function (global) {
  // Cameras offered for tracking ("position/stream" as in the session manifest). Depth
  // videos are left out: there's no hand to see in them.
  const STREAMS = ["head/rgb", "chest/rgb", "wrist_left/rgb", "wrist_right/rgb", "head/mono_left", "head/mono_right"];
  const DEFAULT_STREAMS = ["head/rgb", "chest/rgb"];
  const DEFAULT_FORMATS = ["json", "csv"];

  let desktop = null, prefs = {}, setPref = () => {};
  let els = {};
  let sessions = [];
  let offset = 0;
  const picked = new Map(); // id -> session
  const manifests = new Map(); // id -> manifest
  let running = false, stopRequested = false;

  const $ = (id) => document.getElementById(id);
  const errText = (err) => (err && err.message ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  const esc = (v) => String(v === null || v === undefined ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const pad2 = (n) => String(n).padStart(2, "0");
  function clock(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    return s >= 3600 ? `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}` : `${Math.floor(s / 60)}:${pad2(s % 60)}`;
  }
  function stamp(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "session" : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
  }

  function error(text) {
    els.error.textContent = text || "";
    els.error.hidden = !text;
  }
  async function busy(btn, fn) {
    btn.disabled = true;
    error("");
    try {
      return await fn();
    } catch (err) {
      error(errText(err));
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- panels ----------
  async function refresh() {
    const s = await desktop.ops.status();
    els.setup.hidden = s.configured;
    els.signIn.hidden = !s.configured || s.signedIn;
    els.browse.hidden = !(s.configured && s.signedIn);
    els.signOut.hidden = !s.signedIn;
    els.who.textContent = s.configured ? `${s.site.replace(/^https:\/\//, "")}${s.signedIn && s.email ? ` · ${s.email}` : ""}` : "";
    if (s.configured && !s.signedIn && s.email && !els.email.value) els.email.value = s.email;
    if (!els.browse.hidden && !sessions.length) await load(true);
  }

  function open() {
    els.dialog.hidden = false;
    refresh().catch((err) => error(errText(err)));
  }

  // ---------- sessions ----------
  async function load(reset) {
    if (reset) {
      sessions = [];
      offset = 0;
    }
    const rows = await desktop.ops.sessions({ offset, limit: 50, search: els.search.value.trim() });
    sessions.push(...rows);
    offset += rows.length;
    els.more.hidden = rows.length < 50;
    render();
  }

  function render() {
    if (!sessions.length) {
      els.list.innerHTML = '<div class="note" style="padding:10px">No sessions found.</div>';
      return;
    }
    els.list.innerHTML = sessions
      .map((s) => {
        const when = new Date(s.when);
        const m = manifests.get(s.id);
        const cams = m ? m.streams.map((x) => `${x.position}/${x.stream}`).join(", ") : picked.has(s.id) ? "reading cameras…" : "";
        return `<div class="ops-row" data-id="${esc(s.id)}">
          <input type="checkbox" ${picked.has(s.id) ? "checked" : ""} tabindex="-1" />
          <div><b>${esc(isNaN(when) ? s.when : when.toLocaleString())}</b> · ${esc(clock(s.duration))} · ${esc(s.id.slice(0, 8))}
            <small>${esc([s.operator, s.task, s.venue, s.program].filter(Boolean).join(" · "))}</small></div>
          <span class="status">${esc(s.review || "")}</span>
          ${cams ? `<div class="ops-cams">${esc(cams)}</div>` : ""}
        </div>`;
      })
      .join("");
    els.picked.textContent = picked.size ? `${picked.size} selected` : "";
    els.track.disabled = !picked.size || running;
  }

  async function togglePick(id) {
    const s = sessions.find((x) => x.id === id);
    if (!s || running) return;
    if (picked.has(id)) picked.delete(id);
    else picked.set(id, s);
    render();
    if (picked.has(id) && !manifests.has(id)) {
      try {
        manifests.set(id, await desktop.ops.manifest(id));
      } catch (err) {
        error(`${id.slice(0, 8)}: ${errText(err)}`);
        picked.delete(id);
      }
      render();
    }
  }

  function chosen(container) {
    return [...container.querySelectorAll("input:checked")].map((i) => i.value);
  }

  // ---------- tracking ----------
  async function trackSelected() {
    const streams = chosen(els.streamPicks);
    const formats = chosen(els.formats);
    if (!streams.length) return error("Pick at least one camera to track.");
    if (!formats.length) return error("Pick at least one format to save.");
    const folder = await desktop.chooseFolder("Choose a folder for the tracked sessions");
    if (!folder || folder.canceled) return;
    running = true;
    stopRequested = false;
    els.stop.hidden = false;
    els.runStop.hidden = false;
    render();
    els.dialog.hidden = true; // watch the tracking; progress shows under the picture
    els.runBar.hidden = false;
    const log = [];
    let done = 0, saved = 0;
    const jobs = [];
    for (const s of picked.values()) {
      const m = manifests.get(s.id) || (await desktop.ops.manifest(s.id).catch((err) => (log.push(`${s.id.slice(0, 8)}: ${errText(err)}`), null)));
      if (!m) continue;
      manifests.set(s.id, m);
      for (const st of m.streams) if (streams.includes(`${st.position}/${st.stream}`)) jobs.push({ s, m, st });
    }
    for (const [i, { s, m, st }] of jobs.entries()) {
      if (stopRequested) break;
      const name = `${stamp(s.when)}_${s.id.slice(0, 8)}_${st.position}-${st.stream}`;
      const label = `${i + 1} of ${jobs.length}: ${s.id.slice(0, 8)} ${st.position}/${st.stream}`;
      let url = null;
      try {
        url = (await desktop.ops.stream(s.id, st.path)).url;
        els.runText.textContent = `Tracking ${label}…`;
        const data = await HandTrackerApp.trackWholeVideo(`${name}.mp4`, url, {
          onProgress: (t, total) => (els.runText.textContent = `Tracking ${label} · ${clock(t)} of ${clock(total)}`),
        });
        done++;
        if (!data.hands.length) {
          log.push(`${name}: no hands visible`);
          continue;
        }
        // Where this camera sits on the session's clock (explained in the file's notes below).
        const sessionStart = m.window && m.window.start_ns;
        data.recorded_at = s.when;
        data.source = {
          kind: "capture_session",
          session_id: s.id,
          position: st.position,
          stream: st.stream,
          device: st.device,
          fps_nominal: st.fps,
          frame_count: st.frames,
          stream_start_ns: st.startNs,
          session_start_ns: sessionStart || null,
          // Seconds from the session's start to this video's first frame; add time_origin_s
          // and each frame's t to get its time on the session clock.
          stream_offset_s: st.startNs && sessionStart ? (st.startNs - sessionStart) / 1e9 : null,
        };
        data.notes.push("source.stream_offset_s + time_origin_s + t = the frame's time on the capture session's clock (seconds from the session start), so several cameras can be lined up.");
        const files = MotionExport.build(data, formats, name);
        const res = await desktop.saveFilesTo(folder.token, { baseName: name, files });
        const ok = res.results.filter((r) => r.ok).length;
        saved += ok;
        log.push(`${name}: ${data.hands.map((h) => h.handedness).join(" + ")} · ${ok} file${ok === 1 ? "" : "s"}`);
      } catch (err) {
        log.push(`${name}: ${errText(err)}`);
      } finally {
        if (url) desktop.ops.forget(url);
      }
    }
    running = false;
    els.stop.hidden = true;
    els.runStop.hidden = true;
    els.runBar.hidden = true;
    await HandTrackerApp.backToCamera();
    els.progress.textContent = `${stopRequested ? "Stopped. " : ""}Tracked ${done} of ${jobs.length} camera video${jobs.length === 1 ? "" : "s"}; saved ${saved} file${saved === 1 ? "" : "s"} to ${folder.dir}\n${log.join("\n")}`;
    els.dialog.hidden = false;
    render();
  }

  function stop() {
    stopRequested = true;
    HandTrackerApp.stopTracking();
  }

  // ---------- setup ----------
  function init(opts) {
    desktop = opts.desktop;
    prefs = opts.prefs;
    setPref = opts.setPref;
    if (!desktop || !desktop.ops || !$("opsDialog")) return;
    els = {
      button: $("opsBtn"), dialog: $("opsDialog"), who: $("opsWho"), signOut: $("opsSignOut"), close: $("opsClose"),
      setup: $("opsSetup"), site: $("opsSite"), connect: $("opsConnect"),
      signIn: $("opsSignIn"), email: $("opsEmail"), sendCode: $("opsSendCode"), codeRow: $("opsCodeRow"), code: $("opsCode"), verify: $("opsVerify"),
      password: $("opsPassword"), passwordBtn: $("opsPasswordBtn"), siteSignIn: $("opsSiteSignIn"),
      browse: $("opsBrowse"), search: $("opsSearch"), searchBtn: $("opsSearchBtn"), streamPicks: $("opsStreamPicks"), formats: $("opsFormats"),
      list: $("opsList"), more: $("opsMore"), picked: $("opsPicked"), track: $("opsTrack"), stop: $("opsStop"), progress: $("opsProgress"), error: $("opsError"),
      runBar: $("opsRunBar"), runText: $("opsRunText"), runStop: $("opsRunStop"),
    };
    els.button.hidden = prefs.captureSessions !== true;
    els.button.addEventListener("click", open);
    els.close.addEventListener("click", () => (els.dialog.hidden = true));
    els.connect.addEventListener("click", () => busy(els.connect, async () => {
      await desktop.ops.configure(els.site.value);
      await refresh();
    }));
    els.siteSignIn.addEventListener("click", () => busy(els.siteSignIn, async () => {
      await desktop.ops.signInWithSite();
      await refresh();
    }));
    els.sendCode.addEventListener("click", () => busy(els.sendCode, async () => {
      await desktop.ops.sendCode(els.email.value);
      els.codeRow.hidden = false;
      els.code.focus();
      error("");
      els.progress.textContent = "";
    }));
    els.verify.addEventListener("click", () => busy(els.verify, async () => {
      await desktop.ops.verifyCode(els.email.value, els.code.value);
      els.code.value = "";
      await refresh();
    }));
    els.passwordBtn.addEventListener("click", () => busy(els.passwordBtn, async () => {
      const pw = els.password.value;
      els.password.value = ""; // not kept anywhere
      await desktop.ops.signInWithPassword(els.email.value, pw);
      await refresh();
    }));
    els.signOut.addEventListener("click", () => busy(els.signOut, async () => {
      await desktop.ops.signOut();
      sessions = [];
      picked.clear();
      await refresh();
    }));
    els.searchBtn.addEventListener("click", () => busy(els.searchBtn, () => load(true)));
    els.search.addEventListener("keydown", (e) => e.key === "Enter" && els.searchBtn.click());
    els.more.addEventListener("click", () => busy(els.more, () => load(false)));
    els.list.addEventListener("click", (e) => {
      const row = e.target.closest(".ops-row");
      if (row) togglePick(row.dataset.id);
    });
    els.track.addEventListener("click", () => trackSelected().catch((err) => error(errText(err))));
    els.stop.addEventListener("click", stop);
    els.runStop.addEventListener("click", stop);

    const savedStreams = Array.isArray(prefs.opsStreams) ? prefs.opsStreams : DEFAULT_STREAMS;
    els.streamPicks.innerHTML = STREAMS.map((s) => `<label><input type="checkbox" value="${s}"${savedStreams.includes(s) ? " checked" : ""} /> ${s}</label>`).join("");
    els.streamPicks.addEventListener("change", () => setPref("opsStreams", chosen(els.streamPicks)));
    const savedFormats = Array.isArray(prefs.opsFormats) ? prefs.opsFormats : DEFAULT_FORMATS;
    els.formats.innerHTML = MotionExport.FORMATS.map((f) => `<label title="${esc(f.detail || "")}"><input type="checkbox" value="${f.id}"${savedFormats.includes(f.id) ? " checked" : ""} /> ${esc(f.label)}</label>`).join("");
    els.formats.addEventListener("change", () => setPref("opsFormats", chosen(els.formats)));
  }

  function toggleShown() {
    if (!els.button) return;
    const shown = els.button.hidden;
    setPref("captureSessions", shown);
    els.button.hidden = !shown;
    if (shown) open();
    else els.dialog.hidden = true;
  }

  global.OpsSessions = { init, toggleShown, open };
})(window);
