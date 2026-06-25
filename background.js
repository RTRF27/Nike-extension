// ============================================================
// Nike SNKRS Bot – Background Service Worker
// ============================================================

const SETTINGS_KEY = "snkrsBotSettings";
const DROP_ALARM_NAME = "snkrsDropAlarm";

const defaultSettings = {
  enabled: true,
  testMode: false,
  preferredSize: "",
  profileLabel: "",
  logWebhook: "",
  alertWebhook: "",
  // Multi-product drop scheduling
  multiEnabled: false,     // when true, the drop scheduler opens slot tabs
  dropTimeISO: "",         // ISO datetime string for when to open tabs
  slots: [],               // [{ url, keyword, size, sizeType }, ...] up to 2
};

async function getSettings() {
  const saved = await chrome.storage.sync.get(SETTINGS_KEY);
  return { ...defaultSettings, ...(saved[SETTINGS_KEY] || {}) };
}

async function saveSettings(settings) {
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
}

async function sendLog(message) {
  const settings = await getSettings();
  const isAlert = typeof message === "string" && message.includes("@here");

  if (isAlert) {
    if (!settings.alertWebhook) return;
    fetch(settings.alertWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    }).catch(console.warn);
    return;
  }

  if (!settings.logWebhook) return;
  fetch(settings.logWebhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message }),
  }).catch(console.warn);
}

// ── Upcoming SNKRS drops (preview + new-release alerts) ───────
// Nike exposes its launch feed through the public product-feed API. We poll it
// on an alarm, render it in the dashboard, and ping a Discord webhook whenever
// a brand-new thread appears.
const UPCOMING_POLL_ALARM = "snkrsUpcomingPoll";
const UPCOMING_CFG_KEY    = "snkrsUpcomingCfg";   // {webhook, enabled, intervalMin}
const UPCOMING_SEEN_KEY   = "snkrsUpcomingSeen";  // {threadId: true}
const UPCOMING_CACHE_KEY  = "snkrsUpcomingCache"; // {ts, drops:[]}

// SNKRS Web channel for the SG marketplace. If Nike ever rotates this, it's the
// only value that needs changing.
const SNKRS_CHANNEL_ID = "010794e5-35fe-4e32-aaff-cd2c74f89d61";
const SNKRS_MARKETPLACE = "SG";
const SNKRS_LANGUAGE    = "en-GB";

function upcomingFeedUrl() {
  const filters = [
    `marketplace(${SNKRS_MARKETPLACE})`,
    `language(${SNKRS_LANGUAGE})`,
    `upcoming(true)`,
    `channelId(${SNKRS_CHANNEL_ID})`,
    `exclusiveAccess(true,false)`,
  ].map(f => `filter=${encodeURIComponent(f)}`).join("&");
  return `https://api.nike.com/product_feed/threads/v2/?anchor=0&count=50&${filters}`;
}

// Pull the squarish image URL out of a thread's published content.
function _threadImage(obj) {
  try {
    const nodes = obj?.publishedContent?.nodes || [];
    for (const n of nodes) {
      const p = n.properties || {};
      if (p.squarishURL) return p.squarishURL;
      if (p.portraitURL) return p.portraitURL;
      if (p.coverCard && p.coverCard.properties && p.coverCard.properties.squarishURL)
        return p.coverCard.properties.squarishURL;
    }
    const cc = obj?.publishedContent?.properties?.coverCard?.properties;
    if (cc && (cc.squarishURL || cc.portraitURL)) return cc.squarishURL || cc.portraitURL;
  } catch {}
  return "";
}

