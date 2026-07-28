// ============================================================
// Reagan Bot – FLOW Content Script (nike.com general catalogue)
// URLs: nike.com/<region>/t/<slug>/<SKU>  ·  /cart  ·  /checkout
// ============================================================
// FLOW mode is the normal nike.com buying path, which is a COMPLETELY
// different UI from SNKRS — verified against the live site:
//
//   SNKRS  <ul class="size-layout"><li data-qa="size-available">
//            <button class="size-grid-button">US 7Y</button>
//
//   FLOW   <fieldset data-testid="pdp-grid-selector">
//            <div data-testid="pdp-grid-selector-item">
//              <input class="visually-hidden" name="grid-selector-input"
//                     type="radio" value="10.5">          ← NOT clickable
//              <label for="grid-selector-input-10.5">US 10.5</label>  ← click THIS
//
// The size input is `visually-hidden`, so clicking the input does nothing —
// the <label> is the real target. Sold-out sizes are `input.disabled`.
// Add to Bag is [data-testid="atb-button-mobile"] (plus a floating variant).
// The bag then offers "Member Checkout" / "Guest Checkout" (text-matched).
//
// This file NEVER runs in SNKRS mode, and snkrs-content-script.js never runs
// here — the two flows share nothing but the status-bar look.
// ============================================================

const SETTINGS_KEY = "snkrsBotSettings";
let settings = null;
let hasRun = false;

function log(...a) { console.log("[ReaganBot FLOW]", ...a); }
function extAlive() { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } }
function logBG(msg) {
  if (!extAlive()) return;
  try { chrome.runtime.sendMessage({ type: "log", message: msg, profileDir: settings?.profileDir }); } catch (e) {}
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

async function checkAbort() {
  try { const r = await chrome.runtime.sendMessage({ type: "check_abort" }); return !!(r && r.on); }
  catch (e) { return false; }
}

function profileTag() {
  const label = settings?.profileLabel?.trim();
  return label ? ` **[${label}]**` : "";
}

// ── Status stepper (same visual language as SNKRS mode) ───────
const FLOW_STEPS = [
  { key: "waiting",  icon: "⏳", label: "Waiting" },
  { key: "size",     icon: "👟", label: "Selecting size" },
  { key: "bag",      icon: "🛍️", label: "Add to Bag" },
  { key: "checkout", icon: "💳", label: "Checkout" },
  { key: "done",     icon: "✅", label: "Done" },
];
function nowClock() {
  const d = new Date(); const p = n => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function renderStatusBar(activeKey, opts) {
  opts = opts || {};
  if (!document.body) return;
  let bar = document.getElementById("snkrs-status-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "snkrs-status-bar";
    document.body.appendChild(bar);
  }
  if (activeKey === "error") {
    bar.style.cssText =
      "position:fixed;top:0;left:0;width:100%;z-index:2147483647;box-sizing:border-box;" +
      "padding:9px 14px;background:#c1121f;color:#fff;font:700 14px/1.3 sans-serif;" +
      "text-align:center;letter-spacing:.6px;box-shadow:0 2px 10px rgba(0,0,0,.4);";
    bar.textContent = `❌ FLOW ERROR — NEEDS MANUAL${opts.errorMsg ? ": " + opts.errorMsg : ""}`;
    return;
  }
  bar.style.cssText =
    "position:fixed;top:0;left:0;width:100%;z-index:2147483647;box-sizing:border-box;" +
    "display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 14px;" +
    "background:#111;border-bottom:2px solid #000;font:700 13px/1.25 sans-serif;" +
    "letter-spacing:.4px;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.4);";
  const tagEl = document.createElement("span");
  tagEl.textContent = "FLOW";
  tagEl.style.cssText = "background:#7c3aed;color:#fff;padding:3px 8px;border-radius:5px;font-size:11px;letter-spacing:1px;";
  bar.innerHTML = "";
  bar.appendChild(tagEl);
  const activeIdx = FLOW_STEPS.findIndex(s => s.key === activeKey);
  FLOW_STEPS.forEach((step, i) => {
    const state = i < activeIdx ? "done" : (i === activeIdx ? "active" : "todo");
    let text = step.label;
    if (step.key === "size" && opts.size) text = opts.size;
    if (step.key === "done") { if (opts.label) text = opts.label; if (opts.time) text += " · " + opts.time; }
    else if (opts.label && i === activeIdx) text = opts.label;
    let bg = "transparent", color = "#6b7280", icon = step.icon, weight = "600";
    if (state === "done") { color = "#1db954"; icon = "✓"; }
    if (state === "active") { color = "#fff"; weight = "800"; bg = step.key === "done" ? "#1db954" : "#7c3aed"; }
    const seg = document.createElement("span");
    seg.style.cssText = `display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:6px;` +
      `background:${bg};color:${color};font-weight:${weight};`;
    seg.textContent = `${icon} ${text}`;
    bar.appendChild(seg);
    if (i < FLOW_STEPS.length - 1) {
      const arr = document.createElement("span");
      arr.textContent = "→"; arr.style.cssText = "color:#4b5563;font-weight:700;";
      bar.appendChild(arr);
    }
  });
}

// ── Click helper ─────────────────────────────────────────────
// Same synthetic sequence proven on SNKRS. For a <label> bound to a
// visually-hidden radio, the label click is what actually selects.
function humanClick(el, label) {
  if (!el) { log("humanClick: null for " + label); return; }
  try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window,
    }));
  }
  log("Clicked: " + label);
}

