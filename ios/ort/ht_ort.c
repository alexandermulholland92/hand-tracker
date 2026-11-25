/*
 * ht_ort.c — ONNX Runtime for the Cluster app's own Python on an iPhone (the animal model's jobs there, this iPhone as a
 * member of the cluster: cluster/node/phonetools.py's onnxruntime(), by ctypes), built with ONNX Runtime's own iOS
 * library into ClusterORT.framework by scripts/build-ort-ios.sh. A model's session, what it takes and gives (with the
 * model's own notes: the kinds' names), and runs with float32 tensors (numpy's arrays, as they are): all a job needs.
 *   void *ht_ort_open(const char *path, int threads, char *err, int len)   a session (NULL: err says why)
 *   char *ht_ort_describe(void *session)                                   JSON: {"inputs": [{"name", "shape", "type"}],
 *                                                                          "outputs": [...], "meta": {...}} (ht_ort_free)
 *   void *ht_ort_run(void *session, int n, const char *const *names, const void *const *data,
 *                    const int64_t *const *shapes, const int *ndims, char *err, int len)
 *                                                                          its outputs, kept (NULL: err says why)
 *   const float *ht_ort_output(void *outputs, int i, int64_t *shape, int most, int *ndim)
 *                                                                          output i (ndim -1: not float32, or no such)
 *   void ht_ort_release(void *outputs), void ht_ort_free(char *text), void ht_ort_close(void *session)
 */
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "onnxruntime_c_api.h"

void *ht_ort_open(const char *path, int threads, char *err, int len);
char *ht_ort_describe(void *session);
void *ht_ort_run(void *session, int n, const char *const *names, const void *const *data, const int64_t *const *shapes,
                 const int *ndims, char *err, int len);
const float *ht_ort_output(void *outputs, int i, int64_t *shape, int most, int *ndim);
void ht_ort_release(void *outputs);
void ht_ort_free(char *text);
void ht_ort_close(void *session);

static const OrtApi *ort;
static OrtEnv *env;
static OrtMemoryInfo *cpu;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

typedef struct {
    OrtSession *session;
    size_t n_in, n_out;
    char **in_names, **out_names;
} Session;

typedef struct {
    size_t n;
    OrtValue **values;
} Outputs;

static void say(char *err, int len, const char *format, ...)
{
    va_list ap;
    if (!err || len <= 0)
        return;
    va_start(ap, format);
    vsnprintf(err, (size_t)len, format, ap);
    va_end(ap);
}

/* ONNX Runtime's error, its text into err: 1 if there was one. */
static int failed(OrtStatus *status, char *err, int len)
{
    if (!status)
        return 0;
    say(err, len, "%s", ort->GetErrorMessage(status));
    ort->ReleaseStatus(status);
    return 1;
}

static int quiet(OrtStatus *status)
{
    if (!status)
        return 0;
    ort->ReleaseStatus(status);
    return 1;
}

/* Once: ONNX Runtime's API, its environment, and where tensors are (this phone's memory). */
static int ready(char *err, int len)
{
    int ok = 1;
    pthread_mutex_lock(&lock);
    if (!env) {
        const OrtApiBase *base = OrtGetApiBase();
        ort = base ? base->GetApi(ORT_API_VERSION) : NULL;
        if (!ort) {
            say(err, len, "ONNX Runtime %s has no API version %d", base ? base->GetVersionString() : "?", ORT_API_VERSION);
            ok = 0;
        } else if (failed(ort->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "cluster", &env), err, len)) {
            env = NULL;
            ok = 0;
        } else if (failed(ort->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &cpu), err, len)) {
            ort->ReleaseEnv(env);
            env = NULL;
            ok = 0;
        }
    }
    pthread_mutex_unlock(&lock);
    return ok;
}

void ht_ort_close(void *session)
{
    Session *s = session;
    if (!s)
        return;
    if (s->session)
        ort->ReleaseSession(s->session);
    for (size_t i = 0; s->in_names && i < s->n_in; i++)
        free(s->in_names[i]);
    for (size_t i = 0; s->out_names && i < s->n_out; i++)
        free(s->out_names[i]);
    free(s->in_names);
    free(s->out_names);
    free(s);
}

/* Its inputs' or outputs' names, as the session gives them (copied: they're kept with it). */
static int names_of(Session *s, int outputs, OrtAllocator *alloc, char *err, int len)
{
    size_t n = outputs ? s->n_out : s->n_in;
    char **names = calloc(n ? n : 1, sizeof(char *));
    if (!names) {
        say(err, len, "out of memory");
        return 0;
    }
    if (outputs)
        s->out_names = names;
    else
        s->in_names = names;
    for (size_t i = 0; i < n; i++) {
        char *name = NULL;
        OrtStatus *st = outputs ? ort->SessionGetOutputName(s->session, i, alloc, &name)
                                : ort->SessionGetInputName(s->session, i, alloc, &name);
        if (failed(st, err, len))
            return 0;
        names[i] = strdup(name ? name : "");
        quiet(ort->AllocatorFree(alloc, name));
        if (!names[i]) {
            say(err, len, "out of memory");
            return 0;
        }
    }
    return 1;
}

