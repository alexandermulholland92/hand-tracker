# The Kinect for Xbox One (Several cameras → Kinect): its helper (kinect/kinect2-helper) talks to it
# over USB itself, which Linux only allows once a rule says so (libfreenect2's own rule, its three
# parts: the sensor, its audio and its hub). It goes away when Hand Tracker is removed. A Kinect
# that's already plugged in gets it at once.
# (Appended to electron-builder's own after-install script by scripts/dist.js.)
mkdir -p /lib/udev/rules.d
cat > /lib/udev/rules.d/80-hand-tracker-kinect.rules <<'RULES'
# The Kinect for Xbox One (Kinect v2), for Hand Tracker (removed with it)
SUBSYSTEM=="usb", ATTRS{idVendor}=="045e", ATTRS{idProduct}=="02c4", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="045e", ATTRS{idProduct}=="02d8", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="045e", ATTRS{idProduct}=="02d9", MODE="0666"
RULES
if hash udevadm 2>/dev/null; then
  udevadm control --reload-rules || true
  udevadm trigger --subsystem-match=usb --attr-match=idVendor=045e || true
fi
