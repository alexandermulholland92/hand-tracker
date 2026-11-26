"""
downloads.py - Cluster module: torrents downloaded by any computer in the cluster, each on its own disk with a
Transmission of its own, then copied to the Pi that keeps Transmission's files (the home, pi) (the user, 2026-11-24:
"decentralize the transmission downloads from pi so any device can download and seed from that device and send it
to pi").

Their choices:
- Which computers: the Pis and the Windows PC (in its own Linux, Cluster-Linux), each on its own disk; and the phones
  in the cluster (the user, 2026-11-25: "both": a phone downloads for the cluster as a computer does, with the Cluster
  app's own Transmission, while it's charging unless "Download on battery" is on; and has an FTP link to pi's folders).
- Where a new download goes, chosen each time it's added: pi (the cluster's Transmission, as before), a computer by
  name, or "the computer with the most free network": the least busy network right now (what its own Wi-Fi or
  Ethernet received and sent over the last minute), among those free and with room on their disk for it (pi too:
  then it goes straight into the cluster's Transmission; networks within 50 KB/s of pi's count as as free, and pi
  is chosen then, as nothing has to be copied).
- Once it's on pi, chosen each time too: the computer keeps seeding it (pi has its own copy, which it doesn't seed),
  or pi takes over (pi's Transmission checks its copy and seeds it; once it has all of it, the computer's copy is
  deleted). A torrent kept seeding can be handed to pi later.
- pi's own torrents (the 51 it had) stay on pi, in the cluster's Transmission.
- One torrent split between computers (the user: "By files and pieces"): its files shared out (each computer's
  Transmission downloads only its own), or a big file shared out by pieces (libtorrent on each computer, as
  Transmission can't choose pieces; pieces.py beside this service), each part copied to pi and joined there.

How:
- Each computer with this module on runs a Transmission of its own for these (its address 127.0.0.1:9094, peers on
  51415), its downloads in a folder of its own (a Pi: ~/ht-cluster-downloads; the PC: %USERPROFILE%/Cluster/
  downloads), each torrent in a folder of its own there; started while it has any, stopped 5 minutes after the last.
  It says how it's doing to the home every 5 s (free or not, its room, how busy its network is, its torrents); the
  home answers with what it should have (each torrent, which of its files, paused or not, its turn to copy) and what
  to remove.
- Not while a computer records ("Download while its cameras run" off), is too hot or short of memory, or is on
  battery ("Download on battery" off; never under 30 %): its torrents wait, paused, meanwhile.
- Copying to pi: one computer at a time (pi's Wi-Fi), in 4 MB pieces, each tried again after a stall; a copy that
  stops goes on from where it got to. Files arrive as <name>.part, renamed once every part is there. pi never
  overwrites a file it has: that download fails instead, saying so.
- Its own Transmission's peers are kept few (40 in all, 20 a torrent, 2 downloading at once), as the router hung at
  200 (2026-11-20); uTP, DHT and local peer discovery off, as on pi.
"""

import base64
import collections
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

TITLE = "Downloads"
ORDER = 55
ON = True
EVERY = 5
WINDOWS = os.environ.get("HT_CLUSTER_PLATFORM") == "windows"
PHONE = os.environ.get("HT_CLUSTER_PLATFORM") in ("android", "ios")  # (the Cluster app on a phone: its own Transmission)
PLATFORMS = ("linux", "windows", "android", "ios")
SETTINGS = [
    {"key": "battery", "title": "Download on battery", "default": False},
    {"key": "recording", "title": "Download while its cameras run", "default": False},
]
OWN_PORT = 9094
OWN_PEER_PORT = 51415
PIECES_PORT = 51416  # (pieces.py's, libtorrent's own: the first part by pieces here; another at once, the next port up)
FRESH_S = 30  # (the home) a computer heard from this lately can be given a download, or its turn to copy
TURN_STALE_S = 90  # a computer copying says so this often (each piece) or loses its turn
STOP_IDLE_S = 300  # its own Transmission stopped this long after it last had a torrent
PIECE = 4 << 20
MAX_PIECE = 8 << 20
PIECE_TRIES = 6
PIECE_WAITS = (5, 10, 20, 30, 30)
RESERVE_MIN = 4 << 30  # room left on a computer's disk beyond a download: 4 GB, or a tenth of the disk
RESERVE_SHARE = 0.10
UNKNOWN_SIZE = 8 << 30  # (a magnet link's size before its file list comes: room for this much asked for)
MAX_SPLIT = 4
HOT_C = 80
LOW_BATTERY = 30
MIN_MEMORY = 300 << 20
NET_WINDOW_S = 60
TIE_BYTES = 50000  # networks this close (bytes/s) count as as busy: the home first (nothing to copy), then the less busy
BEAT_S = 4.5  # how often a computer says how it's doing (its tick's every EVERY s)
if os.environ.get("HT_CLUSTER_SIM_FAST"):  # (the checks)
    TURN_STALE_S, STOP_IDLE_S, NET_WINDOW_S, FRESH_S = 15, 20, 6, 15
    PIECE_WAITS = (1, 1, 1, 1, 1)
    EVERY, BEAT_S = 1, 1.5
HASH = re.compile(r"^[0-9a-f]{40}$")
ID = re.compile(r"^d[0-9a-f]{10}$")
PHYSICAL = re.compile(r"^(wlan|wlp|wl|eth|enp|eno|ens|enx|end)\w*$")

_lock = threading.RLock()
_beats = {}  # (the home) computer -> its last word
_reports = {}  # (the home) computer -> {hash: its torrent as it said}
_turn = {"holder": None, "beat": 0.0}  # (the home) whose turn it is to copy: (download id, part)
_finishing = set()  # (the home) downloads being joined or handed to pi just now
_dev = {"home": None, "homeAt": 0, "beat": 0, "lastHad": 0.0, "starting": False, "error": None, "answer": None,
        "pieces": None, "piecesAt": 0}
_copy = {"thread": None, "what": None, "error": None, "rate": 0, "stop": False}
_net = collections.deque(maxlen=64)  # (t, rx, tx, mbit)
_sid = {}
_procs = {}  # (a computer) download id -> pieces.py's process
_ports = {}  # (a computer) download id -> its pieces.py's port


def phonesys():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if here not in sys.path:
        sys.path.insert(0, here)
    import phonesys as p

    return p


# ----- where things are -----
def apps_mod(node):
    m = node.modules.get("apps")
    return m.mod if m else None


def is_home(node):
    a = apps_mod(node)
    return bool(a and a.is_home(node))


def install_dir(node):
    return os.path.dirname(node.state_dir)


def downloads_dir(node):
    d = os.environ.get("HT_CLUSTER_OWN_DOWNLOADS") if node.simulate else None
    if d:
        return d
    if PHONE:
        return os.path.join(install_dir(node), "cluster-downloads")
    if WINDOWS:
        return os.path.join(install_dir(node), "downloads")
    return os.path.join(os.path.expanduser("~"), "ht-cluster-downloads")


def config_dir(node):
    d = os.environ.get("HT_CLUSTER_OWN_TR_CONFIG") if node.simulate else None
    if d:
        return d
    if PHONE:
        return os.path.join(node.state_dir, "own-transmission")
    if WINDOWS:
        return os.path.join(install_dir(node), "own-transmission")
    return os.path.join(os.path.expanduser("~"), ".local", "share", "ht-cluster", "own-transmission")


def own_port(node):
    return int(os.environ.get("HT_CLUSTER_OWN_TR_PORT", OWN_PORT)) if node.simulate else OWN_PORT


def meta_dir(node):
    return os.path.join(node.state_dir, "downloads")


def to_linux(node, p):
    """A path as its own Transmission sees it (the PC's: in its Linux, /mnt/c/...)."""
    if WINDOWS and not node.simulate:
        drive, rest = os.path.splitdrive(os.path.abspath(p))
        return "/mnt/%s%s" % (drive[:1].lower(), rest.replace("\\", "/"))
    return p


def from_linux(node, p):
    if WINDOWS and not node.simulate:
        m = re.match(r"^/mnt/([a-z])(/.*)?$", p or "")
        if m:
            return "%s:%s" % (m.group(1).upper(), (m.group(2) or "/").replace("/", "\\"))
    return p


def local_name(node, rel):
    """A torrent's file (its name as Transmission keeps it, under the download's folder) as this computer opens it. On
    the PC its Linux wrote it on Windows' drive, which keeps the characters Windows doesn't allow in names as others
    (U+F000 and up), so they're read so."""
    parts = rel.split("/")
    if WINDOWS and not node.simulate:
        parts = ["".join(chr(0xF000 + ord(c)) if c in '<>:"\\|?*' or ord(c) < 32 else c for c in p) for p in parts]
    return os.path.join(*parts)


