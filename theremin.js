/**
 * theremin.js — Theremin mode: your hands play a theremin in front of the camera. Where they are sets the
 * note and the volume, in one of four ways (the "Play with" choice):
 *   - "theremin", like a real one: the right hand's nearest part to a pitch line on your right-hand side of
 *     the picture sets the note (nearer, higher); the left hand's height the volume (lower, quieter, as over
 *     a real theremin's volume loop);
 *   - "updown", both hands up and down: the right hand higher, a higher note; the left hand higher, louder;
 *   - "distance": the right hand's distance from the camera sets the note (nearer, higher: measured by a
 *     depth camera, OAK-D or Kinect, else told by the hand's size in the picture); the left hand's height the
 *     volume, as with "theremin";
 *   - "onehand": one hand (the right if both are in view): its height the note, how far apart its thumb and
 *     index finger are the volume (pinched shut, silent).
 * With no hand for the note it's silent; with no hand for the volume it plays at full volume, as a real
 * theremin does with no hand near its loop. The note slides freely, as on a real theremin, or with Snap to
 * notes lands on a key's scale. Its tone: a theremin's, nearly a pure sine with a little vibrato.
 *
 * Its sound goes into recordings started while it's on: camera-video.js's clips (remote recording's takes,
 * Sentry mode's clips), mixed with their microphone's sound or as their only sound, and the Record card's
 * video (video-recorder.js). Its guides are drawn over the picture on screen, not into recordings.
 *
 *   Theremin.init({ wrap, stage, toggle, prefs, setPref })   // the page's switch and options (index.html)
 *   Theremin.update(hands, { mirror, aspect })                // each tracked frame (app.js)
 *   Theremin.playing()                                        // switched on (and able to make sound)
 *   Theremin.recordingTrack(micTrack | null)                  // -> { track, stop() } or null: its sound for one
 *                                                             //   recording, with the microphone's if given
 *   Theremin._test                                            // for the checks
 *
 * The switch starts off each time (a page can't start sound before you click); the choices are remembered.
 */

