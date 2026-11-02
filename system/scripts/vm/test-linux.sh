#!/usr/bin/env bash
# Run `pnpm install --frozen-lockfile && pnpm build && pnpm typecheck && pnpm test` inside
# node:24-bookworm. Exit status is the suite's.
#
# The image is built from a staging copy, never the repo: only git-tracked or
# untracked-not-ignored files are copied (no node_modules, dist, .git, user-data), then only the code in user-data/extensions
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

# Allowlist: tracked + untracked-but-not-ignored files only, so no unanticipated
# gitignored file reaches the image. .dockerignore is dropped because it
# excludes user-data and docs; the staging dir is already the curated context.
git -C "$repo" ls-files -z --cached --others --exclude-standard \
  | rsync -a --from0 --files-from=- \
    --exclude='/.dockerignore' --exclude='/CLAUDE.local.md' --exclude='/.superpowers/' --exclude='/docs/design/' \
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
