/**
 * flush-often.js — recordings on the drive every 2 seconds (the user, 2026-11-22, from a capture rig's own fix):
 * what's been written to a recording's file reaches its drive at most about this long after, so a power cut (a
 * battery running out, a Pi unplugged) loses the last seconds rather than the take. Left to itself, the system
 * keeps what's written in memory for up to half a minute first.
 *
 *   await FlushOften.handle(state, fileHandle)   // a file this app writes (a fs.promises FileHandle): flushed
 *                                                // once 2 s have passed since it last was (state: { syncedAt },
 *                                                // one per file, the caller's own)
 *   const w = FlushOften.watch(() => [file, …]); w.stop();   // files another program writes (ffmpeg): each
 *                                                // flushed every 2 s through a descriptor of its own (which
 *                                                // flushes the whole file's data, whoever wrote it)
 */

const fs = require("fs");

const EVERY_MS = 2000;

function handle(state, fh) {
  const now = Date.now();
  if (now - (state.syncedAt || 0) < EVERY_MS) return Promise.resolve();
  state.syncedAt = now;
  return fh.datasync().catch(() => {});
}

function watch(list) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      for (const file of list() || []) {
        let fh = null;
        try {
          fh = await fs.promises.open(file, "r+");
          await fh.datasync();
        } catch {
          // (not there yet, or gone: nothing to flush)
        } finally {
          if (fh) await fh.close().catch(() => {});
        }
      }
    } finally {
      busy = false;
    }
  }, EVERY_MS);
  if (timer.unref) timer.unref();
  return { stop: () => clearInterval(timer) };
}

module.exports = { EVERY_MS, handle, watch };
