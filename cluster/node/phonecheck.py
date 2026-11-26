"""
phonecheck.py - the iPhone build's simulator check of the Cluster app's own tools for the animal model's jobs
(ClusterMember.swift's selfTestAnimals, only when launched with -HTSelfTest, as build-iphone.yml does): in the app's
Python, its NumPy and Pillow; its HTTPS (the model fetched as a job fetches it, jobs.py's model_file: this project's
GitHub release, its SHA-256 checked); its ONNX Runtime (phonetools.onnxruntime(): the model run twice on one picture,
the same both times, its output as the model's should be); and the animal model's own script (jobs_animals.py, run as
a job runs it, in this Python) over a clip made here with the app's ffmpeg: its pictures, label proposals and list.

  animals(work) -> {"ok": bool, and what each part found}

And of its own Transmission, for the cluster's downloads (downloads.py): started from a settings folder as the service
starts it (phonesys "transmission-start"), its remote control answering as Transmission 4.1.4 (its session-get), then
stopped; and the network's counters it's given (phonesys "net").

  downloads(work) -> {"ok": bool, and what each part found}
"""

import hashlib
import json
import os
import sys
import time
import traceback
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
# (the model test_jobs.py checks with: one of this project's own, as a job is given it)
MODEL_URL = "https://github.com/alexandermulholland92/hand-tracker/releases/download/sentry-models-3/animals8.onnx"
MODEL_SHA = "62f76d03c90701582d5023240340b0e0d9b5249695033bd2fcd8f6206bce2b27"


def animals(work):
    out = {"ok": False}
    try:
        _animals(work, out)
    except BaseException:
        out["error"] = traceback.format_exc()[-2000:]
    return out


