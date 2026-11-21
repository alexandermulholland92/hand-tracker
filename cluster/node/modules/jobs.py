"""
jobs.py - Pi Cluster module: jobs shared out across the Pis. One Pi keeps the cluster's job list and
its files (this Pi's "Keep the cluster's job list and files here"); each Pi with "Take jobs" on asks
it for work, one file at a time, and sends back what it made.

A job is one kind of work over a list of files (an item each):
  animals  the animal model over clips: each clip cut to a picture every few seconds (1), with the
           model's boxes as label check proposals (images/train, labels-proposed/train: what the
           label check pages read), and a list of the kinds in each clip and when (clips/<clip>.json;
           the job's finds.json and animals.json put them together)
  convert  videos converted to one of the Recording Converter's formats (the app sends its ffmpeg settings)
  command  a command line run for each file: {in} the file, {out} the folder for what it makes, {name}
           the file's name without its ending, {file} with it
  playable a video made one every device plays as it is (autoconvert.py's): each file's own plan
           (which streams, the picture copied or made H.264, scaled to 1080p, HDR made SDR) into an
           .mp4, put by the Pi that keeps the list where the file's "place" says (never over a file)
The files: recordings on any Pi (Hand Tracker's recordings folder: done by that Pi itself while it
takes jobs, else fetched by another), files sent from a computer to the Pi that keeps the list, or a
folder on that Pi. What's made goes to that Pi (~/ht-cluster-jobs/results/<job>/), where the app
lists it and saves it to a computer. A job whose params say "here" is done only by the Pi each file
is on (nothing sent over the Wi-Fi).

Files go between Pis one at a time each way (the user, 2026-11-21, when four Pis fetching videos
from pi at once swamped its Wi-Fi): a Pi asks the one that keeps the list for its turn to download a
file, or to send back what it made, and waits in line for it ("turn"); its own files need no turn.

When a Pi works: "Take jobs" on; not while its cameras run unless "Take jobs while its cameras run";
not on battery unless "Take jobs on battery" (and never under 25 %); not too hot (80 °C, again under
70), not short of memory. A job going while one of those changes is paused, and given back for
another Pi if it's still paused after 5 minutes. A job runs at low priority on two of the four cores,
or at high priority (this Pi's switch, or the job's own) on all of them, ahead of everything else
(the root helper sets that: the cameras may stutter).
"""

import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid

TITLE = "Jobs"
ORDER = 40
ON = True
EVERY = 3
SETTINGS = [
    {"key": "take", "title": "Take jobs", "default": True},
    {"key": "withCameras", "title": "Take jobs while its cameras run", "default": False},
    {"key": "onBattery", "title": "Take jobs on battery", "default": False},
    {"key": "high", "title": "Its jobs at high priority (all cores, ahead of everything: the cameras may stutter)", "default": False},
    {"key": "home", "title": "Keep the cluster's job list and files here", "default": False},
]

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PIECE = 4 << 20  # bytes per request, files going between Pis and to the app
MAX_PIECE = 16 << 20
LEASE_S = 90  # a Pi working on a file says so at least this often, or the file goes back on the list
GIVE_BACK_S = 300  # paused this long: given back for another Pi
HOT_C, COOL_C = 80, 70
MIN_MEMORY = 350 << 20
LOW_BATTERY = 25
OWNER_FRESH_S = 30  # a Pi that asked for work this lately keeps its own recordings for itself
MAX_TRIES = 3
TURN_STALE_S = 45  # a Pi with a turn, or in line for one, says so this often or loses its place
TURN_ASK_S = 3  # how often a Pi in line asks again
TURN_BEAT_S = 15  # how often a Pi moving a file says it still has its turn
TEXT_SUBS = {"subrip", "ass", "ssa", "mov_text", "webvtt", "text"}
VIDEO = re.compile(r"\.(mp4|webm|mkv|mov|avi|m4v|ts|mpg|mpeg|wmv|flv|3gp|ogv)$", re.I)
SAFE_NAME = re.compile(r"^[^/\\\x00-\x1f]{1,200}$")
SAFE_REL = re.compile(r"^[A-Za-z0-9 ._()+,=@'-]+(/[A-Za-z0-9 ._()+,=@'-]+)*$")
MODEL_URL = "https://github.com/alexandermulholland92/hand-tracker/releases/download/"

_lock = threading.RLock()  # (the job list, on the Pi that keeps it)
_book = {"jobs": None}  # the job list, loaded once
_seen = {}  # Pi -> when it last asked for work (that it's taking jobs now)
_run = {"item": None, "proc": None, "paused": False, "pausedAt": 0, "why": "", "stop": False, "progress": 0.0,
        "beat": 0, "home": None, "thread": None, "gave": None, "turn": None}
_state = {"why": "", "last": ""}
_tools = {"ready": None, "making": False, "error": None}
# (on the Pi that keeps the list: whose turn it is to move a file, and who's in line, each way)
_turns = {"down": {"holder": None, "beat": 0, "line": []}, "up": {"holder": None, "beat": 0, "line": []}}


# ----- where things are -----
def data_dir(node):
    d = os.environ.get("HT_CLUSTER_JOBS_DIR") if node.simulate else None
    return d or os.path.join(os.path.expanduser("~"), "ht-cluster-jobs")


def work_dir(node):
    return os.path.join(node.state_dir, "work") if node.simulate else os.path.join(os.path.expanduser("~"), ".cache", "ht-cluster", "work")


def env_dir(node):
    return os.path.join(os.path.expanduser("~"), ".local", "share", "ht-cluster", "jobs-env")


def recordings_dir(node):
    """Hand Tracker's remote recording folder here (its setting, else Documents/Hand Tracker recordings)."""
    if node.simulate and os.environ.get("HT_CLUSTER_SIM_RECORDINGS"):
        return os.environ["HT_CLUSTER_SIM_RECORDINGS"]
    try:
        with open(os.path.join(os.path.expanduser("~"), ".config", "Hand Tracker", "settings.json"), "r", encoding="utf-8") as f:
            d = json.load(f).get("remoteDir")
        if d:
            return d
    except (OSError, ValueError, AttributeError):
        pass
    return os.path.join(os.path.expanduser("~"), "Documents", "Hand Tracker recordings")


def ffmpeg(node):
    for p in (os.environ.get("HT_CLUSTER_FFMPEG") if node.simulate else None, "/usr/bin/ffmpeg",
              "/opt/Hand Tracker/resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg"):
        if p and os.path.exists(p):
            return p
    return shutil.which("ffmpeg")


def inside(path, folder):
    path, folder = os.path.realpath(path), os.path.realpath(folder)
    return path == folder or path.startswith(folder.rstrip(os.sep) + os.sep)


# ----- the job list (on the Pi that keeps it) -----
def is_home(node):
    return bool(node.setting("jobs", "home"))


