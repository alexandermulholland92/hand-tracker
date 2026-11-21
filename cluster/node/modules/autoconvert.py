"""
autoconvert.py - Pi Cluster module, on the Pi that keeps the job list: every video in ~/Videos that some
device would make Jellyfin convert while it plays gets a copy every device plays as it is, "<name> -
converted.mp4" beside it; the original is kept, for the devices that play it (the user, 2026-11-21: "have
the conversion set up to run automatically when new videos that need conversion are found", and "any video
that pi has to transcode with any effort"). The copy: H.264 8-bit up to 1080p, AAC stereo, its text
subtitles, in .mp4 (the phone app, TVs and sticks, web browsers and the Pi's own screen play that).

Every 30 minutes (or at once from its button) it looks through the folder; a video is looked into
(ffprobe) once nothing has been written to it for 10 minutes (so not while it's still downloading), and
remembered by its size and time. What it needs, each kind with its own switch:
  old    an old or 10-bit picture format (Xvid, DivX, MPEG-2, WMV, VP9, AV1, Hi10P H.264): re-encoded
  hevc   H.265 up to 1080p: re-encoded (hours a video on a Pi)
  big    bigger than 1080p: scaled to 1080p and re-encoded, HDR's colours made SDR's (slowest)
  sound  the picture plays everywhere but the sound doesn't (AC3, E-AC3, DTS, TrueHD, FLAC...): the
         picture copied, the sound made AAC; done by this Pi alone, where the file is
Each look puts what's new in jobs (jobs.py's "playable" kind: shared out across the Pis, one file moving
over the Wi-Fi at a time each way), old formats first; the Pi that keeps the list puts each copy beside
its video as it comes back. A file that failed is tried again a day later. Picture subtitles (PGS, DVD)
can't go in an .mp4: the original keeps them. Names with "sample" in them are left alone.
"""

import collections
import json
import os
import re
import shutil
import threading
import time

TITLE = "Convert for every device"
ORDER = 45
ON = False
EVERY = 30
SETTINGS = [
    {"key": "old", "title": "Convert old picture formats (Xvid, DivX, MPEG-2, WMV, 10-bit H.264)", "default": True},
    {"key": "hevc", "title": "Convert HEVC / H.265 (slow: hours a video)", "default": False},
    {"key": "big", "title": "Convert 4K and bigger to 1080p (slowest)", "default": False},
    {"key": "sound", "title": "Change only the sound where only the sound doesn't play everywhere (this Pi alone)", "default": False},
]

LOOK_EVERY = 1800
STEADY_S = 600  # nothing written to it for this long: not still downloading
RETRY_S = 24 * 3600
KINDS = ["old", "sound", "hevc", "big"]  # (the jobs' order: quick wins first)
WORDS = {"old": "old-format", "sound": "sound-only", "hevc": "HEVC", "big": "4K"}
VIDEO = re.compile(r"\.(mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|webm|mpg|mpeg|flv|ogv|3gp)$", re.I)
CONVERTED = re.compile(r" - converted\.mp4$", re.I)
TEXT_SUBS = {"subrip", "ass", "ssa", "mov_text", "webvtt", "text"}
PLAYS = {"aac", "mp3"}  # (sound every device plays)
HDR = {"smpte2084", "arib-std-b67"}

_want = {"look": False}
_state = {"why": "", "looking": False, "progress": ""}
_lock = threading.Lock()


def videos_dir(node):
    d = os.environ.get("HT_CLUSTER_AUTOCONVERT_DIR") if node.simulate else None
    return d or os.path.join(os.path.expanduser("~"), "Videos")


def ffprobe(node):
    for p in (os.environ.get("HT_CLUSTER_FFPROBE") if node.simulate else None, "/usr/bin/ffprobe", "/usr/lib/jellyfin-ffmpeg/ffprobe"):
        if p and os.path.exists(p):
            return p
    return shutil.which("ffprobe")


def converted_name(name):
    return os.path.splitext(name)[0] + " - converted.mp4"


def probe(node, tool, path):
    cmd = [tool, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]
    if os.name == "posix" and not node.simulate:
        cmd = ["nice", "-n", "15"] + (["ionice", "-c3"] if shutil.which("ionice") else []) + cmd
    code, out, err = node.run(cmd, 120)
    try:
        return json.loads(out or "{}") if code == 0 else None
    except ValueError:
        return None


def frame_transfer(node, tool, path):
    """The first picture's own colour transfer (an HDR video can say it only there, not in its container)."""
    cmd = [tool, "-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1", "-show_entries", "frame=color_transfer", "-print_format", "json", path]
    code, out, err = node.run(cmd, 60)
    try:
        return ((json.loads(out or "{}").get("frames") or [{}])[0]).get("color_transfer") if code == 0 else None
    except ValueError:
        return None


