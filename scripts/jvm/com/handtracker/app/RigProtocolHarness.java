package com.handtracker.app;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * The phone app's end of the Bluetooth link (BtRigProtocol.java) on this computer's Java, for
 * scripts/check-android.js: a line each way instead of Bluetooth.
 *
 *   in:  rx <device> <mtu> <frame, base64>    a frame a device wrote to RX
 *   out: info <INFO's value, base64>          first
 *        tx <frame, base64>                   a notification on TX (to every device)
 *
 * Its stand-in for the phone's remote recording server answers GET /api/state (a long, repetitive
 * JSON), POST /api/command (what was sent, back), GET /api/preview (5000 bytes of a "picture").
 * Usage: java com.handtracker.app.RigProtocolHarness <password>
 */
public final class RigProtocolHarness {
    public static void main(String[] args) throws Exception {
        PrintStream out = new PrintStream(System.out, true, "UTF-8");
        byte[] salt = new byte[16];
        BtRigProtocol.RANDOM.nextBytes(salt);
        BtRigProtocol.Secret secret = new BtRigProtocol.Secret(Base64.getEncoder().encodeToString(salt), BtRigProtocol.ITERATIONS,
                BtRigProtocol.pbkdf2(args[0].getBytes(StandardCharsets.UTF_8), salt, BtRigProtocol.ITERATIONS));
        BtRigProtocol.Relay relay = (method, path, body) -> {
            if ("GET".equals(method) && path.startsWith("/api/state")) {
                StringBuilder filler = new StringBuilder();
                for (int i = 0; i < 300; i++) filler.append("camera ").append(i % 7).append(' ');
                return new BtRigProtocol.Answer(200, "application/json; charset=utf-8",
                        ("{\"kind\":\"rig\",\"host\":\"java-rig\",\"filler\":\"" + filler + "\"}").getBytes(StandardCharsets.UTF_8));
            }
            if ("POST".equals(method) && path.equals("/api/command")) {
                return new BtRigProtocol.Answer(200, "application/json; charset=utf-8",
                        ("{\"ok\":true,\"got\":" + org.json.JSONObject.quote(new String(body, StandardCharsets.UTF_8)) + "}").getBytes(StandardCharsets.UTF_8));
            }
            if ("GET".equals(method) && path.startsWith("/api/preview")) {
                byte[] pic = new byte[5000];
                for (int i = 0; i < pic.length; i++) pic[i] = (byte) ((i * 31) % 251);
                return new BtRigProtocol.Answer(200, "image/jpeg", pic);
            }
            return new BtRigProtocol.Answer(404, "application/json; charset=utf-8", "{\"error\":\"Not found\"}".getBytes(StandardCharsets.UTF_8));
        };
        BtRigProtocol link = new BtRigProtocol("java-rig", secret, relay, (frame) -> {
            synchronized (out) {
                out.println("tx " + Base64.getEncoder().encodeToString(frame));
            }
        });
        out.println("info " + Base64.getEncoder().encodeToString(link.info()));
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        for (String line; (line = in.readLine()) != null; ) {
            String[] w = line.trim().split(" ");
            if (w.length == 4 && w[0].equals("rx")) link.received(w[1], Base64.getDecoder().decode(w[3]), Integer.parseInt(w[2]));
        }
        System.exit(0);
    }
}
