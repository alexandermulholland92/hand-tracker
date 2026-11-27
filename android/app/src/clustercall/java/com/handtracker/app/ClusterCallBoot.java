package com.handtracker.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** ClusterCallBoot — Cluster Call ready for calls again after the phone restarts or the app is updated, when "Ring when
 *  closed" is on (ClusterCallService.java). */
public class ClusterCallBoot extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? "" : String.valueOf(intent.getAction());
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return;
        if (ClusterCallService.ringWhenClosed(context)) ClusterCallService.start(context);
    }
}
