#!/bin/bash
# network-tuning.sh — keeps a Raspberry Pi (or another Linux computer) running Hand Tracker
# reachable over Tailscale while it's busy on the network (copying recordings, Jellyfin, a
# download), and fixes a one-way Tailscale tunnel on Wi-Fi. Run it once:
#     sudo bash network-tuning.sh            # set up
#     sudo bash network-tuning.sh --remove   # take it away
#
# Three things, all kept after a restart:
#  - BBR for TCP (with fq): a big transfer stops filling the Wi-Fi's queues, so everything else
#    waiting behind it (Tailscale's packets, remote recording's page) isn't held up for seconds.
#  - Tailscale's packets first on Wi-Fi: they're marked as urgent (DSCP EF), which the Wi-Fi
#    sends in its faster queue, ahead of bulk traffic.
#  - No IPv6 on wlan0: with it, a Pi on some networks gets a Tailscale tunnel that only works
#    one way ("tailscale ping" answers, but SSH and web pages time out). Tailscale then uses
#    IPv4, which works. The Pi's hotspot and Ethernet keep their IPv6.
set -euo pipefail

SYSCTL=/etc/sysctl.d/90-hand-tracker-network.conf
MODULE=/etc/modules-load.d/hand-tracker-network.conf
RULES=/etc/hand-tracker/network.nft
UNIT=/etc/systemd/system/hand-tracker-network.service
DISPATCH=/etc/NetworkManager/dispatcher.d/91-hand-tracker-wlan0-ipv6
TABLE="inet hand_tracker_net"

if [ "$(id -u)" != 0 ]; then
  echo "Run it with sudo: sudo bash $0" >&2
  exit 1
fi

if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now hand-tracker-network.service >/dev/null 2>&1 || true
  nft delete table $TABLE >/dev/null 2>&1 || true
  rm -f "$SYSCTL" "$MODULE" "$RULES" "$UNIT" "$DISPATCH"
  rmdir /etc/hand-tracker 2>/dev/null || true
  systemctl daemon-reload
  echo cubic > /proc/sys/net/ipv4/tcp_congestion_control
  echo fq_codel > /proc/sys/net/core/default_qdisc
  [ -e /proc/sys/net/ipv6/conf/wlan0/disable_ipv6 ] && echo 0 > /proc/sys/net/ipv6/conf/wlan0/disable_ipv6
  echo "Network tuning is gone (TCP back to cubic, no marking, IPv6 on wlan0 again)."
  exit 0
fi

command -v nft >/dev/null || { echo "This needs nft (sudo apt install nftables)." >&2; exit 1; }
if ! modprobe tcp_bbr 2>/dev/null && ! grep -qw bbr /proc/sys/net/ipv4/tcp_available_congestion_control; then
  echo "This computer's kernel has no BBR." >&2
  exit 1
fi

# Tailscale's own UDP port (41641 unless set otherwise for tailscaled).
PORT=$( (. /etc/default/tailscaled 2>/dev/null; echo "${PORT:-41641}") )
case "$PORT" in ''|*[!0-9]*) PORT=41641 ;; esac

# BBR and fq, now and at every start.
echo tcp_bbr > "$MODULE"
cat > "$SYSCTL" <<EOF
# Hand Tracker (pi/network-tuning.sh)
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.ipv6.conf.wlan0.disable_ipv6 = 1
EOF
echo fq > /proc/sys/net/core/default_qdisc
echo bbr > /proc/sys/net/ipv4/tcp_congestion_control
# (the Wi-Fi's own queue takes fq now; the others when they next come up)
[ -e /sys/class/net/wlan0 ] && tc qdisc replace dev wlan0 root fq 2>/dev/null || true

# Tailscale's packets marked urgent, by a table of Hand Tracker's own (Tailscale's own rules
# are left alone).
mkdir -p /etc/hand-tracker
cat > "$RULES" <<EOF
#!/usr/sbin/nft -f
# Hand Tracker (pi/network-tuning.sh): Tailscale's packets first on Wi-Fi.
table $TABLE
delete table $TABLE
table $TABLE {
  chain out {
    type filter hook output priority mangle; policy accept;
    udp sport $PORT ip dscp set ef
    udp sport $PORT ip6 dscp set ef
  }
}
EOF
cat > "$UNIT" <<EOF
[Unit]
Description=Hand Tracker: Tailscale's packets first on Wi-Fi
After=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f $RULES
ExecStop=/usr/sbin/nft delete table $TABLE

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable hand-tracker-network.service >/dev/null 2>&1
systemctl restart hand-tracker-network.service

# No IPv6 on wlan0: the sysctl above when wlan0 appears, and again each time NetworkManager
# brings it up (it turns IPv6 back on when it joins a network).
cat > "$DISPATCH" <<'EOF'
#!/bin/sh
# Hand Tracker (pi/network-tuning.sh): no IPv6 on wlan0.
[ "$1" = wlan0 ] || exit 0
case "$2" in up|pre-up|dhcp4-change|connectivity-change) echo 1 > /proc/sys/net/ipv6/conf/wlan0/disable_ipv6 ;; esac
EOF
chmod 755 "$DISPATCH"
[ -e /proc/sys/net/ipv6/conf/wlan0/disable_ipv6 ] && echo 1 > /proc/sys/net/ipv6/conf/wlan0/disable_ipv6

echo
echo "Network tuning is on: TCP $(cat /proc/sys/net/ipv4/tcp_congestion_control), Tailscale's port $PORT marked urgent, IPv6 on wlan0 $( [ "$(cat /proc/sys/net/ipv6/conf/wlan0/disable_ipv6 2>/dev/null)" = 1 ] && echo off || echo "not found (no wlan0)")."
echo "Tailscale may take a few seconds to find its way again over IPv4."
