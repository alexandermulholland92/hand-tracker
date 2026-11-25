package com.handtracker.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.apache.commons.net.ftp.FTP;
import org.apache.commons.net.ftp.FTPClient;
import org.apache.commons.net.ftp.FTPFile;
import org.apache.commons.net.ftp.FTPReply;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * Ftp — the FTP link to a Pi's shared folders (the user: phones "mount them as an ftp link built into the app"; the
 * Pi's side is cluster/node/modules/ftp.py), for the Cluster app's page (cluster.js). It logs in as this phone of the
 * cluster: its name and its own key (MemberService's: the one it gave the Pis), so this phone must be in the cluster.
 *   list({ host, path }) -> { path, entries: [{ name, dir, size, time }] }
 *   download({ host, path, name, size }) -> { saved }  into the phone's Downloads, "progress" { name, got, size } as it goes
 *   upload({ host, dir }) -> { name, size }  a file picked on the phone, sent into that folder
 *   mkdir({ host, path }) -> {}
 * Only over Tailscale (the Pi takes nothing else); passive FTP, binary. Only the Cluster app has it.
 */
@CapacitorPlugin(name = "Ftp")
public class FtpPlugin extends Plugin {
    static final int PORT = 2121;
    private static final Pattern HOST = Pattern.compile("^(100\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)$");
    private static final Pattern PATH = Pattern.compile("^/[^\\u0000-\\u001f]{0,1000}$");
    private static final Pattern NAME = Pattern.compile("^[^/\\\\\\u0000-\\u001f]{1,200}$");
    private final ExecutorService pool = Executors.newCachedThreadPool();

    private FTPClient connect(String host) throws IOException {
        if (host == null || !HOST.matcher(host).matches()) throw new IOException("That isn't a Pi of the cluster.");
        Context c = getContext();
        File keyFile = new File(new File(c.getFilesDir(), "cluster-state"), "phone-key");
        if (!keyFile.exists()) throw new IOException("Turn on This phone in the cluster first: the Pis know this phone by its key.");
        String key;
        try (InputStream in = new FileInputStream(keyFile)) {
            byte[] b = new byte[256];
            int n = in.read(b);
            key = new String(b, 0, Math.max(0, n), StandardCharsets.US_ASCII).trim();
        }
        String name = c.getSharedPreferences(MemberService.PREFS, Context.MODE_PRIVATE).getString("name", MemberService.defaultName());
        FTPClient f = new FTPClient();
        f.setConnectTimeout(10000);
        f.setDefaultTimeout(30000);
        f.setControlEncoding("UTF-8");
        f.connect(host, PORT);
        if (!FTPReply.isPositiveCompletion(f.getReplyCode())) {
            f.disconnect();
            throw new IOException("The Pi's FTP link didn't answer (is Get the FTP server done on it?).");
        }
        if (!f.login(name, key)) {
            f.disconnect();
            throw new IOException("The Pi didn't take this phone (has it seen it in the cluster yet? a minute after it joins).");
        }
        f.enterLocalPassiveMode();
        f.setFileType(FTP.BINARY_FILE_TYPE);
        return f;
    }

    private static void close(FTPClient f) {
        try {
            if (f.isConnected()) {
                f.logout();
                f.disconnect();
            }
        } catch (IOException ignored) {
            // (gone already)
        }
    }

    private static String path(PluginCall call, String key) throws IOException {
        String p = call.getString(key, "/");
        if (p == null || !PATH.matcher(p).matches()) throw new IOException("Not a folder there.");
        return p;
    }

    @PluginMethod
    public void list(PluginCall call) {
        pool.execute(() -> {
            FTPClient f = null;
            try {
                f = connect(call.getString("host", ""));
                String p = path(call, "path");
                JSArray entries = new JSArray();
                for (FTPFile e : f.listFiles(p)) {
                    if (e == null || ".".equals(e.getName()) || "..".equals(e.getName())) continue;
                    JSObject o = new JSObject();
                    o.put("name", e.getName());
                    o.put("dir", e.isDirectory() || e.isSymbolicLink());
                    o.put("size", e.getSize());
                    o.put("time", e.getTimestamp() != null ? e.getTimestamp().getTimeInMillis() : 0);
                    entries.put(o);
                }
                JSObject ret = new JSObject();
                ret.put("path", p);
                ret.put("entries", entries);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            } finally {
                if (f != null) close(f);
            }
        });
    }

    @PluginMethod
    public void mkdir(PluginCall call) {
        pool.execute(() -> {
            FTPClient f = null;
            try {
                f = connect(call.getString("host", ""));
                if (!f.makeDirectory(path(call, "path"))) throw new IOException("The folder wasn't made: " + f.getReplyString().trim());
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            } finally {
                if (f != null) close(f);
            }
        });
    }

    // A file from the Pi into the phone's Downloads (as ClusterPlugin.save puts a job's results there).
    @PluginMethod
    public void download(PluginCall call) {
        pool.execute(() -> {
            FTPClient f = null;
            Uri uri = null;
            ContentResolver resolver = getContext().getContentResolver();
            try {
                String name = call.getString("name", "");
                if (name == null || !NAME.matcher(name).matches()) throw new IOException("Not a name it can save.");
                Object given = call.getData().opt("size");
                long size = given instanceof Number ? ((Number) given).longValue() : -1L;
                f = connect(call.getString("host", ""));
                OutputStream os;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    v.put(MediaStore.Downloads.IS_PENDING, 1);
                    uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) throw new IOException("Downloads didn't take it.");
                    os = resolver.openOutputStream(uri);
                } else {
                    File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir == null || (!dir.isDirectory() && !dir.mkdirs())) throw new IOException("No Downloads folder.");
                    os = new FileOutputStream(new File(dir, name));
                }
                if (os == null) throw new IOException("Downloads didn't take it.");
                long got = 0;
                try (OutputStream out = os; InputStream in = f.retrieveFileStream(path(call, "path"))) {
                    if (in == null) throw new IOException("It couldn't be fetched: " + f.getReplyString().trim());
                    byte[] buf = new byte[1 << 16];
                    long told = 0;
                    for (int n; (n = in.read(buf)) > 0; ) {
                        out.write(buf, 0, n);
                        got += n;
                        if (got - told >= (1 << 20) || got == size) {
                            told = got;
                            JSObject p = new JSObject();
                            p.put("name", name);
                            p.put("got", got);
                            p.put("size", size);
                            notifyListeners("progress", p);
                        }
                    }
                }
                if (!f.completePendingCommand()) throw new IOException("It didn't all come: " + f.getReplyString().trim());
                if (uri != null) {
                    ContentValues done = new ContentValues();
                    done.put(MediaStore.Downloads.IS_PENDING, 0);
                    resolver.update(uri, done, null, null);
                }
                JSObject ret = new JSObject();
                ret.put("saved", "Downloads");
                ret.put("size", got);
                call.resolve(ret);
            } catch (Exception e) {
                if (uri != null) resolver.delete(uri, null, null);
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            } finally {
                if (f != null) close(f);
            }
        });
    }

    // A file picked on the phone, sent into a folder on the Pi.
    @PluginMethod
    public void upload(PluginCall call) {
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
        startActivityForResult(call, pick, "picked");
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("No file picked.");
            return;
        }
        Uri uri = data.getData();
        pool.execute(() -> {
            FTPClient f = null;
            ContentResolver resolver = getContext().getContentResolver();
            try {
                String name = "file";
                long size = -1;
                try (Cursor cur = resolver.query(uri, new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                    if (cur != null && cur.moveToFirst()) {
                        name = cur.getString(0);
                        size = cur.isNull(1) ? -1 : cur.getLong(1);
                    }
                }
                if (name == null || !NAME.matcher(name).matches()) throw new IOException("That file's name can't go there.");
                String dir = path(call, "dir");
                f = connect(call.getString("host", ""));
                String to = (dir.endsWith("/") ? dir : dir + "/") + name;
                try (InputStream in = resolver.openInputStream(uri)) {
                    if (in == null) throw new IOException("The file couldn't be read.");
                    if (!f.storeFile(to, in)) throw new IOException("The Pi didn't take it: " + f.getReplyString().trim());
                }
                JSObject ret = new JSObject();
                ret.put("name", name);
                ret.put("size", size);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            } finally {
                if (f != null) close(f);
            }
        });
    }
}
