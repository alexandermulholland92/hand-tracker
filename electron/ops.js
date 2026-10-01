/**
 * ops.js — capture sessions from a capture-operations dashboard (an optional, hidden
 * feature of the Windows, Linux and Android apps; the Android app's is in mobile-bridge.js
 * and RemotePlugin.java): sign in, list recorded sessions, read a session's standardized
 * manifest, and stream its camera videos so every frame can be tracked. The signing in,
 * sessions and manifests are remote-core.js's (OpsCore).
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
 *   const ops = new OpsClient(userDataDir, fetch, safeStorage);
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
const { OpsCore } = require("../remote-core.js");

const SIGN_FOR_MS = 30 * 60 * 1000; // signed links last longer; re-sign well before that
const CHUNK_BYTES = 4 * 1024 * 1024; // video is fetched this much at a time (see serve)
const KEEP_PARTS = 6; // parts of a video kept for the player's next request (see part)

// Signing in, sessions and manifests are remote-core.js's (shared with the Android app);
// this adds keeping the settings in the app's data folder, the refresh token encrypted by
// the operating system, and serving the videos to the page.
class OpsClient extends OpsCore {
  constructor(dataDir, fetchFn, safeStorage = null) {
    const file = path.join(dataDir, "capture-ops.json");
    const safe = safeStorage && safeStorage.isEncryptionAvailable() ? safeStorage : null;
    super({
      fetch: fetchFn,
      config: {
        load: () => {
          try {
            return JSON.parse(fs.readFileSync(file, "utf8"));
          } catch {
            return {};
          }
        },
        save: (cfg) => {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
        },
      },
      secret: safe && {
        seal: (text) => safe.encryptString(text).toString("base64"),
        open: (sealed) => safe.decryptString(Buffer.from(sealed, "base64")),
      },
    });
    this.file = file;
    this.remote = new Map(); // id -> { sessionId, gsPath, url, signedAt }
  }

  // Registers a stream for serve(); returns its id.
  stream(sessionId, relPath) {
    const gsPath = this.videoPath(sessionId, relPath);
    const id = crypto.randomBytes(12).toString("hex");
    this.remote.set(id, { sessionId, gsPath, url: null, signedAt: 0 });
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
