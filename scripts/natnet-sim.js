/**
 * natnet-sim.js — a stand-in for OptiTrack Motive's NatNet stream, for the automated
 * checks. It answers the connect handshake and model-definition requests, and streams
 * frames (NatNet 4.1 layout, as in NaturalPoint's reference NatNetClient.py) with three
 * labelled markers on a rigid body "Wand" circling the origin, plus a two-bone skeleton.
 *
 *   const sim = await startNatNetSim({ rate: 120, version: [4, 1] });   // unicast on 127.0.0.1:1510
 *   version: the NatNet version to speak (4.1 adds section sizes and assets; 3.x/4.0 don't)
 *   multicast: send frames to 239.255.42.99:1511 on 127.0.0.1 (Motive's default) instead of to each client
 *   host: the address to listen on (default 127.0.0.1; this PC's network address to reach a phone),
 *     and the interface multicast goes out on
 *   sim.framesSent; sim.stop();
 */

const dgram = require("dgram");

class Writer {
  constructor() {
    this.parts = [];
  }
  i32(v) { const b = Buffer.alloc(4); b.writeInt32LE(v); this.parts.push(b); return this; }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v); this.parts.push(b); return this; }
  i16(v) { const b = Buffer.alloc(2); b.writeInt16LE(v); this.parts.push(b); return this; }
  f32(v) { const b = Buffer.alloc(4); b.writeFloatLE(v); this.parts.push(b); return this; }
  f64(v) { const b = Buffer.alloc(8); b.writeDoubleLE(v); this.parts.push(b); return this; }
  u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); this.parts.push(b); return this; }
  bytes(arr) { this.parts.push(Buffer.from(arr)); return this; }
  str(s) { this.parts.push(Buffer.from(s + "\0", "utf8")); return this; }
  // A section: count, then (NatNet 4.1+) its size in bytes, then the items.
  section(count, fill) {
    const inner = new Writer();
    fill(inner);
    const body = inner.buf();
    this.i32(count);
    if (this.sized) this.i32(body.length);
    this.parts.push(body);
    return this;
  }
  buf() { return Buffer.concat(this.parts); }
}

const packet = (id, payload) => {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(id, 0);
  head.writeUInt16LE(payload.length, 2);
  return Buffer.concat([head, payload]);
};

const RIGID_BODY_ID = 7;
const SKELETON_ID = 3;
const MARKER_OFFSETS = [[0.05, 0, 0], [-0.03, 0.02, 0.01], [0, -0.04, 0.03]]; // metres, around the wand

function serverInfo(v) {
  const name = Buffer.alloc(256);
  name.write("Motive", "utf8");
  return packet(1, Buffer.concat([name, Buffer.from([3, 5, 0, 0]), Buffer.from([v[0], v[1], 0, 0]), Buffer.alloc(16)]));
}

function modelDef(v) {
  const sized = v[0] > 4 || (v[0] === 4 && v[1] >= 1);
  const w = new Writer();
  w.i32(3); // descriptions: marker set, rigid body, skeleton
  // Marker set (type 0). NatNet 4.1 puts each description's size after its type.
  const ms = new Writer().str("Wand").i32(3).str("Wand_1").str("Wand_2").str("Wand_3").buf();
  w.i32(0);
  if (sized) w.i32(ms.length);
  w.bytes(ms);
  const rbDesc = (name, id, parent, markers) => {
    const d = new Writer().str(name).i32(id).i32(parent).f32(0).f32(0).f32(0).i32(markers.length);
    for (const m of markers) d.f32(m[0]).f32(m[1]).f32(m[2]);
    for (let i = 0; i < markers.length; i++) d.i32(i + 1);
    if (v[0] >= 4) for (let i = 0; i < markers.length; i++) d.str(`${name}_${i + 1}`);
    return d.buf();
  };
  const rb = rbDesc("Wand", RIGID_BODY_ID, -1, MARKER_OFFSETS);
  w.i32(1);
  if (sized) w.i32(rb.length);
  w.bytes(rb);
  const bones = [rbDesc("Hip", 1, 0, []), rbDesc("Chest", 2, 1, [])];
  const sk = new Writer().str("Performer").i32(SKELETON_ID).i32(bones.length);
  for (const b of bones) sk.bytes(b);
  const skb = sk.buf();
  w.i32(2);
  if (sized) w.i32(skb.length);
  w.bytes(skb);
  return packet(5, w.buf());
}

