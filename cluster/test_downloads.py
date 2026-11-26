#!/usr/bin/env python3
"""
test_downloads.py - checks Cluster's downloads on other computers (cluster/node/modules/downloads.py) on any computer:
  python3 cluster/test_downloads.py

Three computers are simulated: "pi" (it keeps the cluster's Transmission's files: the home), "pie" and "rhubarb", each
with a stand-in Hand Tracker (so it can be "recording"). Stand-in Transmissions (the cluster's on pi, and each other
computer's own) download from a stand-in swarm (a folder with each test torrent's files) at a steady pace, and a
stand-in pieces.py does a part by pieces the same way. Checked:
- each computer saying how it is (free, room, network), and the home listing them;
- a download on "the computer with the most free network": that computer's own Transmission started for it, the
  download copied to pi, pi's Transmission checking it and seeding it, the computer's copy deleted;
- a torrent split by files between two computers, copied one at a time, joined on pi (an empty file too), the
  computers keeping on seeding it; then handed to pi;
- a magnet link split by files (its file list fetched first, on one computer);
- a big file split by pieces (pieces.py on each), its parts written into one file on pi;
- pausing and going on; a computer that's recording waits; a download removed (the copies deleted);
- what's refused (the same torrent twice, a folder outside the home, a name pi already has, a piece out of turn);
- pi itself chosen when its own network's the least busy (straight into its Transmission).
"""

import base64
import hashlib
import http.server
import json
import os
import random
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
T0 = time.time()


def check(name, ok, detail=""):
    results.append(bool(ok))
    print("%s  [%4ds] %s%s" % ("PASS" if ok else "FAIL", time.time() - T0, name, "" if ok else "  (%s)" % str(detail)[:700]), flush=True)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


# ----- torrents for the checks -----
def bencode(v):
    if isinstance(v, int):
        return b"i%de" % v
    if isinstance(v, str):
        v = v.encode()
    if isinstance(v, bytes):
        return b"%d:%s" % (len(v), v)
    if isinstance(v, list):
        return b"l" + b"".join(bencode(x) for x in v) + b"e"
    return b"d" + b"".join(bencode(k) + bencode(v[k]) for k in sorted(v, key=lambda k: k.encode() if isinstance(k, str) else k)) + b"e"


def content(seed, n):
    # (the same bytes for the same seed each time; quick for big files too)
    return random.Random(seed).randbytes(n)


def make_torrent(swarm, name, files, pl=262144, pads=()):
    """files: [(path under name, or None for a single-file torrent, bytes)] -> (its .torrent, its hash, [[name, length]]).
    pads: which of them are padding files (BEP 47, as a v2 hybrid has: zeros, attr "p")."""
    datas = [b"\0" * n if i in pads else content(name + str(p), n) for i, (p, n) in enumerate(files)]
    blob = b"".join(datas)
    pieces = b"".join(hashlib.sha1(blob[i:i + pl]).digest() for i in range(0, len(blob), pl))
    info = {"name": name, "piece length": pl, "pieces": pieces}
    if files[0][0] is None:
        info["length"] = len(blob)
        rels = [name]
    else:
        info["files"] = [dict({"length": n, "path": p.split("/")}, **({"attr": "p"} if i in pads else {})) for i, (p, n) in enumerate(files)]
        rels = [name + "/" + p for p, _ in files]
    raw = bencode({"announce": "http://tracker.invalid/announce", "info": info})
    h = hashlib.sha1(bencode(info)).hexdigest()
    for rel, d in zip(rels, datas):
        path = os.path.join(swarm, h, *rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "wb").write(d)
    open(os.path.join(swarm, h + ".torrent"), "wb").write(raw)
    return raw, h, [[r, len(d)] for r, d in zip(rels, datas)]


BDECODE = r'''
import hashlib
def bdecode(data):
    pos = 0
    span = [None]
    def val(depth):
        nonlocal pos
        c = data[pos:pos + 1]
        if c == b"i":
            end = data.index(b"e", pos); n = int(data[pos + 1:end]); pos = end + 1; return n
        if c in (b"l", b"d"):
            pos += 1
            out = [] if c == b"l" else {}
            while data[pos:pos + 1] != b"e":
                if c == b"l":
                    out.append(val(depth + 1))
                else:
                    k = val(depth + 1); start = pos; v = val(depth + 1)
                    if depth == 0 and k == b"info":
                        span[0] = (start, pos)
                    out[k] = v
            pos += 1
            return out
        colon = data.index(b":", pos); n = int(data[pos:colon]); pos = colon + 1 + n; return data[colon + 1:pos]
    v = val(0)
    return v, span[0]
def parse(raw):
    top, span = bdecode(raw)
    info = top[b"info"]
    name = info[b"name"].decode()
    if b"files" in info:
        files = [[name + "/" + "/".join(p.decode() for p in f[b"path"]), f[b"length"]] for f in info[b"files"]]
    else:
        files = [[name, info[b"length"]]]
    return hashlib.sha1(raw[span[0]:span[1]]).hexdigest(), name, files, info[b"piece length"]
'''

