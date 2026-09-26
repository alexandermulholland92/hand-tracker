/**
 * fake-capacitor.js — preload for check-android.js. Stands in for Capacitor's
 * native bridge so the Android code paths (mobile-bridge.js and app.js) can run
 * in desktop Chromium: an in-memory Filesystem plugin and a Share plugin that
 * behave like the real ones' JavaScript API, recording every call.
 */

(function () {
  const files = new Map(); // "Hand Tracker/name.ext" -> Uint8Array
  const calls = [];
  const shared = [];
  const ROOT_URI = "file:///storage/emulated/0/Documents/";

  const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const decode = (data, encoding) => (encoding === "utf8" ? new TextEncoder().encode(data) : fromBase64(data));
  const uriFor = (path) => ROOT_URI + path.split("/").map(encodeURIComponent).join("/");
  const checkDir = (directory) => {
    if (directory !== "DOCUMENTS") throw new Error(`unexpected directory ${directory}`);
  };

  const Filesystem = {
    async stat({ path, directory }) {
      checkDir(directory);
      calls.push(["stat", path]);
      if (!files.has(path)) throw new Error("File does not exist");
      return { type: "file", size: files.get(path).length, uri: uriFor(path) };
    },
    async writeFile({ path, directory, data, encoding, recursive }) {
      checkDir(directory);
      calls.push(["writeFile", path, encoding || "base64", !!recursive]);
      if (!recursive && path.includes("/")) throw new Error("Parent folder doesn't exist");
      files.set(path, decode(data, encoding));
      return { uri: uriFor(path) };
    },
    async appendFile({ path, directory, data, encoding }) {
      checkDir(directory);
      calls.push(["appendFile", path, encoding || "base64"]);
      const prev = files.get(path) || new Uint8Array(0);
      const add = decode(data, encoding);
      const next = new Uint8Array(prev.length + add.length);
      next.set(prev);
      next.set(add, prev.length);
      files.set(path, next);
    },
    async getUri({ path, directory }) {
      checkDir(directory);
      return { uri: uriFor(path) };
    },
  };
  const Share = {
    async share(options) {
      shared.push(options);
      return {};
    },
  };

  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "android",
    registerPlugin(name) {
      if (name === "Filesystem") return Filesystem;
      if (name === "Share") return Share;
      throw new Error(`fake-capacitor: no plugin ${name}`);
    },
  };
  window.__fakeCapacitor = { files, calls, shared };
})();
