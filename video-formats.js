/**
 * video-formats.js
 * Every video format the app can export, and the ffmpeg settings for each. Shared
 * by the Windows app (electron/exporter.js, native ffmpeg) and the website and
 * Android app (video-convert.js, ffmpeg.wasm), so all of them offer the same list.
 *
 *   VideoFormats.FORMATS                 [{ id, label, detail, wasmDetail?, ext, suffix, group, audio, wasm }]
 *   VideoFormats.outputArgs(id, options) ffmpeg arguments that follow "-i <input>"
 *     options = { fps, retimeFps, constantRate, copyFromWebm, wasm }
 *       fps           source frame rate (needed by formats with fixed frame rates)
 *       retimeFps     re-time every frame to this rate (clips recorded from a video file)
 *       constantRate  force a constant frame rate (MediaRecorder clips are variable)
 *       copyFromWebm  the input is the app's own VP9 WebM recording: WebM/MKV just copy it
 *       wasm          running in ffmpeg.wasm: quicker settings (it has one core) and VP8
 *                     for WebM (its VP9 encoder crashes)
 *   VideoFormats.IMPORT_ACCEPT           file-picker filter for any video
 *   VideoFormats.parseProbe(text)        { duration, fps, width, height, videoCodec, hasAudio } from "ffmpeg -i" output
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VideoFormats = api;
})(typeof self !== "undefined" ? self : this, function () {
  const EVEN = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

  // group: where the format is listed. audio: keeps the source's sound.
  // wasm: available in the website/Android converter. ffmpeg.wasm has no AV1 encoder, and
  // its HEVC encoder (x265) hangs without threads, so those two need the Windows app.
  const FORMATS = [
    { id: "mp4", label: "MP4", detail: "H.264 · plays almost everywhere", ext: "mp4", group: "Common", audio: true },
    { id: "mov", label: "MOV", detail: "H.264 · QuickTime and editors", ext: "mov", group: "Common", audio: true },
    { id: "webm", label: "WebM", detail: "VP9 · web and browsers", wasmDetail: "VP8 · web and browsers", ext: "webm", group: "Common", audio: true },
    { id: "mkv", label: "MKV", detail: "Matroska · H.264", ext: "mkv", group: "Common", audio: true },
    { id: "avi", label: "AVI", detail: "MPEG-4 (Xvid) · older players", ext: "avi", group: "Common", audio: true },
    { id: "gif", label: "GIF", detail: "Animated · 15 fps, max 800 px wide", ext: "gif", group: "Common", audio: false },

    { id: "m4v", label: "M4V", detail: "H.264 · Apple devices and iTunes", ext: "m4v", group: "More formats", audio: true },
    { id: "wmv", label: "WMV", detail: "Windows Media Video", ext: "wmv", group: "More formats", audio: true },
    { id: "mpg", label: "MPG", detail: "MPEG-2 · DVD-era players", ext: "mpg", group: "More formats", audio: true },
    { id: "mpeg", label: "MPEG-1", detail: "Plays on nearly anything", ext: "mpeg", group: "More formats", audio: true },
    { id: "vob", label: "VOB", detail: "DVD video (MPEG-2, AC-3 sound)", ext: "vob", group: "More formats", audio: true },
    { id: "ts", label: "TS", detail: "MPEG transport stream · H.264", ext: "ts", group: "More formats", audio: true },
    { id: "m2ts", label: "M2TS", detail: "Blu-ray / AVCHD · H.264", ext: "m2ts", group: "More formats", audio: true },
    { id: "flv", label: "FLV", detail: "Flash Video · H.264", ext: "flv", group: "More formats", audio: true },
    { id: "3gp", label: "3GP", detail: "Older phones · H.264", ext: "3gp", group: "More formats", audio: true },
    { id: "3g2", label: "3G2", detail: "Older CDMA phones · H.264", ext: "3g2", group: "More formats", audio: true },
    { id: "ogv", label: "OGV", detail: "Ogg Theora · open format", ext: "ogv", group: "More formats", audio: true },

    { id: "hevc", label: "HEVC", detail: "H.265 MP4 · about half the size of H.264", ext: "mp4", suffix: "-hevc", group: "Newer codecs", audio: true, wasm: false },
    { id: "av1", label: "AV1", detail: "AV1 WebM · smallest files, slow to make", ext: "webm", suffix: "-av1", group: "Newer codecs", audio: true, wasm: false },

    { id: "prores", label: "ProRes", detail: "ProRes 422 MOV · Final Cut, Premiere, Resolve", ext: "mov", suffix: "-prores", group: "Editing and archiving", audio: true },
    { id: "dnxhr", label: "DNxHR", detail: "DNxHR HQ MOV · Avid, Premiere, Resolve", ext: "mov", suffix: "-dnxhr", group: "Editing and archiving", audio: true },
    { id: "mxf", label: "MXF", detail: "Broadcast · MPEG-2 4:2:2", ext: "mxf", group: "Editing and archiving", audio: true },
    { id: "mjpeg", label: "Motion JPEG", detail: "AVI · every frame a JPEG, easy to edit", ext: "avi", suffix: "-mjpeg", group: "Editing and archiving", audio: true },
    { id: "ffv1", label: "FFV1", detail: "Lossless MKV · archiving, large files", ext: "mkv", suffix: "-lossless", group: "Editing and archiving", audio: true },
    { id: "dv", label: "DV", detail: "MiniDV · 720 × 480 or 576", ext: "dv", group: "Editing and archiving", audio: true },

    { id: "webp", label: "WebP", detail: "Animated image · 15 fps, max 800 px wide", ext: "webp", group: "Animated images", audio: false },
    { id: "apng", label: "APNG", detail: "Animated PNG · 15 fps, max 640 px wide", ext: "apng", group: "Animated images", audio: false },
  ].map((f) => ({ suffix: "", wasm: true, ...f }));
  const BY_ID = new Map(FORMATS.map((f) => [f.id, f]));

  // MPEG-1/2, VOB and DV only allow these frame rates; the nearest one is used.
  const STANDARD_RATES = ["24000/1001", "24", "25", "30000/1001", "30", "50", "60000/1001", "60"];
  function nearestStandardRate(fps) {
    const value = (r) => (r.includes("/") ? Number(r.split("/")[0]) / Number(r.split("/")[1]) : Number(r));
    let best = "30";
    for (const r of STANDARD_RATES) if (Math.abs(value(r) - fps) < Math.abs(value(best) - fps)) best = r;
    return best;
  }

  function outputArgs(id, options = {}) {
    const f = BY_ID.get(id);
    if (!f) throw new Error(`Unknown format: ${id}`);
    const { fps = 0, retimeFps = 0, constantRate = false, copyFromWebm = false, wasm = false } = options;
    const retime = retimeFps > 0 ? `setpts=N/(${retimeFps}*TB)` : "";
    const rate = retimeFps > 0 ? retimeFps : fps;
    const filters = (...more) => ["-vf", [retime, ...more].filter(Boolean).join(",")];
    const cfr = rate > 0 && (constantRate || retimeFps > 0) ? ["-r", String(Math.round(rate * 1000) / 1000)] : [];
    const std = ["-r", nearestStandardRate(rate || 30)];
    const h264 = (profile) => [
      "-c:v", "libx264", "-preset", wasm ? "veryfast" : "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      ...(profile ? ["-profile:v", profile] : []), ...filters(EVEN), ...cfr,
    ];
    const aac = ["-c:a", "aac", "-b:a", "160k"];
    const pcm = (rateHz) => ["-c:a", "pcm_s16le", ...(rateHz ? ["-ar", String(rateHz)] : [])];
    let video, audio, container = [];

    switch (id) {
      case "mp4":
      case "mov":
      case "m4v":
        video = [...h264(), "-movflags", "+faststart"];
        audio = aac;
        break;
      case "mkv":
        // The app's own WebM recordings are VP9, which Matroska holds as-is (original quality).
        if (copyFromWebm && !retime) return ["-map", "0", "-c", "copy"];
        video = h264();
        audio = aac;
        break;
      case "webm":
        // Remuxing a WebM recording also adds the duration and seek index MediaRecorder leaves out.
        if (copyFromWebm && !retime) return ["-map", "0", "-c", "copy"];
        video = wasm
          ? ["-c:v", "libvpx", "-b:v", "4M", "-crf", "10", "-deadline", "realtime", "-cpu-used", "8", ...filters(EVEN), ...cfr]
          : ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", ...filters(EVEN), ...cfr];
        audio = ["-c:a", "libopus", "-b:a", "128k"];
        break;
      case "avi":
        video = ["-c:v", "mpeg4", "-q:v", "3", "-tag:v", "XVID", ...filters(EVEN), ...cfr];
        audio = ["-c:a", "libmp3lame", "-b:a", "192k"];
        break;
      case "gif":
        video = [
          "-vf",
          `${retime ? retime + "," : ""}fps=15,scale='min(800,iw)':-1:flags=lanczos,split[a][b];` +
            "[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
          "-loop", "0",
        ];
        break;
      case "wmv":
        video = ["-c:v", "wmv2", "-b:v", "6M", ...filters(EVEN), ...cfr];
        audio = ["-c:a", "wmav2", "-b:a", "160k"];
        break;
      case "mpg":
        video = ["-c:v", "mpeg2video", "-q:v", "3", "-g", "15", "-bf", "2", ...filters(EVEN), ...std];
        audio = ["-c:a", "mp2", "-b:a", "192k"];
        container = ["-f", "vob"]; // MPEG-2 program stream
        break;
      case "mpeg":
        video = ["-c:v", "mpeg1video", "-q:v", "3", "-g", "15", ...filters(EVEN), ...std];
        audio = ["-c:a", "mp2", "-b:a", "192k"];
        container = ["-f", "mpeg"];
        break;
      case "vob":
        video = ["-c:v", "mpeg2video", "-q:v", "3", "-g", "15", "-bf", "2", ...filters(EVEN), ...std];
        audio = ["-c:a", "ac3", "-b:a", "192k", "-ar", "48000"];
        container = ["-f", "dvd"];
        break;
      case "ts":
        video = h264();
        audio = aac;
        container = ["-f", "mpegts"];
        break;
      case "m2ts":
        video = h264();
        audio = ["-c:a", "ac3", "-b:a", "192k"];
        container = ["-f", "mpegts", "-mpegts_m2ts_mode", "1"];
        break;
      case "flv":
        video = h264();
        audio = [...aac, "-ar", "44100"];
        container = ["-f", "flv"];
        break;
      case "3gp":
      case "3g2":
        video = h264("baseline");
        audio = ["-c:a", "aac", "-b:a", "96k", "-ar", "44100"];
        container = ["-f", id];
        break;
      case "ogv":
        video = ["-c:v", "libtheora", "-q:v", "7", ...filters(EVEN), ...cfr];
        audio = ["-c:a", "libvorbis", "-q:a", "5"];
        break;
      case "hevc":
        video = [
          "-c:v", "libx265", "-preset", wasm ? "ultrafast" : "medium", "-crf", "26", "-pix_fmt", "yuv420p",
          "-tag:v", "hvc1", "-x265-params", "log-level=error", ...filters(EVEN), ...cfr, "-movflags", "+faststart",
        ];
        audio = aac;
        break;
      case "av1":
        video = ["-c:v", "libaom-av1", "-crf", "32", "-b:v", "0", "-cpu-used", "6", "-row-mt", "1", ...filters(EVEN), ...cfr];
        audio = ["-c:a", "libopus", "-b:a", "128k"];
        break;
      case "prores":
        video = ["-c:v", "prores_ks", "-profile:v", "2", "-pix_fmt", "yuv422p10le", "-vendor", "apl0", ...filters(EVEN), ...cfr];
        audio = pcm();
        break;
      case "dnxhr":
        video = ["-c:v", "dnxhd", "-profile:v", "dnxhr_hq", "-pix_fmt", "yuv422p", ...filters(EVEN), ...cfr];
        audio = pcm();
        break;
      case "mxf":
        video = ["-c:v", "mpeg2video", "-pix_fmt", "yuv422p", "-b:v", "50M", "-maxrate", "50M", "-bufsize", "17M", "-g", "12", ...filters(EVEN), ...std];
        audio = pcm(48000);
        break;
      case "mjpeg":
        video = ["-c:v", "mjpeg", "-q:v", "3", "-pix_fmt", "yuvj420p", ...filters(EVEN), ...cfr];
        audio = pcm();
        break;
      case "ffv1":
        video = ["-c:v", "ffv1", "-level", "3", "-g", "1", "-slicecrc", "1", ...(retime ? filters() : []), ...cfr];
        audio = ["-c:a", "flac"];
        break;
      case "dv": {
        // DV is fixed at NTSC (720×480, 29.97 fps) or PAL (720×576, 25 fps); the picture is letterboxed to fit.
        const ntsc = (rate || 30) > 27.5;
        const [w, h] = ntsc ? [720, 480] : [720, 576];
        video = [
          "-c:v", "dvvideo", "-pix_fmt", ntsc ? "yuv411p" : "yuv420p",
          ...filters(`scale=${w}:${h}:force_original_aspect_ratio=decrease`, `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`, "setsar=1", "setpts=PTS-STARTPTS"),
          "-r", ntsc ? "30000/1001" : "25",
        ];
        // The DV muxer needs sound and picture to start together, in one frame's worth of
        // samples per packet (sources like WMV start their sound slightly offset).
        audio = [
          "-c:a", "pcm_s16le", "-ac", "2",
          "-af", `aresample=48000:async=1:first_pts=0,asetpts=N/SR/TB,asetnsamples=n=${ntsc ? 1602 : 1920}:p=1`,
        ];
        container = ["-f", "dv"];
        break;
      }
      case "webp":
        video = [
          "-c:v", "libwebp_anim", "-q:v", "75", "-loop", "0",
          ...filters("fps=15", "scale='min(800,iw)':-1:flags=lanczos"),
        ];
        break;
      case "apng":
        video = ["-c:v", "apng", "-plays", "0", ...filters("fps=15", "scale='min(640,iw)':-1:flags=lanczos")];
        container = ["-f", "apng"];
        break;
      default:
        throw new Error(`Unknown format: ${id}`);
    }
    const streams = f.audio ? ["-map", "0:v:0", "-map", "0:a:0?", ...audio] : ["-map", "0:v:0", "-an"];
    return [...streams, "-sn", "-dn", ...video, ...container];
  }

  // Everything a file picker should offer for "any video".
  const IMPORT_ACCEPT = [
    "video/*", ".mp4", ".m4v", ".mov", ".qt", ".mkv", ".webm", ".avi", ".mpg", ".mpeg", ".mpe", ".m1v", ".m2v",
    ".mpv", ".vob", ".ts", ".mts", ".m2ts", ".wmv", ".asf", ".flv", ".f4v", ".3gp", ".3g2", ".ogv", ".ogg",
    ".mxf", ".dv", ".y4m", ".rm", ".rmvb", ".divx", ".xvid", ".hevc", ".h264", ".264", ".h265", ".265", ".gif",
    ".apng", ".webp", ".nut", ".ivf", ".swf", ".amv", ".mjpeg", ".mjpg",
  ].join(",");

  function parseProbe(text) {
    const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
    const video = /Stream #[^\n]*Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})[^\n]*/.exec(text);
    const rate = video && (/(\d+(?:\.\d+)?) fps/.exec(video[0]) || /(\d+(?:\.\d+)?) tbr/.exec(video[0]));
    return {
      duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
      videoCodec: video ? video[1] : "",
      width: video ? Number(video[2]) : 0,
      height: video ? Number(video[3]) : 0,
      fps: rate ? Number(rate[1]) : 0,
      hasAudio: /Stream #[^\n]*Audio:/.test(text),
    };
  }

  function fileSuffix(id) {
    return BY_ID.get(id).suffix;
  }

  return { FORMATS, outputArgs, IMPORT_ACCEPT, parseProbe, fileSuffix, nearestStandardRate };
});
