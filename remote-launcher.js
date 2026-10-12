/**
 * remote-launcher.js — remote.html, the way to a camera rig's remote recording from the website,
 * the Android app and the Windows and Linux app: the computer's name or address (remembered
 * here, newest first; a different port as name:port) opens its remote recording page.
 *   - In the apps the page opens right here (remote-client.html?rig=<name>:<port>), the app
 *     reaching the computer for it.
 *   - On the website it's the computer's own page, http://<it>:47821/ (electron/remote-record.js),
 *     since a website can't talk to a device on your network itself.
 * The address under Hand Tracker's QR code (…/#k=<code>) can be pasted too: its code goes along
 * (the page keeps it for that computer), for a computer reached on the same Wi-Fi rather than
 * over Tailscale.
 * Over Bluetooth instead: Web Bluetooth (Chrome, and the Windows, Mac and Linux app), or in the
 * Android app the computer's Bluetooth network (paired in Android's Bluetooth settings).
 * In the apps each computer remembered shows its cameras' previews under its name (a switch for
 * every computer, and one each).
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const STORE = "hand-tracker-remote-computers";
  const PORT = 47821;
  const MAX_SAVED = 8;

  // "pi", "pi.tailnet.ts.net", "100.101.2.3", "[fd7a::1]", each optionally ":port"; or a
  // pasted http(s) address (with its #k=<code>, if any). -> { host, port, key } or null.
  function parse(text) {
    let t = String(text || "").trim();
    let key = "";
    if (!t) return null;
    if (/^https?:\/\//i.test(t)) {
      try {
        const u = new URL(t);
        t = u.host;
        const k = /[#&]k=([A-Za-z0-9_-]{8,64})/.exec(u.hash);
        if (k) key = k[1];
      } catch {
        return null;
      }
    }
    const m = /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?$/i.exec(t);
    if (!m) return null;
    const port = m[5] ? Number(m[5]) : PORT;
    if (port < 1 || port > 65535) return null;
    return { host: m[1].toLowerCase(), port, key };
  }
  const label = (c) => (c.port === PORT ? c.host : `${c.host}:${c.port}`);

  function load() {
    try {
      const list = JSON.parse(localStorage.getItem(STORE) || "[]");
      return Array.isArray(list) ? list.map((x) => parse(x)).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  function save(list) {
    try {
      localStorage.setItem(STORE, JSON.stringify(list.map(label)));
    } catch {
      // private browsing: just not remembered
    }
  }

  function show() {
    const list = load();
    $("savedCard").hidden = !list.length;
    const ul = $("saved");
    ul.textContent = "";
    const gen = ++previewGen;
    const prefs = previewPrefs();
    $("previewsAll").hidden = !canPreview;
    toggle($("previewsAll"), prefs.all);
    list.forEach((c, i) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = label(c);
      // Its cameras, small, under its name (in the apps), with a switch of its own.
      let head = name, pics = null;
      if (canPreview) {
        head = document.createElement("div");
        head.className = "head";
        const own = document.createElement("button");
        own.type = "button";
        own.className = "quiet small";
        own.dataset.previews = label(c);
        own.setAttribute("aria-label", `Camera previews of ${label(c)}`);
        own.hidden = !prefs.all;
        toggle(own, !prefs.off.includes(label(c)));
        own.addEventListener("click", () => {
          const p = previewPrefs();
          const off = p.off.includes(label(c));
          setPreviewPrefs({ ...p, off: off ? p.off.filter((x) => x !== label(c)) : [...p.off, label(c)] });
          show();
        });
        head.append(name, own);
        pics = document.createElement("div");
        pics.className = "pics";
        pics.hidden = !prefs.all || prefs.off.includes(label(c));
        if (!pics.hidden) previewLoop(c, pics, gen);
      }
      const go = document.createElement("button");
      go.type = "button";
      go.textContent = "Open";
      go.addEventListener("click", () => open(c));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "quiet";
      remove.textContent = "Forget";
      remove.setAttribute("aria-label", `Forget ${label(c)}`);
      remove.addEventListener("click", () => {
        save(load().filter((_, j) => j !== i));
        show();
      });
      if (btPossible || nativeRemote) {
        const viaBt = document.createElement("button");
        viaBt.type = "button";
        viaBt.className = "quiet";
        viaBt.textContent = "Bluetooth";
        viaBt.setAttribute("aria-label", `${label(c)} over Bluetooth`);
        viaBt.addEventListener("click", () => openBluetooth(c.host));
        li.append(head, ...(pics ? [pics] : []), go, viaBt, remove);
      } else {
        li.append(head, ...(pics ? [pics] : []), go, remove);
      }
      ul.appendChild(li);
    });
    if (!$("host").value && list.length) $("host").placeholder = label(list[0]);
  }

  // The apps: the Windows and Linux app's preload gives every window `desktop`; the Android and
  // iPhone apps are Capacitor's ("inAndroidApp": either).
  const inDesktopApp = !!(window.desktop && window.desktop.rig);
  const cap = window.Capacitor;
  const inAndroidApp = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const inApp = inDesktopApp || inAndroidApp;

  // Over Bluetooth instead: Web Bluetooth (Chrome, and the Windows, Mac and Linux app), its page
  // here connecting to it by name; the Android app, over the computer's Bluetooth network (its
  // address there; a computer asked for by name is checked to be the one).
  // (The iPhone app has Bluetooth Low Energy of its own, RemoteLink.swift, and no Bluetooth network.)
  const onIphone = inAndroidApp && typeof cap.getPlatform === "function" && cap.getPlatform() === "ios";
  const btPossible = !!((navigator.bluetooth || onIphone) && window.isSecureContext !== false);
  const nativeRemote = inAndroidApp && !onIphone ? (typeof cap.registerPlugin === "function" ? cap.registerPlugin("Remote") : cap.Plugins && cap.Plugins.Remote) : null;
  const BT_NET_RIG = "10.43.0.1:47821";
  function openBluetooth(name) {
    location.href = nativeRemote
      ? `remote-client.html?rig=${encodeURIComponent(BT_NET_RIG)}${name ? `&want=${encodeURIComponent(name)}` : ""}`
      : `remote-client.html?bt=${encodeURIComponent(name || "")}`;
  }

  function open(c) {
    save([c, ...load().filter((x) => label(x) !== label(c))].slice(0, MAX_SAVED));
    const code = c.key ? `#k=${c.key}` : "";
    location.href = inApp ? `remote-client.html?rig=${encodeURIComponent(`${c.host}:${c.port}`)}${code}` : `http://${c.host}:${c.port}/${code}`;
  }

  // ---------- each computer's cameras, small, under its name ----------
  // In the apps, which can reach a computer (the Windows, Mac and Linux app's desktop.rig, the
  // Android app's Remote, the iPhone app's RigLink; a website can't): its running cameras'
  // previews, about once a second while this page shows, with its code if it has one (as its
  // page keeps it). One switch for every computer, and one each; both on until turned off
  // (remembered here). Tapping a picture opens that computer.
  const PREVIEWS = "hand-tracker-remote-previews";
  const PREVIEW_EVERY_MS = 1000;
  const rigLink = onIphone ? (typeof cap.registerPlugin === "function" ? cap.registerPlugin("RigLink") : cap.Plugins && cap.Plugins.RigLink) : nativeRemote;
  const canPreview = !!(inDesktopApp || rigLink);
  let previewGen = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function previewPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREVIEWS) || "{}");
      return { all: p.all !== false, off: Array.isArray(p.off) ? p.off.filter((x) => typeof x === "string") : [] };
    } catch {
      return { all: true, off: [] };
    }
  }
  function setPreviewPrefs(p) {
    try {
      localStorage.setItem(PREVIEWS, JSON.stringify(p));
    } catch {
      // private browsing: just not remembered
    }
  }
  function toggle(b, on) {
    b.textContent = on ? "Previews: on" : "Previews: off";
    b.setAttribute("aria-pressed", String(on));
    b.classList.toggle("on", on);
  }
  $("previewsAll").addEventListener("click", () => {
    const p = previewPrefs();
    setPreviewPrefs({ ...p, all: !p.all });
    show();
  });
  // One request to a computer, as its page makes them -> { status, bytes }.
  async function rigGet(c, path) {
    const rig = `${c.host}:${c.port}`;
    let key = "";
    try {
      key = localStorage.getItem(`hand-tracker-remote-key:${rig.toLowerCase()}`) || "";
    } catch {}
    if (inDesktopApp) {
      const r = await window.desktop.rig.request({ rig, path, method: "GET", body: null, key });
      return { status: r.status, bytes: r.body instanceof Uint8Array ? r.body : new Uint8Array(r.body || []) };
    }
    const r = await rigLink.rigRequest({ rig, path, method: "GET", body: "", key });
    return { status: r.status, bytes: Uint8Array.from(atob(r.body || ""), (ch) => ch.charCodeAt(0)) };
  }
  // A computer's previews while its row shows (until the list is drawn again).
  async function previewLoop(c, box, gen) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = "Looking…";
    box.append(note);
    const shown = []; // [{ fig, img, caption, url }]
    let cams = [], stateAt = 0;
    const say = (text) => {
      note.textContent = text;
      note.hidden = !text;
    };
    const clear = () => {
      for (const s of shown.splice(0)) {
        if (s.url) URL.revokeObjectURL(s.url);
        s.fig.remove();
      }
    };
    while (gen === previewGen) {
      if (document.hidden) {
        await sleep(500);
        continue;
      }
      const t0 = Date.now();
      try {
        if (Date.now() - stateAt > 4000) {
          const r = await rigGet(c, "/api/state");
          stateAt = Date.now();
          if (r.status === 200) {
            const s = JSON.parse(new TextDecoder().decode(r.bytes));
            cams = Array.isArray(s.cameras) ? s.cameras : [];
            say(cams.length ? "" : "Its cameras are off.");
          } else {
            cams = [];
            say(r.status === 401 ? "Open it once (with its code) to see its cameras here." : "Can't reach it now.");
          }
          while (shown.length > cams.length) {
            const gone = shown.pop();
            if (gone.url) URL.revokeObjectURL(gone.url);
            gone.fig.remove();
          }
          while (shown.length < cams.length) {
            const fig = document.createElement("figure");
            const img = document.createElement("img");
            img.alt = "";
            const caption = document.createElement("figcaption");
            fig.append(img, caption);
            fig.addEventListener("click", () => open(c));
            box.append(fig);
            shown.push({ fig, img, caption, url: null });
          }
          cams.forEach((cam, i) => (shown[i].caption.textContent = cam.role || cam.name || `Camera ${i + 1}`));
        }
        for (let i = 0; i < cams.length && gen === previewGen; i++) {
          const r = await rigGet(c, `/api/preview?i=${i}`);
          if (r.status !== 200 || gen !== previewGen || !shown[i]) continue;
          const url = URL.createObjectURL(new Blob([r.bytes], { type: "image/jpeg" }));
          const img = shown[i].img;
          await new Promise((done) => {
            img.onload = img.onerror = done;
            img.src = url;
          });
          if (shown[i] && shown[i].url) URL.revokeObjectURL(shown[i].url);
          if (shown[i]) shown[i].url = url;
        }
      } catch {
        cams = [];
        stateAt = 0;
        clear();
        say("Can't reach it now.");
        await sleep(4000);
      }
      await sleep(Math.max(0, PREVIEW_EVERY_MS - (Date.now() - t0)));
    }
    clear();
  }

  // In the Windows and Linux app this page is a window of its own: no way "back".
  if (inDesktopApp) $("back").hidden = true;
  // The apps show the computer's page here; the website opens the computer's own page.
  $("whereNote").textContent = inApp
    ? "The computer's page opens here: this app reaches it for you."
    : "This opens the computer's own page (on port 47821), since a website can't talk to a device on your network directly. Hand Tracker's apps show it in the app.";

  $("connectForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const typed = $("host").value.trim();
    const c = parse(typed || (load()[0] ? label(load()[0]) : ""));
    if (!c) {
      $("error").textContent = typed ? "That doesn't look like a computer's name or address (such as pi or 100.101.2.3)." : "Type the computer's name or address.";
      return;
    }
    $("error").textContent = "";
    open(c);
  });

  if ((btPossible || nativeRemote) && $("btCard")) {
    $("btCard").hidden = false;
    $("btOpen").addEventListener("click", () => openBluetooth(""));
  }
  if (nativeRemote && $("btCard")) {
    $("btWeb").hidden = true;
    $("btAndroid").hidden = false;
    $("btSettings").hidden = false;
    $("btSettings").addEventListener("click", () => nativeRemote.openBluetoothSettings().catch(() => {}));
    // Whether the phone is on a computer's Bluetooth network now (again on coming back from settings).
    const showNet = async () => {
      try {
        const n = await nativeRemote.bluetoothNetwork({});
        $("btNow").textContent = n.on ? `This phone is on ${n.device ? n.device.name : "a computer"}'s Bluetooth network.` : "This phone isn't on a computer's Bluetooth network now.";
        $("btNow").hidden = false;
      } catch {}
    };
    showNet();
    document.addEventListener("visibilitychange", () => document.hidden || showNet());
  }
  show();
})();
