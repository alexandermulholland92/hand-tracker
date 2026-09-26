/**
 * exporter.js
 * Converts a recorded master clip (WebM from MediaRecorder), or any video file,
 * into the formats the user picked (see video-formats.js), and converts imported
 * videos the app can't play directly (AVI, MPEG, WMV, FLV…) into MP4 — using the
 * ffmpeg binary bundled via ffmpeg-static (or one on PATH as a fallback).
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const VideoFormats = require("../video-formats.js");

const FORMATS = VideoFormats.FORMATS;
const FORMAT_IDS = new Set(FORMATS.map((f) => f.id));

function resolveFfmpeg() {
  try {
    // Inside a packaged app the binary lives in app.asar.unpacked (see "asarUnpack").
    const bundled = require("ffmpeg-static");
    if (bundled) {
      const unpacked = bundled.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
      if (fs.existsSync(unpacked)) return unpacked;
    }
  } catch {
    // fall through to PATH
  }
  return "ffmpeg";
}

const ffmpegPath = resolveFfmpeg();
let availability = null;
let current = null; // { proc, canceled } for the conversion in progress
let cancelRequested = false;

function isAvailable() {
  if (!availability) {
    availability = new Promise((resolve) => {
      const proc = spawn(ffmpegPath, ["-hide_banner", "-version"], { windowsHide: true });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
    });
  }
  return availability;
}

function runFfmpeg(args, duration, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    current = { proc, canceled: false };
    const job = current;
    let stderr = "";
    let pending = "";

    proc.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-4000);
      if (!(duration > 0)) {
        const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
        if (m) duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      }
    });
    proc.stdout.on("data", (d) => {
      pending += d;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && duration > 0) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    });
    proc.on("error", (err) => {
      current = null;
      reject(err);
    });
    proc.on("close", (code) => {
      current = null;
      if (job.canceled) return reject(Object.assign(new Error("Canceled"), { canceled: true }));
      if (code === 0) return resolve();
      const lastLine = stderr.trim().split(/\r?\n/).pop();
      reject(new Error(lastLine || `ffmpeg exited with code ${code}`));
    });
  });
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

function sanitizeBaseName(name) {
  let base = String(name || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 120);
  if (!base) base = "hand-tracker-recording";
  if (RESERVED.test(base)) base = `_${base}`;
  return base;
}

// Never overwrite: "clip.mp4" -> "clip (1).mp4" -> "clip (2).mp4" ...
function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, `${base}.${ext}`);
  for (let n = 1; fs.existsSync(candidate); n++) {
    candidate = path.join(dir, `${base} (${n}).${ext}`);
  }
  return candidate;
}

/**
 * @param {object} job
 * @param {Buffer} job.data            recorded master clip
 * @param {"webm"|"mp4"} job.container container of the master clip
 * @param {string[]} job.formats       ids from FORMATS
 * @param {string} job.dir             output folder
 * @param {string} job.baseName        file name without extension
 * @param {number} job.duration        seconds (MediaRecorder files don't store it)
 * @param {number} job.fps
 * @param {number} [job.retimeFps]    source frame rate when the clip was recorded from a video file
 * @param {(p: {format, index, total, progress}) => void} onProgress
 */