// Normalise one feed object into a flat drop record.
function _normaliseThread(obj) {
  const pi = (obj.productInfo && obj.productInfo[0]) || {};
  const merch = pi.merchProduct || {};
  const launch = pi.launchView || {};
  const content = pi.productContent || {};
  const price = pi.merchPrice || {};
  const props = (obj.publishedContent && obj.publishedContent.properties) || {};

  const title = content.fullTitle || props.title || content.title || "Nike Drop";
  const subtitle = content.subtitle || props.subtitle || "";
  const sku = merch.styleColor || "";
  // Entry/availability time: prefer the draw entry start, else commerce start.
  const dateISO = launch.startEntryDate || merch.commerceStartDate || launch.stopEntryDate || "";
  const slug = content.slug || props.seo?.slug || "";
  const url = slug ? `https://www.nike.com/${SNKRS_MARKETPLACE.toLowerCase()}/launch/t/${slug}` : "";
  const method = launch.method || props.threadType || ""; // DRAW / LEO / etc.

  return {
    id: obj.id || obj.threadId || sku || slug,
    title, subtitle, sku,
    dateISO,
    price: price.currentPrice != null ? price.currentPrice : (price.fullPrice != null ? price.fullPrice : ""),
    currency: price.currency || "SGD",
    method,
    url,
    imageUrl: _threadImage(obj),
  };
}

async function fetchUpcomingDrops() {
  const res = await fetch(upcomingFeedUrl(), {
    headers: { "Accept": "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Nike feed HTTP ${res.status}`);
  const json = await res.json();
  const objects = Array.isArray(json.objects) ? json.objects : [];
  const drops = objects
    .map(_normaliseThread)
    .filter(d => d.id && (d.title || d.sku));
  // Sort by release date ascending (soonest first); undated go last.
  drops.sort((a, b) => {
    const ta = a.dateISO ? Date.parse(a.dateISO) : Infinity;
    const tb = b.dateISO ? Date.parse(b.dateISO) : Infinity;
    return ta - tb;
  });
  // Cache for instant dashboard render.
  await chrome.storage.local.set({ [UPCOMING_CACHE_KEY]: { ts: Date.now(), drops } });
  return drops;
}

function _fmtDropTime(iso) {
  if (!iso) return "TBA";
  const d = new Date(iso);
  if (isNaN(d)) return "TBA";
  return d.toLocaleString("en-SG", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
}

async function postDropToDiscord(webhook, drop) {
  const fields = [];
  if (drop.sku)   fields.push({ name: "SKU", value: drop.sku, inline: true });
  if (drop.price !== "") fields.push({ name: "Price", value: `${drop.currency} ${drop.price}`, inline: true });
  if (drop.method) fields.push({ name: "Type", value: String(drop.method), inline: true });
  fields.push({ name: "Release", value: _fmtDropTime(drop.dateISO), inline: false });

  const embed = {
    title: [drop.title, drop.subtitle].filter(Boolean).join(" — ").slice(0, 250),
    url: drop.url || undefined,
    color: 0x8b5cf6,
    fields,
    footer: { text: "SNKRS SG · Upcoming" },
    timestamp: drop.dateISO && !isNaN(Date.parse(drop.dateISO)) ? new Date(drop.dateISO).toISOString() : undefined,
  };
  if (drop.imageUrl) embed.thumbnail = { url: drop.imageUrl };

  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "🔥 **New SNKRS SG drop detected!**", embeds: [embed] }),
    });
  } catch (e) {
    console.warn("[SNKRSBot BG] Discord post failed:", e);
  }
}

async function getUpcomingCfg() {
  const d = await chrome.storage.local.get(UPCOMING_CFG_KEY);
  return Object.assign({ webhook: "", enabled: false, intervalMin: 5 }, d[UPCOMING_CFG_KEY] || {});
}

// Re-arm (or clear) the polling alarm to match the saved config.
async function armUpcomingPoll() {
  const cfg = await getUpcomingCfg();
  await chrome.alarms.clear(UPCOMING_POLL_ALARM);
  if (cfg.enabled) {
    const period = Math.max(1, Number(cfg.intervalMin) || 5);
    chrome.alarms.create(UPCOMING_POLL_ALARM, { periodInMinutes: period, delayInMinutes: 0.1 });
  }
}

