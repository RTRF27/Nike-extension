// ============================================================
// Nike SNKRS Bot – GS Checkout Content Script (adapter)
// URL: gs.nike.com/?checkoutId=...
// ============================================================
// This is now a THIN ADAPTER. All the DOM detection + the explicit
// checkout state machine live in checkout-core.js (window.CheckoutCore),
// which is chrome-free and unit-tested offline (see test-harness/).
//
// This file's job is only to bridge the machine to the extension:
//   • load settings, arm the card-fill signal, resolve the drop-time gate,
//   • forward the machine's logs to the background/Discord,
//   • forward the machine's analytics events for the History/replay view,
//   • keep the DOM run-guard and the stall watchdog that re-drives the
//     machine if the checkout stalls before submit.
// The detection semantics and log phrasings are unchanged.
// ============================================================

const SETTINGS_KEY = "snkrsBotSettings";
const Core = (typeof window !== "undefined" && window.CheckoutCore) || null;
let settings = null;

// DOM-based run guard — survives extension reloads within same page load.
let hasRun = false;
function markHasRun() {
  hasRun = true;
  try { document.documentElement.dataset.snkrsBotRan = Date.now(); } catch (e) {}
}
function checkHasRun() {
  if (hasRun) return true;
  try {
    const ts = parseInt(document.documentElement.dataset.snkrsBotRan || "0");
    if (ts && Date.now() - ts < 180000) return true; // ran within last 3 min
  } catch (e) {}
  return false;
}
// snkrsReset() in console to force a retry.
function resetRunGuard() {
  hasRun = false;
  try { delete document.documentElement.dataset.snkrsBotRan; } catch (e) {}
  log("Run guard reset — re-running flow…");
  markHasRun();
  drive();
}
window.snkrsReset = resetRunGuard;

function log(...args) { console.log("[SNKRSBot GS]", ...args); }

// ── Status stepper (mirrors snkrs-content-script) ─────────────
// Same top bar as the launch page, so the journey reads continuously as the tab
// moves nike.com → gs.nike.com. Here we own the CHECKOUT → SUBMIT → DONE half.
const FLOW_STEPS = [
  { key: "waiting",  icon: "⏳", label: "Waiting for drop" },
  { key: "size",     icon: "👟", label: "Size selected" },
  { key: "checkout", icon: "💳", label: "Checkout" },
  { key: "submit",   icon: "🚀", label: "Submitting" },
  { key: "done",     icon: "✅", label: "Done" },
];
function nowClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// The launch page records the EXACT size it grabbed (incl. the random one) in
// extension storage; prefer that so the checkout bar shows the real size.
let _pickedSize = "";
function stepperSize() {
  if (_pickedSize) return _pickedSize;
  if (settings && (settings.preferredSizeType === "random" ||
      String(settings.preferredSize || "").toUpperCase() === "RANDOM")) return "🎲 random";
  const s = settings && settings.preferredSize;
  return s ? (/^[A-Z]/i.test(String(s)) && String(s).length <= 3 ? String(s).toUpperCase() : "US " + s) : "";
}
function renderStatusBar(activeKey, opts) {
  opts = opts || {};
  let bar = document.getElementById("snkrs-status-bar");
  if (!bar) {
    if (!document.body) return;
    bar = document.createElement("div");
    bar.id = "snkrs-status-bar";
    bar.style.cssText =
      "position:fixed;top:0;left:0;width:100%;z-index:2147483647;box-sizing:border-box;" +
      "display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 14px;" +
      "background:#111;border-bottom:2px solid #000;font:700 13px/1.25 sans-serif;" +
      "letter-spacing:.4px;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.4);";
    document.body.appendChild(bar);
  }
  if (activeKey === "error") {
    bar.style.background = "#c1121f"; bar.style.borderBottomColor = "#7a0b13";
    bar.innerHTML = "";
    const msg = document.createElement("div");
    msg.style.cssText = "width:100%;text-align:center;font-size:14px;letter-spacing:.6px;";
    msg.textContent = `❌ ERROR — NEEDS MANUAL${opts.errorMsg ? ": " + opts.errorMsg : ""}`;
    bar.appendChild(msg);
    return;
  }
  bar.style.cssText =
    "position:fixed;top:0;left:0;width:100%;z-index:2147483647;box-sizing:border-box;" +
    "display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 14px;" +
    "background:#111;border-bottom:2px solid #000;font:700 13px/1.25 sans-serif;" +
    "letter-spacing:.4px;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.4);";
  const activeIdx = FLOW_STEPS.findIndex(s => s.key === activeKey);
  bar.innerHTML = "";
  FLOW_STEPS.forEach((step, i) => {
    const state = i < activeIdx ? "done" : (i === activeIdx ? "active" : "todo");
    let text = step.label;
    if (step.key === "size" && (opts.size || stepperSize())) text = opts.size || stepperSize();
    if (step.key === "done") { if (opts.label) text = opts.label; if (opts.time) text += " · " + opts.time; }
    else if (opts.label && i === activeIdx) text = opts.label;
    let bg = "transparent", color = "#6b7280", icon = step.icon, weight = "600";
    if (state === "done") { color = "#1db954"; icon = "✓"; }
    if (state === "active") {
      color = "#fff"; weight = "800";
      bg = step.key === "done" ? (opts.tone === "win" ? "#1db954" : "#1db954") : "#fa5400";
    }
    const seg = document.createElement("span");
    seg.style.cssText =
      `display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:6px;` +
      `background:${bg};color:${color};font-weight:${weight};` +
      (state === "active" ? "box-shadow:0 0 0 1px rgba(255,255,255,.15);" : "");
    seg.textContent = `${icon} ${text}`;
    bar.appendChild(seg);
    if (i < FLOW_STEPS.length - 1) {
      const arr = document.createElement("span");
      arr.textContent = "→"; arr.style.cssText = "color:#4b5563;font-weight:700;";
      bar.appendChild(arr);
    }
  });
}
// Map a checkout-machine event code to the stepper.
function stepperFromEvent(code) {
  switch (code) {
    case "started": case "loaded": case "delivery":
      renderStatusBar("checkout", { label: "Filling checkout" }); break;
    case "filled": case "ready":
      renderStatusBar("checkout", { label: "Card filled — arming submit" }); break;
    case "holding":
      renderStatusBar("submit", { label: "Holding for drop" }); break;
    case "submitting":
      renderStatusBar("submit"); break;
    case "submitted": case "done":
      renderStatusBar("done", { time: nowClock(), label: "Order submitted" }); break;
    case "error":
      renderStatusBar("error", { errorMsg: "checkout stuck — finish it by hand" }); break;
  }
}

