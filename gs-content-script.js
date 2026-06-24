// ============================================================
// Nike SNKRS Bot – GS Checkout Content Script
// URL: gs.nike.com/?checkoutId=...
// ============================================================

const SETTINGS_KEY = "snkrsBotSettings";
let settings = null;
// DOM-based run guard — survives extension reloads within same page load
// (JS vars reset on extension reload, but dataset persists on the DOM node)
let hasRun = false;
function markHasRun() {
  hasRun = true;
  try { document.documentElement.dataset.snkrsBotRan = Date.now(); } catch(e) {}
}
function checkHasRun() {
  if (hasRun) return true;
  try {
    const ts = parseInt(document.documentElement.dataset.snkrsBotRan || "0");
    if (ts && Date.now() - ts < 180000) return true; // ran within last 3 min
  } catch(e) {}
  return false;
}
// Expose globally so you can type snkrsReset() in console to force a retry
function resetRunGuard() {
  hasRun = false;
  try { delete document.documentElement.dataset.snkrsBotRan; } catch(e) {}
  log("Run guard reset — re-running flow…");
  markHasRun();
  runCheckoutFlow().catch(e => log("Flow error:", e));
}
window.snkrsReset = resetRunGuard;

function log(...args) { console.log("[SNKRSBot GS]", ...args); }
function logBG(msg) {
  try { chrome.runtime.sendMessage({ type: "log", message: msg }); }
  catch (e) { console.warn("[SNKRSBot GS] logBG:", e); }
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function profileTag() {
  return settings?.profileLabel?.trim() ? ` **[${settings.profileLabel.trim()}]**` : "";
}

async function loadSettings() {
  const saved = await chrome.storage.sync.get(SETTINGS_KEY);
  settings = { ...(saved[SETTINGS_KEY] || {}) };
  log("Settings loaded:", JSON.stringify({
    hasCard: !!(settings.cardNumber),
    hasExpiry: !!(settings.cardExpiry),
    hasCvv: !!(settings.cardCvv),
  }));
}

async function waitFor(fn, timeoutMs = 15000, intervalMs = 100) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const r = fn();
    if (r) return r;
    await wait(intervalMs);
  }
  return null;
}

// ── Card fill signal ──────────────────────────────────────────
// Module-level handle so the main flow can cancel the wait early (e.g. when
// the payment is already complete with a saved card on file).
let _cancelCardFill = null;
function cancelCardFillWait() {
  if (typeof _cancelCardFill === "function") {
    _cancelCardFill();
    _cancelCardFill = null;
  }
}

async function armCardFillSignal(timeoutMs = 60000) {
  // Check cache first — iframe may have already filled before we armed
  try {
    const resp = await chrome.runtime.sendMessage({ type: "get_card_fill_cache" });
    if (resp?.cached) {
      const age = Date.now() - resp.cached.ts;
      if (age < 60000) {
        log(`card_fill_done from cache — ${resp.cached.filled}/3 fields, ${age}ms ago`);
        return resp.cached.filled > 0;
      }
    }
  } catch (e) {
    log("Cache check failed (non-fatal):", e.message);
  }

  return new Promise((resolve) => {
    let resolved = false;

    function finish(val, why) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
      _cancelCardFill = null;
      log(`card_fill wait resolved (${why}) → ${val}`);
      resolve(val);
    }

    const timer = setTimeout(() => finish(false, "timeout"), timeoutMs);

    function listener(msg) {
      if (msg.type === "card_fill_done") {
        finish(msg.filled > 0, `signal ${msg.filled}/3`);
      }
    }
    chrome.runtime.onMessage.addListener(listener);

    // Expose a canceller. Resolving with `true` means "stop waiting, proceed" —
    // used when we detect payment is already complete (no fill needed).
    _cancelCardFill = () => finish(true, "cancelled (payment already complete)");

    log("card_fill_done listener armed — waiting…");
  });
}

// ── Native click ──────────────────────────────────────────────
async function nativeClick(el, label, fast = false) {
  if (!el) { log(`nativeClick: null for "${label}"`); return; }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  if (!fast) await wait(randInt(150, 300));
  el.click();
  log(`nativeClick: "${label}"`);
}

// ── Selector helpers (based on confirmed live HTML) ───────────

