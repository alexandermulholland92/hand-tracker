#!/usr/bin/env python3
"""bt-hid-linux.py: this Linux computer (a Raspberry Pi too) as a Bluetooth mouse and keyboard
(HID over GATT) for another device, an iPhone or iPad most of all (hid-core.js has the
reports). Uses BlueZ, Linux's own Bluetooth, through D-Bus: python3-dbus and python3-gi
(Raspberry Pi OS and most desktops have both). electron/bt-hid.js runs it.

    bt-hid-linux.py <report map, hex> <report id:size,...>
    stdin:  "r <id> <hex>"   a report (sent to the device taking them)
            "quit"
    stdout: "ready"                      published and advertising
            "clients <n> <device name>"  devices taking the mouse's reports
            "error <message>"            (then it ends)

Pairing is accepted without a code (a mouse has no screen to show one); BlueZ asks the
desktop's own Bluetooth agent first if one is running.
"""

import os
import sys

try:
    import dbus
    import dbus.exceptions
    import dbus.mainloop.glib
    import dbus.service
    from gi.repository import GLib
except ImportError:
    print("error Bluetooth here needs python3-dbus and python3-gi: sudo apt install python3-dbus python3-gi", flush=True)
    sys.exit(1)

BLUEZ = "org.bluez"
ADAPTER = "org.bluez.Adapter1"
DEVICE = "org.bluez.Device1"
GATT_MANAGER = "org.bluez.GattManager1"
ADV_MANAGER = "org.bluez.LEAdvertisingManager1"
AGENT_MANAGER = "org.bluez.AgentManager1"
OM = "org.freedesktop.DBus.ObjectManager"
PROPS = "org.freedesktop.DBus.Properties"
SERVICE = "org.bluez.GattService1"
CHRC = "org.bluez.GattCharacteristic1"
DESC = "org.bluez.GattDescriptor1"
ROOT = "/com/handtracker/hid"


def say(line):
    print(line, flush=True)


def uuid16(short):
    return "0000%04x-0000-1000-8000-00805f9b34fb" % short


class Failed(dbus.exceptions.DBusException):
    _dbus_error_name = "org.bluez.Error.Failed"


class Application(dbus.service.Object):
    def __init__(self, bus):
        self.services = []
        dbus.service.Object.__init__(self, bus, ROOT)

    @dbus.service.method(OM, out_signature="a{oa{sa{sv}}}")
    def GetManagedObjects(self):
        out = {}
        for s in self.services:
            out[s.path] = s.props()
            for c in s.chars:
                out[c.path] = c.props()
                for d in c.descs:
                    out[d.path] = d.props()
        return out


class Service(dbus.service.Object):
    def __init__(self, bus, index, short):
        self.path = "%s/service%d" % (ROOT, index)
        self.uuid = uuid16(short)
        self.chars = []
        dbus.service.Object.__init__(self, bus, self.path)

    def props(self):
        return {SERVICE: {"UUID": self.uuid, "Primary": True, "Characteristics": dbus.Array([c.path for c in self.chars], signature="o")}}

    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return self.props().get(interface, {})


class Characteristic(dbus.service.Object):
    def __init__(self, bus, service, short, flags, value=b"", on_notify=None):
        self.path = "%s/char%d" % (service.path, len(service.chars))
        self.service = service
        self.uuid = uuid16(short)
        self.flags = flags
        self.value = bytes(value)
        self.descs = []
        self.notifying = False
        self.on_notify = on_notify
        dbus.service.Object.__init__(self, bus, self.path)
        service.chars.append(self)

    def props(self):
        return {CHRC: {"Service": dbus.ObjectPath(self.service.path), "UUID": self.uuid, "Flags": self.flags, "Descriptors": dbus.Array([d.path for d in self.descs], signature="o")}}

    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return self.props().get(interface, {})

    @dbus.service.method(CHRC, in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, options):
        offset = int(options.get("offset", 0))
        return dbus.Array(self.value[offset:], signature="y")

    @dbus.service.method(CHRC, in_signature="aya{sv}")
    def WriteValue(self, value, options):
        if "write" not in self.flags and "write-without-response" not in self.flags:
            raise Failed("Not writable")
        self.value = bytes(value)

    @dbus.service.method(CHRC)
    def StartNotify(self):
        self.notifying = True
        if self.on_notify:
            self.on_notify()

    @dbus.service.method(CHRC)
    def StopNotify(self):
        self.notifying = False
        if self.on_notify:
            self.on_notify()

    @dbus.service.signal(PROPS, signature="sa{sv}as")
    def PropertiesChanged(self, interface, changed, invalidated):
        pass

    def notify(self, value):
        self.value = bytes(value)
        if self.notifying:
            self.PropertiesChanged(CHRC, {"Value": dbus.Array(self.value, signature="y")}, [])


