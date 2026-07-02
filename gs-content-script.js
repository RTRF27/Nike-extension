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
// True while THIS content script's extension context is still valid. When the
// extension is reloaded/updated with the tab still open, the old script is
// orphaned and chrome.runtime.id becomes undefined — we then stop quietly
// instead of throwing "Extension context invalidated" over and over.
function extAlive() { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } }
function logBG(msg) {
  if (!extAlive()) return; // orphaned tab — the extension was reloaded; stop quietly
  try { chrome.runtime.sendMessage({ type: "log", message: msg }); }
  catch (e) { /* context invalidated mid-call — ignore */ }
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// ── Minimized-window helpers ──────────────────────────────────
// Chrome sets offsetParent=null for ALL elements in a minimized window (no layout
// pass occurs off-screen). getBoundingClientRect() also returns all-zero rects.
// These helpers work correctly regardless of window state.

function isWindowMinimized() {
  return !!(document.body && document.body.getBoundingClientRect().width === 0);
}

// CSS-computed visibility — works when window is minimized (unlike offsetParent).
function isLogicallyVisible(el) {
  if (!el) return false;
  const s = window.getComputedStyle(el);
  return s.display !== "none" && s.visibility !== "hidden" && parseFloat(s.opacity || "1") > 0;
}

// Returns the DOM element that anchors the top of the payment card form.
// Used for above/below ordering via compareDocumentPosition instead of Y coordinates —
// the only approach that is reliable in minimized windows.
function findPaymentFormEl() {
  const iframe = document.querySelector("iframe.newCard[src*='gs-payments'], iframe[src*='gs-payments']");
  if (iframe && isLogicallyVisible(iframe)) return iframe;

  const cardInput = Array.from(document.querySelectorAll("input")).find(inp => {
    const hay = [inp.name, inp.id, inp.placeholder, inp.getAttribute("aria-label"), inp.autocomplete]
      .join(" ").toLowerCase();
    return /card\s*number|cardnumber|cc-number|ccnumber|creditcard/.test(hay);
  });
  if (cardInput && isLogicallyVisible(cardInput)) return cardInput;

  const cardLabel = Array.from(document.querySelectorAll("label, span, div, p")).find(el => {
    const t = (el.textContent || "").trim().toLowerCase();
    return t === "card number" || t === "card number *" || t.startsWith("card number");
  });
  if (cardLabel && isLogicallyVisible(cardLabel)) return cardLabel;

  return null;
}

// Sort elements by DOM order (earlier in document = lower index).
function sortByDomOrder(els) {
  return els.slice().sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  );
}

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
  el.scrollIntoView({ behavior: fast ? "auto" : "smooth", block: "center" });
  if (!fast) await wait(randInt(150, 300));

  // Nike's checkout buttons are Angular components that often ignore a bare
  // el.click() — they listen on the real pointer/mouse event sequence. Dispatch
  // the full sequence (with coordinates when the window isn't minimized), then
  // fall back to el.click() for any handler bound directly to click.
  const r = el.getBoundingClientRect();
  const minimized = (r.width === 0 && r.height === 0) || isWindowMinimized();
  const cx = minimized ? 0 : r.left + r.width / 2;
  const cy = minimized ? 0 : r.top + r.height / 2;
  const opt = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy };

  try { el.focus(); } catch (e) {}
  for (const type of ["pointerover", "mouseover", "pointerenter",
                       "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    try { el.dispatchEvent(new MouseEvent(type, opt)); } catch (e) {}
    await wait(randInt(4, 12));
  }
  try { el.click(); } catch (e) {} // belt-and-suspenders fallback
  log(`nativeClick: "${label}" (sequence${minimized ? ", minimized" : ""})`);
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
//
// Uses CSS-computed visibility + DOM order instead of offsetParent/getBoundingClientRect
// so it works correctly when the browser window is minimized.
function findDeliveryContinueOnly() {
  const visibleContinues = Array.from(document.querySelectorAll("button.button-continue"))
    .filter(b => !b.disabled && isLogicallyVisible(b));

  if (!visibleContinues.length) {
    log(`findDeliveryContinueOnly: no non-disabled visible CONTINUEs (minimized=${isWindowMinimized()})`);
    return null;
  }

  // If the payment form is visible, delivery is already confirmed. Any CONTINUE
  // that appears AFTER the form in the DOM belongs to PAYMENT — do not click it.
  const formEl = findPaymentFormEl();
  if (formEl != null) {
    const aboveForm = visibleContinues.filter(b =>
      !!(formEl.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING)
    );
    if (!aboveForm.length) {
      log(`findDeliveryContinueOnly: all CONTINUEs are after the payment form — none are delivery`);
      return null;
    }
    const sorted = sortByDomOrder(aboveForm);
    log(`findDeliveryContinueOnly: found delivery CONTINUE (above payment form)`);
    return sorted[0];
  }

  // Before payment is expanded, the earliest CONTINUE in DOM order is delivery.
  const sorted = sortByDomOrder(visibleContinues);
  log(`findDeliveryContinueOnly: found delivery CONTINUE (no payment form yet)`);
  return sorted[0];
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

// Finds the top Y position of the PAYMENT card form for legacy callers.
// NOTE: When the window is minimized, getBoundingClientRect() returns 0 for everything.
// New code should use findPaymentFormEl() + compareDocumentPosition instead.
// This function adds an offsetTop fallback so callers that still need a number
// get something non-zero even when minimized.
function getPaymentFormTop() {
  const el = findPaymentFormEl();
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  // If rect.top is non-zero the window is visible — use it directly.
  if (rect.top !== 0 || rect.height !== 0) return rect.top;
  // Minimized: climb the DOM to build an approximate offsetTop.
  let top = 0;
  let node = el;
  while (node && node !== document.body) {
    top += node.offsetTop || 0;
    node = node.offsetParent;
  }
  return top;
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
// card form element in the DOM (via findPaymentFormEl), using compareDocumentPosition
// for above/below ordering — this works in minimized windows where
// getBoundingClientRect() returns zeros and offsetParent is null for everything.
function findPaymentContinueOnly() {
  const visibleContinues = Array.from(document.querySelectorAll("button.button-continue"))
    .filter(b => !b.disabled && isLogicallyVisible(b));

  if (!visibleContinues.length) {
    log(`findPaymentContinueOnly: no enabled visible CONTINUEs (minimized=${isWindowMinimized()})`);
    return null;
  }

  const formEl = findPaymentFormEl();

  if (formEl == null) {
    // No detectable card form. If there's exactly one visible CONTINUE, it's
    // most likely the payment one at this stage (delivery already confirmed).
    // If there are several, we can't safely disambiguate → return null.
    if (visibleContinues.length === 1) {
      log(`findPaymentContinueOnly: single CONTINUE, no payment form yet — treating as payment`);
      return visibleContinues[0];
    }
    log(`findPaymentContinueOnly: ${visibleContinues.length} CONTINUEs but no card form — ambiguous`);
    return null;
  }

  // Keep only CONTINUEs that come AFTER the card form element in the DOM.
  const afterForm = visibleContinues.filter(b =>
    !!(formEl.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
  );

  if (!afterForm.length) {
    log(`findPaymentContinueOnly: all CONTINUEs are before the card form — none are payment`);
    return null;
  }

  // Last one in DOM order = payment CONTINUE.
  const sorted = sortByDomOrder(afterForm);
  log(`findPaymentContinueOnly: found payment CONTINUE (after card form in DOM)`);
  return sorted[sorted.length - 1];
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
//
// Uses isLogicallyVisible() instead of offsetParent so this works in minimized windows.
function isPaymentAlreadyComplete() {
  // An iframe only counts as "open" (needing entry) if it's actually visible.
  // Nike preloads a hidden iframe.newCard even when a saved card is on file.
  const iframeEl = document.querySelector("iframe.newCard[src*='gs-payments'], iframe[src*='gs-payments']");
  const iframeOpen = !!(iframeEl && isLogicallyVisible(iframeEl));
  if (iframeOpen) {
    log(`isPaymentAlreadyComplete: card iframe is open — not complete yet`);
    return false;
  }

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
// Builds a compact snapshot of every relevant button + key page signals.
// Pass toDiscord=true to also push it to the log webhook (so you can see
// EXACTLY what the bot sees when it gets stuck, without opening DevTools).
function dumpPageState(tag = "", toDiscord = false) {
  const continues = document.querySelectorAll("button.button-continue").length;
  const submits   = document.querySelectorAll("button.button-submit").length;
  const iframeOpen = (() => {
    const f = document.querySelector("iframe.newCard[src*='gs-payments'], iframe[src*='gs-payments']");
    return f ? isLogicallyVisible(f) : false;
  })();

  log("=== PAGE STATE DUMP ===");
  log("button-continue:", continues, "button-submit:", submits,
      "iframeOpen:", iframeOpen, "minimized:", isWindowMinimized());

  // Per-button detail. Log BOTH visibility signals so we can tell when the
  // minimized-window offsetParent bug is in play (offVis=false but cssVis=true).
  const btnLines = [];
  document.querySelectorAll("button").forEach((b, i) => {
    const txt = (b.textContent || "").trim().slice(0, 30);
    const offVis = b.offsetParent !== null;
    const cssVis = isLogicallyVisible(b);
    log(`btn[${i}] class="${b.className}" text="${txt}" disabled=${b.disabled} offVis=${offVis} cssVis=${cssVis}`);
    // Only the buttons that matter go to Discord (keep the message small).
    if (/button-continue|button-submit/.test(b.className) ||
        /continue|submit|order|pay/i.test(txt)) {
      btnLines.push(`• "${txt || b.className}" dis=${b.disabled ? "Y" : "N"} vis=${cssVis ? "Y" : "N"}`);
    }
  });
  log("=== END DUMP ===");

  if (toDiscord) {
    const finders = [
      `deliveryCont=${!!findDeliveryContinueOnly()}`,
      `paymentForm=${!!findPaymentFormEl()}`,
      `paymentCont=${!!findPaymentContinueOnly()}`,
      `submitBtn=${!!findSubmitOrderButton()}`,
      `paymentDone=${isPaymentAlreadyComplete()}`,
      `inlineCard=${isInlineCardFilled()}`,
    ].join(" | ");
    const msg =
      `🔬${tag} PAGE STATE — minimized=${isWindowMinimized()} | ` +
      `continues=${continues} submits=${submits} iframeOpen=${iframeOpen}\n` +
      `Finders: ${finders}\n` +
      (btnLines.length ? `Buttons:\n${btnLines.slice(0, 10).join("\n")}` : `Buttons: (none relevant found)`);
    logBG(msg.slice(0, 1800)); // stay under Discord's message limit
  }
}

// ── Main checkout flow ────────────────────────────────────────
async function runCheckoutFlow() {
  const tag = profileTag();
  logBG(`💳${tag} SNKRS checkout — starting…`);

  // ARM card fill listener FIRST — never miss the signal
  const cardFillPromise = armCardFillSignal(60000);

  // Let Angular finish rendering
  await wait(2000);

  const minimized = isWindowMinimized();
  if (minimized) {
    logBG(`⚠️${tag} Window is MINIMIZED — using DOM-order visibility checks (offsetParent bypass active)`);
  }
  dumpPageState(tag, true); // snapshot to Discord at the very start

  // ── STEP 1: CONTINUE (delivery) ──────────────────────────────
  // Only click the delivery CONTINUE. If the payment form is already visible,
  // any visible CONTINUE is probably the payment-section CONTINUE and should be
  // clicked only AFTER the card fill is complete.
  logBG(`🔍${tag} [1/3] Looking for delivery CONTINUE…`);
  const deliveryContinue = findDeliveryContinueOnly();

  if (deliveryContinue) {
    logBG(`✅${tag} [1/3] Clicking CONTINUE (delivery)…`);
    await nativeClick(deliveryContinue, "CONTINUE (delivery)");
    await wait(1500);
  } else {
    logBG(`ℹ️${tag} [1/3] Delivery CONTINUE not found — already confirmed or payment form is open.`);
  }

  // ── STEP 2: Ensure the card is filled (then we go straight to SUBMIT) ──
  // After delivery CONTINUE, the payment card form becomes active. The card is
  // filled by one of these paths:
  //   (A) Saved card already on file → nothing to fill.
  //   (B) Inline native card fields → already filled (or filled by the user).
  //   (C) gs-payments iframe → filled by gs-payments-content-script, which
  //       signals us via cardFillPromise.
  // We do NOT need a payment-CONTINUE step; SUBMIT ORDER places the order.
  logBG(`🔍${tag} [2/3] Checking payment state…`);
  if (isPaymentAlreadyComplete()) {
    logBG(`💳${tag} [2/3] Payment already on file — no card entry needed.`);
    cancelCardFillWait();
  } else if (isInlineCardFilled()) {
    logBG(`💳${tag} [2/3] Card details already filled inline — proceeding to SUBMIT.`);
    cancelCardFillWait();
  } else {
    // Card not yet filled. Make sure a card form is surfaced (expand PAYMENT if
    // needed), then wait for the iframe fill signal OR for the inline fields to
    // become filled OR for SUBMIT to appear — whichever happens first.
    const iframe = document.querySelector("iframe.newCard[src*='gs-payments']");
    if (!iframe && !isInlineCardFilled()) {
      logBG(`🔍${tag} [2/3] No payment iframe — looking for PAYMENT accordion to expand…`);
      const paymentRow = await waitFor(findPaymentAccordionRow, 6000, 150);
      if (paymentRow) {
        logBG(`✅${tag} [2/3] Expanding PAYMENT accordion…`);
        await nativeClick(paymentRow, "PAYMENT accordion row");
      } else {
        logBG(`⚠️${tag} [2/3] PAYMENT accordion not found after 6s — card iframe may already be loading`);
      }
    } else {
      logBG(`ℹ️${tag} [2/3] Payment iframe already present — waiting for fill signal…`);
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

    logBG(`ℹ️${tag} [2/3] Fill race resolved: via=${filledSomehow.via} ok=${filledSomehow.ok} ` +
      `| inlineFilled=${isInlineCardFilled()} | alreadyComplete=${isPaymentAlreadyComplete()} ` +
      `| submitFound=${!!findSubmitOrderButton()}`);
    if (!filledSomehow.ok && !isInlineCardFilled() && !isPaymentAlreadyComplete() && !findSubmitOrderButton()) {
      logBG(`❌${tag} Card details could not be filled — ABORTING.`);
      dumpPageState(tag, true);
      return;
    }
    logBG(`✅${tag} [2/3] Card details ready (${filledSomehow.via}) — confirming PAYMENT…`);

    // Some Nike GS layouts keep a payment-section CONTINUE visible even though
    // SUBMIT ORDER is already present. Click it after card fill so the payment
    // accordion commits the card before final submit.
    const paymentContinue = findPaymentContinueOnly();
    if (paymentContinue) {
      logBG(`✅${tag} [2/3] Clicking CONTINUE (payment)…`);
      await nativeClick(paymentContinue, "CONTINUE (payment)");
      await wait(1200);
    } else {
      logBG(`ℹ️${tag} [2/3] No payment-section CONTINUE found — going straight to SUBMIT`);
      await wait(400);
    }
  }

  // ── FINAL STEP: commit PAYMENT, then SUBMIT ORDER ─────────────
  // A `button.button-submit` is pre-rendered on the page even before checkout is
  // ready, so merely "finding" it isn't enough — clicking SUBMIT while the
  // PAYMENT section is still open (its CONTINUE visible) does nothing (this was
  // the stall: card filled, but the order never went through). So first make
  // sure the payment CONTINUE is gone (payment committed), THEN submit.
  logBG(`⏳${tag} [3/3] Finalising — committing payment, then submitting…`);

  // 1) Click the payment CONTINUE until it disappears. Angular sometimes drops
  //    the first synthetic click; the new pointer-sequence click + retries fix
  //    that. Bounded so we never loop forever.
  for (let i = 0; i < 4; i++) {
    const pc = findPaymentContinueOnly();
    if (!pc) break;
    logBG(`✅${tag} [3/3] Clicking CONTINUE (payment) to commit it (try ${i + 1})…`);
    await nativeClick(pc, "CONTINUE (payment)");
    await wait(1600);
  }

  // 2) Wait for a SUBMIT ORDER button, with a live heartbeat.
  let hb = 0;
  const heartbeat = setInterval(() => {
    hb++;
    const all = Array.from(document.querySelectorAll("button.button-submit"));
    logBG(`💓${tag} [3/3] waiting for SUBMIT (${hb * 3}s) — submitBtns=${all.length} ` +
      `enabled=${all.filter(b => !b.disabled).length} | paymentCont=${!!findPaymentContinueOnly()}`);
  }, 3000);
  let submitBtn = await waitFor(findSubmitOrderButton, 12000, 100);
  clearInterval(heartbeat);

  if (!submitBtn) {
    logBG(`❌${tag} [3/3] SUBMIT ORDER not found — STUCK HERE. Full page state:`);
    dumpPageState(tag, true);
    return;
  }
  logBG(`✅${tag} [3/3] SUBMIT ORDER found and enabled.`);

  if (settings?.testMode) {
    logBG(`🧪${tag} TEST MODE — NOT clicking SUBMIT ORDER.`);
    return;
  }

  // ── DROP-TIME GATE ────────────────────────────────────────────
  // Everything above is PREP: delivery confirmed, card filled, payment committed,
  // SUBMIT ready. We must NOT place the order before the launch is active —
  // submitting early returns LAUNCH_NOT_ACTIVE and bounces the page. So hold here
  // until the real drop time, then click the instant it opens. dropAtMs is
  // stamped in by the gs bootstrap from the schedule; if it's absent we submit
  // immediately (manual/no-schedule behaviour unchanged).
  try {
    // Per-TAB drop time (multi-product: each tab in a profile has its own),
    // written to sessionStorage by the gs bootstrap; fall back to the shared
    // per-profile setting for the single-product case.
    let dropAt = 0;
    try { dropAt = Number(sessionStorage.getItem("snkrsDropAt")) || 0; } catch (e) {}
    if (!dropAt) {
      const sres = await chrome.storage.sync.get(SETTINGS_KEY);
      dropAt = Number((sres[SETTINGS_KEY] || {}).dropAtMs) || 0;
    }
    if (dropAt && Date.now() < dropAt) {
      logBG(`⏸️${tag} [3/3] Primed — holding SUBMIT until drop time ${new Date(dropAt).toLocaleTimeString()}.`);
      while (Date.now() < dropAt) {
        const left = dropAt - Date.now();
        if (left > 5000) {
          logBG(`⏳${tag} [3/3] ${Math.ceil(left / 1000)}s to drop — SUBMIT held…`);
          await wait(Math.min(3000, left - 1500));
        } else {
          await wait(120); // fine-grained as we approach drop for a precise click
        }
      }
      logBG(`🟢${tag} [3/3] DROP TIME — submitting now!`);
    }
  } catch (e) { /* if the gate errors, fall through and submit */ }

  // 3) Click SUBMIT and VERIFY it took effect. Nike can ignore the first click
  //    or re-open the payment section — so verify the page actually advanced and
  //    retry a few times (re-committing payment if it reappeared).
  logBG(`@here 🚀${tag} Clicking SUBMIT ORDER…`);
  const startUrl = location.href;
  const advanced = () => {
    const t = (document.body.innerText || "").toUpperCase();
    if (!location.hostname.includes("gs.nike.com")) return true;
    if (location.href !== startUrl) return true;
    return /PROCESSING|JUST A MINUTE|ORDER CONFIRMED|THANK YOU|YOU'RE IN|ENTRY CONFIRMED/.test(t);
  };

  let submitted = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // If the payment section re-opened, re-commit it before submitting.
    const pc = findPaymentContinueOnly();
    if (pc) {
      logBG(`⚠️${tag} [3/3] payment CONTINUE reappeared — re-committing before submit…`);
      await nativeClick(pc, "CONTINUE (payment) re-commit");
      await wait(1500);
    }
    const sb = findSubmitOrderButton();
    if (!sb) {
      if (advanced()) { submitted = true; break; } // already progressing
      await wait(800);
      continue;
    }
    logBG(`🚀${tag} [3/3] SUBMIT ORDER click attempt ${attempt}…`);
    await nativeClick(sb, "SUBMIT ORDER", true);
    submitted = true;
    // Give the page up to ~5s to react before deciding to retry.
    if (await waitFor(advanced, 5000, 250)) {
      logBG(`✅${tag} [3/3] Submit registered — order is processing.`);
      break;
    }
    logBG(`🔁${tag} [3/3] Submit didn't advance yet (attempt ${attempt}) — retrying…`);
  }

  if (!submitted) {
    logBG(`❌${tag} [3/3] Could not click SUBMIT ORDER.`);
    dumpPageState(tag, true);
    return;
  }
  await wait(500);
  dumpPageState();
  watchForConfirmation(tag);
}

// ── Init ──────────────────────────────────────────────────────
(async function init() {
  if (checkHasRun()) { log("Already ran on this page — skipping."); return; }
  markHasRun();
  await loadSettings();
  // Proof-of-injection: if you DON'T see this line in Discord on a checkout
  // page, the content script isn't running in that profile at all (extension
  // not loaded there) — which is a force-install / profile issue, not a
  // checkout-flow bug.
  logBG(`🟢${profileTag()} GS checkout script injected on ${location.hostname}` +
        ` (enabled=${settings?.enabled !== false}, testMode=${!!settings?.testMode})`);
  if (!settings?.enabled) { logBG(`⏹️${profileTag()} Bot disabled in settings — not running checkout.`); return; }
  if (document.readyState !== "complete") {
    await new Promise(resolve => window.addEventListener("load", resolve, { once: true }));
  }
  await wait(300);

  // ── Single-flight flow runner + stall watchdog ──────────────
  // The flow can stall before submitting (e.g. delivery filled but PAYMENT
  // never expanded, or a click that didn't register). A watchdog re-drives it
  // from the current state, bounded, WITHOUT ever running two flows at once
  // (so it never fights the drop-time hold, which keeps the flow "running").
  let flowRunning = false;
  let redrives = 0;
  async function drive() {
    if (flowRunning) return;
    flowRunning = true;
    try { await runCheckoutFlow(); }
    catch (err) { try { logBG(`❌${profileTag()} flow error: ${err}`); } catch (_) {} }
    finally { flowRunning = false; }
  }

  const isConfirmed = () => {
    if (!location.hostname.includes("gs.nike.com")) return true;
    const t = (document.body.innerText || "").toUpperCase();
    return /PROCESSING|JUST A MINUTE|ORDER CONFIRMED|THANK YOU|YOU'RE IN|ENTRY CONFIRMED/.test(t);
  };
  const stuckPreSubmit = () =>
    location.hostname.includes("gs.nike.com") && !isConfirmed() &&
    !!(findDeliveryContinueOnly() || findPaymentContinueOnly() || findPaymentAccordionRow());

  await drive(); // initial run

  const watchdog = setInterval(() => {
    if (!extAlive()) { clearInterval(watchdog); return; } // extension reloaded — orphaned tab, stop
    if (isConfirmed()) { clearInterval(watchdog); return; }
    if (redrives >= 4) { clearInterval(watchdog); return; }
    if (flowRunning) return;            // busy (incl. holding for drop) — leave it
    if (stuckPreSubmit()) {
      redrives++;
      logBG(`🩺${profileTag()} Watchdog: checkout stalled before submit — re-driving (${redrives}/4).`);
      drive();
    }
  }, 12000);
})();