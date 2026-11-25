#!/usr/bin/env python3
"""
jobs_animals.py - the animal model over one clip, for Cluster's jobs (modules/jobs.py runs it with
the Python it made for this, which has ONNX Runtime, NumPy and Pillow):

  python jobs_animals.py --video CLIP --model MODEL.onnx --names NAMES.json --out DIR --base NAME
                         [--every 1] [--score 0.25] [--threads 2] [--ffmpeg PATH] [--work DIR]

Makes, in DIR, what the label check pages read (as HandTrackerTraining's clip_frames.py does):
  images/train/NAME_MM-SS.S.jpg        a picture every EVERY seconds
  labels-proposed/train/NAME_….txt     the model's boxes on it from SCORE (YOLO: kind cx cy w h, 0-1)
and clips/NAME.json: the kinds in the clip, each with how many pictures it's in, when first and last,
and its best score (from 0.45, as Sentry's Track animals takes them). Prints "progress 0.42" as it
goes, and at the end "done {json}" (the counts).

The model sees each picture as the app's own object finder does (object-finder-worker.js): at most
640 on its longer side, in the middle of grey (114) sides up to multiples of 32 (or the model's own
fixed size), RGB 0-1; its output [1, 4 + kinds, places] read the same way, one box per thing.
Kinds' names: NAMES.json's (the app's), else the model's own metadata.
"""

import argparse
import ast
import glob
import json
import os
import subprocess
import sys

import numpy as np
from PIL import Image

PHONE = os.environ.get("HT_CLUSTER_PLATFORM") in ("android", "ios")
if PHONE:  # (the Cluster app on a phone: its own ONNX Runtime and ffmpeg, phonetools.py beside this)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import phonetools

    ort = phonetools.onnxruntime()
else:
    import onnxruntime as ort

SIZE, STRIDE, IOU, MAX_RESULTS = 640, 32, 0.5, 20
LIST_SCORE = 0.45  # (a kind counts as in the clip from this sure: Sentry's TRACK_SCORE)


