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

const NATIVE_HOST = "com.snkrs.launcher";
const DASH_KEY    = "snkrsDashboard";
const VAULT_KEY   = "snkrsVault";
const STATUS_KEY  = "snkrsStatus";
const HISTORY_KEY = "snkrsHistory";

const FOOTWEAR_SIZES = ["5","5.5","6","6.5","7","7.5","8","8.5","9","9.5","10","10.5","11","11.5","12","12.5","13","13.5","14"];
const APPAREL_SIZES  = ["XS","S","M","L","XL","XXL"];

let discoveredProfiles = [];   // [{dir,name}]
let hostOk = false;
let accounts = [];             // [{id,label,profileDir,manualProfile,size,sizeType,ownCard,card}]
let savedVault = [];           // [{id,label,profileDir,size,sizeType,card}]
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
  }
}

// ── Status badge metadata ─────────────────────────────────────
const STATUS_META = {
  win:     { text: "🏆 WON",     color: "#1db954" },
  loss:    { text: "😔 LOSS",    color: "#e03131" },
  entered: { text: "✓ ENTERED",  color: "#4a90e2" },
  pending: { text: "⏳ PENDING", color: "#fa8c00" },
  polling: { text: "🔄 POLLING", color: "#888888" },
  closed:  { text: "⛔ CLOSED",  color: "#666666" },
  limit:   { text: "⚠ LIMIT",   color: "#fa5400" },
};

function updateStatusBadge(profileDir) {
  const entry = statusElMap.get(profileDir);
  if (!entry) return;
  const s = liveStatuses[profileDir];
  if (!s) { entry.rowEl.classList.add("hidden"); return; }
  const meta = STATUS_META[s.code] || { text: s.code, color: "#888" };
  entry.rowEl.classList.remove("hidden");
  entry.badgeEl.textContent = meta.text;
  entry.badgeEl.style.color = meta.color;
  entry.badgeEl.style.borderColor = meta.color + "66";
  entry.badgeEl.style.background  = meta.color + "1a";
  entry.textEl.textContent  = (s.message || "").replace(/\*\*/g, "").slice(0, 90);
  entry.textEl.title        = s.message || "";
  if (s.time) {
    const d = new Date(s.time);
    entry.timeEl.textContent = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  }
}

function refreshAllBadges() {
  accounts.forEach(a => { if (a.profileDir) updateStatusBadge(a.profileDir); });
}

// ── Storage change listener (live status + vault + history sync) ─
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
  if (changes[VAULT_KEY]) {
    savedVault = changes[VAULT_KEY].newValue || [];
    renderVault();
    refreshVaultSelects();
  }
  if (changes[HISTORY_KEY]) {
    renderHistory(changes[HISTORY_KEY].newValue || []);
  }
});

// ── Vault helpers ─────────────────────────────────────────────
async function loadVault() {
  const data = await chrome.storage.local.get(VAULT_KEY);
  savedVault = Array.isArray(data[VAULT_KEY]) ? data[VAULT_KEY] : [];
}

async function persistVault() {
  await chrome.storage.local.set({ [VAULT_KEY]: savedVault });
}

function fillVaultSelect(sel) {
  const current = sel.value;
  sel.innerHTML = "";
  sel.appendChild(el("option", { value: "" }, "— import from vault —"));
  savedVault.forEach(vp => {
    const label = vp.label || vp.profileDir || "Unnamed";
    const size  = vp.size ? ` · ${vp.sizeType === "apparel" ? "" : "US "}${vp.size}` : "";
    sel.appendChild(el("option", { value: vp.id }, label + size));
  });
  sel.value = current;
}

function refreshVaultSelects() {
  document.querySelectorAll(".f-vault-select").forEach(sel => fillVaultSelect(sel));
}

