// ============================================================
// Nike SNKRS Bot – Background Service Worker
// ============================================================

const SETTINGS_KEY = "snkrsBotSettings";
const DROP_ALARM_NAME = "snkrsDropAlarm";
const SELF_PROFILE_KEY = "snkrsSelfProfileDir";
const EXT_VERSION = chrome.runtime.getManifest().version;

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
  // SNKRS launch pages live at /launch/t/<seoSlug>, where seoSlug comes from
  // the thread's publishedContent (e.g. "dunk-low-protro-draft-pack-charlotte-to-la").
  // The merch productContent.slug is the commerce/PDP slug
  // (e.g. "dunk-low-protro-draft-pack-shoes-BuduZU1m") which 404s on /launch/t/,
  // so prefer the publishedContent SEO slug and only fall back to it.
  const slug = props.seo?.slug || props.custom?.seoSlug || props.custom?.url || content.slug || "";
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

// ── Direct SNKRS checkout-URL resolver ────────────────────────
// Nike's launch products can be entered directly at
//   https://gs.nike.com/?checkoutId=..&launchId=..&skuId=..&country=..&locale=..
// which skips the launch page AND the size picker. To build that URL per size
// we need the launchView.id, the SEO slug, and the size→skuId map for a SKU.
// We pull all three from the public product-feed v3 threads API.
const NIKE_LANG_MAP = {
  PT:"en-GB", GB:"en-GB", ZA:"en-GB", CZ:"en-GB", PH:"en-GB", SK:"en-GB", SI:"en-GB",
  SG:"en-GB", SE:"en-GB", CH:"en-GB", SA:"en-GB", LU:"en-GB", FI:"en-GB", IN:"en-GB",
  IL:"en-GB", CA:"en-GB", IE:"en-GB", ID:"en-GB", RO:"en-GB", HR:"en-GB", BG:"en-GB",
  NZ:"en-GB", BE:"en-GB", NO:"en-GB", NL:"en-GB", AU:"en-GB", AT:"en-GB", MY:"en-GB",
  DK:"en-GB", AE:"en-GB", PL:"pl", FR:"fr", IT:"it", US:"en", JP:"ja", ES:"es-ES",
  HU:"hu", KR:"ko", TW:"zh-Hant", TR:"tr", TH:"th", GR:"el", MX:"es-419", DE:"de",
};
function nikeLanguageFor(country) { return NIKE_LANG_MAP[country] || "en-GB"; }

