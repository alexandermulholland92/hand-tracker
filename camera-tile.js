/**
 * camera-tile.js — one camera of "Several cameras" (multi-camera.js), in its own page
 * (camera-tile.html, shown in a tile): its own hand tracker, so each camera has its own
 * left and right hand, its own smoothing and its own motion capture.
 *
 * Settings come from the page's address: ?device=<camera id>&label=<its name>&mirror=1|0&rot=0|90|180|270&model=0|1&name=<tile name>,
 * or ?oak=<OAK camera id> for a Luxonis OAK camera: its hands are found on the camera, and the
 * page showing the tile passes its frames in (oakHands, then oakPicture now and then; oakStatus).
 * The tile page's API, for the page that shows it:
 *   await Tile.ready                          the camera is running
 *   Tile.hands()                              the hands on the last frame
 *   Tile.status()                             { fps, width, height, hands, recording, error }
 *   Tile.startRecording() / Tile.stopRecording() -> the recording (RobotMotion), with
 *     clock_origin_ms: when its first frame was, in ms since 1970 (to line cameras up)
 *   Tile.oakHands(w, h, results, t)           an OAK camera's frame's hands (results as HandTracker takes
 *                                             them, with its objects; its picture, w x h, isn't drawn) -> the
 *                                             hands; Tile.objects() its last objects
 *   await Tile.oakPicture(jpeg, hands)        then its picture, drawn with those hands
 *   Tile.oakStatus(status)                    its helper's status ("starting", "running", "error"…)
 *   Tile.setView({ rotation, mirror })        turn the picture (and its tracking) clockwise by 0, 90, 180
 *                                             or 270 degrees, and show it mirrored or not (just the look:
 *                                             Left stays the person's left)
 *   Tile.setOptions({ display, overlay, square, far, gloves, readable, paused })
 *                                             the main window's More settings, any of them: what's drawn
 *                                             (the Show buttons, Overlay), Square crop, Far-away hands
 *                                             ({ enabled, focus, raisedOnly }), Black gloves, Readable text,
 *                                             Pause. An OAK camera finds its own hands, so Square crop,
 *                                             Black gloves and Readable text don't apply to it, and its
 *                                             far-away mode is the camera's (multi-camera.js starts it so).
 */

