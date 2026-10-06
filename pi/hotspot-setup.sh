#!/bin/bash
# hotspot-setup.sh — gives a Raspberry Pi running Hand Tracker a Wi-Fi hotspot of its own, so a
# phone can reach it (and Remote recording) wherever it is: whenever the Pi isn't on a Wi-Fi
# network it knows, it's the hotspot. Run it once on the Pi:
#     sudo bash hotspot-setup.sh            # set up (again: change the password)
#     sudo bash hotspot-setup.sh --update   # this version of it, keeping its name and password
#     sudo bash hotspot-setup.sh --remove   # take it all away
#
# The hotspot is "HandTracker-<this Pi's name>", WPA2, with a password you choose (or a random
# one, shown once); the Pi is 10.42.0.1 on it, so Remote recording is http://10.42.0.1:47821
# (phones on the hotspot need no code: the hotspot's password is what keeps others out). It
# shares the Pi's wired internet, when the Pi has some.
#
# The Pi's Wi-Fi is one or the other: on a network, or the hotspot. (Its chip can't be both at
# once: on a second interface beside a network, the hotspot shows up but no phone can join it.)
# The hotspot comes on once the Pi has been without a network for about half a minute (at boot,
# or out of range), on 2.4 GHz channel 6. While no phone is on it, every three minutes the Pi
# looks for a network it knows, and joins it if one is in range (the hotspot goes off); while a
# phone is on it, it stays. A phone on the hotspot can have the Pi join a network (Remote
# recording's Wi-Fi), and then reaches it there, or over Tailscale.
set -euo pipefail

IF=wlan0                      # the Pi's Wi-Fi: the hotspot when it isn't on a network
CON="Hand Tracker hotspot"    # its NetworkManager connection
BIN=/usr/local/sbin/hand-tracker-hotspot
UNIT=/etc/systemd/system/hand-tracker-hotspot
DISPATCH=/etc/NetworkManager/dispatcher.d/90-hand-tracker-hotspot
OLD_IF=htap0                         # an earlier version's hotspot interface (beside wlan0)
OLD_KEEP=/var/lib/hand-tracker-hotspot   # and the networks it kept to 2.4 GHz for it

if [ "$(id -u)" != 0 ]; then
  echo "Run it with sudo: sudo bash $0" >&2
  exit 1
fi

# What an earlier version left: its hotspot interface, and the networks it kept to their 2.4 GHz
# side (they can use either band again).
undo_earlier() {
  iw dev "$OLD_IF" del 2>/dev/null || true
  if [ -f "$OLD_KEEP/pinned" ]; then
    while read -r uuid; do nmcli connection modify "$uuid" 802-11-wireless.band "" 2>/dev/null || true; done < "$OLD_KEEP/pinned"
  fi
  rm -rf "$OLD_KEEP"
}

if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now hand-tracker-hotspot.timer hand-tracker-hotspot.service 2>/dev/null || true
  nmcli connection delete "$CON" 2>/dev/null || true
  undo_earlier
  rm -f "$BIN" "$UNIT.service" "$UNIT.timer" "$DISPATCH"
  systemctl daemon-reload
  echo "The hotspot is gone."
  exit 0
fi

for tool in nmcli iw; do
  command -v "$tool" >/dev/null || { echo "This needs $tool (NetworkManager's Wi-Fi), which isn't here." >&2; exit 1; }
done

if [ "${1:-}" = "--update" ]; then
  nmcli connection show "$CON" >/dev/null 2>&1 || { echo "There's no hotspot here to update: sudo bash $0 sets one up." >&2; exit 1; }
  UPDATE=1
  SSID=$(nmcli -g 802-11-wireless.ssid connection show "$CON")
