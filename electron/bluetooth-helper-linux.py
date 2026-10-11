#!/usr/bin/env python3
# bluetooth-helper-linux.py: Hand Tracker's Bluetooth link on Linux (BlueZ, over D-Bus; a
# Raspberry Pi's): the GATT service remote recording is reached by over Bluetooth Low Energy
# (electron/bluetooth-link.js says what goes over it; this only carries its frames), advertised
# by name, and pairing accepted from any device (with no screen here to confirm it on; the
# password is what keeps others out, checked by bluetooth-link.js), so an Android phone can join
# the Pi's Bluetooth network (pi/bluetooth-setup.sh). Only Python's own library, dbus and
# GLib (python3-dbus, python3-gi, both in Raspberry Pi OS). electron/bluetooth.js runs it; a JSON
# line each way:
#
#   in:  {"t":"start","name":N,"service":U,"info":U,"rx":U,"tx":U}   register the service, advertise as N
#        {"t":"info","data":B64}      INFO's value
#        {"t":"tx","data":B64}        a notification on TX
#   out: {"t":"ready","address":A,"network":N}   registered and advertising (A: this computer's
#                                     Bluetooth address; N: its Bluetooth network offered to phones)
#        {"t":"rx","dev":D,"mtu":M,"data":B64}   a device wrote a frame
#        {"t":"gone","dev":D}         a device disconnected
#        {"t":"error","message":S}
#
# It exits (its service and advertisement going with it) when its input closes.

import base64
import json
import os
import sys
import threading

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

BLUEZ = "org.bluez"
PROPS = "org.freedesktop.DBus.Properties"
OM = "org.freedesktop.DBus.ObjectManager"
ROOT = "/com/handtracker/link"
BRIDGE = "htbt0"  # the Bluetooth network's bridge (pi/bluetooth-setup.sh), offered to phones (NAP)