def letterbox(img, fixed):
    w, h = img.size
    if fixed:
        W, H = fixed
        scale = min(W / w, H / h)
    else:
        scale = min(SIZE / w, SIZE / h)
    nw, nh = round(w * scale), round(h * scale)
    if not fixed:
        W, H = -(-nw // STRIDE) * STRIDE, -(-nh // STRIDE) * STRIDE
    dx, dy = (W - nw) // 2, (H - nh) // 2
    canvas = Image.new("RGB", (W, H), (114, 114, 114))
    canvas.paste(img.resize((nw, nh), Image.BILINEAR), (dx, dy))
    x = np.asarray(canvas, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
    return x, scale, dx, dy


def overlap(a, b):
    w = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    h = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - w * h
    return w * h / u if u > 0 else 0.0


def decode(out, scale, dx, dy, w, h, min_score):
    d = out[0]  # [4 + kinds, places]
    scores = d[4:]
    best = scores.argmax(axis=0)
    sure = scores[best, np.arange(scores.shape[1])]
    keep = np.nonzero(sure > min_score)[0]
    found = []
    for i in keep[np.argsort(-sure[keep])]:
        cx, cy, bw, bh = d[0, i], d[1, i], d[2, i], d[3, i]
        box = [min(1.0, max(0.0, v)) for v in (((cx - bw / 2 - dx) / scale) / w, ((cy - bh / 2 - dy) / scale) / h,
                                                 ((cx + bw / 2 - dx) / scale) / w, ((cy + bh / 2 - dy) / scale) / h)]
        found.append((int(best[i]), float(sure[i]), box))
    kept = []
    for f in found:
        if len(kept) >= MAX_RESULTS:
            break
        if not any(k[0] == f[0] and overlap(k[2], f[2]) > IOU for k in kept):
            kept.append(f)
    return kept


def names_of(session, given):
    if given:
        return given
    meta = session.get_modelmeta().custom_metadata_map or {}
    try:
        n = ast.literal_eval(meta.get("names", "{}"))
        return [n[k] for k in sorted(n)] if isinstance(n, dict) else list(n)
    except (ValueError, SyntaxError):
        return []


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--video", required=True)
    a.add_argument("--model", required=True)
    a.add_argument("--names")
    a.add_argument("--out", required=True)
    a.add_argument("--base", required=True)
    a.add_argument("--every", type=float, default=1.0)
    a.add_argument("--score", type=float, default=0.25)
    a.add_argument("--threads", type=int, default=2)
    a.add_argument("--ffmpeg", default="ffmpeg")
    a.add_argument("--work")
    o = a.parse_args()

    frames = o.work or os.path.join(o.out, "_frames")
    os.makedirs(frames, exist_ok=True)
    # The pictures: one every EVERY seconds, as JPEGs (about the label check's 92 quality).
    run = (lambda cmd, **kw: subprocess.CompletedProcess(cmd, *phonetools.run(cmd, 3600))) if PHONE else subprocess.run
    r = run([o.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", o.video,
                        "-vf", "fps=1/%g" % o.every, "-q:v", "2", "-threads", str(o.threads), os.path.join(frames, "%06d.jpg")],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print("ffmpeg: " + (r.stderr or "").strip()[-300:], flush=True)
        sys.exit(1)
    pics = sorted(glob.glob(os.path.join(frames, "*.jpg")))
    print("progress 0.05", flush=True)

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = max(1, o.threads)
    opts.inter_op_num_threads = 1
    session = ort.InferenceSession(o.model, sess_options=opts, providers=["CPUExecutionProvider"])
    given = {}
    if o.names and os.path.exists(o.names):
        with open(o.names, "r", encoding="utf-8") as f:
            given = json.load(f)
    names = names_of(session, given.get("names"))
    animals = set(given.get("animals") or [])
    inp = session.get_inputs()[0]
    shape = inp.shape
    fixed = (shape[3], shape[2]) if all(isinstance(v, int) for v in shape[2:4]) else None

    images = os.path.join(o.out, "images", "train")
    labels = os.path.join(o.out, "labels-proposed", "train")
    clips = os.path.join(o.out, "clips")
    for d in (images, labels, clips):
        os.makedirs(d, exist_ok=True)
    kinds, with_animal = {}, 0
    for n, pic in enumerate(pics):
        t = n * o.every
        name = "%s_%02d-%04.1f" % (o.base, int(t // 60), t % 60)
        img = Image.open(pic).convert("RGB")
        w, h = img.size
        x, scale, dx, dy = letterbox(img, fixed)
        out = session.run(None, {inp.name: x})[0]
        found = decode(out, scale, dx, dy, w, h, min(o.score, LIST_SCORE))
        os.replace(pic, os.path.join(images, name + ".jpg"))
        rows = []
        any_animal = False
        for kind, score, b in found:
            label = names[kind] if kind < len(names) else str(kind)
            if score >= o.score:
                rows.append("%d %.6f %.6f %.6f %.6f\n" % (kind, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2, b[2] - b[0], b[3] - b[1]))
            if score >= LIST_SCORE:
                is_animal = label in animals if animals else True
                any_animal = any_animal or is_animal
                k = kinds.setdefault(label, {"pictures": 0, "first": t, "last": t, "best": 0.0, "animal": is_animal})
                k["pictures"] += 1
                k["last"] = t
                k["best"] = max(k["best"], round(score, 3))
        with_animal += 1 if any_animal else 0
        with open(os.path.join(labels, name + ".txt"), "w", encoding="utf-8") as f:
            f.write("".join(rows))
        if n % 5 == 0 or n == len(pics) - 1:
            print("progress %.3f" % (0.05 + 0.95 * (n + 1) / max(1, len(pics))), flush=True)
    summary = {"clip": os.path.basename(o.video), "pictures": len(pics), "every": o.every, "withAnimal": with_animal, "kinds": kinds}
    with open(os.path.join(clips, o.base + ".json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=1)
    if not o.work:
        os.rmdir(frames)
    print("done " + json.dumps({"pictures": len(pics), "withAnimal": with_animal,
                                "kinds": {k: v["pictures"] for k, v in kinds.items()}}), flush=True)


if __name__ == "__main__":
    main()
