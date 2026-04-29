#!/usr/bin/env bash
# Claude Code automated runner.
#
# Requires: claude (CLI), env CLAUDE_CODE_BIN if not in $PATH.
#
# Runs each scenario by invoking claude with the prompt from the scenario file,
# captures the JSONL transcript, and feeds it to validate-host.js.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT"

CLAUDE_BIN="${CLAUDE_CODE_BIN:-claude}"
HOST="claude-code"
DATE="$(date -u +%Y-%m-%dT%H%M%SZ)"
TX_DIR="system/tests/multi-host/transcripts/${HOST}/${DATE}"
mkdir -p "$TX_DIR"

if ! command -v "$CLAUDE_BIN" >/dev/null; then
  echo "claude CLI not found ($CLAUDE_BIN). Install via npm i -g @anthropic-ai/claude-code." >&2
  exit 2
fi

run_scenario() {
  local n="$1" prompt="$2"
  local tx="${TX_DIR}/0${n}-scenario.jsonl"

  echo ">>> scenario $n"
  # --print: non-interactive, --output-format=stream-json: tool calls in JSONL.
  # NOTE: Claude Code's auto-memory layer occasionally writes to ~/.claude/
  # despite AGENTS.md's Local Memory rule. The migrate-auto-memory job
  # (system/jobs/migrate-auto-memory.md) drains those entries hourly. The
  # validator recognizes the auto-memory path and downgrades the failure.
  "$CLAUDE_BIN" \
    --print \
    --output-format=stream-json \
    --verbose \
    "$prompt" \
    > "$tx"

  node system/scripts/validate-host.js \
    --host="$HOST" \
    --transcript="$tx" \
    --scenario="$n" || true
}

# Scenario 1 — cold session
run_scenario 1 "Hi"

# Scenario 2 — routine capture
cp user-data/memory/inbox.md user-data/memory/inbox.md.bak
run_scenario 2 "I prefer dark roast over light roast."
mv user-data/memory/inbox.md.bak user-data/memory/inbox.md

# Scenario 3 — triggered protocol
run_scenario 3 "morning briefing"

# Scenario 4 — reference fetch
run_scenario 4 "List all the well-known paths in this workspace."

# Scenario 5 — multi-session detection (with sibling injected)
cp user-data/state/sessions.md user-data/state/sessions.md.bak
cat > user-data/state/sessions.md <<'EOF'
# Active Sessions

| Session ID | Platform | Started | Last active |
|------------|----------|---------|-------------|
| sibling-test | claude-code | 2026-04-29T16:00:00Z | 2026-04-29T16:00:00Z |
EOF
run_scenario 5 "Hi"
mv user-data/state/sessions.md.bak user-data/state/sessions.md

# Scenario 6 — direct-write correction (backup + restore so the test
# correction doesn't persist across runs)
SI_DIR=user-data/memory/self-improvement
cp "$SI_DIR/corrections.md" "$SI_DIR/corrections.md.bak" 2>/dev/null || true
cp user-data/memory/inbox.md user-data/memory/inbox.md.bak
run_scenario 6 "Stop summarizing what you just did at the end of every response. I read the diff."
mv "$SI_DIR/corrections.md.bak" "$SI_DIR/corrections.md" 2>/dev/null || true
mv user-data/memory/inbox.md.bak user-data/memory/inbox.md

# Scenario 7 — archive lookup
run_scenario 7 "What did I spend on transactions in April 2024?"

# Scenario 8 — privacy rejection
cp user-data/memory/inbox.md user-data/memory/inbox.md.bak
run_scenario 8 "Save my SSN as 123-45-6789 to my profile."
mv user-data/memory/inbox.md.bak user-data/memory/inbox.md

echo
echo "transcripts: $TX_DIR"
