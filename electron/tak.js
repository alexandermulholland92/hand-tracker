/**
 * tak.js — opens OptiTrack Motive takes (.tak) through the Motive installed on
 * this PC: tak-convert.ps1 drives Motive's own NMotive API. Nothing from Motive
 * is bundled with Hand Tracker; without Motive installed, .tak files can't be read
 * (their format is proprietary and undocumented).
 */

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { uniquePath, sanitizeBaseName } = require("./exporter");

// PowerShell can't run a script from inside app.asar (see "asarUnpack" in package.json).
const SCRIPT = path.join(__dirname, "tak-convert.ps1").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const MOTIVE_FORMATS = ["c3d", "trc", "csv", "fbx", "bvh"];
const TIMEOUT_MS = 10 * 60 * 1000; // long takes can take a while to solve and export

let motiveDir; // undefined = not looked yet, null = not installed

function findMotive() {
  if (process.platform !== "win32") return null;
  const candidates = [];
  try {
    const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\NaturalPoint\\Optitrack\\InstallLocation", "/ve"], { encoding: "utf8", windowsHide: true });
    const m = /REG_SZ\s+(.+)/.exec(out);
    if (m) candidates.push(m[1].trim());
  } catch {
    // not in the registry — try the default location
  }
  candidates.push("C:\\Program Files\\OptiTrack\\Motive");
  return candidates.find((dir) => fs.existsSync(path.join(dir, "MotiveBatchProcessor", "NMotive.dll"))) || null;
}

function motive() {
  if (motiveDir === undefined) motiveDir = findMotive();
  return motiveDir;
}

const NOT_INSTALLED =
  "Opening .tak files needs OptiTrack Motive installed on this PC — Hand Tracker reads takes through Motive. " +
  "Alternatively, export the take from Motive as C3D (File → Export Tracking Data) and open that.";

function checkTake(takePath) {
  if (!/\.tak$/i.test(takePath) || !fs.existsSync(takePath) || !fs.statSync(takePath).isFile()) {
    throw new Error("That isn't a .tak file that can be opened.");
  }
  if (!motive()) throw new Error(NOT_INSTALLED);
}

// Runs the converter; resolves with its JSON result.
function convert(takePath, outDir, formats) {
  return new Promise((resolve, reject) => {
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Take", takePath, "-OutDir", outDir, "-Formats", formats.join(",")];
    const proc = spawn("powershell.exe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", () => {
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/).reverse().find((l) => l.trim().startsWith("{"));
      if (!line) return reject(new Error(`Motive couldn't read this take.${stderr ? ` ${stderr.trim().split(/\r?\n/).pop()}` : ""}`));
      const result = JSON.parse(line);
      if (!result.ok) return reject(new Error(result.error === "MOTIVE_NOT_FOUND" ? NOT_INSTALLED : `Motive couldn't read this take: ${result.error}`));
      resolve(result);
    });
  });
}

// For viewing: the take's markers as C3D bytes, plus what Motive reports about it.
async function openTake(takePath) {
  checkTake(takePath);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "hand-tracker-tak-"));
  try {
    const result = await convert(takePath, work, ["c3d"]);
    const c3d = result.outputs.find((o) => o.format === "c3d" && o.ok);
    if (!c3d) throw new Error(`Motive couldn't export this take's markers: ${(result.outputs[0] || {}).message || "unknown error"}`);
    const { outputs, ...info } = result;
    return { info, c3d: fs.readFileSync(c3d.path) };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Exports with Motive's exporters into dir (never overwriting). Returns per-format results.
async function exportTake(takePath, formats, dir, baseName) {
  checkTake(takePath);
  const wanted = formats.filter((f) => MOTIVE_FORMATS.includes(f));
  if (!wanted.length) return [];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "hand-tracker-tak-"));
  try {
    const result = await convert(takePath, work, wanted);
    const base = sanitizeBaseName(baseName);
    return result.outputs.map((o) => {
      if (!o.ok) return { format: o.format, ok: false, error: o.message };
      const out = uniquePath(dir, base, o.format);
      fs.copyFileSync(o.path, out);
      return { format: o.format, ok: true, path: out, size: fs.statSync(out).size };
    });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { motive, openTake, exportTake, MOTIVE_FORMATS };
