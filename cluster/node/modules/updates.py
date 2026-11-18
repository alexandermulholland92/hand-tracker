"""
updates.py - Pi Cluster module: keeps this Pi up to date by itself. Each part has its own switch
for this Pi, and its own "now" button:
  Hand Tracker - the newest build on GitHub's "Latest build" release, as soon as it's out, once
    Hand Tracker isn't recording or saving a take; then Hand Tracker is restarted (if it was
    running) and Sentry turned back on (if it was on).
  This service - the same build's cluster/node files; it then restarts itself with them.
  Raspberry Pi OS - apt's updates (none removing a package), looked for every 6 hours and put in
    once Hand Tracker isn't recording. If they need the Pi restarted, it says so (Restart Pi);
    it isn't restarted by itself.
ht-cluster-root does the installing, and downloads and checks everything itself.
"""

import datetime
import json
import os
import threading
import time
import urllib.error
import urllib.request

TITLE = "Updates"
ORDER = 30
ON = True
EVERY = 30
SETTINGS = [
    {"key": "handTracker", "title": "Update Hand Tracker by itself", "default": True},
    {"key": "cluster", "title": "Update this service by itself", "default": True},
    {"key": "os", "title": "Update Raspberry Pi OS by itself", "default": True},
]

REPO = "alexandermulholland92/hand-tracker"
CHECK_EVERY = 600  # GitHub's release, at most this often (a check that changed nothing is free)
OS_EVERY = 6 * 3600
RETRY_AFTER = 3600  # a failed update, tried again after this (or at once from its button)
MISSING = "not in GitHub's latest build yet"
NOT_THERE = "Up to date (GitHub's latest build hasn't got it yet)"

_lock = threading.Lock()  # (one update at a time)
_want = {}  # what a button asked for: {"check", "handTracker", "cluster", "os": {"force": bool}}
_doing = {"what": None}
_state = {"handTracker": "", "cluster": "", "os": ""}


def short(commit):
    return (commit or "")[:7] or "?"


def when(iso):
    try:
        return datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def arch(node):
    if node.simulate:
        return "arm64"
    code, out, _ = node.run(["dpkg", "--print-architecture"], 5)
    return out.strip() if code == 0 else None


def boot_id(node):
    return (node.read("/proc/sys/kernel/random/boot_id", "") or "").strip()


def check_release(node):
    """GitHub's "Latest build": which commit it is, and the Hand Tracker package for this Pi."""
    mem = node.memory("updates")
    api = (os.environ.get("HT_CLUSTER_GITHUB_API") if node.simulate else None) or "https://api.github.com"
    req = urllib.request.Request(api + "/repos/%s/releases/tags/latest-build" % REPO,
                                 headers={"User-Agent": "ht-cluster", "Accept": "application/vnd.github+json"})
    if mem.get("etag") and mem.get("release"):
        req.add_header("If-None-Match", mem["etag"])
    mem["checkedAt"] = time.time()
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            rel = json.loads(res.read().decode("utf-8"))
            mem["etag"] = res.headers.get("ETag")
    except urllib.error.HTTPError as e:
        if e.code == 304:
            mem["checkError"] = None
            mem.save()
            return
        mem["checkError"] = "GitHub answered %d" % e.code
        mem.save()
        return
    except (OSError, ValueError) as e:
        mem["checkError"] = "Couldn't reach GitHub: %s" % e
        mem.save()
        return
    commit = str(rel.get("target_commitish") or "")
    want = "hand-tracker_"
    a = arch(node)
    deb = None
    for asset in rel.get("assets") or []:
        name = str(asset.get("name") or "")
        if a and name.startswith(want) and name.endswith("_%s.deb" % a) and name.count("_") == 2:
            deb = {"name": name, "size": asset.get("size"), "updated": asset.get("updated_at"), "digest": asset.get("digest")}
    mem["release"] = {"commit": commit if len(commit) == 40 else None, "at": rel.get("published_at") or rel.get("created_at"), "deb": deb}
    mem["checkError"] = None
    mem.save()


def failed_lately(mem, part, target):
    f = (mem.get("failed") or {}).get(part)
    return f if f and f.get("for") == target and time.time() - f.get("at", 0) < RETRY_AFTER else None


def note_failure(node, part, target, error):
    mem = node.memory("updates")
    mem.setdefault("failed", {})[part] = {"for": target, "at": time.time(), "error": error}
    mem.save()


def clear_failure(node, part):
    mem = node.memory("updates")
    if (mem.get("failed") or {}).pop(part, None):
        mem.save()


def rig(node):
    m = node.modules.get("rig")
    return m.mod if m else None


def recording(node):
    r = rig(node)
    return bool(r and r.busy(node))


def hand_tracker_outdated(inst, rel):
    deb = rel.get("deb") or {}
    if inst.get("commit") and rel.get("commit"):
        return inst["commit"] != rel["commit"]
    built = when(deb.get("updated"))
    if inst.get("installedAt") and built:
        return inst["installedAt"] < built
    return False


