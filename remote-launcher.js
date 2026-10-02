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
    list.forEach((c, i) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = label(c);
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
      li.append(name, go, remove);
      ul.appendChild(li);
    });
    if (!$("host").value && list.length) $("host").placeholder = label(list[0]);
  }

  // The apps: the Windows and Linux app's preload gives every window `desktop`; the Android
  // app is Capacitor's.
  const inDesktopApp = !!(window.desktop && window.desktop.rig);
  const cap = window.Capacitor;
  const inAndroidApp = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const inApp = inDesktopApp || inAndroidApp;

  function open(c) {
    save([c, ...load().filter((x) => label(x) !== label(c))].slice(0, MAX_SAVED));
    const code = c.key ? `#k=${c.key}` : "";
    location.href = inApp ? `remote-client.html?rig=${encodeURIComponent(`${c.host}:${c.port}`)}${code}` : `http://${c.host}:${c.port}/${code}`;
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

  show();
})();
