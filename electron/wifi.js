/**
 * wifi.js — this computer's Wi-Fi, through NetworkManager (Linux: a Raspberry Pi camera rig,
 * say), for remote recording's page (electron/remote-record.js lets only phones on the Pi's
 * own hotspot or over Tailscale use it): the networks around, and joining one.
 *
 *   const wifi = createWifi();   // null where there's no NetworkManager
 *   wifi.available()             // nmcli answered
 *   wifi.status()                // { connecting: ssid | null, last: { ssid, ok, message, at } | null }
 *   await wifi.list()            // { device, current: { ssid, signal } | null, networks: [{ ssid, signal, secure, saved }] }
 *   wifi.connect(ssid, password) // -> { ok, message } now; joining goes on in the background
 *
 * The hotspot's own network (pi/hotspot-setup.sh) isn't listed. The hotspot is the Wi-Fi itself
 * when that isn't on a network, so joining one turns it off (and it comes back if the network
 * can't be joined). A network that couldn't be joined (a wrong password, say) isn't kept.
 */

const { execFile } = require("child_process");

const HOTSPOT = "Hand Tracker hotspot";

function nmcli(args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile("nmcli", args, { timeout, maxBuffer: 1 << 20, env: { ...process.env, LC_ALL: "C" } }, (err, out, errOut) => {
      if (err) reject(new Error(String(errOut || err.message).trim().replace(/^Error:\s*/, "")));
      else resolve(String(out));
    });
  });
}

// nmcli -t's fields: split at ":" that isn't escaped ("\:"), then unescaped.
function fields(line) {
  const out = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && i + 1 < line.length) cur += line[++i];
    else if (line[i] === ":") {
      out.push(cur);
      cur = "";
    } else cur += line[i];
  }
  out.push(cur);
  return out;
}

// The nmcli steps that join a network: a saved one is brought up (with the new password, if
// one's given); a new one is made first, with the security it was seen with when listed. Not
// "nmcli device wifi connect", which needs the network in the Wi-Fi's own latest look around:
// while the Wi-Fi is the hotspot that look is old, and the profile it makes then has no
// security ("802-11-wireless-security.key-mgmt: property is missing").
// security: what the list said ("WPA2", "WPA1 WPA2", "WPA3", "--"); WPA3 alone is SAE.
function joinSteps({ ssid, password, dev, savedName, security }) {
  const keyMgmt = /WPA1|WPA2/.test(security || "") || !/WPA3/.test(security || "") ? "wpa-psk" : "sae";
  const secret = password ? ["wifi-sec.key-mgmt", keyMgmt, "wifi-sec.psk", password] : [];
  const steps = [];
  let name = savedName;
  if (!name) {
    name = ssid;
    steps.push(["connection", "add", "type", "wifi", "ifname", dev, "con-name", name, "ssid", ssid, ...secret]);
  } else if (password) {
    steps.push(["connection", "modify", name, ...secret]);
  }
  // On the normal Wi-Fi only (not a hotspot's own interface).
  if (savedName) steps.push(["connection", "modify", name, "connection.interface-name", dev]);
  steps.push(["--wait", "30", "connection", "up", "id", name, "ifname", dev]);
  return steps;
}

// Why a network couldn't be joined, in a few words.
function why(err) {
  const m = String((err && err.message) || err);
  if (/secrets were required|802-1x|psk|password/i.test(m)) return "the password isn't right";
  if (/no network with ssid|not found/i.test(m)) return "it isn't in range any more";
  if (/not authorized|insufficient privileges/i.test(m)) return "Hand Tracker isn't allowed to change the Wi-Fi here";
  return m.split("\n")[0].slice(0, 160);
}

function createWifi() {
  if (process.platform !== "linux") return null;
  let ok = false;
  let connecting = null;
  let last = null;
  const seen = new Map(); // network name -> its security, from the last list
  nmcli(["--version"], 5000).then(() => (ok = true), () => (ok = false));

  // The Wi-Fi device (wlan0 on a Pi).
  async function device() {
    for (const line of (await nmcli(["-t", "-f", "DEVICE,TYPE", "device"])).split("\n")) {
      const [dev, type] = fields(line);
      if (type === "wifi") return dev;
    }
    throw new Error("No Wi-Fi here.");
  }

  // The saved Wi-Fi networks: connection name by network name (not the hotspot).
  async function saved() {
    const out = new Map();
    for (const line of (await nmcli(["-t", "-f", "NAME,TYPE", "connection", "show"])).split("\n")) {
      const [name, type] = fields(line);
      if (type !== "802-11-wireless" || name === HOTSPOT) continue;
      const ssid = (await nmcli(["-g", "802-11-wireless.ssid", "connection", "show", name]).catch(() => "")).trim();
      if (ssid && !out.has(ssid)) out.set(ssid, name);
    }
    return out;
  }

  async function list() {
    const dev = await device();
    const known = await saved();
    const hotspotSsid = (await nmcli(["-g", "802-11-wireless.ssid", "connection", "show", HOTSPOT]).catch(() => "")).trim();
    const out = await nmcli(["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "ifname", dev, "--rescan", "auto"], 30000);
    const bySsid = new Map();
    let current = null;
    for (const line of out.split("\n")) {
      const [inUse, ssid, signal, security] = fields(line);
      if (!ssid || ssid === hotspotSsid) continue;
      const n = { ssid, signal: Number(signal) || 0, secure: !!security && security !== "--", saved: known.has(ssid) };
      if (security) seen.set(ssid, security);
      if (inUse.trim() === "*") current = { ssid, signal: n.signal };
      const had = bySsid.get(ssid);
      if (!had || had.signal < n.signal) bySsid.set(ssid, n);
    }
    return { device: dev, current, networks: [...bySsid.values()].sort((a, b) => b.signal - a.signal).slice(0, 40) };
  }

  function connect(ssid, password) {
    if (connecting) return { ok: false, message: `Still joining ${connecting}…` };
    connecting = ssid;
    last = null;
    (async () => {
      let made = false;
      try {
        const dev = await device();
        const savedName = (await saved()).get(ssid);
        made = !savedName;
        for (const args of joinSteps({ ssid, password, dev, savedName, security: seen.get(ssid) })) await nmcli(args, 45000);
        last = { ssid, ok: true, message: `Joined ${ssid}.`, at: Date.now() };
      } catch (err) {
        // A network that couldn't be joined isn't kept (NetworkManager would keep trying it).
        if (made) {
          const left = (await saved().catch(() => new Map())).get(ssid);
          if (left) await nmcli(["connection", "delete", "id", left]).catch(() => {});
        }
        last = { ssid, ok: false, message: `Couldn't join ${ssid}: ${why(err)}.`, at: Date.now() };
      } finally {
        connecting = null;
      }
    })();
    return { ok: true, message: `Joining ${ssid}… The hotspot goes off while this computer is on it: to keep reaching it, join ${ssid} on this phone too (or use Tailscale). If it can't be joined, the hotspot comes back within a minute.` };
  }

  return { available: () => ok, status: () => ({ connecting, last }), list, connect };
}

module.exports = { createWifi, fields, joinSteps };
