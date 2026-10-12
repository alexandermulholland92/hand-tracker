package com.handtracker.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.util.Base64;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;

/**
 * BtNet — a computer's Bluetooth network (Hand Tracker on a Raspberry Pi, set up with
 * pi/bluetooth-setup.sh), for remote recording when there's no other network between them. This
 * phone joins it in Android's Bluetooth settings (paired with the computer, its Internet access
 * turned on) and reaches remote recording there at ADDR (RemotePlugin.fetchRig, bound to that
 * network rather than the phone's default one; asked for here, since Android sets a Bluetooth
 * network up only when something asks for one, never while Wi-Fi or mobile data is on otherwise),
 * with the computer's Bluetooth password (on a Pi,
 * its hotspot's): asked for once, then kept here per computer, encrypted with the app's key in
 * the Android Keystore (RemotePlugin.secretKey).
 */
final class BtNet {
    static final String ADDR = "10.43.0.1"; // the computer, on its Bluetooth network
    private static final String PREFIX = "10.43.0.";

    private static final int PAN = 5; // BluetoothProfile.PAN (hidden in the SDK, a public profile)
    private static volatile BluetoothProfile pan; // the phone's Bluetooth network connections (PAN)
    private static CountDownLatch panReady;

    private static ConnectivityManager.NetworkCallback asking; // the standing request for it
    private static final Object changed = new Object();

    private BtNet() {}

    // Asks Android for a Bluetooth network, once (kept while the app runs): with the phone joined
    // to a computer's, Android then gets it an address.
    private static synchronized void ask(Context ctx) {
        if (asking != null) return;
        ConnectivityManager cm = ctx.getApplicationContext().getSystemService(ConnectivityManager.class);
        if (cm == null) return;
        ConnectivityManager.NetworkCallback cb = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network n) {
                wake();
            }

            @Override
            public void onLinkPropertiesChanged(Network n, LinkProperties lp) {
                wake();
            }
        };
        try {
            cm.requestNetwork(new NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_BLUETOOTH)
                    .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build(), cb);
            asking = cb;
        } catch (RuntimeException e) {
            // (Not allowed, or too many requests: only a network already up is used.)
        }
    }

    private static void wake() {
        synchronized (changed) {
            changed.notifyAll();
        }
    }

    // Joined to a computer's Bluetooth network (its link up), with or without an address yet.
    private static boolean joined() {
        try {
            NetworkInterface i = NetworkInterface.getByName("bt-pan");
            return i != null && i.isUp();
        } catch (Exception e) {
            return false;
        }
    }

    // The network, if this phone is on one of Hand Tracker's (an address in 10.43.0.0/24 over
    // Bluetooth); joined but without its address yet, waited for up to waitMs.
    static Network network(Context ctx) {
        return network(ctx, 0);
    }

    static Network network(Context ctx, long waitMs) {
        ask(ctx);
        ConnectivityManager cm = ctx.getSystemService(ConnectivityManager.class);
        if (cm == null) return null;
        long until = System.currentTimeMillis() + waitMs;
        while (true) {
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH) && address(cm.getLinkProperties(n)) != null) return n;
            }
            if (System.currentTimeMillis() >= until || !joined()) return null;
            synchronized (changed) {
                try {
                    changed.wait(250);
                } catch (InterruptedException e) {
                    return null;
                }
            }
        }
    }

    // This phone's address on it.
    static String address(Context ctx, Network n) {
        ConnectivityManager cm = ctx.getSystemService(ConnectivityManager.class);
        return n == null || cm == null ? null : address(cm.getLinkProperties(n));
    }

    private static String address(LinkProperties lp) {
        if (lp == null) return null;
        for (LinkAddress la : lp.getLinkAddresses()) {
            InetAddress a = la.getAddress();
            if (a instanceof Inet4Address && a.getHostAddress().startsWith(PREFIX)) return a.getHostAddress();
        }
        return null;
    }

    static boolean mayAsk(Context ctx) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S || ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    // The computer this phone's Bluetooth network is with; null if it can't be told (no Nearby
    // devices permission). Waits a moment the first time (not on the main thread).
    @SuppressLint("MissingPermission")
    static BluetoothDevice device(Context ctx) {
        if (!mayAsk(ctx)) return null;
        CountDownLatch ready;
        synchronized (BtNet.class) {
            if (panReady == null) {
                panReady = new CountDownLatch(1);
                BluetoothManager bm = ctx.getSystemService(BluetoothManager.class);
                BluetoothAdapter adapter = bm == null ? null : bm.getAdapter();
                if (adapter == null || !adapter.getProfileProxy(ctx.getApplicationContext(), new BluetoothProfile.ServiceListener() {
                    @Override
                    public void onServiceConnected(int profile, BluetoothProfile proxy) {
                        pan = proxy;
                        panReady.countDown();
                    }

                    @Override
                    public void onServiceDisconnected(int profile) {
                        pan = null;
                    }
                }, PAN)) panReady.countDown();
            }
            ready = panReady;
        }
        try {
            ready.await(2, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            return null;
        }
        BluetoothProfile p = pan;
        if (p == null) return null;
        try {
            List<BluetoothDevice> list = p.getConnectedDevices();
            return list.isEmpty() ? null : list.get(0);
        } catch (Exception e) {
            return null;
        }
    }

    @SuppressLint("MissingPermission")
    static String nameOf(BluetoothDevice d) {
        try {
            String n = d.getName();
            return n != null ? n : d.getAddress();
        } catch (Exception e) {
            return d.getAddress();
        }
    }

    // ---------- its password, kept per computer ----------
    // A Wi-Fi password's characters (what a Pi's hotspot has): 8 to 63, letters, digits, symbols, spaces.
    static boolean okPassword(String pw) {
        if (pw == null || pw.length() < 8 || pw.length() > 63) return false;
        for (int i = 0; i < pw.length(); i++) {
            char c = pw.charAt(i);
            if (c < 0x20 || c > 0x7e) return false;
        }
        return true;
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences("hand-tracker-bluetooth", Context.MODE_PRIVATE);
    }

    // (Kept by the computer's Bluetooth address; "any" when it can't be told.)
    private static String slot(Context ctx) {
        BluetoothDevice d = device(ctx);
        return "password:" + (d == null ? "any" : d.getAddress());
    }

    static String password(Context ctx) {
        String slot = slot(ctx);
        String v = prefs(ctx).getString(slot, null);
        if (v == null) return null;
        try {
            String[] parts = v.split(":", 2);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, RemotePlugin.secretKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            String pw = new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
            return okPassword(pw) ? pw : null;
        } catch (Exception e) {
            // (The Keystore's key is gone: as if nothing was kept.)
            prefs(ctx).edit().remove(slot).apply();
            return null;
        }
    }

    static void setPassword(Context ctx, String pw) throws Exception {
        if (!okPassword(pw)) throw new IllegalArgumentException("A Bluetooth password is 8 to 63 letters, digits, symbols or spaces.");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, RemotePlugin.secretKey());
        byte[] sealed = cipher.doFinal(pw.getBytes(StandardCharsets.UTF_8));
        prefs(ctx).edit().putString(slot(ctx), Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP)).apply();
    }

    static void forget(Context ctx) {
        prefs(ctx).edit().remove(slot(ctx)).apply();
    }
}
