#!/bin/bash
# bluetooth-setup.sh — remote recording over Bluetooth on a Raspberry Pi running Hand Tracker, for
# when a phone can't reach it over a network (no Wi-Fi, no hotspot, no Tailscale). Run it once:
#     sudo bash bluetooth-setup.sh            # set up (again: the hotspot's password again)
#     sudo bash bluetooth-setup.sh --remove   # take it away
#
# Hand Tracker itself offers its remote recording page over Bluetooth Low Energy (iPhones, the
# website, other computers) and the Pi's Bluetooth network (Android phones, which pair with the Pi
# in their Bluetooth settings and turn on its internet access) while remote recording is on;
# pairing needs nothing confirmed here. What keeps others out is a password: the Pi's hotspot's
# (pi/hotspot-setup.sh), or one you choose here if it has none. This sets up the two things only
# root can: the Bluetooth network's bridge (htbt0, 10.43.0.1/24, handing out addresses to phones,
# by NetworkManager), and the password's key where Hand Tracker reads it (only the key: PBKDF2-
# SHA256 of the password, never the password itself), for the person logged in at the screen.
set -euo pipefail

BR=htbt0
CON="Hand Tracker Bluetooth"
HOTSPOT="Hand Tracker hotspot"

if [ "$(id -u)" != 0 ]; then
  echo "Run it with sudo: sudo bash $0" >&2
  exit 1
fi
USER_NAME="${SUDO_USER:-}"
if [ -z "$USER_NAME" ] || [ "$USER_NAME" = root ]; then
  USER_NAME=$(loginctl list-sessions --no-legend 2>/dev/null | awk '$3 != "root" {print $3; exit}')
fi
HOME_DIR=$(getent passwd "$USER_NAME" | cut -d: -f6)
SECRET="$HOME_DIR/.config/Hand Tracker/bluetooth.json"

if [ "${1:-}" = "--remove" ]; then
  nmcli connection delete "$CON" >/dev/null 2>&1 || true
  if [ -f "$SECRET" ] && grep -q '"from": *"hotspot"' "$SECRET"; then rm -f "$SECRET"; fi
  echo "Bluetooth's network is gone (Hand Tracker still offers Bluetooth Low Energy with a password set in it)."
  exit 0
fi

for tool in nmcli python3; do
  command -v "$tool" >/dev/null || { echo "This needs $tool, which isn't here." >&2; exit 1; }
done

# The password: the hotspot's, else one chosen now.
FROM=hotspot
PW=$(nmcli -s -g 802-11-wireless-security.psk connection show "$HOTSPOT" 2>/dev/null || true)
if [ -z "$PW" ]; then
  FROM=set
  read -r -s -p "This Pi has no hotspot: a Bluetooth password (8 to 63 characters): " PW
  echo
  if [ "${#PW}" -lt 8 ] || [ "${#PW}" -gt 63 ]; then
    echo "A Bluetooth password is 8 to 63 characters." >&2
    exit 1
  fi
fi
mkdir -p "$(dirname "$SECRET")"
PW="$PW" FROM="$FROM" SECRET="$SECRET" python3 - <<'PY'
import base64, hashlib, json, os
salt = os.urandom(16)
key = hashlib.pbkdf2_hmac("sha256", os.environ["PW"].encode(), salt, 100000, 32)
tmp = os.environ["SECRET"] + ".tmp"
with open(tmp, "w") as f:
    json.dump({"salt": base64.b64encode(salt).decode(), "iter": 100000, "key": base64.b64encode(key).decode(), "from": os.environ["FROM"]}, f)
os.chmod(tmp, 0o600)
os.replace(tmp, os.environ["SECRET"])
PY
chown "$USER_NAME:" "$SECRET" "$(dirname "$SECRET")"
unset PW

# The Bluetooth network: a bridge with an address and a DHCP server (NetworkManager's "shared"),
# which phones joining over Bluetooth are put on (Hand Tracker offers it to them, by BlueZ).
nmcli connection delete "$CON" >/dev/null 2>&1 || true
nmcli connection add type bridge con-name "$CON" ifname "$BR" autoconnect yes \
  bridge.stp no ipv4.method shared ipv4.addresses 10.43.0.1/24 ipv6.method disabled >/dev/null
nmcli connection up "$CON" >/dev/null 2>&1 || true

echo
echo "Bluetooth is set up for Hand Tracker on this Pi, with $([ "$FROM" = hotspot ] && echo "the hotspot's password" || echo "that password")."
echo "Its Bluetooth network: $(ip -4 -br addr show "$BR" 2>/dev/null | awk '{print $3}' || echo "not up yet") (Hand Tracker offers it while remote recording is on)."
echo "Restart Hand Tracker (or turn remote recording off and on) for it to take the password."
