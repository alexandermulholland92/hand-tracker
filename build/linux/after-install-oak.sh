# Luxonis OAK cameras (Camera → Luxonis OAK camera): the app talks to the camera over USB
# itself, which Linux only allows once a rule says so. This is Luxonis's own rule, from its
# instructions; it goes away when Hand Tracker is removed. A camera that's already plugged
# in gets it at once.
# (Appended to electron-builder's own after-install script by scripts/dist.js.)
mkdir -p /lib/udev/rules.d
cat > /lib/udev/rules.d/80-hand-tracker-oak.rules <<'RULES'
# Luxonis OAK cameras, for Hand Tracker (removed with it)
SUBSYSTEM=="usb", ATTRS{idVendor}=="03e7", MODE="0666"
RULES
if hash udevadm 2>/dev/null; then
  udevadm control --reload-rules || true
  udevadm trigger --subsystem-match=usb --attr-match=idVendor=03e7 || true
fi
