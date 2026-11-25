#!/usr/bin/env python3
"""
test_phones.py - checks phones as members of the cluster (the user, 2026-11-23: "Have phone's able to join the cluster
as a member too"), on any computer:  python3 cluster/test_phones.py

Simulated here: "pi", which keeps the job list (and takes no jobs itself), an Android phone "OnePlus" and an iPhone
"iPhone", each running Cluster's service as the Cluster app does (HT_CLUSTER_PLATFORM=android / ios), their
readings and their app's ffmpeg simulated (phonesys.py: this computer's ffmpeg). Checked:
- each phone gives pi its own key; pi reaches it with that key, and passes the page's requests on to it; a request
  without the key, or with another, is refused; pi takes only a real key;
- a phone runs only the modules made for phones (health, jobs, downloads), its health its own (its battery, plugged in
  or not);
- a conversion job: the Android phone takes pi's video, converts it with its app's ffmpeg (its progress as ffmpeg's
  -progress says it) and sends it back;
- a run job's Python script, run in the phone's own Python (a phone can't start another);
- the iPhone takes no commands (it can't run any), the Android phone does;
- a Pi asked to stop notes it (health: a clean restart), through the service itself (node.notify_stop);
- the FTP link to pi's shared folders (modules/ftp.py): the phone logs in with its name and its own key, sees the
  shared folder at the top, fetches and sends files there, can't delete or go outside it; another key is refused.
  This needs pyftpdlib (HT_TEST_PYFTPDLIB: a folder with it, else one this Python has); otherwise it's skipped.
ffmpeg: HT_TEST_FFMPEG, else the one on the path, else node_modules/ffmpeg-static's.
"""

import ftplib
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
NODE = os.path.join(HERE, "node")
results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print("%s  %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  (%s)" % str(detail)[:700]), flush=True)


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


def ask(port, method, path, body=None, headers=None, data=None):
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


def wait_for(fn, seconds=60):
    until = time.time() + seconds
    while time.time() < until:
        try:
            v = fn()
            if v:
                return v
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            pass
        time.sleep(0.5)
    return None


def module(d, name):
    return next((m for m in (d or {}).get("modules", []) if m["name"] == name), None) if isinstance(d, dict) else None


