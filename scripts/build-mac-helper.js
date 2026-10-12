/**
 * build-mac-helper.js — builds the Mac helpers, for Apple silicon and Intel Macs in one file each:
 * electron/input-helper-mac (the hand mouse's and floating keyboard's input) from
 * input-helper-mac.m, and electron/bluetooth-helper-mac (remote recording over Bluetooth) from
 * bluetooth-helper-mac.m. Needs a Mac with Xcode's command line tools (xcode-select --install).
 *   node scripts/build-mac-helper.js
 * scripts/dist.js runs it before building the Mac app.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const DIR = path.join(__dirname, "..", "electron");

function buildMacHelper() {
  if (process.platform !== "darwin") throw new Error("The Mac input helper is built on a Mac.");
  const helpers = [["input-helper-mac", ["Cocoa", "ApplicationServices"]], ["bluetooth-helper-mac", ["Foundation", "CoreBluetooth"]]];
  for (const [name, frameworks] of helpers) {
    const args = ["-fobjc-arc", "-O2", "-Wall", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=12.0",
      ...frameworks.flatMap((f) => ["-framework", f]),
      "-o", path.join(DIR, name), path.join(DIR, `${name}.m`)];
    const run = spawnSync("clang", args, { stdio: "inherit" });
    if (run.status !== 0) throw new Error(`clang couldn't build the Mac helper ${name}.`);
  }
}

if (require.main === module) {
  try {
    buildMacHelper();
    console.log("Built electron/input-helper-mac and electron/bluetooth-helper-mac");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { buildMacHelper };
