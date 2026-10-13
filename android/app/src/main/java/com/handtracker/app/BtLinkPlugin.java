package com.handtracker.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
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

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * BtLink — Bluetooth Low Energy for the remote recording page (bt-link-client.js, which speaks
 * Hand Tracker's link over it: electron/bluetooth-link.js on the computer), for when the phone
 * can't use the computer's Bluetooth network (BtNet.java; a VPN such as Tailscale keeps apps off
 * every other network). Just what bt-link-client.js's capacitorBluetooth() needs, one device at a
 * time; each GATT step waits for the one before (Android's Bluetooth does one at a time):
 *
 *   scan({ service, ms }) -> { devices: [{ id, name }] }   devices near by offering the service
 *   connect({ id }) -> { mtu }            connected, its services found
 *   read({ id, characteristic }) -> { value }   (base64)
 *   write({ id, characteristic, value })  with a response
 *   notify({ id, characteristic })        its notifications on: "notifications" { id, characteristic, values }
 *                                         (those that came within NOTIFY_BATCH_MS of each other, in order)
 *   disconnect({ id })                    "disconnected" { id } (also when the computer goes)
 */
@SuppressLint("MissingPermission")
@CapacitorPlugin(
    name = "BtLink",
    permissions = {
        @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT }),
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION }),
    }
)
public class BtLinkPlugin extends Plugin {
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final int CONNECT_MS = 15000;
    private static final int STEP_MS = 10000;
    // Notifications go to the page together: a picture is ~200 of them, each its own hand-off
    // to the page otherwise.
    private static final int NOTIFY_BATCH_MS = 10;
    private static final int NOTIFY_BATCH_MAX = 64;

    private final Handler main = new Handler(Looper.getMainLooper());
    private BluetoothGatt gatt;
    private String gattId = "";
    private int mtu = 23;
    private PluginCall connecting;
    // The GATT step under way, and those waiting for it.
    private PluginCall step;
    private final ArrayDeque<Step> steps = new ArrayDeque<>();
    private Runnable stepTimeout;
    // Notifications not yet passed to the page ({ characteristic, base64 }), from Bluetooth's thread.
    private final ArrayList<String[]> notified = new ArrayList<>();
    private boolean notifyQueued;

    private BluetoothAdapter adapter() {
        BluetoothManager bm = getContext().getSystemService(BluetoothManager.class);
        return bm == null ? null : bm.getAdapter();
    }

