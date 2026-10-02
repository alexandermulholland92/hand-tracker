#!/bin/bash
# hotspot-setup.sh — gives a Raspberry Pi running Hand Tracker a Wi-Fi hotspot of its own, on
# from boot alongside its normal Wi-Fi, so a phone can always reach it (and Remote recording)
# whatever Wi-Fi there is, or none. Run it once on the Pi:
#     sudo bash hotspot-setup.sh            # set up (again: change the password)
#     sudo bash hotspot-setup.sh --remove   # take it all away
#
# The hotspot is "HandTracker-<this Pi's name>", WPA2, with a password you choose (or a random
# one, shown once); the Pi is 10.42.0.1 on it, so Remote recording is http://10.42.0.1:47821
# (phones on the hotspot need no code: the hotspot's password is what keeps others out). It
# shares the Pi's internet, when the Pi has some.
#
# The Pi's Wi-Fi chip can run a hotspot and be on a network at the same time, but only on one
# channel: the hotspot follows the network's channel (moving, so phones on it drop off for a
# moment, when the Pi joins a network on another channel). With no network it's on 2.4 GHz
# channel 6, and every two minutes, if a saved network is in range, the Pi is given a moment to
# join it. A network on a 5 GHz radar (DFS) channel can't have a hotspot beside it: the hotspot
# is off while the Pi is on one.
set -euo pipefail

IF=htap0                      # the hotspot's interface (Hand Tracker trusts phones on it)
CON="Hand Tracker hotspot"    # its NetworkManager connection
BIN=/usr/local/sbin/hand-tracker-hotspot
UNIT=/etc/systemd/system/hand-tracker-hotspot
DISPATCH=/etc/NetworkManager/dispatcher.d/90-hand-tracker-hotspot

if [ "$(id -u)" != 0 ]; then
  echo "Run it with sudo: sudo bash $0" >&2
  exit 1
fi

if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now hand-tracker-hotspot.timer hand-tracker-hotspot.service 2>/dev/null || true
  nmcli connection delete "$CON" 2>/dev/null || true
  iw dev "$IF" del 2>/dev/null || true
  rm -f "$BIN" "$UNIT.service" "$UNIT.timer" "$DISPATCH"
  systemctl daemon-reload
  echo "The hotspot is gone."
  exit 0
fi

for tool in nmcli iw; do
  command -v "$tool" >/dev/null || { echo "This needs $tool (NetworkManager's Wi-Fi), which isn't here." >&2; exit 1; }
done

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

# The script that keeps the hotspot up, on the normal Wi-Fi's channel.
cat > "$BIN" <<'SCRIPT'
#!/bin/bash
# hand-tracker-hotspot — keeps the Hand Tracker hotspot (htap0) up alongside wlan0, on wlan0's
# channel (the Wi-Fi chip has one channel for both). From hotspot-setup.sh: run at boot, every
# two minutes, and when wlan0 joins or leaves a network.
IF=htap0
CON="Hand Tracker hotspot"
STATE=/run/hand-tracker-hotspot.off   # checks in a row that wlan0 had no network
log() { logger -t hand-tracker-hotspot "$*"; }
exec 9>/run/hand-tracker-hotspot.lock
flock 9

# The hotspot's interface, with an address of its own (wlan0's, marked as a local one).
if ! ip link show "$IF" >/dev/null 2>&1; then
  iw dev wlan0 interface add "$IF" type __ap || { log "couldn't add $IF"; exit 1; }
  mac=$(cat /sys/class/net/wlan0/address)
  first=$(( 0x${mac:0:2} ))
  local_first=$(( (first | 2) == first ? first ^ 4 : first | 2 ))
  ip link set "$IF" address "$(printf '%02x' "$local_first")${mac:2}" || true
fi

up_on() { # band channel
  nmcli connection modify "$CON" 802-11-wireless.band "$1" 802-11-wireless.channel "$2"
  if nmcli --wait 20 connection up "$CON" ifname "$IF" >/dev/null 2>&1; then log "hotspot on $1 channel $2"; else log "the hotspot didn't start on $1 channel $2"; fi
}
active() { nmcli -t -f NAME connection show --active | grep -qxF "$CON"; }

