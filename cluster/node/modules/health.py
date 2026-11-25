"""
health.py - Cluster module: how this Pi is doing. Processor use and temperature, memory, Wi-Fi,
its drives, the supply's voltage and whether it's been too low or too hot (the firmware's own
flags), and its power: wall or battery (a PiSugar tells, through pisugar-server; otherwise this
Pi's Power setting says).

Other modules read status()["power"]["source"] ("wall", "battery" or "unknown").

The user, 2026-11-22 (from a capture rig's own fixes):
- Low battery: a Pi on battery (piradise) at 10% saves any recording (Hand Tracker's "stop") and then shuts down
  cleanly, before the battery cuts it off. Two readings in a row, not while charging, not in its first 3 minutes
  (time to plug it in). Its own switch.
- Its starts: each start of this Pi noted with why it started, and its last minutes alive: after a restart or a
  shutdown (this service, asked to end while the system shuts down, says which), after its power was cut (no such
  note, and the firmware says it started from power-on), or after it froze (no note, a warm start: its watchdog).
  The last ones are in status()["boots"]; an unexpected one in the last day is a warning.

On a Windows PC in the cluster: Windows' own readings (winsys.py): processor, memory, Wi-Fi (netsh), drives, uptime
and its power (wall or battery, as Windows tells). No temperature (Windows gives it only to an administrator). Neither
of the two above.

On a phone in the cluster (the Cluster app, Android or iPhone): the phone's own readings (phonesys.py): its model,
memory, battery (its power: charging or not) and its temperature, Wi-Fi, storage and how long it's been on; no
processor use (a phone doesn't let an app read it). Neither of the two above: a phone looks after its own battery.
"""

import os
import random
import re
import socket
import sys
import threading
import time

TITLE = "Health"
ORDER = 10
ON = True
EVERY = 5
WINDOWS = os.environ.get("HT_CLUSTER_PLATFORM") == "windows"
PHONE = os.environ.get("HT_CLUSTER_PLATFORM") in ("android", "ios")
PLATFORMS = ("linux", "windows", "android", "ios")
SETTINGS = [] if PHONE else [
    {"key": "power", "title": "Power", "default": "auto",
     "choices": [["auto", "Find out (Windows)" if WINDOWS else "Find out (PiSugar)"], ["wall", "Wall power"], ["battery", "Battery"]]},
] + ([] if WINDOWS else [{"key": "lowBattery", "title": "On battery at 10%: save any recording, then shut down", "default": True}])

HOT_C = 80
LOW_BATTERY = 10  # (%: the user's choice)
LOW_READINGS = 2
SETTLE_S = 180  # (after a start: time to plug it in)
SAVE_WAIT_S = 180
BOOTS_KEPT = 30
SEEN_EVERY = 300
POWER_ON_RESET = 0x1000  # (the firmware's reset flags: HADPOR, a start from power-on)
CAUSES = {"first": "its first start seen", "restart": "a restart", "shutdown": "being shut down",
          "power": "its power was cut (or it was unplugged)", "froze": "it froze (its watchdog restarted it)",
          "unknown": "stopping without shutting down (its power cut, or it froze)"}
UNEXPECTED = ("power", "froze", "unknown")
_now = {}
_cpu_prev = None
_slow = {"at": 0}  # (Wi-Fi's name and the drives: every 30 s)
_guard = {"low": 0, "doing": False}
_boot = {"seenAt": 0}

# The firmware's flags (vcgencmd get_throttled): now, and since it started.
THROTTLED_NOW = {0: "Voltage too low now", 1: "Processor held back now", 2: "Slowed down now", 3: "Near its heat limit now"}
THROTTLED_SINCE = {16: "voltage was too low", 17: "processor held back", 18: "slowed down", 19: "reached its heat limit"}


def parse_stat(text):
    """/proc/stat's first line -> (idle, total) jiffies."""
    for line in (text or "").splitlines():
        if line.startswith("cpu "):
            v = [int(x) for x in line.split()[1:]]
            idle = v[3] + (v[4] if len(v) > 4 else 0)
            return idle, sum(v[:8])
    return None


def cpu_percent(prev, now):
    if not prev or not now or now[1] <= prev[1]:
        return None
    return max(0.0, min(100.0, 100.0 * (1 - (now[0] - prev[0]) / float(now[1] - prev[1]))))


