"""
rig.py - Pi Cluster module: this Pi's camera rig, through the Hand Tracker app on it (its remote
recording server, port 47821, asked over this Pi's own Tailscale address as a phone would). Whether
Hand Tracker is installed and running and which build it is, its cameras, recording and Sentry;
Start or Restart Hand Tracker, and Sentry on or off.

updates.py asks busy() (recording or saving: an update waits) and restarts Hand Tracker after an
update with restart_after(), turning Sentry back on if it was on.
"""

import json
import os
import struct
import time
import urllib.error
import urllib.request

TITLE = "Camera rig"
ORDER = 20
ON = True
EVERY = 5
SETTINGS = []

APP_DIR = "/opt/Hand Tracker"
APP_EXE = APP_DIR + "/hand-tracker"
HT_PORT = 47821
HELPER_RECORD = "/var/lib/ht-cluster/hand-tracker.json"  # (what ht-cluster-root last installed)

_now = {"state": None, "error": None, "at": 0}
_installed = {"at": 0, "info": None}


def ht_base(node):
    if node.simulate:
        return os.environ.get("HT_CLUSTER_HT_URL") or "http://127.0.0.1:47821"
    me = node.tailscale.me() or {}
    ip = next((a for a in me.get("ips", []) if ":" not in a), None)
    return "http://%s:%d" % (ip, HT_PORT) if ip else None


def ht(node, method, path, body=None, timeout=6):
    """One request to Hand Tracker's remote recording server here: (status, JSON) or (None, why)."""
    base = ht_base(node)
    if not base:
        return None, "This Pi has no Tailscale address yet."
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")
        except ValueError:
            return e.code, {}
    except (OSError, ValueError) as e:
        return None, str(e)


def asar_file(path, name="package.json"):
    """One file from an Electron app.asar (its header: two pickles, then the JSON of its files)."""
    try:
        with open(path, "rb") as f:
            head = f.read(16)
            if len(head) < 16:
                return None
            _, header_size, _, json_len = struct.unpack("<4I", head)
            header = json.loads(f.read(json_len).decode("utf-8"))
            entry = (header.get("files") or {}).get(name)
            if not entry or "offset" not in entry:
                return None
            f.seek(8 + header_size + int(entry["offset"]))
            return f.read(int(entry["size"]))
    except (OSError, ValueError, struct.error):
        return None


def installed(node, fresh=False):
    """Hand Tracker's package here: {version, commit, built, installedAt} or None (not installed)."""
    if not fresh and time.time() - _installed["at"] < 60:
        return _installed["info"]
    info = None
    if node.simulate:
        # (the checks: what's "installed", from the file their stand-in root helper writes)
        try:
            with open(os.environ.get("HT_CLUSTER_SIM_HT") or "", "r", encoding="utf-8") as f:
                info = dict({"version": "1.1.0", "commit": None, "built": None, "installedAt": None}, **json.load(f))
        except (OSError, ValueError):
            info = None
    else:
        code, out, _ = node.run(["dpkg-query", "-W", "-f", "${Version}\t${db:Status-Status}", "hand-tracker"], 10)
        if code == 0 and out.strip().endswith("installed"):
            info = {"version": out.split("\t")[0], "commit": None, "built": None, "installedAt": None}
            try:
                info["installedAt"] = os.path.getmtime("/var/lib/dpkg/info/hand-tracker.list")
            except OSError:
                pass
            pkg = asar_file(os.path.join(APP_DIR, "resources", "app.asar"))
            try:
                meta = json.loads(pkg.decode("utf-8")) if pkg else {}
            except ValueError:
                meta = {}
            info["built"] = meta.get("buildTime")
            info["commit"] = meta.get("commit")
            try:
                with open(HELPER_RECORD, "r", encoding="utf-8") as f:
                    rec = json.load(f)
                # (the build ht-cluster-root put in, if nothing has been installed since)
                if not info["commit"] and rec.get("commit") and abs((info["installedAt"] or 0) - rec.get("at", 0)) < 600:
                    info["commit"] = rec["commit"]
            except (OSError, ValueError):
                pass
    _installed.update(at=time.time(), info=info)
    return info