// The CONTINUE button inside the delivery section
// <button class="button-continue"> Continue </button>
function findDeliveryContinueButton() {
  // No offsetParent check — Angular sets it null during accordion transitions
  const all = Array.from(document.querySelectorAll("button.button-continue"))
    .filter(b => !b.disabled);
  return all.length > 0 ? all[0] : null;
}


// Strict delivery CONTINUE finder.
// Nike GS can show a PAYMENT-section CONTINUE and a SUBMIT ORDER button at the
// same time. The old flow sometimes treated the payment CONTINUE as delivery
// and then clicked SUBMIT before the card iframe finished filling.
function findDeliveryContinueOnly() {
  const visibleContinues = Array.from(document.querySelectorAll("button.button-continue"))
    .filter(b => !b.disabled && b.offsetParent !== null);

  if (!visibleContinues.length) return null;

  // If the payment form is visible, delivery is already confirmed. Any CONTINUE
  // below the form belongs to PAYMENT, so do not click it as delivery.
  const formTop = getPaymentFormTop();
  if (formTop != null) {
    const aboveForm = visibleContinues.filter(
      b => b.getBoundingClientRect().top < formTop - 5
    );
    if (!aboveForm.length) return null;
    aboveForm.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return aboveForm[0];
  }

  // Before payment is expanded, the visible CONTINUE is normally delivery.
  visibleContinues.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  return visibleContinues[0];
}

// The PAYMENT accordion row — find any element whose visible text is
// exactly "PAYMENT" and that has a sibling/child "+" expand button.
// We click the entire row/header so Angular registers the expand.
function findPaymentAccordionRow() {
  // Strategy 1: find a button or div containing only the text "PAYMENT"
  // with a "+" nearby — walk all elements
  const allEls = document.querySelectorAll(
    "div, section, li, button, [class*='accordion'], [class*='category'], [class*='panel'], [class*='header']"
  );
  for (const el of allEls) {
    // Must be a shallow text match — avoid matching children that have tons of text
    const ownText = Array.from(el.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent.trim())
      .join(" ")
      .trim()
      .toUpperCase();

    if (ownText === "PAYMENT") return el;

    // Also check innerText of short elements (avoids giant containers)
    const innerText = (el.innerText || "").trim().toUpperCase();
    if (innerText === "PAYMENT" || innerText === "PAYMENT +") return el;
  }

  // Strategy 2: find the "+" expand button that is next to a PAYMENT label
  const allBtns = document.querySelectorAll("button, [role='button']");
  for (const btn of allBtns) {
    const text = (btn.innerText || btn.textContent || "").trim();
    if (text === "+") {
      // Check parent/siblings for "PAYMENT" text
      const parent = btn.parentElement;
      if (parent && (parent.innerText || "").toUpperCase().includes("PAYMENT")) {
        return parent; // click the whole row
      }
    }
  }

  return null;
}

// Finds the top Y position of the PAYMENT card form, whether it's rendered as
// an iframe (iframe.newCard) OR as inline native inputs (card number / MM-YY /
// CVV). Returns null if no card form is detectable.
function getPaymentFormTop() {
  // Case 1: card iframe
  const iframe = document.querySelector("iframe.newCard[src*='gs-payments'], iframe[src*='gs-payments']");
  if (iframe && iframe.offsetParent !== null) {
    return iframe.getBoundingClientRect().top;
  }

  // Case 2: inline card inputs. Match by name/id/placeholder/label text.
  const inputs = Array.from(document.querySelectorAll("input"));
  const cardInput = inputs.find(inp => {
    const hay = [
      inp.name, inp.id, inp.placeholder,
      inp.getAttribute("aria-label"), inp.autocomplete,
    ].join(" ").toLowerCase();
    return /card\s*number|cardnumber|cc-number|ccnumber|creditcard/.test(hay);
  });
  if (cardInput && cardInput.offsetParent !== null) {
    return cardInput.getBoundingClientRect().top;
  }

  // Case 3: a label/text node that says "Card number"
  const labels = Array.from(document.querySelectorAll("label, span, div, p"));
  const cardLabel = labels.find(el => {
    const t = (el.textContent || "").trim().toLowerCase();
    return t === "card number" || t === "card number *" || t.startsWith("card number");
  });
  if (cardLabel && cardLabel.offsetParent !== null) {
    return cardLabel.getBoundingClientRect().top;
  }

  return null;
}

// Payment iframe — only present when PAYMENT section is expanded
function findPaymentIframe() {
  return document.querySelector("iframe.newCard, iframe[src*='gs-payments']");
}

