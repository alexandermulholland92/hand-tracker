#!/bin/bash
# tailscale-watchdog.sh — Tailscale started again when it stays offline although this Pi has a network
# (pi, 2026-11-14: after a restart the router moved it between 5 and 2.4 GHz four times in six minutes;
# Tailscale came back twice by itself, then stayed off until `sudo systemctl restart tailscaled`, as it
# had that morning too). Run it once:
#     sudo bash tailscale-watchdog.sh            # set up
#     sudo bash tailscale-watchdog.sh --remove   # take it away
#
# A timer looks once a minute, from 3 minutes after the Pi starts. Tailscale counts as offline when it
# isn't Running, says this Pi isn't online, or says it can't reach its coordination server, home relay
# or is logged out. When that has lasted 3 looks in a row while the Pi has a way out (a default route),
# tailscaled is restarted; after a restart it waits at least 5 minutes before another. Each restart is
# written to the journal (journalctl -t hand-tracker-tailscale-watchdog). Without a network, or when
# Tailscale was turned off on purpose (tailscale down), it does nothing.
set -euo pipefail

CHECK=/usr/local/sbin/hand-tracker-tailscale-watchdog
UNIT=/etc/systemd/system/hand-tracker-tailscale-watchdog
STATE=/run/hand-tracker-tailscale-watchdog

if [ "$(id -u)" != 0 ]; then
  echo "Run it with sudo: sudo bash $0" >&2
  exit 1
fi

if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now hand-tracker-tailscale-watchdog.timer >/dev/null 2>&1 || true
  rm -f "$UNIT.timer" "$UNIT.service" "$CHECK"
  rm -rf "$STATE"
  systemctl daemon-reload
  echo "Removed."
  exit 0
fi

cat > "$CHECK" <<'EOF'
#!/bin/bash
# hand-tracker-tailscale-watchdog: one look (pi/tailscale-watchdog.sh). Restarts tailscaled after 3
# offline looks in a row while there's a default route; at most once in 5 minutes.
STATE=/run/hand-tracker-tailscale-watchdog
mkdir -p "$STATE"
say() { logger -t hand-tracker-tailscale-watchdog "$*"; }
if ! ip route show default | grep -q .; then
  echo 0 > "$STATE/bad"; exit 0          # (no network: nothing Tailscale could do)
fi
json=$(timeout 10 tailscale status --json 2>/dev/null) || json=""
verdict=$(printf '%s' "$json" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("bad no answer from tailscaled"); sys.exit()
state = d.get("BackendState")
if state == "Stopped":
    print("off"); sys.exit()           # (tailscale down: on purpose)
health = " ".join(d.get("Health") or []).lower()
if state != "Running":
    print("bad state " + str(state))
elif not (d.get("Self") or {}).get("Online"):
    print("bad this Pi not online")
elif any(w in health for w in ("coordination server", "logged out", "home derp", "not connected")):
    print("bad " + health[:120])
else:
    print("ok")
')
case "$verdict" in
  ok|off) echo 0 > "$STATE/bad"; exit 0 ;;
esac
bad=$(( $(cat "$STATE/bad" 2>/dev/null || echo 0) + 1 ))
echo "$bad" > "$STATE/bad"
[ "$bad" -lt 3 ] && exit 0
last=$(cat "$STATE/restarted" 2>/dev/null || echo 0)
now=$(date +%s)
[ $(( now - last )) -lt 300 ] && exit 0
say "Tailscale offline for $bad minutes with a network (${verdict#bad }): restarting tailscaled"
echo "$now" > "$STATE/restarted"
echo 0 > "$STATE/bad"
systemctl restart tailscaled
EOF
chmod 755 "$CHECK"

cat > "$UNIT.service" <<EOF
[Unit]
Description=Hand Tracker: Tailscale started again when it stays offline with a network
After=tailscaled.service

[Service]
Type=oneshot
ExecStart=$CHECK
EOF

cat > "$UNIT.timer" <<EOF
[Unit]
Description=Hand Tracker: look at Tailscale once a minute

[Timer]
OnBootSec=3min
OnUnitActiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now hand-tracker-tailscale-watchdog.timer
echo "Set up: Tailscale is looked at once a minute (journalctl -t hand-tracker-tailscale-watchdog for restarts)."
