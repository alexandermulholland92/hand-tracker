/**
 * robot-motion.js
 * Records HandTracker output into a robotics-oriented motion capture format:
 * a full 21-joint kinematic chain (position + orientation + velocity +
 * acceleration per joint), end-effector / palm-orientation trajectories, and
 * heuristic task-phase segmentation (reach / grasp / manipulate / release).
 *
 * Both hands are recorded, each as its own track keyed by handedness, on a
 * shared session clock so two-handed (bimanual) tasks stay time-aligned.
 *
 * Usage:
 *   RobotMotion.start();
 *   RobotMotion.feed(hands, timestamp);  // call once per frame with the HandTracker hands array
 *   const data = RobotMotion.stop();     // returns the full JSON-ready object (format_version 2)
 *
 * Output shape (format_version 2):
 *   { format_version, frame_rate, duration, recorded_at, coordinate_frame,
 *     hands: [{ handedness, frame_rate, frames, trajectories, task_segments }, ...], notes }
 *   Version 1 files (single hand, frames at the top level) came from earlier builds.
 *
 * IMPORTANT LIMITATIONS (be aware of these when consuming the output):
 *  - "World" position is the wrist's raw camera-frame coordinate, lightly
 *    smoothed. A single monocular webcam cannot produce true calibrated,
 *    camera-position-invariant 3D coordinates — depth (z) is a relative
 *    MediaPipe estimate, not measured. Treat trajectories as camera-relative,
 *    not world-frame in the robotics sense.
 *  - Task-phase segmentation is a simple hand-tuned heuristic (finger-curl +
 *    wrist-speed thresholds), not a learned classifier. It's a reasonable
 *    starting point, not production-grade phase detection.
 */

