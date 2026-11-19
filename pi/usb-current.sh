#!/bin/bash
# usb-current.sh — a Raspberry Pi 5 that didn't find a 5 A supply ("This power supply is not capable of supplying
# 5A … power to peripherals will be restricted": its USB ports limited to 0.6 A in all) treated as if it had one:
# its USB ports given their full 1.6 A, and no warning. Two of Raspberry Pi's own settings:
#  - usb_max_current_enable=1 in config.txt (raspi-config's "USB current"): the USB ports' 1.6 A. Alone it leaves
#    the warning, which goes by the supply the Pi found (cloud, 2026-11-19: "I tried the official way but it
#    didn't work");
#  - PSU_MAX_CURRENT=5000 in the bootloader's own settings (its EEPROM, through rpi-eeprom-config): the supply taken
#    as a 5 A one, so no warning (and the USB ports' 1.6 A by itself).
# Both take effect at the next restart. Only for a supply that can give that much: on a weaker one (a phone charger,
# a battery), USB devices drawing more can make the Pi lose power (cloud: on a battery, the user's choice, as a
# switch in Pi Cluster's Fixes). Keep the Pi's power steady while this runs and while it restarts after: the
# bootloader's settings are written then. Run it once:
#     sudo bash usb-current.sh            # set up (then restart the Pi)
#     sudo bash usb-current.sh --remove   # take it away (then restart the Pi)
#
# config.txt: three lines of its own at its end (a comment, [all], the setting), with a copy of the file from
# before the first time (config.txt.before-usb-current); when config.txt sets it already (by hand, or with
# raspi-config), that's left as it is, and --remove leaves it too. The bootloader: PSU_MAX_CURRENT=5000 first in
# its settings, what it had kept for --remove (/etc/hand-tracker/usb-current-psu, with the start it was written
# in); not written again while it's set already, or while it waits for this start's restart; one set to 5000 by
# hand is left as it is.
set -euo pipefail

ROOT=""
if [ -n "${USB_CURRENT_TEST_ROOT:-}" ]; then
  ROOT=$USB_CURRENT_TEST_ROOT   # (the checks: a folder standing in for /, and a stand-in rpi-eeprom-config on the PATH)
elif [ "$(id -u)" != 0 ]; then
  echo "Run it with sudo: sudo bash $0" >&2
  exit 1
fi

CONFIG=$ROOT/boot/firmware/config.txt
[ -f "$CONFIG" ] || CONFIG=$ROOT/boot/config.txt
MARK=$ROOT/etc/hand-tracker/usb-current       # ("added": its lines are in config.txt; "by hand": it was set already)
PSU=$ROOT/etc/hand-tracker/usb-current-psu    # (the bootloader's PSU_MAX_CURRENT before: a number, "none" or "keep"; the start it was written in)
HEAD="# Hand Tracker (pi/usb-current.sh): the USB ports' full 1.6 A without a 5 A supply"
SETTING=usb_max_current_enable=1
BOOT_ID=$(cat "$ROOT/proc/sys/kernel/random/boot_id" 2>/dev/null || echo "?")

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
# The bootloader's PSU_MAX_CURRENT as it runs now (nothing: not set).
psu_now() { rpi-eeprom-config 2>/dev/null | sed -n 's/^[[:space:]]*PSU_MAX_CURRENT[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' | tail -1; }
# The bootloader's settings with PSU_MAX_CURRENT=$1 ("none": the line taken out), the rest as they are, written by
# Raspberry Pi's own rpi-eeprom-config (its --apply: with the bootloader release this Pi has; in place at the restart).
psu_write() {
  local now new
  now=$(mktemp)
  new=$(mktemp)
  if ! rpi-eeprom-config > "$now"; then
    rm -f "$now" "$new"
    return 1
  fi
  { [ "$1" = none ] || echo "PSU_MAX_CURRENT=$1"; grep -vE "^[[:space:]]*PSU_MAX_CURRENT[[:space:]]*=" "$now" || true; } > "$new"
  if ! rpi-eeprom-config --apply "$new" >&2; then
    rm -f "$now" "$new"
    return 1
  fi
  rm -f "$now" "$new"
}

