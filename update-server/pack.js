#!/usr/bin/env node
// ============================================================
// pack.js — build the signed .crx + update.xml for the local
// update server.  Run from anywhere:  node update-server/pack.js
// ============================================================
// Key handling (THE thing that keeps the extension ID stable):
//   1. $SNKRS_CRX_KEY                — explicit path to a PEM private key
//   2. <repo>/.keys/*.pem            — the key from the old installer, if
//                                      you still have it (ID stays gkfbg…)
//   3. <repo>/update-server/key.pem
//   4. none found → a fresh RSA-2048 key is generated into
//      .keys/crx-signing-key.pem (gitignored). The extension ID is derived
//      from the key, so manifest.json "key" and the native-host manifest's
//      allowed_origins are rewritten to match — everything keeps working,
//      the ID is just a new one. BACK THE PEM UP: lose it and every
//      profile has to migrate IDs again.
//
// Output (update-server/dist/, gitignored):
//   snkrs-bot.crx   signed package (self-verified before writing)
//   update.xml      Omaha update manifest Chrome polls
//   info.json       { id, version, ts } for the server + installer
// ============================================================

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { packCrx3, verifyCrx3, collectEntries, publicKeyDer, extensionIdFromPublicKey } = require("./crx3");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(__dirname, "dist");
const KEYS_DIR = path.join(ROOT, ".keys");
const UPDATE_PORT = Number(process.env.SNKRS_UPDATE_PORT || 38473);
const UPDATE_BASE = `http://127.0.0.1:${UPDATE_PORT}`;

// Repo files that are NOT part of the extension payload.
const EXCLUDES = [
  ".git", ".gitignore", ".keys", "node_modules",
  "update-server", "native-host", "force-install", "test-harness",
  "README.md", "package.json", "package-lock.json", "snkrs-bot.zip", "pack-tmp.cjs",
];

function findOrCreateKey() {
  if (process.env.SNKRS_CRX_KEY) {
    const p = process.env.SNKRS_CRX_KEY;
    if (!fs.existsSync(p)) throw new Error(`SNKRS_CRX_KEY points at a missing file: ${p}`);
    return { pem: fs.readFileSync(p, "utf8"), source: p, created: false };
  }
  const candidates = [];
  try {
    for (const f of fs.readdirSync(KEYS_DIR).sort()) {
      if (f.endsWith(".pem")) candidates.push(path.join(KEYS_DIR, f));
    }
  } catch (e) { /* .keys/ absent */ }
  const local = path.join(__dirname, "key.pem");
  if (fs.existsSync(local)) candidates.push(local);

  for (const p of candidates) {
    const pem = fs.readFileSync(p, "utf8");
    try { crypto.createPrivateKey(pem); return { pem, source: p, created: false }; }
    catch (e) { console.warn(`! Skipping ${p} — not a usable private key (${e.message})`); }
  }

  // No usable private key found. If manifest.json ALREADY pins a key, generating
  // a new one here would SILENTLY change the extension ID — which breaks the
  // native host trust and every already-installed copy until all profiles are
  // reinstalled/restarted. That footgun caused real breakage, so refuse to
  // regenerate unless the user explicitly opts in.
  let manifestHasKey = false;
  try { manifestHasKey = !!JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).key; } catch (e) {}
  if (manifestHasKey && process.env.SNKRS_CRX_REGEN !== "1") {
    throw new Error(
      "No signing private key found, but manifest.json already pins a key (a fixed extension ID).\n" +
      "  Generating a new key would CHANGE the extension ID and break every installed copy + the\n" +
      "  native host until all profiles are reinstalled. Do ONE of:\n" +
      "    • restore the matching private key to .keys/crx-signing-key.pem (keeps the current ID), or\n" +
      "    • set SNKRS_CRX_REGEN=1 to intentionally mint a NEW id (then reinstall the native host and\n" +
      "      re-add the extension in every profile).\n" +
      "  Back up .keys/crx-signing-key.pem once you have it — losing it forces an id change."
    );
  }

  // Generate a new key (first-ever pack, or explicit regen).
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  const out = path.join(KEYS_DIR, "crx-signing-key.pem");
  fs.writeFileSync(out, pem, { mode: 0o600 });
  return { pem, source: out, created: true };
}

// Keep manifest.json "key" and the native-host manifest in sync with the
// signing key, so the unpacked copy, the crx copy, and the native host all
// agree on ONE extension ID.
function syncIdentity(pubDerB64, id) {
  let changed = [];

  const manifestPath = path.join(ROOT, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.key !== pubDerB64) {
    manifest.key = pubDerB64;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    changed.push("manifest.json key");
  }

  const hostManifestPath = path.join(ROOT, "native-host", "com.snkrs.launcher.json");
  try {
    const hm = JSON.parse(fs.readFileSync(hostManifestPath, "utf8"));
    const origin = `chrome-extension://${id}/`;
    if (!Array.isArray(hm.allowed_origins) || hm.allowed_origins[0] !== origin) {
      hm.allowed_origins = [origin];
      fs.writeFileSync(hostManifestPath, JSON.stringify(hm, null, 2) + "\n");
      changed.push("native-host allowed_origins");
    }
  } catch (e) {
    console.warn("! Could not update native-host manifest:", e.message);
  }
  return changed;
}

function main() {
  const key = findOrCreateKey();
  const pubDer = publicKeyDer(key.pem);
  const id = extensionIdFromPublicKey(pubDer);
  const pubDerB64 = pubDer.toString("base64");

  console.log(`Signing key : ${key.source}${key.created ? "  (NEWLY GENERATED — back it up!)" : ""}`);
  console.log(`Extension ID: ${id}`);

  const changed = syncIdentity(pubDerB64, id);
  if (changed.length) {
    console.log(`! Updated ${changed.join(" + ")} to match the signing key.`);
    console.log(`! (The ID above is now the one true ID — remove any old unpacked`);
    console.log(`!  copies with a different ID after the forced install lands.)`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const version = manifest.version;

  const entries = collectEntries(ROOT, EXCLUDES);
  if (!entries.find(e => e.name === "manifest.json")) throw new Error("manifest.json missing from payload?!");
  const { crx } = packCrx3(entries, key.pem);

  // Self-check: parse + verify the signature before we ship it. A corrupt or
  // mis-signed crx is exactly how the old force-install nuked itself.
  const check = verifyCrx3(crx);
  if (check.id !== id) throw new Error(`self-check ID mismatch: ${check.id} != ${id}`);

  fs.mkdirSync(DIST, { recursive: true });
  const crxPath = path.join(DIST, "snkrs-bot.crx");
  fs.writeFileSync(crxPath, crx);

  const updateXml = `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='${UPDATE_BASE}/snkrs-bot.crx' version='${version}' />
  </app>
</gupdate>
`;
  fs.writeFileSync(path.join(DIST, "update.xml"), updateXml);
  fs.writeFileSync(path.join(DIST, "info.json"), JSON.stringify({
    id, version, ts: Date.now(), crxBytes: crx.length, files: entries.length,
  }, null, 2));

  console.log(`Packed      : ${crxPath}  (${(crx.length / 1024).toFixed(1)} KB, ${entries.length} files, v${version})`);
  console.log(`Update XML  : ${path.join(DIST, "update.xml")}`);
  console.log(`Signature   : VERIFIED ✓`);
  console.log(`Forcelist   : ${id};${UPDATE_BASE}/update.xml`);
}

try { main(); } catch (e) {
  console.error("PACK FAILED:", e.message);
  process.exit(1);
}
