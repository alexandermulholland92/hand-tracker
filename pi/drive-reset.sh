#!/bin/bash
# drive-reset.sh — a Raspberry Pi 5 whose NVMe drive isn't found again after a restart (the bootloader's "NVMe read
# failure" over and over, until its power is cut: pi, 2026-11-21 and 11-26, its drive behind a PCIe switch on a HAT
# powered from the pin header, so the drive never loses its power while the Pi restarts or is switched off). The drive
# is given back the way the bootloader finds it after power-on, at the very end of every restart or power-off (after
# everything's written and the drives are read-only, by systemd-shutdown, just before the Pi restarts):
#  - each NVMe drive told to stop using the Pi's memory (its host memory buffer: a drive without memory of its own
#    keeps tables in the Pi's, which the bootloader, starting afresh, knows nothing of) and to leave its power-saving
#    states (APST, power state 0);
#  - then taken off the PCIe bus the way Linux does when a drive is unplugged (each drive shut down cleanly first),
#    with whatever else hangs off the same connector (the HAT's PCIe switch, its USB controller);
#  - then the connector held in reset (a secondary bus reset of its PCIe root port) until the Pi restarts, so the
#    switch and the drives start from scratch when the bootloader brings the connector up again.
# Not for a freeze or a kernel panic (the Pi restarts at once then, with nothing run first). Run it once:
#     sudo bash drive-reset.sh            # set up
#     sudo bash drive-reset.sh --remove   # take it away
#     sudo bash drive-reset.sh --dry-run  # what it would do at a restart now (nothing done)
set -euo pipefail

ROOT=""
if [ -n "${DRIVE_RESET_TEST_ROOT:-}" ]; then
  ROOT=$DRIVE_RESET_TEST_ROOT   # (the checks: a folder standing in for /)
elif [ "$(id -u)" != 0 ]; then
  echo "Run it with sudo: sudo bash $0" >&2
  exit 1
fi

HOOK=$ROOT/usr/lib/systemd/system-shutdown/hand-tracker-drive-reset

if [ "${1:-}" = "--remove" ]; then
  if [ -e "$HOOK" ]; then
    rm -f "$HOOK"
    echo "Removed: a restart leaves the drive as it is again."
  else
    echo "Removed: it wasn't set up."
  fi
  exit 0
fi

if [ "${1:-}" != "--dry-run" ]; then
  MODEL=$(tr -d '\0' < "$ROOT/proc/device-tree/model" 2>/dev/null || true)
  case "$MODEL" in
    *"Raspberry Pi 5"*|*"Raspberry Pi Compute Module 5"*|*"Raspberry Pi 500"*) ;;
    *) echo "This is for a Raspberry Pi 5 (this is ${MODEL:-not one}): its NVMe drive on the PCIe connector." >&2; exit 1 ;;
  esac
fi
command -v python3 >/dev/null || { echo "This needs Python 3 (sudo apt install python3)." >&2; exit 1; }

NEW=$(mktemp)
trap 'rm -f "$NEW"' EXIT
cat > "$NEW" <<'PY'
#!/usr/bin/python3 -I
# hand-tracker-drive-reset (pi/drive-reset.sh): run by systemd-shutdown at the very end of a restart or a power-off,
# after the drives are read-only. Each NVMe drive on the Pi's PCIe connector given back as after power-on: its host
# memory buffer and power-saving states off, the drive taken off the bus (shut down cleanly by Linux's driver), then
# the connector's root port held in reset until the Pi restarts. Nothing here may read the root drive once it's gone:
# everything it uses is loaded first. --dry-run: what it would do, nothing done.
import os
import re
import struct
import sys
import time

SYS = os.environ.get("HT_DRIVE_RESET_SYS", "/sys")
DEV = os.environ.get("HT_DRIVE_RESET_DEV", "/dev")
ARGS = sys.argv[1:]
DRY = "--dry-run" in ARGS
WHAT = ([a for a in ARGS if not a.startswith("--")] or ["reboot"])[0]  # (systemd-shutdown: halt, poweroff, reboot, kexec)
BDF = re.compile(r"^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$")
NVME_ADMIN = 0xC0484E41  # (_IOWR('N', 0x41, struct nvme_passthru_cmd): 72 bytes)
SET_FEATURES = 0x09
FEATURES = ((0x0D, "its host memory buffer off"), (0x0C, "its power-saving states (APST) off"), (0x02, "power state 0"))
BRIDGE_CONTROL = 0x3E
SECONDARY_BUS_RESET = 0x40


