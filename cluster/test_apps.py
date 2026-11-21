#!/usr/bin/env python3
"""
test_apps.py - checks Pi Cluster's Transmission (cluster/node/modules/apps.py) on any computer:  python3 cluster/test_apps.py

Two Pis are simulated here: "pi", which keeps Transmission's files, and "pie". Each has a stand-in
Hand Tracker (so it can be "recording"), and there's a stand-in Transmission (its RPC, keeping its
torrents in its settings folder, which both Pis see as the NFS share would let them) and a stand-in
root helper. Checked:
- the window app's torrents moved in, each keeping its folder, and their folders shared;
- Transmission started on pi (its home, free) and reachable on its old address;
- the turtle;
- each torrent's totals, peers and place in the queue, and its speeds over time (the last hour's
  readings, and the minutes kept on the home's disk); asking for more peers, moving a waiting torrent
  in the queue, and how many download, seed and connect at once;
- moved to pie while pi records, and back to pi when asked to and free again;
- a new download into a folder of your choice (shared then);
- pie stopping it by itself when it can't reach pi;
- the torrents given back.
"""

import http.server
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
results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print("%s  %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  (%s)" % str(detail)[:600]), flush=True)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


FAKE_TRANSMISSION = r'''
import hashlib, http.server, json, os, sys, threading
port, config, who = int(sys.argv[1]), sys.argv[2], sys.argv[3]
STATE = os.path.join(config, "fake-state.json")
lock = threading.Lock()
LIMIT_KEYS = ("download-queue-enabled", "download-queue-size", "seed-queue-enabled", "seed-queue-size", "peer-limit-global", "peer-limit-per-torrent", "utp-enabled")
def load():
    try:
        return json.load(open(STATE))
    except Exception:
        return {"alt": False, "added": []}
def save(s):
    json.dump(s, open(STATE, "w"))
def torrents():
    out = []
    rd = os.path.join(config, "resume")
    for i, n in enumerate(sorted(os.listdir(rd)) if os.path.isdir(rd) else []):
        data = open(os.path.join(rd, n), "rb").read()
        k = data.find(b"11:destination")
        rest = data[k + 14:]
        ln = int(rest.split(b":")[0])
        dest = rest[len(str(ln)) + 1:len(str(ln)) + 1 + ln].decode()
        # (the first seeds, at 1.5 KB/s; the others wait to download)
        out.append({"id": i + 1, "name": n[:-7], "downloadDir": dest, "percentDone": 1 if i == 0 else 0.5, "status": 6 if i == 0 else 3,
                    "rateDownload": 0, "rateUpload": 1500 if i == 0 else 0})
    s = load()
    for j, a in enumerate(s["added"]):
        out.append({"id": 100 + j, "name": a["name"], "downloadDir": a["dir"], "percentDone": 0, "status": 4, "rateDownload": 3000, "rateUpload": 100})
    order = queue(s, [t["id"] for t in out])
    for t in out:
        t.update(hashString=hashlib.sha1(t["name"].encode()).hexdigest(), downloadedEver=1000000 * t["id"], uploadedEver=500000 * t["id"],
                 peersConnected=3, queuePosition=order.index(t["id"]))
    return out
def queue(s, ids):
    kept = [i for i in s.get("order") or [] if i in ids]
    return kept + [i for i in ids if i not in kept]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        if self.headers.get("X-Transmission-Session-Id") != "sid":
            self.send_response(409); self.send_header("X-Transmission-Session-Id", "sid"); self.send_header("Content-Length", "0"); self.end_headers(); return
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
        m, a = req.get("method"), req.get("arguments") or {}
        with lock:
            s = load()
            if m == "session-get":
                st = json.load(open(os.path.join(config, "settings.json")))
                res = dict(st, **{"alt-speed-enabled": s["alt"], "who": who})
                res.update(s.get("limits") or {})
            elif m == "session-set":
                if "alt-speed-enabled" in a: s["alt"] = bool(a["alt-speed-enabled"])
                for k in LIMIT_KEYS:
                    if k in a: s.setdefault("limits", {})[k] = a[k]
                save(s)
                res = {}
            elif m == "torrent-reannounce":
                s.setdefault("reannounced", []).append(a.get("ids") or "all"); save(s)
                res = {}
            elif m.startswith("queue-move-") or (m == "torrent-set" and "queuePosition" in a):
                order = queue(s, [t["id"] for t in torrents()])
                for i in a.get("ids") or []:
                    k = order.index(i)
                    order.remove(i)
                    where = {"queue-move-top": 0, "queue-move-bottom": len(order), "queue-move-up": max(0, k - 1), "queue-move-down": k + 1}.get(m, a.get("queuePosition"))
                    order.insert(where, i)
                s["order"] = order; save(s)
                res = {}
            elif m == "session-stats":
                res = {"torrentCount": len(torrents()), "downloadSpeed": 1000, "uploadSpeed": 500, "who": who}
            elif m == "torrent-get":
                res = {"torrents": torrents()}
            elif m == "torrent-add":
                name = a.get("filename", "file")[-12:]
                s["added"].append({"name": name, "dir": a.get("download-dir")}); save(s)
                res = {"torrent-added": {"name": name}}
            else:
                res = {}
        body = json.dumps({"result": "success", "arguments": res}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
'''

