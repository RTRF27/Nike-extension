// ============================================================
// Launch-flow test — proves the REAL snkrs-content-script.js drives a
// random-size instant-buy drop all the way to "Added to bag".
//
// It serves a faithful replica of Nike's SNKRS launch page (the exact size
// grid <ul class="size-layout"> and Buy button .buying-tools-cta-button the
// user captured), with realistic behaviour:
//   • clicking a size marks its <li> .selected (like Nike);
//   • clicking Buy ONLY adds to bag when a size is actually selected —
//     otherwise nothing happens (so a premature/no-size Buy click fails).
// Then it injects the real content script (chrome.* stubbed, random-size
// settings) and asserts the bot reaches the "Added to bag" cart state.
//
//   node test-harness/launch-flow-test.mjs
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

// Random-size, enabled, not test mode — exactly how a launched profile is set.
const SETTINGS = {
  enabled: true, testMode: false,
  preferredSize: "RANDOM", preferredSizeType: "random",
  profileLabel: "TESTER", profileDir: "Profile T", productKeyword: "",
};

// chrome.* stub. Captures every logBG() line into window.__botLogs so we can
// assert the bot announced "ADDED TO BAG", and answers check_abort with off.
const CHROME_STUB = `
(function(){
  const sync = { snkrsBotSettings: ${JSON.stringify(SETTINGS)} };
  const local = {}, session = {};
  window.__botLogs = [];
  const mkArea = (store) => ({
    get: (keys, cb) => {
      let out = {};
      if (keys == null) out = {...store};
      else if (typeof keys === "string") out[keys] = store[keys];
      else if (Array.isArray(keys)) keys.forEach(k => out[k] = store[k]);
      else Object.keys(keys).forEach(k => out[k] = (k in store) ? store[k] : keys[k]);
      const p = Promise.resolve(out); if (cb) cb(out); return p;
    },
    set: (obj, cb) => { Object.assign(store, obj); if (cb) cb(); return Promise.resolve(); },
    remove: (k, cb) => { (Array.isArray(k)?k:[k]).forEach(x=>delete store[x]); if (cb) cb(); return Promise.resolve(); },
  });
  window.chrome = {
    runtime: {
      id: "flowtest", lastError: null,
      getManifest: () => ({ version: "test" }),
      getURL: (p) => p,
      sendMessage: (m, cb) => {
        if (m && m.type === "log") window.__botLogs.push(String(m.message || ""));
        const resp = (m && m.type === "check_abort") ? { on: false } : { ok: true };
        if (typeof cb === "function") cb(resp);
        return Promise.resolve(resp);
      },
      onMessage: { addListener(){}, removeListener(){} },
    },
    storage: { local: mkArea(local), sync: mkArea(sync), session: mkArea(session), onChanged: { addListener(){} } },
    tabs: { query: (q, cb) => cb && cb([]), create(){}, update(){}, onRemoved:{ addListener(){} } },
  };
})();
`;

// The fake launch page. Uses Nike's real class names / data-qa. One size is
// sold-out (data-qa="size-sold-out") to prove random never picks it. No "sold
// out"/"coming soon" body text, so detectPageStatus() reads it as live (ENTER).
const AVAILABLE = ["3.5Y","4Y","4.5Y","5Y","5.5Y","6Y","6.5Y","7Y"];
const SOLD_OUT = "8Y";
const sizeLi = (v, avail) =>
  `<li class="size va-sm-m d-sm-ib va-sm-t ta-sm-c" data-qa="${avail ? "size-available" : "size-sold-out"}">` +
  `<button type="button" class="size-grid-dropdown size-grid-button" id="size_item_radio${v}" value="${v}" data-qa="size-dropdown">US ${v}</button></li>`;

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Older Kids' Air Jordan 4 'She's a Star'</title></head>
<body>
  <header><a>Feed</a><a>In Stock</a><a>Upcoming</a>
    <span data-qa="cart-item-count" aria-label="0 items in bag">0</span>
  </header>
  <h1>Older Kids' Air Jordan 4 'She's a Star'</h1>
  <p>S$215.00</p>
  <p>SKU: IO2829-600</p>
  <ul class="size-layout" style="width:100%;">
    ${AVAILABLE.map(v => sizeLi(v, true)).join("")}
    ${sizeLi(SOLD_OUT, false)}
  </ul>
  <div class="button-container">
    <button type="button" class="ncss-btn-primary-dark btn-lg buying-tools-cta-button">Buy S$215.00</button>
  </div>
  <div id="cart-drawer"></div>

  <script>
    // Realistic Nike behaviour ----------------------------------------------
    // Size click → mark its <li> selected (only size-available lis respond).
    document.querySelectorAll("ul.size-layout button.size-grid-button").forEach(btn => {
      btn.addEventListener("click", () => {
        const li = btn.closest("li");
        if (!li || li.getAttribute("data-qa") !== "size-available") return; // sold-out: no-op
        document.querySelectorAll("ul.size-layout li.size").forEach(x => x.classList.remove("selected"));
        li.classList.add("selected");
      });
    });
    // Buy click → add to bag ONLY when a size is actually selected.
    document.querySelector("button.buying-tools-cta-button").addEventListener("click", () => {
      const sel = document.querySelector("ul.size-layout li.size.selected");
      if (!sel) return;                                   // no size → nothing (mimics Nike)
      if (document.querySelector("#cart-drawer .added-to-bag")) return; // already added → no dup
      const size = sel.querySelector("button").textContent.trim();
      const badge = document.querySelector("[data-qa='cart-item-count']");
      badge.textContent = "1"; badge.setAttribute("aria-label", "1 item in bag");
      document.getElementById("cart-drawer").innerHTML =
        '<div class="added-to-bag"><span>Added to bag</span>' +
        '<div>Air Jordan 4 Retro "She\\'s A Star" — ' + size + '</div>' +
        '<button type="button">View Bag (1)</button></div>';
      window.__addedSize = size;
    });
  </script>
  <script src="/snkrs-content-script.js"></script>
