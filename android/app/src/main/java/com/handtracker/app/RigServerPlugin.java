package com.handtracker.app;

import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * RigServer — remote recording on the phone itself: while it's on, another device (the PC's
 * Hand Tracker, from its Remote recording page, or any browser) starts and stops motion
 * capture with this phone's camera, the same way as on a computer running Hand Tracker
 * (electron/remote-record.js, whose rules this follows): the page (remote-client.html, from the
 * app's own files), its state, a preview of the camera (bigger and more often full screen),
 * and commands, which the page (remote-record-ui.js) carries out and answers.
 *
 * Over Tailscale no code is needed (only your own devices reach the phone there, encrypted);
 * on the local network every request carries the key (shown in the app). Without the key, a
 * request must be addressed to the phone by an address or name of its own (not a website's
 * name, "DNS rebinding"), and a command must be JSON from the page itself.
 *
 *   start({ key }) / stop() / status() / setKey({ key }) -> { on, port, addresses, urls, viewer }
 *   setState({ state: json }); setPreview({ i, jpeg: base64 }); result({ id, result: json })
 *   events: "command" { id, action, details?, settings? }, "wantPreviews" { on, focus }, "status"
 */
@CapacitorPlugin(name = "RigServer")
public class RigServerPlugin extends Plugin {
    private static final int FIRST_PORT = 47821;
    private static final int PORTS_TRIED = 10;
    private static final long PREVIEW_WANTED_MS = 3000;
    private static final long PREVIEW_STALE_MS = 5000;
    private static final long FOCUS_MS = 1500;
    private static final long NEXT_WAIT_MS = 400; // a preview request waits this long for that camera's next picture
    private static final long VIEWER_GONE_MS = 10000;
    private static final long ANSWER_MS = 30000;
    private static final int HEAD_BYTES = 16 * 1024;
    private static final int BODY_BYTES = 8192;
    private static final Set<String> ACTIONS = new HashSet<>(java.util.Arrays.asList(
            "cameras", "record", "stop", "close", "details", "camera", "scan", "pick", "mode", "settings", "sentry"));
    private static final Set<String> ROLES = new HashSet<>(java.util.Arrays.asList("", "head", "chest", "wrist_left", "wrist_right"));
    private static final Set<String> MODES = new HashSet<>(java.util.Arrays.asList("ego", "stereo", "freeform"));
    private static final String CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'";

    private final ExecutorService pool = Executors.newCachedThreadPool();
    private ScheduledExecutorService ticker;
    private volatile ServerSocket server;
    private volatile int port = 0;
    private volatile String key = "";
    private volatile String stateJson = "{}";
    private static class Frame {
        final byte[] jpeg;
        final long at;
        Frame(byte[] jpeg, long at) { this.jpeg = jpeg; this.at = at; }
    }
    private final Map<Integer, Frame> previews = new ConcurrentHashMap<>();
    private final Map<Integer, Long> lastSent = new ConcurrentHashMap<>();
    private volatile long wantUntil = 0, focusUntil = 0;
    private volatile boolean wanting = false;
    private volatile Integer focus = null;
    private final Map<Integer, CompletableFuture<String>> pending = new ConcurrentHashMap<>();
    private final AtomicInteger asked = new AtomicInteger();
    private volatile String viewerAddress = null;
    private volatile long viewerSeen = 0;

    // ---------- from the page ----------
    @PluginMethod
    public void start(PluginCall call) {
        String k = call.getString("key", "");
        if (k == null || !k.matches("[A-Za-z0-9_-]{8,64}")) {
            call.reject("A key is needed.");
            return;
        }
        key = k;
        if (server == null) {
            IOException last = null;
            for (int p = FIRST_PORT; p < FIRST_PORT + PORTS_TRIED && server == null; p++) {
                try {
                    ServerSocket s = new ServerSocket();
                    s.setReuseAddress(true);
                    s.bind(new InetSocketAddress(p));
                    server = s;
                    port = p;
                } catch (IOException e) {
                    last = e;
                }
            }
            if (server == null) {
                call.reject("No free port for remote recording" + (last != null ? " (" + last.getMessage() + ")" : "") + ".");
                return;
            }
            final ServerSocket s = server;
            pool.execute(() -> {
                while (!s.isClosed()) {
                    try {
                        final Socket client = s.accept();
                        pool.execute(() -> serve(client));
                    } catch (IOException e) {
                        // closed
                    }
                }
            });
            ticker = Executors.newSingleThreadScheduledExecutor();
            ticker.scheduleWithFixedDelay(this::tick, 1, 1, TimeUnit.SECONDS);
        }
        JSObject st = status();
        notifyListeners("status", st);
        call.resolve(st);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ServerSocket s = server;
        server = null;
        port = 0;
        if (s != null) {
            try {
                s.close();
            } catch (IOException ignored) {
            }
        }
        if (ticker != null) ticker.shutdownNow();
        ticker = null;
        setWanting(false);
        previews.clear();
        viewerAddress = null;
        JSObject st = status();
        notifyListeners("status", st);
        call.resolve(st);
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(status());
    }

    @PluginMethod
    public void setKey(PluginCall call) {
        String k = call.getString("key", "");
        if (k == null || !k.matches("[A-Za-z0-9_-]{8,64}")) {
            call.reject("That isn't a key.");
            return;
        }
        key = k;
        viewerAddress = null;
        JSObject st = status();
        notifyListeners("status", st);
        call.resolve(st);
    }

    @PluginMethod
    public void setState(PluginCall call) {
        String s = call.getString("state", "{}");
        if (s != null && s.length() < 256 * 1024) stateJson = s;
        call.resolve();
    }

    @PluginMethod
    public void setPreview(PluginCall call) {
        Integer i = call.getInt("i", -1);
        String b64 = call.getString("jpeg", "");
        if (i != null && i >= 0 && i < 16 && b64 != null && !b64.isEmpty()) {
            try {
                previews.put(i, new Frame(Base64.decode(b64, Base64.DEFAULT), System.currentTimeMillis()));
            } catch (IllegalArgumentException ignored) {
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void result(PluginCall call) {
        Integer id = call.getInt("id", -1);
        CompletableFuture<String> f = id == null ? null : pending.remove(id);
        if (f != null) f.complete(call.getString("result", "{}"));
        call.resolve();
    }

    // ---------- status ----------
    private static boolean isTailscale(String a) {
        String[] p = a.replace("::ffff:", "").split("\\.");
        if (p.length != 4) return false;
        try {
            int x = Integer.parseInt(p[0]), y = Integer.parseInt(p[1]);
            return x == 100 && y >= 64 && y <= 127;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    // This phone's addresses another device could use: [address, kind].
    private static List<String[]> addresses() {
        List<String[]> out = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || a.isLinkLocalAddress()) continue;
                    String ip = a.getHostAddress();
                    String kind = isTailscale(ip) ? "Tailscale" : ni.getName().startsWith("wlan") ? "Wi-Fi" : a.isSiteLocalAddress() ? "local network" : null;
                    if (kind != null) out.add(new String[] { ip, kind });
                }
            }
        } catch (Exception ignored) {
        }
        out.sort((x, y) -> Boolean.compare("Tailscale".equals(x[1]), "Tailscale".equals(y[1])));
        return out;
    }

    private JSObject status() {
        JSObject st = new JSObject();
        boolean on = server != null;
        st.put("on", on);
        st.put("port", on ? port : null);
        JSArray list = new JSArray();
        JSArray urls = new JSArray();
        if (on) {
            for (String[] a : addresses()) {
                JSObject o = new JSObject();
                o.put("address", a[0]);
                o.put("kind", a[1]);
                list.put(o);
                boolean keyed = !"Tailscale".equals(a[1]);
                JSObject u = new JSObject();
                u.put("kind", a[1]);
                u.put("url", "http://" + a[0] + ":" + port + "/" + (keyed ? "#k=" + key : ""));
                u.put("keyed", keyed);
                urls.put(u);
            }
        }
        st.put("addresses", list);
        st.put("urls", urls);
        if (viewerAddress != null && System.currentTimeMillis() - viewerSeen < VIEWER_GONE_MS) {
            JSObject v = new JSObject();
            v.put("address", viewerAddress);
            v.put("seen", viewerSeen);
            st.put("viewer", v);
        } else {
            st.put("viewer", JSObject.NULL);
        }
        return st;
    }

    private void tick() {
        long now = System.currentTimeMillis();
        if (focus != null && now > focusUntil) setFocus(null);
        if (wanting && now > wantUntil) setWanting(false);
        if (viewerAddress != null && now - viewerSeen > VIEWER_GONE_MS) {
            viewerAddress = null;
            notifyListeners("status", status());
        }
    }

    private void setFocus(Integer i) {
        if (i == null ? focus == null : i.equals(focus)) return;
        focus = i;
        // Newly full screen: its next picture is the bigger one (not the small one already here).
        if (i != null) lastSent.put(i, System.currentTimeMillis());
        if (wanting) wantEvent();
    }

    private void setWanting(boolean on) {
        if (wanting == on) return;
        wanting = on;
        wantEvent();
    }

    private void wantEvent() {
        JSObject w = new JSObject();
        w.put("on", wanting);
        w.put("focus", wanting && focus != null ? focus : JSObject.NULL);
        notifyListeners("wantPreviews", w);
    }

    // ---------- requests ----------
    private static class Request {
        String method, path, query;
        Map<String, String> headers = new HashMap<>();
        byte[] body = new byte[0];
        String localAddress, remoteAddress;
    }

    private void serve(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(15000);
            Request req = read(s);
            if (req == null) return;
            handle(req, s.getOutputStream());
        } catch (Exception ignored) {
            // the other side went away
        }
    }

    private static int find(byte[] b, int len) {
        for (int i = 3; i < len; i++) if (b[i - 3] == '\r' && b[i - 2] == '\n' && b[i - 1] == '\r' && b[i] == '\n') return i + 1;
        return -1;
    }

    private Request read(Socket s) throws IOException {
        InputStream in = s.getInputStream();
        byte[] buf = new byte[HEAD_BYTES];
        int len = 0, end = -1;
        while (end < 0) {
            if (len == buf.length) return null;
            int n = in.read(buf, len, buf.length - len);
            if (n < 0) return null;
            len += n;
            end = find(buf, len);
        }
        String[] lines = new String(buf, 0, end, StandardCharsets.ISO_8859_1).split("\r\n");
        String[] first = lines[0].split(" ");
        if (first.length < 3) return null;
        Request r = new Request();
        r.method = first[0];
        int q = first[1].indexOf('?');
        r.path = q < 0 ? first[1] : first[1].substring(0, q);
        r.query = q < 0 ? "" : first[1].substring(q + 1);
        for (int i = 1; i < lines.length; i++) {
            int c = lines[i].indexOf(':');
            if (c > 0) r.headers.put(lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT), lines[i].substring(c + 1).trim());
        }
        int want = 0;
        try {
            want = Integer.parseInt(r.headers.getOrDefault("content-length", "0"));
        } catch (NumberFormatException e) {
            return null;
        }
        if (want < 0 || want > BODY_BYTES) want = BODY_BYTES + 1;
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        body.write(buf, end, Math.min(len - end, Math.max(want, 0)));
        while (body.size() < want && body.size() <= BODY_BYTES) {
            int n = in.read(buf);
            if (n < 0) break;
            body.write(buf, 0, Math.min(n, want - body.size()));
        }
        r.body = body.toByteArray();
        r.localAddress = s.getLocalAddress().getHostAddress();
        r.remoteAddress = s.getInetAddress().getHostAddress();
        return r;
    }

    private static void send(OutputStream out, int code, String type, byte[] body, String csp) throws IOException {
        String reason = code == 200 ? "OK" : code == 204 ? "No Content" : code == 400 ? "Bad Request" : code == 401 ? "Unauthorized" : code == 403 ? "Forbidden" : code == 404 ? "Not Found" : code == 413 ? "Too Large" : "Error";
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(code).append(' ').append(reason).append("\r\n")
                .append("Content-Type: ").append(type).append("\r\n")
                .append("Content-Length: ").append(body.length).append("\r\n")
                .append("Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n");
        if (csp != null) h.append("Content-Security-Policy: ").append(csp).append("\r\n");
        h.append("\r\n");
        out.write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
        out.write(body);
        out.flush();
    }

    private static void json(OutputStream out, int code, JSONObject o) throws IOException {
        send(out, code, "application/json; charset=utf-8", o.toString().getBytes(StandardCharsets.UTF_8), null);
    }

    private static JSONObject error(String message) {
        JSONObject o = new JSONObject();
        try {
            o.put("error", message);
        } catch (Exception ignored) {
        }
        return o;
    }

    private byte[] asset(String name) throws IOException {
        try (InputStream in = getContext().getAssets().open("public/" + name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] b = new byte[16 * 1024];
            int n;
            while ((n = in.read(b)) > 0) out.write(b, 0, n);
            return out.toByteArray();
        }
    }

    // The names this phone goes by: its addresses, "localhost", a bare name (as Tailscale's
    // short names are) or a Tailscale name (….ts.net). A website's own name is none of these.
    private static boolean ownHost(String hostHeader) {
        String host = hostHeader == null ? "" : hostHeader.toLowerCase(Locale.ROOT).replaceAll(":\\d+$", "").replaceAll("^\\[|\\]$", "");
        if (host.isEmpty()) return false;
        if (host.equals("localhost") || host.endsWith(".ts.net") || host.matches("[a-z0-9]([a-z0-9-]*[a-z0-9])?")) return true;
        for (String[] a : addresses()) if (a[0].equals(host)) return true;
        return host.equals("127.0.0.1");
    }

    private boolean authorized(Request r) {
        if (isTailscale(r.localAddress) && isTailscale(r.remoteAddress) && ownHost(r.headers.get("host"))) return true;
        byte[] given = r.headers.getOrDefault("x-key", "").getBytes(StandardCharsets.UTF_8);
        byte[] k = key.getBytes(StandardCharsets.UTF_8);
        return k.length > 0 && MessageDigest.isEqual(given, k);
    }

    private static String param(String query, String name) {
        for (String part : query.split("&")) {
            int e = part.indexOf('=');
            String k = e < 0 ? part : part.substring(0, e);
            if (k.equals(name)) {
                try {
                    return URLDecoder.decode(e < 0 ? "" : part.substring(e + 1), "UTF-8");
                } catch (Exception ex) {
                    return "";
                }
            }
        }
        return null;
    }

    private static String clean(Object v, int max) {
        String s = v == null || v == JSONObject.NULL ? "" : String.valueOf(v);
        s = s.replaceAll("[\\u0000-\\u001f\\u007f]+", " ").trim();
        return s.length() > max ? s.substring(0, max) : s;
    }

    private void handle(Request r, OutputStream out) throws Exception {
        if ("GET".equals(r.method) && ("/".equals(r.path) || "/index.html".equals(r.path))) {
            send(out, 200, "text/html; charset=utf-8", asset("remote-client.html"), CSP);
            return;
        }
        if ("GET".equals(r.method) && "/remote-client.js".equals(r.path)) {
            send(out, 200, "text/javascript; charset=utf-8", asset("remote-client.js"), null);
            return;
        }
        if (!r.path.startsWith("/api/")) {
            json(out, 404, error("Not found"));
            return;
        }
        if (!authorized(r)) {
            json(out, 401, error("This page's key isn't the one Hand Tracker shows now."));
            return;
        }
        String address = r.remoteAddress;
        boolean newViewer = viewerAddress == null || !viewerAddress.equals(address);
        viewerAddress = address;
        viewerSeen = System.currentTimeMillis();
        if (newViewer) notifyListeners("status", status());

        if ("GET".equals(r.method) && "/api/state".equals(r.path)) {
            JSONObject st;
            try {
                st = new JSONObject(stateJson);
            } catch (Exception e) {
                st = new JSONObject();
            }
            st.put("host", Build.MODEL);
            st.put("wifi", JSONObject.NULL);
            json(out, 200, st);
            return;
        }
        if ("GET".equals(r.method) && "/api/preview".equals(r.path)) {
            int i;
            try {
                i = Integer.parseInt(String.valueOf(param(r.query, "i")));
            } catch (NumberFormatException e) {
                i = -1;
            }
            boolean full = "1".equals(param(r.query, "full")) && i >= 0 && i < 16;
            wantUntil = System.currentTimeMillis() + PREVIEW_WANTED_MS;
            if (full) {
                focusUntil = System.currentTimeMillis() + FOCUS_MS;
                setFocus(i);
            }
            setWanting(true);
            // Each request waits for that camera's next picture (the page asks again as soon as it
            // has one, and gets each picture once).
            long since = lastSent.containsKey(i) ? lastSent.get(i) : 0;
            for (long t = 0; t < NEXT_WAIT_MS; t += 15) {
                Frame f = previews.get(i);
                if (f != null && f.at > since) break;
                Thread.sleep(15);
            }
            Frame next = previews.get(i);
            if (next != null) lastSent.put(i, next.at);
            Frame p = previews.get(i);
            if (p == null || System.currentTimeMillis() - p.at > PREVIEW_STALE_MS) send(out, 204, "application/json; charset=utf-8", new byte[0], null);
            else send(out, 200, "image/jpeg", p.jpeg, null);
            return;
        }
        if ("POST".equals(r.method) && "/api/command".equals(r.path)) {
            // From the page itself: JSON, and (if the browser says where from) this address.
            String origin = r.headers.get("origin");
            String type = r.headers.getOrDefault("content-type", "");
            if (!type.toLowerCase(Locale.ROOT).startsWith("application/json") || (origin != null && !origin.equals("http://" + r.headers.get("host")))) {
                json(out, 403, error("Only Hand Tracker's own page can do that."));
                return;
            }
            if (r.body.length > BODY_BYTES) {
                json(out, 413, error("Too long"));
                return;
            }
            JSONObject msg;
            try {
                msg = new JSONObject(new String(r.body, StandardCharsets.UTF_8));
            } catch (Exception e) {
                json(out, 400, error("Not JSON"));
                return;
            }
            String action = msg.optString("action", "");
            if (!ACTIONS.contains(action)) {
                json(out, 400, error("Unknown action: " + action));
                return;
            }
            JSObject cmd = new JSObject();
            int id = asked.incrementAndGet();
            cmd.put("id", id);
            cmd.put("action", action);
            JSONObject d = msg.optJSONObject("details");
            if (d != null) {
                JSObject details = new JSObject();
                for (String k : new String[] { "contributor", "location", "task" }) details.put(k, clean(d.opt(k), 200));
                cmd.put("details", details);
            }
            // Settings: whether the take details are needed, and each camera's video (and its
            // sound) with the take, as booleans; the video's quality, one of camera-video.js's.
            JSONObject st = msg.optJSONObject("settings");
            if (st != null) {
                JSObject settings = new JSObject();
                for (String k : new String[] { "detailsRequired", "video", "sound" }) {
                    if (st.opt(k) instanceof Boolean) settings.put(k, st.optBoolean(k));
                }
                String q = st.opt("videoQuality") instanceof String ? st.optString("videoQuality") : "";
                if (q.matches("low|standard|high|best")) settings.put("videoQuality", q);
                if (settings.length() > 0) cmd.put("settings", settings);
            }
            // Sentry mode (sentry.js): checked as the computer checks it (cleanSentry in
            // electron/remote-record.js).
            JSObject sentry = cleanSentry(msg.optJSONObject("sentry"));
            if (sentry != null) cmd.put("sentry", sentry);
            // The cameras to start (picked, with a role), the mode, and a running camera's role,
            // turn and flip: checked as the computer checks them (electron/remote-record.js).
            JSONObject pk = msg.optJSONObject("pick");
            if (pk != null && pk.opt("id") instanceof String && pk.optString("id").matches("[A-Za-z0-9:._+/=-]{1,200}")) {
                JSObject pick = new JSObject();
                pick.put("id", pk.optString("id"));
                if (pk.opt("use") instanceof Boolean) pick.put("use", pk.optBoolean("use"));
                if (pk.opt("role") instanceof String && ROLES.contains(pk.optString("role"))) pick.put("role", pk.optString("role"));
                cmd.put("pick", pick);
            }
            if (msg.opt("mode") instanceof String && MODES.contains(msg.optString("mode"))) cmd.put("mode", msg.optString("mode"));
            JSONObject cm = msg.optJSONObject("camera");
            if (cm != null && cm.opt("index") instanceof Integer && cm.optInt("index") >= 0 && cm.optInt("index") <= 3) {
                JSObject camera = new JSObject();
                camera.put("index", cm.optInt("index"));
                if (cm.opt("role") instanceof String && ROLES.contains(cm.optString("role"))) camera.put("role", cm.optString("role"));
                if (cm.opt("rotation") instanceof Integer && java.util.Arrays.asList(0, 90, 180, 270).contains(cm.optInt("rotation"))) camera.put("rotation", cm.optInt("rotation"));
                if (cm.opt("mirror") instanceof Boolean) camera.put("mirror", cm.optBoolean("mirror"));
                cmd.put("camera", camera);
            }
            String missingPart = action.equals("pick") && !cmd.has("pick") ? "Which camera?"
                    : action.equals("camera") && !cmd.has("camera") ? "Which camera?"
                    : action.equals("mode") && !cmd.has("mode") ? "Which mode?"
                    : action.equals("settings") && !cmd.has("settings") ? "Which setting?"
                    : action.equals("sentry") && !cmd.has("sentry") ? "Which Sentry setting?" : null;
            if (missingPart != null) {
                json(out, 400, error(missingPart));
                return;
            }
            CompletableFuture<String> answer = new CompletableFuture<>();
            pending.put(id, answer);
            notifyListeners("command", cmd);
            String result;
            try {
                result = answer.get(ANSWER_MS, TimeUnit.MILLISECONDS);
            } catch (Exception e) {
                pending.remove(id);
                result = "{\"ok\":false,\"message\":\"Hand Tracker didn't answer.\"}";
            }
            // Only what the page needs: ok, message, the take details still missing, locked.
            JSONObject in = new JSONObject(result);
            JSONObject o = new JSONObject();
            o.put("ok", in.optBoolean("ok", true));
            o.put("message", clean(in.opt("message"), 500));
            JSONArray missing = in.optJSONArray("missing");
            if (missing != null) {
                JSONArray m = new JSONArray();
                for (int k = 0; k < missing.length(); k++) {
                    String f = missing.optString(k);
                    if (f.equals("contributor") || f.equals("location") || f.equals("task")) m.put(f);
                }
                o.put("missing", m);
            }
            if (in.optBoolean("locked", false)) o.put("locked", true);
            json(out, 200, o);
            return;
        }
        json(out, 404, error("Not found"));
    }

    // Sentry mode from the page: shown or not, on or off, its settings, a box of a running camera
    // left out or watched again, or every box watched; ntfy's server (a web address), a new topic
    // or a test; alerts deleted (by their ids) or all of Sentry's files. Only those, each
    // checked; null if there's nothing.
    private static final Pattern NTFY_SERVER = Pattern.compile("^https?://[^\\s/?#]+(/[^\\s?#]*)?$", Pattern.CASE_INSENSITIVE);
    private static final Pattern ALERT_ID = Pattern.compile("^[0-9]{1,15}-[a-z0-9]{1,8}$");
    static JSObject cleanSentry(JSONObject s) {
        if (s == null) return null;
        JSObject out = new JSObject();
        for (String k : new String[] { "shown", "armed", "ignoreAnimals", "photo", "video", "sound" }) {
            if (s.opt(k) instanceof Boolean) out.put(k, s.optBoolean(k));
        }
        if (s.opt("rows") instanceof Integer && s.optInt("rows") >= 1 && s.optInt("rows") <= 9) out.put("rows", s.optInt("rows"));
        if (s.opt("cols") instanceof Integer && s.optInt("cols") >= 1 && s.optInt("cols") <= 16) out.put("cols", s.optInt("cols"));
        String sens = s.optString("sensitivity", "");
        if (sens.equals("low") || sens.equals("medium") || sens.equals("high")) out.put("sensitivity", sens);
        JSONObject n = s.optJSONObject("ntfy");
        if (n != null) {
            JSObject ntfy = new JSObject();
            for (String k : new String[] { "on", "photo" }) if (n.opt(k) instanceof Boolean) ntfy.put(k, n.optBoolean(k));
            for (String k : new String[] { "newTopic", "test" }) if (Boolean.TRUE.equals(n.opt(k))) ntfy.put(k, true);
            Object server = n.opt("server");
            if (server instanceof String && ((String) server).length() <= 200 && NTFY_SERVER.matcher(((String) server).trim()).matches()) ntfy.put("server", ((String) server).trim());
            if (ntfy.length() > 0) out.put("ntfy", ntfy);
        }
        JSONObject b = s.optJSONObject("box");
        if (b != null && b.opt("camera") instanceof Integer && b.opt("cell") instanceof Integer && b.opt("off") instanceof Boolean
                && b.optInt("camera") >= 0 && b.optInt("camera") < 16 && b.optInt("cell") >= 0 && b.optInt("cell") < 9 * 16) {
            JSObject box = new JSObject();
            box.put("camera", b.optInt("camera"));
            box.put("cell", b.optInt("cell"));
            box.put("off", b.optBoolean("off"));
            out.put("box", box);
        }
        if (Boolean.TRUE.equals(s.opt("watchAll"))) out.put("watchAll", true);
        // Alerts deleted, with their photos and videos; or every Sentry photo and video.
        JSONArray ids = s.optJSONArray("deleteAlerts");
        if (ids != null && ids.length() >= 1 && ids.length() <= 50) {
            JSONArray kept = new JSONArray();
            for (int i = 0; i < ids.length(); i++) {
                Object id = ids.opt(i);
                if (!(id instanceof String) || !ALERT_ID.matcher((String) id).matches()) { kept = null; break; }
                kept.put(id);
            }
            if (kept != null) out.put("deleteAlerts", kept);
        }
        if (Boolean.TRUE.equals(s.opt("deleteAll"))) out.put("deleteAll", true);
        return out.length() > 0 ? out : null;
    }
}
