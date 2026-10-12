/**
 * bt-link-client.js — reaching a computer's remote recording over Bluetooth Low Energy: the
 * device's end of electron/bluetooth-link.js (which says what goes over the link), for the
 * website and the Windows, Mac and Linux app (Web Bluetooth) and the checks (Node). It speaks the
 * link (frames, the handshake, each request and answer sealed with the session's key) over
 * whatever carries the bytes; only the browser's own crypto (Web Crypto).
 *
 *   const link = BtLinkClient.create({ password, key, info, write })
 *     info: INFO's value ({ name, salt, iter }); write(bytes) -> Promise: a frame to RX;
 *     key: the password's key (K) kept from before, instead of the password
 *   link.received(bytes)                 each notification from TX
 *   await link.open()                    the handshake (again after a disconnect)
 *   await link.request({ method, path, body })  -> { status, type, bytes }
 *     (throws { password: true } for the wrong password)
 *   BtLinkClient.SERVICE / INFO / RX / TX  the GATT service's and characteristics' UUIDs
 *   BtLinkClient.connect({ password, keys, onGone, bluetooth })  (Web Bluetooth) asks for a device
 *     near by, connects -> { name, request, close, saved: { salt, key } }; keys: { [salt]: key }
 *     kept from before (each computer's password's key, base64: what to keep, rather than the
 *     password); throws { needPassword: true } for a computer with none kept and no password given;
 *     bluetooth: instead of navigator.bluetooth, such as
 *   BtLinkClient.capacitorBluetooth(plugin, { prefer, pick })  the phone apps' own Bluetooth (the
 *     "BtLink" plugin: BtLinkPlugin.java on Android) looking like Web Bluetooth's part used here:
 *     the device named prefer, or the only one near by, or pick(devices) -> one of them (or null)
 */

