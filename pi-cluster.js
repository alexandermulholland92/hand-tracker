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
    $("tabPis").setAttribute("aria-selected", String(tab === "pis"));
    $("tabRigs").setAttribute("aria-selected", String(tab === "rigs"));
    $("pis").hidden = tab !== "pis";
    $("rigs").hidden = tab !== "rigs";
  }

  $("tabPis").onclick = () => showTab("pis");
  $("tabRigs").onclick = () => showTab("rigs");
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
