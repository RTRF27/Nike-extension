# Extension install — manual load (force-install removed)

The automated force-install (Chrome enterprise policy + local crx server) has
been **removed**. It caused the extension to vanish on restart: when the policy
claimed the extension ID but Chrome couldn't reach the local crx server at
startup, Chrome dropped the policy-managed copy *and* overrode any manually
loaded one.

## If your extension keeps disappearing — clean up first

If you ever ran the old auto-installer, purge its leftovers once:

1. Right-click **`REMOVE-ALL.bat`** → **Run as administrator**.
   - Deletes the Chrome `ExtensionInstallForcelist` / `ExtensionInstallSources`
     policy (HKLM + HKCU), the login scheduled task, and the local server.
2. Quit Chrome completely (Task Manager → end all `chrome.exe`), reopen.
3. `chrome://policy` → **Reload policies** → confirm `ExtensionInstallForcelist`
   is gone.

## Loading the extension (the supported way)

In each profile you use:

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the repo folder (the one with `manifest.json`).
3. It loads as ID `gkfbgibdipccnmamfeflgpahoehpbebf` (pinned by the manifest
   `key`, so it matches the native host) and **stays loaded across restarts**.

Repeat once per profile. Because the launcher no longer passes
`--load-extension`, bot-launched profiles keep whatever you loaded manually.
