# The hand mouse and floating keyboard on a Wayland desktop (Raspberry Pi OS's, GNOME's, KDE's):
# Wayland lets no app move the pointer or type into other apps, so Hand Tracker makes a virtual
# mouse and keyboard (electron/input-helper-linux.py) with /dev/uinput, which only root may use
# until a rule says otherwise. This one lets whoever is logged in at this computer's own screen
# use it (logind's "uaccess", as for the other devices there; it has to come before logind's
# 73-seat-late.rules), not other users or remote logins. It goes away when Hand Tracker is
# removed, and the person logged in now gets it at once.
# (Appended to electron-builder's own after-install script by scripts/dist.js.)
mkdir -p /lib/udev/rules.d
cat > /lib/udev/rules.d/70-hand-tracker-uinput.rules <<'RULES'
# Hand Tracker's virtual mouse and keyboard (removed with it)
KERNEL=="uinput", SUBSYSTEM=="misc", OPTIONS+="static_node=uinput", TAG+="uaccess"
RULES
if hash udevadm 2>/dev/null; then
  udevadm control --reload-rules || true
  udevadm trigger --action=change --subsystem-match=misc --sysname-match=uinput || true
fi
