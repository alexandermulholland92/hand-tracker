/**
 * fleet-sim.js — a stand-in capture-fleet dashboard on this computer, for the Live Rigs
 * checks (check.js, check-android.js): its sign-in page sets a cookie, and its rig list and
 * pictures need that cookie. Rig A (recording) sends changing side-by-side stereo JPEGs
 * (left half red, right half blue) and has no keyframes; rig D only has H.264 keyframes;
 * rig E's camera is stale (like one that stopped sending); rig F is recording with its
 * preview flag off; B has no preview and C is offline.
 *
 *   const sim = await startFleetSim({ ffmpegPath, outDir });   // outDir: where its pictures are made
 *   sim.site; sim.writes (anything but a read); sim.served(); sim.stop();
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

function startFleetSim({ ffmpegPath, outDir }) {
  const ffmpeg = (args, file) => {
    spawnSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args, file]);
    return fs.readFileSync(file);
  };
  const jpegs = [0, 1].map((i) => ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=640x400", "-f", "lavfi", "-i", "color=c=blue:s=640x400",
    "-filter_complex", `[0][1]hstack,drawbox=x=${100 + i * 200}:y=150:w=80:h=80:color=white:t=fill`, "-frames:v", "1"], path.join(outDir, `fleet-frame-${i}.jpg`)));
  const monos = [0, 1].map((i) => ffmpeg(["-f", "lavfi", "-i", "color=c=gray:s=640x360", "-vf", `drawbox=x=${100 + i * 200}:y=100:w=80:h=80:color=white:t=fill`, "-frames:v", "1"], path.join(outDir, `fleet-mono-${i}.jpg`)));
  // Annex B H.264 keyframes, as the rigs send them; the codec string comes from the SPS.
  const keyframes = [0, 1].map((i) => ffmpeg(["-f", "lavfi", "-i", "color=c=green:s=640x360", "-vf", `drawbox=x=${100 + i * 200}:y=100:w=80:h=80:color=white:t=fill`,
    "-frames:v", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-bsf:v", "h264_mp4toannexb", "-f", "h264"], path.join(outDir, `fleet-key-${i}.h264`)));
  const k = keyframes[0];
  let sps = -1;
  for (let i = 0; i + 4 < k.length && sps < 0; i++) if (k[i] === 0 && k[i + 1] === 0 && k[i + 2] === 1 && (k[i + 3] & 0x1f) === 7) sps = i + 4;
  const codec = "avc1." + [k[sps], k[sps + 1], k[sps + 2]].map((b) => b.toString(16).padStart(2, "0")).join("");
  const rig = (hostname, display_name, generation, capture_state, extra) => ({ hostname, display_name, generation, capture_state, online: true, reachable: true, via_relay: false, preview_active: false, preview_cameras: ["head"], ...extra });
  const rigs = [
    rig("rig-a", "Rig A", "rock5c", "recording", { recording_duration_s: 42, session_name: "s1",
      // (its health, as the dashboard sees it: under-voltage and throttling since it started)
      cpu_temp: 61.4, disk_free_gb: 120.4, disk_total_gb: 476, storage_runway_label: "2.5 h", camera_count: 2, recording_health_pct: 98.6,
      upload_queue: 3, upload_rate_label: "3.7 MB/s", throttle_int: 0x50000, today_recording_s: 4000 }),
    rig("rig-b", "Rig B", "rpi5", "idle", { preview_cameras: ["chest"] }),
    rig("rig-c", "Rig C", "rpi5", "unknown", { online: false, reachable: false, preview_cameras: [], last_seen: Math.floor(Date.now() / 1000) - 3 * 86400 }),
    rig("rig-d", "Rig D", "rpi5", "preview", { preview_active: true }),
    rig("rig-e", "Rig E", "rpi5", "preview", { preview_active: true }),
    rig("rig-f", "Rig F", "rpi5", "recording", { recording_duration_s: 5, session_name: "s2", preview_cameras: ["head", "chest"] }),
  ];
  let served = 0;
  const count = {};
  const writes = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const signedIn = /(^|;\s*)fleet=ok/.test(req.headers.cookie || "");
    if (req.method !== "GET") writes.push(`${req.method} ${url.pathname}`); // it only ever reads
    if (url.pathname === "/login") {
      // Signs in by itself: the page sets the cookie (as a browser would after signing in), and
      // so does the answer (for the Android check's stand-in WebView, which runs no pages).
      res.writeHead(200, { "content-type": "text/html", "set-cookie": "fleet=ok; Path=/" });
      return res.end('<!doctype html><title>Sign in</title><p>Signing in…</p><script>document.cookie = "fleet=ok; path=/";</script>');
    }
    if (!signedIn) {
      res.writeHead(302, { location: "/login" });
      return res.end();
    }
    if (url.pathname === "/api/fleet/status") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ devices: rigs, summary: {} }));
    }
    // A rig's sessions: rig-a's history (uploaded) and one still on it (and one both, by its start).
    const ses = /^\/proxy\/(rig-a)\/api\/(sessions\/history|sessions)$/.exec(url.pathname);
    if (ses && url.searchParams.get("days") === "7") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(ses[2] === "sessions" ? [
        { session_id: "20261015_090000", duration_s: 120, total_bytes: 8e8, start_time_unix: 1760544000 },
        { session_id: "f762f21a", duration_s: 300, total_bytes: 2.1e9, start_time_unix: 1760461000.5 },
      ] : [{ session: "20261014_101500", start_unix: 1760461000, duration_s: 300, bytes: 2.1e9, location: "lab", camera_count: 3 }]));
    }
    const m = /^\/proxy\/([^/]+)\/api\/preview\/(frame|keyframe)\/([^/]+)$/.exec(url.pathname);
    if (m) {
      served++;
      const key = `${m[1]} ${m[2]}`;
      const n = (count[key] = (count[key] || 0) + 1);
      const fresh = { "x-frame-age-ms": "300", "x-frame-unix-ns": `17906${String(Math.floor(n / 2)).padStart(14, "0")}` }; // a new picture every second request
      const send = (status, type, body, headers = {}) => {
        res.writeHead(status, { "content-type": type, ...headers });
        res.end(body);
      };
      if (m[1] === "rig-a" && m[2] === "frame") return send(200, "image/jpeg", jpegs[Math.floor(n / 2) % 2], fresh);
      if (m[1] === "rig-d" && m[2] === "keyframe") return send(200, "video/h264", keyframes[Math.floor(n / 2) % 2], { ...fresh, "x-codec-string": codec });
      if (m[1] === "rig-e" && m[2] === "keyframe") return send(200, "video/h264", keyframes[0], { "x-codec-string": codec, "x-frame-stale": "1", "x-frame-age-ms": String(13 * 86400e3) });
      if (m[1] === "rig-f" && m[2] === "frame") return send(200, "image/jpeg", monos[Math.floor(n / 2) % 2], fresh);
      return send(503, "image/jpeg", "", { "x-frame-stale": "1" });
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ site: `http://127.0.0.1:${server.address().port}`, writes, served: () => served, stop: () => server.close() })));
}

module.exports = { startFleetSim };
