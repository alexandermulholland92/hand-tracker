/**
 * download-menu.js — the website's Download menu (index.html's header): each app's files for each
 * device, on the "Latest build" release. Picking one downloads it and shows how to install it on
 * that device. Only on the website (app.js doesn't call it in the apps).
 *
 *   DownloadMenu.init(version)   version: this build's ("1.1.0"), which the release's files carry
 *                                (they're built from the same commit as the website); without one
 *                                (a copy run from the source folder), just the release's page
 */
(function (global) {
  const $ = (id) => document.getElementById(id);
  const RELEASE = "https://github.com/alexandermulholland92/hand-tracker/releases";
  // name, its files' name, its Linux package's name, whether it has the hand mouse, whether it uses the camera
  const APPS = [
    { name: "Hand Tracker", file: "HandTracker", deb: "hand-tracker", mouse: true, camera: true },
    { name: "Hand Mouse", file: "HandMouse", deb: "hand-mouse", mouse: true, camera: true },
    { name: "Remote Recording", file: "RemoteRecording", deb: "remote-recording", mouse: false, camera: true },
    { name: "Recording Converter", file: "RecordingConverter", deb: "recording-converter", mouse: false, camera: false },
  ];
  // Each device: its label in the menu, the file's name, and how to install it.
  const DEVICES = [
    { id: "windows", label: "Windows", file: (a, v) => `${a.file}-${v}-portable.exe` },
    { id: "mac-arm64", label: "Mac (Apple chip)", file: (a, v) => `${a.file}-${v}-mac-arm64.dmg` },
    { id: "mac-x64", label: "Mac (Intel)", file: (a, v) => `${a.file}-${v}-mac-x64.dmg` },
    { id: "linux", label: "Linux", file: (a, v) => `${a.deb}_${v}_amd64.deb` },
    { id: "pi", label: "Raspberry Pi", file: (a, v) => `${a.deb}_${v}_arm64.deb` },
    { id: "android", label: "Android", file: (a, v) => `${a.file}-${v}.apk` },
    { id: "iphone", label: "iPhone", file: (a, v) => `${a.file}-${v}-ios-unsigned.ipa` },
  ];
  const EXTENSION = { name: "Hand Tracker Chrome extension", label: "Chrome, Edge", id: "chrome" };
  const code = (text) => `<code>${text}</code>`;
  const debSteps = (a, file) => [
    `Open a terminal in the folder it downloaded to (usually Downloads) and run:<code class="cmd">sudo apt install ./${file}</code>`,
    `Open <b>${a.name}</b> from the app menu. A newer one installs over the old one the same way.`,
  ];

  // The steps for an app on a device: [title, intro, steps].
  function steps(device, a, file) {
    switch (device) {
      case "windows":
        return [`${a.name} for Windows`, "Nothing to install: it's one file, and it works offline.", [
          `Open the downloaded ${code(file)} (double-click it).`,
          "If Windows says <b>Windows protected your PC</b>, click <b>More info</b>, then <b>Run anyway</b>.",
        ]];
      case "mac-arm64":
      case "mac-x64":
        return [`${a.name} for Mac`, `For ${device === "mac-arm64" ? "Macs with an Apple chip (M1 and later)" : "Intel Macs"}, macOS 12 or later.`, [
          `Open the downloaded ${code(file)} and drag <b>${a.name}</b> into Applications.`,
          `Open ${a.name}. It isn't signed with an Apple Developer ID, so the first time macOS won't open it: go to System Settings → Privacy & Security and click <b>Open Anyway</b>.`,
          a.mouse
            ? "Allow the camera when it asks. For the hand mouse, turn it on under System Settings → Privacy & Security → Accessibility. macOS asks for these again after each update."
            : a.camera && "Allow the camera when it asks (macOS asks again after each update).",
        ].filter(Boolean)];
      case "linux":
        return [`${a.name} for Linux`, "For 64-bit PCs with Ubuntu, Debian, Mint or another Linux that installs .deb packages.", debSteps(a, file)];
      case "pi":
        return [`${a.name} for Raspberry Pi`, "For a Raspberry Pi 4 or 5 with 64-bit Raspberry Pi OS, or another 64-bit ARM Linux board.", debSteps(a, file)];
      case "android":
        return [`${a.name} for Android`, "For Android 7.0 or newer.", [
          `Open the downloaded ${code(file)} (from the download's notification, or Downloads in the Files app).`,
          "If Android asks, allow your browser (or file manager) to <b>install unknown apps</b>, then tap <b>Install</b>. A newer one installs over the old one.",
          a.mouse
            ? "Allow the camera when it asks. If turning on hand control says <b>Restricted setting</b>: open App info → <b>⋮</b> (top right) → <b>Allow restricted settings</b>, then turn it on again."
            : a.camera && "Allow the camera when it asks.",
        ].filter(Boolean)];
      case "iphone":
        return [`${a.name} for iPhone and iPad`, "For iOS 15 or later. It isn't on the App Store, so a sideloading tool installs it with your own Apple ID, from a computer.", [
          `On a Windows PC or Mac, open the downloaded ${code(file)} in <a class="header-link" href="https://sideloadly.io" target="_blank" rel="noopener">Sideloadly</a> (with the iPhone plugged in by USB) or <a class="header-link" href="https://altstore.io" target="_blank" rel="noopener">AltStore</a>, and install it with your Apple ID.`,
          "On the iPhone, trust it once: Settings → General → VPN & Device Management → your Apple ID → <b>Trust</b>. Turn on Settings → Privacy & Security → <b>Developer Mode</b> if it asks.",
          "With a free Apple ID it works for 7 days, then needs installing again (Sideloadly or AltStore can refresh it).",
        ]];
      case "chrome":
        return [EXTENSION.name, "The hand mouse for any web page, in Chrome, Edge, Brave and other Chromium browsers.", [
          `Unzip the downloaded ${code(file)}.`,
          `Open ${code("chrome://extensions")} (in Edge, ${code("edge://extensions")}), turn on <b>Developer mode</b>, click <b>Load unpacked</b> and pick the unzipped folder.`,
          "Click its toolbar button (pin it from the puzzle-piece menu), allow the camera once, and turn on <b>Hand mouse</b>.",
        ]];
    }
    return null;
  }

  function showInstall(device, a, file, url) {
    const s = steps(device, a, file);
    if (!s) return;
    const [title, intro, list] = s;
    $("installTitle").textContent = title;
    $("installIntro").textContent = intro;
    $("installSteps").innerHTML = list.map((t) => `<li>${t}</li>`).join("");
    $("installAgain").href = url;
    $("installDialog").hidden = false;
    $("installClose").focus();
  }

  function init(version) {
    const menu = $("downloadMenu"), list = $("downloadList");
    const v = /^\d+\.\d+\.\d+$/.test(version || "") ? version : "";
    const files = {}; // url -> [device, app, file]
    const link = (device, a, label, file) => {
      const url = `${RELEASE}/download/latest-build/${file}`;
      files[url] = [device, a, file];
      return `<a href="${url}" title="${file}">${label}</a>`;
    };
    list.innerHTML = (v
      ? APPS.map((a) => `<div class="dl-app">${a.name}</div><div class="dl-files">${DEVICES.map((d) => link(d.id, a, d.label, d.file(a, v))).join("")}</div>`).join("") +
        `<div class="dl-app">Chrome extension</div><div class="dl-files">${link(EXTENSION.id, EXTENSION, EXTENSION.label, `HandTracker-${v}-chrome-extension.zip`)}</div>`
      : "") +
      `<div class="note"><a class="header-link" href="${RELEASE}/tag/latest-build" target="_blank" rel="noopener">All files on GitHub ↗</a></div>`;
    menu.hidden = false;
    // Opened under its button's right edge, moved over if that puts it off the screen's left
    // (on a phone the header wraps, so the button isn't at the right).
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      list.style.right = "0px";
      const left = list.getBoundingClientRect().left;
      if (left < 16) list.style.right = `${left - 16}px`;
    });
    // A file picked: it downloads (the link itself), and its instructions show.
    list.addEventListener("click", (e) => {
      const a = e.target.closest("a");
      const f = a && files[a.getAttribute("href")];
      if (!f) return;
      menu.open = false;
      showInstall(f[0], f[1], f[2], a.href);
    });
    const dialog = $("installDialog");
    const close = () => (dialog.hidden = true);
    $("installClose").addEventListener("click", close);
    dialog.addEventListener("click", (e) => e.target === dialog && close());
    // The menu closed by a click anywhere else; it and the instructions by Escape.
    document.addEventListener("click", (e) => {
      if (menu.open && !menu.contains(e.target)) menu.open = false;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!dialog.hidden) close();
      else if (menu.open) menu.open = false;
    });
  }

  global.DownloadMenu = { init, _steps: steps };
})(window);
