"""
jobs.py - Cluster module: jobs shared out across the Pis. One Pi keeps the cluster's job list and
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
  run      any command line or script (the user, 2026-11-24: "make the cluster do anything together"): once on each
           chosen member ("each": a part a member, done by that member alone), or split over a list ("split": files,
           lines of text, or the numbers 1 to N, each part to whichever member is free). In a command line: {in} the
           file, {out} the folder for what it makes, {name} and {file} the file's name without and with its ending,
           {input} the line or number, {i} and {n} the part's place and how many there are, {member} the member
           running it; a script gets the file, line or number as its $1, and all of them as IN, OUT, NAME, INPUT,
           INDEX, COUNT and MEMBER. A script runs by its #! line, else by its ending (bash, python3, node, perl). It
           runs as the member's own user; as root only with the cluster password (the user's choice: set once in the
           app; each member keeps only a check of it, and runs root jobs through its root helper, which checks it; the
           password itself is kept in memory alone, by the Pi keeping the list, while the job's there). A Windows PC
           runs them in its own Linux (Cluster-Linux, WSL), and takes only those it has the language for.
The files: recordings on any Pi (Hand Tracker's recordings folder: done by that Pi itself while it
takes jobs, else fetched by another), files sent from a computer to the Pi that keeps the list, or a
folder on that Pi. What's made goes to that Pi (~/ht-cluster-jobs/results/<job>/), where the app
lists it and saves it to a computer. A job whose params say "here" is done only by the Pi each file
is on (nothing sent over the Wi-Fi).

Files go between Pis in turns (the user, 2026-11-21: four Pis fetching videos from pi at once swamped
its Wi-Fi; then, with one at a time too slow, "staggered then together but as fast as they can without
putting strain on pi"): a Pi asks the one that keeps the list for its turn to download a file, or to
send back what it made, and waits in line for it ("turn"); its own files need no turn. Links start one
after the other (TURN_STAGGER_S apart) and run together: one more is let in while every piece comes
quickly and the total grew with the last one, one fewer when a piece crawls, and one at a time while
Transmission's turtle is on (someone's watching). A piece that doesn't come through is tried again
(PIECE_TRIES); a file that still can't be moved goes back on the list (MAX_TRIES times), not failed. A Pi
keeps its file while the Pi keeping the list doesn't answer: only one not heard from for LEASE_S (10 minutes)
has it put back on the list.

Failed conversions go first (the user, 2026-11-22: "have failed conversions be first in the queue always"; their
choices: straight back by itself, ahead of every waiting video in any job, and 3 more rounds, then it stays failed):
a conversion whose try didn't work goes back in line ahead of every waiting file, the one put back longest ago
first ("first"); one that fails for good (its tries used up, or its program failed) comes back so by itself
AUTO_ROUNDS times ("rounds"), then stays failed; Try again, or autoconvert's look a day later, gives it one more
round, first. Other kinds of job (the animal model's, commands) are as before.

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
# A Windows PC in the cluster (ht_cluster.py's HT_CLUSTER_PLATFORM): its jobs' priority a choice of its own (the user,
# 2026-11-22: "anytime with its switch at any chosen priority"), instead of the Pis' high-priority switch; it takes
# conversions and the animal model's jobs (TAKES: a command job's line is written for a Pi's Linux).
WINDOWS = os.environ.get("HT_CLUSTER_PLATFORM") == "windows"
# A phone (the Cluster app, Android or iPhone: its own switch): its programs are the app's (phonetools.py: ffmpeg in the
# app, a Python script in its own Python, a command in Android's sh), held still by giving the file back (an app's
# can't be paused), and never as root. It says which kinds it takes: an iPhone no commands (it can't run any).
PHONE = os.environ.get("HT_CLUSTER_PLATFORM") in ("android", "ios")
PLATFORMS = ("linux", "windows", "android", "ios")
PRIORITIES = [["low", "Low"], ["belowNormal", "Below normal"], ["normal", "Normal"], ["aboveNormal", "Above normal"], ["high", "High"]]
TAKES = ("convert", "playable", "animals")  # (and "run", in its Linux, once that's set up: run_kinds)
if WINDOWS:
    SETTINGS = [SETTINGS[0], {"key": "priority", "title": "Its jobs' priority", "default": "belowNormal", "choices": PRIORITIES}] + [
        s for s in SETTINGS[1:] if s["key"] != "high"]


def winsys():
    """winsys.py (beside ht_cluster.py): a job's programs on Windows."""
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    import winsys as w
    return w

PIECE = 4 << 20  # bytes per request, files going between Pis and to the app
MAX_PIECE = 16 << 20
# A Pi working on a file says so every 20 s; one not heard from for this long has its file put back on the list.
# Long, so a Pi keeps its file while the Pi keeping the list doesn't answer (the user, 2026-11-21: at 90 s,
# 4 videos were dropped while pi's Wi-Fi was full; "keep videos through pauses", for up to 10 minutes).
LEASE_S = 600
GIVE_BACK_S = 300  # paused this long: given back for another Pi
HOT_C, COOL_C = 80, 70
MIN_MEMORY = 350 << 20
LOW_BATTERY = 25
OWNER_FRESH_S = 30  # a Pi that asked for work this lately keeps its own recordings for itself
MAX_TRIES = 3
AUTO_ROUNDS = 3  # a conversion that failed comes back in line first by itself this many times, then stays failed
CONVERSIONS = ("convert", "playable")  # (the kinds of job whose failed files go first)
TURN_STALE_S = 45  # a Pi with a turn, or in line for one, says so this often or loses its place
TURN_ASK_S = 3  # how often a Pi in line asks again
TURN_BEAT_S = 15  # how often a Pi moving a file says it still has its turn (and how fast its pieces go)
TURN_STAGGER_S = 15  # links start one after the other, at least this far apart
PIECE_FAST_S = 20  # every piece within this (4 MB: 0.2 MB/s a link, short of crawling) and the total grew: one more link
# (12 s at first let no second link in on pi, whose one link went at 0.3-0.5 MB/s: 8-13 s a piece, 2026-11-21)
PIECE_SLOW_S = 25  # a piece slower than this (about 0.17 MB/s): the Pi keeping the list is straining, one link fewer
PIECE_TRIES = 6  # a piece that doesn't come through (a stall on the Wi-Fi) is tried this many times in all
PIECE_WAITS = (5, 10, 20, 30, 30)  # seconds between those tries
TEXT_SUBS = {"subrip", "ass", "ssa", "mov_text", "webvtt", "text"}
VIDEO = re.compile(r"\.(mp4|webm|mkv|mov|avi|m4v|ts|mpg|mpeg|wmv|flv|3gp|ogv)$", re.I)
SAFE_NAME = re.compile(r"^[^/\\\x00-\x1f]{1,200}$")
SAFE_REL = re.compile(r"^[A-Za-z0-9 ._()+,=@'-]+(/[A-Za-z0-9 ._()+,=@'-]+)*$")
MAX_PARTS = 10000  # (a run job's parts: lines, numbers)
LANGUAGES = ("bash", "python3", "node", "perl")
BY_ENDING = {".sh": "bash", ".bash": "bash", ".py": "python3", ".js": "node", ".mjs": "node", ".pl": "perl"}
WSL_DISTRO = "Cluster-Linux"  # (apps.py's: a Windows PC's own Linux)
_secrets = {}  # job id -> its cluster password (a root run job's: in memory alone, never in the job list)
_pw = {"at": 0, "set": False}
_has = {"at": 0, "list": None}
MODEL_URL = "https://github.com/alexandermulholland92/hand-tracker/releases/download/"

