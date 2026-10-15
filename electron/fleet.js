/**
 * fleet.js — live pictures from capture rigs on a capture-fleet dashboard (an optional,
 * hidden feature of the Windows, Linux and Android apps, next to Capture Sessions in ops.js;
 * the Android app's is in mobile-bridge.js and RemotePlugin.java).
 *
 * Built for dashboards that list their rigs at /api/fleet/status and pass each rig's own
 * preview through at /proxy/<rig>/api/preview/keyframe/<camera> (the camera's latest H.264
 * keyframe, full size) and /proxy/<rig>/api/preview/frame/<camera> (a JPEG of it). That's
 * what the dashboard's own camera tiles show, so it's a new picture every second or two,
 * and it only ever reads: nothing on a rig or the dashboard is changed.
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
 *   fleet.serveFrame(host, camera, { kind, full }); // a Response with the camera's latest picture
 */

const fs = require("fs");
const path = require("path");
// The rig list and address rules are shared with the Android app.
const { fleetRigs, fleetSessions, FLEET_SESSION_DAYS, siteOrigin, FLEET_HOST_RE: HOST_RE, FLEET_CAMERA_RE: CAMERA_RE } = require("../remote-core.js");

const FRAME_TIMEOUT_MS = 10000;

const isRedirect = (err) => /redirect/i.test(String((err && err.message) || err));

class FleetClient {
  // safe: Electron's safeStorage (the rigs' Bluetooth password is kept with it, encrypted).
  constructor(dataDir, ses, safe = null) {
    this.file = path.join(dataDir, "capture-fleet.json");
    this.ses = ses;
    this.safe = safe;
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
    this.cfg = { site: siteOrigin(site), ...(this.cfg.rigBle ? { rigBle: this.cfg.rigBle } : {}) };
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

  // The work rigs' shared Bluetooth password (rig-ble.js), kept encrypted; "" when there's none.
  blePassword() {
    try {
      return this.cfg.rigBle && this.safe && this.safe.isEncryptionAvailable() ? this.safe.decryptString(Buffer.from(this.cfg.rigBle, "base64")) : "";
    } catch {
      return "";
    }
  }
  setBlePassword(password) {
    const pw = String(password || "");
    if (!pw) delete this.cfg.rigBle;
    else {
      if (!this.safe || !this.safe.isEncryptionAvailable()) throw new Error("This computer can't keep it encrypted.");
      if (pw.length > 128) throw new Error("That's too long for a Bluetooth password.");
      this.cfg.rigBle = this.safe.encryptString(pw).toString("base64");
    }
    this.save();
    return !!pw;
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
    return fleetRigs(j);
  }

  // A rig's sessions of the last FLEET_SESSION_DAYS days, newest first (fleetSessions): those
  // it has uploaded (its history) and those still on it, as the rig itself lists them through
  // the dashboard. Only read.
  async sessions(host) {
    this.requireConfigured();
    if (!HOST_RE.test(String(host || ""))) throw new Error("Which rig?");
    const get = async (p) => {
      let res;
      try {
        res = await this.ses.fetch(`${this.cfg.site}/proxy/${host}/${p}?days=${FLEET_SESSION_DAYS}`, { cache: "no-store", redirect: "manual", credentials: "include" });
      } catch (err) {
        if (!isRedirect(err)) return null;
        this.signedIn = false;
        throw new Error("Sign in to the fleet dashboard first.");
      }
      if (res.status === 401 || (res.status >= 300 && res.status < 400) || res.status === 0) {
        this.signedIn = false;
        throw new Error("Sign in to the fleet dashboard first.");
      }
      const type = res.headers.get("content-type") || "";
      return res.ok && type.includes("json") ? res.json().catch(() => null) : null;
    };
    const [history, local] = await Promise.all([get("api/sessions/history"), get("api/sessions")]);
    if (!Array.isArray(history) && !Array.isArray(local)) throw new Error("The rig didn't say what it has recorded (it may be offline).");
    return fleetSessions(history, local);
  }

  // The camera's latest picture, as the dashboard's own camera tile gets it. kind
  // "keyframe": its latest H.264 keyframe (full size; x-codec-string says how to decode it);
  // "jpeg": a JPEG, the preview size (about 854 wide) or with full, the camera's own size.
  // The rig's x-frame-* headers (the picture's age, and whether it's stale) are passed on.
  async serveFrame(host, camera, { kind = "jpeg", full = false } = {}) {
    if (!this.cfg.site || !HOST_RE.test(host) || !CAMERA_RE.test(camera)) return new Response("Not found", { status: 404 });
    const endpoint = kind === "keyframe" ? `keyframe/${camera}?` : `frame/${camera}?${full ? "quality=full" : "fps=2"}&`;
    let res;
    // A rig that doesn't answer mustn't hold up the next picture.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), FRAME_TIMEOUT_MS);
    try {
      res = await this.ses.fetch(`${this.cfg.site}/proxy/${host}/api/preview/${endpoint}t=${Date.now()}`, { cache: "no-store", redirect: "manual", credentials: "include", signal: abort.signal });
    } catch (err) {
      if (abort.signal.aborted) return new Response("The rig took too long to answer", { status: 504 });
      if (isRedirect(err)) {
        this.signedIn = false;
        return new Response("Signed out", { status: 401 });
      }
      return new Response(String(err.message || err), { status: 502 });
    } finally {
      clearTimeout(timer);
    }
    const type = res.headers.get("content-type") || "";
    // (A redirect comes back as status 0, "opaqueredirect".)
    if ((res.ok && !/^(image|video)\//.test(type)) || res.status === 401 || res.status < 200 || (res.status >= 300 && res.status < 400)) {
      // A sign-in page (or a redirect to one) instead of a picture: signed out.
      this.signedIn = false;
      return new Response("Signed out", { status: 401 });
    }
    const headers = { "content-type": type || "application/octet-stream", "cache-control": "no-store" };
    for (const h of ["x-codec-string", "x-frame-stale", "x-frame-age-ms", "x-frame-unix-ns"]) {
      const v = res.headers.get(h);
      if (v) headers[h] = v;
    }
    return new Response(res.body, { status: res.status, headers });
  }
}

module.exports = { FleetClient };
