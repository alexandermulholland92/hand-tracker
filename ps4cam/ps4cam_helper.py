"""
ps4cam_helper.py — the PlayStation 4 camera (CUH-ZEY1, CUH-ZEY2: two lenses side by side) for Hand
Tracker (electron/ps4cam.js runs it, with the Python of the app's OAK support). The camera plugs
into USB 3 through an adapter, and starts in a mode that only takes its firmware (OmniVision OV580,
USB 05a9:0580): this sends it (Sony's firmware.bin, the one the person chose; it isn't the app's to
ship), the camera starts again as a webcam (05a9:058a, or 058b with another version of the firmware), and its pictures are read: both lenses'
pictures side by side in each frame. From them it makes the picture the tile shows (one lens, the
two side by side, red/cyan 3D, laid over each other, merged into one, or their depth) and the
depth for each part of the left lens's picture, on which the page finds the hands.

    python ps4cam_helper.py --check            {status: "check", python, opencv, usb}
    python ps4cam_helper.py --list             {status: "devices", devices: [{id, name, ready}]}
    python ps4cam_helper.py --device <id> --firmware <file> [--size 1280x800|640x400] [--fps <n>]
        [--view <view>] [--depth] [--night auto|on|off] [--quality <jpeg>] [--ffmpeg <path>] [--paced]
    python ps4cam_helper.py --simulate ...     no camera: made-up stereo pictures, for testing

--paced: a frame made only when one's asked for ("next" on stdin; the first without), so none is
made that the app would only drop: the app asks as it takes each one in, so the next is ready when
it's done with that one.

An id is the camera's USB port ("4-1" on Linux, "1-3" on Windows: the bus and its ports). Views:
left, right, side (the two side by side), anaglyph (red/cyan 3D), blend (laid over each other,
half see-through), merged (the right lens's picture moved onto the left's by its depth and the two
put together: one solid picture, less grainy), depth, depth-blend (laid over the picture),
depth-side (beside it). Commands on stdin, one a line: "view <view>", "depth on|off",
"night auto|on|off", "next" (--paced), "quit".

Output on stdout: oak_bridge.py's messages ("HTK1", a u32 length and that much JSON, then a u32
length and that many bytes, little-endian). A frame: {kind: "frame", seq, t, u (ms since 1970,
when it came), w, h, fps, view, night, dark, image: {fx, fy, cx, cy}, map: {w, h, fx, fy, cx, cy}
(with depth), parts: {jpeg: [at, length], shown, depth}}: jpeg is the left lens's picture (the
hands are found on it), shown the picture the view makes (only when it isn't that one; with the
views that have the left lens's picture as their left half, or are it made better, merged, only
shown is sent, and the hands are found on that), depth a u16 a point, millimetres (0: not known),
lined up with the left lens's picture.
"""

import argparse
import glob
import json
import os
import platform
import queue
import re
import struct
import subprocess
import sys
import threading
import time

OUT = os.fdopen(os.dup(1), "wb", buffering=0)
os.dup2(2, 1)
sys.stdout = sys.stderr
MAGIC = b"HTK1"