// CONTINUE button inside the payment section (after card is filled)
// After delivery is confirmed, there should be only one .button-continue visible
function findPaymentContinueButton() {
  const all = Array.from(document.querySelectorAll("button.button-continue"))
    .filter(b => !b.disabled);
  // Take the last one — payment section is lower on page
  return all.length > 0 ? all[all.length - 1] : null;
}

// Strict payment-section CONTINUE finder.
// Returns the CONTINUE that belongs to the PAYMENT section. We anchor on the
// card form's vertical position (iframe OR inline inputs), so the delivery
// CONTINUE (which sits above the card form) is never returned.
//
// Handles all observed cases:
//  - Card in an iframe → anchor on iframe.
//  - Card as inline inputs (no iframe) → anchor on the card-number field.
//  - Only ONE visible CONTINUE and it's below the card form → that's payment.
//  - The only CONTINUE is the delivery one (above the card form) → return null.
function findPaymentContinueOnly() {
  const visibleContinues = Array.from(document.querySelectorAll("button.button-continue"))
    .filter(b => !b.disabled && b.offsetParent !== null);

  if (!visibleContinues.length) return null;

  const formTop = getPaymentFormTop();

  if (formTop == null) {
    // No detectable card form. If there's exactly one visible CONTINUE, it's
    // most likely the payment one at this stage (delivery already confirmed).
    // If there are several, we can't safely disambiguate → return null.
    if (visibleContinues.length === 1) return visibleContinues[0];
    return null;
  }

  // Keep only CONTINUEs clearly BELOW the card form (the payment section).
  const belowForm = visibleContinues.filter(
    b => b.getBoundingClientRect().top > formTop + 5
  );

  if (!belowForm.length) return null;

  // Lowest one = the payment CONTINUE.
  belowForm.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  return belowForm[belowForm.length - 1];
}

// SUBMIT ORDER — confirmed class: button-submit
// <button class="button-submit"> Submit Order </button>
function findSubmitOrderButton() {
  const byClass = document.querySelector("button.button-submit");
  if (byClass && !byClass.disabled) return byClass;
  // Fallback: text match
  return Array.from(document.querySelectorAll("button")).find(b => {
    if (b.disabled) return false;
    return (b.textContent || "").trim().toUpperCase() === "SUBMIT ORDER";
  }) || null;
}

// Detects whether PAYMENT is ALREADY complete (a saved card is on file), so we
// must NOT wait for a card-fill that will never happen and must NOT re-open the
// payment accordion. Signals (any one is enough):
//   - There is NO open payment card iframe AND a card brand/last-4 is shown in
//     the collapsed PAYMENT row (e.g. "VISA 5992").
//   - SUBMIT ORDER is already present and enabled while no card iframe is open.
function isPaymentAlreadyComplete() {
  // An iframe only counts as "open" (needing entry) if it's actually visible.
  // Nike preloads a hidden iframe.newCard even when a saved card is on file.
  const iframeEl = document.querySelector("iframe.newCard[src*='gs-payments'], iframe[src*='gs-payments']");
  const iframeOpen = !!(iframeEl && iframeEl.offsetParent !== null);
  if (iframeOpen) return false;

  // Look for a masked card indicator near a PAYMENT label.
  const bodyText = (document.body.innerText || "");
  const hasCardBrand = /\b(VISA|MASTERCARD|MASTER CARD|AMEX|AMERICAN EXPRESS)\b/i.test(bodyText);
  const hasLast4Near = /\b(VISA|MASTERCARD|AMEX)\b[\s\S]{0,40}?\d{3,4}\b/i.test(bodyText)
                    || /PAYMENT[\s\S]{0,60}?\d{4}\b/i.test(bodyText.toUpperCase());

  // Submit present with no open card form is a strong "ready to submit" signal.
  const submitReady = !!findSubmitOrderButton();

  // No OPEN card form, and either a masked card is shown or (a brand is shown
  // and Submit is ready) → payment is already complete.
  if (hasLast4Near || (hasCardBrand && submitReady)) return true;
  return false;
}

