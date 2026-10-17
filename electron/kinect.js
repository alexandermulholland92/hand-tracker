/**
 * kinect.js — the Kinect for Xbox One (Kinect v2) as one of "Several cameras" (multi-camera.js),
 * in the Linux and Windows app: a helper each, which streams its colour camera, its depth, its
 * infrared and its four microphones (kinect/kinect2-helper.cpp on Linux, through libfreenect2;
 * kinect/KinectHelper.cs on Windows, through Microsoft's Kinect SDK, which adds the Kinect's own
 * body tracking). The page finds the hands (and on Linux the bodies) in its pictures, with the
 * depth for each part of them; this keeps a take's depth, infrared, full-size colour and sound.
 *
 *   KinectCamera.available()            -> { ok, reason }
 *   await KinectCamera.list(dataDir)    -> [{ id, name }]
 *   const cam = new KinectCamera(dataDir);
 *   cam.start(options, onMessage)       options: { device, source: "color" | "infrared" | "auto",
 *                                         size: "960x540"…, mics, pipeline: "auto" | "opengl" | "cpu" }
 *                                       onMessage: { status… } | { frame, jpeg, depth } | { raw, depth, ir }
 *                                         | { rawcolor, jpeg } | { audio, pcm, beam }
 *   cam.command(line)                   e.g. "source infrared", "record on" (kinect2-helper.cpp's list)
 *   cam.stop()
 *
 *   const take = new KinectTake(folder, { depth, ir, color, sound })   a take's files, as they come:
 *   take.raw(header, depth, ir); take.color(header, jpeg); take.audio(header, pcm, beam)
 *   await take.finish()                 -> [{ kind, file, startMs, times, frames }]  (times: a .csv
 *                                         of each frame's time; kind: depth, ir, color, sound, beam)
 */

const { spawn, execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readMessages } = require("./oak");

const unpacked = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const KINECT = unpacked(path.join(__dirname, "..", "kinect"));
const LINUX_HELPER = path.join(KINECT, "bin", `linux-${process.arch}`, "kinect2-helper");
const WINDOWS_SOURCE = path.join(KINECT, "KinectHelper.cs");
// Microsoft's Kinect library: where its Kinect for Windows Runtime 2.0 puts it, or its SDK.
const KINECT_DLLS = [
  path.join(process.env.SystemRoot || "C:\\Windows", "Microsoft.NET", "assembly", "GAC_MSIL", "Microsoft.Kinect", "v4.0_2.0.0.0__31bf3856ad364e35", "Microsoft.Kinect.dll"),
  path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft SDKs", "Kinect", "v2.0_1409", "Assemblies", "Microsoft.Kinect.dll"),
];
const kinectDll = () => KINECT_DLLS.find((f) => fs.existsSync(f)) || null;
const RUNTIME_URL = "https://www.microsoft.com/download/details.aspx?id=44559";

// Linux: whether OpenGL depth processing works here (libfreenect2 ends the program when it
// can't), found once a run; the CPU's otherwise.
let glProbe = null;
function probeOpenGL() {
  if (!glProbe) {
    glProbe = new Promise((resolve) => {
      execFile(LINUX_HELPER, ["--probe-gl"], { timeout: 15000, windowsHide: true }, (err) => resolve(!err));
    });
  }
  return glProbe;
}

