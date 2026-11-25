#!/usr/bin/env python3
"""
test_cluster.py - checks Cluster's service (cluster/node) on any computer:  python3 cluster/test_cluster.py

The service runs --simulate against stand-ins: a Hand Tracker (its remote recording API), GitHub (the
"Latest build" release, its files and downloads) and a root helper that only notes what it was
asked. Checked: who may ask it (the header, the Host), each module's switch and settings, an update
of Hand Tracker waiting while it records and then going in (Hand Tracker restarted, Sentry turned
back on), Raspberry Pi OS updates and the restart they ask for, the service updating itself
(it ends, for systemd to start it again), the Pi fixes (switched on and off, waiting while it
records, put in again when their script changes, one put in by hand left as it is, the Wi-Fi
recovery's test, a fix that fails), and the real root helper's downloads: checked against GitHub's
size and SHA-256, and its own files (with the Pi fixes from pi/) against GitHub's list of them (on
Linux and Macs: it switches folders with a symbolic link).
"""

import hashlib
import http.server
import importlib.machinery
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
NODE = os.path.join(HERE, "node")
REPO = "alexandermulholland92/hand-tracker"
OLD = "a" * 40
NEW = "b" * 40
DEB = b"not really a .deb, but the right size and hash" * 100
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print("%s  %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  (%s)" % (detail,)), flush=True)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def serve(handler_cls):
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, "http://127.0.0.1:%d" % srv.server_address[1]


class Quiet(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, body, ctype="application/json", headers=None):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)


# ----- a stand-in Hand Tracker -----
HT = {"recording": False, "saving": False, "armed": True, "down_until": 0, "commands": []}


