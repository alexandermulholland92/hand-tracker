# The OAK camera rule the install added (see after-install-oak.sh): removed with the app,
# not on an upgrade (the new version's install writes it again).
# (Appended to electron-builder's own after-remove script by scripts/dist.js.)
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  rm -f /lib/udev/rules.d/80-hand-tracker-oak.rules
  if hash udevadm 2>/dev/null; then
    udevadm control --reload-rules || true
  fi
fi
