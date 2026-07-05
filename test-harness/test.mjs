// ============================================================
// Offline checkout tests — drive checkout-core.js against saved
// gs.nike.com fixtures in a REAL browser (faithful layout engine).
// ============================================================
// Why a real browser and not jsdom: the finders depend on
// getComputedStyle, compareDocumentPosition, innerText and the
// minimized-window rect behaviour — jsdom fakes or omits all of these.
//
// Fixtures are served under the real https://gs.nike.com origin via
// route interception, so hostname-dependent logic (isConfirmed, the
// SUBMIT "advanced" check) runs exactly as it does live.
//
// Run:  node test-harness/test.mjs
// Needs Playwright (global install is fine; PLAYWRIGHT_BROWSERS_PATH set).
// ============================================================

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Resolve Playwright from local OR global node_modules.
function loadPlaywright() {
  try { return require("playwright"); } catch (e) {}
  try {
    const groot = execSync("npm root -g", { encoding: "utf8" }).trim();
    return require(join(groot, "playwright"));
  } catch (e) {
    console.error("Playwright not found. Install it:  npm i -D playwright");
    process.exit(2);
  }
}
const { chromium } = loadPlaywright();

const FIX = join(__dirname, "fixtures");
const CORE = readFileSync(join(__dirname, "..", "checkout-core.js"), "utf8");
const fixture = (name) => readFileSync(join(FIX, name), "utf8");

// ── tiny assert harness ───────────────────────────────────────
let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { passed++; results.push(`  ✓ ${name}`); }
  else { failed++; results.push(`  ✗ ${name}${detail ? "  — " + detail : ""}`); }
}
function eq(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// Serve a fixture under https://gs.nike.com and return a ready page.
async function openFixture(context, html) {
  const page = await context.newPage();
  await page.route("https://gs.nike.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: html }));
  await page.goto("https://gs.nike.com/checkout?checkoutId=test");
  await page.addScriptTag({ content: CORE });
  return page;
}

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined,
  });
  const context = await browser.newContext();

  // ── 1. Per-state detection assertions ───────────────────────
  console.log("\n[detection] snapshot + finders per fixture state");

  {
    const page = await openFixture(context, fixture("delivery.html"));
    const s = await page.evaluate(() => window.CheckoutCore.snapshotPageState(document));
    eq("delivery: sees a delivery CONTINUE", s.deliveryContinue, true);
    eq("delivery: no payment form yet", s.paymentForm, false);
    eq("delivery: submit disabled → not found", s.submitBtn, false);
    eq("delivery: not confirmed", s.confirmed, false);
    await page.close();
  }

  {
    const page = await openFixture(context, fixture("payment-iframe.html"));
    const r = await page.evaluate(() => {
      const C = window.CheckoutCore;
      return {
        s: C.snapshotPageState(document),
        payCont: !!C.findPaymentContinueOnly(document),
        delCont: !!C.findDeliveryContinueOnly(document),
      };
    });
    eq("payment-iframe: payment form detected", r.s.paymentForm, true);
    eq("payment-iframe: a payment CONTINUE exists (after iframe)", r.payCont, true);
    eq("payment-iframe: submit still disabled", r.s.submitBtn, false);
    eq("payment-iframe: NOT treated as already-complete", r.s.paymentDone, false);
    await page.close();
  }

  {
    const page = await openFixture(context, fixture("saved-card.html"));
    const s = await page.evaluate(() => window.CheckoutCore.snapshotPageState(document));
    eq("saved-card: isPaymentAlreadyComplete true", s.paymentDone, true);
    eq("saved-card: submit ready", s.submitBtn, true);
    eq("saved-card: no open card iframe", s.iframeOpen, false);
    await page.close();
  }

  {
    const page = await openFixture(context, fixture("inline-card.html"));
    const s = await page.evaluate(() => window.CheckoutCore.snapshotPageState(document));
    eq("inline-card: inline card detected filled", s.inlineCard, true);
    eq("inline-card: submit ready", s.submitBtn, true);
    await page.close();
  }

  {
    const page = await openFixture(context, fixture("confirmation.html"));
    const s = await page.evaluate(() => window.CheckoutCore.snapshotPageState(document));
    eq("confirmation: isConfirmed true", s.confirmed, true);
    eq("confirmation: no delivery CONTINUE", s.deliveryContinue, false);
    eq("confirmation: no submit button", s.submitBtn, false);
    await page.close();
  }

  // ── 2. Full state-machine drive against the live-ish fixture ─
  console.log("[machine] drive LOADING → … → SUBMITTING → DONE");
  {
    const page = await openFixture(context, fixture("flow-live.html"));
    const out = await page.evaluate(async () => {
      const C = window.CheckoutCore;
      const events = [];
      const machine = new C.CheckoutMachine({
        doc: document,
        log: () => {},
        dbg: () => {},
        emit: (e) => events.push(e.code),
        tag: () => "",
        getCardFill: () => Promise.resolve(false), // inline path wins
        cancelCardFill: () => {},
        isTestMode: () => false,
        getDropAt: () => 0, // submit immediately, no hold
      });
      const result = await machine.run();
      return { result, events, finalState: machine.state,
               confirmed: C.isConfirmed(document) };
    });
    eq("machine: reached DONE", out.finalState, "DONE");
    eq("machine: reported submitted", out.result.submitted, true);
    eq("machine: page shows confirmation", out.confirmed, true);
    check("machine: emitted submitted event", out.events.includes("submitted"),
      "events=" + out.events.join(","));
    check("machine: emitted done event", out.events.includes("done"));
    check("machine: passed through PAYMENT/filled", out.events.includes("filled"));
    await page.close();
  }

  // ── 3. TEST MODE must stop before clicking SUBMIT ───────────
  console.log("[machine] test mode stops before SUBMIT");
  {
    const page = await openFixture(context, fixture("saved-card.html"));
    const out = await page.evaluate(async () => {
      const C = window.CheckoutCore;
      const machine = new C.CheckoutMachine({
        doc: document, log: () => {}, dbg: () => {}, emit: () => {},
        tag: () => "", getCardFill: () => Promise.resolve(false),
        cancelCardFill: () => {}, isTestMode: () => true, getDropAt: () => 0,
      });
      const result = await machine.run();
      return { submitted: result.submitted, testMode: result.testMode, state: machine.state };
    });
    eq("test-mode: did not submit", out.submitted, false);
    eq("test-mode: flagged testMode", out.testMode, true);
    await page.close();
  }

  // ── 4. HOLDING gate: with a future dropAt the machine must hold ─
  console.log("[machine] holds SUBMIT until drop time");
  {
    const page = await openFixture(context, fixture("saved-card.html"));
    const out = await page.evaluate(async () => {
      const C = window.CheckoutCore;
      const dropAt = Date.now() + 1500; // 1.5s in the future
      let submittedAt = 0;
      const machine = new C.CheckoutMachine({
        doc: document, log: () => {}, dbg: () => {},
        emit: (e) => { if (e.code === "submitted") submittedAt = Date.now(); },
        tag: () => "", getCardFill: () => Promise.resolve(false),
        cancelCardFill: () => {}, isTestMode: () => false, getDropAt: () => dropAt,
      });
      const result = await machine.run();
      return { submitted: result.submitted, heldMs: submittedAt - dropAt };
    });
    eq("holding: still submitted", out.submitted, true);
    check("holding: submit landed at/after drop (not early)", out.heldMs >= -200,
      `offset ${out.heldMs}ms (negative = early)`);
    await page.close();
  }

  await browser.close();

  console.log("\n" + results.join("\n"));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
