"""
ftp.py - Cluster module, on a Pi: an FTP link to this Pi's shared folders for the cluster's phones (the user,
2026-11-23/25: phones "mount them as an ftp link built into the app"; the Cluster app on a phone opens it).

What it shares: the folders this Pi shares on the network already (its NFS exports, /etc/exports: those the PC has
as drives), each at the top by its name. Who: only over Tailscale, and only a phone of the cluster, logging in with
its name and its own key (the one it gave this Pi: ht_cluster.py's take_phone; it changes only if the phone's app is
put in again). What a phone can do there: list, fetch, send files and make folders; not delete or rename anything.
FTP itself is plain text, but over Tailscale it's encrypted on the way.

pyftpdlib runs it (Debian's python3-pyftpdlib, about 0.2 MB, MIT): "Get the FTP server" puts it in (the root
helper), this Pi's own choice; until then it says so.
"""

import os
import re
import sys
import threading
import time

TITLE = "FTP link (phones)"
ORDER = 62
ON = True
EVERY = 10
PLATFORMS = ("linux",)
PORT = 2121
PASSIVE = (2122, 2141)  # (a link's data on one of these)
PERMS = "elrawm"  # list folders and files, fetch, append, send, make folders (no delete, rename or changing modes)
ROOT_NAME = "ftp-root"  # (in the state folder: a link to each shared folder, which pyftpdlib serves)

_state = {"server": None, "error": None, "folders": [], "at": 0, "have": None, "haveAt": 0}
_lock = threading.Lock()


def available(node):
    """Whether pyftpdlib's here (looked at once a minute)."""
    if _state["have"] is not None and time.time() - _state["haveAt"] < 60:
        return _state["have"]
    try:
        import pyftpdlib  # noqa: F401

        ok = True
    except ImportError:
        ok = False
    _state.update(have=ok, haveAt=time.time())
    return ok


def shared_folders(node):
    """This Pi's NFS exports (the folders it shares on the network): [path] (simulated: HT_CLUSTER_FTP_FOLDERS)."""
    if node.simulate:
        return [p for p in (os.environ.get("HT_CLUSTER_FTP_FOLDERS") or "").split(os.pathsep) if p and os.path.isdir(p)]
    out = []
    text = node.read("/etc/exports", "") or ""
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        m = re.match(r'^"([^"]+)"|^(\S+)', line)
        path = (m.group(1) or m.group(2)) if m else ""
        if path.startswith("/") and os.path.isdir(path) and path not in out:
            out.append(path)
    return out


def root_dir(node, folders):
    """The FTP's top folder: a link to each shared folder, by its name (made again as they change)."""
    root = os.path.join(node.state_dir, ROOT_NAME)
    os.makedirs(root, exist_ok=True)
    want, names = {}, set()
    for f in folders:
        name = os.path.basename(f.rstrip("/")) or "root"
        base, n = name, 2
        while name in names:
            name, n = "%s %d" % (base, n), n + 1
        names.add(name)
        want[name] = f
    for name in os.listdir(root):
        p = os.path.join(root, name)
        if os.path.islink(p) and (name not in want or os.readlink(p) != want[name]):
            os.remove(p)
    for name, f in want.items():
        p = os.path.join(root, name)
        if not os.path.lexists(p):
            os.symlink(f, p)
    return root


def make_server(node, root, folders):
    from pyftpdlib.authorizers import AuthenticationFailed, DummyAuthorizer
    from pyftpdlib.filesystems import AbstractedFS
    from pyftpdlib.handlers import FTPHandler
    from pyftpdlib.servers import ThreadedFTPServer

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if here not in sys.path:
        sys.path.insert(0, here)
    import ht_cluster
    import hmac

    allowed = [os.path.realpath(f) for f in folders]

    class Phones(DummyAuthorizer):
        """A phone of the cluster, by its name and its own key (those it gave this Pi)."""

        def validate_authentication(self, username, password, handler):
            phones = node.config.get("phones") or {}
            for addr, p in phones.items():
                if (isinstance(p, dict) and p.get("name") == username and p.get("key")
                        and hmac.compare_digest(str(password).encode(), str(p["key"]).encode())):
                    return
            raise AuthenticationFailed("Not a phone of this cluster.")

        def get_home_dir(self, username):
            return root

        def has_user(self, username):
            return True

        def has_perm(self, username, perm, path=None):
            return perm in PERMS

        def get_perms(self, username):
            return PERMS

        def get_msg_login(self, username):
            return "This Pi's shared folders."

        def get_msg_quit(self, username):
            return "Bye."

    class Shared(AbstractedFS):
        """Its top folder, and inside the shared folders its links lead to (nothing else)."""

        def validpath(self, path):
            real = os.path.realpath(path)
            if real == os.path.realpath(root):
                return True
            return any(real == a or real.startswith(a.rstrip(os.sep) + os.sep) for a in allowed)

    class Handler(FTPHandler):
        authorizer = Phones()
        abstracted_fs = Shared
        passive_ports = range(PASSIVE[0], PASSIVE[1])
        banner = "Cluster: this Pi's shared folders, for the cluster's phones."

        def on_connect(self):
            # (only over Tailscale: this account's own devices)
            if not (node.simulate or ht_cluster.is_tailscale(self.remote_ip)):
                self.close()

    return ThreadedFTPServer(("::" if not node.simulate else "127.0.0.1", int(os.environ.get("HT_CLUSTER_FTP_PORT") or PORT) if node.simulate else PORT), Handler)


def tick(node):
    if not available(node):
        return
    folders = shared_folders(node)
    with _lock:
        if folders != _state["folders"] or not _state["server"]:
            _state["folders"] = folders
            try:
                root = root_dir(node, folders)
                if not _state["server"]:
                    server = make_server(node, root, folders)
                    threading.Thread(target=server.serve_forever, kwargs={"handle_exit": False}, daemon=True, name="ftp").start()
                    _state.update(server=server, error=None)
                    node.event("ftp", "The phones' FTP link to this Pi's shared folders is on (port %d)." % PORT)
            except Exception as e:  # (said in its status, tried again at the next tick)
                _state["error"] = str(e)[:300]


def stopping(node):
    s = _state["server"]
    if s:
        try:
            s.close_all()
        except Exception:
            pass


def status(node):
    if not available(node):
        return {"summary": "Its FTP server isn't here yet: Get the FTP server puts it in (Debian's, about 0.2 MB)", "ready": False}
    if _state["error"]:
        return {"summary": "The phones' FTP link didn't start", "warnings": [_state["error"]], "ready": False}
    folders = _state["folders"]
    if not folders:
        return {"summary": "On, but this Pi shares no folders on the network (its NFS exports) for it to show", "ready": True, "port": PORT, "folders": []}
    names = [os.path.basename(f.rstrip("/")) or f for f in folders]
    return {"summary": "Phones see %s over FTP (port %d)" % (", ".join(names), PORT), "ready": True, "port": PORT, "folders": names}


def act_get(node, args):
    """pyftpdlib put on this Pi (Debian's), for the phones' FTP link."""
    if node.simulate:
        return {"ok": False, "error": "Not while simulated."}
    a = node.root("install-pyftpdlib", timeout=1800)
    _state["have"] = None
    return {"ok": True, "message": "The FTP server is on %s now." % node.name} if a.get("ok") else {"ok": False, "error": a.get("error")}


ACTIONS = {
    "getFtp": {"title": "Get the FTP server (for the phones' link)", "run": act_get,
               "confirm": "Download and install the FTP server here (Debian's python3-pyftpdlib, about 0.2 MB)?"},
}