// Windows: the helper, built once per version of its source by Windows' own C# compiler,
// against the Kinect runtime's library (as electron/bt-hid.js builds its helper).
function buildWindowsHelper(folder) {
  const dll = kinectDll();
  if (!dll) return Promise.reject(Object.assign(new Error(`The Kinect needs Microsoft's Kinect for Windows Runtime 2.0 on this PC: ${RUNTIME_URL}`), { runtime: true }));
  const hash = crypto.createHash("sha256").update(fs.readFileSync(WINDOWS_SOURCE)).digest("hex").slice(0, 12);
  const exe = path.join(folder, `kinect-helper-${hash}.exe`);
  if (fs.existsSync(exe)) return Promise.resolve(exe);
  const win = process.env.SystemRoot || "C:\\Windows";
  const fw = ["Framework64", "Framework"].map((d) => path.join(win, "Microsoft.NET", d, "v4.0.30319")).find((d) => fs.existsSync(path.join(d, "csc.exe")));
  if (!fw) return Promise.reject(new Error("This Windows is missing .NET Framework 4, which the Kinect's helper needs."));
  fs.mkdirSync(folder, { recursive: true });
  for (const old of fs.readdirSync(folder)) if (/^kinect-helper-[0-9a-f]+\.exe$/.test(old)) fs.rmSync(path.join(folder, old), { force: true });
  const refs = [`-r:${dll}`, `-r:${path.join(fw, "WPF", "PresentationCore.dll")}`, `-r:${path.join(fw, "WPF", "WindowsBase.dll")}`, `-r:${path.join(fw, "System.Xaml.dll")}`];
  // (The SDK's copy isn't in Windows' own store of libraries: the helper finds it beside itself.)
  if (!/GAC_MSIL/i.test(dll)) fs.copyFileSync(dll, path.join(folder, "Microsoft.Kinect.dll"));
  const tmp = `${exe}.tmp.exe`;
  return new Promise((resolve, reject) => {
    execFile(path.join(fw, "csc.exe"), ["-nologo", "-optimize", "-platform:x64", "-unsafe", `-out:${tmp}`, ...refs, WINDOWS_SOURCE], { windowsHide: true, timeout: 120000 }, (err, stdout) => {
      if (err) return reject(new Error(`The Kinect's helper didn't build: ${String(stdout || err.message).trim().split(/\r?\n/).find((l) => /error/i.test(l)) || err.message}`));
      fs.renameSync(tmp, exe);
      resolve(exe);
    });
  });
}

class KinectCamera {
  static available() {
    if (process.platform === "linux") {
      return fs.existsSync(LINUX_HELPER) ? { ok: true } : { ok: false, reason: `This build has no Kinect helper for ${process.arch} Linux.` };
    }
    if (process.platform === "win32") {
      if (process.arch !== "x64") return { ok: false, reason: "The Kinect works with 64-bit Windows." };
      if (!kinectDll()) return { ok: false, runtime: true, reason: `The Kinect needs Microsoft's Kinect for Windows Runtime 2.0 on this PC: ${RUNTIME_URL}` };
      return { ok: true };
    }
    return { ok: false, reason: "The Kinect works in the Linux and Windows apps." };
  }

  static async helper(dataDir) {
    if (process.platform === "win32") return buildWindowsHelper(path.join(dataDir, "kinect"));
    return LINUX_HELPER;
  }

  // The Kinects plugged in (none when there's no helper here).
  static async list(dataDir) {
    if (!KinectCamera.available().ok) return [];
    const exe = await KinectCamera.helper(dataDir);
    return new Promise((resolve) => {
      execFile(exe, ["--list"], { encoding: "buffer", timeout: 15000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
        const msg = readMessages(Buffer.from(stdout || [])).messages.map((m) => m.header).find((h) => h.status === "devices");
        const devices = msg && Array.isArray(msg.devices) ? msg.devices : [];
        resolve(devices.filter((d) => d && /^[A-Za-z0-9._-]{1,64}$/.test(String(d.id))).map((d) => ({ id: String(d.id), name: String(d.name || "Kinect for Xbox One").slice(0, 60) })));
      });
    });
  }

  constructor(dataDir) {
    this.dataDir = dataDir;
    this.proc = null;
    this.started = null;
  }

  start(options, onMessage) {
    this.stop();
    const started = (this.started = {});
    (async () => {
      const exe = await KinectCamera.helper(this.dataDir);
      const args = [];
      if (options.device && /^[A-Za-z0-9._-]{1,64}$/.test(options.device)) args.push("--device", options.device);
      if (["color", "infrared", "auto"].includes(options.source)) args.push("--source", options.source);
      if (/^\d{3,4}x\d{3,4}$/.test(options.size || "")) args.push("--size", options.size);
      // (Its microphones through PipeWire where it runs, KinectMics, shared; else the helper opens them.)
      const pw = process.platform === "linux" && options.mics !== false && KinectMics.usable();
      if (options.mics === false || pw) args.push("--no-mics");
      if (process.platform === "linux") {
        const want = options.pipeline || "auto";
        args.push("--pipeline", want === "cpu" ? "cpu" : want === "opengl" || (await probeOpenGL()) ? "opengl" : "cpu");
      }
      if (this.started !== started) return; // (stopped meanwhile)
      this.spawn(exe, args, options.device, (msg) => {
        if (pw && msg.status === "running" && !this.mics) {
          this.mics = new KinectMics(onMessage);
          this.mics.start().catch(() => {});
        }
        if (msg.status === "stopped" && this.mics) {
          this.mics.stop();
          this.mics = null;
        }
        onMessage(msg);
      });
    })().catch((err) => onMessage({ status: "error", message: err.message, runtime: !!err.runtime }));
  }