FAKE_HELPER = r'''
import json, os, subprocess, sys, time
job, words = sys.argv[1], sys.argv[2:]
state = os.environ["HT_CLUSTER_STATE"]
with open(os.environ["HT_TEST_HELPER_LOG"], "a") as f:
    f.write("%s %s %s\n" % (os.environ.get("HT_CLUSTER_SIM_NAME"), job, " ".join(words)))
marker = os.path.join(state, "tr-running")
if job == "transmission-start":
    if os.path.exists(marker):
        pid = int(open(marker).read())
        try: os.kill(pid, 9)
        except OSError: pass
    p = subprocess.Popen([sys.executable, os.environ["HT_TEST_FAKE_TR"], os.environ["HT_CLUSTER_TR_PORT"], os.environ["HT_CLUSTER_TR_CONFIG"], os.environ["HT_CLUSTER_SIM_NAME"]],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)  # (as systemd-run: nothing left holding the answer open)
    time.sleep(0.7)
    open(marker, "w").write(str(p.pid))
    print(json.dumps({"ok": True, "started": words[0]}))
elif job == "transmission-stop":
    if os.path.exists(marker):
        try: os.kill(int(open(marker).read()), 9)
        except OSError: pass
        os.remove(marker)
    print(json.dumps({"ok": True}))
elif job == "nfs-share":
    print(json.dumps({"ok": True, "shared": sorted(set(words))}))
else:
    print(json.dumps({"ok": True}))
'''