// True while THIS content script's extension context is still valid.
function extAlive() { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } }

function logBG(msg) {
  if (!extAlive()) return; // orphaned tab — extension reloaded; stop quietly
  // Stamp our profileDir so the background can attribute this status even after
  // its (ephemeral MV3) service worker restarted and lost its in-memory map.
  try { chrome.runtime.sendMessage({ type: "log", message: msg, profileDir: settings?.profileDir }); }
  catch (e) { /* context invalidated mid-call — ignore */ }
}

// Analytics: forward the machine's structured events to the background, which
// timestamps + attributes them to this profile for the Drop Replay/History view.
function emitEvent(evt) {
  try { stepperFromEvent(evt.code); } catch (e) {}   // drive the top status bar
  if (!extAlive()) return;
  try {
    chrome.runtime.sendMessage({
      type: "checkout_event",
      code: evt.code,
      t: evt.t,
      dropAt: evt.dropAt || 0,
      extra: evt.extra || null,
      url: location.href,
      profileDir: settings?.profileDir,
    });
  } catch (e) { /* ignore */ }
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function profileTag() {
  return settings?.profileLabel?.trim() ? ` **[${settings.profileLabel.trim()}]**` : "";
}

async function loadSettings() {
  const saved = await chrome.storage.sync.get(SETTINGS_KEY);
  settings = { ...(saved[SETTINGS_KEY] || {}) };
  log("Settings loaded:", JSON.stringify({
    hasCard: !!(settings.cardNumber), hasExpiry: !!(settings.cardExpiry), hasCvv: !!(settings.cardCvv),
  }));
}

// ── Card fill signal ──────────────────────────────────────────
// Armed BEFORE the machine runs so we never miss the iframe's signal. The
// machine awaits getCardFill() during its PAYMENT state.
let _cancelCardFill = null;
function cancelCardFillWait() {
  if (typeof _cancelCardFill === "function") { _cancelCardFill(); _cancelCardFill = null; }
}
async function armCardFillSignal(timeoutMs = 60000) {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "get_card_fill_cache" });
    if (resp?.cached) {
      const age = Date.now() - resp.cached.ts;
      if (age < 60000) {
        log(`card_fill_done from cache — ${resp.cached.filled}/3 fields, ${age}ms ago`);
        return resp.cached.filled > 0;
      }
    }
  } catch (e) { log("Cache check failed (non-fatal):", e.message); }

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
      if (msg.type === "card_fill_done") finish(msg.filled > 0, `signal ${msg.filled}/3`);
    }
    chrome.runtime.onMessage.addListener(listener);
    _cancelCardFill = () => finish(true, "cancelled (payment already complete)");
    log("card_fill_done listener armed — waiting…");
  });
}

