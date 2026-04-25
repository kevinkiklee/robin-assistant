#!/usr/bin/env bash
# Lock helper for pillar file edits.
# Uses mkdir for atomic lock acquisition (POSIX guarantee).
#
# Usage:
#   ./lock.sh acquire <file> <session-id> [timeout-seconds]
#   ./lock.sh release <file> <session-id>
#
# Exit codes:
#   0 = success
#   1 = lock held by another session
#   2 = stale lock (cleaned, retry)
#   3 = ownership mismatch on release

set -euo pipefail

ACTION="${1:-}"
FILE="${2:-}"
SESSION_ID="${3:-}"
TIMEOUT="${4:-300}"  # 5 min default stale threshold

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# State lives in .state/ at workspace root, not alongside the script
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR="$WORKSPACE_ROOT/.state/coordination"
mkdir -p "$STATE_DIR/locks"
LOCK_DIR="$STATE_DIR/locks/${FILE//\//_}.lock"

if [ -z "$ACTION" ] || [ -z "$FILE" ] || [ -z "$SESSION_ID" ]; then
  echo "usage: $0 {acquire|release} <file> <session-id> [timeout]" >&2
  exit 64
fi

case "$ACTION" in
  acquire)
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "$SESSION_ID" > "$LOCK_DIR/owner"
      date +%s > "$LOCK_DIR/acquired_at"
      echo "ACQUIRED: $FILE by $SESSION_ID"
      exit 0
    fi
    # Lock exists. Check if stale.
    if [ -f "$LOCK_DIR/acquired_at" ]; then
      ACQUIRED_AT=$(cat "$LOCK_DIR/acquired_at")
      NOW=$(date +%s)
      AGE=$((NOW - ACQUIRED_AT))
      if [ "$AGE" -gt "$TIMEOUT" ]; then
        OWNER=$(cat "$LOCK_DIR/owner" 2>/dev/null || echo "unknown")
        echo "STALE: $FILE held by $OWNER for ${AGE}s (>${TIMEOUT}s) — cleaning"
        rm -rf "$LOCK_DIR"
        # Retry acquisition once
        if mkdir "$LOCK_DIR" 2>/dev/null; then
          echo "$SESSION_ID" > "$LOCK_DIR/owner"
          date +%s > "$LOCK_DIR/acquired_at"
          echo "ACQUIRED: $FILE by $SESSION_ID (after stale cleanup)"
          exit 0
        fi
      fi
      OWNER=$(cat "$LOCK_DIR/owner" 2>/dev/null || echo "unknown")
      echo "HELD: $FILE held by $OWNER for ${AGE}s" >&2
      exit 1
    fi
    # Lock dir exists but no metadata — corrupt, clean it
    echo "CORRUPT: $FILE lock dir has no metadata — cleaning"
    rm -rf "$LOCK_DIR"
    exit 2
    ;;
  release)
    if [ ! -d "$LOCK_DIR" ]; then
      echo "NO_LOCK: $FILE was not locked"
      exit 0
    fi
    OWNER=$(cat "$LOCK_DIR/owner" 2>/dev/null || echo "")
    if [ "$OWNER" != "$SESSION_ID" ]; then
      echo "NOT_OWNER: $FILE locked by $OWNER, not $SESSION_ID — refusing release" >&2
      exit 3
    fi
    rm -rf "$LOCK_DIR"
    echo "RELEASED: $FILE by $SESSION_ID"
    exit 0
    ;;
  *)
    echo "unknown action: $ACTION" >&2
    exit 64
    ;;
esac
