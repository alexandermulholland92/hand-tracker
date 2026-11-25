#!/bin/sh
# transmission.sh - Cluster's Transmission in a Windows PC's own Linux ("Cluster-Linux" under WSL, Debian 13
# with the Pis' transmission-daemon), run as root by the service (modules/apps.py) through wsl.exe.
#
#   transmission.sh net       this Linux's gateway (Windows' side of WSL's network) and its own address
#   transmission.sh start <relay address> <relay port> <home folder> <settings folder> <folder>...
#   transmission.sh stop      asks it to stop (it saves its torrents' progress first), and waits
#   transmission.sh status    "running" or "stopped"
#   transmission.sh own-start <settings folder>   this PC's own Transmission, for the cluster's downloads (downloads.py):
#                             its settings and downloads on Windows' drive (/mnt/c/...), run as the ordinary user (1000)
#                             at nice 10, in the foreground until it's asked to stop
#   transmission.sh own-stop  asks it to stop, and waits
#   transmission.sh install-libtorrent   python3 and Debian's python3-libtorrent (for a download split by pieces)
#   transmission.sh has-libtorrent       exits 0 if libtorrent's here
#
# start: the home's folders (<home folder>/<folder>, and <home folder>/<settings folder>) are mounted at the same
# paths as on the home, over NFS through the service's relay on Windows' side (<relay address>:<relay port>):
# WSL's own connections reach the home from ports above 1023, which its share turns away, while the relay's
# come from below 1024. Transmission then runs as the account that owns them there (the home's share gives every
# file to its own user), at nice 5, until it's asked to stop; then the folders are let go. It stays in the
# foreground all along: wsl.exe running it keeps this Linux up.
set -u
PIDFILE=/run/ht-cluster-transmission.pid
DAEMON=/run/ht-cluster-transmission.daemon

say() { echo "transmission.sh: $*"; }

gateway() {  # (the default route's gateway, little-endian hex in /proc/net/route; the shell's printf reads hex, mawk's doesn't)
  g=$(awk 'NR > 1 && $2 == "00000000" { print $3; exit }' /proc/net/route)
  [ "${#g}" -eq 8 ] || return 0
  printf '%d.%d.%d.%d\n' "0x$(echo "$g" | cut -c7-8)" "0x$(echo "$g" | cut -c5-6)" "0x$(echo "$g" | cut -c3-4)" "0x$(echo "$g" | cut -c1-2)"
}

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

stop() {
  pid=$(cat "$PIDFILE" 2>/dev/null)
  alive "$pid" || { rm -f "$PIDFILE" "$DAEMON"; return 0; }
  kill -TERM "$pid" 2>/dev/null
  i=0
  while alive "$pid" && [ "$i" -lt 110 ]; do sleep 1; i=$((i + 1)); done
  if alive "$pid"; then  # (Transmission didn't finish saving in time: stopped as it is, and its folders let go)
    say "it didn't stop within 110 s: stopped hard"
    d=$(cat "$DAEMON" 2>/dev/null)
    alive "$d" && kill -KILL "$d" 2>/dev/null
    i=0
    while alive "$pid" && [ "$i" -lt 20 ]; do sleep 1; i=$((i + 1)); done
    alive "$pid" && kill -KILL "$pid" 2>/dev/null
  fi
  rm -f "$PIDFILE" "$DAEMON"
}

letgo() {  # <home> <folder>...: unmounted (lazily: nothing waits on a home that's gone)
  h=$1
  shift
  for rel in "$@"; do
    if awk -v m="$h/$rel" '{ gsub(/\\040/, " ", $2) } $2 == m { found = 1 } END { exit !found }' /proc/mounts; then
      umount -l "$h/$rel" 2>/dev/null
    fi
  done
}

