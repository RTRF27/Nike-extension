#!/usr/bin/env bash
# ============================================================
# Installs the SNKRS Bot native messaging host on macOS / Linux.
# Run this once: ./install-unix.sh
# ============================================================
set -euo pipefail

HOST_NAME="com.snkrs.launcher"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/snkrs-launcher.js"
MANIFEST_SRC="$SCRIPT_DIR/$HOST_NAME.json"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is required but 'node' was not found on PATH." >&2
  echo "Install Node from https://nodejs.org/ and re-run." >&2
  exit 1
fi

chmod +x "$HOST_SCRIPT"

# Where Chrome looks for native-messaging host manifests.
case "$(uname -s)" in
  Darwin)
    TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  Linux)
    TARGET_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    ;;
  *)
    echo "Unsupported OS. Use install-windows.bat on Windows." >&2
    exit 1
    ;;
esac

mkdir -p "$TARGET_DIR"

# Write the manifest with the REAL absolute path to the host script.
# Chrome can execute the .js directly via its shebang (#!/usr/bin/env node).
node -e '
  const fs = require("fs");
  const src = process.argv[1], out = process.argv[2], scriptPath = process.argv[3];
  const m = JSON.parse(fs.readFileSync(src, "utf8"));
  m.path = scriptPath;
  fs.writeFileSync(out, JSON.stringify(m, null, 2));
' "$MANIFEST_SRC" "$TARGET_DIR/$HOST_NAME.json" "$HOST_SCRIPT"

echo "✓ Installed native host manifest:"
echo "    $TARGET_DIR/$HOST_NAME.json"
echo "    -> path: $HOST_SCRIPT"
echo
echo "Next:"
echo "  1. Load the extension (chrome://extensions, Developer mode, Load unpacked)."
echo "  2. Open the SNKRS dashboard and click 'Test launcher connection'."
echo
echo "If you use Chrome Beta/Canary/Chromium, copy the manifest into that"
echo "browser's own NativeMessagingHosts folder too."