void *ht_ort_open(const char *path, int threads, char *err, int len)
{
    OrtSessionOptions *opts = NULL;
    OrtAllocator *alloc = NULL;
    Session *s = NULL;
    say(err, len, "%s", "");
    if (!ready(err, len))
        return NULL;
    if (failed(ort->CreateSessionOptions(&opts), err, len))
        return NULL;
    if ((threads > 0 && failed(ort->SetIntraOpNumThreads(opts, threads), err, len)) ||
        failed(ort->SetInterOpNumThreads(opts, 1), err, len))
        goto fail;
    s = calloc(1, sizeof(Session));
    if (!s) {
        say(err, len, "out of memory");
        goto fail;
    }
    if (failed(ort->CreateSession(env, path, opts, &s->session), err, len))
        goto fail;
    ort->ReleaseSessionOptions(opts);
    opts = NULL;
    if (failed(ort->GetAllocatorWithDefaultOptions(&alloc), err, len) ||
        failed(ort->SessionGetInputCount(s->session, &s->n_in), err, len) ||
        failed(ort->SessionGetOutputCount(s->session, &s->n_out), err, len) ||
        !names_of(s, 0, alloc, err, len) || !names_of(s, 1, alloc, err, len))
        goto fail;
    return s;
fail:
    if (opts)
        ort->ReleaseSessionOptions(opts);
    ht_ort_close(s);
    return NULL;
}

/* ---------- JSON, for ht_ort_describe ---------- */
typedef struct {
    char *s;
    size_t n, cap;
    int bad;
} Text;

static void put(Text *t, const char *s, size_t n)
{
    if (t->bad)
        return;
    if (t->n + n + 1 > t->cap) {
        size_t cap = t->cap ? t->cap : 1024;
        while (cap < t->n + n + 1)
            cap *= 2;
        char *p = realloc(t->s, cap);
        if (!p) {
            t->bad = 1;
            return;
        }
        t->s = p;
        t->cap = cap;
    }
    memcpy(t->s + t->n, s, n);
    t->n += n;
    t->s[t->n] = 0;
}

static void text(Text *t, const char *s)
{
    put(t, s, strlen(s));
}

static void string(Text *t, const char *s)
{
    char u[8];
    put(t, "\"", 1);
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        if (*p == '"' || *p == '\\') {
            char e[2] = {'\\', (char)*p};
            put(t, e, 2);
        } else if (*p < 0x20) {
            snprintf(u, sizeof u, "\\u%04x", *p);
            put(t, u, 6);
        } else {
            put(t, (const char *)p, 1);
        }
    }
    put(t, "\"", 1);
}

static void shape(Text *t, const OrtTensorTypeAndShapeInfo *info)
{
    int64_t dims[16];
    size_t n = 0;
    char num[32];
    text(t, "[");
    if (info && !quiet(ort->GetDimensionsCount(info, &n)) && n <= 16 && !quiet(ort->GetDimensions(info, dims, n))) {
        for (size_t i = 0; i < n; i++) {
            snprintf(num, sizeof num, "%s%lld", i ? "," : "", (long long)dims[i]);
            text(t, num);
        }
    }
    text(t, "]");
}

static void args(Text *t, Session *s, int outputs)
{
    size_t n = outputs ? s->n_out : s->n_in;
    char num[32];
    text(t, "[");
    for (size_t i = 0; i < n; i++) {
        OrtTypeInfo *ti = NULL;
        const OrtTensorTypeAndShapeInfo *info = NULL;
        ONNXTensorElementDataType type = ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED;
        OrtStatus *st = outputs ? ort->SessionGetOutputTypeInfo(s->session, i, &ti)
                                : ort->SessionGetInputTypeInfo(s->session, i, &ti);
        if (!quiet(st) && ti && !quiet(ort->CastTypeInfoToTensorInfo(ti, &info)) && info)
            quiet(ort->GetTensorElementType(info, &type));
        text(t, i ? ",{\"name\":" : "{\"name\":");
        string(t, outputs ? s->out_names[i] : s->in_names[i]);
        text(t, ",\"shape\":");
        shape(t, info);
        snprintf(num, sizeof num, ",\"type\":%d}", (int)type);
        text(t, num);
        if (ti)
            ort->ReleaseTypeInfo(ti);
    }
    text(t, "]");
}

