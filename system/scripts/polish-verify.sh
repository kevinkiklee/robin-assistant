#!/usr/bin/env bash
# Polish program exit-gate verifier. Usage: polish-verify.sh --phase=a|--phase=b
set -euo pipefail

phase="${1:-}"
if [[ "$phase" != "--phase=a" && "$phase" != "--phase=b" ]]; then
  echo "usage: $0 --phase=a|--phase=b" >&2
  exit 2
fi

echo "[polish-verify $phase] pnpm test"
pnpm test

echo "[polish-verify $phase] pnpm test:integration (if present)"
if pnpm run | grep -q "^  test:integration"; then
  pnpm test:integration
else
  echo "  (no test:integration script; skipping)"
fi

echo "[polish-verify $phase] robin doctor --json"
node system/bin/robin doctor --json | tee /tmp/polish-doctor.json >/dev/null
if ! jq -e '.exit_code == 0' /tmp/polish-doctor.json > /dev/null; then
  echo "  doctor returned non-zero exit_code" >&2
  jq '.' /tmp/polish-doctor.json >&2
  exit 1
fi

echo "[polish-verify $phase] robin --help"
node system/bin/robin --help > /dev/null

echo "[polish-verify $phase] mcp tool inventory"
if [[ -f system/scripts/list-mcp-tools.js ]]; then
  node system/scripts/list-mcp-tools.js > /tmp/polish-mcp-tools.txt
  echo "  ok ($(wc -l < /tmp/polish-mcp-tools.txt) tools listed)"
fi

echo "[polish-verify $phase] git status clean (excluding user-data, .claude, tmp)"
if git status --porcelain | grep -v "^?? user-data/" | grep -v "^?? .claude/" | grep -v "^?? tmp/" | grep -q "."; then
  echo "  unexpected uncommitted changes:" >&2
  git status --porcelain | grep -v "^?? user-data/" | grep -v "^?? .claude/" | grep -v "^?? tmp/" >&2
  exit 1
fi

echo "[polish-verify $phase] PASS"
