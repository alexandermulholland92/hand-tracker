#!/bin/bash
# sd-fallback.sh — a Raspberry Pi 5 that boots from an NVMe drive given a fallback on a microSD card: the boot files
# (/boot/firmware: the kernel, its initramfs, config.txt, cmdline.txt) copied to the card, and the bootloader set to
# try the card when it can't read the NVMe drive (pi, 2026-11-26: "NVMe read failure" over and over after a restart,
# until its power was cut). It still boots from the NVMe drive whenever it can; from the card only Linux's start comes,
# which then uses the NVMe drive as always (the card's cmdline.txt names the same root). Kept up to date by itself:
# the card's copy follows every change to /boot/firmware (a system update's new kernel), at each start and once a day.
# The card is only made the fallback when it's empty or already this one's (a card with files on it is never erased
# unless it's asked for: --erase). Takes effect from the next start. Run it once:
#     sudo bash sd-fallback.sh            # set up (a microSD card in the Pi)
#     sudo bash sd-fallback.sh --erase    # set up with a card that has files on it (they're all lost)
#     sudo bash sd-fallback.sh --remove   # take it away (the card's copy left on it)
set -euo pipefail

ROOT=""
if [ -n "${SD_FALLBACK_TEST_ROOT:-}" ]; then
  ROOT=$SD_FALLBACK_TEST_ROOT   # (the checks: a folder standing in for /, a stand-in rpi-eeprom-config on the PATH)
elif [ "$(id -u)" != 0 ]; then
  echo "Run it with sudo: sudo bash $0" >&2
  exit 1
fi

CARD=${SD_FALLBACK_CARD:-/dev/mmcblk0}   # (the checks: a loop device standing in for the card)
LABEL=HTBOOTFB
TOOL=$ROOT/usr/local/sbin/hand-tracker-sd-fallback
UNITS=$ROOT/etc/systemd/system
STATE=$ROOT/etc/hand-tracker/sd-fallback-boot-order   # (the bootloader's BOOT_ORDER before, for --remove)
SYSTEMCTL=${SD_FALLBACK_SYSTEMCTL:-systemctl}

