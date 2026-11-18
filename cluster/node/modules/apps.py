"""
apps.py - Pi Cluster module: apps the cluster runs on whichever Pi is free. The first is Transmission.

Transmission's torrents, settings and files stay on one Pi, its home: the Pi with "Transmission's
files and settings are here" on (pi). It runs on whichever Pi is free and allowed to ("Can run
Transmission"), the home first. A Pi stops being free if it's recording, too hot, short of memory,
or its battery is low. When it isn't free, or goes quiet, Transmission moves on.
- On another Pi: the home's folders are mounted (an NFS share, Tailscale's addresses only; the root
  helper's nfs-share) and put back at their own paths for Transmission alone, so every torrent keeps
  its folder.
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
"""

import ipaddress
import json
import os
import re
import shutil
import signal
import socket
import threading
import time
import urllib.error
import urllib.request

TITLE = "Apps"
ORDER = 50
ON = True
EVERY = 5
SETTINGS = [
    {"key": "transmission", "title": "Can run Transmission", "default": True},
    {"key": "home", "title": "Transmission's files and settings are here", "default": False},
]

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
    return bool(node.setting("apps", "home"))


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
def unit_active(node):
    if node.simulate:
        return os.path.exists(os.path.join(node.state_dir, "tr-running"))
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
    aside = os.path.join(g, "moved-to-pi-cluster")
    os.makedirs(aside, exist_ok=True)
    for part in ("torrents", "resume", "queue.json"):
        if os.path.exists(os.path.join(g, part)):
            shutil.move(os.path.join(g, part), os.path.join(aside, part))
    with open(os.path.join(aside, "README.txt"), "w", encoding="utf-8") as f:
        f.write("These torrents moved into Pi Cluster's Transmission (%s) on %s.\n"
                "Pi Cluster's app: Give them back to the window app moves them back here.\n" % (c, time.strftime("%Y-%m-%d %H:%M")))
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
        alt = ask_tr(node, "session-get", {"fields": ["alt-speed-enabled"]}, timeout=3).get("alt-speed-enabled")
        _stats.update(at=time.time(), torrents=st.get("torrentCount"), down=st.get("downloadSpeed"), up=st.get("uploadSpeed"), turtle=bool(alt))
    except (RuntimeError, OSError):
        pass
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
    return {"ok": True, "run": run, "where": where, "names": mem.get("names") or []}


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
    _run["beat"] = now
    running = unit_active(node)
    home = _run["home"] if _run["home"] and now - _run["contact"] < 120 else find_home(node)
    if not home:
        if running and now - _run["contact"] > FENCE_S:
            stop_here(node, "can't reach the Pi with Transmission's files")
        return
    _run["home"] = home
    ok, why = free(node)
    h = node.status_of("health") if node.modules.get("health") else {}
    words = {"worker": node.name, "running": running, "free": ok, "why": why, "canRun": bool(node.setting("apps", "transmission")),
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
    if a.get("run"):
        if not running or a.get("names") != _run["names"] or a.get("where") != _run["where"]:
            start_here(node, a["where"], a.get("names") or [])
        else:
            keep_caps(node)
    elif running:
        stop_here(node, "%s asked it to stop" % home["name"])


def start_here(node, where, names):
    if _run["starting"]:
        return
    _run["starting"] = True

    def go():
        try:
            if not node.simulate and not os.path.exists("/usr/bin/transmission-daemon") or not node.simulate and not shutil.which("mount.nfs4"):
                a = node.root("install-transmission", timeout=1800)
                if not a.get("ok"):
                    _run["error"] = "Transmission didn't install: %s" % a.get("error")
                    return
            a = node.root("transmission-start", where, *names, timeout=600)
            if a.get("ok"):
                _run.update(names=names, where=where, error=None, caps=None)
                node.event("apps", "Transmission started here%s." % ("" if where == "local" else " (its files from " + where + ")"))
            else:
                _run["error"] = "Transmission didn't start: %s" % a.get("error")
                node.event("apps", _run["error"], bad=True)
        finally:
            _run["starting"] = False
    threading.Thread(target=go, daemon=True).start()


def stop_here(node, why):
    a = node.root("transmission-stop", timeout=300)
    _run.update(names=None, where=None, caps=None)
    node.event("apps", "Transmission stopped here: %s." % why, bad=not a.get("ok"))


def keep_caps(node):
    """Its own download and upload limits (the turtle's when on), kept on the Wi-Fi by Linux."""
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
    if node.setting("apps", "transmission") or unit_active(node) or _run["names"] is not None:
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
        t = ask_tr(node, "torrent-get", {"fields": ["id", "name", "percentDone", "status", "rateDownload", "rateUpload", "downloadDir", "errorString", "eta", "totalSize"]})
    except (RuntimeError, OSError) as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "torrents": t.get("torrents", [])}


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
    "folders": {"run": act_folders, "hidden": True},
    "add": {"run": act_add, "hidden": True},
}


def status(node):
    ok, why = free(node)
    here = unit_active(node)
    out = {"home": is_home(node), "canRun": bool(node.setting("apps", "transmission")), "free": ok, "why": why, "runningHere": here,
           "error": _run["error"]}
    parts = []
    if here:
        parts.append("Transmission runs here")
    elif out["canRun"]:
        parts.append("Can run Transmission" + ("" if ok else " (not now: %s)" % why))
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
                out.update(torrents=_stats.get("torrents"), down=_stats.get("down"), up=_stats.get("up"), turtle=_stats.get("turtle"))
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