function buildVaultRow(vp) {
  const row = document.createElement("div");
  row.className = "vault-row";

  const info = document.createElement("div");
  info.className = "vault-info";

  const name = document.createElement("span");
  name.className = "vault-label";
  name.textContent = vp.label || "(unlabelled)";

  const sub = document.createElement("span");
  sub.className = "vault-sub";
  const sizeStr  = vp.size ? `${vp.sizeType === "apparel" ? "" : "US "}${vp.size}` : "no size";
  const cardStr  = (vp.card && vp.card.cardNumber) ? " · own card" : "";
  sub.textContent = `${vp.profileDir || "no profile"} · ${sizeStr}${cardStr}`;

  info.append(name, sub);

  const btns = document.createElement("div");
  btns.className = "vault-btns";

  const useBtn = document.createElement("button");
  useBtn.className = "btn btn-mini btn-dark";
  useBtn.textContent = "USE →";
  useBtn.title = "Add a new account row pre-filled with this template";
  useBtn.addEventListener("click", () => {
    accounts.push({
      id: uid(),
      label: vp.label || "",
      profileDir: vp.profileDir || "",
      size: vp.size || "",
      sizeType: vp.sizeType || "footwear",
      ownCard: !!(vp.card && vp.card.cardNumber),
      card: vp.card ? { ...vp.card } : null,
    });
    renderAccounts();
    document.getElementById("accountsList").lastElementChild
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  const delBtn = document.createElement("button");
  delBtn.className = "btn btn-mini btn-danger";
  delBtn.textContent = "✕";
  delBtn.title = "Delete from vault";
  delBtn.addEventListener("click", async () => {
    savedVault = savedVault.filter(p => p.id !== vp.id);
    await persistVault();
    renderVault();
    refreshVaultSelects();
    flashTemp($("vaultMsg"), "Removed from vault.", "#888");
  });

  btns.append(useBtn, delBtn);
  row.append(info, btns);
  return row;
}

function renderVault() {
  const list = $("vaultList");
  if (!list) return;
  list.innerHTML = "";
  if (!savedVault.length) {
    list.appendChild(el("p", { className: "hint" }, "No saved profiles yet. Click 💾 vault on any account row to save it here."));
    return;
  }
  savedVault.forEach(vp => list.appendChild(buildVaultRow(vp)));
}

// ── Drop countdown timer ──────────────────────────────────────
function startCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  function tick() {
    const el = $("dropCountdown");
    if (!el) return;
    if (!scheduleIsEnabled()) { el.style.display = "none"; return; }
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
      renderAccounts();
      renderVault();
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
}

function buildAccountRow(acct) {
  const tpl = $("accountRowTpl").content.cloneNode(true);
  const row = tpl.querySelector(".acct");

  const labelEl     = row.querySelector(".f-label");
  const profileEl   = row.querySelector(".f-profile");
  const manualEl    = row.querySelector(".f-profile-manual");
  const sizeEl      = row.querySelector(".f-size");
  const ownCardEl   = row.querySelector(".f-owncard");
  const autoEl      = row.querySelector(".f-autolaunch");
  const panel       = row.querySelector(".owncard-panel");
  const ocName      = row.querySelector(".oc-name");
  const ocNumber    = row.querySelector(".oc-number");
  const ocExpiry    = row.querySelector(".oc-expiry");
  const ocCvv       = row.querySelector(".oc-cvv");
  const msgEl       = row.querySelector(".acct-msg");
  const vaultSel    = row.querySelector(".f-vault-select");
  const assignedEl  = row.querySelector(".f-assigned");
  const statusRow   = row.querySelector(".f-status-row");
  const statusBadge = row.querySelector(".f-status-badge");
  const statusText  = row.querySelector(".f-status-text");
  const statusTime  = row.querySelector(".f-status-time");

  labelEl.value = acct.label || "";
  autoEl.checked = !!acct.autoLaunch;
  fillSizeSelect(sizeEl, acct.size, acct.sizeType);
  fillProfileSelect(profileEl, manualEl, acct.profileDir);
  fillVaultSelect(vaultSel);

  ownCardEl.checked = !!acct.ownCard;
  panel.style.display = acct.ownCard ? "block" : "none";
  const c = acct.card || {};
  ocName.value = c.cardName || "";
  ocNumber.value = c.cardNumber || "";
  ocExpiry.value = c.cardExpiry || "";
  ocCvv.value = c.cardCvv || "";
  attachCardFormatters(ocNumber, ocExpiry, ocCvv);

  // Show which product this account is assigned to (multi-product mode)
  if (multiProduct && acct.url) {
    assignedEl.style.display = "";
    assignedEl.textContent = `→ ${acct.keyword ? acct.keyword + " · " : ""}${shortUrl(acct.url)}`;
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

  ownCardEl.addEventListener("change", () => {
    acct.ownCard = ownCardEl.checked;
    panel.style.display = acct.ownCard ? "block" : "none";
  });
  autoEl.addEventListener("change", () => { acct.autoLaunch = autoEl.checked; });
  const syncOwnCard = () => {
    acct.card = {
      cardName: ocName.value.trim(),
      cardNumber: ocNumber.value.trim(),
      cardExpiry: ocExpiry.value.trim(),
      cardCvv: ocCvv.value.trim(),
    };
  };
  [ocName, ocNumber, ocExpiry, ocCvv].forEach(i => i.addEventListener("input", syncOwnCard));

  // ── Vault import: fill this row from a saved vault profile ──
  vaultSel.addEventListener("change", () => {
    if (!vaultSel.value) return;
    const vp = savedVault.find(v => v.id === vaultSel.value);
    if (!vp) { vaultSel.value = ""; return; }

    labelEl.value = vp.label || "";       acct.label     = vp.label || "";
    fillProfileSelect(profileEl, manualEl, vp.profileDir);
    acct.profileDir = vp.profileDir || "";
    fillSizeSelect(sizeEl, vp.size, vp.sizeType);
    const { size, sizeType } = parseSizeValue(sizeEl.value);
    acct.size = size; acct.sizeType = sizeType;

    if (vp.card && vp.card.cardNumber) {
      ownCardEl.checked = true; acct.ownCard = true;
      panel.style.display = "block";
      ocName.value   = vp.card.cardName   || "";
      ocNumber.value = vp.card.cardNumber || "";
      ocExpiry.value = vp.card.cardExpiry || "";
      ocCvv.value    = vp.card.cardCvv    || "";
      acct.card = { ...vp.card };
    }
    registerStatus(acct.profileDir);
    vaultSel.value = ""; // reset after import
    flashTemp(msgEl, `Imported from vault: "${vp.label || vp.profileDir}".`, "#1db954");
  });

  // ── Save this account row to vault ──────────────────────────
  row.querySelector(".f-save-vault").addEventListener("click", async () => {
    if (!acct.label && !acct.profileDir) {
      flashTemp(msgEl, "Fill in at least a label or Chrome profile first.", "#fa5400");
      return;
    }
    const vp = {
      id: uid(),
      label:      acct.label || acct.profileDir || "Profile",
      profileDir: acct.profileDir || "",
      size:       acct.size || "",
      sizeType:   acct.sizeType || "footwear",
      card:       acct.ownCard && acct.card && acct.card.cardNumber ? { ...acct.card } : null,
    };
    // Avoid exact duplicate labels
    const dupe = savedVault.find(v => v.label === vp.label && v.profileDir === vp.profileDir);
    if (dupe) {
      Object.assign(dupe, vp, { id: dupe.id }); // update in-place
    } else {
      savedVault.push(vp);
    }
    await persistVault();
    flashTemp(msgEl, `💾 Saved to vault as "${vp.label}".`, "#1db954");
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

function dropTimeISO() {
  if (!scheduleIsEnabled()) return "";
  const v = $("dropTime") && $("dropTime").value;
  if (!v) return "";
  const d = new Date(v);
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

function buildConfig() {
  return {
    drop: {
      url: $("dropUrl").value.trim(),
      keyword: $("dropKeyword").value.trim(),
      dropTimeISO: dropTimeISO(),
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
    card: {
      cardName: $("cardName").value.trim(),
      cardNumber: $("cardNumber").value.trim(),
      cardExpiry: $("cardExpiry").value.trim(),
      cardCvv: $("cardCvv").value.trim(),
    },
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
      autoLaunch: !!a.autoLaunch,
      card: a.ownCard ? (a.card || {}) : null,
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
  const el = $("scheduleStatus");
  if (!el) return;
  if (!armResp || !scheduleIsEnabled()) { el.style.display = "none"; return; }
  if (armResp.armed) {
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
  } else {
    el.className = "schedule-status disarmed";
    el.style.display = "";
    el.textContent = armResp.reason
      ? `Not scheduled (${armResp.reason})`
      : "Not scheduled — set a time and toggle ⏰ auto on at least one account to arm.";
  }
}

// ── Launch a single account into its Chrome profile ───────────
// In multi-product mode each account carries its own assigned URL; in
// single-product mode they all share the central Drop URL.
function resolvedUrl(acct) {
  return (multiProduct && acct.url) ? acct.url.trim() : $("dropUrl").value.trim();
}

function bootUrlFor(acct) {
  let url = resolvedUrl(acct);
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const sep = url.includes("#") ? "&" : "#";
  return `${url}${sep}snkrsBoot=${encodeURIComponent(acct.profileDir)}`;
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

async function launchAll() {
  const ready = accounts.filter(a => a.profileDir && a.size && resolvedUrl(a));
  if (!ready.length) {
    flashTemp($("statusMsg"), multiProduct
      ? "No accounts ready — run 🎲 assign so each gets a product + size."
      : "No accounts ready (need Drop URL, a profile + size).", "#fa5400");
    return;
  }
  const config = await saveAll(true);
  await appendHistory(config);
  flash($("statusMsg"), `Launching ${ready.length} accounts…`, "#888");
  let okCount = 0, lastErr = "";
  for (const acct of ready) {
    const url = bootUrlFor(acct);
    const resp = await hostSend({ cmd: "launch", profileDir: acct.profileDir, url });
    if (resp.ok) okCount++;
    else lastErr = resp.error || "unknown";
    await new Promise(r => setTimeout(r, 400)); // stagger so Chrome keeps up
  }
  if (okCount === ready.length) {
    flashTemp($("statusMsg"), `🚀 Launched all ${okCount} accounts onto the drop.`, "#1db954", 5000);
  } else if (okCount > 0) {
    flashTemp($("statusMsg"), `Launched ${okCount}/${ready.length}. Last error: ${lastErr}`, "#f0c070", 6000);
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
  const drop = cfg.drop || {}, card = cfg.card || {}, opts = cfg.options || {};
  $("dropUrl").value = drop.url || "";
  $("dropKeyword").value = drop.keyword || "";
  const schedOn = !!drop.scheduleEnabled;
  $("scheduleEnabled").checked = schedOn;
  $("schedulePanel").style.display = schedOn ? "" : "none";
  if (drop.dropTimeISO) {
    const d = new Date(drop.dropTimeISO);
    if (!isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, "0");
      $("dropTime").value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }
  $("cardName").value = card.cardName || "";
  $("cardNumber").value = card.cardNumber || "";
  $("cardExpiry").value = card.cardExpiry || "";
  $("cardCvv").value = card.cardCvv || "";

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
    autoLaunch: !!a.autoLaunch,
    ownCard: !!a.card,
    card: a.card || null,
  }));
}

document.addEventListener("DOMContentLoaded", async () => {
  attachCardFormatters($("cardNumber"), $("cardExpiry"), $("cardCvv"));

  // 1) Load saved vault profiles, live status snapshots, and history.
  await loadVault();
  await loadHistory();
  const storedStatus = await chrome.storage.local.get(STATUS_KEY);
  liveStatuses = storedStatus[STATUS_KEY] || {};

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

  if (!accounts.length) accounts = [{ id: uid(), label: "", profileDir: "", size: "", sizeType: "footwear", ownCard: false, card: null }];
  renderAccounts();
  renderVault();
  renderDropUI();
  startCountdown();

  // ── Buttons ──
  $("addAccountBtn").addEventListener("click", () => {
    accounts.push({ id: uid(), label: "", profileDir: "", size: "", sizeType: "footwear", ownCard: false, card: null });
    renderAccounts();
  });
  $("scheduleEnabled").addEventListener("change", () => {
    const on = $("scheduleEnabled").checked;
    $("schedulePanel").style.display = on ? "" : "none";
    if (on) {
      startCountdown();
    } else {
      // Hide countdown and disarm alarm immediately
      const el = $("dropCountdown"); if (el) el.style.display = "none";
      chrome.runtime.sendMessage({ type: "arm_drop_launch", config: buildConfig() }, updateScheduleStatus);
    }
  });
  $("dropTime").addEventListener("input", startCountdown);
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
  $("setupLink").addEventListener("click", (e) => { e.preventDefault(); $("setupHelp").style.display = "block"; $("setupHelp").scrollIntoView({ behavior: "smooth" }); });

  $("exportConfigBtn").addEventListener("click", exportConfig);
  $("importFileInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) importConfig(file);
    e.target.value = ""; // reset so the same file can be re-imported
  });
  $("clearHistoryBtn").addEventListener("click", async () => {
    currentRunId = null;
    await chrome.storage.local.remove(HISTORY_KEY);
    renderHistory([]);
    flashTemp($("statusMsg"), "History cleared.", "#888");
  });
});
