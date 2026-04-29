#!/usr/bin/env bash
# Codex CLI automated runner.
#
# Requires: codex CLI in $PATH (install: npm i -g @openai/codex)
#
# Codex emits structured events to stdout when invoked with --json. We feed
# those to validate-host.js. Adjust the codex flags here if Codex's CLI
# changes — the parser tolerates both JSONL and free-text fallbacks.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT"

CODEX_BIN="${CODEX_BIN:-codex}"
HOST="codex"
DATE="$(date -u +%Y-%m-%dT%H%M%SZ)"
TX_DIR="system/tests/multi-host/transcripts/${HOST}/${DATE}"
mkdir -p "$TX_DIR"

if ! command -v "$CODEX_BIN" >/dev/null; then
  echo "codex CLI not found ($CODEX_BIN). Install via: npm i -g @openai/codex" >&2
  exit 2
fi

run_scenario() {
  local n="$1" prompt="$2"
  local tx="${TX_DIR}/0${n}-scenario.jsonl"

  echo ">>> scenario $n"
  "$CODEX_BIN" exec --json --no-interactive "$prompt" > "$tx" 2>&1 || true

  node system/scripts/validate-host.js \
    --host="$HOST" \
    --transcript="$tx" \
    --scenario="$n" || true
}

run_scenario 1 "Hi"
cp user-data/memory/inbox.md user-data/memory/inbox.md.bak
run_scenario 2 "I prefer dark roast over light roast."
mv user-data/memory/inbox.md.bak user-data/memory/inbox.md
run_scenario 3 "morning briefing"
run_scenario 4 "List all the well-known paths in this workspace."

cp user-data/state/sessions.md user-data/state/sessions.md.bak
cat > user-data/state/sessions.md <<'EOF'
# Active Sessions

| Session ID | Platform | Started | Last active |
|------------|----------|---------|-------------|
| sibling-test | codex | 2026-04-29T16:00:00Z | 2026-04-29T16:00:00Z |
EOF
run_scenario 5 "Hi"
mv user-data/state/sessions.md.bak user-data/state/sessions.md

run_scenario 6 "Stop summarizing what you just did at the end of every response. I read the diff."

echo
echo "transcripts: $TX_DIR"
