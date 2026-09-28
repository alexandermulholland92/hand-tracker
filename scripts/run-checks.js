// Runs an automated check script (scripts/check.js or scripts/check-android.js) in Electron,
// and runs it again when Chromium's fake test camera crashed during it (the script then exits
// with CAMERA_CRASHED; see "fake test camera" in it). At most three attempts.
//
//   node scripts/run-checks.js scripts/check.js

const { spawnSync } = require("child_process");
const path = require("path");

const CAMERA_CRASHED = 75;
const ATTEMPTS = 3;
const script = process.argv[2];
if (!script) {
  console.error("Usage: node scripts/run-checks.js <check script>");
  process.exit(2);
}
const electron = require("electron"); // the path to Electron's executable, from Node

let code = 1;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  if (attempt > 1) {
    console.log(`\nChromium's fake test camera crashed; running the checks again (attempt ${attempt} of ${ATTEMPTS}).\n`);
    // Give the crashed run's processes time to go: starting straight away tends to crash again.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  }
  const run = spawnSync(electron, [path.resolve(script), ...process.argv.slice(3)], { stdio: "inherit" });
  code = run.status === null ? 1 : run.status;
  if (code !== CAMERA_CRASHED) break;
}
process.exit(code === CAMERA_CRASHED ? 1 : code);
