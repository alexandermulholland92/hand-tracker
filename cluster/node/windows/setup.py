"""
setup.py - puts Cluster's service on this Windows PC, so that it's a member of the cluster (the user,
2026-11-22: "this PC joins as a member"): in %LOCALAPPDATA%/Cluster, the service for GitHub's latest build
(each file checked against GitHub's list, as a Pi's own update does, by ht-cluster-root's Windows part), its
launcher started now and at each sign-in (a shortcut in the Startup folder: no administrator needed), and
config.json: the Python the service runs with, the one the animal model's tools are made with, and ffmpeg.
A PC set up before the rename (2026-11-25: "Pi Cluster" became "Cluster") has its folder, %LOCALAPPDATA%/Pi Cluster,
moved to the new name with everything in it (Cluster-Linux's disk moved by WSL itself), and its Startup shortcut
named again, the next time this runs.

  python setup.py [--python PY] [--tools-python PY] [--ffmpeg FFMPEG] [--drive P=\\\\pi\\home\\alex\\Downloads]... [--from-repo]
  python setup.py --linux         (the Linux Transmission runs in here: see below)
  python setup.py --remove        (stops it and takes its shortcut away; its folder and settings stay)

--from-repo: this copy of the code (versions/dev, not updated by itself), to try it before it's on GitHub.
--drive: a Pi's shared folder kept connected as a drive letter by the launcher (Windows' Client for NFS, which
you turn on in Windows Features). Settings already in config.json are kept unless given again.
--linux: Transmission runs on this PC in a Linux of its own under WSL, "Cluster-Linux" (WSL itself first: as
administrator, wsl --install --no-distribution). This downloads Debian 13 (the Pis' release; about 30 MB, Docker's
official image, its SHA-256 checked against its manifest), sets it up in %LOCALAPPDATA%/Cluster/linux, and
installs the Pis' own transmission-daemon and the NFS client in it from Debian (about 20 MB).
The service answers the other Pis on port 47830 of every network: the Python it runs with needs Windows
Firewall's leave for that (on a private network, as Tailscale's is), or Windows asks the first time.
"""

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

NODE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # (cluster/node: this copy of the service)
REPO = os.path.dirname(os.path.dirname(NODE))
INSTALL = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "Cluster")
OLD_INSTALL = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "Pi Cluster")  # (before the rename)
STARTUP = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
SHORTCUT = os.path.join(STARTUP, "Cluster.lnk")
OLD_SHORTCUT = os.path.join(STARTUP, "Pi Cluster.lnk")
NO_WINDOW = 0x08000000
DETACHED = 0x00000008 | 0x00000200  # (DETACHED_PROCESS, CREATE_NEW_PROCESS_GROUP: it outlives this setup)
PAGE = ("cluster.html", "cluster.js", "video-formats.js", "sentry-models.js", "models/kinds.js", "favicon.png", "apple-touch-icon.png")
WSL_DISTRO = "Cluster-Linux"  # (modules/apps.py's)
DEBIAN = "https://raw.githubusercontent.com/debuerreotype/docker-debian-artifacts/dist-amd64/trixie/slim/oci/blobs/"


def wsl_exe():
    return os.path.join(os.environ.get("SystemRoot") or r"C:\Windows", "System32", "wsl.exe")


def in_linux(script, timeout=1800):
    """A shell script run in Cluster-Linux as root: (exit code, what it said)."""
    p = subprocess.run([wsl_exe(), "-d", WSL_DISTRO, "-u", "root", "--exec", "/bin/sh", "-c", script], capture_output=True, text=True,
                       timeout=timeout, creationflags=NO_WINDOW, env=dict(os.environ, WSL_UTF8="1"))
    return p.returncode, ((p.stdout or "") + (p.stderr or "")).replace("\x00", "").strip()


