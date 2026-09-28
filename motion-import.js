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

  function parse(text, fileName = "") {
    const clean = String(text).replace(/^﻿/, ""); // byte-order mark from spreadsheets
    const ext = (fileName.match(/\.([a-z0-9]+)$/i) || [])[1];
    const looksJSON = ext ? ext.toLowerCase() === "json" : /^\s*[{[]/.test(clean);
    return looksJSON ? fromJSON(clean, fileName) : fromCSV(clean, fileName);
  }

  // Any supported file, as bytes: C3D is binary, the rest is text.
  function parseFile(fileName, buffer) {
    const ext = ((fileName.match(/\.([a-z0-9]+)$/i) || [])[1] || "").toLowerCase();
    const u8 = new Uint8Array(buffer);
    if (ext === "c3d" || (!ext && u8.length > 1024 && u8[1] === 0x50)) return fromC3D(buffer, fileName);
    const text = new TextDecoder().decode(u8).replace(/^\uFEFF/, "");
    if (ext === "trc" || /^PathFileType/i.test(text)) return fromTRC(text, fileName);
    return parse(text, fileName);
  }

  global.MotionImport = { parse, parseFile, fromC3D, fromTRC };
})(window);
