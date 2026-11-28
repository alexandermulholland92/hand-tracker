"""
installs.py - Cluster module: the project's apps on this device (the user, 2026-11-27: "add a download link for all not
downloaded apps from the cluster app"; answers: the device Cluster runs on and the Pis in the cluster, "Install where it
can").

Each app is listed as here (and which version) or not. On a Pi, one that isn't here is put in from the Cluster app
(its Install button): the latest build's .deb for this Pi's processor, checked against GitHub's size and SHA-256 and put
in by the root helper (install-app; Hand Tracker's own install-hand-tracker). On a Windows PC, which can't put them in
for you (its apps are single files, run where they're saved), it lists the ones not seen on it (each app notes itself
when it starts: electron/main.js, %APPDATA%/Hand Tracker Apps/seen.json), to get from hand-tracker.com's Download menu.
One install at a time; while Hand Tracker records, it waits (the root helper's own lock keeps it from overlapping an
update).

  status: {"summary", "apps": [{"slug", "name", "here", "version"?}], "canInstall", "doing"?, "warnings"?}
"""

import json
import os
import threading

TITLE = "Hand Tracker's apps"
ORDER = 32
ON = True
EVERY = 60
PLATFORMS = ("linux", "windows")

# (each app's .deb package and the kind its computer app calls itself: scripts/dist.js, electron/main.js APPS)
APPS = (
    ("hand-tracker", "Hand Tracker", "full"),
    ("hand-mouse", "Hand Mouse", "mouse"),
    ("remote-recording", "Remote Recording", "remote"),
    ("recording-converter", "Recording Converter", "converter"),
    ("hand-tracker-cluster", "Cluster", "cluster"),
    ("cluster-call", "Cluster Call", "clustercall"),
)
_state = {"apps": None, "doing": None, "said": {}, "lock": threading.Lock()}


def seen_on_windows():
    """The apps that noted themselves on this PC (each as it starts): {kind: {"version"}}."""
    path = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "Hand Tracker Apps", "seen.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def look(node):
    """What's here now: [{"slug", "name", "here", "version"?}]."""
    here = {}
    if node.simulate:  # (the checks: a list in a file the stand-in root helper adds to)
        path = os.environ.get("HT_CLUSTER_SIM_APPS")
        try:
            with open(path, "r", encoding="utf-8") as f:
                here = {s.strip(): "1.1.0" for s in f.read().split(",") if s.strip()}
        except (OSError, TypeError):
            here = {}
    elif node.windows:
        seen = seen_on_windows()
        here = {slug: str((seen.get(kind) or {}).get("version") or "") for slug, _, kind in APPS if kind in seen}
    else:
        code, out, _ = node.run(["dpkg-query", "-W", "-f", "${Package} ${db:Status-Status} ${Version}\\n"] + [a[0] for a in APPS], 30)
        for line in (out or "").splitlines():
            parts = line.split()
            if len(parts) >= 3 and parts[1] == "installed":
                here[parts[0]] = parts[2]
    out = []
    for slug, name, _ in APPS:
        a = {"slug": slug, "name": name, "here": slug in here}
        if here.get(slug):
            a["version"] = here[slug]
        out.append(a)
    return out


def tick(node):
    _state["apps"] = look(node)


def status(node):
    apps = _state["apps"]
    if apps is None:
        return {"summary": "Looking…"}
    missing = [a["name"] for a in apps if not a["here"]]
    can = not node.windows
    out = {"apps": apps, "canInstall": can}
    doing = _state["doing"]
    if doing:
        out["doing"] = doing
        out["summary"] = "Putting in %s…" % dict((a[0], a[1]) for a in APPS)[doing]
    elif not missing:
        out["summary"] = "All of Hand Tracker's apps are here."
    else:
        out["summary"] = "Not here yet: %s.%s" % (", ".join(missing), " Install below." if can else
                                                   " Get them on this PC from hand-tracker.com's Download menu.")
    bad = [said for said in _state["said"].values() if said]
    if bad:
        out["warnings"] = bad
    return out


def install(node, slug):
    name = dict((a[0], a[1]) for a in APPS).get(slug)
    if not name:
        return {"ok": False, "message": "No such app."}
    if node.windows:
        return {"ok": False, "message": "On a Windows PC, get %s from hand-tracker.com's Download menu." % name}
    with _state["lock"]:
        if _state["doing"]:
            return {"ok": False, "message": "Putting in %s already: one at a time." % _state["doing"]}
        if any(a["slug"] == slug and a["here"] for a in (_state["apps"] or [])):
            return {"ok": True, "message": "%s is here already." % name}
        _state["doing"] = slug
        _state["said"].pop(slug, None)

    def go():
        try:
            answer = node.root("install-hand-tracker") if slug == "hand-tracker" else node.root("install-app", slug)
            if answer.get("ok"):
                node.event("installs", "%s put in (%s)" % (name, str(answer.get("asset") or "the latest build")))
            else:
                _state["said"][slug] = "%s didn't go in: %s" % (name, answer.get("error") or "no answer")
                node.event("installs", _state["said"][slug], bad=True)
        finally:
            _state["apps"] = look(node)
            _state["doing"] = None
    threading.Thread(target=go, daemon=True, name="install-" + slug).start()
    return {"ok": True, "message": "Putting in %s (from the latest build: a few minutes)…" % name}


def _action(slug, name):
    return {"title": "Install %s" % name, "run": lambda node, args: install(node, slug),
            "confirm": "Put %s on this device, from the latest build?" % name}


ACTIONS = {"install-" + slug: _action(slug, name) for slug, name, _ in APPS}