async function resolveLaunchData(sku, country) {
  country = (country || "SG").toUpperCase();
  sku = (sku || "").toUpperCase().trim();
  if (!sku) throw new Error("Missing SKU");
  const language = nikeLanguageFor(country);
  const marketplace = country === "AU" ? "ASTLA" : country;
  const channels = ["SNKRS Web", "Nike.com", "SNKRS", "UNKNOWN"];

  // Candidate query URLs. v3 first — it carries launchView.id + the full skus
  // list (with skuId per size), which is exactly what we need and what the
  // reference checkout tool uses. v2 is a secondary fallback. We try each
  // channel; the channel-less variant catches anything the named channels miss.
  const base = (ver, channel) =>
    `https://api.nike.com/product_feed/threads/${ver}/?` +
    `filter=marketplace(${marketplace})` +
    `&filter=language(${language})` +
    (channel ? `&filter=channelName(${encodeURIComponent(channel)})` : ``) +
    `&filter=productInfo.merchProduct.styleColor(${encodeURIComponent(sku)})` +
    `&filter=exclusiveAccess(true,false)`;
  const candidates = [
    ...channels.map(c => base("v3", c)),
    base("v3", null),
    ...channels.map(c => base("v2", c)),
    base("v2", null),
  ];

  // Extract the launch fields from a feed object (null if no usable productInfo).
  function extract(obj) {
    const piArr = obj.productInfo || [];
    const pi = piArr.length === 1
      ? piArr[0]
      : (piArr.find(p => p.merchProduct && p.merchProduct.styleColor === sku) || piArr[0]);
    if (!pi) return null;
    const launchId = pi.launchView && pi.launchView.id;
    const slug = obj.publishedContent && obj.publishedContent.properties &&
                 obj.publishedContent.properties.seo && obj.publishedContent.properties.seo.slug;
    const skus = (pi.skus || []).map(s => ({ nikeSize: s.nikeSize, id: s.id, localizedSize: s.localizedSize }));
    const name = (pi.productContent && pi.productContent.fullTitle) ||
                 (obj.publishedContent && obj.publishedContent.properties &&
                  obj.publishedContent.properties.title) || sku;
    // Nike's authoritative drop time: the launch entry-open date (draws) or the
    // commerce start (LEO/buy). This is what the website shows as "Available …".
    const lv = pi.launchView || {};
    const dropTimeISO = lv.startEntryDate ||
                        (pi.merchProduct && pi.merchProduct.commerceStartDate) ||
                        lv.stopEntryDate || "";
    return { launchId, slug, skus, name, dropTimeISO };
  }

  let lastStatus = 0, netErr = "", partial = null;
  for (const url of candidates) {
    let res;
    try { res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" }); }
    catch (e) { netErr = String(e && e.message || e); continue; }
    lastStatus = res.status;
    if (!res.ok) continue;
    let data; try { data = await res.json(); } catch (e) { continue; }
    const obj = (data.objects || [])[0];
    if (!obj) continue;
    const ex = extract(obj);
    if (!ex) continue;
    // Accept only a COMPLETE record. If an endpoint returns the product but
    // without launch fields (e.g. v2), remember it and keep trying others (v3).
    if (ex.launchId && ex.slug && ex.skus.length) {
      return { ok: true, sku, country, language, launchId: ex.launchId, slug: ex.slug, skus: ex.skus, name: ex.name, dropTimeISO: ex.dropTimeISO };
    }
    partial = partial || ex;
  }

  if (partial) {
    if (!partial.launchId)     throw new Error(`${sku} has no launch entry in the feed yet (not a draw/launch, or not published yet).`);
    if (!partial.skus.length)  throw new Error(`No size list for ${sku} yet — sizes can publish closer to launch; try again nearer drop time.`);
    if (!partial.slug)         throw new Error(`No launch slug for ${sku} yet.`);
    throw new Error(`Couldn't resolve full launch details for ${sku}.`);
  }
  if (lastStatus && lastStatus !== 200) throw new Error(`Nike API blocked the lookup (HTTP ${lastStatus}). SKU ${sku}/${country}.`);
  if (netErr)                           throw new Error(`Network error reaching Nike: ${netErr}`);
  throw new Error(`Product ${sku} not found in ${country}.`);
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
    // Time already passed. Only open immediately if it just passed (grace
    // window). If it passed long ago, clear the stale schedule instead of
    // re-opening the tabs every time the browser restarts.
    if (Date.now() - when <= LAUNCH_GRACE_MS) {
      sendLog("⏰ Configured drop time just passed — opening tabs now.");
      openDropTabs("time just passed");
    } else {
      sendLog("⏰ Configured drop time already passed — schedule cleared, not opening tabs.");
      const cleared = { ...settings, multiEnabled: false, dropTimeISO: "" };
      await saveSettings(cleared);
    }
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
  if (alarm.name.startsWith("snkrsReload#")) {
    fireTabReload(alarm.name.slice("snkrsReload#".length));
  }
});

// Re-arm the alarm when the service worker starts (e.g. browser restart).
chrome.runtime.onStartup.addListener(() => {
  scheduleDropAlarm();
  rescheduleDashLaunch();
  armUpcomingPoll();
  rearmTabReloads();
  reportVersionToHost();
});
chrome.runtime.onInstalled.addListener(() => {
  scheduleDropAlarm();
  armUpcomingPoll();
  rearmTabReloads();
  // Fires on every extension UPDATE too — report the new version immediately
  // so the dashboard banner flips this profile to green without waiting for
  // the next browser restart.
  reportVersionToHost();
});

