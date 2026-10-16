/**
 * camera-tile.js — one camera of "Several cameras" (multi-camera.js), in its own page
 * (camera-tile.html, shown in a tile): its own hand tracker, so each camera has its own
 * left and right hand, its own smoothing and its own motion capture.
 *
 * Settings come from the page's address: ?device=<camera id>&label=<its name>&mirror=1|0&rot=0|90|180|270&model=0|1&name=<tile name>,
 * or ?oak=<OAK camera id> for a Luxonis OAK camera: its hands are found on the camera, and the
 * page showing the tile passes its frames in (oakHands, then oakPicture now and then; oakStatus),
 * or ?kinect=<Kinect id>&bodies=1|0&people=<1-6>&view=<color|depth|blend|side> for a Kinect: the page
 * showing the tile passes each of its pictures in (kinectFrame), with the depth for each part of
 * it; the hands are found here, each with where it is (from the depth), and the bodies too
 * (body-tracker.js; on Windows the Kinect's own, from its frames).
 * The tile page's API, for the page that shows it:
 *   await Tile.ready                          the camera is running
 *   Tile.hands()                              the hands on the last frame
 *   Tile.status()                             { fps, width, height, hands, recording, error, tracking }
 *   Tile.startRecording() / Tile.stopRecording() -> the recording (RobotMotion), with
 *     clock_origin_ms: when its first frame was, in ms since 1970 (to line cameras up)
 *   Tile.oakHands(w, h, results, t)           an OAK camera's frame's hands (results as HandTracker takes
 *                                             them, with its objects; its picture, w x h, isn't drawn) -> the
 *                                             hands; Tile.objects() its last objects
 *   await Tile.oakPicture(jpeg, hands)        then its picture, drawn with those hands
 *   Tile.oakStatus(status)                    its helper's status ("starting", "running", "error"…)
 *   await Tile.kinectFrame({ header, jpeg, depth, bodies, audio, t })   a Kinect's picture (jpeg) with its
 *                                             depth map (depth, kinect-view.js), its own bodies (Windows) and
 *                                             its microphones' latest (audio), taken at t (this page's
 *                                             clock): its hands found, drawn as its view says -> { hands, bodies }
 *   Tile.kinectStatus(status)                 its helper's status
 *   Tile.kinectOptions({ view, bodies, people, faces })   what it shows, and whether (and how many) bodies are tracked,
 *                                             and their faces
 *   Tile.bodies()                             the bodies on the last frame (body-tracker.js's)
 *   Tile.setView({ rotation, mirror })        turn the picture (and its tracking) clockwise by 0, 90, 180
 *                                             or 270 degrees, and show it mirrored or not (just the look:
 *                                             Left stays the person's left)
 *   Tile.setOptions({ display, overlay, square, far, gloves, readable, paused, tracking })
 *                                             the main window's More settings, any of them: what's drawn
 *                                             (the Show buttons, Overlay), Square crop, Far-away hands
 *                                             ({ enabled, focus, raisedOnly }), Black gloves, Readable text,
 *                                             Pause; and hand tracking (off while Sentry mode watches: the
 *                                             picture carries on, with no hands). An OAK camera finds its
 *                                             own hands, so Square crop, Black gloves and Readable text
 *                                             don't apply to it, and its far-away mode is the camera's
 *                                             (multi-camera.js starts it so); with tracking off, the hands
 *                                             it finds are let go.
 */

