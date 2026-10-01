/**
 * phone-link-protocol.js — the messages between the Android app and a PC it controls over
 * the local network (Wi-Fi): the phone's hand mouse, keyboard and gesture actions, carried
 * out on the PC (electron/phone-link.js) like the PC's own.
 *
 * Pairing: the PC shows a QR code with its addresses, a port and a random key; the phone
 * reads it. Every message is signed with that key (HMAC-SHA-256), so nothing else on the
 * network can send input. Each connection starts with a hello, which the PC answers with a
 * new session id that every later message must carry: a message recorded earlier can't be
 * played back. Pointer moves are sent and forgotten (the next one replaces them); clicks,
 * keys and text are answered, and sent again until they are (each is carried out once).
 *
 *   PhoneLinkProtocol.pairingText({ port, key, addresses })  -> "handtracker-link:1:…"
 *   PhoneLinkProtocol.parsePairing(text)                      -> { port, key, addresses }
 *   PhoneLinkProtocol.newKey()                                -> random key text
 *   await PhoneLinkProtocol.encode(key, { session, seq, type, data })  -> Uint8Array
 *   await PhoneLinkProtocol.decode(key, bytes)                -> { session, seq, type, data } | null
 *
 * A message: "HTL1", session (8 bytes), seq (32-bit), type (1 byte), data (JSON), and the
 * first 16 bytes of the HMAC of all that.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PhoneLinkProtocol = api;
})(typeof self !== "undefined" ? self : this, function () {
  const PREFIX = "handtracker-link:1";
  const PORT = 47820;
  const MAGIC = [0x48, 0x54, 0x4c, 0x31]; // HTL1
  const MAC_BYTES = 16;
  const TYPES = { hello: 1, pointer: 2, button: 3, wheel: 4, key: 5, text: 6, keyboard: 7, ping: 8, bye: 9, ack: 128 };
  const NAMES = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));
  // Answered (and sent again until they are). Pointer moves aren't: the next one replaces them.
  const RELIABLE = new Set(["hello", "button", "wheel", "key", "text", "keyboard", "ping", "bye"]);
  const NO_SESSION = "0000000000000000";

  const subtle = () => (typeof crypto !== "undefined" && crypto.subtle) || require("crypto").webcrypto.subtle;
  const random = (n) => {
    const b = new Uint8Array(n);
    (typeof crypto !== "undefined" && crypto.getRandomValues ? crypto : require("crypto").webcrypto).getRandomValues(b);
    return b;
  };
  const toB64url = (bytes) => {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return (typeof btoa === "function" ? btoa(s) : Buffer.from(bytes).toString("base64")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const fromB64url = (text) => {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
    if (typeof atob === "function") return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new Uint8Array(Buffer.from(b64, "base64"));
  };
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const unhex = (text) => Uint8Array.from(text.match(/../g), (h) => parseInt(h, 16));

  const newKey = () => toB64url(random(16));
  const newSession = () => hex(random(8));

  function pairingText({ port, key, addresses }) {
    return `${PREFIX}:${port}:${key}:${addresses.join(",")}`;
  }

  function parsePairing(text) {
    const m = /^handtracker-link:1:(\d{1,5}):([A-Za-z0-9_-]{22}):([0-9.,]+)$/.exec(String(text || "").trim());
    if (!m) throw new Error("That isn't a Hand Tracker pairing code. On the PC: Control your PC → Let a phone control this PC.");
    const addresses = m[3].split(",").filter((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
    const port = Number(m[1]);
    if (!addresses.length || port < 1 || port > 65535) throw new Error("That pairing code is incomplete.");
    return { port, key: m[2], addresses };
  }

  const keys = new Map(); // key text -> CryptoKey
  async function hmacKey(key) {
    if (!keys.has(key)) keys.set(key, await subtle().importKey("raw", fromB64url(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
    return keys.get(key);
  }

  async function mac(key, bytes) {
    return new Uint8Array(await subtle().sign("HMAC", await hmacKey(key), bytes)).subarray(0, MAC_BYTES);
  }

  async function encode(key, { session = NO_SESSION, seq, type, data = {} }) {
    const body = new TextEncoder().encode(JSON.stringify(data));
    const out = new Uint8Array(4 + 8 + 4 + 1 + body.length + MAC_BYTES);
    out.set(MAGIC, 0);
    out.set(unhex(session), 4);
    new DataView(out.buffer).setUint32(12, seq >>> 0);
    out[16] = TYPES[type];
    out.set(body, 17);
    out.set(await mac(key, out.subarray(0, 17 + body.length)), 17 + body.length);
    return out;
  }

  async function decode(key, bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length < 17 + MAC_BYTES || MAGIC.some((v, i) => b[i] !== v) || !NAMES[b[16]]) return null;
    const end = b.length - MAC_BYTES;
    const expected = await mac(key, b.subarray(0, end));
    let diff = 0;
    for (let i = 0; i < MAC_BYTES; i++) diff |= expected[i] ^ b[end + i];
    if (diff) return null;
    let data;
    try {
      data = JSON.parse(new TextDecoder().decode(b.subarray(17, end)));
    } catch {
      return null;
    }
    return { session: hex(b.subarray(4, 12)), seq: new DataView(b.buffer, b.byteOffset).getUint32(12), type: NAMES[b[16]], data };
  }

  return { PORT, TYPES, RELIABLE, NO_SESSION, newKey, newSession, pairingText, parsePairing, encode, decode };
});
