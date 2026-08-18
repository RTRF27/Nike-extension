// ============================================================
// Reagan Bot – Product Page Content Script
// URL: nike.com/sg/launch/t/<slug>
//
// Confirmed from screenshots:
//   - Size buttons show "US 7", "US 7.5", "US 11" (no M/W prefix)
//   - Selected size has black background
//   - CTA button says "Join Draw S$289.00" (draw) or "Buy S$xxx" (instant)
//   - After entry: "Your entry is in" modal appears
//   - Countdown timer bar at top: "Time Left to Enter  00:14:51"
// ============================================================

const SETTINGS_KEY = "snkrsBotSettings";
let settings = null;
let hasRun = false;
// Track if we've successfully entered — prevents double-entry on re-runs
let entryAttempted = false;

function log(...args) { console.log("[SNKRSBot]", ...args); }
function logBG(msg) {
  // Stamp profileDir so the background attributes status even after an MV3
  // service-worker restart wiped its in-memory tab→profile map.
  try { chrome.runtime.sendMessage({ type: "log", message: msg, profileDir: settings?.profileDir }); }
  catch (e) { console.warn("[SNKRSBot] logBG:", e); }
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// ── PANIC / abort ─────────────────────────────────────────────
// Shared abort flag the dashboard can raise to stop every profile entering.
let _abortCache = { on: false, at: 0 };
async function checkAbort() {
  if (Date.now() - _abortCache.at < 1200) return _abortCache.on;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "check_abort" });
    _abortCache = { on: !!(resp && resp.on), at: Date.now() };
  } catch (e) {}
  return _abortCache.on;
}

// ── CLOSE ALL polling ─────────────────────────────────────────
// Poll the shared close flag; when raised, ask the background to close this
// profile's bot windows. Runs regardless of bot state so a launch tab can be
// closed even if the bot is disabled or already entered.
function startControlPoller() {
  const iv = setInterval(async () => {
    let close = false;
    try { const r = await chrome.runtime.sendMessage({ type: "check_close" }); close = !!(r && r.on); }
    catch (e) { clearInterval(iv); return; } // context invalidated — stop
    if (close) { clearInterval(iv); try { chrome.runtime.sendMessage({ type: "close_windows" }); } catch (e) {} }
  }, 2500);
}
startControlPoller();

// ── Profile tag ──────────────────────────────────────────────
function profileTag() {
  let base = "";
  const label = settings?.profileLabel?.trim();
  if (label) base = ` **[${label}]**`;
  else {
    const navName = document.querySelector("[data-testid='user-name'], .nds-text[class*='name']");
    if (navName?.innerText?.trim()) base = ` **[${navName.innerText.trim()}]**`;
  }
  // Add slot/product marker when running as part of a multi-product drop.
  if (settings?._activeSlot) {
    const kw = (settings.productKeyword || "").trim();
    const which = kw ? `Slot ${settings._activeSlot}: ${kw}` : `Slot ${settings._activeSlot}`;
    base += ` (${which})`;
  }
  return base;
}

// ── Settings ─────────────────────────────────────────────────
// Reads the #snkrsSlot=N marker (added by the background worker when it
// opens multi-product drop tabs). Returns the slot index (1-based) or null.
function getSlotIndexFromUrl() {
  const hash = location.hash || "";
  const search = location.search || "";
  const m = (hash + "&" + search).match(/snkrsSlot=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function loadSettings() {
  const saved = await chrome.storage.sync.get(SETTINGS_KEY);
  settings = { ...(saved[SETTINGS_KEY] || {}) };

  // If this tab was opened for a specific product slot, overlay that slot's
  // product/size onto the active settings so this tab targets only it.
  const slotIdx = getSlotIndexFromUrl();
  if (slotIdx && Array.isArray(settings.slots) && settings.slots[slotIdx - 1]) {
    const slot = settings.slots[slotIdx - 1];
    if (slot.size)     settings.preferredSize     = slot.size;
    if (slot.sizeType) settings.preferredSizeType = slot.sizeType;
    // Keyword may be empty for a direct-URL slot — that's fine.
    settings.productKeyword = slot.keyword || "";
    settings._activeSlot = slotIdx;
    log(`Tab assigned to slot ${slotIdx}:`, slot);
  }

  log("Settings:", settings);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[SETTINGS_KEY]) {
    const next = { ...(changes[SETTINGS_KEY].newValue || {}) };
    // Preserve this tab's slot assignment across live settings updates.
    const slotIdx = getSlotIndexFromUrl();
    if (slotIdx && Array.isArray(next.slots) && next.slots[slotIdx - 1]) {
      const slot = next.slots[slotIdx - 1];
      if (slot.size)     next.preferredSize     = slot.size;
      if (slot.sizeType) next.preferredSizeType = slot.sizeType;
      next.productKeyword = slot.keyword || "";
      next._activeSlot = slotIdx;
    }
    settings = next;
  }
});

// ── Status stepper ───────────────────────────────────────────
// A single top bar that shows the WHOLE journey the bot will take, start to
// end, with the current stage lit up — so at a glance you know what it's doing
// and what size it will cop. On failure the whole bar goes red and says a human
// needs to step in. Rendered identically by the launch-page and checkout
// scripts so the story is continuous as the tab moves nike.com → gs.nike.com.
const FLOW_STEPS = [
  { key: "waiting",  icon: "⏳", label: "Waiting for drop" },
  { key: "size",     icon: "👟", label: "Selecting size" },
  { key: "checkout", icon: "💳", label: "Checkout" },
  { key: "submit",   icon: "🚀", label: "Submitting" },
  { key: "done",     icon: "✅", label: "Done" },
];
function nowClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// The exact size the bot committed to (matters most in RANDOM mode — this is how
// you learn WHICH size it grabbed). Persisted so the gs.nike.com checkout page
// (a different origin, same tab) can show the same size in its status bar.
let _pickedSize = "";
function recordPickedSize(label) {
  _pickedSize = label || "";
  try { chrome.storage.local.set({ snkrsPickedSize: _pickedSize }); } catch (e) {}
}
// renderStatusBar(activeKey, { size, time, label, errorMsg, tone })
//   tone: "win" | "pending" (colours the DONE step), else default.
function renderStatusBar(activeKey, opts) {
  opts = opts || {};
  let bar = document.getElementById("snkrs-status-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "snkrs-status-bar";
    bar.style.cssText =
      "position:fixed;top:0;left:0;width:100%;z-index:2147483647;box-sizing:border-box;" +
      "display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 14px;" +
      "background:#111;border-bottom:2px solid #000;font:700 13px/1.25 sans-serif;" +
      "letter-spacing:.4px;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.4);";
    document.body.appendChild(bar);
  }
  // Remove the old plain banner if it's still around.
  const old = document.getElementById("snkrs-bot-banner");
  if (old) old.remove();

  if (activeKey === "error") {
    bar.style.background = "#c1121f";
    bar.style.borderBottomColor = "#7a0b13";
    bar.innerHTML = "";
    const msg = document.createElement("div");
    msg.style.cssText = "width:100%;text-align:center;font-size:14px;letter-spacing:.6px;";
    msg.textContent = `❌ ERROR — NEEDS MANUAL${opts.errorMsg ? ": " + opts.errorMsg : ""}`;
    bar.appendChild(msg);
    return;
  }

  // Re-apply the full flex layout each render — a prior showBanner() call may
  // have left the element as a centred single-line bar.
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
    if (step.key === "size" && opts.size) text = opts.size;
    if (step.key === "done") {
      if (opts.label) text = opts.label;
      if (opts.time) text += " · " + opts.time;
    } else if (opts.label && i === activeIdx) {
      text = opts.label;
    }
    let bg = "transparent", color = "#6b7280", icon = step.icon, weight = "600";
    if (state === "done") { color = "#1db954"; icon = "✓"; }
    if (state === "active") {
      color = "#fff"; weight = "800";
      bg = step.key === "done"
        ? (opts.tone === "win" ? "#1db954" : opts.tone === "pending" ? "#2563eb" : "#1db954")
        : "#fa5400";
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
      arr.textContent = "→";
      arr.style.cssText = "color:#4b5563;font-weight:700;";
      bar.appendChild(arr);
    }
  });
}