def book(node):
    with _lock:
        if _book["jobs"] is None:
            try:
                with open(os.path.join(data_dir(node), "jobs.json"), "r", encoding="utf-8") as f:
                    _book["jobs"] = json.load(f).get("jobs") or []
            except (OSError, ValueError):
                _book["jobs"] = []
        return _book["jobs"]


def save(node):
    with _lock:
        d = data_dir(node)
        os.makedirs(d, exist_ok=True)
        tmp = os.path.join(d, "jobs.json.new")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"jobs": _book["jobs"] or []}, f)
        os.replace(tmp, os.path.join(d, "jobs.json"))


def job_of(node, jid):
    return next((j for j in book(node) if j["id"] == jid), None)


def counts(job):
    c = {"waiting": 0, "running": 0, "done": 0, "failed": 0, "stopped": 0, "uploading": 0}
    for it in job["items"]:
        c[it["state"]] = c.get(it["state"], 0) + 1
    return c


def settle(job):
    """The job's own state from its files'."""
    c = counts(job)
    if job["state"] in ("stopped", "uploading"):
        return
    if c["waiting"] or c["running"]:
        job["state"] = "running" if (c["running"] or c["done"] or c["failed"]) else "waiting"
    else:
        job["state"] = "done"
        job.setdefault("finished", time.time())


def expire(node):
    """Files whose Pi stopped saying it's on them: back on the list (failed after MAX_TRIES)."""
    now = time.time()
    changed = False
    with _lock:
        for j in book(node):
            for it in j["items"]:
                if it["state"] == "running" and it.get("until", 0) < now:
                    it["tries"] = it.get("tries", 0) + 1
                    who = it.get("worker")
                    it.update(state="waiting" if it["tries"] < MAX_TRIES else "failed", worker=None, lease=None,
                              error=None if it["tries"] < MAX_TRIES else "%s stopped answering %d times" % (who, it["tries"]))
                    changed = True
            settle(j)
        if changed:
            save(node)


def pick(node, worker, worker_can_reach):
    """The next file for this worker: its own recordings first; then the job list's own files and
    any other Pi's whose Pi isn't taking jobs itself (fetched from there)."""
    now = time.time()
    me = node.name
    fallback = None
    for j in sorted(book(node), key=lambda x: (not x.get("high"), x["created"])):
        if j["state"] not in ("waiting", "running"):
            continue
        here = bool(j["params"].get("here"))  # (done only where each file is)
        for it in j["items"]:
            if it["state"] != "waiting":
                continue
            src = it["source"]["node"]
            if src == worker:
                return j, it
            if fallback is None and not here:
                owner_busy = src != me and now - _seen.get(src, 0) < OWNER_FRESH_S
                if src == me or (not owner_busy and src in worker_can_reach):
                    fallback = (j, it)
    return fallback


def summarize_animals(node, job):
    """The job's finds.json (as clip_frames.py's) and animals.json (each clip's kinds) from its clips' lists."""
    clips_dir = os.path.join(data_dir(node), "results", job["id"], "clips")
    per_clip, totals, pictures, with_animal = {}, {}, 0, 0
    for name in sorted(os.listdir(clips_dir)) if os.path.isdir(clips_dir) else []:
        try:
            with open(os.path.join(clips_dir, name), "r", encoding="utf-8") as f:
                c = json.load(f)
        except (OSError, ValueError):
            continue
        per_clip[c.get("clip", name)] = c.get("kinds", {})
        pictures += int(c.get("pictures") or 0)
        with_animal += int(c.get("withAnimal") or 0)
        for kind, k in (c.get("kinds") or {}).items():
            t = totals.setdefault(kind, {"clips": 0, "pictures": 0, "animal": bool(k.get("animal"))})
            t["clips"] += 1
            t["pictures"] += int(k.get("pictures") or 0)
    out = os.path.join(data_dir(node), "results", job["id"])
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "finds.json"), "w", encoding="utf-8") as f:
        json.dump({"pictures": pictures, "with an animal proposed": with_animal, "finds": {k: v["pictures"] for k, v in totals.items()}}, f, indent=1)
    with open(os.path.join(out, "animals.json"), "w", encoding="utf-8") as f:
        json.dump({"clips": per_clip, "kinds": totals}, f, indent=1)
    job["summary"] = {"pictures": pictures, "withAnimal": with_animal,
                      "kinds": sorted(([k, v["clips"], v["pictures"], v["animal"]] for k, v in totals.items()), key=lambda r: (not r[3], -r[1]))}


# ----- actions: the app's, and the Pis' asking for work -----
def act_create(node, args):
    if not is_home(node):
        return {"ok": False, "error": "%s doesn't keep the job list." % node.name}
    kind = args.get("kind")
    if kind not in ("animals", "convert", "command", "playable"):
        return {"ok": False, "error": "Which kind of job?"}
    params = args.get("params") if isinstance(args.get("params"), dict) else {}
    if kind == "convert" and not (isinstance(params.get("args"), list) and all(isinstance(a, str) for a in params["args"]) and params.get("ext")):
        return {"ok": False, "error": "Which format?"}
    if kind == "command" and not str(params.get("command") or "").strip():
        return {"ok": False, "error": "Which command?"}
    if kind == "animals":
        m = params.get("model") or {}
        if not ((m.get("url", "").startswith(MODEL_URL) and re.fullmatch(r"[0-9a-f]{64}", str(m.get("sha256", "")))) or m.get("upload")):
            return {"ok": False, "error": "Which model?"}
    jid = "j%s-%s" % (time.strftime("%Y%m%d-%H%M%S"), uuid.uuid4().hex[:4])
    items = []
    for i, s in enumerate(args.get("files") or []):
        if not isinstance(s, dict) or not SAFE_NAME.match(str(s.get("name") or "")):
            continue
        if s.get("upload"):
            items.append({"name": s["name"], "size": int(s.get("size") or 0), "source": {"node": node.name, "path": os.path.join(data_dir(node), "inputs", jid, s["name"])}, "state": "uploading"})
        elif s.get("node") and s.get("path"):
            items.append({"name": s["name"], "size": int(s.get("size") or 0), "source": {"node": str(s["node"]), "path": str(s["path"])}, "state": "waiting"})
        else:
            continue
        if kind == "playable":  # (each file its own plan, and where what's made goes)
            if not isinstance(s.get("plan"), dict):
                items.pop()
                continue
            items[-1]["plan"] = s["plan"]
            if isinstance(s.get("place"), str) and os.path.isabs(s["place"]):
                items[-1]["place"] = s["place"]
    folder = str(args.get("folder") or "")
    if folder and kind != "playable":  # (a playable file comes with its plan)
        if not os.path.isdir(folder):
            return {"ok": False, "error": "No folder %s on %s." % (folder, node.name)}
        for name in sorted(os.listdir(folder)):
            p = os.path.join(folder, name)
            if os.path.isfile(p) and (kind == "command" or VIDEO.search(name)):
                items.append({"name": name, "size": os.path.getsize(p), "source": {"node": node.name, "path": p}, "state": "waiting"})
    if not items:
        return {"ok": False, "error": "No files for it." + (" (Only videos are taken for this kind of job.)" if folder and kind != "command" else "")}
    for n, it in enumerate(items):
        it.update(id="i%d" % (n + 1), worker=None, lease=None, until=0, progress=0, tries=0, error=None, summary=None)
    uploading = any(it["state"] == "uploading" for it in items) or bool((params.get("model") or {}).get("upload"))
    job = {"id": jid, "kind": kind, "title": str(args.get("title") or kind)[:120], "created": time.time(), "high": bool(args.get("high")),
           "params": params, "state": "uploading" if uploading else "waiting", "items": items, "summary": None}
    with _lock:
        book(node).append(job)
        save(node)
    node.event("jobs", "New job: %s (%d file%s)" % (job["title"], len(items), "" if len(items) == 1 else "s"))
    return {"ok": True, "job": jid, "uploads": [it["name"] for it in items if it["state"] == "uploading"]}


