// ============================================================
// Re-pack the extension into snkrs-bot.crx, signed with the stable key.
// Run this AFTER you change any extension code so the force-installed
// copy updates. Requires:
//   1. The signing key at  .keys/snkrs-extension.pem  (kept out of git —
//      ask the maintainer for it / restore from your private backup).
//   2. crx3 installed:  npm install crx3
//
// Usage:  node pack-crx.cjs
//
// After packing, BUMP the "version" in manifest.json (e.g. 1.2 -> 1.3) and
// re-run force-install\install-forceinstall.bat so Chrome picks up the update.
// ============================================================
const crx3 = require("crx3");
const fs = require("fs");
const { execSync } = require("child_process");

const KEY = ".keys/snkrs-extension.pem";
if (!fs.existsSync(KEY)) {
  console.error(`\nERROR: signing key not found at ${KEY}`);
  console.error("Restore it from your private backup before packing.\n");
  process.exit(1);
}

// Ship exactly the tracked extension files — never the key, host, or build junk.
const files = execSync("git ls-files").toString().trim().split("\n").filter(f =>
  f &&
  !f.startsWith(".keys/") &&
  !f.startsWith("native-host/") &&
  !f.startsWith("force-install/") &&
  !f.endsWith(".crx") &&
  !f.endsWith(".cjs") &&
  f !== ".gitignore"
);

crx3(files, { keyPath: KEY, crxPath: "snkrs-bot.crx", zipPath: "snkrs-bot.zip" })
  .then(() => console.log(`packed snkrs-bot.crx (${files.length} files)`))
  .catch(e => { console.error("PACK ERROR:", e.message); process.exit(1); });
