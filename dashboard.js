// ============================================================
// Nike SNKRS Bot – Drop Dashboard
// ============================================================
// Central control room for running ONE drop across MANY Chrome profiles
// (= many Nike accounts). It:
//   • holds the shared DROP details (everyone cops the same product),
//   • holds the shared CARD details (applied to all, with per-account
//     overrides),
//   • lists accounts, each pinned to a Chrome profile,
//   • launches each profile straight onto the drop via the native host.
//
// The native host ("com.snkrs.launcher") is what actually opens other
// Chrome profiles and stores the shared config file. Without it the
// dashboard still edits config and can hand you copy-paste launch
// commands as a fallback.
// ============================================================

// ── Page navigation ──────────────────────────────────────────
let _currentPage = "home";
function navigateTo(name) {
  document.querySelectorAll(".page-section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".nav-tab").forEach(t => t.classList.remove("active"));
  const sec = document.getElementById("page-" + name);
  const tab = document.querySelector(`.nav-tab[data-nav="${name}"]`);
  if (sec) sec.classList.add("active");
  if (tab) tab.classList.add("active");
  _currentPage = name;
  if (name === "home") {
    renderHomeStats();
    if (!_upcomingLoaded) loadUpcoming(false);
  }
}

function renderHomeStats() {
  // Stats
  const $s = id => document.getElementById(id);
  if ($s("statAccounts")) $s("statAccounts").textContent = accounts.length || 0;

  // Count entries + wins from live statuses
  const statuses = Object.values(liveStatuses || {});
  const wins = statuses.filter(s => (s.code || "").toLowerCase().includes("won") || (s.code || "").toLowerCase().includes("win")).length;
  const entries = statuses.filter(s => s.code && s.code !== "idle").length;
  if ($s("statWins")) $s("statWins").textContent = wins;
  if ($s("statEntries")) $s("statEntries").textContent = entries;
  if ($s("statDrops")) {
    chrome.storage.local.get(HISTORY_KEY, d => {
      const hist = Array.isArray(d[HISTORY_KEY]) ? d[HISTORY_KEY] : [];
      $s("statDrops").textContent = hist.length;
      renderLastDrop(hist);
    });
  }

  // Live status board
  const list = document.getElementById("homeStatusList");
  if (list) {
    const acctStatuses = accounts.filter(a => a.profileDir && liveStatuses[a.profileDir]);
    if (!acctStatuses.length) {
      list.innerHTML = "<p class='hint'>No accounts running. Launch from the DROP tab.</p>";
    } else {
      list.innerHTML = "";
      acctStatuses.forEach(a => {
        const s = liveStatuses[a.profileDir] || {};
        const row = document.createElement("div");
        row.className = "home-status-row";
        const lbl = document.createElement("span");
        lbl.className = "home-status-label";
        lbl.textContent = a.label || a.profileDir;
        const badge = document.createElement("span");
        badge.className = "home-status-badge";
        badge.textContent = s.code || "IDLE";
        badge.style.color = (s.code||"").toLowerCase().includes("won") ? "var(--green)"
          : (s.code||"").toLowerCase().includes("fail") || (s.code||"").toLowerCase().includes("err") ? "var(--red)"
          : "var(--purple2)";
        row.append(lbl, badge);
        list.appendChild(row);
      });
    }
  }

  // Current drop summary
  const dropDiv = document.getElementById("homeDropSummary");
  if (dropDiv) {
    const url = (document.getElementById("dropUrl") || {}).value || "";
    const kw = (document.getElementById("dropKeyword") || {}).value || "";
    if (url) {
      dropDiv.innerHTML = `<div class="home-drop-url">${url}</div>` +
        (kw ? `<span class="home-drop-chip" style="color:var(--purple2)">SKU: ${kw}</span>` : "") +
        `<span class="home-drop-chip" style="color:var(--grey)">${accounts.length} account(s)</span>`;
    } else {
      dropDiv.innerHTML = "<p class='hint'>No drop configured. Go to the DROP tab to set one up.</p>";
    }
  }
}

function renderLastDrop(hist) {
  const div = document.getElementById("lastDropSummary");
  const tag = document.getElementById("lastDropTag");
  if (!div) return;
  if (!hist.length) {
    div.innerHTML = "<p class='hint'>No drop history. Run a drop to see results here.</p>";
    if (tag) tag.textContent = "NO RUNS YET";
    return;
  }
  // History is stored newest-first (unshift), so the latest run is index 0.
  const last = hist[0];
  const d = new Date(last.date || last.ts || 0);
  const dateStr = isNaN(d.getTime()) ? "" : d.toLocaleDateString();

  // results is a map { profileDir: code }, codes like "win"/"loss"/"entered".
  const results = (last.results && typeof last.results === "object" && !Array.isArray(last.results))
    ? last.results : {};
  const entries = Object.entries(results);
  const wins = entries.filter(([, code]) => (code || "").toLowerCase().includes("win")).length;

  if (tag) tag.textContent =
    `${wins > 0 ? "🏆 " + wins + " WIN" + (wins > 1 ? "S" : "") : "NO WINS"}${dateStr ? " · " + dateStr : ""}`;

  // Resolve a profileDir to its friendly label from this run's account list.
  const labelFor = (pd) => {
    const a = (last.accounts || []).find(x => x.profileDir === pd);
    return a ? (a.label || a.profileDir) : pd;
  };

  let html = `<div class="home-drop-url">${last.url || "(no URL)"}</div>`;
  if (!entries.length) {
    const n = (last.accounts || []).length;
    html += `<p class="hint">Launched ${n} account(s) — no results in yet.</p>`;
  } else {
    entries.slice(0, 8).forEach(([pd, code]) => {
      const meta = STATUS_META[code] || { text: code || "?", color: "var(--grey)" };
      html += `<span class="home-drop-chip" style="color:${meta.color}">${labelFor(pd)}: ${meta.text}</span>`;
    });
  }
  div.innerHTML = html;
}

// ── Upcoming SNKRS drops ──────────────────────────────────────
function fmtUpcomingDate(iso) {
  if (!iso) return "TBA";
  const d = new Date(iso);
  if (isNaN(d)) return "TBA";
  return d.toLocaleString("en-SG", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
}

function renderUpcoming(drops, note) {
  const list = document.getElementById("upcomingList");
  const msg = document.getElementById("upcomingMsg");
  if (!list) return;
  if (msg) msg.textContent = note || `${drops.length} upcoming drop(s) on Nike SG.`;
  list.innerHTML = "";
  if (!drops.length) {
    if (msg) msg.textContent = note || "No upcoming drops found right now.";
    return;
  }
  drops.forEach(d => {
    const card = document.createElement("div");
    card.className = "upcoming-card";

    if (d.imageUrl) {
      const img = document.createElement("img");
      img.className = "upcoming-img";
      img.src = d.imageUrl; img.loading = "lazy"; img.alt = d.title || "";
      card.appendChild(img);
    }

    const body = document.createElement("div");
    body.className = "upcoming-body";

    const name = el("div", { className: "upcoming-name" }, d.title || "Nike Drop");
    body.appendChild(name);
    if (d.subtitle) body.appendChild(el("div", { className: "upcoming-sub" }, d.subtitle));
    body.appendChild(el("div", { className: "upcoming-date" }, "📅 " + fmtUpcomingDate(d.dateISO)));

    const metaRow = document.createElement("div");
    metaRow.className = "upcoming-meta-row";
    metaRow.appendChild(el("span", { className: "upcoming-price" },
      d.price !== "" ? `${d.currency || "SGD"} ${d.price}` : ""));
    if (d.method) metaRow.appendChild(el("span", { className: "upcoming-method" }, String(d.method)));
    body.appendChild(metaRow);

    if (d.sku) body.appendChild(el("div", { className: "upcoming-sku" }, d.sku));

    const useBtn = el("button", { className: "upcoming-use" }, "USE FOR DROP →");
    useBtn.addEventListener("click", () => {
      if (d.url && $("dropUrl")) $("dropUrl").value = d.url;
      if (d.sku && $("dropKeyword")) $("dropKeyword").value = d.sku;
      navigateTo("drop");
      flashTemp($("assignMsg"), `Loaded "${d.title}" into the drop. Set sizes and save.`, "var(--green)", 5000);
    });
    body.appendChild(useBtn);

    card.appendChild(body);
    list.appendChild(card);
  });
}

let _upcomingLoaded = false;
function loadUpcoming(force) {
  const msg = document.getElementById("upcomingMsg");
  if (msg) msg.textContent = force ? "Refreshing from Nike…" : "Loading upcoming drops from Nike…";
  chrome.runtime.sendMessage({ type: "fetch_upcoming", force: !!force }, (resp) => {
    if (chrome.runtime.lastError) {
      if (msg) msg.textContent = "Couldn't reach the background worker — reload the extension.";
      return;
    }
    if (!resp) { if (msg) msg.textContent = "No response from background."; return; }
    if (resp.ok || (resp.drops && resp.drops.length)) {
      _upcomingLoaded = true;
      const note = resp.ok
        ? `${resp.drops.length} upcoming drop(s)${resp.cached ? " (cached)" : ""}.`
        : `Showing cached drops — live fetch failed (${resp.error || "network"}).`;
      renderUpcoming(resp.drops || [], note);
    } else {
      if (msg) msg.textContent = `Couldn't load upcoming drops: ${resp.error || "unknown error"}. Nike's feed may be temporarily blocking requests.`;
    }
  });
}

const NATIVE_HOST = "com.snkrs.launcher";
const DASH_KEY    = "snkrsDashboard";
const STATUS_KEY  = "snkrsStatus";
const HISTORY_KEY = "snkrsHistory";
const ORDERS_KEY  = "snkrsOrders";
const CARDS_KEY   = "snkrsCardProfiles";

const FOOTWEAR_SIZES = ["5","5.5","6","6.5","7","7.5","8","8.5","9","9.5","10","10.5","11","11.5","12","12.5","13","13.5","14"];
const APPAREL_SIZES  = ["XS","S","M","L","XL","XXL"];

let discoveredProfiles = [];   // [{dir,name}]
let hostOk = false;
let accounts = [];             // [{id,label,profileDir,manualProfile,size,sizeType,cardId}]
let cardProfiles = [];         // [{id,name,cardName,cardNumber,cardExpiry,cardCvv}]
let editingCardId = null;      // card profile currently being edited (or null)
let liveStatuses = {};         // {profileDir: {code,message,time}}
const statusElMap = new Map(); // profileDir → {rowEl, badgeEl, textEl, timeEl}

let singleSizePool = [];       // ["footwear:9", "footwear:9.5", ...] for single-product
let products = [];             // [{id,url,keyword,sizePool:[]}] for multi-product
let multiProduct = false;
let currentRunId  = null;      // ID of the most recently launched history entry
let countdownTimer = null;

// ── Random helpers ────────────────────────────────────────────
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// Deal n picks from a pool, evenly + randomly (each size used about equally).
function dealFromPool(pool, n) {
  if (!pool.length || n <= 0) return [];
  const bag = [];
  while (bag.length < n) bag.push(...shuffle(pool));
  return shuffle(bag).slice(0, n);
}
function newProduct() { return { id: uid(), url: "", keyword: "", sizePool: [] }; }

// ── Size-pool chip multi-select ───────────────────────────────
function buildSizePool(container, selected, onChange) {
  container.innerHTML = "";
  const sel = new Set(selected || []);
  const addGroup = (label, sizes, type, fmt) => {
    container.appendChild(el("div", { className: "size-pool-grouplbl" }, label));
    sizes.forEach(s => {
      const val = `${type}:${s}`;
      const chip = el("div", { className: "size-chip" + (sel.has(val) ? " on" : "") }, fmt(s));
      chip.addEventListener("click", () => {
        if (sel.has(val)) { sel.delete(val); chip.classList.remove("on"); }
        else { sel.add(val); chip.classList.add("on"); }
        onChange(Array.from(sel));
      });
      container.appendChild(chip);
    });
  };
  addGroup("Footwear (US M)", FOOTWEAR_SIZES, "footwear", s => "US " + s);
  addGroup("Apparel", APPAREL_SIZES, "apparel", s => s);
}

// ── Multi-product UI ──────────────────────────────────────────
function applyMultiUI() {
  $("singleProductPanel").style.display = multiProduct ? "none" : "";
  $("multiProductPanel").style.display  = multiProduct ? "" : "none";
  $("dropModeTag").textContent = multiProduct ? "ACCOUNTS SPLIT ACROSS PRODUCTS" : "EVERYONE COPS THE SAME DROP";
  if (multiProduct && !products.length) { products.push(newProduct()); }
  renderProducts();
}

function renderProducts() {
  const list = $("productsList");
  if (!list) return;
  list.innerHTML = "";
  if (!products.length) {
    list.appendChild(el("p", { className: "hint" }, "No products yet — add one."));
    return;
  }
  products.forEach((p, i) => list.appendChild(buildProductRow(p, i)));
}

function buildProductRow(p, idx) {
  const row = $("productRowTpl").content.cloneNode(true).querySelector(".product");
  row.querySelector(".product-idx").textContent = "PRODUCT " + (idx + 1);
  const urlEl  = row.querySelector(".p-url");
  const kwEl   = row.querySelector(".p-keyword");
  const poolEl = row.querySelector(".p-sizepool");
  urlEl.value = p.url || "";
  kwEl.value  = p.keyword || "";
  buildSizePool(poolEl, p.sizePool || [], (s) => { p.sizePool = s; });
  urlEl.addEventListener("input", () => { p.url = urlEl.value.trim(); });
  kwEl.addEventListener("input",  () => { p.keyword = kwEl.value.trim(); });
  row.querySelector(".p-remove").addEventListener("click", () => {
    products = products.filter(x => x.id !== p.id);
    renderProducts();
  });
  return row;
}

function renderDropUI() {
  buildSizePool($("singleSizePool"), singleSizePool, (s) => { singleSizePool = s; });
  $("multiProductToggle").checked = multiProduct;
  applyMultiUI();
}

// ── Random assignment of sizes / products to accounts ─────────
function shortUrl(u) {
  if (!u) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : "https://" + u);
    const last = url.pathname.split("/").filter(Boolean).pop();
    return last || url.hostname;
  } catch { return u.slice(0, 40); }
}

