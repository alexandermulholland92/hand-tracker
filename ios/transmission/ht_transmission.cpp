// ht_transmission.cpp - this iPhone's own Transmission (libtransmission, in the Cluster app: ClusterTransmission.framework,
// built by scripts/build-transmission-ios.sh), for the cluster's downloads (cluster/node/modules/downloads.py: each
// computer downloads with a Transmission of its own, then copies what it got to pi), as the Android app's
// (android/app/src/cluster/cpp/transmission_jni.cpp) and as transmission-daemon is on a Pi: its settings in its folder's
// settings.json (written by the service first: its remote control on 127.0.0.1:9094, its peers on 51415), its torrents
// those it had, until it's stopped. ClusterMember.swift calls it (ht_native_call's "transmission-start" and the rest).
//   int ht_tr_start(char const* config, char const* ca, char* err, int len)   0 once it runs (else err says why)
//   void ht_tr_stop(void)                                                     its torrents' state saved, then ended
//   int ht_tr_running(void)

#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <string>

#include <libtransmission/transmission.h>
#include <libtransmission/variant.h>

#define HT_EXPORT extern "C" __attribute__((visibility("default")))

namespace
{
std::mutex lock;
tr_session* session = nullptr;
} // namespace

// (ca: a file of root certificates, the trackers' HTTPS checked against them, as curl can't use the iPhone's own)
HT_EXPORT int ht_tr_start(char const* config, char const* ca, char* err, int len)
{
    std::lock_guard<std::mutex> guard{ lock };
    if (session != nullptr)
    {
        return 0;
    }
    if (config == nullptr || *config == '\0')
    {
        std::snprintf(err, static_cast<size_t>(len), "No settings folder.");
        return -1;
    }
    if (ca != nullptr && *ca != '\0')
    {
        setenv("CURL_CA_BUNDLE", ca, 1);
    }
    auto const dir = std::string{ config };
    auto const settings = tr_sessionLoadSettings(dir);
    session = tr_sessionInit(dir, false, settings);
    if (session == nullptr)
    {
        std::snprintf(err, static_cast<size_t>(len), "It didn't start.");
        return -1;
    }
    auto* ctor = tr_ctorNew(session);
    tr_sessionLoadTorrents(session, ctor);
    tr_ctorFree(ctor);
    return 0;
}

// (up to 15 s for the trackers to hear it's gone)
HT_EXPORT void ht_tr_stop(void)
{
    std::lock_guard<std::mutex> guard{ lock };
    if (session == nullptr)
    {
        return;
    }
    tr_sessionClose(session, 15);
    session = nullptr;
}

HT_EXPORT int ht_tr_running(void)
{
    std::lock_guard<std::mutex> guard{ lock };
    return session != nullptr ? 1 : 0;
}
