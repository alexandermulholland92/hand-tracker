/**
 * check-cluster.js — checks the Pi Cluster app (its own app: --app=cluster) with a Pi simulated on
 * this computer: Pi Cluster's real service (cluster/node, --simulate) beside a stand-in Hand Tracker
 * and a stand-in GitHub, found through HT_CLUSTER_NODES.
 *   npm run check:cluster        (Python 3 needed: PYTHON, else python3, python or py -3)
 * Checked in the app's window: the Pi listed with its modules' summaries; a module turned off
 * under ⚙ (and the Pi says so); Sentry turned off from Camera rigs (Hand Tracker is asked);
 * a module the page doesn't know shown all the same; Transmission's torrents moved in (with
 * cluster/test_apps.py's stand-in Transmission), each torrent's Traffic drop-down (its speeds,
 * totals, peers, a graph over 1 h and 24 h), asking for more peers, a waiting torrent moved up the
 * queue, and how many download, seed and connect at once; on a phone (the app's plugins standing
 * in: fake-cluster-plugin.js), the Pi found and a job done from there, and this phone's apps (a
 * newer build's notice, the list, Update all, Install; the iPhone's notice only); in a browser, the
 * page as a Pi serves it (a second Pi asked through it, a job from a file picked there, its results
 * saved from a one-time link, another site's page refused); a Pi that stops answering faded, with
 * Forget. The service's own checks: cluster/test_cluster.py.
 */
