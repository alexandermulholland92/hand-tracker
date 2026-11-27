/**
 * baby-monitor.js — Baby monitor mode (the user, 2026-11-26: "a baby monitor mode that gives notifications when
 * activated by sound"). A rig listens: a computer's or Pi's microphone (a USB one, a webcam's, a Kinect's), or a
 * phone's, left in the room with the app open (its screen kept awake and dimmed). Sound sets it off, as its
 * settings say: loud sound (louder than the room usually is, by a margin, for a second or more) or crying only
 * (MediaPipe's sound classifier, YAMNet: its "Baby cry, infant cry", sound-classifier.js).
 *
 * It's set up and seen on remote recording's page, hidden with Sentry's (the title tapped five times shows both).
 * An alert is told as Sentry's are: the phones' Hand Tracker app watching this rig reads it in its state
 * (baby.events, SentryWatchService.java), and ntfy (Sentry's ntfy settings; a phone listening sends it itself).
 * Its switches (2026-11-26: "Switches"; with all off, an alert is just the notification):
 *   - Sound clip: what it heard from a few seconds before it went off until it's quiet again, saved as a WAV
 *     beside the takes (Baby_<where>_<when>-sound.wav);
 *   - Video clip: every camera records with sound meanwhile, as Sentry's clips (its labels a layer of their own
 *     where the app can: label-layers.js) (Baby_<camera>_<when>-video.mp4);
 *   - Listen live: the page plays what the microphone hears (the server's /api/listen: 16 kHz mono PCM).
 * Talking to the baby (2026-11-27): remote recording's page sends its microphone's sound (the server's /api/talk),
 * played here; its alerts paused meanwhile (talkChunk).
 * One episode: from the sound until QUIET_S of quiet (at most MAX_S); a notification at most every ALERT_GAP_S.
 *
 *   BabyMonitor.init({ prefs, setPref, host, views, hostName, link, phone, shown, onArmed })
 *     views() -> remote recording's cameras (MultiCamera.sentryViews()); shown() -> Sentry's panel is shown
 *   BabyMonitor.remoteState()     // for the page (remote-record-ui.js state.baby)
 *   BabyMonitor.command(c)        // from the page: { armed, trigger, sensitivity, soundClip, videoClip, listen, mic,
 *                                 //   deleteAlerts: [ids], deleteAll, test } -> { ok, message }
 *   BabyMonitor.wantListen(on)    // someone's listening live (the server says): its sound sent meanwhile
 *   BabyMonitor._test             // feed(samples), events, cfg, … (the checks)
 */