class FakeHT(Quiet):
    def do_GET(self):
        if time.time() < HT["down_until"]:
            return self.reply(503, {"error": "restarting"})
        if self.path == "/api/state":
            return self.reply(200, {"recording": HT["recording"], "saving": HT["saving"], "elapsed_s": 61,
                                    "cameras": [{"name": "OAK-D-W", "role": "Head", "fps": 30, "oak": True}],
                                    "sentry": {"armed": HT["armed"], "shown": False},
                                    "storage": {"free": 4e10, "total": 5e11, "hours": 0.7, "low": True,
                                                "text": "40 GB free of 500 GB · about 40 minutes of takes (1 camera, standard video)"}})
        self.reply(404, {"error": "Not found"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        HT["commands"].append(body)
        if body.get("action") == "restartApp":
            HT["down_until"] = time.time() + 2.5
            HT["armed"] = False  # (as if it hadn't turned Sentry back on by itself)
            return self.reply(200, {"ok": True, "message": "Restarting"})
        if body.get("action") == "sentry":
            HT["armed"] = bool((body.get("sentry") or {}).get("armed"))
            return self.reply(200, {"ok": True})
        self.reply(400, {"error": "Unknown"})


# ----- a stand-in GitHub -----
GH = {"tamper": False, "requests": []}


def node_files():
    out = []
    for root, dirs, files in os.walk(NODE):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, NODE).replace(os.sep, "/")
            with open(full, "rb") as fh:
                out.append(("cluster/node/" + rel, fh.read()))
    return out


FIX_SCRIPTS = ("wifi-watchdog", "tailscale-watchdog", "network-tuning", "freeze-restart", "usb-current", "wifi-autoconnect")


PAGE = ("cluster.html", "cluster.js", "video-formats.js", "sentry-models.js", "models/kinds.js", "favicon.png", "apple-touch-icon.png")


def repo_files():
    """The build's files the service's update looks at: cluster/node's, the Pi fixes in pi/ (with one of
    pi/'s other scripts, which isn't taken), and the Cluster page's (with one of the top folder's other
    files, which isn't)."""
    out = node_files()
    for f in FIX_SCRIPTS:
        with open(os.path.join(HERE, "..", "pi", f + ".sh"), "rb") as fh:
            out.append(("pi/%s.sh" % f, fh.read()))
    out.append(("pi/hotspot-setup.sh", b"# not a fix: never taken\n"))
    for f in PAGE:
        with open(os.path.join(HERE, "..", *f.split("/")), "rb") as fh:
            out.append((f, fh.read()))
    out.append(("index.html", b"<!-- not the Cluster page: never taken -->\n"))
    return out


class FakeGitHub(Quiet):
    def do_GET(self):
        GH["requests"].append(self.path)
        base = "http://127.0.0.1:%d" % self.server.server_address[1]
        if self.path == "/repos/%s/releases/tags/latest-build" % REPO:
            if self.headers.get("If-None-Match") == '"v1"':
                return self.reply(304, b"")
            return self.reply(200, {"target_commitish": NEW, "published_at": "2026-11-17T12:00:00Z", "assets": [
                {"name": "hand-tracker_1.1.0_arm64.deb", "size": len(DEB), "updated_at": "2026-11-17T11:59:00Z",
                 "digest": "sha256:" + hashlib.sha256(DEB).hexdigest(), "browser_download_url": base + "/dl/hand-tracker_1.1.0_arm64.deb"},
                {"name": "hand-mouse_1.1.0_arm64.deb", "size": 1, "updated_at": "2026-11-17T11:59:00Z", "browser_download_url": base + "/dl/x"}]},
                headers={"ETag": '"v1"'})
        if self.path.startswith("/repos/%s/git/trees/%s" % (REPO, NEW)):
            tree = [{"path": p, "type": "blob", "sha": hashlib.sha1(b"blob %d\0" % len(d) + d).hexdigest()} for p, d in repo_files()]
            tree.append({"path": "cluster/node/../../evil", "type": "blob", "sha": "0"})  # (never taken)
            tree.append({"path": "README.md", "type": "blob", "sha": "0"})
            return self.reply(200, {"tree": tree})
        if self.path.startswith("/raw/%s/%s/" % (REPO, NEW)):
            want = self.path[len("/raw/%s/%s/" % (REPO, NEW)):]
            for p, d in repo_files():
                if p == want:
                    return self.reply(200, d + (b"#" if GH["tamper"] and p.endswith("ht_cluster.py") else b""), "application/octet-stream")
        if self.path == "/dl/hand-tracker_1.1.0_arm64.deb":
            return self.reply(200, DEB, "application/octet-stream")
        if self.path == "/repos/%s/compare/%s...%s" % (REPO, OLD, NEW):
            return self.reply(200, {"status": "ahead", "ahead_by": 3, "behind_by": 0})
        self.reply(404, {"message": "Not Found"})


FAKE_HELPER = r'''
import hashlib, importlib.util, json, os, sys, time
job = sys.argv[1]
with open(os.environ["HT_TEST_HELPER_LOG"], "a") as f:
    f.write(" ".join(sys.argv[1:]) + "\n")
if job in ("fix-install", "fix-remove"):
    # (the fix's files, as modules/fixes.py looks for them, made or taken away in the stand-in for /)
    name = sys.argv[2]
    spec = importlib.util.spec_from_file_location("fixes", os.environ["HT_TEST_FIXES_PY"])
    fixes = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixes)
    marks = next(m for _, n, _, _, m in fixes.FIXES if n == name)
    fail = os.environ.get("HT_TEST_FIX_FAIL")
    if fail and os.path.exists(fail) and open(fail).read().strip() == name:
        print(json.dumps({"ok": False, "error": "This needs nft (sudo apt install nftables)."}))
        sys.exit(1)
    for p in marks:
        full = os.path.join(os.environ["HT_CLUSTER_SIM_ROOT"], p.lstrip("/"))
        if job == "fix-install":
            os.makedirs(os.path.dirname(full), exist_ok=True)
            open(full, "w").close()
        elif os.path.exists(full):
            os.remove(full)
    if name == "usb-current":  # (its setting in config.txt, as pi/usb-current.sh puts it)
        conf = os.path.join(os.environ["HT_CLUSTER_SIM_ROOT"], "boot", "firmware", "config.txt")
        os.makedirs(os.path.dirname(conf), exist_ok=True)
        with open(conf, "w") as f:
            f.write("dtparam=audio=on\n" + ("[all]\nusb_max_current_enable=1\n" if job == "fix-install" else ""))
    script = os.path.join(os.environ["HT_CLUSTER_SIM_FIXES"], name + ".sh")
    if not os.path.exists(script):  # (the real one fetches it for its version, from GitHub)
        with open(script, "w") as f:
            f.write("# stand-in for pi/" + name + ".sh, fetched")
    if job == "fix-install":
        with open(script, "rb") as f:
            sha = hashlib.sha256(f.read()).hexdigest()
        print(json.dumps({"ok": True, "fix": name, "sha256": sha, "said": "Set up." + (" Restart this Pi for it to take effect." if name == "usb-current" else "")}))
    else:
        print(json.dumps({"ok": True, "fix": name, "said": "Removed." + (" Restart this Pi for it to take effect." if name == "usb-current" else "")}))
elif job == "wifi-test":
    print(json.dumps({"ok": True, "in": 0}))
elif job == "install-hand-tracker":
    with open(os.environ["HT_CLUSTER_SIM_HT"], "w") as f:
        json.dump({"commit": os.environ["HT_TEST_NEW"], "installedAt": time.time()}, f)
    print(json.dumps({"ok": True, "commit": os.environ["HT_TEST_NEW"]}))
elif job == "update-cluster":
    print(json.dumps({"ok": True, "commit": os.environ["HT_TEST_NEW"]}))
elif job == "os-check":
    print(json.dumps({"ok": True, "upgradable": 3, "packages": ["a", "b", "c"]}))
elif job == "os-upgrade":
    print(json.dumps({"ok": True, "upgraded": 3, "rebootNeeded": True}))
else:
    print(json.dumps({"ok": True}))
'''


def ask(port, method="GET", path="/api/node", body=None, headers=None):
    h = {"X-HT-Cluster": "1", "Host": "127.0.0.1:%d" % port}
    h.update(headers or {})
    data = json.dumps(body).encode() if body is not None else None
    if data is not None:
        h.setdefault("Content-Type", "application/json")
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def module(port, name):
    _, d = ask(port)
    return next((m for m in d.get("modules", []) if m["name"] == name), {})


def wait_for(fn, seconds=30):
    until = time.time() + seconds
    while time.time() < until:
        try:
            v = fn()
            if v:
                return v
        except (OSError, ValueError, KeyError):
            pass
        time.sleep(0.3)
    return None


def start_node(tmp, gh, ht, version=None, extra=None, port=None):
    port = port or free_port()
    env = dict(os.environ, HT_CLUSTER_STATE=os.path.join(tmp, "state-%d" % port), HT_CLUSTER_HT_URL=ht,
               HT_CLUSTER_GITHUB_API=gh, HT_CLUSTER_ROOT_HELPER=os.path.join(tmp, "fake-helper.py"),
               HT_TEST_HELPER_LOG=os.path.join(tmp, "helper.log"), HT_CLUSTER_SIM_HT=os.path.join(tmp, "installed.json"),
               HT_TEST_NEW=NEW, PYTHONDONTWRITEBYTECODE="1")
    env.update(extra or {})
    if version:
        env["HT_CLUSTER_SIM_VERSION"] = version
    p = subprocess.Popen([sys.executable, os.path.join(NODE, "ht_cluster.py"), "--simulate", "--port", str(port)],
                         env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    wait_for(lambda: ask(port)[0] == 200, 15)
    return p, port


def helper_log(tmp):
    try:
        with open(os.path.join(tmp, "helper.log")) as f:
            return f.read().split()
    except OSError:
        return []


def helper_lines(tmp):
    """What the root helper was asked, a job (with its words) a line."""
    try:
        with open(os.path.join(tmp, "helper.log")) as f:
            return [l.strip() for l in f if l.strip()]
    except OSError:
        return []


def check_fixes(tmp, gh, ht):
    """The Pi fixes module (modules/fixes.py), against the stand-in root helper: what it makes and takes
    away stands in for the fixes' files, under a folder standing in for /."""
    sim_root, sim_fixes = os.path.join(tmp, "sim-root"), os.path.join(tmp, "sim-fixes")
    os.makedirs(sim_fixes)
    for f in FIX_SCRIPTS:
        with open(os.path.join(sim_fixes, f + ".sh"), "w") as fh:
            fh.write("# stand-in for pi/%s.sh, version 1\n" % f)
    fixes_py = os.path.join(NODE, "modules", "fixes.py")
    spec = importlib.util.spec_from_file_location("fixes_for_checks", fixes_py)
    fixes = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixes)
    marks = {n: [os.path.join(sim_root, p.lstrip("/")) for p in m] for _, n, _, _, m in fixes.FIXES}
    for p in marks["freeze-restart"]:  # (put in by hand before)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "w").close()
    fail, journal = os.path.join(tmp, "fix-fail"), os.path.join(tmp, "journal.txt")
    open(os.path.join(tmp, "helper.log"), "w").close()
    with open(os.path.join(tmp, "installed.json"), "w") as f:  # (Hand Tracker up to date: not restarted meanwhile)
        json.dump({"commit": NEW, "installedAt": time.time()}, f)
    HT["recording"] = False
    node, port = start_node(tmp, gh, ht, extra=dict(HT_CLUSTER_SIM_ROOT=sim_root, HT_CLUSTER_SIM_FIXES=sim_fixes, HT_TEST_FIXES_PY=fixes_py,
                                                     HT_TEST_FIX_FAIL=fail, HT_CLUSTER_SIM_JOURNAL=journal))
    mod = lambda: module(port, "fixes")
    setting = lambda m, key: next((s.get("value") for s in m.get("settings", []) if s["key"] == key), None)
    state = lambda m, script: next((f["state"] for f in (m.get("status") or {}).get("fixes", []) if f["script"] == script), None)
    hidden = lambda m, action: next((a["hidden"] for a in m.get("actions", []) if a["name"] == action), None)
    there = lambda script: all(os.path.exists(p) for p in marks[script])
    poke = lambda: ask(port, "POST", "/api/action", {"module": "fixes", "action": "retry"})  # (a look now, not in a minute)
    try:
        m = wait_for(lambda: state(mod(), "freeze-restart") == "On" and mod(), 20) or mod()
        check("Fixes: one put in by hand shows on", setting(m, "freezeRestart") is True, m.get("status"))
        check("...the others are off on a new Pi", all(setting(m, k) is False for k in ("wifiWatchdog", "tailscaleWatchdog", "networkTuning"))
              and all(state(m, s) == "Off" for s in ("wifi-watchdog", "tailscale-watchdog", "network-tuning")), m.get("status"))
        check("...nothing was put in by itself, nor the one put in by hand run again", not any(l.startswith("fix-") for l in helper_lines(tmp)), helper_lines(tmp))
        check("...and the Wi-Fi test button is hidden while the Wi-Fi recovery is off", hidden(m, "testWifi") is True, m.get("actions"))
        code, _ = ask(port, "POST", "/api/action", {"module": "fixes", "action": "testWifi"})
        check("...and refused", code == 409 and "wifi-test" not in helper_lines(tmp), code)

        HT["recording"] = True
        ask(port, "POST", "/api/settings", {"module": "fixes", "key": "wifiWatchdog", "value": True})
        w = wait_for(lambda: state(mod(), "wifi-watchdog") == "Waiting: recording", 20)
        check("A fix switched on waits while Hand Tracker records", bool(w) and not there("wifi-watchdog") and not any(l.startswith("fix-install") for l in helper_lines(tmp)),
              (state(mod(), "wifi-watchdog"), helper_lines(tmp)))
        HT["recording"] = False
        poke()
        m = wait_for(lambda: state(mod(), "wifi-watchdog") == "On" and mod(), 30) or mod()
        check("...then it's put in", "fix-install wifi-watchdog" in helper_lines(tmp) and there("wifi-watchdog"), (m.get("status"), helper_lines(tmp)))
        check("...and the Wi-Fi test button shows", hidden(m, "testWifi") is False, m.get("actions"))

        with open(journal, "w") as f:
            f.write("Reloading the Wi-Fi driver now, as asked (a test).\nThe Wi-Fi driver is reloaded: rmmod + modprobe.\nBack on TestNet 4 s after the reload.\n")
        code, d = ask(port, "POST", "/api/action", {"module": "fixes", "action": "testWifi"})
        check("The Wi-Fi recovery's test asks the root helper", code == 200 and "wifi-test" in helper_lines(tmp), (code, d))
        time.sleep(6)
        poke()
        r = wait_for(lambda: ((mod().get("status") or {}).get("test") or {}).get("result"), 20)
        check("...and says how it went", r == "Back on TestNet 4 s after the reload.", r)

        ask(port, "POST", "/api/settings", {"module": "fixes", "key": "wifiWatchdog", "value": False})
        m = wait_for(lambda: state(mod(), "wifi-watchdog") == "Off" and mod(), 30) or mod()
        check("A fix switched off is taken away", "fix-remove wifi-watchdog" in helper_lines(tmp) and not there("wifi-watchdog"), (m.get("status"), helper_lines(tmp)))
        time.sleep(1.5)
        check("...and stays off (not taken for one put in by hand)", setting(mod(), "wifiWatchdog") is False and not there("wifi-watchdog"))

        ask(port, "POST", "/api/settings", {"module": "fixes", "key": "tailscaleWatchdog", "value": True})
        wait_for(lambda: state(mod(), "tailscale-watchdog") == "On", 30)
        with open(os.path.join(sim_fixes, "tailscale-watchdog.sh"), "a") as f:
            f.write("# version 2\n")
        poke()
        again = wait_for(lambda: helper_lines(tmp).count("fix-install tailscale-watchdog") == 2 and state(mod(), "tailscale-watchdog") == "On", 30)
        check("A fix whose script changed in a newer build is put in again", bool(again), helper_lines(tmp))
        check("...and one put in by hand isn't, while its script is the same", "fix-install freeze-restart" not in helper_lines(tmp), helper_lines(tmp))

        with open(fail, "w") as f:
            f.write("network-tuning")
        ask(port, "POST", "/api/settings", {"module": "fixes", "key": "networkTuning", "value": True})
        m = wait_for(lambda: (state(mod(), "network-tuning") or "").startswith("Didn't go in") and mod(), 30) or mod()
        warns = (m.get("status") or {}).get("warnings") or []
        check("A fix that didn't go in says why", any(w.startswith("Network tuning: Didn't go in") and "nft" in w for w in warns), warns)
        check("...with a button to try again", hidden(m, "retry") is False, m.get("actions"))
        tries = helper_lines(tmp).count("fix-install network-tuning")
        ask(port, "POST", "/api/settings", {"module": "fixes", "key": "tailscaleWatchdog", "value": True})  # (a look, not a retry)
        time.sleep(2)
        check("...and isn't tried again by itself straight away", helper_lines(tmp).count("fix-install network-tuning") == tries, helper_lines(tmp))
        os.remove(fail)
        poke()
        m = wait_for(lambda: state(mod(), "network-tuning") == "On" and mod(), 30) or mod()
        check("...until that button is pressed", there("network-tuning") and hidden(m, "retry") is True, (m.get("status"), m.get("actions")))
        # USB power: in effect at the Pi's next restart (this start's boot ID, the supply the Pi takes it has and the
        # firmware's word standing in)
        sim = lambda rel, data: (os.makedirs(os.path.dirname(os.path.join(sim_root, rel)), exist_ok=True),
                                 open(os.path.join(sim_root, rel), "wb").write(data))
        sim("proc/sys/kernel/random/boot_id", b"boot-1\n")
        sim("proc/device-tree/chosen/power/max_current", (3000).to_bytes(4, "big"))
        ask(port, "POST", "/api/settings", {"module": "fixes", "key": "usbCurrent", "value": True})
        m = wait_for(lambda: state(mod(), "usb-current") == "On" and mod(), 30) or mod()
        warns = (m.get("status") or {}).get("warnings") or []
        check("USB power put in: until the Pi restarts, it says to restart it", "fix-install usb-current" in helper_lines(tmp) and
              any(w.startswith("USB power: restart this Pi") for w in warns), (m.get("status"), helper_lines(tmp)))
        check("...and shows the supply the Pi takes it has, and the USB ports' limit now", "the Pi takes its supply as 3 A, USB limited to 0.6 A" in (m.get("status") or {}).get("summary", ""),
              (m.get("status") or {}).get("summary"))
        sim("proc/sys/kernel/random/boot_id", b"boot-2\n")  # (restarted: the bootloader takes the supply as 5 A, the ports have 1.6 A)
        sim("proc/device-tree/chosen/power/max_current", (5000).to_bytes(4, "big"))
        sim("run/ht-sim-usb-current", b"1")
        poke()
        m = wait_for(lambda: not any(w.startswith("USB power") for w in (mod().get("status") or {}).get("warnings") or []) and mod(), 30) or mod()
        check("...restarted: no more warning, the supply taken as 5 A, the ports up to 1.6 A", not any(w.startswith("USB power") for w in (m.get("status") or {}).get("warnings") or []) and
              "the Pi takes its supply as 5 A, USB up to 1.6 A" in (m.get("status") or {}).get("summary", ""), m.get("status"))
        ask(port, "POST", "/api/settings", {"module": "fixes", "key": "usbCurrent", "value": False})
        m = wait_for(lambda: state(mod(), "usb-current") == "Off" and mod(), 30) or mod()
        check("...switched off: taken away, and a restart asked for again", "fix-remove usb-current" in helper_lines(tmp) and
              any(w.startswith("USB power: restart this Pi") for w in (m.get("status") or {}).get("warnings") or []), m.get("status"))

        _, d = ask(port)
        texts = " | ".join(e["text"] for e in d.get("events", []))
        check("Its events say what happened", all(t in texts for t in ("Freeze restart was on this Pi already", "Wi-Fi recovery put in", "Wi-Fi recovery taken off",
                                                                         "Tailscale recovery updated", "Network tuning didn't go in", "Wi-Fi recovery test: Back on TestNet",
                                                                         "USB power put in")), texts)
    finally:
        node.terminate()
        node.wait(10)

    # A Pi whose service's update didn't bring the scripts (the first update to a version with fixes is done
    # by the root helper from before): the root helper fetches them for that version. A copy of the code
    # run as it is ("dev") hasn't got them.
    for version, expect in ((NEW, "On"), (None, fixes.NOT_HERE)):
        empty = os.path.join(tmp, "sim-fixes-" + (version or "dev")[:5])
        os.makedirs(empty)
        open(os.path.join(tmp, "helper.log"), "w").close()
        node, port = start_node(tmp, gh, ht, version=version, extra=dict(HT_CLUSTER_SIM_ROOT=os.path.join(tmp, "sim-root-" + (version or "dev")[:5]),
                                                                          HT_CLUSTER_SIM_FIXES=empty, HT_TEST_FIXES_PY=fixes_py, HT_TEST_FIX_FAIL=fail))
        try:
            ask(port, "POST", "/api/settings", {"module": "fixes", "key": "tailscaleWatchdog", "value": True})
            got = wait_for(lambda: state(module(port, "fixes"), "tailscale-watchdog") == expect, 30)
            asked = "fix-install tailscale-watchdog" in helper_lines(tmp)
            if version:
                check("A build's service without the scripts has the root helper fetch them, then it's put in", bool(got) and asked, (state(module(port, "fixes"), "tailscale-watchdog"), helper_lines(tmp)))
            else:
                check("A copy of the code without them says so, and asks nothing", bool(got) and not asked, (state(module(port, "fixes"), "tailscale-watchdog"), helper_lines(tmp)))
        finally:
            node.terminate()
            node.wait(10)


def raw(port, path, headers=None, method="GET", data=None):
    """A request as a browser makes it (without the app's header unless it's given): (status, headers, bytes)."""
    h = {"Host": "127.0.0.1:%d" % port}
    h.update(headers or {})
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def check_page(tmp, gh, ht):
    """The Cluster page in a browser: the Pi serves it itself (only its own files, never in another site's
    frame), passes the page's requests for another Pi of the cluster on, and gives one-time download links."""
    a_port, b_port = free_port(), free_port()
    a, _ = start_node(tmp, gh, ht, port=a_port, extra={"HT_CLUSTER_SIM_NAME": "alpha", "HT_CLUSTER_SIM_PEERS": "127.0.0.1:%d" % b_port,
                                                        "HT_CLUSTER_STATE": os.path.join(tmp, "state-alpha"), "HT_CLUSTER_JOBS_DIR": os.path.join(tmp, "jobs-alpha")})
    b, _ = start_node(tmp, gh, ht, port=b_port, extra={"HT_CLUSTER_SIM_NAME": "beta", "HT_CLUSTER_SIM_PEERS": "127.0.0.1:%d" % a_port,
                                                       "HT_CLUSTER_STATE": os.path.join(tmp, "state-beta"), "HT_CLUSTER_JOBS_DIR": os.path.join(tmp, "jobs-beta")})
    try:
        code, hd, body = raw(a_port, "/")
        check("The Pi serves the Cluster page to a browser (no app header needed for the page)",
              code == 200 and hd.get("Content-Type", "").startswith("text/html") and b"<title>Cluster</title>" in body, (code, hd.get("Content-Type")))
        check("...saying which Pi served it", b'<meta name="ht-cluster-page" content="alpha" />' in body, body[:300])
        code, _, old = raw(a_port, "/pi-cluster.html")
        check("...at its name from before the rename too (/pi-cluster.html, as a bookmark may have it)", code == 200 and old == body, code)
        check("...never inside another site's page", "frame-ancestors 'none'" in (hd.get("Content-Security-Policy") or "") and hd.get("X-Frame-Options") == "DENY",
              dict(hd))
        with open(os.path.join(HERE, "..", "cluster.js"), "rb") as f:
            want = f.read()
        code, hd, body = raw(a_port, "/cluster.js")
        check("...and the files it loads", code == 200 and body == want and hd.get("Content-Type", "").startswith("text/javascript") and
              raw(a_port, "/models/kinds.js")[0] == 200 and raw(a_port, "/favicon.png")[1].get("Content-Type") == "image/png", (code, hd.get("Content-Type")))
        others = [raw(a_port, p)[0] for p in ("/ht_cluster.py", "/README.md", "/../README.md", "/%2e%2e/README.md", "/node/ht_cluster.py", "/index.js")]
        check("...but nothing else", all(c == 404 for c in others), others)
        check("A page asked for under another name is refused", raw(a_port, "/", {"Host": "evil.example:47830"})[0] == 403)
        check("...and only fetched (a POST to it is refused)", raw(a_port, "/", method="POST", data=b"x")[0] == 405)
        check("The API still wants the app's header (sent by the page itself)", raw(a_port, "/api/node")[0] == 403)
        code, d = ask(a_port, "GET", "/api/peers")
        check("The Pi lists the other Pis it sees", code == 200 and [p["ip"] for p in d.get("peers", [])] == ["127.0.0.1:%d" % b_port], d)

        # Passed on to another Pi (X-HT-Cluster-To)
        code, d = ask(a_port, "GET", "/api/node", headers={"X-HT-Cluster-To": "127.0.0.1:%d" % b_port})
        check("A request for another Pi is passed on to it", code == 200 and d.get("name") == "beta", (code, d.get("name")))
        code, d = ask(a_port, "GET", "/api/node", headers={"X-HT-Cluster-To": "127.0.0.1:%d" % a_port})
        check("...one naming the Pi itself is answered there", code == 200 and d.get("name") == "alpha", (code, d.get("name")))
        code, _ = ask(a_port, "POST", "/api/settings", {"module": "health", "key": "power", "value": "battery"}, headers={"X-HT-Cluster-To": "127.0.0.1:%d" % b_port})
        b_power = next((s.get("value") for s in module(b_port, "health").get("settings", []) if s["key"] == "power"), None)
        a_power = next((s.get("value") for s in module(a_port, "health").get("settings", []) if s["key"] == "power"), None)
        check("...a change too (its body passed on as it is), made there and not here", code == 200 and b_power == "battery" and a_power != "battery", (code, b_power, a_power))
        refused = [ask(a_port, "GET", "/api/node", headers={"X-HT-Cluster-To": t})[0] for t in ("8.8.8.8", "example.com", "100.64.0.1", "127.0.0.1:0")]
        check("...but never anywhere that isn't a Pi of the cluster", all(c == 403 for c in refused), refused)
        code, d = ask(a_port, "GET", "/api/node", headers={"X-HT-Cluster-To": "127.0.0.1:%d" % free_port()})
        check("...and a Pi that doesn't answer is said to", code == 502 and "No answer" in d.get("error", ""), (code, d))

        # One-time download links
        for p in ("/api/download", "http://evil.example/api/node", "/api/x/../../etc/passwd", "/api/node\r\nX: y", "relative"):
            code, _ = ask(a_port, "POST", "/api/ticket", {"path": p})
            if code != 400:
                break
        check("A download link is only made for one of the service's own requests", code == 400, (p, code))
        code, _ = ask(a_port, "POST", "/api/ticket", {"path": "/api/jobs/zip-file?job=x&whole=1", "to": "8.8.8.8"})
        check("...on a Pi of the cluster", code == 403, code)
        code, d = ask(a_port, "POST", "/api/ticket", {"path": "/api/jobs/zip-file?job=nothing&whole=1", "to": "127.0.0.1:%d" % b_port})
        url = d.get("url", "")
        first = raw(a_port, url)
        second = raw(a_port, url)
        check("A link is followed without the app's header (the request it stands for is made: here, a job that isn't there)",
              code == 200 and url.startswith("/api/download?ticket=") and first[0] == 404 and b"No such" in first[2], (code, d, first[0], first[2][:100]))
        check("...once only", second[0] == 410, second[0])
        check("...and a made-up one goes nowhere", raw(a_port, "/api/download?ticket=madeup")[0] == 410 and raw(a_port, "/api/download")[0] == 410)
    finally:
        for p in (a, b):
            p.terminate()
            p.wait(10)


def main():
    tmp = tempfile.mkdtemp(prefix="ht-cluster-test-")
    with open(os.path.join(tmp, "fake-helper.py"), "w") as f:
        f.write(FAKE_HELPER)
    with open(os.path.join(tmp, "installed.json"), "w") as f:
        json.dump({"commit": OLD, "installedAt": time.time() - 86400}, f)
    _, gh = serve(FakeGitHub)
    _, ht = serve(FakeHT)
    HT["recording"] = True
    node, port = start_node(tmp, gh, ht)
    try:
        # Who may ask
        code, _ = ask(port, headers={"X-HT-Cluster": "0"})
        check("A request without the app's header is refused", code == 403, code)
        code, _ = ask(port, headers={"Host": "evil.example:47830"})
        check("A request naming another host is refused", code == 403, code)
        code, _ = ask(port, "POST", "/api/settings", None, {"Content-Type": "text/plain"})
        check("A change that isn't JSON is refused", code in (400, 415), code)
        code, d = ask(port)
        names = [m["name"] for m in d.get("modules", [])]
        check("It describes itself with its modules in order", code == 200 and names[:3] == ["health", "rig", "updates"], names)

        # Switches and settings
        ask(port, "POST", "/api/settings", {"module": "health", "on": False})
        check("A module turned off says so", module(port, "health").get("on") is False)
        code, _ = ask(port, "POST", "/api/action", {"module": "health", "action": "x"})
        check("An off module's buttons are refused", code == 409, code)
        ask(port, "POST", "/api/settings", {"module": "health", "on": True})
        ask(port, "POST", "/api/settings", {"module": "health", "key": "power", "value": "battery"})
        h = wait_for(lambda: (module(port, "health").get("status") or {}).get("power", {}).get("source") == "battery" and module(port, "health"))
        check("Power set to battery for this Pi", bool(h), module(port, "health"))
        code, _ = ask(port, "POST", "/api/settings", {"module": "health", "key": "power", "value": "nuclear"})
        check("A setting can't take a value it doesn't offer", code == 400, code)
        rig = wait_for(lambda: (module(port, "rig").get("status") or {}).get("app") == "running" and module(port, "rig"))
        check("The rig module sees Hand Tracker recording, its camera and Sentry",
              bool(rig) and rig["status"].get("recording") and rig["status"].get("sentry") and len(rig["status"].get("cameras", [])) == 1,
              rig and rig.get("status"))
        check("...and its room as Hand Tracker works it out: free space and the time of takes it leaves (a warning when that's low)",
              bool(rig) and "about 40 minutes of takes" in (rig["status"].get("space") or "") and any("Little room left" in w for w in rig["status"].get("warnings") or []),
              rig and rig.get("status"))

        # Hand Tracker's update waits while it records, then goes in
        waiting = wait_for(lambda: (module(port, "updates").get("status") or {}).get("handTracker", {}).get("state") == "Waiting: recording", 20)
        check("A new Hand Tracker waits while it's recording", bool(waiting), (module(port, "updates").get("status") or {}).get("handTracker"))
        check("Nothing was installed while it recorded", "install-hand-tracker" not in helper_log(tmp), helper_log(tmp))
        summary = (module(port, "updates").get("status") or {}).get("summary") or ""
        check("...and its summary says how many commits behind Hand Tracker is (GitHub's compare)", "waiting: recording (3 commits behind)" in summary, summary)
        HT["recording"] = False
        ask(port, "POST", "/api/action", {"module": "updates", "action": "check"})
        done = wait_for(lambda: (module(port, "updates").get("status") or {}).get("handTracker", {}).get("state") == "Up to date", 60)
        check("Once it stopped recording, Hand Tracker updated", bool(done) and "install-hand-tracker" in helper_log(tmp),
              ((module(port, "updates").get("status") or {}).get("handTracker"), helper_log(tmp)))
        actions = [c.get("action") for c in HT["commands"]]
        check("Hand Tracker was restarted, then Sentry turned back on", actions[-2:] == ["restartApp", "sentry"] and HT["armed"], HT["commands"])
        _, d = ask(port)
        texts = " | ".join(e["text"] for e in d.get("events", []))
        check("Its events say so", "Hand Tracker updated to bbbbbbb" in texts and "Sentry turned back on" in texts, texts)

        # Raspberry Pi OS
        os_state = wait_for(lambda: (module(port, "updates").get("status") or {}).get("os", {}).get("rebootNeeded"), 30)
        warns = (module(port, "updates").get("status") or {}).get("warnings") or []
        check("OS updates went in, and it asks for a restart", bool(os_state) and any("Restart this Pi" in w for w in warns) and "os-upgrade" in helper_log(tmp), warns)
        HT["recording"] = True
        code, d = ask(port, "POST", "/api/action", {"module": "updates", "action": "reboot"})
        check("Restart this Pi is refused while recording", code == 409, (code, d))
        HT["recording"] = False
        code, d = ask(port, "POST", "/api/action", {"module": "updates", "action": "reboot"})
        check("Restart this Pi asks the root helper", code == 200 and "reboot" in helper_log(tmp), (code, d))
        check("GitHub was asked again with the release's ETag (free when unchanged)", GH["requests"].count("/repos/%s/releases/tags/latest-build" % REPO) >= 2)
    finally:
        node.terminate()
        node.wait(10)

    # The service updating itself (with Hand Tracker out of date too: that's left to the new one)
    with open(os.path.join(tmp, "installed.json"), "w") as f:
        json.dump({"commit": OLD, "installedAt": time.time() - 86400}, f)
    open(os.path.join(tmp, "helper.log"), "w").close()
    node2, port2 = start_node(tmp, gh, ht, version=OLD)
    try:
        code = node2.wait(30)
        out = node2.stdout.read()
        check("An old service updates itself, then ends for systemd to restart it", code == 0 and "update-cluster" in helper_log(tmp), (code, out[-500:]))
        check("...without starting Hand Tracker's update as it ends", "install-hand-tracker" not in helper_log(tmp), helper_log(tmp))
    except subprocess.TimeoutExpired:
        node2.terminate()
        check("An old service updates itself, then ends for systemd to restart it", False, "still running")

    # The Pi fixes
    check_fixes(tmp, gh, ht)

    # The Cluster page in a browser
    check_page(tmp, gh, ht)

    # The real root helper's downloads (as a user other than root: pointed at the stand-in GitHub)
    loader = importlib.machinery.SourceFileLoader("ht_cluster_root", os.path.join(NODE, "ht-cluster-root"))
    spec = importlib.util.spec_from_loader("ht_cluster_root", loader)
    helper = importlib.util.module_from_spec(spec)
    os.environ.update(HT_CLUSTER_GITHUB_API=gh, HT_CLUSTER_GITHUB_RAW=gh + "/raw", HT_CLUSTER_ROOT_DIR=os.path.join(tmp, "root"))
    loader.exec_module(helper)
    dest = os.path.join(tmp, "x.deb")
    helper.download(gh + "/dl/hand-tracker_1.1.0_arm64.deb", dest, len(DEB), hashlib.sha256(DEB).hexdigest())
    check("A download that matches GitHub's size and SHA-256 is kept", os.path.exists(dest))
    for what, size, sha in (("size", len(DEB) + 1, None), ("SHA-256", len(DEB), "0" * 64)):
        try:
            helper.download(gh + "/dl/hand-tracker_1.1.0_arm64.deb", dest + what, size, sha)
            check("A download with the wrong %s is thrown away" % what, False, "kept")
        except helper.Failed:
            check("A download with the wrong %s is thrown away" % what, not os.path.exists(dest + what) and not os.path.exists(dest + what + ".part"))
    # The Cluster page's files: the same list in the service and its root helper; fetched for a version
    # put in by the helper from before (any system: no folder switch)
    spec = importlib.util.spec_from_file_location("ht_cluster_service", os.path.join(NODE, "ht_cluster.py"))
    service = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(service)
    check("The service and its root helper list the same page files", tuple(service.PAGE_FILES) == tuple(helper.PAGE) == PAGE, (service.PAGE_FILES, helper.PAGE))
    cur_dir = os.path.join(tmp, "root", "opt", "ht-cluster", "current")
    os.makedirs(cur_dir, exist_ok=True)
    with open(os.path.join(cur_dir, "VERSION"), "w") as f:
        f.write(NEW + "\n")
    got = helper.fetch_page()
    same = True
    for p in PAGE:
        with open(os.path.join(HERE, "..", *p.split("/")), "rb") as a:
            try:
                with open(os.path.join(cur_dir, "web", *p.split("/")), "rb") as b:
                    same = same and a.read() == b.read()
            except OSError:
                same = False
    check("A version without the page's files gets them from GitHub for its own commit, checked", got.get("files") == len(PAGE) and same, got)
    check("...once (asked again: nothing to do)", helper.fetch_page().get("unchanged") is True)
    with open(os.path.join(cur_dir, "VERSION"), "w") as f:
        f.write("local\n")
    shutil.rmtree(os.path.join(cur_dir, "web"))
    try:
        helper.fetch_page()
        check("A copy put in by hand (no commit to fetch them for) says so", False, "it fetched something")
    except helper.Missing:
        check("A copy put in by hand (no commit to fetch them for) says so", True)
    shutil.rmtree(os.path.join(tmp, "root", "opt"))
    for name, why in (("rm-rf", "No fix called"), ("wifi-watchdog", "hasn't got the fixes")):
        try:
            helper.fix_install(name)
            check("fix-install refuses %s" % name, False, "it went ahead")
        except helper.Failed as e:
            check("fix-install refuses %s (%s)" % (name, "not a fix" if name == "rm-rf" else "not in this version"), why in str(e), e)
    if os.name == "posix":
        os.makedirs(os.path.join(tmp, "root", "usr", "local", "sbin"), exist_ok=True)
        got = helper.update_cluster()
        cur = os.path.join(tmp, "root", "opt", "ht-cluster", "current")
        ok = got.get("commit") == NEW and open(os.path.join(cur, "VERSION")).read().strip() == NEW and os.path.exists(os.path.join(cur, "modules", "rig.py"))
        check("update-cluster puts the build's files in and switches to them", ok, got)
        check("...and only cluster/node's (nothing outside it)", not os.path.exists(os.path.join(tmp, "root", "evil")) and not os.path.exists(os.path.join(cur, "README.md")))
        same = True
        for f in FIX_SCRIPTS:
            with open(os.path.join(HERE, "..", "pi", f + ".sh"), "rb") as a:
                try:
                    with open(os.path.join(cur, "fixes", f + ".sh"), "rb") as b:
                        same = same and a.read() == b.read()
                except OSError:
                    same = False
        check("...with the Pi fixes from pi/, in fixes/ (and none of pi/'s other scripts)", same and not os.path.exists(os.path.join(cur, "fixes", "hotspot-setup.sh")))
        page_same = True
        for p in PAGE:
            with open(os.path.join(HERE, "..", *p.split("/")), "rb") as a:
                try:
                    with open(os.path.join(cur, "web", *p.split("/")), "rb") as b:
                        page_same = page_same and a.read() == b.read()
                except OSError:
                    page_same = False
        check("...and the Cluster page's files in web/ (and none of the top folder's others)", page_same and not os.path.exists(os.path.join(cur, "web", "index.html")))
        check("...and installs its new self", os.path.exists(os.path.join(tmp, "root", "usr", "local", "sbin", "ht-cluster-root")))
        try:
            helper.fix_install("wifi-watchdog")
            check("A fix's script that stops says why", False, "it went in")
        except helper.Failed as e:  # (run here by a user other than root: the script itself asks for sudo)
            check("A fix's script that stops says why", "sudo" in str(e), e)
        shutil.rmtree(os.path.join(cur, "fixes"))
        path, sha = helper.fix_script("tailscale-watchdog")
        with open(os.path.join(HERE, "..", "pi", "tailscale-watchdog.sh"), "rb") as a:
            want = a.read()
        check("A version without its fixes gets them from GitHub for its own commit, checked",
              open(path, "rb").read() == want and sha == hashlib.sha256(want).hexdigest() and all(os.path.exists(os.path.join(cur, "fixes", f + ".sh")) for f in FIX_SCRIPTS))
        check("Asked again: nothing to do", helper.update_cluster().get("unchanged") is True)
        shutil.rmtree(os.path.join(tmp, "root", "opt"))
        GH["tamper"] = True
        try:
            helper.update_cluster()
            check("A file that isn't what GitHub lists stops the update", False, "it went in")
        except helper.Failed as e:
            check("A file that isn't what GitHub lists stops the update", "didn't come out" in str(e), e)
    else:
        print("SKIP  update-cluster's folder switch (symbolic links: Linux and Macs)")


    # A Windows PC in the cluster (the user, 2026-11-22: "this PC joins as a member"), simulated: its modules
    GH["tamper"] = False
    p, port = start_node(tmp, gh, ht, extra={"HT_CLUSTER_PLATFORM": "windows"})
    try:
        _, d = ask(port)
        mods = {m["name"]: m for m in d.get("modules", [])}
        check("A Windows PC's service has the modules but the Pi fixes", "fixes" not in mods and {"health", "rig", "updates", "jobs", "apps"} <= set(mods), sorted(mods))
        js = (mods.get("jobs") or {}).get("settings", [])
        pr = next((s for s in js if s["key"] == "priority"), {})
        check("...its jobs' priority a choice of its own (Low to High; Below normal at first), not the Pis' high-priority switch",
              [s["key"] for s in js] == ["take", "priority", "withCameras", "onBattery", "home"] and pr.get("value") == "belowNormal"
              and [c[0] for c in pr.get("choices", [])] == ["low", "belowNormal", "normal", "aboveNormal", "high"], js)
        code, _ = ask(port, "POST", "/api/settings", {"module": "jobs", "key": "priority", "value": "aboveNormal"})
        code2, _ = ask(port, "POST", "/api/settings", {"module": "jobs", "key": "priority", "value": "realtime"})
        check("...which takes any of them, and nothing else", code == 200 and code2 == 400
              and next((s["value"] for s in module(port, "jobs")["settings"] if s["key"] == "priority"), None) == "aboveNormal", (code, code2))
        up = mods.get("updates") or {}
        check("...only its own service updated by itself (not Hand Tracker or the system), their buttons hidden",
              [s["key"] for s in up.get("settings", [])] == ["cluster"]
              and all(a["hidden"] for a in up.get("actions", []) if a["name"] in ("updateHandTracker", "updateOS", "reboot"))
              and (up.get("status") or {}).get("summary", "").startswith("This service:"), up)
        st = (mods.get("apps") or {}).get("status") or {}
        check("...and no Transmission until its Linux for it is set up", st.get("canRun") is False and "isn't set up" in st.get("summary", ""), st)
    finally:
        p.terminate()
        p.wait(10)

    # The root helper's Windows part: the service's own update into versions/<commit>, named in current.txt
    if os.name == "nt":
        win_install = os.path.join(tmp, "win-install")
        os.environ.update(HT_CLUSTER_WINDOWS="1", HT_CLUSTER_INSTALL=win_install)
        wl = importlib.machinery.SourceFileLoader("ht_cluster_root_win", os.path.join(NODE, "ht-cluster-root"))
        winhelper = importlib.util.module_from_spec(importlib.util.spec_from_loader("ht_cluster_root_win", wl))
        wl.exec_module(winhelper)
        for k in ("HT_CLUSTER_WINDOWS", "HT_CLUSTER_INSTALL"):
            os.environ.pop(k, None)
        before, older = "0" * 40, "1" * 40
        for v in (before, older):
            os.makedirs(os.path.join(win_install, "versions", v))
        with open(os.path.join(win_install, "current.txt"), "w") as fh:
            fh.write(before + "\n")
        got = winhelper.update_cluster()
        cur = os.path.join(win_install, "versions", NEW)
        with open(os.path.join(win_install, "current.txt")) as fh:
            named = fh.read().strip()
        check("On a Windows PC, update-cluster puts the build's files in versions/<commit> and names it in current.txt",
              got.get("commit") == NEW and named == NEW and os.path.exists(os.path.join(cur, "windows", "launcher.py"))
              and os.path.exists(os.path.join(cur, "winsys.py")) and os.path.exists(os.path.join(cur, "web", "cluster.html")), (got, named))
        check("...keeping the one before, and only that", sorted(os.listdir(os.path.join(win_install, "versions"))) == sorted([before, NEW]),
              os.listdir(os.path.join(win_install, "versions")))
        check("...asked again: nothing to do", winhelper.update_cluster().get("unchanged") is True)
        shutil.rmtree(os.path.join(cur, "web"))
        check("...its page's files fetched again for that commit when they're missing", winhelper.fetch_page().get("files") == len(PAGE))
        # (after a start: its files checked against GitHub's list for its commit, a damaged or missing one put back)
        with open(os.path.join(cur, "modules", "rig.py"), "rb") as fh:
            rig_was = fh.read()
        with open(os.path.join(cur, "modules", "rig.py"), "wb") as fh:
            fh.write(rig_was[:100])  # (cut short, as by a power cut)
        os.remove(os.path.join(cur, "winsys.py"))
        got = winhelper.verify_cluster()
        with open(os.path.join(cur, "modules", "rig.py"), "rb") as fh:
            back = fh.read() == rig_was
        check("verify-cluster: a file cut short and one missing are put back as GitHub lists them, the rest left as they are",
              sorted(got.get("repaired") or []) == ["modules/rig.py", "winsys.py"] and back and os.path.exists(os.path.join(cur, "winsys.py"))
              and got.get("checked", 0) > 20, got)
        check("...and asked again: nothing to put back", winhelper.verify_cluster().get("repaired") == [])
        r = subprocess.run([sys.executable, os.path.join(NODE, "ht-cluster-root"), "reboot"], capture_output=True, text=True,
                           env=dict(os.environ, HT_CLUSTER_WINDOWS="1", HT_CLUSTER_INSTALL=win_install))
        check("...and does nothing else there (restarting the PC, say)", r.returncode == 1 and "Not on Windows" in r.stdout, r.stdout)

        # Its launcher: the version current.txt names, as a Windows PC's, started again when it ends; one launcher at a time
        lt = os.path.join(tmp, "launcher-test")
        os.makedirs(os.path.join(lt, "versions", "dev", "windows"))
        for where in (os.path.join(lt, "launcher.py"), os.path.join(lt, "versions", "dev", "windows", "launcher.py")):
            shutil.copyfile(os.path.join(NODE, "windows", "launcher.py"), where)
        with open(os.path.join(lt, "versions", "dev", "ht_cluster.py"), "w") as fh:
            fh.write("import os, time\nwith open(os.path.join(os.environ['HT_CLUSTER_INSTALL'], 'runs.txt'), 'a') as f:\n"
                     "    f.write(os.environ['HT_CLUSTER_PLATFORM'] + ' ' + os.environ['HT_CLUSTER_STATE'] + '\\n')\ntime.sleep(0.5)\n")
        with open(os.path.join(lt, "current.txt"), "w") as fh:
            fh.write("dev\n")
        runs = os.path.join(lt, "runs.txt")
        lp = subprocess.Popen([sys.executable, os.path.join(lt, "launcher.py")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            twice = wait_for(lambda: os.path.exists(runs) and len(open(runs).read().splitlines()) >= 2, 25)
            second = subprocess.run([sys.executable, os.path.join(lt, "launcher.py")], capture_output=True, timeout=20)
            lines = open(runs).read().splitlines() if os.path.exists(runs) else []
            check("The launcher starts the service as a Windows PC's, with its state in its folder, and again when it ends",
                  bool(twice) and all(l == "windows " + os.path.join(lt, "state") for l in lines), lines)
            check("...one launcher at a time (a second ends at once)", second.returncode == 0 and lp.poll() is None, second.returncode)
        finally:
            lp.kill()
            lp.wait(10)
    else:
        print("SKIP  the root helper's Windows part and the launcher (Windows)")

    check_health_units()
    check_update_trial_units()
    shutil.rmtree(tmp, ignore_errors=True)
    print("%d/%d checks passed." % (sum(results), len(results)))
    return 0 if all(results) else 1


def check_update_trial_units():
    """updates.py's choice of the Pi that tries a new build first, and the others following (the user, 2026-11-22:
    an idle Pi, no cameras; the others 30 minutes after its check passed), with stand-in Pis."""
    spec = importlib.util.spec_from_file_location("updates_unit", os.path.join(NODE, "modules", "updates.py"))
    U = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(U)

    class Mem(dict):
        def save(self):
            pass

    class Node:
        simulate = True

        def __init__(self, name, peers=(), version=OLD):
            self.name, self.version, self.peers, self.mem, self.events = name, version, list(peers), Mem(), []
            self.modules = {}

        def memory(self, module):
            return self.mem

        def cluster(self, fresh=False):
            return [{"name": n, "node": {"modules": [{"name": "updates", "on": True, "status": st}]}} for n, st in self.peers]

        def setting(self, module, key):
            return True

        def event(self, module, text, bad=False):
            self.events.append(text)

    old = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 10 * 86400))
    new = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 600))
    rel = {"commit": NEW, "at": new}
    U.recording = lambda node: getattr(node, "rec", False)
    U._state["idle"] = True
    a = Node("alpha", [("beta", {"idle": True})])
    go_a = U.plan(a, rel)
    b = Node("beta", [("alpha", {"idle": True})])
    go_b = U.plan(b, rel)
    check("A new build: of two idle Pis, the first by name tries it first (and says so); the other waits for it",
          go_a == (True, None) and a.mem["trial"]["state"] == "updating" and go_b[0] is False and "alpha tries it first" in go_b[1], (go_a, go_b))
    b.peers = [("alpha", {"idle": True, "trial": dict(a.mem["trial"])})]
    U._state["idle"] = True
    check("...while it's trying, the other doesn't go first itself", U.plan(b, rel)[1] == "alpha tries it first", U.plan(b, rel))
    b.peers = [("alpha", {"trial": {"commit": NEW, "state": "passed", "at": time.time() - 60}})]
    waits = U.plan(b, rel)
    b.peers = [("alpha", {"trial": {"commit": NEW, "state": "passed", "at": time.time() - 31 * 60}})]
    check("...once its check passed, the others put it in 30 minutes later",
          waits[0] is False and "the others follow at" in waits[1] and U.plan(b, rel) == (True, None), (waits, U.plan(b, rel)))
    b.peers = [("alpha", {"trial": {"commit": NEW, "state": "failed", "at": time.time() - 3 * 3600, "error": "Hand Tracker didn't answer"}})]
    nope = U.plan(b, rel)
    check("...if its check failed, the others don't put it in by themselves", nope[0] is False and "check of this build failed" in nope[1], nope)
    U._state["idle"] = False
    c = Node("gamma", [("alpha", {"idle": False}), ("pc", {"idle": True, "windows": True})])
    young = U.plan(c, rel)
    check("No idle Pi (a Windows PC never goes first): a new build waits", young[0] is False and "idle Pi" in young[1] and "trial" not in c.mem, young)
    aged = U.plan(c, {"commit": NEW, "at": old})
    c.rec = True
    rec = U.plan(c, {"commit": NEW, "at": old})
    check("...an older one goes in on a Pi that isn't recording, not on one that is", aged == (True, None) and rec[0] is False, (aged, rec))

    # The first Pi's check: once both parts are in, passed; a module that didn't start fails it
    U.needs = lambda node, r: False
    U.rig = lambda node: None
    a.modules = {"health": types.SimpleNamespace(name="health", error=None)}
    a.version = NEW
    a.mem["trial"] = {"commit": NEW, "state": "updating", "at": time.time()}
    U.trial_progress(a, rel)
    passed = dict(a.mem["trial"])
    a.mem["trial"] = {"commit": NEW, "state": "updating", "at": time.time()}
    a.modules["jobs"] = types.SimpleNamespace(name="jobs", error="ImportError")
    U.trial_progress(a, rel)
    check("The first Pi checks the build once it's in: passed; a module of the service that didn't start fails it",
          passed["state"] == "passed" and a.mem["trial"]["state"] == "failed" and "jobs" in a.mem["trial"]["error"], (passed, a.mem["trial"]))