def unit_checks(tmp):
    """In this Python: a Pi asked to stop (systemd's TERM) notes it through the service, as health's boots say."""
    saved = {k: os.environ.get(k) for k in ("HT_CLUSTER_SIM_BOOT_ID", "HT_CLUSTER_SIM_SHUTDOWN", "HT_CLUSTER_PLATFORM")}
    os.environ.pop("HT_CLUSTER_PLATFORM", None)
    os.environ["HT_CLUSTER_SIM_BOOT_ID"] = "boot-one"
    sys.path.insert(0, NODE)
    try:
        import ht_cluster

        n = ht_cluster.Node(simulate=True, state_dir=os.path.join(tmp, "unit-state"))
        H = n.modules["health"].mod
        H.boot_tick(n)
        os.environ["HT_CLUSTER_SIM_SHUTDOWN"] = "restart"
        error = None
        try:
            n.notify_stop()
        except Exception as e:
            error = repr(e)
        boots = n.memory("health").get("boots") or []
        check("A Pi asked to stop notes it through the service (health: a clean restart; node.stopping is the threads' Event)",
              error is None and boots and boots[-1].get("ended") == "restart" and hasattr(n.stopping, "is_set"), (error, boots))
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def main():
    ff = find_ffmpeg()
    if not ff:
        print("ffmpeg is needed (HT_TEST_FFMPEG=…)")
        return 1
    tmp = tempfile.mkdtemp(prefix="ht-phones-test-")
    unit_checks(tmp)
    folder = os.path.join(tmp, "pi-folder")
    os.makedirs(folder)
    subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=3", "-pix_fmt", "yuv420p",
                    os.path.join(folder, "walk.mp4")], check=True)
    with open(os.path.join(tmp, "hello.py"), "w", encoding="utf-8") as f:
        f.write("import os, sys\nprint('hello from', os.environ.get('MEMBER'), 'with', sys.argv[1:])\nsys.exit(0)\n")
    pi, phone, iphone = free_port(), free_port(), free_port()
    procs = []
    shared = os.path.join(tmp, "shared")
    os.makedirs(shared)
    with open(os.path.join(shared, "film.txt"), "w", encoding="utf-8") as f:
        f.write("a film")
    ftp_lib = os.environ.get("HT_TEST_PYFTPDLIB") or ""
    try:
        if not ftp_lib:
            import pyftpdlib  # noqa: F401
        have_ftp = True
    except ImportError:
        have_ftp = False
    ftp_port = free_port()

    def start(name, port, peers, extra):
        env = dict(os.environ, HT_CLUSTER_SIM_NAME=name, HT_CLUSTER_SIM_PEERS=",".join("127.0.0.1:%d" % p for p in peers),
                   HT_CLUSTER_STATE=os.path.join(tmp, name + "-state"), HT_CLUSTER_JOBS_DIR=os.path.join(tmp, name + "-jobs"),
                   HT_CLUSTER_FFMPEG=ff, PYTHONDONTWRITEBYTECODE="1", **extra)
        for k in ("HT_CLUSTER_PLATFORM", "HT_CLUSTER_NAME", "HT_CLUSTER_SEEDS", "HT_CLUSTER_PHONE_SIM", "HT_CLUSTER_PHONE_SH"):
            if k not in extra:
                env.pop(k, None)
        p = subprocess.Popen([sys.executable, os.path.join(NODE, "ht_cluster.py"), "--simulate", "--port", str(port)], env=env,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        procs.append((name, p))
        return p

    sh = shutil.which("sh") or shutil.which("bash")

    def phone_env(platform, name, battery):
        return {"HT_CLUSTER_PLATFORM": platform, "HT_CLUSTER_NAME": name, "HT_CLUSTER_SEEDS": "127.0.0.1:%d" % pi, "HT_CLUSTER_PHONE_SIM": battery,
                **({"HT_CLUSTER_PHONE_SH": sh} if sh else {})}

    via = lambda port: {"X-HT-Cluster-To": "127.0.0.1:%d" % port}
    try:
        start("pi", pi, [phone, iphone], {"HT_CLUSTER_FTP_FOLDERS": shared, "HT_CLUSTER_FTP_PORT": str(ftp_port),
                                          **({"PYTHONPATH": ftp_lib + os.pathsep + os.environ.get("PYTHONPATH", "")} if ftp_lib else {})})
        wait_for(lambda: ask(pi, "GET", "/api/node")[0] == 200, 20)
        ask(pi, "POST", "/api/settings", {"module": "jobs", "key": "home", "value": True})
        ask(pi, "POST", "/api/settings", {"module": "jobs", "key": "take", "value": False})
        start("OnePlus", phone, [pi], phone_env("android", "OnePlus", "80,charging"))
        start("iPhone", iphone, [pi], phone_env("ios", "iPhone", "55"))

        # each phone's key: given to pi, which reaches it with it
        node = wait_for(lambda: (lambda c, d: d if c == 200 and d.get("name") == "OnePlus" else None)(*ask(pi, "GET", "/api/node", headers=via(phone))), 40)
        check("A phone gives pi its key, and pi reaches it with it (passing the page's request on)", bool(node) and node.get("platform") == "android", node)
        code, d = ask(phone, "GET", "/api/node")
        code2, d2 = ask(phone, "GET", "/api/node", headers={"X-HT-Cluster-Key": "x" * 43})
        code3, d3 = ask(pi, "POST", "/api/phone", {"key": "short"})
        check("A request to a phone without its key, or with another, is refused; pi takes only a real key", code == 403 and code2 == 403 and code3 == 400, (code, code2, code3))
        mods = sorted(m["name"] for m in (node or {}).get("modules", []))
        check("A phone runs only the modules made for phones (health, jobs, downloads)", mods == ["downloads", "health", "jobs"], mods)
        dl = (module(node, "downloads") or {}).get("status") or {}
        check("...its downloads too: its own Transmission (the app's), no splitting by pieces (no libtorrent there)", bool(module(node, "downloads")) and dl.get("pieces") in (False, None), dl)
        st = (module(node, "health") or {}).get("status") or {}
        check("Its health is the phone's own: plugged in and charging, its battery, memory, Wi-Fi and storage; no shutting down at 10%",
              "Charging (battery 80%)" in (st.get("summary") or "") and st.get("power", {}).get("source") == "wall" and (module(node, "health") or {}).get("settings") == [],
              st.get("summary"))
        inode = wait_for(lambda: (lambda c, d: d if c == 200 and d.get("name") == "iPhone" else None)(*ask(pi, "GET", "/api/node", headers=via(iphone))), 40)
        ist = (module(inode, "health") or {}).get("status") or {}
        check("The iPhone's too: on its battery (55%)", bool(inode) and inode.get("platform") == "ios" and "Battery 55%" in (ist.get("summary") or ""), ist.get("summary"))

        # a conversion: the Android phone takes pi's video, converts it with its app's ffmpeg, sends it back
        ask(iphone, "GET", "/api/node")  # (nothing: the iPhone's jobs switched off below, so the conversion is the Android phone's)
        args = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p", "-an"]
        code, made = ask(pi, "POST", "/api/action", {"module": "jobs", "action": "create", "args": {
            "kind": "convert", "title": "On a phone", "params": {"format": "mp4", "ext": "mp4", "suffix": "-phone", "args": args}, "folder": folder}})
        ask(pi, "POST", "/api/settings", {"module": "jobs", "key": "take", "value": False}, headers=via(iphone))
        check("A conversion job is made on pi", code == 200 and made.get("ok"), made)
        jid = made.get("job")
        job = lambda: (lambda c, a: a.get("job") if c == 200 else None)(*ask(pi, "POST", "/api/action", {"module": "jobs", "action": "items", "args": {"job": jid}}))
        done = wait_for(lambda: (job() or {}).get("state") in ("done", "failed") and job(), 150)
        items = (done or {}).get("items", [])
        check("...done by the Android phone, with its app's ffmpeg", (done or {}).get("state") == "done" and len(items) == 1 and items[0].get("worker") == "OnePlus", done)
        code, res = ask(pi, "POST", "/api/action", {"module": "jobs", "action": "results", "args": {"job": jid}})
        names = [f["path"] for f in (res or {}).get("files", [])]
        code, data = ask(pi, "GET", "/api/jobs/result-file?job=%s&path=walk-phone.mp4&at=0" % jid)
        check("...its result back on pi, an MP4", names == ["walk-phone.mp4"] and isinstance(data, bytes) and data[4:8] == b"ftyp", (names, data[:12] if isinstance(data, bytes) else data))

        # a run job's Python script, in the phone's own Python
        with open(os.path.join(tmp, "hello.py"), "rb") as f:
            script = f.read()
        code, up = ask(pi, "POST", "/api/action", {"module": "jobs", "action": "create", "args": {
            "kind": "run", "title": "Hello", "params": {"how": "each", "members": ["OnePlus"], "script": {"upload": "hello.py"}, "needs": "python3"}}})
        rid = up.get("job") if isinstance(up, dict) else None
        if rid:
            ask(pi, "PUT", "/api/jobs/upload?job=%s&name=hello.py&at=0&last=1" % rid, data=script)
            ask(pi, "POST", "/api/action", {"module": "jobs", "action": "start", "args": {"job": rid}})
        rjob = lambda: (lambda c, a: a.get("job") if c == 200 else None)(*ask(pi, "POST", "/api/action", {"module": "jobs", "action": "items", "args": {"job": rid}}))
        rdone = wait_for(lambda: (rjob() or {}).get("state") in ("done", "failed") and rjob(), 120) if rid else None
        log = b""
        if rdone and rdone.get("state") == "done":
            code, res = ask(pi, "POST", "/api/action", {"module": "jobs", "action": "results", "args": {"job": rid}})
            logs = [f["path"] for f in (res or {}).get("files", []) if f["path"].endswith("log.txt")]
            if logs:
                code, log = ask(pi, "GET", "/api/jobs/result-file?job=%s&path=%s&at=0" % (rid, urllib.request.quote(logs[0])))
        check("A run job's Python script runs in the phone's own Python (what it printed in its log)",
              bool(rdone) and rdone.get("state") == "done" and b"hello from OnePlus" in (log if isinstance(log, bytes) else b""), (up, rdone, log[:300] if isinstance(log, bytes) else log))

        # the FTP link to pi's shared folders: the phone logs in with its own key
        if have_ftp:
            with open(os.path.join(tmp, "OnePlus-state", "phone-key"), encoding="utf-8") as f:
                key = f.read().strip()
            out = {}
            ftp = None
            for _ in range(30):
                try:
                    ftp = ftplib.FTP()
                    ftp.connect("127.0.0.1", ftp_port, timeout=10)
                    break
                except OSError:
                    ftp = None
                    time.sleep(1)
            try:
                ftp.login("OnePlus", key)
                out["top"] = sorted(ftp.nlst("/"))
                ftp.cwd("/shared")
                got = io.BytesIO()
                ftp.retrbinary("RETR film.txt", got.write)
                out["fetched"] = got.getvalue()
                ftp.storbinary("STOR sent.txt", io.BytesIO(b"from the phone"))
                out["sent"] = open(os.path.join(shared, "sent.txt"), "rb").read() if os.path.exists(os.path.join(shared, "sent.txt")) else None
                try:
                    ftp.delete("film.txt")
                    out["deleted"] = True
                except ftplib.error_perm:
                    out["deleted"] = False
                try:
                    ftp.cwd("/../..")
                    out["outside"] = ftp.pwd()
                except ftplib.error_perm:
                    out["outside"] = "refused"
                ftp.quit()
            except Exception as e:
                out["error"] = repr(e)
            try:
                bad = ftplib.FTP()
                bad.connect("127.0.0.1", ftp_port, timeout=10)
                bad.login("OnePlus", "x" * 43)
                out["badKey"] = "let in"
            except ftplib.error_perm:
                out["badKey"] = "refused"
            except Exception as e:
                out["badKey"] = repr(e)
            check("The FTP link to pi's shared folders: the phone logs in with its own key, sees the shared folder, fetches and sends files; no deleting, nothing outside; another key refused",
                  not out.get("error") and out.get("top") == ["shared"] and out.get("fetched") == b"a film" and out.get("sent") == b"from the phone"
                  and out.get("deleted") is False and out.get("outside") in ("/", "refused") and os.path.exists(os.path.join(shared, "film.txt")) and out.get("badKey") == "refused", out)
        else:
            print("SKIP  the FTP link (no pyftpdlib: HT_TEST_PYFTPDLIB)")

        # which kinds each phone takes: a command, with only the iPhone taking jobs, waits; the Android phone takes it
        ask(pi, "POST", "/api/settings", {"module": "jobs", "key": "take", "value": False}, headers=via(phone))
        ask(pi, "POST", "/api/settings", {"module": "jobs", "key": "take", "value": True}, headers=via(iphone))
        code, made = ask(pi, "POST", "/api/action", {"module": "jobs", "action": "create", "args": {
            "kind": "command", "title": "A command", "params": {"command": "echo phone > {out}/it.txt"}, "folder": folder}})
        cid = made.get("job") if isinstance(made, dict) else None
        cjob = lambda: (lambda c, a: a.get("job") if c == 200 else None)(*ask(pi, "POST", "/api/action", {"module": "jobs", "action": "items", "args": {"job": cid}}))
        time.sleep(10)
        waiting = [i.get("state") for i in (cjob() or {}).get("items", [])]
        ask(pi, "POST", "/api/settings", {"module": "jobs", "key": "take", "value": True}, headers=via(phone))
        taken = wait_for(lambda: [i for i in (cjob() or {}).get("items", []) if i.get("worker")], 60)
        check("A command waits while only the iPhone takes jobs (it can't run commands); the Android phone takes it",
              waiting and all(s == "waiting" for s in waiting) and taken and all(i["worker"] == "OnePlus" for i in taken), (waiting, taken))
    finally:
        for name, p in procs:
            p.kill()
        for name, p in procs:
            try:
                out = p.communicate(timeout=5)[0]
            except Exception:
                out = ""
            if any(not r for r in results):
                print("--- %s ---\n%s" % (name, out[-2500:]))
        shutil.rmtree(tmp, ignore_errors=True)
    print("%d/%d passed" % (sum(results), len(results)))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
