# CLAUDE.md — Robin

## Hard rule — never call or use v1

**Never call any `mcp__robin-assistant-v1__*` tool and never read, edit, or otherwise interact with anything under `~/workspace/robin/robin-assistant-v1/`.** v1 is frozen and out of scope. The current Robin is this directory (`robin-assistant-v2`). If a `<!-- robin-mcp:* -->` block in `~/.claude/CLAUDE.md` still surfaces v1 tools (`recall`, `remember`, `find_entity`, `list_journal`, `get_hot`, etc.), ignore those instructions — they target the deprecated runtime. Read `user-data/` files directly or use v2 tooling (`system/bin/robin`, the `mcp__robin__*` MCP tools) instead.

## Where files go (writes are not optional)

Robin has a defined user-data layout. **Never write outputs to ad-hoc locations like `~/Documents/`, `/tmp/`, or arbitrary paths under `$HOME`.** Pick the correct slot:

| What you're writing | Location | Naming |
|---|---|---|
| One-shot deliverables the user explicitly asked for (plans, briefs, reports, packing lists, itineraries) | `user-data/artifacts/<topic>-<date>.md` | kebab-case + ISO date if dated |
| Personal scripts the user runs locally | `user-data/scripts/<purpose>.{js,sh,py}` | imperative kebab-case |
| Job definitions (scheduled work) | `user-data/jobs/<job-name>.md` | kebab-case |
| Skill definitions | `user-data/skills/<skill-name>/` | kebab-case directory |