// The poll: fetch, diff against seen set, ping Discord for new threads.
async function runUpcomingPoll() {
  const cfg = await getUpcomingCfg();
  if (!cfg.enabled || !cfg.webhook) return;

  let drops;
  try { drops = await fetchUpcomingDrops(); }
  catch (e) { console.warn("[SNKRSBot BG] upcoming fetch failed:", e); return; }

  const store = await chrome.storage.local.get(UPCOMING_SEEN_KEY);
  const seen  = store[UPCOMING_SEEN_KEY];

  // First ever run: seed the seen-set silently so we don't dump the whole feed.
  if (!seen || typeof seen !== "object" || !Object.keys(seen).length) {
    const seed = {};
    drops.forEach(d => { seed[d.id] = Date.now(); });
    await chrome.storage.local.set({ [UPCOMING_SEEN_KEY]: seed });
    return;
  }

  const newOnes = drops.filter(d => !seen[d.id]);
  for (const d of newOnes) {
    await postDropToDiscord(cfg.webhook, d);
    seen[d.id] = Date.now();
  }
  if (newOnes.length) await chrome.storage.local.set({ [UPCOMING_SEEN_KEY]: seen });
}

// ── Multi-product drop scheduler ──────────────────────────────
// Opens each configured slot in its own tab, tagging the URL with
// #snkrsSlot=N so the content script knows which product/size to use.
function buildSlotUrl(slot, index) {
  // Slot must have a URL to open. (Keyword-only slots still need a page to
  // land on — the popup enforces a URL when scheduling auto-open.)
  let url = (slot.url || "").trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  // Append our slot marker in the hash so it doesn't disturb Nike's routing.
  const sep = url.includes("#") ? "&" : "#";
  return `${url}${sep}snkrsSlot=${index + 1}`;
}

async function openDropTabs(reason) {
  const settings = await getSettings();
  const slots = Array.isArray(settings.slots) ? settings.slots : [];
  const active = slots.filter(s => s && (s.url || "").trim());

  if (!active.length) {
    sendLog("⚠️ Drop scheduler fired but no product slots have URLs — nothing opened.");
    return;
  }

  sendLog(`⏰ Drop time reached (${reason}) — opening ${active.length} product tab(s) now.`);

  for (let i = 0; i < active.length; i++) {
    const url = buildSlotUrl(active[i], i);
    if (!url) continue;
    chrome.tabs.create({ url, active: i === 0 }, (tab) => {
      if (chrome.runtime.lastError) {
        console.warn("[SNKRSBot BG] tab open error:", chrome.runtime.lastError.message);
      }
    });
  }

  // One-shot: clear the schedule so it doesn't refire on next browser start.
  const cleared = { ...settings, multiEnabled: false, dropTimeISO: "" };
  await saveSettings(cleared);
}

async function scheduleDropAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(DROP_ALARM_NAME);

  if (!settings.multiEnabled || !settings.dropTimeISO) return;

  const when = Date.parse(settings.dropTimeISO);
  if (isNaN(when)) {
    sendLog("⚠️ Drop time is not a valid date — scheduler not armed.");
    return;
  }

  if (when <= Date.now()) {
    // Time already passed — open immediately rather than waiting.
    sendLog("⏰ Configured drop time is in the past — opening tabs now.");
    openDropTabs("time already passed");
    return;
  }

  chrome.alarms.create(DROP_ALARM_NAME, { when });
  const mins = Math.round((when - Date.now()) / 60000);
  sendLog(`✅ Drop scheduled — opening ${(settings.slots || []).filter(s => s && s.url).length} tab(s) in ~${mins} min.`);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DROP_ALARM_NAME) {
    openDropTabs("scheduled alarm");
  }
  if (alarm.name === "snkrsDashLaunchAlarm") {
    autoDashLaunch();
  }
  if (alarm.name === UPCOMING_POLL_ALARM) {
    runUpcomingPoll();
  }
});