  spawn(exe, args, device, onMessage) {
    const proc = spawn(exe, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    const log = helperLog(this.dataDir, device, args);
    let buf = Buffer.alloc(0), err = "";
    proc.stdout.on("data", (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      const { messages, rest } = readMessages(buf);
      buf = Buffer.from(rest);
      for (const m of messages) {
        const h = m.header;
        const part = (name) => (h.parts && Array.isArray(h.parts[name]) && m.jpeg ? m.jpeg.subarray(h.parts[name][0], h.parts[name][0] + h.parts[name][1]) : null);
        if (h.status) onMessage(h);
        else if (h.kind === "frame") onMessage({ frame: h, jpeg: part("jpeg"), depth: part("depth"), body: part("body") });
        else if (h.kind === "raw") onMessage({ raw: h, depth: part("depth"), ir: part("ir") });
        else if (h.kind === "rawcolor") onMessage({ rawcolor: h, jpeg: part("jpeg") });
        else if (h.kind === "audio") onMessage({ audio: h, pcm: part("pcm"), beam: part("beam") });
      }
    });
    proc.stderr.on("data", (d) => {
      err = (err + d).slice(-4000);
      log.write(d);
    });
    proc.stdin.on("error", () => {}); // (a helper that's gone)
    proc.on("error", (e) => onMessage({ status: "error", message: `The Kinect's helper couldn't start: ${e.message}` }));
    proc.on("close", (code) => {
      if (this.proc === proc) this.proc = null;
      log.end(`--- ${new Date().toISOString()} ended (${code})\n`);
      const last = err.trim().split("\n").filter((l) => l.trim()).slice(-2).join(" ");
      onMessage({ status: "stopped", code, detail: code ? last : "" });
    });
  }

  command(line) {
    if (this.mics && /^record (on|off)$/.test(line)) this.mics.recording = line === "record on";
    if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(`${String(line).replace(/[\r\n]/g, " ")}\n`);
  }

  // Asked to stop (it closes the Kinect properly), then ended if it hasn't in 3 s.
  stop() {
    this.started = null;
    if (this.mics) this.mics.stop();
    this.mics = null;
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    try {
      proc.stdin.write("quit\n");
    } catch {}
    const timer = setTimeout(() => proc.kill(), 3000);
    proc.once("close", () => clearTimeout(timer));
    proc.kill("SIGTERM");
  }
}

// Each Kinect's helper's messages (libfreenect2's, each with its time: lost packets and USB
// troubles show there), kept in <data>/kinect/helper-<id>.log, about a megabyte of them (the one
// before as .old.log): what's there when a Kinect has stopped says why.
function helperLog(dataDir, device, args) {
  try {
    const dir = path.join(dataDir, "kinect");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `helper-${/^[A-Za-z0-9._-]{1,64}$/.test(device || "") ? device : "kinect"}.log`);
    if (fs.existsSync(file) && fs.statSync(file).size > 1 << 20) fs.renameSync(file, file.replace(/\.log$/, ".old.log"));
    const out = fs.createWriteStream(file, { flags: "a" });
    out.on("error", () => {});
    out.write(`--- ${new Date().toISOString()} started: ${args.join(" ")}\n`);
    return out;
  } catch {
    return { write() {}, end() {} };
  }
}

// ---------- the microphones, through PipeWire (Linux) ----------
// Where PipeWire looks after the sound cards (Raspberry Pi OS, most Linux desktops), the Kinect's
// microphones are one of its sources: read through it (pw-record), they stay shared with
// everything else (a camera video's sound, say), where the helper opening the card itself would
// keep it to itself. Started once the Kinect runs (starting it resets the device, and the card
// with it), and again if it stops. Messages as the helper's "audio" ones.
const pipewireRunning = () => process.platform === "linux" && !!process.env.XDG_RUNTIME_DIR && fs.existsSync(path.join(process.env.XDG_RUNTIME_DIR, "pipewire-0"));

