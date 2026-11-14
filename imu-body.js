/**
 * imu-body.js — a body's posture from a motion sensor (an IMU: accelerometer and gyroscope) worn on it, such
 * as an OAK camera's own in the Chest role, or a separate sensor: which way is up, how far it leans forward
 * or to a side, how far it has turned, and whether it's still, moving or walking (steps a minute).
 *
 *   const body = ImuBody.create({ imuToCamera });  // imuToCamera: 3 x 3 rotation from the sensor's axes to its
 *                                                  // camera's (x right, y down, z out of the lens), when the
 *                                                  // sensor sits in a camera (an OAK camera's calibration says)
 *   body.add(tMs, ax, ay, az, gx, gy, gz);         // each reading: m/s² and rad/s on the sensor's own axes
 *   body.setUpright();                             // how it is now counts as standing straight, facing ahead
 *   body.setForward();                             // (a sensor not in a camera) leaning forward now: learns where
 *                                                  // forward is, so forward and side can be told, not only lean
 *   body.state() -> { ready, forward, side, lean, turn, activity: "still" | "moving" | "walking", stepsPerMin,
 *                     bending, upright: whether setUpright was used (else the first still second counts), q,
 *                     level, axes: "camera" | "sensor" }
 *   body.row(t) -> [t, forward, side, turn, activity (0 still, 1 moving, 2 walking), stepsPerMin, qw, qx, qy, qz, lw, lx, ly, lz]
 *   ImuBody.text(state) -> "leaning 12° forward, 3° right · walking, 104 steps a minute"
 *   ImuBody.level(level, [x, y, z]) -> the point turned upright (state().level)
 *
 * Angles are in degrees. forward: + leaning forward, - back; side: + to the right, - to the left (as the wearer
 * sees it); lean: the whole lean, whichever way; turn: + to the left (seen from above), since the start or the
 * last setUpright. Forward and side need to know where "forward" is: with imuToCamera it's where the camera
 * looks; without it they're null and only lean is told. Turn drifts by some degrees a minute (a sensor without
 * a compass can't tell north).
 *
 * How: Mahony's filter (Mahony, Hamel, Pflimlin 2008) puts the gyroscope's turns together with the
 * accelerometer's sense of up into the sensor's orientation (q: sensor to world, world z up). Steps are the
 * peaks of the acceleration's size, filtered, at least STEP_GAP apart.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ImuBody = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const KP = 1.0, KI = 0.02; // (how strongly up follows the accelerometer, and how its slow gyroscope error is learned)
  const G = 9.80665;
  const STILL_ACC = 0.25, STILL_GYRO = 0.15; // (m/s² spread, rad/s: under both for a second is still)
  const STEP_RISE = 1.2, STEP_GAP = 280, STEP_WINDOW = 5000; // (m/s² over the average; ms)
  const BEND = 35; // (degrees forward: bending)
  const LEARN = 8; // (degrees: leaning at least this far to learn where forward is)
  const deg = (r) => (r * 180) / Math.PI;

  function create(opts = {}) {
    const M = validRotation(opts.imuToCamera);
    let q = null, ix = 0, iy = 0, iz = 0, last = null;
    let ref = null, refByHand = false; // { forward, side, yaw, up: [x, y, z] }
    const win = []; // [t, |a|, |g|] over the last second and more
    let avg = G, lastStep = -1e9, rising = false;
    const steps = [];
    let n = 0;

    function add(t, ax, ay, az, gx, gy, gz) {
      if (![t, ax, ay, az, gx, gy, gz].every(Number.isFinite)) return;
      const an = Math.hypot(ax, ay, az);
      if (!q) {
        if (an < 1) return;
        q = fromUp(ax / an, ay / an, az / an);
        last = t;
      }
      const dt = Math.min(0.1, Math.max(0, (t - last) / 1000));
      last = t;
      if (an > 0.5 * G && an < 1.5 * G) {
        // (only when it isn't being thrown about: then the accelerometer says where up is)
        const [vx, vy, vz] = upInSensor(q);
        const ex = (ay * vz - az * vy) / an, ey = (az * vx - ax * vz) / an, ez = (ax * vy - ay * vx) / an;
        ix += KI * ex * dt; iy += KI * ey * dt; iz += KI * ez * dt;
        gx += KP * ex + ix; gy += KP * ey + iy; gz += KP * ez + iz;
      }
      const [w, x, y, z] = q;
      const h = 0.5 * dt;
      const nq = [w + h * (-x * gx - y * gy - z * gz), x + h * (w * gx + y * gz - z * gy), y + h * (w * gy - x * gz + z * gx), z + h * (w * gz + x * gy - y * gx)];
      const l = Math.hypot(...nq) || 1;
      q = nq.map((c) => c / l);
      n++;
      // Still, moving, walking.
      win.push([t, an, Math.hypot(gx, gy, gz)]);
      while (win.length && t - win[0][0] > 1000) win.shift();
      avg += (an - avg) * Math.min(1, dt / 2);
      if (!rising && an > avg + STEP_RISE && t - lastStep > STEP_GAP) {
        rising = true;
        lastStep = t;
        steps.push(t);
      } else if (rising && an < avg) rising = false;
      while (steps.length && t - steps[0] > STEP_WINDOW) steps.shift();
      if (!ref && n > 50 && still()) ref = angles(); // (the first still moment counts as upright until setUpright)
    }

    function still() {
      if (win.length < 10) return false;
      const a = win.map((r) => r[1]);
      const mean = a.reduce((s, v) => s + v, 0) / a.length;
      const sd = Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length);
      return sd < STILL_ACC && Math.max(...win.map((r) => r[2])) < STILL_GYRO;
    }

    // Up, and the way it faces, from q: forward and side against the camera when it's known.
    function angles() {
      const up = upInSensor(q);
      let forward = null, side = null, fwd;
      if (M) {
        const u = mul(M, up); // (up in the camera's axes: (0, -1, 0) for a camera upright and level)
        forward = deg(Math.atan2(-u[2], -u[1]));
        side = deg(Math.atan2(-u[0], -u[1]));
        fwd = mulT(M, [0, 0, 1]); // (the camera's line of sight, in the sensor's axes)
      } else {
        fwd = Math.abs(up[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      }
      const f = rotate(q, fwd);
      return { forward, side, yaw: deg(Math.atan2(f[1], f[0])), up };
    }

    function setUpright() {
      if (!q) return false;
      ref = angles();
      refByHand = true;
      return true;
    }

    // A sensor not in a camera: where forward is, learned from leaning forward now (after setUpright, or
    // the first still second): the way up moved. False when it hasn't leaned enough (LEARN degrees).
    let learned = null; // { f, r }: forward and right, in the sensor's axes, square to upright's up
    function setForward() {
      if (!q || !ref || M) return false;
      const u = upInSensor(q), u0 = ref.up;
      const d = [0, 1, 2].map((i) => u0[i] - u[i]);
      const along = dot(d, u0);
      const f = d.map((v, i) => v - along * u0[i]);
      const l = Math.hypot(...f);
      if (l < Math.sin((LEARN * Math.PI) / 180)) return false;
      const fu = f.map((v) => v / l);
      learned = { f: fu, r: cross(fu, u0) };
      return true;
    }

    function state() {
      if (!q || n < 20) return { ready: false };
      const a = angles();
      const r = ref || a;
      let forward = a.forward === null ? null : wrap(a.forward - r.forward);
      let side = a.side === null ? null : wrap(a.side - r.side);
      if (learned) {
        const upPart = dot(a.up, r.up);
        forward = deg(Math.atan2(-dot(a.up, learned.f), upPart));
        side = deg(Math.atan2(-dot(a.up, learned.r), upPart));
      }
      const lean = deg(Math.acos(Math.max(-1, Math.min(1, dot(a.up, r.up)))));
      const turn = wrap(a.yaw - r.yaw);
      const spm = steps.length >= 3 ? Math.round(((steps.length - 1) * 60000) / (steps[steps.length - 1] - steps[0])) : 0;
      const walking = spm >= 50 && spm <= 200 && last - steps[steps.length - 1] < 1500;
      const activity = walking ? "walking" : still() ? "still" : "moving";
      // The rotation that turns its camera's points upright (its lean taken out, its facing kept).
      const level = M ? levelOf(mul(M, a.up), mul(M, r.up)) : null;
      return { ready: true, forward: round1(forward), side: round1(side), lean: round1(lean), turn: round1(turn), activity, stepsPerMin: walking ? spm : 0,
               bending: forward !== null ? forward > BEND : lean > BEND, upright: refByHand, q: q.map((c) => +c.toFixed(5)), level, axes: M ? "camera" : learned ? "learned" : "sensor" };
    }

    function row(t) {
      const s = state();
      if (!s.ready) return null;
      return [t, s.forward, s.side, s.turn, s.activity === "walking" ? 2 : s.activity === "moving" ? 1 : 0, s.stepsPerMin, ...s.q, ...(s.level || [null, null, null, null])];
    }

    return { add, setUpright, setForward, state, row, get camera() { return !!M; }, get knowsForward() { return !!M || !!learned; } };
  }

  // ---- small 3D helpers ----
  function validRotation(m) {
    if (!Array.isArray(m) || m.length !== 3 || !m.every((r) => Array.isArray(r) && r.length === 3 && r.every(Number.isFinite))) return null;
    const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    return Math.abs(det - 1) < 0.05 ? m : null;
  }
  const mul = (m, v) => [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
  const mulT = (m, v) => [0, 1, 2].map((i) => m[0][i] * v[0] + m[1][i] * v[1] + m[2][i] * v[2]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
  const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

  // World up (z) seen in the sensor's axes, for q (sensor to world).
  function upInSensor([w, x, y, z]) {
    return [2 * (x * z - w * y), 2 * (w * x + y * z), w * w - x * x - y * y + z * z];
  }
  // A vector on the sensor's axes, in the world's.
  function rotate([w, x, y, z], [vx, vy, vz]) {
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
  }
  // The orientation whose up (in the sensor's axes) is (ux, uy, uz): the shortest turn from world up.
  function fromUp(ux, uy, uz) {
    // q sensor->world takes (ux, uy, uz) to (0, 0, 1)
    const c = uz, ax = uy, ay = -ux; // axis = u x z
    const s = Math.sqrt(Math.max(0, (1 + c) * 2));
    if (s < 1e-6) return [0, 1, 0, 0];
    const q = [s / 2, ax / s, ay / s, 0];
    const l = Math.hypot(...q);
    return q.map((v) => v / l);
  }
  // The shortest rotation (quaternion) taking unit vector a to b.
  function levelOf(a, b) {
    const c = dot(a, b);
    const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0];
    const q = [1 + c, x, y, z];
    const l = Math.hypot(...q);
    if (l < 1e-6) return [0, 1, 0, 0];
    return q.map((v) => +(v / l).toFixed(5));
  }
  function level(qr, p) {
    if (!qr || !Array.isArray(p) || p.length < 3) return p;
    return rotate(qr, p).map((v) => +v.toFixed(4));
  }

  function text(s) {
    if (!s || !s.ready) return "";
    const parts = [];
    if (s.forward !== null && s.side !== null) {
      const f = Math.round(s.forward), d = Math.round(s.side);
      const fw = Math.abs(f) < 3 ? "" : `${Math.abs(f)}° ${f > 0 ? "forward" : "back"}`;
      const sd = Math.abs(d) < 3 ? "" : `${Math.abs(d)}° ${d > 0 ? "right" : "left"}`;
      parts.push(fw || sd ? `leaning ${[fw, sd].filter(Boolean).join(", ")}` : "upright");
    } else parts.push(Math.round(s.lean) < 3 ? "upright" : `leaning ${Math.round(s.lean)}°`);
    if (Math.abs(s.turn) >= 15) parts[0] += `, turned ${Math.abs(Math.round(s.turn))}° ${s.turn > 0 ? "left" : "right"}`;
    if (s.bending) parts[0] = "bending, " + parts[0];
    parts.push(s.activity === "walking" ? `walking, ${s.stepsPerMin} steps a minute` : s.activity);
    return parts.join(" · ");
  }

  return { create, text, level, G };
});
