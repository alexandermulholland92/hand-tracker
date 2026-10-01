/**
 * gestures.js — names each tracked hand's shape ("Fist", "Peace", "Thumbs Up"…) from its
 * landmarks and finger curls, steadied over a few frames so a hand near a threshold doesn't
 * flicker between two names. Used by the main window (app.js) and the Android app's
 * background tracker (phone-control.js).
 *
 *   const g = HandGestures.create();   // its own wave history and steadying
 *   g.update(hands);                    // once a frame (HandTracker's hands)
 *   g.of(hand)                          // -> { label, color }
 *   HandGestures.LABELS                 // every name it gives
 */

(function (global) {
  const NO_GESTURE = { label: "—", color: "#666" };
  // Every label classifyGesture gives (for gesture actions).
  const GESTURE_LABELS = [
    "Open Palm", "Fist", "Point", "Two", "Three", "Four", "Peace", "OK Sign", "Pinch", "Thumbs Up", "Thumbs Down",
    "Rock On", "Call Me", "Shaka", "The Bird", "Live Long and Prosper",
  ];

  // Each user (a window) has its own: the wave history and the steadying are per hand.
  function create() {
    // Tracks recent palm-roll angles per hand to detect a genuine "shaka wave"
    // (the wrist rocking back and forth) vs. a hand held steady — the only
    // real difference between Call Me and Shaka, since they're the same
    // finger shape. Not reset on hand loss — a short gap just restarts the window.
    const ROLL_HISTORY_LEN = 12;
    const rollHistory = {};
    function detectWristWave(handKey, rollDeg) {
      const hist = rollHistory[handKey] || (rollHistory[handKey] = []);
      hist.push(rollDeg);
      if (hist.length > ROLL_HISTORY_LEN) hist.shift();
      if (hist.length < 6) return false;
      let reversals = 0, prevDelta = 0;
      for (let i = 1; i < hist.length; i++) {
        // Shortest way round, so roll passing ±180° isn't mistaken for a rock.
        const delta = ((hist[i] - hist[i - 1] + 540) % 360) - 180;
        if (Math.abs(delta) < 3) continue; // ignore small tracking jitter
        if (prevDelta !== 0 && Math.sign(delta) !== Math.sign(prevDelta)) reversals++;
        prevDelta = delta;
      }
      return reversals >= 2; // at least one full back-and-forth rock
    }

    // The hand's shape in the picture: landmarks relative to the wrist, in the picture's
    // real proportions (MediaPipe gives x and y as fractions of its width and height), and
    // distances in palm lengths (wrist to middle knuckle), so near and far hands compare.
    function handShape(landmarks) {
      const cam = HandTracker.getCamera();
      const aspect = cam.width && cam.height ? cam.width / cam.height : 1;
      const pts = landmarks.map((p) => ({ x: p.x * aspect, y: p.y }));
      const palm = Math.hypot(pts[9].x, pts[9].y) || 1e-6;
      const dist = (i, j) => Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) / palm;
      return { pts, palm, dist, reach: (i) => dist(i, 0) };
    }
    const OTHER_FINGERS = ["index", "middle", "ring", "pinky"];

    // The rules below were measured on photos of real hands (scripts/fixtures/gesture-hands.json)
    // and a live session on a webcam. MediaPipe's curl readings for folded fingers run low
    // (often 0.4-0.65, even in a fist), so the rules mostly use how far each fingertip
    // reaches from the wrist, in palm lengths: folded fingertips reach well under 1, straight
    // ones 1.5-2.5. Distances don't depend on how the hand is turned in the picture.
    const TIPS = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
    // Straight: a low curl reading and a long reach. Folded: reaching well short of `than`.
    const straight = ({ reach }, c, f, min = 1.3) => c[f] < 0.35 && reach(TIPS[f]) > min;
    const shorter = ({ reach }, f, than, ratio) => reach(TIPS[f]) < ratio * than;

    // The Bird: only the middle finger up, raised, with the hand facing the camera.
    // Curled fingertips reach under 0.6 of the middle fingertip's distance from the wrist;
    // straight ones over 0.9.
    function isTheBird({ pts, palm, dist, reach }) {
      // (Index up to 0.72: a thumb holding the index down often leaves it half folded.)
      if (!(reach(8) < 0.72 * reach(12) && reach(16) < 0.65 * reach(12) && reach(20) < 0.65 * reach(12))) return false;
      // Raised: up or sideways on screen, just not pointing down. Sideways counts because
      // a phone held on its side with auto-rotate off turns the whole picture. A finger
      // pointing at the camera looks short, and its on-screen direction means little.
      const finger = dist(9, 12);
      const raised = finger > 0.5 && (pts[12].y - pts[9].y) / palm < 0.7 * finger;
      // Facing the camera: side-on, the knuckles line up one behind another and their
      // spread nearly vanishes.
      return raised && dist(5, 17) > 0.4;
    }

    // Thumbs Up / Thumbs Down: thumb straight and sticking out (its tip reaching further than
    // any other fingertip, which are folded), well away from the index finger (so it isn't a
    // pinch), and pointing up (tip well above all four knuckles) or down (well below them).
    // A thumb out to the side of an upright fist, level with the knuckles, is neither.
    function thumbOut(shape, c) {
      const { reach, dist } = shape;
      return c.thumb < 0.35 && reach(4) > 1.1 && dist(4, 8) > 0.5 && OTHER_FINGERS.every((f) => shorter(shape, f, reach(4), 0.8));
    }
    function thumbHeight({ pts, palm }) {
      return (pts[4].y - Math.max(pts[5].y, pts[9].y, pts[13].y, pts[17].y)) / palm; // > 0: below the knuckles
    }
    function isThumbsUp(shape, c) {
      const { pts, palm } = shape;
      return thumbOut(shape, c) && (pts[4].y - Math.min(pts[5].y, pts[9].y, pts[13].y, pts[17].y)) / palm < -0.6;
    }
    function isThumbsDown(shape, c) {
      return thumbOut(shape, c) && thumbHeight(shape) > 0.35 && shape.pts[4].y > shape.pts[2].y;
    }

    // Fist: all four fingertips folded close to the wrist, thumb tucked in (not sticking out
    // as in a thumbs up, a thumbs down or call me).
    function isFist({ reach }) {
      return [8, 12, 16, 20].every((tip) => reach(tip) < 1.0) && reach(4) < 1.15;
    }

    // Point: index straight, the other three fingertips folded well short of it.
    function isPoint(shape, c) {
      const r = shape.reach(8);
      return straight(shape, c, "index") && ["middle", "ring", "pinky"].every((f) => shorter(shape, f, r, 0.6));
    }

    // Rock On: index and little finger straight, middle and ring folded well short of them.
    function isRockOn(shape, c) {
      const r = Math.min(shape.reach(8), shape.reach(20));
      return straight(shape, c, "index") && straight(shape, c, "pinky", 1.1) && ["middle", "ring"].every((f) => shorter(shape, f, r, 0.6));
    }

    // Call Me / Shaka: thumb and little finger out, the other three folded well short of the
    // little finger.
    function isCallMeShape(shape, c) {
      const r = shape.reach(20);
      return c.thumb < 0.35 && shape.reach(4) > 1.1 && straight(shape, c, "pinky", 1.1) && ["index", "middle", "ring"].every((f) => shorter(shape, f, r, 0.75));
    }

    // OK Sign: thumb and index tips touching in a ring, the other three fingers straight.
    // The gap is measured in palm lengths, so big (close) and small (far) hands alike: OK
    // signs in photos were 0.14-0.24 apart, open hands 0.5 and more. The index bends to
    // make the ring (its tip reaches about 2/3 as far as the middle one), unlike a relaxed
    // hand whose thumb just rests against a straight index finger.
    // (The other three reach at least 1.55, 1.45 and 1.25 palm lengths: fully out, not the
    // half-curled fingers of a pinch, which reach about 1.3, 1.15 and 1.05.)
    function isOkSign({ dist, reach }, c) {
      return dist(4, 8) < 0.35 && reach(8) < 0.8 * reach(12) &&
        ["middle", "ring", "pinky"].every((f) => c[f] < 0.35) && reach(12) > 1.55 && reach(16) > 1.45 && reach(20) > 1.25;
    }

    // Peace: index and middle straight, ring and little fingers folded, their tips reaching
    // under 0.65 of the raised two's distance from the wrist (peace signs in photos: at most
    // 0.58; open hands and the Vulcan salute: over 0.85). Only distances, never directions,
    // so the V reads at any angle, upright, leaning or on its side.
    // The two raised fingers are about the same length (a Bird with the index only half
    // folded is not a peace sign).
    function isPeace({ reach }, c) {
      const raised = Math.min(reach(8), reach(12));
      return c.index < 0.35 && c.middle < 0.35 && reach(8) > 0.8 * reach(12) && reach(12) > 0.8 * reach(8) &&
        reach(16) < 0.65 * raised && reach(20) < 0.65 * raised;
    }

    // Live Long and Prosper (the Vulcan salute): all four fingers straight, index and middle
    // together, ring and little together, with a wide V between the middle and ring fingers.
    // An open or relaxed hand spreads its fingers more evenly. Straight means both a low
    // curl reading and fingertips reaching nearly as far as the middle one (a peace sign's
    // folded ring and little fingers can read as only slightly curled).
    function isVulcanSalute({ dist, reach }, c) {
      const gap = dist(12, 16);
      const straight = OTHER_FINGERS.every((f) => c[f] < 0.35) && reach(8) > 0.75 * reach(12) && reach(16) > 0.75 * reach(12) && reach(20) > 0.6 * reach(12);
      return straight && gap > 0.45 && gap > 1.3 * Math.max(dist(8, 12), dist(16, 20));
    }

    // Finger counting (after geaxgx/depthai_hand_tracker's ONE..FIVE; One is Point, Five is
    // Open Palm). Two: thumb and index out, like an L. Three: thumb, index and middle out.
    // Four: all four fingers up, the thumb folded in. "Clearly out" for a thumb means its tip
    // is well away from the index knuckle (over 0.8 palm lengths): in fists, points and peace
    // signs, on a live webcam and in photos, it stayed under 0.72; held out, 0.8 to 1.8.
    function thumbClearlyOut({ reach, dist }, c) {
      return c.thumb < 0.35 && reach(4) > 1.25 && dist(4, 5) > 0.8;
    }
    function thumbTucked({ reach, dist }) {
      return reach(4) < 1.2 && dist(4, 5) < 0.65;
    }
    function isTwo(shape, c) {
      return thumbClearlyOut(shape, c) && isPoint(shape, c);
    }
    function isThree(shape, c) {
      const { reach } = shape;
      const raised = Math.min(reach(8), reach(12));
      return thumbClearlyOut(shape, c) && straight(shape, c, "index") && straight(shape, c, "middle") &&
        reach(16) < 0.65 * raised && reach(20) < 0.65 * raised;
    }
    function isFour(shape, c) {
      const { reach } = shape;
      return thumbTucked(shape) && OTHER_FINGERS.every((f) => c[f] < 0.35) &&
        reach(8) > 0.75 * reach(12) && reach(16) > 0.75 * reach(12) && reach(20) > 0.6 * reach(12) && reach(12) > 1.4;
    }

    // Gesture classifier built from data we already compute (finger curl,
    // thumb-index distance) plus wrist-relative landmark positions for the
    // one gesture (Thumbs Up) that needs a spatial direction, not just curl.
    // Rules are ordered most-specific-first so a more detailed match (e.g.
    // OK Sign) is checked before a looser one that shares the same signal
    // (e.g. Pinch, which also relies on thumb-index distance).
    // Call it once per frame per hand: the wave detector keeps a history.
    function classifyGesture(hand) {
      const f = hand.features;
      const c = f.fingerCurls;
      const avgCurl = (c.thumb + c.index + c.middle + c.ring + c.pinky) / 5;
      const EXTENDED = 0.35;

      // The most specific shapes come first. The Bird: a thumb tucked over the curled
      // index finger would otherwise read as Pinch. Thumbs Up before OK Sign (a thumb up
      // can brush the index finger). Live Long and Prosper would otherwise read as Open
      // Palm. Fist before Pinch (a thumb resting on the fist's index finger).
      const shape = hand.landmarks ? handShape(hand.landmarks) : null;
      if (shape) {
        if (c.middle < EXTENDED && isTheBird(shape)) return { label: "The Bird", color: "#da77f2" };
        if (isThumbsUp(shape, c)) return { label: "Thumbs Up", color: "#69db7c" };
        if (isThumbsDown(shape, c)) return { label: "Thumbs Down", color: "#e64980" };
        if (isVulcanSalute(shape, c)) return { label: "Live Long and Prosper", color: "#748ffc" };
        if (isFour(shape, c)) return { label: "Four", color: "#3bc9db" };
        if (isOkSign(shape, c)) return { label: "OK Sign", color: "#ffd43b" };
        if (isThree(shape, c)) return { label: "Three", color: "#c0eb75" };
        if (isPeace(shape, c)) return { label: "Peace", color: "#66d9e8" };
        if (isRockOn(shape, c)) return { label: "Rock On", color: "#b197fc" };
        // Call Me / Shaka: identical finger shape — the real-world difference is motion, not
        // shape, so a rocking wrist wave means Shaka; held steady means Call Me.
        if (isCallMeShape(shape, c)) {
          const isWaving = detectWristWave(hand.handedness, hand.orientation.palmEuler.roll);
          return isWaving ? { label: "Shaka", color: "#20c997" } : { label: "Call Me", color: "#ff922b" };
        }
        if (isTwo(shape, c)) return { label: "Two", color: "#e599f7" };
        if (isPoint(shape, c)) return { label: "Point", color: "#74c0fc" };
        if (isFist(shape) || avgCurl > 0.7) return { label: "Fist", color: "#ff6b6b" };
        // Pinch: thumb and index tips touching, in palm lengths (so a small, far-away hand
        // isn't a pinch just because everything in it is close together). After Fist, so a
        // thumb resting on a clenched fist's index finger stays a fist.
        if (shape.dist(4, 8) < 0.35) return { label: "Pinch", color: "#f783ac" };
      } else if (avgCurl > 0.7) return { label: "Fist", color: "#ff6b6b" };
      if (avgCurl < 0.15) return { label: "Open Palm", color: "#51cf66" };
      return NO_GESTURE;
    }

    // Holds a gesture label for a few consecutive frames before switching the
    // displayed badge, so a hand sitting near a threshold (e.g. a half-curled
    // finger) doesn't flicker between two labels every frame. Keyed per side
    // (Left/Right) so each hand's hysteresis is independent.
    const GESTURE_HOLD_FRAMES = 4;
    const gestureHold = {};
    function stableGesture(side, rawGesture) {
      let state = gestureHold[side];
      if (!state) {
        state = { label: rawGesture.label, color: rawGesture.color, candidate: rawGesture.label, count: 1 };
        gestureHold[side] = state;
      }
      if (rawGesture.label === state.candidate) {
        state.count++;
      } else {
        state.candidate = rawGesture.label;
        state.count = 1;
      }
      if (state.count >= GESTURE_HOLD_FRAMES) {
        state.label = rawGesture.label;
        state.color = rawGesture.color;
      }
      return { label: state.label, color: state.color };
    }

    // This frame's gesture per side, classified once in the frame handler and
    // shared by the stage labels, hand cards and Both Hands panel.
    let gestures = {};
    function updateGestures(hands) {
      gestures = {};
      for (const hand of hands) {
        if (!gestures[hand.handedness]) gestures[hand.handedness] = stableGesture(hand.handedness, classifyGesture(hand));
      }
    }
    const gestureOf = (hand) => gestures[hand.handedness] || NO_GESTURE;

    return { update: updateGestures, of: gestureOf, classify: classifyGesture };
  }

  global.HandGestures = { create, LABELS: GESTURE_LABELS, NONE: NO_GESTURE };
})(window);
