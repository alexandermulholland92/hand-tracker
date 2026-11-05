/*
 * transmission.js — Transmission (the torrent app) slowed to its alternative speeds while a page
 * looks at this computer's cameras (remote recording's previews), so its uploading leaves the
 * Wi-Fi to their pictures, and back as it was once nobody looks (or the app closes). Through its
 * remote control on this computer only (127.0.0.1:9092: Transmission's desktop app with remote
 * access on, no password, as on the user's Raspberry Pi "pi", whose Wi-Fi its seeding filled).
 * Nothing at all where it isn't there or doesn't answer; one already slow is left as it is.
 *
 *   const transmission = require("./transmission");
 *   transmission.watching(true | false);  // a page looking at the cameras, or not
 *   transmission.restore();               // as the app closes: back to its own speeds, if slowed here
 */
const http = require("http");
const { execFileSync } = require("child_process");

const RPC = { host: "127.0.0.1", port: 9092, path: "/transmission/rpc" };
let session = ""; // Transmission's X-Transmission-Session-Id (it asks for it with a 409)
let ours = false; // its alternative speeds turned on here
let queue = Promise.resolve();

// One remote-control call -> its arguments, or null (not there, or it said no).
function rpc(method, args, again = true) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ method, arguments: args });
    const req = http.request({ ...RPC, method: "POST", timeout: 4000, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-Transmission-Session-Id": session } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode === 409 && again && res.headers["x-transmission-session-id"]) {
          session = String(res.headers["x-transmission-session-id"]);
          return resolve(rpc(method, args, false));
        }
        try {
          const r = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(res.statusCode === 200 && r.result === "success" ? r.arguments || {} : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end(body);
  });
}

function watching(on) {
  if (process.platform !== "linux") return;
  queue = queue
    .then(async () => {
      if (on && !ours) {
        const s = await rpc("session-get", { fields: ["alt-speed-enabled"] });
        if (!s || s["alt-speed-enabled"]) return; // (no Transmission here, or already slow: left as it is)
        if (await rpc("session-set", { "alt-speed-enabled": true })) ours = true;
      } else if (!on && ours) {
        ours = false;
        await rpc("session-set", { "alt-speed-enabled": false });
      }
    })
    .catch(() => {});
  return queue;
}

// As the app closes: its own speeds back, if they were slowed here (waited for: the app is going).
function restore() {
  if (!ours) return;
  ours = false;
  try {
    execFileSync("transmission-remote", [`${RPC.host}:${RPC.port}`, "--no-alt-speed"], { timeout: 3000, stdio: "ignore", windowsHide: true });
  } catch {
    // (gone already)
  }
}

module.exports = { watching, restore, _rpc: rpc, _state: () => ({ ours }) };
