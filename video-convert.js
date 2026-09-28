/**
 * video-convert.js
 * Opening and converting any video in the website and the Android app, with
 * ffmpeg.wasm. (The Windows app has a real ffmpeg: see electron/exporter.js.)
 * The engine (~32 MB) is only downloaded the first time it's needed. Formats and
 * their settings come from video-formats.js.
 *
 *   VideoConvert.supported()        true outside the Windows app, where WebAssembly works
 *   VideoConvert.formats()          VideoFormats.FORMATS, marked available or not here
 *   await VideoConvert.probe(file)  { duration, fps, width, height, videoCodec, hasAudio }
 *   await VideoConvert.toPlayable(file, onProgress)  -> Blob: H.264 MP4 any page can play
 *   await VideoConvert.convert(file, ids, options)   -> { results, canceled }
 *     options = { retimeFps, constantRate, copyFromWebm, fps, duration, trim, onProgress, onResult }
 *       trim: { start, length } in seconds, to convert just that stretch (synced videos)
 *       onProgress({ format, index, total, progress 0..1, loading })  loading: engine downloading
 *       onResult({ format, ok, ext, suffix, data: Uint8Array } | { format, ok: false, error })
 *         called as each format finishes, so callers can save it straight away;
 *         results then leave out the data.
 *   VideoConvert.cancel()           stops the conversion in progress
 *
 * file: a File, or a Blob plus options.name (used for its extension).
 */

