// ============================================================
// FLOW mode test — drives the REAL flow-content-script.js against a faithful
// replica of nike.com's product page, captured live from the site:
//
//   <fieldset data-testid="pdp-grid-selector">
//     <div data-testid="pdp-grid-selector-item">
//       <input class="visually-hidden" id="grid-selector-input-10.5"
//              name="grid-selector-input" type="radio" value="10.5">
//       <label for="grid-selector-input-10.5">US 10.5</label>
//
// The input is visually-hidden, so the <label> is the only real click target —
// this test fails if the script clicks the input instead. Add to Bag is
// [data-testid="atb-button-mobile"] and only works when a size is selected,
// so the test can't rubber-stamp.
//
//   node test-harness/flow-test.mjs
// ============================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = join(__dirname, "..");
const { chromium } = require(join(execSync("npm root -g", { encoding: "utf8" }).trim(), "playwright"));

const SIZES = ["7", "7.5", "8", "8.5", "9", "9.5", "10", "10.5", "11", "11.5", "12"];
const SOLD_OUT = ["8", "11"];   // must never be chosen

const cell = (v) =>
  `<div class="css-ovr0gm nds-grid-item" data-testid="pdp-grid-selector-item" style="min-width:0px;">` +
  `<input class="visually-hidden css-mi494v" id="grid-selector-input-${v}" name="grid-selector-input" ` +
  `type="radio" value="${v}"${SOLD_OUT.includes(v) ? " disabled" : ""}>` +
  `<label class="u-full-width u-full-height" for="grid-selector-input-${v}">US ${v}</label></div>`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Air Jordan 1 Low SE Men's Shoes. Nike SG</title></head>
<body>
  <header><span data-testid="cart-item-count" aria-label="0 items">0</span></header>
  <h1>Air Jordan 1 Low SE</h1>
  <fieldset class="pdp-grid-selector" data-testid="pdp-grid-selector">
    <legend data-testid="pdp-grid-selector-legend"><span>Select Size</span></legend>
    ${SIZES.map(cell).join("")}
  </fieldset>
  <button type="button" class="nds-btn btn-primary-dark btn-lg" data-testid="atb-button-mobile">Add to Bag</button>
  <div id="bag-drawer"></div>
  <script>
    // Real Nike behaviour: Add to Bag only works once a size radio is checked.
    document.querySelector('[data-testid="atb-button-mobile"]').addEventListener("click", () => {
      const sel = document.querySelector('input[name="grid-selector-input"]:checked');
      if (!sel) { window.__atbNoSize = (window.__atbNoSize||0) + 1; return; }
      if (sel.disabled) { window.__atbSoldOut = true; return; }
      if (window.__bag) return;                       // no double-add
      window.__bag = { size: sel.value };
      document.querySelector('[data-testid="cart-item-count"]').textContent = "1";
      document.getElementById("bag-drawer").innerHTML = "<div>Added to Bag</div><div>US " + sel.value + "</div>";
    });
  </script>
  <script src="/flow-content-script.js"></script>
