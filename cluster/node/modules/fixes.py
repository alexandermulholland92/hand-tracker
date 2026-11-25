"""
fixes.py - Cluster module: the repository's Raspberry Pi fixes (pi/*.sh) put on this Pi from the app,
each with a switch of its own for this Pi. They're all off on a Pi until switched on there; one that's
already on the Pi (put in by hand) is taken as it is and shows on.
  Wi-Fi recovery (pi/wifi-watchdog.sh): the Wi-Fi chip's driver reloaded when the chip locks up, and the
    Pi restarted if that doesn't bring it back.
  Tailscale recovery (pi/tailscale-watchdog.sh): Tailscale started again when it stays offline although
    the Pi has a network.
  Network tuning (pi/network-tuning.sh): the Wi-Fi rejoin fix (no IPv6 in the saved Wi-Fi networks), BBR,
    and Tailscale's packets first on Wi-Fi.
  Freeze restart + kept logs (pi/freeze-restart.sh): the Pi restarted when it freezes for 30 s, 10 s
    after a kernel panic, or when something stays stuck in the kernel for 2 minutes (a drive or a driver
    that stopped answering, which the watchdog misses), and its log kept on its drive.
  USB power (pi/usb-current.sh): a Raspberry Pi 5 that didn't find a 5 A supply ("power to peripherals will
    be restricted") treated as if it had one, from its next restart: its USB ports' full 1.6 A
    (usb_max_current_enable=1 in config.txt) and no warning (PSU_MAX_CURRENT=5000 in its bootloader's
    settings). Only for a supply that can give that much. Until the Pi is restarted, a warning says so
    (Updates: Restart this Pi).
  Wi-Fi at each start (pi/wifi-autoconnect.sh): the Wi-Fi network the Pi was last on set to join by itself again
    when it starts (its auto-connect switched back on if something turned it off), and joined if the Wi-Fi isn't on
    one; only that network, and never a hotspot (the user, 2026-11-22).
On: put in, and put in again when a newer build of this service brings a changed script. Off: taken
away. Neither while Hand Tracker records or saves a take. A fix that didn't go in is tried again an
hour later, or at once with "Try the fixes again". "Test the Wi-Fi recovery" reloads the Wi-Fi driver
once, 20 s after it's pressed (the Pi is off the Wi-Fi for about half a minute), and says how it went.
ht-cluster-root does the putting in and taking away, with the scripts this service's own update brought
(checked against GitHub's list of the build's files, as the service's own files are).
"""

import hashlib
import os
import re
import threading
import time

TITLE = "Fixes"
ORDER = 35
ON = True
PLATFORMS = ("linux",)  # (Raspberry Pi OS's: not on a Windows PC in the cluster)
EVERY = 60

# (setting, script in pi/, name in the app, its switch, the files that say it's on a Pi)
FIXES = [
    ("wifiWatchdog", "wifi-watchdog", "Wi-Fi recovery",
     "Wi-Fi recovery: the Wi-Fi chip's driver reloaded when it locks up, the device restarted if that fails",
     ["/usr/local/sbin/hand-tracker-wifi-watchdog", "/etc/systemd/system/hand-tracker-wifi-watchdog.timer"]),
    ("tailscaleWatchdog", "tailscale-watchdog", "Tailscale recovery",
     "Tailscale recovery: Tailscale restarted when it stays offline with a network",
     ["/usr/local/sbin/hand-tracker-tailscale-watchdog", "/etc/systemd/system/hand-tracker-tailscale-watchdog.timer"]),
    ("networkTuning", "network-tuning", "Network tuning",
     "Network tuning: the Wi-Fi rejoin fix (no IPv6 on Wi-Fi), BBR, Tailscale's packets first",
     ["/etc/sysctl.d/90-hand-tracker-network.conf", "/etc/NetworkManager/dispatcher.d/91-hand-tracker-wlan0-ipv6"]),
    ("freezeRestart", "freeze-restart", "Freeze restart",
     "Freeze restart + kept logs: restarted after 30 s frozen, 2 min stuck or a kernel panic, the log kept on the drive",
     ["/etc/systemd/system.conf.d/50-watchdog.conf", "/etc/sysctl.d/90-panic-reboot.conf",
      "/etc/systemd/journald.conf.d/50-persistent.conf"]),
    ("usbCurrent", "usb-current", "USB power",
     "USB power: a Pi 5 without a 5 A supply treated as having one: USB ports' 1.6 A, no warning (only if its supply can give it; after a restart)",
     ["/etc/hand-tracker/usb-current"]),
    ("wifiAutoconnect", "wifi-autoconnect", "Wi-Fi at each start",
     "Wi-Fi at each start: the network it was last on joins by itself again (auto-connect switched back on if it was off)",
     ["/usr/local/sbin/hand-tracker-wifi-autoconnect", "/etc/systemd/system/hand-tracker-wifi-autoconnect.service"]),
]
SETTINGS = [{"key": key, "title": switch, "default": False} for key, _, _, switch, _ in FIXES]
WIFI = FIXES[0][4]
BY_HAND = "by hand"  # (put in before this module, with no script of this service's to compare with yet)
RETRY_AFTER = 3600
NOT_HERE = "Not in this device's version of the service yet"
TEST_SAYS = ("Back on", "Not back", "Reloading the Wi-Fi driver didn't")
RESTART = {"usb-current"}  # (fixes taking effect at the Pi's next restart: a warning until then, when they say so)

