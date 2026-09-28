/**
 * motion-validators.js — independent readers used by check.js to verify the
 * motion capture exports. They re-derive what each file should contain from
 * the JSON recording (or cross-check files against each other) rather than
 * reusing motion-export.js, so a bug in the exporter can't hide itself.
 */

const fs = require("fs");
const { spawnSync } = require("child_process");

const JOINTS = [
  "wrist",
  "thumb_cmc", "thumb_mcp", "thumb_ip", "thumb_tip",
  "index_mcp", "index_pip", "index_dip", "index_tip",
  "middle_mcp", "middle_pip", "middle_dip", "middle_tip",
  "ring_mcp", "ring_pip", "ring_dip", "ring_tip",
  "pinky_mcp", "pinky_pip", "pinky_dip", "pinky_tip",
];
const TIPS = new Set([4, 8, 12, 16, 20]);
const MAX_GAP_S = 0.25; // documented rule: across longer gaps a hand isn't interpolated (BVH holds the nearest pose)

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const len = (a) => Math.hypot(...a);
const angleDeg = (a, b) => (Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (len(a) * len(b) || 1)))) * 180) / Math.PI;

// ---------- expected positions from the JSON recording ----------
// Isotropic image axes (x right, y down, z away), converted to Y-up (x, -y, -z).
function expectedPose(data, hand, t) {
  const [w, h] = data.image_size;
  const aspect = h / w;
  const frames = hand.frames;
  const ee = hand.trajectories.end_effector;
  const at = (i) =>
    frames[i].joints.map((j) => {
      const e = ee[i];
      return [e[1] - 0.5 + j.position[0], (e[2] - 0.5 + j.position[1]) * aspect, e[3] + j.position[2]];
    });
  let pose;
  if (t <= frames[0].t) pose = at(0);
  else if (t >= frames[frames.length - 1].t) pose = at(frames.length - 1);
  else {
    let i = 0;
    while (frames[i + 1].t < t) i++;
    const span = frames[i + 1].t - frames[i].t;
    if (span > MAX_GAP_S) pose = at(t - frames[i].t < frames[i + 1].t - t ? i : i + 1);
    else {
      const u = (t - frames[i].t) / span;
      const a = at(i), b = at(i + 1);
      pose = a.map((p, k) => p.map((v, d) => v + (b[k][d] - v) * u));
    }
  }
  return pose.map((p) => [p[0], -p[1], -p[2]]);
}

// ---------- CSV ----------
function checkCSV(file, data) {
  const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  const header = lines[0].split(",");
  const rows = lines.slice(1).map((l) => l.split(","));
  const frames = data.hands.reduce((n, h) => n + h.frames.length, 0);
  const numeric = rows.every((r) => r.length === header.length && r.slice(4).every((v) => Number.isFinite(Number(v))));
  // Spot-check one value against the JSON.
  const left = data.hands.find((h) => h.handedness === "Left");
  const row = rows.find((r) => r[0] === "Left" && r[1] === "3");
  const col = header.indexOf("index_tip_y");
  const same = !!row && Math.abs(Number(row[col]) - left.frames[3].joints[8].position[1]) < 1e-5;
  const iw = header.indexOf("image_width");
  const sized = iw === 11 + 63 && header[iw + 1] === "image_height" && rows.every((r) => `${r[iw]}x${r[iw + 1]}` === data.image_size.join("x"));
  // The hand's real shape (metres), when recorded: 63 more columns, matching the JSON.
  const hasReal = data.hands.some((h) => h.frames.some((f) => f.world_joints));
  const realCol = header.indexOf("index_tip_real_y");
  const realSame = !hasReal || (!!row && realCol > 0 && Math.abs(Number(row[realCol]) - left.frames[3].world_joints[8][1]) < 1e-5);
  const columns = 11 + 63 + 2 + (hasReal ? 63 : 0);
  return {
    ok: header.length === columns && sized && rows.length === frames && numeric && same && realSame,
    detail: `${rows.length} rows × ${header.length} columns${hasReal ? " (with real-size joints)" : ""}`,
  };
}