# ----- torrents' own files -----
def bdecode(data):
    """A bencoded value -> (it, with byte strings as they are; the top dictionary's "info" value's span)."""
    pos = 0
    span = [None]

    def val(depth):
        nonlocal pos
        c = data[pos:pos + 1]
        if c == b"i":
            end = data.index(b"e", pos)
            n = int(data[pos + 1:end])
            pos = end + 1
            return n
        if c in (b"l", b"d"):
            pos += 1
            out = [] if c == b"l" else {}
            while data[pos:pos + 1] != b"e":
                if pos >= len(data):
                    raise ValueError("cut short")
                if c == b"l":
                    out.append(val(depth + 1))
                else:
                    k = val(depth + 1)
                    start = pos
                    v = val(depth + 1)
                    if depth == 0 and k == b"info":
                        span[0] = (start, pos)
                    out[k] = v
            pos += 1
            return out
        if c.isdigit():
            colon = data.index(b":", pos)
            n = int(data[pos:colon])
            pos = colon + 1 + n
            if pos > len(data):
                raise ValueError("cut short")
            return data[colon + 1:pos]
        raise ValueError("not a torrent")

    v = val(0)
    return v, span[0]


def text(b):
    return b.decode("utf-8", "replace") if isinstance(b, bytes) else str(b)


def safe_rel(rel):
    parts = rel.split("/")
    return bool(rel) and all(p and p not in (".", "..") and "\x00" not in p and "\\" not in p for p in parts) and len(rel) < 4000


def parse_meta(data):
    """A .torrent file's bytes -> {hash, name, files: [[its name under the folder, bytes]], pieceLength, pieces, size,
    padded}; ValueError if it isn't one this can take."""
    top, span = bdecode(data)
    if not isinstance(top, dict) or not isinstance(top.get(b"info"), dict) or not span:
        raise ValueError("That isn't a .torrent file.")
    info = top[b"info"]
    name = text(info.get(b"name.utf-8") or info.get(b"name") or b"")
    pl = int(info.get(b"piece length") or 0)
    pieces = info.get(b"pieces") or b""
    if not name or pl <= 0 or not pieces or len(pieces) % 20:
        raise ValueError("That torrent has no pieces this can read (a v2-only torrent?).")
    padded = False
    if isinstance(info.get(b"files"), list):
        files = []
        for f in info[b"files"]:
            path = f.get(b"path.utf-8") or f.get(b"path") or []
            rel = "/".join([name] + [text(p) for p in path])
            if b"p" in (f.get(b"attr") or b""):
                padded = True
            files.append([rel, int(f.get(b"length") or 0)])
    else:
        files = [[name, int(info.get(b"length") or 0)]]
    for rel, _ in files:
        if not safe_rel(rel):
            raise ValueError("That torrent has a file name this won't write: %s" % rel[:80])
    return {"hash": hashlib.sha1(data[span[0]:span[1]]).hexdigest(), "name": name, "files": files, "pieceLength": pl,
            "pieces": len(pieces) // 20, "size": sum(f[1] for f in files), "padded": padded}


def parse_magnet(m):
    """A magnet link -> (its info hash, as 40 hex digits, its name or None); ValueError if it hasn't one."""
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(m).query)
    for xt in q.get("xt", []):
        if xt.lower().startswith("urn:btih:"):
            h = xt[9:]
            if len(h) == 32:
                try:
                    h = base64.b32decode(h.upper()).hex()
                except (ValueError, TypeError):
                    continue
            h = h.lower()
            if HASH.match(h):
                return h, (q.get("dn") or [None])[0]
    raise ValueError("That magnet link has no torrent's hash in it.")


# ----- its own Transmission's requests -----
def rpc(port, method, args=None, timeout=10):
    url = "http://127.0.0.1:%d/transmission/rpc" % port
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


def own(node, method, args=None, timeout=10):
    return rpc(own_port(node), method, args, timeout)


FIELDS = ["id", "hashString", "name", "percentDone", "status", "rateDownload", "rateUpload", "eta", "sizeWhenDone", "leftUntilDone",
          "peersConnected", "errorString", "metadataPercentComplete", "torrentFile", "wanted", "uploadedEver", "downloadedEver"]


# ----- this computer: free, room, network -----
def ready(node):
    """Whether this computer can run a Transmission of its own: a Pi with Transmission installed, the PC with its Linux
    set up, a phone always (the Cluster app's own, libtransmission in it: start_own asks the app)."""
    if node.simulate:
        return not os.environ.get("HT_CLUSTER_SIM_NO_OWN_TR")
    if PHONE:  # (looked for /usr/bin/transmission-daemon before, so a phone said "no Transmission here": the user, 2026-11-25)
        return True
    if WINDOWS:
        a = apps_mod(node)
        return bool(a and a.wsl_ready(node))
    return os.path.exists("/usr/bin/transmission-daemon")


def free(node):
    """(True, "") or (False, why not now)."""
    rig = node.modules.get("rig")
    if not node.setting("downloads", "recording") and rig and hasattr(rig.mod, "busy") and node.is_on("rig") and rig.mod.busy(node):
        return False, "recording"
    h = node.status_of("health") if node.modules.get("health") else {}
    if (h.get("tempC") or 0) >= HOT_C:
        return False, "too hot"
    mem = h.get("memory") or {}
    if mem.get("available") is not None and mem["available"] < MIN_MEMORY:
        return False, "short of memory"
    p = h.get("power") or {}
    if p.get("source") == "battery" and not p.get("charging"):
        if not node.setting("downloads", "battery"):
            return False, "on battery"
        if p.get("level") is not None and p["level"] < LOW_BATTERY:
            return False, "battery low"
    return True, ""


def room(node, path=None):
    """(free bytes, bytes kept free beyond any download) on the disk path is on (its downloads folder)."""
    if node.simulate and os.environ.get("HT_CLUSTER_SIM_ROOM"):
        n = int(os.environ["HT_CLUSTER_SIM_ROOM"])
        return n, RESERVE_MIN
    p = path or downloads_dir(node)
    while p and not os.path.exists(p):
        up = os.path.dirname(p)
        if up == p:
            break
        p = up
    try:
        u = shutil.disk_usage(p or "/")
    except OSError:
        return 0, RESERVE_MIN
    return u.free, max(RESERVE_MIN, int(u.total * RESERVE_SHARE))


def net_counters(node):
    if PHONE:  # (a phone: what Android counts, all its networks; its Wi-Fi's speed)
        n = phonesys().call("net")
        return (int(n["rx"]), int(n["tx"]), n.get("mbit")) if n.get("ok") and n.get("rx") is not None and n.get("rx") >= 0 else None
    if WINDOWS:
        try:
            sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            import winsys
            n = winsys.net_bytes()
        except Exception:
            return None
        return (n["rx"], n["tx"], n.get("mbit")) if n else None
    try:
        with open("/proc/net/dev", "r", encoding="utf-8") as f:
            lines = f.read().splitlines()[2:]
    except OSError:
        return None
    rx = tx = 0
    for line in lines:
        name, _, rest = line.partition(":")
        if PHYSICAL.match(name.strip()):
            f = rest.split()
            rx += int(f[0])
            tx += int(f[8])
    return rx, tx, None


def sample_net(node):
    c = net_counters(node) if not node.simulate else None
    if c:
        if _net and (c[0] < _net[-1][1] or c[1] < _net[-1][2]):
            _net.clear()  # (counters started again)
        _net.append((time.time(), c[0], c[1], c[2]))


def net_busy(node):
    """Bytes a second its own network moved (received and sent) over the last minute, and its link (Mbit/s) if known."""
    if node.simulate:
        return int(os.environ.get("HT_CLUSTER_SIM_NET") or 0), None
    now = time.time()
    pts = [p for p in _net if now - p[0] <= NET_WINDOW_S + 6]
    if len(pts) < 2 or pts[-1][0] - pts[0][0] < 4:
        return None, None
    a, b = pts[0], pts[-1]
    return int((b[1] - a[1] + b[2] - a[2]) / (b[0] - a[0])), b[3]


