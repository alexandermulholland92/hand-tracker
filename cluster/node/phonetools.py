"""
phonetools.py - a job's programs on a phone (the Cluster app: the user, 2026-11-23, phones take conversions, the animal
model's jobs and the rest; jobs.py's launch() and node.run() use this there). A phone can't start the programs a Pi
does, so:
  ffmpeg, ffprobe   the app's own (FFmpegKit, in the app: phonesys.call "ffmpeg-start" / "ffmpeg-poll" / "ffmpeg-run"):
                    its log as the program's output; its progress as -progress pipe:1 says it (out_time_us=), which an
                    app can't be given on its stdout
  a Python script   run in this Python, in a thread of its own (a phone can't start another Python): its prints as its
                    output, sys.exit's code as its own; stopped by raising SystemExit in it
  a shell command   Android's own sh (/system/bin/sh: no bash there); none on an iPhone
Each as subprocess.Popen is used by jobs.py: poll(), wait(), stdout (its lines), terminate(), kill(), returncode, pid.
And onnxruntime() -> a module for the animal model's script (jobs_animals.py), as onnxruntime's own: its
InferenceSession runs the model with the app's ONNX Runtime (Android: its Java API, through Chaquopy).
"""

import ctypes
import itertools
import json
import os
import queue
import runpy
import subprocess
import sys
import threading
import time
import traceback
import types

FFMPEG, FFPROBE, PYTHON = "ffmpeg", "ffprobe", "python3"
PLATFORM = os.environ.get("HT_CLUSTER_PLATFORM") or ""
POLL_S = 0.5
_ids = itertools.count(1)


def _phonesys():
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    import phonesys

    return phonesys


def tool_of(cmd):
    return os.path.basename(str(cmd[0])).lower() if isinstance(cmd, (list, tuple)) and cmd else ""


def _plain(args):
    """ffmpeg's options as the app runs them: its progress comes another way (-progress pipe:1, -nostats left out)."""
    out, i = [], 0
    while i < len(args):
        if args[i] == "-progress" and i + 1 < len(args):
            i += 2
            continue
        if args[i] != "-nostats":
            out.append(str(args[i]))
        i += 1
    return out


def run(cmd, timeout=20):
    """node.run's for ffmpeg and ffprobe on a phone: (exit code, output, errors)."""
    tool = tool_of(cmd)
    a = _phonesys().call("ffmpeg-run", {"args": _plain(cmd[1:]), "probe": tool == FFPROBE, "timeout": timeout})
    if a.get("ok") is False:
        return None, "", str(a.get("error") or "the app's ffmpeg didn't answer")
    if tool == FFPROBE:
        return a.get("code"), a.get("output") or "", a.get("log") or ""
    return a.get("code"), "", a.get("log") or ""


class _Proc:
    """What jobs.py uses of a program it started."""

    def __init__(self):
        self.pid = -next(_ids)  # (not a real program's: never signalled)
        self.returncode = None
        self.lines = queue.Queue()
        self.done = threading.Event()
        self.stdout = self._read()

    def _read(self):
        while True:
            line = self.lines.get()
            if line is None:
                return
            yield line

    def _say(self, text):
        for line in str(text).splitlines():
            self.lines.put(line + "\n")

    def _end(self, code):
        if self.returncode is None:
            self.returncode = code
        self.lines.put(None)
        self.done.set()

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        if not self.done.wait(timeout):
            raise subprocess.TimeoutExpired("job", timeout)
        return self.returncode

    def kill(self):
        self.terminate()


