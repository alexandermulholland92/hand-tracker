/**
 * take-names.js — a remote recording take's name: its details (contributor, location, task), its
 * length and when it started ("Sam_Lab-2_Pick-up-cup_1m05s_2026-10-01_16-30-00"), or
 * "robot-motion_<length>_<when>" without any details. The page that records takes
 * (remote-record-ui.js) names them; the computer that keeps them (electron/remote-record.js)
 * renames them when their details are changed afterwards.
 *
 *   TakeNames.DETAILS                       ["contributor", "location", "task"]
 *   TakeNames.lengthText(seconds, forName)  "1:05", or for a name "1m05s"
 *   TakeNames.takeName(details, when, seconds)
 *   TakeNames.renamed(id, details)          the name of take id with these details instead (its
 *                                           length and time kept), or null for a name not made
 *                                           this way
 */
(function (global) {
  const DETAILS = ["contributor", "location", "task"];
  const p2 = (n) => String(n).padStart(2, "0");

  function lengthText(seconds, forName) {
    const s = Math.max(0, Math.floor(seconds || 0)); // whole seconds, as the timer showed them
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (forName) return h ? `${h}h${p2(m)}m${p2(sec)}s` : m ? `${m}m${p2(sec)}s` : `${sec}s`;
    return h ? `${h}:${p2(m)}:${p2(sec)}` : `${m}:${p2(sec)}`;
  }

  // Each detail as a part of a file name: no characters a file name can't have, no spaces, kept
  // short (so the length and time always fit).
  const part = (v) => String(v || "").trim().replace(/[<>:"/\\|?*]+/g, "-").replace(/\s+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 28).replace(/[-.]+$/, "");
  const detailsPart = (d) => {
    const parts = DETAILS.map((k) => part((d || {})[k])).filter(Boolean);
    return parts.length ? parts : ["robot-motion"];
  };

  function takeName(d, when, seconds) {
    const t = new Date(when);
    const stamp = `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}_${p2(t.getHours())}-${p2(t.getMinutes())}-${p2(t.getSeconds())}`;
    return [...detailsPart(d), lengthText(seconds, true), stamp].join("_");
  }

  const ENDING = /_(\d+h\d{2}m\d{2}s|\d+m\d{2}s|\d+s)_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})$/;
  function renamed(id, d) {
    const m = ENDING.exec(String(id || ""));
    if (!m || m.index === 0) return null;
    return [...detailsPart(d), m[1], m[2]].join("_");
  }

  const api = { DETAILS, lengthText, takeName, renamed };
  if (typeof module === "object" && module.exports) module.exports = api;
  global.TakeNames = api;
})(typeof window !== "undefined" ? window : globalThis);
