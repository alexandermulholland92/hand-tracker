#!/bin/bash
# wifi-autoconnect.sh — at each start, the Wi-Fi network this Pi was last on is set to join by itself again
# (the user, 2026-11-22, from a capture rig's own fix: rigs whose hotspot switch had turned auto-connect off on
# their saved networks came back after a power cut on the hotspot and never rejoined; pi's home network was once
# found with auto-connect off too). Only that one network, the one it last connected to ("the one it was last on",
# the user's choice), so a network switched off on purpose stays off; a hotspot (an access point) is never
# touched. If this Pi's Wi-Fi isn't connected when it does that, it joins that network. Run it once:
#     sudo bash wifi-autoconnect.sh            # set up
#     sudo bash wifi-autoconnect.sh --remove   # take it away
#
# Each change is written to the journal (journalctl -t hand-tracker-wifi-autoconnect).
set -euo pipefail

CHECK=/usr/local/sbin/hand-tracker-wifi-autoconnect
UNIT=/etc/systemd/system/hand-tracker-wifi-autoconnect.service

if [ "$(id -u)" != 0 ]; then
  echo "Run it with sudo: sudo bash $0" >&2
  exit 1
fi

if [ "${1:-}" = "--remove" ]; then
  systemctl disable hand-tracker-wifi-autoconnect.service >/dev/null 2>&1 || true
  rm -f "$UNIT" "$CHECK"
  systemctl daemon-reload
  echo "Removed."
  exit 0
fi

cat > "$CHECK" <<'EOF'
#!/bin/bash
# hand-tracker-wifi-autoconnect (pi/wifi-autoconnect.sh): the Wi-Fi network last used set to join by itself again.
say() { logger -t hand-tracker-wifi-autoconnect "$*"; }
[ "${1:-}" = "now" ] || sleep 15   # (at a start: NetworkManager's own first look before it)
best="" best_t=0
while IFS=: read -r uuid type ts; do   # (nmcli -t: a UUID, a type and a number hold no ":")
  [ "$type" = "802-11-wireless" ] || continue
  mode=$(nmcli -g 802-11-wireless.mode connection show "$uuid" 2>/dev/null || true)
  [ "$mode" = "ap" ] && continue       # (a hotspot: left as it is)
  if [ "${ts:-0}" -gt "$best_t" ]; then best=$uuid; best_t=$ts; fi
done < <(nmcli -t -f UUID,TYPE,TIMESTAMP connection show 2>/dev/null)
[ -n "$best" ] || exit 0
name=$(nmcli -g connection.id connection show "$best")
if [ "$(nmcli -g connection.autoconnect connection show "$best")" != "yes" ]; then
  nmcli connection modify "$best" connection.autoconnect yes
  say "Auto-connect was off for $name, the network this Pi was last on: switched back on"
fi
# (its Wi-Fi not on a network now: that one joined, rather than waiting for NetworkManager's next look)
if nmcli -t -f TYPE,STATE device 2>/dev/null | grep -q '^wifi:disconnected$'; then
  if timeout 60 nmcli connection up "$best" >/dev/null 2>&1; then
    say "Joined $name"
  else
    say "Couldn't join $name just now (NetworkManager keeps trying by itself)"
  fi
fi
EOF
chmod 755 "$CHECK"

cat > "$UNIT" <<EOF
[Unit]
Description=Hand Tracker: the Wi-Fi network last used set to join by itself again, at each start
After=NetworkManager.service
Wants=NetworkManager.service

[Service]
Type=simple
ExecStart=$CHECK

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable hand-tracker-wifi-autoconnect.service
"$CHECK" now || true
echo "Set up: at each start, the Wi-Fi network last used joins by itself again (journalctl -t hand-tracker-wifi-autoconnect)."
