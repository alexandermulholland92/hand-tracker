/**
 * camera-settings.js — each camera's own settings on this computer's own pages (Windows, Mac and
 * Linux app): the ones remote recording's page has under each camera's ⚙ (remote-client.js keeps
 * its own copy of these tables, for the phones; check.js keeps the two the same).
 *   - Under each tile's ⚙ in Several cameras (multi-camera.js): that camera's.
 *   - In the main page's Cameras card: every camera found (and each picked one that isn't),
 *     ticked or not, its role and its ⚙, as remote recording's Cameras box has them.
 *
 *   CameraSettings.html(camera, disabled)   // a camera as remote recording lists it
 *                                           //   ({ id, tracking, oak? , kinect?, ps4? }): its settings
 *   CameraSettings.wire(el, change)         // its switches and menus -> change(action, data), as
 *                                           //   remote recording's commands: "pick" { id, tracking },
 *                                           //   "oak" { id, options }, "kinect" { id, options }, "ps4" { id, options };
 *                                           //   and "ps4firmware" { id }: its firmware file to choose here
 *   CameraSettings.initCard({ remote, card, rows, note, refresh })   // the main page's Cameras card
 *                                           //   (remote: RemoteRecordUI's cameras/changeCamera/scanCameras)
 * A camera that doesn't find objects itself (not an OAK camera) has Sentry's second look too
 * ({ secondLook }: its switch, "pick" { id, secondLook }).
 */
