#!/bin/bash
# Pi Cluster: puts this Raspberry Pi in your cluster (cluster/README.md). On the Pi, logged in to
# Tailscale with your account, from your own account (not root):
#   curl -fsSL https://raw.githubusercontent.com/alexandermulholland92/hand-tracker/main/cluster/setup.sh | sudo bash
# From a copy of this folder instead (before a build has it):   sudo bash setup.sh --from node
# Taking it off this Pi again:                                  sudo bash setup.sh --remove
#
# What it puts in:
#  - /usr/local/sbin/ht-cluster-root: the service's few root jobs (Hand Tracker's and the system's
#    updates, its own updates, restarting the Pi); it downloads and checks what it installs itself.
#    sudo lets your account run that, and only that, without a password (/etc/sudoers.d/ht-cluster).
#  - /opt/ht-cluster: the service itself (GitHub's "Latest build" of it, or the copy given).
#  - ht-cluster: a service of your account's (systemd --user), running from boot.
set -euo pipefail
REPO=alexandermulholland92/hand-tracker
FROM=""
REMOVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM=$(cd "$2" && pwd); shift 2 ;;
    --remove) REMOVE=1; shift ;;
    *) echo "Unknown: $1 (--from FOLDER or --remove)"; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "Run it with sudo."; exit 1; }
WHO=${SUDO_USER:-}
if [ -z "$WHO" ] || [ "$WHO" = root ]; then
  echo "Run it with sudo from your own account, not as root: the service runs as that account."
  exit 1
fi
WHO_ID=$(id -u "$WHO")
user_ctl() { systemctl --user -M "$WHO@" "$@"; }

if [ "$REMOVE" = 1 ]; then
  user_ctl disable --now ht-cluster.service 2>/dev/null || true
  rm -f /etc/systemd/user/ht-cluster.service /etc/sudoers.d/ht-cluster /usr/local/sbin/ht-cluster-root
  rm -rf /opt/ht-cluster /var/cache/ht-cluster /var/lib/ht-cluster
  user_ctl daemon-reload 2>/dev/null || true
  echo "Pi Cluster's service is off and gone from this Pi (its settings stay in ~$WHO/.local/state/ht-cluster)."
  exit 0
fi

command -v python3 >/dev/null || { apt-get update -q && apt-get install -y -q python3; }
command -v tailscale >/dev/null || { echo "Tailscale isn't installed: install it and log in with your account first (https://tailscale.com/download/linux)."; exit 1; }
tailscale status >/dev/null 2>&1 || { echo "Tailscale isn't logged in: run  sudo tailscale up  first."; exit 1; }
install -d -m 755 /usr/local/sbin /opt/ht-cluster /opt/ht-cluster/versions /var/cache/ht-cluster /var/lib/ht-cluster /etc/systemd/user

if [ -n "$FROM" ]; then
  # The copy given, as it is ("local": the service's own updates replace it with the latest
  # build's once a build has it).
  V=/opt/ht-cluster/versions/local
  rm -rf "$V.part"
  mkdir -p "$V.part"
  cp -r "$FROM"/. "$V.part"/
  # (the Pi Cluster page, which the service serves itself: from the copy's top folder, when it's in one)
  for f in pi-cluster.html pi-cluster.js video-formats.js sentry-models.js models/kinds.js favicon.png apple-touch-icon.png; do
    if [ -f "$FROM/../../$f" ]; then install -D -m 644 "$FROM/../../$f" "$V.part/web/$f"; fi
  done
  find "$V.part" -name __pycache__ -prune -exec rm -rf {} +
  echo local > "$V.part/VERSION"
  chown -R root:root "$V.part"
  chmod -R u=rwX,go=rX "$V.part"
  chmod 755 "$V.part/ht-cluster-root"
  rm -rf "$V"
  mv "$V.part" "$V"
  ln -sfn "$V" /opt/ht-cluster/current
  install -m 755 -o root -g root "$V/ht-cluster-root" /usr/local/sbin/ht-cluster-root
else
  COMMIT=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/tags/latest-build" | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_commitish"])')
  curl -fsSL "https://raw.githubusercontent.com/$REPO/$COMMIT/cluster/node/ht-cluster-root" -o /usr/local/sbin/ht-cluster-root.new
  if ! head -1 /usr/local/sbin/ht-cluster-root.new | grep -q python3; then
    rm -f /usr/local/sbin/ht-cluster-root.new
    echo "The latest build has no Pi Cluster service in it yet."
    exit 1
  fi
  chown root:root /usr/local/sbin/ht-cluster-root.new
  chmod 755 /usr/local/sbin/ht-cluster-root.new
  mv /usr/local/sbin/ht-cluster-root.new /usr/local/sbin/ht-cluster-root
  GOT=$(/usr/local/sbin/ht-cluster-root update-cluster || true)
  echo "$GOT"
  echo "$GOT" | grep -q '"ok": true' || exit 1
fi

# sudo: your account may run the helper, and nothing else, without its password.
echo "$WHO ALL=(root) NOPASSWD: /usr/local/sbin/ht-cluster-root" > /etc/sudoers.d/ht-cluster.new
chmod 440 /etc/sudoers.d/ht-cluster.new
visudo -cf /etc/sudoers.d/ht-cluster.new >/dev/null
mv /etc/sudoers.d/ht-cluster.new /etc/sudoers.d/ht-cluster

# The service: your account's own, running from boot without anyone logged in.
install -m 644 /opt/ht-cluster/current/ht-cluster.service /etc/systemd/user/ht-cluster.service
loginctl enable-linger "$WHO"
for _ in $(seq 1 40); do [ -S "/run/user/$WHO_ID/bus" ] && break; sleep 0.25; done
user_ctl daemon-reload
user_ctl enable ht-cluster.service >/dev/null 2>&1
user_ctl restart ht-cluster.service
sleep 2
if user_ctl is-active --quiet ht-cluster.service; then
  echo "Done: $(hostname) is in your Pi Cluster. It shows in the Pi Cluster app within a minute."
else
  echo "The service didn't start. What it said:"
  journalctl --user -M "$WHO@" -u ht-cluster -n 20 --no-pager || true
  exit 1
fi
