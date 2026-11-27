/**
 * check-call.js — checks the Video Call app (its own app: --app=call) with two devices simulated on this computer
 * (HT_VIDEO_CALL_SIM: "Desk" and "Pi", each with its own service and page), and Chromium's test camera and
 * microphone:  npm run check:call
 * Checked: each lists the other, ready for calls; a call rings the other; declined; not answered in time (missed);
 * answered: both in the call, each receiving the other's pictures and sound; mute and camera off shown on the other
 * side; the camera switched off and back mid-call; a third device calling one in a call: busy; hung up: both back,
 * their cameras let go; a page in a hidden window (as at login, waiting) never opens a camera; the service refuses a
 * web page, and anything but its own devices.
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const http = require("http");
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
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "video-call-check-")));
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
process.argv.push("--app=call");
process.env.HT_VIDEO_CALL_SIM = JSON.stringify([{ name: "Desk", port: PORTS[0] }, { name: "Pi", port: PORTS[1] }]);
require("../electron/main.js");

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

app.whenReady().then(async () => {
  let code = 1;
  try {
    await new Promise((r) => thirdServer.listen(47973, "127.0.0.1", r));
    const desk = await until(() => BrowserWindow.getAllWindows()[0], 20000);
    await desk.loadURL(`app://hand-tracker/video-call.html?ringMs=${RING_MS}`);
    const pi = new BrowserWindow({
      show: false, width: 1000, height: 760,
      webPreferences: { preload: path.join(ROOT, "electron", "preload.js"), contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    await pi.loadURL(`app://hand-tracker/video-call.html?device=1&ringMs=${RING_MS}`);
    const A = (code) => desk.webContents.executeJavaScript(code, true);
    const B = (code) => pi.webContents.executeJavaScript(code, true);
    const st = (w) => w("window.__videoCall.state()");
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
      const [a, b] = [await A("window.__videoCall.received()"), await B("window.__videoCall.received()")];
      return a && b && a.frames > 20 && b.frames > 20 && a.audioPackets > 50 && b.audioPackets > 50 ? { a, b } : null;
    }, 20000);
    check("...each receives the other's pictures and sound", !!flowing, flowing || { a: await A("window.__videoCall.received()"), b: await B("window.__videoCall.received()"), da: await A("window.__videoCall.debug()"), db: await B("window.__videoCall.debug()") });

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
    const before = await B("window.__videoCall.received()");
    await A(`(() => { const s = document.getElementById("callCamera"); s.value = "none"; s.dispatchEvent(new Event("change")); return true; })()`);
    await sleep(1500);
    const none = await A("({ tracks: document.getElementById('self').srcObject.getVideoTracks().length })");
    await A(`(() => { const s = document.getElementById("callCamera"); s.value = s.options[0].value; s.dispatchEvent(new Event("change")); return true; })()`);
    const again = await until(async () => {
      const r = await B("window.__videoCall.received()");
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

    // The service itself: a web page refused; only this computer when simulated.
    const page = await post(PORTS[1], { kind: "offer", call: "page-call-0001", sdp: "v=0" }, { Origin: "https://example.com" });
    check("The service refuses a web page's request", page.status === 403, page);
    const { createVideoCall } = require("../electron/video-call.js");
    const real = createVideoCall({});
    check("...and, not simulated, anything but your own devices on Tailscale", !(await real.trusted("127.0.0.1")) && !(await real.trusted("192.168.1.20")) && !(await real.trusted("8.8.8.8")));

    code = results.every(Boolean) ? 0 : 1;
  } catch (e) {
    console.log(`FAIL  the checks stopped: ${e.stack || e}`);
  }
  console.log(`${results.filter(Boolean).length}/${results.length} checks passed.`);
  thirdServer.close();
  app.exit(code);
});
