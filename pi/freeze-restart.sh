#!/bin/bash
# freeze-restart.sh — a Raspberry Pi running Hand Tracker restarted by itself when it freezes, and its log
# kept on its drive, so a freeze leaves a record (pi, 2026-11-14: a kernel panic, then a freeze, each time
# needing the power pulled, and nothing to say why: Raspberry Pi OS keeps its log in memory only). Run it once:
#     sudo bash freeze-restart.sh            # set up
#     sudo bash freeze-restart.sh --remove   # take it away (the log kept so far stays on the drive)
#
# Four things, all kept after a restart (the first three the settings pi was given by hand on 2026-11-14):
#  - The Pi's hardware watchdog, kept going by systemd: when the system stops answering for 30 seconds,
#    the watchdog restarts the Pi.
#  - A kernel panic restarts the Pi 10 seconds later, instead of leaving it frozen.
#  - The log (systemd's journal) kept in /var/log/journal, not only in memory: after a restart,
#    `journalctl -b -1` shows what happened before it. Raspberry Pi OS keeps it in memory to spare SD
#    cards; on the drive it takes at most 10 % of it (and 4 GB at most), the oldest dropped first.
#  - Something stuck in the kernel for 2 minutes (waiting on a drive or a driver that stopped answering)
#    taken as a kernel panic, so the Pi restarts then too. The watchdog misses that kind of freeze, as
#    systemd itself still answers it (pi, 2026-11-20: stuck from 10:10 to 12:24 with nothing logged and
#    its watchdog on, until it was restarted by hand). Only where the kernel has that check.
set -euo pipefail

WATCHDOG=/etc/systemd/system.conf.d/50-watchdog.conf
PANIC=/etc/sysctl.d/90-panic-reboot.conf
JOURNAL=/etc/systemd/journald.conf.d/50-persistent.conf
BEFORE=/etc/hand-tracker/kernel-panic-before    # (kernel.panic as it was, for --remove)
HUNG_BEFORE=/etc/hand-tracker/hung-task-before  # (the stuck check's panic and wait as they were, for --remove)

if [ "$(id -u)" != 0 ]; then
  echo "Run it with sudo: sudo bash $0" >&2
  exit 1
fi

if [ "${1:-}" = "--remove" ]; then
  had_hung=$(grep -c '^kernel.hung_task_panic=1' "$PANIC" 2>/dev/null || true)
  rm -f "$WATCHDOG" "$PANIC" "$JOURNAL"
  systemctl daemon-reexec                      # (systemd lets the watchdog go)
  # (the stuck check's panic put back first: a stuck task never panics a Pi that no longer restarts after one)
  if [ -f "$HUNG_BEFORE" ]; then
    read -r was_panic was_wait < "$HUNG_BEFORE" || true
    sysctl -q -w kernel.hung_task_panic="${was_panic:-0}" || true
    sysctl -q -w kernel.hung_task_timeout_secs="${was_wait:-120}" || true
    rm -f "$HUNG_BEFORE"
  elif [ "${had_hung:-0}" != 0 ]; then
    sysctl -q -w kernel.hung_task_panic=0 || true
  fi
  if [ -f "$BEFORE" ]; then
    sysctl -q -w kernel.panic="$(cat "$BEFORE")" || true
    rm -f "$BEFORE"
    panic="back to $(sysctl -n kernel.panic) s"
  else
    panic="back to the kernel's own at the next restart"
  fi
  rmdir /etc/hand-tracker 2>/dev/null || true
  systemctl restart systemd-journald           # (the log in memory again, as Raspberry Pi OS has it)
  echo "Removed: no watchdog, kernel panics $panic, nothing stuck taken as a panic, the log in memory only (what was kept stays in /var/log/journal)."
  exit 0
fi

mkdir -p "$(dirname "$WATCHDOG")" "$(dirname "$PANIC")" "$(dirname "$JOURNAL")" "$(dirname "$BEFORE")"
if [ ! -f "$PANIC" ] && [ ! -f "$BEFORE" ]; then
  sysctl -n kernel.panic > "$BEFORE"
fi
# The kernel's check for something stuck, where it has one: its panic and wait as they were, kept the
# first time this sets them.
stuck=""
if sysctl -n kernel.hung_task_panic >/dev/null 2>&1 && sysctl -n kernel.hung_task_timeout_secs >/dev/null 2>&1; then
  stuck=1
  if [ ! -f "$HUNG_BEFORE" ] && ! grep -q '^kernel.hung_task_panic=1' "$PANIC" 2>/dev/null; then
    echo "$(sysctl -n kernel.hung_task_panic) $(sysctl -n kernel.hung_task_timeout_secs)" > "$HUNG_BEFORE"
  fi
fi
printf '# Hand Tracker (pi/freeze-restart.sh): the Pi restarted when it stops answering for 30 s.\n[Manager]\nRuntimeWatchdogSec=30s\n' > "$WATCHDOG"
{
  # (kernel.panic first, here and when the Pi starts: a stuck task's panic always restarts it)
  printf '# Hand Tracker (pi/freeze-restart.sh): the Pi restarted 10 s after a kernel panic.\nkernel.panic=10\n'
  if [ -n "$stuck" ]; then
    printf '# ...and something stuck in the kernel for 2 minutes (a drive or a driver) taken as a panic.\nkernel.hung_task_timeout_secs=120\nkernel.hung_task_panic=1\n'
  fi
} > "$PANIC"
printf '# Hand Tracker (pi/freeze-restart.sh): the log kept on the drive, not only in memory.\n[Journal]\nStorage=persistent\n' > "$JOURNAL"
sysctl -q -p "$PANIC"
systemctl daemon-reexec
systemctl restart systemd-journald
journalctl --flush >/dev/null 2>&1 || true

dog=$(systemctl show -p RuntimeWatchdogUSec --value 2>/dev/null || true)
if [ -e /dev/watchdog0 ] && [ -n "$dog" ] && [ "$dog" != 0 ] && [ "$dog" != infinity ]; then
  dog="restarts it after $dog frozen"
else
  dog="has no hardware watchdog here (nothing restarts it when it freezes)"
fi
if [ -n "$stuck" ]; then
  stuck=" or after something stays stuck in the kernel for $(sysctl -n kernel.hung_task_timeout_secs) s"
else
  stuck=" (this kernel can't tell when something is stuck)"
fi
echo "Set up: this Pi $dog, restarts $(sysctl -n kernel.panic) s after a kernel panic$stuck, and keeps its log in /var/log/journal."
