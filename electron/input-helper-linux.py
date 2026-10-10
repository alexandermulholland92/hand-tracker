#!/usr/bin/env python3
# input-helper-linux.py: moves the pointer, clicks, scrolls and presses keys for Hand Tracker on
# a Linux Wayland desktop (Raspberry Pi OS's labwc, GNOME, KDE...), where no app may move the
# pointer or type into other apps: it makes a virtual mouse and keyboard with the kernel's
# uinput (/dev/uinput), which the desktop takes like any plugged-in ones. The mouse gives
# absolute positions, like a drawing tablet, so the pointer goes exactly where it's put. Only
# Python's own library is used. electron/input.js runs it (UinputDriver); one command a line:
#
#   move X Y              X, Y: shares of the whole desktop (0..1)
#   down|up|click|double left|right|middle
#   wheel N               N notches, positive = up
#   keydown|keyup|tap CODE   a Linux key code (input.js's LINUX_KEYS)
#   text BASE64           UTF-8 text, typed with a US keyboard's keys (others are left out, said so)
#   pos                   answers "pos none" (Wayland doesn't tell apps where the pointer is)
#   ping                  answers "pong"
#
# It prints "ready" once the devices are made, "error ..." for anything it couldn't do, and
# exits (the devices going with it) when its input closes. Needs write access to /dev/uinput:
# the .deb's rule (build/linux/after-install-uinput.sh) gives it to whoever is logged in at
# the computer's own screen.

import base64
import fcntl
import os
import struct
import sys
import time

EV_SYN, EV_KEY, EV_REL, EV_ABS = 0, 1, 2, 3
SYN_REPORT = 0
ABS_X, ABS_Y = 0, 1
REL_HWHEEL, REL_WHEEL = 6, 8
BTN = {"left": 0x110, "right": 0x111, "middle": 0x112}
ABS_MAX = 32767


def _ioc(direction, nr, size):
    return (direction << 30) | (size << 16) | (ord("U") << 8) | nr


UI_DEV_CREATE = _ioc(0, 1, 0)
UI_DEV_DESTROY = _ioc(0, 2, 0)
UI_DEV_SETUP = _ioc(1, 3, 92)  # struct uinput_setup
UI_ABS_SETUP = _ioc(1, 4, 28)  # struct uinput_abs_setup
UI_SET_EVBIT = _ioc(1, 100, 4)
UI_SET_KEYBIT = _ioc(1, 101, 4)
UI_SET_RELBIT = _ioc(1, 102, 4)
UI_SET_ABSBIT = _ioc(1, 103, 4)


class Device:
    def __init__(self, name, keys=(), rel=(), absolute=False):
        self.fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        if keys:
            fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_KEY)
            for k in keys:
                fcntl.ioctl(self.fd, UI_SET_KEYBIT, k)
        if rel:
            fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_REL)
            for r in rel:
                fcntl.ioctl(self.fd, UI_SET_RELBIT, r)
        if absolute:
            fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_ABS)
            for a in (ABS_X, ABS_Y):
                fcntl.ioctl(self.fd, UI_SET_ABSBIT, a)
                # code, then struct input_absinfo: value, minimum, maximum, fuzz, flat, resolution
                fcntl.ioctl(self.fd, UI_ABS_SETUP, struct.pack("HxxiIiiii", a, 0, 0, ABS_MAX, 0, 0, 0))
        # struct uinput_setup: input_id (bus, vendor, product, version), name, ff_effects_max
        fcntl.ioctl(self.fd, UI_DEV_SETUP, struct.pack("HHHH80sI", 0x06, 0x1209, 0x4854, 1, name.encode()[:79], 0))
        fcntl.ioctl(self.fd, UI_DEV_CREATE)

    def emit(self, *events):
        data = b"".join(struct.pack("llHHi", 0, 0, t, c, v) for t, c, v in events)
        os.write(self.fd, data + struct.pack("llHHi", 0, 0, EV_SYN, SYN_REPORT, 0))

    def close(self):
        try:
            fcntl.ioctl(self.fd, UI_DEV_DESTROY)
        finally:
            os.close(self.fd)


