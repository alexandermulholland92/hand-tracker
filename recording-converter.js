/**
 * recording-converter.js — Recording Converter's first page in the phone apps (an app of its own,
 * for Android, iPhone and iPad; the computer apps open viewer.html itself): the Recording
 * Converter (viewer.html) on its own. It marks the tab as the converter's (sessionStorage, as
 * remote-recording.js does for Remote Recording), which viewer.js reads (no "Back to tracker"
 * there: there's no tracker in the app), and opens it in its place, so the phone's Back leaves
 * the app from there.
 */

(function () {
  try {
    sessionStorage.setItem("hand-tracker:app", "converter");
  } catch {}
  location.replace("viewer.html");
})();
