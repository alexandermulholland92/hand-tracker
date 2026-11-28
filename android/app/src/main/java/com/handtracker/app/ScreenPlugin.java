package com.handtracker.app;

import android.app.Activity;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.util.Rational;
import android.view.View;
import android.view.Window;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * ScreenPlugin ("Screen") — full screen and picture-in-picture for a page's main view (the user, 2026-11-27: "make a
 * fullscreen mode as well as picture in picture to use over other apps"): a call in Cluster Call, a camera full screen in
 * Hand Tracker or Remote Recording (screen-modes.js asks this).
 *
 *   fullScreen({ on })           -> { on }: the status and navigation bars hidden (a swipe from an edge shows them
 *                                   for a moment), or back
 *   pip({ aspect, actions })     -> { ok } | { ok: false, error }: the app, small, over other apps (Android's own
 *                                   picture-in-picture); actions: up to 3 of its buttons there, [{ id, title, icon }],
 *                                   icon one of "mic", "micOff", "camera", "cameraOff", "hangup", "close"
 *   auto({ on, aspect, actions }) -> {}: while on, the app goes small by itself when you leave it (Home, another app),
 *                                   as Android does for a call or a video; off again when the view closes
 *   leave({ toApp })             -> {}: out of picture-in-picture, the app big again (or, toApp false, out of sight)
 *   state()                      -> { pipSupported, inPip, fullScreen }
 * Events: "pip" { on } (it went small or came back), "action" { id } (one of its buttons there pressed).
 * The page keeps to its main view while small (screen-modes.js: class "pip" on the page).
 */
@CapacitorPlugin(name = "Screen")
public class ScreenPlugin extends Plugin {
    static final String ACTION = "com.handtracker.app.SCREEN_ACTION";
    private static ScreenPlugin current;
    private boolean full = false;
    private boolean autoOn = false;
    private Rational aspect = new Rational(16, 9);
    private JSArray actions = new JSArray();
    private BroadcastReceiver receiver;