// Re-arm the alarm when the service worker starts (e.g. browser restart).
chrome.runtime.onStartup.addListener(() => {
  scheduleDropAlarm();
  rescheduleDashLaunch();
  armUpcomingPoll();
});
chrome.runtime.onInstalled.addListener(() => {
  scheduleDropAlarm();
  armUpcomingPoll();
});

// ── Dashboard auto-launch (per-account scheduled open) ────────
const DASH_LAUNCH_ALARM  = "snkrsDashLaunchAlarm";
const DASH_LAUNCH_STORE  = "snkrsDashLaunchConfig";

function buildBootUrlFromConfig(cfg, acct) {
  let url = (cfg.multiProduct && acct.url) ? acct.url : ((cfg.drop && cfg.drop.url) || "");
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const sep = url.includes("#") ? "&" : "#";
  return `${url}${sep}snkrsBoot=${encodeURIComponent(acct.profileDir)}`;
}

async function autoDashLaunch() {
  const data = await chrome.storage.local.get(DASH_LAUNCH_STORE);
  const cfg = data[DASH_LAUNCH_STORE];
  if (!cfg) return;
  const autoAccts = (cfg.accounts || []).filter(a => a.autoLaunch && a.profileDir && a.size);
  if (!autoAccts.length) return;
  // One-shot — clear so it doesn't refire on restart
  await chrome.storage.local.remove(DASH_LAUNCH_STORE);
  sendLog(`⏰ Auto-launch time reached — opening ${autoAccts.length} account(s).`);
  for (const acct of autoAccts) {
    const url = buildBootUrlFromConfig(cfg, acct);
    if (!url) continue;
    await nativeSend({ cmd: "launch", profileDir: acct.profileDir, url });
    await new Promise(r => setTimeout(r, 500));
  }
}

async function rescheduleDashLaunch() {
  const data = await chrome.storage.local.get(DASH_LAUNCH_STORE);
  const cfg = data[DASH_LAUNCH_STORE];
  if (!cfg) return;
  const when = cfg.drop && cfg.drop.dropTimeISO ? Date.parse(cfg.drop.dropTimeISO) : NaN;
  if (isNaN(when) || when <= Date.now()) {
    // Time already passed while browser was closed — launch immediately
    autoDashLaunch();
    return;
  }
  chrome.alarms.create(DASH_LAUNCH_ALARM, { when });
}

// ── Native messaging host bridge ──────────────────────────────
// The native host ("com.snkrs.launcher") is the only thing that can open
// OTHER Chrome profiles and read/write the shared config file. The
// dashboard talks to it directly; content scripts can't use native
// messaging, so the boot bootstrap routes through us here.
const NATIVE_HOST = "com.snkrs.launcher";

function nativeSend(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message, hostMissing: true });
          return;
        }
        resolve(resp || { ok: false, error: "Empty response from native host." });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message || e), hostMissing: true });
    }
  });
}

// Build the per-profile settings object that the existing content scripts
// already understand, from the central shared config + this account's row.
function buildSettingsForProfile(config, profileDir) {
  if (!config) return null;
  const drop = config.drop || {};
  const opts = config.options || {};
  const central = config.card || {};
  const accounts = Array.isArray(config.accounts) ? config.accounts : [];
  const account = accounts.find(a => a && a.profileDir === profileDir);
  if (!account) return null;

  // Per-account card overrides the central card only when it has a number.
  const acctCard = account.card || {};
  const card = (acctCard.cardNumber && acctCard.cardNumber.trim()) ? acctCard : central;

  // In multi-product mode each account carries its own SKU/keyword; otherwise
  // they all share the central one.
  const keyword = (config.multiProduct && account.keyword) ? account.keyword : (drop.keyword || "");

  return {
    enabled:             opts.enabled ?? true,
    testMode:            opts.testMode ?? false,
    preferredSize:       account.size || "",
    preferredSizeType:   account.sizeType || "footwear",
    productKeyword:      keyword,
    profileLabel:        account.label || profileDir,
    logWebhook:          account.logWebhook || opts.logWebhook || "",
    alertWebhook:        account.alertWebhook || opts.alertWebhook || "",
    cardName:            card.cardName   || "",
    cardNumber:          card.cardNumber || "",
    cardExpiry:          card.cardExpiry || "",
    cardCvv:             card.cardCvv    || "",
    statusPollerEnabled: opts.statusPollerEnabled ?? true,
    pollerIntervalMin:   opts.pollerIntervalMin ?? 3,
    multiEnabled:        false,
  };
}

