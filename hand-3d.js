/**
 * hand-3d.js
 * Renders live 3D hand skeletons (up to two hands) and a simple simulated
 * gripper per hand using Three.js. Each gripper's orientation follows its
 * palm's quaternion, and its jaw angle follows average finger curl
 * (open hand -> open jaws, fist -> closed jaws).
 *
 * Usage:
 *   Hand3D.init(containerEl);
 *   Hand3D.update(hands); // once per frame with the HandTracker hands array (a single hand also works)
 *   Hand3D.getCanvas();   // the WebGL canvas (kept readable so it can be recorded)
 *   Hand3D.setMirror(true/false); // match the 2D camera view's mirror setting
 */

(function (global) {
  const SCALE = 6; // landmarks are small (wrist-relative, ~0-0.3 range) — scale up for visibility
  const HIDE_AFTER_MS = 300; // ride out brief tracking dropouts before hiding a hand

  // Bone connections mirroring MediaPipe's hand skeleton structure.
  const BONES = [
    [0, 1], [1, 2], [2, 3], [3, 4],       // thumb
    [0, 5], [5, 6], [6, 7], [7, 8],       // index
    [5, 9], [9, 10], [10, 11], [11, 12],  // middle
    [9, 13], [13, 14], [14, 15], [15, 16],// ring
    [13, 17], [17, 18], [18, 19], [19, 20],// pinky
    [0, 17],                              // palm base closure
  ];

  // Colors match the Left (blue) / Right (orange) hand cards in the UI.
  // Gripper offsets are in raw camera space (same as the hand positions), so
  // each gripper sits on the outer side of its own hand in either view.
  const SIDES = {
    Left: { joint: 0x4dabf7, bone: 0xa5d8ff, palm: 0x4dabf7, jaw: 0xd0ebff, trail: [0.3, 0.67, 0.97], offsetX: 4.5 },
    Right: { joint: 0xff922b, bone: 0xffd8a8, palm: 0xff922b, jaw: 0xffe8cc, trail: [1.0, 0.57, 0.17], offsetX: -4.5 },
  };

  // --- Fading wrist motion trail ---
  const TRAIL_LENGTH = 60; // ~1-2 seconds of history depending on frame rate

  let scene, camera, renderer, controls, containerEl, mirrorGroup;
  let rigs = {}; // { Left: rig, Right: rig }
  let ready = false;

  function makeRig(mirrorGroup, colors) {
    const T = global.THREE;
    const rig = { colors, lastSeen: 0, joints: [], bones: [], trailPositions: [] };

    // Hand skeleton: 21 joint spheres + bone lines, grouped so the whole hand
    // can be translated as a unit (landmarks are wrist-relative, so without
    // this the hand would never actually move through space).
    rig.handGroup = new T.Group();
    mirrorGroup.add(rig.handGroup);

    const sphereGeo = new T.SphereGeometry(0.12, 10, 10);
    const sphereMat = new T.MeshStandardMaterial({ color: colors.joint });
    for (let i = 0; i < 21; i++) {
      const m = new T.Mesh(sphereGeo, sphereMat);
      rig.handGroup.add(m);
      rig.joints.push(m);
    }
    const lineMat = new T.LineBasicMaterial({ color: colors.bone });
    for (const [a, b] of BONES) {
      const geo = new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]);
      const line = new T.Line(geo, lineMat);
      rig.handGroup.add(line);
      rig.bones.push({ line, a, b });
    }

    // Simple simulated gripper, offset to the side, also translates with the hand.
    rig.gripperGroup = new T.Group();
    mirrorGroup.add(rig.gripperGroup);

    const palmMat = new T.MeshStandardMaterial({ color: colors.palm });
    rig.gripperGroup.add(new T.Mesh(new T.BoxGeometry(1, 0.4, 1), palmMat));

    const jawMat = new T.MeshStandardMaterial({ color: colors.jaw });
    const jawGeo = new T.BoxGeometry(0.2, 1.4, 0.3);
    const makeJaw = (x) => {
      const pivot = new T.Group();
      pivot.position.set(x, -0.3, 0);
      const mesh = new T.Mesh(jawGeo, jawMat);
      mesh.position.set(0, -0.6, 0);
      pivot.add(mesh);
      rig.gripperGroup.add(pivot);
      return pivot;
    };
    rig.jawLeft = makeJaw(-0.5);
    rig.jawRight = makeJaw(0.5);

    // Fading trail behind the wrist, traces recent motion history.
    rig.trailGeometry = new T.BufferGeometry();
    rig.trailGeometry.setAttribute("position", new T.BufferAttribute(new Float32Array(TRAIL_LENGTH * 3), 3));
    rig.trailGeometry.setAttribute("color", new T.BufferAttribute(new Float32Array(TRAIL_LENGTH * 3), 3));
    const trailMat = new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 });
    rig.trailLine = new T.Line(rig.trailGeometry, trailMat);
    mirrorGroup.add(rig.trailLine);

    setRigVisible(rig, false);
    return rig;
  }

  function init(container) {
    const T = global.THREE;
    containerEl = container;
    const width = containerEl.clientWidth || 400;
    const height = containerEl.clientHeight || 380;

    scene = new T.Scene();
    scene.background = new T.Color(0x0e0f12);

    camera = new T.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(1.5, 1.5, 11);

    // preserveDrawingBuffer keeps the last frame readable so the video
    // recorder can composite this canvas at any time.
    renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    containerEl.innerHTML = "";
    containerEl.appendChild(renderer.domElement);

    scene.add(new T.AmbientLight(0x606070));
    const light = new T.DirectionalLight(0xffffff, 0.9);
    light.position.set(5, 8, 6);
    scene.add(light);

    const grid = new T.GridHelper(40, 40, 0x2c2e36, 0x1c1d22);
    grid.position.y = -4;
    scene.add(grid);

    if (T.OrbitControls) {
      controls = new T.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
    }

    // Everything lives in one group whose X scale follows the 2D view's
    // mirror setting, so left/right always match the camera panel above.
    // Raw camera space has +x to the right of the image, which is the
    // unmirrored view.
    mirrorGroup = new T.Group();
    scene.add(mirrorGroup);

    rigs = { Left: makeRig(mirrorGroup, SIDES.Left), Right: makeRig(mirrorGroup, SIDES.Right) };

    if (global.ResizeObserver) new global.ResizeObserver(resize).observe(containerEl);

    ready = true;
    animate();
  }

  function resize() {
    const w = containerEl.clientWidth;
    const h = containerEl.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    for (const rig of Object.values(rigs)) {
      if (rig.visible && now - rig.lastSeen > HIDE_AFTER_MS) {
        setRigVisible(rig, false);
        rig.trailPositions = [];
      }
    }
    if (controls) controls.update();
    if (renderer && scene && camera) renderer.render(scene, camera);
  }

  function setRigVisible(rig, visible) {
    rig.visible = visible;
    rig.handGroup.visible = visible;
    rig.gripperGroup.visible = visible;
    rig.trailLine.visible = visible;
  }

  // Convert a wrist-relative landmark {x,y,z} into Three.js space
  // (image y is down / z is depth-away-from-camera, so flip both for a natural view).
  function toVec3(p) {
    return new global.THREE.Vector3(p.x * SCALE, -p.y * SCALE, -p.z * SCALE);
  }

  // Convert the raw (0-1 image-space) world wrist position into a scene
  // translation, centered so the middle of the camera frame maps to the
  // scene's origin. This is what actually moves the hand/gripper through
  // space — wrist-relative landmarks alone never do, since the wrist is
  // always (0,0,0) relative to itself.
  function toWorldTranslation(worldPos) {
    return new global.THREE.Vector3(
      (worldPos.x - 0.5) * SCALE,
      -(worldPos.y - 0.5) * SCALE,
      -worldPos.z * SCALE
    );
  }

  function updateRig(rig, hand) {
    const landmarks = hand.landmarks;
    rig.lastSeen = performance.now();
    if (!rig.visible) setRigVisible(rig, true);

    // Move the whole hand + gripper based on the wrist's actual position in the
    // camera frame — without this, only the fingers would visibly move.
    const worldTranslation = toWorldTranslation(hand.features.worldPosition);
    rig.handGroup.position.copy(worldTranslation);
    rig.gripperGroup.position.set(rig.colors.offsetX + worldTranslation.x, worldTranslation.y, worldTranslation.z);

    for (let i = 0; i < 21; i++) {
      rig.joints[i].position.copy(toVec3(landmarks[i]));
    }
    for (const { line, a, b } of rig.bones) {
      const pa = toVec3(landmarks[a]);
      const pb = toVec3(landmarks[b]);
      const posAttr = line.geometry.attributes.position;
      posAttr.setXYZ(0, pa.x, pa.y, pa.z);
      posAttr.setXYZ(1, pb.x, pb.y, pb.z);
      posAttr.needsUpdate = true;
    }

    // Gripper follows palm orientation (same y/z flip as joint positions, for consistency)
    const q = hand.orientation.palm;
    rig.gripperGroup.quaternion.set(q.x, -q.y, -q.z, q.w);

    // Gripper jaw angle mimics the hand's grip: open hand -> jaws spread apart (angle 0),
    // fist -> jaws swing inward to meet at center. maxAngle is derived from the hinge
    // geometry itself (pivot offset 0.5, arm length 1.3) so the tips meet exactly at
    // center rather than overshooting into a crossed "X" shape.
    const c = hand.features.fingerCurls;
    const avgCurl = (c.thumb + c.index + c.middle + c.ring + c.pinky) / 5;
    const HINGE_OFFSET = 0.5, ARM_LENGTH = 1.3;
    const maxAngle = Math.asin(HINGE_OFFSET / ARM_LENGTH); // ~22.6°, tips just touch here
    const angle = maxAngle * avgCurl; // 0 = open/spread, maxAngle = closed/touching
    rig.jawLeft.rotation.z = angle;
    rig.jawRight.rotation.z = -angle;

    updateTrail(rig, worldTranslation); // trail follows the wrist's actual position in space
  }

  function update(handsOrHand) {
    if (!ready || !handsOrHand) return;
    const list = Array.isArray(handsOrHand) ? handsOrHand : [handsOrHand];
    const used = new Set();
    for (const hand of list) {
      // Unlabeled hands (rare) take whichever rig is still free this frame.
      let side = rigs[hand.handedness] && !used.has(hand.handedness) ? hand.handedness : null;
      if (!side) side = ["Left", "Right"].find((s) => !used.has(s));
      if (!side) continue;
      used.add(side);
      updateRig(rigs[side], hand);
    }
  }

  function updateTrail(rig, wristPos) {
    rig.trailPositions.push(wristPos);
    if (rig.trailPositions.length > TRAIL_LENGTH) rig.trailPositions.shift();

    const posAttr = rig.trailGeometry.attributes.position;
    const colorAttr = rig.trailGeometry.attributes.color;
    const n = rig.trailPositions.length;
    const [r, g, b] = rig.colors.trail;

    for (let i = 0; i < TRAIL_LENGTH; i++) {
      if (i < n) {
        const p = rig.trailPositions[i];
        posAttr.setXYZ(i, p.x, p.y, p.z);
        // Fade from dim (oldest) to the hand's full color (newest).
        const age = i / Math.max(n - 1, 1);
        const k = 0.25 + 0.75 * age;
        colorAttr.setXYZ(i, r * k, g * k, b * k);
      } else {
        // Collapse unused vertices onto the oldest known point so they don't draw stray lines.
        const p = rig.trailPositions[0] || { x: 0, y: 0, z: 0 };
        posAttr.setXYZ(i, p.x, p.y, p.z);
        colorAttr.setXYZ(i, 0, 0, 0);
      }
    }
    posAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
    rig.trailGeometry.setDrawRange(0, n);
  }

  function getCanvas() {
    return renderer ? renderer.domElement : null;
  }

  function setMirror(mirrored) {
    if (mirrorGroup) mirrorGroup.scale.x = mirrored ? -1 : 1;
  }

  global.Hand3D = { init, update, getCanvas, setMirror };
})(window);