VENDOR, BOOT = 0x05A9, 0x0580
CAMERAS = (0x058A, 0x058B)  # (as a camera: the firmware's versions give it either)
# Its picture sizes (each lens's): the frame the camera sends for it (both lenses' pictures and
# smaller copies of them side by side, a header before them in every row), and its frame rates.
MODES = {"1280x800": ((3448, 808), (60, 30, 15, 8)), "640x400": ((1748, 408), (120, 60, 30, 15, 8)), "320x192": ((898, 200), (240, 120, 60, 30))}
FIRST_X = 48  # the first lens's picture, from this column of each row; the second's right after it
TOP = 0  # its first row
# Its lenses (the first picture in a row is the right lens's, as the camera looks: a near thing is
# further right in the second), apart by BASELINE_MM, with a focal length of FOCAL_640 pixels in
# a 640-wide picture: a calibration of one (the ps4eye ROS package's; measured on pi too).
BASELINE_MM = 78.6
FOCAL_640 = 415.0
# The depth shown as colours (near red, far blue), and the nearest it can tell (its depth search's
# reach); the depth is worked out on the pictures made DEPTH_W wide (a hand's distance to about
# 5 mm at 1 m: the search goes to a sixteenth of a pixel).
NEAR_MM, FAR_MM = 300, 3000
DEPTH_W = 320
DAY_GAIN, NIGHT_GAIN = 4, 8
VIEWS = ("left", "right", "side", "anaglyph", "blend", "merged", "depth", "depth-blend", "depth-side")
NEEDS_DEPTH = ("merged", "depth", "depth-blend", "depth-side")
# Views whose picture has the left lens's own as its left half, or is that lens's picture made
# better (merged): the hands are found on it, so the left lens's isn't sent as well.
HAS_LEFT = ("side", "depth-side", "merged")


def send(header, data=b""):
    body = json.dumps(header, separators=(",", ":")).encode("utf-8")
    OUT.write(MAGIC + struct.pack("<I", len(body)) + body + struct.pack("<I", len(data)) + data)


def status(state, **extra):
    send({"status": state, **extra})


# ---------- the camera on USB ----------
def usb_backend():
    """pyusb's libusb: the one beside the app's Python (libusb-package), else the system's."""
    try:
        import libusb_package
        return libusb_package.get_libusb1_backend()
    except Exception:
        return None


def port_of(dev):
    return f"{dev.bus}-{'.'.join(str(p) for p in (dev.port_numbers or ()))}"


def cameras():
    """The PS4 cameras plugged in: [{"id": its USB port, "ready": a camera now (its firmware sent)}]."""
    found = []
    if sys.platform.startswith("linux"):
        for d in sorted(glob.glob("/sys/bus/usb/devices/*")):
            try:
                vid = int(open(os.path.join(d, "idVendor")).read(), 16)
                pid = int(open(os.path.join(d, "idProduct")).read(), 16)
            except (OSError, ValueError):
                continue
            if vid == VENDOR and pid in (BOOT, *CAMERAS):
                found.append({"id": os.path.basename(d), "ready": pid != BOOT})
        return found
    import usb.core
    for pid in (BOOT, *CAMERAS):
        for dev in usb.core.find(find_all=True, idVendor=VENDOR, idProduct=pid, backend=usb_backend()) or []:
            found.append({"id": port_of(dev), "ready": pid != BOOT})
    return found


def send_firmware(port, firmware):
    """Sends the camera in its start-up mode its firmware, 512 bytes at a time (a vendor request,
    the address carried in its value and index), then the request that starts it with it."""
    import usb.core
    import usb.util
    dev = next((d for d in usb.core.find(find_all=True, idVendor=VENDOR, idProduct=BOOT, backend=usb_backend()) or [] if port_of(d) == port), None)
    if dev is None:
        raise RuntimeError("The PS4 camera wasn't found in its start-up mode.")
    try:
        dev.set_configuration()
    except usb.core.USBError:
        pass  # (already set: Linux sets it when it's plugged in, and Windows' WinUSB can't)
    value, index = 0, 0x14
    for at in range(0, len(firmware), 512):
        dev.ctrl_transfer(0x40, 0, value, index, firmware[at:at + 512])
        value += 512
        if value >= 0x10000:
            value, index = 0, index + 1
    try:
        dev.ctrl_transfer(0x40, 0, 0x2200, 0x8018, b"\x5b")
    except usb.core.USBError:
        pass  # (it starts again at once, so its answer doesn't come)
    usb.util.dispose_resources(dev)


def wait_ready(port, seconds=20):
    end = time.time() + seconds
    while time.time() < end:
        if any(c["id"] == port and c["ready"] for c in cameras()):
            return True
        time.sleep(0.25)
    return False