changed=0
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
    said="config.txt: its setting taken out"
    changed=1
  elif set_already; then
    said="config.txt sets it itself (by hand or with raspi-config): left as it is"
  else
    said="config.txt: it wasn't set"
  fi
  if [ -f "$PSU" ]; then
    before=$(sed -n 1p "$PSU")
    if [ "$before" = keep ]; then
      said="$said; the bootloader's PSU_MAX_CURRENT was set by hand: left as it is"
    elif command -v rpi-eeprom-config >/dev/null && psu_write "$before"; then
      said="$said; the bootloader goes back to the supply it finds"
      changed=1
    else
      echo "Removed from config.txt, but the bootloader's settings couldn't be put back (rpi-eeprom-config --apply)." >&2
      exit 1
    fi
    rm -f "$PSU"
  fi
  rm -f "$MARK"
  rmdir "$(dirname "$MARK")" 2>/dev/null || true
  if [ "$changed" = 1 ]; then
    echo "Removed: $said. Restart this Pi for it to take effect (then 0.6 A for the USB ports again without a 5 A supply)."
  else
    echo "Removed: $said."
  fi
  exit 0
fi

MODEL=$(tr -d '\0' < "$ROOT/proc/device-tree/model" 2>/dev/null || true)
case "$MODEL" in
  *"Raspberry Pi 5"*|*"Raspberry Pi Compute Module 5"*|*"Raspberry Pi 500"*) ;;
  *) echo "This is for a Raspberry Pi 5 (this is ${MODEL:-not one}): others don't limit their USB ports this way." >&2; exit 1 ;;
esac
command -v rpi-eeprom-config >/dev/null || { echo "This needs rpi-eeprom-config (sudo apt install rpi-eeprom)." >&2; exit 1; }
mkdir -p "$(dirname "$MARK")"

# config.txt
if ours; then
  echo added > "$MARK"
  said="config.txt has it already"
elif set_already; then
  echo "by hand" > "$MARK"
  said="config.txt sets it itself (by hand or with raspi-config): left as it is"
else
  [ -f "$CONFIG.before-usb-current" ] || cp "$CONFIG" "$CONFIG.before-usb-current"
  { cat "$CONFIG"; [ -z "$(tail -c1 "$CONFIG")" ] || echo; printf '%s\n[all]\n%s\n' "$HEAD" "$SETTING"; } | put
  echo added > "$MARK"
  said="config.txt: the USB ports' full 1.6 A"
  changed=1
fi

# The bootloader
now=$(psu_now)
if [ "$now" = 5000 ]; then
  [ -f "$PSU" ] || printf 'keep\n%s\n' "$BOOT_ID" > "$PSU"
  said="$said; the bootloader takes the supply as 5 A already"
elif [ -f "$PSU" ] && [ "$(sed -n 2p "$PSU")" = "$BOOT_ID" ]; then
  said="$said; the bootloader's settings are written already, for the restart"
  changed=1
else
  before=${now:-none}
  if [ -f "$PSU" ] && [ "$(sed -n 1p "$PSU")" != keep ]; then
    before=$(sed -n 1p "$PSU")   # (written in an earlier start but not taken: what it had at first kept)
  fi
  if ! psu_write 5000; then
    echo "$said, but the bootloader's settings couldn't be written (rpi-eeprom-config --apply): the warning stays." >&2
    exit 1
  fi
  printf '%s\n%s\n' "$before" "$BOOT_ID" > "$PSU"
  said="$said; the bootloader takes the supply as 5 A (no more warning)"
  changed=1
fi
if [ "$changed" = 1 ]; then
  echo "Set up: $said. Restart this Pi for it to take effect."
else
  echo "Set up: $said."
fi
