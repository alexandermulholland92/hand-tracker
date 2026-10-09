"""
oak_bridge.py - runs hand tracking on a Luxonis OAK camera (OAK-D, OAK-D Lite, OAK-1...)
and streams the hands and the picture to Hand Tracker (electron/oak.js).

The tracking itself is geaxgx/depthai_hand_tracker's (MIT licence, see
LICENSE-depthai_hand_tracker.txt): Google MediaPipe's palm detection and hand landmark
models running on the camera ("Edge mode"), optionally with Body Pre Focusing for hands
far from the camera, and, on depth cameras, each hand's distance.

Usage (Hand Tracker starts it; the models come from its one-time OAK setup):
    python oak_bridge.py --models DIR [--lm lite|full] [--two-hands] [--xyz]
                         [--far both|higher|left|right] [--all-hands] [--fps N] [--device ID]
                         [--mjpeg auto|on|off] [--detect] [--picture color|depth] [--motion]
    (--device: which OAK camera, by its id from --list; the first one found otherwise.
     --mjpeg: the camera sends its pictures as JPEG from its own encoder, about a tenth of the
     data; auto: over USB 2, where the raw pictures of one camera nearly fill the link, and on
     ARM boards such as a Raspberry Pi, where it also saves the processor encoding them.
     --detect: also find objects on the camera (MobileNet-SSD's 20 kinds: person, cat, dog...),
     each with its distance on a depth camera; needs mobilenet-ssd_openvino_2021.4_5shave.blob
     in the models folder. If the camera can't run it alongside the hands, it starts without.
     --picture depth: send the depth picture (coloured: near is red, far is blue) instead of the
     colour one, lined up with it; depth cameras only.
     --motion: the camera also makes a small grey picture (64 x 36) each frame, sent along for
     Sentry mode to measure movement on.)
    python oak_bridge.py --check        prints the versions it would use
    python oak_bridge.py --list         prints the OAK cameras found
    python oak_bridge.py --simulate     no camera: a moving synthetic hand, for testing

Output on stdout, one message after another: the 4 bytes "HTK1", a 4-byte little-endian
length and that many bytes of JSON, then a 4-byte length and that many bytes of JPEG (0 for
none). The JSON is
{"status": ...} or a frame: {"t", "w", "h", "fps", "hands": [{"lm": [[x, y, z]] (0-1 of the
picture, z in picture widths, like MediaPipe), "world": [[x, y, z]] (metres), "label":
"Left"/"Right", "anatomical": true when that's the person's own side (always, on the
camera) rather than MediaPipe's mirrored convention, "score", "lm_score", "xyz": [x, y, z] mm from the
camera (x right, y down, z forward) or null, "gesture"}]}, and with --detect "objects": [{"label",
"score", "box": [x0, y0, x1, y1] (0-1 of the picture), "xyz": [x, y, z] mm or absent}], with
--motion "grey": {"w": 64, "h": 36, "data": base64 of a byte a pixel, rows top to bottom} when
the camera made a new one.
Anything else the tracker prints goes to stderr.
"""

import argparse
import base64
import json
import math
import os
import platform
import struct
import sys
import time

# The stream gets the real stdout to itself. Everything else that writes to stdout (the
# tracker's prints, and depthai's own C++ log lines, which bypass Python) goes to stderr.
OUT = os.fdopen(os.dup(1), "wb", buffering=0)
os.dup2(2, 1)
sys.stdout = sys.stderr
MAGIC = b"HTK1"
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def send(header, jpeg=b""):
    data = json.dumps(header, separators=(",", ":")).encode("utf-8")
    OUT.write(MAGIC + struct.pack("<I", len(data)) + data + struct.pack("<I", len(jpeg)) + jpeg)


def status(state, **extra):
    send({"status": state, **extra})


DETECT_MODEL = "mobilenet-ssd_openvino_2021.4_5shave.blob"
# MobileNet-SSD's kinds of object (PASCAL VOC), by its label number.
VOC = ["background", "aeroplane", "bicycle", "bird", "boat", "bottle", "bus", "car", "cat", "chair", "cow", "diningtable",
       "dog", "horse", "motorbike", "person", "pottedplant", "sheep", "sofa", "train", "tvmonitor"]
