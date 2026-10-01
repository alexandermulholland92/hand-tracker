package com.handtracker.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Remote — the Android side of Capture Sessions and Live Rigs (the desktop app's
 * electron/ops.js and electron/fleet.js), for the page (mobile-bridge.js, remote-core.js):
 *
 *   request({ url, method, headers, body, cookies, followRedirects }) -> { status, headers, body }
 *       a web request from the app itself (no CORS), with the WebView's cookies if asked
 *   signIn({ url, mode: "supabase" | "cookie", checkUrl }) -> { session? }
 *       the dashboard's own sign-in page in a window of its own (SignInActivity); the user
 *       signs in there themselves
 *   clearCookies()
 *   secretGet / secretSet / secretRemove({ key, value })
 *       kept encrypted with a key in the Android Keystore
 *   streamRegister({ id, url }) / streamForget({ id })
 *       a session video, played (and seeked) by the page at /__ops/<id>: fetched from its
 *       signed link a part at a time, as the player reads on; "streamExpired" { id } asks
 *       the page for a fresh link
 *   fleetConfigure({ site })
 *       /__fleet/<rig>/<camera>?kind=keyframe|jpeg[&full=1]: that camera's latest picture
 */
@CapacitorPlugin(name = "Remote")
public class RemotePlugin extends Plugin {
    private static final int CHUNK_BYTES = 4 * 1024 * 1024;
    private static final int KEEP_PARTS = 6;
    private static final int TIMEOUT_MS = 20000;
    private static final int FRAME_TIMEOUT_MS = 10000;
    private static final String KEY_ALIAS = "hand-tracker-secrets";
    private static final Pattern FLEET_PATH = Pattern.compile("^/__fleet/([A-Za-z0-9][A-Za-z0-9-]{0,62})/([A-Za-z0-9_]{1,32})$");
    private static final Pattern OPS_PATH = Pattern.compile("^/__ops/([0-9a-f]{24})$");

    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, Stream> streams = new ConcurrentHashMap<>();
    private volatile String fleetSite = null;