# A stand-in Transmission: torrents from a .torrent's bytes or a magnet link (its file list from the swarm a second
# later), each wanted file "downloaded" from the swarm at RATE (as Transmission does: <name>.part until it's all there),
# files wanted or not, paused or not, removed (its files too, if asked), and checked against the swarm when asked.
FAKE_TR = BDECODE + r'''
import base64, http.server, json, os, sys, threading, time, urllib.parse
port, config, who, swarm = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
RATE = 800000
STATE = os.path.join(config, "fake-state.json")
lock = threading.Lock()
os.makedirs(os.path.join(config, "torrents"), exist_ok=True)
def load():
    try:
        return json.load(open(STATE))
    except Exception:
        return {"torrents": {}, "next": 1}
def save(s):
    json.dump(s, open(STATE + ".new", "w")); os.replace(STATE + ".new", STATE)
def src(h, rel):
    return os.path.join(swarm, h, *rel.split("/"))
def local(t, rel):
    return os.path.join(t["dir"], *rel.split("/"))
def write(t, i, at, n):
    rel = t["files"][i][0]
    path = local(t, rel) + ".part"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(src(t["hash"], rel), "rb") as f:
        f.seek(at); data = f.read(n)
    with open(path, "r+b" if os.path.exists(path) else "wb") as f:
        f.seek(at); f.write(data)
def complete(t):
    return all(t["done"][i] >= ln for i, (_, ln) in enumerate(t["files"]) if t["wanted"][i])
def advance(s):
    now = time.time()
    for h, t in s["torrents"].items():
        dt, t["at"] = now - t.get("at", now), now
        if t.get("checkUntil"):
            if now < t["checkUntil"]:
                continue
            t["checkUntil"] = None
            t["status"] = 0 if t["paused"] else (6 if complete(t) else 4)
        if not t["meta"]:
            tf = os.path.join(swarm, h + ".torrent")
            if not t["paused"] and now - t["added"] > 1 and os.path.exists(tf):
                raw = open(tf, "rb").read()
                _, name, files, pl = parse(raw)
                open(os.path.join(config, "torrents", h + ".torrent"), "wb").write(raw)
                t.update(meta=True, name=name, files=files, wanted=[True] * len(files), done=[0] * len(files), status=4)
            continue
        if t["status"] != 4:
            continue
        budget = int(RATE * dt)
        for i, (rel, ln) in enumerate(t["files"]):
            if not t["wanted"][i] or t["done"][i] >= ln and os.path.exists(local(t, rel)):
                continue
            n = min(budget, ln - t["done"][i])
            if n > 0:
                write(t, i, t["done"][i], n)
                t["done"][i] += n
                budget -= n
            if t["done"][i] >= ln:
                part = local(t, rel) + ".part"
                if not os.path.exists(part):
                    os.makedirs(os.path.dirname(part), exist_ok=True)
                    open(part, "wb").close()
                os.replace(part, local(t, rel))
            if budget <= 0:
                break
        if complete(t) and all(os.path.exists(local(t, rel)) for i, (rel, _) in enumerate(t["files"]) if t["wanted"][i]):
            t["status"] = 6
def view(t):
    want = [ln for i, (_, ln) in enumerate(t["files"]) if t["wanted"][i]]
    have = sum(min(t["done"][i], ln) for i, (_, ln) in enumerate(t["files"]) if t["wanted"][i])
    size = sum(want)
    return {"id": t["id"], "hashString": t["hash"], "name": t["name"], "status": t["status"], "downloadDir": t["dir"],
            "percentDone": (have / size) if size else (1.0 if t["meta"] else 0.0), "sizeWhenDone": size, "leftUntilDone": size - have,
            "rateDownload": RATE if t["status"] == 4 and t["meta"] else 0, "rateUpload": 1000 if t["status"] == 6 else 0, "eta": -1,
            "peersConnected": 3, "errorString": "", "metadataPercentComplete": 1 if t["meta"] else 0,
            "torrentFile": os.path.join(config, "torrents", t["hash"] + ".torrent") if t["meta"] else "",
            "wanted": [bool(w) for w in t["wanted"]], "files": [{"name": r, "length": ln, "bytesCompleted": t["done"][i]} for i, (r, ln) in enumerate(t["files"])],
            "uploadedEver": 5000, "downloadedEver": have, "addedDate": int(t["added"]), "queuePosition": t["id"], "recheckProgress": 0.5 if t.get("checkUntil") else 0}
def pick(s, ids):
    if ids is None:
        return list(s["torrents"].values())
    ids = ids if isinstance(ids, list) else [ids]
    return [t for t in s["torrents"].values() if t["id"] in ids or t["hash"] in ids]
def files_set(t, a):
    n = len(t["files"])
    if "files-wanted" in a:
        for i in (a["files-wanted"] or range(n)):
            t["wanted"][i] = True
    if "files-unwanted" in a:
        for i in (a["files-unwanted"] or range(n)):
            t["wanted"][i] = False
    if t["status"] == 6 and not complete(t):
        t["status"] = 4
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        if self.headers.get("X-Transmission-Session-Id") != "sid":
            self.send_response(409); self.send_header("X-Transmission-Session-Id", "sid"); self.send_header("Content-Length", "0"); self.end_headers(); return
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
        m, a = req.get("method"), req.get("arguments") or {}
        res = {}
        with lock:
            s = load()
            advance(s)
            if m == "session-get":
                res = {"version": "fake", "who": who}
            elif m == "session-stats":
                res = {"torrentCount": len(s["torrents"]), "downloadSpeed": 0, "uploadSpeed": 0, "who": who}
            elif m == "torrent-get":
                got = [view(t) for t in pick(s, a.get("ids"))]
                fields = a.get("fields")
                res = {"torrents": [{k: v for k, v in g.items() if not fields or k in fields} for g in got]}
            elif m == "torrent-add":
                if a.get("metainfo"):
                    raw = base64.b64decode(a["metainfo"])
                    h, name, files, pl = parse(raw)
                    meta = True
                else:
                    q = urllib.parse.parse_qs(urllib.parse.urlsplit(a["filename"]).query)
                    h, name, files, meta, raw = q["xt"][0][9:].lower(), (q.get("dn") or ["magnet"])[0], [], False, None
                if h in s["torrents"]:
                    t = s["torrents"][h]
                    res = {"torrent-duplicate": {"id": t["id"], "name": t["name"], "hashString": h}}
                else:
                    if raw:
                        open(os.path.join(config, "torrents", h + ".torrent"), "wb").write(raw)
                    paused = bool(a.get("paused"))
                    t = {"id": s["next"], "hash": h, "name": name, "files": files, "meta": meta, "wanted": [True] * len(files), "done": [0] * len(files),
                         "dir": a.get("download-dir") or config, "paused": paused, "status": 0 if paused else 4, "added": time.time(), "at": time.time()}
                    files_set(t, a)
                    s["next"] += 1
                    s["torrents"][h] = t
                    res = {"torrent-added": {"id": t["id"], "name": name, "hashString": h}}
            elif m == "torrent-set":
                for t in pick(s, a.get("ids")):
                    files_set(t, a)
            elif m in ("torrent-start", "torrent-stop"):
                for t in pick(s, a.get("ids")):
                    t["paused"] = m == "torrent-stop"
                    if not t.get("checkUntil"):
                        t["status"] = 0 if t["paused"] else (6 if t["meta"] and complete(t) else 4)
            elif m == "torrent-verify":
                for t in pick(s, a.get("ids")):
                    for i, (rel, ln) in enumerate(t["files"]):
                        try:
                            same = open(local(t, rel), "rb").read() == open(src(t["hash"], rel), "rb").read()
                        except OSError:
                            same = False
                        t["done"][i] = ln if same else 0
                    t["status"] = 2
                    t["checkUntil"] = time.time() + 1
            elif m == "torrent-remove":
                for t in pick(s, a.get("ids")):
                    if a.get("delete-local-data"):
                        for rel, _ in t["files"]:
                            for p in (local(t, rel), local(t, rel) + ".part"):
                                if os.path.exists(p):
                                    os.remove(p)
                    del s["torrents"][t["hash"]]
            save(s)
        body = json.dumps({"result": "success", "arguments": res}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
'''

