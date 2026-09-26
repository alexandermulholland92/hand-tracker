/**
 * dist.js — builds the Windows app with electron-builder, stamping the build time
 * into the packaged package.json (the app shows it in its header).
 *   node scripts/dist.js portable | nsis
 */
const { spawnSync } = require("child_process");

const target = process.argv[2] === "nsis" ? "nsis" : "portable";
const result = spawnSync("npx", ["electron-builder", "--win", target, `-c.extraMetadata.buildTime=${new Date().toISOString()}`], {
  stdio: "inherit",
  shell: true,
});
process.exit(result.status === null ? 1 : result.status);
