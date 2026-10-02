/**
 * mobile-bridge.js
 * Android support (Capacitor). When the page runs inside the Android app this
 * defines window.mobile with the same saveFiles() shape as the desktop bridge
 * (electron/preload.js), writing into Documents/Hand Tracker on the phone, plus
 * share() to hand a saved file to another app (Photos, Drive, email…).
 * In a browser or the desktop app it does nothing.
 *
 *   await mobile.saveFiles({ baseName, files: [{ format, suffix, ext, data: string | Uint8Array | Blob }] })
 *     -> { dir, results: [{ format, ok, path (file URI), size, error? }] }
 *   await mobile.share(path)
 */

(function (global) {
  const cap = global.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;

  // A plugin, as the app's own bridge has it: Capacitor.Plugins.<name> (registerPlugin belongs
  // to the @capacitor/core package, which this app doesn't load; on a phone it isn't there).
  const plugin = (name) => (typeof cap.registerPlugin === "function" ? cap.registerPlugin(name) : cap.Plugins && cap.Plugins[name]);
  const Filesystem = plugin("Filesystem");
  const Share = plugin("Share");
  const DIRECTORY = "DOCUMENTS"; // public Documents folder; Android 11+ lets apps write files they create there
  const FOLDER = "Hand Tracker";
  const CHUNK_BYTES = 3 * 1024 * 1024; // binary data crosses the bridge as base64, a few MB at a time (mobile.chunkBytes)

  // Same rules as the desktop exporter: no path characters, no reserved names.
  function sanitize(name) {
    let base = String(name || "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/^[\s.]+|[\s.]+$/g, "")
      .slice(0, 120);
    if (!base) base = "hand-tracker";
    return base;
  }

  async function exists(path) {
    try {
      await Filesystem.stat({ path, directory: DIRECTORY });
      return true;
    } catch {
      return false;
    }
  }

  // Never overwrite: "clip.mp4" -> "clip (1).mp4" -> ...
  async function uniquePath(base, ext) {
    let candidate = `${FOLDER}/${base}.${ext}`;
    for (let n = 1; await exists(candidate); n++) candidate = `${FOLDER}/${base} (${n}).${ext}`;
    return candidate;
  }

  function toBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function writeFile(path, data) {
    if (typeof data === "string") {
      await Filesystem.writeFile({ path, directory: DIRECTORY, data, encoding: "utf8", recursive: true });
      return new Blob([data]).size;
    }
    // Chunked so a long video never has to become one giant base64 string. A Blob (an
    // uncompressed video, made in parts) is read a chunk at a time, never all at once.
    const blob = data instanceof Blob ? data : null;
    const bytes = blob ? null : data instanceof Uint8Array ? data : new Uint8Array(data);
    const size = blob ? blob.size : bytes.length;
    const chunk = api.chunkBytes;
    for (let i = 0; i === 0 || i < size; i += chunk) {
      const piece = blob ? new Uint8Array(await blob.slice(i, i + chunk).arrayBuffer()) : bytes.subarray(i, i + chunk);
      const part = toBase64(piece);
      if (i === 0) await Filesystem.writeFile({ path, directory: DIRECTORY, data: part, recursive: true });
      else await Filesystem.appendFile({ path, directory: DIRECTORY, data: part });
    }
    return size;
  }

  async function saveFiles({ baseName, files }) {
    const base = sanitize(baseName);
    const results = [];
    for (const file of files) {
      try {
        const path = await uniquePath(base + (file.suffix || ""), file.ext);
        const size = await writeFile(path, file.data);
        const { uri } = await Filesystem.getUri({ path, directory: DIRECTORY });
        results.push({ format: file.format, ok: true, path: uri, size });
      } catch (err) {
        results.push({ format: file.format, ok: false, error: (err && err.message) || String(err) });
      }
    }
    return { dir: `Documents/${FOLDER}`, results };
  }

  async function share(uri) {
    await Share.share({ files: [uri] });
  }

  const fromBase64 = (b64) => {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  };

  // OptiTrack Motive's live stream, like the desktop app's desktop.natnet: the NatNet
  // plugin (NatNetPlugin.java) has the sockets, natnet-parse.js speaks the protocol.
  function createNatNet() {
    const P = global.NatNetParse;
    if (!P) return null;
    const NatNet = plugin("NatNet");
    const statusListeners = new Set(), frameListeners = new Set();
    const emit = (set, value) => {
      for (const cb of set) {
        try {
          cb(value);
        } catch (err) {
          console.error(err);
        }
      }
    };
    let session = null, timer = null, packets = null;

    async function stop() {
      clearInterval(timer);
      timer = null;
      const sub = packets;
      packets = null;
      if (sub) (await sub).remove();
      await NatNet.stop().catch(() => {});
      const was = session;
      session = null;
      if (was) emit(statusListeners, { ...was.lastStatus, state: "stopped" });
      return true;
    }

    async function start(opts = {}) {
      await stop();
      const server = String(opts.server || "127.0.0.1").trim();
      if (!/^[\w.-]+$/.test(server)) throw new Error("That isn't a valid address for Motive's PC.");
      const multicast = opts.multicast !== false;
      const s = new P.Session({
        server, multicast,
        send: (bytes) => NatNet.send({ data: toBase64(bytes) }).catch(() => {}),
        onStatus: (st) => emit(statusListeners, st),
        onFrame: (f) => emit(frameListeners, P.compactFrame(f)),
        onWarning: (warning) => emit(statusListeners, { ...s.lastStatus, warning }),
      });
      session = s;
      s.status({ state: "waiting" });
      packets = NatNet.addListener("packet", ({ data }) => {
        if (session === s) s.handle(fromBase64(data));
      });
      try {
        await NatNet.start({ server, multicast });
      } catch (err) {
        if (session === s) s.status({ state: "stopped", error: (err && err.message) || String(err) });
        return true;
      }
      if (session !== s) return true;
      s.hello();
      timer = setInterval(() => s.hello(), 1000);
      return true;
    }

    async function recordStart() {
      await NatNet.recordStart();
      return true;
    }

    // Every frame since recordStart, read back from the plugin a few MB at a time.
    async function recordStop() {
      const { bytes } = await NatNet.recordStop();
      const all = new Uint8Array(bytes || 0);
      let got = 0;
      while (got < all.length) {
        const { data } = await NatNet.recordRead({ offset: got, length: api.chunkBytes });
        const part = fromBase64(data || "");
        if (!part.length) break;
        all.set(part.subarray(0, all.length - got), got);
        got += part.length;
      }
      const frames = [];
      const dv = new DataView(all.buffer);
      for (let o = 0; session && o + 4 <= got; ) {
        const n = dv.getUint32(o, true);
        const packet = all.subarray(o + 4, o + 4 + n);
        o += 4 + n;
        try {
          frames.push(P.compactFrame(session.readFrame(packet)));
        } catch {
          // a packet this client can't read: already said so live
        }
      }
      return frames;
    }

    return {
      start, stop, recordStart, recordStop,
      onStatus: (cb) => (statusListeners.add(cb), () => statusListeners.delete(cb)),
      onFrame: (cb) => (frameListeners.add(cb), () => frameListeners.delete(cb)),
    };
  }

  // Capture Sessions and Live Rigs (hidden features), like the desktop app's desktop.ops and
  // desktop.fleet: remote-core.js has the logic, the Remote plugin (RemotePlugin.java) makes
  // the web requests (from the app, so no CORS), keeps the sign-in in the Android Keystore,
  // and answers the page's /__ops/<id> (session videos) and /__fleet/<rig>/<camera>.
  function createRemote() {
    const Core = global.RemoteCore;
    if (!Core) return {};
    const Remote = plugin("Remote");
    // A fetch-like request; with cookies, the WebView's (a sign-in on the dashboard's page).
    const request = async (url, init = {}, { cookies = false, followRedirects = true } = {}) => {
      const r = await Remote.request({
        url, method: init.method || "GET", headers: init.headers || {}, body: init.body == null ? undefined : String(init.body), cookies, followRedirects,
      });
      const headers = r.headers || {};
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: { get: (k) => (headers[String(k).toLowerCase()] === undefined ? null : headers[String(k).toLowerCase()]) },
        text: async () => r.body || "",
        json: async () => JSON.parse(r.body || "null"),
      };
    };
    const stored = (key) => ({
      load: () => {
        try {
          return JSON.parse(localStorage.getItem(key)) || {};
        } catch {
          return {};
        }
      },
      save: (value) => {
        try {
          localStorage.setItem(key, JSON.stringify(value));
        } catch {
          // storage full or blocked: kept for this run only
        }
      },
    });

    // ---------- Capture Sessions ----------
    const core = new Core.OpsCore({
      fetch: request,
      config: stored("hand-tracker-capture-ops"),
      secret: {
        seal: async (text) => {
          await Remote.secretSet({ key: "ops-refresh", value: text });
          return "keystore";
        },
        open: async () => (await Remote.secretGet({ key: "ops-refresh" })).value || null,
        clear: () => Remote.secretRemove({ key: "ops-refresh" }),
      },
    });
    const streams = new Map(); // id -> { sessionId, gsPath }
    // A video's signed link ran out while it played: sign a new one.
    Remote.addListener("streamExpired", async ({ id }) => {
      const s = streams.get(id);
      if (!s) return;
      try {
        const url = (await core.sign(s.sessionId, [s.gsPath]))[s.gsPath];
        if (url) await Remote.streamRegister({ id, url });
      } catch {
        // the player gets an error for that part
      }
    });
    const randomId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const ops = {
      status: async () => core.status(),
      configure: (site) => core.configure(site),
      sendCode: (email) => core.sendCode(email),
      verifyCode: (email, code) => core.verifyCode(email, code),
      signInWithPassword: (email, password) => core.signInWithPassword(email, password),
      signOut: async () => core.signOut(),
      // The dashboard's own sign-in page, in a window of its own; then the session it keeps.
      signInWithSite: async () => {
        const site = core.status().site;
        if (!site) throw new Error("Connect to the dashboard first.");
        const { session } = await Remote.signIn({ url: `${site}/`, mode: "supabase" });
        return core.adoptSession(JSON.parse(session || "null"));
      },
      sessions: (query) => core.sessions(query || {}),
      manifest: (sessionId) => core.manifest(String(sessionId)),
      stream: async (sessionId, path) => {
        const gsPath = core.videoPath(String(sessionId), String(path));
        const url = (await core.sign(String(sessionId), [gsPath]))[gsPath];
        if (!url) throw new Error("Couldn't get that video.");
        const id = randomId();
        streams.set(id, { sessionId: String(sessionId), gsPath });
        await Remote.streamRegister({ id, url });
        return { url: `/__ops/${id}` };
      },
      forget: async (url) => {
        const id = String(url || "").split("/__ops/")[1];
        if (!id) return;
        streams.delete(id);
        await Remote.streamForget({ id }).catch(() => {});
      },
    };

    // ---------- Live Rigs ----------
    const fleetCfg = stored("hand-tracker-capture-fleet");
    let fleetSite = fleetCfg.load().site || "";
    let fleetSignedIn = false;
    if (fleetSite) Remote.fleetConfigure({ site: fleetSite }).catch(() => {});
    const fleetState = () => ({ configured: !!fleetSite, site: fleetSite, signedIn: fleetSignedIn });
    // The dashboard's rig list, or null when it doesn't answer as signed in.
    const fleetStatus = async () => {
      if (!fleetSite) throw new Error("Enter the fleet dashboard's address first.");
      const res = await request(`${fleetSite}/api/fleet/status`, { headers: { "Cache-Control": "no-store" } }, { cookies: true, followRedirects: false });
      const type = res.headers.get("content-type") || "";
      const j = res.ok && type.includes("json") ? await res.json().catch(() => null) : null;
      fleetSignedIn = !!(j && Array.isArray(j.devices));
      return fleetSignedIn ? j : null;
    };
    const fleet = {
      status: async () => {
        if (fleetSite) await fleetStatus().catch(() => (fleetSignedIn = false));
        return fleetState();
      },
      configure: async (site) => {
        fleetSite = Core.siteOrigin(site);
        fleetSignedIn = false;
        fleetCfg.save({ site: fleetSite });
        await Remote.fleetConfigure({ site: fleetSite });
        return fleetState();
      },
      signIn: async () => {
        if (!fleetSite) throw new Error("Enter the fleet dashboard's address first.");
        await Remote.signIn({ url: `${fleetSite}/login`, mode: "cookie", checkUrl: `${fleetSite}/api/fleet/status` });
        await fleetStatus().catch(() => {});
        return fleetState();
      },
      signOut: async () => {
        await Remote.clearCookies();
        fleetSignedIn = false;
        return fleetState();
      },
      rigs: async () => {
        const j = await fleetStatus();
        if (!j) throw new Error("Sign in to the fleet dashboard first.");
        return Core.fleetRigs(j);
      },
    };
    return { ops, fleet };
  }

  // Controlling a PC over Wi-Fi (the desktop app's electron/phone-link.js): mobile.link pairs
  // with the PC from the code it shows (the key is kept in the Android Keystore) and keeps the
  // connection; mobile.pc has the same calls as the desktop app's desktop.pc (hand mouse,
  // keyboard, gesture actions), carried out on that PC. Messages go by UDP (UdpPlugin.java),
  // signed as phone-link-protocol.js says.
  function createLink() {
    const L = global.PhoneLinkProtocol;
    if (!L) return {};
    const Udp = plugin("Udp");
    const Remote = plugin("Remote");
    const STORE = "hand-tracker-pc-link"; // { port, addresses, name }; the key is in the Keystore
    const statusListeners = new Set(), keyboardListeners = new Set(), toggleListeners = new Set();
    const state = { paired: false, connected: false, pc: "", address: "", error: "" };
    const set = (patch) => {
      Object.assign(state, patch);
      for (const cb of statusListeners) cb({ ...state });
    };
    let pairing = null; // { port, key, addresses, name }
    let peer = null; // { host, session, name }
    let seq = 1;
    let socket = null;
    let connecting = null;
    const pending = new Map(); // seq -> { resolve, reject, timer, tries }

    const save = () => {
      try {
        localStorage.setItem(STORE, JSON.stringify({ port: pairing.port, addresses: pairing.addresses, name: pairing.name || "" }));
      } catch {
        // kept for this run only
      }
    };
    const ready = (async () => {
      try {
        const saved = JSON.parse(localStorage.getItem(STORE) || "null");
        const key = saved && (await Remote.secretGet({ key: "pc-link" })).value;
        if (saved && key) {
          pairing = { ...saved, key };
          set({ paired: true, pc: saved.name || "", address: saved.addresses[0] });
        }
      } catch {
        // nothing paired
      }
    })();

    async function onPacket({ data, host }) {
      if (!pairing) return;
      const msg = await L.decode(pairing.key, fromBase64(data));
      if (!msg || msg.type !== "ack" || !pending.has(msg.seq)) return;
      const p = pending.get(msg.seq);
      pending.delete(msg.seq);
      clearTimeout(p.timer);
      p.resolve({ ...msg.data, host });
    }
    function open() {
      if (!socket) {
        socket = Udp.open().then(() => Udp.addListener("packet", (ev) => onPacket(ev).catch(() => {})));
        socket.catch(() => (socket = null));
      }
      return socket;
    }
    const encode = async (type, data, session) => {
      const s = seq++;
      return { s, data: toBase64(await L.encode(pairing.key, { session: session || L.NO_SESSION, seq: s, type, data })) };
    };
    // An answered message: sent (to each address) every 200 ms until it's answered, 2 s at most.
    async function request(type, data, hosts, session) {
      const msg = await encode(type, data, session);
      return new Promise((resolve, reject) => {
        const p = { resolve, reject, tries: 0 };
        const again = () => {
          if (++p.tries > 10) {
            pending.delete(msg.s);
            reject(new Error("The PC didn't answer"));
            return;
          }
          for (const host of hosts) Udp.send({ data: msg.data, host, port: pairing.port }).catch(() => {});
          p.timer = setTimeout(again, 200);
        };
        pending.set(msg.s, p);
        again();
      });
    }

    const deviceName = () => (/Android [^;]+; ([^;)]+)/.exec(navigator.userAgent) || [])[1] || "Android phone";
    function connect() {
      if (peer) return Promise.resolve(peer);
      if (!connecting) {
        connecting = (async () => {
          await ready;
          if (!pairing) throw new Error("Connect to a PC first: on the PC, open Control your PC and turn on Let a phone control this PC, then scan its code here.");
          await open();
          // (One id for this attempt: its hello is sent to every address, and again until answered.)
          const id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
          const a = await request("hello", { name: deviceName(), id }, pairing.addresses).catch(() => {
            throw new Error(`The PC didn't answer at ${pairing.addresses.join(" or ")}. Is Let a phone control this PC on, and is this phone on the same Wi-Fi?`);
          });
          peer = { host: a.host, session: a.session, name: a.name || "" };
          // The address that answered first next time.
          pairing.addresses = [a.host, ...pairing.addresses.filter((x) => x !== a.host)];
          pairing.name = peer.name || pairing.name;
          save();
          set({ connected: true, pc: pairing.name, address: a.host, error: "" });
          return peer;
        })()
          .catch((err) => {
            set({ connected: false, error: err.message });
            throw err;
          })
          .finally(() => (connecting = null));
      }
      return connecting;
    }
    // Answered calls. When the PC stops answering (its link restarted: a new session) this
    // connects again once.
    async function call(type, data) {
      for (let attempt = 0; ; attempt++) {
        const p = await connect();
        try {
          const r = await request(type, data, [p.host], p.session);
          if (!r.ok) throw Object.assign(new Error(r.error || "The PC couldn't do that"), { fromPc: true });
          return r.result;
        } catch (err) {
          if (err.fromPc || attempt > 0) throw err;
          peer = null;
          set({ connected: false });
        }
      }
    }
    // Pointer moves: sent and forgotten (the next one replaces it).
    function move(data) {
      const p = peer;
      if (!p) return void connect().catch(() => {});
      encode("pointer", data, p.session).then((m) => Udp.send({ data: m.data, host: p.host, port: pairing.port })).catch(() => {});
    }
    // Still there? A PC that stops answering is shown as disconnected.
    setInterval(() => {
      const p = peer;
      if (p && !connecting) {
        request("ping", {}, [p.host], p.session).catch(() => {
          if (peer === p) peer = null;
          set({ connected: false, error: "The PC stopped answering." });
        });
      }
    }, 3000);

    const link = {
      status: async () => {
        await ready;
        return { ...state };
      },
      // The text in the PC's QR code (or typed in): pairs, then connects.
      pair: async (text) => {
        const p = L.parsePairing(text);
        await Remote.secretSet({ key: "pc-link", value: p.key });
        pairing = { ...p, name: "" };
        peer = null;
        save();
        set({ paired: true, connected: false, pc: "", address: p.addresses[0], error: "" });
        await connect();
        return { ...state };
      },
      connect: () => connect().then(() => ({ ...state })),
      forget: async () => {
        const p = peer;
        if (p) request("bye", {}, [p.host], p.session).catch(() => {});
        peer = null;
        pairing = null;
        try {
          localStorage.removeItem(STORE);
        } catch {
          // nothing kept
        }
        await Remote.secretRemove({ key: "pc-link" }).catch(() => {});
        set({ paired: false, connected: false, pc: "", address: "", error: "" });
      },
      onStatus: (cb) => (statusListeners.add(cb), () => statusListeners.delete(cb)),
    };

    const pc = {
      start: () => connect().then(() => true),
      pointer: (nx, ny, screen) => move({ nx, ny, screen }),
      button: (which, action) => call("button", { which, action }),
      wheel: (notches) => call("wheel", { notches }),
      key: (combo, action) => call("key", { combo, action }),
      text: (text) => call("text", { text }),
      // A gesture action's web request: from the phone itself (no browser cross-site limits).
      web: async ({ url, method = "GET", body = null } = {}) => {
        let target;
        try {
          target = new URL(String(url));
        } catch {
          throw new Error("That isn't a web address.");
        }
        if (!/^https?:$/.test(target.protocol)) throw new Error("Only http:// and https:// addresses can be called.");
        const m = String(method).toUpperCase();
        if (!["GET", "POST", "PUT"].includes(m)) throw new Error("Unknown request method.");
        const withBody = body !== null && m !== "GET";
        const r = await Remote.request({ url: target.href, method: m, headers: withBody ? { "Content-Type": "application/json" } : {}, body: withBody ? JSON.stringify(body) : undefined });
        return { ok: r.status >= 200 && r.status < 300, status: r.status };
      },
      // The PC's floating keyboard (its keys clicked with the hand mouse).
      setKeyboard: async (show) => {
        const r = await call("keyboard", { show: !!show });
        const shown = !!(r && r.shown);
        for (const cb of keyboardListeners) cb(shown);
        return shown;
      },
      status: () => {},
      onStatus: () => () => {},
      toggleMouse: () => toggleListeners.forEach((cb) => cb()),
      onToggleMouse: (cb) => (toggleListeners.add(cb), () => toggleListeners.delete(cb)),
      onKeyboard: (cb) => (keyboardListeners.add(cb), () => keyboardListeners.delete(cb)),
    };
    return { link, pc };
  }

  // Controlling the phone itself with your hand (PhoneControlPlugin.java): the pointer over
  // every app and the hand mouse's taps, swipes and keys, while Hand Tracker is in the background.
  function createPhoneControl() {
    const PhoneControl = plugin("PhoneControl");
    const stopped = new Set();
    PhoneControl.addListener("stopped", () => stopped.forEach((cb) => cb()));
    return {
      status: () => PhoneControl.status(),
      openOverlaySettings: () => PhoneControl.openOverlaySettings(),
      openAccessibilitySettings: () => PhoneControl.openAccessibilitySettings(),
      start: (settings) => PhoneControl.start({ settings: JSON.stringify(settings || {}) }),
      stop: () => PhoneControl.stop(),
      onStopped: (cb) => (stopped.add(cb), () => stopped.delete(cb)),
    };
  }

  // Remote recording on the phone itself (the desktop app's desktop.remote, same shape): while
  // it's on, the PC's Hand Tracker (or any browser) starts and stops motion capture with this
  // phone's camera. The RigServer plugin (RigServerPlugin.java) is the web server; its key is
  // kept in the Android Keystore; remote-record-ui.js carries out what it's asked.
  function createRigServer() {
    const Rig = plugin("RigServer");
    const Remote = plugin("Remote");
    if (!Rig || !Remote) return null;
    const listeners = { status: new Set(), wantPreviews: new Set(), command: new Set() };
    for (const name of Object.keys(listeners)) {
      Rig.addListener(name, (data) => {
        for (const cb of listeners[name]) {
          try {
            cb(data);
          } catch (err) {
            console.error(err);
          }
        }
      });
    }
    const on = (name) => (cb) => (listeners[name].add(cb), () => listeners[name].delete(cb));
    const newKey = () => toBase64(crypto.getRandomValues(new Uint8Array(16))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    async function key(fresh) {
      let k = fresh ? null : (await Remote.secretGet({ key: "remote-rig" }).catch(() => ({}))).value;
      if (!k) {
        k = newKey();
        await Remote.secretSet({ key: "remote-rig", value: k });
      }
      return k;
    }
    const bytes64 = (b) => toBase64(b instanceof Uint8Array ? b : new Uint8Array(b));
    return {
      status: () => Rig.status(),
      start: async () => Rig.start({ key: await key(false) }),
      stop: () => Rig.stop(),
      newKey: async () => Rig.setKey({ key: await key(true) }),
      settings: async () => ({ standby: false, phone: true, folder: `Documents/${FOLDER}`, autostart: { available: false, on: false } }),
      setAutostart: async () => false,
      chooseFolder: async () => `Documents/${FOLDER}`,
      saveTake: ({ baseName, files }) => saveFiles({ baseName, files }),
      onStatus: on("status"),
      setState: (state) => Rig.setState({ state: JSON.stringify(state) }).catch(() => {}),
      sendPreviews: (list) => {
        for (const p of list) Rig.setPreview({ i: p.i, jpeg: bytes64(p.jpeg) }).catch(() => {});
      },
      onWantPreviews: on("wantPreviews"),
      onCommand: on("command"),
      result: (id, result) => Rig.result({ id, result: JSON.stringify(result || {}) }).catch(() => {}),
    };
  }

  const api = { platform: cap.getPlatform(), saveFiles, share, chunkBytes: CHUNK_BYTES };
  api.remote = createRigServer();
  api.natnet = createNatNet();
  Object.assign(api, createRemote(), createLink());
  api.phoneControl = createPhoneControl();
  // Saving many results "into one folder" (the desktop app's chooseFolder / saveFilesTo):
  // on the phone that's always Documents/Hand Tracker.
  api.chooseFolder = async () => ({ token: "documents", dir: `Documents/${FOLDER}` });
  api.saveFilesTo = (token, job) => saveFiles(job);
  global.mobile = api;
})(window);
