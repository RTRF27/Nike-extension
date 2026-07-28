// ============================================================
// Dashboard smoke test — loads the REAL dashboard.html + dashboard.js
// in a browser with chrome.* stubbed, and checks the revamped sidebar
// IA works end to end without runtime errors.
//   node test-harness/dashboard-smoke.mjs
// ============================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = join(__dirname, "..");
const { chromium } = require(join(execSync("npm root -g", { encoding: "utf8" }).trim(), "playwright"));

// A minimal chrome.* stub: storage (with a seeded history so Insights render),
// runtime messaging, and the native-host sendNativeMessage the dashboard polls.
const CHROME_STUB = `
(function(){
  const local = {
    snkrsHistory: [
      { id:"r1", date: Date.now()-86400000, accounts:[
          {label:"P1",profileDir:"Profile 1",size:"9"},
          {label:"P2",profileDir:"Profile 2",size:"9.5"}],
        results:{ "Profile 1":"win", "Profile 2":"loss" },
        replay:{ "Profile 1":{profileDir:"Profile 1",loadedT:1000,filledT:5000,submittedT:9000,dropAt:9000,offsetMs:0},
                 "Profile 2":{profileDir:"Profile 2",loadedT:1000,filledT:7000,submittedT:8800,dropAt:9000,offsetMs:-200} } },
      { id:"r2", date: Date.now()-3600000, accounts:[{label:"P1",profileDir:"Profile 1",size:"9"}],
        results:{ "Profile 1":"entered" }, replay:{} }
    ],
  };
  const sync = { snkrsBotSettings: {} };
  const session = {};
  const mkArea = (store) => ({
    get: (keys, cb) => {
      let out = {};
      if (keys == null) out = {...store};
      else if (typeof keys === "string") out[keys] = store[keys];
      else if (Array.isArray(keys)) keys.forEach(k => out[k] = store[k]);
      else Object.keys(keys).forEach(k => out[k] = (k in store) ? store[k] : keys[k]);
      const p = Promise.resolve(out); if (cb) { cb(out); } return p;
    },
    set: (obj, cb) => { Object.assign(store, obj); const p = Promise.resolve(); if (cb) cb(); return p; },
    remove: (k, cb) => { (Array.isArray(k)?k:[k]).forEach(x=>delete store[x]); if (cb) cb(); return Promise.resolve(); },
  });
  window.chrome = {
    runtime: {
      id: "smoke",
      lastError: null,
      getManifest: () => ({ version: "9.9" }),
      getURL: (p) => p,
      sendMessage: (m, cb) => { if (typeof cb === "function") cb({ ok:false }); return Promise.resolve({ ok:false }); },
      onMessage: { addListener(){}, removeListener(){} },
      sendNativeMessage: (host, msg, cb) => {
        // Host offline for the smoke test — dashboard must degrade gracefully.
        window.chrome.runtime.lastError = { message: "host offline (smoke)" };
        cb(undefined);
        window.chrome.runtime.lastError = null;
      },
    },
    storage: {
      local: mkArea(local), sync: mkArea(sync), session: mkArea(session),
      onChanged: { addListener(){} },
    },
    tabs: { query: (q, cb) => cb && cb([]), create(){}, update(){}, onRemoved:{ addListener(){} } },
    alarms: { create(){}, clear(){}, onAlarm:{ addListener(){} } },
    cookies: { getAll: (q, cb) => cb && cb([]) },
  };
})();
`;

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
};

