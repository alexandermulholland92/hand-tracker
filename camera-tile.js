/**
 * camera-tile.js — one camera of "Several cameras" (multi-camera.js), in its own page
 * (camera-tile.html, shown in a tile): its own hand tracker, so each camera has its own
 * left and right hand, its own smoothing and its own motion capture.
 *
 * Settings come from the page's address: ?device=<camera id>&mirror=1|0&model=0|1&name=<tile name>,
 * or ?oak=<OAK camera id> for a Luxonis OAK camera: its hands are found on the camera, and the
 * page showing the tile passes its frames in (oakFrame, oakStatus).
 * The tile page's API, for the page that shows it:
 *   await Tile.ready                          the camera is running
 *   Tile.hands()                              the hands on the last frame
 *   Tile.status()                             { fps, width, height, hands, recording, error }
 *   Tile.startRecording() / Tile.stopRecording() -> the recording (RobotMotion), with
 *     clock_origin_ms: when its first frame was, in ms since 1970 (to line cameras up)
 *   await Tile.oakFrame(jpeg, results, t)     an OAK camera's frame (results as HandTracker takes them)
 *   Tile.oakStatus(status)                    its helper's status ("starting", "running", "error"…)
 */

(function (global) {
  const params = new URLSearchParams(location.search);
  const SIDE_COLORS = { Left: "#4dabf7", Right: "#ff922b" };
  const video = document.getElementById("video"), stage = document.getElementById("stage"), message = document.getElementById("message");
  let latest = [], error = "";
  const oak = params.get("oak");
  let lastBitmap = null;

  // A small tag at each wrist: which hand (the main window's labels, without gestures).
  function drawTags(hands) {
    const ctx = stage.getContext("2d");
    const unit = Math.max(1, stage.width / 640);
    ctx.save();
    ctx.textBaseline = "middle";
    ctx.font = `600 ${Math.round(15 * unit)}px "Segoe UI", system-ui, sans-serif`;
    for (const hand of hands) {
      const wrist = HandTracker.toCanvasPoint(hand.imageLandmarks[0]);
      const text = hand.handedness;
      const color = SIDE_COLORS[hand.handedness] || "#adb5bd";
      const h = 26 * unit, w = ctx.measureText(text).width + 20 * unit;
      const x = Math.min(Math.max(wrist.x - w / 2, 4), stage.width - w - 4), y = Math.min(Math.max(wrist.y + 14 * unit, 4), stage.height - h - 4);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, h / 2);
      else ctx.rect(x, y, w, h);
      ctx.fillStyle = "rgba(14, 15, 18, 0.8)";
      ctx.fill();
      ctx.lineWidth = 2 * unit;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillText(text, x + 10 * unit, y + h / 2);
    }
    ctx.restore();
  }

  async function start() {
    if (oak) {
      // The camera's helper finds the hands; this page draws and records them.
      await HandTracker.init({ videoEl: video, canvasEl: stage, overlay: true, mirror: params.get("mirror") !== "0", maxNumHands: 2, external: "OAK camera" });
      message.textContent = "Starting the OAK camera…";
      HandTracker.onHandLandmarks(({ hands, timestamp }) => {
        latest = hands;
        drawTags(hands);
        if (RobotMotion.isRecording()) RobotMotion.feed(hands, timestamp);
      });
      return;
    }
    try {
      await HandTracker.init({
        videoEl: video,
        canvasEl: stage,
        overlay: true,
        mirror: params.get("mirror") !== "0",
        maxNumHands: 2,
        modelComplexity: params.get("model") === "0" ? 0 : 1,
        deviceId: params.get("device") || null,
        width: 1280,
        height: 720,
      });
      message.hidden = true;
      HandTracker.onHandLandmarks(({ hands, timestamp }) => {
        latest = hands;
        drawTags(hands);
        if (RobotMotion.isRecording()) RobotMotion.feed(hands, timestamp);
      });
    } catch (err) {
      error = String((err && err.message) || err);
      message.textContent = `This camera couldn't start: ${error}`;
      throw err;
    }
  }

  const ready = start();
  ready.catch(() => {});

  global.Tile = {
    ready,
    name: params.get("name") || "Camera",
    hands: () => latest,
    status: () => {
      const cam = error ? { width: 0, height: 0 } : HandTracker.getCamera();
      return { fps: error ? 0 : HandTracker.getFPS(), width: cam.width, height: cam.height, hands: latest.map((h) => h.handedness), recording: RobotMotion.isRecording(), error };
    },
    oakFrame: async (jpeg, results, t) => {
      if (!oak || !jpeg) return;
      const bitmap = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
      HandTracker.pushExternalFrame(bitmap, results, t);
      if (lastBitmap) lastBitmap.close();
      lastBitmap = bitmap;
      if (!error) message.hidden = true;
    },
    oakStatus: (s) => {
      if (s.status === "error" || (s.status === "stopped" && s.code)) {
        error = s.message || `The OAK camera stopped${s.detail ? `: ${s.detail}` : "."}`;
        message.hidden = false;
        message.textContent = error;
      } else if (s.status === "starting" && s.message) {
        message.textContent = s.message;
      }
    },
    startRecording: () => RobotMotion.start(),
    stopRecording: () => {
      const data = RobotMotion.stop();
      // RobotMotion's clock is this page's (performance.now); in ms since 1970 the cameras line up.
      data.clock_origin_ms = data.time_origin_s === null || data.time_origin_s === undefined ? null : performance.timeOrigin + data.time_origin_s * 1000;
      return data;
    },
  };
})(window);
