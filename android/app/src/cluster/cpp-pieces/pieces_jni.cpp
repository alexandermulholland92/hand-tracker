// pieces_jni.cpp — the Android Cluster app's way in to its own libtorrent (PiecesNative.java): a part of a big torrent
// by pieces, for the cluster's downloads (cluster/pieces-native/ht_pieces.cpp, which the iPhone's app has too).
#include <jni.h>

#include <string>

#include "ht_pieces.h"

namespace {
std::string str(JNIEnv* env, jstring s) {
    if (s == nullptr) {
        return {};
    }
    const char* c = env->GetStringUTFChars(s, nullptr);
    std::string out = c != nullptr ? c : "";
    if (c != nullptr) {
        env->ReleaseStringUTFChars(s, c);
    }
    return out;
}
}  // namespace

extern "C" JNIEXPORT jstring JNICALL Java_com_handtracker_app_PiecesNative_start(JNIEnv* env, jclass /*cls*/, jstring jtorrent, jstring jfolder, jint first, jint end,
                                                                             jstring jstate, jint port) {
    char err[512] = {0};
    std::string torrent = str(env, jtorrent), folder = str(env, jfolder), state = str(env, jstate);
    int rc = ht_pc_start(torrent.c_str(), folder.c_str(), first, end, state.c_str(), port, err, sizeof err);
    return env->NewStringUTF(rc == 0 ? "" : (err[0] != '\0' ? err : "it didn't start"));
}

extern "C" JNIEXPORT jboolean JNICALL Java_com_handtracker_app_PiecesNative_running(JNIEnv* env, jclass /*cls*/, jstring jstate) {
    std::string state = str(env, jstate);
    return ht_pc_running(state.c_str()) != 0 ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT void JNICALL Java_com_handtracker_app_PiecesNative_stop(JNIEnv* env, jclass /*cls*/, jstring jstate) {
    std::string state = str(env, jstate);
    ht_pc_stop(state.c_str());
}
