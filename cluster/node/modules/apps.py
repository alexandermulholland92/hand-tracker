"""
apps.py - Cluster module: apps the cluster runs on whichever Pi is free. The first is Transmission.

Transmission's torrents, settings and files stay on one Pi, its home: the Pi with "Transmission's
files and settings are here" on (pi). It runs on whichever Pi is free and allowed to ("Can run
Transmission"), the home first. A Pi stops being free if it's recording, too hot, short of memory,
or its battery is low. When it isn't free, or goes quiet, Transmission moves on.
- On another Pi: the home's folders are mounted (an NFS share, Tailscale's addresses only; the root
  helper's nfs-share) and put back at their own paths for Transmission alone, so every torrent keeps
  its folder.
- On a Windows PC: in a Linux of its own under WSL (Cluster-Linux), the home's folders mounted at their
  own paths there through this service's NFS relay (see "a Windows PC" below).
- Its old address: the home still answers on Transmission's old address (port 9092, the window
  app's, from Tailscale and the home network) and passes it on to wherever Transmission runs, so the
  Jellyfin turtle, Hand Tracker's turtle and the web page keep working.
- Its speed limits: kept on the Wi-Fi by Linux on whichever Pi runs it (this Transmission goes over
  its own).
- Moving the window app's torrents in (Move pi's torrents in): its torrents, their progress and its
  settings are copied over and its own copies put aside, so the window app, if opened again, starts
  empty. Give them back undoes it.
- New downloads: they go wherever they're asked to in your home; a folder that isn't shared yet is
  shared then.
- Each torrent's traffic: the home reads every torrent's speeds every 10 s (the last hour kept as they
  are) and keeps a reading a minute (that minute's average) for 7 days, in its state folder
  (transmission-traffic.jsonl: a line a minute, only the torrents that moved), for the app's graph of
  it over 1 h, 24 h or 7 days.
- Peers and the queue: asking a torrent's trackers (or every torrent's) for more peers, how many peers
  Transmission takes, how many torrents download and seed at once, and a waiting torrent's place in
  the queue.
"""

import collections
import ipaddress
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request

TITLE = "Apps"
ORDER = 50
ON = True
EVERY = 5
# A Windows PC in the cluster: Transmission runs there in a Linux of its own under WSL (its folders at the same
# paths as on the Pis), once that's set up (wsl_ready: setup.py --linux); until then it can't run there. It
# never keeps Transmission's files (they stay on a Pi).
WINDOWS = os.environ.get("HT_CLUSTER_PLATFORM") == "windows"
SETTINGS = [
    {"key": "transmission", "title": "Can run Transmission", "default": True},
] + ([] if WINDOWS else [{"key": "home", "title": "Transmission's files and settings are here", "default": False}])
ASIDE = "moved-to-cluster"  # (in the window app's folder: its own copies of the torrents, put aside when they move here)
OLD_ASIDE = "moved-to-pi-cluster"  # (its name before the rename, 2026-11-25: the home names it again)
TR_PORT = 9093  # the cluster's Transmission's own address (on the Pi running it)
OLD_PORT = 9092  # on its home: the window app's old address, passed on to it
LEASE_S = 60  # a Pi running it says so at least this often, or it's taken as gone
FENCE_S = 45  # a Pi that can't reach the home this long stops it by itself (before the home starts it elsewhere)
BEAT_S = 10
HOT_C = 80
LOW_BATTERY = 30
MIN_MEMORY = 300 << 20
if os.environ.get("HT_CLUSTER_SIM_FAST"):  # (the checks: its waits shorter)
    LEASE_S, FENCE_S, BEAT_S = 12, 8, 2
ALLOWED = [ipaddress.ip_network(n) for n in ("127.0.0.0/8", "::1/128", "100.64.0.0/10", "fd7a:115c:a1e0::/48", "192.168.1.0/24")]
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.+-]{0,59}$")

_lock = threading.RLock()
_beats = {}  # (on the home) Pi -> its last word: {at, running, free, why, canRun, target, cpu}
_run = {"contact": 0, "beat": 0, "names": None, "where": None, "starting": False, "caps": None, "error": None, "home": None}
_fwd = {"server": None, "target": None, "error": None}
_stats = {"at": 0}  # (the home) Transmission's numbers, as its tick last read them
_sid = {}

# Each torrent's traffic (the home): a reading of every torrent's speeds every SAMPLE_S, the last hour of
# them kept as they are; and a reading a minute (that minute's average) for 7 days, on its disk.
SAMPLE_S, MINUTE_S = 10, 60
if os.environ.get("HT_CLUSTER_SIM_FAST"):  # (the checks: minutes of 3 s)
    SAMPLE_S, MINUTE_S = 1, 3
