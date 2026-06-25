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

// ── Relay fetch/XHR-interceptor payloads ──────────────────────
window.addEventListener('message', (e) => {
  if (!e.data || !e.data.__snkrsOrd) return;
  try {
    chrome.runtime.sendMessage({
      type:       'orders_api_data',
      profileDir: _dir,
      raw:        e.data.data,
      apiUrl:     e.data.url,
    });
  } catch {}
});

// ── DOM scrape fallback ───────────────────────────────────────
// Always runs alongside the API path. Nike's list view shows each order's
// Style code (e.g. "IM3198-052") and status ("Delivered"), but NOT the order
// number — so we anchor on Style codes / status instead of order numbers.

const STYLE_RE  = /\b[A-Z]{2,4}\d{3,4}-\d{2,4}\b/;          // IM3198-052
const ORDER_RE  = /\b(C\d{9,}|[A-Z]{2,3}\d{8,})\b/;          // C0123456789
const STATUS_RE = /\b(Delivered|Shipped|Arriving|Out for delivery|In transit|Processing|Confirmed|Order placed|Preparing|Cancelled|Canceled|Returned|Refunded|On its way|Ready)\b/i;

function _closestCard(startEl) {
  // Climb to a container that looks like an order card (has an image and a
  // reasonable height), without going all the way to <body>.
  let el = startEl;
  for (let i = 0; i < 8 && el && el !== document.body; i++) {
    const h = el.offsetHeight || 0;
    if (h >= 80 && el.querySelector && el.querySelector('img')) return el;
    el = el.parentElement;
  }
  return startEl.parentElement || startEl;
}

function _field(text, re) {
  const m = text.match(re);
  return m ? m[1] || m[0] : '';
}

// ── Structured scrape (preferred) ─────────────────────────────
// Nike's orders list renders each order as a [data-testid="order-item"] card
// with stable testid'd children. Read those directly — no guessing.
function _scrapeStructured() {
  const cards = document.querySelectorAll('[data-testid="order-item"]');
  if (!cards.length) return [];
  const orders = [];
  cards.forEach((card) => {
    const img   = card.querySelector('img[data-testid="Product Image"]') || card.querySelector('img[src]');
    const status = (card.querySelector('[data-testid="status-text"]')?.textContent || '').trim();
    const nameEl = card.querySelector('[data-testid="productNameLink-headline"]');
    const name   = (nameEl?.getAttribute('aria-label') || nameEl?.textContent || '').trim();
    const subtitle = (card.querySelector('[data-testid="Product Subtitle"]')?.textContent || '').trim();
    const sizeRaw  = (card.querySelector('[data-testid="Product Size"]')?.textContent || '').trim();
    const styleRaw = (card.querySelector('[data-testid="Product Style Color"]')?.textContent || '').trim();

    const size  = sizeRaw.replace(/^\s*size\s*/i, '').trim();
    const styleM = styleRaw.match(STYLE_RE);
    const style  = styleM ? styleM[0] : styleRaw.replace(/^\s*style\s*/i, '').trim();

    // aria-label usually already contains the full "<collection> <subtitle>".
    let fullName = name;
    if (subtitle && (!fullName || !fullName.toLowerCase().includes(subtitle.toLowerCase()))) {
      fullName = fullName ? `${fullName} ${subtitle}` : subtitle;
    }

    if (!style && !fullName && !status) return; // empty card, skip
    orders.push({
      orderNumber: '',
      style:       style || '',
      status:      status || '',
      size:        size || '',
      rawText:     (fullName || subtitle || '').slice(0, 160),
      imageUrl:    img ? img.src : '',
    });
  });
  return orders;
}

function _scrape() {
  // Try the precise testid-based scrape first; fall back to the heuristic
  // tree-walker only if Nike changes the markup.
  const structured = _scrapeStructured();
  if (structured.length) return structured;

  if (!document.body) return [];
  const orders = [];
  const seenCards = new Set();

  // Anchor candidates: every text node containing a Style code or a status word.
  const anchors = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const t = node.data;
    if (!t || t.length > 200) continue;
    if (STYLE_RE.test(t) || /\bStyle\b/i.test(t) || (STATUS_RE.test(t) && t.length < 40)) {
      if (node.parentElement) anchors.push(node.parentElement);
    }
  }

  for (const a of anchors) {
    const card = _closestCard(a);
    if (!card || seenCards.has(card)) continue;
    seenCards.add(card);

    const text = (card.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const style = _field(text, STYLE_RE);
    const order = _field(text, ORDER_RE);
    // Require at least a style code or an order number to count it as a card.
    if (!style && !order) continue;

    const imgEl  = card.querySelector('img[src]');
    const status = _field(text, STATUS_RE);
    const size   = (text.match(/\bSize\s+([A-Za-z0-9.\/ ]{1,8})/) || [])[1] || '';

    orders.push({
      orderNumber: order || '',
      style:       style || '',
      status:      status || '',
      size:        (size || '').trim(),
      rawText:     text.slice(0, 300),
      imageUrl:    imgEl ? imgEl.src : '',
    });
  }

  return orders;
}

// Poll – give the SPA time to render, and keep refreshing as more cards load.
let _lastCount = -1;
let _ticks = 0;
const _t = setInterval(() => {
  if (++_ticks > 24) { clearInterval(_t); return; }
  const orders = _scrape();
  if (orders.length && orders.length !== _lastCount) {
    _lastCount = orders.length;
    try {
      chrome.runtime.sendMessage({ type: 'orders_dom_data', profileDir: _dir, orders });
    } catch {}
  }
}, 1200);