def act_start(node, args):
    with _lock:
        job = job_of(node, args.get("job"))
        if not job:
            return {"ok": False, "error": "No such job."}
        for it in job["items"]:
            if it["state"] == "uploading":
                p = it["source"]["path"]
                if not os.path.isfile(p) or (it["size"] and os.path.getsize(p) != it["size"]):
                    return {"ok": False, "error": "%s hasn't all arrived." % it["name"]}
                it["state"] = "waiting"
        upload = (job["params"].get("model") or {}).get("upload")
        if upload and not os.path.isfile(os.path.join(data_dir(node), "inputs", job["id"], upload)):
            return {"ok": False, "error": "The model file hasn't arrived."}
        if job["state"] == "uploading":
            job["state"] = "waiting"
        settle(job)
        save(node)
    return {"ok": True, "message": "Started %s." % job["title"]}


def act_stop(node, args):
    with _lock:
        job = job_of(node, args.get("job"))
        if not job:
            return {"ok": False, "error": "No such job."}
        for it in job["items"]:
            if it["state"] in ("waiting", "uploading"):
                it["state"] = "stopped"
            # (a running one: its Pi is told at its next word, and stops)
        job["state"] = "stopped"
        save(node)
    return {"ok": True, "message": "Stopping %s." % job["title"]}


def act_again(node, args):
    """Its stopped and failed files back on the list."""
    with _lock:
        job = job_of(node, args.get("job"))
        if not job:
            return {"ok": False, "error": "No such job."}
        n = 0
        for it in job["items"]:
            if it["state"] in ("stopped", "failed"):
                it.update(state="waiting", tries=0, error=None, worker=None, lease=None)
                n += 1
        job["state"] = "waiting"
        job.pop("finished", None)
        settle(job)
        save(node)
    return {"ok": True, "message": "%d file%s back on the list." % (n, "" if n == 1 else "s")}


def act_remove(node, args):
    with _lock:
        job = job_of(node, args.get("job"))
        if not job:
            return {"ok": False, "error": "No such job."}
        if any(it["state"] == "running" for it in job["items"]):
            return {"ok": False, "error": "It's still being worked on: stop it first."}
        _book["jobs"] = [j for j in book(node) if j["id"] != job["id"]]
        save(node)
    for sub in ("inputs", "results"):
        shutil.rmtree(os.path.join(data_dir(node), sub, job["id"]), ignore_errors=True)
    try:
        os.remove(os.path.join(data_dir(node), "zips", job["id"] + ".zip"))
    except OSError:
        pass
    node.event("jobs", "Removed the job %s and its files." % job["title"])
    return {"ok": True, "message": "Removed %s." % job["title"]}


def brief(job, items=False):
    out = {k: job.get(k) for k in ("id", "kind", "title", "created", "finished", "high", "state", "summary")}
    out["counts"] = counts(job)
    out["files"] = len(job["items"])
    out["working"] = sorted({it["worker"] for it in job["items"] if it["state"] == "running" and it.get("worker")})
    out["params"] = {k: v for k, v in job["params"].items() if k in ("every", "format", "command", "label", "modelName")}
    if items:
        out["items"] = [{k: it.get(k) for k in ("id", "name", "size", "state", "worker", "progress", "error", "summary", "placed")} | {"from": it["source"]["node"]} for it in job["items"]]
    return out


def act_list(node, args):
    if not is_home(node):
        return {"ok": False, "error": "%s doesn't keep the job list." % node.name}
    return {"ok": True, "jobs": [brief(j) for j in sorted(book(node), key=lambda x: -x["created"])]}


def act_items(node, args):
    job = job_of(node, args.get("job"))
    return {"ok": True, "job": brief(job, items=True)} if job else {"ok": False, "error": "No such job."}


def act_results(node, args):
    job = job_of(node, args.get("job"))
    if not job:
        return {"ok": False, "error": "No such job."}
    root = os.path.join(data_dir(node), "results", job["id"])
    files = []
    for d, _, names in os.walk(root):
        for n in names:
            if n.endswith(".part"):
                continue
            p = os.path.join(d, n)
            files.append({"path": os.path.relpath(p, root).replace(os.sep, "/"), "size": os.path.getsize(p)})
    return {"ok": True, "files": sorted(files, key=lambda f: f["path"]), "title": job["title"]}


def act_zip(node, args):
    """A job's results as one zip (for a phone: saved whole in its Downloads), made again only if
    they've changed since: {name, size}; then GET /api/jobs/zip-file?job=&at= a piece at a time."""
    job = job_of(node, args.get("job"))
    if not job:
        return {"ok": False, "error": "No such job."}
    root = os.path.join(data_dir(node), "results", job["id"])
    files = []
    for d, _, names in os.walk(root):
        for n in names:
            if not n.endswith(".part"):
                files.append(os.path.join(d, n))
    if not files:
        return {"ok": False, "error": "It has no results yet."}
    zips = os.path.join(data_dir(node), "zips")
    os.makedirs(zips, exist_ok=True)
    path = os.path.join(zips, job["id"] + ".zip")
    newest = max(os.path.getmtime(f) for f in files)
    if not os.path.exists(path) or os.path.getmtime(path) < newest:
        import zipfile
        with zipfile.ZipFile(path + ".part", "w", zipfile.ZIP_STORED, allowZip64=True) as z:  # (pictures and videos don't shrink)
            for f in sorted(files):
                z.write(f, os.path.relpath(f, root).replace(os.sep, "/"))
        os.replace(path + ".part", path)
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", job["title"]).strip() or job["id"]
    return {"ok": True, "name": name + ".zip", "size": os.path.getsize(path)}


def route_zip_file(node, h, q):
    job = job_of(node, q.get("job")) if is_home(node) else None
    path = os.path.join(data_dir(node), "zips", job["id"] + ".zip") if job else None
    return read_piece(node, h, path, q)