    @Override
    public void load() {
        current = this;
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String id = intent.getStringExtra("id");
                if (id == null) return;
                JSObject e = new JSObject();
                e.put("id", id);
                notifyListeners("action", e);
            }
        };
        IntentFilter filter = new IntentFilter(ACTION);
        if (Build.VERSION.SDK_INT >= 33) getContext().registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else getContext().registerReceiver(receiver, filter);
    }

    @Override
    protected void handleOnDestroy() {
        if (current == this) current = null;
        try {
            if (receiver != null) getContext().unregisterReceiver(receiver);
        } catch (IllegalArgumentException ignored) {
        }
    }

    static ScreenPlugin current() {
        return current;
    }

    private boolean pipSupported() {
        return Build.VERSION.SDK_INT >= 26 && getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    @PluginMethod
    public void fullScreen(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        Activity a = getActivity();
        a.runOnUiThread(() -> {
            setBars(a, !on);
            full = on;
            JSObject r = new JSObject();
            r.put("on", on);
            call.resolve(r);
        });
    }

    private static void setBars(Activity a, boolean shown) {
        Window w = a.getWindow();
        View decor = w.getDecorView();
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(w, decor);
        if (shown) c.show(WindowInsetsCompat.Type.systemBars());
        else {
            c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            c.hide(WindowInsetsCompat.Type.systemBars());
        }
    }

    @PluginMethod
    public void state(PluginCall call) {
        JSObject r = new JSObject();
        r.put("pipSupported", pipSupported());
        r.put("inPip", Build.VERSION.SDK_INT >= 24 && getActivity().isInPictureInPictureMode());
        r.put("fullScreen", full);
        call.resolve(r);
    }

    private void take(PluginCall call) {
        Double a = call.getDouble("aspect");
        if (a != null && a > 0.1 && a < 10) {
            // (Android takes from 1:2.39 to 2.39:1)
            double v = Math.max(1 / 2.39, Math.min(2.39, a));
            aspect = new Rational((int) Math.round(v * 1000), 1000);
        }
        JSArray list = call.getArray("actions");
        if (list != null) actions = list;
    }

    @PluginMethod
    public void pip(PluginCall call) {
        if (!pipSupported()) {
            call.resolve(error("This phone has no picture-in-picture."));
            return;
        }
        take(call);
        Activity a = getActivity();
        a.runOnUiThread(() -> {
            boolean ok;
            try {
                ok = a.enterPictureInPictureMode(params(false));
            } catch (IllegalStateException | IllegalArgumentException e) {
                call.resolve(error(String.valueOf(e.getMessage())));
                return;
            }
            JSObject r = new JSObject();
            r.put("ok", ok);
            if (!ok) r.put("error", "Android didn't let it go small just now.");
            call.resolve(r);
        });
    }

    @PluginMethod
    public void auto(PluginCall call) {
        take(call);
        autoOn = Boolean.TRUE.equals(call.getBoolean("on", false));
        Activity a = getActivity();
        a.runOnUiThread(() -> {
            if (pipSupported()) {
                try {
                    a.setPictureInPictureParams(params(autoOn));
                } catch (IllegalStateException | IllegalArgumentException ignored) {
                }
            }
            call.resolve(new JSObject());
        });
    }

    /** Out of picture-in-picture: the app big again (toApp), or out of sight (the call over, say). */
    @PluginMethod
    public void leave(PluginCall call) {
        boolean toApp = !Boolean.FALSE.equals(call.getBoolean("toApp", true));
        Activity a = getActivity();
        a.runOnUiThread(() -> {
            if (toApp) a.startActivity(new Intent(a, a.getClass()).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_NEW_TASK));
            else a.moveTaskToBack(true);
            call.resolve(new JSObject());
        });
    }

    /** Leaving the app (Home, another app): small by itself while auto is on (Android 12 on does that itself). */
    void onUserLeaveHint(Activity a) {
        if (!autoOn || !pipSupported() || Build.VERSION.SDK_INT >= 31) return;
        try {
            a.enterPictureInPictureMode(params(true));
        } catch (IllegalStateException | IllegalArgumentException ignored) {
        }
    }

    void onPip(boolean on) {
        JSObject e = new JSObject();
        e.put("on", on);
        notifyListeners("pip", e);
        // (its bars as the page had them, once it's big again)
        if (!on) {
            Activity a = getActivity();
            if (a != null) a.runOnUiThread(() -> setBars(a, !full));
        }
    }

    private PictureInPictureParams params(boolean autoEnter) {
        PictureInPictureParams.Builder b = new PictureInPictureParams.Builder().setAspectRatio(aspect);
        List<RemoteAction> list = new ArrayList<>();
        for (int i = 0; i < actions.length() && list.size() < 3; i++) {
            JSONObject o = actions.optJSONObject(i);
            if (o == null) continue;
            String id = o.optString("id", ""), title = o.optString("title", id);
            if (id.isEmpty()) continue;
            Intent intent = new Intent(ACTION).setPackage(getContext().getPackageName()).putExtra("id", id);
            PendingIntent pi = PendingIntent.getBroadcast(getContext(), id.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            list.add(new RemoteAction(Icon.createWithResource(getContext(), icon(o.optString("icon", ""))), title, title, pi));
        }
        b.setActions(list);
        if (Build.VERSION.SDK_INT >= 31) {
            b.setAutoEnterEnabled(autoEnter);
            b.setSeamlessResizeEnabled(true);
        }
        return b.build();
    }

    private static int icon(String name) {
        switch (name) {
            case "mic": return R.drawable.ic_screen_mic;
            case "micOff": return R.drawable.ic_screen_mic_off;
            case "camera": return R.drawable.ic_screen_camera;
            case "cameraOff": return R.drawable.ic_screen_camera_off;
            case "hangup": return R.drawable.ic_screen_hangup;
            default: return R.drawable.ic_screen_close;
        }
    }

    private static JSObject error(String text) {
        JSObject r = new JSObject();
        r.put("ok", false);
        r.put("error", text);
        return r;
    }
}