HOUR_S, DAY_S, KEEP_S = 3600, 86400, 7 * 86400
WEEK_BUCKET_S = 10 * MINUTE_S  # (7 days: sent as 10-minute averages, ~1,000 points, enough for a graph)
TRIM_EVERY = 6 * 3600
_tlock = threading.Lock()
_traffic = {"recent": collections.deque(maxlen=HOUR_S // SAMPLE_S + 10), "minute": None, "last": 0, "trimmed": 0}
HASH = re.compile(r"^[0-9a-fA-F]{12,40}$")
# How many download, seed and connect at once: the app's names -> (Transmission's, lowest, highest; None: on/off)
LIMITS = {
    "downloadQueue": ("download-queue-enabled", None, None),
    "downloadQueueSize": ("download-queue-size", 1, 50),
    "seedQueue": ("seed-queue-enabled", None, None),
    "seedQueueSize": ("seed-queue-size", 1, 100),
    "peerLimit": ("peer-limit-global", 10, 1000),
    "peerLimitPerTorrent": ("peer-limit-per-torrent", 2, 300),
    "utp": ("utp-enabled", None, None),  # (off: peers over TCP only, as on pi since 2026-11-20: its router copes worst with UDP)
}


# ----- where things are -----
def home_dir():
    return os.environ.get("HT_CLUSTER_SIM_HOME") or os.path.expanduser("~")


def config_dir(node):
    d = os.environ.get("HT_CLUSTER_TR_CONFIG") if node.simulate else None
    return d or os.path.join(home_dir(), ".local", "share", "ht-cluster", "transmission")


def gtk_dir(node):
    d = os.environ.get("HT_CLUSTER_SIM_GTK") if node.simulate else None
    return d or os.path.join(home_dir(), ".config", "transmission")


def tr_port(node):
    return int(os.environ.get("HT_CLUSTER_TR_PORT", TR_PORT)) if node.simulate else TR_PORT


def old_port(node):
    return int(os.environ.get("HT_CLUSTER_TR_OLD_PORT", OLD_PORT)) if node.simulate else OLD_PORT


def is_home(node):
    return not WINDOWS and bool(node.setting("apps", "home"))


def top_of(path):
    """A path's folder right under your home ("Videos" for ~/Videos/shows/x), or None (not in your home)."""
    home = os.path.realpath(home_dir())
    p = os.path.realpath(path) if not path.startswith(home) else os.path.normpath(path)
    if not p.startswith(home.rstrip(os.sep) + os.sep):
        return None
    first = p[len(home.rstrip(os.sep)) + 1:].split(os.sep)[0]
    return first if NAME.match(first) else None


# ----- Transmission's own requests -----
def rpc(host, port, method, args=None, timeout=10):
    url = "http://%s:%d/transmission/rpc" % (host, port)
    body = json.dumps({"method": method, "arguments": args or {}}).encode()
    for _ in range(2):
        req = urllib.request.Request(url, body, {"Content-Type": "application/json", "X-Transmission-Session-Id": _sid.get(url, "")})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                a = json.loads(r.read().decode("utf-8"))
            if a.get("result") != "success":
                raise RuntimeError(a.get("result") or "it said no")
            return a.get("arguments") or {}
        except urllib.error.HTTPError as e:
            if e.code != 409:
                raise RuntimeError("Transmission answered %d" % e.code)
            _sid[url] = e.headers.get("X-Transmission-Session-Id", "")
    raise RuntimeError("Transmission didn't take its session")


def where_it_runs(node):
    """(host, port) of the cluster's Transmission, from its home: here, or the Pi running it."""
    m = node.memory("apps")
    runner = m.get("runner")
    if not runner:
        return None
    if runner == node.name:
        return ("127.0.0.1", tr_port(node))
    b = _beats.get(runner) or {}
    host = (b.get("target") or "").split(":")[0]
    return (host, b.get("trPort") or TR_PORT) if host else None


def ask_tr(node, method, args=None, timeout=10):
    at = where_it_runs(node)
    if not at:
        raise RuntimeError("Transmission isn't running anywhere just now")
    return rpc(at[0], at[1], method, args, timeout)


# ----- this Pi -----
def wsl_ready(node):
    """A Windows PC's Linux for Transmission is set up: Cluster-Linux is one of WSL's Linuxes (setup.py --linux
    makes it). Looked at once a minute, in the registry (WSL isn't started for it)."""
    if node.simulate:
        return bool(os.environ.get("HT_CLUSTER_SIM_WSL"))
    now = time.time()
    if _wsl["ready"] is None or now - _wsl["readyAt"] > 60:
        try:
            _wsl["ready"] = WSL_DISTRO in winsys().wsl_distros()
        except Exception:  # (no registry key: no WSL at all)
            _wsl["ready"] = False
        _wsl["readyAt"] = now
    return _wsl["ready"]


def can_run(node):
    """Its "Can run Transmission" on, and (a Windows PC) its Linux for it set up."""
    return bool(node.setting("apps", "transmission")) and (not WINDOWS or wsl_ready(node))


def unit_active(node):
    if node.simulate:
        return os.path.exists(os.path.join(node.state_dir, "tr-running"))
    if WINDOWS:
        return wsl_running(node)
    code, out, _ = node.run(["systemctl", "is-active", "ht-cluster-transmission"], 10)
    return out.strip() == "active"


def free(node):
    """Whether this Pi is free to run Transmission: (True, "") or (False, why)."""
    # (recording keeps it off a Pi, but not off its home: its files are there, so another Pi running
    # it would still send everything through the home's Wi-Fi)
    rig = node.modules.get("rig")
    if not is_home(node) and rig and hasattr(rig.mod, "busy") and rig.mod.busy(node):
        return False, "recording"
    h = node.status_of("health") if node.modules.get("health") else {}
    if (h.get("tempC") or 0) >= HOT_C:
        return False, "too hot"
    mem = h.get("memory") or {}
    if mem.get("available") is not None and mem["available"] < MIN_MEMORY:
        return False, "short of memory"
    p = h.get("power") or {}
    if p.get("source") == "battery" and p.get("level") is not None and p["level"] < LOW_BATTERY and not p.get("charging"):
        return False, "battery low"
    return True, ""


# ----- moving the window app's torrents in, and back -----
def bdecode_destination(data):
    """A Transmission .resume file's "destination" (its torrent's folder), read from its bencoding."""
    m = re.search(rb"11:destination(\d+):", data)
    if not m:
        return None
    n = int(m.group(1))
    start = m.end()
    return data[start:start + n].decode("utf-8", "replace")


def act_migrate(node, args):
    if not is_home(node):
        return {"ok": False, "error": "This isn't the Pi that keeps Transmission's files (its switch under ⚙)."}
    mem = node.memory("apps")
    if mem.get("migrated"):
        return {"ok": False, "error": "Its torrents are in the cluster's Transmission already."}
    g, c = gtk_dir(node), config_dir(node)
    if not os.path.isdir(os.path.join(g, "torrents")):
        return {"ok": False, "error": "No Transmission window app's torrents here (%s)." % g}
    try:
        with open(os.path.join(g, "settings.json"), "r", encoding="utf-8") as f:
            settings = json.load(f)
    except (OSError, ValueError):
        settings = {}
    places = set()
    for name in os.listdir(os.path.join(g, "resume")) if os.path.isdir(os.path.join(g, "resume")) else []:
        try:
            with open(os.path.join(g, "resume", name), "rb") as f:
                d = bdecode_destination(f.read())
            if d:
                places.add(d)
        except OSError:
            pass
    places.add(settings.get("download-dir") or os.path.join(home_dir(), "Downloads"))
    names = sorted({top_of(p) for p in places if top_of(p)})
    outside = sorted(p for p in places if not top_of(p))
    # The window app, ended as its own way (it writes each torrent's progress first).
    pids = [p for p in node.run(["pgrep", "-x", "transmission-gt"], 10)[1].split()] if not node.simulate else []
    for pid in pids:
        try:
            os.kill(int(pid), signal.SIGTERM)
        except (OSError, ValueError):
            pass
    until = time.time() + 60
    while pids and time.time() < until and node.run(["pgrep", "-x", "transmission-gt"], 10)[0] == 0:
        time.sleep(1)
    if pids and node.run(["pgrep", "-x", "transmission-gt"], 10)[0] == 0:
        return {"ok": False, "error": "The Transmission window app didn't close; close it, then try again."}
    os.makedirs(c, exist_ok=True)
    for part in ("torrents", "resume", "blocklists"):
        src = os.path.join(g, part)
        if os.path.isdir(src):
            shutil.copytree(src, os.path.join(c, part), dirs_exist_ok=True)
    for part in ("dht.dat", "bandwidth-groups.json", "stats.json", "queue.json"):
        if os.path.exists(os.path.join(g, part)):
            shutil.copyfile(os.path.join(g, part), os.path.join(c, part))
    s = dict(settings)
    s.update({"rpc-enabled": True, "rpc-port": tr_port(node), "rpc-bind-address": "0.0.0.0",
              "rpc-whitelist-enabled": True, "rpc-whitelist": "127.0.0.1,::1,100.*.*.*,192.168.1.*",
              "rpc-authentication-required": False, "umask": settings.get("umask", "022")})
    with open(os.path.join(c, "settings.json"), "w", encoding="utf-8") as f:
        json.dump(s, f, indent=4)
    # The window app's own copies put aside (its settings stay: pi/download-cap.sh reads its port there).
    aside = os.path.join(g, ASIDE)
    os.makedirs(aside, exist_ok=True)
    for part in ("torrents", "resume", "queue.json"):
        if os.path.exists(os.path.join(g, part)):
            shutil.move(os.path.join(g, part), os.path.join(aside, part))
    with open(os.path.join(aside, "README.txt"), "w", encoding="utf-8") as f:
        f.write("These torrents moved into Cluster's Transmission (%s) on %s.\n"
                "Cluster's app: Give them back to the window app moves them back here.\n" % (c, time.strftime("%Y-%m-%d %H:%M")))
    n = len(os.listdir(os.path.join(c, "torrents")))
    mem.update(migrated=True, names=names, outside=outside, runner=None, handing=None, prefer=None)
    mem.save()
    answer = node.root("nfs-share", *names, timeout=1800) if names else {"ok": True}
    note = "" if answer.get("ok") else " (sharing its folders didn't work yet: %s; it runs here meanwhile)" % answer.get("error")
    node.event("apps", "Transmission moved into the cluster: %d torrents, each in its own folder%s." % (n, note))
    _wake(node)
    return {"ok": True, "message": "Moved %d torrents in. Transmission starts on a free Pi in a moment." % n}


def act_give_back(node, args):
    """Undo: the torrents (with their progress now) back to the window app; the cluster's stops."""
    if not is_home(node):
        return {"ok": False, "error": "This isn't the Pi that keeps Transmission's files."}
    mem = node.memory("apps")
    if not mem.get("migrated"):
        return {"ok": False, "error": "Nothing to give back."}
    mem.update(migrated=False, handing={"from": mem.get("runner") or "", "at": time.time()}, runner=None, prefer=None)
    mem.save()
    deadline = time.time() + 90
    while time.time() < deadline and any(b.get("running") and time.time() - b.get("at", 0) < 30 for b in _beats.values()):
        time.sleep(2)
    g, c = gtk_dir(node), config_dir(node)
    for part in ("torrents", "resume"):
        if os.path.isdir(os.path.join(c, part)):
            shutil.copytree(os.path.join(c, part), os.path.join(g, part), dirs_exist_ok=True)
    node.root("nfs-unshare", timeout=600)
    _stop_forwarder()
    node.event("apps", "Transmission's torrents went back to the window app; open it to go on.")
    return {"ok": True, "message": "Given back: open Transmission's window app on %s to go on." % node.name}


# ----- the home: who runs it -----
def choose(node, mem):
    now = time.time()
    ok = lambda n: n in _beats and now - _beats[n]["at"] < LEASE_S and _beats[n]["canRun"] and _beats[n]["free"]
    if mem.get("outside"):  # (a torrent saving outside your home: only here)
        return node.name if ok(node.name) else None
    prefer = mem.get("prefer")
    if prefer and ok(prefer):
        return prefer
    if ok(node.name):
        return node.name
    rest = sorted((n for n in _beats if ok(n)), key=lambda n: (_beats[n].get("cpu") or 0))
    return rest[0] if rest else None


def home_tick(node):
    mem = node.memory("apps")
    if not mem.get("migrated"):
        return
    # (the window app's copies put aside before the rename, 2026-11-25: under the new name)
    old = os.path.join(gtk_dir(node), OLD_ASIDE)
    if os.path.isdir(old) and not os.path.lexists(os.path.join(gtk_dir(node), ASIDE)):
        try:
            os.rename(old, os.path.join(gtk_dir(node), ASIDE))
        except OSError:
            pass
    now = time.time()
    with _lock:
        runner, handing = mem.get("runner"), mem.get("handing")
        b = _beats.get(runner) if runner else None
        if runner and (not b or now - b["at"] > LEASE_S):
            handing, runner = {"from": runner, "at": now}, None
            node.event("apps", "Transmission's Pi went quiet: it moves on.")
        elif runner and (not b["canRun"] or not b["free"] or (mem.get("prefer") and mem["prefer"] != runner and choose(node, mem) == mem["prefer"])):
            handing, runner = {"from": runner, "at": now}, None
        if handing:
            hb = _beats.get(handing["from"]) or {}
            stopped = hb.get("at", 0) > handing["at"] and not hb.get("running")
            quiet = now - hb.get("at", 0) > FENCE_S + 15
            if stopped or quiet or not handing["from"]:
                handing = None
        if not runner and not handing:
            runner = choose(node, mem)
            if runner:
                node.event("apps", "Transmission runs on %s now." % runner)
        if (runner, handing) != (mem.get("runner"), mem.get("handing")):
            mem.update(runner=runner, handing=handing)
            mem.save()
    _keep_forwarder(node)
    try:
        st = ask_tr(node, "session-stats", timeout=3)
        s = ask_tr(node, "session-get", {"fields": ["alt-speed-enabled"] + [v[0] for v in LIMITS.values()]}, timeout=3)
        _stats.update(at=time.time(), torrents=st.get("torrentCount"), down=st.get("downloadSpeed"), up=st.get("uploadSpeed"), turtle=bool(s.get("alt-speed-enabled")),
                      session={k: s.get(v[0]) for k, v in LIMITS.items() if s.get(v[0]) is not None})
    except (RuntimeError, OSError):
        pass
    sample_traffic(node)
    # New folders torrents save into (added from its web page, say): shared too.
    if now - mem.get("foldersAt", 0) > 60 and runner:
        mem["foldersAt"] = now
        try:
            dirs = {t.get("downloadDir") for t in ask_tr(node, "torrent-get", {"fields": ["downloadDir"]}).get("torrents", [])}
            new = sorted({top_of(d) for d in dirs if d and top_of(d)} - set(mem.get("names") or []))
            outside = sorted(d for d in dirs if d and not top_of(d))
            if new:
                share(node, sorted(set(mem.get("names") or []) | set(new)))
            if outside != mem.get("outside", []):
                mem["outside"] = outside
            mem.save()
        except (RuntimeError, OSError):
            pass


# ----- each torrent's traffic (the home) -----
def traffic_file(node):
    return os.path.join(node.state_dir, "transmission-traffic.jsonl")


def sample_traffic(node):
    """A reading of every torrent's speeds (only the moving ones kept), every SAMPLE_S; each minute's average
    written to its file as the next minute starts. No reading (Transmission moving, say): a gap."""
    now = time.time()
    if now - _traffic["last"] < SAMPLE_S - 0.5:
        return
    _traffic["last"] = now
    try:
        got = ask_tr(node, "torrent-get", {"fields": ["hashString", "rateDownload", "rateUpload"]}, timeout=5).get("torrents", [])
    except (RuntimeError, OSError):
        return
    moving = {}
    for t in got:
        d, u = int(t.get("rateDownload") or 0), int(t.get("rateUpload") or 0)
        if (d or u) and HASH.match(str(t.get("hashString") or "")):
            moving[t["hashString"][:12].lower()] = (d, u)
    start = now - now % MINUTE_S
    with _tlock:
        _traffic["recent"].append((now, moving))
        m = _traffic["minute"]
        if m and m["t"] != start:
            line = {"t": int(m["t"]), "r": {k: [round(s[0] / m["n"]), round(s[1] / m["n"])] for k, s in m["sum"].items()}}
            try:
                with open(traffic_file(node), "a", encoding="utf-8") as f:
                    f.write(json.dumps(line, separators=(",", ":")) + "\n")
            except OSError:
                pass
            m = None
        if not m:
            m = _traffic["minute"] = {"t": start, "n": 0, "sum": {}}
        m["n"] += 1
        for k, (d, u) in moving.items():
            s = m["sum"].setdefault(k, [0, 0])
            s[0] += d
            s[1] += u
        if now - _traffic["trimmed"] > TRIM_EVERY:
            _traffic["trimmed"] = now
            trim_traffic(node, now)


def trim_traffic(node, now):
    """The file without its minutes older than 7 days (under _tlock)."""
    path = traffic_file(node)
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return
    keep = [l for l in lines if minute_of(l) is not None and minute_of(l) >= now - KEEP_S]
    if len(keep) == len(lines):
        return
    try:
        with open(path + ".new", "w", encoding="utf-8") as f:
            f.writelines(keep)
        os.replace(path + ".new", path)
    except OSError:
        pass


def minute_of(line):
    """A line's minute ({"t":…,…}), read without parsing all of it."""
    try:
        return int(line[5:line.index(",")])
    except ValueError:
        return None


def minutes(node, key, frm, to):
    """One torrent's readings a minute from frm to to: [[ms, down, up], …], 0 where it didn't move; none
    where nothing was read (a gap)."""
    out = []
    try:
        with open(traffic_file(node), "r", encoding="utf-8") as f:
            for line in f:
                t = minute_of(line)
                if t is None or t < frm or t > to:
                    continue
                d, u = 0, 0
                if '"%s"' % key in line:
                    try:
                        d, u = json.loads(line)["r"][key]
                    except (ValueError, KeyError, TypeError):
                        continue
                out.append([t * 1000, d, u])
    except OSError:
        pass
    with _tlock:
        m = _traffic["minute"]
        if m and m["n"] and frm <= m["t"] <= to:  # (the minute going on, so far)
            s = m["sum"].get(key) or [0, 0]
            out.append([int(m["t"]) * 1000, round(s[0] / m["n"]), round(s[1] / m["n"])])
    return out


def act_traffic(node, args):
    """A torrent's speeds over the last hour (a reading every 10 s), 24 hours (a minute) or 7 days (10-minute
    averages of the minutes): {"points": [[ms, down, up], …], "every": seconds}."""
    h, span = str(args.get("hash") or ""), args.get("span") or "1h"
    if not HASH.match(h):
        return {"ok": False, "error": "Which torrent?"}
    if span not in ("1h", "24h", "7d"):
        return {"ok": False, "error": "A span of 1h, 24h or 7d."}
    key, now = h[:12].lower(), time.time()
    if span == "1h":
        with _tlock:
            pts = [[int(t * 1000), *(r.get(key) or (0, 0))] for t, r in _traffic["recent"] if t >= now - HOUR_S]
        first = pts[0][0] / 1000 if pts else now
        # (before this service's own readings, after a restart: the minutes on its disk)
        return {"ok": True, "span": span, "every": SAMPLE_S, "points": minutes(node, key, now - HOUR_S, first - MINUTE_S) + pts}
    if span == "24h":
        return {"ok": True, "span": span, "every": MINUTE_S, "points": minutes(node, key, now - DAY_S, now)}
    buckets = collections.OrderedDict()
    for t, d, u in minutes(node, key, now - KEEP_S, now):
        b = buckets.setdefault(t // 1000 // WEEK_BUCKET_S * WEEK_BUCKET_S, [0, 0, 0])
        b[0] += d
        b[1] += u
        b[2] += 1
    return {"ok": True, "span": span, "every": WEEK_BUCKET_S,
            "points": [[t * 1000, round(d / n), round(u / n)] for t, (d, u, n) in buckets.items()]}


def share(node, names):
    mem = node.memory("apps")
    answer = node.root("nfs-share", *names, timeout=1800)
    if answer.get("ok"):
        mem["names"] = answer.get("shared") or names
        mem.save()
        node.event("apps", "Shared for Transmission: %s." % ", ".join("~/" + n for n in mem["names"]))
    return answer


def act_lease(node, args):
    """A Pi's word (every BEAT_S): whether it runs Transmission, whether it's free -> run it or not."""
    if not is_home(node):
        return {"ok": False, "error": "%s doesn't keep Transmission's files." % node.name}
    worker = str(args.get("worker") or "")
    if not worker:
        return {"ok": False, "error": "Who's asking?"}
    with _lock:
        _beats[worker] = {"at": time.time(), "running": bool(args.get("running")), "free": bool(args.get("free")), "why": args.get("why") or "",
                          "canRun": bool(args.get("canRun")), "target": str(args.get("target") or ""), "cpu": args.get("cpu"),
                          "trPort": int(args.get("trPort") or TR_PORT)}
        mem = node.memory("apps")
        run = bool(mem.get("migrated")) and mem.get("runner") == worker and not mem.get("handing")
        where = "local" if worker == node.name else (node.target() or "").split(":")[0]
    # (homeDir: where its folders are here, for a Windows PC's Linux to mount them at the same paths)
    return {"ok": True, "run": run, "where": where, "names": mem.get("names") or [], "homeDir": os.path.normpath(home_dir())}


# ----- every Pi: running it when the home says so -----
def find_home(node):
    if is_home(node):
        return {"name": node.name, "target": node.target()}
    for fresh in (False, True):
        for p in node.cluster(fresh=fresh):
            a = next((m for m in p["node"].get("modules", []) if m["name"] == "apps"), None)
            if a and a.get("on") and (a.get("status") or {}).get("home"):
                return {"name": p["name"], "target": p["target"]}
    return None


def runner_tick(node):
    now = time.time()
    if now - _run["beat"] < BEAT_S:
        return
    slept = WINDOWS and not node.simulate and _run["beat"] and now - _run["beat"] > LEASE_S
    _run["beat"] = now
    running = unit_active(node)
    if slept and running:
        # (a Windows PC that was asleep: the home may have started Transmission elsewhere meanwhile, so it stops
        # here before it saves anything; the home hands it back if it hadn't moved)
        stop_here(node, "this PC was asleep")
        running = False
    home = _run["home"] if _run["home"] and now - _run["contact"] < 120 else find_home(node)
    if not home:
        if running and now - _run["contact"] > FENCE_S:
            stop_here(node, "can't reach the Pi with Transmission's files")
        return
    _run["home"] = home
    ok, why = free(node)
    h = node.status_of("health") if node.modules.get("health") else {}
    words = {"worker": node.name, "running": running, "free": ok, "why": why, "canRun": can_run(node),
             "target": node.target() or "", "cpu": h.get("cpu"), "trPort": tr_port(node)}
    if home["name"] == node.name:
        code, a = 200, act_lease(node, words)
    else:
        code, a = node.ask(home["target"], "POST", "/api/action", {"module": "apps", "action": "lease", "args": words}, timeout=15)
    if code != 200 or not isinstance(a, dict) or not a.get("ok"):
        if running and now - _run["contact"] > FENCE_S:
            stop_here(node, "can't reach %s, which has Transmission's files" % home["name"])
        return
    _run["contact"] = now
    if a.get("homeDir"):
        _run["homeDir"] = a["homeDir"]
    if a.get("run"):
        if running and _run["names"] is None and not _run["starting"] and kept(node, a["where"], a.get("names") or []):
            # (running already: this service restarted, an update say, and left it going. Started again, it
            # would ask every torrent's trackers and peers at once, which twice set pi's router off)
            _run.update(names=a.get("names") or [], where=a["where"], error=None)
            mem = node.memory("apps")
            if mem.get("started") is None:  # (the note the version before didn't write)
                mem["started"] = {"where": a["where"], "names": list(a.get("names") or [])}
                mem.save()
            node.event("apps", "Transmission kept running through this service's restart.")
            keep_caps(node)
        elif not running or a.get("names") != _run["names"] or a.get("where") != _run["where"]:
            start_here(node, a["where"], a.get("names") or [])
        else:
            keep_caps(node)
    elif running:
        stop_here(node, "%s asked it to stop" % home["name"])


def kept(node, where, names):
    """Whether the Transmission running here is the one this service started before it restarted, with these
    files: its note says so, or, with no note (started by a version that didn't write one), it's this Pi's own
    files (only another Pi's are bound in, so nothing else can differ)."""
    started = node.memory("apps").get("started")
    if started is None:
        return where == "local"
    return started.get("where") == where and sorted(started.get("names") or []) == sorted(names)


def start_here(node, where, names):
    if _run["starting"]:
        return
    _run["starting"] = True

    def go():
        try:
            if WINDOWS and not node.simulate:
                why, relay = start_wsl(node, where, names)
                if why:
                    _run["error"] = "Transmission didn't start: %s" % why
                    node.event("apps", _run["error"], bad=True)
                    return
                _run.update(names=names, where=where, error=None, caps=None)
                mem = node.memory("apps")
                mem["started"] = {"where": where, "names": list(names), "relay": relay}  # (kept through this service's restarts)
                mem.save()
                node.event("apps", "Transmission started here, in this PC's Linux (its files from %s)." % where)
                return
            if not node.simulate and not os.path.exists("/usr/bin/transmission-daemon") or not node.simulate and not shutil.which("mount.nfs4"):
                a = node.root("install-transmission", timeout=1800)
                if not a.get("ok"):
                    _run["error"] = "Transmission didn't install: %s" % a.get("error")
                    return
            a = node.root("transmission-start", where, *names, timeout=600)
            if a.get("ok"):
                _run.update(names=names, where=where, error=None, caps=None)
                mem = node.memory("apps")
                mem["started"] = {"where": where, "names": list(names)}  # (kept through this service's restarts)
                mem.save()
                node.event("apps", "Transmission started here%s." % ("" if where == "local" else " (its files from " + where + ")"))
            else:
                _run["error"] = "Transmission didn't start: %s" % a.get("error")
                node.event("apps", _run["error"], bad=True)
        finally:
            _run["starting"] = False
    threading.Thread(target=go, daemon=True).start()


def stop_here(node, why):
    a = {"ok": stop_wsl(node)} if WINDOWS and not node.simulate else node.root("transmission-stop", timeout=300)
    _run.update(names=None, where=None, caps=None)
    mem = node.memory("apps")
    if mem.pop("started", None) is not None:
        mem.save()
    node.event("apps", "Transmission stopped here: %s." % why, bad=not a.get("ok"))


def keep_caps(node):
    """Its own download and upload limits (the turtle's when on), kept on the Wi-Fi by Linux."""
    if WINDOWS and not node.simulate:  # (a Windows PC: Transmission's own limits only; its relay and address kept up)
        keep_wsl_links(node)
        return
    try:
        s = rpc("127.0.0.1", tr_port(node), "session-get", {"fields": ["alt-speed-enabled", "alt-speed-down", "alt-speed-up",
                                                                         "speed-limit-down", "speed-limit-down-enabled", "speed-limit-up", "speed-limit-up-enabled"]}, timeout=5)
    except (RuntimeError, OSError):
        return
    def lim(way):
        if s.get("alt-speed-enabled"):
            return str(max(1, int(s.get("alt-speed-" + way) or 1)))
        if s.get("speed-limit-%s-enabled" % way):
            return str(max(1, int(s.get("speed-limit-" + way) or 1)))
        return "none"
    caps = (lim("down"), lim("up"))
    if caps != _run["caps"]:
        a = node.root("transmission-cap", *caps, timeout=60)
        if a.get("ok"):
            _run["caps"] = caps


# ----- a Windows PC: Transmission in its own Linux (WSL) -----
# Cluster-Linux (setup.py --linux: Debian 13 with the Pis' transmission-daemon and the NFS client) runs
# windows/transmission.sh as root through wsl.exe: the home's folders mounted at their own paths, then Transmission,
# in the foreground for as long as it runs (wsl.exe running it keeps that Linux up, and goes on through this
# service's own restarts). Two things on Windows' side, in this service:
# - the NFS relay: WSL's connections reach the home from ports above 1023 (WSL's network changes them), which the
#   home's share turns away ("secure"); the relay, on Windows' side of WSL's network and for that Linux alone,
#   passes them on from ports below 1024 (any program may use those on Windows).
# - Transmission's address: WSL passes this PC's 127.0.0.1:9093 on to it; the home reaches it at this PC's
#   Tailscale address, passed on to that.
# Its speed limits are Transmission's own here (no nft).
WSL_DISTRO = "Cluster-Linux"
NFS_RELAY_PORT = 47832  # (on Windows' side of WSL's network only)
TR_CONFIG_REL = ".local/share/ht-cluster/transmission"  # (ht-cluster-root's TR_CONFIG, in the home's home)
CREATE_NO_WINDOW, CREATE_NEW_PROCESS_GROUP = 0x08000000, 0x00000200
_wsl = {"proc": None, "ready": None, "readyAt": 0}
_links = {"relay": None, "relayKey": None, "tr": None, "trKey": None}


def winsys():
    import winsys as w  # (cluster/node/winsys.py: Windows only)
    return w


def wsl_exe():
    return os.path.join(os.environ.get("SystemRoot") or r"C:\Windows", "System32", "wsl.exe")


def wsl_path(p):
    """A Windows path as WSL's Linux sees it (C:\\Users\\... -> /mnt/c/Users/...)."""
    drive, rest = os.path.splitdrive(os.path.abspath(p))
    return "/mnt/%s%s" % (drive[:1].lower(), rest.replace("\\", "/"))


def wsl_script(node):
    """windows/transmission.sh as that Linux reads it: a copy with Linux's line ends, in the state folder."""
    src = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "windows", "transmission.sh")
    with open(src, "rb") as f:
        data = f.read().replace(b"\r\n", b"\n")
    dst = os.path.join(node.state_dir, "transmission-wsl.sh")
    try:
        with open(dst, "rb") as f:
            same = f.read() == data
    except OSError:
        same = False
    if not same:
        with open(dst + ".new", "wb") as f:
            f.write(data)
        os.replace(dst + ".new", dst)
    return wsl_path(dst)


def wsl_cmd(node, words):
    return [wsl_exe(), "-d", WSL_DISTRO, "-u", "root", "--exec", "/bin/sh", wsl_script(node)] + [str(w) for w in words]


def wsl_call(node, words, timeout=60):
    """transmission.sh <words> in Cluster-Linux, as root: (exit code, what it said)."""
    code, out, err = node.run(wsl_cmd(node, words), timeout, dict(os.environ, WSL_UTF8="1"))
    return code, (out + "\n" + err).replace("\x00", "").strip()


def wsl_pid_file(node):
    return os.path.join(node.state_dir, "transmission-wsl.pid")


def wsl_running(node):
    """Transmission's wsl.exe (started by this service, or by it before a restart) is still going."""
    p = _wsl["proc"]
    if p is not None:
        if p.poll() is None:
            return True
        _wsl["proc"] = None
    path = wsl_pid_file(node)
    try:
        with open(path, "r", encoding="utf-8") as f:
            pid = int(f.read().split()[0])
        since = os.path.getmtime(path)
    except (OSError, ValueError, IndexError):
        return False
    w = winsys()
    if since < time.time() - w.uptime() or (w.exe_of(pid) or "").lower() != "wsl.exe":  # (Windows started since, or it ended)
        try:
            os.remove(path)
        except OSError:
            pass
        return False
    return True


def _ipv4(s):
    try:
        return ipaddress.ip_address(s).version == 4
    except ValueError:
        return False


def home_folder(node):
    """The home's own home folder (its lease answer says; a home from before that: its folders action)."""
    if _run.get("homeDir"):
        return _run["homeDir"]
    home = _run.get("home") or {}
    if home.get("target"):
        code, a = node.ask(home["target"], "POST", "/api/action", {"module": "apps", "action": "folders", "args": {}}, timeout=15)
        if code == 200 and isinstance(a, dict) and a.get("ok") and a.get("home"):
            _run["homeDir"] = a["home"]
    return _run.get("homeDir")


def _reserved_connect(host, port):
    """A connection to host:port from a port below 1024 (the home's NFS share takes only those)."""
    for local in range(1023, 599, -1):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(("0.0.0.0", local))
        except OSError:
            s.close()
            continue
        try:
            s.settimeout(15)
            s.connect((host, port))
            s.settimeout(None)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            return s
        except OSError as e:
            s.close()
            if getattr(e, "winerror", None) in (10048, 10013, 10049):  # (that port taken just then, for this address: the next one)
                continue
            raise
    raise OSError("no port below 1024 free here")


def _serve_relay(server, peer, upstream):
    while _links["relay"] is server:
        try:
            conn, addr = server.accept()
        except OSError:
            break
        if addr[0] != peer:  # (that Linux alone)
            conn.close()
            continue
        try:
            up = _reserved_connect(*upstream)
        except OSError:
            conn.close()
            continue
        threading.Thread(target=_pipe, args=(conn, up), daemon=True).start()
        threading.Thread(target=_pipe, args=(up, conn), daemon=True).start()


def _serve_tr(server, target):
    while _links["tr"] is server:
        try:
            conn, addr = server.accept()
        except OSError:
            break
        if not _allowed(addr[0]):
            conn.close()
            continue
        try:
            up = socket.create_connection(target, timeout=10)
            up.settimeout(None)
        except OSError:
            conn.close()
            continue
        threading.Thread(target=_pipe, args=(conn, up), daemon=True).start()
        threading.Thread(target=_pipe, args=(up, conn), daemon=True).start()


def _listen(addr):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(addr)
    s.listen(32)
    return s


def keep_relay(gw, vm, home_ip):
    """The NFS relay: on gw (Windows' side of WSL's network), for vm (that Linux) alone, to the home's NFS. -> None,
    or why it couldn't."""
    key = (gw, vm, home_ip)
    if _links["relay"] and _links["relayKey"] == key:
        return None
    _close("relay")
    try:
        s = _listen((gw, NFS_RELAY_PORT))
    except OSError as e:
        return "Its relay for the home's folders couldn't listen on %s:%d: %s" % (gw, NFS_RELAY_PORT, e)
    _links.update(relay=s, relayKey=key)
    threading.Thread(target=_serve_relay, args=(s, vm, (home_ip, 2049)), daemon=True).start()
    return None


def keep_tr_link(node):
    """Transmission's address at this PC's Tailscale address (for the home and the app), passed on to WSL's."""
    ip = (node.target() or "").split(":")[0]
    if not _ipv4(ip):
        return
    key = (ip, tr_port(node))
    if _links["tr"] and _links["trKey"] == key:
        return
    _close("tr")
    try:
        s = _listen(key)
    except OSError:
        return
    _links.update(tr=s, trKey=key)
    threading.Thread(target=_serve_tr, args=(s, ("127.0.0.1", tr_port(node))), daemon=True).start()


def _close(which):
    s = _links[which]
    _links[which] = None
    _links[which + "Key"] = None
    if s:
        try:
            s.close()
        except OSError:
            pass


def keep_wsl_links(node):
    """While Transmission runs here: its relay and its address kept up (again after this service restarted)."""
    r = (node.memory("apps").get("started") or {}).get("relay") or {}
    if r.get("gw") and r.get("vm") and r.get("home"):
        keep_relay(r["gw"], r["vm"], r["home"])
    keep_tr_link(node)


def wsl_log(node):
    path = os.path.join(node.state_dir, "transmission-wsl.log")
    try:
        if os.path.getsize(path) > 1 << 20:
            os.replace(path, path + ".1")
    except OSError:
        pass
    return path


def last_said(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = [l.strip() for l in f.read().replace("\x00", "").splitlines() if l.strip()]
        return lines[-1][:300] if lines else "nothing said"
    except OSError:
        return "nothing said"


def start_wsl(node, where, names):
    """Transmission started in this PC's Linux, the home's folders from where: -> (None, the relay's addresses), or
    (why not, None)."""
    if not _ipv4(where or ""):
        return "this PC doesn't keep Transmission's files", None
    home = home_folder(node)
    if not home or not home.startswith("/home/"):
        return "couldn't learn where the home keeps its folders", None
    stop_wsl(node, quiet=True)
    code, out = wsl_call(node, ["net"], 120)
    parts = out.split()
    if code != 0 or len(parts) < 2 or not _ipv4(parts[0]) or not _ipv4(parts[1]):
        return "this PC's Linux didn't start (%s)" % (out.splitlines()[-1][:200] if out else code), None
    gw, vm = parts[0], parts[1]
    why = keep_relay(gw, vm, where)
    if why:
        return why, None
    log = wsl_log(node)
    with open(log, "ab") as f:
        f.write(("%s starting, its folders from %s: %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), where, ", ".join(names))).encode("utf-8"))
        f.flush()
        since = f.tell()
        p = subprocess.Popen(wsl_cmd(node, ["start", gw, NFS_RELAY_PORT, home, TR_CONFIG_REL] + list(names)), stdout=f, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, env=dict(os.environ, WSL_UTF8="1"), creationflags=CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
    _wsl["proc"] = p
    with open(wsl_pid_file(node), "w", encoding="utf-8") as f:
        f.write("%d\n" % p.pid)
    # (started once its folders are mounted and Transmission launched, as on a Pi: not waiting for it to answer,
    # which over a slow Wi-Fi can take minutes, reading every torrent's progress from the home)
    deadline = time.time() + 600
    while time.time() < deadline:
        if p.poll() is not None:
            _close("relay")
            return "it ended at once: %s" % last_said(log), None
        try:
            with open(log, "rb") as f:
                f.seek(since)
                if b"transmission.sh: running" in f.read():
                    break
        except OSError:
            pass
        time.sleep(2)
    else:
        stop_wsl(node, quiet=True)
        return "its folders weren't mounted within 10 minutes: %s" % last_said(log), None
    keep_tr_link(node)
    return None, {"gw": gw, "vm": vm, "home": where}


def stop_wsl(node, quiet=False):
    """Transmission here stopped (it saves its torrents' progress first: up to 2 minutes), its folders let go, and
    its relay and address closed. -> whether it stopped cleanly."""
    ok = True
    if wsl_running(node) or not quiet:
        code, out = wsl_call(node, ["stop"], 180)
        ok = code == 0
    p = _wsl["proc"]
    if p is not None:
        try:
            p.wait(30)
        except subprocess.TimeoutExpired:
            p.kill()
            ok = False
        _wsl["proc"] = None
    elif wsl_running(node):  # (started by this service before it restarted)
        try:
            with open(wsl_pid_file(node), "r", encoding="utf-8") as f:
                pid = int(f.read().split()[0])
            for _ in range(30):
                if (winsys().exe_of(pid) or "").lower() != "wsl.exe":
                    break
                time.sleep(1)
            else:
                winsys().stop(pid)
                ok = False
        except (OSError, ValueError, IndexError):
            pass
    try:
        os.remove(wsl_pid_file(node))
    except OSError:
        pass
    _close("tr")
    _close("relay")
    return ok


# ----- the home: its old address, passed on -----
def _allowed(addr):
    try:
        ip = ipaddress.ip_address(addr.split("%")[0])
        if ip.version == 6 and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        return any(ip in n for n in ALLOWED if n.version == ip.version)
    except ValueError:
        return False


def _pipe(a, b):
    try:
        while True:
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def _serve_forwarder(node, server):
    while _fwd["server"] is server:
        try:
            conn, addr = server.accept()
        except OSError:
            break
        target = _fwd["target"]
        if not target or not _allowed(addr[0]):
            conn.close()
            continue
        try:
            up = socket.create_connection(target, timeout=10)
            up.settimeout(None)
        except OSError:
            conn.close()
            continue
        threading.Thread(target=_pipe, args=(conn, up), daemon=True).start()
        threading.Thread(target=_pipe, args=(up, conn), daemon=True).start()


def _keep_forwarder(node):
    _fwd["target"] = where_it_runs(node)
    if _fwd["server"] or not _fwd["target"]:
        return
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1" if node.simulate else "0.0.0.0", old_port(node)))
        s.listen(32)
    except OSError as e:
        _fwd["error"] = "Its old address (port %d) is taken: is the Transmission window app open?" % old_port(node)
        return
    _fwd.update(server=s, error=None)
    threading.Thread(target=_serve_forwarder, args=(node, s), daemon=True).start()


def _stop_forwarder():
    s = _fwd["server"]
    _fwd["server"] = None
    if s:
        try:
            s.close()
        except OSError:
            pass


def _wake(node):
    m = node.modules.get("apps")
    if m:
        m.wake.set()


def tick(node):
    # (this Pi's own word first: the home weighs itself with the others when it chooses)
    if can_run(node) or unit_active(node) or _run["names"] is not None:
        runner_tick(node)
    if is_home(node):
        home_tick(node)


# ----- the app's buttons -----
def act_move(node, args):
    if not is_home(node):
        return {"ok": False, "error": "Ask the Pi that keeps Transmission's files."}
    to = args.get("to") or None
    mem = node.memory("apps")
    mem["prefer"] = to
    mem.save()
    _wake(node)
    return {"ok": True, "message": ("Moving Transmission to %s (once it's free)." % to) if to else "Transmission goes wherever's free."}


def act_turtle(node, args):
    try:
        ask_tr(node, "session-set", {"alt-speed-enabled": bool(args.get("on"))})
    except (RuntimeError, OSError) as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "message": "Turtle %s." % ("on" if args.get("on") else "off")}


def act_torrents(node, args):
    try:
        t = ask_tr(node, "torrent-get", {"fields": ["id", "name", "percentDone", "status", "rateDownload", "rateUpload", "downloadDir", "errorString", "eta", "totalSize",
                                                    "hashString", "downloadedEver", "uploadedEver", "queuePosition", "peersConnected", "addedDate"]})
    except (RuntimeError, OSError) as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "torrents": t.get("torrents", [])}


def act_reannounce(node, args):
    """Its trackers asked for more peers now: these torrents', or every torrent's (Transmission asks those it
    may: a tracker is asked at most once a minute or so)."""
    ids = [int(i) for i in (args.get("ids") or []) if str(i).isdigit()]
    try:
        ask_tr(node, "torrent-reannounce", {"ids": ids} if ids else {})
    except (RuntimeError, OSError) as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "message": "Asked the trackers for more peers%s." % ("" if ids else " for every torrent")}


def act_queue(node, args):
    """A waiting torrent's place among the others waiting the same way (to download, or to seed): top, up,
    down or bottom."""
    move = args.get("move")
    tid = args.get("id")
    if move not in ("top", "up", "down", "bottom") or not str(tid).isdigit():
        return {"ok": False, "error": "Which torrent, and where to?"}
    tid = int(tid)
    try:
        if move in ("top", "bottom"):
            ask_tr(node, "queue-move-" + move, {"ids": [tid]})
        else:
            got = ask_tr(node, "torrent-get", {"fields": ["id", "status", "queuePosition"]}).get("torrents", [])
            me = next((t for t in got if t.get("id") == tid), None)
            if not me:
                return {"ok": False, "error": "That torrent isn't there any more."}
            same = sorted((t for t in got if t.get("status") == me.get("status")), key=lambda t: t.get("queuePosition") or 0)
            i = next(i for i, t in enumerate(same) if t.get("id") == tid)
            j = i - 1 if move == "up" else i + 1
            if 0 <= j < len(same):  # (in Transmission's queue, the place of the one it goes past: the rest move along)
                ask_tr(node, "torrent-set", {"ids": [tid], "queuePosition": same[j].get("queuePosition") or 0})
    except (RuntimeError, OSError) as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "message": {"top": "Moved to the top of the queue.", "up": "Moved up the queue.", "down": "Moved down the queue.",
                                    "bottom": "Moved to the bottom of the queue."}[move]}


def act_limits(node, args):
    """How many torrents download and seed at once (a queue each, on or off) and how many peers Transmission
    takes, in all and for each torrent: set now, and in its settings (kept wherever it runs next)."""
    change = {}
    for k, (name, lo, hi) in LIMITS.items():
        if k not in args:
            continue
        if lo is None:
            change[name] = bool(args[k])
            continue
        try:
            v = int(args[k])
        except (TypeError, ValueError):
            return {"ok": False, "error": "That isn't a number."}
        if not lo <= v <= hi:
            return {"ok": False, "error": "Between %d and %d." % (lo, hi)}
        change[name] = v
    if not change:
        return {"ok": False, "error": "Nothing to change."}
    try:
        ask_tr(node, "session-set", change)
    except (RuntimeError, OSError) as e:
        return {"ok": False, "error": str(e)}
    # (its settings file too, as Transmission writes it when it stops: kept if it stops another way)
    path = os.path.join(config_dir(node), "settings.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            s = json.load(f)
        s.update(change)
        with open(path + ".new", "w", encoding="utf-8") as f:
            json.dump(s, f, indent=4, sort_keys=True)
        os.replace(path + ".new", path)
    except (OSError, ValueError):
        pass
    _wake(node)  # (read again now)
    said = []
    if "download-queue-enabled" in change or "download-queue-size" in change:
        said.append("downloads: %s" % ("as many as want to at once" if change.get("download-queue-enabled") is False else
                                       "at most %s at once" % change.get("download-queue-size", (_stats.get("session") or {}).get("downloadQueueSize", "?"))))
    if "seed-queue-enabled" in change or "seed-queue-size" in change:
        said.append("seeding: %s" % ("every finished torrent" if change.get("seed-queue-enabled") is False else
                                     "at most %s at once" % change.get("seed-queue-size", (_stats.get("session") or {}).get("seedQueueSize", "?"))))
    if "peer-limit-global" in change:
        said.append("at most %d peers in all" % change["peer-limit-global"])
    if "peer-limit-per-torrent" in change:
        said.append("at most %d peers for each torrent" % change["peer-limit-per-torrent"])
    if "utp-enabled" in change:
        said.append("uTP on" if change["utp-enabled"] else "uTP off (peers over TCP only)")
    return {"ok": True, "message": "Transmission: %s." % ", ".join(said)}


def act_torrent(node, args):
    do = {"start": "torrent-start", "stop": "torrent-stop", "remove": "torrent-remove"}.get(args.get("do"))
    ids = [int(i) for i in (args.get("ids") or []) if str(i).isdigit()]
    if not do or not ids:
        return {"ok": False, "error": "Which torrents, and what?"}
    try:
        ask_tr(node, do, {"ids": ids, **({"delete-local-data": False} if do == "torrent-remove" else {})})
    except (RuntimeError, OSError) as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "message": "Done."}


def act_folders(node, args):
    """Folders in your home, for choosing where a new download goes."""
    home = os.path.normpath(home_dir())
    path = os.path.normpath(str(args.get("path") or home))
    if not (path == home or path.startswith(home.rstrip(os.sep) + os.sep)) or not os.path.isdir(path):
        return {"ok": False, "error": "Only folders in your home."}
    try:
        subs = sorted(e.name for e in os.scandir(path) if e.is_dir() and not e.name.startswith("."))
    except OSError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "path": path, "home": home, "parent": os.path.dirname(path) if path != home else None, "folders": subs[:500]}


def act_add(node, args):
    """A new download (a magnet link, or a .torrent file's bytes in base64) into a folder of your choice."""
    if not is_home(node):
        return {"ok": False, "error": "Ask the Pi that keeps Transmission's files."}
    mem = node.memory("apps")
    folder = os.path.normpath(str(args.get("folder") or "")) or None
    top = top_of(folder) if folder else None
    if folder and not top:
        return {"ok": False, "error": "Choose a folder in your home on %s." % node.name}
    if folder:
        os.makedirs(folder, exist_ok=True)
    if top and top not in (mem.get("names") or []):
        a = share(node, sorted(set(mem.get("names") or []) | {top}))
        if not a.get("ok"):
            return {"ok": False, "error": "Couldn't share ~/%s: %s" % (top, a.get("error"))}
        time.sleep(BEAT_S + 2)  # (the Pi running it starts again with it)
    add = {"paused": False}
    if args.get("magnet"):
        if not str(args["magnet"]).startswith("magnet:"):
            return {"ok": False, "error": "That isn't a magnet link."}
        add["filename"] = str(args["magnet"])
    elif args.get("torrent"):
        add["metainfo"] = str(args["torrent"])
    else:
        return {"ok": False, "error": "A magnet link or a .torrent file?"}
    if folder:
        add["download-dir"] = folder
    try:
        got = ask_tr(node, "torrent-add", add, timeout=30)
    except (RuntimeError, OSError) as e:
        return {"ok": False, "error": str(e)}
    t = got.get("torrent-added") or got.get("torrent-duplicate") or {}
    return {"ok": True, "message": "Added %s%s." % (t.get("name") or "it", (" into " + folder) if folder else "")}


ACTIONS = {
    "migrate": {"title": "Move pi's Transmission torrents in", "run": act_migrate, "hidden": True},
    "giveBack": {"title": "Give the torrents back to the window app", "run": act_give_back, "hidden": True},
    "lease": {"run": act_lease, "hidden": True},
    "move": {"run": act_move, "hidden": True},
    "turtle": {"run": act_turtle, "hidden": True},
    "torrents": {"run": act_torrents, "hidden": True},
    "torrent": {"run": act_torrent, "hidden": True},
    "traffic": {"run": act_traffic, "hidden": True},
    "reannounce": {"run": act_reannounce, "hidden": True},
    "queue": {"run": act_queue, "hidden": True},
    "limits": {"run": act_limits, "hidden": True},
    "folders": {"run": act_folders, "hidden": True},
    "add": {"run": act_add, "hidden": True},
}


def status(node):
    ok, why = free(node)
    here = unit_active(node)
    out = {"home": is_home(node), "canRun": can_run(node), "free": ok, "why": why, "runningHere": here,
           "error": _run["error"]}
    parts = []
    if here:
        parts.append("Transmission runs here")
    elif out["canRun"]:
        parts.append("Can run Transmission" + ("" if ok else " (not now: %s)" % why))
    elif WINDOWS and node.setting("apps", "transmission"):
        parts.append("Doesn't run Transmission yet (its Linux for it isn't set up on this PC: setup.py --linux)")
    else:
        parts.append("Doesn't run Transmission (its switch is off)")
    warn = [_run["error"]] if _run["error"] else []
    if out["home"]:
        mem = node.memory("apps")
        out.update(migrated=bool(mem.get("migrated")), runner=mem.get("runner"), prefer=mem.get("prefer"), shared=mem.get("names") or [],
                   moving=bool(mem.get("handing")), outside=mem.get("outside") or [])
        if not mem.get("migrated"):
            parts.append("keeps Transmission's files; its torrents aren't moved in yet")
        else:
            if mem.get("runner") and not mem.get("handing") and time.time() - _stats["at"] < 30:
                out.update(torrents=_stats.get("torrents"), down=_stats.get("down"), up=_stats.get("up"), turtle=_stats.get("turtle"),
                           session=_stats.get("session") or {})
                kb = lambda b: "%.1f MB/s" % (b / 1e6) if b >= 1e6 else "%d KB/s" % round(b / 1e3)
                parts.append("Transmission on %s · %d torrents · ↓ %s ↑ %s%s" % (mem.get("runner"), _stats.get("torrents") or 0, kb(_stats.get("down") or 0),
                                                                                  kb(_stats.get("up") or 0), " · turtle on" if _stats.get("turtle") else ""))
            else:
                parts.append("Transmission: moving to another Pi" if mem.get("handing") else "Transmission: starting on %s" % mem.get("runner") if mem.get("runner") else "Transmission: waiting for a free Pi")
            if _fwd["error"]:
                warn.append(_fwd["error"])
            if mem.get("outside"):
                warn.append("%d torrent folder%s outside your home: Transmission stays on %s" % (len(mem["outside"]), "" if len(mem["outside"]) == 1 else "s", node.name))
    out["summary"] = " · ".join(parts)
    out["warnings"] = warn
    return out