def video_node(port):
    """Linux: the camera's picture device (/dev/videoN) once it's a camera."""
    for v in sorted(glob.glob("/sys/class/video4linux/video*"), key=lambda p: int(re.sub(r"\D", "", os.path.basename(p)) or 0)):
        try:
            iface = os.path.realpath(os.path.join(v, "device"))
            if os.path.basename(os.path.dirname(iface)) == port and open(os.path.join(v, "index")).read().strip() == "0":
                return "/dev/" + os.path.basename(v)
        except OSError:
            continue
    return None


def dshow_index(ffmpeg):
    """Windows: the camera's place among DirectShow's cameras (OpenCV opens them by their place),
    found by its name ("USB Camera-OV580") in ffmpeg's list of them."""
    out = subprocess.run([ffmpeg, "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], capture_output=True, text=True, timeout=20,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stderr
    videos = [m.group(1) for m in re.finditer(r'"([^"]+)" \(video\)', out)]
    return next((i for i, name in enumerate(videos) if "OV580" in name), None)


def open_capture(args, port, frame_size, fps):
    import cv2
    if sys.platform.startswith("linux"):
        node = None
        for _ in range(40):  # (its picture device comes a moment after it starts as a camera)
            node = video_node(port)
            if node:
                break
            time.sleep(0.25)
        if not node:
            raise RuntimeError("The PS4 camera started, but no picture device came for it.")
        cap = cv2.VideoCapture(node, cv2.CAP_V4L2)
        fourcc = "YUYV"
    else:
        index = None
        for _ in range(60):  # (the first time, Windows sets the camera up first)
            index = dshow_index(args.ffmpeg) if args.ffmpeg else None
            if index is not None:
                break
            time.sleep(0.5)
        if index is None:
            raise RuntimeError("The PS4 camera started, but Windows doesn't list it as a camera.")
        cap = cv2.VideoCapture(index, cv2.CAP_DSHOW)
        fourcc = "YUY2"
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*fourcc))
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, frame_size[0])
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, frame_size[1])
    cap.set(cv2.CAP_PROP_FPS, fps)
    # (Not one buffer: with one, a frame that comes while the last is being read is lost; on a Pi 5
    # that's 18 of 30 a second at 1280 x 800. Its frames are read as they come, on a thread of
    # their own, so none wait in the buffers.)
    if sys.platform.startswith("linux"):
        # Its frames as they come (YUYV), only the lenses' part of those that are used made BGR
        # (Pictures.split), not every frame whole.
        cap.set(cv2.CAP_PROP_CONVERT_RGB, 0)
    if not cap.isOpened():
        raise RuntimeError("The PS4 camera's pictures couldn't be opened.")
    return cap


class Simulated:
    """A made-up camera: a textured room, and a square near the lenses moving about (its depth
    known), in the camera's own frame layout."""

    def __init__(self, frame_size, fps):
        import numpy as np
        self.np, self.fps, self.n = np, fps, 0
        (self.fw, self.fh), self.next = frame_size, time.time()
        rng = np.random.default_rng(7)
        w, h = eye_size(self.fw)
        self.room = np.repeat((rng.random((h, w, 1)) * 200 + 30).astype(np.uint8), 3, axis=2)

    def read(self):
        np = self.np
        self.next += 1 / self.fps
        time.sleep(max(0, self.next - time.time()))
        self.n += 1
        w, h = eye_size(self.fw)
        frame = np.zeros((self.fh, self.fw, 3), np.uint8)
        x = int(w * (0.3 + 0.2 * np.sin(self.n / 20)))
        y, s, shift = h // 3, w // 6, max(4, w // 20)  # (the square's disparity: near)
        for i, dx in ((0, shift), (1, 0)):  # (the right lens's picture first: the square further left in it)
            eye = frame[TOP:TOP + h, FIRST_X + i * w:FIRST_X + (i + 1) * w]
            eye[:] = self.room
            eye[y:y + s, x - dx:x - dx + s] = (60, 160, 230)
        return True, frame

    def get(self, prop):
        return -1  # (no gain of its own)

    def set(self, prop, value):
        return False

    def release(self):
        pass