def fetch(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": "cluster-setup"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def setup_linux():
    """Cluster-Linux: Debian 13 under WSL, with the Pis' transmission-daemon and the NFS client."""
    sys.path.insert(0, NODE)
    import winsys
    if not os.path.exists(wsl_exe()):
        raise SystemExit("WSL isn't on this PC: as administrator, run  wsl --install --no-distribution  then restart, and try again.")
    if WSL_DISTRO not in winsys.wsl_distros():
        import hashlib
        import tempfile
        manifest = json.loads(fetch(DEBIAN + "image-manifest.json").decode("utf-8"))
        layer = manifest["layers"][0]
        want, size = layer["digest"].split(":", 1)[1], int(layer["size"])
        print("Downloading Debian 13's root filesystem (%.0f MB)..." % (size / 1e6), flush=True)
        data = fetch(DEBIAN + "rootfs.tar.gz", timeout=900)
        if len(data) != size or hashlib.sha256(data).hexdigest() != want:
            raise SystemExit("Debian's root filesystem didn't match its manifest (SHA-256 %s expected): not used." % want)
        tmp = tempfile.mkdtemp(prefix="cluster-linux-")
        tar = os.path.join(tmp, "rootfs.tar.gz")
        with open(tar, "wb") as f:
            f.write(data)
        os.makedirs(os.path.join(INSTALL, "linux"), exist_ok=True)
        p = subprocess.run([wsl_exe(), "--import", WSL_DISTRO, os.path.join(INSTALL, "linux"), tar, "--version", "2"], capture_output=True,
                           text=True, timeout=600, creationflags=NO_WINDOW, env=dict(os.environ, WSL_UTF8="1"))
        shutil.rmtree(tmp, ignore_errors=True)
        if p.returncode != 0:
            raise SystemExit("WSL didn't take it: %s" % ((p.stdout or "") + (p.stderr or "")).replace("\x00", "").strip()[-300:])
        print("Set up as WSL's %s, in %s." % (WSL_DISTRO, os.path.join(INSTALL, "linux")), flush=True)
    print("Installing Transmission and the NFS client in it...", flush=True)
    code, out = in_linux("export DEBIAN_FRONTEND=noninteractive; apt-get update -q >/tmp/apt.log 2>&1 && "
                         "apt-get install -y -q --no-install-recommends transmission-daemon nfs-common >>/tmp/apt.log 2>&1 || "
                         "{ tail -3 /tmp/apt.log; exit 1; }; /usr/bin/transmission-daemon --version 2>&1 | head -1")
    if code != 0:
        raise SystemExit("They didn't install: %s" % out[-300:])
    print("%s: %s, ready for the cluster's Transmission." % (WSL_DISTRO, out.splitlines()[-1] if out else "?"))
    return 0


def ps(script, timeout=60):
    p = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], capture_output=True, text=True,
                       timeout=timeout, creationflags=NO_WINDOW)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def windowless(py):
    """The same Python's pythonw.exe (no window), if it has one."""
    w = os.path.join(os.path.dirname(py), "pythonw.exe")
    return w if os.path.exists(w) else py


def find_ffmpeg():
    found = shutil.which("ffmpeg")
    if found:
        return found
    builds = sorted(glob.glob(os.path.join(os.path.expanduser("~"), "Documents", "ffmpeg-*", "bin", "ffmpeg.exe")), key=os.path.getmtime)
    if builds:
        return builds[-1]
    static = os.path.join(REPO, "node_modules", "ffmpeg-static", "ffmpeg.exe")
    return static if os.path.exists(static) else None


def install_latest():
    """The service for GitHub's latest build, by ht-cluster-root's Windows part (versions/<commit>, current.txt)."""
    env = dict(os.environ, HT_CLUSTER_WINDOWS="1", HT_CLUSTER_INSTALL=INSTALL)
    p = subprocess.run([sys.executable, os.path.join(NODE, "ht-cluster-root"), "update-cluster"], capture_output=True, text=True,
                       env=env, timeout=900, creationflags=NO_WINDOW)
    lines = [l for l in (p.stdout or "").splitlines() if l.strip().startswith("{")]
    answer = json.loads(lines[-1]) if lines else {"ok": False, "error": (p.stderr or p.stdout or "no answer").strip()[-300:]}
    if not answer.get("ok"):
        raise SystemExit("The service didn't download: %s" % answer.get("error"))
    return answer["commit"]