</body></html>`;

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
};

async function main() {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newContext({ viewport: { width: 1280, height: 900 } }).then(c => c.newPage());

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p.includes("/launch/")) { route.fulfill({ status: 200, contentType: "text/html", body: PAGE_HTML }); return; }
    try {
      const body = readFileSync(join(ROOT, p.replace(/^\//, "")));
      route.fulfill({ status: 200, contentType: "text/javascript", body });
    } catch (e) { route.fulfill({ status: 404, body: "nf" }); }
  });

  await page.addInitScript(CHROME_STUB);
  await page.goto("https://www.nike.com/sg/launch/t/big-kids-air-jordan-4-shes-a-star-sweet-beet-and-off-noir", { waitUntil: "load" });

  // The flow waits ~2s before acting, then selects + clicks Buy. Poll up to 20s
  // for BOTH the "Added to bag" drawer AND the bot's own success log (which it
  // emits a beat after its verification loop confirms the cart state).
  for (let i = 0; i < 80; i++) {
    const done = await page.evaluate(() =>
      /added to bag/i.test(document.body.innerText || "") &&
      (window.__botLogs || []).some(l => /added to bag/i.test(l)));
    if (done) break;
    await page.waitForTimeout(250);
  }

  const state = await page.evaluate(() => {
    const sel = document.querySelector("ul.size-layout li.size.selected");
    const soldOutSelected = !!(sel && sel.getAttribute("data-qa") === "size-sold-out");
    const badge = document.querySelector("[data-qa='cart-item-count']");
    return {
      addedText: /added to bag/i.test(document.body.innerText || ""),
      selectedSize: sel ? sel.querySelector("button").textContent.trim() : null,
      soldOutSelected,
      viewBag: /view bag\s*\(\s*1/i.test(document.body.innerText || ""),
      badge: badge ? badge.textContent.trim() : null,
      addedSize: window.__addedSize || null,
      logs: window.__botLogs || [],
    };
  });

  console.log("");
  check("no uncaught errors in the content script", errors.length === 0, errors.slice(0, 3).join(" | "));
  check("bot SELECTED a size (li.selected present)", !!state.selectedSize, "none selected");
  check("selected size is a real available size (US …Y)", /^US\s+[\d.]+Y$/.test(state.selectedSize || ""), state.selectedSize || "");
  check("bot did NOT pick the sold-out size", !state.soldOutSelected);
  check("ITEM ADDED TO BAG (drawer appeared)", state.addedText === true);
  check("cart badge shows 1", state.badge === "1", `badge=${state.badge}`);
  check("View Bag (1) control present", state.viewBag === true);
  check("bot logged 'ADDED TO BAG' success", state.logs.some(l => /added to bag/i.test(l)),
    (state.logs.slice(-3).join(" | ")) || "no logs");
  check("bot's confirmed size matches the carted size",
    state.selectedSize && state.addedSize && state.selectedSize === state.addedSize,
    `sel=${state.selectedSize} bag=${state.addedSize}`);

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
