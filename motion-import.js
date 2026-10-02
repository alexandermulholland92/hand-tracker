/**
 * motion-import.js
 * Reads motion capture files back in:
 *  - hand recordings: the app's JSON (current or older single-hand files) or its
 *    CSV export — including CSVs edited or re-saved in a spreadsheet (semicolon or
 *    tab separators, decimal commas, quoted cells, rows in any order). These become
 *    a format_version 2 recording, the same shape RobotMotion.stop() produces.
 *  - marker recordings: C3D files (Vicon, Qualisys, OptiTrack Motive, this app…),
 *    OptiTrack Motive CSV exports, TRC files (OpenSim, Motive, this app) and the
 *    marker CSV / JSON this app writes. These become marker data:
 *    { kind: "markers", labels, frame_rate, first_frame, frame_count, duration,
 *      positions: Float32Array (frame-major x,y,z in mm, Z-up, NaN = missing) }.
 *
 *  - MCAP files (ROS 2, Foxglove): Hand Tracker's own read back exactly (from the recording
 *    attached to them); others' positions as markers: each geometry_msgs PoseArray pose,
 *    PoseStamped and PointStamped (chunks uncompressed, lz4 or zstd), labelled by topic.
 *
 *   MotionImport.parseFile(fileName, arrayBuffer) -> { data, source, warnings: [string] }
 *   MotionImport.parse(text, fileName)            -> same, for text formats
 *   MotionImport.fromC3D(arrayBuffer, fileName)   -> marker data
 *
 * A CSV only holds positions, the palm orientation and the phase, so on import
 * joint orientations, velocities and accelerations are recalculated from the
 * positions (the palm orientation too, if its columns are missing). Task phases
 * come from the "phase" column, so edits made there are kept.
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
  const MAX_GAP_S = 0.25; // same rule as robot-motion.js: longer gaps restart velocities
  const DEFAULT_IMAGE_SIZE = [1280, 720]; // the app's default camera resolution
  const NOTES = [
    "Each entry in hands[] is one hand's track; t is seconds on a clock shared by all hands.",
    "Joint positions are wrist-relative (wrist = local origin).",
    "end_effector trajectory is camera-frame, not calibrated world 3D (monocular limitation).",
  ];

  // ---------- small vector / quaternion helpers (same math as hand-tracker.js) ----------
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1e-6;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // Shortest rotation from +Y to the bone direction, as [x, y, z, w].
  function boneQuat(dir) {
    const up = [0, 1, 0];
    const d = dot(up, dir);
    if (d > 0.999999) return [0, 0, 0, 1];
    if (d < -0.999999) return [1, 0, 0, 0];
    const axis = cross(up, dir);
    const s = Math.sqrt((1 + d) * 2);
    return [axis[0] / s, axis[1] / s, axis[2] / s, s / 2];
  }

  // Palm frame from the wrist and knuckles -> quaternion [x, y, z, w].
  function palmQuat(P) {
    const x = norm(sub(P[17], P[5]));
    const z = norm(cross(x, norm(sub(P[9], P[0]))));
    const y = norm(cross(z, x));
    const [m00, m10, m20] = x, [m01, m11, m21] = y, [m02, m12, m22] = z;
    const tr = m00 + m11 + m22;
    if (tr > 0) {
      const s = 0.5 / Math.sqrt(tr + 1);
      return [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
    }
    if (m00 > m11 && m00 > m22) {
      const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
      return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
    }
    if (m11 > m22) {
      const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
      return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
    }
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }

  // ---------- CSV parsing ----------
  // Picks the separator that occurs most often in the header (outside quotes).
  function detectDelimiter(text) {
    const header = text.split(/\r?\n/, 1)[0];
    let best = ",", bestCount = -1;
    for (const d of [",", ";", "\t"]) {
      let count = 0, quoted = false;
      for (const c of header) {
        if (c === '"') quoted = !quoted;
        else if (c === d && !quoted) count++;
      }
      if (count > bestCount) {
        best = d;
        bestCount = count;
      }
    }
    return best;
  }

  // RFC 4180-style rows: quoted cells may contain separators, quotes ("") and newlines.
  function parseRows(text, delim) {
    const rows = [];
    let row = [], cell = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i++;
          } else quoted = false;
        } else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === delim) {
        row.push(cell);
        cell = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else cell += c;
    }
    if (cell !== "" || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows.filter((r) => r.some((c) => c.trim() !== ""));
  }

  function fromCSV(text, fileName) {
    const warnings = [];
    const delim = detectDelimiter(text);
    const rows = parseRows(text, delim);
    if (rows.length < 2) throw new Error("The CSV has no data rows.");
    // OptiTrack Motive's CSV export: a metadata line, then Type/Name/ID rows, then "Frame,Time".
    if (/^format version$/i.test((rows[0][0] || "").trim()) || rows.some((r) => r[0] === "" && /^type$/i.test((r[1] || "").trim()))) {
      return markersFromMotiveCSV(rows, delim, fileName);
    }
    const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
    const col = (name) => header.indexOf(name);

    const required = ["t", ...JOINTS.flatMap((j) => [`${j}_x`, `${j}_y`, `${j}_z`])];
    const missing = required.filter((name) => col(name) < 0);
    // Not a hand CSV, but "t" plus <name>_x/_y/_z column triples: a marker CSV.
    if (missing.length && col("t") >= 0 && header.some((h, i) => h.endsWith("_x") && header[i + 1] === h.replace(/_x$/, "_y"))) {
      return markersFromCSV(rows, header, delim, fileName);
    }
    if (missing.length) {
      const shown = missing.slice(0, 6).join(", ") + (missing.length > 6 ? `, and ${missing.length - 6} more` : "");
      throw new Error(
        `This CSV isn't a motion capture file the viewer recognises (missing columns: ${shown}). ` +
          "It reads Hand Tracker's CSV export (a \"t\" column plus x/y/z columns for all 21 joints), Hand Tracker's marker CSV, and OptiTrack Motive's CSV export."
      );
    }

    // Spreadsheets in many regions save "0,123" with ";" separators.
    const decimalComma = delim !== "," && rows.slice(1, 20).some((r) => r.some((c) => /^\s*-?\d+,\d+(e[-+]?\d+)?\s*$/i.test(c)));
    const numberAt = (r, i) => {
      if (i < 0 || i >= r.length) return NaN;
      const v = r[i].trim();
      return v === "" ? NaN : Number(decimalComma ? v.replace(",", ".") : v);
    };
    // The wrist's camera-frame position is wrist_world_x/y/z. CSVs from earlier builds
    // named it wrist_x/y/z too, so there "wrist_x" appears twice: first the camera-frame
    // wrist, then the (wrist-relative) wrist joint.
    const allCols = (name) => header.reduce((found, h, i) => (h === name ? [...found, i] : found), []);
    const oldLayout = col("wrist_world_x") < 0 && allCols("wrist_x").length > 1;
    const jointCol = (j, axis) => (j === "wrist" && oldLayout ? allCols(`wrist_${axis}`)[1] : col(`${j}_${axis}`));
    const jointCols = JOINTS.map((j) => ["x", "y", "z"].map((axis) => jointCol(j, axis)));
    const wristCols = oldLayout ? ["x", "y", "z"].map((axis) => allCols(`wrist_${axis}`)[0]) : ["wrist_world_x", "wrist_world_y", "wrist_world_z"].map(col);
    const quatCols = ["palm_qx", "palm_qy", "palm_qz", "palm_qw"].map(col);
    const hasWrist = wristCols.every((i) => i >= 0);
    const hasQuat = quatCols.every((i) => i >= 0);
    const handCol = col("hand"), phaseCol = col("phase");
    const sizeCols = [col("image_width"), col("image_height")];
    // The hand's real shape (metres) and a depth camera's distance (mm), when recorded.
    const realCols = JOINTS.map((j) => ["x", "y", "z"].map((axis) => col(`${j}_real_${axis}`)));
    const hasReal = realCols.every((c) => c.every((i) => i >= 0));
    const distCols = ["distance_x_mm", "distance_y_mm", "distance_z_mm"].map(col);
    const hasDist = distCols.every((i) => i >= 0);

    // Group rows by hand.
    const byHand = new Map();
    let skipped = 0;
    for (const r of rows.slice(1)) {
      const t = numberAt(r, col("t"));
      const joints = jointCols.map((cols) => cols.map((i) => numberAt(r, i)));
      if (!Number.isFinite(t) || joints.some((p) => p.some((v) => !Number.isFinite(v)))) {
        skipped++;
        continue;
      }
      const rawHand = handCol >= 0 ? r[handCol].trim() : "";
      const hand = /^l(eft)?$/i.test(rawHand) ? "Left" : /^r(ight)?$/i.test(rawHand) ? "Right" : rawHand || "Hand";
      const wrist = hasWrist ? wristCols.map((i) => numberAt(r, i)) : null;
      const quat = hasQuat ? quatCols.map((i) => numberAt(r, i)) : null;
      const phase = phaseCol >= 0 && r[phaseCol].trim() ? r[phaseCol].trim().toLowerCase() : "idle";
      if (!byHand.has(hand)) byHand.set(hand, []);
      const real = hasReal ? realCols.map((cols) => cols.map((i) => numberAt(r, i))) : null;
      const distance = hasDist ? distCols.map((i) => numberAt(r, i)) : null;
      byHand.get(hand).push({
        t,
        joints,
        wrist: wrist && wrist.every(Number.isFinite) ? wrist : null,
        quat: quat && quat.every(Number.isFinite) ? quat : null,
        phase,
        size: sizeCols.map((i) => numberAt(r, i)),
        real: real && real.every((p) => p.every(Number.isFinite)) ? real : null,
        distance: distance && distance.every(Number.isFinite) ? distance : null,
      });
    }
    if (skipped) warnings.push(`${skipped} row${skipped === 1 ? " was" : "s were"} skipped because of missing or non-numeric values.`);
    if (!byHand.size) throw new Error("No usable rows: every row was missing a time or a joint value.");
    if (!hasWrist) warnings.push("No wrist_world_x/y/z columns: the hands are placed in the middle of the frame.");
    if (!hasQuat) warnings.push("No palm_q columns: palm orientation was recalculated from the joint positions.");

    const sizeRow = [...byHand.values()].flat().find((r) => r.size.every((v) => Number.isFinite(v) && v > 0));
    const imageSize = sizeRow ? sizeRow.size.map(Math.round) : DEFAULT_IMAGE_SIZE;
    if (!sizeRow) warnings.push(`No image_width/image_height columns: assumed ${imageSize[0]}×${imageSize[1]} for 3D exports.`);

    // Left, then Right, then anything else — the order the app records in.
    const order = (h) => (h === "Left" ? 0 : h === "Right" ? 1 : 2);
    const hands = [...byHand.entries()]
      .sort((a, b) => order(a[0]) - order(b[0]))
      .map(([name, list]) => buildHand(name, list, warnings));
    return finish(hands, imageSize, true, [`Imported from ${fileName || "a CSV file"}: joint orientations, velocities and accelerations were recalculated from the positions.`], warnings);
  }

  function buildHand(name, list, warnings) {
    list.sort((a, b) => a.t - b.t);
    // Keyframe times must increase (glTF requires it); drop repeated timestamps.
    const rows = list.filter((r, i) => i === 0 || r.t > list[i - 1].t);
    if (rows.length < list.length) warnings.push(`${name}: ${list.length - rows.length} row(s) with a repeated time were dropped.`);

    const frames = [], endEffector = [], palmTraj = [], segments = [];
    let prevPos = null, prevVel = null, prevT = null;
    rows.forEach((r, i) => {
      let dt = prevT === null ? null : r.t - prevT;
      if (dt !== null && dt > MAX_GAP_S) {
        dt = null;
        prevPos = null;
        prevVel = null;
      }
      const P = r.joints;
      const palm = r.quat || palmQuat(P);
      const velocities = [];
      const joints = P.map((p, j) => {
        const velocity = dt && prevPos ? sub(p, prevPos[j]).map((v) => v / dt) : [0, 0, 0];
        const acceleration = dt && prevVel ? sub(velocity, prevVel[j]).map((v) => v / dt) : [0, 0, 0];
        velocities.push(velocity);
        return {
          name: JOINTS[j],
          position: p,
          orientation: j === 0 ? palm : boneQuat(norm(sub(p, P[PARENT[j]]))),
          velocity,
          acceleration,
        };
      });
      const frame = { frame_index: i, t: r.t, joints };
      if (r.real) frame.world_joints = r.real;
      if (r.distance) frame.distance_mm = r.distance;
      frames.push(frame);
      endEffector.push([r.t, ...(r.wrist || [0.5, 0.5, 0])]);
      palmTraj.push([r.t, ...palm]);
      const last = segments[segments.length - 1];
      if (last && last.phase === r.phase) last.end_frame = i;
      else segments.push({ phase: r.phase, start_frame: i, end_frame: i });
      prevPos = P;
      prevVel = velocities;
      prevT = r.t;
    });
    const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
    return {
      handedness: name,
      frame_rate: span > 0 ? Math.round(((frames.length - 1) / span) * 10) / 10 : null,
      frames,
      trajectories: { end_effector: endEffector, palm_orientation: palmTraj },
      task_segments: segments,
    };
  }

  // Shared top-level fields for any imported recording.
  function finish(hands, imageSize, mirrored, extraNotes, warnings, base = {}) {
    const duration = hands.reduce((m, h) => Math.max(m, h.frames.length ? h.frames[h.frames.length - 1].t : 0), 0);
    const busiest = hands.reduce((best, h) => (!best || h.frames.length > best.frames.length ? h : best), null);
    const data = {
      format_version: 2,
      frame_rate: base.frame_rate != null ? base.frame_rate : busiest ? busiest.frame_rate : null,
      duration: base.duration != null ? base.duration : duration,
      recorded_at: base.recorded_at || null,
      image_size: imageSize,
      display_mirrored: mirrored,
      coordinate_frame: "wrist_relative + world_aligned",
      hands,
      notes: [...extraNotes, ...(Array.isArray(base.notes) ? base.notes : NOTES)],
    };
    return { data, source: "csv", warnings };
  }


  // ---------- Marker recordings ----------
  function markerData({ name, source, rate, firstFrame, labels, positions, notes = [], warnings = [] }) {
    const frameCount = labels.length ? positions.length / (labels.length * 3) : 0;
    // Unique, non-empty labels (spreadsheets and some C3D writers leave blanks or repeats).
    const seen = new Map();
    const clean = labels.map((l, i) => {
      let label = String(l || "").trim() || `Marker${i + 1}`;
      const n = (seen.get(label) || 0) + 1;
      seen.set(label, n);
      if (n > 1) label = `${label} (${n})`;
      return label;
    });
    return {
      data: {
        kind: "markers",
        name,
        source,
        frame_rate: rate,
        first_frame: firstFrame,
        frame_count: frameCount,
        duration: frameCount > 1 ? (frameCount - 1) / rate : 0,
        units: "mm",
        up_axis: "z",
        labels: clean,
        positions,
        notes,
      },
      source,
      warnings,
    };
  }

  // C3D, read from the published format description (c3d.org): header block,
  // parameter section (groups + parameters), then per-frame 3D points and analog samples.
  function fromC3D(buffer, fileName = "") {
    const u8 = new Uint8Array(buffer);
    if (u8.length < 1024 || u8[1] !== 0x50) throw new Error("This isn't a C3D file (the C3D signature is missing).");
    const pStart = (u8[0] - 1) * 512;
    const processor = u8[pStart + 3]; // 84 = Intel, 85 = DEC, 86 = MIPS
    if (processor === 85) throw new Error("This C3D uses the old DEC (VAX) number format. Re-save it in PC/Intel format and open it again.");
    const le = processor !== 86;
    const dv = new DataView(buffer);
    const i16 = (o) => dv.getInt16(o, le);
    const u16 = (o) => dv.getUint16(o, le);
    const f32 = (o) => dv.getFloat32(o, le);
    const ascii = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));

    // Parameters: GROUP:NAME -> value
    const groups = {};
    const params = {};
    let p = pStart + 4;
    const end = pStart + u8[pStart + 2] * 512;
    while (p + 2 < end) {
      const nameLen = Math.abs(dv.getInt8(p));
      const id = dv.getInt8(p + 1);
      if (nameLen === 0 || id === 0) break;
      const name = ascii(p + 2, nameLen).toUpperCase();
      const offsetPos = p + 2 + nameLen;
      const offset = i16(offsetPos);
      if (id < 0) groups[-id] = name;
      else {
        let q = offsetPos + 2;
        const type = dv.getInt8(q++);
        const dims = Array.from({ length: u8[q++] }, () => u8[q++]);
        const count = dims.reduce((a, d) => a * d, 1);
        let value;
        if (type === -1) {
          const width = dims[0] || 1;
          const text = ascii(q, count);
          value = dims.length > 1 ? Array.from({ length: count / width }, (_, k) => text.slice(k * width, (k + 1) * width).trim()) : text.trim();
        } else if (type === 1) value = Array.from(u8.subarray(q, q + count));
        else if (type === 2) value = Array.from({ length: count }, (_, k) => i16(q + 2 * k));
        else if (type === 4) value = Array.from({ length: count }, (_, k) => f32(q + 4 * k));
        params[`${id}:${name}`] = value;
      }
      if (offset === 0) break;
      p = offsetPos + offset;
    }
    const param = (group, name) => {
      const id = Object.keys(groups).find((k) => groups[k] === group);
      const v = id ? params[`${id}:${name}`] : undefined;
      return Array.isArray(v) && v.length === 1 && typeof v[0] === "number" ? v[0] : v;
    };

    const nPoints = u16(2);
    const analogPerFrame = u16(4); // analog measurements stored after the points of each frame
    const first = u16(6);
    const scale = typeof param("POINT", "SCALE") === "number" ? param("POINT", "SCALE") : f32(12);
    const dataStart = typeof param("POINT", "DATA_START") === "number" ? param("POINT", "DATA_START") : u16(16);
    const rate = typeof param("POINT", "RATE") === "number" && param("POINT", "RATE") > 0 ? param("POINT", "RATE") : f32(20);
    let frames = u16(8) - first + 1;
    const framesParam = param("POINT", "FRAMES");
    if (typeof framesParam === "number") frames = Math.max(frames, framesParam < 0 ? framesParam + 65536 : framesParam);

    let labels = [];
    for (const key of ["LABELS", "LABELS2", "LABELS3", "LABELS4"]) {
      const v = param("POINT", key);
      if (Array.isArray(v)) labels = labels.concat(v);
      else if (typeof v === "string") labels.push(v);
    }
    labels = labels.slice(0, nPoints);
    while (labels.length < nPoints) labels.push("");

    const units = String(param("POINT", "UNITS") || "mm").trim().toLowerCase();
    const toMM = { mm: 1, cm: 10, m: 1000, in: 25.4, inch: 25.4, inches: 25.4 }[units] || 1;
    const isFloat = scale < 0;
    const word = isFloat ? 4 : 2;
    const frameBytes = (nPoints * 4 + analogPerFrame) * word;
    const base = (dataStart - 1) * 512;
    const available = Math.floor((u8.length - base) / frameBytes);
    const warnings = [];
    if (available < frames) {
      warnings.push(`The file ends early: ${available} of ${frames} frames could be read.`);
      frames = Math.max(0, available);
    }
    if (!(rate > 0)) throw new Error("This C3D has no frame rate.");

    const positions = new Float32Array(frames * nPoints * 3).fill(NaN);
    const s = Math.abs(scale) || 1;
    let missing = 0;
    for (let k = 0; k < frames; k++) {
      let o = base + k * frameBytes;
      for (let m = 0; m < nPoints; m++, o += 4 * word) {
        let x, y, z, residual;
        if (isFloat) {
          x = f32(o); y = f32(o + 4); z = f32(o + 8); residual = f32(o + 12);
        } else {
          x = i16(o) * s; y = i16(o + 2) * s; z = i16(o + 4) * s; residual = i16(o + 6);
        }
        // Negative residual = no data; (0, 0, 0) is how many writers mark a gap too.
        if (residual < 0 || (x === 0 && y === 0 && z === 0) || !Number.isFinite(x)) {
          missing++;
          continue;
        }
        const i = (k * nPoints + m) * 3;
        positions[i] = x * toMM;
        positions[i + 1] = y * toMM;
        positions[i + 2] = z * toMM;
      }
    }
    if (units !== "mm") warnings.push(`Converted from ${units} to millimetres.`);
    const notes = [`${nPoints} markers, ${frames} frames at ${rate} fps${missing ? `; ${missing} missing samples` : ""}.`];
    return markerData({ name: fileName.replace(/\.[^.]+$/, ""), source: "c3d", rate, firstFrame: first, labels, positions, notes, warnings });
  }

  // The marker CSV this app writes: frame, t, then <label>_x/_y/_z per marker.
  function markersFromCSV(rows, header, delim, fileName) {
    const triples = [];
    header.forEach((h, i) => {
      if (h.endsWith("_x") && header[i + 1] === h.replace(/_x$/, "_y") && header[i + 2] === h.replace(/_x$/, "_z")) triples.push({ i, label: rows[0][i].trim().replace(/_x$/i, "") });
    });
    const tCol = header.indexOf("t");
    const frameCol = header.indexOf("frame");
    const decimalComma = delim !== "," && rows.slice(1, 20).some((r) => r.some((c) => /^\s*-?\d+,\d+(e[-+]?\d+)?\s*$/i.test(c)));
    const num = (r, i) => {
      const v = i >= 0 && i < r.length ? r[i].trim() : "";
      return v === "" ? NaN : Number(decimalComma ? v.replace(",", ".") : v);
    };
    const data = rows.slice(1).filter((r) => Number.isFinite(num(r, tCol))).sort((a, b) => num(a, tCol) - num(b, tCol));
    if (data.length < 2) throw new Error("The marker CSV needs at least two rows with a time.");
    const gaps = data.slice(1).map((r, k) => num(r, tCol) - num(data[k], tCol)).filter((d) => d > 0).sort((a, b) => a - b);
    const rate = gaps.length ? Math.round((1 / gaps[Math.floor(gaps.length / 2)]) * 1000) / 1000 : 30;
    const positions = new Float32Array(data.length * triples.length * 3);
    data.forEach((r, k) => triples.forEach((tr, m) => {
      for (let d = 0; d < 3; d++) positions[(k * triples.length + m) * 3 + d] = num(r, tr.i + d);
    }));
    const firstFrame = frameCol >= 0 && Number.isFinite(num(data[0], frameCol)) ? num(data[0], frameCol) : 0;
    return markerData({ name: fileName.replace(/\.[^.]+$/, ""), source: "csv", rate, firstFrame, labels: triples.map((t) => t.label), positions });
  }


  // OptiTrack Motive CSV export. Layout (version 1.2x):
  //   Format Version,1.25,…,Export Frame Rate,120,…,Length Units,Millimeters,…
  //   ,Type,Rigid Body,…,Rigid Body Marker,…,Marker,…
  //   ,Name,Rigid Body 1,…            (also ID and Parent rows)
  //   ,,Rotation,…,Position,…
  //   Frame,Time (Seconds),X,Y,Z,W,X,Y,Z,Error,…
  // Every "Position" X/Y/Z triple becomes a point: markers, solved rigid-body
  // markers, rigid-body centres and bones.
  function markersFromMotiveCSV(rows, delim, fileName) {
    const warnings = [];
    const meta = {};
    for (let i = 0; i + 1 < rows[0].length; i += 2) meta[rows[0][i].trim().toLowerCase()] = rows[0][i + 1].trim();
    const axisRow = rows.findIndex((r) => /^frame$/i.test((r[0] || "").trim()) && /^time/i.test((r[1] || "").trim()));
    if (axisRow < 1) throw new Error("This looks like an OptiTrack Motive CSV, but its column header (Frame, Time, X, Y, Z…) wasn't found.");
    const labelRow = (name) => rows.slice(0, axisRow).find((r) => r[0] === "" && (r[1] || "").trim().toLowerCase() === name) || [];
    const types = labelRow("type"), names = labelRow("name");
    const categories = rows[axisRow - 1];
    const axes = rows[axisRow].map((a) => a.trim().toUpperCase());

    const decimalComma = delim !== "," && rows.slice(axisRow + 1, axisRow + 20).some((r) => r.some((c) => /^\s*-?\d+,\d+(e[-+]?\d+)?\s*$/i.test(c)));
    const num = (r, i) => {
      const v = i < r.length ? r[i].trim() : "";
      return v === "" ? NaN : Number(decimalComma ? v.replace(",", ".") : v);
    };

    const points = []; // { col, name, type }
    let rotations = 0;
    for (let c = 2; c + 2 < axes.length; c++) {
      const category = (categories[c] || "").trim().toLowerCase();
      if (category === "rotation" && axes[c] === "X") rotations++;
      if (category === "position" && axes[c] === "X" && axes[c + 1] === "Y" && axes[c + 2] === "Z") {
        points.push({ col: c, name: (names[c] || "").trim() || `Point${points.length + 1}`, type: (types[c] || "").trim() });
      }
    }
    if (!points.length) throw new Error("This OptiTrack Motive CSV has no position columns to show.");
    // The same name can appear as a marker and as a rigid body's solved marker: keep both, labelled.
    const counts = points.reduce((m, pt) => m.set(pt.name, (m.get(pt.name) || 0) + 1), new Map());
    const labels = points.map((pt) => (counts.get(pt.name) > 1 && !/^marker$/i.test(pt.type) ? `${pt.name} (${pt.type.toLowerCase()})` : pt.name));

    const units = (meta["length units"] || "millimeters").toLowerCase();
    const toMM = units.startsWith("meter") ? 1000 : units.startsWith("centimeter") ? 10 : units.startsWith("inch") ? 25.4 : 1;
    const data = rows.slice(axisRow + 1).filter((r) => Number.isFinite(num(r, 0)));
    const rate = Number(meta["export frame rate"]) || Number(meta["capture frame rate"]) || 120;
    // Motive's CSV coordinates are a mirror image of its internal (and C3D) space;
    // flipping Y lines them up exactly with the same take opened as .tak or C3D (Z-up).
    const positions = new Float32Array(data.length * points.length * 3);
    data.forEach((r, k) => points.forEach((pt, m) => {
      const x = num(r, pt.col), y = num(r, pt.col + 1), z = num(r, pt.col + 2);
      const i = (k * points.length + m) * 3;
      positions[i] = x * toMM;
      positions[i + 1] = -y * toMM;
      positions[i + 2] = z * toMM;
    }));
    if (rotations) warnings.push(`${rotations} rigid-body / bone rotation${rotations === 1 ? " was" : "s were"} left out: the viewer shows positions.`);
    if (toMM !== 1) warnings.push(`Converted from ${units} to millimetres.`);
    const name = meta["take name"] || fileName.replace(/\.[^.]+$/, "");
    const notes = [`OptiTrack Motive CSV (format ${meta["format version"] || "?"}): ${points.length} points × ${data.length} frames at ${rate} fps.`];
    const out = markerData({ name, source: "motive-csv", rate, firstFrame: data.length ? num(data[0], 0) : 0, labels, positions, notes, warnings });
    return out;
  }

  // TRC marker tables (OpenSim, Motive, this app). TRC is Y-up by convention; it's
  // turned Z-up with the usual OpenSim rotation, the inverse of this app's TRC export.
  function fromTRC(text, fileName = "") {
    const lines = text.split(/\r?\n/);
    if (!/^PathFileType/i.test(lines[0] || "")) throw new Error("This isn't a TRC file (it should start with PathFileType).");
    const keys = (lines[1] || "").split("\t").map((k) => k.trim().toLowerCase());
    const values = (lines[2] || "").split("\t").map((v) => v.trim());
    const info = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
    const nameCells = (lines[3] || "").split("\t");
    const labels = [];
    for (let c = 2; c < nameCells.length; c += 3) if (nameCells[c] && nameCells[c].trim()) labels.push(nameCells[c].trim());
    const n = labels.length;
    const units = (info.units || "mm").toLowerCase();
    const toMM = { mm: 1, cm: 10, m: 1000, in: 25.4 }[units] || 1;
    const rate = Number(info.datarate) || Number(info.camerarate) || 30;
    const data = lines.slice(5).filter((l) => l.trim() && Number.isFinite(Number(l.split("\t")[0])));
    const positions = new Float32Array(data.length * n * 3);
    data.forEach((line, k) => {
      const cells = line.split("\t");
      for (let m = 0; m < n; m++) {
        const v = [2, 3, 4].map((d) => (cells[2 + m * 3 + d - 2] || "").trim()).map((c) => (c === "" ? NaN : Number(c) * toMM));
        const i = (k * n + m) * 3;
        positions[i] = v[0];
        positions[i + 1] = -v[2];
        positions[i + 2] = v[1];
      }
    });
    const firstFrame = data.length ? Number(data[0].split("\t")[0]) : 0;
    const warnings = toMM !== 1 ? [`Converted from ${units} to millimetres.`] : [];
    return markerData({ name: fileName.replace(/\.[^.]+$/, ""), source: "trc", rate, firstFrame, labels, positions, notes: [`TRC: ${n} markers × ${data.length} frames at ${rate} fps.`], warnings });
  }

  function markersFromJSON(raw, fileName) {
    const labels = Array.isArray(raw.labels) ? raw.labels : [];
    const frames = Array.isArray(raw.frames) ? raw.frames : [];
    const positions = new Float32Array(frames.length * labels.length * 3).fill(NaN);
    frames.forEach((frame, k) => labels.forEach((_, m) => {
      const pt = frame && frame[m];
      if (Array.isArray(pt)) for (let d = 0; d < 3; d++) positions[(k * labels.length + m) * 3 + d] = Number(pt[d]);
    }));
    const rate = Number(raw.frame_rate) > 0 ? Number(raw.frame_rate) : 30;
    return markerData({ name: raw.name || fileName.replace(/\.[^.]+$/, ""), source: raw.source || "json", rate, firstFrame: Number(raw.first_frame) || 0, labels, positions });
  }

  function fromJSON(text, fileName = "") {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`Couldn't read this file as JSON: ${err.message}`);
    }
    if (raw.format === "hand-tracker-markers") return markersFromJSON(raw, fileName);
    if (Array.isArray(raw.hands)) {
      if (!raw.hands.every((h) => Array.isArray(h.frames))) throw new Error("This JSON has hands without frames.");
      return { data: raw, source: "json", warnings: [] };
    }
    if (Array.isArray(raw.frames)) {
      // Older single-hand files (before two-hand support); they were recorded at 640×480, mirrored.
      const hand = {
        handedness: raw.handedness || "Hand",
        frame_rate: raw.frame_rate,
        frames: raw.frames,
        trajectories: raw.trajectories || { end_effector: [], palm_orientation: [] },
        task_segments: raw.task_segments || [],
      };
      const out = finish([hand], [640, 480], true, [], [], raw);
      out.source = "json";
      out.warnings.push("Older single-hand recording: converted to the current two-hand layout.");
      return out;
    }
    throw new Error("This JSON isn't a Hand Tracker motion recording (no hands or frames).");
  }

  // ---------- Hands kept as points (C3D, TRC, marker CSV/JSON, GLB, BVH, NPZ) ----------
  // Hand Tracker's own exports name each hand's points L_wrist … R_pinky_tip (H0_… for
  // others). A recording with all 21 of a hand's points is turned back into that hand, so
  // it converts to every hand format again, BVH included. The points are millimetres, Z-up
  // (the C3D convention); in the app's image units they're scaled so the middle finger
  // (wrist to fingertip, at its longest) is CHAIN_UNITS long. Exporting scales it back to
  // the 190 mm average hand the exports use, so the app's own files come back exactly.
  const CHAIN_UNITS = 0.25;
  const addV = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const MIDDLE_CHAIN = [0, 9, 10, 11, 12];
  const HAND_NAMES = { L: "Left", R: "Right" };
  const fromZUp = (q) => [q[0], -q[2], q[1]]; // inverse of the exports' (x, z, -y)

  // handFrames: { prefix: [{ t, pts: 21 x [x, y, z] mm Z-up }] } -> hand recording, or null.
  function handsFromPointFrames(handFrames, source, notes, warnings) {
    const prefixes = Object.keys(handFrames).filter((p) => handFrames[p].length);
    if (!prefixes.length) return null;
    const chains = [];
    for (const p of prefixes) for (const f of handFrames[p]) {
      let l = 0;
      for (let k = 1; k < MIDDLE_CHAIN.length; k++) l += Math.hypot(...sub(f.pts[MIDDLE_CHAIN[k]], f.pts[MIDDLE_CHAIN[k - 1]]));
      chains.push(l);
    }
    chains.sort((a, b) => a - b);
    const mmPerUnit = Math.max(1e-6, chains[Math.floor(chains.length * 0.9)] / CHAIN_UNITS);
    const [iw, ih] = DEFAULT_IMAGE_SIZE;
    const aspect = ih / iw;
    const order = (p) => (p === "L" ? 0 : p === "R" ? 1 : 2);
    const hands = prefixes.sort((a, b) => order(a) - order(b)).map((p) => {
      const rows = handFrames[p].map((f) => {
        const W = f.pts.map((q) => fromZUp(q).map((v) => v / mmPerUnit));
        const w = W[0];
        return {
          t: f.t,
          joints: W.map((q) => [q[0] - w[0], (q[1] - w[1]) / aspect, q[2] - w[2]]),
          wrist: [w[0] + 0.5, w[1] / aspect + 0.5, w[2]],
          quat: null,
          phase: "idle",
          size: [iw, ih],
          real: null,
          distance: null,
        };
      });
      return buildHand(HAND_NAMES[p] || (p === "H0" ? "Hand" : `Hand ${Number(p.slice(1)) + 1}`), rows, warnings);
    });
    const out = finish(hands, DEFAULT_IMAGE_SIZE, true, notes, warnings);
    out.source = source;
    return out;
  }

  // A marker recording (mm, Z-up) holding Hand Tracker hands -> those hands, or null.
  function handsFromMarkers(md, fileName) {
    const index = new Map(md.labels.map((l, i) => [l, i]));
    const prefixes = md.labels.map((l) => (/^(L|R|H\d+)_wrist$/.exec(l) || [])[1]).filter((p) => p && JOINTS.every((j) => index.has(`${p}_${j}`)));
    if (!prefixes.length) return null;
    const handFrames = {};
    for (const p of prefixes) {
      const cols = JOINTS.map((j) => index.get(`${p}_${j}`));
      handFrames[p] = [];
      for (let k = 0; k < md.frame_count; k++) {
        const pts = cols.map((m) => {
          const i = (k * md.labels.length + m) * 3;
          return [md.positions[i], md.positions[i + 1], md.positions[i + 2]];
        });
        if (pts.every((q) => q.every(Number.isFinite))) handFrames[p].push({ t: k / md.frame_rate, pts });
      }
    }
    const kind = { c3d: "C3D", trc: "TRC", csv: "marker CSV", json: "marker JSON", glb: "GLB", bvh: "BVH", npz: "NPZ", mcap: "MCAP" }[md.source] || md.source;
    const other = md.labels.length - prefixes.length * 21;
    const warnings = [...(md.warnings || [])];
    if (other > 0) warnings.push(`${other} other point${other === 1 ? " was" : "s were"} left out: only the hands were kept.`);
    return handsFromPointFrames(handFrames, md.source, [`Imported from ${fileName || `a ${kind} file`}: Hand Tracker hands, rebuilt from their points (joint orientations, velocities and accelerations recalculated).`], warnings);
  }

  // ---------- MCAP ----------
  // Hand Tracker's own: the recording attached to it (hand_tracker.json), as it was. Otherwise
  // (another program's, or one a ROS tool rewrote without its attachments) every position in it
  // as a marker: each pose of a PoseArray (named from the channel's "labels" when it has them,
  // as Hand Tracker's do, else "<topic> 1", "<topic> 2"…), each PoseStamped and PointStamped,
  // put on frames at the busiest topic's rate. ROS axes (x forward, y left, z up, metres) become
  // Z-up millimetres (x right, y forward). useAttachment: false reads only the messages.
  function fromMCAP(buffer, fileName = "", { useAttachment = true } = {}) {
    if (!global.Mcap) throw new Error("MCAP files can't be read here (mcap.js is missing).");
    const file = Mcap.read(buffer);
    const own = useAttachment && file.attachments.find((a) => a.name === "hand_tracker.json");
    if (own) {
      const res = parse(new TextDecoder().decode(own.data), fileName.replace(/\.mcap$/i, ".json"));
      return asHandsIfAny(res, fileName);
    }
    const KINDS = /^geometry_msgs\/(msg\/)?(PoseArray|PoseStamped|PointStamped)$/;
    const channels = [...file.channels.values()].filter((c) => c.messageEncoding === "cdr" && c.schema && KINDS.test(c.schema.name));
    if (!channels.length) {
      const kinds = [...new Set([...file.channels.values()].map((c) => (c.schema ? c.schema.name : c.messageEncoding)))].join(", ");
      throw new Error(`${fileName || "This MCAP file"} holds no positions Hand Tracker can read (it reads PoseArray, PoseStamped and PointStamped messages)${kinds ? `: it has ${kinds}` : ""}.`);
    }
    const byChannel = new Map(channels.map((c) => [c.id, []]));
    // Times from when the take was recorded (Hand Tracker's say, in their metadata), else from
    // the first message.
    const recorded = Date.parse(((file.metadata.find((m) => m.name === "hand_tracker") || {}).metadata || {}).recorded_at);
    let t0 = Number.isFinite(recorded) ? BigInt(recorded) * 1000000n : null;
    for (const m of file.messages) {
      const list = byChannel.get(m.channel);
      if (!list) continue;
      const d = Mcap.cdr.decode(file.channels.get(m.channel).schema.name, m.data);
      if (!d) continue;
      if (t0 === null) t0 = m.logTime;
      list.push({ t: Number(m.logTime - t0) / 1e9, points: d.points });
    }
    const labelsOf = (c) => {
      try {
        return JSON.parse(c.metadata.labels || "null");
      } catch {
        return String(c.metadata.labels || "").split(",");
      }
    };
    // ROS (x forward, y left, z up; m) -> Z-up mm (x right, y forward).
    const zUp = (p) => [-p[1] * 1000, p[0] * 1000, p[2] * 1000];
    // Hand Tracker's hands (a topic per hand, its poses named "L_wrist", "L_thumb_cmc"…): rebuilt
    // on their messages' own times.
    const handFrames = {};
    for (const c of channels) {
      const named = labelsOf(c);
      const prefix = Array.isArray(named) && named.length === 21 && (/^(L|R|H\d+)_wrist$/.exec(named[0]) || [])[1];
      if (!prefix || !JOINTS.every((j, i) => named[i] === `${prefix}_${j}`)) continue;
      handFrames[prefix] = byChannel.get(c.id).filter((f) => f.points.length === 21 && f.points.every((p) => p.every(Number.isFinite))).map((f) => ({ t: f.t, pts: f.points.map(zUp) }));
    }
    const handTopics = Object.keys(handFrames).length;
    if (handTopics) {
      const others = channels.length - handTopics;
      const hands = handsFromPointFrames(handFrames, "mcap",
        [`Imported from ${fileName || "an MCAP file"}: Hand Tracker hands, rebuilt from their joint messages (joint orientations, velocities and accelerations recalculated).`],
        others ? [`${others} other topic${others === 1 ? " was" : "s were"} left out: only the hands were kept.`] : []);
      if (hands) return hands;
    }
    // Labels: each channel's points, in order.
    const labels = [], base = new Map();
    for (const c of channels) {
      const most = Math.max(0, ...byChannel.get(c.id).map((f) => f.points.length));
      const named = labelsOf(c);
      base.set(c.id, labels.length);
      const topic = c.topic.replace(/^\//, "");
      for (let i = 0; i < most; i++) labels.push(Array.isArray(named) && named.length === most && named[i] ? String(named[i]) : most === 1 ? topic : `${topic} ${i + 1}`);
    }
    // Frames at the busiest channel's rate (its median interval).
    const busiest = [...byChannel.values()].sort((a, b) => b.length - a.length)[0];
    const gaps = busiest.slice(1).map((f, i) => f.t - busiest[i].t).filter((d) => d > 0).sort((a, b) => a - b);
    const rate = gaps.length ? Math.min(1000, Math.max(1, Math.round(1 / gaps[Math.floor(gaps.length / 2)]))) : 30;
    const last = Math.max(0, ...[...byChannel.values()].map((l) => (l.length ? l[l.length - 1].t : 0)));
    const frameCount = Math.round(last * rate) + 1;
    const positions = new Float32Array(frameCount * labels.length * 3).fill(NaN);
    for (const [id, list] of byChannel) {
      for (const f of list) {
        const k = Math.min(frameCount - 1, Math.round(f.t * rate));
        f.points.forEach((p, i) => {
          if (!p.every(Number.isFinite)) return;
          positions.set(zUp(p), (k * labels.length + base.get(id) + i) * 3);
        });
      }
    }
    const notes = [`MCAP: ${channels.length} topic${channels.length === 1 ? "" : "s"} (${channels.map((c) => c.topic).join(", ")}), ${labels.length} point${labels.length === 1 ? "" : "s"} × ${frameCount} frames at ${rate} fps.`];
    return asHandsIfAny(markerData({ name: fileName.replace(/\.[^.]+$/, ""), source: "mcap", rate, firstFrame: 0, labels, positions, notes }), fileName);
  }

  // Any marker result: as hands when it holds Hand Tracker hands, else as it is.
  function asHandsIfAny(result, fileName) {
    if (!result || !result.data || result.data.kind !== "markers") return result;
    const hands = handsFromMarkers({ ...result.data, warnings: result.warnings }, fileName);
    return hands || result;
  }

  // ---------- BVH ----------
  // Skeleton animation (Blender, MotionBuilder, this app): each joint's position on every
  // frame comes from the skeleton's offsets and rotations; end sites are points too. BVH
  // has no units: read as centimetres (as this app writes it), Y-up.
  function fromBVH(text, fileName = "") {
    const tokens = text.split(/\s+/).filter(Boolean);
    let p = 0;
    const next = () => tokens[p++];
    const expect = (word) => {
      const got = next();
      if (!got || got.toUpperCase() !== word) throw new Error(`This BVH file is malformed (expected ${word}, found ${got || "the end"}).`);
    };
    if ((tokens[0] || "").toUpperCase() !== "HIERARCHY") throw new Error("This isn't a BVH file (it should start with HIERARCHY).");
    next();
    const joints = []; // depth-first: { name, parent, offset, channels, end }
    const readJoint = (name, parent, end) => {
      const j = { name, parent, offset: [0, 0, 0], channels: [], end };
      joints.push(j);
      expect("{");
      for (;;) {
        const word = (next() || "").toUpperCase();
        if (word === "OFFSET") j.offset = [Number(next()), Number(next()), Number(next())];
        else if (word === "CHANNELS") {
          const n = Number(next());
          for (let k = 0; k < n; k++) j.channels.push(next().toLowerCase());
        } else if (word === "JOINT") readJoint(next(), j, false);
        else if (word === "END") {
          next(); // "Site"
          readJoint(endName(j.name), j, true);
        } else if (word === "}") return;
        else throw new Error(`This BVH file is malformed (unexpected "${word}").`);
      }
    };
    // This app's end sites are the fingertips (L_index_dip -> L_index_tip).
    const endName = (parent) => {
      const m = /^(.*_)(thumb_ip|index_dip|middle_dip|ring_dip|pinky_dip)$/.exec(parent);
      return m ? `${m[1]}${m[2].replace(/_(ip|dip)$/, "_tip")}` : `${parent}_end`;
    };
    expect("ROOT");
    readJoint(next(), null, false);
    expect("MOTION");
    if (!/^frames:?$/i.test(next())) throw new Error("This BVH file is malformed (no Frames count).");
    const frames = Number(next());
    if (!/^frame$/i.test(next()) || !/^time:?$/i.test(next())) throw new Error("This BVH file is malformed (no Frame Time).");
    const frameTime = Number(next());
    if (!(frames >= 1) || !(frameTime > 0)) throw new Error("This BVH has no frames.");
    // Frame Time is written rounded (0.037037 for 27 fps): a rate a hair from a whole number is that number.
    const rawRate = 1 / frameTime;
    const rate = Math.abs(rawRate - Math.round(rawRate)) < 0.01 ? Math.round(rawRate) : rawRate;
    const perFrame = joints.reduce((n, j) => n + j.channels.length, 0);
    const available = Math.floor((tokens.length - p) / Math.max(1, perFrame));
    const warnings = ["BVH has no units: read as centimetres, Y-up (as Hand Tracker writes it)."];
    const count = Math.min(frames, available);
    if (count < frames) warnings.push(`The file ends early: ${count} of ${frames} frames could be read.`);

    const rot = (axis, deg) => {
      const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      if (axis === "x") return [1, 0, 0, 0, c, -s, 0, s, c];
      if (axis === "y") return [c, 0, s, 0, 1, 0, -s, 0, c];
      return [c, -s, 0, s, c, 0, 0, 0, 1];
    };
    const mm = (a, b) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]));
    const mv = (a, v) => [0, 1, 2].map((r) => a[r * 3] * v[0] + a[r * 3 + 1] * v[1] + a[r * 3 + 2] * v[2]);
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const labels = joints.map((j) => j.name);
    const positions = new Float32Array(count * joints.length * 3);
    const world = new Map();
    for (let k = 0; k < count; k++) {
      let c = p + k * perFrame;
      world.clear();
      joints.forEach((j, m) => {
        const local = [...j.offset];
        let R = I;
        for (const ch of j.channels) {
          const v = Number(tokens[c++]);
          if (ch.endsWith("position")) local["xyz".indexOf(ch[0])] += v;
          else R = mm(R, rot(ch[0], v));
        }
        const parent = j.parent ? world.get(j.parent) : { R: I, pos: [0, 0, 0] };
        const pos = addV(parent.pos, mv(parent.R, local));
        world.set(j, { R: mm(parent.R, R), pos });
        const i = (k * joints.length + m) * 3;
        // centimetres, Y-up -> millimetres, Z-up
        positions[i] = pos[0] * 10;
        positions[i + 1] = -pos[2] * 10;
        positions[i + 2] = pos[1] * 10;
      });
    }
    const md = markerData({
      name: fileName.replace(/\.[^.]+$/, ""), source: "bvh", rate, firstFrame: 0, labels, positions,
      notes: [`BVH: ${joints.length} joints and end sites × ${count} frames at ${rate.toFixed(2)} fps, as points.`], warnings,
    });
    return asHandsIfAny(md, fileName);
  }

  // ---------- NPZ (NumPy) ----------
  // Zip of .npy arrays: stored (numpy.savez, this app) or deflated (numpy.savez_compressed).
  async function unzip(buffer) {
    const u8 = new Uint8Array(buffer), dv = new DataView(buffer);
    let end = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error("This isn't an NPZ file (no zip directory found).");
    const count = dv.getUint16(end + 10, true);
    let c = dv.getUint32(end + 16, true);
    const files = {};
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(c, true) !== 0x02014b50) throw new Error("This NPZ file's zip directory is damaged.");
      const method = dv.getUint16(c + 10, true), packed = dv.getUint32(c + 20, true), size = dv.getUint32(c + 24, true);
      const nameLen = dv.getUint16(c + 28, true), extraLen = dv.getUint16(c + 30, true), commentLen = dv.getUint16(c + 32, true);
      const local = dv.getUint32(c + 42, true);
      const name = new TextDecoder().decode(u8.subarray(c + 46, c + 46 + nameLen));
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const raw = u8.subarray(start, start + packed);
      if (method === 0) files[name] = raw.slice(0, size);
      else if (method === 8 && global.DecompressionStream) {
        files[name] = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      } else throw new Error(`This NPZ file uses a compression this app can't read (method ${method}).`);
      c += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  // One .npy array -> { shape, data } (numbers in a plain array, or strings).
  function readNpy(bytes, name) {
    if (bytes[0] !== 0x93 || String.fromCharCode(...bytes.subarray(1, 6)) !== "NUMPY") throw new Error(`${name} isn't a NumPy array.`);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const major = bytes[6];
    const headerLen = major === 1 ? dv.getUint16(8, true) : dv.getUint32(8, true);
    const headerStart = major === 1 ? 10 : 12;
    const header = new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLen));
    const descr = (/'descr':\s*'([^']+)'/.exec(header) || [])[1];
    if (/'fortran_order':\s*True/.test(header)) throw new Error(`${name} is stored in Fortran order, which this app doesn't read.`);
    const shape = ((/'shape':\s*\(([^)]*)\)/.exec(header) || [])[1] || "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
    const n = shape.reduce((a, b) => a * b, 1);
    const at = headerStart + headerLen;
    const little = descr[0] !== ">";
    const kind = descr.slice(1);
    const read = { f4: [4, (o) => dv.getFloat32(o, little)], f8: [8, (o) => dv.getFloat64(o, little)], i4: [4, (o) => dv.getInt32(o, little)], i8: [8, (o) => Number(dv.getBigInt64(o, little))],
      i2: [2, (o) => dv.getInt16(o, little)], i1: [1, (o) => dv.getInt8(o)], u1: [1, (o) => dv.getUint8(o)], b1: [1, (o) => dv.getUint8(o)], u4: [4, (o) => dv.getUint32(o, little)] }[kind];
    if (read) return { shape, data: Array.from({ length: n }, (_, i) => read[1](at + i * read[0])) };
    if (kind[0] === "U") {
      const width = Number(kind.slice(1));
      return { shape, data: Array.from({ length: n }, (_, i) => {
        let s = "";
        for (let k = 0; k < width; k++) {
          const code = dv.getUint32(at + (i * width + k) * 4, little);
          if (!code) break;
          s += String.fromCodePoint(code);
        }
        return s;
      }) };
    }
    throw new Error(`${name} holds ${descr} values, which this app doesn't read.`);
  }

  async function fromNPZ(buffer, fileName = "") {
    const files = await unzip(buffer);
    const arrays = {};
    for (const [name, bytes] of Object.entries(files)) {
      if (!/\.npy$/i.test(name)) continue;
      try {
        arrays[name.replace(/\.npy$/i, "")] = readNpy(bytes, name);
      } catch {
        // an array of a kind this app doesn't read: left out
      }
    }
    const one = (name, fallback) => (arrays[name] && arrays[name].data.length ? arrays[name].data[0] : fallback);
    const warnings = [];
    // Hand Tracker's hand NPZ: <hand>_t, <hand>_joints (n, 21, 3), <hand>_wrist, <hand>_palm_quat, <hand>_phase…
    const handKeys = Object.keys(arrays).filter((k) => /_joints$/.test(k) && !/_real_joints$/.test(k) && arrays[k].shape.join() === `${arrays[k].shape[0]},21,3` && arrays[k.replace(/_joints$/, "_t")]);
    if (handKeys.length) {
      const phases = arrays.phase_names ? arrays.phase_names.data : ["idle", "reach", "grasp", "manipulate", "release"];
      const imageSize = arrays.image_size && arrays.image_size.data.length === 2 ? arrays.image_size.data.map(Number) : DEFAULT_IMAGE_SIZE;
      const order = (k) => (k === "left_joints" ? 0 : k === "right_joints" ? 1 : 2);
      const hands = handKeys.sort((a, b) => order(a) - order(b)).map((jk) => {
        const key = jk.replace(/_joints$/, "");
        const get = (suffix) => arrays[`${key}_${suffix}`];
        const t = get("t").data, J = get("joints").data, W = get("wrist"), Q = get("palm_quat"), P = get("phase"), R = get("real_joints"), D = get("distance_mm");
        const rows = t.map((ti, i) => {
          const real = R ? Array.from({ length: 21 }, (_, j) => R.data.slice((i * 21 + j) * 3, (i * 21 + j) * 3 + 3)) : null;
          const distance = D ? D.data.slice(i * 3, i * 3 + 3) : null;
          return {
            t: ti,
            joints: Array.from({ length: 21 }, (_, j) => J.slice((i * 21 + j) * 3, (i * 21 + j) * 3 + 3)),
            wrist: W ? W.data.slice(i * 3, i * 3 + 3) : null,
            quat: Q ? Q.data.slice(i * 4, i * 4 + 4) : null,
            phase: P ? phases[P.data[i]] || "idle" : "idle",
            size: imageSize,
            real: real && real.every((p) => p.every(Number.isFinite)) ? real : null,
            distance: distance && distance.every(Number.isFinite) ? distance : null,
          };
        });
        const name = key === "left" ? "Left" : key === "right" ? "Right" : key.charAt(0).toUpperCase() + key.slice(1);
        return buildHand(name, rows, warnings);
      });
      const out = finish(hands, imageSize, true, [`Imported from ${fileName || "an NPZ file"}: joint orientations, velocities and accelerations were recalculated from the positions.`], warnings);
      out.source = "npz";
      return out;
    }
    // Points: Hand Tracker's marker NPZ (positions, labels…), or any (frames, points, 3) array.
    const name = arrays.positions && arrays.positions.shape.length === 3 && arrays.positions.shape[2] === 3
      ? "positions"
      : Object.keys(arrays).find((k) => arrays[k].shape.length === 3 && arrays[k].shape[2] === 3 && typeof arrays[k].data[0] === "number");
    if (!name) throw new Error("This NPZ doesn't hold motion capture this viewer recognises: Hand Tracker's hand or marker NPZ, or an array of point positions shaped (frames, points, 3).");
    const [frames, count] = arrays[name].shape;
    const labels = arrays.labels && arrays.labels.data.length === count ? arrays.labels.data : Array.from({ length: count }, (_, i) => `${name}_${i + 1}`);
    const t = arrays.t && arrays.t.data.length === frames ? arrays.t.data : null;
    const rate = Number(one("frame_rate", one("fps", 0))) || (t && t.length > 1 ? 1 / (t[1] - t[0]) : 30);
    const units = String(one("units", "mm")).toLowerCase();
    const toMM = { mm: 1, cm: 10, m: 1000 }[units] || 1;
    const yUp = String(one("up_axis", "z")).toLowerCase() === "y";
    const v = arrays[name].data;
    const positions = new Float32Array(frames * count * 3);
    for (let i = 0; i < frames * count; i++) {
      const x = v[i * 3] * toMM, y = v[i * 3 + 1] * toMM, z = v[i * 3 + 2] * toMM;
      positions[i * 3] = x;
      positions[i * 3 + 1] = yUp ? -z : y;
      positions[i * 3 + 2] = yUp ? y : z;
    }
    if (name !== "positions") warnings.push(`Read the array "${name}" as ${count} points over ${frames} frames (${units}, ${yUp ? "Y" : "Z"}-up).`);
    const md = markerData({ name: fileName.replace(/\.[^.]+$/, ""), source: "npz", rate, firstFrame: 0, labels, positions, notes: [`NPZ: ${count} points × ${frames} frames at ${rate.toFixed(2)} fps.`], warnings });
    return asHandsIfAny(md, fileName);
  }

  // ---------- GLB (glTF 2.0 binary) ----------
  // Points animated by position (Hand Tracker's hand and marker GLBs, and other GLBs that
  // animate their nodes' translation), in metres, Y-up.
  function fromGLB(buffer, fileName = "") {
    const dv = new DataView(buffer);
    if (buffer.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error("This isn't a GLB file (the glTF signature is missing).");
    let o = 12, gltf = null, bin = null;
    while (o + 8 <= buffer.byteLength) {
      const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
      if (type === 0x4e4f534a) gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, o + 8, len)));
      else if (type === 0x004e4942) bin = new DataView(buffer, o + 8, len);
      o += 8 + len;
    }
    if (!gltf || !bin) throw new Error("This GLB file is incomplete (no JSON or binary part).");
    const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
    const accessor = (i) => {
      const a = gltf.accessors[i], view = gltf.bufferViews[a.bufferView];
      if (a.componentType !== 5126) throw new Error("This GLB's animation isn't stored as floats, which this app doesn't read.");
      const w = width[a.type], stride = view.byteStride || w * 4, base = (view.byteOffset || 0) + (a.byteOffset || 0);
      return Array.from({ length: a.count }, (_, k) => Array.from({ length: w }, (_, c) => bin.getFloat32(base + k * stride + c * 4, true)));
    };
    const nodes = gltf.nodes || [];
    const parent = new Map();
    nodes.forEach((n, i) => (n.children || []).forEach((c) => parent.set(c, i)));
    // Each node's still placement (its parents' translation, rotation and scale), as a matrix.
    const trs = (n) => {
      if (n.matrix) return n.matrix;
      const [x, y, z, w] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1], t = n.translation || [0, 0, 0];
      return [
        (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
        2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
        2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
        t[0], t[1], t[2], 1,
      ];
    };
    const mul4 = (a, b) => Array.from({ length: 16 }, (_, i) => { const c = Math.floor(i / 4), r = i % 4; let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; return s; });
    const parentMatrix = (i) => {
      let m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      // A parent's scale is often its visibility (0 while hidden): use its placement without it.
      for (let p = parent.get(i); p !== undefined; p = parent.get(p)) m = mul4(trs({ ...nodes[p], scale: [1, 1, 1] }), m);
      return m;
    };
    const apply = (m, v) => [0, 1, 2].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r]);

    const tracks = []; // { name, times, values }
    for (const anim of gltf.animations || []) {
      for (const ch of anim.channels || []) {
        const node = ch.target && ch.target.node;
        if (ch.target.path !== "translation" || node === undefined) continue;
        const name = nodes[node].name || `node ${node}`;
        if (/-/.test(name) && /_(cmc|mcp|pip|dip|ip|tip|wrist)-/.test(name)) continue; // this app's bone pieces
        const s = anim.samplers[ch.sampler];
        const m = parentMatrix(node);
        tracks.push({ name, times: accessor(s.input).map((v) => v[0]), values: accessor(s.output).map((v) => apply(m, v)) });
      }
    }
    if (!tracks.length) throw new Error("This GLB has no points animated by position, which is what this viewer reads (Hand Tracker's GLB exports, and other GLBs that move their nodes).");
    // metres, Y-up -> millimetres, Z-up
    const toMM = (v) => [v[0] * 1000, -v[2] * 1000, v[1] * 1000];
    // Hand Tracker hands: each hand's 21 joints share their frame times.
    const byName = new Map(tracks.map((t) => [t.name, t]));
    const prefixes = tracks.map((t) => (/^(L|R|H\d+)_wrist$/.exec(t.name) || [])[1]).filter((p) => p && JOINTS.every((j) => byName.has(`${p}_${j}`)));
    if (prefixes.length) {
      const handFrames = {};
      for (const p of prefixes) {
        const T = JOINTS.map((j) => byName.get(`${p}_${j}`));
        handFrames[p] = T[0].times.map((t, k) => ({ t, pts: T.map((tr) => toMM(tr.values[Math.min(k, tr.values.length - 1)])) }));
      }
      return handsFromPointFrames(handFrames, "glb", [`Imported from ${fileName || "a GLB file"}: Hand Tracker hands, rebuilt from their animated joints (joint orientations, velocities and accelerations recalculated).`], []);
    }
    // Other points: on one timeline at the most common spacing of their keys.
    const allTimes = [...new Set(tracks.flatMap((t) => t.times.map((x) => Math.round(x * 1e5) / 1e5)))].sort((a, b) => a - b);
    const gaps = allTimes.slice(1).map((x, k) => x - allTimes[k]).filter((d) => d > 1e-6).sort((a, b) => a - b);
    const rate = gaps.length ? Math.round(1000 / gaps[Math.floor(gaps.length / 2)]) / 1000 : 30;
    const t0 = allTimes[0];
    const frames = Math.round((allTimes[allTimes.length - 1] - t0) * rate) + 1;
    const positions = new Float32Array(frames * tracks.length * 3).fill(NaN);
    tracks.forEach((tr, m) => tr.times.forEach((t, k) => {
      const f = Math.round((t - t0) * rate);
      if (f >= 0 && f < frames) positions.set(toMM(tr.values[k]), (f * tracks.length + m) * 3);
    }));
    return markerData({ name: fileName.replace(/\.[^.]+$/, ""), source: "glb", rate, firstFrame: 0, labels: tracks.map((t) => t.name), positions,
      notes: [`GLB: ${tracks.length} animated points × ${frames} frames at ${rate} fps.`] });
  }

  function parse(text, fileName = "") {
    const clean = String(text).replace(/^﻿/, ""); // byte-order mark from spreadsheets
    const ext = (fileName.match(/\.([a-z0-9]+)$/i) || [])[1];
    const looksJSON = ext ? ext.toLowerCase() === "json" : /^\s*[{[]/.test(clean);
    return looksJSON ? fromJSON(clean, fileName) : fromCSV(clean, fileName);
  }

  // Any supported file, as bytes: C3D and GLB are binary, the rest is text. Points that are
  // Hand Tracker hands (its own C3D, TRC, GLB, BVH… exports) come back as hands.
  function parseFile(fileName, buffer) {
    const ext = ((fileName.match(/\.([a-z0-9]+)$/i) || [])[1] || "").toLowerCase();
    const u8 = new Uint8Array(buffer);
    if (ext === "npz") throw new Error("NPZ files are read with parseFileAsync.");
    if (ext === "mcap" || (u8.length > 8 && u8[0] === 0x89 && u8[1] === 0x4d && u8[2] === 0x43 && u8[3] === 0x41 && u8[4] === 0x50)) return fromMCAP(buffer, fileName);
    if (ext === "glb" || (u8.length > 12 && new DataView(buffer).getUint32(0, true) === 0x46546c67)) return fromGLB(buffer, fileName);
    if (ext === "c3d" || (!ext && u8.length > 1024 && u8[1] === 0x50)) return asHandsIfAny(fromC3D(buffer, fileName), fileName);
    const text = new TextDecoder().decode(u8).replace(/^\uFEFF/, "");
    if (ext === "trc" || /^PathFileType/i.test(text)) return asHandsIfAny(fromTRC(text, fileName), fileName);
    if (ext === "bvh" || /^\s*HIERARCHY/.test(text)) return fromBVH(text, fileName);
    return asHandsIfAny(parse(text, fileName), fileName);
  }

  // The same, for every format including NPZ (whose compressed form needs async unpacking).
  async function parseFileAsync(fileName, buffer) {
    const u8 = new Uint8Array(buffer);
    const isZip = u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 3 && u8[3] === 4;
    if (/\.npz$/i.test(fileName) || isZip) return fromNPZ(buffer, fileName);
    return parseFile(fileName, buffer);
  }

  // Every motion capture file this module reads, by extension.
  const EXTENSIONS = ["json", "csv", "c3d", "trc", "bvh", "npz", "glb", "mcap"];

  global.MotionImport = { parse, parseFile, parseFileAsync, fromC3D, fromTRC, fromBVH, fromNPZ, fromGLB, fromMCAP, EXTENSIONS };
})(window);
