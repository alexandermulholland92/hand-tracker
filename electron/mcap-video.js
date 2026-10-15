/**
 * mcap-video.js — camera videos added to a motion capture's MCAP file (motion-export.js writes
 * the hands; this adds the videos recorded with them): each video's frames as JPEG pictures,
 * sensor_msgs/msg/CompressedImage on /hand_tracker/<camera>/image/compressed, each at the moment
 * it was taken, on the same clock as the hands. ffmpeg (exporter.js) turns a video into its
 * frames, at most MAX_WIDTH wide; the file is written again with them, its other messages kept.
 *
 *   await addVideos(mcapPath, [{ path, name, startMs }])   startMs: when the video started (ms since 1970)
 *     -> { ok, frames, message }
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
require("../mcap.js");
const Mcap = globalThis.Mcap;
const { ffmpegPath } = require("./exporter");

const MAX_WIDTH = 960;
const QUALITY = 5; // ffmpeg's JPEG quality, 2 (best) to 31

// A ROS name from a camera's: letters, digits and underscores.
const rosName = (s) => String(s || "camera").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "camera";

// A video's frames as JPEGs, each with its time in seconds from the video's start.
function jpegFrames(input) {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-nostdin", "-i", input, "-an", "-vsync", "0", "-vf", `scale='min(${MAX_WIDTH},iw)':-2,showinfo`, "-q:v", String(QUALITY), "-f", "image2pipe", "-c:v", "mjpeg", "-"];
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    const chunks = [];
    const times = [];
    let err = "";
    proc.stdout.on("data", (b) => chunks.push(b));
    proc.stderr.on("data", (b) => {
      err += b.toString();
      // (showinfo: one line a frame, in order)
      let nl;
      while ((nl = err.indexOf("\n")) >= 0) {
        const line = err.slice(0, nl);
        err = err.slice(nl + 1);
        const m = /\bpts_time:\s*(-?[\d.]+)/.exec(line);
        if (m && /showinfo/i.test(line)) times.push(Number(m[1]));
      }
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      const all = Buffer.concat(chunks);
      // JPEGs one after another: each ends with FF D9 (never inside one: its data escapes FF).
      const jpegs = [];
      let start = 0;
      for (let i = 0; i + 1 < all.length; i++) {
        if (all[i] === 0xff && all[i + 1] === 0xd9) {
          jpegs.push(all.subarray(start, i + 2));
          start = i + 2;
          i++;
        }
      }
      if (code !== 0 && !jpegs.length) return reject(new Error(`ffmpeg couldn't read the video (exit ${code}).`));
      const t0 = times.length ? times[0] : 0;
      resolve(jpegs.map((jpeg, k) => ({ t: (k < times.length ? times[k] : times.length ? times[times.length - 1] + (k - times.length + 1) / 30 : k / 30) - t0, jpeg })));
    });
  });
}

async function addVideos(mcapPath, videos) {
  if (!/\.mcap$/i.test(String(mcapPath || "")) || !fs.existsSync(mcapPath)) return { ok: false, message: "No MCAP file to add the videos to." };
  const list = (Array.isArray(videos) ? videos : []).filter((v) => v && typeof v.path === "string" && fs.existsSync(v.path) && Number.isFinite(v.startMs));
  if (!list.length) return { ok: false, message: "No videos to add." };
  const file = Mcap.read(new Uint8Array(fs.readFileSync(mcapPath)));
  const w = Mcap.writer({ profile: file.profile || "ros2", library: file.library || "Hand Tracker" });
  const schemas = new Map(), channels = new Map();
  for (const s of file.schemas.values()) schemas.set(s.id, w.schema(s.name, s.encoding, s.data));
  for (const c of file.channels.values()) channels.set(c.id, w.channel(c.topic, c.messageEncoding, schemas.get(c.schemaId), c.metadata));
  const messages = file.messages.map((m) => ({ ch: channels.get(m.channel), t: BigInt(m.logTime), data: m.data }));
  const image = w.schema("sensor_msgs/msg/CompressedImage", "ros2msg", Mcap.ROS2.CompressedImage);
  const topics = new Set([...file.channels.values()].map((c) => c.topic));
  let frames = 0;
  const failed = [];
  for (const v of list) {
    let name = rosName(v.name);
    for (let k = 2; topics.has(`/hand_tracker/${name}/image/compressed`); k++) name = `${rosName(v.name)}_${k}`;
    const topic = `/hand_tracker/${name}/image/compressed`;
    topics.add(topic);
    let pictures;
    try {
      pictures = await jpegFrames(v.path);
    } catch (err) {
      failed.push(`${v.name}: ${err.message}`);
      continue;
    }
    const ch = w.channel(topic, "cdr", image, { offered_qos_profiles: Mcap.QOS });
    const start = BigInt(Math.round(v.startMs * 1000)) * 1000n;
    for (const p of pictures) {
      const t = start + BigInt(Math.round(p.t * 1e9));
      messages.push({ ch, t, data: Mcap.cdr.compressedImage(t, `${name}_camera`, "jpeg", p.jpeg) });
    }
    frames += pictures.length;
  }
  messages.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  for (const m of messages) w.message(m.ch, m.t, m.data);
  for (const a of file.attachments) w.attachment(a.name, a.mediaType, a.data, BigInt(a.logTime || 0));
  for (const md of file.metadata) w.metadata(md.name, md.metadata instanceof Map ? Object.fromEntries(md.metadata) : md.metadata);
  const out = w.finish();
  const tmp = path.join(path.dirname(mcapPath), `.${path.basename(mcapPath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, mcapPath);
  return { ok: frames > 0, frames, message: failed.length ? `Not added: ${failed.join("; ")}` : "" };
}

module.exports = { addVideos, jpegFrames, MAX_WIDTH };