def say(**msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


class Characteristic(dbus.service.Object):
    def __init__(self, bus, path, uuid, service, flags, on_write=None):
        self.path, self.uuid, self.service, self.flags = path, uuid, service, flags
        self.value = b""
        self.on_write = on_write
        self.notifying = False
        super().__init__(bus, path)

    def props(self):
        return {"org.bluez.GattCharacteristic1": {"UUID": self.uuid, "Service": dbus.ObjectPath(self.service), "Flags": dbus.Array(self.flags, signature="s")}}

    @dbus.service.method("org.bluez.GattCharacteristic1", in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, options):
        off = int(options.get("offset", 0))
        return dbus.Array(self.value[off:], signature="y")

    @dbus.service.method("org.bluez.GattCharacteristic1", in_signature="aya{sv}")
    def WriteValue(self, value, options):
        if self.on_write:
            self.on_write(bytes(value), str(options.get("device", "")), int(options.get("mtu", 23)))

    @dbus.service.method("org.bluez.GattCharacteristic1")
    def StartNotify(self):
        self.notifying = True

    @dbus.service.method("org.bluez.GattCharacteristic1")
    def StopNotify(self):
        self.notifying = False

    @dbus.service.signal(PROPS, signature="sa{sv}as")
    def PropertiesChanged(self, interface, changed, invalidated):
        pass

    def notify(self, data):
        self.PropertiesChanged("org.bluez.GattCharacteristic1", {"Value": dbus.Array(data, signature="y")}, [])

    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return self.props().get(interface, {})


class Service(dbus.service.Object):
    def __init__(self, bus, path, uuid):
        self.path, self.uuid = path, uuid
        self.chars = []
        super().__init__(bus, path)

    def props(self):
        return {"org.bluez.GattService1": {"UUID": self.uuid, "Primary": True}}

    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return self.props().get(interface, {})


class Application(dbus.service.Object):
    def __init__(self, bus, path, service):
        self.service = service
        super().__init__(bus, path)

    @dbus.service.method(OM, out_signature="a{oa{sa{sv}}}")
    def GetManagedObjects(self):
        out = {dbus.ObjectPath(self.service.path): self.service.props()}
        for c in self.service.chars:
            out[dbus.ObjectPath(c.path)] = c.props()
        return out


class Advertisement(dbus.service.Object):
    def __init__(self, bus, path, uuid, name):
        self.uuid, self.name = uuid, name
        super().__init__(bus, path)

    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        props = {"Type": "peripheral", "ServiceUUIDs": dbus.Array([self.uuid], signature="s"), "Discoverable": dbus.Boolean(True)}
        if self.name:
            props["LocalName"] = dbus.String(self.name)
        return props

    @dbus.service.method("org.bluez.LEAdvertisement1")
    def Release(self):
        pass


class Agent(dbus.service.Object):
    """Pairing from any device, without a screen here: accepted (and the device trusted, so it
    reconnects by itself). What a device may do once it's in is up to the password."""

    def __init__(self, bus, path):
        self.bus = bus
        super().__init__(bus, path)

    def trust(self, device):
        try:
            dbus.Interface(self.bus.get_object(BLUEZ, device), PROPS).Set("org.bluez.Device1", "Trusted", dbus.Boolean(True))
        except dbus.DBusException:
            pass

    @dbus.service.method("org.bluez.Agent1")
    def Release(self):
        pass

    @dbus.service.method("org.bluez.Agent1", in_signature="o", out_signature="s")
    def RequestPinCode(self, device):
        self.trust(device)
        return "0000"

    @dbus.service.method("org.bluez.Agent1", in_signature="o", out_signature="u")
    def RequestPasskey(self, device):
        self.trust(device)
        return dbus.UInt32(0)

    @dbus.service.method("org.bluez.Agent1", in_signature="ouq")
    def DisplayPasskey(self, device, passkey, entered):
        pass

    @dbus.service.method("org.bluez.Agent1", in_signature="os")
    def DisplayPinCode(self, device, code):
        pass

    @dbus.service.method("org.bluez.Agent1", in_signature="ou")
    def RequestConfirmation(self, device, passkey):
        self.trust(device)

    @dbus.service.method("org.bluez.Agent1", in_signature="o")
    def RequestAuthorization(self, device):
        self.trust(device)

    @dbus.service.method("org.bluez.Agent1", in_signature="os")
    def AuthorizeService(self, device, uuid):
        pass

    @dbus.service.method("org.bluez.Agent1")
    def Cancel(self):
        pass


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    loop = GLib.MainLoop()
    state = {"tx": None, "info": None, "app": None, "adv": None}

    adapter = None
    for path, ifaces in dbus.Interface(bus.get_object(BLUEZ, "/"), OM).GetManagedObjects().items():
        if "org.bluez.GattManager1" in ifaces and "org.bluez.LEAdvertisingManager1" in ifaces:
            adapter = path
            break
    if not adapter:
        say(t="error", message="This computer has no Bluetooth that can be reached over Bluetooth Low Energy.")
        return 2
    obj = bus.get_object(BLUEZ, adapter)
    props = dbus.Interface(obj, PROPS)

    def setp(name, value):
        try:
            props.Set("org.bluez.Adapter1", name, value)
        except dbus.DBusException as err:
            say(t="error", message=f"Bluetooth {name}: {err.get_dbus_message()}")

    def start(msg):
        setp("Powered", dbus.Boolean(True))
        setp("PairableTimeout", dbus.UInt32(0))
        setp("Pairable", dbus.Boolean(True))
        setp("DiscoverableTimeout", dbus.UInt32(0))
        setp("Discoverable", dbus.Boolean(True))
        agent = Agent(bus, ROOT + "/agent")
        manager = dbus.Interface(bus.get_object(BLUEZ, "/org/bluez"), "org.bluez.AgentManager1")
        try:
            manager.RegisterAgent(agent, "NoInputNoOutput")
            manager.RequestDefaultAgent(agent)
        except dbus.DBusException as err:
            say(t="error", message=f"Bluetooth pairing: {err.get_dbus_message()}")

        service = Service(bus, ROOT + "/service0", msg["service"])
        info = Characteristic(bus, ROOT + "/service0/info", msg["info"], service.path, ["read"])
        rx = Characteristic(bus, ROOT + "/service0/rx", msg["rx"], service.path, ["write", "write-without-response"],
                            on_write=lambda data, dev, mtu: say(t="rx", dev=dev, mtu=mtu, data=base64.b64encode(data).decode()))
        tx = Characteristic(bus, ROOT + "/service0/tx", msg["tx"], service.path, ["notify"])
        service.chars = [info, rx, tx]
        state.update(tx=tx, info=info)
        if state.get("pending_info") is not None:
            info.value = state.pop("pending_info")
        app = Application(bus, ROOT, service)
        adv = Advertisement(bus, ROOT + "/adv0", msg["service"], str(msg.get("name") or "")[:12])
        state.update(app=app, adv=adv)
        gatt = dbus.Interface(obj, "org.bluez.GattManager1")
        advm = dbus.Interface(obj, "org.bluez.LEAdvertisingManager1")
        address = str(props.Get("org.bluez.Adapter1", "Address"))
        # The Bluetooth network for Android phones (they join it once paired): the bridge root made,
        # offered by BlueZ, which puts each phone's link on it.
        if os.path.exists(f"/sys/class/net/{BRIDGE}"):
            try:
                dbus.Interface(obj, "org.bluez.NetworkServer1").Register("nap", BRIDGE)
                state["nap"] = True
            except dbus.DBusException as err:
                say(t="error", message=f"Bluetooth network: {err.get_dbus_message()}")

        def registered():
            advm.RegisterAdvertisement(adv.__dbus_object_path__, {}, reply_handler=lambda: say(t="ready", address=address, network=bool(state.get("nap"))),
                                       error_handler=lambda e: retry_adv(e))

        def retry_adv(err):
            # (A name too long for the advertisement: without it; the service is what's looked for.)
            if adv.name:
                adv.name = ""
                registered()
            else:
                say(t="error", message=f"Bluetooth advertising: {err.get_dbus_message()}")

        gatt.RegisterApplication(app.__dbus_object_path__, {}, reply_handler=registered,
                                 error_handler=lambda e: say(t="error", message=f"Bluetooth service: {e.get_dbus_message()}"))

    def device_changed(interface, changed, invalidated, path=None):
        if interface == "org.bluez.Device1" and changed.get("Connected") is False:
            say(t="gone", dev=str(path))

    bus.add_signal_receiver(device_changed, dbus_interface=PROPS, signal_name="PropertiesChanged", path_keyword="path", arg0="org.bluez.Device1")

    def handle(line):
        try:
            msg = json.loads(line)
            t = msg.get("t")
            if t == "start":
                start(msg)
            elif t == "info":
                data = base64.b64decode(msg.get("data", ""))
                if state["info"]:
                    state["info"].value = data
                else:
                    state["pending_info"] = data
            elif t == "tx" and state["tx"]:
                state["tx"].notify(base64.b64decode(msg.get("data", "")))
        except (ValueError, KeyError, dbus.DBusException) as err:
            say(t="error", message=str(err))
        return False

    def read_input():
        for line in sys.stdin:
            if line.strip():
                GLib.idle_add(handle, line)
        GLib.idle_add(loop.quit)

    threading.Thread(target=read_input, daemon=True).start()
    try:
        loop.run()
    finally:
        try:
            if state["adv"]:
                dbus.Interface(obj, "org.bluez.LEAdvertisingManager1").UnregisterAdvertisement(state["adv"])
            if state["app"]:
                dbus.Interface(obj, "org.bluez.GattManager1").UnregisterApplication(state["app"])
            if state.get("nap"):
                dbus.Interface(obj, "org.bluez.NetworkServer1").Unregister("nap")
        except dbus.DBusException:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