def eye_size(frame_w):
    return next(tuple(map(int, k.split("x"))) for k, (size, _) in MODES.items() if size[0] == frame_w)


# ---------- the pictures ----------
class Pictures:
    """Each frame's lens pictures, their depth, and the views made from them."""

    def __init__(self, w, h):
        import cv2
        import numpy as np
        self.cv2, self.np, self.w, self.h = cv2, np, w, h
        self.f = FOCAL_640 * w / 640  # (its focal length, in the picture's pixels)
        self.dw = min(w, DEPTH_W)
        self.dh = round(h * self.dw / w)
        self.df = self.f * self.dw / w
        reach = 16 * int(np.ceil(self.df * BASELINE_MM / NEAR_MM / 16))  # (disparities searched: down to NEAR_MM)
        self.reach = reach
        self.sgbm = cv2.StereoSGBM_create(minDisparity=0, numDisparities=reach, blockSize=5, P1=8 * 5 * 5, P2=32 * 5 * 5, disp12MaxDiff=2,
                                          uniquenessRatio=10, speckleWindowSize=60, speckleRange=2, mode=cv2.STEREO_SGBM_MODE_SGBM_3WAY)
        self.dy = 0.0  # the right lens's picture's height against the left's (worked out from them)
        self.dy_at = 0
        self.xs = np.tile(np.arange(w, dtype=np.float32), (h, 1))
        self.ys = np.tile(np.arange(h, dtype=np.float32)[:, None], (1, w))
        self.ys_at = (None, None)
        ramp = np.array([[255, 40, 40], [255, 200, 40], [80, 220, 80], [40, 170, 255], [60, 60, 200]], np.float32)
        t = np.linspace(0, 1, 256)[:, None] * (len(ramp) - 1)
        k = np.minimum(t.astype(int)[:, 0], len(ramp) - 2)
        f = t[:, 0] - k
        rgb = ramp[k] * (1 - f[:, None]) + ramp[k + 1] * f[:, None]
        self.lut = np.vstack([[0, 0, 0], rgb[1:, ::-1]]).astype(np.uint8)  # (BGR; 0: unknown, black)
        self.clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))

    def split(self, frame):
        """(left, right): the left lens's picture is the second in the frame. A frame as the camera
        sent it (YUYV, two bytes a pixel) has its lenses' part made BGR first."""
        w, h = self.w, self.h
        if frame.shape[2] == 2:
            both = self.cv2.cvtColor(frame[TOP:TOP + h, FIRST_X:FIRST_X + 2 * w], self.cv2.COLOR_YUV2BGR_YUYV)
            return both[:, w:], both[:, :w]
        return frame[TOP:TOP + h, FIRST_X + w:FIRST_X + 2 * w], frame[TOP:TOP + h, FIRST_X:FIRST_X + w]

    def night(self, img):
        """Low light: black and white, its darks brought up (each part of it by its own light)."""
        g = self.cv2.cvtColor(img, self.cv2.COLOR_BGR2GRAY)
        return self.cv2.cvtColor(self.clahe.apply(g), self.cv2.COLOR_GRAY2BGR)

    def depth(self, left, right):
        """The disparity (in the small pictures' pixels; 0 where unknown) and the depth (u16 mm)."""
        cv2, np = self.cv2, self.np
        gl = cv2.cvtColor(cv2.resize(left, (self.dw, self.dh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        gr = cv2.cvtColor(cv2.resize(right, (self.dw, self.dh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        now = time.time()
        if now - self.dy_at > 30:  # (how much higher one lens's picture is, every 30 s)
            self.dy_at = now
            (_, dy), resp = cv2.phaseCorrelate(np.float32(gl), np.float32(gr))
            if resp > 0.05 and abs(dy) < self.dh * 0.05:
                self.dy = float(dy) * self.h / self.dh
        if abs(self.dy) >= 0.5:
            gr = cv2.warpAffine(gr, np.float32([[1, 0, 0], [0, 1, -self.dy * self.dh / self.h]]), (self.dw, self.dh), borderMode=cv2.BORDER_REPLICATE)
        disp = self.sgbm.compute(gl, gr).astype(np.float32) / 16
        disp[disp < 1] = 0
        with np.errstate(divide="ignore"):
            mm = np.where(disp > 0, self.df * BASELINE_MM / np.maximum(disp, 1e-3), 0)
        mm[(mm < NEAR_MM * 0.9) | (mm > 8000)] = 0
        return disp, mm.astype(np.uint16)

    def depth_colours(self, mm):
        np = self.np
        k = np.clip((mm.astype(np.float32) - NEAR_MM) / (FAR_MM - NEAR_MM) * 254 + 1, 1, 255).astype(np.uint8)
        k[mm == 0] = 0
        return self.cv2.resize(self.lut[k], (self.w, self.h), interpolation=self.cv2.INTER_NEAREST)

    def merged(self, left, right, disp):
        """The right lens's picture moved onto the left's (each part by its own disparity) and the
        two put together where they agree: one picture, as the left lens sees it, half as grainy."""
        cv2, np = self.cv2, self.np
        d = cv2.resize(disp * (self.w / self.dw), (self.w, self.h), interpolation=cv2.INTER_LINEAR)
        if self.ys_at[0] != self.dy:  # (the rows to take from, as long as dy stays)
            self.ys_at = (self.dy, cv2.add(self.ys, self.dy))
        moved = cv2.remap(right, cv2.subtract(self.xs, d), self.ys_at[1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        both = cv2.addWeighted(left, 0.5, moved, 0.5, 0)
        _, known = cv2.threshold(d, 0, 255, cv2.THRESH_BINARY)
        _, close = cv2.threshold(cv2.cvtColor(cv2.absdiff(left, moved), cv2.COLOR_BGR2GRAY), 40, 255, cv2.THRESH_BINARY_INV)
        return cv2.copyTo(both, cv2.bitwise_and(known.astype(np.uint8), close), left.copy())

    def view(self, view, left, right, disp, mm):
        cv2, np = self.cv2, self.np
        if view == "right":
            return right
        if view == "side":
            return np.hstack([left, right])
        if view == "anaglyph":
            out = right.copy()  # (its blue and green; red is the left lens's brightness)
            out[:, :, 2] = cv2.cvtColor(left, cv2.COLOR_BGR2GRAY)
            return out
        if view == "blend":
            return cv2.addWeighted(left, 0.5, right, 0.5, 0)
        if view == "merged" and disp is not None:
            return self.merged(left, right, disp)
        if view in ("depth", "depth-blend", "depth-side") and mm is not None:
            colours = self.depth_colours(mm)
            if view == "depth":
                return colours
            if view == "depth-blend":
                return cv2.addWeighted(left, 0.5, colours, 0.5, 0)
            return np.hstack([left, colours])
        return left


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--simulate", action="store_true")
    ap.add_argument("--device", default="")
    ap.add_argument("--firmware", default="")
    ap.add_argument("--ffmpeg", default="")
    ap.add_argument("--size", default="1280x800", choices=list(MODES))
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--view", default="left", choices=VIEWS)
    ap.add_argument("--depth", action="store_true")
    ap.add_argument("--night", default="auto", choices=("auto", "on", "off"))
    ap.add_argument("--quality", type=int, default=80)
    ap.add_argument("--paced", action="store_true")
    args = ap.parse_args()

    if args.check:
        import cv2
        try:
            import usb
            usb_version = usb.__version__
        except ImportError:
            usb_version = None
        status("check", python=platform.python_version(), opencv=cv2.__version__, usb=usb_version)
        return
    if args.list:
        try:
            status("devices", devices=[{"id": c["id"], "name": "PlayStation 4 camera", "ready": c["ready"]} for c in cameras()])
        except Exception as e:  # (no libusb here, say)
            status("devices", devices=[], error=str(e))
        return

    import cv2
    import numpy as np
    (frame_size, rates) = MODES[args.size]
    fps = min(rates, key=lambda r: abs(r - args.fps))
    port = args.device
    if args.simulate:
        cap = Simulated(frame_size, fps)
    else:
        status("starting", message="Starting the PS4 camera…")
        found = next((c for c in cameras() if c["id"] == port), None)
        if found is None:
            status("error", message="The PS4 camera isn't plugged in (on a USB 3 port, through its adapter).")
            return
        if not found["ready"]:
            try:
                firmware = open(args.firmware, "rb").read()
            except OSError:
                status("error", message="The PS4 camera needs its firmware file: choose it under its ⚙.", firmware=False)
                return
            status("starting", message="Sending the PS4 camera its firmware…")
            try:
                send_firmware(port, firmware)
            except Exception as e:
                denied = getattr(e, "errno", None) == 13 or "Access denied" in str(e)
                hint = (" On Windows its start-up mode needs the WinUSB driver (Zadig, once)." if sys.platform == "win32"
                        else " Linux lets Hand Tracker talk to it once its rule is in (installing Hand Tracker's package again puts it in)." if denied else "")
                status("error", message=f"The PS4 camera couldn't be sent its firmware: {str(e).rstrip('.')}.{hint}", driver=sys.platform == "win32", denied=denied)
                return
            if not wait_ready(port):
                status("error", message="The PS4 camera didn't start with its firmware: is it the right file?")
                return
        try:
            cap = open_capture(args, port, frame_size, fps)
            ok, first = cap.read()
            if ok and first is not None and first.ndim != 3:  # (an OpenCV that gives its raw frames some other way: they're made BGR whole)
                cap.set(cv2.CAP_PROP_CONVERT_RGB, 1)
                ok, first = cap.read()
            if not ok or first is None:
                raise RuntimeError("The PS4 camera sent no pictures.")
            if first.shape[1] != frame_size[0]:
                raise RuntimeError(f"The PS4 camera sent {first.shape[1]} x {first.shape[0]} pictures, not {frame_size[0]} x {frame_size[1]}.")
        except Exception as e:
            status("error", message=str(e))
            return

    w, h = eye_size(frame_size[0])
    pics = Pictures(w, h)
    # Its gain by day: its own default (none where it can't be set; not as it's found: a helper
    # that ended at night leaves it high), and at night its highest (NIGHT_GAIN: measured on pi in
    # a dark room, 3.5 times as bright, hardly grainier).
    base_gain = DAY_GAIN if cap.get(cv2.CAP_PROP_GAIN) >= 0 else None
    state = {"view": args.view, "depth": args.depth, "night": args.night, "quit": False, "gain": base_gain}
    asked = threading.Semaphore(1) if args.paced else None  # (--paced: the frames asked for, not yet made)

    def commands():
        for line in sys.stdin:
            parts = line.split()
            if not parts:
                continue
            if parts[0] == "quit":
                state["quit"] = True
                return
            if parts[0] == "view" and len(parts) == 2 and parts[1] in VIEWS:
                state["view"] = parts[1]
            elif parts[0] == "depth" and len(parts) == 2 and parts[1] in ("on", "off"):
                state["depth"] = parts[1] == "on"
            elif parts[0] == "night" and len(parts) == 2 and parts[1] in ("auto", "on", "off"):
                state["night"] = parts[1]
            elif parts[0] == "next" and asked:
                asked.release()
        state["quit"] = True  # (the app's gone)

    threading.Thread(target=commands, daemon=True).start()

    # The camera is read on its own thread, the newest frame kept (one that's not dealt with yet is
    # dropped for a newer one): the pictures are made as fast as this computer can (--paced: as
    # fast as the app takes them).
    frames = queue.Queue(maxsize=1)
    gone = {"why": None}

    def reader():
        misses, gain = 0, None
        while not state["quit"]:
            if state["gain"] != gain:  # (set here, between its frames)
                gain = state["gain"]
                cap.set(cv2.CAP_PROP_GAIN, gain)
            ok, frame = cap.read()
            if not ok or frame is None or frame.shape[1] != frame_size[0] or frame.shape[0] < TOP + h:
                misses += 1
                if misses > 60:
                    gone["why"] = "The PS4 camera stopped sending pictures."
                    break
                time.sleep(0.02)
                continue
            misses = 0
            item = (time.time() * 1000, frame)
            try:
                frames.put_nowait(item)
            except queue.Full:
                try:
                    frames.get_nowait()
                except queue.Empty:
                    pass
                frames.put_nowait(item)
        state["quit"] = True

    threading.Thread(target=reader, daemon=True).start()
    status("running", camera="PlayStation 4 camera", size=f"{w}x{h}", fps=fps, simulated=args.simulate, depthSize=f"{pics.dw}x{pics.dh}", nearest=NEAR_MM)
    seq, times, dark_since, light_since, night_now = 0, [], None, None, args.night == "on"
    q = [int(cv2.IMWRITE_JPEG_QUALITY), max(30, min(95, args.quality))]
    while not state["quit"]:
        if asked and not asked.acquire(timeout=0.5):
            continue
        try:
            u, frame = frames.get(timeout=0.5)
        except queue.Empty:
            if asked:
                asked.release()  # (still wanted)
            continue
        left, right = pics.split(frame)
        # Night vision (it has no light of its own): in a dark room its gain up and the pictures
        # black and white and brightened, on its own after 8 s of dark ("auto"), back after 20 s
        # of light (with its gain up, a light room is far brighter).
        dark = float(cv2.cvtColor(np.ascontiguousarray(left[::8, ::8]), cv2.COLOR_BGR2GRAY).mean())
        now = time.time()
        if state["night"] == "auto":
            dark_since = (dark_since or now) if dark < 45 else None
            light_since = (light_since or now) if dark > (150 if night_now and base_gain is not None else 80) else None
            if not night_now and dark_since and now - dark_since > 8:
                night_now = True
            elif night_now and light_since and now - light_since > 20:
                night_now = False
        else:
            night_now = state["night"] == "on"
        if base_gain is not None:
            state["gain"] = NIGHT_GAIN if night_now else base_gain
        view = state["view"]
        with_depth = state["depth"] or view in NEEDS_DEPTH
        if night_now:
            left = pics.night(left)
            if with_depth or view != "left":
                right = pics.night(right)
        disp = mm = None
        if with_depth:
            disp, mm = pics.depth(left, right)
        shown = pics.view(view, left, right, disp, mm) if view != "left" else None
        parts, data = {}, []
        for name, img in (("jpeg", left if shown is None or view not in HAS_LEFT else None), ("shown", shown)):
            if img is not None:
                ok, enc = cv2.imencode(".jpg", np.ascontiguousarray(img), q)
                if ok:
                    parts[name] = [sum(len(d) for d in data), len(enc)]
                    data.append(enc.tobytes())
        if mm is not None:
            parts["depth"] = [sum(len(d) for d in data), mm.nbytes]
            data.append(mm.tobytes())
        times = [t for t in times if now - t < 2] + [now]
        seq += 1
        header = {"kind": "frame", "seq": seq, "t": round(time.monotonic() * 1000, 1), "u": round(u, 1), "w": w, "h": h, "fps": round((len(times) - 1) / max(1e-3, times[-1] - times[0]), 1) if len(times) > 1 else 0,
                  "view": view, "night": night_now, "dark": round(dark, 1), "image": {"fx": pics.f, "fy": pics.f, "cx": w / 2, "cy": h / 2}, "parts": parts}
        if mm is not None:
            header["map"] = {"w": pics.dw, "h": pics.dh, "fx": pics.df, "fy": pics.df, "cx": pics.dw / 2, "cy": pics.dh / 2}
        send(header, b"".join(data))
    cap.release()
    if gone["why"]:
        status("error", message=gone["why"])


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        pass
