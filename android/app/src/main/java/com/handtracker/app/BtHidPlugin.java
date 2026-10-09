package com.handtracker.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothHidDevice;
import android.bluetooth.BluetoothHidDeviceAppSdpSettings;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.Intent;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * BtHid — this phone as a Bluetooth mouse and keyboard for another device, an iPhone or iPad
 * most of all (its pointer needs AssistiveTouch on), with Android's own Bluetooth HID device
 * (Android 9 and later). The page makes the reports (hid-core.js) and the hand mouse, gesture
 * actions and keys send them through here (mobile-bridge.js).
 *
 *   start({ map })                 the HID report descriptor (base64): registers, asks to be
 *                                  visible for a few minutes -> { state, device, message }
 *   send({ id, data })             a report (base64) to the device connected -> { sent }
 *   devices() -> { devices: [{ name, address }] }   the paired ones
 *   connect({ address })           to a paired device (it can also connect from its side)
 *   visible()                      asks to be visible again (to pair a new device)
 *   status() / stop()
 *   "status" events { state: "off" | "starting" | "waiting" | "connected" | "error", device, message }
 */
@SuppressLint("MissingPermission")
@CapacitorPlugin(
    name = "BtHid",
    permissions = {
        @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_ADVERTISE }),
    }
)
public class BtHidPlugin extends Plugin {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private BluetoothAdapter adapter;
    private BluetoothHidDevice hid;
    private BluetoothDevice host; // the device connected to us
    private byte[] reportMap;
    private PluginCall pendingStart;
    private String state = "off", device = "", message = "";

    private JSObject status() {
        JSObject s = new JSObject();
        s.put("state", state);
        s.put("device", device);
        s.put("message", message);
        return s;
    }

    private void setState(String st, String dev, String msg) {
        state = st;
        device = dev == null ? "" : dev;
        message = msg == null ? "" : msg;
        notifyListeners("status", status());
    }

