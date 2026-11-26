// ht_pieces.h — a phone's part of a big torrent, by pieces, with the Cluster app's own libtorrent (ht_pieces.cpp):
// the Android app's way in is pieces_jni.cpp, the iPhone's ClusterPieces.framework (these three, by dlsym).
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

// The pieces from first up to (not including) end of the torrent file at torrent, into folder (each file where the
// torrent puts it), seeding them while it runs; its state folder (status.json written every 2 s, control.json read:
// {"paused": true}, {"stop": true}; resume.dat its progress) names it. 0 when it's going (or was already), else its
// error in err.
int ht_pc_start(const char* torrent, const char* folder, int first, int end, const char* state, int port, char* err, int errsize);

// 1 while the part with that state folder runs.
int ht_pc_running(const char* state);

// That part ended (its progress kept), waiting up to 30 s for it.
void ht_pc_stop(const char* state);

#ifdef __cplusplus
}
#endif
