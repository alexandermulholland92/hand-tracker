/**
 * fake-bt-hid.js — stands in for the Bluetooth mouse helpers (electron/bt-hid-win.cs,
 * bt-hid-linux.py) in the checks: says it's ready, then that "Test iPhone" connected, and
 * writes every line it's sent (and its arguments) to HAND_TRACKER_BTHID_LOG. Nothing goes
 * over Bluetooth.
 */

const fs = require("fs");
const log = process.env.HAND_TRACKER_BTHID_LOG;
const say = (line) => process.stdout.write(`${line}\n`);
fs.writeFileSync(log, `args ${process.argv.slice(2).join(" ")}\n`);
say("ready");
setTimeout(() => say("clients 1 Test iPhone"), 200);
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    fs.appendFileSync(log, `${line}\n`);
    if (line === "quit") process.exit(0);
  }
});
process.stdin.on("end", () => process.exit(0));