def act_browse(node, args):
    path = os.path.expanduser(str(args.get("path") or "~"))
    if not os.path.isdir(path):
        return {"ok": False, "error": "No folder %s here." % path}
    folders, files = [], []
    try:
        for e in sorted(os.scandir(path), key=lambda e: e.name.lower()):
            if e.name.startswith("."):
                continue
            if e.is_dir():
                folders.append(e.name)
            elif e.is_file():
                files.append({"name": e.name, "size": e.stat().st_size, "video": bool(VIDEO.search(e.name))})
    except OSError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "path": os.path.realpath(path), "parent": os.path.dirname(os.path.realpath(path)), "folders": folders[:500], "files": files[:2000]}


def act_recordings(node, args):
    d = recordings_dir(node)
    out = []
    try:
        for e in os.scandir(d):
            if e.is_file() and VIDEO.search(e.name) and not e.name.startswith("."):
                st = e.stat()
                out.append({"name": e.name, "path": e.path, "size": st.st_size, "at": int(st.st_mtime * 1000), "sentry": e.name.startswith("Sentry_")})
    except OSError:
        pass
    return {"ok": True, "folder": d, "recordings": sorted(out, key=lambda r: -r["at"])[:1000]}


def act_lease(node, args):
    """A Pi asking for work: {worker, reach: [the Pis it can fetch files from]} -> an item, or none."""
    if not is_home(node):
        return {"ok": False, "error": "%s doesn't keep the job list." % node.name}
    worker = str(args.get("worker") or "")
    with _lock:
        _seen[worker] = time.time()
        expire(node)
        got = pick(node, worker, set(args.get("reach") or []) | {node.name})
        if not got:
            return {"ok": True, "item": None}
        job, it = got
        it.update(state="running", worker=worker, lease=uuid.uuid4().hex, until=time.time() + LEASE_S, progress=0, started=time.time(), error=None)
        settle(job)
        save(node)
        upload = (job["params"].get("model") or {}).get("upload")
        return {"ok": True, "item": {"job": job["id"], "kind": job["kind"], "title": job["title"], "high": job["high"], "params": job["params"],
                                     "id": it["id"], "name": it["name"], "size": it["size"], "source": it["source"], "lease": it["lease"],
                                     "plan": it.get("plan"),
                                     "modelPath": os.path.join(data_dir(node), "inputs", job["id"], upload) if upload else None}}


def find_lease(node, lease):
    for j in book(node):
        for it in j["items"]:
            if lease and it.get("lease") == lease and it["state"] == "running":
                return j, it
    return None, None


def act_progress(node, args):
    with _lock:
        job, it = find_lease(node, args.get("lease"))
        if not it:
            return {"ok": True, "stop": True}  # (given to another Pi meanwhile, or the job removed)
        it["until"] = time.time() + LEASE_S
        it["progress"] = max(0.0, min(1.0, float(args.get("progress") or 0)))
        it["paused"] = args.get("paused") or None
        stop = job["state"] == "stopped"
    return {"ok": True, "stop": stop}


def act_finish(node, args):
    placing = None
    with _lock:
        job, it = find_lease(node, args.get("lease"))
        if not it:
            return {"ok": True}
        if args.get("giveBack"):
            it.update(state="waiting", worker=None, lease=None, progress=0)
        elif args.get("ok"):
            it.update(state="done", lease=None, progress=1, finished=time.time(), summary=args.get("summary"))
            if job["kind"] == "playable" and it.get("place"):
                placing = (job["id"], it)
        else:
            it.update(state="stopped" if job["state"] == "stopped" else "failed", lease=None, finished=time.time(), error=str(args.get("error") or "it failed")[:500])
        settle(job)
        if job["kind"] == "animals":
            summarize_animals(node, job)
        save(node)
        done = job["state"] == "done"
    if placing:  # (a move on this drive is at once; another drive's copy could take a while)
        threading.Thread(target=place_result, args=(node,) + placing, daemon=True).start()
    if done:
        c = counts(job)
        node.event("jobs", "Job done: %s (%d of %d files%s)" % (job["title"], c["done"], len(job["items"]), ", %d failed" % c["failed"] if c["failed"] else ""), bad=bool(c["failed"]))
    return {"ok": True}


def place_result(node, jid, it):
    """What a playable file made, put where its place says (beside its video): never over a file there."""
    src = os.path.join(data_dir(node), "results", jid, os.path.splitext(it["name"])[0] + ".mp4")
    dst = it["place"]
    try:
        if os.path.exists(dst):
            word = "already there"
        elif not os.path.isfile(src):
            word = "nothing made"
        else:
            try:
                os.replace(src, dst)  # (the same drive: at once)
            except OSError:
                shutil.copyfile(src, dst + ".part")
                os.replace(dst + ".part", dst)
                os.remove(src)
            word = "placed"
    except OSError as e:
        word = "couldn't place it: %s" % e
    with _lock:
        it["placed"] = word
        save(node)


def act_turn(node, args):
    """A Pi's turn to move a file to or from here, one at a time each way, in the order they asked:
    {lane: down|up, worker, done?} -> {go: true} (its turn: said again at least every TURN_STALE_S
    while the file moves) or {go: false, ahead: how many before it}."""
    if not is_home(node):
        return {"ok": False, "error": "%s doesn't keep the job list." % node.name}
    lane, worker = args.get("lane"), str(args.get("worker") or "")
    if lane not in _turns or not worker:
        return {"ok": False, "error": "Which turn?"}
    now = time.time()
    with _lock:
        t = _turns[lane]
        if t["holder"] and now - t["beat"] > TURN_STALE_S:  # (a Pi that stopped saying it has its turn)
            t["holder"] = None
        t["line"] = [w for w in t["line"] if now - w[1] <= TURN_STALE_S and w[0] != t["holder"]]
        if args.get("done"):
            if t["holder"] == worker:
                t["holder"] = None
            t["line"] = [w for w in t["line"] if w[0] != worker]
            return {"ok": True, "go": False}
        if t["holder"] == worker:
            t["beat"] = now
            return {"ok": True, "go": True}
        mine = next((w for w in t["line"] if w[0] == worker), None)
        if mine:
            mine[1] = now
        else:
            t["line"].append([worker, now])
        if t["holder"] is None and t["line"][0][0] == worker:
            t["line"].pop(0)
            t.update(holder=worker, beat=now)
            return {"ok": True, "go": True}
        return {"ok": True, "go": False, "ahead": (1 if t["holder"] else 0) + [w[0] for w in t["line"]].index(worker)}


def act_tools(node, args):
    """The animal model's Python tools made now (once per Pi)."""
    threading.Thread(target=make_tools, args=(node,), daemon=True).start()
    return {"ok": True, "message": "Getting the animal model's tools ready on %s (a few minutes, once)." % node.name}


