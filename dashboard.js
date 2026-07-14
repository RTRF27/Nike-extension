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

// ── Page navigation (CyberAIO sidebar + grouped sections) ─────
// Four primary groups in the sidebar. Each maps to one or more of the existing
// page-sections (so all their element IDs + wiring stay intact). Multi-section
// groups get a secondary tab row; "stack" groups show their sections together.
const NAV_GROUPS = {
  dashboard: { sections: ["home", "live"], stack: true },
  setup:     { sections: ["drop", "profiles", "cards", "preflight"], tabs: ["Drop", "Profiles", "Cards", "Preflight"] },
  history:   { sections: ["history", "orders"], tabs: ["Insights & Replay", "Orders"] },
  settings:  { sections: ["settings"], stack: true },
};
const SECTION_TO_GROUP = {};
for (const [g, def] of Object.entries(NAV_GROUPS)) def.sections.forEach(s => (SECTION_TO_GROUP[s] = g));

let _currentGroup = "dashboard";
let _currentPage = "home";                 // the active (sub)section
let _visibleSections = new Set(["home", "live"]);
const isVisible = (section) => _visibleSections.has(section);

function runSectionHooks(section) {
  if (section === "home") { renderHomeStats(); if (!_upcomingLoaded) loadUpcoming(false); }
  else if (section === "live") { renderLivePage(); refreshPanicBanner(); }
  else if (section === "preflight") { renderPreflight(); refreshVersionBanner(); }
  else if (section === "history") { renderDropReplay(); renderInsights(); }
  else if (section === "drop") { renderSelfLearningForDrop(); }
}

function buildSubnav(group, active) {
  const nav = document.getElementById("subNav");
  if (!nav) return;
  const g = NAV_GROUPS[group];
  nav.innerHTML = "";
  if (!g || g.stack || g.sections.length <= 1) { nav.style.display = "none"; return; }
  nav.style.display = "flex";
  g.sections.forEach((sec, i) => {
    const b = document.createElement("button");
    b.className = "subtab" + (sec === active ? " active" : "");
    b.textContent = (g.tabs && g.tabs[i]) || sec.toUpperCase();
    b.addEventListener("click", () => navigateTo(group, sec));
    nav.appendChild(b);
  });
}

