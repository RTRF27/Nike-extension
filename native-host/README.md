# SNKRS Bot — Native Launcher Host

This is the small local helper that lets the dashboard do the two things a
sandboxed Chrome extension can’t do on its own:

1. **Open another Chrome profile** (`chrome --profile-directory="<dir>" <url>`).
2. **Read/write one shared config file** (`~/.snkrs-bot/config.json`) — the
   “generic file” that holds the central drop + card details every account uses.

It speaks Chrome **Native Messaging** (length-prefixed JSON over stdio). It is
~200 lines of Node with no dependencies.

## Install

You need Node.js on `PATH` (`node --version`).

- **Windows:** double-click `install-windows.bat`
  (creates `snkrs-launcher.bat`, writes the manifest, adds the
  `HKCU\…\NativeMessagingHosts\com.snkrs.launcher` registry key).
- **macOS / Linux:** `./install-unix.sh`
  (chmods the script, writes the manifest into Chrome’s
  `NativeMessagingHosts` folder).

Then load the extension and click **Test launcher connection** in the
dashboard.

## Commands (for reference)

| `cmd` | Does |
|-------|------|
| `ping` | Health check; returns version, platform, detected Chrome + user-data dir. |
| `listProfiles` | Reads Chrome’s `Local State` and returns profiles + display names. |
| `getConfig` | Returns the parsed `~/.snkrs-bot/config.json` (or `null`). |
| `setConfig` | Writes `~/.snkrs-bot/config.json` (mode `600`). |
| `launch` | Spawns `chrome --profile-directory=<dir> <url>`. |

## Environment overrides

If Chrome is in a non-standard place:

- `SNKRS_CHROME_PATH` — full path to the Chrome executable.
- `SNKRS_CHROME_USER_DATA_DIR` — Chrome’s “User Data” directory (for profile
  discovery).

Set these in the environment the host runs in (e.g. via the wrapper `.bat` on
Windows, or your shell profile on macOS/Linux).

## Troubleshooting

- **Pill stays red / “Launcher offline”** — the manifest isn’t registered, or
  the extension ID doesn’t match. The host manifest trusts
  `chrome-extension://gkfbgibdipccnmamfeflgpahoehpbebf/`. That ID is pinned by
  the `key` in the extension’s `manifest.json`, so it should match as long as
  you load *this* extension folder. Re-run the installer after moving the
  folder (the manifest stores an absolute path to the script).
- **“Chrome executable not found”** — set `SNKRS_CHROME_PATH`.
- **No profiles listed** — set `SNKRS_CHROME_USER_DATA_DIR`, or just type each
  profile directory manually in the dashboard (e.g. `Default`, `Profile 1`).
- **Chrome Beta/Canary/Chromium** — copy `com.snkrs.launcher.json` into that
  browser’s own `NativeMessagingHosts` folder too.

## Finding a profile’s directory name

The dashboard needs the profile **directory** (`Default`, `Profile 1`, …), not
the display name. In any Chrome window for that profile, open
`chrome://version` and read **Profile Path** — the last segment is the
directory. When the launcher is connected the dashboard lists these for you.
