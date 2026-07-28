// Checkout-worker policy tests. No Playwright, no Nike — every dependency is
// injected, so the retry / profile-rotation / cart-expiry rules are verified
// deterministically and instantly.
//   node runner/test/worker-test.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const { CheckoutWorker, OUTCOME } = require(join(__dirname, "..", "src", "checkout-worker.js"));

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log("  ✓ " + n); } else { failed++; console.log("  ✗ " + n + (d ? " — " + d : "")); } };

const PROFILES = [{ name: "Visa" }, { name: "Amex" }, { name: "Mastercard" }];
// Deterministic rotation through the billing profiles.
const nextProfile = (cur) => {
  if (!cur) return PROFILES[0];
  const i = PROFILES.findIndex(p => p.name === cur.name);
  return PROFILES[(i + 1) % PROFILES.length];
};

function mk(cfg, runCheckout, extra = {}) {
  const log = [];
  const results = [];
  let t = 0;                       // virtual clock — tests never really sleep
  const w = new CheckoutWorker(
    { id: 1, name: "T", proxyGroup: "Vital", retryDelayMs: 1000, ...cfg },
    {
      runCheckout, nextProfile,
      onResult: (job, r) => results.push(r),
      log: m => log.push(m),
      now: () => t,
      sleep: async (ms) => { t += ms; },
      ...extra,
    });
  return { w, log, results, tick: (ms) => { t += ms; } };
}
const JOB = { id: "job-1", url: "https://www.nike.com/checkout" };

// 1) First attempt succeeds.
{
  const calls = [];
  const { w, results } = mk({ maxRetries: 5 }, async (j, p) => { calls.push(p.name); return { status: OUTCOME.COMPLETED, detail: "order 123" }; });
  const out = await w.processJob({ ...JOB });
  check("completes on first attempt", out === OUTCOME.COMPLETED, out);
  check("counts one completion", w.stats.completed === 1 && w.stats.attempts === 1);
  check("used the first billing profile", calls.join(",") === "Visa", calls.join(","));
  check("reports the result once", results.length === 1 && results[0].status === OUTCOME.COMPLETED);
}

// 2) Declines rotate the billing profile — the core reason this split exists.
{
  const used = [];
  const { w, log } = mk({ maxRetries: 8, profileRotateRetries: 2 },
    async (j, p) => { used.push(p.name); return { status: OUTCOME.DECLINED, detail: "card declined" }; });
  await w.processJob({ ...JOB });
  // rotate every 2 declines: Visa,Visa → Amex,Amex → Mastercard,Mastercard → Visa,...
  check("rotates profile after N declines", used.slice(0, 6).join(",") === "Visa,Visa,Amex,Amex,Mastercard,Mastercard", used.slice(0, 6).join(","));
  check("logs the rotation", log.some(l => /rotating profile/i.test(l)));
  check("stops at maxRetries", w.stats.attempts === 9, "attempts=" + w.stats.attempts);
}

// 3) A decline that later succeeds on a different card.
{
  let n = 0;
  const { w } = mk({ maxRetries: 5, profileRotateRetries: 1 }, async (j, p) => {
    n++;
    return p.name === "Amex" ? { status: OUTCOME.COMPLETED } : { status: OUTCOME.DECLINED };
  });
  const out = await w.processJob({ ...JOB });
  check("recovers by rotating to a card that works", out === OUTCOME.COMPLETED && w.stats.completed === 1, `out=${out} n=${n}`);
}

// 4) Expired cart abandons immediately — retrying a dead cart is pointless.
{
  let calls = 0;
  const { w, log } = mk({ maxRetries: 5, stopOnCartExpiry: true },
    async () => { calls++; return { status: OUTCOME.EXPIRED }; });
  const out = await w.processJob({ ...JOB });
  check("abandons on cart expiry", out === OUTCOME.EXPIRED);
  check("does NOT retry a dead cart", calls === 1, "calls=" + calls);
  check("logs the abandon", log.some(l => /abandoning/i.test(l)));
}

// 4b) …unless stop_on_cart_expiry is false.
{
  let calls = 0;
  const { w } = mk({ maxRetries: 2, stopOnCartExpiry: false },
    async () => { calls++; return { status: OUTCOME.EXPIRED }; });
  await w.processJob({ ...JOB });
  check("retries expiry when stop_on_cart_expiry=false", calls === 3, "calls=" + calls);
}

// 5) Transport errors retry, and a thrown error is caught not crashed.
{
  let calls = 0;
  const { w } = mk({ maxRetries: 3 }, async () => { calls++; if (calls < 3) throw new Error("net down"); return { status: OUTCOME.COMPLETED }; });
  const out = await w.processJob({ ...JOB });
  check("a thrown error is caught and retried", out === OUTCOME.COMPLETED && calls === 3, `out=${out} calls=${calls}`);
  check("counts the errors", w.stats.errors === 2, "errors=" + w.stats.errors);
}

// 6) Time limit ends a job even if attempts remain.
{
  const { w, log } = mk({ maxRetries: 100, timeLimitMs: 5000, retryDelayMs: 2000 },
    async () => ({ status: OUTCOME.DECLINED }));
  const out = await w.processJob({ ...JOB });
  check("time limit stops a long job", out === OUTCOME.DECLINED && log.some(l => /limit/i.test(l)));
  check("time limit beat maxRetries", w.stats.attempts < 100, "attempts=" + w.stats.attempts);
}

// 7) run() drains the queue, and a disabled worker does nothing.
{
  const jobs = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const { w } = mk({ maxRetries: 0 }, async () => ({ status: OUTCOME.COMPLETED }),
    { takeJob: () => jobs.shift() || null });
  await w.run();
  check("drains every queued job", w.stats.completed === 3, "completed=" + w.stats.completed);

  const off = new CheckoutWorker({ id: 2, name: "off", enabled: false },
    { takeJob: () => ({ id: "x" }), runCheckout: async () => ({ status: OUTCOME.COMPLETED }) });
  await off.run();
  check("a disabled worker processes nothing", off.stats.attempts === 0);
}

// 8) Cooperative stop.
{
  const jobs = [{ id: "a" }, { id: "b" }];
  let stop = false;
  const { w } = mk({ maxRetries: 0 }, async () => { stop = true; return { status: OUTCOME.COMPLETED }; },
    { takeJob: () => jobs.shift() || null, shouldStop: () => stop });
  await w.run();
  check("stops cooperatively mid-run", w.stats.completed === 1, "completed=" + w.stats.completed);
}

// 9) The CSV row mirrors Void's workers.csv shape.
{
  const { w } = mk({ maxRetries: 5, retryDelayMs: 5000, profileRotateRetries: 3, timeLimitMs: 25 * 60000 },
    async () => ({ status: OUTCOME.COMPLETED }));
  const row = w.toRow();
  check("exports a workers.csv-shaped row",
    row.max_retries === 5 && row.retry_delay_seconds === 5 &&
    row.profile_rotate_retries === 3 && row.time_limit_minutes === 25 && row.proxy_list === "Vital",
    JSON.stringify(row));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