(function (global) {
  const STYLES = ["theremin", "updown", "distance", "onehand"];
  const SCALES = {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    pentatonic: [0, 2, 4, 7, 9],
    minorPentatonic: [0, 3, 5, 7, 10],
    blues: [0, 3, 5, 6, 7, 10],
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  };
  // The notes played, as MIDI numbers (60 = middle C): three octaves up from the lowest.
  const RANGES = { low: { from: 36, octaves: 3 }, mid: { from: 48, octaves: 3 }, high: { from: 60, octaves: 3 } };
  const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const DEFAULTS = { style: "theremin", snap: false, key: 0, scale: "major", range: "mid", volume: 0.6 };

  // Where hands play, in the picture (0-1: x across, unmirrored, so 0 is the player's right-hand side for a
  // camera facing them; y down):
  const AERIAL = { near: 0.03, far: 0.75 }; // the pitch line at x 0: the right hand's nearest part this far from it
  const LOOP = { quiet: 0.88, loud: 0.4 }; // the left hand's palm this high: silent .. full ("theremin", "distance")
  const UP = { low: 0.88, high: 0.12 }; // the palm this high: the lowest .. the highest note ("updown", "onehand")
  const UP_VOLUME = { low: 0.88, high: 0.35 }; // the left palm this high: silent .. full ("updown")
  const DEPTH = { near: 250, far: 1500 }; // mm from a depth camera: the highest .. the lowest note
  const SIZE = { near: 0.34, far: 0.07 }; // or the palm's length (wrist to middle knuckle), in picture heights
  const PINCH = { shut: 0.2, open: 0.95 }; // thumb tip to index tip, in palm lengths: silent .. full
  const HOLD = 0.25; // semitones further a snapped note must be passed before the next one takes over
  const LEVEL = 0.32; // the loudest it plays (of the most a speaker takes), at the Volume slider's top
  const VIBRATO = { hz: 5.5, cents: 6 };
  const PALM = [0, 5, 9, 13, 17];

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const nameOf = (m) => `${NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;

  function palm(lm) {
    let x = 0, y = 0;
    for (const i of PALM) {
      x += lm[i].x;
      y += lm[i].y;
    }
    return { x: x / PALM.length, y: y / PALM.length };
  }
  // Between two of a hand's points, in picture heights (x made the same scale as y).
  const span = (lm, a, b, aspect) => Math.hypot((lm[a].x - lm[b].x) * aspect, lm[a].y - lm[b].y);

  // The hand of that side, one tracked in this frame before one only held from a moment ago.
  function pick(hands, side) {
    let held = null;
    for (const h of hands || []) {
      if (!h || h.handedness !== side || !h.imageLandmarks || h.imageLandmarks.length < 21) continue;
      if (!h.held) return h;
      held = held || h;
    }
    return held;
  }

  // What the hands play: { pitch: 0..1 (lowest .. highest note) or null (no hand for it), volume: 0..1,
  // pitchHand, volumeHand, near (the pitch line's distance), depth (mm), size, pinch }.
  function read(hands, style, aspect = 16 / 9) {
    const R = pick(hands, "Right"), L = pick(hands, "Left");
    if (style === "onehand") {
      const h = R || L;
      if (!h) return { pitch: null, volume: 0, pitchHand: null, volumeHand: null };
      const lm = h.imageLandmarks;
      const pinch = span(lm, 4, 8, aspect) / Math.max(1e-6, span(lm, 0, 9, aspect));
      return {
        pitch: clamp01((UP.low - palm(lm).y) / (UP.low - UP.high)),
        volume: clamp01((pinch - PINCH.shut) / (PINCH.open - PINCH.shut)),
        pitchHand: h, volumeHand: h, pinch,
      };
    }
    const out = { pitch: null, volume: 1, pitchHand: R, volumeHand: L };
    if (R) {
      const lm = R.imageLandmarks;
      if (style === "updown") out.pitch = clamp01((UP.low - palm(lm).y) / (UP.low - UP.high));
      else if (style === "distance") {
        const z = R.distance && Number(R.distance[2]) > 0 ? Number(R.distance[2]) : null;
        if (z) {
          out.depth = z;
          out.pitch = clamp01(Math.log(DEPTH.far / z) / Math.log(DEPTH.far / DEPTH.near));
        } else {
          out.size = span(lm, 0, 9, aspect);
          out.pitch = clamp01(Math.log(out.size / SIZE.far) / Math.log(SIZE.near / SIZE.far));
        }
      } else {
        let near = 1;
        for (const q of lm) near = Math.min(near, q.x);
        out.near = Math.max(0, near);
        out.pitch = clamp01((AERIAL.far - out.near) / (AERIAL.far - AERIAL.near));
      }
    }
    if (L) {
      const y = palm(L.imageLandmarks).y;
      out.volume = style === "updown" ? clamp01((UP_VOLUME.low - y) / (UP_VOLUME.low - UP_VOLUME.high)) : clamp01((LOOP.quiet - y) / (LOOP.quiet - LOOP.loud));
    }
    return out;
  }

  // The scale's note nearest m (a MIDI number, fractional), within the range; the note now playing (current)
  // kept until m is HOLD semitones nearer another, so it doesn't flicker between two.
  function snap(m, key, scale, current, range) {
    const steps = SCALES[scale] || SCALES.major;
    const r = RANGES[range] || RANGES.mid;
    const lo = r.from, hi = r.from + 12 * r.octaves;
    const inScale = (n) => steps.includes((((n - key) % 12) + 12) % 12);
    let best = null;
    for (let n = Math.max(lo, Math.floor(m) - 4); n <= Math.min(hi, Math.ceil(m) + 4); n++) {
      if (inScale(n) && (best === null || Math.abs(n - m) < Math.abs(best - m))) best = n;
    }
    if (best === null) return Math.round(m);
    if (current !== null && current !== undefined && current !== best && inScale(current) && current >= lo && current <= hi &&
        Math.abs(m - current) < Math.abs(m - best) + HOLD) return current;
    return best;
  }

  // ---------- Sound ----------
  let ctx = null, osc = null, amp = null, master = null, out = null, analyser = null;
  let mixes = 0, sleepTimer = null, sessionWas = null, soundError = "";

  function build() {
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) throw new Error("This browser can't make sound (it has no Web Audio).");
    ctx = new AC({ latencyHint: "interactive" });
    osc = ctx.createOscillator();
    // (Nearly a pure sine, as a theremin's is, with a touch of its 2nd to 5th harmonics.)
    osc.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0, 0, 0]), new Float32Array([0, 1, 0.1, 0.035, 0.015, 0.006])));
    osc.frequency.value = hz(60);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = VIBRATO.hz;
    const depth = ctx.createGain();
    depth.gain.value = VIBRATO.cents;
    lfo.connect(depth);
    depth.connect(osc.detune);
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 3800;
    tone.Q.value = 0.3;
    amp = ctx.createGain(); // what the hands ask for
    amp.gain.value = 0;
    master = ctx.createGain(); // the Volume slider
    master.gain.value = LEVEL * settings.volume;
    out = ctx.createGain();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    osc.connect(tone);
    tone.connect(amp);
    amp.connect(master);
    master.connect(out);
    out.connect(ctx.destination);
    out.connect(analyser);
    osc.start();
    lfo.start();
  }

  // Phones: on an iPhone the page's sound would follow the ring/silent switch; asked for as media playback, it
  // plays (as a music app's does) while the theremin is on.
  function audioSession(on) {
    const s = global.navigator && global.navigator.audioSession;
    if (!s || typeof s.type !== "string") return;
    try {
      if (on && s.type === "auto") {
        sessionWas = s.type;
        s.type = "playback";
      } else if (!on && sessionWas !== null) {
        s.type = sessionWas;
        sessionWas = null;
      }
    } catch {
      // (left as it was)
    }
  }

  // Sound off a moment after the theremin is switched off and nothing records it: no work for the computer.
  function sleepSoon() {
    clearTimeout(sleepTimer);
    sleepTimer = setTimeout(() => {
      if (!on && !mixes && ctx && ctx.state === "running") ctx.suspend().catch(() => {});
    }, 400);
  }

  // ---------- State and the page ----------
  let settings = { ...DEFAULTS };
  let on = false, last = null, playing = null, ui = null, savePref = null, readoutAt = 0;

  function setParams(r) {
    if (!ctx) return;
    const now = ctx.currentTime;
    if (r.pitch === null) {
      amp.gain.setTargetAtTime(0, now, 0.08);
      return;
    }
    osc.frequency.setTargetAtTime(r.hz, now, settings.snap ? 0.012 : 0.03);
    amp.gain.setTargetAtTime(r.volume * r.volume, now, 0.035);
  }

  function update(hands, { mirror = true, aspect = 16 / 9 } = {}) {
    if (!on) return;
    const r = read(hands, settings.style, aspect);
    const range = RANGES[settings.range] || RANGES.mid;
    if (r.pitch !== null) {
      r.m = range.from + r.pitch * 12 * range.octaves; // (the note the hand is at, between notes too)
      playing = settings.snap ? snap(r.m, settings.key, settings.scale, playing, settings.range) : null;
      r.note = settings.snap ? playing : r.m;
      r.hz = hz(r.note);
    } else playing = null;
    last = { ...r, pitchHand: undefined, volumeHand: undefined, at: performance.now() };
    setParams(r);
    draw(r, mirror, aspect);
    const now = performance.now();
    if (ui && now - readoutAt > 100) {
      readoutAt = now;
      ui.note.textContent = r.pitch === null
        ? (settings.style === "onehand" ? "Show a hand to play" : "Show your right hand to play")
        : `♪ ${nameOf(r.note)}${settings.snap ? "" : cents(r.note)} · ${Math.round(r.hz)} Hz · ${Math.round(r.volume * 100)}%`;
    }
  }
  function cents(m) {
    const c = Math.round((m - Math.round(m)) * 100);
    return c ? ` ${c > 0 ? "+" : "−"}${Math.abs(c)}¢` : "";
  }

  async function setOn(want) {
    if (want === on) return;
    if (want) {
      soundError = "";
      try {
        if (!ctx) build();
        clearTimeout(sleepTimer);
        audioSession(true);
        if (ctx.state !== "running") await ctx.resume();
      } catch (err) {
        soundError = err && err.message ? err.message : String(err);
        if (ui) {
          ui.options.hidden = false; // (the switch stays off; why is said in its bar)
          ui.note.textContent = soundError;
        }
        return;
      }
      on = true;
      if (ui) ui.note.textContent = settings.style === "onehand" ? "Show a hand to play" : "Show your right hand to play";
    } else {
      on = false;
      playing = null;
      if (amp) amp.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
      audioSession(false);
      sleepSoon();
      clearGuides();
    }
    syncUi();
  }

  function syncUi() {
    if (!ui) return;
    ui.toggle.classList.toggle("active", on);
    ui.toggle.setAttribute("aria-pressed", String(on));
    ui.toggle.textContent = `Theremin: ${on ? "ON" : "OFF"}`;
    ui.options.hidden = !on;
    ui.layer.hidden = !on;
    ui.style.value = settings.style;
    ui.snap.checked = settings.snap;
    ui.keyLabel.hidden = ui.scaleLabel.hidden = !settings.snap;
    ui.key.value = String(settings.key);
    ui.scale.value = settings.scale;
    ui.range.value = settings.range;
    ui.volume.value = String(Math.round(settings.volume * 100));
  }

  function choose(key, value) {
    settings[key] = value;
    playing = null;
    if (key === "volume" && master) master.gain.setTargetAtTime(LEVEL * value, ctx.currentTime, 0.05);
    if (savePref) savePref("theremin", { ...settings });
    syncUi();
  }

  function init({ wrap, stage, toggle, prefs = {}, setPref = null } = {}) {
    const saved = prefs.theremin && typeof prefs.theremin === "object" ? prefs.theremin : {};
    settings = {
      style: STYLES.includes(saved.style) ? saved.style : DEFAULTS.style,
      snap: saved.snap === true,
      key: Number.isInteger(saved.key) && saved.key >= 0 && saved.key < 12 ? saved.key : DEFAULTS.key,
      scale: SCALES[saved.scale] ? saved.scale : DEFAULTS.scale,
      range: RANGES[saved.range] ? saved.range : DEFAULTS.range,
      volume: typeof saved.volume === "number" && saved.volume >= 0 && saved.volume <= 1 ? saved.volume : DEFAULTS.volume,
    };
    savePref = setPref;
    const $ = (id) => document.getElementById(id);
    if (!toggle || !wrap || !stage) return;
    const layer = document.createElement("canvas");
    layer.id = "thereminLayer";
    layer.hidden = true;
    wrap.appendChild(layer);
    ui = {
      toggle, stage, layer, options: $("thereminOptions"), style: $("thereminStyle"), snap: $("thereminSnap"),
      keyLabel: $("thereminKeyLabel"), key: $("thereminKey"), scaleLabel: $("thereminScaleLabel"), scale: $("thereminScale"),
      range: $("thereminRange"), volume: $("thereminVolume"), note: $("thereminNote"),
    };
    toggle.addEventListener("click", () => setOn(!on));
    ui.style.addEventListener("change", () => choose("style", STYLES.includes(ui.style.value) ? ui.style.value : DEFAULTS.style));
    ui.snap.addEventListener("change", () => choose("snap", ui.snap.checked));
    ui.key.addEventListener("change", () => choose("key", Number(ui.key.value) || 0));
    ui.scale.addEventListener("change", () => choose("scale", SCALES[ui.scale.value] ? ui.scale.value : DEFAULTS.scale));
    ui.range.addEventListener("change", () => choose("range", RANGES[ui.range.value] ? ui.range.value : DEFAULTS.range));
    ui.volume.addEventListener("input", () => choose("volume", clamp01(Number(ui.volume.value) / 100)));
    syncUi();
  }

  // ---------- Guides over the picture (on screen only) ----------
  const PITCH_COLOR = "#ff922b"; // the right hand's colour (stage-overlay.js)
  const VOLUME_COLOR = "#4dabf7"; // the left hand's

  function clearGuides() {
    if (!ui) return;
    const g = ui.layer.getContext("2d");
    g.clearRect(0, 0, ui.layer.width, ui.layer.height);
  }

  function draw(r, mirror, aspect) {
    if (!ui) return;
    const c = ui.layer;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    const dpr = global.devicePixelRatio || 1;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    // Where the picture is in the box (the stage is fitted in, keeping its shape).
    const sw = ui.stage.width || 16, sh = ui.stage.height || 9;
    const s = Math.min(W / sw, H / sh);
    const cw = sw * s, ch = sh * s, ox = (W - cw) / 2, oy = (H - ch) / 2;
    const X = (x) => ox + (mirror ? 1 - x : x) * cw; // (a picture x, unmirrored, on screen)
    const Y = (y) => oy + y * ch;
    const unit = Math.max(1, cw / 640);
    g.lineCap = "round";
    g.font = `600 ${Math.round(13 * unit)}px system-ui, sans-serif`;
    const style = settings.style;
    const range = RANGES[settings.range] || RANGES.mid;

    // The note's line or scale, with the scale's notes marked when snapping (C's always).
    const marks = (x0, y0, x1, y1) => {
      const steps = SCALES[settings.scale] || SCALES.major;
      for (let n = range.from; n <= range.from + 12 * range.octaves; n++) {
        const isC = n % 12 === 0;
        if (!isC && !(settings.snap && steps.includes((((n - settings.key) % 12) + 12) % 12))) continue;
        const t = (n - range.from) / (12 * range.octaves);
        const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
        g.fillStyle = isC ? "#fff" : "rgba(255,255,255,0.65)";
        g.strokeStyle = "rgba(14,15,18,0.7)";
        g.lineWidth = 1.5 * unit;
        g.beginPath();
        g.arc(x, y, (isC ? 3 : 2) * unit, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        if (isC) {
          const text = nameOf(n), w = g.measureText(text).width;
          // (to the dot's left where the picture ends on its right)
          const tx = x + 6 * unit + w > ox + cw - 2 * unit ? x - 6 * unit - w : x + 6 * unit;
          g.lineWidth = 3 * unit;
          g.strokeText(text, tx, y + 4 * unit);
          g.fillStyle = "#fff";
          g.fillText(text, tx, y + 4 * unit);
        }
      }
    };
    const glowLine = (x0, y0, x1, y1, color, width) => {
      g.strokeStyle = color;
      g.globalAlpha = 0.25;
      g.lineWidth = width * 3;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      g.globalAlpha = 1;
      g.lineWidth = width;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    };
    const volumeBar = (x, yQuiet, yLoud, v) => {
      g.strokeStyle = "rgba(14,15,18,0.6)"; // (seen on a light picture too)
      g.lineWidth = 10 * unit;
      g.beginPath(); g.moveTo(x, yQuiet); g.lineTo(x, yLoud); g.stroke();
      g.strokeStyle = "rgba(255,255,255,0.35)";
      g.lineWidth = 6 * unit;
      g.beginPath(); g.moveTo(x, yQuiet); g.lineTo(x, yLoud); g.stroke();
      g.strokeStyle = VOLUME_COLOR;
      g.beginPath(); g.moveTo(x, yQuiet); g.lineTo(x, yQuiet + (yLoud - yQuiet) * v); g.stroke();
    };
    // (Picture x's: the player's right-hand side is x 0, shown on the right when mirrored; their left x 1.)
    const rightEdge = 0.015, leftSide = 0.88;

    if (style === "theremin" || style === "distance") {
      if (style === "theremin") {
        // The pitch line, like a theremin's upright aerial, and the reach that plays notes.
        glowLine(X(rightEdge), Y(0.06), X(rightEdge), Y(0.94), PITCH_COLOR, 3 * unit);
        const xFar = X(AERIAL.far), xNear = X(AERIAL.near);
        marks(xFar, Y(0.96), xNear, Y(0.96));
        if (r.pitchHand && r.near !== undefined) {
          const y = Y(palm(r.pitchHand.imageLandmarks).y);
          g.setLineDash([6 * unit, 5 * unit]);
          g.strokeStyle = PITCH_COLOR;
          g.lineWidth = 2 * unit;
          g.beginPath(); g.moveTo(X(r.near), y); g.lineTo(X(rightEdge), y); g.stroke();
          g.setLineDash([]);
        }
      } else {
        // Nearer the camera, higher: a meter of how near.
        const x0 = X(0.3), x1 = X(0.03), y = Y(0.06);
        g.strokeStyle = "rgba(14,15,18,0.6)";
        g.lineWidth = 10 * unit;
        g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
        g.strokeStyle = "rgba(255,255,255,0.35)";
        g.lineWidth = 6 * unit;
        g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
        marks(x0, y + 12 * unit, x1, y + 12 * unit);
        if (r.pitch !== null) {
          g.strokeStyle = PITCH_COLOR;
          g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + (x1 - x0) * r.pitch, y); g.stroke();
        }
        g.fillStyle = "#fff";
        g.fillText(r.depth ? `${(r.depth / 1000).toFixed(2)} m` : "nearer: higher", Math.min(x0, x1), y - 10 * unit);
      }
      // The volume loop: the left hand above it, louder the higher.
      const lx = X(leftSide), ly = Y(LOOP.quiet);
      g.strokeStyle = VOLUME_COLOR;
      g.lineWidth = 3 * unit;
      g.beginPath();
      g.ellipse(lx, ly, cw * 0.09, ch * 0.025, 0, 0, Math.PI * 2);
      g.stroke();
      volumeBar(X(0.98), Y(LOOP.quiet), Y(LOOP.loud), r.volume);
    } else {
      // A scale up the player's right-hand side: the hand's height plays the note.
      const x = X(style === "onehand" && r.pitchHand && r.pitchHand.handedness === "Left" ? 0.97 : 0.03);
      glowLine(x, Y(UP.low), x, Y(UP.high), PITCH_COLOR, 3 * unit);
      marks(x, Y(UP.low), x, Y(UP.high));
      if (r.pitch !== null) {
        const y = Y(UP.low + (UP.high - UP.low) * r.pitch);
        g.fillStyle = PITCH_COLOR;
        g.beginPath(); g.arc(x, y, 7 * unit, 0, Math.PI * 2); g.fill();
      }
      if (style === "updown") volumeBar(X(0.97), Y(UP_VOLUME.low), Y(UP_VOLUME.high), r.volume);
      else if (r.pitchHand) {
        // How open the pinch is, by the hand.
        const lm = r.pitchHand.imageLandmarks;
        g.strokeStyle = VOLUME_COLOR;
        g.lineWidth = 3 * unit;
        g.beginPath(); g.moveTo(X(lm[4].x), Y(lm[4].y)); g.lineTo(X(lm[8].x), Y(lm[8].y)); g.stroke();
      }
    }
    // The note, large, at the top.
    if (r.pitch !== null) {
      const text = nameOf(r.note);
      g.font = `700 ${Math.round(30 * unit)}px system-ui, sans-serif`;
      const w = g.measureText(text).width;
      g.fillStyle = "rgba(14,15,18,0.65)";
      g.fillRect(ox + cw / 2 - w / 2 - 12 * unit, oy + 8 * unit, w + 24 * unit, 40 * unit);
      g.fillStyle = "#fff";
      g.globalAlpha = 0.4 + 0.6 * r.volume;
      g.fillText(text, ox + cw / 2 - w / 2, oy + 38 * unit);
      g.globalAlpha = 1;
    }
  }

  // ---------- Recordings ----------
  // Its sound for one recording, mixed with the microphone's (track, if given): { track, stop() }, or null
  // (switched off, or its sound isn't running: the recording then keeps just the microphone, as before).
  function recordingTrack(mic) {
    if (!on || !ctx || ctx.state !== "running" || typeof ctx.createMediaStreamDestination !== "function") return null;
    let dest = null, src = null;
    try {
      dest = ctx.createMediaStreamDestination();
      out.connect(dest);
      if (mic) {
        src = ctx.createMediaStreamSource(new MediaStream([mic]));
        src.connect(dest);
      }
    } catch {
      try { if (dest) out.disconnect(dest); } catch { /* (not connected) */ }
      return null;
    }
    const track = dest.stream.getAudioTracks()[0];
    if (!track) {
      out.disconnect(dest);
      return null;
    }
    mixes++;
    let done = false;
    return {
      track,
      withMic: !!src,
      stop() {
        if (done) return;
        done = true;
        try { out.disconnect(dest); } catch { /* (already) */ }
        if (src) try { src.disconnect(); } catch { /* (already) */ }
        track.stop();
        mixes--;
        sleepSoon();
      },
    };
  }

  // How loud it is right now (0-1, the sound's RMS), for the checks.
  function level() {
    if (!analyser) return 0;
    const a = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(a);
    let sum = 0;
    for (const v of a) sum += v * v;
    return Math.sqrt(sum / a.length);
  }

  global.Theremin = {
    init,
    update,
    playing: () => on,
    recordingTrack,
    STYLES,
    _test: {
      read, snap, hz, nameOf, level, setOn, choose,
      last: () => last,
      settings: () => ({ ...settings }),
      state: () => (ctx ? ctx.state : "none"),
      mixes: () => mixes,
      error: () => soundError,
      RANGES, SCALES,
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
