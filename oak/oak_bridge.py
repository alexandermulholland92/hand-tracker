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
                         [--mjpeg auto|on|off]
    (--device: which OAK camera, by its id from --list; the first one found otherwise.
     --mjpeg: the camera sends its pictures as JPEG from its own encoder, about a tenth of the
     data; auto: over USB 2, where the raw pictures of one camera nearly fill the link, and on
     ARM boards such as a Raspberry Pi, where it also saves the processor encoding them.)
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
camera (x right, y down, z forward) or null, "gesture"}]}.
Anything else the tracker prints goes to stderr.
"""

import argparse
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
    status("devices", devices=found)


def simulate(args):
    """A synthetic hand moving across a plain picture: tests the whole path without a camera."""
    import numpy as np

    w, h = 1152, 648
    base = [(0, 0), (-.04, -.03), (-.08, -.07), (-.11, -.10), (-.13, -.13), (-.035, -.12), (-.04, -.17), (-.043, -.20), (-.045, -.23),
            (0, -.125), (0, -.18), (0, -.215), (0, -.245), (.03, -.115), (.035, -.165), (.038, -.195), (.04, -.22), (.055, -.10), (.065, -.135), (.07, -.16), (.075, -.18)]
    status("running", camera="Simulated OAK camera", width=w, height=h, depth=True)
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
        try:
            import cv2

            cv2.putText(img, f"simulated {n}", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1, (200, 200, 200), 2)
            for x, y, _ in lm:
                cv2.circle(img, (int(x * w), int(y * h)), 4, (80, 200, 255), -1)
            jpeg = encode(img)
        except ImportError:
            jpeg = b""
        # The synthetic hand is a right hand as MediaPipe labels it for a camera facing you.
        send({"t": round(t * 1000, 1), "w": w, "h": h, "fps": 30, "hands": [
            {"lm": lm, "world": world, "label": "Left", "anatomical": False, "score": 0.97, "lm_score": 0.95, "xyz": [120.0, -40.0, 850.0], "gesture": "FIVE"}]}, jpeg)
        n += 1
        time.sleep(1 / 30)
        if args.frames and n >= args.frames:
            break


def open_device(dai, wanted):
    """Opens the OAK camera with that id, or the first one found (None if there's none). A
    camera that can't keep a USB 3 link (its cable or its port) boots but never comes back
    ("Failed to find device after booting"); Luxonis's advice is USB 2, so it's started again
    that way. (Seen with an OAK-1 Lite W on a Raspberry Pi 5: USB 3 failed every time, USB 2
    started it in 2 s.)"""
    # A camera that was just in use resets first (a few seconds): wait for it.
    deadline = time.time() + 10
    while True:
        devices = [d for d in dai.Device.getAllAvailableDevices() if not wanted or d.getMxId() == wanted]
        if devices or time.time() > deadline:
            break
        time.sleep(0.5)
    if not devices:
        return None
    info = devices[0]
    try:
        return dai.Device(info, dai.UsbSpeed.SUPER)
    except RuntimeError as err:
        if "X_LINK_DEVICE_NOT_FOUND" not in str(err) and "after booting" not in str(err):
            raise
    mxid = info.getMxId()
    status("starting", message="The OAK camera didn't come back in USB 3 mode: starting it in USB 2 mode.")
    deadline = time.time() + 20
    while time.time() < deadline:
        found, again = dai.Device.getDeviceByMxId(mxid)
        if found:
            return dai.Device(again, dai.UsbSpeed.HIGH)
        time.sleep(0.5)
    raise RuntimeError("X_LINK_DEVICE_NOT_FOUND: the camera didn't come back after a failed start")


def run(args):
    models = args.models
    need = ["palm_detection_sh4.blob", f"hand_landmark_{args.lm}_sh4.blob", "PDPostProcessing_top2_sh1.blob"]
    if args.far:
        need.append("movenet_singlepose_lightning_U8_transpose.blob")
    missing = [m for m in need if not os.path.isfile(os.path.join(models, m))]
    if missing:
        status("error", message="The OAK models are missing (" + ", ".join(missing) + "). Run the OAK setup again.")
        return 2

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
        # Landmarks with their fractions of a pixel kept (the original rounds them).
        def extract_hand_data(self, res, hand_idx):
            hand = super().extract_hand_data(res, hand_idx)
            lm = np.array(res["sqn_lms"][hand_idx], dtype=np.float64).reshape(-1, 2) * self.frame_size
            lm[:, 0] -= self.pad_w
            lm[:, 1] -= self.pad_h
            hand.landmarks_f = lm
            return hand

    device = None
    try:
        device = open_device(dai, args.device)
        if device is None:
            status("error", message="That OAK camera wasn't found: it may have been unplugged." if args.device else
                   "No OAK camera found. Check it's plugged in (a USB 3 port is best) and not in use by another program.")
            return 3
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
            device.close()
        text = str(err)
        if sys.platform.startswith("linux") and any(k in text.lower() for k in ("permission", "udev")):
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

    depth = bool(getattr(tracker, "xyz", False))
    status("running", camera=getattr(getattr(tracker, "device", None), "getDeviceName", lambda: "OAK camera")(), width=tracker.img_w, height=tracker.img_h, depth=depth,
           id=device.getMxId(), usb=usb, jpeg="camera" if mjpeg else "computer")
    t0 = time.time()
    last = time.time()
    frames = 0
    fps = 0.0
    try:
        while True:
            frame, hands, _ = tracker.next_frame()
            if frame is None:
                break
            h, w = frame.shape[:2]
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
            send({"t": round((now - t0) * 1000, 1), "w": w, "h": h, "fps": round(fps, 1), "hands": out}, tracker.jpeg if mjpeg else encode(frame))
    except (BrokenPipeError, KeyboardInterrupt):
        pass
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