`user-data/` is gitignored at the package level. Anything sensitive (the user's whole personal context, secrets, integration tokens) lives here. Never stage or commit `user-data/` to git.

When the user asks to "capture", "save", or "remember" something:
1. **Default: DB only.** Call `mcp__robin__remember` and stop. The biographer auto-extracts entities (people, things, places, topics) and edges, so structured data — meds, prefs, decisions, facts — is queryable via `recall` and `find_entity` without a parallel markdown file.
2. **Only write a markdown artifact when**:
   - The user explicitly asked for an artifact ("give me a packing list", "write up a plan"), OR
   - You proposed an artifact and the user agreed.
   In both cases, write to `user-data/artifacts/`.
3. **Never write to `user-data/sources/`** for new captures. If the data feels durable enough that you're tempted to use `sources/`, that's the signal to put it in the DB instead. `sources/` is reserved for pre-existing binary attachments (PDFs, CSVs, large reference files).
4. If `mcp__robin__remember` errors, surface the daemon error to the user so they can investigate — don't silently fall back to a file.

## Memory writes — resilient by design

`recordEvent` (the underlying writer for `remember`, `ingest`, `record_correction`, and the integrations) wraps embedding upserts in try/catch. If the embedder produces a vector that the active embedding table's schema rejects (profile mismatch, dimension mismatch, embedder unavailable), the event row is **still created** and the call returns success. The embedding failure is logged via `console.warn`. Recall by semantic search will be degraded until the profile mismatch is fixed and the row is back-filled, but writes never throw `InternalError` to MCP clients.

When you see `recordEvent: embedding failed for events:...` in `user-data/runtime/logs/daemon.log`, the fix is one of:
- `robin embeddings list` — check `active_profile` vs the config's `embedder_profile`
- `robin embeddings activate <profile>` — flip the active profile to match the loaded embedder
- `robin embeddings backfill <profile>` — re-embed events under the new profile

Don't "fix" embedding errors by reverting the try/catch — that re-introduces the user-visible `InternalError` for every memory write.

## Test scripts and writing performant tests

Test scripts in `package.json` (all use `--test-force-exit --test-timeout=20000 --test-concurrency=18`):

| Script | What it runs | When to use |
|---|---|---|
| `pnpm test` | Everything (`system/tests/**/*.test.js`) | Pre-commit / CI |
| `pnpm test:unit` | Just `system/tests/unit/**` | Validating logic changes |
| `pnpm test:integration` | Just `system/tests/integration/**` | Validating CLI / daemon flows |
| `pnpm test:fast` | Unit suite with `ROBIN_SKIP_SLOW=1` (skips embedder + install tests) | Inner-loop iteration; ~5s |
| `pnpm test:watch` | Unit suite in watch mode | TDD on a single file |
| `pnpm test:file <path>` | One or more named files | Focused single-file run |

`test:fast` is the right default for inner-loop work — it skips the ~6 tests that load the mxbai-1024 embedder or run the full install flow (each ~1s) and finishes in ~5s instead of ~6.5s.

**Rules for writing tests that stay fast**:

- **Never `setTimeout` without `.unref()`** unless you also `clearTimeout` on every code path. A 5-second pending timer in a test that asserts within 100ms is a 4.9-second handle leak. Without `--test-force-exit` the test runner waits for it; with `--test-force-exit` it just makes shutdown noisier.
- **Prefer `mock.timers`** over real `setTimeout(r, 200)` when the unit under test owns the timer. `system/tests/integration/whoop-quiet-window.test.js` shows the pattern (`mock.timers.enable({ apis: ['Date'], now: ... })`). Real `await sleep(N)` is only acceptable when the code under test schedules a timer through APIs you don't control.
- **Skip slow tests behind `ROBIN_SKIP_SLOW`** when they cost >300ms and exist to verify real model loading, real install flows, or real subprocess spawning. The pattern is `test('...', { skip: process.env.ROBIN_SKIP_SLOW === '1' }, async () => {...})`. The CI/full `pnpm test` still runs them.
- **Don't spawn the CLI as a subprocess from a unit test.** Each `node`/`robin` subprocess on macOS costs ~150ms. If you're spawning to test logic, refactor the logic out and call the function directly. Subprocess tests belong in `system/tests/integration/`.
- **Use `mem://` for SurrealDB unit tests.** It's the only embedded engine fast enough for per-test setup; `rocksdb://` and `surrealkv://` write to disk and are an order of magnitude slower. Always pair every `connect({engine:'mem://'})` with `await close(db)` at the end of the test — the NAPI engine leaks threadsafe handles without it (see the `--test-force-exit` note below).
- **Avoid `beforeEach` setup that allocates a real DB or model** when test bodies can share fixtures. Each fresh `mem://` connection costs ~30ms; multiplied across hundreds of tests this dominates wall time. Prefer a single `before` hook + per-test transactions or unique IDs.
- **Don't leak `setInterval` past `stop()`**. Tests calling `sched.start()` must call `sched.stop()` (or assert via mock timers). `setInterval` handles without `.unref()` keep the process alive.
- **Cap polling loops at the tightest interval that's not flaky** — 50ms is plenty in this repo; 100ms is the upper bound. Anything higher just inflates the slowest test on a fast machine.

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

**Fix.** Already shipped in `system/data/db/client.js`. Two layers:
1. **Proactive** — subscribe to the client's `connected` event (fires on reconnects, not the initial connect since we subscribe after `db.connect()` resolves) and re-apply signin + use via a single-flight `reauth()`.
2. **Reactive** — `installQueryRetry()` wraps `db.query()`'s returned builder so its `.collect()` catches `Anonymous access not allowed`, calls `reauth()`, rebuilds the query (`DispatchedPromise` caches the rejection, so we re-call `db.query(...origArgs)`), and retries once. The whole codebase uses `db.query(sql).collect()`; we don't wrap `db.select`/`create`/etc. because nothing in tree uses them directly.

The reactive layer exists because the proactive one alone failed in practice (observed 2026-05-14, ~12K consecutive failures in one daemon's log): the `connected` event either didn't fire on reconnect, or in-flight queries dispatched in the gap between WS recovery and the handler running still threw. Layer 2 is the safety net. If the symptom recurs, check whether either layer was reverted and confirm `system/tests/unit/db-client-reauth.test.js` still passes.

**One-shot recovery** for an already-stuck daemon: `kill <daemon pid>` — the launchd-supervised path (via the `mcp-start --foreground` EALREADY-attach fix) will spawn a fresh daemon that picks up the current code.

### `pnpm` runs tests under a different Node than `node` directly

**Symptom.** `pnpm test:unit` reports `NODE_MODULE_VERSION 141 / 137 mismatch` errors on `better-sqlite3` (or any native addon), but running `node --test <file>` directly succeeds. Hits flow-control tests like `chrome-sync.test.js` and `lrc-sync.test.js`.

**Cause.** `pnpm exec` resolves binaries through its own PATH (Homebrew at `/opt/homebrew/bin/node`, Node 25, ABI 141), while the user's interactive shell uses nvm's `node` (24.14.1, ABI 137). Native modules built for one ABI fail to load under the other.

**Fix.** `.npmrc` at the package root pins pnpm to a specific Node version:
```
use-node-version=24.14.1
```
pnpm downloads and caches that exact Node and uses it for every spawned process. If you bump the project Node version, update this line *and* rebuild native addons (`node_modules/better-sqlite3 && node-gyp rebuild --target=<new-version>`).

### `node --test` hangs forever after passing all tests

**Symptom.** A direct `node --test system/tests/unit/<file>.test.js` invocation prints all tests as `✔` plus the summary (`ℹ pass N`, `ℹ duration_ms …`), then *never exits*. The Claude harness shell times out, gets killed by `/clear`, but leaves orphan `node --test` + child-worker processes (PPID=1) holding native handles. They pile up across sessions. `pnpm test` and `pnpm test:unit` are NOT affected.

**Cause.** `@surrealdb/node@3.0.x` embedded engines (`mem://`, `surrealkv://`, `rocksdb://`) — used by ~all unit tests via `connect({ engine: 'mem://' })` — register NAPI threadsafe-function handles inside the abort/notification machinery. `db.close()` calls `engine.free()` but doesn't fully release those handles, so node's event loop stays alive after the runner prints its summary. The `--test-force-exit` flag — included in every `pnpm test*` script in `package.json` — tells the test runner to `process.exit()` after the summary regardless; raw `node --test <file>` invocations omit it and hang indefinitely.

**Fix when running a single test file.**
- Use `pnpm test:file system/tests/unit/<file>.test.js` — the script bakes in `--test-force-exit --test-timeout=20000 --test-reporter=spec` so you can't forget.
- To filter inside a file, use `--test-name-pattern`: `pnpm test:file --test-name-pattern='accumulator' system/tests/unit/biographer-batch-accumulator.test.js`.
- If invoking `node --test` directly outside the scripts, **always** include `--test-force-exit`.

**Cleanup when orphans already exist.** `pkill -f "node --test"` then remove `mktemp` leftovers under `$TMPDIR/robin-multi-*`, `$TMPDIR/robin-ws-*`, and `/tmp/robin-test-*`. On macOS `$TMPDIR` resolves under `/var/folders/.../T/`, so `/tmp` alone won't catch everything.

### v2 MCP not exposed to Claude Code

**Symptom.** `mcp__robin__*` tools are not in the deferred-tools list; only `mcp__robin-assistant-v1__*` (or nothing) shows up. The v2 daemon is running but the agent can't talk to it.

**Cause.** Three flavors:
1. `~/.claude.json` has no `robin` entry, or has the legacy stdio entry for v1. The v2 daemon serves MCP over SSE, not stdio.
2. **Race condition with concurrent Claude sessions:** another agent session can silently rewrite `~/.claude.json` from its in-memory copy and clobber the `robin` entry. Observed live in this repo when 16 concurrent stdio v1 children were running — Claude Code's own backups in `~/.claude/backups/.claude.json.backup.*` show the `robin` entry vanishing without our action.
3. **Transport-type mismatch.** The entry uses `"type": "http"` (Streamable HTTP — single endpoint, POSTs JSON-RPC directly to the URL) but the daemon serves the legacy SSE transport (`SSEServerTransport`, GET `/sse` for the event stream + POST `/messages?sessionId=…`). Claude Code's MCP log shows `Streamable HTTP error: Error POSTing to endpoint: (code: 404)`. The correct type is `"sse"`.

**Fix.** Write the SSE entry to **both** locations so a single race-overwrite of the global file leaves a working fallback. Use `"type": "sse"` — the daemon does not support Streamable HTTP:
1. `~/.claude.json` `mcpServers.robin`:
   ```json
   "robin": { "type": "sse", "url": "http://127.0.0.1:<port>/sse" }
   ```
2. Project-level `.mcp.json` at the package root (gitignored — port is user-specific):
   ```json
   { "mcpServers": { "robin": { "type": "sse", "url": "http://127.0.0.1:<port>/sse" } } }
   ```

Port lives in `user-data/config/config.json` under `mcp.port`. After editing, the user must restart Claude Code — running sessions keep whatever MCP wiring they saw at launch.

To clean up orphan v1 MCP children (each terminal session that ever connected to v1 has its own stdio child server holding file descriptors): `pkill -f "robin-assistant-v1/system/scripts/mcp/server.js"`.
