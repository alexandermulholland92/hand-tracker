/**
 * bluetooth-link.js — remote recording over Bluetooth Low Energy, this computer's side (the rig):
 * a phone, the website or another computer that can't reach it over a network (no Wi-Fi, no
 * hotspot, no Tailscale) reaches its remote recording page over Bluetooth instead. Each request
 * the page makes comes over the link, is checked, and goes to this computer's own remote
 * recording server (relay), whose answer goes back the same way: everything the page does works.
 *
 * The link: a GATT service of its own (SERVICE), advertised by name, with three characteristics:
 *   INFO (read): {"v":1,"name":<this computer>,"salt":<base64>,"iter":<n>}
 *   RX (write, from the device): frames
 *   TX (notify, to the device): frames
 * The password (on a Raspberry Pi with a hotspot, its hotspot's; else the Bluetooth password set
 * here) is never sent: both sides know K = PBKDF2-SHA256(password, salt, iter, 32 bytes) (this
 * computer keeps only K). A frame: [type][session: u16 LE][message: u16 LE][flags][bytes...]
 * (flags: 1 the first frame of a message, 2 the last).
 *   HELLO (1, device -> here, one frame): its 16 random bytes (cn); message: its tag.
 *   WELCOME (2, here -> device): the session's number; message: the device's tag; 16 random
 *     bytes (sn). Both make the session's key S = HMAC-SHA256(K, "HT1" + cn + sn).
 *   DATA (3, either way, in frames): iv (12) + AES-256-GCM(S, iv, message, aad = session + message
 *     numbers) + tag; a message is [u32 LE n][n bytes of JSON][body]: a request {"m","p"} with its
 *     body, an answer {"s","t"} (status, content type) with its body, deflated ("z":1, raw deflate)
 *     when that's shorter (the page's state: 2 KB, 0.7 deflated). A request that doesn't open
 *     with S (the wrong password) gets an ERROR; one that does is the device's proof it knows it.
 *   ERROR (4, here -> device): what went wrong, as text ("password": the wrong one).
 * Notifications go to every device listening (Bluetooth's way): each frame says whose session it
 * is, and only that device can open it.
 *
 *   const link = new BluetoothLink({ name, secret: () => ({ salt, iter, key }) | null, relay, send })
 *     relay({ method, path, body, peer }) -> Promise<{ status, type, body: Buffer }>  (the remote recording server)
 *     send(frame: Buffer, mtu)   a notification to the devices (the platform's helper sends it)
 *   link.received(device, frame, mtu)   a frame a device wrote
 *   link.gone(device)                   a device disconnected: its sessions end
 *   link.info()                         INFO's value (Buffer)
 */

const crypto = require("crypto");
const zlib = require("zlib");

const SERVICE = "48540001-6c69-6e6b-8000-68616e647472";
const INFO = "48540002-6c69-6e6b-8000-68616e647472";
const RX = "48540003-6c69-6e6b-8000-68616e647472";
const TX = "48540004-6c69-6e6b-8000-68616e647472";
const HELLO = 1, WELCOME = 2, DATA = 3, ERROR = 4;
const FIRST = 1, LAST = 2;
const HEAD = 6; // a frame's own bytes before its share of the message
const SESSION_IDLE_MS = 10 * 60 * 1000;
const MAX_MESSAGE = 64 * 1024; // a request's most (the page's commands are a few KB)
const ITERATIONS = 100000;

// K from a password (also what's kept: { salt, iter, key }, base64).
function makeSecret(password, salt = crypto.randomBytes(16), iter = ITERATIONS) {
  const key = crypto.pbkdf2Sync(String(password), salt, iter, 32, "sha256");
  return { salt: salt.toString("base64"), iter, key: key.toString("base64") };
}
function checkPassword(secret, password) {
  if (!secret || !secret.key) return false;
  const k = crypto.pbkdf2Sync(String(password), Buffer.from(secret.salt, "base64"), secret.iter, 32, "sha256");
  const want = Buffer.from(secret.key, "base64");
  return k.length === want.length && crypto.timingSafeEqual(k, want);
}
const sessionKey = (K, cn, sn) => crypto.createHmac("sha256", K).update(Buffer.concat([Buffer.from("HT1"), cn, sn])).digest();
function seal(S, session, message, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", S, iv);
  c.setAAD(aad(session, message));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]);
}
function open(S, session, message, sealed) {
  if (sealed.length < 28) return null;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", S, sealed.subarray(0, 12));
    d.setAAD(aad(session, message));
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()]);
  } catch {
    return null;
  }
}
function aad(session, message) {
  const b = Buffer.alloc(4);
  b.writeUInt16LE(session, 0);
  b.writeUInt16LE(message, 2);
  return b;
}
// A message: [u32 LE n][n bytes of JSON][body].
function pack(head, body = Buffer.alloc(0)) {
  const h = Buffer.from(JSON.stringify(head));
  const n = Buffer.alloc(4);
  n.writeUInt32LE(h.length, 0);
  return Buffer.concat([n, h, Buffer.isBuffer(body) ? body : Buffer.from(body || "")]);
}
function unpack(buf) {
  if (buf.length < 4) return null;
  const n = buf.readUInt32LE(0);
  if (n > buf.length - 4) return null;
  try {
    return { head: JSON.parse(buf.subarray(4, 4 + n).toString("utf8")), body: buf.subarray(4 + n) };
  } catch {
    return null;
  }
}
// A notification's most bytes: at most mtu - 3, and a size that fills Bluetooth's radio packets
// (251 bytes each, with the packet length extension every phone and computer here has): with
// its 7 bytes of headers, 495 is exactly two and 244 one, where 509 took three (the last with 14
// bytes, a third of the packets sent: a Raspberry Pi's Bluetooth sends so many a turn).
function frameSize(mtu) {
  const most = Math.min(509, (mtu || 23) - 3);
  return most >= 495 ? 495 : most >= 244 ? 244 : Math.max(20, most);
}
// A message as frames that fit the link (each frameSize(mtu) bytes at most).
function frames(type, session, message, data, mtu) {
  const room = frameSize(mtu) - HEAD;
  const out = [];
  for (let at = 0; at === 0 || at < data.length; at += room) {
    const part = data.subarray(at, at + room);
    const f = Buffer.alloc(HEAD + part.length);
    f[0] = type;
    f.writeUInt16LE(session, 1);
    f.writeUInt16LE(message, 3);
    f[5] = (at === 0 ? FIRST : 0) | (at + room >= data.length ? LAST : 0);
    part.copy(f, HEAD);
    out.push(f);
  }
  return out;
}

