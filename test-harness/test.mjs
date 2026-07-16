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

  // ── 4b. LEO speed mode: faster fill→submit + on-the-dot / immediate ─
  // Tests run against the REAL captured gs.nike.com checkout DOM (saved-card
  // fixture). We assert BEHAVIOUR + a RELATIVE speed-up (LEO vs the normal
  // flow on the same page) rather than brittle absolute millisecond thresholds,
  // and that LEO never submits before the drop.
  console.log("[machine] LEO mode is faster and submits on/after the drop");
  {
    const runOnce = async (page, leo, getDropAt) => page.evaluate(async ({ leo, dropAt }) => {
      const C = window.CheckoutCore;
      let submittedAt = 0;
      const machine = new C.CheckoutMachine({
        doc: document, log: () => {}, dbg: () => {},
        // FIRST submit emit only — the post-submit verify loop re-emits on each
        // retry when a static fixture never "advances".
        emit: (e) => { if (e.code === "submitted" && !submittedAt) submittedAt = Date.now(); },
        tag: () => "", getCardFill: () => Promise.resolve(false),
        cancelCardFill: () => {}, isTestMode: () => false,
        isLeoMode: () => leo, getDropAt: () => dropAt,
      });
      const t0 = Date.now();
      const r = await machine.run();
      return { submitted: r.submitted, totalMs: Date.now() - t0, offset: submittedAt ? submittedAt - dropAt : null };
    }, { leo, dropAt: getDropAt });

    // Relative speed: LEO (no hold) must reach SUBMIT faster than the normal
    // flow on the same real page — that's the "fill→submit is too slow" fix.
    const pN = await openFixture(context, fixture("saved-card.html"));
    const normal = await runOnce(pN, false, 0);
    await pN.close();
    const pL = await openFixture(context, fixture("saved-card.html"));
    const leo = await runOnce(pL, true, 0);
    await pL.close();
    eq("LEO: normal flow submitted", normal.submitted, true);
    eq("LEO: leo flow submitted", leo.submitted, true);
    check("LEO: fill→submit is faster than the normal flow",
      leo.totalMs < normal.totalMs, `leo ${leo.totalMs}ms vs normal ${normal.totalMs}ms`);

    // On-the-dot: with a drop comfortably beyond the fill pipeline, LEO holds and
    // submits AT/AFTER the drop, never early.
    const pH = await openFixture(context, fixture("saved-card.html"));
    const held = await runOnce(pH, true, Date.now() + 6000);
    await pH.close();
    eq("LEO: held tab submitted", held.submitted, true);
    check("LEO: never submits before the drop", held.offset >= -15, `offset ${held.offset}ms`);
    check("LEO: submits on the dot (<120ms late)", held.offset != null && held.offset <= 120, `offset ${held.offset}ms`);

    // Late tab (opened after drop): submits, with no drop-hold added.
    const pLate = await openFixture(context, fixture("saved-card.html"));
    const late = await runOnce(pLate, true, Date.now() - 60000);
    await pLate.close();
    eq("LEO: late tab submitted", late.submitted, true);
    check("LEO: late tab not slower than normal (no hold added)",
      late.totalMs <= normal.totalMs + 500, `${late.totalMs}ms`);
  }

  // ── 4c. DAN raffle human delay: submit lands AFTER the drop, within window ─
  console.log("[machine] DAN raffle adds a bounded human delay before submit");
  {
    const page = await openFixture(context, fixture("saved-card.html"));
    const out = await page.evaluate(async () => {
      const C = window.CheckoutCore;
      const dropAt = Date.now(); // drop is now → only the jitter delays submit
      let firstSubmit = 0;
      const machine = new C.CheckoutMachine({
        doc: document, log: () => {}, dbg: () => {},
        emit: (e) => { if (e.code === "submitted" && !firstSubmit) firstSubmit = Date.now(); },
        tag: () => "", getCardFill: () => Promise.resolve(false),
        cancelCardFill: () => {}, isTestMode: () => false,
        isLeoMode: () => false, getSubmitJitterMs: () => 3000, getDropAt: () => dropAt,
      });
      const r = await machine.run();
      return { submitted: r.submitted, delay: firstSubmit - dropAt };
    });
    eq("DAN: submitted", out.submitted, true);
    // Pipeline itself takes ~1s; with up to 3s jitter the submit must land after
    // the drop and comfortably inside the raffle window.
    check("DAN: submit delayed past the drop (human spread)", out.delay >= 0, `delay ${out.delay}ms`);
    check("DAN: delay within the bounded window", out.delay < 20000, `delay ${out.delay}ms`);
    await page.close();
  }

  // ── 5. PANIC: abort raised while holding must cancel SUBMIT ──
  console.log("[machine] panic abort during HOLDING cancels SUBMIT");
  {
    const page = await openFixture(context, fixture("saved-card.html"));
    const out = await page.evaluate(async () => {
      const C = window.CheckoutCore;
      const dropAt = Date.now() + 4000; // hold 4s
      let submitted = false, aborted = false;
      const machine = new C.CheckoutMachine({
        doc: document, log: () => {}, dbg: () => {},
        emit: (e) => { if (e.code === "submitted") submitted = true; },
        tag: () => "", getCardFill: () => Promise.resolve(false),
        cancelCardFill: () => {}, isTestMode: () => false, getDropAt: () => dropAt,
        // Abort flips true ~1s into the hold.
        checkAbort: () => Date.now() > (window.__t0 + 1000),
      });
      window.__t0 = Date.now();
      const r = await machine.run();
      aborted = !!r.aborted;
      return { submitted, aborted, state: machine.state };
    });
    check("panic: never submitted", out.submitted === false, `submitted=${out.submitted}`);
    eq("panic: reported aborted", out.aborted, true);
    eq("panic: ended in ERROR", out.state, "ERROR");
    await page.close();
  }

  // ── 6. Saved card + CVV: fill the inline security code, then submit ──
  console.log("[machine] saved card that needs a CVV: types it and submits");
  {
    const page = await openFixture(context, fixture("saved-card-cvv.html"));
    // Detection: the empty security-code field is found; once filled it isn't.
    const det = await page.evaluate(() => {
      const C = window.CheckoutCore;
      const before = !!C.findSecurityCodeInput(document);
      const inp = document.querySelector(".cvv-input");
      C.fillNativeInput(inp, "123");
      const after = !!C.findSecurityCodeInput(document);
      return { before, after, value: inp.value };
    });
    eq("cvv: empty security-code field detected", det.before, true);
    eq("cvv: fillNativeInput wrote the value", det.value, "123");
    eq("cvv: filled field no longer flagged empty", det.after, false);
    await page.close();

    // Machine: a saved card with an empty CVV → types the account CVV → submits.
    const page2 = await openFixture(context, fixture("saved-card-cvv.html"));
    const out = await page2.evaluate(async () => {
      const C = window.CheckoutCore;
      const machine = new C.CheckoutMachine({
        doc: document, log: () => {}, dbg: () => {},
        emit: () => {}, tag: () => "", getCardFill: () => Promise.resolve(false),
        cancelCardFill: () => {}, isTestMode: () => false, getDropAt: () => 0,
        getCvv: () => "456",
      });
      const r = await machine.run();
      return { submitted: r.submitted, cvv: (document.querySelector(".cvv-input").value || "") };
    });
    eq("cvv: machine typed the account CVV", out.cvv, "456");
    eq("cvv: machine reached SUBMIT", out.submitted, true);
    await page2.close();

    // No CVV set → the machine must NOT get stuck; it flags and moves on.
    const page3 = await openFixture(context, fixture("saved-card-cvv.html"));
    const noCvv = await page3.evaluate(async () => {
      const C = window.CheckoutCore;
      const machine = new C.CheckoutMachine({
        doc: document, log: () => {}, dbg: () => {},
        emit: () => {}, tag: () => "", getCardFill: () => Promise.resolve(false),
        cancelCardFill: () => {}, isTestMode: () => false, getDropAt: () => 0,
        getCvv: () => "",
      });
      const r = await machine.run();
      return { state: machine.state, cvv: (document.querySelector(".cvv-input").value || "") };
    });
    check("cvv: no-CVV account leaves the field empty (manual)", noCvv.cvv === "", `cvv=${noCvv.cvv}`);
    await page3.close();
  }

  await browser.close();

  console.log("\n" + results.join("\n"));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
