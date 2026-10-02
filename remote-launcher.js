/**
 * remote-launcher.js — remote.html, the way to a camera rig's remote recording page from the
 * website, the Android app and the Windows and Linux app: the computer's name or address
 * (remembered here, newest first) opens http://<it>:47821/, the page Hand Tracker serves while
 * Remote recording is on (electron/remote-record.js). A different port can be given as name:port.
 * The website opens it in place; the Android app hands it to the phone's browser; the Windows
 * and Linux app (where this page is a window of its own) to the computer's browser, so the
 * rig's page never runs inside the app.
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const STORE = "hand-tracker-remote-computers";
  const PORT = 47821;
  const MAX_SAVED = 8;

  // "pi", "pi.tailnet.ts.net", "100.101.2.3", "[fd7a::1]", each optionally ":port"; or a
  // pasted http(s) address. -> { host, port } or null.
  function parse(text) {
    let t = String(text || "").trim();
    if (!t) return null;
    if (/^https?:\/\//i.test(t)) {
      try {
        const u = new URL(t);
        t = u.host;
      } catch {
        return null;
      }
    }
    const m = /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?$/i.exec(t);
    if (!m) return null;
    const port = m[5] ? Number(m[5]) : PORT;
    if (port < 1 || port > 65535) return null;
    return { host: m[1].toLowerCase(), port };
  }
  const label = (c) => (c.port === PORT ? c.host : `${c.host}:${c.port}`);
  const urlOf = (c) => `http://${c.host}:${c.port}/`;

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

  // The Windows and Linux app (its preload gives every window `desktop`) sends a new window's
  // web address to the browser; elsewhere going there does it (the Android app's WebView hands
  // other sites to the phone's browser). Either app stays on this page.
  const inDesktopApp = !!window.desktop;
  const cap = window.Capacitor;
  const inAndroidApp = !!(cap && cap.isNativePlatform && cap.isNativePlatform());

  function open(c) {
    save([c, ...load().filter((x) => label(x) !== label(c))].slice(0, MAX_SAVED));
    if (inDesktopApp) window.open(urlOf(c), "_blank", "noopener");
    else location.href = urlOf(c);
    if (inDesktopApp || inAndroidApp) {
      $("error").textContent = "";
      $("opened").textContent = `Opened ${label(c)}'s page in your browser.`;
      show();
    }
  }

  // In the Windows and Linux app this page is a window of its own: no way "back".
  if (inDesktopApp) $("back").hidden = true;

  $("connectForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const typed = $("host").value.trim();
    const c = parse(typed || (load()[0] ? label(load()[0]) : ""));
    if (!c) {
      $("opened").textContent = "";
      $("error").textContent = typed ? "That doesn't look like a computer's name or address (such as pi or 100.101.2.3)." : "Type the computer's name or address.";
      return;
    }
    $("error").textContent = "";
    open(c);
  });

  show();
})();
