/**
 * sentry-models.js — Sentry mode's models for the Windows, Mac and Linux app (the page's
 * sentry-models.js says what they are): each downloaded the first time it's wanted (from this
 * project's sentry-models-2 release), checked against its size and SHA-256, and kept in the
 * app's data folder (<userData>/models). A copy kept there that isn't whole is downloaded again;
 * the ones before (SentryModels.OLD) are deleted. HAND_TRACKER_SENTRY_MODELS_URL (a folder's
 * address, ending in /) downloads them from elsewhere (the checks).
 *
 *   await sentryModel(dataDir, fetchFn, which [, expect])   // its bytes (a Buffer)
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { MODELS, OLD } = require("../sentry-models.js");

const whole = (data, expect) => !!data && data.length === expect.size && crypto.createHash("sha256").update(data).digest("hex") === expect.sha256;
const downloading = {}; // (one download of each at a time)

async function sentryModel(dataDir, fetchFn, which, expect = MODELS[which]) {
  if (!expect) throw new Error(`no such model (${which})`);
  const dir = path.join(dataDir, "models");
  const file = path.join(dir, expect.name);
  const kept = await fs.promises.readFile(file).catch(() => null);
  if (whole(kept, expect)) return kept;
  if (!downloading[expect.name]) {
    downloading[expect.name] = (async () => {
      for (const old of OLD) await fs.promises.rm(path.join(dir, old), { force: true }).catch(() => {});
      const base = process.env.HAND_TRACKER_SENTRY_MODELS_URL;
      const res = await fetchFn(base ? base + expect.name : expect.url);
      if (!res.ok) throw new Error(`its model's download failed (${res.status})`);
      const data = Buffer.from(await res.arrayBuffer());
      if (!whole(data, expect)) throw new Error("its model didn't download whole (it didn't match its checksum)");
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(file + ".part", data);
      await fs.promises.rename(file + ".part", file);
      return data;
    })().finally(() => delete downloading[expect.name]);
  }
  return downloading[expect.name];
}

module.exports = { sentryModel };
