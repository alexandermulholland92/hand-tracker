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
                         [--mjpeg auto|on|off] [--detect] [--picture color|depth|left|right|blend|side]
                         [--motion] [--imu] [--no-hands]
                         [--night auto|on|off] [--ir-dots]
    (--device: which OAK camera, by its id from --list; the first one found otherwise.
     --mjpeg: the camera sends its pictures as JPEG from its own encoder, about a tenth of the
     data; auto: over USB 2, where the raw pictures of one camera nearly fill the link, and on
     ARM boards such as a Raspberry Pi, where it also saves the processor encoding them.
     --detect: also find objects on the camera (MobileNet-SSD's 20 kinds: person, cat, dog...),
     each with its distance on a depth camera; needs mobilenet-ssd_openvino_2021.4_5shave.blob
     in the models folder. If the camera can't run it alongside the hands, it starts without.
     --picture depth: send the depth picture (coloured: near is red, far is blue) instead of the
     colour one, lined up with it; depth cameras only. blend: the colour picture with the depth
     picture laid over it, half see-through; side: the two side by side (twice as wide; the
     hands' places are the colour half's). left / right: that black-and-white camera's picture,
     for everything (the hands are found on it, as with night vision, which is the left one with
     the infrared light on; --night on turns the light on here too).
     --motion: the camera also makes a small grey picture (64 x 36) each frame, sent along for
     Sentry mode to measure movement on (in night vision's Automatic it's made here instead).
     --imu: its motion sensor's readings too (a camera that has one): accelerometer (m/s²) and
     gyroscope (rad/s), IMU_HZ a second, each frame bringing those since the last as "imu":
     [[when (ms since 1970, on this computer's clock), ax, ay, az, gx, gy, gz]], on the sensor's
     own axes.
     --no-hands: no hand tracking (Sentry mode, while it doesn't track hands): none of the hands'
     models run on the camera, only its picture (the same size) and what else is asked for;
     each frame's "hands" is empty. The depth cameras run only for an object's distance or the
     depth picture.
     --night: night vision, on a camera with an infrared light (OAK-D Pro, OAK-D Pro W): its
     infrared flood light on, and its black-and-white left camera's picture instead of the colour
     one's, for everything (the hands, objects, Sentry's motion, depth lined up with it). auto: on
     once it's been too dark for the colour camera for a few seconds, off once it's been light
     again for a while (the camera is started again each time, a few seconds); the "running"
     status says which ("night"). A camera without an infrared light stays in colour.
     --ir-dots: the infrared dot projector on (a camera with one), in colour or night vision:
     better depth, in the dark too, but a pattern of dots on the black-and-white pictures (night
     vision's, left / right; the colour camera doesn't see them).)
    python oak_bridge.py --check        prints the versions it would use
    python oak_bridge.py --list         prints the OAK cameras found
    python oak_bridge.py --simulate     no camera: a moving synthetic hand, for testing

Output on stdout, one message after another: the 4 bytes "HTK1", a 4-byte little-endian
length and that many bytes of JSON, then a 4-byte length and that many bytes of JPEG (0 for
none). The JSON is
{"status": ...} or a frame: {"t", "u" (when the camera took it: ms since 1970 on this computer's
clock), "w", "h", "fps", "hands": [{"lm": [[x, y, z]] (0-1 of the
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


def host_grey(jpeg, frame):
    """The small grey picture made here rather than on the camera (see add_extras): from the
    camera's JPEG, decoded at an eighth of its size, or from its picture. None if there's neither."""
    import cv2
    import numpy as np

    if jpeg:
        g = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_REDUCED_GRAYSCALE_8)
    elif frame is not None and frame.size:
        g = frame if frame.ndim == 2 else cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    else:
        return None
    return None if g is None else cv2.resize(g, MOTION_SIZE, interpolation=cv2.INTER_AREA)


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


DEPTH_VIEWS = ("depth", "blend", "side")  # the pictures made with the depth picture
MONO_VIEWS = ("left", "right")  # a black-and-white camera's picture, for everything


def view_picture(view, colour, depth):
    """The picture for blend (the depth picture over the colour one, half see-through where the
    depth is known) or side (the two side by side) from the colour picture (or a black-and-white
    one) and the depth picture, the same size."""
    import cv2
    import numpy as np

    if colour.ndim == 2 or colour.shape[2] == 1:
        colour = cv2.cvtColor(colour, cv2.COLOR_GRAY2BGR)
    if depth.shape[:2] != colour.shape[:2]:
        depth = cv2.resize(depth, (colour.shape[1], colour.shape[0]), interpolation=cv2.INTER_NEAREST)
    if view == "side":
        return np.hstack([colour, depth])
    # (cv2's own masked copy: numpy's indexing by a mask took ~50 ms a picture on a Pi 5)
    out = colour.copy()
    cv2.copyTo(cv2.addWeighted(colour, 0.5, depth, 0.5, 0), cv2.cvtColor(depth, cv2.COLOR_BGR2GRAY), out)
    return out


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


# Night vision (--night): the left black-and-white camera at 720P, the colour picture's shape, by
# the camera's infrared flood light. At half its most, a dark room's picture needed ISO 103
# instead of 1549 (an OAK-D Pro W). Automatic goes by the colour camera: dark once it's at its
# highest sensitivity (its exposure is at its longest by then) for NIGHT_AFTER_S; light again once
# its exposure times its sensitivity is under LIGHT_AT (a fifth brighter than its limit at 30 ms)
# for DAY_AFTER_S, looked at a few times a second while night vision is on (the infrared light
# doesn't get through its filter). A normally lit room needs ISO ~1300 at 30 ms (39,000): it
# stays in colour, but once in night vision it stays there.
NIGHT_SIZE = (1280, 720)
NIGHT_FLOOD = 0.5
IR_DOTS = 0.5
DARK_ISO = 1500
LIGHT_AT = 36000
NIGHT_AFTER_S, DAY_AFTER_S = 8, 20
NIGHT_METER_FPS = 10


def has_infrared(device):
    try:
        return bool(device.getIrDrivers())
    except Exception:
        return False


def set_infrared(device, night, dots):
    """The infrared flood light on with night vision, else off; the dot projector on whenever it's
    asked for, day or night (the depth cameras see its dots, the colour camera doesn't)."""
    try:
        device.setIrFloodLightIntensity(NIGHT_FLOOD if night else 0.0)
        device.setIrLaserDotProjectorIntensity(IR_DOTS if dots else 0.0)
    except Exception as err:
        print(f"Infrared light: {err}", file=sys.stderr)


def night_geometry(t):
    """A tracker's picture size and padding for night vision's camera (1280 x 720)."""
    t.img_w, t.img_h = NIGHT_SIZE
    t.frame_size = t.img_w
    t.pad_w, t.pad_h = 0, (t.img_w - t.img_h) // 2
    t.crop_w = 0


class NightCamera:
    """Night vision's camera as the trackers take a camera (its preview and video): the left
    (or, for --picture right, the right) black-and-white camera at 720P (its picture is grey; the hands' models get their crops of it
    as colour). With meter, the colour camera runs too, a few times a second at a tiny size, only
    to tell when it's light again (its pictures' exposure, on the "meter" stream)."""

    def __init__(self, dai, pipeline, fps, meter, socket=None):
        self.night = True
        self.meter = meter
        self.resolution = dai.MonoCameraProperties.SensorResolution.THE_720_P
        self.socket = socket if socket is not None else dai.CameraBoardSocket.LEFT
        self.mono = pipeline.createMonoCamera()
        self.mono.setBoardSocket(self.socket)
        self.mono.setResolution(self.resolution)
        self.mono.setFps(fps)
        # Its one output feeds everything the colour camera's two do (the video, and each model's
        # crop, which holds a picture while it waits for its instructions): with its usual 3
        # pictures, far-away hands' four took them all and it stopped after a few frames.
        self.mono.setNumFramesPool(10)
        self.preview = self.video = self.mono.out
        if meter:
            colour = pipeline.createColorCamera()
            colour.setResolution(dai.ColorCameraProperties.SensorResolution.THE_1080_P)
            colour.setBoardSocket(dai.CameraBoardSocket.RGB)
            colour.setPreviewSize(64, 36)
            colour.setFps(NIGHT_METER_FPS)
            x = pipeline.createXLinkOut()
            x.setStreamName("meter")
            x.input.setBlocking(False)
            x.input.setQueueSize(1)
            colour.preview.link(x.input)


IMU_HZ = 100  # the motion sensor's readings a second (--imu)

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
    if extras.get("picture") in DEPTH_VIEWS and stereo is not None:
        tracker.max_disparity = stereo.initialConfig.getMaxDisparity()
        out("pic_out", stereo.disparity)
    if extras.get("imu"):
        # Every reading kept (a few to a message), unlike the pictures, of which only the last is.
        imu = pipeline.create(dai.node.IMU)
        imu.enableIMUSensor([dai.IMUSensor.ACCELEROMETER_RAW, dai.IMUSensor.GYROSCOPE_RAW], IMU_HZ)
        imu.setBatchReportThreshold(5)
        imu.setMaxBatchReports(20)
        x = pipeline.create(dai.node.XLinkOut)
        x.setStreamName("imu_out")
        x.input.setBlocking(False)
        x.input.setQueueSize(8)
        imu.out.link(x.input)
        tracker.extra_streams.append("imu_out")
    if extras.get("motion") and getattr(cam, "meter", False):
        # Night vision's Automatic (its colour camera running alongside, to tell when it's light
        # again): with the small picture made on the camera too, every picture stopped after 153
        # (about 5 s), then X_LINK_ERROR, each time (an OAK-D-PRO-W on a Pi 5, depthai 2.30; not
        # with night vision On, nor without the small picture). So it's made here from each
        # picture instead (host_grey).
        tracker.host_motion = True
    elif extras.get("motion"):
        small = pipeline.create(dai.node.ImageManip)
        small.initialConfig.setResize(*MOTION_SIZE)
        small.initialConfig.setFrameType(dai.ImgFrame.Type.GRAY8)
        small.setMaxOutputFrameSize(MOTION_SIZE[0] * MOTION_SIZE[1])
        small.inputImage.setQueueSize(1)
        small.inputImage.setBlocking(False)
        cam.preview.link(small.inputImage)
        out("motion_out", small.out)


class PictureOnly:
    """The camera without hand tracking (--no-hands): its colour picture, the same size as the
    hand tracker's (and as JPEG from its own encoder or not, as that one), and the extras
    asked for alongside (add_extras); none of the hands' models run, leaving the camera's
    processor to the rest. It's what stream() and run() use of a tracker; its frames have no
    hands. The depth cameras run only for something that uses them (an object's distance, the
    depth picture), and the frame rate is the one asked for, else 30 (at most 30 alongside the
    depth cameras or the object finder, as Sentry mode's videos are)."""

    RESOLUTION = (1920, 1080)

    def __init__(self, dai, device, extras, fps=None, depth=False, mjpeg=False, frame_height=640, night=False, meter=False, mono=None):
        import mediapipe_utils as mpu

        self.device = device
        self.mjpeg = mjpeg
        self.jpeg = None
        self.video_msg = None
        self.xyz = False  # (no hands to measure)
        self.night, self.meter = night, meter
        # (night vision's left camera, or a black-and-white camera's view: that one)
        self.mono = mono if mono is not None else dai.CameraBoardSocket.LEFT if night else None
        sw, sh = self.RESOLUTION
        _, self.scale_nd = mpu.find_isp_scale_params(frame_height * sw / sh, self.RESOLUTION, is_height=False)
        self.img_h = int(round(sh * self.scale_nd[0] / self.scale_nd[1]))
        self.img_w = int(round(sw * self.scale_nd[0] / self.scale_nd[1]))
        if self.mono is not None:
            night_geometry(self)
        cameras = device.getConnectedCameras()
        self.has_depth = bool(depth and dai.CameraBoardSocket.LEFT in cameras and dai.CameraBoardSocket.RIGHT in cameras)
        self.stereo = self.has_depth and bool(extras.get("detect") or extras.get("picture") in DEPTH_VIEWS)
        self.internal_fps = min(fps or 30, 30) if self.stereo or extras.get("detect") else fps or 30
        device.startPipeline(self.create_pipeline(dai, extras))
        self.q_video = device.getOutputQueue(name="cam_out", maxSize=1, blocking=False)

    def create_pipeline(self, dai, extras):
        pipeline = dai.Pipeline()
        pipeline.setOpenVINOVersion(version=dai.OpenVINO.Version.VERSION_2021_4)
        if self.mono is not None:
            cam = NightCamera(dai, pipeline, self.internal_fps, self.meter, self.mono)
        else:
            cam = pipeline.createColorCamera()
            cam.setResolution(dai.ColorCameraProperties.SensorResolution.THE_1080_P)
            cam.setBoardSocket(dai.CameraBoardSocket.RGB)
            cam.setInterleaved(False)
            cam.setIspScale(self.scale_nd[0], self.scale_nd[1])
            cam.setFps(self.internal_fps)
            cam.setVideoSize(self.img_w, self.img_h)
            cam.setPreviewSize(self.img_w, self.img_h)
        cam_out = pipeline.createXLinkOut()
        cam_out.setStreamName("cam_out")
        cam_out.input.setQueueSize(1)
        cam_out.input.setBlocking(False)
        if self.mjpeg:
            encoder = pipeline.create(dai.node.VideoEncoder)
            encoder.setDefaultProfilePreset(self.internal_fps, dai.VideoEncoderProperties.Profile.MJPEG)
            encoder.setQuality(80)
            cam.video.link(encoder.input)
            encoder.bitstream.link(cam_out.input)
        else:
            cam.video.link(cam_out.input)
        stereo = None
        if self.stereo:
            # As the hand tracker sets them up: the colour camera at its calibrated focus, so the
            # depth lines up with its picture (night vision, or a black-and-white camera's view:
            # that camera is its camera, at its size, and the depth lines up with that).
            mono = self.mono is not None
            if mono:
                resolution = cam.resolution
            else:
                cam.initialControl.setManualFocus(self.device.readCalibration().getLensPosition(dai.CameraBoardSocket.RGB))
                resolution = dai.MonoCameraProperties.SensorResolution.THE_400_P

            def mono_camera(socket):
                if mono and cam.socket == socket:
                    return cam.mono
                m = pipeline.createMonoCamera()
                m.setBoardSocket(socket)
                m.setResolution(resolution)
                m.setFps(self.internal_fps)
                return m

            left, right = mono_camera(dai.CameraBoardSocket.LEFT), mono_camera(dai.CameraBoardSocket.RIGHT)
            stereo = pipeline.createStereoDepth()
            stereo.setConfidenceThreshold(230)
            stereo.setLeftRightCheck(True)
            stereo.setDepthAlign(cam.socket if mono else dai.CameraBoardSocket.RGB)
            stereo.setSubpixel(False)
            left.out.link(stereo.left)
            right.out.link(stereo.right)
        add_extras(dai, pipeline, cam, stereo, extras, self)
        return pipeline

    def next_frame(self):
        import numpy as np

        frame = self.q_video.get()
        self.video_msg = frame  # (how dark it is, from its exposure: night vision's Automatic)
        if self.mjpeg:
            self.jpeg = bytes(frame.getData())
            return np.empty((self.img_h, self.img_w, 0), dtype=np.uint8), [], None
        return frame.getCvFrame(), [], None

    def exit(self):
        self.device.close()


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
    status("running", camera="Simulated OAK camera", width=w, height=h, depth=True, depthCameras=True, detect=bool(args.detect), picture=args.picture, motion=bool(args.motion),
           hands=not args.no_hands, night=False, infrared=False,
           warning="This camera has no infrared light, so it can't use night vision." if args.night == "on" else None)
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
        # The synthetic hand is a right hand as MediaPipe labels it for a camera facing you
        # (in the picture either way: with --no-hands it isn't looked for).
        if not args.no_hands:
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
CRASH_MESSAGE = "The OAK camera's own software crashed (not its cable or its USB)."
CRASHED = 6  # the exit code then


def crash_reports():
    """The crash reports depthai has kept ({ path: when }): it writes one when it closes a camera
    whose own software crashed, so a new one says the camera crashed rather than its USB link
    dropping (both reach here as the same X_LINK_ERROR). Its folder: DEPTHAI_CRASHDUMP if set, else
    its cache's (on Linux ~/.cache/depthai/crashdumps)."""
    home = os.path.expanduser("~")
    folders = [os.environ.get("DEPTHAI_CRASHDUMP", ""),
               os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.join(home, ".cache"), "depthai", "crashdumps"),
               os.path.join(os.environ.get("LOCALAPPDATA", ""), "depthai", "crashdumps") if os.environ.get("LOCALAPPDATA") else "",
               os.path.join(home, "Library", "Caches", "depthai", "crashdumps")]
    found = {}
    for folder in filter(os.path.isdir, folders):
        for root, _, files in os.walk(folder):
            for name in files:
                if name.endswith(".json"):
                    try:
                        found[os.path.join(root, name)] = os.path.getmtime(os.path.join(root, name))
                    except OSError:
                        pass
    return found


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
    hands = not args.no_hands
    need = ["palm_detection_sh4.blob", f"hand_landmark_{args.lm}_sh4.blob", "PDPostProcessing_top2_sh1.blob"] if hands else []
    if args.far and hands:
        need.append("movenet_singlepose_lightning_U8_transpose.blob")
    missing = [m for m in need if not os.path.isfile(os.path.join(models, m))]
    if missing:
        status("error", message="The OAK models are missing (" + ", ".join(missing) + "). Run the OAK setup again.")
        return 2

    # The hand models compiled for 6 of the camera's cores where they're downloaded (electron/
    # oak.js FAST_MODELS: the same outputs, found faster), else the 4-core ones.
    def model(name):
        six = os.path.join(models, f"{name}_sh6.blob")
        return six if os.path.isfile(six) else os.path.join(models, f"{name}_sh4.blob")

    pd_model, lm_model = model("palm_detection"), model(f"hand_landmark_{args.lm}")
    fast = lm_model.endswith("_sh6.blob")
    warnings = []
    detect = os.path.join(models, DETECT_MODEL) if args.detect else None
    if detect and not os.path.isfile(detect):
        warnings.append("The object finder's model isn't downloaded, so objects aren't found.")
        detect = None
    extras = {"detect": detect, "picture": args.picture, "motion": args.motion, "imu": False}

    import depthai as dai

    common = dict(
        pd_model=pd_model,
        lm_model=lm_model,
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
        def __init__(self, night=False, mono=None, **kw):
            self.night = night
            # (night vision's left camera, or a black-and-white camera's view: that one)
            self.mono = mono if mono is not None else dai.CameraBoardSocket.LEFT if night else None
            super().__init__(**kw)

        # Night vision, or a black-and-white camera's view: its camera (NightCamera) and its
        # picture's size, in the colour camera's place.
        def camera_geometry(self):
            if self.mono is not None:
                night_geometry(self)

        def create_night_camera(self, pipeline):
            if self.mono is None:
                return None
            return NightCamera(dai, pipeline, self.internal_fps, meter=self.night and args.night == "auto", socket=self.mono)

        # Objects, the depth picture and the motion picture, alongside the hands (add_extras).
        def extend_pipeline(self, pipeline, cam, stereo):
            add_extras(dai, pipeline, cam, stereo, extras, self)

        # The camera's frame rate: one the camera's processor keeps up with, given all it's
        # asked to do. Asked for more, it starts frames it can't finish and slows right down.
        # Measured on an OAK-D-PRO-W (Pi 5), full model and two hands, with depth and objects
        # (a look at every frame then): 60 asked -> 4.7 a second, 39 -> 6.6, 15 -> 11.7. With
        # objects looked for 3 times a second, 20 -> 20.0 and 25 -> 22.9 (depth only: 25 ->
        # 20.0, 30 -> 17.8). Its rates vary with what's in view: 24 was never far off the best.
        # With the 6-core models, side by side at 24: 23.7 and 23.5 (4-core: 19.6, 22.6; 8-core:
        # 21.4, 20.7), and asked for more, 24 -> 19.5, 18.4; 28 -> 18.8, 22.4; 32 -> 22.5, 24.7.
        # (The lite model's rates are the tracker's own.) 60 asked for holds only where nothing
        # else shares the processor: no depth, no objects.
        def pick_fps(self, asked, depth):
            busy = depth or extras.get("detect")
            if args.lm == "full":
                best = (30 if fast else 24) if busy else 26
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

    # Night vision's Automatic (auto): how dark it is, each frame. In colour, from the colour
    # camera's own pictures; in night vision, from its pictures on the "meter" stream. -> "night"
    # or "day" once it's time to change over, else None.
    def night_watch(tracker, night, auto):
        if not auto:
            return lambda: None
        meter = tracker.device.getOutputQueue(name="meter", maxSize=1, blocking=False) if night else None
        since = [None]

        def look():
            msg = meter.tryGet() if night else getattr(tracker, "video_msg", None)
            if msg is not None:
                try:
                    iso = msg.getSensitivity()
                    exposure = msg.getExposureTime().total_seconds() * 1000
                except Exception:
                    return None
                change = exposure * iso < LIGHT_AT if night else iso >= DARK_ISO
                since[0] = (since[0] or time.time()) if change else None
            if since[0] and time.time() - since[0] >= (DAY_AFTER_S if night else NIGHT_AFTER_S):
                return "day" if night else "night"
            return None

        return look

    def stream(tracker, mjpeg, watch=lambda: None):
        depth = bool(getattr(tracker, "xyz", False))
        t0 = time.time()
        last = time.time()
        frames = 0
        fps = 0.0
        queues = {name: tracker.device.getOutputQueue(name=name, maxSize=50 if name == "imu_out" else 1, blocking=False) for name in getattr(tracker, "extra_streams", [])}
        objects, objects_at = [], 0.0
        picture = None
        view = extras.get("picture")
        depth_now = None  # (blend, side: the last depth picture)
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
            elif getattr(tracker, "host_motion", False):
                small = host_grey(tracker.jpeg if mjpeg else None, frame)
                if small is not None:
                    grey = grey_text(small)
            if "pic_out" in queues:
                disparity = queues["pic_out"].tryGet()
                if disparity is not None:
                    depth_now = depth_picture(disparity.getFrame(), tracker.max_disparity, w, h)
                    if view == "depth":
                        picture = encode(depth_now)
                if view in ("blend", "side") and depth_now is not None:
                    import cv2

                    colour = cv2.imdecode(np.frombuffer(tracker.jpeg, np.uint8), cv2.IMREAD_COLOR) if mjpeg else frame
                    if colour is not None and colour.size:
                        picture = encode(view_picture(view, colour, depth_now))
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
            # When the camera took the picture, in ms since 1970 (its own timestamp, on this
            # computer's clock): the app lines cameras up by it.
            msg = getattr(tracker, "video_msg", None)
            if msg is not None:
                try:
                    header["u"] = round((time.time() - (dai.Clock.now() - msg.getTimestamp()).total_seconds()) * 1000, 1)
                except Exception:
                    pass
            if "det_out" in queues:
                header["objects"] = objects
            if grey:
                header["grey"] = grey  # (only when the camera made a new one)
            if "imu_out" in queues:
                readings = []
                for m in queues["imu_out"].tryGetAll():
                    for p in m.packets:
                        a, g = p.acceleroMeter, p.gyroscope
                        try:
                            u = (time.time() - (dai.Clock.now() - a.getTimestamp()).total_seconds()) * 1000
                        except Exception:
                            u = time.time() * 1000
                        readings.append([round(u, 1)] + [round(float(v), 4) for v in (a.x, a.y, a.z, g.x, g.y, g.z)])
                if readings:
                    header["imu"] = readings
            jpeg = picture if "pic_out" in queues and picture else tracker.jpeg if mjpeg else encode(frame)
            send(header, jpeg)
            change = watch()
            if change:
                return change
        return None

    usb2 = Usb2Cameras(models)
    wanted, retried = args.device, False
    night = args.night == "on"
    view = args.picture
    imu_tried = False  # (once it's failed to start, it isn't tried again)
    while True:
        device, high = None, retried
        reports = crash_reports()  # (those from before this start)
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
            cameras = device.getConnectedCameras()
            infrared = has_infrared(device) and dai.CameraBoardSocket.LEFT in cameras
            if args.imu and not imu_tried:
                try:
                    extras["imu"] = str(device.getConnectedIMU()).upper() not in ("", "NONE")
                except Exception:
                    extras["imu"] = False
            if night and not infrared:
                night = False
                if args.night == "on":
                    warnings.append("This camera has no infrared light, so it can't use night vision.")
            # A black-and-white camera's view: that camera, for everything (night vision's light
            # only if it's on; Automatic doesn't switch here).
            mono = None
            if view in MONO_VIEWS:
                socket = dai.CameraBoardSocket.LEFT if view == "left" else dai.CameraBoardSocket.RIGHT
                if socket in cameras:
                    mono = socket
                    night = night and args.night == "on"
                else:
                    warnings.append("This camera has no black-and-white cameras, so its colour picture is shown.")
                    view = extras["picture"] = "color"
            if hands:
                tracker = Tracker(**common, **extra, device=device, mjpeg=mjpeg, night=night, mono=mono)
            else:
                tracker = PictureOnly(dai, device, extras, fps=args.fps, depth=args.xyz, mjpeg=mjpeg, night=night, meter=night and args.night == "auto", mono=mono)
            if infrared:
                set_infrared(device, night, args.ir_dots)
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
            if extras.get("imu"):
                # The motion sensor wouldn't start with the rest: started again without it.
                extras["imu"] = False
                imu_tried = True
                warnings.append("Its motion sensor couldn't run alongside the rest, so it isn't read.")
                status("starting", message="Starting the OAK camera again without its motion sensor…")
                time.sleep(2)  # until the camera is let go
                continue
            if extras["detect"]:
                # Finding objects as well may be more than the camera's processor can take with the
                # hands' models (or its model may not load): started again without it.
                extras["detect"] = None
                alongside = " alongside the hand tracking" if hands else ""
                warnings.append(f"Finding objects couldn't run{alongside} on this camera ({text.splitlines()[0][:160] if text else 'no reason given'}).")
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
        # (whether it has depth cameras at all; "depth" says whether they're in use)
        stereo = dai.CameraBoardSocket.LEFT in cameras and dai.CameraBoardSocket.RIGHT in cameras
        if view in DEPTH_VIEWS and "pic_out" not in streams:
            warnings.append("Depth is off, so its usual picture is shown: turn Depth on for the depth picture." if stereo else
                            "This camera has no depth cameras, so its colour picture is shown.")
            view = "color"
        status("running", camera=getattr(getattr(tracker, "device", None), "getDeviceName", lambda: "OAK camera")(), width=tracker.img_w, height=tracker.img_h,
               depth=bool(getattr(tracker, "xyz", False) or getattr(tracker, "has_depth", False)), depthCameras=stereo, id=device.getMxId(), usb=usb, jpeg="camera" if mjpeg else "computer",
               detect="det_out" in streams, picture=view, motion="motion_out" in streams or getattr(tracker, "host_motion", False), imu="imu_out" in streams, hands=hands,
               night=night, infrared=infrared, warning=" ".join(dict.fromkeys(warnings)) or None)
        if retried:
            usb2.add(wanted)
        change = None
        try:
            change = stream(tracker, mjpeg, night_watch(tracker, night, args.night == "auto" and infrared and mono is None))
        except (BrokenPipeError, KeyboardInterrupt):
            pass
        except RuntimeError:
            # Closed first: depthai keeps a crashed camera's report as it closes it.
            try:
                tracker.exit()
            except Exception:
                pass
            new = []
            for _ in range(7):  # (written as it closes; given up to 3 s more)
                new = [p for p, at in crash_reports().items() if reports.get(p) != at]
                if new:
                    break
                time.sleep(0.5)
            if new:
                # Its own software crashed: not its USB (so not USB 2 from now on); the app may
                # start it again.
                status("error", message=CRASH_MESSAGE, crashed=True, report=new[0])
                return CRASHED
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
        if change:
            # Night vision's Automatic: started again the other way (the camera resets first).
            night = change == "night"
            status("starting", message="It's dark: switching to night vision…" if night else "It's light again: switching back to colour…")
            continue
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
    ap.add_argument("--picture", choices=["color", "depth", "left", "right", "blend", "side"], default="color",
                    help="the picture sent: colour, depth, the two blended or side by side (depth cameras), or a black-and-white camera's")
    ap.add_argument("--motion", action="store_true", help="a small grey picture (64 x 36) with each frame, for Sentry mode")
    ap.add_argument("--imu", action="store_true", help="its motion sensor's readings too (accelerometer, gyroscope)")
    ap.add_argument("--no-hands", action="store_true", help="no hand tracking: only the picture and what else is asked for (Sentry mode)")
    ap.add_argument("--night", choices=["auto", "on", "off"], default="off", help="night vision by the camera's infrared light (OAK-D Pro)")
    ap.add_argument("--ir-dots", action="store_true", help="the infrared dot projector on, day or night (better depth; dots on the black-and-white pictures)")
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
