package com.handtracker.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * PhoneControl — controlling the phone itself with your hand (PhoneControlService.java,
 * HandControlService.java), for the "Control your PC" card on the phone (phone-link-ui.js):
 *
 *   status() -> { overlay, accessibility, running }   the two permissions it needs, and whether it's on
 *   openOverlaySettings()          Android's "Display over other apps" page for this app
 *   openAccessibilitySettings()    Android's Accessibility settings (turn on Hand Tracker there)
 *   start({ settings })            settings: JSON for phone-control.js (hand, reach, gesture actions…)
 *   stop()
 *   "stopped" event                when it ends (its × or the notification's Stop)
 */
@CapacitorPlugin(name = "PhoneControl")
public class PhoneControlPlugin extends Plugin {
    @Override
    public void load() {
        PhoneControlService.onStopped = () -> notifyListeners("stopped", new JSObject());
    }

    private JSObject state() {
        Context c = getContext();
        JSObject s = new JSObject();
        s.put("overlay", Settings.canDrawOverlays(c));
        s.put("accessibility", HandControlService.isEnabled(c));
        s.put("running", PhoneControlService.running != null);
        return s;
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(state());
    }

    @PluginMethod
    public void openOverlaySettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void start(PluginCall call) {
        Context c = getContext();
        if (!Settings.canDrawOverlays(c)) {
            call.reject("Allow Hand Tracker to display over other apps first.");
            return;
        }
        Intent i = new Intent(c, PhoneControlService.class);
        i.putExtra(PhoneControlService.EXTRA_SETTINGS, call.getString("settings", "{}"));
        try {
            ContextCompat.startForegroundService(c, i);
        } catch (Exception e) {
            call.reject("Couldn't start: " + e.getMessage());
            return;
        }
        call.resolve(state());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), PhoneControlService.class));
        call.resolve(state());
    }
}
