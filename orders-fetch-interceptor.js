// Runs in MAIN world so it can wrap the page's own network calls before any
// orders API requests are made. Forwards raw JSON responses to the
// isolated-world orders-content-script.js via postMessage.
//
// Nike's orders SPA fetches data in a few different ways (fetch + XHR, and the
// endpoint URL doesn't always contain the word "order"), so we cast a wide net:
// any JSON response that either has an order-ish URL OR whose body looks like
// order data is forwarded. The content script + dashboard dedupe and decide.
(function () {
  if (window.__snkrsOrdInt) return;
  window.__snkrsOrdInt = true;

  // Does the parsed body look like order data? Cheap structural sniff.
  function looksLikeOrders(data) {
    if (!data || typeof data !== "object") return false;
    let hit = false;
    const KEYS = /^(orders?|orderHistory|orderNumber|orderId|lineItems|orderLines|orderItems|fulfillment|placedDate|orderDate)$/i;
    const scan = (o, depth) => {
      if (hit || depth > 4 || !o || typeof o !== "object") return;
      for (const k of Object.keys(o)) {
        if (KEYS.test(k)) { hit = true; return; }
        const v = o[k];
        if (v && typeof v === "object") scan(v, depth + 1);
        if (hit) return;
      }
    };
    try { scan(data, 0); } catch {}
    return hit;
  }

  const URL_HINT = /order|purchase|commerce|\/buy\/|fulfillment|\/me\//i;
  const URL_SKIP = /analytics|collect|event|pixel|beacon|tracking|telemetry|metric|\.png|\.jpg|\.svg|\.css|\.js(\?|$)/i;

  function maybeForward(url, text) {
    if (!text) return;
    let data;
    try { data = JSON.parse(text); } catch { return; }
    const urlHit = URL_HINT.test(url) && !URL_SKIP.test(url);
    if (urlHit || looksLikeOrders(data)) {
      try { window.postMessage({ __snkrsOrd: 1, data, url: String(url || "") }, "*"); } catch {}
    }
  }

  // ── Wrap fetch ──────────────────────────────────────────────
  const _fetch = window.fetch ? window.fetch.bind(window) : null;
  if (_fetch) {
    window.fetch = async function (...args) {
      const url = args[0] instanceof Request ? args[0].url : String(args[0] || "");
      const res = await _fetch(...args);
      if (!URL_SKIP.test(url)) {
        res.clone().text().then(t => maybeForward(url, t)).catch(() => {});
      }
      return res;
    };
  }

  // ── Wrap XMLHttpRequest ─────────────────────────────────────
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const _open = XHR.prototype.open;
    const _send = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__snkrsUrl = String(url || "");
      return _open.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      this.addEventListener("load", () => {
        try {
          const url = this.__snkrsUrl || "";
          if (URL_SKIP.test(url)) return;
          if (this.responseType && this.responseType !== "text" && this.responseType !== "json") return;
          let text = "";
          if (this.responseType === "json") {
            try { text = JSON.stringify(this.response); } catch { return; }
          } else {
            text = this.responseText || "";
          }
          if (text) maybeForward(url, text);
        } catch {}
      });
      return _send.apply(this, arguments);
    };
  }

  // ── Scrape embedded JSON (server-rendered pages) ────────────
  // Some Nike order pages ship the order data inside the HTML (Next.js
  // __NEXT_DATA__, a preloaded-state global, or <script type=application/json>)
  // and never fire a client fetch/XHR. Sweep those a few times as the SPA
  // hydrates.
  function sweepEmbedded() {
    try {
      if (window.__NEXT_DATA__) maybeForward("__NEXT_DATA__", JSON.stringify(window.__NEXT_DATA__));
    } catch {}
    for (const g of ["__PRELOADED_STATE__", "__INITIAL_STATE__", "__APP_STATE__"]) {
      try { if (window[g]) maybeForward(g, JSON.stringify(window[g])); } catch {}
    }
    try {
      document.querySelectorAll('script[type="application/json"], script[id*="order" i], script[id*="state" i]')
        .forEach(s => { if (s.textContent && /order/i.test(s.textContent)) maybeForward("embedded:" + (s.id || "json"), s.textContent); });
    } catch {}
  }
  let _sweeps = 0;
  const _sw = setInterval(() => { if (++_sweeps > 10) clearInterval(_sw); sweepEmbedded(); }, 1000);
  if (document.readyState !== "loading") sweepEmbedded();
  else document.addEventListener("DOMContentLoaded", sweepEmbedded);
})();