# The stand-in pieces.py: the pieces from FIRST up to END "downloaded" from the swarm, in four steps, into the files
# where the torrent puts them; then it seeds them until it's stopped.
FAKE_PIECES = BDECODE + r'''
import json, os, sys, time
args = sys.argv[1:]
if "--port" in args:
    i = args.index("--port"); del args[i:i + 2]
tfile, folder, first, end, state = args[0], args[1], int(args[2]), int(args[3]), args[4]
raw = open(tfile, "rb").read()
h, name, files, pl = parse(raw)
swarm = os.environ["HT_TEST_SWARM"]
total = sum(ln for _, ln in files)
b0, b1 = first * pl, min(end * pl, total)
def control():
    try:
        return json.load(open(os.path.join(state, "control.json")))
    except Exception:
        return {}
def status(**k):
    json.dump(dict(k, of=end - first, down=500000, up=0, peers=2, error=""), open(os.path.join(state, "status.json.new"), "w"))
    os.replace(os.path.join(state, "status.json.new"), os.path.join(state, "status.json"))
def put(lo, hi):
    pos = 0
    for rel, ln in files:
        s, e = max(lo, pos), min(hi, pos + ln)
        if s < e:
            path = os.path.join(folder, *rel.split("/"))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(os.path.join(swarm, h, *rel.split("/")), "rb") as f:
                f.seek(s - pos); data = f.read(e - s)
            with open(path, "r+b" if os.path.exists(path) else "wb") as f:
                f.seek(s - pos); f.write(data)
        pos += ln
steps, k = 4, 0
while k < steps:
    c = control()
    if c.get("stop"):
        sys.exit(0)
    if not c.get("paused"):
        put(b0 + (b1 - b0) * k // steps, b0 + (b1 - b0) * (k + 1) // steps)
        k += 1
    status(have=(end - first) * k // steps, done=False)
    time.sleep(0.6)
while not control().get("stop"):
    status(have=end - first, done=True)
    time.sleep(1)
'''

