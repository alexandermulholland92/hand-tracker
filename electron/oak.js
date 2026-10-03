/**
 * oak.js — Luxonis OAK cameras (OAK-D, OAK-D Lite, OAK-1...) as a hand tracking source.
 *
 * The tracking runs on the camera itself, through geaxgx/depthai_hand_tracker's code
 * (oak/, MIT licence) and Luxonis's depthai library for Python. That library's version 2,
 * which the code is written for, needs Python 3.8-3.13, so the app keeps its own: a
 * one-time setup (the first time an OAK camera is picked) downloads uv, which installs a
 * private Python 3.12 with depthai, OpenCV and NumPy, plus the camera models, all into
 * this app's data folder (about 150 MB; nothing else on the computer changes). Every
 * download is checked against a known size or checksum.
 *
 *   const oak = new OakCamera(userDataDir);
 *   await oak.status();                  // { ready, python, models, reason }
 *   await oak.setup((line) => ...);      // progress lines; rejects with a readable reason
 *   oak.start(options, (msg) => ...);    // msg: { status... } or { frame: header, jpeg: Buffer }
 *   oak.stop();
 */

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const UV_VERSION = "0.12.19";
// By platform and processor. 64-bit ARM Linux: Raspberry Pi 4 and 5 and other ARM boards
// (Luxonis's depthai, OpenCV and NumPy all have ARM builds for Python 3.12).
const UV = {
  "win32-x64": { file: "uv-x86_64-pc-windows-msvc.zip", size: 17955780, exe: "uv.exe" },
  "linux-x64": { file: "uv-x86_64-unknown-linux-gnu.tar.gz", size: 19831732, exe: "uv-x86_64-unknown-linux-gnu/uv" },
  "linux-arm64": { file: "uv-aarch64-unknown-linux-gnu.tar.gz", size: 18916891, exe: "uv-aarch64-unknown-linux-gnu/uv" },
};
const uvHere = () => UV[`${process.platform}-${process.arch}`];
const PYTHON = "3.12";
const PACKAGES = ["depthai==2.30.0.0", "opencv-python-headless==4.10.0.84", "numpy==1.26.4"];
// The camera models, from geaxgx/depthai_hand_tracker at a fixed commit.
const MODEL_BASE = "https://raw.githubusercontent.com/geaxgx/depthai_hand_tracker/97731232fffd467e8de2c3a34ab8382962bb385e/";
const MODELS = [
  ["models/palm_detection_sh4.blob", "4d45ecfddc68d8365fef3cb633d78b916612f25f7a48898f90f8a47d4b151aa5"],
  ["models/hand_landmark_lite_sh4.blob", "98f2e9642099a572c96e80af944212efec199cdea1995ef391fab0d3a9da45fd"],
  ["models/hand_landmark_full_sh4.blob", "4ae2162d077b5abba2b914a685911cb2cd54a34a06a5fc8f9a3dccee6fd2d3ae"],
  ["models/movenet_singlepose_lightning_U8_transpose.blob", "43c097b7610fc0441c3038c3de0edafe57689c87f7bf6b4f20a5ffd6c74f67c2"],
  ["custom_models/PDPostProcessing_top2_sh1.blob", "ef4c2db0bd6b4d3209abcc90fefc54e6d23b614c5165774ac1b706a7652c6516"],
];
// The object finder (MobileNet-SSD, Apache 2.0, from Luxonis's model zoo as depthai's examples
// list it): downloaded the first time Find objects is turned on, not with the setup.
const DETECT_MODEL = {
  name: "mobilenet-ssd_openvino_2021.4_5shave.blob",
  url: "https://artifacts.luxonis.com/artifactory/luxonis-depthai-data-local/network/mobilenet-ssd_openvino_2021.4_5shave.blob",
  sha256: "782d80902c5ce7da01f8fc83894b68da33216edc93d94afb16dd7576a25e50e2",
};
// Python reads the bridge from disk, so in the packaged app it's outside app.asar.
const BRIDGE = path.join(__dirname, "..", "oak", "oak_bridge.py").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

class OakCamera {
  constructor(dataDir, fetchFn) {
    this.dir = path.join(dataDir, "oak");
    this.fetch = fetchFn || globalThis.fetch;
    this.proc = null;
    this.setupRunning = null;
  }

  get paths() {
    const env = path.join(this.dir, "python-env");
    return {
      env,
      python: process.platform === "win32" ? path.join(env, "Scripts", "python.exe") : path.join(env, "bin", "python"),
      models: path.join(this.dir, "models"),
      uv: path.join(this.dir, "uv", uvHere() ? uvHere().exe : "uv"),
    };
  }

  // Everything uv downloads (Python itself, packages) stays in this app's folder.
  uvEnv() {
    return { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(this.dir, "python"), UV_CACHE_DIR: path.join(this.dir, "cache"), UV_NO_CONFIG: "1" };
  }

