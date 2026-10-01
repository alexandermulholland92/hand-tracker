/**
 * viewer.js — the Recording Viewer.
 * Opens motion recordings and converts them to other formats:
 *  - hand recordings: Hand Tracker JSON (current or older) and CSV (motion-import.js)
 *  - marker recordings: C3D files, and OptiTrack .tak takes read through the
 *    Motive installed on the PC (Windows app only, see electron/tak.js)
 * and shows a summary, playback, a frame table and — for hand recordings —
 * task-phase timelines, phase totals and wrist paths.
 * It also opens videos in nearly any format and converts them to any of the
 * formats in video-formats.js (Windows app: its ffmpeg; website and Android
 * app: ffmpeg.wasm, see video-convert.js).
 *
 * Several videos at once (chosen or dropped together, or sent from the tracker's
 * several-videos panel) go into an export queue (video-queue.js) and are converted one
 * after another, each on its own; synced ones trimmed to the stretch they share.
 *
 * window.RecordingViewer.openBytes(name, arrayBuffer) / openTake(path, name) /
 * openVideo(file) / queueVideos(files) are the same entry points the file pickers use;
 * the automated checks call them.
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const dropZone = $("dropZone");
  const fileInput = $("fileInput");
  const chooseBtn = $("chooseBtn");
  const videoBtn = $("videoBtn");
  const videoInput = $("videoInput");
  const fileNameEl = $("fileName");
  const resultsEl = $("results");

  // In the Android app the viewer replaces the tracker screen, so offer a way back.
  const cap = window.Capacitor;
  if (cap && cap.isNativePlatform && cap.isNativePlatform()) {
    const back = document.createElement("a");
    back.href = "index.html";
    back.textContent = "← Back to tracker";
    back.className = "back-link";
    document.querySelector("h1").before(back);
  }

  const PHASE_COLORS = {
    idle: "#666666",
    reach: "#74c0fc",
    grasp: "#f783ac",
    manipulate: "#ff922b",
    release: "#51cf66",
  };
  const HAND_COLORS = { Left: "#4dabf7", Right: "#ff922b" };
  const MARKER_COLORS = ["#4dabf7", "#ff922b", "#51cf66", "#f783ac", "#be8cfb", "#ffd43b"]; // matches the GLB export
  const CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
  ];
  const MAX_GAP_S = 0.25; // a hand isn't drawn across longer tracking gaps
  const PAGE_ROWS = 100;
  const phaseColor = (p) => PHASE_COLORS[p] || "#888888";
  const handColor = (h) => HAND_COLORS[h] || "#adb5bd";

  // Everything below comes from a user-chosen file, so it is escaped before
  // it goes anywhere near innerHTML.
  function esc(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const fmt = (v, digits = 3) => (Number.isFinite(v) ? v.toFixed(digits) : "—");

  let current = null; // { data, name, takPath?, takInfo? }
  let player = null;

  // ---------- opening files ----------
  chooseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    fileInput.click();
  });
  // Both pickers (and dropping) take recordings and videos; each file goes where it belongs.
  fileInput.accept = `${fileInput.accept},${VideoFormats.IMPORT_ACCEPT}`;
  videoInput.accept = VideoFormats.IMPORT_ACCEPT;
  videoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    videoInput.click();
  });
  dropZone.addEventListener("click", () => fileInput.click());
  for (const input of [fileInput, videoInput]) {
    input.addEventListener("change", (e) => {
      const files = [...e.target.files];
      input.value = "";
      openMany(files);
    });
  }
  ["dragover", "dragenter"].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add("drag"); })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove("drag"); })
  );
  dropZone.addEventListener("drop", (e) => openMany([...e.dataTransfer.files]));

  // One file opens; several videos go into the export queue, several recordings into the
  // recordings queue.
  function openMany(files) {
    const videos = files.filter((f) => !isRecording(f));
    const recordings = files.filter((f) => isRecording(f) && !/\.tak$/i.test(f.name));
    if (videos.length > 1) queueVideos(videos);
    if (recordings.length > 1) queueRecordings(recordings);
    if (videos.length > 1 || recordings.length > 1) return;
    if (files[0]) openAny(files[0]);
  }

  // Recordings are known by their extension; everything else is opened as a video (the
  // converter says so if there's no video in it), never parsed as motion data.
  const RECORDING_EXT = new RegExp(`\\.(${[...MotionImport.EXTENSIONS, "tak"].join("|")})$`, "i");
  const isRecording = (file) => RECORDING_EXT.test(file.name);

  // Explicit "convert several" pickers: everything picked is queued, even a single file.
  const convertVideoInput = $("convertVideoInput"), convertRecordingInput = $("convertRecordingInput");
  convertVideoInput.accept = VideoFormats.IMPORT_ACCEPT;
  for (const [btn, input] of [["convertVideosBtn", convertVideoInput], ["queueAddBtn", convertVideoInput], ["convertRecordingsBtn", convertRecordingInput], ["motionQueueAddBtn", convertRecordingInput]]) {
    $(btn).addEventListener("click", (e) => {
      e.stopPropagation();
      input.click();
    });
  }
  convertVideoInput.addEventListener("change", () => {
    const files = [...convertVideoInput.files];
    convertVideoInput.value = "";
    if (files.length) queueVideos(files);
  });
  convertRecordingInput.addEventListener("change", () => {
    const files = [...convertRecordingInput.files];
    convertRecordingInput.value = "";
    if (files.length) queueRecordings(files);
  });
  function openAny(file) {
    return isRecording(file) ? openFile(file) : openVideo(file);
  }

  function showError(message) {
    stopPlayer();
    releaseVideo();
    resultsEl.innerHTML = `<div class="card error">${esc(message)}</div>`;
  }

  async function openFile(file) {
    releaseVideo();
    fileNameEl.textContent = `Loaded: ${file.name}`;
    if (/\.tak$/i.test(file.name)) {
      const desktop = window.desktop;
      if (!desktop || !desktop.openTake) {
        showError("OptiTrack .tak files can only be opened in the Windows app, on a PC with OptiTrack Motive installed (Hand Tracker reads takes through Motive). In Motive, export the take as C3D (File → Export Tracking Data) and open the C3D here instead.");
        return;
      }
      return openTake(desktop.pathForFile(file), file.name);
    }
    try {
      await openBytes(file.name, await file.arrayBuffer());
    } catch (err) {
      showError(err.message);
    }
  }

  async function openBytes(name, buffer) {
    let parsed;
    try {
      parsed = await MotionImport.parseFileAsync(name, buffer);
    } catch (err) {
      showError(err.message);
      return false;
    }
    show(parsed, name);
    return true;
  }

  async function openTake(takPath, name) {
    stopPlayer();
    resultsEl.innerHTML = `<div class="card busy">Opening the take with OptiTrack Motive… this can take a few seconds.</div>`;
    try {
      const res = await window.desktop.openTake(takPath);
      const bytes = res.c3d;
      const parsed = MotionImport.fromC3D(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), name);
      parsed.data.source = "tak";
      parsed.data.name = res.info.name || parsed.data.name;
      show(parsed, name, { takPath, takInfo: res.info });
      return true;
    } catch (err) {
      showError(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      return false;
    }
  }

  function show({ data, warnings }, name, extra = {}) {
    stopPlayer();
    releaseVideo();
    current = { data, name, ...extra };
    const warn = warnings && warnings.length
      ? `<div class="card warn"><b>Imported with notes</b><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>`
      : "";
    if (data.kind === "markers") renderMarkers(data, warn);
    else renderHands(data, warn);
  }

  // ---------- shared cards ----------
  const playerCard = (title, caption) => `
    <div class="card">
      <div class="section-label">${title}</div>
      <canvas id="playCanvas" class="view" width="800" height="450"></canvas>
      <div class="player">
        <button id="playBtn">▶ Play</button>
        <input type="range" id="playSlider" min="0" max="1" step="0.001" value="0" aria-label="Playback position" />
        <span class="time" id="playTime"></span>
        <label>Speed <select id="playSpeed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select></label>
        <span id="playExtra"></span>
      </div>
      <div class="canvas-caption">${caption}</div>
    </div>`;

  // A box that starts collapsed: a header with a hint of what's inside and a Show/Hide button.
  const fold = (label, hint, body, extraClass = "card") => `
    <details class="fold ${extraClass}">
      <summary><span class="section-label">${label}</span><span class="fold-hint">${hint}</span><span class="fold-btn" aria-hidden="true"></span></summary>
      ${body}
    </details>`;

  const tableCard = (selectLabel, note = "", frames = 0) =>
    fold("Frames", `${frames} frame${frames === 1 ? "" : "s"}, by ${selectLabel.toLowerCase()}`, `
      ${note ? `<div class="note table-note">${note}</div>` : ""}
      <div class="toolbar"><label>${selectLabel} <select id="columnSelect"></select></label><span id="rowCount"></span></div>
      <div class="table-wrap"><table class="data-table"><thead id="tableHead"></thead><tbody id="tableBody"></tbody></table></div>
      <div class="more-row"><button id="moreRows">Show more</button><span>Click a row to jump there in the playback.</span></div>`);

  // The export formats, collapsed to one line naming the formats that are ticked.
  const formatsFold = () => fold("Formats", `<span id="formatsHint"></span>`, `<div class="format-grid" id="exportGrid"></div>`, "formats");

  function describeFormats() {
    const grid = $("exportGrid"), hint = $("formatsHint");
    if (!grid || !hint) return;
    const picked = [...grid.querySelectorAll("input:checked")].map((i) => i.closest("label").querySelector("span").firstChild.textContent);
    const total = grid.querySelectorAll("input:not(:disabled)").length;
    hint.textContent = !picked.length
      ? `none ticked · ${total} to choose from`
      : `${picked.length > 4 ? `${picked.slice(0, 4).join(", ")} and ${picked.length - 4} more` : picked.join(", ")} · ${total} to choose from`;
  }

  const exportCard = () => `
    <div class="card">
      <div class="section-label">Export</div>
      <label class="field">File name <input id="exportName" type="text" spellcheck="false" autocomplete="off" /></label>
      ${formatsFold()}
      <div class="export-actions"><button id="exportBtn" class="primary">Export…</button></div>
      <ul id="exportResults" class="results"></ul>
      <div id="exportNote" class="note"></div>
    </div>`;

  const renderNotes = (notes) =>
    Array.isArray(notes) && notes.length
      ? `<div class="card"><div class="section-label">Notes</div><ul class="notes-list">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>`
      : "";

  // ---------- playback ----------
  function stopPlayer() {
    if (player) player.stop();
    player = null;
  }

  // Generic player: draw(t) renders one moment; the controls drive t.
  function createPlayer(duration, draw) {
    const btn = $("playBtn"), slider = $("playSlider"), label = $("playTime"), speedSel = $("playSpeed");
    let t = 0, playing = false, raf = 0, last = 0;
    slider.max = String(Math.max(duration, 0.001));
    const render = () => {
      slider.value = String(t);
      label.textContent = `${t.toFixed(2)} / ${duration.toFixed(2)} s`;
      draw(t);
    };
    const tick = (now) => {
      if (!playing) return;
      t += ((now - last) / 1000) * Number(speedSel.value);
      last = now;
      if (t > duration) t = 0; // loop
      render();
      raf = requestAnimationFrame(tick);
    };
    const setPlaying = (on) => {
      playing = on && duration > 0;
      btn.textContent = playing ? "❚❚ Pause" : "▶ Play";
      cancelAnimationFrame(raf);
      if (playing) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };
    btn.addEventListener("click", () => setPlaying(!playing));
    slider.addEventListener("input", () => {
      t = Number(slider.value);
      render();
    });
    render();
    return {
      seek(time) {
        t = Math.min(Math.max(time, 0), duration);
        render();
      },
      redraw: render,
      stop: () => setPlaying(false),
      time: () => t,
    };
  }

  // Frame table with paging; rows(): [{ t, cells: [...] }], columns from header().
  // options: the column choices (strings, or { label } to show a different label); initial: starting choice.
  function setupTable(options, header, rowsFor, initial = 0) {
    const select = $("columnSelect");
    options.forEach((o, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = typeof o === "string" ? o : o.label;
      select.appendChild(opt);
    });
    select.value = String(initial);
    let rows = [], shown = 0;
    const head = $("tableHead"), body = $("tableBody"), more = $("moreRows"), count = $("rowCount");
    function appendRows() {
      const frag = document.createDocumentFragment();
      for (const r of rows.slice(shown, shown + PAGE_ROWS)) {
        const tr = document.createElement("tr");
        for (const c of r.cells) {
          const td = document.createElement("td");
          td.textContent = c;
          if (c === "—") td.className = "missing";
          tr.appendChild(td);
        }
        tr.addEventListener("click", () => player && player.seek(r.t));
        frag.appendChild(tr);
      }
      body.appendChild(frag);
      shown = Math.min(rows.length, shown + PAGE_ROWS);
      more.hidden = shown >= rows.length;
      count.textContent = `${shown} of ${rows.length} rows`;
    }
    function refresh() {
      const col = Number(select.value);
      head.innerHTML = "";
      const tr = document.createElement("tr");
      for (const h of header(col)) {
        const th = document.createElement("th");
        th.textContent = h;
        tr.appendChild(th);
      }
      head.appendChild(tr);
      rows = rowsFor(col);
      body.innerHTML = "";
      shown = 0;
      appendRows();
    }
    select.addEventListener("change", refresh);
    more.addEventListener("click", appendRows);
    refresh();
  }

  // Export panel: formats [{ id, label, detail, available, why }], run(ids, baseName) -> save result.
  function setupExport(formats, defaults, baseName, run) {
    ExportUI.renderFormatGrid($("exportGrid"), formats, defaults, describeFormats);
    describeFormats();
    $("exportName").value = baseName;
    const note = $("exportNote");
    const btn = $("exportBtn");
    if (window.mobile) btn.textContent = "Save";
    btn.addEventListener("click", async () => {
      const ids = ExportUI.checkedIds($("exportGrid"));
      if (!ids.length) {
        note.textContent = "Pick at least one format.";
        return;
      }
      const name = $("exportName").value.trim() || baseName;
      btn.disabled = true;
      note.textContent = "Exporting…";
      $("exportResults").innerHTML = "";
      try {
        const res = await run(ids, name);
        if (res.canceled) note.textContent = "Export canceled.";
        else if (res.downloaded) note.textContent = `Downloaded ${res.count} file${res.count === 1 ? "" : "s"}.`;
        else {
          ExportUI.renderResults($("exportResults"), res.results);
          const saved = res.results.filter((r) => r.ok).length;
          note.textContent = saved ? `Saved ${saved} file${saved === 1 ? "" : "s"} to ${res.dir}` : "Nothing was saved.";
        }
      } catch (err) {
        note.textContent = `Export failed: ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`;
      } finally {
        btn.disabled = false;
      }
    });
  }

  const baseNameOf = (name) => String(name || "recording").replace(/\.[^.]+$/, "");

  // ---------- motion capture as video ----------
  // The video formats, offered next to the motion formats: the recording's playback is drawn
  // frame by frame (MotionVideo) and converted like any video.
  const VIDEO_ID = "video:";
  const VIDEO_WIDTH = 1280;
  function withVideoFormats(motionFormats) {
    const motion = motionFormats.map((f) => ({ ...f, group: "Motion capture" }));
    if (!window.MotionVideo || !MotionVideo.supported()) return motion;
    const video = videoFormats(null).map((f) => ({ ...f, id: VIDEO_ID + f.id, group: `Video${f.group ? ` · ${f.group}` : ""}` }));
    return [...motion, ...video];
  }
  // Progress of a long export, under the Export button.
  const exportProgress = (text) => {
    const note = $("exportNote");
    if (note) note.textContent = text;
  };
  const splitIds = (ids) => ({ motion: ids.filter((id) => !id.startsWith(VIDEO_ID)), video: ids.filter((id) => id.startsWith(VIDEO_ID)).map((id) => id.slice(VIDEO_ID.length)) });

  // The playback drawn as a WebM at the recording's frame rate (at most 60 fps).
  async function sceneVideo(scene, progress) {
    const fps = Math.min(60, Math.max(1, Math.round(scene.rate || 30)));
    const frames = Math.max(1, Math.round(scene.duration * fps) + 1);
    const width = VIDEO_WIDTH, height = Math.round(VIDEO_WIDTH * scene.aspect);
    const blob = await MotionVideo.render({
      width, height, fps, frames,
      draw: (ctx, k) => scene.draw(ctx, ctx.canvas.width, ctx.canvas.height, k / fps),
      onProgress: (p) => progress && progress(`Drawing the video… ${Math.round(p * 100)}%`),
    });
    return { blob, fps, duration: frames / fps };
  }

  // Saves a recording's motion files and, for the video formats, its playback as video.
  // folder: a { token, dir } from desktop.chooseFolder (the queue picks one for all).
  async function saveRecording({ ids, baseName, build, scene, progress, folder = null }) {
    const { motion, video } = splitIds(ids);
    const desktop = window.desktop;
    const results = [];
    let dir = "", downloaded = 0;
    if (desktop && !folder && (video.length || motion.length)) {
      folder = await desktop.chooseFolder("Choose a folder for the exported files");
      if (!folder || folder.canceled) return { canceled: true };
    }
    if (motion.length) {
      const files = build(motion);
      if (folder) {
        const res = await desktop.saveFilesTo(folder.token, { baseName, files });
        results.push(...res.results);
        dir = res.dir || folder.dir;
      } else {
        const res = await ExportUI.saveFiles({ title: "Choose a folder for the exported files", baseName, files });
        if (res.downloaded) downloaded += res.count;
        else if (res.results) {
          results.push(...res.results);
          dir = res.dir || dir;
        }
      }
    }
    if (video.length) {
      const clip = await sceneVideo(scene, progress);
      if (folder) {
        const off = desktop.onExportProgress(({ format, index, total, progress: p }) => progress && progress(`Converting ${String(format).toUpperCase()} (${index + 1} of ${total})… ${Math.round((p || 0) * 100)}%`));
        try {
          const res = await desktop.exportVideo({ bytes: await clip.blob.arrayBuffer(), container: "webm", formats: video, baseName, duration: clip.duration, fps: clip.fps, retimeFps: 0, token: folder.token });
          results.push(...res.results);
          dir = res.dir || folder.dir;
        } finally {
          off();
        }
      } else {
        const saves = [];
        await VideoConvert.convert(clip.blob, video, {
          name: `${baseName}.webm`, fps: clip.fps, duration: clip.duration, constantRate: true, copyFromWebm: true,
          onProgress: ({ format, index, total, progress: p, loading }) => progress && progress(loading ? "Loading the video converter (about 32 MB, only the first time)…" : `Converting ${String(format).toUpperCase()} (${index + 1} of ${total})… ${Math.round((p || 0) * 100)}%`),
          onResult: (r) => saves.push(keepResult(r, baseName)),
        });
        const saved = await Promise.all(saves);
        results.push(...saved);
        dir = (saved.find((r) => r.dir) || {}).dir || dir;
        if (!window.mobile) downloaded += saved.filter((r) => r.ok).length;
      }
    }
    if (downloaded && !results.length) return { downloaded: true, count: downloaded };
    return { dir, results };
  }

  // ---------- hand recordings ----------
  function renderHands(data, warn) {
    const hands = data.hands;
    const lastT = (h) => (h.frames.length ? num(h.frames[h.frames.length - 1].t) : 0);
    const duration = num(data.duration, 0) || Math.max(0, ...hands.map(lastT));
    const totalFrames = hands.reduce((n, h) => n + h.frames.length, 0);
    const handNames = hands.map((h) => h.handedness || "—").join(" + ") || "—";
    const recorded = data.recorded_at ? new Date(data.recorded_at) : null;
    const mirrored = data.display_mirrored !== false;

    resultsEl.innerHTML = `
      ${warn}
      <div class="card">
        <div class="section-label">Summary</div>
        <div class="summary-grid">
          <div class="summary-item"><div class="value">${esc(handNames)}</div><div class="label">Hands</div></div>
          <div class="summary-item"><div class="value">${totalFrames}</div><div class="label">Frames</div></div>
          <div class="summary-item"><div class="value">${duration.toFixed(2)}s</div><div class="label">Duration</div></div>
          <div class="summary-item"><div class="value">${data.frame_rate != null ? esc(num(data.frame_rate)) : "—"}</div><div class="label">Frame Rate</div></div>
          ${recorded && !isNaN(recorded) ? `<div class="summary-item"><div class="value">${esc(recorded.toLocaleString())}</div><div class="label">Recorded</div></div>` : ""}
        </div>
      </div>

      ${playerCard("Playback", `${hands.map((h) => `<span style="color:${handColor(h.handedness)}">■ ${esc(h.handedness || "Hand")}</span>`).join(" &nbsp; ")} &nbsp;•&nbsp; ${mirrored ? "mirrored, as shown in the app" : "camera view"}`)}

      <div class="card">
        <div class="section-label">Task Phases Over Time</div>
        ${hands.map((h) => renderHandTimeline(h, duration)).join("")}
        <div class="time-axis"><span>0s</span><span>${(duration / 2).toFixed(1)}s</span><span>${duration.toFixed(1)}s</span></div>
      </div>

      <div class="card">
        <div class="section-label">Time in Each Phase</div>
        ${renderPhaseTable(hands, duration)}
      </div>

      <div class="card">
        <div class="section-label">Hand Movement Path (${mirrored ? "mirrored view, as shown in the app" : "camera view"})</div>
        <canvas id="trajCanvas" class="view" width="780" height="360"></canvas>
        <div class="canvas-caption">
          ${hands.map((h) => `<span style="color:${handColor(h.handedness)}">■ ${esc(h.handedness || "Hand")}</span>`).join(" &nbsp; ")}
          &nbsp;•&nbsp; ○ start &nbsp;•&nbsp; ● end &nbsp;•&nbsp; camera-frame position, not calibrated 3D space
        </div>
      </div>

      ${tableCard("Joint", "Joint positions are measured <b>from the wrist</b>, so the wrist joint is always 0, 0, 0. <b>Wrist world</b> is where the wrist is in the camera image (x and y as fractions of the frame's width and height). Its z is always 0: the tracker measures each joint's depth relative to the wrist, and a single camera can't measure the wrist's own distance.", totalFrames)}
      ${exportCard()}
      ${renderNotes(data.notes)}
    `;

    drawTrajectories(hands, mirrored, data.image_size);
    setupHandPlayer(data, duration);
    setupHandTable(data);
    setupExport(withVideoFormats(MotionExport.FORMATS), ["bvh"], baseNameOf(current.name), (ids, name) =>
      saveRecording({ ids, baseName: name, build: (motionIds) => MotionExport.build(data, motionIds, name), scene: handScene(data), progress: exportProgress })
    );
  }

  // Index of the frame shown at time t (the last one at or before t), or -1.
  function frameAt(frames, t) {
    let lo = 0, hi = frames.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (num(frames[mid].t) <= t + 1e-9) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  function phaseOfFrame(hand) {
    const phases = new Array(hand.frames.length).fill("idle");
    for (const seg of hand.task_segments || []) {
      for (let i = Math.max(0, seg.start_frame); i <= seg.end_frame && i < phases.length; i++) phases[i] = seg.phase;
    }
    return phases;
  }

  // A hand recording, one moment at a time, on any canvas: the playback, or each frame of a
  // video made from it. Sizes are an 800-wide picture's, scaled to the canvas.
  function handScene(data) {
    const [iw, ih] = Array.isArray(data.image_size) ? data.image_size : [1280, 720];
    const mirrored = data.display_mirrored !== false;
    const phases = data.hands.map(phaseOfFrame);
    const lastT = (h) => (h.frames.length ? num(h.frames[h.frames.length - 1].t) : 0);
    return {
      aspect: ih / iw,
      duration: num(data.duration, 0) || Math.max(0, ...data.hands.map(lastT)),
      rate: num(data.frame_rate, 0) || 30,
      draw(ctx, W, H, t) {
        const k = W / 800;
        const toCanvas = (x, y) => [(mirrored ? 1 - x : x) * W, y * H];
        ctx.fillStyle = "#0e0f12";
        ctx.fillRect(0, 0, W, H);
        data.hands.forEach((hand, h) => {
          const color = handColor(hand.handedness);
          const ee = (hand.trajectories && hand.trajectories.end_effector) || [];
          // Faint full wrist path for context.
          ctx.strokeStyle = `${color}40`;
          ctx.lineWidth = 1.5 * k;
          ctx.beginPath();
          ee.forEach((p, i) => {
            const [x, y] = toCanvas(num(p[1]), num(p[2]));
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.stroke();

          const i = frameAt(hand.frames, t);
          if (i < 0 || t - num(hand.frames[i].t) > MAX_GAP_S || !ee[i]) return; // not tracked at t
          if (!Array.isArray(hand.frames[i].joints) || hand.frames[i].joints.length < 21) return; // malformed frame
          const w = ee[i];
          const pts = hand.frames[i].joints.map((j) => toCanvas(num(w[1]) + num(j.position[0]), num(w[2]) + num(j.position[1])));
          ctx.strokeStyle = color;
          ctx.lineWidth = 2.5 * k;
          ctx.lineCap = "round";
          for (const [a, b] of CONNECTIONS) {
            ctx.beginPath();
            ctx.moveTo(...pts[a]);
            ctx.lineTo(...pts[b]);
            ctx.stroke();
          }
          ctx.fillStyle = "#ff3355";
          for (const [x, y] of pts) {
            ctx.beginPath();
            ctx.arc(x, y, 3.5 * k, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.font = `600 ${13 * k}px 'Segoe UI', system-ui, sans-serif`;
          ctx.fillStyle = color;
          ctx.textAlign = "center";
          ctx.fillText(`${hand.handedness || "Hand"} · ${phases[h][i]}`, pts[0][0], Math.min(H - 6 * k, pts[0][1] + 22 * k));
        });
      },
    };
  }

  function setupHandPlayer(data, duration) {
    const canvas = $("playCanvas");
    const scene = handScene(data);
    canvas.height = Math.round(canvas.width * scene.aspect);
    const ctx = canvas.getContext("2d");
    player = createPlayer(duration, (t) => scene.draw(ctx, canvas.width, canvas.height, t));
  }

  function setupHandTable(data) {
    const joints = MotionExport.JOINTS;
    const phases = data.hands.map(phaseOfFrame);
    setupTable(
      // Joint positions are measured from the wrist, so the wrist joint itself is always 0, 0, 0.
      joints.map((j) => (j === "wrist" ? { label: "wrist (origin: always 0)" } : j)),
      (j) => ["hand", "frame", "t (s)", "phase", "wrist world x", "wrist world y", "wrist world z", `${joints[j]} x (from wrist)`, `${joints[j]} y (from wrist)`, `${joints[j]} z (from wrist)`],
      (j) => {
        const rows = [];
        data.hands.forEach((hand, h) => {
          const ee = (hand.trajectories && hand.trajectories.end_effector) || [];
          hand.frames.forEach((f, i) => {
            const w = ee[i] || [];
            const p = (f.joints && f.joints[j] && f.joints[j].position) || [];
            rows.push({ t: num(f.t), cells: [hand.handedness || "Hand", String(i), num(f.t).toFixed(3), phases[h][i], fmt(num(w[1], NaN), 4), fmt(num(w[2], NaN), 4), fmt(num(w[3], NaN), 4), fmt(num(p[0], NaN), 4), fmt(num(p[1], NaN), 4), fmt(num(p[2], NaN), 4)] });
          });
        });
        return rows.sort((a, b) => a.t - b.t);
      },
      joints.indexOf("index_tip")
    );
  }

  // Segment start/end times, using the frame timestamps (shared clock in v2).
  function segmentTimes(hand, seg, duration) {
    const frames = hand.frames || [];
    const start = frames[seg.start_frame];
    const end = frames[seg.end_frame];
    const frameDur = hand.frame_rate ? 1 / num(hand.frame_rate, 30) : 1 / 30;
    const t0 = start ? num(start.t) : 0;
    const t1 = end ? Math.min(num(end.t) + frameDur, duration) : t0; // never past the end of the recording
    return [t0, Math.max(t0, t1)];
  }

  function renderHandTimeline(hand, duration) {
    const segments = Array.isArray(hand.task_segments) ? hand.task_segments : [];
    const frames = hand.frames || [];
    const title = `
      <div class="hand-title">
        <span style="color:${handColor(hand.handedness)}">${esc(hand.handedness || "Hand")}</span>
        <small>${frames.length} frames${hand.frame_rate ? ` · ${esc(num(hand.frame_rate))} fps` : ""}</small>
      </div>`;
    if (!segments.length || !frames.length || duration <= 0) {
      return `<div class="hand-row">${title}<div style="opacity:0.4; font-size:12.5px;">No phase data for this hand.</div></div>`;
    }
    const bars = segments.map((seg) => {
      const [t0, t1] = segmentTimes(hand, seg, duration);
      const left = Math.max(0, (t0 / duration) * 100);
      const width = Math.max(0.2, Math.min(100 - left, ((t1 - t0) / duration) * 100));
      return `<div class="timeline-seg" title="${esc(seg.phase)}: ${t0.toFixed(2)}–${t1.toFixed(2)}s" style="left:${left}%; width:${width}%; background:${phaseColor(seg.phase)}">${width > 8 ? esc(seg.phase) : ""}</div>`;
    }).join("");
    return `<div class="hand-row">${title}<div class="timeline-bar">${bars}</div></div>`;
  }

  // Totals per phase (rather than one row per segment, which can run to hundreds).
  function renderPhaseTable(hands, duration) {
    const rows = [];
    for (const hand of hands) {
      const totals = {};
      for (const seg of hand.task_segments || []) {
        const [t0, t1] = segmentTimes(hand, seg, duration);
        const entry = totals[seg.phase] || (totals[seg.phase] = { time: 0, count: 0 });
        entry.time += Math.max(0, t1 - t0);
        entry.count++;
      }
      for (const [phase, { time, count }] of Object.entries(totals).sort((a, b) => b[1].time - a[1].time)) {
        rows.push(`
          <tr>
            <td style="color:${handColor(hand.handedness)}">${esc(hand.handedness || "Hand")}</td>
            <td><span class="legend-dot" style="background:${phaseColor(phase)}"></span>${esc(phase)}</td>
            <td>${time.toFixed(2)}s</td>
            <td>${count}</td>
          </tr>`);
      }
    }
    if (!rows.length) return `<div style="opacity:0.4; font-size:12.5px;">No phase data in this file.</div>`;
    return `<table class="phase-table"><thead><tr><th>Hand</th><th>Phase</th><th>Total time</th><th>Segments</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  }

  function drawTrajectories(hands, mirrored, imageSize) {
    const canvas = $("trajCanvas");
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height, pad = 24;
    ctx.clearRect(0, 0, W, H);
    const [iw, ih] = Array.isArray(imageSize) ? imageSize : [1280, 720];
    const aspect = ih / iw; // landmark y is a fraction of the height, x of the width

    const paths = hands
      .map((h) => ({
        hand: h,
        points: ((h.trajectories && h.trajectories.end_effector) || [])
          .filter((p) => Array.isArray(p) && Number.isFinite(p[1]) && Number.isFinite(p[2]))
          .map((p) => [mirrored ? 1 - p[1] : p[1], p[2] * aspect]), // match how the recording looked on screen
      }))
      .filter((p) => p.points.length > 1);

    if (!paths.length) {
      ctx.fillStyle = "#666";
      ctx.font = "13px sans-serif";
      ctx.fillText("No trajectory data.", pad, pad + 10);
      return;
    }

    // One uniform scale for both axes (and both hands) so shapes aren't distorted.
    const all = paths.flatMap((p) => p.points);
    const minX = Math.min(...all.map((p) => p[0])), maxX = Math.max(...all.map((p) => p[0]));
    const minY = Math.min(...all.map((p) => p[1])), maxY = Math.max(...all.map((p) => p[1]));
    const scale = Math.min((W - pad * 2) / (maxX - minX || 1e-3), (H - pad * 2) / (maxY - minY || 1e-3));
    const offX = (W - (maxX - minX) * scale) / 2;
    const offY = (H - (maxY - minY) * scale) / 2;
    const toCanvas = ([x, y]) => [offX + (x - minX) * scale, offY + (y - minY) * scale];

    for (const { hand, points } of paths) {
      const color = handColor(hand.handedness);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      points.forEach((p, i) => {
        const [cx, cy] = toCanvas(p);
        if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
      });
      ctx.stroke();

      const [sx, sy] = toCanvas(points[0]);
      const [ex, ey] = toCanvas(points[points.length - 1]);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(ex, ey, 5, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ---------- marker recordings (C3D, OptiTrack .tak) ----------
  const VIEWS = {
    front: { label: "Front", axes: [0, 2], names: ["X", "Z"] }, // Z-up: X across, Z up
    side: { label: "Side", axes: [1, 2], names: ["Y", "Z"] },
    top: { label: "Top", axes: [0, 1], names: ["X", "Y"] },
  };

  function markerAt(md, k, m) {
    const i = (k * md.labels.length + m) * 3;
    const p = [md.positions[i], md.positions[i + 1], md.positions[i + 2]];
    return p.every(Number.isFinite) ? p : null;
  }

  function renderMarkers(md, warn) {
    const tak = current.takInfo;
    const tracked = md.labels.map((_, m) => {
      let n = 0;
      for (let k = 0; k < md.frame_count; k++) if (markerAt(md, k, m)) n++;
      return n;
    });
    const coverage = md.frame_count && md.labels.length ? tracked.reduce((a, b) => a + b, 0) / (md.frame_count * md.labels.length) : 0;
    const sourceText = md.source === "tak" ? `OptiTrack take (read with Motive ${tak && tak.motiveVersion ? esc(tak.motiveVersion.split(".").slice(0, 2).join(".")) : ""})`
      : md.source === "c3d" ? "C3D file" : md.source === "motive-csv" ? "OptiTrack Motive CSV" : md.source === "trc" ? "TRC file" : `${esc(String(md.source).toUpperCase())} marker file`;

    resultsEl.innerHTML = `
      ${warn}
      <div class="card">
        <div class="section-label">Summary · ${sourceText}</div>
        <div class="summary-grid">
          <div class="summary-item"><div class="value">${md.labels.length}</div><div class="label">Markers</div></div>
          <div class="summary-item"><div class="value">${md.frame_count}</div><div class="label">Frames</div></div>
          <div class="summary-item"><div class="value">${md.duration.toFixed(2)}s</div><div class="label">Duration</div></div>
          <div class="summary-item"><div class="value">${esc(Math.round(md.frame_rate * 100) / 100)}</div><div class="label">Frame Rate</div></div>
          <div class="summary-item"><div class="value">${Math.round(coverage * 100)}%</div><div class="label">Tracked</div></div>
          ${tak ? `<div class="summary-item"><div class="value">${tak.rigidBodies}</div><div class="label">Rigid Bodies</div></div><div class="summary-item"><div class="value">${tak.skeletons}</div><div class="label">Skeletons</div></div>` : ""}
        </div>
      </div>

      ${playerCard("Playback", "Marker positions in millimetres (Z-up) · the tail shows the last half second")}

      ${fold("Markers", `${md.labels.length} marker${md.labels.length === 1 ? "" : "s"} · tracked frames and coverage for each`, `
        <table class="phase-table"><thead><tr><th>Marker</th><th>Tracked frames</th><th>Coverage</th></tr></thead><tbody>
          ${md.labels.slice(0, 200).map((l, m) => `<tr><td><span class="legend-dot" style="background:${MARKER_COLORS[m % MARKER_COLORS.length]}"></span>${esc(l)}</td><td>${tracked[m]}</td><td>${md.frame_count ? Math.round((tracked[m] / md.frame_count) * 100) : 0}%</td></tr>`).join("")}
        </tbody></table>
        ${md.labels.length > 200 ? `<div class="note">…and ${md.labels.length - 200} more.</div>` : ""}`)}

      ${tableCard("Marker", "", md.frame_count)}
      ${exportCard()}
      ${renderNotes(md.notes)}
    `;

    setupMarkerPlayer(md);
    setupMarkerTable(md);
    setupMarkerExport(md);
  }

  // A marker recording, one moment at a time, on any canvas (playback and video export),
  // seen from one side (view) and with or without labels. Sizes are an 800-wide picture's.
  function markerScene(md, options = () => ({ view: "front", labels: false })) {
    // Bounds of every tracked sample, per axis, for a stable fit.
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < md.positions.length; i += 3) {
      if (!Number.isFinite(md.positions[i])) continue;
      for (let d = 0; d < 3; d++) {
        min[d] = Math.min(min[d], md.positions[i + d]);
        max[d] = Math.max(max[d], md.positions[i + d]);
      }
    }
    const trail = Math.max(1, Math.round(md.frame_rate / 2));
    return {
      aspect: 450 / 800,
      duration: md.duration,
      rate: md.frame_rate,
      draw(ctx, W, H, t) {
        const sc = W / 800, pad = 28 * sc;
        const opt = options();
        const view = VIEWS[opt.view] || VIEWS.front;
        const [a, b] = view.axes;
        const spanA = max[a] - min[a] || 1, spanB = max[b] - min[b] || 1;
        const s = Math.min((W - pad * 2) / spanA, (H - pad * 2) / spanB);
        const ox = (W - spanA * s) / 2, oy = (H - spanB * s) / 2;
        const toCanvas = (p) => [ox + (p[a] - min[a]) * s, H - (oy + (p[b] - min[b]) * s)]; // up is up
        ctx.fillStyle = "#0e0f12";
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "#555";
        ctx.font = `${11 * sc}px 'Segoe UI', system-ui, sans-serif`;
        ctx.textAlign = "left";
        ctx.fillText(`${view.label} view · ${view.names[0]} → , ${view.names[1]} ↑ · ${(Math.max(spanA, spanB) / 1000).toFixed(2)} m across`, 10 * sc, 16 * sc);

        const k = Math.min(md.frame_count - 1, Math.max(0, Math.round(t * md.frame_rate)));
        md.labels.forEach((label, m) => {
          const color = MARKER_COLORS[m % MARKER_COLORS.length];
          // Short trail of recent positions.
          ctx.strokeStyle = `${color}55`;
          ctx.lineWidth = 1.5 * sc;
          ctx.beginPath();
          let drawing = false;
          for (let j = Math.max(0, k - trail); j <= k; j++) {
            const p = markerAt(md, j, m);
            if (!p) { drawing = false; continue; }
            const [x, y] = toCanvas(p);
            if (drawing) ctx.lineTo(x, y); else ctx.moveTo(x, y);
            drawing = true;
          }
          ctx.stroke();
          const p = markerAt(md, k, m);
          if (!p) return;
          const [x, y] = toCanvas(p);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(x, y, 5 * sc, 0, Math.PI * 2);
          ctx.fill();
          if (opt.labels) {
            ctx.fillStyle = "#c9c9cf";
            ctx.fillText(label, x + 8 * sc, y - 6 * sc);
          }
        });
      },
    };
  }

  function setupMarkerPlayer(md) {
    const canvas = $("playCanvas");
    const ctx = canvas.getContext("2d");
    const extra = $("playExtra");
    extra.innerHTML = `<label>View <select id="viewSelect">${Object.entries(VIEWS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}</select></label> <label><input type="checkbox" id="labelsToggle" /> Labels</label>`;
    const viewSelect = $("viewSelect"), labelsToggle = $("labelsToggle");
    // The video export draws what the playback shows: the same view, labels or not.
    current.sceneOptions = () => ({ view: viewSelect.value, labels: labelsToggle.checked });
    const scene = markerScene(md, current.sceneOptions);
    player = createPlayer(md.duration, (t) => scene.draw(ctx, canvas.width, canvas.height, t));
    viewSelect.addEventListener("change", () => player.redraw());
    labelsToggle.addEventListener("change", () => player.redraw());
  }

  function setupMarkerTable(md) {
    setupTable(
      md.labels,
      (m) => ["frame", "t (s)", "markers tracked", `${md.labels[m]} x`, `${md.labels[m]} y`, `${md.labels[m]} z`],
      (m) => {
        const rows = [];
        for (let k = 0; k < md.frame_count; k++) {
          let n = 0;
          for (let j = 0; j < md.labels.length; j++) if (markerAt(md, k, j)) n++;
          const p = markerAt(md, k, m) || [NaN, NaN, NaN];
          const t = k / md.frame_rate;
          rows.push({ t, cells: [String(md.first_frame + k), t.toFixed(3), `${n}/${md.labels.length}`, fmt(p[0], 2), fmt(p[1], 2), fmt(p[2], 2)] });
        }
        return rows;
      }
    );
  }

  function setupMarkerExport(md) {
    const baseName = baseNameOf(current.name);
    const takPath = current.takPath;
    if (!takPath) {
      setupExport(withVideoFormats(MotionExport.MARKER_FORMATS), ["trc"], baseName, (ids, name) =>
        saveRecording({ ids, baseName: name, build: (motionIds) => MotionExport.buildMarkers(md, motionIds, name), scene: markerScene(md, current.sceneOptions), progress: exportProgress })
      );
      return;
    }
    // From a .tak: Motive's own exporters where it has one; Hand Tracker's for the rest.
    const hasSkeleton = current.takInfo && current.takInfo.skeletons > 0;
    const formats = [
      { id: "c3d", label: "C3D", detail: "via Motive · Vicon, Visual3D, Mokka" },
      { id: "trc", label: "TRC", detail: "via Motive · OpenSim" },
      { id: "csv", label: "CSV", detail: "via Motive · markers + rigid bodies" },
      { id: "fbx", label: "FBX", detail: "via Motive · Maya, MotionBuilder, Unity" },
      { id: "bvh", label: "BVH", detail: hasSkeleton ? "via Motive · skeleton animation" : "needs a skeleton in the take", available: hasSkeleton, why: "This take has no skeleton; Motive can only write BVH for skeletons." },
      { id: "glb", label: "GLB (glTF)", detail: "Animated 3D markers · Blender, Unity" },
      { id: "npz", label: "NPZ", detail: "NumPy arrays · Python, ML" },
      { id: "json", label: "JSON", detail: "Plain data · any language" },
    ];
    const OURS = ["glb", "npz", "json"];
    setupExport(formats, ["c3d"], baseName, (ids, name) =>
      window.desktop.exportTake({
        path: takPath,
        formats: ids.filter((id) => !OURS.includes(id)),
        baseName: name,
        title: "Choose a folder for the exported files",
        extraFiles: MotionExport.buildMarkers(md, ids.filter((id) => OURS.includes(id)), name),
      })
    );
  }

  // ---------- videos: open nearly any format, convert to any other ----------
  let video = null; // { file, path, urls: [] } while a video is open
  let converting = false;

  function releaseVideo() {
    if (!video) return;
    if (converting) cancelConversion();
    for (const url of video.urls) URL.revokeObjectURL(url);
    video = null;
  }

  const cleanError = (err) => String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

  // Resolves true once the page can show the video's first frame.
  function playsHere(el, url) {
    return new Promise((resolve) => {
      const done = (ok) => {
        clearTimeout(timer);
        el.removeEventListener("loadeddata", onData);
        el.removeEventListener("error", onError);
        resolve(ok);
      };
      const onData = () => done(el.videoWidth > 0);
      const onError = () => done(false);
      const timer = setTimeout(() => done(false), 8000);
      el.addEventListener("loadeddata", onData);
      el.addEventListener("error", onError);
      el.src = url;
      el.load();
    });
  }

  function videoFormats(appInfo) {
    if (window.desktop) {
      const ffmpeg = !appInfo || appInfo.ffmpeg;
      return VideoFormats.FORMATS.map((f) => ({ ...f, available: ffmpeg, why: ffmpeg ? "" : "ffmpeg wasn't found" }));
    }
    return VideoConvert.supported() ? VideoConvert.formats() : [];
  }

  // filePath: where the file is on disk (Windows app); found from the file when not given.
  async function openVideo(file, filePath) {
    stopPlayer();
    releaseVideo();
    current = null;
    fileNameEl.textContent = `Loaded: ${file.name}`;
    const desktop = window.desktop;
    video = { file, path: filePath || (desktop && desktop.pathForFile ? desktop.pathForFile(file) : ""), urls: [] };
    const mine = video;
    const size = ExportUI.formatBytes(file.size);
    resultsEl.innerHTML = `
      <div class="card">
        <div class="section-label">Video</div>
        <video id="videoPreview" class="preview" controls playsinline></video>
        <div id="videoMeta" class="video-meta"><b>${esc(file.name)}</b> · ${size}</div>
        <div id="videoStatus" class="note"></div>
      </div>
      <div class="card">
        <div class="section-label">Convert to</div>
        <label class="field">File name <input id="exportName" type="text" spellcheck="false" autocomplete="off" /></label>
        ${formatsFold()}
        <div class="export-actions">
          <button id="exportBtn" class="primary">${window.mobile ? "Convert and save" : desktop ? "Export…" : "Convert and download"}</button>
          <button id="cancelBtn" hidden>Cancel</button>
        </div>
        <div id="exportProgress" class="progress" hidden><div class="progress-bar"><div id="progressFill" class="progress-fill"></div></div><span id="progressLabel"></span></div>
        <ul id="exportResults" class="results"></ul>
        <div id="exportNote" class="note"></div>
      </div>`;
    const preview = $("videoPreview"), status = $("videoStatus"), meta = $("videoMeta");
    $("exportName").value = baseNameOf(file.name);

    const appInfo = desktop ? await desktop.getInfo().catch(() => null) : null;
    const formats = videoFormats(appInfo);
    if (formats.length) {
      ExportUI.renderFormatGrid($("exportGrid"), formats, ["mp4"], describeFormats);
      describeFormats();
    } else {
      $("exportBtn").disabled = true;
      $("exportNote").textContent = "This browser can't run the video converter (it needs WebAssembly). Try Chrome, Edge, Firefox or Safari, or the Windows app.";
    }
    if (!desktop && formats.length) {
      $("exportNote").textContent = window.mobile
        ? "Converts on this phone and saves to Documents/Hand Tracker. The converter downloads once (about 32 MB). Long videos take a while; HEVC and AV1 need the Windows app."
        : "Converts in this browser; nothing is uploaded. The converter downloads once (about 32 MB), and each file downloads when it's ready. Long videos take a while; HEVC and AV1 need the Windows app.";
    }
    $("exportBtn").addEventListener("click", () => exportVideoFile(mine));
    $("cancelBtn").addEventListener("click", cancelConversion);

    // Details: the Windows app asks ffmpeg; elsewhere the video element knows the basics.
    const describe = (info) => {
      if (video !== mine) return;
      const parts = [`<b>${esc(file.name)}</b>`, size];
      if (info.duration) parts.push(`${info.duration.toFixed(1)} s`);
      if (info.width) parts.push(`${info.width} × ${info.height}`);
      if (info.fps) parts.push(`${Math.round(info.fps * 100) / 100} fps`);
      if (info.videoCodec) parts.push(esc(info.videoCodec));
      if (info.hasAudio !== undefined) parts.push(info.hasAudio ? "with sound" : "no sound");
      meta.innerHTML = parts.join(" · ");
    };
    if (desktop && video.path) desktop.probeVideo(video.path).then(describe).catch(() => {});

    // Preview: play it directly if the page can; otherwise convert a playable copy.
    const direct = URL.createObjectURL(file);
    video.urls.push(direct);
    if (await playsHere(preview, direct)) {
      if (!desktop) describe({ duration: preview.duration, width: preview.videoWidth, height: preview.videoHeight });
      return true;
    }
    if (video !== mine) return false;
    try {
      if (desktop && desktop.importVideo && video.path) {
        status.textContent = "Making a preview copy this page can play…";
        const off = desktop.onImportProgress(({ progress }) => (status.textContent = `Making a preview copy this page can play… ${Math.round(progress * 100)}%`));
        try {
          const res = await desktop.importVideo(video.path);
          if (video === mine) preview.src = res.url;
        } finally {
          off();
        }
      } else if (VideoConvert.supported()) {
        status.textContent = "Making a preview copy this page can play…";
        const blob = await VideoConvert.toPlayable(file, ({ progress, loading }) => {
          status.textContent = loading ? "Loading the video converter (about 32 MB, only the first time)…" : `Making a preview copy this page can play… ${Math.round(progress * 100)}%`;
        });
        if (video !== mine) return false;
        const url = URL.createObjectURL(blob);
        video.urls.push(url);
        preview.src = url;
        VideoConvert.probe(file).then(describe).catch(() => {});
      } else {
        throw new Error("this browser can't play or convert it");
      }
      if (video === mine) status.textContent = "";
      return true;
    } catch (err) {
      if (video === mine) status.textContent = `Couldn't preview this video (${cleanError(err)}). You can still try converting it.`;
      return false;
    }
  }

  // A format converted in the page: saved on the phone, or downloaded in a browser.
  function keepResult(r, baseName) {
    if (!r.ok) return Promise.resolve(r);
    if (window.mobile) {
      return window.mobile
        .saveFiles({ baseName, files: [{ format: r.format, suffix: r.suffix, ext: r.ext, data: r.data }] })
        .then((s) => ({ ...s.results[0], dir: s.dir }))
        .catch((err) => ({ format: r.format, ok: false, error: cleanError(err) }));
    }
    const fileName = `${baseName}${r.suffix}.${r.ext}`;
    ExportUI.downloadBlob(new Blob([r.data]), fileName);
    return Promise.resolve({ format: r.format, ok: true, path: fileName, size: r.data.size === undefined ? r.data.length : r.data.size });
  }

  function renderConversionProgress({ format, index, total, progress, loading }) {
    $("progressFill").style.width = `${Math.round(((index + (progress || 0)) / total) * 100)}%`;
    $("progressLabel").textContent = loading
      ? "Loading the video converter (about 32 MB, only the first time)…"
      : `Converting ${String(format).toUpperCase()} (${index + 1} of ${total})… ${Math.round((progress || 0) * 100)}%`;
  }

  function setConverting(on) {
    converting = on;
    $("exportBtn").disabled = on;
    $("cancelBtn").hidden = !on;
    $("exportProgress").hidden = !on;
    for (const input of $("exportGrid").querySelectorAll("input")) input.disabled = on || input.closest(".unavailable") !== null;
  }

  function cancelConversion() {
    if (window.desktop) window.desktop.cancelExport();
    else VideoConvert.cancel();
  }

  async function exportVideoFile(mine) {
    if (converting || video !== mine) return;
    const ids = ExportUI.checkedIds($("exportGrid"));
    const note = $("exportNote");
    if (!ids.length) {
      note.textContent = "Pick at least one format.";
      return;
    }
    const baseName = $("exportName").value.trim() || baseNameOf(mine.file.name);
    const desktop = window.desktop;
    setConverting(true);
    $("progressFill").style.width = "0%";
    $("progressLabel").textContent = desktop ? "Choose a folder…" : "Starting…";
    $("exportResults").innerHTML = "";
    note.textContent = "";
    try {
      let res;
      if (desktop) {
        const off = desktop.onExportProgress(renderConversionProgress);
        try {
          res = await desktop.convertVideoFile({ path: mine.path, formats: ids, baseName });
        } finally {
          off();
        }
        if (res.canceled && !res.results.length) {
          note.textContent = "Export canceled.";
          return;
        }
      } else {
        // Each file is saved (phone) or downloaded (browser) as soon as it's converted.
        const saves = [];
        const out = await VideoConvert.convert(mine.file, ids, {
          onProgress: renderConversionProgress,
          onResult: (r) => saves.push(keepResult(r, baseName)),
        });
        const results = await Promise.all(saves);
        const dir = (results.find((r) => r.dir) || {}).dir;
        res = { results, canceled: out.canceled, dir };
      }
      ExportUI.renderResults($("exportResults"), res.results);
      const saved = res.results.filter((r) => r.ok).length;
      const failed = res.results.length - saved;
      note.textContent =
        (saved ? (desktop || window.mobile ? `Saved ${saved} file${saved === 1 ? "" : "s"} to ${res.dir}` : `Downloaded ${saved} file${saved === 1 ? "" : "s"}`) : "Nothing was saved") +
        (res.canceled ? " (canceled)." : failed ? `; ${failed} couldn't be converted.` : ".");
    } catch (err) {
      note.textContent = `Conversion failed: ${cleanError(err)}`;
    } finally {
      if (video === mine) setConverting(false);
      else converting = false;
    }
  }

  // ---------- export queue: videos converted one after another (video-queue.js) ----------
  const queueEls = {
    card: $("queueCard"), list: $("queueList"), grid: $("queueGrid"), convert: $("queueConvertBtn"), cancel: $("queueCancelBtn"),
    clear: $("queueClearBtn"), progress: $("queueProgress"), fill: $("queueFill"), label: $("queueLabel"), results: $("queueResults"), note: $("queueNote"),
  };
  const QUEUE_FORMATS_KEY = "hand-tracker:viewer-queue-formats";
  let queueRunning = false, queueCanceled = false;
  const clockText = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;

  async function queueVideos(files) {
    const desktop = window.desktop;
    try {
      await VideoQueue.add(files.map((f) => ({ name: f.name, path: desktop && desktop.pathForFile ? desktop.pathForFile(f) : "", file: f })));
      queueEls.note.textContent = `Added ${files.length} video${files.length === 1 ? "" : "s"} to the export queue.`;
    } catch (err) {
      queueEls.note.textContent = `Couldn't add them to the queue: ${cleanError(err)}`;
    }
    await renderQueue();
    queueEls.card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  let queueFormatsShown = false;
  async function renderQueue() {
    let items = [];
    try {
      items = await VideoQueue.list();
    } catch {
      // no database here (a private window, say): nothing is queued
    }
    queueEls.card.hidden = !items.length && !queueRunning && !queueEls.results.children.length;
    queueEls.list.innerHTML = items
      .map((q) => {
        const trim = q.trim ? ` · synced: ${clockText(q.trim.start)} for ${clockText(q.trim.length)}` : "";
        return `<li><span class="name" title="${esc(q.name)}">${esc(q.name)}</span><span class="status">${q.size ? ExportUI.formatBytes(q.size) : ""}${esc(trim)}</span>${queueRunning ? "" : `<button data-id="${esc(q.id)}">Remove</button>`}</li>`;
      })
      .join("") || '<li><span class="name">The queue is empty.</span></li>';
    queueEls.convert.disabled = queueRunning || !items.length;
    queueEls.clear.disabled = queueRunning || !items.length;
    if (!queueFormatsShown && items.length) {
      queueFormatsShown = true;
      const appInfo = window.desktop ? await window.desktop.getInfo().catch(() => null) : null;
      let saved = ["mp4"];
      try {
        saved = JSON.parse(localStorage.getItem(QUEUE_FORMATS_KEY)) || saved;
      } catch {
        // storage unavailable: MP4
      }
      ExportUI.renderFormatGrid(queueEls.grid, videoFormats(appInfo), saved, (ids) => {
        try {
          localStorage.setItem(QUEUE_FORMATS_KEY, JSON.stringify(ids));
        } catch {
          // not remembered
        }
      });
    }
  }

  async function convertQueue() {
    if (queueRunning) return;
    const ids = ExportUI.checkedIds(queueEls.grid);
    if (!ids.length) return (queueEls.note.textContent = "Pick at least one format.");
    const items = await VideoQueue.list();
    if (!items.length) return;
    const desktop = window.desktop;
    let folder = null;
    if (desktop) {
      folder = await desktop.chooseFolder("Choose a folder for the converted videos");
      if (!folder || folder.canceled) return;
    }
    queueRunning = true;
    queueCanceled = false;
    queueEls.cancel.hidden = false;
    queueEls.progress.hidden = false;
    queueEls.results.innerHTML = "";
    queueEls.note.textContent = "";
    await renderQueue();
    const all = [];
    let dir = folder ? folder.dir : "", done = 0;
    for (const [n, q] of items.entries()) {
      if (queueCanceled) break;
      const baseName = baseNameOf(q.name) + (q.trim ? "-synced" : "");
      const show = ({ format, index, total, progress, loading }) => {
        queueEls.fill.style.width = `${Math.round(((n + (index + (progress || 0)) / total) / items.length) * 100)}%`;
        queueEls.label.textContent = loading
          ? "Loading the video converter (about 32 MB, only the first time)…"
          : `${q.name} (${n + 1} of ${items.length}): ${String(format).toUpperCase()}… ${Math.round((progress || 0) * 100)}%`;
      };
      let res;
      try {
        if (desktop) {
          if (!q.path) throw new Error("this app can't find the file on disk; open it here to convert it");
          const off = desktop.onExportProgress(show);
          try {
            res = await desktop.convertVideoFile({ path: q.path, formats: ids, baseName, token: folder.token, trim: q.trim });
          } finally {
            off();
          }
        } else {
          const saves = [];
          const out = await VideoConvert.convert(q.file, ids, { name: q.name, trim: q.trim, onProgress: show, onResult: (r) => saves.push(keepResult(r, baseName)) });
          const results = await Promise.all(saves);
          dir = (results.find((r) => r.dir) || {}).dir || dir;
          res = { results, canceled: out.canceled };
        }
      } catch (err) {
        res = { results: [{ format: q.name, ok: false, error: cleanError(err) }] };
      }
      all.push(...res.results.map((r) => ({ ...r, format: `${q.name}: ${String(r.format).toUpperCase()}` })));
      ExportUI.renderResults(queueEls.results, all);
      if (res.canceled) queueCanceled = true;
      // Done with it: out of the queue. Anything that failed stays for another go.
      if (res.results.length && res.results.every((r) => r.ok)) {
        done++;
        await VideoQueue.remove(q.id).catch(() => {});
      }
    }
    queueRunning = false;
    queueEls.cancel.hidden = true;
    queueEls.progress.hidden = true;
    const saved = all.filter((r) => r.ok).length;
    queueEls.note.textContent =
      `${queueCanceled ? "Canceled. " : ""}Converted ${done} of ${items.length} video${items.length === 1 ? "" : "s"}; ` +
      (saved ? (desktop || window.mobile ? `saved ${saved} file${saved === 1 ? "" : "s"} to ${dir}` : `downloaded ${saved} file${saved === 1 ? "" : "s"}`) : "nothing was saved") + ".";
    await renderQueue();
  }

  queueEls.convert.addEventListener("click", () => convertQueue().catch((err) => {
    queueRunning = false;
    queueEls.note.textContent = `Conversion failed: ${cleanError(err)}`;
    renderQueue();
  }));
  queueEls.cancel.addEventListener("click", () => {
    queueCanceled = true;
    cancelConversion();
  });
  queueEls.clear.addEventListener("click", async () => {
    if (queueRunning) return;
    await VideoQueue.clear().catch(() => {});
    queueEls.results.innerHTML = "";
    queueEls.note.textContent = "";
    renderQueue();
  });
  queueEls.list.addEventListener("click", async (e) => {
    const id = e.target.dataset && e.target.dataset.id;
    if (!id || queueRunning) return;
    await VideoQueue.remove(Number(id)).catch(() => {});
    renderQueue();
  });
  VideoQueue.onChange(renderQueue);
  renderQueue();

  // ---------- converting several recordings ----------
  // Any motion capture file to the formats picked: hand recordings to any of the seven,
  // marker recordings to the six that hold markers. Each is read only when it's converted.
  const motionEls = {
    card: $("motionQueueCard"), list: $("motionQueueList"), grid: $("motionQueueGrid"), convert: $("motionQueueConvertBtn"),
    clear: $("motionQueueClearBtn"), results: $("motionQueueResults"), note: $("motionQueueNote"),
  };
  const MOTION_FORMATS_KEY = "hand-tracker:viewer-motion-formats";
  const MARKER_IDS = MotionExport.MARKER_FORMATS.map((f) => f.id);
  let motionQueue = []; // File
  let motionRunning = false;

  function queueRecordings(files) {
    const known = new Set(motionQueue.map((f) => `${f.name}:${f.size}`));
    const added = files.filter((f) => isRecording(f) && !/\.tak$/i.test(f.name) && !known.has(`${f.name}:${f.size}`));
    motionQueue.push(...added);
    const skipped = files.length - added.length;
    motionEls.note.textContent = `Added ${added.length} recording${added.length === 1 ? "" : "s"}.` + (skipped ? ` ${skipped} left out (already in the list, an OptiTrack .tak, or not a recording).` : "");
    renderMotionQueue();
    motionEls.card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  let motionFormatsShown = false;
  function renderMotionQueue() {
    motionEls.card.hidden = !motionQueue.length && !motionRunning && !motionEls.results.children.length;
    motionEls.list.innerHTML = motionQueue
      .map((f, i) => `<li><span class="name" title="${esc(f.name)}">${esc(f.name)}</span><span class="status">${ExportUI.formatBytes(f.size)}</span>${motionRunning ? "" : `<button data-i="${i}">Remove</button>`}</li>`)
      .join("") || '<li><span class="name">Nothing to convert yet.</span></li>';
    motionEls.convert.disabled = motionRunning || !motionQueue.length;
    motionEls.clear.disabled = motionRunning;
    if (!motionFormatsShown && motionQueue.length) {
      motionFormatsShown = true;
      let saved = ["csv", "c3d"];
      try {
        saved = JSON.parse(localStorage.getItem(MOTION_FORMATS_KEY)) || saved;
      } catch {
        // not remembered
      }
      ExportUI.renderFormatGrid(motionEls.grid, withVideoFormats(MotionExport.FORMATS), saved, (ids) => {
        try {
          localStorage.setItem(MOTION_FORMATS_KEY, JSON.stringify(ids));
        } catch {
          // not remembered
        }
      });
    }
  }

  async function convertRecordings() {
    if (motionRunning) return;
    const ids = ExportUI.checkedIds(motionEls.grid);
    if (!ids.length) return (motionEls.note.textContent = "Pick at least one format.");
    const desktop = window.desktop;
    let folder = null;
    if (desktop && desktop.chooseFolder) {
      folder = await desktop.chooseFolder("Choose a folder for the converted recordings");
      if (!folder || folder.canceled) return;
    }
    motionRunning = true;
    motionEls.results.innerHTML = "";
    motionEls.note.textContent = "";
    renderMotionQueue();
    const all = [], left = [];
    let dir = folder ? folder.dir : "", done = 0;
    const items = [...motionQueue];
    for (const [n, file] of items.entries()) {
      motionEls.note.textContent = `Converting ${file.name} (${n + 1} of ${items.length})…`;
      const baseName = file.name.replace(/\.[^.]+$/, "");
      try {
        const { data } = await MotionImport.parseFileAsync(file.name, await file.arrayBuffer());
        const markers = data.kind === "markers";
        const use = markers ? ids.filter((id) => MARKER_IDS.includes(id) || id.startsWith(VIDEO_ID)) : ids;
        // The file's own format again only when it's a different kind of file (C3D -> CSV, not C3D -> C3D).
        const ext = (file.name.match(/\.([a-z0-9]+)$/i) || [])[1].toLowerCase();
        const wanted = use.filter((id) => id !== ext);
        if (!wanted.length) throw new Error(markers && ids.includes("bvh") ? "it holds markers, which can't become BVH (that needs a skeleton)" : "nothing to convert it to (the formats picked are its own)");
        const res = await saveRecording({
          ids: wanted, baseName, folder,
          build: (motionIds) => (markers ? MotionExport.buildMarkers(data, motionIds, baseName) : MotionExport.build(data, motionIds, baseName)),
          scene: markers ? markerScene(data) : handScene(data),
          progress: (text) => (motionEls.note.textContent = `${file.name} (${n + 1} of ${items.length}): ${text}`),
        });
        if (res && res.dir) dir = res.dir;
        const results = res && res.results && res.results.length ? res.results : [{ ok: true, format: "files", path: `${baseName} (downloaded)`, size: 0 }];
        all.push(...results.map((r) => ({ ...r, format: `${file.name}: ${String(r.format).toUpperCase()}` })));
        if (markers && ids.includes("bvh") && ext !== "bvh") all.push({ ok: false, format: `${file.name}: BVH`, error: "markers can't become BVH (that needs a skeleton)" });
        if (results.every((r) => r.ok)) done++;
        else left.push(file);
      } catch (err) {
        all.push({ ok: false, format: file.name, error: cleanError(err) });
        left.push(file);
      }
      ExportUI.renderResults(motionEls.results, all);
    }
    motionQueue = left; // done ones leave the list; anything that failed stays for another go
    motionRunning = false;
    const saved = all.filter((r) => r.ok).length;
    motionEls.note.textContent = `Converted ${done} of ${items.length} recording${items.length === 1 ? "" : "s"}; ` +
      (saved ? (desktop || window.mobile ? `saved ${saved} file${saved === 1 ? "" : "s"}${dir ? ` to ${dir}` : ""}` : `downloaded ${saved} file${saved === 1 ? "" : "s"}`) : "nothing was saved") + ".";
    renderMotionQueue();
  }

  motionEls.convert.addEventListener("click", () => convertRecordings().catch((err) => {
    motionRunning = false;
    motionEls.note.textContent = `Conversion failed: ${cleanError(err)}`;
    renderMotionQueue();
  }));
  motionEls.clear.addEventListener("click", () => {
    if (motionRunning) return;
    motionQueue = [];
    motionEls.results.innerHTML = "";
    motionEls.note.textContent = "";
    renderMotionQueue();
  });
  motionEls.list.addEventListener("click", (e) => {
    const i = e.target.dataset && e.target.dataset.i;
    if (i === undefined || motionRunning) return;
    motionQueue.splice(Number(i), 1);
    renderMotionQueue();
  });

  window.RecordingViewer = {
    openBytes,
    openTake,
    openVideo,
    openAny,
    queueVideos,
    queueRecordings,
    current: () => current,
  };
})();
