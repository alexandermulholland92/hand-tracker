#!/bin/bash
# download-cap.sh — Transmission's own download limits, kept by Linux itself (nftables) on this Pi's
# Wi-Fi: Transmission 4.1.0 beta 2 (Debian 13's) goes several times over its download limit, which
# fills a slow Wi-Fi link until the Pi can't be reached (pi, 2026-11-10: "offline" for 25 minutes
# after torrents were added). Run it once:
#     sudo bash download-cap.sh            # set up
#     sudo bash download-cap.sh --remove   # take it away
#
# A small service (hand-tracker-download-cap) asks each Transmission every 5 seconds what its
# download limit is now (the turtle's when the turtle is on) and caps what comes in for it at that:
# no limit in Transmission, no cap here (the user's choice). Each Transmission has its own cap:
#  - the background service (its own user, debian-transmission), asked with the login the Jellyfin
#    turtle saved (~/.config/jellyfin-turtle/transmission-daemon), or, without it, as its settings
#    file says;
#  - the desktop app, started through /usr/local/bin/transmission-gtk from now on so that it runs
#    with the group ht-capped (how Linux tells its connections from everything else's; files it
#    saves get that group, readable by all as before). The app has to be started again for that.
# What's over a cap is dropped as it comes in, so the senders slow down to it.
set -euo pipefail

GROUP=ht-capped
WRAPPER=/usr/local/bin/transmission-gtk
REAL=/usr/bin/transmission-gtk
FOLLOW=/usr/local/sbin/hand-tracker-download-cap
UNIT=/etc/systemd/system/hand-tracker-download-cap.service
TABLE="inet hand_tracker_cap"

if [ "$(id -u)" != 0 ]; then
  echo "Run it with sudo: sudo bash $0" >&2
  exit 1
fi

if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now hand-tracker-download-cap.service >/dev/null 2>&1 || true
  nft delete table $TABLE >/dev/null 2>&1 || true
  grep -qs "download-cap.sh" "$WRAPPER" && rm -f "$WRAPPER"
  rm -f "$FOLLOW" "$UNIT"
  systemctl daemon-reload
  echo "The download cap is gone (the group $GROUP is left: files may have it). Start Transmission's app again to run it as before."
  exit 0
fi

command -v nft >/dev/null || { echo "This needs nft (sudo apt install nftables)." >&2; exit 1; }
command -v python3 >/dev/null || { echo "This needs python3." >&2; exit 1; }

getent group "$GROUP" >/dev/null || groupadd --system "$GROUP"
GID=$(getent group "$GROUP" | cut -d: -f3)
WHO=${SUDO_USER:-}
[ "$WHO" = root ] && WHO=""
[ -n "$WHO" ] && usermod -aG "$GROUP" "$WHO"

# The desktop app, with that group (sg: no password for the group's members). Its arguments
# (torrent files, magnet links) quoted for sg's shell.
if [ -x "$REAL" ]; then
  cat > "$WRAPPER" <<'EOF'
#!/bin/bash
# (pi/download-cap.sh) Transmission's app run with the group ht-capped, so Linux can cap its downloads.
real=/usr/bin/transmission-gtk
if getent group ht-capped | cut -d: -f4 | tr ',' '\n' | grep -qx "$(id -un)"; then
  q="'"; r="'\''"
  cmd="exec $real"
  for a in "$@"; do cmd+=" '${a//$q/$r}'"; done
  exec sg ht-capped -c "$cmd"
fi
exec "$real" "$@"
EOF
  chmod 755 "$WRAPPER"
fi

cat > "$FOLLOW" <<'EOF'
#!/usr/bin/env python3
# (pi/download-cap.sh) Each Transmission's download limit as it is now, kept as a cap on what comes in
# for it over wlan0 (nftables): asked every 5 seconds, the rules written again when a limit changes.
import base64, json, os, pwd, subprocess, sys, time, urllib.error, urllib.request

TABLE = "inet hand_tracker_cap"
USER, GID = os.environ.get("CAP_USER", ""), os.environ.get("CAP_GID", "")
HOME = pwd.getpwnam(USER).pw_dir if USER else ""
FIELDS = ["alt-speed-enabled", "alt-speed-down", "speed-limit-down", "speed-limit-down-enabled"]


def saved(path):
    try:
        with open(path, encoding="utf8") as f:
            return json.load(f)
    except Exception:
        return {}


