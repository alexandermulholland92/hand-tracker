/**
 * check-cluster.js — checks the Pi Cluster app (its own app: --app=cluster) with a Pi simulated on
 * this computer: Pi Cluster's real service (cluster/node, --simulate) beside a stand-in Hand Tracker
 * and a stand-in GitHub, found through HT_CLUSTER_NODES.
 *   npm run check:cluster        (Python 3 needed: PYTHON, else python3, python or py -3)
 * Checked in the app's window: the Pi listed with its modules' summaries; a module turned off
 * under ⚙ (and the Pi says so); Sentry turned off from Camera rigs (Hand Tracker is asked);
 * a module the page doesn't know shown all the same; a Pi that stops answering faded, with
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
fs.writeFileSync(path.join(nodeDir, "modules", "zz_later.py"), [
  'TITLE = "Later module"', "ORDER = 90", "ON = True",
  'SETTINGS = [{"key": "speed", "title": "Speed", "default": "slow", "choices": [["slow", "Slow"], ["fast", "Fast"]]}]',
  'def status(node): return {"summary": "Something new: speed " + str(node.setting("zz_later", "speed")), "warnings": ["A new warning"]}',
  'ACTIONS = {"poke": {"title": "Poke it", "run": lambda node, args: {"ok": True, "message": "Poked."}}}',
].join("\n"));

let service = null;
process.argv.push("--app=cluster");
process.env.HT_CLUSTER_NODES = `127.0.0.1:${port}`;
app.setPath("userData", path.join(tmp, "app"));
require("../electron/main.js");

app.whenReady().then(async () => {
  let code = 1;
  try {
    const ht = await serve(fakeHT);
    const gh = await serve(fakeGitHub);
    service = spawn(py[0], [...py[1], path.join(nodeDir, "ht_cluster.py"), "--simulate", "--port", String(port)], {
      env: { ...process.env, HT_CLUSTER_STATE: path.join(tmp, "state"), HT_CLUSTER_HT_URL: `http://127.0.0.1:${ht.address().port}`, HT_CLUSTER_GITHUB_API: `http://127.0.0.1:${gh.address().port}`, PYTHONDONTWRITEBYTECODE: "1" },
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
    console.log(`${results.filter(Boolean).length}/${results.length} checks passed.`);
    try {
      fs.rmSync(path.join(tmp, "node"), { recursive: true, force: true });
      fs.rmSync(path.join(tmp, "state"), { recursive: true, force: true });
    } catch {} // (the app's own folder is still in use until it has quit)
    app.exit(code);
  }
});