// Accepts a group name ("setup") OR a section name ("preflight") so every
// existing navigateTo("preflight"/"settings"/…) call keeps working.
function navigateTo(name, subSection) {
  let group, active;
  if (NAV_GROUPS[name]) { group = name; active = subSection || NAV_GROUPS[name].sections[0]; }
  else { group = SECTION_TO_GROUP[name] || "dashboard"; active = name; }
  const g = NAV_GROUPS[group];

  document.querySelectorAll(".page-section").forEach(s => s.classList.remove("active"));
  _visibleSections = new Set();
  const shown = g.stack ? g.sections : [active];
  shown.forEach(sec => {
    const el = document.getElementById("page-" + sec);
    if (el) { el.classList.add("active"); _visibleSections.add(sec); }
  });

  document.querySelectorAll(".side-item").forEach(t => t.classList.toggle("active", t.dataset.nav === group));
  buildSubnav(group, active);

  _currentGroup = group;
  _currentPage = active;
  shown.forEach(runSectionHooks);
  const c = document.querySelector(".content");
  if (c) c.scrollTop = 0;
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
    const acctStatuses = accounts.filter(a => a.profileDir && bestStatusFor(a.profileDir));
    if (!acctStatuses.length) {
      list.innerHTML = "<p class='hint'>No accounts running. Launch from the DROP tab.</p>";
    } else {
      list.innerHTML = "";
      acctStatuses.forEach(a => {
        const s = bestStatusFor(a.profileDir) || {};
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
      if (d.url) {
        img.classList.add("clickable");
        img.title = "Open product page";
        img.addEventListener("click", () => window.open(d.url, "_blank", "noopener"));
      }
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
let proxyAssignments = {};     // {profileDir: "host:port:user:pass"} manual overrides (swap)
let currentRunId  = null;      // ID of the most recently launched history entry
let countdownTimer = null;

const TIMELINE_KEY = "snkrsTimeline";
let timelines = {};            // {key(profileDir#tab): {profileDir,events:[],dropAt,label}}
let timelinePollTimer = null;

const WARM_KEY = "snkrsWarmTimes";
let warmTimes = {};            // {profileDir: epochMs of last warm-up we opened}

const NIKE_PREFLIGHT_URL = "https://www.nike.com/sg/member/settings"; // logged-in-only page; renders phone + country for region detection
let preflightResults = {};     // {profileDir: {ts,version,checks:{...}}}
let profileVersions = {};      // {profileDir: {version,ts}}
let latestVersion = "";        // repo manifest version reported by the host
let preflightPollTimer = null;
const PENDING_PF = "__pending__"; // placeholder verdict while a run is in flight

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
  $("dropModeTag").textContent = multiProduct ? "EVERY ACCOUNT COPS ALL PRODUCTS" : "EVERYONE COPS THE SAME DROP";
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
  const fetchBtn = row.querySelector(".p-fetch");
  const preview  = row.querySelector(".p-preview");
  urlEl.value = p.url || "";
  kwEl.value  = p.keyword || "";
  buildSizePool(poolEl, p.sizePool || [], (s) => { p.sizePool = s; });
  urlEl.addEventListener("input", () => { p.url = urlEl.value.trim(); });
  kwEl.addEventListener("input",  () => { p.keyword = kwEl.value.trim(); });
  fetchBtn.addEventListener("click", async () => {
    const sku = (p.keyword || "").trim();
    if (!sku) { previewError(preview, "Enter this product's SKU first."); return; }
    previewLoading(preview, sku);
    const meta = await resolveProductMeta(sku);
    if (!meta.ok) { previewError(preview, `Couldn't resolve ${sku}: ${meta.error || "not found"}.`); return; }
    renderProductPreview(preview, meta);
    if (!(p.url || "").trim() && meta.url) { p.url = meta.url; urlEl.value = meta.url; }
  });
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

// ── Product lookup + thumbnail preview ────────────────────────
// Resolve a SKU to its real product (name, image, /launch/t/ URL, drop time)
// via Nike's feed. Confirms visually that the exact item is being targeted —
// so a collection page can never silently cop the top-most product.
function resolveProductMeta(sku) {
  return new Promise((resolve) => {
    const clean = (sku || "").trim().toUpperCase();
    if (!clean) { resolve({ ok: false, error: "no SKU" }); return; }
    chrome.runtime.sendMessage({ type: "resolve_launch", sku: clean, country: DIRECT_COUNTRY }, (res) => {
      if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
      resolve(res || { ok: false, error: "no response from background" });
    });
  });
}

// Render a thumbnail card into `box`. The image is clickable → opens the
// product's launch page in a new tab.
function renderProductPreview(box, meta, pageUrl) {
  box.innerHTML = "";
  box.style.display = "";
  const url = (meta && meta.url) || pageUrl || "";
  const img = el("img", { className: "product-thumb", src: (meta && meta.imageUrl) || "", alt: (meta && meta.name) || "" });
  if (url) {
    img.classList.add("clickable");
    img.title = "Open the product page";
    img.addEventListener("click", () => window.open(url, "_blank", "noopener"));
  }
  box.appendChild(img);
  const info = el("div", { className: "product-preview-info" });
  info.appendChild(el("div", { className: "product-preview-name" }, (meta && meta.name) || (meta && meta.sku) || "Product"));
  if (meta && meta.sku) info.appendChild(el("div", { className: "product-preview-sku" }, meta.sku));
  if (meta && meta.dropTimeISO) info.appendChild(el("div", { className: "product-preview-date" }, "📅 " + fmtUpcomingDate(meta.dropTimeISO)));
  // DRAW = raffle: you can't direct-checkout, you enter the draw. Flag it so the
  // user doesn't expect BUILD DIRECT CHECKOUT URLS to work for this product.
  if (meta && meta.method) {
    const isDraw = /draw/i.test(meta.method);
    info.appendChild(el("div", { className: "product-preview-date" },
      isDraw ? "🎟️ DRAW (raffle) — enter, don't direct-checkout" : `🛒 ${meta.method} (first-come buy)`));
  }
  if (url) info.appendChild(el("div", { className: "product-preview-open" }, "▶ click image to open product page"));
  box.appendChild(info);
}

function previewLoading(box, sku) {
  box.style.display = "";
  box.innerHTML = `<span class="hint">Looking up ${sku}…</span>`;
}
function previewError(box, text) {
  box.style.display = "";
  box.innerHTML = `<span class="hint" style="color:#fa5400">${text}</span>`;
}

// ── Manual gs.nike.com checkout-link generator ────────────────
// Resolve a SKU and list a ready-to-paste checkout link for every size, so the
// user can drop one straight into a logged-in tab. Reuses the same resolver and
// URL builder the automatic flow uses, so the links are identical.
async function generateGsLinks() {
  const sku  = ($("gsLinkSku").value || "").trim().toUpperCase();
  const msg  = $("gsLinkMsg");
  const list = $("gsLinkList");
  list.innerHTML = "";
  if (!sku) { msg.style.color = "#fa5400"; msg.textContent = "Enter a SKU first."; return; }
  msg.style.color = "#888"; msg.textContent = `Resolving ${sku} from Nike…`;

  let d;
  try { d = await resolveLaunch(sku); } catch (e) { d = { ok: false, error: String(e && e.message || e) }; }
  if (!d || !d.ok) {
    msg.style.color = "#fa5400";
    msg.textContent = `Couldn't resolve ${sku}: ${(d && d.error) || "not found"}. Sizes often publish closer to drop time.`;
    return;
  }
  const skus = d.skus || [];
  if (!skus.length) {
    msg.style.color = "#fa5400";
    msg.textContent = `No sizes published for ${sku} yet — try again nearer the drop.`;
    return;
  }

  msg.style.color = "var(--green)";
  msg.textContent = `${d.name || sku} — ${skus.length} size(s). Note: links only load at go-live; before the drop they show Nike's error page.`;

  skus.forEach((s) => {
    const sizeText = s.localizedSize || s.nikeSize || "?";
    const row   = el("div", { className: "gs-link-row" });
    const label = el("span", { className: "gs-link-size" }, sizeText);
    const input = el("input", { className: "inp gs-link-url", type: "text", value: buildDirectCheckoutUrl(d, s.id), readOnly: true });
    const copy  = el("button", { className: "btn btn-mini btn-dark" }, "COPY");
    copy.addEventListener("click", () => {
      // Fresh checkoutId every copy — a reused session is a common Oops cause.
      const fresh = buildDirectCheckoutUrl(d, s.id);
      input.value = fresh;
      const done = () => { copy.textContent = "COPIED"; setTimeout(() => { copy.textContent = "COPY"; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(fresh).then(done).catch(() => { input.select(); document.execCommand("copy"); done(); });
      } else { input.select(); document.execCommand("copy"); done(); }
    });
    row.appendChild(label); row.appendChild(input); row.appendChild(copy);
    list.appendChild(row);
  });

  // Copy-all row.
  const actions = el("div", { className: "gs-link-actions" });
  const copyAll = el("button", { className: "btn btn-mini btn-purple" }, "COPY ALL LINKS");
  copyAll.addEventListener("click", () => {
    const all = skus.map(s => `${s.localizedSize || s.nikeSize}\t${buildDirectCheckoutUrl(d, s.id)}`).join("\n");
    const done = () => { copyAll.textContent = "COPIED ALL"; setTimeout(() => { copyAll.textContent = "COPY ALL LINKS"; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(all).then(done).catch(done);
    else done();
  });
  actions.appendChild(copyAll);
  list.appendChild(actions);
}

// Fetch handler for the single-product panel.
async function fetchSingleMeta() {
  const sku = ($("dropKeyword").value || "").trim();
  const box = $("singleProductPreview");
  if (!sku) { previewError(box, "Enter the item's SKU (e.g. IH1610-052) first, then Fetch."); return; }
  previewLoading(box, sku);
  const meta = await resolveProductMeta(sku);
  if (!meta.ok) { previewError(box, `Couldn't resolve ${sku}: ${meta.error || "not found"}. Sizes/details often publish closer to drop time.`); return; }
  renderProductPreview(box, meta);
  // Auto-fill the product URL if the user only gave a SKU.
  if (!($("dropUrl").value || "").trim() && meta.url) $("dropUrl").value = meta.url;
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
    // EVERY account cops EVERY product — one checkout tab per product, each with
    // its own size dealt from that product's pool (no repeats across accounts).
    accounts.forEach(a => { a.targets = []; });
    prods.forEach(p => {
      const sizes = dealFromPool(p.sizePool, accounts.length);
      accounts.forEach((acct, i) => {
        const { size, sizeType } = parseSizeValue(sizes[i]);
        acct.targets.push({
          productId: p.id, url: (p.url || "").trim(), keyword: (p.keyword || "").trim(),
          size, sizeType, checkoutUrl: "", dropAtMs: 0,
        });
      });
    });
    renderAccounts();
    await saveAll(true);
    flashTemp(msg, `🎲 Each account will cop all ${prods.length} products (${prods.length} tabs each).`, "#1db954", 4000);
    await assignCheckoutUrls(msg); // build a direct checkout URL per product
  } else {
    if (!singleSizePool.length) { flashTemp(msg, "Pick at least one size in the pool above.", "#fa5400"); return; }
    const sizes = dealFromPool(singleSizePool, accounts.length);
    accounts.forEach((acct, i) => {
      acct.url = ""; acct.keyword = ""; acct.targets = [];
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

// liveStatuses is keyed per TAB ("profile#tabId"). These aggregate by profile.
const STALE_MS = 15 * 60 * 1000;
function profileEntries(profileDir) {
  return Object.values(liveStatuses).filter(e => e && String(e.profileDir).split("#")[0] === profileDir);
}
function bestStatusFor(profileDir) {
  const es = profileEntries(profileDir);
  if (!es.length) return null;
  const err = es.find(e => e.code === "error");
  if (err) return err;
  return es.slice().sort((a, b) => (b.time || 0) - (a.time || 0))[0];
}

function updateStatusBadge(profileDir) {
  const entry = statusElMap.get(profileDir);
  if (!entry) return;
  const s = bestStatusFor(profileDir);
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
  renderLivePage();
}

// ══════════════════ PREFLIGHT + VERSION BANNER ══════════════════
// The pre-drop health check. RUN PREFLIGHT opens every account's profile on a
// logged-in-only Nike page tagged #snkrsPreflight=<profileDir>; the bootstrap
// + background run the checks, publish results to the shared preflight folder,
// and close the tab. We poll that folder and render a red/green checklist.

function cmpVer(a, b) {
  const pa = String(a || "").split(".").map(Number);
  const pb = String(b || "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// The checks shown per profile, in display order. "region" (SG/MY from the
// account's phone) and "address" (printed, informational) sit together.
const PF_CHECK_DEFS = [
  { key: "version", label: "Version" },
  { key: "host",    label: "Host" },
  { key: "login",   label: "Nike login" },
  { key: "region",  label: "Region" },
  { key: "address", label: "Address" },
  { key: "card",    label: "Card" },
  { key: "cookies", label: "Cookies" },
  { key: "target",  label: "Target" },
];

// Some checks the dashboard can determine on its own (card on file, a launch
// target assigned) without needing the profile's browser. Merge those in.
function localChecksFor(acct) {
  const checks = {};
  const card = cardProfiles.find(c => c.id === acct.cardId);
  const hasCard = !!(card && (card.cardNumber || "").replace(/\s/g, "").length >= 12);
  checks.card = hasCard
    ? { ok: true, detail: `card “${card.name}” assigned` }
    : { ok: null, detail: "no saved card — will type manually at checkout" };

  const targets = launchTargetsFor(acct);
  checks.target = targets.length
    ? { ok: true, detail: `${targets.length} target(s) · size ${acct.size || "?"}` }
    : { ok: false, detail: "no product/size assigned for this account" };
  return checks;
}

// Informational rows — shown for reference, never affect the pass/fail verdict.
const PF_INFO_KEYS = new Set(["region", "address"]);

// Reduce one profile's per-check map to a card verdict: red (any hard fail),
// amber (any unknown/warning), green (all good), or pending.
function preflightVerdict(checks) {
  let anyBad = false, anyWarn = false, seen = 0;
  for (const def of PF_CHECK_DEFS) {
    if (PF_INFO_KEYS.has(def.key)) continue; // region/address are informational
    const c = checks[def.key];
    if (!c) continue;
    seen++;
    if (c.ok === false) anyBad = true;
    else if (c.ok === null || c.ok === undefined) anyWarn = true;
  }
  if (!seen) return "pending";
  if (anyBad) return "red";
  if (anyWarn) return "amber";
  return "green";
}

// Merge shared-folder results + locally-derived checks for one account.
function mergedChecksFor(acct) {
  const rec = preflightResults[acct.profileDir] || {};
  const remote = rec.checks || {};
  const local = localChecksFor(acct);
  const merged = { ...local, ...remote, __rec: rec };
  // Annotate the cookies check with how long ago we last warmed this profile.
  const warm = warmTimes[acct.profileDir];
  if (warm && merged.cookies) {
    const mins = Math.round((Date.now() - warm) / 60000);
    const ago = mins <= 0 ? "just now" : mins === 1 ? "1 min ago" : `${mins} min ago`;
    merged.cookies = { ...merged.cookies, detail: `${merged.cookies.detail} · warmed ${ago}` };
  }
  return merged;
}

// The region an account counts as: a manual override (SG/MY) wins, otherwise
// the region auto-detected from its phone during Preflight.
function effectiveRegionFor(acct) {
  const ov = acct && acct.regionOverride;
  if (ov === "SG" || ov === "MY") return ov;
  const rec = preflightResults[acct.profileDir];
  return (rec && rec.region) || "";
}

// ── Warm-up: open the SNKRS feed (no boot marker → bot idle) so each profile's
// Kasada anti-bot cookies are fresh before the drop. Records when we warmed
// each profile so the preflight cookies row can show its age.
async function markWarm(profileDir) {
  warmTimes[profileDir] = Date.now();
  await chrome.storage.local.set({ [WARM_KEY]: warmTimes });
}
// ── UPDATE ALL: hot-reload the extension in every profile ─────
// For machines that can't force-install (personal/unmanaged), this is the
// one-click updater: after a `git pull`, it opens each profile with a reload
// marker so its background calls chrome.runtime.reload() and re-reads the
// latest unpacked code from the folder — no Chrome restart. Do it BETWEEN
// drops (reloading mid-checkout would interrupt it).
const NIKE_RELOAD_URL = "https://www.nike.com/sg/launch/"; // bootstrap runs here at document_start
async function updateAllProfiles() {
  const msg = $("preflightMsg");
  const withProfile = accounts.filter(a => a.profileDir);
  if (!withProfile.length) { flashTemp(msg, "No profiles to update.", "var(--orange)", 4000); return; }
  if (!hostOk && !(await pingHost())) { flashTemp(msg, "Launcher offline — can't reach profiles.", "var(--orange)", 5000); return; }
  if (!confirm(
    "Update the extension in ALL profiles now?\n\n" +
    "Pull the latest first (git pull), then this reloads every profile's bot from the folder.\n\n" +
    "Do this BETWEEN drops — reloading during a live checkout would interrupt it.\n\n" +
    "This dashboard's own profile reloads last (the page will refresh)."
  )) return;

  const ts = Date.now();
  flash(msg, `Sending update to ${withProfile.length} profile(s)…`, "#888");
  let ok = 0, lastErr = "";
  for (const a of withProfile) {
    const url = `${NIKE_RELOAD_URL}#snkrsReload=${ts}`;
    const resp = await hostSend({ cmd: "launch", profileDir: a.profileDir, url });
    if (resp.ok) ok++; else lastErr = resp.error || "unknown";
    await new Promise(r => setTimeout(r, 400));
  }
  flashTemp(msg, ok === withProfile.length
    ? `⟳ Update sent to ${ok} profile(s) — each reloads to the current version. This dashboard reloads in 5s; reopen it after.`
    : `Sent to ${ok}/${withProfile.length}. Last error: ${lastErr}`,
    ok ? "var(--green)" : "var(--red)", 9000);
  // Reload our OWN profile last so the dashboard picks up new code too.
  if (ok) setTimeout(() => { try { chrome.runtime.reload(); } catch (e) {} }, 5000);
}

async function warmAll() {
  const msg = $("preflightMsg");
  const withProfile = accounts.filter(a => a.profileDir);
  if (!withProfile.length) { flashTemp(msg, "No profiles to warm.", "var(--orange)", 4000); return; }
  if (!hostOk && !(await pingHost())) { flashTemp(msg, "Launcher offline.", "var(--orange)", 5000); return; }
  flash(msg, `Warming ${withProfile.length} profile(s) on the SNKRS feed…`, "#888");
  let ok = 0, lastErr = "";
  for (const a of withProfile) {
    const resp = await hostSend({ cmd: "launch", profileDir: a.profileDir, url: WARMUP_URL });
    if (resp.ok) { ok++; await markWarm(a.profileDir); } else lastErr = resp.error || "unknown";
    await new Promise(r => setTimeout(r, 350));
  }
  if (isVisible("preflight")) renderPreflight();
  flashTemp(msg, ok === withProfile.length
    ? `🔥 Warmed ${ok} profile(s) — cookies/Kasada refreshed. Re-run preflight to confirm.`
    : `Warmed ${ok}/${withProfile.length}. Last error: ${lastErr}`,
    ok ? "var(--green)" : "var(--red)", 7000);
}

function pfIcon(ok) {
  if (ok === true) return { ico: "✓", cls: "ok" };
  if (ok === false) return { ico: "✕", cls: "bad" };
  return { ico: "!", cls: "warn" };
}

function renderPreflight() {
  const grid = $("preflightGrid");
  const empty = $("preflightEmpty");
  const summary = $("preflightSummary");
  if (!grid) return;

  const withProfile = accounts.filter(a => a.profileDir);
  const anyData = withProfile.some(a => preflightResults[a.profileDir]) ||
                  Object.keys(preflightResults).length > 0;

  if (!withProfile.length) {
    grid.innerHTML = "";
    if (summary) summary.innerHTML = "";
    if (empty) { empty.style.display = "block"; empty.innerHTML = "No accounts have a Chrome profile yet. Add profiles on the <strong>PROFILES</strong> page first."; }
    return;
  }
  if (empty) empty.style.display = anyData ? "none" : "block";

  const counts = { green: 0, red: 0, amber: 0, pending: 0 };
  grid.innerHTML = "";

  for (const acct of withProfile) {
    const checks = mergedChecksFor(acct);
    const rec = checks.__rec || {};
    // A profile that was launched for preflight but never reported back within
    // the grace window almost always means it isn't logged in (Nike redirected
    // its /sg/member page to login, dropping our marker) or the tab didn't open.
    // Surface that as a hard fail instead of an eternal "CHECKING…".
    const PREFLIGHT_TIMEOUT_MS = 40000;
    const timedOut = rec.__pending && !rec.ts && rec.startedAt &&
                     (Date.now() - rec.startedAt > PREFLIGHT_TIMEOUT_MS);
    const pendingRun = rec.__pending && !rec.ts && !timedOut;
    const verdict = pendingRun ? "pending" : (timedOut ? "red" : preflightVerdict(checks));
    counts[verdict] = (counts[verdict] || 0) + 1;

    if (timedOut && !checks.login) {
      checks.login = { ok: false, detail: "no response — is this profile logged in / did the tab open?" };
    }

    const card = el("div", { className: `pf-card ${verdict}` });
    const head = el("div", { className: "pf-card-head" });
    head.appendChild(el("span", { className: "pf-card-name" }, acct.label || acct.profileDir));
    // Region tag (SG/MY/?) — manual override or phone-detected.
    const reg = effectiveRegionFor(acct);
    const overridden = acct.regionOverride === "SG" || acct.regionOverride === "MY";
    const regCls = reg === "SG" ? "sg" : reg === "MY" ? "my" : "unknown";
    head.appendChild(el("span", { className: `pf-region ${regCls}`,
      title: overridden ? "Region set manually" : "Region detected from phone number" },
      (reg === "SG" ? "🇸🇬 SG" : reg === "MY" ? "🇲🇾 MY" : "? REGION") + (overridden ? " ·set" : "")));
    const verdictText = pendingRun ? "CHECKING…"
      : timedOut ? "NO RESPONSE"
      : verdict === "green" ? "READY"
      : verdict === "red" ? "BLOCKED"
      : verdict === "amber" ? "REVIEW" : "NO DATA";
    head.appendChild(el("span", { className: `pf-card-verdict ${verdict}` }, verdictText));
    card.appendChild(head);

    const list = el("div", { className: "pf-checks" });
    for (const def of PF_CHECK_DEFS) {
      const c = checks[def.key] || { ok: null, detail: pendingRun ? "checking…" : "not checked yet" };
      const { ico, cls } = pfIcon(c.ok);
      const row = el("div", { className: `pf-check ${cls}` });
      row.appendChild(el("span", { className: "ico" }, ico));
      row.appendChild(el("span", { className: "lbl" }, def.label));
      row.appendChild(el("span", { className: "dtl" }, c.detail || ""));
      list.appendChild(row);
    }
    card.appendChild(list);

    // ── Remediation actions for a non-green profile ──
    if (!pendingRun && (verdict === "red" || verdict === "amber")) {
      const actions = el("div", { className: "pf-actions" });
      const addBtn = (label, kind) => {
        const b = el("button", { className: "btn btn-mini btn-dark" }, label);
        b.addEventListener("click", () => remediateProfile(acct.profileDir, kind));
        actions.appendChild(b);
      };
      if (checks.login && checks.login.ok === false) addBtn("🔑 LOG IN", "login");
      if (checks.version && checks.version.ok === false) addBtn("⬆ UPDATE", "version");
      if (checks.cookies && checks.cookies.ok !== true) addBtn("🔥 WARM", "warm");
      // Always offer a plain re-check.
      const rc = el("button", { className: "btn btn-mini btn-dark" }, "↻ RE-CHECK");
      rc.addEventListener("click", () => { if (hostOk) launchPreflightFor(acct.profileDir); });
      actions.appendChild(rc);
      card.appendChild(actions);
    }

    if (rec.ts) {
      const d = new Date(rec.ts);
      card.appendChild(el("div", { className: "pf-card-time" },
        `checked ${d.toLocaleTimeString()}${rec.version ? " · v" + rec.version : ""}`));
    }
    grid.appendChild(card);
  }

  if (summary) {
    const chip = (n, label, color) =>
      `<div class="pf-chip" style="color:${color}"><span class="n">${n}</span><span>${label}</span></div>`;
    const rc = { SG: 0, MY: 0, unknown: 0 };
    for (const acct of withProfile) { const r = effectiveRegionFor(acct); rc[r === "SG" ? "SG" : r === "MY" ? "MY" : "unknown"]++; }
    summary.innerHTML =
      chip(counts.green, "READY", "var(--green)") +
      chip(counts.amber, "REVIEW", "var(--orange)") +
      chip(counts.red, "BLOCKED", "var(--red)") +
      (counts.pending ? chip(counts.pending, "CHECKING", "var(--purple2)") : "") +
      `<div class="pf-chip-sep"></div>` +
      chip(rc.SG, "🇸🇬 SG", "var(--green)") +
      chip(rc.MY, "🇲🇾 MY", "var(--purple2)") +
      (rc.unknown ? chip(rc.unknown, "? REGION", "#8a8a9e") : "");
  }

  // Open-by-region toolbar: open just the SG or just the MY profiles, now.
  // Additive — click SG and MY to open both.
  const bar = $("preflightRegionBar");
  if (bar) {
    const rc = { SG: 0, MY: 0 };
    for (const acct of withProfile) { const r = effectiveRegionFor(acct); if (r === "SG") rc.SG++; else if (r === "MY") rc.MY++; }
    bar.innerHTML =
      `<span class="pf-bar-lbl">Open profiles:</span>` +
      `<button id="openSGBtn" class="btn btn-mini btn-accent">🇸🇬 OPEN SG (${rc.SG})</button>` +
      `<button id="openMYBtn" class="btn btn-mini btn-accent">🇲🇾 OPEN MY (${rc.MY})</button>` +
      `<span class="pf-bar-hint">Additive — click both to open both.</span>` +
      `<span id="preflightRegionMsg" class="status-msg" style="margin:0 0 0 10px; text-align:left; display:inline-block;"></span>`;
    const sg = $("openSGBtn"); if (sg) sg.addEventListener("click", () => launchRegion("SG"));
    const my = $("openMYBtn"); if (my) my.addEventListener("click", () => launchRegion("MY"));
  }
}

// Whether any account is currently blocked (used to gate LAUNCH ALL).
function preflightBlockers() {
  return accounts.filter(a => a.profileDir).filter(a => {
    const rec = preflightResults[a.profileDir];
    if (!rec || !rec.ts) return false; // never checked → don't block
    return preflightVerdict(mergedChecksFor(a)) === "red";
  });
}

async function refreshVersionBanner() {
  const banner = $("versionBanner");
  if (!banner) return;
  const resp = await hostSend({ cmd: "getVersions" });
  if (resp && resp.ok) {
    profileVersions = resp.versions || {};
    if (resp.latestVersion) latestVersion = resp.latestVersion;
  }
  // Also probe the local update server so we can report whether auto-update is live.
  let serverInfo = null;
  try {
    const r = await fetch("http://127.0.0.1:38473/version.json", { cache: "no-store" });
    if (r.ok) serverInfo = await r.json();
  } catch (e) { /* server not running */ }
  if (serverInfo && serverInfo.version) latestVersion = latestVersion || serverInfo.version;

  const withProfile = accounts.filter(a => a.profileDir);
  const known = withProfile.map(a => ({ acct: a, v: (profileVersions[a.profileDir] || {}).version }))
                           .filter(x => x.v);
  const stale = latestVersion
    ? known.filter(x => cmpVer(x.v, latestVersion) < 0)
    : [];
  const unknown = withProfile.length - known.length;

  let cls, title, detail;
  if (!latestVersion) {
    cls = "warn";
    title = "Update server offline";
    detail = "Start it: <code>node update-server/server.js</code> (or run the installer). Can't tell which profiles are stale without it.";
  } else if (stale.length) {
    cls = "bad";
    title = `${stale.length} profile(s) on an OLD version`;
    detail = `Latest is v${latestVersion}. In each stale profile open chrome://extensions → Update, or just wait — auto-update pulls it within ~5h.`;
  } else if (unknown) {
    cls = "warn";
    title = "Some profiles haven't reported yet";
    detail = `Latest v${latestVersion}. ${known.length}/${withProfile.length} profiles reported in. Run PREFLIGHT (or launch them once) so they report their version.`;
  } else {
    cls = "ok";
    title = `All profiles on v${latestVersion}`;
    detail = withProfile.length
      ? "Every profile with a version report is up to date. 🎉"
      : "No profiles configured yet.";
  }

  const pills = known.map(x => {
    const isStale = latestVersion && cmpVer(x.v, latestVersion) < 0;
    return `<span class="vb-pill ${isStale ? "stale" : "good"}">${escapeHtml(x.acct.label || x.acct.profileDir)}: v${escapeHtml(x.v)}</span>`;
  }).join("");

  banner.className = "version-banner " + cls;
  banner.innerHTML =
    `<span class="vb-title">${escapeHtml(title)}</span>` +
    `<span class="vb-spacer"></span>` +
    (serverInfo ? `<span class="vb-pill good">server v${escapeHtml(serverInfo.version)}</span>` : `<span class="vb-pill stale">server offline</span>`) +
    `<div style="flex-basis:100%; height:0;"></div>` +
    `<span class="hint" style="margin:4px 0 0;">${detail}</span>` +
    (pills ? `<div style="flex-basis:100%; height:2px;"></div>${pills}` : "");
}

async function runPreflight() {
  const msg = $("preflightMsg");
  const withProfile = accounts.filter(a => a.profileDir);
  if (!withProfile.length) {
    flashTemp(msg, "No accounts have a Chrome profile set. Add them on PROFILES first.", "var(--orange)", 5000);
    return;
  }
  if (!hostOk) {
    const up = await pingHost();
    if (!up) {
      flashTemp(msg, "Launcher offline — install/start the native host first (SETTINGS → setup).", "var(--orange)", 6000);
      return;
    }
  }
  // Save config first so each profile's boot has current data (and so the
  // card/target local checks match what we're about to launch).
  await saveAll(true);

  // Mark every target profile as pending so the UI shows CHECKING immediately.
  // startedAt lets us flag profiles that never report back (e.g. a logged-out
  // profile whose /sg/member page redirected to login, dropping our marker).
  for (const a of withProfile) {
    preflightResults[a.profileDir] = { __pending: true, startedAt: Date.now(), profileDir: a.profileDir };
  }
  renderPreflight();
  navigateTo("preflight");

  flash(msg, `Opening ${withProfile.length} profile(s) to health-check…`, "#888");
  let opened = 0, lastErr = "";
  for (const a of withProfile) {
    const resp = await launchPreflightFor(a.profileDir);
    if (resp.ok) opened++; else lastErr = resp.error || "unknown";
    await new Promise(r => setTimeout(r, 400));
  }
  if (opened === withProfile.length) {
    flashTemp(msg, `🩺 Checking ${opened} profile(s)… results appear below as each finishes (tabs close themselves).`, "var(--green)", 8000);
  } else if (opened > 0) {
    flashTemp(msg, `Started ${opened}/${withProfile.length}. Last error: ${lastErr}`, "var(--orange)", 7000);
  } else {
    flashTemp(msg, `Couldn't open any profile. ${lastErr || "Is the launcher installed?"}`, "var(--red)", 7000);
  }
}

// Launch ONE profile on the preflight page (marks it pending first).
async function launchPreflightFor(profileDir) {
  preflightResults[profileDir] = { __pending: true, startedAt: Date.now(), profileDir };
  if (isVisible("preflight")) renderPreflight();
  const sep = NIKE_PREFLIGHT_URL.includes("#") ? "&" : "#";
  const url = `${NIKE_PREFLIGHT_URL}${sep}snkrsPreflight=${encodeURIComponent(profileDir)}`;
  return hostSend({ cmd: "launch", profileDir, url });
}

// ── Preflight remediation: one-click fix for a red/amber profile ──
// Opens the profile at the page that fixes the specific problem, then
// re-runs its preflight so the card goes green without a full re-check.
async function remediateProfile(profileDir, kind) {
  const msg = $("preflightMsg");
  const urls = {
    login:   NIKE_LOGIN_URL,                                   // sign in
    version: "chrome://extensions/",                           // click Update
    warm:    WARMUP_URL,                                       // warm Kasada/cookies
  };
  const url = urls[kind];
  if (!url) return;
  const resp = await hostSend({ cmd: "launch", profileDir, url });
  if (!resp.ok) {
    flashTemp(msg, `Couldn't open ${profileDir}: ${resp.error || (resp.hostMissing ? "launcher offline" : "unknown")}`, "var(--red)", 6000);
    return;
  }
  if (kind === "warm") await markWarm(profileDir);
  const note = kind === "login" ? "Sign in there, then it re-checks automatically."
    : kind === "version" ? "Click Update on the extension, then it re-checks."
    : "Let the feed load to warm cookies, then it re-checks.";
  flashTemp(msg, `Opened ${profileDir} — ${note}`, "var(--green)", 8000);
  // Give the user time to act, then re-run this profile's preflight.
  const delay = kind === "login" ? 25000 : kind === "version" ? 12000 : 12000;
  setTimeout(() => { if (hostOk) launchPreflightFor(profileDir); }, delay);
}

// Poll the shared preflight folder (results arrive from OTHER Chrome profiles).
function startPreflightPolling() {
  if (preflightPollTimer) clearInterval(preflightPollTimer);
  const tick = async () => {
    const resp = await hostSend({ cmd: "getPreflight" });
    if (!resp || !resp.ok) return;
    if (resp.latestVersion) latestVersion = resp.latestVersion;
    let changed = false;
    for (const [pd, entry] of Object.entries(resp.preflight || {})) {
      const cur = preflightResults[pd];
      if (!cur || cur.ts !== entry.ts || cur.__pending) {
        preflightResults[pd] = entry;
        changed = true;
      }
    }
    // Re-render on any change, OR while entries are still pending so the
    // no-response timeout can flip a stuck profile to a hard fail on schedule.
    const anyPending = Object.values(preflightResults).some(r => r && r.__pending && !r.ts);
    if (isVisible("preflight") && (changed || anyPending)) { renderPreflight(); refreshVersionBanner(); }
  };
  tick();
  preflightPollTimer = setInterval(tick, 2500);
}

// ── LIVE MONITOR (cyber command center) ───────────────────────
// One panel per browser/profile; inside it a tile per live TAB, so you oversee
// every product tab in every Chrome at once. Fed by the per-tab liveStatuses.
function liveGroupOf(code) {
  if (code === "error") return "error";
  if (code === "win" || code === "success") return "done";
  if (code === "waiting") return "waiting";
  if (["checkout", "delivery", "payment", "submitting", "pending", "polling"].includes(code)) return "active";
  return "idle";
}
function fmtClock(ts) {
  if (!ts) return "";
  const d = new Date(ts); const p = n => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function renderLivePage() {
  const grid = $("liveGrid");
  if (!grid) return;
  const empty = $("liveEmpty");
  const now = Date.now();

  // Group non-stale tab entries by profile. Normalise the profile id defensively
  // (strip any accidental "#tabId" suffix from older builds) so tabs always
  // group under their account instead of leaking the internal key as a panel.
  const byProfile = {};
  for (const e of Object.values(liveStatuses)) {
    if (!e || !e.profileDir) continue;
    if (e.time && now - e.time > STALE_MS) continue; // drop dead tabs
    const pdir = String(e.profileDir).split("#")[0];
    (byProfile[pdir] = byProfile[pdir] || []).push(e);
  }

  // Every account with a profile gets a panel (even if idle / not launched).
  const profiles = [];
  const seen = new Set();
  accounts.forEach(a => {
    if (!a.profileDir || seen.has(a.profileDir)) return;
    seen.add(a.profileDir);
    profiles.push({ dir: a.profileDir, label: (a.label && a.label.trim()) || a.profileDir });
  });
  // Include any profile reporting status that isn't in the accounts list.
  Object.keys(byProfile).forEach(dir => { if (!seen.has(dir)) { seen.add(dir); profiles.push({ dir, label: dir }); } });

  const counts = { active: 0, waiting: 0, error: 0, done: 0, idle: 0, tabs: 0 };
  let html = "";

  profiles.forEach(p => {
    const tabs = (byProfile[p.dir] || []).slice().sort((a, b) => (a.tabId || 0) - (b.tabId || 0));
    const hasErr = tabs.some(t => t.code === "error");
    counts.tabs += tabs.length;

    let tiles = "";
    if (!tabs.length) {
      counts.idle++;
      tiles = `<div class="cy-tile idle"><div class="cy-tile-stage">— IDLE —</div><div class="cy-tile-msg">not launched</div></div>`;
    } else {
      tabs.forEach(t => {
        counts[liveGroupOf(t.code)]++;
        const meta = STATUS_META[t.code] || { text: (t.code || "IDLE").toUpperCase(), color: "#6b6b7b" };
        const attn = ATTENTION_CODES.has(t.code);
        const prod = t.label || "Nike";
        const msg = (t.message || "").replace(/\*\*/g, "");
        tiles += `<div class="cy-tile${attn ? " attn" : ""}" style="--st:${meta.color}" data-dir="${escapeHtml(p.dir)}">
          <div class="cy-tile-top">
            <span class="cy-prod">${escapeHtml(prod)}</span>
            <span class="cy-stage">${meta.text}</span>
          </div>
          <div class="cy-tile-msg">${escapeHtml(msg)}</div>
          <div class="cy-tile-foot"><span class="cy-dot"></span>${fmtClock(t.time)}${attn ? " · CLICK TO FIX" : ""}</div>
        </div>`;
      });
    }

    html += `<section class="cy-panel${hasErr ? " err" : ""}">
      <div class="cy-panel-head">
        <span class="cy-led"></span>
        <span class="cy-browser">${escapeHtml(p.label)}</span>
        <span class="cy-count">${tabs.length} TAB${tabs.length === 1 ? "" : "S"}</span>
      </div>
      <div class="cy-tiles">${tiles}</div>
    </section>`;
  });

  grid.innerHTML = html;
  if (empty) empty.style.display = counts.tabs ? "none" : "";

  grid.querySelectorAll(".cy-tile.attn").forEach(el => {
    el.addEventListener("click", () => jumpToProfile(el.dataset.dir));
  });

  const sum = $("liveSummary");
  if (sum) {
    const chip = (n, label, color) => `<div class="live-chip" style="color:${color}"><span class="n">${n}</span><span class="l">${label}</span></div>`;
    sum.innerHTML =
      `<div class="live-chip live-pulse" style="color:#22d3ee"><span class="n">●</span><span class="l">LIVE · ${counts.tabs} TABS</span></div>` +
      chip(counts.active, "RUNNING", "#8b5cf6") +
      chip(counts.waiting, "WAITING", "#a855f7") +
      chip(counts.done, "DONE", "#1db954") +
      chip(counts.error, "NEEDS FIX", "#ff2d55") +
      chip(counts.idle, "IDLE", "#6b6b7b");
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
    for (const [key, entry] of Object.entries(resp.status)) {
      const cur = liveStatuses[key];
      if (!cur || cur.time !== entry.time || cur.code !== entry.code) {
        liveStatuses[key] = entry;
        changed = true;
        // Feed resolved outcomes into the current history run (by profile).
        if (entry && ["win", "loss", "entered", "limit", "success"].includes(entry.code)) {
          if (!cur || cur.code !== entry.code) updateHistoryResult(entry.profileDir || key, entry.code === "success" ? "entered" : entry.code);
        }
      }
    }
    if (changed) refreshAllBadges();
    else if (isVisible("live")) renderLivePage(); // keep the monitor fresh
  };
  tick();
  statusPollTimer = setInterval(tick, 2500);
}

// ── Storage change listener (live status + history sync) ─
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STATUS_KEY]) {
    const newStatuses = changes[STATUS_KEY].newValue || {};
    // Propagate newly resolved statuses into the current history run (by profile).
    Object.entries(newStatuses).forEach(([key, info]) => {
      if (info && ["win", "loss", "entered", "limit", "success"].includes(info.code)) {
        const old = liveStatuses[key];
        if (!old || old.code !== info.code) updateHistoryResult(info.profileDir || key, info.code === "success" ? "entered" : info.code);
      }
    });
    // Merge (don't replace) so cross-profile entries from the poll aren't lost.
    liveStatuses = { ...liveStatuses, ...newStatuses };
    refreshAllBadges();
  }
  if (changes[HISTORY_KEY]) {
    renderHistory(changes[HISTORY_KEY].newValue || []);
    if (isVisible("history")) renderInsights();
    if (isVisible("drop")) renderSelfLearningForDrop();
  }
  if (changes[TIMELINE_KEY]) {
    // Merge the local mirror (this profile's own tabs) with polled cross-profile
    // entries so neither source clobbers the other.
    timelines = { ...timelines, ...(changes[TIMELINE_KEY].newValue || {}) };
    if (isVisible("history")) renderDropReplay();
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

  // Persisted replay timing (from the drop's per-account timeline).
  const replay = entry.replay && typeof entry.replay === "object" ? entry.replay : null;
  if (replay && Object.keys(replay).length) {
    const strip = el("div", { className: "history-replay" });
    for (const s of Object.values(replay)) {
      const acct = (entry.accounts || []).find(a => a.profileDir === s.profileDir);
      const name = (acct && (acct.label || acct.profileDir)) || s.profileDir;
      const parts = [];
      if (s.loadedT && s.filledT) parts.push(`fill ${fmtDelta(s.filledT - s.loadedT)}`);
      if (s.error) parts.push(`✕ ${String(s.error).replace(/_/g, " ")}`);
      else if (s.offsetMs != null) parts.push(`${s.offsetMs >= 0 ? "+" : "−"}${fmtDelta(Math.abs(s.offsetMs))} vs go-live`);
      else if (s.submittedT) parts.push("submitted");
      const row = el("div", { className: "history-replay-row" });
      row.appendChild(el("span", { className: "hr-name" }, name));
      row.appendChild(el("span", { className: "hr-detail" + (s.error ? " bad" : (s.offsetMs != null && s.offsetMs < 0 ? " warn" : "")) },
        parts.join(" · ") || "—"));
      strip.appendChild(row);
    }
    div.appendChild(strip);
  }
  return div;
}

// ══════════════════ DROP REPLAY / ANALYTICS ══════════════════
// Renders each account's checkout timeline for the most recent drop:
// loaded → filled → submitted timing, and how many ms before/after go-live
// the submit landed. Fed by the shared timeline folder (via the native host),
// so it shows accounts running in OTHER Chrome profiles.

const REPLAY_STAGES = [
  { code: "loaded",    label: "Loaded" },
  { code: "delivery",  label: "Delivery" },
  { code: "filled",    label: "Card filled" },
  { code: "ready",     label: "Ready" },
  { code: "submitted", label: "Submitted" },
];

function eventTime(events, code) {
  const e = events.find(x => x.code === code);
  return e ? e.t : null;
}
function fmtDelta(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + "s";
}
function labelForKey(entry) {
  const acct = accounts.find(a => a.profileDir === entry.profileDir);
  return (acct && (acct.label || acct.profileDir)) || entry.profileDir || entry.label || entry.key;
}

// Outcome for a timeline: prefer resolved draw result, else terminal event.
function replayOutcome(entry) {
  const s = bestStatusFor(entry.profileDir);
  if (s && ["win", "loss", "entered", "limit", "success"].includes(s.code)) {
    const map = { win: ["🏆 WON", "var(--green)"], loss: ["😔 LOST", "var(--red)"],
      entered: ["✓ ENTERED", "#4a90e2"], success: ["✓ ENTERED", "#4a90e2"], limit: ["⚠ LIMIT", "var(--orange)"] };
    return map[s.code];
  }
  const events = entry.events || [];
  const err = events.find(e => e.code === "error");
  if (err) return [`✕ ${(err.extra && err.extra.reason) || "error"}`.replace(/_/g, " "), "var(--red)"];
  if (eventTime(events, "submitted")) return ["🚀 SUBMITTED", "var(--purple2)"];
  if (eventTime(events, "ready")) return ["● PRIMED", "var(--orange)"];
  return ["… running", "var(--grey)"];
}

function renderDropReplay() {
  const list = $("replayList");
  if (!list) return;
  list.innerHTML = "";
  const entries = Object.values(timelines).filter(e => e && (e.events || []).length);
  if (!entries.length) {
    list.appendChild(el("p", { className: "hint" },
      "No timeline yet. Launch a drop — each account's loaded→filled→submitted timing appears here."));
    return;
  }
  // Most-recent drop first; within it, most-recently-updated account first.
  entries.sort((a, b) => (b.updated || 0) - (a.updated || 0));

  for (const entry of entries) {
    const events = entry.events || [];
    const t0 = eventTime(events, "started") || (events[0] && events[0].t);
    const submittedT = eventTime(events, "submitted");
    const submittedEv = events.find(e => e.code === "submitted");

    const card = el("div", { className: "replay-card" });

    const head = el("div", { className: "replay-head" });
    head.appendChild(el("span", { className: "replay-name" }, labelForKey(entry)));
    const [outText, outColor] = replayOutcome(entry);
    const outEl = el("span", { className: "replay-outcome" }, outText);
    outEl.style.color = outColor;
    head.appendChild(outEl);
    card.appendChild(head);

    // Timeline dots for each reached stage, with elapsed-since-start under each.
    const track = el("div", { className: "replay-track" });
    for (const st of REPLAY_STAGES) {
      const t = eventTime(events, st.code);
      const dot = el("div", { className: "replay-step" + (t ? " on" : "") });
      dot.appendChild(el("span", { className: "replay-dot" }));
      dot.appendChild(el("span", { className: "replay-step-label" }, st.label));
      dot.appendChild(el("span", { className: "replay-step-time" },
        t && t0 ? "+" + fmtDelta(t - t0) : "—"));
      track.appendChild(dot);
    }
    card.appendChild(track);

    // Key metrics row: total prep, and go-live offset for the submit.
    const metrics = el("div", { className: "replay-metrics" });
    const loadedT = eventTime(events, "loaded");
    const filledT = eventTime(events, "filled");
    if (loadedT && filledT) metrics.appendChild(el("span", { className: "replay-metric" }, `fill ${fmtDelta(filledT - loadedT)}`));
    if (filledT && submittedT) metrics.appendChild(el("span", { className: "replay-metric" }, `→submit ${fmtDelta(submittedT - filledT)}`));

    // ms before/after go-live — the headline number.
    let offsetMs = null;
    if (submittedEv && submittedEv.extra && submittedEv.extra.offsetMs != null) offsetMs = submittedEv.extra.offsetMs;
    else if (submittedT && entry.dropAt) offsetMs = submittedT - entry.dropAt;
    if (offsetMs != null) {
      const after = offsetMs >= 0;
      const badge = el("span", { className: "replay-offset " + (after ? "after" : "before") },
        `${after ? "+" : ""}${fmtDelta(Math.abs(offsetMs)).replace(/^/, offsetMs < 0 ? "-" : "")} vs go-live`);
      // simpler text:
      badge.textContent = `${after ? "+" : "−"}${fmtDelta(Math.abs(offsetMs))} vs go-live`;
      metrics.appendChild(badge);
    } else if (entry.dropAt && !submittedT) {
      metrics.appendChild(el("span", { className: "replay-metric" }, "holding for drop…"));
    }
    card.appendChild(metrics);
    list.appendChild(card);
  }
}

// ══════════════════ LIVE STATUS DIAGNOSTIC ══════════════════
// Answers "why don't I see the other profiles?" by walking the exact chain:
// this profile → native host → shared status folder → per-profile version
// reports. Pinpoints whether launched profiles are writing at all.
async function runLiveDiagnostic() {
  const out = $("liveDiag");
  if (!out) return;
  out.style.display = "block";
  out.textContent = "Running diagnostic…";
  const L = [];

  // 1) Can THIS (dashboard) profile reach the launcher?
  const ping = await hostSend({ cmd: "ping" });
  if (ping.ok) {
    L.push(`✓ This dashboard profile reaches the launcher (host v${ping.version} · ${ping.platform}).`);
    // Show how launched profiles get the extension (the "no extension on Launch
    // All" fix). Requires host v1.3.0+.
    if (ping.extensionDir) {
      L.push(`  Extension folder: ${ping.extensionDir}${ping.extensionDirValid === false ? "  (⚠ no manifest.json here!)" : ""}`);
      if (ping.loadExtensionOnLaunch)
        L.push(`  (opt-in --load-extension is ON — only affects the first fresh profile; not reliable for many profiles.)`);
    }
  } else {
    L.push(`✗ This dashboard CANNOT reach the launcher: ${ping.error || "no response"}.`);
    L.push(`  → Cross-profile status can't be read until the native host is installed for this profile.`);
    out.textContent = L.join("\n");
    return;
  }

  // 2) What's in the shared status folder (written by the launched profiles)?
  const st = await hostSend({ cmd: "getStatus" });
  const entries = (st.ok && st.status) ? Object.values(st.status) : [];
  const byProfile = {};
  entries.forEach(e => { const p = String(e.profileDir || "").split("#")[0]; if (p) (byProfile[p] = byProfile[p] || []).push(e); });
  const profs = Object.keys(byProfile);
  L.push("");
  L.push(`SHARED STATUS FOLDER — ${entries.length} tab entr${entries.length === 1 ? "y" : "ies"} from ${profs.length} profile(s):`);
  if (!entries.length) {
    L.push(`  ⚠ EMPTY. The launched profiles are NOT writing any status. Almost always one of:`);
    L.push(`     1. Those profiles run a STALE loaded copy of the extension. Unpacked extensions`);
    L.push(`        do NOT hot-reload when files change — each profile keeps the old code until you`);
    L.push(`        reload it (chrome://extensions → ↻) or fully restart that Chrome. The fix that`);
    L.push(`        removes this for good is the force-install auto-update (update-server/), which`);
    L.push(`        pushes the SAME build to every profile automatically.`);
    L.push(`     2. The native host isn't reachable from those profiles (rare if it works here).`);
  } else {
    profs.sort().forEach(p => {
      const es = byProfile[p].slice().sort((a, b) => (b.time || 0) - (a.time || 0));
      const age = Math.round((Date.now() - (es[0].time || 0)) / 1000);
      L.push(`  • ${p}: ${es.length} tab(s), latest "${es[0].code}" ${age}s ago`);
    });
    const missing = accounts.filter(a => a.profileDir && !byProfile[a.profileDir]);
    if (missing.length) {
      L.push("");
      L.push(`  ✗ NO status from: ${missing.map(a => a.label || a.profileDir).join(", ")}.`);
      L.push(`    Those profiles didn't report — likely running stale code, not launched, or their`);
      L.push(`    account's "Chrome profile" doesn't match the real profile directory.`);
    }
  }

  // 3) Which profiles have reported their extension version (i.e. booted current code)?
  const vr = await hostSend({ cmd: "getVersions" });
  if (vr.ok) {
    const vs = Object.entries(vr.versions || {});
    L.push("");
    L.push(`REPORTED VERSIONS (latest is v${vr.latestVersion || "?"}):`);
    if (!vs.length) L.push(`  ⚠ No profile has reported a version — none have booted with current code yet.`);
    let anyUnpacked = false;
    vs.sort().forEach(([p, v]) => {
      const age = Math.round((Date.now() - (v.ts || 0)) / 1000);
      const stale = vr.latestVersion && v.version !== vr.latestVersion;
      const kind = v.installType === "development" ? " · unpacked"
        : v.installType === "admin" ? " · force-installed"
        : v.installType === "normal" ? " · web-store" : "";
      if (v.installType === "development") anyUnpacked = true;
      L.push(`  • ${p}: v${v.version}${kind}${stale ? "  ← STALE, restart this profile" : ""} (${age}s ago)`);
    });
    if (anyUnpacked) {
      L.push("");
      L.push(`  ℹ Unpacked profiles only pick up new code when that profile's Chrome fully RESTARTS.`);
      L.push(`    To make them all current now: quit Chrome COMPLETELY (check Task Manager for stray`);
      L.push(`    chrome.exe), then reopen. To stop managing versions by hand, force-install`);
      L.push(`    (update-server/install-windows.bat) so every profile auto-updates.`);
    }
  }

  out.textContent = L.join("\n");
}

// ══════════════════ PANIC / GLOBAL ABORT ══════════════════
// Raises (or clears) a shared abort flag that every profile's checkout script
// polls while holding SUBMIT — one click stops all held submits at once.
async function setAbort(on) {
  const resp = await hostSend({ cmd: "setAbort", on });
  return resp && resp.ok;
}
async function refreshPanicBanner() {
  const banner = $("panicBanner");
  const btn = $("panicBtn");
  if (!banner) return;
  const resp = await hostSend({ cmd: "getAbort" });
  const on = !!(resp && resp.ok && resp.abort && resp.abort.on);
  if (on) {
    banner.style.display = "flex";
    banner.className = "panic-banner active";
    const when = resp.abort.ts ? new Date(resp.abort.ts).toLocaleTimeString() : "";
    banner.innerHTML =
      `<span>🛑 <strong>ABORT ACTIVE</strong> — every profile is holding / not submitting${when ? " (since " + when + ")" : ""}.</span>` +
      `<button id="panicClearBtn" class="btn btn-mini btn-light">✓ CLEAR ABORT</button>`;
    const clr = $("panicClearBtn");
    if (clr) clr.addEventListener("click", async () => {
      await setAbort(false);
      await refreshPanicBanner();
      flashTemp($("statusMsg"), "Abort cleared — profiles may submit again on the next drive.", "#888");
    });
    if (btn) { btn.textContent = "🛑 ABORT ACTIVE"; btn.disabled = true; }
  } else {
    banner.style.display = "none";
    if (btn) { btn.textContent = "🛑 PANIC — STOP ALL SUBMITS"; btn.disabled = false; }
  }
}
async function raisePanic() {
  const ok = await setAbort(true);
  if (!ok) {
    flashTemp($("statusMsg"), "Couldn't raise abort — is the launcher connected?", "var(--red)", 6000);
    return;
  }
  await refreshPanicBanner();
  flashTemp($("statusMsg"), "🛑 ABORT raised — all holding profiles will cancel their SUBMIT.", "var(--red)", 8000);
}

// CLOSE ALL: raise a shared close flag every profile's content scripts poll,
// closing their bot windows within a couple of seconds. Auto-clears so it can't
// linger and close the next launch.
async function closeAllProfiles() {
  if (!confirm("Close every profile's Nike/checkout windows now? (The dashboard stays open.)")) return;
  const resp = await hostSend({ cmd: "setClose", on: true });
  if (!resp || !resp.ok) {
    flashTemp($("statusMsg"), "Couldn't send close — is the launcher connected?", "var(--red)", 6000);
    return;
  }
  flashTemp($("statusMsg"), "✖ Closing all profile windows… (takes a couple of seconds per profile)", "var(--red)", 8000);
  // Clear the flag after the pollers have had time to act, so a later launch
  // isn't immediately closed.
  setTimeout(() => { hostSend({ cmd: "setClose", on: false }); }, 8000);
}

// Compact per-account summary of a timeline, for persisting into history.
function summarizeTimeline(entry) {
  const events = entry.events || [];
  const startedT = eventTime(events, "started") || (events[0] && events[0].t) || 0;
  const submittedEv = events.find(e => e.code === "submitted");
  const submittedT = submittedEv ? submittedEv.t : null;
  let offsetMs = null;
  if (submittedEv && submittedEv.extra && submittedEv.extra.offsetMs != null) offsetMs = submittedEv.extra.offsetMs;
  else if (submittedT && entry.dropAt) offsetMs = submittedT - entry.dropAt;
  const err = events.find(e => e.code === "error");
  return {
    profileDir: entry.profileDir || "",
    startedT,
    loadedT: eventTime(events, "loaded"),
    filledT: eventTime(events, "filled"),
    submittedT,
    dropAt: entry.dropAt || 0,
    offsetMs,
    error: err ? ((err.extra && err.extra.reason) || "error") : null,
  };
}

// Snapshot the live timelines into the CURRENT history run so past drops keep
// their timing (the live timeline store is cleared on each new launch).
async function persistTimelineToHistory() {
  if (!currentRunId) return;
  // One summary per profile — prefer the tab that actually submitted.
  const byProfile = {};
  for (const entry of Object.values(timelines)) {
    const pd = entry.profileDir;
    if (!pd) continue;
    const s = summarizeTimeline(entry);
    const prev = byProfile[pd];
    if (!prev || (s.submittedT && !prev.submittedT) || (s.startedT > prev.startedT)) byProfile[pd] = s;
  }
  if (!Object.keys(byProfile).length) return;
  const data = await chrome.storage.local.get(HISTORY_KEY);
  const history = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
  const entry = history.find(e => e.id === currentRunId);
  if (!entry) return;
  if (JSON.stringify(entry.replay || {}) === JSON.stringify(byProfile)) return; // no change
  entry.replay = byProfile;
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
}

// ══════════════════ SELF-LEARNING ══════════════════
// The bot mines its own drop history (persisted runs + per-account replay
// timings) to learn: how fast checkout fills, how close to go-live it submits,
// which sizes hit, and what usually goes wrong — then turns that into an
// Insights panel, a recommended open-lead (auto-tune), and size hints.

let _insights = null;          // cached compute
let _prepLeadSec = 0;          // user/auto-tuned open-lead (0 = default 30s)

function computeInsights(history) {
  const runs = Array.isArray(history) ? history : [];
  const out = {
    runs: runs.length,
    wins: 0, entered: 0, losses: 0, limits: 0, entries: 0,
    fills: [], offsets: [], failures: {}, sizes: {},
  };
  for (const run of runs) {
    const results = (run.results && typeof run.results === "object") ? run.results : {};
    const replay = (run.replay && typeof run.replay === "object") ? run.replay : {};
    for (const acct of (run.accounts || [])) {
      const code = results[acct.profileDir];
      const size = acct.size;
      if (size) {
        const s = out.sizes[size] || (out.sizes[size] = { size, win: 0, entered: 0, total: 0 });
        s.total++;
        if (code === "win") s.win++;
        else if (code === "entered" || code === "success") s.entered++;
      }
      if (code) {
        out.entries++;
        if (code === "win") out.wins++;
        else if (code === "loss") { out.losses++; out.failures["not selected"] = (out.failures["not selected"] || 0) + 1; }
        else if (code === "entered" || code === "success") out.entered++;
        else if (code === "limit") { out.limits++; out.failures["entry limit"] = (out.failures["entry limit"] || 0) + 1; }
      }
    }
    for (const s of Object.values(replay)) {
      if (s.loadedT && s.filledT) out.fills.push(s.filledT - s.loadedT);
      if (s.offsetMs != null) out.offsets.push(s.offsetMs);
      if (s.error) out.failures[String(s.error).replace(/_/g, " ")] = (out.failures[String(s.error).replace(/_/g, " ")] || 0) + 1;
    }
  }
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  out.avgFill = avg(out.fills);
  out.maxFill = out.fills.length ? Math.max(...out.fills) : null;
  out.avgOffset = avg(out.offsets);
  // Recommended open-lead: cover the slowest observed fill + a safety buffer,
  // clamped to a sane 20–90s window. Null until we have fill data.
  out.recommendedLeadSec = out.maxFill != null
    ? Math.max(20, Math.min(90, Math.ceil(out.maxFill / 1000) + 15))
    : null;
  const failEntries = Object.entries(out.failures).sort((a, b) => b[1] - a[1]);
  out.topFailure = failEntries.length ? failEntries[0] : null;
  out.winRate = out.entries ? (out.wins + out.entered) / out.entries : null;
  out.topSizes = Object.values(out.sizes)
    .map(s => ({ ...s, rate: s.total ? (s.win + s.entered) / s.total : 0 }))
    .sort((a, b) => b.rate - a.rate || b.total - a.total);
  return out;
}

async function loadInsights() {
  const d = await chrome.storage.local.get(HISTORY_KEY);
  _insights = computeInsights(Array.isArray(d[HISTORY_KEY]) ? d[HISTORY_KEY] : []);
  return _insights;
}

async function renderInsights() {
  const body = $("insightsBody");
  const msg = $("insightsMsg");
  if (!body) return;
  const ins = await loadInsights();
  if (!ins.runs) {
    body.innerHTML = "";
    if (msg) msg.textContent = "The bot studies every drop it runs. Run a few and it learns your fill speed, timing margin, and which sizes hit.";
    return;
  }
  if (msg) msg.textContent = `Learned from ${ins.runs} drop${ins.runs > 1 ? "s" : ""} · ${ins.entries} entr${ins.entries === 1 ? "y" : "ies"}.`;

  const fmtMs = (ms) => ms == null ? "—" : ms < 1000 ? Math.round(ms) + "ms" : (ms / 1000).toFixed(1) + "s";
  const tile = (val, label, cls) => `<div class="insight-tile ${cls || ""}"><div class="it-val">${val}</div><div class="it-label">${label}</div></div>`;

  const offTxt = ins.avgOffset == null ? "—"
    : (ins.avgOffset >= 0 ? "+" : "−") + fmtMs(Math.abs(ins.avgOffset));
  const winPct = ins.winRate == null ? "—" : Math.round(ins.winRate * 100) + "%";

  let html = `<div class="insight-tiles">` +
    tile(winPct, "hit rate", ins.winRate >= 0.5 ? "good" : "") +
    tile(fmtMs(ins.avgFill), "avg fill time") +
    tile(offTxt, "avg submit vs go-live", ins.avgOffset != null && ins.avgOffset < 0 ? "warn" : "good") +
    tile(ins.wins, "wins", ins.wins ? "good" : "") +
    `</div>`;

  // Recommendation line.
  const recs = [];
  if (ins.recommendedLeadSec != null) {
    const curLead = _prepLeadSec || 30;
    if (ins.recommendedLeadSec > curLead + 3)
      recs.push(`⏱ Your slowest checkout filled in ${fmtMs(ins.maxFill)} — open accounts <strong>${ins.recommendedLeadSec}s</strong> early (currently ${curLead}s) so nothing's still filling at go-live.`);
    else
      recs.push(`✅ Fills complete well within your ${curLead}s open-lead — timing margin looks safe.`);
  }
  if (ins.avgOffset != null && ins.avgOffset < -150)
    recs.push(`⚠ On average you submit <strong>${fmtMs(Math.abs(ins.avgOffset))} early</strong> — that risks LAUNCH_NOT_ACTIVE. The drop-time gate should hold to exactly go-live.`);
  if (ins.topFailure && ins.topFailure[1] >= 2)
    recs.push(`🔎 Most common issue: <strong>${escapeHtml(ins.topFailure[0])}</strong> (${ins.topFailure[1]}×).`);
  if (recs.length) html += `<div class="insight-recs">` + recs.map(r => `<div class="insight-rec">${r}</div>`).join("") + `</div>`;

  // Top sizes by hit rate.
  if (ins.topSizes.length) {
    const rows = ins.topSizes.slice(0, 6).map(s =>
      `<div class="size-stat"><span class="ss-size">${escapeHtml(s.size)}</span>` +
      `<span class="ss-bar"><span class="ss-fill" style="width:${Math.round(s.rate * 100)}%"></span></span>` +
      `<span class="ss-rate">${Math.round(s.rate * 100)}% <span class="muted">(${s.win + s.entered}/${s.total})</span></span></div>`).join("");
    html += `<div class="insight-sizes"><div class="insight-sub">HIT RATE BY SIZE</div>${rows}</div>`;
  }
  body.innerHTML = html;
}

// Drop-page self-learning: recommended open-lead (auto-tune) + size hints.
async function renderSelfLearningForDrop() {
  const ins = await loadInsights();

  // Auto-tune box.
  const box = $("autoTuneBox"), txt = $("autoTuneText");
  if (box && txt) {
    if (ins.recommendedLeadSec != null) {
      const cur = _prepLeadSec || 30;
      box.style.display = "flex";
      txt.innerHTML = `🧠 Recommended open-lead <strong>${ins.recommendedLeadSec}s</strong> ` +
        `<span class="muted">(from your ${(ins.maxFill / 1000).toFixed(1)}s slowest fill · currently ${cur}s)</span>`;
      const btn = $("autoTuneApplyBtn");
      if (btn) btn.style.display = (ins.recommendedLeadSec !== cur) ? "" : "none";
    } else {
      box.style.display = "none";
    }
  }

  // Size hints.
  const sh = $("sizeHints");
  if (sh) {
    if (ins.topSizes.length && ins.entries >= 2) {
      const top = ins.topSizes.slice(0, 4).filter(s => s.total >= 1)
        .map(s => `<span class="size-hint-chip">${escapeHtml(s.size)} · ${Math.round(s.rate * 100)}%</span>`).join("");
      sh.style.display = "";
      sh.innerHTML = `<span class="muted">🧠 Best historical sizes:</span> ${top}`;
    } else {
      sh.style.display = "none";
    }
  }
}

async function applyAutoTune() {
  const ins = _insights || await loadInsights();
  if (ins.recommendedLeadSec == null) return;
  _prepLeadSec = ins.recommendedLeadSec;
  await saveAll(true);           // persists options.prepLeadSec + re-arms
  renderSelfLearningForDrop();
  flashTemp($("statusMsg"), `🧠 Open-lead set to ${_prepLeadSec}s — accounts will open that early before the drop.`, "var(--green)", 6000);
}

// Poll the shared timeline folder (accounts run in OTHER Chrome profiles).
function startTimelinePolling() {
  if (timelinePollTimer) clearInterval(timelinePollTimer);
  const tick = async () => {
    const resp = await hostSend({ cmd: "getTimeline" });
    if (!resp || !resp.ok || !resp.timeline) return;
    let changed = false;
    for (const [k, entry] of Object.entries(resp.timeline)) {
      const cur = timelines[k];
      if (!cur || cur.updated !== entry.updated || (cur.events || []).length !== (entry.events || []).length) {
        timelines[k] = entry;
        changed = true;
      }
    }
    if (changed) {
      persistTimelineToHistory();
      if (isVisible("history")) renderDropReplay();
    }
  };
  tick();
  timelinePollTimer = setInterval(tick, 2500);
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
  if (typeof renderProxyAssignments === "function") renderProxyAssignments();
}

function buildAccountRow(acct) {
  const tpl = $("accountRowTpl").content.cloneNode(true);
  const row = tpl.querySelector(".acct");

  const labelEl     = row.querySelector(".f-label");
  const profileEl   = row.querySelector(".f-profile");
  const manualEl    = row.querySelector(".f-profile-manual");
  const sizeEl      = row.querySelector(".f-size");
  const autoEl      = row.querySelector(".f-autolaunch");
  const regionEl    = row.querySelector(".f-region");
  const cardSel     = row.querySelector(".f-card-select");
  const msgEl       = row.querySelector(".acct-msg");
  const assignedEl  = row.querySelector(".f-assigned");
  const statusRow   = row.querySelector(".f-status-row");
  const statusBadge = row.querySelector(".f-status-badge");
  const statusText  = row.querySelector(".f-status-text");
  const statusTime  = row.querySelector(".f-status-time");

  labelEl.value = acct.label || "";
  autoEl.checked = !!acct.autoLaunch;
  if (regionEl) regionEl.value = (acct.regionOverride === "SG" || acct.regionOverride === "MY") ? acct.regionOverride : "auto";
  fillSizeSelect(sizeEl, acct.size, acct.sizeType);
  fillProfileSelect(profileEl, manualEl, acct.profileDir);

  cardSel.dataset.acctId = acct.id;
  fillCardSelect(cardSel, acct.cardId);

  // Show what this account will open. Multi-product: one tab per product with
  // its size; single-product: a ⚡ marker when a direct checkout URL is ready.
  if (multiProduct && Array.isArray(acct.targets) && acct.targets.length) {
    const built = acct.targets.filter(t => t.checkoutUrl).length;
    const parts = acct.targets.map(t => `${t.keyword || shortUrl(t.url)}${t.size ? " " + t.size : ""}`);
    assignedEl.style.display = "";
    assignedEl.textContent = `→ ${acct.targets.length} tab(s): ${parts.join(", ")}` +
      (built ? `  ·  ⚡ ${built} direct` : "");
  } else if (acct.checkoutUrl) {
    assignedEl.style.display = "";
    assignedEl.textContent = "⚡ direct checkout";
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
  if (regionEl) regionEl.addEventListener("change", () => {
    acct.regionOverride = regionEl.value === "auto" ? "" : regionEl.value;
    saveAll(true);
    if (isVisible("preflight")) renderPreflight();
  });
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

// ── Proxy + notification config (Settings) ────────────────────
function proxyLines() {
  const raw = ($("proxyList") && $("proxyList").value) || "";
  return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

function buildProxyConfig() {
  const enabled = !!($("proxyEnabled") && $("proxyEnabled").checked);
  const mode = ($("proxyMode") && $("proxyMode").value) || "list";
  const list = proxyLines();
  const gateway = (($("proxyGateway") && $("proxyGateway").value) || "").trim();
  // Prune stale swap overrides: keep only overrides whose proxy is still in the
  // current list (a proxy the user deleted can't stay assigned).
  const inList = new Set(list);
  const assignments = {};
  for (const [dir, px] of Object.entries(proxyAssignments)) {
    if (inList.has(px)) assignments[dir] = px;
  }
  proxyAssignments = assignments;
  return {
    enabled,
    mode,
    list,
    gateway,
    assignments,
    // Flag so a launched profile knows to CLEAR its proxy when we turn this off
    // (rather than only ever setting one).
    hadProxy: enabled || list.length > 0 || !!gateway,
  };
}

// Deterministic DEFAULT proxy for an account — mirrors the background's sticky
// mapping (accounts sorted by profileDir, round-robin over the list).
function defaultProxyForDir(dir) {
  const list = proxyLines();
  if (!list.length) return "";
  const dirs = (accounts || []).map(a => a && a.profileDir).filter(Boolean).sort();
  let i = dirs.indexOf(dir);
  if (i < 0) i = 0;
  return list[i % list.length];
}

// The proxy an account is CURRENTLY on (a manual swap override wins).
function currentProxyForDir(dir) {
  if (proxyAssignments[dir]) return proxyAssignments[dir];
  return defaultProxyForDir(dir);
}

// Pick the next proxy after `cur`, preferring one no other account is using so a
// dead resi is actually REPLACED (not just rotated onto another in-use IP).
function nextProxyAfter(cur, list, excludeDir) {
  const used = new Set((accounts || [])
    .map(a => a && a.profileDir).filter(d => d && d !== excludeDir)
    .map(d => currentProxyForDir(d)));
  const start = Math.max(0, list.indexOf(cur));
  for (let step = 1; step <= list.length; step++) {
    const cand = list[(start + step) % list.length];
    if (cand === cur) continue;
    if (!used.has(cand)) return cand;
  }
  // Every other proxy is already in use — still move off the (dead) current one.
  return list[(start + 1) % list.length];
}

// Swap one account onto a fresh proxy and relaunch it there. Used drop-day when
// a residential IP dies with the tab still open.
async function swapProxyForAccount(dir) {
  const list = proxyLines();
  const msgEl = $("proxyTestMsg");
  if (list.length < 2) { if (msgEl) flashTemp(msgEl, "Add more proxies to the list to have spares to swap in.", "var(--orange)", 5000); return; }
  const acct = (accounts || []).find(a => a && a.profileDir === dir);
  if (!acct) return;
  const chosen = nextProxyAfter(currentProxyForDir(dir), list, dir);
  proxyAssignments[dir] = chosen;
  renderProxyAssignments();
  // Persist the new assignment first so it sticks even if the profile isn't
  // currently launch-valid; then boot the profile — its background re-applies
  // the new proxy on boot (boot_fetch_settings).
  await saveAll(true);
  await launchAccount(acct, msgEl);
  if (msgEl) flashTemp(msgEl, `⟳ ${escapeHtml(acct.label || dir)} → ${escapeHtml(maskProxy(chosen))} (relaunched on the new IP).`, "var(--green)", 7000);
}

// Rotate EVERY account onto its next proxy — for when a whole batch/subnet dies.
async function rotateAllProxies() {
  const list = proxyLines();
  const msgEl = $("proxyTestMsg");
  if (list.length < 2) { if (msgEl) flashTemp(msgEl, "Add more proxies to rotate between.", "var(--orange)", 5000); return; }
  const withDir = (accounts || []).filter(a => a && a.profileDir);
  if (!withDir.length) return;
  if (!confirm(`Rotate all ${withDir.length} account(s) to a different IP and relaunch them?`)) return;
  for (const a of withDir) {
    const cur = currentProxyForDir(a.profileDir);
    const idx = Math.max(0, list.indexOf(cur));
    proxyAssignments[a.profileDir] = list[(idx + 1) % list.length];
  }
  renderProxyAssignments();
  await saveAll(true);
  let ok = 0;
  for (const a of withDir) { await launchAccount(a, msgEl); ok++; }
  if (msgEl) flashTemp(msgEl, `⟳ Rotated ${withDir.length} account(s) — relaunched on new IPs.`, "var(--green)", 7000);
}

function buildNotifyConfig() {
  const evt = (id) => !!($(id) && $(id).checked);
  return {
    enabled: !!($("notifyEnabled") && $("notifyEnabled").checked),
    webhook: (($("notifyWebhook") && $("notifyWebhook").value) || "").trim(),
    telegramToken: (($("notifyTgToken") && $("notifyTgToken").value) || "").trim(),
    telegramChatId: (($("notifyTgChat") && $("notifyTgChat").value) || "").trim(),
    events: {
      win:        evt("notifyEvtWin"),
      success:    evt("notifyEvtWin"),   // "Won / order confirmed" is one toggle
      entered:    evt("notifyEvtEntered"),
      submitting: evt("notifyEvtSubmitting"),
      error:      evt("notifyEvtError"),
      loss:       evt("notifyEvtLoss"),
      limit:      evt("notifyEvtError"), // group entry-limit under "problems"
    },
  };
}

// Show the list box or the single-gateway box depending on the chosen mode.
function syncProxyModeUI() {
  const mode = ($("proxyMode") && $("proxyMode").value) || "list";
  const listWrap = $("proxyListWrap");
  const gwWrap = $("proxyGatewayWrap");
  if (listWrap) listWrap.style.display = mode === "list" ? "" : "none";
  if (gwWrap) gwWrap.style.display = mode === "gateway" ? "" : "none";
}

// Mask credentials so the preview never shows the password.
function maskProxy(str) {
  const s = String(str || "").trim();
  if (!s) return "";
  // Strip scheme + any user:pass@, then keep host:port from either style.
  let body = s.replace(/^(https?|socks5|socks4):\/\//i, "");
  const at = body.lastIndexOf("@");
  if (at >= 0) body = body.slice(at + 1);
  const parts = body.split(":");
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : body;
}

// Preview which account gets which IP — same deterministic sticky mapping the
// background uses (accounts sorted by profileDir, round-robin over the list).
function renderProxyAssignments() {
  const el = $("proxyAssignPreview");
  if (!el) return;
  const mode = ($("proxyMode") && $("proxyMode").value) || "list";
  const withDir = (accounts || []).filter(a => a && a.profileDir);
  if (!withDir.length) { el.innerHTML = '<span class="muted">Add accounts (with a Chrome profile) to see IP assignments.</span>'; return; }
  let rows = "";
  if (mode === "gateway") {
    const gw = maskProxy(($("proxyGateway") && $("proxyGateway").value) || "");
    if (!gw) { el.innerHTML = '<span class="muted">Enter a gateway endpoint above.</span>'; return; }
    rows = withDir.map(a => `<div class="pa-row"><span>${escapeHtml(a.label || a.profileDir)}</span><span class="muted">→ ${escapeHtml(gw)} <em>(rotating)</em></span></div>`).join("");
  } else {
    const list = proxyLines();
    if (!list.length) { el.innerHTML = '<span class="muted">Paste one proxy per line above.</span>'; return; }
    const sorted = withDir.slice().sort((a, b) => a.profileDir.localeCompare(b.profileDir));
    const canSwap = list.length >= 2;
    rows = sorted.map((a) => {
      const cur = currentProxyForDir(a.profileDir);
      const swapped = !!proxyAssignments[a.profileDir];
      const swapBtn = canSwap
        ? `<button class="pa-swap" data-dir="${escapeHtml(a.profileDir)}" title="Swap this account to a fresh IP and relaunch it">⟳</button>`
        : "";
      return `<div class="pa-row"><span>${escapeHtml(a.label || a.profileDir)}</span>` +
             `<span class="muted">→ ${escapeHtml(maskProxy(cur))}${swapped ? ' <em>(swapped)</em>' : ''} ${swapBtn}</span></div>`;
    }).join("");
    if (withDir.length > list.length) {
      rows += `<div class="pa-row muted" style="margin-top:4px;">⚠ ${withDir.length} accounts share ${list.length} proxies — some reuse the same IP. Add spare lines so ⟳ Swap has fresh IPs.</div>`;
    }
  }
  el.innerHTML = rows;
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
      // Self-learning auto-tune: how many seconds early to open accounts before
      // the drop (0/absent = background default of 30s).
      prepLeadSec: _prepLeadSec || 0,
      // Warm-page-then-flip-to-checkout: launch page first, switch to the gs
      // checkout link N minutes before the drop.
      warmFlipEnabled: !!($("warmFlipToggle") && $("warmFlipToggle").checked),
      flipLeadMin: $("flipLeadMin") ? (parseFloat($("flipLeadMin").value) || 7) : 7,
      // Small tiled launch windows instead of full-size.
      tileWindows: !!($("tileWindowsToggle") && $("tileWindowsToggle").checked),
      tileW: $("tileW") ? (parseInt($("tileW").value, 10) || 500) : 500,
      tileH: $("tileH") ? (parseInt($("tileH").value, 10) || 680) : 680,
    },
    proxies: buildProxyConfig(),
    notify:  buildNotifyConfig(),
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
      // Multi-product: one launch target per product (checkoutUrl + size + time).
      targets: Array.isArray(a.targets) ? a.targets.map(t => ({
        productId: t.productId || "", url: t.url || "", keyword: t.keyword || "",
        size: t.size || "", sizeType: t.sizeType || "footwear",
        checkoutUrl: t.checkoutUrl || "", dropAtMs: t.dropAtMs || 0,
      })) : [],
      autoLaunch: !!a.autoLaunch,
      regionOverride: a.regionOverride || "",   // "" = auto (detect from phone)
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
  if (msgEl) flash(msgEl, "Resolving launch(es) from Nike…", "#888");

  let ok = 0, fail = 0, notLaunch = 0; const errs = new Set();
  let nikeDropISO = "";

  // Resolve one product SKU into a checkout URL + drop time for a given size.
  // Returns { checkoutUrl, dropAtMs, dropISO } or null (records the error).
  async function resolveOne(sku, size) {
    if (!sku || !size) return null;
    let d;
    try { d = await resolveLaunch(sku); } catch (e) { d = { ok: false, error: String(e && e.message || e) }; }
    if (!d || !d.ok) {
      const er = (d && d.error) || "";
      if (er) errs.add(er);
      if (/not an upcoming launch/i.test(er)) notLaunch++;
      return null;
    }
    const match = (d.skus || []).find(s => String(s.nikeSize) === String(size));
    if (!match) { errs.add(`size ${size} not offered for ${sku}`); return null; }
    const dropAtMs = d.dropTimeISO ? Date.parse(d.dropTimeISO) : 0;
    return { checkoutUrl: buildDirectCheckoutUrl(d, match.id), dropAtMs: isNaN(dropAtMs) ? 0 : dropAtMs, dropISO: d.dropTimeISO || "" };
  }

  if (multiProduct) {
    // Each account has a target per product — build a checkout URL for each.
    for (const acct of accounts) {
      for (const t of (acct.targets || [])) {
        t.checkoutUrl = ""; t.dropAtMs = 0;
        const r = await resolveOne((t.keyword || "").toUpperCase(), t.size);
        if (!r) { fail++; continue; }
        t.checkoutUrl = r.checkoutUrl; t.dropAtMs = r.dropAtMs;
        if (r.dropISO && !nikeDropISO) nikeDropISO = r.dropISO;
        ok++;
      }
    }
  } else {
    for (const acct of accounts) {
      acct.checkoutUrl = ""; acct.dropAtMs = 0; acct.targets = [];
      const sku = skuForAccount(acct);
      if (!acct.size || !sku) continue;
      const r = await resolveOne(sku, acct.size);
      if (!r) { fail++; continue; }
      acct.checkoutUrl = r.checkoutUrl; acct.dropAtMs = r.dropAtMs;
      if (r.dropISO && !nikeDropISO) nikeDropISO = r.dropISO;
      ok++;
    }
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
      flashTemp(msgEl, `⚡ Built ${ok} direct checkout URL(s) — LAUNCH ALL opens straight onto them, skipping the size screen. (They only resolve at go-live; opening early shows Nike's error page — that's normal.)`, "#1db954", 8000);
    } else if (ok) {
      flashTemp(msgEl, `⚡ Built ${ok}; ${fail} will use the normal launch-page flow. (${[...errs][0] || ""})`, "#f0c070", 7000);
    } else if (notLaunch) {
      flashTemp(msgEl, `Sizes assigned ✓ — direct checkout skipped: not a SNKRS draw/launch product, so the normal launch page + size selection is used.`, "#f0c070", 9000);
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

// The list of pages to open for an account. Multi-product: one per product
// (each its own checkout URL + size + drop time). Single: one.
function launchTargetsFor(acct) {
  if (multiProduct && Array.isArray(acct.targets) && acct.targets.length) {
    return acct.targets
      .filter(t => (t.checkoutUrl && t.checkoutUrl.trim()) || (t.url && t.url.trim()))
      .map(t => ({
        checkoutUrl: (t.checkoutUrl || "").trim(),
        url: (t.url || "").trim(),
        dropAtMs: t.dropAtMs || 0,
        size: t.size || "",
      }));
  }
  // Single-product: one target from the account fields.
  const url = (acct.checkoutUrl && acct.checkoutUrl.trim()) || resolvedUrl(acct);
  if (!url) return [];
  return [{ checkoutUrl: (acct.checkoutUrl || "").trim(), url: resolvedUrl(acct), dropAtMs: acct.dropAtMs || 0, size: acct.size || "" }];
}

// URL-safe base64, for embedding a full gs checkout URL inside a hash param.
function b64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function warmFlipEnabled() {
  return !!($("warmFlipToggle") && $("warmFlipToggle").checked);
}

// ── Small tiled launch windows ────────────────────────────────
function tileWindowsEnabled() {
  return !!($("tileWindowsToggle") && $("tileWindowsToggle").checked);
}
function tileWH() {
  const w = $("tileW") ? parseInt($("tileW").value, 10) : NaN;
  const h = $("tileH") ? parseInt($("tileH").value, 10) : NaN;
  return {
    w: isNaN(w) ? 500 : Math.max(300, Math.min(2000, w)),
    h: isNaN(h) ? 680 : Math.max(300, Math.min(2000, h)),
  };
}
// Return { size, position } for the index-th launched profile, tiled across the
// screen — or undefined when tiling is off (Chrome then sizes the window itself).
function windowFor(index) {
  if (!tileWindowsEnabled()) return undefined;
  const { w, h } = tileWH();
  const availW = (window.screen && screen.availWidth)  || 1920;
  const availH = (window.screen && screen.availHeight) || 1040;
  const cols = Math.max(1, Math.floor(availW / w));
  const rows = Math.max(1, Math.floor(availH / h));
  const per  = cols * rows;
  const idx  = ((index % per) + per) % per;   // wrap; overlaps once the grid fills
  const x = (idx % cols) * w;
  const y = Math.floor(idx / cols) * h;
  return { size: `${w},${h}`, position: `${x},${y}` };
}
function flipLeadMs() {
  const m = $("flipLeadMin") ? parseFloat($("flipLeadMin").value) : NaN;
  const min = isNaN(m) ? 7 : Math.max(0.5, Math.min(60, m));
  return Math.round(min * 60 * 1000);
}

// Build the boot URL for one launch target.
//
// WARM → FLIP (default): open the launch PAGE first so it warms Kasada / keeps
// the profile present, and hand it the fully-marked gs.nike.com checkout URL to
// switch to a few minutes before the drop. The checkout page then loads FRESH,
// so its Kasada token is current at submit time and it never rots into
// gs.nike.com/error. Needs a checkout URL, a launch page, and a future drop.
//
// Otherwise the direct gs.nike.com checkout link is opened straight away (the
// fast flow — it only resolves at go-live; opening early shows Nike's error
// page, which is expected).
function bootUrlForTarget(acct, target) {
  const checkout = (target.checkoutUrl || "").trim();
  const page     = (target.url || "").trim();

  // Resolve this target's drop time (from the target, else the Drop Time field).
  let t = target.dropAtMs || 0;
  if (!t) { const iso = dropTimeFieldISO(); const p = iso ? Date.parse(iso) : NaN; if (!isNaN(p)) t = p; }

  // Append our #snkrsBoot / #snkrsDrop markers to a URL.
  const boot = (u) => {
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    const params = [`snkrsBoot=${encodeURIComponent(acct.profileDir)}`];
    if (t) params.push(`snkrsDrop=${t}`);
    const sep = u.includes("#") ? "&" : "#";
    return `${u}${sep}${params.join("&")}`;
  };

  if (warmFlipEnabled() && checkout && page && t && Date.now() < t) {
    const gsBoot = boot(checkout); // gs URL carrying its own boot/drop markers
    let pageUrl = page;
    if (!/^https?:\/\//i.test(pageUrl)) pageUrl = "https://" + pageUrl;
    const params = [
      `snkrsBoot=${encodeURIComponent(acct.profileDir)}`,
      `snkrsDrop=${t}`,
      `snkrsGs=${b64url(gsBoot)}`,
      `snkrsFlip=${flipLeadMs()}`,
    ];
    const sep = pageUrl.includes("#") ? "&" : "#";
    return `${pageUrl}${sep}${params.join("&")}`;
  }

  const url = checkout || page;
  if (!url) return null;
  return boot(url);
}

function validateForLaunch(acct, msgEl) {
  if (!acct.profileDir) {
    flashTemp(msgEl, "Pick a Chrome profile for this account.", "#fa5400");
    return false;
  }
  if (!launchTargetsFor(acct).length) {
    flashTemp(msgEl, multiProduct
      ? "No products assigned — run 🎲 RANDOMLY ASSIGN then ⚡ BUILD DIRECT URLS."
      : "Set the Drop URL / size first.", "#fa5400");
    return false;
  }
  return true;
}

async function launchAccount(acct, msgEl) {
  if (!validateForLaunch(acct, msgEl)) return;
  await saveAll(true); // make sure the shared file is current before boot
  const targets = launchTargetsFor(acct);
  const urls = targets.map(t => bootUrlForTarget(acct, t)).filter(Boolean);
  flash(msgEl, `Opening ${urls.length} tab(s)…`, "#888");
  // All tabs in ONE chrome command so they reliably open together.
  const idx = Math.max(0, accounts.findIndex(a => a.id === acct.id));
  const resp = await hostSend({ cmd: "launch", profileDir: acct.profileDir, urls, window: windowFor(idx) });
  if (resp.ok) {
    flashTemp(msgEl, `🚀 Launched “${acct.profileDir}” — ${urls.length} tab(s).`, "#1db954");
  } else if (resp.hostMissing) {
    flashTemp(msgEl, "Launcher offline — use ⌘ copy cmd, or install the host.", "#fa5400", 5000);
  } else {
    flashTemp(msgEl, "Launch failed: " + (resp.error || "unknown"), "#e03131", 5000);
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

  // Preflight gate: if a recent run flagged any profile BLOCKED (red), warn
  // before launching so you don't watch it fail live. Confirm-to-proceed only
  // (never a hard block — the operator always has the final call).
  const blockers = preflightBlockers();
  if (blockers.length) {
    const names = blockers.map(a => a.label || a.profileDir).join(", ");
    const proceed = confirm(
      `⚠️ Preflight flagged ${blockers.length} profile(s) as BLOCKED:\n\n${names}\n\n` +
      `These may fail at the drop (not logged in, no target, etc.). ` +
      `Open the PREFLIGHT tab to see why.\n\nLaunch anyway?`);
    if (!proceed) {
      flashTemp($("statusMsg"), `Launch cancelled — fix ${blockers.length} blocked profile(s) on PREFLIGHT first.`, "#fa5400", 6000);
      navigateTo("preflight");
      return;
    }
  }

  const config = await saveAll(true);
  await appendHistory(config);

  // Fresh drop → clear the previous run's replay timelines so the Drop Replay
  // view reflects THIS launch, and clear any stale PANIC abort so a prior
  // panic can't silently block this drop's submits.
  timelines = {};
  await chrome.storage.local.set({ [TIMELINE_KEY]: {} });
  await hostSend({ cmd: "clearTimeline" });
  await setAbort(false);
  await hostSend({ cmd: "setClose", on: false }); // clear any stale CLOSE ALL
  refreshPanicBanner();

  flash($("statusMsg"), `Launching ${all.length} profiles…`, "#888");
  let profOk = 0, tabOk = 0, warmCount = 0, lastErr = "";
  let winIdx = 0;
  for (const acct of all) {
    const win = windowFor(winIdx); winIdx++;
    const targets = launchTargetsFor(acct);
    if (!targets.length) {
      // Not configured — open a warm-up tab (idle, just warms Kasada/cookies).
      const resp = await hostSend({ cmd: "launch", profileDir: acct.profileDir, url: WARMUP_URL, window: win });
      if (resp.ok) { profOk++; warmCount++; } else lastErr = resp.error || "unknown";
      await new Promise(r => setTimeout(r, 400));
      continue;
    }
    const urls = targets.map(t => bootUrlForTarget(acct, t)).filter(Boolean);
    // All of this account's product tabs open in ONE chrome command.
    const resp = await hostSend({ cmd: "launch", profileDir: acct.profileDir, urls, window: win });
    if (resp.ok) { profOk++; tabOk += urls.length; } else lastErr = resp.error || "unknown";
    await new Promise(r => setTimeout(r, 450)); // stagger BETWEEN profiles
  }

  // You launched manually — disarm any auto-open scheduler so it can't open a
  // SECOND set of tabs at drop time (that caused duplicate submits + lag).
  await new Promise(res => chrome.runtime.sendMessage({ type: "cancel_dash_launch" }, res));

  if (profOk === all.length) {
    const tail = warmCount ? ` (${warmCount} warm-up)` : "";
    flashTemp($("statusMsg"), `🚀 Launched ${profOk} profiles · ${tabOk} product tab(s)${tail}. Auto-open disarmed. Each holds SUBMIT until drop.`, "#1db954", 8000);
  } else if (profOk > 0) {
    flashTemp($("statusMsg"), `Launched ${profOk}/${all.length}. Last error: ${lastErr}`, "#f0c070", 6000);
  } else {
    flashTemp($("statusMsg"), `Couldn't launch. ${lastErr || "Is the launcher installed?"}`, "#e03131", 6000);
  }
}

// Open ONLY the accounts of one region (SG or MY), now. Additive by design:
// launching SG never closes MY, so a Singapore + Malaysia drop is just two
// clicks. Each account keeps its stable window tile so SG and MY don't overlap.
async function launchRegion(region) {
  const msgEl = $("preflightRegionMsg") || $("statusMsg");
  const list = accounts.filter(a => a.profileDir && effectiveRegionFor(a) === region);
  if (!list.length) {
    flashTemp(msgEl, `No ${region} accounts detected yet — run Preflight, or set Region manually on the Profiles page.`, "var(--orange)", 6000);
    return;
  }

  // Preflight gate, scoped to THIS region's accounts (warn, never hard-block).
  const blockers = list.filter(a => {
    const rec = preflightResults[a.profileDir];
    return rec && rec.ts && preflightVerdict(mergedChecksFor(a)) === "red";
  });
  if (blockers.length) {
    const names = blockers.map(a => a.label || a.profileDir).join(", ");
    if (!confirm(`⚠️ Preflight flagged ${blockers.length} ${region} profile(s) as BLOCKED:\n\n${names}\n\nOpen anyway?`)) {
      flashTemp(msgEl, `Cancelled — fix ${blockers.length} blocked ${region} profile(s) first.`, "var(--orange)", 6000);
      return;
    }
  }

  await saveAll(true);
  // Clear any stale PANIC / CLOSE flag so this region's tabs can submit, and
  // disarm the auto-open scheduler so it can't open a duplicate set at drop time.
  await setAbort(false);
  await hostSend({ cmd: "setClose", on: false });
  refreshPanicBanner();
  await new Promise(res => chrome.runtime.sendMessage({ type: "cancel_dash_launch" }, res));

  const flag = region === "SG" ? "🇸🇬" : "🇲🇾";
  flash(msgEl, `Opening ${list.length} ${region} profile(s)…`, "#888");
  let profOk = 0, tabOk = 0, warmCount = 0, lastErr = "";
  for (const acct of list) {
    // Stable per-account tile (global index) so SG and MY windows don't stack.
    const win = windowFor(Math.max(0, accounts.findIndex(a => a.id === acct.id)));
    const targets = launchTargetsFor(acct);
    if (!targets.length) {
      const resp = await hostSend({ cmd: "launch", profileDir: acct.profileDir, url: WARMUP_URL, window: win });
      if (resp.ok) { profOk++; warmCount++; } else lastErr = resp.error || "unknown";
      await new Promise(r => setTimeout(r, 400));
      continue;
    }
    const urls = targets.map(t => bootUrlForTarget(acct, t)).filter(Boolean);
    const resp = await hostSend({ cmd: "launch", profileDir: acct.profileDir, urls, window: win });
    if (resp.ok) { profOk++; tabOk += urls.length; } else lastErr = resp.error || "unknown";
    await new Promise(r => setTimeout(r, 450));
  }

  if (profOk === list.length) {
    const tail = warmCount ? ` (${warmCount} warm-up)` : "";
    flashTemp(msgEl, `${flag} Opened ${profOk} ${region} profile(s) · ${tabOk} tab(s)${tail}. Each holds SUBMIT until drop.`, "var(--green)", 8000);
  } else if (profOk > 0) {
    flashTemp(msgEl, `Opened ${profOk}/${list.length} ${region}. Last error: ${lastErr}`, "#f0c070", 6000);
  } else {
    flashTemp(msgEl, `Couldn't open ${region}. ${lastErr || "Is the launcher installed?"}`, "#e03131", 6000);
  }
}

// Fallback when the host isn't installed: copy a paste-ready command.
function copyLaunchCommand(acct, msgEl) {
  if (!acct.profileDir) { flashTemp(msgEl, "Pick a profile first.", "#fa5400"); return; }
  const targets = launchTargetsFor(acct);
  const urls = targets.length
    ? targets.map(t => bootUrlForTarget(acct, t)).filter(Boolean)
    : ["https://www.nike.com/sg/launch/"];
  const cmd = urls.map(u => `chrome --profile-directory="${acct.profileDir}" "${u}"`).join(" && ");
  navigator.clipboard.writeText(cmd).then(
    () => flashTemp(msgEl, `📋 ${urls.length} command(s) copied — paste into a terminal.`, "#1db954"),
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

  _prepLeadSec = Number(opts.prepLeadSec) || 0;
  if ($("warmFlipToggle")) $("warmFlipToggle").checked = opts.warmFlipEnabled ?? true;
  if ($("flipLeadMin")) $("flipLeadMin").value = opts.flipLeadMin ?? 7;
  if ($("tileWindowsToggle")) $("tileWindowsToggle").checked = opts.tileWindows ?? true;
  if ($("tileW")) $("tileW").value = opts.tileW ?? 500;
  if ($("tileH")) $("tileH").value = opts.tileH ?? 680;
  $("optEnabled").checked = opts.enabled ?? true;
  $("optTestMode").checked = opts.testMode ?? false;
  $("optPoller").checked = opts.statusPollerEnabled ?? true;
  $("optPollerMin").value = opts.pollerIntervalMin ?? 3;
  $("logWebhook").value = opts.logWebhook || "";
  $("alertWebhook").value = opts.alertWebhook || "";

  // Proxies
  const px = cfg.proxies || {};
  if ($("proxyEnabled")) $("proxyEnabled").checked = !!px.enabled;
  if ($("proxyMode")) $("proxyMode").value = px.mode === "gateway" ? "gateway" : "list";
  if ($("proxyList")) $("proxyList").value = Array.isArray(px.list) ? px.list.join("\n") : "";
  if ($("proxyGateway")) $("proxyGateway").value = px.gateway || "";
  proxyAssignments = (px.assignments && typeof px.assignments === "object") ? { ...px.assignments } : {};
  if (typeof syncProxyModeUI === "function") syncProxyModeUI();
  if (typeof renderProxyAssignments === "function") renderProxyAssignments();

  // Outcome notifications
  const nt = cfg.notify || {};
  const nEvt = nt.events || {};
  if ($("notifyEnabled")) $("notifyEnabled").checked = !!nt.enabled;
  if ($("notifyWebhook")) $("notifyWebhook").value = nt.webhook || "";
  if ($("notifyTgToken")) $("notifyTgToken").value = nt.telegramToken || "";
  if ($("notifyTgChat")) $("notifyTgChat").value = nt.telegramChatId || "";
  // Defaults when this is a fresh config with no notify block yet.
  const dEvt = (k, def) => (k in nEvt) ? !!nEvt[k] : def;
  if ($("notifyEvtWin")) $("notifyEvtWin").checked = dEvt("win", true);
  if ($("notifyEvtEntered")) $("notifyEvtEntered").checked = dEvt("entered", true);
  if ($("notifyEvtError")) $("notifyEvtError").checked = dEvt("error", true);
  if ($("notifyEvtSubmitting")) $("notifyEvtSubmitting").checked = dEvt("submitting", false);
  if ($("notifyEvtLoss")) $("notifyEvtLoss").checked = dEvt("loss", false);

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
    targets: Array.isArray(a.targets) ? a.targets.map(t => ({ ...t })) : [],
    autoLaunch: !!a.autoLaunch,
    regionOverride: a.regionOverride || "",
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

  // ── Page navigation (sidebar) ──
  document.querySelectorAll(".side-item").forEach(tab => {
    tab.addEventListener("click", () => navigateTo(tab.dataset.nav));
  });
  // Persistent sidebar quick-actions.
  if ($("sideLaunchBtn")) $("sideLaunchBtn").addEventListener("click", launchAll);
  if ($("sidePanicBtn")) $("sidePanicBtn").addEventListener("click", raisePanic);
  if ($("sideCloseBtn")) $("sideCloseBtn").addEventListener("click", closeAllProfiles);
  navigateTo("dashboard");
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
  const _lc = $("liveClearBtn");
  if (_lc) _lc.addEventListener("click", async () => {
    await hostSend({ cmd: "clearStatus" });         // clear shared per-tab files
    await chrome.storage.local.set({ snkrsStatus: {} }); // clear local mirror
    liveStatuses = {};
    refreshAllBadges();
  });
  const _panic = $("panicBtn");
  if (_panic) _panic.addEventListener("click", raisePanic);
  const _closeAll = $("closeAllBtn");
  if (_closeAll) _closeAll.addEventListener("click", closeAllProfiles);
  if ($("liveDiagBtn")) $("liveDiagBtn").addEventListener("click", runLiveDiagnostic);
  refreshPanicBanner();

  // ── Preflight page ──
  if ($("preflightRunBtn")) $("preflightRunBtn").addEventListener("click", runPreflight);
  if ($("preflightClearBtn")) $("preflightClearBtn").addEventListener("click", async () => {
    await hostSend({ cmd: "clearPreflight" });
    preflightResults = {};
    renderPreflight();
    flashTemp($("preflightMsg"), "Preflight results cleared.", "#888");
  });
  startPreflightPolling();
  if ($("warmAllBtn")) $("warmAllBtn").addEventListener("click", warmAll);
  if ($("updateAllBtn")) $("updateAllBtn").addEventListener("click", updateAllProfiles);
  {
    const w = await chrome.storage.local.get(WARM_KEY);
    if (w[WARM_KEY]) warmTimes = w[WARM_KEY];
  }

  // ── Drop replay / analytics ──
  {
    const localTl = await chrome.storage.local.get(TIMELINE_KEY);
    if (localTl[TIMELINE_KEY]) timelines = localTl[TIMELINE_KEY];
  }
  startTimelinePolling();
  if ($("clearReplayBtn")) $("clearReplayBtn").addEventListener("click", async () => {
    timelines = {};
    await chrome.storage.local.set({ [TIMELINE_KEY]: {} });
    await hostSend({ cmd: "clearTimeline" });
    renderDropReplay();
    flashTemp($("replayMsg"), "Replay cleared.", "#888");
  });
  // Carry the single-panel entry into PRODUCT 1 (so a typed/loaded URL is never
  // lost when switching to multi). Returns product[0] after seeding.
  function carrySingleIntoProducts() {
    const su = ($("dropUrl").value || "").trim();
    const sk = ($("dropKeyword").value || "").trim();
    if (!products.length) products.push(newProduct());
    const p0 = products[0];
    if (!p0.url && su) p0.url = su;
    if (!p0.keyword && sk) p0.keyword = sk;
    if (!(p0.sizePool || []).length && singleSizePool.length) p0.sizePool = singleSizePool.slice();
    return p0;
  }

  $("multiProductToggle").addEventListener("change", () => {
    const goingMulti = $("multiProductToggle").checked;
    if (goingMulti) {
      carrySingleIntoProducts();
    } else if (products.length === 1) {
      // Coming back to a single product — pull it back into the fields so nothing
      // silently disappears from view.
      const p0 = products[0];
      if (p0.url) $("dropUrl").value = p0.url;
      if (p0.keyword) $("dropKeyword").value = p0.keyword;
      if ((p0.sizePool || []).length) singleSizePool = p0.sizePool.slice();
    }
    multiProduct = goingMulti;
    applyMultiUI();
    buildSizePool($("singleSizePool"), singleSizePool, (s) => { singleSizePool = s; });
    renderAccounts(); // refresh assigned-product notes
  });
  $("addProductBtn").addEventListener("click", () => {
    products.push(newProduct());
    renderProducts();
  });
  // One-click: single → multi carrying the current entry as PRODUCT 1 and adding
  // a blank PRODUCT 2 (e.g. the jacket + the shirt). No toggle dance.
  if ($("toMultiBtn")) $("toMultiBtn").addEventListener("click", () => {
    carrySingleIntoProducts();
    if (products.length < 2) products.push(newProduct());
    multiProduct = true;
    $("multiProductToggle").checked = true;
    applyMultiUI();
    renderAccounts();
  });
  if ($("fetchSingleMetaBtn")) $("fetchSingleMetaBtn").addEventListener("click", fetchSingleMeta);
  if ($("gsLinkGenBtn")) $("gsLinkGenBtn").addEventListener("click", generateGsLinks);
  if ($("gsLinkSku")) $("gsLinkSku").addEventListener("keydown", (e) => { if (e.key === "Enter") generateGsLinks(); });
  if ($("autoTuneApplyBtn")) $("autoTuneApplyBtn").addEventListener("click", applyAutoTune);
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
  // ── Proxies ──
  if ($("proxyMode")) $("proxyMode").addEventListener("change", () => { syncProxyModeUI(); renderProxyAssignments(); });
  if ($("proxyList")) $("proxyList").addEventListener("input", renderProxyAssignments);
  if ($("proxyGateway")) $("proxyGateway").addEventListener("input", renderProxyAssignments);
  // Per-account ⟳ swap (delegated — the preview re-renders on every change).
  if ($("proxyAssignPreview")) {
    $("proxyAssignPreview").addEventListener("click", (e) => {
      const btn = e.target.closest(".pa-swap");
      if (btn && btn.dataset.dir) swapProxyForAccount(btn.dataset.dir);
    });
  }
  if ($("rotateProxiesBtn")) $("rotateProxiesBtn").addEventListener("click", rotateAllProxies);
  if ($("saveProxyBtn")) {
    $("saveProxyBtn").addEventListener("click", async () => {
      const msgEl = $("proxyTestMsg");
      const px = buildProxyConfig();
      if (px.enabled && px.mode === "list" && !px.list.length) { if (msgEl) flashTemp(msgEl, "Paste at least one proxy, or turn proxies off.", "var(--orange)", 4000); return; }
      if (px.enabled && px.mode === "gateway" && !px.gateway) { if (msgEl) flashTemp(msgEl, "Enter the gateway endpoint, or turn proxies off.", "var(--orange)", 4000); return; }
      if (msgEl) flash(msgEl, "Saving…", "#888");
      await saveAll(true);
      // Apply immediately in THIS profile so the change takes effect now; other
      // profiles pick it up when they next boot / on their next restart.
      chrome.runtime.sendMessage({ type: "apply_proxy_now" }, () => {
        if (msgEl) flashTemp(msgEl, px.enabled ? "✓ Saved & applied. Launched profiles use their IP on next boot." : "✓ Saved. Proxies OFF — profiles use your normal IP on next boot.", "var(--green)", 6000);
      });
    });
  }
  if ($("testProxyBtn")) {
    $("testProxyBtn").addEventListener("click", () => {
      const msgEl = $("proxyTestMsg");
      const list = proxyLines();
      const mode = ($("proxyMode") && $("proxyMode").value) || "list";
      const proxy = mode === "gateway" ? (($("proxyGateway") && $("proxyGateway").value) || "").trim() : list[0];
      if (!proxy) { if (msgEl) flashTemp(msgEl, "Enter a proxy to test first.", "var(--orange)", 4000); return; }
      if (msgEl) flash(msgEl, "Testing egress IP through the proxy… (a few seconds)", "#888");
      chrome.runtime.sendMessage({ type: "test_proxy", proxy }, (resp) => {
        if (resp && resp.ok) {
          const changed = resp.changed ? "✓ different from your real IP" : "⚠ same as your real IP — proxy may be bypassed";
          const col = resp.changed ? "var(--green)" : "var(--orange)";
          if (msgEl) flashTemp(msgEl, `✓ Proxy live — egress IP ${resp.ip} (${changed}).`, col, 9000);
        } else {
          if (msgEl) flashTemp(msgEl, "Proxy test failed: " + ((resp && resp.error) || "no response"), "var(--red)", 9000);
        }
      });
    });
  }

  // ── Outcome notifications ──
  if ($("saveNotifyBtn")) {
    $("saveNotifyBtn").addEventListener("click", async () => {
      const msgEl = $("notifyTestMsg");
      const nt = buildNotifyConfig();
      if (nt.enabled && !nt.webhook && !(nt.telegramToken && nt.telegramChatId)) {
        if (msgEl) flashTemp(msgEl, "Add a Discord webhook or Telegram token+chat first.", "var(--orange)", 5000); return;
      }
      if (msgEl) flash(msgEl, "Saving…", "#888");
      await saveAll(true);
      if (msgEl) flashTemp(msgEl, nt.enabled ? "✓ Saved — every launched account will ping on these events." : "✓ Saved (notifications off).", "var(--green)", 5000);
    });
  }
  if ($("testNotifyBtn")) {
    $("testNotifyBtn").addEventListener("click", () => {
      const msgEl = $("notifyTestMsg");
      const cfg = buildNotifyConfig();
      if (!cfg.webhook && !(cfg.telegramToken && cfg.telegramChatId)) { if (msgEl) flashTemp(msgEl, "Add a Discord webhook or Telegram token+chat first.", "var(--orange)", 5000); return; }
      if (msgEl) flash(msgEl, "Sending test notification…", "#888");
      chrome.runtime.sendMessage({ type: "test_outcome_notify", cfg }, (resp) => {
        if (resp && resp.ok) { if (msgEl) flashTemp(msgEl, "✓ Sent — check Discord/Telegram.", "var(--green)", 6000); }
        else { if (msgEl) flashTemp(msgEl, "Failed: " + ((resp && resp.error) || "no response"), "var(--red)", 6000); }
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
