/**
 * pi-cluster.js — Pi Cluster's page (pi-cluster.html), in its own app. Lists the Pis running Pi
 * Cluster's service (window.desktop.cluster: electron/cluster.js finds them over Tailscale), asked
 * again every few seconds:
 *   Pis — each Pi's modules, the same way for every module (a module this page doesn't know yet
 *     too): its one-line summary, its warnings and its buttons; under ⚙, each module's switch for
 *     that Pi and its settings; and what happened lately (updates and the like).
 *   Camera rigs — each Pi's Hand Tracker: its cameras, recording, Sentry on or off, Start or
 *     Restart, and updating it.
 * A Pi that's away (unplugged, out of battery, off the Wi-Fi) stays listed, faded, with when it
 * was last seen and what it said then, until it's back or forgotten.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.desktop && window.desktop.cluster;
  const REFRESH_MS = 4000;
  const open = new Set(); // Pis whose ⚙ is open
  let data = null;
  let tab = "pis";
  let asking = false;
  let messageTimer = null;

  function el(tag, props = {}, ...kids) {
    const e = Object.assign(document.createElement(tag), props);
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : String(k));
    return e;
  }
  const mod = (node, name) => (node && node.modules ? node.modules.find((m) => m.name === name) : null);
  const short = (c) => (c && /^[0-9a-f]{40}$/.test(c) ? c.slice(0, 7) : c || "");
  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (!ms) return "never";
    if (s < 90) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  }
  const clock = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  function say(text, bad = false) {
    const m = $("message");
    m.textContent = text;
    m.className = bad ? "err" : "";
    m.hidden = !text;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => (m.hidden = true), bad ? 12000 : 6000);
  }

  const recording = (pi) => {
    const r = mod(pi.node, "rig");
    return !!(r && r.on && r.status && (r.status.recording || r.status.saving));
  };

  // A module's button on a Pi. Updating or restarting while it records asks first, and then
  // doesn't wait for the recording to end (the take is saved first).
  async function act(pi, module, action, args = {}) {
    const m = mod(pi.node, module);
    const a = m && (m.actions || []).find((x) => x.name === action);
    const waits = ["updateHandTracker", "updateOS", "reboot"].includes(action);
    if (waits && recording(pi)) {
      const what = action === "reboot" ? "Restart it now anyway" : "Update it now anyway, rather than once it stops";
      if (!confirm(`${pi.name} is recording. ${what}? The take is saved first.`)) return;
      args = { ...args, force: true };
    } else if (a && a.confirm && !confirm(`${pi.name}: ${a.confirm}`)) return;
    const answer = await api.action({ target: pi.target, module, action, args }).catch((e) => ({ error: e.message }));
    say(`${pi.name}: ${answer.message || answer.error || "Done."}`, !!answer.error && !answer.ok);
    setTimeout(refresh, 600);
  }

  async function set(pi, module, change) {
    // (one Pi keeps the job list: choosing one takes it off the others)
    if (module === "jobs" && change.key === "home" && change.value === true) {
      for (const other of ((data && data.nodes) || []).filter((p) => p.answering && p.name !== pi.name)) {
        const j = mod(other.node, "jobs");
        if (j && j.status && j.status.home) await api.settings({ target: other.target, module: "jobs", key: "home", value: false }).catch(() => {});
      }
    }
    const answer = await api.settings({ target: pi.target, module, ...change }).catch((e) => ({ error: e.message }));
    if (answer.error) say(`${pi.name}: ${answer.error}`, true);
    refresh();
  }

  function moduleBlock(pi, m) {
    const st = m.status || {};
    const live = pi.answering;
    const block = el("div", { className: "mod" }, el("div", { className: "mod-title" }, m.title));
    if (st.summary) block.append(el("div", { className: "summary" }, st.summary));
    for (const w of st.warnings || []) block.append(el("div", { className: "warn-line" }, "⚠ " + w));
    if (m.error) block.append(el("div", { className: "warn-line" }, `⚠ ${m.title} had a problem: ${m.error}`));
    if (m.name === "rig" && st.cameras && st.cameras.length) block.append(cameraLine(st.cameras));
    const buttons = (m.actions || []).filter((a) => !a.hidden && actionMakesSense(m, a));
    if (live && buttons.length) {
      block.append(el("div", { className: "buttons" }, buttons.map((a) => {
        const b = el("button", { textContent: a.title, className: m.name === "updates" && a.name === "reboot" && st.os && st.os.rebootNeeded ? "warn" : "" });
        b.onclick = () => act(pi, m.name, a.name);
        return b;
      })));
    }
    return block;
  }

  // (Start only when Hand Tracker isn't running, Restart only when it is)
  function actionMakesSense(m, a) {
    const st = m.status || {};
    if (m.name === "rig" && a.name === "start") return st.app === "not running";
    if (m.name === "rig" && a.name === "restart") return st.app === "running" && st.answering;
    return true;
  }

  function cameraLine(cams) {
    return el("div", { className: "cams" }, cams.map((c) => `${c.role ? c.role + ": " : ""}${c.name || "camera"}${c.fps ? ` ${Math.round(c.fps)} fps` : ""}${c.chipC ? ` · chip ${Math.round(c.chipC)} °C` : ""}${c.error ? ` · ${c.error}` : ""}`).join(" · "));
  }

  function settingsBlock(pi) {
    const box = el("div", { className: "settings" });
    for (const m of pi.node.modules) {
      const on = el("input", { type: "checkbox", checked: !!m.on });
      on.onchange = () => set(pi, m.name, { on: on.checked });
      box.append(el("h3", {}, el("label", {}, on, m.title)));
      if (!m.on) continue;
      for (const s of m.settings || []) {
        if (Array.isArray(s.choices)) {
          const sel = el("select", {}, s.choices.map(([v, t]) => el("option", { value: v, textContent: t, selected: v === s.value })));
          sel.onchange = () => set(pi, m.name, { key: s.key, value: sel.value });
          box.append(el("label", {}, s.title, sel));
        } else {
          const cb = el("input", { type: "checkbox", checked: !!s.value });
          cb.onchange = () => set(pi, m.name, { key: s.key, value: cb.checked });
          box.append(el("label", {}, cb, s.title));
        }
      }
    }
    return box;
  }

  function header(pi) {
    const node = pi.node || {};
    const health = mod(node, "health");
    const model = health && health.status && health.status.model ? health.status.model.replace(/ Model B| Rev [\d.]+/g, "") : "";
    const dot = el("span", { className: "dot" + (pi.answering ? " on" : pi.online ? " part" : "") });
    const sub = pi.answering
      ? [model, node.version && `service ${short(node.version)}`].filter(Boolean).join(" · ")
      : pi.online
        ? `On Tailscale, but its Pi Cluster service isn't answering${pi.error ? ` (${pi.error})` : ""} · last answered ${ago(pi.seen)}`
        : `Away · last seen ${ago(pi.seen)}`;
    const top = el("div", { className: "top" }, dot, el("span", { className: "name" }, pi.name), el("span", { className: "sub" }, sub));
    if (!pi.answering) {
      const forget = el("button", { textContent: "Forget", title: "Take it off this list (it comes back if its service answers again)" });
      forget.onclick = async () => {
        if (!confirm(`Take ${pi.name} off the list? It comes back by itself if its Pi Cluster service answers again.`)) return;
        await api.forget(pi.name);
        refresh();
      };
      top.append(forget);
    } else {
      const gear = el("button", { textContent: open.has(pi.name) ? "⚙ Close" : "⚙", title: "This Pi's modules and settings" });
      gear.onclick = () => {
        open.has(pi.name) ? open.delete(pi.name) : open.add(pi.name);
        render();
      };
      top.append(gear);
    }
    return top;
  }

  function piCard(pi) {
    const card = el("div", { className: "card" + (pi.answering ? "" : " away") }, header(pi));
    const node = pi.node;
    if (!node) return card;
    for (const m of node.modules.filter((x) => x.on)) card.append(moduleBlock(pi, m));
    if (pi.answering && open.has(pi.name)) card.append(settingsBlock(pi));
    const events = (node.events || []).slice(-5).reverse();
    if (events.length) {
      card.append(el("div", { className: "events" }, events.map((e) => el("div", { className: e.bad ? "bad" : "" }, `${clock(e.at)} — ${e.text}`))));
    }
    return card;
  }

  function rigCard(pi) {
    const card = el("div", { className: "card" + (pi.answering ? "" : " away") }, header(pi));
    const rig = mod(pi.node, "rig");
    if (!rig || !rig.on) {
      card.append(el("div", { className: "mod summary" }, "Its camera rig module is off (⚙ on the Pis tab)."));
      return card;
    }
    const st = rig.status || {};
    card.append(el("div", { className: "mod summary" }, st.summary || ""));
    for (const w of st.warnings || []) card.append(el("div", { className: "warn-line" }, "⚠ " + w));
    if (st.cameras && st.cameras.length) card.append(cameraLine(st.cameras));
    const updates = mod(pi.node, "updates");
    if (updates && updates.on && updates.status && updates.status.handTracker) {
      const inst = st.installed || {};
      card.append(el("div", { className: "cams" }, `Hand Tracker ${inst.commit ? short(inst.commit) : inst.version || ""}: ${updates.status.handTracker.state}`));
    }
    if (!pi.answering) return card;
    const buttons = el("div", { className: "buttons" });
    if (st.app === "running" && st.answering) {
      const s = el("button", { textContent: st.sentry ? "Turn Sentry off" : "Turn Sentry on" });
      s.onclick = () => act(pi, "rig", "sentry", { armed: !st.sentry });
      buttons.append(s);
    }
    for (const a of (rig.actions || []).filter((x) => !x.hidden && actionMakesSense(rig, x))) {
      const b = el("button", { textContent: a.title });
      b.onclick = () => act(pi, "rig", a.name);
      buttons.append(b);
    }
    if (updates && updates.on && st.installed) {
      const u = el("button", { textContent: "Update Hand Tracker now" });
      u.onclick = () => act(pi, "updates", "updateHandTracker");
      buttons.append(u);
    }
    card.append(buttons);
    return card;
  }

  function render() {
    // (not while a list is open: it would close under the pointer)
    if (document.activeElement && document.activeElement.tagName === "SELECT") return;
    const nodes = (data && data.nodes) || [];
    const pis = $("pis");
    const rigs = $("rigs");
    if (!nodes.length) {
      const why = data && !data.tailscale ? " Tailscale isn't running on this computer (or isn't installed), so no Pis can be found yet." : "";
      pis.replaceChildren(el("div", { className: "empty" }, `No Pis yet. Press Add a Pi to put one in the cluster.${why}`));
      rigs.replaceChildren(el("div", { className: "empty" }, "No Pis yet."));
    } else {
      pis.replaceChildren(...nodes.map(piCard));
      rigs.replaceChildren(...nodes.filter((p) => p.node).map(rigCard));
    }
    renderJobs();
    const live = nodes.filter((p) => p.answering).length;
    $("note").textContent = data
      ? `${live} of ${nodes.length} Pi${nodes.length === 1 ? "" : "s"} answering${data.tailscale ? "" : " · Tailscale isn't running on this computer"} · updated ${new Date(data.at).toLocaleTimeString()}`
      : "Looking for Pis over Tailscale…";
    $("updateAll").disabled = !live;
  }

  async function refresh() {
    if (asking || !api) return;
    asking = true;
    try {
      data = await api.list();
    } catch (e) {
      say(`Couldn't list the Pis: ${e.message}`, true);
    } finally {
      asking = false;
    }
    render();
  }

  function showTab(which) {
    tab = which;
    for (const t of ["pis", "rigs", "jobs"]) {
      $("tab" + t[0].toUpperCase() + t.slice(1)).setAttribute("aria-selected", String(tab === t));
      $(t).hidden = tab !== t;
    }
  }

  // ---------- Jobs: the job list (on the Pi that keeps it), and making a job ----------
  const KINDS = { animals: "Animals in clips", convert: "Converting videos", command: "A command for each file" };
  const shown = new Set(); // jobs whose files are listed
  const itemsOf = new Map(); // job -> its files, as last asked
  const pickedJobs = { recordings: new Map(), files: [], folder: null, model: null };
  let browsing = null;

  function homePi() {
    const nodes = (data && data.nodes) || [];
    return nodes.find((p) => p.node && (mod(p.node, "jobs") || {}).status && mod(p.node, "jobs").status.home && mod(p.node, "jobs").on) || null;
  }

  function renderJobs() {
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest("#newJob")) return;
    const home = homePi();
    for (const n of document.querySelectorAll(".homeName")) n.textContent = home ? home.name : "the Pi that keeps the jobs";
    const line = $("jobsHome");
    $("newJobBtn").disabled = !(home && home.answering);
    if (!home) {
      const live = ((data && data.nodes) || []).filter((p) => p.answering && mod(p.node, "jobs"));
      const sel = el("select", {}, live.map((p) => el("option", { value: p.name, textContent: p.name, selected: /^pi$/i.test(p.name) })));
      const use = el("button", { textContent: "Keep it there" });
      use.onclick = () => {
        const p = live.find((x) => x.name === sel.value);
        if (p) set(p, "jobs", { key: "home", value: true });
      };
      line.replaceChildren("No Pi keeps the job list yet. Which one should keep it (and the jobs' files)? ", sel, " ", use);
      $("jobList").replaceChildren();
      return;
    }
    const st = mod(home.node, "jobs").status;
    line.textContent = home.answering
      ? `${home.name} keeps the job list and the jobs' files (~/ht-cluster-jobs). Each Pi takes work when its switches (⚙ on the Pis tab) let it.`
      : `${home.name} keeps the job list, but it isn't answering: what's shown is from ${ago(home.seen)}.`;
    const jobs = st.jobs || [];
    $("jobList").replaceChildren(...(jobs.length ? jobs.map((j) => jobCard(home, j)) : [el("div", { className: "empty" }, "No jobs yet.")]));
  }

  function jobCard(home, j) {
    const c = j.counts || {};
    const finished = (c.done || 0) + (c.failed || 0);
    const parts = [KINDS[j.kind] || j.kind, j.state === "uploading" ? "waiting for its files" : j.state, `${c.done || 0} of ${j.files} done`];
    if (c.failed) parts.push(`${c.failed} failed`);
    if (c.stopped) parts.push(`${c.stopped} stopped`);
    if ((j.working || []).length) parts.push(`working: ${j.working.join(", ")}`);
    if (j.high) parts.push("high priority");
    const card = el("div", { className: "card" },
      el("div", { className: "top" }, el("span", { className: "name" }, j.title), el("span", { className: "sub" }, parts.join(" · "))),
      el("div", { className: "bar" }, el("div", { style: `width:${Math.round((100 * finished) / Math.max(1, j.files))}%` })));
    if (j.kind === "animals" && j.summary && (j.summary.kinds || []).length) {
      const text = j.summary.kinds.slice(0, 12).map(([kind, clips, pictures]) => `${kind} in ${clips} clip${clips === 1 ? "" : "s"} (${pictures} picture${pictures === 1 ? "" : "s"})`).join(" · ");
      card.append(el("div", { className: "mod summary" }, `${j.summary.pictures} pictures, ${j.summary.withAnimal} with an animal: ${text}`));
    } else if (j.kind === "animals" && j.summary) {
      card.append(el("div", { className: "mod summary" }, `${j.summary.pictures} pictures, no animal found yet`));
    }
    if (!home.answering) return card;
    const buttons = el("div", { className: "buttons" });
    const button = (text, fn, cls = "") => {
      const b = el("button", { textContent: text, className: cls });
      b.onclick = fn;
      buttons.append(b);
    };
    if (c.done) button("Save results…", () => saveResults(home, j), "main");
    if (["waiting", "running", "uploading"].includes(j.state)) button("Stop", () => jobAction(home, "stop", j));
    if ((c.failed || c.stopped) && !["waiting", "running"].includes(j.state)) button("Try those again", () => jobAction(home, "again", j));
    if (!c.running) button("Remove", () => confirm(`Remove ${j.title}, and its files and results on ${home.name}?`) && jobAction(home, "remove", j));
    button(shown.has(j.id) ? "Hide its files" : "Its files", async () => {
      if (shown.has(j.id)) shown.delete(j.id);
      else {
        shown.add(j.id);
        await loadItems(home, j.id);
      }
      render();
    });
    card.append(buttons);
    if (shown.has(j.id)) {
      if (["waiting", "running"].includes(j.state)) loadItems(home, j.id); // (as it goes)
      const items = itemsOf.get(j.id) || [];
      card.append(el("div", { className: "items" }, items.map((it) => el("div", { className: it.state === "failed" ? "bad" : "" },
        `${it.name} (from ${it.from}): ${it.state}${it.worker ? ` on ${it.worker}` : ""}${it.state === "running" ? ` ${Math.round(100 * (it.progress || 0))}%` : ""}${it.error ? ` — ${it.error}` : ""}`))));
    }
    return card;
  }

  async function loadItems(home, jid) {
    const a = await api.action({ target: home.target, module: "jobs", action: "items", args: { job: jid } }).catch(() => null);
    if (a && a.job) itemsOf.set(jid, a.job.items || []);
  }

  async function jobAction(home, action, j) {
    const a = await api.action({ target: home.target, module: "jobs", action, args: { job: j.id } }).catch((e) => ({ error: e.message }));
    say(a.message || a.error || "Done.", !!a.error);
    setTimeout(refresh, 400);
  }

  async function saveResults(home, j) {
    const dir = await api.pickFolder();
    if (!dir) return;
    say(`Saving ${j.title}'s results…`);
    try {
      const got = await api.download({ target: home.target, job: j.id, dir });
      say(`Saved ${got.files} file${got.files === 1 ? "" : "s"} in ${got.folder}`);
    } catch (e) {
      say(`Couldn't save them: ${e.message}`, true);
    }
  }

  // The new job's form
  const kindNow = () => (document.querySelector('input[name="kind"]:checked') || {}).value || "animals";
  function showOptions() {
    $("animalsOpts").hidden = kindNow() !== "animals";
    $("commandOpts").hidden = kindNow() !== "command";
    const m = pickedJobs.model;
    const app = window.SentryModels && window.SentryModels.MODELS.finder;
    $("modelName").textContent = m ? `${m.name} (from this computer)` : app ? `the app's own (${app.name})` : "?";
    $("appModel").hidden = !m;
    const n = pickedJobs.recordings.size + pickedJobs.files.length;
    const bits = [];
    if (pickedJobs.recordings.size) bits.push(`${pickedJobs.recordings.size} recording${pickedJobs.recordings.size === 1 ? "" : "s"} on the Pis`);
    if (pickedJobs.files.length) bits.push(`${pickedJobs.files.length} file${pickedJobs.files.length === 1 ? "" : "s"} from this computer`);
    if (pickedJobs.folder) bits.push(`the folder ${pickedJobs.folder}`);
    $("chosen").textContent = bits.length ? "Chosen: " + bits.join(", ") + "." : "No files chosen yet.";
    $("startJob").disabled = !(n || pickedJobs.folder);
  }

  function resetForm() {
    pickedJobs.recordings.clear();
    pickedJobs.files = [];
    pickedJobs.folder = null;
    pickedJobs.model = null;
    $("recordingsBox").hidden = true;
    $("browseBox").hidden = true;
    $("jobTitle").value = "";
    $("jobHigh").checked = false;
    showOptions();
  }

  async function showRecordings() {
    const box = $("recordingsBox");
    box.hidden = false;
    box.replaceChildren(el("div", { className: "hint" }, "Asking the Pis…"));
    const pis = ((data && data.nodes) || []).filter((p) => p.answering && mod(p.node, "jobs") && mod(p.node, "jobs").on);
    const lists = await Promise.all(pis.map((p) => api.action({ target: p.target, module: "jobs", action: "recordings", args: {} }).then((a) => [p, a]).catch((e) => [p, { error: e.message }])));
    box.replaceChildren(...lists.flatMap(([p, a]) => {
      const recs = a.recordings || [];
      const all = el("input", { type: "checkbox" });
      const rows = recs.map((r) => {
        const key = `${p.name}\n${r.path}`;
        const cb = el("input", { type: "checkbox", checked: pickedJobs.recordings.has(key) });
        cb.onchange = () => {
          cb.checked ? pickedJobs.recordings.set(key, { node: p.name, name: r.name, path: r.path, size: r.size }) : pickedJobs.recordings.delete(key);
          showOptions();
        };
        return el("label", {}, cb, `${r.name} · ${clock(r.at)} · ${(r.size / 1e6).toFixed(r.size < 1e7 ? 1 : 0)} MB`);
      });
      all.onchange = () => {
        for (const row of rows) {
          const cb = row.querySelector("input");
          if (cb.checked !== all.checked) {
            cb.checked = all.checked;
            cb.onchange();
          }
        }
      };
      const head = el("h4", {}, el("label", {}, all, `${p.name}: ${recs.length ? `${recs.length} recording${recs.length === 1 ? "" : "s"}` : a.error ? a.error : "no recordings"}`));
      return [head, ...rows];
    }));
  }

  async function browse(where) {
    const home = homePi();
    if (!home) return;
    const a = await api.action({ target: home.target, module: "jobs", action: "browse", args: { path: where || "" } }).catch((e) => ({ error: e.message }));
    const box = $("browseBox");
    box.hidden = false;
    if (!a.ok) {
      box.replaceChildren(el("div", { className: "hint" }, a.error || "Couldn't look."));
      return;
    }
    browsing = a.path;
    const videos = a.files.filter((f) => f.video).length;
    const use = el("button", { textContent: `Use this folder (${kindNow() === "command" ? `${a.files.length} files` : `${videos} videos`})` });
    use.onclick = () => {
      pickedJobs.folder = browsing;
      box.hidden = true;
      showOptions();
    };
    const up = el("div", { className: "folder" }, "↑ " + a.parent);
    up.onclick = () => browse(a.parent);
    box.replaceChildren(el("div", { className: "hint" }, `${home.name}: ${a.path}`), use, up,
      ...a.folders.map((f) => {
        const d = el("div", { className: "folder" }, "📁 " + f);
        d.onclick = () => browse(a.path.replace(/\/$/, "") + "/" + f);
        return d;
      }));
  }

  // (names on the Pi that keeps the list are unique within a job)
  function uniqueName(name, taken) {
    let n = name, i = 2;
    const dot = name.lastIndexOf(".");
    while (taken.has(n)) n = dot > 0 ? `${name.slice(0, dot)} (${i++})${name.slice(dot)}` : `${name} (${i++})`;
    taken.add(n);
    return n;
  }

  async function startJob() {
    const home = homePi();
    if (!home) return say("No Pi keeps the job list yet.", true); // (one that's away: its own answer says so)
    const kind = kindNow();
    const params = {};
    if (kind === "animals") {
      const app = window.SentryModels.MODELS.finder;
      params.every = Math.min(60, Math.max(0.2, Number($("every").value) || 1));
      params.score = 0.25;
      params.animals = (window.Kinds && window.Kinds.animals) || [];
      if (pickedJobs.model) params.model = { upload: "model.onnx", name: pickedJobs.model.name };
      else Object.assign(params, { model: { url: app.url, sha256: app.sha256, name: app.name }, names: (window.Kinds && window.Kinds.names) || [] });
      params.modelName = pickedJobs.model ? pickedJobs.model.name : app.name;
    } else if (kind === "convert") {
      const id = $("format").value;
      const f = window.VideoFormats.FORMATS.find((x) => x.id === id);
      Object.assign(params, { format: id, label: f.label, ext: f.ext, suffix: f.suffix || "", args: window.VideoFormats.outputArgs(id, {}) });
    } else {
      params.command = $("command").value.trim();
      if (!params.command) return say("Which command?", true);
    }
    const taken = new Set();
    const uploads = pickedJobs.files.map((f) => ({ ...f, name: uniqueName(f.name, taken) }));
    const files = [...[...pickedJobs.recordings.values()].map((r) => ({ name: r.name, size: r.size, node: r.node, path: r.path })), ...uploads.map((f) => ({ name: f.name, size: f.size, upload: true }))];
    const count = files.length + (pickedJobs.folder ? 1 : 0);
    const title = $("jobTitle").value.trim() || (kind === "animals" ? `Animals in ${files.length || "a folder's"} clip${files.length === 1 ? "" : "s"}` : kind === "convert" ? `Videos to ${params.label}` : "A command for each file");
    const made = await api.action({ target: home.target, module: "jobs", action: "create", args: { kind, title, high: $("jobHigh").checked, params, files, folder: pickedJobs.folder } }).catch((e) => ({ error: e.message }));
    if (!made.ok) return say(made.error || "It wasn't made.", true);
    const sending = [...uploads.map((f) => ({ path: f.path, name: f.name })), ...(pickedJobs.model ? [{ path: pickedJobs.model.path, name: "model.onnx" }] : [])];
    if (sending.length) {
      try {
        await api.upload({ target: home.target, job: made.job, files: sending });
      } catch (e) {
        return say(`Couldn't send the files to ${home.name}: ${e.message}`, true);
      }
      const started = await api.action({ target: home.target, module: "jobs", action: "start", args: { job: made.job } }).catch((e) => ({ error: e.message }));
      if (!started.ok) return say(started.error || "It didn't start.", true);
    }
    say(`Started ${title}${count ? "" : ""}.`);
    $("newJob").hidden = true;
    resetForm();
    setTimeout(refresh, 500);
  }

  if (api && api.onProgress) {
    api.onProgress((p) => {
      if (p.size !== undefined) say(`Sending ${p.name}: ${Math.round((100 * p.sent) / Math.max(1, p.size))}%`);
      else if (p.files !== undefined) say(`Saving results: ${p.got} of ${p.files}`);
    });
  }
  if (window.VideoFormats) {
    $("format").replaceChildren(...window.VideoFormats.FORMATS.map((f) => el("option", { value: f.id, textContent: `${f.label} (${f.detail})` })));
  }
  for (const r of document.querySelectorAll('input[name="kind"]')) r.onchange = showOptions;
  $("newJobBtn").onclick = () => {
    $("newJob").hidden = !$("newJob").hidden;
    showOptions();
  };
  $("cancelJob").onclick = () => {
    $("newJob").hidden = true;
    resetForm();
  };
  $("showRecordings").onclick = showRecordings;
  $("browseHome").onclick = () => browse(browsing || "");
  $("pickFiles").onclick = async () => {
    const got = await api.pickFiles();
    for (const f of got || []) if (!pickedJobs.files.some((x) => x.path === f.path)) pickedJobs.files.push(f);
    showOptions();
  };
  $("pickModel").onclick = async () => {
    const got = await api.pickModel();
    if (got && got[0]) pickedJobs.model = got[0];
    showOptions();
  };
  $("appModel").onclick = () => {
    pickedJobs.model = null;
    showOptions();
  };
  $("startJob").onclick = startJob;

  $("tabPis").onclick = () => showTab("pis");
  $("tabRigs").onclick = () => showTab("rigs");
  $("tabJobs").onclick = () => showTab("jobs");
  $("addPi").onclick = () => $("addDialog").showModal();
  $("closeAdd").onclick = () => $("addDialog").close();
  $("copyCmd").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("setupCmd").textContent.trim());
      $("copied").hidden = false;
      setTimeout(() => ($("copied").hidden = true), 3000);
    } catch {
      say("Couldn't copy: select the line and copy it instead.", true);
    }
  };
  $("updateAll").onclick = async () => {
    const live = ((data && data.nodes) || []).filter((p) => p.answering && mod(p.node, "updates") && mod(p.node, "updates").on);
    if (!live.length || !confirm(`Update Hand Tracker on ${live.map((p) => p.name).join(", ")}? Each restarts Hand Tracker when it's done; a Pi that's recording waits until it stops.`)) return;
    const answers = await Promise.all(live.map((p) => api.action({ target: p.target, module: "updates", action: "updateHandTracker", args: {} }).catch((e) => ({ error: e.message }))));
    const bad = answers.map((a, i) => (a.error ? `${live[i].name}: ${a.error}` : null)).filter(Boolean);
    say(bad.length ? bad.join(" · ") : `Asked ${live.length} Pi${live.length === 1 ? "" : "s"} to update Hand Tracker.`, bad.length > 0);
    setTimeout(refresh, 600);
  };

  if (window.desktop && window.desktop.getInfo) window.desktop.getInfo().then((i) => i && i.version && ($("buildInfo").textContent = `v${i.version}`), () => {});
  if (!api) {
    $("note").textContent = "Pi Cluster runs in its own app (Pi Cluster), not in a browser.";
    return;
  }
  refresh();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, REFRESH_MS);
})();