MOTION_SIZE = (64, 36)  # the small grey picture Sentry mode measures movement on (made on the camera)


def grey_text(grey):
    """The small grey picture (64 x 36, a byte a pixel, its rows top to bottom) as base64:
    Sentry mode measures movement on it, as it does on any camera's picture."""
    import numpy as np

    g = np.asarray(grey)
    if g.ndim == 3:
        g = g[:, :, 0]
    h, w = g.shape[:2]
    return {"w": int(w), "h": int(h), "data": base64.b64encode(np.ascontiguousarray(g, dtype=np.uint8).tobytes()).decode("ascii")}


def object_of(det):
    """A detection as sent: its kind, how sure, its box (0-1 of the picture) and, from a depth
    camera, where it is (mm: x right, y down, z forward)."""
    label = VOC[det.label] if 0 <= det.label < len(VOC) else str(det.label)
    box = [min(1.0, max(0.0, float(v))) for v in (det.xmin, det.ymin, det.xmax, det.ymax)]
    o = {"label": label, "score": round(float(det.confidence), 3), "box": [round(v, 4) for v in box]}
    sc = getattr(det, "spatialCoordinates", None)
    if sc is not None and sc.z > 0:
        o["xyz"] = [round(float(sc.x)), round(-float(sc.y)), round(float(sc.z))]  # depthai's y points up
    return o


def depth_picture(disparity, max_disparity, w, h):
    """The depth picture as a colour picture the size of the colour one: near is red, far is
    blue, unknown (too near, too far, or seen by one camera only) is black."""
    import cv2
    import numpy as np

    d = disparity.astype(np.float32)
    v = (d * (255.0 / max(1.0, float(max_disparity)))).clip(0, 255).astype(np.uint8)
    img = cv2.applyColorMap(v, cv2.COLORMAP_TURBO)
    img[disparity == 0] = 0
    if img.shape[1] != w or img.shape[0] != h:
        img = cv2.resize(img, (w, h), interpolation=cv2.INTER_NEAREST)
    return img


DETECT_GAP_S = 0.33
# On the camera (a Script node): only every frame DETECT_GAP_S after the last one sent goes on.
DETECT_EVERY = f"""
last = -1.0
while True:
    frame = node.io["frame"].get()
    t = frame.getTimestamp().total_seconds()
    if t - last >= {DETECT_GAP_S}:
        last = t
        node.io["out"].send(frame)
"""


def add_extras(dai, pipeline, cam, stereo, extras, tracker):
    """More from the same camera alongside the hands, each only when asked for: objects found
    on the camera (with their distance on a depth camera), the depth picture, and a small grey
    picture to measure motion on. Their streams are listed in tracker.extra_streams."""

    def out(name, source):
        x = pipeline.create(dai.node.XLinkOut)
        x.setStreamName(name)
        x.input.setBlocking(False)
        x.input.setQueueSize(1)
        source.link(x.input)
        tracker.extra_streams.append(name)

    tracker.extra_streams = []
    if extras.get("detect"):
        # A few looks a second (DETECT_GAP_S apart) rather than one at every frame: plenty for
        # Sentry (it keeps each animal where it was for 3 s, and waits for a look before
        # movement counts; the app keeps each object for 1 s), and each look takes the camera's
        # processor from the hands' models (on an OAK-D-PRO-W, full model, two hands and depth:
        # 11.7 a second with a look at every frame, 14.5 with 5 looks a second, 18.8 with 2,
        # side by side; 20 without objects).
        every = pipeline.create(dai.node.Script)
        every.setScript(DETECT_EVERY)
        every.inputs["frame"].setBlocking(False)
        every.inputs["frame"].setQueueSize(1)
        cam.preview.link(every.inputs["frame"])
        manip = pipeline.create(dai.node.ImageManip)
        manip.initialConfig.setResize(300, 300)  # stretched: its boxes are then fractions of the picture as they are
        manip.initialConfig.setFrameType(dai.ImgFrame.Type.BGR888p)
        manip.setMaxOutputFrameSize(300 * 300 * 3)
        manip.inputImage.setQueueSize(1)
        manip.inputImage.setBlocking(False)
        every.outputs["out"].link(manip.inputImage)
        if stereo is not None:
            nn = pipeline.create(dai.node.MobileNetSpatialDetectionNetwork)
            nn.setBoundingBoxScaleFactor(0.4)  # the middle of each box: its distance, not the background's
            nn.setDepthLowerThreshold(100)
            nn.setDepthUpperThreshold(15000)
            nn.inputDepth.setBlocking(False)
            nn.inputDepth.setQueueSize(1)
            stereo.depth.link(nn.inputDepth)
        else:
            nn = pipeline.create(dai.node.MobileNetDetectionNetwork)
        nn.setBlobPath(extras["detect"])
        nn.setConfidenceThreshold(0.4)  # (a cat seen from above, in poor light, is often less sure than 0.5)
        nn.setNumInferenceThreads(1)  # the hands' models need the camera's processor too
        nn.input.setBlocking(False)
        nn.input.setQueueSize(1)
        manip.out.link(nn.input)
        out("det_out", nn.out)
    if extras.get("picture") == "depth" and stereo is not None:
        tracker.max_disparity = stereo.initialConfig.getMaxDisparity()
        out("pic_out", stereo.disparity)
    if extras.get("motion"):
        small = pipeline.create(dai.node.ImageManip)
        small.initialConfig.setResize(*MOTION_SIZE)
        small.initialConfig.setFrameType(dai.ImgFrame.Type.GRAY8)
        small.setMaxOutputFrameSize(MOTION_SIZE[0] * MOTION_SIZE[1])
        small.inputImage.setQueueSize(1)
        small.inputImage.setBlocking(False)
        cam.preview.link(small.inputImage)
        out("motion_out", small.out)


