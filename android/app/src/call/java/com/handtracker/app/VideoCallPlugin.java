package com.handtracker.app;

import android.Manifest;
import android.app.Activity;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.view.WindowManager;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * VideoCall — Video Call's page (video-call-page.js) on an Android phone, as electron/preload.js's desktop.call is on
 * a computer: hello() -> { me, waiting, settings, shown, error }, devices() -> { devices }, send({ address, signal })
 * -> its reply, settings({ ringWhenClosed }), inCall({ on }) (the screen kept on, and over the lock screen, only
 * while a call rings or goes on); events "signal" (each call's signal) and "shown" ({ on }: the app in front).
 * The service itself: VideoCallService.java (kept going in the background), VideoCallServer.java.
 */
@CapacitorPlugin(name = "VideoCall")
public class VideoCallPlugin extends Plugin implements VideoCallService.Page {
    static volatile boolean inFront;
    private final ExecutorService pool = Executors.newCachedThreadPool();

    @Override
    public void load() {
        VideoCallService.start(getContext());
        VideoCallService.page = this;
        // (the incoming call notification needs this on Android 13+)
        Activity a = getActivity();
        if (Build.VERSION.SDK_INT >= 33 && a != null && ContextCompat.checkSelfPermission(a, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(a, new String[] {Manifest.permission.POST_NOTIFICATIONS}, 4703);
        }
    }

    @Override
    protected void handleOnResume() {
        inFront = true;
        VideoCallService.page = this;
        VideoCallService.stopRinging(getContext()); // (the page rings now)
        JSObject o = new JSObject();
        o.put("on", true);
        notifyListeners("shown", o);
    }

    @Override
    protected void handleOnPause() {
        inFront = false;
        JSObject o = new JSObject();
        o.put("on", false);
        notifyListeners("shown", o);
    }

    @Override
    protected void handleOnDestroy() {
        inFront = false;
        if (VideoCallService.page == this) VideoCallService.page = null;
        pool.shutdownNow();
    }

    @Override
    public void onSignal(Map<String, Object> signal) {
        notifyListeners("signal", toJs(signal));
    }

    private static JSObject toJs(Object map) {
        try {
            return JSObject.fromJSONObject(new JSONObject(VideoCallServer.json(map)));
        } catch (Exception e) {
            return new JSObject();
        }
    }

    /** This phone's Tailscale address (100.64.0.0/10), or null. */
    private static String tailscaleAddress() {
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && VideoCallServer.onTailnet(a.getHostAddress())) return a.getHostAddress();
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    @PluginMethod
    public void hello(PluginCall call) {
        VideoCallService.page = this;
        Map<String, Object> me = new LinkedHashMap<>();
        me.put("name", VideoCallService.deviceName(getContext()));
        String ip = tailscaleAddress();
        List<Object> ips = new ArrayList<>();
        if (ip != null) ips.add(ip);
        me.put("ips", ips);
        Map<String, Object> settings = new LinkedHashMap<>();
        settings.put("ringWhenClosed", VideoCallService.ringWhenClosed(getContext()));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("me", me);
        out.put("waiting", new ArrayList<Object>(VideoCallService.takeWaiting()));
        out.put("settings", settings);
        out.put("shown", true);
        VideoCallService s = VideoCallService.running;
        String err = s == null ? "" : s.error();
        if (ip == null) err = (err.isEmpty() ? "" : err + " ") + "This phone isn't on Tailscale: turn Tailscale on to call and be called.";
        out.put("error", err);
        call.resolve(toJs(out));
    }

    /** Your devices, as a computer of yours last announced them, each asked whether it has Video Call now. */
    @PluginMethod
    public void devices(PluginCall call) {
        pool.execute(() -> {
            SharedPreferences p = getContext().getSharedPreferences(VideoCallService.PREFS, android.content.Context.MODE_PRIVATE);
            List<Map<String, Object>> list = new ArrayList<>();
            try {
                Object o = VideoCallServer.parse(p.getString("devices", "[]"));
                if (o instanceof List) for (Object d : (List<?>) o) if (d instanceof Map) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> m = new LinkedHashMap<>((Map<String, Object>) d);
                    list.add(m);
                }
            } catch (RuntimeException ignored) {
            }
            List<Future<Map<String, Object>>> asks = new ArrayList<>();
            for (Map<String, Object> d : list) asks.add(pool.submit(() -> VideoCallServer.hello(String.valueOf(d.get("address")))));
            List<Object> out = new ArrayList<>();
            for (int i = 0; i < list.size(); i++) {
                Map<String, Object> d = list.get(i), h = null;
                try {
                    h = asks.get(i).get(4, TimeUnit.SECONDS);
                } catch (Exception ignored) {
                }
                d.put("app", h != null);
                d.put("online", h != null || Boolean.TRUE.equals(d.get("online")));
                if (h != null && h.get("name") instanceof String && !((String) h.get("name")).isEmpty()) d.put("name", h.get("name"));
                out.add(d);
            }
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("devices", out);
            r.put("announcedAt", p.getLong("devicesAt", 0));
            call.resolve(toJs(r));
        });
    }

    @PluginMethod
    public void send(PluginCall call) {
        String address = call.getString("address", "");
        JSObject signal = call.getObject("signal", new JSObject());
        pool.execute(() -> {
            Object parsed;
            try {
                parsed = VideoCallServer.parse(signal.toString());
            } catch (RuntimeException e) {
                parsed = null;
            }
            Map<String, Object> reply;
            if (!(parsed instanceof Map) || address.isEmpty()) {
                reply = new LinkedHashMap<>();
                reply.put("ok", false);
                reply.put("error", "Nothing to send.");
            } else {
                @SuppressWarnings("unchecked")
                Map<String, Object> s = (Map<String, Object>) parsed;
                reply = VideoCallServer.send(address, s, VideoCallService.deviceName(getContext()));
            }
            call.resolve(toJs(reply));
        });
    }

    @PluginMethod
    public void settings(PluginCall call) {
        SharedPreferences p = getContext().getSharedPreferences(VideoCallService.PREFS, android.content.Context.MODE_PRIVATE);
        Boolean ring = call.getBoolean("ringWhenClosed");
        if (ring != null) p.edit().putBoolean("ringWhenClosed", ring).apply();
        JSObject o = new JSObject();
        o.put("ringWhenClosed", p.getBoolean("ringWhenClosed", true));
        call.resolve(o);
    }

    /** While a call rings or goes on: the screen kept on and the call shown over the lock screen; otherwise neither. */
    @PluginMethod
    public void inCall(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        Activity a = getActivity();
        if (a != null) a.runOnUiThread(() -> {
            if (on) a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            if (Build.VERSION.SDK_INT >= 27) {
                a.setShowWhenLocked(on);
                a.setTurnScreenOn(on);
            }
        });
        if (!on) VideoCallService.stopRinging(getContext());
        call.resolve();
    }
}
