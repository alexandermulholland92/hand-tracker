# The virtual mouse and keyboard's rule the install added (see after-install-uinput.sh):
# removed with the app, not on an upgrade (the new version's install writes it again).
# (Appended to electron-builder's own after-remove script by scripts/dist.js.)
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  rm -f /lib/udev/rules.d/70-hand-tracker-uinput.rules
  if hash udevadm 2>/dev/null; then
    udevadm control --reload-rules || true
    udevadm trigger --action=change --subsystem-match=misc --sysname-match=uinput || true
  fi
fi
