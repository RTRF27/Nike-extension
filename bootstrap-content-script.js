// ============================================================
// Nike SNKRS Bot – Boot Config Bootstrap (document_start)
// ============================================================
// When the dashboard launches a Chrome profile for a drop, it opens the
// product URL tagged with "#snkrsBoot=<profileDir>". This script runs
// BEFORE the page (document_start) and, for that profile, pulls the
// CENTRAL drop + card details out of the one shared config file (served
// by the native host) and writes them into THIS profile's local
// settings — so every launched account targets the same drop with the
// same (or its own) card, with no manual setup per profile.
//
// If the native host isn't installed, or this tab wasn't launched by the
// dashboard, this is a no-op and the profile just uses whatever was last
// saved in its own popup. Card details are NEVER placed in the URL.
// ============================================================

(function () {
  const SETTINGS_KEY = "snkrsBotSettings";

  function getBootProfile() {
    const hash = location.hash || "";
    const search = location.search || "";
    const m = (hash + "&" + search).match(/snkrsBoot=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  const profileDir = getBootProfile();
  if (!profileDir) return; // not a dashboard-launched tab

  // Strip the boot marker from the address bar so it doesn't linger or
  // get re-applied on the status-poller's reloads. Other hash params (e.g.
  // snkrsSlot) are preserved.
  try {
    const cleanedHash = location.hash
      .replace(/([#&])snkrsBoot=[^&]*/, "$1")
      .replace(/#&/, "#")
      .replace(/#$/, "");
    const cleanedSearch = location.search
      .replace(/([?&])snkrsBoot=[^&]*/, "$1")
      .replace(/[?&]$/, "");
    history.replaceState(null, "", location.pathname + cleanedSearch + cleanedHash);
  } catch (e) { /* non-fatal */ }

  console.log("[SNKRSBot boot] Applying central config for profile:", profileDir);

  chrome.runtime.sendMessage(
    { type: "boot_fetch_settings", profileDir },
    (resp) => {
      if (chrome.runtime.lastError) {
        console.warn("[SNKRSBot boot] background unreachable:", chrome.runtime.lastError.message);
        return;
      }
      if (!resp || !resp.ok || !resp.settings) {
        console.warn("[SNKRSBot boot] No central config applied:", resp && resp.error);
        return;
      }
      // Merge over whatever already exists so we don't wipe unrelated keys.
      chrome.storage.sync.get(SETTINGS_KEY, (saved) => {
        const merged = { ...(saved[SETTINGS_KEY] || {}), ...resp.settings };
        chrome.storage.sync.set({ [SETTINGS_KEY]: merged }, () => {
          console.log("[SNKRSBot boot] Central config applied for", profileDir,
            "— size", merged.preferredSize, merged.preferredSizeType);
        });
      });
    }
  );
})();
