/**
 * mobile-bridge.js
 * Android support (Capacitor). When the page runs inside the Android app this
 * defines window.mobile with the same saveFiles() shape as the desktop bridge
 * (electron/preload.js), writing into Documents/Hand Tracker on the phone, plus
 * share() to hand a saved file to another app (Photos, Drive, email…).
 * In a browser or the desktop app it does nothing.
 *
 *   await mobile.saveFiles({ baseName, files: [{ format, suffix, ext, data: string | Uint8Array }] })
 *     -> { dir, results: [{ format, ok, path (file URI), size, error? }] }
 *   await mobile.share(path)
 */

(function (global) {
  const cap = global.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;

  const Filesystem = cap.registerPlugin("Filesystem");
  const Share = cap.registerPlugin("Share");
  const DIRECTORY = "DOCUMENTS"; // public Documents folder; Android 11+ lets apps write files they create there
  const FOLDER = "Hand Tracker";
  const CHUNK_BYTES = 3 * 1024 * 1024; // binary data crosses the bridge as base64, a few MB at a time (mobile.chunkBytes)

  // Same rules as the desktop exporter: no path characters, no reserved names.
  function sanitize(name) {
    let base = String(name || "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/^[\s.]+|[\s.]+$/g, "")
      .slice(0, 120);
    if (!base) base = "hand-tracker";
    return base;
  }

  async function exists(path) {
    try {
      await Filesystem.stat({ path, directory: DIRECTORY });
      return true;
    } catch {
      return false;
    }
  }

  // Never overwrite: "clip.mp4" -> "clip (1).mp4" -> ...
  async function uniquePath(base, ext) {
    let candidate = `${FOLDER}/${base}.${ext}`;
    for (let n = 1; await exists(candidate); n++) candidate = `${FOLDER}/${base} (${n}).${ext}`;
    return candidate;
  }

  function toBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function writeFile(path, data) {
    if (typeof data === "string") {
      await Filesystem.writeFile({ path, directory: DIRECTORY, data, encoding: "utf8", recursive: true });
      return new Blob([data]).size;
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    // Chunked so a long video never has to become one giant base64 string.
    const chunk = api.chunkBytes;
    for (let i = 0; i === 0 || i < bytes.length; i += chunk) {
      const part = toBase64(bytes.subarray(i, i + chunk));
      if (i === 0) await Filesystem.writeFile({ path, directory: DIRECTORY, data: part, recursive: true });
      else await Filesystem.appendFile({ path, directory: DIRECTORY, data: part });
    }
    return bytes.length;
  }

  async function saveFiles({ baseName, files }) {
    const base = sanitize(baseName);
    const results = [];
    for (const file of files) {
      try {
        const path = await uniquePath(base + (file.suffix || ""), file.ext);
        const size = await writeFile(path, file.data);
        const { uri } = await Filesystem.getUri({ path, directory: DIRECTORY });
        results.push({ format: file.format, ok: true, path: uri, size });
      } catch (err) {
        results.push({ format: file.format, ok: false, error: (err && err.message) || String(err) });
      }
    }
    return { dir: `Documents/${FOLDER}`, results };
  }

  async function share(uri) {
    await Share.share({ files: [uri] });
  }

  const api = { platform: cap.getPlatform(), saveFiles, share, chunkBytes: CHUNK_BYTES };
  global.mobile = api;
})(window);