def login():  # (the background service's, as the Jellyfin turtle saved it: "name:password")
    try:
        with open(os.path.join(HOME, ".config", "jellyfin-turtle", "transmission-daemon"), encoding="utf8") as f:
            return f.read().strip()
    except Exception:
        return ""


def ask(port, auth):
    """Transmission's limits now (session-get), or None when it doesn't answer (or wants another login)."""
    h = {"X-Transmission-Session-Id": ""}
    if auth:
        h["Authorization"] = "Basic " + base64.b64encode(auth.encode()).decode()
    body = json.dumps({"method": "session-get", "arguments": {"fields": FIELDS}}).encode()
    for _ in range(2):
        try:
            with urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:%d/transmission/rpc" % port, body, h), timeout=4) as r:
                return json.load(r).get("arguments")
        except urllib.error.HTTPError as e:
            if e.code != 409:
                return None
            h["X-Transmission-Session-Id"] = e.headers.get("X-Transmission-Session-Id", "")
        except Exception:
            return None
    return None


def limit(a):
    """kB a second (Transmission's, 1000 bytes), or None: no limit."""
    try:
        if a.get("alt-speed-enabled"):
            return max(1, int(a["alt-speed-down"]))
        if a.get("speed-limit-down-enabled"):
            return max(1, int(a["speed-limit-down"]))
    except Exception:
        pass
    return None


def rules(caps):
    owners, drops = [], []
    for (how, mark), cap in caps.items():
        owners.append("    %s ct mark set ct mark or %s" % (how, mark))
        if cap is not None:
            rate = cap * 1000
            drops.append('    iifname "wlan0" ct mark and %s == %s limit rate over %d bytes/second burst %d bytes drop' % (mark, mark, rate, max(rate // 2, 30000)))
    return ("table %s\ndelete table %s\ntable %s {\n  chain out {\n    type filter hook output priority mangle; policy accept;\n%s\n  }\n"
            "  chain in {\n    type filter hook prerouting priority mangle; policy accept;\n%s\n  }\n}\n") % (TABLE, TABLE, TABLE, "\n".join(owners), "\n".join(drops))


def main():
    # What to ask, and whose connections they are: the desktop app (the group) and the background service (its user).
    who = []
    if HOME:
        who.append(("the app", os.path.join(HOME, ".config", "transmission", "settings.json"), lambda: "", ("meta skgid %s" % GID, "0x04000000")))
    try:
        uid = pwd.getpwnam("debian-transmission").pw_uid
        who.append(("the background service", "/etc/transmission-daemon/settings.json", login, ("meta skuid %d" % uid, "0x08000000")))
    except KeyError:
        pass
    last = None
    while True:
        caps, told = {}, []
        for name, file, auth, key in who:
            s = saved(file)
            a = ask(int(s.get("rpc-port", 9091)), auth()) if s.get("rpc-enabled", True) else None
            caps[key] = limit(a if a is not None else s)  # (not answering: as its settings file says)
            told.append("%s %s%s" % (name, "no cap" if caps[key] is None else "%d kB/s" % caps[key], "" if a is not None else " (from its settings file)"))
        if caps != last:
            r = subprocess.run(["nft", "-f", "-"], input=rules(caps), text=True, capture_output=True)
            if r.returncode:
                print("nft:", r.stderr.strip(), flush=True)
            else:
                print("download caps: " + ", ".join(told), flush=True)
                last = caps
        time.sleep(5)


if __name__ == "__main__":
    sys.exit(main())
EOF
chmod 755 "$FOLLOW"

cat > "$UNIT" <<EOF
[Unit]
Description=Hand Tracker download cap (Transmission's own limits, kept by Linux on Wi-Fi)
After=network.target nftables.service

[Service]
Environment=CAP_USER=$WHO CAP_GID=$GID
ExecStart=$FOLLOW
ExecStopPost=-$(command -v nft) delete table $TABLE
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable hand-tracker-download-cap.service >/dev/null 2>&1
systemctl restart hand-tracker-download-cap.service
sleep 3
journalctl -u hand-tracker-download-cap.service -n 2 -o cat --no-pager || true
echo "Transmission's download limits are kept by Linux on Wi-Fi from now on."
[ -x "$REAL" ] && echo "Start Transmission's app again for its cap to cover it."
exit 0