def say(words):
    line = "hand-tracker-drive-reset: %s\n" % words
    try:
        sys.stdout.write(line)
        sys.stdout.flush()
    except OSError:
        pass
    if not DRY:
        try:
            with open("/dev/kmsg", "w") as k:  # (on the console and in the kernel's log, kept by a crash log if any)
                k.write(line)
        except OSError:
            pass


def chains():
    """Each NVMe drive's PCIe path, from its root port down: {root port: [(nvme name, [bdf, ...]), ...]}."""
    out = {}
    base = os.path.join(SYS, "class", "nvme")
    try:
        names = sorted(os.listdir(base))
    except OSError:
        return out
    for name in names:
        if not re.match(r"^nvme\d+$", name):
            continue
        dev = os.path.realpath(os.path.join(base, name, "device"))
        path = [p for p in dev.split(os.sep) if BDF.match(p)]
        if len(path) < 2:  # (a drive straight on a root complex, with no root port above it: nothing to reset)
            continue
        out.setdefault(path[0], []).append((name, path))
    return out


def set_feature(name, fid):
    import fcntl  # (loaded while the root drive's still there: step 1 runs before it's taken off the bus)
    cmd = struct.pack("<BBHIIIQQIIIIIIIIII", SET_FEATURES, 0, 0, 0, 0, 0, 0, 0, 0, 0, fid, 0, 0, 0, 0, 0, 5000, 0)
    fd = os.open(os.path.join(DEV, name), os.O_RDONLY)
    try:
        fcntl.ioctl(fd, NVME_ADMIN, bytearray(cmd))
        return True
    except OSError:
        return False  # (a feature the drive hasn't got, or one that's off already: nothing to do)
    finally:
        os.close(fd)


def main():
    if WHAT == "kexec":
        return
    found = chains()
    if not found:
        say("no NVMe drive on a PCIe root port: nothing to do")
        return
    for root, drives in sorted(found.items()):
        for name, path in drives:
            say("%s at %s" % (name, " > ".join(path)))
    if DRY:
        for root, drives in sorted(found.items()):
            first = sorted({path[1] for _, path in drives})
            say("would: tell each drive its host memory buffer and power-saving states off, take %s off the bus "
                "(each drive shut down cleanly), then hold %s in reset until the restart" % (", ".join(first), root))
        return
    # 1. Each drive: no host memory buffer, no power saving.
    for root, drives in sorted(found.items()):
        for name, _ in drives:
            done = [words for fid, words in FEATURES if set_feature(name, fid)]
            say("%s: %s" % (name, ", ".join(done) if done else "nothing to change"))
    # 2. Everything under each root port taken off the bus (Linux's driver shuts each drive down first). The root
    #    drive is gone from here on: only sysfs from now.
    for root, drives in sorted(found.items()):
        for child in sorted({path[1] for _, path in drives}):
            try:
                with open(os.path.join(SYS, "bus", "pci", "devices", child, "remove"), "w") as f:
                    f.write("1")
            except OSError as e:
                say("%s couldn't be taken off the bus: %s" % (child, e))
    # 3. Each root port's secondary bus reset, held: the PCIe switch and the drives stay in reset until the Pi's own
    #    reset clears it and the bootloader brings the connector up again, as after power-on.
    for root in sorted(found):
        try:
            fd = os.open(os.path.join(SYS, "bus", "pci", "devices", root, "config"), os.O_RDWR)
            try:
                now = os.pread(fd, 2, BRIDGE_CONTROL)
                if len(now) == 2:
                    value = struct.unpack("<H", now)[0] | SECONDARY_BUS_RESET
                    os.pwrite(fd, struct.pack("<H", value), BRIDGE_CONTROL)
                    say("%s held in reset until the restart" % root)
            finally:
                os.close(fd)
        except OSError as e:
            say("%s couldn't be reset: %s" % (root, e))
    time.sleep(0.2)


try:
    main()
except Exception as e:  # (never in the way of the restart itself)
    say("stopped: %s" % e)
PY

if [ "${1:-}" = "--dry-run" ]; then
  python3 -I - --dry-run < "$NEW"
  exit 0
fi

mkdir -p "$(dirname "$HOOK")"
if [ -f "$HOOK" ] && cmp -s "$NEW" "$HOOK"; then
  echo "Set up: it's there already (at each restart or power-off, the drive given back as after power-on)."
  exit 0
fi
install -m 0755 "$NEW" "$HOOK"
echo "Set up: at each restart or power-off, the drive given back as after power-on (from the next restart)."
