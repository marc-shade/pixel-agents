#!/bin/bash
set -e
PLIST="com.pixel-agents.server.plist"
SRC="$(dirname "$0")/../$PLIST"
DEST="$HOME/Library/LaunchAgents/$PLIST"

mkdir -p "$HOME/.pixel-agents"
mkdir -p "$HOME/Library/LaunchAgents"

# Unload if already loaded
launchctl unload "$DEST" 2>/dev/null || true

cp "$SRC" "$DEST"
launchctl load "$DEST"

echo "Pixel Agents server installed and started."
echo "  Dashboard: http://127.0.0.1:3777"
echo "  Logs: ~/.pixel-agents/server.log"
echo "  Uninstall: bin/uninstall-launchd.sh"