# The bootloader's BOOT_ORDER now (e.g. 0xf46), from Raspberry Pi's own rpi-eeprom-config.
order_now() { rpi-eeprom-config 2>/dev/null | sed -n 's/^[[:space:]]*BOOT_ORDER[[:space:]]*=[[:space:]]*\(0x[0-9a-fA-F]*\).*/\1/p' | tail -1; }
# BOOT_ORDER set to $1 (the rest of its settings as they are), with --apply (in place from the next start).
order_write() {
  local now new
  now=$(mktemp)
  new=$(mktemp)
  if ! rpi-eeprom-config > "$now"; then
    rm -f "$now" "$new"
    return 1
  fi
  { echo "BOOT_ORDER=$1"; grep -vE "^[[:space:]]*BOOT_ORDER[[:space:]]*=" "$now" || true; } > "$new"
  if ! rpi-eeprom-config --apply "$new" >&2; then
    rm -f "$now" "$new"
    return 1
  fi
  rm -f "$now" "$new"
}
# The order with the microSD card (1) tried right after the NVMe drive (6): read from the lowest digit up (0xf46 is
# NVMe, then USB, then start again: 0xf416 is NVMe, the card, USB, start again). Unchanged if the card's in it already.
with_card() {
  local hex=${1#0x} out="" i d
  case "$hex" in *1*) echo "$1"; return ;; esac
  for (( i=${#hex}-1; i>=0; i-- )); do
    d=${hex:$i:1}
    out="$out$d"
    [ "$d" = 6 ] && out="${out}1"
  done
  case "$out" in *1*) ;; *) out="1$out" ;; esac   # (no NVMe in it: the card first)
  local back=""
  for (( i=${#out}-1; i>=0; i-- )); do back="$back${out:$i:1}"; done
  echo "0x$back"
}
units_off() {
  "$SYSTEMCTL" disable --now hand-tracker-sd-fallback.path hand-tracker-sd-fallback.timer >/dev/null 2>&1 || true
  rm -f "$UNITS/hand-tracker-sd-fallback.service" "$UNITS/hand-tracker-sd-fallback.path" "$UNITS/hand-tracker-sd-fallback.timer"
  "$SYSTEMCTL" daemon-reload >/dev/null 2>&1 || true
}

if [ "${1:-}" = "--remove" ]; then
  said="the card's copy isn't kept up to date any more (it's left on the card)"
  units_off
  rm -f "$TOOL"
  if [ -f "$STATE" ]; then
    before=$(sed -n 1p "$STATE")
    if [ "$before" != keep ] && command -v rpi-eeprom-config >/dev/null; then
      if order_write "$before"; then
        said="$said; the bootloader doesn't try the card any more ($before, from the next start)"
      else
        echo "Removed, but the bootloader's settings couldn't be put back (rpi-eeprom-config --apply)." >&2
        exit 1
      fi
    fi
    rm -f "$STATE"
    rmdir "$(dirname "$STATE")" 2>/dev/null || true
  fi
  echo "Removed: $said."
  exit 0
fi

MODEL=$(tr -d '\0' < "$ROOT/proc/device-tree/model" 2>/dev/null || true)
case "$MODEL" in
  *"Raspberry Pi 5"*|*"Raspberry Pi Compute Module 5"*|*"Raspberry Pi 500"*) ;;
  *) echo "This is for a Raspberry Pi 5 (this is ${MODEL:-not one}) that boots from an NVMe drive." >&2; exit 1 ;;
esac
command -v rpi-eeprom-config >/dev/null || { echo "This needs rpi-eeprom-config (sudo apt install rpi-eeprom)." >&2; exit 1; }
for t in sfdisk mkfs.vfat lsblk blkid wipefs; do
  command -v "$t" >/dev/null || { echo "This needs $t (sudo apt install util-linux dosfstools)." >&2; exit 1; }
done
BOOT=$ROOT/boot/firmware
[ -f "$BOOT/config.txt" ] || { echo "There's no /boot/firmware/config.txt here: is this a Raspberry Pi?" >&2; exit 1; }
if [ -z "$ROOT" ]; then
  src=$(findmnt -no SOURCE /boot/firmware 2>/dev/null || true)
  case "$src" in
    /dev/nvme*) ;;
    *) echo "This Pi doesn't start from an NVMe drive (its boot files are on ${src:-nothing}): nothing to fall back from." >&2; exit 1 ;;
  esac
fi
if [ -n "$ROOT" ] && [ -n "${SD_FALLBACK_TEST_CARD_DIR:-}" ]; then
  PART="dir:$SD_FALLBACK_TEST_CARD_DIR"   # (the checks: a folder standing in for the card's partition, mounted)
else
  [ -b "$CARD" ] || { echo "There's no microSD card in this Pi: put one in (any size: about 1 GB of it is used), then try again." >&2; exit 1; }
  # The card's partition: one already ours (its label), else the card made into one, if it's empty (or --erase).
  part_of() { lsblk -nrpo NAME,LABEL "$CARD" 2>/dev/null | awk -v l="$LABEL" '$2 == l { print $1; exit }'; }
  PART=$(part_of)
