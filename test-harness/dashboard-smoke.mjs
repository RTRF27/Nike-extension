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
  check("sidebar has 4 groups", nav.items.join(",") === "dashboard,setup,history,settings", nav.items.join(","));
  check("dashboard active on load", nav.active === "dashboard");
  check("dashboard stacks home + live", nav.dashVisible && nav.liveStacked);

  // 3) Navigate to Setup → sub-tabs appear, preflight reachable.
  await page.click('.side-item[data-nav="setup"]');
  await page.waitForTimeout(150);
  const setup = await page.evaluate(() => ({
    subtabs: Array.from(document.querySelectorAll("#subNav .subtab")).map(b => b.textContent),
    dropVisible: document.getElementById("page-drop").classList.contains("active"),
  }));
  check("setup shows sub-tabs", setup.subtabs.length === 4, setup.subtabs.join(","));
  check("setup opens Drop first", setup.dropVisible);

  await page.click('#subNav .subtab:nth-child(4)'); // Preflight
  await page.waitForTimeout(150);
  const pf = await page.evaluate(() => document.getElementById("page-preflight").classList.contains("active"));
  check("setup → Preflight sub-tab works", pf);

  // 4) History → Insights render from seeded history.
  await page.click('.side-item[data-nav="history"]');
  await page.waitForTimeout(300);
  const ins = await page.evaluate(() => {
    const body = document.getElementById("insightsBody");
    return {
      hasTiles: !!body.querySelector(".insight-tile"),
      text: (document.getElementById("insightsMsg")||{}).textContent || "",
      sizes: body.querySelectorAll(".size-stat").length,
    };
  });
  check("insights render tiles from history", ins.hasTiles);
  check("insights mention learned drops", /Learned from 2 drops/.test(ins.text), ins.text);
  check("insights show per-size hit rates", ins.sizes >= 1, "rows=" + ins.sizes);

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

  // 7) Outcome notifications: card present, buildNotifyConfig reflects toggles.
  const notify = await page.evaluate(() => {
    if (!document.getElementById("notifyEnabled")) return { present: false };
    document.getElementById("notifyEnabled").checked = true;
    document.getElementById("notifyWebhook").value = "https://discord.com/api/webhooks/x/y";
    document.getElementById("notifyEvtWin").checked = true;
    document.getElementById("notifyEvtSubmitting").checked = false;
    const cfg = buildNotifyConfig();
    return { present: true, cfg };
  });
  check("notifications card present", notify.present);
  check("buildNotifyConfig maps webhook + win/success toggle",
    notify.cfg && notify.cfg.enabled && notify.cfg.webhook.includes("discord") &&
    notify.cfg.events.win === true && notify.cfg.events.success === true &&
    notify.cfg.events.submitting === false);

  check("no errors after full navigation", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