// Back-compat shim: existing showBanner(text,...) calls still work, but route
// through the stepper where the text maps cleanly to a stage. Free-text callers
// (test mode, etc.) fall back to a simple coloured bar on the same element.
function showBanner(text, bg = "#fa5400", color = "#fff") {
  const bar = document.getElementById("snkrs-status-bar");
  const div = bar || document.createElement("div");
  if (!bar) { div.id = "snkrs-status-bar"; document.body.appendChild(div); }
  div.style.cssText =
    `position:fixed;top:0;left:0;width:100%;z-index:2147483647;box-sizing:border-box;` +
    `padding:9px 16px;background:${bg};color:${color};font:700 13px/1.3 sans-serif;` +
    `text-align:center;letter-spacing:1px;box-shadow:0 2px 10px rgba(0,0,0,.4);`;
  div.textContent = text;
}

// ── Page checks ───────────────────────────────────────────────
function isLaunchPage() {
  return location.hostname.includes("nike.com") && location.pathname.includes("/launch/");
}

// ── Status detection ─────────────────────────────────────────
const STATUS = {
  PURCHASED: "purchased",
  NOT_WON:   "not_won",
  ENTRY_IN:  "entry_in",
  PENDING:     "pending",
  ENTER:     "enter",
  CLOSED:    "closed",
  SOLD_OUT:  "sold_out",
  COMING_SOON: "coming_soon",
  UNKNOWN:   "unknown",
};

// Nike renders TYPOGRAPHIC apostrophes — "Got ’em", "You’re in line",
// "We’ll email you" — but the phrase lists below are written with straight
// ones, so a raw includes() silently misses every one of them. Fold all the
// apostrophe variants to ' before matching, and collapse whitespace runs so a
// line break inside a sentence can't hide a phrase either.
function normText(s) {
  return String(s || "")
    .replace(/[‘’ʼ՚＇´`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function detectPageStatus() {
  // FIX: Check URL for ENTRY_LIMIT_EXCEEDED — means already entered, stop everything
  if (location.search.includes("ENTRY_LIMIT_EXCEEDED")) {
    log("ENTRY_LIMIT_EXCEEDED in URL — already entered, stopping.");
    return STATUS.PENDING;
  }

  // Check modal text first — "Got 'em" or "Your entry is in"
  const modal = document.querySelector(".modal, [role='dialog'], [class*='Modal'], [class*='modal']");
  if (modal) {
    const t = normText(modal.innerText).toLowerCase();
    if (t.includes("got 'em") || t.includes("got em") || t.includes("is yours") ||
        t.includes("order confirmation will be arriving"))
      return STATUS.PURCHASED;
    if (t.includes("your entry is in") || t.includes("entry received"))
      return STATUS.ENTRY_IN;
  }

  const bodyText = normText(document.body.innerText).toUpperCase();

  if (
    bodyText.includes("GOT 'EM") || bodyText.includes("GOT EM") ||
    bodyText.includes("IS YOURS") ||
    // The live win page pairs "Got 'em" with this line; either alone is enough.
    bodyText.includes("ORDER CONFIRMATION WILL BE ARRIVING") ||
    bodyText.includes("YOUR ORDER CONFIRMATION") ||
    bodyText.includes("PURCHASED") || bodyText.includes("YOU WON") ||
    bodyText.includes("CONGRATULATIONS")
  ) return STATUS.PURCHASED;

  if (
    bodyText.includes("BETTER LUCK NEXT TIME") ||
    bodyText.includes("NOT SELECTED") ||
    bodyText.includes("UNSUCCESSFUL")
  ) return STATUS.NOT_WON;

  if (
    bodyText.includes("YOUR ENTRY IS IN") ||
    bodyText.includes("ENTRY RECEIVED") ||
    bodyText.includes("WE'LL EMAIL YOU")
  ) return STATUS.ENTRY_IN;

  // FIX: "Pending" / "You're in line" — entry submitted, Nike is processing
  // This appears when the draw button is greyed out as "Pending" after clicking
  if (
    bodyText.includes("YOU'RE IN LINE") ||
    bodyText.includes("YOURE IN LINE") ||
    bodyText.includes("WE WILL NOTIFY YOU") ||
    bodyText.includes("NOTIFY YOU IN A MOMENT")
  ) return STATUS.PENDING;

  // FIX: "Entry is invalid. Please try again." — duplicate/invalid entry attempt
  if (
    bodyText.includes("ENTRY IS INVALID") ||
    bodyText.includes("PLEASE TRY AGAIN") ||
    bodyText.includes("ENTRY_LIMIT_EXCEEDED") ||
    bodyText.includes("INVALID ENTRY")
  ) return STATUS.PENDING;

  // FIX: Also catch the greyed "Pending" button state on the page
  const pendingBtn = document.querySelector("button[disabled], button[aria-disabled='true']");
  if (pendingBtn) {
    const btnText = (pendingBtn.innerText || "").trim().toUpperCase();
    if (btnText === "PENDING") return STATUS.PENDING;
  }

  if (bodyText.includes("ENTRY CLOSED") || bodyText.includes("DRAW CLOSED"))
    return STATUS.CLOSED;

  if (bodyText.includes("SOLD OUT"))
    return STATUS.SOLD_OUT;

  // FIX: Detect "Coming Soon" state — drop hasn't gone live yet
  if (
    bodyText.includes("COMING SOON") ||
    bodyText.includes("NOTIFY ME")
  ) return STATUS.COMING_SOON;

  if (
    bodyText.includes("JOIN DRAW") ||
    /BUY S\$/.test(bodyText) ||
    bodyText.includes("TIME LEFT TO ENTER")
  ) return STATUS.ENTER;

  return STATUS.UNKNOWN;
}

// ── Confetti celebration ──────────────────────────────────────
// Self-contained canvas confetti — no external script. Nike's Content-Security-
// Policy blocks loading a CDN <script> into the page, so the old jsdelivr-based
// version silently never fired. This draws its own particles on an overlay
// canvas and cleans itself up.
function launchConfetti() {
  try {
    if (document.getElementById("snkrs-confetti-canvas")) return; // already running
    const canvas = document.createElement("canvas");
    canvas.id = "snkrs-confetti-canvas";
    canvas.style.cssText =
      "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;";
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    const colors = ["#fa5400", "#ffffff", "#111111", "#1db954", "#ffd700"];

    const onResize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    window.addEventListener("resize", onResize);

    // Spawn particles from both bottom corners, arcing inward.
    const particles = [];
    const spawn = () => {
      for (const side of [0, 1]) {
        for (let i = 0; i < 6; i++) {
          const angle = side === 0 ? randFloat(-1.2, -0.3) : randFloat(-2.84, -1.94);
          const speed = randFloat(9, 17);
          particles.push({
            x: side === 0 ? 0 : canvas.width,
            y: canvas.height,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            size: randFloat(5, 10),
            color: colors[randInt(0, colors.length - 1)],
            rot: randFloat(0, Math.PI * 2),
            vrot: randFloat(-0.2, 0.2),
            life: 1,
          });
        }
      }
    };

    const end = Date.now() + 6000;
    (function frame() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (Date.now() < end && Math.random() < 0.9) spawn();
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.vy += 0.28;            // gravity
        p.vx *= 0.99;            // drag
        p.x += p.vx; p.y += p.vy;
        p.rot += p.vrot;
        p.life -= 0.006;
        if (p.life <= 0 || p.y > canvas.height + 20) { particles.splice(i, 1); continue; }
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
      if (Date.now() < end || particles.length) {
        requestAnimationFrame(frame);
      } else {
        window.removeEventListener("resize", onResize);
        canvas.remove();
      }
    })();
  } catch (e) { log("confetti error (non-fatal):", e); }
}

// ── Status Poller ────────────────────────────────────────────
const POLLER_ACTIVE_KEY  = "snkrsBotPollerActive";
const POLLER_COUNT_KEY   = "snkrsBotPollCount";
const POLLER_PRODUCT_KEY = "snkrsBotProduct";

// PENDING ("You're in line - Nike processing") is NOT an outcome, it is Nike
// still deciding. It used to stop the bot dead, which is why a win could sit on
// screen reading "Got 'em" while the status bar still said "In line" and no
// win notification ever fired. Watch the page in place until it resolves: Nike
// re-renders the SAME url, so no reload is needed and this still works when the
// reload poller is switched off.
let _pendingWatchActive = false;
function watchPendingOutcome(tag, maxMs) {
  if (_pendingWatchActive) return;
  _pendingWatchActive = true;
  const budget = maxMs || 20 * 60 * 1000;
  const deadline = Date.now() + budget;
  let settled = false;

  const finish = (status) => {
    if (settled) return true;
    if (status === STATUS.PURCHASED) {
      settled = true;
      logBG(`🎉🔥👟${tag} **GOT 'EM!!** You won the draw! Check your email NOW. 🏆🏆🏆 ${location.href}`);
      renderStatusBar("done", { time: nowClock(), label: "GOT 'EM 🎉", tone: "win" });
      try { launchConfetti(); } catch (e) {}
      return true;
    }
    if (status === STATUS.NOT_WON) {
      settled = true;
      logBG(`😔${tag} Result: **Better Luck Next Time** - entry not selected.`);
      renderStatusBar("done", { time: nowClock(), label: "Not selected", tone: "pending" });
      return true;
    }
    return false;
  };

  const stop = () => { obs.disconnect(); clearInterval(iv); _pendingWatchActive = false; };
  const tick = () => {
    if (finish(detectPageStatus())) { stop(); return; }
    if (Date.now() > deadline) {
      stop();
      logBG(`⏳${tag} Still in line after ${Math.round(budget / 60000)} min - stopped watching, check the app.`);
    }
  };
  const obs = new MutationObserver(tick);
  try { obs.observe(document.body, { childList: true, subtree: true, characterData: true }); } catch (e) {}
  const iv = setInterval(tick, 1000);
  tick(); // the page may already have resolved before we armed the watcher
}

