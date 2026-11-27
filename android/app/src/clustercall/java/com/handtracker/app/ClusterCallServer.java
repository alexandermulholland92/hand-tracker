package com.handtracker.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * ClusterCallServer — Cluster Call's own service on a phone (Android: ClusterCallService.java runs it), as
 * electron/cluster-call.js is on a computer, speaking the same: port 47860, GET /vc/hello, POST /vc/signal (a call's
 * offer, answer, hang up...), and POST /vc/announce (your devices, as a computer of yours lists them: a phone can't
 * ask Tailscale). Plain Java (no Android), so it's checked on a computer too (scripts/check-cluster-call.js).
 *
 * Who may ask: anything on your Tailscale network (the user's choice, 2026-11-27: a phone can't check whose a device
 * is, as a computer does with `tailscale whois`); never a web page (an Origin header), a POST only as JSON, at most
 * 256 KB. allowLocal: this device itself too (the checks).
 *
 *   ClusterCallServer s = new ClusterCallServer(name, PORT, false, listener); s.start(); ... s.stop();
 *   ClusterCallServer.send(address, signal, myName) -> its reply (a Map), or { ok: false, error }
 *   ClusterCallServer.hello(address) -> its hello (a Map), or null
 *   ClusterCallServer.parse(json) / ClusterCallServer.json(value): this file's own JSON (Map, List, String, Double,
 *   Boolean, null)
 */
public class ClusterCallServer {
    public static final int PORT = 47860;
    static final int BODY_MAX = 256 * 1024;
    static final Set<String> KINDS = new HashSet<>(Arrays.asList("offer", "answer", "decline", "busy", "cancel", "hangup", "state", "join"));
    static final Pattern CALL_ID = Pattern.compile("^[A-Za-z0-9_-]{8,64}$");
    static final Pattern IPV4 = Pattern.compile("^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}(:\\d{1,5})?$");

    /** What the service does with what comes. */
    public interface Listener {
        /** A call's signal (checked): its reply, or null for { ok: true }. */
        Map<String, Object> onSignal(Map<String, Object> signal);

        /** Your devices, as a computer of yours listed them. */
        void onAnnounce(List<Map<String, Object>> devices, String from);
    }

    private final String name;
    private final int port;
    private final boolean allowLocal;
    private final Listener listener;
    private ServerSocket server;
    private ExecutorService pool;
    private volatile boolean running;

    public ClusterCallServer(String name, int port, boolean allowLocal, Listener listener) {
        this.name = name;
        this.port = port;
        this.allowLocal = allowLocal;
        this.listener = listener;
    }

    public synchronized void start() throws IOException {
        if (running) return;
        server = new ServerSocket();
        server.setReuseAddress(true);
        server.bind(new InetSocketAddress(port));
        pool = Executors.newFixedThreadPool(4);
        running = true;
        Thread t = new Thread(() -> {
            while (running) {
                try {
                    Socket s = server.accept();
                    pool.execute(() -> handle(s));
                } catch (IOException e) {
                    if (!running) break;
                }
            }
        }, "cluster-call-server");
        t.setDaemon(true);
        t.start();
    }

