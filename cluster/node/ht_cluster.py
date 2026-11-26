#!/usr/bin/env python3
"""
ht_cluster.py - Cluster's service on each Raspberry Pi in the cluster (cluster/README.md).

It answers the Cluster app over Tailscale (port 47830) and runs the cluster's modules: each one
a file in modules/ (health, rig, updates; later jobs and apps), turned on or off for this Pi from
the app, with its own settings for this Pi. A new module is a new file there: the app shows a
module it doesn't know yet as its one-line summary, its warnings, its switches and its buttons.

Who may use it: only the Tailscale account this Pi is logged in with (each request's address is
looked up with `tailscale whois`), and this Pi itself (readings only). Every request carries
X-HT-Cluster: 1 and names this Pi in its Host (so a web page in a browser can't send one), and a
change is JSON.

The Cluster page in a browser: http://<this Pi>:47830/ serves the app's own page (PAGE_FILES, from
web/: the root helper puts the build's copies there), to the same Tailscale account only, never in
another site's frame. Its requests come from the page itself (same origin, so they can carry the
header); one for another Pi of the cluster names it in X-HT-Cluster-To, and this Pi passes it on as it
is (relay). A download goes through a one-time link (POST /api/ticket, then GET /api/download?ticket=:
a browser saves a file by following a link, which can't carry the header).

  python3 ht_cluster.py [--port 47830] [--simulate]
    --simulate: on any computer, for the checks: made-up readings, requests from this computer
    allowed for everything, Hand Tracker where HT_CLUSTER_HT_URL says, GitHub where
    HT_CLUSTER_GITHUB_API says and the root helper HT_CLUSTER_ROOT_HELPER (a script run with
    this Python, not sudo).

This Pi's settings, and what the modules remember: ~/.local/state/ht-cluster/ (HT_CLUSTER_STATE).

A module (modules/<name>.py) has:
  TITLE = "Health"; ORDER = 10 (its place in the app); ON = True (for a Pi that hasn't said);
  PLATFORMS = ("linux",) (optional: not loaded on a Windows PC; both by default)
  EVERY = 5 (seconds between tick()s while it's on)
  SETTINGS = [{"key", "title", "default", "choices"?: [[value, title], ...]}]  (no choices: on/off)
  start(node)         once, as the service starts (optional)
  tick(node)          every EVERY s while it's on, in a thread of its own (optional; may take long)
  status(node) -> {}  its readings now, quickly (from what tick() found): "summary" (one line),
                      "warnings" (a list), and anything else the app knows how to show
  ACTIONS = {name: {"title", "run": fn(node, args) -> {"message"}, "confirm"?, "hidden"?}}
  ROUTES = {"GET /api/<module>/<what>": fn(node, h, query)}   requests of its own (files going to or
                      from another Pi, say), each under /api/<its name>/, answered by fn itself
                      (node.send for JSON, node.send_bytes for anything else): the same checks first

Pis ask each other the same way the app asks them (node.ask), and find each other with node.cluster()
(the other Linux and Windows computers on Tailscale whose service answers).

On a phone (the user, 2026-11-23: "Have phone's able to join the cluster as a member too"; Android and iPhone, in the
Cluster app, its own switch): the same service, run by the app (HT_CLUSTER_PLATFORM=android or ios; node.phone), its
name, Tailscale address and the Pis it knows given by the app (HT_CLUSTER_NAME, HT_CLUSTER_TS_IP, HT_CLUSTER_SEEDS:
it can't ask Tailscale itself, which other apps can't), its readings from the phone (phonesys.py), and only the
modules made for phones (their PLATFORMS). Who may use it: a phone can't tell who's asking (Tailscale's own app keeps
that to itself), so it makes a key of its own (PHONE_KEY_FILE in its state) and gives it to each Pi it reaches
(POST /api/phone: a Pi takes it only from this account's devices, as everything); a request to it must carry that
key (X-HT-Cluster-Key), which the Pis add when they ask it or pass a request on to it (the page reaches phones
through a Pi). The Pis list phones among their Tailscale peers (phone: true).

On a Windows PC (the user, 2026-11-22: "this PC joins as a member"): the same service, started at sign-in by
its launcher (windows/launcher.py, which starts it again when it ends, as systemd does on a Pi), its state in
%USERPROFILE%/Cluster/state, the root helper's Windows part run as the user (its own update, the page),
and the modules' readings from Windows (winsys.py). node.windows says so (HT_CLUSTER_PLATFORM=windows).
"""

import argparse
import collections
import hmac
import html
import http.client
import http.server
import importlib.util
import ipaddress
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse

PORT = 47830
HERE = os.path.dirname(os.path.abspath(__file__))
MODULES_DIR = os.path.join(HERE, "modules")
ROOT_HELPER = "/usr/local/sbin/ht-cluster-root"
NO_WINDOW = 0x08000000 if os.name == "nt" else 0  # (on Windows: the commands it runs open no window, under pythonw)
MAX_BODY = 1 << 20  # (a job's list of files can be long)
KEEP_EVENTS = 60
# The Cluster page and the files it loads (the same list as ht-cluster-root's PAGE), served from web/
# beside this file; a copy of the code run as it is (dev, or --simulate) serves them from the folder
# they're in, two up.
PAGE_FILES = ("cluster.html", "cluster.js", "video-formats.js", "sentry-models.js", "models/kinds.js", "favicon.png", "apple-touch-icon.png")
PAGE_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png"}
RELAY_MAX = 32 << 20  # (a piece of a file going to another Pi through this one: the jobs take up to 16 MB)
RELAY_CONNECT_S = 6
RELAY_S = 300  # (packing a job's results as one zip can take minutes)
TICKET_S = 120
TS_V4 = ipaddress.ip_network("100.64.0.0/10")
PHONE_KEY_FILE = "phone-key"  # (a phone's own key, in its state folder)
PHONE_TELL_S = 60  # (how often a phone gives its key to the Pis it finds: a Pi new to the cluster learns it then)
PHONE_OSES = ("android", "ios")  # (Tailscale's names for the phones' systems, lower-cased)
TS_V6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")