ACTIONS = {
    "create": {"run": act_create, "hidden": True},
    "start": {"run": act_start, "hidden": True},
    "stop": {"run": act_stop, "hidden": True},
    "again": {"run": act_again, "hidden": True},
    "remove": {"run": act_remove, "hidden": True},
    "list": {"run": act_list, "hidden": True},
    "items": {"run": act_items, "hidden": True},
    "results": {"run": act_results, "hidden": True},
    "zip": {"run": act_zip, "hidden": True},
    "browse": {"run": act_browse, "hidden": True},
    "recordings": {"run": act_recordings, "hidden": True},
    "lease": {"run": act_lease, "hidden": True},
    "progress": {"run": act_progress, "hidden": True},
    "finish": {"run": act_finish, "hidden": True},
    "turn": {"run": act_turn, "hidden": True},
    "tools": {"title": "Get the animal model's tools ready", "run": act_tools},
}


# ----- files: sent here, and fetched from here -----
def route_upload(node, h, q):
    """A piece of a file sent from a computer for a job (PUT ?job=&name=&at=)."""
    job = job_of(node, q.get("job")) if is_home(node) else None
    name = str(q.get("name") or "")
    if not job or job["state"] != "uploading":
        return node.send(h, 409, {"error": "That job isn't taking files."})
    it = next((i for i in job["items"] if i["name"] == name and i["state"] == "uploading"), None)
    model = (job["params"].get("model") or {}).get("upload")
    if not it and name != model:
        return node.send(h, 400, {"error": "That file isn't one of the job's."})
    return write_piece(node, h, os.path.join(data_dir(node), "inputs", job["id"], name), q)


def route_result(node, h, q):
    """A piece of something a Pi made (PUT ?lease=&path=&at=)."""
    job, it = find_lease(node, q.get("lease"))
    rel = str(q.get("path") or "")
    if not it:
        return node.send(h, 409, {"error": "That work isn't this Pi's any more."})
    if not SAFE_REL.match(rel) or ".." in rel.split("/"):
        return node.send(h, 400, {"error": "Not a name it can take."})
    return write_piece(node, h, os.path.join(data_dir(node), "results", job["id"], *rel.split("/")), q)


def write_piece(node, h, path, q):
    try:
        at = int(q.get("at") or 0)
    except ValueError:
        return node.send(h, 400, {"error": "Where in the file?"})
    data = node.body_bytes(h, MAX_PIECE)
    if data is None:
        return node.send(h, 413, {"error": "Too big a piece."})
    part = path + ".part"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    have = os.path.getsize(part) if os.path.exists(part) else 0
    if at != have:
        return node.send(h, 409, {"error": "Out of turn", "have": have})
    with open(part, "ab") as f:
        f.write(data)
    if q.get("last") == "1":
        os.replace(part, path)
    return node.send(h, 200, {"ok": True, "have": at + len(data)})


def shared(node, path):
    """Whether this Pi lets another fetch this file: its recordings, the job list's files and results,
    and (on the Pi that keeps the list) any job's own files."""
    if not os.path.isfile(path):
        return False
    if inside(path, recordings_dir(node)) or inside(path, data_dir(node)):
        return True
    if is_home(node):
        return any(it["source"]["path"] == path for j in book(node) for it in j["items"])
    return False


def route_file(node, h, q):
    path = str(q.get("path") or "")
    return read_piece(node, h, path if shared(node, path) else None, q)


def route_result_file(node, h, q):
    job = job_of(node, q.get("job")) if is_home(node) else None
    rel = str(q.get("path") or "")
    if not job or not SAFE_REL.match(rel) or ".." in rel.split("/"):
        return node.send(h, 404, {"error": "No such file."})
    return read_piece(node, h, os.path.join(data_dir(node), "results", job["id"], *rel.split("/")), q)


def read_piece(node, h, path, q):
    if not path or not os.path.isfile(path):
        return node.send(h, 404, {"error": "No such file."})
    try:
        at = max(0, int(q.get("at") or 0))
    except ValueError:
        at = 0
    with open(path, "rb") as f:
        f.seek(at)
        data = f.read(PIECE)
    return node.send_bytes(h, 200, data)


ROUTES = {
    "PUT /api/jobs/upload": route_upload,
    "PUT /api/jobs/result": route_result,
    "GET /api/jobs/file": route_file,
    "GET /api/jobs/result-file": route_result_file,
    "GET /api/jobs/zip-file": route_zip_file,
}


# ----- working: on each Pi that takes jobs -----
_looked = {"at": 0}


def find_home(node):
    if is_home(node):
        return {"name": node.name, "target": node.target()}
    for fresh in (False, True):
        if fresh:  # (not among the Pis seen in the last minute: looked for again, every 15 s at most)
            if time.time() - _looked["at"] < 15:
                break
            _looked["at"] = time.time()
        for p in node.cluster(fresh=fresh):
            j = next((m for m in p["node"].get("modules", []) if m["name"] == "jobs"), None)
            if j and j.get("on") and (j.get("status") or {}).get("home"):
                return {"name": p["name"], "target": p["target"]}
    return None


def ask_home(node, home, action, args, timeout=30):
    if home["name"] == node.name:
        a = ACTIONS[action]["run"](node, args)
        return 200, a
    return node.ask(home["target"], "POST", "/api/action", {"module": "jobs", "action": action, "args": args}, timeout=timeout)


def reasons(node, running=False):
    """Why this Pi shouldn't work on a job now ("" if it may)."""
    if not node.setting("jobs", "take"):
        return "Not taking jobs (its switch is off)"
    health = node.status_of("health")
    temp = health.get("tempC")
    if temp is not None and (temp >= HOT_C or (running and _run["paused"] and temp > COOL_C and _run["why"].startswith("Too hot"))):
        return "Too hot (%d °C)" % temp
    mem = health.get("memory") or {}
    if mem.get("available") is not None and mem["available"] < MIN_MEMORY:
        return "Short of memory"
    power = health.get("power") or {}
    if power.get("source") == "battery":
        if not node.setting("jobs", "onBattery"):
            return "On battery"
        if power.get("level") is not None and power["level"] < LOW_BATTERY and not power.get("charging"):
            return "Battery low (%d %%)" % power["level"]
    if not node.setting("jobs", "withCameras"):
        rig = node.modules.get("rig")
        if rig and hasattr(rig.mod, "cameras_running") and rig.mod.cameras_running(node, fresh=not running):
            return "Its cameras are running"
    return ""


def pause(on):
    p = _run["proc"]
    if not p or p.poll() is not None or not hasattr(os, "killpg"):
        return
    try:
        os.killpg(p.pid, signal.SIGSTOP if on else signal.SIGCONT)
    except OSError:
        pass


def stop_proc():
    p = _run["proc"]
    if p and p.poll() is None:
        try:
            if hasattr(os, "killpg"):
                os.killpg(p.pid, signal.SIGCONT)
                os.killpg(p.pid, signal.SIGTERM)
            else:
                p.terminate()
            p.wait(10)
        except (OSError, subprocess.TimeoutExpired):
            try:
                os.killpg(p.pid, signal.SIGKILL) if hasattr(os, "killpg") else p.kill()
            except OSError:
                pass