_lock = threading.RLock()  # (the job list, on the Pi that keeps it)
_book = {"jobs": None}  # the job list, loaded once
_seen = {}  # Pi -> when it last asked for work (that it's taking jobs now)
_run = {"item": None, "proc": None, "paused": False, "pausedAt": 0, "why": "", "stop": False, "progress": 0.0,
        "beat": 0, "home": None, "thread": None, "gave": None, "turn": None}
_state = {"why": "", "last": ""}
_tools = {"ready": None, "making": False, "error": None}


def _lane():
    # holders: Pi -> {since, beat, rate (bytes/s, as it last said), slowest (its slowest piece lately, s)};
    # line: [[Pi, when it last asked]]; allowed: how many links may run together now
    return {"holders": {}, "line": [], "allowed": 1, "last_go": 0.0, "total_at_go": 0.0}


# (on the Pi that keeps the list: whose turn it is to move a file, and who's in line, each way)
_turns = {"down": _lane(), "up": _lane()}


class Moving(RuntimeError):
    """A file that couldn't be moved between Pis (the network, not the file): it goes back on the list."""


# ----- where things are -----
def data_dir(node):
    d = os.environ.get("HT_CLUSTER_JOBS_DIR") if node.simulate else None
    if not d and WINDOWS:
        d = os.path.join(os.path.dirname(node.state_dir), "jobs")
    return d or os.path.join(os.path.expanduser("~"), "ht-cluster-jobs")


def work_dir(node):
    if node.simulate or PHONE:
        return os.path.join(node.state_dir, "work")
    if WINDOWS:
        return os.path.join(os.path.dirname(node.state_dir), "work")
    return os.path.join(os.path.expanduser("~"), ".cache", "ht-cluster", "work")


def env_dir(node):
    if WINDOWS:
        return os.path.join(os.path.dirname(node.state_dir), "jobs-env")
    return os.path.join(os.path.expanduser("~"), ".local", "share", "ht-cluster", "jobs-env")


def env_python(d):
    return os.path.join(d, "Scripts", "python.exe") if os.name == "nt" else os.path.join(d, "bin", "python")


def recordings_dir(node):
    """Hand Tracker's remote recording folder here (its setting, else Documents/Hand Tracker recordings)."""
    if node.simulate and os.environ.get("HT_CLUSTER_SIM_RECORDINGS"):
        return os.environ["HT_CLUSTER_SIM_RECORDINGS"]
    if PHONE:  # (a phone: its Hand Tracker apps' Documents/Hand Tracker, as the Cluster app says where; none it can't read)
        return os.environ.get("HT_CLUSTER_PHONE_RECORDINGS") or os.path.join(node.state_dir, "no-recordings")
    try:
        with open(os.path.join(os.path.expanduser("~"), ".config", "Hand Tracker", "settings.json"), "r", encoding="utf-8") as f:
            d = json.load(f).get("remoteDir")
        if d:
            return d
    except (OSError, ValueError, AttributeError):
        pass
    return os.path.join(os.path.expanduser("~"), "Documents", "Hand Tracker recordings")


