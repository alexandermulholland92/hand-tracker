package com.handtracker.app;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * This phone's own Transmission (libtransmission_jni.so, scripts/build-transmission-android.js): the cluster's
 * downloads this phone takes (cluster/node/modules/downloads.py, through PhoneNative's "transmission-start" /
 * "transmission-stop"), as transmission-daemon on a Pi: its settings in its folder (written by the service first:
 * its remote control on 127.0.0.1 only). Trackers' HTTPS is checked against Android's own certificates, put in one
 * file for it (CA_FILE) as curl can't read Android's folder of them itself. Only the Cluster app has it.
 */
public final class TransmissionNative {
    private static final String CA_FILE = "transmission-cacerts.pem";
    private static final long CA_FRESH_MS = 24L * 3600 * 1000;
    private static final Pattern PEM = Pattern.compile("-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\\s]+?-----END CERTIFICATE-----");
    private static boolean loaded;

    private TransmissionNative() {
    }

    static synchronized boolean load() {
        if (!loaded) {
            try {
                System.loadLibrary("transmission_jni");
                loaded = true;
            } catch (UnsatisfiedLinkError e) {
                return false;
            }
        }
        return true;
    }

    static native String start(String configDir, String caBundle);

    static native void stop();

    static native boolean running();

    // (java.nio.file is Android 8's: the app runs on 7 too)
    private static byte[] readAll(File f) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[16384];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    // Android's own certificates as one file (made again once a day: an update may bring new ones).
    static String caBundle(Context c) {
        File out = new File(c.getFilesDir(), CA_FILE);
        if (out.exists() && System.currentTimeMillis() - out.lastModified() < CA_FRESH_MS) return out.getAbsolutePath();
        StringBuilder all = new StringBuilder();
        // (Android 14 keeps them in Conscrypt's own module; older ones in /system)
        for (String dir : new String[] {"/apex/com.android.conscrypt/cacerts", "/system/etc/security/cacerts"}) {
            File[] files = new File(dir).listFiles();
            if (files == null || files.length == 0) continue;
            for (File f : files) {
                try {
                    Matcher m = PEM.matcher(new String(readAll(f), StandardCharsets.US_ASCII));
                    while (m.find()) all.append(m.group()).append('\n');
                } catch (IOException ignored) {
                    // (one it can't read: left out)
                }
            }
            break;
        }
        if (all.length() == 0) return "";
        try (OutputStream o = new FileOutputStream(out)) {
            o.write(all.toString().getBytes(StandardCharsets.US_ASCII));
        } catch (IOException e) {
            return "";
        }
        return out.getAbsolutePath();
    }
}
