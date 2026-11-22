#!/usr/bin/env python3
"""
test_jobs.py - checks Pi Cluster's jobs (cluster/node/modules/jobs.py) on any computer:  python3 cluster/test_jobs.py

Two Pis are simulated here: "pi", which keeps the job list, and "pie", whose recordings folder has a
clip. Each has a stand-in Hand Tracker (pie's cameras can be turned on). Checked:
- a conversion job over pie's clip (done by pie itself, where the clip is) and a folder on pi;
- a command job over a file sent from a computer;
- the animal model over a clip: its pictures, label check proposals and per-clip list. This needs a
  Python with ONNX Runtime, NumPy and Pillow (HT_TEST_ANIMALS_PY) and the app's model, animals8.onnx
  (HT_TEST_MODEL); otherwise it's skipped;
- a job stopped while it runs, then removed with its files;
- pie not taking work while its cameras run (its switch off);
- only shared files fetched, and results downloaded;
- files moving in turns: in the order asked, pie waiting for its turn to download while another Pi has
  it (2026-11-21); in this process with a clock of its own, links let in one after the other while they
  make it faster, one fewer when a piece crawls, one only while the turtle's on, a piece asked for
  again, and a file that couldn't be moved put back on the list, then failed after 3 tries; a file
  sent again from its start, and a last piece sent again, taken as they should be;
- a playable copy, done only by the Pi its file is on ("here"), put beside its video;
- autoconvert.py: a look through a videos folder puts an old-format video and a sound-only one in jobs,
  and leaves alone one that plays everywhere, a sample, one converted already and a 4K one (its switch
  off); the copies come back as "<name> - converted.mp4" (H.264 + AAC); a second look adds nothing.
  This needs ffprobe (HT_TEST_FFPROBE, else on the path, else beside ffmpeg); otherwise it's skipped.
ffmpeg: HT_TEST_FFMPEG, else the one on the path, else node_modules/ffmpeg-static's.
"""

import hashlib
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
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
NODE = os.path.join(HERE, "node")
MODEL_URL = "https://github.com/alexandermulholland92/hand-tracker/releases/download/sentry-models-3/animals8.onnx"
MODEL_SHA = "62f76d03c90701582d5023240340b0e0d9b5249695033bd2fcd8f6206bce2b27"
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


def find_ffmpeg():
    for p in (os.environ.get("HT_TEST_FFMPEG"), shutil.which("ffmpeg"),
              os.path.join(HERE, "..", "node_modules", "ffmpeg-static", "ffmpeg.exe" if os.name == "nt" else "ffmpeg")):
        if p and os.path.exists(p):
            return os.path.abspath(p)
    return None


def find_ffprobe(ff):
    side = os.path.join(os.path.dirname(ff), "ffprobe.exe" if os.name == "nt" else "ffprobe") if ff else None
    for p in (os.environ.get("HT_TEST_FFPROBE"), shutil.which("ffprobe"), side):
        if p and os.path.exists(p):
            return os.path.abspath(p)
    return None


def streams_of(fp, path):
    out = subprocess.run([fp, "-v", "error", "-print_format", "json", "-show_streams", path], capture_output=True, text=True).stdout
    try:
        return [(s.get("codec_type"), s.get("codec_name")) for s in json.loads(out or "{}").get("streams", [])]
    except ValueError:
        return []


def fake_ht():
    st = {"cameras": False}

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            body = json.dumps({"recording": False, "saving": False, "running": st["cameras"],
                               "cameras": [{"name": "OAK-1"}] if st["cameras"] else [], "sentry": {"armed": False}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return st, "http://127.0.0.1:%d" % srv.server_address[1]


def ask(port, method, path, body=None, data=None, headers=None):
    h = {"X-HT-Cluster": "1", "Host": "127.0.0.1:%d" % port}
    h.update(headers or {})
    payload = None
    if body is not None:
        payload = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    elif data is not None:
        payload = data
        h["Content-Type"] = "application/octet-stream"
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), data=payload, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()
            return r.status, (json.loads(raw or b"{}") if r.headers.get("Content-Type", "").startswith("application/json") else raw)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"{}")
        except ValueError:
            return e.code, raw


