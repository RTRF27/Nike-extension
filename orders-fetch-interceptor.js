// Runs in MAIN world so it can wrap the page's own fetch before any orders
// API calls are made. Forwards raw JSON responses to the isolated-world
// orders-content-script.js via postMessage.
(function () {
  if (window.__snkrsOrdInt) return;
  window.__snkrsOrdInt = true;

  const _fetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const url = args[0] instanceof Request ? args[0].url : String(args[0] || '');
    const res = await _fetch(...args);
    if (/order/i.test(url) && !/analytics|collect|event|pixel|beacon|tracking/i.test(url)) {
      res.clone().json().then(data => {
        window.postMessage({ __snkrsOrd: 1, data, url }, '*');
      }).catch(() => {});
    }
    return res;
  };
})();