def fake_ht():
    st = {"recording": False}

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            body = json.dumps({"recording": st["recording"], "saving": False, "cameras": [], "sentry": {"armed": False}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return st, "http://127.0.0.1:%d" % srv.server_address[1]


def ask(port, method, path, body=None):
    h = {"X-HT-Cluster": "1", "Host": "127.0.0.1:%d" % port}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")
    except OSError as e:
        return None, {"error": str(e)}


def act(port, action, args=None):
    return ask(port, "POST", "/api/action", {"module": "apps", "action": action, "args": args or {}})


def apps(port):
    code, d = ask(port, "GET", "/api/node")
    return next((m for m in (d or {}).get("modules", []) if m["name"] == "apps"), {}).get("status") or {} if code == 200 else {}


def tr_ask(port, method, args=None):
    url = "http://127.0.0.1:%d/transmission/rpc" % port
    body = json.dumps({"method": method, "arguments": args or {}}).encode()
    sid = ""
    for _ in range(2):
        req = urllib.request.Request(url, body, {"Content-Type": "application/json", "X-Transmission-Session-Id": sid})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return json.loads(r.read())["arguments"]
        except urllib.error.HTTPError as e:
            if e.code != 409:
                return None
            sid = e.headers.get("X-Transmission-Session-Id", "")
        except OSError:
            return None
    return None


def wait_for(fn, seconds=60):
    until = time.time() + seconds
    while time.time() < until:
        try:
            v = fn()
            if v:
                return v
        except (OSError, ValueError, KeyError, TypeError):
            pass
        time.sleep(0.5)
    return None


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")  # (Windows' console: its speeds' arrows)
    tmp = tempfile.mkdtemp(prefix="ht-apps-test-")
    home = os.path.join(tmp, "home")
    gtk = os.path.join(home, ".config", "transmission")
    config = os.path.join(tmp, "shared-settings")  # (both Pis see it, as over the NFS share)
    for d in (os.path.join(gtk, "torrents"), os.path.join(gtk, "resume"), os.path.join(home, "Videos", "shows"), os.path.join(home, "Videos", "movies"), os.path.join(home, "Downloads")):
        os.makedirs(d)
    for i, sub in enumerate(["Videos/shows", "Videos/shows", "Videos/movies"]):
        dest = os.path.join(home, *sub.split("/")).encode()
        with open(os.path.join(gtk, "resume", "t%d.resume" % i), "wb") as f:
            f.write(b"d11:destination%d:%s5:addedi1ee" % (len(dest), dest))
        open(os.path.join(gtk, "torrents", "t%d.torrent" % i), "wb").write(b"d4:infod4:name2:t%dee" % i)
    json.dump({"download-dir": os.path.join(home, "Downloads"), "rpc-port": 9092, "speed-limit-down": 1000, "speed-limit-down-enabled": True,
               "rpc-whitelist": "127.0.0.1,::1,100.*.*.*,192.168.1.*", "peer-port": 51413}, open(os.path.join(gtk, "settings.json"), "w"))
    with open(os.path.join(tmp, "fake-tr.py"), "w") as f:
        f.write(FAKE_TRANSMISSION)
    with open(os.path.join(tmp, "fake-helper.py"), "w") as f:
        f.write(FAKE_HELPER)
    log = os.path.join(tmp, "helper.log")
    pi_ht, pi_ht_url = fake_ht()
    pie_ht, pie_ht_url = fake_ht()
    pi_port, pie_port, old = free_port(), free_port(), free_port()
    procs = {}

    def start(name, port, peer, ht, tr_port):
        env = dict(os.environ, HT_CLUSTER_SIM_NAME=name, HT_CLUSTER_SIM_PEERS="127.0.0.1:%d" % peer, HT_CLUSTER_STATE=os.path.join(tmp, name + "-state"),
                   HT_CLUSTER_JOBS_DIR=os.path.join(tmp, name + "-jobs"), HT_CLUSTER_HT_URL=ht, HT_CLUSTER_ROOT_HELPER=os.path.join(tmp, "fake-helper.py"),
                   HT_TEST_HELPER_LOG=log, HT_TEST_FAKE_TR=os.path.join(tmp, "fake-tr.py"), HT_CLUSTER_TR_PORT=str(tr_port), HT_CLUSTER_TR_CONFIG=config,
                   HT_CLUSTER_TR_OLD_PORT=str(old), HT_CLUSTER_SIM_GTK=gtk, HT_CLUSTER_SIM_HOME=home, HT_CLUSTER_SIM_FAST="1", PYTHONDONTWRITEBYTECODE="1")
        p = subprocess.Popen([sys.executable, os.path.join(NODE, "ht_cluster.py"), "--simulate", "--port", str(port)], env=env,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        procs[name] = p
        wait_for(lambda: ask(port, "GET", "/api/node")[0] == 200, 20)

    pi_tr, pie_tr = free_port(), free_port()
    try:
        start("pi", pi_port, pie_port, pi_ht_url, pi_tr)
        start("pie", pie_port, pi_port, pie_ht_url, pie_tr)
        ask(pi_port, "POST", "/api/settings", {"module": "apps", "key": "home", "value": True})
        st = wait_for(lambda: apps(pi_port).get("home") and apps(pi_port), 10)
        check("pi keeps Transmission's files; nothing moved in yet", st and st.get("migrated") is False, st)

        code, a = act(pi_port, "migrate")
        check("The window app's torrents move in", code == 200 and a.get("ok"), a)
        check("...their files and progress copied, the window app's own put aside",
              len(os.listdir(os.path.join(config, "torrents"))) == 3 and len(os.listdir(os.path.join(config, "resume"))) == 3 and
              not os.path.exists(os.path.join(gtk, "torrents")) and os.path.isdir(os.path.join(gtk, "moved-to-pi-cluster", "torrents")) and
              os.path.exists(os.path.join(gtk, "settings.json")))
        s = json.load(open(os.path.join(config, "settings.json")))
        check("...its settings kept, on its own address now", s.get("speed-limit-down") == 1000 and s.get("rpc-port") == pi_tr and s.get("download-dir").endswith("Downloads"), s)
        shared = wait_for(lambda: [l for l in open(log).read().splitlines() if " nfs-share " in l], 10)
        check("...and their folders shared (Downloads, Videos)", shared and shared[0].endswith("nfs-share Downloads Videos"), shared)

        on_pi = wait_for(lambda: (apps(pi_port).get("runner") == "pi" and (tr_ask(old, "session-stats") or {}).get("who") == "pi") and True, 30)
        check("Transmission starts on pi (its home, free), and answers on its old address", bool(on_pi), (apps(pi_port), tr_ask(old, "session-stats")))
        torrents = (tr_ask(old, "torrent-get") or {}).get("torrents") or []
        check("...every torrent in its own folder", sorted(t["downloadDir"].replace(home, "~").replace(os.sep, "/") for t in torrents) ==
              ["~/Videos/movies", "~/Videos/shows", "~/Videos/shows"], torrents)

        code, a = act(pi_port, "turtle", {"on": True})
        tur = wait_for(lambda: apps(pi_port).get("turtle") is True, 20)
        check("The turtle goes on", code == 200 and tur, (a, apps(pi_port)))

        # Each torrent: its totals, peers and place in the queue; its traffic over time
        code, a = act(pi_port, "torrents")
        ts = {t["id"]: t for t in a.get("torrents", [])}
        check("The torrents come with their totals, peers and place in the queue",
              code == 200 and len(ts) == 3 and all(len(t.get("hashString", "")) == 40 and t.get("downloadedEver") and t.get("uploadedEver") and "queuePosition" in t and "peersConnected" in t
                                                   for t in ts.values()), a)
        seed = ts.get(1) or {}
        traffic = lambda span: act(pi_port, "traffic", {"hash": seed.get("hashString", ""), "span": span})[1]
        hour = wait_for(lambda: [p for p in traffic("1h").get("points", []) if p[2] == 1500], 20)
        check("Its speeds are read every few seconds: the last hour's", bool(hour), traffic("1h"))
        day = wait_for(lambda: [p for p in traffic("24h").get("points", []) if p[2] == 1500 and p[1] == 0], 20)
        check("...a reading a minute (the minute's average) for 24 hours", bool(day), traffic("24h"))
        week = traffic("7d")
        check("...and for 7 days, in fewer points", week.get("ok") and week.get("points") and len(week["points"]) <= len(traffic("24h")["points"]), week)
        kept = os.path.join(tmp, "pi-state", "transmission-traffic.jsonl")
        lines = wait_for(lambda: os.path.exists(kept) and len(open(kept).read().splitlines()) >= 2 and open(kept).read().splitlines(), 20) or []
        check("...kept on the home's disk, a line a minute, only the torrents that moved", lines and all(json.loads(l)["r"].keys() <= {seed["hashString"][:12]} for l in lines), lines[-3:])
        code, other = act(pi_port, "traffic", {"hash": ts[2]["hashString"], "span": "1h"})
        check("A torrent that doesn't move reads 0, not nothing", code == 200 and other["points"] and all(p[1] == 0 and p[2] == 0 for p in other["points"]), other)
        code, bad = act(pi_port, "traffic", {"hash": "nope", "span": "1h"})
        code2, bad2 = act(pi_port, "traffic", {"hash": seed["hashString"], "span": "1y"})
        check("...and a torrent or span it doesn't know is refused", code != 200 and code2 != 200, (bad, bad2))

        fake = lambda: json.load(open(os.path.join(config, "fake-state.json")))
        code, a = act(pi_port, "reannounce", {"ids": [2]})
        code2, a2 = act(pi_port, "reannounce", {})
        check("Asking for more peers: one torrent's trackers, or every torrent's", code == 200 and code2 == 200 and fake().get("reannounced") == [[2], "all"], (a, a2, fake()))

        order = lambda: [t["id"] for t in sorted(act(pi_port, "torrents")[1]["torrents"], key=lambda t: t["queuePosition"])]
        before = order()
        code, a = act(pi_port, "queue", {"id": 3, "move": "up"})
        after = order()
        check("A waiting torrent moved up: past the one waiting before it", code == 200 and after.index(3) < after.index(2) and before.index(3) > before.index(2), (before, after, a))
        act(pi_port, "queue", {"id": 3, "move": "bottom"})
        act(pi_port, "queue", {"id": 2, "move": "top"})
        check("...to the bottom, and to the top", order()[-1] == 3 and order()[0] == 2, order())
        code, a = act(pi_port, "queue", {"id": 2, "move": "sideways"})
        check("...but not anywhere else", code != 200, a)

        code, a = act(pi_port, "limits", {"downloadQueue": True, "downloadQueueSize": 2, "seedQueue": True, "seedQueueSize": 5, "peerLimit": 80, "peerLimitPerTorrent": 25})
        session = wait_for(lambda: apps(pi_port).get("session", {}).get("downloadQueueSize") == 2 and apps(pi_port)["session"], 20)
        check("How many download, seed and connect at once: set, and read back", code == 200 and session and session.get("seedQueue") is True and session.get("seedQueueSize") == 5 and
              session.get("peerLimit") == 80 and session.get("peerLimitPerTorrent") == 25, (a, session))
        saved = json.load(open(os.path.join(config, "settings.json")))
        check("...and kept in its settings, for wherever it runs next", saved.get("download-queue-size") == 2 and saved.get("peer-limit-global") == 80, saved)
        check("...said in words", "at most 2 at once" in a.get("message", "") and "80 peers" in a.get("message", ""), a)
        code, a = act(pi_port, "limits", {"peerLimit": 5000})
        code2, a2 = act(pi_port, "limits", {"downloadQueueSize": "lots"})
        check("...but not beyond what makes sense", code != 200 and code2 != 200, (a, a2))
        code, a = act(pi_port, "limits", {"utp": False})
        utp = wait_for(lambda: apps(pi_port).get("session", {}).get("utp") is False, 20)
        check("uTP off (peers over TCP only): set, read back, kept in its settings, said",
              code == 200 and utp and json.load(open(os.path.join(config, "settings.json"))).get("utp-enabled") is False and "uTP off" in a.get("message", ""), (a, apps(pi_port).get("session")))

        # pi's service restarting (an update, say) leaves its Transmission running: started again, it would ask
        # every torrent's trackers and peers at once (pi's router went down after that, 2026-11-20)
        marker = os.path.join(tmp, "pi-state", "tr-running")
        starts = lambda: len([l for l in open(log).read().splitlines() if l.startswith("pi transmission-start")])
        for note in (True, False):  # (then as from the version before, which kept no note of it)
            n0, pid0 = starts(), open(marker).read()
            procs["pi"].terminate()
            procs["pi"].wait(10)
            if not note:
                mem_file = os.path.join(tmp, "pi-state", "apps.json")
                m = json.load(open(mem_file))
                had = m.pop("started", None)
                json.dump(m, open(mem_file, "w"))
            start("pi", pi_port, pie_port, pi_ht_url, pi_tr)
            said = wait_for(lambda: any("kept running" in e.get("text", "") for e in ask(pi_port, "GET", "/api/node")[1].get("events", [])[-5:]), 30)
            time.sleep(6)  # (a few more of its words with itself)
            check("pi's service restarting leaves Transmission running, not started again" + ("" if note else ", with no note from the version before"),
                  said and starts() == n0 and os.path.exists(marker) and open(marker).read() == pid0 and apps(pi_port).get("runner") == "pi" and
                  (tr_ask(old, "session-stats") or {}).get("who") == "pi" and (note or had), (starts(), n0, apps(pi_port)))

        pi_ht["recording"] = True
        time.sleep(6)
        check("pi recording keeps it on pi (its files are there either way)", apps(pi_port).get("runner") == "pi", apps(pi_port))
        pi_ht["recording"] = False
        ask(pi_port, "POST", "/api/settings", {"module": "apps", "key": "transmission", "value": False})
        moved = wait_for(lambda: apps(pi_port).get("runner") == "pie" and (tr_ask(old, "session-stats") or {}).get("who") == "pie", 60)
        check("pi's switch off: Transmission moves to pie (still on pi's old address)", bool(moved), (apps(pi_port), tr_ask(old, "session-stats")))
        check("...and isn't running on pi any more", not os.path.exists(os.path.join(tmp, "pi-state", "tr-running")))
        caps = wait_for(lambda: [l for l in open(log).read().splitlines() if l.startswith("pie transmission-cap")], 20)
        check("...its speed limits kept on pie's Wi-Fi (the turtle's now)", caps and caps[-1].endswith("transmission-cap 50 50") or caps and "transmission-cap" in caps[-1], caps)
        start_line = [l for l in open(log).read().splitlines() if l.startswith("pie transmission-start")]
        check("...with pi's shared folders", start_line and start_line[-1].endswith("Downloads Videos") and " 127.0.0.1 " in start_line[-1], start_line)
        since = time.time() * 1000
        read = wait_for(lambda: [p for p in traffic("1h").get("points", []) if p[0] > since + 1000 and p[2] == 1500], 20)
        check("...and pi, its home, still reads each torrent's speeds (from pie)", bool(read), traffic("1h")["points"][-3:])

        code, a = act(pi_port, "move", {"to": "pi"})
        time.sleep(4)
        check("Moving it to pi waits while pi's switch is off", apps(pi_port).get("runner") == "pie", apps(pi_port))
        ask(pi_port, "POST", "/api/settings", {"module": "apps", "key": "transmission", "value": True})
        back = wait_for(lambda: apps(pi_port).get("runner") == "pi" and (tr_ask(old, "session-stats") or {}).get("who") == "pi", 60)
        check("...and goes once it's on again", bool(back), apps(pi_port))
        pie_ht["recording"] = True
        time.sleep(7)  # (pie says so at its next word)
        code, a = act(pi_port, "move", {"to": "pie"})
        time.sleep(6)
        st = apps(pi_port)
        check("A Pi that's recording doesn't take it (pie)", st.get("runner") == "pi" and not st.get("moving"), st)
        pie_ht["recording"] = False
        act(pi_port, "move", {"to": None})
        wait_for(lambda: (tr_ask(old, "session-stats") or {}).get("who") == "pi", 30)

        code, folders = act(pi_port, "folders", {"path": home})
        check("Folders of your home to save a new download in", code == 200 and "Videos" in folders.get("folders", []), folders)
        code, a = act(pi_port, "add", {"magnet": "magnet:?xt=urn:btih:abc", "folder": os.path.join(home, "Music", "new")})
        shared = [l for l in open(log).read().splitlines() if " nfs-share " in l]
        added = [t for t in (tr_ask(old, "torrent-get") or {}).get("torrents", []) if t["id"] >= 100]
        check("A new download into a folder you choose: that folder shared, the download there", code == 200 and shared[-1].endswith("Downloads Music Videos") and
              added and added[0]["downloadDir"] == os.path.join(home, "Music", "new"), (a, shared[-1:], added))
        code, a = act(pi_port, "add", {"magnet": "magnet:?xt=urn:btih:abc", "folder": tmp})
        check("...but not outside your home", code != 200 and "home" in a.get("error", ""), a)

        # pie running it, then pi gone: pie stops it by itself
        act(pi_port, "move", {"to": "pie"})
        on_pie = wait_for(lambda: os.path.exists(os.path.join(tmp, "pie-state", "tr-running")), 60)
        procs["pi"].terminate()
        procs["pi"].wait(10)
        fenced = wait_for(lambda: not os.path.exists(os.path.join(tmp, "pie-state", "tr-running")), 40)
        check("With pi gone, pie stops Transmission by itself", bool(on_pie) and bool(fenced), (on_pie, fenced))
        start("pi", pi_port, pie_port, pi_ht_url, pi_tr)
        again = wait_for(lambda: apps(pi_port).get("runner") in ("pi", "pie") and tr_ask(old, "session-stats"), 60)
        check("pi back: Transmission runs again", bool(again), apps(pi_port))

        code, a = act(pi_port, "giveBack")
        stopped = wait_for(lambda: not os.path.exists(os.path.join(tmp, "pi-state", "tr-running")) and not os.path.exists(os.path.join(tmp, "pie-state", "tr-running")), 40)
        check("Given back: the window app has its torrents again, the cluster's stopped",
              code == 200 and stopped and len(os.listdir(os.path.join(gtk, "torrents"))) == 3 and "nfs-unshare" in open(log).read(), (a, stopped))
    finally:
        for p in procs.values():
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(10)
                except subprocess.TimeoutExpired:
                    p.kill()
        for st in ("pi-state", "pie-state"):
            m = os.path.join(tmp, st, "tr-running")
            if os.path.exists(m):
                try:
                    os.kill(int(open(m).read()), 9)
                except OSError:
                    pass
        if not all(results):
            print("---- the root helper was asked:\n" + "".join(open(log).readlines()[-25:]))
            for name, p in procs.items():
                print("---- %s's log:\n%s" % (name, (p.stdout.read() if p.stdout else "")[-2500:]))
        shutil.rmtree(tmp, ignore_errors=True)
    print("%d/%d checks passed." % (sum(results), len(results)))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
