// ============================================================
// Region classifier tests — SG vs MY from a phone number.
//   node test-harness/region-test.mjs
// ============================================================
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const { classifyRegionFromPhone } = require(join(__dirname, "..", "region-util.js"));

let passed = 0, failed = 0;
const eq = (name, got, want) => {
  if (got === want) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} — got "${got}", want "${want}"`); }
};

// ── Malaysia ──
eq("MY: dashed local 011-2109 9805", classifyRegionFromPhone("011-2109 9805"), "MY");
eq("MY: bare local 0112109805",      classifyRegionFromPhone("0112109805"), "MY");
eq("MY: landline 03-1234 5678",      classifyRegionFromPhone("03-1234 5678"), "MY");
eq("MY: +60 country code",           classifyRegionFromPhone("+60 11-2109 9805"), "MY");
eq("MY: 60 country code no plus",    classifyRegionFromPhone("60112109805"), "MY");
eq("MY: stored w/o leading 0 (1121099805)", classifyRegionFromPhone("1121099805"), "MY");

// ── Singapore ──
eq("SG: 8-digit starting 9",         classifyRegionFromPhone("91234567"), "SG");
eq("SG: 8-digit starting 8",         classifyRegionFromPhone("81234567"), "SG");
eq("SG: spaced 9123 4567",           classifyRegionFromPhone("9123 4567"), "SG");
eq("SG: +65 prefixed",               classifyRegionFromPhone("+65 9123 4567"), "SG");
eq("SG: 65 prefix no plus",          classifyRegionFromPhone("6591234567"), "SG");

// ── Unknown / empty ──
eq("unknown: empty",                 classifyRegionFromPhone(""), "");
eq("unknown: null",                  classifyRegionFromPhone(null), "");
eq("unknown: SG landline 6 (not 8/9)", classifyRegionFromPhone("61234567"), "");
eq("unknown: junk",                  classifyRegionFromPhone("hello"), "");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
