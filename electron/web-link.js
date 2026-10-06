/**
 * web-link.js — lets the Hand Tracker website (hand-tracker.pages.dev) move this computer's
 * mouse and type on it with its hand mouse, through this app: a website can't do that itself.
 * Only while "Let the website control this computer" is on (it's off until turned on), only
 * from this computer itself (127.0.0.1: nothing on the network can reach it), and only from the
 * website's own pages (their Origin; a browser can't fake that), each request carried out like
 * this app's own hand mouse's (main.js's handle).
 *
 *   const link = new WebLink({ handle: async (type, data) => result });
 *   await link.start(); link.stop(); link.status() -> { on, port, used }
 *
 * The website (web-pc.js) asks http://127.0.0.1:47823 — browsers let a secure page reach this
 * computer itself (Chrome asks once whether the site may reach apps on this device): GET
 * /status, POST /input { type, data } with type pointer { nx, ny, screen }, button { which,
 * action }, wheel { notches }, key { combo, action }, text { text } or keyboard { show } (this
 * app's floating keyboard). A browser's preflight is
 * answered, with the header Chrome wants for reaching a private address.
 */

const http = require("http");
const { EventEmitter } = require("events");

const PORT = 47823;
const ORIGINS = new Set(["https://hand-tracker.pages.dev", "https://main.hand-tracker.pages.dev", "http://localhost:8080", "http://127.0.0.1:8080"]);

// A request's input, checked: { type, data } or null.
function cleanInput(msg) {
  if (!msg || typeof msg !== "object") return null;
  const d = msg.data && typeof msg.data === "object" ? msg.data : {};
  const frac = (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1;
  switch (msg.type) {
    case "pointer":
      return frac(d.nx) && frac(d.ny) ? { type: "pointer", data: { nx: Number(d.nx), ny: Number(d.ny), screen: d.screen === "all" ? "all" : "primary" } } : null;
    case "button":
      return ["left", "right", "middle"].includes(d.which) && ["down", "up", "click", "double"].includes(d.action) ? { type: "button", data: { which: d.which, action: d.action } } : null;
    case "wheel":
      return Number.isInteger(d.notches) && Math.abs(d.notches) <= 20 ? { type: "wheel", data: { notches: d.notches } } : null;
    case "key":
      return typeof d.combo === "string" && /^[a-z0-9+_ ]{1,60}$/i.test(d.combo) && ["tap", "down", "up"].includes(d.action || "tap")
        ? { type: "key", data: { combo: d.combo, action: d.action || "tap" } }
        : null;
    case "text":
      return typeof d.text === "string" && d.text.length && d.text.length <= 500 ? { type: "text", data: { text: d.text } } : null;
    case "keyboard":
      return typeof d.show === "boolean" ? { type: "keyboard", data: { show: d.show } } : null;
    default:
      return null;
  }
}

class WebLink extends EventEmitter {
  constructor({ handle, port = PORT }) {
    super();
    this.handle = handle;
    this.port = port;
    this.hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]); // (a name that only points here is refused)
    this.server = null;
    this.used = null; // { at, origin }: when the website last used it
  }

  status() {
    return { on: !!this.server, port: this.port, used: this.used };
  }

  start() {
    if (this.server) return Promise.resolve(this.status());
    const server = http.createServer((req, res) => this.serve(req, res));
    return new Promise((resolve, reject) => {
      server.once("error", (err) => reject(err.code === "EADDRINUSE" ? new Error(`Port ${this.port} is in use by another program.`) : err));
      server.listen(this.port, "127.0.0.1", () => {
        this.server = server;
        this.emit("status", this.status());
        resolve(this.status());
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
    this.server = null;
    this.emit("status", this.status());
    return this.status();
  }

  async serve(req, res) {
    const origin = String(req.headers.origin || "");
    const ok = this.hosts.has(String(req.headers.host || "")) && ORIGINS.has(origin);
    const send = (status, body) => {
      const head = { "Content-Type": "application/json", "Cache-Control": "no-store" };
      if (ok) Object.assign(head, { "Access-Control-Allow-Origin": origin, Vary: "Origin" });
      res.writeHead(status, head);
      res.end(JSON.stringify(body));
    };
    if (!ok) return send(403, { error: "Only the Hand Tracker website can use this." });
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      });
      return res.end();
    }
    if (req.method === "GET" && req.url === "/status") return send(200, { app: "Hand Tracker", on: true });
    if (req.method !== "POST" || req.url !== "/input") return send(404, { error: "Not found" });
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4096) return send(413, { error: "Too long" });
    }
    let input;
    try {
      input = cleanInput(JSON.parse(body));
    } catch {
      input = null;
    }
    if (!input) return send(400, { error: "That isn't something the hand mouse does." });
    try {
      const result = await this.handle(input.type, input.data);
      this.used = { at: Date.now(), origin };
      return send(200, { ok: true, result: result || null });
    } catch (err) {
      return send(500, { error: String((err && err.message) || err) });
    }
  }
}

module.exports = { WebLink, cleanInput, PORT, ORIGINS };