// ── Drop-time tab reload (survives Memory Saver / SW sleep) ────
// When a profile is launched early, its checkout tab HOLDS until ~PREP before
// the drop. A plain in-page timer dies if Chrome discards the idle tab, so we
// arm a background alarm here to reload the tab (fresh checkoutId → fresh
// Kasada) right before the drop — this wakes the SW and reloads even a
// discarded tab.
const RELOAD_STORE = "snkrsTabReloads"; // { [tabId]: { when, bootUrl } }

function bgFreshCheckoutId(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has("checkoutId")) {
      u.searchParams.set("checkoutId", (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()));
    }
    return u.toString();
  } catch (e) { return url; }
}

async function armTabReload(tabId, when, bootUrl) {
  const d = await chrome.storage.local.get(RELOAD_STORE);
  const m = d[RELOAD_STORE] || {};
  m[tabId] = { when, bootUrl };
  await chrome.storage.local.set({ [RELOAD_STORE]: m });
  chrome.alarms.create(`snkrsReload#${tabId}`, { when: Math.max(when, Date.now() + 1000) });
}

async function fireTabReload(tabIdStr) {
  const tabId = Number(tabIdStr);
  const d = await chrome.storage.local.get(RELOAD_STORE);
  const m = d[RELOAD_STORE] || {};
  const rec = m[tabId];
  if (rec) { delete m[tabId]; await chrome.storage.local.set({ [RELOAD_STORE]: m }); }
  const url = bgFreshCheckoutId((rec && rec.bootUrl) || "");
  if (!url) return;
  // Reload the (possibly discarded) tab to the fresh checkout URL.
  chrome.tabs.update(tabId, { url }, () => { if (chrome.runtime.lastError) { /* tab gone */ } });
}

async function rearmTabReloads() {
  const d = await chrome.storage.local.get(RELOAD_STORE);
  const m = d[RELOAD_STORE] || {};
  for (const [tabId, rec] of Object.entries(m)) {
    chrome.alarms.create(`snkrsReload#${tabId}`, { when: Math.max(rec.when, Date.now() + 1000) });
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const d = await chrome.storage.local.get(RELOAD_STORE);
  const m = d[RELOAD_STORE] || {};
  if (m[tabId] != null) { delete m[tabId]; await chrome.storage.local.set({ [RELOAD_STORE]: m }); }
  chrome.alarms.clear(`snkrsReload#${tabId}`);
});

// ── Dashboard auto-launch (per-account scheduled open) ────────
const DASH_LAUNCH_ALARM  = "snkrsDashLaunchAlarm";
const DASH_LAUNCH_STORE  = "snkrsDashLaunchConfig";

// How long after a scheduled drop time we still honour a "launch now" when the
// browser/dashboard is (re)opened. This covers the genuine case where the
// browser was launched a few seconds late and we should still try to enter.
// If the drop time passed longer ago than this, we treat the schedule as stale
// and silently disarm — otherwise reopening the dashboard hours/days later
// would re-open every account's tab again, which is exactly what the user hit.
const LAUNCH_GRACE_MS = 90 * 1000; // 90 seconds

// Open each account this long BEFORE the drop so the checkout page loads fresh
// (fresh Kasada/anti-bot token), delivery + card get filled, and everything is
// primed to SUBMIT the instant the drop goes live. The content scripts hold the
// actual SUBMIT click until the real drop time (never before → no
// LAUNCH_NOT_ACTIVE). Long enough to fill, short enough that Kasada stays valid.
const DASH_PREP_LEAD_MS = 30 * 1000; // 30 seconds

