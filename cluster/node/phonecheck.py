"""
phonecheck.py - the iPhone build's simulator check of the Cluster app's own tools for the animal model's jobs
(ClusterMember.swift's selfTestAnimals, only when launched with -HTSelfTest, as build-iphone.yml does): in the app's
Python, its NumPy and Pillow; its HTTPS (the model fetched as a job fetches it, jobs.py's model_file: this project's
GitHub release, its SHA-256 checked); its ONNX Runtime (phonetools.onnxruntime(): the model run twice on one picture,
the same both times, its output as the model's should be); and the animal model's own script (jobs_animals.py, run as
a job runs it, in this Python) over a clip made here with the app's ffmpeg: its pictures, label proposals and list.

  animals(work) -> {"ok": bool, and what each part found}
"""

import hashlib
import json
import os
import sys
import time
import traceback
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
