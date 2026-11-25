package com.handtracker.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.content.res.AssetManager;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import com.chaquo.python.PyObject;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

/**
 * MemberService — this phone as a member of the cluster (the user, 2026-11-23: "Have phone's able to join the
 * cluster as a member too"; the Cluster app's own switch, MemberPlugin.java): Cluster's service, the same as on
 * the Pis (cluster/node/ht_cluster.py), run in the app's Python (Chaquopy; htmember.py), in a foreground service with
 * a quiet notification while it's on, until the switch (or the notification's Stop) turns it off. On after the phone
 * restarts if it was on (MemberBoot.java), and when the app opens.
 *
 * Its code comes with the app (assets/cluster-node, scripts/build-android.js), copied to the app's files when the
 * app's version changes (the service reads its modules from its folder). What it's told: this phone's name, its
 * Tailscale address (found here every CHECK_MS: the service can't ask Tailscale, which keeps that to the Tailscale
 * app) and the Pis the app knows (through which it finds the others), and its state folder.
 */
public class MemberService extends Service {
    static final String PREFS = "cluster-member";
    static final String ACTION_STOP = "com.handtracker.app.STOP_MEMBER";
    static final int PORT = 47830;
    private static final String CHANNEL = "cluster-member";
    private static final int NOTIFICATION_ID = 21;
    private static final long CHECK_MS = 30000;
    private static final String TAG = "ClusterMember";

    static volatile MemberService running;
    static volatile String lastError = "";
    static volatile String tailscaleIp = "";
    private volatile String takesTold = "";
    private Thread thread, checker;
    private volatile boolean stop;