# ----- this computer: its own Transmission -----
def write_settings(node):
    """Its own Transmission's settings, before it starts (it writes them itself as it stops)."""
    d = config_dir(node)
    os.makedirs(d, exist_ok=True)
    os.makedirs(downloads_dir(node), exist_ok=True)
    path = os.path.join(d, "settings.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            s = json.load(f)
    except (OSError, ValueError):
        s = {}
    for k, v in (("peer-limit-global", 40), ("peer-limit-per-torrent", 20), ("download-queue-enabled", True), ("download-queue-size", 2)):
        s.setdefault(k, v)
    s.update({"rpc-enabled": True, "rpc-port": own_port(node), "rpc-bind-address": "0.0.0.0" if WINDOWS else "127.0.0.1",
              "rpc-whitelist-enabled": True, "rpc-whitelist": "127.0.0.1,::1", "rpc-authentication-required": False,
              "rpc-host-whitelist-enabled": False, "download-dir": to_linux(node, downloads_dir(node)), "incomplete-dir-enabled": False,
              "rename-partial-files": True, "peer-port": OWN_PEER_PORT, "peer-port-random-on-start": False, "utp-enabled": False,
              "dht-enabled": False, "lpd-enabled": False, "pex-enabled": True, "seed-queue-enabled": False, "ratio-limit-enabled": False,
              "idle-seeding-limit-enabled": False, "start-added-torrents": True, "umask": "022", "watch-dir-enabled": False,
              "preallocation": 0 if WINDOWS else 1})
    with open(path + ".new", "w", encoding="utf-8") as f:
        json.dump(s, f, indent=4, sort_keys=True)
    os.replace(path + ".new", path)


def own_running(node):
    if node.simulate:
        return os.path.exists(os.path.join(node.state_dir, "own-tr-running"))
    if PHONE:
        return bool(phonesys().call("transmission-running").get("running"))
    if WINDOWS:
        return wsl_own_running(node)
    code, out, _ = node.run(["systemctl", "is-active", "ht-cluster-own-transmission"], 10)
    return out.strip() == "active"


def start_own(node):
    if _dev["starting"]:
        return
    _dev["starting"] = True

    def go():
        try:
            write_settings(node)
            if WINDOWS and not node.simulate:
                why = start_wsl_own(node)
                a = {"ok": not why, "error": why}
            elif PHONE and not node.simulate:  # (the app's own: libtransmission in it)
                a = phonesys().call("transmission-start", {"config": config_dir(node)})
            else:
                a = node.root("own-transmission-start", timeout=120)
            if not a.get("ok"):
                _dev["error"] = "Its own Transmission didn't start: %s" % a.get("error")
                node.event("downloads", _dev["error"], bad=True)
                return
            for _ in range(60):  # (answering)
                try:
                    own(node, "session-get", {"fields": ["version"]}, timeout=3)
                    break
                except (RuntimeError, OSError):
                    time.sleep(1)
            _dev["error"] = None
            _dev["lastHad"] = time.time()
            node.event("downloads", "This computer's own Transmission started (for the cluster's downloads).")
        finally:
            _dev["starting"] = False
    threading.Thread(target=go, daemon=True).start()


def stop_own(node, why):
    if WINDOWS and not node.simulate:
        stop_wsl_own(node)
    elif PHONE and not node.simulate:
        phonesys().call("transmission-stop")
    else:
        node.root("own-transmission-stop", timeout=180)
    node.event("downloads", "This computer's own Transmission stopped (%s)." % why)


# (the PC: its own Transmission in Cluster-Linux, through windows/transmission.sh as apps.py runs the cluster's)
def wsl_pid_file(node):
    return os.path.join(node.state_dir, "own-transmission-wsl.pid")


def wsl_own_running(node):
    p = _dev.get("proc")
    if p is not None and p.poll() is None:
        return True
    try:
        with open(wsl_pid_file(node), "r", encoding="utf-8") as f:
            pid = int(f.read().split()[0])
    except (OSError, ValueError, IndexError):
        return False
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import winsys
    if os.path.getmtime(wsl_pid_file(node)) < time.time() - winsys.uptime() or (winsys.exe_of(pid) or "").lower() != "wsl.exe":
        try:
            os.remove(wsl_pid_file(node))
        except OSError:
            pass
        return False
    return True


def start_wsl_own(node):
    a = apps_mod(node)
    log = os.path.join(node.state_dir, "own-transmission-wsl.log")
    try:
        if os.path.getsize(log) > 1 << 20:
            os.replace(log, log + ".1")
    except OSError:
        pass
    with open(log, "ab") as f:
        f.write(("%s starting\n" % time.strftime("%Y-%m-%d %H:%M:%S")).encode())
        f.flush()
        p = subprocess.Popen(a.wsl_cmd(node, ["own-start", to_linux(node, config_dir(node))]), stdout=f, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, env=dict(os.environ, WSL_UTF8="1"), creationflags=0x08000000 | 0x00000200)
    _dev["proc"] = p
    with open(wsl_pid_file(node), "w", encoding="utf-8") as f:
        f.write("%d\n" % p.pid)
    for _ in range(90):
        if p.poll() is not None:
            return "it ended at once: %s" % a.last_said(log)
        try:
            with open(log, "rb") as f:
                if b"transmission.sh: own running" in f.read()[-4000:]:
                    return None
        except OSError:
            pass
        time.sleep(1)
    return "it didn't start within 90 s: %s" % a.last_said(log)


def stop_wsl_own(node):
    a = apps_mod(node)
    a.wsl_call(node, ["own-stop"], 180)
    p = _dev.get("proc")
    if p is not None:
        try:
            p.wait(30)
        except subprocess.TimeoutExpired:
            p.kill()
        _dev["proc"] = None
    try:
        os.remove(wsl_pid_file(node))
    except OSError:
        pass


# ----- this computer: its part of the cluster's downloads -----
def find_home(node):
    now = time.time()
    if _dev["home"] and now - _dev["homeAt"] < 120:
        return _dev["home"]
    a = apps_mod(node)
    home = a.find_home(node) if a else apps_home(node)
    if home:
        _dev.update(home=home, homeAt=now)
    return home


def apps_home(node):
    """The Pi that keeps Transmission's files, as apps.py finds it (for a phone, which doesn't run that module)."""
    for fresh in (False, True):
        for p in node.cluster(fresh=fresh):
            a = next((m for m in p["node"].get("modules", []) if m["name"] == "apps"), None)
            if a and a.get("on") and (a.get("status") or {}).get("home"):
                return {"name": p["name"], "target": p["target"]}
    return None


def own_torrents(node, fields=FIELDS):
    try:
        return own(node, "torrent-get", {"fields": fields}, timeout=15).get("torrents") or []
    except (RuntimeError, OSError):
        return None


def wanted_ok(w, t):
    """Whether its own Transmission downloads just the files this computer was given."""
    files = w.get("files")
    flags = [bool(x) for x in (t.get("wanted") or [])]
    if files is None:
        return all(flags)
    if not isinstance(files, list) or not flags:
        return False
    mine = set(files)
    return all(f == (i in mine) for i, f in enumerate(flags))


def report(t, w):
    return {"hash": t["hashString"].lower(), "name": t.get("name"), "pct": t.get("percentDone") or 0, "status": t.get("status"),
            "down": t.get("rateDownload") or 0, "up": t.get("rateUpload") or 0, "eta": t.get("eta"), "size": t.get("sizeWhenDone") or 0,
            "left": t.get("leftUntilDone"), "peers": t.get("peersConnected"), "error": t.get("errorString") or "",
            "meta": t.get("metadataPercentComplete"), "upEver": t.get("uploadedEver") or 0, "downEver": t.get("downloadedEver") or 0,
            "wantedOk": wanted_ok(w, t) if w else None}


def device_tick(node):
    now = time.time()
    if now - _dev["beat"] < BEAT_S:
        return
    _dev["beat"] = now
    home = find_home(node)
    if not home or home["name"] == node.name:
        return
    running = own_running(node)
    torrents = own_torrents(node) if running else []
    if torrents is None:
        torrents, running = [], False
    last = _dev["answer"] or {}
    wants = {w["hash"]: w for w in last.get("want") or [] if w.get("hash")}
    ok, why = free(node)
    _dev["free"] = (ok, why)
    have_room, reserve = room(node)
    busy, mbit = net_busy(node)
    words = {"worker": node.name, "ready": ready(node), "free": ok, "why": why, "room": have_room, "reserve": reserve, "net": busy,
             "mbit": mbit, "pieces": pieces_ready(node), "running": running, "error": _dev["error"],
             "torrents": [report(t, wants.get(t["hashString"].lower())) for t in torrents],
             "copying": {"what": _copy["what"], "rate": _copy["rate"], "error": _copy["error"]} if _copy["what"] or _copy["error"] else None}
    words["torrents"] += pieces_reports(node, wants)
    # (what the home asked for at its last word: each new torrent's own file, its files as Transmission names them)
    meta, files = {}, {}
    for h in last.get("needMeta") or []:
        t = next((x for x in torrents if x["hashString"].lower() == h), None)
        if t and (t.get("metadataPercentComplete") or 0) >= 1 and t.get("torrentFile"):
            try:
                with open(from_linux(node, t["torrentFile"]), "rb") as f:
                    meta[h] = base64.b64encode(f.read()).decode()
            except OSError:
                pass
    need_files = [h for h in last.get("needFiles") or [] if any(x["hashString"].lower() == h for x in torrents)]
    if need_files:
        got = own(node, "torrent-get", {"ids": need_files, "fields": ["hashString", "files", "metadataPercentComplete"]}, timeout=20).get("torrents") or []
        for t in got:
            if (t.get("metadataPercentComplete") or 0) >= 1:
                files[t["hashString"].lower()] = [[f["name"], f["length"]] for f in t.get("files") or []]
    words.update(meta=meta, files=files)
    code, a = node.ask(home["target"], "POST", "/api/action", {"module": "downloads", "action": "beat", "args": words}, timeout=20)
    if code != 200 or not isinstance(a, dict) or not a.get("ok"):
        if code == 400 or code == 404:  # (the home moved, or isn't running this yet)
            _dev["home"] = None
        return
    _dev["answer"] = a
    reconcile(node, home, a, torrents, running, ok)


def reconcile(node, home, a, torrents, running, ok):
    wants = [w for w in a.get("want") or [] if w.get("hash") and ID.match(str(w.get("id") or ""))]
    drops = [d for d in a.get("drop") or [] if HASH.match(str(d.get("hash") or ""))]
    have = {t["hashString"].lower(): t for t in torrents}
    tr_wants = [w for w in wants if not w.get("pieces")]
    if tr_wants or any(d["hash"] in have and (d.get("what") or "all") in ("tr", "all") for d in drops):
        _dev["lastHad"] = time.time()
        if not running:
            if ready(node):
                start_own(node)
            return
    for w in tr_wants:
        t = have.get(w["hash"])
        try:
            if not t:
                add_own(node, w, ok)
                continue
            if (t.get("metadataPercentComplete") or 0) >= 1:
                files = w.get("files")
                n = len(t.get("wanted") or [])
                if files == "none":
                    if any(t.get("wanted") or []):
                        own(node, "torrent-set", {"ids": [t["id"]], "files-unwanted": []})  # (an empty list: every file)
                elif not wanted_ok(w, t) and n:
                    want = set(range(n)) if files is None else set(files)
                    args = {"ids": [t["id"]], "files-wanted": sorted(want)}
                    left = sorted(set(range(n)) - want)
                    if left:
                        args["files-unwanted"] = left
                    own(node, "torrent-set", args)
            stopped = t.get("status") == 0
            if (w.get("paused") or not ok) and not stopped:
                own(node, "torrent-stop", {"ids": [t["id"]]})
            elif not (w.get("paused") or not ok) and stopped:
                own(node, "torrent-start", {"ids": [t["id"]]})
        except (RuntimeError, OSError) as e:
            _dev["error"] = "Its own Transmission: %s" % e
    for d in drops:
        what = d.get("what") or "all"
        if what in ("tr", "all"):
            t = have.get(d["hash"])
            if t:
                try:
                    own(node, "torrent-remove", {"ids": [t["id"]], "delete-local-data": bool(d.get("deleteData"))})
                except (RuntimeError, OSError):
                    continue
            if d.get("deleteData") and ID.match(str(d.get("id") or "")):
                shutil.rmtree(os.path.join(downloads_dir(node), d["id"]), ignore_errors=True)
        if what in ("pieces", "all") and ID.match(str(d.get("id") or "")):
            stop_pieces(node, d["id"], d.get("deleteData"))
    pieces_reconcile(node, home, [w for w in wants if w.get("pieces")], ok)
    go = next((w for w in wants if (w.get("copy") or {}).get("go")), None)
    if go and ok and not (_copy["thread"] and _copy["thread"].is_alive()):
        _copy.update(what=go["name"], error=None, rate=0, stop=False)
        _copy["thread"] = threading.Thread(target=copy_part, args=(node, home, go), daemon=True)
        _copy["thread"].start()
    elif not ok and _copy["thread"] and _copy["thread"].is_alive():
        _copy["stop"] = True
    if running and not tr_wants and not torrents and time.time() - _dev["lastHad"] > STOP_IDLE_S:
        stop_own(node, "no downloads for a while")


def add_own(node, w, ok):
    folder = os.path.join(downloads_dir(node), w["id"])
    os.makedirs(folder, exist_ok=True)
    args = {"download-dir": to_linux(node, folder), "paused": bool(w.get("paused") or not ok)}
    if w.get("meta"):
        args["metainfo"] = w["meta"]
        files, n = w.get("files"), w.get("fileCount")
        if isinstance(files, list) and n:
            left = sorted(set(range(n)) - set(files))
            if left:
                args["files-unwanted"] = left
    elif w.get("magnet"):
        args["filename"] = w["magnet"]
    else:
        return
    got = own(node, "torrent-add", args, timeout=30)
    t = got.get("torrent-added") or got.get("torrent-duplicate") or {}
    node.event("downloads", "Downloading %s here, for the cluster." % (t.get("name") or w.get("name") or "a torrent"))


def copy_part(node, home, w):
    """This computer's part of a download, copied to the home in its turn: its ranges of its files, a piece at a
    time, from where the home says it got to (it says where to go on from after each)."""
    try:
        ranges, names = w["copy"]["ranges"], w["copy"]["names"]
        r, at = w["copy"]["from"]
        base = os.path.join(downloads_dir(node), w["id"]) if not w.get("pieces") else pieces_dir(node, w["id"])
        since, moved = time.time(), 0
        while r < len(ranges):
            if _copy["stop"]:
                return
            i, s, e = ranges[r]
            n = max(0, min(PIECE, e - s - at))
            data = b""
            if n:
                with open(os.path.join(base, local_name(node, names[str(i)])), "rb") as f:
                    f.seek(s + at)
                    data = f.read(n)
                if len(data) != n:
                    raise RuntimeError("%s is shorter than it should be" % names[str(i)])
            q = "id=%s&part=%d&r=%d&at=%d" % (w["id"], int(w["part"]), r, at)
            code, ans = None, None
            for k in range(PIECE_TRIES):
                code, ans = node.ask(home["target"], "PUT", "/api/downloads/piece?" + q, data=data, timeout=120)
                if code is not None and code < 500:
                    break
                time.sleep(PIECE_WAITS[min(k, len(PIECE_WAITS) - 1)])
            if not isinstance(ans, dict) or not isinstance(ans.get("next"), list):
                raise RuntimeError("%s didn't take it: %s" % (home["name"], (ans or {}).get("error") if isinstance(ans, dict) else ans))
            if code != 200 and ans.get("stop"):
                raise RuntimeError(ans.get("error") or "stopped")
            r, at = ans["next"]
            moved += len(data)
            _copy["rate"] = int(moved / max(0.5, time.time() - since))
    except (OSError, RuntimeError, ValueError, KeyError) as e:
        _copy["error"] = "Copying %s to %s: %s" % (w.get("name"), home["name"], e)
        node.event("downloads", _copy["error"], bad=True)
    finally:
        _copy.update(what=None, rate=0)


# ----- this computer: a part of a big file, by pieces (pieces.py, with libtorrent) -----
def pieces_dir(node, did):
    return os.path.join(downloads_dir(node), did + ".p")


def pieces_ready(node):
    """Whether libtorrent's here, for pieces.py (looked at once an hour)."""
    now = time.time()
    if _dev["pieces"] is not None and now - _dev["piecesAt"] < 3600:
        return _dev["pieces"]
    if PHONE:
        ok = False  # (no libtorrent in the app)
    elif node.simulate:
        ok = bool(os.environ.get("HT_CLUSTER_SIM_PIECES"))
    elif WINDOWS:
        ok = os.path.exists(os.path.join(node.state_dir, "libtorrent-ok"))
    else:
        ok = node.run(["python3", "-c", "import libtorrent"], 30)[0] == 0
    _dev.update(pieces=ok, piecesAt=now)
    return ok


def pieces_cmd(node, args):
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    script = os.path.join(here, "pieces.py")
    if node.simulate:  # (the checks: their stand-in for it)
        return [sys.executable, os.environ.get("HT_CLUSTER_SIM_PIECES_SCRIPT") or script] + args
    if WINDOWS:
        a = apps_mod(node)
        return [a.wsl_exe(), "-d", a.WSL_DISTRO, "-u", "root", "--exec", "setpriv", "--reuid=1000", "--regid=1000", "--clear-groups",
                "nice", "-n", "10", "python3", to_linux(node, script)] + [to_linux(node, x) if os.path.isabs(x) else x for x in args]
    return ["nice", "-n", "10", "python3", script] + args


def pieces_state(node, did):
    try:
        with open(os.path.join(pieces_dir(node, did), ".pieces", "status.json"), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def pieces_reports(node, wants):
    out = []
    for w in wants.values():
        if not w.get("pieces"):
            continue
        st = pieces_state(node, w["id"])
        if st:
            out.append({"hash": w["hash"], "name": w.get("name"), "pct": st.get("have", 0) / float(max(1, st.get("of") or 1)), "status": 6 if st.get("done") else 4,
                        "down": st.get("down") or 0, "up": st.get("up") or 0, "eta": None, "size": 0, "left": 0 if st.get("done") else None,
                        "peers": st.get("peers"), "error": st.get("error") or "", "meta": 1, "upEver": st.get("upEver") or 0,
                        "downEver": st.get("downEver") or 0, "wantedOk": True, "pieces": True,
                        "alive": bool(_procs.get(w["id"]) and _procs[w["id"]].poll() is None)})
    return out


def pieces_reconcile(node, home, wants, ok):
    for w in wants:
        p = _procs.get(w["id"])
        alive = p is not None and p.poll() is None
        d = pieces_dir(node, w["id"])
        ctl = os.path.join(d, ".pieces")
        os.makedirs(ctl, exist_ok=True)
        with open(os.path.join(ctl, "control.json.new"), "w", encoding="utf-8") as f:
            json.dump({"paused": bool(w.get("paused") or not ok)}, f)
        os.replace(os.path.join(ctl, "control.json.new"), os.path.join(ctl, "control.json"))
        if alive or not pieces_ready(node):
            continue
        tfile = os.path.join(ctl, "it.torrent")
        if w.get("meta"):
            with open(tfile, "wb") as f:
                f.write(base64.b64decode(w["meta"]))
        if not os.path.exists(tfile):
            continue  # (its file comes at the home's next word)
        lo, hi = w["pieces"]
        log = open(os.path.join(ctl, "log.txt"), "ab")
        taken = {_ports.get(k) for k, q in _procs.items() if k != w["id"] and q.poll() is None}
        _ports[w["id"]] = next(port for port in range(PIECES_PORT, PIECES_PORT + 64) if port not in taken)
        _procs[w["id"]] = subprocess.Popen(pieces_cmd(node, [tfile, d, str(int(lo)), str(int(hi)), ctl, "--port", str(_ports[w["id"]])]),
                                           stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                           creationflags=0x08000000 if os.name == "nt" else 0)
        log.close()
        _dev["lastHad"] = time.time()
    keep = {w["id"] for w in wants}
    for did in [k for k in _procs if k not in keep]:
        stop_pieces(node, did, False)


def stop_pieces(node, did, delete):
    p = _procs.pop(did, None) if did else None
    _ports.pop(did, None)
    if p is not None and p.poll() is None:
        try:
            with open(os.path.join(pieces_dir(node, did), ".pieces", "control.json"), "w", encoding="utf-8") as f:
                json.dump({"stop": True}, f)
            p.wait(30)
        except (OSError, subprocess.TimeoutExpired):
            p.kill()
    if delete and did and ID.match(did):
        shutil.rmtree(pieces_dir(node, did), ignore_errors=True)


# ----- the home: the list of downloads on other computers -----
def book(node):
    mem = node.memory("downloads")
    if not isinstance(mem.get("list"), list):
        mem["list"] = []
    if not isinstance(mem.get("drops"), list):
        mem["drops"] = []
    return mem


def entry_of(mem, did):
    return next((e for e in mem["list"] if e["id"] == did), None)


def meta_path(node, did):
    return os.path.join(meta_dir(node), did + ".torrent")


def meta_b64(node, did):
    try:
        with open(meta_path(node, did), "rb") as f:
            return base64.b64encode(f.read()).decode()
    except OSError:
        return None


def ranges_of(e, p):
    """A part's ranges of the download's files: [[file, from, to]] (bytes in that file), in order."""
    files = e.get("files") or []
    if p.get("pieces"):
        lo, hi = p["pieces"]
        pl = e["pieceLength"]
        b0, b1 = lo * pl, min(hi * pl, e["size"])
        out, pos = [], 0
        for i, (_, ln) in enumerate(files):
            s, t = max(b0, pos), min(b1, pos + ln)
            if s < t:
                out.append([i, s - pos, t - pos])
            pos += ln
        return out
    idx = p.get("files")
    return [[i, 0, files[i][1]] for i in (idx if isinstance(idx, list) else range(len(files)))]


def part_size(e, p):
    return sum(t - s for _, s, t in ranges_of(e, p)) if e.get("files") else 0


def fresh(name, now=None):
    b = _beats.get(name)
    return bool(b) and (now or time.time()) - b["at"] < FRESH_S


def candidates(node, size, exclude=()):
    """The computers a download may go to now, the freest network first: [(name, why not, or "")]. With room for size
    (bytes) beyond what each keeps free. The home itself is one (its own Transmission, the cluster's)."""
    now = time.time()
    out = []
    for name, b in list(_beats.items()):  # (a computer's word may come in meanwhile)
        if name in exclude or now - b["at"] >= FRESH_S:
            continue
        why = "" if b.get("ready") else "no Transmission of its own"
        if not why and not b.get("free"):
            why = b.get("why") or "busy"
        if not why and (b.get("room") or 0) < size + (b.get("reserve") or RESERVE_MIN):
            why = "%s of room" % gb(b.get("room") or 0)
        out.append((name, why, b.get("net"), b.get("room") or 0))
    if node.name not in exclude:  # (the home: its Transmission's folder, its own network)
        have, reserve = room(node, apps_mod(node).home_dir() if apps_mod(node) else None)
        busy, _ = net_busy(node)
        out.append((node.name, "" if have >= size + reserve else "%s of room" % gb(have), busy, have))
    usable = [c for c in out if not c[1]]
    net = lambda c: c[2] if c[2] is not None else 10 ** 9
    usable.sort(key=lambda c: (net(c) // TIE_BYTES, c[0] != node.name, net(c), -c[3]))
    return usable, [c for c in out if c[1]]


def gb(n):
    return "%.1f GB" % (n / 1e9)


def new_id():
    return "d" + uuid.uuid4().hex[:10]


def act_add(node, args):
    """A new download: where ("home": its own Transmission, a computer's name, or "freest"), split (None, "files" or
    "pieces"), after ("home": the home takes it over, or "keep"), and a magnet link or a .torrent file's bytes (base64),
    into a folder on the home."""
    if not is_home(node):
        return {"ok": False, "error": "Ask the device that keeps Transmission's files."}
    A = apps_mod(node)
    where = str(args.get("where") or "home")
    split = args.get("split") or None
    after = args.get("after") if args.get("after") in ("home", "keep") else "home"
    if split not in (None, "files", "pieces"):
        return {"ok": False, "error": "Split it by files, or by pieces?"}
    folder = os.path.normpath(str(args.get("folder") or os.path.join(A.home_dir(), "Downloads")))
    if not A.top_of(folder):
        return {"ok": False, "error": "Choose a folder in your home on %s." % node.name}
    meta = None
    try:
        if args.get("torrent"):
            raw = base64.b64decode(str(args["torrent"]))
            meta = parse_meta(raw)
            h, name = meta["hash"], meta["name"]
        elif str(args.get("magnet") or "").startswith("magnet:"):
            h, name = parse_magnet(str(args["magnet"]))
        else:
            return {"ok": False, "error": "A magnet link or a .torrent file?"}
    except (ValueError, TypeError) as e:
        return {"ok": False, "error": str(e)}
    mem = book(node)
    with _lock:
        if any(e["hash"] == h for e in mem["list"]):
            return {"ok": False, "error": "That one's already downloading on the cluster's computers."}
    try:
        if any(str(t.get("hashString") or "").lower() == h for t in A.ask_tr(node, "torrent-get", {"fields": ["hashString"]}, timeout=10).get("torrents", [])):
            return {"ok": False, "error": "The cluster's Transmission has that one already."}
    except (RuntimeError, OSError):
        pass
    size = meta["size"] if meta else UNKNOWN_SIZE
    if meta and os.path.exists(os.path.join(folder, meta["files"][0][0].split("/")[0])):
        return {"ok": False, "error": "%s already has %s in that folder." % (node.name, meta["files"][0][0].split("/")[0])}
    usable, not_now = candidates(node, size if not split else 0)
    if where == "freest":
        if not usable:
            return {"ok": False, "error": "No computer is free with room for it now%s." % (
                " (" + "; ".join("%s: %s" % (c[0], c[1]) for c in not_now) + ")" if not_now else "")}
        if not split and usable[0][0] == node.name:
            a = A.act_add(node, args)
            if a.get("ok"):
                a["message"] = a["message"].rstrip(".") + " (on %s: its network was the least busy)." % node.name
            return a
    if where in ("home", node.name):
        return A.act_add(node, args)
    if split and meta and meta["padded"]:
        return {"ok": False, "error": "That torrent has padding files (a v2 hybrid): download it whole."}
    if split:
        devices = [c for c in usable if c[0] != node.name and (split != "pieces" or (_beats.get(c[0]) or {}).get("pieces"))][:MAX_SPLIT]
        while len(devices) >= 2:  # (each with room for its share)
            share = size / len(devices)
            short = [c for c in devices if c[3] < share + ((_beats.get(c[0]) or {}).get("reserve") or RESERVE_MIN)]
            if not short:
                break
            devices = [c for c in devices if c not in short]
        if len(devices) < 2:
            why = "libtorrent on at least two computers" if split == "pieces" else "two computers free with room"
            return {"ok": False, "error": "Splitting it needs %s; now: %s." % (why, ", ".join(c[0] for c in devices) or "none")}
        names = [c[0] for c in devices]
    elif where == "freest":
        names = [next(c[0] for c in usable if c[0] != node.name)] if any(c[0] != node.name for c in usable) else []
    else:
        b = _beats.get(where)
        if not b or not fresh(where):
            return {"ok": False, "error": "%s isn't answering (its Downloads may be off)." % where}
        if not b.get("ready"):
            return {"ok": False, "error": "%s has no Transmission of its own yet." % where}
        if (b.get("room") or 0) < size + (b.get("reserve") or RESERVE_MIN):
            return {"ok": False, "error": "%s has only %s of room." % (where, gb(b.get("room") or 0))}
        names = [where]
    if not names:
        return {"ok": False, "error": "No computer is free with room for it now."}
    did = new_id()
    os.makedirs(meta_dir(node), exist_ok=True)
    e = {"id": did, "hash": h, "name": name or "a magnet link", "magnet": None if meta else str(args["magnet"]), "meta": bool(meta),
         "folder": folder, "after": after, "where": where, "split": split, "state": "downloading", "error": None, "created": time.time(),
         "paused": False, "parts": []}
    if meta:
        with open(meta_path(node, did), "wb") as f:
            f.write(raw)
        e.update(files=meta["files"], pieceLength=meta["pieceLength"], pieces=meta["pieces"], size=meta["size"])
    if split and not meta:
        e["state"] = "metadata"
        e["parts"] = [{"device": names[0], "files": "none", "state": "downloading", "copied": [0, 0], "copiedBytes": 0}]
        e["splitOver"] = names
    elif split:
        e["parts"] = split_parts(e, names, split)
    else:
        e["parts"] = [{"device": names[0], "files": None, "state": "downloading", "copied": [0, 0], "copiedBytes": 0}]
    with _lock:
        mem["list"].append(e)
        mem.save()
    on = ", ".join(p["device"] for p in e["parts"]) if not e.get("splitOver") else ", ".join(e["splitOver"])
    node.event("downloads", "%s: downloading on %s, then to %s." % (e["name"], on, folder))
    return {"ok": True, "id": did, "message": "Added %s: %s %s%s, then copied to %s." % (
        e["name"], "split between" if split else "downloading on", on, " (its network was the least busy)" if where == "freest" and not split else "",
        node.name)}


def split_parts(e, names, how):
    """A download's parts, one a computer: its files (the biggest first, each to the one with the least so far), or
    its pieces (as many to each)."""
    files = e["files"]
    if how == "files":
        if len(files) < 2:
            how = "pieces"
        else:
            load = {n: 0 for n in names}
            mine = {n: [] for n in names}
            for i in sorted(range(len(files)), key=lambda i: -files[i][1]):
                n = min(names, key=lambda n: (load[n], names.index(n)))
                mine[n].append(i)
                load[n] += files[i][1]
            return [{"device": n, "files": sorted(mine[n]), "state": "downloading", "copied": [0, 0], "copiedBytes": 0} for n in names if mine[n]]
    total = e["pieces"]
    step = -(-total // len(names))
    return [{"device": n, "pieces": [k * step, min(total, (k + 1) * step)], "state": "downloading", "copied": [0, 0], "copiedBytes": 0}
            for k, n in enumerate(names) if k * step < total]


def take_meta(node, mem, worker, h, b64):
    e = next((x for x in mem["list"] if x["hash"] == h and not x.get("meta")), None)
    if not e:
        return
    try:
        raw = base64.b64decode(b64)
        meta = parse_meta(raw)
    except (ValueError, TypeError):
        return
    if meta["hash"] != h:
        return
    os.makedirs(meta_dir(node), exist_ok=True)
    with open(meta_path(node, e["id"]), "wb") as f:
        f.write(raw)
    e.update(meta=True, magnet=None, name=meta["name"], files=meta["files"], pieceLength=meta["pieceLength"], pieces=meta["pieces"], size=meta["size"])
    top = meta["files"][0][0].split("/")[0]
    if os.path.exists(os.path.join(e["folder"], top)):
        fail(node, e, "%s already has %s in %s: not overwritten." % (node.name, top, e["folder"]))
        return
    if e["state"] == "metadata":
        how = e["split"]
        if meta["padded"]:
            e["parts"][0]["files"] = None
            e["state"] = "downloading"
            node.event("downloads", "%s has padding files: downloading it whole on %s." % (e["name"], e["parts"][0]["device"]))
            return
        names = [n for n in e.get("splitOver") or [] if fresh(n)] or [e["parts"][0]["device"]]
        if how == "pieces":
            names = [n for n in names if (_beats.get(n) or {}).get("pieces")] or [e["parts"][0]["device"]]
        first = e["parts"][0]["device"]
        parts = split_parts(e, names if first in names else [first] + names, how)
        if how == "pieces" and first not in [p["device"] for p in parts]:
            parts = split_parts(e, [first], "files")
        if how == "pieces":  # (the first computer's Transmission had it for its file list: given up, pieces.py takes over)
            add_drop(mem, first, h, e["id"], True, "tr")
        e["parts"] = parts
        e["state"] = "downloading"
        node.event("downloads", "%s: split between %s." % (e["name"], ", ".join(p["device"] for p in parts)))


def add_drop(mem, device, h, did, delete, what="all"):
    """A computer told to remove a torrent: its Transmission's copy ("tr"), its part by pieces ("pieces"), or both."""
    mem["drops"] = [d for d in mem["drops"] if not (d["device"] == device and d["hash"] == h and d.get("what", "all") == what)]
    mem["drops"].append({"device": device, "hash": h, "id": did, "deleteData": bool(delete), "what": what, "at": time.time()})


def dropping(mem, device, h, pieces):
    """Whether a computer's being told to remove that part of a torrent (so it isn't asked to have it too)."""
    return any(d["device"] == device and d["hash"] == h and d.get("what", "all") in ("all", "pieces" if pieces else "tr") for d in mem["drops"])


def fail(node, e, why):
    e.update(state="failed", error=why)
    node.event("downloads", "%s: %s" % (e["name"], why), bad=True)


def act_beat(node, args):
    """A computer's word (every 5 s): how it is and its torrents -> what it should have, what to remove, and what the
    home still needs from it (a torrent's own file, its files' names)."""
    if not is_home(node):
        return {"ok": False, "error": "%s doesn't keep Transmission's files." % node.name}
    worker = str(args.get("worker") or "")
    if not worker or worker == node.name:
        return {"ok": False, "error": "Who's asking?"}
    now = time.time()
    with _lock:
        mem = book(node)
        _beats[worker] = {"at": now, **{k: args.get(k) for k in ("ready", "free", "why", "room", "reserve", "net", "mbit", "pieces", "running", "error", "copying")}}
        said = [r for r in args.get("torrents") or [] if isinstance(r, dict) and HASH.match(str(r.get("hash") or ""))]
        reps = {r["hash"]: r for r in said}
        has_tr = {r["hash"] for r in said if not r.get("pieces")}
        has_pieces = {r["hash"] for r in said if r.get("pieces")}
        _reports[worker] = reps
        changed = False
        for h, b64 in (args.get("meta") or {}).items():
            take_meta(node, mem, worker, str(h).lower(), b64)
            changed = True
        for h, files in (args.get("files") or {}).items():
            e = next((x for x in mem["list"] if x["hash"] == str(h).lower()), None)
            if e and not e.get("named") and isinstance(files, list) and e.get("files") and len(files) == len(e["files"]) \
                    and all(isinstance(f, list) and len(f) == 2 and safe_rel(str(f[0])) and int(f[1]) == e["files"][i][1] for i, f in enumerate(files)):
                e["files"] = [[str(f[0]), int(f[1])] for f in files]  # (as its Transmission names them: pi's will look for those)
                e["named"] = True
                changed = True
        for e in mem["list"]:
            for p in e["parts"]:
                if p["device"] != worker or p["state"] != "downloading" or e["state"] != "downloading":
                    continue
                r = reps.get(e["hash"])
                if r and r.get("meta") == 1 and r.get("left") == 0 and r.get("wantedOk") and (r.get("size") or r.get("pieces")):
                    p["state"] = "downloaded"
                    changed = True
        before = len(mem["drops"])
        gone = lambda d: not ((d.get("what", "all") in ("tr", "all") and d["hash"] in has_tr) or (d.get("what", "all") in ("pieces", "all") and d["hash"] in has_pieces))
        mem["drops"] = [d for d in mem["drops"] if not (d["device"] == worker and gone(d) and now - d["at"] > 30) and now - d["at"] < 7 * 86400]
        changed |= len(mem["drops"]) != before
        grant(node, mem, now)
        if changed:
            mem.save()
        want = wants_for(node, mem, worker, reps)
        drop = [{"hash": d["hash"], "id": d.get("id"), "deleteData": d["deleteData"], "what": d.get("what", "all")} for d in mem["drops"] if d["device"] == worker]
        need_meta = [e["hash"] for e in mem["list"] if not e.get("meta") and any(p["device"] == worker for p in e["parts"]) and e["hash"] in reps]
        need_files = [e["hash"] for e in mem["list"] if e.get("meta") and not e.get("named") and e["hash"] in reps
                      and any(p["device"] == worker and not p.get("pieces") for p in e["parts"])]
    return {"ok": True, "want": want, "drop": drop, "needMeta": need_meta, "needFiles": need_files}


def wants_for(node, mem, worker, reps):
    out = []
    for e in mem["list"]:
        if e["state"] == "failed":
            continue
        for idx, p in enumerate(e["parts"]):
            if p["device"] != worker or dropping(mem, worker, e["hash"], bool(p.get("pieces"))):
                continue
            w = {"id": e["id"], "part": idx, "hash": e["hash"], "name": e["name"], "paused": bool(e.get("paused")),
                 "files": p.get("files"), "fileCount": len(e["files"]) if e.get("files") else None, "pieces": p.get("pieces")}
            r = reps.get(e["hash"])
            if not r or bool(r.get("pieces")) != bool(p.get("pieces")):  # (it hasn't got it yet: the torrent's own file, or its magnet link)
                w["meta"] = meta_b64(node, e["id"]) if e.get("meta") else None
                w["magnet"] = None if e.get("meta") else e.get("magnet")
            if _turn["holder"] == [e["id"], idx] and p["state"] in ("downloaded", "copying"):
                rs = ranges_of(e, p)
                w["copy"] = {"go": True, "from": p["copied"], "ranges": rs, "names": {str(i): e["files"][i][0] for i, _, _ in rs}}
            out.append(w)
    return out


def grant(node, mem, now):
    """Whose turn it is to copy to the home: one computer at a time, the download added first first."""
    if _turn["holder"]:
        e = entry_of(mem, _turn["holder"][0])
        p = e["parts"][_turn["holder"][1]] if e and _turn["holder"][1] < len(e["parts"]) else None
        if not p or p["state"] not in ("downloaded", "copying") or e["state"] != "downloading" or now - _turn["beat"] > TURN_STALE_S \
                or not (_beats.get(p["device"]) or {}).get("free"):
            _turn["holder"] = None
    if _turn["holder"]:
        return
    for e in sorted(mem["list"], key=lambda x: x["created"]):
        if e["state"] != "downloading" or e.get("paused"):
            continue
        for idx, p in enumerate(e["parts"]):
            b = _beats.get(p["device"]) or {}
            if p["state"] in ("downloaded", "copying") and fresh(p["device"], now) and b.get("free"):
                _turn.update(holder=[e["id"], idx], beat=now)
                p["state"] = "copying"
                return


def dest_of(e, i):
    return os.path.join(e["folder"], *e["files"][i][0].split("/"))


def route_piece(node, h, q):
    """A piece of a computer's part of a download (PUT ?id=&part=&r=&at=): written where it goes, in its file's .part.
    -> {"next": [range, at]}: where to go on from (a piece that came before, its answer lost, just says so)."""
    data = node.body_bytes(h, MAX_PIECE)
    if data is None:
        return node.send(h, 413, {"error": "Too big a piece."})
    try:
        did, idx, r, at = str(q.get("id") or ""), int(q.get("part") or 0), int(q.get("r") or 0), int(q.get("at") or 0)
    except ValueError:
        return node.send(h, 400, {"error": "Which piece?"})
    with _lock:
        mem = book(node) if is_home(node) else None
        e = entry_of(mem, did) if mem else None
        if not e or idx >= len(e["parts"]) or e["state"] != "downloading":
            return node.send(h, 409, {"error": "That download isn't being copied here.", "next": [0, 0], "stop": True})
        p = e["parts"][idx]
        if _turn["holder"] != [did, idx]:
            return node.send(h, 409, {"error": "It isn't that computer's turn to copy.", "next": p["copied"], "stop": True})
        if [r, at] != p["copied"]:
            return node.send(h, 409, {"error": "Out of turn", "next": p["copied"]})
        rs = ranges_of(e, p)
        if r >= len(rs):
            return node.send(h, 409, {"error": "It's all here.", "next": p["copied"], "stop": True})
        i, s, t = rs[r]
        if at + len(data) > t - s:
            return node.send(h, 400, {"error": "Past the end of its file."})
        _turn["beat"] = time.time()
    path = dest_of(e, i) + ".part"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o644)
        try:
            os.lseek(fd, s + at, 0)
            view = memoryview(data)
            while view:
                n = os.write(fd, view)
                view = view[n:]
        finally:
            os.close(fd)
    except OSError as ex:
        return node.send(h, 507, {"error": "Couldn't write it: %s" % ex, "next": [r, at]})
    with _lock:
        at += len(data)
        while r < len(rs) and at >= rs[r][2] - rs[r][1]:
            r, at = r + 1, 0
            if r < len(rs) and rs[r][2] == rs[r][1]:  # (an empty file: made, nothing to send)
                os.makedirs(os.path.dirname(dest_of(e, rs[r][0])), exist_ok=True)
                open(dest_of(e, rs[r][0]) + ".part", "ab").close()
        p["copied"] = [r, at]
        p["copiedBytes"] = sum(x[2] - x[1] for x in rs[:r]) + at
        if r >= len(rs):
            p["state"] = "copied"
            _turn["holder"] = None
            node.event("downloads", "%s: %s's part copied to %s." % (e["name"], p["device"], node.name))
        mem.save()
    return node.send(h, 200, {"ok": True, "next": [r, at]})


def home_tick(node):
    mem = book(node)
    now = time.time()
    with _lock:
        if _turn["holder"] and now - _turn["beat"] > TURN_STALE_S:
            grant(node, mem, now)
        todo = [e for e in mem["list"] if e["id"] not in _finishing and (
            (e["state"] == "downloading" and e["parts"] and all(p["state"] == "copied" for p in e["parts"])) or e["state"] == "checking")]
        for e in todo:
            _finishing.add(e["id"])
    for e in todo:
        threading.Thread(target=finish, args=(node, e), daemon=True).start()


def finish(node, e):
    """A download all here: its files' .part names dropped, then pi takes it over (its Transmission checks it and
    seeds it; the computers' copies go once it has all of it), or it's left to the computers to seed."""
    mem = book(node)
    try:
        if e["state"] == "downloading":
            for i, (rel, ln) in enumerate(e["files"]):
                final = dest_of(e, i)
                part = final + ".part"
                if os.path.exists(final):
                    with _lock:
                        fail(node, e, "%s already has %s: not overwritten (it's left as %s.part)." % (node.name, rel, os.path.basename(final)))
                        mem.save()
                    return
                if not os.path.exists(part):
                    if ln:
                        with _lock:
                            fail(node, e, "%s never came." % rel)
                            mem.save()
                        return
                    os.makedirs(os.path.dirname(part), exist_ok=True)
                    open(part, "wb").close()
                elif os.path.getsize(part) != ln:
                    with open(part, "r+b") as f:  # (pieces never sent: a file shorter than it is)
                        f.truncate(ln)
            for i in range(len(e["files"])):
                os.replace(dest_of(e, i) + ".part", dest_of(e, i))
            with _lock:
                e["state"] = "checking" if e["after"] == "home" else "seeding"
                mem.save()
            node.event("downloads", "%s is on %s now%s." % (e["name"], node.name, ", for its Transmission to check and seed" if e["after"] == "home" else
                                                               " (%s keeps seeding it)" % ", ".join(p["device"] for p in e["parts"])))
        if e["state"] == "checking":
            take_over(node, mem, e)
    except (OSError, RuntimeError) as ex:
        with _lock:
            e["error"] = str(ex)
            mem.save()
    finally:
        _finishing.discard(e["id"])


def take_over(node, mem, e):
    """pi's Transmission given it (its copy checked first), and the computers told to drop theirs once it has all."""
    A = apps_mod(node)
    if not e.get("given"):
        top = A.top_of(e["folder"])
        amem = node.memory("apps")
        if top and top not in (amem.get("names") or []):
            A.share(node, sorted(set(amem.get("names") or []) | {top}))
        b64 = meta_b64(node, e["id"])
        if not b64:
            raise RuntimeError("its own torrent file is missing here")
        got = A.ask_tr(node, "torrent-add", {"metainfo": b64, "download-dir": e["folder"], "paused": True}, timeout=30)
        t = got.get("torrent-added") or got.get("torrent-duplicate") or {}
        A.ask_tr(node, "torrent-verify", {"ids": [e["hash"]]})
        A.ask_tr(node, "torrent-start", {"ids": [e["hash"]]})
        with _lock:
            e["given"] = True
            mem.save()
        node.event("downloads", "%s: %s's Transmission checks its copy, then seeds it." % (e["name"], node.name))
    got = A.ask_tr(node, "torrent-get", {"ids": [e["hash"]], "fields": ["percentDone", "status", "recheckProgress"]}, timeout=15).get("torrents") or []
    if not got:
        with _lock:
            e["given"] = False  # (not there: given again)
            mem.save()
        return
    t = got[0]
    e["check"] = {"pct": t.get("percentDone"), "status": t.get("status"), "recheck": t.get("recheckProgress")}
    if t.get("status") not in (1, 2) and (t.get("percentDone") or 0) >= 1:
        with _lock:
            for p in e["parts"]:
                add_drop(mem, p["device"], e["hash"], e["id"], True)
            mem["list"] = [x for x in mem["list"] if x["id"] != e["id"]]
            mem.save()
        try:
            os.remove(meta_path(node, e["id"]))
        except OSError:
            pass
        node.event("downloads", "%s: %s seeds it now; the copies on %s are deleted." % (e["name"], node.name, ", ".join(p["device"] for p in e["parts"])))


# ----- the app's buttons (on the home) -----
def act_list(node, args):
    if not is_home(node):
        return {"ok": False, "error": "Ask the device that keeps Transmission's files."}
    now = time.time()
    with _lock:
        mem = book(node)
        out = []
        for e in mem["list"]:
            parts, done, total = [], 0, 0
            for idx, p in enumerate(e["parts"]):
                r = (_reports.get(p["device"]) or {}).get(e["hash"]) or {}
                b = _beats.get(p["device"]) or {}
                size = part_size(e, p)
                total += size
                pct = 1.0 if p["state"] in ("downloaded", "copying", "copied") else float(r.get("pct") or 0)
                done += pct * size
                parts.append({"device": p["device"], "state": p["state"], "pct": pct, "down": r.get("down") or 0, "up": r.get("up") or 0,
                              "peers": r.get("peers"), "eta": r.get("eta"), "error": r.get("error") or "", "size": size,
                              "copied": p.get("copiedBytes") or 0, "turn": _turn["holder"] == [e["id"], idx],
                              "heard": bool(b) and now - b["at"] < FRESH_S, "free": b.get("free"), "why": b.get("why") or "",
                              "files": len(p["files"]) if isinstance(p.get("files"), list) else None, "pieces": p.get("pieces"),
                              "copyRate": (b.get("copying") or {}).get("rate") if _turn["holder"] == [e["id"], idx] else None})
            out.append({"id": e["id"], "hash": e["hash"], "name": e["name"], "state": e["state"], "error": e.get("error"), "after": e["after"],
                        "split": e.get("split"), "folder": e["folder"], "paused": bool(e.get("paused")), "created": e["created"],
                        "size": e.get("size"), "pct": (done / total) if total else 0.0, "copied": sum(p["copied"] for p in parts),
                        "parts": parts, "check": e.get("check")})
        computers = [{"name": n, "ready": b.get("ready"), "free": b.get("free"), "why": b.get("why") or "", "room": b.get("room"),
                      "reserve": b.get("reserve"), "net": b.get("net"), "pieces": b.get("pieces"), "heard": now - b["at"] < FRESH_S}
                     for n, b in sorted(_beats.items())]
        busy, _ = net_busy(node)
        have, reserve = room(node, apps_mod(node).home_dir())
        computers.append({"name": node.name, "home": True, "ready": True, "free": True, "why": "", "room": have, "reserve": reserve, "net": busy, "heard": True})
    return {"ok": True, "downloads": out, "computers": computers}


def act_pause(node, args):
    with _lock:
        mem = book(node)
        e = entry_of(mem, str(args.get("id") or ""))
        if not e:
            return {"ok": False, "error": "No such download."}
        e["paused"] = bool(args.get("paused"))
        mem.save()
    return {"ok": True, "message": "%s %s." % (e["name"], "paused" if e["paused"] else "going on")}


def act_after(node, args):
    """Once it's on pi: pi takes over, or its computers keep seeding it (changed any time before pi took it; a download
    kept seeding is handed to pi so)."""
    after = args.get("after")
    if after not in ("home", "keep"):
        return {"ok": False, "error": "pi takes over, or the computer keeps seeding it?"}
    with _lock:
        mem = book(node)
        e = entry_of(mem, str(args.get("id") or ""))
        if not e:
            return {"ok": False, "error": "No such download."}
        e["after"] = after
        if e["state"] == "seeding" and after == "home":
            e["state"] = "checking"
        mem.save()
    return {"ok": True, "message": "%s: %s." % (e["name"], "%s takes it over once it's there" % node.name if after == "home" else "its computers keep seeding it")}


def act_remove(node, args):
    """A download taken off the cluster's computers (their copies deleted); pi's copy stays if it's all there."""
    with _lock:
        mem = book(node)
        e = entry_of(mem, str(args.get("id") or ""))
        if not e:
            return {"ok": False, "error": "No such download."}
        if e["id"] in _finishing:
            return {"ok": False, "error": "It's being handed to %s just now: try again in a moment." % node.name}
        for p in e["parts"]:
            add_drop(mem, p["device"], e["hash"], e["id"], True)
        mem["list"] = [x for x in mem["list"] if x["id"] != e["id"]]
        if _turn["holder"] and _turn["holder"][0] == e["id"]:
            _turn["holder"] = None
        mem.save()
    if e["state"] in ("downloading", "metadata") and e.get("files"):
        for i in range(len(e["files"])):
            try:
                os.remove(dest_of(e, i) + ".part")
            except OSError:
                pass
    try:
        os.remove(meta_path(node, e["id"]))
    except OSError:
        pass
    return {"ok": True, "message": "Removed %s from the cluster's computers%s." % (
        e["name"], "; %s keeps its copy" % node.name if e["state"] in ("seeding", "checking") else "")}


def act_get_libtorrent(node, args):
    """libtorrent put on this computer (a Pi: Debian's python3-libtorrent; the PC: in its Linux, with python3), for
    downloads split by pieces."""
    if node.simulate:
        return {"ok": False, "error": "Not while simulated."}
    if PHONE:
        return {"ok": False, "error": "A phone downloads whole files with its app's own Transmission: libtorrent isn't for phones."}
    if WINDOWS:
        code, out = apps_mod(node).wsl_call(node, ["install-libtorrent"], 1800)
        a = {"ok": code == 0, "error": out.splitlines()[-1] if out else str(code)}
        if a["ok"]:
            with open(os.path.join(node.state_dir, "libtorrent-ok"), "w", encoding="utf-8") as f:
                f.write(time.strftime("%Y-%m-%d %H:%M:%S\n"))
    else:
        a = node.root("install-libtorrent", timeout=1800)
    _dev["pieces"] = None
    return {"ok": True, "message": "libtorrent is on %s now." % node.name} if a.get("ok") else {"ok": False, "error": a.get("error")}


ACTIONS = {
    "beat": {"run": act_beat, "hidden": True},
    "add": {"run": act_add, "hidden": True},
    "list": {"run": act_list, "hidden": True},
    "pause": {"run": act_pause, "hidden": True},
    "after": {"run": act_after, "hidden": True},
    "remove": {"run": act_remove, "hidden": True},
    "getLibtorrent": {"title": "Get libtorrent (to split a big file by pieces)", "run": act_get_libtorrent,
                      "confirm": "Download and install libtorrent here (a few MB from Debian)?", "hidden": PHONE},  # (not on a phone)
}
ROUTES = {"PUT /api/downloads/piece": route_piece}


def tick(node):
    sample_net(node)
    if is_home(node):
        home_tick(node)
    else:
        device_tick(node)


def status(node):
    ok, why = _dev.get("free") or (True, "")
    have, reserve = room(node)
    busy, mbit = net_busy(node)
    out = {"ready": ready(node), "free": ok, "why": why, "room": have, "reserve": reserve, "net": busy, "mbit": mbit,
           "home": is_home(node), "pieces": _dev["pieces"], "error": _dev["error"], "copying": _copy["what"]}
    parts = []
    if out["home"]:
        mem = book(node)
        n = len(mem["list"])
        copying = next((e["name"] for e in mem["list"] if _turn["holder"] and e["id"] == _turn["holder"][0]), None)
        parts.append("Keeps the list of downloads on other computers: %d%s" % (n, " (copying %s here)" % copying if copying else ""))
    elif not out["ready"]:
        parts.append("Can't download here yet: %s" % ("its Linux for it isn't set up (setup.py --linux)" if WINDOWS else "no Transmission here"))
    else:
        rep = (_dev["answer"] or {}).get("want") or []
        parts.append("Downloads here: %d torrent%s" % (len(rep), "" if len(rep) == 1 else "s") + ("" if ok else " (paused: %s)" % why))
        parts.append("%s of room" % gb(max(0, have - reserve)))
    if busy is not None:
        parts.append("network %s" % ("%.1f MB/s" % (busy / 1e6) if busy >= 1e6 else "%d KB/s" % round(busy / 1e3)))
    if _copy["what"]:
        parts.append("copying %s to %s%s" % (_copy["what"], (_dev["home"] or {}).get("name") or "its home",
                                             " (%.1f MB/s)" % (_copy["rate"] / 1e6) if _copy["rate"] else ""))
    out["summary"] = " · ".join(parts)
    out["warnings"] = [w for w in (_dev["error"], _copy["error"]) if w]
    return out
