/**
 * natnet.js — receives OptiTrack Motive's live NatNet stream (Windows and Linux app).
 *
 * Motive keeps the cameras to itself, but it streams what it tracks — labelled
 * markers, rigid bodies and skeletons — over UDP with the NatNet protocol
 * (Motive: View → Streaming Pane → Broadcast Frame Data). The protocol (reading packets,
 * connecting, asking for names) is natnet-parse.js's, shared with the Android app; this
 * has the sockets.
 *
 *   const client = new NatNetClient();
 *   client.on("status", (s) => ...);   // { state: "waiting" | "connected" | "stopped", server, app, version, error }
 *   client.on("frame", (f) => ...);    // { frame, timestamp, markers, rigidBodies, skeletons }
 *   client.start({ server: "127.0.0.1", multicast: true });
 *   client.stop();
 */

const dgram = require("dgram");
const os = require("os");
const { EventEmitter } = require("events");
const { NAT, DEFAULTS, readFrame, readModelDef, Session } = require("../natnet-parse.js");

// The local address that shares a network with the server (for multicast membership).
function localInterfaceFor(server) {
  if (server === "127.0.0.1" || server === "localhost") return "127.0.0.1";
  const target = server.split(".").map(Number);
  let best = null;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      const mask = a.netmask.split(".").map(Number);
      const mine = a.address.split(".").map(Number);
      if (mine.every((b, i) => (b & mask[i]) === (target[i] & mask[i]))) return a.address;
      if (!a.internal && !best) best = a.address;
    }
  }
  return best || "0.0.0.0";
}

class NatNetClient extends EventEmitter {
  constructor() {
    super();
    this.opts = null;
    this.session = null;
    this.timers = [];
    this.sockets = [];
    this.lastStatus = null;
  }

  start(options = {}) {
    this.stop();
    const opts = { ...DEFAULTS, ...options };
    this.opts = opts;
    const local = localInterfaceFor(opts.server);
    const command = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const session = new Session({
      server: opts.server,
      multicast: opts.multicast,
      send: (bytes) => command.send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), opts.commandPort, opts.server),
      onStatus: (s) => {
        this.lastStatus = s;
        this.emit("status", s);
      },
      onFrame: (f) => this.emit("frame", f),
      onWarning: (w) => this.emit("warning", w),
    });
    this.session = session;
    const fail = (error) => session.status({ state: "stopped", error });
    session.status({ state: "waiting" });

    this.sockets.push(command);
    command.on("message", (msg) => session.handle(msg));
    command.on("error", (err) => fail(err.message));
    command.bind(0, opts.multicast ? undefined : local, () => {
      session.hello();
      this.timers.push(setInterval(() => session.hello(), 1000));
    });

    if (opts.multicast) {
      const data = dgram.createSocket({ type: "udp4", reuseAddr: true });
      this.sockets.push(data);
      data.on("message", (msg) => session.handle(msg));
      data.on("error", (err) => fail(err.message));
      data.bind(opts.dataPort, () => {
        try {
          data.addMembership(opts.multicastAddress, local);
        } catch (err) {
          fail(`Couldn't join Motive's multicast group ${opts.multicastAddress} on ${local}: ${err.message}`);
        }
      });
    }
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const s of this.sockets) {
      try {
        s.close();
      } catch {
        // already closed
      }
    }
    this.sockets = [];
    if (this.opts && this.session) this.session.status({ state: "stopped" });
    this.opts = null;
    this.session = null;
  }
}

module.exports = { NatNetClient, readFrame, readModelDef, NAT, localInterfaceFor };