// ── PANIC / abort polling ─────────────────────────────────────
// Asks our background (which reads the shared abort.json via the native host)
// whether the dashboard has raised a global abort. Throttled so the HOLDING
// loop can call it freely without hammering the native host.
let _abortCache = { on: false, at: 0 };
async function checkAbort() {
  if (!extAlive()) return false;
  if (Date.now() - _abortCache.at < 1200) return _abortCache.on;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "check_abort" });
    _abortCache = { on: !!(resp && resp.on), at: Date.now() };
  } catch (e) { /* keep last value */ }
  return _abortCache.on;
}

// ── CLOSE ALL polling ─────────────────────────────────────────
// The dashboard can raise a shared "close" flag; every profile's content
// scripts poll it and ask the background to close this profile's bot windows
// (e.g. wrong sizes assigned — bail out of everything).
async function checkClose() {
  if (!extAlive()) return false;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "check_close" });
    return !!(resp && resp.on);
  } catch (e) { return false; }
}
function startControlPoller() {
  const iv = setInterval(async () => {
    if (!extAlive()) { clearInterval(iv); return; }
    if (await checkClose()) {
      clearInterval(iv);
      try { chrome.runtime.sendMessage({ type: "close_windows" }); } catch (e) {}
    }
  }, 2500);
}
startControlPoller();

// ── Drop-time gate resolution ─────────────────────────────────
// The exact drop time this tab must hold SUBMIT until. Per-TAB value
// (multi-product) from sessionStorage, else the shared per-profile setting.
async function resolveDropAt() {
  // Per-TAB value (multi-product), set by the bootstrap when it opens a
  // PRE-BUILT direct checkout URL before the drop. That tab genuinely must hold.
  let dropAt = 0;
  try { dropAt = Number(sessionStorage.getItem("snkrsDropAt")) || 0; } catch (e) {}
  if (dropAt) return dropAt;

  let s = {};
  try { s = (await chrome.storage.sync.get(SETTINGS_KEY))[SETTINGS_KEY] || {}; } catch (e) {}

  // ORGANIC path (no pre-built direct checkout URL — always the case for random
  // size): the only way this tab reached gs.nike.com is by clicking Buy on the
  // LIVE launch page, so the drop is already open. A hold here could only cost
  // us the race — e.g. if the local clock lags the configured drop time. No gate.
  if (!((s.checkoutUrl || "").trim())) {
    log("Organic checkout (no pre-built URL) — drop is already open, SUBMIT gate disabled.");
    return 0;
  }

  return Number(s.dropAtMs) || 0;
}

// ── Confirmation watcher ──────────────────────────────────────
function watchForConfirmation(tag) {
  const startUrl = location.href;
  const startTs = Date.now();
  const iv = setInterval(() => {
    const text = (document.body.innerText || "").toUpperCase();
    if (text.includes("PROCESSING YOUR ENTRY") || text.includes("JUST A MINUTE")) return;
    if (!location.hostname.includes("gs.nike.com")) {
      clearInterval(iv); renderStatusBar("done", { time: nowClock(), label: "Order complete", tone: "win" });
      logBG(`🎉${tag} Entry complete → ${location.href}`); return;
    }
    if (text.includes("ORDER CONFIRMED") || text.includes("THANK YOU") ||
        text.includes("YOU'RE IN") || location.href !== startUrl) {
      clearInterval(iv); renderStatusBar("done", { time: nowClock(), label: "Order submitted", tone: "win" });
      logBG(`🎉${tag} ORDER SUBMITTED! ${location.href}`); return;
    }
    if (Date.now() - startTs > 30000) {
      clearInterval(iv); renderStatusBar("error", { errorMsg: "no confirmation after 30s — check the order manually" });
      logBG(`⚠️${tag} No confirmation after 30s — check manually.`);
    }
  }, 1000);
}