def act(port, action, args):
    return ask(port, "POST", "/api/action", {"module": "jobs", "action": action, "args": args})


def jobs_status(port):
    _, d = ask(port, "GET", "/api/node")
    return next((m for m in d.get("modules", []) if m["name"] == "jobs"), {}).get("status") or {}


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


def job_state(port, jid):
    code, a = act(port, "items", {"job": jid})
    return a.get("job") if code == 200 else None


def unit_checks(tmp):
    """jobs.py's turns, tries and files put back on the list, in this process with a clock of its own (no
    waiting for real beats): links let in one after the other while they help, one fewer when a piece crawls,
    one only while the turtle's on; a piece asked for again; a file that can't be moved put back, then failed."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("jobs_unit", os.path.join(NODE, "modules", "jobs.py"))
    J = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(J)

    class Clock:
        now = 1000.0

        @classmethod
        def time(cls):
            return cls.now

        @classmethod
        def sleep(cls, s):
            cls.now += s
    J.time = Clock  # (the module's time.time() and time.sleep())

    class Node:
        name, simulate, state_dir, turtle = "pi", True, tmp, False

        def setting(self, module, key):
            return key in ("home", "take")

        def status_of(self, name):
            return {"turtle": self.turtle} if name == "apps" else {}

        def event(self, *a, **k):
            pass

        def log(self, *a):
            pass
    node = Node()
    lane = J._turns["down"]

    def turn(worker, **kw):
        return J.act_turn(node, dict(lane="down", worker=worker, **kw))

    def at(t):
        Clock.now = 1000.0 + t

    at(0)
    a, b = turn("a"), turn("b")
    check("Links: one goes first, the next waits in line", a.get("go") and not b.get("go") and b.get("ahead") == 0, (a, b))
    at(10)
    turn("a", rate=500000, slowest=8)
    b = turn("b")
    check("...the next not before the first has said how its pieces go", not b.get("go"), (b, lane["allowed"]))
    at(16)
    turn("a", rate=500000, slowest=8)
    b = turn("b")
    check("...then, every piece quick (and 15 s on), a second link starts beside it", b.get("go"), (b, lane["allowed"]))
    at(17)
    c = turn("c")
    check("...a third waits while the second hasn't said yet", not c.get("go") and c.get("ahead") == 0, c)
    at(33)
    turn("a", rate=500000, slowest=8)
    turn("b", rate=450000, slowest=9)
    c = turn("c")
    check("...and starts once the total grew with the second", c.get("go"), (c, lane["allowed"], lane["total_at_go"]))
    at(50)
    for w in "abc":
        turn(w, rate=330000, slowest=11)
    d = turn("d")
    check("...but no fourth when the third only shared the same speed", not d.get("go") and lane["allowed"] == 3, (d, lane["allowed"]))
    at(52)
    turn("a", rate=150000, slowest=30)
    turn("a", done=True)
    d = turn("d")
    check("One fewer when a piece crawled (this Pi straining): one ending isn't followed by another", not d.get("go") and lane["allowed"] == 2, (d, lane["allowed"]))
    at(60)
    node.turtle = True
    turn("b", rate=300000, slowest=5)
    for w in "bc":
        turn(w, done=True)
    d = turn("d")
    at(80)
    turn("d", rate=900000, slowest=3)
    e = turn("e")
    check("While the turtle's on (someone's watching), one link at a time however quick", d.get("go") and not e.get("go") and lane["allowed"] == 1, (d, e, lane["allowed"]))
    at(200)
    e = turn("e")
    check("A Pi that stopped saying it has its turn loses it", e.get("go") and "d" not in lane["holders"], (e, sorted(lane["holders"])))
    node.turtle = False
    at(217)
    turn("e", rate=310000, slowest=13)  # (pi's one link, 2026-11-21: 0.3 MB/s, 13 s a piece)
    f = turn("f")
    check("A link going at pi's 0.3 MB/s (13 s a piece) gets a second beside it", f.get("go"), (f, lane["allowed"]))
    at(234)
    turn("e", rate=200000, slowest=22)
    turn("f", rate=190000, slowest=22)
    g = turn("g")
    check("...pieces near crawling (22 s): no third, none taken away", not g.get("go") and lane["allowed"] == 2, (g, lane["allowed"]))
    for w in "ef":
        turn(w, done=True)
    turn("g", done=True)

    # A piece asked for again
    calls = []

    def flaky():
        calls.append(1)
        return (None, "timed out") if len(calls) < 3 else (200, b"x")
    code, data, _took = J.with_tries("a piece", flaky)
    check("A piece that didn't come through is asked for again, and comes", code == 200 and data == b"x" and len(calls) == 3, (code, len(calls)))
    del calls[:]
    try:
        J.with_tries("a piece", lambda: (calls.append(1), (None, "timed out"))[1])
        moved = False
    except J.Moving as e:
        moved = len(calls) == J.PIECE_TRIES and "%d tries" % J.PIECE_TRIES in str(e)
    check("...one that never does stops after %d tries, as a file that couldn't be moved" % J.PIECE_TRIES, moved, len(calls))
    del calls[:]
    code, _a, _took = J.with_tries("a piece", lambda: (calls.append(1), (404, {"error": "No such file."}))[1])
    check("...but the other Pi's no (a 4xx) isn't asked again", code == 404 and len(calls) == 1, (code, len(calls)))

    # A file that couldn't be moved: back on the list, then failed after MAX_TRIES
    os.environ["HT_CLUSTER_JOBS_DIR"] = os.path.join(tmp, "unit-jobs")
    try:
        J._book["jobs"] = [{"id": "j1", "kind": "playable", "title": "T", "state": "running", "params": {}, "created": 0, "high": False,
                            "items": [{"id": "i1", "name": "v1.avi", "state": "running", "lease": "L1", "worker": "pie", "tries": 0,
                                       "source": {"node": "pi", "path": "/x"}}]}]
        it = J._book["jobs"][0]["items"][0]
        J.act_finish(node, {"lease": "L1", "ok": False, "again": True, "error": "v1.avi from pi didn't come through"})
        back = it["state"] == "waiting" and it.get("tries") == 1 and not it.get("error")
        it.update(state="running", lease="L2")
        J.act_finish(node, {"lease": "L2", "ok": False, "again": True, "error": "not again"})
        it.update(state="running", lease="L3")
        J.act_finish(node, {"lease": "L3", "ok": False, "again": True, "error": "still not through"})
        check("A file that couldn't be moved goes back on the list, not failed", back, it)
        check("...and fails after %d tries, saying why" % J.MAX_TRIES, it["state"] == "failed" and "still not through" in it.get("error", ""), it)
    finally:
        os.environ.pop("HT_CLUSTER_JOBS_DIR", None)


def main():
    ff = find_ffmpeg()
    if not ff:
        print("ffmpeg is needed (HT_TEST_FFMPEG=…)")
        return 1
    tmp = tempfile.mkdtemp(prefix="ht-jobs-test-")
    unit_checks(tmp)
    pie_rec = os.path.join(tmp, "pie-recordings")
    pi_folder = os.path.join(tmp, "pi-folder")
    for d in (pie_rec, pi_folder):
        os.makedirs(d)
    for path, secs in ((os.path.join(pie_rec, "Sentry_Head_2026-11-17_12-00-00.mp4"), 3), (os.path.join(pi_folder, "walk.mp4"), 2)):
        subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=%d" % secs,
                        "-pix_fmt", "yuv420p", path], check=True)
    with open(os.path.join(pi_folder, "notes.txt"), "w") as f:
        f.write("not a video")
    # autoconvert.py's folder: what needs converting, and what doesn't
    fp = find_ffprobe(ff)
    vids = os.path.join(tmp, "Videos")
    tone = ["-f", "lavfi", "-i", "sine=frequency=440:duration=2"]
    made_vids = {
        os.path.join("Show", "Season 1", "ep1.avi"): ["-c:v", "mpeg4", "-c:a", "libmp3lame"],  # old format
        os.path.join("Show", "Season 1", "ep2.mkv"): ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "ac3"],  # sound only
        os.path.join("Show", "Season 1", "ep3.mp4"): ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"],  # plays everywhere (a third in the folder)
        os.path.join("Movie", "movie.mp4"): ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"],  # plays everywhere
        os.path.join("Movie", "movie sample.mp4"): ["-c:v", "mpeg4", "-c:a", "libmp3lame"],  # a sample: left alone
        os.path.join("Old", "done.avi"): ["-c:v", "mpeg4", "-c:a", "libmp3lame"],  # converted already
        os.path.join("Old", "done - converted.mp4"): ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"],
    }
    for rel, codecs in made_vids.items():
        p = os.path.join(vids, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2"] + tone + codecs + ["-shortest", p], check=True)
    big = os.path.join(vids, "Big", "big.mp4")  # 4K-sized: its switch is off
    os.makedirs(os.path.dirname(big), exist_ok=True)
    subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=2560x1440:rate=5:duration=1"] + tone +
                   ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", big], check=True)
    old = time.time() - 3600  # (nothing written for an hour: not still downloading)
    for d, _, names in os.walk(vids):
        for n in names:
            os.utime(os.path.join(d, n), (old, old))
    pi_ht, pi_ht_url = fake_ht()
    pie_ht, pie_ht_url = fake_ht()
    pi_port, pie_port = free_port(), free_port()
    procs = []

    def start(name, port, peer, ht, extra):
        env = dict(os.environ, HT_CLUSTER_SIM_NAME=name, HT_CLUSTER_SIM_PEERS="127.0.0.1:%d" % peer, HT_CLUSTER_STATE=os.path.join(tmp, name + "-state"),
                   HT_CLUSTER_JOBS_DIR=os.path.join(tmp, name + "-jobs"), HT_CLUSTER_FFMPEG=ff, HT_CLUSTER_HT_URL=ht, PYTHONDONTWRITEBYTECODE="1", **extra)
        if os.environ.get("HT_TEST_ANIMALS_PY"):
            env["HT_CLUSTER_SIM_ANIMALS_PY"] = os.environ["HT_TEST_ANIMALS_PY"]
        model = os.environ.get("HT_TEST_MODEL")
        if model:  # (the model where a Pi keeps the ones it has downloaded)
            os.makedirs(os.path.join(tmp, name + "-state", "models"), exist_ok=True)
            shutil.copyfile(model, os.path.join(tmp, name + "-state", "models", MODEL_SHA + ".onnx"))
        p = subprocess.Popen([sys.executable, os.path.join(NODE, "ht_cluster.py"), "--simulate", "--port", str(port)], env=env,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        procs.append(p)
        wait_for(lambda: ask(port, "GET", "/api/node")[0] == 200, 20)
        return p

    try:
        start("pi", pi_port, pie_port, pi_ht_url, {"HT_CLUSTER_AUTOCONVERT_DIR": vids, **({"HT_CLUSTER_FFPROBE": fp} if fp else {})})
        ask(pi_port, "POST", "/api/settings", {"module": "jobs", "key": "home", "value": True})
        start("pie", pie_port, pi_port, pie_ht_url, {"HT_CLUSTER_SIM_RECORDINGS": pie_rec})
        check("pi says it keeps the job list", jobs_status(pi_port).get("home") is True)

        # What a computer can pick from: pie's recordings, pi's folders
        code, recs = act(pie_port, "recordings", {})
        check("pie lists its recordings", code == 200 and [r["name"] for r in recs["recordings"]] == ["Sentry_Head_2026-11-17_12-00-00.mp4"], recs)
        code, br = act(pi_port, "browse", {"path": pi_folder})
        check("pi's folder can be looked through", code == 200 and [f["name"] for f in br["files"]] == ["notes.txt", "walk.mp4"], br)

        # A conversion over pie's clip and pi's folder
        rec = recs["recordings"][0]
        args = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p", "-an"]
        code, made = act(pi_port, "create", {"kind": "convert", "title": "Smaller MP4s", "params": {"format": "mp4", "ext": "mp4", "suffix": "-small", "args": args},
                                            "files": [{"name": rec["name"], "size": rec["size"], "node": "pie", "path": rec["path"]}], "folder": pi_folder})
        check("A conversion job is made (pie's clip, and pi's folder's video only)", code == 200 and made.get("ok"), made)
        jid = made.get("job")
        done = wait_for(lambda: (job_state(pi_port, jid) or {}).get("state") == "done" and job_state(pi_port, jid), 120)
        check("...and done", bool(done), job_state(pi_port, jid))
        items = (done or {}).get("items", [])
        check("...with 2 files, pie's clip done by pie itself", len(items) == 2 and next((i["worker"] for i in items if i["from"] == "pie"), None) == "pie", items)
        code, res = act(pi_port, "results", {"job": jid})
        names = sorted(f["path"] for f in res.get("files", []))
        check("...its results on pi", names == ["Sentry_Head_2026-11-17_12-00-00-small.mp4", "walk-small.mp4"], res)
        code, data = ask(pi_port, "GET", "/api/jobs/result-file?job=%s&path=%s&at=0" % (jid, urllib.parse.quote(names[0] if names else "x")))
        check("A result downloads from pi", code == 200 and isinstance(data, bytes) and data[4:8] == b"ftyp", (code, data[:16] if isinstance(data, bytes) else data))
        code, z = act(pi_port, "zip", {"job": jid})
        got = b""
        while code == 200 and len(got) < z.get("size", 0):
            c, piece = ask(pi_port, "GET", "/api/jobs/zip-file?job=%s&at=%d" % (jid, len(got)))
            if c != 200 or not isinstance(piece, bytes) or not piece:
                break
            got += piece
        import io
        import zipfile
        try:
            inside_zip = sorted(zipfile.ZipFile(io.BytesIO(got)).namelist())
        except zipfile.BadZipFile:
            inside_zip = []
        check("Its results as one zip (for a phone)", z.get("name") == "Smaller MP4s.zip" and inside_zip == names, (z, inside_zip))
        # The Pi Cluster page in a browser, served by pie: the zip saved whole through a one-time link, from pi through pie
        code, t = ask(pie_port, "POST", "/api/ticket", {"to": "127.0.0.1:%d" % pi_port, "path": "/api/jobs/zip-file?job=%s&whole=1" % jid})
        req = urllib.request.Request("http://127.0.0.1:%d%s" % (pie_port, t.get("url", "/x") if isinstance(t, dict) else "/x"), headers={"Host": "127.0.0.1:%d" % pie_port})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                whole, disp = r.read(), r.headers.get("Content-Disposition", "")
        except urllib.error.HTTPError as e:
            whole, disp = b"", "HTTP %d" % e.code
        check("In a browser: the zip saved whole from a one-time link (no header), from pi through pie", code == 200 and whole == got and len(got) > 0
              and 'filename="Smaller MP4s.zip"' in disp, (code, t, len(whole), len(got), disp))

        # A command over a file sent from a computer
        payload = b"hello from a computer\n" * 1000
        code, made = act(pi_port, "create", {"kind": "command", "title": "Copy it",
                                            "params": {"command": '%s -c "import shutil,sys; shutil.copy(sys.argv[1], sys.argv[2])" {in} {out}' % sys.executable},
                                            "files": [{"name": "letter.txt", "size": len(payload), "upload": True}]})
        jid2 = made.get("job")
        check("A job with a file from a computer waits for it", code == 200 and made.get("uploads") == ["letter.txt"] and job_state(pi_port, jid2)["state"] == "uploading", made)
        code, a = act(pi_port, "start", {"job": jid2})
        check("...it can't start before the file has come", code == 409, a)
        half = len(payload) // 2
        ask(pi_port, "PUT", "/api/jobs/upload?job=%s&name=letter.txt&at=0" % jid2, data=b"a try that broke off")
        c1, _ = ask(pi_port, "PUT", "/api/jobs/upload?job=%s&name=letter.txt&at=0" % jid2, data=payload[:half])  # (started again: that's thrown away)
        # (the second piece as the page in a browser on pie sends it: through pie, X-HT-Cluster-To)
        c2, _ = ask(pie_port, "PUT", "/api/jobs/upload?job=%s&name=letter.txt&at=%d&last=1" % (jid2, half), data=payload[half:],
                    headers={"X-HT-Cluster-To": "127.0.0.1:%d" % pi_port})
        c2b, a2b = ask(pi_port, "PUT", "/api/jobs/upload?job=%s&name=letter.txt&at=%d&last=1" % (jid2, half), data=payload[half:])  # (its answer lost: sent again)
        c3, a3 = ask(pi_port, "PUT", "/api/jobs/upload?job=%s&name=other.txt&at=0&last=1" % jid2, data=b"x")
        check("...the file arrives in two pieces, the second passed on by another Pi (and no other is taken)", c1 == 200 and c2 == 200 and c3 == 400, (c1, c2, c3, a3))
        check("...its last piece sent again is taken as come (its answer was lost)", c2b == 200, (c2b, a2b))
        code, a = act(pi_port, "start", {"job": jid2})
        done2 = wait_for(lambda: (job_state(pi_port, jid2) or {}).get("state") == "done", 60)
        code, res = act(pi_port, "results", {"job": jid2})
        names2 = sorted(f["path"] for f in res.get("files", []))
        check("...the command ran on it and its copy came back", bool(done2) and names2 == ["letter.txt", "log.txt"], (job_state(pi_port, jid2), names2))
        code, copy = ask(pi_port, "GET", "/api/jobs/result-file?job=%s&path=letter.txt&at=0" % jid2)
        check("...the file as sent: the broken-off try gone, nothing twice", code == 200 and copy == payload, (code, len(copy) if isinstance(copy, bytes) else copy, len(payload)))

        # The animal model
        if os.environ.get("HT_TEST_ANIMALS_PY") and os.environ.get("HT_TEST_MODEL"):
            code, made = act(pi_port, "create", {"kind": "animals", "title": "Animals", "params": {"every": 1, "score": 0.25,
                                                                                                    "model": {"url": MODEL_URL, "sha256": MODEL_SHA, "name": "animals8.onnx"}},
                                                "files": [{"name": rec["name"], "size": rec["size"], "node": "pie", "path": rec["path"]}]})
            jid3 = made.get("job")
            done3 = wait_for(lambda: (job_state(pi_port, jid3) or {}).get("state") in ("done",) and job_state(pi_port, jid3), 180)
            code, res = act(pi_port, "results", {"job": jid3})
            files = [f["path"] for f in res.get("files", [])]
            pics = [f for f in files if f.startswith("images/train/")]
            labels = [f for f in files if f.startswith("labels-proposed/train/")]
            check("The animal model's job: a picture a second, each with proposals", bool(done3) and len(pics) == 3 and len(labels) == 3 and
                  "images/train/Sentry_Head_2026-11-17_12-00-00_00-01.0.jpg" in pics, (job_state(pi_port, jid3), files))
            check("...its clip's list, and the job's finds.json and animals.json", "clips/Sentry_Head_2026-11-17_12-00-00.json" in files and "finds.json" in files and "animals.json" in files, files)
        else:
            print("SKIP  the animal model (HT_TEST_ANIMALS_PY with ONNX Runtime, NumPy and Pillow, and HT_TEST_MODEL)")

        # Stopped while it runs, then removed
        code, made = act(pi_port, "create", {"kind": "command", "title": "Long one", "params": {"command": '%s -c "import time; time.sleep(60)"' % sys.executable}, "folder": pi_folder})
        jid4 = made.get("job")
        running = wait_for(lambda: (job_state(pi_port, jid4) or {}).get("counts", {}).get("running"), 30)
        check("A long job runs", bool(running), job_state(pi_port, jid4))
        act(pi_port, "stop", {"job": jid4})
        stopped = wait_for(lambda: not (job_state(pi_port, jid4) or {}).get("counts", {}).get("running") and job_state(pi_port, jid4), 60)
        check("...stopped, its files stop", bool(stopped) and stopped["state"] == "stopped", job_state(pi_port, jid4))
        code, a = act(pi_port, "remove", {"job": jid4})
        check("...and removed with its files", code == 200 and job_state(pi_port, jid4) is None and not os.path.exists(os.path.join(tmp, "pi-jobs", "results", jid4)), a)

        # pie's cameras on: it doesn't take work (its switch for that is off)
        pie_ht["cameras"] = True
        why = wait_for(lambda: "cameras are running" in (jobs_status(pie_port).get("summary") or ""), 20)
        check("pie waits while its cameras run", bool(why), jobs_status(pie_port))
        ask(pie_port, "POST", "/api/settings", {"module": "jobs", "key": "withCameras", "value": True})
        ready = wait_for(lambda: "Ready" in (jobs_status(pie_port).get("summary") or ""), 20)
        check("...and takes work again once its \"while its cameras run\" is on", bool(ready), jobs_status(pie_port))

        # Only shared files leave a Pi
        outside = os.path.join(tmp, "secret.txt")
        with open(outside, "w") as f:
            f.write("no")
        code, _ = ask(pie_port, "GET", "/api/jobs/file?path=%s&at=0" % urllib.parse.quote(outside))
        code2, data2 = ask(pie_port, "GET", "/api/jobs/file?path=%s&at=0" % urllib.parse.quote(rec["path"]))
        check("A Pi gives only its recordings and the jobs' files", code == 404 and code2 == 200 and isinstance(data2, bytes) and len(data2) == rec["size"], (code, code2))

        # Files move one at a time each way, in the order the Pis asked
        def turn(worker, done=False):
            return act(pi_port, "turn", {"lane": "down", "worker": worker, **({"done": True} if done else {})})[1]
        a1, b1, c1 = turn("x"), turn("y"), turn("z")
        check("Turns: the first to ask goes, the others wait in line", a1.get("go") and not b1.get("go") and b1.get("ahead") == 0
              and not c1.get("go") and c1.get("ahead") == 1, (a1, b1, c1))
        turn("x", done=True)
        b2, c2 = turn("y"), turn("z")
        check("...the next in line goes once it's done", b2.get("go") and not c2.get("go") and c2.get("ahead") == 0, (b2, c2))
        turn("y", done=True)
        turn("z", done=True)

        # pie waits its turn to download pi's file while another Pi has the turn
        ask(pi_port, "POST", "/api/settings", {"module": "jobs", "key": "take", "value": False})  # (pi leaves its folder to pie)
        hold = {"on": True}

        def holder():
            while hold["on"]:
                turn("x")
                time.sleep(2)
        threading.Thread(target=holder, daemon=True).start()
        wait_for(lambda: turn("x").get("go"), 10)
        code, made = act(pi_port, "create", {"kind": "convert", "title": "In turn", "params": {"format": "mp4", "ext": "mp4", "suffix": "-turn", "args": args},
                                            "files": [{"name": "walk.mp4", "size": os.path.getsize(os.path.join(pi_folder, "walk.mp4")), "node": "pi", "path": os.path.join(pi_folder, "walk.mp4")}]})
        jid5 = made.get("job")
        waiting = wait_for(lambda: "Waiting its turn to download" in (jobs_status(pie_port).get("summary") or ""), 30)
        check("pie waits its turn to download pi's file while another Pi has it", bool(waiting) and (job_state(pi_port, jid5) or {}).get("state") != "done", jobs_status(pie_port))
        hold["on"] = False
        time.sleep(2.5)
        turn("x", done=True)
        done5 = wait_for(lambda: (job_state(pi_port, jid5) or {}).get("state") == "done" and job_state(pi_port, jid5), 60)
        check("...and gets it once that's done", bool(done5) and done5["items"][0]["worker"] == "pie", job_state(pi_port, jid5))
        ask(pi_port, "POST", "/api/settings", {"module": "jobs", "key": "take", "value": True})

        # A playable copy, done only where its file is ("here"), put beside it
        walk = os.path.join(pi_folder, "walk.mp4")
        place = os.path.join(pi_folder, "walk - converted.mp4")
        code, made = act(pi_port, "create", {"kind": "playable", "title": "Playable", "params": {"here": True},
                                            "files": [{"name": "v000001.mp4", "size": os.path.getsize(walk), "node": "pi", "path": walk, "place": place,
                                                       "plan": {"v": 0, "audio": [], "subs": [], "duration": 2, "video": "h264"}}]})
        jid6 = made.get("job")
        done6 = wait_for(lambda: (job_state(pi_port, jid6) or {}).get("items", [{}])[0].get("placed") and job_state(pi_port, jid6), 60)
        it6 = (done6 or {}).get("items", [{}])[0]
        check("A playable copy is made by the Pi its file is on (\"here\") and put beside it", it6.get("worker") == "pi" and it6.get("placed") == "placed"
              and os.path.isfile(place) and not os.path.exists(os.path.join(tmp, "pi-jobs", "results", jid6 or "-", "v000001.mp4")), job_state(pi_port, jid6))

        # autoconvert.py: a look through the videos folder
        if fp:
            def auto_status():
                return next((m for m in ask(pi_port, "GET", "/api/node")[1].get("modules", []) if m["name"] == "autoconvert"), {}).get("status") or {}
            ask(pi_port, "POST", "/api/settings", {"module": "autoconvert", "on": True})
            first = wait_for(lambda: "Looked at" in auto_status().get("summary", "") and auto_status(), 60) or {}
            check("One look goes through every video, each of several in a folder too (6 here)", ": 6 videos" in first.get("summary", ""), first.get("summary"))
            ask(pi_port, "POST", "/api/settings", {"module": "autoconvert", "key": "sound", "value": True})
            ask(pi_port, "POST", "/api/action", {"module": "autoconvert", "action": "look", "args": {}})

            def auto_jobs():
                return [j for j in act(pi_port, "list", {})[1].get("jobs", []) if j["title"].startswith("Convert for every device")]
            two = wait_for(lambda: len(auto_jobs()) == 2 and auto_jobs(), 60)
            titles = sorted(j["title"] for j in (two or []))
            check("A look puts the old-format video and the sound-only one in jobs (not the rest)",
                  titles == ["Convert for every device: 1 old-format video", "Convert for every device: 1 sound-only video"], titles)
            ep1 = os.path.join(vids, "Show", "Season 1", "ep1 - converted.mp4")
            ep2 = os.path.join(vids, "Show", "Season 1", "ep2 - converted.mp4")
            placed = wait_for(lambda: os.path.isfile(ep1) and os.path.isfile(ep2), 120)
            check("...their copies come back beside them", bool(placed), sorted(os.listdir(os.path.join(vids, "Show", "Season 1"))))
            check("...each H.264 with AAC sound", streams_of(fp, ep1) == [("video", "h264"), ("audio", "aac")] and streams_of(fp, ep2) == [("video", "h264"), ("audio", "aac")],
                  (streams_of(fp, ep1), streams_of(fp, ep2)))
            sound_job = next((j for j in (two or []) if "sound-only" in j["title"]), {})
            check("...the sound-only one done by pi itself, where it is", [i["worker"] for i in (job_state(pi_port, sound_job.get("id")) or {}).get("items", [])] == ["pi"],
                  job_state(pi_port, sound_job.get("id")))
            before = auto_status().get("lastLook") or 0
            ask(pi_port, "POST", "/api/action", {"module": "autoconvert", "action": "look", "args": {}})
            st = wait_for(lambda: (auto_status().get("lastLook") or 0) > before and "Looked at" in auto_status().get("summary", "") and auto_status(), 30) or {}
            check("...and a second look adds nothing", bool(st) and len(auto_jobs()) == 2, [j["title"] for j in auto_jobs()])
            others = [p for p in (os.path.join(vids, "Movie", "movie - converted.mp4"), os.path.join(vids, "Movie", "movie sample - converted.mp4"), os.path.join(vids, "Big", "big - converted.mp4"),
                                  os.path.join(vids, "Show", "Season 1", "ep3 - converted.mp4")) if os.path.exists(p)]
            check("...nothing made for the one that plays, the sample or the 4K one (its switch off), which it says it'd convert; 3 converted",
                  not others and st.get("toConvert") == {"big": 1} and "4K (switched off)" in st.get("summary", "") and st.get("converted") == 3, (others, st))
        else:
            print("SKIP  autoconvert (ffprobe: HT_TEST_FFPROBE)")
    finally:
        for p in procs:
            p.terminate()
            try:
                p.wait(10)
            except subprocess.TimeoutExpired:
                p.kill()
        if not all(results):
            for p in procs:
                out = p.stdout.read() if p.stdout else ""
                print("---- a Pi's log:\n" + out[-3000:])
        shutil.rmtree(tmp, ignore_errors=True)
    print("%d/%d checks passed." % (sum(results), len(results)))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
