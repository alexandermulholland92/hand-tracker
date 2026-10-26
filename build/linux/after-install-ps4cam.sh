# The PlayStation 4 camera (Several cameras → PlayStation 4 camera): it starts in a mode that only
# takes its firmware, which the app sends it over USB itself (ps4cam/ps4cam_helper.py); Linux only
# allows that once a rule says so. Once it has its firmware it's a camera like any webcam. The rule
# goes away when Hand Tracker is removed. A camera that's already plugged in gets it at once.
# (Appended to electron-builder's own after-install script by scripts/dist.js.)
mkdir -p /lib/udev/rules.d
cat > /lib/udev/rules.d/80-hand-tracker-ps4cam.rules <<'RULES'
# The PlayStation 4 camera before its firmware is sent (OV580 start-up mode), for Hand Tracker (removed with it)
SUBSYSTEM=="usb", ATTRS{idVendor}=="05a9", ATTRS{idProduct}=="0580", MODE="0666"
RULES
if hash udevadm 2>/dev/null; then
  udevadm control --reload-rules || true
  udevadm trigger --subsystem-match=usb --attr-match=idVendor=05a9 || true
fi
