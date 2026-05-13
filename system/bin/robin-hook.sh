#!/bin/sh
# robin-hook: POSIX shim that resolves a usable node binary and execs the
# JS hook dispatcher. Lives at <package_root>/bin/robin-hook.sh; package
# root is the parent of this script's directory.

set -u

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# SELF_DIR is system/bin; its parent is system/. The dispatcher lives at
# system/io/hooks/dispatcher.js, so anchor against the system root.
SYSTEM_DIR=$(CDPATH= cd -- "$SELF_DIR/.." && pwd)
DISPATCHER="$SYSTEM_DIR/io/hooks/dispatcher.js"

try_exec() {
  if [ -n "${1:-}" ] && [ -x "$1" ]; then
    exec "$1" "$DISPATCHER" "$@"
  fi
}

# 1) ROBIN_NODE override.
if [ -n "${ROBIN_NODE:-}" ] && [ -x "$ROBIN_NODE" ]; then
  exec "$ROBIN_NODE" "$DISPATCHER" "$@"
fi

# 2) command -v node on PATH.
NODE_BIN=$(command -v node 2>/dev/null || true)
if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
  exec "$NODE_BIN" "$DISPATCHER" "$@"
fi

# 3) nvm shim path.
if [ -n "${NVM_DIR:-}" ]; then
  for cand in "$NVM_DIR"/versions/node/*/bin/node; do
    if [ -x "$cand" ]; then
      exec "$cand" "$DISPATCHER" "$@"
    fi
  done
fi

# 4) asdf shim path.
if [ -n "${ASDF_DIR:-}" ]; then
  for cand in "$ASDF_DIR"/installs/nodejs/*/bin/node; do
    if [ -x "$cand" ]; then
      exec "$cand" "$DISPATCHER" "$@"
    fi
  done
fi

# 5) Common absolute paths.
for cand in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
  if [ -x "$cand" ]; then
    exec "$cand" "$DISPATCHER" "$@"
  fi
done

# Fail-soft: trace and exit 0 so the host is never broken.
echo "robin-hook: cannot find node" >&2
exit 0
