#!/bin/bash
# wifi-watchdog.sh — the Wi-Fi chip's driver reloaded when the chip locks up, and the Pi restarted when
# that doesn't bring it back (pi, 2026-11-18: at 06:35 its chip's firmware stopped answering: "PSM's
# watchdog has fired!" every few seconds, its scans timing out; pi was off the network until it was
# restarted at 09:25). Run it once:
#     sudo bash wifi-watchdog.sh            # set up
#     sudo bash wifi-watchdog.sh --test     # set up, then reload the driver once, 20 s later, to see the
#                                           # Wi-Fi come back (off for about half a minute)
#     sudo bash wifi-watchdog.sh --remove   # take it away
#
# A timer looks once a minute, from 3 minutes after the Pi starts. When wlan0 has been off a network for
# 5 looks in a row and, in at least 2 of them, the chip's driver (brcmfmac) wrote that the chip is in
# trouble (PSM's watchdog, scans timing out or suppressed, a firmware trap, the bus down, or wlan0 gone),
# the driver is taken out and put back: the chip's firmware is loaded afresh, and NetworkManager joins
# the network again. If the chip is still in trouble 10 looks later, the Pi is restarted, but not while
# Hand Tracker records or saves a take, or packages are being installed (it waits for those), not when
# the Pi has another way out (a cable), and at most once an hour and three times a day (in between, the
# driver is reloaded again every half hour). Off a network with nothing wrong with the chip (out of
# range, the router off, the hotspot on), it does nothing. Everything it does goes to the journal:
#     journalctl -t hand-tracker-wifi-watchdog
#     hand-tracker-wifi-watchdog status        (what it has seen)
set -euo pipefail

CHECK=/usr/local/sbin/hand-tracker-wifi-watchdog
UNIT=/etc/systemd/system/hand-tracker-wifi-watchdog

if [ "$(id -u)" != 0 ]; then
  echo "Run it with sudo: sudo bash $0" >&2
  exit 1
fi

if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now hand-tracker-wifi-watchdog.timer >/dev/null 2>&1 || true
  rm -f "$UNIT.timer" "$UNIT.service" "$CHECK"
  rm -rf /run/hand-tracker-wifi-watchdog /var/lib/hand-tracker-wifi-watchdog
  systemctl daemon-reload
  echo "Removed."
  exit 0
fi

for tool in python3 nmcli journalctl rmmod modprobe; do
  command -v "$tool" >/dev/null || { echo "This needs $tool, which isn't here." >&2; exit 1; }
done
if ! grep -q '^brcmfmac ' /proc/modules; then
  echo "This Pi's Wi-Fi driver isn't brcmfmac (the Raspberry Pi's own chip): the watchdog only knows that one." >&2
  exit 1
fi

cat > "$CHECK" <<'PY'
#!/usr/bin/python3
# hand-tracker-wifi-watchdog (from pi/wifi-watchdog.sh): one look at the Wi-Fi, once a minute (its timer).
#   hand-tracker-wifi-watchdog              one look
#   hand-tracker-wifi-watchdog status       what it has seen and done
#   hand-tracker-wifi-watchdog reload-now   the driver reloaded now, to see the Wi-Fi come back (a test)
# wlan0 counts as on a network when NetworkManager has it on one (the hotspot only with a phone on it)
# and it receives something, or nothing says the chip is in trouble. The chip counts as in trouble when
# its driver (brcmfmac) writes one of TROUBLE's lines to the kernel's log, or wlan0 disappears.
import fcntl, json, os, re, subprocess, sys, syslog, time, urllib.request

IF = "wlan0"
HOTSPOT = "Hand Tracker hotspot"   # (hotspot-setup.sh's connection)
RUN = os.environ.get("WIFI_WATCHDOG_RUN", "/run/hand-tracker-wifi-watchdog")       # this start's looks
KEEP = os.environ.get("WIFI_WATCHDOG_KEEP", "/var/lib/hand-tracker-wifi-watchdog")  # its restarts
BAD = 5            # looks in a row off a network ...
TROUBLED = 2       # ... in at least this many of which the chip was in trouble: the driver reloaded
AFTER = 10         # looks after a reload with the chip still in trouble (2 of them): the Pi restarted
AGAIN = 30         # when it can't restart: the driver reloaded again this many looks later
GAP = 3600         # at most one restart an hour ...
A_DAY = 3          # ... and three a day
TROUBLE = re.compile(r"PSM's watchdog has fired|escan_timeout|[Ss]canning suppressed|firmware trap|"
                     r"[Ff]irmware has halted|bus is down|\(-110\)|status -110")