static void meta(Text *t, Session *s)
{
    OrtModelMetadata *m = NULL;
    OrtAllocator *alloc = NULL;
    char **keys = NULL;
    int64_t n = 0;
    int first = 1;
    text(t, "{");
    if (!quiet(ort->GetAllocatorWithDefaultOptions(&alloc)) && !quiet(ort->SessionGetModelMetadata(s->session, &m)) &&
        !quiet(ort->ModelMetadataGetCustomMetadataMapKeys(m, alloc, &keys, &n)) && keys) {
        for (int64_t i = 0; i < n; i++) {
            char *value = NULL;
            if (!quiet(ort->ModelMetadataLookupCustomMetadataMap(m, alloc, keys[i], &value)) && value) {
                text(t, first ? "" : ",");
                first = 0;
                string(t, keys[i]);
                text(t, ":");
                string(t, value);
                quiet(ort->AllocatorFree(alloc, value));
            }
            quiet(ort->AllocatorFree(alloc, keys[i]));
        }
        quiet(ort->AllocatorFree(alloc, keys));
    }
    if (m)
        ort->ReleaseModelMetadata(m);
    text(t, "}");
}

char *ht_ort_describe(void *session)
{
    Session *s = session;
    Text t = {0};
    if (!s)
        return NULL;
    text(&t, "{\"inputs\":");
    args(&t, s, 0);
    text(&t, ",\"outputs\":");
    args(&t, s, 1);
    text(&t, ",\"meta\":");
    meta(&t, s);
    text(&t, "}");
    if (t.bad) {
        free(t.s);
        return NULL;
    }
    return t.s;
}

void ht_ort_free(char *text)
{
    free(text);
}

/* ---------- runs ---------- */
void ht_ort_release(void *outputs)
{
    Outputs *o = outputs;
    if (!o)
        return;
    for (size_t i = 0; o->values && i < o->n; i++)
        if (o->values[i])
            ort->ReleaseValue(o->values[i]);
    free(o->values);
    free(o);
}

void *ht_ort_run(void *session, int n, const char *const *names, const void *const *data, const int64_t *const *shapes,
                 const int *ndims, char *err, int len)
{
    Session *s = session;
    OrtValue **inputs = NULL;
    Outputs *o = NULL;
    say(err, len, "%s", "");
    if (!s || n < 0) {
        say(err, len, "no session");
        return NULL;
    }
    inputs = calloc(n ? (size_t)n : 1, sizeof(OrtValue *));
    o = calloc(1, sizeof(Outputs));
    if (o) {
        o->n = s->n_out;
        o->values = calloc(s->n_out ? s->n_out : 1, sizeof(OrtValue *));
    }
    if (!inputs || !o || !o->values) {
        say(err, len, "out of memory");
        goto fail;
    }
    for (int i = 0; i < n; i++) {
        size_t count = 1;
        for (int d = 0; d < ndims[i]; d++)
            count *= shapes[i][d] > 0 ? (size_t)shapes[i][d] : 0;
        if (failed(ort->CreateTensorWithDataAsOrtValue(cpu, (void *)data[i], count * sizeof(float), shapes[i], (size_t)ndims[i],
                                                       ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &inputs[i]), err, len))
            goto fail;
    }
    if (failed(ort->Run(s->session, NULL, names, (const OrtValue *const *)inputs, (size_t)n, (const char *const *)s->out_names,
                        s->n_out, o->values), err, len))
        goto fail;
    for (int i = 0; i < n; i++)
        ort->ReleaseValue(inputs[i]);
    free(inputs);
    return o;
fail:
    for (int i = 0; inputs && i < n; i++)
        if (inputs[i])
            ort->ReleaseValue(inputs[i]);
    free(inputs);
    ht_ort_release(o);
    return NULL;
}

const float *ht_ort_output(void *outputs, int i, int64_t *shape, int most, int *ndim)
{
    Outputs *o = outputs;
    OrtTensorTypeAndShapeInfo *info = NULL;
    ONNXTensorElementDataType type = ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED;
    size_t n = 0;
    void *p = NULL;
    *ndim = -1;
    if (!o || i < 0 || (size_t)i >= o->n || !o->values[i] || quiet(ort->GetTensorTypeAndShape(o->values[i], &info)))
        return NULL;
    if (!quiet(ort->GetTensorElementType(info, &type)) && type == ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT &&
        !quiet(ort->GetDimensionsCount(info, &n)) && n <= (size_t)(most > 0 ? most : 0) &&
        !quiet(ort->GetDimensions(info, shape, n)) && !quiet(ort->GetTensorMutableData(o->values[i], &p)))
        *ndim = (int)n;
    ort->ReleaseTensorTypeAndShapeInfo(info);
    return *ndim >= 0 ? (const float *)p : NULL;
}
