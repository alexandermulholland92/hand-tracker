package com.handtracker.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Sentry mode's alerts on this phone (SentryWatchService.java) started again after the phone
 * restarts or the app is updated, if they were on: Android doesn't start a service again itself
 * then. (The app opening does the same: SentryWatchPlugin.java.)
 */
public class SentryWatchBoot extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent == null ? "" : String.valueOf(intent.getAction());
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return;
        SentryWatchService.startIfOn(ctx);
    }
}
