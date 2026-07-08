# Auto-update: signed .crx + local update server

One managed copy of the extension in **every Chrome profile**, updated from
one place. No more "Load unpacked" × 14, no more mixed versions at drop time.

```
manifest.json version bump
        │  node update-server/pack.js
        ▼
dist/snkrs-bot.crx  (CRX3, signed with YOUR key → stable extension ID)
dist/update.xml     (Omaha manifest)
        │  served by server.js on http://127.0.0.1:38473 (loopback only)
        ▼
Chrome policy: ExtensionInstallForcelist = "<id>;http://127.0.0.1:38473/update.xml"
        ▼
Every profile installs + auto-updates the same build.
Dashboard banner + Preflight page show which profiles are still stale.
```

## Migrating from "Load unpacked" (do this on a calm day)

If your profiles currently run the extension via **Load unpacked**, switching to
force-install ends the manual-reload / mixed-version / ID-drift pain for good —
one policy entry installs and auto-updates the extension in **every** profile.

1. **Run it:** right-click `install-windows.bat` → **Run as administrator**.
   It packs + signs, starts the local update server, verifies the download, then
   writes the Chrome policy. It prints the extension ID and whether it changed.
   - **If it found your signing key** (`.keys\crx-signing-key.pem`): the ID stays
     `gkfbg…` — same as your unpacked copies and native host. Cleanest case.
   - **If no key was found:** it mints a NEW id **once** and saves the key. The
     new id differs from your old unpacked copies, so you'll remove those in
     step 4.
2. **Quit Chrome completely** (Task Manager → end every `chrome.exe`), reopen.
3. `chrome://policy` → **Reload policies** → confirm `ExtensionInstallForcelist`
   shows the ID. In a couple of profiles, `chrome://extensions` should show the
   extension as **"Installed by enterprise policy."**
4. **Remove the old "Load unpacked" copies** from every profile
   (`chrome://extensions` → Remove). Especially important if the ID changed —
   otherwise the bot runs twice per profile.
5. **Back up** `.keys\crx-signing-key.pem` somewhere safe. Losing it is the only
   thing that forces another ID change; `pack.js` now refuses to regenerate
   silently without it.

From then on: bump `version` in `manifest.json`, run `node update-server/pack.js`
(no admin, no ID change), and every profile updates within ~5h (or instantly via
the Update button). The dashboard's **DIAGNOSE** shows each profile as
`force-installed` once migrated.

## Install (Windows)

1. Make sure Node.js is installed.
2. Right-click **`install-windows.bat`** → **Run as administrator**.
3. Quit Chrome completely, reopen, check `chrome://policy`.
4. Once the managed copy shows up in your profiles, remove the old
   "Load unpacked" copies (`chrome://extensions` in each profile).

macOS/Linux: `./install-unix.sh`. Remove everything with
`uninstall-windows.bat` (as admin).

## Publish an update

1. Bump `"version"` in `manifest.json` (e.g. `3.3` → `3.4`).
2. `node update-server/pack.js`
3. Done. Chrome re-checks the update URL every few hours; to force it now,
   open `chrome://extensions` in any profile → **Update**. The dashboard's
   version banner (and the Preflight page) show exactly which profiles have
   picked it up.

## Why the OLD force-install nuked itself — and why this one can't

The old installer wrote the Chrome policy **first** and started a server it
never verified. When Chrome started before the server (or the crx was bad),
the policy still *claimed* the extension ID — so Chrome blocked the manually
loaded copy AND had no crx to install. Result: extension gone everywhere.

This pipeline is ordered so that failure is always safe:

1. **Pack is self-verifying** — `pack.js` re-parses the crx it just built and
   cryptographically verifies the signature + ID before writing anything.
2. **The policy is written LAST**, only after the installer has actually
   downloaded `update.xml` *and* the crx from the running server and checked
   the `Cr24` magic bytes. No working pipeline → no policy → Chrome untouched.
3. **A down server can no longer remove anything.** Once a policy-installed
   extension is on disk, Chrome keeps running it even when the update URL is
   unreachable — it just can't update until the server is back. The logon
   task restarts the server at every login, and duplicate starts exit
   harmlessly (port-in-use = someone's already serving).
4. `update.xml` 404s rather than serving a bogus manifest when `dist/` is
   empty — Chrome treats that as "no update available".

## The signing key = the extension ID

The extension ID is derived from the signing key. `pack.js` looks for a key
in this order:

1. `SNKRS_CRX_KEY` env var
2. `<repo>/.keys/*.pem` — if you still have the key from the old installer,
   the ID stays `gkfbgibdipccnmamfeflgpahoehpbebf`
3. `update-server/key.pem`
4. otherwise it **generates** `.keys/crx-signing-key.pem` and rewrites
   `manifest.json`'s `"key"` + the native-host `allowed_origins` to the new
   ID so everything stays consistent.

**Back the PEM up.** It is gitignored and cannot be regenerated — losing it
means a new extension ID and a one-time re-install in every profile.

## Files

| File | Role |
|------|------|
| `crx3.js` | Dependency-free CRX3 packer (zip + protobuf header + RSA sign + verify) |
| `pack.js` | Build/sign/verify `dist/` (crx, update.xml, info.json) |
| `server.js` | Loopback HTTP server: `/update.xml` `/snkrs-bot.crx` `/version.json` `/healthz` |
| `install-windows.bat` | Pack → logon task → start → **verify** → write policy |
| `uninstall-windows.bat` | Remove policy + task + server |
| `install-unix.sh` | Same pipeline for macOS (launchd) / Linux (systemd) |
| `run-hidden.vbs` | Starts the server with no console window (used by the task) |
