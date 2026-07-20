// ============================================================
// Verifies the tab→profile attribution survives an MV3 service-worker
// restart — the bug that made the LIVE feed go stale. Extracts the REAL
// resolveTabProfile / persistTabProfile from background.js and drives them
// against a mock chrome.storage.session.
//
//   node test-harness/attribution-test.mjs
// ============================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BG = readFileSync(join(__dirname, "..", "background.js"), "utf8");

// Pull the exact source of the pieces under test out of background.js.
function extract(re, name) {
  const m = BG.match(re);
  if (!m) throw new Error(`could not find ${name} in background.js`);
  return m[0];
}
const storeConst   = extract(/const TAB_PROFILE_STORE = "[^"]+";/, "TAB_PROFILE_STORE");
const persistFn    = extract(/async function persistTabProfile[\s\S]*?\n}/, "persistTabProfile");
const resolveFn    = extract(/async function resolveTabProfile[\s\S]*?\n}/, "resolveTabProfile");

// Mock chrome.storage.session — an in-memory bucket that (unlike the worker's
// own variables) SURVIVES a simulated worker restart.
function makeChrome(sessionBucket) {
  return {
    storage: {
      session: {
        get: async (key) => ({ [key]: sessionBucket[key] }),
        set: async (obj) => { Object.assign(sessionBucket, obj); },
      },
    },
  };
}

let passed = 0, failed = 0;
const eq = (name, got, want) => {
  if (got === want) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

// Build a fresh "worker" context: its own tabProfileMap + the real functions,
// sharing a persistent sessionBucket (survives restarts).
function newWorker(sessionBucket) {
  const chrome = makeChrome(sessionBucket);
  const scope = { chrome, tabProfileMap: {} };
  const src = `${storeConst}\n${persistFn}\n${resolveFn}\n` +
    `return { persistTabProfile, resolveTabProfile, tabProfileMap };`;
  // eslint-disable-next-line no-new-func
  const factory = new Function("chrome", "tabProfileMap", src);
  return factory(scope.chrome, scope.tabProfileMap);
}

const run = async () => {
  const sessionBucket = {}; // the shared, restart-surviving store

  // ── Worker #1: a tab boots and self-identifies. ──
  let w = newWorker(sessionBucket);
  const p1 = await w.resolveTabProfile(42, "Profile 1"); // boot message carries profileDir
  eq("boot: resolves from message payload", p1, "Profile 1");
  eq("boot: cached in memory", w.tabProfileMap[42], "Profile 1");
  eq("boot: persisted to session", sessionBucket.snkrsTabProfiles["42"] ?? sessionBucket.snkrsTabProfiles[42], "Profile 1");

  // ── A later log message with NO profileDir, same worker → in-memory hit. ──
  const p2 = await w.resolveTabProfile(42, undefined);
  eq("same worker: resolves from in-memory cache", p2, "Profile 1");

  // ── Simulate MV3 worker restart: new worker, EMPTY in-memory map,
  //    but session bucket persists. A log with no profileDir must STILL attribute.
  w = newWorker(sessionBucket);
  eq("after restart: in-memory map is empty", Object.keys(w.tabProfileMap).length, 0);
  const p3 = await w.resolveTabProfile(42, undefined);
  eq("after restart: recovered from session store", p3, "Profile 1");
  eq("after restart: rehydrated the in-memory cache", w.tabProfileMap[42], "Profile 1");

  // ── A content script that self-identifies wins even with a cold worker. ──
  const w2 = newWorker(sessionBucket);
  const p4 = await w2.resolveTabProfile(99, "Profile 7"); // never booted in this worker
  eq("self-identify: message payload attributes an unseen tab", p4, "Profile 7");

  // ── Genuinely unknown tab → null (no bogus attribution). ──
  const w3 = newWorker(sessionBucket);
  const p5 = await w3.resolveTabProfile(123, undefined);
  eq("unknown tab: resolves to null", p5, null);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