(function (global) {
  const params = new URLSearchParams(location.search);
  const video = document.getElementById("video"), stage = document.getElementById("stage"), message = document.getElementById("message");
  let latest = [], error = "";
  let objects = null; // an OAK camera's last objects found
  const oak = params.get("oak");
  let lastBitmap = null;
  let pictures = 0; // pictures drawn (an OAK camera's hands can come without theirs)

  // What's drawn over the picture: the main window's tags, boxes and far-away search area,
  // as its Show buttons say (setOptions); until they arrive, which hand each is.
  const overlay = StageOverlay.create(stage, { phone: params.get("phone") === "1" });
  const gestures = HandGestures.create();
  const options = { display: { side: true, skeleton: true }, overlay: true, far: false, readable: false };
  function drawTags(hands) {
    if (options.overlay) overlay.draw(hands, { display: options.display, far: options.far && !oak, gestureOf: (h) => gestures.of(h), objects });
  }

  // The tile's camera. Its id from the page showing the tile works on a computer, but Android's
  // WebView gives each page its own camera ids, so there it's found by its name ("camera 0,
  // facing back"), which is the same everywhere. Names only show once this page may use a
  // camera: it opens one which way the camera faces for a moment first.
  async function cameraId() {
    const id = params.get("device"), label = params.get("label");
    let list = await navigator.mediaDevices.enumerateDevices();
    if (!label || list.some((d) => d.deviceId === id)) return id;
    const byLabel = () => list.find((d) => d.kind === "videoinput" && d.label === label);
    if (!byLabel()) {
      const facing = /back|rear|environment/i.test(label) ? "environment" : /front|user/i.test(label) ? "user" : null;
      const probe = await navigator.mediaDevices.getUserMedia({ video: facing ? { facingMode: { exact: facing } } : true, audio: false });
      probe.getTracks().forEach((t) => t.stop());
      list = await navigator.mediaDevices.enumerateDevices();
    }
    const found = byLabel();
    if (!found) throw Object.assign(new Error(`${label} wasn't found.`), { name: "NotFoundError" });
    return found.deviceId;
  }

  async function start() {
    if (oak) {
      // The camera's helper finds the hands; this page draws and records them.
      await HandTracker.init({ videoEl: video, canvasEl: stage, overlay: true, mirror: params.get("mirror") !== "0", maxNumHands: 2, external: "OAK camera" });
      HandTracker.setRotation(Number(params.get("rot")) || 0);
      message.textContent = "Starting the OAK camera…";
      HandTracker.onHandLandmarks(({ hands, timestamp, noPicture }) => {
        latest = hands;
        gestures.update(hands);
        if (!noPicture) drawTags(hands);
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
        deviceId: (await cameraId()) || null,
        exactCamera: true, // another camera instead would be a copy of one already in a tile
        width: 1280,
        height: 720,
      });
      HandTracker.setRotation(Number(params.get("rot")) || 0);
      message.hidden = true;
      HandTracker.onHandLandmarks(({ hands, timestamp }) => {
        latest = hands;
        gestures.update(hands);
        // Readable text (only when it's on: one text reader per camera would be a lot for a
        // small computer): text in a mirrored picture shown the right way round.
        if (options.readable && !HandTracker.getCamera().crop) ReadableText.process(HandTracker.getFrameImage(), stage, HandTracker.isMirrored(), hands, false);
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
    objects: () => objects,
    status: () => {
      const cam = error ? { width: 0, height: 0 } : HandTracker.getCamera();
      return { fps: error ? 0 : HandTracker.getFPS(), width: cam.width, height: cam.height, hands: latest.map((h) => h.handedness), recording: RobotMotion.isRecording(), error, pictures };
    },
    oakHands: (w, h, results, t) => {
      if (!oak) return null;
      objects = results && Array.isArray(results.objects) ? results.objects : null;
      HandTracker.pushExternalHands(w, h, results, t);
      if (!error) message.hidden = true;
      return latest;
    },
    oakPicture: async (jpeg, hands) => {
      if (!oak || !jpeg) return;
      const bitmap = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
      HandTracker.drawExternalPicture(bitmap, (hands || []).map((h) => h.imageLandmarks));
      drawTags(hands || []);
      pictures++;
      if (lastBitmap) lastBitmap.close();
      lastBitmap = bitmap;
    },
    oakStatus: (s) => {
      if (s.status === "error" || (s.status === "stopped" && s.code)) {
        error = s.message || `The OAK camera stopped${s.detail ? `: ${s.detail}` : "."}`;
        message.hidden = false;
        message.textContent = error;
      } else if (s.status === "starting") {
        // Started (again): the last error is gone until the camera says otherwise.
        error = "";
        message.hidden = false;
        message.textContent = s.message || "Starting the OAK camera…";
      } else if (s.status === "running") {
        error = "";
      }
    },
    setOptions: (o = {}) => {
      if (o.display) options.display = { ...o.display };
      if (o.overlay !== undefined) options.overlay = !!o.overlay;
      if (o.readable !== undefined) options.readable = !!o.readable && !oak;
      HandTracker.setOverlay(options.overlay && options.display.skeleton !== false);
      if (!oak) {
        if (o.square !== undefined) HandTracker.setSquareCrop(!!o.square);
        if (o.gloves !== undefined) HandTracker.setGloves(!!o.gloves);
        if (o.far) {
          options.far = !!o.far.enabled;
          HandTracker.setFarMode({ enabled: !!o.far.enabled, focus: o.far.focus || "both", raisedOnly: o.far.raisedOnly !== false });
        }
      }
      if (o.paused !== undefined && !!o.paused !== HandTracker.isPaused()) HandTracker.setPaused(!!o.paused);
    },
    options: () => ({ ...options, display: { ...options.display }, square: !oak && HandTracker.isSquareCrop(), gloves: !oak && HandTracker.getGloves(), farMode: HandTracker.getFarMode(), paused: HandTracker.isPaused() }),
    setView: ({ rotation, mirror } = {}) => {
      if (rotation !== undefined) HandTracker.setRotation(rotation);
      if (mirror !== undefined) HandTracker.setMirror(!!mirror);
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