async function exportVideo(job, onProgress) {
  const formats = job.formats.filter((id) => FORMAT_IDS.has(id));
  const base = sanitizeBaseName(job.baseName);
  const source = job.container === "mp4" ? "mp4" : "webm";
  const hasFfmpeg = await isAvailable();
  const tmp = path.join(os.tmpdir(), `hand-tracker-${process.pid}-${Date.now()}.${source}`);
  await fs.promises.writeFile(tmp, job.data);

  const results = [];
  cancelRequested = false;
  try {
    for (let i = 0; i < formats.length; i++) {
      const id = formats[i];
      const { ext, suffix } = FORMATS.find((f) => f.id === id);
      const report = (progress) => onProgress({ format: id, index: i, total: formats.length, progress });

      if (cancelRequested) {
        results.push({ format: id, ok: false, error: "Canceled" });
        continue;
      }
      const out = uniquePath(job.dir, base + suffix, ext);
      report(0);
      try {
        if (!hasFfmpeg) {
          if (id !== source) throw new Error("ffmpeg isn't available, so only the original format can be saved.");
          await fs.promises.copyFile(tmp, out);
        } else {
          const options = { fps: job.fps, retimeFps: job.retimeFps, constantRate: true, copyFromWebm: source === "webm" };
          const args = [
            "-hide_banner", "-nostdin", "-y", "-i", tmp,
            ...VideoFormats.outputArgs(id, options),
            "-progress", "pipe:1", "-nostats", out,
          ];
          await runFfmpeg(args, job.duration, report);
        }
        report(1);
        const { size } = await fs.promises.stat(out);
        results.push({ format: id, ok: true, path: out, size });
      } catch (err) {
        await fs.promises.rm(out, { force: true }).catch(() => {});
        results.push({ format: id, ok: false, error: err.canceled ? "Canceled" : err.message });
      }
    }
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
  return { results, canceled: cancelRequested };
}

// What's in a video file: { duration, fps, width, height, videoCodec, hasAudio }.
function probe(inputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ["-hide_banner", "-nostdin", "-i", inputPath], { windowsHide: true });
    let text = "";
    proc.stderr.on("data", (d) => (text += d));
    proc.on("error", reject);
    // "At least one output file must be specified" makes this exit 1; the stream list is what matters.
    proc.on("close", () => {
      const info = VideoFormats.parseProbe(text);
      if (!info.width) return reject(new Error("ffmpeg couldn't find a video stream in this file."));
      resolve(info);
    });
  });
}

/**
 * Converts a video file on disk to each format, straight from the original (so
 * nothing is lost to an intermediate copy, and its sound is kept).
 * @param {object} job  { inputPath, formats: string[], dir, baseName }
 * @param {(p: {format, index, total, progress}) => void} onProgress
 */
async function convertFile(job, onProgress) {
  if (!(await isAvailable())) throw new Error("ffmpeg isn't available, so videos can't be converted.");
  const formats = job.formats.filter((id) => FORMAT_IDS.has(id));
  const base = sanitizeBaseName(job.baseName);
  const info = await probe(job.inputPath);
  const results = [];
  cancelRequested = false;
  for (let i = 0; i < formats.length; i++) {
    const id = formats[i];
    const { ext, suffix } = FORMATS.find((f) => f.id === id);
    const report = (progress) => onProgress({ format: id, index: i, total: formats.length, progress });
    if (cancelRequested) {
      results.push({ format: id, ok: false, error: "Canceled" });
      continue;
    }
    const out = uniquePath(job.dir, base + suffix, ext);
    report(0);
    try {
      const args = [
        "-hide_banner", "-nostdin", "-y", "-i", job.inputPath,
        ...VideoFormats.outputArgs(id, { fps: info.fps }),
        "-progress", "pipe:1", "-nostats", out,
      ];
      await runFfmpeg(args, info.duration, report);
      report(1);
      const { size } = await fs.promises.stat(out);
      results.push({ format: id, ok: true, path: out, size });
    } catch (err) {
      await fs.promises.rm(out, { force: true }).catch(() => {});
      results.push({ format: id, ok: false, error: err.canceled ? "Canceled" : err.message });
    }
  }
  return { results, canceled: cancelRequested };
}

function cancel() {
  cancelRequested = true;
  if (current) {
    current.canceled = true;
    current.proc.kill();
  }
}

// Converts an imported video the app can't play into an MP4 (H.264, no audio)
// in outDir. onProgress(0..1). Resolves with the output path.
async function convertForPlayback(inputPath, outDir, onProgress) {
  if (!(await isAvailable())) throw new Error("ffmpeg isn't available, so this video format can't be converted.");
  const out = path.join(outDir, `import-${Date.now()}.mp4`);
  const args = [
    "-hide_banner", "-nostdin", "-y", "-i", inputPath,
    "-map", "0:v:0", "-an", "-sn", "-dn",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats", out,
  ];
  cancelRequested = false;
  try {
    await runFfmpeg(args, 0, onProgress);
  } catch (err) {
    await fs.promises.rm(out, { force: true }).catch(() => {});
    throw err.canceled ? err : new Error(`ffmpeg couldn't convert this video: ${err.message}`);
  }
  return out;
}

module.exports = { FORMATS, exportVideo, convertFile, probe, convertForPlayback, cancel, isAvailable, sanitizeBaseName, uniquePath, ffmpegPath };
