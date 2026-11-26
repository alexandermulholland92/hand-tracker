"""
updates.py - Cluster module: keeps this Pi up to date by itself. Each part has its own switch
for this Pi, and its own "now" button:
  Hand Tracker - the newest build on GitHub's "Latest build" release, as soon as it's out, once
    Hand Tracker isn't recording or saving a take; then Hand Tracker is restarted (if it was
    running) and Sentry turned back on (if it was on).
  This service - the same build's cluster/node files, as soon as the build is out, on every Pi (it doesn't wait for
    a first Pi's try: the user, 2026-11-25, "Service never waits"); it then restarts itself with them.
  Raspberry Pi OS - apt's updates (none removing a package), looked for every 6 hours and put in
    once Hand Tracker isn't recording. If they need the Pi restarted, it says so (Restart Pi);
    it isn't restarted by itself.
ht-cluster-root does the installing, and downloads and checks everything itself.

A new build's Hand Tracker goes to one Pi first (the user, 2026-11-22, from a capture rig fleet's own rollouts: "an
idle Pi, no cameras"): an idle Pi (not recording, not running Transmission; the first by name, so every Pi picks the
same one) puts it in by itself, then checks the build without opening a camera: this service on that build with all
its modules started, Hand Tracker on it and answering (if it was running). The others put Hand Tracker in by
themselves 30 minutes after that check passed; not at all if it failed (each Pi's button still updates it). With
no idle Pi, a Pi not recording goes ahead once the build is 2 hours old (a lone Pi too). Each Pi's status says which
build it tried first and how that went, and how many commits behind its service and Hand Tracker are. While
Hand Tracker is being put in, it won't start a recording (/tmp/hand-tracker-updating); an update waits while it
records, as before.

After each start, this service's own files are checked against the build they came from (verify-cluster), and
any a power cut damaged put back.
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
SOAK_S = 30 * 60  # (the others follow this long after the first Pi's check passed: the user's choice)
TRIAL_STALE_S = 3600  # (a first Pi that hasn't finished its check in this time: another may go first)
NO_IDLE_S = 2 * 3600  # (no idle Pi to go first: a Pi not recording goes ahead once the build is this old)
CHECK_HT_S = 180  # (Hand Tracker answering again after its restart)
UPDATING_FLAG = "/tmp/hand-tracker-updating"  # (Hand Tracker won't start a recording while it's there: remote-record.js)
if os.environ.get("HT_CLUSTER_SIM_FAST"):
    SOAK_S, TRIAL_STALE_S, NO_IDLE_S, CHECK_HT_S = 6, 60, 3600, 10

_lock = threading.Lock()  # (one update at a time)
_want = {}  # what a button asked for: {"check", "handTracker", "cluster", "os": {"force": bool}}
_doing = {"what": None}
_state = {"handTracker": "", "cluster": "", "os": "", "idle": False, "plan": None}


def short(commit):
    return (commit or "")[:7] or "?"


def when(iso):
    try:
        return datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


WINDOWS = os.environ.get("HT_CLUSTER_PLATFORM") == "windows"  # (a Windows PC: only this service, its own way)
if WINDOWS:
    SETTINGS = [s for s in SETTINGS if s["key"] == "cluster"]
NOT_HERE_HT = "Not Cluster's to update on Windows"
NOT_HERE_OS = "Windows Update looks after this PC"


def arch(node):
    if WINDOWS:
        return None
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
    if WINDOWS:
        _state["handTracker"] = NOT_HERE_HT
        return
    r = rig(node)
    inst = r.installed(node, fresh=True) if r else None
    if not inst:
        _state["handTracker"] = "Not installed on this device"
        return
    if not deb:
        _state["handTracker"] = "No build for this device on GitHub yet"
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
    updating_flag(node, True)  # (no recording started meanwhile: until it's restarted)
    try:
        answer = node.root("install-hand-tracker", timeout=1800)
        if not answer.get("ok"):
            note_failure(node, "handTracker", target, answer.get("error") or "it didn't install")
            node.event("updates", "Hand Tracker didn't update: %s" % answer.get("error"), bad=True)
            _state["handTracker"] = "Didn't update: %s" % answer.get("error")
            return
        clear_failure(node, "handTracker")
        r.installed(node, fresh=True)
        after = r.restart_after(node, before)
    finally:
        updating_flag(node, False)
    node.event("updates", "Hand Tracker updated to %s. %s" % (short(answer.get("commit") or rel.get("commit")), after))
    _state["handTracker"] = "Up to date"


def updating_flag(node, on):
    """Hand Tracker told it's being put in (remote-record.js won't start a recording while the flag's there and
    not past its time)."""
    path = os.environ.get("HT_CLUSTER_SIM_UPDATING_FLAG") if node.simulate else UPDATING_FLAG
    if not path:
        return
    try:
        if on:
            with open(path + ".new", "w", encoding="utf-8") as f:
                json.dump({"until": int((time.time() + 1800) * 1000), "by": "Cluster"}, f)
            os.replace(path + ".new", path)
        elif os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


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
    node.event("updates", "Cluster service updated to %s; restarting it." % short(answer.get("commit")))
    _state["cluster"] = "Restarting with %s…" % short(answer.get("commit"))
    node.restart_soon()
    return True  # (nothing more in this tick: the new service does the rest, not one about to end)


def check_os(node):
    if WINDOWS:
        return
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
    if WINDOWS:
        _state["os"] = NOT_HERE_OS
        return
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
    node.event("updates", "Raspberry Pi OS updated (%s)%s" % (answer.get("upgraded", n), "; restart this device to finish." if o.get("rebootNeeded") else "."))
    _state["os"] = "Up to date"


def start_key(node):
    """Which start of this computer it is: Linux's boot id; on Windows, when it started (to the minute)."""
    if node.simulate:
        return os.environ.get("HT_CLUSTER_SIM_BOOT_ID") or "simulated-boot"
    if WINDOWS:
        import winsys
        return "windows-%d" % round((time.time() - winsys.uptime()) / 60)
    return boot_id(node)