def parse_meminfo(text):
    out = {}
    for line in (text or "").splitlines():
        m = re.match(r"(\w+):\s+(\d+)\s*kB", line)
        if m and m.group(1) in ("MemTotal", "MemAvailable"):
            out[m.group(1)] = int(m.group(2)) * 1024
    if "MemTotal" not in out:
        return None
    return {"total": out["MemTotal"], "available": out.get("MemAvailable", 0)}


def parse_wireless(text):
    """/proc/net/wireless -> {"iface", "dbm"} for the first Wi-Fi adapter."""
    for line in (text or "").splitlines()[2:]:
        m = re.match(r"\s*(\w+):\s+\S+\s+([-\d.]+)\.?\s+([-\d.]+)\.?", line)
        if m:
            dbm = float(m.group(3))
            if dbm > 0:  # (some drivers give it unsigned)
                dbm -= 256
            return {"iface": m.group(1), "dbm": int(round(dbm))}
    return None


def parse_nmcli_wifi(text):
    """`nmcli -t -f ACTIVE,SSID,FREQ dev wifi list --rescan no` -> {"ssid", "mhz"} of the network in use."""
    for line in (text or "").splitlines():
        parts = re.split(r"(?<!\\):", line)
        if len(parts) >= 3 and parts[0] == "yes":
            mhz = re.match(r"(\d+)", parts[2])
            return {"ssid": parts[1].replace("\\:", ":"), "mhz": int(mhz.group(1)) if mhz else None}
    return None


def parse_throttled(text):
    m = re.search(r"throttled=(0x[0-9a-fA-F]+)", text or "")
    if not m:
        return None
    bits = int(m.group(1), 16)
    return {"now": [t for b, t in THROTTLED_NOW.items() if bits & (1 << b)],
            "since": [t for b, t in THROTTLED_SINCE.items() if bits & (1 << b)]}


def parse_volts(text):
    m = re.search(r"=\s*([\d.]+)\s*V", text or "")
    return round(float(m.group(1)), 2) if m else None


def parse_mounts(text):
    """/proc/mounts -> the real drives' mount points (each drive once; not /boot)."""
    seen, out = set(), []
    for line in (text or "").splitlines():
        f = line.split()
        if len(f) < 3 or not re.match(r"/dev/(nvme|sd|mmcblk|vd)", f[0]) or f[1].startswith("/boot"):
            continue
        dev = re.sub(r"p?\d+$", "", f[0])
        if dev in seen:
            continue
        seen.add(dev)
        out.append(f[1].replace("\\040", " "))
    return out


def pisugar(timeout=1.0):
    """pisugar-server's battery level and whether it's on outside power, or None (no PiSugar)."""
    def ask(q):
        with socket.create_connection(("127.0.0.1", 8423), timeout=timeout) as s:
            s.sendall((q + "\n").encode())
            s.settimeout(timeout)
            return s.recv(256).decode("utf-8", "replace")
    try:
        level = re.search(r"battery:\s*([\d.]+)", ask("get battery"))
        plugged = re.search(r"battery_power_plugged:\s*(true|false)", ask("get battery_power_plugged"))
        charging = re.search(r"battery_charging:\s*(true|false)", ask("get battery_charging"))
    except OSError:
        return None
    if not level:
        return None
    return {"level": round(float(level.group(1))), "plugged": bool(plugged and plugged.group(1) == "true"),
            "charging": bool(charging and charging.group(1) == "true")}