else
  SSID="HandTracker-$(hostname)"
  echo "Hotspot: $SSID"
  read -r -s -p "Its password (8 to 63 characters; just Enter for a random one): " PW
  echo
  if [ -z "$PW" ]; then
    PW=$(tr -dc 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789' </dev/urandom | head -c 12 || true)
    SHOW_PW=1
  fi
  if [ "${#PW}" -lt 8 ] || [ "${#PW}" -gt 63 ]; then
    echo "A Wi-Fi password is 8 to 63 characters." >&2
    exit 1
  fi
fi

# The script that turns the hotspot on and off.
cat > "$BIN" <<'SCRIPT'
#!/bin/bash
# hand-tracker-hotspot — the Hand Tracker hotspot on wlan0 whenever wlan0 isn't on a network
# (from hotspot-setup.sh). Run at boot, every 30 seconds ("check"), and when wlan0 joins or
# leaves a network.
#   hand-tracker-hotspot         the hotspot on, once wlan0 has been without a network for a while
#   hand-tracker-hotspot now     the hotspot on now, if wlan0 isn't on a network
#   hand-tracker-hotspot check   that, and with no phone on the hotspot, every three minutes, a
#                                network the Pi knows joined if one is in range
IF=wlan0
CON="Hand Tracker hotspot"
SINCE=/run/hand-tracker-hotspot.since     # when wlan0 was first seen without a network
LOOKED=/run/hand-tracker-hotspot.looked   # when the hotspot last looked for a known network
log() { logger -t hand-tracker-hotspot "$*"; }
exec 9>/run/hand-tracker-hotspot.lock
flock 9
now=$(date +%s)

active() { nmcli -t -f NAME connection show --active | grep -qxF "$CON"; }
on_network() { iw dev "$IF" link 2>/dev/null | grep -q freq:; }
hotspot_on() { # why
  touch "$LOOKED"
  if nmcli --wait 20 connection up "$CON" ifname "$IF" >/dev/null 2>&1; then log "$1: the hotspot is on"; else log "$1, but the hotspot didn't start"; fi
}
known() { nmcli -t -e no -f NAME,TYPE connection show | sed -n 's/:802-11-wireless$//p' | grep -vxF "$CON"; }

# A network this Pi knows, if one's in range, joined (the hotspot is off by now).
join_known() {
  local seen n ssid
  nmcli device wifi rescan ifname "$IF" >/dev/null 2>&1
  sleep 5
  seen=$(nmcli -t -e no -f SSID device wifi list ifname "$IF" --rescan no 2>/dev/null)
  while read -r n; do
    ssid=$(nmcli -e no -g 802-11-wireless.ssid connection show "$n" 2>/dev/null)
    if [ -n "$ssid" ] && grep -qxF -- "$ssid" <<<"$seen" && nmcli --wait 30 connection up "$n" ifname "$IF" >/dev/null 2>&1; then
      log "joined $n: the hotspot is off"
      return 0
    fi
  done < <(known)
  return 1
}

if on_network; then
  rm -f "$SINCE"
  exit 0
fi

if active; then
  [ "${1:-}" = check ] || exit 0
  # A phone on it: it stays (and the three minutes count from when the last one leaves).
  if [ "$(iw dev "$IF" station dump 2>/dev/null | grep -c '^Station')" -gt 0 ]; then
    touch "$LOOKED"
    exit 0
  fi
  [ $(( now - $(stat -c %Y "$LOOKED" 2>/dev/null || echo 0) )) -ge 180 ] || exit 0
  touch "$LOOKED"
  [ -n "$(known)" ] || exit 0
  nmcli connection down "$CON" >/dev/null 2>&1
  if join_known; then rm -f "$SINCE"; exit 0; fi
  hotspot_on "no known network in range"
  exit 0
fi

# No network and no hotspot. NetworkManager joining one: that first.
case "$(nmcli -g GENERAL.STATE device show "$IF" 2>/dev/null)" in [4-9]0\ *) exit 0 ;; esac
[ -f "$SINCE" ] || echo "$now" > "$SINCE"
if [ "${1:-}" = now ] || [ $(( now - $(cat "$SINCE") )) -ge 25 ]; then
  hotspot_on "no network"
fi
SCRIPT
chmod 755 "$BIN"