(function (global) {
  const FFMPEG_JS = "node_modules/@ffmpeg/ffmpeg/dist/umd/ffmpeg.js";
  const CORE_JS = "node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js";
  const CORE_WASM = "node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm";
  const EVEN = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

  let engine = null; // Promise<FFmpeg>
  let wasmBlobUrl = null; // the joined engine, kept for restarts
  let log = [];
  let onLog = null;
  let canceled = false;
  let jobCount = 0;

  const absolute = (url) => new URL(url, global.location.href).href;

  function supported() {
    return !global.desktop && typeof WebAssembly === "object" && typeof Worker === "function";
  }

  function formats() {
    return global.VideoFormats.FORMATS.map((f) => ({
      ...f,
      detail: f.wasmDetail || f.detail,
      available: f.wasm,
      why: f.wasm ? "" : "Only the Windows app can make this format",
    }));
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("The video converter couldn't be loaded. Check the connection and try again."));
      document.head.appendChild(s);
    });
  }

  // Websites can't host files over 25 MB, so the build splits the engine into parts
  // listed in ffmpeg-core.wasm.json and they're joined here. From source it's one file.
  async function engineWasm() {
    if (wasmBlobUrl) return wasmBlobUrl;
    let parts = [CORE_WASM];
    try {
      const res = await fetch(`${CORE_WASM}.json`);
      if (res.ok) parts = (await res.json()).parts.map((p) => new URL(p, absolute(CORE_WASM)).href);
    } catch {
      // no parts list: the whole file
    }
    const blobs = await Promise.all(
      parts.map(async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error("The video converter couldn't be downloaded. Check the connection and try again.");
        return res.blob();
      })
    );
    wasmBlobUrl = URL.createObjectURL(new Blob(blobs, { type: "application/wasm" }));
    return wasmBlobUrl;
  }

  function getEngine() {
    if (!engine) {
      engine = (async () => {
        if (!global.FFmpegWASM) await loadScript(FFMPEG_JS);
        const ff = new global.FFmpegWASM.FFmpeg();
        ff.on("log", ({ message }) => {
          log.push(message);
          if (log.length > 500) log.splice(0, 250);
          if (onLog) onLog(message);
        });
        await ff.load({ coreURL: absolute(CORE_JS), wasmURL: await engineWasm() });
        return ff;
      })();
      engine.catch(() => (engine = null));
    }
    return engine;
  }

  // Errors ffmpeg reports are Errors we make from its log; anything else (RuntimeError,
  // TypeError, even undefined) means the engine itself crashed.
  const isCrash = (err) => !(err instanceof Error && err.name === "Error");

  // After a crash (or a cancel) the engine can't be reused; the next job starts a new one.
  function discardEngine() {
    const old = engine;
    engine = null;
    if (old) old.then((ff) => ff.terminate()).catch(() => {});
  }

  // One ffmpeg run. The log level is set every time: ffmpeg.wasm keeps it between runs.
  async function run(ff, args, onTime) {
    log = [];
    onLog = onTime
      ? (line) => {
          const m = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
          if (m) onTime(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
        }
      : null;
    try {
      const code = await ff.exec(["-hide_banner", "-loglevel", "info", ...args]);
      return { code, text: log.join("\n") };
    } finally {
      onLog = null;
    }
  }

  function failure(text) {
    const lines = text.split("\n").filter((l) => /error|invalid|not supported|unsupported|could not|failed/i.test(l));
    return new Error((lines.pop() || "The conversion failed").trim());
  }

  // Makes the file readable by the engine without copying it into memory (WORKERFS).
  async function attach(ff, file, name) {
    const dir = `/in${++jobCount}`;
    const named = file instanceof File ? file : new File([file], name || "input.bin");
    await ff.createDir(dir);
    await ff.mount("WORKERFS", { files: [named] }, dir);
    return {
      path: `${dir}/${named.name}`,
      async detach() {
        try {
          await ff.unmount(dir);
          await ff.deleteDir(dir);
        } catch {
          // the engine may already be gone
        }
      },
    };
  }

  async function probeWith(ff, path) {
    const info = global.VideoFormats.parseProbe((await run(ff, ["-i", path])).text);
    if (!info.width) throw new Error("No video was found in this file, or its format isn't supported.");
    return info;
  }

  async function probe(file, name) {
    const ff = await getEngine();
    const input = await attach(ff, file, name);
    try {
      return await probeWith(ff, input.path);
    } finally {
      await input.detach();
    }
  }

  async function toPlayable(file, onProgress = () => {}, name) {
    canceled = false;
    onProgress({ progress: 0, loading: !engine });
    const ff = await getEngine();
    const input = await attach(ff, file, name);
    try {
      const info = await probeWith(ff, input.path);
      const out = `/playable-${jobCount}.mp4`;
      const args = [
        "-y", "-i", input.path, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p", "-vf", EVEN,
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out,
      ];
      const { code, text } = await run(ff, args, (t) => info.duration && onProgress({ progress: Math.min(1, t / info.duration) }));
      if (code !== 0) throw failure(text);
      const data = await ff.readFile(out);
      await ff.deleteFile(out);
      return new Blob([data], { type: "video/mp4" });
    } catch (err) {
      if (isCrash(err) || canceled) discardEngine();
      throw canceled ? new Error("Canceled") : isCrash(err) ? new Error("The video converter crashed on this file.") : err;
    } finally {
      await input.detach();
    }
  }

  // The input, or just a stretch of it: seeking before the input keeps it quick, and as
  // every format is re-encoded the cut is still exact to the frame.
  function trimArgs(trim, inputPath) {
    return trim ? ["-ss", trim.start.toFixed(3), "-i", inputPath, "-t", trim.length.toFixed(3)] : ["-i", inputPath];
  }

  async function convert(file, ids, options = {}) {
    const { retimeFps = 0, constantRate = false, copyFromWebm = false, fps = 0, duration = 0, name, trim = null } = options;
    const onProgress = options.onProgress || (() => {});
    const byId = new Map(formats().map((f) => [f.id, f]));
    const list = ids.filter((id) => byId.has(id));
    const results = [];
    canceled = false;

    onProgress({ format: list[0], index: 0, total: list.length, progress: 0, loading: !engine });
    let ff = await getEngine();
    let input = await attach(ff, file, name);
    let info;
    try {
      info = await probeWith(ff, input.path);
    } catch (err) {
      await input.detach();
      throw err;
    }
    const total = trim ? trim.length : duration || (retimeFps && fps ? (info.duration * fps) / retimeFps : info.duration);

    for (let i = 0; i < list.length; i++) {
      const f = byId.get(list[i]);
      const report = (progress) => onProgress({ format: f.id, index: i, total: list.length, progress });
      let result;
      if (canceled) result = { format: f.id, ok: false, error: "Canceled" };
      else if (!f.available) result = { format: f.id, ok: false, error: f.why };
      else {
        const out = `/out-${jobCount}-${i}.${f.ext}`;
        report(0);
        try {
          const args = [
            "-y", ...trimArgs(trim, input.path),
            ...global.VideoFormats.outputArgs(f.id, { fps: fps || info.fps, retimeFps, constantRate, copyFromWebm, wasm: true }),
            out,
          ];
          const { code, text } = await run(ff, args, (t) => total && report(Math.min(1, t / total)));
          if (code !== 0) throw failure(text);
          const data = await ff.readFile(out);
          await ff.deleteFile(out);
          report(1);
          result = { format: f.id, ok: true, ext: f.ext, suffix: f.suffix, data };
        } catch (err) {
          result = { format: f.id, ok: false, error: canceled ? "Canceled" : (err && err.message) || String(err) };
          if (isCrash(err) && !canceled) result.error = "The video converter crashed on this format.";
          // A crash leaves the engine unusable: start a fresh one for the next format.
          if (!canceled && isCrash(err)) {
            discardEngine();
            ff = await getEngine();
            input = await attach(ff, file, name);
          }
        }
      }
      if (options.onResult) {
        options.onResult(result);
        if (result.ok) result = { ...result, data: undefined, size: result.data.length };
      }
      results.push(result);
    }
    await input.detach();
    return { results, canceled };
  }

  function cancel() {
    canceled = true;
    discardEngine(); // stops the ffmpeg run in progress
  }

  global.VideoConvert = { supported, formats, probe, toPlayable, convert, cancel };
})(window);
