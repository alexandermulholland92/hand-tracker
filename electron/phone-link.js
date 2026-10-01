/**
 * phone-link.js — lets the Android app control this computer over the local network
 * (Windows and Linux app): the phone's hand mouse, keyboard and gesture actions arrive as
 * small UDP messages (phone-link-protocol.js: signed with a key the phone only gets from the
 * QR code shown here) and are carried out like this app's own. It only listens while "Let a
 * phone control this PC" is on.
 *
 *   const link = new PhoneLinkServer({ handle: async (type, data) => result, keyStore });
 *   await link.start();       // -> status (with the pairing text for the QR code)
 *   link.on("status", (s) => …);   // { on, port, addresses, pairing, phone: { name, address, seen } | null }
 *   link.newKey(); link.stop();
 *
 * keyStore: { load() -> key | null, save(key) } (main.js keeps it encrypted by the OS).
 */

const dgram = require("dgram");
const os = require("os");
const { EventEmitter } = require("events");
const P = require("../phone-link-protocol.js");

const SEEN_WINDOW = 4096; // reliable messages remembered per session (each is carried out once)
const GONE_MS = 10000; // no message for this long: the phone is shown as gone

// This computer's addresses on local networks: private ranges first (the phone is on Wi-Fi).
function localAddresses() {
  const all = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family !== "IPv4" && a.family !== 4) || a.internal || a.address.startsWith("169.254.")) continue;
      all.push(a.address);
    }
  }
  const rank = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return [...new Set(all)].sort((a, b) => rank(a) - rank(b)).slice(0, 4);
}

class PhoneLinkServer extends EventEmitter {
  constructor({ handle, keyStore }) {
    super();
    this.handle = handle;
    this.keyStore = keyStore;
    this.key = (keyStore && keyStore.load()) || null;
    this.socket = null;
    this.port = 0;
    this.peer = null; // { session, address, port, name, seen: Set, high, lastPointer, at }
    this.timer = null;
  }

  status() {
    const on = !!this.socket;
    const addresses = on ? localAddresses() : [];
    const phone = this.peer && Date.now() - this.peer.at < GONE_MS ? { name: this.peer.name, address: this.peer.address, seen: this.peer.at } : null;
    return { on, port: this.port, addresses, pairing: on && addresses.length ? P.pairingText({ port: this.port, key: this.key, addresses }) : "", phone };
  }

  emitStatus() {
    this.emit("status", this.status());
  }

  async start() {
    if (this.socket) return this.status();
    if (!this.key) this.newKey();
    const socket = dgram.createSocket("udp4");
    socket.on("message", (msg, rinfo) => this.receive(msg, rinfo).catch(() => {}));
    socket.on("error", () => {});
    // The usual port when it's free (the phone remembers it), else any.
    await new Promise((resolve, reject) => {
      socket.once("error", (err) => (err.code === "EADDRINUSE" ? socket.bind(0, resolve) : reject(err)));
      socket.bind(P.PORT, resolve);
    });
    this.socket = socket;
    this.port = socket.address().port;
    this.timer = setInterval(() => {
      if (this.peer && this.peer.shown && Date.now() - this.peer.at >= GONE_MS) {
        this.peer.shown = false;
        this.emitStatus();
      }
    }, 2000);
    this.emitStatus();
    return this.status();
  }

  stop() {
    if (this.socket) this.socket.close();
    this.socket = null;
    this.port = 0;
    this.peer = null;
    clearInterval(this.timer);
    this.emitStatus();
    return this.status();
  }

  // A new key: phones paired with the old one can't connect any more.
  newKey() {
    this.key = P.newKey();
    this.peer = null;
    if (this.keyStore) this.keyStore.save(this.key);
    if (this.socket) this.emitStatus();
    return this.status();
  }

  async send(rinfo, msg) {
    const bytes = await P.encode(this.key, msg);
    if (this.socket) this.socket.send(bytes, rinfo.port, rinfo.address);
  }

  async receive(bytes, rinfo) {
    const msg = await P.decode(this.key, bytes);
    if (!msg) return; // not signed with this PC's key: ignored
    const ack = (data) => this.send(rinfo, { session: msg.session, seq: msg.seq, type: "ack", data });
    if (msg.type === "hello") {
      // The same hello again (sent again before its answer came, or arriving over a second
      // network, like Wi-Fi and a VPN): the session already given.
      const helloId = String((msg.data && msg.data.id) || "");
      if (this.peer && helloId && this.peer.helloId === helloId) {
        await ack({ ok: true, session: this.peer.session, name: os.hostname() });
        return;
      }
      // A new connection: a new session id (messages from an earlier one stop counting).
      const session = P.newSession();
      this.peer = { session, helloId, address: rinfo.address, port: rinfo.port, name: String((msg.data && msg.data.name) || "Phone").slice(0, 60), seen: new Set(), high: 0, lastPointer: 0, at: Date.now(), shown: true };
      await ack({ ok: true, session, name: os.hostname() });
      this.emitStatus();
      return;
    }
    const peer = this.peer;
    if (!peer || msg.session !== peer.session) return;
    peer.address = rinfo.address;
    peer.port = rinfo.port;
    peer.at = Date.now();
    if (!peer.shown) {
      peer.shown = true;
      this.emitStatus();
    }
    if (msg.type === "pointer") {
      if (msg.seq <= peer.lastPointer) return; // an older move arriving late
      peer.lastPointer = msg.seq;
      this.handle("pointer", msg.data).catch(() => {});
      return;
    }
    if (!P.RELIABLE.has(msg.type)) return;
    if (peer.seen.has(msg.seq)) return ack({ ok: true, again: true }); // the answer was lost: say so again
    if (msg.seq + SEEN_WINDOW < peer.high) return; // too old
    peer.seen.add(msg.seq);
    peer.high = Math.max(peer.high, msg.seq);
    if (peer.seen.size > SEEN_WINDOW) for (const s of peer.seen) if (s + SEEN_WINDOW < peer.high) peer.seen.delete(s);
    if (msg.type === "ping") return ack({ ok: true });
    if (msg.type === "bye") {
      this.peer = null;
      await ack({ ok: true });
      this.emitStatus();
      return;
    }
    try {
      const result = await this.handle(msg.type, msg.data || {});
      await ack({ ok: true, result: result === undefined ? null : result });
    } catch (err) {
      await ack({ ok: false, error: String((err && err.message) || err) });
    }
  }
}

module.exports = { PhoneLinkServer, localAddresses };
