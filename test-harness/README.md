# Offline checkout test harness

Iterate and unit-test the `gs.nike.com` checkout fill/confirm/submit flow
against **saved fixture HTML**, without waiting for (or burning) a real drop.

This is possible because the DOM logic + the state machine live in
[`../checkout-core.js`](../checkout-core.js) with **zero `chrome.*`
dependencies** — the content script (`gs-content-script.js`) is just a thin
adapter around it. The same module runs live in the extension and here in
tests.

## Why a real browser (not jsdom)

The finders depend on `getComputedStyle`, `compareDocumentPosition`,
`innerText`, and minimized-window rect behaviour — jsdom fakes or omits all of
these, so it would give false confidence. The harness runs fixtures in real
Chromium via Playwright, served under the real `https://gs.nike.com` origin
(route interception), so hostname-dependent logic (`isConfirmed`, the SUBMIT
"advanced" check) behaves exactly as live.

## Run the automated tests

```bash
node test-harness/test.mjs      # or: npm test
```

Uses Playwright (already available in the Claude web environment; otherwise
`npm i -D playwright`). 26 assertions cover per-state detection on every
fixture plus three full state-machine drives (happy path → DONE, test-mode
stops before SUBMIT, and the drop-time HOLD gate never submits early).

## Iterate visually

```bash
node test-harness/serve.mjs     # or: npm run runner
# open the printed http://127.0.0.1:8977/test-harness/run.html
```

Pick a fixture, hit **Snapshot** to see what the finders detect, or **Run
machine** to drive the whole flow and watch the structured log + state
transitions stream live. Toggle *test mode* or set a *hold* to exercise those
paths. Great for tuning selectors against a new checkout layout: save the new
page's HTML into `fixtures/`, add it to the dropdown, and iterate.

## Fixtures (`fixtures/`)

| File | Checkout state it captures |
|------|-----------------------------|
| `delivery.html` | Delivery section open, awaiting the delivery CONTINUE |
| `payment-iframe.html` | Card iframe open + a payment CONTINUE after it (disambiguation) |
| `saved-card.html` | Saved card on file → `isPaymentAlreadyComplete` |
| `inline-card.html` | Inline native card fields already filled |
| `confirmation.html` | Order placed → `isConfirmed` |
| `flow-live.html` | Mutates as the machine clicks — drivable LOADING→…→DONE |

To capture a **real** page: on a live `gs.nike.com` checkout, run
`copy(document.documentElement.outerHTML)` in DevTools, paste into a new file
under `fixtures/`, and strip anything sensitive. The finders only need the
structural DOM (buttons, iframes, card inputs, the PAYMENT label).

## What's asserted

- **Detection**: each fixture's `snapshotPageState()` matches the expected
  finder outcomes (delivery vs payment CONTINUE, saved-card completeness,
  inline-fill detection, confirmation).
- **State machine**: on `flow-live.html` the machine walks
  `LOADING → DELIVERY → PAYMENT → READY → SUBMITTING → DONE`, emits the
  `filled`/`submitted`/`done` analytics events, and lands on the confirmation
  screen; test-mode halts before SUBMIT; a future `dropAt` holds SUBMIT until
  the drop (never early).
