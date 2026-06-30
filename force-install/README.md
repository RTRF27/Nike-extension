# Force-install the extension into every Chrome profile

`--load-extension` (what the launcher used) is unreliable: Chrome **ignores it
when Chrome is already running**, and **newer Chrome versions disable it
entirely** for security. That's why newly created profiles open the Nike page
but have no extension running in them.

This folder force-installs the extension via Chrome's enterprise policy. Once
set up, the extension appears in **every profile automatically** — current and
future.

> **Use the HTTP installer below.** Modern Chrome (v73+) refuses `file://`
> update URLs, so the older `install-forceinstall.bat` (file://) does **not**
> work on current Chrome and is kept only for reference.

---

## Recommended: HTTP installer (works on modern Chrome)

This serves the `.crx` over `http://127.0.0.1` from a tiny local Node server,
points the force-install policy at it, and runs the server automatically at
login via Task Scheduler.

1. **Pull the repo** on this machine (it ships the signed `snkrs-bot.crx`).
2. Make sure **Node.js** is installed (`node --version` works).
3. Right-click **`install-http-forceinstall.bat`** → **Run as administrator**.
   - It writes the policy, creates the login task, starts the server now, and
     prints a health check (should say `SNKRS update server OK`).
4. Quit Chrome **completely** — close every window, end any leftover
   `chrome.exe` in Task Manager.
5. Reopen Chrome. The extension installs into **every profile** automatically.
6. Remove any old **Load unpacked** copy from `chrome://extensions` to avoid two
   copies side-by-side.

Verify: `chrome://policy` shows `ExtensionInstallForcelist` =
`gkfbgibdipccnmamfeflgpahoehpbebf;http://127.0.0.1:38473/update.xml`, and
`chrome://extensions` shows **"Installed by enterprise policy"**.

**To undo:** right-click **`uninstall-http-forceinstall.bat`** → Run as
administrator (removes policy, login task, and stops the server), then restart
Chrome.

### How it stays running
A scheduled task **"SNKRS Bot Extension Server"** runs `run-server-hidden.vbs`
at every login, which starts `serve.js` with no console window. Chrome checks
the local server at startup (and periodically) to install/update the extension.
If the server isn't running when Chrome starts, the install just retries on the
next launch once it's up.

### Default port
`38473` (localhost only). Override by setting `SNKRS_SERVE_PORT` before starting
the server and changing the port in `install-http-forceinstall.bat`.

---

## Legacy: file:// installer (does NOT work on modern Chrome)

`install-forceinstall.bat` / `uninstall-forceinstall.bat` set the same policy
but with a `file://` update URL. Chrome blocks `file://` for force-install, so
this is non-functional on current versions — use the HTTP installer above.

---

## Extension ID changed

To force-install, the extension must be packed and signed into a `.crx`, and the
ID is derived from the signing key. The original ID could not be reproduced
(its private key isn't in the repo), so a new stable identity was generated:

```
gkfbgibdipccnmamfeflgpahoehpbebf
```

This is now pinned in `manifest.json` (`key`) and in the native host's
`allowed_origins`. If you previously loaded the extension **unpacked**, remove
that old copy from `chrome://extensions` to avoid two copies side-by-side.

After running this, the dashboard lives at:
`chrome-extension://gkfbgibdipccnmamfeflgpahoehpbebf/dashboard.html`

---

## After you change extension code

The force-installed copy is the `.crx`, not your working folder, so re-pack and
bump the version:

1. Edit code as usual.
2. Bump `"version"` in `manifest.json` (e.g. `1.3` → `1.4`).
3. Re-pack:  `node pack-crx.cjs`   (needs `.keys/snkrs-extension.pem` + `npm install crx3`)
4. The local server serves the new `.crx` and version automatically — no
   reinstall needed. Chrome auto-updates within a few hours, or immediately if
   you restart Chrome. (If the server was already running, that's fine; it reads
   the version fresh on each request.)

> The signing key `.keys/snkrs-extension.pem` is **gitignored on purpose**.
> Keep it backed up privately — without it you cannot re-pack updates and would
> have to generate a new ID again.

---

## If the extension doesn't appear

- Make sure the server is up: open `http://127.0.0.1:38473/health` — it should
  say `SNKRS update server OK`. If not, run `install-http-forceinstall.bat`
  again as administrator (it starts the server), or check the
  **"SNKRS Bot Extension Server"** task in Task Scheduler.
- Fully quit Chrome (Task Manager → no `chrome.exe`) before reopening.
- `chrome://policy` → **Reload policies** → confirm `ExtensionInstallForcelist`
  shows `gkfbgibdipccnmamfeflgpahoehpbebf;http://127.0.0.1:38473/update.xml`.
- Legacy note: the old `file://` installer does not work on modern Chrome — host
  over the local `http://` server (this installer) instead.
  address — the rest stays the same.
