/**
 * ntfy.js — a Sentry mode alert (sentry.js decides when) sent through ntfy, ntfy.sh or your own
 * server, to the ntfy app on a phone. What the page asks is checked here first: an http(s)
 * server, a topic of ntfy's characters, a short title and message, a link that's a web address,
 * and at most one photo of a few MB. Everything but the photo goes in the address's query
 * (ntfy takes it there too), so a camera's name in any language arrives as it is.
 *
 *   const req = cleanNtfy(fromPage);   // or throws, saying what's wrong
 *   await sendNtfy(req);               // or throws
 */

const MAX_PHOTO = 8 << 20;
const SERVER = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~-]+)*\/?$/;
const TOPIC = /^[-_A-Za-z0-9]{1,64}$/;

const text = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

function cleanNtfy(r) {
  if (!r || typeof r !== "object") throw new Error("Nothing to send.");
  const server = String(r.server || "https://ntfy.sh").replace(/\/+$/, "");
  if (!SERVER.test(server) || /\/\.{1,2}(\/|$)/.test(server)) throw new Error("The ntfy server should be an address like https://ntfy.sh.");
  const topic = String(r.topic || "");
  if (!TOPIC.test(topic)) throw new Error("The ntfy topic can only have letters, digits, - and _.");
  const click = String(r.click || "");
  const out = {
    server, topic,
    title: text(r.title, 120) || "Sentry",
    message: text(r.message, 400) || "Movement.",
    tags: text(r.tags, 60).replace(/[^\w,-]/g, ""),
    priority: Math.min(5, Math.max(1, Math.round(Number(r.priority)) || 3)),
    click: /^https?:\/\/\S{1,300}$/.test(click) ? click : "",
  };
  if (r.photo) {
    const photo = Buffer.from(r.photo);
    if (!photo.length || photo.length > MAX_PHOTO) throw new Error("The photo is too big to send.");
    out.photo = photo;
    out.filename = (text(r.filename, 120).replace(/[^\w.-]/g, "_") || "sentry.jpg").replace(/^\.+/, "");
  }
  return out;
}

async function sendNtfy(req, fetchImpl = globalThis.fetch) {
  const q = new URLSearchParams({ title: req.title, tags: req.tags, priority: String(req.priority) });
  if (req.click) q.set("click", req.click);
  if (req.photo) {
    q.set("message", req.message);
    q.set("filename", req.filename);
  }
  const url = `${req.server}/${encodeURIComponent(req.topic)}?${q}`;
  const res = await fetchImpl(url, req.photo ? { method: "PUT", body: req.photo } : { method: "POST", body: req.message });
  if (!res.ok) {
    let why = "";
    try {
      why = (await res.json()).error || "";
    } catch {
      // (not ntfy's JSON)
    }
    throw new Error(`ntfy answered ${res.status}${why ? `: ${why}` : ""}.`);
  }
  return { ok: true };
}

module.exports = { cleanNtfy, sendNtfy };
