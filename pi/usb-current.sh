#!/bin/bash
# usb-current.sh — a Raspberry Pi 5's USB ports given their full 1.6 A in all, though it didn't find a 5 A supply
# (its "power to peripherals will be restricted": 0.6 A in all then). This is Raspberry Pi's own setting for it,
# usb_max_current_enable=1 in config.txt (raspi-config's "USB current"), and it takes effect at the next
# restart. Only for a supply that can give it: on a weaker one (a phone charger, a battery), USB devices drawing
# more can make the Pi lose power (cloud, 2026-11-19: on a battery; the user's choice, as a switch in Pi
# Cluster's Fixes). Run it once:
#     sudo bash usb-current.sh            # set up (then restart the Pi)
#     sudo bash usb-current.sh --remove   # take it away (then restart the Pi)
#
# It adds three lines of its own at the end of config.txt (a comment, [all], the setting), keeping a copy of the
# file as it was before the first time (config.txt.before-usb-current). When config.txt sets it already (put in
# by hand, or with raspi-config), that's left as it is, and --remove leaves it too.
set -euo pipefail

ROOT=""
if [ -n "${USB_CURRENT_TEST_ROOT:-}" ]; then
  ROOT=$USB_CURRENT_TEST_ROOT   # (the checks: a folder standing in for /)
elif [ "$(id -u)" != 0 ]; then
  echo "Run it with sudo: sudo bash $0" >&2
  exit 1
fi

CONFIG=$ROOT/boot/firmware/config.txt
[ -f "$CONFIG" ] || CONFIG=$ROOT/boot/config.txt
MARK=$ROOT/etc/hand-tracker/usb-current   # ("added": its lines are in config.txt; "by hand": it was set already)
HEAD="# Hand Tracker (pi/usb-current.sh): the USB ports' full 1.6 A without a 5 A supply"
SETTING=usb_max_current_enable=1

if [ ! -f "$CONFIG" ]; then
  echo "There's no config.txt here (/boot/firmware/config.txt): is this a Raspberry Pi?" >&2
  exit 1
fi
ours() { grep -qxF "$HEAD" "$CONFIG"; }
# (a line of its own setting it, not a comment: put in by hand, or by raspi-config)
set_already() { grep -qE "^[[:space:]]*usb_max_current_enable[[:space:]]*=[[:space:]]*1[[:space:]]*$" "$CONFIG"; }
# config.txt written whole, then put in place (it's on the boot partition: a half-written file must never be left).
put() {
  cat > "$CONFIG.ht-new"
  sync "$CONFIG.ht-new" 2>/dev/null || true
  mv "$CONFIG.ht-new" "$CONFIG"
  sync 2>/dev/null || true
}

if [ "${1:-}" = "--remove" ]; then
  if ours; then
    # (its three lines only: the comment, then [all] and the setting right after it)
    awk -v head="$HEAD" -v setting="$SETTING" '
      state == 1 && $0 == "[all]" { state = 2; next }
      state == 2 && $0 == setting { state = 0; next }
      { state = 0 }
      $0 == head { state = 1; next }
      { print }
    ' "$CONFIG" | put
    said="taken out of config.txt: the USB ports go back to 0.6 A in all without a 5 A supply, from the next restart"
  elif set_already; then
    said="config.txt sets it itself (by hand or with raspi-config): left as it is"
  else
    said="it wasn't set"
  fi
  rm -f "$MARK"
  rmdir "$(dirname "$MARK")" 2>/dev/null || true
  echo "Removed: $said."
  exit 0
fi

MODEL=$(tr -d '\0' < "$ROOT/proc/device-tree/model" 2>/dev/null || true)
case "$MODEL" in
  *"Raspberry Pi 5"*|*"Raspberry Pi Compute Module 5"*|*"Raspberry Pi 500"*) ;;
  *) echo "This is for a Raspberry Pi 5 (this is ${MODEL:-not one}): others don't limit their USB ports this way." >&2; exit 1 ;;
esac
mkdir -p "$(dirname "$MARK")"
if ours; then
  echo added > "$MARK"
  echo "Set up already: config.txt has it (the USB ports' full 1.6 A from the next restart, if not yet)."
elif set_already; then
  echo "by hand" > "$MARK"
  echo "Set up already: config.txt sets it itself (by hand or with raspi-config), so it's left as it is."
else
  [ -f "$CONFIG.before-usb-current" ] || cp "$CONFIG" "$CONFIG.before-usb-current"
  { cat "$CONFIG"; [ -z "$(tail -c1 "$CONFIG")" ] || echo; printf '%s\n[all]\n%s\n' "$HEAD" "$SETTING"; } | put
  echo added > "$MARK"
  echo "Set up: the USB ports may draw 1.6 A in all from the next restart (restart this Pi for it to take effect)."
fi