def update_hand_tracker(node, asked=None):
    mem = node.memory("updates")
    rel = mem.get("release") or {}
    deb = rel.get("deb")
    r = rig(node)
    inst = r.installed(node, fresh=True) if r else None
    if not inst:
        _state["handTracker"] = "Not installed on this Pi"
        return
    if not deb:
        _state["handTracker"] = "No build for this Pi on GitHub yet"
        return
    target = deb.get("updated")
    if not hand_tracker_outdated(inst, rel) and asked is None:
        _state["handTracker"] = "Up to date"
        clear_failure(node, "handTracker")
        return
    f = failed_lately(mem, "handTracker", target)
    if f and asked is None:
        _state["handTracker"] = "Didn't update: %s (tries again later)" % f["error"]
        return
    if recording(node) and not (asked or {}).get("force"):
        _state["handTracker"] = "Waiting: recording"
        return
    before = r.before_update(node)
    _state["handTracker"] = "Updating to %s…" % short(rel.get("commit"))
    node.event("updates", "Updating Hand Tracker to %s…" % short(rel.get("commit")))
    answer = node.root("install-hand-tracker", timeout=1800)
    if not answer.get("ok"):
        note_failure(node, "handTracker", target, answer.get("error") or "it didn't install")
        node.event("updates", "Hand Tracker didn't update: %s" % answer.get("error"), bad=True)
        _state["handTracker"] = "Didn't update: %s" % answer.get("error")
        return
    clear_failure(node, "handTracker")
    r.installed(node, fresh=True)
    after = r.restart_after(node, before)
    node.event("updates", "Hand Tracker updated to %s. %s" % (short(answer.get("commit") or rel.get("commit")), after))
    _state["handTracker"] = "Up to date"


def update_cluster(node, asked=None):
    mem = node.memory("updates")
    rel = mem.get("release") or {}
    if node.version == "dev":
        _state["cluster"] = "Running from a copy of the code: not updated by itself"
        return
    if not rel.get("commit"):
        _state["cluster"] = "No build on GitHub yet"
        return
    if node.version == rel["commit"] and asked is None:
        _state["cluster"] = "Up to date"
        clear_failure(node, "cluster")
        return
    f = failed_lately(mem, "cluster", rel["commit"])
    if f and asked is None:
        _state["cluster"] = NOT_THERE if f["error"] == MISSING else "Didn't update: %s (tries again later)" % f["error"]
        return
    _state["cluster"] = "Updating to %s…" % short(rel["commit"])
    answer = node.root("update-cluster", timeout=900)
    if not answer.get("ok") and answer.get("missing"):
        # (a copy put in before a build had it: kept until one does, asked again with the next build)
        note_failure(node, "cluster", rel["commit"], MISSING)
        _state["cluster"] = NOT_THERE
        return
    if not answer.get("ok"):
        note_failure(node, "cluster", rel["commit"], answer.get("error") or "it didn't update")
        node.event("updates", "This service didn't update: %s" % answer.get("error"), bad=True)
        _state["cluster"] = "Didn't update: %s" % answer.get("error")
        return
    clear_failure(node, "cluster")
    if answer.get("unchanged") or answer.get("commit") == node.version:
        _state["cluster"] = "Up to date"
        return
    node.event("updates", "Pi Cluster service updated to %s; restarting it." % short(answer.get("commit")))
    _state["cluster"] = "Restarting with %s…" % short(answer.get("commit"))
    node.restart_soon()
    return True  # (nothing more in this tick: the new service does the rest, not one about to end)


def check_os(node):
    mem = node.memory("updates")
    answer = node.root("os-check", timeout=900)
    o = mem.setdefault("os", {})
    o["checkedAt"] = time.time()
    if answer.get("ok"):
        o["upgradable"] = int(answer.get("upgradable") or 0)
        o["packages"] = (answer.get("packages") or [])[:30]
        o["error"] = None
    else:
        o["error"] = answer.get("error") or "couldn't look"
    mem.save()


def update_os(node, asked=None):
    mem = node.memory("updates")
    o = mem.setdefault("os", {})
    if o.get("rebootNeeded") and o.get("bootId") and o.get("bootId") != boot_id(node):
        o["rebootNeeded"] = False  # (it has been restarted since)
        mem.save()
    n = int(o.get("upgradable") or 0)
    if n <= 0 and asked is None:
        _state["os"] = "Up to date" if o.get("checkedAt") else "Not looked yet"
        return
    f = failed_lately(mem, "os", "any")
    if f and asked is None:
        _state["os"] = "Didn't update: %s (tries again later)" % f["error"]
        return
    if recording(node) and not (asked or {}).get("force"):
        _state["os"] = "%d update%s waiting: recording" % (n, "" if n == 1 else "s")
        return
    _state["os"] = "Putting in %d update%s…" % (n, "" if n == 1 else "s")
    node.event("updates", "Putting in Raspberry Pi OS updates (%d)…" % n)
    answer = node.root("os-upgrade", timeout=3600)
    if not answer.get("ok"):
        note_failure(node, "os", "any", answer.get("error") or "they didn't go in")
        node.event("updates", "Raspberry Pi OS updates didn't go in: %s" % answer.get("error"), bad=True)
        _state["os"] = "Didn't update: %s" % answer.get("error")
        return
    clear_failure(node, "os")
    o["upgradable"] = 0
    o["lastAt"] = time.time()
    if answer.get("rebootNeeded"):
        o["rebootNeeded"] = True
        o["bootId"] = boot_id(node)
    mem.save()
    node.event("updates", "Raspberry Pi OS updated (%s)%s" % (answer.get("upgraded", n), "; restart this Pi to finish." if o.get("rebootNeeded") else "."))
    _state["os"] = "Up to date"


