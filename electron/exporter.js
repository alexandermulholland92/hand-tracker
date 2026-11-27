/**
 * exporter.js
 * Converts a recorded master clip (WebM from MediaRecorder), or any video file,
 * into the formats the user picked (see video-formats.js), and converts imported
 * videos the app can't play directly (AVI, MPEG, WMV, FLV…) into MP4 — using the
 * ffmpeg binary bundled via ffmpeg-static (or one on PATH as a fallback). Also puts a take's
 * camera videos side by side in one video (gridVideo: the Recording Converter's Grid video).
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

// cwd: where it runs (label-layers.js's tracks, named plainly in a filter's arguments).
function runFfmpeg(args, duration, onProgress, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true, ...(cwd ? { cwd } : {}) });
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

// A clip from the browser's recorder (remote recording's camera videos, Sentry's), made a plain
// MP4 that plays everywhere: the recorder writes it a piece at a time (a fragmented MP4, which
// some players, Apple's among them, don't take well), and on Linux with Opus sound, as Linux's
// recorder has no AAC. The picture is copied as it is (a fraction of a second); only Opus sound
// is made again, as AAC. Left as it was if ffmpeg can't. -> true if it was redone
async function finishClip(file, mimeType) {
  if (!(await isAvailable())) return false;
  const part = `${file}.part`;
  const sound = /opus/i.test(String(mimeType || "")) ? ["-c:a", "aac", "-b:a", "96k"] : ["-c:a", "copy"];
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-map", "0", "-c:v", "copy", ...sound, "-movflags", "+faststart", "-f", "mp4", part];
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, args, { windowsHide: true });
      let stderr = "";
      proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
      proc.on("error", reject);
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim().split(/\r?\n/).pop() || `ffmpeg exited with code ${code}`))));
    });
    await fs.promises.rename(part, file);
    return true;
  } catch {
    await fs.promises.rm(part, { force: true }).catch(() => {});
    return false;
  }
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
 * @param {object} [job.layers]        the clip's labels as tracks (electron/label-layers.js's bundle, with its args
 *                                     and filter): each format gets them drawn in, as <name> (labels)<suffix>.<ext>,
 *                                     and <name>.mkv is the clean picture with them as tracks (format "clean")
 * @param {(p: {format, index, total, progress}) => void} onProgress
 */