def check_health_units():
    """health.py on its own (the user, 2026-11-22): its starts and why, and a Pi on battery at 10% saving its
    recording and then shutting down. With a stand-in node (simulated readings, set through the environment)."""
    spec = importlib.util.spec_from_file_location("health_unit", os.path.join(NODE, "modules", "health.py"))
    H = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(H)

    class Mem(dict):
        def save(self):
            pass

    class Rig:
        def __init__(self):
            self.recording, self.asked = False, []

        def busy(self, node):
            return self.recording

        def ht(self, node, method, path, body=None, timeout=6):
            self.asked.append(body)
            if body == {"action": "stop"}:
                threading.Timer(0.5, lambda: setattr(self, "recording", False)).start()  # (saved half a second later)
            return 200, {"ok": True}

    class Node:
        simulate = True

        def __init__(self):
            self.mem, self.events, self.jobs, self.rig = Mem(), [], [], Rig()
            self.settings = {"power": "auto", "lowBattery": True}
            self.modules = {"rig": types.SimpleNamespace(mod=self.rig)}

        def memory(self, name):
            return self.mem

        def setting(self, module, key):
            return self.settings.get(key)

        def event(self, module, text, bad=False):
            self.events.append((text, bad))

        def root(self, action, *words, timeout=0):
            self.jobs.append(action)
            return {"ok": True}

    saved = {k: os.environ.get(k) for k in ("HT_CLUSTER_SIM_BOOT_ID", "HT_CLUSTER_SIM_RSTS", "HT_CLUSTER_SIM_SHUTDOWN", "HT_CLUSTER_SIM_BATTERY", "HT_CLUSTER_SIM_UPTIME")}
    try:
        n = Node()
        os.environ["HT_CLUSTER_SIM_UPTIME"] = "600"

        def start(bid, rsts=None):
            os.environ["HT_CLUSTER_SIM_BOOT_ID"] = bid
            if rsts is None:
                os.environ.pop("HT_CLUSTER_SIM_RSTS", None)
            else:
                os.environ["HT_CLUSTER_SIM_RSTS"] = rsts
            H.readings(n)
            H.boot_tick(n)
        start("b1")
        os.environ["HT_CLUSTER_SIM_SHUTDOWN"] = "restart"
        H.stopping(n)
        os.environ.pop("HT_CLUSTER_SIM_SHUTDOWN")
        start("b2", "0x1020")  # (power-on flags too: the note wins)
        start("b3", "0x1020")  # (no note, from power-on)
        start("b4", "0x20")  # (no note, a warm start)
        causes = [b["cause"] for b in n.mem["boots"]]
        check("Its starts: the first, then after a restart (its note), a power cut (power-on, no note) and a freeze (a warm start, no note)",
              causes == ["first", "restart", "power", "froze"], causes)
        st = H.status(n)
        check("...newest first in its status, with when it was last heard from, and an unexpected one in the last day a warning",
              [b["cause"] for b in st["boots"]] == ["froze", "power", "restart", "first"] and st["boots"][0]["lastSeen"] and
              any("froze" in w for w in st["warnings"]), (st["boots"], st["warnings"]))
        check("...said in its events when it wasn't expected", [bad for text, bad in n.events] == [True, True] and "power was cut" in n.events[0][0], n.events)

        # Low battery: 9% on battery, recording -> stopped, saved, then shut down
        n2 = Node()
        n2.rig.recording = True
        os.environ["HT_CLUSTER_SIM_BATTERY"] = "9"
        for _ in range(2):
            H.readings(n2)
            H.battery_guard(n2)
        done = wait_for(lambda: "poweroff" in n2.jobs, 15)
        check("On battery at 9%: the recording stopped and saved, then the Pi shut down",
              bool(done) and n2.rig.asked == [{"action": "stop"}] and not n2.rig.recording and any("saved" in t for t, _ in n2.events), (n2.jobs, n2.rig.asked, n2.events))
        H._guard.update(doing=False, low=0)
        for label, setup in (("charging", lambda n: None), ("in its first 3 minutes", lambda n: os.environ.update(HT_CLUSTER_SIM_UPTIME="60")),
                             ("its switch off", lambda n: n.settings.update(lowBattery=False)), ("at 11%", lambda n: os.environ.update(HT_CLUSTER_SIM_BATTERY="11"))):
            n3 = Node()
            os.environ.update(HT_CLUSTER_SIM_BATTERY="9", HT_CLUSTER_SIM_UPTIME="600")
            setup(n3)
            orig = H.simulated
            if label == "charging":
                H.simulated = lambda: dict(orig(), pisugar={"level": 9, "plugged": True, "charging": True})
            try:
                for _ in range(3):
                    H.readings(n3)
                    H.battery_guard(n3)
            finally:
                H.simulated = orig
            time.sleep(0.2)
            check("...but not %s" % label, not n3.jobs and not H._guard["doing"], (n3.jobs, H._guard))
            H._guard.update(doing=False, low=0)
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


if __name__ == "__main__":
    sys.exit(main())