def _animals(work, out):
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    import numpy as np
    import PIL
    import phonetools

    out["numpy"], out["pillow"] = np.__version__, PIL.__version__
    os.makedirs(work, exist_ok=True)

    # The model, as jobs.py's model_file fetches it.
    model = os.path.join(work, "model.onnx")
    t = time.time()
    req = urllib.request.Request(MODEL_URL, headers={"User-Agent": "ht-cluster"})
    with urllib.request.urlopen(req, timeout=300) as res:
        data = res.read()
    fetched = hashlib.sha256(data).hexdigest() == MODEL_SHA
    out["download"] = {"bytes": len(data), "s": round(time.time() - t, 1), "whole": fetched}
    with open(model, "wb") as f:
        f.write(data)

    # ONNX Runtime: the model twice on one picture (a pattern, the same each time).
    ort = phonetools.onnxruntime()
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 2
    session = ort.InferenceSession(model, sess_options=opts, providers=["CPUExecutionProvider"])
    inp = session.get_inputs()[0]
    side = inp.shape[2] if isinstance(inp.shape[2], int) else 640
    yy, xx = np.mgrid[0:side, 0:side]
    x = (np.stack([(xx * 7 + yy * 13 + c * 29) % 256 for c in range(3)]).astype(np.float32) / 255.0)[None]
    t = time.time()
    y = session.run(None, {inp.name: x})[0]
    took = time.time() - t
    again = session.run(None, {inp.name: x})[0]
    three = y.ndim == 3 and y.shape[0] == 1 and y.shape[1] > 4
    scores = y[0, 4:] if three else np.zeros(1, np.float32)
    out["model"] = {"input": [inp.name, inp.shape], "output": list(y.shape), "s": round(took, 2), "kinds": int(y.shape[1] - 4) if three else 0,
                    "named": "names" in session.get_modelmeta().custom_metadata_map, "best": round(float(scores.max()), 4)}
    model_ok = bool(three and np.isfinite(y).all() and np.array_equal(y, again) and scores.min() >= 0 and scores.max() <= 1
                    and np.abs(y[0, :4]).max() < 4 * side)

    # The animal model's own script, as a job runs it (in this Python), over a clip made here with the app's ffmpeg.
    raw, clip = os.path.join(work, "clip.rgb"), os.path.join(work, "clip.mp4")
    w, h, n = 320, 240, 30
    frames = np.zeros((n, h, w, 3), np.uint8)
    for i in range(n):
        frames[i, :, :, 0] = (np.arange(w)[None, :] + i * 8) % 256
        frames[i, :, :, 1] = (np.arange(h)[:, None] * 2) % 256
        frames[i, :, :, 2] = 128
    frames.tofile(raw)
    code, _, said = phonetools.run(["ffmpeg", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (w, h), "-r", "10", "-i", raw,
                                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", clip], 120)
    out["clip"] = {"code": code, "bytes": os.path.getsize(clip) if os.path.exists(clip) else 0}
    if code != 0:
        out["clip"]["said"] = (said or "")[-600:]
    dest = os.path.join(work, "out")
    p = phonetools.PythonProc([os.path.join(HERE, "jobs_animals.py"), "--video", clip, "--model", model, "--out", dest,
                               "--base", "check", "--every", "1", "--threads", "2", "--ffmpeg", "ffmpeg",
                               "--work", os.path.join(work, "frames")])
    lines = [line.rstrip("\n") for line in p.stdout]
    code = p.wait(60)
    done = [line for line in lines if line.startswith("done ")]
    summary = json.loads(done[-1][5:]) if done else {}

    def files(*parts):
        d = os.path.join(dest, *parts)
        return sorted(os.listdir(d)) if os.path.isdir(d) else []
    pictures, labels = files("images", "train"), files("labels-proposed", "train")
    out["job"] = {"code": code, "done": summary, "pictures": len(pictures), "labels": len(labels), "said": lines[-6:]}
    job_ok = (code == 0 and summary.get("pictures", 0) >= 2 and len(pictures) == summary["pictures"] and len(labels) == len(pictures)
              and os.path.exists(os.path.join(dest, "clips", "check.json")))
    out["ok"] = bool(fetched and model_ok and out["clip"]["code"] == 0 and job_ok)


def downloads(work):
    out = {"ok": False}
    try:
        _downloads(work, out)
    except BaseException:
        out["error"] = traceback.format_exc()[-2000:]
    # (and its own libtorrent, where the app has it: a big download's pieces, 2026-11-25)
    try:
        if HERE not in sys.path:
            sys.path.insert(0, HERE)
        import phonesys

        if phonesys.call("pieces-available").get("available"):
            out["pieces"] = pieces(work)
            out["ok"] = bool(out.get("ok") and out["pieces"].get("ok"))
    except BaseException:
        out["pieces"] = {"ok": False, "error": traceback.format_exc()[-1500:]}
        out["ok"] = False
    return out


def _bencode(x):
    if isinstance(x, int):
        return b"i%de" % x
    if isinstance(x, str):
        x = x.encode("utf-8")
    if isinstance(x, bytes):
        return b"%d:%s" % (len(x), x)
    if isinstance(x, list):
        return b"l" + b"".join(_bencode(v) for v in x) + b"e"
    return b"d" + b"".join(_bencode(k) + _bencode(x[k]) for k in sorted(x)) + b"e"


def pieces(work):
    """The app's own libtorrent (phonesys "pieces-start", as downloads.py starts a part by pieces): a file made here and
    its torrent; the part given all its pieces, already in its folder, which libtorrent checks and then has (done);
    then stopped, its progress kept (resume.dat)."""
    import phonesys

    folder, state = os.path.join(work, "pieces-data"), os.path.join(work, "pieces-state")
    for d in (folder, state):
        os.makedirs(d, exist_ok=True)
    size, plen = 16384 * 12 + 1000, 16384
    data = b"".join(hashlib.sha256(b"cluster %d" % i).digest() for i in range(size // 32 + 1))[:size]
    with open(os.path.join(folder, "pieces-check.bin"), "wb") as f:
        f.write(data)
    hashes = b"".join(hashlib.sha1(data[i:i + plen]).digest() for i in range(0, size, plen))
    n = len(hashes) // 20
    torrent = os.path.join(work, "pieces-check.torrent")
    with open(torrent, "wb") as f:
        f.write(_bencode({"info": {"name": "pieces-check.bin", "piece length": plen, "length": size, "pieces": hashes}}))
    out = {"ok": False, "pieces": n}
    out["start"] = phonesys.call("pieces-start", {"torrent": torrent, "folder": folder, "first": 0, "end": n, "state": state, "port": 51497})
    status = None
    for _ in range(60):
        try:
            with open(os.path.join(state, "status.json"), encoding="utf-8") as f:
                status = json.load(f)
            if status.get("done"):
                break
        except (OSError, ValueError):
            pass
        time.sleep(0.5)
    out["status"] = status
    out["running"] = bool(phonesys.call("pieces-running", {"state": state}).get("running"))
    phonesys.call("pieces-stop", {"state": state})
    out["stopped"] = not phonesys.call("pieces-running", {"state": state}).get("running")
    out["resume"] = os.path.exists(os.path.join(state, "resume.dat"))
    out["ok"] = bool(out["start"].get("ok") and status and status.get("done") and status.get("have") == n and out["running"] and out["stopped"])
    return out


def _rpc(port, method, args):
    """Transmission's remote control, as downloads.py's own() asks it (its session id first, when it asks for one)."""
    body = json.dumps({"method": method, "arguments": args}).encode("utf-8")
    sid = ""
    for _ in range(3):
        req = urllib.request.Request("http://127.0.0.1:%d/transmission/rpc" % port, data=body,
                                     headers={"Content-Type": "application/json", "X-Transmission-Session-Id": sid})
        try:
            with urllib.request.urlopen(req, timeout=5) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code != 409:
                raise
            sid = e.headers.get("X-Transmission-Session-Id", "")
    raise RuntimeError("Transmission gave no session id")


def _downloads(work, out):
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    import phonesys

    # (its own ports, beside the service's: 9094 and 51415)
    port, config, dest = 47894, os.path.join(work, "own-transmission"), os.path.join(work, "downloads")
    os.makedirs(config, exist_ok=True)
    os.makedirs(dest, exist_ok=True)
    with open(os.path.join(config, "settings.json"), "w", encoding="utf-8") as f:
        json.dump({"rpc-enabled": True, "rpc-port": port, "rpc-bind-address": "127.0.0.1", "rpc-whitelist-enabled": True,
                   "rpc-whitelist": "127.0.0.1,::1", "rpc-authentication-required": False, "rpc-host-whitelist-enabled": False,
                   "download-dir": dest, "incomplete-dir-enabled": False, "peer-port": 51499, "peer-port-random-on-start": False,
                   "port-forwarding-enabled": False, "dht-enabled": False, "lpd-enabled": False, "utp-enabled": False}, f, indent=4)
    first = phonesys.call("net")
    started = phonesys.call("transmission-start", {"config": config})
    session, said = None, None
    for _ in range(30):
        try:
            session = _rpc(port, "session-get", {"fields": ["version", "download-dir", "rpc-version"]}).get("arguments")
            break
        except Exception as e:
            said = str(e)[:300]
            time.sleep(1)
    running = phonesys.call("transmission-running").get("running")
    phonesys.call("transmission-stop")
    stopped = not phonesys.call("transmission-running").get("running")
    then = phonesys.call("net")
    out.update(start=started, session=session, running=running, stopped=stopped, net={"first": first, "then": then})
    if session is None:
        out["said"] = said
    counted = bool(first.get("ok") and then.get("ok") and int(then.get("rx", -1)) >= int(first.get("rx", 0)) >= 0)
    out["ok"] = bool(started.get("ok") and session and str(session.get("version", "")).startswith("4.1.4")
                     and os.path.basename(str(session.get("download-dir", "")).rstrip("/")) == "downloads" and running and stopped and counted)