function findPipewireSource() {
  return new Promise((resolve) => {
    execFile("pw-dump", [], { timeout: 8000, maxBuffer: 32 << 20 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const node = JSON.parse(stdout).find((o) => {
          const p = (o && o.info && o.info.props) || {};
          return p["media.class"] === "Audio/Source" && /Xbox_NUI|Xbox NUI|NUI_Sensor/i.test(`${p["node.name"] || ""} ${p["node.description"] || ""}`);
        });
        resolve(node ? String(node.info.props["node.name"]) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

class KinectMics {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.proc = null;
    this.stopped = false;
    this.beam = new Beam();
    this.recording = false;
  }

  static usable() {
    const onPath = (exe) => String(process.env.PATH || "").split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, exe)));
    return pipewireRunning() && onPath("pw-record") && onPath("pw-dump");
  }

  async start(delayMs = 2500) {
    this.stopped = false;
    await new Promise((r) => (this.timer = setTimeout(r, delayMs)));
    if (this.stopped) return;
    const target = await findPipewireSource();
    if (this.stopped) return;
    if (!target) {
      this.onMessage({ status: "note", mics: false, message: "The Kinect's microphones weren't found among this computer's sound sources." });
      return this.again(10000);
    }
    const proc = spawn("pw-record", [`--target=${target}`, "--rate=16000", "--channels=4", "--format=s32", "-"], { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    const chunk = 1600 * 16; // 100 ms
    let buf = Buffer.alloc(0);
    proc.stdout.on("data", (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= chunk) {
        this.chunk(buf.subarray(0, chunk));
        buf = buf.subarray(chunk);
      }
      buf = Buffer.from(buf);
    });
    proc.on("error", () => {});
    proc.on("close", () => {
      if (this.proc === proc) this.proc = null;
      if (!this.stopped) this.again(5000);
    });
    this.onMessage({ status: "note", mics: true, micDevice: target });
  }

  again(ms) {
    if (!this.stopped) this.timer = setTimeout(() => this.start(0).catch(() => {}), ms);
  }

  chunk(pcm) {
    const frames = pcm.length / 16;
    const ch = [0, 1, 2, 3].map(() => new Float32Array(frames));
    const level = [0, 0, 0, 0];
    for (let i = 0; i < frames; i++) {
      for (let m = 0; m < 4; m++) {
        const v = pcm.readInt32LE((i * 4 + m) * 4) / 2147483648;
        ch[m][i] = v;
        level[m] += v * v;
      }
    }
    for (let m = 0; m < 4; m++) level[m] = Math.round(Math.sqrt(level[m] / frames) * 1e5) / 1e5;
    const b = this.beam.update(ch);
    const header = { kind: "audio", u: Date.now() - (frames / 16000) * 1000, rate: 16000, channels: 4, frames, level, delays: b.delays.slice(1).map((d) => Math.round(d * 100) / 100), angle: Math.round(b.angle * 10) / 10, confidence: Math.round(b.confidence * 100) / 100,
      active: b.active, snr: Math.round(b.snr * 10) / 10 };
    this.onMessage(this.recording ? { audio: header, pcm, beam: b.mono(ch) } : { audio: header });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.proc) this.proc.kill();
    this.proc = null;
  }
}

// Where the loudest sound is (kinect2-helper.cpp's Beam, the same): each microphone's delay
// behind the first (GCC-PHAT, in samples), how sure, its angle (roughly), and the four lined up
// on it as one, turned up gently (the Kinect's sound is quiet).
// Only a sound above the steady one is placed: the Kinect hears its own hum all the time (one
// microphone far more than the rest), and placed, that hum would hold the angle still. So each
// microphone's steady sound is followed, frequency by frequency, each frequency counts by how
// far above it it is, and the delays change only while the speech band is well above it
// (active: placed in the last 0.8 s).
class Beam {
  constructor() {
    this.N = 1024;
    this.MAX_LAG = 12;
    this.delays = [0, 0, 0, 0];
    this.confidence = 0;
    this.angle = 0;
    this.gain = 8;
    this.noise = null; // per microphone, per frequency: the steady sound's power
    this.snr = 0; // the last 100 ms's speech band over that (dB)
    this.quiet = 99; // updates since a sound was last placed
    this.active = false;
    this.window = Float64Array.from({ length: this.N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.N - 1)));
  }

  static fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = ((2 * Math.PI) / len) * (inverse ? 1 : -1);
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < len / 2; j++) {
          const a = i + j, b = a + len / 2;
          const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - vr;
          im[b] = im[a] - vi;
          re[a] += vr;
          im[a] += vi;
          [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) (re[i] /= n), (im[i] /= n);
  }

  update(ch) {
    const N = this.N, H = N / 2, n = Math.min(N, ch[0].length), at = ch[0].length - n;
    const k0 = Math.round((200 / 16000) * N), k1 = Math.round((6000 / 16000) * N); // the speech band
    const re = [], im = [], power = [];
    for (let m = 0; m < 4; m++) {
      const r = new Float64Array(N), i = new Float64Array(N);
      for (let j = 0; j < n; j++) r[j] = ch[m][at + j] * this.window[j];
      Beam.fft(r, i, false);
      const p = new Float64Array(H + 1);
      for (let k = 0; k <= H; k++) p[k] = r[k] * r[k] + i[k] * i[k];
      re.push(r), im.push(i), power.push(p);
    }
    const first = !this.noise;
    if (first) this.noise = power.map((p) => Float64Array.from(p, (v) => v + 1e-20));
    // How far above the steady sound: the speech band as a whole, and each frequency's share.
    let sp = 0, sn = 0;
    const share = power.map((p, m) =>
      Float64Array.from(p, (v, k) => {
        if (k >= k0 && k <= k1) (sp += v), (sn += this.noise[m][k]);
        return Math.max(0, 1 - (2 * this.noise[m][k]) / Math.max(v, 1e-30));
      })
    );
    this.snr = first ? 0 : 10 * Math.log10(Math.max(sp, 1e-30) / Math.max(sn, 1e-30));
    let placed = 0, confSum = 0;
    for (let m = 1; m < 4 && !first && this.snr > 6; m++) {
      const rm = new Float64Array(N), iq = new Float64Array(N);
      let weight = 0;
      for (let k = k0; k <= k1; k++) {
        const w = share[0][k] * share[m][k];
        if (w <= 0) continue;
        const cr = re[0][k] * re[m][k] + im[0][k] * im[m][k], ci = im[0][k] * re[m][k] - re[0][k] * im[m][k];
        const mag = Math.hypot(cr, ci);
        if (mag < 1e-30) continue;
        rm[k] = (w * cr) / mag;
        iq[k] = (w * ci) / mag;
        rm[N - k] = rm[k];
        iq[N - k] = -iq[k];
        weight += w;
      }
      if (weight < 8) continue; // (too few frequencies above the steady sound to tell)
      Beam.fft(rm, iq, true);
      let best = 0, top = -1e9, sum = 0;
      for (let lag = -this.MAX_LAG; lag <= this.MAX_LAG; lag++) {
        const v = rm[(lag + N) % N];
        sum += Math.abs(v);
        if (v > top) (top = v), (best = lag);
      }
      const l = rm[(best - 1 + N) % N], r = rm[(best + 1 + N) % N], den = l - 2 * top + r;
      const frac = Math.abs(den) > 1e-12 ? (0.5 * (l - r)) / den : 0;
      const d = -(best + Math.max(-0.5, Math.min(0.5, frac)));
      const c = sum > 0 ? top / (sum / (2 * this.MAX_LAG + 1)) : 0;
      if (c < 4) continue;
      this.delays[m] += (d - this.delays[m]) * 0.5;
      placed++;
      confSum += c;
    }
    // The steady sound, after: its average while nothing stands out (the speech band within 3 dB
    // of it); while something does, down towards a quieter frequency, up only slowly (4 dB in
    // 10 s: a fan that's come on becomes the steady sound).
    if (!first) {
      const calm = this.snr < 3;
      for (let m = 0; m < 4; m++)
        for (let k = 0; k <= H; k++) {
          const v = power[m][k] + 1e-20, s = this.noise[m][k];
          this.noise[m][k] = calm || v < s ? s + (v - s) * 0.1 : s * 1.01;
        }
    }
    this.quiet = placed ? 0 : this.quiet + 1;
    this.active = this.quiet <= 8;
    this.confidence = placed ? Math.min(1, confSum / placed / 12) : this.confidence * 0.8;
    const s = Math.max(-1, Math.min(1, ((this.delays[3] / 16000) * 343) / 0.2));
    this.angle = (Math.asin(s) * 180) / Math.PI;
    return this;
  }

  mono(ch) {
    const frames = ch[0].length, out = Buffer.alloc(frames * 2), mono = new Float32Array(frames);
    let peak = 1e-6;
    for (let i = 0; i < frames; i++) {
      let v = 0;
      for (let m = 0; m < 4; m++) v += ch[m][Math.max(0, Math.min(frames - 1, i + Math.round(this.delays[m])))];
      mono[i] = v / 4;
      peak = Math.max(peak, Math.abs(mono[i]));
    }
    this.gain = Math.min(this.gain, 0.9 / peak);
    for (let i = 0; i < frames; i++) out.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(mono[i] * this.gain * 32767))), i * 2);
    this.gain = Math.min(64, this.gain * 1.01);
    return out;
  }
}

