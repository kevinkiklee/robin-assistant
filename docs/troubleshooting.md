# Troubleshooting

Common problems and how to diagnose them. The first step in every case is `robin doctor` — it prints a one-fact-per-line health overview.

## The daemon

### `robin doctor` says the daemon is not running

```sh
robin mcp status   # confirm port + pid
robin mcp start    # foreground start (Ctrl-C to stop)
```

If `mcp start` exits immediately:

- **Port in use:** another process is on the same port. `robin mcp status` prints the recorded port. `lsof -i :<port>` to find the squatter.
- **Lock not released:** `<package_root>/user-data/.daemon.lock` is held. If no daemon PID is alive, delete it: `rm <package_root>/user-data/.daemon.lock`.
- **Stale state:** `<package_root>/user-data/.daemon.state` lists a dead PID. `robin doctor` detects this. Delete: `rm <package_root>/user-data/.daemon.state`.

### Daemon crashes immediately after start

Most common cause is profile drift between `config.json` and the DB:

```
[daemon] config drift detected:
  config.json says: gemini-3072
  runtime:embedder says: mxbai-1024
```

Fix one of two ways:

```sh
robin embedder switch <profile-in-config-json>   # migrate schema to match config
# OR edit user-data/config.json back to the runtime profile
```

### Daemon's supervisor (launchctl / systemctl) isn't auto-restarting

```sh
# macOS
launchctl list io.robin-assistant.mcp
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/io.robin-assistant.mcp.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.robin-assistant.mcp.plist

# Linux
systemctl --user status robin-mcp
systemctl --user restart robin-mcp
```

## Hooks not firing

`robin doctor --lint-hooks` lists the robin-owned hook entries in `~/.claude/settings.json` and `~/.gemini/settings.json`. If empty, hooks were never installed or got removed:

```sh
robin install --hooks-only
```

After re-installing hooks, **restart the host session** — Claude Code and Gemini CLI only re-read `settings.json` on launch.

### `intuition` (memory injection) not appearing in turns

- Verify the daemon is running: `robin mcp status`.
- Verify the hook is wired: `robin doctor --lint-hooks` should list a `UserPromptSubmit → intuition` entry.
- Verify the hook isn't disabled: `cat <package_root>/user-data/hooks-disabled.txt`. Re-enable with `robin hooks enable intuition`.
- Telemetry: `SELECT * FROM runtime_intuition_telemetry ORDER BY ts DESC LIMIT 10` — confirms recent fires, hits, latency.
- v1 cutover suppression: if you have v1 hooks (`$CLAUDE_PROJECT_DIR/system/scripts/hooks/host-hook.js`) still installed, v2 intuition yields. The hook prints a one-line stderr notice when this happens.

### `discretion` (bash refusal) blocking commands you want to run

Two options:

1. Disable the hook entirely: `robin hooks disable discretion` (also affects the agent — be aware).
2. Run the command outside the agent's Bash tool (paste into your terminal directly).

To see *why* a command was refused, look at the stderr line Robin prints: `Robin: blocked Bash — <rule-name>: <why>`. The 7 rules are in `src/hooks/bash-patterns.js`.

### `discretion` (memory write) refusing content that doesn't actually contain PII

Force the write from the CLI:

```sh
robin remember --force "the content..."
```

Agents have no override path — they must escalate. Check the audit:

```sh
robin refusals list
```

If the pattern is wrong, file an issue. Patterns live in `src/hooks/pii-patterns.js` and `src/outbound/patterns.js`.

## Memory

### `robin journal` is empty after a session

Possible causes:

- Biographer never ran. Check `<package_root>/user-data/cache/logs/biographer.log` for the most recent invocation. Manually run `robin biographer-catchup` to drain pending events.
- The Stop hook didn't fire. Verify with `robin doctor --lint-hooks` — should list a `Stop → stop` entry.
- The conversation-capture pipeline skipped the turn. Skip log lines are in `biographer.log` with a `skip_reason` field: `no_transcript_path`, `no_assistant_turn`, `single_word_ack`, `pure_tool_turn`, `empty_turn`, `dedup_hit`, `pii_refused`.

### Recall returns nothing relevant

