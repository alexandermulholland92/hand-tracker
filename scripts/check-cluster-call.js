/**
 * check-cluster-call.js — checks the Cluster Call app (its own app: --app=call) with two devices simulated on this computer
 * (HT_CLUSTER_CALL_SIM: "Desk" and "Pi", each with its own service and page), and Chromium's test camera and
 * microphone:  npm run check:cluster-call
 * Checked: each lists the other, ready for calls; a call rings the other; declined; not answered in time (missed);
 * answered: both in the call, each receiving the other's pictures and sound; mute and camera off shown on the other
 * side; the camera switched off and back mid-call; a third device calling one in a call: busy; hung up: both back,
 * their cameras let go; a page in a hidden window (as at login, waiting) never opens a camera; the service refuses a
 * web page, and anything but its own devices.
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const http = require("http");
const { spawn, spawnSync } = require("child_process");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const results = [];
const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 2500)})`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(200);
  }
  return null;
}

const PORTS = [47971, 47972];
const RING_MS = 5000;
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "cluster-call-check-")));
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
// (the test camera playing a file: Chromium's own pattern crashes now and then, and then no camera opens: fake-camera.js)
const fakeCamera = require("./fake-camera.js").fakeCameraFile();
if (fakeCamera) app.commandLine.appendSwitch("use-file-for-fake-video-capture", fakeCamera);
process.argv.push("--app=clustercall");
process.env.HT_CLUSTER_CALL_SIM = JSON.stringify([{ name: "Desk", port: PORTS[0] }, { name: "Pi", port: PORTS[1] }, { name: "Phone", port: 47975, external: true }]);
process.env.HT_CLUSTER_CALL_RIG = "127.0.0.1:47974"; // (the Pi's Hand Tracker: the stand-in below)
require("../electron/main.js");

// A stand-in Hand Tracker on the Pi (its rig service): one camera ("North", an OAK say) whose pictures are 320 × 180
// (a size no test webcam gives, so the call's picture is known to be this one's), about 15 a second once started.
const rig = { commands: [], running: false, seq: 0, frames: [] };
const rigServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://rig");
  const json = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && url.pathname === "/api/state") return json(200, { cameras: [{ name: "Cam 1", role: "North", fps: rig.running ? 15 : 0 }], recording: false, sentry: false });
  if (req.method === "POST" && url.pathname === "/api/command") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const a = (JSON.parse(body || "{}") || {}).action;
      rig.commands.push(a);
      if (a === "cameras") rig.running = true;
      if (a === "close") rig.running = false;
      json(200, { ok: true, message: a === "cameras" ? "Starting the cameras…" : "Cameras stopped." });
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/preview") {
    if (!rig.running || !rig.frames.length) return setTimeout(() => (res.writeHead(204), res.end()), 100);
    return setTimeout(() => {
      const n = ++rig.seq;
      const data = rig.frames[n % rig.frames.length];
      res.writeHead(200, { "Content-Type": `image/jpeg; seq=${n}`, "Content-Length": data.length });
      res.end(data);
    }, 66);
  }
  json(404, {});
});

// A third device standing in (it only takes signals): what a device already in a call says to it.
const third = { got: [] };
const thirdServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      third.got.push(JSON.parse(body));
    } catch {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
});

function post(port, body, headers = {}) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const q = http.request({ host: "127.0.0.1", port, path: "/vc/signal", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": data.length, ...headers } }, (r) => {
      let t = "";
      r.on("data", (c) => (t += c));
      r.on("end", () => resolve({ status: r.statusCode, body: t }));
    });
    q.on("error", () => resolve({ status: 0 }));
    q.end(data);
  });
}


// The phone's service (ClusterCallServer.java) on this computer's Java: compiled, started on port 47975 as "Phone";
// { lines (what it said), ask(request) -> its answer, stop() }, or null without Java.
async function startPhone() {
  const isWin = process.platform === "win32";
  const home = [process.env.JAVA_HOME, isWin && "C:/Program Files/Android/Android Studio/jbr", !isWin && "/Applications/Android Studio.app/Contents/jbr/Contents/Home", !isWin && path.join(os.homedir(), "android-studio/jbr")]
    .find((d) => d && fs.existsSync(path.join(d, "bin", isWin ? "javac.exe" : "javac")));
  if (!home) return null;
  const bin = (t) => path.join(home, "bin", isWin ? `${t}.exe` : t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cluster-call-java-"));
  const javac = spawnSync(bin("javac"), ["-nowarn", "-encoding", "UTF-8", "-d", dir, path.join(ROOT, "android/app/src/clustercall/java/com/handtracker/app/ClusterCallServer.java"),
    path.join(__dirname, "jvm/com/handtracker/app/ClusterCallHarness.java")], { encoding: "utf8" });
  if (javac.status !== 0) {
    check("The phone's Cluster Call service compiles (ClusterCallServer.java)", false, String(javac.stderr || javac.error).slice(0, 800));
    return null;
  }
  const java = spawn(bin("java"), ["-cp", dir, "com.handtracker.app.ClusterCallHarness", "47975", "Phone"], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = [], waiting = [];
  let buf = "";
  java.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let j = null;
      try {
        j = JSON.parse(line);
      } catch {}
      if (!j) continue;
      if (j.reply !== undefined || j.trusted !== undefined || j.hello !== undefined) {
        const w = waiting.shift();
        if (w) w(j);
      } else lines.push(j);
    }
  });
  const ready = await until(() => lines.find((l) => l.ready), 10000);
  if (!ready) {
    java.kill();
    check("The phone's Cluster Call service starts (ClusterCallServer.java)", false, "it didn't say it was ready");
    return null;
  }
  return {
    lines,
    ask: (req) => new Promise((resolve) => {
      waiting.push(resolve);
      java.stdin.write(JSON.stringify(req) + "\n");
      setTimeout(() => resolve(null), 15000);
    }),
    stop: () => java.kill(),
  };
}

app.whenReady().then(async () => {
  let code = 1;
  try {
    await new Promise((r) => thirdServer.listen(47973, "127.0.0.1", r));
    // (the stand-in camera's pictures: a bar moving across, so each differs)
    const { nativeImage } = require("electron");
    for (let k = 0; k < 12; k++) {
      const px = Buffer.alloc(320 * 180 * 4);
      for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) {
        const o = (y * 320 + x) * 4, bar = Math.abs(x - k * 26) < 14;
        px[o] = bar ? 255 : 40; px[o + 1] = bar ? 255 : 120; px[o + 2] = bar ? 255 : 200; px[o + 3] = 255;
      }
      rig.frames.push(nativeImage.createFromBitmap(px, { width: 320, height: 180 }).toJPEG(80));
    }
    await new Promise((r) => rigServer.listen(47974, "127.0.0.1", r));
    const desk = await until(() => BrowserWindow.getAllWindows()[0], 20000);
    await desk.loadURL(`app://hand-tracker/cluster-call.html?ringMs=${RING_MS}`);
    const pi = new BrowserWindow({
      show: false, width: 1000, height: 760,
      webPreferences: { preload: path.join(ROOT, "electron", "preload.js"), contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    await pi.loadURL(`app://hand-tracker/cluster-call.html?device=1&ringMs=${RING_MS}`);
    const A = (code) => desk.webContents.executeJavaScript(code, true);
    const B = (code) => pi.webContents.executeJavaScript(code, true);
    const st = (w) => w("window.__clusterCall.state()");
    const click = (w, id) => w(`document.getElementById(${JSON.stringify(id)}).click(); true`);
    const callButton = (w, name) => w(`(() => { const li = [...document.querySelectorAll("#devices li")].find((l) => l.querySelector(".name").textContent === ${JSON.stringify(name)}); const b = li && li.querySelector("button"); if (!b || b.disabled) return false; b.click(); return true; })()`);

    // Each lists the other, ready for calls.
    const lists = await until(async () => {
      const [a, b] = [await st(A), await st(B)];
      return a.devices.some((d) => d.name === "Pi" && d.app && d.online) && b.devices.some((d) => d.name === "Desk" && d.app) ? { a: a.devices, b: b.devices } : null;
    });
    check("Each device lists the other, ready for calls", !!lists, lists);
    const meText = [await A('document.getElementById("me").textContent'), await B('document.getElementById("me").textContent')];
    check("...and says which device it is", meText[0] === "This device: Desk" && meText[1] === "This device: Pi", meText);
    const preview = (w) => w("!!document.getElementById('preview').srcObject");
    const deskPreview = await until(() => preview(A), 8000);
    const views = { desk: !!deskPreview, pi: await preview(B) };
    check("Only a window in view has its camera open: Desk's (shown) does; Pi's (hidden, as at login waiting for calls) doesn't", views.desk && !views.pi, views);
    pi.showInactive();
    const opened = await until(() => preview(B), 8000);
    pi.hide();
    const closed = await until(async () => !(await preview(B)), 8000);
    check("...Pi's window shown: its camera's picture; hidden again: the camera let go", !!opened && !!closed, { opened, closed });

    // Declined.
    check("Desk calls Pi", await callButton(A, "Pi"));
    const ringing = await until(async () => ((await st(B)).mode === "ringing" ? await st(B) : null));
    const calling = await st(A);
    check("...Pi rings, saying who's calling; Desk is calling", ringing && ringing.peer === "Desk" && calling.mode === "calling" && (await B('document.getElementById("caller").textContent')) === "Desk", { ringing, calling });
    await click(B, "decline");
    const declined = await until(async () => ((await st(A)).mode === "idle" ? await st(A) : null));
    check("...Pi declines: Desk is told, both back", declined && /Pi declined/.test(declined.note) && (await st(B)).mode === "idle", declined);

    // Not answered in time.
    await sleep(500);
    await callButton(A, "Pi");
    await until(async () => (await st(B)).mode === "ringing");
    const missed = await until(async () => {
      const [a, b] = [await st(A), await st(B)];
      return a.mode === "idle" && b.mode === "idle" ? { a: a.note, b: b.note } : null;
    }, RING_MS + 8000);
    check("Not answered in time: Desk gives up, Pi shows a missed call", missed && /didn't answer/.test(missed.a) && /Missed call from Desk/.test(missed.b), missed);

    // Answered: both in the call, each receiving the other's pictures and sound.
    await sleep(500);
    await callButton(A, "Pi");
    await until(async () => (await st(B)).mode === "ringing");
    await click(B, "answer");
    const both = await until(async () => {
      const [a, b] = [await st(A), await st(B)];
      return a.mode === "in-call" && b.mode === "in-call" && a.connection === "connected" && b.connection === "connected" ? { a, b } : null;
    }, 20000);
    check("Pi answers: both in the call, connected straight to each other", !!both, both || { a: await st(A), b: await st(B) });
    const flowing = await until(async () => {
      const [a, b] = [await A("window.__clusterCall.received()"), await B("window.__clusterCall.received()")];
      return a && b && a.frames > 20 && b.frames > 20 && a.audioPackets > 50 && b.audioPackets > 50 ? { a, b } : null;
    }, 20000);
    check("...each receives the other's pictures and sound", !!flowing, flowing || { a: await A("window.__clusterCall.received()"), b: await B("window.__clusterCall.received()"), da: await A("window.__clusterCall.debug()"), db: await B("window.__clusterCall.debug()") });

    // Mute and camera off, shown on the other side.
    await click(A, "mute");
    await click(A, "cameraOff");
    const told = await until(async () => {
      const b = await st(B);
      return b.remote && b.remote.muted && b.remote.camera === false ? b : null;
    });
    const remoteText = await B('document.getElementById("remoteState").textContent');
    check("Desk mutes and turns its camera off: Pi shows both", !!told && /muted/.test(remoteText) && /camera off/.test(remoteText), { told, remoteText });
    await click(A, "mute");
    await click(A, "cameraOff");
    const back = await until(async () => {
      const b = await st(B);
      return b.remote && !b.remote.muted && b.remote.camera ? b : null;
    });
    check("...and back on: Pi shows that too", !!back, await st(B));

    // The camera switched to none and back mid-call: its pictures come again.
    const before = await B("window.__clusterCall.received()");
    await A(`(() => { const s = document.getElementById("callCamera"); s.value = "none"; s.dispatchEvent(new Event("change")); return true; })()`);
    await sleep(1500);
    const none = await A("({ tracks: document.getElementById('self').srcObject.getVideoTracks().length })");
    await A(`(() => { const s = document.getElementById("callCamera"); s.value = s.options[0].value; s.dispatchEvent(new Event("change")); return true; })()`);
    const again = await until(async () => {
      const r = await B("window.__clusterCall.received()");
      return r && r.frames > before.frames + 20 ? r : null;
    }, 15000);
    check("The camera switched off and back mid-call (no new setting up): its pictures come again", none.tracks === 0 && !!again, { none, before, again });

    // A third device calling one already in a call: busy.
    const busyReply = await post(PORTS[0], { kind: "offer", call: "third-call-0001", sdp: "v=0", name: "Tablet", port: 47973 });
    const busy = await until(() => third.got.find((s) => s.kind === "busy" && s.call === "third-call-0001"));
    check("A third device calling Desk in a call: told it's busy (Desk's call goes on)", busyReply.status === 200 && !!busy && (await st(A)).mode === "in-call", { busyReply, got: third.got });

    // Hung up: both back, cameras let go.
    await click(B, "hangup");
    const ended = await until(async () => {
      const [a, b] = [await st(A), await st(B)];
      return a.mode === "idle" && b.mode === "idle" ? { a: a.note, b: b.note } : null;
    });
    const freed = await B("({ preview: !!document.getElementById('preview').srcObject, self: !!document.getElementById('self').srcObject })");
    check("Pi hangs up: both back, Desk told; Pi (hidden) has no camera open any more", ended && /Pi hung up/.test(ended.a) && !freed.preview && !freed.self, { ended, freed });

    // Hand Tracker's camera on the Pi (an OAK, say) as its call's camera: listed, not started just by being chosen,
    // started when the call is answered, its pictures what Desk sees, and stopped after the call.
    const listed = await B(`[...document.getElementById("camera").options].map((o) => o.value + "=" + o.textContent)`);
    check("Pi lists its Hand Tracker's camera among its cameras", listed.includes("rig:0=North (Hand Tracker)"), listed);
    await B(`(() => { const s = document.getElementById("camera"); s.value = "rig:0"; s.dispatchEvent(new Event("change")); return true; })()`);
    await sleep(800);
    check("...chosen, it isn't started just for that (only in a call)", !rig.commands.includes("cameras"), rig.commands);
    await callButton(A, "Pi");
    await until(async () => (await st(B)).mode === "ringing");
    await click(B, "answer");
    const fromRig = await until(async () => {
      const r = await A("window.__clusterCall.received()");
      return r && r.width === 320 && r.frames > 15 ? r : null;
    }, 20000);
    check("...Pi answers with it: Hand Tracker's cameras started, Desk sees its pictures (320 × 180)", rig.commands.includes("cameras") && !!fromRig, { commands: rig.commands, fromRig, got: await A("window.__clusterCall.received()") });
    await click(A, "hangup");
    const rigClosed = await until(() => rig.commands.includes("close") && !rig.running);
    check("...the call over: Hand Tracker's cameras stopped again (this call started them)", !!rigClosed, rig.commands);


    // Each computer app's own page is in what's packaged (package.json's build files; these checks run from the folder,
    // where every file is there: Cluster Call's own page was missing from its packages until 2026-11-27, a blank window).
    const packaged = require("../package.json").build.files;
    const mainSource = fs.readFileSync(path.join(ROOT, "electron/main.js"), "utf8");
    const pages = [...mainSource.matchAll(/^\s+\w+: \{ name: "[^"]+", page: "([^"]+)"/gm)].map((m) => m[1]);
    check("Each computer app's page is packaged with it (Cluster Call's too)", pages.includes("cluster-call.html") && pages.every((p) => packaged.includes(p)),
      pages.filter((p) => !packaged.includes(p)));

    // Android lets the phone app send its signals at all: plain HTTP, which it refuses unless the app says so (this
    // computer's Java has no such rule, so the run below can't show it: every signal from a real phone was refused,
    // "Cleartext HTTP traffic not permitted", 2026-11-27).
    const manifest = fs.readFileSync(path.join(ROOT, "android/app/src/clustercall/AndroidManifest.xml"), "utf8");
    const server = fs.readFileSync(path.join(ROOT, "android/app/src/clustercall/java/com/handtracker/app/ClusterCallServer.java"), "utf8");
    check("The phone app may send plain HTTP (its signals), and only to devices on Tailscale",
      /<application[^>]*android:usesCleartextTraffic="true"/.test(manifest) && /onTailnet\(host\)/.test(server));

    // A phone's Cluster Call service (ClusterCallServer.java: on this computer's Java, ClusterCallHarness standing in for the
    // phone app around it): listed by Desk, told Desk's list of your devices, rung by Desk, and declining back; it
    // takes anything on your Tailscale network, never a web page.
    const phone = await startPhone();
    if (!phone) check("A phone's Cluster Call service (ClusterCallServer.java)", true, "no Java here: skipped");
    else {
      await click(A, "refresh");
      const listedPhone = await until(async () => (await st(A)).devices.find((d) => d.name === "Phone" && d.app));
      check("Desk lists the phone (its Java service) as ready for calls", !!listedPhone, (await st(A)).devices);
      const told = await until(() => phone.lines.find((l) => l.announce));
      check("...and tells the phone your devices (Desk itself first, with its address)", told && told.announce.some((d) => d.name === "Desk" && d.address === `127.0.0.1:${PORTS[0]}` && d.app) && told.announce.some((d) => d.name === "Pi"), told);
      await callButton(A, "Phone");
      const offer = await until(() => phone.lines.find((l) => l.signal && l.signal.kind === "offer"));
      check("Desk calls the phone: its service gets the offer, from Desk, with its description", offer && offer.signal.from.name === "Desk" && /^v=0/.test(offer.signal.sdp) && offer.signal.from.address === `127.0.0.1:${PORTS[0]}`, offer);
      const sent = await phone.ask({ send: offer ? offer.signal.from.address : "", signal: { kind: "decline", call: offer ? offer.signal.call : "x" } });
      const declined = await until(async () => ((await st(A)).mode === "idle" ? await st(A) : null));
      check("...the phone declines: Desk is told", sent && sent.reply && sent.reply.ok && declined && /Phone declined/.test(declined.note), { sent, declined });
      const trusts = [await phone.ask({ trusted: "100.101.44.120" }), await phone.ask({ trusted: "fd7a:115c:a1e0::1" }), await phone.ask({ trusted: "192.168.1.88" }), await phone.ask({ trusted: "8.8.8.8" })].map((r) => r && r.trusted);
      check("The phone's service takes anything on your Tailscale network, nothing else", JSON.stringify(trusts) === "[true,true,false,false]", trusts);
      const pagePost = await post(47975, { kind: "offer", call: "page-call-0002", sdp: "v=0" }, { Origin: "https://example.com" });
      const formPost = await new Promise((resolve) => {
        const q = http.request({ host: "127.0.0.1", port: 47975, path: "/vc/signal", method: "POST", headers: { "Content-Type": "text/plain" } }, (r) => resolve(r.statusCode));
        q.on("error", () => resolve(0));
        q.end('{"kind":"offer","call":"form-call-0001"}');
      });
      check("...never a web page's request, nor anything posted that isn't JSON", pagePost.status === 403 && formPost === 415, { pagePost, formPost });
      phone.stop();
    }

    // The service itself: a web page refused; only this computer when simulated.
    const page = await post(PORTS[1], { kind: "offer", call: "page-call-0001", sdp: "v=0" }, { Origin: "https://example.com" });
    check("The service refuses a web page's request", page.status === 403, page);
    const { createClusterCall } = require("../electron/cluster-call.js");
    const real = createClusterCall({});
    check("...and, not simulated, anything but your own devices on Tailscale", !(await real.trusted("127.0.0.1")) && !(await real.trusted("192.168.1.20")) && !(await real.trusted("8.8.8.8")));

    code = results.every(Boolean) ? 0 : 1;
  } catch (e) {
    console.log(`FAIL  the checks stopped: ${e.stack || e}`);
  }
  console.log(`${results.filter(Boolean).length}/${results.length} checks passed.`);
  thirdServer.close();
  rigServer.close();
  app.exit(code);
});
