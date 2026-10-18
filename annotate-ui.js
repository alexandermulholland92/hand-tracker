/**
 * annotate-ui.js — the Recording Viewer's Annotate (Windows, Mac and Linux app): for a take (its
 * JSON) or a video opened there, its cameras' picture quality, Claude's steps (each labelled as an
 * instruction, described, with its kind, its share of hands in sight and its picture's verdict),
 * the useful footage, and a review of each step: approve or reject it, edit it, add a subtask.
 * The work is electron/annotate.js's; what's kept is <take>.annotations.json beside the take
 * (saved as the review goes), and <take>.annotations.csv when asked.
 *
 *   AnnotateUI.card()                                // its markup
 *   AnnotateUI.attach({ path, take, video, player }) // path: the take's JSON or the video, on disk;
 *        take: the take's data (for its task); video: the page's <video> of it (a video opened), or
 *        player: the viewer's playback (a take) — the card then plays the main camera's video itself
 *
 * Keys, with a step picked (not while typing): j / k the next / previous step, a approve, r reject,
 * e edit, , / . a second back / on.
 */
(function (global) {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v === null || v === undefined ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const errText = (err) => (err && err.message ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const long = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${Math.round(s)}s`);
  const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;
  const KIND_NAMES = { task: "hands-on task", setup: "setup", waiting: "waiting", screen: "screen", idle: "transition or idle" };
  let st = null;

  function card() {
    return `
      <div class="card" id="annCard">
        <div class="section-label">Annotate</div>
        <div class="note">Claude divides the main camera's video into steps and labels and describes each one; Hand Tracker checks each camera's pictures (blurry, too dark or too bright), each step's share of hands in sight, and works out the useful footage. Review each step here: <b>a</b> approve, <b>r</b> reject, <b>e</b> edit, <b>j</b>/<b>k</b> next and previous. It's kept beside the take as it goes.</div>
        <div class="toolbar">
          <label>Task <input id="annTask" type="text" spellcheck="false" autocomplete="off" placeholder="What was recorded (optional)" style="min-width:16em" /></label>
          <label>Main camera <select id="annPrimary"></select></label>
        </div>
        <div class="toolbar">
          <button id="annRun" class="primary">Annotate…</button>
          <button id="annKey">Claude API key…</button>
          <span id="annStatus" class="status"></span>
        </div>
        <div id="annConfirm" class="toolbar" hidden><span id="annEstimate"></span><button id="annGo" class="primary">Start</button><button id="annNo">Not now</button></div>
        <div id="annBusy" class="toolbar" hidden><span id="annProgress"></span><button id="annCancel">Cancel</button></div>
        <div id="annKeyRow" class="toolbar" hidden>
          <input id="annKeyInput" type="password" autocomplete="off" spellcheck="false" placeholder="Your Claude API key (sk-ant-…)" style="flex:1" />
          <button id="annKeySave" class="primary">Keep it</button><button id="annKeyForget">Forget it</button>
          <span class="note">Kept on this computer, encrypted. Only the main camera's frames go to Anthropic's API, charged to your key.</span>
        </div>
        <video id="annVideo" class="preview" controls playsinline hidden></video>
        <div id="annResults"></div>
      </div>`;
  }

  async function attach({ path, take = null, video = null, player = null } = {}) {
    const d = global.desktop && global.desktop.annotate;
    const box = $("annCard");
    if (!box) return;
    if (!d || !path) {
      box.hidden = true;
      return;
    }
    st = { path, take, video, player, files: null, annotations: null, selected: null, editing: null, saveTimer: null, mainUrl: "" };
    const mine = st;
    if (take && take.metadata && take.metadata.task) $("annTask").value = take.metadata.task;
    const status = await d.status().catch(() => ({ hasKey: false }));
    showKey(status.hasKey);
    try {
      st.files = await d.find(path);
    } catch (err) {
      say(errText(err));
      $("annRun").disabled = true;
      return;
    }
    if (st !== mine) return;
    const sel = $("annPrimary");
    sel.innerHTML = st.files.videos.map((v, i) => `<option value="${esc(v.camera)}"${/head/i.test(v.camera) || (i === 0 && !st.files.videos.some((x) => /head/i.test(x.camera))) ? " selected" : ""}>${esc(v.camera || "This video")}</option>`).join("");
    sel.disabled = st.files.videos.length < 2;
    if (!st.files.videos.length) {
      $("annRun").disabled = true;
      say("No camera video beside this take (<take>-video-<camera>.mp4): annotating needs its video.");
    }
    sel.addEventListener("change", () => showMainVideo());
    $("annRun").addEventListener("click", () => estimate());
    $("annNo").addEventListener("click", () => ($("annConfirm").hidden = true));
    $("annGo").addEventListener("click", () => run());
    $("annCancel").addEventListener("click", () => d.cancel());
    $("annKey").addEventListener("click", () => ($("annKeyRow").hidden = !$("annKeyRow").hidden));
    $("annKeySave").addEventListener("click", async () => {
      try {
        showKey(await d.setKey($("annKeyInput").value));
        $("annKeyInput").value = "";
        $("annKeyRow").hidden = true;
      } catch (err) {
        say(errText(err));
      }
    });
    $("annKeyForget").addEventListener("click", async () => {
      showKey(await d.setKey("").catch(() => false));
      $("annKeyRow").hidden = true;
    });
    $("annResults").addEventListener("click", onClick);
    $("annResults").addEventListener("change", onChange);
    // Annotations kept beside it already: shown at once.
    const kept = await d.load(path).catch(() => null);
    if (st !== mine) return;
    if (kept) {
      st.annotations = kept.annotations;
      $("annRun").textContent = "Annotate again…";
      render();
      say(`Kept beside the take: ${kept.file.split(/[\\/]/).pop()}`);
      if (kept.annotations.source && kept.annotations.source.session && !st.files.videos.length) say(`A capture session's, from Capture Sessions (annotate it again there): ${kept.file.split(/[\\/]/).pop()}`);
    }
    showMainVideo();
  }

  // ---------- running it ----------
  function showKey(has) {
    $("annKey").textContent = has ? "Claude API key ✓" : "Claude API key…";
    st && (st.hasKey = has);
  }
  const say = (text) => ($("annStatus").textContent = text || "");
  const primary = () => $("annPrimary").value;
  const mainPath = () => {
    const v = (st.files && st.files.videos) || [];
    return (v.find((x) => x.camera === primary()) || v[0] || {}).path || "";
  };

  async function estimate() {
    const d = global.desktop.annotate;
    if (!st.hasKey) {
      $("annKeyRow").hidden = false;
      return say("Add your Claude API key first.");
    }
    try {
      const e = await d.estimate(mainPath() || st.path);
      $("annEstimate").textContent = `About ${e.minutes} minutes of video: Claude (Opus 5.5) looks at ${e.chunks} one-minute stretch${e.chunks === 1 ? "" : "es"}, about $${e.dollars.toFixed(2)} of your API credit. `;
      $("annConfirm").hidden = false;
    } catch (err) {
      say(errText(err));
    }
  }

  async function run() {
    const d = global.desktop.annotate, mine = st;
    $("annConfirm").hidden = true;
    $("annBusy").hidden = false;
    $("annRun").disabled = true;
    say("");
    const off = d.onProgress((p) => {
      $("annProgress").textContent = p.stage === "quality"
        ? `Checking ${p.camera ? `the ${p.camera} camera's` : "the"} pictures (${p.index + 1} of ${p.total})… ${pct(p.progress)}`
        : `Claude: stretch ${Math.min(p.total, p.index + 1)} of ${p.total}…`;
    });
    try {
      const a = await d.run(mainPath() || st.path, { task: $("annTask").value.trim(), primary: primary() });
      if (st !== mine) return;
      st.annotations = a;
      st.selected = null;
      render();
      await save();
      $("annRun").textContent = "Annotate again…";
    } catch (err) {
      say(errText(err));
    } finally {
      off();
      $("annBusy").hidden = true;
      $("annRun").disabled = false;
    }
  }

  // The card's own video (a take: its main camera's; a capture session's, streamed from the
  // dashboard as Capture Sessions does), or the page's.
  async function showMainVideo() {
    if (st.video) return;
    const p = mainPath(), el = $("annVideo");
    const session = st.annotations && st.annotations.source && st.annotations.source.session;
    try {
      if (p) el.src = (await global.desktop.annotate.media(p)).url;
      else if (session && global.desktop.ops) {
        const main = (st.annotations.source.videos.find((v) => v.primary) || {}).camera;
        const stream = session.streams.find((x) => x.camera === main) || session.streams[0];
        if (!stream) return;
        el.src = (await global.desktop.ops.stream(session.id, stream.path)).url;
      } else return;
      el.hidden = false;
    } catch {
      el.hidden = true;
    }
  }
  const media = () => st.video || (!$("annVideo").hidden ? $("annVideo") : null);
  function seek(t) {
    const v = media();
    if (v) v.currentTime = Math.max(0, t);
    if (st.player && st.player.seek) st.player.seek(t);
  }
  const now = () => {
    const v = media();
    return v ? v.currentTime : st.player && st.player.time ? st.player.time() : 0;
  };

  // ---------- what it found ----------
  function render() {
    const a = st.annotations;
    if (!a) return;
    const duration = (a.source.videos.find((v) => v.primary) || a.source.videos[0] || {}).duration || 0;
    a.useful = AnnotateCore.useful(duration, a.segments);
    if (st.take) st.take.annotations = a; // (so the take's exports, its JSON and MCAP, carry them)
    const u = a.useful;
    const counts = { pending: 0, approved: 0, rejected: 0 };
    for (const s of a.segments) counts[s.review || "pending"] = (counts[s.review || "pending"] || 0) + 1;
    const cams = a.quality.cameras.map((c) => `<tr><td>${esc(c.camera || "video")}${c.primary ? " (main)" : ""}</td><td class="q-${c.verdict}">${c.verdict}</td><td>${pct(c.bad)}</td><td>${pct(c.blur)}</td><td>${pct(c.dark)}</td><td>${pct(c.bright)}</td><td>${c.longestBad}s</td><td>${pct(c.covered)}</td>` +
      `<td>${(c.spec || []).map((x) => `<span class="${x.ok ? "q-pass" : "q-fail"}">${x.ok ? "✓" : "✗"} ${esc(x.check)}</span>`).join(" ")}</td></tr>`).join("");
    const bar = a.segments.filter((s) => !s.parent).map((s) => `<div class="ann-bar-seg kind-${s.kind}${s.review === "rejected" ? " rejected" : ""}" title="${esc(clock(s.start))}–${esc(clock(s.end))} ${esc(s.label)}" data-seek="${s.start}" style="left:${(s.start / duration) * 100}%;width:${((s.end - s.start) / duration) * 100}%;opacity:${0.35 + 0.65 * (Number(s.hands) || 0)}"></div>`).join("");
    $("annResults").innerHTML = `
      <div class="section-label">Picture quality</div>
      <table class="phase-table"><thead><tr><th>Camera</th><th>Verdict</th><th>Bad</th><th>Blurry</th><th>Dark</th><th>Bright</th><th>Longest bad</th><th>Looked at</th><th>Spec</th></tr></thead><tbody>${cams}</tbody></table>
      <div class="section-label">Useful footage</div>
      <div class="ann-useful"><b>${long(u.useful)}</b> · ${pct(u.share)} of ${long(u.recorded)} recorded: hands-on work with hands in sight.</div>
      <div class="ann-breakdown">Recorded ${long(u.recorded)} · hands not in sight −${long(u.handsOut)} · setup −${long(u.setup)} · waiting or idle −${long(u.waiting)} · screen −${long(u.screen)}${u.rejected ? ` · rejected −${long(u.rejected)}` : ""} · <b>useful ${long(u.useful)}</b></div>
      <div class="ann-bar">${bar}</div>
      <div class="ann-legend">${Object.entries(KIND_NAMES).map(([k, n]) => `<span><i class="kind-${k}"></i>${n}</span>`).join("")} <span class="note">fainter: fewer hands in sight</span></div>
      <div class="section-label">Steps <span class="note">${a.segments.length} · ${counts.approved} approved · ${counts.rejected} rejected · ${counts.pending} to review</span></div>
      <div class="toolbar"><button id="annCsv">Save the table (CSV)</button><span id="annSaved" class="status"></span></div>
      <div id="annSegs" class="ann-segs">${a.segments.map(segHtml).join("")}</div>
      ${(a.notes || []).length ? `<div class="note">${a.notes.map(esc).join("<br>")}</div>` : ""}
      <div class="note">${esc(a.made.model)}${a.made.task ? ` · task: ${esc(a.made.task)}` : ""} · hands in sight from ${a.made.handsFrom === "take" ? "the take's tracking" : "Claude's look at each frame"} · ${esc(new Date(a.made.at).toLocaleString())}</div>`;
    const csv = $("annCsv");
    if (csv) csv.addEventListener("click", saveCsv);
  }

  function segHtml(s) {
    const q = s.quality || {};
    const editing = st.editing === s.id;
    const head = editing
      ? `<input class="ann-edit-label" value="${esc(s.label)}" /><textarea class="ann-edit-desc" rows="2">${esc(s.description)}</textarea>
         <div class="toolbar"><label>From <input class="ann-edit-start" type="number" step="0.1" value="${s.start}" /></label><label>to <input class="ann-edit-end" type="number" step="0.1" value="${s.end}" /></label>
         <label>Kind <select class="ann-edit-kind">${AnnotateCore.KINDS.map((k) => `<option value="${k}"${k === s.kind ? " selected" : ""}>${KIND_NAMES[k]}</option>`).join("")}</select></label>
         <button data-act="save" class="primary">Keep</button><button data-act="unedit">Cancel</button></div>`
      : `<div class="ann-label">${esc(s.label)}</div><div class="ann-desc">${esc(s.description)}</div>`;
    return `<div class="ann-seg review-${s.review || "pending"}${s.parent ? " sub" : ""}${st.selected === s.id ? " selected" : ""}" data-id="${esc(s.id)}">
      <div class="ann-time" data-seek="${s.start}">${clock(s.start)} – ${clock(s.end)}</div>
      <div class="ann-main">${head}
        <div class="ann-meta"><span class="ann-kind kind-${s.kind}">${KIND_NAMES[s.kind] || s.kind}</span> · hands ${pct(s.hands)} · <span class="q-${q.verdict || "ok"}">picture ${q.verdict || "ok"}${q.bad !== undefined ? ` · ${pct(q.bad)} bad · ${pct(q.covered)} looked at` : ""}</span> · ${esc(s.review || "pending")}</div></div>
      <div class="ann-actions"><button data-act="approve" title="Approve (a)">✓</button><button data-act="reject" title="Reject (r)">✗</button><button data-act="edit" title="Edit (e)">Edit</button>${s.parent ? "" : '<button data-act="sub" title="Add a subtask inside this step">+ Subtask</button>'}</div>
    </div>`;
  }

  // ---------- reviewing ----------
  const segOf = (id) => st.annotations.segments.find((s) => s.id === id);
  function pick(id, andSeek = true) {
    st.selected = id;
    const s = segOf(id);
    if (s && andSeek) seek(s.start);
    for (const el of document.querySelectorAll("#annSegs .ann-seg")) el.classList.toggle("selected", el.dataset.id === id);
    const el = document.querySelector(`#annSegs .ann-seg[data-id="${CSS.escape(id)}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }
  function review(id, verdict) {
    const s = segOf(id);
    if (!s) return;
    s.review = s.review === verdict ? "pending" : verdict;
    changed();
  }
  function changed() {
    render();
    if (st.selected) pick(st.selected, false);
    clearTimeout(st.saveTimer);
    st.saveTimer = setTimeout(save, 400);
  }
  async function save() {
    try {
      const file = await global.desktop.annotate.save(st.annotations, st.path);
      const el = $("annSaved");
      if (el) el.textContent = `Kept: ${String(file).split(/[\\/]/).pop()}`;
    } catch (err) {
      say(errText(err));
    }
  }
  async function saveCsv() {
    try {
      const file = await global.desktop.annotate.saveCsv(AnnotateCore.toCSV(st.annotations), st.path);
      $("annSaved").textContent = `Saved: ${String(file).split(/[\\/]/).pop()}`;
    } catch (err) {
      say(errText(err));
    }
  }

  function onClick(e) {
    const seekAt = e.target.closest && e.target.closest("[data-seek]");
    const row = e.target.closest && e.target.closest(".ann-seg");
    const b = e.target.closest && e.target.closest("button[data-act]");
    if (b && row) {
      const id = row.dataset.id, act = b.dataset.act;
      st.selected = id;
      if (act === "approve") review(id, "approved");
      else if (act === "reject") review(id, "rejected");
      else if (act === "edit") (st.editing = id), changed();
      else if (act === "unedit") (st.editing = null), changed();
      else if (act === "save") keepEdit(row, id);
      else if (act === "sub") addSub(id);
      return;
    }
    if (seekAt && !row) return seek(Number(seekAt.dataset.seek));
    if (row && !(e.target.closest("input, textarea, select"))) pick(row.dataset.id);
  }
  function onChange() {}
  function keepEdit(row, id) {
    const s = segOf(id);
    const start = Number(row.querySelector(".ann-edit-start").value), end = Number(row.querySelector(".ann-edit-end").value);
    s.label = row.querySelector(".ann-edit-label").value.trim() || s.label;
    s.description = row.querySelector(".ann-edit-desc").value.trim();
    s.kind = row.querySelector(".ann-edit-kind").value;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      s.start = Math.round(start * 10) / 10;
      s.end = Math.round(end * 10) / 10;
    }
    s.edited = true;
    st.editing = null;
    changed();
  }
  // A subtask: inside its step (its times, to begin with), right after it and its other subtasks.
  function addSub(id) {
    const segs = st.annotations.segments, parent = segOf(id);
    let at = segs.indexOf(parent) + 1;
    while (segs[at] && segs[at].parent === id) at++;
    const n = segs.filter((s) => s.parent === id).length + 1;
    const sub = { id: `${id}.${n}`, parent: id, start: parent.start, end: parent.end, label: "New subtask", description: "", kind: parent.kind, hands: parent.hands, quality: parent.quality, review: "pending", edited: true };
    segs.splice(at, 0, sub);
    st.selected = sub.id;
    st.editing = sub.id;
    changed();
  }

  // Keys, with a step picked and nothing being typed into.
  document.addEventListener("keydown", (e) => {
    if (!st || !st.annotations || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest && e.target.closest("input, textarea, select")) return;
    const segs = st.annotations.segments, i = segs.findIndex((s) => s.id === st.selected);
    const key = e.key.toLowerCase();
    if (key === "j" || key === "k") {
      const next = segs[Math.max(0, Math.min(segs.length - 1, i < 0 ? 0 : i + (key === "j" ? 1 : -1)))];
      if (next) pick(next.id);
    } else if (i >= 0 && key === "a") review(st.selected, "approved");
    else if (i >= 0 && key === "r") review(st.selected, "rejected");
    else if (i >= 0 && key === "e") (st.editing = st.selected), changed();
    else if (key === "," || key === ".") seek(now() + (key === "," ? -1 : 1));
    else return;
    e.preventDefault();
  });

  global.AnnotateUI = { card, attach, _state: () => st };
})(window);
