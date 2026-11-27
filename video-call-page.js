/**
 * video-call-page.js — Video Call's page (video-call.html): your own devices on Tailscale, and calls between them.
 * A call's pictures and sound go straight between the two apps (WebRTC, over Tailscale: no server in between,
 * nothing looked up outside); its offer, answer and hang up go through each app's own service
 * (electron/video-call.js), as "signals".
 *
 *   calling: offer (this app's description, every address it can be reached at in it) -> the other app rings ->
 *            answer (its description) | decline | busy (already in a call); cancel (given up before an answer);
 *   in a call: hangup; state (muted, camera off), also over the call's own data channel.
 *
 * Only a device that answers rings out (45 s); a call that isn't answered in that time is given up.
 * window.__videoCall: what the checks look at.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const device = Number(params.get("device")) || 0; // (which simulated device this page is, in the checks)
  const desktop = window.desktop && window.desktop.call;
  const host = desktop
    ? {
        hello: () => desktop.hello(device),
        devices: () => desktop.devices(device),
        send: (address, signal) => desktop.send(device, address, signal),
        settings: (change) => desktop.settings(change),
        onSignal: (cb) => desktop.onSignal(cb),
        onShown: (cb) => desktop.onShown(cb),
      }
    : null;
  let shown = false; // (the window in view: told by the app; until then, a camera stays closed)
  const RING_MS = Number(params.get("ringMs")) || 45000;
  const NAMES = { windows: "Windows", linux: "Linux", macos: "Mac", android: "Android", ios: "iPhone", win32: "Windows", darwin: "Mac" };

  let me = null;
  let list = [];
  let state = { mode: "idle" }; // idle | calling | ringing | in-call
  let call = null; // { id, peer: { address, name }, pc, dc, offer?, timer, started, remoteState }
  let local = null; // this app's camera and microphone while in a call (or showing its preview)
  let muted = false, cameraOff = false;

  const note = (text, err = false) => {
    $("note").textContent = text || "";
    $("note").className = "note" + (err ? " err" : "");
  };
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");

  // ---------- Camera and microphone ----------
  const chosen = { camera: localStorage.getItem("vc.camera") || "", mic: localStorage.getItem("vc.mic") || "" };

  async function fillDevices() {
    let all = [];
    try {
      all = await navigator.mediaDevices.enumerateDevices();
    } catch {}
    const cams = all.filter((d) => d.kind === "videoinput");
    const mics = all.filter((d) => d.kind === "audioinput" && d.deviceId !== "communications");
    const fill = (sel, items, none, value) => {
      sel.innerHTML = "";
      for (const [v, label] of [...items.map((d, i) => [d.deviceId, d.label || `${none === "No camera" ? "Camera" : "Microphone"} ${i + 1}`]), ["none", none]]) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = label;
        sel.appendChild(o);
      }
      sel.value = [...sel.options].some((o) => o.value === value) ? value : sel.options[0] ? sel.options[0].value : "none";
    };
    fill($("camera"), cams, "No camera", chosen.camera);
    fill($("mic"), mics, "No microphone", chosen.mic);
    fill($("callCamera"), cams, "No camera", $("camera").value);
  }

  async function openMedia({ camera = $("camera").value, mic = $("mic").value } = {}) {
    const want = {
      video: camera === "none" ? false : { deviceId: camera ? { ideal: camera } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: mic === "none" ? false : { deviceId: mic ? { ideal: mic } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    };
    if (!want.video && !want.audio) return new MediaStream();
    try {
      return await navigator.mediaDevices.getUserMedia(want);
    } catch (first) {
      // (a camera just let go of may need a moment: once more, then the call goes on with sound only)
      await new Promise((r) => setTimeout(r, 600));
      try {
        return await navigator.mediaDevices.getUserMedia(want);
      } catch (e) {
        if (want.video && want.audio) {
          note(`The camera couldn't be opened (${e.message}): sound only.`, true);
          return navigator.mediaDevices.getUserMedia({ audio: want.audio });
        }
        throw e;
      }
    }
  }

  function stopMedia(stream) {
    if (stream) for (const t of stream.getTracks()) t.stop();
  }

  // The chosen camera's picture beside your devices: only while the window is in view and no call is going on (a
  // window hidden in the background, waiting for calls, never has a camera open).
  let previewStream = null, previewTurn = 0, previewOpening = Promise.resolve();
  function showPreview() {
    const turn = ++previewTurn;
    stopMedia(previewStream);
    previewStream = null;
    const cam = $("camera").value;
    $("previewOff").hidden = cam !== "none";
    $("previewOff").textContent = "Camera off";
    if (cam === "none" || state.mode !== "idle" || !shown) {
      $("preview").srcObject = null;
      return previewOpening;
    }
    previewOpening = (async () => {
      try {
        const s = await openMedia({ camera: cam, mic: "none" });
        // (a call started, or the window hidden, while it opened: let go at once)
        if (turn !== previewTurn || state.mode !== "idle" || !shown) return stopMedia(s);
        previewStream = s;
        $("preview").srcObject = s;
      } catch (e) {
        if (turn !== previewTurn) return;
        $("previewOff").hidden = false;
        $("previewOff").textContent = `No picture: ${e.message}`;
      }
    })();
    return previewOpening;
  }

  // The preview's camera let go of (one still opening waited for first), before a call opens it.
  async function dropPreview() {
    previewTurn++;
    await previewOpening.catch(() => {});
    stopMedia(previewStream);
    previewStream = null;
    $("preview").srcObject = null;
  }

  // ---------- Your devices ----------
  async function refresh() {
    if (!host) return;
    try {
      list = await host.devices();
    } catch (e) {
      note(`Your devices couldn't be listed: ${e.message}`, true);
      return;
    }
    const ul = $("devices");
    ul.innerHTML = "";
    if (!list.length) {
      const li = document.createElement("li");
      li.textContent = "No other devices on your Tailscale network.";
      ul.appendChild(li);
    }
    for (const d of list) {
      const li = document.createElement("li");
      li.className = d.online && d.app ? "" : "off";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = d.name;
      const what = document.createElement("span");
      what.className = "what";
      what.textContent = [NAMES[String(d.os).toLowerCase()] || d.os, !d.online ? "offline" : d.app ? "ready for calls" : "no Video Call there"].filter(Boolean).join(" · ");
      const btn = document.createElement("button");
      btn.className = "go";
      btn.textContent = "Call";
      btn.disabled = !(d.online && d.app) || state.mode !== "idle";
      btn.dataset.address = d.address;
      btn.addEventListener("click", () => startCall(d));
      li.append(name, what, btn);
      ul.appendChild(li);
    }
  }

  // ---------- Tones (made here: no sound files) ----------
  let tone = null;
  function playTone(kind) {
    stopTone();
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);
    for (const hz of [440, 480]) {
      const o = ctx.createOscillator();
      o.frequency.value = hz;
      o.connect(gain);
      o.start();
    }
    const level = kind === "ring" ? 0.18 : 0.06;
    const beat = () => {
      const t = ctx.currentTime;
      gain.gain.setValueAtTime(level, t);
      gain.gain.setValueAtTime(0, t + 2);
    };
    beat();
    tone = { ctx, timer: setInterval(beat, 6000) };
  }
  function stopTone() {
    if (!tone) return;
    clearInterval(tone.timer);
    tone.ctx.close().catch(() => {});
    tone = null;
  }

  // ---------- Calls ----------
  function setMode(mode) {
    state.mode = mode;
    $("ringing").hidden = mode !== "ringing";
    $("calling").hidden = mode !== "calling";
    $("call").hidden = mode !== "in-call";
    for (const b of document.querySelectorAll("#devices button")) b.disabled = mode !== "idle" || b.closest("li").classList.contains("off");
  }

  // Waits until the connection's addresses are all in its description (sent whole: no addresses after it).
  function gathered(pc, ms = 3000) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const done = () => {
        if (pc.iceGatheringState !== "complete") return;
        pc.removeEventListener("icegatheringstatechange", done);
        resolve();
      };
      pc.addEventListener("icegatheringstatechange", done);
      setTimeout(resolve, ms);
    });
  }

  function connection(c) {
    const pc = new RTCPeerConnection({ iceServers: [] }); // (over Tailscale: each other's own addresses, nothing outside)
    pc.ontrack = (e) => {
      const stream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      if ($("remote").srcObject !== stream) $("remote").srcObject = stream;
    };
    pc.onconnectionstatechange = () => {
      if (call !== c) return;
      if (pc.connectionState === "connected") {
        $("callNote").textContent = "";
        if (!c.started) startTimer(c);
      } else if (pc.connectionState === "disconnected") $("callNote").textContent = "The connection is struggling…";
      else if (pc.connectionState === "failed") end(`The call was lost: ${c.peer.name} couldn't be reached any more.`, true);
    };
    pc.ondatachannel = (e) => useChannel(c, e.channel);
    return pc;
  }

  function useChannel(c, dc) {
    c.dc = dc;
    dc.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === "state") showRemoteState(c, m);
      } catch {}
    };
    dc.onopen = () => tellState();
  }

  function showRemoteState(c, s) {
    c.remoteState = { muted: !!s.muted, camera: s.camera !== false };
    $("remoteState").textContent = [c.remoteState.muted ? "🔇 muted" : "", c.remoteState.camera ? "" : "camera off"].filter(Boolean).join(" · ");
  }

  function tellState() {
    if (!call) return;
    const s = { type: "state", muted, camera: !cameraOff };
    if (call.dc && call.dc.readyState === "open") call.dc.send(JSON.stringify(s));
  }

  function startTimer(c) {
    c.started = Date.now();
    clearInterval(c.clock);
    c.clock = setInterval(() => {
      const s = Math.floor((Date.now() - c.started) / 1000);
      $("callTime").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 500);
  }

  // This app's camera and microphone added to the call. Without one, its place is kept all the same (sending
  // nothing), so a camera chosen during the call is sent without setting the call up again, and the other's still comes.
  function addLocal(pc, stream, answering) {
    for (const t of stream.getTracks()) pc.addTrack(t, stream);
    if (answering) {
      for (const t of pc.getTransceivers()) if (t.direction === "recvonly") t.direction = "sendrecv";
    } else {
      if (!stream.getVideoTracks().length) pc.addTransceiver("video", { direction: "sendrecv" });
      if (!stream.getAudioTracks().length) pc.addTransceiver("audio", { direction: "sendrecv" });
    }
  }

  const videoSender = (pc) => {
    const t = pc.getTransceivers().find((x) => (x.sender.track && x.sender.track.kind === "video") || (x.receiver.track && x.receiver.track.kind === "video"));
    return t ? t.sender : null;
  };

  async function startCall(d) {
    if (state.mode !== "idle" || !host) return;
    const c = { id: newId(), peer: { address: d.address, name: d.name }, outgoing: true };
    call = c;
    $("callee").textContent = d.name;
    setMode("calling");
    note("");
    try {
      await dropPreview();
      local = await openMedia();
      if (call !== c) return stopMedia(local);
      c.pc = connection(c);
      addLocal(c.pc, local);
      useChannel(c, c.pc.createDataChannel("vc"));
      await c.pc.setLocalDescription(await c.pc.createOffer());
      await gathered(c.pc);
      if (call !== c) return;
      const r = await host.send(d.address, { kind: "offer", call: c.id, sdp: c.pc.localDescription.sdp, video: local.getVideoTracks().length > 0 });
      if (call !== c) return;
      if (!r || !r.ok) return end(`${d.name} couldn't be called: ${(r && r.error) || "no answer"}`, true);
      playTone("ringback");
      c.timer = setTimeout(() => {
        if (call !== c || state.mode !== "calling") return;
        host.send(c.peer.address, { kind: "cancel", call: c.id });
        end(`${d.name} didn't answer.`);
      }, RING_MS);
    } catch (e) {
      if (call === c) end(`The call couldn't start: ${e.message}`, true);
    }
  }

  function cancelCall() {
    if (!call || state.mode !== "calling") return;
    host.send(call.peer.address, { kind: "cancel", call: call.id });
    end("");
  }

  async function answer() {
    const c = call;
    if (!c || state.mode !== "ringing") return;
    stopTone();
    clearTimeout(c.timer);
    try {
      await dropPreview();
      local = await openMedia();
      if (call !== c) return stopMedia(local);
      c.pc = connection(c);
      await c.pc.setRemoteDescription({ type: "offer", sdp: c.offer });
      addLocal(c.pc, local, true);
      await c.pc.setLocalDescription(await c.pc.createAnswer());
      await gathered(c.pc);
      if (call !== c) return;
      const r = await host.send(c.peer.address, { kind: "answer", call: c.id, sdp: c.pc.localDescription.sdp });
      if (!r || !r.ok) return end(`${c.peer.name} couldn't be reached: ${(r && r.error) || "no answer"}`, true);
      inCall(c);
    } catch (e) {
      if (call === c) {
        host.send(c.peer.address, { kind: "hangup", call: c.id });
        end(`The call couldn't start: ${e.message}`, true);
      }
    }
  }

  function decline() {
    if (!call || state.mode !== "ringing") return;
    host.send(call.peer.address, { kind: "decline", call: call.id });
    end("");
  }

  function inCall(c) {
    stopTone();
    clearTimeout(c.timer);
    muted = false;
    cameraOff = false;
    $("self").srcObject = local;
    $("remoteName").textContent = c.peer.name;
    $("remoteState").textContent = "";
    $("callTime").textContent = "0:00";
    $("callCamera").value = $("camera").value;
    syncButtons();
    setMode("in-call");
  }

  function hangup() {
    if (!call) return;
    host.send(call.peer.address, { kind: "hangup", call: call.id });
    end("Call ended.");
  }

  function end(text, err = false) {
    const c = call;
    call = null;
    stopTone();
    if (c) {
      clearTimeout(c.timer);
      clearInterval(c.clock);
      if (c.pc) c.pc.close();
    }
    stopMedia(local);
    local = null;
    $("remote").srcObject = null;
    $("self").srcObject = null;
    setMode("idle");
    note(text, err);
    showPreview();
    refresh();
  }

  async function onSignal(s) {
    if (!s || !s.kind) return;
    const same = call && call.id === s.call;
    if (s.kind === "offer") {
      if (state.mode !== "idle") return host.send(s.from.address, { kind: "busy", call: s.call });
      call = { id: s.call, peer: s.from, offer: s.sdp };
      $("caller").textContent = s.from.name;
      setMode("ringing");
      note("");
      playTone("ring");
      call.timer = setTimeout(() => {
        if (call && call.id === s.call && state.mode === "ringing") end(`Missed call from ${s.from.name}.`);
      }, RING_MS);
      return;
    }
    if (!same) return;
    if (s.kind === "answer" && state.mode === "calling") {
      try {
        await call.pc.setRemoteDescription({ type: "answer", sdp: s.sdp });
        inCall(call);
      } catch (e) {
        hangup();
        end(`The call couldn't start: ${e.message}`, true);
      }
    } else if (s.kind === "decline" && state.mode === "calling") end(`${call.peer.name} declined.`);
    else if (s.kind === "busy" && state.mode === "calling") end(`${call.peer.name} is in another call.`);
    else if (s.kind === "cancel" && state.mode === "ringing") end(`Missed call from ${call.peer.name}.`);
    else if (s.kind === "hangup") end(`${call.peer.name} hung up.`);
    else if (s.kind === "state" && s.state) showRemoteState(call, s.state);
  }

  // ---------- In a call ----------
  function syncButtons() {
    $("mute").textContent = muted ? "Unmute" : "Mute";
    $("mute").classList.toggle("on", muted);
    $("mute").setAttribute("aria-pressed", String(muted));
    $("cameraOff").textContent = cameraOff ? "Camera on" : "Camera off";
    $("cameraOff").classList.toggle("on", cameraOff);
    $("cameraOff").setAttribute("aria-pressed", String(cameraOff));
  }

  function setMuted(on) {
    muted = on;
    if (local) for (const t of local.getAudioTracks()) t.enabled = !on;
    syncButtons();
    tellState();
  }

  function setCameraOff(on) {
    cameraOff = on;
    if (local) for (const t of local.getVideoTracks()) t.enabled = !on;
    syncButtons();
    tellState();
  }

  // Another camera for the call (or none): its picture sent in place of the last one's.
  async function switchCamera(id) {
    if (!call || !call.pc || !local) return;
    const sender = videoSender(call.pc);
    let track = null;
    if (id !== "none") {
      try {
        const s = await openMedia({ camera: id, mic: "none" });
        track = s.getVideoTracks()[0] || null;
      } catch (e) {
        $("callNote").textContent = `That camera couldn't be opened: ${e.message}`;
        return;
      }
    }
    if (track) track.enabled = !cameraOff;
    for (const t of local.getVideoTracks()) {
      t.stop();
      local.removeTrack(t);
    }
    if (track) local.addTrack(track);
    if (sender) await sender.replaceTrack(track);
    $("self").srcObject = local;
    $("camera").value = id;
  }

  // ---------- Start ----------
  async function start() {
    $("refresh").addEventListener("click", refresh);
    $("answer").addEventListener("click", answer);
    $("decline").addEventListener("click", decline);
    $("cancel").addEventListener("click", cancelCall);
    $("hangup").addEventListener("click", hangup);
    $("mute").addEventListener("click", () => setMuted(!muted));
    $("cameraOff").addEventListener("click", () => setCameraOff(!cameraOff));
    $("callCamera").addEventListener("change", () => switchCamera($("callCamera").value));
    $("camera").addEventListener("change", () => {
      chosen.camera = $("camera").value;
      localStorage.setItem("vc.camera", chosen.camera);
      showPreview();
    });
    $("mic").addEventListener("change", () => {
      chosen.mic = $("mic").value;
      localStorage.setItem("vc.mic", chosen.mic);
    });
    $("ringClosed").addEventListener("change", async () => {
      const s = await host.settings({ ringWhenClosed: $("ringClosed").checked });
      if (s && s.error) note(s.error, true);
    });
    if (!host) {
      note("Video Call works in its app (and soon in a browser on your tailnet).", true);
      return;
    }
    host.onSignal((s) => onSignal(s).catch(() => {}));
    host.onShown((on) => {
      shown = on;
      if (state.mode === "idle") showPreview();
    });
    const hello = await host.hello();
    shown = !!hello.shown;
    me = hello.me;
    $("me").textContent = me && me.name ? `This device: ${me.name}` : "This device isn't on Tailscale.";
    $("ringClosed").checked = !!(hello.settings && hello.settings.ringWhenClosed);
    if (hello.error) note(hello.error, true);
    await fillDevices();
    navigator.mediaDevices.addEventListener("devicechange", fillDevices);
    showPreview();
    for (const s of hello.waiting || []) await onSignal(s).catch(() => {});
    await refresh();
    setInterval(() => {
      if (state.mode === "idle" && !document.hidden) refresh();
    }, 30000);
  }

  window.__videoCall = {
    state: () => ({
      mode: state.mode,
      peer: call ? call.peer.name : null,
      muted,
      cameraOff,
      remote: call && call.remoteState ? { ...call.remoteState } : null,
      note: $("note").textContent,
      devices: list.map((d) => ({ name: d.name, app: d.app, online: d.online })),
      connection: call && call.pc ? call.pc.connectionState : null,
    }),
    // What's coming in: video frames decoded, sound packets received (and how loud, 0-1).
    async received() {
      if (!call || !call.pc) return null;
      const out = { frames: 0, width: 0, audioPackets: 0, audioLevel: 0, sent: 0, videoPackets: 0 };
      (await call.pc.getStats()).forEach((r) => {
        if (r.type === "outbound-rtp" && r.kind === "video") out.sent = r.framesEncoded || 0;
        if (r.type !== "inbound-rtp") return;
        if (r.kind === "video") {
          out.frames = r.framesDecoded || 0;
          out.width = r.frameWidth || 0;
          out.videoPackets = r.packetsReceived || 0;
        } else if (r.kind === "audio") {
          out.audioPackets = r.packetsReceived || 0;
          out.audioLevel = r.audioLevel || 0;
        }
      });
      return out;
    },
    // (what's set up, when something doesn't come)
    debug() {
      if (!call || !call.pc) return null;
      return {
        transceivers: call.pc.getTransceivers().map((t) => ({ mid: t.mid, dir: t.direction, cur: t.currentDirection, send: t.sender.track ? `${t.sender.track.kind}:${t.sender.track.readyState}:${t.sender.track.enabled}:${t.sender.track.muted}` : null, recv: t.receiver.track ? `${t.receiver.track.kind}:${t.receiver.track.readyState}:${t.receiver.track.muted}` : null })),
        local: local ? local.getTracks().map((t) => `${t.kind}:${t.label}:${t.readyState}`) : null,
        remote: $("remote").srcObject ? $("remote").srcObject.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.muted}`) : null,
      };
    },
  };

  start().catch((e) => note(`Video Call couldn't start: ${e.message}`, true));
})();