def run(cmd, timeout):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.stdout if p.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


class Pi:
    """This Pi."""

    def now(self):
        return time.time()

    def exists(self):
        return os.path.isdir("/sys/class/net/" + IF)

    def rx(self):
        try:
            with open("/sys/class/net/%s/statistics/rx_packets" % IF) as f:
                return int(f.read())
        except (OSError, ValueError):
            return None

    def network(self):
        """The network wlan0 is on (its NetworkManager connection), or None and why not."""
        if not self.exists():
            return None, IF + " is gone"
        lines = (run(["nmcli", "-g", "GENERAL.STATE,GENERAL.CONNECTION", "device", "show", IF], 20) or "").splitlines()
        state = lines[0] if lines else ""
        con = lines[1] if len(lines) > 1 else ""
        if not state.startswith("100"):
            return None, state or "NetworkManager didn't answer"
        if con == HOTSPOT:
            phones = (run(["iw", "dev", IF, "station", "dump"], 10) or "").count("Station ")
            if not phones:
                return None, "the hotspot is on"
            return "the hotspot (%d phone%s on it)" % (phones, "" if phones == 1 else "s"), ""
        return con or "a network", ""

    def kernel(self, cursor):
        """The driver's lines in the kernel's log since cursor (the last look), and the new cursor."""
        base = ["journalctl", "-k", "-q", "--no-pager", "-o", "cat", "--show-cursor"]
        out = run(base + (["--after-cursor", cursor] if cursor else ["--since", "-2min"]), 30) or ""
        if not cursor and "-- cursor: " not in out:
            out = "\n".join(l for l in (run(base + ["-n", "1"], 30) or "").splitlines() if l.startswith("-- cursor: "))
        lines, new = [], cursor
        for line in out.splitlines():
            if line.startswith("-- cursor: "):
                new = line[len("-- cursor: "):].strip()
            elif "brcmf" in line:
                lines.append(line.strip())
        return lines, new

    def busy(self):
        """Why a restart should wait just now ("" when it needn't)."""
        for pid in os.listdir("/proc"):
            if pid.isdigit():
                try:
                    with open("/proc/%s/comm" % pid) as f:
                        name = f.read().strip()
                except OSError:
                    continue
                if name in ("dpkg", "apt", "apt-get", "unattended-upgr"):
                    return "packages are being installed (%s)" % name
        # Hand Tracker's remote recording, asked over this Pi's own Tailscale address (as the Cluster
        # asks it; that stays on this Pi, network or not)
        words = (run(["ip", "-4", "-o", "addr", "show", "dev", "tailscale0"], 10) or "").split()
        ip = next((w.split("/")[0] for w in words if w.startswith("100.")), None)
        if ip:
            try:
                with urllib.request.urlopen("http://%s:47821/api/state" % ip, timeout=5) as r:
                    st = json.loads(r.read().decode("utf-8") or "{}")
                if st.get("recording"):
                    return "Hand Tracker is recording"
                if st.get("saving"):
                    return "Hand Tracker is saving a take"
            except (OSError, ValueError):
                pass
        return ""

    def other_way_out(self):
        """Another way out than wlan0 (a default route over a cable, say), or None."""
        for line in (run(["ip", "-4", "route", "show", "default"], 10) or "").splitlines():
            m = re.search(r"\bdev (\S+)", line)
            if m and m.group(1) != IF:
                try:
                    with open("/sys/class/net/%s/carrier" % m.group(1)) as f:
                        if f.read().strip() == "1":
                            return m.group(1)
                except OSError:
                    pass
        return None

    def reload(self):
        """The chip's driver taken out and put back (its firmware loaded afresh): (done, how it went)."""
        t0 = time.time()
        with open("/proc/modules") as f:
            mods = [l.split()[0] for l in f]
        out = [m for m in mods if m.startswith("brcmfmac_")] + [m for m in mods if m == "brcmfmac"]
        if not out:
            return False, "its driver (brcmfmac) isn't loaded"
        for cmd in (["rmmod"] + out, ["modprobe", "brcmfmac"]):
            p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            try:
                err = p.communicate(timeout=60)[1].strip()
            except subprocess.TimeoutExpired:
                # (stuck in the kernel: it can't be stopped, and only a restart helps)
                return False, "'%s' was still going after a minute" % " ".join(cmd)
            if p.returncode:
                return False, "'%s': %s" % (" ".join(cmd), err.splitlines()[-1] if err else "failed")
        for _ in range(30):
            if self.exists():
                return True, "%s back after %d s" % (IF, time.time() - t0)
            time.sleep(1)
        return False, IF + " didn't come back"

    def restart(self):
        subprocess.Popen(["systemctl", "reboot"])

    def say(self, msg):
        syslog.openlog("hand-tracker-wifi-watchdog")
        syslog.syslog(msg)
        print(msg)

    def wait(self, s):
        time.sleep(s)


