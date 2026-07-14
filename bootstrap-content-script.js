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

  // ── UPDATE ALL (#snkrsReload=<ts>) ──────────────────────────
  // The dashboard's "UPDATE ALL PROFILES" opens each profile here with a reload
  // timestamp. Ask the background to hot-reload the extension from disk (picks
  // up the latest unpacked code without restarting Chrome). Deduped by ts in the
  // background so it fires at most once. This tab is then just a leftover page.
  const reloadTs = getMarker("snkrsReload");
  if (reloadTs) {
    try { chrome.runtime.sendMessage({ type: "check_reload", ts: Number(reloadTs) }); } catch (e) {}
    return; // extension is about to reload — don't run the normal boot flow
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

    // Pull phone / country / address from Nike — from the PAGE context, where
    // the session cookies + anti-bot tokens are valid (the background's
    // cookieless call to the same API just 403s). Tries the identity API first,
    // then falls back to scraping the rendered settings page. All best-effort:
    // anything it can't read is simply left blank and the account's region can
    // be set manually in the dashboard.
    async function readProfile(accessToken) {
      const out = { phone: "", country: "", addressLine1: "", profileFetched: false };

      // Deep-scan an arbitrary JSON object for the first value whose KEY matches
      // keyRe and whose value looks right (valPred).
      const deepFind = (obj, keyRe, valPred, depth = 0) => {
        if (!obj || typeof obj !== "object" || depth > 6) return "";
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          if (keyRe.test(k) && (typeof v === "string" || typeof v === "number")) {
            const sv = String(v).trim();
            if (sv && (!valPred || valPred(sv))) return sv;
          }
        }
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          if (v && typeof v === "object") { const r = deepFind(v, keyRe, valPred, depth + 1); if (r) return r; }
        }
        return "";
      };

      if (accessToken) {
        const endpoints = [
          "https://api.nike.com/identity/user/v3/me",
          "https://api.nike.com/identity/user/v1/users/me",
        ];
        for (const url of endpoints) {
          try {
            const res = await fetch(url, {
              headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
              credentials: "include", cache: "no-store",
            });
            if (!res.ok) continue;
            const body = await res.json();
            out.profileFetched = true;
            out.phone = out.phone || deepFind(body, /phone/i, s => /\d{6,}/.test(s));
            out.country = out.country || deepFind(body, /^country$|countrycode|region/i, s => s.length <= 24);
            out.addressLine1 = out.addressLine1 || deepFind(body, /addressline1|address1|^line1$/i);
            if (out.phone && out.addressLine1) break;
          } catch (e) { /* try next endpoint */ }
        }
      }

      // DOM fallback (settings page renders phone + country in plain text).
      if (!out.phone || !out.country) {
        try {
          const bodyText = document.body ? document.body.innerText || "" : "";
          if (!out.phone) {
            // Look near a "Phone Number" label, else any phone-shaped run.
            const m = bodyText.match(/phone\s*number[^\d+]*([+\d][\d\s\-()]{6,})/i)
                   || bodyText.match(/(\+?\d[\d\s\-()]{7,}\d)/);
            if (m) out.phone = m[1].trim();
          }
          if (!out.country) {
            const cm = bodyText.match(/country\/?region[^A-Za-z]*([A-Za-z ]{3,24})/i);
            if (cm) out.country = cm[1].trim();
          }
        } catch (e) {}
      }
      return out;
    }

    const collectAndSend = async () => {
      const login = { hasToken: false, tokenFresh: false, signInVisible: false, accountMenu: false };
      let accessToken = "";
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const raw = localStorage.getItem(k);
          // Nike's OIDC session lives under an "oidc.user:*" key, but the exact
          // prefix has changed across their web builds — so also accept any
          // value that parses to an object carrying an access_token.
          if (!/oidc|access_token|nike/i.test(k) && !/access_token/.test(raw || "")) continue;
          try {
            const v = JSON.parse(raw);
            const tok = v && (v.access_token || (v.tokens && v.tokens.access_token));
            if (tok) {
              login.hasToken = true;
              const expSec = Number(v.expires_at) || Number(v.expiresAt) || 0;
              const expMs = expSec > 1e12 ? expSec : expSec * 1000; // secs or ms
              login.tokenFresh = expMs ? expMs > Date.now() : true;
              if (!accessToken || login.tokenFresh) accessToken = tok;
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

      const profile = await readProfile(accessToken);

      chrome.runtime.sendMessage({
        type: "preflight_page_checks",
        profileDir: preflightProfile,
        page: { login, profile },
        accessToken,
        keepOpen,
      }, () => { chrome.runtime.lastError; });
    };

    // Let the SPA hydrate (the nav/Sign-In button + settings fields render late).
    if (document.readyState === "complete") setTimeout(collectAndSend, 4000);
    else window.addEventListener("load", () => setTimeout(collectAndSend, 4000));
    return; // a preflight tab never boots the drop config
  }

  const profileDir = getMarker("snkrsBoot");
  if (!profileDir) return; // not a dashboard-launched tab

  function logBG(msg) {
    try { chrome.runtime.sendMessage({ type: "log", message: msg, profileDir }); } catch (e) {}
  }

  // ── Warm page → flip to gs.nike.com checkout ────────────────
  // The dashboard can launch us onto the LAUNCH PAGE (to warm Kasada / keep the
  // profile present) and pass the gs.nike.com checkout URL to switch to shortly
  // before the drop (snkrsFlip = lead ms). By loading checkout FRESH near go-live
  // — instead of parking on it for hours — its Kasada token is current at submit
  // time and it never rots into gs.nike.com/error.
  (function scheduleWarmFlip() {
    const gsB64 = getMarker("snkrsGs");
    if (!gsB64) return;
    let gsUrl = "";
    try {
      let s = gsB64.replace(/-/g, "+").replace(/_/g, "/");
      while (s.length % 4) s += "=";
      gsUrl = decodeURIComponent(escape(atob(s)));
    } catch (e) { gsUrl = ""; }
    if (!/^https?:\/\//i.test(gsUrl)) return;

    // Tell snkrs-content-script (document_idle) to stay in warm-only mode — no
    // launch-page submit, no poller reloads. This tab only warms, then flips.
    try { sessionStorage.setItem("snkrsWarmFlip", "1"); } catch (e) {}

    const flipRaw  = getMarker("snkrsFlip");
    const flipLead = flipRaw ? parseInt(flipRaw, 10) : 7 * 60 * 1000;
    const dropRaw  = getMarker("snkrsDrop");
    const dropMs   = dropRaw ? parseInt(dropRaw, 10) : NaN;
    const flipAt   = !isNaN(dropMs) ? (dropMs - flipLead) : (Date.now() + 4000);
    const MIN_WARM_MS = 4000; // brief warm even if already inside the window

    let flipped = false;
    const doFlip = () => {
      if (flipped) return; flipped = true;
      logBG(`🔀 Flipping "${profileDir}" to the direct checkout now (fresh Kasada).`);
      try { location.href = gsUrl; } catch (e) { try { location.assign(gsUrl); } catch (e2) {} }
    };
    // Poll the clock (robust to long waits) and flip on time.
    const tick = () => {
      if (flipped) return;
      const left = flipAt - Date.now();
      if (left <= 0) { doFlip(); return; }
      setTimeout(tick, Math.min(3000, Math.max(250, left)));
    };
    if (flipAt - Date.now() <= 0) setTimeout(doFlip, MIN_WARM_MS);
    else tick();

    // Small on-page banner so it's visible the tab is intentionally warming.
    const paint = () => {
      try {
        if (document.getElementById("snkrs-warm-banner")) return;
        const when = !isNaN(dropMs)
          ? new Date(flipAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
          : "soon";
        const b = document.createElement("div");
        b.id = "snkrs-warm-banner";
        b.textContent = `🔥 WARMING — checkout opens automatically at ${when}`;
        b.style.cssText = "position:fixed;top:0;left:0;width:100%;padding:9px 16px;background:#8b5cf6;color:#fff;z-index:2147483647;font:700 13px/1.3 sans-serif;text-align:center;letter-spacing:1px;";
        document.body.appendChild(b);
      } catch (e) {}
    };
    if (document.body) paint(); else window.addEventListener("DOMContentLoaded", paint);

    const secs = Math.max(0, Math.round((flipAt - Date.now()) / 1000));
    logBG(`🔥 Warming "${profileDir}" on the launch page — will flip to checkout in ~${secs}s (${flipLead / 60000} min before drop).`);
  })();

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
