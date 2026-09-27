/**
 * video-validators.js — checks an exported video really is the format it claims:
 * decodes it with the bundled ffmpeg and compares the codec and sound. Animated
 * WebP is checked by its structure (ffmpeg 6.1 can write it but not read it back), and
 * so is AVIF where the ffmpeg can't read it (newer ones decode it as AV1).
 * Used by check.js and check-android.js.
 */

const fs = require("fs");
const { spawnSync } = require("child_process");
const VideoFormats = require("../video-formats.js");
const { ffmpegPath } = require("../electron/exporter.js");

// Video codec each format should hold. WebM is VP8 when made by ffmpeg.wasm; MKV and
// WebM copy the app's own VP9 recordings unchanged.
const EXPECTED_CODEC = {
  mp4: "h264", mov: "h264", webm: ["vp9", "vp8"], mkv: ["h264", "vp9"], avi: "mpeg4", gif: "gif",
  m4v: "h264", wmv: "wmv2", mpg: "mpeg2video", mpeg: "mpeg1video", vob: "mpeg2video", ts: "h264",
  m2ts: "h264", flv: "h264", "3gp": "h264", "3g2": "h264", ogv: "theora", hevc: "hevc", av1: "av1",
  prores: "prores", dnxhr: "dnxhd", mxf: "mpeg2video", mjpeg: "mjpeg", ffv1: "ffv1", dv: "dvvideo", apng: "apng",
  rm: "rv20", av1mp4: "av1", cfhd: "cfhd", utvideo: "utvideo", huffyuv: "huffyuv", qtrle: "qtrle", rawavi: "rawvideo",
  y4m: "rawvideo", avif: "av1",
};

// -> { ok, detail }. withSound: the source had sound (kept wherever the format allows it).
function verifyVideo(file, formatId, withSound) {
  const format = VideoFormats.FORMATS.find((f) => f.id === formatId);
  if (!file || !fs.existsSync(file)) return { ok: false, detail: "missing" };
  const size = `${(fs.statSync(file).size / 1024).toFixed(0)} KB`;
  if (formatId === "webp") {
    const bytes = fs.readFileSync(file);
    const frames = bytes.toString("latin1").split("ANMF").length - 1;
    return { ok: /^RIFF....WEBPVP8X/s.test(bytes.subarray(0, 20).toString("latin1")) && frames > 1, detail: `animated WebP, ${frames} frames, ${size}` };
  }
  const probe = spawnSync(ffmpegPath, ["-hide_banner", "-i", file, "-f", "null", "-"], { encoding: "utf8" });
  const info = VideoFormats.parseProbe(probe.stderr);
  if (formatId === "avif") {
    const sequence = /^....ftypavis/s.test(fs.readFileSync(file).subarray(0, 12).toString("latin1")); // an animated AVIF
    return { ok: sequence && (probe.status !== 0 || info.videoCodec === "av1"), detail: `AVIF image sequence, ${info.videoCodec || "not readable by this ffmpeg"}, ${size}` };
  }
  const sound = format.audio && withSound;
  const ok = probe.status === 0 && [].concat(EXPECTED_CODEC[formatId]).includes(info.videoCodec) && info.hasAudio === sound;
  return { ok, detail: `${info.videoCodec || "?"} ${info.width}x${info.height}${info.hasAudio ? " + sound" : ""}, ${info.duration.toFixed(2)} s, ${size}` };
}

// Verifies a set of exports named <base><suffix>.<ext> in dir; -> { ok, summary }.
function verifyExports(dir, base, formatIds, withSound) {
  const bad = [];
  for (const id of formatIds) {
    const f = VideoFormats.FORMATS.find((x) => x.id === id);
    const r = verifyVideo(require("path").join(dir, `${base}${f.suffix}.${f.ext}`), id, withSound);
    if (!r.ok) bad.push(`${id}: ${r.detail}`);
  }
  return { ok: bad.length === 0, summary: bad.length ? bad.join(" | ") : `${formatIds.length} of ${formatIds.length} decode as the right format${withSound ? ", with sound where the format has it" : ""}` };
}

module.exports = { verifyVideo, verifyExports, EXPECTED_CODEC };
