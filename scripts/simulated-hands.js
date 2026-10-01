/**
 * simulated-hands.js — page scripts used by the automated checks. They stop real
 * camera results and drive synthetic hands through HandTracker's real processing
 * pipeline: PAGE_SIMULATION moves two hands (one opening, one closing into a fist)
 * for about two seconds; gesturePoses() holds one hand in each given pose;
 * rigSimulation() puts a moving hand in video files, as a capture rig's cameras saw it.
 */

// Open right hand in image space (y down), wrist-relative.
const TEMPLATE = `[[0,0],[-.04,-.03],[-.08,-.07],[-.11,-.10],[-.13,-.13],[-.035,-.12],[-.04,-.17],[-.043,-.20],[-.045,-.23],
    [0,-.125],[0,-.18],[0,-.215],[0,-.245],[.03,-.115],[.035,-.165],[.038,-.195],[.04,-.22],[.055,-.10],[.065,-.135],[.07,-.16],[.075,-.18]]`;

const PAGE_SIMULATION = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Stop real camera results so only the simulated hands reach the app.
  if (!window.__realSend) window.__realSend = Hands.prototype.send; // restored by the checks afterwards
  Hands.prototype.send = async function () {};
  await sleep(200);

  const T = ${TEMPLATE};
  const TIPS = new Set([4, 8, 12, 16, 20]), DIPS = new Set([3, 7, 11, 15, 19]);
  function hand(cx, cy, flip, curl) {
    return T.map(([x, y], i) => {
      // Curl: pull the outer joints back toward the palm.
      const k = TIPS.has(i) ? curl * 1.25 : DIPS.has(i) ? curl * 0.7 : 0;
      const px = x * (1 - k * 0.3), py = y + Math.abs(y) * k * 0.85;
      return { x: cx + (flip ? -px : px), y: cy + py, z: -0.02 * k };
    });
  }

  const frames = 60;
  window.__seenBothCards = false;
  for (let f = 0; f < frames; f++) {
    const t = f / frames;
    const results = {
      image: document.getElementById("video"),
      // Raw MediaPipe labels assume a mirrored image; HandTracker swaps them.
      multiHandLandmarks: [hand(0.32 + 0.1 * t, 0.7, false, 0), hand(0.68, 0.72 - 0.1 * t, true, Math.min(1, t * 1.6))],
      multiHandedness: [{ label: "Left", score: 0.97 }, { label: "Right", score: 0.95 }],
    };
    // Real-world landmarks as MediaPipe gives them: metres, around the hand's centre.
    results.multiHandWorldLandmarks = results.multiHandLandmarks.map((lm) => {
      const c = lm.reduce((a, p) => ({ x: a.x + p.x / 21, y: a.y + p.y / 21, z: a.z + p.z / 21 }), { x: 0, y: 0, z: 0 });
      return lm.map((p) => ({ x: (p.x - c.x) * 0.75, y: (p.y - c.y) * 0.75, z: (p.z - c.z) * 0.75 }));
    });
    HandTracker._processResults(results);
    if (document.querySelector("#slotLeft .hand-card.left:not(.missing)") && document.querySelector("#slotRight .hand-card.right:not(.missing)")) {
      window.__seenBothCards = true;
    }
    await sleep(33);
  }
  return true;
})()`;

// poses: { name: { curls: { thumb, index, middle, ring, pinky } (0 straight .. 1 curled),
//   squeezeX (1; smaller turns the hand side-on), flipY (point the fingers down),
//   rotate (degrees clockwise on screen, as when a phone is held on its side),
//   thumbAcross (the thumb folded across the palm, as in counting four) } }.
// Each is held for half a second; resolves { name: gesture badge on the hand card }.
function gesturePoses(poses) {
  return `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!window.__realSend) window.__realSend = Hands.prototype.send;
  Hands.prototype.send = async function () {};
  const T = ${TEMPLATE};
  const FINGER = ["thumb", "index", "middle", "ring", "pinky"];
  const cam = HandTracker.getCamera();
  const aspect = cam.width && cam.height ? cam.width / cam.height : 1;
  const ACROSS = { 2: [-0.05, -0.06], 3: [-0.035, -0.085], 4: [-0.01, -0.1] }; // thumb joints folded across the palm
  const pose = ({ curls, squeezeX = 1, flipY = false, rotate = 0, thumbAcross = false }) => T.map(([x0, y0], i) => {
    const [x, y] = thumbAcross && ACROSS[i] ? ACROSS[i] : [x0, y0];
    const curl = i ? curls[FINGER[Math.floor((i - 1) / 4)]] : 0;
    const k = thumbAcross && i <= 4 ? 0 : i && i % 4 === 0 ? curl * 1.25 : i % 4 === 3 ? curl * 0.7 : 0; // tip, then DIP
    let px = x * (1 - k * 0.3) * squeezeX, py = y + Math.abs(y) * k * 0.85;
    if (rotate) {
      // Turn the hand in real proportions (x is a fraction of the picture's width).
      const a = (rotate * Math.PI) / 180, rx = px * aspect;
      [px, py] = [(rx * Math.cos(a) - py * Math.sin(a)) / aspect, rx * Math.sin(a) + py * Math.cos(a)];
    }
    return { x: (rotate ? 0.4 : 0.5) + px, y: flipY ? 0.3 - py : rotate ? 0.5 + py : 0.65 + py, z: -0.02 * k };
  });
  const out = {};
  for (const [name, p] of Object.entries(${JSON.stringify(poses)})) {
    for (let f = 0; f < 15; f++) {
      // Raw MediaPipe label "Left" is the user's right hand once HandTracker swaps it.
      HandTracker._processResults({ image: document.getElementById("video"), multiHandLandmarks: [pose(p)], multiHandedness: [{ label: "Left", score: 0.97 }] });
      await sleep(33);
    }
    const badge = document.querySelector("#slotRight .gesture-badge");
    out[name] = badge ? badge.textContent : "(no hand card)";
  }
  HandTracker._processResults({ image: document.getElementById("video"), multiHandLandmarks: [], multiHandedness: [] });
  return out;
})()`;
}

// Several videos of one moment, as a capture rig's cameras would film it. videos:
// { fileName: { seed, start, view } }: frame t of the video shows the moment start + t of
// the movement numbered seed (the same seed: the same moment); view 1 is another camera,
// further away and off to one side. Each frame of an open video file gets that hand, with
// a little tracking jitter, instead of MediaPipe's (until window.__realSend is restored).
function rigSimulation(videos) {
  return `(() => {
  if (!window.__realSend) window.__realSend = Hands.prototype.send;
  const T = ${TEMPLATE};
  const TIPS = new Set([4, 8, 12, 16, 20]), DIPS = new Set([3, 7, 11, 15, 19]);
  const videos = ${JSON.stringify(videos)};
  const paths = {};
  // The hand moves somewhere new (or stays put) every 0.3-1.5 s, opening or closing.
  function movement(seed) {
    let s = seed >>> 0;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    const keys = [];
    let key = { t: -2, x: 0.5, y: 0.6, curl: 0 };
    for (let t = -2; t < 120; t += 0.3 + 1.2 * rnd()) {
      key = rnd() < 0.25 ? { ...key, t } : { t, x: 0.3 + 0.4 * rnd(), y: 0.45 + 0.3 * rnd(), curl: rnd() < 0.5 ? 0 : rnd() };
      keys.push(key);
    }
    return (time) => {
      let k = 0;
      while (k < keys.length - 2 && keys[k + 1].t <= time) k++;
      const a = keys[k], b = keys[k + 1];
      const u = Math.min(1, Math.max(0, (time - a.t) / (b.t - a.t))), e = u * u * (3 - 2 * u);
      return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, curl: a.curl + (b.curl - a.curl) * e };
    };
  }
  function hand({ x: cx, y: cy, curl }, view) {
    return T.map(([x, y], i) => {
      const k = TIPS.has(i) ? curl * 1.25 : DIPS.has(i) ? curl * 0.7 : 0;
      let px = cx + x * (1 - k * 0.3), py = cy + y + Math.abs(y) * k * 0.85;
      if (view === 1) [px, py] = [0.2 + px * 0.7, 0.2 + py * 0.7];
      return { x: px + (Math.random() - 0.5) * 0.004, y: py + (Math.random() - 0.5) * 0.004, z: -0.02 * k };
    });
  }
  Hands.prototype.send = async function () {
    const spec = videos[HandTracker.file.name()];
    if (!spec || HandTracker.getSource() !== "file") return;
    if (!paths[spec.seed]) paths[spec.seed] = movement(spec.seed);
    const v = document.getElementById("video");
    // Raw MediaPipe label "Left" is the person's right hand.
    HandTracker._processResults({ image: v, multiHandLandmarks: [hand(paths[spec.seed](spec.start + v.currentTime), spec.view)], multiHandedness: [{ label: "Left", score: 0.96 }] });
  };
  return true;
})()`;
}

// How tall the Left/Right tag is drawn for one right hand at several distances, in
// 640-wide units (30 at its normal size, plus its border): the hand at each size for a
// second, on a black picture with the skeleton and box hidden, so the only orange on the
// stage is the tag. Resolves { veryClose, armsLength, further, far, veryFar }; palm (wrist to
// middle knuckle) 0.375, 0.2, 0.125, 0.0625 and 0.03 of the picture's height.
const TAG_HEIGHTS = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!window.__realSend) window.__realSend = Hands.prototype.send;
  Hands.prototype.send = async function () {}; // only these hands
  const T = ${TEMPLATE};
  const shown = ["skeleton", "box"].map((k) => document.querySelector('[data-show="' + k + '"]')).filter((b) => b && b.classList.contains("active"));
  shown.forEach((b) => b.click());
  const stage = document.getElementById("stage");
  const black = Object.assign(document.createElement("canvas"), { width: stage.width, height: stage.height });
  black.getContext("2d").fillRect(0, 0, black.width, black.height);
  const tagHeight = async (s) => {
    for (let f = 0; f < 30; f++) {
      HandTracker._processResults({ image: black, multiHandLandmarks: [T.map(([x, y]) => ({ x: 0.5 + x * s, y: 0.4 + y * s, z: 0 }))], multiHandedness: [{ label: "Left", score: 0.95 }] });
      await sleep(33);
    }
    await sleep(150);
    const d = stage.getContext("2d").getImageData(0, 0, stage.width, stage.height).data;
    let y0 = Infinity, y1 = -1;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - 255) < 40 && Math.abs(d[i + 1] - 146) < 40 && Math.abs(d[i + 2] - 43) < 50) {
        const y = Math.floor(i / 4 / stage.width);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
    return y1 < 0 ? 0 : Math.round(((y1 - y0 + 1) / Math.max(1, stage.width / 640)) * 10) / 10;
  };
  const out = { veryClose: await tagHeight(3), armsLength: await tagHeight(1.6), further: await tagHeight(1), far: await tagHeight(0.5), veryFar: await tagHeight(0.25) };
  HandTracker._processResults({ image: black, multiHandLandmarks: [], multiHandedness: [] });
  shown.forEach((b) => b.click());
  return out;
})()`;

module.exports = { PAGE_SIMULATION, gesturePoses, rigSimulation, TAG_HEIGHTS };
