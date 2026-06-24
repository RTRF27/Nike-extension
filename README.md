# Nike SNKRS Bot SG — Multi-Account Drop Dashboard

Auto-selects a size and submits SNKRS raffle entries on `nike.com/sg`, and now
runs **one drop across many Chrome profiles** from a single control room.

## What’s new (v1.1)

The original single-profile bot still works exactly as before. Added on top:

- **Drop Dashboard** (`dashboard.html`) — a full-page control room:
  - **Drop details** entered once → every account cops the **same product**.
  - **Card details** entered once → applied to **all accounts** (with optional
    per-account card overrides).
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

1. **Drop details** — paste the product URL once (keyword/SKU only needed for
   multi-product collection pages).
2. **Payment card** — enter the shared card. Add a per-account card only if a
   particular account checks out with a different card (“own card” toggle).
3. **Accounts** — add a row per account, pick its **Chrome profile** (the list
   auto-populates when the launcher is connected) and its **size**.
4. **Save central config** — writes `~/.snkrs-bot/config.json`.
5. **🚀 Launch all** (or per-account **launch**) — each profile opens onto the
   drop and auto-configures itself. The bot then runs as usual in each window.

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