def verify(node):
    """This service's own files checked once after each start (the user, 2026-11-22, from a capture rig's own fix:
    files a power cut damaged put back from GitHub, by verify-cluster), and the service restarted with them if any
    of its code was. -> True when it restarts."""
    if node.version == "dev":
        return False
    mem = node.memory("updates")
    key = start_key(node)
    v = mem.get("verified") or {}
    if v.get("start") == key or (v.get("failedStart") == key and time.time() - v.get("failedAt", 0) < RETRY_AFTER):
        return False
    _doing["what"] = "verify"
    answer = node.root("verify-cluster", timeout=900)
    if not answer.get("ok") and not answer.get("missing"):
        mem["verified"] = dict(v, failedStart=key, failedAt=time.time(), error=answer.get("error"))
        mem.save()
        return False
    repaired = answer.get("repaired") or []
    mem["verified"] = {"start": key, "at": time.time(), "repaired": repaired}
    mem.save()
    if not repaired:
        return False
    node.event("updates", "After this start, %d of this service's files weren't as its build has them (a power cut?): put back from GitHub (%s)." % (
        len(repaired), ", ".join(repaired[:6])), bad=True)
    if any(r.endswith(".py") for r in repaired):
        node.restart_soon()
        return True
    return False


def tick(node):
    mem = node.memory("updates")
    with _lock:
        asked = dict(_want)
        _want.clear()
        now = time.time()
        try:
            if verify(node):
                return
            if "check" in asked or now - mem.get("checkedAt", 0) > CHECK_EVERY:
                _doing["what"] = "check"
                check_release(node)
                note_behind(node)
            if "check" in asked or "os" in asked or (node.setting("updates", "os") and now - (mem.get("os") or {}).get("checkedAt", 0) > OS_EVERY):
                _doing["what"] = "os-check"
                check_os(node)
            rel = mem.get("release") or {}
            _state["idle"] = idle(node)
            # (this service: each build at once, on every Pi (the user, 2026-11-25: "Service never waits"); only
            # Hand Tracker waits for a first Pi's try)
            if node.setting("updates", "cluster") or "cluster" in asked:
                _doing["what"] = "cluster"
                if update_cluster(node, asked.get("cluster")):
                    return
            go, why = plan(node, rel) if ht_needed(node, rel) else (True, None)
            _state["plan"] = why
            if WINDOWS:
                _state.update(handTracker=NOT_HERE_HT, os=NOT_HERE_OS)
            elif node.setting("updates", "handTracker") or "handTracker" in asked:
                _doing["what"] = "handTracker"
                if "handTracker" not in asked and not go and ht_outdated(node, rel):
                    _state["handTracker"] = waiting(node, "handTracker", why)
                else:
                    update_hand_tracker(node, asked.get("handTracker"))
            trial_progress(node, rel)
            if not WINDOWS and (node.setting("updates", "os") or "os" in asked):
                _doing["what"] = "os"
                update_os(node, asked.get("os"))
        finally:
            _doing["what"] = None