async function randomAssign() {
  const msg = $("assignMsg");
  if (!accounts.length) { flashTemp(msg, "Add at least one account first.", "#fa5400"); return; }

  if (multiProduct) {
    const prods = products.filter(p => (p.url || "").trim());
    if (!prods.length) { flashTemp(msg, "Add at least one product with a URL.", "#fa5400"); return; }
    if (prods.some(p => !(p.sizePool || []).length)) {
      flashTemp(msg, "Every product needs at least one size in its range.", "#fa5400"); return;
    }
    // Spread accounts evenly across products, in random order.
    const order = shuffle(accounts.map((_, i) => i));
    const groups = prods.map(() => []);
    order.forEach((acctIdx, k) => groups[k % prods.length].push(acctIdx));
    groups.forEach((acctIdxs, pIdx) => {
      const p = prods[pIdx];
      const sizes = dealFromPool(p.sizePool, acctIdxs.length);
      acctIdxs.forEach((ai, k) => {
        const acct = accounts[ai];
        acct.url = (p.url || "").trim();
        acct.keyword = (p.keyword || "").trim();
        const { size, sizeType } = parseSizeValue(sizes[k]);
        acct.size = size; acct.sizeType = sizeType;
      });
    });
    renderAccounts();
    await saveAll(true);
    flashTemp(msg, `🎲 Assigned ${accounts.length} accounts across ${prods.length} products.`, "#1db954", 4000);
    await assignCheckoutUrls(msg); // build direct checkout URLs for the new sizes
  } else {
    if (!singleSizePool.length) { flashTemp(msg, "Pick at least one size in the pool above.", "#fa5400"); return; }
    const sizes = dealFromPool(singleSizePool, accounts.length);
    accounts.forEach((acct, i) => {
      acct.url = ""; acct.keyword = "";
      const { size, sizeType } = parseSizeValue(sizes[i]);
      acct.size = size; acct.sizeType = sizeType;
    });
    renderAccounts();
    await saveAll(true);
    flashTemp(msg, `🎲 Dealt sizes to ${accounts.length} accounts from a pool of ${singleSizePool.length}.`, "#1db954", 4000);
    await assignCheckoutUrls(msg); // build direct checkout URLs for the new sizes
  }
}

// ── Status badge metadata ─────────────────────────────────────
const STATUS_META = {
  win:        { text: "🏆 WON",       color: "#1db954" },
  success:    { text: "✅ SUBMITTED", color: "#1db954" },
  loss:       { text: "😔 LOSS",      color: "#e03131" },
  entered:    { text: "✓ ENTERED",    color: "#4a90e2" },
  // Live checkout stages
  waiting:    { text: "🕒 WAITING",   color: "#8b5cf6" },
  checkout:   { text: "🛒 CHECKOUT",  color: "#8b5cf6" },
  delivery:   { text: "📦 DELIVERY",  color: "#6366f1" },
  payment:    { text: "💳 PAYMENT",   color: "#4a90e2" },
  submitting: { text: "🚀 SUBMITTING",color: "#a855f7" },
  // Poller / draw
  pending:    { text: "⏳ PENDING",   color: "#fa8c00" },
  polling:    { text: "🔄 POLLING",   color: "#888888" },
  closed:     { text: "⛔ CLOSED",    color: "#666666" },
  limit:      { text: "⚠ LIMIT",     color: "#fa5400" },
  // Needs manual attention — clickable
  error:      { text: "❗ ERROR — CLICK TO FIX", color: "#e03131" },
};
// Codes that mean "this account needs you" — the row becomes clickable to jump
// straight to that Chrome profile.
const ATTENTION_CODES = new Set(["error"]);

function updateStatusBadge(profileDir) {
  const entry = statusElMap.get(profileDir);
  if (!entry) return;
  const s = liveStatuses[profileDir];
  if (!s) { entry.rowEl.classList.add("hidden"); return; }
  const meta = STATUS_META[s.code] || { text: s.code, color: "#888" };
  const attention = ATTENTION_CODES.has(s.code);

  entry.rowEl.classList.remove("hidden");
  entry.badgeEl.textContent = meta.text;
  entry.badgeEl.style.color = meta.color;
  entry.badgeEl.style.borderColor = meta.color + "66";
  entry.badgeEl.style.background  = meta.color + "1a";
  // Strip the **[label]** markup and step prefixes for a clean, readable line.
  entry.textEl.textContent  = (s.message || "").replace(/\*\*/g, "").slice(0, 110);
  entry.textEl.title        = s.message || "";
  if (s.time) {
    const d = new Date(s.time);
    entry.timeEl.textContent = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
  }

  // Attention rows glow red and become a click-to-jump control.
  entry.rowEl.classList.toggle("status-attention", attention);
  entry.rowEl.style.cursor = attention ? "pointer" : "";
  entry.rowEl.title = attention ? "Click to open this Chrome profile and fix it" : "";
  entry.rowEl.onclick = attention ? () => jumpToProfile(profileDir) : null;
}

// Open / focus the Chrome profile that needs attention, reopening its direct
// checkout URL with a FRESH checkoutId (a clean retry) so you land right where
// the fix is needed. Falls back to just focusing the profile.
async function jumpToProfile(profileDir) {
  const acct = accounts.find(a => a.profileDir === profileDir);
  let url = acct && acct.checkoutUrl ? freshCheckoutId(acct.checkoutUrl) : "";
  flashTemp($("statusMsg"), `Opening “${profileDir}”…`, "#8b5cf6", 3000);
  const resp = await hostSend({ cmd: "launch", profileDir, url: url || undefined });
  if (resp && resp.ok) flashTemp($("statusMsg"), `🡒 Opened “${profileDir}” — fix it there.`, "#1db954", 4000);
  else flashTemp($("statusMsg"), `Couldn't open “${profileDir}”: ${resp && resp.error || "launcher offline"}`, "#e03131", 5000);
}

// Swap the checkoutId in a gs.nike.com URL for a new UUID (avoids reusing a
// spent/invalid checkout session that may have caused the error page).
function freshCheckoutId(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has("checkoutId") && window.crypto && crypto.randomUUID) {
      u.searchParams.set("checkoutId", crypto.randomUUID());
    }
    return u.toString();
  } catch { return url; }
}

function refreshAllBadges() {
  accounts.forEach(a => { if (a.profileDir) updateStatusBadge(a.profileDir); });
}

// Poll the shared status.json (via the native host) and merge into liveStatuses.
// This is what makes the board show accounts running in OTHER Chrome profiles.
let statusPollTimer = null;
function startStatusPolling() {
  if (statusPollTimer) clearInterval(statusPollTimer);
  const tick = async () => {
    const resp = await hostSend({ cmd: "getStatus" });
    if (!resp || !resp.ok || !resp.status) return;
    let changed = false;
    for (const [dir, entry] of Object.entries(resp.status)) {
      const cur = liveStatuses[dir];
      if (!cur || cur.time !== entry.time || cur.code !== entry.code) {
        liveStatuses[dir] = entry;
        changed = true;
        // Feed resolved outcomes into the current history run too.
        if (entry && ["win", "loss", "entered", "limit", "success"].includes(entry.code)) {
          if (!cur || cur.code !== entry.code) updateHistoryResult(dir, entry.code === "success" ? "entered" : entry.code);
        }
      }
    }
    if (changed) refreshAllBadges();
  };
  tick();
  statusPollTimer = setInterval(tick, 2500);
}

// ── Storage change listener (live status + history sync) ─
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STATUS_KEY]) {
    const newStatuses = changes[STATUS_KEY].newValue || {};
    // Propagate newly resolved statuses into the current history run
    Object.entries(newStatuses).forEach(([profileDir, info]) => {
      if (info && ["win", "loss", "entered", "limit"].includes(info.code)) {
        const old = liveStatuses[profileDir];
        if (!old || old.code !== info.code) updateHistoryResult(profileDir, info.code);
      }
    });
    liveStatuses = newStatuses;
    refreshAllBadges();
  }
  if (changes[HISTORY_KEY]) {
    renderHistory(changes[HISTORY_KEY].newValue || []);
  }
  if (changes[CARDS_KEY]) {
    cardProfiles = changes[CARDS_KEY].newValue || [];
    renderCardProfiles();
    refreshCardSelects();
  }
  if (changes[ORDERS_KEY]) {
    const profileDir = $("orderCheckerProfile") && $("orderCheckerProfile").value;
    if (profileDir && changes[ORDERS_KEY].newValue?.[profileDir]) {
      renderOrders(profileDir, changes[ORDERS_KEY].newValue[profileDir]);
      flashTemp($("orderCheckerMsg"), "Orders updated.", "#1db954");
    }
  }
});

// ── Chrome Profile Creator ────────────────────────────────────
// Chrome auto-creates a profile directory the first time it's launched with
// --profile-directory="<name>". So "creating" a profile is just launching a
// fresh directory name straight onto the Nike SG login page.
const NIKE_LOGIN_URL = "https://www.nike.com/sg/login";

function nextProfileName() {
  const nums = [];
  const grab = (dir) => {
    const m = /^Profile (\d+)$/.exec((dir || "").trim());
    if (m) nums.push(parseInt(m[1], 10));
  };
  discoveredProfiles.forEach(p => grab(p.dir));
  accounts.forEach(a => grab(a.profileDir));
  const max = nums.length ? Math.max(...nums) : 0;
  return `Profile ${max + 1}`;
}

function suggestProfileName() {
  const inp = $("newProfileName");
  if (inp && !inp.value.trim()) inp.value = nextProfileName();
}

