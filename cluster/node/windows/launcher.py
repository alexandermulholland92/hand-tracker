r"""
launcher.py - starts Cluster's service on this Windows PC and keeps it going, as systemd does on a Pi (the
user, 2026-11-22: "this PC joins as a member"). It runs the version current.txt names (versions/<commit>, or
versions/dev: a copy of the code) and starts it again a few seconds after it ends (its own update ends it, to
start the new one); one that keeps ending soon after it starts waits longer each time, up to 5 minutes. One
launcher at a time (launcher.lock); the service's output goes to service.log.

Its folder, %USERPROFILE%/Cluster (setup.py puts it there and starts it at sign-in, with pythonw: no
window), keeps everything: config.json (the Python the service runs with, the one for the animal model's tools,
ffmpeg, and the Pis' shared folders kept as drives), current.txt, versions/, state/ (the service's settings and
memory), jobs/, work/ and jobs-env/.

The Pis' shared folders as drives (config.json "drives": [{"letter": "P", "remote": a UNC path, \\<Pi>\home\<user>\
Downloads}]; the user, 2026-11-22: pi's folders on this PC, read and write, over NFS): connected at sign-in with
Windows' NFS client, and again every few minutes if one's missing (the Pi was away), waiting 3 s an answer and
trying once more (the user, 2026-11-24: 10 s and 3 tries froze PowerShell and Explorer whenever pi was slow).

  pythonw launcher.py            (setup.py's shortcut in the Startup folder)
"""

import json
import msvcrt
import os
import shutil
import subprocess
import sys
import threading
import time

INSTALL = os.path.dirname(os.path.abspath(__file__))
NO_WINDOW = 0x08000000
MAX_LOG = 5 << 20
QUICK_S = 60  # (one that ran less than this: the next start waits longer)
DRIVES_EVERY = 300  # (a shared folder's drive that's missing: connected again this often)


def config():
    try:
        with open(os.path.join(INSTALL, "config.json"), "r", encoding="utf-8") as f:
            c = json.load(f)
        return c if isinstance(c, dict) else {}
    except (OSError, ValueError):
        return {}


def current():
    """The service to run: versions/<what current.txt names>/ht_cluster.py, or None."""
    try:
        with open(os.path.join(INSTALL, "current.txt"), "r", encoding="utf-8") as f:
            name = f.read().strip()
    except OSError:
        return None
    script = os.path.join(INSTALL, "versions", name, "ht_cluster.py")
    return script if name and os.path.isfile(script) else None


def log_file():
    path = os.path.join(INSTALL, "service.log")
    try:
        if os.path.getsize(path) > MAX_LOG:
            os.replace(path, path + ".1")
    except OSError:
        pass
    return open(path, "ab")


def note(text):
    try:
        with log_file() as f:
            f.write(("%s launcher: %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), text)).encode("utf-8"))
    except OSError:
        pass


def refresh_self(script):
    """A newer launcher, come with the service's own update: in place for the launcher's next start."""
    new = os.path.join(os.path.dirname(script), "windows", "launcher.py")
    mine = os.path.abspath(__file__)
    try:
        with open(new, "rb") as a, open(mine, "rb") as b:
            if a.read() == b.read():
                return
        shutil.copyfile(new, mine + ".new")
        os.replace(mine + ".new", mine)
        note("A newer launcher is in place for its next start.")
    except OSError:
        pass


def keep_drives():
    """The Pis' shared folders as drives (config.json "drives"): any that's missing connected (NFS, anonymous: the
    Pi squashes every request to its own user), waiting 3 s an answer and trying once more (Windows: 0.8 s, once)."""
    while True:
        for d in config().get("drives") or []:
            letter, remote = str(d.get("letter") or "")[:1].upper(), str(d.get("remote") or "")
            if not letter.isalpha() or not remote.startswith("\\\\") or os.path.exists(letter + ":\\"):
                continue
            try:
                p = subprocess.run(["mount.exe", "-o", "anon", "-o", "timeout=3", "-o", "retry=1", remote, letter + ":"],
                                   capture_output=True, text=True, timeout=120, creationflags=NO_WINDOW)
                if p.returncode == 0:
                    note("Connected %s: to %s." % (letter, remote))
            except (OSError, subprocess.TimeoutExpired):
                pass
        time.sleep(DRIVES_EVERY)


def python_for_service(c):
    py = c.get("python") or sys.executable
    if os.path.basename(py).lower() == "pythonw.exe":  # (the service's output goes to its log: python.exe, no window)
        py = os.path.join(os.path.dirname(py), "python.exe")
    return py


def main():
    os.makedirs(INSTALL, exist_ok=True)
    lock = open(os.path.join(INSTALL, "launcher.lock"), "a+b")
    try:
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        return 0  # (another launcher keeps it going)
    threading.Thread(target=keep_drives, daemon=True).start()
    wait = 3
    while True:
        script = current()
        if not script:
            note("No version of the service to run (current.txt): looking again in a minute.")
            time.sleep(60)
            continue
        refresh_self(script)
        c = config()
        env = dict(os.environ, HT_CLUSTER_PLATFORM="windows", HT_CLUSTER_INSTALL=INSTALL,
                   HT_CLUSTER_STATE=os.path.join(INSTALL, "state"), PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
        if c.get("ffmpeg"):
            env["HT_CLUSTER_FFMPEG"] = str(c["ffmpeg"])
        if c.get("toolsPython"):
            env["HT_CLUSTER_TOOLS_PYTHON"] = str(c["toolsPython"])
        started = time.time()
        try:
            with log_file() as out:
                p = subprocess.Popen([python_for_service(c), script], cwd=os.path.dirname(script), env=env, stdout=out,
                                     stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
                code = p.wait()
        except OSError as e:
            code = "couldn't start: %s" % e
        ran = time.time() - started
        wait = 3 if ran > QUICK_S else min(300, wait * 2)
        note("The service ended (%s) after %d s; starting it again in %d s." % (code, ran, wait))
        time.sleep(wait)


if __name__ == "__main__":
    sys.exit(main())