_lock = threading.Lock()  # (one tick at a time)
_state = {}  # script -> what's happening with it now
_asked = {}  # "retry": True (its button), "test": when the Wi-Fi driver reloads (the test's button)
_doing = {"what": None}


def at(node, path):
    """A system path (with the checks: inside the folder standing in for /)."""
    root = os.environ.get("HT_CLUSTER_SIM_ROOT") if node.simulate else None
    return os.path.join(root, path.lstrip("/")) if root else path


def is_in(node, marks):
    return all(os.path.exists(at(node, p)) for p in marks)


def scripts(node):
    """Where this version of the service keeps the fixes (its update brings them into fixes/; a copy of the
    code run as it is uses the repository's pi/)."""
    if node.simulate and os.environ.get("HT_CLUSTER_SIM_FIXES"):
        return os.environ["HT_CLUSTER_SIM_FIXES"]
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    own = os.path.join(here, "fixes")
    if os.path.isdir(own) or node.version != "dev":
        return own
    return os.path.join(here, "..", "..", "pi")


def device_words(text):
    """A fix script's own words (pi/*.sh) as the app shows them: "this Pi" said "this device", as the rest of the app
    says it (the user, 2026-11-25); the scripts themselves aren't changed for it, as a changed script is put in again
    on every device that has it."""
    return re.sub(r"\b([Tt]his|[Tt]he|[Aa]) Pi\b", r"\1 device", str(text))


