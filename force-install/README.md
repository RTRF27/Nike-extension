# Auto-update is back — and it no longer nukes itself

The old force-install here was removed because it wrote the Chrome policy
**before** verifying anything: when the policy claimed the extension ID but
Chrome couldn't reach the crx server at startup, Chrome dropped the extension
in every profile.

That's fixed. The replacement lives in **[`../update-server/`](../update-server/)**
and is safe by construction: it packs a self-verified signed `.crx`, starts +
health-checks the local update server, and only writes
`ExtensionInstallForcelist` **after** it has actually downloaded `update.xml`
and the crx from that server. A down server can no longer remove anything —
Chrome keeps a policy-installed extension even when the update URL is
unreachable.

## Use this instead

- **Install auto-update:** run `../update-server/install-windows.bat` as
  administrator (macOS/Linux: `../update-server/install-unix.sh`).
- **Publish an update:** bump `version` in `manifest.json`, then
  `node ../update-server/pack.js`.
- The dashboard's **PREFLIGHT** tab shows a version banner flagging any profile
  still on an old build.

See [`../update-server/README.md`](../update-server/README.md) for the full
explanation of why this pipeline can't repeat the old failure.

## Cleaning up the OLD broken installer

If you ever ran the original auto-installer, purge its leftovers once with
**`REMOVE-ALL.bat`** (right-click → Run as administrator) before installing the
new one. It deletes the old policy, login task, and server. Then quit Chrome
completely, reopen, and run the new installer above.

## Manual load (no auto-update)

Still supported, per profile: `chrome://extensions` → Developer mode → **Load
unpacked** → select the repo folder. It loads with the ID pinned by the
manifest `key`. (The auto-update installer is the way to avoid doing this 14
times.)
