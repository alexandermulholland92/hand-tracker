/**
 * natnet-parse.js — OptiTrack Motive's NatNet protocol, without the sockets: reading its
 * packets (NatNet 3.x and 4.x) and the conversation with Motive (connect, ask for names,
 * keep alive, notice when it stops). Shared by the Windows/Linux app (electron/natnet.js,
 * over Node's UDP sockets) and the Android app (mobile-bridge.js, over the NatNet plugin's).
 * Follows the layout of NaturalPoint's reference Python client (NatNetClient.py, Apache-2.0).
 *
 *   const session = new NatNetParse.Session({ server, multicast, send(bytes), onStatus(s), onFrame(f), onWarning(text) });
 *   session.hello();          // once a second: connects, asks for names, keeps unicast alive
 *   session.handle(bytes);    // every packet from Motive (Uint8Array or Buffer)
 *   session.readFrame(bytes)  // a recorded frame-of-data packet -> the frame (with names)
 *   NatNetParse.compactFrame(f) -> { n, t, markers, rigidBodies, skeletons } in mm, Z-up
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NatNetParse = api;
})(typeof self !== "undefined" ? self : this, function () {
  const NAT = {
    CONNECT: 0, SERVERINFO: 1, REQUEST: 2, RESPONSE: 3, REQUEST_MODELDEF: 4, MODELDEF: 5,
    REQUEST_FRAMEOFDATA: 6, FRAMEOFDATA: 7, MESSAGESTRING: 8, DISCONNECT: 9, KEEPALIVE: 10,
    UNRECOGNIZED_REQUEST: 100,
  };
  const DEFAULTS = { server: "127.0.0.1", multicast: true, multicastAddress: "239.255.42.99", commandPort: 1510, dataPort: 1511 };
  const utf8 = new TextDecoder("utf-8");

  // ---------- reading packets ----------
  class Reader {
    constructor(bytes, offset = 0) {
      this.b = bytes;
      this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.o = offset;
    }
    i32() { const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
    u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
    i16() { const v = this.dv.getInt16(this.o, true); this.o += 2; return v; }
    u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
    u8() { return this.dv.getUint8(this.o++); }
    f32() { const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
    f64() { const v = this.dv.getFloat64(this.o, true); this.o += 8; return v; }
    vec3() { return [this.f32(), this.f32(), this.f32()]; }
    quat() { return [this.f32(), this.f32(), this.f32(), this.f32()]; } // x, y, z, w
    skip(n) {
      this.o += n;
      if (this.o > this.b.length) throw new RangeError("Offset is outside the bounds of the packet");
    }
    str() {
      const end = this.b.indexOf(0, this.o);
      const stop = end < 0 ? this.b.length : end;
      const s = utf8.decode(this.b.subarray(this.o, stop));
      this.o = end < 0 ? this.b.length : end + 1;
      return s;
    }
    fixedStr(n) {
      const slice = this.b.subarray(this.o, this.o + n);
      this.o += n;
      const end = slice.indexOf(0);
      return utf8.decode(slice.subarray(0, end < 0 ? n : end));
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

  // ---------- writing packets ----------
  function packet(id, payload = new Uint8Array(0)) {
    const out = new Uint8Array(4 + payload.length);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, id, true);
    dv.setUint16(2, payload.length, true);
    out.set(payload, 4);
    return out;
  }

  function connectPacket() {
    // "Ping", padded to 264 bytes, then the NatNet version this client speaks (4.1).
    const payload = new Uint8Array(271);
    payload.set([0x50, 0x69, 0x6e, 0x67], 0); // "Ping"
    payload[265] = 4;
    payload[266] = 1;
    return packet(NAT.CONNECT, payload);
  }

  // A frame in the app's units: millimetres, Z-up (Motive streams metres, Y-up; this is the
  // same axis mapping as Motive's own C3D export, so it matches a .tak opened in the viewer).
  const MM = (p) => [-p[0] * 1000, p[2] * 1000, p[1] * 1000];
  function compactFrame(f) {
    return {
      n: f.frame,
      t: f.timestamp,
      markers: f.markers.map((m) => ({ id: m.id, model: m.model, p: MM(m.position) })),
      rigidBodies: f.rigidBodies.map((rb) => ({ id: rb.id, name: rb.name, p: MM(rb.position), q: rb.rotation, valid: rb.valid })),
      skeletons: f.skeletons.map((sk) => ({ id: sk.id, name: sk.name, bones: sk.bones.map((b) => ({ name: b.name, p: MM(b.position), valid: b.valid })) })),
    };
  }

  // ---------- the conversation with Motive ----------
  class Session {
    constructor({ server = DEFAULTS.server, multicast = true, send, onStatus, onFrame, onWarning }) {
      this.opts = { server, multicast };
      this.send = send;
      this.onStatus = onStatus || (() => {});
      this.onFrame = onFrame || (() => {});
      this.onWarning = onWarning || (() => {});
      this.version = [0, 0, 0, 0];
      this.names = null;
      this.server = null;
      this.app = undefined;
      this.appVersion = undefined;
      this.lastFrameAt = 0;
      this.warned = false;
      this.lastStatus = null;
    }

    status(s) {
      this.lastStatus = { server: this.opts.server, app: this.app, version: this.version.slice(0, 2).join("."), ...s };
      this.onStatus(this.lastStatus);
      return this.lastStatus;
    }

    hello() {
      if (!this.server) this.send(connectPacket());
      else if (!this.names) this.send(packet(NAT.REQUEST_MODELDEF));
      if (!this.opts.multicast && this.server) this.send(packet(NAT.KEEPALIVE));
      // No frames for a while: Motive was closed or stopped streaming.
      if (this.server && this.lastFrameAt && Date.now() - this.lastFrameAt > 3000) {
        this.server = null;
        this.status({ state: "waiting" });
      }
    }

    // A frame-of-data packet -> the frame, with the names Motive has told us.
    readFrame(bytes) {
      const f = readFrame(new Reader(bytes, 4), this.version);
      const names = this.names;
      for (const rb of f.rigidBodies) rb.name = (names && names.rigidBodies.get(rb.id)) || `Rigid body ${rb.id}`;
      for (const sk of f.skeletons) {
        const desc = names && names.skeletons.get(sk.id);
        sk.name = desc ? desc.name : `Skeleton ${sk.id}`;
        for (const b of sk.bones) b.name = (desc && desc.bones.get(b.id & 0xffff)) || `Bone ${b.id & 0xffff}`;
      }
      return f;
    }

    handle(bytes) {
      if (bytes.length < 4) return;
      const id = bytes[0] | (bytes[1] << 8);
      const r = new Reader(bytes, 4);
      try {
        if (id === NAT.SERVERINFO) {
          this.app = r.fixedStr(256);
          const appVersion = [r.u8(), r.u8(), r.u8(), r.u8()];
          this.version = [r.u8(), r.u8(), r.u8(), r.u8()];
          this.appVersion = appVersion.join(".");
          this.server = this.opts.server;
          this.status({ state: "connected", appVersion: this.appVersion });
          this.send(packet(NAT.REQUEST_MODELDEF));
        } else if (id === NAT.MODELDEF) {
          if (this.version[0] === 0) return;
          this.names = readModelDef(r, this.version);
        } else if (id === NAT.FRAMEOFDATA) {
          if (this.version[0] === 0) return; // don't know the layout until Motive has said which NatNet it speaks
          const f = this.readFrame(bytes);
          this.lastFrameAt = Date.now();
          if (!this.server) {
            this.server = this.opts.server;
            this.status({ state: "connected", appVersion: this.appVersion });
          }
          // A new rigid body: ask for the names again.
          if (this.names && f.rigidBodies.some((rb) => !this.names.rigidBodies.has(rb.id))) this.names = null;
          this.onFrame(f);
        }
      } catch (err) {
        // A packet this client can't read (a newer NatNet?): say so once, keep listening.
        if (!this.warned) {
          this.warned = true;
          this.onWarning(`Couldn't read a NatNet packet (message ${id}, NatNet ${this.version.join(".")}): ${err.message}`);
        }
      }
    }
  }

  return { NAT, DEFAULTS, Reader, readFrame, readModelDef, packet, connectPacket, compactFrame, Session };
});
