/**
 * remote-core.js — Capture Sessions and Live Rigs without the plumbing, shared by the
 * desktop app (electron/ops.js, electron/fleet.js) and the Android app (mobile-bridge.js),
 * which each bring their own way of making web requests and of keeping settings and the
 * sign-in.
 *
 * OpsCore: a capture-operations dashboard backed by Supabase that keeps each session's
 * standardized output in Google Cloud Storage as <bucket>/<session id>/standardized/
 * manifest.json plus one <position>/<stream>/video.mp4 per camera, handed out as signed
 * links by a "sign-gcs-urls" function. Nothing specific to one dashboard is in the code:
 * its web address is entered once, and its database address, public (publishable) key and
 * bucket are read from the dashboard's own page. The sign-in is the user's own; only the
 * refresh token is kept, and only encrypted (secret.seal), else for this run only.
 *
 *   const ops = new OpsCore({
 *     fetch,                                  // (url, { method, headers, body }) -> { ok, status, headers.get(), json(), text() }
 *     config: { load() -> {}, save(cfg) },
 *     secret: { seal(text) -> string, open(string) -> text, clear() } | null,   // sync or async
 *   });
 *   ops.status();                             // { configured, site, signedIn, email }
 *   await ops.configure("https://ops.example.com");
 *   await ops.sendCode(email); await ops.verifyCode(email, code);   // or signInWithPassword, adoptSession
 *   await ops.sessions({ offset, limit, search });
 *   await ops.manifest(sessionId);            // { window, streams: [{ position, stream, path, ... }] }
 *   await ops.sign(sessionId, [gsPath]);      // { [gsPath]: signed https link }
 *
 * fleetRigs(status): a capture-fleet dashboard's /api/fleet/status as the rigs Live Rigs
 * lists: recording first, then those that can be watched, then the rest.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RemoteCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  const PAGE_SIZE = 50;

  class OpsCore {
    constructor({ fetch, config, secret = null }) {
      this.fetch = fetch;
      this.config = config;
      this.secret = secret;
      this.cfg = config.load() || {};
      this.access = null; // { token, expires }
      this.refreshMem = null; // the refresh token, for this run
    }

    save() {
      this.config.save(this.cfg);
    }

    status() {
      const signedIn = !!(this.access || this.refreshMem || (this.cfg.refresh && this.secret));
      return { configured: !!(this.cfg.base && this.cfg.key && this.cfg.bucket), site: this.cfg.site || "", signedIn, email: this.cfg.email || "" };
    }

    // Reads the dashboard's page to find its database address, public key and bucket.
    async configure(site) {
      let url;
      try {
        url = new URL(String(site).trim());
      } catch {
        throw new Error("That isn't a web address.");
      }
      if (url.protocol !== "https:") throw new Error("The dashboard's address must start with https://");
      const html = await (await this.fetch(url.origin + "/")).text();
      const scripts = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => new URL(m[1], url.origin).href);
      let found = null;
      for (const src of scripts) {
        const js = await (await this.fetch(src)).text();
        const client = js.match(/`(https:\/\/[a-z0-9]+\.supabase\.co)`\s*,\s*`((?:sb_publishable_|eyJ)[A-Za-z0-9._-]+)`/) ||
          js.match(/"(https:\/\/[a-z0-9]+\.supabase\.co)"\s*,\s*"((?:sb_publishable_|eyJ)[A-Za-z0-9._-]+)"/);
        const bucket = js.match(/=`([a-z0-9][a-z0-9._-]+)`\)\{return`gs:\/\/\$\{\w+\}\/\$\{\w+\}\/standardized`/);
        if (client) found = { base: client[1], key: client[2], bucket: bucket ? bucket[1] : found && found.bucket };
        if (found && found.bucket) break;
      }
      if (!found) throw new Error("Couldn't find how that dashboard connects to its data. Is it the right address?");
      if (!found.bucket) throw new Error("Couldn't find where that dashboard keeps its session videos.");
      this.cfg = { site: url.origin, base: found.base, key: found.key, bucket: found.bucket };
      this.access = null;
      this.save();
      return this.status();
    }

    requireConfigured() {
      if (!this.status().configured) throw new Error("Connect to the dashboard first.");
    }

    async auth(endpoint, body) {
      this.requireConfigured();
      const res = await this.fetch(`${this.cfg.base}/auth/v1/${endpoint}`, {
        method: "POST",
        headers: { apikey: this.cfg.key, Authorization: `Bearer ${this.cfg.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.msg || j.error_description || j.message || j.error || `Sign-in failed (${res.status})`);
      return j;
    }

    async keep(j, email) {
      if (!j.access_token) throw new Error("The dashboard didn't sign you in.");
      this.access = { token: j.access_token, expires: Date.now() + Math.max(60, (j.expires_in || 3600) - 60) * 1000 };
      if (j.refresh_token) {
        this.refreshMem = j.refresh_token;
        // Kept between runs only encrypted; otherwise sign in again next time.
        if (this.secret) this.cfg.refresh = await this.secret.seal(j.refresh_token);
      }
      if (email) this.cfg.email = email;
      this.save();
      return this.status();
    }

    sendCode(email) {
      return this.auth("otp", { email: String(email).trim(), create_user: false }).then(() => true);
    }
    async verifyCode(email, code) {
      return this.keep(await this.auth("verify", { type: "email", email: String(email).trim(), token: String(code).trim() }), String(email).trim());
    }
    async signInWithPassword(email, password) {
      return this.keep(await this.auth("token?grant_type=password", { email: String(email).trim(), password: String(password) }), String(email).trim());
    }
    // A session the user signed in to on the dashboard's own page: the page keeps it as
    // { access_token, refresh_token, expires_at, user }.
    adoptSession(saved) {
      if (!saved || !saved.access_token || !saved.refresh_token) throw new Error("That sign-in didn't finish.");
      const expiresIn = saved.expires_at ? Math.max(60, saved.expires_at - Math.floor(Date.now() / 1000)) : 3600;
      return this.keep({ access_token: saved.access_token, refresh_token: saved.refresh_token, expires_in: expiresIn }, (saved.user && saved.user.email) || "");
    }

    signOut() {
      this.access = null;
      this.refreshMem = null;
      delete this.cfg.refresh;
      if (this.secret && this.secret.clear) Promise.resolve(this.secret.clear()).catch(() => {});
      this.save();
      return this.status();
    }

    async token() {
      if (this.access && this.access.expires > Date.now()) return this.access.token;
      const refresh = this.refreshMem || (this.cfg.refresh && this.secret ? await this.secret.open(this.cfg.refresh) : null);
      if (!refresh) throw new Error("Sign in to the dashboard first.");
      try {
        await this.keep(await this.auth("token?grant_type=refresh_token", { refresh_token: refresh }));
      } catch (err) {
        this.signOut();
        throw new Error(`Your sign-in has expired; sign in again. (${err.message})`);
      }
      return this.access.token;
    }

    async rest(query) {
      this.requireConfigured();
      const res = await this.fetch(`${this.cfg.base}/rest/v1/${query}`, { headers: { apikey: this.cfg.key, Authorization: `Bearer ${await this.token()}` } });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error((j && (j.message || j.hint)) || `The dashboard said ${res.status}`);
      return j;
    }

    // Sessions with standardized videos (their prep run completed), newest first.
    async sessions({ offset = 0, limit = PAGE_SIZE, search = "" } = {}) {
      const select = [
        "id", "capture_at", "started_at", "duration_seconds", "review_status", "contributor_metadata",
        "program:programs!program_id(name)", "device:devices!device_id(device_type:device_types!device_type_id(display_name))",
        "prep:pipeline_runs!session_id!inner(id)",
      ].join(",");
      const params = new URLSearchParams({
        select,
        "prep.pipeline_type": "eq.prep",
        "prep.status": "eq.completed",
        order: "capture_at.desc.nullslast",
        offset: String(Math.max(0, offset | 0)),
        limit: String(Math.min(200, Math.max(1, limit | 0))),
      });
      const term = String(search || "").replace(/[(),*]/g, " ").trim();
      if (term) {
        const like = `*${term}*`;
        params.set("or", `(contributor_metadata->>operator.ilike.${like},contributor_metadata->>task.ilike.${like},contributor_metadata->>environment.ilike.${like},contributor_metadata->>location.ilike.${like})`);
      }
      const rows = await this.rest(`capture_sessions?${params.toString()}`);
      return rows.map((r) => {
        const c = r.contributor_metadata || {};
        return {
          id: r.id,
          when: r.capture_at || r.started_at,
          duration: r.duration_seconds,
          review: r.review_status,
          program: r.program && r.program.name,
          device: r.device && r.device.device_type && r.device.device_type.display_name,
          operator: c.operator || "",
          venue: c.environment || c.location || "",
          task: c.task || c.instruction || "",
        };
      });
    }

    prefix(sessionId) {
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("That isn't a session id.");
      return `gs://${this.cfg.bucket}/${sessionId}/standardized`;
    }

    // A video of the session (a path from its manifest) as its gs:// path.
    videoPath(sessionId, relPath) {
      const rel = String(relPath).replace(/^\/+/, "");
      if (rel.includes("..") || !/\.(mp4|mov|webm)$/i.test(rel)) throw new Error("That isn't a session video.");
      return `${this.prefix(sessionId)}/${rel}`;
    }

    async sign(sessionId, gsPaths) {
      this.requireConfigured();
      const res = await this.fetch(`${this.cfg.base}/functions/v1/sign-gcs-urls`, {
        method: "POST",
        headers: { apikey: this.cfg.key, Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ paths: gsPaths, sessionId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.error) throw new Error(`Couldn't get the session's files: ${j.error || res.status}`);
      return j.urls || {};
    }

    // The session's cameras: every video stream in its standardized manifest.
    async manifest(sessionId) {
      const gs = `${this.prefix(sessionId)}/manifest.json`;
      const url = (await this.sign(sessionId, [gs]))[gs];
      if (!url) throw new Error("This session has no standardized videos yet.");
      const res = await this.fetch(url);
      if (!res.ok) throw new Error(`Couldn't read the session's manifest (${res.status}).`);
      const m = await res.json();
      const streams = [];
      for (const [position, pos] of Object.entries(m.positions || {})) {
        for (const [stream, s] of Object.entries(pos.streams || {})) {
          if (s.type !== "video" || !s.files || !s.files.video) continue;
          streams.push({
            position,
            stream,
            device: pos.device_type || "",
            path: s.files.video.path,
            bytes: s.files.video.size_bytes || null,
            codec: s.codec,
            fps: s.fps_nominal || s.fps_measured || null,
            frames: s.frame_count || null,
            resolution: s.resolution || null,
            startNs: s.start_ns || null,
            droppedFrames: s.dropped_frames || 0,
          });
        }
      }
      return { sessionId, window: m.session_window || null, clock: m.master_clock || null, streams };
    }
  }

  // ---------- Live Rigs ----------
  const FLEET_HOST_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;
  const FLEET_CAMERA_RE = /^[a-z0-9_]{1,32}$/i;
  // Generations whose previews start on demand; the others only show a picture while their
  // preview is already running (the dashboard's own rule; starting one would change the rig).
  const ON_DEMAND = new Set(["rock5c", "granite"]);

  function fleetRigs(j) {
    const rank = (r) => (r.state === "recording" ? 0 : r.canWatch ? 1 : r.online ? 2 : 3);
    return (j && Array.isArray(j.devices) ? j.devices : [])
      .filter((d) => d && FLEET_HOST_RE.test(d.hostname || ""))
      .map((d) => {
        const roles = (Array.isArray(d.cameras_detail) ? d.cameras_detail : []).map((c) => c && c.role);
        const cameras = [...new Set([...(Array.isArray(d.preview_cameras) ? d.preview_cameras : []), ...roles])].filter((c) => typeof c === "string" && FLEET_CAMERA_RE.test(c));
        const online = !!d.online;
        const recording = d.capture_state === "recording";
        return {
          host: d.hostname,
          name: d.display_name || d.readable_name || d.hostname,
          generation: d.generation || "",
          online,
          state: d.capture_state || (online ? "online" : "offline"),
          recordingS: Number(d.recording_duration_s) || 0,
          session: d.session_name || "",
          cameras,
          // Mirrors the dashboard: a relayed rig has no proxy, and only on-demand previews,
          // ones already running, or a recording's own pictures can be shown without starting
          // anything on the rig.
          canWatch: online && d.reachable !== false && !d.via_relay && cameras.length > 0 && (!!d.preview_active || recording || ON_DEMAND.has(d.generation)),
        };
      })
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }

  // A dashboard address as its origin: https only (http only for this device, for checks).
  function siteOrigin(site, what = "The dashboard's") {
    let url;
    try {
      url = new URL(String(site).trim());
    } catch {
      throw new Error("That isn't a web address.");
    }
    const local = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !local) throw new Error(`${what} address must start with https://`);
    return url.origin;
  }

  return { OpsCore, fleetRigs, siteOrigin, FLEET_HOST_RE, FLEET_CAMERA_RE, PAGE_SIZE };
});
