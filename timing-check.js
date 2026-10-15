/**
 * timing-check.js — how far apart several cameras' timings are: each films a beacon flashing
 * white and black once a second (on a phone's remote recording page, or on this computer's
 * screen), and the moments each camera's pictures turn bright are compared.
 *
 * Each camera's pictures are measured as they come: their brightness in a 16 x 9 grid, with the
 * time each picture reached this computer (ms since 1970). The part of the picture that swings
 * most is taken to be the beacon; each time it turns bright is placed between the two pictures
 * either side, by how bright they were. Offsets are against the first camera that saw it.
 *
 *   TimingCheck.GRID                    [16, 9]
 *   TimingCheck.cells(data, w, h, step) a picture's RGBA (step 4) or grey (step 1) bytes -> the grid's
 *   TimingCheck.edges(samples)          [{ t, cells }] -> the times it turned bright
 *   TimingCheck.compare(cameras, beacon) [{ name, samples }] -> [{ name, flashes, offsetMs, spreadMs,
 *                                       afterBeaconMs }] (offsetMs null: it didn't see the beacon);
 *                                       beacon: the beacon's own flash times, when it's on this screen
 *   TimingCheck.beacon(el)              makes el flash (a full-screen element) until the returned stop()
 *   TimingCheck.PERIOD_MS               1000 (bright for the first half of each second)
 */

(function (global) {
  const GRID = [16, 9];
  const PERIOD_MS = 1000;

  // A picture's brightness in the grid (mean of each cell's pixels).
  function cells(data, w, h, step = 4) {
    const [gw, gh] = GRID;
    const sum = new Float64Array(gw * gh), count = new Uint32Array(gw * gh);
    for (let y = 0; y < h; y++) {
      const cy = Math.min(gh - 1, Math.floor((y * gh) / h));
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * step;
        const v = step >= 3 ? (data[i] + data[i + 1] + data[i + 2]) / 3 : data[i];
        const c = cy * gw + Math.min(gw - 1, Math.floor((x * gw) / w));
        sum[c] += v;
        count[c]++;
      }
    }
    return Array.from(sum, (s, i) => (count[i] ? s / count[i] : 0));
  }

  // The times the beacon's part of the picture turned bright: that part is the cell that
  // swings most; a turn is a crossing of halfway between its dark and bright, placed between
  // the two pictures either side.
  function edges(samples) {
    if (!samples || samples.length < 8) return { times: [], cell: -1, swing: 0 };
    const n = samples[0].cells.length;
    let best = -1, swing = 0, lo = 0, hi = 0;
    for (let c = 0; c < n; c++) {
      const v = samples.map((s) => s.cells[c]).sort((a, b) => a - b);
      const a = v[Math.floor(v.length * 0.05)], b = v[Math.floor(v.length * 0.95)];
      if (b - a > swing) {
        swing = b - a;
        best = c;
        lo = a;
        hi = b;
      }
    }
    // Too small a swing is no beacon (a picture's own noise).
    if (best < 0 || swing < 20) return { times: [], cell: best, swing };
    const mid = (lo + hi) / 2;
    const times = [];
    let darkSince = null;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      const va = a.cells[best], vb = b.cells[best];
      if (va < mid && darkSince === null) darkSince = a.t;
      if (va < mid && vb >= mid && darkSince !== null && b.t - darkSince >= PERIOD_MS / 4) {
        times.push(a.t + ((mid - va) / Math.max(1e-6, vb - va)) * (b.t - a.t));
        darkSince = null;
      }
      if (vb >= mid) darkSince = null;
    }
    return { times, cell: best, swing };
  }

  const median = (v) => {
    const s = v.slice().sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
  };
  const quantile = (v, q) => {
    const s = v.slice().sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] : null;
  };

  // Each camera against the first that saw the beacon: the middle of their differences (each
  // flash matched with the nearest within half a period), and how much that varied (half the
  // spread of the middle 80%). beacon: its own flash times (on this computer's screen), for how
  // long after each flash each camera saw it.
  function compare(cameras, beacon = null) {
    const found = cameras.map((c) => ({ name: c.name, ...edges(c.samples) }));
    const ref = found.find((f) => f.times.length >= 3);
    const near = (t, list) => {
      let best = null;
      for (const x of list) if (best === null || Math.abs(x - t) < Math.abs(best - t)) best = x;
      return best !== null && Math.abs(best - t) < PERIOD_MS / 2 ? best : null;
    };
    return found.map((f) => {
      const out = { name: f.name, flashes: f.times.length, offsetMs: null, spreadMs: null, afterBeaconMs: null };
      if (ref && f.times.length >= 3) {
        const d = f.times.map((t) => (near(t, ref.times) === null ? null : t - near(t, ref.times))).filter((x) => x !== null);
        if (d.length >= 3) {
          out.offsetMs = Math.round(median(d));
          out.spreadMs = Math.round((quantile(d, 0.9) - quantile(d, 0.1)) / 2);
        }
      }
      if (beacon && beacon.length && f.times.length >= 3) {
        const d = f.times.map((t) => (near(t, beacon) === null ? null : t - near(t, beacon))).filter((x) => x !== null);
        if (d.length >= 3) out.afterBeaconMs = Math.round(median(d));
      }
      return out;
    });
  }

  // The beacon: el white for the first half of each second, black for the rest (by this
  // device's clock), until stop(); flashes() -> when it turned white (ms since 1970).
  function beacon(el) {
    const turned = [];
    let on = null, frame = 0;
    const tick = () => {
      const now = Date.now();
      const bright = now % PERIOD_MS < PERIOD_MS / 2;
      if (bright !== on) {
        on = bright;
        el.style.background = bright ? "#fff" : "#000";
        if (bright) turned.push(now - (now % PERIOD_MS));
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return {
      stop: () => cancelAnimationFrame(frame),
      flashes: () => turned.slice(),
    };
  }

  const api = { GRID, PERIOD_MS, cells, edges, compare, beacon };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.TimingCheck = api;
})(typeof window !== "undefined" ? window : globalThis);
