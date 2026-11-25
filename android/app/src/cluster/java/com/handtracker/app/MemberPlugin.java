package com.handtracker.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Member — this phone as a member of the cluster, for the Cluster app's page (cluster.js): its own switch
 * (MemberService.java runs Cluster's service here while it's on, any time it's on).
 *   start({ name?, seeds: [the Pis the app knows, as their Tailscale addresses or names] }) -> status
 *   stop() -> status
 *   status() -> { on, running, name, address (this phone's Tailscale address, "" without), port, error, takes (its
 *       Hand Tracker takes can be shared: All files access on) }
 *   allowTakes() -> status   Android's All files access page for this app (the user turns it on there)
 * Only the Cluster app has it (the "cluster" flavor; MainActivity registers it by name).
 */
@CapacitorPlugin(name = "Member")
public class MemberPlugin extends Plugin {
    private static final Pattern NAME = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$");
    private static final Pattern SEED = Pattern.compile("^[A-Za-z0-9.:-]{1,80}$");

    @Override
    public void load() {
        MemberService.startIfOn(getContext()); // (on as it was left, when the app opens)
    }

    @PluginMethod
    public void start(PluginCall call) {
        Context ctx = getContext();
        SharedPreferences.Editor e = ctx.getSharedPreferences(MemberService.PREFS, Context.MODE_PRIVATE).edit();
        String name = call.getString("name", "");
        if (name != null && NAME.matcher(name).matches()) e.putString("name", name);
        List<String> seeds = new ArrayList<>();
        JSArray given = call.getArray("seeds", new JSArray());
        for (int i = 0; i < given.length() && seeds.size() < 32; i++) {
            String s = given.optString(i, "");
            if (SEED.matcher(s).matches() && !seeds.contains(s)) seeds.add(s);
        }
        if (!seeds.isEmpty()) e.putString("seeds", String.join(",", seeds));
        e.putBoolean("on", true).apply();
        try {
            if (MemberService.running == null) ctx.startForegroundService(new Intent(ctx, MemberService.class));
        } catch (Exception ex) {
            call.reject("This phone couldn't join: " + ex.getMessage());
            return;
        }
        call.resolve(status());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context ctx = getContext();
        ctx.getSharedPreferences(MemberService.PREFS, Context.MODE_PRIVATE).edit().putBoolean("on", false).apply();
        ctx.stopService(new Intent(ctx, MemberService.class));
        call.resolve(status());
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(status());
    }

    // Android's All files access for this app (its Settings page), so this phone's takes can be shared with the cluster.
    @PluginMethod
    public void allowTakes(PluginCall call) {
        if (android.os.Build.VERSION.SDK_INT < 30) { // (before Android 11 it has them already)
            call.resolve(status());
            return;
        }
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, android.net.Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) {
            getContext().startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        call.resolve(status());
    }

    private JSObject status() {
        SharedPreferences p = getContext().getSharedPreferences(MemberService.PREFS, Context.MODE_PRIVATE);
        JSObject o = new JSObject();
        o.put("on", p.getBoolean("on", false));
        o.put("running", MemberService.running != null);
        o.put("name", p.getString("name", MemberService.defaultName()));
        o.put("address", MemberService.findTailscale());
        o.put("port", MemberService.PORT);
        o.put("error", MemberService.lastError);
        // (whether its takes can be shared: All files access, Android 11+; before that, the storage permission it has)
        o.put("takes", android.os.Build.VERSION.SDK_INT < 30 || android.os.Environment.isExternalStorageManager());
        return o;
    }
}
