#!/bin/bash
PLIST="com.pixel-agents.server.plist"
DEST="$HOME/Library/LaunchAgents/$PLIST"

launchctl unload "$DEST" 2>/dev/null || true
rm -f "$DEST"

echo "Pixel Agents server uninstalled."