def script_sha(node, name):
    try:
        with open(os.path.join(scripts(node), name + ".sh"), "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return None


def boot_id(node):
    return (node.read(at(node, "/proc/sys/kernel/random/boot_id"), "") or "").strip()


def usb_power(node):
    """The USB ports now: whether they're allowed their 1.6 A (the firmware's own word), and the supply the Pi
    takes it has (mA; 5000 once its bootloader is told so): {"now", "supply"}, None where unknown."""
    out = {"now": None, "supply": None}
    if node.simulate:
        now = node.read(at(node, "/run/ht-sim-usb-current"))  # (the checks: the firmware's word, standing in)
        out["now"] = (now or "0").strip() == "1"
    else:
        code, said, _ = node.run(["vcgencmd", "get_config", "usb_max_current_enable"], 5)
        m = re.search(r"usb_max_current_enable=(\d+)", said or "")
        out["now"] = m.group(1) == "1" if code == 0 and m else None
    try:
        with open(at(node, "/proc/device-tree/chosen/power/max_current"), "rb") as f:
            out["supply"] = int.from_bytes(f.read()[:4], "big") or None
    except (OSError, ValueError):
        pass
    return out


def recording(node):
    m = node.modules.get("rig")
    return bool(m and node.is_on("rig") and m.mod.busy(node))


def failed_lately(mem, name, target):
    f = (mem.get("failed") or {}).get(name)
    return f if f and f.get("for") == target and time.time() - f.get("at", 0) < RETRY_AFTER else None


def note_failure(mem, name, target, error, missing=False):
    mem.setdefault("failed", {})[name] = {"for": target, "at": time.time(), "error": error, "missing": missing}
    mem.save()


def clear_failure(mem, name):
    if (mem.get("failed") or {}).pop(name, None):
        mem.save()


def released(node):
    """This service is a build's (its version a commit): the root helper can fetch that build's fixes when
    its update didn't bring them (the first update to a version with fixes is the old root helper's)."""
    v = node.version or ""
    return len(v) == 40 and all(c in "0123456789abcdef" for c in v)


def one(node, mem, key, name, short, marks, retry):
    rec = mem.setdefault("installed", {})  # script -> the SHA-256 of the script put in (or BY_HAND)
    here = is_in(node, marks)
    cur = script_sha(node, name)
    on = bool(node.setting("fixes", key))
    if here and name not in rec:
        # On the Pi already (put in by hand): taken as it is, not run again until a newer script comes.
        rec[name] = cur or BY_HAND
        mem.save()
        if not on:
            node.change({"module": "fixes", "key": key, "value": True})
            on = True
        node.event("fixes", "%s was on this device already: its switch is on." % short)
    elif here and rec.get(name) == BY_HAND and cur:
        rec[name] = cur
        mem.save()
    if on and here and (cur is None or rec.get(name) == cur):
        _state[name] = "On"
        clear_failure(mem, name)
        return
    if not on and not here:
        if rec.pop(name, None) is not None:
            mem.save()
        clear_failure(mem, name)
        _state[name] = "Off"
        return
    # To put in (or in again: its script changed), or to take away (switched off).
    job, doing, done, didnt = (("fix-install", "Updating…" if here else "Putting it in…", "updated" if here else "put in", "Didn't go in")
                               if on else ("fix-remove", "Taking it off…", "taken off", "Didn't come off"))
    missing = NOT_HERE if on else "Still on: this device's version of the service can't take it off"
    if cur is None and not released(node):
        _state[name] = missing
        return
    target = (cur or "fetch " + node.version) if on else "remove"
    f = failed_lately(mem, name, target)
    if f and not retry:
        _state[name] = missing if f.get("missing") else "%s: %s (tries again later)" % (didnt, f["error"])
        return
    if recording(node):
        _state[name] = "Waiting: recording"
        return
    _state[name] = doing
    answer = node.root(job, name, timeout=900)
    if not answer.get("ok"):
        error = device_words(answer.get("error") or ("it didn't go in" if on else "it didn't come off"))
        note_failure(mem, name, target, error, missing=bool(answer.get("missing")))
        if answer.get("missing"):
            _state[name] = missing
            return
        node.event("fixes", "%s %s: %s" % (short, didnt[0].lower() + didnt[1:], error), bad=True)
        _state[name] = "%s: %s" % (didnt, error)
        return
    if on:
        rec[name] = answer.get("sha256") or cur
    else:
        rec.pop(name, None)
    clear_failure(mem, name)
    if name in RESTART and re.search(r"Restart this (Pi|device)\b", str(answer.get("said") or "")):
        mem.setdefault("restart", {})[name] = boot_id(node)  # (until this start is over)
    mem.save()
    node.event("fixes", "%s %s.%s" % (short, done, " " + device_words(answer["said"]) if answer.get("said") else ""))
    _state[name] = "On" if on else "Off"


def test_result(node, mem):
    """How the Wi-Fi recovery's test went: the watchdog's own words in the journal."""
    if _asked.get("test"):
        mem["test"] = {"at": _asked.pop("test"), "result": None}
        mem.save()
    t = mem.get("test")
    if not t or t.get("result") or time.time() < t.get("at", 0) + 5:
        return
    if node.simulate and os.environ.get("HT_CLUSTER_SIM_JOURNAL"):
        code, out = 0, node.read(os.environ["HT_CLUSTER_SIM_JOURNAL"], "")
    else:
        code, out, _ = node.run(["journalctl", "-q", "--no-pager", "-o", "cat", "-t", "hand-tracker-wifi-watchdog",
                                 "--since", "@%d" % int(t["at"] - 5)], 15)
    said = [l.strip() for l in (out or "").splitlines() if l.strip().startswith(TEST_SAYS)] if code == 0 else []
    if said:
        t["result"] = said[-1]
    elif time.time() > t["at"] + 300:
        t["result"] = "No word from it (journalctl -t hand-tracker-wifi-watchdog)"
    else:
        return
    mem.save()
    node.event("fixes", "Wi-Fi recovery test: %s" % t["result"], bad=not t["result"].startswith("Back on"))


def tick(node):
    mem = node.memory("fixes")
    with _lock:
        retry = bool(_asked.pop("retry", False))
        for key, name, short, _, marks in FIXES:
            _doing["what"] = name
            try:
                one(node, mem, key, name, short, marks, retry)
            finally:
                _doing["what"] = None
        test_result(node, mem)
        waits = mem.get("restart") or {}
        if any(b != boot_id(node) for b in waits.values()):  # (restarted since: in effect now)
            mem["restart"] = {k: b for k, b in waits.items() if b == boot_id(node)}
            mem.save()


def status(node):
    mem = node.memory("fixes")
    fixes, parts, warn = [], [], []
    for key, name, short, _, marks in FIXES:
        on = bool(node.setting("fixes", key))
        state = _state.get(name) or ("Off" if not on else "Not looked yet")
        fixes.append({"key": key, "script": name, "title": short, "on": on, "here": is_in(node, marks), "state": state})
        parts.append("%s: %s" % (short, state[:1].lower() + state[1:]))
        if state.startswith(("Didn't", "Still on")):
            warn.append("%s: %s" % (short, state))
    now_boot = boot_id(node)
    for key, name, short, _, _ in FIXES:
        if (mem.get("restart") or {}).get(name) == now_boot:
            warn.append("%s: restart this device for it to take effect (Updates: Restart this device)" % short)
    usb = usb_power(node) if node.setting("fixes", "usbCurrent") or is_in(node, FIXES[4][4]) else None
    t = mem.get("test")
    if _asked.get("test"):
        t = {"at": _asked["test"], "result": None}
    out = {"fixes": fixes, "doing": _doing["what"], "test": t, "usb": usb}
    summary = " · ".join(parts)
    if usb and usb.get("supply"):
        summary += " · the device takes its supply as %s A%s" % (("%.1f" % (usb["supply"] / 1000)).rstrip("0").rstrip("."),
                                                           ", USB up to 1.6 A" if usb["now"] or usb["supply"] >= 5000 else ", USB limited to 0.6 A")
    if t:
        summary += " · Wi-Fi test %s: %s" % (time.strftime("%H:%M", time.localtime(t["at"])), t.get("result") or "going on")
    out["summary"] = summary
    out["warnings"] = warn
    # (its buttons, where they make sense: the test where the Wi-Fi recovery is on, trying again after a failure)
    ACTIONS["testWifi"]["hidden"] = not is_in(node, WIFI)
    ACTIONS["retry"]["hidden"] = not mem.get("failed")
    return out


def act_test(node, args):
    if not is_in(node, WIFI):
        return {"ok": False, "error": "The Wi-Fi recovery isn't on this device: switch it on first."}
    if recording(node):
        return {"ok": False, "error": "It's recording. Test it once the recording has stopped."}
    answer = node.root("wifi-test", timeout=60)
    if not answer.get("ok"):
        return {"ok": False, "error": device_words(answer.get("error") or "The test didn't start.")}
    when = time.time() + int(answer.get("in", 20))
    _asked["test"] = when
    node.event("fixes", "Testing the Wi-Fi recovery: the Wi-Fi driver reloads at %s." % time.strftime("%H:%M:%S", time.localtime(when)))
    return {"ok": True, "message": "In 20 seconds this device's Wi-Fi driver reloads, as a test. It's off the Wi-Fi for about half a minute, then back."}


def act_retry(node, args):
    _asked["retry"] = True
    return {"ok": True, "message": "Trying the fixes again."}


ACTIONS = {
    "testWifi": {"title": "Test the Wi-Fi recovery", "run": act_test, "hidden": True,
                 "confirm": "Reload this device's Wi-Fi driver in 20 seconds, as a test? It's off the Wi-Fi for about half a minute."},
    "retry": {"title": "Try the fixes again", "run": act_retry, "hidden": True},
}