- Verify there are events to recall: `SELECT count() FROM events GROUP ALL`.
- Verify embeddings exist: `SELECT count(IF embedding IS NOT NONE THEN 1 END) AS embedded, count() AS total FROM events GROUP ALL`.
- Verify your embedder profile matches what's in the DB: `robin doctor` prints both.
- For a one-off ad-hoc query: `node scripts/dev-recall.js "your query"`.

### Biographer keeps failing on the same event

Check `runtime:biographer.failed_event_ids` — events that hit terminal failure (malformed JSON, exhausted retries). Retry once:

```sh
robin biographer-catchup --retry-failed
```

If it fails again, inspect the event's content for an unusual shape (very long, malformed unicode, JSON markers that confuse the LLM's output parser).

### Dream didn't run last night

- Check the scheduler: `SELECT * FROM type::record('runtime', 'dream')`. `last_run_at` and `last_run_at_success` should match within a 4 AM window.
- Manually run: `robin dream run` (synchronous, prints summary).
- Time zone: scheduler reads `process.env.TZ`. If your daemon was started under a different TZ, 4 AM is in that TZ.

### Rule candidates aren't appearing

Reflection requires ≥ 3 correction events clustering (cosine ≥ 0.85, within 30 days). To inspect:

```surql
SELECT count() AS n FROM events WHERE meta.kind = 'correction' AND ts >= time::now() - 30d;
```

If `n < 3`, you simply don't have enough correction signal yet. Use `record_correction` (via the MCP tool or `robin remember`-with-correction-meta) to accumulate.

## Introspection warnings

Boot output like:

```
[daemon] introspection warning — hash_drift: bin/robin
[daemon] introspection warning — mode_drift: secrets_env_mode
```

means the live filesystem diverged from the manifest baseline. Two cases:

- **Intentional change** (you upgraded the package, edited code on a dev clone, rotated `.env` permissions): rebaseline.
  ```sh
  robin doctor --rebaseline
  ```
- **Unintentional change** (you don't know why a tracked file changed): investigate before rebaseling. The finding includes `expected` and `actual` sha256s; `git status` and `git diff` against the tracked file will usually explain.

The `no_baseline` finding (`baselined=false`) means `<robinHome>/manifest.json` is missing — run `robin install` to write one. The daemon still runs without it.

## Integrations

### `robin integrations list` shows an integration as `unavailable`

Each integration's manifest declares the env keys it needs. Missing keys → `unavailable`. The daemon stays up; only that integration is dormant. Check what it wants:

```sh
robin secrets list                 # what's set
cat src/integrations/<name>/manifest.json   # what's needed
```

Set the missing key:

```sh
robin secrets set <KEY_NAME>
```

### An integration's `next_run_at` keeps slipping into the future

Backoff is active — the integration is failing repeatedly. Check `consecutive_failures`:

```surql
SELECT name, consecutive_failures, last_error, next_run_at
FROM type::record('runtime', 'integrations')
```

The error message lives in `last_error`. Fix and reset:

```sh
robin integrations run <name>    # one manual run (clears backoff on success)
```

### OAuth tokens expired

```sh
robin auth <google|spotify|whoop>     # re-runs the loopback flow
```

For headless boxes, use `--code`:

```sh
robin auth google --code
```

## Schema migrations

### `robin migrate` claims pending migrations but the DB looks current

The `_migrations` table tracks applied versions. Re-check:

```surql
SELECT version, name, applied_at FROM _migrations ORDER BY version;
```

If a migration was applied manually (via `surreal sql`) without recording, the runner will re-apply. Either delete the manual changes and re-run, or insert the matching `_migrations` row manually.

### Migration runner crashes with "Transaction conflict"

SurrealDB embedded engine surfaces this when two processes touch the same record. The migration runner is single-process (cooperative lock); this usually means the daemon is still running. Stop it:

```sh
robin mcp stop
robin migrate
```

## When in doubt

```sh
robin doctor                         # status overview
robin doctor --lint-hooks            # hook entries by host
robin doctor --purge-stale-sessions  # clean runtime_sessions
robin doctor --rebaseline            # rewrite introspection manifest
robin sessions --stale               # active vs stale sessions
robin refusals list                  # recent in/outbound refusal audit
```

If a faculty is misbehaving and the audit doesn't explain it, the per-faculty deep dive in [`faculties.md`](faculties.md) lists the relevant files, tables, and disable knobs.
