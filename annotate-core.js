/**
 * annotate-core.js — the arithmetic of annotating a video (the Recording Viewer's Annotate and
 * electron/annotate.js; the same in the page and in the app): where the hands suggest a step
 * changes, Claude's steps for each stretch made one list, each step's picture quality and share
 * of hands in sight, and the useful footage (hands-on work with hands in sight).
 *
 *   AnnotateCore.handTrack(take, camera)        // { step, visible[], motion[] }: each half second of
 *                                               //   a take's hands (from one camera's, or all of them)
 *   AnnotateCore.candidateCuts(track)           // [seconds]: where the hands appear, go, start or stop moving
 *   AnnotateCore.cleanSteps(steps, from, to, cuts)   // one stretch's steps: in order, end to end,
 *                                               //   ends moved to a nearby cut
 *   AnnotateCore.joinSteps(list)                // the stretches' steps as one list (a step running on
 *                                               //   into the next stretch made one)
 *   AnnotateCore.cameraQuality(samples, info)   // a camera's pictures: bad/blur/dark/bright shares,
 *                                               //   longest bad stretch, its verdict
 *   AnnotateCore.stepQuality(step, samples)     // { verdict, bad, covered } for one step
 *   AnnotateCore.handsShare(step, track | flags) // the share of the step with hands in sight
 *   AnnotateCore.useful(duration, segments)     // how the recorded time breaks down, and the useful footage
 *   AnnotateCore.toCSV(annotations)             // the segments as a table
 *
 * A quality sample is { t, mean, sharp } (mean brightness 0-255, sharpness: the variance of the
 * picture's Laplacian at 160 pixels wide). A segment is { start, end, label, description, kind,
 * hands, quality, review }; kind is task, setup, waiting, screen or idle.
 */