// ── Page detection ───────────────────────────────────────────
const PAGE = { PRODUCT: "product", CART: "cart", CHECKOUT: "checkout", OTHER: "other" };
function detectPage() {
  const p = location.pathname;
  if (/\/checkout/i.test(p)) return PAGE.CHECKOUT;
  if (/\/cart\b/i.test(p)) return PAGE.CART;
  if (/\/t\/[^/]+\/[A-Z0-9-]+/i.test(p)) return PAGE.PRODUCT;
  return PAGE.OTHER;
}
// SKU is the last path segment of a product URL: /sg/t/<slug>/HQ4309-001
function skuFromUrl() {
  const m = location.pathname.match(/\/t\/[^/]+\/([A-Za-z0-9-]+)/);
  return m ? m[1].toUpperCase() : "";
}

// ── Size grid (FLOW) ─────────────────────────────────────────
function sizeCells() {
  const fs = document.querySelector('[data-testid="pdp-grid-selector"]');
  const root = fs || document;
  return Array.from(root.querySelectorAll('[data-testid="pdp-grid-selector-item"]')).map(cell => {
    const input = cell.querySelector('input[type="radio"]');
    const label = cell.querySelector("label");
    return { cell, input, label,
             value: input ? String(input.value || "").trim() : "",
             text: label ? (label.innerText || "").trim() : "",
             available: !!input && !input.disabled && input.getAttribute("aria-disabled") !== "true" };
  }).filter(s => s.input && s.label);
}
// Normalise "US 10.5" / "10.5" / "M" → comparable token.
function normSize(v) { return String(v || "").trim().toUpperCase().replace(/^US\s+/, ""); }

function findSizeCell(preferred) {
  const want = normSize(preferred);
  if (!want) return null;
  const cells = sizeCells();
  log(`Flow: ${cells.length} sizes (${cells.filter(c => c.available).length} available). Want ${want}.`);
  // Match on the input's value first (clean "10.5"), then the label text.
  return cells.find(c => c.available && normSize(c.value) === want)
      || cells.find(c => c.available && normSize(c.text) === want)
      || null;
}
function selectedSizeCell() {
  return sizeCells().find(c => c.input.checked) || null;
}

// ── Add to Bag ───────────────────────────────────────────────
function findAtbButton() {
  const direct = document.querySelector('[data-testid="atb-button-mobile"]');
  if (direct && !direct.disabled) return direct;
  const floating = document.querySelector('[data-testid="floating-atb-wrapper"] button');
  if (floating && !floating.disabled) return floating;
  return Array.from(document.querySelectorAll("button"))
    .find(b => !b.disabled && /^add to bag$|^add to cart$/i.test((b.innerText || "").trim())) || null;
}
// Nike confirms with an "Added to Bag" panel and a non-zero bag count.
function addedToBagConfirmed() {
  const body = (document.body.innerText || "");
  if (/added to bag/i.test(body)) return true;
  const badge = document.querySelector('[data-testid*="cart-item-count"], [aria-label*="Bag"], [aria-label*="bag"]');
  if (badge) {
    const n = (badge.getAttribute("aria-label") || badge.innerText || "").match(/\d+/);
    if (n && parseInt(n[0], 10) > 0) return true;
  }
  return false;
}

// ── Cart → checkout ──────────────────────────────────────────
function findCheckoutCta() {
  const btns = Array.from(document.querySelectorAll("button, a"));
  // Prefer MEMBER checkout — the account is signed in, and guest checkout
  // would drop the member benefits/addresses the profile relies on.
  return btns.find(b => /member checkout/i.test((b.innerText || "").trim()))
      || btns.find(b => /^checkout$/i.test((b.innerText || "").trim()))
      || btns.find(b => /guest checkout/i.test((b.innerText || "").trim()))
      || null;
}

