// check-oak.js — OAK camera support on this computer, without a camera: runs the real
// one-time setup (electron/oak.js: uv, a private Python with depthai, OpenCV and NumPy, the
// camera models) into an empty folder, then checks that it reports ready, that depthai can
// look for cameras, and that the helper streams frames (its simulated camera: a moving hand).
// GitHub runs it on Linux PCs and 64-bit ARM (.github/workflows/check-oak.yml).
//
//   node scripts/check-oak.js [folder]     (default: a new temporary folder)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { OakCamera } = require("../electron/oak.js");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

(async () => {
  const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "hand-tracker-oak-"));
  const oak = new OakCamera(dir);
  console.log(`${process.platform}-${process.arch}, into ${dir}`);

  const before = await oak.status();
  check("Before the setup it says a setup is needed", !before.ready && /setup/.test(before.reason || ""), before.reason);

  const started = Date.now();
  let lines = 0;
  try {
    await oak.setup((line) => {
      lines++;
      if (!/^\s+\d+% of/.test(line)) console.log(`      ${line}`);
    });
  } catch (err) {
    check("The one-time setup finishes", false, err.message);
  }
  const after = await oak.status();
  check("The one-time setup finishes and it's ready (depthai 2, Python 3.12)",
    after.ready && /^2\./.test(after.versions.depthai) && /^3\.12\./.test(after.versions.python),
    after.ready ? `depthai ${after.versions.depthai}, OpenCV ${after.versions.opencv}, NumPy ${after.versions.numpy}, Python ${after.versions.python}; ${Math.round((Date.now() - started) / 1000)} s, ${lines} progress lines` : after.reason);

  // The faster (6-core) hand models: downloaded and checked as a camera's first start does, and
  // each one taking and giving the very same as its 4-core model (what HandTrackerEdge reads).
  const said = [];
  const fast = await oak.fastModels((m) => said.push(m.message)).catch((err) => (said.push(err.message), false));
  const { spawnSync } = require("child_process");
  const shapes = spawnSync(oak.paths.python, ["-c", `
import depthai as dai, json, sys
out = {}
for f in sys.argv[1:]:
    b = dai.OpenVINO.Blob(f)
    out[f.split("/")[-1].split("\\\\")[-1]] = {"shaves": b.numShaves, "in": {n: [t.dims, str(t.dataType)] for n, t in b.networkInputs.items()},
        "out": {n: [t.dims, str(t.dataType)] for n, t in b.networkOutputs.items()}}
print(json.dumps(out))`, ...["palm_detection", "hand_landmark_full", "hand_landmark_lite"].flatMap((m) => [4, 6].map((n) => path.join(oak.paths.models, `${m}_sh${n}.blob`)))], { encoding: "utf8" });
  let blobs = {};
  try {
    blobs = JSON.parse(shapes.stdout);
  } catch {}
  const same = ["palm_detection", "hand_landmark_full", "hand_landmark_lite"].every((m) => {
    const a = blobs[`${m}_sh4.blob`], b = blobs[`${m}_sh6.blob`];
    return a && b && a.shaves === 4 && b.shaves === 6 && JSON.stringify(a.in) === JSON.stringify(b.in) && JSON.stringify(a.out) === JSON.stringify(b.out);
  });
  check("The faster hand models download (checked), and each takes and gives the very same as its 4-core model, with 6 of the camera's cores",
    fast === true && same, JSON.stringify({ fast, said, blobs: same ? Object.keys(blobs) : blobs, err: shapes.stderr && shapes.stderr.slice(-300) }));

  // depthai looks for cameras over USB (and the network): none here, but it must be able to look.
  const list = await oak.runBridge(["--list"]).catch((err) => ({ status: "error", message: err.message }));
  check("depthai can look for OAK cameras", list.status === "devices" && Array.isArray(list.devices), JSON.stringify(list));

  // The helper's stream, from its simulated camera: frames with a hand and a JPEG picture.
  const frames = await new Promise((resolve) => {
    const got = [];
    const timer = setTimeout(() => oak.stop(), 30000);
    oak.start({ simulate: true, lm: "lite" }, (msg) => {
      if (msg.frame) {
        got.push(msg);
        if (got.length === 30) oak.stop();
      } else if (msg.status === "stopped") {
        clearTimeout(timer);
        resolve(got);
      }
    });
  });
  const first = frames[0];
  check("The OAK helper streams frames with hands and pictures (simulated camera)",
    frames.length >= 30 && frames.every((f) => f.frame.hands.length === 1 && f.frame.hands[0].lm.length === 21) &&
      first.jpeg && first.jpeg[0] === 0xff && first.jpeg[1] === 0xd8,
    `${frames.length} frames, ${first ? `${first.frame.w}x${first.frame.h}, JPEG ${first.jpeg ? first.jpeg.length : 0} bytes` : "none"}`);

  // With Find objects, Sentry mode's motion and the depth picture (simulated: a cat walking
  // along the bottom and a person standing still).
  const extra = await new Promise((resolve) => {
    const got = [];
    const timer = setTimeout(() => oak.stop(), 30000);
    oak.start({ simulate: true, lm: "lite", detect: true, motion: true, picture: "depth" }, (msg) => {
      if (msg.status === "running") got.running = msg;
      if (msg.frame) {
        got.push(msg);
        if (got.length === 60) oak.stop();
      } else if (msg.status === "stopped") {
        clearTimeout(timer);
        resolve(got);
      }
    });
  });
  const labels = new Set(extra.flatMap((f) => (f.frame.objects || []).map((o) => o.label)));
  // Its small grey pictures, measured as Sentry mode does (sentry.js): the cat moves in the
  // bottom row of a 3 x 3 grid, and nothing moves in the top one.
  global.window = undefined;
  require("../sentry.js");
  const S = globalThis.Sentry._test;
  const greys = extra.map((f) => f.frame.grey).filter(Boolean).map((g) => ({ w: g.w, h: g.h, data: new Uint8Array(Buffer.from(g.data, "base64")) }));
  let bottom = 0, top = 0;
  for (let i = 1; i < greys.length; i++) {
    const lv = S.levels(S.moved(S.blur(greys[i - 1]), S.blur(greys[i])), 3, 3);
    bottom = Math.max(bottom, ...lv.slice(6));
    top = Math.max(top, ...lv.slice(0, 3));
  }
  const sized = greys.length > 0 && greys.every((g) => g.w === 64 && g.h === 36 && g.data.length === 64 * 36);
  check("The OAK helper also sends the objects it found, a small grey picture for Sentry mode (the cat moving is seen in the bottom row only) and the depth picture (simulated camera)",
    extra.running && extra.running.detect && extra.running.motion && extra.running.picture === "depth" && labels.has("cat") && labels.has("person") &&
      sized && bottom > 0.02 && top === 0 && extra.every((f) => f.jpeg && f.jpeg[0] === 0xff),
    `${extra.length} frames, objects: ${[...labels].join(", ")}, ${greys.length} grey pictures (64x36: ${sized}), moved most: bottom row ${bottom.toFixed(3)}, top row ${top.toFixed(3)}`);

  if (!process.argv[2]) fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