# A US keyboard: character -> (key code, shift).
US = {" ": (57, False), "\n": (28, False), "\t": (15, False)}
for i, c in enumerate("1234567890"):
    US[c] = (2 + i, False)
for i, c in enumerate("!@#$%^&*()"):
    US[c] = (2 + i, True)
for row, start in (("qwertyuiop", 16), ("asdfghjkl", 30), ("zxcvbnm", 44)):
    for i, c in enumerate(row):
        US[c] = (start + i, False)
        US[c.upper()] = (start + i, True)
for plain, shifted, code in (("-", "_", 12), ("=", "+", 13), ("[", "{", 26), ("]", "}", 27), (";", ":", 39), ("'", '"', 40),
                             ("`", "~", 41), ("\\", "|", 43), (",", "<", 51), (".", ">", 52), ("/", "?", 53)):
    US[plain] = (code, False)
    US[shifted] = (code, True)
SHIFT = 42


def main():
    try:
        mouse = Device("Hand Tracker mouse", keys=BTN.values(), rel=(REL_WHEEL, REL_HWHEEL), absolute=True)
        keyboard = Device("Hand Tracker keyboard", keys=range(1, 256))
    except PermissionError:
        print("Hand Tracker can't use /dev/uinput (the virtual mouse and keyboard): it needs the permission its package adds.", file=sys.stderr)
        return 2
    except OSError as err:
        print(f"Couldn't make the virtual mouse and keyboard: {err}", file=sys.stderr)
        return 3
    time.sleep(0.3)  # until the desktop has taken them
    print("ready", flush=True)

    def tap(code, shift=False):
        if shift:
            keyboard.emit((EV_KEY, SHIFT, 1))
        keyboard.emit((EV_KEY, code, 1))
        keyboard.emit((EV_KEY, code, 0))
        if shift:
            keyboard.emit((EV_KEY, SHIFT, 0))
        time.sleep(0.004)

    def click(button):
        mouse.emit((EV_KEY, button, 1))
        time.sleep(0.02)
        mouse.emit((EV_KEY, button, 0))

    try:
        for line in sys.stdin:
            parts = line.split()
            if not parts:
                continue
            cmd, args = parts[0], parts[1:]
            try:
                if cmd == "move":
                    x = min(1.0, max(0.0, float(args[0])))
                    y = min(1.0, max(0.0, float(args[1])))
                    mouse.emit((EV_ABS, ABS_X, round(x * ABS_MAX)), (EV_ABS, ABS_Y, round(y * ABS_MAX)))
                elif cmd in ("down", "up", "click", "double"):
                    button = BTN[args[0]]
                    if cmd == "down":
                        mouse.emit((EV_KEY, button, 1))
                    elif cmd == "up":
                        mouse.emit((EV_KEY, button, 0))
                    else:
                        click(button)
                        if cmd == "double":
                            time.sleep(0.06)
                            click(button)
                elif cmd == "wheel":
                    mouse.emit((EV_REL, REL_WHEEL, int(args[0])))
                elif cmd in ("keydown", "keyup"):
                    keyboard.emit((EV_KEY, int(args[0]), 1 if cmd == "keydown" else 0))
                elif cmd == "tap":
                    tap(int(args[0]))
                elif cmd == "text":
                    text = base64.b64decode(args[0] if args else "").decode("utf-8")
                    left_out = sorted({c for c in text if c not in US})
                    for c in text:
                        if c in US:
                            tap(*US[c])
                    if left_out:
                        print(f"error not typed (not on a US keyboard): {''.join(left_out)}", flush=True)
                elif cmd == "pos":
                    print("pos none", flush=True)
                elif cmd == "ping":
                    print("pong", flush=True)
                else:
                    print(f"error unknown command {cmd}", flush=True)
            except (IndexError, KeyError, ValueError) as err:
                print(f"error {cmd}: {err}", flush=True)
    finally:
        mouse.close()
        keyboard.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