// ---------- a take's Kinect files ----------
// Depth and infrared: 512 x 424, 16 bits, lossless (FFV1 in Matroska), as the frames come
// (nominally 30 a second: each frame's real time is in the .csv beside it). The colour camera's
// own pictures (1920 x 1080 JPEGs) kept as they are (Motion JPEG in Matroska). The four
// microphones: a 4-channel 32-bit WAV, and the beam (the four lined up on the loudest sound) a
// mono 16-bit one.
class KinectTake {
  constructor(folder, want = {}) {
    this.folder = folder;
    fs.mkdirSync(folder, { recursive: true });
    this.want = { depth: want.depth !== false, ir: want.ir !== false, color: !!want.color, sound: want.sound !== false };
    this.streams = {};
    this.errors = [];
  }

  video(kind, args) {
    const { ffmpegPath } = require("./exporter");
    const file = path.join(this.folder, `${kind}.mkv`);
    const proc = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args, "-i", "-", ...(kind === "color" ? ["-c:v", "copy"] : ["-c:v", "ffv1", "-level", "3", "-g", "30", "-slices", "4"]), file], {
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
    const s = { kind, file, proc, times: [], err: "", done: new Promise((r) => proc.on("close", r)) };
    proc.stderr.on("data", (d) => (s.err = (s.err + d).slice(-1000)));
    proc.stdin.on("error", () => {});
    return s;
  }

