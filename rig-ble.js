/**
 * rig-ble.js — a capture rig's own Bluetooth server, for Live Rigs when you're next to a rig
 * (hidden with it): the rig's status over Bluetooth Low Energy, with no network or dashboard.
 * Only reads: the rigs' shared Bluetooth password (typed into the app once, kept encrypted by
 * it), the rig's identity, then the status it sends once a second. Nothing on the rig is changed.
 *
 * The rig's protocol: one GATT service with three characteristics: Status (notify: its status,
 * once a second once the password's taken), Command (write: one JSON command,
 * { id, domain, action, params }) and Detail (notify: each command's answer,
 * { id, domain, action, ok, data | error: { code, message } }). Everything notified is JSON
 * sent in pieces: byte 0 flags (1: the first piece, 2: the last), bytes 1-2 its number (big
 * endian, from 0), then up to 128 bytes of the JSON (UTF-8).
 *
 *   const rig = await RigBle.connect({ bluetooth, password, onStatus, onGone })
 *     bluetooth: navigator.bluetooth (the Windows, Mac and Linux app) or
 *     BtLinkClient.capacitorBluetooth(plugin, { service: RigBle.SERVICE, pick }) (Android)
 *     -> { name, identity, close() }; throws { password: true } for a password it didn't take
 *   RigBle.lines(status)   the status as lines of text to show
 *   RigBle.reassembler(onMessage)  pieces -> each JSON message (for the checks)
 */

