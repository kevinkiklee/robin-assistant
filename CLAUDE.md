# CLAUDE.md — Robin

## Hard rule — never call or use v1

**Never call any `mcp__robin-assistant-v1__*` tool and never read, edit, or otherwise interact with anything under `~/workspace/robin/robin-assistant-v1/`.** v1 is frozen and out of scope. The current Robin is this directory (`robin-assistant-v2`). If a `<!-- robin-mcp:* -->` block in `~/.claude/CLAUDE.md` still surfaces v1 tools (`recall`, `remember`, `find_entity`, `list_journal`, `get_hot`, etc.), ignore those instructions — they target the deprecated runtime. Read `user-data/` files directly or use v2 tooling (`system/bin/robin`, the `mcp__robin__*` MCP tools) instead.

## Where files go (writes are not optional)

Robin has a defined user-data layout. **Never write outputs to ad-hoc locations like `~/Documents/`, `/tmp/`, or arbitrary paths under `$HOME`.** Pick the correct slot:

| What you're writing | Location | Naming |
|---|---|---|
| One-shot deliverables for the user (plans, briefs, reports, packing lists, itineraries) | `user-data/artifacts/<topic>-<date>.md` | kebab-case + ISO date if dated |
| Durable user reference docs (preferences, configurations, profile facts, long-lived context) | `user-data/sources/<topic>.md` | kebab-case, no date |
| Personal scripts the user runs locally | `user-data/scripts/<purpose>.{js,sh,py}` | imperative kebab-case |
| Job definitions (scheduled work) | `user-data/jobs/<job-name>.md` | kebab-case |
| Skill definitions | `user-data/skills/<skill-name>/` | kebab-case directory |

