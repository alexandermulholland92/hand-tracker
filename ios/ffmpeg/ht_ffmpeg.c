/*
 * ht_ffmpeg.c — FFmpeg's ffmpeg tool as a function the Cluster app on an iPhone calls again and again (a job's
 * conversions there, this iPhone as a member of the cluster: ClusterMember.swift), built with FFmpeg 8.0 and x264 into
 * ClusterFFmpeg.framework by scripts/build-ffmpeg-ios.sh.
 *
 * The tool keeps its state in globals, written for a process that runs it once. So each run here starts as in a
 * process of its own: this library's writable data (the tool's globals and the FFmpeg libraries') is put back as it
 * was when the library was loaded. Its own state below is in a section of its own, which isn't. One run at a time.
 *   int ht_ffmpeg_init(void)                                   once, after it's loaded: that data kept (-1: it couldn't)
 *   int ht_ffmpeg_run(int argc, char **argv, const char *log)  a run (argv[0]: "ffmpeg"), what it says into that
 *                                                              file -> its exit code
 *   void ht_ffmpeg_cancel(void)                                the run going on asked to stop (as a signal would)
 */
#include <dlfcn.h>
#include <mach-o/getsect.h>
#include <mach-o/loader.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "libavutil/log.h"

int main(int argc, char **argv);   /* fftools/ffmpeg.c's: here a function like any other */
void ht_ffmpeg_tool_stop(void);    /* added to fftools/ffmpeg.c by the build */

#define KEEP __attribute__((section("__DATA,__htkeep")))

struct kept {
    uint8_t *at;
    uint8_t *copy;
    unsigned long size;
};
static struct kept kept[6] KEEP = {{0}};
static int n_kept KEEP = 0;
static int ready KEEP = 0;
static FILE *log_out KEEP = NULL;
static int print_prefix KEEP = 1;
static pthread_mutex_t log_lock KEEP = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t run_lock KEEP = PTHREAD_MUTEX_INITIALIZER;
static volatile int running KEEP = 0;
static volatile int stopping KEEP = 0;
/* (the app's own signal handlers, which the tool replaces with its own while it runs: given back after) */
static const int SIGNALS[] = {SIGINT, SIGTERM, SIGQUIT, SIGXCPU, SIGPIPE};
static struct sigaction before[5] KEEP;

int ht_ffmpeg_init(void)
{
    static const char *const names[][2] = {
        {"__DATA", "__data"},       {"__DATA", "__bss"},       {"__DATA", "__common"},
        {"__DATA_DIRTY", "__data"}, {"__DATA_DIRTY", "__bss"}, {"__DATA_DIRTY", "__common"},
    };
    Dl_info info;
    if (ready)
        return n_kept;
    if (!dladdr((const void *)ht_ffmpeg_init, &info) || !info.dli_fbase)
        return -1;
    const struct mach_header_64 *mh = (const struct mach_header_64 *)info.dli_fbase;
    for (int i = 0; i < 6; i++) {
        unsigned long size = 0;
        uint8_t *at = getsectiondata(mh, names[i][0], names[i][1], &size);
        if (!at || !size)
            continue;
        uint8_t *copy = malloc(size);
        if (!copy)
            return -1;
        memcpy(copy, at, size);
        kept[n_kept].at = at;
        kept[n_kept].copy = copy;
        kept[n_kept].size = size;
        n_kept++;
    }
    ready = 1;
    return n_kept;
}

static void log_line(void *avcl, int level, const char *fmt, va_list vl)
{
    char line[4096];
    if (level > av_log_get_level())
        return;
    pthread_mutex_lock(&log_lock);
    av_log_format_line2(avcl, level, fmt, vl, line, sizeof(line), &print_prefix);
    if (log_out) {
        fputs(line, log_out);
        fflush(log_out);
    }
    pthread_mutex_unlock(&log_lock);
}

int ht_ffmpeg_run(int argc, char **argv, const char *log_path)
{
    int code;
    pthread_mutex_lock(&run_lock);
    if (!ready && ht_ffmpeg_init() < 0) {
        pthread_mutex_unlock(&run_lock);
        return -1;
    }
    for (int i = 0; i < n_kept; i++)
        memcpy(kept[i].at, kept[i].copy, kept[i].size);
    for (int i = 0; i < 5; i++)
        sigaction(SIGNALS[i], NULL, &before[i]);
    pthread_mutex_lock(&log_lock);
    log_out = log_path && *log_path ? fopen(log_path, "a") : NULL;
    print_prefix = 1;
    pthread_mutex_unlock(&log_lock);
    av_log_set_callback(log_line);
    stopping = 0;
    running = 1;
    code = main(argc, argv);
    running = 0;
    av_log_set_callback(av_log_default_callback);
    for (int i = 0; i < 5; i++)
        sigaction(SIGNALS[i], &before[i], NULL);
    pthread_mutex_lock(&log_lock);
    if (log_out)
        fclose(log_out);
    log_out = NULL;
    pthread_mutex_unlock(&log_lock);
    pthread_mutex_unlock(&run_lock);
    return code;
}

void ht_ffmpeg_cancel(void)
{
    if (running && !stopping) {
        stopping = 1;
        ht_ffmpeg_tool_stop();
    }
}
