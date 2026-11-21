package com.handtracker.app;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/**
 * Pi Cluster's hourly look for a newer build of this phone's apps, on Wi-Fi (an unmetered network:
 * a build is over 200 MB), even when it isn't open (Android's JobScheduler, kept through restarts):
 * AppUpdates.autoUpdate updates them by itself, unless the phone is recording or saving a take.
 * Scheduled when Pi Cluster opens (AppUpdatePlugin).
 */
public class AppUpdateJob extends JobService {
    static final int ID = 4701;
    private static final long HOUR_MS = 3600L * 1000;

    static void schedule(Context ctx) {
        JobScheduler js = ctx.getSystemService(JobScheduler.class);
        if (js == null) return;
        JobInfo had = js.getPendingJob(ID);
        if (had != null && had.getIntervalMillis() == HOUR_MS && had.getNetworkType() == JobInfo.NETWORK_TYPE_UNMETERED) return;
        js.schedule(new JobInfo.Builder(ID, new ComponentName(ctx, AppUpdateJob.class))
                .setPeriodic(HOUR_MS)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_UNMETERED)
                .setPersisted(true)
                .build());
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            try {
                AppUpdates.autoUpdate(getApplicationContext());
            } catch (Exception e) {
                AppUpdates.said(getApplicationContext(), "Couldn't look: " + (e.getMessage() == null ? e.toString() : e.getMessage()));
            }
            jobFinished(params, false);
        }, "app-update-look").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }
}