def install_repo():
    """This copy of the code, as versions/dev (with the page's files from the repository)."""
    dest = os.path.join(INSTALL, "versions", "dev")
    shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(NODE, dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for p in PAGE:
        target = os.path.join(dest, "web", *p.split("/"))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(os.path.join(REPO, *p.split("/")), target)
    with open(os.path.join(INSTALL, "current.txt"), "w", encoding="utf-8") as f:
        f.write("dev\n")
    return "dev"


def stop():
    """The launcher and the service it runs (their command lines name its folder, by its name now or the one from
    before the rename), if they're running."""
    match = " -or ".join("$_.CommandLine -like '*\\%s\\launcher.py*' -or $_.CommandLine -like '*\\%s\\versions\\*ht_cluster.py*'" % (n, n)
                         for n in ("Cluster", "Pi Cluster"))
    ps("Get-CimInstance Win32_Process | Where-Object { %s } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force "
       "-ErrorAction SilentlyContinue }" % match)


def wsl(*args, timeout=600):
    p = subprocess.run([wsl_exe(), *args], capture_output=True, text=True, timeout=timeout, creationflags=NO_WINDOW,
                       env=dict(os.environ, WSL_UTF8="1"))
    return p.returncode, ((p.stdout or "") + (p.stderr or "")).replace("\x00", "").strip()


def move_into(src, dst):
    """Everything in folder src moved into folder dst (made if need be), then src removed: what dst has already of
    the same name stops it, before anything's moved."""
    both_dirs = lambda n: os.path.isdir(os.path.join(src, n)) and os.path.isdir(os.path.join(dst, n))
    clash = [n for n in os.listdir(src) if os.path.exists(os.path.join(dst, n)) and not both_dirs(n)] if os.path.isdir(dst) else []
    if clash:
        raise SystemExit("Both %s and %s have %s: keep one of each, then run this again." % (src, dst, ", ".join(sorted(clash))))
    os.makedirs(dst, exist_ok=True)
    for name in os.listdir(src):
        s, d = os.path.join(src, name), os.path.join(dst, name)
        if os.path.isdir(s) and os.path.isdir(d):
            move_into(s, d)
        else:
            os.replace(s, d)
    os.rmdir(src)


def move_old_folder():
    """The folder from before the rename (%LOCALAPPDATA%/Pi Cluster) moved to the new name, everything in it: first
    Cluster-Linux's disk, by WSL itself (which then knows where it is; nothing's moved if it can't), then the rest.
    Its service is stopped first (main). Run again after a move that stopped part way, it goes on from there."""
    if not os.path.isdir(OLD_INSTALL):
        return
    disk = os.path.join(OLD_INSTALL, "linux", "ext4.vhdx")
    if os.path.isfile(disk) and os.path.exists(wsl_exe()):
        sys.path.insert(0, NODE)
        import winsys
        if WSL_DISTRO in winsys.wsl_distros():
            if os.path.exists(os.path.join(INSTALL, "linux", "ext4.vhdx")):
                raise SystemExit("Both %s and %s have a Linux disk (linux\\ext4.vhdx): keep one, then run this again." % (OLD_INSTALL, INSTALL))
            print("Moving %s's disk into %s..." % (WSL_DISTRO, os.path.join(INSTALL, "linux")), flush=True)
            os.makedirs(INSTALL, exist_ok=True)
            wsl("--terminate", WSL_DISTRO, timeout=120)
            until = time.time() + 90
            while True:  # (WSL's own machine lets go of a stopped Linux's disk a little after: tried again till then)
                code, out = wsl("--manage", WSL_DISTRO, "--move", os.path.join(INSTALL, "linux"), timeout=1800)
                if code == 0 or "SHARING_VIOLATION" not in out or time.time() > until:
                    break
                time.sleep(5)
            if code != 0 or os.path.isfile(disk):
                raise SystemExit("WSL didn't move %s's disk (%s): the rest stays in %s too, used as it is, until it can be."
                                 % (WSL_DISTRO, out[-300:] or "no answer", OLD_INSTALL))
    move_into(OLD_INSTALL, INSTALL)
    if os.path.exists(OLD_SHORTCUT):
        os.remove(OLD_SHORTCUT)
    print("Moved %s to %s (its name since the rename)." % (OLD_INSTALL, INSTALL), flush=True)


def make_shortcut(target, launcher):
    q = lambda s: s.replace("'", "''")
    code, out = ps("$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%s'); $s.TargetPath = '%s'; $s.Arguments = '\"%s\"'; "
                   "$s.WorkingDirectory = '%s'; $s.Description = 'Cluster: this PC as a member of the cluster'; $s.Save()"
                   % (q(SHORTCUT), q(target), q(launcher), q(INSTALL)))
    if code != 0:
        raise SystemExit("The Startup shortcut wasn't made: %s" % out.strip()[-300:])


def answers(timeout=40):
    """What the service says about itself here, once it answers (or None)."""
    until = time.time() + timeout
    while time.time() < until:
        try:
            req = urllib.request.Request("http://127.0.0.1:47830/api/node", headers={"X-HT-Cluster": "1", "Host": "localhost:47830"})
            with urllib.request.urlopen(req, timeout=5) as res:
                return json.loads(res.read().decode("utf-8"))
        except (OSError, ValueError):
            time.sleep(2)
    return None


def main():
    a = argparse.ArgumentParser(description="Cluster's service on this Windows PC")
    a.add_argument("--python", help="the Python the service runs with (default: this one)")
    a.add_argument("--tools-python", help="the Python the animal model's tools are made with (one onnxruntime has wheels for)")
    a.add_argument("--ffmpeg", help="ffmpeg.exe for the conversions (default: on the path, else a build in Documents)")
    a.add_argument("--drive", action="append", default=[], metavar="LETTER=UNC", help="a Pi's shared folder as a drive, e.g. P=\\\\pi\\home\\alex\\Downloads")
    a.add_argument("--from-repo", action="store_true", help="this copy of the code, not GitHub's latest build")
    a.add_argument("--linux", action="store_true", help="set up Cluster-Linux under WSL, for Transmission")
    a.add_argument("--remove", action="store_true")
    args = a.parse_args()
    if os.name != "nt":
        raise SystemExit("This is for a Windows PC (a Pi has cluster/setup.sh).")
    if args.linux:
        if os.path.isdir(OLD_INSTALL):
            raise SystemExit("This PC's folder still has its name from before the rename (%s): run setup.py without --linux first "
                             "(it moves it, and starts the service again), then this." % OLD_INSTALL)
        return setup_linux()
    drives = []
    for d in args.drive:
        letter, _, remote = d.partition("=")
        if len(letter) != 1 or not letter.isalpha() or not remote.startswith("\\\\"):
            raise SystemExit("--drive takes LETTER=\\\\server\\path (got %s)" % d)
        drives.append({"letter": letter.upper(), "remote": remote})
    stop()
    if args.remove:
        for s in (SHORTCUT, OLD_SHORTCUT):
            if os.path.exists(s):
                os.remove(s)
        print("Cluster's service stopped, and it won't start at sign-in. Its folder stays: %s"
              % (OLD_INSTALL if os.path.isdir(OLD_INSTALL) else INSTALL))
        return 0
    move_old_folder()
    os.makedirs(INSTALL, exist_ok=True)
    version = install_repo() if args.from_repo else install_latest()
    launcher = os.path.join(INSTALL, "launcher.py")
    shutil.copyfile(os.path.join(INSTALL, "versions", version, "windows", "launcher.py"), launcher)
    try:  # (what's there already is kept: its drives, say, unless given again)
        with open(os.path.join(INSTALL, "config.json"), "r", encoding="utf-8") as f:
            config = json.load(f)
        if not isinstance(config, dict):
            config = {}
    except (OSError, ValueError):
        config = {}
    if args.python or not config.get("python"):
        config["python"] = os.path.abspath(args.python or sys.executable)
    if args.tools_python:
        config["toolsPython"] = os.path.abspath(args.tools_python)
    config.setdefault("toolsPython", "")
    if args.ffmpeg or not config.get("ffmpeg"):
        config["ffmpeg"] = args.ffmpeg or find_ffmpeg() or ""
    if drives:
        config["drives"] = drives
    py = config["python"]
    with open(os.path.join(INSTALL, "config.json") + ".new", "w", encoding="utf-8") as f:
        json.dump(config, f, indent=1)
    os.replace(os.path.join(INSTALL, "config.json") + ".new", os.path.join(INSTALL, "config.json"))
    if not config["ffmpeg"]:
        print("No ffmpeg found: conversions wait until config.json says where one is (--ffmpeg).")
    pyw = windowless(py)
    make_shortcut(pyw, launcher)
    subprocess.Popen([pyw, launcher], cwd=INSTALL, creationflags=DETACHED | NO_WINDOW, close_fds=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    d = answers()
    if not d:
        raise SystemExit("It's started, but hasn't answered yet: see %s" % os.path.join(INSTALL, "service.log"))
    print("Cluster's service %s runs on %s (port 47830), starting at each sign-in: %s" % (
        d.get("version", "?")[:7], d.get("name"), ", ".join("%s (%s)" % (m["name"], (m.get("status") or {}).get("summary") or ("on" if m["on"] else "off")) for m in d.get("modules", []))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
