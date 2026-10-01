package com.handtracker.app;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.util.Arrays;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * NatNet — OptiTrack Motive's live stream on the phone: the UDP sockets only. The page
 * (natnet-parse.js, through mobile-bridge.js) speaks the protocol and reads the packets.
 *
 *   start({ server, multicast, multicastAddress, commandPort, dataPort }) -> { port }
 *   send({ data })                      a packet (base64) to Motive's command port
 *   "packet" events { data }            every packet Motive sends, except frames of data,
 *                                       which come at most 30 a second (the latest)
 *   recordStart() / recordStop() -> { count, bytes }, then recordRead({ offset, length })
 *                                       -> { data }: every frame, each as [length u32 LE][packet]
 *   stop()
 *
 * Android drops multicast packets unless an app holds a multicast lock, so one is held
 * while listening.
 */
@CapacitorPlugin(name = "NatNet")
public class NatNetPlugin extends Plugin {
    private static final int FRAME_OF_DATA = 7;
    private static final long FRAME_EVERY_NS = 33_000_000L;
    private static final int MAX_RECORDING_BYTES = 512 * 1024 * 1024;

    private final ExecutorService net = Executors.newSingleThreadExecutor();
    private volatile DatagramSocket command;
    private volatile MulticastSocket data;
    private volatile InetAddress server;
    private volatile int commandPort = 1510;
    private volatile boolean running;
    private WifiManager.MulticastLock lock;
    private long lastFrameSentNs;

    private final Object recordingLock = new Object();
    private ByteArrayOutputStream recording;
    private int recordedCount;
    private boolean recordingFull;
    private byte[] finished = new byte[0];

