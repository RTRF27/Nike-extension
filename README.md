# Nike SNKRS Bot SG — Multi-Account Drop Dashboard

Auto-selects a size and submits SNKRS raffle entries on `nike.com/sg`, and now
runs **one drop across many Chrome profiles** from a single control room.

## What’s new (v1.1)

The original single-profile bot still works exactly as before. Added on top:

- **Drop Dashboard** (`dashboard.html`) — a full-page control room:
  - **Drop details** entered once → every account cops the **same product**.
  - **Card details per account** — entered in each account row (with an optional
    shared **fallback card** for rows left blank).
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
`chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
this folder. The extension ID is pinned to
`kopeofjmoelfkdcmfcenkedojhoaolfb` (via the `key` in `manifest.json`) so the
native host manifest can trust it on every machine.

### 3. Install the native launcher (one time)
- **Windows:** double-click `native-host/install-windows.bat`
- **macOS / Linux:** `cd native-host && ./install-unix.sh`

See `native-host/README.md` for details and troubleshooting.

### 4. Open the dashboard
Click the extension icon → **⊞ OPEN DROP DASHBOARD**, or open
`chrome-extension://kopeofjmoelfkdcmfcenkedojhoaolfb/dashboard.html`.
Click **Test launcher connection** — it should go green.

## Using the dashboard

The dashboard has a built-in **Getting Started** guide at the top — these are
the same steps in short:

1. **Create Chrome profiles** — use **Create Chrome Profile** (one per Nike
   account). Each click opens a fresh profile on the Nike SG login page; sign
   in there. The profile is added to your accounts list automatically.
2. **Accounts** — one row per account. Pick its **Chrome profile**, set its
   **size**, and fill its **card details right in the row** (cards are
   per-account — Chrome profiles hold no saved cards, so the bot fills the card
   for every entry).
3. **Fallback card** (optional) — only used for a row whose own card fields are
   left blank. Leave it empty to type the card manually at checkout instead.
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
| `dashboard.html/.css/.js` | Multi-account control room (new) |
| `bootstrap-content-script.js` | Applies central config to a launched profile (new) |
| `background.js` | + native-host bridge & boot handler (existing flow unchanged) |
| `native-host/` | Launcher host, installers, host manifest (new) |
| `popup.*` | Single-profile popup (+ button to open the dashboard) |
| `snkrs-content-script.js` | Draw entry — **unchanged** |
| `gs-content-script.js` | Checkout — **unchanged** |
| `gs-payments-content-script.js` | Card autofill — **unchanged** |
