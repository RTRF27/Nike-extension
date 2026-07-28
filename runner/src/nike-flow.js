// Nike FLOW page driver. Selectors were captured from the live site, not
// guessed — see runner/README.md for the exact markup.
//
//   size grid   <fieldset data-testid="pdp-grid-selector">
//                 <div data-testid="pdp-grid-selector-item">
//                   <input class="visually-hidden" name="grid-selector-input" value="10.5">
//                   <label for="grid-selector-input-10.5">US 10.5</label>
//   add to bag  [data-testid="atb-button-mobile"]
//   bag         "Member Checkout" / "Guest Checkout"
//
// The size input is visually-hidden, so the LABEL is the only real click
// target — clicking the input silently does nothing.
const { OUTCOME } = require("./checkout-worker.js");

function productUrl(task) {
  if (task.url) return task.url;
  // Nike resolves /t/<any-slug>/<SKU>, so the slug doesn't have to be right.
  return `https://www.nike.com/${task.region || "sg"}/t/x/${task.sku}`;
}

async function readSizes(page) {
  return page.$$eval('[data-testid="pdp-grid-selector-item"]', cells =>
    cells.map(c => {
      const i = c.querySelector('input[type="radio"]');
      const l = c.querySelector("label");
      return i && l ? { value: String(i.value || "").trim(),
                        text: (l.textContent || "").trim(),
                        available: !i.disabled && i.getAttribute("aria-disabled") !== "true" } : null;
    }).filter(Boolean));
}
const norm = (v) => String(v || "").trim().toUpperCase().replace(/^US\s+/, "");

// Add to bag. `wanted` is the task's size list, in preference order; the first
// available one wins. Empty list = take any available size.
async function addToBag(page, task, log) {
  await page.goto(productUrl(task), { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector('[data-testid="pdp-grid-selector"]', { timeout: 30000 });

  const sizes = await readSizes(page);
  const wanted = (task.sizes || []).map(norm);
  const avail = sizes.filter(s => s.available);
  if (!avail.length) return { ok: false, reason: "no sizes available" };

  const pick = wanted.length
    ? avail.find(s => wanted.includes(norm(s.value)) || wanted.includes(norm(s.text)))
    : avail[Math.floor(Math.random() * avail.length)];
  if (!pick) {
    return { ok: false, reason: `wanted ${wanted.join("/")}, available ${avail.map(s => s.text).join(", ")}` };
  }

  // Click the LABEL — the input is visually-hidden.
  await page.click(`label[for="grid-selector-input-${pick.value}"]`, { timeout: 10000 });
  const checked = await page.$eval('input[name="grid-selector-input"]:checked', el => el.value).catch(() => null);
  if (checked == null) return { ok: false, reason: "size click did not register" };
  log(`size ${pick.text} selected`);

  await page.click('[data-testid="atb-button-mobile"]', { timeout: 15000 });
  const added = await page.waitForFunction(
    () => /added to bag/i.test(document.body.innerText || ""), null, { timeout: 15000 }
  ).then(() => true).catch(() => false);
  if (!added) return { ok: false, reason: "Add to Bag did not confirm" };

  return { ok: true, size: pick.text, value: pick.value };
}

// Drive the bag → checkout. Returns a worker OUTCOME so the CheckoutWorker's
// retry policy can act on it. Only clicks "place order" when explicitly allowed
// — everything else stops short of spending money.
async function runCheckout(page, job, profile, opts, log) {
  const region = job.region || "sg";
  try {
    if (!/\/(cart|checkout)/.test(page.url())) {
      await page.goto(`https://www.nike.com/${region}/cart`, { waitUntil: "domcontentloaded", timeout: 45000 });
    }
    const body = (await page.textContent("body").catch(() => "")) || "";
    if (/your bag is empty|bag is empty/i.test(body)) return { status: OUTCOME.EXPIRED, detail: "bag empty" };

    const cta = await page.$('button:has-text("Member Checkout"), button:has-text("Guest Checkout"), button:has-text("Checkout")');
    if (!cta) return { status: OUTCOME.ERROR, detail: "no checkout button on the bag" };
    await cta.click({ timeout: 10000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 45000 }).catch(() => {});

    const txt = (await page.textContent("body").catch(() => "")) || "";
    if (/expired|no longer available|session has ended/i.test(txt)) {
      return { status: OUTCOME.EXPIRED, detail: "checkout expired" };
    }
    if (!opts.placeOrder) {
      log("auto place-order is OFF — stopping at checkout for manual review.");
      return { status: OUTCOME.ERROR, detail: "stopped for manual review (placeOrder off)" };
    }

    const place = await page.$('button:has-text("Place Order"), button:has-text("Submit Order"), button:has-text("Pay Now")');
    if (!place) return { status: OUTCOME.ERROR, detail: "Place Order not found" };
    await place.click({ timeout: 10000 });

    const done = await page.waitForFunction(
      () => /thank you|order confirmed|order number/i.test(document.body.innerText || ""),
      null, { timeout: 60000 }).then(() => true).catch(() => false);
    if (done) return { status: OUTCOME.COMPLETED, detail: page.url() };

    const after = (await page.textContent("body").catch(() => "")) || "";
    if (/declin|payment (was )?(not|un)|try another card|could not be processed/i.test(after)) {
      return { status: OUTCOME.DECLINED, detail: "payment declined" };
    }
    return { status: OUTCOME.ERROR, detail: "no confirmation after submit" };
  } catch (e) {
    return { status: OUTCOME.ERROR, detail: String((e && e.message) || e).slice(0, 120) };
  }
}

module.exports = { productUrl, readSizes, addToBag, runCheckout };
