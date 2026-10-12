package com.handtracker.app;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.content.Context;
import android.os.Build;
import android.os.ParcelUuid;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * BtRigLink — remote recording on this phone over Bluetooth Low Energy: another phone, the
 * website or a computer that can't reach it over a network reaches its remote recording page
 * (RigServerPlugin) over Bluetooth instead. The link is electron/bluetooth-link.js's, word for
 * word: a GATT service of its own (INFO / RX / TX) here, what goes over it in BtRigProtocol.java
 * (read bluetooth-link.js for it). Each request is handed to RigServerPlugin as one from a phone
 * it trusts (the password was the proof); its answer goes back the same way.
 *
 *   new BtRigLink(context, name, secret (BtRigProtocol.Secret), relay)
 *     relay.handle(method, path, body) -> BtRigProtocol.Answer
 *   makeSecret(password); start() -> null or why not; stop(); on()
 */
@SuppressLint("MissingPermission")
final class BtRigLink {
    static final UUID SERVICE = UUID.fromString("48540001-6c69-6e6b-8000-68616e647472");
    static final UUID INFO = UUID.fromString("48540002-6c69-6e6b-8000-68616e647472");
    static final UUID RX = UUID.fromString("48540003-6c69-6e6b-8000-68616e647472");
    static final UUID TX = UUID.fromString("48540004-6c69-6e6b-8000-68616e647472");
    static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private final Context ctx;
    private final BtRigProtocol link;

    BtRigLink(Context ctx, String name, BtRigProtocol.Secret secret, BtRigProtocol.Relay relay) {
        this.ctx = ctx.getApplicationContext();
        this.link = new BtRigProtocol(name, secret, relay, this::send);
    }

    // The password's key (as bluetooth-link.js makeSecret), its salt in base64 as INFO gives it.
    static BtRigProtocol.Secret makeSecret(String password) throws Exception {
        byte[] salt = new byte[16];
        BtRigProtocol.RANDOM.nextBytes(salt);
        return new BtRigProtocol.Secret(android.util.Base64.encodeToString(salt, android.util.Base64.NO_WRAP), BtRigProtocol.ITERATIONS,
                BtRigProtocol.pbkdf2(password.getBytes(StandardCharsets.UTF_8), salt, BtRigProtocol.ITERATIONS));
    }

    // ---------- Bluetooth: the GATT service and its advertising ----------
    private BluetoothGattServer server;
    private BluetoothGattCharacteristic tx;
    private BluetoothLeAdvertiser advertiser;
    private final Set<BluetoothDevice> listening = ConcurrentHashMap.newKeySet();
    private final Map<String, Integer> mtus = new ConcurrentHashMap<>();
    private final Set<String> used = ConcurrentHashMap.newKeySet(); // devices that read or wrote this service
    private final ArrayDeque<byte[]> outbox = new ArrayDeque<>();
    private final ArrayDeque<BluetoothDevice> sendingTo = new ArrayDeque<>();
    private boolean sending = false;
    private volatile boolean on = false;

    boolean on() {
        return on;
    }

    private final AdvertiseCallback advertised = new AdvertiseCallback() {
        @Override
        public void onStartSuccess(AdvertiseSettings settingsInEffect) {
            on = true;
        }

        @Override
        public void onStartFailure(int errorCode) {
            // (A name too long to fit: without it; the service is what's looked for.)
            if (errorCode == ADVERTISE_FAILED_DATA_TOO_LARGE && advertiser != null) advertise(false);
        }
    };

    private void advertise(boolean withName) {
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                .setConnectable(true)
                .setTimeout(0)
                .build();
        AdvertiseData data = new AdvertiseData.Builder().addServiceUuid(new ParcelUuid(SERVICE)).setIncludeDeviceName(false).build();
        AdvertiseData scan = new AdvertiseData.Builder().setIncludeDeviceName(withName).build();
        advertiser.startAdvertising(settings, data, scan, advertised);
    }

    // null when it's on, or why it isn't.
    String start() {
        BluetoothManager bm = ctx.getSystemService(BluetoothManager.class);
        BluetoothAdapter adapter = bm == null ? null : bm.getAdapter();
        if (adapter == null) return "This phone has no Bluetooth.";
        if (!adapter.isEnabled()) return "Turn Bluetooth on.";
        advertiser = adapter.getBluetoothLeAdvertiser();
        if (advertiser == null) return "This phone's Bluetooth can't be reached over Bluetooth Low Energy.";
        server = bm.openGattServer(ctx, callback);
        if (server == null) return "Bluetooth didn't start.";
        BluetoothGattService service = new BluetoothGattService(SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY);
        service.addCharacteristic(new BluetoothGattCharacteristic(INFO, BluetoothGattCharacteristic.PROPERTY_READ, BluetoothGattCharacteristic.PERMISSION_READ));
        service.addCharacteristic(new BluetoothGattCharacteristic(RX, BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE, BluetoothGattCharacteristic.PERMISSION_WRITE));
        tx = new BluetoothGattCharacteristic(TX, BluetoothGattCharacteristic.PROPERTY_NOTIFY, BluetoothGattCharacteristic.PERMISSION_READ);
        tx.addDescriptor(new BluetoothGattDescriptor(CCCD, BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE));
        service.addCharacteristic(tx);
        if (!server.addService(service)) {
            stop();
            return "Bluetooth's service didn't start.";
        }
        advertise(true);
        return null;
    }