class BluetoothLink {
  constructor({ name, secret, relay, send }) {
    this.name = name;
    this.secret = secret;
    this.relay = relay;
    this.send = send;
    this.sessions = new Map(); // session -> { device, S, at, parts: Map<message, Buffer[]>, mtu }
    this.next = 1 + crypto.randomInt(60000);
  }

  info() {
    const s = this.secret();
    return Buffer.from(JSON.stringify({ v: 1, name: this.name, salt: s ? s.salt : null, iter: s ? s.iter : null }));
  }

  gone(device) {
    for (const [id, s] of this.sessions) if (s.device === device) this.sessions.delete(id);
  }

  notify(type, session, message, data, mtu) {
    for (const f of frames(type, session, message, data, mtu)) this.send(f, mtu);
  }

  received(device, frame, mtu = 23) {
    if (!Buffer.isBuffer(frame) || frame.length < HEAD) return;
    const type = frame[0], session = frame.readUInt16LE(1), message = frame.readUInt16LE(3), flags = frame[5], part = frame.subarray(HEAD);
    const now = Date.now();
    for (const [id, s] of this.sessions) if (now - s.at > SESSION_IDLE_MS) this.sessions.delete(id);
    if (type === HELLO) {
      const secret = this.secret();
      if (!secret) return this.notify(ERROR, 0, message, Buffer.from("no password"), mtu);
      if (part.length !== 16) return;
      this.gone(device); // (one session a device: a new hello starts afresh)
      const id = this.next;
      this.next = (this.next % 65000) + 1;
      const sn = crypto.randomBytes(16);
      this.sessions.set(id, { device, S: sessionKey(Buffer.from(secret.key, "base64"), part, sn), at: now, parts: new Map(), mtu });
      return this.notify(WELCOME, id, message, sn, mtu);
    }
    if (type !== DATA) return;
    const s = this.sessions.get(session);
    if (!s || s.device !== device) return this.notify(ERROR, session, message, Buffer.from("session"), mtu);
    s.at = now;
    s.mtu = mtu || s.mtu;
    if (flags & FIRST) s.parts.set(message, []);
    const parts = s.parts.get(message);
    if (!parts) return;
    parts.push(Buffer.from(part));
    if (parts.reduce((n, p) => n + p.length, 0) > MAX_MESSAGE + 64) {
      s.parts.delete(message);
      return this.notify(ERROR, session, message, Buffer.from("too long"), s.mtu);
    }
    if (!(flags & LAST)) return;
    s.parts.delete(message);
    const plain = open(s.S, session, message, Buffer.concat(parts));
    if (!plain) {
      this.sessions.delete(session);
      return this.notify(ERROR, session, message, Buffer.from("password"), s.mtu);
    }
    const req = unpack(plain);
    if (!req || typeof req.head.p !== "string" || !/^\/api\/[a-z]/.test(req.head.p)) return this.reply(s, session, message, 400, { error: "Not found" });
    const method = req.head.m === "POST" ? "POST" : "GET";
    return this.relay({ method, path: req.head.p.slice(0, 512), body: method === "POST" ? req.body : null, peer: device })
      .then((r) => this.reply(s, session, message, r.status, r.body, r.type))
      .catch((err) => this.reply(s, session, message, 502, { error: String((err && err.message) || err) }));
  }

  reply(s, session, message, status, body, type = "application/json; charset=utf-8") {
    if (this.sessions.get(session) !== s) return;
    const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    // (Bluetooth is slow: a phone's link carries a few KB a second, a computer's can be under one.)
    const small = data.length > 200 && !/^image\//.test(type || "") ? zlib.deflateRawSync(data, { level: 9 }) : null;
    const head = small && small.length < data.length ? { s: status, t: type || "", z: 1 } : { s: status, t: type || "" };
    this.notify(DATA, session, message, seal(s.S, session, message, pack(head, head.z ? small : data)), s.mtu);
  }
}

module.exports = { BluetoothLink, SERVICE, INFO, RX, TX, makeSecret, checkPassword, sessionKey, seal, open, pack, unpack, frames, frameSize, HELLO, WELCOME, DATA, ERROR, FIRST, LAST, HEAD };
