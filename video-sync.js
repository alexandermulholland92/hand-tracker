/**
 * video-sync.js
 * Lines up several videos of the same moment (the cameras of a capture rig, say) from the
 * hand movement in them, using the motion capture tracked from each (Capture Whole Video).
 *
 *   const result = VideoSync.sync([{ name, duration, data }, ...]);
 *     data: the video's motion capture (robot-motion.js), whose time_origin_s + t is each
 *     frame's time in its video.
 *     -> { ok, message, reference, window: { start, end, length }, videos: [{ name, offset,
 *          trimStart, score, reason }] }
 *        offset: add it to a time in this video to get the time in the reference video.
 *        window: the stretch every video covers, on the reference video's clock; trimStart:
 *        where that stretch starts in this video.
 *   VideoSync.align(data, video, result) -> the motion capture on the shared clock (t = 0 at
 *     the window's start), trimmed to the window.
 *
 * How: each video's movement is measured at 30 samples a second as how fast the wrists
 * move (in hand lengths a second, so near and far cameras measure alike) plus how fast the
 * fingers move, and each video is slid along the longest one to find where the movement
 * matches best (normalized cross-correlation over the overlap, via FFT). Different cameras
 * see the same movement from different sides, so the curves differ in size but rise and
 * fall together. Changes slower than about a second are taken out first: every session
 * starts with the hands resting and then moving, and that alone would line up two
 * different sessions; the detail of the movement after it is what tells them apart.
 * A lineup is trusted when it matches MIN_SCORE or more overall and MIN_HALF_SCORE or more
 * in each half of the overlap (a chance match rests on one stretch), and no other lineup
 * fits almost as well (repetitive movement). On simulated cameras with realistic tracking
 * jitter this refused unrelated videos 599 times in 600 and lined up matching ones to
 * within 0.04 s (about a frame); with heavier jitter it refuses more often rather than guessing.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VideoSync = api;
})(typeof self !== "undefined" ? self : this, function () {
  const RATE = 30; // movement samples per second
  const MIN_SCORE = 0.6; // correlation needed to call two videos lined up
  const MIN_HALF_SCORE = 0.4; // ...and in each half of the overlap on its own
  const MIN_MARGIN = 0.08; // the best lineup must beat any other (over 1 s away) by this much
  const HIGHPASS_S = 1; // changes slower than this are taken out before matching
  const MIN_OVERLAP_S = 2; // ...and cover at least this long,
  const MIN_OVERLAP_SHARE = 0.5; // ...and at least this share of the shorter video
  const MAX_GAP_S = 0.25; // frames further apart than this aren't compared (hand lost)
  const SPEED_CAP = 8; // hand lengths a second; faster readings are tracking glitches

  // ---------- movement signal ----------
  const dist2 = (a, b, aspect) => Math.hypot((a[0] - b[0]) * aspect, a[1] - b[1]);

  // One number per 1/RATE s: how much the hands move then (0 while still or not seen).
  function signal(data, duration) {
    const n = Math.max(1, Math.ceil(duration * RATE) + 1);
    const out = new Float64Array(n);
    const origin = Number(data && data.time_origin_s) || 0;
    const size = data && data.image_size;
    const aspect = size && size[1] ? size[0] / size[1] : 16 / 9;
    for (const hand of (data && data.hands) || []) {
      const frames = hand.frames || [];
      const wrists = (hand.trajectories && hand.trajectories.end_effector) || [];
      // Each speed holds from one frame to the next: spread over the samples that stretch
      // covers, so any frame rate (24 fps, 60 fps, frames missed while tracking) gives the
      // same curve.
      const sum = new Float64Array(n), weight = new Float64Array(n);
      for (let k = 1; k < frames.length; k++) {
        const a = frames[k - 1], b = frames[k];
        const dt = b.t - a.t;
        if (!(dt > 0) || dt > MAX_GAP_S) continue;
        // Hand length: wrist to the middle finger's knuckle (joint 9), in the picture.
        const knuckle = b.joints[9].position;
        const handLength = Math.max(1e-3, Math.hypot(knuckle[0] * aspect, knuckle[1]));
        let speed = 0;
        if (wrists[k] && wrists[k - 1]) speed += dist2([wrists[k][1], wrists[k][2]], [wrists[k - 1][1], wrists[k - 1][2]], aspect) / dt / handLength;
        // Fingers: the fingertips' movement around the wrist (grasping, pointing).
        let fingers = 0;
        for (const j of [4, 8, 12, 16, 20]) fingers += dist2(b.joints[j].position, a.joints[j].position, aspect);
        speed += (fingers / 5) / dt / handLength;
        speed = Math.min(speed, SPEED_CAP);
        const s0 = (origin + a.t) * RATE, s1 = (origin + b.t) * RATE; // sample i covers i ± 0.5
        for (let i = Math.max(0, Math.round(s0)); i <= Math.min(n - 1, Math.round(s1)); i++) {
          const w = Math.min(s1, i + 0.5) - Math.max(s0, i - 0.5);
          if (w > 0) {
            sum[i] += speed * w;
            weight[i] += w;
          }
        }
      }
      for (let i = 0; i < n; i++) if (weight[i] > 0) out[i] += sum[i] / weight[i];
    }
    // Light smoothing (0.1 s), then compress big movements so one fast swing doesn't
    // outweigh everything else.
    const smooth = new Float64Array(n);
    for (let i = 0; i < n; i++) smooth[i] = Math.log1p((out[i] + (out[i - 1] || 0) + (out[i + 1] || 0)) / 3);
    return highpass(smooth, Math.round(HIGHPASS_S * RATE));
  }

  // x minus its running average over ±win samples: keeps the detail, drops slow changes.
  function highpass(x, win) {
    const n = x.length, sum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) sum[i + 1] = sum[i] + x[i];
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - win), b = Math.min(n, i + win + 1);
      out[i] = x[i] - (sum[b] - sum[a]) / (b - a);
    }
    return out;
  }

  function pearson(a, b) {
    const n = a.length;
    let sa = 0, sb = 0, qa = 0, qb = 0, sab = 0;
    for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; qa += a[i] * a[i]; qb += b[i] * b[i]; sab += a[i] * b[i]; }
    const v = (n * qa - sa * sa) * (n * qb - sb * sb);
    return v > 1e-12 ? (n * sab - sa * sb) / Math.sqrt(v) : 0;
  }

  // ---------- correlation ----------
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = ((inverse ? 2 : -2) * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ar = re[i + k], ai = im[i + k];
          const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ar + br; im[i + k] = ai + bi;
          re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
          const nr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = nr;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  // Pearson correlation of ref and other at every lag k (other[j] against ref[j + k]),
  // over just the samples they share. -> { lags: Int32Array, scores: Float64Array }
  function correlate(ref, other, minOverlap) {
    const nr = ref.length, no = other.length;
    let size = 1;
    while (size < nr + no) size <<= 1;
    const ar = new Float64Array(size), ai = new Float64Array(size);
    const br = new Float64Array(size), bi = new Float64Array(size);
    ar.set(ref);
    br.set(other);
    fft(ar, ai, false);
    fft(br, bi, false);
    for (let i = 0; i < size; i++) { // ref × conj(other)
      const r = ar[i] * br[i] + ai[i] * bi[i];
      const im = ai[i] * br[i] - ar[i] * bi[i];
      ar[i] = r; ai[i] = im;
    }
    fft(ar, ai, true); // ar[k mod size] = Σ_j ref[j + k] · other[j]
    const prefix = (x) => {
      const s = new Float64Array(x.length + 1), q = new Float64Array(x.length + 1);
      for (let i = 0; i < x.length; i++) { s[i + 1] = s[i] + x[i]; q[i + 1] = q[i] + x[i] * x[i]; }
      return { s, q };
    };
    const R = prefix(ref), O = prefix(other);
    const lags = [], scores = [];
    for (let k = -(no - minOverlap); k <= nr - minOverlap; k++) {
      const j0 = Math.max(0, -k), j1 = Math.min(no, nr - k); // shared: other[j0..j1), ref[j0+k..j1+k)
      const n = j1 - j0;
      if (n < minOverlap) continue;
      const sr = R.s[j1 + k] - R.s[j0 + k], qr = R.q[j1 + k] - R.q[j0 + k];
      const so = O.s[j1] - O.s[j0], qo = O.q[j1] - O.q[j0];
      const cross = ar[((k % size) + size) % size];
      const vr = n * qr - sr * sr, vo = n * qo - so * so;
      lags.push(k);
      scores.push(vr > 1e-9 && vo > 1e-9 ? (n * cross - sr * so) / Math.sqrt(vr * vo) : 0);
    }
    return { lags: Int32Array.from(lags), scores: Float64Array.from(scores) };
  }

  // Where other lines up with ref best, and how sure: -> { offset (s), score, half, runnerUp }.
  // half: the weaker of the two halves of the overlap, scored on its own.
  function bestLag(ref, other) {
    const shorter = Math.min(ref.length, other.length);
    const minOverlap = Math.min(shorter, Math.max(Math.round(MIN_OVERLAP_S * RATE), Math.round(shorter * MIN_OVERLAP_SHARE)));
    const { lags, scores } = correlate(ref, other, minOverlap);
    if (!scores.length) return { offset: 0, score: 0, half: 0, runnerUp: 0 };
    let best = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
    // The next best lineup more than a second away (a repeating movement matches again).
    let runnerUp = -1;
    for (let i = 0; i < scores.length; i++) if (Math.abs(lags[i] - lags[best]) > RATE && scores[i] > runnerUp) runnerUp = scores[i];
    // Between samples: the top of a parabola through the best score and its neighbours.
    let frac = 0;
    if (best > 0 && best < scores.length - 1) {
      const a = scores[best - 1], b = scores[best], c = scores[best + 1];
      const d = a - 2 * b + c;
      if (d < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d));
    }
    const k = lags[best], j0 = Math.max(0, -k), j1 = Math.min(other.length, ref.length - k), mid = (j0 + j1) >> 1;
    const half = Math.min(pearson(ref.subarray(j0 + k, mid + k), other.subarray(j0, mid)), pearson(ref.subarray(mid + k, j1 + k), other.subarray(mid, j1)));
    return { offset: (k + frac) / RATE, score: scores[best], half, runnerUp: Math.max(0, runnerUp) };
  }

  const variance = (x) => {
    let s = 0, q = 0;
    for (const v of x) { s += v; q += v * v; }
    return q / x.length - (s / x.length) ** 2;
  };

  // ---------- syncing ----------
  function sync(videos) {
    if (!Array.isArray(videos) || videos.length < 2) throw new Error("Syncing needs at least two videos.");
    const items = videos.map((v) => ({ ...v, duration: Number(v.duration) || 0 }));
    items.forEach((v) => (v.signal = signal(v.data, v.duration)));
    // The reference: the longest video (the one most likely to cover all the others).
    const reference = items.reduce((a, b) => (b.duration > a.duration ? b : a));
    const results = items.map((v) => {
      if (!(v.data && v.data.hands && v.data.hands.length)) return { name: v.name, offset: null, score: 0, reason: "no hands were seen in it" };
      if (variance(v.signal) < 1e-4) return { name: v.name, offset: null, score: 0, reason: "the hands in it hardly move" };
      if (v === reference) return { name: v.name, offset: 0, score: 1, reason: "" };
      const { offset, score, half, runnerUp } = bestLag(reference.signal, v.signal);
      const reason =
        score < MIN_SCORE ? `its hand movement doesn't match ${reference.name} (best match ${score.toFixed(2)}; ${MIN_SCORE} needed)`
          : half < MIN_HALF_SCORE ? `its hand movement only matches ${reference.name} for part of the time (${half.toFixed(2)} in one half; ${MIN_HALF_SCORE} needed)`
            : score - runnerUp < MIN_MARGIN ? `its movement repeats, so it matches ${reference.name} in more than one place (${score.toFixed(2)} and ${runnerUp.toFixed(2)})`
              : "";
      return { name: v.name, offset, score, reason };
    });
    // The reference itself has nothing to match if every other video failed for its own reasons.
    const failed = results.filter((r) => r.reason);
    const window = { start: 0, end: 0, length: 0 };
    if (!failed.length) {
      window.start = Math.max(...results.map((r) => r.offset));
      window.end = Math.min(...results.map((r, i) => r.offset + items[i].duration));
      window.length = Math.max(0, window.end - window.start);
      for (const r of results) r.trimStart = window.start - r.offset;
    }
    const ok = !failed.length && window.length > 0;
    const when = (s) => `${Math.abs(s).toFixed(2)} s ${s < 0 ? "before" : "after"}`;
    const message = ok
      ? `Synced: the hand movement lines up (weakest match ${Math.min(...results.map((r) => r.score)).toFixed(2)}). ` +
        results.filter((r) => r.name !== reference.name).map((r) => `${r.name} started ${when(r.offset)} ${reference.name}`).join("; ") +
        `. All ${results.length} videos cover ${window.length.toFixed(1)} s together.`
      : "The motion capture data doesn't line up, so these videos can't be synced: " +
        (failed.length ? failed.map((r) => `${r.name}: ${r.reason}`).join("; ") : "they don't overlap in time") + ".";
    return { ok, message, reference: reference.name, window, videos: results };
  }

  // ---------- one video's motion capture on the shared clock ----------
  function align(data, video, result) {
    const shift = (Number(data.time_origin_s) || 0) - video.trimStart; // this data's t=0, on the shared clock
    const end = result.window.length;
    const inWindow = (t) => t >= -1e-9 && t <= end + 1e-9;
    const hands = [];
    for (const hand of data.hands || []) {
      const keep = [], newIndex = new Map();
      hand.frames.forEach((f, i) => {
        const t = f.t + shift;
        if (!inWindow(t)) return;
        newIndex.set(i, keep.length);
        keep.push({ ...f, frame_index: keep.length, t: Math.round(t * 1e6) / 1e6 });
      });
      if (!keep.length) continue;
      const moveTraj = (traj) => (traj || []).filter((row) => inWindow(row[0] + shift)).map((row) => [Math.round((row[0] + shift) * 1e6) / 1e6, ...row.slice(1)]);
      const kept = [...newIndex.keys()];
      const first = kept[0], last = kept[kept.length - 1];
      const segments = (hand.task_segments || [])
        .filter((s) => s.end_frame >= first && s.start_frame <= last)
        .map((s) => ({ ...s, start_frame: newIndex.get(Math.max(s.start_frame, first)), end_frame: newIndex.get(Math.min(s.end_frame, last)) }))
        .filter((s) => s.start_frame !== undefined && s.end_frame !== undefined);
      hands.push({
        ...hand,
        frames: keep,
        trajectories: { ...hand.trajectories, end_effector: moveTraj(hand.trajectories && hand.trajectories.end_effector), palm_orientation: moveTraj(hand.trajectories && hand.trajectories.palm_orientation) },
        task_segments: segments,
      });
    }
    const others = result.videos.filter((v) => v.name !== video.name);
    return {
      ...data,
      hands,
      duration: Math.round(end * 1e6) / 1e6,
      time_origin_s: Math.round(video.trimStart * 1e6) / 1e6, // where the shared clock's 0 is in this video
      sync: {
        reference: result.reference,
        offset_s: Math.round(video.offset * 1e6) / 1e6,
        match: Math.round(video.score * 1000) / 1000,
        window_s: Math.round(end * 1e6) / 1e6,
        videos: result.videos.map((v) => ({ name: v.name, trim_start_s: Math.round(v.trimStart * 1e6) / 1e6, offset_s: Math.round(v.offset * 1e6) / 1e6, match: Math.round(v.score * 1000) / 1000 })),
      },
      notes: [
        ...(data.notes || []),
        `Synced with ${others.map((v) => v.name).join(", ")} from the hand movement: t is seconds on a clock all ${result.videos.length} videos share, starting when all of them are running (time_origin_s + t is the time in this video), trimmed to the ${end.toFixed(2)} s they cover together.`,
      ],
    };
  }

  return { sync, align, signal, correlate, bestLag, RATE, MIN_SCORE, MIN_HALF_SCORE };
});