// ---------- BVH: parse + forward kinematics ----------
function parseBVH(text) {
  const tok = text.split(/\s+/).filter(Boolean);
  let i = 0;
  const joints = [];
  const stack = [];
  while (tok[i] !== "MOTION") {
    const t = tok[i++];
    if (t === "ROOT" || t === "JOINT") {
      joints.push({ name: tok[i++], parent: stack.length ? stack[stack.length - 1] : -1, offset: null, channels: [], end: null });
      stack.push(joints.length - 1);
    } else if (t === "End") {
      i += 3; // Site { OFFSET
      joints[stack[stack.length - 1]].end = [tok[i++], tok[i++], tok[i++]].map(Number);
      i++; // }
    } else if (t === "OFFSET") joints[stack[stack.length - 1]].offset = [tok[i++], tok[i++], tok[i++]].map(Number);
    else if (t === "CHANNELS") {
      const n = Number(tok[i++]);
      joints[stack[stack.length - 1]].channels = tok.slice(i, i + n);
      i += n;
    } else if (t === "}") stack.pop();
  }
  i += 2; // MOTION Frames:
  const nFrames = Number(tok[i++]);
  i += 2; // Frame Time:
  const frameTime = Number(tok[i++]);
  const nCh = joints.reduce((n, j) => n + j.channels.length, 0);
  const frames = [];
  for (let f = 0; f < nFrames; f++, i += nCh) frames.push(tok.slice(i, i + nCh).map(Number));
  return { joints, frames, frameTime };
}

const matMul = (A, B) => A.map((r) => [0, 1, 2].map((c) => r[0] * B[0][c] + r[1] * B[1][c] + r[2] * B[2][c]));
const matVec = (A, v) => A.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
function rot(axis, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  if (axis === "X") return [[1, 0, 0], [0, c, -s], [0, s, c]];
  if (axis === "Y") return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}

// World position of every joint (and end sites) for one frame; channels apply in listed order.
function forwardKinematics(bvh, values) {
  const G = [], P = [], ends = [];
  let c = 0;
  bvh.joints.forEach((j, idx) => {
    let R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const T = [0, 0, 0];
    for (const ch of j.channels) {
      const v = values[c++];
      if (ch.endsWith("position")) T["XYZ".indexOf(ch[0])] = v;
      else R = matMul(R, rot(ch[0], v));
    }
    if (j.parent < 0) {
      G[idx] = R;
      P[idx] = add(j.offset, T);
    } else {
      G[idx] = matMul(G[j.parent], R);
      P[idx] = add(P[j.parent], matVec(G[j.parent], j.offset));
    }
    if (j.end) ends[idx] = add(P[idx], matVec(G[idx], j.end));
  });
  return { P, ends };
}

// Replays the BVH and compares every bone's direction with the recording.
function checkBVH(file, data, handName) {
  const bvh = parseBVH(fs.readFileSync(file, "utf8"));
  const hand = data.hands.find((h) => h.handedness === handName);
  const prefix = handName[0];
  const index = (name) => bvh.joints.findIndex((j) => j.name === `${prefix}_${name}`);
  let worstFinger = 0, worstPalm = 0;
  bvh.frames.forEach((values, f) => {
    const { P, ends } = forwardKinematics(bvh, values);
    const pos = (lm) => (TIPS.has(lm) ? ends[index(JOINTS[lm - 1])] : P[index(JOINTS[lm])]);
    const expected = expectedPose(data, hand, f * bvh.frameTime);
    for (let lm = 1; lm < 21; lm++) {
      if (TIPS.has(lm)) continue;
      worstFinger = Math.max(worstFinger, angleDeg(sub(pos(lm + 1), pos(lm)), sub(expected[lm + 1], expected[lm])));
    }
    for (const mcp of [1, 5, 9, 13, 17]) worstPalm = Math.max(worstPalm, angleDeg(sub(pos(mcp), pos(0)), sub(expected[mcp], expected[0])));
  });
  return {
    ok: bvh.joints.length === 16 && bvh.frames.length > 10 && worstFinger < 0.5 && worstPalm < 3,
    detail: `${bvh.joints.length} joints, ${bvh.frames.length} frames; worst bone direction error ${worstFinger.toFixed(3)}° (fingers), ${worstPalm.toFixed(3)}° (palm)`,
  };
}