    void stop() {
        on = false;
        try {
            if (advertiser != null) advertiser.stopAdvertising(advertised);
        } catch (Exception ignored) {
            // (Bluetooth off meanwhile)
        }
        try {
            if (server != null) server.close();
        } catch (Exception ignored) {
        }
        advertiser = null;
        server = null;
        listening.clear();
        used.clear();
        link.clear();
        synchronized (outbox) {
            outbox.clear();
            sendingTo.clear();
            sending = false;
        }
    }

    // A notification to every device listening, one at a time (Android sends one, then says so).
    private void send(byte[] frame) {
        synchronized (outbox) {
            for (BluetoothDevice d : listening) {
                outbox.add(frame);
                sendingTo.add(d);
            }
            if (!sending) sendNext();
        }
    }

    @SuppressWarnings("deprecation")
    private void sendNext() {
        synchronized (outbox) {
            while (!outbox.isEmpty()) {
                byte[] f = outbox.poll();
                BluetoothDevice d = sendingTo.poll();
                if (server == null || d == null || !listening.contains(d)) continue;
                boolean ok;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    ok = server.notifyCharacteristicChanged(d, tx, false, f) == BluetoothGatt.GATT_SUCCESS;
                } else {
                    tx.setValue(f);
                    ok = server.notifyCharacteristicChanged(d, tx, false);
                }
                if (ok) {
                    sending = true;
                    return;
                }
            }
            sending = false;
        }
    }

    private final BluetoothGattServerCallback callback = new BluetoothGattServerCallback() {
        @Override
        public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
            if (newState != BluetoothProfile.STATE_DISCONNECTED) return;
            listening.remove(device);
            mtus.remove(device.getAddress());
            link.gone(device.getAddress());
            // Advertising again once a device that used it goes (its connection can have ended the
            // advertising, and not every phone starts it again). Only then: every device's
            // connections come here, and each new start can be under a new address.
            if (used.remove(device.getAddress()) && advertiser != null && on) {
                try {
                    advertiser.stopAdvertising(advertised);
                    advertise(true);
                } catch (Exception ignored) {
                    // (Bluetooth off meanwhile)
                }
            }
        }

        @Override
        public void onMtuChanged(BluetoothDevice device, int mtu) {
            mtus.put(device.getAddress(), mtu);
        }

        @Override
        public void onCharacteristicReadRequest(BluetoothDevice device, int requestId, int offset, BluetoothGattCharacteristic c) {
            if (server == null) return;
            byte[] value = INFO.equals(c.getUuid()) ? link.info() : new byte[0];
            used.add(device.getAddress());
            int off = Math.min(offset, value.length);
            server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, off, Arrays.copyOfRange(value, off, value.length));
        }

        @Override
        public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId, BluetoothGattCharacteristic c, boolean preparedWrite, boolean responseNeeded, int offset, byte[] value) {
            if (server == null) return;
            if (responseNeeded) server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null);
            used.add(device.getAddress());
            if (RX.equals(c.getUuid()) && !preparedWrite) link.received(device.getAddress(), value, mtus.getOrDefault(device.getAddress(), 23));
        }

        @Override
        public void onDescriptorWriteRequest(BluetoothDevice device, int requestId, BluetoothGattDescriptor d, boolean preparedWrite, boolean responseNeeded, int offset, byte[] value) {
            if (server == null) return;
            if (CCCD.equals(d.getUuid())) {
                if (value != null && value.length > 0 && value[0] != 0) listening.add(device);
                else listening.remove(device);
            }
            if (responseNeeded) server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null);
        }

        @Override
        public void onDescriptorReadRequest(BluetoothDevice device, int requestId, int offset, BluetoothGattDescriptor d) {
            if (server == null) return;
            server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, listening.contains(device) ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE : BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE);
        }

        @Override
        public void onNotificationSent(BluetoothDevice device, int status) {
            synchronized (outbox) {
                sending = false;
                sendNext();
            }
        }
    };
}
