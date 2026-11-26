package com.handtracker.app;

/**
 * This phone's own libtorrent (libpieces_jni.so, scripts/build-libtorrent-android.js): a part of a big torrent by
 * pieces, for the cluster's downloads split between devices (cluster/node/modules/downloads.py, through PhoneNative's
 * "pieces-start" / "pieces-stop" / "pieces-running"), as pieces.py on a Pi: only its pieces, into its folder, its
 * status and control files in its state folder (cluster/pieces-native/ht_pieces.cpp, shared with the iPhone's app).
 * Only the Cluster app has it.
 */
public final class PiecesNative {
    private static boolean loaded;

    private PiecesNative() {
    }

    static synchronized boolean load() {
        if (!loaded) {
            try {
                System.loadLibrary("pieces_jni");
                loaded = true;
            } catch (UnsatisfiedLinkError e) {
                return false;
            }
        }
        return true;
    }

    // "" when it's going (or was already), else why not
    static native String start(String torrent, String folder, int first, int end, String state, int port);

    static native boolean running(String state);

    static native void stop(String state);
}
