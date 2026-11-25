package com.handtracker.app;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;

/**
 * How an app's install through Android's PackageInstaller went (AppUpdates.install): done, or not
 * with Android's reason, or Android asking first. Its question is shown here when Cluster is in use
 * (the Update button), or, for an hourly update with no one looking, put in a notification to answer
 * later (AppUpdates.autoUpdate). Passed on to whoever waits for it (AppUpdates.update).
 */
public class AppUpdateResult extends BroadcastReceiver {
    static final String EXTRA_PKG = "com.handtracker.app.UPDATE_PKG";
    static final String EXTRA_BACKGROUND = "com.handtracker.app.UPDATE_BACKGROUND";
    static final String ASKS = "Android asks first"; // (the error given when its question went to a notification)

    interface Listener {
        void result(String pkg, boolean ok, String error);
    }

    static volatile Listener listener;

    @Override
    @SuppressWarnings("deprecation")
    public void onReceive(Context ctx, Intent intent) {
        String pkg = intent.getStringExtra(EXTRA_PKG);
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent ask = Build.VERSION.SDK_INT >= 33 ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class) : intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (ask == null) {
                tell(pkg, false, "Android wanted to ask first, but gave nothing to ask with.");
                return;
            }
            ask.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (intent.getBooleanExtra(EXTRA_BACKGROUND, false)) {
                PendingIntent later = PendingIntent.getActivity(ctx, pkg == null ? 0 : pkg.hashCode(), ask, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                AppUpdates.notify(ctx, "Update " + AppUpdates.nameOf(pkg) + "?", "Android asks before Cluster updates " + AppUpdates.nameOf(pkg) + ". Tap to answer.", later);
                tell(pkg, false, ASKS);
                return;
            }
            try {
                ctx.startActivity(ask);
            } catch (RuntimeException e) {
                tell(pkg, false, "Android's question couldn't be shown: " + e.getMessage());
            }
            return;
        }
        if (status == PackageInstaller.STATUS_SUCCESS) {
            AppUpdates.resultLater(ctx, pkg, true, null); // (one an hourly look left installing: in its note)
            tell(pkg, true, null);
            return;
        }
        String why = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        if (status == PackageInstaller.STATUS_FAILURE_ABORTED) why = "Not installed: it was cancelled.";
        else if (status == PackageInstaller.STATUS_FAILURE_CONFLICT) why = "It conflicts with the copy on this phone (signed with another key?)" + (why != null ? ": " + why : ".");
        else if (status == PackageInstaller.STATUS_FAILURE_STORAGE) why = "Not enough room on this phone.";
        if (why == null) why = "Android didn't install it (" + status + ").";
        AppUpdates.resultLater(ctx, pkg, false, why);
        tell(pkg, false, why);
    }

    private static void tell(String pkg, boolean ok, String error) {
        Listener l = listener;
        if (l != null) l.result(pkg, ok, error);
    }
}
