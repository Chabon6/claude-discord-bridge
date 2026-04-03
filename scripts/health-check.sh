#!/usr/bin/env bash
# Health check for claude-discord-bridge
# Returns 0 if the process is running, 1 otherwise.

set -euo pipefail

if command -v pm2 &>/dev/null; then
  pm2 describe claude-discord-bridge &>/dev/null && exit 0
fi

# Fallback: check if any node process is running our entry point
pgrep -f "claude-discord-bridge" &>/dev/null && exit 0

echo "claude-discord-bridge is not running"
exit 1
