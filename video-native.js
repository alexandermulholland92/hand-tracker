/**
 * video-native.js — the video formats ffmpeg.wasm can't make on its own, for the Android
 * app and the website (video-convert.js uses it; the Windows and Linux apps have a real ffmpeg).
 *
 * ffmpeg.wasm has no AV1 encoder and its HEVC encoder (x265) hangs without threads, so HEVC,
 * AV1 (WebM and MP4) and animated AVIF are encoded by the device's own encoders (WebCodecs:
 * a phone's hardware HEVC encoder, the browser's AV1 one), from frames ffmpeg.wasm decodes a
 * stretch at a time; ffmpeg.wasm then puts them, with the sound, in their container (and an
 * AVIF gets the still-image boxes viewers look for). Uncompressed AVI and Y4M are huge, so
 * they're made a stretch at a time into a Blob of parts, never all in memory at once.
 *
 *   VideoNative.handles(id)        one of the formats made here
 *   await VideoNative.ready()      which of them this device can make (checked once)
 *   VideoNative.available(id)      after ready(): true / false
 *   VideoNative.why(id)            why not, when it can't
 *   await VideoNative.make({ id, ff, run, input, info, rate, retimeFps, trim, duration, onProgress, canceled })
 *     -> Uint8Array or Blob (the finished file)
 */