class Descriptor(dbus.service.Object):
    def __init__(self, bus, chrc, short, flags, value):
        self.path = "%s/desc%d" % (chrc.path, len(chrc.descs))
        self.chrc = chrc
        self.uuid = uuid16(short)
        self.flags = flags
        self.value = bytes(value)
        dbus.service.Object.__init__(self, bus, self.path)
        chrc.descs.append(self)

    def props(self):
        return {DESC: {"Characteristic": dbus.ObjectPath(self.chrc.path), "UUID": self.uuid, "Flags": self.flags}}

    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return self.props().get(interface, {})

    @dbus.service.method(DESC, in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, options):
        offset = int(options.get("offset", 0))
        return dbus.Array(self.value[offset:], signature="y")


class Advertisement(dbus.service.Object):
    PATH = ROOT + "/advert"

    def __init__(self, bus):
        dbus.service.Object.__init__(self, bus, self.PATH)

    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return {
            "Type": "peripheral",
            "ServiceUUIDs": dbus.Array([uuid16(0x1812)], signature="s"),
            "Appearance": dbus.UInt16(0x03C0),  # a HID device
            "LocalName": dbus.String("Hand Tracker"),
            "Discoverable": dbus.Boolean(True),
        }

    @dbus.service.method("org.bluez.LEAdvertisement1")
    def Release(self):
        pass


class Agent(dbus.service.Object):
    """Pairing without a code: a mouse has no screen to show one on."""

    PATH = ROOT + "/agent"
    IFACE = "org.bluez.Agent1"

    def __init__(self, bus):
        dbus.service.Object.__init__(self, bus, self.PATH)

    @dbus.service.method(IFACE)
    def Release(self):
        pass

    @dbus.service.method(IFACE, in_signature="os")
    def AuthorizeService(self, device, uuid):
        pass

    @dbus.service.method(IFACE, in_signature="o", out_signature="s")
    def RequestPinCode(self, device):
        return "0000"

    @dbus.service.method(IFACE, in_signature="o", out_signature="u")
    def RequestPasskey(self, device):
        return dbus.UInt32(0)

    @dbus.service.method(IFACE, in_signature="ouq")
    def DisplayPasskey(self, device, passkey, entered):
        pass

    @dbus.service.method(IFACE, in_signature="os")
    def DisplayPinCode(self, device, pincode):
        pass

    @dbus.service.method(IFACE, in_signature="ou")
    def RequestConfirmation(self, device, passkey):
        pass

    @dbus.service.method(IFACE, in_signature="o")
    def RequestAuthorization(self, device):
        pass

    @dbus.service.method(IFACE)
    def Cancel(self):
        pass


def explain(err):
    name = err.get_dbus_name() if isinstance(err, dbus.exceptions.DBusException) else ""
    text = str(err).splitlines()[0] if str(err) else name
    if "AccessDenied" in name or "NotAuthorized" in name:
        return "Linux didn't let Hand Tracker use Bluetooth: add yourself to the bluetooth group (sudo usermod -aG bluetooth $USER), then log out and in. (%s)" % text
    return text


