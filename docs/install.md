# Installation

The full install walkthrough. For the one-liner, see the [README](../README.md). For what to do when something goes wrong, see [troubleshooting.md](troubleshooting.md).

## Prerequisites

- **Node.js ≥ 22**
- **macOS** (launchd) or **Linux** (systemd user services). Windows daemon supervision is not yet supported.
- **Claude Code** and/or **Gemini CLI** on PATH for auto-registration.
- Provider credentials for whatever integrations you want (Google OAuth, Spotify, Linear API key, etc.) — set later, not at install time.

## The fast path

```sh
git clone git@github.com:kevinkiklee/robin-assistant.git
cd robin-assistant
npm install
```

`npm install` triggers a postinstall script that runs `robin install --auto` with safe defaults: home at `<repo>/user-data/`, `mxbai-1024` embedder, all hooks and daemon supervisor wired up, MCP registered with any Claude Code / Gemini CLI on PATH. No prompts.

Restart your CLI host afterward so it loads the new MCP server. Verify with `robin doctor`.

### When the postinstall skips itself

The postinstall is conservative — it sits out anywhere auto-setup would be a surprise:

| Condition | What happens |
|---|---|
| `ROBIN_SKIP_INSTALL=1 npm install` | Skipped silently. Run `node system/bin/robin install` yourself. |
| `CI=true` (any CI env) | Skipped silently. |
| `npm install -g robin-assistant` | Skipped with a hint. Run `robin install` once after global install. |
| Installed as a transitive dep | Skipped silently. |
| Windows | Skipped with a hint. Run `node system/bin/robin install` manually. |

### Per-step skips

Set any of these before `npm install` to skip a single step:

| Env var | Equivalent flag |
|---|---|
| `ROBIN_SKIP_MCP` | `--no-mcp` |
| `ROBIN_SKIP_DAEMON` | `--no-start` |
| `ROBIN_SKIP_HOOKS` | `--no-hooks` |
| `ROBIN_SKIP_AGENTS_MD` | `--no-agents-md` |
| `ROBIN_SKIP_SUPERVISE` | `--no-supervise` |
| `ROBIN_SKIP_REGISTER` | `--no-register` |
| `ROBIN_SKIP_SURREAL` | `--no-surreal` |

`--no-surreal` skips installing + starting the standalone SurrealDB server
and leaves `db.url` out of `config.json`, so the daemon falls back to the
embedded NAPI engine. Only safe when you run **one** Robin process at a
time — the embedded engine is single-writer and concurrent processes
(daemon + biographer + CLI) will hang on its lockfile.

`ROBIN_HOME=<path> npm install` overrides the home directory without any other ceremony.

### First-run safety net

If postinstall was skipped (global install, CI re-run, `--ignore-scripts`) and you run any non-install `robin` command later, the CLI detects the missing setup, runs `robin install --auto` once, and continues with your original command. Set `ROBIN_SKIP_FIRST_RUN=1` to disable.

## The interactive path

If you want to pick a different embedder profile or store data outside the repo:

```sh
ROBIN_SKIP_INSTALL=1 npm install
node system/bin/robin install
```

One command sets up everything Robin needs.

```sh
node system/bin/robin install
```

Interactively prompts for an embedder profile:

| Profile | Cost | Tradeoff |
|---|---|---|
| `mxbai-1024` *(default)* | Free, ~1.3 GB local model | In-process, no external dependency. Recommended unless you have a reason. |
| `qwen3-4096` | Free, ~16 GB local model | Best retrieval quality. Requires Ollama running and `qwen3-embedding:8b` pulled. |
| `gemini-3072` | Google AI Studio API | Cloud-hosted. Free tier trains on input — paid tier or AI Studio opt-out does not. Requires `GEMINI_API_KEY` and an `--i-understand` acknowledgement. |

Non-interactive form:

```sh
node system/bin/robin install --profile mxbai-1024
```

### Home directory

`robin install` prompts for where to store your data (the "robin home"). The picker offers four options:

1. `<package_root>/user-data/` — keeps data alongside the package install (default v2 layout)
2. `~/.robin/` — home directory, hidden
3. `~/Documents/Robin/` — home directory, visible
4. Custom path