    @Override
    public void load() {
        final Bridge bridge = getBridge();
        // The page's requests for /__ops/… and /__fleet/… are answered here; everything else
        // as Capacitor does.
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String path = u.getPath();
                if (path != null && "localhost".equals(u.getHost()) && (path.startsWith("/__ops/") || path.startsWith("/__fleet/"))) {
                    try {
                        return path.startsWith("/__ops/") ? serveStream(path, request.getRequestHeaders()) : serveFleet(path, u);
                    } catch (Exception e) {
                        return text(502, "Bad Gateway", String.valueOf(e.getMessage()));
                    }
                }
                return super.shouldInterceptRequest(view, request);
            }
        });
    }

    // ---------- web requests ----------
    @PluginMethod
    public void request(PluginCall call) {
        pool.execute(() -> {
            try {
                String url = call.getString("url", "");
                if (!url.startsWith("https://") && !url.startsWith("http://")) throw new IOException("Only web addresses can be fetched");
                JSObject headers = call.getObject("headers", new JSObject());
                Map<String, String> h = new HashMap<>();
                for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                    String k = it.next();
                    h.put(k, headers.getString(k));
                }
                Response res = fetch(url, call.getString("method", "GET"), h, call.getString("body", null),
                        Boolean.TRUE.equals(call.getBoolean("cookies", false)), Boolean.TRUE.equals(call.getBoolean("followRedirects", true)), TIMEOUT_MS, -1);
                JSObject ret = new JSObject();
                ret.put("status", res.status);
                JSObject rh = new JSObject();
                for (Map.Entry<String, String> e : res.headers.entrySet()) rh.put(e.getKey(), e.getValue());
                ret.put("headers", rh);
                ret.put("body", new String(res.body, StandardCharsets.UTF_8));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            }
        });
    }

    private static class Response {
        int status;
        Map<String, String> headers = new LinkedHashMap<>();
        byte[] body = new byte[0];
    }

    // A request from the app; with cookies, the WebView's (so a sign-in there counts here).
    // maxBytes < 0: the whole body.
    private Response fetch(String url, String method, Map<String, String> headers, String body, boolean cookies, boolean follow, int timeoutMs, int maxBytes) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setInstanceFollowRedirects(follow);
            c.setRequestMethod(method);
            c.setUseCaches(false);
            for (Map.Entry<String, String> e : headers.entrySet()) c.setRequestProperty(e.getKey(), e.getValue());
            CookieManager jar = cookies ? CookieManager.getInstance() : null;
            if (jar != null) {
                String cookie = jar.getCookie(url);
                if (cookie != null) c.setRequestProperty("Cookie", cookie);
            }
            if (body != null) {
                c.setDoOutput(true);
                byte[] b = body.getBytes(StandardCharsets.UTF_8);
                c.setFixedLengthStreamingMode(b.length);
                try (OutputStream os = c.getOutputStream()) {
                    os.write(b);
                }
            }
            Response r = new Response();
            r.status = c.getResponseCode();
            for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
                if (e.getKey() == null || e.getValue() == null || e.getValue().isEmpty()) continue;
                String k = e.getKey().toLowerCase();
                if (k.equals("set-cookie")) {
                    if (jar != null) for (String v : e.getValue()) jar.setCookie(url, v);
                    continue;
                }
                r.headers.put(k, String.join(", ", e.getValue()));
            }
            if (jar != null) jar.flush();
            InputStream in = r.status >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in != null) {
                try (InputStream is = in) {
                    r.body = readAll(is, maxBytes);
                }
            }
            return r;
        } finally {
            c.disconnect();
        }
    }

    private static byte[] readAll(InputStream in, int maxBytes) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            if (maxBytes >= 0 && out.size() > maxBytes) throw new IOException("The answer was too big");
        }
        return out.toByteArray();
    }

    // ---------- signing in on the dashboard's own page ----------
    @PluginMethod
    public void signIn(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            call.reject("That isn't a web address.");
            return;
        }
        Intent intent = new Intent(getContext(), SignInActivity.class);
        intent.putExtra(SignInActivity.EXTRA_URL, url);
        intent.putExtra(SignInActivity.EXTRA_MODE, call.getString("mode", "cookie"));
        intent.putExtra(SignInActivity.EXTRA_CHECK_URL, call.getString("checkUrl", ""));
        startActivityForResult(call, intent, "signInDone");
    }

    @ActivityCallback
    private void signInDone(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK) {
            call.reject("Sign-in window closed before signing in.");
            return;
        }
        JSObject ret = new JSObject();
        Intent data = result.getData();
        String session = data == null ? null : data.getStringExtra(SignInActivity.EXTRA_SESSION);
        if (session != null) ret.put("session", session);
        call.resolve(ret);
    }

    @PluginMethod
    public void clearCookies(PluginCall call) {
        CookieManager jar = CookieManager.getInstance();
        jar.removeAllCookies(ok -> {
            jar.flush();
            call.resolve();
        });
    }

    // ---------- secrets, encrypted with a key kept in the Android Keystore ----------
    private SharedPreferences secrets() {
        return getContext().getSharedPreferences("hand-tracker-secrets", Context.MODE_PRIVATE);
    }

    private static SecretKey secretKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }

    @PluginMethod
    public void secretSet(PluginCall call) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey());
            byte[] sealed = cipher.doFinal(call.getString("value", "").getBytes(StandardCharsets.UTF_8));
            String v = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP);
            secrets().edit().putString(call.getString("key", ""), v).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("Couldn't keep that securely: " + e.getMessage());
        }
    }

    @PluginMethod
    public void secretGet(PluginCall call) {
        JSObject ret = new JSObject();
        String v = secrets().getString(call.getString("key", ""), null);
        try {
            if (v != null) {
                String[] parts = v.split(":", 2);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
                ret.put("value", new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            // A key that's gone (the app's data was restored elsewhere): as if nothing was kept.
            secrets().edit().remove(call.getString("key", "")).apply();
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void secretRemove(PluginCall call) {
        secrets().edit().remove(call.getString("key", "")).apply();
        call.resolve();
    }

    // ---------- session videos at /__ops/<id> ----------
    private static class Stream {
        final String id;
        volatile String url;
        volatile long total = -1;
        volatile String type = "video/mp4";
        final LinkedHashMap<Integer, byte[]> parts = new LinkedHashMap<>(16, 0.75f, true);
        Stream(String id, String url) {
            this.id = id;
            this.url = url;
        }
    }

    @PluginMethod
    public void streamRegister(PluginCall call) {
        String id = call.getString("id", "");
        String url = call.getString("url", "");
        if (!id.matches("[0-9a-f]{24}") || !url.startsWith("https://")) {
            call.reject("That isn't a session video.");
            return;
        }
        Stream s = streams.get(id);
        if (s == null) streams.put(id, new Stream(id, url));
        else synchronized (s) {
            s.url = url;
            s.notifyAll();
        }
        call.resolve();
    }

    @PluginMethod
    public void streamForget(PluginCall call) {
        streams.remove(call.getString("id", ""));
        call.resolve();
    }

    // Part `index` of a stream (CHUNK_BYTES from index * CHUNK_BYTES), kept among the last few.
    private byte[] part(Stream s, int index) throws IOException {
        synchronized (s.parts) {
            byte[] p = s.parts.get(index);
            if (p != null) return p;
        }
        for (int attempt = 0; ; attempt++) {
            String url = s.url;
            Map<String, String> h = new HashMap<>();
            h.put("Range", "bytes=" + ((long) index * CHUNK_BYTES) + "-" + ((long) (index + 1) * CHUNK_BYTES - 1));
            Response r = fetch(url, "GET", h, null, false, true, TIMEOUT_MS, CHUNK_BYTES + 1024);
            if ((r.status == 400 || r.status == 401 || r.status == 403) && attempt == 0) {
                // The signed link has run out: the page signs a new one (streamRegister).
                JSObject ev = new JSObject();
                ev.put("id", s.id);
                notifyListeners("streamExpired", ev);
                synchronized (s) {
                    long until = System.currentTimeMillis() + 15000;
                    while (url.equals(s.url) && System.currentTimeMillis() < until) {
                        try {
                            s.wait(500);
                        } catch (InterruptedException e) {
                            throw new IOException("interrupted");
                        }
                    }
                }
                continue;
            }
            if (r.status != 206) throw new IOException("The video's server said " + r.status);
            Matcher m = Pattern.compile("/(\\d+)$").matcher(r.headers.containsKey("content-range") ? r.headers.get("content-range") : "");
            if (m.find()) s.total = Long.parseLong(m.group(1));
            if (r.headers.containsKey("content-type")) s.type = r.headers.get("content-type");
            synchronized (s.parts) {
                s.parts.put(index, r.body);
                while (s.parts.size() > KEEP_PARTS) {
                    Iterator<Integer> it = s.parts.keySet().iterator();
                    it.next();
                    it.remove();
                }
            }
            return r.body;
        }
    }

    // "Byte N to the end", made of parts fetched only as the player reads on (plus one ahead),
    // so a player that drops the answer once it has read enough costs nothing more (ops.js serve).
    private WebResourceResponse serveStream(String path, Map<String, String> requestHeaders) throws IOException {
        Matcher pm = OPS_PATH.matcher(path);
        final Stream s = pm.matches() ? streams.get(pm.group(1)) : null;
        if (s == null) return text(404, "Not Found", "Not found");
        String range = null;
        for (Map.Entry<String, String> e : requestHeaders.entrySet()) if (e.getKey().equalsIgnoreCase("Range")) range = e.getValue();
        Matcher m = Pattern.compile("^bytes=(\\d+)-(\\d*)$").matcher(range == null ? "bytes=0-" : range.trim());
        if (!m.matches()) return text(416, "Range Not Satisfiable", "Only byte ranges are served");
        final long start = Long.parseLong(m.group(1));
        final int firstIndex = (int) (start / CHUNK_BYTES);
        final byte[] first = part(s, firstIndex);
        if (s.total < 0) return text(502, "Bad Gateway", "The video's server didn't say how long it is");
        if (start >= s.total) return text(416, "Range Not Satisfiable", "");
        final long last = Math.min(m.group(2).isEmpty() ? Long.MAX_VALUE : Long.parseLong(m.group(2)), s.total - 1);
        final int lastIndex = (int) (last / CHUNK_BYTES);
        readAhead(s, firstIndex + 1, lastIndex);
        InputStream body = new InputStream() {
            int index = firstIndex;
            byte[] cur = first;
            int pos = (int) (start - (long) firstIndex * CHUNK_BYTES);
            long left = last - start + 1;

            private boolean ensure() throws IOException {
                if (left <= 0) return false;
                if (pos < cur.length) return true;
                index++;
                if (index > lastIndex) return false;
                cur = part(s, index);
                pos = 0;
                readAhead(s, index + 1, lastIndex);
                if (cur.length == 0) throw new IOException("The video ended early");
                return true;
            }

            @Override
            public int read() throws IOException {
                if (!ensure()) return -1;
                left--;
                return cur[pos++] & 0xff;
            }

            @Override
            public int read(byte[] b, int off, int len) throws IOException {
                if (len == 0) return 0;
                if (!ensure()) return -1;
                int n = (int) Math.min(Math.min(len, cur.length - pos), left);
                System.arraycopy(cur, pos, b, off, n);
                pos += n;
                left -= n;
                return n;
            }
        };
        Map<String, String> h = new HashMap<>();
        h.put("Content-Range", "bytes " + start + "-" + last + "/" + s.total);
        h.put("Content-Length", String.valueOf(last - start + 1));
        h.put("Accept-Ranges", "bytes");
        h.put("Cache-Control", "no-store");
        String type = s.type.split(";")[0].trim();
        return new WebResourceResponse(type, null, 206, "Partial Content", h, body);
    }

    private void readAhead(Stream s, int index, int lastIndex) {
        if (index > lastIndex) return;
        pool.execute(() -> {
            try {
                if (streams.containsKey(s.id)) part(s, index);
            } catch (Exception ignored) {
                // fetched again when the player gets there
            }
        });
    }

    // ---------- live rig pictures at /__fleet/<rig>/<camera> ----------
    @PluginMethod
    public void fleetConfigure(PluginCall call) {
        String site = call.getString("site", "");
        fleetSite = site.isEmpty() ? null : site.replaceAll("/+$", "");
        call.resolve();
    }

    private WebResourceResponse serveFleet(String path, Uri u) {
        String site = fleetSite;
        Matcher m = FLEET_PATH.matcher(path);
        if (site == null || !m.matches()) return text(404, "Not Found", "Not found");
        boolean keyframe = "keyframe".equals(u.getQueryParameter("kind"));
        boolean full = "1".equals(u.getQueryParameter("full"));
        String endpoint = keyframe ? "keyframe/" + m.group(2) + "?" : "frame/" + m.group(2) + "?" + (full ? "quality=full" : "fps=2") + "&";
        Response r;
        try {
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-store");
            r = fetch(site + "/proxy/" + m.group(1) + "/api/preview/" + endpoint + "t=" + System.currentTimeMillis(), "GET", h, null, true, false, FRAME_TIMEOUT_MS, 32 * 1024 * 1024);
        } catch (java.net.SocketTimeoutException e) {
            return text(504, "Gateway Timeout", "The rig took too long to answer");
        } catch (Exception e) {
            return text(502, "Bad Gateway", String.valueOf(e.getMessage()));
        }
        String type = r.headers.containsKey("content-type") ? r.headers.get("content-type") : "";
        // A sign-in page (or a redirect to one) instead of a picture: signed out.
        if ((r.status >= 200 && r.status < 300 && !type.matches("^(image|video)/.*")) || r.status == 401 || r.status < 200 || (r.status >= 300 && r.status < 400)) {
            return text(401, "Unauthorized", "Signed out");
        }
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        for (String k : new String[]{"x-codec-string", "x-frame-stale", "x-frame-age-ms", "x-frame-unix-ns"}) {
            if (r.headers.containsKey(k)) h.put(k, r.headers.get(k));
        }
        String mime = type.isEmpty() ? "application/octet-stream" : type.split(";")[0].trim();
        return new WebResourceResponse(mime, null, r.status, r.status == 200 ? "OK" : "Error", h, new java.io.ByteArrayInputStream(r.body));
    }

    private static WebResourceResponse text(int status, String reason, String message) {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", status, reason, h, new java.io.ByteArrayInputStream(message.getBytes(StandardCharsets.UTF_8)));
    }

    @Override
    protected void handleOnDestroy() {
        pool.shutdownNow();
    }
}