(function (global) {
  const SERVICE = "48540001-6c69-6e6b-8000-68616e647472";
  const INFO = "48540002-6c69-6e6b-8000-68616e647472";
  const RX = "48540003-6c69-6e6b-8000-68616e647472";
  const TX = "48540004-6c69-6e6b-8000-68616e647472";
  const HELLO = 1, WELCOME = 2, DATA = 3, ERROR = 4;
  const FIRST = 1, LAST = 2, HEAD = 6;
  // A write's most (with its frame's own bytes): one Bluetooth packet's on any phone or computer
  // (a longer write needs a "long write", which a computer's Bluetooth may refuse).
  const WRITE_MAX = 180;
  const subtle = () => global.crypto.subtle;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const random = (n) => global.crypto.getRandomValues(new Uint8Array(n));
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const toB64 = (b) => btoa(String.fromCharCode(...b));
  const concat = (parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  const u16 = (n) => new Uint8Array([n & 255, (n >> 8) & 255]);

  async function keyFrom(password, salt, iter) {
    const base = await subtle().importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base, 256));
  }
  async function sessionKey(K, cn, sn) {
    const h = await subtle().importKey("raw", K, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const S = new Uint8Array(await subtle().sign("HMAC", h, concat([enc.encode("HT1"), cn, sn])));
    return subtle().importKey("raw", S, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  function frames(type, session, message, data) {
    const room = WRITE_MAX - HEAD, out = [];
    for (let at = 0; at === 0 || at < data.length; at += room) {
      const part = data.subarray(at, at + room);
      const f = new Uint8Array(HEAD + part.length);
      f[0] = type;
      f.set(u16(session), 1);
      f.set(u16(message), 3);
      f[5] = (at === 0 ? FIRST : 0) | (at + room >= data.length ? LAST : 0);
      f.set(part, HEAD);
      out.push(f);
    }
    return out;
  }
  // An answer deflated by the computer (raw deflate), as it was.
  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  function pack(head, body) {
    const h = enc.encode(JSON.stringify(head));
    const n = new Uint8Array(4);
    new DataView(n.buffer).setUint32(0, h.length, true);
    return concat([n, h, body || new Uint8Array(0)]);
  }
  function unpack(buf) {
    const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
    return { head: JSON.parse(dec.decode(buf.subarray(4, 4 + n))), body: buf.subarray(4 + n) };
  }

  function create({ password, key = null, info, write }) {
    let K = key, S = null, session = 0, opening = null, nextId = 1 + Math.floor(Math.random() * 60000);
    const waiting = new Map(); // message -> { resolve, reject, parts }
    const newId = () => (nextId = (nextId % 65000) + 1);

    function received(bytes) {
      const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (b.length < HEAD) return;
      const type = b[0], sid = b[1] | (b[2] << 8), mid = b[3] | (b[4] << 8), flags = b[5], part = b.subarray(HEAD);
      const w = waiting.get(mid);
      if (!w || (type !== WELCOME && sid !== session && !(type === ERROR && w.hello))) return; // (another device's)
      if (type === WELCOME && w.hello) {
        waiting.delete(mid);
        return w.resolve({ sid, sn: part.slice() });
      }
      if (type === ERROR) {
        waiting.delete(mid);
        const why = dec.decode(part);
        if (why === "password") S = null;
        return w.reject(Object.assign(new Error(why === "password" ? "That isn't its password." : why), { password: why === "password", code: why }));
      }
      if (type !== DATA) return;
      if (flags & FIRST) w.parts = [];
      if (!w.parts) return;
      w.parts.push(part.slice());
      if (flags & LAST) {
        waiting.delete(mid);
        w.resolve(concat(w.parts));
      }
    }

    function expect(mid, extra = {}, ms = 30000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => waiting.delete(mid) && reject(new Error("No answer over Bluetooth.")), ms);
        waiting.set(mid, { ...extra, resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      });
    }

    async function open() {
      if (!info || !info.salt) throw new Error("Its Bluetooth password isn't set yet.");
      if (!K) K = await keyFrom(password, fromB64(info.salt), info.iter);
      const cn = random(16), mid = newId();
      const answer = expect(mid, { hello: true }, 15000);
      for (const f of frames(HELLO, 0, mid, cn)) await write(f);
      const { sid, sn } = await answer;
      S = await sessionKey(K, cn, sn);
      session = sid;
    }

    async function request({ method = "GET", path, body = null }) {
      if (!S) await (opening || (opening = open().finally(() => (opening = null))));
      const mid = newId();
      const aad = concat([u16(session), u16(mid)]);
      const iv = random(12);
      const plain = pack({ m: method, p: path }, body == null ? null : typeof body === "string" ? enc.encode(body) : body);
      const sealed = concat([iv, new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad }, S, plain))]);
      const answer = expect(mid, {}, 60000);
      for (const f of frames(DATA, session, mid, sealed)) await write(f);
      let data;
      try {
        data = await answer;
      } catch (err) {
        if (err.code === "session") S = null; // (the computer forgot it: a new handshake next time)
        throw err;
      }
      const answered = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: data.subarray(0, 12), additionalData: aad }, S, data.subarray(12)));
      const r = unpack(answered);
      return { status: r.head.s, type: r.head.t || "", bytes: r.head.z ? await inflate(r.body) : r.body };
    }

    return { received, open, request, forget: () => (S = null), key: () => K };
  }

  // Web Bluetooth: a device near by offering the link (the browser asks which), connected.
  async function connect({ password, keys = {}, onGone = () => {}, bluetooth = global.navigator && navigator.bluetooth }) {
    if (!bluetooth) throw new Error("This browser can't use Bluetooth (Chrome on Android, Windows or Mac can).");
    const device = await bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
    device.addEventListener("gattserverdisconnected", () => onGone());
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE);
    const [infoC, rx, tx] = await Promise.all([service.getCharacteristic(INFO), service.getCharacteristic(RX), service.getCharacteristic(TX)]);
    const info = JSON.parse(dec.decode(new Uint8Array((await infoC.readValue()).buffer)));
    const kept = info.salt && keys ? keys[info.salt] : null;
    if (!kept && !password) {
      device.gatt.disconnect();
      throw Object.assign(new Error("Its password, please."), { needPassword: true, name: info.name || device.name || "" });
    }
    let queue = Promise.resolve();
    const link = create({ password, key: !password && kept ? fromB64(kept) : null, info, write: (f) => (queue = queue.then(() => rx.writeValueWithResponse(f))) });
    tx.addEventListener("characteristicvaluechanged", (e) => link.received(new Uint8Array(e.target.value.buffer.slice(e.target.value.byteOffset, e.target.value.byteOffset + e.target.value.byteLength))));
    await tx.startNotifications();
    await link.open();
    // (The password's checked by the first request: one that opens with the session's key.)
    try {
      await link.request({ path: "/api/state" });
    } catch (err) {
      device.gatt.disconnect();
      throw err;
    }
    return { name: info.name || device.name || "", request: link.request, close: () => device.gatt.disconnect(), saved: { salt: info.salt, key: toB64(link.key()) } };
  }

  // A phone app's Bluetooth (its "BtLink" plugin) as the Web Bluetooth connect() uses.
  const sameName = (a, b) => !!a && !!b && String(a).toLowerCase().split(".")[0] === String(b).toLowerCase().split(".")[0];
  function capacitorBluetooth(plugin, { prefer = "", pick = null } = {}) {
    return {
      async requestDevice() {
        const { devices = [] } = await plugin.scan({ service: SERVICE, ms: 4000 });
        const named = prefer ? devices.filter((d) => sameName(d.name, prefer)) : [];
        let d = named.length === 1 ? named[0] : !prefer && devices.length === 1 ? devices[0] : null;
        if (!d && devices.length && pick) d = await pick(devices);
        if (!d) throw Object.assign(new Error(devices.length ? "No Hand Tracker was picked over Bluetooth." : "No Hand Tracker near by over Bluetooth (with remote recording on)."), { name: "NotFoundError", none: !devices.length });
        const onValue = [], onGone = [], handles = [];
        const drop = () => handles.splice(0).forEach((h) => h && h.remove && h.remove());
        const characteristic = (uuid) => {
          const ch = {
            readValue: async () => new DataView(fromB64((await plugin.read({ id: d.id, characteristic: uuid })).value || "").buffer),
            writeValueWithResponse: (f) => plugin.write({ id: d.id, characteristic: uuid, value: toB64(f instanceof Uint8Array ? f : new Uint8Array(f)) }),
            startNotifications: async () => (await plugin.notify({ id: d.id, characteristic: uuid }), ch),
            addEventListener: (type, fn) => {
              if (type === "characteristicvaluechanged") onValue.push((e) => e.characteristic === uuid && fn({ target: { value: new DataView(fromB64(e.value || "").buffer) } }));
            },
          };
          return ch;
        };
        return {
          id: d.id,
          name: d.name,
          addEventListener: (type, fn) => type === "gattserverdisconnected" && onGone.push(fn),
          gatt: {
            async connect() {
              drop();
              handles.push(await plugin.addListener("notification", (e) => e.id === d.id && onValue.forEach((f) => f(e))));
              handles.push(await plugin.addListener("disconnected", (e) => {
                if (e.id !== d.id) return;
                drop();
                onGone.forEach((f) => f());
              }));
              await plugin.connect({ id: d.id });
              return { getPrimaryService: async () => ({ getCharacteristic: async (uuid) => characteristic(uuid) }) };
            },
            disconnect: () => {
              plugin.disconnect({ id: d.id }).catch(() => {});
            },
          },
        };
      },
    };
  }

  const api = { create, connect, capacitorBluetooth, SERVICE, INFO, RX, TX };
  global.BtLinkClient = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