  raw(header, depth, ir) {
    const u = Number(header.u) || Date.now();
    for (const [kind, data] of [["depth", depth], ["ir", ir]]) {
      if (!this.want[kind] || !data || data.length !== 512 * 424 * 2) continue;
      const s = (this.streams[kind] = this.streams[kind] || this.video(kind, ["-f", "rawvideo", "-pix_fmt", "gray16le", "-s", "512x424", "-framerate", "30"]));
      s.proc.stdin.write(Buffer.from(data));
      s.times.push(u);
    }
  }

  color(header, jpeg) {
    if (!this.want.color || !jpeg || !jpeg.length) return;
    const s = (this.streams.color = this.streams.color || this.video("color", ["-f", "mjpeg", "-framerate", "30"]));
    s.proc.stdin.write(Buffer.from(jpeg));
    s.times.push(Number(header.u) || Date.now());
  }

  audio(header, pcm, beam) {
    if (!this.want.sound || !((pcm && pcm.length) || (beam && beam.length))) return;
    if (!this.streams.beam) {
      const open = (kind, file, channels, bits) => {
        const s = { kind, file: path.join(this.folder, file), fd: fs.openSync(path.join(this.folder, file), "w"), bytes: 0, channels, bits, startMs: Number(header.u) || Date.now() };
        fs.writeSync(s.fd, wavHeader(0, channels, bits));
        return s;
      };
      // (Windows: the Kinect's SDK gives only its beam, the four lined up by the Kinect itself.)
      if (pcm && pcm.length) this.streams.sound = open("sound", "sound.wav", 4, 32);
      this.streams.beam = open("beam", "beam.wav", 1, 16);
      this.streams.angles = [];
    }
    for (const [s, data] of [[this.streams.sound, pcm], [this.streams.beam, beam]]) {
      if (!s || !data || !data.length) continue;
      fs.writeSync(s.fd, Buffer.from(data));
      s.bytes += data.length;
    }
    this.streams.angles.push([Number(header.u) || Date.now(), header.angle, header.confidence, header.active]);
  }

