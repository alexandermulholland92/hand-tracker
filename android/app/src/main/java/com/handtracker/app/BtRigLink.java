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

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.Deflater;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * BtRigLink — remote recording on this phone over Bluetooth Low Energy: another phone, the
 * website or a computer that can't reach it over a network reaches its remote recording page
 * (RigServerPlugin) over Bluetooth instead. The link is electron/bluetooth-link.js's, word for
 * word (a GATT service of its own, INFO / RX / TX, the password's key K, a session key per device,
 * each request and answer sealed with AES-256-GCM, answers deflated when that's shorter): read
 * that file for what goes over it. Each request is handed to RigServerPlugin as one from a phone
 * it trusts (the password was the proof); its answer goes back the same way.
 *
 *   new BtRigLink(context, name, secret: { salt, iter, key } (base64), relay)
 *     relay.handle(method, path, body) -> { status, type, body }
 *   start() -> null or why not; stop(); on()
 */
@SuppressLint("MissingPermission")
final class BtRigLink {
    static final UUID SERVICE = UUID.fromString("48540001-6c69-6e6b-8000-68616e647472");
    static final UUID INFO = UUID.fromString("48540002-6c69-6e6b-8000-68616e647472");
    static final UUID RX = UUID.fromString("48540003-6c69-6e6b-8000-68616e647472");
    static final UUID TX = UUID.fromString("48540004-6c69-6e6b-8000-68616e647472");
    static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    static final int HELLO = 1, WELCOME = 2, DATA = 3, ERROR = 4, FIRST = 1, LAST = 2, HEAD = 6;
    static final long SESSION_IDLE_MS = 10 * 60 * 1000;
    static final int MAX_MESSAGE = 64 * 1024;
    static final int ITERATIONS = 100000;

    interface Relay {
        Answer handle(String method, String path, byte[] body);
    }

    static final class Answer {
        final int status;
        final String type;
        final byte[] body;

        Answer(int status, String type, byte[] body) {
            this.status = status;
            this.type = type;
            this.body = body;
        }
    }

    static final class Secret {
        final String salt;
        final int iter;
        final byte[] key;

        Secret(String salt, int iter, byte[] key) {
            this.salt = salt;
            this.iter = iter;
            this.key = key;
        }
    }

    private static final SecureRandom RANDOM = new SecureRandom();

    // ---------- the password's key (as bluetooth-link.js makeSecret) ----------
    static byte[] pbkdf2(byte[] password, byte[] salt, int iter) throws Exception {
        // One 32-byte block of PBKDF2-HMAC-SHA256 (Android 7 has no PBKDF2WithHmacSHA256).
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(password.length == 0 ? new byte[1] : password, "HmacSHA256"));
        mac.update(salt);
        byte[] u = mac.doFinal(new byte[] {0, 0, 0, 1});
        byte[] t = u.clone();
        for (int i = 1; i < iter; i++) {
            u = mac.doFinal(u);
            for (int j = 0; j < t.length; j++) t[j] ^= u[j];
        }
        return t;
    }

    static Secret makeSecret(String password) throws Exception {
        byte[] salt = new byte[16];
        RANDOM.nextBytes(salt);
        return new Secret(android.util.Base64.encodeToString(salt, android.util.Base64.NO_WRAP), ITERATIONS, pbkdf2(password.getBytes(StandardCharsets.UTF_8), salt, ITERATIONS));
    }

    // ---------- the link ----------
    private static final class Session {
        final String device;
        final byte[] key;
        long at;
        int mtu;
        final Map<Integer, ByteArrayOutputStream> parts = new HashMap<>();

        Session(String device, byte[] key, int mtu) {
            this.device = device;
            this.key = key;
            this.mtu = mtu;
            this.at = System.currentTimeMillis();
        }
    }

    private final Context ctx;
    private final String name;
    private final Secret secret;
    private final Relay relay;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<Integer, Session> sessions = new ConcurrentHashMap<>();
    private int next = 1 + RANDOM.nextInt(60000);

    BtRigLink(Context ctx, String name, Secret secret, Relay relay) {
        this.ctx = ctx.getApplicationContext();
        this.name = name;
        this.secret = secret;
        this.relay = relay;
    }

    byte[] info() {
        try {
            JSONObject o = new JSONObject();
            o.put("v", 1);
            o.put("name", name);
            o.put("salt", secret.salt);
            o.put("iter", secret.iter);
            return o.toString().getBytes(StandardCharsets.UTF_8);
        } catch (Exception e) {
            return new byte[0];
        }
    }

    private static byte[] aad(int session, int message) {
        return new byte[] {(byte) session, (byte) (session >> 8), (byte) message, (byte) (message >> 8)};
    }

    static byte[] sessionKey(byte[] k, byte[] cn, byte[] sn) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(k, "HmacSHA256"));
        mac.update("HT1".getBytes(StandardCharsets.US_ASCII));
        mac.update(cn);
        return mac.doFinal(sn);
    }

    static byte[] seal(byte[] s, int session, int message, byte[] plain) throws Exception {
        byte[] iv = new byte[12];
        RANDOM.nextBytes(iv);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(s, "AES"), new GCMParameterSpec(128, iv));
        c.updateAAD(aad(session, message));
        byte[] body = c.doFinal(plain); // (its tag at the end, as the link has it)
        byte[] out = new byte[12 + body.length];
        System.arraycopy(iv, 0, out, 0, 12);
        System.arraycopy(body, 0, out, 12, body.length);
        return out;
    }

    static byte[] open(byte[] s, int session, int message, byte[] sealed) {
        if (sealed.length < 28) return null;
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(s, "AES"), new GCMParameterSpec(128, sealed, 0, 12));
            c.updateAAD(aad(session, message));
            return c.doFinal(sealed, 12, sealed.length - 12);
        } catch (Exception e) {
            return null;
        }
    }

    static byte[] pack(JSONObject head, byte[] body) {
        byte[] h = head.toString().getBytes(StandardCharsets.UTF_8);
        byte[] out = new byte[4 + h.length + body.length];
        out[0] = (byte) h.length;
        out[1] = (byte) (h.length >> 8);
        out[2] = (byte) (h.length >> 16);
        out[3] = (byte) (h.length >> 24);
        System.arraycopy(h, 0, out, 4, h.length);
        System.arraycopy(body, 0, out, 4 + h.length, body.length);
        return out;
    }

    static byte[] deflateRaw(byte[] data) {
        Deflater d = new Deflater(9, true);
        d.setInput(data);
        d.finish();
        ByteArrayOutputStream out = new ByteArrayOutputStream(data.length / 2 + 64);
        byte[] buf = new byte[8192];
        while (!d.finished()) out.write(buf, 0, d.deflate(buf));
        d.end();
        return out.toByteArray();
    }

    // A message as frames that fit the link (each at most mtu - 3 bytes, as notifications are).
    static List<byte[]> frames(int type, int session, int message, byte[] data, int mtu) {
        int room = Math.max(20, Math.min(509, (mtu > 0 ? mtu : 23) - 3)) - HEAD;
        List<byte[]> out = new ArrayList<>();
        for (int at = 0; at == 0 || at < data.length; at += room) {
            int n = Math.min(room, data.length - at);
            byte[] f = new byte[HEAD + n];
            f[0] = (byte) type;
            f[1] = (byte) session;
            f[2] = (byte) (session >> 8);
            f[3] = (byte) message;
            f[4] = (byte) (message >> 8);
            f[5] = (byte) ((at == 0 ? FIRST : 0) | (at + room >= data.length ? LAST : 0));
            System.arraycopy(data, at, f, HEAD, n);
            out.add(f);
        }
        return out;
    }

    private void notifyAll(int type, int session, int message, byte[] data, int mtu) {
        for (byte[] f : frames(type, session, message, data, mtu)) send(f);
    }

    void gone(String device) {
        sessions.values().removeIf((s) -> s.device.equals(device));
    }

    void received(String device, byte[] frame, int mtu) {
        if (frame == null || frame.length < HEAD) return;
        int type = frame[0] & 0xff, session = (frame[1] & 0xff) | ((frame[2] & 0xff) << 8), message = (frame[3] & 0xff) | ((frame[4] & 0xff) << 8), flags = frame[5];
        byte[] part = Arrays.copyOfRange(frame, HEAD, frame.length);
        long now = System.currentTimeMillis();
        sessions.values().removeIf((s) -> now - s.at > SESSION_IDLE_MS);
        if (type == HELLO) {
            if (part.length != 16) return;
            gone(device); // (one session a device: a new hello starts afresh)
            int id;
            synchronized (this) {
                id = next;
                next = (next % 65000) + 1;
            }
            byte[] sn = new byte[16];
            RANDOM.nextBytes(sn);
            try {
                sessions.put(id, new Session(device, sessionKey(secret.key, part, sn), mtu));
            } catch (Exception e) {
                return;
            }
            notifyAll(WELCOME, id, message, sn, mtu);
            return;
        }
        if (type != DATA) return;
        Session s = sessions.get(session);
        if (s == null || !s.device.equals(device)) {
            notifyAll(ERROR, session, message, "session".getBytes(StandardCharsets.UTF_8), mtu);
            return;
        }
        s.at = now;
        if (mtu > 0) s.mtu = mtu;
        if ((flags & FIRST) != 0) s.parts.put(message, new ByteArrayOutputStream());
        ByteArrayOutputStream parts = s.parts.get(message);
        if (parts == null) return;
        parts.write(part, 0, part.length);
        if (parts.size() > MAX_MESSAGE + 64) {
            s.parts.remove(message);
            notifyAll(ERROR, session, message, "too long".getBytes(StandardCharsets.UTF_8), s.mtu);
            return;
        }
        if ((flags & LAST) == 0) return;
        s.parts.remove(message);
        byte[] plain = open(s.key, session, message, parts.toByteArray());
        if (plain == null) {
            sessions.remove(session);
            notifyAll(ERROR, session, message, "password".getBytes(StandardCharsets.UTF_8), s.mtu);
            return;
        }
        pool.execute(() -> answer(s, session, message, plain));
    }

    private void answer(Session s, int session, int message, byte[] plain) {
        int status;
        String type = "application/json; charset=utf-8";
        byte[] body;
        try {
            if (plain.length < 4) throw new Exception("short");
            int n = (plain[0] & 0xff) | ((plain[1] & 0xff) << 8) | ((plain[2] & 0xff) << 16) | ((plain[3] & 0xff) << 24);
            if (n < 0 || n > plain.length - 4) throw new Exception("short");
            JSONObject head = new JSONObject(new String(plain, 4, n, StandardCharsets.UTF_8));
            String path = head.optString("p", "");
            if (!path.matches("^/api/[a-z].*")) {
                status = 400;
                body = "{\"error\":\"Not found\"}".getBytes(StandardCharsets.UTF_8);
            } else {
                String method = "POST".equals(head.optString("m")) ? "POST" : "GET";
                byte[] reqBody = "POST".equals(method) ? Arrays.copyOfRange(plain, 4 + n, plain.length) : new byte[0];
                Answer a = relay.handle(method, path.length() > 512 ? path.substring(0, 512) : path, reqBody);
                status = a.status;
                type = a.type;
                body = a.body;
            }
        } catch (Exception e) {
            status = 502;
            body = ("{\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}").getBytes(StandardCharsets.UTF_8);
        }
        if (sessions.get(session) != s) return;
        try {
            byte[] small = body.length > 200 && !type.startsWith("image/") ? deflateRaw(body) : null;
            JSONObject head = new JSONObject();
            head.put("s", status);
            head.put("t", type);
            boolean z = small != null && small.length < body.length;
            if (z) head.put("z", 1);
            notifyAll(DATA, session, message, seal(s.key, session, message, pack(head, z ? small : body)), s.mtu);
        } catch (Exception ignored) {
            // (gone meanwhile)
        }
    }

    // ---------- Bluetooth: the GATT service and its advertising ----------
    private BluetoothGattServer server;
    private BluetoothGattCharacteristic tx;
    private BluetoothLeAdvertiser advertiser;
    private final Set<BluetoothDevice> listening = ConcurrentHashMap.newKeySet();
    private final Map<String, Integer> mtus = new ConcurrentHashMap<>();
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
        sessions.clear();
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
            if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                listening.remove(device);
                mtus.remove(device.getAddress());
                gone(device.getAddress());
            }
            // Advertising again (a connection can end it, and not every phone starts it again).
            if (advertiser != null && on) {
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
            byte[] value = INFO.equals(c.getUuid()) ? info() : new byte[0];
            int off = Math.min(offset, value.length);
            server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, off, Arrays.copyOfRange(value, off, value.length));
        }

        @Override
        public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId, BluetoothGattCharacteristic c, boolean preparedWrite, boolean responseNeeded, int offset, byte[] value) {
            if (server == null) return;
            if (responseNeeded) server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null);
            if (RX.equals(c.getUuid()) && !preparedWrite) received(device.getAddress(), value, mtus.getOrDefault(device.getAddress(), 23));
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
