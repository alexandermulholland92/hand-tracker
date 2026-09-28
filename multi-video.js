/**
 * multi-video.js — several videos at once (the cameras of a capture rig, say). Pick more
 * than one with Open Video…: each is tracked in turn (Capture Whole Video), then they're
 * lined up from the hand movement in them (video-sync.js).
 *  - They line up: their motion capture is saved on one shared clock, trimmed to the
 *    stretch every video covers, with a -sync.json report of the offsets; and the videos
 *    can go to the Recording Viewer's queue, each trimmed to that same stretch.
 *  - They don't: the reason is shown, and they can go to the motion capture queue (each
 *    video's motion capture saved on its own) and to the Recording Viewer's queue (each
 *    video converted on its own).
 * The motion capture queue also takes videos of its own (Add videos…); they're tracked
 * when it runs.
 *
 *   MultiVideo.init({ desktop, prefs, setPref });
 *   MultiVideo.open(files);   // File objects from a picker
 */

(function (global) {
  const DEFAULT_FORMATS = ["json"];
  let desktop = null, prefs = {}, setPref = () => {};
  let els = {};
  let items = []; // { name, file, url, path, duration, data, status, error }
  let result = null; // the last VideoSync.sync result
  let queue = []; // { name, file, url, path, data, status, ok }
  let running = false, stopRequested = false;

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v === null || v === undefined ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const errText = (err) => (err && err.message ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  const pad2 = (n) => String(n).padStart(2, "0");
  const clock = (s) => `${Math.floor((s || 0) / 60)}:${pad2(Math.floor((s || 0) % 60))}`;
  const baseOf = (name) => String(name).replace(/\.[^.]+$/, "") || "video";
  function stamp() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
  }
  const checked = (grid) => [...grid.querySelectorAll("input:checked")].map((i) => i.value);
  const handsText = (data) => (data && data.hands.length ? `${data.hands.map((h) => h.handedness).join(" + ")} · ${data.hands.reduce((n, h) => n + h.frames.length, 0)} frames` : "no hands");

  // A video from a picker: an address the page can play, and where it is on disk (desktop).
  function entry(file, taken) {
    let name = file.name;
    for (let n = 2; taken.has(name); n++) name = `${baseOf(file.name)} (${n})${file.name.slice(baseOf(file.name).length)}`;
    taken.add(name);
    return { name, file, url: URL.createObjectURL(file), path: desktop && desktop.pathForFile ? desktop.pathForFile(file) : "", duration: 0, data: null, status: "waiting", error: "" };
  }

  // Tracks one video's every frame; fills in its motion capture and length.
  async function track(item, show) {
    item.status = "tracking…";
    show();
    try {
      item.data = await HandTrackerApp.trackWholeVideo(item.name, item.url, {
        filePath: item.path,
        file: item.file,
        // At the video's own speed: played faster, many computers skip frames, and syncing
        // is only as precise as the frames it has.
        rate: 1,
        onProgress: (t, total) => {
          item.status = `tracking ${clock(t)} of ${clock(total)}`;
          show();
        },
      });
      item.duration = HandTracker.file.duration();
      item.status = stopRequested ? "stopped" : handsText(item.data);
    } catch (err) {
      item.error = errText(err);
      item.status = item.error;
    }
    show();
  }

  // Saves groups of files: on the desktop into one folder picked once; elsewhere each group
  // is saved (Android) or downloaded (browser) as usual. jobs: [{ baseName, files }]
  async function saveAll(title, jobs) {
    const results = [];
    if (desktop && desktop.chooseFolder) {
      const folder = await desktop.chooseFolder(title);
      if (!folder || folder.canceled) return { canceled: true, results };
      for (const job of jobs) results.push(...(await desktop.saveFilesTo(folder.token, job)).results);
      return { dir: folder.dir, results };
    }
    let dir = "", downloaded = 0;
    for (const job of jobs) {
      const res = await ExportUI.saveFiles({ title, ...job });
      if (res.downloaded) downloaded += res.count;
      else {
        results.push(...res.results);
        dir = res.dir || dir;
      }
    }
    return { dir, results, downloaded };
  }

  function savedText(res) {
    if (res.canceled) return "Canceled.";
    if (res.downloaded) return `Downloaded ${res.downloaded} file${res.downloaded === 1 ? "" : "s"}.`;
    const ok = res.results.filter((r) => r.ok).length;
    const failed = res.results.length - ok;
    return `${ok ? `Saved ${ok} file${ok === 1 ? "" : "s"} to ${res.dir}` : "Nothing was saved"}${failed ? `; ${failed} couldn't be saved.` : "."}`;
  }

  // ---------- several videos: track, then sync ----------
  function renderItems() {
    els.rows.innerHTML = items
      .map((it) => {
        const v = result && result.videos.find((x) => x.name === it.name);
        const lines = !v ? "" : v.reason ? "no" : v.name === result.reference ? "reference" : `${v.offset >= 0 ? "+" : "−"}${Math.abs(v.offset).toFixed(2)} s · match ${v.score.toFixed(2)}`;
        return `<tr><td title="${esc(it.name)}">${esc(it.name)}</td><td>${it.duration ? clock(it.duration) : ""}</td><td>${esc(it.status)}</td><td>${esc(lines)}</td></tr>`;
      })
      .join("");
  }

  // which: "videos" (several videos being tracked) or "queue" (the queue running).
  function setRunning(on, which) {
    running = on;
    els.stop.hidden = !(on && which === "videos");
    els.queueStop.hidden = !(on && which === "queue");
    els.close.disabled = on;
    for (const b of [els.saveBtn, els.viewerBtn, els.queueBtn, els.viewerQueueBtn, els.queueRun, els.queueAdd, els.queueClear]) b.disabled = on;
  }

  async function open(files) {
    if (running) return;
    if (!global.HandTrackerApp || !HandTrackerApp.trackWholeVideo) return;
    const old = items;
    const taken = new Set();
    items = files.map((f) => entry(f, taken));
    release(old);
    result = null;
    els.card.hidden = false;
    els.message.hidden = true;
    els.synced.hidden = true;
    els.failed.hidden = true;
    els.results.innerHTML = "";
    els.note.textContent = "";
    els.card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    stopRequested = false;
    setRunning(true, "videos");
    try {
      for (const [i, it] of items.entries()) {
        if (stopRequested) break;
        els.status.textContent = `Tracking every frame of video ${i + 1} of ${items.length}; then they're lined up from the hand movement.`;
        await track(it, renderItems);
      }
      await HandTrackerApp.backToCamera();
    } finally {
      setRunning(false);
    }
    els.status.textContent = "";
    if (stopRequested) {
      els.status.textContent = "Stopped.";
      return;
    }
    const tracked = items.filter((it) => it.data);
    if (tracked.length < 2) {
      showMessage(false, `The motion capture data doesn't line up: ${tracked.length ? "only one" : "none"} of the videos could be tracked, and syncing needs at least two.`);
      return;
    }
    result = VideoSync.sync(tracked.map((it) => ({ name: it.name, duration: it.duration, data: it.data })));
    renderItems();
    showMessage(result.ok, result.message);
  }

  function showMessage(ok, text) {
    els.message.hidden = false;
    els.message.className = `sync-message ${ok ? "ok" : "fail"}`;
    els.message.textContent = text;
    els.synced.hidden = !ok;
    els.failed.hidden = ok;
    if (ok) els.name.value = `synced-${stamp()}`;
  }

  // Synced: every video's motion capture on the shared clock, plus the offsets.
  async function saveSynced() {
    if (!result || !result.ok) return;
    const formats = checked(els.formats);
    if (!formats.length) return (els.note.textContent = "Pick at least one format.");
    const base = els.name.value.trim() || `synced-${stamp()}`;
    const jobs = [];
    try {
      for (const it of items) {
        const v = it.data && result.videos.find((x) => x.name === it.name);
        if (!v) continue;
        jobs.push({ baseName: `${base}-${baseOf(it.name)}`, files: MotionExport.build(VideoSync.align(it.data, v, result), formats, `${base}-${baseOf(it.name)}`) });
      }
    } catch (err) {
      return (els.note.textContent = `Couldn't convert: ${errText(err)}`);
    }
    const report = {
      reference: result.reference,
      shared_clock: "seconds from the moment every video was running; each video's trim_start_s is where that moment is in it",
      length_s: Math.round(result.window.length * 1e6) / 1e6,
      videos: result.videos.map((v) => ({ name: v.name, offset_s: Math.round(v.offset * 1e6) / 1e6, trim_start_s: Math.round(v.trimStart * 1e6) / 1e6, match: Math.round(v.score * 1000) / 1000 })),
    };
    jobs.push({ baseName: `${base}-sync`, files: [{ format: "json", ext: "json", suffix: "", data: JSON.stringify(report, null, 2) }] });
    await busy(els.saveBtn, async () => {
      const res = await saveAll("Choose a folder for the synced motion capture", jobs);
      if (res.results.length) ExportUI.renderResults(els.results, res.results);
      els.note.textContent = savedText(res);
    });
  }

  // The Recording Viewer's queue, trimmed to the shared stretch when synced.
  async function toViewer(synced) {
    const group = synced ? `synced-${stamp()}` : "";
    const list = items.filter((it) => !synced || (result && result.videos.some((v) => v.name === it.name && !v.reason)));
    await busy(synced ? els.viewerBtn : els.viewerQueueBtn, async () => {
      await VideoQueue.add(list.map((it) => {
        const v = synced && result.videos.find((x) => x.name === it.name);
        return { name: it.name, path: it.path, file: it.path ? null : it.file, group, trim: v ? { start: v.trimStart, length: result.window.length } : null };
      }));
      els.note.innerHTML = `Added ${list.length} video${list.length === 1 ? "" : "s"} to the Recording Viewer's queue${synced ? ", each trimmed to the stretch they share" : ""}. <a href="viewer.html" id="multiOpenViewer">Open the Recording Viewer</a>`;
      const link = $("multiOpenViewer"), header = document.querySelector('a[href="viewer.html"]');
      if (header && header.target) link.target = header.target;
    });
  }

  async function busy(btn, fn) {
    btn.disabled = true;
    try {
      await fn();
    } catch (err) {
      els.note.textContent = errText(err);
    } finally {
      btn.disabled = false;
    }
  }

  // Frees the addresses of videos that are neither on show nor in the queue any more.
  function release(list) {
    const kept = new Set([...items, ...queue].map((x) => x.url));
    for (const it of list) if (it.url && !kept.has(it.url)) URL.revokeObjectURL(it.url);
  }

  function close() {
    if (running) return;
    const old = items;
    items = [];
    release(old);
    result = null;
    els.card.hidden = true;
  }

  // ---------- motion capture queue: each video saved on its own ----------
  let queueRunning = false;

  function renderQueue() {
    els.queueCard.hidden = !queue.length;
    els.queueRows.innerHTML = queue
      .map((q, i) => `<li class="${q.ok === true ? "ok" : q.ok === false ? "fail" : ""}"><span class="mark">${q.ok === true ? "✓" : q.ok === false ? "✕" : "•"}</span><span class="name" title="${esc(q.name)}">${esc(q.name)}</span><span class="status">${esc(q.status)}</span>${queueRunning ? "" : `<button data-i="${i}" title="Take it out of the queue">Remove</button>`}</li>`)
      .join("");
  }

  function addToQueue(list) {
    const taken = new Set(queue.map((q) => q.name));
    for (const it of list) {
      if (taken.has(it.name)) continue;
      taken.add(it.name);
      queue.push({ ...it, status: it.data ? `tracked: ${handsText(it.data)}` : "waiting to be tracked", ok: undefined });
    }
    renderQueue();
    els.queueCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function runQueue() {
    const formats = checked(els.queueFormats);
    if (!formats.length) return (els.queueNote.textContent = "Pick at least one format.");
    const todo = queue.filter((q) => q.ok !== true);
    if (!todo.length) return (els.queueNote.textContent = "Everything in the queue has been saved.");
    let folder = null;
    if (desktop && desktop.chooseFolder) {
      folder = await desktop.chooseFolder("Choose a folder for the motion capture files");
      if (!folder || folder.canceled) return;
    }
    stopRequested = false;
    queueRunning = true;
    setRunning(true, "queue");
    renderQueue();
    const results = [];
    let dir = folder ? folder.dir : "", downloaded = 0, tracked = false;
    try {
      for (const q of todo) {
        if (stopRequested) break;
        if (!q.data) {
          tracked = true;
          await track(q, renderQueue);
          if (!q.data) {
            q.ok = false;
            continue;
          }
          if (stopRequested) {
            q.data = null; // only part of it was tracked
            q.status = "stopped";
            break;
          }
        }
        if (!q.data.hands.length) {
          q.ok = false;
          q.status = "no hands were seen in it";
          renderQueue();
          continue;
        }
        const baseName = `${baseOf(q.name)}-motion`;
        try {
          const job = { baseName, files: MotionExport.build(q.data, formats, baseName) };
          const res = folder ? await desktop.saveFilesTo(folder.token, job) : await ExportUI.saveFiles({ title: "Choose a folder for the motion capture files", ...job });
          if (res.downloaded) downloaded += res.count;
          else {
            results.push(...res.results);
            dir = res.dir || dir;
          }
          q.ok = res.downloaded ? true : res.results.length > 0 && res.results.every((r) => r.ok);
          q.status = q.ok ? `saved (${handsText(q.data)})` : "couldn't be saved";
        } catch (err) {
          q.ok = false;
          q.status = errText(err);
        }
        renderQueue();
      }
      if (tracked) await HandTrackerApp.backToCamera();
    } finally {
      queueRunning = false;
      setRunning(false);
      renderQueue();
    }
    if (results.length) ExportUI.renderResults(els.queueResults, results);
    els.queueNote.textContent = (stopRequested ? "Stopped. " : "") + savedText({ results, dir, downloaded });
  }

  function stop() {
    stopRequested = true;
    HandTrackerApp.stopTracking();
  }

  function init(opts) {
    desktop = opts.desktop || null;
    prefs = opts.prefs || {};
    setPref = opts.setPref || (() => {});
    els = {
      card: $("multiCard"), rows: $("multiRows"), status: $("multiStatus"), message: $("multiMessage"),
      synced: $("multiSynced"), name: $("multiName"), formats: $("multiFormatGrid"), saveBtn: $("multiSaveBtn"), viewerBtn: $("multiViewerBtn"),
      failed: $("multiFailed"), queueBtn: $("multiQueueBtn"), viewerQueueBtn: $("multiViewerQueueBtn"),
      results: $("multiResults"), note: $("multiNote"), stop: $("multiStop"), close: $("multiClose"),
      queueCard: $("queueCard"), queueRows: $("queueRows"), queueFormats: $("queueFormatGrid"), queueRun: $("queueRunBtn"),
      queueAdd: $("queueAddBtn"), queueClear: $("queueClearBtn"), queueStop: $("queueStopBtn"), queueInput: $("queueFileInput"),
      queueResults: $("queueResults"), queueNote: $("queueNote"),
    };
    if (!els.card) return;
    const grid = (el, key) => ExportUI.renderFormatGrid(el, MotionExport.FORMATS, Array.isArray(prefs[key]) ? prefs[key] : DEFAULT_FORMATS, (ids) => setPref(key, ids));
    grid(els.formats, "syncFormats");
    grid(els.queueFormats, "queueFormats");
    els.queueInput.accept = VideoFormats.IMPORT_ACCEPT;
    els.saveBtn.addEventListener("click", saveSynced);
    els.viewerBtn.addEventListener("click", () => toViewer(true));
    els.viewerQueueBtn.addEventListener("click", () => toViewer(false));
    els.queueBtn.addEventListener("click", () => {
      addToQueue(items);
      els.note.textContent = `Added ${items.length} video${items.length === 1 ? "" : "s"} to the motion capture queue (below).`;
    });
    els.stop.addEventListener("click", stop);
    els.close.addEventListener("click", close);
    els.queueRun.addEventListener("click", () => runQueue().catch((err) => (els.queueNote.textContent = errText(err))));
    els.queueStop.addEventListener("click", stop);
    els.queueAdd.addEventListener("click", () => els.queueInput.click());
    els.queueInput.addEventListener("change", () => {
      const taken = new Set(queue.map((q) => q.name));
      const files = [...els.queueInput.files];
      els.queueInput.value = "";
      addToQueue(files.map((f) => entry(f, taken)));
    });
    els.queueClear.addEventListener("click", () => {
      if (queueRunning) return;
      const old = queue;
      queue = [];
      release(old);
      els.queueResults.innerHTML = "";
      els.queueNote.textContent = "";
      renderQueue();
    });
    els.queueRows.addEventListener("click", (e) => {
      const i = e.target.dataset && e.target.dataset.i;
      if (i === undefined || queueRunning) return;
      const [gone] = queue.splice(Number(i), 1);
      release([gone]);
      renderQueue();
    });
  }

  global.MultiVideo = { init, open, isRunning: () => running };
})(window);
