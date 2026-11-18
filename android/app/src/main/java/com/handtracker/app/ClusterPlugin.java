package com.handtracker.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Cluster — Pi Cluster's own app on Android (the "cluster" flavor; pi-cluster.js) reaching the Pis
 * running Pi Cluster's service (cluster/node, port 47830) over Tailscale: plain HTTP straight over
 * TCP (as RemotePlugin's rigRequest: Android keeps the app's other requests off plain HTTP), with
 * the service's own header, and only to its /api/ paths.
 *
 *   request({ target: "pi" | "100.x.y.z" | "host:port", method, path, body?, data? (base64), timeoutMs? })
 *       -> { status, type, body (text, for JSON), data (base64, for anything else) }
 *   save({ target, path, name, size }) -> { saved }
 *       a file from a Pi (a job's results as one zip), fetched a piece at a time (path&at=…) straight
 *       into the phone's Downloads; "progress" { name, got, size } as it goes
 */
@CapacitorPlugin(name = "Cluster")
public class ClusterPlugin extends Plugin {
    static final int PORT = 47830;
    private static final int MAX_ANSWER = 8 * 1024 * 1024;
    private static final int MAX_SEND = 16 * 1024 * 1024;
    private static final Pattern TARGET = Pattern.compile(
            "^(\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*)(:(\\d{1,5}))?$");
    private static final Pattern PATH = Pattern.compile("^/api/[A-Za-z0-9/_.-]{1,80}(\\?[A-Za-z0-9%._~!*'()=&+-]{0,4000})?$");
    private static final Pattern NAME = Pattern.compile("^[^/\\\\\\u0000-\\u001f]{1,200}\\.zip$");

    private final ExecutorService pool = Executors.newCachedThreadPool();

    static class Answer {
        int status;
        String type = "";
        byte[] body = new byte[0];
    }

    @PluginMethod
    public void request(PluginCall call) {
        pool.execute(() -> {
            try {
                String method = call.getString("method", "GET");
                byte[] payload = null;
                String type = null;
                String data = call.getString("data", null);
                String body = call.getString("body", null);
                if (data != null) {
                    payload = Base64.decode(data, Base64.DEFAULT);
                    type = "application/octet-stream";
                } else if (body != null) {
                    payload = body.getBytes(StandardCharsets.UTF_8);
                    type = "application/json";
                }
                int timeout = Math.max(2000, Math.min(180000, call.getInt("timeoutMs", 20000)));
                Answer a = exchange(call.getString("target", ""), method, call.getString("path", ""), payload, type, timeout);
                JSObject ret = new JSObject();
                ret.put("status", a.status);
                ret.put("type", a.type);
                if (a.type.startsWith("application/json")) ret.put("body", new String(a.body, StandardCharsets.UTF_8));
                else ret.put("data", Base64.encodeToString(a.body, Base64.NO_WRAP));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            }
        });
    }

    @PluginMethod
    public void save(PluginCall call) {
        pool.execute(() -> {
            Uri uri = null;
            ContentResolver resolver = getContext().getContentResolver();
            try {
                String target = call.getString("target", "");
                String path = call.getString("path", "");
                String name = call.getString("name", "");
                Object given = call.getData().opt("size"); // (a number from the page: an Integer or a Long, as it comes)
                long size = given instanceof Number ? ((Number) given).longValue() : -1L;
                if (!NAME.matcher(name).matches()) throw new IOException("Not a name it can save.");
                OutputStream os;
                File file = null;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    v.put(MediaStore.Downloads.MIME_TYPE, "application/zip");
                    v.put(MediaStore.Downloads.IS_PENDING, 1);
                    uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) throw new IOException("Downloads didn't take it.");
                    os = resolver.openOutputStream(uri);
                } else {
                    // (before Android 10: the app's own Downloads folder, which needs no permission)
                    File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir == null || (!dir.isDirectory() && !dir.mkdirs())) throw new IOException("No Downloads folder.");
                    file = new File(dir, name);
                    os = new FileOutputStream(file);
                }
                if (os == null) throw new IOException("Downloads didn't take it.");
                long got = 0;
                try (OutputStream out = os) {
                    for (;;) {
                        Answer a = exchange(target, "GET", path + (path.contains("?") ? "&" : "?") + "at=" + got, null, null, 120000);
                        if (a.status != 200) throw new IOException("The Pi answered " + a.status + ".");
                        if (a.type.startsWith("application/json")) throw new IOException(new String(a.body, StandardCharsets.UTF_8));
                        out.write(a.body);
                        got += a.body.length;
                        JSObject p = new JSObject();
                        p.put("name", name);
                        p.put("got", got);
                        p.put("size", size);
                        notifyListeners("progress", p);
                        if (a.body.length == 0 || (size >= 0 && got >= size)) break;
                    }
                }
                if (size >= 0 && got != size) throw new IOException("It came out " + got + " bytes, not " + size + ".");
                if (uri != null) {
                    ContentValues done = new ContentValues();
                    done.put(MediaStore.Downloads.IS_PENDING, 0);
                    resolver.update(uri, done, null, null);
                }
                JSObject ret = new JSObject();
                ret.put("saved", uri != null ? "Downloads/" + name : file.getAbsolutePath());
                call.resolve(ret);
            } catch (Exception e) {
                if (uri != null) {
                    try {
                        resolver.delete(uri, null, null);
                    } catch (Exception ignored) {
                    }
                }
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            }
        });
    }

    // One request and its answer over a TCP connection of its own (the service closes it).
    static Answer exchange(String target, String method, String path, byte[] payload, String type, int timeoutMs) throws IOException {
        Matcher m = TARGET.matcher(target == null ? "" : target);
        if (!m.matches()) throw new IOException("That isn't a Pi's name.");
        int port = m.group(6) != null ? Integer.parseInt(m.group(6)) : PORT;
        if (port < 1 || port > 65535) throw new IOException("That isn't a port.");
        String host = m.group(1).replaceAll("^\\[|\\]$", "");
        if (!("GET".equals(method) || "POST".equals(method) || "PUT".equals(method))) throw new IOException("Not a request it makes.");
        if (path == null || !PATH.matcher(path).matches()) throw new IOException("Not one of the service's requests.");
        if (payload != null && payload.length > MAX_SEND) throw new IOException("Too big a piece.");
        StringBuilder head = new StringBuilder();
        head.append(method).append(' ').append(path).append(" HTTP/1.1\r\n")
                .append("Host: ").append(m.group(1)).append(':').append(port).append("\r\n")
                .append("X-HT-Cluster: 1\r\n")
                .append("Connection: close\r\n");
        if (payload != null) head.append("Content-Type: ").append(type).append("\r\nContent-Length: ").append(payload.length).append("\r\n");
        else if (!"GET".equals(method)) head.append("Content-Length: 0\r\n");
        head.append("\r\n");
        byte[] all;
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(host, port), Math.min(timeoutMs, 10000));
            socket.setSoTimeout(timeoutMs);
            OutputStream os = socket.getOutputStream();
            os.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
            if (payload != null) os.write(payload);
            os.flush();
            all = readAll(socket.getInputStream());
        }
        int split = indexOf(all, new byte[] {'\r', '\n', '\r', '\n'});
        if (split < 0) throw new IOException("Not an answer from the Pi.");
        String[] lines = new String(all, 0, split, StandardCharsets.ISO_8859_1).split("\r\n");
        String[] first = lines[0].split(" ");
        if (first.length < 2 || !first[0].startsWith("HTTP/")) throw new IOException("Not an answer from the Pi.");
        Answer a = new Answer();
        int length = -1;
        try {
            a.status = Integer.parseInt(first[1]);
            for (int i = 1; i < lines.length; i++) {
                int c = lines[i].indexOf(':');
                if (c < 0) continue;
                String k = lines[i].substring(0, c).trim().toLowerCase();
                String v = lines[i].substring(c + 1).trim();
                if (k.equals("content-type")) a.type = v;
                else if (k.equals("content-length")) length = Integer.parseInt(v);
            }
        } catch (NumberFormatException e) {
            throw new IOException("Not an answer from the Pi.");
        }
        int start = split + 4;
        int n = all.length - start;
        if (length >= 0 && length < n) n = length;
        a.body = new byte[Math.max(0, n)];
        System.arraycopy(all, start, a.body, 0, a.body.length);
        return a;
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int r;
        while ((r = in.read(buf)) != -1) {
            out.write(buf, 0, r);
            if (out.size() > MAX_ANSWER) throw new IOException("The answer was too big.");
        }
        return out.toByteArray();
    }

    private static int indexOf(byte[] a, byte[] b) {
        outer:
        for (int i = 0; i + b.length <= a.length; i++) {
            for (int j = 0; j < b.length; j++) if (a[i + j] != b[j]) continue outer;
            return i;
        }
        return -1;
    }
}