def _read(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def _vcgencmd(node, *args):
    code, out, _ = node.run(["vcgencmd"] + list(args), 5)
    return out if code == 0 else None


def simulated():
    t = time.time()
    return {
        "model": "Raspberry Pi 5 Model B (simulated)", "cpu": round(20 + 10 * random.random()), "cores": 4,
        "load": [0.4, 0.5, 0.6], "memory": {"total": 4 * 1024 ** 3, "available": int(2.5 * 1024 ** 3)},
        "tempC": 58, "wifi": {"iface": "wlan0", "dbm": -57, "ssid": "Home", "mhz": 5180},
        "volts": 5.12, "throttled": {"now": [], "since": []},
        "drives": [{"mount": "/", "total": 500 * 10 ** 9, "free": 320 * 10 ** 9}],
        "uptime": int(os.environ.get("HT_CLUSTER_SIM_UPTIME") or t % 100000),
        # (the checks: a PiSugar's battery at this level, unplugged)
        "pisugar": {"level": int(os.environ["HT_CLUSTER_SIM_BATTERY"]), "plugged": False, "charging": False} if os.environ.get("HT_CLUSTER_SIM_BATTERY") else None,
    }


def windows_tick(node):
    global _cpu_prev
    w = winsys()
    name = w.cpu_name()
    r = {"model": "Windows PC" + (" (%s)" % name if name else "")}
    times = w.cpu_times()
    r["cpu"] = cpu_percent(_cpu_prev, times)
    _cpu_prev = times
    r["cores"] = os.cpu_count()
    r["load"] = None
    r["memory"] = w.memory()
    r["tempC"] = None
    if time.time() - _slow["at"] > 30:
        _slow.update(at=time.time(), wifi=w.wifi(), drives=w.drives())
    r["wifi"] = _slow.get("wifi")
    r["drives"] = _slow.get("drives") or []
    r["volts"] = None
    r["throttled"] = None
    r["uptime"] = w.uptime()
    r["pisugar"] = None
    r["windowsPower"] = w.power()
    _now.clear()
    _now.update(r)


def phone_tick(node):
    """A phone's readings, as the app gives them (phonesys.py)."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if here not in sys.path:
        sys.path.insert(0, here)
    import phonesys

    p = phonesys.readings()
    b = p.get("battery") if isinstance(p.get("battery"), dict) else None
    r = {"model": p.get("model") or "Phone", "cpu": None, "cores": p.get("cores") or os.cpu_count(), "load": None,
         "memory": p.get("memory") if isinstance(p.get("memory"), dict) and p["memory"].get("total") else None,
         "tempC": p.get("tempC"), "wifi": p.get("wifi") if isinstance(p.get("wifi"), dict) else None,
         "drives": [d for d in p.get("drives") or [] if isinstance(d, dict) and d.get("total")], "volts": None, "throttled": None,
         "uptime": p.get("uptime"), "pisugar": None,
         "phonePower": {"plugged": bool(b.get("plugged")), "level": b["level"], "charging": bool(b.get("charging"))} if b and b.get("level") is not None else None}
    _now.clear()
    _now.update(r)


def tick(node):
    readings(node)
    if not WINDOWS and not PHONE:
        boot_tick(node)
        battery_guard(node)


def readings(node):
    global _cpu_prev
    if node.simulate and not PHONE:
        _now.update(simulated())
        return
    if WINDOWS:
        return windows_tick(node)
    if PHONE:
        return phone_tick(node)
    r = {}
    r["model"] = (_read("/proc/device-tree/model") or "").strip("\x00\n ") or None
    stat = parse_stat(_read("/proc/stat"))
    r["cpu"] = cpu_percent(_cpu_prev, stat)
    _cpu_prev = stat
    r["cores"] = os.cpu_count()
    try:
        r["load"] = [round(x, 2) for x in os.getloadavg()]
    except OSError:
        r["load"] = None
    r["memory"] = parse_meminfo(_read("/proc/meminfo"))
    t = _read("/sys/class/thermal/thermal_zone0/temp")
    r["tempC"] = round(int(t) / 1000.0) if t and t.strip().isdigit() else None
    wifi = parse_wireless(_read("/proc/net/wireless"))
    if time.time() - _slow["at"] > 30:
        _slow["at"] = time.time()
        code, out, _ = node.run(["nmcli", "-t", "-f", "ACTIVE,SSID,FREQ", "dev", "wifi", "list", "--rescan", "no"], 8)
        _slow["wifi"] = parse_nmcli_wifi(out) if code == 0 else None
        drives = []
        for mount in parse_mounts(_read("/proc/mounts")):
            try:
                st = os.statvfs(mount)
                drives.append({"mount": mount, "total": st.f_blocks * st.f_frsize, "free": st.f_bavail * st.f_frsize})
            except OSError:
                pass
        _slow["drives"] = drives
        _slow["volts"] = parse_volts(_vcgencmd(node, "pmic_read_adc", "EXT5V_V"))
    if wifi:
        wifi.update(_slow.get("wifi") or {})
    r["wifi"] = wifi
    r["drives"] = _slow.get("drives") or []
    r["volts"] = _slow.get("volts")
    r["throttled"] = parse_throttled(_vcgencmd(node, "get_throttled"))
    up = _read("/proc/uptime")
    r["uptime"] = int(float(up.split()[0])) if up else None
    r["pisugar"] = pisugar()
    _now.clear()
    _now.update(r)


# ----- low battery: any recording saved, then shut down (the user, 2026-11-22) -----
def battery_guard(node):
    if _guard["doing"] or not node.setting("health", "lowBattery"):
        return
    p = power(node)
    low = (p["source"] == "battery" and p.get("level") is not None and p["level"] <= LOW_BATTERY and not p.get("charging")
           and (_now.get("uptime") or 0) >= SETTLE_S)
    _guard["low"] = _guard["low"] + 1 if low else 0
    if _guard["low"] < LOW_READINGS:
        return
    _guard["doing"] = True
    threading.Thread(target=shut_down, args=(node, p["level"]), daemon=True).start()


def shut_down(node, level):
    node.event("health", "Battery at %d%%: saving any recording, then shutting down." % level, bad=True)
    m = node.modules.get("rig")
    r = m.mod if m else None
    if r and r.busy(node):
        code, answer = r.ht(node, "POST", "/api/command", {"action": "stop"}, timeout=30)
        until = time.time() + SAVE_WAIT_S
        while time.time() < until and r.busy(node):
            time.sleep(3)
        if r.busy(node):
            node.event("health", "The take was still saving after %d minutes: shutting down all the same." % (SAVE_WAIT_S // 60), bad=True)
        else:
            node.event("health", "The take is saved.")
    answer = node.root("poweroff", timeout=60)
    if not answer.get("ok"):
        node.event("health", "Couldn't shut down: %s" % answer.get("error"), bad=True)
        _guard.update(doing=False, low=0)  # (tried again at the next low readings)


# ----- its starts, and why (the user, 2026-11-22) -----
def boot_id(node):
    if node.simulate:
        return os.environ.get("HT_CLUSTER_SIM_BOOT_ID") or "simulated-boot"
    return (_read("/proc/sys/kernel/random/boot_id") or "").strip()


def boot_time(node):
    if node.simulate:
        return time.time() - (_now.get("uptime") or 0)
    m = re.search(r"^btime\s+(\d+)", _read("/proc/stat") or "", re.M)
    return int(m.group(1)) if m else None


def power_on_start(node):
    """Whether this start was from power-on (the firmware's reset flags, as the bootloader left them), or None
    (not known here)."""
    if node.simulate:
        v = os.environ.get("HT_CLUSTER_SIM_RSTS")
        return None if v is None else bool(int(v, 16) & POWER_ON_RESET)
    try:
        with open("/proc/device-tree/chosen/bootloader/rsts", "rb") as f:
            data = f.read(4)
    except OSError:
        return None
    return bool(int.from_bytes(data, "big") & POWER_ON_RESET) if len(data) == 4 else None


def boot_tick(node):
    bid = boot_id(node)
    if not bid:
        return
    mem = node.memory("health")
    boots = mem.get("boots") or []
    now = time.time()
    if not boots or boots[-1].get("id") != bid:
        prev = boots[-1] if boots else None
        if prev is None:
            cause = "first"
        elif prev.get("ended") in ("restart", "shutdown"):
            cause = prev["ended"]
        else:
            cold = power_on_start(node)
            cause = "unknown" if cold is None else "power" if cold else "froze"
        boots.append({"id": bid, "at": int(boot_time(node) or now), "cause": cause, "seen": int(now)})
        mem["boots"] = boots[-BOOTS_KEPT:]
        mem.save()
        _boot["seenAt"] = now
        if cause in UNEXPECTED:
            last = (" (last heard from %s)" % time.strftime("%Y-%m-%d %H:%M", time.localtime(prev["seen"]))) if prev and prev.get("seen") else ""
            node.event("health", "Started again after %s%s." % (CAUSES[cause], last), bad=True)
        return
    if now - _boot["seenAt"] >= SEEN_EVERY:
        _boot["seenAt"] = now
        boots[-1]["seen"] = int(now)
        mem.save()


def stopping(node):
    """This service asked to end: when the system itself is shutting down, its start's note says how (a restart, or
    shut down), so the next start knows it wasn't a power cut."""
    if WINDOWS or PHONE:
        return
    how = None
    if node.simulate:
        how = os.environ.get("HT_CLUSTER_SIM_SHUTDOWN") or None
    else:
        code, out, _ = node.run(["systemctl", "is-system-running"], 3)
        if out.strip() == "stopping":
            code, jobs, _ = node.run(["systemctl", "list-jobs", "--no-legend", "--no-pager"], 3)
            how = "restart" if re.search(r"\b(reboot|kexec)\.target\b", jobs or "") else "shutdown"
    if not how:
        return
    mem = node.memory("health")
    boots = mem.get("boots") or []
    if boots and boots[-1].get("id") == boot_id(node):
        boots[-1].update(ended=how, seen=int(time.time()))
        mem.save()


def boots_seen(node):
    """The last starts, newest first: [{"at", "cause", "words", "lastSeen" (of the start before it)}]."""
    boots = node.memory("health").get("boots") or []
    out = []
    for i in range(len(boots) - 1, -1, -1):
        b = boots[i]
        prev = boots[i - 1] if i else None
        out.append({"at": b.get("at"), "cause": b.get("cause"), "words": CAUSES.get(b.get("cause"), b.get("cause")),
                    "lastSeen": prev.get("seen") if prev else None})
    return out[:10]


def power(node):
    told = node.setting("health", "power")
    sugar = _now.get("pisugar")
    wp = _now.get("windowsPower") or _now.get("phonePower")
    if wp:  # (a Windows PC: as Windows tells it, a battery's level too)
        sugar = {"plugged": wp.get("plugged") is not False, "level": wp["level"], "charging": wp.get("charging")} if "level" in wp else None
        if not sugar and told not in ("wall", "battery"):
            return {"source": "battery" if wp.get("plugged") is False else "wall", "set": told}
    if told in ("wall", "battery"):
        source = told
    elif sugar:
        source = "wall" if sugar["plugged"] else "battery"
    else:
        source = "unknown"
    out = {"source": source, "set": told}
    if sugar:
        out.update(level=sugar["level"], charging=sugar["charging"])
    return out


def gb(n):
    return "%.1f" % (n / 1024.0 ** 3)


def size(n):
    return ("%.1f TB" % (n / 1e12)) if n >= 1e12 else ("%d GB" % round(n / 1e9))


def status(node):
    r = dict(_now)
    r["power"] = power(node)
    parts, warn = [], []
    if r.get("cpu") is not None:
        parts.append("CPU %d%%" % round(r["cpu"]))
    if r.get("tempC") is not None:
        parts.append("%d °C" % r["tempC"])
        if r["tempC"] >= HOT_C:
            warn.append("Hot: %d °C" % r["tempC"])
    mem = r.get("memory")
    if mem:
        used = mem["total"] - mem["available"]
        parts.append("Memory %s of %s GB" % (gb(used), gb(mem["total"])))
        if mem["available"] < 0.08 * mem["total"]:
            warn.append("Memory nearly full")
    w = r.get("wifi")
    if w:
        band = (" %s GHz" % ("5" if w["mhz"] >= 4900 else "2.4")) if w.get("mhz") else ""
        if w.get("signal") is not None:  # (Windows says how strong as a share)
            parts.append("Wi-Fi %d%%%s" % (w["signal"], band))
        elif w.get("dbm") is not None:
            parts.append("Wi-Fi %d dBm%s" % (w["dbm"], band))
    p = r["power"]
    if p["source"] == "battery":
        parts.append("Battery %d%%" % p["level"] if "level" in p else "Battery")
        if p.get("level") is not None and p["level"] < 20 and not p.get("charging"):
            warn.append("Battery low: %d%%" % p["level"])
    elif p["source"] == "wall" and PHONE:  # (a phone: plugged in, charging or full)
        parts.append(("Charging" if p.get("charging") else "Plugged in") + (" (battery %d%%)" % p["level"] if "level" in p else ""))
    elif p["source"] == "wall":
        parts.append("Wall power" + (" (battery %d%%)" % p["level"] if "level" in p else ""))
    for d in r.get("drives") or []:
        if d["total"] > 0 and d["free"] < 0.05 * d["total"]:
            warn.append("Drive %s nearly full (%s free)" % (d["mount"], size(d["free"])))
    th = r.get("throttled")
    if th and th["now"]:
        warn.extend(th["now"])
    if not WINDOWS and not PHONE:
        r["boots"] = boots_seen(node)
        for b in r["boots"]:
            if b["cause"] in UNEXPECTED and b.get("at") and time.time() - b["at"] < 86400:
                warn.append("Started again at %s after %s" % (time.strftime("%H:%M", time.localtime(b["at"])), b["words"]))
                break
        if _guard["doing"]:
            warn.append("Battery nearly empty: saving any recording, then shutting down")
    r["summary"] = " · ".join(parts)
    r["warnings"] = warn
    return r


def winsys():
    """winsys.py (beside ht_cluster.py): Windows' own readings."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if here not in sys.path:
        sys.path.insert(0, here)
    import winsys as w
    return w


ACTIONS = {}
