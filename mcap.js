/**
 * mcap.js — MCAP files (https://mcap.dev), the container ROS 2 and Foxglove record into:
 * writing them with ROS 2 messages (CDR), and reading them back.
 *
 *   const w = Mcap.writer({ profile: "ros2", library: "Hand Tracker" });
 *   const schema = w.schema("geometry_msgs/msg/PoseArray", "ros2msg", Mcap.ROS2.PoseArray);
 *   const channel = w.channel("/topic", "cdr", schema, { offered_qos_profiles: Mcap.QOS });
 *   w.message(channel, timeNs, bytes);           // timeNs: a BigInt, nanoseconds since 1970
 *   w.attachment(name, mediaType, bytes, timeNs); w.metadata(name, { key: "value" });
 *   const bytes = w.finish();                    // -> Uint8Array
 *
 *   const file = Mcap.read(bytes);  // { profile, library, schemas, channels: Map id ->
 *                                   //   { topic, messageEncoding, schema, metadata }, messages:
 *                                   //   [{ channel, sequence, logTime, data }], attachments, metadata }
 *
 *   Mcap.cdr.poseArray(timeNs, frameId, poses)   // ROS 2 messages, CDR-encoded (poses: [{ p, q }])
 *   Mcap.cdr.markerArray(markers) / Mcap.cdr.decode(schemaName, bytes)
 *
 * Messages are written in chunks of about 1 MB, uncompressed, with an index and summary, as
 * `ros2 bag` and Foxglove read best. Chunks compressed with lz4 or zstd (ROS 2's recorder
 * compresses with zstd) are read too (zstd with fzstd, node_modules/fzstd/umd/index.js).
 */