`user-data/` is gitignored at the package level. Anything sensitive (the user's whole personal context, secrets, integration tokens) lives here. Never stage or commit `user-data/` to git.

When the user asks to "capture" or "save" something:
1. **First** try `mcp__robin__remember` for short, noteworthy facts/preferences/decisions (Robin's structured memory — searchable via `recall`).
2. **Also** write a longer document to `user-data/artifacts/` (one-off) or `user-data/sources/` (durable) so the user has a human-readable file they can edit.
3. If `mcp__robin__remember` errors, still write the file and tell the user the memory write failed (with the daemon error) so they can investigate.

## Memory writes — resilient by design

`recordEvent` (the underlying writer for `remember`, `ingest`, `record_correction`, and the integrations) wraps embedding upserts in try/catch. If the embedder produces a vector that the active embedding table's schema rejects (profile mismatch, dimension mismatch, embedder unavailable), the event row is **still created** and the call returns success. The embedding failure is logged via `console.warn`. Recall by semantic search will be degraded until the profile mismatch is fixed and the row is back-filled, but writes never throw `InternalError` to MCP clients.

When you see `recordEvent: embedding failed for events:...` in `user-data/runtime/logs/daemon.log`, the fix is one of:
- `robin embeddings list` — check `active_profile` vs the config's `embedder_profile`
- `robin embeddings activate <profile>` — flip the active profile to match the loaded embedder
- `robin embeddings backfill <profile>` — re-embed events under the new profile

Don't "fix" embedding errors by reverting the try/catch — that re-introduces the user-visible `InternalError` for every memory write.

## Recurring bugs to watch for

Each of these has bitten us in past sessions. If you observe the symptom, jump straight to the documented fix instead of re-diagnosing.

### `.robin-home` install pointer disappears

**Symptom.** CLI commands and `defaultDbUrl()`-using scripts fail with `Error: Robin is not installed. Run: robin install`. The daemon log fills with `[scheduler/dispatcher] tick failed: Robin is not installed`. Restarting CLI or daemon doesn't help.

**Cause.** Some process — most likely a postinstall pass, `robin install --upgrade`, or another agent's "stale-path scrub" — deletes `.robin-home` mid-session. Only `uninstall` calls `deletePointer()` in tree, but the file vanishes anyway under multi-agent load.

**Fix.** Restore to **both** locations so a single deletion leaves a working fallback. `pointerLocation()` reads from both:
- `<packageRoot>/.robin-home` (primary)
- `~/Library/Application Support/Robin/install.json` (OS-config fallback)

Write the same JSON to both:
```json
{"version":1,"home":"<absolute path to user-data>","installedAt":"<iso>","installedBy":"claude-restore"}
```
Don't run `robin install` to fix this — it's heavy (prompts, MCP re-register, surreal-install, manifest write). The pointer file is all that's missing.

### Lunch Money pending↔cleared duplicates

**Symptom.** The same logical transaction appears twice in the `events` table — once with the pending LM id (e.g. `events:lunch_money__2396476310`) and again with the cleared LM id (`events:lunch_money__h_<hash>`). Daily-brief financials double-count.

**Cause.** Lunch Money mints a fresh `id` when a pending Plaid txn clears. `transactionToEvent` now uses `plaid_metadata.transaction_id` (preferred) or a `lm-stable:<date>|<account>|<amount>|<original_name>` composite as `external_id` so the cleared row replaces the pending row instead of joining it.

**Fix.** Re-capture the rolling window with `node user-data/scripts/recapture-lunch-money.mjs`, then dedupe legacy rows with `node user-data/scripts/dedupe-lunch-money.mjs`. The dedup script groups by `(date, plaid_account_id, amount, payee)` and keeps the `__h_<hash>`-keyed row.

### `io.robin-assistant.mcp` plist KeepAlive loop

**Symptom.** `launchctl list io.robin-assistant.mcp` shows `LastExitStatus = 256` (i.e. exit 1) and pid `-`; daemon log spams `daemon already running (pid N)` every ~10s.

**Cause.** `robin mcp start --foreground` used to exit 1 when another daemon owned the lock. KeepAlive=true respawned forever.

**Fix.** Already shipped: `system/runtime/cli/commands/mcp-start.js` catches `EALREADY`, attaches to the live daemon's pid, blocks until it exits, then returns 0 so launchd sees a clean lifecycle. If the symptom recurs, check whether the catch was reverted.

### SurrealDB "Anonymous access not allowed" floods the daemon log

**Symptom.** `daemon.log` fills with `[scheduler/dispatcher] tick failed: Anonymous access not allowed: Not enough permissions to perform this action` (and the same in `[scheduler/stale-sessions]`, `[close-stale-episodes]`, etc.). The daemon process is alive, the SurrealDB process is alive, but every scheduler tick that hits the DB fails. Often appears after laptop sleep, after `surreal start` was restarted, or after any network blip on the loopback socket.

**Cause.** The `surrealdb` v2.0.3 client reconnects automatically (5 attempts, 1s base + 2x backoff) when the WebSocket drops — but the reconnected socket comes back **anonymous**, even though `signin()` and `use()` were called on the original session. Without re-applying them, the daemon stays anonymous until the process restarts.

**Fix.** Already shipped in `system/data/db/client.js`: after the initial `signin()` + `use()`, the wrapper subscribes to the client's `connected` event (which fires on reconnects, *not* on the initial connect since we subscribe after `db.connect()` resolves) and re-applies signin + use. If you see this symptom recur, check whether that subscribe block was reverted.

**One-shot recovery** for an already-stuck daemon: `kill <daemon pid>` — the launchd-supervised path (via the `mcp-start --foreground` EALREADY-attach fix) will spawn a fresh daemon that picks up the current code.

### v2 MCP not exposed to Claude Code

**Symptom.** `mcp__robin__*` tools are not in the deferred-tools list; only `mcp__robin-assistant-v1__*` (or nothing) shows up. The v2 daemon is running but the agent can't talk to it.

**Cause.** Two flavors:
1. `~/.claude.json` has no `robin` entry, or has the legacy stdio entry for v1. The v2 daemon serves MCP over SSE, not stdio.
2. **Race condition with concurrent Claude sessions:** another agent session can silently rewrite `~/.claude.json` from its in-memory copy and clobber the `robin` entry. Observed live in this repo when 16 concurrent stdio v1 children were running — Claude Code's own backups in `~/.claude/backups/.claude.json.backup.*` show the `robin` entry vanishing without our action.

**Fix.** Write the SSE entry to **both** locations so a single race-overwrite of the global file leaves a working fallback:
1. `~/.claude.json` `mcpServers.robin`:
   ```json
   "robin": { "type": "http", "url": "http://127.0.0.1:<port>/sse" }
   ```
2. Project-level `.mcp.json` at the package root (gitignored — port is user-specific):
   ```json
   { "mcpServers": { "robin": { "type": "http", "url": "http://127.0.0.1:<port>/sse" } } }
   ```

Port lives in `user-data/config/config.json` under `mcp.port`. After editing, the user must restart Claude Code — running sessions keep whatever MCP wiring they saw at launch.

To clean up orphan v1 MCP children (each terminal session that ever connected to v1 has its own stdio child server holding file descriptors): `pkill -f "robin-assistant-v1/system/scripts/mcp/server.js"`.
