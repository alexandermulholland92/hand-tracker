/**
 * camera-video.js — records one camera's picture, with sound from a microphone if asked, into a
 * clip (WebM; MP4 on a phone, which plays everywhere there): remote recording's video of each
 * camera, and Sentry mode's clips. Unlike video-recorder.js (the Record card's: several views
 * stacked, frames pushed one by one), it takes the picture as it's drawn, at a steady rate.
 *
 *   const rec = CameraVideo.start({ canvas, fps: 15, audio: true | false, preferMp4 });
 *   rec.elapsed()                          // seconds so far
 *   const clip = await rec.stop();         // { blob, mimeType, ext: "webm" | "mp4", duration, width, height, sound }
 *   CameraVideo.setMicrophone(deviceId)    // which microphone the sound comes from ("" the usual one)
 *   await CameraVideo.microphones()        // [{ deviceId, label }]
 *
 * The microphone is opened once while any clip wants sound, each clip getting its own copy of
 * it, and closed when the last one stops. A clip whose sound can't be had (no microphone, or
 * it's not allowed) is recorded without it, and says so (clip.sound false). A clip is at least
 * a little over a second long: the browser's recorder gives nothing for one stopped sooner.
 */

(function (global) {
  const MIME = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4",
  ];
  const MIME_SILENT = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4;codecs=avc1", "video/mp4"];
  const BITS_PER_PIXEL_FRAME = 0.12; // plenty for a camera's picture at these rates
  // The browser's recorder gives nothing at all for a clip stopped much sooner than this.
  const MIN_CLIP_MS = 1200;

  let micId = "";
  let mic = null; // { stream, users }
  let micOpening = null;

  function supported() {
    return typeof global.MediaRecorder !== "undefined" && !!global.HTMLCanvasElement && !!global.HTMLCanvasElement.prototype.captureStream;
  }

  function pickMime(sound, preferMp4) {
    let list = sound ? MIME : MIME_SILENT;
    if (preferMp4) list = [...list.filter((t) => t.includes("mp4")), ...list.filter((t) => !t.includes("mp4"))];
    return list.find((t) => global.MediaRecorder.isTypeSupported(t)) || "";
  }

  async function microphones() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    return (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === "audioinput" && d.deviceId !== "communications")
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  }

  function setMicrophone(deviceId) {
    micId = String(deviceId || "");
  }

  // A copy of the microphone's sound for one clip (the microphone opened if it isn't), or null.
  async function micTrack() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
    if (!mic) {
      if (!micOpening) {
        const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: true, ...(micId ? { deviceId: { exact: micId } } : {}) };
        micOpening = navigator.mediaDevices
          .getUserMedia({ audio, video: false })
          .catch(() => (micId ? navigator.mediaDevices.getUserMedia({ audio: true, video: false }) : null)) // that one's gone: the usual one
          .then((stream) => (stream ? (mic = { stream, users: 0 }) : null))
          .catch(() => null)
          .finally(() => (micOpening = null));
      }
      await micOpening;
      if (!mic) return null;
    }
    const track = mic.stream.getAudioTracks()[0];
    if (!track || track.readyState !== "live") {
      closeMic(true);
      return null;
    }
    mic.users++;
    return track.clone();
  }

  function closeMic(force) {
    if (!mic) return;
    if (!force && --mic.users > 0) return;
    for (const t of mic.stream.getTracks()) t.stop();
    mic = null;
  }

  // Starts recording canvas (it's recorded as it's drawn on). The sound, if any, starts a moment
  // later: the microphone may still be opening.
  function start({ canvas, fps = 15, audio = false, preferMp4 = false }) {
    if (!supported()) throw new Error("This browser can't record video.");
    if (!canvas || !canvas.width || !canvas.height) throw new Error("There's no picture to record yet.");
    const stream = canvas.captureStream(fps);
    const startedAt = performance.now();
    let recorder = null, chunks = [], sound = false, ownTrack = null, stopped = false, mimeType = "";
    const ready = (async () => {
      if (audio) {
        ownTrack = await micTrack();
        if (ownTrack && !stopped) {
          stream.addTrack(ownTrack);
          sound = true;
        } else if (ownTrack) {
          ownTrack.stop();
          closeMic();
          ownTrack = null;
        }
      }
      if (stopped) return;
      mimeType = pickMime(sound, preferMp4);
      const pixels = canvas.width * canvas.height;
      recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: Math.max(400000, Math.round(pixels * fps * BITS_PER_PIXEL_FRAME)),
        ...(sound ? { audioBitsPerSecond: 96000 } : {}),
      });
      recorder.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
      recorder.start(1000); // a chunk a second: a crash loses at most that
    })();

    return {
      elapsed: () => (performance.now() - startedAt) / 1000,
      async stop() {
        const short = MIN_CLIP_MS - (performance.now() - startedAt);
        if (short > 0) await new Promise((r) => setTimeout(r, short));
        stopped = true;
        await ready;
        const done = recorder && recorder.state !== "inactive" ? new Promise((r) => (recorder.onstop = r)) : Promise.resolve();
        if (recorder && recorder.state !== "inactive") {
          recorder.requestData();
          recorder.stop();
        }
        await done;
        for (const t of stream.getVideoTracks()) t.stop();
        if (ownTrack) {
          ownTrack.stop();
          closeMic();
        }
        const type = (recorder && recorder.mimeType) || mimeType || "video/webm";
        return {
          blob: new Blob(chunks, { type: type.split(";")[0] }),
          mimeType: type,
          ext: type.includes("mp4") ? "mp4" : "webm",
          duration: (performance.now() - startedAt) / 1000,
          width: canvas.width,
          height: canvas.height,
          sound,
        };
      },
    };
  }

  global.CameraVideo = { supported, start, microphones, setMicrophone };
})(typeof window !== "undefined" ? window : globalThis);