    private String alias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? "bluetooth" : "location";
    }

    // ---------- finding it ----------
    @PluginMethod
    public void scan(PluginCall call) {
        if (getPermissionState(alias()) != PermissionState.GRANTED) {
            requestPermissionForAlias(alias(), call, "afterPermission");
            return;
        }
        scanNow(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        if (getPermissionState(alias()) == PermissionState.GRANTED) scanNow(call);
        else call.reject("Hand Tracker needs the Nearby devices permission to use Bluetooth.");
    }

    private void scanNow(PluginCall call) {
        BluetoothAdapter a = adapter();
        if (a == null) {
            call.reject("This phone has no Bluetooth.");
            return;
        }
        if (!a.isEnabled()) {
            call.reject("Turn Bluetooth on, then try again.");
            return;
        }
        BluetoothLeScanner scanner = a.getBluetoothLeScanner();
        if (scanner == null) {
            call.reject("Turn Bluetooth on, then try again.");
            return;
        }
        String service = call.getString("service", "");
        int ms = Math.max(1000, Math.min(15000, call.getInt("ms", 4000)));
        Map<String, String> found = Collections.synchronizedMap(new LinkedHashMap<>());
        // (Whether it takes connections: a computer can be seen advertising but not answer.)
        Map<String, Boolean> connectable = Collections.synchronizedMap(new LinkedHashMap<>());
        ScanCallback cb = new ScanCallback() {
            @Override
            public void onScanResult(int type, ScanResult r) {
                String name = r.getScanRecord() != null ? r.getScanRecord().getDeviceName() : null;
                if (name == null) {
                    try {
                        name = r.getDevice().getName();
                    } catch (Exception ignored) {
                        // (no name)
                    }
                }
                String id = r.getDevice().getAddress();
                if (name != null || !found.containsKey(id)) found.put(id, name == null ? "" : name);
                if (!Boolean.TRUE.equals(connectable.get(id))) connectable.put(id, r.isConnectable());
            }
        };
        try {
            scanner.startScan(Collections.singletonList(new ScanFilter.Builder().setServiceUuid(ParcelUuid.fromString(service)).build()),
                    new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), cb);
        } catch (Exception e) {
            call.reject("Bluetooth: " + e.getMessage());
            return;
        }
        main.postDelayed(() -> {
            try {
                scanner.stopScan(cb);
            } catch (Exception ignored) {
                // (Bluetooth turned off meanwhile)
            }
            JSArray list = new JSArray();
            synchronized (found) {
                for (Map.Entry<String, String> e : found.entrySet()) {
                    JSObject d = new JSObject();
                    d.put("id", e.getKey());
                    d.put("name", e.getValue());
                    d.put("connectable", !Boolean.FALSE.equals(connectable.get(e.getKey())));
                    list.put(d);
                }
            }
            JSObject ret = new JSObject();
            ret.put("devices", list);
            call.resolve(ret);
        }, ms);
    }

    // ---------- connected ----------
    private final BluetoothGattCallback callback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int state) {
            main.post(() -> {
                if (g != gatt) return;
                if (state == BluetoothProfile.STATE_CONNECTED && connecting != null) {
                    if (!g.requestMtu(247)) g.discoverServices();
                } else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                    gone("The Bluetooth connection ended.");
                }
            });
        }

        @Override
        public void onMtuChanged(BluetoothGatt g, int newMtu, int status) {
            main.post(() -> {
                if (g != gatt) return;
                if (status == BluetoothGatt.GATT_SUCCESS) mtu = newMtu;
                if (connecting != null) g.discoverServices();
            });
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            main.post(() -> {
                if (g != gatt || connecting == null) return;
                PluginCall c = connecting;
                connecting = null;
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    c.reject("Its Bluetooth services weren't found.");
                    close();
                    return;
                }
                // Bluetooth 5's 2M radio mode where both ends can (a Raspberry Pi's is LE 1M only).
                // Not its quick timing: a Pi's Bluetooth sends ~7 packets a turn, and 7.5 ms turns
                // halved what it carried (15-37.5 ms all carried ~50 KB a second).
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) g.setPreferredPhy(BluetoothDevice.PHY_LE_2M_MASK, BluetoothDevice.PHY_LE_2M_MASK, BluetoothDevice.PHY_OPTION_NO_PREFERRED);
                JSObject ret = new JSObject();
                ret.put("mtu", mtu);
                c.resolve(ret);
            });
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic ch, byte[] value, int status) {
            main.post(() -> stepDone(status, value));
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic ch, int status) {
            byte[] value = ch.getValue();
            main.post(() -> stepDone(status, value));
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic ch, int status) {
            main.post(() -> stepDone(status, null));
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) {
            main.post(() -> stepDone(status, null));
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic ch, byte[] value) {
            changed(ch, value);
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic ch) {
            changed(ch, ch.getValue());
        }

        private void changed(BluetoothGattCharacteristic ch, byte[] value) {
            String[] n = { ch.getUuid().toString(), Base64.encodeToString(value == null ? new byte[0] : value, Base64.NO_WRAP) };
            synchronized (notified) {
                notified.add(n);
                if (notified.size() >= NOTIFY_BATCH_MAX) main.post(BtLinkPlugin.this::passNotifications);
                else if (!notifyQueued) main.postDelayed(BtLinkPlugin.this::passNotifications, NOTIFY_BATCH_MS);
                notifyQueued = true;
            }
        }
    };

    // The notifications waiting, to the page: one "notifications" per characteristic in a row.
    private void passNotifications() {
        ArrayList<String[]> now;
        synchronized (notified) {
            notifyQueued = false;
            if (notified.isEmpty()) return;
            now = new ArrayList<>(notified);
            notified.clear();
        }
        for (int at = 0; at < now.size(); ) {
            String ch = now.get(at)[0];
            JSArray values = new JSArray();
            for (; at < now.size() && now.get(at)[0].equals(ch); at++) values.put(now.get(at)[1]);
            JSObject ev = new JSObject();
            ev.put("id", gattId);
            ev.put("characteristic", ch);
            ev.put("values", values);
            notifyListeners("notifications", ev);
        }
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String id = call.getString("id", "");
        BluetoothAdapter a = adapter();
        if (a == null || !BluetoothAdapter.checkBluetoothAddress(id)) {
            call.reject("That isn't a Bluetooth device.");
            return;
        }
        main.post(() -> {
            close();
            synchronized (notified) {
                notified.clear();
            }
            gattId = id;
            mtu = 23;
            connecting = call;
            try {
                gatt = a.getRemoteDevice(id).connectGatt(getContext(), false, callback, BluetoothDevice.TRANSPORT_LE);
            } catch (Exception e) {
                connecting = null;
                call.reject("Bluetooth: " + e.getMessage());
                return;
            }
            main.postDelayed(() -> {
                if (connecting == call) {
                    connecting = null;
                    call.reject("It didn't answer over Bluetooth.");
                    close();
                }
            }, CONNECT_MS);
        });
    }

    private BluetoothGattCharacteristic characteristic(PluginCall call) {
        if (gatt == null || !gattId.equals(call.getString("id", ""))) return null;
        UUID uuid;
        try {
            uuid = UUID.fromString(call.getString("characteristic", ""));
        } catch (IllegalArgumentException e) {
            return null;
        }
        for (BluetoothGattService s : gatt.getServices()) {
            BluetoothGattCharacteristic ch = s.getCharacteristic(uuid);
            if (ch != null) return ch;
        }
        return null;
    }

    // One GATT step at a time: start.run() begins it (false: it couldn't), stepDone() ends it.
    private interface Start {
        boolean run();
    }

    private static final class Step {
        final PluginCall call;
        final Start start;

        Step(PluginCall call, Start start) {
            this.call = call;
            this.start = start;
        }
    }

    private void queue(PluginCall call, Start start) {
        main.post(() -> {
            steps.add(new Step(call, start));
            if (step == null) next();
        });
    }

    private void next() {
        Step s = steps.poll();
        if (s == null) return;
        step = s.call;
        boolean ok;
        try {
            ok = s.start.run();
        } catch (Exception e) {
            ok = false;
        }
        if (!ok) stepDone(-1, null);
        else {
            PluginCall c = s.call;
            stepTimeout = () -> {
                if (step == c) stepDone(-2, null);
            };
            main.postDelayed(stepTimeout, STEP_MS);
        }
    }

    private void stepDone(int status, byte[] value) {
        PluginCall c = step;
        if (c == null) return;
        step = null;
        if (stepTimeout != null) main.removeCallbacks(stepTimeout);
        if (status == BluetoothGatt.GATT_SUCCESS) {
            JSObject ret = new JSObject();
            if (value != null) ret.put("value", Base64.encodeToString(value, Base64.NO_WRAP));
            c.resolve(ret);
        } else {
            c.reject(status == -2 ? "No answer over Bluetooth." : "Bluetooth didn't do that (" + status + ").");
        }
        next();
    }

    @PluginMethod
    public void read(PluginCall call) {
        BluetoothGattCharacteristic ch = characteristic(call);
        if (ch == null) {
            call.reject("Not connected.");
            return;
        }
        queue(call, () -> gatt.readCharacteristic(ch));
    }

    @PluginMethod
    @SuppressWarnings("deprecation")
    public void write(PluginCall call) {
        BluetoothGattCharacteristic ch = characteristic(call);
        if (ch == null) {
            call.reject("Not connected.");
            return;
        }
        byte[] value = Base64.decode(call.getString("value", ""), Base64.DEFAULT);
        queue(call, () -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                return gatt.writeCharacteristic(ch, value, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothGatt.GATT_SUCCESS;
            }
            ch.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            ch.setValue(value);
            return gatt.writeCharacteristic(ch);
        });
    }

    @PluginMethod
    @SuppressWarnings("deprecation")
    public void notify(PluginCall call) {
        BluetoothGattCharacteristic ch = characteristic(call);
        BluetoothGattDescriptor d = ch == null ? null : ch.getDescriptor(CCCD);
        if (d == null) {
            call.reject("Not connected.");
            return;
        }
        queue(call, () -> {
            if (!gatt.setCharacteristicNotification(ch, true)) return false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                return gatt.writeDescriptor(d, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothGatt.GATT_SUCCESS;
            }
            d.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
            return gatt.writeDescriptor(d);
        });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        main.post(() -> {
            if (gatt != null && gattId.equals(call.getString("id", ""))) gone(null);
            call.resolve();
        });
    }

    // The connection's over (why: for what was waiting on it).
    private void gone(String why) {
        passNotifications(); // (what came before it ended)
        String id = gattId;
        if (connecting != null) {
            connecting.reject(why == null ? "Disconnected." : why);
            connecting = null;
        }
        if (step != null) {
            PluginCall c = step;
            step = null;
            c.reject(why == null ? "Disconnected." : why);
        }
        for (Step s; (s = steps.poll()) != null; ) s.call.reject(why == null ? "Disconnected." : why);
        boolean was = gatt != null;
        close();
        if (was) {
            JSObject ev = new JSObject();
            ev.put("id", id);
            notifyListeners("disconnected", ev);
        }
    }

    private void close() {
        if (gatt != null) {
            try {
                gatt.disconnect();
                gatt.close();
            } catch (Exception ignored) {
                // (gone already)
            }
        }
        gatt = null;
    }

    @Override
    protected void handleOnDestroy() {
        main.post(this::close);
    }
}