// ---------- TRC ----------
function parseTRC(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const [rate, , nFrames, nMarkers, units] = lines[2].split("\t");
  const labels = lines[3].split("\t").slice(2).filter(Boolean);
  const rows = lines
    .slice(6)
    .filter((l) => l.trim())
    .map((l) => {
      const cells = l.split("\t");
      return { t: Number(cells[1]), values: cells.slice(2).map((v) => (v === "" ? null : Number(v))) };
    });
  return { rate: Number(rate), nFrames: Number(nFrames), nMarkers: Number(nMarkers), units, labels, rows };
}

function checkTRC(trc) {
  const shaped = trc.rows.length === trc.nFrames && trc.rows.every((r) => r.values.length === trc.nMarkers * 3);
  return { ok: shaped && trc.labels.length === trc.nMarkers && trc.units === "mm", detail: `${trc.nMarkers} markers × ${trc.nFrames} frames at ${trc.rate} fps, ${trc.units}` };
}

// ---------- C3D (read straight from the spec) ----------
function readC3D(file) {
  const b = fs.readFileSync(file);
  if (b[1] !== 0x50) throw new Error("bad C3D key");
  const header = {
    paramBlock: b[0],
    points: b.readUInt16LE(2),
    first: b.readUInt16LE(6),
    last: b.readUInt16LE(8),
    scale: b.readFloatLE(12),
    dataStart: b.readUInt16LE(16),
    rate: b.readFloatLE(20),
  };
  const params = {};
  const groups = {};
  let p = (header.paramBlock - 1) * 512 + 4;
  for (;;) {
    const nameLen = Math.abs(b.readInt8(p));
    const id = b.readInt8(p + 1);
    if (nameLen === 0 || id === 0) break;
    const name = b.toString("latin1", p + 2, p + 2 + nameLen);
    const offsetPos = p + 2 + nameLen;
    const next = offsetPos + b.readInt16LE(offsetPos);
    if (id < 0) groups[-id] = name;
    else {
      let q = offsetPos + 2;
      const type = b.readInt8(q++);
      const dims = Array.from({ length: b[q++] }, () => b[q++]);
      const count = dims.reduce((a, d) => a * d, 1);
      let value;
      if (type === -1) {
        const width = dims[0] || 1;
        const text = b.toString("latin1", q, q + count);
        value = dims.length > 1 ? Array.from({ length: count / width }, (_, k) => text.slice(k * width, (k + 1) * width).trim()) : text.trim();
      } else if (type === 2) value = Array.from({ length: count }, (_, k) => b.readInt16LE(q + 2 * k));
      else if (type === 4) value = Array.from({ length: count }, (_, k) => b.readFloatLE(q + 4 * k));
      params[`${id}:${name}`] = value;
    }
    if (next === offsetPos) break;
    p = next;
  }
  const named = {};
  for (const [key, v] of Object.entries(params)) {
    const [gid, name] = key.split(":");
    named[`${groups[gid]}:${name}`] = Array.isArray(v) && v.length === 1 ? v[0] : v;
  }
  const nFrames = header.last - header.first + 1;
  const data = [];
  let o = (header.dataStart - 1) * 512;
  for (let f = 0; f < nFrames; f++) {
    const frame = [];
    for (let k = 0; k < header.points; k++, o += 16) frame.push([b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8), b.readFloatLE(o + 12)]);
    data.push(frame);
  }
  return { header, params: named, data };
}