(function (global) {
  const { subVec, normVec, quatFromVectors } = global.HandTracker._math;
  const UP = { x: 0, y: 1, z: 0 };
  const FORMAT_VERSION = 2;

  const JOINT_NAMES = [
    "wrist",
    "thumb_cmc", "thumb_mcp", "thumb_ip", "thumb_tip",
    "index_mcp", "index_pip", "index_dip", "index_tip",
    "middle_mcp", "middle_pip", "middle_dip", "middle_tip",
    "ring_mcp", "ring_pip", "ring_dip", "ring_tip",
    "pinky_mcp", "pinky_pip", "pinky_dip", "pinky_tip",
  ];
  // Parent joint index for each of the 21 landmarks (-1 = root/wrist).
  const PARENT_INDEX = [
    -1,
    0, 1, 2, 3,
    0, 5, 6, 7,
    0, 9, 10, 11,
    0, 13, 14, 15,
    0, 17, 18, 19,
  ];

  // Phase-detection thresholds — tune these for your setup/camera distance.
  const SPEED_MOVING = 0.15;   // wrist units/sec considered "moving"
  const CURL_OPEN = 0.25;      // avg curl below this = hand open
  const CURL_CLOSED = 0.55;    // avg curl above this = hand closed/grasping
  const CURL_DELTA_FAST = 0.02; // per-frame curl change considered a fast close/open
  // Frames further apart than this (hand left view / tracking dropped) are a
  // discontinuity: velocity, acceleration and curl deltas restart from zero.
  const MAX_GAP_S = 0.25;

  let recording = false;
  let tracks = {}; // { Left: track, Right: track }
  let sessionStart = null; // first fed timestamp — the shared clock for every hand
  let recordedAt = null;

  function newTrack(label) {
    return {
      handedness: label,
      frames: [],
      endEffectorTraj: [],
      palmOrientTraj: [],
      taskSegments: [],
      prevTimestamp: null,
      prevJointPositions: null, // array of 21 {x,y,z}
      prevJointVelocities: null,
      prevAvgCurl: null,
      currentPhase: null,
      currentPhaseStartFrame: 0,
    };
  }

  function avg(obj) {
    const vals = Object.values(obj);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  function closeSegment(track, endFrame) {
    if (track.currentPhase !== null) {
      track.taskSegments.push({ phase: track.currentPhase, start_frame: track.currentPhaseStartFrame, end_frame: endFrame });
    }
  }

  function updatePhase(track, frameIndex, avgCurl, speed) {
    const curlDelta = track.prevAvgCurl === null ? 0 : avgCurl - track.prevAvgCurl;
    const closing = curlDelta > CURL_DELTA_FAST;
    const opening = curlDelta < -CURL_DELTA_FAST;
    const open = avgCurl < CURL_OPEN;
    const closed = avgCurl > CURL_CLOSED;
    const moving = speed > SPEED_MOVING;

    let phase;
    if (closing) phase = "grasp";
    else if (opening) phase = "release";
    else if (closed) phase = "manipulate";
    else if (moving && open) phase = "reach";
    else phase = "idle";

    if (phase !== track.currentPhase) {
      closeSegment(track, frameIndex - 1);
      track.currentPhase = phase;
      track.currentPhaseStartFrame = frameIndex;
    }
    track.prevAvgCurl = avgCurl;
  }

  function start() {
    recording = true;
    tracks = {};
    sessionStart = null;
    recordedAt = new Date().toISOString();
  }

  function feedHand(hand, timestamp) {
    if (sessionStart === null) sessionStart = timestamp;
    const label = hand.handedness;
    const track = tracks[label] || (tracks[label] = newTrack(label));
    // Frames must move forward in time (a video file can be seeked backwards).
    if (track.prevTimestamp !== null && timestamp <= track.prevTimestamp) return;
    if (timestamp < sessionStart) return;

    const frameIndex = track.frames.length;
    const t = (timestamp - sessionStart) / 1000;
    const landmarks = hand.landmarks; // 21 points, wrist-relative, already smoothed
    let dt = track.prevTimestamp !== null ? Math.max((timestamp - track.prevTimestamp) / 1000, 1e-3) : null;
    if (dt !== null && dt > MAX_GAP_S) {
      dt = null;
      track.prevJointPositions = null;
      track.prevJointVelocities = null;
      track.prevAvgCurl = null;
    }

    const joints = [];
    const newVelocities = [];
    for (let i = 0; i < 21; i++) {
      const pos = landmarks[i];

      let orientation;
      if (i === 0) {
        orientation = hand.orientation.palm;
      } else {
        const parentPos = landmarks[PARENT_INDEX[i]];
        const dir = normVec(subVec(pos, parentPos));
        orientation = quatFromVectors(UP, dir);
      }

      let velocity = { x: 0, y: 0, z: 0 };
      let acceleration = { x: 0, y: 0, z: 0 };
      if (dt && track.prevJointPositions) {
        const prevPos = track.prevJointPositions[i];
        velocity = {
          x: (pos.x - prevPos.x) / dt,
          y: (pos.y - prevPos.y) / dt,
          z: (pos.z - prevPos.z) / dt,
        };
        if (track.prevJointVelocities) {
          const prevVel = track.prevJointVelocities[i];
          acceleration = {
            x: (velocity.x - prevVel.x) / dt,
            y: (velocity.y - prevVel.y) / dt,
            z: (velocity.z - prevVel.z) / dt,
          };
        }
      }
      newVelocities.push(velocity);

      joints.push({
        name: JOINT_NAMES[i],
        position: [pos.x, pos.y, pos.z],
        orientation: [orientation.x, orientation.y, orientation.z, orientation.w],
        velocity: [velocity.x, velocity.y, velocity.z],
        acceleration: [acceleration.x, acceleration.y, acceleration.z],
      });
    }

    track.prevJointPositions = landmarks.map((p) => ({ ...p }));
    track.prevJointVelocities = newVelocities;
    track.prevTimestamp = timestamp;

    const frame = { frame_index: frameIndex, t, joints };
    // The hand's real shape (metres, origin at the hand's centre) and, from a depth camera,
    // where it is (mm from the camera).
    if (hand.worldLandmarks) frame.world_joints = hand.worldLandmarks.map((p) => [p.x, p.y, p.z]);
    if (hand.distance) frame.distance_mm = hand.distance.slice(0, 3);
    track.frames.push(frame);

    const w = hand.features.worldPosition;
    track.endEffectorTraj.push([t, w.x, w.y, w.z]);

    const p = hand.orientation.palm;
    track.palmOrientTraj.push([t, p.x, p.y, p.z, p.w]);

    updatePhase(track, frameIndex, avg(hand.features.fingerCurls), hand.features.wristVelocity.speed);
  }

  // Call once per frame with the HandTracker hands array (a single hand also works).
  function feed(handsOrHand, timestamp) {
    if (!recording || !handsOrHand) return;
    const list = Array.isArray(handsOrHand) ? handsOrHand : [handsOrHand];
    for (const hand of list) feedHand(hand, timestamp);
  }

  // Average capture rate for one hand, measured across its own frames.
  function measuredRate(frames) {
    const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
    return span > 0 ? Math.round(((frames.length - 1) / span) * 10) / 10 : null;
  }

  function finishTrack(track) {
    if (track.frames.length > 0) closeSegment(track, track.frames.length - 1);
    return {
      handedness: track.handedness,
      frame_rate: measuredRate(track.frames),
      frames: track.frames,
      trajectories: {
        end_effector: track.endEffectorTraj,     // [t, x, y, z] — approximate camera-frame wrist position
        palm_orientation: track.palmOrientTraj,  // [t, qx, qy, qz, qw]
      },
      task_segments: track.taskSegments,
    };
  }

  function stop() {
    recording = false;
    // Stable order: Left, then Right, then anything unlabeled.
    const order = (label) => (label === "Left" ? 0 : label === "Right" ? 1 : 2);
    const hands = Object.values(tracks)
      .sort((a, b) => order(a.handedness) - order(b.handedness))
      .map(finishTrack);

    const duration = hands.reduce((max, h) => Math.max(max, h.frames.length ? h.frames[h.frames.length - 1].t : 0), 0);
    const busiest = hands.reduce((best, h) => (!best || h.frames.length > best.frames.length ? h : best), null);

    return {
      format_version: FORMAT_VERSION,
      frame_rate: busiest ? busiest.frame_rate : null,
      duration,
      recorded_at: recordedAt,
      coordinate_frame: "wrist_relative + world_aligned",
      hands,
      notes: [
        "Each entry in hands[] is one hand's track; t is seconds on a clock shared by all hands.",
        "Joint positions are wrist-relative (wrist = local origin).",
        "world_joints (when present): each joint's real position in metres, estimated by the hand model, origin at the hand's centre (x right, y down, z away from the camera).",
        "distance_mm (when present): the wrist's position measured by a depth camera, in mm from the camera (x right, y down, z forward).",
        "end_effector trajectory is camera-frame, not calibrated world 3D (monocular limitation).",
        "task_segments are heuristic (curl/speed thresholds), not learned classification.",
        "Orientation for non-root joints is each bone's direction relative to a fixed [0,1,0] reference axis, not true parent-relative joint rotation (twist is not recoverable from point landmarks alone).",
      ],
    };
  }

  function isRecording() {
    return recording;
  }

  // Total frames captured across all hands.
  function frameCount() {
    return Object.values(tracks).reduce((n, track) => n + track.frames.length, 0);
  }

  // Current phase for one hand, or null if that hand hasn't been recorded.
  function getCurrentPhase(label) {
    const track = label ? tracks[label] : Object.values(tracks)[0];
    return track ? track.currentPhase : null;
  }

  // Per-hand live status: [{ handedness, frames, phase }]
  function getStatus() {
    return Object.values(tracks).map((track) => ({
      handedness: track.handedness,
      frames: track.frames.length,
      phase: track.currentPhase,
    }));
  }

  global.RobotMotion = { start, feed, stop, isRecording, frameCount, getCurrentPhase, getStatus };
})(window);
