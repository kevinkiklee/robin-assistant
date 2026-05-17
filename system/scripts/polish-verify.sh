#!/usr/bin/env bash
# Polish program exit-gate verifier. Usage: polish-verify.sh --phase=a|--phase=b
set -euo pipefail

phase="${1:-}"
if [[ "$phase" != "--phase=a" && "$phase" != "--phase=b" ]]; then
  echo "usage: $0 --phase=a|--phase=b" >&2
  exit 2
fi

tmp_mcp=$(mktemp -t polish-mcp.XXXXXX)
trap 'rm -f "$tmp_mcp"' EXIT

echo "[polish-verify $phase] pnpm test:unit"
pnpm test:unit

echo "[polish-verify $phase] pnpm test:integration"
pnpm test:integration

echo "[polish-verify $phase] robin doctor"
node system/bin/robin doctor

echo "[polish-verify $phase] robin --help"
node system/bin/robin --help > /dev/null

echo "[polish-verify $phase] mcp tool inventory"
if [[ -f system/scripts/list-mcp-tools.js ]]; then
  node system/scripts/list-mcp-tools.js > "$tmp_mcp"
  echo "  ok ($(wc -l < "$tmp_mcp") tools listed)"
else
  echo "  (list-mcp-tools.js not yet present; skipping until Task 4 lands)"
fi

echo "[polish-verify $phase] git status clean (excluding user-data, .claude, tmp)"
if git status --porcelain | grep -vE '^\?\? (user-data|\.claude|tmp)/' | grep -q "."; then
  echo "  unexpected uncommitted changes:" >&2
  git status --porcelain | grep -vE '^\?\? (user-data|\.claude|tmp)/' >&2
  exit 1
fi

echo "[polish-verify $phase] PASS"
