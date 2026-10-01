package com.handtracker.app;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Udp — a UDP socket for the page, used to control a PC over Wi-Fi (mobile-bridge.js,
 * phone-link-protocol.js, which signs every message).
 *
 *   open() -> { port }                       binds a socket on any free port (once)
 *   send({ data, host, port })               a datagram (base64) to host:port
 *   "packet" events { data, host, port }     every datagram that arrives
 *   close()
 */
@CapacitorPlugin(name = "Udp")
public class UdpPlugin extends Plugin {
    private final ExecutorService net = Executors.newSingleThreadExecutor();
    private volatile DatagramSocket socket;

    @PluginMethod
    public void open(PluginCall call) {
        net.execute(() -> {
            try {
                DatagramSocket s = socket;
                if (s == null || s.isClosed()) {
                    s = new DatagramSocket();
                    socket = s;
                    listen(s);
                }
                JSObject ret = new JSObject();
                ret.put("port", s.getLocalPort());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Couldn't open a network socket: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void send(PluginCall call) {
        final String data = call.getString("data", "");
        final String host = call.getString("host", "");
        final int port = call.getInt("port", 0);
        net.execute(() -> {
            DatagramSocket s = socket;
            if (s == null || s.isClosed()) {
                call.reject("Not open");
                return;
            }
            try {
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                s.send(new DatagramPacket(bytes, bytes.length, InetAddress.getByName(host), port));
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            }
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        DatagramSocket s = socket;
        socket = null;
        if (s != null) s.close();
        call.resolve();
    }

    private void listen(final DatagramSocket s) {
        Thread t = new Thread(() -> {
            byte[] buf = new byte[65536];
            while (!s.isClosed()) {
                try {
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    s.receive(p);
                    JSObject ev = new JSObject();
                    ev.put("data", Base64.encodeToString(Arrays.copyOf(p.getData(), p.getLength()), Base64.NO_WRAP));
                    ev.put("host", p.getAddress().getHostAddress());
                    ev.put("port", p.getPort());
                    notifyListeners("packet", ev);
                } catch (Exception e) {
                    if (s.isClosed()) break;
                }
            }
        }, "udp-receive");
        t.setDaemon(true);
        t.start();
    }

    @Override
    protected void handleOnDestroy() {
        DatagramSocket s = socket;
        socket = null;
        if (s != null) s.close();
        net.shutdownNow();
    }
}