  async finish() {
    const out = [];
    for (const s of Object.values(this.streams)) {
      if (!s || !s.kind) continue;
      if (s.proc) {
        s.proc.stdin.end();
        const code = await s.done;
        if (code !== 0 || !fs.existsSync(s.file)) {
          this.errors.push(`The Kinect's ${s.kind} video couldn't be saved: ${s.err.trim().split("\n").pop() || `ffmpeg ended with ${code}`}`);
          continue;
        }
        const times = path.join(this.folder, `${s.kind}-times.csv`);
        const t0 = s.times[0] || 0;
        fs.writeFileSync(times, `frame,t_s,unix_ms\n${s.times.map((u, i) => `${i},${((u - t0) / 1000).toFixed(4)},${u.toFixed(1)}`).join("\n")}\n`);
        out.push({ kind: s.kind, file: s.file, startMs: t0, times, frames: s.times.length });
      } else if (s.fd !== undefined) {
        // The WAV's sizes, now they're known.
        const header = wavHeader(s.bytes, s.channels, s.bits);
        fs.writeSync(s.fd, header, 0, header.length, 0);
        fs.closeSync(s.fd);
        out.push({ kind: s.kind, file: s.file, startMs: s.startMs, seconds: s.bytes / (s.channels * (s.bits / 8) * 16000) });
      }
    }
    // Where the sound came from (roughly), as it went (active 1: a sound above the room's steady
    // one was placed then; empty with the Kinect's own direction finding, Windows).
    const angles = this.streams.angles;
    if (angles && angles.length) {
      const file = path.join(this.folder, "sound-direction.csv");
      const t0 = this.streams.beam.startMs;
      const rows = angles.map(([u, a, c, on]) => `${((u - t0) / 1000).toFixed(2)},${u.toFixed(1)},${a},${c},${on === undefined ? "" : on ? 1 : 0}`);
      fs.writeFileSync(file, `t_s,unix_ms,angle_deg,confidence,active\n${rows.join("\n")}\n`);
      out.push({ kind: "direction", file, startMs: t0 });
    }
    return out;
  }

  abort() {
    for (const s of Object.values(this.streams)) {
      if (s && s.proc) s.proc.kill();
      if (s && s.fd !== undefined) fs.closeSync(s.fd);
    }
    fs.rmSync(this.folder, { recursive: true, force: true });
  }
}

