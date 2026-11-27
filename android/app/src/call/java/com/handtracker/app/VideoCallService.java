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
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * VideoCallService — Video Call on an Android phone, kept ready in the background (a foreground service, its
 * notification "Ready for calls"): it runs the phone's call service (VideoCallServer.java, port 47860), so your
 * devices can ring the phone with the app closed. A call that comes then rings (the incoming call notification,
 * over the lock screen where the phone allows it) and opens the app on it; while the app is open, each signal goes
 * straight to its page (VideoCallPlugin.java). Started by the app, and when the phone starts when "Ring when closed"
 * is on (VideoCallBoot.java).
 *
 * Your devices, as a computer of yours announced them (a phone can't ask Tailscale), are kept in its preferences.
 */
public class VideoCallService extends Service implements VideoCallServer.Listener {
    static final String PREFS = "video_call";
    static final String CHANNEL_READY = "video_call_ready";
    static final String CHANNEL_RING = "video_call_ring";
    static final int NOTE_READY = 4701;
    static final int NOTE_RING = 4702;
    static final String EXTRA_RING = "com.handtracker.app.VIDEO_CALL_RING";

    /** The page while it's there: each signal goes to it. */
    interface Page {
        void onSignal(Map<String, Object> signal);
    }

    static volatile Page page;
    private static final List<Map<String, Object>> waiting = new ArrayList<>();
    private VideoCallServer server;
    private String startError = "";
    static volatile VideoCallService running;

    static void start(Context context) {
        Intent i = new Intent(context, VideoCallService.class);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i);
        else context.startService(i);
    }

    static boolean ringWhenClosed(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("ringWhenClosed", true);
    }

    static String deviceName(Context context) {
        String n = null;
        try {
            n = Settings.Global.getString(context.getContentResolver(), Settings.Global.DEVICE_NAME);
        } catch (RuntimeException ignored) {
        }
        return n == null || n.trim().isEmpty() ? Build.MODEL : n.trim();
    }

    /** The signals that came before the page listened (the call that opened the app), taken once. */
    static synchronized List<Map<String, Object>> takeWaiting() {
        List<Map<String, Object>> out = new ArrayList<>(waiting);
        waiting.clear();
        return out;
    }

    private static synchronized void keep(Map<String, Object> signal) {
        waiting.add(signal);
        while (waiting.size() > 20) waiting.remove(0);
    }

    String error() {
        return startError;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        running = this;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm != null) {
            NotificationChannel ready = new NotificationChannel(CHANNEL_READY, "Ready for calls", NotificationManager.IMPORTANCE_MIN);
            ready.setDescription("Shown while Video Call waits for calls in the background.");
            nm.createNotificationChannel(ready);
            NotificationChannel ring = new NotificationChannel(CHANNEL_RING, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
            ring.setDescription("A video call from one of your devices.");
            ring.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                    new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            ring.enableVibration(true);
            nm.createNotificationChannel(ring);
        }
        Notification n = readyNotification();
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTE_READY, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTE_READY, n);
        server = new VideoCallServer(deviceName(this), VideoCallServer.PORT, false, this);
        try {
            server.start();
        } catch (IOException e) {
            startError = "Calls can't come in: port " + VideoCallServer.PORT + " is taken (" + e.getMessage() + ").";
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = null;
        if (server != null) server.stop();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private PendingIntent openApp(boolean ring) {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (ring) i.putExtra(EXTRA_RING, true);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getActivity(this, ring ? 2 : 1, i, flags);
    }

    private Notification readyNotification() {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL_READY) : new Notification.Builder(this);
        return b.setSmallIcon(android.R.drawable.sym_call_incoming)
                .setContentTitle("Video Call")
                .setContentText("Ready for calls from your devices")
                .setContentIntent(openApp(false))
                .setOngoing(true)
                .build();
    }

    /** A call coming with the app not open (or in the background): the incoming call notification, which rings. */
    private void ring(Map<String, Object> signal) {
        Object from = signal.get("from");
        String who = from instanceof Map && ((Map<?, ?>) from).get("name") instanceof String ? (String) ((Map<?, ?>) from).get("name") : "One of your devices";
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL_RING) : new Notification.Builder(this);
        b.setSmallIcon(android.R.drawable.sym_call_incoming)
                .setContentTitle(who + " is calling")
                .setContentText("Video Call: tap to answer")
                .setCategory(Notification.CATEGORY_CALL)
                .setContentIntent(openApp(true))
                .setFullScreenIntent(openApp(true), true)
                .setAutoCancel(true)
                .setOngoing(true);
        if (Build.VERSION.SDK_INT >= 26) b.setTimeoutAfter(45000);
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTE_RING, b.build());
    }

    static void stopRinging(Context context) {
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(NOTE_RING);
    }

    // ---------- VideoCallServer.Listener ----------
    @Override
    public Map<String, Object> onSignal(Map<String, Object> signal) {
        Page p = page;
        String kind = String.valueOf(signal.get("kind"));
        if (p != null) {
            p.onSignal(signal);
            if ("offer".equals(kind) && !VideoCallPlugin.inFront) ring(signal); // (the page rings too, once it's in front)
        } else {
            keep(signal);
            if ("offer".equals(kind)) ring(signal);
        }
        if ("cancel".equals(kind) || "hangup".equals(kind)) stopRinging(this);
        return null;
    }

    @Override
    public void onAnnounce(List<Map<String, Object>> devices, String from) {
        SharedPreferences.Editor e = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
        e.putString("devices", VideoCallServer.json(devices));
        e.putLong("devicesAt", System.currentTimeMillis());
        e.apply();
    }
}