def main():
    if len(sys.argv) < 3:
        say("error usage: bt-hid-linux.py <report map hex> <id:size,...>")
        return 1
    report_map = bytes.fromhex(sys.argv[1])
    sizes = [tuple(int(v) for v in part.split(":")) for part in sys.argv[2].split(",")]

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    objects = dbus.Interface(bus.get_object(BLUEZ, "/"), OM).GetManagedObjects()
    adapter_path = next((p for p, i in objects.items() if GATT_MANAGER in i and ADV_MANAGER in i), None)
    if not adapter_path:
        say("error This computer has no Bluetooth that can act as a device (no BlueZ adapter with LE advertising).")
        return 1
    adapter = dbus.Interface(bus.get_object(BLUEZ, adapter_path), PROPS)
    for name, value in (("Powered", True), ("Pairable", True)):
        try:
            adapter.Set(ADAPTER, name, dbus.Boolean(value))
        except dbus.exceptions.DBusException:
            pass  # (already so, or not ours to change: the advertising still works)

    app = Application(bus)
    hid = Service(bus, 0, 0x1812)
    app.services.append(hid)
    sec = ["encrypt-read"]
    Characteristic(bus, hid, 0x2A4A, ["read"] + sec, bytes([0x11, 0x01, 0x00, 0x02]))  # HID 1.11, normally connectable
    Characteristic(bus, hid, 0x2A4B, ["read"] + sec, report_map)
    Characteristic(bus, hid, 0x2A4C, ["write-without-response", "encrypt-write"])
    Characteristic(bus, hid, 0x2A4E, ["read", "write-without-response", "encrypt-read", "encrypt-write"], bytes([0x01]))

    reports = {}
    mouse_id = 2 if any(i == 2 for i, _ in sizes) else sizes[0][0]

    def say_clients():
        c = reports.get(mouse_id)
        n = 1 if c is not None and c.notifying else 0
        name = ""
        if n:
            try:
                objs = dbus.Interface(bus.get_object(BLUEZ, "/"), OM).GetManagedObjects()
                for p, i in objs.items():
                    d = i.get(DEVICE)
                    if d and d.get("Connected") and str(p).startswith(adapter_path):
                        name = str(d.get("Alias") or d.get("Name") or "")
                        break
            except dbus.exceptions.DBusException:
                pass
        say(("clients %d %s" % (n, name)).strip())

    for rid, size in sizes:
        c = Characteristic(bus, hid, 0x2A4D, ["read", "notify"] + sec, bytes(size), on_notify=say_clients if rid == mouse_id else None)
        Descriptor(bus, c, 0x2908, ["read"] + sec, bytes([rid, 0x01]))  # its report id, an input report
        reports[rid] = c

    battery = Service(bus, 1, 0x180F)
    app.services.append(battery)
    Characteristic(bus, battery, 0x2A19, ["read", "notify"], bytes([100]))
    info = Service(bus, 2, 0x180A)
    app.services.append(info)
    Characteristic(bus, info, 0x2A29, ["read"], b"Hand Tracker")
    Characteristic(bus, info, 0x2A50, ["read"], bytes([0x02, 0x09, 0x12, 0x01, 0x00, 0x01, 0x00]))  # PnP ID: USB, pid.codes

    loop = GLib.MainLoop()
    done = {"code": 0}

    def fail(message):
        say("error " + message)
        done["code"] = 1
        loop.quit()

    # Pairing without a code (if the desktop has its own agent, BlueZ may ask it instead).
    try:
        agent = Agent(bus)
        manager = dbus.Interface(bus.get_object(BLUEZ, "/org/bluez"), AGENT_MANAGER)
        manager.RegisterAgent(agent.PATH, "NoInputNoOutput")
        try:
            manager.RequestDefaultAgent(agent.PATH)
        except dbus.exceptions.DBusException:
            pass
    except dbus.exceptions.DBusException:
        pass

    registered = {"gatt": False, "adv": False}

    def maybe_ready():
        if registered["gatt"] and registered["adv"]:
            say("ready")
            say_clients()

    def gatt_ok():
        registered["gatt"] = True
        maybe_ready()

    def adv_ok():
        registered["adv"] = True
        maybe_ready()

    gatt = dbus.Interface(bus.get_object(BLUEZ, adapter_path), GATT_MANAGER)
    gatt.RegisterApplication(app, {}, reply_handler=gatt_ok, error_handler=lambda e: fail("Bluetooth wouldn't publish the mouse: " + explain(e)))
    advert = Advertisement(bus)
    advertising = dbus.Interface(bus.get_object(BLUEZ, adapter_path), ADV_MANAGER)
    advertising.RegisterAdvertisement(advert.PATH, {}, reply_handler=adv_ok, error_handler=lambda e: fail("Bluetooth wouldn't advertise the mouse: " + explain(e)))

    # stdin read straight from its file descriptor (Python's own buffering would keep lines
    # back until more arrive).
    pending = {"text": b""}

    def handle(line):
        parts = line.split()
        if parts == ["quit"]:
            return False
        if len(parts) == 3 and parts[0] == "r":
            try:
                c = reports.get(int(parts[1]))
                if c is not None:
                    c.notify(bytes.fromhex(parts[2]))
            except ValueError:
                pass
        return True

    def on_input(source, condition):
        chunk = os.read(sys.stdin.fileno(), 65536) if condition & GLib.IO_IN else b""
        if not chunk:
            loop.quit()
            return False
        pending["text"] += chunk
        *lines, pending["text"] = pending["text"].split(b"\n")
        for line in lines:
            if not handle(line.decode("ascii", "replace")):
                loop.quit()
                return False
        return True

    GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, on_input)
    loop.run()
    for undo in (lambda: advertising.UnregisterAdvertisement(advert.PATH), lambda: gatt.UnregisterApplication(app)):
        try:
            undo()
        except dbus.exceptions.DBusException:
            pass
    return done["code"]


if __name__ == "__main__":
    try:
        sys.exit(main())
    except dbus.exceptions.DBusException as err:
        say("error " + explain(err))
        sys.exit(1)