// ── Per-tab card fill cache ───────────────────────────────────
// Stores the last card_fill_done result per tabId so gs-content-script
// can retrieve it even if it arms the listener after the signal was sent.
const cardFillCache = {};

// ── Live status board support ─────────────────────────────────
// Maps tabId → profileDir so log messages from a launched Nike tab
// can be attributed to the correct dashboard account row.
const tabProfileMap = {};
chrome.tabs.onRemoved.addListener((tabId) => { delete tabProfileMap[tabId]; });

function parseStatusFromLog(message) {
  if (!message) return null;
  const m = message.toLowerCase();
  if (m.includes("got 'em") || m.includes("got em") || m.includes("you won the draw"))
    return "win";
  if (m.includes("better luck next time") || m.includes("not selected") || m.includes("unsuccessful") && m.includes("result"))
    return "loss";
  if (m.includes("entry confirmed") || (m.includes("📋") && m.includes("draw entered")))
    return "entered";
  if (m.includes("entry is pending") || m.includes("you're in line") || m.includes("pending / you"))
    return "pending";
  if (m.includes("polling every") || m.includes("still pending") || m.includes("check #"))
    return "polling";
  if (m.includes("draw ended") || m.includes("draw closed") || m.includes("sold out"))
    return "closed";
  if (m.includes("entry_limit_exceeded") || (m.includes("limit") && m.includes("exceeded")))
    return "limit";
  return null;
}

