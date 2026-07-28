// ============================================================
// Reagan Bot – gs-payments.nike.com iframe Content Script
// Fast but human-like: urgent typist copping hyped shoes
// ============================================================

const SETTINGS_KEY = "snkrsBotSettings";
let settings = null;

function log(...args) { console.log("[SNKRSBot PAYMENTS]", ...args); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randFloat(min, max) { return Math.random() * (max - min) + min; }

function logBG(msg) {
  try { chrome.runtime.sendMessage({ type: "log", message: msg, profileDir: settings?.profileDir }); }
  catch (e) { console.warn("[SNKRSBot PAYMENTS] logBG:", e); }
}

async function waitFor(fn, timeoutMs = 15000, intervalMs = 150) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const r = fn();
    if (r) return r;
    await wait(intervalMs);
  }
  return null;
}

// ── Quick mouse approach (fewer steps, faster) ────────────────
async function quickMouseTo(el) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  // When the window is minimized getBoundingClientRect() returns all zeros —
  // skip mouse-move simulation since the coordinates would be meaningless.
  if (rect.width === 0 && rect.height === 0) return;
  const targetX = rect.left + rect.width  * randFloat(0.25, 0.75);
  const targetY = rect.top  + rect.height * randFloat(0.25, 0.75);
  const startX  = targetX + randInt(-50, 50);
  const startY  = targetY + randInt(-25, 25);
  const steps   = randInt(4, 7); // fewer steps = faster

  for (let i = 1; i <= steps; i++) {
    const ease = 1 - Math.pow(1 - i / steps, 2);
    el.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true, cancelable: true, composed: true,
      clientX: startX + (targetX - startX) * ease + randFloat(-0.5, 0.5),
      clientY: startY + (targetY - startY) * ease + randFloat(-0.5, 0.5),
      view: window,
    }));
    await wait(randInt(8, 16));
  }
}

// ── Fast human click ──────────────────────────────────────────
async function humanClick(el, label) {
  if (!el) { log(`humanClick: null for "${label}"`); return; }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  await wait(randInt(150, 300));
  await quickMouseTo(el); // no-ops when minimized (zero rect)
  await wait(randInt(30, 80));

  const rect = el.getBoundingClientRect();
  const minimized = rect.width === 0 && rect.height === 0;

  if (minimized) {
    // Window is minimized — getBoundingClientRect() returns zeros.
    // Skip coordinate-dependent mouse events; use direct focus+click instead.
    log(`humanClick: window minimized for "${label}" — using direct focus+click`);
    el.focus();
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: window }));
    el.click();
    return;
  }

  const cx = rect.left + rect.width  * randFloat(0.3, 0.7);
  const cy = rect.top  + rect.height * randFloat(0.3, 0.7);

  for (const type of ["pointerover", "mouseover", "pointerdown", "mousedown",
                       "pointerup", "mouseup", "click"]) {
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: cx, clientY: cy, view: window,
    }));
    await wait(randInt(6, 14));
  }
  log(`Clicked: "${label}"`);
}

// ── Urgent but human typing ───────────────────────────────────
// ~150 WPM pace — someone stressed and in a hurry
async function humanType(input, value, label) {
  if (!input) { log(`No element for "${label}"`); return false; }
  log(`Typing "${label}" (${value.length} chars)…`);

  input.scrollIntoView({ behavior: "smooth", block: "center" });
  await wait(randInt(80, 150));
  await quickMouseTo(input);
  await wait(randInt(40, 80));

  const rect = input.getBoundingClientRect();
  const cx = rect.left + rect.width  * randFloat(0.2, 0.8);
  const cy = rect.top  + rect.height * randFloat(0.2, 0.8);
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    input.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: cx, clientY: cy, view: window,
    }));
    await wait(randInt(4, 10));
  }
  input.focus();
  input.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
  await wait(randInt(60, 120)); // brief pause before typing

  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, "value"
  )?.set;

  // Clear field
  if (nativeSetter) nativeSetter.call(input, "");
  else input.value = "";
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  await wait(20);

  // Type each character — urgent pace
  for (let i = 0; i < value.length; i++) {
    const char = value[i];

    // Urgent typist: mostly fast, occasional micro-hesitation
    let delay;
    const r = Math.random();
    if (r < 0.04)       delay = randInt(180, 320); // rare stumble
    else if (r < 0.15)  delay = randInt(80, 140);  // slight pause
    else                delay = randInt(28, 65);    // fast burst

    const keyProps = { key: char, bubbles: true, cancelable: true, composed: true };
    input.dispatchEvent(new KeyboardEvent("keydown",  keyProps));
    input.dispatchEvent(new KeyboardEvent("keypress", keyProps));

    const newVal = (input.value || "") + char;
    if (nativeSetter) nativeSetter.call(input, newVal);
    else input.value = newVal;

    input.dispatchEvent(new InputEvent("input", {
      bubbles: true, cancelable: true, composed: true,
      inputType: "insertText", data: char,
    }));
    input.dispatchEvent(new KeyboardEvent("keyup", keyProps));

    await wait(delay);
  }

  await wait(randInt(60, 120)); // glance at field after typing
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
  input.blur();
  await wait(randInt(80, 160)); // inter-field gap

  const ok = input.value.length > 0;
  log(`"${label}" done — ok: ${ok}`);
  return ok;
}