// C3D is Z-up, TRC is Y-up: C3D (X, Y, Z) must equal TRC (X, -Z, Y) for every marker and frame.
function checkC3D(file, trc) {
  const c3d = readC3D(file);
  const P = c3d.params;
  let worst = 0, missingMatch = true;
  c3d.data.forEach((frame, f) => {
    frame.forEach(([x, y, z, residual], k) => {
      const t = trc.rows[f].values.slice(k * 3, k * 3 + 3);
      if (t[0] === null) missingMatch = missingMatch && residual < 0;
      else {
        missingMatch = missingMatch && residual >= 0;
        worst = Math.max(worst, Math.abs(x - t[0]), Math.abs(y + t[2]), Math.abs(z - t[1]));
      }
    });
  });
  const ok =
    P["POINT:USED"] === c3d.header.points &&
    P["POINT:DATA_START"] === c3d.header.dataStart &&
    P["POINT:UNITS"] === "mm" &&
    Math.abs(P["POINT:RATE"] - trc.rate) < 1e-3 &&
    JSON.stringify(P["POINT:LABELS"]) === JSON.stringify(trc.labels) &&
    c3d.data.length === trc.nFrames &&
    missingMatch &&
    worst < 0.01;
  return { ok, detail: `${c3d.header.points} points × ${c3d.data.length} frames at ${c3d.header.rate} fps; max difference from TRC ${worst.toFixed(4)} mm` };
}

// ---------- NPZ (loaded with real NumPy) ----------
const NPZ_CHECK = `
import sys, json, numpy as np
npz = np.load(sys.argv[1]); data = json.load(open(sys.argv[2]))
out = {"keys": sorted(npz.files), "joint_names": npz["joint_names"].tolist(), "hands": {}}
for h in data["hands"]:
    k = h["handedness"].lower()
    J = npz[k + "_joints"]
    exp = np.array([[j["position"] for j in f["joints"]] for f in h["frames"]], dtype=np.float32)
    out["hands"][k] = {"shape": list(J.shape), "max_diff": float(np.abs(J - exp).max()),
        "t_ok": bool(np.allclose(npz[k + "_t"], [f["t"] for f in h["frames"]])),
        "quat_shape": list(npz[k + "_palm_quat"].shape), "phase_len": int(npz[k + "_phase"].shape[0])}
    if any("world_joints" in f for f in h["frames"]):
        R = npz[k + "_real_joints"]
        exp = np.array([f.get("world_joints", [[np.nan] * 3] * 21) for f in h["frames"]], dtype=np.float32)
        out["hands"][k]["real_diff"] = float(np.nanmax(np.abs(R - exp)))
print(json.dumps(out))
`;

function checkNPZ(file, jsonFile, data) {
  const run = spawnSync("python", ["-c", NPZ_CHECK, file, jsonFile], { encoding: "utf8" });
  if (run.status !== 0) return { ok: false, detail: (run.stderr || run.error || "python failed").toString().slice(-300) };
  const out = JSON.parse(run.stdout);
  const ok =
    out.joint_names.length === 21 &&
    data.hands.every((h) => {
      const r = out.hands[h.handedness.toLowerCase()];
      const real = !h.frames.some((f) => f.world_joints) || (r && r.real_diff !== undefined && r.real_diff < 1e-6);
      return r && r.shape.join() === `${h.frames.length},21,3` && r.max_diff < 1e-6 && r.t_ok && r.quat_shape[1] === 4 && r.phase_len === h.frames.length && real;
    });
  return { ok, detail: `${out.keys.length} arrays; ${Object.entries(out.hands).map(([k, r]) => `${k}_joints ${r.shape.join("×")}`).join(", ")}` };
}

module.exports = { checkCSV, checkBVH, parseTRC, checkTRC, checkC3D, checkNPZ, readC3D };