// Detects whether INLINE card fields (native inputs on gs.nike.com, no iframe)
// already contain a card number. Used so we don't wait for an iframe card-fill
// signal that will never fire when the form is inline.
function isInlineCardFilled() {
  const inputs = Array.from(document.querySelectorAll("input"));
  const cardInput = inputs.find(inp => {
    const hay = [inp.name, inp.id, inp.placeholder, inp.getAttribute("aria-label"), inp.autocomplete]
      .join(" ").toLowerCase();
    return /card\s*number|cardnumber|cc-number|ccnumber|creditcard/.test(hay);
  });
  if (!cardInput) return false;
  const digits = (cardInput.value || "").replace(/\D/g, "");
  return digits.length >= 12;
}

// ── Confirmation watcher ──────────────────────────────────────
function watchForConfirmation(tag) {
  const startUrl = location.href;
  const startTs  = Date.now();
  const iv = setInterval(() => {
    const text = (document.body.innerText || "").toUpperCase();
    if (text.includes("PROCESSING YOUR ENTRY") || text.includes("JUST A MINUTE")) return;
    if (!location.hostname.includes("gs.nike.com")) {
      clearInterval(iv); logBG(`🎉${tag} Entry complete → ${location.href}`); return;
    }
    if (text.includes("ORDER CONFIRMED") || text.includes("THANK YOU") ||
        text.includes("YOU'RE IN") || location.href !== startUrl) {
      clearInterval(iv); logBG(`🎉${tag} ORDER SUBMITTED! ${location.href}`); return;
    }
    if (Date.now() - startTs > 30000) {
      clearInterval(iv); logBG(`⚠️${tag} No confirmation after 30s — check manually.`);
    }
  }, 1000);
}

// ── DOM debug dump ────────────────────────────────────────────
function dumpPageState() {
  log("=== PAGE STATE DUMP ===");
  log("button-continue count:", document.querySelectorAll("button.button-continue").length);
  log("button-submit count:", document.querySelectorAll("button.button-submit").length);
  log("payment iframe:", !!findPaymentIframe());
  log("PAYMENT accordion:", !!findPaymentAccordionRow());

  document.querySelectorAll("button").forEach((b, i) => {
    log(`btn[${i}] class="${b.className}" text="${(b.textContent||"").trim().slice(0,40)}" disabled=${b.disabled} visible=${b.offsetParent!==null}`);
  });
  log("=== END DUMP ===");
}

