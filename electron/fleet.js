/**
 * fleet.js — live pictures from capture rigs on a capture-fleet dashboard (an optional,
 * hidden feature of the Windows and Linux app, next to Capture Sessions in ops.js).
 *
 * Built for dashboards that list their rigs at /api/fleet/status and pass each rig's own
 * preview through at /proxy/<rig>/api/preview/frame/<camera>: a JPEG of the camera's latest
 * picture. That's what the dashboard's own camera tiles show, so it's a new picture every
 * second or two, and it only ever reads: nothing on a rig or the dashboard is changed.
 *
 * Nothing specific to one dashboard is in the code: its web address is entered once and
 * kept in this app's data folder. The sign-in is the user's own, on the dashboard's own
 * sign-in page, in a separate browser profile ("persist:capture-fleet") that keeps its
 * cookie between runs like a browser would; signing out clears that profile.
 *
 *   const fleet = new FleetClient(userDataDir, session.fromPartition("persist:capture-fleet"));
 *   await fleet.configure("https://fleet.example.com");
 *   await fleet.signIn(parentWindow);           // resolves once the dashboard answers as signed in
 *   await fleet.rigs();                         // [{ host, name, state, cameras, canWatch, ... }]
 *   fleet.serveFrame(host, camera, { full });   // a Response with the camera's latest JPEG
 */

const fs = require("fs");
const path = require("path");

const HOST_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const CAMERA_RE = /^[a-z0-9_]{1,32}$/i;
// Generations whose previews start on demand; the others only show a picture while their
// preview is already running (the dashboard's own rule; starting one would change the rig).
const ON_DEMAND = new Set(["rock5c", "granite"]);

const isRedirect = (err) => /redirect/i.test(String((err && err.message) || err));

class FleetClient {
  constructor(dataDir, ses) {
    this.file = path.join(dataDir, "capture-fleet.json");
    this.ses = ses;
    this.cfg = this.read();
    this.signedIn = false;
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cfg, null, 2));
  }

  status() {
    return { configured: !!this.cfg.site, site: this.cfg.site || "", signedIn: this.signedIn };
  }

  // https only (http is allowed for this computer, for automated checks).
  configure(site) {
    let url;
    try {
      url = new URL(String(site).trim());
    } catch {
      throw new Error("That isn't a web address.");
    }
    const local = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !local) throw new Error("The dashboard's address must start with https://");
    this.cfg = { site: url.origin };
    this.signedIn = false;
    this.save();
    return this.status();
  }

  requireConfigured() {
    if (!this.cfg.site) throw new Error("Enter the fleet dashboard's address first.");
  }

  // The dashboard's rig list, or null when it doesn't answer as signed in.
  async fleetStatus() {
    this.requireConfigured();
    let res;
    try {
      res = await this.ses.fetch(`${this.cfg.site}/api/fleet/status`, { cache: "no-store", redirect: "manual", credentials: "include" });
    } catch (err) {
      // Electron's fetch reports a redirect (to the sign-in page) it wasn't to follow as an error.
      if (!isRedirect(err)) throw err;
      this.signedIn = false;
      return null;
    }
    const type = res.headers.get("content-type") || "";
    const j = res.ok && type.includes("json") ? await res.json().catch(() => null) : null;
    this.signedIn = !!(j && Array.isArray(j.devices));
    return this.signedIn ? j : null;
  }

  async check() {
    if (this.cfg.site) await this.fleetStatus().catch(() => (this.signedIn = false));
    return this.status();
  }

  // Opens the dashboard's sign-in page in a window using this client's own browser profile;
  // resolves once the dashboard answers as signed in (the user signs in there themselves).
  signIn(BrowserWindow, parent) {
    this.requireConfigured();
    return new Promise((resolve, reject) => {
      const win = new BrowserWindow({
        parent: parent || undefined,
        width: 480,
        height: 720,
        title: "Sign in to the fleet dashboard",
        autoHideMenuBar: true,
        webPreferences: { session: this.ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      let done = false;
      const finish = (err, value) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        if (!win.isDestroyed()) win.close();
        err ? reject(err) : resolve(value);
      };
      const timer = setInterval(async () => {
        try {
          if (await this.fleetStatus()) finish(null, this.status());
        } catch {
          // not yet
        }
      }, 1500);
      win.on("closed", () => finish(new Error("Sign-in window closed before signing in.")));
      win.loadURL(`${this.cfg.site}/login`).catch(() => {});
    });
  }

  async signOut() {
    await this.ses.clearStorageData();
    this.signedIn = false;
    return this.status();
  }

  // Every rig, those recording first, then those that can be watched, then the rest.
  async rigs() {
    const j = await this.fleetStatus();
    if (!j) throw new Error("Sign in to the fleet dashboard first.");
    const rank = (r) => (r.state === "recording" ? 0 : r.canWatch ? 1 : r.online ? 2 : 3);
    return j.devices
      .filter((d) => d && HOST_RE.test(d.hostname || ""))
      .map((d) => {
        const cameras = (Array.isArray(d.preview_cameras) ? d.preview_cameras : []).filter((c) => CAMERA_RE.test(c));
        const online = !!d.online;
        return {
          host: d.hostname,
          name: d.display_name || d.readable_name || d.hostname,
          generation: d.generation || "",
          online,
          state: d.capture_state || (online ? "online" : "offline"),
          recordingS: Number(d.recording_duration_s) || 0,
          session: d.session_name || "",
          cameras,
          // Mirrors the dashboard: a relayed rig has no proxy, and only on-demand previews
          // (or ones already running) can be shown without starting anything on the rig.
          canWatch: online && d.reachable !== false && !d.via_relay && cameras.length > 0 && (!!d.preview_active || ON_DEMAND.has(d.generation)),
        };
      })
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }

  // The camera's latest picture, as the dashboard's own camera tile gets it. Default: the
  // preview size (about 854 wide); full: the camera's own resolution (bigger downloads).
  async serveFrame(host, camera, { full = false } = {}) {
    if (!this.cfg.site || !HOST_RE.test(host) || !CAMERA_RE.test(camera)) return new Response("Not found", { status: 404 });
    const query = full ? "quality=full" : "fps=2";
    let res;
    try {
      res = await this.ses.fetch(`${this.cfg.site}/proxy/${host}/api/preview/frame/${camera}?${query}&t=${Date.now()}`, { cache: "no-store", redirect: "manual", credentials: "include" });
    } catch (err) {
      if (isRedirect(err)) {
        this.signedIn = false;
        return new Response("Signed out", { status: 401 });
      }
      return new Response(String(err.message || err), { status: 502 });
    }
    const type = res.headers.get("content-type") || "";
    // (A redirect comes back as status 0, "opaqueredirect".)
    if ((res.ok && !type.startsWith("image/")) || res.status === 401 || res.status < 200 || (res.status >= 300 && res.status < 400)) {
      // A sign-in page (or a redirect to one) instead of a picture: signed out.
      this.signedIn = false;
      return new Response("Signed out", { status: 401 });
    }
    return new Response(res.body, { status: res.status, headers: { "content-type": type || "application/octet-stream", "cache-control": "no-store" } });
  }
}

module.exports = { FleetClient };