class FfmpegProc(_Proc):
    """ffmpeg (or ffprobe) run by the app, its output and progress asked for every POLL_S."""

    def __init__(self, args, probe=False):
        super().__init__()
        a = _phonesys().call("ffmpeg-start", {"args": _plain(args), "probe": probe})
        if a.get("ok") is False or a.get("id") is None:
            raise OSError(a.get("error") or "the app's ffmpeg didn't start")
        self.id = a["id"]
        threading.Thread(target=self._watch, daemon=True, name="ffmpeg-%s" % self.id).start()

    def _watch(self):
        last = -1
        while True:
            a = _phonesys().call("ffmpeg-poll", {"id": self.id})
            if a.get("ok") is False:
                self._say("ffmpeg: %s" % a.get("error"))
                return self._end(1)
            if a.get("log"):
                self._say(a["log"])
            t = a.get("time")
            if isinstance(t, (int, float)) and t > last:
                last = t
                self.lines.put("out_time_us=%d\n" % int(t * 1000))
            if a.get("done"):
                code = a.get("code")
                return self._end(int(code) if isinstance(code, int) else 1)
            time.sleep(POLL_S)

    def terminate(self):
        if self.returncode is None:
            _phonesys().call("ffmpeg-cancel", {"id": self.id})


# ----- a Python script, in this Python -----
class _Router:
    """sys.stdout / sys.stderr while scripts run here: each script's thread writes to its own output, the rest as before."""

    def __init__(self, before):
        self.before = before
        self.routes = {}

    def write(self, text):
        to = self.routes.get(threading.get_ident())
        if to is not None:
            to(text)
            return len(text)
        return self.before.write(text)

    def flush(self):
        try:
            self.before.flush()
        except Exception:
            pass

    def __getattr__(self, name):
        return getattr(self.before, name)


_routers = {}
_script_lock = threading.Lock()  # (one script at a time: its argv, environment and folder are this Python's own)


def _route(name):
    r = getattr(sys, name)
    if not isinstance(r, _Router):
        r = _Router(r)
        setattr(sys, name, r)
    return r


class PythonProc(_Proc):
    def __init__(self, argv, cwd=None, env=None):
        super().__init__()
        self.argv = [str(a) for a in argv]
        self.cwd, self.env = cwd, dict(env or {})
        self.partial = ""
        self.thread = threading.Thread(target=self._run, daemon=True, name="script")
        self.thread.start()

    def _write(self, text):
        self.partial += text
        while "\n" in self.partial:
            line, self.partial = self.partial.split("\n", 1)
            self.lines.put(line + "\n")

    def _run(self):
        with _script_lock:
            me = threading.get_ident()
            out, err = _route("stdout"), _route("stderr")
            out.routes[me] = err.routes[me] = self._write
            saved_argv, saved_env, saved_cwd = sys.argv, dict(os.environ), os.getcwd()
            code = 0
            try:
                sys.argv = list(self.argv)
                os.environ.update({str(k): str(v) for k, v in self.env.items()})
                os.environ["HT_CLUSTER_JOB"] = "1"
                if self.cwd:
                    os.chdir(self.cwd)
                runpy.run_path(self.argv[0], run_name="__main__")
            except SystemExit as e:
                code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
                if e.code is not None and not isinstance(e.code, int):
                    self._write(str(e.code) + "\n")
            except BaseException:
                self._write(traceback.format_exc())
                code = 1
            finally:
                if self.partial:
                    self.lines.put(self.partial + "\n")
                    self.partial = ""
                out.routes.pop(me, None)
                err.routes.pop(me, None)
                sys.argv = saved_argv
                os.environ.clear()
                os.environ.update(saved_env)
                try:
                    os.chdir(saved_cwd)
                except OSError:
                    pass
                self._end(code)

    def terminate(self):
        if self.returncode is None and self.thread.ident:
            ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(self.thread.ident), ctypes.py_object(SystemExit))


