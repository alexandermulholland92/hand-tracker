/**
 * kinect-mcap.js — a take's Kinect files as an MCAP file of their own, beside the take's
 * (<take>-kinect-<camera>.mcap): its depth as ROS's compressed_depth_image_transport makes it
 * (sensor_msgs/CompressedImage "16UC1; compressedDepth png": 16-bit millimetres, lossless), its
 * infrared ("mono16; png compressed mono16") and its full-size colour ("jpeg"), each frame at the
 * time it was taken (its -times.csv), with each camera's sensor_msgs/CameraInfo (a depth picture
 * and its camera's parameters make a point cloud, in Foxglove or ROS). Written as the frames are
 * read (ffmpeg turns the lossless videos back into pictures), so a long take never has to fit in
 * memory, nor all of it in one go on a small computer.
 *
 *   await writeKinectMcap(file, { name, files: [{ kind: "depth" | "ir" | "color", path, times }], color, ir })
 *     color, ir: the cameras' parameters (kinect2-helper's "running" message) -> { ok, frames, message }
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
require("../mcap.js");
const Mcap = globalThis.Mcap;

const rosName = (s) => String(s || "camera").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "camera";
const PNG_END = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]); // a PNG's IEND chunk and its CRC

// A video's frames one at a time, as pictures (PNG for the 16-bit ones, the JPEGs as they are),
// ffmpeg paused while a few wait.
class Frames {
  constructor(file, kind) {
    const { ffmpegPath } = require("./exporter");
    const out = kind === "color" ? ["-c:v", "copy", "-f", "mjpeg"] : ["-pix_fmt", "gray16be", "-c:v", "png", "-compression_level", "1", "-f", "image2pipe"];
    this.proc = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", file, "-an", ...out, "-"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.kind = kind;
    this.buf = Buffer.alloc(0);
    this.queue = [];
    this.waiting = null;
    this.ended = false;
    this.err = "";
    this.proc.stderr.on("data", (d) => (this.err = (this.err + d).slice(-1000)));
    this.proc.stdout.on("data", (d) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      this.split();
      if (this.queue.length > 6) this.proc.stdout.pause();
      this.wake();
    });
    this.proc.on("close", () => {
      this.ended = true;
      this.wake();
    });
    this.proc.on("error", (e) => {
      this.err = e.message;
      this.ended = true;
      this.wake();
    });
  }

  split() {
    for (;;) {
      let end = -1;
      if (this.kind === "color") {
        for (let i = 2; i + 1 < this.buf.length; i++) if (this.buf[i] === 0xff && this.buf[i + 1] === 0xd9) { end = i + 2; break; }
      } else {
        const at = this.buf.indexOf(PNG_END);
        if (at >= 0) end = at + PNG_END.length;
      }
      if (end < 0) return;
      this.queue.push(Buffer.from(this.buf.subarray(0, end)));
      this.buf = this.buf.subarray(end);
    }
  }

  wake() {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w();
    }
  }

  async next() {
    while (!this.queue.length && !this.ended) await new Promise((r) => (this.waiting = r));
    const f = this.queue.shift() || null;
    if (this.queue.length <= 2 && !this.ended) this.proc.stdout.resume();
    return f;
  }

  stop() {
    if (!this.ended) this.proc.kill();
  }
}

// A -times.csv's unix_ms column.
function readTimes(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split(/\r?\n/).slice(1).map((l) => Number(l.split(",")[2])).filter(Number.isFinite);
}
const ns = (ms) => BigInt(Math.round(ms * 1000)) * 1000n;

async function writeKinectMcap(file, { name, files = [], color = null, ir = null } = {}) {
  const wanted = files.filter((f) => ["depth", "ir", "color"].includes(f.kind) && fs.existsSync(f.path));
  if (!wanted.length) return { ok: false, frames: 0, message: "No Kinect videos to put in it." };
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, "w");
  const streams = [];
  let frames = 0;
  try {
    const w = Mcap.writer({ profile: "ros2", library: "Hand Tracker", sink: (b) => fs.writeSync(fd, b) });
    const image = w.schema("sensor_msgs/msg/CompressedImage", "ros2msg", Mcap.ROS2.CompressedImage);
    const info = w.schema("sensor_msgs/msg/CameraInfo", "ros2msg", Mcap.ROS2.CameraInfo);
    const base = `/hand_tracker/${rosName(name)}/kinect`;
    const qos = { offered_qos_profiles: Mcap.QOS };
    const TOPIC = { depth: ["depth/image_raw/compressedDepth", "depth"], ir: ["ir/image_raw/compressed", "depth"], color: ["color/image_raw/compressed", "color"] };
    const infos = {};
    for (const f of wanted) {
      const [topic, cam] = TOPIC[f.kind];
      const times = readTimes(f.times);
      if (!times.length) continue;
      const params = cam === "color" ? color : ir;
      if (params && !infos[cam]) {
        infos[cam] = { ch: w.channel(`${base}/${cam === "color" ? "color" : "depth"}/camera_info`, "cdr", info, qos), params, last: -Infinity };
      }
      streams.push({ kind: f.kind, frameId: `${rosName(name)}_kinect_${cam}`, cam, ch: w.channel(`${base}/${topic}`, "cdr", image, qos), times, at: 0, frames: new Frames(f.path, f.kind), head: null });
    }
    for (const s of streams) s.head = await s.frames.next();
    // The streams' frames in time order (depth and infrared share each frame's time).
    for (;;) {
      let s = null;
      for (const x of streams) if (x.head && x.at < x.times.length && (!s || x.times[x.at] < s.times[s.at])) s = x;
      if (!s) break;
      const t = ns(s.times[s.at]);
      const data =
        s.kind === "depth"
          ? Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), s.head]) // (compressedDepth's header: its format and two unused parameters)
          : s.head;
      const format = s.kind === "depth" ? "16UC1; compressedDepth png" : s.kind === "ir" ? "mono16; png compressed mono16" : "jpeg";
      w.message(s.ch, t, Mcap.cdr.compressedImage(t, s.frameId, format, data));
      // Each camera's parameters, with its pictures (once a second).
      const ci = infos[s.cam];
      if (ci && s.times[s.at] - ci.last >= 1000) {
        ci.last = s.times[s.at];
        const p = ci.params;
        const d = s.cam === "color" ? [0, 0, 0, 0, 0] : [p.k1 || 0, p.k2 || 0, p.p1 || 0, p.p2 || 0, p.k3 || 0];
        w.message(ci.ch, t, Mcap.cdr.cameraInfo(t, s.frameId, { width: p.w, height: p.h, fx: p.fx, fy: p.fy, cx: p.cx, cy: p.cy, d }));
      }
      frames++;
      s.at++;
      s.head = await s.frames.next();
    }
    w.finish();
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
    const short = streams.filter((s) => s.at < s.times.length - 1);
    return { ok: frames > 0, frames, message: short.length ? `Some frames weren't read: ${short.map((s) => `${s.kind} ${s.at}/${s.times.length}${s.frames.err ? ` (${s.frames.err.trim().split("\n").pop()})` : ""}`).join(", ")}` : "" };
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {}
    fs.rmSync(tmp, { force: true });
    return { ok: false, frames, message: err.message };
  } finally {
    for (const s of streams) s.frames.stop();
  }
}

module.exports = { writeKinectMcap };