</body></html>`;

const stub = (settings) => `
(function(){
  const sync = { snkrsBotSettings: ${JSON.stringify(settings)} };
  const local = {}, session = {};
  window.__botLogs = [];
  const mk = (s) => ({
    get: (k, cb) => { let o = {};
      if (k == null) o = {...s}; else if (typeof k === "string") o[k] = s[k];
      else if (Array.isArray(k)) k.forEach(x => o[x] = s[x]);
      else Object.keys(k).forEach(x => o[x] = (x in s) ? s[x] : k[x]);
      const p = Promise.resolve(o); if (cb) cb(o); return p; },
    set: (o, cb) => { Object.assign(s, o); if (cb) cb(); return Promise.resolve(); },
    remove: (k, cb) => { if (cb) cb(); return Promise.resolve(); },
  });
  window.chrome = {
    runtime: { id: "flowtest", lastError: null, getManifest: () => ({ version: "test" }), getURL: p => p,
      sendMessage: (m, cb) => {
        if (m && m.type === "log") window.__botLogs.push(String(m.message || ""));
        if (m && m.type === "flow_stat") (window.__stats = window.__stats || []).push(m.stat);
        const r = (m && m.type === "check_abort") ? { on: false } : { ok: true };
        if (typeof cb === "function") cb(r); return Promise.resolve(r);
      },
      onMessage: { addListener(){}, removeListener(){} } },
    storage: { local: mk(local), sync: mk(sync), session: mk(session), onChanged: { addListener(){} } },
    tabs: { query: (q, cb) => cb && cb([]) },
  };
})();`;

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log("  ✓ " + n); } else { failed++; console.log("  ✗ " + n + (d ? " — " + d : "")); } };

async function run(browser, settings, { waitFor = 8000 } = {}) {
  const page = await browser.newContext({ viewport: { width: 1200, height: 900 } }).then(c => c.newPage());
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.route("**/*", (r) => {
    const u = new URL(r.request().url());
    if (u.pathname.includes("/t/")) return r.fulfill({ status: 200, contentType: "text/html", body: PAGE });
    try {
      return r.fulfill({ status: 200, contentType: "text/javascript",
        body: readFileSync(join(ROOT, u.pathname.replace(/^\//, ""))) });
    } catch { return r.fulfill({ status: 404, body: "nf" }); }
  });
  await page.addInitScript(stub(settings));
  await page.goto("https://www.nike.com/sg/t/air-jordan-1-low-se-mens-shoes-Li0K39Xo/IO2047-001", { waitUntil: "load" });
  const deadline = Date.now() + waitFor;
  while (Date.now() < deadline) {
    // Only TERMINAL states end the wait. "not available" is also logged on
    // non-final retries, so matching it would cut the run short before the
    // last attempt paints the error bar.
    const done = await page.evaluate(() =>
      (window.__botLogs || []).some(l => /ADDED TO BAG|TEST MODE/i.test(l)) ||
      /NEEDS MANUAL/.test((document.getElementById("snkrs-status-bar") || {}).innerText || ""));
    if (done) break;
    await page.waitForTimeout(200);
  }
  const state = await page.evaluate(() => ({
    bag: window.__bag || null,
    checked: (document.querySelector('input[name="grid-selector-input"]:checked') || {}).value || null,
    checkedDisabled: !!(document.querySelector('input[name="grid-selector-input"]:checked') || {}).disabled,
    atbNoSize: window.__atbNoSize || 0,
    atbSoldOut: !!window.__atbSoldOut,
    badge: (document.querySelector('[data-testid="cart-item-count"]') || {}).textContent,
    logs: window.__botLogs || [], stats: window.__stats || [],
    barText: (document.getElementById("snkrs-status-bar") || {}).innerText || "",
  }));
  await page.close();
  return { state, errors };
}

const BASE = { enabled: true, testMode: false, botMode: "flow", profileLabel: "T", profileDir: "P1",
               flowAutoCheckout: false, flowMaxRetries: 1, flowRetryDelaySec: 0, flowTimeLimitMin: 5 };

const browser = await chromium.launch({ args: ["--no-sandbox"] });

// 1) Happy path — configured size gets selected and added to bag.
{
  const { state, errors } = await run(browser, { ...BASE, preferredSize: "10.5" });
  check("no uncaught errors in flow-content-script", errors.length === 0, errors.slice(0, 2).join(" | "));
  check("FLOW selects the configured size via the <label>", state.checked === "10.5", "checked=" + state.checked);
  check("FLOW adds it to the bag", !!state.bag && state.bag.size === "10.5", JSON.stringify(state.bag));
  check("bag badge shows 1", state.badge === "1", "badge=" + state.badge);
  check("never clicked Add to Bag without a size", state.atbNoSize === 0, "noSize=" + state.atbNoSize);
  check("logged ADDED TO BAG", state.logs.some(l => /ADDED TO BAG/i.test(l)), state.logs.slice(-2).join(" | "));
  check("counted a 'carted' stat", state.stats.includes("carted"), JSON.stringify(state.stats));
  check("status bar is branded FLOW", /FLOW/.test(state.barText), state.barText.slice(0, 60));
}

// 2) Sold-out size must never be chosen or carted.
{
  const { state } = await run(browser, { ...BASE, preferredSize: "11" }, { waitFor: 30000 }); // 11 is disabled
  check("refuses a SOLD-OUT size (nothing carted)", !state.bag, JSON.stringify(state.bag));
  check("never selected the disabled input", !state.checkedDisabled);
  check("never fired Add to Bag on a sold-out size", state.atbSoldOut === false);
  check("says the size isn't available", state.logs.some(l => /not available/i.test(l)), state.logs.slice(-2).join(" | "));
  check("shows the red NEEDS MANUAL bar", /NEEDS MANUAL/.test(state.barText), state.barText.slice(0, 70));
}

// 3) Test mode selects but must NOT add to bag.
{
  const { state } = await run(browser, { ...BASE, preferredSize: "9", testMode: true });
  check("TEST MODE selects the size", state.checked === "9", "checked=" + state.checked);
  check("TEST MODE does NOT add to bag", !state.bag);
}

// 4) SNKRS mode: this script must stay completely inert.
{
  const { state } = await run(browser, { ...BASE, preferredSize: "10.5", botMode: "snkrs" }, { waitFor: 2500 });
  check("inert in SNKRS mode (no size touched, nothing carted)", !state.bag && !state.checked);
}

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
