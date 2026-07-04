#!/usr/bin/env bash
# ============================================================
# SNKRS Bot — auto-update installer (macOS / Linux).
# Same pipeline as Windows: pack → keep-alive service → start →
# VERIFY end-to-end → only then apply the Chrome policy.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${SNKRS_UPDATE_PORT:-38473}"
BASE="http://127.0.0.1:${PORT}"

command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js required."; exit 1; }

echo "[1/5] Packing + signing…"
node "$SCRIPT_DIR/pack.js"
EXT_ID="$(node -p "require('$SCRIPT_DIR/dist/info.json').id")"
echo "      Extension ID: $EXT_ID"

echo "[2/5] Installing keep-alive service…"
case "$(uname -s)" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/com.snkrs.updateserver.plist"
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.snkrs.updateserver</string>
  <key>ProgramArguments</key><array>
    <string>$(command -v node)</string>
    <string>$SCRIPT_DIR/server.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    ;;
  Linux)
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/snkrs-update-server.service" <<EOF
[Unit]
Description=SNKRS Bot local extension update server

[Service]
ExecStart=$(command -v node) $SCRIPT_DIR/server.js
Restart=on-failure

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now snkrs-update-server.service
    ;;
  *) echo "Unsupported OS."; exit 1;;
esac

echo "[3/5] Server starting…"
echo "[4/5] Verifying pipeline end-to-end…"
ok=""
for i in $(seq 1 15); do
  if curl -fsS "$BASE/update.xml" | grep -q "$EXT_ID" &&
     curl -fsS "$BASE/snkrs-bot.crx" -o /tmp/snkrs-verify.crx &&
     [ "$(head -c4 /tmp/snkrs-verify.crx)" = "Cr24" ]; then
    ok=1; break
  fi
  sleep 1
done
rm -f /tmp/snkrs-verify.crx
if [ -z "$ok" ]; then
  echo "VERIFICATION FAILED — Chrome policy NOT applied. Fix the server first."
  exit 1
fi
echo "      update.xml OK, crx OK (Cr24 magic verified)"

echo "[5/5] Applying Chrome force-install policy…"
FORCELIST_ENTRY="${EXT_ID};${BASE}/update.xml"
case "$(uname -s)" in
  Darwin)
    defaults write com.google.Chrome ExtensionInstallForcelist -array "$FORCELIST_ENTRY"
    echo "      (written via 'defaults write com.google.Chrome')"
    ;;
  Linux)
    POLICY_DIR="/etc/opt/chrome/policies/managed"
    POLICY_JSON="{\"ExtensionInstallForcelist\": [\"$FORCELIST_ENTRY\"]}"
    if [ -w "$POLICY_DIR" ] 2>/dev/null; then
      echo "$POLICY_JSON" > "$POLICY_DIR/snkrs-bot.json"
    else
      echo "$POLICY_JSON" | sudo tee "$POLICY_DIR/snkrs-bot.json" >/dev/null || {
        echo "Could not write $POLICY_DIR/snkrs-bot.json — create it manually with:"
        echo "  $POLICY_JSON"
        exit 1
      }
    fi
    ;;
esac

echo
echo "DONE. Restart Chrome fully, then check chrome://policy for"
echo "ExtensionInstallForcelist = $FORCELIST_ENTRY"
echo "To publish an update: bump manifest version → node pack.js"