# ----- a new build to one Pi first (the user, 2026-11-22) -----
def hhmm(t):
    return time.strftime("%H:%M", time.localtime(t))


def cluster_outdated(node, rel):
    return bool(rel.get("commit")) and node.version not in ("dev", rel["commit"])


def ht_outdated(node, rel):
    if WINDOWS:
        return False
    r = rig(node)
    inst = r.installed(node) if r else None
    return bool(inst and rel.get("deb") and hand_tracker_outdated(inst, rel))


def ht_needed(node, rel):
    """Whether Hand Tracker here has the latest build to put in by itself (the part that waits for a first Pi's try)."""
    return bool(rel.get("commit")) and not WINDOWS and bool(node.setting("updates", "handTracker")) and ht_outdated(node, rel)


def needs(node, rel):
    """Whether this Pi's own automatic updates have something to put in from the latest build."""
    return bool(rel.get("commit")) and ((node.setting("updates", "cluster") and cluster_outdated(node, rel)) or ht_needed(node, rel))


def idle(node):
    """Free to try a new build first: not recording, and not running Transmission."""
    if WINDOWS or recording(node):
        return False
    m = node.modules.get("apps")
    try:
        return not (m and node.is_on("apps") and m.mod.unit_active(node))
    except Exception:
        return False


def others(node):
    """The other members' word about their updates: [(name, updates status)], those answering with Updates on."""
    out = []
    for p in node.cluster():
        m = next((x for x in (p.get("node") or {}).get("modules") or [] if x.get("name") == "updates" and x.get("on")), None)
        if m:
            out.append((p["name"], m.get("status") or {}))
    return out


def plan(node, rel):
    """Whether this Pi puts the latest build in by itself now: -> (True, None), or (False, why it waits)."""
    c, now = rel["commit"], time.time()
    mem = node.memory("updates")
    mine = mem.get("trial") or {}
    peers = others(node)
    trials = [(n, t) for n, t in [(node.name, mine)] + [(n, st.get("trial") or {}) for n, st in peers] if t.get("commit") == c]
    passed = sorted((t.get("at") or now, n) for n, t in trials if t.get("state") == "passed")
    if passed:
        if now - passed[0][0] >= SOAK_S:
            return True, None
        return False, "%s tried it first; the others follow at %s" % (passed[0][1], hhmm(passed[0][0] + SOAK_S))
    failed = next(((n, t) for n, t in trials if t.get("state") == "failed"), None)
    if failed:
        return False, "%s's check of this build failed (%s), so it isn't put in by itself" % (failed[0], failed[1].get("error") or "?")
    if mine.get("commit") == c and mine.get("state") in ("updating", "checking"):
        return True, None  # (its own first try: on with it)
    going = [n for n, t in trials if n != node.name and t.get("state") in ("updating", "checking") and now - (t.get("at") or 0) < TRIAL_STALE_S]
    if going:
        return False, "%s tries it first" % going[0]
    stuck = {n for n, t in trials if t.get("state") == "stuck"}
    first = sorted([n for n, st in peers if st.get("idle") and not st.get("windows") and n not in stuck] +
                   ([node.name] if _state["idle"] and node.name not in stuck else []))
    if first:
        if first[0] != node.name:
            return False, "%s tries it first" % first[0]
        mem["trial"] = {"commit": c, "state": "updating", "at": now}
        mem.save()
        node.event("updates", "Trying build %s's Hand Tracker here first: the others put it in 30 minutes after its check passes." % short(c))
        return True, None
    if recording(node):
        return False, "recording"
    if now - (when(rel.get("at")) or now) >= NO_IDLE_S:
        return True, None
    return False, "no idle device has tried it first yet"


