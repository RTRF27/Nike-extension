// ============================================================
// Regression: SUBMIT ORDER must be VISIBLE, not merely enabled.
// ============================================================
// gs.nike.com is an Angular accordion. The review step — and its
//   <button _ngcontent-ng-c… class="button-submit"> Submit Order </button>
// — is in the DOM from page load but display:none until payment is committed.
// It carries NO `disabled` attribute while hidden.
//
// The old finder only checked `!disabled`, so it grabbed that hidden button
// instantly, logged "SUBMIT ORDER found and enabled", clicked an element
// Angular ignores, and the order silently never submitted — the checkout just
// sat on the payment step forever.
//
//   node test-harness/submit-visibility-test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = join(__dirname, "..");
const { chromium } = require(join(execSync("npm root -g", { encoding: "utf8" }).trim(), "playwright"));

// Faithful to the real markup the user captured, including the Angular attr.
const PAGE = `<!doctype html><html><body>
  <section id="delivery"><button class="button-continue">Continue</button></section>
  <section id="payment">
    <input class="security-code" placeholder="Security code">
    <button class="button-continue">Continue</button>
  </section>
  <!-- Review step: present but collapsed until payment commits. -->
  <section id="review" style="display:none;">
    <button _ngcontent-ng-c2609328562 class="button-submit"> Submit Order </button>
  </section>
</body></html>`;

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log("  ✓ " + n); } else { failed++; console.log("  ✗ " + n + (d ? " — " + d : "")); } };

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newContext().then(c => c.newPage());
page.on("pageerror", e => { failed++; console.log("  ✗ page error: " + e); });
await page.setContent(PAGE);
await page.addScriptTag({ content: readFileSync(join(ROOT, "checkout-core.js"), "utf8") });

const api = await page.evaluate(() => ({
  loaded: !!window.CheckoutCore,
  hasFinder: typeof (window.CheckoutCore || {}).findSubmitOrderButton === "function",
}));
check("checkout-core loaded with the submit finder exported", api.loaded && api.hasFinder);

// 1) Hidden review step — the button exists and is NOT disabled.
const hidden = await page.evaluate(() => {
  const btn = document.querySelector("button.button-submit");
  return {
    existsInDom: !!btn,
    notDisabled: btn && !btn.disabled,
    found: !!window.CheckoutCore.findSubmitOrderButton(document),
  };
});
check("the hidden submit button really is in the DOM and NOT disabled",
  hidden.existsInDom && hidden.notDisabled, JSON.stringify(hidden));
check("finder REFUSES a hidden submit button (the bug)", hidden.found === false,
  "finder returned a hidden button — it would click into the void");

// 2) Reveal the review step, as committing payment does.
const shown = await page.evaluate(() => {
  document.getElementById("review").style.display = "";
  const el = window.CheckoutCore.findSubmitOrderButton(document);
  return { found: !!el, text: el ? el.textContent.trim() : null, cls: el ? el.className : null };
});
check("finder RETURNS the submit button once the step is revealed", shown.found, JSON.stringify(shown));
check("it is the right button", shown.text === "Submit Order" && shown.cls === "button-submit",
  `${shown.text} / ${shown.cls}`);

// 3) A revealed-but-disabled button is still refused.
const disabled = await page.evaluate(() => {
  document.querySelector("button.button-submit").disabled = true;
  const r = !!window.CheckoutCore.findSubmitOrderButton(document);
  document.querySelector("button.button-submit").disabled = false;
  return r;
});
check("finder refuses a visible-but-DISABLED submit", disabled === false);

// 4) visibility:hidden and opacity:0 must also be refused.
for (const [css, label] of [["visibility:hidden", "visibility:hidden"], ["opacity:0", "opacity:0"]]) {
  const r = await page.evaluate((c) => {
    const rev = document.getElementById("review");
    rev.style.cssText = "display:block;" + c;
    const found = !!window.CheckoutCore.findSubmitOrderButton(document);
    rev.style.cssText = "display:block;";
    return found;
  }, css);
  check(`finder refuses a submit hidden by ${label}`, r === false);
}

// 5) Text fallback must obey visibility too (button with no .button-submit class).
const fallback = await page.evaluate(() => {
  document.getElementById("review").innerHTML =
    '<button id="txt" style="display:none"> Submit Order </button>';
  const whileHidden = !!window.CheckoutCore.findSubmitOrderButton(document);
  document.getElementById("txt").style.display = "";
  const whenShown = !!window.CheckoutCore.findSubmitOrderButton(document);
  return { whileHidden, whenShown };
});
check("text-fallback path also requires visibility", fallback.whileHidden === false);
check("text-fallback finds it once visible", fallback.whenShown === true);

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
