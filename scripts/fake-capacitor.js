/**
 * fake-capacitor.js — preload for check-android.js. Stands in for Capacitor's
 * native bridge so the Android code paths (mobile-bridge.js and app.js) can run
 * in desktop Chromium: an in-memory Filesystem plugin and a Share plugin that
 * behave like the real ones' JavaScript API, recording every call.
 */

(function () {
  const files = new Map(); // "Hand Tracker/name.ext" -> Uint8Array
  const calls = [];
  const shared = [];
  const ROOT_URI = "file:///storage/emulated/0/Documents/";

  const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const decode = (data, encoding) => (encoding === "utf8" ? new TextEncoder().encode(data) : fromBase64(data));
  const uriFor = (path) => ROOT_URI + path.split("/").map(encodeURIComponent).join("/");
  const checkDir = (directory) => {
    if (directory !== "DOCUMENTS") throw new Error(`unexpected directory ${directory}`);
  };

  const Filesystem = {
    async stat({ path, directory }) {
      checkDir(directory);
      calls.push(["stat", path]);
      if (!files.has(path)) throw new Error("File does not exist");
      return { type: "file", size: files.get(path).length, uri: uriFor(path) };
    },
    async writeFile({ path, directory, data, encoding, recursive }) {
      checkDir(directory);
      calls.push(["writeFile", path, encoding || "base64", !!recursive]);
      if (!recursive && path.includes("/")) throw new Error("Parent folder doesn't exist");
      files.set(path, decode(data, encoding));
      return { uri: uriFor(path) };
    },
    async appendFile({ path, directory, data, encoding }) {
      checkDir(directory);
      calls.push(["appendFile", path, encoding || "base64"]);
      const prev = files.get(path) || new Uint8Array(0);
      const add = decode(data, encoding);
      const next = new Uint8Array(prev.length + add.length);
      next.set(prev);
      next.set(add, prev.length);
      files.set(path, next);
    },
    async getUri({ path, directory }) {
      checkDir(directory);
      return { uri: uriFor(path) };
    },
  };
  const Share = {
    async share(options) {
      shared.push(options);
      return {};
    },
  };

  // A plugin's listeners: addListener(event, cb) -> Promise<{ remove }>, as Capacitor's.
  const events = () => {
    const map = new Map();
    return {
      addListener(event, cb) {
        if (!map.has(event)) map.set(event, new Set());
        map.get(event).add(cb);
        return Promise.resolve({ remove: async () => map.get(event).delete(cb) });
      },
      emit(event, value) {
        for (const cb of map.get(event) || []) cb(value);
      },
    };
  };

  // NatNet (NatNetPlugin.java): real UDP sockets (Node's, in this preload), the same rules:
  // every packet but frames, which come at most 30 a second; every frame kept while recording.
  const NatNet = (() => {
    const dgram = require("dgram");
    const ev = events();
    let sockets = [], server = null, commandPort = 1510, lastFrame = 0, recording = null, finished = Buffer.alloc(0), count = 0;
    const handle = (msg) => {
      if (msg.length < 4) return;
      if (msg.readUInt16LE(0) === 7) {
        if (recording) {
          const head = Buffer.alloc(4);
          head.writeUInt32LE(msg.length);
          recording.push(head, Buffer.from(msg));
          count++;
        }
        const now = Date.now();
        if (now - lastFrame < 33) return;
        lastFrame = now;
      }
      ev.emit("packet", { data: msg.toString("base64") });
    };
    const stop = async () => {
      for (const s of sockets) {
        try {
          s.close();
        } catch {
          // closed
        }
      }
      sockets = [];
    };
    return {
      addListener: ev.addListener,
      async start({ server: host, multicast = true, multicastAddress = "239.255.42.99", commandPort: cp = 1510, dataPort = 1511 }) {
        await stop();
        calls.push(["natnet.start", host, multicast]);
        server = host;
        commandPort = cp;
        const cmd = dgram.createSocket({ type: "udp4", reuseAddr: true });
        sockets.push(cmd);
        cmd.on("message", handle);
        await new Promise((r) => cmd.bind(0, r));
        if (multicast) {
          const data = dgram.createSocket({ type: "udp4", reuseAddr: true });
          sockets.push(data);
          data.on("message", handle);
          await new Promise((r) => data.bind(dataPort, r));
          data.addMembership(multicastAddress, "127.0.0.1");
        }
        return { port: cmd.address().port };
      },
      async send({ data }) {
        if (!sockets[0]) throw new Error("Not started");
        sockets[0].send(Buffer.from(data, "base64"), commandPort, server);
      },
      stop,
      async recordStart() {
        recording = [];
        count = 0;
      },
      async recordStop() {
        finished = Buffer.concat(recording || []);
        recording = null;
        return { count, bytes: finished.length, full: false };
      },
      async recordRead({ offset = 0, length = 3 << 20 }) {
        calls.push(["natnet.recordRead", offset, length]);
        return { data: finished.subarray(offset, offset + length).toString("base64") };
      },
    };
  })();

  // Remote (RemotePlugin.java): web requests with a cookie jar (the WebView's, on a phone),
  // a sign-in "window" that loads the page (the stand-in dashboards sign in by themselves),
  // secrets in memory, and /__fleet/ pictures served by check-android.js's app:// handler
  // (it's told the site and the cookie, as the plugin's own handler knows them).
  const Remote = (() => {
    const http = require("http"), https = require("https");
    const { ipcRenderer } = require("electron");
    const ev = events();
    const jar = new Map(); // origin -> Map(name -> value)
    const secrets = new Map();
    let fleetSite = null;
    const cookieFor = (url) => [...(jar.get(new URL(url).origin) || new Map())].map(([k, v]) => `${k}=${v}`).join("; ");
    const tellFleet = () => ipcRenderer.send("fake-remote:fleet", { site: fleetSite, cookie: fleetSite ? cookieFor(fleetSite) : "" });
    const request = ({ url, method = "GET", headers = {}, body, cookies = false, followRedirects = true }, hops = 0) =>
      new Promise((resolve, reject) => {
        const u = new URL(url);
        const h = { ...headers };
        if (cookies && cookieFor(url)) h.Cookie = cookieFor(url);
        const req = (u.protocol === "https:" ? https : http).request(u, { method, headers: h }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            if (cookies) {
              for (const c of [].concat(res.headers["set-cookie"] || [])) {
                const [pair] = c.split(";");
                const i = pair.indexOf("=");
                if (!jar.has(u.origin)) jar.set(u.origin, new Map());
                jar.get(u.origin).set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
              }
              if (fleetSite) tellFleet();
            }
            if (followRedirects && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
              resolve(request({ url: new URL(res.headers.location, url).href, method: "GET", headers, cookies, followRedirects }, hops + 1));
              return;
            }
            const out = {};
            for (const [k, v] of Object.entries(res.headers)) if (k !== "set-cookie") out[k] = [].concat(v).join(", ");
            resolve({ status: res.statusCode, headers: out, body: Buffer.concat(chunks).toString("utf8") });
          });
        });
        req.on("error", reject);
        if (body != null) req.write(body);
        req.end();
      });
    return {
      addListener: ev.addListener,
      async request(opts) {
        calls.push(["remote.request", opts.url, !!opts.cookies]);
        return request(opts);
      },
      async signIn({ url, mode, checkUrl }) {
        calls.push(["remote.signIn", url, mode]);
        await request({ url, cookies: true });
        if (mode === "cookie") {
          for (let i = 0; i < 20; i++) {
            const r = await request({ url: checkUrl, cookies: true, followRedirects: false });
            if (r.status === 200 && /json/.test(r.headers["content-type"] || "")) return {};
            await new Promise((done) => setTimeout(done, 250));
          }
        }
        throw new Error("Sign-in window closed before signing in.");
      },
      async clearCookies() {
        jar.clear();
        tellFleet();
      },
      async secretSet({ key, value }) {
        secrets.set(key, value);
      },
      async secretGet({ key }) {
        return secrets.has(key) ? { value: secrets.get(key) } : {};
      },
      async secretRemove({ key }) {
        secrets.delete(key);
      },
      async streamRegister({ id, url }) {
        calls.push(["remote.streamRegister", id, url]);
      },
      async streamForget({ id }) {
        calls.push(["remote.streamForget", id]);
      },
      async fleetConfigure({ site }) {
        fleetSite = site || null;
        tellFleet();
      },
      _emit: ev.emit,
    };
  })();

  // Udp (UdpPlugin.java): a real UDP socket (Node's).
  const Udp = (() => {
    const dgram = require("dgram");
    const ev = events();
    let socket = null;
    return {
      addListener: ev.addListener,
      async open() {
        if (!socket) {
          socket = dgram.createSocket("udp4");
          socket.on("message", (msg, rinfo) => ev.emit("packet", { data: msg.toString("base64"), host: rinfo.address, port: rinfo.port }));
          await new Promise((r) => socket.bind(0, r));
        }
        return { port: socket.address().port };
      },
      async send({ data, host, port }) {
        if (!socket) throw new Error("Not open");
        calls.push(["udp.send", host, port]);
        socket.send(Buffer.from(data, "base64"), port, host);
      },
      async close() {
        if (socket) socket.close();
        socket = null;
      },
    };
  })();

  // PhoneControl (PhoneControlPlugin.java): both permissions given; start and stop recorded.
  const PhoneControl = (() => {
    const ev = events();
    let running = false;
    const status = async () => ({ overlay: true, accessibility: true, running });
    return {
      addListener: ev.addListener,
      status,
      async openOverlaySettings() {
        calls.push(["phoneControl.openOverlaySettings"]);
      },
      async openAccessibilitySettings() {
        calls.push(["phoneControl.openAccessibilitySettings"]);
      },
      async start({ settings }) {
        calls.push(["phoneControl.start", settings]);
        running = true;
        return status();
      },
      async stop() {
        calls.push(["phoneControl.stop"]);
        running = false;
        ev.emit("stopped", {});
        return status();
      },
      // As when the control window's × is tapped.
      _stoppedOutside() {
        running = false;
        ev.emit("stopped", {});
      },
    };
  })();

  // The control window's bridge (PhoneControlService.java's HandControl), on phone-control.html:
  // every call recorded, all carried out.
  if (/phone-control\.html$/.test(location.pathname)) {
    const did = (name) => (...args) => {
      calls.push([`hand.${name}`, ...args]);
      return "";
    };
    window.HandControl = {
      pointer: did("pointer"), button: did("button"), wheel: did("wheel"), key: did("key"), text: did("text"),
      web: (json) => (calls.push(["hand.web", json]), JSON.stringify({ status: 200 })),
      status: () => {}, stop: did("stop"),
    };
  }

  // As Capacitor's own bridge on a phone has them: Capacitor.Plugins.<name>, and no
  // registerPlugin (that's @capacitor/core's, which the app doesn't load).
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "android",
    Plugins: { Filesystem, Share, NatNet, Remote, Udp, PhoneControl },
  };
  window.__fakeCapacitor = { files, calls, shared, stopPhoneControl: () => PhoneControl._stoppedOutside() };
})();
