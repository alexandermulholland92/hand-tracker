"""
ftp.py - Cluster module, on a Pi: an FTP link to this Pi's shared folders for the cluster's phones (the user,
2026-11-23/25: phones "mount them as an ftp link built into the app"; the Cluster app on a phone opens it).

What it shares: the folders this Pi shares on the network already (its NFS exports, /etc/exports: those the PC has
as drives), and those its switches share (your whole home, Downloads, Videos, ...: the user, 2026-11-25, "New
buttons"; the root helper shares them over NFS too, to Tailscale's addresses only, for the PC's drives), each at the
top by its name. With your whole home shared, nothing in it whose name starts with a dot is shown or reachable (the
user, 2026-11-25: "exclude hidden folders from the whole home share", hidden files too); over NFS, which can't leave
folders out of a share, it goes as each folder in it that isn't hidden ("Each visible folder"). Who: only over Tailscale, and only a phone of the cluster, logging in with
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
SHARE = [("shareHome", "~", "your whole home folder"), ("shareDownloads", "Downloads", "Downloads"), ("shareVideos", "Videos", "Videos"),
         ("shareMusic", "Music", "Music"), ("sharePictures", "Pictures", "Pictures"), ("shareDocuments", "Documents", "Documents")]
SETTINGS = [{"key": k, "title": "Share %s" % words, "default": False} for k, _, words in SHARE]
SHARES = "/etc/exports.d/ht-cluster-shares.exports"  # (the root helper's share-folders: the switches' folders)
OTHERS = ("/etc/exports", "/etc/exports.d/ht-cluster.exports")  # (yours, and Transmission's: not shared twice)
SHARE_RETRY_S = 600  # (a share that didn't go in, tried again after this)
FOLDER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.+-]{0,59}$")  # (the root helper's own check: names it shares)
NFS_MAX = 40  # (the root helper takes at most this many)

_state = {"server": None, "error": None, "folders": [], "at": 0, "have": None, "haveAt": 0, "home": None}
_share = {"failed": None, "at": 0, "error": None, "capped": False}
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


def exported(node, path):
    """The folders an NFS exports file shares: [path]."""
    out = []
    for line in (node.read(path, "") or "").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        m = re.match(r'^"([^"]+)"|^(\S+)', line)
        p = (m.group(1) or m.group(2)) if m else ""
        p = p.rstrip("/") or p
        if p.startswith("/") and p not in out:
            out.append(p)
    return out


def home_dir(node):
    sim = (os.environ.get("HT_CLUSTER_FTP_HOME") or os.environ.get("HT_CLUSTER_SIM_HOME")) if node.simulate else None
    return os.path.normpath(sim or os.path.expanduser("~"))


def wanted(node):
    """The folders its switches share, those there: [(name: "~" for your whole home, path)]."""
    home, out = home_dir(node), []
    for key, name, _ in SHARE:
        p = home if name == "~" else os.path.join(home, name)
        if node.setting("ftp", key) and os.path.isdir(p) and not os.path.islink(p):
            out.append((name, p))
    return out


def nfs_wanted(node):
    """What its switches share over NFS: [(folder name in your home, path)], your whole home as each folder in it that
    isn't hidden (NFS can't leave folders out of a share); names the root helper can share."""
    out = []
    for name, p in wanted(node):
        if name != "~":
            subs = [name]
        else:
            try:
                subs = sorted(e.name for e in os.scandir(p) if not e.name.startswith(".") and e.is_dir(follow_symlinks=False))
            except OSError:
                subs = []
        for n in subs:
            q = p if name != "~" else os.path.join(p, n)
            if FOLDER.match(n) and q not in [x[1] for x in out]:
                out.append((n, q))
    return out


def hidden_in(real, folders, home):
    """Whether a path (resolved) is, or is in, something hidden (its name starting with a dot) in your home, with
    your whole home among the shared folders."""
    home = os.path.realpath(home)
    if home not in [os.path.realpath(f) for f in folders]:
        return False
    base = home.rstrip(os.sep) + os.sep
    return real.startswith(base) and any(part.startswith(".") for part in real[len(base):].split(os.sep))


def visible(names, real, folders, home):
    """A folder's names as the phones see them: with your whole home shared, those in it not hidden."""
    h = os.path.realpath(home)
    if h in [os.path.realpath(f) for f in folders] and (real == h or real.startswith(h.rstrip(os.sep) + os.sep)):
        return [n for n in names if not n.startswith(".")]
    return names