(function (global) {
  const KINDS = ["task", "setup", "waiting", "screen", "idle"];
  const STEP = 0.5; // the hands' track, in half seconds
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

  // ---------- the hands ----------
  // A take's hands (Hand Tracker's JSON: hands, each with frames { t, landmarks… }) as each half
  // second: whether a hand was in sight, and how fast the wrists moved (picture widths a second).
  // camera: just the hands named after it ("Head Right"), else all of them.
  function handTrack(take, camera = "") {
    const hands = ((take && take.hands) || []).filter((h) => !camera || String(h.handedness || "").toLowerCase().startsWith(String(camera).toLowerCase() + " "));
    let end = num(take && take.duration);
    for (const h of hands) for (const f of h.frames || []) end = Math.max(end, num(f.t));
    const n = Math.max(1, Math.ceil(end / STEP));
    const seen = new Array(n).fill(0), motion = new Array(n).fill(0), count = new Array(n).fill(0);
    for (const h of hands) {
      let prev = null;
      const ee = (h.trajectories && h.trajectories.end_effector) || [];
      (h.frames || []).forEach((f, k) => {
        const i = Math.min(n - 1, Math.floor(num(f.t) / STEP));
        const w = Array.isArray(ee[k]) && ee[k].length >= 3 ? [num(ee[k][1]), num(ee[k][2])] : wrist(f);
        seen[i] = 1; // (a hand's frames are the ones it was in sight)
        if (!w) {
          prev = null;
          return;
        }
        if (prev && num(f.t) > prev.t && num(f.t) - prev.t < 0.5) {
          motion[i] += Math.hypot(w[0] - prev.w[0], w[1] - prev.w[1]) / (num(f.t) - prev.t);
          count[i]++;
        }
        prev = { t: num(f.t), w };
      });
    }
    return { step: STEP, duration: end, visible: seen, motion: motion.map((m, i) => (count[i] ? m / count[i] : 0)) };
  }
  // A frame's wrist in the picture (0-1), where the hand has no wrist path (end_effector: [t, x, y, z]
  // for each frame): its image landmarks' first, or its wrist.
  function wrist(f) {
    const lm = f.image_landmarks || f.imageLandmarks || f.landmarks_image;
    if (Array.isArray(lm) && lm[0]) return Array.isArray(lm[0]) ? [num(lm[0][0]), num(lm[0][1])] : [num(lm[0].x), num(lm[0].y)];
    const w = f.wrist_world || f.wrist;
    if (Array.isArray(w) && w.length >= 2) return [num(w[0]), num(w[1])];
    if (w && typeof w === "object") return [num(w.x), num(w.y)];
    return null;
  }

  // Where the hands suggest a step changes: each half second is none (no hand), still or moving;
  // runs shorter than 2 s are taken into their neighbours, and each change left is a cut.
  function candidateCuts(track, { minRun = 2, moving = 0.08 } = {}) {
    if (!track || !track.visible || !track.visible.length) return [];
    const st = track.visible.map((v, i) => (!v ? "none" : track.motion[i] > moving ? "moving" : "still"));
    const runs = [];
    for (let i = 0; i < st.length; i++) {
      if (runs.length && runs[runs.length - 1].s === st[i]) runs[runs.length - 1].n++;
      else runs.push({ s: st[i], n: 1 });
    }
    const min = Math.round(minRun / track.step);
    for (let changed = true; changed; ) {
      changed = false;
      for (let i = 0; i < runs.length; i++) {
        if (runs[i].n >= min || runs.length === 1) continue;
        const into = i === 0 ? 1 : i === runs.length - 1 ? i - 1 : runs[i - 1].n >= runs[i + 1].n ? i - 1 : i + 1;
        runs[into].n += runs[i].n;
        runs.splice(i, 1);
        for (let j = runs.length - 1; j > 0; j--) if (runs[j].s === runs[j - 1].s) (runs[j - 1].n += runs[j].n), runs.splice(j, 1);
        changed = true;
        break;
      }
    }
    const cuts = [];
    let at = 0;
    for (let i = 0; i < runs.length - 1; i++) {
      at += runs[i].n;
      cuts.push(round(at * track.step, 1));
    }
    return cuts;
  }

  // ---------- Claude's steps ----------
  // One stretch's steps (from..to s): known kinds, in order, end to end over the whole stretch
  // (a gap is the step before carried on), each end moved to a cut within 1.5 s.
  function cleanSteps(steps, from, to, cuts = []) {
    const list = (Array.isArray(steps) ? steps : [])
      .map((s) => ({ start: num(s.start, from), end: num(s.end, from), label: String(s.label || "").trim().slice(0, 140), description: String(s.description || "").trim().slice(0, 400), kind: KINDS.includes(s.kind) ? s.kind : "task" }))
      .filter((s) => s.label && s.end > s.start)
      .map((s) => ({ ...s, start: Math.max(from, Math.min(to, s.start)), end: Math.max(from, Math.min(to, s.end)) }))
      .filter((s) => s.end - s.start > 0.05)
      .sort((a, b) => a.start - b.start);
    if (!list.length) return [{ start: from, end: to, label: "Transition or idle", description: "Nothing task-related could be made out in this stretch.", kind: "idle" }];
    list[0].start = from;
    for (let i = 1; i < list.length; i++) {
      const snap = nearest(cuts, list[i].start, 1.5);
      const at = snap === null ? list[i].start : Math.max(list[i - 1].start + 0.5, Math.min(list[i].end - 0.5, snap));
      list[i - 1].end = at;
      list[i].start = at;
    }
    list[list.length - 1].end = to;
    return list.filter((s) => s.end - s.start > 0.05).map((s) => ({ ...s, start: round(s.start), end: round(s.end) }));
  }
  const nearest = (cuts, t, within) => {
    let best = null;
    for (const c of cuts) if (Math.abs(c - t) <= within && (best === null || Math.abs(c - t) < Math.abs(best - t))) best = c;
    return best;
  };

  // The stretches' steps as one list: where a stretch's last step and the next's first are the
  // same (label and kind), they're one step.
  function joinSteps(chunks) {
    const out = [];
    for (const steps of chunks) {
      for (const s of steps) {
        const last = out[out.length - 1];
        if (last && last.kind === s.kind && last.label.toLowerCase() === s.label.toLowerCase() && Math.abs(last.end - s.start) < 0.6) last.end = s.end;
        else out.push({ ...s });
      }
    }
    return out.map((s, i) => ({ id: `s${i + 1}`, ...s }));
  }

  // ---------- picture quality ----------
  // (A picture too dark or too bright isn't also called blurry: its sharpness can't be told.)
  const badOf = (s, floor) => {
    const dark = s.mean < 40, bright = s.mean > 230;
    return { dark, bright, blur: !dark && !bright && s.sharp < floor };
  };
  // A camera's sharpness floor: a fifth of its usual sharpness, and never under 15 (at 160 pixels).
  function sharpFloor(samples) {
    const v = samples.map((s) => s.sharp).sort((a, b) => a - b);
    return Math.max(15, (v.length ? v[v.length >> 1] : 0) * 0.2);
  }
  // A camera's pictures, as its samples say: the shares of bad (blurry, dark or bright) ones, the
  // longest bad stretch, how much of it was looked at, and its verdict (fail: a third bad; flag: a
  // tenth, or 10 s bad in a row).
  function cameraQuality(samples, { duration = 0, every = 0.5 } = {}) {
    const n = samples.length;
    if (!n) return { samples: 0, covered: 0, bad: 1, blur: 0, dark: 0, bright: 0, longestBad: 0, verdict: "fail" };
    const floor = sharpFloor(samples);
    let bad = 0, blur = 0, dark = 0, bright = 0, run = 0, longest = 0;
    for (const s of samples) {
      const b = badOf(s, floor);
      if (b.blur) blur++;
      if (b.dark) dark++;
      if (b.bright) bright++;
      if (b.blur || b.dark || b.bright) {
        bad++;
        run++;
        longest = Math.max(longest, run);
      } else run = 0;
    }
    const share = (k) => round(k / n, 3);
    const longestBad = round(longest * every, 1);
    const covered = duration > 0 ? Math.min(1, round((n * every) / duration, 3)) : 1;
    const verdict = bad / n >= 1 / 3 || covered < 0.8 ? "fail" : bad / n >= 0.1 || longestBad >= 10 ? "flag" : "pass";
    return { samples: n, covered, bad: share(bad), blur: share(blur), dark: share(dark), bright: share(bright), longestBad, sharpFloor: round(floor, 1), verdict };
  }
  // One step's pictures: reject (a quarter bad, or under 90% looked at), flag (a twentieth bad) or ok.
  function stepQuality(step, samples, { every = 0.5, floor = null } = {}) {
    const f = floor === null ? sharpFloor(samples) : floor;
    const inside = samples.filter((s) => s.t >= step.start && s.t < step.end);
    const want = Math.max(1, Math.round((step.end - step.start) / every));
    const covered = Math.min(1, round(inside.length / want, 2));
    const bad = inside.length ? round(inside.filter((s) => { const b = badOf(s, f); return b.blur || b.dark || b.bright; }).length / inside.length, 2) : 1;
    return { verdict: bad >= 0.25 || covered < 0.9 ? "reject" : bad >= 0.05 ? "flag" : "ok", bad, covered };
  }

  // The share of a step with hands in sight: from the hands' track (half seconds), or from
  // Claude's look at each frame (flags: [{ t, hands }]).
  function handsShare(step, from) {
    if (from && from.visible) {
      const a = Math.floor(step.start / from.step), b = Math.max(a + 1, Math.ceil(step.end / from.step));
      const part = from.visible.slice(a, Math.min(b, from.visible.length));
      return part.length ? round(part.reduce((x, v) => x + v, 0) / part.length, 2) : 0;
    }
    const flags = (from || []).filter((f) => f.t >= step.start && f.t < step.end);
    return flags.length ? round(flags.filter((f) => f.hands).length / flags.length, 2) : 0;
  }

  // How the recorded time breaks down: hands not in sight, then of the time they were, setup,
  // waiting (or idle) and screen work; what's left is useful footage. Each step counts by its
  // share of hands in sight (half in sight, half its length). Rejected steps aren't useful.
  function useful(duration, segments) {
    const out = { recorded: round(duration, 1), handsOut: 0, handsIn: 0, setup: 0, waiting: 0, screen: 0, rejected: 0, useful: 0 };
    for (const s of segments) {
      if (s.parent) continue; // (a subtask is inside its step)
      const len = Math.max(0, s.end - s.start), seen = len * num(s.hands);
      out.handsOut += len - seen;
      out.handsIn += seen;
      if (s.kind === "setup") out.setup += seen;
      else if (s.kind === "waiting" || s.kind === "idle") out.waiting += seen;
      else if (s.kind === "screen") out.screen += seen;
      else if (s.review === "rejected") out.rejected += seen;
      else out.useful += seen;
    }
    for (const k of Object.keys(out)) out[k] = round(out[k], 1);
    out.share = duration > 0 ? round(out.useful / duration, 3) : 0;
    return out;
  }

  // ---------- the table ----------
  function toCSV(a) {
    const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const rows = [["id", "parent", "start_s", "end_s", "kind", "label", "description", "hands_share", "quality", "bad_share", "covered", "review"].join(",")];
    for (const s of (a && a.segments) || [])
      rows.push([s.id, s.parent || "", s.start, s.end, s.kind, s.label, s.description, s.hands, s.quality ? s.quality.verdict : "", s.quality ? s.quality.bad : "", s.quality ? s.quality.covered : "", s.review || "pending"].map(q).join(","));
    return rows.join("\n") + "\n";
  }

  const api = { KINDS, handTrack, candidateCuts, cleanSteps, joinSteps, cameraQuality, stepQuality, sharpFloor, handsShare, useful, toCSV };
  if (typeof module === "object" && module.exports) module.exports = api;
  global.AnnotateCore = api;
})(typeof window !== "undefined" ? window : globalThis);