def encode(frame, quality=75):
    import cv2

    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    return buf.tobytes() if ok else b""


def check():
    import cv2
    import depthai as dai
    import numpy as np

    status("check", depthai=dai.__version__, opencv=cv2.__version__, numpy=np.__version__, python=sys.version.split()[0])


def list_devices():
    import depthai as dai

    found = [{"name": getattr(d, "name", ""), "id": d.getMxId(), "state": str(d.state).split(".")[-1]} for d in dai.Device.getAllAvailableDevices()]
    status("devices", devices=found, silent=silent_devices({d["name"] for d in found}))


def silent_devices(listed):
    """OAK cameras plugged in that depthai couldn't list (Linux): waiting to start, but not
    answering when asked who they are (unplugging one and plugging it back in resets it).
    Their USB ports, named as depthai names them ("3.2" is bus 3, port 2)."""
    root = "/sys/bus/usb/devices"
    found = []
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        return found  # not Linux
    for base in entries:
        if "-" not in base or ":" in base:
            continue
        try:
            with open(os.path.join(root, base, "idVendor")) as f:
                vendor = f.read().strip()
            with open(os.path.join(root, base, "idProduct")) as f:
                product = f.read().strip()
        except OSError:
            continue
        name = base.replace("-", ".", 1)
        if vendor == "03e7" and product == "2485" and name not in listed:
            found.append(name)
    return found