    // Started if it's on (as it was left) and not running: after the phone restarts, the app is updated, or it opens.
    static void startIfOn(Context ctx) {
        if (running != null || !ctx.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("on", false)) return;
        try {
            ctx.startForegroundService(new Intent(ctx, MemberService.class));
        } catch (Exception e) {
            lastError = "Couldn't start: " + e.getMessage();
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("on", false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel quiet = new NotificationChannel(CHANNEL, "This phone in your cluster", NotificationManager.IMPORTANCE_MIN);
        quiet.setShowBadge(false);
        nm.createNotificationChannel(quiet);
        Notification n = notification();
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIFICATION_ID, n);
        running = this;
        PhoneNative.app = getApplicationContext();
        if (thread == null) {
            stop = false;
            lastError = "";
            thread = new Thread(this::serve, "cluster-member");
            thread.start();
            checker = new Thread(this::check, "cluster-member-check");
            checker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stop = true;
        if (checker != null) checker.interrupt();
        try {
            if (Python.isStarted()) Python.getInstance().getModule("htmember").callAttr("stop");
        } catch (Exception e) {
            Log.w(TAG, "stop", e);
        }
        thread = null;
        checker = null;
        running = null;
        super.onDestroy();
    }

    private Notification notification() {
        Intent stopIt = new Intent(this, MemberService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stopIt, PendingIntent.FLAG_IMMUTABLE);
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_share)
                .setContentTitle("This phone is in your cluster")
                .setContentText("Its health, jobs and downloads, as its switch in the Cluster app says")
                .setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE))
                .addAction(new Notification.Action.Builder(null, "Stop", stopPi).build())
                .setOngoing(true)
                .build();
    }

    // The service itself, until it's stopped (htmember.run blocks while it runs).
    private void serve() {
        try {
            File code = copyCode();
            if (!Python.isStarted()) Python.start(new AndroidPlatform(getApplicationContext()));
            SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
            tailscaleIp = findTailscale();
            File state = new File(getFilesDir(), "cluster-state");
            //noinspection ResultOfMethodCallIgnored
            state.mkdirs();
            JSONObject env = new JSONObject()
                    .put("HT_CLUSTER_PLATFORM", "android")
                    .put("HT_CLUSTER_NAME", p.getString("name", defaultName()))
                    .put("HT_CLUSTER_TS_IP", tailscaleIp)
                    .put("HT_CLUSTER_SEEDS", p.getString("seeds", ""))
                    .put("HT_CLUSTER_STATE", state.getAbsolutePath())
                    .put("HT_CLUSTER_PORT", String.valueOf(PORT))
                    .put("HOME", getFilesDir().getAbsolutePath());
            // (its Hand Tracker apps' takes, Documents/Hand Tracker, shared with the cluster as a Pi's are: only once this
            // app may read them there, All files access; told later too, as it's allowed: check())
            String takes = takesFolder();
            if (!takes.isEmpty()) env.put("HT_CLUSTER_PHONE_RECORDINGS", takes);
            takesTold = takes;
            Python.getInstance().getModule("htmember").callAttr("run", code.getAbsolutePath(), env.toString());
        } catch (Throwable e) {
            lastError = String.valueOf(e.getMessage() != null ? e.getMessage() : e);
            Log.e(TAG, "serve", e);
        }
        if (!stop) stopSelf(); // (it ended by itself: said in its status)
    }

    // Every CHECK_MS: this phone's Tailscale address, told to the service when it changes (Tailscale turned on later).
    private void check() {
        while (!stop) {
            try {
                Thread.sleep(CHECK_MS);
            } catch (InterruptedException e) {
                return;
            }
            String takes = takesFolder();
            if (!takes.equals(takesTold) && Python.isStarted()) {
                takesTold = takes;
                try {
                    Python.getInstance().getModule("os").get("environ").callAttr("__setitem__", "HT_CLUSTER_PHONE_RECORDINGS", takes);
                } catch (Exception e) {
                    Log.w(TAG, "takes", e);
                }
            }
            String ip = findTailscale();
            if (!ip.equals(tailscaleIp) && Python.isStarted()) {
                tailscaleIp = ip;
                try {
                    Python.getInstance().getModule("os").get("environ").callAttr("__setitem__", "HT_CLUSTER_TS_IP", ip);
                } catch (Exception e) {
                    Log.w(TAG, "tailscale address", e);
                }
            }
        }
    }

    // Its Hand Tracker apps' takes folder (Documents/Hand Tracker), if this app may read it there, else "".
    static String takesFolder() {
        File takes = new File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOCUMENTS), "Hand Tracker");
        return takes.isDirectory() && takes.canRead() && takes.list() != null ? takes.getAbsolutePath() : "";
    }

    // This phone's Tailscale address (100.64.0.0/10, on Tailscale's own network interface), or "".
    static String findTailscale() {
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address)) continue;
                    byte[] b = a.getAddress();
                    if ((b[0] & 0xff) == 100 && (b[1] & 0xc0) == 64) return a.getHostAddress();
                }
            }
        } catch (Exception ignored) {
            // (none)
        }
        return "";
    }

    static String defaultName() {
        String m = (Build.MODEL == null ? "phone" : Build.MODEL).replaceAll("[^A-Za-z0-9 ._-]", "").trim();
        return m.isEmpty() ? "phone" : m.length() > 40 ? m.substring(0, 40) : m;
    }

    // The service's code (assets/cluster-node), copied to the app's files when its STAMP (of its contents) isn't the one there.
    private File copyCode() throws IOException {
        File dir = new File(getFilesDir(), "cluster-node");
        AssetManager am = getAssets();
        String version = read(am.open("cluster-node/STAMP"));
        File mark = new File(dir, "STAMP");
        if (mark.exists() && version.equals(read(new java.io.FileInputStream(mark)))) return dir;
        deleteAll(dir);
        copyDir(am, "cluster-node", dir);
        return dir;
    }

    private static String read(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        try (InputStream i = in) {
            copy(i, out);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8).trim();
    }

    // (InputStream.transferTo is Android 13's: the app runs on older ones too)
    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[65536];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
    }

    private static void copyDir(AssetManager am, String from, File to) throws IOException {
        String[] names = am.list(from);
        if (names == null || names.length == 0) { // (a file)
            //noinspection ResultOfMethodCallIgnored
            to.getParentFile().mkdirs();
            try (InputStream in = am.open(from); OutputStream out = new FileOutputStream(to)) {
                copy(in, out);
            }
            return;
        }
        //noinspection ResultOfMethodCallIgnored
        to.mkdirs();
        for (String n : names) copyDir(am, from + "/" + n, new File(to, n));
    }

    private static void deleteAll(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteAll(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