(function (global) {
  const IDS = ["hevc", "av1", "av1mp4", "avif", "y4m", "rawavi"];
  const RUN_BYTES = 48 * 1024 * 1024; // decoded frames per ffmpeg run
  const AUDIO_RATE = 48000;
  // An AVI over this is written as OpenDML (as ffmpeg does), in RIFF pieces of at most PIECE.
  const AVI_LIMITS = { single: 1000 * 1024 * 1024, piece: 900 * 1024 * 1024 };
  let checked = null;
  let known = null; // { hevc, av1 } once checked

  const handles = (id) => IDS.includes(id);

  // ---------- which encoders this device has ----------
  function hevcCodec(w, h, fps) {
    const ps = w * h * fps;
    const level = ps <= 1280 * 720 * 30 ? 93 : ps <= 1920 * 1080 * 30 ? 120 : ps <= 1920 * 1080 * 60 ? 123 : ps <= 3840 * 2160 * 30 ? 150 : 153;
    return `hvc1.1.6.L${level}.B0`;
  }
  function av1Codec(w, h, fps) {
    const ps = w * h * fps;
    const level = ps <= 1280 * 720 * 30 ? "05" : ps <= 1920 * 1080 * 30 ? "08" : ps <= 1920 * 1080 * 60 ? "09" : ps <= 3840 * 2160 * 30 ? "12" : "13";
    return `av01.0.${level}M.08`;
  }
  function encoderConfig(kind, w, h, fps) {
    const hevc = kind === "hevc";
    return {
      codec: hevc ? hevcCodec(w, h, fps) : av1Codec(w, h, fps),
      width: w,
      height: h,
      framerate: fps,
      // About what the desktop app's CRF settings come to for camera video.
      bitrate: Math.round(w * h * fps * (hevc ? 0.15 : 0.08)),
      bitrateMode: "variable",
      latencyMode: "quality",
      ...(hevc ? { hevc: { format: "annexb" } } : {}),
    };
  }
  const kindOf = (id) => (id === "hevc" ? "hevc" : "av1");

  function ready() {
    if (!checked) {
      checked = (async () => {
        const ok = async (cfg) => {
          try {
            return typeof global.VideoEncoder === "function" && (await global.VideoEncoder.isConfigSupported(cfg)).supported === true;
          } catch {
            return false;
          }
        };
        known = { hevc: await ok(encoderConfig("hevc", 1280, 720, 30)), av1: await ok(encoderConfig("av1", 1280, 720, 30)) };
        return known;
      })();
    }
    return checked;
  }

  function available(id) {
    if (id === "y4m" || id === "rawavi") return true;
    return !!known && known[kindOf(id)];
  }

  function why(id) {
    if (available(id)) return "";
    if (!known) return "Checking this device's video encoders…";
    return kindOf(id) === "hevc" ? "This device has no HEVC (H.265) encoder the app can use" : "This device has no AV1 encoder the app can use";
  }

  // ---------- frames, a run of ffmpeg at a time ----------
  const failure = (text) => {
    const lines = text.split("\n").filter((l) => /error|invalid|not supported|unsupported|could not|failed/i.test(l));
    return new Error((lines.pop() || "The conversion failed").trim());
  };
  let tmp = 0;
  const tmpName = (ext) => `/native-${Date.now()}-${++tmp}.${ext}`;

  // The picture as it comes out of `chain` (rotation and scaling applied): one frame's worth.
  async function outputSize(ff, run, input, chain, seek) {
    const out = tmpName("raw");
    const { code, text } = await run(ff, ["-y", ...seek, "-i", input, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", chain, "-frames:v", "1", "-pix_fmt", "yuv420p", "-f", "rawvideo", out]);
    await ff.deleteFile(out).catch(() => {});
    const m = /Output #0[\s\S]*?Video: rawvideo[^\n]*?, (\d+)x(\d+)/.exec(text);
    if (code !== 0 || !m) throw failure(text);
    return { width: Number(m[1]), height: Number(m[2]) };
  }

  // Calls each(bytes, first frame index, frame count) for the frames 0..total-1 of the
  // output, at `rate`. Seeks to each run's start; a re-timed recording (its frames played
  // at a set rate) can't be sought by time, so its runs pick frames by number instead.
  async function eachRun({ ff, run, input, start, total, rate, retimeFps, filters, pixFmt, frameBytes, canceled, each }) {
    const perRun = Math.max(1, Math.floor(RUN_BYTES / frameBytes));
    for (let k = 0; k < total; k += perRun) {
      if (canceled()) throw new Error("Canceled");
      const n = Math.min(perRun, total - k);
      const out = tmpName("raw");
      const chain = retimeFps
        ? [`setpts=N/(${retimeFps}*TB)`, `fps=${rate}`, ...filters, `select=between(n\\,${k}\\,${k + n - 1})`].join(",")
        : [`fps=${rate}`, ...filters].join(",");
      const seek = retimeFps ? [] : ["-ss", (start + k / rate).toFixed(6)];
      const { code, text } = await run(ff, ["-y", ...seek, "-i", input, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", chain,
        ...(retimeFps ? ["-vsync", "0"] : []), "-frames:v", String(n), "-pix_fmt", pixFmt, "-f", "rawvideo", out]);
      if (code !== 0) throw failure(text);
      const bytes = await ff.readFile(out);
      await ff.deleteFile(out);
      const got = Math.floor(bytes.length / frameBytes);
      if (got) await each(bytes, k, got);
      if (got < n) return k + got; // the video ended
    }
    return total;
  }

  // ---------- HEVC / AV1 with WebCodecs ----------
  // HEVC as Annex B (start codes); a browser that hands back length-prefixed NAL units
  // (and the parameter sets in decoderConfig.description) is converted.
  function hevcAnnexB(chunk, description) {
    if (!description) return chunk;
    const d = new Uint8Array(description instanceof ArrayBuffer ? description : description.buffer || description);
    const lengthSize = (d[21] & 3) + 1;
    const start = [0, 0, 0, 1];
    const out = [];
    const params = [];
    for (let o = 23, arrays = d[22], a = 0; a < arrays; a++) {
      const count = (d[o + 1] << 8) | d[o + 2];
      o += 3;
      for (let i = 0; i < count; i++) {
        const len = (d[o] << 8) | d[o + 1];
        params.push(...start, ...d.subarray(o + 2, o + 2 + len));
        o += 2 + len;
      }
    }
    out.push(...params);
    for (let o = 0; o + lengthSize <= chunk.length; ) {
      let len = 0;
      for (let i = 0; i < lengthSize; i++) len = len * 256 + chunk[o + i];
      out.push(...start, ...chunk.subarray(o + lengthSize, o + lengthSize + len));
      o += lengthSize + len;
    }
    return new Uint8Array(out);
  }

  // AV1 as an OBU stream: each temporal unit starts with a temporal delimiter.
  const TD = new Uint8Array([0x12, 0x00]);
  const av1Unit = (chunk) => (((chunk[0] >> 3) & 0x0f) === 2 ? [chunk] : [TD, chunk]);

  async function encodeStream({ kind, width, height, rate, frames }) {
    const parts = [];
    let error = null;
    let description = null;
    const encoder = new global.VideoEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && meta.decoderConfig.description) description = meta.decoderConfig.description;
        const b = new Uint8Array(chunk.byteLength);
        chunk.copyTo(b);
        if (kind === "hevc") parts.push(chunk.type === "key" || !description ? hevcAnnexB(b, description) : hevcAnnexB(b, description).subarray(paramBytes(description)));
        else parts.push(...av1Unit(b));
      },
      error: (e) => (error = e),
    });
    encoder.configure(encoderConfig(kind, width, height, rate));
    const gop = Math.max(1, Math.round(rate * 2));
    const ended = await frames(async (bytes, index) => {
      if (error) throw error;
      const frame = new global.VideoFrame(bytes, {
        format: "I420", codedWidth: width, codedHeight: height,
        timestamp: Math.round((index * 1e6) / rate), duration: Math.round(1e6 / rate),
      });
      encoder.encode(frame, { keyFrame: index % gop === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 6 && !error) await new Promise((r) => setTimeout(r, 5));
    });
    await encoder.flush();
    encoder.close();
    if (error) throw error;
    return { bytes: concat(parts), frames: ended };
  }

  // The parameter sets hevcAnnexB puts in front, which only keyframes need.
  function paramBytes(description) {
    const d = new Uint8Array(description instanceof ArrayBuffer ? description : description.buffer || description);
    let n = 0;
    for (let o = 23, arrays = d[22], a = 0; a < arrays; a++) {
      const count = (d[o + 1] << 8) | d[o + 2];
      o += 3;
      for (let i = 0; i < count; i++) {
        const len = (d[o] << 8) | d[o + 1];
        n += 4 + len;
        o += 2 + len;
      }
    }
    return n;
  }

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  // ---------- AVIF: the still-image boxes viewers look for ----------
  // ffmpeg.wasm (FFmpeg 5) writes the AV1 frames as an MP4; an animated AVIF is that with
  // brand avis, a 'pict' track, and a meta box naming the first frame as the image (as
  // FFmpeg 6's avif muxer writes it).
  function toAvif(mp4) {
    const view = new DataView(mp4.buffer, mp4.byteOffset, mp4.byteLength);
    const u32 = (o) => view.getUint32(o);
    const type = (o) => String.fromCharCode(mp4[o + 4], mp4[o + 5], mp4[o + 6], mp4[o + 7]);
    const boxes = (from, to) => {
      const out = [];
      for (let o = from; o + 8 <= to; ) {
        const size = u32(o) || to - o;
        out.push({ type: type(o), start: o, size });
        o += size;
      }
      return out;
    };
    const top = boxes(0, mp4.length);
    const ftyp = top.find((b) => b.type === "ftyp"), moov = top.find((b) => b.type === "moov");
    if (!ftyp || !moov) throw new Error("The AVIF couldn't be made (no MP4 boxes)");
    const child = (box, name, skip = 0) => boxes(box.start + 8 + skip, box.start + box.size).find((b) => b.type === name);
    const trak = child(moov, "trak"), mdia = child(trak, "mdia"), hdlr = child(mdia, "hdlr"), minf = child(mdia, "minf"), stbl = child(minf, "stbl");
    const stsd = child(stbl, "stsd"), stsz = child(stbl, "stsz"), stco = child(stbl, "stco");
    const entry = boxes(stsd.start + 16, stsd.start + stsd.size)[0]; // av01 sample entry
    const width = view.getUint16(entry.start + 32), height = view.getUint16(entry.start + 34);
    const av1C = boxes(entry.start + 8 + 78, entry.start + entry.size).find((b) => b.type === "av1C");
    if (!av1C || !stco) throw new Error("The AVIF couldn't be made (no AV1 track)");
    const firstSize = u32(stsz.start + 12) || u32(stsz.start + 20);
    const firstOffset = u32(stco.start + 16);

    const enc = new TextEncoder();
    const box = (name, ...parts) => {
      const body = concat(parts.map((p) => (typeof p === "string" ? enc.encode(p) : p)));
      const out = new Uint8Array(8 + body.length);
      new DataView(out.buffer).setUint32(0, out.length);
      out.set(enc.encode(name), 4);
      out.set(body, 8);
      return out;
    };
    const bytes = (...v) => new Uint8Array(v);
    const be32 = (v) => bytes((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
    const be16 = (v) => bytes((v >>> 8) & 255, v & 255);
    const full = (version, flags) => bytes(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255);

    const newFtyp = box("ftyp", "avis", be32(0), "avis", "avif", "msf1", "iso8", "mif1", "miaf", "MA1B");
    const meta = (offset) =>
      box("meta", full(0, 0),
        box("hdlr", full(0, 0), be32(0), "pict", be32(0), be32(0), be32(0), "PictureHandler\0"),
        box("pitm", full(0, 0), be16(1)),
        // iloc v0: offset and length 4 bytes, no base offset; item 1, one extent.
        box("iloc", full(0, 0), bytes(0x44, 0x00), be16(1), be16(1), be16(0), be16(1), be32(offset), be32(firstSize)),
        box("iinf", full(0, 0), be16(1), box("infe", full(2, 0), be16(1), be16(0), "av01", "Color\0")),
        box("iprp",
          box("ipco",
            box("ispe", full(0, 0), be32(width), be32(height)),
            box("pixi", full(0, 0), bytes(3, 8, 8, 8)),
            mp4.slice(av1C.start, av1C.start + av1C.size),
            box("colr", "nclx", be16(1), be16(13), be16(6), bytes(0))),
          // item 1: ispe, pixi, av1C (essential), colr
          box("ipma", full(0, 0), be32(1), be16(1), bytes(4, 0x01, 0x02, 0x83, 0x04))));
    const delta = newFtyp.length + meta(0).length - ftyp.size;
    const out = concat([newFtyp, meta(firstOffset + delta), mp4.subarray(ftyp.start + ftyp.size)]);
    const ov = new DataView(out.buffer);
    const shift = delta; // every box after ftyp moved by this much
    // The track is a picture track, and its chunk offsets point into the moved mdat.
    out.set(enc.encode("pict"), hdlr.start + shift + 16);
    const count = ov.getUint32(stco.start + shift + 12);
    for (let i = 0; i < count; i++) {
      const at = stco.start + shift + 16 + i * 4;
      ov.setUint32(at, ov.getUint32(at) + delta);
    }
    return out;
  }

  // ---------- Y4M and uncompressed AVI ----------
  function y4mHeader(width, height, rate) {
    const [num, den] = Number.isInteger(rate) ? [rate, 1] : [Math.round(rate * 1000), 1000];
    return new TextEncoder().encode(`YUV4MPEG2 W${width} H${height} F${num}:${den} Ip A1:1 C420jpeg\n`);
  }

  // An AVI (OpenDML when it's over 1 GB, as ffmpeg writes it): top-down BGR frames ('00dc')
  // and, with sound, 16-bit stereo PCM ('01wb') after each run of frames. Every size is known
  // before the first frame (the frame count and each run's sound are fixed), so it's written
  // in order: headers, then the frames as they're decoded, then the indexes.
  function aviLayout({ width, height, rate }) {
    const frameBytes = width * height * 3;
    const enc = new TextEncoder();
    const chunk = (id, body) => {
      const pad = body.length & 1;
      const out = new Uint8Array(8 + body.length + pad);
      out.set(enc.encode(id), 0);
      new DataView(out.buffer).setUint32(4, body.length, true);
      out.set(body, 8);
      return out;
    };
    const le = (n, ...values) => {
      const out = new Uint8Array(values.length * n);
      const dv = new DataView(out.buffer);
      values.forEach((v, i) => (n === 4 ? dv.setUint32(i * 4, v >>> 0, true) : dv.setUint16(i * 2, v, true)));
      return out;
    };
    const list = (kind, ...parts) => chunk("LIST", concat([enc.encode(kind), ...parts]));
    const [scale, rateNum] = Number.isInteger(rate) ? [1, rate] : [1000, Math.round(rate * 1000)];
    // fccType, fccHandler, flags, priority + language, initial frames, scale, rate, start, length, buffer size, quality, sample size, frame rectangle.
    const strh = (kindId, handler, sc, rt, length, sample, size, video) =>
      chunk("strh", concat([enc.encode(kindId), enc.encode(handler), le(4, 0, 0, 0, sc, rt, 0, length, size, 0xffffffff, sample), le(2, 0, 0, video ? width : 0, video ? height : 0)]));
    const bih = chunk("strf", concat([le(4, 40, width, -height >>> 0), le(2, 1, 24), le(4, 0, frameBytes, 0, 0, 0, 0)]));
    const wave = chunk("strf", concat([le(2, 1, 2), le(4, AUDIO_RATE, AUDIO_RATE * 4), le(2, 4, 16)]));
    return { frameBytes, chunk, list, le, strh, bih, wave, scale, rateNum };
  }

  async function makeAvi({ width, height, rate, total, decodeRuns, audioFor }) {
    // Runs of frames and their sound, decoded in order; sizes fixed up front.
    const L = aviLayout({ width, height, rate });
    const { frameBytes, chunk, list, le, scale, rateNum } = L;
    const parts = [];
    const index = []; // { id, offset in movi data, size }
    let moviBytes = 0;
    const add = (id, body) => {
      const c = chunk(id, body);
      index.push({ id, offset: moviBytes, size: body.length });
      moviBytes += c.length;
      parts.push(new Blob([c]));
    };
    let audioTotal = 0;
    const framesDone = await decodeRuns(async (bytes, first, count) => {
      for (let i = 0; i < count; i++) add("00dc", bytes.subarray(i * frameBytes, (i + 1) * frameBytes));
      const pcm = audioFor ? await audioFor(first, count) : null;
      if (pcm && pcm.length) {
        add("01wb", pcm);
        audioTotal += pcm.length;
      }
    });
    const audio = audioTotal > 0;
    const enc = new TextEncoder();
    // Headers, now that the counts are known (the parts are already in order after them).
    const strlVideo = list("strl", L.strh("vids", "\0\0\0\0", scale, rateNum, framesDone, 0, frameBytes, true), L.bih);
    const strlAudio = audio ? list("strl", L.strh("auds", "\0\0\0\0", 1, AUDIO_RATE, audioTotal / 4, 4, 0), L.wave) : new Uint8Array(0);
    // µs per frame, max bytes a second, padding, flags (has an index; interleaved), frames, initial frames, streams, buffer size, width, height.
    const avih = chunk("avih", le(4, Math.round(1e6 / rate), Math.round(frameBytes * rate), 0, audio ? 0x110 : 0x10, framesDone, 0, audio ? 2 : 1, frameBytes, width, height, 0, 0, 0, 0));
    const hdrl = list("hdrl", avih, strlVideo, strlAudio);
    const big = moviBytes > AVI_LIMITS.single;
    if (!big) {
      // AVI 1.0: one RIFF, an idx1 at the end.
      // Each chunk: its id, flags (a keyframe: every frame is), offset from the 'movi' tag, size.
      const idx = concat(index.map((e) => concat([enc.encode(e.id), le(4, 0x10, e.offset + 4, e.size)])));
      const moviHead = concat([enc.encode("LIST"), le(4, moviBytes + 4), enc.encode("movi")]);
      const idx1 = chunk("idx1", idx);
      const riffSize = 4 + hdrl.length + moviHead.length + moviBytes + idx1.length;
      const head = concat([enc.encode("RIFF"), le(4, riffSize), enc.encode("AVI "), hdrl, moviHead]);
      return new Blob([head, ...parts, idx1]);
    }
    return makeOpenDml({ L, hdrl: { avih, strlVideo, strlAudio, audio }, parts, index, framesDone, enc });
  }

  // Over 1 GB: RIFF AVI + RIFF AVIX pieces of under 1 GB each, every stream with a standard
  // index (ix00 / ix01) per piece and a super index (indx) in the header pointing at them.
  function makeOpenDml({ L, hdrl, parts, index, framesDone, enc }) {
    const { chunk, list, le } = L;
    const PIECE = AVI_LIMITS.piece;
    // Split the movi chunks (in order) into pieces.
    const pieces = [];
    let cur = null;
    index.forEach((e, i) => {
      const len = 8 + e.size + (e.size & 1);
      if (!cur || cur.bytes + len > PIECE) pieces.push((cur = { items: [], bytes: 0 }));
      cur.items.push({ ...e, part: parts[i], len });
      cur.bytes += len;
    });
    const streams = hdrl.audio ? ["00dc", "01wb"] : ["00dc"];
    // indx: a super index for each stream, with an entry per piece (sizes fixed up front).
    const superIndex = (id, entries) =>
      // wLongsPerEntry 4, sub-type 0, type 0 (an index of indexes); entries: offset (64-bit), size, duration.
      chunk("indx", concat([le(2, 4), new Uint8Array([0, 0]), le(4, entries.length), enc.encode(id), le(4, 0, 0, 0), ...entries.map((x) => le(4, x.offsetLo, x.offsetHi, x.size, x.duration))]));
    const standardIndex = (id, base, items) =>
      // wLongsPerEntry 2, sub-type 0, type 1 (an index of chunks); base offset (64-bit); entries: data offset from base, size.
      chunk(id === "00dc" ? "ix00" : "ix01", concat([le(2, 2), new Uint8Array([0, 1]), le(4, items.length), enc.encode(id), le(4, base % 2 ** 32, Math.floor(base / 2 ** 32), 0),
        ...items.map((x) => le(4, x.rel + 8, x.size))]));
    const dmlh = list("odml", chunk("dmlh", concat([le(4, framesDone), new Uint8Array(244)])));
    // Lay out: header sizes don't depend on offsets (fixed-size entries), so build twice.
    const build = (entriesFor) => {
      const strlVideo = list("strl", L.strh("vids", "\0\0\0\0", L.scale, L.rateNum, framesDone, 0, L.frameBytes, true), L.bih, superIndex("00dc", entriesFor("00dc")));
      const strlAudio = hdrl.audio
        ? list("strl", L.strh("auds", "\0\0\0\0", 1, AUDIO_RATE, index.filter((e) => e.id === "01wb").reduce((n, e) => n + e.size, 0) / 4, 4, 0), L.wave, superIndex("01wb", entriesFor("01wb")))
        : new Uint8Array(0);
      return list("hdrl", hdrl.avih, strlVideo, strlAudio, dmlh);
    };
    const placeholder = () => pieces.map(() => ({ offsetLo: 0, offsetHi: 0, size: 0, duration: 0 }));
    const head = build(placeholder);
    // File offsets: RIFF AVI (12) + hdrl, then each piece: [RIFF AVIX header for later pieces] LIST movi (12) + chunks + ix.. per stream [+ idx1 none].
    let offset = 12 + head.length;
    const out = [];
    const entries = { "00dc": [], "01wb": [] };
    const blobs = [];
    pieces.forEach((piece, p) => {
      const riffStart = offset;
      if (p > 0) offset += 12; // RIFF AVIX header
      const moviStart = offset;
      offset += 12; // LIST movi header
      const dataStart = offset;
      let rel = 0;
      const per = { "00dc": [], "01wb": [] };
      for (const it of piece.items) {
        per[it.id].push({ size: it.size, abs: dataStart + rel });
        rel += it.len;
      }
      offset += rel;
      const ixs = streams.map((id) => {
        const ix = standardIndex(id, dataStart, per[id].map((x) => ({ rel: x.abs - dataStart, size: x.size })));
        entries[id].push({ offsetLo: offset % 2 ** 32, offsetHi: Math.floor(offset / 2 ** 32), size: ix.length, duration: id === "00dc" ? per[id].length : per[id].reduce((n, x) => n + x.size, 0) / 4 });
        offset += ix.length;
        return ix;
      });
      const moviSize = 4 + rel + ixs.reduce((n, x) => n + x.length, 0);
      const moviHead = concat([enc.encode("LIST"), le(4, moviSize), enc.encode("movi")]);
      out.push({ p, riffStart, moviHead, items: piece.items, ixs, end: offset });
    });
    const hdrlFinal = build((id) => entries[id]);
    if (hdrlFinal.length !== head.length) throw new Error("AVI index layout changed size");
    out.forEach((o, i) => {
      const end = i + 1 < out.length ? out[i + 1].riffStart : o.end;
      if (i === 0) blobs.push(concat([enc.encode("RIFF"), le(4, end - 8), enc.encode("AVI "), hdrlFinal]));
      else blobs.push(concat([enc.encode("RIFF"), le(4, end - o.riffStart - 8), enc.encode("AVIX")]));
      blobs.push(o.moviHead, ...o.items.map((it) => it.part), ...o.ixs);
    });
    return new Blob(blobs);
  }

  // ---------- making a file ----------
  async function make({ id, ff, run, input, info, rate: sourceRate, retimeFps = 0, trim = null, duration = 0, onProgress = () => {}, canceled = () => false }) {
    if (!handles(id)) throw new Error(`Not made here: ${id}`);
    if (!available(id)) throw new Error(why(id));
    const rate = id === "avif" ? 15 : retimeFps || sourceRate || info.fps || 30;
    const start = trim ? trim.start : 0;
    const length = trim ? trim.length : duration || info.duration;
    const total = Math.max(1, Math.round(length * rate));
    const filters = id === "avif" ? ["scale='min(800,iw)':-2:flags=lanczos"] : ["scale=trunc(iw/2)*2:trunc(ih/2)*2"];
    const seek = retimeFps || !start ? [] : ["-ss", start.toFixed(6)];
    const size = await outputSize(ff, run, input, [...(retimeFps ? [`setpts=N/(${retimeFps}*TB)`] : []), ...filters].join(","), seek);
    const { width, height } = size;
    const pixFmt = id === "rawavi" ? "bgr24" : "yuv420p";
    const frameBytes = id === "rawavi" ? width * height * 3 : (width * height * 3) / 2;
    const decodeRuns = (each) =>
      eachRun({ ff, run, input, start, total, rate, retimeFps, filters, pixFmt, frameBytes, canceled, each: async (bytes, first, count) => {
        await each(bytes, first, count);
        onProgress(Math.min(0.95, (first + count) / total));
      } });

    if (id === "y4m") {
      const parts = [y4mHeader(width, height, rate)];
      const tag = new TextEncoder().encode("FRAME\n");
      await decodeRuns(async (bytes, first, count) => {
        const run = [];
        for (let i = 0; i < count; i++) run.push(tag, bytes.subarray(i * frameBytes, (i + 1) * frameBytes));
        parts.push(new Blob(run));
      });
      onProgress(1);
      return new Blob(parts);
    }

    if (id === "rawavi") {
      const hasAudio = !!info.hasAudio;
      const samplesAt = (frame) => Math.round((frame * AUDIO_RATE) / rate);
      // The sound for frames first..first+count-1: exactly that many samples (padded with silence).
      const audioFor = hasAudio && !retimeFps
        ? async (first, count) => {
            const want = (samplesAt(first + count) - samplesAt(first)) * 4;
            const out = tmpName("pcm");
            const t0 = start + first / rate;
            const { code } = await run(ff, ["-y", "-ss", t0.toFixed(6), "-i", input, "-map", "0:a:0", "-vn", "-t", (count / rate).toFixed(6), "-ac", "2", "-ar", String(AUDIO_RATE), "-f", "s16le", out]);
            const got = code === 0 ? await ff.readFile(out).catch(() => new Uint8Array(0)) : new Uint8Array(0);
            await ff.deleteFile(out).catch(() => {});
            const pcm = new Uint8Array(want);
            pcm.set(got.subarray(0, want));
            return pcm;
          }
        : null;
      const blob = await makeAvi({ width, height, rate, total, decodeRuns, audioFor });
      onProgress(1);
      return blob;
    }

    // HEVC, AV1, AVIF: the device's encoder, then ffmpeg.wasm for the container (and sound).
    const kind = kindOf(id);
    const encoded = await encodeStream({ kind, width, height, rate, frames: (each) => decodeRuns(async (bytes, first, count) => {
      for (let i = 0; i < count; i++) await each(bytes.subarray(i * frameBytes, (i + 1) * frameBytes), first + i);
    }) });
    if (canceled()) throw new Error("Canceled");
    const stream = tmpName(kind === "hevc" ? "hevc" : "obu");
    await ff.writeFile(stream, encoded.bytes);
    const ext = id === "av1" ? "webm" : "mp4";
    const out = tmpName(ext);
    const audioIn = id === "avif" ? [] : retimeFps ? ["-i", input] : trim ? ["-ss", trim.start.toFixed(3), "-t", trim.length.toFixed(3), "-i", input] : ["-i", input];
    const audio = id === "avif" ? ["-an"] : ["-map", "1:a:0?", ...(id === "av1" ? ["-c:a", "libopus", "-b:a", "128k"] : ["-c:a", "aac", "-b:a", "160k"]), "-shortest"];
    const args = [
      "-y", "-framerate", String(Math.round(rate * 1000) / 1000), "-f", kind === "hevc" ? "hevc" : "obu", "-i", stream, ...audioIn,
      // A raw stream has no timestamps (its first frame would come out before 0 and be cut):
      // each frame's is its number (the encoders here don't reorder frames).
      "-map", "0:v:0", ...audio, "-c:v", "copy", "-bsf:v", "setts=ts=N*DURATION", ...(kind === "hevc" ? ["-tag:v", "hvc1"] : []),
      ...(ext === "mp4" ? ["-movflags", "+faststart"] : []), ...(id === "avif" ? ["-f", "mp4", "-brand", "avis"] : []), out,
    ];
    const { code, text } = await run(ff, args);
    await ff.deleteFile(stream).catch(() => {});
    if (code !== 0) throw failure(text);
    const data = await ff.readFile(out);
    await ff.deleteFile(out).catch(() => {});
    onProgress(1);
    return id === "avif" ? toAvif(data) : data;
  }

  ready();
  // (_aviLimits: the checks make small OpenDML files.)
  global.VideoNative = { handles, ready, available, why, make, _aviLimits: AVI_LIMITS };
})(window);
