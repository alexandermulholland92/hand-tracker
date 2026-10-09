// config.js — before the tracker loads (control.html): its hidden-page timer runs in this
// extension's own worker file, as a Chrome extension can't run one from a blob.
window.HT_TIMER_WORKER = "steady-timer.js";

// MediaPipe prints its own notes ("I0000 00:00:… Successfully created a WebGL context") as
// console warnings, which Chrome's extensions page lists under Errors: its info and warning
// notes are left out there; its errors (E…, F…) and everything else still show.
(() => {
  const warn = console.warn.bind(console);
  console.warn = (...args) => {
    if (typeof args[0] === "string" && /^[IW]\d{4} \d\d:\d\d:/.test(args[0])) return;
    warn(...args);
  };
})();
