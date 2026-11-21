package com.handtracker.app;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * AppUpdates — Pi Cluster's own app on Android (the "cluster" flavor) updating this phone's Hand
 * Tracker apps, itself too, from GitHub's "Latest build" release (AppUpdates.java; pi-cluster.js:
 * This phone's apps). They also update by themselves every hour on Wi-Fi, unless the phone is
 * recording (AppUpdateJob.java).
 *   apps() -> { apps: [{ pkg, name, installed, commit, updated, self, ours }], canInstall,
 *       recording (an app's name, or null), auto (what the hourly look did last), silent (Android 12+) }
 *   latest() -> { commit, published, apps: { pkg: { asset, size, sha256, url } } }
 *   install({ pkgs, force? }) -> { done: [pkg], failed: [{ pkg, error }], asks: [pkg] }: each
 *       downloaded, checked and installed in turn, Pi Cluster itself last (updating itself closes it);
 *       refused while the phone records, unless force; "progress" { pkg, name, stage: "download" |
 *       "install" | "done" | "failed" | "asks", got, size, error } as it goes
 *   allowInstalls(): Android's page where Pi Cluster is allowed to install apps
 *   notices() -> { granted }: notifications allowed (Android 13 and later ask), for the hourly look's
 * When it opens, the hourly look is scheduled.
 */
@CapacitorPlugin(name = "AppUpdates", permissions = {@Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS})})
public class AppUpdatePlugin extends Plugin {
    private final ExecutorService pool = Executors.newCachedThreadPool();

    @Override
    public void load() {
        AppUpdates.open = true;
        try {
            AppUpdateJob.schedule(getContext());
        } catch (RuntimeException ignored) {
            // (no JobScheduler: the page still looks when it opens)
        }
    }

    @Override
    protected void handleOnResume() {
        AppUpdates.open = true;
    }

    @Override
    protected void handleOnPause() {
        AppUpdates.open = false;
    }

    @PluginMethod
    public void apps(PluginCall call) {
        pool.execute(() -> {
            try {
                JSObject ret = new JSObject();
                ret.put("apps", AppUpdates.apps(getContext()));
                ret.put("canInstall", canInstall());
                ret.put("recording", AppUpdates.recording(getContext()));
                ret.put("auto", AppUpdates.lastSaid(getContext()));
                ret.put("silent", Build.VERSION.SDK_INT >= 31);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(msg(e));
            }
        });
    }

    @PluginMethod
    public void latest(PluginCall call) {
        pool.execute(() -> {
            try {
                call.resolve(JSObject.fromJSONObject(AppUpdates.latest()));
            } catch (Exception e) {
                call.reject(msg(e));
            }
        });
    }

    @PluginMethod
    public void install(PluginCall call) {
        JSArray asked = call.getArray("pkgs");
        boolean force = Boolean.TRUE.equals(call.getBoolean("force", false));
        if (asked == null || asked.length() == 0) {
            call.reject("Which apps?");
            return;
        }
        pool.execute(() -> {
            if (!AppUpdates.LOCK.tryLock()) {
                call.reject("It's updating already.");
                return;
            }
            try {
                String busy = force ? null : AppUpdates.recording(getContext());
                if (busy != null) {
                    call.reject(busy + " is recording or saving a take: the apps update by themselves once it stops.");
                    return;
                }
                List<String> want = new ArrayList<>();
                for (int i = 0; i < asked.length(); i++) want.add(asked.getString(i));
                call.resolve(JSObject.fromJSONObject(AppUpdates.update(getContext(), want, AppUpdates.latest(), false, this::tell)));
            } catch (Exception e) {
                call.reject(msg(e));
            } finally {
                AppUpdates.LOCK.unlock();
            }
        });
    }

    @PluginMethod
    public void allowInstalls(PluginCall call) {
        try {
            Intent i = Build.VERSION.SDK_INT >= 26
                    ? new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()))
                    : new Intent(Settings.ACTION_SECURITY_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (RuntimeException e) {
            call.reject(msg(e));
        }
    }

    @PluginMethod
    public void notices(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            answerNotices(call);
            return;
        }
        requestPermissionForAlias("notifications", call, "noticesAnswered");
    }

    @PermissionCallback
    private void noticesAnswered(PluginCall call) {
        answerNotices(call);
    }

    private void answerNotices(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(ret);
    }

    private boolean canInstall() {
        return Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls();
    }

    private void tell(String pkg, String stage, long got, long size, String error) {
        JSObject p = new JSObject();
        p.put("pkg", pkg);
        p.put("name", AppUpdates.nameOf(pkg));
        p.put("stage", stage);
        p.put("got", got);
        p.put("size", size);
        if (error != null) p.put("error", error);
        notifyListeners("progress", p);
    }

    private static String msg(Exception e) {
        return e.getMessage() == null ? e.toString() : e.getMessage();
    }
}