start() {
  [ "$#" -ge 4 ] || { say "start <relay address> <relay port> <home folder> <settings folder> <folder>..."; exit 2; }
  relay=$1 port=$2 home=$3 settings=$4
  shift 4
  case "$home" in /home/?*) ;; *) say "Not a home folder: $home"; exit 2 ;; esac
  for rel in "$settings" "$@"; do
    case "$rel" in ""|/*|*..*) say "Not a folder in the home: $rel"; exit 2 ;; esac
  done
  [ -x /usr/bin/transmission-daemon ] && [ -x /sbin/mount.nfs4 ] || { say "Transmission or the NFS client isn't installed here (setup.py --linux)"; exit 3; }
  stop
  letgo "$home" "$settings" "$@"
  for rel in "$settings" "$@"; do
    mkdir -p "$home/$rel"
    if ! mount -t nfs4 -o "vers=4.2,port=$port,soft,timeo=150,retrans=3,nosuid,nodev,noexec" "$relay:$home/$rel" "$home/$rel"; then
      say "Couldn't reach the home's $rel"
      letgo "$home" "$settings" "$@"
      exit 4
    fi
  done
  owner=$(stat -c '%u:%g' "$home/$settings")
  echo $$ > "$PIDFILE"
  trap 'd=$(cat "$DAEMON" 2>/dev/null); alive "$d" && kill -TERM "$d"' TERM INT
  trap '' HUP
  umask 022
  HOME=$home nice -n 5 setpriv --reuid="${owner%%:*}" --regid="${owner##*:}" --clear-groups \
    /usr/bin/transmission-daemon -f --log-level=error -g "$home/$settings" &
  echo $! > "$DAEMON"
  d=$!
  say "running (its folders from $relay:$port, as $owner)"
  code=0
  wait "$d" || code=$?
  while alive "$d"; do wait "$d" || code=$?; done
  letgo "$home" "$settings" "$@"
  rm -f "$PIDFILE" "$DAEMON"
  say "stopped ($code)"
  exit "$code"
}

OWN_PIDFILE=/run/ht-cluster-own-transmission.pid
OWN_DAEMON=/run/ht-cluster-own-transmission.daemon

own_stop() {
  pid=$(cat "$OWN_PIDFILE" 2>/dev/null)
  alive "$pid" || { rm -f "$OWN_PIDFILE" "$OWN_DAEMON"; return 0; }
  kill -TERM "$pid" 2>/dev/null
  i=0
  while alive "$pid" && [ "$i" -lt 110 ]; do sleep 1; i=$((i + 1)); done
  if alive "$pid"; then
    say "its own didn't stop within 110 s: stopped hard"
    d=$(cat "$OWN_DAEMON" 2>/dev/null)
    alive "$d" && kill -KILL "$d" 2>/dev/null
    sleep 2
    alive "$pid" && kill -KILL "$pid" 2>/dev/null
  fi
  rm -f "$OWN_PIDFILE" "$OWN_DAEMON"
}

own_start() {
  [ "$#" -eq 1 ] || { say "own-start <settings folder>"; exit 2; }
  config=$1
  case "$config" in /mnt/[a-z]/*) ;; *) say "Not a folder on Windows' drive: $config"; exit 2 ;; esac
  case "$config" in *..*) say "Not a plain folder: $config"; exit 2 ;; esac
  [ -f "$config/settings.json" ] || { say "No settings in $config"; exit 2; }
  [ -x /usr/bin/transmission-daemon ] || { say "Transmission isn't installed here (setup.py --linux)"; exit 3; }
  own_stop
  echo $$ > "$OWN_PIDFILE"
  trap 'd=$(cat "$OWN_DAEMON" 2>/dev/null); alive "$d" && kill -TERM "$d"' TERM INT
  trap '' HUP
  umask 022
  HOME=/tmp nice -n 10 setpriv --reuid=1000 --regid=1000 --clear-groups /usr/bin/transmission-daemon -f --log-level=error -g "$config" &
  d=$!
  echo "$d" > "$OWN_DAEMON"
  say "own running"
  code=0
  wait "$d" || code=$?
  while alive "$d"; do wait "$d" || code=$?; done
  rm -f "$OWN_PIDFILE" "$OWN_DAEMON"
  say "own stopped ($code)"
  exit "$code"
}

case "${1:-}" in
  own-start) shift; own_start "$@" ;;
  own-stop) own_stop ;;
  install-libtorrent)
    export DEBIAN_FRONTEND=noninteractive
    { apt-get update -q && apt-get install -y -q --no-install-recommends python3 python3-libtorrent; } >/tmp/libtorrent-apt.log 2>&1 \
      || { tail -n 3 /tmp/libtorrent-apt.log; exit 1; }
    python3 -c "import libtorrent" || exit 1
    say "libtorrent installed" ;;
  has-libtorrent) command -v python3 >/dev/null 2>&1 && python3 -c "import libtorrent" 2>/dev/null ;;
  net) shift; echo "$(gateway) $(hostname -I 2>/dev/null | awk '{ print $1 }')" ;;
  start) shift; start "$@" ;;
  stop) stop ;;
  status) pid=$(cat "$PIDFILE" 2>/dev/null); if alive "$pid"; then echo running; else echo stopped; fi ;;
  *) say "net | start ... | stop | status | own-start ... | own-stop | install-libtorrent | has-libtorrent"; exit 2 ;;
esac