(function (global) {
  const SERVICE = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
  const STATUS = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f1";
  const COMMAND = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f2";
  const DETAIL = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f3";
  const FIRST = 1, LAST = 2;
  const MAX_MESSAGE = 256 * 1024;
  const ANSWER_MS = 10000;
  const enc = new TextEncoder(), dec = new TextDecoder();

  // One characteristic's pieces as whole messages: a missed piece drops that message (until the
  // next first piece).
  function reassembler(onMessage) {
    let parts = null, size = 0, next = 0;
    return (bytes) => {
      if (!bytes || bytes.length < 3) return;
      const flags = bytes[0], seq = (bytes[1] << 8) | bytes[2];
      if (flags & FIRST) {
        parts = [];
        size = 0;
        next = 0;
      }
      if (!parts || seq !== next) {
        parts = null;
        return;
      }
      const body = bytes.slice(3);
      parts.push(body);
      size += body.length;
      next++;
      if (size > MAX_MESSAGE) {
        parts = null;
        return;
      }
      if (!(flags & LAST)) return;
      const all = new Uint8Array(size);
      let at = 0;
      for (const p of parts) {
        all.set(p, at);
        at += p.length;
      }
      parts = null;
      let message = null;
      try {
        message = JSON.parse(dec.decode(all));
      } catch {
        return; // (not JSON: dropped)
      }
      if (message && typeof message === "object") onMessage(message);
    };
  }

  const bytesOf = (e) => {
    const v = e.target.value;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  };

  async function connect({ bluetooth, password, onStatus = () => {}, onGone = () => {} }) {
    if (!bluetooth) throw new Error("Bluetooth can't be used here.");
    if (!password) throw Object.assign(new Error("The rigs' Bluetooth password, please."), { password: true });
    const device = await bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
    let closed = false;
    device.addEventListener("gattserverdisconnected", () => {
      if (!closed) onGone();
    });
    const close = () => {
      closed = true;
      try {
        device.gatt.disconnect();
      } catch {
        // already gone
      }
    };
    try {
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE);
      const [status, command, detail] = await Promise.all([STATUS, COMMAND, DETAIL].map((uuid) => service.getCharacteristic(uuid)));
      const waiting = new Map();
      let n = 0;
      const answers = reassembler((m) => {
        const done = waiting.get(m.id);
        if (done) {
          waiting.delete(m.id);
          done(m);
        }
      });
      const statuses = reassembler((m) => {
        if (m.domain === "status" && m.action === "telemetry" && m.ok !== false && m.data && typeof m.data === "object") onStatus(m.data);
      });
      detail.addEventListener("characteristicvaluechanged", (e) => answers(bytesOf(e)));
      status.addEventListener("characteristicvaluechanged", (e) => statuses(bytesOf(e)));
      await detail.startNotifications();
      await status.startNotifications();
      let queue = Promise.resolve();
      // Only these: who it is, and the password (its status then comes by itself).
      const ask = (action, params = {}) =>
        new Promise((resolve, reject) => {
          const id = `ht${++n}`;
          const timer = setTimeout(() => {
            waiting.delete(id);
            reject(new Error("The rig didn't answer over Bluetooth."));
          }, ANSWER_MS);
          waiting.set(id, (m) => {
            clearTimeout(timer);
            if (m.ok) return resolve(m.data && typeof m.data === "object" ? m.data : {});
            reject(Object.assign(new Error((m.error && m.error.message) || "The rig said no."), { code: m.error && m.error.code }));
          });
          const body = enc.encode(JSON.stringify({ id, domain: "session", action, params }));
          queue = queue.then(() => command.writeValueWithResponse(body)).catch((err) => {
            clearTimeout(timer);
            waiting.delete(id);
            reject(err);
          });
        });
      const identity = await ask("identity");
      try {
        await ask("auth", { password: String(password) });
      } catch (err) {
        if (err.code === "auth_failed") throw Object.assign(new Error("The rig didn't take that Bluetooth password."), { password: true });
        throw err;
      }
      const text = (v) => (typeof v === "string" ? v.slice(0, 80) : "");
      return { name: text(identity.display_name) || text(identity.hostname) || device.name || "The rig", identity, close };
    } catch (err) {
      close();
      throw err;
    }
  }

  // The rig's status (as its Bluetooth server sends it) as lines of text; only what it says.
  function lines(t) {
    const o = (v) => (v && typeof v === "object" ? v : {});
    const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
    const text = (v, n = 80) => (typeof v === "string" ? v.slice(0, n) : "");
    const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    const gb = (b) => `${(b / 1e9).toFixed(1)} GB`;
    const out = [];
    const rec = o(t.recording), cams = o(t.cameras), sys = o(t.system), disk = o(t.disk), ssd = o(t.ssd), up = o(t.upload), wifi = o(t.wifi), imu = o(t.imu);
    if (rec.active) out.push(`Recording ${num(rec.elapsed_s) != null ? clock(rec.elapsed_s) : ""}${text(rec.task) ? ` · ${text(rec.task)}` : ""}${num(rec.size_bytes) ? ` · ${gb(rec.size_bytes)}` : ""}`);
    else out.push(`Not recording${rec.can_record === false && text(rec.block_reason) ? `: ${text(rec.block_reason, 160)}` : ""}`);
    const list = Array.isArray(cams.list) ? cams.list.map(o) : [];
    if (num(cams.detected) != null || list.length) {
      const each = list.map((c) => `${text(c.role) || "camera"}${text(c.ui_health) || text(c.ui_status) ? ` ${text(c.ui_health) || text(c.ui_status)}` : ""}`).join(", ");
      out.push(`Cameras ${num(cams.detected) != null ? cams.detected : list.length}${num(cams.expected) ? ` of ${cams.expected}` : ""}${each ? `: ${each}` : ""}`);
    }
    const s = [];
    if (num(sys.cpu_temp_c) != null) s.push(`${Math.round(sys.cpu_temp_c)} °C`);
    if (num(sys.cpu_pct) != null) s.push(`processor ${Math.round(sys.cpu_pct)}%`);
    if (num(sys.mem_pct) != null) s.push(`memory ${Math.round(sys.mem_pct)}%`);
    if (num(sys.fan_rpm)) s.push(`fan ${Math.round(sys.fan_rpm)} rpm`);
    const watts = num(sys.pi_power_w) || num(sys.hat_power_w);
    if (watts) s.push(`${watts.toFixed(1)} W`);
    if (sys.throttled && sys.throttled !== "0x0" && sys.throttled !== 0) s.push(`⚠ throttled (${text(String(sys.throttled), 20)})`);
    if (s.length) out.push(s.join(" · "));
    const d = [];
    if (num(disk.free_gb) != null) d.push(`${Math.round(disk.free_gb)} GB free`);
    if (num(ssd.temp_c) != null) d.push(`drive ${Math.round(ssd.temp_c)} °C`);
    if (num(ssd.write_mb_s)) d.push(`writing ${ssd.write_mb_s.toFixed(1)} MB/s`);
    if (d.length) out.push(d.join(" · "));
    const u = [];
    if (num(up.uploading_bytes)) u.push(`uploading ${gb(up.uploading_bytes)}`);
    if (num(up.pending_bytes)) u.push(`${gb(up.pending_bytes)} to upload`);
    if (up.paused) u.push("paused");
    if (u.length) out.push(`Upload: ${u.join(" · ")}`);
    if (wifi.connected === false) out.push("Wi-Fi: not connected");
    else if (text(wifi.ssid)) out.push(`Wi-Fi: ${text(wifi.ssid)}${num(wifi.signal) != null ? ` (signal ${wifi.signal})` : ""}`);
    if (text(imu.state)) out.push(`Motion sensor: ${text(imu.state)}`);
    for (const a of (Array.isArray(t.alerts) ? t.alerts : []).slice(0, 5)) {
      const msg = typeof a === "string" ? a : text(o(a).message, 160) || text(o(a).title, 160);
      if (msg) out.push(`⚠ ${msg.slice(0, 160)}`);
    }
    return out;
  }

  const api = { connect, lines, reassembler, SERVICE, STATUS, COMMAND, DETAIL };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.RigBle = api;
})(typeof window !== "undefined" ? window : globalThis);
