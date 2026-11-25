// transmission_jni.cpp - this phone's own Transmission (libtransmission, in the Cluster app), for the cluster's
// downloads (cluster/node/modules/downloads.py: each computer downloads with a Transmission of its own, then copies
// what it got to pi). As transmission-daemon is on a Pi: its settings in its folder's settings.json (written by the
// service first: its remote control on 127.0.0.1:9094, its peers on 51415), its torrents those it had, until it's
// stopped. TransmissionNative.java; built by scripts/build-transmission-android.js.

#include <jni.h>

#include <cstdlib>
#include <mutex>
#include <string>

#include <libtransmission/transmission.h>
#include <libtransmission/utils.h> // tr_lib_init()
#include <libtransmission/variant.h>

namespace
{
std::mutex lock;
tr_session* session = nullptr;

std::string text(JNIEnv* env, jstring s)
{
    if (s == nullptr)
    {
        return {};
    }
    char const* c = env->GetStringUTFChars(s, nullptr);
    std::string out = c != nullptr ? c : "";
    if (c != nullptr)
    {
        env->ReleaseStringUTFChars(s, c);
    }
    return out;
}
} // namespace

// start(settings folder, CA bundle file) -> "" once it runs, else why not. (A bundle of Android's own certificates: the
// trackers' HTTPS checked against them, as curl can't find Android's itself.)
extern "C" JNIEXPORT jstring JNICALL Java_com_handtracker_app_TransmissionNative_start(JNIEnv* env, jclass /*cls*/, jstring jconfig, jstring jca)
{
    std::lock_guard<std::mutex> guard{ lock };
    if (session != nullptr)
    {
        return env->NewStringUTF("");
    }
    auto const config = text(env, jconfig);
    auto const ca = text(env, jca);
    if (config.empty())
    {
        return env->NewStringUTF("No settings folder.");
    }
    if (!ca.empty())
    {
        setenv("CURL_CA_BUNDLE", ca.c_str(), 1);
    }
    // (first, as Transmission's own programs do: without it no setting can be read, settings.json's included, and it
    // would run on its defaults, its remote control off; found in the iPhone's simulator check, 2026-11-25)
    tr_lib_init();
    auto const settings = tr_sessionLoadSettings(config);
    session = tr_sessionInit(config, false, settings);
    if (session == nullptr)
    {
        return env->NewStringUTF("It didn't start.");
    }
    auto* ctor = tr_ctorNew(session);
    tr_sessionLoadTorrents(session, ctor);
    tr_ctorFree(ctor);
    return env->NewStringUTF("");
}

// stop(): its torrents' state saved, then ended (up to 15 s for the trackers to hear it's gone).
extern "C" JNIEXPORT void JNICALL Java_com_handtracker_app_TransmissionNative_stop(JNIEnv* /*env*/, jclass /*cls*/)
{
    std::lock_guard<std::mutex> guard{ lock };
    if (session == nullptr)
    {
        return;
    }
    tr_sessionClose(session, 15);
    session = nullptr;
}

extern "C" JNIEXPORT jboolean JNICALL Java_com_handtracker_app_TransmissionNative_running(JNIEnv* /*env*/, jclass /*cls*/)
{
    std::lock_guard<std::mutex> guard{ lock };
    return session != nullptr ? JNI_TRUE : JNI_FALSE;
}