def trial_progress(node, rel):
    """The first Pi, once both parts are in: its check (no camera opened), passed or failed; or, when one didn't go
    in, given up (another idle Pi may go first)."""
    mem = node.memory("updates")
    t = mem.get("trial") or {}
    if not rel.get("commit") or t.get("commit") != rel["commit"] or t.get("state") not in ("updating", "checking"):
        return
    if needs(node, rel):
        fails = [f for part, f in (mem.get("failed") or {}).items() if part in ("cluster", "handTracker") and time.time() - f.get("at", 0) < RETRY_AFTER]
        if fails:
            t.update(state="stuck", at=time.time(), error=fails[0].get("error"))
            mem.save()
            node.event("updates", "Build %s didn't go in here (%s): another device can try it first." % (short(rel["commit"]), t["error"]), bad=True)
        return
    t.update(state="checking", at=time.time())
    mem.save()
    _state["plan"] = "checking build %s here first" % short(rel["commit"])
    ok, why = self_check(node, rel)
    t.update(state="passed" if ok else "failed", at=time.time(), error=None if ok else why)
    mem.save()
    if ok:
        node.event("updates", "Build %s checked out here (no camera opened): the others put its Hand Tracker in by themselves 30 minutes from now." % short(rel["commit"]))
    else:
        node.event("updates", "Build %s didn't pass its check here: %s. The others won't put its Hand Tracker in by themselves." % (short(rel["commit"]), why), bad=True)


def self_check(node, rel):
    """The first Pi's check of a build, no camera opened: this service is on it with all its modules started, and
    Hand Tracker (if it's here) is on it and answers (if it's running). -> (ok, why not)."""
    if node.setting("updates", "cluster") and cluster_outdated(node, rel):
        return False, "this service isn't on it"
    broken = sorted(m.name for m in node.modules.values() if m.error)
    if broken:
        return False, "this service's %s didn't start" % ", ".join(broken)
    r = rig(node)
    if WINDOWS or not r:
        return True, None
    inst = r.installed(node, fresh=True)
    if not inst:
        return True, None
    if node.setting("updates", "handTracker") and hand_tracker_outdated(inst, rel):
        return False, "Hand Tracker isn't on it"
    if not r.app_process(node):  # (not running: not started for this)
        return True, None
    until = time.time() + CHECK_HT_S
    while time.time() < until:
        code, _ = r.ht(node, "GET", "/api/state", timeout=6)
        if code == 200:
            return True, None
        time.sleep(3)
    return False, "Hand Tracker didn't answer within %d s of its restart" % CHECK_HT_S


def waiting(node, part, why):
    return "Waiting: %s" % why


def behind_words(mem, part, out):
    """" (3 commits behind)" while that part isn't up to date and GitHub said how far behind it is."""
    b = mem.get("behind") or {}
    n = b.get(part) if b.get("for") == (mem.get("release") or {}).get("commit") else None
    return " (%d commit%s behind)" % (n, "" if n == 1 else "s") if n and not out[part]["state"].startswith("Up to date") else ""


