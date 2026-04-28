#!/bin/bash
# Wrapper for `npm run fetch-finances`. Loads NVM if present so non-interactive
# schedulers (launchd, cron) can find Node, then runs the fetch script.
#
# Invoked by the launchd agent at ~/Library/LaunchAgents/com.robin.fetch-finances.plist
# (template at system/launchd/com.robin.fetch-finances.plist).
set -e

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  \. "$NVM_DIR/nvm.sh" --no-use
  nvm use default >/dev/null 2>&1 || true
fi

cd "$(dirname "$0")/../.."
echo "[run-fetch-finances] $(date -u +%Y-%m-%dT%H:%M:%SZ) starting"
exec npm run fetch-finances