def app_process(node):
    """Whether Hand Tracker's main process is running here."""
    if node.simulate:
        return _now["state"] is not None
    try:
        pids = [p for p in os.listdir("/proc") if p.isdigit()]
    except OSError:
        return False
    for pid in pids:
        try:
            with open("/proc/%s/cmdline" % pid, "rb") as f:
                args = f.read().split(b"\0")
        except OSError:
            continue
        if args and args[0].decode("utf-8", "replace") == APP_EXE and not any(a.startswith(b"--type=") for a in args):
            return True
    return False


def tick(node):
    code, st = ht(node, "GET", "/api/state")
    if code == 200 and isinstance(st, dict):
        _now.update(state=st, error=None, at=time.time())
    else:
        _now.update(state=None, error=st if code is None else (st or {}).get("error", "HTTP %s" % code), at=time.time())
    installed(node)


def busy(node):
    """Recording or saving a take right now (asked afresh)."""
    tick(node)
    st = _now["state"] or {}
    return bool(st.get("recording") or st.get("saving"))


def cameras_running(node, fresh=True):
    """Its cameras on (Sentry watching through them, say), recording or saving (jobs.py: a Pi whose
    "Take jobs while its cameras run" is off waits)."""
    if fresh or time.time() - _now["at"] > 10:
        tick(node)
    st = _now["state"] or {}
    return bool(st.get("recording") or st.get("saving") or st.get("running") or (st.get("cameras") or []))


def sentry_on(st):
    return bool(st and isinstance(st.get("sentry"), dict) and st["sentry"].get("armed"))


def restart_after(node, before):
    """After a new Hand Tracker was installed: restart it if it was running (the new one then runs),
    and turn Sentry back on if it was on. -> a sentence for the Pi's events."""
    if not before.get("answering"):
        if before.get("process"):
            return "Hand Tracker uses it from its next restart (its remote recording was off, so it couldn't be restarted from here)."
        return "Hand Tracker wasn't running."
    code, answer = ht(node, "POST", "/api/command", {"action": "restartApp"})
    if code != 200:
        return "Couldn't restart Hand Tracker: %s" % ((answer or {}).get("error") if isinstance(answer, dict) else answer)
    gone_by = time.time() + 30
    while time.time() < gone_by and ht(node, "GET", "/api/state", timeout=3)[0] == 200:
        time.sleep(1)
    back_by = time.time() + 240
    st = None
    while time.time() < back_by:
        c, s = ht(node, "GET", "/api/state", timeout=3)
        if c == 200 and isinstance(s, dict):
            st = s
            break
        time.sleep(2)
    if st is None:
        return "Restarted Hand Tracker, but it hasn't answered since."
    if before.get("sentry") and not sentry_on(st):
        time.sleep(5)  # (its page turns Sentry back on itself as it starts, if it was on)
        c, s = ht(node, "GET", "/api/state", timeout=3)
        if not sentry_on(s if c == 200 else None):
            c, _ = ht(node, "POST", "/api/command", {"action": "sentry", "sentry": {"armed": True}})
            return "Restarted Hand Tracker" + ("; Sentry turned back on." if c == 200 else "; couldn't turn Sentry back on.")
    return "Restarted Hand Tracker."


def before_update(node):
    tick(node)
    st = _now["state"]
    return {"answering": st is not None, "process": app_process(node), "sentry": sentry_on(st)}