def _ip(addr):
    try:
        ip = ipaddress.ip_address(str(addr).split("%")[0])
    except ValueError:
        return None
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip


def is_tailscale(addr):
    ip = _ip(addr)
    return bool(ip) and ip in (TS_V4 if ip.version == 4 else TS_V6)


def is_loopback(addr):
    ip = _ip(addr)
    return bool(ip) and ip.is_loopback


def run(cmd, timeout=20, env=None, stdin=None):
    """A command's (exit code, output, errors); (None, "", why) when it couldn't be run. stdin: text given to it (a
    password, say: never on its command line, which other programs can read)."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env, creationflags=NO_WINDOW,
                           input=stdin if stdin is not None else None, stdin=None if stdin is not None else subprocess.DEVNULL)
        return p.returncode, p.stdout or "", p.stderr or ""
    except (OSError, subprocess.TimeoutExpired) as e:
        return None, "", str(e)


def windows_folder():
    """A Windows PC's folder for the service (its launcher names it with HT_CLUSTER_INSTALL): %USERPROFILE%/Cluster, or
    one it was in before while only that one is there (setup.py moves it): %LOCALAPPDATA%/Cluster (until 2026-11-25),
    %LOCALAPPDATA%/Pi Cluster (before the rename)."""
    new = os.path.join(os.path.expanduser("~"), "Cluster")
    local = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    if os.path.isfile(os.path.join(new, "launcher.py")):
        return new
    for old in (os.path.join(local, "Cluster"), os.path.join(local, "Pi Cluster")):
        if os.path.isfile(os.path.join(old, "launcher.py")):
            return old
    return new


def read(path, default=None):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return default


def tailscale_cmd():
    """Tailscale's command (on Windows, where it's put if it isn't on the path)."""
    found = shutil.which("tailscale")
    if not found and os.name == "nt":
        default = os.path.join(os.environ.get("ProgramFiles") or r"C:\Program Files", "Tailscale", "tailscale.exe")
        found = default if os.path.exists(default) else None
    return found or "tailscale"