// ── Retry policy ─────────────────────────────────────────────
function retryCfg() {
  return {
    max: Math.max(0, Number(settings?.flowMaxRetries ?? 5)),
    delayMs: Math.max(0, Number(settings?.flowRetryDelaySec ?? 5) * 1000),
    limitMs: Math.max(0, Number(settings?.flowTimeLimitMin ?? 25) * 60000),
  };
}
function bumpStat(kind) {
  try { chrome.runtime.sendMessage({ type: "flow_stat", stat: kind, profileDir: settings?.profileDir }); } catch (e) {}
}

// ── PRODUCT PAGE: size → Add to Bag → go to bag ──────────────
async function runProductPage() {
  const tag = profileTag();
  const preferred = settings?.preferredSize;
  if (!preferred) { log("Flow: no size configured."); return; }

  const { max, delayMs, limitMs } = retryCfg();
  const started = Date.now();
  const sku = skuFromUrl();
  logBG(`🟣${tag} FLOW: watching ${sku || location.pathname} for size ${preferred}…`);
  renderStatusBar("waiting", { size: "US " + normSize(preferred), label: `Waiting · ${sku}` });

  for (let attempt = 1; attempt <= max + 1; attempt++) {
    if (await checkAbort()) {
      logBG(`🛑${tag} FLOW: abort raised — nothing added.`);
      renderStatusBar("error", { errorMsg: "aborted by PANIC" });
      return;
    }
    if (limitMs && Date.now() - started > limitMs) {
      logBG(`⌛${tag} FLOW: time limit hit for ${sku} — giving up.`);
      renderStatusBar("error", { errorMsg: "time limit reached" });
      bumpStat("declined");
      return;
    }

    // 1) Size — wait for the grid to render / restock.
    let cell = null;
    for (let i = 0; i < 40 && !cell; i++) {
      cell = findSizeCell(preferred);
      if (!cell) await wait(250);
    }
    if (!cell) {
      const avail = sizeCells().filter(c => c.available).map(c => c.text).join(", ");
      logBG(`⚠️${tag} FLOW: size US ${normSize(preferred)} not available on ${sku}. Available: ${avail || "none"}${attempt <= max ? ` — retry ${attempt}/${max}` : ""}`);
      if (attempt > max) {
        renderStatusBar("error", { errorMsg: `US ${normSize(preferred)} not available` });
        bumpStat("declined");
        return;
      }
      await wait(delayMs);
      continue;
    }

    // The <input> is visually-hidden — the <label> is the real click target.
    renderStatusBar("size", { size: cell.text || "US " + normSize(preferred) });
    humanClick(cell.label, `Size ${cell.text}`);
    await wait(randInt(250, 500));
    if (!selectedSizeCell()) {
      // Fallback for builds that don't wire the label: set + notify React.
      try {
        cell.input.checked = true;
        cell.input.dispatchEvent(new Event("change", { bubbles: true }));
        cell.input.dispatchEvent(new Event("input", { bubbles: true }));
      } catch (e) {}
      await wait(200);
    }
    logBG(`✅${tag} FLOW: size ${cell.text} selected on ${sku}.`);

    // 2) Add to Bag
    let atb = null;
    for (let i = 0; i < 24 && !atb; i++) { atb = findAtbButton(); if (!atb) await wait(250); }
    if (!atb) {
      logBG(`❌${tag} FLOW: Add to Bag not found${attempt <= max ? ` — retry ${attempt}/${max}` : ""}.`);
      if (attempt > max) { renderStatusBar("error", { errorMsg: "Add to Bag button not found" }); bumpStat("declined"); return; }
      await wait(delayMs);
      continue;
    }

    if (settings?.testMode) {
      logBG(`🧪${tag} FLOW TEST MODE — size ${cell.text} selected, NOT adding to bag.`);
      renderStatusBar("bag", { size: cell.text, label: "TEST MODE — not adding" });
      return;
    }

    renderStatusBar("bag", { size: cell.text });
    humanClick(atb, "Add to Bag");

    // 3) Confirm it actually landed in the bag.
    let added = false;
    for (let i = 0; i < 24 && !added; i++) { await wait(250); added = addedToBagConfirmed(); }
    if (!added) {
      logBG(`⚠️${tag} FLOW: Add to Bag didn't confirm${attempt <= max ? ` — retry ${attempt}/${max}` : ""}.`);
      if (attempt > max) { renderStatusBar("error", { errorMsg: "Add to Bag didn't confirm" }); bumpStat("declined"); return; }
      await wait(delayMs);
      continue;
    }

    logBG(`🛍️${tag} FLOW: ADDED TO BAG — ${sku} ${cell.text}.`);
    bumpStat("carted");
    renderStatusBar("checkout", { size: cell.text, label: "In bag — going to checkout" });

    if (settings?.flowAutoCheckout === false) {
      logBG(`⏸️${tag} FLOW: auto-checkout OFF — stopping with the item in the bag.`);
      renderStatusBar("done", { time: nowClock(), label: "In bag (auto-checkout off)" });
      return;
    }
    await wait(randInt(400, 900));
    const region = (location.pathname.split("/")[1] || "sg");
    location.href = `${location.origin}/${region}/cart`;
    return;
  }
}

