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
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/**
 * Sentry mode's alerts on this phone, from the computers it's told to watch ("Alerts on this
 * phone" in Sentry mode on a computer's remote recording page; the Hand Tracker app's own way,
 * the other is the ntfy app). A foreground service, with a quiet notification saying it's
 * watching, that asks each computer for its state every POLL_MS (over Tailscale from anywhere,
 * or on the same Wi-Fi with the computer's code) and shows a notification, with the photo, for
 * each new alert a computer's Sentry mode has. Started and stopped by SentryWatchPlugin.java;
 * the computers are kept in its SharedPreferences, so it carries on after a restart of the app.
 */
public class SentryWatchService extends Service {
    static final String PREFS = "sentry-watch";
    static final String ACTION_STOP = "com.handtracker.app.STOP_SENTRY_WATCH";
    private static final String CHANNEL_ON = "sentry-watch";
    private static final String CHANNEL_ALERT = "sentry-alerts";
    private static final int NOTIFICATION_ID = 11;
    private static final long POLL_MS = 15000;

    static volatile SentryWatchService running;
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
    }

    private PendingIntent openApp(int code) {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, code, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification watchingNotification() {
        Intent stopIt = new Intent(this, SentryWatchService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stopIt, PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL_ON)
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentTitle("Watching for Sentry alerts")
                .setContentText("From your computers' Sentry mode")
                .setContentIntent(openApp(0))
                .addAction(new Notification.Action.Builder(null, "Stop", stopPi).build())
                .setOngoing(true)
                .build();
    }

    // Each computer in turn, every POLL_MS; an alert not seen before is a notification. The first
    // look at a computer only notes what it has (they're not new to this phone).
    private void watch() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        Set<String> seen = new HashSet<>(p.getStringSet("seen", new HashSet<>()));
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
                try {
                    RemotePlugin.RigAnswer a = RemotePlugin.fetchRig(rig, "/api/state", "GET", "", key);
                    if (a.status != 200) continue;
                    JSONObject state = new JSONObject(new String(a.body, StandardCharsets.UTF_8));
                    JSONObject sentry = state.optJSONObject("sentry");
                    if (sentry == null) {
                        looked.add(rig);
                        continue;
                    }
                    JSONArray events = sentry.optJSONArray("events");
                    String host = state.optString("host", rig.replaceAll(":\\d+$", ""));
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
                    // not reachable now (off, or this phone off Tailscale): next time
                }
            }
            // Only the alerts the computers still list are worth remembering.
            if (seen.size() > 400) seen.clear();
            p.edit().putStringSet("seen", new HashSet<>(seen)).apply();
            try {
                Thread.sleep(POLL_MS);
            } catch (InterruptedException e) {
                break;
            }
        }
    }

    private void notify(String rig, String key, String host, JSONObject e, int n) {
        String camera = e.optString("camera", "A camera");
        Notification.Builder b = new Notification.Builder(this, CHANNEL_ALERT)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle("Sentry: " + camera)
                .setContentText("Movement on " + host)
                .setWhen(e.optLong("at", System.currentTimeMillis()))
                .setShowWhen(true)
                .setCategory(Notification.CATEGORY_ALARM)
                .setAutoCancel(true)
                .setContentIntent(openApp(100 + n));
        String photo = e.optString("photo", "");
        if (!photo.isEmpty()) {
            try {
                String path = "/api/take?f=" + URLEncoder.encode(photo, "UTF-8").replace("+", "%20") + "&at=0";
                RemotePlugin.RigAnswer a = RemotePlugin.fetchRig(rig, path, "GET", "", key);
                Bitmap bmp = a.status == 200 ? BitmapFactory.decodeByteArray(a.body, 0, a.body.length) : null;
                if (bmp != null) b.setLargeIcon(bmp).setStyle(new Notification.BigPictureStyle().bigPicture(bmp).setSummaryText("Movement on " + host));
            } catch (Exception ignored) {
                // the text alone, then
            }
        }
        getSystemService(NotificationManager.class).notify(1000 + (n % 500), b.build());
    }
}