// A WAV file's header: 16 kHz PCM, more than two channels or more than 16 bits in its extensible form.
function wavHeader(dataBytes, channels, bits) {
  const extensible = channels > 2 || bits > 16;
  const fmtSize = extensible ? 40 : 16;
  const h = Buffer.alloc(20 + fmtSize + 8);
  const rate = 16000, block = channels * (bits / 8);
  h.write("RIFF", 0);
  h.writeUInt32LE(12 + fmtSize + 8 + dataBytes, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(fmtSize, 16);
  h.writeUInt16LE(extensible ? 0xfffe : 1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * block, 28);
  h.writeUInt16LE(block, 32);
  h.writeUInt16LE(bits, 34);
  let at = 36;
  if (extensible) {
    h.writeUInt16LE(22, 36); // the extension's size
    h.writeUInt16LE(bits, 38); // valid bits
    h.writeUInt32LE(channels === 4 ? 0x33 : 0, 40); // FL FR BL BR (no speaker positions are right for microphones; 0 for the rest)
    Buffer.from("0100000000001000800000aa00389b71", "hex").copy(h, 44); // KSDATAFORMAT_SUBTYPE_PCM
    at = 60;
  }
  h.write("data", at);
  h.writeUInt32LE(dataBytes, at + 4);
  return h.subarray(0, at + 8);
}

// For the automated checks (HAND_TRACKER_KINECT_SIMULATE): a Kinect without a Kinect, streaming as
// the helper does: a grey picture (the checks give the hand tracker its hands), a wall 2 m away
// with a box 850 mm away in the middle, the depth and infrared while it records, and a sound
// reaching each microphone a sample after the one before.
class SimulatedKinect {
  start(options, onMessage) {
    const { nativeImage } = require("electron");
    this.onMessage = onMessage;
    this.recording = false;
    this.rawcolor = false;
    let source = ["infrared", "auto"].includes(options.source) ? options.source : "color";
    const night = () => source === "infrared";
    const [w, h] = night() ? [512, 424] : [960, 540];
    const jpegOf = (ww, hh, v) => nativeImage.createFromBitmap(Buffer.alloc(ww * hh * 4, v), { width: ww, height: hh }).toJPEG(70);
    const pictures = { color: jpegOf(960, 540, 90), infrared: jpegOf(512, 424, 50), full: jpegOf(1920, 1080, 90) };
    const map = (mw, mh) => {
      const m = Buffer.alloc(mw * mh * 2);
      for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) m.writeUInt16LE(Math.abs(x / mw - 0.5) < 0.15 && Math.abs(y / mh - 0.5) < 0.2 ? 850 : 2000, (y * mw + x) * 2);
      return m;
    };
    const maps = { color: map(480, 270), infrared: map(256, 212) };
    const raw = Buffer.alloc(512 * 424 * 2);
    for (let i = 0; i < 512 * 424; i++) raw.writeUInt16LE(2000, i * 2);
    const color = { w: 1920, h: 1080, fx: 1081.37, fy: 1081.37, cx: 959.5, cy: 539.5 };
    const ir = { w: 512, h: 424, fx: 365.46, fy: 365.46, cx: 256.12, cy: 205.4, k1: 0.09, k2: -0.27, k3: 0.09, p1: 0, p2: 0 };
    onMessage({ status: "running", camera: "Kinect for Xbox One", id: options.device || "SIMULATED-KINECT", firmware: "simulated", pipeline: "cpu", color, ir, depth: true, infrared: true,
      source, size: [w, h], unmirrored: true, version: "simulated", mics: options.mics !== false });
    const scaled = (c, ww, hh) => ({ fx: (c.fx * ww) / c.w, fy: (c.fy * hh) / c.h, cx: ((c.cx + 0.5) * ww) / c.w - 0.5, cy: ((c.cy + 0.5) * hh) / c.h - 0.5 });
    let seq = 0;
    this.timer = setInterval(() => {
      const n = night(), u = Date.now();
      const [iw, ih, mw, mh] = n ? [512, 424, 256, 212] : [960, 540, 480, 270];
      const cam = n ? ir : color;
      onMessage({
        frame: { kind: "frame", seq: ++seq, t: u, u, source: n ? "infrared" : "color", w: iw, h: ih, image: scaled(cam, iw, ih), map: { w: mw, h: mh, ...scaled(cam, mw, mh) },
          dark: n ? 10 : 120, fps: 30, depthFps: 30, colorFps: 30, night: n, auto: source === "auto" },
        jpeg: n ? pictures.infrared : pictures.color,
        depth: n ? maps.infrared : maps.color,
      });
      if (this.recording) {
        onMessage({ raw: { kind: "raw", u, w: 512, h: 424 }, depth: raw, ir: raw });
        if (this.rawcolor) onMessage({ rawcolor: { kind: "rawcolor", u }, jpeg: pictures.full });
      }
    }, 33);
    if (options.mics !== false) {
      let k = 0;
      this.audioTimer = setInterval(() => {
        const frames = 1600, pcm = Buffer.alloc(frames * 16), beam = Buffer.alloc(frames * 2);
        for (let i = 0; i < frames; i++) {
          for (let m = 0; m < 4; m++) pcm.writeInt32LE(Math.round(Math.sin(((k + i - m) / 16000) * 2 * Math.PI * 440) * 2e8), (i * 4 + m) * 4);
          beam.writeInt16LE(Math.round(Math.sin(((k + i) / 16000) * 2 * Math.PI * 440) * 8000), i * 2);
        }
        k += frames;
        const header = { kind: "audio", u: Date.now() - 100, rate: 16000, channels: 4, frames, level: [0.07, 0.07, 0.07, 0.07], delays: [1, 2, 3], angle: 19, confidence: 0.8, active: true, snr: 24 };
        onMessage(this.recording ? { audio: header, pcm, beam } : { audio: header });
      }, 100);
    }
    this.source = (s) => (source = s);
  }

  command(line) {
    const [cmd, a] = String(line).split(" ");
    if (cmd === "stall") return this.stall();
    if (cmd === "record") this.recording = a === "on";
    else if (cmd === "rawcolor") this.rawcolor = a === "on";
    else if (cmd === "source" && this.source) this.source(a);
    else if (this.onMessage) this.onMessage({ status: "note", applied: line });
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    clearInterval(this.audioTimer);
    this.timer = this.audioTimer = null;
    this.onMessage({ status: "stopped", code: 0, detail: "" });
  }

  // As a Kinect whose pictures stop coming: the helper says so and ends.
  stall() {
    if (!this.timer) return;
    clearInterval(this.timer);
    clearInterval(this.audioTimer);
    this.timer = this.audioTimer = null;
    setTimeout(() => {
      this.onMessage({ status: "error", message: "The Kinect stopped sending pictures.", colors: 10, depths: 10 });
      this.onMessage({ status: "stopped", code: 0, detail: "" });
    }, 200);
  }
}

module.exports = { KinectCamera, KinectTake, KinectMics, SimulatedKinect, Beam, wavHeader, LINUX_HELPER };