// ── Build the machine's deps and run one flow ─────────────────
let _cardFillPromise = null;
async function runCheckoutFlow() {
  if (!Core) { logBG(`❌${profileTag()} checkout-core.js not loaded — cannot run checkout.`); return; }
  const tag = profileTag();

  // Arm the card-fill listener FIRST (before the machine touches the DOM) so a
  // fast iframe fill can never race ahead of us.
  _cardFillPromise = armCardFillSignal(60000);

  const machine = new Core.CheckoutMachine({
    doc: document,
    log: (msg) => logBG(msg),
    dbg: (msg) => log(msg),
    emit: (evt) => emitEvent(evt),
    tag: () => tag,
    getCardFill: () => _cardFillPromise,
    cancelCardFill: () => cancelCardFillWait(),
    isTestMode: () => !!settings?.testMode,
    isLeoMode: () => !!settings?.leoMode,
    // Saved-card checkouts sometimes still ask for the CVV inline — supply it,
    // plus the configured card's last 4 so the bot can confirm the card on file
    // matches this account before submitting.
    getCvv: () => settings?.cardCvv || "",
    getCardLast4: () => (settings?.cardNumber || "").replace(/\D/g, "").slice(-4),
    // DAN raffle only: max random human delay before submit (seconds → ms).
    getSubmitJitterMs: () => Math.max(0, Number(settings?.danJitterSec) || 0) * 1000,
    getDropAt: () => resolveDropAt(),
    checkAbort: () => checkAbort(),
  });

  const result = await machine.run();
  if (result && result.submitted) watchForConfirmation(tag);
  return result;
}

// ── Init: run-guard, single-flight runner, stall watchdog ─────
(async function init() {
  if (checkHasRun()) { log("Already ran on this page — skipping."); return; }
  markHasRun();
  await loadSettings();
  logBG(`🟢${profileTag()} GS checkout script injected on ${location.hostname}` +
        ` (enabled=${settings?.enabled !== false}, testMode=${!!settings?.testMode})`);
  if (!settings?.enabled) { logBG(`⏹️${profileTag()} Bot disabled in settings — not running checkout.`); return; }
  // Pull the exact size the launch page grabbed (random included), then paint
  // the checkout half of the journey.
  try {
    const d = await chrome.storage.local.get("snkrsPickedSize");
    _pickedSize = (d && d.snkrsPickedSize) || "";
  } catch (e) {}
  try { renderStatusBar("checkout", { label: "Loading checkout" }); } catch (e) {}
  if (document.readyState !== "complete") {
    await new Promise(resolve => window.addEventListener("load", resolve, { once: true }));
  }
  await wait(300);

  // Single-flight flow runner so the watchdog never runs two flows at once
  // (and so it never fights the drop-time hold, which keeps the flow running).
  let flowRunning = false;
  let redrives = 0;
  window.__snkrsFlowRunning = () => flowRunning;
  async function _drive() {
    if (flowRunning) return;
    flowRunning = true;
    try { await runCheckoutFlow(); }
    catch (err) { try { logBG(`❌${profileTag()} flow error: ${err}`); } catch (_) {} }
    finally { flowRunning = false; }
  }
  window.__snkrsDrive = _drive;

  const isConfirmed = () => Core ? Core.isConfirmed(document) : !location.hostname.includes("gs.nike.com");
  const stuckPreSubmit = () =>
    Core && location.hostname.includes("gs.nike.com") && !isConfirmed() &&
    !!(Core.findDeliveryContinueOnly(document) || Core.findPaymentContinueOnly(document) || Core.findPaymentAccordionRow(document));

  await _drive(); // initial run

  const watchdog = setInterval(() => {
    if (!extAlive()) { clearInterval(watchdog); return; } // orphaned tab — stop
    if (isConfirmed()) { clearInterval(watchdog); return; }
    if (redrives >= 4) { clearInterval(watchdog); return; }
    if (flowRunning) return;               // busy (incl. holding for drop) — leave it
    if (stuckPreSubmit()) {
      redrives++;
      logBG(`🩺${profileTag()} Watchdog: checkout stalled before submit — re-driving (${redrives}/4).`);
      _drive();
    }
  }, 12000);
})();

// expose a top-level drive() for snkrsReset()
function drive() { if (window.__snkrsDrive) window.__snkrsDrive(); }
