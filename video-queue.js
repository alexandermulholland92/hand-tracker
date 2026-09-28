/**
 * video-queue.js
 * The Recording Viewer's export queue: videos waiting to be converted, each on its own, or
 * trimmed to the stretch it shares with the videos it was synced with (video-sync.js). It's
 * kept in the page's own database (IndexedDB), so the main window can add videos and the
 * viewer finds them, whether it's another window (Windows, Linux, website) or opens in
 * place (Android), and the queue is still there after a restart.
 *
 *   await VideoQueue.add([{ name, path?, file?, trim?, group? }])
 *     path: where the file is on disk (Windows and Linux app; nothing is copied);
 *     file: the File itself elsewhere (a page can't reopen a file by its path, so the
 *           browser keeps a copy until it's removed from the queue);
 *     trim: { start, length } seconds; group: a label shared by videos synced together.
 *   await VideoQueue.list()      -> [{ id, name, size, path, file, trim, group, added }], oldest first
 *   await VideoQueue.remove(id)  /  await VideoQueue.clear()
 *   VideoQueue.onChange(cb)      the queue changed (in this window or another one)
 */

(function (global) {
  const DB = "hand-tracker";
  const STORE = "exportQueue";
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("hand-tracker-queue") : null;
  const listeners = [];
  let dbPromise = null;

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("The export queue can't be opened here."));
      });
      dbPromise.catch(() => (dbPromise = null));
    }
    return dbPromise;
  }

  async function run(mode, work) {
    const store = (await db()).transaction(STORE, mode).objectStore(STORE);
    return new Promise((resolve, reject) => {
      const req = work(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function changed() {
    if (channel) channel.postMessage("changed");
    for (const cb of listeners) cb();
  }

  async function add(items) {
    for (const item of items) {
      const entry = {
        name: String(item.name || "video"),
        size: item.file ? item.file.size : Number(item.size) || 0,
        path: item.path || "",
        file: item.path ? null : item.file || null,
        trim: item.trim && item.trim.length > 0 ? { start: Math.max(0, item.trim.start), length: item.trim.length } : null,
        group: item.group || "",
        added: Date.now(),
      };
      if (!entry.path && !entry.file) throw new Error(`${entry.name} can't be queued: it has no file.`);
      await run("readwrite", (s) => s.add(entry));
    }
    changed();
  }

  const list = () => run("readonly", (s) => s.getAll());

  async function remove(id) {
    await run("readwrite", (s) => s.delete(id));
    changed();
  }

  async function clear() {
    await run("readwrite", (s) => s.clear());
    changed();
  }

  function onChange(cb) {
    listeners.push(cb);
    if (channel && listeners.length === 1) channel.onmessage = () => listeners.forEach((f) => f());
  }

  global.VideoQueue = { add, list, remove, clear, onChange };
})(window);