class Fake(Pi):
    """A pretend Pi for the checks (WIFI_WATCHDOG_FAKE=world.json): what a look sees comes from the
    file, and what it does is added to the file's "did" and "said"."""

    def __init__(self, path):
        self.path = path
        with open(path) as f:
            self.w = json.load(f)

    def _keep(self):
        with open(self.path, "w") as f:
            json.dump(self.w, f)

    def now(self):
        return self.w.get("now", 1.8e9)

    def exists(self):
        return self.w.get("exists", True)

    def rx(self):
        return self.w.get("rx")

    def network(self):
        if not self.exists():
            return None, IF + " is gone"
        return (self.w["network"], "") if self.w.get("network") else (None, self.w.get("why", "disconnected"))

    def kernel(self, cursor):
        lines, self.w["kernel"] = self.w.get("kernel", []), []   # (each line seen once)
        self._keep()
        return lines, str(int(cursor or 0) + 1)

    def busy(self):
        return self.w.get("busy", "")

    def other_way_out(self):
        return self.w.get("other")

    def reload(self):
        self.w.setdefault("did", []).append("reload")
        self._keep()
        ok, how = self.w.get("reload", [True, "wlan0 back after 3 s"])
        return ok, how

    def restart(self):
        self.w.setdefault("did", []).append("restart")
        self._keep()

    def say(self, msg):
        self.w.setdefault("said", []).append(msg)
        self._keep()

    def wait(self, s):
        self.w["now"] = self.now() + s


def minutes(n):
    return "%d minute%s" % (n, "" if n == 1 else "s")


