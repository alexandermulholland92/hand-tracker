/**
 * camera-roles.js — where each of several cameras is: worn (head, chest, left wrist or right
 * wrist: the same names as a capture session's camera positions, ops-sessions.js) or set up
 * around the scene (north, south, east or west). Several cameras (multi-camera.js) and several
 * videos (multi-video.js) give each camera a role; its hands and files are named after it.
 *
 *   CameraRoles.ROLES                    [{ id: "head", label: "Head" }, …, { id: "north", … }, …]
 *   CameraRoles.label(id)                "Left wrist" ("" for no role)
 *   CameraRoles.guess(name)              a role from a camera's or file's name ("…_head.mp4",
 *                                        "wrist_left", "north"), or ""
 *   CameraRoles.assign(sources)          roles for [{ name, saved }]: each one's saved role ("" if
 *                                        set to none), else the one its name says, else the next
 *                                        free one in order; no role twice
 *   CameraRoles.pick(roles, i, role)     roles with source i set to role; a source that had it
 *                                        takes source i's old one instead, so no role is used twice
 *   CameraRoles.options(selected)        the <option>s for a role <select>
 *   CameraRoles.blocks(roles)            where each of up to four sources goes in a 2 × 2 grid,
 *                                        by role: head or north top left, chest or south top right,
 *                                        left wrist or east bottom left, right wrist or west bottom
 *                                        right (one with no role, or whose block is taken, takes the
 *                                        first free block) -> { slots: [block per source],
 *                                        empty: [blocks], emptyLabels: [the roles they'd hold] }
 */

(function (global) {
  const WORN = [
    { id: "head", label: "Head" },
    { id: "chest", label: "Chest" },
    { id: "wrist_left", label: "Left wrist" },
    { id: "wrist_right", label: "Right wrist" },
  ];
  // Around the scene, in the grid's order (top left, top right, bottom left, bottom right).
  const AROUND = [
    { id: "north", label: "North" },
    { id: "south", label: "South" },
    { id: "east", label: "East" },
    { id: "west", label: "West" },
  ];
  const ROLES = [...WORN, ...AROUND];
  const ids = ROLES.map((r) => r.id);
  // A role's block in the grid: its place in its own set.
  const blockOf = (id) => {
    const w = WORN.findIndex((r) => r.id === id);
    return w >= 0 ? w : AROUND.findIndex((r) => r.id === id);
  };

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
    for (const r of AROUND) if (has(r.id)) return r.id;
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

  function blocks(roles) {
    const used = new Set();
    const slots = roles.map((r) => {
      const b = blockOf(r);
      if (b < 0 || used.has(b)) return -1;
      used.add(b);
      return b;
    });
    slots.forEach((b, i) => {
      if (b >= 0) return;
      const free = [0, 1, 2, 3].find((k) => !used.has(k));
      slots[i] = free !== undefined ? free : 4 + i;
      if (free !== undefined) used.add(free);
    });
    const empty = [0, 1, 2, 3].filter((k) => !used.has(k));
    // (what an empty block is waiting for: the set in use, around the scene if any camera is)
    const set = roles.some((r) => AROUND.some((a) => a.id === r)) && !roles.some((r) => WORN.some((w) => w.id === r)) ? AROUND : WORN;
    return { slots, empty, emptyLabels: empty.map((k) => set[k].label) };
  }

  global.CameraRoles = { ROLES, WORN, AROUND, label, guess, assign, pick, options, blocks };
})(window);
