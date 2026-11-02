# Running Robin on a cloud VM

Provider-neutral runbook for the Linux host: the daemon runs as a systemd user
service under a dedicated `robin` user. Names below (`robin`, `/home/robin`,
`example-vm`) are placeholders.

## 1. VM

- Debian 12 or Ubuntu 24.04.
- 4-8 GB RAM, about 80 GB disk.
- Outbound network only. Robin opens no listening ports.

## 2. User and checkout

```bash
# as root (or via the provider's console), once
adduser robin
usermod -aG sudo robin

# then as robin
ssh robin@example-vm
git clone <repo-url> ~/robin-assistant-v3
```

## 3. Bootstrap

```bash
cd ~/robin-assistant-v3
bash system/scripts/vm/bootstrap.sh --dry-run   # review every action
bash system/scripts/vm/bootstrap.sh
```

The script is idempotent, so re-running it is safe. It installs system
packages (bubblewrap, git, build tools, sqlite3, rsync), Node 24 and pnpm
10.33.0 (via corepack), sets the host timezone (`ROBIN_TZ`, else operator.yaml `timezone:`), enables
linger, installs the Claude Code CLI and `cloudflared`, runs
`pnpm install --frozen-lockfile && pnpm build`, creates `daemon.env`, and runs
the systemd unit install (`daemon install`, pointed at the checkout's `user-data/`). `ROBIN_HOME` overrides the checkout path.

If linger was off, the install prints
`Linger is off — the daemon stops at logout. Run: sudo loginctl enable-linger $USER`.
The bootstrap already enables it; log out and back in if you see the line.

## 4. Secrets

Tokens go in `~/robin-assistant-v3/user-data/config/secrets/daemon.env`
(mode `0600`), and nowhere else. It is daemon-only in one sense: it is never
exported in a shell. Fill in by hand:

```
CLAUDE_TOKEN_ROBIN=...        # account 2 (Robin's default), from claude setup-token
CLAUDE_TOKEN_SHARED=...       # account 1 (your interactive account; borrowed when Robin's is limited)
CLAUDE_CREDIT_KEY_ROBIN=...   # API key, Console org linked to account 2 (no auto-reload)
CLAUDE_CREDIT_KEY_SHARED=...  # API key, Console org linked to account 1 (no auto-reload)
```

Fill these, then `systemctl --user restart robin-daemon`. The daemon gets the
file through its systemd unit (`EnvironmentFile=`); every `robin` CLI command and
MCP server reads it itself at startup, so nothing needs exporting. `robin
accounts` shows each credential's limits, expiry and last use; `robin doctor`
warns 30 days before a token lapses.

Never put them in `~/.bashrc` or any shell profile. `CLAUDE_CODE_OAUTH_TOKEN`
outranks a normal `/login`, so a shell-wide export would silently put your own
interactive `claude` sessions on Robin's account.

After editing: `systemctl --user restart robin-daemon`.

## 5. Check the daemon

```bash
systemctl --user status robin-daemon
systemctl --user is-active robin-daemon
journalctl --user -u robin-daemon -f
pnpm robin doctor   # run from the checkout; `robin` is not on PATH
```

## Expected warning

On Linux, `pnpm robin doctor` warns `agent.auto_land_sandbox` (auto-land is enabled
without an OS sandbox). That is expected until a later milestone. To silence it,
set `agent.auto_land: false`.

## Tests on Linux

`pnpm test:linux` runs the build, typecheck and suite in a Docker container
from a clean copy of the repo.