def decide(info, transfer=None):
    """-> {need: a kind or None, why, plan} for jobs.py's playable_args. transfer: the first picture's
    colour transfer, if looked at (frame_transfer)."""
    if not info:
        return {"need": None, "why": "ffprobe couldn't read it", "broken": True}
    streams = info.get("streams") or []
    vids = [s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")]
    if not vids:
        return {"need": None, "why": "no picture"}
    v = vids[0]
    auds = [s for s in streams if s.get("codec_type") == "audio"]
    codec, prof, pix = v.get("codec_name") or "", (v.get("profile") or "").lower(), v.get("pix_fmt") or ""
    w, h = int(v.get("width") or 0), int(v.get("height") or 0)
    ten = any(x in pix for x in ("10", "12", "422", "444")) or any(x in prof for x in ("high 10", "4:2:2", "4:4:4"))
    hdr = v.get("color_transfer") in HDR or transfer in HDR
    big = w > 1920 or h > 1088
    plan = {"v": v["index"], "audio": [a["index"] for a in auds],
            "subs": [s["index"] for s in streams if s.get("codec_type") == "subtitle" and s.get("codec_name") in TEXT_SUBS],
            "duration": float((info.get("format") or {}).get("duration") or 0), "video": "h264"}
    if big:
        plan.update(scale=True, wide=w * 9 >= h * 16, hdr=hdr)
        return {"need": "big", "why": "%s %dx%d%s" % (codec, w, h, " HDR" if hdr else ""), "plan": plan}
    if codec == "hevc":
        plan["hdr"] = hdr
        return {"need": "hevc", "why": "hevc%s%s" % (" 10-bit" if ten else "", " HDR" if hdr else ""), "plan": plan}
    if codec != "h264" or ten or hdr:
        plan["hdr"] = hdr
        return {"need": "old", "why": "%s%s%s" % (codec, " 10-bit" if ten else "", " HDR" if hdr else ""), "plan": plan}
    if auds and not any((a.get("codec_name") or "") in PLAYS for a in auds):
        plan["video"] = "copy"
        return {"need": "sound", "why": "sound " + ",".join(sorted({a.get("codec_name") or "?" for a in auds})), "plan": plan}
    return {"need": None, "why": "plays everywhere"}


def look(node):
    """One look through the folder; what's new and steady looked into; what needs it put in jobs."""
    mem = node.memory("autoconvert")
    files = mem.setdefault("files", {})
    folder, tool, now = videos_dir(node), ffprobe(node), time.time()
    mem["lastLook"] = now
    if not os.path.isdir(folder):
        _state["why"] = "No folder %s here" % folder
        mem.save()
        return
    if not tool:
        _state["why"] = "No ffprobe here to look into videos with"
        mem.save()
        return
    _state["why"] = ""
    seen, probed = set(), 0
    for d, dirs, names in os.walk(folder):
        dirs[:] = sorted(x for x in dirs if not x.startswith("."))
        here = set(names)
        for n in sorted(names):
            if n.startswith(".") or not VIDEO.search(n) or CONVERTED.search(n) or "sample" in n.lower():
                continue
            p = os.path.join(d, n)
            try:
                st = os.stat(p)
            except OSError:
                continue
            seen.add(p)
            key = [st.st_size, int(st.st_mtime)]
            f = files.get(p)
            if f is None or f.get("key") != key:
                f = files[p] = {"key": key}
            if converted_name(n) in here:  # (made already: by a job, or by hand)
                f["state"] = "done"
            if "need" not in f and now - st.st_mtime >= STEADY_S:
                info = probe(node, tool, p)
                d = decide(info)
                plan = d.get("plan") or {}
                if plan.get("video") == "h264" and not plan.get("hdr") and "10" in str(next((s.get("pix_fmt") for s in info["streams"] if s.get("index") == plan["v"]), "")):
                    d = decide(info, frame_transfer(node, tool, p))  # (HDR is 10-bit: its first picture may say so)
                f.update(d)
                probed += 1
                _state["progress"] = "looked into %d" % probed
                if probed % 200 == 0:
                    mem.save()
    for p in [p for p in files if p not in seen]:  # (gone)
        del files[p]
    queue(node, mem, files, now)
    _state["progress"] = ""
    mem.save()


def queue(node, mem, files, now):
    """What needs converting and isn't on its way yet: a job for each kind (its switch on)."""
    jobs = {j["id"]: j for j in list(node.call("jobs", "book") or [])}
    pending = collections.defaultdict(list)
    for p, f in sorted(files.items()):
        kind = f.get("need")
        if not kind or f.get("state") == "done" or not node.setting("autoconvert", kind):
            continue
        job = jobs.get(f.get("job"))
        it = next((i for i in list(job["items"]) if i["source"]["path"] == p), None) if job else None
        if it and it["state"] in ("waiting", "running", "uploading"):
            continue
        if it and it["state"] == "done":
            if it.get("placed") is None:  # (being put beside its video now)
                continue
            if it["placed"] in ("placed", "already there"):
                f["state"] = "done"
                continue
            f["state"], f["failedAt"] = "failed", f.get("failedAt") or now
        elif it and it["state"] in ("failed", "stopped"):
            f["state"], f["failedAt"] = "failed", f.get("failedAt") or now
        if f.get("state") == "failed" and now - float(f.get("failedAt") or 0) < RETRY_S:
            continue
        pending[kind].append(p)
    for kind in KINDS:
        paths = pending.get(kind)
        if not paths:
            continue
        entries = []
        for p in paths:
            mem["next"] = int(mem.get("next") or 0) + 1
            entries.append({"name": "v%06d%s" % (mem["next"], os.path.splitext(p)[1].lower()), "size": files[p]["key"][0],
                            "node": node.name, "path": p, "plan": files[p]["plan"],
                            "place": os.path.join(os.path.dirname(p), converted_name(os.path.basename(p)))})
        a = node.call("jobs", "act_create", {"kind": "playable", "title": "Convert for every device: %d %s video%s" % (len(entries), WORDS[kind], "" if len(entries) == 1 else "s"),
                                             "params": {"auto": kind, "here": kind == "sound"}, "files": entries})
        if a and a.get("ok"):
            for p in paths:
                files[p].update(job=a["job"], state="queued")
            node.event("autoconvert", "Converting %d %s video%s for every device" % (len(paths), WORDS[kind], "" if len(paths) == 1 else "s"))
        else:
            node.event("autoconvert", "Couldn't make a job for the %s videos: %s" % (WORDS[kind], (a or {}).get("error", "the jobs module is off")), bad=True)


def tick(node):
    if not node.setting("jobs", "home"):
        _state["why"] = "Only the Pi that keeps the job list looks for videos"
        return
    mem = node.memory("autoconvert")
    if not _want["look"] and time.time() - float(mem.get("lastLook") or 0) < LOOK_EVERY:
        return
    _want["look"] = False
    with _lock:
        _state["looking"] = True
        try:
            look(node)
        finally:
            _state["looking"] = False


def status(node):
    mem = node.memory("autoconvert")
    files = mem.get("files") or {}
    need = collections.Counter(f["need"] for f in files.values() if f.get("need") and f.get("state") != "done")
    done = sum(1 for f in files.values() if f.get("need") and f.get("state") == "done")
    failed = sum(1 for f in files.values() if f.get("state") == "failed")
    broken = sum(1 for f in files.values() if f.get("broken"))
    last = float(mem.get("lastLook") or 0)
    if _state["looking"]:
        summary = "Looking through %s%s" % (videos_dir(node), " (%s)" % _state["progress"] if _state["progress"] else "")
    elif _state["why"]:
        summary = _state["why"]
    elif not last:
        summary = "Hasn't looked yet"
    else:
        left = ", ".join("%d %s" % (need[k], WORDS[k]) + ("" if node.setting("autoconvert", k) else " (switched off)") for k in KINDS if need[k])
        summary = "Looked at %s: %d videos · %s · %d converted%s · next look %s" % (
            time.strftime("%H:%M", time.localtime(last)), len(files), "to convert: " + left if left else "nothing to convert",
            done, ", %d failed (tried again a day later)" % failed if failed else "", time.strftime("%H:%M", time.localtime(last + LOOK_EVERY)))
    out = {"summary": summary, "toConvert": dict(need), "converted": done, "failed": failed, "lastLook": int(last * 1000) or None,
           "warnings": ["%d video%s ffprobe couldn't read" % (broken, "" if broken == 1 else "s")] if broken else []}
    return out


def act_look(node, args):
    _want["look"] = True
    return {"ok": True, "message": "Looking for new videos in %s." % videos_dir(node)}


def act_again(node, args):
    mem = node.memory("autoconvert")
    n = 0
    for f in (mem.get("files") or {}).values():
        if f.get("state") == "failed":
            f["failedAt"] = 1
            n += 1
    mem.save()
    _want["look"] = True
    return {"ok": True, "message": "%d failed video%s put back for the next look (now)." % (n, "" if n == 1 else "s")}


ACTIONS = {
    "look": {"title": "Look for new videos now", "run": act_look},
    "again": {"title": "Try the failed ones again", "run": act_again},
}
