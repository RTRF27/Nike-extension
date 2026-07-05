# Nike SNKRS Bot SG — Multi-Account Drop Dashboard

Auto-selects a size and submits SNKRS raffle entries on `nike.com/sg`, and now
runs **one drop across many Chrome profiles** from a single control room.

## What’s new (v1.1)

The original single-profile bot still works exactly as before. Added on top:

- **Drop Dashboard** (`dashboard.html`) — a full-page control room:
  - **Drop details** entered once → every account cops the **same product**.
  - **Card profiles** — create reusable named cards once, then assign one to any
    account from a dropdown (multiple accounts can share a card).
  - **Create Chrome Profile** — spin up a new profile straight onto the Nike SG
    login page, one per account.
  - **Accounts list** — each row is pinned to a **Chrome profile**.
  - **Launch** buttons that open each Chrome profile straight onto the drop —
    no manually opening profiles.
- **Native launcher host** (`native-host/`) — the small local helper that
  actually opens other Chrome profiles and stores the shared config file.

> **The checkout process is untouched.** The size-selection, draw-entry, and
> eShopWorld payment scripts are byte-for-byte the same. The dashboard only
> writes the *same* settings those scripts already read (size, keyword, card),
> just supplied centrally instead of typed into each profile’s popup.

## Why a native helper is required

Chrome extensions are sandboxed and **cannot open another Chrome profile** on
their own — there is no `chrome.*` API for it. The only supported way is a
**Native Messaging host**: a tiny local program Chrome is allowed to talk to,
which runs `chrome --profile-directory="<dir>" <url>` for each account. That’s
all `native-host/snkrs-launcher.js` does (plus reading/writing the shared
config file). Without it, the dashboard still edits config and gives you
copy-paste launch commands as a fallback.

## How it fits together

```
            ┌─────────────────────────────┐
            │   Drop Dashboard (any        │
            │   Chrome profile)            │
            │   • central drop + card      │
            │   • accounts → profiles      │
            └───────────┬─────────────────┘
                        │ Native Messaging
                        ▼
        ┌───────────────────────────────────────┐
        │  snkrs-launcher.js (native host)       │
        │  • setConfig/getConfig                 │
        │     → ~/.snkrs-bot/config.json         │
        │  • launch  → chrome --profile-directory│
        │  • listProfiles                        │
        └───────────────┬───────────────────────┘
                        │ opens each profile at
                        │ <dropUrl>#snkrsBoot=<profileDir>
                        ▼
   ┌──────────────────────────────────────────────────┐
   │  Launched Chrome profile (Nike account N)         │
   │  bootstrap-content-script.js (document_start):    │
   │   reads #snkrsBoot → asks background →            │
   │   background reads config.json via host →         │
   │   writes this profile’s snkrsBotSettings          │
   │  → existing snkrs / gs / payments scripts run     │
   │    UNCHANGED with the central size + card         │
   └──────────────────────────────────────────────────┘
```

The card number **never travels in the URL** — only the (non-sensitive)
profile directory does. Each launched profile pulls its card from the shared
`config.json` through the native host.

## Setup

### 1. Install Node.js
The native host runs on Node. Check with `node --version`. Get it from
<https://nodejs.org/> if missing.

### 2. Load the extension

**Recommended — auto-update into every profile at once** (kills the mixed-version
problem): run `update-server/install-windows.bat` as administrator (macOS/Linux:
`update-server/install-unix.sh`). It packs a signed `.crx`, serves it from a
local loopback update server, and force-installs it into **every** Chrome
profile via `ExtensionInstallForcelist` — so all profiles run the same build and
update together. See [`update-server/README.md`](update-server/README.md).
Publish a new build later with: bump `version` in `manifest.json` →
`node update-server/pack.js`.

**Or manually, per profile:** `chrome://extensions` → enable **Developer mode**
→ **Load unpacked** → select this folder. The extension ID is pinned via the
`key` in `manifest.json` so the native host manifest trusts it on every machine.
(The `key` and native-host `allowed_origins` are kept in sync automatically by
`pack.js` when you use the auto-update installer.)

### Pre-drop health check (Preflight)
Before a drop, open the dashboard's **PREFLIGHT** tab and click **RUN
PREFLIGHT**. It opens each profile on Nike, checks it, and closes the tab,
turning every account red/green on: extension version current, native host
connected, logged into Nike, delivery address on file, card assigned, cookies
warm, and a launch target set. A version banner flags any profile running a
stale build, and **LAUNCH ALL** warns before launching if any profile is
blocked — so you catch problems *before* the drop, not while 14 accounts fail
live.

### 3. Install the native launcher (one time)
- **Windows:** double-click `native-host/install-windows.bat`
- **macOS / Linux:** `cd native-host && ./install-unix.sh`

See `native-host/README.md` for details and troubleshooting.

