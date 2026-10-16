/**
 * body-finder-worker.js — body-tracker.js's worker: MediaPipe's pose landmarker (its lite model,
 * up to six people) and, when asked, its face landmarker (each face's direction and expressions),
 * in a worker of their own. On the page they can't load beside the hand tracker's MediaPipe
 * (each brings a WebAssembly runtime that expects to be the only one), and here they're off the
 * page's thread too.
 *
 * Messages in: { id, load: true, people } (just get ready) or { id, bitmap, t, people, poses,
 * faces } (an ImageBitmap, given over; t: its time in ms, rising; poses: false to skip the bodies;
 * faces: how many faces to look for, 0 for none). Out: { id, ok, poses: [{ landmarks: [[x, y, z,
 * visibility] × 33] (0-1 of the picture), world: [[x, y, z] × 33] (metres, about the hips) }],
 * faces: [{ box: [x0, y0, x1, y1], points: { leftEye, rightEye, nose, mouthLeft, mouthRight }
 * ([x, y], 0-1; left and right the person's), rotation: [yaw, pitch, roll] (degrees, 0 facing the
 * camera), shapes: [52 scores, 0-1] }], shapeNames: the scores' names (MediaPipe's blendshapes) } or
 * { id, ok: false, error }.
 */

/* global Vision */
// MediaPipe's runtime writes its "INFO: …" lines (like the XNNPACK one) as errors; they're news.
const logError = console.error.bind(console);
console.error = (...args) => (typeof args[0] === "string" && args[0].startsWith("INFO:") ? console.info(...args) : logError(...args));
importScripts("node_modules/@mediapipe/tasks-vision/vision_bundle.js");

let files = null;
let landmarker = null, loading = null, people = 1;
let faceFinder = null, faceLoading = null, facesWanted = 0;
let lastT = -1;
const here = (p) => new URL(p, self.location.href).href;
const fileset = async () => (files = files || (await Vision.FilesetResolver.forVisionTasks(here("node_modules/@mediapipe/tasks-vision/wasm"))));

function load(n) {
  if (landmarker) return Promise.resolve(landmarker);
  if (!loading) {
    loading = (async () => {
      people = n;
      landmarker = await Vision.PoseLandmarker.createFromOptions(await fileset(), {
        baseOptions: { modelAssetPath: here("models/pose_landmarker_lite.task"), delegate: "CPU" },
        runningMode: "VIDEO",
        numPoses: n,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      return landmarker;
    })().catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

function loadFaces(n) {
  if (faceFinder) return Promise.resolve(faceFinder);
  if (!faceLoading) {
    faceLoading = (async () => {
      facesWanted = n;
      faceFinder = await Vision.FaceLandmarker.createFromOptions(await fileset(), {
        baseOptions: { modelAssetPath: here("models/face_landmarker.task"), delegate: "CPU" },
        runningMode: "VIDEO",
        numFaces: n,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
      return faceFinder;
    })().catch((err) => {
      faceLoading = null;
      throw err;
    });
  }
  return faceLoading;
}

const round = (v, k = 1e4) => Math.round(v * k) / k;
const deg = (r) => Math.round((r * 180) / Math.PI * 10) / 10;

// A face's box, five points, direction and expressions (the face mesh's 478 points: 1 the nose
// tip, 61 and 291 the mouth's corners, 468 and 473 the eyes' irises; the person's right eye is
// on the picture's left in an unmirrored picture).
function face(lm, matrix, shapes) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of lm) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const pt = (i) => (lm[i] ? [round(lm[i].x), round(lm[i].y)] : null);
  let rotation = [0, 0, 0];
  if (matrix && matrix.data && matrix.data.length >= 16) {
    const m = matrix.data; // column-major 4 x 4: R[r][c] = m[c * 4 + r]
    const R = (r, c) => m[c * 4 + r];
    rotation = [deg(Math.atan2(R(0, 2), R(2, 2))), deg(Math.asin(Math.max(-1, Math.min(1, -R(1, 2))))), deg(Math.atan2(R(1, 0), R(1, 1)))];
  }
  return {
    box: [round(x0), round(y0), round(x1), round(y1)],
    points: { rightEye: pt(468), leftEye: pt(473), nose: pt(1), mouthRight: pt(61), mouthLeft: pt(291) },
    rotation,
    shapes: (shapes && shapes.categories ? shapes.categories : []).map((c) => round(c.score, 1000)),
  };
}

self.onmessage = async (e) => {
  const { id, bitmap, t } = e.data || {};
  const n = Math.max(1, Math.min(6, Number(e.data && e.data.people) || 1));
  const nFaces = Math.max(0, Math.min(6, Number(e.data && e.data.faces) || 0));
  const wantPoses = !(e.data && e.data.poses === false);
  try {
    const p = wantPoses ? await load(n) : null;
    if (p && n !== people) {
      await p.setOptions({ numPoses: n });
      people = n;
    }
    const f = nFaces ? await loadFaces(nFaces) : null;
    if (f && nFaces !== facesWanted) {
      await f.setOptions({ numFaces: nFaces });
      facesWanted = nFaces;
    }
    if (!bitmap) return self.postMessage({ id, ok: true, poses: [], faces: [] });
    // (Their video mode wants each picture later than the one before.)
    const at = Math.max(lastT + 1, Math.round(Number(t) || 0));
    lastT = at;
    let poses = [], faces = [], shapeNames = null;
    if (p) {
      const res = p.detectForVideo(bitmap, at);
      poses = (res.landmarks || []).map((lm, i) => ({
        landmarks: lm.map((q) => [round(q.x), round(q.y), round(q.z), round(q.visibility === undefined ? 1 : q.visibility, 100)]),
        world: ((res.worldLandmarks || [])[i] || []).map((q) => [round(q.x), round(q.y), round(q.z)]),
      }));
    }
    if (f) {
      const res = f.detectForVideo(bitmap, at);
      faces = (res.faceLandmarks || []).map((lm, i) => face(lm, (res.facialTransformationMatrixes || [])[i], (res.faceBlendshapes || [])[i]));
      const first = (res.faceBlendshapes || [])[0];
      if (first && first.categories) shapeNames = first.categories.map((c) => c.categoryName);
    }
    bitmap.close();
    self.postMessage({ id, ok: true, poses, faces, shapeNames });
  } catch (err) {
    if (bitmap && bitmap.close) bitmap.close();
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
