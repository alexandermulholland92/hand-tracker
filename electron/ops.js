/**
 * ops.js — capture sessions from a capture-operations dashboard (an optional, hidden
 * feature of the Windows and Linux app): sign in, list recorded sessions, read a session's
 * standardized manifest, and stream its camera videos so every frame can be tracked.
 *
 * Built for dashboards backed by Supabase that keep each session's standardized output in
 * Google Cloud Storage as <bucket>/<session id>/standardized/manifest.json plus one
 * <position>/<stream>/video.mp4 per camera, handed out as signed links by a
 * "sign-gcs-urls" function. Nothing specific to one dashboard is in the code: its web
 * address is entered once, and its database address, public (publishable) key and bucket
 * are read from the dashboard's own page, then kept in this app's data folder. The sign-in
 * is the user's own: on the dashboard's own sign-in page (in a window of its own, see
 * main.js signInWithSite), or an emailed code or password typed into the app. Only the
 * refresh token is kept, encrypted by the operating system.
 *
 *   const ops = new OpsClient(userDataDir, fetch);
 *   ops.status();                                // { configured, site, signedIn, email }
 *   await ops.configure("https://ops.example.com");
 *   await ops.sendCode(email); await ops.verifyCode(email, code);   // or ops.signInWithPassword
 *   await ops.sessions({ offset, limit, search });
 *   await ops.manifest(sessionId);               // { window, streams: [{ position, stream, path, ... }] }
 *   const id = ops.stream(sessionId, path);      // then serve() answers app://…/__ops/<id>
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SIGN_FOR_MS = 30 * 60 * 1000; // signed links last longer; re-sign well before that
const PAGE_SIZE = 50;
const CHUNK_BYTES = 4 * 1024 * 1024; // video is fetched this much at a time (see serve)
const KEEP_PARTS = 6; // parts of a video kept for the player's next request (see part)

class OpsClient {
  constructor(dataDir, fetchFn, safeStorage = null) {
    this.file = path.join(dataDir, "capture-ops.json");
    this.fetch = fetchFn;
    this.safe = safeStorage && safeStorage.isEncryptionAvailable() ? safeStorage : null;
    this.cfg = this.read();
    this.access = null; // { token, expires }
    this.refreshMem = null; // the refresh token, when the OS can't encrypt it for keeping
    this.remote = new Map(); // id -> { sessionId, gsPath, url, signedAt }
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
    const signedIn = !!(this.access || this.refreshMem || (this.cfg.refresh && this.safe));
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

  keep(j, email) {
    if (!j.access_token) throw new Error("The dashboard didn't sign you in.");
    this.access = { token: j.access_token, expires: Date.now() + Math.max(60, (j.expires_in || 3600) - 60) * 1000 };
    if (j.refresh_token) {
      this.refreshMem = j.refresh_token;
      // Kept between runs only encrypted by the operating system; otherwise sign in again.
      if (this.safe) this.cfg.refresh = this.safe.encryptString(j.refresh_token).toString("base64");
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
  // A session the user signed in to on the dashboard's own page (see main.js signInWithSite):
  // the page keeps it as { access_token, refresh_token, expires_at, user }.
  adoptSession(saved) {
    if (!saved || !saved.access_token || !saved.refresh_token) throw new Error("That sign-in didn't finish.");
    const expiresIn = saved.expires_at ? Math.max(60, saved.expires_at - Math.floor(Date.now() / 1000)) : 3600;
    return this.keep({ access_token: saved.access_token, refresh_token: saved.refresh_token, expires_in: expiresIn }, (saved.user && saved.user.email) || "");
  }

  signOut() {
    this.access = null;
    this.refreshMem = null;
    delete this.cfg.refresh;
    this.save();
    return this.status();
  }

  async token() {
    if (this.access && this.access.expires > Date.now()) return this.access.token;
    const refresh = this.refreshMem || (this.cfg.refresh && this.safe ? this.safe.decryptString(Buffer.from(this.cfg.refresh, "base64")) : null);
    if (!refresh) throw new Error("Sign in to the dashboard first.");
    try {
      this.keep(await this.auth("token?grant_type=refresh_token", { refresh_token: refresh }));
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

  // Registers a stream for serve(); returns its id.
  stream(sessionId, relPath) {
    const rel = String(relPath).replace(/^\/+/, "");
    if (rel.includes("..") || !/\.(mp4|mov|webm)$/i.test(rel)) throw new Error("That isn't a session video.");
    const id = crypto.randomBytes(12).toString("hex");
    this.remote.set(id, { sessionId, gsPath: `${this.prefix(sessionId)}/${rel}`, url: null, signedAt: 0 });
    return id;
  }

  // Answers the page's request for a registered stream from the signed link. The video
  // player asks for "byte N to the end" and drops the answer once it has read enough, again
  // and again as it plays. Passing the whole rest of a large file straight through left
  // those downloads open (nothing stopped them) until the connection stalled, and playback
  // stopped a few seconds in. So the answer is still "byte N to the end", but it's made of
  // parts of CHUNK_BYTES, each fetched in full and only as the player reads on (plus one
  // ahead): a dropped answer stops costing anything. The last few parts are kept, since the
  // player's next request usually starts inside one it has just had.
  async serve(request, id) {
    const r = this.remote.get(id);
    if (!r) return new Response("Not found", { status: 404 });
    const m = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("Range") || "bytes=0-");
    if (!m) return new Response("Only byte ranges are served", { status: 416 });
    const start = Number(m[1]);
    let k = Math.floor(start / CHUNK_BYTES);
    let first;
    try {
      first = await this.part(r, k);
    } catch (err) {
      return new Response(String(err.message || err), { status: 502 });
    }
    if (first.status !== 206 || !first.total) return new Response(first.bytes, { status: first.status });
    if (start >= first.total) return new Response("", { status: 416, headers: { "content-range": `bytes */${first.total}` } });
    const last = Math.min(m[2] ? Number(m[2]) : Infinity, first.total - 1);
    const lastPart = Math.floor(last / CHUNK_BYTES);
    const slice = (p, index) => p.bytes.subarray(Math.max(0, start - index * CHUNK_BYTES), last + 1 - index * CHUNK_BYTES);
    const ahead = (index) => index <= lastPart && this.part(r, index).catch(() => {});
    ahead(k + 1);
    const body = new ReadableStream(
      {
        start(controller) {
          controller.enqueue(slice(first, k));
          if (k >= lastPart) controller.close();
        },
        pull: async (controller) => {
          k++;
          const p = await this.part(r, k);
          if (!p.bytes.length) throw new Error("The video ended early");
          ahead(k + 1);
          controller.enqueue(slice(p, k));
          if (k >= lastPart) controller.close();
        },
      },
      { highWaterMark: 1 }
    );
    return new Response(body, {
      status: 206,
      headers: {
        "content-type": first.type || "video/mp4",
        "content-range": `bytes ${start}-${last}/${first.total}`,
        "content-length": String(last - start + 1),
        "accept-ranges": "bytes",
      },
    });
  }

  // Part `index` of a registered stream (CHUNK_BYTES from index * CHUNK_BYTES), fetched once
  // and kept among the last KEEP_PARTS used: { status, bytes, total, type }.
  part(r, index) {
    if (!r.parts) r.parts = new Map();
    let p = r.parts.get(index);
    if (p) {
      r.parts.delete(index); // most recently used last
      r.parts.set(index, p);
      return p;
    }
    p = (async () => {
      const get = async (fresh) => {
        if (fresh || !r.url || Date.now() - r.signedAt > SIGN_FOR_MS) {
          r.url = (await this.sign(r.sessionId, [r.gsPath]))[r.gsPath];
          r.signedAt = Date.now();
        }
        return this.fetch(r.url, { headers: { Range: `bytes=${index * CHUNK_BYTES}-${(index + 1) * CHUNK_BYTES - 1}` } });
      };
      let res = await get(false);
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        await res.arrayBuffer().catch(() => {});
        res = await get(true);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const total = Number((/\/(\d+)$/.exec(res.headers.get("content-range") || "") || [])[1]);
      if (res.status !== 206) r.parts.delete(index); // not kept: an error, or a server without ranges
      return { status: res.status, bytes, total, type: res.headers.get("content-type") || "" };
    })();
    p.catch(() => r.parts.delete(index));
    r.parts.set(index, p);
    while (r.parts.size > KEEP_PARTS) r.parts.delete(r.parts.keys().next().value);
    return p;
  }

  forget(id) {
    this.remote.delete(id);
  }
}

module.exports = { OpsClient };