    @PluginMethod
    public void start(PluginCall call) {
        final String host = call.getString("server", "127.0.0.1");
        final boolean multicast = Boolean.TRUE.equals(call.getBoolean("multicast", true));
        final String group = call.getString("multicastAddress", "239.255.42.99");
        final int cmdPort = call.getInt("commandPort", 1510);
        final int dataPort = call.getInt("dataPort", 1511);
        net.execute(() -> {
            closeSockets();
            try {
                server = InetAddress.getByName(host);
                commandPort = cmdPort;
                running = true;
                // Any free port: Motive answers commands (and sends unicast data) to it.
                DatagramSocket cmd = new DatagramSocket();
                command = cmd;
                listen(cmd);
                if (multicast) {
                    WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                    if (wifi != null) {
                        lock = wifi.createMulticastLock("hand-tracker-natnet");
                        lock.setReferenceCounted(false);
                        lock.acquire();
                    }
                    MulticastSocket ms = new MulticastSocket(null);
                    ms.setReuseAddress(true);
                    ms.bind(new InetSocketAddress(dataPort));
                    ms.joinGroup(new InetSocketAddress(InetAddress.getByName(group), dataPort), interfaceFor(server));
                    data = ms;
                    listen(ms);
                }
                JSObject ret = new JSObject();
                ret.put("port", cmd.getLocalPort());
                call.resolve(ret);
            } catch (Exception e) {
                closeSockets();
                call.reject("Couldn't listen for Motive: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void send(PluginCall call) {
        final String b64 = call.getString("data", "");
        net.execute(() -> {
            DatagramSocket cmd = command;
            if (cmd == null || server == null) {
                call.reject("Not started");
                return;
            }
            try {
                byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                cmd.send(new DatagramPacket(bytes, bytes.length, server, commandPort));
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        net.execute(() -> {
            closeSockets();
            call.resolve();
        });
    }

    @PluginMethod
    public void recordStart(PluginCall call) {
        synchronized (recordingLock) {
            recording = new ByteArrayOutputStream(1 << 20);
            recordedCount = 0;
            recordingFull = false;
            finished = new byte[0];
        }
        call.resolve();
    }

    @PluginMethod
    public void recordStop(PluginCall call) {
        JSObject ret = new JSObject();
        synchronized (recordingLock) {
            finished = recording == null ? new byte[0] : recording.toByteArray();
            ret.put("count", recordedCount);
            ret.put("bytes", finished.length);
            ret.put("full", recordingFull);
            recording = null;
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void recordRead(PluginCall call) {
        int offset = call.getInt("offset", 0);
        int length = call.getInt("length", 3 * 1024 * 1024);
        byte[] all;
        synchronized (recordingLock) {
            all = finished;
        }
        int from = Math.max(0, Math.min(offset, all.length));
        int to = Math.max(from, Math.min(all.length, from + Math.max(0, length)));
        JSObject ret = new JSObject();
        ret.put("data", Base64.encodeToString(all, from, to - from, Base64.NO_WRAP));
        if (to >= all.length) {
            synchronized (recordingLock) {
                if (finished == all) finished = new byte[0];
            }
        }
        call.resolve(ret);
    }

    @Override
    protected void handleOnDestroy() {
        closeSockets();
        net.shutdownNow();
    }

    private void listen(final DatagramSocket socket) {
        Thread t = new Thread(() -> {
            byte[] buf = new byte[65536];
            while (running && !socket.isClosed()) {
                try {
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    socket.receive(p);
                    handle(Arrays.copyOf(p.getData(), p.getLength()));
                } catch (Exception e) {
                    if (!running || socket.isClosed()) break;
                }
            }
        }, "natnet-receive");
        t.setDaemon(true);
        t.start();
    }

    private void handle(byte[] packet) {
        if (packet.length < 4) return;
        int id = (packet[0] & 0xff) | ((packet[1] & 0xff) << 8);
        if (id == FRAME_OF_DATA) {
            synchronized (recordingLock) {
                if (recording != null && !recordingFull) {
                    if (recording.size() + packet.length + 4 > MAX_RECORDING_BYTES) recordingFull = true;
                    else {
                        int n = packet.length;
                        recording.write(n & 0xff);
                        recording.write((n >> 8) & 0xff);
                        recording.write((n >> 16) & 0xff);
                        recording.write((n >> 24) & 0xff);
                        recording.write(packet, 0, n);
                        recordedCount++;
                    }
                }
            }
            long now = System.nanoTime();
            if (now - lastFrameSentNs < FRAME_EVERY_NS) return;
            lastFrameSentNs = now;
        }
        JSObject ev = new JSObject();
        ev.put("data", Base64.encodeToString(packet, Base64.NO_WRAP));
        notifyListeners("packet", ev);
    }

    // The network that reaches Motive's PC (Wi-Fi, usually), for joining its multicast group.
    private static NetworkInterface interfaceFor(InetAddress target) {
        NetworkInterface fallback = null;
        try {
            byte[] t = target.getAddress();
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || !nif.supportsMulticast()) continue;
                for (InterfaceAddress ia : nif.getInterfaceAddresses()) {
                    if (!(ia.getAddress() instanceof Inet4Address) || t.length != 4) continue;
                    if (target.isLoopbackAddress() && nif.isLoopback()) return nif;
                    byte[] a = ia.getAddress().getAddress();
                    int bits = ia.getNetworkPrefixLength();
                    boolean same = true;
                    for (int i = 0; i < 4 && same; i++) {
                        int mask = bits >= 8 * (i + 1) ? 0xff : bits <= 8 * i ? 0 : (0xff << (8 - (bits - 8 * i))) & 0xff;
                        same = (a[i] & mask) == (t[i] & mask);
                    }
                    if (same) return nif;
                    if (fallback == null && !nif.isLoopback()) fallback = nif;
                }
            }
        } catch (Exception ignored) {
            // no interface list: let the system pick
        }
        return fallback;
    }

    private void closeSockets() {
        running = false;
        DatagramSocket c = command;
        MulticastSocket d = data;
        command = null;
        data = null;
        if (c != null) c.close();
        if (d != null) d.close();
        if (lock != null && lock.isHeld()) lock.release();
        lock = null;
    }
}
