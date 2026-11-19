#!/usr/bin/env python3
"""
test_cluster.py - checks Pi Cluster's service (cluster/node) on any computer:  python3 cluster/test_cluster.py

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
                                    "sentry": {"armed": HT["armed"], "shown": False}})
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


FIX_SCRIPTS = ("wifi-watchdog", "tailscale-watchdog", "network-tuning", "freeze-restart")


def repo_files():
    """The build's files the service's update looks at: cluster/node's, and the Pi fixes in pi/ (with one of
    pi/'s other scripts, which isn't taken)."""
    out = node_files()
    for f in FIX_SCRIPTS:
        with open(os.path.join(HERE, "..", "pi", f + ".sh"), "rb") as fh:
            out.append(("pi/%s.sh" % f, fh.read()))
    out.append(("pi/hotspot-setup.sh", b"# not a fix: never taken\n"))
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
    script = os.path.join(os.environ["HT_CLUSTER_SIM_FIXES"], name + ".sh")
    if not os.path.exists(script):  # (the real one fetches it for its version, from GitHub)
        with open(script, "w") as f:
            f.write("# stand-in for pi/" + name + ".sh, fetched")
    if job == "fix-install":
        with open(script, "rb") as f:
            sha = hashlib.sha256(f.read()).hexdigest()
        print(json.dumps({"ok": True, "fix": name, "sha256": sha, "said": "Set up."}))
    else:
        print(json.dumps({"ok": True, "fix": name, "said": "Removed."}))
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


def start_node(tmp, gh, ht, version=None, extra=None):
    port = free_port()
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
        _, d = ask(port)
        texts = " | ".join(e["text"] for e in d.get("events", []))
        check("Its events say what happened", all(t in texts for t in ("Freeze restart was on this Pi already", "Wi-Fi recovery put in", "Wi-Fi recovery taken off",
                                                                         "Tailscale recovery updated", "Network tuning didn't go in", "Wi-Fi recovery test: Back on TestNet")), texts)
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

        # Hand Tracker's update waits while it records, then goes in
        waiting = wait_for(lambda: (module(port, "updates").get("status") or {}).get("handTracker", {}).get("state") == "Waiting: recording", 20)
        check("A new Hand Tracker waits while it's recording", bool(waiting), (module(port, "updates").get("status") or {}).get("handTracker"))
        check("Nothing was installed while it recorded", "install-hand-tracker" not in helper_log(tmp), helper_log(tmp))
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

    shutil.rmtree(tmp, ignore_errors=True)
    print("%d/%d checks passed." % (sum(results), len(results)))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
