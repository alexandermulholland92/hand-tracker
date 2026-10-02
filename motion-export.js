/**
 * motion-export.js
 * Converts motion capture data into other formats.
 *
 * Hand recordings (what RobotMotion.stop() returns, or an imported JSON / CSV):
 *   JSON  full recording (unchanged)
 *   CSV   one row per hand per frame            -> spreadsheets, pandas, MATLAB
 *   BVH   skeleton animation, one file per hand -> Blender, Maya, MotionBuilder
 *   GLB   animated 3D hands (glTF 2.0 binary)   -> Blender, three.js, Unity, Unreal, 3D Viewer
 *   C3D   3D marker trajectories                -> Vicon, Qualisys, Visual3D, Mokka
 *   TRC   3D marker trajectories (text)         -> OpenSim
 *   NPZ   NumPy arrays                          -> Python, ML and robotics pipelines
 *   MCAP  ROS 2 messages (mcap.js)              -> ros2 bag play, RViz, Foxglove
 *
 * Marker recordings (imported C3D files and OptiTrack .tak takes, see motion-import.js):
 *   C3D, TRC, CSV, GLB, NPZ, JSON, MCAP — the same writers, fed with labelled 3D points.
 *
 *   MotionExport.FORMATS / MotionExport.build(data, ["bvh", ...], baseName)
 *   MotionExport.MARKER_FORMATS / MotionExport.buildMarkers(markerData, ["trc", ...], baseName)
 *     -> [{ format, suffix, ext, data: string | Uint8Array }]
 *
 * Coordinates: hand landmarks are normalized image units (x right, y down, z
 * away from the camera). JSON, CSV and NPZ keep those raw units. The 3D formats
 * (BVH, GLB, C3D, TRC) convert to right-handed axes and to approximate
 * real-world size by assuming an average adult hand (wrist to middle fingertip
 * about 19 cm). A single webcam can't measure distance, so that scale is an
 * estimate. 3D formats show the hands as the camera saw them (not mirrored),
 * so a left hand stays a left hand. Marker data is kept in millimetres; C3D
 * input is taken as Z-up (the usual lab convention) and TRC / GLB are written Y-up.
 */

