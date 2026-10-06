/**
 * build-mac-helper.js — builds electron/input-helper-mac (the hand mouse's and floating
 * keyboard's input on a Mac) from electron/input-helper-mac.m, for Apple silicon and Intel
 * Macs in one file. Needs a Mac with Xcode's command line tools (xcode-select --install).
 *   node scripts/build-mac-helper.js
 * scripts/dist.js runs it before building the Mac app.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const DIR = path.join(__dirname, "..", "electron");

function buildMacHelper() {
  if (process.platform !== "darwin") throw new Error("The Mac input helper is built on a Mac.");
  const args = ["-fobjc-arc", "-O2", "-Wall", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=12.0",
    "-framework", "Cocoa", "-framework", "ApplicationServices",
    "-o", path.join(DIR, "input-helper-mac"), path.join(DIR, "input-helper-mac.m")];
  const run = spawnSync("clang", args, { stdio: "inherit" });
  if (run.status !== 0) throw new Error("clang couldn't build the Mac input helper.");
}

if (require.main === module) {
  try {
    buildMacHelper();
    console.log("Built electron/input-helper-mac");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { buildMacHelper };
