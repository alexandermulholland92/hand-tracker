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
- only shared files fetched, and results downloaded.
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


def main():
    ff = find_ffmpeg()
    if not ff:
        print("ffmpeg is needed (HT_TEST_FFMPEG=…)")
        return 1
    tmp = tempfile.mkdtemp(prefix="ht-jobs-test-")
    pie_rec = os.path.join(tmp, "pie-recordings")
    pi_folder = os.path.join(tmp, "pi-folder")
    for d in (pie_rec, pi_folder):
        os.makedirs(d)
    for path, secs in ((os.path.join(pie_rec, "Sentry_Head_2026-11-17_12-00-00.mp4"), 3), (os.path.join(pi_folder, "walk.mp4"), 2)):
        subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=%d" % secs,
                        "-pix_fmt", "yuv420p", path], check=True)
    with open(os.path.join(pi_folder, "notes.txt"), "w") as f:
        f.write("not a video")
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
        start("pi", pi_port, pie_port, pi_ht_url, {})
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
        c1, _ = ask(pi_port, "PUT", "/api/jobs/upload?job=%s&name=letter.txt&at=0" % jid2, data=payload[:half])
        c2, _ = ask(pi_port, "PUT", "/api/jobs/upload?job=%s&name=letter.txt&at=%d&last=1" % (jid2, half), data=payload[half:])
        c3, a3 = ask(pi_port, "PUT", "/api/jobs/upload?job=%s&name=other.txt&at=0&last=1" % jid2, data=b"x")
        check("...the file arrives in two pieces (and no other is taken)", c1 == 200 and c2 == 200 and c3 == 400, (c1, c2, c3, a3))
        code, a = act(pi_port, "start", {"job": jid2})
        done2 = wait_for(lambda: (job_state(pi_port, jid2) or {}).get("state") == "done", 60)
        code, res = act(pi_port, "results", {"job": jid2})
        names2 = sorted(f["path"] for f in res.get("files", []))
        check("...the command ran on it and its copy came back", bool(done2) and names2 == ["letter.txt", "log.txt"], (job_state(pi_port, jid2), names2))

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