freq=$(iw dev wlan0 link 2>/dev/null | awk '/freq:/ {print int($2); exit}')
if [ -n "$freq" ]; then
  echo 0 > "$STATE"
  if [ "$freq" -ge 5260 ] && [ "$freq" -le 5720 ]; then
    active && nmcli connection down "$CON" >/dev/null 2>&1
    log "wlan0 is on a radar (DFS) channel ($freq MHz), where the hotspot can't be: it's off"
    exit 0
  fi
  if [ "$freq" -lt 3000 ]; then band=bg; chan=$(( freq == 2484 ? 14 : (freq - 2407) / 5 )); else band=a; chan=$(( (freq - 5000) / 5 )); fi
  if ! active || [ "$(nmcli -g 802-11-wireless.channel connection show "$CON")" != "$chan" ] || [ "$(nmcli -g 802-11-wireless.band connection show "$CON")" != "$band" ]; then
    up_on "$band" "$chan"
  fi
  exit 0
fi

# No network: the hotspot on 2.4 GHz channel 6. If a saved network is in range and wlan0 still
# hasn't joined it by the next check, the hotspot steps aside for a moment so it can.
off=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$off" > "$STATE"
if [ "${1:-}" = check ] && [ "$off" -ge 2 ]; then
  saved=$(nmcli -t -f NAME,TYPE connection show | awk -F: -v con="$CON" '$2 == "802-11-wireless" && $1 != con {print $1}' | while read -r n; do nmcli -g 802-11-wireless.ssid connection show "$n"; done)
  seen=$(nmcli -t -f SSID device wifi list ifname wlan0 2>/dev/null)
  if [ -n "$saved" ] && grep -qxFf <(echo "$saved") <(echo "$seen"); then
    log "a saved network is in range: the hotspot steps aside so wlan0 can join it"
    nmcli connection down "$CON" >/dev/null 2>&1 || true
    nmcli --wait 30 device connect wlan0 >/dev/null 2>&1 || true
    echo 0 > "$STATE"
    exec "$0" align
  fi
fi
active || up_on bg 6
SCRIPT
chmod 755 "$BIN"

# The hotspot's connection (made again, so a new password replaces the old one).
nmcli connection delete "$CON" >/dev/null 2>&1 || true
"$BIN" align >/dev/null 2>&1 || true   # makes the interface (the connection comes next)
nmcli connection add type wifi con-name "$CON" ifname "$IF" ssid "$SSID" autoconnect no \
  802-11-wireless.mode ap 802-11-wireless.band bg 802-11-wireless.channel 6 802-11-wireless.powersave 2 \
  wifi-sec.key-mgmt wpa-psk wifi-sec.proto rsn wifi-sec.pairwise ccmp wifi-sec.group ccmp wifi-sec.psk "$PW" \
  ipv4.method shared ipv4.addresses 10.42.0.1/24 ipv6.method disabled >/dev/null

# The saved Wi-Fi networks join on wlan0 only (not on the hotspot's interface).
nmcli -t -f NAME,TYPE connection show | awk -F: -v con="$CON" '$2 == "802-11-wireless" && $1 != con {print $1}' | while read -r n; do
  if [ -z "$(nmcli -g connection.interface-name connection show "$n")" ]; then
    nmcli connection modify "$n" connection.interface-name wlan0
  fi
done

# At boot, every two minutes, and when wlan0 joins or leaves a network.
cat > "$UNIT.service" <<UNITEOF
[Unit]
Description=Hand Tracker hotspot (alongside the normal Wi-Fi)
After=NetworkManager.service
Wants=NetworkManager.service

[Service]
Type=oneshot
ExecStart=$BIN check
UNITEOF
cat > "$UNIT.timer" <<UNITEOF
[Unit]
Description=Hand Tracker hotspot: at boot and every two minutes

[Timer]
OnBootSec=20s
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
UNITEOF
cat > "$DISPATCH" <<'DISPEOF'
#!/bin/sh
# Moves the Hand Tracker hotspot to wlan0's channel when wlan0 joins or leaves a network.
[ "$1" = wlan0 ] || exit 0
case "$2" in up|down) systemd-run --no-block --quiet /usr/local/sbin/hand-tracker-hotspot align ;; esac
DISPEOF
chmod 755 "$DISPATCH"
systemctl daemon-reload
systemctl enable --now hand-tracker-hotspot.timer >/dev/null
"$BIN" align || true

echo
echo "The hotspot is set up, and comes on at every boot: $SSID"
if [ -n "${SHOW_PW:-}" ]; then echo "Its password: $PW   (keep it somewhere: it isn't shown again)"; fi
echo "On it, Remote recording is http://10.42.0.1:47821 (no code needed)."
nmcli -t -f NAME,DEVICE connection show --active | grep -F "$CON" >/dev/null && echo "It's on now." || echo "It isn't on yet: see journalctl -t hand-tracker-hotspot"