(function (global) {
  const params = new URLSearchParams(location.search);
  const video = document.getElementById("video"), stage = document.getElementById("stage"), message = document.getElementById("message");
  let latest = [], error = "";
  let objects = null; // an OAK camera's last objects found
  const oak = params.get("oak");
  const kinect = params.get("kinect");
  let lastBitmap = null;
  let pictures = 0; // pictures drawn (an OAK camera's hands can come without theirs; a webcam's, each frame)

  // What's drawn over the picture: the main window's tags, boxes and far-away search area,
  // as its Show buttons say (setOptions); until they arrive, which hand each is.
  const overlay = StageOverlay.create(stage, { phone: params.get("phone") === "1" });
  const gestures = HandGestures.create();
  const options = { display: { side: true, skeleton: true }, overlay: true, far: false, readable: false };
  let timing = null; // { samples, handle } while the timing check measures this webcam
  function startTiming() {
    stopTiming();
    if (oak || kinect || !video || typeof video.requestVideoFrameCallback !== "function" || !global.TimingCheck) return false;
    const [gw, gh] = TimingCheck.GRID;
    const small = Object.assign(document.createElement("canvas"), { width: gw * 4, height: gh * 4 });
    const sctx = small.getContext("2d", { willReadFrequently: true });
    const t = (timing = { samples: [], handle: 0 });
    const each = (now) => {
      if (timing !== t) return;
      sctx.drawImage(video, 0, 0, small.width, small.height);
      t.samples.push({ t: performance.timeOrigin + now, cells: TimingCheck.cells(sctx.getImageData(0, 0, small.width, small.height).data, small.width, small.height, 4) });
      t.handle = video.requestVideoFrameCallback(each);
    };
    t.handle = video.requestVideoFrameCallback(each);
    return true;
  }
  function stopTiming() {
    const t = timing;
    timing = null;
    if (t && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(t.handle);
    return t ? t.samples : [];
  }

  function drawTags(hands, objs = objects) {
    if (options.overlay) overlay.draw(hands, { display: options.display, far: options.far && !oak, gestureOf: (h) => gestures.of(h), objects: objs });
  }
  // An OAK camera's side-by-side picture (its colour half, then its depth): the hands and
  // objects found are the colour half's, so they're drawn there (wherever the turned picture has it).
  let oakSize = null; // its frames' size (the colour picture's)
  function onColourHalf(p) {
    const r = HandTracker.getRotation ? HandTracker.getRotation() : 0;
    if (r === 90) return { ...p, y: p.y / 2 };
    if (r === 180) return { ...p, x: 0.5 + p.x / 2 };
    if (r === 270) return { ...p, y: 0.5 + p.y / 2 };
    return { ...p, x: p.x / 2 };
  }
  function boxOnColourHalf(o) {
    if (!Array.isArray(o.box)) return o;
    const a = onColourHalf({ x: o.box[0], y: o.box[1] }), b = onColourHalf({ x: o.box[2], y: o.box[3] });
    return { ...o, box: [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)] };
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

  // ---------- a Kinect ----------
  // Its pictures come from the page showing this tile; the hands (and bodies) are found here.
  const kin = kinect
    ? { view: KinectView.create(), show: ["depth", "blend", "side"].includes(params.get("view")) ? params.get("view") : "color", bodies: params.get("bodies") !== "0",
      people: Math.max(1, Math.min(6, Number(params.get("people")) || 1)), faces: params.get("faces") === "1", tracker: null, found: [], recording: null, audio: null, mirrored: false }
    : null;
  // A point of the picture the hand tracker saw (turned) in the depth map's own (unturned) one.
  const at3dTurned = (u, v) => {
    const [x, y] = KinectView.unturn(u, v, HandTracker.getRotation ? HandTracker.getRotation() : 0);
    return kin.view.at3d(x, y);
  };
  // A hand's place: its palm's middle (the wrist and the knuckles), from the depth there.
  const handXyz = (raw) => {
    if (!raw || raw.length < 21) return null;
    const ids = [0, 5, 9, 13, 17];
    const u = ids.reduce((a, i) => a + raw[i].x, 0) / ids.length, v = ids.reduce((a, i) => a + raw[i].y, 0) / ids.length;
    const [x, y] = KinectView.unturn(u, v, HandTracker.getRotation ? HandTracker.getRotation() : 0);
    return kin.view.at3d(x, y);
  };
  function startBodies() {
    if (!kin || (!kin.bodies && !kin.faces) || kin.tracker || !global.BodyTracker || typeof Worker === "undefined") return;
    kin.tracker = BodyTracker.create({ people: kin.people });
  }
  // The Kinect's own bodies (Windows: its SDK's), as body-tracker.js's: joints in the colour
  // picture (u, v: 0-1, unturned) and where they are (mm).
  function ownBodies(list) {
    const r = HandTracker.getRotation ? HandTracker.getRotation() : 0;
    const turn = (u, v) => (r === 90 ? [1 - v, u] : r === 180 ? [1 - u, 1 - v] : r === 270 ? [v, 1 - u] : [u, v]);
    return list.map((b) => ({
      ...b,
      joints: (b.joints || []).map((j) => {
        if (j.u === null || j.u === undefined) return j;
        const [u, v] = turn(j.u, j.v);
        return { ...j, u, v };
      }),
    }));
  }
  async function kinectFrame({ header, jpeg, depth, bodies, audio, t }) {
    if (!kin || !jpeg) return { hands: latest, bodies: kin ? kin.found : [] };
    const bitmap = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
    kin.view.frame(header, depth);
    kin.audio = audio || null;
    const when = Number.isFinite(t) ? t : performance.now();
    await HandTracker.trackExternalImage(bitmap, when, (rawList) => rawList.map((raw) => ({ xyz: handXyz(raw) })));
    if (!error) message.hidden = true;
    // Bodies: the Kinect's own (Windows), or found here in the picture as tracked (turned), as
    // often as the body model keeps up (the hands don't wait for it).
    // Faces (when asked): each one's direction and expressions, on its body.
    const own = Array.isArray(bodies);
    if (own) {
      const before = kin.found;
      kin.found = ownBodies(bodies);
      if (kin.faces && kin.lastFaces) BodyTracker.attachFaces(kin.found, kin.lastFaces, before);
    }
    if (((kin.bodies && !own) || kin.faces) && HandTracker.isTracking()) {
      startBodies();
      if (kin.tracker) {
        const seen = latest.map((h) => ({ imageLandmarks: h.imageLandmarks, handedness: h.handedness, gesture: gestures.of(h).label }));
        kin.tracker.detect(HandTracker.getFrameImage(), when, { people: kin.people, faces: kin.faces ? kin.people : 0, poses: kin.bodies && !own }).then((got) => {
          if (!got) return;
          kin.lastFaces = kin.faces ? got.faces : null;
          if (kin.bodies && !own) kin.found = BodyTracker.fromPoses(got.poses, { at3d: at3dTurned, hands: seen, previous: kin.found, faces: kin.lastFaces });
        }).catch(() => {});
      }
    } else if (!own) kin.found = [];
    if (kin.recording && kin.found.length) kin.recording.push({ t: performance.timeOrigin + when, bodies: kin.found.map(compactBody) });
    // Its view: the picture (colour, or infrared at night), the depth, the two laid over each
    // other, or side by side (the hands and bodies drawn on the picture's half).
    const shown = kin.view.picture(bitmap, kin.show);
    const onPicture = shown.side ? (hands) => hands.map((h) => ({ ...h, imageLandmarks: h.imageLandmarks.map(onColourHalf) })) : (hands) => hands;
    const drawn = onPicture(latest);
    HandTracker.drawExternalPicture(shown.image, drawn.map((h) => h.imageLandmarks), shown.side);
    drawTags(drawn);
    const ctx = stage.getContext("2d");
    const unit = Math.max(1, stage.width / (shown.side ? 1280 : 640));
    if (kin.found.length) BodyTracker.draw(ctx, kin.found, (p) => HandTracker.toCanvasPoint(shown.side ? onColourHalf(p) : p), unit);
    KinectView.drawSound(ctx, kin.audio, stage.width, stage.height, unit, HandTracker.isMirrored());
    pictures++;
    if (lastBitmap) lastBitmap.close();
    lastBitmap = bitmap;
    return { hands: latest, bodies: kin.found };
  }
  // A body as a take keeps it: each joint [x, y, z, u, v, state] (state 2 tracked, 1 inferred, 0 none).
  const STATE = { tracked: 2, inferred: 1, none: 0 };
  const compactBody = (b) => ({
    id: b.id,
    joints: b.joints.map((j) => [j.x, j.y, j.z, j.u, j.v, STATE[j.state] || 0]),
    hands: [b.hands.left, b.hands.right],
    lean: b.lean,
    ...(b.face ? { face: { rotation: b.face.rotation, happy: b.face.happy, eyesClosed: b.face.eyesClosed, mouthOpen: b.face.mouthOpen, mouthMoved: b.face.mouthMoved,
      lookingAway: b.face.lookingAway, engaged: b.face.engaged, box: b.face.box, shapes: b.face.shapes } } : {}),
  });

  async function start() {
    if (kinect) {
      await HandTracker.init({ videoEl: video, canvasEl: stage, overlay: true, mirror: params.get("mirror") !== "0", maxNumHands: 2,
        modelComplexity: params.get("model") === "0" ? 0 : 1, external: "Kinect", trackExternal: true });
      HandTracker.setRotation(Number(params.get("rot")) || 0);
      message.textContent = "Starting the Kinect…";
      HandTracker.onHandLandmarks(({ hands, timestamp }) => {
        latest = hands;
        gestures.update(hands);
        if (RobotMotion.isRecording()) RobotMotion.feed(hands, timestamp);
      });
      startBodies();
      return;
    }
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
        pictures++;
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
      return { fps: error ? 0 : HandTracker.getFPS(), width: cam.width, height: cam.height, hands: latest.map((h) => h.handedness), recording: RobotMotion.isRecording(), error, pictures, tracking: HandTracker.isTracking(),
        ...(kin ? { bodies: kin.found.length, bodyError: kin.tracker ? kin.tracker.error() : "" } : {}) };
    },
    oakHands: (w, h, results, t) => {
      if (!oak) return null;
      objects = results && Array.isArray(results.objects) ? results.objects : null;
      oakSize = { w, h };
      HandTracker.pushExternalHands(w, h, results, t);
      if (!error) message.hidden = true;
      return latest;
    },
    oakPicture: async (jpeg, hands) => {
      if (!oak || !jpeg) return;
      const bitmap = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
      const side = !!oakSize && bitmap.width / bitmap.height > 1.8 * (oakSize.w / oakSize.h);
      const shown = side ? (hands || []).map((h) => ({ ...h, imageLandmarks: h.imageLandmarks.map(onColourHalf) })) : hands || [];
      HandTracker.drawExternalPicture(bitmap, shown.map((h) => h.imageLandmarks), side);
      drawTags(shown, side && objects ? objects.map(boxOnColourHalf) : objects);
      pictures++;
      if (lastBitmap) lastBitmap.close();
      lastBitmap = bitmap;
    },
    kinectFrame: (f) => kinectFrame(f),
    bodies: () => (kin ? kin.found : []),
    kinectOptions: (o = {}) => {
      if (!kin) return;
      if (["color", "depth", "blend", "side"].includes(o.view)) kin.show = o.view;
      if (Number.isInteger(o.people) && o.people >= 1 && o.people <= 6) kin.people = o.people;
      if (o.model === 0 || o.model === 1) HandTracker.setModelComplexity(o.model);
      if (o.hands === 1 || o.hands === 2) HandTracker.setMaxHands(o.hands);
      if (typeof o.faces === "boolean") kin.faces = o.faces;
      if (typeof o.bodies === "boolean") kin.bodies = o.bodies;
      if (!kin.bodies && !kin.faces) {
        if (kin.tracker) kin.tracker.close();
        kin.tracker = null;
        kin.found = [];
      }
      if (!kin.bodies) kin.found = [];
    },
    kinectStatus: (s) => {
      if (s.status === "error" || (s.status === "stopped" && s.code)) {
        error = s.message || `The Kinect stopped${s.detail ? `: ${s.detail}` : "."}`;
        message.hidden = false;
        message.textContent = error;
      } else if (s.status === "starting") {
        error = "";
        message.hidden = false;
        message.textContent = s.message || "Starting the Kinect…";
      } else if (s.status === "running") {
        error = "";
      }
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
      if (o.readable !== undefined) options.readable = !!o.readable && !oak && !kinect;
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
      if (o.tracking !== undefined) HandTracker.setTracking(!!o.tracking);
    },
    options: () => ({ ...options, display: { ...options.display }, square: !oak && HandTracker.isSquareCrop(), gloves: !oak && HandTracker.getGloves(), farMode: HandTracker.getFarMode(), paused: HandTracker.isPaused(), tracking: HandTracker.isTracking() }),
    // The timing check (timing-check.js): a webcam's pictures measured as they come, from
    // timing(true) until timing(false) -> [{ t (ms since 1970), cells }]. (An OAK camera's are
    // measured by the page showing the tile; timing(true) is then false.)
    timing: (on) => (on ? startTiming() : stopTiming()),
    setView: ({ rotation, mirror } = {}) => {
      if (rotation !== undefined) HandTracker.setRotation(rotation);
      if (mirror !== undefined) HandTracker.setMirror(!!mirror);
    },
    startRecording: () => {
      if (kin) kin.recording = [];
      return RobotMotion.start();
    },
    stopRecording: () => {
      const data = RobotMotion.stop();
      // A Kinect's bodies, each frame's time in ms since 1970 (multi-camera.js puts them on the take's clock).
      if (kin) {
        if (kin.recording && kin.recording.length) {
          data.bodyFrames = kin.recording;
          data.bodyJoints = BodyTracker.JOINTS;
          if (BodyTracker.shapes().length) data.faceShapes = BodyTracker.shapes();
        }
        kin.recording = null;
      }
      // RobotMotion's clock is this page's (performance.now); in ms since 1970 the cameras line up.
      data.clock_origin_ms = data.time_origin_s === null || data.time_origin_s === undefined ? null : performance.timeOrigin + data.time_origin_s * 1000;
      return data;
    },
  };
})(window);