def simulate(args):
    """A synthetic hand moving across a plain picture: tests the whole path without a camera."""
    import numpy as np

    w, h = 1152, 648
    base = [(0, 0), (-.04, -.03), (-.08, -.07), (-.11, -.10), (-.13, -.13), (-.035, -.12), (-.04, -.17), (-.043, -.20), (-.045, -.23),
            (0, -.125), (0, -.18), (0, -.215), (0, -.245), (.03, -.115), (.035, -.165), (.038, -.195), (.04, -.22), (.055, -.10), (.065, -.135), (.07, -.16), (.075, -.18)]
    status("running", camera="Simulated OAK camera", width=w, height=h, depth=True, detect=bool(args.detect), picture=args.picture, motion=bool(args.motion))
    t0 = time.time()
    frame = np.zeros((h, w, 3), dtype=np.uint8)
    frame[:, :] = (60, 45, 30)
    n = 0
    while True:
        t = time.time() - t0
        cx, cy = 0.5 + 0.2 * math.sin(t), 0.7
        lm = [[cx + x, cy + y, 0.0] for x, y in base]
        world = [[x * 0.75, y * 0.75, 0.0] for x, y in base]
        img = frame.copy()
        # With --detect: a cat walking along the bottom, and a person standing at the left.
        cat_x = (t * 0.3) % 1.2 - 0.1
        objects = [{"label": "person", "score": 0.85, "box": [0.05, 0.1, 0.3, 0.98], "xyz": [-1400, 0, 3500]}]
        if -0.06 < cat_x < 1.06:  # (in the picture)
            objects.insert(0, {"label": "cat", "score": 0.9, "box": [round(max(0.0, cat_x - 0.08), 4), 0.72, round(min(1.0, cat_x + 0.08), 4), 0.95],
                               "xyz": [round((cat_x - 0.5) * 3000), 600, 3000]})
        header = {"t": round(t * 1000, 1), "w": w, "h": h, "fps": 30, "hands": []}
        try:
            import cv2

            cv2.putText(img, f"simulated {n}", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1, (200, 200, 200), 2)
            for x, y, _ in lm:
                cv2.circle(img, (int(x * w), int(y * h)), 4, (80, 200, 255), -1)
            if args.detect and objects[0]["label"] == "cat":
                x0, y0, x1, y1 = objects[0]["box"]
                cv2.rectangle(img, (int(x0 * w), int(y0 * h)), (int(x1 * w), int(y1 * h)), (150, 150, 150), -1)
            if args.motion:
                header["grey"] = grey_text(cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), MOTION_SIZE))
            if args.picture == "depth":
                # Nearer towards the bottom, as a floor seen from a camera on a wall.
                disparity = np.tile(np.linspace(10, 90, h, dtype=np.float32)[:, None], (1, w)).astype(np.uint8)
                jpeg = encode(depth_picture(disparity, 95, w, h))
            else:
                jpeg = encode(img)
        except ImportError:
            jpeg = b""
        if args.detect:
            header["objects"] = objects
        # The synthetic hand is a right hand as MediaPipe labels it for a camera facing you.
        header["hands"] = [{"lm": lm, "world": world, "label": "Left", "anatomical": False, "score": 0.97, "lm_score": 0.95, "xyz": [120.0, -40.0, 850.0], "gesture": "FIVE"}]
        send(header, jpeg)
        n += 1
        time.sleep(1 / 30)
        if args.frames and n >= args.frames:
            break


def find_device(dai, wanted, wait):
    """The OAK camera with that id, or the first one found (None if there's none). A camera
    that was just in use, or that failed, resets first (a few seconds, up to 10): it's waited for."""
    deadline = time.time() + wait
    while True:
        devices = [d for d in dai.Device.getAllAvailableDevices() if not wanted or d.getMxId() == wanted]
        if devices or time.time() > deadline:
            return devices[0] if devices else None
        time.sleep(0.5)


USB2_MESSAGE = "The OAK camera didn't keep working in USB 3 mode (its cable or its port): starting it in USB 2 mode."


class Usb2Cameras:
    """The cameras that can't keep a USB 3 link (their cable or their port; Luxonis's advice is
    USB 2). Such a camera boots and then never comes back ("Failed to find device after
    booting", after 15 s), or comes back and drops off the USB again. Started again in USB 2
    mode it works, so it's remembered (beside the models) and started that way straight away
    next time. Seen with an OAK-1 Lite W on a Raspberry Pi 5, alone or on a hub: USB 3 failed
    every time, USB 2 ran it at 30 fps (with the camera's own JPEG, USB 2 is plenty)."""

    def __init__(self, models):
        self.file = os.path.join(os.path.dirname(os.path.abspath(models)), "usb2-cameras.json")

    def ids(self):
        try:
            with open(self.file, encoding="utf-8") as f:
                return set(json.load(f))
        except (OSError, ValueError, TypeError):
            return set()

    def add(self, mxid):
        ids = self.ids()
        if mxid in ids:
            return
        try:
            tmp = f"{self.file}.{os.getpid()}"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(sorted(ids | {mxid}), f)
            os.replace(tmp, self.file)  # several cameras' helpers may write at once
        except OSError:
            pass


