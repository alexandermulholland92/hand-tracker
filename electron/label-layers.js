/**
 * label-layers.js (the desktop app) — a video's labels as a layer of their own (the user, 2026-11-26: "make the
 * labels able to be a separate layer of the video so you can watch them later either baked in or not baked into
 * the video"; "Always save both"; made "After recording", on computers and Pis, not phones).
 *
 * A clip (a remote recording take's camera, Sentry's) is recorded clean while the page sends its labels as subtitle
 * lines (label-layers.js, label-ass.js), kept beside it in the remote recording folder as .labels-<id>.hands /
 * .objects and .labels-<id>.json (what they're of). Once the clip is saved (and its take, whose JSON lists it), it
 * becomes, in the background (one at a time, at low priority, held while anything records):
 *   <name>.mkv           the clean picture (copied, not made again) and sound, with the labels as tracks a player
 *                        switches on: All labels, Hand points, Sentry's boxes, Steps (and a grid's Camera names);
 *   <name> (labels).mp4  the same labels drawn in (made with ffmpeg's libass, so both look the same).
 * The take's JSON then lists the .mkv (file) and the labelled copy (labelled); the clip as recorded (<name>.mp4) goes
 * once no page has read it for a couple of minutes (a phone may have been playing it). Steps: Annotate's (<take or video>.annotations.json), all but rejected ones; when that
 * file changes, the take's (or the video's) .mkv and labelled copies are made again with them (watched folders:
 * the remote recording folder, and each folder a take was opened or a video made in).
 *
 *   const layers = new LabelLayers({ folder, stateFile, busy, onDone, inUse })   // inUse(file): a page reading it now
 *   layers.open() -> id; write(id, { hands, objects }); close(id, { width, height }); discard(id)   // as it records
 *   layers.claim(id, videoPath, takeBase)      // the clip saved there (files:save-remote's labels)
 *   layers.finish({ paths, json })             // its take saved too: made now (paths: its clips')
 *   layers.watch(dir)                          // steps in that folder followed
 *   await layers.bundle(tracks, { width, height }) -> { cwd, inputs, all, fontsdir, attach, done() }   // ASS files
 *                                              //   for exporter.js (a grid, the Record card's video)
 *   await layers.trackLines(mkvPath)           // a .mkv's own tracks: { width, height, tracks: { title: lines } }
 *   layers.stepsFor(dir, base, shift?)         // Steps lines for a video of that take (or that video)
 *   LabelLayers.LABELLED                       // " (labels)": the labelled copy's name ends so
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const LabelAss = require("../label-ass.js");
const exporter = require("./exporter");

const LABELLED = " (labels)";
const ID = /^[\w-]{1,60}$/;
const MAX_LINES_BYTES = 2 * 1024 ** 3; // (a clip's labels: 2 GB at most)
// A file of steps changed: made again once it's been still this long (the checks: shorter).
const STEPS_QUIET_MS = Number(process.env.HAND_TRACKER_LABELS_QUIET_MS) > 0 ? Number(process.env.HAND_TRACKER_LABELS_QUIET_MS) : 20000;
const MAX_WATCHED = 40;
const T = LabelAss.TRACKS;
const ORDER = ["all", "hands", "objects", "steps", "names"];

// The font the labels are drawn in, put beside the tracks (players take it from the .mkv; libass from fontsdir):
// one this computer has, else none (the player's own then).
function fonts() {
  const win = path.join(process.env.WINDIR || "C:\\Windows", "Fonts");
  const choices = process.platform === "win32"
    ? [["Arial", [path.join(win, "arial.ttf"), path.join(win, "arialbd.ttf")]]]
    : process.platform === "darwin"
      ? [["Arial", ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"]], ["Arial", ["/Library/Fonts/Arial.ttf", "/Library/Fonts/Arial Bold.ttf"]]]
      : [
        ["DejaVu Sans", ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]],
        ["DejaVu Sans", ["/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"]],
        ["DejaVu Sans", ["/usr/share/fonts/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"]],
        ["Liberation Sans", ["/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"]],
      ];
  for (const [family, files] of choices) {
    const have = files.filter((f) => fs.existsSync(f));
    if (have.length) return { family, files: have };
  }
  return { family: "Arial", files: [] };
}

// ffmpeg, at low priority, held (Linux and Mac: stopped and started again; Windows: stopped and run again
// after) while busy() says something records. -> resolves when it's done.
function runFfmpeg(args, { cwd, busy = () => false, threads = true } = {}) {
  const pausable = process.platform !== "win32";
  const once = () => new Promise((resolve, reject) => {
    const full = threads ? [...args.slice(0, -1), "-threads", String(Math.max(1, Math.floor(os.cpus().length / 2))), args[args.length - 1]] : args;
    const proc = spawn(exporter.ffmpegPath, full, { cwd, windowsHide: true });
    try {
      os.setPriority(proc.pid, os.constants.priority.PRIORITY_LOW);
    } catch {
      // (left at its own)
    }
    let stderr = "", paused = false, restart = false;
    proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-3000)));
    const timer = setInterval(() => {
      const b = !!busy();
      if (b && !paused) {
        if (pausable) {
          try {
            proc.kill("SIGSTOP");
            paused = true;
          } catch {}
        } else {
          restart = true;
          proc.kill();
        }
      } else if (!b && paused) {
        try {
          proc.kill("SIGCONT");
          paused = false;
        } catch {}
      }
    }, 2000);
    proc.on("error", (err) => {
      clearInterval(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearInterval(timer);
      if (restart) return resolve("again");
      if (code === 0) return resolve("done");
      reject(new Error(stderr.trim().split(/\r?\n/).pop() || `ffmpeg exited with code ${code}`));
    });
  });
  return (async () => {
    for (;;) {
      while (busy()) await new Promise((r) => setTimeout(r, 5000));
      if ((await once()) === "done") return;
    }
  })();
}

// Whether this app's ffmpeg can draw the labels in (its ass filter: libass) and put them in a .mkv: asked once.
// Without it, clips keep their labels drawn in, as before (label-layers.js isn't used: labels:available).
let canDraw = null;
function drawable() {
  if (!canDraw) {
    canDraw = new Promise((resolve) => {
      const proc = spawn(exporter.ffmpegPath, ["-hide_banner", "-filters"], { windowsHide: true });
      let text = "";
      proc.stdout.on("data", (d) => (text += d));
      proc.on("error", () => resolve(false));
      proc.on("close", () => resolve(/^\s*\S*\s+ass\s+V->V/m.test(text)));
    });
  }
  return canDraw;
}

// A .mkv's streams from ffmpeg's own words: [{ index, kind: "Video" | "Audio" | "Subtitle" | "Attachment", codec, title }].
function streamsOf(file) {
  return new Promise((resolve) => {
    const proc = spawn(exporter.ffmpegPath, ["-hide_banner", "-nostdin", "-i", file], { windowsHide: true });
    let text = "";
    proc.stderr.on("data", (d) => (text += d));
    proc.on("error", () => resolve([]));
    proc.on("close", () => {
      const out = [];
      let cur = null;
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*Stream #0:(\d+)[^:]*: (Video|Audio|Subtitle|Attachment|Data): ([\w-]+)/.exec(line);
        if (m) {
          cur = { index: Number(m[1]), kind: m[2], codec: m[3], title: "" };
          out.push(cur);
          continue;
        }
        const t = /^\s+title\s*:\s*(.*)$/.exec(line);
        if (t && cur && !cur.title) cur.title = t[1].trim();
      }
      resolve(out);
    });
  });
}

const readJson = async (file) => {
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch {
    return null;
  }
};
async function writeAtomic(file, text) {
  const part = `${file}.part-${process.pid}`;
  await fs.promises.writeFile(part, text);
  await fs.promises.rename(part, file);
}
const exists = (f) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};
const noExt = (name) => String(name).replace(/\.(mp4|webm|mkv|mov)$/i, "");
// A take's name from one of its camera videos' (<take>-video-<role>.mkv), else the video's own.
const takeOf = (file) => noExt(path.basename(file)).replace(/ \(labels\)$/, "").replace(/-video-[a-z0-9-]+$/i, "");

class LabelLayers {
  constructor({ folder, stateFile = null, busy = () => false, onDone = () => {}, inUse = () => false } = {}) {
    this.folder = folder;
    this.stateFile = stateFile;
    this.busy = busy;
    this.onDone = onDone;
    this.inUse = (file) => {
      try {
        return !!inUse(file);
      } catch {
        return false;
      }
    };
    this.next = 0;
    this.live = new Map(); // id -> { dir, meta, writing, size }
    this.queue = [];
    this.running = false;
    this.watchers = new Map(); // dir -> FSWatcher
    this.quiet = new Map(); // annotations file -> timer
    this.font = fonts();
  }

  // ---------- as a clip records ----------
  paths(dir, id) {
    return { meta: path.join(dir, `.labels-${id}.json`), hands: path.join(dir, `.labels-${id}.hands`), objects: path.join(dir, `.labels-${id}.objects`) };
  }
  async saveMeta(dir, meta) {
    await writeAtomic(this.paths(dir, meta.id).meta, JSON.stringify(meta));
  }
  async open() {
    const dir = this.folder();
    await fs.promises.mkdir(dir, { recursive: true });
    const id = `${process.pid}-${Date.now().toString(36)}-${++this.next}`;
    const meta = { id, made: Date.now(), width: 0, height: 0, closed: false, video: null, take: null, json: null, finish: false };
    const p = this.paths(dir, id);
    await fs.promises.writeFile(p.hands, "");
    await fs.promises.writeFile(p.objects, "");
    await this.saveMeta(dir, meta);
    this.live.set(id, { dir, meta, writing: Promise.resolve(), size: 0 });
    return id;
  }
  async write(id, lines = {}) {
    const c = this.live.get(String(id));
    if (!c) throw new Error("Those labels aren't being recorded.");
    const p = this.paths(c.dir, c.meta.id);
    for (const k of ["hands", "objects"]) {
      const text = typeof lines[k] === "string" ? lines[k] : "";
      if (!text || c.size + text.length > MAX_LINES_BYTES) continue;
      // (only our own lines: each a Dialogue line, nothing else)
      const clean = text.split(/\r?\n/).filter((l) => l.startsWith("Dialogue: ")).join("\n");
      if (!clean) continue;
      c.size += clean.length;
      c.writing = c.writing.then(() => fs.promises.appendFile(p[k], clean + "\n")).catch(() => {});
    }
    await c.writing;
    return c.size;
  }
  async close(id, { width, height } = {}) {
    const c = this.live.get(String(id));
    if (!c) throw new Error("Those labels aren't being recorded.");
    this.live.delete(String(id));
    await c.writing;
    c.meta.width = Math.max(0, Math.min(8192, Math.round(Number(width) || 0)));
    c.meta.height = Math.max(0, Math.min(8192, Math.round(Number(height) || 0)));
    c.meta.closed = true;
    await this.saveMeta(c.dir, c.meta);
    return true;
  }
  async discard(id) {
    const s = String(id);
    if (!ID.test(s)) return false;
    const c = this.live.get(s);
    this.live.delete(s);
    if (c) await c.writing;
    await this.forget(c ? c.dir : this.folder(), s);
    return true;
  }
  async forget(dir, id) {
    for (const f of Object.values(this.paths(dir, id))) await fs.promises.rm(f, { force: true }).catch(() => {});
  }
  // The clip with these labels was saved as videoPath (files:save-remote).
  async claim(id, videoPath, takeBase) {
    const s = String(id);
    if (!ID.test(s)) return false;
    const dir = this.folder();
    const meta = await readJson(this.paths(dir, s).meta);
    if (!meta || meta.id !== s) return false;
    meta.video = videoPath;
    meta.take = typeof takeBase === "string" ? takeBase.slice(0, 200) : null;
    await this.saveMeta(dir, meta);
    return true;
  }
  // Its take was saved (its JSON written, which lists it): made now.
  async finish({ paths, json } = {}) {
    const dir = this.folder();
    const want = new Set((Array.isArray(paths) ? paths : []).map((p) => path.resolve(String(p))));
    if (!want.size) return { queued: 0 };
    // (its JSON: by name, in the same folder)
    const jsonPath = typeof json === "string" && /\.json$/i.test(json) ? path.join(dir, path.basename(json)) : null;
    let queued = 0;
    for (const name of await fs.promises.readdir(dir).catch(() => [])) {
      const m = /^\.labels-([\w-]{1,60})\.json$/.exec(name);
      if (!m) continue;
      const meta = await readJson(path.join(dir, name));
      if (!meta || !meta.video || !want.has(path.resolve(meta.video)) || meta.finish) continue;
      meta.finish = true;
      meta.json = jsonPath;
      await this.saveMeta(dir, meta);
      this.enqueue({ kind: "clip", dir, id: meta.id });
      queued++;
    }
    this.watch(dir);
    return { queued };
  }
  // At start: clips saved but not made yet (the app closed meanwhile) made now; labels of clips never saved
  // (a crash while recording, a day or more ago) thrown away.
  async recover() {
    const dir = this.folder();
    const names = await fs.promises.readdir(dir).catch(() => []);
    for (const name of names) {
      const m = /^\.labels-([\w-]{1,60})\.json$/.exec(name);
      if (!m) continue;
      const meta = await readJson(path.join(dir, name));
      if (!meta) continue;
      // (made already: the clip as recorded still to go)
      if (meta.removeAfter && meta.video) {
        this.removeLater(dir, meta.id, meta.video);
        continue;
      }
      if (meta.video && exists(meta.video)) {
        if (!meta.finish) {
          meta.finish = true;
          meta.json = meta.json || (meta.take ? path.join(dir, `${meta.take}.json`) : null);
          await this.saveMeta(dir, meta).catch(() => {});
        }
        this.enqueue({ kind: "clip", dir, id: meta.id });
      } else if (Date.now() - Number(meta.made || 0) > 24 * 3600e3 && !this.live.has(meta.id)) await this.forget(dir, meta.id);
    }
    for (const d of this.watched()) this.watch(d);
    this.watch(dir);
  }

  // ---------- one at a time ----------
  enqueue(job) {
    const key = JSON.stringify(job);
    if (this.queue.some((j) => JSON.stringify(j) === key)) return;
    this.queue.push(job);
    this.pump();
  }
  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        try {
          if (job.kind === "clip") await this.makeClip(job);
          else if (job.kind === "steps") await this.makeSteps(job.file);
        } catch (err) {
          this.onDone({ ok: false, error: err.message, job });
        }
      }
    } finally {
      this.running = false;
    }
  }

  // ---------- ASS files for ffmpeg ----------
  // tracks: { all?, hands, objects, steps, names } (lines; All labels made from the rest when not given). -> the
  // files in a folder of their own (ffmpeg runs there: the ass filter's arguments stay plain), the font beside.
  async bundle(tracks, { width, height }) {
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hand-tracker-labels-"));
    const t = { ...tracks };
    if (!t.all) t.all = LabelAss.merge(t.hands, t.objects, t.steps, t.names);
    const inputs = [];
    for (const k of ORDER) {
      const lines = t[k];
      if (!Array.isArray(lines) || !lines.length) continue;
      const file = `${k}.ass`;
      await fs.promises.writeFile(path.join(cwd, file), LabelAss.file(lines, { width, height, font: this.font.family }));
      inputs.push({ file: path.join(cwd, file), name: file, title: T[k], key: k });
    }
    let fontsdir = null;
    if (this.font.files.length) {
      await fs.promises.mkdir(path.join(cwd, "fonts"));
      for (const f of this.font.files) await fs.promises.copyFile(f, path.join(cwd, "fonts", path.basename(f))).catch(() => {});
      fontsdir = "fonts";
    }
    // (the font isn't put in the .mkv: a megabyte or two each, and players draw it in theirs, much the same)
    return {
      cwd, inputs, fontsdir, attach: [],
      all: inputs.some((i) => i.key === "all") ? "all.ass" : null,
      done: () => fs.promises.rm(cwd, { recursive: true, force: true }).catch(() => {}),
    };
  }
  // The arguments that put a bundle's tracks into a .mkv: after the inputs given first (n of them).
  static trackArgs(b, n) {
    const inputs = [], maps = [], meta = [];
    b.inputs.forEach((x, i) => {
      inputs.push("-i", x.file);
      maps.push("-map", String(n + i));
      meta.push(`-metadata:s:s:${i}`, `title=${x.title}`);
    });
    const attach = [];
    b.attach.forEach((f, i) => attach.push("-attach", f, `-metadata:s:t:${i}`, "mimetype=application/x-truetype-font"));
    return { inputs, maps, meta: [...meta, ...(b.inputs.length ? ["-disposition:s", "0"] : [])], attach };
  }
  // The ass filter for the labelled copy (ffmpeg's own escaping is kept out: plain names, run in cwd).
  static assFilter(b) {
    return b.all ? `ass=${b.all}${b.fontsdir ? `:fontsdir=${b.fontsdir}` : ""}` : "";
  }

  // A .mkv's own label tracks, read back: { width, height, tracks: { key: lines } }.
  async trackLines(mkv) {
    const subs = (await streamsOf(mkv)).filter((s) => s.kind === "Subtitle" && s.codec === "ass");
    const out = { width: 0, height: 0, tracks: {} };
    if (!subs.length) return out;
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hand-tracker-tracks-"));
    try {
      const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", mkv];
      for (const s of subs) args.push("-map", `0:${s.index}`, "-c", "copy", path.join(cwd, `s${s.index}.ass`));
      await runFfmpeg(args, { threads: false });
      for (const s of subs) {
        const key = Object.keys(T).find((k) => T[k] === s.title);
        if (!key) continue;
        const parsed = LabelAss.parse(await fs.promises.readFile(path.join(cwd, `s${s.index}.ass`), "utf8").catch(() => ""));
        out.width = parsed.width;
        out.height = parsed.height;
        out.tracks[key] = parsed.lines;
      }
    } finally {
      fs.promises.rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
    return out;
  }

  // ---------- steps ----------
  // The Steps lines for one video of a take (file: its name in the take's folder), or for that video itself:
  // <take>.annotations.json's steps, timed by the annotated (primary) video: shifted onto this one's start on the
  // take's clock (grid: true, the take's clock itself). -> lines ([] without any).
  async stepsFor(dir, file, { grid = false, length = Infinity, height = 720 } = {}) {
    const take = grid ? noExt(file).replace(/-video-grid$/i, "") : takeOf(file);
    const own = noExt(path.basename(file)).replace(/ \(labels\)$/, "");
    const annFile = [path.join(dir, `${take}.annotations.json`), path.join(dir, `${own}.annotations.json`)].find(exists);
    if (!annFile) return [];
    const ann = await readJson(annFile);
    if (!ann || !Array.isArray(ann.segments)) return [];
    const json = await readJson(path.join(dir, `${take}.json`));
    const videos = json && Array.isArray(json.videos) ? json.videos : [];
    const startOf = (name) => {
      const v = videos.find((x) => x && typeof x.file === "string" && noExt(x.file) === noExt(name));
      return v && Number.isFinite(Number(v.start_s)) ? Number(v.start_s) : 0;
    };
    const src = ann.source && Array.isArray(ann.source.videos) ? ann.source.videos : [];
    const primary = src.find((v) => v && v.primary) || src[0] || null;
    const primaryStart = primary && primary.file ? startOf(primary.file) : 0;
    const shift = grid ? primaryStart : annFile.endsWith(`${own}.annotations.json`) && own !== take ? 0 : primaryStart - startOf(path.basename(file));
    return LabelAss.stepLines(ann, { shift, length, height });
  }

  // ---------- a clip: made into its .mkv and labelled copy ----------
  async makeClip({ dir, id }) {
    const p = this.paths(dir, id);
    const meta = await readJson(p.meta);
    if (!meta || !meta.video) return this.forget(dir, id);
    const video = meta.video;
    if (!exists(video)) return this.forget(dir, id);
    const unlock = await this.lock(video);
    if (!unlock) return;
    try {
      const info = await exporter.probe(video);
      const width = meta.width || info.width, height = meta.height || info.height;
      const read = async (f) => (await fs.promises.readFile(f, "utf8").catch(() => "")).split(/\r?\n/).filter((l) => l.startsWith("Dialogue: "));
      const tracks = { hands: await read(p.hands), objects: await read(p.objects), steps: await this.stepsFor(dir, path.basename(video), { length: info.duration || Infinity, height }) };
      const base = noExt(path.basename(video));
      const mkv = exporter.uniquePath(dir, base, "mkv");
      const labelled = exporter.uniquePath(dir, base + LABELLED, "mp4");
      await this.make({ source: video, mkv, labelled, tracks, width, height, info });
      // (the clip deleted meanwhile, as a Sentry alert's can be: what was made of it goes too)
      if (!exists(video)) {
        for (const f of [mkv, labelled]) await fs.promises.rm(f, { force: true }).catch(() => {});
        return this.forget(dir, id);
      }
      // The take's JSON lists the .mkv now (and its labelled copy).
      if (meta.json && exists(meta.json)) await this.relist(meta.json, path.basename(video), path.basename(mkv), path.basename(labelled)).catch(() => {});
      await this.saveMeta(dir, { ...meta, removeAfter: true, mkv, labelled });
      this.onDone({ ok: true, from: video, mkv, labelled, json: meta.json || null });
      this.removeLater(dir, id, video);
    } finally {
      await unlock();
    }
  }
  // The clip as recorded goes once its .mkv and labelled copy are made, when no page has read it for a while (a
  // phone may be playing or downloading it, just after it was saved: inUse, remote-record.js's reads). At most
  // half an hour's wait; noted (removeAfter), so a start of the app finishes it.
  async removeLater(dir, id, video) {
    const until = Date.now() + 30 * 60e3;
    while (Date.now() < until && exists(video) && this.inUse(video)) await new Promise((r) => setTimeout(r, 5000));
    await fs.promises.rm(video, { force: true }).catch(() => {});
    await this.forget(dir, id);
  }
  async relist(jsonPath, from, mkv, labelled) {
    const data = await readJson(jsonPath);
    if (!data || !Array.isArray(data.videos)) return;
    let changed = false;
    for (const v of data.videos) {
      if (v && v.file === from) {
        v.file = mkv;
        v.labelled = labelled;
        changed = true;
      }
    }
    if (changed) await writeAtomic(jsonPath, JSON.stringify(data));
  }

  // The clean .mkv (the source's picture and sound copied, the tracks beside them) and the labelled copy.
  // source may be the .mkv itself (steps made again): then it's made beside it and put in its place.
  async make({ source, mkv, labelled, tracks, width, height, info }) {
    const b = await this.bundle(tracks, { width, height });
    // (made as hidden files beside them, so nothing lists them meanwhile: remote-record.js's takes)
    const hidden = (f) => path.join(path.dirname(f), `.${path.basename(f)}.part`);
    const mkvPart = hidden(mkv), labPart = hidden(labelled);
    try {
      const same = path.resolve(source) === path.resolve(mkv);
      const a = LabelLayers.trackArgs(b, 1);
      await runFfmpeg(["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", source, ...a.inputs,
        "-map", "0:v:0", "-map", "0:a?", ...a.maps, "-c", "copy", ...a.meta, ...a.attach, "-f", "matroska", mkvPart], { cwd: b.cwd, busy: this.busy, threads: false });
      // The labelled copy: drawn in, made again (an even size, as H.264 needs); with nothing to draw, a copy.
      const ass = LabelLayers.assFilter(b);
      const aac = info && /aac/i.test(String(info.audioCodec || "aac"));
      const args = ass
        ? ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", source, "-map", "0:v:0", "-map", "0:a?", "-vf", `${ass},scale=trunc(iw/2)*2:trunc(ih/2)*2`,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", ...(aac ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "128k"]), "-movflags", "+faststart", "-f", "mp4", labPart]
        : ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", source, "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", labPart];
      await runFfmpeg(args, { cwd: b.cwd, busy: this.busy, threads: !!ass });
      await fs.promises.rename(labPart, labelled);
      if (same) await fs.promises.rm(mkv, { force: true });
      await fs.promises.rename(mkvPart, mkv);
    } catch (err) {
      for (const f of [mkvPart, labPart]) await fs.promises.rm(f, { force: true }).catch(() => {});
      throw err;
    } finally {
      await b.done();
    }
  }

  // One of these apps at a time on a file (another on this computer may be at it: it's left to that one).
  // -> a function that lets it go, or null.
  async lock(file) {
    const lock = path.join(path.dirname(file), `.${path.basename(file)}.labels-lock`);
    const take = async () => {
      const h = await fs.promises.open(lock, "wx");
      return async () => {
        await h.close().catch(() => {});
        await fs.promises.rm(lock, { force: true }).catch(() => {});
      };
    };
    try {
      return await take();
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs < 3600e3) return null;
        await fs.promises.rm(lock, { force: true });
        return await take();
      } catch {
        return null;
      }
    }
  }

  // ---------- steps changed: made again ----------
  watched() {
    if (!this.stateFile) return [];
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      return Array.isArray(s.dirs) ? s.dirs.filter((d) => typeof d === "string") : [];
    } catch {
      return [];
    }
  }
  watch(dir) {
    const d = path.resolve(String(dir || ""));
    if (!d || this.watchers.has(d) || !fs.existsSync(d)) return;
    try {
      const w = fs.watch(d, { persistent: false }, (_event, name) => {
        if (name && /\.annotations\.json$/i.test(String(name))) this.stepsChanged(path.join(d, String(name)));
      });
      w.on("error", () => this.watchers.delete(d));
      this.watchers.set(d, w);
    } catch {
      return;
    }
    if (this.stateFile && path.resolve(this.folder()) !== d) {
      const dirs = [d, ...this.watched().filter((x) => path.resolve(x) !== d)].slice(0, MAX_WATCHED);
      try {
        fs.writeFileSync(this.stateFile, JSON.stringify({ dirs }));
      } catch {}
    }
  }
  stepsChanged(file) {
    clearTimeout(this.quiet.get(file));
    this.quiet.set(file, setTimeout(() => {
      this.quiet.delete(file);
      this.enqueue({ kind: "steps", file });
    }, STEPS_QUIET_MS));
  }
  // The take's camera videos (its JSON's .mkv ones) and its grid, or the video of that name, made again.
  async makeSteps(annFile) {
    const dir = path.dirname(annFile);
    const base = path.basename(annFile).replace(/\.annotations\.json$/i, "");
    const targets = [];
    const json = await readJson(path.join(dir, `${base}.json`));
    if (json && Array.isArray(json.videos)) {
      for (const v of json.videos) {
        if (!v || typeof v.file !== "string" || path.basename(v.file) !== v.file || !/\.mkv$/i.test(v.file)) continue;
        if (exists(path.join(dir, v.file))) targets.push({ mkv: path.join(dir, v.file), labelled: path.join(dir, typeof v.labelled === "string" && path.basename(v.labelled) === v.labelled ? v.labelled : `${noExt(v.file)}${LABELLED}.mp4`) });
      }
      const grid = path.join(dir, `${base}-video-grid.mkv`);
      if (exists(grid)) targets.push({ mkv: grid, labelled: path.join(dir, `${base}-video-grid${LABELLED}.mp4`), grid: true });
    } else if (exists(path.join(dir, `${base}.mkv`))) targets.push({ mkv: path.join(dir, `${base}.mkv`), labelled: path.join(dir, `${base}${LABELLED}.mp4`) });
    for (const t of targets) {
      const unlock = await this.lock(t.mkv);
      if (!unlock) continue;
      try {
        const info = await exporter.probe(t.mkv);
        const own = await this.trackLines(t.mkv);
        const width = own.width || info.width, height = own.height || info.height;
        const steps = await this.stepsFor(dir, path.basename(t.mkv), { grid: !!t.grid, length: info.duration || Infinity, height });
        const tracks = { hands: own.tracks.hands, objects: own.tracks.objects, names: own.tracks.names, steps };
        await this.make({ source: t.mkv, mkv: t.mkv, labelled: t.labelled, tracks, width, height, info });
        this.onDone({ ok: true, steps: true, mkv: t.mkv, labelled: t.labelled });
      } finally {
        await unlock();
      }
    }
  }
}

LabelLayers.LABELLED = LABELLED;
LabelLayers.drawable = drawable;
LabelLayers.fonts = fonts;
LabelLayers.runFfmpeg = runFfmpeg;
LabelLayers.streamsOf = streamsOf;
module.exports = LabelLayers;