// ── Main checkout flow ────────────────────────────────────────
async function runCheckoutFlow() {
  const tag = profileTag();
  logBG(`@here 💳${tag} SNKRS checkout — starting…`);

  // ARM card fill listener FIRST — never miss the signal
  const cardFillPromise = armCardFillSignal(60000);

  // Let Angular finish rendering
  await wait(2000);
  dumpPageState();

  // ── STEP 1: CONTINUE (delivery) ──────────────────────────────
  // Only click the delivery CONTINUE. If the payment form is already visible,
  // any visible CONTINUE is probably the payment-section CONTINUE and should be
  // clicked only AFTER the card fill is complete.
  const deliveryContinue = findDeliveryContinueOnly();

  if (deliveryContinue) {
    logBG(`✅${tag} [1/3] Clicking CONTINUE (delivery)…`);
    await nativeClick(deliveryContinue, "CONTINUE (delivery)");
    await wait(1500);
  } else {
    log("Delivery CONTINUE not visible — already confirmed or payment form is open.");
  }

  // ── STEP 2: Ensure the card is filled (then we go straight to SUBMIT) ──
  // After delivery CONTINUE, the payment card form becomes active. The card is
  // filled by one of these paths:
  //   (A) Saved card already on file → nothing to fill.
  //   (B) Inline native card fields → already filled (or filled by the user).
  //   (C) gs-payments iframe → filled by gs-payments-content-script, which
  //       signals us via cardFillPromise.
  // We do NOT need a payment-CONTINUE step; SUBMIT ORDER places the order.
  if (isPaymentAlreadyComplete()) {
    logBG(`💳${tag} Payment already on file — no card entry needed.`);
    cancelCardFillWait();
  } else if (isInlineCardFilled()) {
    logBG(`💳${tag} Card details already filled — proceeding to SUBMIT.`);
    cancelCardFillWait();
  } else {
    // Card not yet filled. Make sure a card form is surfaced (expand PAYMENT if
    // needed), then wait for the iframe fill signal OR for the inline fields to
    // become filled OR for SUBMIT to appear — whichever happens first.
    const iframe = document.querySelector("iframe.newCard[src*='gs-payments']");
    if (!iframe && !isInlineCardFilled()) {
      const paymentRow = await waitFor(findPaymentAccordionRow, 6000, 150);
      if (paymentRow) {
        logBG(`✅${tag} Expanding PAYMENT…`);
        await nativeClick(paymentRow, "PAYMENT accordion row");
      }
    }

    logBG(`⏳${tag} Waiting for card details to be filled…`);
    // Race the iframe signal against inline-filled / submit-ready detection.
    const filledSomehow = await Promise.race([
      cardFillPromise.then(v => ({ via: "iframe", ok: v })),
      (async () => {
        const ok = await waitFor(
          () => isInlineCardFilled() || isPaymentAlreadyComplete(),
          60000, 300
        );
        return { via: "inline/submit", ok: !!ok };
      })(),
    ]);
    cancelCardFillWait();

    if (!filledSomehow.ok && !isInlineCardFilled() && !isPaymentAlreadyComplete() && !findSubmitOrderButton()) {
      logBG(`❌${tag} Card details could not be filled — ABORTING.`);
      dumpPageState();
      return;
    }
    logBG(`✅${tag} Card details ready (${filledSomehow.via}) — confirming PAYMENT…`);

    // Some Nike GS layouts keep a payment-section CONTINUE visible even though
    // SUBMIT ORDER is already present. Click it after card fill so the payment
    // accordion commits the card before final submit.
    const paymentContinue = findPaymentContinueOnly();
    if (paymentContinue) {
      logBG(`✅${tag} Clicking CONTINUE (payment)…`);
      await nativeClick(paymentContinue, "CONTINUE (payment)");
      await wait(1200);
    } else {
      await wait(400);
    }
  }

  // ── FINAL STEP: SUBMIT ORDER ──────────────────────────────────
  // Per the real checkout flow: after delivery CONTINUE is clicked and the card
  // details are filled, the order is placed by clicking SUBMIT ORDER. There is
  // no separate payment-CONTINUE step required — SUBMIT ORDER is the action.
  //
  // We wait for SUBMIT ORDER to appear and become enabled, then click it.
  // ONLY if SUBMIT never shows do we try a payment-section CONTINUE once (some
  // layouts gate SUBMIT behind a CONTINUE), then wait for SUBMIT again.
  logBG(`⏳${tag} Waiting for SUBMIT ORDER…`);
  let submitBtn = await waitFor(findSubmitOrderButton, 12000, 100);

  if (!submitBtn) {
    // SUBMIT not visible yet. As a fallback, a payment-section CONTINUE may be
    // gating it. Click it once (never the delivery one), then wait again.
    const gatingContinue = findPaymentContinueOnly();
    if (gatingContinue) {
      logBG(`⚠️${tag} SUBMIT not visible — clicking payment CONTINUE once to reveal it…`);
      await nativeClick(gatingContinue, "CONTINUE (payment, to reveal SUBMIT)");
      submitBtn = await waitFor(findSubmitOrderButton, 8000, 100);
    }
  }

  if (!submitBtn) {
    logBG(`❌${tag} SUBMIT ORDER not found.`);
    dumpPageState();
    return;
  }

  if (settings?.testMode) {
    logBG(`🧪${tag} TEST MODE — NOT clicking SUBMIT ORDER.`);
    return;
  }

  logBG(`🚀${tag} Clicking SUBMIT ORDER…`);
  await nativeClick(submitBtn, "SUBMIT ORDER", true);
  await wait(500);
  dumpPageState();
  watchForConfirmation(tag);
}

// ── Init ──────────────────────────────────────────────────────
(async function init() {
  if (checkHasRun()) return;
  markHasRun();
  await loadSettings();
  if (!settings?.enabled) { log("Bot disabled."); return; }
  if (document.readyState !== "complete") {
    await new Promise(resolve => window.addEventListener("load", resolve, { once: true }));
  }
  await wait(300);

  // Run the flow — if it fails or times out, reset the guard and retry once
  try {
    await runCheckoutFlow();
  } catch (err) {
    try { logBG(`❌ GS error (will retry): ${err}`); } catch (_) {}
    console.error("[SNKRSBot GS] flow error, retrying in 3s:", err);
    // Reset guard so retry can run
    hasRun = false;
    try { delete document.documentElement.dataset.snkrsBotRan; } catch(e) {}
    await wait(3000);
    if (!checkHasRun()) {
      markHasRun();
      runCheckoutFlow().catch(err2 => {
        try { logBG(`❌ GS retry also failed: ${err2}`); } catch (_) {}
      });
    }
  }
})();