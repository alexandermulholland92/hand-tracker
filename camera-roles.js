/**
 * camera-roles.js — where each of several cameras is worn: head, chest, left wrist or right
 * wrist (the same names as a capture session's camera positions, ops-sessions.js). Several
 * cameras (multi-camera.js) and several videos (multi-video.js) give each camera a role;
 * its hands and files are named after it.
 *
 *   CameraRoles.ROLES                    [{ id: "head", label: "Head" }, …]
 *   CameraRoles.label(id)                "Left wrist" ("" for no role)
 *   CameraRoles.guess(name)              a role from a camera's or file's name ("…_head.mp4",
 *                                        "wrist_left"), or ""
 *   CameraRoles.assign(sources)          roles for [{ name, saved }]: each one's saved role ("" if
 *                                        set to none), else the one its name says, else the next
 *                                        free one in order; no role twice
 *   CameraRoles.pick(roles, i, role)     roles with source i set to role; a source that had it
 *                                        takes source i's old one instead, so no role is used twice
 *   CameraRoles.options(selected)        the <option>s for a role <select>
 */

(function (global) {
  const ROLES = [
    { id: "head", label: "Head" },
    { id: "chest", label: "Chest" },
    { id: "wrist_left", label: "Left wrist" },
    { id: "wrist_right", label: "Right wrist" },
  ];
  const ids = ROLES.map((r) => r.id);

  const label = (id) => (ROLES.find((r) => r.id === id) || {}).label || "";

  // Words in a name, split at anything that isn't a letter or digit and at camelCase.
  function guess(name) {
    const words = String(name || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const has = (...w) => w.some((x) => words.includes(x));
    if (has("head", "helmet")) return "head";
    if (has("chest", "torso")) return "chest";
    if (has("wrist")) {
      if (has("left", "l")) return "wrist_left";
      if (has("right", "r")) return "wrist_right";
    }
    if (has("lwrist", "leftwrist", "wristleft")) return "wrist_left";
    if (has("rwrist", "rightwrist", "wristright")) return "wrist_right";
    return "";
  }

  function assign(sources) {
    const out = sources.map(() => "");
    const used = new Set();
    const take = (i, role) => {
      if (!role || !ids.includes(role) || used.has(role) || out[i]) return;
      out[i] = role;
      used.add(role);
    };
    const none = sources.map((s) => s.saved === ""); // set to no role before: stays that way
    sources.forEach((s, i) => take(i, s.saved));
    sources.forEach((s, i) => none[i] || take(i, guess(s.name)));
    sources.forEach((s, i) => none[i] || take(i, ids.find((r) => !used.has(r))));
    return out;
  }

  function pick(roles, i, role) {
    const out = roles.slice();
    const other = role ? out.findIndex((r, j) => j !== i && r === role) : -1;
    if (other >= 0) out[other] = out[i];
    out[i] = role;
    return out;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const options = (selected) =>
    [{ id: "", label: "No role" }, ...ROLES].map((r) => `<option value="${esc(r.id)}"${r.id === (selected || "") ? " selected" : ""}>${esc(r.label)}</option>`).join("");

  global.CameraRoles = { ROLES, label, guess, assign, pick, options };
})(window);