async function createProfile() {
  const msg = $("profileCreatorMsg");
  const inp = $("newProfileName");
  const name = (inp && inp.value.trim()) || nextProfileName();

  if (accounts.some(a => a.profileDir === name) || discoveredProfiles.some(p => p.dir === name)) {
    flashTemp(msg, `"${name}" already exists — pick another name.`, "#fa5400", 4000);
    return;
  }

  flash(msg, `Creating "${name}" and opening Nike login…`, "#888");
  const resp = await hostSend({ cmd: "launch", profileDir: name, url: NIKE_LOGIN_URL });

  if (resp.ok) {
    // Add it to the accounts list straight away so it's ready to configure.
    accounts.push({ id: uid(), label: name, profileDir: name, size: "", sizeType: "footwear", cardId: "" });
    renderAccounts();
    await saveAll(true);
    if (inp) inp.value = nextProfileName();
    flashTemp(msg, `✓ Created "${name}" — sign into your Nike account in the new window, then fill its size & card below.`, "#1db954", 9000);
    document.getElementById("accountsList").lastElementChild
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } else if (resp.hostMissing) {
    flashTemp(msg, "Launcher offline — install the native host first (see the guide / setup below).", "#fa5400", 6000);
  } else {
    flashTemp(msg, "Couldn't create profile: " + resp.error, "#e03131", 6000);
  }
}

// ── Card profiles (reusable cards shared across accounts) ─────
async function loadCardProfiles() {
  const data = await chrome.storage.local.get(CARDS_KEY);
  cardProfiles = Array.isArray(data[CARDS_KEY]) ? data[CARDS_KEY] : [];
}
async function persistCardProfiles() {
  await chrome.storage.local.set({ [CARDS_KEY]: cardProfiles });
}

// Resolve an account's chosen card id into the card object the bot fills.
function resolveCard(cardId) {
  if (!cardId) return null;
  const cp = cardProfiles.find(c => c.id === cardId);
  if (!cp) return null;
  return {
    cardName:   cp.cardName   || "",
    cardNumber: cp.cardNumber || "",
    cardExpiry: cp.cardExpiry || "",
    cardCvv:    cp.cardCvv    || "",
  };
}

function cardMask(num) {
  const d = (num || "").replace(/\D/g, "");
  return d ? "•••• " + d.slice(-4) : "no number";
}

// Fill one account's card <select> with the saved profiles.
function fillCardSelect(sel, currentId) {
  if (!sel) return;
  sel.innerHTML = "";
  sel.appendChild(el("option", { value: "" }, "— no card (type at checkout) —"));
  cardProfiles.forEach(cp => {
    sel.appendChild(el("option", { value: cp.id }, `${cp.name || "Card"} · ${cardMask(cp.cardNumber)}`));
  });
  sel.appendChild(el("option", { value: "__new__" }, "➕ New card profile…"));
  // Keep the selection if it still exists, else fall back to none.
  sel.value = (currentId && cardProfiles.some(c => c.id === currentId)) ? currentId : "";
}
function refreshCardSelects() {
  document.querySelectorAll(".f-card-select").forEach(sel => {
    const acct = accounts.find(a => a.id === sel.dataset.acctId);
    fillCardSelect(sel, acct ? acct.cardId : "");
  });
}

function renderCardProfiles() {
  const list = $("cardProfilesList");
  if (!list) return;
  list.innerHTML = "";
  if (!cardProfiles.length) {
    list.appendChild(el("p", { className: "hint" }, "No cards yet. Add one below, then pick it from each account’s 💳 Card dropdown."));
    return;
  }
  cardProfiles.forEach(cp => list.appendChild(buildCardProfileRow(cp)));
}

function buildCardProfileRow(cp) {
  const row = el("div", { className: "cardprofile-row" });
  const info = el("div", { className: "cardprofile-info" });
  const usedBy = accounts.filter(a => a.cardId === cp.id).length;
  info.append(
    el("span", { className: "cardprofile-name" }, cp.name || "(unnamed card)"),
    el("span", { className: "cardprofile-sub" },
      `${cardMask(cp.cardNumber)}${cp.cardExpiry ? " · " + cp.cardExpiry : ""}${usedBy ? ` · used by ${usedBy}` : ""}`)
  );
  const btns = el("div", { className: "cardprofile-btns" });
  const editBtn = el("button", { className: "btn btn-mini btn-dark" }, "edit");
  editBtn.addEventListener("click", () => editCardProfile(cp.id));
  const delBtn = el("button", { className: "btn btn-mini btn-danger" }, "✕");
  delBtn.title = "Delete this card";
  delBtn.addEventListener("click", () => deleteCardProfile(cp.id));
  btns.append(editBtn, delBtn);
  row.append(info, btns);
  return row;
}

function resetCardForm() {
  editingCardId = null;
  ["cpName", "cpCardName", "cpNumber", "cpExpiry", "cpCvv"].forEach(id => { const n = $(id); if (n) n.value = ""; });
  $("cardFormTitle").textContent = "ADD A CARD";
  $("cpSaveBtn").textContent = "➕ SAVE CARD PROFILE";
  $("cpCancelBtn").style.display = "none";
}

function editCardProfile(id) {
  const cp = cardProfiles.find(c => c.id === id);
  if (!cp) return;
  editingCardId = id;
  $("cpName").value     = cp.name || "";
  $("cpCardName").value = cp.cardName || "";
  $("cpNumber").value   = cp.cardNumber || "";
  $("cpExpiry").value   = cp.cardExpiry || "";
  $("cpCvv").value      = cp.cardCvv || "";
  $("cardFormTitle").textContent = "EDIT CARD";
  $("cpSaveBtn").textContent = "✓ UPDATE CARD PROFILE";
  $("cpCancelBtn").style.display = "";
  $("cardForm").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function saveCardProfile() {
  const name   = $("cpName").value.trim();
  const number = $("cpNumber").value.trim();
  if (!name)   { flashTemp($("cpMsg"), "Give the card a nickname.", "#fa5400"); return; }
  if (!number) { flashTemp($("cpMsg"), "Enter the card number.", "#fa5400"); return; }

  const fields = {
    name,
    cardName:   $("cpCardName").value.trim(),
    cardNumber: number,
    cardExpiry: $("cpExpiry").value.trim(),
    cardCvv:    $("cpCvv").value.trim(),
  };

  if (editingCardId) {
    const cp = cardProfiles.find(c => c.id === editingCardId);
    if (cp) Object.assign(cp, fields);
    flashTemp($("cpMsg"), `✓ Updated "${name}".`, "#1db954");
  } else {
    cardProfiles.push({ id: uid(), ...fields });
    flashTemp($("cpMsg"), `✓ Saved "${name}". Pick it from an account’s 💳 Card dropdown.`, "#1db954", 5000);
  }
  await persistCardProfiles();
  resetCardForm();
  renderCardProfiles();
  refreshCardSelects();
  await saveAll(true);
}

async function deleteCardProfile(id) {
  const cp = cardProfiles.find(c => c.id === id);
  const usedBy = accounts.filter(a => a.cardId === id);
  if (usedBy.length && !confirm(`"${cp ? cp.name : "This card"}" is assigned to ${usedBy.length} account(s). Delete it and clear those assignments?`)) return;
  cardProfiles = cardProfiles.filter(c => c.id !== id);
  accounts.forEach(a => { if (a.cardId === id) a.cardId = ""; });
  if (editingCardId === id) resetCardForm();
  await persistCardProfiles();
  renderCardProfiles();
  refreshCardSelects();
  await saveAll(true);
  flashTemp($("cpMsg"), "Card deleted.", "#888");
}

// ── Order checker ─────────────────────────────────────────────

// Populate the profile picker from the current accounts list
function refreshOrderCheckerProfiles() {
  const sel = $("orderCheckerProfile");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = "";
  if (!accounts.length) {
    sel.appendChild(el("option", { value: "" }, "— add accounts first —"));
    return;
  }
  accounts.forEach(a => {
    const label = (a.label || a.profileDir || "Unnamed") + (a.profileDir ? `  ·  ${a.profileDir}` : "");
    sel.appendChild(el("option", { value: a.profileDir || "" }, label));
  });
  // Restore previous selection if still valid
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}

// Normalise raw API payloads from Nike's various order endpoints into a
// flat array of { orderNumber, date, status, products:[{name,sku,size,imageUrl}] }.
function normaliseOrderPayloads(payloads) {
  const orders = [];
  for (const p of (payloads || [])) {
    extractOrders(p.data).forEach(o => {
      if (!orders.find(x => x.orderNumber === o.orderNumber)) orders.push(o);
    });
  }
  return orders;
}

function extractOrders(raw) {
  if (!raw) return [];
  // Try many possible shapes Nike uses
  let items = raw.orders || raw.orderHistory || raw.data?.orders
           || raw.results || raw.content || raw.items;
  if (!Array.isArray(items)) {
    if (Array.isArray(raw)) items = raw;
    else return [];
  }
  return items.map(o => ({
    orderNumber: o.orderNumber || o.orderId || o.id || o.order_number || "",
    date:        o.orderDate   || o.placedDate || o.submittedDate || o.created_at || o.date || "",
    status:      o.orderStatus || o.status     || o.state || o.fulfillmentStatus || "",
    products:    extractLineItems(o),
  })).filter(o => o.orderNumber || o.products.length);
}

function extractLineItems(order) {
  const raw = order.lineItems || order.items || order.products
           || order.orderLines || order.orderItems || [];
  if (!Array.isArray(raw)) return [];
  return raw.map(i => ({
    name:     i.productName || i.name || i.title || i.product?.name || i.skuName || "",
    sku:      i.sku || i.styleCode || i.productCode || i.product?.sku || i.upc || "",
    size:     i.size || i.selectedSize || i.localSize || i.displaySize || "",
    imageUrl: i.imageUrl || i.image?.url || i.product?.imageUrl || i.thumbnailUrl || "",
  }));
}

// Normalise a SKU/style code for comparison: "IM3198-052" → "IM3198052".
function normSku(s) { return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }

// A win = the drop's SKU matches a SKU in the order. We pull SKU-like tokens
// from the drop keyword/SKU field and the drop URL (single-product) or from
// every product (multi-product).
const SKU_PAT = /[A-Z]{2,4}\d{3,4}-?\d{2,4}/gi;
function dropSkuTokens() {
  const out = new Set();
  const add = (str) => (String(str || "").match(SKU_PAT) || []).forEach(t => out.add(normSku(t)));
  if (multiProduct) {
    products.forEach(p => { add(p.keyword); add(p.url); });
  } else {
    add($("dropKeyword")?.value.trim() || "");
    add($("dropUrl")?.value.trim() || "");
  }
  return [...out].filter(Boolean);
}

// Does a single SKU match the drop?
function skuMatchesDrop(sku) {
  const ps = normSku(sku);
  if (!ps) return false;
  return dropSkuTokens().some(d => ps === d || ps.includes(d) || d.includes(ps));
}

// Returns true if any product SKU in this order matches a drop SKU.
function isDropMatch(order) {
  if (!dropSkuTokens().length) return false;
  return (order.products || []).some(p => skuMatchesDrop(p.sku));
}

function statusMeta(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("deliver") || s.includes("complete")) return { color: "#1db954" };
  if (s.includes("ship") || s.includes("transit"))    return { color: "#4a90e2" };
  if (s.includes("process") || s.includes("confirm")) return { color: "#fa8c00" };
  if (s.includes("cancel"))                            return { color: "#e03131" };
  return { color: "#8d8d8d" };
}