// Returns the list of boot URLs to open for an account. Multi-product: one per
// product target (each its own checkout URL + drop time). Single: one.
function buildBootUrlsFromConfig(cfg, acct) {
  const globalDrop = cfg.drop && cfg.drop.dropTimeISO ? Date.parse(cfg.drop.dropTimeISO) : NaN;
  const mk = (rawUrl, dropMs) => {
    if (!rawUrl) return null;
    let url = rawUrl.trim();
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const params = [`snkrsBoot=${encodeURIComponent(acct.profileDir)}`];
    const t = dropMs || (isNaN(globalDrop) ? 0 : globalDrop);
    if (t) params.push(`snkrsDrop=${t}`);
    const sep = url.includes("#") ? "&" : "#";
    return `${url}${sep}${params.join("&")}`;
  };
  if (cfg.multiProduct && Array.isArray(acct.targets) && acct.targets.length) {
    return acct.targets
      .map(tg => mk((tg.checkoutUrl && tg.checkoutUrl.trim()) || tg.url, tg.dropAtMs || 0))
      .filter(Boolean);
  }
  const one = mk((acct.checkoutUrl && acct.checkoutUrl.trim()) || (cfg.drop && cfg.drop.url) || "", acct.dropAtMs || 0);
  return one ? [one] : [];
}

async function autoDashLaunch() {
  const data = await chrome.storage.local.get(DASH_LAUNCH_STORE);
  const cfg = data[DASH_LAUNCH_STORE];
  if (!cfg) return;
  const autoAccts = (cfg.accounts || []).filter(a =>
    a.autoLaunch && a.profileDir && (a.size || (a.targets || []).length));
  if (!autoAccts.length) return;
  // One-shot — clear so it doesn't refire on restart
  await chrome.storage.local.remove(DASH_LAUNCH_STORE);
  sendLog(`⏰ Auto-launch time reached — opening ${autoAccts.length} account(s).`);
  for (const acct of autoAccts) {
    const urls = buildBootUrlsFromConfig(cfg, acct);
    if (!urls.length) continue;
    // All of this account's product tabs in ONE chrome command.
    await nativeSend({ cmd: "launch", profileDir: acct.profileDir, urls });
    await new Promise(r => setTimeout(r, 450)); // stagger BETWEEN profiles
  }
}