// ── CART PAGE: click checkout ────────────────────────────────
async function runCartPage() {
  const tag = profileTag();
  if (settings?.flowAutoCheckout === false) {
    log("Flow: auto-checkout off — leaving the bag alone.");
    return;
  }
  renderStatusBar("checkout", { label: "Bag — opening checkout" });
  let cta = null;
  for (let i = 0; i < 40 && !cta; i++) { cta = findCheckoutCta(); if (!cta) await wait(250); }
  if (!cta) {
    logBG(`❌${tag} FLOW: no checkout button on the bag page — finish by hand.`);
    renderStatusBar("error", { errorMsg: "no checkout button on the bag" });
    return;
  }
  if (settings?.testMode) {
    logBG(`🧪${tag} FLOW TEST MODE — not clicking "${(cta.innerText || "").trim()}".`);
    return;
  }
  if (await checkAbort()) {
    logBG(`🛑${tag} FLOW: abort raised at the bag — not checking out.`);
    renderStatusBar("error", { errorMsg: "aborted by PANIC" });
    return;
  }
  logBG(`💳${tag} FLOW: clicking "${(cta.innerText || "").trim()}"…`);
  humanClick(cta, "Checkout");
}

// ── CHECKOUT PAGE ────────────────────────────────────────────
// nike.com/checkout is a different surface from gs.nike.com, and it can only be
// exercised with a signed-in session and a live bag. We drive the visible
// "place order" step and otherwise hand over rather than guess — a wrong click
// here spends money.
async function runCheckoutPage() {
  const tag = profileTag();
  renderStatusBar("checkout", { label: "Checkout — review" });
  logBG(`🧾${tag} FLOW: on checkout. Auto-submit is ${settings?.flowAutoPlaceOrder ? "ON" : "OFF"}.`);
  if (!settings?.flowAutoPlaceOrder) {
    renderStatusBar("done", { time: nowClock(), label: "At checkout — place the order" });
    return;
  }
  if (await checkAbort()) { renderStatusBar("error", { errorMsg: "aborted by PANIC" }); return; }

  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) {
    btn = Array.from(document.querySelectorAll("button"))
      .find(b => !b.disabled && /place order|submit order|pay now/i.test((b.innerText || "").trim()));
    if (!btn) await wait(250);
  }
  if (!btn) {
    logBG(`⚠️${tag} FLOW: no "Place Order" button found — complete it manually.`);
    renderStatusBar("error", { errorMsg: "Place Order not found — finish manually" });
    return;
  }
  if (settings?.testMode) {
    logBG(`🧪${tag} FLOW TEST MODE — NOT placing the order.`);
    return;
  }
  logBG(`🚀${tag} FLOW: placing order…`);
  humanClick(btn, "Place Order");
  await wait(3000);
  const done = /thank you|order confirmed|order number/i.test(document.body.innerText || "");
  if (done) {
    logBG(`🎉${tag} FLOW: ORDER SUBMITTED.`);
    bumpStat("completed");
    renderStatusBar("done", { time: nowClock(), label: "Order submitted" });
  } else {
    renderStatusBar("checkout", { label: "Submitted — awaiting confirmation" });
  }
}

// ── Init ─────────────────────────────────────────────────────
(async function init() {
  if (hasRun) return;
  hasRun = true;
  try {
    const saved = await chrome.storage.sync.get(SETTINGS_KEY);
    settings = { ...(saved[SETTINGS_KEY] || {}) };
  } catch (e) { return; }

  // FLOW mode only — in SNKRS mode this script stays completely inert so the
  // proven SNKRS path is untouched.
  if (settings?.botMode !== "flow") { log("Not in FLOW mode — idle."); return; }
  if (!settings?.enabled) { log("Bot disabled — idle."); return; }

  if (document.readyState !== "complete") {
    await new Promise(r => window.addEventListener("load", r, { once: true }));
  }
  await wait(400);

  const page = detectPage();
  log("Flow page:", page, location.pathname);
  try {
    if (page === PAGE.PRODUCT) await runProductPage();
    else if (page === PAGE.CART) await runCartPage();
    else if (page === PAGE.CHECKOUT) await runCheckoutPage();
  } catch (e) {
    logBG(`❌${profileTag()} FLOW error: ${e && e.message || e}`);
    renderStatusBar("error", { errorMsg: String(e && e.message || e).slice(0, 80) });
  }
})();