class Tailscale:
    """This Pi's own Tailscale account and names, and whose a request is (`tailscale whois`)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.me_info = None
        self.me_at = 0
        self.whois_cache = {}  # address -> (user ID or None, when)

    def me(self):
        with self.lock:
            if self.me_info and time.time() - self.me_at < 300:
                return self.me_info
        code, out, _ = run([tailscale_cmd(), "status", "--json", "--peers=false"], timeout=10)
        info = None
        if code == 0:
            try:
                s = json.loads(out).get("Self") or {}
                names = set()
                dns = str(s.get("DNSName") or "").rstrip(".").lower()
                if dns:
                    names.update([dns, dns.split(".")[0]])
                if s.get("HostName"):
                    names.add(str(s["HostName"]).lower())
                info = {"user": s.get("UserID"), "names": names, "ips": [str(a) for a in s.get("TailscaleIPs") or []]}
            except (ValueError, AttributeError):
                info = None
        with self.lock:
            if info:
                self.me_info, self.me_at = info, time.time()
            return self.me_info

    def user_of(self, addr):
        now = time.time()
        with self.lock:
            hit = self.whois_cache.get(addr)
            if hit and now - hit[1] < (600 if hit[0] is not None else 60):
                return hit[0]
        code, out, _ = run([tailscale_cmd(), "whois", "--json", addr], timeout=10)
        user = None
        if code == 0:
            try:
                user = (json.loads(out).get("UserProfile") or {}).get("ID")
            except (ValueError, AttributeError):
                user = None
        with self.lock:
            self.whois_cache[addr] = (user, now)
        return user

    def peers(self):
        """The other Linux and Windows computers, and the phones (phone: true), on this Tailscale network:
        [{name, ip, online, phone?}]."""
        code, out, _ = run([tailscale_cmd(), "status", "--json"], timeout=10)
        if code != 0:
            return []
        try:
            peers = (json.loads(out).get("Peer") or {}).values()
        except (ValueError, AttributeError):
            return []
        out_list = []
        for p in peers:
            os_name = str(p.get("OS") or "").lower()
            if os_name not in ("linux", "windows") + PHONE_OSES:
                continue
            ips = [str(a) for a in p.get("TailscaleIPs") or [] if ":" not in str(a)]
            if ips:
                out_list.append({"name": str(p.get("HostName") or ips[0]), "ip": ips[0], "online": bool(p.get("Online"))}
                                | ({"phone": True} if os_name in PHONE_OSES else {}))
        return out_list


class PhoneTailscale:
    """On a phone, what Tailscale would say, from what the Cluster app knows (other apps can't ask Tailscale): this
    phone's name and Tailscale address, and the other computers, as the Pis it knows (HT_CLUSTER_SEEDS) list them
    (theirs: no phones, which only the Pis can reach)."""

    def __init__(self, node):
        self.node = node
        self.lock = threading.Lock()
        self.cache = {"at": 0, "list": []}

    def me(self):
        ip = os.environ.get("HT_CLUSTER_TS_IP") or ""
        return {"user": None, "names": {self.node.name.lower()}, "ips": [ip] if is_tailscale(ip) else []}

    def user_of(self, addr):
        return None

    def seeds(self):
        out = []
        for t in (os.environ.get("HT_CLUSTER_SEEDS") or "").split(","):
            t = t.strip()
            if t and re.fullmatch(r"[A-Za-z0-9.:-]{1,80}", t) and t not in out:
                out.append(t)
        return out

    def peers(self):
        with self.lock:
            if time.time() - self.cache["at"] < 60:
                return list(self.cache["list"])
        found = {}
        for seed in self.seeds():
            code, d = self.node.ask(seed, "GET", "/api/peers", timeout=8)
            if code != 200 or not isinstance(d, dict):
                continue
            host = seed.rsplit(":", 1)[0] if seed.count(":") == 1 else seed
            if not is_tailscale(host):  # (a Pi the app knows by name, as "pi": its Tailscale address, as Tailscale's DNS gives it;
                # without it that Pi never had this phone's key, as it doesn't list itself among its peers: 2026-11-25)
                try:
                    host = next((a[4][0] for a in socket.getaddrinfo(host, None, socket.AF_INET) if is_tailscale(a[4][0])), host)
                except OSError:
                    pass
            if is_tailscale(host):
                found.setdefault(host, {"name": host, "ip": host, "online": True})
            for p in d.get("peers") or []:
                if isinstance(p, dict) and not p.get("phone") and is_tailscale(p.get("ip")) and p.get("ip") not in self.me()["ips"]:
                    found[p["ip"]] = {"name": str(p.get("name") or p["ip"]), "ip": p["ip"], "online": bool(p.get("online"))}
        with self.lock:
            if found or time.time() - self.cache["at"] > 600:
                self.cache = {"at": time.time(), "list": list(found.values())}
            return list(self.cache["list"])


class Memory(dict):
    """What a module remembers between runs (a JSON file in the state folder)."""

    def __init__(self, path):
        super().__init__()
        self.path = path
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                self.update(data)
        except (OSError, ValueError):
            pass

    def save(self):
        # (on its drive before it takes the old one's place: a power cut leaves the old file or the new, never an
        # empty one; the user, 2026-11-22, from a capture rig's own fix)
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except OSError:
            pass


class Module:
    def __init__(self, path):
        name = os.path.splitext(os.path.basename(path))[0]
        spec = importlib.util.spec_from_file_location("ht_cluster_module_" + name, path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.mod = mod
        self.name = name
        self.title = str(getattr(mod, "TITLE", name.capitalize()))
        self.order = int(getattr(mod, "ORDER", 100))
        self.default_on = bool(getattr(mod, "ON", True))
        self.every = max(1.0, float(getattr(mod, "EVERY", 10)))
        self.platforms = tuple(getattr(mod, "PLATFORMS", ("linux", "windows")))
        self.settings = [s for s in getattr(mod, "SETTINGS", []) if isinstance(s, dict) and s.get("key")]
        self.actions = dict(getattr(mod, "ACTIONS", {}))
        # (its own requests: only under /api/<its name>/)
        self.routes = {k: f for k, f in dict(getattr(mod, "ROUTES", {})).items()
                       if isinstance(k, str) and k.split(" ")[0] in ("GET", "POST", "PUT") and k.split(" ", 1)[-1].startswith("/api/%s/" % name)}
        self.error = None
        self.wake = threading.Event()


class Node:
    def __init__(self, simulate=False, state_dir=None, port=PORT):
        self.simulate = simulate
        self.port = port
        self.platform = os.environ.get("HT_CLUSTER_PLATFORM") or ("windows" if os.name == "nt" and not simulate else "linux")
        self.windows = self.platform == "windows"
        self.phone = self.platform in ("android", "ios")
        self.name = socket.gethostname().split(".")[0].lower()
        if self.phone and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}", os.environ.get("HT_CLUSTER_NAME") or ""):
            self.name = os.environ["HT_CLUSTER_NAME"]
        if simulate and os.environ.get("HT_CLUSTER_SIM_NAME"):
            self.name = os.environ["HT_CLUSTER_SIM_NAME"]
        self.peers_cache = {"at": 0, "list": []}
        self.relay_ips = {"at": 0, "ips": set()}  # (the Tailscale addresses a request may be passed on to)
        self.tickets = {}  # one-time download links: token -> {target, path, addr, until}
        self.page_asked = 0
        self.started = time.time()
        default_state = (os.path.join(windows_folder(), "state") if self.windows
                         else os.path.join(os.path.expanduser("~"), ".local", "state", "ht-cluster"))
        self.state_dir = state_dir or os.environ.get("HT_CLUSTER_STATE") or default_state
        os.makedirs(self.state_dir, exist_ok=True)
        self.version = (read(os.path.join(HERE, "VERSION"), "") or "").strip() or "dev"
        if simulate and os.environ.get("HT_CLUSTER_SIM_VERSION"):
            self.version = os.environ["HT_CLUSTER_SIM_VERSION"]
        self.lock = threading.RLock()
        self.tailscale = PhoneTailscale(self) if self.phone else Tailscale()
        self.phone_key = self.own_key() if self.phone else None
        self.config = Memory(os.path.join(self.state_dir, "settings.json"))
        self.memories = {}
        saved = Memory(os.path.join(self.state_dir, "events.json"))
        self.events = collections.deque(saved.get("events") or [], maxlen=KEEP_EVENTS)
        self.events_file = saved
        self.modules = {}
        self.stopping = threading.Event()
        for f in sorted(os.listdir(MODULES_DIR)) if os.path.isdir(MODULES_DIR) else []:
            if f.endswith(".py") and not f.startswith("_"):
                try:
                    m = Module(os.path.join(MODULES_DIR, f))
                    if self.platform not in m.platforms:
                        continue  # (one for the Pis only: the Pi fixes; a phone's only those made for it)
                    self.modules[m.name] = m
                except Exception as e:  # (one broken module doesn't stop the rest)
                    self.log("Module %s didn't load: %s" % (f, e))

    # ----- phones -----
    def own_key(self):
        """A phone's own key (made once, kept in its state folder): what a request to it must carry."""
        path = os.path.join(self.state_dir, PHONE_KEY_FILE)
        key = (read(path, "") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,64}", key):
            key = secrets.token_urlsafe(32)
            with open(path, "w", encoding="utf-8") as f:
                f.write(key)
        return key

    def phone_key_for(self, target):
        """The key a phone gave this Pi, for a request to it (by its address, as node.ask takes it), or None."""
        host = str(target).rsplit(":", 1)[0] if str(target).count(":") == 1 else str(target)
        phones = self.config.get("phones") or {}
        entry = phones.get(str(target)) or phones.get(host)  # (simulated: by address and port)
        return entry.get("key") if isinstance(entry, dict) else None

    def take_phone(self, addr, body):
        """A phone's key, from the phone itself (its own Tailscale address: this account's, as every request is)."""
        key = str(body.get("key") or "")
        if self.phone or not re.fullmatch(r"[A-Za-z0-9_-]{32,64}", key) or not (is_tailscale(addr) or self.simulate):
            return 400, {"error": "Not a phone's key."}
        name = str(body.get("name") or "")[:40]
        target = str(body.get("target") or "") if self.simulate else str(_ip(addr))
        with self.lock:
            phones = self.config.setdefault("phones", {})
            known = phones.get(target)
            phones[target] = {"key": key, "name": name, "at": int(time.time())}
            if not known or known.get("key") != key:
                self.config.save()
                self.peers_cache = {"at": 0, "list": []}  # (found at the next look)
            elif time.time() - known.get("at", 0) > 3600:
                self.config.save()
        return 200, {"ok": True}

    def tell_pis(self):
        """A phone: its key to each Pi it can reach (every PHONE_TELL_S), so they can ask it."""
        while not self.stopping.is_set():
            for p in self.tailscale.peers():
                t = p["ip"] if self.port == PORT else "%s:%d" % (p["ip"], self.port)
                self.ask(t, "POST", "/api/phone", {"key": self.phone_key, "name": self.name}, timeout=8)
            for seed in self.tailscale.seeds():  # (simulated: the Pis as the app gave them)
                if self.simulate:
                    self.ask(seed, "POST", "/api/phone", {"key": self.phone_key, "name": self.name, "target": self.target()}, timeout=8)
            self.stopping.wait(PHONE_TELL_S)

    # ----- for the modules -----
    def run(self, cmd, timeout=20, env=None):
        if self.phone and isinstance(cmd, (list, tuple)) and cmd and os.path.basename(str(cmd[0])) in ("ffmpeg", "ffprobe"):
            import phonetools  # (a phone: the app's own ffmpeg)

            return phonetools.run(cmd, timeout)
        return run(cmd, timeout=timeout, env=env)

    def read(self, path, default=None):
        return read(path, default)

    def log(self, text):
        print(time.strftime("%H:%M:%S "), text, flush=True)

    def event(self, module, text, bad=False):
        """Something the app shows under this Pi (and keeps after a restart)."""
        self.log("[%s] %s" % (module, text))
        with self.lock:
            self.events.append({"at": int(time.time() * 1000), "module": module, "text": text, "bad": bool(bad)})
            self.events_file["events"] = list(self.events)
            self.events_file.save()

    def memory(self, module):
        with self.lock:
            if module not in self.memories:
                self.memories[module] = Memory(os.path.join(self.state_dir, "%s.json" % module))
            return self.memories[module]

    def is_on(self, name):
        m = self.modules.get(name)
        if not m:
            return False
        on = ((self.config.get("modules") or {}).get(name) or {}).get("on")
        return m.default_on if on is None else bool(on)

    def setting(self, module, key):
        m = self.modules.get(module)
        spec = next((s for s in (m.settings if m else []) if s["key"] == key), None)
        saved = (((self.config.get("modules") or {}).get(module) or {}).get("settings") or {})
        if key in saved:
            return saved[key]
        return spec.get("default") if spec else None

    def status_of(self, name):
        """Another module's readings now ({} if it's off or missing)."""
        m = self.modules.get(name)
        if not m or not self.is_on(name) or not hasattr(m.mod, "status"):
            return {}
        try:
            return m.mod.status(self) or {}
        except Exception:
            return {}

    def call(self, name, fn, *args):
        """A function of another module's (for one that builds on it), or None if it's off or missing."""
        m = self.modules.get(name)
        if not m or not self.is_on(name) or not hasattr(m.mod, fn):
            return None
        return getattr(m.mod, fn)(self, *args)

    def root(self, action, *words, timeout=1800, stdin=None):
        """One of the root helper's jobs (cluster/node/ht-cluster-root), with its words if it takes
        any (it checks them itself): its JSON answer. stdin: text for it (a password: never in its words)."""
        words = [str(w) for w in words]
        env = None
        if self.phone and not self.simulate:  # (no sudo there: it said "[Errno 2] No such file or directory: 'sudo'", 2026-11-25)
            return {"ok": False, "error": "%s is a phone: that's for the Pis and computers (it has no root helper)." % self.name}
        if self.simulate:
            helper = os.environ.get("HT_CLUSTER_ROOT_HELPER")
            if not helper:
                return {"ok": False, "error": "No root helper while simulated."}
            cmd = [sys.executable, helper, action] + words
        elif self.windows:  # (its Windows part, as the user: this service's own update and the page)
            py = sys.executable
            if os.path.basename(py).lower() == "pythonw.exe":
                py = os.path.join(os.path.dirname(py), "python.exe")
            cmd = [py, os.path.join(HERE, "ht-cluster-root"), action] + words
            env = dict(os.environ, HT_CLUSTER_WINDOWS="1")
        else:
            cmd = ["sudo", "-n", ROOT_HELPER, action] + words
        code, out, err = run(cmd, timeout=timeout, env=env, stdin=stdin)
        lines = [l for l in out.strip().splitlines() if l.strip().startswith("{")]
        try:
            answer = json.loads(lines[-1]) if lines else None
        except ValueError:
            answer = None
        if not isinstance(answer, dict):
            why = (err or out or "no answer").strip().splitlines()
            return {"ok": False, "error": (why[-1] if why else "no answer")[:300]}
        return answer

    def target(self):
        """How the other Pis reach this one: its Tailscale address (simulated: 127.0.0.1:port)."""
        if self.simulate:
            return "127.0.0.1:%d" % self.port
        me = self.tailscale.me() or {}
        ip = next((a for a in me.get("ips", []) if ":" not in a), None)
        return ip if not ip or self.port == PORT else "%s:%d" % (ip, self.port)

    def ask(self, target, method, path, body=None, data=None, timeout=30):
        """A request to another Pi's service (as the app makes them): -> (status, JSON or bytes), or
        (None, why). body: JSON; data: bytes as they are (a file's piece)."""
        host, _, port = str(target).partition(":")
        port = int(port or PORT)
        headers = {"X-HT-Cluster": "1", "Host": "%s:%d" % (host, port)}
        key = self.phone_key_for(target)
        if key:
            headers["X-HT-Cluster-Key"] = key  # (a phone's: it takes only requests that carry it)
        payload = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif data is not None:
            payload = data
            headers["Content-Type"] = "application/octet-stream"
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
        try:
            conn.request(method, path, body=payload, headers=headers)
            res = conn.getresponse()
            raw = res.read()
            if (res.getheader("Content-Type") or "").startswith("application/json"):
                try:
                    return res.status, json.loads(raw.decode("utf-8") or "{}")
                except ValueError:
                    return res.status, {"error": "Its answer wasn't readable."}
            return res.status, raw
        except (OSError, http.client.HTTPException) as e:
            return None, str(e)
        finally:
            conn.close()

    def cluster(self, fresh=False):
        """The other Pis running this service: [{name, target, node: what /api/node said}], looked
        for at most once a minute among the Linux computers on Tailscale (simulated: HT_CLUSTER_SIM_PEERS)."""
        with self.lock:
            if not fresh and time.time() - self.peers_cache["at"] < 60:
                return list(self.peers_cache["list"])
        if self.simulate:
            targets = [t.strip() for t in os.environ.get("HT_CLUSTER_SIM_PEERS", "").split(",") if t.strip()]
        else:
            # (on the port this one is on: a copy run on another port to try it finds its own kind)
            targets = [p["ip"] if self.port == PORT else "%s:%d" % (p["ip"], self.port) for p in self.tailscale.peers() if p["online"]]
        found = []
        lock = threading.Lock()

        def probe(t):
            code, d = self.ask(t, "GET", "/api/node", timeout=6)
            if code == 200 and isinstance(d, dict) and d.get("name") and d.get("name") != self.name:
                with lock:
                    found.append({"name": d["name"], "target": t, "node": d})
        threads = [threading.Thread(target=probe, args=(t,), daemon=True) for t in targets]
        for th in threads:
            th.start()
        for th in threads:
            th.join(10)
        with self.lock:
            self.peers_cache = {"at": time.time(), "list": found}
        return list(found)

    def notify_stop(self):
        """Asked to end (systemd's TERM): each module that wants to notes something first (health: whether the system
        itself is shutting down), a few seconds at most each. (Not named stopping: that's the Event the threads watch.)"""
        for m in list(self.modules.values()):
            fn = getattr(m.mod, "stopping", None)
            if not fn:
                continue
            th = threading.Thread(target=fn, args=(self,), daemon=True)
            th.start()
            th.join(5)

    def restart_soon(self):
        """This service ends; systemd (on Windows, its launcher) starts it again (with what's now in its folder)."""
        def go():
            time.sleep(1.5)
            os._exit(0)
        threading.Thread(target=go, daemon=True).start()

    # ----- the Cluster page -----
    def page_dir(self):
        """Where the page's files are: web/ beside this file (as a build puts them in), or, for a copy of
        the code run as it is, the folder they're in; None while they aren't here."""
        web = os.path.join(HERE, "web")
        if os.path.isfile(os.path.join(web, "cluster.html")):
            return web
        repo = os.path.normpath(os.path.join(HERE, "..", ".."))
        if (self.simulate or self.version == "dev") and os.path.isfile(os.path.join(repo, "cluster.html")):
            return repo
        return None

    def fetch_page_soon(self):
        """This version's page, when its update didn't bring it (the first update to a version that serves
        the page is done by the root helper from before it): the root helper fetches it from GitHub for
        this version's commit (at most every 10 minutes)."""
        if self.simulate or not re.fullmatch(r"[0-9a-f]{40}", self.version) or self.page_dir():
            return
        with self.lock:
            if time.time() - self.page_asked < 600:
                return
            self.page_asked = time.time()

        def go():
            answer = self.root("page", timeout=600)
            self.log("The Cluster page's files: %s" % ("here" if answer.get("ok") else answer.get("error")))
        threading.Thread(target=go, daemon=True, name="page").start()

    # ----- running -----
    def start(self):
        for m in self.modules.values():
            if hasattr(m.mod, "start"):
                try:
                    m.mod.start(self)
                except Exception as e:
                    m.error = "Didn't start: %s" % e
                    self.log("%s: %s" % (m.name, traceback.format_exc()))
            if hasattr(m.mod, "tick"):
                threading.Thread(target=self._ticks, args=(m,), daemon=True, name="tick-" + m.name).start()
        if self.phone:
            threading.Thread(target=self.tell_pis, daemon=True, name="tell-pis").start()
        else:
            self.fetch_page_soon()

    def _ticks(self, m):
        last_error = ""
        while not self.stopping.is_set():
            if self.is_on(m.name):
                try:
                    m.mod.tick(self)
                    m.error = None
                except Exception as e:
                    m.error = str(e)[:300]
                    trace = traceback.format_exc()
                    if trace != last_error:
                        self.log("%s: %s" % (m.name, trace))
                    last_error = trace
            m.wake.wait(m.every)
            m.wake.clear()

    def describe(self):
        mods = []
        for m in sorted(self.modules.values(), key=lambda x: (x.order, x.name)):
            on = self.is_on(m.name)
            status = {}
            if on and hasattr(m.mod, "status"):
                try:
                    status = m.mod.status(self) or {}
                except Exception as e:
                    status = {"warnings": ["Couldn't read: %s" % e]}
            mods.append({
                "name": m.name, "title": m.title, "on": on, "status": status, "error": m.error,
                "settings": [dict(s, value=self.setting(m.name, s["key"])) for s in m.settings],
                "actions": [{"name": k, "title": a.get("title", k), "confirm": a.get("confirm"), "hidden": bool(a.get("hidden"))}
                            for k, a in m.actions.items() if isinstance(a, dict)],
            })
        with self.lock:
            events = list(self.events)[-20:]
        return {"name": self.name, "version": self.version, "platform": self.platform, "time": int(time.time() * 1000),
                "up": int(time.time() - self.started), "simulated": self.simulate, "modules": mods, "events": events}

    def change(self, body):
        name = str(body.get("module") or "")
        m = self.modules.get(name)
        if not m:
            return 404, {"error": "No module %s here." % name}
        with self.lock:
            mods = self.config.setdefault("modules", {})
            entry = mods.setdefault(name, {})
            if "on" in body:
                entry["on"] = bool(body["on"])
                self.event(name, "%s turned %s" % (m.title, "on" if entry["on"] else "off"))
            if "key" in body:
                key = str(body["key"])
                spec = next((s for s in m.settings if s["key"] == key), None)
                if not spec:
                    return 400, {"error": "No setting %s in %s." % (key, m.title)}
                value = body.get("value")
                if spec.get("choices"):
                    if value not in [c[0] for c in spec["choices"]]:
                        return 400, {"error": "%s can't be %r." % (spec.get("title", key), value)}
                elif isinstance(spec.get("default"), bool):
                    value = bool(value)
                entry.setdefault("settings", {})[key] = value
            self.config.save()
        m.wake.set()  # (it acts on the change now, not at its next tick)
        return 200, {"ok": True}

    def act(self, body):
        name = str(body.get("module") or "")
        m = self.modules.get(name)
        if not m:
            return 404, {"error": "No module %s here." % name}
        if not self.is_on(name):
            return 409, {"error": "%s is off on %s." % (m.title, self.name)}
        a = m.actions.get(str(body.get("action") or ""))
        if not isinstance(a, dict) or "run" not in a:
            return 400, {"error": "%s can't do that." % m.title}
        args = body.get("args") if isinstance(body.get("args"), dict) else {}
        answer = a["run"](self, args) or {}
        m.wake.set()
        return (200 if answer.get("ok", True) else 409), answer

    # ----- the requests -----
    def own_host(self, host):
        host = str(host or "").strip().lower()
        if host.startswith("["):
            host = host[1:host.find("]")] if "]" in host else host[1:]
        elif host.count(":") == 1:
            host = host.split(":")[0]
        names = {"localhost", "127.0.0.1", "::1", self.name.lower(), self.name.lower() + ".local"}
        me = self.tailscale.me() if not self.simulate else None
        if me:
            names.update(me["names"])
            names.update(ip.lower() for ip in me["ips"])
        return host in names

    def allowed(self, addr, h=None):
        if self.phone:  # (only with its own key: see PhoneTailscale)
            given = str((h.headers.get("X-HT-Cluster-Key") if h is not None else "") or "")
            return bool(given) and hmac.compare_digest(given.encode("utf-8"), self.phone_key.encode("utf-8")) and (self.simulate or is_tailscale(addr))
        if self.simulate:
            return is_loopback(addr)
        me = self.tailscale.me()
        if not me or me.get("user") is None:
            return False
        return self.tailscale.user_of(addr) == me["user"]

    def serve(self, h, method):
        try:
            addr = str(h.client_address[0])
            path = h.path.split("?")[0]
            local = is_loopback(addr)
            if not path.startswith("/api/"):
                return self.page(h, method, addr, local, path)
            if not local and not is_tailscale(addr):
                return self.send(h, 403, {"error": "Only over Tailscale."})
            # (a one-time download link is followed by the browser itself, which can't add the header: the
            # link stands for it, given only to a request that had it)
            if h.headers.get("X-HT-Cluster") != "1" and not (method == "GET" and path == "/api/download"):
                return self.send(h, 403, {"error": "Only the Cluster app can ask that."})
            if not self.own_host(h.headers.get("Host")):
                return self.send(h, 403, {"error": "That isn't one of this device's names."})
            if local and not self.simulate and not self.phone:
                if method != "GET":
                    return self.send(h, 403, {"error": "From this device itself: readings only."})
            elif not self.allowed(addr, h):
                return self.send(h, 403, {"error": "Only your own Tailscale account can use this device's cluster service."})
            if method == "GET" and path == "/api/download":
                return self.download(h, addr)
            # For another Pi of the cluster (the page in a browser asks only the Pi it came from): passed on.
            to = h.headers.get("X-HT-Cluster-To")
            if to:
                target = self.relay_target(to)
                if not target:
                    return self.send(h, 403, {"error": "%s isn't a device of this cluster." % str(to)[:60]})
                if target != "self":
                    return self.relay(h, method, target, h.path)
            if self.route(h, method, h.path):
                return
            body = {}
            if method == "POST":
                if not str(h.headers.get("Content-Type") or "").startswith("application/json"):
                    return self.send(h, 415, {"error": "JSON only."})
                n = int(h.headers.get("Content-Length") or 0)
                if n > MAX_BODY:
                    return self.send(h, 413, {"error": "Too long."})
                try:
                    body = json.loads(h.rfile.read(n).decode("utf-8") or "{}")
                except ValueError:
                    return self.send(h, 400, {"error": "Not JSON."})
                if not isinstance(body, dict):
                    return self.send(h, 400, {"error": "Not a JSON object."})
            if method == "GET" and path == "/api/node":
                return self.send(h, 200, self.describe())
            if method == "GET" and path == "/api/peers":
                if self.simulate:  # (the other simulated Pis, as Tailscale would list them)
                    sim = [t.strip() for t in os.environ.get("HT_CLUSTER_SIM_PEERS", "").split(",") if t.strip()]
                    return self.send(h, 200, {"peers": [{"name": t, "ip": t, "online": True} for t in sim]})
                return self.send(h, 200, {"peers": self.tailscale.peers()})
            if method == "POST" and path == "/api/phone":
                return self.send(h, *self.take_phone(addr, body))
            if method == "POST" and path == "/api/settings":
                return self.send(h, *self.change(body))
            if method == "POST" and path == "/api/action":
                return self.send(h, *self.act(body))
            if method == "POST" and path == "/api/ticket":
                return self.send(h, *self.ticket(body, addr))
            return self.send(h, 404, {"error": "Not found"})
        except Exception as e:
            self.log("Request failed: %s" % traceback.format_exc())
            return self.send(h, 500, {"error": str(e)[:300]})

    def route(self, h, method, full):
        """A module's own request (it reads the body itself: a file's piece can be megabytes): answered, and
        True, or False when no module has it."""
        parts = urllib.parse.urlsplit(full)
        key = "%s %s" % (method, parts.path)
        for m in self.modules.values():
            if key in m.routes:
                if not self.is_on(m.name):
                    self.send(h, 409, {"error": "%s is off on %s." % (m.title, self.name)})
                    return True
                query = {k: v[-1] for k, v in urllib.parse.parse_qs(parts.query).items()}
                m.routes[key](self, h, query)
                return True
        return False

    def page(self, h, method, addr, local, path):
        """The Cluster page and the files it loads, for a browser on this Tailscale account (never inside
        another site's page: it has buttons)."""
        def say(code, text):
            return self.send_bytes(h, code, text.encode("utf-8"), "text/plain; charset=utf-8")
        if method != "GET":
            # (its body read first, if it's small: a reply with it unread can reach the asker as a reset instead)
            try:
                n = int(h.headers.get("Content-Length") or 0)
            except ValueError:
                n = -1
            if 0 < n <= 65536:
                h.rfile.read(n)
            h.close_connection = True
            return say(405, "Only the page is here.")
        if not local and not is_tailscale(addr):
            return say(403, "Only over Tailscale.")
        if not self.own_host(h.headers.get("Host")):
            return say(403, "That isn't one of this device's names.")
        if not local and not self.allowed(addr):
            return say(403, "Only your own Tailscale account can use this device's cluster service.")
        # (/pi-cluster.html: the page's name before the rename, 2026-11-25, as a bookmark may have it)
        name = "cluster.html" if path in ("/", "/index.html", "/pi-cluster.html") else urllib.parse.unquote(path[1:])
        if name not in PAGE_FILES:
            return say(404, "Not found.")
        where = self.page_dir()
        if not where:
            self.fetch_page_soon()
            return say(503, "This device's copy of the Cluster page isn't here yet: it's being fetched for the version of the "
                            "service it runs. Try again in a minute.")
        try:
            with open(os.path.join(where, *name.split("/")), "rb") as f:
                data = f.read()
        except OSError:
            return say(404, "Not found.")
        extra = {"Referrer-Policy": "no-referrer"}
        if name.endswith(".html"):
            # (how the page knows it came from a Pi: cluster.js asks this Pi, and the others through it)
            data = data.replace(b"<head>", b'<head>\n<meta name="ht-cluster-page" content="%s" />' % html.escape(self.name).encode("utf-8"), 1)
            extra.update({"Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY"})
        return self.send_bytes(h, 200, data, PAGE_TYPES.get(os.path.splitext(name)[1], "application/octet-stream"), extra)

    def relay_target(self, to):
        """Where a request may be passed on to: "self" for this Pi, another Pi of the cluster as node.ask takes
        it (a Tailscale address among this Tailscale network's Linux computers; simulated: 127.0.0.1:port), or
        None for anywhere else."""
        to = str(to or "").strip()
        if self.simulate:
            host, _, port = to.rpartition(":")
            if host in ("127.0.0.1", "localhost") and port.isdigit() and 0 < int(port) < 65536:
                return "self" if int(port) == self.port else "127.0.0.1:%d" % int(port)
            return None
        ip = _ip(to)
        if not ip or not is_tailscale(str(ip)):
            return None
        ip = str(ip)
        if ip in (self.tailscale.me() or {}).get("ips", []):
            return "self"
        now = time.time()
        with self.lock:
            known = self.relay_ips
        if now - known["at"] > 60 or (ip not in known["ips"] and now - known["at"] > 5):
            known = {"at": now, "ips": {p["ip"] for p in self.tailscale.peers()}}
            with self.lock:
                self.relay_ips = known
        if ip not in known["ips"]:
            return None
        return ip if self.port == PORT else "%s:%d" % (ip, self.port)

    def relay(self, h, method, target, path):
        """A request passed on to another Pi of the cluster as it is, and its answer back as it comes (a file's
        piece, or a whole file, a little at a time)."""
        host, _, port = target.partition(":")
        port = int(port or PORT)
        try:
            n = int(h.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if n < 0 or n > RELAY_MAX:
            h.close_connection = True
            return self.send(h, 413, {"error": "Too long."})
        conn = http.client.HTTPConnection(host, port, timeout=RELAY_CONNECT_S)
        try:
            conn.connect()
            conn.sock.settimeout(RELAY_S)
            conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            conn.putheader("Host", "%s:%d" % (host, port))
            conn.putheader("X-HT-Cluster", "1")
            key = self.phone_key_for(target)
            if key:
                conn.putheader("X-HT-Cluster-Key", key)
            if h.headers.get("Content-Type"):
                conn.putheader("Content-Type", h.headers["Content-Type"])
            if n or method != "GET":
                conn.putheader("Content-Length", str(n))
            conn.endheaders()
            left = n
            while left > 0:
                chunk = h.rfile.read(min(left, 1 << 16))
                if not chunk:
                    raise OSError("the request stopped part way")
                conn.send(chunk)
                left -= len(chunk)
            res = conn.getresponse()
        except (OSError, http.client.HTTPException) as e:
            conn.close()
            h.close_connection = True  # (what's left of its body isn't read)
            return self.send(h, 502, {"error": "No answer from %s (%s)." % (host, e)})
        try:
            h.send_response(res.status)
            h.send_header("Content-Type", res.getheader("Content-Type") or "application/octet-stream")
            length = res.getheader("Content-Length")
            if length is not None:
                h.send_header("Content-Length", length)
            else:
                h.send_header("Connection", "close")
                h.close_connection = True
            if res.getheader("Content-Disposition"):
                h.send_header("Content-Disposition", res.getheader("Content-Disposition"))
            h.send_header("Cache-Control", "no-store")
            h.send_header("X-Content-Type-Options", "nosniff")
            h.end_headers()
            while True:
                chunk = res.read(1 << 16)
                if not chunk:
                    break
                h.wfile.write(chunk)
        except (OSError, http.client.HTTPException):
            h.close_connection = True
        finally:
            conn.close()

    def ticket(self, body, addr):
        """A one-time link (for TICKET_S seconds, from this address) to one GET of this Pi's, or of another
        Pi's of the cluster (to): what a browser follows to save a file."""
        p = str(body.get("path") or "")
        if (not re.fullmatch(r"/api/[A-Za-z0-9/_.-]+(\?[A-Za-z0-9_.~%&=+!*'(),-]*)?", p) or ".." in p
                or p.split("?")[0] in ("/api/ticket", "/api/download")):
            return 400, {"error": "That isn't something to download."}
        target = "self"
        if body.get("to"):
            target = self.relay_target(body["to"])
            if not target:
                return 403, {"error": "That isn't a device of this cluster."}
        now = time.time()
        with self.lock:
            self.tickets = {k: t for k, t in self.tickets.items() if t["until"] > now}
            if len(self.tickets) >= 50:
                return 429, {"error": "Too many downloads waiting: try again in a couple of minutes."}
            token = secrets.token_urlsafe(24)
            self.tickets[token] = {"target": target, "path": p, "addr": addr, "until": now + TICKET_S}
        return 200, {"ok": True, "url": "/api/download?ticket=" + token}

    def download(self, h, addr):
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(h.path).query)
        token = (q.get("ticket") or [""])[-1]
        with self.lock:
            t = self.tickets.pop(token, None) if token else None
        if not t or t["until"] < time.time() or t["addr"] != addr:
            return self.send_bytes(h, 410, "That download link has been used or has run out: press Save results again.".encode("utf-8"),
                                   "text/plain; charset=utf-8")
        if t["target"] != "self":
            return self.relay(h, "GET", t["target"], t["path"])
        if not self.route(h, "GET", t["path"]):
            return self.send(h, 404, {"error": "Not found"})

    def send(self, h, code, body):
        self.send_bytes(h, code, json.dumps(body).encode("utf-8"), "application/json; charset=utf-8")

    def send_bytes(self, h, code, data, ctype="application/octet-stream", headers=None):
        try:
            h.send_response(code)
            h.send_header("Content-Type", ctype)
            h.send_header("Content-Length", str(len(data)))
            h.send_header("Cache-Control", "no-store")
            h.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (headers or {}).items():
                h.send_header(k, v)
            h.end_headers()
            h.wfile.write(data)
        except OSError:
            pass

    def send_file(self, h, path, name, ctype="application/octet-stream"):
        """A whole file as a download, a little at a time (a browser saves it as name)."""
        try:
            f = open(path, "rb")
        except OSError:
            return self.send(h, 404, {"error": "No such file."})
        with f:
            size = os.fstat(f.fileno()).st_size
            plain = "".join(c if " " <= c <= "~" and c not in '"\\' else "_" for c in name) or "download"
            try:
                h.send_response(200)
                h.send_header("Content-Type", ctype)
                h.send_header("Content-Length", str(size))
                h.send_header("Content-Disposition", "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (plain, urllib.parse.quote(name, safe="")))
                h.send_header("Cache-Control", "no-store")
                h.send_header("X-Content-Type-Options", "nosniff")
                h.end_headers()
                left = size
                while left > 0:
                    chunk = f.read(min(left, 1 << 20))
                    if not chunk:
                        h.close_connection = True  # (it got shorter as it went: the browser sees it cut off)
                        break
                    h.wfile.write(chunk)
                    left -= len(chunk)
            except OSError:
                h.close_connection = True

    def body_bytes(self, h, limit):
        """A request's body as it is (at most limit bytes), or None if it's longer."""
        n = int(h.headers.get("Content-Length") or 0)
        if n < 0 or n > limit:
            return None
        return h.rfile.read(n) if n else b""


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "ht-cluster"
    protocol_version = "HTTP/1.1"
    node = None

    def log_message(self, fmt, *args):  # (quiet: the service logs what matters itself)
        pass

    def do_GET(self):
        self.node.serve(self, "GET")

    def do_POST(self):
        self.node.serve(self, "POST")

    def do_PUT(self):
        self.node.serve(self, "PUT")


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64  # (the app, the other Pis and this Pi's own jobs at once: none turned away)
    address_family = socket.AF_INET6

    def server_bind(self):
        # (IPv6 and IPv4 on the one socket: Tailscale gives each Pi one address of each)
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except (OSError, AttributeError):
            pass
        super().server_bind()


def main():
    p = argparse.ArgumentParser(description="Cluster's service on a Raspberry Pi (or a Windows PC)")
    p.add_argument("--port", type=int, default=PORT)
    p.add_argument("--simulate", action="store_true")
    args = p.parse_args()
    if os.name == "nt" and not args.simulate:  # (the modules read it as they load)
        os.environ.setdefault("HT_CLUSTER_PLATFORM", "windows")
    node = Node(simulate=args.simulate, port=args.port)
    Handler.node = node
    if args.simulate:
        Server.address_family = socket.AF_INET
        server = Server(("127.0.0.1", args.port), Handler)
    else:
        server = Server(("::", args.port), Handler)
    node.start()

    def on_term(signum, frame):
        node.notify_stop()
        os._exit(0)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, on_term)
    node.log("Cluster service %s on %s, port %d, modules: %s" % (node.version[:7], node.name, server.server_address[1], ", ".join(node.modules) or "none"))
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
