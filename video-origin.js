/**
 * video-origin.js
 * Works out from a video file's own metadata whether a phone recorded it, and with which
 * camera, so a phone's selfie video can be flipped back before tracking (see "Mirrored
 * videos" in hand-tracker.js). Only the metadata is read, never the video itself, so
 * it's quick however big the file is.
 *
 *   const origin = await VideoOrigin.read(file);  // { phone: "android" | "iphone" | null,
 *                                                //   camera: "front" | "back" | null, rotation }
 *   const { mirrored, note } = VideoOrigin.mirroredByDefault(origin);
 *
 * Android phones save front-camera videos mirrored, the way the preview looked. The file
 * doesn't say which camera recorded it, but its rotation does when the phone was held
 * upright: the front camera's sensor is mounted the other way round from the back one's,
 * so upright front-camera videos are rotated 270° and back-camera ones 90°. Held sideways
 * both are 0° or 180°, so there's no telling; like any Android video not known to be from
 * the back camera, those are taken to be from the front one. Android camera recordings
 * carry com.android.* metadata keys (and Samsung's their own "smta" box).
 *
 * iPhones save front-camera videos the right way round (their Mirror Front Camera setting
 * is for photos), so they're left as they are, like videos from anything else.
 *
 * MP4 and MOV only (ISO base media files); other formats don't carry this metadata.
 */

