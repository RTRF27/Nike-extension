// Orders page content script — relays API-intercepted + DOM-scraped order
// data back to the dashboard via background.js.
//
// The dashboard opens the orders URL tagged with #snkrsOrderCheck=<profileDir>
// so we know which Chrome profile (= account) these orders belong to.

// ── Profile attribution ───────────────────────────────────────
let _dir = '';
(function () {
  const m = location.hash.match(/[#&]snkrsOrderCheck=([^&#]+)/);
  if (m) {
    _dir = decodeURIComponent(m[1]);
    try { history.replaceState(null, '', location.pathname + location.search); } catch {}
  }
})();

// ── Relay fetch-interceptor payloads ──────────────────────────
window.addEventListener('message', (e) => {
  if (!e.data || !e.data.__snkrsOrd) return;
  chrome.runtime.sendMessage({
    type:     'orders_api_data',
    profileDir: _dir,
    raw:      e.data.data,
    apiUrl:   e.data.url,
  });
});

// ── DOM scrape fallback ───────────────────────────────────────
// Fires if no API data arrives (e.g. cached response, no orders).
let _scraped = false;

function _scrape() {
  if (_scraped) return;
  const orders = [];
  const seen   = new Set();

  // Walk every text node looking for Nike order-number patterns
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const m = node.data.match(/\b(C\d{10,}|[A-Z]{2,3}\d{8,})\b/);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);

    // Walk up to a "card-sized" ancestor
    let el = node.parentElement;
    for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
      if (el.offsetHeight > 60) break;
    }
    const imgEl = el ? el.querySelector('img[src]') : null;
    const text  = el ? el.textContent.replace(/\s+/g, ' ').trim() : node.data;

    orders.push({
      orderNumber: m[1],
      rawText:    text.slice(0, 400),
      imageUrl:   imgEl ? imgEl.src : '',
    });
  }

  if (orders.length) {
    _scraped = true;
    chrome.runtime.sendMessage({ type: 'orders_dom_data', profileDir: _dir, orders });
  }
}

// Poll – give the SPA up to ~30 s to render
let _ticks = 0;
const _t = setInterval(() => {
  if (++_ticks > 20 || _scraped) { clearInterval(_t); return; }
  if (document.body) _scrape();
}, 1500);