FAKE_HELPER = r'''
import json, os, subprocess, sys, time
job, words = sys.argv[1], sys.argv[2:]
state = os.environ["HT_CLUSTER_STATE"]
with open(os.environ["HT_TEST_HELPER_LOG"], "a") as f:
    f.write("%s %s %s\n" % (os.environ.get("HT_CLUSTER_SIM_NAME"), job, " ".join(words)))
def stop(marker):
    if os.path.exists(marker):
        try: os.kill(int(open(marker).read()), 9)
        except OSError: pass
        os.remove(marker)
def launch(marker, port, config, who):
    stop(marker)
    os.makedirs(config, exist_ok=True)
    p = subprocess.Popen([sys.executable, os.environ["HT_TEST_FAKE_TR"], port, config, who, os.environ["HT_TEST_SWARM"]],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.7)
    open(marker, "w").write(str(p.pid))
if job == "transmission-start":
    launch(os.path.join(state, "tr-running"), os.environ["HT_CLUSTER_TR_PORT"], os.environ["HT_CLUSTER_TR_CONFIG"], os.environ["HT_CLUSTER_SIM_NAME"])
    print(json.dumps({"ok": True, "started": words[0]}))
elif job == "transmission-stop":
    stop(os.path.join(state, "tr-running"))
    print(json.dumps({"ok": True}))
elif job == "own-transmission-start":
    s = json.load(open(os.path.join(os.environ["HT_CLUSTER_OWN_TR_CONFIG"], "settings.json")))
    launch(os.path.join(state, "own-tr-running"), str(s["rpc-port"]), os.environ["HT_CLUSTER_OWN_TR_CONFIG"], os.environ["HT_CLUSTER_SIM_NAME"] + "-own")
    print(json.dumps({"ok": True, "started": True}))
elif job == "own-transmission-stop":
    stop(os.path.join(state, "own-tr-running"))
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


def ask(port, method, path, body=None, data=None):
    h = {"X-HT-Cluster": "1", "Host": "127.0.0.1:%d" % port}
    payload = None
    if body is not None:
        payload = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    elif data is not None:
        payload = data
        h["Content-Type"] = "application/octet-stream"
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), data=payload, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")
    except OSError as e:
        return None, {"error": str(e)}


def dl(port, action, args=None):
    return ask(port, "POST", "/api/action", {"module": "downloads", "action": action, "args": args or {}})


def module_status(port, name):
    code, d = ask(port, "GET", "/api/node")
    return next((m for m in (d or {}).get("modules", []) if m["name"] == name), {}).get("status") or {} if code == 200 else {}


def tr_ask(port, method, args=None):
    url = "http://127.0.0.1:%d/transmission/rpc" % port
    body = json.dumps({"method": method, "arguments": args or {}}).encode()
    sid = ""
    for _ in range(2):
        req = urllib.request.Request(url, body, {"Content-Type": "application/json", "X-Transmission-Session-Id": sid})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.loads(r.read())["arguments"]
        except urllib.error.HTTPError as e:
            if e.code != 409:
                return None
            sid = e.headers.get("X-Transmission-Session-Id", "")
        except OSError:
            return None
    return None


def wait_for(fn, seconds=60, every=0.5):
    until = time.time() + seconds
    while time.time() < until:
        try:
            v = fn()
            if v:
                return v
        except (OSError, ValueError, KeyError, TypeError, IndexError):
            pass
        time.sleep(every)
    return None


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    tmp = tempfile.mkdtemp(prefix="ht-downloads-test-")
    home = os.path.join(tmp, "home")
    gtk = os.path.join(home, ".config", "transmission")
    config = os.path.join(tmp, "cluster-tr")  # (the cluster's Transmission's settings: on pi)
    swarm = os.path.join(tmp, "swarm")
    for d in (os.path.join(gtk, "torrents"), os.path.join(gtk, "resume"), os.path.join(home, "Videos"), os.path.join(home, "Downloads"), swarm):
        os.makedirs(d)
    json.dump({"download-dir": os.path.join(home, "Downloads"), "rpc-port": 9092}, open(os.path.join(gtk, "settings.json"), "w"))
    for name, text in (("fake-tr.py", FAKE_TR), ("fake-helper.py", FAKE_HELPER), ("fake-pieces.py", FAKE_PIECES)):
        with open(os.path.join(tmp, name), "w") as f:
            f.write(text)
    log = os.path.join(tmp, "helper.log")
    open(log, "w").close()
    ports = {n: free_port() for n in ("pi", "pie", "rhubarb")}
    hts = {n: fake_ht() for n in ports}
    pi_tr, old = free_port(), free_port()
    procs = {}
    nets = {"pi": 900000, "pie": 300000, "rhubarb": 5000}

    def start(name, **extra):
        peers = ",".join("127.0.0.1:%d" % p for n, p in ports.items() if n != name)
        env = dict(os.environ, HT_CLUSTER_SIM_NAME=name, HT_CLUSTER_SIM_PEERS=peers, HT_CLUSTER_STATE=os.path.join(tmp, name + "-state"),
                   HT_CLUSTER_JOBS_DIR=os.path.join(tmp, name + "-jobs"), HT_CLUSTER_HT_URL=hts[name][1], HT_CLUSTER_ROOT_HELPER=os.path.join(tmp, "fake-helper.py"),
                   HT_TEST_HELPER_LOG=log, HT_TEST_FAKE_TR=os.path.join(tmp, "fake-tr.py"), HT_TEST_SWARM=swarm, HT_CLUSTER_TR_PORT=str(pi_tr),
                   HT_CLUSTER_TR_CONFIG=config, HT_CLUSTER_TR_OLD_PORT=str(old), HT_CLUSTER_SIM_GTK=gtk, HT_CLUSTER_SIM_HOME=home,
                   HT_CLUSTER_OWN_TR_PORT=str(free_port()), HT_CLUSTER_OWN_TR_CONFIG=os.path.join(tmp, name + "-own"),
                   HT_CLUSTER_OWN_DOWNLOADS=os.path.join(tmp, name + "-downloads"), HT_CLUSTER_SIM_ROOM=str(100 * 10 ** 9),
                   HT_CLUSTER_SIM_NET=str(nets[name]), HT_CLUSTER_SIM_PIECES="1", HT_CLUSTER_SIM_PIECES_SCRIPT=os.path.join(tmp, "fake-pieces.py"),
                   HT_CLUSTER_SIM_FAST="1", PYTHONDONTWRITEBYTECODE="1", **extra)
        p = subprocess.Popen([sys.executable, os.path.join(NODE, "ht_cluster.py"), "--simulate", "--port", str(ports[name])], env=env,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
        procs[name] = p
        wait_for(lambda: ask(ports[name], "GET", "/api/node")[0] == 200, 20)

    pi = ports["pi"]
    listing = lambda: dl(pi, "list")[1]
    entry = lambda did: next((d for d in listing().get("downloads", []) if d["id"] == did), None)
    cluster_has = lambda h: next((t for t in (tr_ask(pi_tr, "torrent-get", {"fields": ["hashString", "percentDone", "status", "downloadDir"]}) or {}).get("torrents", [])
                                  if t["hashString"] == h), None)
    own_port = lambda name: json.load(open(os.path.join(tmp, name + "-own", "settings.json")))["rpc-port"]
    own_has = lambda name, h: next((t for t in (tr_ask(own_port(name), "torrent-get", {}) or {}).get("torrents", []) if t["hashString"] == h), None)
    same = lambda a, b: os.path.exists(a) and os.path.exists(b) and open(a, "rb").read() == open(b, "rb").read()
    movies = os.path.join(home, "Videos", "movies")
    b64 = lambda raw: base64.b64encode(raw).decode()
    try:
        for n in ports:
            start(n)
        ask(pi, "POST", "/api/settings", {"module": "apps", "key": "home", "value": True})
        wait_for(lambda: module_status(pi, "apps").get("home"), 10)
        code, a = ask(pi, "POST", "/api/action", {"module": "apps", "action": "migrate", "args": {}})
        # (whichever Pi is free runs it: pi itself, or pie or rhubarb if their word reached pi first)
        running = wait_for(lambda: module_status(pi, "apps").get("runner") in ports and tr_ask(pi_tr, "session-stats"), 40)
        check("pi keeps the cluster's Transmission's files, and it runs on a free computer", code == 200 and bool(running), (a, module_status(pi, "apps")))

        seen = wait_for(lambda: {c["name"]: c for c in listing().get("computers", []) if c.get("heard")}.keys() >= {"pie", "rhubarb", "pi"} and listing()["computers"], 40) or []
        byname = {c["name"]: c for c in seen}
        check("Each other computer says how it is: ready, free, its room and how busy its network is (the home too)",
              byname.get("rhubarb", {}).get("ready") and byname["rhubarb"].get("free") and byname["rhubarb"].get("net") == 5000 and
              byname.get("pie", {}).get("room") == 100 * 10 ** 9 and byname.get("pi", {}).get("home") and byname["pi"].get("net") == 900000, seen)

        # 1. On the computer with the most free network; then pi takes it over
        raw1, h1, files1 = make_torrent(swarm, "Movie One.mkv", [(None, 2500000)])
        code, a = dl(pi, "add", {"torrent": b64(raw1), "folder": movies, "where": "freest", "after": "home"})
        e1 = entry(a.get("id")) if code == 200 else None
        check("A download on the computer with the most free network goes to rhubarb (its network the least busy)",
              code == 200 and e1 and [p["device"] for p in e1["parts"]] == ["rhubarb"] and "least busy" in a.get("message", ""), a)
        own = wait_for(lambda: os.path.exists(os.path.join(tmp, "rhubarb-state", "own-tr-running")) and own_has("rhubarb", h1), 30)
        s = json.load(open(os.path.join(tmp, "rhubarb-own", "settings.json")))
        check("...rhubarb's own Transmission starts for it (peers on 51415; DHT, uTP and local peers off; few peers), and has it",
              bool(own) and s.get("peer-port") == 51415 and s.get("dht-enabled") is False and s.get("utp-enabled") is False and
              s.get("lpd-enabled") is False and s.get("peer-limit-global") == 40 and s.get("rpc-whitelist") == "127.0.0.1,::1", s)
        states = set()
        gone = wait_for(lambda: (states.add((entry(e1["id"]) or {}).get("state")), entry(e1["id"]) is None)[1], 90)
        t = cluster_has(h1)
        check("...downloaded there, copied to pi, then pi's Transmission checks its copy and seeds it",
              bool(gone) and t and t["percentDone"] == 1 and t["status"] == 6 and t["downloadDir"] == movies and {"downloading", "checking"} <= states, (states, t))
        check("...pi's copy is the torrent's file, byte for byte", same(os.path.join(movies, "Movie One.mkv"), os.path.join(swarm, h1, "Movie One.mkv")))
        deleted = wait_for(lambda: not own_has("rhubarb", h1) and not os.path.exists(os.path.join(tmp, "rhubarb-downloads", e1["id"])), 30)
        check("...and once pi has all of it, rhubarb's copy is deleted", bool(deleted), os.listdir(os.path.join(tmp, "rhubarb-downloads")))

        # 2. Split by files between two computers, kept seeding there; then handed to pi
        raw2, h2, files2 = make_torrent(swarm, "Show S01", [("e1.mkv", 1200000), ("e2.mkv", 900000), ("e3.mkv", 700000), ("extras/notes.txt", 0), ("e1.srt", 20000)])
        shows = os.path.join(home, "Videos", "shows")
        code, a = dl(pi, "add", {"torrent": b64(raw2), "folder": shows, "where": "freest", "split": "files", "after": "keep"})
        e2 = entry(a.get("id")) if code == 200 else None
        parts = {p["device"]: p for p in (e2 or {}).get("parts", [])}
        check("Split by files: its files shared out between rhubarb and pie (the biggest first, to the one with less so far)",
              code == 200 and set(parts) == {"rhubarb", "pie"} and sorted(p["files"] for p in parts.values()) == [2, 3], (a, e2))
        most = [0]

        def seeding():
            d = entry(e2["id"]) or {}
            most[0] = max(most[0], sum(1 for p in d.get("parts", []) if p.get("turn")))
            return d.get("state") == "seeding" and d
        d2 = wait_for(seeding, 120, 0.2)
        check("...downloaded on both, copied to pi one computer at a time, joined there", bool(d2) and most[0] <= 1, (d2, most))
        check("...every file on pi as the torrent has it (its empty one too)",
              all(same(os.path.join(shows, *rel.split("/")), os.path.join(swarm, h2, *rel.split("/"))) for rel, _ in files2) and
              os.path.getsize(os.path.join(shows, "Show S01", "extras", "notes.txt")) == 0, os.listdir(os.path.join(shows, "Show S01")))
        time.sleep(3)
        check("...and both computers keep seeding it (pi has its copy, not in its Transmission)",
              own_has("rhubarb", h2) and own_has("pie", h2) and not cluster_has(h2) and (entry(e2["id"]) or {}).get("state") == "seeding", entry(e2["id"]))
        code, a = dl(pi, "after", {"id": e2["id"], "after": "home"})
        handed = wait_for(lambda: entry(e2["id"]) is None and (cluster_has(h2) or {}).get("percentDone") == 1, 60)
        dropped = wait_for(lambda: not own_has("rhubarb", h2) and not own_has("pie", h2), 30)
        check("Handed to pi later: its Transmission checks it and seeds it, then the computers' copies are deleted", code == 200 and bool(handed) and bool(dropped), a)

        # 3. A magnet link split by files: its file list first (on one computer), then shared out
        raw3, h3, files3 = make_torrent(swarm, "Album", [("01.flac", 600000), ("02.flac", 500000), ("03.flac", 400000), ("cover.jpg", 90000)])
        music = os.path.join(home, "Music")
        code, a = dl(pi, "add", {"magnet": "magnet:?xt=urn:btih:%s&dn=Album" % h3, "folder": music, "where": "freest", "split": "files", "after": "home"})
        e3 = entry(a.get("id")) if code == 200 else None
        check("A magnet link split by files: its file list fetched first, on one computer", code == 200 and e3 and e3["state"] == "metadata" and len(e3["parts"]) == 1, (a, e3))
        split3 = wait_for(lambda: (entry(e3["id"]) or {}).get("state") == "downloading" and len(entry(e3["id"])["parts"]) == 2 and entry(e3["id"]), 40)
        done3 = wait_for(lambda: entry(e3["id"]) is None and (cluster_has(h3) or {}).get("percentDone") == 1, 120)
        check("...then shared out between the two, copied, and taken over by pi",
              bool(split3) and bool(done3) and all(same(os.path.join(music, *r.split("/")), os.path.join(swarm, h3, *r.split("/"))) for r, _ in files3), (split3, entry(e3["id"])))

        # 4. A big file split by pieces (pieces.py on each computer)
        raw4, h4, files4 = make_torrent(swarm, "Big Film.mkv", [(None, 3000000)], pl=65536)
        code, a = dl(pi, "add", {"torrent": b64(raw4), "folder": movies, "where": "freest", "split": "pieces", "after": "home"})
        e4 = entry(a.get("id")) if code == 200 else None
        ranges = sorted(p["pieces"] for p in (e4 or {}).get("parts", []))
        check("Split by pieces: half the pieces each (pieces.py on each computer)", code == 200 and ranges == [[0, 23], [23, 46]], (a, e4))
        done4 = wait_for(lambda: entry(e4["id"]) is None and (cluster_has(h4) or {}).get("percentDone") == 1, 120)
        check("...each part written into the one file on pi, which pi's Transmission checks and seeds",
              bool(done4) and same(os.path.join(movies, "Big Film.mkv"), os.path.join(swarm, h4, "Big Film.mkv")), entry(e4["id"]))
        stopped = wait_for(lambda: not os.path.exists(os.path.join(tmp, "pie-downloads", e4["id"] + ".p")) and
                           not os.path.exists(os.path.join(tmp, "rhubarb-downloads", e4["id"] + ".p")), 30)
        check("...and the computers' parts are deleted once pi has it all", bool(stopped))

        # 4b. A v2 hybrid (padding files, BEP 47) split by pieces: the padding files aren't copied, pi makes them (zeros)
        # (the user, 2026-11-25: "That torrent has padding files (a v2 hybrid): download it whole." was refused before)
        raw7, h7, files7 = make_torrent(swarm, "Hybrid", [("film.mkv", 100000), (".pad/31072", 31072), ("film.srt", 5000)], pl=65536, pads=(1,))
        code, a = dl(pi, "add", {"torrent": b64(raw7), "folder": movies, "where": "freest", "split": "pieces", "after": "home"})
        e7 = entry(a.get("id")) if code == 200 else None
        done7 = wait_for(lambda: entry(e7["id"]) is None and (cluster_has(h7) or {}).get("percentDone") == 1, 120) if e7 else None
        pad7 = os.path.join(movies, "Hybrid", ".pad", "31072")
        check("A v2 hybrid (padding files) split by pieces: its files copied to pi, its padding files made there (zeros)",
              code == 200 and bool(done7) and all(same(os.path.join(movies, *r.split("/")), os.path.join(swarm, h7, *r.split("/"))) for r, _ in files7)
              and os.path.getsize(pad7) == 31072 and open(pad7, "rb").read() == b"\0" * 31072, (a, e7 and entry(e7["id"])))

        # 5. Paused, going on, waiting while a computer records, removed
        raw5, h5, files5 = make_torrent(swarm, "Long One.mkv", [(None, 60000000)])
        code, a = dl(pi, "add", {"torrent": b64(raw5), "folder": movies, "where": "pie", "after": "home"})
        e5 = entry(a.get("id")) if code == 200 else None
        going = wait_for(lambda: (own_has("pie", h5) or {}).get("status") == 4, 30)
        dl(pi, "pause", {"id": e5["id"], "paused": True})
        paused = wait_for(lambda: (own_has("pie", h5) or {}).get("status") == 0, 20)
        dl(pi, "pause", {"id": e5["id"], "paused": False})
        again = wait_for(lambda: (own_has("pie", h5) or {}).get("status") == 4, 20)
        check("Chosen by name (pie); paused, and going on again", code == 200 and bool(going) and bool(paused) and bool(again), (a, own_has("pie", h5)))
        hts["pie"][0]["recording"] = True
        waits = wait_for(lambda: (own_has("pie", h5) or {}).get("status") == 0 and any(p["free"] is False for p in entry(e5["id"])["parts"]), 30)
        hts["pie"][0]["recording"] = False
        on = wait_for(lambda: (own_has("pie", h5) or {}).get("status") == 4, 30)
        check("A computer that's recording pauses its downloads, and goes on after", bool(waits) and bool(on), entry(e5["id"]))
        code, a = dl(pi, "remove", {"id": e5["id"]})
        removed = wait_for(lambda: entry(e5["id"]) is None and not own_has("pie", h5) and not os.path.exists(os.path.join(tmp, "pie-downloads", e5["id"])), 30)
        check("Removed: off the list, pie's copy deleted", code == 200 and bool(removed), a)

        # 6. What's refused
        raw6, h6, _ = make_torrent(swarm, "Twice.mkv", [(None, 40000000)])
        code, a = dl(pi, "add", {"torrent": b64(raw6), "folder": movies, "where": "rhubarb"})
        code2, a2 = dl(pi, "add", {"torrent": b64(raw6), "folder": movies, "where": "pie"})
        code3, a3 = dl(pi, "add", {"torrent": b64(raw6), "folder": tmp, "where": "pie"})
        code4, a4 = dl(pi, "add", {"torrent": b64(raw1), "folder": movies, "where": "pie"})
        check("Refused: the same torrent twice, a folder outside the home, a torrent pi has already",
              code == 200 and code2 != 200 and "already" in a2.get("error", "") and code3 != 200 and "home" in a3.get("error", "") and
              code4 != 200 and "already" in a4.get("error", ""), (a2, a3, a4))
        code5, a5 = ask(pi, "PUT", "/api/downloads/piece?id=%s&part=0&r=0&at=0" % a.get("id"), data=b"x" * 10)
        check("...and a piece sent out of its computer's turn", code5 == 409 and a5.get("stop") is True, a5)
        dl(pi, "remove", {"id": a.get("id")})

        # 7. pi itself, when its own network's the least busy: straight into its Transmission
        procs["pi"].terminate()
        procs["pi"].wait(10)
        nets["pi"] = 1000
        start("pi")
        raw7, h7, _ = make_torrent(swarm, "Small.mkv", [(None, 300000)])
        ready = wait_for(lambda: {c["name"] for c in listing().get("computers", []) if c.get("heard")} >= {"pie", "rhubarb"}, 30)
        # (where the cluster's Transmission ran on pie, it moves to pi now pi's back: added once it runs there, as an
        # add in that gap finds no Transmission; the check failed that way on a busy PC, 2026-11-25)
        moved = wait_for(lambda: os.path.exists(os.path.join(tmp, "pi-state", "tr-running")) and tr_ask(pi_tr, "session-get") is not None, 60)
        code, a = dl(pi, "add", {"torrent": b64(raw7), "folder": movies, "where": "freest"})
        check("The most free network pi's own: added straight to its Transmission", bool(ready) and bool(moved) and code == 200 and wait_for(lambda: cluster_has(h7), 20) and
              not any(d["hash"] == h7 for d in listing().get("downloads", [])), a)
        idle = wait_for(lambda: not os.path.exists(os.path.join(tmp, "rhubarb-state", "own-tr-running")), 60)
        check("A computer's own Transmission stops a while after its last download", bool(idle))
    finally:
        for p in procs.values():
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(10)
                except subprocess.TimeoutExpired:
                    p.kill()
        for n in ports:
            for m in ("tr-running", "own-tr-running"):
                f = os.path.join(tmp, n + "-state", m)
                if os.path.exists(f):
                    try:
                        os.kill(int(open(f).read()), 9)
                    except OSError:
                        pass
        if not all(results):
            print("---- the root helper was asked:\n" + "".join(open(log).readlines()[-20:]))
            for name, p in procs.items():
                print("---- %s's log:\n%s" % (name, (p.stdout.read() if p.stdout else "")[-3000:]))
        time.sleep(0.5)
        shutil.rmtree(tmp, ignore_errors=True)
    print("%d/%d checks passed." % (sum(results), len(results)))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
