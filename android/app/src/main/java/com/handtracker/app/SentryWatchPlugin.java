package com.handtracker.app;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.regex.Pattern;

/**
 * Sentry mode's alerts on this phone (SentryWatchService.java): sentry.js turns it on with the
 * computers in remote recording's list (name:port, and its code if it has one), and off.
 *   start({ rigs: [{ rig, key }] }) / stop() / status() -> { on, rigs }
 */
@CapacitorPlugin(name = "SentryWatch")
public class SentryWatchPlugin extends Plugin {
    private static final Pattern RIG = Pattern.compile("^[A-Za-z0-9.\\[\\]:-]{1,200}:\\d{1,5}$");
    private static final Pattern KEY = Pattern.compile("^[A-Za-z0-9_-]{0,64}$");

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(SentryWatchService.PREFS, android.content.Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void start(PluginCall call) {
        JSArray list = call.getArray("rigs", new JSArray());
        JSONArray rigs = new JSONArray();
        try {
            for (int i = 0; i < list.length() && rigs.length() < 16; i++) {
                JSONObject r = list.getJSONObject(i);
                String rig = r.optString("rig", ""), key = r.optString("key", "");
                if (!RIG.matcher(rig).matches() || !KEY.matcher(key).matches()) continue;
                JSONObject one = new JSONObject();
                one.put("rig", rig);
                one.put("key", key);
                rigs.put(one);
            }
        } catch (Exception e) {
            call.reject("Those aren't computers' names.");
            return;
        }
        if (rigs.length() == 0) {
            call.reject("No computers to watch: open one in Remote recording first.");
            return;
        }
        // Android 13 and newer ask before an app shows notifications.
        if (Build.VERSION.SDK_INT >= 33 && getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            getActivity().requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 41);
        }
        prefs().edit().putString("rigs", rigs.toString()).putBoolean("on", true).apply();
        getContext().startForegroundService(new Intent(getContext(), SentryWatchService.class));
        call.resolve(status());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        prefs().edit().putBoolean("on", false).apply();
        getContext().stopService(new Intent(getContext(), SentryWatchService.class));
        call.resolve(status());
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(status());
    }

    private JSObject status() {
        JSObject s = new JSObject();
        s.put("on", prefs().getBoolean("on", false));
        try {
            JSONArray rigs = new JSONArray(prefs().getString("rigs", "[]"));
            JSArray names = new JSArray();
            for (int i = 0; i < rigs.length(); i++) names.put(rigs.getJSONObject(i).optString("rig"));
            s.put("rigs", names);
        } catch (Exception e) {
            s.put("rigs", new JSArray());
        }
        return s;
    }
}