// ── Field scanner ─────────────────────────────────────────────
function scanFields() {
  log("=== FIELD SCAN ===");
  document.querySelectorAll("input").forEach((el, i) => {
    log(i, "id:", el.id, "| placeholder:", el.placeholder, "| type:", el.type,
        "| autocomplete:", el.getAttribute("autocomplete"));
  });
  log("=== END SCAN ===");
}

// ── Field finders ─────────────────────────────────────────────
function findCardField() {
  return document.getElementById("cardNumber-input")
    || document.querySelector("input[autocomplete='cc-number']")
    || document.querySelector("input[id*='card'][id*='number' i]")
    || document.querySelector("input[placeholder*='card number' i]")
    || document.querySelector("input[data-cy*='card' i]");
}

function findExpiryField() {
  return document.getElementById("cardExpiry-input")
    || document.querySelector("input[autocomplete='cc-exp']")
    || document.querySelector("input[placeholder*='MM' i]")
    || document.querySelector("input[id*='expir' i]");
}

function findCvvField() {
  return document.getElementById("cardCvc-input")
    || document.getElementById("cardCvv-input")
    || document.querySelector("input[autocomplete='cc-csc']")
    || document.querySelector("input[placeholder*='cvv' i]")
    || document.querySelector("input[placeholder*='cvc' i]")
    || document.querySelector("input[placeholder*='security' i]")
    || document.querySelector("input[id*='cvv' i]")
    || document.querySelector("input[id*='cvc' i]");
}

// ── Main ──────────────────────────────────────────────────────
// No signal needed — this iframe only loads after the payment
// section is expanded, so it's safe to start filling immediately.
(async function init() {
  // Only run inside the actual gs-payments card iframe. (When the background
  // re-injects checkout scripts into an already-open tab after an extension
  // reload, it injects into ALL frames — this guard makes it a no-op in the
  // main gs.nike.com frame, which has no card form.)
  if (!/gs-payments\.nike\.com/i.test(location.hostname)) return;
  // Run-guard: don't double-type if this frame already got filled this load.
  try {
    const ran = document.documentElement.dataset.snkrsPayRan;
    if (ran && Date.now() - Number(ran) < 180000) { log("Payments script already ran on this frame — skipping."); return; }
    document.documentElement.dataset.snkrsPayRan = String(Date.now());
  } catch (e) {}

  const minimizedAtLoad = document.body && document.body.getBoundingClientRect().width === 0;
  log("Payment iframe script loaded —", location.href, minimizedAtLoad ? "[WINDOW MINIMIZED]" : "[window visible]");

  const saved = await chrome.storage.sync.get(SETTINGS_KEY);
  settings = saved[SETTINGS_KEY] || {};

  if (!settings.enabled) { log("Bot disabled."); return; }

  const rawNumber = (settings.cardNumber || "").replace(/\s/g, "");
  if (!rawNumber) {
    logBG("⚠️ PAYMENTS: No card number saved!");
    return;
  }

  // Brief settle — let the iframe finish rendering its Angular form
  await wait(500);

  // Poll for card field
  log("Waiting for card field…");
  const cardField = await waitFor(findCardField, 15000, 150);

  if (!cardField) {
    logBG("❌ PAYMENTS: Card field not found after 15s");
    scanFields();
    return;
  }

  log(`Card field found: id="${cardField.id}"`);
  const expiryField = findExpiryField();
  const cvvField    = findCvvField();
  log(`Fields — card:${!!cardField} expiry:${!!expiryField} cvv:${!!cvvField}`);

  const cardFormatted = rawNumber.replace(/(.{4})/g, "$1 ").trim();
  const expiry        = (settings.cardExpiry || "").replace(/\s/g, "");
  const cvv           = settings.cardCvv || "";

  logBG("💳 PAYMENTS: Filling card details…");

  let filled = 0;
  if (cardField)   { if (await humanType(cardField,   cardFormatted, "Card number")) filled++; }
  if (expiryField) { if (await humanType(expiryField, expiry,        "Expiry"))      filled++; }
  if (cvvField)    { if (await humanType(cvvField,    cvv,           "CVV"))         filled++; }

  const msg = filled === 3
    ? `✅ PAYMENTS: All 3 fields filled`
    : `⚠️ PAYMENTS: Only ${filled}/3 fields filled`;
  logBG(msg);

  chrome.runtime.sendMessage({ type: "card_fill_done", filled });
})();