/**
 * remote-recording.js — Remote Recording (an app of its own, for Android, iPhone and iPad,
 * Windows, Mac and Linux): each time it opens it asks what this device is for now:
 *  - Control a rig: remote.html, the computers (and phones) it has reached before, with their
 *    cameras' previews, each one's page a tap away (remote-client.html);
 *  - Be a rig: Hand Tracker's page with only what a camera rig needs (index.html?rig=1, app.js's
 *    rig mode): remote recording on, the cameras off until a phone or browser starts them.
 * The pages it opens come back here (their ← Remote Recording, or the phone's Back): this page
 * marks the tab as Remote Recording's (sessionStorage), which they read.
 * Opened at login as a rig (the computer apps' "Open when this computer starts"), the app goes
 * straight to the rig (electron/main.js).
 */

(function (global) {
  const $ = (id) => document.getElementById(id);
  const PAGES = { control: "remote.html", rig: "index.html?rig=1" };

  try {
    sessionStorage.setItem("hand-tracker:app", "remote");
  } catch {}

  const build = document.querySelector('meta[name="hand-tracker-build"]');
  if (build) $("buildInfo").textContent = `v${build.dataset.version}`;
  else if (global.desktop && global.desktop.getInfo) global.desktop.getInfo().then((i) => i && i.version && ($("buildInfo").textContent = `v${i.version}`), () => {});

  // Being a rig needs the app: the computer apps (window.desktop) or the phone apps (Capacitor's
  // native bridge). Controlling one works from a website too (remote.html opens a computer's own page).
  const cap = global.Capacitor;
  const app = !!global.desktop || !!(cap && (cap.isNativePlatform ? cap.isNativePlatform() : cap.platform && cap.platform !== "web"));
  for (const b of document.querySelectorAll(".choice")) {
    if (b.dataset.mode === "rig") b.disabled = !app;
    b.addEventListener("click", () => {
      if (!b.disabled) location.href = PAGES[b.dataset.mode];
    });
  }
  $("noApp").hidden = app;

  // Back here from being a rig, in the phone apps: remote recording stops (on a computer,
  // electron/main.js stops it as the rig's page is left). Nothing when it wasn't on.
  const available = (name) => (cap && typeof cap.isPluginAvailable === "function" ? cap.isPluginAvailable(name) : !!(cap && cap.Plugins && cap.Plugins[name]));
  if (!global.desktop && available("RigServer")) Promise.resolve(cap.Plugins.RigServer.stop()).catch(() => {});

  // The build's own check in the iPhone simulator (-HTSelfTest): the rig, whose page runs it.
  if (global.__htSelfTest) setTimeout(() => (location.href = PAGES.rig), 300);
})(window);