(function (global) {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---------- the tables (remote-client.js has the same) ----------
  // Sentry's second look (sentry.js, second-look.js): its switch and what it does.
  const SECOND_LOOK = ["Second look at animals (Sentry)", "With Track animals, an animal found in this camera's picture is an alert only once a second model (YOLOv8 nano, as OAK cameras run) finds one there too, and not where it finds a person. Its model (13 MB) is downloaded the first time it's turned on."];
  const OAK_CHOICES = {
    model: ["Hand model", [["lite", "Lite"], ["full", "Full"]]],
    hands: ["Hands", [[1, "One"], [2, "Two"]]],
    fps: ["Frame rate", [[0, "Automatic"], [60, "60"]]],
    picture: ["Picture", [["color", "Colour"], ["depth", "Depth"], ["blend", "Colour + depth"], ["side", "Colour | depth"], ["left", "Left mono"], ["right", "Right mono"]]],
    night: ["Night vision", [["auto", "Automatic"], ["on", "On"], ["off", "Off"]]],
  };
  const OAK_SWITCHES = { depth: "Depth (each hand's distance)", detect: "Find objects", dots: "Infrared dots (better depth, day or night; dots on the black-and-white pictures)" };
  const OAK_NUMBERS = new Set(["hands", "fps"]);
  const KINECT_CHOICES = {
    picture: ["Picture", [["color", "Colour (infrared at night)"], ["depth", "Depth"], ["blend", "Colour + depth"], ["side", "Colour | depth"]]],
    night: ["Night vision (its infrared camera)", [["auto", "Automatic"], ["on", "On"], ["off", "Off"]]],
    size: ["Picture size", [["960x540", "960 × 540"], ["1440x810", "1440 × 810"], ["1920x1080", "1920 × 1080"]]],
    model: ["Hand model", [["lite", "Lite"], ["full", "Full"]]],
    hands: ["Hands", [[1, "One"], [2, "Two"]]],
    people: ["People (bodies)", [[1, "1"], [2, "2"], [3, "3"], [4, "4"], [5, "5"], [6, "6"]]],
    exposure: ["Brightness", [[-2, "−2"], [-1, "−1"], [0, "Automatic"], [1, "+1"], [2, "+2"]]],
    led: ["Its light", [["on", "On"], ["dim", "Dim"], ["off", "Off"]]],
    range: ["Depth up to", [[3, "3 m"], [4.5, "4.5 m"], [8, "8 m"]]],
    processing: ["Depth worked out by", [["auto", "Automatic"], ["gpu", "The graphics chip"], ["cpu", "The processor"]]],
  };
  const KINECT_SWITCHES = { bodies: "Bodies (25 joints each)", faces: "Faces (which way each looks, and its expressions)", depth: "Depth (each hand's place)", filters: "Depth smoothing",
    mics: "Its microphones", saveDepth: "Keep the depth and infrared with each take", saveColor: "Keep its full-size colour (1920 × 1080) with each take", saveSound: "Keep its sound with each take" };
  const KINECT_NUMBERS = new Set(["hands", "people", "exposure", "range"]);
  // (Only where libfreenect2 works the depth out: Linux.)
  const KINECT_LINUX = new Set(["processing", "filters"]);
  const PS4_CHOICES = {
    picture: ["Picture", [["side", "Both lenses side by side"], ["merged", "Merged into one"], ["anaglyph", "Red/cyan 3D"], ["blend", "Laid over each other"], ["left", "Left lens"], ["right", "Right lens"],
      ["depth", "Depth"], ["depth-blend", "Picture + depth"], ["depth-side", "Picture | depth"]]],
    night: ["Night vision (black and white, brightened)", [["auto", "Automatic"], ["on", "On"], ["off", "Off"]]],
    model: ["Hand model", [["lite", "Lite"], ["full", "Full"]]],
    hands: ["Hands", [[1, "One"], [2, "Two"]]],
    size: ["Picture size (each lens)", [["1280x800", "1280 × 800"], ["640x400", "640 × 400 (faster)"]]],
    fps: ["Frame rate", [[15, "15"], [30, "30"], [60, "60"], [120, "120 (640 × 400)"]]],
  };
  const PS4_SWITCHES = { depth: "Depth (each hand's distance)" };
  const PS4_NUMBERS = new Set(["hands", "fps"]);

  // ---------- one camera's settings ----------
  function html(c, disabled = false) {
    const id = esc(c.id), dis = disabled ? " disabled" : "", on = c.tracking !== false;
    const sw = (kind, k, label, value) =>
      `<div class="cs-row"><span class="cs-grow">${label}</span><button type="button" class="small${value ? " on" : ""}" data-csid="${id}" data-cskind="${kind}" data-csset="${k}" aria-pressed="${!!value}"${dis}>${value ? "On" : "Off"}</button></div>`;
    const choice = (kind, k, [label, options], value) =>
      `<div class="cs-row"><span class="cs-grow">${label}</span><select data-csid="${id}" data-cskind="${kind}" data-csset="${k}"${dis}>` +
      options.map(([v, t]) => `<option value="${v}"${String(value) === String(v) ? " selected" : ""}>${t}</option>`).join("") + "</select></div>";
    let out = sw("pick", "tracking", "Hand tracking", on);
    if (c.oak) {
      const o = c.oak, depth = o.hasDepth !== false, infrared = o.infrared !== false;
      out += choice("oak", "model", OAK_CHOICES.model, o.model) + choice("oak", "hands", OAK_CHOICES.hands, o.hands) + (depth ? sw("oak", "depth", OAK_SWITCHES.depth, o.depth) : "") +
        choice("oak", "fps", OAK_CHOICES.fps, o.fps) + sw("oak", "detect", OAK_SWITCHES.detect, o.detect) + (depth ? choice("oak", "picture", OAK_CHOICES.picture, o.picture) : "") +
        (infrared ? choice("oak", "night", OAK_CHOICES.night, o.night) + sw("oak", "dots", OAK_SWITCHES.dots, o.dots) : "");
      out += `<div class="cs-sub">${infrared ? (o.infrared === null ? "Night vision needs an infrared light (OAK-D Pro); Automatic turns it on when it's dark. " : "Night vision: Automatic turns it on when it's dark. ") : "This camera has no infrared light, so no night vision. "}` +
        "Changed while the camera runs, it starts again with them (a few seconds).</div>";
    } else if (c.kinect) {
      const o = c.kinect, linux = o.linux !== false, keep = (k) => linux || !KINECT_LINUX.has(k);
      for (const k of ["picture", "night"]) out += choice("kinect", k, KINECT_CHOICES[k], o[k]);
      out += sw("kinect", "bodies", KINECT_SWITCHES.bodies, o.bodies) + choice("kinect", "people", KINECT_CHOICES.people, o.people) + sw("kinect", "faces", KINECT_SWITCHES.faces, o.faces) +
        sw("kinect", "depth", KINECT_SWITCHES.depth, o.depth);
      for (const k of ["model", "hands", "size", "exposure", "led", "range", "processing"]) if (keep(k)) out += choice("kinect", k, KINECT_CHOICES[k], o[k]);
      for (const k of ["filters", "mics", "saveDepth", "saveColor", "saveSound"]) if (keep(k)) out += sw("kinect", k, KINECT_SWITCHES[k], o[k]);
      const where = o.pipeline === "opengl" ? "with the graphics chip" : o.pipeline === "cpu" ? "by the processor" : o.pipeline ? `by ${esc(o.pipeline)}` : "";
      out += `<div class="cs-sub">Bodies: each person's 25 joints, where they are, each hand open, closed or "lasso". ` +
        (linux ? `Depth smoothing evens out the depth, but on a Raspberry Pi it takes most of the graphics chip, which the hand model needs. ${where ? `Its depth is worked out ${where} now. ` : ""}` : "") +
        "Picture size, Its microphones and Depth worked out by start it again (a few seconds); the rest change as it runs.</div>";
    } else if (c.ps4) {
      const o = c.ps4;
      for (const k of ["picture", "night"]) out += choice("ps4", k, PS4_CHOICES[k], o[k]);
      out += sw("ps4", "depth", PS4_SWITCHES.depth, o.depth);
      for (const k of ["model", "hands", "size", "fps"]) out += choice("ps4", k, PS4_CHOICES[k], o[k]);
      out += `<div class="cs-row"><span class="cs-grow">Its firmware (Sony's firmware.bin, sent each time it's plugged in)</span><button type="button" class="small" data-csfirmware="${id}"${dis}>Choose…</button></div>`;
      out += '<div class="cs-sub">The hands are found on its left lens\'s picture; Merged and the depth pictures work the depth out too. ' +
        "Night vision: it has no light of its own, so in the dark its pictures are made black and white and brightened. Picture size and Frame rate start it again (a few seconds); the rest change as it runs.</div>";
    } else out += '<div class="cs-sub">Off: a take records this camera\'s video, without its hands.</div>';
    // (An OAK camera's animals always have a second look: the app's own object finder.)
    if (!c.oak && typeof c.secondLook === "boolean") out += sw("pick", "secondLook", SECOND_LOOK[0], c.secondLook) + `<div class="cs-sub">${SECOND_LOOK[1]}</div>`;
    return out;
  }

  // Its switches and menus, as remote recording's commands.
  function wire(el, change) {
    el.addEventListener("click", (e) => {
      const f = e.target.closest && e.target.closest("button[data-csfirmware]");
      if (f && !f.disabled) return change("ps4firmware", { id: f.dataset.csfirmware });
      const b = e.target.closest && e.target.closest("button[data-csset]");
      if (!b || b.disabled) return;
      const id = b.dataset.csid, kind = b.dataset.cskind, k = b.dataset.csset, v = b.getAttribute("aria-pressed") !== "true";
      change(kind, kind === "pick" ? { id, [k]: v } : { id, options: { [k]: v } });
    });
    el.addEventListener("change", (e) => {
      const s = e.target;
      if (!s.dataset || !s.dataset.csset || s.tagName !== "SELECT") return;
      const kind = s.dataset.cskind, k = s.dataset.csset;
      const number = (kind === "kinect" ? KINECT_NUMBERS : kind === "ps4" ? PS4_NUMBERS : OAK_NUMBERS).has(k);
      change(kind, { id: s.dataset.csid, options: { [k]: number ? Number(s.value) : s.value } });
    });
  }

  // ---------- the main page's Cameras card ----------
  // Every camera found here, picked or not (as remote recording's Cameras box), redrawn as it
  // changes (not while one of its menus is open).
  function initCard({ remote, card, rows, note, refresh }) {
    if (!remote || !remote.cameras || !card || !rows) return;
    card.hidden = false;
    const open = new Set();
    let shown = "", message = "";
    const say = (text) => {
      message = text || "";
      draw(true);
    };
    async function act(action, data) {
      try {
        // (A PS4 camera's firmware file is chosen on this computer, not sent as a setting.)
        if (action === "ps4firmware") {
          const r = await desktop.ps4cam.chooseFirmware();
          return r.canceled ? undefined : say(r.ok ? "The PS4 camera's firmware is kept: it starts with it." : r.reason);
        }
        const res = await remote.changeCamera(action, action === "pick" ? { pick: data } : { [action]: data });
        say(res && res.message ? res.message : "");
      } catch (err) {
        say(String((err && err.message) || err));
      }
    }
    function draw(force) {
      const st = remote.cameraState ? remote.cameraState() : {};
      const list = remote.cameras();
      const busy = !!(st.running || st.recording || st.pending), fixed = !!st.recording;
      const sig = JSON.stringify(list) + busy + fixed + [...open].join() + message + (st.scanning ? 1 : 0);
      const using = document.activeElement && document.activeElement.tagName === "SELECT" && rows.contains(document.activeElement);
      if ((!force && sig === shown) || using) return;
      shown = sig;
      const roles = (role) => (global.CameraRoles ? CameraRoles.options(role) : "");
      rows.innerHTML = list.length
        ? list.map((c) =>
          `<div class="cs-cam"><label><input type="checkbox" data-pick="${esc(c.id)}"${c.use ? " checked" : ""}${(c.present ? !busy : c.use && !fixed) ? "" : " disabled"} /> ` +
          `<span>${esc(c.label)}${c.present ? "" : ' <span class="cs-gone">not plugged in</span>'}</span></label>` +
          `<select data-role="${esc(c.id)}" aria-label="Role of ${esc(c.label)}"${busy ? " disabled" : ""}>${roles(c.role)}</select>` +
          `<button type="button" class="small" data-open="${esc(c.id)}" aria-expanded="${open.has(c.id)}" aria-label="Settings of ${esc(c.label)}">⚙</button></div>` +
          (open.has(c.id) ? `<div class="cs-set">${html(c, fixed)}</div>` : "")).join("")
        : "";
      if (note) {
        note.textContent = message || (st.scanning ? "Looking for cameras…" : !list.length ? "No cameras found. Plug one in, then Refresh." :
          busy ? "The cameras ticked are on (Several cameras). Close them to choose others; each one's ⚙ still changes its settings." :
          "Tick the cameras for Several cameras and remote recording; each one's role is where it's worn, and its ⚙ has its own settings.");
      }
    }
    wire(rows, act);
    rows.addEventListener("click", (e) => {
      const b = e.target.closest && e.target.closest("button[data-open]");
      if (!b) return;
      const id = b.dataset.open;
      open.has(id) ? open.delete(id) : open.add(id);
      draw(true);
    });
    rows.addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset && t.dataset.pick) act("pick", { id: t.dataset.pick, use: t.checked });
      else if (t.dataset && t.dataset.role !== undefined && t.tagName === "SELECT") act("pick", { id: t.dataset.role, role: t.value });
    });
    if (refresh)
      refresh.addEventListener("click", () => {
        message = "";
        Promise.resolve(remote.scanCameras()).finally(() => draw(true));
        draw(true);
      });
    // A first look once the card's seen (listing cameras opens none, but nothing's looked for
    // before then), then redrawn as things change.
    let looked = false;
    const look = () => {
      if (looked) return;
      looked = true;
      Promise.resolve(remote.scanCameras()).finally(() => draw(true));
    };
    if (typeof IntersectionObserver === "function") {
      const seen = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          seen.disconnect();
          look();
        }
      });
      seen.observe(card);
    } else look();
    setInterval(() => !card.hidden && draw(false), 1000);
    draw(true);
  }

  global.CameraSettings = { html, wire, initCard, OAK_CHOICES, OAK_SWITCHES, KINECT_CHOICES, KINECT_SWITCHES, KINECT_NUMBERS, KINECT_LINUX, PS4_CHOICES, PS4_SWITCHES, PS4_NUMBERS };
})(window);
