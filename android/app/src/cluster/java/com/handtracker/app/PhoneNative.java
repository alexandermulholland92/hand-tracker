package com.handtracker.app;

import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.net.TrafficStats;
import android.os.BatteryManager;
import android.os.Build;
import android.os.PowerManager;
import android.os.StatFs;
import android.os.SystemClock;

import com.arthenica.ffmpegkit.FFmpegKit;
import com.arthenica.ffmpegkit.FFmpegSession;
import com.arthenica.ffmpegkit.FFprobeKit;
import com.arthenica.ffmpegkit.FFprobeSession;
import com.arthenica.ffmpegkit.ReturnCode;
import com.arthenica.ffmpegkit.Session;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * PhoneNative — what Cluster's service, run in this app's Python (MemberService), asks of this phone
 * (cluster/node/phonesys.py, through Chaquopy's Java bridge): call(name, argsJson) -> JSON.
 *   "readings": its model, memory, battery (level, plugged in, charging) and temperature, its Wi-Fi's strength and
 *               band (not its name: that needs the location permission), the storage of the app's files, how long
 *               it's been on, and how hot Android says it is (thermal: 0 none to 6 shutting down).
 *   "ffmpeg-start" { args, probe }: ffmpeg (or ffprobe) with those options, in the app (FFmpegKit) -> { id }
 *   "ffmpeg-poll" { id }: its log since the last ask, its progress (time: ms of the output done) -> { log, time, done, code }
 *   "ffmpeg-cancel" { id }: stopped
 *   "ffmpeg-run" { args, probe, timeout (s) }: to the end -> { code, log, output (ffprobe's) }
 *   "transmission-start" { config }: this phone's own Transmission (TransmissionNative), its settings in that folder
 *   "transmission-stop", "transmission-running" -> { running }
 *   "net": what this phone's network has received and sent since it started (bytes), and its Wi-Fi's speed (Mbit/s)
 * (cluster/node/phonetools.py: a job's ffmpeg on a phone.) Only the Cluster app has it (the "cluster" flavor).
 */
public final class PhoneNative {
    static volatile Context app; // (MemberService's, as it starts)

    private PhoneNative() {
    }

    public static String call(String name, String argsJson) {
        try {
            JSONObject args = new JSONObject(argsJson == null || argsJson.isEmpty() ? "{}" : argsJson);
            if (app == null) return error("The app isn't ready.");
            if ("readings".equals(name)) return readings(app).toString();
            if ("ffmpeg-start".equals(name)) return ffmpegStart(args).toString();
            if ("ffmpeg-poll".equals(name)) return ffmpegPoll(args.optLong("id", -1)).toString();
            if ("ffmpeg-cancel".equals(name)) {
                FFmpegKit.cancel(args.optLong("id", -1));
                return new JSONObject().put("ok", true).toString();
            }
            if ("ffmpeg-run".equals(name)) return ffmpegRun(args).toString();
            if ("transmission-start".equals(name)) {
                if (!TransmissionNative.load()) return error("This app has no Transmission of its own.");
                String why = TransmissionNative.start(args.optString("config", ""), TransmissionNative.caBundle(app));
                return why.isEmpty() ? new JSONObject().put("ok", true).toString() : error(why);
            }
            if ("transmission-stop".equals(name)) {
                if (TransmissionNative.load()) TransmissionNative.stop();
                return new JSONObject().put("ok", true).toString();
            }
            if ("transmission-running".equals(name)) {
                return new JSONObject().put("ok", true).put("running", TransmissionNative.load() && TransmissionNative.running()).toString();
            }
            if ("net".equals(name)) {
                JSONObject n = new JSONObject().put("ok", true).put("rx", TrafficStats.getTotalRxBytes()).put("tx", TrafficStats.getTotalTxBytes());
                WifiManager wm = app.getApplicationContext().getSystemService(WifiManager.class);
                WifiInfo wi = wm != null ? wm.getConnectionInfo() : null;
                if (wi != null && wi.getLinkSpeed() > 0) n.put("mbit", wi.getLinkSpeed());
                return n.toString();
            }
            return error("No " + name + " here.");
        } catch (Exception e) {
            return error(String.valueOf(e));
        }
    }

    static String error(String why) {
        try {
            return new JSONObject().put("ok", false).put("error", why).toString();
        } catch (JSONException e) {
            return "{\"ok\":false}";
        }
    }

    // ----- ffmpeg (FFmpegKit), for the jobs -----
    private static final Map<Long, Run> runs = new ConcurrentHashMap<>();

    static final class Run {
        final StringBuilder log = new StringBuilder();
        volatile boolean done;
        volatile int code = -1;
        volatile long time = -1;
        volatile String output = "";
        final CountDownLatch ended = new CountDownLatch(1);
    }

    private static String[] argv(JSONObject args) throws JSONException {
        JSONArray a = args.getJSONArray("args");
        String[] out = new String[a.length()];
        for (int i = 0; i < out.length; i++) out[i] = a.getString(i);
        return out;
    }

    private static void ended(Run r, Session s) {
        ReturnCode rc = s.getReturnCode();
        r.code = rc == null ? -1 : rc.getValue();
        if (s instanceof FFprobeSession) r.output = s.getOutput() == null ? "" : s.getOutput();
        r.done = true;
        r.ended.countDown();
    }

    // (its session's id; the Run kept by it until its end has been asked for)
    private static long start(JSONObject args) throws JSONException {
        Run r = new Run();
        String[] a = argv(args);
        Session s;
        if (args.optBoolean("probe", false)) {
            s = FFprobeKit.executeWithArgumentsAsync(a, session -> ended(r, session), log -> {
                synchronized (r.log) {
                    r.log.append(log.getMessage());
                }
            });
        } else {
            s = FFmpegKit.executeWithArgumentsAsync(a, session -> ended(r, session), log -> {
                synchronized (r.log) {
                    r.log.append(log.getMessage());
                }
            }, stats -> r.time = (long) stats.getTime());
        }
        runs.put(s.getSessionId(), r);
        return s.getSessionId();
    }

    private static JSONObject ffmpegStart(JSONObject args) throws JSONException {
        return new JSONObject().put("ok", true).put("id", start(args));
    }

    private static JSONObject ffmpegPoll(long id) throws JSONException {
        Run r = runs.get(id);
        if (r == null) return new JSONObject().put("ok", false).put("error", "No such ffmpeg.");
        String text;
        synchronized (r.log) {
            text = r.log.toString();
            r.log.setLength(0);
        }
        boolean done = r.done;
        if (done) runs.remove(id);
        return new JSONObject().put("ok", true).put("log", text).put("time", r.time).put("done", done).put("code", r.code);
    }

    private static JSONObject ffmpegRun(JSONObject args) throws JSONException, InterruptedException {
        long id = start(args);
        Run r = runs.get(id);
        long seconds = Math.max(1, args.optLong("timeout", 60));
        if (!r.ended.await(seconds, TimeUnit.SECONDS)) {
            FFmpegKit.cancel(id);
            r.ended.await(10, TimeUnit.SECONDS);
        }
        runs.remove(id);
        String text;
        synchronized (r.log) {
            text = r.log.toString();
        }
        return new JSONObject().put("ok", true).put("code", r.code).put("log", text).put("output", r.output);
    }

    static JSONObject readings(Context c) throws JSONException {
        JSONObject r = new JSONObject();
        r.put("model", Build.MANUFACTURER + " " + Build.MODEL + " (Android " + Build.VERSION.RELEASE + ")");
        r.put("cores", Runtime.getRuntime().availableProcessors());
        ActivityManager am = c.getSystemService(ActivityManager.class);
        if (am != null) {
            ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            r.put("memory", new JSONObject().put("total", mi.totalMem).put("available", mi.availMem));
        }
        // (the battery's last broadcast: no receiver kept)
        Intent b = c.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (b != null) {
            int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1), scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            int plugged = b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0), status = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            int temp = b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE);
            if (level >= 0 && scale > 0) {
                boolean charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL;
                r.put("battery", new JSONObject().put("level", Math.round(level * 100f / scale)).put("plugged", plugged != 0).put("charging", charging));
            }
            if (temp != Integer.MIN_VALUE) r.put("tempC", Math.round(temp / 10f));
        }
        PowerManager pm = c.getSystemService(PowerManager.class);
        if (pm != null && Build.VERSION.SDK_INT >= 29) r.put("thermal", pm.getCurrentThermalStatus());
        WifiManager wm = c.getApplicationContext().getSystemService(WifiManager.class);
        WifiInfo wi = wm != null ? wm.getConnectionInfo() : null;
        if (wi != null && wi.getRssi() > -127 && wi.getFrequency() > 0) {
            r.put("wifi", new JSONObject().put("dbm", wi.getRssi()).put("mhz", wi.getFrequency()));
        }
        StatFs st = new StatFs(c.getFilesDir().getAbsolutePath());
        r.put("drives", new JSONArray().put(new JSONObject().put("mount", "phone").put("total", st.getTotalBytes()).put("free", st.getAvailableBytes())));
        r.put("uptime", SystemClock.elapsedRealtime() / 1000);
        return r;
    }
}