// Enter the "in line" holding state: show it, keep watching the page for the
// real result, and (if enabled) keep the reload poller going as a backstop.
function enterPendingState(tag, note) {
  renderStatusBar("done", { time: nowClock(), label: "In line — Nike processing", tone: "pending" });
  logBG(`⏳${tag} ${note || "In line - Nike is processing"} - watching for the result.`);
  watchPendingOutcome(tag);
  startStatusPoller();
}

function startStatusPoller() {
  if (!settings?.statusPollerEnabled) {
    log("Poller disabled in settings.");
    return;
  }

  const intervalMin = Math.max(1, settings?.pollerIntervalMin || 3);
  const tag = profileTag();

  const count = parseInt(sessionStorage.getItem(POLLER_COUNT_KEY) || "0");
  sessionStorage.setItem(POLLER_ACTIVE_KEY, "1");
  sessionStorage.setItem(POLLER_COUNT_KEY, String(count + 1));

  if (count === 0) {
    const product = sessionStorage.getItem(POLLER_PRODUCT_KEY) || location.href;
    logBG(`🔄${tag} Entry submitted — polling every ${intervalMin} min for result: ${product}`);
  } else {
    log(`Poller: scheduling reload #${count + 1} in ${intervalMin} min`);
  }

  setTimeout(() => location.reload(), intervalMin * 60 * 1000);
}

function checkStatusAfterReload() {
  if (sessionStorage.getItem(POLLER_ACTIVE_KEY) !== "1") return false;

  const tag = profileTag();
  const count = sessionStorage.getItem(POLLER_COUNT_KEY) || "?";
  const status = detectPageStatus();

  log(`Poller check #${count}: ${status}`);

  switch (status) {
    case STATUS.PURCHASED:
      sessionStorage.removeItem(POLLER_ACTIVE_KEY);
      sessionStorage.removeItem(POLLER_COUNT_KEY);
      logBG(`🎉🔥👟${tag} **GOT 'EM!!** You won the draw! Check your email NOW. 🏆🏆🏆 ${location.href}`);
      renderStatusBar("done", { time: nowClock(), label: "GOT 'EM 🎉", tone: "win" });
      launchConfetti();
      return true;

    case STATUS.NOT_WON:
      sessionStorage.removeItem(POLLER_ACTIVE_KEY);
      sessionStorage.removeItem(POLLER_COUNT_KEY);
      logBG(`😔${tag} Result: **Better Luck Next Time** (check #${count})`);
      return true;

    case STATUS.PENDING:
      // Not an outcome - Nike is still processing. Keep watching this page and
      // keep the reload poller running so a win can never be missed.
      enterPendingState(tag, `Check #${count}: still in line`);
      return true;

    case STATUS.ENTRY_IN:
    case STATUS.UNKNOWN:
      logBG(`⏳${tag} Check #${count}: Still pending — next check in ${settings?.pollerIntervalMin || 3} min`);
      startStatusPoller();
      return true;

    case STATUS.CLOSED:
    case STATUS.SOLD_OUT:
      sessionStorage.removeItem(POLLER_ACTIVE_KEY);
      sessionStorage.removeItem(POLLER_COUNT_KEY);
      logBG(`ℹ️${tag} Draw ended with status: ${status} — stopping poller.`);
      return true;

    default:
      logBG(`❓${tag} Check #${count}: Unknown state — retrying.`);
      startStatusPoller();
      return true;
  }
}

// ── Size button finder ────────────────────────────────────────
// Apparel sizes Nike uses on launch pages. Order matters for matching
// (check longest tokens first so "XXL" isn't shadowed by "XL"/"L").
const APPAREL_SIZES = ["XXXL", "XXL", "XL", "L", "M", "S", "XS", "XXS"];

// A button is an apparel-size button if its FULL trimmed text is exactly
// one of the apparel tokens (case-insensitive). The exact-match requirement
// is critical — a loose includes() would match "S$135.00", "Maps", "Men's", etc.
function isApparelSizeText(text) {
  const t = (text || "").trim().toUpperCase();
  return APPAREL_SIZES.includes(t);
}

// Tells whether a button anywhere under `el` is a size button.
function elementHasSizeButton(el) {
  if (!el) return false;
  const btns = el.querySelectorAll("button");
  for (const b of btns) {
    const t = (b.innerText || "").trim();
    if (/^US\s+(M\s+)?[\d]/.test(t) || isApparelSizeText(t)) return true;
  }
  return false;
}