The chosen location is written to `<package_root>/.robin-home` (a pointer file) and exported as `ROBIN_HOME` in the supervisor unit. Throughout the rest of these docs, `<robinHome>` refers to whichever path you picked. The picker also scans known locations on reinstall and offers to migrate existing data with a copy-verify-delete sequence.

### What `robin install` does

1. **Embedder profile validation** — checks Ollama is reachable / Gemini key is present where required.
2. **Resolves the robin home** via the picker described above and writes the `.robin-home` pointer + `<robinHome>/runtime/install/.marker.json` marker.
3. **Persists config** to `<robinHome>/config.json`.
4. **Runs migrations** (`runMigrations`) against `<robinHome>/data/db/` — applies any pending `.surql` files, including the profile-specific `0008-embedder-<profile>.surql`.
5. **Writes the introspection baseline** to `<robinHome>/runtime/install/manifest.json` — content hashes of key handler files, permission bits on the secrets/db directories, supervisor file checksum. The daemon checks against this on boot.
6. **Installs host-side hooks** into `~/.claude/settings.json` and `~/.gemini/settings.json` — discretion (Bash), intuition (UserPromptSubmit), SessionStart registry, Stop hook. Hooks invoke `<package_root>/system/bin/robin-hook.sh`, a POSIX shim that finds `node` even under nvm/asdf where `/bin/sh` may not have it on PATH. Foreign hook entries in those files are preserved byte-for-byte; the manifest of robin-owned touchpoints (hook entries, plists, supervisor units) lives at `<robinHome>/runtime/install/host-integrations.json`.
7. **Installs the daemon supervisor** — writes `~/Library/LaunchAgents/io.robin-assistant.mcp.plist` (macOS) or `~/.config/systemd/user/robin-mcp.service` (Linux) with `ROBIN_HOME` baked in, and `launchctl load` / `systemctl --user enable` so the daemon auto-restarts on crash.
8. **Starts the daemon** and writes the chosen port to `<robinHome>/runtime/daemon/.state`.
9. **Registers with each host CLI** on PATH: `claude mcp add --transport sse robin http://127.0.0.1:<port>/sse` and the Gemini equivalent.
10. **Merges the `<!-- robin -->` block** into `~/.claude/CLAUDE.md` and `~/.gemini/GEMINI.md` so agents see the active rules + integration surface on next session start.

**Restart your Claude Code / Gemini CLI session afterward** so it picks up the new MCP server and hooks.

### Install flags

- `--auto` zero-prompt preset: implies `--yes --profile mxbai-1024 --on-existing ignore`. Explicit flags layer on top (e.g. `--auto --profile gemini-3072 --i-understand`).
- `--yes` skip the home picker; accept default `<package-root>/user-data/`.
- `--profile <id>` `mxbai-1024` | `qwen3-4096` | `gemini-3072`. Required in non-interactive mode unless `--auto` is set.
- `--home <path>` explicit home directory; bypasses the picker.
- `--on-existing <move|copy|ignore|abort>` what to do if pre-existing Robin data is discovered (non-interactive default: `abort`).
- `--no-supervise` skip launchd/systemd registration
- `--no-register` skip `mcp add` calls
- `--no-agents-md` skip CLAUDE.md/GEMINI.md merge
- `--no-start` install everything but don't start the daemon yet
- `--no-mcp` skip everything in the MCP-install bundle (supervise + register + start + agents-md)
- `--no-migrate` skip running DB migrations
- `--no-hooks` skip host-side hook installation
- `--no-surreal` skip the standalone SurrealDB server install (falls back to embedded NAPI engine; only safe single-process — see `docs/troubleshooting.md`)
- `--hooks-only` only run the hook-install step (use after manual settings.json edits)
- `--force` re-run even if Robin is already configured

## Step 3 — Add your secrets

v2 keeps a single `<robinHome>/config/secrets/.env` (mode 0600). If you're coming from v1:

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

Stops the daemon, removes hook entries from host settings, unregisters from each host CLI, unloads the supervisor, removes the supervisor file (best-effort by default; `--strict` aborts on first failure). Your `<robinHome>` (DB, secrets, snapshots, telemetry) is left in place — pass `--purge` to remove it, or delete the directory manually.

## See also

- [`troubleshooting.md`](troubleshooting.md) — common install issues
- [`architecture.md`](architecture.md) — what each piece does
- [`faculties.md`](faculties.md) — the in-MCP behaviour the hooks unlock