def popen(cmd, cwd=None, env=None, stdin_text=None):
    """jobs.py's launch() on a phone: one of the programs above, or OSError when it's something a phone can't run."""
    if isinstance(cmd, str):
        cmd = ["sh", "-c", cmd]
    tool = tool_of(cmd)
    if tool in (FFMPEG, FFPROBE):
        return FfmpegProc(cmd[1:], probe=tool == FFPROBE)
    if tool in ("python3", "python") or str(cmd[0]) == sys.executable:
        return PythonProc(cmd[1:], cwd, env)
    first = b""
    if os.path.isfile(str(cmd[0])):
        with open(cmd[0], "rb") as f:
            first = f.readline()
        if first.startswith(b"#!") and b"python" in first:
            return PythonProc(list(cmd), cwd, env)
    if tool in ("sh", "bash") or first.startswith(b"#!"):
        if PLATFORM != "android":
            raise OSError("An iPhone can't run commands: only Python scripts.")
        sh = os.environ.get("HT_CLUSTER_PHONE_SH") or "/system/bin/sh"  # (the checks' phone: this computer's sh)
        argv = [sh] + list(cmd[1:]) if tool in ("sh", "bash") else [sh] + list(cmd)
        p = subprocess.Popen(argv, cwd=cwd, env=dict(os.environ, **(env or {})), stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        if stdin_text is not None:
            try:
                p.stdin.write(stdin_text)
                p.stdin.close()
            except OSError:
                pass
        return p
    raise OSError("A phone can't run %s." % tool)


# ----- the animal model: onnxruntime, as its own module, with the app's ONNX Runtime -----
def onnxruntime():
    """A module for jobs_animals.py in place of onnxruntime (Android: the app's ONNX Runtime, its Java API)."""
    m = types.ModuleType("onnxruntime")

    class SessionOptions:
        def __init__(self):
            self.intra_op_num_threads = 0
            self.inter_op_num_threads = 0

    class _Arg:
        def __init__(self, name, shape):
            self.name, self.shape = name, shape

    class _Meta:
        def __init__(self, custom):
            self.custom_metadata_map = custom

    class InferenceSession:
        def __init__(self, path, sess_options=None, providers=None):
            from java import jclass  # (Chaquopy's: the Android app)

            self.jclass = jclass
            self.env = jclass("ai.onnxruntime.OrtEnvironment").getEnvironment()
            opts = jclass("ai.onnxruntime.OrtSession$SessionOptions")()
            threads = int(getattr(sess_options, "intra_op_num_threads", 0) or 0)
            if threads > 0:
                opts.setIntraOpNumThreads(threads)
            self.session = self.env.createSession(str(path), opts)
            info = self.session.getInputInfo()
            self.inputs = [_Arg(str(k), list(info.get(k).getInfo().getShape())) for k in info.keySet().toArray()]
            meta = self.session.getMetadata().getCustomMetadata()
            self.meta = {str(k): str(meta.get(k)) for k in meta.keySet().toArray()}

        def get_inputs(self):
            return self.inputs

        def get_modelmeta(self):
            return _Meta(self.meta)

        def run(self, output_names, feeds):
            import numpy as np
            from java import jarray, jfloat, jlong

            HashMap = self.jclass("java.util.HashMap")
            FloatBuffer = self.jclass("java.nio.FloatBuffer")
            OnnxTensor = self.jclass("ai.onnxruntime.OnnxTensor")
            tensors, inputs = [], HashMap()
            for name, x in feeds.items():
                x = np.ascontiguousarray(x, dtype=np.float32)
                t = OnnxTensor.createTensor(self.env, FloatBuffer.wrap(jarray(jfloat)(x.ravel())), jarray(jlong)(list(x.shape)))
                tensors.append(t)
                inputs.put(name, t)
            result = self.session.run(inputs)
            try:
                outs = []
                for i in range(result.size()):
                    v = result.get(i)
                    shape = [int(n) for n in v.getInfo().getShape()]
                    buf = v.getFloatBuffer()
                    arr = jarray(jfloat)(buf.remaining())
                    buf.get(arr)
                    outs.append(np.array(arr, dtype=np.float32).reshape(shape))
                return outs
            finally:
                result.close()
                for t in tensors:
                    t.close()

    m.SessionOptions = SessionOptions
    m.InferenceSession = InferenceSession
    return m
