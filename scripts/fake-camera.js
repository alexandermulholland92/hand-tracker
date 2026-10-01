/**
 * fake-camera.js — the test camera for check.js and check-android.js.
 *
 * Chromium's built-in fake camera (--use-fake-device-for-media-stream) crashes its capture
 * process now and then as it's opened (an access violation inside Chromium: about 1 start in
 * 3 on one Windows PC), and after that no camera can be opened, so every later camera check
 * fails. A fake camera that plays a file (--use-file-for-fake-video-capture) goes through
 * other code and didn't crash once in the same test. This makes that file once (with the
 * ffmpeg the app ships): a 1280x720 test pattern at 30 fps with a running clock drawn on it,
 * like the built-in camera's (the Android check reads it with OCR), looped by Chromium.
 *
 *   const file = fakeCameraFile(); // path, or null (no ffmpeg): then the built-in fake camera is used
 *   if (file) app.commandLine.appendSwitch("use-file-for-fake-video-capture", file);
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const FILE = path.join(os.tmpdir(), "hand-tracker-fake-camera-v1.mjpeg");
const FONTS = ["C:\\Windows\\Fonts\\arialbd.ttf", "C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial.ttf"];

function fakeCameraFile() {
  if (fs.existsSync(FILE) && fs.statSync(FILE).size > 0) return FILE;
  let ffmpeg = null;
  try {
    ffmpeg = require("ffmpeg-static");
  } catch {
    return null;
  }
  if (!ffmpeg || !fs.existsSync(ffmpeg)) return null;
  const font = FONTS.find((f) => fs.existsSync(f));
  // (In a filter, a font path's ":" and "\" need escaping.)
  const clock = font
    ? `,drawtext=fontfile='${font.replace(/\\/g, "/").replace(/:/g, "\\:")}':text='%{pts\\:hms}':fontsize=72:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=12:x=(w-tw)/2:y=h-th-60`
    : "";
  const tmp = `${FILE}.${process.pid}.part`;
  const r = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=30${clock}`,
    "-t", "10", "-c:v", "mjpeg", "-q:v", "5", "-f", "mjpeg", tmp], { encoding: "utf8" });
  if (r.status !== 0 || !fs.existsSync(tmp)) {
    fs.rmSync(tmp, { force: true });
    return null;
  }
  fs.renameSync(tmp, FILE);
  return FILE;
}

module.exports = { fakeCameraFile };