def tick(node):
    if is_home(node):
        expire(node)
    if _run["item"]:
        watch(node)
        return
    why = reasons(node)
    _state["why"] = why
    if why:
        return
    home = find_home(node)
    if not home:
        _state["why"] = "No Pi keeps the job list yet"
        return
    reach = [p["name"] for p in node.cluster()]
    code, a = ask_home(node, home, "lease", {"worker": node.name, "reach": reach})
    if code != 200 or not isinstance(a, dict):
        _state["why"] = "Can't reach %s, which keeps the job list" % home["name"]
        return
    item = a.get("item")
    if not item:
        _state["why"] = ""
        return
    _run.update(item=item, proc=None, paused=False, pausedAt=0, why="", stop=False, progress=0.0, beat=0, home=home, gave=None, turn=None)
    t = threading.Thread(target=work, args=(node, item, home), daemon=True, name="job-" + item["id"])
    _run["thread"] = t
    t.start()


def watch(node):
    """While a file's being worked on: pause and go on as this Pi's state changes; say how it's going."""
    why = reasons(node, running=True)
    if why and why.startswith("Not taking"):
        _run["stop"] = "give back"
    elif why and not _run["paused"]:
        pause(True)
        _run.update(paused=True, pausedAt=time.time(), why=why)
    elif not why and _run["paused"]:
        pause(False)
        _run.update(paused=False, why="")
    elif why:
        _run["why"] = why
        if time.time() - _run["pausedAt"] > GIVE_BACK_S:
            _run["stop"] = "give back"
    if _run["stop"]:
        stop_proc()
    if time.time() - _run["beat"] > 20:
        _run["beat"] = time.time()
        code, a = ask_home(node, _run["home"], "progress", {"lease": _run["item"]["lease"], "progress": _run["progress"], "paused": _run["why"] if _run["paused"] else None}, timeout=15)
        if code == 200 and isinstance(a, dict) and a.get("stop") and not _run["stop"]:
            _run["stop"] = "stopped"
            stop_proc()


