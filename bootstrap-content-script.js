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

  function getMarker(name) {
    const hash = location.hash || "";
    const search = location.search || "";
    const m = (hash + "&" + search).match(new RegExp(name + "=([^&]+)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // ── Preflight visit (#snkrsPreflight=<profileDir>) ──────────
  // The dashboard's Preflight page opens each profile here to health-check
  // it before a drop. We collect what only a nike.com PAGE can see — the
  // OIDC session token in localStorage and login-state DOM signals — and
  // hand them to the background, which finishes the checks (host, version,
  // cookies, identity API), publishes the result, and closes this tab.
  const preflightProfile = getMarker("snkrsPreflight");
  if (preflightProfile) {
    const keepOpen = !!getMarker("snkrsKeep");

    const collectAndSend = () => {
      const login = { hasToken: false, tokenFresh: false, signInVisible: false, accountMenu: false };
      let accessToken = "";
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!/^oidc\.user:/i.test(k)) continue;
          try {
            const v = JSON.parse(localStorage.getItem(k));
            if (v && v.access_token) {
              login.hasToken = true;
              const expMs = (Number(v.expires_at) || 0) * 1000;
              login.tokenFresh = expMs > Date.now();
              if (!accessToken || login.tokenFresh) accessToken = v.access_token;
            }
          } catch (e) {}
        }
      } catch (e) {}
      try {
        // "Sign In" / "Join Us" CTAs mean logged OUT; an avatar/account
        // entry means logged in. Both are best-effort — the token decides.
        const signIn = document.querySelector(
          'button[data-testid*="signin" i], a[href*="unite" i], a[data-testid*="join" i]');
        const btnTexts = Array.from(document.querySelectorAll("nav button, nav a, header button, header a"))
          .slice(0, 80).map(n => (n.textContent || "").trim().toLowerCase());
        login.signInVisible = !!signIn || btnTexts.some(t => t === "sign in" || t === "join us");
        login.accountMenu = !!document.querySelector(
          '[data-testid*="avatar" i], [aria-label*="account" i], img[alt*="avatar" i]');
      } catch (e) {}

      chrome.runtime.sendMessage({
        type: "preflight_page_checks",
        profileDir: preflightProfile,
        page: { login },
        accessToken,
        keepOpen,
      }, () => { chrome.runtime.lastError; });
    };

    // Let the SPA hydrate (the nav/Sign-In button renders late).
    if (document.readyState === "complete") setTimeout(collectAndSend, 4000);
    else window.addEventListener("load", () => setTimeout(collectAndSend, 4000));
    return; // a preflight tab never boots the drop config
  }

  const profileDir = getMarker("snkrsBoot");
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