# The hotspot's connection (made again, so a new password replaces the old one), on wlan0.
# WPA2 only, with PMF off: otherwise NetworkManager offers WPA3 (SAE) alongside it, which the Pi's
# Wi-Fi chip can't do as a hotspot, and phones and laptops that pick WPA3 say the password is wrong.
SECURITY=(wifi-sec.key-mgmt wpa-psk wifi-sec.proto rsn wifi-sec.pairwise ccmp wifi-sec.group ccmp wifi-sec.pmf disable)
if [ -n "${UPDATE:-}" ]; then
  # Its settings as a new one's (its name and password stay).
  nmcli connection down "$CON" >/dev/null 2>&1 || true
  nmcli connection modify "$CON" connection.interface-name "$IF" 802-11-wireless.band bg 802-11-wireless.channel 6 "${SECURITY[@]}"
else
  nmcli connection delete "$CON" >/dev/null 2>&1 || true
  nmcli connection add type wifi con-name "$CON" ifname "$IF" ssid "$SSID" autoconnect no \
    802-11-wireless.mode ap 802-11-wireless.band bg 802-11-wireless.channel 6 802-11-wireless.powersave 2 \
    "${SECURITY[@]}" wifi-sec.psk "$PW" \
    ipv4.method shared ipv4.addresses 10.42.0.1/24 ipv6.method disabled >/dev/null
fi
undo_earlier

# The saved Wi-Fi networks join on wlan0.
nmcli -t -f NAME,TYPE connection show | awk -F: -v con="$CON" '$2 == "802-11-wireless" && $1 != con {print $1}' | while read -r n; do
  if [ -z "$(nmcli -g connection.interface-name connection show "$n")" ]; then
    nmcli connection modify "$n" connection.interface-name "$IF"
  fi
done

# At boot, every 30 seconds, and when wlan0 joins or leaves a network.
cat > "$UNIT.service" <<UNITEOF
[Unit]
Description=Hand Tracker hotspot (when the Wi-Fi isn't on a network)
After=NetworkManager.service
Wants=NetworkManager.service

[Service]
Type=oneshot
ExecStart=$BIN check
UNITEOF
cat > "$UNIT.timer" <<UNITEOF
[Unit]
Description=Hand Tracker hotspot: at boot and every 30 seconds

[Timer]
OnBootSec=20s
OnUnitActiveSec=30s
AccuracySec=5s

[Install]
WantedBy=timers.target
UNITEOF
cat > "$DISPATCH" <<'DISPEOF'
#!/bin/sh
# The Hand Tracker hotspot on when wlan0 leaves a network (once it's been without one a while).
[ "$1" = wlan0 ] || exit 0
case "$2" in up|down) systemd-run --no-block --quiet /usr/local/sbin/hand-tracker-hotspot ;; esac
DISPEOF
chmod 755 "$DISPATCH"
systemctl daemon-reload
systemctl enable hand-tracker-hotspot.timer >/dev/null
systemctl restart hand-tracker-hotspot.timer
# wlan0 a moment to be back on its network (the old hotspot stopping knocks it off); if it isn't,
# the hotspot now.
for _ in $(seq 30); do iw dev "$IF" link 2>/dev/null | grep -q freq: && break; sleep 1; done
"$BIN" now || true

echo
if [ -n "${UPDATE:-}" ]; then
  echo "The hotspot is updated (the same name and password): $SSID"
else
  echo "The hotspot is set up: $SSID"
fi
if [ -n "${SHOW_PW:-}" ]; then echo "Its password: $PW   (keep it somewhere: it isn't shown again)"; fi
echo "It comes on whenever this Pi isn't on a Wi-Fi network it knows; on it, Remote recording is http://10.42.0.1:47821 (no code needed)."
if nmcli -t -f NAME connection show --active | grep -qxF "$CON"; then
  echo "It's on now."
else
  echo "It's off now: this Pi is on $(nmcli -g GENERAL.CONNECTION device show "$IF")."
fi
