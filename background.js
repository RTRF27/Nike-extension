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
});

// Re-arm the alarm when the service worker starts (e.g. browser restart).
chrome.runtime.onStartup.addListener(() => {
  scheduleDropAlarm();
  rescheduleDashLaunch();
});
chrome.runtime.onInstalled.addListener(() => {
  scheduleDropAlarm();
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