def status(node):
    st = _now["state"]
    inst = installed(node)
    out = {"installed": inst, "answering": st is not None}
    warn = []
    if st is None and not inst:
        out["app"] = "not installed"
        out["summary"] = "Hand Tracker isn't installed"
    elif st is None:
        running = app_process(node)
        out["app"] = "running" if running else "not running"
        out["summary"] = "Hand Tracker running, remote recording off" if running else "Hand Tracker isn't running"
    else:
        out["app"] = "running"
        cams = st.get("cameras") or []
        out["cameras"] = [{"name": c.get("name"), "role": c.get("role"), "fps": c.get("fps"), "error": c.get("error"),
                           "oak": bool(c.get("oak")), "chipC": c.get("chipC")} for c in cams if isinstance(c, dict)]
        out["recording"] = bool(st.get("recording"))
        out["saving"] = bool(st.get("saving"))
        out["elapsed"] = int(st.get("elapsed_s") or 0)
        out["sentry"] = sentry_on(st)
        parts = ["Hand Tracker running", "%d camera%s" % (len(cams), "" if len(cams) == 1 else "s")]
        if out["recording"]:
            parts.append("recording %d:%02d" % (out["elapsed"] // 60, out["elapsed"] % 60))
        elif out["saving"]:
            parts.append("saving a take")
        if out["sentry"]:
            parts.append("Sentry on")
        out["summary"] = " · ".join(parts)
        for c in out["cameras"]:
            if c.get("error"):
                warn.append("%s: %s" % (c.get("name") or "A camera", c["error"]))
    out["warnings"] = warn
    return out


def act_restart(node, args):
    code, answer = ht(node, "POST", "/api/command", {"action": "restartApp"})
    if code == 200:
        return {"ok": True, "message": (answer or {}).get("message") or "Restarting Hand Tracker."}
    return {"ok": False, "error": "Couldn't restart Hand Tracker: %s" % ((answer or {}).get("error") if isinstance(answer, dict) else answer)}


def act_start(node, args):
    if app_process(node):
        return {"ok": False, "error": "Hand Tracker is already running."}
    if not installed(node, fresh=True):
        return {"ok": False, "error": "Hand Tracker isn't installed on this Pi."}
    if node.simulate:
        return {"ok": True, "message": "Starting Hand Tracker (simulated)."}
    # (as the desktop starts it at login, waiting for a phone; in a service of its own, so it outlives this one's requests)
    env = {}
    code, out, _ = node.run(["systemctl", "--user", "show-environment"], 5)
    for line in out.splitlines() if code == 0 else []:
        k, _, v = line.partition("=")
        if k in ("WAYLAND_DISPLAY", "DISPLAY"):
            env[k] = v
    env.setdefault("WAYLAND_DISPLAY", "wayland-0")
    env.setdefault("DISPLAY", ":0")
    cmd = ["systemd-run", "--user", "--collect", "--unit=hand-tracker-%d" % int(time.time())]
    cmd += ["--setenv=%s=%s" % kv for kv in env.items()]
    cmd += [APP_EXE, "--remote-standby"]
    code, out, err = node.run(cmd, 15)
    if code != 0:
        return {"ok": False, "error": "Couldn't start Hand Tracker: %s" % (err or out).strip()[:200]}
    return {"ok": True, "message": "Starting Hand Tracker."}


def act_sentry(node, args):
    on = bool(args.get("armed"))
    code, answer = ht(node, "POST", "/api/command", {"action": "sentry", "sentry": {"armed": on}})
    if code == 200:
        return {"ok": True, "message": "Sentry %s." % ("on" if on else "off")}
    return {"ok": False, "error": "Couldn't turn Sentry %s: %s" % ("on" if on else "off", (answer or {}).get("error") if isinstance(answer, dict) else answer)}


ACTIONS = {
    "start": {"title": "Start Hand Tracker", "run": act_start},
    "restart": {"title": "Restart Hand Tracker", "run": act_restart, "confirm": "Restart Hand Tracker on this Pi? A take being recorded is saved first."},
    "sentry": {"title": "Sentry", "run": act_sentry, "hidden": True},
}