  async status() {
    if (!uvHere()) return { ready: false, reason: "OAK cameras work in the Windows and Linux apps (64-bit PCs, and 64-bit ARM boards like the Raspberry Pi)." };
    const p = this.paths;
    const models = MODELS.every(([rel]) => fs.existsSync(path.join(p.models, path.basename(rel))));
    const python = fs.existsSync(p.python);
    if (!python || !models) return { ready: false, python, models, reason: "OAK support needs a one-time setup." };
    const check = await this.runBridge(["--check"]).catch((err) => ({ status: "error", message: err.message }));
    if (check.status !== "check") return { ready: false, python, models, reason: check.message || "OAK support isn't working; run the setup again." };
    return { ready: true, python, models, versions: check };
  }

  // Runs the bridge once and resolves its first status message.
  runBridge(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.paths.python, ["-u", BRIDGE, ...args], { windowsHide: true });
      let buf = Buffer.alloc(0), err = "";
      proc.stdout.on("data", (d) => (buf = Buffer.concat([buf, d])));
      proc.stderr.on("data", (d) => (err += d));
      proc.on("error", reject);
      proc.on("close", () => {
        const msg = readMessages(buf).messages[0];
        if (msg) resolve(msg.header);
        else reject(new Error(err.trim().split("\n").pop() || "The OAK helper didn't answer."));
      });
    });
  }

  async download(url, file, progress, expect = {}) {
    const res = await this.fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
    const total = Number(res.headers.get("content-length")) || expect.size || 0;
    const chunks = [];
    let got = 0, shown = 0;
    for await (const chunk of res.body) {
      chunks.push(Buffer.from(chunk));
      got += chunk.length;
      if (total && got - shown > total / 10) {
        shown = got;
        progress(`  ${Math.round((got / total) * 100)}% of ${(total / 1048576).toFixed(1)} MB`);
      }
    }
    const data = Buffer.concat(chunks);
    if (expect.size && data.length !== expect.size) throw new Error(`${path.basename(file)} downloaded incomplete (${data.length} of ${expect.size} bytes).`);
    if (expect.sha256 && crypto.createHash("sha256").update(data).digest("hex") !== expect.sha256) throw new Error(`${path.basename(file)} didn't match its checksum; not using it.`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }

  run(cmd, args, progress, env) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { windowsHide: true, env });
      let tail = "";
      const onData = (d) => {
        const text = d.toString();
        tail = (tail + text).slice(-2000);
        for (const line of text.split(/\r?\n/)) if (line.trim()) progress(`  ${line.trim()}`);
      };
      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);
      proc.on("error", reject);
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} failed (${code}): ${tail.trim().split("\n").pop()}`))));
    });
  }

  setup(progress = () => {}) {
    if (this.setupRunning) return this.setupRunning;
    this.setupRunning = this.doSetup(progress).finally(() => {
      this.setupRunning = null;
    });
    return this.setupRunning;
  }

  async doSetup(progress) {
    const plat = uvHere();
    if (!plat) throw new Error("OAK cameras work in the Windows and Linux apps (64-bit PCs, and 64-bit ARM boards like the Raspberry Pi).");
    const p = this.paths;
    fs.mkdirSync(this.dir, { recursive: true });

    if (!fs.existsSync(p.uv)) {
      progress(`Downloading uv ${UV_VERSION} (installs Python for OAK support)…`);
      const archive = path.join(this.dir, plat.file);
      await this.download(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${plat.file}`, archive, progress, { size: plat.size });
      const uvDir = path.join(this.dir, "uv");
      fs.rmSync(uvDir, { recursive: true, force: true });
      fs.mkdirSync(uvDir, { recursive: true });
      if (process.platform === "win32") {
        await this.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${uvDir.replace(/'/g, "''")}' -Force`], progress);
      } else {
        await this.run("tar", ["-xzf", archive, "-C", uvDir], progress);
        fs.chmodSync(p.uv, 0o755);
      }
      fs.rmSync(archive, { force: true });
    }

    if (!fs.existsSync(p.python)) {
      progress(`Installing a private Python ${PYTHON}…`);
      await this.run(p.uv, ["venv", "--python", PYTHON, "--python-preference", "only-managed", "--seed", p.env], progress, this.uvEnv());
    }
    progress(`Installing ${PACKAGES.join(", ")}…`);
    await this.run(p.uv, ["pip", "install", "--python", p.python, ...PACKAGES], progress, this.uvEnv());

    for (const [rel, sha256] of MODELS) {
      const file = path.join(p.models, path.basename(rel));
      if (fs.existsSync(file) && crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") === sha256) continue;
      progress(`Downloading the camera model ${path.basename(rel)}…`);
      await this.download(MODEL_BASE + rel, file, progress, { sha256 });
    }

    progress("Checking it works…");
    const s = await this.status();
    if (!s.ready) throw new Error(s.reason);
    progress(`OAK support is ready (depthai ${s.versions.depthai}, Python ${s.versions.python}).`);
    return s;
  }

  // The object finder's model, downloaded once (and checked) the first time it's wanted.
  async detectModel(onMessage) {
    const file = path.join(this.paths.models, DETECT_MODEL.name);
    if (fs.existsSync(file)) return true;
    onMessage({ status: "starting", message: "Downloading the object finder for the OAK camera (15 MB, only the first time)…" });
    try {
      await this.download(DETECT_MODEL.url, file, () => {}, { sha256: DETECT_MODEL.sha256 });
      return true;
    } catch (err) {
      onMessage({ status: "starting", message: `The object finder couldn't be downloaded (${err.message.replace(/\.$/, "")}), so the camera starts without it.` });
      return false;
    }
  }

  // options: { lm: "lite" | "full", twoHands, xyz, far: null | "both" | "higher" | "left" | "right", allHands, device, simulate,
  //   detect (find objects too), picture: "color" | "depth", motion (each ninth's movement, for Sentry mode), fps }
  // (device: which OAK camera, by its id; the first one found otherwise)
  start(options, onMessage) {
    this.stop();
    const started = (this.started = {});
    if (options.detect && !options.simulate) {
      // (Its model first; this.stop() meanwhile cancels the start.)
      this.detectModel(onMessage).then((ok) => this.started === started && this.spawn({ ...options, detect: ok }, onMessage));
      return;
    }
    this.spawn(options, onMessage);
  }

  spawn(options, onMessage) {
    const args = ["-u", BRIDGE, "--models", this.paths.models, "--lm", options.lm === "full" ? "full" : "lite"];
    if (options.simulate) args.push("--simulate");
    if (options.twoHands) args.push("--two-hands");
    if (options.xyz) args.push("--xyz");
    if (["both", "higher", "left", "right"].includes(options.far)) args.push("--far", options.far);
    if (options.allHands) args.push("--all-hands");
    if (options.device && /^[A-Za-z0-9._-]+$/.test(options.device)) args.push("--device", options.device);
    if (options.detect) args.push("--detect");
    if (options.picture === "depth") args.push("--picture", "depth");
    if (options.motion) args.push("--motion");
    if (Number.isInteger(options.fps) && options.fps >= 10 && options.fps <= 60) args.push("--fps", String(options.fps));
    const proc = spawn(this.paths.python, args, { windowsHide: true });
    this.proc = proc;
    let buf = Buffer.alloc(0), err = "";
    proc.stdout.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      const { messages, rest } = readMessages(buf);
      buf = rest;
      for (const m of messages) onMessage(m.header.status ? m.header : { frame: m.header, jpeg: m.jpeg });
    });
    proc.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    proc.on("error", (e) => onMessage({ status: "error", message: `The OAK helper couldn't start: ${e.message}` }));
    proc.on("close", (code) => {
      if (this.proc === proc) this.proc = null;
      onMessage({ status: "stopped", code, detail: code ? err.trim().split("\n").slice(-3).join(" ") : "" });
    });
  }

  stop() {
    this.started = null; // (a start waiting for its model is called off)
    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      proc.kill();
    }
  }
}

