#!/usr/bin/env python3
"""
pieces.py - one computer's part of a big torrent, by pieces, for Cluster's downloads (modules/downloads.py; the
user, 2026-11-24: "can you split up single torrents between multiple devices?" -> "By files and pieces").
Transmission can't download chosen pieces, so this does it with libtorrent (Debian's python3-libtorrent): only the
pieces from FIRST up to (not including) END, into FOLDER (each file where the torrent puts it), seeding them while
it runs. It says how it's going in STATE/status.json every 2 s, and does what STATE/control.json says:
{"paused": true} pauses it, {"stop": true} ends it (its progress kept in STATE/resume.dat, so it goes on from there
next time). Its peers are kept few (40), with uTP, DHT and local peer discovery off, as on the cluster's Transmission.

  python3 pieces.py TORRENT FOLDER FIRST END STATE [--port N]
"""

import json
import os
import sys
import time

import libtorrent as lt

SAVE_EVERY_S = 300


def write_json(path, data):
    with open(path + ".new", "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(path + ".new", path)


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_resume(ses, h, path, wait=10):
    """Its progress written down (libtorrent says it in an alert: waited for, up to wait seconds)."""
    if not h.is_valid() or not h.status().has_metadata:
        return
    h.save_resume_data(lt.save_resume_flags_t.flush_disk_cache)
    until = time.time() + wait
    while time.time() < until:
        ses.wait_for_alert(500)
        for a in ses.pop_alerts():
            if isinstance(a, lt.save_resume_data_alert):
                with open(path + ".new", "wb") as f:
                    f.write(lt.write_resume_data_buf(a.params))
                os.replace(path + ".new", path)
                return
            if isinstance(a, lt.save_resume_data_failed_alert):
                return


def main():
    args = sys.argv[1:]
    port = 51416
    if "--port" in args:
        i = args.index("--port")
        port = int(args[i + 1])
        del args[i:i + 2]
    if len(args) != 5:
        print(__doc__)
        return 2
    torrent, folder, first, end, state = args[0], args[1], int(args[2]), int(args[3]), args[4]
    os.makedirs(folder, exist_ok=True)
    os.makedirs(state, exist_ok=True)
    status_file, control_file, resume_file = (os.path.join(state, n) for n in ("status.json", "control.json", "resume.dat"))
    ses = lt.session({"listen_interfaces": "0.0.0.0:%d" % port, "enable_dht": False, "enable_lsd": False, "enable_upnp": True,
                      "enable_natpmp": True, "enable_incoming_utp": False, "enable_outgoing_utp": False, "connections_limit": 40,
                      "user_agent": "Cluster pieces/1", "alert_mask": lt.alert.category_t.error_notification | lt.alert.category_t.storage_notification})
    ti = lt.torrent_info(torrent)
    n = ti.num_pieces()
    first, end = max(0, min(first, n)), max(0, min(end, n))
    atp = lt.add_torrent_params()
    if os.path.exists(resume_file):
        try:
            with open(resume_file, "rb") as f:
                atp = lt.read_resume_data(f.read())
        except Exception:  # (unreadable: checked again from the files instead)
            atp = lt.add_torrent_params()
    atp.ti = ti
    atp.save_path = folder
    mine = [4 if first <= i < end else 0 for i in range(n)]
    atp.piece_priorities = mine
    atp.flags &= ~lt.torrent_flags.auto_managed
    atp.flags &= ~lt.torrent_flags.paused
    h = ses.add_torrent(atp)
    h.prioritize_pieces(mine)
    saved = time.time()
    paused = False
    try:
        while True:
            ctl = read_json(control_file)
            if ctl.get("stop"):
                break
            if bool(ctl.get("paused")) != paused:
                paused = bool(ctl.get("paused"))
                h.pause() if paused else h.resume()
            s = h.status()
            have = sum(1 for i in range(first, end) if s.pieces and s.pieces[i]) if s.has_metadata else 0
            error = s.errc.message() if s.errc and s.errc.value() else ""
            write_json(status_file, {"have": have, "of": end - first, "done": end > first and have == end - first, "down": s.download_rate,
                                     "up": s.upload_rate, "peers": s.num_peers, "state": str(s.state).split(".")[-1], "paused": paused,
                                     "error": error, "upEver": s.all_time_upload, "downEver": s.all_time_download, "at": time.time()})
            for a in ses.pop_alerts():  # (a file it couldn't write, say: said in its status)
                if isinstance(a, (lt.file_error_alert, lt.torrent_error_alert)):
                    print("pieces.py: %s" % a.message(), flush=True)
            if time.time() - saved > SAVE_EVERY_S:
                save_resume(ses, h, resume_file)
                saved = time.time()
            time.sleep(2)
    finally:
        h.pause()
        save_resume(ses, h, resume_file)
    return 0


if __name__ == "__main__":
    sys.exit(main())
