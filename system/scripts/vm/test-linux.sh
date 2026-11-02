#!/usr/bin/env bash
# Run `pnpm install --frozen-lockfile && pnpm build && pnpm typecheck && pnpm test` inside
# node:24-bookworm. Exit status is the suite's.
#
# The image is built from a staging copy, never the repo: node_modules, dist,
# .git and user-data are left out, then only the code in user-data/extensions
# and user-data/scripts is added back, plus their test fixtures (no caches, no
# secrets, no .env files).
#
#   ROBIN_USER_DATA_SRC  where to read user-data code from (default: <repo>/user-data)
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ud_src="${ROBIN_USER_DATA_SRC:-$repo/user-data}"
image=robin-test-linux

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

# No trailing slash on node_modules/.git: in a worktree they are a symlink and a
# file. .dockerignore is dropped because it excludes user-data and docs — the
# staging dir is already the curated context. Gitignored local notes stay out.
rsync -a \
  --exclude='node_modules' --exclude='/dist/' --exclude='/.git' --exclude='/user-data/' \
  --exclude='/.worktrees/' --exclude='/.dockerignore' \
  --exclude='/.superpowers/' --exclude='/docs/design/' --exclude='/CLAUDE.local.md' \
  "$repo/" "$staging/"

for sub in extensions scripts; do
  [ -d "$ud_src/$sub" ] || continue
  mkdir -p "$staging/user-data/$sub"
  rsync -a --prune-empty-dirs \
    --exclude='node_modules' --exclude='dem_cache/' --exclude='.venv/' --exclude='*.env*' --exclude='secrets/' \
    --include='*/' --include='*.ts' --include='*.mjs' --include='*.js' --include='*.json' --include='*.yaml' \
    --exclude='*' \
    "$ud_src/$sub/" "$staging/user-data/$sub/"
  # Test fixtures (scraped HTML, RSS, …) of every type, each file at most 5 MB.
  rsync -a --prune-empty-dirs --max-size=5m \
    --exclude='node_modules' --exclude='dem_cache/' --exclude='.venv/' --exclude='*.env*' --exclude='secrets/' \
    --include='*/' --include='fixtures/***' --exclude='*' \
    "$ud_src/$sub/" "$staging/user-data/$sub/"
done

# Belt and braces: refuse to build if anything secret-shaped slipped through.
leaks="$(find "$staging" -name '*.env*' -print; \
  [ -d "$staging/user-data" ] && find "$staging/user-data" -name secrets -print || true)"
if [ -n "$leaks" ]; then
  echo "test-linux: refusing to build — secret-shaped paths in staging:" >&2
  echo "$leaks" | sed "s|^$staging/|  |" >&2
  exit 1
fi

docker build -f "$staging/system/scripts/vm/Dockerfile.test" -t "$image" "$staging"
docker run --rm "$image"
