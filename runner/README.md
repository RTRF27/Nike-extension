# Reagan Runner

A terminal task runner for Nike **FLOW** (the normal `nike.com` store, not SNKRS
draws). It drives your **real, already-signed-in Chrome profiles** and can run
without the dashboard open.

```
tasks.csv → real Chrome profile → product by SKU → size → Add to Bag → CheckoutWorker → order
```

---

## Why it uses your real profiles

This is the whole design decision, so it's worth being blunt about it.

Nike fronts its store with **Kasada**. A clean automated Chromium — no history,
no cookies, an automation fingerprint — gets flagged quickly. Commercial bots
deal with that by shipping a patched browser plus a paid anti-bot/captcha
solving service.

This runner doesn't do that. Instead it drives the Chrome profiles you already
use, which carry **real Kasada cookies and a real browsing history**. That
existing trust is the advantage, and it's free.

**So there is no anti-bot bypass in here, by design.** If Nike flags a profile,
the answer is to warm that profile by browsing normally — not to defeat the
detector.

## The one hard constraint

**Chrome must be completely closed before you run this.**

Chrome uses one browser process per user-data-dir. If any Chrome window is open
— on any profile — a new launch just hands the URL to the running instance and
the runner never gets control (`Opening in existing browser session`). The
runner checks for this and stops with a clear message rather than failing
mysteriously.

Also: these are your real sessions. If the runner logs a profile out, that
profile is logged out when you open Chrome normally.

---

## Setup

```bash
cd runner
npm i playwright
cp config.example.json config.json
cp tasks.example.csv  tasks.csv
cp workers.example.csv workers.csv
node src/index.js --list-profiles     # see your real Chrome profiles
```

### Run

```bash
npm run dry        # carts only — never places an order
npm start          # LIVE — places real orders
```

The banner at startup always tells you which mode you're in. **Do a `--dry-run`
first.**

---

## Files

| File | What it is |
|---|---|
| `config.json` | `placeOrder`, `headless`, webhooks |
| `tasks.csv` | one row = one task |
| `workers.csv` | checkout worker policy (retries, rotation, limits) |
| `proxies/<Group>.txt` | one file per named proxy group |
| `profiles/<Group>.csv` | billing profiles (guest checkout only) |
| `orders/run-*.json` | what happened, per run |

All of these except the `*.example.*` ones are **gitignored** — they hold card
data, proxy credentials and webhook URLs.

### tasks.csv

```csv
id,sku,region,mode,sizes,chrome_profile,proxies,profile_group,delay,quantity,auto_checkout,enabled
1,HQ4309-001,sg,flow,10;10.5;11,Profile 1,Vital,SG,3000,1,true,true
```

`sizes` is a preference list (`;` separated) — the first available one wins.
Leave it empty to take **any** available size.

### workers.csv — the checkout worker

```csv
id,name,proxy_list,chrome_profile,max_retries,retry_delay_seconds,profile_rotate_retries,time_limit_minutes,stop_on_cart_expiry,enabled,profile_group
1,SG 1,Vital,Profile 1,5,5,3,25,true,true,SG
```

The worker exists because **carting and paying fail for different reasons**.
Carting fails on stock; paying fails on the card. So its retry policy is about
payment:

- `max_retries` / `retry_delay_seconds` — plain retries
- **`profile_rotate_retries`** — after N declines, switch to a *different
  billing profile*. Retrying the same declining card just declines again; this
  is the part most people miss.
- `time_limit_minutes` — hard cap on one job
- `stop_on_cart_expiry` — a dead cart can't be revived, so abandon rather than
  burn retries on it

The policy is a pure state machine (`src/checkout-worker.js`) with every side
effect injected, so it's unit-tested offline with no browser and no Nike:

```bash
npm test     # 20 checks
```

---

## How this differs from Void

| | Void | Reagan Runner |
|---|---|---|
| Browser | patchright (stealth-patched) | your real Chrome profiles |
| Anti-bot | paid Kasada + CapSolver | **none — rides existing trust** |
| Billing profiles | 50 generated guest identities | your signed-in accounts |
| Checkout worker | any worker takes any checkout link | the cart's own session must pay for it |

That last row is a real structural difference. Void's carts are guest checkouts,
so any worker can pick one up. Yours live inside a specific signed-in session,
so **a cart made by `Profile 1` must be paid for by `Profile 1`**. Each task
therefore owns its browser context end-to-end and the worker supplies only the
policy.

Consequence: `profile_rotate_retries` only does something when you're using
guest checkout with `profiles/*.csv`. On a member checkout it can't swap the
card unless that account has multiple cards saved.

## Selectors

Captured from the live site, not guessed:

```html
<fieldset data-testid="pdp-grid-selector">
  <div data-testid="pdp-grid-selector-item">
    <input class="visually-hidden" name="grid-selector-input" value="10.5">
    <label for="grid-selector-input-10.5">US 10.5</label>
<button data-testid="atb-button-mobile">Add to Bag</button>
```

The size input is **visually-hidden** — clicking it does nothing. The `<label>`
is the only real target. Nike changes markup; if carting breaks, check here
first.

## Build an .exe

```bash
npm i -g pkg
npm run build:exe      # dist/reagan-runner.exe
```

The exe still needs `playwright` and a real Chrome installed — it bundles the
runner, not the browser.

## Not verified

Carting is verified against the captured DOM. The **checkout half is not** — it
needs a signed-in session with a live bag, which can't be exercised in a test.
Run `--dry-run` first, then one live run you watch, before trusting it
unattended.
