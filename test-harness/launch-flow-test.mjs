// ============================================================
// Launch-flow test — proves the REAL snkrs-content-script.js drives a
// random-size instant-buy drop all the way to "Added to bag" on a MULTI-PRODUCT
// launch page (the real failure mode the user hit).
//
// The page mirrors nike.com/sg/launch/t/… : a HERO product (AJ4, US …Y youth
// sizes, Buy S$215) PLUS two "you might also like" products with their OWN size
// grids + Buy buttons (toddler …C sizes, S$119 / S$95). Behaviour is faithful:
//   • clicking a size marks its <li> .selected within ITS product only;
//   • a product's Buy adds THAT product to the bag ONLY if a size in that same
//     product is selected — so picking a size on the wrong product carts nothing.
// The bot must pick a HERO size and cart the S$215 item. If random selection
// leaks across products (the old bug), this test fails.
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

// leoMode flips the entry path: LEO strips the settling waits, DAN keeps them
// and verifies the size actually selected before committing. Both must cart.
const settingsFor = (leo) => ({
  enabled: true, testMode: false,
  preferredSize: "RANDOM", preferredSizeType: "random",
  profileLabel: "TESTER", profileDir: "Profile T", productKeyword: "",
  leoMode: leo,
});

const chromeStub = (leo) => `
(function(){
  const sync = { snkrsBotSettings: ${JSON.stringify(settingsFor(leo))} };
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

// Three products, each with its own size grid + Buy button. The HERO is first.
const PRODUCTS = [
  { name: "Air Jordan 4 Retro 'She's A Star'", price: "215.00", sizes: ["3.5Y","4Y","4.5Y","5Y","5.5Y","6Y","6.5Y","7Y"], soldOut: "8Y" },
  { name: "Jordan 4 Retro (TD)",               price: "119.00", sizes: ["10.5C","11C","11.5C","12C"], soldOut: null },
  { name: "Jordan 4 Retro (PS)",               price: "95.00",  sizes: ["4C","5C","6C","7C"], soldOut: null },
];
const sizeLi = (v, avail) =>
  `<li class="size va-sm-m d-sm-ib va-sm-t ta-sm-c" data-qa="${avail ? "size-available" : "size-sold-out"}">` +
  `<button type="button" class="size-grid-dropdown size-grid-button" id="size_item_radio${v}" value="${v}" data-qa="size-dropdown">US ${v}</button></li>`;
const productBlock = (p) =>
  `<section class="product">
     <h2>${p.name}</h2>
     <p>S$${p.price}</p>
     <ul class="size-layout" style="width:100%;">
       ${p.sizes.map(v => sizeLi(v, true)).join("")}
       ${p.soldOut ? sizeLi(p.soldOut, false) : ""}
     </ul>
     <div class="button-container">
       <button type="button" class="ncss-btn-primary-dark btn-lg buying-tools-cta-button">Buy S$${p.price}</button>
     </div>
   </section>`;

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Older Kids' Air Jordan 4 'She's a Star'</title></head>
<body>
  <header><a>Feed</a><a>In Stock</a><a>Upcoming</a>
    <span data-qa="cart-item-count" aria-label="0 items in bag">0</span>
  </header>
  <h1>Older Kids' Air Jordan 4 'She's a Star'</h1>
  ${PRODUCTS.map(productBlock).join("")}
  <div id="cart-drawer"></div>

  <script>
    // Faithful per-product behaviour: selection + Buy are scoped to each section.
    document.querySelectorAll("section.product").forEach(section => {
      section.querySelectorAll("ul.size-layout button.size-grid-button").forEach(btn => {
        btn.addEventListener("click", () => {
          const li = btn.closest("li");
          if (!li || li.getAttribute("data-qa") !== "size-available") return; // sold-out no-op
          section.querySelectorAll("ul.size-layout li.size").forEach(x => x.classList.remove("selected"));
          li.classList.add("selected");
        });
      });
      section.querySelector("button.buying-tools-cta-button").addEventListener("click", () => {
        const sel = section.querySelector("ul.size-layout li.size.selected");
        if (!sel) return;                                    // no size in THIS product → nothing
        if (window.__cart) return;                           // already carted → no dup
        const size = sel.querySelector("button").textContent.trim();
        const name = section.querySelector("h2").textContent.trim();
        const price = section.querySelector("button.buying-tools-cta-button").textContent.replace(/^Buy\\s*/,"").trim();
        const badge = document.querySelector("[data-qa='cart-item-count']");
        badge.textContent = "1"; badge.setAttribute("aria-label", "1 item in bag");
        document.getElementById("cart-drawer").innerHTML =
          '<div class="added-to-bag"><span>Added to bag</span>' +
          '<div>' + name + ' — Size ' + size + ' — ' + price + '</div>' +
          '<button type="button">View Bag (1)</button></div>';
        window.__cart = { name: name, size: size, price: price };
      });
    });
  </script>
  <script src="/snkrs-content-script.js"></script>
</body></html>`;

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
};

