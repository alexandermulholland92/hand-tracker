// config.js — before the tracker loads (control.html): its hidden-page timer runs in this
// extension's own worker file, as a Chrome extension can't run one from a blob.
window.HT_TIMER_WORKER = "steady-timer.js";