function buildOrderCard(order) {
  const match = isDropMatch(order);
  const card  = document.createElement("div");
  card.className = "order-card" + (match ? " match" : "");

  // Win banner when the drop SKU is found in this order
  if (match) {
    const win = document.createElement("div");
    win.className = "order-win-banner";
    win.textContent = "🏆 WIN — matches this drop’s SKU";
    card.appendChild(win);
  }

  // Header row: order number + date + status
  const head = document.createElement("div");
  head.className = "order-head";

  const numEl = document.createElement("span");
  numEl.className = "order-num";
  numEl.textContent = order.orderNumber ? `#${order.orderNumber}` : "Order";

  const dateEl = document.createElement("span");
  dateEl.className = "order-date";
  if (order.date) {
    try {
      const d = new Date(order.date);
      dateEl.textContent = isNaN(d) ? order.date
        : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch { dateEl.textContent = order.date; }
  }

  const statusEl = document.createElement("span");
  statusEl.className = "order-status";
  const sm = statusMeta(order.status);
  statusEl.style.color = sm.color;
  statusEl.textContent = (order.status || "PLACED").toUpperCase();

  head.append(numEl, dateEl, statusEl);

  // Products
  const itemsWrap = document.createElement("div");
  itemsWrap.className = "order-items";

  if (order.products && order.products.length) {
    order.products.forEach(p => {
      const itemMatch = skuMatchesDrop(p.sku);
      const row = document.createElement("div");
      row.className = "order-item" + (itemMatch ? " match" : "");

      const img = document.createElement("img");
      img.className = "order-thumb";
      img.src = p.imageUrl || "";
      img.alt = p.name || "";
      img.onerror = () => { img.style.visibility = "hidden"; };
      row.appendChild(img);

      const info = document.createElement("div");
      info.className = "order-item-info";

      const name = document.createElement("div");
      name.className = "order-item-name";
      name.textContent = p.name || "Product";

      const skuEl = document.createElement("div");
      skuEl.className = "order-item-sku";
      skuEl.textContent = p.sku ? `SKU ${p.sku}` : "SKU —";

      const meta = document.createElement("div");
      meta.className = "order-item-meta";
      meta.textContent = p.size ? `Size ${p.size}` : "";

      info.append(name, skuEl, meta);
      row.appendChild(info);

      if (itemMatch) {
        const badge = document.createElement("span");
        badge.className = "match-badge";
        badge.textContent = "DROP MATCH";
        row.appendChild(badge);
      }

      itemsWrap.appendChild(row);
    });
  }

  card.append(head, itemsWrap);
  return card;
}

async function renderOrders(profileDir, entry) {
  const display = $("ordersDisplay");
  if (!display) return;
  display.innerHTML = "";

  if (!entry) {
    display.appendChild(el("p", { className: "hint" }, "No orders loaded yet — click Open Orders Page."));
    return;
  }

  // Prefer richer API data (has order numbers); fall back to / merge DOM scrape.
  let orders = [];
  if (entry.apiPayloads?.length) orders = normaliseOrderPayloads(entry.apiPayloads);

  if (entry.domOrders?.length) {
    const domMapped = entry.domOrders.map(o => ({
      orderNumber: o.orderNumber || "",
      date: "",
      status: o.status || "",
      products: [{
        name: (o.rawText || "Order item").slice(0, 90),
        sku: o.style || "",
        size: o.size || "",
        imageUrl: o.imageUrl || "",
      }],
    }));
    // Merge: add any DOM order whose SKU isn't already covered by API data.
    const apiSkus = new Set();
    orders.forEach(o => (o.products || []).forEach(p => { if (p.sku) apiSkus.add(normSku(p.sku)); }));
    domMapped.forEach(o => {
      const sku = normSku(o.products[0].sku);
      if (!sku || !apiSkus.has(sku)) orders.push(o);
    });
  }

  if (!orders.length) {
    display.appendChild(el("p", { className: "hint" },
      "No orders read yet. If you’re logged in and orders are visible, give it a few seconds — or reload the extension if you just updated."));
    return;
  }

  // Wins (drop SKU matches) first, then the rest.
  orders.sort((a, b) => (isDropMatch(b) ? 1 : 0) - (isDropMatch(a) ? 1 : 0));

  const wins = orders.filter(isDropMatch).length;
  const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString() : "";
  const note = document.createElement("p");
  note.className = "hint";
  note.style.marginBottom = "10px";
  note.textContent = `${orders.length} order(s)${wins ? ` · 🏆 ${wins} match this drop` : " · no drop match"}${ts ? " · " + ts : ""}.`;
  display.appendChild(note);

  orders.forEach(o => display.appendChild(buildOrderCard(o)));
}

// ── Cross-profile order polling ───────────────────────────────
// Orders are scraped inside each account's OWN Chrome profile and written to
// the shared on-disk orders file via the native host. The dashboard (a
// different profile) reads them back here. We poll because there's no
// storage.onChanged signal across profiles.
let ordersPollTimer = null;

async function fetchOrdersForProfile(profileDir) {
  if (!profileDir) return null;
  // Prefer the shared host file (works cross-profile); fall back to local
  // storage (covers the case where the dashboard IS the account's profile).
  const resp = await hostSend({ cmd: "getOrders" });
  if (resp && resp.ok && resp.orders && resp.orders[profileDir]) {
    return resp.orders[profileDir];
  }
  const data = await chrome.storage.local.get(ORDERS_KEY);
  return data[ORDERS_KEY]?.[profileDir] || null;
}

async function loadAndRenderOrders(profileDir) {
  if (!profileDir) return;
  const entry = await fetchOrdersForProfile(profileDir);
  if (entry) renderOrders(profileDir, entry);
}

function startOrdersPolling() {
  stopOrdersPolling();
  ordersPollTimer = setInterval(() => {
    const sel = $("orderCheckerProfile");
    if (sel && sel.value) loadAndRenderOrders(sel.value);
  }, 2500);
}

function stopOrdersPolling() {
  if (ordersPollTimer) { clearInterval(ordersPollTimer); ordersPollTimer = null; }
}

// Step-by-step health check so the user can SEE where cross-profile order
// reading breaks: native host reachable? shared file written? which profiles
// have data?
async function diagnoseOrderChecker() {
  const box = $("ordersDiag");
  if (!box) return;
  box.style.display = "block";
  const lines = [];
  const stamp = new Date().toLocaleTimeString();
  lines.push(`Order Checker diagnostic — ${stamp}`);
  lines.push("");

  // 1. Native host reachable?
  const ping = await hostSend({ cmd: "ping" });
  if (ping && ping.ok) {
    lines.push("✅ Native host CONNECTED");
    lines.push(`   version: ${ping.version || "?"}   chrome: ${ping.chrome || "not found"}`);
    lines.push(`   config:  ${ping.configPath || "?"}`);
    if (ping.extensionDir) lines.push(`   ext dir: ${ping.extensionDir}`);
  } else {
    lines.push("❌ Native host NOT CONNECTED");
    lines.push(`   ${ping && ping.error ? ping.error : "no response"}`);
    lines.push("   → Cross-profile orders CANNOT work without the host.");
    lines.push("   → Reinstall: native-host/install-unix.sh (mac/linux)");
    lines.push("              or native-host/install-windows.bat (windows)");
    box.textContent = lines.join("\n");
    return;
  }

  // 2. Shared orders file — what's in it?
  lines.push("");
  const ord = await hostSend({ cmd: "getOrders" });
  if (ord && ord.ok) {
    const map = ord.orders || {};
    const keys = Object.keys(map);
    if (!keys.length) {
      lines.push("⚠️  Shared orders file is EMPTY.");
      lines.push("   No account has scraped + written orders yet.");
      lines.push("   → This means the account profile's browser hasn't opened");
      lines.push("     the orders page with the UPDATED extension code.");
      lines.push("   → Fully QUIT Chrome (all profiles), reopen, then click");
      lines.push("     'Open Orders Page' — it relaunches the profile fresh.");
    } else {
      lines.push(`✅ Shared orders file has ${keys.length} profile(s):`);
      keys.forEach(k => {
        const e = map[k] || {};
        const dom = Array.isArray(e.domOrders) ? e.domOrders.length : 0;
        const api = Array.isArray(e.apiPayloads) ? e.apiPayloads.length : 0;
        const when = e.ts ? new Date(e.ts).toLocaleTimeString() : "?";
        lines.push(`   • ${k}: ${dom} scraped, ${api} api payload(s)  (${when})`);
      });
    }
  } else {
    lines.push("❌ getOrders failed — host is too OLD (no getOrders command).");
    lines.push(`   ${ord && ord.error ? ord.error : ""}`);
    lines.push("   → git pull, then reinstall the native host.");
  }

  // 3. Selected account status
  lines.push("");
  const sel = $("orderCheckerProfile");
  const pd = sel && sel.value;
  if (pd) {
    lines.push(`Selected account profileDir: "${pd}"`);
    const entry = await fetchOrdersForProfile(pd);
    if (entry) {
      const dom = Array.isArray(entry.domOrders) ? entry.domOrders.length : 0;
      lines.push(`   → ${dom} scraped order(s) available for this account.`);
    } else {
      lines.push("   → No data for this account yet. Click 'Open Orders Page'");
      lines.push("     and confirm a Chrome window for THIS account opens.");
    }
  } else {
    lines.push("⚠️  No account selected in the dropdown.");
  }

  box.textContent = lines.join("\n");
}

async function openOrdersPage() {
  const sel     = $("orderCheckerProfile");
  const profileDir = sel && sel.value;
  if (!profileDir) {
    flashTemp($("orderCheckerMsg"), "Pick an account first.", "#fa5400"); return;
  }

  flash($("orderCheckerMsg"), "Opening orders page…", "#888");

  // Scrape any orders tabs already open in THIS Chrome profile. This handles
  // the case where the user manually navigated to the orders page — those tabs
  // load without the #snkrsOrderCheck hash so profileDir was unknown. We now
  // tell them which profile to attribute the data to.
  let foundOpenTab = false;
  try {
    const existingTabs = await chrome.tabs.query({
      url: ["*://www.nike.com/*orders*", "*://nike.com/*orders*"]
    });
    for (const tab of existingTabs) {
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: "scrapeOrdersNow", profileDir });
        if (res && res.ok) {
          foundOpenTab = true;
          // Data is flowing through background → shared file; poll will pick it up.
        }
      } catch { /* tab may not have the content script yet — ignore */ }
    }
  } catch {}

  // Always also launch the account's own Chrome profile via native host so
  // the correct account's orders page opens (the existing tab above might
  // belong to a different Nike account logged in here).
  const url = `https://www.nike.com/sg/orders/#snkrsOrderCheck=${encodeURIComponent(profileDir)}`;
  const resp = await hostSend({ cmd: "launch", profileDir, url });

  if (foundOpenTab && (resp.ok || resp.hostMissing)) {
    flashTemp($("orderCheckerMsg"), "Orders loading from open tab — also launching profile window…", "#1db954", 8000);
  } else if (resp.ok) {
    flashTemp($("orderCheckerMsg"), `Opened "${profileDir}" — orders will appear here once the page loads.`, "#1db954", 8000);
  } else if (resp.hostMissing) {
    if (foundOpenTab) {
      flashTemp($("orderCheckerMsg"), "Launcher offline — reading from open tab instead.", "#888", 6000);
    } else {
      flashTemp($("orderCheckerMsg"), "Launcher offline — open the orders page manually in that profile, then click here again.", "#fa5400", 8000);
    }
  } else {
    flashTemp($("orderCheckerMsg"), "Launch failed: " + resp.error, "#e03131", 5000);
  }

  // Kick the poll immediately so results appear as soon as data is written.
  setTimeout(() => loadAndRenderOrders(profileDir), 1500);
}

// ── Drop countdown timer ──────────────────────────────────────
function startCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  function tick() {
    const el = $("dropCountdown");
    if (!el) return;
    const v = $("dropTime") && $("dropTime").value;
    if (!v) { el.style.display = "none"; return; }
    const target = new Date(v).getTime();
    if (isNaN(target)) { el.style.display = "none"; return; }
    el.style.display = "";
    const diff = target - Date.now();
    if (diff <= 0) {
      el.className = "drop-countdown passed";
      el.textContent = "DROP TIME HAS PASSED";
      return;
    }
    el.className = "drop-countdown";
    const s = Math.floor(diff / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sc = s % 60;
    const p = n => String(n).padStart(2, "0");
    el.textContent = d > 0 ? `${d}d ${p(h)}:${p(m)}:${p(sc)}` : `${p(h)}:${p(m)}:${p(sc)}`;
  }
  tick();
  countdownTimer = setInterval(tick, 1000);
}

