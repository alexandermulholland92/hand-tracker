/**
 * second-look.js — Sentry's second look's model for the Windows, Mac and Linux app (the page's
 * second-look.js says what it is and does): downloaded the first time it's wanted (13 MB, from this
 * project's sentry-models-1 release), checked against its size and SHA-256, and kept in the app's
 * data folder (<userData>/models). A copy kept there that isn't whole is downloaded again.
 * HAND_TRACKER_SECOND_LOOK_URL downloads it from elsewhere (the checks).
 *
 *   await secondLookModel(dataDir, fetchFn [, expect])   // its bytes (a Buffer)
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { MODEL } = require("../second-look.js");

const whole = (data, expect) => !!data && data.length === expect.size && crypto.createHash("sha256").update(data).digest("hex") === expect.sha256;
let downloading = null; // (one download at a time)

async function secondLookModel(dataDir, fetchFn, expect = MODEL) {
  const file = path.join(dataDir, "models", expect.name);
  const kept = await fs.promises.readFile(file).catch(() => null);
  if (whole(kept, expect)) return kept;
  if (!downloading) {
    downloading = (async () => {
      const url = process.env.HAND_TRACKER_SECOND_LOOK_URL || expect.url;
      const res = await fetchFn(url);
      if (!res.ok) throw new Error(`its model's download failed (${res.status})`);
      const data = Buffer.from(await res.arrayBuffer());
      if (!whole(data, expect)) throw new Error("its model didn't download whole (it didn't match its checksum)");
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file + ".part", data);
      await fs.promises.rename(file + ".part", file);
      return data;
    })().finally(() => (downloading = null));
  }
  return downloading;
}

module.exports = { secondLookModel };
