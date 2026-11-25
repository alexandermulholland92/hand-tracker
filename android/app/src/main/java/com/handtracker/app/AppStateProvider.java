package com.handtracker.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;

/**
 * Whether this app is recording or saving a take just now, for Cluster on the same phone, which
 * doesn't update the phone's apps meanwhile (AppUpdates.recording). The page says so
 * (remote-record-ui.js, through RigServerPlugin.setBusy) as it starts, and every 30 seconds while it
 * records or saves; it counts as busy until 2 minutes after the last time it said so (the take's
 * files written meanwhile, or a page that went away). Only Hand Tracker's own apps may ask: they're
 * signed with the same key (the signature permission com.handtracker.permission.APP_STATE).
 *   call("busy") -> { busy }
 */
public class AppStateProvider extends ContentProvider {
    static final String PERMISSION = "com.handtracker.permission.APP_STATE";
    private static final long GRACE_MS = 2 * 60 * 1000;
    private static volatile long busyAt = -1;

    static void tell(boolean busy) {
        if (busy) busyAt = SystemClock.elapsedRealtime();
    }

    static boolean busy() {
        return busyAt >= 0 && SystemClock.elapsedRealtime() - busyAt < GRACE_MS;
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Bundle call(String method, String arg, Bundle extras) {
        if (getContext() == null || getContext().checkCallingPermission(PERMISSION) != PackageManager.PERMISSION_GRANTED) {
            throw new SecurityException("Only Hand Tracker's own apps ask this.");
        }
        Bundle out = new Bundle();
        if ("busy".equals(method)) out.putBoolean("busy", busy());
        return out;
    }

    // (nothing to look up, add, change or take away)
    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sortOrder) {
        return null;
    }

    @Override
    public String getType(Uri uri) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] args) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) {
        return 0;
    }
}