// ── Config export / import ────────────────────────────────────
function exportConfig() {
  const json = JSON.stringify(buildConfig(), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `snkrs-config-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importConfig(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const config = JSON.parse(e.target.result);
      applyConfigToUI(config);
      await persistCardProfiles();
      renderCardProfiles();
      renderAccounts();
      renderDropUI();
      startCountdown();
      await saveAll(false);
      flashTemp($("statusMsg"), "✓ Config imported and saved.", "#1db954");
    } catch (err) {
      flashTemp($("statusMsg"), "Import failed: " + err.message, "#e03131", 5000);
    }
  };
  reader.readAsText(file);
}

// ── Drop history log ──────────────────────────────────────────
async function appendHistory(config) {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  const history = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
  const launched = (config.accounts || []).filter(a => a.profileDir && a.size);
  const entry = {
    id: uid(),
    date: Date.now(),
    multiProduct: !!config.multiProduct,
    url: config.drop?.url || "",
    keyword: config.drop?.keyword || "",
    products: (config.products || []).map(p => ({ url: p.url, keyword: p.keyword })),
    accounts: launched.map(a => ({
      label: a.label || a.profileDir,
      profileDir: a.profileDir,
      size: a.size,
      url: a.url || "",
    })),
    results: {},
  };
  currentRunId = entry.id;
  history.unshift(entry);
  if (history.length > 20) history.length = 20;
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
  renderHistory(history);
}

async function updateHistoryResult(profileDir, code) {
  if (!currentRunId) return;
  const data = await chrome.storage.local.get(HISTORY_KEY);
  const history = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
  const entry = history.find(e => e.id === currentRunId);
  if (!entry) return;
  entry.results[profileDir] = code;
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
}

async function loadHistory() {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  renderHistory(Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : []);
}

function renderHistory(history) {
  const list = $("historyList");
  if (!list) return;
  list.innerHTML = "";
  if (!history || !history.length) {
    list.appendChild(el("p", { className: "hint" }, "No drops launched yet. History appears here after each run."));
    return;
  }
  history.forEach(entry => list.appendChild(buildHistoryEntry(entry)));
}

function buildHistoryEntry(entry) {
  const div = document.createElement("div");
  div.className = "history-entry";

  const date = new Date(entry.date);
  const pad = n => String(n).padStart(2, "0");
  const dateStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
                + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());

  const dateEl = document.createElement("div");
  dateEl.className = "history-date";
  dateEl.textContent = dateStr;

  const urlEl = document.createElement("div");
  urlEl.className = "history-url";
  if (entry.multiProduct && entry.products?.length) {
    urlEl.textContent = `${entry.products.length} products · ${entry.accounts.length} accounts`;
  } else {
    urlEl.textContent = (entry.keyword ? entry.keyword + " · " : "") + (shortUrl(entry.url) || "—");
    urlEl.title = entry.url || "";
  }

  const resultsDiv = document.createElement("div");
  resultsDiv.className = "history-results";
  const r = entry.results || {};
  const total   = entry.accounts?.length || 0;
  const wins    = Object.values(r).filter(v => v === "win").length;
  const losses  = Object.values(r).filter(v => v === "loss").length;
  const entered = Object.values(r).filter(v => v === "entered").length;
  const limits  = Object.values(r).filter(v => v === "limit").length;

  const chip = (text, color) => {
    const s = document.createElement("span");
    s.className = "history-chip";
    s.style.color = color;
    s.textContent = text;
    resultsDiv.appendChild(s);
  };
  chip(`${total} accounts`, "#888");
  if (wins)    chip(`🏆 ${wins} won`, "#1db954");
  if (losses)  chip(`😔 ${losses} lost`, "#e03131");
  if (entered) chip(`✓ ${entered} entered`, "#4a90e2");
  if (limits)  chip(`⚠ ${limits} limit`, "#fa5400");

  div.append(dateEl, urlEl, resultsDiv);
  return div;
}

// ── Native host helper (extension pages can call this directly) ─
function hostSend(payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, payload, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message, hostMissing: true });
          return;
        }
        resolve(resp || { ok: false, error: "Empty response from launcher." });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message || e), hostMissing: true });
    }
  });
}

// ── Small DOM helpers ─────────────────────────────────────────
const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, text) {
  const n = document.createElement(tag);
  Object.assign(n, attrs);
  if (text != null) n.textContent = text;
  return n;
}
function uid() { return "a" + Math.random().toString(36).slice(2, 9); }

function flash(node, msg, color) {
  if (!node) return;
  node.style.color = color || "#1db954";
  node.textContent = msg;
}
function flashTemp(node, msg, color, ms = 3000) {
  flash(node, msg, color);
  setTimeout(() => { if (node) node.textContent = ""; }, ms);
}

// ── Card field formatters (shared with per-account cards) ──────
function attachCardFormatters(numberEl, expiryEl, cvvEl) {
  if (numberEl) numberEl.addEventListener("input", () => {
    let v = numberEl.value.replace(/\D/g, "").slice(0, 16);
    numberEl.value = v.replace(/(.{4})/g, "$1 ").trim();
  });
  if (expiryEl) expiryEl.addEventListener("input", () => {
    let v = expiryEl.value.replace(/\D/g, "").slice(0, 4);
    if (v.length >= 3) v = v.slice(0, 2) + "/" + v.slice(2);
    expiryEl.value = v;
  });
  if (cvvEl) cvvEl.addEventListener("input", () => {
    cvvEl.value = cvvEl.value.replace(/\D/g, "").slice(0, 4);
  });
}

// ── Size <select> builder ─────────────────────────────────────
function fillSizeSelect(sel, size, sizeType) {
  sel.innerHTML = "";
  sel.appendChild(el("option", { value: "" }, "— pick size —"));
  const g1 = el("optgroup", { label: "Footwear (US M)" });
  FOOTWEAR_SIZES.forEach(s => g1.appendChild(el("option", { value: "footwear:" + s }, "US " + s)));
  sel.appendChild(g1);
  const g2 = el("optgroup", { label: "Apparel" });
  APPAREL_SIZES.forEach(s => g2.appendChild(el("option", { value: "apparel:" + s }, s)));
  sel.appendChild(g2);
  sel.value = size ? `${sizeType || "footwear"}:${size}` : "";
}
function parseSizeValue(v) {
  if (!v) return { size: "", sizeType: "footwear" };
  const [type, size] = v.split(":");
  return { size: size || "", sizeType: type || "footwear" };
}

// ── Profile <select> builder ──────────────────────────────────
function fillProfileSelect(sel, manualInput, current) {
  sel.innerHTML = "";
  sel.appendChild(el("option", { value: "" }, discoveredProfiles.length ? "— pick profile —" : "— no profiles found —"));
  discoveredProfiles.forEach(p => {
    sel.appendChild(el("option", { value: p.dir }, `${p.name}  ·  ${p.dir}`));
  });
  sel.appendChild(el("option", { value: "__manual__" }, "Type directory manually…"));

  const known = discoveredProfiles.some(p => p.dir === current);
  if (current && !known) {
    sel.value = "__manual__";
    manualInput.style.display = "";
    manualInput.value = current;
  } else {
    sel.value = current || "";
    manualInput.style.display = "none";
  }
}

// ── Render the accounts list ──────────────────────────────────
function renderAccounts() {
  statusElMap.clear(); // rebuild per render
  const list = $("accountsList");
  list.innerHTML = "";
  if (!accounts.length) {
    list.appendChild(el("p", { className: "hint" }, "No accounts yet — add one to get started."));
  }
  accounts.forEach((acct) => list.appendChild(buildAccountRow(acct)));
  updateProfileSourceNote();
  refreshOrderCheckerProfiles();
}

function buildAccountRow(acct) {
  const tpl = $("accountRowTpl").content.cloneNode(true);
  const row = tpl.querySelector(".acct");

  const labelEl     = row.querySelector(".f-label");
  const profileEl   = row.querySelector(".f-profile");
  const manualEl    = row.querySelector(".f-profile-manual");
  const sizeEl      = row.querySelector(".f-size");
  const autoEl      = row.querySelector(".f-autolaunch");
  const cardSel     = row.querySelector(".f-card-select");
  const msgEl       = row.querySelector(".acct-msg");
  const assignedEl  = row.querySelector(".f-assigned");
  const statusRow   = row.querySelector(".f-status-row");
  const statusBadge = row.querySelector(".f-status-badge");
  const statusText  = row.querySelector(".f-status-text");
  const statusTime  = row.querySelector(".f-status-time");

  labelEl.value = acct.label || "";
  autoEl.checked = !!acct.autoLaunch;
  fillSizeSelect(sizeEl, acct.size, acct.sizeType);
  fillProfileSelect(profileEl, manualEl, acct.profileDir);

  cardSel.dataset.acctId = acct.id;
  fillCardSelect(cardSel, acct.cardId);

  // Show which product this account is assigned to (multi-product mode), and a
  // ⚡ marker when a direct checkout URL is ready (skips the size screen).
  const directTag = acct.checkoutUrl ? "⚡ direct checkout" : "";
  if (multiProduct && acct.url) {
    assignedEl.style.display = "";
    assignedEl.textContent = `→ ${acct.keyword ? acct.keyword + " · " : ""}${shortUrl(acct.url)}` +
      (directTag ? `  ·  ${directTag}` : "");
  } else if (directTag) {
    assignedEl.style.display = "";
    assignedEl.textContent = directTag;
  } else {
    assignedEl.style.display = "none";
  }

  // Register for live status updates
  statusRow.classList.add("hidden");
  const registerStatus = (dir) => {
    if (!dir) return;
    statusElMap.set(dir, { rowEl: statusRow, badgeEl: statusBadge, textEl: statusText, timeEl: statusTime });
    updateStatusBadge(dir);
  };
  registerStatus(acct.profileDir);

  // ── Wire field → state ──
  labelEl.addEventListener("input", () => { acct.label = labelEl.value.trim(); });
  sizeEl.addEventListener("change", () => {
    const { size, sizeType } = parseSizeValue(sizeEl.value);
    acct.size = size; acct.sizeType = sizeType;
    // The direct checkout URL is size-specific — a manual size change makes it
    // stale, so drop it (re-run ⚡ DIRECT URLS to rebuild).
    if (acct.checkoutUrl) { acct.checkoutUrl = ""; renderAccounts(); }
  });
  profileEl.addEventListener("change", () => {
    if (profileEl.value === "__manual__") {
      manualEl.style.display = "";
      acct.profileDir = manualEl.value.trim();
    } else {
      manualEl.style.display = "none";
      acct.profileDir = profileEl.value;
    }
    registerStatus(acct.profileDir);
  });
  manualEl.addEventListener("input", () => {
    acct.profileDir = manualEl.value.trim();
    registerStatus(acct.profileDir);
  });

  autoEl.addEventListener("change", () => {
    acct.autoLaunch = autoEl.checked;
    saveAll(true); // re-arm the alarm immediately so ⏰ state is always in sync
  });
  cardSel.addEventListener("change", () => {
    if (cardSel.value === "__new__") {
      // Jump to the card-profile form to create a new card.
      cardSel.value = acct.cardId || "";
      $("cpName").focus();
      $("cardForm").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    acct.cardId = cardSel.value;
    renderCardProfiles(); // refresh "used by N" counts
  });

  // ── Buttons ──
  row.querySelector(".f-remove").addEventListener("click", () => {
    accounts = accounts.filter(a => a.id !== acct.id);
    renderAccounts();
  });
  row.querySelector(".f-launch").addEventListener("click", () => launchAccount(acct, msgEl));
  row.querySelector(".f-copycmd").addEventListener("click", () => copyLaunchCommand(acct, msgEl));

  return row;
}

function updateProfileSourceNote() {
  const note = $("profileSourceNote");
  if (!note) return;
  if (hostOk && discoveredProfiles.length) {
    note.textContent = `Found ${discoveredProfiles.length} Chrome profiles on this machine.`;
    note.style.color = "#1db954";
  } else if (hostOk) {
    note.textContent = "Launcher connected, but no profiles detected — type the directory manually.";
    note.style.color = "#f0c070";
  } else {
    note.textContent = "Launcher offline — type each profile directory manually for now.";
    note.style.color = "#8d8d8d";
  }
}

// ── Build config object from the UI ───────────────────────────
function scheduleIsEnabled() { return !!($("scheduleEnabled") && $("scheduleEnabled").checked); }

// The DROP TIME field value as ISO — ALWAYS, regardless of the auto-open toggle.
// This is the moment accounts submit; it's carried on every launch (manual too).
function dropTimeFieldISO() {
  const v = $("dropTime") && $("dropTime").value;
  if (!v) return "";
  const d = new Date(v);
  return isNaN(d.getTime()) ? "" : d.toISOString();
}
// Only returns a time when AUTO-OPEN is enabled — used to arm the auto-open alarm.
function dropTimeISO() {
  return scheduleIsEnabled() ? dropTimeFieldISO() : "";
}

// Set the DROP TIME field from an ISO string (converts to the datetime-local
// format the input expects, in local time).
function setDropTimeField(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  const p = n => String(n).padStart(2, "0");
  const local = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  if ($("dropTime")) { $("dropTime").value = local; startCountdown(); }
  return true;
}

function buildConfig() {
  return {
    drop: {
      url: $("dropUrl").value.trim(),
      keyword: $("dropKeyword").value.trim(),
      // Submit-gate time — always the field value (persists even with auto-open off).
      dropTimeISO: dropTimeFieldISO(),
      // Whether to ALSO auto-open accounts before the drop (the ⏰ toggle).
      autoOpen: scheduleIsEnabled(),
      scheduleEnabled: scheduleIsEnabled(),
      sizePool: singleSizePool.slice(),
    },
    multiProduct,
    products: products.map(p => ({
      id: p.id,
      url: (p.url || "").trim(),
      keyword: (p.keyword || "").trim(),
      sizePool: (p.sizePool || []).slice(),
    })),
    card: {},               // no global card — each account picks a card profile
    cardProfiles: cardProfiles.map(c => ({ ...c })),
    options: {
      enabled: $("optEnabled").checked,
      testMode: $("optTestMode").checked,
      statusPollerEnabled: $("optPoller").checked,
      pollerIntervalMin: parseInt($("optPollerMin").value) || 3,
      logWebhook: $("logWebhook").value.trim(),
      alertWebhook: $("alertWebhook").value.trim(),
    },
    accounts: accounts.map(a => ({
      id: a.id,
      label: a.label || "",
      profileDir: a.profileDir || "",
      size: a.size || "",
      sizeType: a.sizeType || "footwear",
      url: a.url || "",
      keyword: a.keyword || "",
      checkoutUrl: a.checkoutUrl || "",   // pre-built direct checkout URL (may be "")
      dropAtMs: a.dropAtMs || 0,          // this account's product drop time (ms)
      autoLaunch: !!a.autoLaunch,
      cardId: a.cardId || "",
      card: resolveCard(a.cardId),   // resolved card object the bot fills
    })),
  };
}

// ── Persist: local mirror + shared config file via host ───────
async function saveAll(silent) {
  const config = buildConfig();
  await chrome.storage.local.set({ [DASH_KEY]: config });

  // Arm (or disarm) the background auto-launch alarm
  const armResp = await new Promise(res => chrome.runtime.sendMessage({ type: "arm_drop_launch", config }, res));
  updateScheduleStatus(armResp);

  const resp = await hostSend({ cmd: "setConfig", config });
  if (!silent) {
    if (resp.ok) {
      flashTemp($("statusMsg"), `✓ Saved. Shared config written to ${resp.configPath || "~/.snkrs-bot/config.json"}.`);
    } else if (resp.hostMissing) {
      flashTemp($("statusMsg"), "✓ Saved locally. (Launcher offline — shared file not written yet.)", "#f0c070", 4000);
    } else {
      flashTemp($("statusMsg"), "Saved locally, but launcher error: " + resp.error, "#f0c070", 4000);
    }
  }
  return config;
}

function updateScheduleStatus(armResp) {
  // ── DROP page inline status ──
  const el = $("scheduleStatus");
  if (el) {
    if (!armResp || !scheduleIsEnabled()) {
      el.style.display = "none";
    } else if (armResp.armed) {
      const d = new Date(armResp.when);
      const hm = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
      const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      el.className = "schedule-status armed";
      el.style.display = "";
      el.textContent = `⏰ Scheduled — ${armResp.count} account(s) will auto-open on ${date} at ${hm}`;
    } else if (armResp.reason === "time already passed — launching now") {
      el.className = "schedule-status armed";
      el.style.display = "";
      el.textContent = "⏰ Time already passed — launching now…";
    } else if (armResp.reason === "drop time already passed — not auto-opening") {
      el.className = "schedule-status disarmed";
      el.style.display = "";
      el.textContent = "⏰ Drop time has passed — accounts will NOT auto-open. Set a new time to re-arm.";
    } else {
      el.className = "schedule-status disarmed";
      el.style.display = "";
      el.textContent = armResp.reason
        ? `Not scheduled (${armResp.reason})`
        : "Not scheduled — set a time and toggle ⏰ auto on at least one account to arm.";
    }
  }

  // ── PROFILES page banner ──
  const banner = $("acctSchedBanner");
  if (!banner) return;
  if (!armResp) { banner.style.display = "none"; return; }

  if (armResp.armed) {
    const d   = new Date(armResp.when);
    const hm  = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
    const date = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    banner.className  = "sched-banner armed";
    banner.style.display = "flex";
    banner.innerHTML  = `<span class="sched-banner-dot"></span>` +
      `<span>⏰ SCHEDULER ARMED &mdash; <strong>${armResp.count} account(s)</strong> will auto-open on <strong>${date} at ${hm}</strong></span>`;
  } else if (armResp.reason === "time already passed — launching now") {
    banner.className  = "sched-banner armed";
    banner.style.display = "flex";
    banner.innerHTML  = `<span class="sched-banner-dot"></span><span>⏰ Time reached &mdash; launching now…</span>`;
  } else if (armResp.reason === "drop time already passed — not auto-opening") {
    banner.className  = "sched-banner disarmed";
    banner.style.display = "flex";
    banner.innerHTML  = `<span class="sched-banner-dot"></span>` +
      `<span>⏰ Drop time has passed &mdash; accounts will <strong>not</strong> auto-open. Set a new time to re-arm.</span>`;
  } else {
    // Only show disarmed hint if scheduler toggle is on (user is actively configuring it)
    if (scheduleIsEnabled()) {
      banner.className  = "sched-banner disarmed";
      banner.style.display = "flex";
      const reason = armResp.reason || "enable schedule and toggle ⏰ on at least one account";
      banner.innerHTML = `<span class="sched-banner-dot"></span><span>Not armed — ${reason}</span>`;
    } else {
      banner.style.display = "none";
    }
  }
}

// ── Direct checkout URLs (skip launch page + size selection) ──
// Marketplace for the direct checkout path. (SNKRS SG.)
const DIRECT_COUNTRY = "SG";
let launchCache = {}; // sku -> resolved launch data (per assign run)

// The SKU that applies to an account: its own in multi-product mode, else the
// central Drop SKU/keyword field.
function skuForAccount(acct) {
  const s = (multiProduct && acct.keyword) ? acct.keyword : ($("dropKeyword").value || "");
  return s.trim().toUpperCase();
}

function buildDirectCheckoutUrl(d, skuId) {
  const cid = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : (Date.now() + "-" + Math.random().toString(16).slice(2));
  const cc = (d.country || "SG").toLowerCase();
  // Matches Nike's real checkout link exactly (returnUrl is URL-encoded).
  const returnUrl = `https://www.nike.com/${cc}/launch/t/${d.slug}/`;
  return `https://gs.nike.com/?checkoutId=${cid}` +
         `&launchId=${encodeURIComponent(d.launchId)}` +
         `&skuId=${encodeURIComponent(skuId)}` +
         `&country=${d.country}&locale=${d.language}` +
         `&appId=com.nike.commerce.snkrs.web` +
         `&returnUrl=${encodeURIComponent(returnUrl)}`;
}

async function resolveLaunch(sku) {
  if (launchCache[sku]) return launchCache[sku];
  const d = await new Promise(res =>
    chrome.runtime.sendMessage({ type: "resolve_launch", sku, country: DIRECT_COUNTRY }, res));
  if (d && d.ok) launchCache[sku] = d;
  return d;
}

// Look up the drop/release time from Nike for the current SKU and fill the
// DROP TIME field, so SUBMIT fires exactly when the website says.
async function fetchDropTimeFromNike() {
  const msg = $("dropTimeMsg");
  const sku = ($("dropKeyword").value || "").trim().toUpperCase() ||
              (accounts.map(skuForAccount).find(Boolean) || "");
  if (!sku) { if (msg) { msg.style.color = "#fa5400"; msg.textContent = "Set the SKU first."; } return; }
  if (msg) { msg.style.color = "#888"; msg.textContent = "Fetching drop time from Nike…"; }
  let d;
  try { d = await resolveLaunch(sku); } catch (e) { d = { ok: false, error: String(e && e.message || e) }; }
  if (!d || !d.ok) { if (msg) { msg.style.color = "#fa5400"; msg.textContent = `Couldn't fetch: ${(d && d.error) || "unknown"}`; } return; }
  if (!d.dropTimeISO) { if (msg) { msg.style.color = "#fa5400"; msg.textContent = "Nike didn't return a drop time for this SKU."; } return; }
  if (setDropTimeField(d.dropTimeISO)) {
    if (msg) { msg.style.color = "var(--green)"; msg.textContent = `⏱ Drop time set: ${new Date(d.dropTimeISO).toLocaleString()}`; }
    saveAll(true);
  }
}

// Build a unique, size-specific direct checkout URL for every account that has
// a size + SKU. Accounts that can't be resolved keep an empty checkoutUrl and
// fall back to the normal launch-page + size-selection flow at launch time.
async function assignCheckoutUrls(msgEl) {
  launchCache = {};
  const eligible = accounts.filter(a => a.size && skuForAccount(a));
  if (!eligible.length) {
    if (msgEl) flashTemp(msgEl, "Assign sizes and set a SKU first to build direct URLs.", "#fa5400");
    return;
  }
  if (msgEl) flash(msgEl, "Resolving launch from Nike…", "#888");

  let ok = 0, fail = 0, notLaunch = 0; const errs = new Set();
  let nikeDropISO = "";
  for (const acct of accounts) {
    acct.checkoutUrl = "";
    acct.dropAtMs = 0;
    const sku = skuForAccount(acct);
    if (!acct.size || !sku) continue;
    let d;
    try { d = await resolveLaunch(sku); } catch (e) { d = { ok: false, error: String(e && e.message || e) }; }
    if (!d || !d.ok) {
      fail++;
      const er = (d && d.error) || "";
      if (er) errs.add(er);
      if (/not an upcoming launch/i.test(er)) notLaunch++;
      continue;
    }
    if (d.dropTimeISO && !nikeDropISO) nikeDropISO = d.dropTimeISO;
    // Per-account drop time (each product in a multi-product drop can differ).
    if (d.dropTimeISO) { const t = Date.parse(d.dropTimeISO); if (!isNaN(t)) acct.dropAtMs = t; }
    const match = (d.skus || []).find(s => String(s.nikeSize) === String(acct.size));
    if (!match) { fail++; errs.add(`size ${acct.size} not offered for ${sku}`); continue; }
    acct.checkoutUrl = buildDirectCheckoutUrl(d, match.id);
    ok++;
  }
  // Auto-fill the DROP TIME from Nike so SUBMIT fires exactly when the site says.
  if (nikeDropISO && setDropTimeField(nikeDropISO)) {
    const dtEl = $("dropTimeMsg");
    if (dtEl) { dtEl.style.color = "var(--green)"; dtEl.textContent = `⏱ Drop time set from Nike: ${new Date(nikeDropISO).toLocaleString()}`; }
  }
  renderAccounts();
  await saveAll(true);
  if (msgEl) {
    if (ok && !fail) {
      flashTemp(msgEl, `⚡ Built ${ok} direct checkout URL(s) — launches will skip the size screen.`, "#1db954", 6000);
    } else if (ok) {
      flashTemp(msgEl, `⚡ Built ${ok}; ${fail} will use the normal launch-page flow. (${[...errs][0] || ""})`, "#f0c070", 7000);
    } else if (notLaunch) {
      // Most common, non-alarming case: the product simply isn't a SNKRS draw.
      flashTemp(msgEl, `Sizes assigned ✓ — direct checkout skipped: this isn't a SNKRS draw/launch product, so accounts will use the normal launch page + size selection (works fine).`, "#f0c070", 9000);
    } else {
      flashTemp(msgEl, `Sizes assigned ✓ — couldn't build direct URLs, using launch-page fallback. (${[...errs][0] || ""})`, "#fa5400", 9000);
    }
  }
}

// ── Launch a single account into its Chrome profile ───────────
// In multi-product mode each account carries its own assigned URL; in
// single-product mode they all share the central Drop URL.
function resolvedUrl(acct) {
  return (multiProduct && acct.url) ? acct.url.trim() : $("dropUrl").value.trim();
}

function bootUrlFor(acct) {
  // Prefer the pre-built direct checkout URL (skips launch page + size pick).
  let url = (acct.checkoutUrl && acct.checkoutUrl.trim()) ? acct.checkoutUrl.trim() : "";
  const isDirect = !!url;
  if (!url) url = resolvedUrl(acct);
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const params = [`snkrsBoot=${encodeURIComponent(acct.profileDir)}`];
  // Carry the drop time so the account holds SUBMIT until go-live — on EVERY
  // launch (manual included), independent of the auto-open toggle. Prefer this
  // account's own product drop time (multi-product), else the global field.
  let t = acct.dropAtMs || 0;
  if (!t) { const iso = dropTimeFieldISO(); const p = iso ? Date.parse(iso) : NaN; if (!isNaN(p)) t = p; }
  if (t) params.push(`snkrsDrop=${t}`);
  const sep = url.includes("#") ? "&" : "#";
  return `${url}${sep}${params.join("&")}`;
}

function validateForLaunch(acct, msgEl) {
  if (!resolvedUrl(acct)) {
    flashTemp(msgEl, multiProduct
      ? "This account has no product URL — run 🎲 assign, or set one."
      : "Set the Drop URL first (left panel).", "#fa5400");
    return false;
  }
  if (!acct.profileDir) {
    flashTemp(msgEl, "Pick a Chrome profile for this account.", "#fa5400");
    return false;
  }
  if (!acct.size) {
    flashTemp(msgEl, "Pick a size for this account.", "#fa5400");
    return false;
  }
  return true;
}

async function launchAccount(acct, msgEl) {
  if (!validateForLaunch(acct, msgEl)) return;
  await saveAll(true); // make sure the shared file is current before boot
  const url = bootUrlFor(acct);
  flash(msgEl, "Opening profile…", "#888");
  const resp = await hostSend({ cmd: "launch", profileDir: acct.profileDir, url });
  if (resp.ok) {
    flashTemp(msgEl, `🚀 Launched “${acct.profileDir}”.`, "#1db954");
  } else if (resp.hostMissing) {
    flashTemp(msgEl, "Launcher offline — use ⌘ copy cmd, or install the host.", "#fa5400", 5000);
  } else {
    flashTemp(msgEl, "Launch failed: " + resp.error, "#e03131", 5000);
  }
}

// Warm-up URL for profiles that aren't fully configured — opens the SNKRS feed
// (no #snkrsBoot marker, so the bot stays idle) just to warm Kasada/cookies.
const WARMUP_URL = "https://www.nike.com/sg/launch";

async function launchAll() {
  // Launch EVERY account that has a Chrome profile — not just configured ones.
  const all = accounts.filter(a => a.profileDir);
  if (!all.length) {
    flashTemp($("statusMsg"), "No accounts have a Chrome profile set yet.", "#fa5400");
    return;
  }
  const config = await saveAll(true);
  await appendHistory(config);

  const isConfigured = (a) => a.size && resolvedUrl(a);
  const configured   = all.filter(isConfigured);
  const warmCount    = all.length - configured.length;

  flash($("statusMsg"), `Launching ${all.length} profiles…`, "#888");
  let okCount = 0, lastErr = "";
  for (const acct of all) {
    const url = isConfigured(acct) ? bootUrlFor(acct) : WARMUP_URL;
    const resp = await hostSend({ cmd: "launch", profileDir: acct.profileDir, url });
    if (resp.ok) okCount++;
    else lastErr = resp.error || "unknown";
    await new Promise(r => setTimeout(r, 400)); // stagger so Chrome keeps up
  }

  if (okCount === all.length) {
    const tail = warmCount
      ? ` ${configured.length} went to the drop; ${warmCount} opened to warm up (add their size/URL to run the bot).`
      : " All went straight to the drop.";
    flashTemp($("statusMsg"), `🚀 Launched ${okCount} profiles.${tail}`, "#1db954", 8000);
  } else if (okCount > 0) {
    flashTemp($("statusMsg"), `Launched ${okCount}/${all.length}. Last error: ${lastErr}`, "#f0c070", 6000);
  } else {
    flashTemp($("statusMsg"), `Couldn't launch. ${lastErr || "Is the launcher installed?"}`, "#e03131", 6000);
  }
}

// Fallback when the host isn't installed: copy a paste-ready command.
function copyLaunchCommand(acct, msgEl) {
  if (!acct.profileDir) { flashTemp(msgEl, "Pick a profile first.", "#fa5400"); return; }
  const url = bootUrlFor(acct) || "https://www.nike.com/sg/launch/";
  const cmd = `chrome --profile-directory="${acct.profileDir}" "${url}"`;
  navigator.clipboard.writeText(cmd).then(
    () => flashTemp(msgEl, "📋 Command copied — paste into a terminal.", "#1db954"),
    () => flashTemp(msgEl, "Copy failed.", "#e03131")
  );
}

// ── Launcher connectivity + profile discovery ─────────────────
function setHostStatus(ok, detail) {
  hostOk = ok;
  $("hostDot").className = "host-dot " + (ok ? "on" : "off");
  $("hostText").textContent = ok ? "LAUNCHER CONNECTED" : "LAUNCHER OFFLINE";
  $("hostMissingBanner").style.display = ok ? "none" : "block";
  if (detail) $("hostText").title = detail;
}

async function pingHost() {
  const resp = await hostSend({ cmd: "ping" });
  setHostStatus(!!resp.ok, resp.ok ? `v${resp.version} · ${resp.platform}` : resp.error);
  return resp.ok;
}

async function loadProfiles() {
  const resp = await hostSend({ cmd: "listProfiles" });
  if (resp.ok && Array.isArray(resp.profiles)) {
    discoveredProfiles = resp.profiles.map(p => ({ dir: p.dir, name: p.name }));
  } else {
    discoveredProfiles = [];
  }
  renderAccounts();
}

// ── Initial load ──────────────────────────────────────────────
function applyConfigToUI(cfg) {
  if (!cfg) return;
  const drop = cfg.drop || {}, opts = cfg.options || {};
  $("dropUrl").value = drop.url || "";
  $("dropKeyword").value = drop.keyword || "";
  // Auto-open toggle (schedulePanel is now the toggle row itself — always visible).
  $("scheduleEnabled").checked = !!(drop.autoOpen ?? drop.scheduleEnabled);
  if (drop.dropTimeISO) {
    const d = new Date(drop.dropTimeISO);
    if (!isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, "0");
      $("dropTime").value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
  }
  // Card profiles (only replace from config if it actually carries them,
  // e.g. on import — otherwise keep what we loaded from storage).
  if (Array.isArray(cfg.cardProfiles)) {
    cardProfiles = cfg.cardProfiles.map(c => ({
      id: c.id || uid(),
      name: c.name || "Card",
      cardName: c.cardName || "",
      cardNumber: c.cardNumber || "",
      cardExpiry: c.cardExpiry || "",
      cardCvv: c.cardCvv || "",
    }));
  }

  $("optEnabled").checked = opts.enabled ?? true;
  $("optTestMode").checked = opts.testMode ?? false;
  $("optPoller").checked = opts.statusPollerEnabled ?? true;
  $("optPollerMin").value = opts.pollerIntervalMin ?? 3;
  $("logWebhook").value = opts.logWebhook || "";
  $("alertWebhook").value = opts.alertWebhook || "";

  singleSizePool = Array.isArray(drop.sizePool) ? drop.sizePool.slice() : [];
  multiProduct = !!cfg.multiProduct;
  products = Array.isArray(cfg.products) ? cfg.products.map(p => ({
    id: p.id || uid(),
    url: p.url || "",
    keyword: p.keyword || "",
    sizePool: Array.isArray(p.sizePool) ? p.sizePool.slice() : [],
  })) : [];

  accounts = (Array.isArray(cfg.accounts) ? cfg.accounts : []).map(a => ({
    id: a.id || uid(),
    label: a.label || "",
    profileDir: a.profileDir || "",
    size: a.size || "",
    sizeType: a.sizeType || "footwear",
    url: a.url || "",
    keyword: a.keyword || "",
    checkoutUrl: a.checkoutUrl || "",
    dropAtMs: a.dropAtMs || 0,
    autoLaunch: !!a.autoLaunch,
    cardId: a.cardId || "",
  }));
}

// ── License gate ──────────────────────────────────────────────
const LICENSE_STORE = "snkrsLicense";

async function _getRevokedIds(cfg) {
  // Merge: license.json list + locally revoked list + optional live URL
  const local = await chrome.storage.local.get(["snkrsRevoked"]);
  const ids   = new Set([...(cfg.revokedIds || []), ...(local.snkrsRevoked || [])]);
  if (cfg.revocationUrl) {
    try {
      const r   = await fetch(cfg.revocationUrl, { cache: "no-store" });
      const obj = await r.json();
      (obj.revokedIds || []).forEach(id => ids.add(id));
    } catch {}
  }
  return [...ids];
}

// Returns { allowed: bool, reason: string }
async function checkLicense() {
  const cfg = await getLicenseConfig();
  if (!cfg.pubKey) return { allowed: true, reason: "no-gate" }; // license system not configured

  const stored = await chrome.storage.local.get(LICENSE_STORE);
  const ks     = stored[LICENSE_STORE];
  if (!ks) return { allowed: false, reason: "no-key" };

  const revoked = await _getRevokedIds(cfg);
  const result  = await verifyLicenseKey(ks, cfg.pubKey, revoked);
  if (!result.ok) {
    await chrome.storage.local.remove(LICENSE_STORE); // clear bad key
    return { allowed: false, reason: result.err };
  }
  return { allowed: true, reason: "ok", payload: result.payload };
}

async function activateLicense(ks) {
  const cfg     = await getLicenseConfig();
  if (!cfg.pubKey) return { ok: false, err: "License system not configured (no public key)." };
  const revoked = await _getRevokedIds(cfg);
  const result  = await verifyLicenseKey(ks.trim(), cfg.pubKey, revoked);
  if (!result.ok) return result;
  await chrome.storage.local.set({ [LICENSE_STORE]: ks.trim() });
  return result;
}

document.addEventListener("DOMContentLoaded", async () => {
  // ── License check — must pass before showing dashboard ──
  const licCheck = await checkLicense();
  if (!licCheck.allowed) {
    $("licenseGate").style.display = "flex";
    // Show reason if there was a bad/expired key
    if (licCheck.reason && licCheck.reason !== "no-key") {
      const msg = $("licenseMsg");
      if (msg) { msg.style.color = "#e03131"; msg.textContent = licCheck.reason; }
    }
    const flashActivate = (msg, color) => { const n = $("licenseMsg"); if (n) { n.style.color = color || "#1db954"; n.textContent = msg; } };
  $("activateBtn").addEventListener("click", async () => {
      const ks = $("licenseKeyInput").value.trim();
      if (!ks) { flashActivate("Enter your license key.", "#fa5400"); return; }
      $("activateBtn").disabled = true;
      flashActivate("Validating…", "#888");
      const result = await activateLicense(ks);
      if (result.ok) {
        flashActivate(`✓ Activated for ${result.payload.user || "user"}. Loading…`, "#1db954");
        setTimeout(() => location.reload(), 800);
      } else {
        flashActivate(result.err || "Invalid key.", "#e03131");
        $("activateBtn").disabled = false;
      }
    });
    return; // stop dashboard init until licensed
  }

  // Show admin link if admin keys are set up on this machine
  chrome.storage.local.get("snkrsAdminPubKey", (d) => {
    if (d.snkrsAdminPubKey && $("adminLink")) $("adminLink").style.display = "";
  });

  attachCardFormatters($("cpNumber"), $("cpExpiry"), $("cpCvv"));

  // 1) Load live status snapshots, history, and card profiles.
  await loadHistory();
  await loadCardProfiles();
  const storedStatus = await chrome.storage.local.get(STATUS_KEY);
  liveStatuses = storedStatus[STATUS_KEY] || {};

  // Cross-profile live status: launched accounts live in OTHER Chrome profiles,
  // so their status arrives via the shared status.json (through the host), not
  // this profile's chrome.storage. Poll it so the board shows every account's
  // live checkout step in near-real-time.
  startStatusPolling();

  // 2) Load the local mirror first (instant UI even if host is offline).
  const local = await chrome.storage.local.get(DASH_KEY);
  if (local[DASH_KEY]) applyConfigToUI(local[DASH_KEY]);

  // 3) Probe the launcher; if connected, pull profiles and (if we had no
  //    local state) import the shared config file.
  const ok = await pingHost();
  if (ok) {
    if (!local[DASH_KEY]) {
      const cfgResp = await hostSend({ cmd: "getConfig" });
      if (cfgResp.ok && cfgResp.config) applyConfigToUI(cfgResp.config);
    }
    await loadProfiles();
  }

  if (!accounts.length) accounts = [{ id: uid(), label: "", profileDir: "", size: "", sizeType: "footwear", cardId: "" }];
  renderCardProfiles();
  renderAccounts();
  renderDropUI();
  startCountdown();
  suggestProfileName();

  // Refresh the schedule banner from current in-memory state without re-arming
  // (just peeks at the existing alarm status so the banner shows on dashboard open).
  chrome.runtime.sendMessage({ type: "arm_drop_launch", config: buildConfig() }, updateScheduleStatus);

  // ── Card profiles ──
  $("cpSaveBtn").addEventListener("click", saveCardProfile);
  $("cpCancelBtn").addEventListener("click", resetCardForm);

  // ── Page navigation ──
  document.querySelectorAll(".nav-tab").forEach(tab => {
    tab.addEventListener("click", () => navigateTo(tab.dataset.nav));
  });
  renderHomeStats();

  // ── Getting Started guide (collapsible, lives on HOME page) ──
  const _guideToggle = $("guideToggle");
  if (_guideToggle) {
    _guideToggle.addEventListener("click", () => {
      const body = $("guideBody");
      const open = body && body.style.display !== "none";
      if (body) body.style.display = open ? "none" : "";
      _guideToggle.textContent = open ? "SHOW" : "HIDE";
    });
  }

  // ── Setup link → navigate to settings ──
  const sl = $("setupLink");
  if (sl) sl.addEventListener("click", e => { e.preventDefault(); navigateTo("settings"); });

  // ── Chrome Profile Creator ──
  $("createProfileBtn").addEventListener("click", createProfile);

  // ── Buttons ──
  $("addAccountBtn").addEventListener("click", () => {
    accounts.push({ id: uid(), label: "", profileDir: "", size: "", sizeType: "footwear", cardId: "" });
    renderAccounts();
  });

  // ── ARM ALL / UNARM ALL ──
  $("armAllBtn").addEventListener("click", () => {
    accounts.forEach(a => { a.autoLaunch = true; });
    renderAccounts();
    saveAll(true).then(cfg => flashTemp($("statusMsg"),
      `⏰ Armed ${accounts.length} account(s) — save confirms the scheduler.`, "#1db954", 4000));
  });
  $("unarmAllBtn").addEventListener("click", () => {
    accounts.forEach(a => { a.autoLaunch = false; });
    renderAccounts();
    saveAll(true).then(() => flashTemp($("statusMsg"), "Unarm All — scheduler cleared.", "#888", 3000));
  });
  $("scheduleEnabled").addEventListener("change", () => {
    // Toggle only controls AUTO-OPEN; the drop time + countdown stay either way.
    startCountdown();
    chrome.runtime.sendMessage({ type: "arm_drop_launch", config: buildConfig() }, updateScheduleStatus);
    saveAll(true);
  });
  $("dropTime").addEventListener("input", () => { startCountdown(); saveAll(true); });
  $("dropTime").addEventListener("change", () => { startCountdown(); saveAll(true); });
  const _fdt = $("fetchDropTimeBtn");
  if (_fdt) _fdt.addEventListener("click", fetchDropTimeFromNike);
  $("multiProductToggle").addEventListener("change", () => {
    multiProduct = $("multiProductToggle").checked;
    applyMultiUI();
    renderAccounts(); // refresh assigned-product notes
  });
  $("addProductBtn").addEventListener("click", () => {
    products.push(newProduct());
    renderProducts();
  });
  $("randomAssignBtn").addEventListener("click", randomAssign);
  $("directUrlsBtn").addEventListener("click", () => assignCheckoutUrls($("assignMsg")));
  $("saveBtn").addEventListener("click", () => saveAll(false));
  $("launchAllBtn").addEventListener("click", launchAll);
  $("testHostBtn").addEventListener("click", async () => {
    flash($("statusMsg"), "Pinging launcher…", "#888");
    const up = await pingHost();
    if (up) { await loadProfiles(); flashTemp($("statusMsg"), "✓ Launcher connected.", "#1db954"); }
    else flashTemp($("statusMsg"), "Launcher not reachable — see setup below.", "#fa5400", 5000);
  });
  $("refreshProfilesBtn").addEventListener("click", async () => {
    await loadProfiles();
    flashTemp($("statusMsg"), hostOk ? `Reloaded ${discoveredProfiles.length} profiles.` : "Launcher offline.", hostOk ? "#1db954" : "#fa5400");
  });
  $("clearStatusBtn").addEventListener("click", async () => {
    liveStatuses = {};
    await chrome.storage.local.set({ [STATUS_KEY]: {} });
    refreshAllBadges();
    flashTemp($("statusMsg"), "Live status cleared.", "#888");
  });
  // setupLink is now wired via navigateTo("settings") — see nav section above.

  // ── Order checker ──
  refreshOrderCheckerProfiles();
  // Pre-load any cached orders for the first profile and start cross-profile polling.
  (async () => {
    const sel = $("orderCheckerProfile");
    if (sel && sel.value) await loadAndRenderOrders(sel.value);
  })();
  startOrdersPolling();
  $("orderCheckerProfile").addEventListener("change", async () => {
    const profileDir = $("orderCheckerProfile").value;
    $("ordersDisplay").innerHTML = "";
    if (!profileDir) return;
    await loadAndRenderOrders(profileDir);
  });
  $("openOrdersBtn").addEventListener("click", openOrdersPage);
  $("diagnoseOrdersBtn").addEventListener("click", diagnoseOrderChecker);
  $("clearOrdersBtn").addEventListener("click", async () => {
    const profileDir = $("orderCheckerProfile")?.value;
    if (!profileDir) return;
    const data = await chrome.storage.local.get(ORDERS_KEY);
    const store = data[ORDERS_KEY] || {};
    delete store[profileDir];
    await chrome.storage.local.set({ [ORDERS_KEY]: store });
    await hostSend({ cmd: "clearOrders", profileDir });
    $("ordersDisplay").innerHTML = "";
    flashTemp($("orderCheckerMsg"), "Orders cleared.", "#888");
  });

  $("exportConfigBtn").addEventListener("click", exportConfig);
  $("importFileInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) importConfig(file);
    e.target.value = ""; // reset so the same file can be re-imported
  });

  // ── Home-page quick-launch mirrors ──
  if ($("saveBtnHome")) $("saveBtnHome").addEventListener("click", () => saveAll(false));
  if ($("launchAllBtnHome")) $("launchAllBtnHome").addEventListener("click", launchAll);

  // ── Upcoming drops ──
  loadUpcoming(false);
  if ($("refreshUpcomingBtn")) $("refreshUpcomingBtn").addEventListener("click", () => loadUpcoming(true));

  // Load saved new-drop alert config into the settings fields.
  chrome.storage.local.get("snkrsUpcomingCfg", (d) => {
    const cfg = d.snkrsUpcomingCfg || {};
    if ($("upcomingEnabled")) $("upcomingEnabled").checked = !!cfg.enabled;
    if ($("upcomingWebhook")) $("upcomingWebhook").value = cfg.webhook || "";
    if ($("upcomingInterval") && cfg.intervalMin) $("upcomingInterval").value = cfg.intervalMin;
  });
  if ($("saveUpcomingBtn")) {
    $("saveUpcomingBtn").addEventListener("click", () => {
      const cfg = {
        enabled: $("upcomingEnabled") ? $("upcomingEnabled").checked : false,
        webhook: $("upcomingWebhook") ? $("upcomingWebhook").value.trim() : "",
        intervalMin: $("upcomingInterval") ? Math.max(1, Number($("upcomingInterval").value) || 5) : 5,
      };
      const msgEl = $("upcomingCfgMsg");
      if (cfg.enabled && !cfg.webhook) {
        if (msgEl) flashTemp(msgEl, "Enter a Discord webhook URL first.", "var(--orange)", 4000);
        return;
      }
      chrome.runtime.sendMessage({ type: "set_upcoming_cfg", cfg }, () => {
        if (msgEl) flashTemp(msgEl, cfg.enabled ? "✓ Monitoring armed — you'll be pinged on new drops." : "Saved (monitoring off).", "var(--green)", 5000);
      });
    });
  }
  if ($("testUpcomingBtn")) {
    $("testUpcomingBtn").addEventListener("click", () => {
      const msgEl = $("upcomingCfgMsg");
      const webhook = $("upcomingWebhook") ? $("upcomingWebhook").value.trim() : "";
      if (!webhook) { if (msgEl) flashTemp(msgEl, "Enter a webhook URL first.", "var(--orange)", 4000); return; }
      if (msgEl) flash(msgEl, "Checking Nike feed + webhook…", "#888");
      chrome.runtime.sendMessage({ type: "test_upcoming_now", webhook }, (resp) => {
        if (resp && resp.ok) {
          if (msgEl) flashTemp(msgEl, "✓ Test posted — check your Discord channel.", "var(--green)", 6000);
        } else {
          if (msgEl) flashTemp(msgEl, "Failed: " + ((resp && resp.error) || "no response"), "var(--red)", 6000);
        }
      });
    });
  }
  // Re-route home action messages to the home action msg div
  // (saveAll and launchAll use statusMsg; we'll update home separately via storage listener)

  // ── Settings-page host test/reload mirrors ──
  if ($("testHostBtnSettings")) {
    $("testHostBtnSettings").addEventListener("click", async () => {
      const msgEl = $("settingsStatusMsg");
      if (msgEl) flash(msgEl, "Pinging launcher…", "#888");
      const up = await pingHost();
      if (up) { await loadProfiles(); if (msgEl) flashTemp(msgEl, "✓ Launcher connected.", "var(--green)"); }
      else if (msgEl) flashTemp(msgEl, "Launcher not reachable — see setup instructions above.", "var(--orange)", 5000);
    });
  }
  if ($("refreshProfilesBtnSettings")) {
    $("refreshProfilesBtnSettings").addEventListener("click", async () => {
      const msgEl = $("settingsStatusMsg");
      await loadProfiles();
      if (msgEl) flashTemp(msgEl, hostOk ? `Reloaded ${discoveredProfiles.length} profile(s).` : "Launcher offline.", hostOk ? "var(--green)" : "var(--orange)");
    });
  }
  $("clearHistoryBtn").addEventListener("click", async () => {
    currentRunId = null;
    await chrome.storage.local.remove(HISTORY_KEY);
    renderHistory([]);
    flashTemp($("statusMsg"), "History cleared.", "#888");
  });
});