fi
if [ -z "$PART" ]; then
  if lsblk -nrpo MOUNTPOINT "$CARD" 2>/dev/null | grep -q .; then
    echo "The microSD card is in use (mounted): nothing done." >&2
    exit 1
  fi
  case "$(findmnt -no SOURCE / 2>/dev/null || true)" in
    "$CARD"*) echo "This Pi's own system is on the microSD card: it can't be the fallback." >&2; exit 1 ;;
  esac
  files=0
  # (each partition, and the card itself when it has a file system with no partitions)
  places=$(lsblk -nrpo NAME,TYPE "$CARD" | awk '$2 == "part" { print $1 }')
  [ -n "$places" ] || places=$CARD
  for p in $places; do
    m=$(mktemp -d)
    if mount -o ro "$p" "$m" 2>/dev/null; then
      n=$(find "$m" -mindepth 1 \( -name "System Volume Information" -o -name ".Spotlight-V100" -o -name ".fseventsd" -o -name ".Trashes" -o -name "lost+found" \) -prune -o -mindepth 1 -print 2>/dev/null | wc -l)
      files=$((files + n))
      umount "$m"
    elif blkid -p "$p" >/dev/null 2>&1; then
      files=$((files + 1))   # (something on it this Pi can't read: taken as files)
    fi
    rmdir "$m"
  done
  if [ "$files" -gt 0 ] && [ "${1:-}" != "--erase" ]; then
    echo "The microSD card has files on it ($files): it isn't erased without asking. To use it anyway (everything on it is lost): sudo bash $(basename "$0") --erase" >&2
    exit 1
  fi
  # One FAT32 partition of 1 GB (or the whole card, if it's smaller), labelled as this one's.
  wipefs -q -a "$CARD"
  size=$(blockdev --getsize64 "$CARD" 2>/dev/null || echo 0)
  if [ "$size" -gt $((1100 * 1024 * 1024)) ]; then spec="start=2048, size=2097152, type=c"; else spec="start=2048, type=c"; fi
  printf 'label: dos\n%s\n' "$spec" | sfdisk -q "$CARD"
  partprobe "$CARD" 2>/dev/null || blockdev --rereadpt "$CARD" 2>/dev/null || true
  udevadm settle 2>/dev/null || true
  p1=$(lsblk -nrpo NAME,TYPE "$CARD" | awk '$2 == "part" { print $1; exit }')
  [ -n "$p1" ] || { echo "The microSD card's partition didn't show up after it was made." >&2; exit 1; }
  mkfs.vfat -F 32 -n "$LABEL" "$p1" >/dev/null
  udevadm settle 2>/dev/null || true
  PART=$p1
fi

# The tool that keeps the card's copy up to date (run now, then on every change to /boot/firmware, at each start
# and once a day).
mkdir -p "$(dirname "$TOOL")" "$UNITS" "$(dirname "$STATE")"
cat > "$TOOL.ht-new" <<'TOOL'
#!/bin/bash
# hand-tracker-sd-fallback (pi/sd-fallback.sh): the microSD card's copy of /boot/firmware brought up to date (its
# partition found by its label, HTBOOTFB), so the bootloader can start Linux from the card when it can't read the
# NVMe drive. The bootloader's own updates (pieeprom.upd, recovery.bin) aren't copied: they're put in from the drive.
set -euo pipefail
SRC=${HT_SD_FALLBACK_SRC:-/boot/firmware}
PART=${HT_SD_FALLBACK_PART:-$(blkid -L HTBOOTFB 2>/dev/null || true)}
if [ -z "$PART" ]; then
  echo "No microSD card with the fallback in this Pi (label HTBOOTFB): nothing copied."
  exit 0
fi
# (a system update writes many files: wait until /boot/firmware has been quiet for 20 s, 10 min at most)
if [ "${1:-}" = "--wait" ]; then
  for _ in $(seq 1 60); do
    newest=$(find "$SRC" -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1 | cut -d. -f1)
    [ -n "$newest" ] && [ $(( $(date +%s) - newest )) -ge 20 ] && break
    sleep 10
  done