// ── Message handler ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Boot bootstrap (content script) asks us to fetch this profile's central
  // config from the native host and hand back ready-to-store settings.
  if (msg.type === "boot_fetch_settings") {
    nativeSend({ cmd: "getConfig" }).then((resp) => {
      if (!resp || !resp.ok) {
        sendResponse({ ok: false, error: resp && resp.error || "host error" });
        return;
      }
      const settings = buildSettingsForProfile(resp.config, msg.profileDir);
      if (!settings) {
        sendResponse({ ok: false, error: "No matching account in shared config." });
        return;
      }
      if (sender?.tab?.id) tabProfileMap[sender.tab.id] = msg.profileDir;
      sendResponse({ ok: true, settings });
    });
    return true;
  }

  // Generic relay so extension pages (the dashboard) could also reach the
  // host through us if they prefer. {cmd} is forwarded verbatim.
  if (msg.type === "native") {
    nativeSend(msg.payload || {}).then(sendResponse);
    return true;
  }

  // Dashboard asks for upcoming SNKRS drops. Serve cache instantly if fresh,
  // otherwise fetch live. Pass {force:true} to always hit the network.
  if (msg.type === "fetch_upcoming") {
    (async () => {
      try {
        if (!msg.force) {
          const c = await chrome.storage.local.get(UPCOMING_CACHE_KEY);
          const cache = c[UPCOMING_CACHE_KEY];
          if (cache && Array.isArray(cache.drops) && (Date.now() - (cache.ts || 0) < 5 * 60 * 1000)) {
            sendResponse({ ok: true, drops: cache.drops, cached: true, ts: cache.ts });
            return;
          }
        }
        const drops = await fetchUpcomingDrops();
        sendResponse({ ok: true, drops, cached: false, ts: Date.now() });
      } catch (e) {
        // On failure, fall back to whatever's cached so the UI isn't empty.
        const c = await chrome.storage.local.get(UPCOMING_CACHE_KEY);
        const cache = c[UPCOMING_CACHE_KEY];
        sendResponse({
          ok: false,
          error: String(e && e.message || e),
          drops: (cache && cache.drops) || [],
          ts: cache && cache.ts,
        });
      }
    })();
    return true;
  }

  // Dashboard saved the upcoming-alert config — persist + re-arm the poller.
  if (msg.type === "set_upcoming_cfg") {
    (async () => {
      await chrome.storage.local.set({ [UPCOMING_CFG_KEY]: msg.cfg || {} });
      await armUpcomingPoll();
      sendResponse({ ok: true });
    })();
    return true;
  }

  // Manual webhook test: post the soonest real upcoming drop (or a synthetic
  // sample) so the user can confirm the webhook works, then run a normal poll
  // so any genuinely-new drops also ping.
  if (msg.type === "test_upcoming_now") {
    (async () => {
      const cfg = await getUpcomingCfg();
      const webhook = (msg.webhook && msg.webhook.trim()) || cfg.webhook;
      if (!webhook) { sendResponse({ ok: false, error: "No webhook configured." }); return; }
      let drop = null;
      try {
        const drops = await fetchUpcomingDrops();
        drop = drops[0] || null;
      } catch (e) {}
      if (!drop) {
        drop = {
          title: "Webhook test", subtitle: "If you can read this, alerts work.",
          sku: "TEST-000", price: "199", currency: "SGD", method: "DRAW",
          dateISO: "", url: "https://www.nike.com/sg/launch/upcoming", imageUrl: "",
        };
      }
      await postDropToDiscord(webhook, drop);
      await runUpcomingPoll();
      sendResponse({ ok: true });
    })();
    return true;
  }

  // gs-content-script polls this to check if card was already filled
  if (msg.type === "get_card_fill_cache") {
    const tabId = sender?.tab?.id;
    const cached = tabId ? cardFillCache[tabId] : null;
    sendResponse({ cached });
    return true;
  }
  if (msg.type === "get_settings") {
    getSettings().then(s => sendResponse({ settings: s }));
    return true;
  }

  if (msg.type === "save_settings") {
    saveSettings(msg.settings).then(() => sendResponse({ ok: true }));
    return true;
  }

  // Popup asks us to (re)arm or cancel the drop schedule after saving.
  if (msg.type === "schedule_drop") {
    scheduleDropAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "cancel_drop") {
    chrome.alarms.clear(DROP_ALARM_NAME).then(() => {
      sendLog("🛑 Drop schedule cancelled.");
      sendResponse({ ok: true });
    });
    return true;
  }
  // Manual trigger: open the slot tabs right now (for testing).
  if (msg.type === "open_drop_now") {
    openDropTabs("manual trigger").then(() => sendResponse({ ok: true }));
    return true;
  }

  // Dashboard arms (or cancels) the auto-launch alarm for per-account scheduled opens.
  if (msg.type === "arm_drop_launch") {
    const cfg = msg.config;
    chrome.alarms.clear(DASH_LAUNCH_ALARM, async () => {
      const autoAccts = (cfg?.accounts || []).filter(a => a.autoLaunch && a.profileDir && a.size);
      const timeISO   = cfg?.drop?.dropTimeISO;
      if (!timeISO || !autoAccts.length) {
        await chrome.storage.local.remove(DASH_LAUNCH_STORE);
        sendResponse({ ok: true, armed: false });
        return;
      }
      const when = Date.parse(timeISO);
      if (isNaN(when)) {
        sendResponse({ ok: true, armed: false, reason: "invalid date" });
        return;
      }
      if (when <= Date.now()) {
        // Time already passed — launch immediately
        await chrome.storage.local.set({ [DASH_LAUNCH_STORE]: cfg });
        autoDashLaunch();
        sendResponse({ ok: true, armed: false, reason: "time already passed — launching now" });
        return;
      }
      await chrome.storage.local.set({ [DASH_LAUNCH_STORE]: cfg });
      chrome.alarms.create(DASH_LAUNCH_ALARM, { when });
      sendResponse({ ok: true, armed: true, when, count: autoAccts.length });
    });
    return true;
  }

  if (msg.type === "log") {
    sendLog(msg.message);
    // Live status board: parse and store per-profile status for the dashboard
    const tabId = sender?.tab?.id;
    const profileDir = tabId ? tabProfileMap[tabId] : null;
    if (profileDir) {
      const code = parseStatusFromLog(msg.message);
      if (code) {
        chrome.storage.local.get("snkrsStatus", (data) => {
          const s = data.snkrsStatus || {};
          s[profileDir] = { code, message: msg.message, time: Date.now() };
          chrome.storage.local.set({ snkrsStatus: s });
        });
      }
    }
    return false;
  }

  // Orders page — store raw API or DOM-scraped data keyed by profileDir.
  // Dashboard.js normalises and displays it.
  if (msg.type === "orders_api_data" || msg.type === "orders_dom_data") {
    const tabId     = sender?.tab?.id;
    const profileDir = msg.profileDir || (tabId ? tabProfileMap[tabId] : "");
    if (!profileDir) return false;

    chrome.storage.local.get("snkrsOrders", (data) => {
      const store   = data.snkrsOrders || {};
      const entry   = store[profileDir] || {};
      entry.ts      = Date.now();
      entry.profileDir = profileDir;

      if (msg.type === "orders_api_data") {
        // Accumulate raw API payloads — Nike pages fire several fetches per load.
        // Dedup by apiUrl so reloads don't bloat storage.
        const list = Array.isArray(entry.apiPayloads) ? entry.apiPayloads : [];
        const idx  = list.findIndex(p => p.url === msg.apiUrl);
        const payload = { url: msg.apiUrl, data: msg.raw, ts: Date.now() };
        if (idx >= 0) list[idx] = payload; else list.push(payload);
        entry.apiPayloads = list;
        entry.source = "api";
      } else {
        // Always keep the latest DOM scrape too — the dashboard falls back to
        // it when API payloads can't be parsed into orders.
        entry.domOrders = msg.orders;
        if (!entry.source) entry.source = "dom";
      }

      store[profileDir] = entry;
      chrome.storage.local.set({ snkrsOrders: store });
      // Also push to the shared on-disk orders file via the native host so the
      // DASHBOARD (which runs in a different Chrome profile and therefore can't
      // see this profile's chrome.storage.local) can read these orders.
      nativeSend({ cmd: "setOrders", profileDir, entry }).catch(() => {});
    });
    return false;
  }

  if (msg.type === "card_fill_done") {
    // The payments iframe and gs-content-script are in the SAME tab.
    // sender.tab.id is the tab the iframe message came from —
    // send back to that tab's top frame (frameId: 0) where gs-content-script lives.
    const tabId = sender?.tab?.id;
    // Cache the result so gs-content-script can retrieve it if it arms late
    if (tabId) cardFillCache[tabId] = { filled: msg.filled, ts: Date.now() };
    if (tabId) {
      chrome.tabs.sendMessage(
        tabId,
        { type: "card_fill_done", filled: msg.filled },
        { frameId: 0 }, // top frame = gs-content-script.js
        () => {
          if (chrome.runtime.lastError) {
            console.warn("[SNKRSBot BG] card_fill_done relay error (non-fatal):",
              chrome.runtime.lastError.message);
          }
        }
      );
    } else {
      // Fallback: broadcast to all gs.nike.com tabs
      chrome.tabs.query({ url: "https://gs.nike.com/*" }, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, { type: "card_fill_done", filled: msg.filled },
            { frameId: 0 }, () => { chrome.runtime.lastError; });
        });
      });
    }
    return false;
  }

  return false;
});