async function runMode(browser, leo) {
  const mode = leo ? "LEO" : "DAN";
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

  await page.addInitScript(chromeStub(leo));
  const t0 = Date.now();
  await page.goto("https://www.nike.com/sg/launch/t/big-kids-air-jordan-4-shes-a-star-sweet-beet-and-off-noir", { waitUntil: "load" });

  // 50ms granularity so the DAN-vs-LEO elapsed numbers mean something, over the
  // same ~20s total budget the 250ms loop used to give.
  for (let i = 0; i < 400; i++) {
    const done = await page.evaluate(() =>
      !!window.__cart && (window.__botLogs || []).some(l => /added to bag/i.test(l)));
    if (done) break;
    await page.waitForTimeout(50);
  }
  const elapsed = Date.now() - t0;

  const state = await page.evaluate(() => {
    const sel = document.querySelector("ul.size-layout li.size.selected");
    const badge = document.querySelector("[data-qa='cart-item-count']");
    const carts = document.querySelectorAll("#cart-drawer .added-to-bag").length;
    return {
      cart: window.__cart || null,
      selectedSize: sel ? sel.querySelector("button").textContent.trim() : null,
      addedText: /added to bag/i.test(document.body.innerText || ""),
      badge: badge ? badge.textContent.trim() : null,
      cartCount: carts,
      logs: window.__botLogs || [],
      products: document.querySelectorAll("section.product").length,
      sizeGrids: document.querySelectorAll("ul.size-layout").length,
      buyButtons: document.querySelectorAll("button.buying-tools-cta-button").length,
    };
  });

  console.log(`\n  ── ${mode} entry path (carted in ${elapsed}ms) ──`);
  check(`${mode}: page really has 3 products / 3 grids / 3 Buy buttons`,
    state.products === 3 && state.sizeGrids === 3 && state.buyButtons === 3,
    `products=${state.products} grids=${state.sizeGrids} buys=${state.buyButtons}`);
  check(`${mode}: no uncaught errors in the content script`, errors.length === 0, errors.slice(0, 3).join(" | "));
  check(`${mode}: bot SELECTED a size`, !!state.selectedSize, "none selected");
  check(`${mode}: selected size is a HERO youth size (US …Y, not a toddler …C)`,
    /^US\s+[\d.]+Y$/.test(state.selectedSize || ""), state.selectedSize || "");
  check(`${mode}: ITEM ADDED TO BAG`, state.addedText === true && !!state.cart);
  check(`${mode}: carted the HERO product (Air Jordan 4 …), not another product`,
    !!state.cart && /Air Jordan 4/.test(state.cart.name), state.cart && state.cart.name);
  check(`${mode}: carted the S$215 item (right product's Buy button)`,
    !!state.cart && /215/.test(state.cart.price), state.cart && state.cart.price);
  check(`${mode}: exactly ONE item carted (no cross-product double add)`,
    state.cartCount === 1 && state.badge === "1", `count=${state.cartCount} badge=${state.badge}`);
  check(`${mode}: bot's confirmed size matches the carted size`,
    state.cart && state.selectedSize && state.selectedSize === ("US " + state.cart.size.replace(/^US\s+/, "")),
    `sel=${state.selectedSize} bag=${state.cart && state.cart.size}`);
  check(`${mode}: bot logged 'ADDED TO BAG' success`, state.logs.some(l => /added to bag/i.test(l)),
    state.logs.slice(-3).join(" | ") || "no logs");

  // Drop-type routing: the entry flow must announce and take the right path.
  const announced = state.logs.some(l => leo ? /LEO drop — speed path/.test(l)
                                             : /DAN drop — accuracy path/.test(l));
  check(`${mode}: announced the ${mode} entry path`, announced, state.logs.slice(0, 4).join(" | "));
  const verified = state.logs.some(l => /confirmed selected — entry verified/.test(l));
  if (leo) {
    check("LEO: skipped size verification (costs time LEO doesn't have)", !verified,
      "verification ran in LEO mode");
  } else {
    check("DAN: verified the size actually selected before entering", verified,
      state.logs.filter(l => /size|select/i.test(l)).slice(-3).join(" | ") || "no verification log");
  }

  await page.context().close();
  return elapsed;
}

async function main() {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const danMs = await runMode(browser, false);
  const leoMs = await runMode(browser, true);
  // Not a hard assertion — wall-clock across two browser contexts is noisy — but
  // LEO stripping ~1.5s of fixed waits should show up plainly in the numbers.
  console.log(`\n  DAN ${danMs}ms vs LEO ${leoMs}ms (LEO strips ~1.5s of fixed waits)`);
  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
