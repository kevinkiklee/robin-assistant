#!/usr/bin/env bash
# Prepare a fresh Debian 12 / Ubuntu 24.04 VM to run the Robin daemon under
# systemd. Run as the robin user (not root) with sudo rights. Idempotent: each
# step is skipped when already satisfied.
#
#   bootstrap.sh [--dry-run]
#
#   --dry-run          print every mutating action as "[dry-run] <command>" and
#                      change nothing. Only read-only probes are executed.
#   ROBIN_HOME         the checkout (default: $HOME/robin-assistant-v3)
#   ROBIN_TZ           host timezone (default: `timezone:` in the checkout's
#                      user-data/config/operator.yaml; neither → left as is)
#
# Runbook: docs/CLOUD-VM.md
set -euo pipefail

dry_run=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    -h | --help)
      sed -n '2,13p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

ROBIN_HOME="${ROBIN_HOME:-$HOME/robin-assistant-v3}"
USER_NAME="${USER:-$(id -un)}"

# Read-only probes only (command -v, node --version, test). Never mutates.
probe() { "$@"; }

# Every mutating action goes through here.
run() {
  if [ "$dry_run" = 1 ]; then
    echo "[dry-run] $*"
  else
    echo "+ $*"
    "$@"
  fi
}

# Mutating action given as one shell string (pipes, redirects).
run_sh() {
  if [ "$dry_run" = 1 ]; then
    echo "[dry-run] $1"
  else
    echo "+ $1"
    bash -c "$1"
  fi
}

have() { probe command -v "$1" >/dev/null 2>&1; }

# 1. Not root.
if [ "$(id -u)" = 0 ]; then
  if [ "$dry_run" = 1 ]; then
    echo "[dry-run] note: running as root; a real run refuses (Run as the robin user with sudo rights)"
  else
    echo "Run as the robin user with sudo rights" >&2
    exit 1
  fi
fi

# 2. System packages.
run sudo apt-get update
run sudo apt-get install -y bubblewrap git build-essential python3 procps sqlite3 ca-certificates curl rsync

# 3. Node 24 (NodeSource) + pnpm via corepack.
node_major=0
if have node; then
  node_major="$(probe node --version | sed -E 's/^v([0-9]+).*/\1/')"
fi
if [ "${node_major:-0}" -lt 24 ] 2>/dev/null; then
  run_sh 'curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -'
  run sudo apt-get install -y nodejs
else
  echo "node $(probe node --version): ok"
fi
run sudo corepack enable
run corepack prepare pnpm@10.33.0 --activate

# 4. Timezone: ROBIN_TZ, else operator.yaml's `timezone:` — never a baked-in zone.
tz="${ROBIN_TZ:-}"
operator_yaml="$ROBIN_HOME/user-data/config/operator.yaml"
if [ -z "$tz" ] && probe test -f "$operator_yaml"; then
  tz="$(sed -nE 's/^timezone:[[:space:]]*["'"'"']?([A-Za-z0-9_+\/-]+).*/\1/p' "$operator_yaml" | head -n 1)"
fi
if [ -n "$tz" ]; then
  run sudo timedatectl set-timezone "$tz"
else
  echo "timezone: unchanged (set ROBIN_TZ or operator.yaml timezone:)"
fi

# 5. Keep the user systemd manager running after logout.
run sudo loginctl enable-linger "$USER_NAME"

# 6. Claude Code CLI.
if have claude; then
  echo "claude: present"
else
  run sudo npm install -g @anthropic-ai/claude-code
fi

# 7. cloudflared (tunnel configuration is a later milestone).
if have cloudflared; then
  echo "cloudflared: present"
else
  run_sh 'sudo mkdir -p --mode=0755 /usr/share/keyrings && curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null'
  run_sh 'echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null'
  run sudo apt-get update
  run sudo apt-get install -y cloudflared
fi

# 8-10. Need the checkout.
daemon_env="$ROBIN_HOME/user-data/config/secrets/daemon.env"
if [ -d "$ROBIN_HOME" ] || [ "$dry_run" = 1 ]; then
  if [ ! -d "$ROBIN_HOME" ]; then
    echo "[dry-run] note: no checkout at $ROBIN_HOME yet; steps below need it"
  fi
  # 8. Install + build.
  run_sh "cd '$ROBIN_HOME' && pnpm install --frozen-lockfile && pnpm build"

  # 9. Daemon-only env file (mode 0600, comments only; fill the values by hand).
  if [ -e "$daemon_env" ]; then
    echo "daemon.env: present"
  else
    run install -d -m 0700 "$(dirname "$daemon_env")"
    run_sh "umask 077 && printf '%s\n' '# Daemon-only secrets, loaded by the robin-daemon systemd unit. Never export these in a shell.' '# CLAUDE_CODE_OAUTH_TOKEN_A=' '# CLAUDE_CODE_OAUTH_TOKEN_B=' > '$daemon_env'"
    run chmod 0600 "$daemon_env"
  fi

  # 10. Install the systemd user unit; its output includes the linger line.
  run_sh "cd '$ROBIN_HOME' && ROBIN_USER_DATA_DIR='$ROBIN_HOME/user-data' node dist/surfaces/cli/index.js daemon install"
else
  echo "No checkout at $ROBIN_HOME: clone it, then re-run to finish install, build, daemon.env and daemon install."
fi