def load():
    try:
        with open(os.path.join(RUN, "state.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save(s):
    os.makedirs(RUN, mode=0o755, exist_ok=True)
    tmp = os.path.join(RUN, "state.json.new")
    with open(tmp, "w") as f:
        json.dump(s, f, indent=1)
    os.chmod(tmp, 0o644)
    os.replace(tmp, os.path.join(RUN, "state.json"))


def restarts(pi):
    """When it restarted the Pi in the last day."""
    try:
        with open(os.path.join(KEEP, "restarts")) as f:
            t = [float(x) for x in f.read().split()]
    except (OSError, ValueError):
        t = []
    return [min(x, pi.now()) for x in t if pi.now() - x < 86400]


def blocked(pi):
    """Why the Pi can't be restarted now ("" when it can)."""
    other = pi.other_way_out()
    if other:
        return "it has another way out (%s), so its Wi-Fi isn't worth a restart" % other
    t = restarts(pi)
    if t and pi.now() - max(t) < GAP:
        return "it was restarted for this %s ago (at most once an hour)" % minutes(int((pi.now() - max(t)) // 60))
    if len(t) >= A_DAY:
        return "it has been restarted for this %d times today already" % len(t)
    return pi.busy()


def reload(pi, s):
    ok, how = pi.reload()
    _, s["cursor"] = pi.kernel(s.get("cursor"))   # (the reload's own lines aren't trouble)
    s.update(reloaded=pi.now(), sinceReload=0, afterTrouble=0, reloads=s.get("reloads", 0) + 1)
    s.pop("waiting", None)
    if ok:
        s.pop("reloadFailed", None)
        pi.say("The Wi-Fi driver is reloaded: %s." % how)
    else:
        s["reloadFailed"] = how
        pi.say("Reloading the Wi-Fi driver didn't work: %s." % how)
        s.update(sinceReload=AFTER, afterTrouble=TROUBLED)   # (straight on to a restart)
        restart_or_wait(pi, s)


def restart_or_wait(pi, s):
    why = blocked(pi)
    if not why:
        t = restarts(pi) + [pi.now()]
        os.makedirs(KEEP, exist_ok=True)
        with open(os.path.join(KEEP, "restarts"), "w") as f:
            f.write("\n".join("%d" % x for x in t) + "\n")
        if s.get("reloadFailed"):
            pi.say("Restarting the Pi: reloading its Wi-Fi driver didn't work (%s)." % s["reloadFailed"])
        else:
            pi.say("Restarting the Pi: its Wi-Fi chip is still in trouble %s after the driver was reloaded (%s)."
                   % (minutes(s["sinceReload"]), s.get("lastTrouble") or "?"))
        s["restarting"] = pi.now()
        pi.restart()
        return
    if s.get("waiting") != why:
        s["waiting"] = why
        pi.say("The Wi-Fi chip is still in trouble, but the Pi isn't restarted now: %s. Meanwhile its driver is reloaded again every half hour.%s"
               % (why, "" if "another way out" in why or "restarted for this" in why else " The Pi is restarted once that's over."))
    if s["sinceReload"] >= AFTER + AGAIN:
        pi.say("Reloading the Wi-Fi driver again (the Pi isn't restarted: %s)." % why)
        reload(pi, s)


def look(pi, s):
    s["looks"] = s.get("looks", 0) + 1
    lines, s["cursor"] = pi.kernel(s.get("cursor"))
    trouble = [l for l in lines if TROUBLE.search(l)]
    here = pi.exists()
    if here:
        s["seen"] = True
    elif s.get("seen"):
        trouble.append(IF + " is gone")
    rx = pi.rx()
    moving = rx is not None and s.get("rx") is not None and rx != s["rx"]
    s["rx"] = rx
    name, why = pi.network()
    on = bool(name) and (moving or not trouble)
    s["last"] = {"at": pi.now(), "on": name if on else None, "trouble": len(trouble),
                 "why": "" if on else (why or "nothing received, with the chip in trouble")}
    if trouble:
        s["lastTrouble"] = trouble[-1][-160:]
        s["troubleLines"] = s.get("troubleLines", 0) + len(trouble)
    if on:
        if s.get("reloaded") is not None:
            pi.say("Back on %s, %s after the Wi-Fi driver was reloaded." % (name, minutes(s.get("sinceReload", 0) + 1)))
        for k in ("bad", "troubled", "reloaded", "sinceReload", "afterTrouble", "waiting"):
            s.pop(k, None)
        return
    s["bad"] = s.get("bad", 0) + 1
    if s.get("reloaded") is None:
        s["troubled"] = (s.get("troubled", []) + [len(trouble)])[-BAD:]
        if s["bad"] >= BAD and sum(1 for n in s["troubled"] if n) >= TROUBLED:
            pi.say("Off the network for %s (%s), the Wi-Fi chip in trouble (%d of its driver's lines, the last \"%s\"): reloading its driver."
                   % (minutes(s["bad"]), why or "nothing received", sum(s["troubled"]), s.get("lastTrouble")))
            reload(pi, s)
        return
    s["sinceReload"] = s.get("sinceReload", 0) + 1
    s["afterTrouble"] = s.get("afterTrouble", 0) + (1 if trouble else 0)
    if s["sinceReload"] < AFTER:
        return
    if s["afterTrouble"] < TROUBLED and here:
        # (the chip seems all right now: whatever keeps wlan0 off a network, it isn't the chip)
        pi.say("Still off the network %s after the Wi-Fi driver was reloaded (%s), but the chip seems all right now: not restarting."
               % (minutes(s["sinceReload"]), why))
        for k in ("bad", "troubled", "reloaded", "sinceReload", "afterTrouble", "waiting"):
            s.pop(k, None)
        return
    restart_or_wait(pi, s)


def reload_now(pi, s):
    if pi.exists():
        s["seen"] = True
    pi.say("Reloading the Wi-Fi driver now, as asked (a test).")
    ok, how = pi.reload()
    _, s["cursor"] = pi.kernel(s.get("cursor"))
    if not ok:
        pi.say("Reloading the Wi-Fi driver didn't work: %s." % how)
        return 1
    pi.say("The Wi-Fi driver is reloaded: %s." % how)
    t0 = pi.now()
    while pi.now() - t0 < 120:
        name, _ = pi.network()
        if name:
            pi.say("Back on %s %d s after the reload." % (name, pi.now() - t0))
            return 0
        pi.wait(2)
    pi.say("Not back on a network 2 minutes after the reload.")
    return 1


def status(pi, s):
    last = s.get("last") or {}
    print("Looks this start: %d%s" % (s.get("looks", 0), ", the last at " + time.strftime("%H:%M:%S", time.localtime(last["at"])) if last else ""))
    if last:
        print("Then: " + ("on " + last["on"] if last.get("on") else "off a network (%s)" % last.get("why")))
    print("Off a network: %d looks in a row" % s.get("bad", 0))
    print("Driver reloads this start: %d%s" % (s.get("reloads", 0), " (the last %s ago)" % minutes(int((pi.now() - s["reloaded"]) // 60)) if s.get("reloaded") else ""))
    print("The chip's trouble lines this start: %d%s" % (s.get("troubleLines", 0), " (the last: %s)" % s["lastTrouble"] if s.get("lastTrouble") else ""))
    t = restarts(pi)
    print("Restarts for it in the last day: %d" % len(t) + "".join(" " + time.strftime("%m-%d %H:%M", time.localtime(x)) for x in t))
    if s.get("waiting"):
        print("Waiting to restart: " + s["waiting"])


def main():
    what = sys.argv[1] if len(sys.argv) > 1 else "look"
    pi = Fake(os.environ["WIFI_WATCHDOG_FAKE"]) if os.environ.get("WIFI_WATCHDOG_FAKE") else Pi()
    if what == "status":
        status(pi, load())
        return 0
    if what not in ("look", "reload-now"):
        print(__doc__ or "hand-tracker-wifi-watchdog [status|reload-now]")
        return 2
    os.makedirs(RUN, mode=0o755, exist_ok=True)
    with open(os.path.join(RUN, "lock"), "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | (fcntl.LOCK_NB if what == "look" else 0))
        except BlockingIOError:
            return 0   # (a reload is going on: the next look)
        s = load()
        if s.get("restarting"):
            if pi.now() - s["restarting"] < 900:
                return 0   # (the Pi is being restarted)
            pi.say("The Pi wasn't restarted (asked %s ago): looking again." % minutes(int((pi.now() - s["restarting"]) // 60)))
            s.pop("restarting")
        code = reload_now(pi, s) if what == "reload-now" else look(pi, s) or 0
        save(s)
        return code


if __name__ == "__main__":
    sys.exit(main())
PY
chmod 755 "$CHECK"

cat > "$UNIT.service" <<EOF
[Unit]
Description=Hand Tracker: the Wi-Fi chip's driver reloaded when the chip locks up (the Pi restarted if that doesn't help)
After=NetworkManager.service

[Service]
Type=oneshot
ExecStart=$CHECK
TimeoutStartSec=5min
EOF

cat > "$UNIT.timer" <<EOF
[Unit]
Description=Hand Tracker: look at the Wi-Fi chip once a minute

[Timer]
OnBootSec=3min
OnUnitActiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now hand-tracker-wifi-watchdog.timer
echo "Set up: the Wi-Fi is looked at once a minute (journalctl -t hand-tracker-wifi-watchdog for what it does)."

if [ "${1:-}" = "--test" ]; then
  systemd-run --quiet --unit="hand-tracker-wifi-watchdog-test-$(date +%s)" --on-active=20s --timer-property=AccuracySec=1s "$CHECK" reload-now
  echo "In 20 seconds the Wi-Fi driver is reloaded once, as a test: this Pi drops off the Wi-Fi for about half a minute,"
  echo "then joins again. To see how it went: journalctl -t hand-tracker-wifi-watchdog"
fi