// Splits the bridge's stream into { header, jpeg } messages (see oak_bridge.py). Each starts
// with "HTK1"; anything else (a stray log line) is skipped.
const MAGIC = Buffer.from("HTK1");
function readMessages(buf) {
  const messages = [];
  let at = 0;
  while (buf.length - at >= 12) {
    if (!buf.subarray(at, at + 4).equals(MAGIC)) {
      const next = buf.indexOf(MAGIC, at + 1);
      if (next < 0) {
        at = Math.max(at, buf.length - 3); // keep a possible partial marker
        break;
      }
      at = next;
      continue;
    }
    const n = buf.readUInt32LE(at + 4);
    if (n > 1 << 20) {
      at += 4; // not a real message: look for the next marker
      continue;
    }
    if (buf.length - at < 8 + n + 4) break;
    const m = buf.readUInt32LE(at + 8 + n);
    if (buf.length - at < 12 + n + m) break;
    let header = null;
    try {
      header = JSON.parse(buf.subarray(at + 8, at + 8 + n).toString("utf8"));
    } catch {
      at += 4;
      continue;
    }
    const jpeg = m ? Buffer.from(buf.subarray(at + 12 + n, at + 12 + n + m)) : null;
    messages.push({ header, jpeg });
    at += 12 + n + m;
  }
  return { messages, rest: buf.subarray(at) };
}

module.exports = { OakCamera, readMessages };
