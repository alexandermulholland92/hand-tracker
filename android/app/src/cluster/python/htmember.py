"""
htmember.py - this phone as a member of the cluster (the Cluster app on Android, MemberService.java): Cluster's own
service (cluster/node/ht_cluster.py, the same as on the Pis, copied from the app's assets into its files) run here, in
the app's Python (Chaquopy), until the member switch is turned off.

  run(code_dir, env_json)   blocks while it runs: env_json's settings first (HT_CLUSTER_PLATFORM=android, its name,
                            Tailscale address, the Pis the app knows, its state folder), then the service
  stop()                    ends it (from another thread): the modules note what they want, then its server stops
  running() -> bool
"""

import json
import os
import sys
import threading

_state = {"node": None, "server": None, "error": ""}


def run(code_dir, env_json):
    env = json.loads(env_json or "{}")
    for key, value in env.items():
        os.environ[str(key)] = str(value)
    if code_dir not in sys.path:
        sys.path.insert(0, code_dir)
    import ht_cluster  # (its modules read the settings above as they load)

    node = ht_cluster.Node(port=int(env.get("HT_CLUSTER_PORT") or ht_cluster.PORT))
    ht_cluster.Handler.node = node
    server = ht_cluster.Server(("::", node.port), ht_cluster.Handler)
    _state.update(node=node, server=server, error="")
    node.start()
    node.log("Cluster service %s on %s (this phone), port %d, modules: %s" % (node.version[:7], node.name, node.port, ", ".join(node.modules) or "none"))
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        _state.update(node=None, server=None)


def stop():
    node, server = _state["node"], _state["server"]
    if node:
        node.notify_stop()
        node.stopping.set()
    if server:
        threading.Thread(target=server.shutdown, daemon=True).start()


def running():
    return _state["server"] is not None