const { app, BrowserWindow } = require("electron");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const results = [];
const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400)})`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const s = require("net").createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(300);
  }
  return null;
}

function python() {
  for (const [cmd, args] of [[process.env.PYTHON, []], ["python3", []], ["python", []], ["py", ["-3"]]]) {
    if (!cmd) continue;
    const r = spawnSync(cmd, [...args, "--version"], { encoding: "utf8" });
    if (r.status === 0 && /Python 3\./.test(r.stdout + r.stderr)) return [cmd, args];
  }
  return null;
}

function serve(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}
const json = (res, code, body) => {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": data.length });
  res.end(data);
};

// A stand-in Hand Tracker (its remote recording API) and GitHub (no newer build).
const HT = { armed: true, commands: [] };
const fakeHT = (req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/api/state") {
      return json(res, 200, { recording: false, saving: false, cameras: [{ name: "OAK-D-W", role: "Head", fps: 30, oak: true, chipC: 51 }], sentry: { armed: HT.armed } });
    }
    if (req.method === "POST" && req.url === "/api/command") {
      const msg = JSON.parse(body || "{}");
      HT.commands.push(msg);
      if (msg.action === "sentry") HT.armed = !!(msg.sentry && msg.sentry.armed);
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: "Not found" });
  });
};
const fakeGitHub = (req, res) => json(res, 200, { target_commitish: "c".repeat(40), published_at: "2026-11-17T12:00:00Z", assets: [] });

function ask(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { "X-HT-Cluster": "1", Host: `127.0.0.1:${port}`, ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) } }, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => resolve(JSON.parse(s || "{}")));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const py = python();
if (!py) {
  console.error("Python 3 is needed (PYTHON=…, python3, python or py -3).");
  process.exit(1);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cluster-check-"));
const port = 47900 + Math.floor(Math.random() * 90);
// (an extra module, as one added later would be: the page has to show it without knowing it)
const nodeDir = path.join(tmp, "node");
fs.cpSync(path.join(ROOT, "cluster", "node"), nodeDir, { recursive: true, filter: (src) => !src.includes("__pycache__") });
// (the Pi Cluster page beside the service, as a build puts it there: what a simulated Pi serves to a browser)
for (const f of ["pi-cluster.html", "pi-cluster.js", "video-formats.js", "sentry-models.js", "models/kinds.js", "favicon.png", "apple-touch-icon.png"]) {
  fs.mkdirSync(path.dirname(path.join(nodeDir, "web", f)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, f), path.join(nodeDir, "web", f));
}
fs.writeFileSync(path.join(nodeDir, "modules", "zz_later.py"), [
  'TITLE = "Later module"', "ORDER = 90", "ON = True",
  'SETTINGS = [{"key": "speed", "title": "Speed", "default": "slow", "choices": [["slow", "Slow"], ["fast", "Fast"]]}]',
  'def status(node): return {"summary": "Something new: speed " + str(node.setting("zz_later", "speed")), "warnings": ["A new warning"]}',
  'ACTIONS = {"poke": {"title": "Poke it", "run": lambda node, args: {"ok": True, "message": "Poked."}}}',
].join("\n"));

// Jobs: a clip in the simulated Pi's recordings folder, a file "from this computer", and a folder to
// save results in (the file pickers answer by themselves).
const recordings = path.join(tmp, "recordings");
const ffmpegPath = require("ffmpeg-static");
fs.mkdirSync(recordings);
spawnSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2", "-pix_fmt", "yuv420p", path.join(recordings, "Sentry_Head_2026-11-17_12-00-00.mp4")]);
const letter = path.join(tmp, "letter.txt");
fs.writeFileSync(letter, "hello from this computer\n");
const saveIn = path.join(tmp, "saved");
fs.mkdirSync(saveIn);
const { dialog } = require("electron");
dialog.showOpenDialog = async (_win, options) => ({ canceled: false, filePaths: (options.properties || []).includes("openDirectory") ? [saveIn] : [letter] });

// Transmission: the window app's torrents to move in (cluster/test_apps.py's stand-ins: a Transmission's
// RPC, keeping its torrents in its settings folder, and a root helper that starts it).
const trHome = path.join(tmp, "home");
const gtk = path.join(trHome, ".config", "transmission");
const trConfig = path.join(tmp, "transmission");
for (const d of [path.join(gtk, "torrents"), path.join(gtk, "resume"), path.join(trHome, "Videos", "shows"), path.join(trHome, "Videos", "movies"), path.join(trHome, "Downloads")]) fs.mkdirSync(d, { recursive: true });
["Videos/shows", "Videos/shows", "Videos/movies"].forEach((sub, i) => {
  const dest = Buffer.from(path.join(trHome, ...sub.split("/")));
  fs.writeFileSync(path.join(gtk, "resume", `t${i}.resume`), Buffer.concat([Buffer.from(`d11:destination${dest.length}:`), dest, Buffer.from("5:addedi1ee")]));
  fs.writeFileSync(path.join(gtk, "torrents", `t${i}.torrent`), `d4:infod4:name2:t${i}ee`);
});
fs.writeFileSync(path.join(gtk, "settings.json"), JSON.stringify({ "download-dir": path.join(trHome, "Downloads"), "rpc-port": 9092, "download-queue-enabled": true, "download-queue-size": 3,
  "seed-queue-enabled": false, "seed-queue-size": 10, "peer-limit-global": 60, "peer-limit-per-torrent": 20, "peer-port": 51413 }));
const fakeTr = path.join(tmp, "fake-tr.py"), fakeHelper = path.join(tmp, "fake-helper.py");
spawnSync(py[0], [...py[1], "-c", "import sys; sys.path.insert(0, sys.argv[1]); import test_apps; open(sys.argv[2], 'w').write(test_apps.FAKE_TRANSMISSION); open(sys.argv[3], 'w').write(test_apps.FAKE_HELPER)",
  path.join(ROOT, "cluster"), fakeTr, fakeHelper]);
const fakeState = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(trConfig, "fake-state.json"), "utf8"));
  } catch {
    return {};
  }
};

let service = null;
process.argv.push("--app=cluster");
process.env.HT_CLUSTER_NODES = `127.0.0.1:${port}`;
process.env.HT_CLUSTER_ONLY = "1"; // (not the real Pis on this computer's Tailscale)
app.setPath("userData", path.join(tmp, "app"));
require("../electron/main.js");

app.whenReady().then(async () => {
  let code = 1;
  try {
    const ht = await serve(fakeHT);
    const gh = await serve(fakeGitHub);
    service = spawn(py[0], [...py[1], path.join(nodeDir, "ht_cluster.py"), "--simulate", "--port", String(port)], {
      env: {
        ...process.env, HT_CLUSTER_STATE: path.join(tmp, "state"), HT_CLUSTER_HT_URL: `http://127.0.0.1:${ht.address().port}`, HT_CLUSTER_GITHUB_API: `http://127.0.0.1:${gh.address().port}`,
        HT_CLUSTER_JOBS_DIR: path.join(tmp, "jobs"), HT_CLUSTER_FFMPEG: ffmpegPath, HT_CLUSTER_SIM_RECORDINGS: recordings, PYTHONDONTWRITEBYTECODE: "1",
        HT_CLUSTER_SIM_NAME: os.hostname().split(".")[0], HT_CLUSTER_ROOT_HELPER: fakeHelper, HT_TEST_HELPER_LOG: path.join(tmp, "helper.log"), HT_TEST_FAKE_TR: fakeTr,
        HT_CLUSTER_TR_PORT: String(await freePort()), HT_CLUSTER_TR_OLD_PORT: String(await freePort()), HT_CLUSTER_TR_CONFIG: trConfig, HT_CLUSTER_SIM_GTK: gtk,
        HT_CLUSTER_SIM_HOME: trHome, HT_CLUSTER_SIM_FAST: "1",
      },
      stdio: "ignore",
    });
    const win = await until(() => BrowserWindow.getAllWindows().find((w) => /pi-cluster\.html/.test(w.webContents.getURL())));
    check("The Pi Cluster app opens its page", !!win);
    const js = (code) => win.webContents.executeJavaScript(code, true);
    // (HT_CLUSTER_SHOT=folder: pictures of the window as it's checked)
    const shot = async (name) => {
      if (!process.env.HT_CLUSTER_SHOT) return;
      await sleep(400);
      fs.writeFileSync(path.join(process.env.HT_CLUSTER_SHOT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    };
    await until(() => js("document.readyState === 'complete'"));
    await js("window.confirm = () => true; null");
    const host = os.hostname().split(".")[0].toLowerCase();
    const text = () => js("document.getElementById('pis').innerText");
    const listed = await until(async () => {
      const t = await text();
      return t.includes("CPU") && t.includes("Hand Tracker running") && t.includes("Something new") && t;
    }, 30000);
    check("The simulated Pi is listed with its health and its rig", !!listed, await text());
    await shot("1-pis");
    check("...by its name", !!listed && listed.toLowerCase().includes(host), listed);
    check("A module the page doesn't know is shown with its summary and warning", !!listed && listed.includes("Something new: speed slow") && listed.includes("A new warning"), listed);
    const buttons = await js("[...document.querySelectorAll('#pis button')].map((b) => b.textContent)");
    check("...and its button", buttons.includes("Poke it"), buttons);
    check("The updates module's buttons are there", buttons.includes("Check for updates") && buttons.includes("Restart this Pi"), buttons);

    // ⚙: a module turned off; another's setting changed
    await js("[...document.querySelectorAll('#pis button')].find((b) => b.textContent === '⚙').click(); null");
    const settings = await until(() => js("[...document.querySelectorAll('.settings label')].map((l) => l.textContent)"));
    check("⚙ lists each module's switch and its settings", !!settings && settings.includes("Camera rig") && settings.includes("Update Raspberry Pi OS by itself") && settings.includes("SpeedSlowFast"), settings);
    await shot("2-settings");
    await js("[...document.querySelectorAll('.settings label')].find((l) => l.textContent === 'Camera rig').querySelector('input').click(); null");
    const rigOff = await until(async () => {
      const d = await ask(port, "GET", "/api/node");
      return d.modules.find((m) => m.name === "rig").on === false;
    });
    check("Turning Camera rig off under ⚙ turns it off on the Pi", !!rigOff);
    await js("(() => { const s = [...document.querySelectorAll('.settings label')].find((l) => l.textContent.startsWith('Speed')).querySelector('select'); s.value = 'fast'; s.dispatchEvent(new Event('change')); })(); null");
    const fast = await until(async () => (await text()).includes("speed fast"));
    check("A setting changed under ⚙ reaches the Pi", !!fast, await text());
    await js("document.activeElement && document.activeElement.blur(); null");
    await js("[...document.querySelectorAll('.settings label')].find((l) => l.textContent === 'Camera rig').querySelector('input').click(); null");
    await until(async () => (await ask(port, "GET", "/api/node")).modules.find((m) => m.name === "rig").on === true);

    // Camera rigs: Sentry off
    await js("document.getElementById('tabRigs').click(); null");
    const rigText = await until(async () => {
      const t = await js("document.getElementById('rigs').innerText");
      return t.includes("Turn Sentry off") && t;
    });
    check("Camera rigs shows the rig, its camera and Sentry's button", !!rigText && rigText.includes("Head: OAK-D-W") && rigText.includes("chip 51"), rigText);
    await shot("3-rigs");
    await js("[...document.querySelectorAll('#rigs button')].find((b) => b.textContent === 'Turn Sentry off').click(); null");
    const off = await until(() => HT.commands.some((c) => c.action === "sentry" && c.sentry && c.sentry.armed === false));
    check("Turn Sentry off asks the Pi's Hand Tracker", !!off, HT.commands);
    const msg = await until(() => js("document.getElementById('message').textContent"));
    check("...and says what it did", /Sentry off/.test(msg || ""), msg);

    // Jobs: this Pi keeps the job list; a conversion of its recording, and a command over a file from this computer
    await ask(port, "POST", "/api/settings", { module: "jobs", key: "withCameras", value: true }); // (its stand-in Hand Tracker's cameras run)
    await js("document.getElementById('tabJobs').click(); null");
    const keep = await until(() => js("[...document.querySelectorAll('#jobsHome button')].some((b) => b.textContent === 'Keep it there')"));
    check("Jobs asks which Pi keeps the job list", !!keep);
    await js("[...document.querySelectorAll('#jobsHome button')].find((b) => b.textContent === 'Keep it there').click(); null");
    const kept = await until(() => js("/keeps the job list/.test(document.getElementById('jobsHome').textContent)"));
    check("...and that Pi keeps it", !!kept, await js("document.getElementById('jobsHome').textContent"));
    const click = (sel, text) => js(`[...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent.startsWith(${JSON.stringify(text)})).click(); null`);
    await click("#jobs button", "New job");
    await js("document.querySelector('input[name=kind][value=convert]').click(); null");
    await click("#newJob button", "Recordings on the Pis");
    await until(() => js("document.querySelectorAll('#recordingsBox label input').length >= 2"));
    await js("[...document.querySelectorAll('#recordingsBox label')].find((l) => l.textContent.startsWith('Sentry_Head')).querySelector('input').click(); null");
    const chosen = await js("document.getElementById('chosen').textContent");
    check("A conversion job's recording is chosen from the Pi's list", /1 recording on the Pis/.test(chosen), chosen);
    await click("#newJob button", "Start the job");
    const converted = await until(async () => {
      const t = await js("document.getElementById('jobList').innerText");
      return /Videos to MP4[\s\S]*1 of 1 done/.test(t) && t;
    }, 90000);
    check("...it's done, there on the job list", !!converted, (await js("document.getElementById('jobList').innerText")) + " | message: " + (await js("document.getElementById('message').textContent")));
    await shot("4-jobs");
    await click("#jobs button", "New job");
    await js("document.querySelector('input[name=kind][value=command]').click(); null");
    await js(`document.getElementById('command').value = ${JSON.stringify(`${py[0]} ${py[1].join(" ")} -c "import shutil,sys; shutil.copy(sys.argv[1], sys.argv[2])" {in} {out}`)}; null`);
    await click("#newJob button", "Files from this computer");
    await until(async () => /1 file from this computer/.test(await js("document.getElementById('chosen').textContent")));
    await click("#newJob button", "Start the job");
    const commanded = await until(async () => {
      const t = await js("document.getElementById('jobList').innerText");
      return /A command for each file[\s\S]*1 of 1 done/.test(t) && t;
    }, 90000);
    check("A command job over a file sent from this computer is done", !!commanded, await js("document.getElementById('jobList').innerText"));
    await js("[...document.querySelectorAll('#jobList .card')].find((c) => c.textContent.startsWith('A command for each file')).querySelector('button').click(); null");
    const saved = await until(() => fs.existsSync(path.join(saveIn, "A command for each file", "letter.txt")) && fs.existsSync(path.join(saveIn, "A command for each file", "log.txt")), 30000);
    check("...and its results saved on this computer", !!saved && fs.readFileSync(path.join(saveIn, "A command for each file", "letter.txt"), "utf8").startsWith("hello"), fs.existsSync(saveIn) && fs.readdirSync(saveIn));

    // Transmission: which Pi keeps its files, then the offer to move the window app's torrents in
    await js("document.getElementById('tabTransmission').click(); null");
    const trAsk = await until(() => js("[...document.querySelectorAll('#trHome button')].some((b) => b.textContent === 'Keep them there')"));
    check("Transmission asks which Pi keeps its files", !!trAsk, await js("document.getElementById('trHome').innerText"));
    await js("[...document.querySelectorAll('#trHome button')].find((b) => b.textContent === 'Keep them there').click(); null");
    const offer = await until(async () => /Move .* Transmission torrents in/.test(await js("document.getElementById('trHome').innerText")));
    check("...then offers to move the window app's torrents in", !!offer, await js("document.getElementById('trHome').innerText"));
    const homeOn = await until(async () => (await ask(port, "GET", "/api/node")).modules.find((m) => m.name === "apps").status.home === true);
    check("...that Pi now keeps them", !!homeOn);

    // Moved in: each torrent's traffic (speeds, totals, a graph over 1 h / 24 h / 7 days), asking for more
    // peers, a waiting torrent's place in the queue, and how many download, seed and connect at once
    await js("[...document.querySelectorAll('#trHome button')].find((b) => /Move .* Transmission torrents in/.test(b.textContent)).click(); null");
    const trList = () => js("document.getElementById('trList').innerText");
    const three = await until(async () => (await js("document.querySelectorAll('#trList details.traffic').length")) === 3, 60000);
    check("Moved in: the torrents listed, each with a Traffic drop-down", !!three, await trList());
    const sums = await js("[...document.querySelectorAll('#trList details.traffic > summary')].map((s) => s.textContent)");
    check("...its speeds on it, 0 too", sums.length === 3 && sums.every((s) => /^Traffic\s+↓ \d+ KB\/s\s+↑ \d+ KB\/s$/.test(s)) && sums.some((s) => /↑ 2 KB\/s/.test(s)) && sums.some((s) => /↑ 0 KB\/s/.test(s)), sums);
    const card = (name) => `[...document.querySelectorAll('#trList .card')].find((c) => c.querySelector('.summary').textContent === ${JSON.stringify(name)})`;
    const order = () => js("[...document.querySelectorAll('#trList .card .summary')].map((s) => s.textContent).join(',')");
    check("...those waiting to download first, in the queue's order", (await order()) === "t1,t2,t0", await order());
    await js(`${card("t0")}.querySelector('summary').click(); null`);
    const opened = await until(() => js(`(() => { const c = ${card("t0")}; const p = c && c.querySelector('.graph path.up'); return p && /L/.test(p.getAttribute('d')) && c.querySelector('details').innerText + ' | ' + c.querySelector('.graph').textContent; })()`), 30000);
    check("Opened: what it's received and sent in all, its peers, and its traffic over the last hour", !!opened && /In all: ↓ 1 MB\s+↑ 500 KB · 3 peers connected/.test(opened) && /1 h ago/.test(opened), opened || (await trList()));
    if (process.env.HT_CLUSTER_SHOT) await js(`${card("t0")}.scrollIntoView({ block: "end" }); null`);
    await shot("5-transmission");
    await js(`[...${card("t0")}.querySelectorAll('.spans button')].find((b) => b.textContent === '24 h').click(); null`);
    await sleep(9000); // (the list drawn again meanwhile: it stays open, on 24 h)
    const day = await until(() => js(`(() => { const c = ${card("t0")}; const d = c && c.querySelector('details'); return d && d.open && /24 h ago/.test(d.querySelector('.graph').textContent) && c.querySelector('.spans button[aria-pressed=true]').textContent; })()`), 30000);
    check("...over 24 hours too, and it stays open as the list is drawn again", day === "24 h", day);
    await js(`[...${card("t0")}.querySelectorAll('button')].find((b) => b.textContent === 'Ask for more peers').click(); null`);
    const askedOne = await until(() => JSON.stringify(fakeState().reannounced || []) === "[[1]]");
    check("Ask for more peers: that torrent's trackers asked", !!askedOne, fakeState());
    await js("document.getElementById('trPeersAll').click(); null");
    const askedAll = await until(() => (fakeState().reannounced || []).includes("all"));
    check("...and every torrent's, from the button for all", !!askedAll, fakeState());
    await js(`${card("t2")}.querySelector('summary').click(); null`);
    const second = await until(() => js(`/2 of 2 waiting to download/.test(${card("t2")}.innerText)`));
    check("A waiting torrent says its place in the queue", !!second, await trList());
    await js(`[...${card("t2")}.querySelectorAll('button')].find((b) => b.textContent === 'Up').click(); null`);
    const upped = await until(async () => (await order()) === "t2,t1,t0", 20000);
    check("...and moves up it from its drop-down", !!upped, await order());
    if (process.env.HT_CLUSTER_SHOT) await js(`${card("t2")}.scrollIntoView({ block: "end" }); null`);
    await shot("5b-transmission-queue");
    const limits = await until(() => js("!document.getElementById('trLimits').hidden && document.getElementById('trPeerAll').value === '60' && document.getElementById('trDlSize').value === '3'"), 20000);
    check("How many download, seed and connect at once, as Transmission has them", !!limits, await js("document.getElementById('trLimits').innerText"));
    const change = (id, value) => js(`(() => { const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('change')); })(); null`);
    await change("trDlSize", "2");
    await change("trPeerAll", "100");
    await js("document.getElementById('trSeedQueue').click(); null");
    const set = await until(() => {
      const l = fakeState().limits || {};
      return l["download-queue-size"] === 2 && l["peer-limit-global"] === 100 && l["seed-queue-enabled"] === true && l;
    });
    check("...changed there: Transmission told", !!set, fakeState());
    const shown = await until(() => js("document.getElementById('trDlSize').value === '2' && document.getElementById('trPeerAll').value === '100' && document.getElementById('trSeedQueue').checked && !document.getElementById('trSeedSize').disabled"), 20000);
    check("...and the page shows it", !!shown, await js("document.getElementById('trLimits').innerText"));
    await shot("6-transmission-limits");

    // On a phone: the same page through the app's Cluster plugin (here fake-cluster-plugin.js): the
    // Pi found by its Tailscale name, a command job over a file picked on the phone, its results as one zip
    const downloads = path.join(tmp, "phone-downloads");
    fs.mkdirSync(downloads);
    Object.assign(process.env, { FAKE_CLUSTER_NAMES: JSON.stringify({ pi: `127.0.0.1:${port}` }), FAKE_CLUSTER_DOWNLOADS: downloads, FAKE_CLUSTER_PICK: letter });
    const phone = new BrowserWindow({ show: false, width: 400, height: 860, webPreferences: { preload: path.join(__dirname, "fake-cluster-plugin.js"), contextIsolation: false, sandbox: false } });
    await phone.loadURL("app://hand-tracker/pi-cluster.html");
    const pjs = (code) => phone.webContents.executeJavaScript(code, true);
    await pjs("window.confirm = () => true; null");
    const phoneText = () => pjs("document.getElementById('pis').innerText");
    const onPhone = await until(async () => /CPU/.test(await phoneText()) && /Hand Tracker running/.test(await phoneText()), 30000);
    check("On a phone: the Pi found by its Tailscale name (pi) and listed", !!onPhone, await phoneText());
    const calls = await pjs("window.__clusterCalls.map((c) => c.join(' '))");
    check("...through the app's Cluster plugin", calls.includes("GET pi /api/node"), calls.slice(0, 6));
    check("...and Add a Pi offers to look for one by its name", (await pjs("document.getElementById('phoneAdd').hidden")) === false);
    await pjs("document.getElementById('tabJobs').click(); null");
    await until(() => pjs("/keeps the job list/.test(document.getElementById('jobsHome').textContent)"));
    const pclick = (sel, text) => pjs(`[...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent.startsWith(${JSON.stringify(text)})).click(); null`);
    await pclick("#jobs button", "New job");
    await pjs("document.querySelector('input[name=kind][value=command]').click(); null");
    await pjs(`document.getElementById('command').value = ${JSON.stringify(`${py[0]} ${py[1].join(" ")} -c "import shutil,sys; shutil.copy(sys.argv[1], sys.argv[2])" {in} {out}`)}; document.getElementById('jobTitle').value = 'From the phone'; null`);
    await pclick("#newJob button", "Files from this phone");
    const picked = await until(async () => /1 file from this phone/.test(await pjs("document.getElementById('chosen').textContent")));
    check("A file picked on the phone is chosen", !!picked, await pjs("document.getElementById('chosen').textContent"));
    await pclick("#newJob button", "Start the job");
    const phoneDone = await until(async () => /From the phone[\s\S]*1 of 1 done/.test(await pjs("document.getElementById('jobList').innerText")), 90000);
    check("...sent to the Pi a piece at a time, and the job done", !!phoneDone, (await pjs("document.getElementById('jobList').innerText")) + " | " + (await pjs("document.getElementById('message').textContent")));
    await pjs("[...document.querySelectorAll('#jobList .card')].find((c) => c.textContent.startsWith('From the phone')).querySelector('button').click(); null");
    const zipped = await until(async () => /Saved From the phone.zip/.test(await pjs("document.getElementById('message').textContent")) && fs.existsSync(path.join(downloads, "From the phone.zip")), 30000);
    const zipBytes = zipped ? fs.readFileSync(path.join(downloads, "From the phone.zip")) : Buffer.alloc(0);
    check("...its results saved on the phone as one zip in Downloads", !!zipped && zipBytes.includes(Buffer.from("letter.txt")) && zipBytes.includes(Buffer.from("hello from this computer")), await pjs("document.getElementById('message').textContent"));
    phone.destroy();

    // This phone's apps (Android): GitHub's newest build, through the app's AppUpdates plugin (here
    // fake-cluster-plugin.js's): a notice for the older ones, the list, Update all, and Install
    const NEW = "b".repeat(40);
    const OLD = "a".repeat(40);
    const asset = (n) => ({ asset: `${n}-1.1.0.apk`, size: 50e6, sha256: "0".repeat(64), url: `https://github.com/x/${n}.apk` });
    Object.assign(process.env, {
      FAKE_APPS: JSON.stringify([
        { pkg: "com.handtracker.app", name: "Hand Tracker", installed: true, commit: OLD, updated: Date.now() - 86400000 },
        { pkg: "com.handtracker.mouse", name: "Hand Mouse", installed: true, commit: NEW, updated: Date.now() },
        { pkg: "com.handtracker.remote", name: "Remote Recording", installed: false },
        { pkg: "com.handtracker.converter", name: "Recording Converter", installed: true, commit: "", updated: Date.parse("2026-11-01T12:00:00Z") },
        { pkg: "com.handtracker.cluster", name: "Pi Cluster", installed: true, commit: OLD, updated: Date.now() - 86400000, self: true, ours: true },
      ]),
      FAKE_LATEST: JSON.stringify({ commit: NEW, published: "2026-11-20T22:40:51Z", apps: {
        "com.handtracker.app": asset("HandTracker"), "com.handtracker.mouse": asset("HandMouse"), "com.handtracker.remote": asset("RemoteRecording"),
        "com.handtracker.converter": asset("RecordingConverter"), "com.handtracker.cluster": asset("PiCluster") } }),
    });
    const handset = new BrowserWindow({ show: false, width: 400, height: 860, webPreferences: { preload: path.join(__dirname, "fake-cluster-plugin.js"), contextIsolation: false, sandbox: false } });
    await handset.loadURL("app://hand-tracker/pi-cluster.html");
    const hjs = (code) => handset.webContents.executeJavaScript(code, true);
    await hjs("window.confirm = () => true; null");
    const notice = await until(() => hjs("!document.getElementById('appNotice').hidden && document.getElementById('appNotice').innerText"), 20000);
    check("This phone's apps: a notice when GitHub has a newer build, naming the older ones here",
      !!notice && /build bbbbbbb/.test(notice) && /Hand Tracker, Recording Converter, Pi Cluster/.test(notice) && !/Hand Mouse/.test(notice) && /3 newer/.test(await hjs("document.getElementById('phoneAppsBtn').textContent")), notice);
    check("...and Android asked once whether it may notify (the hourly look's notices)", (await hjs("window.__notices")) === 1, await hjs("window.__notices"));
    await hjs("[...document.querySelectorAll('#appNotice button')].find((b) => b.textContent === 'See all').click(); null");
    const appList = () => hjs("document.getElementById('phoneAppsBox').innerText");
    const appsListed = await until(async () => {
      const t = await appList();
      return /Hand Mouse — this phone: build bbbbbbb · up to date/.test(t) && /Recording Converter — this phone: an older build/.test(t) && /Remote Recording — not on this phone/.test(t) && t;
    });
    check("...the list: each app's build here (up to date, older, or not on this phone)", !!appsListed, await appList());
    const list = await appList();
    check("...which update by themselves (Pi Cluster installed them) and which Android asks about once",
      /Pi Cluster — this phone: build aaaaaaa · updates by itself/.test(list) && /Hand Tracker — this phone: build aaaaaaa · Android asks once: Update/.test(list), list);
    const installs = () => hjs("JSON.stringify(window.__appInstalls)");
    const lookAgain = "[...document.querySelectorAll('#phoneAppsBox button')].find((b) => b.textContent === 'Look again').click(); null";
    await hjs(`window.__appRecording = 'Hand Tracker'; window.__appAuto = '16:40: Waiting: Hand Tracker is recording or saving a take (looks again within an hour).'; ${lookAgain}`);
    const waiting = await until(async () => /Waiting: Hand Tracker is recording or saving a take/.test(await appList()) && /Last hourly look: 16:40/.test(await appList()));
    check("While this phone records: the apps wait, it says so, with what the hourly look did last", !!waiting, await appList());
    await hjs("[...document.querySelectorAll('#phoneAppsBox button')].find((b) => b.textContent.startsWith('Update all')).click(); null");
    await sleep(800);
    check("...and Update all doesn't update meanwhile", (await installs()) === "[]" && /recording or saving a take/.test(await hjs("document.getElementById('message').textContent")),
      (await installs()) + " | " + (await hjs("document.getElementById('message').textContent")));
    await hjs(`window.__appRecording = null; ${lookAgain}`);
    await until(async () => !/Waiting:/.test(await appList()));
    await hjs("[...document.querySelectorAll('#phoneAppsBox button')].find((b) => b.textContent.startsWith('Update all')).click(); null");
    const updatedAll = await until(async () => (await installs()) === JSON.stringify([["com.handtracker.app", "com.handtracker.converter", "com.handtracker.cluster"]]) &&
      /updated to build bbbbbbb/.test(await hjs("document.getElementById('message').textContent")) && /Hand Tracker — this phone: build bbbbbbb · up to date/.test(await appList()));
    check("Update all: the older ones updated, Pi Cluster last, and up to date after", !!updatedAll, (await installs()) + " | " + (await appList()));
    await hjs("[...document.querySelectorAll('#phoneAppsBox .app-row')].find((r) => r.textContent.startsWith('Remote Recording')).querySelector('button').click(); null");
    const installedOne = await until(async () => JSON.parse(await installs()).length === 2 && JSON.parse(await installs())[1].join() === "com.handtracker.remote" &&
      /Remote Recording — this phone: build bbbbbbb · up to date/.test(await appList()));
    check("Install: an app not on this phone put on it", !!installedOne, (await installs()) + " | " + (await appList()));
    check("...and with nothing older left, no notice", await until(() => hjs("document.getElementById('appNotice').hidden && document.getElementById('phoneAppsBtn').textContent === \"This phone's apps\"")));
    handset.destroy();

    // The iPhone app: only a notice that a newer build (with the iPhone app in it) is out, as GitHub says
    // (here a stand-in for api.github.com); installing stays with AltServer
    const { session, net } = require("electron");
    let githubAsked = 0;
    session.defaultSession.protocol.handle("https", (req) => {
      if (new URL(req.url).hostname !== "api.github.com") return net.fetch(req, { bypassCustomProtocolHandlers: true });
      githubAsked++;
      return new Response(JSON.stringify({ target_commitish: NEW, published_at: "2026-11-20T22:40:51Z", assets: [{ name: "PiCluster-1.1.0-ios-unsigned.ipa" }, { name: "PiCluster-1.1.0.apk" }] }),
        { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    });
    delete process.env.FAKE_APPS;
    Object.assign(process.env, { FAKE_PLATFORM: "ios", FAKE_BUILD_COMMIT: OLD });
    try {
      const iphone = new BrowserWindow({ show: false, width: 400, height: 860, webPreferences: { preload: path.join(__dirname, "fake-cluster-plugin.js"), contextIsolation: false, sandbox: false } });
      await iphone.loadURL("app://hand-tracker/pi-cluster.html");
      const ijs = (code) => iphone.webContents.executeJavaScript(code, true);
      const iNotice = await until(() => ijs("!document.getElementById('appNotice').hidden && document.getElementById('appNotice').innerText"), 20000);
      check("iPhone: a notice that a newer build is out, to install with AltServer (no updating there)",
        !!iNotice && /newer build of the apps is out \(build bbbbbbb/.test(iNotice) && /AltServer/.test(iNotice) && (await ijs("document.getElementById('phoneAppsBtn').hidden")) === true && githubAsked > 0, iNotice);
      await ijs("document.querySelector('#appNotice button').click(); null");
      check("...gone once seen, until the next build", !!(await until(() => ijs("document.getElementById('appNotice').hidden"))));
      iphone.destroy();
    } finally {
      session.defaultSession.protocol.unhandle("https");
      delete process.env.FAKE_PLATFORM;
      delete process.env.FAKE_BUILD_COMMIT;
    }

    // In a browser: the page as a Pi serves it itself (http://<the Pi>:47830/), with the other Pi asked through
    // it: both listed, a setting changed on the other one, a command job over a file picked in the browser, its
    // results saved from a one-time link; and another site's page can't use the service (a pair of Pis of their own)
    const aPort = await freePort();
    const bPort = await freePort();
    const pair = [["alpha", aPort, bPort], ["beta", bPort, aPort]].map(([name, p, other]) => spawn(py[0], [...py[1], path.join(nodeDir, "ht_cluster.py"), "--simulate", "--port", String(p)], {
      env: {
        ...process.env, HT_CLUSTER_SIM_NAME: name, HT_CLUSTER_SIM_PEERS: `127.0.0.1:${other}`, HT_CLUSTER_STATE: path.join(tmp, `state-${name}`), HT_CLUSTER_JOBS_DIR: path.join(tmp, `jobs-${name}`),
        HT_CLUSTER_HT_URL: `http://127.0.0.1:${ht.address().port}`, HT_CLUSTER_GITHUB_API: `http://127.0.0.1:${gh.address().port}`, HT_CLUSTER_ROOT_HELPER: fakeHelper,
        HT_TEST_HELPER_LOG: path.join(tmp, `helper-${name}.log`), PYTHONDONTWRITEBYTECODE: "1", HT_CLUSTER_SIM_FAST: "1",
      },
      stdio: "ignore",
    }));
    try {
      for (const [p, name] of [[aPort, "alpha"], [bPort, "beta"]]) {
        await until(() => ask(p, "GET", "/api/node").then((d) => d.name === name), 20000);
        await ask(p, "POST", "/api/settings", { module: "jobs", key: "withCameras", value: true }); // (its stand-in Hand Tracker's cameras run)
      }
      const browser = new BrowserWindow({ show: false, width: 1000, height: 900 }); // (no preload: an ordinary browser)
      const browserSaved = path.join(tmp, "browser-downloads");
      fs.mkdirSync(browserSaved);
      const downloads = [];
      browser.webContents.session.on("will-download", (_e, item) => {
        item.setSavePath(path.join(browserSaved, item.getFilename()));
        item.once("done", (_e2, state) => downloads.push([item.getFilename(), state]));
      });
      await browser.loadURL(`http://127.0.0.1:${aPort}/`);
      const bjs = (code) => browser.webContents.executeJavaScript(code, true);
      await bjs("window.confirm = () => true; null");
      const browserText = () => bjs("document.getElementById('pis').innerText");
      const both = await until(async () => {
        const t = await browserText();
        return /alpha/.test(t) && /beta/.test(t) && (t.match(/CPU/g) || []).length >= 2 && t;
      }, 30000);
      check("In a browser: the page a Pi serves lists that Pi, and the other one through it", !!both, await browserText());
      const through = await bjs("document.getElementById('buildInfo').textContent");
      check("...saying which Pi it came through", through === "through alpha", through);
      const card = (name) => `[...document.querySelectorAll('#pis .card')].find((c) => c.querySelector('.name').textContent === ${JSON.stringify(name)})`;
      await bjs(`${card("beta")}.querySelector('.top button').click(); null`);
      await until(() => bjs(`!!${card("beta")}.querySelector('.settings')`));
      await bjs(`(() => { const s = [...${card("beta")}.querySelectorAll('.settings label')].find((l) => l.textContent.startsWith('Speed')).querySelector('select'); s.value = 'fast'; s.dispatchEvent(new Event('change')); })(); null`);
      const speed = async (p) => ((await ask(p, "GET", "/api/node")).modules.find((m) => m.name === "zz_later").settings.find((s) => s.key === "speed") || {}).value;
      const relayed = await until(async () => (await speed(bPort)) === "fast");
      check("...a setting changed under the other Pi's ⚙ is made there (passed on), not on the Pi the page came from", !!relayed && (await speed(aPort)) === "slow", [await speed(bPort), await speed(aPort)]);
      await bjs("document.activeElement && document.activeElement.blur(); document.getElementById('tabJobs').click(); null");
      await until(() => bjs("[...document.querySelectorAll('#jobsHome button')].some((b) => b.textContent === 'Keep it there')"));
      await bjs("document.querySelector('#jobsHome select').value = 'alpha'; [...document.querySelectorAll('#jobsHome button')].find((b) => b.textContent === 'Keep it there').click(); null");
      await until(() => bjs("/alpha keeps the job list/.test(document.getElementById('jobsHome').textContent)"));
      const bclick = (sel, text) => bjs(`[...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent.startsWith(${JSON.stringify(text)})).click(); null`);
      await bclick("#jobs button", "New job");
      await bjs("document.querySelector('input[name=kind][value=command]').click(); null");
      await bjs(`document.getElementById('command').value = ${JSON.stringify(`${py[0]} ${py[1].join(" ")} -c "import shutil,sys; shutil.copy(sys.argv[1], sys.argv[2])" {in} {out}`)}; document.getElementById('jobTitle').value = 'From a browser'; null`);
      // (the browser's file box answers by itself: a file "picked" on this device)
      await bjs(`HTMLInputElement.prototype.click = function () { if (this.type !== 'file') return; const dt = new DataTransfer(); dt.items.add(new File(['hello from this device\\n'.repeat(3000)], 'letter.txt', { type: 'text/plain' })); this.files = dt.files; this.onchange && this.onchange(); }; null`);
      await bclick("#newJob button", "Files from this device");
      const bpicked = await until(async () => /1 file from this device/.test(await bjs("document.getElementById('chosen').textContent")));
      check("...a file picked in the browser is chosen", !!bpicked, await bjs("document.getElementById('chosen').textContent"));
      await bclick("#newJob button", "Start the job");
      const bdone = await until(async () => /From a browser[\s\S]*1 of 1 done/.test(await bjs("document.getElementById('jobList').innerText")), 90000);
      check("...sent to the Pi that keeps the job list, and the job done", !!bdone, (await bjs("document.getElementById('jobList').innerText")) + " | " + (await bjs("document.getElementById('message').textContent")));
      await bjs("[...document.querySelectorAll('#jobList .card')].find((c) => c.textContent.startsWith('From a browser')).querySelector('button').click(); null");
      const zipPath = path.join(browserSaved, "From a browser.zip");
      const bzip = await until(() => downloads.some(([n, s]) => n === "From a browser.zip" && s === "completed") && fs.existsSync(zipPath), 30000);
      const bzipBytes = bzip ? fs.readFileSync(zipPath) : Buffer.alloc(0);
      check("...its results saved by the browser as one zip (from a one-time link)", !!bzip && bzipBytes.includes(Buffer.from("letter.txt")) && bzipBytes.includes(Buffer.from("hello from this device")),
        JSON.stringify(downloads) + " | " + (await bjs("document.getElementById('message').textContent")));
      browser.destroy();
      // Another site's page in the same browser: its request with the app's header isn't let through (no CORS)
      const other = new BrowserWindow({ show: false });
      await other.loadURL("data:text/html,<title>another site</title>");
      const foreign = await other.webContents.executeJavaScript(`fetch("http://127.0.0.1:${aPort}/api/node", { headers: { "X-HT-Cluster": "1" } }).then((r) => "answered " + r.status, (e) => "refused: " + e.message)`, true);
      check("Another site's page can't use the service", /^refused/.test(foreign), foreign);
      other.destroy();
    } finally {
      for (const p of pair) p.kill();
    }

    // The Pi goes away
    service.kill();
    await js("document.getElementById('tabPis').click(); null");
    const away = await until(async () => {
      const t = await text();
      return /isn't answering|Away/.test(t) && t.includes("Forget") && t;
    }, 30000);
    check("A Pi that stops answering is faded, with Forget", !!away, await text());
    code = results.every(Boolean) ? 0 : 1;
  } catch (err) {
    console.error(err);
    check("No errors", false, err.message);
  } finally {
    if (service) service.kill();
    try {
      process.kill(Number(fs.readFileSync(path.join(tmp, "state", "tr-running"), "utf8")), "SIGKILL"); // (the stand-in Transmission)
    } catch {}
    console.log(`${results.filter(Boolean).length}/${results.length} checks passed.`);
    try {
      fs.rmSync(path.join(tmp, "node"), { recursive: true, force: true });
      fs.rmSync(path.join(tmp, "state"), { recursive: true, force: true });
    } catch {} // (the app's own folder is still in use until it has quit)
    app.exit(code);
  }
});