### 4. Open the dashboard
Click the extension icon → **⊞ OPEN DROP DASHBOARD**, or open
`chrome-extension://gkfbgibdipccnmamfeflgpahoehpbebf/dashboard.html`.
Click **Test launcher connection** — it should go green.

## Using the dashboard

The dashboard has a built-in **Getting Started** guide at the top — these are
the same steps in short:

1. **Create Chrome profiles** — use **Create Chrome Profile** (one per Nike
   account). Each click opens a fresh profile on the Nike SG login page; sign
   in there. The profile is added to your accounts list automatically.
2. **Card profiles** — create each card once in **Card Profiles** (give it a
   nickname). Chrome profiles hold no saved cards, so the bot fills the card for
   every entry — define them here once and reuse.
3. **Accounts** — one row per account. Pick its **Chrome profile**, set its
   **size**, and choose which saved card it uses from the **💳 Card** dropdown.
   Multiple accounts can share the same card. Leave it on “no card” to type the
   card manually at checkout.
4. **Drop details** — paste the product URL once (keyword/SKU only needed for
   multi-product collection pages) and pick a size pool, then **🎲 Randomly
   assign** to deal sizes.
5. **Save central config** — writes `~/.snkrs-bot/config.json`.
6. **🚀 Launch all now** — opens **every** profile that has one set, even ones
   you haven’t finished configuring, so Kasada warms up. Fully-configured
   profiles go straight to the product and the bot runs; the rest open to the
   SNKRS feed to warm up. Or let **⏰ Scheduled auto-launch** open the
   ⏰-marked accounts at drop time.
7. **Order Checker** — after the drop, pick an account and **Open Orders Page**
   to verify wins; matching products are highlighted.

## Security notes

- Card details are stored **unencrypted** on your machine
  (`~/.snkrs-bot/config.json`, mode `600`, and in each profile’s
  `chrome.storage.sync`). Don’t use on shared computers.
- The native host only accepts messages from this extension’s pinned ID.
- This is for personal use on accounts you own. Respect Nike’s terms.

## Files

| File | Role |
|------|------|
| `dashboard.html/.css/.js` | Multi-account control room (+ Preflight page, version banner, Drop Replay) |
| `update-server/` | Signed-.crx packer + local update server + force-install scripts (auto-update) |
| `checkout-core.js` | Pure DOM detection + explicit checkout **state machine** (no `chrome.*`) |
| `test-harness/` | Offline checkout tests + visual runner against saved fixture HTML |
| `bootstrap-content-script.js` | Applies central config to a launched profile; also runs the per-profile Preflight checks |
| `background.js` | Native-host bridge, boot handler, version/preflight/timeline plumbing |
| `native-host/` | Launcher host, installers, host manifest (config/status/orders/versions/preflight/timeline files) |
| `popup.*` | Single-profile popup (+ button to open the dashboard) |
| `snkrs-content-script.js` | Draw entry — **unchanged** |
| `gs-content-script.js` | Checkout **adapter** — thin bridge over `checkout-core.js` (same detection + log phrasings) |
| `gs-payments-content-script.js` | Card autofill — **unchanged** |

## Reliability & testing (v3.4)

- **Checkout is now an explicit state machine** — `LOADING → DELIVERY →
  PAYMENT → READY → HOLDING → SUBMITTING → DONE/ERROR`, with per-state
  timeouts/retries and structured logging. The battle-tested DOM detection and
  the exact log phrasings are preserved; only the control flow is formalised,
  and it lives in `checkout-core.js` with no `chrome.*` dependency.
- **Offline checkout test harness** (`test-harness/`) — iterate the
  fill/confirm/submit flow against **saved fixture HTML** in a real browser,
  no live drop required. `node test-harness/test.mjs` (26 assertions) or the
  visual runner `node test-harness/serve.mjs`.
- **Drop Replay** (dashboard HISTORY tab) — every drop is recorded as a
  per-account timeline (loaded → card filled → submitted) with fill/submit
  timing and, crucially, **how many ms before/after go-live each submit
  landed**, alongside win/loss and failure reasons. The summary is persisted
  into each history run so past drops keep their timing.

## Drop-day controls (v3.6)

- **🛑 PANIC (LIVE tab)** — one click raises a shared abort flag that every
  profile's checkout polls while holding SUBMIT, so all held submits cancel at
  once (e.g. wrong product spotted). Cleared automatically on the next launch,
  or manually. The draw flow respects it too.
- **Preflight remediation** — red profiles get one-click fixes: **LOG IN**
  (opens Nike sign-in), **UPDATE** (opens `chrome://extensions` to update),
  **WARM** (warms cookies), each auto re-checking afterwards. A profile that
  never reports back within 40s is flagged **NO RESPONSE** (likely logged out).
- **🔥 WARM ALL (Preflight tab)** — opens the SNKRS feed in every profile (bot
  stays idle) to refresh Kasada/cookies before a drop; the cookies check then
  shows how long ago each profile was warmed.