def run(args):
    models = args.models
    need = ["palm_detection_sh4.blob", f"hand_landmark_{args.lm}_sh4.blob", "PDPostProcessing_top2_sh1.blob"]
    if args.far:
        need.append("movenet_singlepose_lightning_U8_transpose.blob")
    missing = [m for m in need if not os.path.isfile(os.path.join(models, m))]
    if missing:
        status("error", message="The OAK models are missing (" + ", ".join(missing) + "). Run the OAK setup again.")
        return 2
    warnings = []
    detect = os.path.join(models, DETECT_MODEL) if args.detect else None
    if detect and not os.path.isfile(detect):
        warnings.append("The object finder's model isn't downloaded, so objects aren't found.")
        detect = None
    extras = {"detect": detect, "picture": args.picture, "motion": args.motion}

    import depthai as dai

    common = dict(
        pd_model=os.path.join(models, "palm_detection_sh4.blob"),
        lm_model=os.path.join(models, f"hand_landmark_{args.lm}_sh4.blob"),
        pp_model=os.path.join(models, "PDPostProcessing_top2_sh1.blob"),
        use_world_landmarks=True,
        solo=not args.two_hands,
        xyz=args.xyz,
        internal_fps=args.fps,
        internal_frame_height=640,
        use_gesture=True,
    )
    if args.far:
        import HandTrackerBpfEdge as bpf

        bpf.MOVENET_LIGHTNING_MODEL = os.path.join(models, "movenet_singlepose_lightning_U8_transpose.blob")
        # Two hands at once: both wrists ("group") is the only choice there.
        focus = "group" if args.two_hands or args.far == "both" else args.far
        Base = bpf.HandTrackerBpf
        extra = dict(body_pre_focusing=focus, body_model="lightning", hands_up_only=not args.all_hands)
    else:
        import HandTrackerEdge as edge

        Base = edge.HandTracker
        extra = {}

    import numpy as np

    class Tracker(Base):
        # Objects, the depth picture and the motion picture, alongside the hands (add_extras).
        def extend_pipeline(self, pipeline, cam, stereo):
            add_extras(dai, pipeline, cam, stereo, extras, self)

        # The camera's frame rate: one the camera's processor keeps up with, given all it's
        # asked to do. Asked for more, it starts frames it can't finish and slows right down.
        # Measured on an OAK-D-PRO-W (Pi 5), full model and two hands, with depth and objects
        # (a look at every frame then): 60 asked -> 4.7 a second, 39 -> 6.6, 15 -> 11.7. With
        # objects looked for 3 times a second, 20 -> 20.0 and 25 -> 22.9 (depth only: 25 ->
        # 20.0, 30 -> 17.8). Its rates vary with what's in view: 24 was never far off the best.
        # (The lite model's rates are the tracker's own.) 60 asked for holds only where nothing
        # else shares the processor: no depth, no objects.
        def pick_fps(self, asked, depth):
            busy = depth or extras.get("detect")
            if args.lm == "full":
                best = 24 if busy else 26
            else:
                best = 29 if busy else 36
            if asked:
                return min(asked, best) if busy else asked
            return best

        # Landmarks with their fractions of a pixel kept (the original rounds them).
        def extract_hand_data(self, res, hand_idx):
            hand = super().extract_hand_data(res, hand_idx)
            lm = np.array(res["sqn_lms"][hand_idx], dtype=np.float64).reshape(-1, 2) * self.frame_size
            lm[:, 0] -= self.pad_w
            lm[:, 1] -= self.pad_h
            hand.landmarks_f = lm
            return hand

    def stream(tracker, mjpeg):
        depth = bool(getattr(tracker, "xyz", False))
        t0 = time.time()
        last = time.time()
        frames = 0
        fps = 0.0
        queues = {name: tracker.device.getOutputQueue(name=name, maxSize=1, blocking=False) for name in getattr(tracker, "extra_streams", [])}
        objects, objects_at = [], 0.0
        picture = None
        while True:
            frame, hands, _ = tracker.next_frame()
            if frame is None:
                break
            h, w = tracker.img_h, tracker.img_w
            if "det_out" in queues:
                found = queues["det_out"].tryGet()
                if found is not None:
                    objects, objects_at = [object_of(d) for d in found.detections], time.time()
                elif time.time() - objects_at > 1:
                    objects = []  # (none for a second: they're gone)
            grey = None
            if "motion_out" in queues:
                small = queues["motion_out"].tryGet()
                if small is not None:
                    grey = grey_text(small.getFrame())
            if "pic_out" in queues:
                disparity = queues["pic_out"].tryGet()
                if disparity is not None:
                    picture = encode(depth_picture(disparity.getFrame(), tracker.max_disparity, w, h))
            out = []
            for hand in hands:
                lm = hand.landmarks_f
                # z: the landmark model's depth, relative to its rotated square, in picture widths.
                zs = np.array(hand.norm_landmarks)[:, 2] * (hand.rect_w_a / w)
                world = np.array(getattr(hand, "world_landmarks", np.zeros((21, 3)))).reshape(-1, 3)
                hd = float(hand.handedness)
                # On the camera the label is already the person's own side (checked with an
                # OAK-D Pro W: a right hand held up reads > 0.5), unlike MediaPipe's in a
                # browser, which assumes a mirrored picture; the body model's is too.
                anatomical = True
                xyz = None
                if depth and getattr(hand, "xyz", None) is not None:
                    x, y, z = [float(v) for v in hand.xyz]
                    xyz = [x, -y, z] if z > 0 else None  # depthai's y points up
                out.append({
                    "lm": [[float(lm[i][0]) / w, float(lm[i][1]) / h, float(zs[i])] for i in range(21)],
                    "world": world.astype(float).round(5).tolist(),
                    "label": "Right" if hd > 0.5 else "Left",
                    "anatomical": anatomical,
                    "score": round(max(hd, 1 - hd), 3),
                    "lm_score": round(float(hand.lm_score), 3),
                    "xyz": xyz,
                    "gesture": getattr(hand, "gesture", None),
                })
            frames += 1
            now = time.time()
            if now - last >= 0.5:
                fps = frames / (now - last)
                frames = 0
                last = now
            header = {"t": round((now - t0) * 1000, 1), "w": w, "h": h, "fps": round(fps, 1), "hands": out}
            if "det_out" in queues:
                header["objects"] = objects
            if grey:
                header["grey"] = grey  # (only when the camera made a new one)
            jpeg = picture if "pic_out" in queues and picture else tracker.jpeg if mjpeg else encode(frame)
            send(header, jpeg)

    usb2 = Usb2Cameras(models)
    wanted, retried = args.device, False
    while True:
        device, high = None, retried
        try:
            info = find_device(dai, wanted, 20 if retried else 10)
            if info is None:
                if retried:
                    raise RuntimeError("X_LINK_DEVICE_NOT_FOUND: the camera didn't come back after a failed start")
                status("error", message="That OAK camera wasn't found: it may have been unplugged." if args.device else
                       "No OAK camera found. Check it's plugged in (a USB 3 port is best) and not in use by another program.")
                return 3
            wanted = info.getMxId()  # the same camera if it's started again
            high = retried or wanted in usb2.ids()
            device = dai.Device(info, dai.UsbSpeed.HIGH if high else dai.UsbSpeed.SUPER)
            usb = str(device.getUsbSpeed()).split(".")[-1]
            mjpeg = args.mjpeg == "on" or (args.mjpeg == "auto" and (usb in ("LOW", "FULL", "HIGH") or platform.machine().lower() in ("aarch64", "arm64")))
            tracker = Tracker(**common, **extra, device=device, mjpeg=mjpeg)
        except SystemExit:
            if device is not None:
                device.close()
            status("error", message="The OAK camera couldn't be started with these settings.")
            return 4
        except Exception as err:  # device errors come as RuntimeError with a readable message
            if device is not None:
                try:
                    device.close()
                except Exception:
                    pass
            text = str(err)
            if extras["detect"]:
                # Finding objects as well may be more than the camera's processor can take with the
                # hands' models (or its model may not load): started again without it.
                extras["detect"] = None
                warnings.append(f"Finding objects couldn't run alongside the hand tracking on this camera ({text.splitlines()[0][:160] if text else 'no reason given'}).")
                status("starting", message="Starting the OAK camera again without finding objects…")
                time.sleep(2)  # until the camera is let go
                continue
            permission = sys.platform.startswith("linux") and any(k in text.lower() for k in ("permission", "udev"))
            if not high and not permission:
                # Whatever went wrong in USB 3 mode, USB 2 mode is tried once (see Usb2Cameras).
                retried = True
                status("starting", message=USB2_MESSAGE)
                continue
            if permission:
                # depthai: "Insufficient permissions to communicate with X_LINK_UNBOOTED device...":
                # Linux needs a USB rule for it. The .deb adds it; elsewhere it's added once by hand.
                status("error", message=("The OAK camera couldn't be started: Linux isn't letting Hand Tracker use it yet. "
                                         "Unplug it and plug it back in. If that doesn't help (or Hand Tracker wasn't installed from its .deb), "
                                         "allow it once in a terminal: echo 'SUBSYSTEM==\"usb\", ATTRS{idVendor}==\"03e7\", MODE=\"0666\"' | "
                                         "sudo tee /etc/udev/rules.d/80-movidius.rules && sudo udevadm control --reload-rules && sudo udevadm trigger, "
                                         "then plug it in again."))
                return 4
            if any(k in text.lower() for k in ("boot", "couldn't open stream", "permission", "x_link")):
                text = ("it's busy or didn't answer. Close OAK Viewer or any other program using it, then try again. "
                        "If that doesn't help, unplug it and plug it back in, ideally into a USB 3 port with the cable that came with it.")
            status("error", message=f"The OAK camera couldn't be started: {text}")
            return 4

        streams = getattr(tracker, "extra_streams", [])
        if args.picture == "depth" and "pic_out" not in streams:
            warnings.append("This camera has no depth cameras, so its colour picture is shown.")
        status("running", camera=getattr(getattr(tracker, "device", None), "getDeviceName", lambda: "OAK camera")(), width=tracker.img_w, height=tracker.img_h,
               depth=bool(getattr(tracker, "xyz", False)), id=device.getMxId(), usb=usb, jpeg="camera" if mjpeg else "computer",
               detect="det_out" in streams, picture="depth" if "pic_out" in streams else "color", motion="motion_out" in streams,
               warning=" ".join(dict.fromkeys(warnings)) or None)
        if retried:
            usb2.add(wanted)
        try:
            stream(tracker, mjpeg)
        except (BrokenPipeError, KeyboardInterrupt):
            pass
        except RuntimeError:
            # The camera dropped off in USB 3 mode (X_LINK_ERROR): it's started again in USB 2 mode.
            if usb != "SUPER" or retried:
                raise
            retried = True
            status("starting", message=USB2_MESSAGE)
            continue
        finally:
            try:
                tracker.exit()
            except Exception:
                pass
        return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=os.path.join(HERE, "models"))
    ap.add_argument("--lm", choices=["lite", "full"], default="lite")
    ap.add_argument("--two-hands", action="store_true")
    ap.add_argument("--xyz", action="store_true")
    ap.add_argument("--far", choices=["both", "higher", "left", "right"])
    ap.add_argument("--all-hands", action="store_true", help="far mode: not only raised hands")
    ap.add_argument("--fps", type=int, default=None)
    ap.add_argument("--device", default=None, help="which OAK camera, by its id (from --list)")
    ap.add_argument("--mjpeg", choices=["auto", "on", "off"], default="auto", help="pictures as JPEG from the camera's encoder")
    ap.add_argument("--detect", action="store_true", help="also find objects (person, cat, dog...) on the camera")
    ap.add_argument("--picture", choices=["color", "depth"], default="color", help="the picture sent: colour, or depth (depth cameras)")
    ap.add_argument("--motion", action="store_true", help="a small grey picture (64 x 36) with each frame, for Sentry mode")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--simulate", action="store_true")
    ap.add_argument("--frames", type=int, default=0, help="simulate: stop after this many frames")
    args = ap.parse_args()
    try:
        if args.check:
            check()
            return 0
        if args.list:
            list_devices()
            return 0
        if args.simulate:
            simulate(args)
            return 0
        return run(args)
    except ImportError as err:
        status("error", message=f"OAK support isn't set up ({err.name or err} is missing). Run the OAK setup.")
        return 5
    except Exception as err:
        status("error", message=f"OAK camera: {err}")
        return 1


if __name__ == "__main__":
    sys.exit(main() or 0)
