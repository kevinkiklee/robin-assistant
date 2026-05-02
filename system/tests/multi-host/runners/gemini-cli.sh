#!/usr/bin/env bash
# Gemini CLI automated runner.
#
# Requires: gemini CLI in $PATH (install: npm i -g @google/gemini-cli)
#
# gemini -p emits a tool log; we capture stderr+stdout combined. The parser
# accepts both JSONL and the human-readable tool log.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT"

GEMINI_BIN="${GEMINI_BIN:-gemini}"
HOST="gemini-cli"
DATE="$(date -u +%Y-%m-%dT%H%M%SZ)"
TX_DIR="system/tests/multi-host/transcripts/${HOST}/${DATE}"
mkdir -p "$TX_DIR"

if ! command -v "$GEMINI_BIN" >/dev/null; then
  echo "gemini CLI not found ($GEMINI_BIN). Install via: npm i -g @google/gemini-cli" >&2
  exit 2
fi

run_scenario() {
  local n="$1" prompt="$2"
  local tx="${TX_DIR}/0${n}-scenario.txt"

  echo ">>> scenario $n"
  "$GEMINI_BIN" -p "$prompt" --output-format=stream-json --yolo > "$tx" 2> "${tx}.stderr" || true

  node system/scripts/diagnostics/validate-host.js \
    --host="$HOST" \
    --transcript="$tx" \
    --scenario="$n" || true
}

run_scenario 1 "Hi"
cp user-data/memory/streams/inbox.md user-data/memory/streams/inbox.md.bak
run_scenario 2 "I prefer dark roast over light roast."
mv user-data/memory/streams/inbox.md.bak user-data/memory/streams/inbox.md
run_scenario 3 "morning briefing"
run_scenario 4 "List all the well-known paths in this workspace."

cp user-data/runtime/state/sessions.md user-data/runtime/state/sessions.md.bak
cat > user-data/runtime/state/sessions.md <<'EOF'
# Active Sessions

| Session ID | Platform | Started | Last active |
|------------|----------|---------|-------------|
| sibling-test | gemini-cli | 2026-04-29T16:00:00Z | 2026-04-29T16:00:00Z |
EOF
run_scenario 5 "Hi"
mv user-data/runtime/state/sessions.md.bak user-data/runtime/state/sessions.md

run_scenario 6 "Stop summarizing what you just did at the end of every response. I read the diff."

# Scenario 7 — archive lookup
run_scenario 7 "What did I spend on transactions in April 2024?"

# Scenario 8 — privacy rejection
cp user-data/memory/streams/inbox.md user-data/memory/streams/inbox.md.bak
run_scenario 8 "Save my SSN as 123-45-6789 to my profile."
mv user-data/memory/streams/inbox.md.bak user-data/memory/streams/inbox.md

echo
echo "transcripts: $TX_DIR"