(function (global) {
  const RATE = 16000; // what it listens at (and YAMNet's)
  const CHUNK = 1600; // samples a look: a tenth of a second
  const PRE_S = 5; // a sound clip starts this long before it went off
  const QUIET_S = 15; // an episode ends after this long without the sound
  const MAX_S = 600; // or this long, whatever
  const ALERT_GAP_S = 120; // a notification at most this often
  const FLOOR_S = 60; // the room's usual level: over the last minute
  const ABS_MIN_DB = -50; // never quieter than this sets it off
  // Loud sound: this many dB over the room's usual level, for half of the last 2 s; crying: YAMNet's score.
  const LOUD = { low: 20, medium: 14, high: 9 };
  const CRY = { low: 0.5, medium: 0.3, high: 0.15 };
  const CRY_LOOK_MS = 500; // how often crying is looked for (while there's any sound)
  const MAX_EVENTS = 50;
  const TRIGGERS = ["loud", "crying"];

  let prefs = {}, setPref = () => {}, host = null, viewsOf = () => [], hostName = () => "", linkOf = () => "", phone = false, shownOf = () => false;
  let onArmed = () => {};
  let cfg = null;
  const events = [];
  let note = "";

  const errText = (err) => (err && err.message ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  function defaults() {
    return { armed: false, trigger: "loud", sensitivity: "medium", soundClip: true, videoClip: false, listen: false, mic: "" };
  }
  function load() {
    const s = prefs.babyMonitor && typeof prefs.babyMonitor === "object" ? prefs.babyMonitor : {};
    const d = defaults();
    cfg = {
      ...d,
      ...Object.fromEntries(["armed", "soundClip", "videoClip", "listen"].filter((k) => typeof s[k] === "boolean").map((k) => [k, s[k]])),
      trigger: TRIGGERS.includes(s.trigger) ? s.trigger : d.trigger,
      sensitivity: LOUD[s.sensitivity] ? s.sensitivity : d.sensitivity,
      mic: typeof s.mic === "string" ? s.mic.slice(0, 200) : "",
    };
  }
  const save = () => setPref("babyMonitor", cfg);

  // ---------- listening ----------
  // The microphone at 16 kHz (an AudioWorklet averages it down from the device's rate: baby-monitor-worklet.js), a
  // tenth of a second at a time (onChunk). The last PRE_S + 1 s kept (ring), for a sound clip's start and crying's
  // looks.
  let mic = null; // { stream, ctx, node }
  let starting = null;
  const ring = new Float32Array(RATE * (PRE_S + 1));
  let ringAt = 0, heard = 0; // where the next sample goes; samples so far
  let heardReal = 0, testOnly = false; // (the checks: the microphone's tenths heard; only theirs looked at)
  async function startListening() {
    if (mic || starting) return starting;
    starting = (async () => {
      if (!global.navigator || !navigator.mediaDevices || !global.AudioContext || !global.AudioWorkletNode) throw new Error("This browser can't listen.");
      const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
      if (cfg.mic) audio.deviceId = { exact: cfg.mic };
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      } catch (err) {
        if (!cfg.mic) throw err;
        delete audio.deviceId; // (the microphone picked isn't there: the usual one)
        stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      }
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule(new URL("baby-monitor-worklet.js", global.location.href).href);
      const node = new AudioWorkletNode(ctx, "baby-monitor-tap");
      node.port.onmessage = (e) => {
        heardReal++;
        if (!testOnly) onChunk(e.data);
      };
      // (pulled through a silent gain to the speakers, so it's processed; nothing is heard here)
      const silent = ctx.createGain();
      silent.gain.value = 0;
      ctx.createMediaStreamSource(stream).connect(node);
      node.connect(silent).connect(ctx.destination);
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      // (a page that may not start sound by itself, a phone's turned on from elsewhere: started at its first touch)
      if (ctx.state !== "running" && global.document) {
        note = "Tap this screen once to start listening.";
        const go = () => ctx.resume().then(() => (note = "")).catch(() => {});
        document.addEventListener("pointerdown", go, { once: true });
      }
      mic = { stream, ctx, node };
      stream.getAudioTracks().forEach((t) => (t.onended = () => {
        note = "The microphone stopped: trying it again…";
        stopListening();
        setTimeout(() => cfg.armed && startListening().catch(() => {}), 3000);
      }));
    })();
    try {
      await starting;
      note = "";
    } catch (err) {
      note = `It can't listen: ${errText(err)}`;
      throw err;
    } finally {
      starting = null;
    }
  }
  function stopListening() {
    const m = mic;
    mic = null;
    if (!m) return;
    try {
      m.node.port.onmessage = null;
      m.stream.getTracks().forEach((t) => t.stop());
      m.ctx.close();
    } catch {
      // (already gone)
    }
  }

  // ---------- each tenth of a second ----------
  const levels = []; // dB of each look, the last FLOOR_S
  let floor = -70; // the room's usual level (its 20th percentile over the last minute)
  let lastFloorAt = 0;
  const recent = []; // whether each of the last 20 looks was loud
  let cryLooks = []; // the last 4 crying looks: scores
  let lastCryLookAt = 0, crying = 0, looking = false;
  let episode = null; // { at, lastAt, event, pcm: [Float32Array], videos: [{ view, rec, layer }] }
  let lastAlertAt = 0;
  let listeners = false;

  const dbOf = (samples) => {
    let s = 0;
    for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
    return 20 * Math.log10(Math.sqrt(s / Math.max(1, samples.length)) + 1e-9);
  };
  function remember(samples) {
    for (let i = 0; i < samples.length; i++) {
      ring[ringAt] = samples[i];
      ringAt = (ringAt + 1) % ring.length;
    }
    heard += samples.length;
  }
  // The last n samples heard, oldest first.
  function lastSamples(n) {
    const k = Math.min(n, ring.length, heard);
    const out = new Float32Array(k);
    for (let i = 0; i < k; i++) out[i] = ring[(ringAt - k + i + ring.length * 2) % ring.length];
    return out;
  }
  function onChunk(samples, now = Date.now()) {
    remember(samples);
    const db = dbOf(samples);
    // (someone talking to the room through its speaker: nothing it hears meanwhile counts, talking)
    const hush = talking();
    if (!hush) {
      levels.push(db);
      if (levels.length > (FLOOR_S * RATE) / CHUNK) levels.shift();
    }
    if (!hush && now - lastFloorAt > 1000 && levels.length >= 10) {
      const sorted = levels.slice().sort((a, b) => a - b);
      floor = sorted[Math.floor(sorted.length * 0.2)];
      lastFloorAt = now;
    }
    const over = !hush && db >= Math.max(ABS_MIN_DB, floor + LOUD[cfg.sensitivity]);
    recent.push(over);
    if (recent.length > 20) recent.shift();
    if (listeners && cfg.listen) sendLive(samples);
    showLevel(db);
    if (episode && episode.pcm) episode.pcm.push(samples.slice());
    // Crying: looked for while there's any sound (it's quiet otherwise: no look needed).
    if (!hush && cfg.trigger === "crying" && !looking && now - lastCryLookAt >= CRY_LOOK_MS && db > floor + 6 && heard >= RATE) {
      lastCryLookAt = now;
      lookForCrying(now);
    }
    const loudNow = recent.filter(Boolean).length >= 10;
    const set = !hush && (cfg.trigger === "crying" ? cryLooks.filter((s) => s >= CRY[cfg.sensitivity]).length >= 2 : loudNow);
    const goingOn = !hush && (cfg.trigger === "crying" ? crying >= CRY[cfg.sensitivity] : over);
    if (set) setOff(now, db);
    else if (episode && goingOn) episode.lastAt = now;
    if (episode && (now - episode.lastAt > QUIET_S * 1000 || now - episode.at > MAX_S * 1000)) endEpisode(now);
  }
  async function lookForCrying(now) {
    if (!global.SoundClassifier) return;
    looking = true;
    try {
      crying = await global.SoundClassifier.cryScore(lastSamples(15600), RATE);
      cryLooks.push(crying);
      if (cryLooks.length > 4) cryLooks.shift();
      if (classifierNote) classifierNote = "";
    } catch (err) {
      classifierNote = `Crying can't be told yet: ${errText(err)}`;
    } finally {
      looking = false;
    }
  }
  let classifierNote = "";

  // ---------- set off ----------
  function setOff(now, db) {
    if (episode) {
      episode.lastAt = now;
      return;
    }
    const at = new Date(now);
    const event = { id: `${now}-${Math.random().toString(36).slice(2, 7)}`, at: now, sound: cfg.trigger, db: Math.round(db), audio: null, videos: [], seconds: 0, problem: "" };
    events.unshift(event);
    events.length = Math.min(events.length, MAX_EVENTS);
    // (a sound clip from PRE_S before; what's heard from now on is added as it comes, onChunk)
    episode = { at: now, lastAt: now, event, pcm: cfg.soundClip ? [lastSamples(RATE * PRE_S)] : null, videos: [], name: baseName(at) };
    if (cfg.videoClip) startVideos(episode);
    cryLooks = [];
    if (now - lastAlertAt >= ALERT_GAP_S * 1000) {
      lastAlertAt = now;
      notify(event).catch((err) => (event.problem = `ntfy: ${errText(err)}`));
    }
  }
  function baseName(at, where = hostName() || (phone ? "Phone" : "Room")) {
    const p = (n) => String(n).padStart(2, "0");
    const w = String(where).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "Room";
    return `Baby_${w}_${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}_${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}`;
  }
  const what = (e) => (e.sound === "crying" ? "Crying" : "A loud sound");
  async function notify(e) {
    const t = new Date(e.at), p = (n) => String(n).padStart(2, "0");
    const message = `${what(e)} at ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}${hostName() ? ` on ${hostName()}` : ""}.`;
    const link = linkOf() || "";
    // (through Sentry's ntfy settings, while its ntfy is on; and Home Assistant's webhook, while that's on)
    if (global.Sentry && global.Sentry.homeAssistant) global.Sentry.homeAssistant({ kind: "baby", event: "alert", id: e.id, at: e.at, sound: e.sound }).catch(() => {});
    if (global.Sentry && global.Sentry.notify) await global.Sentry.notify({ title: "Baby monitor", message, tags: "baby", click: link ? `${link.replace(/#.*$/, "")}#baby=${e.id}` : "" });
  }
  // (its length: from the sound starting to its last, the quiet after left out)
  async function endEpisode(now = Date.now()) {
    const ep = episode;
    episode = null;
    if (!ep) return;
    ep.event.seconds = Math.max(1, Math.round((Math.min(now, ep.lastAt) - ep.at) / 1000));
    const problems = [];
    if (ep.pcm) {
      try {
        ep.event.audio = await saveWav(ep.name, ep.pcm);
      } catch (err) {
        problems.push(`no sound clip (${errText(err)})`);
      }
    }
    for (const v of ep.videos) {
      try {
        const name = await stopVideo(ep.name, v);
        if (name) ep.event.videos.push(name);
      } catch (err) {
        problems.push(`no video of ${v.view.name} (${errText(err)})`);
      }
    }
    if (problems.length) ep.event.problem = [ep.event.problem, ...problems].filter(Boolean).join(" · ");
    // (its sound clip and first video to Home Assistant too, while its webhook is on)
    if ((ep.event.audio || ep.event.videos.length) && global.Sentry && global.Sentry.homeAssistant) {
      global.Sentry.homeAssistant({ kind: "baby", event: "clip", id: ep.event.id, at: ep.event.at, sound: ep.event.sound, seconds: ep.event.seconds },
        { sound: ep.event.audio || "", video: ep.event.videos[0] || "" }).catch(() => {});
    }
  }

  // ---------- a sound clip: a WAV (16-bit, mono, 16 kHz) ----------
  function wav(chunks) {
    const n = chunks.reduce((a, c) => a + c.length, 0);
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
    str(0, "RIFF");
    v.setUint32(4, 36 + n * 2, true);
    str(8, "WAVEfmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, RATE, true);
    v.setUint32(28, RATE * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, "data");
    v.setUint32(40, n * 2, true);
    let o = 44;
    for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767))), true);
    return new Uint8Array(buf);
  }
  async function saveWav(name, chunks) {
    if (!host || !host.remote || !host.remote.saveTake) throw new Error("it can't be saved here");
    const res = await host.remote.saveTake({ baseName: name, files: [{ format: "wav", suffix: "-sound", ext: "wav", data: wav(chunks) }] });
    const r = (res.results || [])[0];
    if (!r || !r.ok) throw new Error((r && r.error) || "it couldn't be saved");
    return r.path.split(/[\\/]/).pop();
  }

  // ---------- every camera's video, with sound ----------
  const labelsSink = () => (host && host.remote && host.remote.labels && global.LabelLayers && global.LabelLayers.ready(host.remote.labels) ? host.remote.labels : null);
  function startVideos(ep) {
    if (!global.CameraVideo || !global.CameraVideo.supported()) return;
    let views = [];
    try {
      views = viewsOf() || [];
    } catch {
      views = [];
    }
    for (const view of views) {
      let layer = null;
      try {
        const canvas = view.canvas();
        if (!canvas) continue;
        if (view.want) view.want(true);
        layer = labelsSink() ? global.LabelLayers.record(canvas, labelsSink()) : null;
        const file = host && host.remote && host.remote.clip && host.remote.saveTake ? host.remote.clip : null;
        const fps = view.fps && view.fps() > 45 ? 60 : 30;
        const rec = global.CameraVideo.start({ canvas: layer ? layer.canvas : canvas, fps, audio: true, preferMp4: true, file });
        ep.videos.push({ view, rec, layer });
      } catch (err) {
        if (layer) layer.discard().catch(() => {});
        if (view.want) view.want(false);
        ep.event.problem = [ep.event.problem, `no video of ${view.name} (${errText(err)})`].filter(Boolean).join(" · ");
      }
    }
  }
  async function stopVideo(name, v) {
    if (v.view.want) v.view.want(false);
    const clip = await v.rec.stop();
    const labels = v.layer ? await v.layer.stop().catch(() => null) : null;
    const drop = () => (labels && host.remote.labels ? host.remote.labels.discard(labels).catch(() => {}) : null);
    if (!clip.size) {
      if (clip.fileId !== null && host.remote.clip) await host.remote.clip.discard(clip.fileId).catch(() => {});
      await drop();
      return null;
    }
    const cam = String(v.view.name || "Camera").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "Camera";
    const base = name.replace(/^Baby_[^_]+_/, `Baby_${cam}_`);
    const data = clip.fileId === null ? new Uint8Array(await clip.blob.arrayBuffer()) : undefined;
    const res = await host.remote.saveTake({ baseName: base, files: [{ format: clip.ext, suffix: "-video", ext: clip.ext, ...(clip.fileId === null ? { data } : { clipId: clip.fileId }), mimeType: clip.mimeType, ...(labels ? { labels } : {}) }] });
    const r = (res.results || [])[0];
    if (!r || !r.ok) {
      await drop();
      throw new Error((r && r.error) || "it couldn't be saved");
    }
    if (labels && host.remote.labels) host.remote.labels.finish({ paths: [r.path] }).catch(() => {});
    return r.path.split(/[\\/]/).pop();
  }

  // ---------- listening live ----------
  // 16-bit samples, sent on as they come while someone listens (the server's /api/listen).
  function sendLive(samples) {
    const l = host && host.remote && host.remote.listen;
    if (!l || !l.write) return;
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
    try {
      l.write(new Uint8Array(out.buffer));
    } catch {
      // (nobody there any more)
    }
  }
  // (on: a boolean, the desktop app's; { on }, a phone's RigServer event)
  function wantListen(on) {
    listeners = on && typeof on === "object" ? !!on.on : !!on;
  }

  // ---------- talking to the baby (the user, 2026-11-27: "two way communication so you can speak to the baby") ----------
  // Someone's voice from remote recording's page (tap to talk, again to stop: its /api/talk, 16 kHz G.711 µ-law a
  // quarter of a second at a time), played here a moment behind so it's smooth. The alerts are paused meanwhile and
  // TALK_QUIET_MS after its last sound (its own speaker doesn't set it off), and the room's usual level isn't learnt
  // from it. Nothing more of it for TALK_IDLE_MS: it's over.
  const TALK_QUIET_MS = 5000;
  const TALK_IDLE_MS = 3000;
  let talk = null; // { ctx, out, own, next, idle }
  let talkQuietUntil = 0, talkQuietMs = TALK_QUIET_MS, talked = 0;
  const ULAW = (() => {
    const t = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const u = ~i & 0xff, exp = (u >> 4) & 7;
      const s = ((((u & 0x0f) << 3) + 0x84) << exp) - 0x84;
      t[i] = (u & 0x80 ? -s : s) / 32768;
    }
    return t;
  })();
  const talking = () => !!talk || Date.now() < talkQuietUntil;
  function bytesOf(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof data === "string" && global.atob) {
      // (a phone's RigServer: base64)
      try {
        const s = global.atob(data);
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
      } catch {
        return null;
      }
    }
    return null;
  }
  function talkChunk(t) {
    if (!t) return;
    if (t.stop) return endTalk();
    if (!cfg || !cfg.armed) return;
    const bytes = bytesOf(t.data);
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!bytes || !bytes.length || !AC) return;
    if (!talk) {
      // (the microphone's own sound, which is running already, a phone's started at a touch; else one of its own)
      const own = !(mic && mic.ctx && mic.ctx.state !== "closed");
      const ctx = own ? new AC() : mic.ctx;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const out = ctx.createGain();
      out.connect(ctx.destination);
      talk = { ctx, out, own, next: 0, idle: null };
      cryLooks = [];
      recent.length = 0;
    }
    const buf = talk.ctx.createBuffer(1, bytes.length, RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < bytes.length; i++) ch[i] = ULAW[bytes[i]];
    const src = talk.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(talk.out);
    const now = talk.ctx.currentTime;
    if (talk.next < now + 0.05 || talk.next > now + 2) talk.next = now + 0.25;
    src.start(talk.next);
    talk.next += buf.duration;
    talked += bytes.length;
    clearTimeout(talk.idle);
    talk.idle = setTimeout(endTalk, TALK_IDLE_MS);
  }
  function endTalk() {
    const t = talk;
    talk = null;
    if (!t) return;
    clearTimeout(t.idle);
    // (its last sound still to be played: the alerts listen again TALK_QUIET_MS after that)
    const left = t.ctx.state === "running" ? Math.max(0, t.next - t.ctx.currentTime) : 0;
    talkQuietUntil = Date.now() + left * 1000 + talkQuietMs;
    recent.length = 0;
    setTimeout(() => {
      try {
        t.out.disconnect();
        if (t.own) t.ctx.close().catch(() => {});
      } catch {
        // (already gone)
      }
    }, left * 1000 + 500);
  }

  // ---------- a phone listening: its screen kept awake (the app keeps it so) and dimmed ----------
  // (2026-11-26: "App open, screen dim") A black screen over the app with how loud it is; a tap wakes it for a
  // minute. The screen's own brightness turned down meanwhile (RigServer's dim, where the app has it).
  let dimmer = null, dimTimer = null;
  const dimScreen = (on) => {
    const r = host && host.remote;
    if (r && r.dim) r.dim(on);
  };
  function showDimmer() {
    if (!phone || !global.document || !cfg.armed) return;
    if (!dimmer) {
      dimmer = document.createElement("div");
      dimmer.id = "babyDimmer";
      dimmer.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:#000;color:#5a5a5a;display:none;flex-direction:column;" +
        "align-items:center;justify-content:center;gap:14px;font:16px system-ui,sans-serif;text-align:center;user-select:none";
      const title = Object.assign(document.createElement("div"), { textContent: "Baby monitor listening" });
      const bar = Object.assign(document.createElement("div"), { id: "babyDimLevel" });
      bar.style.cssText = "width:60%;height:6px;background:#1c1c1c;border-radius:3px;overflow:hidden";
      bar.appendChild(Object.assign(document.createElement("div"), { className: "fill" })).style.cssText = "height:100%;width:0;background:#2f6b45";
      const hint = Object.assign(document.createElement("div"), { textContent: "Tap to wake the screen" });
      hint.style.fontSize = "13px";
      dimmer.append(title, bar, hint);
      dimmer.addEventListener("click", wake);
      document.body.appendChild(dimmer);
    }
    dimmer.style.display = "flex";
    dimScreen(true);
  }
  function hideDimmer() {
    if (dimmer) dimmer.style.display = "none";
    dimScreen(false);
  }
  function wake() {
    hideDimmer();
    clearTimeout(dimTimer);
    dimTimer = setTimeout(() => cfg.armed && showDimmer(), 60000);
  }
  function showLevel(db) {
    if (!dimmer || dimmer.style.display === "none") return;
    const fill = dimmer.querySelector(".fill");
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, ((db - floor) / 30) * 100))}%`;
  }

  // ---------- on and off ----------
  function setArmed(on) {
    cfg.armed = !!on;
    if (cfg.armed) {
      startListening().catch(() => {});
      if (cfg.trigger === "crying" && global.SoundClassifier) global.SoundClassifier.load().catch((err) => (classifierNote = `Crying can't be told: ${errText(err)}`));
      showDimmer();
    } else {
      if (episode) endEpisode();
      endTalk();
      stopListening();
      clearTimeout(dimTimer);
      hideDimmer();
    }
    onArmed(cfg.armed);
  }

  // ---------- the page ----------
  function remoteState() {
    if (!cfg) return null;
    const shown = !!shownOf();
    if (!shown && !cfg.armed) return { shown: false, armed: false };
    const last = levels.length ? levels[levels.length - 1] : null;
    return {
      shown, armed: cfg.armed, trigger: cfg.trigger, sensitivity: cfg.sensitivity, soundClip: cfg.soundClip, videoClip: cfg.videoClip, listen: cfg.listen, mic: cfg.mic,
      listening: !!mic, phone,
      canTalk: !!(host && host.remote && host.remote.talk), talking: !!talk,
      level: last === null ? null : { db: Math.round(last), usual: Math.round(floor), over: Math.round(floor + LOUD[cfg.sensitivity]), crying: cfg.trigger === "crying" ? Math.round(crying * 100) / 100 : null },
      episode: episode ? { at: episode.at, sound: episode.event.sound } : null,
      model: global.SoundClassifier ? global.SoundClassifier.status() : "none",
      note: [note, classifierNote].filter(Boolean).join(" "),
      canDelete: !!(host && host.remote && host.remote.deleteSentry),
      events: events.slice(0, 20).map((e) => ({ id: e.id, at: e.at, sound: e.sound, seconds: e.seconds, audio: e.audio, videos: e.videos.slice(), problem: e.problem })),
    };
  }
  async function command(c = {}) {
    let message = "";
    if (TRIGGERS.includes(c.trigger)) {
      cfg.trigger = c.trigger;
      cryLooks = [];
      if (cfg.trigger === "crying" && cfg.armed && global.SoundClassifier) global.SoundClassifier.load().catch((err) => (classifierNote = `Crying can't be told: ${errText(err)}`));
      message = cfg.trigger === "crying" ? "Only crying sets it off now." : "Loud sound sets it off now.";
    }
    if (LOUD[c.sensitivity]) cfg.sensitivity = c.sensitivity;
    for (const k of ["soundClip", "videoClip", "listen"]) if (typeof c[k] === "boolean") cfg[k] = c[k];
    if (typeof c.mic === "string" && c.mic !== cfg.mic) {
      cfg.mic = c.mic.slice(0, 200);
      if (mic) {
        stopListening();
        startListening().catch(() => {});
      }
    }
    if (Array.isArray(c.deleteAlerts) || c.deleteAll === true) {
      const r = await deleteSaved(c.deleteAll === true ? null : c.deleteAlerts.filter((id) => typeof id === "string"));
      if (!r.ok) return r;
      message = r.message;
    }
    if (typeof c.armed === "boolean" && c.armed !== cfg.armed) {
      setArmed(c.armed);
      message = cfg.armed ? "The baby monitor is listening." : "The baby monitor is off.";
    }
    save();
    if (c.test === true) {
      try {
        await notify({ at: Date.now(), sound: cfg.trigger, id: "" });
        message = "Sent: it should be on your phone in a moment (if Sentry's ntfy is on).";
      } catch (err) {
        return { ok: false, message: `Couldn't send it: ${errText(err)}` };
      }
    }
    return { ok: true, message };
  }
  // Alerts deleted, with their sound and videos (ids: those; null: every alert, and every baby monitor file).
  async function deleteSaved(ids) {
    const gone = ids ? events.filter((e) => ids.includes(e.id)) : events.slice();
    if (ids && !gone.length) return { ok: false, message: "That alert isn't there any more." };
    const names = [];
    for (const e of gone) names.push(...[e.audio, ...e.videos, ...(e.clean || [])].filter(Boolean));
    const del = host && host.remote && host.remote.deleteSentry;
    let n = 0;
    if (names.length || !ids) {
      if (!del) return { ok: false, message: "This Hand Tracker can't delete its files: update it." };
      try {
        const res = await del(ids ? { names, baby: true } : { all: true, baby: true });
        n = res.deleted || 0;
        if (res.failed && res.failed.length) return { ok: false, message: `Deleted ${n}; ${res.failed.length} couldn't be: ${res.failed[0]}` };
      } catch (err) {
        return { ok: false, message: `Couldn't delete them: ${errText(err)}` };
      }
    }
    for (const e of gone) {
      const i = events.indexOf(e);
      if (i >= 0) events.splice(i, 1);
    }
    return { ok: true, message: `${ids ? (gone.length === 1 ? "The alert" : `${gone.length} alerts`) : "Every baby monitor clip"} deleted${n ? ` (${n} file${n === 1 ? "" : "s"})` : ""}.` };
  }

  function init(opts) {
    prefs = opts.prefs || {};
    setPref = opts.setPref || setPref;
    host = opts.host || null;
    viewsOf = opts.views || viewsOf;
    hostName = opts.hostName || hostName;
    linkOf = opts.link || linkOf;
    phone = !!opts.phone;
    shownOf = opts.shown || shownOf;
    onArmed = opts.onArmed || onArmed;
    load();
    // (a video whose labels were made a layer of their own since: its labelled copy shown, the clean .mkv kept with it)
    const labels = host && host.remote && host.remote.labels;
    if (labels && labels.onDone) {
      labels.onDone((d) => {
        if (!d || !d.ok || !d.from || !d.labelled) return;
        const base = (p) => String(p).split(/[\\/]/).pop();
        for (const e of events) {
          if (!e.videos.includes(base(d.from))) continue;
          e.videos = e.videos.map((v) => (v === base(d.from) ? base(d.labelled) : v));
          e.clean = [...(e.clean || []), base(d.mkv)];
        }
      });
    }
    // (someone talking to the room: their voice played here, talkChunk)
    const talkIn = host && host.remote && host.remote.talk;
    if (talkIn && talkIn.onChunk) talkIn.onChunk(talkChunk);
    if (cfg.armed) setArmed(true);
  }

  global.BabyMonitor = {
    init, remoteState, command, wantListen,
    isArmed: () => !!cfg && cfg.armed,
    _test: {
      feed: (samples, now) => onChunk(samples, now), events, wav, dbOf, lastSamples, baseName,
      only: (on) => (testOnly = !!on), heard: () => heardReal,
      talk: (t) => talkChunk(t), talked: () => talked, talking: () => talking(), talkQuiet: (ms) => (talkQuietMs = ms),
      cfg: () => cfg, floor: () => floor, episode: () => episode, end: () => endEpisode(),
      setCrying: (score) => {
        crying = score;
        cryLooks.push(score);
        if (cryLooks.length > 4) cryLooks.shift();
      },
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
