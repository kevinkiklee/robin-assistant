#!/usr/bin/env bash
# Session registry helper.
#
# Usage:
#   ./register-session.sh start [config-name] [topic]
#       Generates a SESSION_ID, writes session file, lists other active sessions.
#       SESSION_ID prints on STDOUT (single line).
#       Other active sessions print on STDERR as "OTHER_SESSION: ..." lines.
#       To capture both: SESSION_ID=$(./register-session.sh start cfg "" 2>&1 | tail -1)
#       To capture cleanly: SESSION_ID=$(./register-session.sh start cfg ""); other info on stderr is visible to user/log.
#   ./register-session.sh heartbeat <session-id>
#       Refreshes mtime on session file.
#   ./register-session.sh end <session-id>
#       Removes session file.
#   ./register-session.sh list
#       Lists active (non-stale) sessions.
#   ./register-session.sh cleanup [stale-seconds]
#       Removes session files older than stale-seconds (default 300).

set -euo pipefail

ACTION="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR="$WORKSPACE_ROOT/.state/coordination"
SESSIONS_DIR="$STATE_DIR/sessions"
mkdir -p "$SESSIONS_DIR"

case "$ACTION" in
  start)
    CONFIG="${2:-default}"
    TOPIC="${3:-}"
    # Prefer uuidgen for collision-resistance; fall back to time+pid+random.
    if command -v uuidgen >/dev/null 2>&1; then
      UUID_PART="$(uuidgen | tr '[:upper:]' '[:lower:]' | tr -d '-' | head -c 8)"
      SESSION_ID="$(date -u +%Y%m%dT%H%M%S)-${CONFIG}-${UUID_PART}"
    else
      SESSION_ID="$(date -u +%Y%m%dT%H%M%S)-${CONFIG}-$$-${RANDOM}"
    fi
    SESSION_FILE="$SESSIONS_DIR/$SESSION_ID.txt"
    cat > "$SESSION_FILE" <<EOF
session_id=$SESSION_ID
config=$CONFIG
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
topic=$TOPIC
EOF
    # List others
    OTHER_COUNT=0
    for f in "$SESSIONS_DIR"/*.txt; do
      [ -f "$f" ] || continue
      [ "$f" = "$SESSION_FILE" ] && continue
      AGE=$(( $(date +%s) - $(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0) ))
      if [ "$AGE" -lt 300 ]; then
        OTHER_COUNT=$((OTHER_COUNT + 1))
        OTHER_ID=$(grep '^session_id=' "$f" | cut -d= -f2)
        OTHER_CONFIG=$(grep '^config=' "$f" | cut -d= -f2)
        echo "OTHER_SESSION: $OTHER_ID (config=$OTHER_CONFIG, age=${AGE}s)" >&2
      fi
    done
    echo "$SESSION_ID"
    ;;
  heartbeat)
    SESSION_ID="${2:-}"
    [ -z "$SESSION_ID" ] && { echo "session-id required" >&2; exit 64; }
    SESSION_FILE="$SESSIONS_DIR/$SESSION_ID.txt"
    if [ -f "$SESSION_FILE" ]; then
      touch "$SESSION_FILE"
      echo "OK"
    else
      echo "MISSING: session file not found, re-register" >&2
      exit 1
    fi
    ;;
  end)
    SESSION_ID="${2:-}"
    [ -z "$SESSION_ID" ] && { echo "session-id required" >&2; exit 64; }
    SESSION_FILE="$SESSIONS_DIR/$SESSION_ID.txt"
    rm -f "$SESSION_FILE"
    echo "ENDED: $SESSION_ID"
    ;;
  list)
    NOW=$(date +%s)
    for f in "$SESSIONS_DIR"/*.txt; do
      [ -f "$f" ] || continue
      MTIME=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
      AGE=$((NOW - MTIME))
      if [ "$AGE" -lt 300 ]; then
        SID=$(grep '^session_id=' "$f" | cut -d= -f2)
        CONF=$(grep '^config=' "$f" | cut -d= -f2)
        TOPIC=$(grep '^topic=' "$f" | cut -d= -f2)
        echo "ACTIVE: $SID (config=$CONF, age=${AGE}s, topic=$TOPIC)"
      fi
    done
    ;;
  cleanup)
    STALE_SEC="${2:-300}"
    NOW=$(date +%s)
    REMOVED=0
    for f in "$SESSIONS_DIR"/*.txt; do
      [ -f "$f" ] || continue
      MTIME=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
      AGE=$((NOW - MTIME))
      if [ "$AGE" -gt "$STALE_SEC" ]; then
        rm -f "$f"
        REMOVED=$((REMOVED + 1))
      fi
    done
    echo "CLEANED: $REMOVED stale sessions"
    # Also clean stale locks
    LOCKS_DIR="$STATE_DIR/locks"
    if [ -d "$LOCKS_DIR" ]; then
      for d in "$LOCKS_DIR"/*.lock; do
        [ -d "$d" ] || continue
        if [ -f "$d/acquired_at" ]; then
          ACQUIRED=$(cat "$d/acquired_at")
          AGE=$((NOW - ACQUIRED))
          if [ "$AGE" -gt "$STALE_SEC" ]; then
            rm -rf "$d"
            echo "CLEANED_LOCK: $(basename "$d") (age=${AGE}s)"
          fi
        fi
      done
    fi
    ;;
  *)
    echo "usage: $0 {start|heartbeat|end|list|cleanup} [args...]" >&2
    exit 64
    ;;
esac
