"""
web.py - Cluster module: Use from hand-tracker.com. Off unless switched on, on each device (the user, 2026-11-27: "A
switch in the apps").

On: this device opens an HTTPS address of its own on Tailscale, https://<its Tailscale name>:47835, with Tailscale's
certificate for that name. hand-tracker.com/cluster.html, opened in a browser on a device of your Tailscale account,
then works as the Cluster app does, through this device (the others of the cluster through it, as the page a Pi
serves does). Two things first, once each: Tailscale's HTTPS certificates turned on for your Tailscale network (its
admin console: DNS, HTTPS Certificates), and on a Pi this service's user let ask for its certificate
(`sudo tailscale set --operator=<user>`). Until then its warning says which. Off: that address closed again.

The address itself, its checks and its certificate: class Web in ht_cluster.py.
"""

TITLE = "Use from hand-tracker.com"
ORDER = 95
ON = False
EVERY = 60
PLATFORMS = ("linux", "windows")  # (not a phone: Tailscale gives other apps there no certificate)
SITE = "https://hand-tracker.com/cluster.html"


def tick(node):
    node.web.on()


def off(node):
    node.web.off()


def status(node):
    w = node.web
    if w.server and w.address:
        out = {"summary": "On: hand-tracker.com/cluster.html reaches the cluster through this device (https://%s)." % w.address,
               "link": {"title": "Open hand-tracker.com/cluster.html", "url": "%s#via=%s" % (SITE, w.address)}}
    else:
        out = {"summary": "Turning on…" if not w.error else "Not on yet."}
    if w.error:
        out["warnings"] = [w.error]
    return out