def ffmpeg(node):
    if PHONE:
        return "ffmpeg"  # (the app's: phonetools.py)
    for p in (os.environ.get("HT_CLUSTER_FFMPEG") if node.simulate or WINDOWS else None, "/usr/bin/ffmpeg",
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
    """Files whose Pi stopped saying it's on them: back on the list (a conversion first), failed after MAX_TRIES (a
    conversion only after AUTO_ROUNDS more rounds)."""
    now = time.time()
    changed = False
    with _lock:
        for j in book(node):
            for it in j["items"]:
                if it["state"] == "running" and it.get("until", 0) < now:
                    it["tries"] = it.get("tries", 0) + 1
                    why = "%s stopped answering %d times" % (it.get("worker"), it["tries"])
                    if it["tries"] < MAX_TRIES:
                        it.update(state="waiting", worker=None, lease=None, error=None)
                        put_first(j, it)
                    elif not come_back(j, it, why):
                        it.update(state="failed", worker=None, lease=None, error=why)
                    changed = True
            settle(j)
        if changed:
            save(node)


def pick(node, worker, worker_can_reach, kinds=None, has=None):
    """The next file for this worker: a conversion whose last try didn't work first, from any job, the one put back
    longest ago; then its own recordings; then the job list's own files and any other Pi's whose Pi isn't taking
    jobs itself (fetched from there)."""
    now = time.time()
    me = node.name

    def takes(j, it):
        if j["kind"] == "run":
            if it.get("only"):  # (once on each member: that member's own)
                return it["only"] == worker
            if not it["source"]["node"]:  # (a line or a number: no file to fetch)
                return True
        src = it["source"]["node"]
        if src == worker:
            return True
        if j["params"].get("here"):  # (done only where each file is)
            return False
        owner_busy = src != me and now - _seen.get(src, 0) < OWNER_FRESH_S
        return src == me or (not owner_busy and src in worker_can_reach)
    live = [j for j in sorted(book(node), key=lambda x: (not x.get("high"), x["created"])) if j["state"] in ("waiting", "running")
            and (not kinds or j["kind"] in kinds)  # (a worker that says which kinds it takes: a Windows PC)
            and runnable(j, has)]
    again = [(it["first"], j, it) for j in live if j["kind"] in CONVERSIONS for it in j["items"]
             if it["state"] == "waiting" and it.get("first") and takes(j, it)]
    if again:
        _, j, it = min(again, key=lambda x: x[0])
        return j, it
    fallback = None
    for j in live:
        for it in j["items"]:
            if it["state"] != "waiting":
                continue
            if it["source"]["node"] == worker:
                return j, it
            if fallback is None and takes(j, it):
                fallback = (j, it)
    return fallback


def runnable(job, has):
    """A run job a worker can take: in a language it has (one that doesn't say has them all: a Pi from before), and,
    as root, while the Pi keeping the list has its password."""
    if job["kind"] != "run":
        return True
    needs = job["params"].get("needs")
    if needs and has is not None and needs not in has:
        return False
    return not job["params"].get("root") or job["id"] in _secrets


def put_first(job, it):
    """A conversion whose try didn't work: ahead of every waiting file in line, in any job (pick)."""
    if job["kind"] in CONVERSIONS:
        it["first"] = time.time()


def come_back(job, it, why):
    """A conversion that failed for good comes back in line first by itself, its tries counted again, AUTO_ROUNDS
    times; then it stays failed. True if it came back."""
    if job["kind"] not in CONVERSIONS or job["state"] == "stopped" or it.get("rounds", 0) >= AUTO_ROUNDS:
        return False
    it.update(state="waiting", worker=None, lease=None, progress=0, tries=0, error=None, rounds=it.get("rounds", 0) + 1,
              lastError=str(why)[:500], first=time.time())
    return True


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
    if kind not in ("animals", "convert", "command", "playable", "run"):
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
    password = None
    if kind == "run":
        why, password = run_params(node, params, args)
        if why:
            return {"ok": False, "error": why}
    jid = "j%s-%s" % (time.strftime("%Y%m%d-%H%M%S"), uuid.uuid4().hex[:4])
    items = run_parts(params) if kind == "run" else []
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
        if s.get("again") and kind in CONVERSIONS:  # (it failed before: autoconvert's look a day later) first, one round
            items[-1].update(first=time.time(), rounds=AUTO_ROUNDS)
    folder = str(args.get("folder") or "")
    if folder and kind != "playable":  # (a playable file comes with its plan)
        if not os.path.isdir(folder):
            return {"ok": False, "error": "No folder %s on %s." % (folder, node.name)}
        for name in sorted(os.listdir(folder)):
            p = os.path.join(folder, name)
            if os.path.isfile(p) and (kind in ("command", "run") or VIDEO.search(name)):
                items.append({"name": name, "size": os.path.getsize(p), "source": {"node": node.name, "path": p}, "state": "waiting"})
    if not items:
        return {"ok": False, "error": ("Nothing to run it over." if kind == "run" else "No files for it.") + (
            " (Only videos are taken for this kind of job.)" if folder and kind not in ("command", "run") else "")}
    for n, it in enumerate(items):
        it.update(id="i%d" % (n + 1), worker=None, lease=None, until=0, progress=0, tries=0, error=None, summary=None)
        if kind == "run":
            it.update(index=n + 1, count=len(items))
    uploading = (any(it["state"] == "uploading" for it in items) or bool((params.get("model") or {}).get("upload"))
                 or bool((params.get("script") or {}).get("upload")))
    job = {"id": jid, "kind": kind, "title": str(args.get("title") or kind)[:120], "created": time.time(), "high": bool(args.get("high")),
           "params": params, "state": "uploading" if uploading else "waiting", "items": items, "summary": None}
    with _lock:
        book(node).append(job)
        if password:
            _secrets[jid] = password
        save(node)
    node.event("jobs", "New job: %s (%d %s%s)" % (job["title"], len(items), "part" if kind == "run" else "file", "" if len(items) == 1 else "s"))
    return {"ok": True, "job": jid, "uploads": [it["name"] for it in items if it["state"] == "uploading"]}


def run_params(node, params, args):
    """A run job's params checked (and its "needs" set): -> (why not, or None; its password, for a root job)."""
    if params.get("how") not in ("each", "split"):
        return "Once on each member, or split over a list?", None
    command = str(params.get("command") or "").strip()
    script = params.get("script") if isinstance(params.get("script"), dict) else None
    if script and not SAFE_NAME.match(str(script.get("upload") or "")):
        script = None
    if bool(command) == bool(script):
        return "A command line, or a script (one of the two)?", None
    params["command"], params["script"] = command or None, {"upload": script["upload"]} if script else None
    if params.get("needs") not in LANGUAGES:
        params["needs"] = BY_ENDING.get(os.path.splitext(script["upload"])[1].lower()) if script else None
    params["root"] = bool(params.get("root"))
    if not params["root"]:
        return None, None
    password = str(args.get("password") or "")
    a = check_password(node, password)
    if a.get("error"):
        return a["error"], None
    return None, password


def check_password(node, password):
    """The cluster password checked by this computer's root helper: {} if it's right, else {"error"}."""
    a = node.root("cluster-password", timeout=60, stdin=json.dumps({"check": password}) + "\n")
    if not a.get("ok"):
        return {"error": "Couldn't check the cluster password: %s" % a.get("error")}
    if not a.get("set"):
        return {"error": "No cluster password is set on %s yet: set it first (Cluster password, in the Jobs tab)." % node.name}
    if not a.get("right"):
        return {"error": "That isn't the cluster password."}
    return {}


def run_parts(params):
    """A run job's parts that aren't files: one for each chosen member, or one for each line or number."""
    blank = lambda name: {"name": name, "size": 0, "source": {"node": None, "path": None}, "state": "waiting"}
    if params["how"] == "each":
        members = []
        for m in params.get("members") or []:
            if isinstance(m, str) and SAFE_NAME.match(m) and m not in members:
                members.append(m)
        return [dict(blank(m), only=m) for m in members[:64]]
    lines = [str(l).rstrip("\r") for l in params.pop("lines", None) or [] if str(l).strip()][:MAX_PARTS]
    if lines:
        return [dict(blank("%d: %s" % (i + 1, l[:80])), input=l[:4096]) for i, l in enumerate(lines)]
    try:
        n = int(params.get("count") or 0)
    except (TypeError, ValueError):
        n = 0
    return [dict(blank(str(i)), input=str(i)) for i in range(1, min(n, MAX_PARTS) + 1)]


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
        script = (job["params"].get("script") or {}).get("upload")
        if script and not os.path.isfile(os.path.join(data_dir(node), "inputs", job["id"], script)):
            return {"ok": False, "error": "The script hasn't arrived."}
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
                if it["state"] == "failed":  # (one more round, first)
                    put_first(job, it)
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
    out["params"] = {k: v for k, v in job["params"].items() if k in ("every", "format", "command", "label", "modelName", "how", "root", "needs")}
    if job["kind"] == "run":
        out["params"]["script"] = (job["params"].get("script") or {}).get("upload")
        out["needsPassword"] = bool(job["params"].get("root")) and job["id"] not in _secrets and job["state"] in ("waiting", "running")
    if items:
        out["items"] = [{k: it.get(k) for k in ("id", "name", "size", "state", "worker", "progress", "error", "summary", "placed", "only")}
                        | {"from": it["source"]["node"] or it.get("only")} for it in job["items"]]
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
    return {"ok": True, "name": zip_name(job), "size": os.path.getsize(path)}


def zip_name(job):
    return (re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", job["title"]).strip() or job["id"]) + ".zip"


def route_zip_file(node, h, q):
    """The zip act_zip made: a piece at a time (?at=), or whole as a download (?whole=1: the Cluster
    page in a browser, through a one-time link)."""
    job = job_of(node, q.get("job")) if is_home(node) else None
    path = os.path.join(data_dir(node), "zips", job["id"] + ".zip") if job else None
    if job and q.get("whole") == "1":
        if not path or not os.path.isfile(path):
            return node.send(h, 404, {"error": "No such file."})
        return node.send_file(h, path, zip_name(job), "application/zip")
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
    """A Pi asking for work: {worker, reach: [the Pis it can fetch files from], kinds?: the kinds of job it takes}
    -> an item, or none."""
    if not is_home(node):
        return {"ok": False, "error": "%s doesn't keep the job list." % node.name}
    worker = str(args.get("worker") or "")
    with _lock:
        _seen[worker] = time.time()
        expire(node)
        kinds = [str(k) for k in args.get("kinds") or []] if isinstance(args.get("kinds"), list) else None
        has = [str(k) for k in args.get("has") or []] if isinstance(args.get("has"), list) else None
        got = pick(node, worker, set(args.get("reach") or []) | {node.name}, kinds, has)
        if not got:
            return {"ok": True, "item": None}
        job, it = got
        it.update(state="running", worker=worker, lease=uuid.uuid4().hex, until=time.time() + LEASE_S, progress=0, started=time.time(), error=None)
        settle(job)
        save(node)
        upload = (job["params"].get("model") or {}).get("upload")
        script = (job["params"].get("script") or {}).get("upload")
        return {"ok": True, "item": {"job": job["id"], "kind": job["kind"], "title": job["title"], "high": job["high"], "params": job["params"],
                                     "id": it["id"], "name": it["name"], "size": it["size"], "source": it["source"], "lease": it["lease"],
                                     "plan": it.get("plan"), "input": it.get("input"), "index": it.get("index"), "count": it.get("count"),
                                     "modelPath": os.path.join(data_dir(node), "inputs", job["id"], upload) if upload else None,
                                     "scriptPath": os.path.join(data_dir(node), "inputs", job["id"], script) if script else None,
                                     # (a root part: its password, which its member's root helper checks; never in the job list)
                                     "password": _secrets.get(job["id"]) if job["params"].get("root") else None}}


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
        elif args.get("again") and job["state"] != "stopped" and it.get("tries", 0) + 1 < MAX_TRIES:
            # (its file couldn't be moved between Pis, the network's doing: back on the list, a few times)
            it.update(state="waiting", worker=None, lease=None, progress=0, tries=it.get("tries", 0) + 1, error=None)
            put_first(job, it)
        elif not come_back(job, it, args.get("error") or "it failed"):
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
    """A Pi's turn to move a file to or from here, in the order they asked: {lane: down|up, worker, done?,
    rate?, slowest?} -> {go: true} (its turn: said again at least every TURN_STALE_S while the file moves,
    with how fast its pieces went: rate, bytes/s, and slowest, s) or {go: false, ahead: how many before it}.
    Links start one after the other and run together, as many as make it faster without straining this Pi
    (allow())."""
    if not is_home(node):
        return {"ok": False, "error": "%s doesn't keep the job list." % node.name}
    lane, worker = args.get("lane"), str(args.get("worker") or "")
    if lane not in _turns or not worker:
        return {"ok": False, "error": "Which turn?"}
    quiet = bool((node.status_of("apps") or {}).get("turtle"))  # (someone's watching: one link at a time)
    now = time.time()
    with _lock:
        t = _turns[lane]
        for w in [w for w, h in t["holders"].items() if now - h["beat"] > TURN_STALE_S]:  # (stopped saying it has its turn)
            del t["holders"][w]
        t["line"] = [w for w in t["line"] if now - w[1] <= TURN_STALE_S and w[0] not in t["holders"]]
        if args.get("done"):
            t["holders"].pop(worker, None)
            t["line"] = [w for w in t["line"] if w[0] != worker]
            return {"ok": True, "go": False}
        mine = t["holders"].get(worker)
        if mine:
            mine["beat"] = now
            for k in ("rate", "slowest"):
                if isinstance(args.get(k), (int, float)):
                    mine[k] = float(args[k])
            allow(t, now, quiet)
            return {"ok": True, "go": True}
        waiting = next((w for w in t["line"] if w[0] == worker), None)
        if waiting:
            waiting[1] = now
        else:
            t["line"].append([worker, now])
        allow(t, now, quiet)
        if (t["line"][0][0] == worker and len(t["holders"]) < t["allowed"]
                and (not t["holders"] or now - t["last_go"] >= TURN_STAGGER_S)):
            t["line"].pop(0)
            t["total_at_go"] = sum(h["rate"] for h in t["holders"].values())
            t["holders"][worker] = {"since": now, "beat": now, "rate": 0.0, "slowest": 0.0}
            t["last_go"] = now
            return {"ok": True, "go": True}
        return {"ok": True, "go": False, "ahead": [w[0] for w in t["line"]].index(worker)}


def allow(t, now, quiet):
    """How many links may run together in a lane now: one while the turtle's on; one fewer than run now when
    a piece crawled (PIECE_SLOW_S: this Pi's straining); one more when every link has said how it's going,
    every piece came quickly (PIECE_FAST_S) and the total grew with the last link let in (or there's one);
    else as many as now (another link would only share the same speed)."""
    holders = list(t["holders"].values())
    n = len(holders)
    if not n and now - t["last_go"] > 300:  # (quiet a while: start again from one)
        t["allowed"] = 1
    if quiet:
        t["allowed"] = 1
    elif any(h["slowest"] > PIECE_SLOW_S for h in holders):
        t["allowed"] = max(1, n - 1)
    elif n and all(now - h["since"] > TURN_BEAT_S and 0 < h["slowest"] <= PIECE_FAST_S for h in holders):
        total = sum(h["rate"] for h in holders)
        t["allowed"] = n + 1 if (n == 1 or total > t["total_at_go"] * 1.15) else max(n, 1)
    t["allowed"] = max(1, t["allowed"])


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
    script = (job["params"].get("script") or {}).get("upload")
    if not it and name not in (model, script):
        return node.send(h, 400, {"error": "That file isn't one of the job's."})
    return write_piece(node, h, os.path.join(data_dir(node), "inputs", job["id"], name), q)


def route_result(node, h, q):
    """A piece of something a Pi made (PUT ?lease=&path=&at=)."""
    job, it = find_lease(node, q.get("lease"))
    rel = str(q.get("path") or "")
    if not it:
        return node.send(h, 409, {"error": "That work isn't this device's any more."})
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
    if at == 0:  # (a file started again: what a try before left of it goes)
        have = 0
    elif at != have:
        if q.get("last") == "1" and not os.path.exists(part) and os.path.isfile(path) and os.path.getsize(path) == at + len(data):
            return node.send(h, 200, {"ok": True, "have": at + len(data)})  # (its last piece came before: the answer got lost)
        return node.send(h, 409, {"error": "Out of turn", "have": have})
    with open(part, "ab" if have else "wb") as f:
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


def by_file(what, on=True):
    """A run part that the service can't signal itself (as root, or in a Windows PC's Linux): told through a file in
    its folder (".pause" while it's there, ".stop"), which its root helper or run-job.sh watches."""
    w = _run.get("folder")
    if not w or not _run.get("byFile"):
        return
    path = os.path.join(w, what)
    try:
        if on:
            open(path, "w").close()
        elif os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


def pause(on):
    by_file(".pause", on)
    p = _run["proc"]
    if p and p.poll() is None and WINDOWS and os.name == "nt":  # (Windows: its programs held still, and carried on)
        winsys().pause(p.pid, on)
        return
    if not p or p.poll() is not None or not hasattr(os, "killpg"):
        return
    try:
        os.killpg(p.pid, signal.SIGSTOP if on else signal.SIGCONT)
    except OSError:
        pass


def stop_proc():
    by_file(".stop")
    p = _run["proc"]
    if p and p.poll() is None and PHONE:
        p.terminate()
        try:
            p.wait(10)
        except subprocess.TimeoutExpired:
            pass
        return
    if p and p.poll() is None:
        try:
            if hasattr(os, "killpg"):
                os.killpg(p.pid, signal.SIGCONT)
                os.killpg(p.pid, signal.SIGTERM)
            elif subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True, timeout=10).returncode:
                p.terminate()  # (Windows, for the checks: taskkill stops cmd's own programs too, which terminate() left running)
            p.wait(10)
        except (OSError, subprocess.TimeoutExpired):
            try:
                os.killpg(p.pid, signal.SIGKILL) if hasattr(os, "killpg") else p.kill()
            except OSError:
                pass


def tick(node):
    if is_home(node):
        expire(node)
    password_set(node)  # (for the app: whether jobs can run as root here; asked at most once a minute)
    if _run["item"]:
        watch(node)
        return
    why = reasons(node)
    _state["why"] = why
    if why:
        return
    home = find_home(node)
    if not home:
        _state["why"] = "No device keeps the job list yet"
        return
    reach = [p["name"] for p in node.cluster()]
    ask = {"worker": node.name, "reach": reach, "has": languages(node)}
    if WINDOWS:
        ask["kinds"] = list(TAKES) + (["run"] if wsl_ready(node) else [])
    elif PHONE:
        ask["kinds"] = list(TAKES) + (["run", "command"] if os.environ.get("HT_CLUSTER_PLATFORM") == "android" else ["run"])
    code, a = ask_home(node, home, "lease", ask)
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
    if why and (why.startswith("Not taking") or PHONE):  # (a phone: its programs can't be held still)
        _run["stop"] = "give back"
    elif why and not _run["paused"]:
        pause(True)
        _run.update(paused=True, pausedAt=time.time(), why=why)
    elif not why and _run["paused"]:
        pause(False)
        _run.update(paused=False, why="")
    elif why:
        _run["why"] = why
    p = _run.get("proc")
    if WINDOWS and os.name == "nt" and p and p.poll() is None and _run.get("priority") != node.setting("jobs", "priority"):
        _run["priority"] = node.setting("jobs", "priority")  # (its priority changed while it ran: its programs too)
        winsys().set_priority(p.pid, _run["priority"])
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


def launch(node, cmd, high, cwd=None, env=None, stdin_text=None):
    """A job's program: in a process group of its own (to pause it whole), at low priority on two
    cores, or (high) on all of them, ahead of everything (the root helper renices it)."""
    if PHONE:
        import phonetools  # (beside ht_cluster.py)

        p = phonetools.popen(cmd, cwd=cwd, env=dict(env or {}, HT_CLUSTER_JOB="1"), stdin_text=stdin_text)
        _run["proc"] = p
        return p
    prefix = []
    if os.name == "posix" and not high:
        prefix = ["nice", "-n", "15"] + (["ionice", "-c3"] if shutil.which("ionice") else [])
        if (os.cpu_count() or 1) >= 4 and shutil.which("taskset"):
            prefix += ["taskset", "-c", "2,3"]
    e = dict(os.environ, HT_CLUSTER_JOB="1", **(env or {}))
    kw = {"start_new_session": True} if os.name == "posix" else {}
    if WINDOWS and os.name == "nt":  # (a Windows PC: no window of its own, at the PC's chosen priority, whatever the job says)
        _run["priority"] = node.setting("jobs", "priority")
        kw = {"creationflags": winsys().creationflags(_run["priority"])}
    stdin = subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL
    if isinstance(cmd, str):  # (a command line as it is: Windows's cmd, for the checks)
        p = subprocess.Popen(cmd, shell=True, cwd=cwd, env=e, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    else:
        p = subprocess.Popen(prefix + cmd, cwd=cwd, env=e, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, **kw)
    if stdin_text is not None:
        try:
            p.stdin.write(stdin_text)
            p.stdin.close()
        except OSError:
            pass
    _run["proc"] = p
    if high and not node.simulate and not WINDOWS:
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


def keep_turn(node, home, lane, rate=None, slowest=None):
    args = {"lane": lane, "worker": node.name}
    if rate is not None:
        args.update(rate=rate, slowest=slowest)
    ask_home(node, home, "turn", args, timeout=15)


def end_turn(node, home, lane):
    ask_home(node, home, "turn", {"lane": lane, "worker": node.name, "done": True}, timeout=15)


class Turn:
    """This Pi's turn to move a file to or from the Pi that keeps the list: waited for (take_turn), kept
    while the file moves (a beat every TURN_BEAT_S from a thread of its own, so a slow piece or a wait
    between tries doesn't lose it, saying how fast its pieces went: that's how that Pi tells whether
    another link would help), and given up after."""

    def __init__(self, node, home, lane, name):
        self.node, self.home, self.lane, self.name = node, home, lane, name
        self.lock = threading.Lock()
        self.bytes, self.slowest, self.since = 0, 0.0, time.time()
        self.stop = threading.Event()
        self.thread = None

    def __enter__(self):
        take_turn(self.node, self.home, self.lane, self.name)
        self.since = time.time()
        self.thread = threading.Thread(target=self._keep, daemon=True, name="turn-" + self.lane)
        self.thread.start()
        return self

    def piece(self, nbytes, seconds):
        with self.lock:
            self.bytes += nbytes
            self.slowest = max(self.slowest, seconds)

    def _keep(self):
        while not self.stop.wait(TURN_BEAT_S):
            with self.lock:
                now = time.time()
                rate = self.bytes / max(0.001, now - self.since)
                slowest = self.slowest
                self.bytes, self.slowest, self.since = 0, 0.0, now
            try:
                keep_turn(self.node, self.home, self.lane, round(rate), round(slowest, 1))
            except Exception:  # (the next beat tries again)
                pass

    def __exit__(self, *exc):
        self.stop.set()
        if self.thread:
            self.thread.join(5)
        end_turn(self.node, self.home, self.lane)
        return False


def with_tries(what, request):
    """One piece of a file moving between Pis, asked for again after a wait when it doesn't come through (no
    answer, or the other Pi's error): a stall on the Wi-Fi isn't the file's fault. request() -> (code,
    answer). -> (code, answer, seconds the answer took) once there's an answer to go on (4xx too: the
    caller decides), else Moving after PIECE_TRIES."""
    why = None
    for i in range(PIECE_TRIES):
        if _run["stop"]:
            raise RuntimeError("stopped")
        t0 = time.time()
        code, a = request()
        if code is not None and code < 500:
            return code, a, time.time() - t0
        why = a.get("error") if isinstance(a, dict) else a
        if i < PIECE_TRIES - 1:
            until = time.time() + PIECE_WAITS[min(i, len(PIECE_WAITS) - 1)]
            while time.time() < until:  # (in small steps: a stop isn't kept waiting)
                if _run["stop"]:
                    raise RuntimeError("stopped")
                time.sleep(0.5)
    raise Moving("%s didn't come through in %d tries (%s)" % (what, PIECE_TRIES, str(why)[:160]))


def fetch(node, item, home, dest):
    """The file to work on: here already (its own recording), else fetched from where it is, in its turn."""
    src = item["source"]
    if src["node"] == node.name and os.path.isfile(src["path"]):
        return src["path"]
    target = home["target"] if src["node"] == home["name"] else next((p["target"] for p in node.cluster() if p["name"] == src["node"]), None)
    if not target:
        raise Moving("%s, which has the file, isn't answering" % src["node"])
    with Turn(node, home, "down", item["name"]) as turn:
        at = 0
        with open(dest, "wb") as f:
            while True:
                if _run["stop"]:
                    raise RuntimeError("stopped")
                path = "/api/jobs/file?path=%s&at=%d" % (urllib.parse.quote(src["path"]), at)
                code, data, took = with_tries("%s from %s" % (item["name"], src["node"]), lambda: node.ask(target, "GET", path, timeout=60))
                if code != 200 or not isinstance(data, bytes):
                    raise RuntimeError("couldn't fetch %s from %s: %s" % (item["name"], src["node"], (data or {}).get("error") if isinstance(data, dict) else data))
                turn.piece(len(data), took)
                if not data:
                    break
                f.write(data)
                at += len(data)
                if item.get("size"):
                    _run["progress"] = 0.1 * min(1.0, at / float(item["size"]))
                if len(data) < PIECE:
                    break
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
    with Turn(node, home, "up", item["name"]) as turn:
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
                    code, a, took = with_tries("%s to %s" % (rel, home["name"]), lambda: node.ask(home["target"], "PUT", "/api/jobs/result?" + q, data=data, timeout=120))
                    came = code == 409 and isinstance(a, dict) and a.get("have") == at + len(data)  # (it came, its answer didn't)
                    if code != 200 and not came:
                        raise RuntimeError("couldn't send %s: %s" % (rel, (a or {}).get("error") if isinstance(a, dict) else a))
                    turn.piece(len(data), took)
                    at += len(data)
                    if last:
                        break


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


# ----- any command or script (the run kind) -----
def languages(node):
    """The languages this member runs scripts in (looked at once every 10 minutes): a Windows PC's, in its Linux."""
    if time.time() - _has["at"] < 600 and _has["list"] is not None:
        return _has["list"]
    if PHONE:  # (a phone: Python scripts in its own Python; Android's sh runs shell scripts, not bash's own)
        _has.update(at=time.time(), list=["python3"])
        return _has["list"]
    if node.simulate:  # (the checks: every language, or those they name)
        _has.update(at=time.time(), list=[x for x in (os.environ.get("HT_CLUSTER_SIM_HAS") or " ".join(LANGUAGES)).split() if x in LANGUAGES])
        return _has["list"]
    if WINDOWS and not node.simulate:
        code, out, _ = node.run([wsl_exe(), "-d", WSL_DISTRO, "-u", "root", "--exec", "/bin/sh", "-c",
                                 "for t in %s; do command -v $t >/dev/null 2>&1 && echo $t; done" % " ".join(LANGUAGES)], 120)
        found = [l.strip() for l in (out or "").replace("\x00", "").splitlines() if l.strip() in LANGUAGES] if code == 0 else []
    else:
        found = [x for x in LANGUAGES if shutil.which(x)]
    _has.update(at=time.time(), list=found)
    return found


def wsl_exe():
    return os.path.join(os.environ.get("SystemRoot") or r"C:\Windows", "System32", "wsl.exe")


def wsl_ready(node):
    """A Windows PC's Linux is set up (Cluster-Linux, setup.py --linux): it takes run jobs, in there."""
    if node.simulate:
        return bool(os.environ.get("HT_CLUSTER_SIM_WSL"))
    try:
        return WSL_DISTRO in winsys().wsl_distros()
    except Exception:
        return False


def wsl_path(p):
    """A Windows path as WSL's Linux sees it (C:\\Users\\... -> /mnt/c/Users/...)."""
    drive, rest = os.path.splitdrive(os.path.abspath(p))
    return "/mnt/%s%s" % (drive[:1].lower(), rest.replace("\\", "/"))


def wsl_copy(node, name):
    """windows/<name> as WSL's Linux reads it: a copy with Linux's line ends, in the state folder."""
    with open(os.path.join(HERE, "windows", name), "rb") as f:
        data = f.read().replace(b"\r\n", b"\n")
    dst = os.path.join(node.state_dir, name)
    try:
        with open(dst, "rb") as f:
            same = f.read() == data
    except OSError:
        same = False
    if not same:
        with open(dst + ".new", "wb") as f:
            f.write(data)
        os.replace(dst + ".new", dst)
    return wsl_path(dst)


def script_file(node, item, home, work):
    """The job's script here: on the Pi keeping the list, where it was sent; elsewhere fetched from there. Its line
    ends made Linux's (a script written on Windows would stop at its first line)."""
    name = item["params"]["script"]["upload"]
    if home["name"] == node.name and item.get("scriptPath") and os.path.isfile(item["scriptPath"]):
        with open(item["scriptPath"], "rb") as f:
            data = f.read()
    else:
        tmp = os.path.join(work, ".script")
        fetch(node, {"name": name, "size": 0, "source": {"node": home["name"], "path": item.get("scriptPath") or ""}}, home, tmp)
        with open(tmp, "rb") as f:
            data = f.read()
        os.remove(tmp)
    if b"\0" not in data[:4096]:
        data = data.replace(b"\r\n", b"\n")
    path = os.path.join(work, re.sub(r"[^A-Za-z0-9._-]", "_", name) or "script")
    with open(path, "wb") as f:
        f.write(data)
    os.chmod(path, 0o755)
    return path, data


def part_folder(item):
    """Where a run part's results go in its job's: its member's name (once on each member), else its number (and
    its file's name, for a file)."""
    if item["params"].get("how") == "each":
        base = item["name"]
    else:
        base = str(item.get("index") or 1).zfill(len(str(item.get("count") or 1)))
        if (item.get("source") or {}).get("path"):
            base += " " + os.path.splitext(item["name"])[0]
    return re.sub(r"[^A-Za-z0-9 ._()+,=@'-]", "_", base)[:80].strip() or "part"


def do_run(node, item, src, out_dir, work, home):
    """A part of a run job: its command line, or its script, as this member's own user or (with the cluster
    password, checked by the root helper) as root; on a Windows PC in its Linux. What it prints goes in log.txt."""
    p = item["params"]
    in_linux = WINDOWS and os.name == "nt" and not node.simulate
    posix = os.name == "posix" or in_linux  # (else Windows itself, for the checks: cmd's way, and this Python for a script)
    lp = wsl_path if in_linux else (lambda v: v)
    name = item["name"] if src else ""
    values = {"in": lp(src) if src else "", "out": lp(out_dir), "name": os.path.splitext(name)[0] if src else "", "file": name,
              "input": item.get("input") or "", "i": str(item.get("index") or 1), "n": str(item.get("count") or 1), "member": node.name}
    env = {"IN": values["in"], "OUT": values["out"], "NAME": values["name"], "INPUT": values["input"], "INDEX": values["i"],
           "COUNT": values["n"], "MEMBER": node.name}
    if p.get("script"):
        path, data = script_file(node, item, home, work)
        first = data.split(b"\n", 1)[0]
        lang = p.get("needs") or "bash"
        extra = [values["in"] or values["input"]] if values["in"] or values["input"] else []
        if posix:
            argv = ([lp(path)] if first.startswith(b"#!") else [lang, lp(path)]) + extra
        else:
            argv = [sys.executable, path] + extra
    else:
        q = shlex.quote if posix else (lambda v: subprocess.list2cmdline([v]))
        cmd = p["command"]
        for k, v in values.items():
            cmd = cmd.replace("{%s}" % k, q(v))
        argv = ["bash", "-c", cmd] if posix else cmd
    root = bool(p.get("root"))
    stdin_text = None
    if in_linux:  # (a Windows PC: in its Linux, run-job.sh watching its folder for .pause and .stop)
        if root:
            a = check_password(node, item.get("password") or "")
            if a.get("error"):
                raise RuntimeError(a["error"])
        envs = ["%s=%s" % (k, v) for k, v in env.items()] + ["HOME=/tmp", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HT_CLUSTER_JOB=1"]
        cmd = [wsl_exe(), "-d", WSL_DISTRO, "-u", "root", "--cd", wsl_path(work), "--exec", "/bin/sh", wsl_copy(node, "run-job.sh")] + (
            ["--root"] if root else []) + ["--", "env"] + envs + argv
        _run["byFile"] = True
    elif root:  # (a Pi: through its root helper, which checks the password, then runs it and watches .pause and .stop)
        helper = [sys.executable, os.environ["HT_CLUSTER_ROOT_HELPER"]] if node.simulate and os.environ.get("HT_CLUSTER_ROOT_HELPER") else ["sudo", "-n", "/usr/local/sbin/ht-cluster-root"]
        cmd = helper + ["run-as-root"]
        stdin_text = json.dumps({"password": item.get("password") or "", "argv": argv, "cwd": work, "env": env}) + "\n"
        _run["byFile"] = True
    else:
        cmd = argv
    proc = launch(node, cmd, high_for(node, item), cwd=work, env=env, stdin_text=stdin_text)
    log = []
    code, tail = run_logged(proc, log.append)
    answer = None
    if root and not in_linux:  # (the root helper's own answer: its last JSON line, kept out of the log)
        for i in range(len(log) - 1, -1, -1):
            if log[i].strip().startswith("{"):
                try:
                    answer = json.loads(log[i])
                except ValueError:
                    answer = None
                if isinstance(answer, dict) and "ok" in answer:
                    del log[i]
                else:
                    answer = None
                break
        tail = log[-3:]
    with open(os.path.join(out_dir, "log.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(log[-5000:]) + "\n")
    if answer is not None:
        if not answer.get("ok"):
            raise RuntimeError(stopped_or("as root: %s" % answer.get("error")))
        code = answer.get("code")
    if code != 0:
        raise RuntimeError(stopped_or("it ended with %s: %s" % (code, " / ".join(tail[-3:]))))
    return {"outputs": sum(len(n) for _, _, n in os.walk(out_dir)) - 1}


def password_set(node):
    """Whether a cluster password is set here (asked of its root helper, at most once a minute). A phone: never (it
    runs nothing as root, and has no root helper)."""
    if PHONE:
        return False
    if time.time() - _pw["at"] > 60:
        a = node.root("cluster-password", timeout=60, stdin=json.dumps({"check": ""}) + "\n")
        _pw.update(at=time.time(), set=bool(a.get("ok") and a.get("set")))
    return _pw["set"]


def act_set_password(node, args):
    """This member's cluster password set (or changed: the old one needed): kept only as a check, by its root helper."""
    new = str(args.get("new") or "")
    a = node.root("cluster-password", timeout=60, stdin=json.dumps({"new": new, "old": str(args.get("old") or "")}) + "\n")
    _pw["at"] = 0
    if not a.get("ok"):
        return {"ok": False, "error": a.get("error") or "it didn't take"}
    node.event("jobs", "The cluster password was set here (for jobs run as root).")
    return {"ok": True, "message": "Set on %s." % node.name}


def act_job_password(node, args):
    """A root job's password again (the Pi keeping the list restarted, which forgets it): checked, then kept in memory."""
    with _lock:
        job = job_of(node, args.get("job"))
    if not job or job["kind"] != "run" or not job["params"].get("root"):
        return {"ok": False, "error": "No such job run as root."}
    a = check_password(node, str(args.get("password") or ""))
    if a.get("error"):
        return {"ok": False, "error": a["error"]}
    _secrets[job["id"]] = str(args.get("password"))
    return {"ok": True, "message": "%s goes on." % job["title"]}


ACTIONS.update(setPassword={"run": act_set_password, "hidden": True}, jobPassword={"run": act_job_password, "hidden": True})


def stopped_or(text):
    return "stopped" if _run["stop"] else text


# ----- the animal model -----
def tools_python(node):
    if PHONE:
        return "python3"  # (this Python: phonetools.py runs the script in it)
    if node.simulate and os.environ.get("HT_CLUSTER_SIM_ANIMALS_PY"):
        return os.environ["HT_CLUSTER_SIM_ANIMALS_PY"]
    py = env_python(env_dir(node))
    return py if os.path.exists(py) else None


def make_tools(node):
    """A Python of its own with ONNX Runtime, NumPy and Pillow (once per Pi, a few minutes)."""
    with _lock:
        if _tools["making"]:
            return
        _tools["making"] = True
    try:
        d = env_dir(node)
        py = env_python(d)
        if not os.path.exists(py):
            base = sys.executable if node.simulate or WINDOWS else "/usr/bin/python3"
            if WINDOWS and os.environ.get("HT_CLUSTER_TOOLS_PYTHON"):  # (one onnxruntime has wheels for: its launcher says)
                base = os.environ["HT_CLUSTER_TOOLS_PYTHON"]
            if os.path.basename(base).lower() == "pythonw.exe":
                base = os.path.join(os.path.dirname(base), "python.exe")
            code, out, err = node.run([base, "-m", "venv", d], 300)
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
    threads = (os.cpu_count() or 4) if high_for(node, item) or WINDOWS else 2  # (a Windows PC: all, at its chosen priority)
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
    ok, error, summary, again = False, None, None, False
    try:
        _state["last"] = "%s: %s" % (item["title"], item["name"])
        _run.update(folder=w, byFile=False)
        has_file = bool((item.get("source") or {}).get("path"))
        src = fetch(node, item, home, os.path.join(w, "input" + os.path.splitext(item["name"])[1])) if has_file else None
        if item["kind"] == "run":  # (each part's own folder in the results: a member's name, or its number)
            part_out = os.path.join(out_dir, part_folder(item))
            os.makedirs(part_out, exist_ok=True)
            summary = do_run(node, item, src, part_out, w, home)
        elif item["kind"] == "convert":
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
    except Moving as e:  # (the network, not the file: back on the list)
        error, again = str(e)[:400], True
    except Exception as e:  # (said to the job list, and shown with the file)
        error = str(e)[:400]
    finally:
        shutil.rmtree(w, ignore_errors=True)
    give_back = _run["stop"] == "give back"
    try:
        for _ in range(5):
            code, _a = ask_home(node, home, "finish", {"lease": item["lease"], "ok": ok, "error": error, "summary": summary, "giveBack": give_back,
                                                       "again": again}, timeout=30)
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
    out = {"home": is_home(node), "tools": bool(tools_python(node)), "taking": bool(node.setting("jobs", "take")), "passwordSet": _pw["set"],
           "runs": not WINDOWS or wsl_ready(node)}
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
        now = time.time()
        with _lock:
            for lane, word in (("down", "to"), ("up", "from")):
                t = _turns[lane]
                live = sorted(w for w, h in t["holders"].items() if now - h["beat"] <= TURN_STALE_S)
                if live:
                    total = sum(h["rate"] for w, h in t["holders"].items() if w in live)
                    moving.append("%s %s%s%s" % (word, ", ".join(live), " at %.1f MB/s" % (total / 1e6) if total else "",
                                                 " (%d in line)" % len(t["line"]) if t["line"] else ""))
            out["turns"] = {lane: {"holders": sorted(t["holders"]), "allowed": t["allowed"], "line": [w[0] for w in t["line"]]}
                            for lane, t in _turns.items()}
        if moving:
            summary += " · moving files: " + "; ".join(moving)
    out["summary"] = summary
    out["warnings"] = ["The animal model's tools didn't install: %s" % _tools["error"]] if _tools["error"] else []
    return out