    public synchronized void stop() {
        running = false;
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
        }
        if (pool != null) pool.shutdownNow();
        server = null;
    }

    public boolean isRunning() {
        return running;
    }

    /** Over Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48); this device itself when allowLocal. */
    public static boolean onTailnet(String ip) {
        if (ip == null) return false;
        String a = ip.startsWith("::ffff:") ? ip.substring(7) : ip;
        if (a.toLowerCase(Locale.ROOT).startsWith("fd7a:115c:a1e0:")) return true;
        String[] p = a.split("\\.");
        if (p.length != 4) return false;
        try {
            int b0 = Integer.parseInt(p[0]), b1 = Integer.parseInt(p[1]);
            return b0 == 100 && b1 >= 64 && b1 <= 127;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    boolean trusted(String ip) {
        if (onTailnet(ip)) return true;
        return allowLocal && ("127.0.0.1".equals(ip) || "0:0:0:0:0:0:0:1".equals(ip) || "::1".equals(ip));
    }

    // ---------- HTTP ----------
    private void handle(Socket s) {
        try (Socket sock = s) {
            sock.setSoTimeout(10000);
            InputStream in = sock.getInputStream();
            OutputStream out = sock.getOutputStream();
            String head = readHead(in);
            if (head == null) return;
            String[] lines = head.split("\r\n");
            String[] first = lines[0].split(" ");
            if (first.length < 2) return;
            String method = first[0], path = first[1];
            Map<String, String> headers = new LinkedHashMap<>();
            for (int i = 1; i < lines.length; i++) {
                int c = lines[i].indexOf(':');
                if (c > 0) headers.put(lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT), lines[i].substring(c + 1).trim());
            }
            InetAddress from = sock.getInetAddress();
            String ip = from == null ? "" : from.getHostAddress();
            if (headers.containsKey("origin")) {
                reply(out, 403, error("Not from a web page."));
                return;
            }
            if (!trusted(ip)) {
                reply(out, 403, error("Only devices on your Tailscale network."));
                return;
            }
            int q = path.indexOf('?');
            if (q >= 0) path = path.substring(0, q);
            if ("GET".equals(method) && "/vc/hello".equals(path)) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("app", "cluster-call");
                m.put("name", name);
                m.put("os", "android");
                reply(out, 200, m);
                return;
            }
            if ("POST".equals(method) && ("/vc/signal".equals(path) || "/vc/announce".equals(path))) {
                String type = headers.getOrDefault("content-type", "");
                if (!type.toLowerCase(Locale.ROOT).startsWith("application/json")) {
                    reply(out, 415, error("JSON only."));
                    return;
                }
                int length;
                try {
                    length = Integer.parseInt(headers.getOrDefault("content-length", "-1"));
                } catch (NumberFormatException e) {
                    length = -1;
                }
                if (length < 0 || length > BODY_MAX) {
                    reply(out, 413, error("Too big."));
                    return;
                }
                byte[] body = readBody(in, length);
                Object parsed;
                try {
                    parsed = parse(new String(body, StandardCharsets.UTF_8));
                } catch (RuntimeException e) {
                    reply(out, 400, error("Not JSON."));
                    return;
                }
                if (!(parsed instanceof Map)) {
                    reply(out, 400, error("Not JSON."));
                    return;
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> j = (Map<String, Object>) parsed;
                if ("/vc/announce".equals(path)) {
                    listener.onAnnounce(devicesOf(j.get("devices")), ip);
                    reply(out, 200, ok());
                    return;
                }
                Map<String, Object> signal = signalOf(j, ip);
                if (signal == null) {
                    reply(out, 400, error("Not a call's signal."));
                    return;
                }
                Map<String, Object> r = listener.onSignal(signal);
                reply(out, 200, r == null ? ok() : r);
                return;
            }
            reply(out, 404, error("Nothing here."));
        } catch (IOException | RuntimeException ignored) {
        }
    }

    /** A signal as it came, checked and kept to what a signal has (the same as electron/cluster-call.js). */
    static Map<String, Object> signalOf(Map<String, Object> j, String ip) {
        Object kind = j.get("kind"), call = j.get("call");
        if (!(kind instanceof String) || !KINDS.contains(kind) || !(call instanceof String) || !CALL_ID.matcher((String) call).matches()) return null;
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("kind", kind);
        s.put("call", call);
        String back = ip.startsWith("::ffff:") ? ip.substring(7) : ip;
        Object port = j.get("port");
        if (port instanceof Double && ("127.0.0.1".equals(back))) back = back + ":" + ((Double) port).intValue(); // (the checks)
        Map<String, Object> from = new LinkedHashMap<>();
        from.put("address", back);
        String name = j.get("name") instanceof String ? (String) j.get("name") : "";
        from.put("name", name.isEmpty() ? back : name.substring(0, Math.min(80, name.length())));
        s.put("from", from);
        Object sdp = j.get("sdp");
        if (sdp != null) {
            if (!(sdp instanceof String) || ((String) sdp).length() > 200000) return null;
            s.put("sdp", sdp);
        }
        if (j.get("state") instanceof Map) {
            Map<?, ?> st = (Map<?, ?>) j.get("state");
            Map<String, Object> state = new LinkedHashMap<>();
            state.put("muted", Boolean.TRUE.equals(st.get("muted")));
            state.put("camera", !Boolean.FALSE.equals(st.get("camera")));
            s.put("state", state);
        }
        if (j.get("video") instanceof Boolean) s.put("video", j.get("video"));
        if (j.get("members") instanceof List) {
            List<Object> members = new ArrayList<>();
            for (Object m : (List<?>) j.get("members")) {
                if (!(m instanceof Map) || members.size() >= 16) continue;
                Map<String, Object> one = new LinkedHashMap<>();
                one.put("address", clip(((Map<?, ?>) m).get("address"), 80));
                one.put("name", clip(((Map<?, ?>) m).get("name"), 80));
                members.add(one);
            }
            s.put("members", members);
        }
        return s;
    }

    /** Your devices as announced: [{ name, address, os, app }] (at most 64, each an IPv4 Tailscale address). */
    static List<Map<String, Object>> devicesOf(Object list) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (!(list instanceof List)) return out;
        for (Object o : (List<?>) list) {
            if (!(o instanceof Map) || out.size() >= 64) continue;
            Map<?, ?> d = (Map<?, ?>) o;
            String address = clip(d.get("address"), 80);
            if (!IPV4.matcher(address).matches()) continue;
            Map<String, Object> one = new LinkedHashMap<>();
            one.put("name", clip(d.get("name"), 80));
            one.put("address", address);
            one.put("os", clip(d.get("os"), 20));
            one.put("app", Boolean.TRUE.equals(d.get("app")));
            out.add(one);
        }
        return out;
    }

    private static String clip(Object o, int n) {
        String s = o instanceof String ? (String) o : "";
        return s.length() > n ? s.substring(0, n) : s;
    }

    private static Map<String, Object> ok() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", true);
        return m;
    }

    private static Map<String, Object> error(String why) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", false);
        m.put("error", why);
        return m;
    }

    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c, state = 0;
        while ((c = in.read()) >= 0) {
            b.write(c);
            if (b.size() > 16384) return null;
            state = (c == '\r' && (state == 0 || state == 2)) ? state + 1 : (c == '\n' && (state == 1 || state == 3)) ? state + 1 : 0;
            if (state == 4) return new String(b.toByteArray(), StandardCharsets.ISO_8859_1).trim();
        }
        return null;
    }

    private static byte[] readBody(InputStream in, int length) throws IOException {
        byte[] body = new byte[length];
        int got = 0;
        while (got < length) {
            int n = in.read(body, got, length - got);
            if (n < 0) break;
            got += n;
        }
        return body;
    }

    private static void reply(OutputStream out, int code, Map<String, Object> body) throws IOException {
        byte[] data = json(body).getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + code + " " + (code == 200 ? "OK" : "Error") + "\r\nContent-Type: application/json\r\nContent-Length: " + data.length
                + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.write(data);
        out.flush();
    }

    // ---------- Asking another device's app ----------
    private static String at(String address) {
        return address.matches(".*:\\d+$") ? address : address + ":" + PORT;
    }

    /** A signal to that device's app (with this device's name): its reply, or { ok: false, error }. */
    public static Map<String, Object> send(String address, Map<String, Object> signal, String myName) {
        Map<String, Object> body = new LinkedHashMap<>(signal);
        body.put("name", myName);
        try {
            Object r = request("http://" + at(address) + "/vc/signal", json(body), 8000);
            if (r instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> m = (Map<String, Object>) r;
                return m;
            }
            return error("It didn't say.");
        } catch (IOException | RuntimeException e) {
            return error("That device didn't answer (" + e.getMessage() + ").");
        }
    }

    /** That device's app's hello, or null (not there, or not Cluster Call). */
    public static Map<String, Object> hello(String address) {
        try {
            Object r = request("http://" + at(address) + "/vc/hello", null, 2500);
            if (r instanceof Map && "cluster-call".equals(((Map<?, ?>) r).get("app"))) {
                @SuppressWarnings("unchecked")
                Map<String, Object> m = (Map<String, Object>) r;
                return m;
            }
        } catch (IOException | RuntimeException ignored) {
        }
        return null;
    }

    /** Your devices to a phone (a computer does this; here for the checks). */
    public static boolean announce(String address, List<Map<String, Object>> devices) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("devices", devices);
        try {
            Object r = request("http://" + at(address) + "/vc/announce", json(body), 4000);
            return r instanceof Map && Boolean.TRUE.equals(((Map<?, ?>) r).get("ok"));
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    private static Object request(String url, String body, int timeout) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(timeout);
        c.setReadTimeout(timeout);
        if (body != null) {
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            byte[] data = body.getBytes(StandardCharsets.UTF_8);
            c.setRequestProperty("Content-Type", "application/json");
            c.setFixedLengthStreamingMode(data.length);
            try (OutputStream o = c.getOutputStream()) {
                o.write(data);
            }
        }
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        if (in == null) throw new IOException("it said " + code);
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            b.write(buf, 0, n);
            if (b.size() > BODY_MAX) throw new IOException("too much");
        }
        in.close();
        Object r = parse(new String(b.toByteArray(), StandardCharsets.UTF_8));
        if (code >= 400 && r instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> m = (Map<String, Object>) r;
            m.put("ok", false);
            if (!(m.get("error") instanceof String)) m.put("error", "It said " + code + ".");
        }
        return r;
    }

    // ---------- JSON (its own: the same on a phone and on a computer's Java) ----------
    public static Object parse(String text) {
        int[] at = {0};
        Object v = value(text, at);
        skip(text, at);
        if (at[0] != text.length()) throw new IllegalArgumentException("trailing");
        return v;
    }

    private static void skip(String t, int[] at) {
        while (at[0] < t.length() && Character.isWhitespace(t.charAt(at[0]))) at[0]++;
    }

    private static Object value(String t, int[] at) {
        skip(t, at);
        if (at[0] >= t.length()) throw new IllegalArgumentException("end");
        char c = t.charAt(at[0]);
        if (c == '{') {
            Map<String, Object> m = new LinkedHashMap<>();
            at[0]++;
            skip(t, at);
            if (t.charAt(at[0]) == '}') {
                at[0]++;
                return m;
            }
            while (true) {
                skip(t, at);
                String k = string(t, at);
                skip(t, at);
                if (t.charAt(at[0]++) != ':') throw new IllegalArgumentException(":");
                m.put(k, value(t, at));
                skip(t, at);
                char d = t.charAt(at[0]++);
                if (d == '}') return m;
                if (d != ',') throw new IllegalArgumentException(",");
            }
        }
        if (c == '[') {
            List<Object> l = new ArrayList<>();
            at[0]++;
            skip(t, at);
            if (t.charAt(at[0]) == ']') {
                at[0]++;
                return l;
            }
            while (true) {
                l.add(value(t, at));
                skip(t, at);
                char d = t.charAt(at[0]++);
                if (d == ']') return l;
                if (d != ',') throw new IllegalArgumentException(",");
            }
        }
        if (c == '"') return string(t, at);
        if (t.startsWith("true", at[0])) {
            at[0] += 4;
            return Boolean.TRUE;
        }
        if (t.startsWith("false", at[0])) {
            at[0] += 5;
            return Boolean.FALSE;
        }
        if (t.startsWith("null", at[0])) {
            at[0] += 4;
            return null;
        }
        int start = at[0];
        while (at[0] < t.length() && "+-0123456789.eE".indexOf(t.charAt(at[0])) >= 0) at[0]++;
        if (start == at[0]) throw new IllegalArgumentException("value");
        return Double.parseDouble(t.substring(start, at[0]));
    }

    private static String string(String t, int[] at) {
        if (t.charAt(at[0]) != '"') throw new IllegalArgumentException("\"");
        at[0]++;
        StringBuilder b = new StringBuilder();
        while (true) {
            char c = t.charAt(at[0]++);
            if (c == '"') return b.toString();
            if (c != '\\') {
                b.append(c);
                continue;
            }
            char e = t.charAt(at[0]++);
            switch (e) {
                case 'n': b.append('\n'); break;
                case 'r': b.append('\r'); break;
                case 't': b.append('\t'); break;
                case 'b': b.append('\b'); break;
                case 'f': b.append('\f'); break;
                case 'u':
                    b.append((char) Integer.parseInt(t.substring(at[0], at[0] + 4), 16));
                    at[0] += 4;
                    break;
                default: b.append(e);
            }
        }
    }

    public static String json(Object v) {
        StringBuilder b = new StringBuilder();
        write(b, v);
        return b.toString();
    }

    private static void write(StringBuilder b, Object v) {
        if (v == null) b.append("null");
        else if (v instanceof String) quote(b, (String) v);
        else if (v instanceof Boolean) b.append(v.toString());
        else if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            if (d == Math.rint(d) && Math.abs(d) < 1e15) b.append((long) d);
            else b.append(d);
        } else if (v instanceof Map) {
            b.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!first) b.append(',');
                first = false;
                quote(b, String.valueOf(e.getKey()));
                b.append(':');
                write(b, e.getValue());
            }
            b.append('}');
        } else if (v instanceof List) {
            b.append('[');
            boolean first = true;
            for (Object o : (List<?>) v) {
                if (!first) b.append(',');
                first = false;
                write(b, o);
            }
            b.append(']');
        } else quote(b, v.toString());
    }

    private static void quote(StringBuilder b, String s) {
        b.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c == '\n') b.append("\\n");
            else if (c == '\r') b.append("\\r");
            else if (c == '\t') b.append("\\t");
            else if (c < 0x20) b.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
            else b.append(c);
        }
        b.append('"');
    }
}