def tick(node):
    mem = node.memory("updates")
    with _lock:
        asked = dict(_want)
        _want.clear()
        now = time.time()
        try:
            if "check" in asked or now - mem.get("checkedAt", 0) > CHECK_EVERY:
                _doing["what"] = "check"
                check_release(node)
            if "check" in asked or "os" in asked or (node.setting("updates", "os") and now - (mem.get("os") or {}).get("checkedAt", 0) > OS_EVERY):
                _doing["what"] = "os-check"
                check_os(node)
            if node.setting("updates", "cluster") or "cluster" in asked:
                _doing["what"] = "cluster"
                if update_cluster(node, asked.get("cluster")):
                    return
            if node.setting("updates", "handTracker") or "handTracker" in asked:
                _doing["what"] = "handTracker"
                update_hand_tracker(node, asked.get("handTracker"))
            if node.setting("updates", "os") or "os" in asked:
                _doing["what"] = "os"
                update_os(node, asked.get("os"))
        finally:
            _doing["what"] = None


def status(node):
    mem = node.memory("updates")
    rel = mem.get("release") or {}
    o = mem.get("os") or {}
    auto = {k: bool(node.setting("updates", k)) for k in ("handTracker", "cluster", "os")}
    out = {
        "latest": {"commit": rel.get("commit"), "at": rel.get("at"), "checkedAt": mem.get("checkedAt"), "error": mem.get("checkError")},
        "handTracker": {"state": _state["handTracker"] or ("Off" if not auto["handTracker"] else "Not looked yet"), "auto": auto["handTracker"]},
        "cluster": {"state": _state["cluster"] or ("Off" if not auto["cluster"] else "Not looked yet"), "auto": auto["cluster"], "version": node.version},
        "os": {"state": _state["os"] or ("Off" if not auto["os"] else "Not looked yet"), "auto": auto["os"],
               "upgradable": o.get("upgradable"), "checkedAt": o.get("checkedAt"), "rebootNeeded": bool(o.get("rebootNeeded")), "error": o.get("error")},
        "doing": _doing["what"],
    }
    low = lambda s: s[:1].lower() + s[1:]
    out["summary"] = "Hand Tracker: %s · This service: %s · Raspberry Pi OS: %s" % (
        low(out["handTracker"]["state"]), low(out["cluster"]["state"]), low(out["os"]["state"]))
    warn = []
    if out["os"]["rebootNeeded"]:
        warn.append("Restart this Pi to finish its system updates")
    if mem.get("checkError"):
        warn.append(mem["checkError"])
    for part, title in (("handTracker", "Hand Tracker"), ("cluster", "This service"), ("os", "Raspberry Pi OS")):
        if out[part]["state"].startswith("Didn't"):
            warn.append("%s: %s" % (title, out[part]["state"]))
    out["warnings"] = warn
    return out


def ask(node, what, args):
    _want[what] = {"force": bool((args or {}).get("force"))}
    m = node.modules.get("updates")
    if m:
        m.wake.set()


def act_check(node, args):
    ask(node, "check", args)
    return {"ok": True, "message": "Looking for updates."}


def act_ht(node, args):
    ask(node, "check", {})
    ask(node, "handTracker", args)
    return {"ok": True, "message": "Updating Hand Tracker if there's a newer build" + ("" if args.get("force") else " (once it isn't recording)") + "."}


def act_cluster(node, args):
    ask(node, "check", {})
    ask(node, "cluster", args)
    return {"ok": True, "message": "Updating this service if there's a newer build."}


def act_os(node, args):
    ask(node, "os", args)
    return {"ok": True, "message": "Looking for Raspberry Pi OS updates and putting them in" + ("" if args.get("force") else " (once it isn't recording)") + "."}


def act_reboot(node, args):
    if recording(node) and not args.get("force"):
        return {"ok": False, "error": "It's recording. Stop the recording first."}
    node.event("updates", "Restarting this Pi.")
    answer = node.root("reboot", timeout=60)
    return {"ok": bool(answer.get("ok")), "message": "Restarting this Pi.", "error": answer.get("error")}


ACTIONS = {
    "check": {"title": "Check for updates", "run": act_check},
    "updateHandTracker": {"title": "Update Hand Tracker now", "run": act_ht},
    "updateCluster": {"title": "Update this service now", "run": act_cluster},
    "updateOS": {"title": "Update Raspberry Pi OS now", "run": act_os},
    "reboot": {"title": "Restart this Pi", "run": act_reboot, "confirm": "Restart this Pi now? Hand Tracker stops until it's back."},
}