def shared_folders(node):
    """This Pi's NFS exports in /etc/exports (the folders it shares on the network: those the PC has as drives), and
    those its switches share: [path] (simulated: HT_CLUSTER_FTP_FOLDERS for the exports)."""
    if node.simulate:
        out = [p for p in (os.environ.get("HT_CLUSTER_FTP_FOLDERS") or "").split(os.pathsep) if p and os.path.isdir(p)]
    else:
        out = [p for p in exported(node, "/etc/exports") if os.path.isdir(p)]
    for _, p in wanted(node):
        if p not in out:
            out.append(p)
    return out


def sync_shares(node):
    """The switches' folders shared over NFS too (the root helper, to Tailscale's addresses only), but not those
    /etc/exports or Transmission's share has already; one that didn't go in is tried again after SHARE_RETRY_S."""
    if node.simulate:
        return
    others = set(p for f in OTHERS for p in exported(node, f))
    need = [(n, p) for n, p in nfs_wanted(node) if p not in others]
    _share["capped"] = len(need) > NFS_MAX
    need = need[:NFS_MAX]
    if sorted(p for _, p in need) == sorted(exported(node, SHARES)):
        _share.update(failed=None, error=None)
        return
    key = "|".join(n for n, _ in need)
    if _share["failed"] == key and time.time() - _share["at"] < SHARE_RETRY_S:
        return
    a = node.root("share-folders", *[n for n, _ in need], timeout=1800)
    _share.update(at=time.time(), failed=None if a.get("ok") else key, error=None if a.get("ok") else a.get("error") or "it didn't go in")
    if not a.get("ok"):
        node.event("ftp", "The folders didn't get shared over the network: %s" % _share["error"], bad=True)
    elif need:
        node.event("ftp", "Shared over the network (NFS, to Tailscale's addresses only): %s." % ", ".join(n for n, _ in need))
    else:
        node.event("ftp", "Its switches share no folders over the network now.")


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

    home = home_dir(node)

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
            return "This device's shared folders."

        def get_msg_quit(self, username):
            return "Bye."

    class Shared(AbstractedFS):
        """Its top folder, and inside the shared folders its links lead to (nothing else)."""

        def validpath(self, path):
            real = os.path.realpath(path)
            if real == os.path.realpath(root):
                return True
            folders = list(_state["folders"])  # (as they are now: the switches change them)
            if hidden_in(real, folders, home):
                return False
            allowed = [os.path.realpath(f) for f in folders]
            return any(real == a or real.startswith(a.rstrip(os.sep) + os.sep) for a in allowed)

        def listdir(self, path):
            return visible(os.listdir(path), os.path.realpath(path), list(_state["folders"]), home)

        listdirinfo = listdir

    class Handler(FTPHandler):
        authorizer = Phones()
        abstracted_fs = Shared
        passive_ports = range(PASSIVE[0], PASSIVE[1])
        banner = "Cluster: this device's shared folders, for the cluster's phones."

        def on_connect(self):
            # (only over Tailscale: this account's own devices)
            if not (node.simulate or ht_cluster.is_tailscale(self.remote_ip)):
                self.close()

    return ThreadedFTPServer(("::" if not node.simulate else "127.0.0.1", int(os.environ.get("HT_CLUSTER_FTP_PORT") or PORT) if node.simulate else PORT), Handler)


def tick(node):
    sync_shares(node)  # (for the PC's drives too: whether or not the FTP server's here)
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
                    node.event("ftp", "The phones' FTP link to this device's shared folders is on (port %d)." % PORT)
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
        return {"summary": "Its FTP server isn't here yet: Get the FTP server puts it in (Debian's, about 0.2 MB)", "ready": False,
                "warnings": ["Sharing over the network didn't work: %s" % _share["error"]] if _share["error"] else []}
    if _state["error"]:
        return {"summary": "The phones' FTP link didn't start", "warnings": [_state["error"]], "ready": False}
    folders = _state["folders"]
    warnings = ["Sharing over the network didn't work: %s" % _share["error"]] if _share["error"] else []
    if _share["capped"]:
        warnings.append("Only the first %d folders of your home are shared over the network (NFS)" % NFS_MAX)
    if not folders:
        return {"summary": "On, but this device shares no folders yet (its ⚙ settings, under FTP link, can share some)",
                "ready": True, "port": PORT, "folders": [], "warnings": warnings}
    names = [os.path.basename(f.rstrip("/")) or f for f in folders]
    return {"summary": "Phones see %s over FTP (port %d)" % (", ".join(names), PORT), "ready": True, "port": PORT, "folders": names, "warnings": warnings}


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
