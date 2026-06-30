# Force-install the extension into every Chrome profile

`--load-extension` (what the launcher used) is unreliable: Chrome **ignores it
when Chrome is already running**, and **newer Chrome versions disable it
entirely** for security. That's why newly created profiles open the Nike page
but have no extension running in them.

This folder force-installs the extension via Chrome's enterprise policy. Once
set up, the extension appears in **every profile automatically** — current and
future — and survives Chrome's `--load-extension` lockdown.

---

## One-time setup

1. **Pull the repo** on this machine (it ships the signed `snkrs-bot.crx`).
2. Right-click **`install-forceinstall.bat`** → **Run as administrator**.
3. Quit Chrome **completely** — close every window, and end any leftover
   `chrome.exe` in Task Manager.
4. Reopen Chrome.
5. Open `chrome://extensions` in any profile — you'll see **Nike SNKRS Bot SG**
   marked *"Installed by enterprise policy"*. It's now in all profiles.

To confirm the policy loaded: visit `chrome://policy` and look for
`ExtensionInstallForcelist`.

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

The force-installed copy is the `.crx`, not your working folder, so you must
re-pack and bump the version:

1. Edit code as usual.
2. Bump `"version"` in `manifest.json` (e.g. `1.2` → `1.3`).
3. Re-pack:  `node pack-crx.cjs`   (needs `.keys/snkrs-extension.pem` + `npm install crx3`)
4. Re-run `install-forceinstall.bat` as administrator (it regenerates
   `update.xml` with the new version).
5. Restart Chrome — it picks up the new version.

> The signing key `.keys/snkrs-extension.pem` is **gitignored on purpose**.
> Keep it backed up privately — without it you cannot re-pack updates and would
> have to generate a new ID again.

---

## To undo

Right-click **`uninstall-forceinstall.bat`** → Run as administrator, then
restart Chrome.

---

## If the extension doesn't appear

- Make sure you fully quit Chrome (Task Manager → no `chrome.exe`) before reopening.
- `chrome://policy` → click **Reload policies** → confirm `ExtensionInstallForcelist`
  shows `gkfbgibdipccnmamfeflgpahoehpbebf;file:///...update.xml`.
- If your Chrome build refuses a `file://` update URL, host the two files over a
  local web server instead and change the policy's update URL to the `http://`
  address — the rest stays the same.
