/**
 * natnet.js — receives OptiTrack Motive's live NatNet stream (Windows app).
 *
 * Motive keeps the cameras to itself, but it streams what it tracks — labelled
 * markers, rigid bodies and skeletons — over UDP with the NatNet protocol
 * (Motive: View → Streaming Pane → Broadcast Frame Data). This client follows
 * the layout of NaturalPoint's reference Python client (NatNetClient.py,
 * Apache-2.0) for NatNet 3.x and 4.x.
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

const NAT = {
  CONNECT: 0, SERVERINFO: 1, REQUEST: 2, RESPONSE: 3, REQUEST_MODELDEF: 4, MODELDEF: 5,
  REQUEST_FRAMEOFDATA: 6, FRAMEOFDATA: 7, MESSAGESTRING: 8, DISCONNECT: 9, KEEPALIVE: 10,
  UNRECOGNIZED_REQUEST: 100,
};
const DEFAULTS = { server: "127.0.0.1", multicast: true, multicastAddress: "239.255.42.99", commandPort: 1510, dataPort: 1511 };

// ---------- reading packets ----------
class Reader {
  constructor(buf, offset = 0) {
    this.buf = buf;
    this.o = offset;
  }
  i32() { const v = this.buf.readInt32LE(this.o); this.o += 4; return v; }
  u32() { const v = this.buf.readUInt32LE(this.o); this.o += 4; return v; }
  i16() { const v = this.buf.readInt16LE(this.o); this.o += 2; return v; }
  u16() { const v = this.buf.readUInt16LE(this.o); this.o += 2; return v; }
  u8() { return this.buf[this.o++]; }
  f32() { const v = this.buf.readFloatLE(this.o); this.o += 4; return v; }
  f64() { const v = this.buf.readDoubleLE(this.o); this.o += 8; return v; }
  vec3() { return [this.f32(), this.f32(), this.f32()]; }
  quat() { return [this.f32(), this.f32(), this.f32(), this.f32()]; } // x, y, z, w
  skip(n) { this.o += n; }
  str() {
    const end = this.buf.indexOf(0, this.o);
    const s = this.buf.toString("utf8", this.o, end < 0 ? this.buf.length : end);
    this.o = end < 0 ? this.buf.length : end + 1;
    return s;
  }
  fixedStr(n) {
    const slice = this.buf.subarray(this.o, this.o + n);
    this.o += n;
    const end = slice.indexOf(0);
    return slice.toString("utf8", 0, end < 0 ? n : end);
  }
}

const atLeast = (v, major, minor) => v[0] > major || (v[0] === major && v[1] >= minor);
// NatNet 4.1 put each section's size in bytes after its count.
const sizedSections = (v) => atLeast(v, 4, 1);

function readRigidBody(r, v) {
  const rb = { id: r.i32(), position: r.vec3(), rotation: r.quat(), valid: true, error: 0 };
  if (v[0] < 3 && v[0] !== 0) {
    const n = r.i32();
    r.skip(n * 12); // marker positions
    if (v[0] >= 2) r.skip(n * 8); // ids, sizes
  }
  if (v[0] >= 2) rb.error = r.f32();
  if (atLeast(v, 2, 6)) rb.valid = (r.i16() & 0x01) !== 0;
  return rb;
}

function readFrame(r, v) {
  const frame = { frame: r.i32(), markerSets: [], rigidBodies: [], skeletons: [], markers: [], timestamp: 0 };
  const count = () => {
    const n = r.i32();
    if (sizedSections(v)) r.i32();
    return n;
  };
  // Marker sets: named groups of marker positions.
  for (let i = 0, n = count(); i < n; i++) {
    const name = r.str();
    const m = r.i32();
    const points = [];
    for (let j = 0; j < m; j++) points.push(r.vec3());
    frame.markerSets.push({ name, points });
  }
  // Legacy "other" (unlabelled) markers — also listed with the labelled ones below.
  for (let i = 0, n = count(); i < n; i++) r.skip(12);
  for (let i = 0, n = count(); i < n; i++) frame.rigidBodies.push(readRigidBody(r, v));
  if (atLeast(v, 2, 1)) {
    for (let i = 0, n = count(); i < n; i++) {
      const sk = { id: r.i32(), bones: [] };
      for (let j = 0, m = r.i32(); j < m; j++) sk.bones.push(readRigidBody(r, v));
      frame.skeletons.push(sk);
    }
  }
  if (atLeast(v, 4, 1)) {
    // Trained markersets ("assets"): rigid bodies (38 bytes) and markers (26 bytes) each.
    for (let i = 0, n = count(); i < n; i++) {
      r.i32(); // asset id
      r.skip(r.i32() * 38);
      r.skip(r.i32() * 26);
    }
  }
  if (atLeast(v, 2, 3)) {
    for (let i = 0, n = count(); i < n; i++) {
      const id = r.i32();
      const marker = { id: id & 0xffff, model: id >>> 16, position: r.vec3(), size: r.f32() };
      if (atLeast(v, 2, 6)) marker.params = r.i16();
      if (v[0] >= 3) marker.residual = r.f32();
      frame.markers.push(marker);
    }
  }
  // Force plates and devices: skipped, but walked to reach the timestamp.
  const skipChannels = () => {
    for (let i = 0, n = count(); i < n; i++) {
      r.i32(); // id
      for (let c = 0, channels = r.i32(); c < channels; c++) r.skip(r.i32() * 4);
    }
  };
  if (atLeast(v, 2, 9)) skipChannels();
  if (atLeast(v, 2, 11)) skipChannels();
  r.u32(); // timecode
  r.u32(); // timecode sub-frame
  frame.timestamp = atLeast(v, 2, 7) ? r.f64() : r.f32();
  return frame;
}

// Names of marker sets, rigid bodies and skeletons (NAT_MODELDEF). NatNet 4.1 may put
// each description's size in bytes after its type; rather than guess, both readings are
// tried and the sized one is kept only if every description ends exactly where its size says.
function readModelDef(r, v) {
  const start = r.o;
  if (sizedSections(v)) {
    try {
      return readModelDefWith(r, v, true);
    } catch {
      r.o = start;
    }
  }
  return readModelDefWith(r, v, false);
}

function readModelDefWith(r, v, sized) {
  const out = { markerSets: [], rigidBodies: new Map(), skeletons: new Map() };
  const readRigidBodyDesc = () => {
    const desc = { name: v[0] >= 2 || v[0] === 0 ? r.str() : "", id: r.i32(), parent: r.i32(), offset: r.vec3() };
    if (v[0] >= 3 || v[0] === 0) {
      const n = r.i32();
      r.skip(n * 12 + n * 4); // marker offsets, active labels
      if (v[0] >= 4 || v[0] === 0) for (let i = 0; i < n; i++) r.str(); // marker names
    }
    return desc;
  };
  for (let i = 0, n = r.i32(); i < n; i++) {
    const type = r.i32();
    const size = sized ? r.i32() : -1;
    const begin = r.o;
    if (type === 0) {
      const name = r.str();
      const labels = [];
      for (let j = 0, m = r.i32(); j < m; j++) labels.push(r.str());
      out.markerSets.push({ name, labels });
    } else if (type === 1) {
      const d = readRigidBodyDesc();
      out.rigidBodies.set(d.id, d.name);
    } else if (type === 2) {
      const name = r.str();
      const id = r.i32();
      const bones = new Map();
      for (let j = 0, m = r.i32(); j < m; j++) {
        const d = readRigidBodyDesc();
        bones.set(d.id, d.name);
      }
      out.skeletons.set(id, { name, bones });
    } else if (sized) {
      r.skip(size); // force plates, devices, cameras, assets: not needed
      continue;
    } else break; // without sizes these can't be skipped; they come after the ones needed
    if (sized && r.o - begin !== size) throw new Error("description size mismatch");
  }
  return out;
}

function packet(id, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(id, 0);
  head.writeUInt16LE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

function connectPacket() {
  // "Ping", padded to 264 bytes, then the NatNet version this client speaks (4.1).
  const payload = Buffer.alloc(270);
  payload.write("Ping", 0, "ascii");
  payload[265] = 4;
  payload[266] = 1;
  return packet(NAT.CONNECT, Buffer.concat([payload, Buffer.from([0])]));
}

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
    this.version = [0, 0, 0, 0];
    this.names = null;
    this.timers = [];
    this.sockets = [];
    this.lastFrameAt = 0;
  }

  start(options = {}) {
    this.stop();
    const opts = { ...DEFAULTS, ...options };
    this.opts = opts;
    this.version = [0, 0, 0, 0];
    this.names = null;
    this.server = null;
    this.lastFrameAt = 0;
    const local = localInterfaceFor(opts.server);
    this.status({ state: "waiting" });

    const command = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.sockets.push(command);
    command.on("message", (msg) => this.handle(msg));
    command.on("error", (err) => this.status({ state: "stopped", error: err.message }));
    command.bind(0, opts.multicast ? undefined : local, () => {
      const hello = () => {
        if (!this.server) command.send(connectPacket(), opts.commandPort, opts.server);
        else if (!this.names) command.send(packet(NAT.REQUEST_MODELDEF), opts.commandPort, opts.server);
        if (!opts.multicast && this.server) command.send(packet(NAT.KEEPALIVE), opts.commandPort, opts.server);
        // No frames for a while: Motive was closed or stopped streaming.
        if (this.server && this.lastFrameAt && Date.now() - this.lastFrameAt > 3000) {
          this.server = null;
          this.status({ state: "waiting" });
        }
      };
      hello();
      this.timers.push(setInterval(hello, 1000));
    });

    if (opts.multicast) {
      const data = dgram.createSocket({ type: "udp4", reuseAddr: true });
      this.sockets.push(data);
      data.on("message", (msg) => this.handle(msg));
      data.on("error", (err) => this.status({ state: "stopped", error: err.message }));
      data.bind(opts.dataPort, () => {
        try {
          data.addMembership(opts.multicastAddress, local);
        } catch (err) {
          this.status({ state: "stopped", error: `Couldn't join Motive's multicast group ${opts.multicastAddress} on ${local}: ${err.message}` });
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
    if (this.opts) this.status({ state: "stopped" });
    this.opts = null;
  }

  status(s) {
    this.lastStatus = { server: this.opts && this.opts.server, app: this.app, version: this.version.slice(0, 2).join("."), ...s };
    this.emit("status", this.lastStatus);
  }

  handle(msg) {
    if (msg.length < 4) return;
    const id = msg.readUInt16LE(0);
    const r = new Reader(msg, 4);
    try {
      if (id === NAT.SERVERINFO) {
        this.app = r.fixedStr(256);
        const appVersion = [r.u8(), r.u8(), r.u8(), r.u8()];
        this.version = [r.u8(), r.u8(), r.u8(), r.u8()];
        this.appVersion = appVersion.join(".");
        this.server = this.opts.server;
        this.status({ state: "connected", appVersion: this.appVersion });
        if (this.sockets[0]) this.sockets[0].send(packet(NAT.REQUEST_MODELDEF), this.opts.commandPort, this.opts.server);
      } else if (id === NAT.MODELDEF) {
        if (this.version[0] === 0) return;
        this.names = readModelDef(r, this.version);
      } else if (id === NAT.FRAMEOFDATA) {
        if (this.version[0] === 0) return; // don't know the layout until Motive has said which NatNet it speaks
        const f = readFrame(r, this.version);
        this.lastFrameAt = Date.now();
        if (!this.server) {
          this.server = this.opts.server;
          this.status({ state: "connected", appVersion: this.appVersion });
        }
        // Names, where Motive has told us them (a new rigid body asks again).
        const names = this.names;
        for (const rb of f.rigidBodies) rb.name = (names && names.rigidBodies.get(rb.id)) || `Rigid body ${rb.id}`;
        for (const sk of f.skeletons) {
          const desc = names && names.skeletons.get(sk.id);
          sk.name = desc ? desc.name : `Skeleton ${sk.id}`;
          for (const b of sk.bones) b.name = (desc && desc.bones.get(b.id & 0xffff)) || `Bone ${b.id & 0xffff}`;
        }
        if (names && f.rigidBodies.some((rb) => !names.rigidBodies.has(rb.id))) this.names = null;
        this.emit("frame", f);
      }
    } catch (err) {
      // A packet this client can't read (a newer NatNet?): say so once, keep listening.
      if (!this.warned) {
        this.warned = true;
        this.emit("warning", `Couldn't read a NatNet packet (message ${id}, NatNet ${this.version.join(".")}): ${err.message}`);
      }
    }
  }
}

module.exports = { NatNetClient, readFrame, readModelDef, NAT, localInterfaceFor };