async function main() {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newContext({ viewport: { width: 1280, height: 900 } }).then(c => c.newPage());

  // Count only uncaught JS exceptions — external resource 404s (fonts) are
  // expected here since we stub the network, and are harmless (system fonts).
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // Serve the extension dir so relative dashboard.css/js/license.js resolve.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    // External assets (Google Fonts) → empty stub, no network.
    if (url.hostname.includes("googleapis") || url.hostname.includes("gstatic")) {
      route.fulfill({ status: 200, contentType: "text/css", body: "" }); return;
    }
    let p = url.pathname;
    if (p === "/" || p.endsWith("/dashboard")) p = "/dashboard.html";
    try {
      const body = readFileSync(join(ROOT, p.replace(/^\//, "")));
      const ext = p.split(".").pop();
      const type = ext === "html" ? "text/html" : ext === "css" ? "text/css" : ext === "js" ? "text/javascript" : "text/plain";
      route.fulfill({ status: 200, contentType: type, body });
    } catch (e) { route.fulfill({ status: 404, body: "nf" }); }
  });

  // Inject the chrome stub before any script runs.
  await page.addInitScript(CHROME_STUB);
  await page.goto("https://snkrs.local/dashboard.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);

  // 1) No uncaught errors on load.
  check("loads with no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  // 2) Sidebar renders 4 items; Dashboard active by default.
  const nav = await page.evaluate(() => ({
    items: Array.from(document.querySelectorAll(".side-item")).map(b => b.dataset.nav),
    active: (document.querySelector(".side-item.active") || {}).dataset?.nav,
    dashVisible: document.getElementById("page-home").classList.contains("active"),
    liveStacked: document.getElementById("page-live").classList.contains("active"),
  }));
  check("sidebar has 4 groups (History removed, Orders promoted)",
    nav.items.join(",") === "dashboard,setup,orders,settings", nav.items.join(","));
  check("dashboard active on load", nav.active === "dashboard");
  check("dashboard stacks home + live", nav.dashVisible && nav.liveStacked);

  // 3) Setup is ONE linear drop-day checklist: every step stacked, no sub-tabs.
  await page.click('.side-item[data-nav="setup"]');
  await page.waitForTimeout(200);
  const setup = await page.evaluate(() => {
    const ids = ["drop", "profiles", "cards", "timing", "preflight", "launch"];
    const active = ids.filter(i => document.getElementById("page-" + i)?.classList.contains("active"));
    // DOM order must match the checklist order, top to bottom.
    const domOrder = Array.from(document.querySelectorAll(".page-section"))
      .map(s => s.id.replace("page-", "")).filter(i => ids.includes(i));
    const steps = Array.from(document.querySelectorAll(".page-section.active .step-num")).map(s => s.textContent);
    return {
      activeCount: active.length,
      subtabsHidden: (document.getElementById("subNav")?.style.display || "") === "none",
      domOrder: domOrder.join(","),
      steps: steps.join(","),
      historyGone: !document.getElementById("page-history"),
    };
  });
  check("setup stacks all 6 steps (no sub-tabs)", setup.activeCount === 6, `active=${setup.activeCount}`);
  check("steps are in drop-day order",
    setup.domOrder === "drop,profiles,cards,timing,preflight,launch", setup.domOrder);
  check("steps are numbered 1..6", setup.steps === "1,2,3,4,5,6", setup.steps);
  check("History page removed", setup.historyGone);

  // 3b) Long-page ergonomics: a sticky jump bar + foldable steps, so a big
  //     account table never buries the LAUNCH step.
  const nav2 = await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll("#subNav .step-chip"));
    const before = document.getElementById("page-profiles").classList.contains("collapsed");
    // Fold ACCOUNTS via its header, the way a user would.
    document.querySelector("#page-profiles .step-header").click();
    const folded = document.getElementById("page-profiles").classList.contains("collapsed");
    // Jumping to a folded step must unfold it.
    if (typeof jumpToStep === "function") jumpToStep("profiles");
    const unfoldedByJump = !document.getElementById("page-profiles").classList.contains("collapsed");
    // Fold-all must keep LAUNCH open — it's the destination.
    document.getElementById("stepFoldAll").click();
    const launchStillOpen = !document.getElementById("page-launch").classList.contains("collapsed");
    const othersFolded = document.getElementById("page-profiles").classList.contains("collapsed");
    document.getElementById("stepFoldAll").click();   // restore
    return {
      chips: chips.map(c => c.dataset.step).join(","),
      hasFoldAll: !!document.getElementById("stepFoldAll"),
      before, folded, unfoldedByJump, launchStillOpen, othersFolded,
      chevrons: document.querySelectorAll("#page-profiles .step-chev").length,
    };
  });
  check("setup shows a step jump bar for all 6 steps",
    nav2.chips === "drop,profiles,cards,timing,preflight,launch", nav2.chips);
  check("jump bar has a fold-all control", nav2.hasFoldAll);
  check("clicking a step header folds it", nav2.before === false && nav2.folded === true);
  check("jumping to a folded step unfolds it", nav2.unfoldedByJump);
  check("fold-all folds the rest but KEEPS Launch open",
    nav2.othersFolded && nav2.launchStillOpen);
  check("step headers get a fold chevron", nav2.chevrons === 1, "chevrons=" + nav2.chevrons);

  // 4) Orders is reachable on its own sidebar item.
  await page.click('.side-item[data-nav="orders"]');
  await page.waitForTimeout(200);
  const ordersOk = await page.evaluate(() =>
    document.getElementById("page-orders").classList.contains("active"));
  check("Orders reachable from sidebar", ordersOk);

  // 5) Settings reachable, no errors accumulated across navigation.
  await page.click('.side-item[data-nav="settings"]');
  await page.waitForTimeout(150);
  const setActive = await page.evaluate(() => document.getElementById("page-settings").classList.contains("active"));
  check("settings group opens", setActive);

  // 6) Proxy manager: card present, mode toggle swaps inputs, buildProxyConfig
  //    + sticky assignment preview work end to end.
  const proxy = await page.evaluate(() => {
    if (!document.getElementById("proxyEnabled")) return { present: false };
    // Seed two accounts + a proxy list, then exercise the real functions.
    accounts = [
      { id: "a1", label: "Acct B", profileDir: "Profile 2" },
      { id: "a2", label: "Acct A", profileDir: "Profile 1" },
    ];
    document.getElementById("proxyEnabled").checked = true;
    document.getElementById("proxyMode").value = "list";
    document.getElementById("proxyList").value = "ip1.prov.com:8000:u:p\nip2.prov.com:8000:u:p";
    syncProxyModeUI();
    const listShown = document.getElementById("proxyListWrap").style.display !== "none";
    // Switch to gateway → list hides, gateway shows.
    document.getElementById("proxyMode").value = "gateway";
    syncProxyModeUI();
    const gwShown = document.getElementById("proxyGatewayWrap").style.display !== "none"
                 && document.getElementById("proxyListWrap").style.display === "none";
    // Back to list for the config + preview checks.
    document.getElementById("proxyMode").value = "list";
    syncProxyModeUI();
    const cfg = buildProxyConfig();
    renderProxyAssignments();
    const rows = document.querySelectorAll("#proxyAssignPreview .pa-row").length;
    // Deterministic sticky: sorted by profileDir → "Profile 1" (Acct A) gets ip1.
    const previewText = document.getElementById("proxyAssignPreview").textContent;
    return { present: true, listShown, gwShown, cfg, rows, previewText };
  });
  check("proxy card present in settings", proxy.present);
  check("proxy mode toggles list ↔ gateway inputs", proxy.listShown && proxy.gwShown);
  check("buildProxyConfig captures enabled + list", proxy.cfg && proxy.cfg.enabled === true && proxy.cfg.list.length === 2);
  check("proxy assignment preview renders a row per account", proxy.rows === 2, "rows=" + proxy.rows);
  check("sticky assignment maps first account (by profileDir) to first proxy",
    /Acct A/.test(proxy.previewText) && /ip1\.prov\.com:8000/.test(proxy.previewText), proxy.previewText);
  check("proxy preview masks credentials (no user:pass shown)", !/:u:p/.test(proxy.previewText), proxy.previewText);

  // 6b) Swap logic: with a spare proxy in the list, swapping an account moves it
  //     onto the UNUSED spare (a dead resi is replaced, not rotated onto a busy IP).
  const swap = await page.evaluate(() => {
    // 3 proxies, 2 accounts → ip3 is a spare.
    document.getElementById("proxyList").value = "ip1.prov.com:8000:u:p\nip2.prov.com:8000:u:p\nip3.prov.com:8000:u:p";
    const list = proxyLines();
    // Profile 1 (Acct A) defaults to ip1; Profile 2 (Acct B) to ip2. Swap Acct A.
    const cur = currentProxyForDir("Profile 1");
    const chosen = nextProxyAfter(cur, list, "Profile 1");
    proxyAssignments["Profile 1"] = chosen;
    renderProxyAssignments();
    const cfg = buildProxyConfig();
    const text = document.getElementById("proxyAssignPreview").textContent;
    const hasSwapBtn = !!document.querySelector("#proxyAssignPreview .pa-swap");
    return { cur, chosen, assignments: cfg.assignments, text, hasSwapBtn };
  });
  check("swap picks the unused spare proxy (ip3)", /ip3\.prov\.com/.test(swap.chosen), swap.chosen);
  check("swap override persists into buildProxyConfig.assignments", swap.assignments && swap.assignments["Profile 1"] === swap.chosen);
  check("swapped account shows the new IP + (swapped) tag", /ip3\.prov\.com/.test(swap.text) && /swapped/.test(swap.text), swap.text);
  check("assignment rows render a ⟳ swap button", swap.hasSwapBtn);

  // 6d) 🎲 Random = PRE-ROLL concrete sizes from a range (not a live sentinel),
  //     so every task targets a fixed, visible size and the spread is knowable.
  const roll = await page.evaluate(() => {
    if (typeof rollRandomSizes !== "function") return { ok: false };
    accounts = Array.from({ length: 10 }, (_, i) => ({ id: "r" + i, profileDir: "P" + i, size: "", sizeType: "footwear" }));
    randomMin = "9"; randomMax = "12";
    rollRandomSizes();
    const sizes = accounts.map(a => a.size);
    const types = accounts.map(a => a.sizeType);
    const nums = sizes.map(parseFloat);
    return {
      ok: true, sizes,
      allConcrete: sizes.every(s => /^\d/.test(s)),         // never the "RANDOM" sentinel
      allInRange: nums.every(n => n >= 9 && n <= 12),
      allFootwear: types.every(t => t === "footwear"),
      distinct: new Set(sizes).size,
      spread: typeof sizeSpreadSummary === "function" ? sizeSpreadSummary() : "",
    };
  });
  // Coverage: with ≥ as many tasks as sizes, EVERY in-range size must appear —
  // none silently dropped (regression: "US 10" vanished from a 9–12 roll).
  const cover = await page.evaluate(() => {
    const pool = footwearRange("9", "12");            // 9,9.5,10,10.5,11,11.5,12
    for (let t = 0; t < 300; t++) {
      const got = new Set(dealFromPool(pool, pool.length).map(v => v.split(":")[1]));
      if (got.size !== pool.length) return { ok: false, missing: pool.filter(p => !got.has(p.split(":")[1])) };
    }
    return { ok: true, includesTen: footwearRange("9", "12").some(v => v.endsWith(":10")) };
  });
  check("US 10 is in the 9–12 pool", cover.includesTen);
  check("no in-range size is ever dropped when tasks ≥ sizes", cover.ok, JSON.stringify(cover.missing));

  check("random rolls CONCRETE sizes (no live RANDOM sentinel)", roll.ok && roll.allConcrete, (roll.sizes || []).join(","));
  check("rolled sizes stay inside the US 9–12 range", roll.ok && roll.allInRange, (roll.sizes || []).join(","));
  check("rolled sizes are footwear", roll.ok && roll.allFootwear);
  check("range gives a real spread (>1 distinct size across 10 tasks)", roll.ok && roll.distinct > 1, "distinct=" + roll.distinct);
  check("spread summary lists the sizes", roll.ok && /US \d/.test(roll.spread), roll.spread);

  // 6e) "No half sizes" (slippers) and apparel (XXS–XXL for tees/jackets).
  const opts = await page.evaluate(() => {
    accounts = Array.from({ length: 8 }, (_, i) => ({ id: "o" + i, profileDir: "P" + i, size: "", sizeType: "footwear" }));
    // No-half footwear
    randomKind = "footwear"; randomMin = "9"; randomMax = "12"; randomNoHalf = true;
    rollRandomSizes();
    const noHalf = { anyHalf: accounts.some(a => a.size.includes(".")), inRange: accounts.every(a => { const n = +a.size; return n >= 9 && n <= 12; }) };
    // Apparel XXS–XXL
    randomKind = "apparel"; randomMinA = "XXS"; randomMaxA = "XXL"; randomNoHalf = false;
    rollRandomSizes();
    const validAp = ["XXS", "XS", "S", "M", "L", "XL", "XXL"];
    const apparel = { allApparelType: accounts.every(a => a.sizeType === "apparel"),
                      allValid: accounts.every(a => validAp.includes(a.size)),
                      spread: sizeSpreadSummary() };
    return { noHalf, apparel };
  });
  // 6f) Tasks CSV: Void-style bulk task loading, matched to real accounts.
  const csv = await page.evaluate(() => {
    cardProfiles = [{ id: "c1", name: "Visa Main" }, { id: "c2", name: "Amex" }];
    const text = [
      "label,profile,sku,size,size_type,card,region,arm",
      'Acct One,Profile 1,HQ4309-001,10,footwear,Visa Main,SG,true',
      '"Tang, R",Profile 2,HQ4309-001,10.5,footwear,Amex,MY,false',
      "Acct Three,Profile 3,HQ4309-001,L,apparel,Nope,,false",
    ].join("\n");
    importTasksCsv(text);
    const a = accounts;
    return {
      n: a.length,
      quotedLabel: a[1] && a[1].label,               // comma inside quotes survived
      cardMapped: a[0] && a[0].cardId,               // matched by NAME → id
      badCard: a[2] && a[2].cardId,                  // unknown name → empty, not silent id
      region: [a[0].regionOverride, a[1].regionOverride, a[2].regionOverride],
      armed: [a[0].autoLaunch, a[1].autoLaunch],
      apparel: a[2] && a[2].sizeType,
      sizes: a.map(x => x.size),
      header: (typeof TASK_CSV_COLS !== "undefined") ? TASK_CSV_COLS.join(",") : "",
    };
  });
  // 6g) Named proxy groups ([Vital] headers) — Void keeps one file per group.
  const grp = await page.evaluate(() => {
    document.getElementById("proxyList").value = [
      "[Vital]", "v1.prov.com:8000:u:p", "v2.prov.com:8000:u:p",
      "[Vital 2]", "w1.prov.com:8000:u:p", "w2.prov.com:8000:u:p", "w3.prov.com:8000:u:p",
    ].join("\n");
    const groups = proxyGroups();
    accounts = [
      { id: "g1", profileDir: "P1", proxyGroup: "Vital" },
      { id: "g2", profileDir: "P2", proxyGroup: "Vital" },
      { id: "g3", profileDir: "P3", proxyGroup: "Vital 2" },
    ];
    proxyAssignments = {};
    const picked = accounts.map(a => currentProxyForDir(a.profileDir));
    // A flat list with no headers must behave exactly as before.
    document.getElementById("proxyList").value = "a.prov.com:1:u:p\nb.prov.com:1:u:p";
    const flat = proxyLines();
    return { names: Object.keys(groups), counts: Object.values(groups).map(v => v.length),
             picked, flatLen: flat.length, flatHasHeader: flat.some(l => l.startsWith("[")) };
  });
  check("proxy groups parse from [Name] headers", grp.names.join(",") === "Vital,Vital 2", grp.names.join(","));
  check("each group keeps its own proxies", grp.counts.join(",") === "2,3", grp.counts.join(","));
  check("a task only draws IPs from ITS group",
    grp.picked[0].startsWith("v") && grp.picked[1].startsWith("v") && grp.picked[2].startsWith("w"),
    grp.picked.join(" | "));
  check("accounts in one group get different IPs", grp.picked[0] !== grp.picked[1], grp.picked.join(" | "));
  check("flat list (no headers) still works unchanged", grp.flatLen === 2 && !grp.flatHasHeader);

  check("tasks CSV imports every row", csv.n === 3, "n=" + csv.n);
  check("tasks CSV handles quoted commas in a field", csv.quotedLabel === "Tang, R", csv.quotedLabel);
  check("tasks CSV maps card by NAME to a saved card", csv.cardMapped === "c1", csv.cardMapped);
  check("unknown card name does NOT silently bind a card", csv.badCard === "", "got=" + csv.badCard);
  check("tasks CSV reads region + arm flags", csv.region.join(",") === "SG,MY," && csv.armed.join(",") === "true,false",
    csv.region.join(",") + " | " + csv.armed.join(","));
  check("tasks CSV keeps apparel size type", csv.apparel === "apparel", csv.apparel);
  check("tasks CSV preserves sizes", csv.sizes.join(",") === "10,10.5,L", csv.sizes.join(","));

  check("no-half rolls WHOLE sizes only", opts.noHalf.anyHalf === false);
  check("no-half still respects the range", opts.noHalf.inRange);
  check("apparel roll assigns apparel-type sizes", opts.apparel.allApparelType);
  check("apparel roll stays within XXS–XXL", opts.apparel.allValid);
  check("apparel spread reads as letters (no 'US')", !/US /.test(opts.apparel.spread), opts.apparel.spread);

  // 7) Outcome notifications: card present, buildNotifyConfig reflects toggles.
  const notify = await page.evaluate(() => {
    if (!document.getElementById("notifyEnabled")) return { present: false };
    document.getElementById("notifyEnabled").checked = true;
    document.getElementById("notifyWebhook").value = "https://discord.com/api/webhooks/x/y";
    // Ensure the editable event list is rendered, then tick per-event toggles.
    if (typeof renderNotifyEvents === "function") renderNotifyEvents({}, {});
    if (document.getElementById("notifyEvt_win")) document.getElementById("notifyEvt_win").checked = true;
    if (document.getElementById("notifyEvt_submitting")) document.getElementById("notifyEvt_submitting").checked = false;
    // Ping control: win pings, error is sent but silent.
    const pWin = document.getElementById("notifyPing_win");
    const pErr = document.getElementById("notifyPing_error");
    if (pWin) { pWin.disabled = false; pWin.checked = true; }
    if (pErr) { pErr.disabled = false; pErr.checked = false; }
    // A muted event must not be able to ping.
    const pSub = document.getElementById("notifyPing_submitting");
    const subDisabled = pSub ? pSub.disabled : null;
    const cfg = buildNotifyConfig();
    return { present: true, cfg, hasGrid: !!document.getElementById("notifyEventsGrid"),
             hasPingCol: !!pWin, subDisabled };
  });
  check("notifications card present", notify.present);
  check("editable per-event notification grid renders", notify.hasGrid);
  check("buildNotifyConfig maps webhook + individual event toggles",
    notify.cfg && notify.cfg.enabled && notify.cfg.webhook.includes("discord") &&
    notify.cfg.events.win === true &&
    notify.cfg.events.submitting === false);
  check("per-event @here ping column renders", notify.hasPingCol);
  check("ping config: win pings, error sends silently",
    notify.cfg && notify.cfg.pings && notify.cfg.pings.win === true && notify.cfg.pings.error === false,
    JSON.stringify(notify.cfg && notify.cfg.pings));
  check("a muted event can never ping", notify.cfg.pings.submitting === false);

  // 8) Region tagging: preflight has region row + arm-by-region bar; the
  //    manual override wins over any detected region.
  await page.click('.side-item[data-nav="setup"]');   // preflight is step 5, already stacked
  await page.waitForTimeout(200);
  const region = await page.evaluate(() => {
    const hasBar = !!document.getElementById("preflightRegionBar");
    const hasOpenBtns = !!document.getElementById("openSGBtn") && !!document.getElementById("openMYBtn");
    const hasRegionDef = typeof PF_CHECK_DEFS !== "undefined" && PF_CHECK_DEFS.some(d => d.key === "region");
    const hasTpl = !!document.querySelector("#accountRowTpl");
    const tplHasRegion = hasTpl && !!document.getElementById("accountRowTpl").content.querySelector(".f-region");
    // Override beats detection: an SG override with no preflight data → "SG".
    accounts = [{ id: "r1", label: "Ov", profileDir: "Profile 9", regionOverride: "SG" }];
    const eff = effectiveRegionFor(accounts[0]);
    // Region is informational — an unknown region must NOT flip the verdict red.
    const verdictInfoSafe = preflightVerdict({ version: { ok: true }, host: { ok: true }, login: { ok: true }, region: { ok: null }, address: { ok: null }, card: { ok: true }, cookies: { ok: true }, target: { ok: true } }) === "green";
    return { hasBar, hasOpenBtns, hasRegionDef, tplHasRegion, eff, verdictInfoSafe };
  });
  check("preflight has open-by-region bar", region.hasBar);
  check("region bar has OPEN SG + OPEN MY buttons", region.hasOpenBtns);
  check("preflight defs include a Region row", region.hasRegionDef);
  check("account row template has a region selector", region.tplHasRegion);
  check("manual region override wins (SG)", region.eff === "SG", region.eff);
  check("region/address are informational (don't fail verdict)", region.verdictInfoSafe);

  // 9) Profile selection → OPEN SELECTED filters to ticked accounts.
  const select = await page.evaluate(() => {
    const tplHasSelect = !!document.getElementById("accountRowTpl").content.querySelector(".f-select");
    const hasBtn = !!document.getElementById("openSelectedBtn");
    accounts = [
      { id: "s1", label: "A", profileDir: "Profile 1", selected: true },
      { id: "s2", label: "B", profileDir: "Profile 2", selected: false },
      { id: "s3", label: "C", profileDir: "Profile 3", selected: true },
    ];
    updateSelectedCount();
    const btnLabel = document.getElementById("openSelectedBtn").textContent;
    const picked = accounts.filter(a => a.profileDir && a.selected).map(a => a.label);
    return { tplHasSelect, hasBtn, btnLabel, picked };
  });
  check("account template has a select checkbox", select.tplHasSelect);
  check("Drop page has OPEN SELECTED button", select.hasBtn);
  check("OPEN SELECTED shows the ticked count", /\(2\)/.test(select.btnLabel), select.btnLabel);
  check("selection filters to the ticked profiles", select.picked.join(",") === "A,C", select.picked.join(","));

  // 10) Tile layout preview renders one cell per profile.
  const preview = await page.evaluate(() => {
    if (typeof renderTilePreview !== "function") return { ok: false };
    if (document.getElementById("tileWindowsToggle")) document.getElementById("tileWindowsToggle").checked = true;
    accounts = [
      { id: "t1", profileDir: "Profile 1" }, { id: "t2", profileDir: "Profile 2" },
      { id: "t3", profileDir: "Profile 3" }, { id: "t4", profileDir: "Profile 4" },
    ];
    renderTilePreview();
    const cells = document.querySelectorAll("#tilePreview .tile-cell").length;
    const shown = document.getElementById("tilePreview").style.display === "block";
    return { ok: true, cells, shown };
  });
  check("tile preview renders a cell per profile", preview.ok && preview.cells === 4 && preview.shown, "cells=" + preview.cells);

  // 9b) Tiler invariant: for ANY profile count, tiled windows must never overlap
  //     and must never exceed the screen. Windows past capacity get no geometry
  //     (Chrome default) rather than being stacked invisibly on top of others.
  const tiling = await page.evaluate(() => {
    if (typeof tileFitFor !== "function") return { ok: false };
    if (document.getElementById("tileWindowsToggle")) document.getElementById("tileWindowsToggle").checked = true;
    if (document.getElementById("tileAutoFit")) document.getElementById("tileAutoFit").checked = true;
    const scr = tileScreen();
    const bad = [];
    let capacity = 0, tallestAt3 = null;
    for (let n = 1; n <= 12; n++) {
      accounts = Array.from({ length: n }, (_, i) => ({ id: "p" + i, profileDir: "Profile " + i }));
      const fit = tileFitFor(n);
      capacity = fit.capacity;
      const rects = [];
      for (let i = 0; i < n; i++) {
        const g = tileGeomFor(i, n);
        if (!g) continue;                       // didn't fit → untiled, that's fine
        if (g.x < 0 || g.y < 0 || g.x + g.w > scr.availW || g.y + g.h > scr.availH)
          bad.push(`n=${n} i=${i} offscreen`);
        if (g.w < 500) bad.push(`n=${n} i=${i} width ${g.w} < Chrome min`);
        rects.push(g);
      }
      // Pairwise overlap check.
      for (let a = 0; a < rects.length; a++) {
        for (let b = a + 1; b < rects.length; b++) {
          const A = rects[a], B = rects[b];
          const hit = A.x < B.x + B.w && A.x + A.w > B.x && A.y < B.y + B.h && A.y + A.h > B.y;
          if (hit) bad.push(`n=${n}: ${a} overlaps ${b}`);
        }
      }
    }
    // Screen-independent: with no more profiles than columns, every window must
    // be a SINGLE row (full height) — never split into short rows.
    const maxCols = Math.max(1, Math.floor(scr.availW / 500));
    accounts = Array.from({ length: maxCols }, (_, i) => ({ id: "q" + i, profileDir: "P" + i }));
    tallestAt3 = tileFitFor(maxCols);
    return { ok: true, bad, capacity, tallestAt3, maxCols, scr };
  });
  check("tiler: no two windows EVER overlap (1..12 profiles)",
    tiling.ok && tiling.bad.length === 0, (tiling.bad || []).slice(0, 3).join(" | "));
  check("tiler: reports a real capacity for this screen",
    tiling.ok && tiling.capacity >= 1, "capacity=" + tiling.capacity);
  // 9c) Multi-monitor spreading: with a second screen to the right, capacity
  //     must grow, windows must land on BOTH screens, stay inside their own
  //     monitor's bounds, and still never overlap in virtual-desktop space.
  const multi = await page.evaluate(() => {
    if (typeof tilePlan !== "function") return { ok: false };
    if (document.getElementById("tileWindowsToggle")) document.getElementById("tileWindowsToggle").checked = true;
    if (document.getElementById("tileAutoFit")) document.getElementById("tileAutoFit").checked = true;
    const SCREENS = [
      { id: 0, x: 0,    y: 0, w: 1536, h: 816, primary: true },
      { id: 1, x: 1536, y: 0, w: 1920, h: 1040, primary: false },  // second monitor, right
    ];
    _displays = SCREENS;
    const one = (() => { _displays = [SCREENS[0]]; return tilePlan(1).capacity; })();
    _displays = SCREENS;
    const plan = tilePlan(12);
    const bad = [];
    // Every window must sit fully inside exactly one monitor.
    for (const r of plan.rects) {
      const home = SCREENS.find(s => r.x >= s.x && r.y >= s.y &&
        r.x + r.w <= s.x + s.w && r.y + r.h <= s.y + s.h);
      if (!home) bad.push(`rect ${r.x},${r.y} ${r.w}x${r.h} not inside any monitor`);
      if (r.w < 500) bad.push(`width ${r.w} < Chrome min`);
    }
    // Pairwise overlap in virtual-desktop coordinates.
    for (let a = 0; a < plan.rects.length; a++) {
      for (let b = a + 1; b < plan.rects.length; b++) {
        const A = plan.rects[a], B = plan.rects[b];
        if (A.x < B.x + B.w && A.x + A.w > B.x && A.y < B.y + B.h && A.y + A.h > B.y)
          bad.push(`${a} overlaps ${b}`);
      }
    }
    const used = new Set(plan.rects.map(r => r.display));
    _displays = null;   // restore
    return { ok: true, bad, capacity: plan.capacity, singleCap: one,
             placed: plan.rects.length, screensUsed: used.size, monitors: plan.monitors };
  });
  check("multi-monitor: capacity grows with a second screen",
    multi.ok && multi.capacity > multi.singleCap, `${multi.singleCap} → ${multi.capacity}`);
  check("multi-monitor: windows land on BOTH screens",
    multi.ok && multi.screensUsed === 2, "screens used=" + multi.screensUsed);
  check("multi-monitor: every window inside a monitor, none overlap",
    multi.ok && multi.bad.length === 0, (multi.bad || []).slice(0, 3).join(" | "));
  check("multi-monitor: all 12 profiles placed", multi.ok && multi.placed === 12, "placed=" + multi.placed);

  check("tiler: prefers TALL windows (profiles ≤ columns → 1 full-height row)",
    tiling.ok && tiling.tallestAt3 && tiling.tallestAt3.rows === 1 &&
      tiling.tallestAt3.h === Math.floor(tiling.scr.availH),
    tiling.tallestAt3 && `${tiling.maxCols} profiles → ${tiling.tallestAt3.cols}x${tiling.tallestAt3.rows} ${tiling.tallestAt3.w}x${tiling.tallestAt3.h}`);

  // 11) Checkout method: organic routes launches to the launch PAGE, not the gs link.
  const cm = await page.evaluate(() => {
    if (!document.getElementById("checkoutModeOrganic")) return { ok: false };
    const acct = { id: "c1", profileDir: "Profile 1" };
    const target = { url: "https://www.nike.com/sg/launch/t/england-x-palace", checkoutUrl: "https://gs.nike.com/?checkoutId=abc" };
    document.getElementById("checkoutModeOrganic").checked = true;
    document.getElementById("checkoutModeDirect").checked = false;
    const organicUrl = bootUrlForTarget(acct, target) || "";
    document.getElementById("checkoutModeDirect").checked = true;
    document.getElementById("checkoutModeOrganic").checked = false;
    const directUrl = bootUrlForTarget(acct, target) || "";
    return { ok: true, organicUrl, directUrl, val: checkoutModeValue() };
  });
  check("checkout method selector present", cm.ok);
  check("organic opens the launch page (not gs link)", /nike\.com\/sg\/launch\/t\//.test(cm.organicUrl) && !/gs\.nike\.com/.test(cm.organicUrl), cm.organicUrl);
  check("direct opens the gs checkout link", /gs\.nike\.com/.test(cm.directUrl), cm.directUrl);

  check("no errors after full navigation", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