def compare(node, base, head):
    """How many commits base is behind head (GitHub's compare), or None (not known)."""
    if not base or not head or base == head:
        return 0 if base and base == head else None
    api = (os.environ.get("HT_CLUSTER_GITHUB_API") if node.simulate else None) or "https://api.github.com"
    req = urllib.request.Request(api + "/repos/%s/compare/%s...%s" % (REPO, base, head),
                                 headers={"User-Agent": "ht-cluster", "Accept": "application/vnd.github+json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            n = json.loads(res.read().decode("utf-8")).get("ahead_by")
        return int(n) if n is not None else None
    except (OSError, ValueError, TypeError):
        return None


def note_behind(node):
    """How far behind the latest build this service and Hand Tracker are (counted when a build comes out)."""
    mem = node.memory("updates")
    head = (mem.get("release") or {}).get("commit")
    if not head:
        return
    r = rig(node)
    inst = (r.installed(node) if r and not WINDOWS else None) or {}
    out = {"for": head}
    for part, base in (("cluster", node.version if len(node.version) == 40 else None), ("handTracker", inst.get("commit"))):
        old = mem.get("behind") or {}
        out[part] = old.get(part) if old.get("for") == head and old.get(part + "Base") == base else compare(node, base, head)
        out[part + "Base"] = base
    mem["behind"] = out
    mem.save()


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
        # (for the others' choice of the Pi that tries a new build first, and what it found)
        "trial": mem.get("trial"), "idle": bool(_state["idle"]), "windows": WINDOWS, "waiting": _state["plan"],
        "behind": {k: v for k, v in (mem.get("behind") or {}).items() if k in ("cluster", "handTracker", "for")},
    }
    low = lambda s: s[:1].lower() + s[1:]
    if WINDOWS:
        out["handTracker"]["state"], out["os"]["state"] = NOT_HERE_HT, NOT_HERE_OS
        out["summary"] = "This service: %s" % (low(out["cluster"]["state"]) + behind_words(mem, "cluster", out))
    else:
        out["summary"] = "Hand Tracker: %s · This service: %s · Raspberry Pi OS: %s" % (
            low(out["handTracker"]["state"]) + behind_words(mem, "handTracker", out), low(out["cluster"]["state"]) + behind_words(mem, "cluster", out),
            low(out["os"]["state"]))
    warn = []
    if out["os"]["rebootNeeded"]:
        warn.append("Restart this device to finish its system updates")
    if mem.get("checkError"):
        warn.append(mem["checkError"])
    for part, title in (("handTracker", "Hand Tracker"), ("cluster", "This service"), ("os", "Raspberry Pi OS")):
        if out[part]["state"].startswith("Didn't"):
            warn.append("%s: %s" % (title, out[part]["state"]))
    t = mem.get("trial") or {}
    if t.get("state") == "failed" and t.get("commit") == rel.get("commit"):
        warn.append("Build %s didn't pass its check here (%s): no device puts it in by itself" % (short(t["commit"]), t.get("error")))
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
    if WINDOWS:
        return {"ok": False, "error": "Cluster doesn't restart a Windows PC."}
    if recording(node) and not args.get("force"):
        return {"ok": False, "error": "It's recording. Stop the recording first."}
    node.event("updates", "Restarting this device.")
    answer = node.root("reboot", timeout=60)
    return {"ok": bool(answer.get("ok")), "message": "Restarting this device.", "error": answer.get("error")}


ACTIONS = {
    "check": {"title": "Check for updates", "run": act_check},
    "updateHandTracker": {"title": "Update Hand Tracker now", "run": act_ht, "hidden": WINDOWS},
    "updateCluster": {"title": "Update this service now", "run": act_cluster},
    "updateOS": {"title": "Update Raspberry Pi OS now", "run": act_os, "hidden": WINDOWS},
    "reboot": {"title": "Restart this device", "run": act_reboot, "confirm": "Restart this device now? Hand Tracker stops until it's back.", "hidden": WINDOWS},
}
