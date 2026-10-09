#!/usr/bin/env node
/**
 * check-extension.js — the Chrome extension (scripts/build-extension.js) in a real Chrome:
 * Chrome for Testing (branded Chrome no longer loads an extension from the command line),
 * with a fake camera. It opens a test page and the extension's control page, and checks:
 *  - the control page runs MediaPipe Hands under an extension's rules (no blob workers, no
 *    eval), and keeps tracking while it's in a background tab;
 *  - the hand mouse, fed the checks' synthetic hands, works the page in front: its pointer
 *    appears and follows the hand, a quick index-finger curl clicks, a middle-finger curl
 *    right-clicks; clicking into a box and typing types there;
 *  - Alt+Shift+M's message turns the hand mouse on and off;
 *  - a page Chrome keeps from extensions says so on the control page.
 *
 *   CHROME=path/to/chrome-for-testing PUPPETEER=path/to/puppeteer-core node scripts/check-extension.js
 *   (both: npx @puppeteer/browsers install chrome@stable; npm install puppeteer-core)
 */
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const puppeteer = require(process.env.PUPPETEER || "puppeteer-core");
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The test page: a box to type into at the top, and below it one big button (wherever the
// pointer is, a click lands on it), logging what reaches it.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Extension test page</title>
<style>body{margin:0;font:16px sans-serif} #box{position:fixed;left:0;top:0;width:100%;height:20vh;font-size:20px}
#big{position:fixed;left:0;top:20vh;width:100%;height:80vh}</style>
<input id="box" placeholder="type here"><button id="big">Big button</button>
<script>
  window.__log = [];
  const big = document.getElementById("big");
  big.addEventListener("click", () => __log.push("click"));
  big.addEventListener("contextmenu", (e) => { e.preventDefault(); __log.push("contextmenu"); });
</script>`;

(async () => {
  if (!process.argv.includes("--no-build")) execFileSync(process.execPath, [path.join(__dirname, "build-extension.js")], { stdio: "inherit" });
  const ext = path.join(ROOT, "dist", "extension");
  const server = http.createServer((req, res) => res.end(PAGE)).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;
  const fake = require("./fake-camera.js").fakeCameraFile();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hand-tracker-ext-"));
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME,
    headless: process.env.HEADFUL ? false : true,
    userDataDir: profile,
    args: [
      `--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
      "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      ...(fake ? [`--use-file-for-fake-video-capture=${fake}`] : []),
      "--no-first-run", "--no-default-browser-check", "--window-size=1280,900",
      ...(process.env.CI ? ["--no-sandbox"] : []), // (GitHub's Linux runners don't allow Chrome's sandbox)
    ],
    defaultViewport: null,
  });
  try {
    const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && /background\.js$/.test(t.url()), { timeout: 20000 });
    const id = new URL(sw.url()).host;
    check("The extension loads (its background script runs)", !!id, id);

    const page = await browser.newPage();
    await page.goto(pageUrl);
    const control = await browser.newPage();
    const errors = [];
    control.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    control.on("pageerror", (e) => errors.push(String(e.message || e)));
    await control.goto(`chrome-extension://${id}/control.html`);
    let fps = 0;
    for (let i = 0; i < 60 && fps < 5; i++) {
      await sleep(500);
      fps = await control.evaluate(() => HandTracker.getFPS());
    }
    check("The control page tracks the camera with MediaPipe under an extension's rules", fps >= 5 && !errors.length, `${fps} fps; errors: ${JSON.stringify(errors.slice(0, 3))}`);

    // The test page in front: the control page in a background tab keeps tracking.
    await page.bringToFront();
    await sleep(3000);
    const hidden = await control.evaluate(() => ({ state: document.visibilityState, fps: HandTracker.getFPS() }));
    check("With another tab in front, the control page keeps tracking", hidden.state === "hidden" && hidden.fps >= 5, JSON.stringify(hidden));

    // The hand mouse, fed synthetic hands (as scripts/check.js does), works the page in front.
    const r = await control.evaluate(async () => {
      const { PcControl, HandTracker } = window.__handMouse;
      HandTracker.setPaused(true); // only these hands
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      const T = [[0,0],[-.04,-.03],[-.08,-.07],[-.11,-.10],[-.13,-.13],[-.035,-.12],[-.04,-.17],[-.043,-.20],[-.045,-.23],
        [0,-.125],[0,-.18],[0,-.215],[0,-.245],[.03,-.115],[.035,-.165],[.038,-.195],[.04,-.22],[.055,-.10],[.065,-.135],[.07,-.16],[.075,-.18]];
      const hand = (cx, cy, curled = []) => ({ handedness: "Right", imageLandmarks: T.map(([x, y], i) => {
        const f = { 7: 5, 8: 5, 11: 9, 12: 9 }[i];
        const bent = f !== undefined && curled.includes(f === 5 ? "index" : "middle");
        const [bx, by] = bent ? [T[f][0] + (x - T[f][0]) * 0.2, T[f][1] + (y - T[f][1]) * 0.2] : [x, y];
        return { x: cx + bx, y: cy + by, z: 0 };
      }) });
      const none = () => ({ label: "—" });
      const frames = async (n, hands) => {
        for (let i = 0; i < n; i++) { PcControl.update(typeof hands === "function" ? hands(i) : hands, none, false, 16 / 9); await sleep(40); }
      };
      PcControl.setMouse(true);
      await sleep(100);
      await frames(20, (i) => [hand(0.35 + i * 0.015, 0.75)]);
      await sleep(300);
      await frames(6, [hand(0.65, 0.75)]);
      await frames(3, [hand(0.65, 0.75, ["index"])]);
      await frames(8, [hand(0.65, 0.75)]);
      await frames(3, [hand(0.65, 0.75, ["middle"])]);
      await frames(8, [hand(0.65, 0.75)]);
      await sleep(300);
      return { on: PcControl.isMouseOn(), note: document.getElementById("pageNote").textContent };
    });
    const seen = await page.evaluate(() => {
      const p = document.getElementById("handPointer");
      return { pointer: !!p, transform: p && p.style.transform, log: window.__log.slice() };
    });
    check("The hand mouse's pointer appears over the page in front and follows the hand", r.on && seen.pointer && /translate\(\d/.test(seen.transform || "") && !r.note, JSON.stringify({ ...r, ...seen }));
    check("A quick index-finger curl clicks the page in front, a middle-finger curl right-clicks it", seen.log.join() === "click,contextmenu", JSON.stringify(seen.log));

    // Clicking into the box and typing (the gesture actions' Type text, through the same calls).
    const typed = await control.evaluate(async () => {
      const { pc } = window.__handMouse;
      pc.pointer(0.5, 0.08);
      await new Promise((res) => setTimeout(res, 200));
      await pc.button("left", "click");
      await pc.text("hello from a hand");
      await pc.key("backspace");
      return true;
    }).catch((e) => String(e.message || e));
    const value = await page.evaluate(() => document.getElementById("box").value);
    check("Clicking into a box on the page in front and typing types there", typed === true && value === "hello from a han", JSON.stringify({ typed, value }));

    // Alt+Shift+M (background.js's command): the hand mouse off, and on again. (Chrome stops an
    // idle background script: it's woken, and found again, each time.)
    const command = async () => {
      await control.evaluate(() => chrome.runtime.sendMessage({ to: "nobody" }).catch(() => {}));
      const target = await browser.waitForTarget((t) => t.type() === "service_worker" && /background\.js$/.test(t.url()), { timeout: 10000 });
      await (await target.worker()).evaluate(() => chrome.runtime.sendMessage({ to: "control", cmd: "toggle" }).catch(() => {}));
      await sleep(400);
      return control.evaluate(() => window.__handMouse.PcControl.isMouseOn());
    };
    const toggled = [await command()];
    const gone = await page.evaluate(() => !document.getElementById("handPointer"));
    toggled.push(await command());
    check("Alt+Shift+M turns the hand mouse off and on again", toggled.join() === "false,true", JSON.stringify(toggled));

    // A page Chrome keeps from extensions: the control page says so.
    await page.goto("chrome://version");
    await page.bringToFront();
    await control.evaluate(async () => {
      const { pc } = window.__handMouse;
      pc.pointer(0.5, 0.5);
      await new Promise((res) => setTimeout(res, 500));
    });
    const note = await control.evaluate(() => document.getElementById("pageNote").textContent);
    check("On a page Chrome keeps from extensions, the control page says so", /Chrome doesn't let extensions work this page/.test(note), note);
    check("Turning the hand mouse off took its pointer off the page", gone);
  } catch (err) {
    check("Check run finished without crashing", false, err.stack || String(err));
  } finally {
    await browser.close().catch(() => {});
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  process.exit(failed ? 1 : 0);
})();
