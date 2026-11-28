package com.handtracker.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Cluster on a phone updating this phone's Hand Tracker apps, itself too, from GitHub's "Latest
 * build" release (the same builds the Pis take):
 *   apps()        which of them are on this phone, and from which build (each app's manifest says:
 *                 com.handtracker.build, "git:" and the commit; build.gradle puts it in)
 *   latest()      the newest build: the release's commit, and each app's APK with its size and SHA-256
 *   recording()   whether this phone is recording or saving a take just now: Hand Tracker and Remote
 *                 Recording say (AppStateProvider.java)
 *   download()    an APK into this app's cache, checked against that size and SHA-256
 *   install()     through Android's PackageInstaller. Android asks first the first time Cluster
 *                 updates an app (and before it installs a new one); after that, from Android 12, an
 *                 app Cluster installed updates without asking. How it went: AppUpdateResult.java.
 *   autoUpdate()  every hour on Wi-Fi, as often as Android lets it (an app used less is let look less
 *                 often: usually within a few hours) (AppUpdateJob.java): the apps with a newer build
 *                 updated by themselves, unless this phone is recording or saving a take (then at the
 *                 next look); Cluster itself last, and not while it's open. Each is left installing
 *                 after a short wait (Play Protect can take minutes to check one first), its answer
 *                 added to the note when it comes. Those Android would ask about first get a
 *                 notification instead (once for each build), to be updated from Cluster.
 * Used by AppUpdatePlugin.java (cluster.js: This phone's apps) and AppUpdateJob.java.
 */
final class AppUpdates {
    static final String RELEASE = "https://api.github.com/repos/alexandermulholland92/hand-tracker/releases/tags/latest-build";
    // (its package, its name, its APK's name in the release before "-<version>.apk", and that name
    // before the rename, 2026-11-25, which the release has too while phones may still look for it:
    // taken only when the new one isn't there). Cluster last: it's updated after the others, as
    // updating itself closes it.
    static final String[][] APPS = {
            {"com.handtracker.app", "Hand Tracker", "HandTracker"},
            {"com.handtracker.mouse", "Hand Mouse", "HandMouse"},
            {"com.handtracker.remote", "Remote Recording", "RemoteRecording"},
            {"com.handtracker.converter", "Recording Converter", "RecordingConverter"},
            {"com.handtracker.clustercall", "Cluster Call", "ClusterCall"}, // (2026-11-27: offered to phones without it too)
            {"com.handtracker.cluster", "Cluster", "Cluster", "PiCluster"},
    };
    // (the apps that record: they say whether they're recording, AppStateProvider.java)
    static final String[] RECORDERS = {"com.handtracker.app", "com.handtracker.remote"};
    static final String PREFS = "app-updates";
    static final long ASK_MS = 10 * 60 * 1000; // (Android's question, waited for that long)
    // (an hourly one: Play Protect can take minutes to check an app first, seen 2-15 on the Wing, longer
    // than a job may run; so it's left installing, and its answer added to the note when it comes)
    private static final long BACKGROUND_WAIT_MS = 20 * 1000;
    private static final String CHANNEL = "app-updates";
    private static final int NOTIFICATION_ID = 21;
    private static final int MAX_ANSWER = 2 * 1024 * 1024;

    // One update at a time, from the page's button or the hourly look.
    static final ReentrantLock LOCK = new ReentrantLock();
    // Cluster on the screen (AppUpdatePlugin): it isn't updated by itself then, as that closes it.
    static volatile boolean open;
    private static int code = 1;

    private AppUpdates() {
    }

    interface Progress {
        void tell(String pkg, String stage, long got, long size, String error);
    }

    static String nameOf(String pkg) {
        for (String[] a : APPS) if (a[0].equals(pkg)) return a[1];
        return pkg;
    }

    // ---------- this phone's apps ----------
    static JSONArray apps(Context ctx) throws Exception {
        PackageManager pm = ctx.getPackageManager();
        JSONArray out = new JSONArray();
        for (String[] a : APPS) {
            JSONObject o = new JSONObject();
            o.put("pkg", a[0]);
            o.put("name", a[1]);
            try {
                PackageInfo info = pm.getPackageInfo(a[0], 0);
                ApplicationInfo app = pm.getApplicationInfo(a[0], PackageManager.GET_META_DATA);
                o.put("installed", true);
                o.put("commit", commitOf(app.metaData));
                o.put("updated", info.lastUpdateTime);
                o.put("self", a[0].equals(ctx.getPackageName()));
                // (whether Cluster installed it last: then it updates without asking, from Android 12)
                o.put("ours", ours(ctx, a[0]));
            } catch (PackageManager.NameNotFoundException e) {
                o.put("installed", false);
            }
            out.put(o);
        }
        return out;
    }

    static String commitOf(Bundle meta) {
        Object v = meta == null ? null : meta.get("com.handtracker.build");
        String s = v == null ? "" : String.valueOf(v);
        return s.matches("git:[0-9a-f]{40}") ? s.substring(4) : "";
    }

    static boolean ours(Context ctx, String pkg) {
        return pkg.equals(ctx.getPackageName()) || ctx.getPackageName().equals(installerOf(ctx.getPackageManager(), pkg));
    }

    @SuppressWarnings("deprecation")
    static String installerOf(PackageManager pm, String pkg) {
        try {
            if (Build.VERSION.SDK_INT >= 30) return pm.getInstallSourceInfo(pkg).getInstallingPackageName();
            return pm.getInstallerPackageName(pkg);
        } catch (Exception e) {
            return null;
        }
    }

    static boolean installed(Context ctx, String pkg) {
        try {
            ctx.getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    // ---------- recording just now? ----------
    // The app's name, or null when nothing on this phone is recording or saving a take. Only recording
    // counts (the user, 2026-11-20: "just unless recording"), not cameras on. An app from before it could
    // say isn't asked: Cluster updates one like that only with Update (Android asks first then).
    static String recording(Context ctx) {
        for (String pkg : RECORDERS) {
            if (!installed(ctx, pkg)) continue;
            try {
                Bundle b = ctx.getContentResolver().call(Uri.parse("content://" + pkg + ".state"), "busy", null, null);
                if (b != null && b.getBoolean("busy")) return nameOf(pkg);
            } catch (RuntimeException e) {
                // (an app from before it could say)
            }
        }
        return null;
    }

    // ---------- GitHub's newest build ----------
    static JSONObject latest() throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(RELEASE).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("Accept", "application/vnd.github+json");
        c.setRequestProperty("User-Agent", "Cluster-Android");
        int status = c.getResponseCode();
        if (status != 200) throw new IOException("GitHub answered " + status + ".");
        JSONObject r;
        try (InputStream in = c.getInputStream()) {
            r = new JSONObject(new String(readAll(in), StandardCharsets.UTF_8));
        } finally {
            c.disconnect();
        }
        String commit = r.optString("target_commitish", "");
        if (!commit.matches("[0-9a-f]{40}")) throw new IOException("GitHub's newest build has no commit.");
        JSONObject apps = new JSONObject();
        JSONArray assets = r.optJSONArray("assets");
        for (int i = 0; assets != null && i < assets.length(); i++) {
            JSONObject x = assets.getJSONObject(i);
            String name = x.optString("name", "");
            for (String[] a : APPS) {
                if (!name.endsWith(".apk")) continue;
                boolean before = a.length > 3 && name.startsWith(a[3] + "-") && !apps.has(a[0]);
                if (!name.startsWith(a[2] + "-") && !before) continue;
                String digest = x.optString("digest", "");
                JSONObject o = new JSONObject();
                o.put("asset", name);
                o.put("size", x.optLong("size", -1));
                o.put("sha256", digest.matches("sha256:[0-9a-f]{64}") ? digest.substring(7) : "");
                o.put("url", x.optString("browser_download_url", ""));
                apps.put(a[0], o);
            }
        }
        JSONObject out = new JSONObject();
        out.put("commit", commit);
        out.put("published", r.optString("published_at", ""));
        out.put("apps", apps);
        return out;
    }

    // ---------- an APK, downloaded and checked ----------
    static File download(Context ctx, String pkg, JSONObject asset, Progress progress) throws Exception {
        String url = asset.optString("url", "");
        long size = asset.optLong("size", -1);
        String sha = asset.optString("sha256", "");
        if (!url.startsWith("https://github.com/")) throw new IOException("Not one of GitHub's downloads.");
        if (sha.isEmpty()) throw new IOException("GitHub didn't give its checksum, so it isn't installed.");
        File dir = new File(ctx.getCacheDir(), "app-updates");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("No room for the download.");
        File out = new File(dir, pkg + ".apk");
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(60000);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "Cluster-Android");
        long got = 0;
        try {
            int status = c.getResponseCode();
            if (status != 200) throw new IOException("GitHub answered " + status + ".");
            try (InputStream in = c.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                byte[] buf = new byte[65536];
                long told = 0;
                int r;
                while ((r = in.read(buf)) != -1) {
                    os.write(buf, 0, r);
                    md.update(buf, 0, r);
                    got += r;
                    if (size > 0 && got > size) throw new IOException("It came out bigger than GitHub said.");
                    if (got - told >= 512 * 1024) {
                        told = got;
                        progress.tell(pkg, "download", got, size, null);
                    }
                }
            }
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            out.delete();
            throw e;
        } finally {
            c.disconnect();
        }
        progress.tell(pkg, "download", got, size, null);
        if ((size >= 0 && got != size) || !hex(md.digest()).equals(sha)) {
            //noinspection ResultOfMethodCallIgnored
            out.delete();
            throw new IOException("It didn't come out as GitHub has it (its size or checksum differs), so it isn't installed.");
        }
        return out;
    }

    // ---------- installed (or Android asked first) ----------
    // background: no one is looking, so Android's question becomes a notification (AppUpdateResult).
    static void install(Context ctx, String pkg, File apk, boolean background) throws IOException {
        PackageInstaller installer = ctx.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(pkg);
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int id = installer.createSession(params);
        try (PackageInstaller.Session session = installer.openSession(id)) {
            try (OutputStream os = session.openWrite("base.apk", 0, apk.length()); InputStream in = new FileInputStream(apk)) {
                byte[] buf = new byte[65536];
                int r;
                while ((r = in.read(buf)) != -1) os.write(buf, 0, r);
                session.fsync(os);
            }
            Intent result = new Intent(ctx, AppUpdateResult.class).setPackage(ctx.getPackageName())
                    .putExtra(AppUpdateResult.EXTRA_PKG, pkg).putExtra(AppUpdateResult.EXTRA_BACKGROUND, background);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            session.commit(PendingIntent.getBroadcast(ctx, nextCode(), result, flags).getIntentSender());
        } catch (IOException | RuntimeException e) {
            installer.abandonSession(id);
            throw e;
        }
    }

    private static synchronized int nextCode() {
        return code++;
    }

    // The apps asked for, in APPS' order (Cluster last): each downloaded, checked, installed, and its
    // answer waited for. Holding LOCK. -> { done: [pkg], failed: [{ pkg, error }], asks: [pkg] }
    static JSONObject update(Context ctx, List<String> want, JSONObject latest, boolean background, Progress progress) throws Exception {
        JSONObject assets = latest.getJSONObject("apps");
        JSONArray done = new JSONArray();
        JSONArray failed = new JSONArray();
        JSONArray asks = new JSONArray();
        JSONArray pending = new JSONArray();
        LinkedBlockingQueue<Object[]> results = new LinkedBlockingQueue<>();
        AppUpdateResult.listener = (pkg, ok, error) -> results.offer(new Object[] {pkg, ok, error});
        try {
            for (String[] app : APPS) {
                String pkg = app[0];
                if (!want.contains(pkg)) continue;
                try {
                    JSONObject asset = assets.optJSONObject(pkg);
                    if (asset == null) throw new Exception("It isn't in GitHub's newest build.");
                    progress.tell(pkg, "download", 0, asset.optLong("size", -1), null);
                    File apk = download(ctx, pkg, asset, progress);
                    progress.tell(pkg, "install", apk.length(), apk.length(), null);
                    results.clear();
                    install(ctx, pkg, apk, background);
                    Object[] r = results.poll(background ? BACKGROUND_WAIT_MS : ASK_MS, TimeUnit.MILLISECONDS);
                    //noinspection ResultOfMethodCallIgnored
                    apk.delete();
                    if (r == null && background) {
                        // (left installing: its answer goes in the note when it comes, resultLater; one that
                        // came just as it was marked is taken here instead)
                        markPending(ctx, pkg);
                        r = results.poll();
                        if (r == null) {
                            pending.put(pkg);
                            progress.tell(pkg, "pending", 0, 0, null);
                            continue;
                        }
                        unmarkPending(ctx, pkg);
                    }
                    if (r == null) throw new Exception("No answer from Android (its question may still be open).");
                    if (AppUpdateResult.ASKS.equals(r[2])) {
                        asks.put(pkg);
                        progress.tell(pkg, "asks", 0, 0, null);
                        continue;
                    }
                    if (!Boolean.TRUE.equals(r[1])) throw new Exception(String.valueOf(r[2]));
                    done.put(pkg);
                    progress.tell(pkg, "done", 0, 0, null);
                } catch (Exception e) {
                    JSONObject f = new JSONObject();
                    f.put("pkg", pkg);
                    f.put("error", e.getMessage() == null ? e.toString() : e.getMessage());
                    failed.put(f);
                    progress.tell(pkg, "failed", 0, 0, f.getString("error"));
                }
            }
        } finally {
            AppUpdateResult.listener = null;
        }
        JSONObject out = new JSONObject();
        out.put("done", done);
        out.put("failed", failed);
        out.put("asks", asks);
        out.put("pending", pending);
        return out;
    }

    // ---------- an hourly install's answer, after the job moved on (AppUpdateResult) ----------
    static synchronized void markPending(Context ctx, String pkg) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        java.util.Set<String> s = new java.util.HashSet<>(p.getStringSet("pending", new java.util.HashSet<>()));
        s.add(pkg);
        p.edit().putStringSet("pending", s).commit();
    }

    static synchronized boolean unmarkPending(Context ctx, String pkg) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        java.util.Set<String> s = new java.util.HashSet<>(p.getStringSet("pending", new java.util.HashSet<>()));
        boolean was = s.remove(pkg);
        p.edit().putStringSet("pending", s).commit();
        return was;
    }

    // Android's answer for one the hourly look left installing: added to what the look said (kept until
    // the look says it, when it comes while the look is still going).
    private static boolean looking;
    private static final StringBuilder ARRIVED = new StringBuilder();

    static void resultLater(Context ctx, String pkg, boolean ok, String error) {
        if (pkg == null || !unmarkPending(ctx, pkg)) return;
        String when = DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date());
        String piece = " " + nameOf(pkg) + (ok ? " updated (" + when + ")." : " not installed (" + when + "): " + error);
        synchronized (AppUpdates.class) {
            if (looking) {
                ARRIVED.append(piece);
                return;
            }
            SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            p.edit().putString("auto", p.getString("auto", "") + piece).commit();
        }
    }

    // ---------- every hour: the apps with a newer build updated by themselves ----------
    static void autoUpdate(Context ctx) throws Exception {
        if (!LOCK.tryLock()) return; // (updating already, from the page)
        try {
            JSONObject latest = latest();
            String commit = latest.getString("commit");
            JSONObject assets = latest.getJSONObject("apps");
            List<String> silent = new ArrayList<>();
            List<String> asking = new ArrayList<>();
            JSONArray apps = apps(ctx);
            for (int i = 0; i < apps.length(); i++) {
                JSONObject a = apps.getJSONObject(i);
                String pkg = a.getString("pkg");
                if (!a.optBoolean("installed") || upToDate(a, latest) || !assets.has(pkg)) continue;
                // (by itself only where Android lets it: an app Cluster installed, from Android 12;
                // Cluster itself not while it's open, as that would close it under your finger)
                if (Build.VERSION.SDK_INT >= 31 && a.optBoolean("ours")) {
                    if (!(a.optBoolean("self") && open)) silent.add(pkg);
                } else {
                    asking.add(a.getString("name"));
                }
            }
            if (silent.isEmpty() && asking.isEmpty()) {
                said(ctx, "Up to date (build " + commit.substring(0, 7) + ").");
                return;
            }
            String busy = recording(ctx);
            if (busy != null) {
                said(ctx, "Waiting: " + busy + " is recording or saving a take (looks again later).");
                return;
            }
            List<String> stillAsk = new ArrayList<>(asking);
            // (Cluster itself after the note is written: updating it ends this process)
            boolean self = silent.remove(ctx.getPackageName());
            if (!silent.isEmpty()) {
                synchronized (AppUpdates.class) {
                    looking = true;
                    ARRIVED.setLength(0);
                }
                JSONObject r;
                try {
                    r = update(ctx, silent, latest, true, (pkg, stage, got, size, error) -> {
                    });
                } catch (Exception e) {
                    synchronized (AppUpdates.class) {
                        looking = false;
                    }
                    throw e;
                }
                List<String> names = new ArrayList<>();
                List<String> installing = new ArrayList<>();
                for (int i = 0; i < r.getJSONArray("done").length(); i++) names.add(nameOf(r.getJSONArray("done").getString(i)));
                for (int i = 0; i < r.getJSONArray("pending").length(); i++) installing.add(nameOf(r.getJSONArray("pending").getString(i)));
                for (int i = 0; i < r.getJSONArray("asks").length(); i++) stillAsk.add(nameOf(r.getJSONArray("asks").getString(i)));
                StringBuilder s = new StringBuilder();
                if (!names.isEmpty()) s.append("Updated ").append(String.join(", ", names)).append(" to build ").append(commit, 0, 7).append(". ");
                JSONArray failed = r.getJSONArray("failed");
                for (int i = 0; i < failed.length(); i++) {
                    s.append(nameOf(failed.getJSONObject(i).getString("pkg"))).append(": ").append(failed.getJSONObject(i).getString("error")).append(" ");
                }
                if (!installing.isEmpty()) s.append("Installing ").append(String.join(", ", installing)).append(" (build ").append(commit, 0, 7).append("; Android checks each first):");
                synchronized (AppUpdates.class) {
                    s.append(ARRIVED);
                    looking = false;
                    said(ctx, s.toString().trim() + (self ? " Cluster itself next." : ""));
                }
            }
            if (self) {
                if (silent.isEmpty()) said(ctx, "Updating Cluster itself to build " + commit.substring(0, 7) + ".");
                if (!stillAsk.isEmpty()) tellOnce(ctx, commit, stillAsk); // (before: updating itself ends this process)
                List<String> me = new ArrayList<>();
                me.add(ctx.getPackageName());
                update(ctx, me, latest, true, (pkg, stage, got, size, error) -> {
                });
                return;
            }
            if (!stillAsk.isEmpty()) tellOnce(ctx, commit, stillAsk);
        } finally {
            LOCK.unlock();
        }
    }

    // Up to date: from the newest build, or, with no build stamp (from before apps had one), put on after
    // it came out (else such an app, once updated, would be updated again every hour: seen 2026-11-20).
    static boolean upToDate(JSONObject a, JSONObject latest) {
        String c = a.optString("commit");
        if (!c.isEmpty()) return c.equals(latest.optString("commit"));
        long published = 0;
        try {
            java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT);
            f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            published = f.parse(latest.optString("published")).getTime();
        } catch (Exception ignored) {
            // (no date: older)
        }
        return published > 0 && a.optLong("updated") >= published;
    }

    static void said(Context ctx, String what) {
        String when = DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date());
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("auto", when + ": " + what).apply();
    }

    static String lastSaid(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("auto", "");
    }

    // A notification, once for each build: the apps Android asks about first, updated from Cluster.
    static void tellOnce(Context ctx, String commit, List<String> names) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (commit.equals(prefs.getString("told", ""))) return;
        String text = String.join(", ", names) + (names.size() == 1 ? " has" : " have") + " a newer build (" + commit.substring(0, 7)
                + "). Android asks once before Cluster updates " + (names.size() == 1 ? "it" : "each") + ": open Cluster and tap Update.";
        notify(ctx, "Newer builds of the apps", text, null);
        prefs.edit().putString("told", commit).apply();
    }

    // (ask: Android's own question, opened from the notification; null opens Cluster)
    static void notify(Context ctx, String title, String text, PendingIntent ask) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Newer builds of the apps", NotificationManager.IMPORTANCE_DEFAULT));
            b = new Notification.Builder(ctx, CHANNEL);
        } else {
            b = new Notification.Builder(ctx);
        }
        PendingIntent tap = ask;
        if (tap == null) {
            Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
            if (open != null) tap = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        }
        if (tap != null) b.setContentIntent(tap);
        nm.notify(NOTIFICATION_ID + (ask != null ? 1 + Math.abs(text.hashCode() % 1000) : 0), b.setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .build());
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int r;
        while ((r = in.read(buf)) != -1) {
            out.write(buf, 0, r);
            if (out.size() > MAX_ANSWER) throw new IOException("GitHub's answer was too big.");
        }
        return out.toByteArray();
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format(Locale.ROOT, "%02x", x));
        return s.toString();
    }
}
