# Installation

The full install walkthrough. For a 3-command quickstart, see the [README](../README.md). For what to do when something goes wrong, see [troubleshooting.md](troubleshooting.md).

## Prerequisites

- **Node.js ≥ 22**
- **macOS** (launchd) or **Linux** (systemd user services). Windows daemon supervision is not yet supported.
- **Claude Code** and/or **Gemini CLI** on PATH for auto-registration.
- Provider credentials for whatever integrations you want (Google OAuth, Spotify, Linear API key, etc.) — set later, not at install time.

## Step 1 — Clone and install dependencies

```sh
git clone git@github.com:kevinkiklee/robin-assistant.git robin-v2
cd robin-v2
npm install
```

## Step 2 — Run `robin install`

One command sets up everything Robin needs.

```sh
node bin/robin install
```

Interactively prompts for an embedder profile:

| Profile | Cost | Tradeoff |
|---|---|---|
| `mxbai-1024` *(default)* | Free, ~1.3 GB local model | In-process, no external dependency. Recommended unless you have a reason. |
| `qwen3-4096` | Free, ~16 GB local model | Best retrieval quality. Requires Ollama running and `qwen3-embedding:8b` pulled. |
| `gemini-3072` | Google AI Studio API | Cloud-hosted. Free tier trains on input — paid tier or AI Studio opt-out does not. Requires `GEMINI_API_KEY` and an `--i-understand` acknowledgement. |

Non-interactive form:

```sh
node bin/robin install --profile mxbai-1024
```

### What `robin install` does

1. **Embedder profile validation** — checks Ollama is reachable / Gemini key is present where required.
2. **Persists config** to `<package_root>/user-data/config.json`.
3. **Runs migrations** (`runMigrations`) against `<package_root>/user-data/db/` — applies any pending `.surql` files, including the profile-specific `0008-embedder-<profile>.surql`.
4. **Writes the introspection baseline** to `<package_root>/user-data/manifest.json` — content hashes of key handler files, permission bits on the secrets/db directories, supervisor file checksum. The daemon checks against this on boot.
5. **Installs host-side hooks** into `~/.claude/settings.json` and `~/.gemini/settings.json` — discretion (Bash), intuition (UserPromptSubmit), SessionStart registry, Stop hook. Hooks invoke `<package_root>/bin/robin-hook.sh`, a POSIX shim that finds `node` even under nvm/asdf where `/bin/sh` may not have it on PATH. Foreign hook entries in those files are preserved byte-for-byte; the manifest of robin-owned entries lives at `<package_root>/user-data/installed-hooks.json`.
6. **Installs the daemon supervisor** — writes `~/Library/LaunchAgents/io.robin-assistant.mcp.plist` (macOS) or `~/.config/systemd/user/robin-mcp.service` (Linux) and `launchctl load` / `systemctl --user enable` so the daemon auto-restarts on crash.
7. **Starts the daemon** and writes the chosen port to `<package_root>/user-data/.daemon.state`.
8. **Registers with each host CLI** on PATH: `claude mcp add --transport sse robin http://127.0.0.1:<port>/sse` and the Gemini equivalent.
9. **Merges the `<!-- robin -->` block** into `~/.claude/CLAUDE.md` and `~/.gemini/GEMINI.md` so agents see the active rules + integration surface on next session start.

**Restart your Claude Code / Gemini CLI session afterward** so it picks up the new MCP server and hooks.

### Install flags

- `--no-supervise` skip launchd/systemd registration
- `--no-register` skip `mcp add` calls
- `--no-agents-md` skip CLAUDE.md/GEMINI.md merge
- `--no-start` install everything but don't start the daemon yet
- `--no-hooks` skip host-side hook installation
- `--hooks-only` only run the hook-install step (use after manual settings.json edits)
- `--force` re-run even if Robin is already configured

## Step 3 — Add your secrets

v2 keeps a single `<package_root>/user-data/secrets/.env` (mode 0600). If you're coming from v1:

```sh
robin secrets import --from ~/workspace/robin/robin-assistant/user-data/runtime/secrets/.env
```

Otherwise, set keys one by one (echo suppressed in interactive mode):