def launch(node, cmd, high, cwd=None, env=None):
    """A job's program: in a process group of its own (to pause it whole), at low priority on two
    cores, or (high) on all of them, ahead of everything (the root helper renices it)."""
    prefix = []
    if os.name == "posix" and not high:
        prefix = ["nice", "-n", "15"] + (["ionice", "-c3"] if shutil.which("ionice") else [])
        if (os.cpu_count() or 1) >= 4 and shutil.which("taskset"):
            prefix += ["taskset", "-c", "2,3"]
    e = dict(os.environ, HT_CLUSTER_JOB="1", **(env or {}))
    kw = {"start_new_session": True} if os.name == "posix" else {}
    if isinstance(cmd, str):  # (a command line as it is: Windows's cmd, for the checks)
        p = subprocess.Popen(cmd, shell=True, cwd=cwd, env=e, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    else:
        p = subprocess.Popen(prefix + cmd, cwd=cwd, env=e, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, **kw)
    _run["proc"] = p
    if high and not node.simulate:
        time.sleep(0.5)
        node.root("renice-jobs", timeout=60)
    return p


def high_for(node, item):
    return bool(item.get("high") or node.setting("jobs", "high"))


def take_turn(node, home, lane, name):
    """Waits in line for this Pi's turn to move a file to (up) or from (down) the Pi that keeps the
    list: one at a time each way, so its Wi-Fi isn't swamped. A list kept by a Pi without turns (one
    not updated yet) says it can't: no waiting then."""
    word = "download" if lane == "down" else "send back"
    try:
        while True:
            if _run["stop"]:
                raise RuntimeError("stopped")
            code, a = ask_home(node, home, "turn", {"lane": lane, "worker": node.name}, timeout=15)
            if code in (400, 409) or (code == 200 and isinstance(a, dict) and a.get("go")):
                return
            ahead = a.get("ahead") if code == 200 and isinstance(a, dict) else None
            _run["turn"] = "Waiting its turn to %s %s%s" % (word, name, " (%d before it)" % ahead if ahead else "")
            time.sleep(TURN_ASK_S)
    finally:
        _run["turn"] = None


def keep_turn(node, home, lane):
    ask_home(node, home, "turn", {"lane": lane, "worker": node.name}, timeout=15)


def end_turn(node, home, lane):
    ask_home(node, home, "turn", {"lane": lane, "worker": node.name, "done": True}, timeout=15)


def fetch(node, item, home, dest):
    """The file to work on: here already (its own recording), else fetched from where it is, in its turn."""
    src = item["source"]
    if src["node"] == node.name and os.path.isfile(src["path"]):
        return src["path"]
    target = home["target"] if src["node"] == home["name"] else next((p["target"] for p in node.cluster() if p["name"] == src["node"]), None)
    if not target:
        raise RuntimeError("%s, which has the file, isn't answering" % src["node"])
    take_turn(node, home, "down", item["name"])
    try:
        at, beat = 0, time.time()
        with open(dest, "wb") as f:
            while True:
                if _run["stop"]:
                    raise RuntimeError("stopped")
                code, data = node.ask(target, "GET", "/api/jobs/file?path=%s&at=%d" % (urllib.parse.quote(src["path"]), at), timeout=60)
                if code != 200 or not isinstance(data, bytes):
                    raise RuntimeError("couldn't fetch %s from %s: %s" % (item["name"], src["node"], (data or {}).get("error") if isinstance(data, dict) else data))
                if not data:
                    break
                f.write(data)
                at += len(data)
                if item.get("size"):
                    _run["progress"] = 0.1 * min(1.0, at / float(item["size"]))
                if time.time() - beat > TURN_BEAT_S:
                    keep_turn(node, home, "down")
                    beat = time.time()
                if len(data) < PIECE:
                    break
    finally:
        end_turn(node, home, "down")
    return dest


def send_results(node, item, home, out_dir):
    files = []
    for d, _, names in os.walk(out_dir):
        for n in names:
            files.append(os.path.join(d, n))
    rels = []
    for p in files:
        rel = os.path.relpath(p, out_dir).replace(os.sep, "/")
        rels.append(rel if SAFE_REL.match(rel) else re.sub(r"[^A-Za-z0-9 ._()+,=@'/-]", "_", rel))
    if not files:
        return
    if home["name"] == node.name:  # (here: moved, not copied, on the same drive)
        for p, rel in zip(files, rels):
            dest = os.path.join(data_dir(node), "results", item["job"], *rel.split("/"))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            try:
                os.replace(p, dest)
            except OSError:
                shutil.copyfile(p, dest)
        return
    take_turn(node, home, "up", item["name"])
    try:
        beat = time.time()
        for p, rel in zip(files, rels):
            size = os.path.getsize(p)
            at = 0
            with open(p, "rb") as f:
                while True:
                    if _run["stop"]:
                        raise RuntimeError("stopped")
                    data = f.read(PIECE)
                    last = at + len(data) >= size
                    q = "lease=%s&path=%s&at=%d&last=%d" % (item["lease"], urllib.parse.quote(rel), at, 1 if last else 0)
                    code, a = node.ask(home["target"], "PUT", "/api/jobs/result?" + q, data=data, timeout=120)
                    if code != 200:
                        raise RuntimeError("couldn't send %s: %s" % (rel, (a or {}).get("error") if isinstance(a, dict) else a))
                    at += len(data)
                    if time.time() - beat > TURN_BEAT_S:
                        keep_turn(node, home, "up")
                        beat = time.time()
                    if last:
                        break
    finally:
        end_turn(node, home, "up")


def run_logged(p, on_line):
    tail = []
    for line in p.stdout:
        line = line.rstrip()
        on_line(line)
        tail = (tail + [line])[-40:]
    p.wait()
    return p.returncode, tail


def duration_of(node, path):
    code, out, err = node.run([ffmpeg(node), "-hide_banner", "-nostdin", "-i", path], 30)
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", out + err)
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else 0.0


def do_convert(node, item, src, out_dir):
    p = item["params"]
    ff = ffmpeg(node)
    if not ff:
        raise RuntimeError("no ffmpeg on %s" % node.name)
    total = duration_of(node, src)
    base = os.path.splitext(item["name"])[0]
    out = os.path.join(out_dir, "%s%s.%s" % (base, p.get("suffix") or "", p["ext"]))
    proc = launch(node, [ff, "-hide_banner", "-nostdin", "-y", "-i", src] + list(p["args"]) + ["-progress", "pipe:1", "-nostats", out], high_for(node, item))

    def line(l):
        m = re.match(r"out_time_(?:ms|us)=(\d+)", l)
        if m and total > 0:
            _run["progress"] = 0.1 + 0.85 * min(1.0, int(m.group(1)) / 1e6 / total)
    code, tail = run_logged(proc, line)
    if code != 0:
        raise RuntimeError(stopped_or("ffmpeg: " + " / ".join(tail[-3:])))
    return {"output": os.path.basename(out), "size": os.path.getsize(out)}


def playable_args(plan):
    """ffmpeg's options for a copy every device plays as it is (autoconvert.py's plan for the file): its
    picture (copied, or H.264 8-bit: scaled to 1080p if bigger, HDR's colours made SDR's), every sound
    track as AAC stereo, its text subtitles (picture ones can't go in an .mp4: the original keeps them)."""
    args = ["-map", "0:%d" % int(plan["v"])]
    for i in plan.get("audio") or []:
        args += ["-map", "0:%d" % int(i)]
    for i in plan.get("subs") or []:
        args += ["-map", "0:%d" % int(i)]
    if plan.get("video") == "copy":
        args += ["-c:v", "copy"]
    else:
        vf = []
        if plan.get("scale"):  # (first: the rest then works on a quarter of the picture)
            vf.append("scale=1920:-2" if plan.get("wide", True) else "scale=-2:1080")
        if plan.get("hdr"):
            vf.append("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv")
        vf.append("format=yuv420p")
        args += ["-vf", ",".join(vf), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-profile:v", "high"]
        if plan.get("hdr"):  # (said as SDR, so no player takes it for HDR)
            args += ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
    args += ["-c:a", "aac", "-b:a", "160k", "-ac", "2"] if plan.get("audio") else ["-an"]
    args += ["-c:s", "mov_text"] if plan.get("subs") else ["-sn"]
    return args + ["-dn", "-movflags", "+faststart"]


def do_playable(node, item, src, out_dir):
    ff = ffmpeg(node)
    if not ff:
        raise RuntimeError("no ffmpeg on %s" % node.name)
    plan = item.get("plan") or {}
    total = float(plan.get("duration") or 0) or duration_of(node, src)
    out = os.path.join(out_dir, os.path.splitext(item["name"])[0] + ".mp4")
    proc = launch(node, [ff, "-hide_banner", "-nostdin", "-y", "-i", src] + playable_args(plan) + ["-progress", "pipe:1", "-nostats", out], high_for(node, item))

    def line(l):
        m = re.match(r"out_time_(?:ms|us)=(\d+)", l)
        if m and total > 0:
            _run["progress"] = 0.1 + 0.85 * min(1.0, int(m.group(1)) / 1e6 / total)
    code, tail = run_logged(proc, line)
    if code != 0:
        raise RuntimeError(stopped_or("ffmpeg: " + " / ".join(tail[-3:])))
    return {"output": os.path.basename(out), "size": os.path.getsize(out)}


def do_command(node, item, src, out_dir, work):
    name = item["name"]
    q = shlex.quote if os.name == "posix" else (lambda v: subprocess.list2cmdline([v]))
    cmd = (item["params"]["command"].replace("{in}", q(src)).replace("{out}", q(out_dir))
           .replace("{name}", q(os.path.splitext(name)[0])).replace("{file}", q(name)))
    shell = ["bash", "-c", cmd] if os.name == "posix" else cmd  # (Windows, for the checks: cmd's own way)
    proc = launch(node, shell, high_for(node, item), cwd=work, env={"IN": src, "OUT": out_dir, "NAME": os.path.splitext(name)[0]})
    log = []
    code, tail = run_logged(proc, log.append)
    with open(os.path.join(out_dir, "log.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(log[-2000:]) + "\n")
    if code != 0:
        raise RuntimeError(stopped_or("the command ended with %s: %s" % (code, " / ".join(tail[-3:]))))
    return {"outputs": sum(len(n) for _, _, n in os.walk(out_dir)) - 1}


def stopped_or(text):
    return "stopped" if _run["stop"] else text


# ----- the animal model -----
def tools_python(node):
    if node.simulate and os.environ.get("HT_CLUSTER_SIM_ANIMALS_PY"):
        return os.environ["HT_CLUSTER_SIM_ANIMALS_PY"]
    py = os.path.join(env_dir(node), "bin", "python")
    return py if os.path.exists(py) else None


def make_tools(node):
    """A Python of its own with ONNX Runtime, NumPy and Pillow (once per Pi, a few minutes)."""
    with _lock:
        if _tools["making"]:
            return
        _tools["making"] = True
    try:
        d = env_dir(node)
        py = os.path.join(d, "bin", "python")
        if not os.path.exists(py):
            code, out, err = node.run([sys.executable if node.simulate else "/usr/bin/python3", "-m", "venv", d], 300)
            if code != 0:
                raise RuntimeError("venv: " + (err or out).strip()[-200:])
        code, out, err = node.run([py, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "onnxruntime", "numpy", "pillow"], 1800)
        if code != 0:
            raise RuntimeError("pip: " + (err or out).strip()[-300:])
        code, out, err = node.run([py, "-c", "import onnxruntime, numpy, PIL; print('ok')"], 120)
        if code != 0 or "ok" not in out:
            raise RuntimeError((err or out).strip()[-200:])
        _tools.update(ready=True, error=None)
        node.event("jobs", "The animal model's tools are ready here.")
    except (RuntimeError, OSError) as e:
        _tools.update(ready=False, error=str(e))
        node.event("jobs", "The animal model's tools didn't install: %s" % e, bad=True)
    finally:
        _tools["making"] = False


def model_file(node, item, home, work):
    """The job's model here: the app's, from its GitHub release (checked against its SHA-256), or one
    sent with the job, from the Pi that keeps the list. Kept for the next job."""
    m = item["params"].get("model") or {}
    cache = os.path.join(os.path.dirname(work_dir(node)), "models")
    os.makedirs(cache, exist_ok=True)
    if m.get("url"):
        if not m["url"].startswith(MODEL_URL):
            raise RuntimeError("not one of this project's models")
        path = os.path.join(cache, m["sha256"] + ".onnx")
        if os.path.exists(path):
            return path
        req = urllib.request.Request(m["url"], headers={"User-Agent": "ht-cluster"})
        with urllib.request.urlopen(req, timeout=300) as res:
            data = res.read()
        if hashlib.sha256(data).hexdigest() != m["sha256"]:
            raise RuntimeError("the model's download wasn't whole")
        with open(path + ".part", "wb") as f:
            f.write(data)
        os.replace(path + ".part", path)
        return path
    name = m.get("upload")
    src = os.path.join(data_dir(node), "inputs", item["job"], name) if home["name"] == node.name else None
    path = os.path.join(work, "model.onnx")
    if src:
        return src
    fetch(node, {"name": name, "size": 0, "source": {"node": home["name"], "path": item.get("modelPath") or ""}}, home, path)
    return path


def do_animals(node, item, src, out_dir, home, work):
    py = tools_python(node)
    if not py:
        make_tools(node)
        py = tools_python(node)
        if not py:
            raise RuntimeError("the animal model's tools aren't ready here: %s" % (_tools["error"] or "making them"))
    model = model_file(node, item, home, work)
    p = item["params"]
    names = os.path.join(work, "names.json")
    with open(names, "w", encoding="utf-8") as f:
        json.dump({"names": p.get("names") or [], "animals": p.get("animals") or []}, f)
    threads = (os.cpu_count() or 4) if high_for(node, item) else 2
    base = re.sub(r"[^A-Za-z0-9_.-]", "_", os.path.splitext(item["name"])[0])
    cmd = [py, os.path.join(HERE, "jobs_animals.py"), "--video", src, "--model", model, "--names", names, "--out", out_dir,
           "--base", base, "--every", str(float(p.get("every") or 1)), "--score", str(float(p.get("score") or 0.25)),
           "--threads", str(threads), "--ffmpeg", ffmpeg(node) or "ffmpeg", "--work", os.path.join(work, "frames")]
    proc = launch(node, cmd, high_for(node, item))
    result = {}

    def line(l):
        if l.startswith("progress "):
            _run["progress"] = 0.1 + 0.85 * float(l.split()[1])
        elif l.startswith("done "):
            result.update(json.loads(l[5:]))
    code, tail = run_logged(proc, line)
    if code != 0:
        raise RuntimeError(stopped_or("the animal model: " + " / ".join(tail[-3:])))
    return result


def work(node, item, home):
    """One file, start to end, in its own thread (watch() pauses and stops it)."""
    w = os.path.join(work_dir(node), item["lease"])
    out_dir = os.path.join(w, "out")
    os.makedirs(out_dir, exist_ok=True)
    ok, error, summary = False, None, None
    try:
        _state["last"] = "%s: %s" % (item["title"], item["name"])
        src = fetch(node, item, home, os.path.join(w, "input" + os.path.splitext(item["name"])[1]))
        if item["kind"] == "convert":
            summary = do_convert(node, item, src, out_dir)
        elif item["kind"] == "playable":
            summary = do_playable(node, item, src, out_dir)
        elif item["kind"] == "command":
            summary = do_command(node, item, src, out_dir, w)
        else:
            summary = do_animals(node, item, src, out_dir, home, w)
        if _run["stop"]:
            raise RuntimeError("stopped")
        _run["progress"] = 0.95
        send_results(node, item, home, out_dir)
        ok = True
    except Exception as e:  # (said to the job list, and shown with the file)
        error = str(e)[:400]
    finally:
        shutil.rmtree(w, ignore_errors=True)
    give_back = _run["stop"] == "give back"
    try:
        for _ in range(5):
            code, _a = ask_home(node, home, "finish", {"lease": item["lease"], "ok": ok, "error": error, "summary": summary, "giveBack": give_back}, timeout=30)
            if code == 200:
                break
            time.sleep(10)
        if ok:
            node.log("[jobs] did %s (%s)" % (item["name"], item["title"]))
        elif not give_back:
            node.log("[jobs] %s didn't go: %s" % (item["name"], error))
    except Exception as e:  # (the list hears of it when it gives the file to another Pi)
        node.log("[jobs] couldn't tell the job list about %s: %s" % (item["name"], e))
    finally:
        _run.update(item=None, proc=None, paused=False, why="", stop=False, progress=0.0, turn=None)


def start(node):
    shutil.rmtree(work_dir(node), ignore_errors=True)  # (what a job left when this service last ended)


def status(node):
    out = {"home": is_home(node), "tools": bool(tools_python(node)), "taking": bool(node.setting("jobs", "take"))}
    it = _run["item"]
    if it:
        out["working"] = {"job": it["job"], "title": it["title"], "file": it["name"], "progress": round(_run["progress"], 3),
                          "paused": _run["why"] if _run["paused"] else None, "high": high_for(node, it)}
        word = "Paused (%s)" % _run["why"] if _run["paused"] else _run.get("turn") or "%d %%" % round(100 * _run["progress"])
        if _run.get("turn"):
            out["working"]["waiting"] = _run["turn"]
        summary = "Working on %s: %s · %s%s" % (it["title"], it["name"], word, " · high priority" if out["working"]["high"] else "")
    else:
        summary = _state["why"] or ("Ready for jobs" if node.setting("jobs", "take") else "Not taking jobs")
    if out["home"]:
        jobs = book(node)
        out["jobs"] = [brief(j) for j in sorted(jobs, key=lambda x: -x["created"])[:50]]
        going = [j for j in jobs if j["state"] in ("waiting", "running", "uploading")]
        summary += " · keeps the job list (%d going, %d in all)" % (len(going), len(jobs))
        moving = []
        for lane, word in (("down", "to"), ("up", "from")):
            t = _turns[lane]
            if t["holder"] and time.time() - t["beat"] <= TURN_STALE_S:
                moving.append("%s %s%s" % (word, t["holder"], " (%d in line)" % len(t["line"]) if t["line"] else ""))
        if moving:
            summary += " · moving files: " + ", ".join(moving)
        out["turns"] = {lane: {"holder": t["holder"], "line": [w[0] for w in t["line"]]} for lane, t in _turns.items()}
    out["summary"] = summary
    out["warnings"] = ["The animal model's tools didn't install: %s" % _tools["error"]] if _tools["error"] else []
    return out