(function (global) {
  const MAX_MOOV_BYTES = 64 * 1024 * 1024; // the metadata box; phones write a few MB at most
  const MAX_TOP_BOXES = 1000;

  const latin1 = (v, pos, n) => {
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(pos + i));
    return s;
  };
  const utf8 = (v, pos, n) => new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset + pos, n));

  // The box starting at pos, or null if there isn't a valid one: { type, pos, start, end },
  // start being where its contents begin.
  function boxAt(v, pos, end) {
    if (pos + 8 > end) return null;
    let size = v.getUint32(pos);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) return null;
      size = Number(v.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos; // runs to the end
    }
    if (size < header || pos + size > end) return null;
    return { type: latin1(v, pos + 4, 4), pos, start: pos + header, end: pos + size };
  }

  function* children(v, box) {
    for (let pos = box.start, b; (b = boxAt(v, pos, box.end)); pos = b.end) yield b;
  }

  function find(v, box, type) {
    for (const b of children(v, box)) if (b.type === type) return b;
    return null;
  }

  // The file's "moov" box (its metadata), read on its own: the file is walked box by box
  // from the headers, skipping the video data.
  async function readMoov(blob) {
    let pos = 0;
    for (let i = 0; i < MAX_TOP_BOXES && pos + 8 <= blob.size; i++) {
      const head = new DataView(await blob.slice(pos, pos + 16).arrayBuffer());
      let size = head.getUint32(0);
      let header = 8;
      const type = latin1(head, 4, 4);
      if (size === 1) {
        if (head.byteLength < 16) return null;
        size = Number(head.getBigUint64(8));
        header = 16;
      } else if (size === 0) {
        size = blob.size - pos;
      }
      if (size < header || !/^[\x20-\x7e]{4}$/.test(type)) return null; // not an MP4/MOV file
      if (type === "moov") {
        if (size > MAX_MOOV_BYTES || pos + size > blob.size) return null;
        return new DataView(await blob.slice(pos, pos + size).arrayBuffer());
      }
      pos += size;
    }
    return null;
  }

  // QuickTime metadata as phones write it (a "meta" box with "keys" and "ilst"): { key: text },
  // with "" for values that aren't text.
  function metadataKeys(v, meta) {
    // QuickTime's meta box holds boxes straight away; the ISO one starts with version and flags.
    const body = latin1(v, meta.start + 4, 4) === "hdlr" ? meta : { start: meta.start + 4, end: meta.end };
    const keys = find(v, body, "keys");
    const ilst = find(v, body, "ilst");
    const out = {};
    if (!keys || !ilst || keys.start + 8 > keys.end) return out;
    const names = [];
    const count = v.getUint32(keys.start + 4);
    for (let i = 0, pos = keys.start + 8; i < count && pos + 8 <= keys.end; i++) {
      const size = v.getUint32(pos); // includes its own 4 bytes and the 4-byte namespace
      if (size < 8 || pos + size > keys.end) break;
      names.push(utf8(v, pos + 8, size - 8));
      pos += size;
    }
    for (const item of children(v, ilst)) {
      const name = names[v.getUint32(item.pos + 4) - 1]; // items are numbered from 1, in key order
      const data = name && find(v, item, "data");
      if (!data || data.end - data.start < 8) continue;
      const isText = (v.getUint32(data.start) & 0xffffff) === 1; // UTF-8
      out[name] = isText ? utf8(v, data.start + 8, data.end - data.start - 8) : "";
    }
    return out;
  }

  // How far the video is turned when shown (0, 90, 180 or 270° clockwise), from its
  // track's matrix, or null if there's no video track.
  function videoRotation(v, moov) {
    for (const trak of children(v, moov)) {
      if (trak.type !== "trak") continue;
      const mdia = find(v, trak, "mdia");
      const hdlr = mdia && find(v, mdia, "hdlr");
      if (!hdlr || hdlr.start + 12 > hdlr.end || latin1(v, hdlr.start + 8, 4) !== "vide") continue;
      const tkhd = find(v, trak, "tkhd");
      if (!tkhd) return null;
      // version/flags, then times and ids (longer in version 1), then 16 bytes before the matrix
      const m = tkhd.start + 4 + (v.getUint8(tkhd.start) === 1 ? 32 : 20) + 16;
      if (m + 8 > tkhd.end) return null;
      const a = v.getInt32(m), b = v.getInt32(m + 4); // cos and sin of the turn (16.16 fixed point)
      const degrees = Math.round(Math.atan2(b, a) / (Math.PI / 2)) * 90;
      return (degrees + 360) % 360;
    }
    return null;
  }

  async function read(blob) {
    const unknown = { phone: null, camera: null, rotation: null };
    try {
      const v = await readMoov(blob);
      const moov = v && boxAt(v, 0, v.byteLength);
      if (!moov) return unknown;
      // iPhones and Android put their metadata in moov/meta; other writers in moov/udta/meta.
      const udta = find(v, moov, "udta");
      const keys = {};
      for (const meta of [find(v, moov, "meta"), udta && find(v, udta, "meta")]) {
        if (meta) Object.assign(keys, metadataKeys(v, meta));
      }
      const rotation = videoRotation(v, moov);
      let phone = null;
      if (Object.keys(keys).some((k) => k.startsWith("com.android.")) || (udta && find(v, udta, "smta"))) phone = "android";
      else if (/^iPhone/.test(keys["com.apple.quicktime.model"] || "")) phone = "iphone";
      const camera = phone === "android" ? (rotation === 270 ? "front" : rotation === 90 ? "back" : null) : null;
      return { phone, camera, rotation };
    } catch (err) {
      console.warn("video-origin: couldn't read the video's metadata:", err);
      return unknown;
    }
  }

  // Whether to flip a video back when it's opened (until the Mirrored video button says
  // otherwise), and a note saying why when it is.
  function mirroredByDefault(origin) {
    if (!origin || origin.phone !== "android" || origin.camera === "back") return { mirrored: false, note: "" };
    return {
      mirrored: true,
      note: origin.camera === "front"
        ? "Recorded on an Android phone's front camera, which saves videos mirrored, so it's flipped back (Mirrored video: ON)."
        : "Recorded on an Android phone held sideways, so the video doesn't say which camera: it's taken to be the front camera, which saves videos mirrored, and flipped back (Mirrored video: ON). For the back camera, turn Mirrored video off.",
    };
  }

  global.VideoOrigin = { read, mirroredByDefault };
})(window);
