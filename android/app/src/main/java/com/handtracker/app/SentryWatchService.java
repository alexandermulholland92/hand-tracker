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
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Sentry mode's alerts on this phone, from the computers it's told to watch ("Alerts on this
 * phone" in Sentry mode on a computer's remote recording page; the Hand Tracker app's own way,
 * the other is the ntfy app). A foreground service, with a quiet notification saying it's
 * watching, that asks each computer for its state every POLL_MS (over Tailscale from anywhere,
 * or on the same Wi-Fi with the computer's code) and shows a notification, with the photo, for
 * each new alert a computer's Sentry mode has. Also: a computer that hasn't answered for
 * OFFLINE_MS (while this phone could reach it: on a network, with Tailscale on for one reached
 * over it) has gone offline, and is back online when it answers again; and one too hot (its state
 * says so: remote-record-ui.js, itself or one of its OAK cameras' chips) is told of once each
 * time it gets so. Started and stopped by SentryWatchPlugin.java; the computers are kept in its
 * SharedPreferences, so it carries on after a restart of the app (and what it's told of stays
 * told), and it's started again after the phone restarts or the app is updated
 * (SentryWatchBoot.java) and when the app opens (startIfOn).
 */
public class SentryWatchService extends Service {
    static final String PREFS = "sentry-watch";
    static final String ACTION_STOP = "com.handtracker.app.STOP_SENTRY_WATCH";
    private static final String CHANNEL_ON = "sentry-watch";
    private static final String CHANNEL_ALERT = "sentry-alerts";
    private static final String CHANNEL_DEVICE = "sentry-devices";
    private static final int NOTIFICATION_ID = 11;
    private static final long POLL_MS = 15000;
    private static final long OFFLINE_MS = 60000;

    static volatile SentryWatchService running;

    // Started if it's on (as it was left) and not running: after the phone restarts, the app is
    // updated, or the app opens.
    static void startIfOn(Context ctx) {
        if (running != null || !ctx.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("on", false)) return;
        try {
            ctx.startForegroundService(new Intent(ctx, SentryWatchService.class));
        } catch (Exception ignored) {
            // (not allowed now: the next time the app opens)
        }
    }
    private volatile boolean stop;
    private Thread thread;
    private PowerManager.WakeLock wake;

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
        channels();
        Notification n = watchingNotification();
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIFICATION_ID, n);
        running = this;
        if (thread == null) {
            // The phone's processor may sleep between looks otherwise (the screen off, in a pocket).
            wake = ((PowerManager) getSystemService(Context.POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "HandTracker:sentry");
            wake.acquire();
            stop = false;
            thread = new Thread(this::watch, "sentry-watch");
            thread.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stop = true;
        if (thread != null) thread.interrupt();
        thread = null;
        if (wake != null && wake.isHeld()) wake.release();
        running = null;
        super.onDestroy();
    }

    private void channels() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel quiet = new NotificationChannel(CHANNEL_ON, "Watching for Sentry alerts", NotificationManager.IMPORTANCE_MIN);
        quiet.setShowBadge(false);
        nm.createNotificationChannel(quiet);
        NotificationChannel loud = new NotificationChannel(CHANNEL_ALERT, "Sentry alerts", NotificationManager.IMPORTANCE_HIGH);
        loud.setDescription("Movement a computer's Sentry mode saw");
        nm.createNotificationChannel(loud);
        NotificationChannel device = new NotificationChannel(CHANNEL_DEVICE, "Computers offline or too hot", NotificationManager.IMPORTANCE_HIGH);
        device.setDescription("A computer this phone watches for Sentry alerts went offline, came back, or is too hot");
        nm.createNotificationChannel(device);
    }

    // The app, at one of its pages (MainActivity.EXTRA_PAGE).
    private PendingIntent openPage(int code, String page) {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(MainActivity.EXTRA_PAGE, page);
        return PendingIntent.getActivity(this, code, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static String enc(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8").replace("+", "%20");
        } catch (Exception e) {
            return "";
        }
    }

    // A computer's remote recording page in the app (remote-client.js).
    private static String rigPage(String rig) {
        return "remote-client.html?rig=" + enc(rig);
    }

    // Tapped: the computer's remote recording page (the list of computers if it watches several).
    private Notification watchingNotification() {
        Intent stopIt = new Intent(this, SentryWatchService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stopIt, PendingIntent.FLAG_IMMUTABLE);
        String page = "remote.html";
        try {
            JSONArray rigs = new JSONArray(getSharedPreferences(PREFS, MODE_PRIVATE).getString("rigs", "[]"));
            if (rigs.length() == 1) page = rigPage(rigs.getJSONObject(0).optString("rig", ""));
        } catch (Exception ignored) {
            // the list, then
        }
        return new Notification.Builder(this, CHANNEL_ON)
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentTitle("Watching for Sentry alerts")
                .setContentText("From your computers' Sentry mode")
                .setContentIntent(openPage(0, page))
                .addAction(new Notification.Action.Builder(null, "Stop", stopPi).build())
                .setOngoing(true)
                .build();
    }

    // Each computer in turn, every POLL_MS; an alert not seen before is a notification. The first
    // look at a computer only notes what it has (they're not new to this phone).
    private void watch() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        Set<String> seen = new HashSet<>(p.getStringSet("seen", new HashSet<>()));
        Set<String> offline = new HashSet<>(p.getStringSet("offline", new HashSet<>()));
        Set<String> hot = new HashSet<>(p.getStringSet("hot", new HashSet<>()));
        Map<String, Long> answered = new HashMap<>(); // each computer: when it last answered (or this phone last couldn't reach it)
        Map<String, String> names = new HashMap<>();
        Set<String> looked = new HashSet<>();
        int notified = 0;
        while (!stop) {
            JSONArray rigs;
            try {
                rigs = new JSONArray(p.getString("rigs", "[]"));
            } catch (Exception e) {
                rigs = new JSONArray();
            }
            for (int i = 0; i < rigs.length() && !stop; i++) {
                JSONObject r = rigs.optJSONObject(i);
                if (r == null) continue;
                String rig = r.optString("rig", ""), key = r.optString("key", "");
                RemotePlugin.RigAnswer a;
                try {
                    a = RemotePlugin.fetchRig(this, rig, "/api/state", "GET", "", key);
                } catch (Exception e) {
                    // Not reachable (off, or this phone off its network or Tailscale): gone
                    // offline once it's been so for OFFLINE_MS while this phone could reach it.
                    long now = System.currentTimeMillis();
                    Long since = answered.get(rig);
                    if (since == null || !canReach(rig)) answered.put(rig, now);
                    else if (now - since >= OFFLINE_MS && offline.add(rig)) {
                        device(offlineId(rig), rig, nameOf(rig, names) + " went offline", "It hasn't answered for a minute.", android.R.drawable.ic_dialog_alert);
                    }
                    continue;
                }
                answered.put(rig, System.currentTimeMillis());
                if (offline.remove(rig)) device(offlineId(rig), rig, nameOf(rig, names) + " is back online", "It's answering again.", android.R.drawable.ic_dialog_info);
                try {
                    if (a.status != 200) continue;
                    JSONObject state = new JSONObject(new String(a.body, StandardCharsets.UTF_8));
                    String host = state.optString("host", rig.replaceAll(":\\d+$", ""));
                    names.put(rig, host);
                    heat(rig, host, state, hot);
                    JSONObject sentry = state.optJSONObject("sentry");
                    if (sentry == null) {
                        looked.add(rig);
                        continue;
                    }
                    JSONArray events = sentry.optJSONArray("events");
                    for (int j = events == null ? -1 : events.length() - 1; j >= 0; j--) {
                        JSONObject e = events.optJSONObject(j);
                        if (e == null) continue;
                        String id = rig + "/" + e.optString("id");
                        if (seen.contains(id)) continue;
                        seen.add(id);
                        if (looked.contains(rig)) notify(rig, key, host, e, ++notified);
                    }
                    looked.add(rig);
                } catch (Exception e) {
                    // (its state not as expected: next time)
                }
            }
            // Only the alerts the computers still list are worth remembering, and only the
            // computers still watched.
            if (seen.size() > 400) seen.clear();
            Set<String> watched = new HashSet<>();
            for (int i = 0; i < rigs.length(); i++) {
                JSONObject r = rigs.optJSONObject(i);
                if (r != null) watched.add(r.optString("rig", ""));
            }
            offline.retainAll(watched);
            hot.removeIf((k) -> !watched.contains(k.replaceAll("\\|.*$", "")));
            p.edit().putStringSet("seen", new HashSet<>(seen)).putStringSet("offline", new HashSet<>(offline)).putStringSet("hot", new HashSet<>(hot)).apply();
            try {
                Thread.sleep(POLL_MS);
            } catch (InterruptedException e) {
                break;
            }
        }
    }

    // Whether this phone could reach a computer now: on a network at all, and for one reached over
    // Tailscale (its 100.x address, a .ts.net name, or a name without dots, as "pi"), with a VPN
    // (Tailscale) on. Otherwise its not answering says nothing about it.
    private boolean canReach(String rig) {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        if (cm == null || cm.getActiveNetwork() == null) return false;
        String h = rig.replaceAll(":\\d+$", "").toLowerCase(Locale.ROOT);
        boolean tailnet = h.endsWith(".ts.net") || (!h.contains(".") && !h.contains(":")) || h.matches("^100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\..*");
        if (!tailnet) return true;
        for (Network n : cm.getAllNetworks()) {
            NetworkCapabilities c = cm.getNetworkCapabilities(n);
            if (c != null && c.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return true;
        }
        return false;
    }

    private static String nameOf(String rig, Map<String, String> names) {
        String n = names.get(rig);
        return n != null && !n.isEmpty() ? n : rig.replaceAll(":\\d+$", "");
    }

    private static int offlineId(String rig) {
        return 2000 + Math.floorMod(rig.hashCode(), 500);
    }

    // Too hot, as its state says: the computer itself (temperature.hot) or an OAK camera's chip
    // (a camera's chipHot). Told once each time it gets so (in hot, "<rig>|...", while it is).
    private void heat(String rig, String host, JSONObject state, Set<String> hot) {
        JSONObject t = state.optJSONObject("temperature");
        String self = rig + "|device";
        if (t != null && t.optBoolean("hot")) {
            if (hot.add(self)) device(2500 + Math.floorMod(self.hashCode(), 500), rig, host + " is too hot", t.optString("text", "Too hot"), android.R.drawable.ic_dialog_alert);
        } else {
            hot.remove(self);
        }
        JSONArray cams = state.optJSONArray("cameras");
        Set<String> now = new HashSet<>();
        for (int i = 0; cams != null && i < cams.length(); i++) {
            JSONObject c = cams.optJSONObject(i);
            if (c == null || !c.optBoolean("chipHot")) continue;
            String name = c.optString("name", "A camera"), k = rig + "|chip:" + name;
            now.add(k);
            if (hot.add(k)) {
                device(2500 + Math.floorMod(k.hashCode(), 500), rig, host + ": " + name + "'s camera is too hot", "Its chip is at " + Math.round(c.optDouble("chipC", 0)) + " °C", android.R.drawable.ic_dialog_alert);
            }
        }
        hot.removeIf((k) -> k.startsWith(rig + "|chip:") && !now.contains(k));
    }

    // Tapped: the computer's remote recording page in the app.
    private void device(int id, String rig, String title, String text, int icon) {
        Notification n = new Notification.Builder(this, CHANNEL_DEVICE)
                .setSmallIcon(icon)
                .setContentTitle(title)
                .setContentText(text)
                .setShowWhen(true)
                .setAutoCancel(true)
                .setContentIntent(openPage(id, rigPage(rig)))
                .build();
        getSystemService(NotificationManager.class).notify(id, n);
    }

    // Tapped: the alert's video, on the computer's page in the app (its photo until it's saved).
    private void notify(String rig, String key, String host, JSONObject e, int n) {
        String camera = e.optString("camera", "A camera");
        String photo = e.optString("photo", "");
        if (e.isNull("photo")) photo = "";
        // Its take's name (its photo's, less the ending), for once the computer no longer lists it.
        String take = photo.replaceAll("( \\(\\d+\\))?\\.[A-Za-z0-9]+$", "");
        String page = rigPage(rig) + "#alert=" + e.optString("id") + (take.isEmpty() ? "" : "&take=" + enc(take));
        Notification.Builder b = new Notification.Builder(this, CHANNEL_ALERT)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle("Sentry: " + camera)
                .setContentText("Movement on " + host)
                .setWhen(e.optLong("at", System.currentTimeMillis()))
                .setShowWhen(true)
                .setCategory(Notification.CATEGORY_ALARM)
                .setAutoCancel(true)
                .setContentIntent(openPage(100 + (n % 500), page));
        if (!photo.isEmpty()) {
            try {
                String path = "/api/take?f=" + URLEncoder.encode(photo, "UTF-8").replace("+", "%20") + "&at=0";
                RemotePlugin.RigAnswer a = RemotePlugin.fetchRig(this, rig, path, "GET", "", key);
                Bitmap bmp = a.status == 200 ? BitmapFactory.decodeByteArray(a.body, 0, a.body.length) : null;
                if (bmp != null) b.setLargeIcon(bmp).setStyle(new Notification.BigPictureStyle().bigPicture(bmp).setSummaryText("Movement on " + host));
            } catch (Exception ignored) {
                // the text alone, then
            }
        }
        getSystemService(NotificationManager.class).notify(1000 + (n % 500), b.build());
    }
}
