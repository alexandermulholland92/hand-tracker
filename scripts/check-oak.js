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
  const moved = extra.some((f) => Array.isArray(f.frame.motion) && f.frame.motion.length === 9 && f.frame.motion.slice(6).some((v) => v > 0));
  check("The OAK helper also sends the objects it found, each ninth's motion and the depth picture (simulated camera)",
    extra.running && extra.running.detect && extra.running.motion && extra.running.picture === "depth" && labels.has("cat") && labels.has("person") && moved &&
      extra.every((f) => f.jpeg && f.jpeg[0] === 0xff),
    `${extra.length} frames, objects: ${[...labels].join(", ")}, motion in the bottom row: ${moved}`);

  if (!process.argv[2]) fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