// ── Product-aware scoping ─────────────────────────────────────
// On a collection page with multiple products, we limit the size search to
// the ONE product the user wants. `keyword` can be a product-name fragment
// or a SKU like "IM3198-052".
//
// Robustness notes (learned from a mis-buy on the England x Palace page):
//  - We match against BOTH textContent (catches visually-hidden text) and any
//    descendant link hrefs (Nike product URLs often embed the SKU/slug).
//  - We pick the SMALLEST container that holds size buttons, so we never grab
//    a wrapper that spans multiple products.
//  - If nothing matches, we return null and the caller REFUSES to buy.
function nodeMatchesKeyword(node, kw) {
  // 1) Visible/hidden text of this node
  const txt = ((node.textContent || "")).toLowerCase();
  if (txt.includes(kw)) return true;
  // 2) Any link href inside this node (URLs contain slug or SKU)
  const links = node.querySelectorAll ? node.querySelectorAll("a[href]") : [];
  for (const a of links) {
    if ((a.getAttribute("href") || "").toLowerCase().includes(kw)) return true;
  }
  // 3) Common attributes that may carry the SKU/product id
  if (node.getAttribute) {
    for (const attr of ["data-product-id", "data-testid", "id", "aria-label"]) {
      const v = (node.getAttribute(attr) || "").toLowerCase();
      if (v && v.includes(kw)) return true;
    }
  }
  return false;
}

function textOf(el) {
  return (el?.innerText || el?.textContent || "").trim();
}

function countMatches(text, re) {
  const m = String(text || "").match(re);
  return m ? m.length : 0;
}

function hasProductCta(el) {
  if (!el) return false;
  const text = textOf(el).toUpperCase();
  if (/(COMING SOON|NOTIFY ME|JOIN DRAW|BUY\s+S\$|BUY\b)/.test(text)) return true;

  const buttons = Array.from(el.querySelectorAll ? el.querySelectorAll("button") : []);
  return buttons.some(b => /(COMING SOON|NOTIFY ME|JOIN DRAW|BUY\s+S\$|BUY\b)/i.test(textOf(b)));
}

function hasSkuText(el) {
  const text = textOf(el);
  return /SKU\s*:/i.test(text) || /\b[A-Z0-9]{2,}-[A-Z0-9]{2,}\b/i.test(text);
}

function hasPriceText(el) {
  return /\bS\$\s*\d/i.test(textOf(el));
}

function isTooBroadProductScope(el) {
  if (!el || el === document.body || el === document.documentElement) return true;
  const text = textOf(el);

  // A real product tile/detail block should normally contain one SKU label.
  // Multiple SKU labels means we probably grabbed a collection wrapper that
  // spans several products, which is unsafe for auto-entry.
  if (countMatches(text, /SKU\s*:/gi) > 1) return true;

  // If it has too many size buttons, it is almost certainly more than one item.
  if (getAllSizeButtons(el).length > 30) return true;

  // Very large blocks are usually page/collection wrappers. Keep this generous
  // so long descriptions still pass, but body-level wrappers do not.
  if (text.length > 3500 && getAllSizeButtons(el).length === 0) return true;

  return false;
}

function looksLikeProductScope(el, kw) {
  if (!el || !nodeMatchesKeyword(el, kw) || isTooBroadProductScope(el)) return false;

  // Live product: size buttons are available. This is the original safest path.
  if (elementHasSizeButton(el)) return true;

  // Pre-live product: there are no size buttons yet. On Nike launch collection
  // pages, the product card still contains the SKU/title/price plus a disabled
  // "Coming Soon" / "Notify Me" CTA. Treat that as a valid product scope so
  // Preview and the watcher can lock onto the correct product BEFORE it goes live.
  const sku = hasSkuText(el);
  const price = hasPriceText(el);
  const cta = hasProductCta(el);

  return (cta && (sku || price)) || (sku && price);
}

function scoreProductScope(el) {
  const text = textOf(el);
  const sizeCount = getAllSizeButtons(el).length;
  const buttonCount = el.querySelectorAll ? el.querySelectorAll("button").length : 0;

  let score = 0;
  if (sizeCount > 0) score -= 1000;     // prefer live, size-containing scope
  if (hasProductCta(el)) score -= 250;  // prefer card/detail block with CTA
  if (hasSkuText(el)) score -= 120;
  if (hasPriceText(el)) score -= 60;

  score += countMatches(text, /SKU\s*:/gi) * 200;
  score += Math.min(text.length, 3500) / 20;
  score += buttonCount * 15;
  return score;
}

function findProductScope(keyword) {
  if (!keyword) return null;
  const kw = keyword.trim().toLowerCase();
  if (!kw) return null;

  const candidates = [];

  // Scan a broad set of element types for the keyword. We deliberately use
  // textContent (via nodeMatchesKeyword) so hidden/below-the-fold product text
  // and link hrefs still match.
  const nodes = Array.from(
    document.querySelectorAll("h1, h2, h3, h4, h5, p, span, div, li, a, section, article")
  );

  for (const node of nodes) {
    if (!nodeMatchesKeyword(node, kw)) continue;

    // Walk up and collect BOTH states:
    //  1) live product scopes that already contain size buttons;
    //  2) pre-live product scopes that contain SKU/title/price + Coming Soon.
    let el = node;
    let hops = 0;
    while (el && hops < 18) {
      if (looksLikeProductScope(el, kw)) candidates.push(el);
      el = el.parentElement;
      hops++;
    }
  }

  const unique = [...new Set(candidates)].filter(el => !isTooBroadProductScope(el));
  if (!unique.length) return null;

  unique.sort((a, b) => scoreProductScope(a) - scoreProductScope(b));
  const best = unique[0];

  const sizeBtnCount = getAllSizeButtons(best).length;
  if (sizeBtnCount > 30) {
    log(`Scope for "${keyword}" looks too broad (${sizeBtnCount} size buttons) — treating as not found.`);
    return null;
  }

  log(`Product scope for "${keyword}" found (${sizeBtnCount || 0} size buttons visible yet).`);
  return best;
}

// Collects size buttons. If `scope` is provided, only looks inside it.
function getAllSizeButtons(scope) {
  const root = scope || document;
  const all = Array.from(root.querySelectorAll("button"));

  // Footwear: "US 9.5" or "US M 9.5 / W 11"
  const footwearButtons = all.filter(b => {
    const t = (b.innerText || "").trim();
    return /^US\s+(M\s+)?[\d]/.test(t);
  });

  // Apparel: exact "S" / "M" / "L" / "XL" etc.
  const apparelButtons = all.filter(b => isApparelSizeText(b.innerText));

  const combined = [...footwearButtons, ...apparelButtons];
  if (combined.length) return [...new Set(combined)];

  // Fallback: scope to size-related containers only, so we don't grab
  // random page buttons. Then still filter to plausible size labels.
  const scoped = [
    ...root.querySelectorAll("[data-testid*='size'] button"),
    ...root.querySelectorAll("[data-testid*='Size'] button"),
    ...root.querySelectorAll("[class*='size'] button"),
    ...root.querySelectorAll("[class*='Size'] button"),
  ];
  const scopedFiltered = [...new Set(scoped)].filter(b => {
    const t = (b.innerText || "").trim();
    return /^US\s+(M\s+)?[\d]/.test(t) || isApparelSizeText(t);
  });
  return scopedFiltered;
}

// Random-size mode: the user asked us to grab ANY available size at the drop
// instead of a fixed one — useful when the real drop lists sizes the preset
// picker never offered. Triggered by sizeType "random" or the "RANDOM" sentinel.
function isRandomSize() {
  return (settings?.preferredSizeType === "random")
      || (String(settings?.preferredSize || "").trim().toUpperCase() === "RANDOM");
}

// Formats the configured size for display/logging.
// Apparel → "L"; footwear → "US 9.5"; random → "🎲 any available size".
function sizeLabel(preferred) {
  if (isRandomSize()) return "🎲 any available size";
  const norm = String(preferred || "").trim().toUpperCase();
  if (norm === "RANDOM") return "🎲 any available size";
  if (APPAREL_SIZES.includes(norm)) return norm;
  return "US " + preferred;
}