(function (global) {
  const MAGIC = [0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a];
  const OP = { header: 1, footer: 2, schema: 3, channel: 4, message: 5, chunk: 6, messageIndex: 7, chunkIndex: 8, attachment: 9, attachmentIndex: 10, statistics: 11, metadata: 12, metadataIndex: 13, summaryOffset: 14, dataEnd: 15 };
  const CHUNK_BYTES = 1 << 20;
  const utf8 = new TextEncoder(), fromUtf8 = new TextDecoder();

  // ---------- CRC32 ----------
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes, crc = 0) {
    let c = ~crc >>> 0;
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
  }

  // ---------- bytes ----------
  class Bytes {
    constructor(size = 1024) {
      this.buf = new Uint8Array(size);
      this.view = new DataView(this.buf.buffer);
      this.length = 0;
    }
    room(n) {
      if (this.length + n <= this.buf.length) return;
      let size = this.buf.length * 2;
      while (size < this.length + n) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(0, this.length));
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
    u8(v) { this.room(1); this.buf[this.length++] = v; return this; }
    u16(v) { this.room(2); this.view.setUint16(this.length, v, true); this.length += 2; return this; }
    u32(v) { this.room(4); this.view.setUint32(this.length, v >>> 0, true); this.length += 4; return this; }
    u64(v) { this.room(8); this.view.setBigUint64(this.length, BigInt(v), true); this.length += 8; return this; }
    raw(bytes) { this.room(bytes.length); this.buf.set(bytes, this.length); this.length += bytes.length; return this; }
    str(s) { const b = utf8.encode(String(s)); return this.u32(b.length).raw(b); }
    map(obj) { // Map<string, string>
      const inner = new Bytes(64);
      for (const [k, v] of Object.entries(obj || {})) inner.str(k).str(v);
      return this.u32(inner.length).raw(inner.bytes());
    }
    bytes() { return this.buf.subarray(0, this.length); }
  }
  // One record: <opcode><uint64 length><content>.
  const record = (out, op, content) => out.u8(op).u64(content.length).raw(content);

  // ---------- writing ----------
  function writer({ profile = "", library = "Hand Tracker" } = {}) {
    const out = new Bytes(1 << 16);
    out.raw(MAGIC);
    record(out, OP.header, new Bytes(64).str(profile).str(library).bytes());
    const schemas = [], channels = [], attachIndex = [], metaIndex = [], chunkIndex = [];
    const counts = new Map();
    let messageCount = 0n, start = null, end = null, sequence = 0;
    let chunk = null; // { records: Bytes, start, end, index: Map channel -> [[time, offset]] }

    function flushChunk() {
      if (!chunk || !chunk.records.length) return;
      const recs = chunk.records.bytes();
      const content = new Bytes(recs.length + 64)
        .u64(chunk.start).u64(chunk.end).u64(recs.length).u32(crc32(recs)).str("").u64(recs.length).raw(recs).bytes();
      const chunkStart = out.length;
      record(out, OP.chunk, content);
      const chunkLength = out.length - chunkStart;
      const offsets = {};
      const indexStart = out.length;
      for (const [id, entries] of chunk.index) {
        offsets[id] = out.length;
        const list = new Bytes(entries.length * 16 + 8);
        for (const [t, o] of entries) list.u64(t).u64(o);
        record(out, OP.messageIndex, new Bytes(list.length + 8).u16(id).u32(list.length).raw(list.bytes()).bytes());
      }
      chunkIndex.push({ start: chunk.start, end: chunk.end, chunkStart, chunkLength, offsets, indexLength: out.length - indexStart, size: recs.length });
      chunk = null;
    }

    return {
      schema(name, encoding, text) {
        flushChunk();
        const id = schemas.length + 1;
        const data = typeof text === "string" ? utf8.encode(text) : text;
        const content = new Bytes(data.length + 64).u16(id).str(name).str(encoding).u32(data.length).raw(data).bytes();
        schemas.push(content);
        record(out, OP.schema, content);
        return id;
      },
      channel(topic, messageEncoding, schemaId, metadata = {}) {
        flushChunk();
        const id = channels.length + 1;
        const content = new Bytes(256).u16(id).u16(schemaId).str(topic).str(messageEncoding).map(metadata).bytes();
        channels.push(content);
        record(out, OP.channel, content);
        counts.set(id, 0n);
        return id;
      },
      message(channelId, timeNs, data) {
        const t = BigInt(timeNs);
        if (!chunk) chunk = { records: new Bytes(1 << 16), start: t, end: t, index: new Map() };
        if (t < chunk.start) chunk.start = t;
        if (t > chunk.end) chunk.end = t;
        if (!chunk.index.has(channelId)) chunk.index.set(channelId, []);
        chunk.index.get(channelId).push([t, chunk.records.length]);
        record(chunk.records, OP.message, new Bytes(data.length + 22).u16(channelId).u32(sequence++).u64(t).u64(t).raw(data).bytes());
        counts.set(channelId, (counts.get(channelId) || 0n) + 1n);
        messageCount++;
        if (start === null || t < start) start = t;
        if (end === null || t > end) end = t;
        if (chunk.records.length >= CHUNK_BYTES) flushChunk();
      },
      attachment(name, mediaType, data, timeNs = 0n) {
        flushChunk();
        const head = new Bytes(data.length + 128).u64(timeNs).u64(timeNs).str(name).str(mediaType).u64(data.length).raw(data);
        const content = new Bytes(head.length + 4).raw(head.bytes()).u32(crc32(head.bytes())).bytes();
        const offset = out.length;
        record(out, OP.attachment, content);
        attachIndex.push({ offset, length: out.length - offset, time: BigInt(timeNs), size: data.length, name, mediaType });
      },
      metadata(name, map) {
        flushChunk();
        const offset = out.length;
        record(out, OP.metadata, new Bytes(256).str(name).map(map).bytes());
        metaIndex.push({ offset, length: out.length - offset, name });
      },
      finish() {
        flushChunk();
        record(out, OP.dataEnd, new Bytes(4).u32(crc32(out.bytes())).bytes());
        // The summary: each kind of record grouped, and where each group is.
        const summaryStart = out.length;
        const groups = [];
        const group = (op, contents) => {
          if (!contents.length) return;
          const at = out.length;
          for (const c of contents) record(out, op, c);
          groups.push([op, at, out.length - at]);
        };
        group(OP.schema, schemas);
        group(OP.channel, channels);
        const stats = new Bytes(128).u64(messageCount).u16(schemas.length).u32(channels.length).u32(attachIndex.length).u32(metaIndex.length)
          .u32(chunkIndex.length).u64(start === null ? 0n : start).u64(end === null ? 0n : end);
        const perChannel = new Bytes(64);
        for (const [id, n] of counts) perChannel.u16(id).u64(n);
        stats.u32(perChannel.length).raw(perChannel.bytes());
        group(OP.statistics, [stats.bytes()]);
        group(OP.chunkIndex, chunkIndex.map((c) => {
          const offs = new Bytes(64);
          for (const [id, o] of Object.entries(c.offsets)) offs.u16(Number(id)).u64(o);
          return new Bytes(128).u64(c.start).u64(c.end).u64(c.chunkStart).u64(c.chunkLength).u32(offs.length).raw(offs.bytes())
            .u64(c.indexLength).str("").u64(c.size).u64(c.size).bytes();
        }));
        group(OP.attachmentIndex, attachIndex.map((a) => new Bytes(128).u64(a.offset).u64(a.length).u64(a.time).u64(a.time).u64(a.size).str(a.name).str(a.mediaType).bytes()));
        group(OP.metadataIndex, metaIndex.map((m) => new Bytes(64).u64(m.offset).u64(m.length).str(m.name).bytes()));
        const offsetStart = out.length;
        for (const [op, at, len] of groups) record(out, OP.summaryOffset, new Bytes(17).u8(op).u64(at).u64(len).bytes());
        // Footer: its CRC covers the summary up to its own summary_offset_start.
        const footHead = new Bytes(25).u8(OP.footer).u64(20).u64(summaryStart).u64(offsetStart).bytes();
        const crc = crc32(footHead, crc32(out.bytes().subarray(summaryStart)));
        out.raw(footHead).u32(crc).raw(MAGIC);
        return out.bytes().slice();
      },
    };
  }

  // ---------- reading ----------
  // Every record, in order (chunks opened), from the start of the file to its footer.
  function read(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < 16 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error("This isn't an MCAP file.");
    const file = { profile: "", library: "", schemas: new Map(), channels: new Map(), messages: [], attachments: [], metadata: [] };
    const take = (buf, start, end) => {
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      for (let at = start; at + 9 <= end; ) {
        const op = buf[at];
        const len = Number(view.getBigUint64(at + 1, true));
        const from = at + 9, to = from + len;
        if (to > end) throw new Error("This MCAP file is cut short.");
        const r = reader(buf, from, to);
        if (op === OP.header) {
          file.profile = r.str();
          file.library = r.str();
        } else if (op === OP.schema) {
          const id = r.u16(), name = r.str(), encoding = r.str(), data = r.bytes(r.u32());
          if (id && !file.schemas.has(id)) file.schemas.set(id, { id, name, encoding, data: fromUtf8.decode(data) });
        } else if (op === OP.channel) {
          const id = r.u16(), schemaId = r.u16(), topic = r.str(), messageEncoding = r.str(), metadata = r.map();
          if (!file.channels.has(id)) file.channels.set(id, { id, schemaId, topic, messageEncoding, metadata });
        } else if (op === OP.message) {
          const channel = r.u16(), sequence = r.u32(), logTime = r.u64();
          r.u64(); // publish time
          file.messages.push({ channel, sequence, logTime, data: buf.subarray(r.at, to) });
        } else if (op === OP.chunk) {
          r.u64(); r.u64();
          const size = Number(r.u64());
          r.u32();
          const compression = r.str();
          const data = r.bytes(Number(r.u64()));
          const records = compression === "" ? data : compression === "lz4" ? lz4Frame(data, size) : compression === "zstd" ? zstd(data, size) : null;
          if (!records) throw new Error(`This MCAP file's data is compressed with ${compression}, which Hand Tracker can't read.`);
          take(records, 0, records.length);
        } else if (op === OP.attachment) {
          const logTime = r.u64();
          r.u64();
          const name = r.str(), mediaType = r.str(), data = r.bytes(Number(r.u64()));
          file.attachments.push({ name, mediaType, logTime, data });
        } else if (op === OP.metadata) {
          file.metadata.push({ name: r.str(), metadata: r.map() });
        } else if (op === OP.dataEnd) {
          return true; // the summary repeats what's been read
        }
        at = to;
      }
      return false;
    };
    take(bytes, MAGIC.length, bytes.length - MAGIC.length);
    for (const c of file.channels.values()) c.schema = file.schemas.get(c.schemaId) || null;
    file.messages.sort((a, b) => (a.logTime < b.logTime ? -1 : a.logTime > b.logTime ? 1 : 0));
    return file;
  }

  function reader(buf, from, to) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const r = {
      at: from,
      need(n) { if (r.at + n > to) throw new Error("This MCAP file has a broken record."); },
      u16() { r.need(2); const v = view.getUint16(r.at, true); r.at += 2; return v; },
      u32() { r.need(4); const v = view.getUint32(r.at, true); r.at += 4; return v; },
      u64() { r.need(8); const v = view.getBigUint64(r.at, true); r.at += 8; return v; },
      bytes(n) { r.need(n); const v = buf.subarray(r.at, r.at + n); r.at += n; return v; },
      str() { return fromUtf8.decode(r.bytes(r.u32())); },
      map() {
        const length = r.u32(), end = r.at + length;
        const out = {};
        while (r.at < end) out[r.str()] = r.str();
        return out;
      },
    };
    return r;
  }

  // LZ4 frames (https://github.com/lz4/lz4/blob/dev/doc/lz4_Frame_format.md).
  function lz4Frame(src, size) {
    const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
    if (view.getUint32(0, true) !== 0x184d2204) throw new Error("A chunk of this MCAP file isn't valid LZ4.");
    const flg = src[4];
    let at = 7 + (flg & 0x08 ? 8 : 0) + (flg & 0x01 ? 4 : 0);
    const out = new Uint8Array(size);
    let o = 0;
    for (;;) {
      const word = view.getUint32(at, true);
      at += 4;
      if (word === 0) break;
      const len = word & 0x7fffffff;
      if (word & 0x80000000) {
        out.set(src.subarray(at, at + len), o);
        o += len;
      } else {
        o = lz4Block(src, at, at + len, out, o);
      }
      at += len + (flg & 0x10 ? 4 : 0);
    }
    return out.subarray(0, o);
  }
  function lz4Block(src, at, end, out, o) {
    while (at < end) {
      const token = src[at++];
      let lit = token >> 4;
      if (lit === 15) for (let b = 255; b === 255; ) lit += b = src[at++];
      out.set(src.subarray(at, at + lit), o);
      o += lit;
      at += lit;
      if (at >= end) break;
      const offset = src[at] | (src[at + 1] << 8);
      at += 2;
      let len = token & 15;
      if (len === 15) for (let b = 255; b === 255; ) len += b = src[at++];
      len += 4;
      for (let k = 0; k < len; k++, o++) out[o] = out[o - offset];
    }
    return o;
  }
  function zstd(data, size) {
    const z = global.fzstd;
    if (!z) return null;
    return z.decompress(data, new Uint8Array(size));
  }

  // ---------- ROS 2 messages (CDR, little endian) ----------
  // The .msg definitions, as ROS 2 Humble, Iron and Jazzy have them (their layout is the same).
  const SEP = "\n================================================================================\nMSG: ";
  const MSG = {
    "std_msgs/Header": "builtin_interfaces/Time stamp\nstring frame_id\n",
    "builtin_interfaces/Time": "int32 sec\nuint32 nanosec\n",
    "builtin_interfaces/Duration": "int32 sec\nuint32 nanosec\n",
    "geometry_msgs/Pose": "Point position\nQuaternion orientation\n",
    "geometry_msgs/Point": "float64 x\nfloat64 y\nfloat64 z\n",
    "geometry_msgs/Quaternion": "float64 x 0\nfloat64 y 0\nfloat64 z 0\nfloat64 w 1\n",
    "geometry_msgs/Vector3": "float64 x\nfloat64 y\nfloat64 z\n",
    "std_msgs/ColorRGBA": "float32 r\nfloat32 g\nfloat32 b\nfloat32 a\n",
    "sensor_msgs/CompressedImage": "std_msgs/Header header\nstring format\nuint8[] data\n",
    "visualization_msgs/UVCoordinate": "float32 u\nfloat32 v\n",
    "visualization_msgs/MeshFile": "string filename\nuint8[] data\n",
    "visualization_msgs/Marker":
      "int32 ARROW=0\nint32 CUBE=1\nint32 SPHERE=2\nint32 CYLINDER=3\nint32 LINE_STRIP=4\nint32 LINE_LIST=5\nint32 CUBE_LIST=6\nint32 SPHERE_LIST=7\n" +
      "int32 POINTS=8\nint32 TEXT_VIEW_FACING=9\nint32 MESH_RESOURCE=10\nint32 TRIANGLE_LIST=11\nint32 ADD=0\nint32 MODIFY=0\nint32 DELETE=2\nint32 DELETEALL=3\n" +
      "std_msgs/Header header\nstring ns\nint32 id\nint32 type\nint32 action\ngeometry_msgs/Pose pose\ngeometry_msgs/Vector3 scale\n" +
      "std_msgs/ColorRGBA color\nbuiltin_interfaces/Duration lifetime\nbool frame_locked\ngeometry_msgs/Point[] points\nstd_msgs/ColorRGBA[] colors\n" +
      "string texture_resource\nsensor_msgs/CompressedImage texture\nUVCoordinate[] uv_coordinates\nstring text\nstring mesh_resource\n" +
      "MeshFile mesh_file\nbool mesh_use_embedded_materials\n",
  };
  const withDeps = (top, deps) => top + deps.map((d) => SEP + d + "\n" + MSG[d]).join("");
  const ROS2 = {
    PoseArray: withDeps("std_msgs/Header header\nPose[] poses\n", ["std_msgs/Header", "builtin_interfaces/Time", "geometry_msgs/Pose", "geometry_msgs/Point", "geometry_msgs/Quaternion"]),
    MarkerArray: withDeps("Marker[] markers\n", [
      "visualization_msgs/Marker", "std_msgs/Header", "builtin_interfaces/Time", "geometry_msgs/Pose", "geometry_msgs/Point", "geometry_msgs/Quaternion",
      "geometry_msgs/Vector3", "std_msgs/ColorRGBA", "builtin_interfaces/Duration", "sensor_msgs/CompressedImage", "visualization_msgs/UVCoordinate", "visualization_msgs/MeshFile",
    ]),
  };
  // What ROS 2's recorder writes for a topic's QoS (numbers, which every distro reads).
  const QOS = "- history: 3\n  depth: 0\n  reliability: 1\n  durability: 2\n  deadline:\n    sec: 2147483647\n    nsec: 4294967295\n" +
    "  lifespan:\n    sec: 2147483647\n    nsec: 4294967295\n  liveliness: 1\n  liveliness_lease_duration:\n    sec: 2147483647\n    nsec: 4294967295\n" +
    "  avoid_ros_namespace_conventions: false\n";

  // CDR: a 4-byte header (little endian), then each value aligned to its size from after it.
  class Cdr extends Bytes {
    constructor() {
      super(512);
      this.raw([0, 1, 0, 0]);
    }
    align(n) { while ((this.length - 4) % n) this.u8(0); return this; }
    i32(v) { this.align(4); this.room(4); this.view.setInt32(this.length, v, true); this.length += 4; return this; }
    ui32(v) { this.align(4); return this.u32(v); }
    f32(v) { this.align(4); this.room(4); this.view.setFloat32(this.length, v, true); this.length += 4; return this; }
    f64(v) { this.align(8); this.room(8); this.view.setFloat64(this.length, v, true); this.length += 8; return this; }
    bool(v) { return this.u8(v ? 1 : 0); }
    string(s) { const b = utf8.encode(String(s)); this.ui32(b.length + 1); return this.raw(b).u8(0); }
    time(ns) { const t = BigInt(ns); return this.i32(Number(t / 1000000000n)).ui32(Number(t % 1000000000n)); }
    header(ns, frameId) { return this.time(ns).string(frameId); }
    point(p) { return this.f64(p[0]).f64(p[1]).f64(p[2]); }
    pose(p, q) { return this.point(p).f64(q[0]).f64(q[1]).f64(q[2]).f64(q[3]); }
    color(c) { return this.f32(c[0]).f32(c[1]).f32(c[2]).f32(c.length > 3 ? c[3] : 1); }
  }

  const cdr = {
    // geometry_msgs/msg/PoseArray. poses: [{ p: [x, y, z] (m), q: [x, y, z, w] }]
    poseArray(timeNs, frameId, poses) {
      const w = new Cdr().header(timeNs, frameId).ui32(poses.length);
      for (const { p, q } of poses) w.pose(p, q || [0, 0, 0, 1]);
      return w.bytes().slice();
    },
    // visualization_msgs/msg/MarkerArray. markers: [{ timeNs, frameId, ns, id, type, action,
    // scale: [x, y, z], color: [r, g, b, a], lifetimeNs, points: [[x, y, z]] }]
    markerArray(markers) {
      const w = new Cdr().ui32(markers.length);
      for (const m of markers) {
        w.header(m.timeNs, m.frameId).string(m.ns || "").i32(m.id || 0).i32(m.type || 0).i32(m.action || 0)
          .pose([0, 0, 0], [0, 0, 0, 1]).point(m.scale || [1, 1, 1]).color(m.color || [1, 1, 1, 1]);
        const life = BigInt(m.lifetimeNs || 0);
        w.i32(Number(life / 1000000000n)).ui32(Number(life % 1000000000n));
        w.bool(false).ui32((m.points || []).length);
        for (const p of m.points || []) w.point(p);
        w.ui32(0); // colors
        w.string(""); // texture_resource
        w.header(0n, "").string("").ui32(0); // texture (an empty CompressedImage)
        w.ui32(0); // uv_coordinates
        w.string(m.text || "").string(""); // text, mesh_resource
        w.string("").ui32(0); // mesh_file
        w.bool(false);
      }
      return w.bytes().slice();
    },
    // The positions in a message of a kind that holds some: PoseArray, PoseStamped, PointStamped.
    // -> { stamp (ns), frameId, points: [[x, y, z]] } or null for other kinds.
    decode(schemaName, data) {
      const kind = String(schemaName).replace("/msg/", "/");
      if (!["geometry_msgs/PoseArray", "geometry_msgs/PoseStamped", "geometry_msgs/PointStamped"].includes(kind)) return null;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const little = data[1] === 1 || data[1] === 3;
      let at = 4;
      const align = (n) => { at += (n - ((at - 4) % n)) % n; };
      const u32 = () => { align(4); const v = view.getUint32(at, little); at += 4; return v; };
      const i32 = () => { align(4); const v = view.getInt32(at, little); at += 4; return v; };
      const f64 = () => { align(8); const v = view.getFloat64(at, little); at += 8; return v; };
      const sec = i32(), nsec = u32();
      const len = u32();
      const frameId = fromUtf8.decode(data.subarray(at, at + Math.max(0, len - 1)));
      at += len;
      const point = () => [f64(), f64(), f64()];
      const pose = () => { const p = point(); f64(); f64(); f64(); f64(); return p; };
      const points = kind === "geometry_msgs/PoseArray" ? Array.from({ length: u32() }, pose) : kind === "geometry_msgs/PoseStamped" ? [pose()] : [point()];
      return { stamp: BigInt(sec) * 1000000000n + BigInt(nsec), frameId, points };
    },
  };

  global.Mcap = { writer, read, cdr, ROS2, QOS, crc32 };
})(typeof window !== "undefined" ? window : globalThis);
