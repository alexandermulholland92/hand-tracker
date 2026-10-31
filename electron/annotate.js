/**
 * annotate.js — annotating a take or a video (the Recording Converter's Annotate, Windows, Mac and
 * Linux app), the way a capture pipeline's QA and annotation would:
 *   - quality: each camera's pictures looked at twice a second (ffmpeg, small and grey): blurry,
 *     too dark or too bright, how much of it, the longest bad stretch, and a verdict;
 *   - steps: the main camera's video a minute at a time, a frame every 2.5 s, shown to Claude
 *     (the user's own API key, kept encrypted here) with where the hands suggest a step changes
 *     (annotate-core.js), which gives each step's start, end, an instruction-style label, a
 *     sentence of what the person does, its kind (task, setup, waiting, screen, idle) and, for
 *     each frame, whether hands are in sight;
 *   - each step's quality and share of hands in sight, and the useful footage (annotate-core.js).
 * Nothing is sent anywhere but Anthropic's API, and only the frames of the main camera.
 *
 *   const a = new Annotator(userDataDir, safeStorage);
 *   a.hasKey(); a.setKey(key);                    // the Claude API key (encrypted with the OS's keyring)
 *   a.estimate(job) -> { minutes, chunks, frames, dollars }
 *   await a.run(job, onProgress) -> annotations    // job: { videos: [{ camera, path } | { camera, url }], primary,
 *                                                  //   take (its hands) | track (annotate-core's handTrack), task }
 *                                                  //   url: () => a link ffmpeg can read (a session's, signed afresh)
 *   a.cancel();
 *   Annotator.save(annotations, nextTo) -> path      // <take or video>.annotations.json beside it
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const AnnotateCore = require("../annotate-core.js");
const { ffmpegPath, probe } = require("./exporter");

const MODEL = "claude-opus-5-5";
const CHUNK_S = 60; // Claude looks at a minute at a time
const FRAME_EVERY_S = 2.5; // a frame every 2.5 s of it
const FRAME_WIDTH = 512;
const QUALITY_EVERY_S = 0.5;
// What a minute costs, roughly (Claude Opus 5.5: $4 / $20 a million tokens in / out): 24 frames
// of about 200 tokens and the instructions in, the steps (and its thinking) out.
const DOLLARS_PER_MINUTE = (24 * 200 + 900) * 4e-6 + 1500 * 20e-6;

const SYSTEM = `You annotate videos of people doing hands-on tasks, recorded for robot learning. You are shown one stretch of a video as frames, each labelled with its time in seconds, and you divide the stretch into the steps the person goes through.

For each step give:
- start and end, in seconds (the steps cover the whole stretch, end to end, in order);
- label: what the person is doing, as a short instruction to them ("Fold the towel in half", "Pour water into the glass"), or "Transition or idle" when nothing task-related happens;
- description: one plain sentence of what is seen ("The person lifts the lid off the jar and sets it on the table.");
- kind: "task" for hands-on work on the task, "setup" for setting up or calibrating the recording, "waiting" for waiting or watching, "screen" for using a phone, tablet or computer screen, "idle" for transitions and nothing in particular.

Also say, for each frame in order, whether the person's hands are in sight (hands_visible).

Make a new step where the activity changes, not at every frame; a step is usually several seconds to a few minutes long. Times where the hands' movement suggests a change are given as hints: cut there when the activity changes there, and elsewhere when it clearly changes without a hint. If the previous stretch's last step carries on into this one, start with the same label. Describe only what is visible; don't guess at names, brands or identities.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["steps", "hands_visible"],
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "label", "description", "kind"],
        properties: {
          start: { type: "number" },
          end: { type: "number" },
          label: { type: "string" },
          description: { type: "string" },
          kind: { type: "string", enum: AnnotateCore.KINDS },
        },
      },
    },
    hands_visible: { type: "array", items: { type: "boolean" } },
  },
};

const sdk = () => {
  const m = require("@anthropic-ai/sdk");
  return m.default || m.Anthropic || m;
};

class Annotator {
  constructor(dataDir, safe) {
    this.file = path.join(dataDir, "annotate.json");
    this.safe = safe;
    this.canceled = false;
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  // ---------- the Claude API key: the user's own, encrypted with the OS's keyring ----------
  key() {
    const k = this.read().claudeKey;
    try {
      return k && this.safe && this.safe.isEncryptionAvailable() ? this.safe.decryptString(Buffer.from(k, "base64")) : "";
    } catch {
      return "";
    }
  }
  hasKey() {
    return !!this.key();
  }
  setKey(key) {
    const k = String(key || "").trim();
    const cfg = this.read();
    if (!k) delete cfg.claudeKey;
    else {
      if (!this.safe || !this.safe.isEncryptionAvailable()) throw new Error("This computer can't keep the key encrypted.");
      if (k.length > 300 || /\s/.test(k)) throw new Error("That doesn't look like an API key.");
      cfg.claudeKey = this.safe.encryptString(k).toString("base64");
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(cfg, null, 2));
    return !!k;
  }

  // How long the main video is, how many minutes Claude looks at, and roughly what it costs.
  async estimate(job) {
    const main = mainVideo(job);
    const info = await probe(main.path || (await main.url()));
    const minutes = info.duration / 60;
    const chunks = Math.max(1, Math.ceil(info.duration / CHUNK_S));
    return { minutes: Math.round(minutes * 10) / 10, chunks, frames: Math.ceil(info.duration / FRAME_EVERY_S), dollars: Math.round(Math.max(1, minutes) * DOLLARS_PER_MINUTE * 100) / 100, model: MODEL };
  }

  cancel() {
    this.canceled = true;
  }

  // The whole of it: quality, steps, their quality and hands, the useful footage.
  async run(job, onProgress = () => {}) {
    this.canceled = false;
    const key = this.key();
    if (!key) throw new Error("Add your Claude API key first.");
    const videos = (job.videos || []).filter((v) => v && ((v.path && fs.existsSync(v.path)) || typeof v.url === "function"));
    if (!videos.length) throw new Error("There's no video to annotate.");
    const input = async (v) => (v.path ? v.path : await v.url());
    const main = mainVideo({ ...job, videos });
    // Each camera's pictures.
    const cameras = [];
    for (let i = 0; i < videos.length; i++) {
      const v = videos[i];
      onProgress({ stage: "quality", camera: v.camera, index: i, total: videos.length, progress: 0 });
      const info = await probe(await input(v));
      const samples = await qualitySamples(await input(v), info.duration, (p) => onProgress({ stage: "quality", camera: v.camera, index: i, total: videos.length, progress: p }), () => this.canceled);
      if (this.canceled) throw new Error("Canceled.");
      cameras.push({ camera: v.camera, file: v.path ? path.basename(v.path) : v.name || v.camera, primary: v === main, info: { duration: info.duration, fps: info.fps, width: info.width, height: info.height, codec: info.videoCodec },
        quality: AnnotateCore.cameraQuality(samples, { duration: info.duration, every: QUALITY_EVERY_S }), spec: spec(info), samples });
    }
    const mainCam = cameras.find((c) => c.primary);
    const duration = mainCam.info.duration;
    // Where the hands suggest a step changes (from the take's hands, where there's a take).
    const track = job.track && Array.isArray(job.track.visible) ? job.track : job.take && job.take.hands && job.take.hands.length ? AnnotateCore.handTrack(job.take, sameCamera(job.take, main.camera)) : null;
    const cuts = track ? AnnotateCore.candidateCuts(track) : [];
    // Claude, a minute at a time.
    const client = new (sdk())({ apiKey: key });
    const chunks = [], flags = [];
    const total = Math.max(1, Math.ceil(duration / CHUNK_S));
    let previous = null;
    const notes = [];
    for (let c = 0; c < total; c++) {
      if (this.canceled) throw new Error("Canceled.");
      const from = c * CHUNK_S, to = Math.min(duration, from + CHUNK_S);
      onProgress({ stage: "steps", index: c, total, progress: 0 });
      const frames = await frameJpegs(await input(main), from, to);
      if (!frames.length) {
        chunks.push(AnnotateCore.cleanSteps([], from, to));
        continue;
      }
      let answer;
      try {
        answer = await askClaude(client, { frames, from, to, cuts: cuts.filter((t) => t > from && t < to), task: job.task, previous });
      } catch (err) {
        throw plainError(err);
      }
      if (answer.note) notes.push(`${fmt(from)}–${fmt(to)}: ${answer.note}`);
      const steps = AnnotateCore.cleanSteps(answer.steps, from, to, cuts);
      chunks.push(steps);
      (answer.hands_visible || []).forEach((h, i) => frames[i] && flags.push({ t: frames[i].t, hands: !!h }));
      previous = steps[steps.length - 1];
      onProgress({ stage: "steps", index: c, total, progress: 1 });
    }
    const floor = AnnotateCore.sharpFloor(mainCam.samples);
    const segments = AnnotateCore.joinSteps(chunks).map((s) => ({
      ...s,
      hands: AnnotateCore.handsShare(s, track || flags),
      quality: { ...AnnotateCore.stepQuality(s, mainCam.samples, { every: QUALITY_EVERY_S, floor }), camera: mainCam.camera },
      review: "pending",
      parent: null,
    }));
    return {
      format: "hand-tracker-annotations",
      version: 1,
      made: { at: new Date().toISOString(), model: MODEL, task: job.task || "", handsFrom: track ? "take" : "frames", hints: cuts.length },
      source: { take: job.takeName || "", videos: cameras.map((c) => ({ camera: c.camera, file: c.file, primary: c.primary, ...c.info })) },
      quality: { cameras: cameras.map((c) => ({ camera: c.camera, primary: c.primary, ...c.quality, spec: c.spec })) },
      segments,
      useful: AnnotateCore.useful(duration, segments),
      notes,
    };
  }

  // <take or video>.annotations.json beside it (a take's name without its "-video-<camera>").
  static save(annotations, nextTo) {
    const file = String(nextTo || "");
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error("The take or video to save beside isn't there.");
    const base = path.basename(file).replace(/\.[^.]+$/, "").replace(/-video-[a-z0-9-]+$/i, "");
    const out = path.join(path.dirname(file), `${base}.annotations.json`);
    fs.writeFileSync(out, JSON.stringify(annotations, null, 2));
    return out;
  }
  // The segments as a table beside it (<take or video>.annotations.csv).
  static saveCsv(csv, nextTo) {
    const file = String(nextTo || "");
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error("The take or video to save beside isn't there.");
    const base = path.basename(file).replace(/\.[^.]+$/, "").replace(/-video-[a-z0-9-]+$/i, "");
    const out = path.join(path.dirname(file), `${base}.annotations.csv`);
    fs.writeFileSync(out, csv);
    return out;
  }
  // The ones saved beside it, if any.
  static load(nextTo) {
    const file = String(nextTo || "");
    const base = path.basename(file).replace(/\.[^.]+$/, "").replace(/-video-[a-z0-9-]+$/i, "");
    const f = path.join(path.dirname(file), `${base}.annotations.json`);
    if (!fs.existsSync(f)) return null;
    const a = JSON.parse(fs.readFileSync(f, "utf8"));
    return a && a.format === "hand-tracker-annotations" ? { file: f, annotations: a } : null;
  }
}

// The video Claude looks at: the one asked for, else the head camera's, else the first.
function mainVideo(job) {
  const vs = job.videos || [];
  return vs.find((v) => v.camera && v.camera === job.primary) || vs.find((v) => /head/i.test(v.camera || "")) || vs[0];
}
// A take's camera name as its hands have it ("Head Right": "head" -> "Head").
function sameCamera(take, camera) {
  if (!camera) return "";
  const names = new Set(((take && take.hands) || []).map((h) => String(h.handedness || "").split(" ").slice(0, -1).join(" ")).filter(Boolean));
  return [...names].find((n) => n.toLowerCase() === String(camera).toLowerCase()) || "";
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// What a capture's video should be: long enough, a usable size and frame rate.
function spec(info) {
  return [
    { check: "Has length", ok: info.duration > 1 },
    { check: "At least 640 × 360", ok: info.width >= 640 && info.height >= 360 },
    { check: "At least 15 frames a second", ok: !info.fps || info.fps >= 15 },
  ];
}

// ---------- the pictures ----------
// Each half second's picture, 160 wide and grey: its mean brightness and sharpness (the variance
// of its Laplacian).
function qualitySamples(file, duration, onProgress, canceled) {
  const W = 160, H = 90, size = W * H;
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", file, "-an", "-vf", `fps=${1 / QUALITY_EVERY_S},scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"], { windowsHide: true });
    const samples = [];
    let buf = Buffer.alloc(0), err = "";
    proc.stdout.on("data", (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= size) {
        samples.push({ t: Math.round(samples.length * QUALITY_EVERY_S * 100) / 100, ...measure(buf.subarray(0, size), W, H) });
        buf = buf.subarray(size);
        if (duration > 0 && samples.length % 20 === 0) onProgress(Math.min(1, (samples.length * QUALITY_EVERY_S) / duration));
        if (canceled()) proc.kill();
      }
      buf = Buffer.from(buf);
    });
    proc.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 || canceled() ? resolve(samples) : reject(new Error(`ffmpeg couldn't read the video: ${err.trim().split("\n").pop() || code}`))));
  });
}
function measure(px, W, H) {
  let sum = 0;
  for (let i = 0; i < px.length; i++) sum += px[i];
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const l = px[i - W] + px[i + W] + px[i - 1] + px[i + 1] - 4 * px[i];
      s += l;
      s2 += l * l;
      n++;
    }
  }
  const m = s / n;
  return { mean: Math.round((sum / px.length) * 10) / 10, sharp: Math.round((s2 / n - m * m) * 10) / 10 };
}

// The frames Claude sees: from..to, one every 2.5 s, 512 wide, as JPEGs with their times.
function frameJpegs(file, from, to) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", from.toFixed(3), "-i", file, "-t", (to - from).toFixed(3), "-an",
      "-vf", `fps=1/${FRAME_EVERY_S},scale=${FRAME_WIDTH}:-2`, "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "5", "-"], { windowsHide: true });
    const chunks = [];
    let err = "";
    proc.stdout.on("data", (d) => chunks.push(d));
    proc.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg couldn't take frames from the video: ${err.trim().split("\n").pop() || code}`));
      const all = Buffer.concat(chunks), frames = [];
      let at = 0;
      while (at < all.length) {
        const start = all.indexOf(Buffer.from([0xff, 0xd8]), at);
        if (start < 0) break;
        const end = all.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
        if (end < 0) break;
        frames.push({ t: Math.round((from + frames.length * FRAME_EVERY_S) * 10) / 10, data: all.subarray(start, end + 2).toString("base64") });
        at = end + 2;
      }
      resolve(frames);
    });
  });
}

// ---------- Claude ----------
// One stretch's frames to Claude (Opus 5.5; a refusal falls back to Anthropic's chosen model).
// -> { steps, hands_visible, note }
async function askClaude(client, { frames, from, to, cuts, task, previous }) {
  const content = [];
  content.push({ type: "text", text: [
    `This stretch runs from ${from.toFixed(1)} s to ${to.toFixed(1)} s.`,
    task ? `The task being recorded: ${task}` : "The task being recorded wasn't given.",
    previous ? `The previous stretch ended with the step "${previous.label}" (${previous.kind}): ${previous.description}` : "This is the start of the video.",
    cuts.length ? `The hands' movement suggests a change at: ${cuts.map((t) => `${t.toFixed(1)} s`).join(", ")}.` : "The hands' movement suggests no change in this stretch.",
    `${frames.length} frames follow, one every ${FRAME_EVERY_S} s.`,
  ].join("\n") });
  for (const f of frames) {
    content.push({ type: "text", text: `t = ${f.t.toFixed(1)} s` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.data } });
  }
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });
  if (res.stop_reason === "refusal") return { steps: [], hands_visible: [], note: "Claude declined to describe this stretch." };
  if (res.stop_reason === "max_tokens") return { steps: [], hands_visible: [], note: "Claude's answer for this stretch was cut short." };
  const text = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    const j = JSON.parse(text);
    return { steps: Array.isArray(j.steps) ? j.steps : [], hands_visible: Array.isArray(j.hands_visible) ? j.hands_visible : [] };
  } catch {
    return { steps: [], hands_visible: [], note: "Claude's answer for this stretch couldn't be read." };
  }
}

// Claude's API's errors, said plainly (most specific first).
function plainError(err) {
  const A = sdk();
  if (err instanceof A.AuthenticationError) return new Error("Your Claude API key wasn't accepted: check it under Annotate's Claude API key.");
  if (err instanceof A.PermissionDeniedError) return new Error("Your Claude API key isn't allowed to do this (its account or workspace).");
  if (err instanceof A.RateLimitError) return new Error("Claude's API is busy, or your account's limit is reached: try again in a minute.");
  if (err instanceof A.BadRequestError) return new Error(`Claude's API turned the request down: ${err.message}`);
  if (err instanceof A.APIConnectionError) return new Error("Claude's API couldn't be reached: is this computer online?");
  if (err instanceof A.APIError) return new Error(`Claude's API: ${err.message}`);
  return err;
}

module.exports = { Annotator, MODEL, DOLLARS_PER_MINUTE, CHUNK_S, FRAME_EVERY_S, qualitySamples, frameJpegs, measure, SYSTEM, SCHEMA };