function isButtonAvailable(btn) {
  if (btn.disabled) return false;
  if (btn.getAttribute("aria-disabled") === "true") return false;
  const style = window.getComputedStyle(btn);
  if (parseFloat(style.opacity) < 0.4) return false;
  if (btn.className.includes("disabled") || btn.className.includes("soldOut")) return false;
  // Nike's size-grid-dropdown variant marks the <li> with data-qa: only
  // "size-available" is copable ("size-sold-out"/"size-unavailable" aren't).
  const li = btn.closest("li[data-qa]");
  if (li) {
    const qa = li.getAttribute("data-qa") || "";
    if (/sold-?out|unavailable|disabled/i.test(qa)) return false;
  }
  return true;
}

// The DEFINITIVE success check for a "Buy" (instant-buy) drop: the item is in
// the bag. Nike shows an "Added to bag" drawer and bumps the cart count — both
// on the SAME url, so this is what "it worked" actually looks like (no
// navigation). Returns true when the confirmation drawer / cart badge is up.
function addedToBagConfirmed() {
  // 1) The confirmation drawer text ("Added to bag").
  const body = (document.body.innerText || "");
  if (/added to bag/i.test(body)) return true;
  // 2) A "View Bag (N>=1)" control (drawer CTA / header link).
  const controls = Array.from(document.querySelectorAll("button, a"));
  if (controls.some(el => /view bag\s*\(\s*[1-9]/i.test((el.innerText || "")))) return true;
  // 3) Cart badge showing a non-zero count (data-qa/test-id or aria-label).
  const cart = document.querySelector(
    "[data-qa='cart-item-count'], [data-testid='cart-item-count'], [aria-label*='bag'], [aria-label*='cart']"
  );
  if (cart) {
    const n = (cart.getAttribute("aria-label") || cart.innerText || "").match(/\d+/);
    if (n && parseInt(n[0], 10) > 0) return true;
  }
  return false;
}

// A /launch/t/ page renders the HERO product PLUS "you might also like" products
// — each with its OWN size grid and Buy button (this drop has 3). With no
// keyword to scope by, random mode must confine itself to the hero product, or
// it could pick a size on one product while clicking Buy on another → nothing
// carts. The hero is the FIRST size grid; walk up to the ancestor that also
// holds its Buy/Join CTA — that ancestor is the hero product's card.
function findMainProductScope() {
  const first = document.querySelector("button.size-grid-button");
  let grid = document.querySelector("ul.size-layout") || (first && first.closest("ul"));
  if (!grid) return null;
  let el = grid.parentElement;
  for (let i = 0; i < 15 && el; i++, el = el.parentElement) {
    const hasBuy = Array.from(el.querySelectorAll("button"))
      .some(b => /^(buy\s+s\$|buy\b|join draw)/i.test((b.innerText || "").trim()));
    if (hasBuy) return el;
  }
  return grid.parentElement || null;
}

function findPreferredSizeButton() {
  const preferred = settings?.preferredSize;
  if (!preferred && !isRandomSize()) return null;

  const preferredNorm = String(preferred).trim().toUpperCase();
  const isApparelTarget = APPAREL_SIZES.includes(preferredNorm);

  // If a product keyword is set, scope the search to that product's card.
  const keyword = settings?.productKeyword;
  let scope = null;
  if (keyword && keyword.trim()) {
    scope = findProductScope(keyword);
    if (!scope) {
      // CRITICAL: keyword set but product card not located.
      // In multi-product/slot mode (or any time a keyword is explicitly set),
      // we must NOT fall back to a whole-page search — doing so previously
      // caused the bot to buy a DIFFERENT product that merely had the size
      // available. Refuse to select anything instead.
      log(`Product "${keyword}" NOT located — refusing to select any size (no whole-page fallback).`);
      return null;
    } else {
      log(`Scoped to product card matching "${keyword}".`);
    }
  }

  // RANDOM mode: don't match a specific label — pick any size that's actually
  // available. Scope to the HERO product (or the keyword card) so on a
  // multi-product page we never grab a size from a different product than the
  // Buy button we click.
  if (isRandomSize()) {
    const randScope = scope || findMainProductScope();
    const randButtons = getAllSizeButtons(randScope);
    const available = randButtons.filter(isButtonAvailable);
    log(`Found ${randButtons.length} size buttons (${available.length} available) in ${randScope ? "the target product" : "the page"}. RANDOM mode — picking any.`);
    if (!available.length) return null;
    const pick = available[Math.floor(Math.random() * available.length)];
    log(`🎲 Random size picked: ${(pick.innerText || "").trim() || "(unlabelled)"}`);
    return pick;
  }

  const buttons = getAllSizeButtons(scope);
  log(`Found ${buttons.length} size buttons. Looking for ${isApparelTarget ? preferredNorm : "US " + preferred}`);

  return buttons.find(b => {
    if (!isButtonAvailable(b)) return false;
    const t = (b.innerText || "").trim();

    if (isApparelTarget) {
      // Apparel: require EXACT match on the whole button label.
      // This prevents "M" from matching "Men's", "S" from "S$135", etc.
      return t.toUpperCase() === preferredNorm;
    }

    // Footwear Format 1: "US 9.5" — and youth/toddler variants "US 5Y",
    // "US 3.5Y", "US 10C". The trailing unit (Y=youth, C=child/toddler, GS/TD)
    // is optional, so a preset like "5" still matches "US 5Y", and typing the
    // full "5Y" matches too.
    const preferredClean = String(preferred).trim().toUpperCase();
    const old = t.toUpperCase().match(/^US\s+([\d.]+)(Y|C|TD|GS)?$/);
    if (old) {
      const digits = old[1];
      const full = digits + (old[2] || "");
      if (preferredClean === digits || preferredClean === full) return true;
    }

    // Footwear Format 2: "US M 9.5 / W 11" (men's/women's dual label)
    const newFmt = t.match(/^US\s+M\s+([\d.]+)/i);
    if (newFmt && newFmt[1] === preferred) return true;

    return false;
  }) || null;
}

// ── CTA button finder ─────────────────────────────────────────
// When a product keyword is set, prefer the CTA inside that product's card
// so we enter the right product's draw. `scope` is optional.
function findCTAButtonInScope(scope) {
  const root = scope || document;
  const buttons = Array.from(root.querySelectorAll("button"));

  return buttons.find(b => {
    if (b.disabled) return false;
    if (b.getAttribute("aria-disabled") === "true") return false;

    const t = (b.innerText || "").trim();

    if (/^join draw/i.test(t)) return true;
    if (/^buy\s+S\$/i.test(t)) return true;
    if (/^buy\b/i.test(t)) return true;

    return false;
  }) || null;
}

// ── CTA button finder ─────────────────────────────────────────
function findCTAButton() {
  // If a product keyword is set, the CTA MUST come from that product's card.
  // Never fall back to a page-wide CTA search when a keyword is set — that
  // could submit a different product. Return null so the caller waits/retries
  // rather than entering the wrong draw.
  const keyword = settings?.productKeyword;
  if (keyword && keyword.trim()) {
    const scope = findProductScope(keyword);
    if (!scope) return null;
    return findCTAButtonInScope(scope); // may be null if not ready yet
  }
  // Random with no keyword: confine the CTA to the HERO product so the Buy we
  // click is the same product we picked a size on (multi-product pages have
  // several Buy buttons). Falls back to page-wide (first Buy = hero) if needed.
  if (isRandomSize()) {
    const main = findMainProductScope();
    if (main) { const c = findCTAButtonInScope(main); if (c) return c; }
  }
  // No keyword (single-product page): page-wide search is correct.
  return findCTAButtonInScope(null);
}

// ── Human-like click ─────────────────────────────────────────
// This is the exact click sequence from the known-good v1.0 build — synthetic
// pointer/mouse events, no native .click(). It's what reliably registers size +
// Buy selections on Nike's launch page; adding a native .click() on top broke it
// on live drops, so we keep this verbatim.
function humanClick(el, label) {
  if (!el) { log(`humanClick: null for ${label}`); return; }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, view: window,
    }));
  }
  log(`Clicked: ${label}`);
}

