// ============================================================
// Nike SNKRS Bot – gs.nike.com Boot + Drop-Time Gate (document_start)
// ============================================================
// When the dashboard launches an account straight to a DIRECT checkout URL
// (https://gs.nike.com/?checkoutId=..&launchId=..&skuId=..), we skip the
// launch page entirely — so the normal launch-page bootstrap never ran and
// this profile has no central settings, and the checkout script would fire
// immediately instead of at the drop.
//
// This script (document_start, BEFORE gs-content-script's document_idle init):
//   1. Pulls this profile's central settings (card/size/enabled/webhooks)
//      from the shared config via the background, into chrome.storage.sync —
//      so the existing gs-content-script works unmodified.
//   2. If a drop time was passed (#snkrsDrop=<epochMs>) and it's still far
//      off, it HOLDS the page (suppresses gs-content-script via its own
//      run-guard) and reloads shortly before the drop, so the checkout flow
//      fills the card and clicks SUBMIT the instant it goes live.
//
// We do NOT modify gs-content-script or gs-payments-content-script — this is
// pure orchestration around them.
// ============================================================

(function () {
  const SETTINGS_KEY = "snkrsBotSettings";
  // Start the checkout flow this long BEFORE the drop, so delivery + card are
  // filled and SUBMIT ORDER is clicked the moment it becomes enabled at drop.
  // Must stay within gs-content-script's own submit-wait window.
  const LEAD_MS = 8000;

  function readParam(name) {
    const hay = (location.hash || "") + "&" + (location.search || "");
    const m = hay.match(new RegExp("[#&?]" + name + "=([^&]+)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  const profileDir = readParam("snkrsBoot");
  const dropRaw    = readParam("snkrsDrop");
  const dropMs     = dropRaw ? parseInt(dropRaw, 10) : NaN;
  const now        = Date.now();

  function log(...a) { console.log("[SNKRSBot gs-boot]", ...a); }
  function logBG(msg) { try { chrome.runtime.sendMessage({ type: "log", message: msg }); } catch (e) {} }

  // gs-content-script runs ONCE at document_idle and bails if its run-guard
  // dataset is set. We set it here (document_start) to hold it back until ready.
  function hold()    { try { document.documentElement.dataset.snkrsBotRan = String(Date.now()); } catch (e) {} }
  function release() { try { delete document.documentElement.dataset.snkrsBotRan; } catch (e) {} }

  // Fetch this profile's central settings and write them so the checkout works.
  function applySettings(cb) {
    if (!profileDir) { if (cb) cb(); return; }
    chrome.runtime.sendMessage({ type: "boot_fetch_settings", profileDir }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok || !resp.settings) {
        log("no central settings:", (chrome.runtime.lastError && chrome.runtime.lastError.message) || (resp && resp.error));
        if (cb) cb();
        return;
      }
      chrome.storage.sync.get(SETTINGS_KEY, (saved) => {
        const merged = { ...(saved[SETTINGS_KEY] || {}), ...resp.settings };
        chrome.storage.sync.set({ [SETTINGS_KEY]: merged }, () => {
          log("central settings applied for", profileDir, "size", merged.preferredSize);
          if (cb) cb();
        });
      });
    });
  }

  const gating = profileDir && !isNaN(dropMs) && now < (dropMs - LEAD_MS);

  if (gating) {
    // Too early — hold the checkout script back, settle settings, then reload
    // just before the drop so the flow runs fresh and submits at go-live.
    hold();
    applySettings();
    const wait = dropMs - LEAD_MS - now;
    logBG(`🕒 Direct checkout armed for "${profileDir}" — holding ${Math.round(wait / 1000)}s until the drop window.`);
    // Keep the guard fresh in case of a very long wait, then fire at the window.
    const keep = setInterval(hold, 60000);
    setTimeout(() => {
      clearInterval(keep);
      logBG(`⚡ Drop window reached for "${profileDir}" — starting checkout now.`);
      release();
      location.reload();
    }, wait);
  } else {
    // Drop window is here (scheduled at/just before drop) or no drop time set —
    // make sure settings exist, then let gs-content-script run normally.
    applySettings();
    if (profileDir) logBG(`⚡ Direct checkout starting for "${profileDir}".`);
  }
})();