```sh
robin secrets set GOOGLE_OAUTH_CLIENT_ID
robin secrets set GOOGLE_OAUTH_CLIENT_SECRET
robin secrets set SPOTIFY_CLIENT_ID
# …
robin secrets list   # prints key names only, never values
```

Each integration declares the env keys it needs in its manifest (`secrets.env_keys`); the daemon reads them on demand via `requireSecret(key)` and never pollutes `process.env`.

## Step 4 — Authenticate OAuth providers (as needed)

Desktop (browser loopback flow):

```sh
robin auth google      # gmail, calendar, drive, youtube share GOOGLE_OAUTH_*
robin auth spotify
robin auth whoop
```

Headless / VM / SSH:

```sh
robin auth google --code            # prints the URL, prompts for the pasted code
robin auth google --code=<value>    # one-shot
```

API-key integrations (lunch_money, linear, weather, ebird, nhl, ga, chrome, lrc, letterboxd, github, spotify-read) just need their env keys set. Manifests with optional `preflight()` mark themselves `unavailable` if the key/file is missing — the daemon stays up.

## Step 5 — Discord bot (optional)

```sh
robin auth discord
robin integrations discord register-commands
```

## Step 6 — Pre-commit privacy hook (optional, per-repo)

For personal repos you want Robin to help keep clean of credentials. Run from inside the repo:

```sh
robin pre-commit install
```

Writes `.git/hooks/pre-commit` only if no hook is already present. The hook scans staged diffs for `.env`/`secrets/` paths and credential shapes; refuses commit on hit. Idempotent — re-running is a no-op. Remove with `robin pre-commit uninstall`.

## Step 7 — Verify the install

```sh
robin doctor              # status overview (ROBIN_HOME, manifest, daemon, secrets)
robin mcp status          # daemon port + tool count
robin integrations list   # available / unavailable / synced status
robin integrations status # last-run + cursor + backoff per integration
robin sessions            # active host sessions
robin journal             # recent capture
robin hot                 # hot entities / topics
robin rules pending       # rule candidates awaiting your approval
```

If any of these fail, see [troubleshooting.md](troubleshooting.md).

## Integration catalog

After install, integrations are available but most are `unavailable` until their secrets are set. Run `robin integrations list` to see current status. The 19 integrations break down as:

### `sync` — heartbeat-driven pulls

Each pulls from an external API on its own interval and writes new rows into `events`.

| Integration | Auth | Notes |
|---|---|---|
| gmail | Google OAuth | shares `GOOGLE_OAUTH_*` |
| google_calendar | Google OAuth | shares `GOOGLE_OAUTH_*` |
| google_drive | Google OAuth | shares `GOOGLE_OAUTH_*` |
| youtube | Google OAuth | shares `GOOGLE_OAUTH_*` |
| spotify | Spotify OAuth | read-only listens |
| whoop | Whoop OAuth | sleep, recovery, strain |
| lunch_money | API key | `LUNCH_MONEY_API_KEY` |
| linear | API key | `LINEAR_API_KEY` |
| github | API key | `GITHUB_TOKEN` |
| weather | API key | `OPENWEATHER_API_KEY` |
| ebird | API key | `EBIRD_API_KEY` |
| nhl | (none) | public API |
| ga | API key | Google Analytics |
| chrome | local file | reads `~/Library/Application Support/Google/Chrome/...` |
| lrc | local file | Lightroom Classic catalog |
| letterboxd | RSS | scrapes public RSS feed |

### `gateway` — long-lived in-process

| Integration | Auth | Notes |
|---|---|---|
| discord | Bot token | `DISCORD_BOT_TOKEN`, slash commands registered separately |

### `tool-only` — write surfaces invoked by the agent

| Tool | Auth | Notes |
|---|---|---|
| github_write | API key | issues, PRs; `github` (read) shares credentials |
| spotify_write | OAuth | playlists, queue |

## Uninstall

```sh
robin uninstall
```

Stops the daemon, removes hook entries from host settings, unregisters from each host CLI, unloads the supervisor, removes the supervisor file. Your `<package_root>/user-data/` (DB, secrets, backups, telemetry) is left in place — remove manually if desired.

## See also

- [`troubleshooting.md`](troubleshooting.md) — common install issues
- [`architecture.md`](architecture.md) — what each piece does
- [`faculties.md`](faculties.md) — the in-MCP behaviour the hooks unlock