async function rescheduleDashLaunch() {
  const data = await chrome.storage.local.get(DASH_LAUNCH_STORE);
  const cfg = data[DASH_LAUNCH_STORE];
  if (!cfg) return;
  const dropMs = cfg.drop && cfg.drop.dropTimeISO ? Date.parse(cfg.drop.dropTimeISO) : NaN;
  if (isNaN(dropMs)) {
    // No valid time — clear the stale config so it can't keep firing.
    await chrome.storage.local.remove(DASH_LAUNCH_STORE);
    return;
  }
  // Open PREP seconds before the drop so the page is primed; the content scripts
  // hold SUBMIT until the real drop time.
  const openAt = dropMs - DASH_PREP_LEAD_MS;
  if (dropMs <= Date.now() - LAUNCH_GRACE_MS) {
    // Drop passed long ago — stale. Disarm silently.
    await chrome.storage.local.remove(DASH_LAUNCH_STORE);
    sendLog("⏰ Scheduled drop time already passed — auto-launch skipped (schedule cleared).");
    return;
  }
  if (openAt <= Date.now()) {
    // Already inside the prep window (or just past drop, within grace) — open now.
    autoDashLaunch();
    return;
  }
  chrome.alarms.create(DASH_LAUNCH_ALARM, { when: openAt });
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

// ── Version reporting (feeds the dashboard's stale-profile banner) ──
// A profile learns its own profileDir the first time the dashboard boots it
// (#snkrsBoot / #snkrsPreflight markers). We remember it so that EVERY
// subsequent browser start can report "this profile runs version X" to the
// shared versions.json via the native host — that's what the dashboard
// compares against the repo's latest version.
async function rememberSelfProfileDir(profileDir) {
  if (!profileDir) return;
  await chrome.storage.local.set({ [SELF_PROFILE_KEY]: profileDir });
}

async function getSelfProfileDir() {
  const d = await chrome.storage.local.get(SELF_PROFILE_KEY);
  return d[SELF_PROFILE_KEY] || "";
}

async function reportVersionToHost(profileDir) {
  const dir = profileDir || await getSelfProfileDir();
  if (!dir) return; // never booted by the dashboard yet — nothing to attribute
  await nativeSend({ cmd: "reportVersion", profileDir: dir, entry: { version: EXT_VERSION, ts: Date.now() } });
}

// Dotted-numeric version compare: -1 / 0 / 1.
function cmpVer(a, b) {
  const pa = String(a || "").split(".").map(Number);
  const pb = String(b || "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ── Preflight (pre-drop health check, runs INSIDE each profile) ──
// The dashboard opens this profile on a nike.com page tagged
// #snkrsPreflight=<profileDir>. The bootstrap content script collects
// page-level signals (login token, sign-in button, etc.) and hands them to
// us; we add everything only the background can see (native host, cookies,
// version), try an authenticated identity call for the delivery address,
// then write the whole result to the shared preflight folder and close the
// tab. The dashboard aggregates the folder into the red/green checklist.

// Best-effort: ask Nike who this token belongs to, and whether the account
// has address data. 200 = definitely logged in. Anything else = "unknown",
// never "failed" — the page signals still decide login.
async function preflightIdentityCheck(accessToken) {
  const out = { tokenAccepted: null, addressOk: null, detail: "" };
  if (!accessToken) { out.detail = "no session token on page"; return out; }
  try {
    const res = await fetch("https://api.nike.com/identity/user/v1/users/me", {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) {
      out.tokenAccepted = false;
      out.detail = `token rejected (HTTP ${res.status})`;
      return out;
    }
    if (!res.ok) { out.detail = `identity HTTP ${res.status}`; return out; }
    out.tokenAccepted = true;
    const body = await res.json();
    // Look for anything address-shaped in the profile payload.
    const json = JSON.stringify(body).toLowerCase();
    if (/"(shippingaddress|addressline1|address1|postalcode|postcode)"/.test(json)) {
      out.addressOk = true;
      out.detail = "identity OK · address data present";
    } else {
      out.detail = "identity OK · no address in profile payload";
    }
  } catch (e) {
    out.detail = "identity call failed: " + String(e && e.message || e);
  }
  return out;
}

async function runPreflight(profileDir, page, accessToken) {
  await rememberSelfProfileDir(profileDir);

  const entry = { profileDir, ts: Date.now(), version: EXT_VERSION, checks: {} };

  // 1) Native host reachable FROM THIS PROFILE (each profile registers the
  //    host independently via the HKCU key — one broken profile can differ).
  const ping = await nativeSend({ cmd: "ping" });
  entry.checks.host = ping.ok
    ? { ok: true, detail: `launcher v${ping.version}` }
    : { ok: false, detail: ping.error || "native host unreachable" };

  // 2) Extension version vs latest (repo manifest, from the host).
  const latest = ping.ok ? (ping.latestVersion || "") : "";
  entry.latestVersion = latest;
  entry.checks.version = latest
    ? { ok: cmpVer(EXT_VERSION, latest) >= 0, detail: `running ${EXT_VERSION} · latest ${latest}` }
    : { ok: null, detail: `running ${EXT_VERSION} · latest unknown (host offline)` };

  // 3) Cookies warm: does this profile carry a real nike.com cookie jar,
  //    including Kasada's KP_* anti-bot cookies?
  try {
    const cookies = await chrome.cookies.getAll({ domain: "nike.com" });
    const kasada = cookies.some(c => /^KP_/i.test(c.name));
    entry.checks.cookies = {
      ok: cookies.length >= 5 && kasada ? true : (cookies.length >= 5 ? null : false),
      detail: `${cookies.length} nike.com cookies` + (kasada ? " · Kasada present" : " · no Kasada cookie yet"),
    };
  } catch (e) {
    entry.checks.cookies = { ok: null, detail: "cookies API unavailable" };
  }

  // 4) Login + delivery address: page signals + authenticated identity call.
  const idc = await preflightIdentityCheck(accessToken);
  const pageLogin = page && page.login || {};
  let loginOk;
  if (idc.tokenAccepted === true) loginOk = true;
  else if (pageLogin.hasToken && pageLogin.tokenFresh) loginOk = true;
  else if (pageLogin.signInVisible && !pageLogin.hasToken) loginOk = false;
  else if (pageLogin.accountMenu) loginOk = true;
  else loginOk = pageLogin.hasToken ? null : false;
  entry.checks.login = {
    ok: loginOk,
    detail: [
      pageLogin.hasToken ? (pageLogin.tokenFresh ? "session token valid" : "session token EXPIRED") : "no session token",
      pageLogin.signInVisible ? "Sign-In button visible" : "",
      idc.tokenAccepted === true ? "API accepted token" : (idc.tokenAccepted === false ? "API rejected token" : ""),
    ].filter(Boolean).join(" · "),
  };
  entry.checks.address = { ok: idc.addressOk, detail: idc.detail };

  await nativeSend({ cmd: "setPreflight", profileDir, entry });
  return entry;
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
    // The account's pre-built direct checkout URL, so the gs bootstrap can
    // recover/retry if the checkout page bounces to gs.nike.com/error.
    checkoutUrl:         account.checkoutUrl || "",
    // The exact drop time this account must hold SUBMIT until. Prefer the
    // account's own product time (multi-product), else the global drop time.
    // Carried in settings so the gate ALWAYS works, even if the URL marker is
    // missing.
    dropAtMs:            account.dropAtMs ||
                         (drop.dropTimeISO ? Date.parse(drop.dropTimeISO) : 0) || 0,
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

// A short human label for a tab (the product it's on) for the live monitor.
function tabLabel(tab) {
  if (!tab) return "";
  try {
    const u = new URL(tab.url || "");
    // SNKRS launch slug or gs checkout — derive the product slug.
    const m = (u.pathname + u.search + u.hash).match(/launch\/t\/([^/?#&]+)/);
    if (m && m[1]) return m[1].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()).slice(0, 42);
  } catch (e) {}
  const t = (tab.title || "").replace(/\s*[|\-–].*$/i, "").trim();
  return t.slice(0, 42);
}

// Throttle shared-file status writes: each write spawns a native-host process,
// so we don't want one per heartbeat line. Important states flush immediately.
const _lastStatusPush = {};
const _IMPORTANT_CODES = new Set(["error", "success", "win", "loss", "submitting", "entered", "limit"]);
function pushStatusToShared(profileDir, entry) {
  const now = Date.now();
  const important = _IMPORTANT_CODES.has(entry.code);
  if (!important && now - (_lastStatusPush[profileDir] || 0) < 1200) return;
  _lastStatusPush[profileDir] = now;
  nativeSend({ cmd: "setStatus", profileDir, entry }).catch(() => {});
}

function parseStatusFromLog(message) {
  if (!message) return null;
  const m = message.toLowerCase();

  // ── Terminal / draw outcomes (highest priority) ──
  if (m.includes("got 'em") || m.includes("got em") || m.includes("you won the draw"))
    return "win";
  if (m.includes("better luck next time") || m.includes("not selected") || m.includes("unsuccessful") && m.includes("result"))
    return "loss";
  if (m.includes("order submitted") || m.includes("order confirmed") || m.includes("entry complete") || m.includes("you're in"))
    return "success";
  if (m.includes("entry confirmed") || (m.includes("📋") && m.includes("draw entered")))
    return "entered";

  // ── Error / needs-attention ──
  if (m.includes("gs.nike.com/error") || m.includes("something went wrong") ||
      m.includes("❌") || m.includes("aborting") || m.includes("stuck here") ||
      m.includes("could not") || m.includes("not found or still disabled") ||
      m.includes("no confirmation after"))
    return "error";

  // ── Live checkout steps (so the dashboard shows exactly where each account is) ──
  if (m.includes("clicking submit order") || m.includes("submit order found") ||
      m.includes("submit order click") || m.includes("submit registered"))
    return "submitting";
  if (m.includes("[2/3]") || m.includes("payments:") || m.includes("continue (payment") ||
      m.includes("filling card") || m.includes("confirming payment") || m.includes("committing payment"))
    return "payment";
  if (m.includes("[1/3]") || m.includes("continue (delivery"))
    return "delivery";
  if (m.includes("checkout — starting") || m.includes("checkout - starting") ||
      m.includes("direct checkout") || m.includes("checkout script injected"))
    return "checkout";

  // ── Draw poller states ──
  if (m.includes("entry is pending") || m.includes("you're in line") || m.includes("pending / you"))
    return "pending";
  if (m.includes("polling every") || m.includes("still pending") || m.includes("check #"))
    return "polling";
  if (m.includes("draw ended") || m.includes("draw closed") || m.includes("sold out"))
    return "closed";
  if (m.includes("entry_limit_exceeded") || (m.includes("limit") && m.includes("exceeded")))
    return "limit";
  if (m.includes("holding") && m.includes("drop window"))
    return "waiting";
  return null;
}

// ── Message handler ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Boot bootstrap (content script) asks us to fetch this profile's central
  // config from the native host and hand back ready-to-store settings.
  if (msg.type === "boot_fetch_settings") {
    // Booting tells us which profile we are — remember it and report our
    // version so the dashboard's stale-profile banner sees this profile.
    rememberSelfProfileDir(msg.profileDir).then(() => reportVersionToHost(msg.profileDir));
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

  // Preflight: the bootstrap content script (opened with #snkrsPreflight=…)
  // hands us its page-level signals; we complete the checks, publish the
  // result to the shared preflight folder, and close the tab (unless the
  // URL asked to keep it open for debugging).
  if (msg.type === "preflight_page_checks") {
    const tabId = sender?.tab?.id;
    (async () => {
      let entry = null;
      try {
        entry = await runPreflight(msg.profileDir, msg.page || {}, msg.accessToken || "");
      } catch (e) {
        // Still publish SOMETHING so the dashboard doesn't show "no data".
        entry = { profileDir: msg.profileDir, ts: Date.now(), version: EXT_VERSION,
          checks: { host: { ok: null, detail: "preflight crashed: " + String(e && e.message || e) } } };
        await nativeSend({ cmd: "setPreflight", profileDir: msg.profileDir, entry }).catch(() => {});
      }
      sendResponse({ ok: true, entry });
      if (!msg.keepOpen && tabId != null) {
        // Small grace so late cookies (Kasada) land before the tab dies.
        setTimeout(() => chrome.tabs.remove(tabId, () => { chrome.runtime.lastError; }), 4000);
      }
    })();
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

  // Dashboard asks us to resolve a SKU into launch data (launchId + slug +
  // size→skuId map) so it can build direct gs.nike.com checkout URLs.
  if (msg.type === "resolve_launch") {
    resolveLaunchData(msg.sku, msg.country)
      .then(d => sendResponse(d))
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
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

  // Manual LAUNCH ALL was used — DISARM every automatic opener so nothing
  // opens a second set of tabs at drop time (which caused duplicate submits).
  if (msg.type === "cancel_dash_launch") {
    (async () => {
      await chrome.alarms.clear(DASH_LAUNCH_ALARM);
      await chrome.storage.local.remove(DASH_LAUNCH_STORE);
      // Clear any armed per-tab reload alarms too.
      const d = await chrome.storage.local.get(RELOAD_STORE);
      const m = d[RELOAD_STORE] || {};
      for (const tabId of Object.keys(m)) await chrome.alarms.clear(`snkrsReload#${tabId}`);
      await chrome.storage.local.remove(RELOAD_STORE);
      sendResponse({ ok: true });
    })();
    return true;
  }

  // Dashboard arms (or cancels) the auto-launch alarm for per-account scheduled opens.
  if (msg.type === "arm_drop_launch") {
    const cfg = msg.config;
    chrome.alarms.clear(DASH_LAUNCH_ALARM, async () => {
      const autoAccts = (cfg?.accounts || []).filter(a =>
        a.autoLaunch && a.profileDir && (a.size || (a.targets || []).length));
      const timeISO   = cfg?.drop?.dropTimeISO;
      // Only auto-OPEN when the user opted in. With auto-open off (the default),
      // the user launches the pages themselves — the drop time still gates SUBMIT
      // via the URL marker, so we simply don't arm the open-alarm here.
      const autoOpen  = cfg?.drop?.autoOpen ?? cfg?.drop?.scheduleEnabled ?? false;
      if (!autoOpen || !timeISO || !autoAccts.length) {
        await chrome.storage.local.remove(DASH_LAUNCH_STORE);
        sendResponse({ ok: true, armed: false, reason: autoOpen ? undefined : "auto-open off — launch manually" });
        return;
      }
      const dropMs = Date.parse(timeISO);
      if (isNaN(dropMs)) {
        sendResponse({ ok: true, armed: false, reason: "invalid date" });
        return;
      }
      // Open PREP seconds before the drop (fresh page/Kasada + time to fill);
      // the content scripts hold SUBMIT until the real drop time.
      const openAt = dropMs - DASH_PREP_LEAD_MS;
      if (dropMs <= Date.now() - LAUNCH_GRACE_MS) {
        // Drop passed long ago → stale. Disarm silently.
        await chrome.storage.local.remove(DASH_LAUNCH_STORE);
        sendResponse({ ok: true, armed: false, reason: "drop time already passed — not auto-opening" });
        return;
      }
      if (openAt <= Date.now()) {
        // Inside the prep window (or just past drop, within grace) — open now.
        await chrome.storage.local.set({ [DASH_LAUNCH_STORE]: cfg });
        autoDashLaunch();
        sendResponse({ ok: true, armed: false, reason: "time already passed — launching now" });
        return;
      }
      await chrome.storage.local.set({ [DASH_LAUNCH_STORE]: cfg });
      chrome.alarms.create(DASH_LAUNCH_ALARM, { when: openAt });
      // Report the actual DROP time to the dashboard banner (not the prep time).
      sendResponse({ ok: true, armed: true, when: dropMs, count: autoAccts.length });
    });
    return true;
  }

  // A held direct-checkout tab asks us to reload it just before the drop, via a
  // background alarm that survives Chrome discarding the idle tab.
  if (msg.type === "arm_reload") {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId != null && msg.dropAtMs) {
      const when = Number(msg.dropAtMs) - (Number(msg.prepMs) || 30000);
      armTabReload(tabId, when, msg.bootUrl || (sender.tab && sender.tab.url) || "");
    }
    return false;
  }

  if (msg.type === "log") {
    sendLog(msg.message);
    // Live status board: attribute the log line to a specific TAB (profile + tab
    // id) so the command-center monitor can show every product tab in every
    // browser — not just the last one per profile. Stored locally AND mirrored
    // to the shared status folder so the dashboard (a different Chrome profile)
    // can see them all.
    const tabId = sender?.tab?.id;
    const profileDir = tabId != null ? tabProfileMap[tabId] : null;
    if (profileDir != null && tabId != null) {
      const code = parseStatusFromLog(msg.message);
      const key = `${profileDir}#${tabId}`;
      const label = tabLabel(sender && sender.tab);
      chrome.storage.local.get("snkrsStatus", (data) => {
        const s = data.snkrsStatus || {};
        const prev = s[key] || {};
        const entry = {
          key, profileDir, tabId,
          label: label || prev.label || "",
          code: code || prev.code || "checkout", // keep last known stage if none
          message: msg.message,
          time: Date.now(),
        };
        s[key] = entry;
        chrome.storage.local.set({ snkrsStatus: s });
        pushStatusToShared(key, entry); // throttled, best-effort
      });
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