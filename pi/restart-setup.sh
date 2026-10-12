#!/bin/bash
# restart-setup.sh — lets Hand Tracker on a Raspberry Pi (or another Linux computer) restart it,
# turn it off, and turn its cameras' USB off and on, from remote recording's device settings
# page. Run it once (again after an update that asks for it):
#     sudo bash restart-setup.sh            # set up
#     sudo bash restart-setup.sh --remove   # take it away
#
# Restart cameras turns the USB ports the cameras are on off and on (uhubctl), as unplugging them
# would: an OAK camera that's stopped answering ("X_LINK_UNBOOTED") needs that, a USB reset alone
# doesn't do it. A Pi 5 switches all four of its own ports at once, so whatever else is plugged in
# there (a keyboard, a hub) goes off and on with them (never ports with a USB drive on them).
# Restart and Turn off restart it and turn it off. Only those commands are allowed without a
# password, for the person logged in at the screen.
set -euo pipefail

RULE=/etc/sudoers.d/hand-tracker-restart

if [ "$(id -u)" != 0 ]; then
  echo "Run it with sudo: sudo bash $0" >&2
  exit 1
fi
USER_NAME="${SUDO_USER:-}"
if [ -z "$USER_NAME" ] || [ "$USER_NAME" = root ]; then
  USER_NAME=$(loginctl list-sessions --no-legend 2>/dev/null | awk '$3 != "root" {print $3; exit}')
fi
if [ -z "$USER_NAME" ]; then
  echo "Who runs Hand Tracker here? Run it as them with sudo." >&2
  exit 1
fi

if [ "${1:-}" = "--remove" ]; then
  rm -f "$RULE"
  echo "Hand Tracker can't restart or turn off this computer, or its cameras' USB, any more (uhubctl stays installed)."
  exit 0
fi

if ! command -v uhubctl >/dev/null; then
  echo "Installing uhubctl (turns USB ports off and on)…"
  apt-get install -y uhubctl >/dev/null
fi
UHUBCTL=$(command -v uhubctl)
SYSTEMCTL=$(command -v systemctl)

TMP=$(mktemp)
cat > "$TMP" <<EOF
# Hand Tracker's remote recording page: restart this computer, turn it off, and its cameras' USB (pi/restart-setup.sh).
$USER_NAME ALL=(root) NOPASSWD: $SYSTEMCTL reboot, $SYSTEMCTL poweroff, $UHUBCTL
EOF
if ! visudo -cf "$TMP" >/dev/null; then
  rm -f "$TMP"
  echo "That rule didn't check out, so nothing was changed." >&2
  exit 1
fi
install -m 440 -o root -g root "$TMP" "$RULE"
rm -f "$TMP"

echo
echo "Done: Hand Tracker (as $USER_NAME) can restart this computer, turn it off, and turn its cameras' USB off and on."
echo "The USB ports here that uhubctl can switch:"
"$UHUBCTL" 2>/dev/null | grep -E "^Current status" | sed 's/^/  /' || echo "  (none found: Restart cameras then only resets them on the USB)"