// ── Drop type: LEO (speed) vs DAN (accuracy) ──────────────────
// LEO is first-come-first-served — the entry has to land the moment the size
// appears, so every settling wait collapses and the CTA gets polled hard.
// DAN stays open far longer and isn't won on speed, so the bot keeps its
// human-looking pacing and spends the spare time proving the size actually
// took before it commits the entry.
function isLeoDrop() { return !!settings?.leoMode; }

// Has Nike marked this size button as the chosen one? The size grid renders
// several ways (radio inputs, aria-checked buttons, class-flagged <li>), so any
// positive signal counts. Returns true / false / null when the markup gives us
// nothing we understand — null is "unknown", NOT "failed".
function sizeButtonSelected(btn) {
  if (!btn) return false;
  const input = btn.matches("input") ? btn : btn.querySelector("input[type=radio], input[type=checkbox]");
  if (input) return !!input.checked;
  for (const attr of ["aria-checked", "aria-selected", "aria-pressed"]) {
    const v = btn.getAttribute(attr);
    if (v === "true") return true;
    if (v === "false") return false;
  }
  const li = btn.closest("li");
  const cls = `${btn.className || ""} ${li ? (li.className || "") : ""}`;
  if (/(^|[\s_-])(is-)?selected([\s_-]|$)|--selected/i.test(cls)) return true;
  return null;
}

// DAN only: confirm the size we clicked really is the one selected before we
// commit. Deliberately ADVISORY — hard selection gating broke a live drop once
// (see the v1.0 note in executeEntry), so this never blocks the entry: it waits
// a short budget, re-clicks at most once, then hands control back either way.
async function verifySizeSelection(tag, sizeBtn, pickedLabel) {
  const deadline = performance.now() + 1200;
  let state = sizeButtonSelected(sizeBtn);
  while (state !== true && performance.now() < deadline) {
    await wait(120);
    state = sizeButtonSelected(sizeBtn);
  }
  if (state === true) {
    logBG(`🎟️${tag} Size ${pickedLabel} confirmed selected — entry verified.`);
    return true;
  }
  if (state === false) {
    logBG(`⚠️${tag} Size ${pickedLabel} never registered as selected — clicking it once more.`);
    humanClick(sizeBtn, `Size ${pickedLabel} (re-click)`);
    await wait(randInt(350, 600));
    if (sizeButtonSelected(sizeBtn) === true) {
      logBG(`🎟️${tag} Size ${pickedLabel} confirmed on the second click.`);
      return true;
    }
  }
  // Unknown markup, or still unconfirmed: enter anyway. Not being able to READ
  // Nike's selection state is never a reason to skip the draw.
  logBG(`ℹ️${tag} Couldn't confirm the selected state for ${pickedLabel} — entering anyway.`);
  return false;
}

async function waitFor(fn, timeoutMs = 20000, intervalMs = 200) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const r = fn();
    if (r) return r;
    await wait(intervalMs);
  }
  return null;
}

// ── Drop countdown watcher ────────────────────────────────────
// FIX: Watch for the drop to go live when we load early (Coming Soon state).
// Uses a MutationObserver on the whole body so we catch Nike's React
// re-renders that swap out the "Coming Soon" button for real size buttons.
// When sizes appear and the drop is live, we fire the entry flow immediately.
let dropWatcherActive = false;
let _stuckDiagShown = false; // one-shot: "live but your size isn't offered" notice