async function exportVideo(job, onProgress) {
  const formats = job.formats.filter((id) => FORMAT_IDS.has(id));
  const base = sanitizeBaseName(job.baseName);
  const source = job.container === "mp4" ? "mp4" : "webm";
  const hasFfmpeg = await isAvailable();
  const layers = hasFfmpeg && job.layers && job.layers.args ? job.layers : null;
  const tmp = path.join(os.tmpdir(), `hand-tracker-${process.pid}-${Date.now()}.${source}`);
  await fs.promises.writeFile(tmp, job.data);

  const results = [];
  cancelRequested = false;
  const total = formats.length + (layers ? 1 : 0);
  try {
    for (let i = 0; i < formats.length; i++) {
      const id = formats[i];
      const { ext, suffix } = FORMATS.find((f) => f.id === id);
      const report = (progress) => onProgress({ format: id, index: i, total, progress });

      if (cancelRequested) {
        results.push({ format: id, ok: false, error: "Canceled" });
        continue;
      }
      const out = uniquePath(job.dir, base + (layers ? " (labels)" : "") + suffix, ext);
      report(0);
      try {
        if (!hasFfmpeg) {
          if (id !== source) throw new Error("ffmpeg isn't available, so only the original format can be saved.");
          await fs.promises.copyFile(tmp, out);
        } else {
          const options = { fps: job.fps, retimeFps: job.retimeFps, constantRate: true, copyFromWebm: source === "webm", labels: layers ? layers.filter : "" };
          const args = [
            "-hide_banner", "-nostdin", "-y", "-i", tmp,
            ...VideoFormats.outputArgs(id, options),
            "-progress", "pipe:1", "-nostats", out,
          ];
          await runFfmpeg(args, job.duration, report, layers ? layers.cwd : undefined);
        }
        report(1);
        const { size } = await fs.promises.stat(out);
        results.push({ format: id, ok: true, path: out, size });
      } catch (err) {
        await fs.promises.rm(out, { force: true }).catch(() => {});
        results.push({ format: id, ok: false, error: err.canceled ? "Canceled" : err.message });
      }
    }
    // The clean picture with the labels as tracks a player switches on (copied as recorded; made again only
    // when it's re-timed to its video file's own rate).
    if (layers) {
      const report = (progress) => onProgress({ format: "clean", index: formats.length, total, progress });
      const out = uniquePath(job.dir, base, "mkv");
      if (cancelRequested) results.push({ format: "clean", ok: false, error: "Canceled" });
      else {
        report(0);
        try {
          const a = layers.args;
          const r = Number(job.retimeFps) > 0 ? Number(job.retimeFps) : 0;
          const video = r
            ? ["-vf", `setpts=N/(${r}*TB),scale=trunc(iw/2)*2:trunc(ih/2)*2`, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(Math.round(r * 1000) / 1000)]
            : ["-c:v", "copy"];
          await runFfmpeg(["-hide_banner", "-nostdin", "-y", "-i", tmp, ...a.inputs, "-map", "0:v:0", "-map", "0:a?", ...a.maps, ...video, "-c:a", "copy", "-c:s", "copy",
            ...a.meta, ...a.attach, "-progress", "pipe:1", "-nostats", out], job.duration, report, layers.cwd);
          report(1);
          results.push({ format: "clean", ok: true, path: out, size: (await fs.promises.stat(out)).size, clean: true });
        } catch (err) {
          await fs.promises.rm(out, { force: true }).catch(() => {});
          results.push({ format: "clean", ok: false, error: err.canceled ? "Canceled" : err.message });
        }
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
 * @param {object} job  { inputPath, formats: string[], dir, baseName, trim? }
 *   trim: { start, length } in seconds, to convert just that stretch (synced videos)
 * @param {(p: {format, index, total, progress}) => void} onProgress
 */
async function convertFile(job, onProgress) {
  if (!(await isAvailable())) throw new Error("ffmpeg isn't available, so videos can't be converted.");
  const formats = job.formats.filter((id) => FORMAT_IDS.has(id));
  const base = sanitizeBaseName(job.baseName);
  const info = await probe(job.inputPath);
  const trim = job.trim;
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
      // Seeking before the input keeps a trim quick; every format is re-encoded, so it's still frame-exact.
      const input = trim ? ["-ss", trim.start.toFixed(3), "-i", job.inputPath, "-t", trim.length.toFixed(3)] : ["-i", job.inputPath];
      const args = [
        "-hide_banner", "-nostdin", "-y", ...input,
        ...VideoFormats.outputArgs(id, { fps: info.fps }),
        "-progress", "pipe:1", "-nostats", out,
      ];
      await runFfmpeg(args, trim ? trim.length : info.duration, report);
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

// A take's camera videos as one 1080p MP4 (the Recording Converter's Grid video): an even grid, 2 × 2 for
// up to 4 cameras and 3 × 2 for 5 or 6, filled in the order given, each picture fitted in its block (black
// around it) with its label (a PNG the page drew, in its top left corner); on the take's clock: each video
// started start seconds after the take (before it, if less than 0: that bit is left out), black before it
// starts and after it ends; the sound of the first one that has any. Its length: the take's (length, in
// seconds), else as long as the videos go.
//   job = { videos: [{ path, start, label (a PNG's path, or none) }], length, out } -> { path, size, layout, sound }
// With the labels as a layer of their own (job.layers: label-layers.js's bundle, its args (its tracks the inputs after
// the videos) and filter; job.labelled):
// no PNGs drawn in; job.out (.mkv) is the clean grid with the labels as tracks, job.labelled (.mp4) the grid with
// them drawn in, both made at once -> also { labelled, labelledSize }.
//   gridPlaces(n, infos): where each picture goes, { x, y, w, h, k } (k: its scale), for its labels to go there too.
const GRID = { w: 1920, h: 1080, fps: 30, most: 6 };
function gridLayout(n) {
  const cols = n <= 4 ? 2 : 3;
  return { cols, rows: 2, w: GRID.w / cols, h: GRID.h / 2 };
}
function gridPlaces(n, infos) {
  const { cols, w, h } = gridLayout(n);
  return infos.slice(0, n).map((info, i) => {
    const x0 = (i % cols) * w, y0 = Math.floor(i / cols) * h;
    const k = info && info.width && info.height ? Math.min(w / info.width, h / info.height) : 1;
    // (as ffmpeg's scale with force_original_aspect_ratio=decrease, then pad centred)
    const pw = Math.floor((info ? info.width : w) * k), ph = Math.floor((info ? info.height : h) * k);
    return { x0, y0, w, h, k, x: x0 + Math.floor((w - pw) / 2), y: y0 + Math.floor((h - ph) / 2) };
  });
}
async function gridVideo(job, onProgress = () => {}) {
  if (!(await isAvailable())) throw new Error("ffmpeg isn't available, so videos can't be put together.");
  const videos = (job.videos || []).slice(0, GRID.most);
  if (videos.length < 2) throw new Error("A grid needs two videos or more.");
  const layers = job.layers && job.layers.args && job.labelled ? job.layers : null;
  const infos = [];
  for (const v of videos) infos.push(await probe(v.path));
  const { cols, rows, w, h } = gridLayout(videos.length);
  const sec = (x) => Math.max(0, x).toFixed(3);
  const length = Number(job.length) > 0 ? Number(job.length) : Math.max(...videos.map((v, i) => (Number(v.start) || 0) + (infos[i].duration || 0)));
  if (!(length > 0)) throw new Error("These videos have no length.");
  const args = ["-hide_banner", "-nostdin", "-y"];
  for (const v of videos) args.push("-i", v.path);
  const labels = [];
  for (const v of videos) {
    if (v.label && !layers) {
      labels.push(videos.length + labels.length);
      args.push("-i", v.label);
    } else labels.push(-1);
  }
  const graph = [];
  videos.forEach((v, i) => {
    const s = Number(v.start) || 0;
    graph.push(`[${i}:v:0]setpts=PTS-STARTPTS,trim=start=${sec(-s)},setpts=PTS-STARTPTS,fps=${GRID.fps},` +
      `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,` +
      `tpad=start_duration=${sec(s)}:stop=-1:color=black` + (labels[i] >= 0 ? `[p${i}];[p${i}][${labels[i]}:v]overlay=x=16:y=16:eof_action=repeat[c${i}]` : `[c${i}]`));
  });
  for (let k = videos.length; k < cols * rows; k++) graph.push(`color=c=black:s=${w}x${h}:r=${GRID.fps}[c${k}]`);
  const layout = Array.from({ length: cols * rows }, (_, k) => `${(k % cols) * w}_${Math.floor(k / cols) * h}`).join("|");
  graph.push(`${Array.from({ length: cols * rows }, (_, k) => `[c${k}]`).join("")}xstack=inputs=${cols * rows}:layout=${layout}[grid]`);
  if (layers) graph.push(layers.filter ? `[grid]split=2[gridc][gridb];[gridb]${layers.filter}[gridl]` : "[grid]split=2[gridc][gridl]");
  const sound = infos.findIndex((x) => x.hasAudio);
  if (sound >= 0) {
    const s = Number(videos[sound].start) || 0;
    graph.push(`[${sound}:a:0]asetpts=PTS-STARTPTS,atrim=start=${sec(-s)},asetpts=PTS-STARTPTS,adelay=${Math.round(Math.max(0, s) * 1000)}:all=1,apad${layers ? ",asplit=2[sound][soundl]" : "[sound]"}`);
  }
  const encode = ["-t", length.toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-r", String(GRID.fps)];
  if (layers) {
    const a = layers.args;
    args.push(...a.inputs, "-filter_complex", graph.join(";"), "-progress", "pipe:1", "-nostats");
    // the clean grid, its tracks beside it
    args.push("-map", "[gridc]", ...(sound >= 0 ? ["-map", "[sound]", "-c:a", "aac", "-b:a", "160k"] : []),
      ...a.maps, ...encode, "-c:s", "copy", ...a.meta, ...a.attach, "-f", "matroska", job.out);
    // and with them drawn in
    args.push("-map", "[gridl]", ...(sound >= 0 ? ["-map", "[soundl]", "-c:a", "aac", "-b:a", "160k"] : []), ...encode, "-movflags", "+faststart", "-f", "mp4", job.labelled);
  } else {
    args.push("-filter_complex", graph.join(";"), "-map", "[grid]");
    if (sound >= 0) args.push("-map", "[sound]", "-c:a", "aac", "-b:a", "160k");
    args.push(...encode, "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", job.out);
  }
  cancelRequested = false;
  try {
    await runFfmpeg(args, length, onProgress, layers ? layers.cwd : undefined);
  } catch (err) {
    await fs.promises.rm(job.out, { force: true }).catch(() => {});
    if (layers) await fs.promises.rm(job.labelled, { force: true }).catch(() => {});
    throw err;
  }
  const { size } = await fs.promises.stat(job.out);
  const extra = layers ? { labelled: job.labelled, labelledSize: (await fs.promises.stat(job.labelled)).size } : {};
  return { path: job.out, size, layout: `${cols} × ${rows}`, sound, ...extra };
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

module.exports = { FORMATS, exportVideo, convertFile, probe, convertForPlayback, finishClip, gridVideo, gridLayout, gridPlaces, cancel, isAvailable, sanitizeBaseName, uniquePath, ffmpegPath };