    private static String nameOf(BluetoothDevice d) {
        try {
            String n = d.getName();
            return n != null ? n : d.getAddress();
        } catch (Exception e) {
            return "";
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            call.reject("Being a Bluetooth mouse needs Android 9 or later.");
            return;
        }
        String map = call.getString("map", "");
        if (map.isEmpty()) {
            call.reject("No report descriptor.");
            return;
        }
        reportMap = Base64.decode(map, Base64.DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && getPermissionState("bluetooth") != PermissionState.GRANTED) {
            requestPermissionForAlias("bluetooth", call, "afterPermission");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        if (getPermissionState("bluetooth") == PermissionState.GRANTED) begin(call);
        else {
            setState("error", "", "Hand Tracker needs the Nearby devices permission to be a Bluetooth mouse.");
            call.reject(message);
        }
    }

    private void begin(PluginCall call) {
        BluetoothManager bm = getContext().getSystemService(BluetoothManager.class);
        adapter = bm != null ? bm.getAdapter() : null;
        if (adapter == null) {
            setState("error", "", "This phone has no Bluetooth.");
            call.reject(message);
            return;
        }
        if (!adapter.isEnabled()) {
            setState("error", "", "Turn Bluetooth on, then try again.");
            call.reject(message);
            return;
        }
        if (hid != null && !"off".equals(state) && !"error".equals(state)) {
            call.resolve(status());
            return;
        }
        pendingStart = call;
        setState("starting", "", "");
        boolean ok = adapter.getProfileProxy(getContext(), new BluetoothProfile.ServiceListener() {
            @Override
            public void onServiceConnected(int profile, BluetoothProfile proxy) {
                hid = (BluetoothHidDevice) proxy;
                BluetoothHidDeviceAppSdpSettings sdp = new BluetoothHidDeviceAppSdpSettings(
                    "Hand Tracker", "Hand Tracker's hand mouse and keyboard", "Hand Tracker", BluetoothHidDevice.SUBCLASS1_COMBO, reportMap);
                if (!hid.registerApp(sdp, null, null, executor, callback)) fail("Android wouldn't let Hand Tracker be a Bluetooth mouse (another app may be one already).");
            }

            @Override
            public void onServiceDisconnected(int profile) {
                hid = null;
                host = null;
                setState("off", "", "");
            }
        }, BluetoothProfile.HID_DEVICE);
        if (!ok) fail("This phone's Bluetooth can't be a mouse (no HID device profile).");
    }

    private void fail(String msg) {
        setState("error", "", msg);
        PluginCall c = pendingStart;
        pendingStart = null;
        if (c != null) c.reject(msg);
    }

    private final BluetoothHidDevice.Callback callback = new BluetoothHidDevice.Callback() {
        @Override
        public void onAppStatusChanged(BluetoothDevice plugged, boolean registered) {
            if (!registered) {
                host = null;
                if (!"error".equals(state)) setState("off", "", "");
                return;
            }
            setState("waiting", "", "");
            askVisible();
            PluginCall c = pendingStart;
            pendingStart = null;
            if (c != null) c.resolve(status());
            if (plugged != null && hid != null) hid.connect(plugged); // the device last used
        }

        @Override
        public void onConnectionStateChanged(BluetoothDevice d, int st) {
            if (st == BluetoothProfile.STATE_CONNECTED) {
                host = d;
                setState("connected", nameOf(d), "");
            } else if (st == BluetoothProfile.STATE_DISCONNECTED && (host == null || host.equals(d))) {
                host = null;
                if (hid != null) setState("waiting", "", "");
            }
        }

        @Override
        public void onGetReport(BluetoothDevice d, byte type, byte id, int bufferSize) {
            int size = id == 1 ? 8 : id == 2 ? 4 : id == 3 ? 2 : 0;
            if (hid == null) return;
            if (size == 0) hid.reportError(d, BluetoothHidDevice.ERROR_RSP_INVALID_RPT_ID);
            else hid.replyReport(d, type, id, new byte[size]);
        }
    };

    // Visible to devices looking for one, for five minutes (Android asks first).
    private void askVisible() {
        if (getActivity() == null) return;
        Intent i = new Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE);
        i.putExtra(BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION, 300);
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startActivity(i);
            } catch (Exception e) {
                // (pairing from this phone's own Bluetooth settings still works)
            }
        });
    }

    @PluginMethod
    public void visible(PluginCall call) {
        askVisible();
        call.resolve(status());
    }

    @PluginMethod
    public void send(PluginCall call) {
        Integer id = call.getInt("id");
        String data = call.getString("data", "");
        JSObject ret = new JSObject();
        BluetoothHidDevice h = hid;
        BluetoothDevice d = host;
        if (h == null || d == null || id == null) {
            ret.put("sent", false);
            call.resolve(ret);
            return;
        }
        ret.put("sent", h.sendReport(d, id, Base64.decode(data, Base64.DEFAULT)));
        call.resolve(ret);
    }

    @PluginMethod
    public void devices(PluginCall call) {
        JSArray list = new JSArray();
        try {
            if (adapter != null) {
                for (BluetoothDevice d : adapter.getBondedDevices()) {
                    JSObject o = new JSObject();
                    o.put("name", nameOf(d));
                    o.put("address", d.getAddress());
                    list.put(o);
                }
            }
        } catch (Exception e) {
            // (no permission yet)
        }
        JSObject ret = new JSObject();
        ret.put("devices", list);
        call.resolve(ret);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String address = call.getString("address", "");
        if (hid == null || adapter == null || !BluetoothAdapter.checkBluetoothAddress(address)) {
            call.reject("Start being a Bluetooth mouse first.");
            return;
        }
        if (!hid.connect(adapter.getRemoteDevice(address))) {
            call.reject("Couldn't connect to it: is it nearby, with Bluetooth on?");
            return;
        }
        call.resolve(status());
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(status());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        BluetoothHidDevice h = hid;
        hid = null;
        host = null;
        if (h != null) {
            try {
                h.unregisterApp();
            } catch (Exception e) {
                // (already gone)
            }
            if (adapter != null) adapter.closeProfileProxy(BluetoothProfile.HID_DEVICE, h);
        }
        setState("off", "", "");
        call.resolve(status());
    }
}