// The wand's position at time t (seconds): a 0.3 m circle, 1 m up (Motive is Y-up).
const wandAt = (t) => [0.3 * Math.cos(t), 1.0, 0.3 * Math.sin(t)];

function frame(n, t, v) {
  const c = wandAt(t);
  const w = new Writer();
  w.sized = v[0] > 4 || (v[0] === 4 && v[1] >= 1);
  w.i32(n);
  w.section(1, (s) => {
    s.str("Wand").i32(3);
    for (const o of MARKER_OFFSETS) s.f32(c[0] + o[0]).f32(c[1] + o[1]).f32(c[2] + o[2]);
  });
  w.section(0, () => {}); // legacy "other" markers
  w.section(1, (s) => s.i32(RIGID_BODY_ID).f32(c[0]).f32(c[1]).f32(c[2]).f32(0).f32(0).f32(0).f32(1).f32(0.0002).i16(1));
  w.section(1, (s) => {
    s.i32(SKELETON_ID).i32(2);
    s.i32((SKELETON_ID << 16) | 1).f32(0).f32(0.9).f32(0).f32(0).f32(0).f32(0).f32(1).f32(0).i16(1);
    s.i32((SKELETON_ID << 16) | 2).f32(0).f32(1.3).f32(0).f32(0).f32(0).f32(0).f32(1).f32(0).i16(1);
  });
  if (w.sized) w.section(0, () => {}); // assets (NatNet 4.1+)
  w.section(4, (s) => {
    MARKER_OFFSETS.forEach((o, i) => s.i32((RIGID_BODY_ID << 16) | (i + 1)).f32(c[0] + o[0]).f32(c[1] + o[1]).f32(c[2] + o[2]).f32(0.014).i16(0).f32(0.0003));
    s.i32((0 << 16) | 50001).f32(1).f32(0.5).f32(-1).f32(0.014).i16(0).f32(0); // one unlabelled marker
  });
  w.section(0, () => {}); // force plates
  w.section(0, () => {}); // devices
  w.u32(0).u32(0).f64(t).u64(0).u64(0).u64(0).i16(0).i32(0); // suffix: timecode, timestamp, stamps, params, end
  return packet(7, w.buf());
}

function startNatNetSim({ rate = 120, port = 1510, version = [4, 1], multicast = false, host = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    const clients = new Map();
    const start = Date.now();
    let n = 0;
    const sim = { framesSent: 0, clients, stop: () => { clearInterval(timer); sock.close(); } };
    sock.on("message", (msg, from) => {
      const id = msg.readUInt16LE(0);
      const key = `${from.address}:${from.port}`;
      if (id === 0) {
        clients.set(key, from);
        sock.send(serverInfo(version), from.port, from.address);
      } else if (id === 4) sock.send(modelDef(version), from.port, from.address);
    });
    sock.on("error", reject);
    // Paced by the clock, not by the timer: Windows' timers often tick only every 15.6 ms,
    // which would cap a 100 Hz stream at about 64 Hz. Each tick sends the frames now due.
    const timer = setInterval(() => {
      const due = Math.floor(((Date.now() - start) / 1000) * rate);
      while (n < due) {
        const p = frame(++n, n / rate, version);
        if (multicast) sock.send(p, 1511, "239.255.42.99");
        else for (const c of clients.values()) sock.send(p, c.port, c.address);
        sim.framesSent++;
      }
    }, Math.min(5, 1000 / rate));
    sock.bind(port, host, () => {
      if (multicast) {
        sock.setMulticastInterface(host);
        sock.setMulticastLoopback(true);
      }
      resolve(sim);
    });
  });
}

module.exports = { startNatNetSim, wandAt };
