"""
phonesys.py - what Cluster's service needs from the phone it runs on (the Cluster app on Android or an iPhone, the
user, 2026-11-23: "Have phone's able to join the cluster as a member too"; HT_CLUSTER_PLATFORM=android or ios): its
readings (its battery, temperature, memory, storage, Wi-Fi, how long it's been on, its model), from the app itself.

The app answers in JSON: on Android through Chaquopy's Java bridge (the app's com.handtracker.app.PhoneNative), on an
iPhone through a C function the app exports (ht_native_call, ctypes); in the checks (HT_CLUSTER_PHONE_SIM) made up.
Only used on phones (node.phone). The service's modules import it when they run there.

  readings() -> {"model", "memory": {total, available}, "tempC", "battery": {level, plugged, charging},
                 "wifi": {ssid?, dbm?, mhz?} or None, "drives": [{mount, total, free}], "uptime", "cores"}
  call(name, args) -> the app's answer to one of its own calls (a dict), for the other parts (jobs, downloads)
"""

import json
import os
import time

PLATFORM = os.environ.get("HT_CLUSTER_PLATFORM") or ""
_native = {"fn": None, "ios": None}  # (the backend chosen; the iPhone app's two functions)


def _android(name, args):
    from java import jclass  # (Chaquopy's: only in the Android app)

    return str(jclass("com.handtracker.app.PhoneNative").call(name, json.dumps(args)))


def _ios(name, args):
    import ctypes

    if _native["ios"] is None:
        # (the app gives the addresses of its two functions, ClusterMember.swift: an app's own symbols aren't for
        # looking up)
        call_at, free_at = os.environ.get("HT_CLUSTER_NATIVE_CALL"), os.environ.get("HT_CLUSTER_NATIVE_FREE")
        if call_at and free_at:
            fn = ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p)(int(call_at))
            free = ctypes.CFUNCTYPE(None, ctypes.c_void_p)(int(free_at))
        else:
            lib = ctypes.CDLL(None)
            fn = lib.ht_native_call
            fn.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
            fn.restype = ctypes.c_void_p
            free = lib.ht_native_free
            free.argtypes = [ctypes.c_void_p]
        _native["ios"] = (fn, free)
    fn, free = _native["ios"]
    ptr = fn(name.encode("utf-8"), json.dumps(args).encode("utf-8"))
    try:
        return ctypes.string_at(ptr).decode("utf-8") if ptr else "{}"
    finally:
        if ptr:
            free(ptr)


_sim = {"runs": {}, "next": 1}


def _sim_ffmpeg(args):
    """The checks' phone's ffmpeg: this computer's (HT_CLUSTER_FFMPEG; HT_CLUSTER_FFPROBE), as the app runs its own."""
    import subprocess
    import threading

    tool = (os.environ.get("HT_CLUSTER_FFPROBE") if args.get("probe") else os.environ.get("HT_CLUSTER_FFMPEG")) or ("ffprobe" if args.get("probe") else "ffmpeg")
    extra = [] if args.get("probe") else ["-progress", "pipe:1", "-nostats"]
    p = subprocess.Popen([tool] + list(args.get("args") or [])[:-1] + extra + list(args.get("args") or [])[-1:] if extra else [tool] + list(args.get("args") or []),
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    run = {"proc": p, "log": [], "out": [], "time": -1, "done": False, "code": -1}

    def err():
        for line in p.stderr:
            run["log"].append(line)

    def out():
        for line in p.stdout:
            if extra and line.startswith("out_time_us=") and line.strip()[12:].isdigit():
                run["time"] = int(line.strip()[12:]) // 1000
            elif not extra:
                run["out"].append(line)
        p.wait()
        run["code"], run["done"] = p.returncode, True
    threads = [threading.Thread(target=err, daemon=True), threading.Thread(target=out, daemon=True)]
    for t in threads:
        t.start()
    run["threads"] = threads
    return run


def _simulated(name, args):
    """For the checks: a phone as the app would answer (HT_CLUSTER_PHONE_SIM: its battery level, and whether it's
    charging: "37" or "37,charging"); its ffmpeg this computer's."""
    if name == "ffmpeg-start":
        rid = _sim["next"]
        _sim["next"] += 1
        _sim["runs"][rid] = _sim_ffmpeg(args)
        return json.dumps({"ok": True, "id": rid})
    if name == "ffmpeg-poll":
        run = _sim["runs"].get(args.get("id"))
        if not run:
            return json.dumps({"ok": False, "error": "No such ffmpeg."})
        done = run["done"]
        if done:
            for t in run["threads"]:
                t.join(5)
        text, run["log"] = "".join(run["log"]), []
        if done:
            _sim["runs"].pop(args.get("id"), None)
        return json.dumps({"ok": True, "log": text, "time": run["time"], "done": done, "code": run["code"]})
    if name == "ffmpeg-cancel":
        run = _sim["runs"].get(args.get("id"))
        if run:
            run["proc"].kill()
        return json.dumps({"ok": True})
    if name == "ffmpeg-run":
        run = _sim_ffmpeg(args)
        try:
            run["proc"].wait(float(args.get("timeout") or 60))
        except Exception:
            run["proc"].kill()
        for t in run["threads"]:
            t.join(5)
        return json.dumps({"ok": True, "code": run["proc"].returncode, "log": "".join(run["log"]), "output": "".join(run["out"])})
    if name == "readings":
        level, _, how = (os.environ.get("HT_CLUSTER_PHONE_SIM") or "80").partition(",")
        return json.dumps({
            "model": "Simulated phone (Android 16)", "cores": 8, "memory": {"total": 8 * 1024 ** 3, "available": 3 * 1024 ** 3},
            "tempC": 31, "battery": {"level": int(level), "plugged": how == "charging", "charging": how == "charging"},
            "wifi": {"ssid": "Home", "dbm": -55, "mhz": 5180}, "drives": [{"mount": "phone", "total": 128 * 10 ** 9, "free": 40 * 10 ** 9}],
            "uptime": int(time.time() % 100000)})
    return json.dumps({"ok": False, "error": "No %s on a simulated phone." % name})


def call(name, args=None):
    """One of the app's own calls -> its answer (a dict; {"ok": False, "error"} when it couldn't answer)."""
    fn = _native["fn"]
    if fn is None:
        fn = _simulated if os.environ.get("HT_CLUSTER_PHONE_SIM") else _android if PLATFORM == "android" else _ios if PLATFORM == "ios" else _simulated
        _native["fn"] = fn
    try:
        answer = json.loads(fn(name, args or {}) or "{}")
    except Exception as e:  # (the app's side failed: said, not raised)
        return {"ok": False, "error": str(e)[:300]}
    return answer if isinstance(answer, dict) else {"ok": False, "error": "Not an answer."}


def readings():
    r = call("readings")
    return {} if r.get("ok") is False else r
