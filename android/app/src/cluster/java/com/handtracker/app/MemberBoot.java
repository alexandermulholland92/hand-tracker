package com.handtracker.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * This phone back in the cluster after it restarts or the app is updated, if its switch was on (MemberService.java).
 */
public class MemberBoot extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) MemberService.startIfOn(context);
    }
}