fi
if [ "${PART#dir:}" != "$PART" ]; then
  mnt=${PART#dir:}   # (the checks: a folder standing in for the card's partition)
else
  mnt=$(mktemp -d /run/hand-tracker-sd-fallback.XXXXXX)
  mount -o rw,noatime "$PART" "$mnt"
  trap 'umount "$mnt" 2>/dev/null || true; rmdir "$mnt" 2>/dev/null || true' EXIT
fi
skip() { case "$1" in pieeprom.upd|pieeprom.sig|recovery.bin|RECOVERY.*|"System Volume Information"*) return 0 ;; esac; return 1; }
copied=0
# New and changed files (by size and time: FAT keeps times to 2 s).
while IFS= read -r -d '' f; do
  rel=${f#"$SRC"/}
  skip "$rel" && continue
  dst=$mnt/$rel
  if [ -f "$dst" ]; then
    a=$(stat -c '%s %Y' "$f")
    b=$(stat -c '%s %Y' "$dst")
    if [ "${a% *}" = "${b% *}" ]; then
      ta=${a#* }; tb=${b#* }
      [ $(( ta > tb ? ta - tb : tb - ta )) -le 2 ] && continue
    fi
  fi
  mkdir -p "$(dirname "$dst")"
  cp --preserve=timestamps "$f" "$dst.ht-new"
  mv -f "$dst.ht-new" "$dst"
  copied=$((copied + 1))
done < <(find "$SRC" -type f -print0)
# Files gone from /boot/firmware gone from the card too.
removed=0
while IFS= read -r -d '' g; do
  rel=${g#"$mnt"/}
  skip "$rel" && continue
  [ -e "$SRC/$rel" ] && continue
  rm -f "$g"
  removed=$((removed + 1))
done < <(find "$mnt" -type f -print0)
find "$mnt" -mindepth 1 -type d -empty -delete 2>/dev/null || true
sync
echo "The microSD card's copy of the boot files is up to date ($copied copied, $removed taken away)."
TOOL
chmod 0755 "$TOOL.ht-new"
mv -f "$TOOL.ht-new" "$TOOL"

cat > "$UNITS/hand-tracker-sd-fallback.service" <<'UNIT'
[Unit]
Description=Hand Tracker: the microSD card's copy of the boot files brought up to date (pi/sd-fallback.sh)
After=local-fs.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/hand-tracker-sd-fallback --wait
Nice=10
IOSchedulingClass=idle
UNIT
cat > "$UNITS/hand-tracker-sd-fallback.path" <<'UNIT'
[Unit]
Description=Hand Tracker: a change to the boot files copied to the microSD card (pi/sd-fallback.sh)

[Path]
PathChanged=/boot/firmware
Unit=hand-tracker-sd-fallback.service

[Install]
WantedBy=multi-user.target
UNIT
cat > "$UNITS/hand-tracker-sd-fallback.timer" <<'UNIT'
[Unit]
Description=Hand Tracker: the microSD card's copy of the boot files checked at each start and once a day (pi/sd-fallback.sh)

[Timer]
OnBootSec=2min
OnUnitActiveSec=1d
Unit=hand-tracker-sd-fallback.service

[Install]
WantedBy=timers.target
UNIT

if [ -n "$ROOT" ]; then
  HT_SD_FALLBACK_SRC=$BOOT HT_SD_FALLBACK_PART=$PART "$TOOL" >/dev/null
else
  HT_SD_FALLBACK_PART=$PART "$TOOL" >/dev/null
fi
"$SYSTEMCTL" daemon-reload >/dev/null 2>&1 || true
"$SYSTEMCTL" enable --now hand-tracker-sd-fallback.path hand-tracker-sd-fallback.timer >/dev/null 2>&1 || true

# The bootloader: the card right after the NVMe drive.
now=$(order_now)
[ -n "$now" ] || now=0xf461   # (not set: a Pi 5's own order, which has the card first already)
new=$(with_card "$now")
if [ "$new" = "$now" ]; then
  [ -f "$STATE" ] || echo keep > "$STATE"
  said="the bootloader tries the card already ($now)"
else
  if ! order_write "$new"; then
    echo "The card has the boot files, but the bootloader's settings couldn't be written (rpi-eeprom-config --apply)." >&2
    exit 1
  fi
  [ -f "$STATE" ] || echo "$now" > "$STATE"
  said="the bootloader tries the card after the NVMe drive ($now -> $new, from the next start)"
fi
echo "Set up: the boot files are on the microSD card and kept up to date; $said."