function startDropWatcher(tag, preferred) {
  if (dropWatcherActive) return;
  dropWatcherActive = true;

  renderStatusBar("waiting", { size: sizeLabel(preferred) });
  logBG(`⏳${tag} Drop not live yet. Bot is watching and will auto-enter when sizes appear.`);

  const observer = new MutationObserver(async () => {
    if (entryAttempted) {
      observer.disconnect();
      return;
    }

    const status = detectPageStatus();

    // Drop has gone live — sizes are now clickable
    if (status === STATUS.ENTER) {
      // Extra check: make sure our size button is actually there
      const sizeBtn = findPreferredSizeButton();
      if (sizeBtn) {
        observer.disconnect();
        logBG(`🚀${tag} DROP IS LIVE! size ${sizeLabel(preferred)} found — entering now!`);
        renderStatusBar("size", { size: sizeLabel(preferred) });
        await executeEntry(tag, preferred);
      }
      return;
    }

    // Already entered or pending — stop watching
    if (status === STATUS.ENTRY_IN || status === STATUS.PURCHASED || status === STATUS.PENDING) {
      observer.disconnect();
      if (status === STATUS.PENDING) enterPendingState(tag, "Pending detected");
    }
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Safety net: also poll every 500ms in case MutationObserver misses a re-render
  const pollId = setInterval(async () => {
    if (entryAttempted) { clearInterval(pollId); return; }

    const status = detectPageStatus();
    if (status === STATUS.ENTER) {
      const sizeBtn = findPreferredSizeButton();
      if (sizeBtn) {
        clearInterval(pollId);
        observer.disconnect();
        if (entryAttempted) return; // double-check before firing
        logBG(`🚀${tag} DROP IS LIVE (poll)! size ${sizeLabel(preferred)} found — entering now!`);
        renderStatusBar("size", { size: sizeLabel(preferred) });
        await executeEntry(tag, preferred);
      } else if (!_stuckDiagShown && !isRandomSize()) {
        // Drop is LIVE and sizes exist, but none match the fixed target — the
        // classic "stuck" case (e.g. youth "US 5Y" sizes vs an adult preset).
        // Say so once, loudly, and point at 🎲 Random instead of hanging silent.
        const kw = settings?.productKeyword;
        const scope = (kw && kw.trim()) ? findProductScope(kw) : null;
        const avail = getAllSizeButtons(scope).filter(isButtonAvailable)
          .map(b => (b.innerText || "").trim()).filter(Boolean);
        if (avail.length) {
          _stuckDiagShown = true;
          logBG(`⚠️${tag} Drop is LIVE but size ${sizeLabel(preferred)} isn't among the ${avail.length} available: ${avail.join(", ")}. Turn on 🎲 Random size (or pick one of these) — the bot will keep watching meanwhile.`);
          renderStatusBar("error", { errorMsg: `${sizeLabel(preferred)} not offered — use 🎲 Random or pick a size manually` });
        }
      }
    }

    if (status === STATUS.ENTRY_IN || status === STATUS.PURCHASED || status === STATUS.CLOSED || status === STATUS.PENDING) {
      clearInterval(pollId);
      observer.disconnect();
      if (status === STATUS.PENDING) enterPendingState(tag, "Pending detected in poll");
    }
  }, 500);
}

// ── Core entry logic (extracted for reuse) ────────────────────
async function executeEntry(tag, preferred) {
  if (entryAttempted) return; // prevent double-fire
  // PANIC: dashboard raised a global abort — do not enter this draw.
  if (await checkAbort()) {
    logBG(`🛑${tag} PANIC — abort raised. NOT entering the draw.`);
    showBanner("🛑 STOPPED — no entry made.", "#374151");
    return;
  }
  entryAttempted = true;

  const leo = isLeoDrop();
  logBG(`${leo ? "⚡" : "🎟️"}${tag} ${leo ? "LEO drop — speed path: settling waits stripped, CTA polled hard."
                                          : "DAN drop — accuracy path: human pacing, size selection verified before entry."}`);

  // Wait for the size button to be fully ready (brief grace period). LEO cuts
  // it to the shortest wait that still lets Nike's React finish painting.
  await wait(leo ? randInt(20, 60) : randInt(200, 500));

  const sizeBtn = findPreferredSizeButton();
  if (!sizeBtn) {
    entryAttempted = false; // allow retry
    logBG(`❌${tag} Size ${sizeLabel(preferred)} disappeared before we could click it — retrying watch.`);
    startDropWatcher(tag, preferred);
    return;
  }

  // Now we know the REAL size — even in random mode. Show it at the top and
  // record it so the checkout page's status bar can show it too.
  const pickedLabel = (sizeBtn.innerText || "").trim() || sizeLabel(preferred);
  recordPickedSize(pickedLabel);
  renderStatusBar("size", { size: pickedLabel });

  // v1.0 proven flow: ONE size click, wait, ONE CTA click. No retry loops, no
  // native .click(), no selection gating — that extra machinery broke live
  // drops. Random size just changes WHICH button findPreferredSizeButton picks.
  logBG(`✅${tag} Clicking size ${pickedLabel}…`);
  humanClick(sizeBtn, `Size ${pickedLabel}`);

  if (leo) {
    // Speed: no fixed settle. The CTA usually enables within ~100ms of the size
    // click, and every 200ms poll skipped is 200ms shaved off the entry.
    await wait(randInt(40, 90));
  } else {
    // Accuracy: the window is long, so pace it like a human and spend the spare
    // time proving the size took before committing to the draw.
    await wait(randInt(500, 900));
    await verifySizeSelection(tag, sizeBtn, pickedLabel);
  }

  const ctaBtn = await waitFor(findCTAButton, 8000, leo ? 40 : 200);

  if (!ctaBtn) {
    logBG(`❌${tag} CTA button (Join Draw / Buy) did not activate after selecting size.`);
    entryAttempted = false;
    return;
  }

  const ctaText = (ctaBtn.innerText || "").trim();
  log(`CTA button found: "${ctaText}"`);

  if (settings?.testMode) {
    logBG(`🧪${tag} TEST MODE — size selected (${sizeLabel(preferred)}), NOT clicking "${ctaText}".`);
    showBanner(`TEST MODE — size ${sizeLabel(preferred)} selected, not entering`);
    return;
  }

  const productTitle = document.title || location.href;
  sessionStorage.setItem(POLLER_PRODUCT_KEY, productTitle);

  renderStatusBar("checkout", { size: pickedLabel, label: "Entering — clicking " + ctaText });
  logBG(`🛒${tag} Clicking "${ctaText}" — entering draw…`);
  humanClick(ctaBtn, ctaText);

  // LEO checks the outcome sooner so the one-shot retry below still lands
  // inside the FCFS window; DAN keeps the original, more forgiving settle.
  await wait(leo ? 900 : 2500);

  // Non-blocking success check: instant-buy drops confirm by adding to the bag
  // on the SAME url. If we see it, report it (and the "carted" notification
  // fires) and skip the retry — never double-click Buy.
  if (addedToBagConfirmed()) {
    logBG(`🛒✅${tag} ADDED TO BAG — ${sizeLabel(preferred)} is in the cart. Proceed to checkout to complete the purchase.`);
    renderStatusBar("checkout", { size: sizeLabel(preferred), label: "Added to bag — completing checkout" });
    return;
  }

  if (location.hostname.includes("nike.com") && !location.hostname.includes("gs.nike.com")) {
    const postStatus = detectPageStatus();
    log(`Post-click status: ${postStatus}`);

    if (postStatus === STATUS.ENTRY_IN) {
      logBG(`📋${tag} Entry confirmed! Draw entered for ${sizeLabel(preferred)}. Starting status poller…`);
      renderStatusBar("done", { time: nowClock(), label: "Entry submitted" });
      startStatusPoller();
    } else if (postStatus === STATUS.ENTER) {
      logBG(`⚠️${tag} CTA click may not have registered — retrying once…`);
      await wait(leo ? 250 : 500);
      const retryBtn = findCTAButton();
      if (retryBtn) humanClick(retryBtn, "CTA retry");
      await wait(leo ? 900 : 2000);
      if (addedToBagConfirmed()) {
        logBG(`🛒✅${tag} ADDED TO BAG — ${sizeLabel(preferred)} is in the cart.`);
        renderStatusBar("checkout", { size: sizeLabel(preferred), label: "Added to bag — completing checkout" });
      } else if (detectPageStatus() === STATUS.ENTRY_IN) {
        logBG(`📋${tag} Entry confirmed on retry! Starting poller…`);
        startStatusPoller();
      }
    } else {
      logBG(`⚠️${tag} Unexpected post-click status: ${postStatus} — check the page manually.`);
    }
  }
}

// ── Main SNKRS flow ───────────────────────────────────────────
async function runSNKRSFlow() {
  const tag = profileTag();
  const preferred = settings?.preferredSize;

  // ── Check if this is a poller reload ────────────────────────
  if (sessionStorage.getItem(POLLER_ACTIVE_KEY) === "1") {
    await wait(2500);
    checkStatusAfterReload();
    return;
  }

  if (!preferred && !isRandomSize()) {
    log("No size configured. Open the SNKRS Bot popup.");
    return;
  }

  // Announce exactly what this profile is targeting, so a launched window that's
  // on stale code (no random support) or the wrong size is obvious in the log.
  logBG(`🎯${tag} Targeting ${isRandomSize() ? "🎲 RANDOM (any available size)" : sizeLabel(preferred)} · ext v${(chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "?"}`);

  // Let the page render fully
  await wait(2000);
  const currentStatus = detectPageStatus();
  log(`Initial page status: ${currentStatus}`);

  if (currentStatus === STATUS.ENTRY_IN) {
    logBG(`ℹ️${tag} Already entered this draw — starting status poller.`);
    startStatusPoller();
    return;
  }
  if (currentStatus === STATUS.PENDING) {
    enterPendingState(tag, "Entry is in line on page load");
    return;
  }
  if (currentStatus === STATUS.PURCHASED) {
    logBG(`🎉🔥👟${tag} **GOT 'EM!!** You won the draw! Check your email NOW. 🏆🏆🏆 ${location.href}`);
    renderStatusBar("done", { time: nowClock(), label: "GOT 'EM 🎉", tone: "win" });
    launchConfetti();
    return;
  }
  if ([STATUS.NOT_WON, STATUS.CLOSED, STATUS.SOLD_OUT].includes(currentStatus)) {
    logBG(`ℹ️${tag} Draw not available (${currentStatus}) — nothing to do.`);
    return;
  }

  // FIX: If drop isn't live yet (Coming Soon) or status is Unknown,
  // start the drop watcher instead of just waiting with waitFor() once.
  if (currentStatus === STATUS.COMING_SOON || currentStatus === STATUS.UNKNOWN) {
    // Could be loading early — activate the persistent watcher
    startDropWatcher(tag, preferred);
    return;
  }

  // Drop is already live — enter immediately
  if (currentStatus === STATUS.ENTER) {
    logBG(`👟${tag} Drop is live on page load. Entering for ${sizeLabel(preferred)}…`);
    renderStatusBar("size", { size: sizeLabel(preferred) });

    // FIX: Wait for size buttons to be stable (Nike loads them but they may
    // briefly show as disabled right as the drop opens)
    const sizeBtn = await waitFor(findPreferredSizeButton, 30000, 300);

    if (!sizeBtn) {
      const kw = settings?.productKeyword;
      const hasKeyword = !!(kw && kw.trim());
      const scope = hasKeyword ? findProductScope(kw) : null;

      // CASE A: a product keyword/SKU was set but we never located that product.
      // This is the dangerous case that previously caused a wrong-product buy.
      // Alert loudly and DO NOT enter anything.
      if (hasKeyword && !scope) {
        logBG(`❌${tag} Product "${kw}" was NOT found on this page — bot did NOT buy anything (correct). Check the SKU/keyword or the URL.`);
        renderStatusBar("error", { errorMsg: `Product "${kw}" not found — check the SKU/URL` });
        // Keep watching in case the product card is still lazy-loading, but the
        // scope guard means we still won't buy a different product.
        startDropWatcher(tag, preferred);
        return;
      }

      // CASE B: product found (or no keyword) but the chosen size isn't there.
      const available = getAllSizeButtons(scope)
        .filter(isButtonAvailable)
        .map(b => (b.innerText || "").trim())
        .join(", ");
      const where = scope ? ` for "${kw}"` : "";
      logBG(`❌${tag} Size ${sizeLabel(preferred)} not found or sold out${where}. Available: ${available || "none visible yet"}`);

      // Don't just give up — start the watcher in case sizes are still loading
      logBG(`⏳${tag} Starting drop watcher as fallback…`);
      startDropWatcher(tag, preferred);
      return;
    }

    await executeEntry(tag, preferred);
  }
}

// ── Init ─────────────────────────────────────────────────────
(async function init() {
  if (hasRun) return;
  hasRun = true;

  await loadSettings();
  if (!settings?.enabled) { log("Bot disabled."); return; }
  if (settings?.testMode) showBanner("SNKRS BOT — TEST MODE (will not submit)");
  if (!isLaunchPage()) { log("Not a SNKRS launch page."); return; }

  // Warm-then-flip: bootstrap-content-script will navigate this tab to the gs
  // checkout link shortly before the drop. Do NOT run the launch-page submit
  // flow or the status poller here — this tab only warms and then flips.
  try {
    if (sessionStorage.getItem("snkrsWarmFlip") === "1") {
      log("Warm-then-flip mode — launch-page submit + poller suppressed; waiting to flip to checkout.");
      return;
    }
  } catch (e) {}

  runSNKRSFlow().catch(err => {
    logBG(`❌ SNKRS flow error: ${err}`);
    console.error("[SNKRSBot]", err);
  });
})();

// ── Preview / highlight target product ────────────────────────
// Lets the user verify, BEFORE the drop, exactly which product the bot will
// target for a given keyword/SKU and size. Draws an outline around the matched
// product card, scrolls it into view, and highlights the size button it would
// click. Returns a summary so the popup can show pass/fail.
let _previewEls = [];
function clearPreviewHighlight() {
  for (const el of _previewEls) {
    try { el.remove(); } catch (e) {}
  }
  _previewEls = [];
  // Remove any inline outline we added to matched elements
  document.querySelectorAll("[data-snkrs-preview-outline]").forEach(el => {
    el.style.outline = "";
    el.style.outlineOffset = "";
    el.removeAttribute("data-snkrs-preview-outline");
  });
}

function makeOverlayLabel(text, color) {
  const div = document.createElement("div");
  div.textContent = text;
  div.style.cssText = `position:fixed;z-index:2147483647;top:0;left:0;background:${color};color:#fff;font:700 13px/1.3 sans-serif;padding:8px 14px;border-radius:0 0 8px 0;box-shadow:0 2px 8px rgba(0,0,0,.3);max-width:90vw;`;
  return div;
}

function previewProductTarget(keyword, size, sizeType) {
  clearPreviewHighlight();

  const kw = (keyword || "").trim();
  const preferred = (size || "").trim();
  const preferredNorm = preferred.toUpperCase();
  const isApparelTarget = APPAREL_SIZES.includes(preferredNorm);

  // Build a temporary settings overlay so findPreferredSizeButton uses these.
  const savedSize = settings.preferredSize;
  const savedType = settings.preferredSizeType;
  const savedKw = settings.productKeyword;
  settings.preferredSize = preferred;
  settings.preferredSizeType = sizeType || (isApparelTarget ? "apparel" : "footwear");
  settings.productKeyword = kw;

  let result = { ok: false, message: "", productText: "", sizeFound: false, sizeText: "" };

  try {
    // 1) Locate the product scope (or whole page if no keyword)
    let scope = null;
    if (kw) {
      scope = findProductScope(kw);
      if (!scope) {
        result.message = `❌ Product "${kw}" NOT found on this page. The bot would REFUSE to buy (safe). Check the SKU/keyword.`;
        const banner = makeOverlayLabel(`❌ "${kw}" not found — bot would buy nothing`, "#e03131");
        document.body.appendChild(banner);
        _previewEls.push(banner);
        setTimeout(clearPreviewHighlight, 8000);
        return result;
      }
    }

    // 2) Outline the product card (or note whole-page mode)
    if (scope) {
      scope.style.outline = "4px solid #1db954";
      scope.style.outlineOffset = "3px";
      scope.setAttribute("data-snkrs-preview-outline", "1");
      scope.scrollIntoView({ behavior: "smooth", block: "center" });

      const title = (scope.querySelector("h1, h2, h3, h4") || {}).innerText
                 || (scope.innerText || "").slice(0, 60);
      result.productText = (title || "").trim().split("\n")[0];
    }

    // 3) Find the exact size button the bot would click
    const sizeBtn = findPreferredSizeButton();
    if (sizeBtn) {
      sizeBtn.style.outline = "4px solid #fa5400";
      sizeBtn.style.outlineOffset = "2px";
      sizeBtn.setAttribute("data-snkrs-preview-outline", "1");
      result.sizeFound = true;
      result.sizeText = (sizeBtn.innerText || "").trim();
      result.ok = true;

      const label = kw
        ? `✅ TARGET: "${result.productText}" — size ${result.sizeText}`
        : `✅ TARGET (whole page) — size ${result.sizeText}`;
      result.message = label;

      const banner = makeOverlayLabel(label, "#1db954");
      document.body.appendChild(banner);
      _previewEls.push(banner);
    } else {
      // Product found but size not available/visible. This is expected before
      // the drop goes live: Nike shows the product + Coming Soon CTA, but no
      // clickable size grid yet.
      const avail = getAllSizeButtons(scope)
        .filter(isButtonAvailable)
        .map(b => (b.innerText || "").trim())
        .join(", ");
      const preLive = scope && hasProductCta(scope) && !avail;
      result.ok = !!preLive;
      result.message = preLive
        ? `✅ Product found, but drop is not live yet. Size ${sizeLabel(preferred)} is not visible yet — bot will keep watching this product.`
        : (scope
          ? `⚠️ Found the product, but size ${sizeLabel(preferred)} isn't available. Available: ${avail || "none yet"}`
          : `⚠️ Size ${sizeLabel(preferred)} not found on page. Available: ${avail || "none yet"}`);
      const banner = makeOverlayLabel(result.message, preLive ? "#1db954" : "#f08c00");
      document.body.appendChild(banner);
      _previewEls.push(banner);
    }

    // Auto-clear after 10s so it doesn't linger till drop time
    setTimeout(clearPreviewHighlight, 10000);
    return result;
  } finally {
    // Restore real settings — preview must not change what the bot uses live.
    settings.preferredSize = savedSize;
    settings.preferredSizeType = savedType;
    settings.productKeyword = savedKw;
  }
}

// Listen for preview requests from the popup.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "preview_target") {
    try {
      const r = previewProductTarget(msg.keyword, msg.size, msg.sizeType);
      sendResponse({ ok: true, result: r });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return true;
  }
  if (msg && msg.type === "clear_preview") {
    clearPreviewHighlight();
    sendResponse({ ok: true });
    return true;
  }
});
