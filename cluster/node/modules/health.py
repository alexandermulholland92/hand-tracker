"""
health.py - Pi Cluster module: how this Pi is doing. Processor use and temperature, memory, Wi-Fi,
its drives, the supply's voltage and whether it's been too low or too hot (the firmware's own
flags), and its power: wall or battery (a PiSugar tells, through pisugar-server; otherwise this
Pi's Power setting says).

Other modules read status()["power"]["source"] ("wall", "battery" or "unknown").
"""

import os
import random
import re
import socket
import time

TITLE = "Health"
ORDER = 10
ON = True
EVERY = 5
SETTINGS = [
    {"key": "power", "title": "Power", "default": "auto",
     "choices": [["auto", "Find out (PiSugar)"], ["wall", "Wall power"], ["battery", "Battery"]]},
]

HOT_C = 80
_now = {}
_cpu_prev = None
_slow = {"at": 0}  # (Wi-Fi's name and the drives: every 30 s)

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
        "uptime": int(t % 100000), "pisugar": None,
    }


def tick(node):
    global _cpu_prev
    if node.simulate:
        _now.update(simulated())
        return
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


def power(node):
    told = node.setting("health", "power")
    sugar = _now.get("pisugar")
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
        parts.append("Wi-Fi %d dBm%s" % (w["dbm"], band))
    p = r["power"]
    if p["source"] == "battery":
        parts.append("Battery %d%%" % p["level"] if "level" in p else "Battery")
        if p.get("level") is not None and p["level"] < 20 and not p.get("charging"):
            warn.append("Battery low: %d%%" % p["level"])
    elif p["source"] == "wall":
        parts.append("Wall power" + (" (battery %d%%)" % p["level"] if "level" in p else ""))
    for d in r.get("drives") or []:
        if d["total"] > 0 and d["free"] < 0.05 * d["total"]:
            warn.append("Drive %s nearly full (%s free)" % (d["mount"], size(d["free"])))
    th = r.get("throttled")
    if th and th["now"]:
        warn.extend(th["now"])
    r["summary"] = " · ".join(parts)
    r["warnings"] = warn
    return r


ACTIONS = {}