(function (global) {
  const JOINTS = [
    "wrist",
    "thumb_cmc", "thumb_mcp", "thumb_ip", "thumb_tip",
    "index_mcp", "index_pip", "index_dip", "index_tip",
    "middle_mcp", "middle_pip", "middle_dip", "middle_tip",
    "ring_mcp", "ring_pip", "ring_dip", "ring_tip",
    "pinky_mcp", "pinky_pip", "pinky_dip", "pinky_tip",
  ];
  const PARENT = [-1, 0, 1, 2, 3, 0, 5, 6, 7, 0, 9, 10, 11, 0, 13, 14, 15, 0, 17, 18, 19];
  const TIPS = new Set([4, 8, 12, 16, 20]);
  const MIDDLE_CHAIN = [0, 9, 10, 11, 12];
  // Drawn connections (same as the in-app 3D view).
  const CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
  ];
  const PHASES = ["idle", "reach", "grasp", "manipulate", "release"];
  const HAND_LENGTH_MM = 190; // average adult wrist-to-middle-fingertip length
  const MAX_GAP_S = 0.25;     // matches robot-motion.js: longer gaps mean the hand wasn't tracked
  const HAND_COLORS = { Left: [0.30, 0.67, 0.97], Right: [1.0, 0.57, 0.17] };

  const FORMATS = [
    { id: "json", label: "JSON", detail: "Everything recorded · full detail" },
    { id: "csv", label: "CSV", detail: "Spreadsheets · Excel, pandas, MATLAB" },
    { id: "bvh", label: "BVH", detail: "Skeleton animation · Blender, Maya, MotionBuilder" },
    { id: "glb", label: "GLB (glTF)", detail: "Animated 3D hands · Blender, Unity, Unreal, 3D Viewer" },
    { id: "c3d", label: "C3D", detail: "Mocap standard · Vicon, Qualisys, Visual3D, Mokka" },
    { id: "trc", label: "TRC", detail: "Marker trajectories · OpenSim" },
    { id: "npz", label: "NPZ", detail: "NumPy arrays · Python, ML, robotics" },
    { id: "mcap", label: "MCAP (ROS 2)", detail: "ROS 2 bag · ros2 bag play, RViz, Foxglove" },
  ];

  // ---------- vector / quaternion helpers (quaternions are [x, y, z, w]) ----------
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const length = (a) => Math.hypot(a[0], a[1], a[2]);
  const norm = (a) => mul(a, 1 / (length(a) || 1e-9));
  const lerp = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

  function qMul(a, b) {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
  }
  const qInv = (q) => [-q[0], -q[1], -q[2], q[3]];
  function qNorm(q) {
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  }
  function qRotate(q, v) {
    const p = qMul(qMul(q, [v[0], v[1], v[2], 0]), qInv(q));
    return [p[0], p[1], p[2]];
  }
  // Shortest rotation taking unit vector u onto unit vector v.
  function qFromTo(u, v) {
    const d = dot(u, v);
    if (d > 0.999999) return [0, 0, 0, 1];
    if (d < -0.999999) {
      let axis = cross([1, 0, 0], u);
      if (length(axis) < 1e-6) axis = cross([0, 1, 0], u);
      axis = norm(axis);
      return [axis[0], axis[1], axis[2], 0];
    }
    const c = cross(u, v);
    const s = Math.sqrt((1 + d) * 2);
    return qNorm([c[0] / s, c[1] / s, c[2] / s, s / 2]);
  }
  // Rotation whose columns are the orthonormal axes x, y, z.
  function qFromBasis(x, y, z) {
    const [m00, m10, m20] = x, [m01, m11, m21] = y, [m02, m12, m22] = z;
    const tr = m00 + m11 + m22;
    let q;
    if (tr > 0) {
      const s = 0.5 / Math.sqrt(tr + 1);
      q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
    } else if (m00 > m11 && m00 > m22) {
      const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
      q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
    } else if (m11 > m22) {
      const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
      q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
    } else {
      const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
      q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
    }
    return qNorm(q);
  }
  function qToMatrix([x, y, z, w]) {
    return [
      [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ];
  }
  // Degrees for BVH "Zrotation Xrotation Yrotation", i.e. R = Rz * Rx * Ry.
  function eulerZXY(q) {
    const m = qToMatrix(q);
    const sx = Math.max(-1, Math.min(1, m[2][1]));
    const x = Math.asin(sx);
    let y, z;
    if (Math.abs(sx) < 0.999999) {
      y = Math.atan2(-m[2][0], m[2][2]);
      z = Math.atan2(-m[0][1], m[1][1]);
    } else {
      y = 0;
      z = Math.atan2(m[1][0], m[0][0]);
    }
    return [z, x, y].map((r) => (r * 180) / Math.PI);
  }

  // Image axes (x right, y down, z away from camera) -> right-handed Y-up
  // (x right, y up, z toward the camera). This is a rotation, not a mirror.
  const toYUp = (p) => [p[0], -p[1], -p[2]];
  // ... -> right-handed Z-up (x right, y away from the camera, z up), common in mocap labs.
  const toZUp = (p) => [p[0], p[2], -p[1]];

  // ---------- normalize the recording ----------
  function prepare(data) {
    const hands = Array.isArray(data.hands)
      ? data.hands
      : [{ handedness: data.handedness, frame_rate: data.frame_rate, frames: data.frames, trajectories: data.trajectories, task_segments: data.task_segments }];
    const [iw, ih] = Array.isArray(data.image_size) && data.image_size[0] > 0 ? data.image_size : [640, 480];
    const aspect = ih / iw; // landmark y is normalized by height, x by width

    const tracks = hands
      .filter((h) => Array.isArray(h.frames) && h.frames.length)
      .map((h, index) => {
        const ee = (h.trajectories && h.trajectories.end_effector) || [];
        const pq = (h.trajectories && h.trajectories.palm_orientation) || [];
        const phase = new Array(h.frames.length).fill("idle");
        for (const seg of h.task_segments || []) {
          for (let i = Math.max(0, seg.start_frame); i <= seg.end_frame && i < phase.length; i++) phase[i] = seg.phase;
        }
        const name = h.handedness || `Hand${index}`;
        return {
          name,
          key: name.toLowerCase().replace(/[^a-z0-9]/g, "") || `hand${index}`,
          prefix: name === "Left" ? "L" : name === "Right" ? "R" : `H${index}`,
          color: HAND_COLORS[name] || [0.7, 0.7, 0.7],
          samples: h.frames.map((f, i) => {
            const raw = f.joints.map((j) => j.position);
            const wristRaw = ee[i] ? ee[i].slice(1, 4) : [0.5, 0.5, 0];
            // Isotropic image-axis units (y rescaled so x and y share a unit), centered on the frame.
            const wrist = [wristRaw[0] - 0.5, (wristRaw[1] - 0.5) * aspect, wristRaw[2]];
            const world = raw.map((p) => add(wrist, [p[0], p[1] * aspect, p[2]]));
            return {
              t: f.t, raw, wristRaw, world, quat: pq[i] ? pq[i].slice(1, 5) : [0, 0, 0, 1], phase: phase[i],
              // Real shape in metres and a depth camera's distance, when the recording has them.
              real: Array.isArray(f.world_joints) && f.world_joints.length === 21 ? f.world_joints : null,
              distance: Array.isArray(f.distance_mm) ? f.distance_mm : null,
            };
          }),
        };
      });

    // Approximate real-world scale from the middle finger chain (its length
    // doesn't change when the finger curls). The 90th percentile favors frames
    // where the hand faces the camera, i.e. the least foreshortened.
    const chains = [];
    for (const tr of tracks) {
      for (const s of tr.samples) {
        let l = 0;
        for (let k = 1; k < MIDDLE_CHAIN.length; k++) l += length(sub(s.world[MIDDLE_CHAIN[k]], s.world[MIDDLE_CHAIN[k - 1]]));
        chains.push(l);
      }
    }
    chains.sort((a, b) => a - b);
    const chain = chains.length ? chains[Math.floor(chains.length * 0.9)] : 0.25;
    const mmPerUnit = HAND_LENGTH_MM / Math.max(chain, 1e-4);

    const fps = Math.min(120, Math.max(1, Math.round(Number(data.frame_rate) || Number(hands[0] && hands[0].frame_rate) || 30)));
    const end = tracks.reduce((m, tr) => Math.max(m, tr.samples[tr.samples.length - 1].t), 0);
    const times = Array.from({ length: Math.floor(end * fps + 1e-6) + 1 }, (_, k) => k / fps);
    return { tracks, mmPerUnit, fps, times, imageSize: [iw, ih] };
  }

  // World positions (isotropic image units) of one hand at time t: linearly
  // interpolated between recorded frames. Returns null when the hand wasn't
  // tracked at t, unless hold=true, which uses the nearest recorded pose.
  function poseAt(track, t, hold) {
    const S = track.samples;
    if (t <= S[0].t) return hold || S[0].t - t < 1e-6 ? S[0].world : null;
    const last = S[S.length - 1];
    if (t >= last.t) return hold || t - last.t < 1e-6 ? last.world : null;
    let lo = 0, hi = S.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (S[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = S[lo], b = S[hi];
    if (b.t - a.t > MAX_GAP_S) return hold ? (t - a.t < b.t - t ? a.world : b.world) : null;
    const u = (t - a.t) / (b.t - a.t);
    return a.world.map((p, j) => lerp(p, b.world[j], u));
  }

  // ---------- CSV ----------
  function toCSV(prep) {
    // wrist_world_* is the wrist's camera-frame position; the joint columns (wrist_x … pinky_tip_z) are wrist-relative.
    const cols = ["hand", "frame", "t", "phase", "wrist_world_x", "wrist_world_y", "wrist_world_z", "palm_qx", "palm_qy", "palm_qz", "palm_qw"];
    for (const j of JOINTS) cols.push(`${j}_x`, `${j}_y`, `${j}_z`);
    cols.push("image_width", "image_height"); // lets an imported CSV rebuild correctly proportioned 3D
    // Real shape (metres, origin at the hand's centre) and a depth camera's distance (mm),
    // at the end, when recorded; empty cells for frames without them.
    const all = prep.tracks.flatMap((tr) => tr.samples);
    const hasReal = all.some((s) => s.real), hasDistance = all.some((s) => s.distance);
    if (hasReal) for (const j of JOINTS) cols.push(`${j}_real_x`, `${j}_real_y`, `${j}_real_z`);
    if (hasDistance) cols.push("distance_x_mm", "distance_y_mm", "distance_z_mm");
    const [iw, ih] = prep.imageSize;
    const rows = [];
    for (const tr of prep.tracks) {
      tr.samples.forEach((s, i) => {
        const cells = [tr.name, i, s.t.toFixed(4), s.phase, ...s.wristRaw, ...s.quat, ...s.raw.flat(), iw, ih];
        if (hasReal) cells.push(...(s.real ? s.real.flat() : new Array(63).fill("")));
        if (hasDistance) cells.push(...(s.distance ? s.distance : ["", "", ""]));
        rows.push({ t: s.t, cells });
      });
    }
    rows.sort((a, b) => a.t - b.t);
    const fmt = (v) => (typeof v === "number" && !Number.isInteger(v) ? v.toFixed(6) : String(v));
    return [cols.join(","), ...rows.map((r) => r.cells.map(fmt).join(","))].join("\n") + "\n";
  }

  // ---------- BVH ----------
  // Palm frame (same construction as hand-tracker.js) for the wrist's rotation.
  function palmQuat(P) {
    const x = norm(sub(P[17], P[5]));
    const yGuess = norm(sub(P[9], P[0]));
    const z = norm(cross(x, yGuess));
    const y = norm(cross(z, x));
    return qFromBasis(x, y, z);
  }

  function toBVH(prep, track) {
    const cm = prep.mmPerUnit / 10;
    const poses = prep.times.map((t) => poseAt(track, t, true).map((p) => mul(toYUp(p), cm)));
    // Rest pose = the first frame, so offsets are this person's actual bone lengths.
    const rest = poses[0];
    const restPalm = palmQuat(rest);
    const f = (v) => v.toFixed(4);
    const name = (j) => `${track.prefix}_${JOINTS[j]}`;

    const lines = ["HIERARCHY", `ROOT ${name(0)}`, "{", "\tOFFSET 0.0000 0.0000 0.0000", "\tCHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation"];
    const order = [0]; // joints with channels, in file order
    for (const base of [1, 5, 9, 13, 17]) {
      let depth = 1;
      for (let j = base; !TIPS.has(j); j++, depth++) {
        const ind = "\t".repeat(depth);
        const off = sub(rest[j], rest[PARENT[j]]);
        lines.push(`${ind}JOINT ${name(j)}`, `${ind}{`, `${ind}\tOFFSET ${off.map(f).join(" ")}`, `${ind}\tCHANNELS 3 Zrotation Xrotation Yrotation`);
        order.push(j);
      }
      const tip = base + 3;
      const tipOff = sub(rest[tip], rest[tip - 1]);
      const ind = "\t".repeat(depth);
      lines.push(`${ind}End Site`, `${ind}{`, `${ind}\tOFFSET ${tipOff.map(f).join(" ")}`, `${ind}}`);
      for (let d = depth - 1; d >= 1; d--) lines.push(`${"\t".repeat(d)}}`);
    }
    lines.push("}", "MOTION", `Frames: ${poses.length}`, `Frame Time: ${(1 / prep.fps).toFixed(6)}`);

    for (const P of poses) {
      // Global rotations: the wrist follows the palm frame; each finger joint
      // takes the smallest extra rotation that points its bone at the recorded child.
      const G = new Array(21);
      G[0] = qMul(palmQuat(P), qInv(restPalm));
      const values = [...P[0].map(f), ...eulerZXY(G[0]).map(f)];
      for (let j = 1; j < 21; j++) {
        if (TIPS.has(j)) continue;
        const parent = G[PARENT[j]];
        const restDir = norm(sub(rest[j + 1], rest[j]));
        const liveDir = norm(sub(P[j + 1], P[j]));
        G[j] = qNorm(qMul(qFromTo(norm(qRotate(parent, restDir)), liveDir), parent));
        values.push(...eulerZXY(qMul(qInv(parent), G[j])).map(f));
      }
      lines.push(values.join(" "));
    }
    return lines.join("\n") + "\n";
  }

  // ---------- TRC (OpenSim) ----------
  // Generic writer. pointAt(k, m) -> [x, y, z] in mm (Y-up), or null when the marker is missing.
  function writeTRC({ fileName, rate, labels, times, pointAt }) {
    const n = times.length;
    const r = rate.toFixed(2);
    const out = [
      `PathFileType\t4\t(X/Y/Z)\t${fileName}`,
      "DataRate\tCameraRate\tNumFrames\tNumMarkers\tUnits\tOrigDataRate\tOrigDataStartFrame\tOrigNumFrames",
      `${r}\t${r}\t${n}\t${labels.length}\tmm\t${r}\t1\t${n}`,
      `Frame#\tTime\t${labels.join("\t\t\t")}`,
      `\t\t${labels.map((_, i) => `X${i + 1}\tY${i + 1}\tZ${i + 1}`).join("\t")}`,
      "",
    ];
    times.forEach((t, k) => {
      const cells = [k + 1, t.toFixed(5)];
      for (let m = 0; m < labels.length; m++) {
        const p = pointAt(k, m);
        if (p) cells.push(p[0].toFixed(3), p[1].toFixed(3), p[2].toFixed(3));
        else cells.push("", "", ""); // OpenSim reads blanks as missing
      }
      out.push(cells.join("\t"));
    });
    return out.join("\n") + "\n";
  }

  // Each hand's pose on the resampled timeline (null where the hand wasn't tracked).
  function resampledPoses(prep) {
    return prep.times.map((t) => prep.tracks.map((tr) => poseAt(tr, t, false)));
  }

  function toTRC(prep, fileName) {
    const labels = [];
    for (const tr of prep.tracks) for (const j of JOINTS) labels.push(`${tr.prefix}_${j}`);
    const poses = resampledPoses(prep);
    return writeTRC({
      fileName,
      rate: prep.fps,
      labels,
      times: prep.times,
      pointAt: (k, m) => {
        const pose = poses[k][Math.floor(m / 21)];
        return pose ? mul(toYUp(pose[m % 21]), prep.mmPerUnit) : null;
      },
    });
  }

  // ---------- C3D ----------
  // Generic writer (Intel/PC float format). pointAt(k, m) -> [x, y, z] in mm (Z-up), or null when missing.
  function writeC3D({ rate, labels, descriptions, frameCount, pointAt }) {
    const nFrames = frameCount;
    const nPoints = labels.length;

    // Parameter section: groups and parameters as binary records.
    const records = [];
    const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0) & 0x7f);
    function group(id, name, desc) {
      const nm = ascii(name), ds = ascii(desc);
      records.push([nm.length, (-id) & 0xff, ...nm, ...int16(3 + ds.length), ds.length, ...ds]);
    }
    function param(id, name, type, dims, bytes, desc = "") {
      const nm = ascii(name), ds = ascii(desc);
      const body = [type & 0xff, dims.length, ...dims, ...bytes, ds.length, ...ds];
      records.push([nm.length, id, ...nm, ...int16(2 + body.length), ...body]);
    }
    const int16 = (v) => [v & 0xff, (v >> 8) & 0xff];
    const f32 = (v) => Array.from(new Uint8Array(new Float32Array([v]).buffer));
    const chars = (list, width) => list.flatMap((s) => ascii(s.padEnd(width).slice(0, width)));
    const labelWidth = Math.max(1, ...labels.map((l) => l.length));
    const descWidth = Math.max(1, ...descriptions.map((d) => d.length));

    const paramsFor = (dataStart) => {
      records.length = 0;
      group(1, "POINT", "3D point data");
      param(1, "USED", 2, [], int16(nPoints), "Number of points");
      if (nFrames <= 32767) param(1, "FRAMES", 2, [], int16(nFrames), "Number of frames");
      else param(1, "FRAMES", 4, [], f32(nFrames), "Number of frames");
      param(1, "DATA_START", 2, [], int16(dataStart), "First block of 3D data");
      param(1, "SCALE", 4, [], f32(-1), "Negative: floating point data");
      param(1, "RATE", 4, [], f32(rate), "Frames per second");
      param(1, "UNITS", -1, [2], ascii("mm"), "Units of length");
      param(1, "LABELS", -1, [labelWidth, nPoints], chars(labels, labelWidth), "Point labels");
      param(1, "DESCRIPTIONS", -1, [descWidth, nPoints], chars(descriptions, descWidth), "Point descriptions");
      group(2, "ANALOG", "Analog data");
      param(2, "USED", 2, [], int16(0), "No analog channels");
      param(2, "RATE", 4, [], f32(rate), "Analog rate");
      group(3, "TRIAL", "Trial information");
      param(3, "ACTUAL_START_FIELD", 2, [2], [...int16(1), ...int16(0)], "First frame");
      param(3, "ACTUAL_END_FIELD", 2, [2], [...int16(nFrames & 0xffff), ...int16(nFrames >>> 16)], "Last frame");
      return records.flat();
    };
    let paramBytes = paramsFor(0);
    const paramBlocks = Math.ceil((4 + paramBytes.length) / 512);
    const dataStart = 2 + paramBlocks; // block 1 = header, parameters start at block 2
    paramBytes = paramsFor(dataStart);

    const dataBytes = nFrames * nPoints * 16;
    const buf = new ArrayBuffer((dataStart - 1) * 512 + Math.ceil(dataBytes / 512) * 512);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);

    // Header block (16-bit words, little-endian / Intel).
    dv.setUint8(0, 2); // first parameter block
    dv.setUint8(1, 0x50); // C3D key
    dv.setUint16(2, nPoints, true);
    dv.setUint16(4, 0, true); // analog measurements per frame
    dv.setUint16(6, 1, true); // first frame
    dv.setUint16(8, Math.min(nFrames, 65535), true); // last frame
    dv.setUint16(10, 0, true); // max interpolation gap
    dv.setFloat32(12, -1, true); // scale (negative = float data)
    dv.setUint16(16, dataStart, true);
    dv.setUint16(18, 0, true); // analog samples per frame
    dv.setFloat32(20, rate, true);

    // Parameter block header, then the records.
    const p0 = 512;
    u8[p0] = 1;
    u8[p0 + 1] = 0x50;
    u8[p0 + 2] = paramBlocks;
    u8[p0 + 3] = 84; // Intel processor
    u8.set(paramBytes, p0 + 4);

    // Point data: X, Y, Z (mm, Z-up) and a residual word (0 = valid, -1 = missing).
    let o = (dataStart - 1) * 512;
    for (let k = 0; k < nFrames; k++) {
      for (let m = 0; m < nPoints; m++) {
        const p = pointAt(k, m);
        dv.setFloat32(o, p ? p[0] : 0, true);
        dv.setFloat32(o + 4, p ? p[1] : 0, true);
        dv.setFloat32(o + 8, p ? p[2] : 0, true);
        dv.setFloat32(o + 12, p ? 0 : -1, true);
        o += 16;
      }
    }
    return new Uint8Array(buf);
  }


  function toC3D(prep) {
    const labels = [];
    const descriptions = [];
    for (const tr of prep.tracks) {
      for (const j of JOINTS) {
        labels.push(`${tr.prefix}_${j}`);
        descriptions.push(`${tr.name} hand ${j.replace("_", " ")}`);
      }
    }
    const poses = resampledPoses(prep);
    return writeC3D({
      rate: prep.fps,
      labels,
      descriptions,
      frameCount: prep.times.length,
      pointAt: (k, m) => {
        const pose = poses[k][Math.floor(m / 21)];
        return pose ? mul(toZUp(pose[m % 21]), prep.mmPerUnit) : null;
      },
    });
  }

  // ---------- GLB (glTF 2.0 binary) ----------
  function sphereGeometry(r, seg = 10, rings = 7) {
    const pos = [], nor = [], idx = [];
    for (let i = 0; i <= rings; i++) {
      const phi = (i / rings) * Math.PI;
      for (let j = 0; j <= seg; j++) {
        const th = (j / seg) * 2 * Math.PI;
        const n = [Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th)];
        nor.push(...n);
        pos.push(...mul(n, r));
      }
    }
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < seg; j++) {
        const a = i * (seg + 1) + j, b = a + seg + 1;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    return { pos, nor, idx };
  }

  // Unit-height cylinder along +Y, centered on the origin (scaled per bone).
  function cylinderGeometry(r, seg = 8) {
    const pos = [], nor = [], idx = [];
    for (let j = 0; j <= seg; j++) {
      const th = (j / seg) * 2 * Math.PI;
      const c = Math.cos(th), s = Math.sin(th);
      pos.push(r * c, -0.5, r * s, r * c, 0.5, r * s);
      nor.push(c, 0, s, c, 0, s);
    }
    for (let j = 0; j < seg; j++) {
      const a = 2 * j, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    return { pos, nor, idx };
  }

  // A small glTF 2.0 binary builder: meshes, materials, a node tree and one animation.
  function createGLB(sceneName, rootName) {
    const gltf = {
      asset: { version: "2.0", generator: "Hand Tracker" },
      scene: 0,
      scenes: [{ name: sceneName, nodes: [0] }],
      nodes: [{ name: rootName, children: [] }],
      meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [],
      animations: [{ name: "Capture", samplers: [], channels: [] }],
    };
    const chunks = [];
    let binLength = 0;

    function accessor(typed, type, extra = {}, target) {
      const pad = (4 - (binLength % 4)) % 4;
      if (pad) {
        chunks.push(new Uint8Array(pad));
        binLength += pad;
      }
      const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
      const view = { buffer: 0, byteOffset: binLength, byteLength: bytes.byteLength };
      if (target) view.target = target;
      chunks.push(bytes);
      binLength += bytes.byteLength;
      gltf.bufferViews.push(view);
      const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
      gltf.accessors.push({
        bufferView: gltf.bufferViews.length - 1,
        componentType: typed instanceof Uint16Array ? 5123 : 5126,
        count: typed.length / width,
        type,
        ...extra,
      });
      return gltf.accessors.length - 1;
    }
    function minMax(values, width) {
      const min = new Array(width).fill(Infinity), max = new Array(width).fill(-Infinity);
      for (let i = 0; i < values.length; i++) {
        const k = i % width;
        min[k] = Math.min(min[k], values[i]);
        max[k] = Math.max(max[k], values[i]);
      }
      return { min, max };
    }
    function geometry(g) {
      return {
        POSITION: accessor(new Float32Array(g.pos), "VEC3", minMax(g.pos, 3), 34962),
        NORMAL: accessor(new Float32Array(g.nor), "VEC3", {}, 34962),
        indices: accessor(new Uint16Array(g.idx), "SCALAR", {}, 34963),
      };
    }
    function material(name, rgb) {
      gltf.materials.push({ name, doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [...rgb, 1], metallicFactor: 0, roughnessFactor: 0.6 } });
      return gltf.materials.length - 1;
    }
    function mesh(name, geo, mat) {
      const { indices, ...attributes } = geo;
      gltf.meshes.push({ name, primitives: [{ attributes, indices, material: mat }] });
      return gltf.meshes.length - 1;
    }
    function animate(node, path, input, values, width, interpolation = "LINEAR") {
      const anim = gltf.animations[0];
      anim.samplers.push({ input, output: accessor(new Float32Array(values), width === 3 ? "VEC3" : "VEC4"), interpolation });
      anim.channels.push({ sampler: anim.samplers.length - 1, target: { node, path } });
    }
    function addNode(node, parent) {
      gltf.nodes.push(node);
      const index = gltf.nodes.length - 1;
      gltf.nodes[parent].children = gltf.nodes[parent].children || [];
      gltf.nodes[parent].children.push(index);
      return index;
    }

    function finish() {
      const binPad = (4 - (binLength % 4)) % 4;
      gltf.buffers.push({ byteLength: binLength + binPad });
      const json = new TextEncoder().encode(JSON.stringify(gltf));
      const jsonPad = (4 - (json.length % 4)) % 4;
      const total = 12 + 8 + json.length + jsonPad + 8 + binLength + binPad;
      const out = new Uint8Array(total);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, 0x46546c67, true); // "glTF"
      dv.setUint32(4, 2, true);
      dv.setUint32(8, total, true);
      dv.setUint32(12, json.length + jsonPad, true);
      dv.setUint32(16, 0x4e4f534a, true); // "JSON"
      out.set(json, 20);
      out.fill(0x20, 20 + json.length, 20 + json.length + jsonPad);
      let o = 20 + json.length + jsonPad;
      dv.setUint32(o, binLength + binPad, true);
      dv.setUint32(o + 4, 0x004e4942, true); // "BIN\0"
      o += 8;
      for (const c of chunks) {
        out.set(c, o);
        o += c.byteLength;
      }
      return out;
    }
    return { accessor, geometry, material, mesh, animate, addNode, finish };
  }

  function toGLB(prep) {
    const m = prep.mmPerUnit / 1000; // glTF units are meters
    const g = createGLB("Hand capture", "HandCapture");
    const { accessor, material, mesh, animate, addNode } = g;
    const sphere = g.geometry(sphereGeometry(0.005));
    const cylinder = g.geometry(cylinderGeometry(0.0022));

    for (const tr of prep.tracks) {
      const jointMesh = mesh(`${tr.name} joint`, sphere, material(`${tr.name} joints`, tr.color));
      const boneMesh = mesh(`${tr.name} bone`, cylinder, material(`${tr.name} bones`, tr.color.map((c) => 0.55 + 0.45 * c)));
      const S = tr.samples;
      const times = S.map((s) => s.t);
      const input = accessor(new Float32Array(times), "SCALAR", { min: [times[0]], max: [times[times.length - 1]] });
      const P = S.map((s) => s.world.map((p) => mul(toYUp(p), m)));

      // Hide the hand (scale 0) while it wasn't tracked.
      const vis = [];
      if (times[0] > 0) vis.push([0, 0]);
      times.forEach((t, i) => {
        vis.push([t, 1]);
        const gap = i + 1 < times.length ? times[i + 1] - t : 0;
        if (gap > MAX_GAP_S) vis.push([t + Math.min(1 / prep.fps, gap / 2), 0]); // keys must stay in order
      });
      const handNode = addNode({ name: `${tr.name} hand`, scale: vis[0][1] ? [1, 1, 1] : [0, 0, 0] }, 0);
      const visInput = accessor(new Float32Array(vis.map((v) => v[0])), "SCALAR", { min: [vis[0][0]], max: [vis[vis.length - 1][0]] });
      animate(handNode, "scale", visInput, vis.flatMap(([, v]) => [v, v, v]), 3, "STEP");

      for (let j = 0; j < 21; j++) {
        const node = addNode({ name: `${tr.prefix}_${JOINTS[j]}`, mesh: jointMesh, translation: P[0][j] }, handNode);
        animate(node, "translation", input, P.flatMap((pose) => pose[j]), 3);
      }
      for (const [a, b] of CONNECTIONS) {
        const T = [], R = [], Sc = [];
        let prev = null;
        for (const pose of P) {
          const d = sub(pose[b], pose[a]);
          let q = qFromTo([0, 1, 0], norm(d));
          if (prev && q[0] * prev[0] + q[1] * prev[1] + q[2] * prev[2] + q[3] * prev[3] < 0) q = q.map((v) => -v); // no flips between keys
          prev = q;
          T.push(...lerp(pose[a], pose[b], 0.5));
          R.push(...q);
          Sc.push(1, length(d), 1);
        }
        const node = addNode(
          { name: `${tr.prefix}_${JOINTS[a]}-${JOINTS[b]}`, mesh: boneMesh, translation: T.slice(0, 3), rotation: R.slice(0, 4), scale: Sc.slice(0, 3) },
          handNode
        );
        animate(node, "translation", input, T, 3);
        animate(node, "rotation", input, R, 4);
        animate(node, "scale", input, Sc, 3);
      }
    }

    return g.finish();
  }

  // ---------- NPZ (NumPy) ----------
  function npy(descr, shape, bytes) {
    const shapeText = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(", ")})`;
    let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': ${shapeText}, }`;
    const total = 10 + header.length + 1;
    header += " ".repeat((64 - (total % 64)) % 64) + "\n"; // numpy aligns data to 64 bytes
    const head = new Uint8Array(10 + header.length);
    head.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]); // \x93NUMPY v1.0
    new DataView(head.buffer).setUint16(8, header.length, true);
    head.set(Array.from(header, (c) => c.charCodeAt(0)), 10);
    const out = new Uint8Array(head.length + bytes.byteLength);
    out.set(head);
    out.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), head.length);
    return out;
  }
  function npyStrings(list) {
    const width = Math.max(1, ...list.map((s) => s.length));
    const codes = new Uint32Array(list.length * width);
    list.forEach((s, i) => Array.from(s).forEach((c, k) => (codes[i * width + k] = c.codePointAt(0))));
    return npy(`<U${width}`, [list.length], codes);
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // Uncompressed ("stored") zip — exactly what numpy.savez writes.
  function zip(files) {
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const { name, data } of files) {
      const nameBytes = new TextEncoder().encode(name);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      parts.push(new Uint8Array(local.buffer), nameBytes, data);

      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true);
      entry.setUint16(4, 20, true);
      entry.setUint16(6, 20, true);
      entry.setUint16(12, dosTime, true);
      entry.setUint16(14, dosDate, true);
      entry.setUint32(16, crc, true);
      entry.setUint32(20, data.length, true);
      entry.setUint32(24, data.length, true);
      entry.setUint16(28, nameBytes.length, true);
      entry.setUint32(42, offset, true);
      central.push(new Uint8Array(entry.buffer), nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const centralSize = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of all) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  function toNPZ(prep) {
    const files = [
      { name: "joint_names.npy", data: npyStrings(JOINTS) },
      { name: "parents.npy", data: npy("<i4", [21], new Int32Array(PARENT)) },
      { name: "phase_names.npy", data: npyStrings(PHASES) },
      { name: "frame_rate.npy", data: npy("<f8", [1], new Float64Array([prep.fps])) },
      { name: "image_size.npy", data: npy("<i4", [2], new Int32Array(prep.imageSize)) },
    ];
    for (const tr of prep.tracks) {
      const S = tr.samples;
      const n = S.length;
      files.push(
        { name: `${tr.key}_t.npy`, data: npy("<f8", [n], new Float64Array(S.map((s) => s.t))) },
        { name: `${tr.key}_joints.npy`, data: npy("<f4", [n, 21, 3], new Float32Array(S.flatMap((s) => s.raw.flat()))) },
        { name: `${tr.key}_wrist.npy`, data: npy("<f4", [n, 3], new Float32Array(S.flatMap((s) => s.wristRaw))) },
        { name: `${tr.key}_palm_quat.npy`, data: npy("<f4", [n, 4], new Float32Array(S.flatMap((s) => s.quat))) },
        { name: `${tr.key}_phase.npy`, data: npy("|i1", [n], new Int8Array(S.map((s) => Math.max(0, PHASES.indexOf(s.phase))))) }
      );
      // Real shape in metres and a depth camera's distance in mm (NaN where not recorded).
      if (S.some((s) => s.real)) {
        files.push({ name: `${tr.key}_real_joints.npy`, data: npy("<f4", [n, 21, 3], new Float32Array(S.flatMap((s) => (s.real ? s.real.flat() : new Array(63).fill(NaN))))) });
      }
      if (S.some((s) => s.distance)) {
        files.push({ name: `${tr.key}_distance_mm.npy`, data: npy("<f4", [n, 3], new Float32Array(S.flatMap((s) => s.distance || [NaN, NaN, NaN]))) });
      }
    }
    return zip(files);
  }

  // ---------- Marker recordings (imported C3D / OptiTrack .tak) ----------
  // Marker data: { labels, frame_rate, first_frame, frame_count, positions: Float32Array
  // (frame-major, NaN = missing), units "mm", up_axis "z" } — see motion-import.js.
  const MARKER_FORMATS = [
    { id: "c3d", label: "C3D", detail: "Mocap standard · Vicon, Qualisys, Visual3D, Mokka" },
    { id: "trc", label: "TRC", detail: "Marker trajectories · OpenSim" },
    { id: "csv", label: "CSV", detail: "Spreadsheets · one row per frame" },
    { id: "glb", label: "GLB (glTF)", detail: "Animated 3D markers · Blender, Unity, 3D Viewer" },
    { id: "npz", label: "NPZ", detail: "NumPy arrays · Python, ML, robotics" },
    { id: "json", label: "JSON", detail: "Plain data · any language" },
    { id: "mcap", label: "MCAP (ROS 2)", detail: "ROS 2 bag · ros2 bag play, RViz, Foxglove" },
  ];
  const MARKER_PALETTE = [[0.30, 0.67, 0.97], [1.0, 0.57, 0.17], [0.32, 0.81, 0.40], [0.97, 0.51, 0.67], [0.75, 0.55, 0.98], [1.0, 0.83, 0.23]];

  function markerPoint(md, k, m) {
    const i = (k * md.labels.length + m) * 3;
    const x = md.positions[i], y = md.positions[i + 1], z = md.positions[i + 2];
    return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? [x, y, z] : null;
  }
  const markerTimes = (md) => Array.from({ length: md.frame_count }, (_, k) => k / md.frame_rate);
  const zUpToYUp = (p) => [p[0], p[2], -p[1]]; // (x, y, z) Z-up -> (x, z, -y) Y-up

  function csvCell(v) {
    const text = String(v);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function toMarkerCSV(md) {
    const header = ["frame", "t", ...md.labels.flatMap((l) => [`${l}_x`, `${l}_y`, `${l}_z`])].map(csvCell);
    const lines = [header.join(",")];
    for (let k = 0; k < md.frame_count; k++) {
      const cells = [md.first_frame + k, (k / md.frame_rate).toFixed(5)];
      for (let m = 0; m < md.labels.length; m++) {
        const p = markerPoint(md, k, m);
        if (p) cells.push(p[0].toFixed(3), p[1].toFixed(3), p[2].toFixed(3));
        else cells.push("", "", "");
      }
      lines.push(cells.join(","));
    }
    return lines.join("\n") + "\n";
  }

  function toMarkerJSON(md) {
    const round = (v) => Math.round(v * 1000) / 1000;
    const frames = [];
    for (let k = 0; k < md.frame_count; k++) {
      frames.push(md.labels.map((_, m) => {
        const p = markerPoint(md, k, m);
        return p ? p.map(round) : null;
      }));
    }
    return JSON.stringify({
      format: "hand-tracker-markers",
      version: 1,
      name: md.name,
      source: md.source,
      frame_rate: md.frame_rate,
      first_frame: md.first_frame,
      units: "mm",
      up_axis: "z",
      labels: md.labels,
      frames,
    });
  }

  function toMarkerGLB(md) {
    const g = createGLB("Marker capture", "Markers");
    const times = markerTimes(md);
    const sphere = g.geometry(sphereGeometry(0.007)); // ~14 mm markers
    const meshes = MARKER_PALETTE.map((rgb, i) => g.mesh(`marker ${i + 1}`, sphere, g.material(`marker ${i + 1}`, rgb)));
    md.labels.forEach((label, m) => {
      const keys = [];
      for (let k = 0; k < md.frame_count; k++) {
        const p = markerPoint(md, k, m);
        if (p) keys.push([times[k], mul(zUpToYUp(p), 1 / 1000)]); // glTF: meters, Y-up
      }
      if (!keys.length) return; // never seen: leave it out
      const node = g.addNode({ name: label, mesh: meshes[m % meshes.length], translation: keys[0][1] }, 0);
      const input = g.accessor(new Float32Array(keys.map((kv) => kv[0])), "SCALAR", { min: [keys[0][0]], max: [keys[keys.length - 1][0]] });
      g.animate(node, "translation", input, keys.flatMap((kv) => kv[1]), 3);
      // Visible only on frames where the marker was tracked.
      const vis = [];
      for (let k = 0; k < md.frame_count; k++) {
        const on = markerPoint(md, k, m) ? 1 : 0;
        if (!vis.length || vis[vis.length - 1][1] !== on) vis.push([times[k], on]);
      }
      if (vis.length > 1 || vis[0][1] === 0) {
        const visInput = g.accessor(new Float32Array(vis.map((v) => v[0])), "SCALAR", { min: [vis[0][0]], max: [vis[vis.length - 1][0]] });
        g.animate(node, "scale", visInput, vis.flatMap(([, v]) => [v, v, v]), 3, "STEP");
      }
    });
    return g.finish();
  }

  function toMarkerNPZ(md) {
    return zip([
      { name: "t.npy", data: npy("<f8", [md.frame_count], new Float64Array(markerTimes(md))) },
      { name: "positions.npy", data: npy("<f4", [md.frame_count, md.labels.length, 3], md.positions) },
      { name: "labels.npy", data: npyStrings(md.labels) },
      { name: "frame_rate.npy", data: npy("<f8", [1], new Float64Array([md.frame_rate])) },
      { name: "units.npy", data: npyStrings(["mm"]) },
      { name: "up_axis.npy", data: npyStrings(["z"]) },
    ]);
  }

  function buildMarkers(md, formatIds, baseName = "markers") {
    if (!md.labels.length || !md.frame_count) throw new Error("This recording has no markers.");
    const out = [];
    for (const id of formatIds) {
      switch (id) {
        case "c3d":
          out.push({ format: id, suffix: "", ext: "c3d", data: writeC3D({ rate: md.frame_rate, labels: md.labels, descriptions: md.labels, frameCount: md.frame_count, pointAt: (k, m) => markerPoint(md, k, m) }) });
          break;
        case "trc":
          out.push({ format: id, suffix: "", ext: "trc", data: writeTRC({ fileName: `${baseName}.trc`, rate: md.frame_rate, labels: md.labels, times: markerTimes(md), pointAt: (k, m) => {
            const p = markerPoint(md, k, m);
            return p ? zUpToYUp(p) : null;
          } }) });
          break;
        case "csv":
          out.push({ format: id, suffix: "", ext: "csv", data: toMarkerCSV(md) });
          break;
        case "glb":
          out.push({ format: id, suffix: "", ext: "glb", data: toMarkerGLB(md) });
          break;
        case "npz":
          out.push({ format: id, suffix: "", ext: "npz", data: toMarkerNPZ(md) });
          break;
        case "json":
          out.push({ format: id, suffix: "", ext: "json", data: toMarkerJSON(md) });
          break;
        case "mcap":
          out.push({ format: id, suffix: "", ext: "mcap", data: toMarkerMCAP(md) });
          break;
        default:
          throw new Error(`Unknown marker format: ${id}`);
      }
    }
    return out;
  }

  // ---------- entry point ----------
  // ---------- MCAP (ROS 2) ----------
  // ROS 2 messages in an MCAP file (mcap.js), which `ros2 bag play`, RViz and Foxglove read:
  // each hand's 21 joints as a geometry_msgs/PoseArray on /hand_tracker/<hand>/joints (metres,
  // each joint's x axis along its bone, the wrist's the palm's), and every hand's skeleton as a
  // visualization_msgs/MarkerArray on /hand_tracker/skeleton, in the frame "hand_tracker" (x away
  // from the camera, y to the left, z up, as ROS has it), timed from when the take was recorded.
  // The JSON export rides along as an attachment (hand_tracker.json): what Hand Tracker reads back.
  const MCAP_FRAME = "hand_tracker";
  const MCAP_LIFETIME_NS = BigInt(MAX_GAP_S * 1e9); // a hand not seen for this long disappears
  const rosName = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "h$1") || "hand";
  const utf8 = (s) => new TextEncoder().encode(s);
  // Image axes (x right, y down, z away) in mm -> ROS (x away, y left, z up) in m.
  const imageToRos = (p, mmPerUnit) => [(p[2] * mmPerUnit) / 1000, (-p[0] * mmPerUnit) / 1000, (-p[1] * mmPerUnit) / 1000];
  // Z-up mm (x right, y away, z up: C3D, Motive) -> ROS m, and back (motion-import.js).
  const zUpToRos = (p) => [p[1] / 1000, -p[0] / 1000, p[2] / 1000];

  // Each joint's orientation: its x axis along its bone (a fingertip's, along the bone that ends
  // there), the wrist's the palm's.
  function jointQuats(P) {
    return P.map((p, j) => {
      if (j === 0) return palmQuat(P);
      const child = PARENT.indexOf(j);
      const d = child >= 0 ? sub(P[child], p) : sub(p, P[PARENT[j]]);
      return length(d) > 1e-9 ? qFromTo([1, 0, 0], norm(d)) : [0, 0, 0, 1];
    });
  }

  function mcapWriter() {
    const M = global.Mcap;
    if (!M) throw new Error("MCAP export isn't available here (mcap.js is missing).");
    const w = M.writer({ profile: "ros2", library: "Hand Tracker" });
    return {
      M, w,
      poseArray: w.schema("geometry_msgs/msg/PoseArray", "ros2msg", M.ROS2.PoseArray),
      markerArray: w.schema("visualization_msgs/msg/MarkerArray", "ros2msg", M.ROS2.MarkerArray),
      qos: { offered_qos_profiles: M.QOS },
    };
  }

  function toMCAP(prep, data) {
    const { M, w, poseArray, markerArray, qos } = mcapWriter();
    const origin = BigInt(Date.parse(data.recorded_at) || 0) * 1000000n;
    const at = (t) => origin + BigInt(Math.round(t * 1e9));
    const topics = new Set();
    const channels = prep.tracks.map((tr) => {
      let name = rosName(tr.name);
      for (let k = 2; topics.has(name); k++) name = `${rosName(tr.name)}_${k}`;
      topics.add(name);
      // The joints' names, as Hand Tracker's C3D names them (so they read back as this hand).
      return w.channel(`/hand_tracker/${name}/joints`, "cdr", poseArray, { ...qos, labels: JSON.stringify(JOINTS.map((j) => `${tr.prefix}_${j}`)) });
    });
    const skeleton = w.channel("/hand_tracker/skeleton", "cdr", markerArray, qos);
    const frames = [];
    prep.tracks.forEach((tr, h) => tr.samples.forEach((s) => frames.push({ h, s })));
    frames.sort((a, b) => a.s.t - b.s.t);
    for (const { h, s } of frames) {
      const tr = prep.tracks[h], t = at(s.t);
      const P = s.world.map((p) => imageToRos(p, prep.mmPerUnit));
      const Q = jointQuats(P);
      w.message(channels[h], t, M.cdr.poseArray(t, MCAP_FRAME, P.map((p, j) => ({ p, q: Q[j] }))));
      const side = /Left$/.test(tr.name) ? "Left" : /Right$/.test(tr.name) ? "Right" : "";
      const color = [...(HAND_COLORS[side] || tr.color), 1];
      const ns = rosName(tr.name);
      w.message(skeleton, t, M.cdr.markerArray([
        { timeNs: t, frameId: MCAP_FRAME, ns, id: 0, type: 7, scale: [0.012, 0.012, 0.012], color, lifetimeNs: MCAP_LIFETIME_NS, points: P },
        { timeNs: t, frameId: MCAP_FRAME, ns, id: 1, type: 5, scale: [0.005, 0, 0], color, lifetimeNs: MCAP_LIFETIME_NS, points: CONNECTIONS.flatMap(([a, b]) => [P[a], P[b]]) },
      ]));
    }
    const meta = { recorded_at: String(data.recorded_at || ""), hands: prep.tracks.map((tr) => tr.name).join(", "), frame_rate: String(prep.fps), units: "m", frame_id: MCAP_FRAME };
    for (const [k, v] of Object.entries(data.metadata || {})) if (v !== null && v !== undefined && typeof v !== "object") meta[k] = String(v);
    w.metadata("hand_tracker", meta);
    w.attachment("hand_tracker.json", "application/json", utf8(JSON.stringify(data)), origin);
    return w.finish();
  }

  // A marker recording: its points as one geometry_msgs/PoseArray on /markers/points (missing
  // ones NaN, in the order of the channel's "labels"), and the ones seen as spheres on
  // /markers/spheres, in the frame "mocap".
  function toMarkerMCAP(md) {
    const { M, w, poseArray, markerArray, qos } = mcapWriter();
    const origin = BigInt(Date.parse(md.recorded_at) || 0) * 1000000n;
    const points = w.channel("/markers/points", "cdr", poseArray, { ...qos, labels: JSON.stringify(md.labels) });
    const spheres = w.channel("/markers/spheres", "cdr", markerArray, qos);
    for (let k = 0; k < md.frame_count; k++) {
      const t = origin + BigInt(Math.round((k / md.frame_rate) * 1e9));
      const P = md.labels.map((_, m) => {
        const p = markerPoint(md, k, m);
        return p ? zUpToRos(p) : [NaN, NaN, NaN];
      });
      w.message(points, t, M.cdr.poseArray(t, "mocap", P.map((p) => ({ p, q: [0, 0, 0, 1] }))));
      w.message(spheres, t, M.cdr.markerArray([{ timeNs: t, frameId: "mocap", ns: "markers", id: 0, type: 7, scale: [0.014, 0.014, 0.014], color: [...MARKER_PALETTE[0], 1],
        lifetimeNs: BigInt(Math.round(2e9 / md.frame_rate)), points: P.filter((p) => p.every(Number.isFinite)) }]));
    }
    w.metadata("hand_tracker", { kind: "markers", labels: String(md.labels.length), frame_rate: String(md.frame_rate), units: "m", frame_id: "mocap" });
    w.attachment("hand_tracker.json", "application/json", utf8(toMarkerJSON(md)), origin);
    return w.finish();
  }

  function build(data, formatIds, baseName = "motion") {
    const prep = prepare(data);
    if (!prep.tracks.length) throw new Error("This recording has no hand frames.");
    const out = [];
    for (const id of formatIds) {
      switch (id) {
        case "json":
          out.push({ format: id, suffix: "", ext: "json", data: JSON.stringify(data, null, 2) });
          break;
        case "csv":
          out.push({ format: id, suffix: "", ext: "csv", data: toCSV(prep) });
          break;
        case "bvh":
          for (const tr of prep.tracks) out.push({ format: id, suffix: `-${tr.key}`, ext: "bvh", data: toBVH(prep, tr) });
          break;
        case "glb":
          out.push({ format: id, suffix: "", ext: "glb", data: toGLB(prep) });
          break;
        case "c3d":
          out.push({ format: id, suffix: "", ext: "c3d", data: toC3D(prep) });
          break;
        case "trc":
          out.push({ format: id, suffix: "", ext: "trc", data: toTRC(prep, `${baseName}.trc`) });
          break;
        case "npz":
          out.push({ format: id, suffix: "", ext: "npz", data: toNPZ(prep) });
          break;
        case "mcap":
          out.push({ format: id, suffix: "", ext: "mcap", data: toMCAP(prep, data) });
          break;
        default:
          throw new Error(`Unknown motion format: ${id}`);
      }
    }
    return out;
  }

  global.MotionExport = { FORMATS, build, JOINTS, MARKER_FORMATS, buildMarkers };
})(window);
