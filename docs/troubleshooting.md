# Troubleshooting

Common problems and how to diagnose them under the v2 substrate. The first step in every case is `robin doctor` — it prints a one-fact-per-line health overview.

## After upgrading to alpha.15 (SurrealDB improvements)

### "checksum mismatch for migration 0001-init"

The schema rewrite changed the checksum of `0001-init.surql`. The migration runner refuses to boot when the recorded checksum (in `_migrations`) doesn't match the file. **There is no automatic migrator** (per spec; no v2 users / data).

```sh
# 1. Stop the daemon
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/io.robin-assistant.mcp.plist
# 2. (safety) backup
cp -R <robinHome>/db <robinHome>/db.pre-alpha15
# 3. Reset
rm -rf <robinHome>/db/*
# 4. Restart — new schema applies on boot
```

### "engine: <X> (config) ≠ <Y> (on-disk)"

`robin doctor` detected that `config.json.db.engine` doesn't match the on-disk store format. Embedded stores can't switch engines in place — same destructive-reset playbook applies. After the reset, the daemon opens the configured engine and applies migrations.

### `surrealkv+versioned://` hangs on connect (embedded engine)

Known upstream issue in `@surrealdb/node` 3.0.3: the versioned engine variant doesn't connect (silent hang on `db.connect()`). The local `connect()` helper has a 10s timeout so the daemon fails fast with an actionable error.

**Workaround — run a standalone SurrealDB server and connect over WebSocket:**

```bash
# 1. Install the server (one-time)
brew install surrealdb/tap/surreal
# or:
curl -sSf https://install.surrealdb.com | sh

# 2. Start it with versioned storage
node scripts/start-surreal-server.mjs --storage surrealkv+versioned
# (the helper script reads ROBIN_HOME and writes to <home>/db)

# 3. Point Robin at the server. Edit <robinHome>/config.json:
#    {
#      "db": { "url": "ws://127.0.0.1:8000" }
#    }
#
# 4. Restart the daemon. `robin doctor` will now print:
#    engine: ws (no on-disk DB yet — embedded path doesn't apply)
```

The SDK's remote engines (`ws`, `wss`, `http`, `https`) are registered alongside the embedded ones, so config can switch between embedded and server-mode without code changes. Time-travel reads via `SELECT ... VERSION d'...'` work against the server immediately. Once the embedded `surrealkv+versioned://` upstream bug is fixed, you can drop the standalone server and switch back to `db.engine: "surrealkv+versioned"`.

## The daemon

### `robin doctor` says the daemon is not running

```sh
robin mcp status   # confirm port + pid
robin mcp start    # foreground start (Ctrl-C to stop)
```

If `mcp start` exits immediately:

- **Port in use:** another process is on the same port. `robin mcp status` prints the recorded port. `lsof -i :<port>` to find the squatter.
- **Lock not released:** `<robinHome>/.daemon.lock` is held. If no daemon PID is alive, delete it: `rm <robinHome>/.daemon.lock`.
- **Stale state:** `<robinHome>/.daemon.state` lists a dead PID. `robin doctor` detects this. Delete: `rm <robinHome>/.daemon.state`.

### Daemon crashes immediately after start

Most common cause is profile drift between `config.json` and `runtime:embedder`:

```
[daemon] config drift detected:
  config.json says: gemini-3072
  runtime:embedder says: mxbai-1024
```

Fix one of two ways:

```sh
robin embeddings activate <profile-in-config-json>
# OR edit user-data/config.json back to the runtime profile
```

For a full profile swap (DDL the new profile + backfill + flip) use `robin embeddings prepare/backfill/activate`. The legacy `robin embedder switch` still exists but does an in-place re-embed against the same table set; the new flow is preferred.

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
- Verify hooks aren't globally disabled: check `hooks.disabled` in `<robinHome>/config.json`. Re-enable with `robin hooks enable intuition`.
- Telemetry (note the renamed table — drop the `runtime_` prefix):

  ```surql
  SELECT * FROM intuition_telemetry ORDER BY ts DESC LIMIT 10;
  ```

### `discretion` (bash refusal) blocking commands you want to run

1. Disable the hook: `robin hooks disable discretion` (affects the agent too).
2. Run the command outside the agent's Bash tool.

To see *why* a command was refused, look at the stderr line: `Robin: blocked Bash — <rule-name>: <why>`. Rules live in `src/hooks/bash-patterns.js`.

### `discretion` (memory write) refusing content that doesn't actually contain PII

Force the write from the CLI:

```sh
robin remember --force "the content..."
```

Agents have no override path — they must escalate. Check the audit: `robin refusals list`. Patterns live in `src/hooks/pii-patterns.js` and `src/outbound/patterns.js`.

## Memory

### Recall returns no hits

Three checks, in order:

1. **Active profile is set and the right tables exist:**

   ```sh
   robin embeddings list
   ```

   `active_profile` should be set, and `embeddings_<profile>_events|memos|entities` should all be present with non-zero row counts. If a backfill is in-flight the counts will lag — `runtime:embedder_backfill` carries the cursor.

2. **Embeddings actually populated for the active profile:**

   ```surql
   SELECT count() AS n FROM embeddings_mxbai_1024_events GROUP ALL;
   SELECT count() AS n FROM embeddings_mxbai_1024_memos  GROUP ALL;
   SELECT count() AS n FROM embeddings_mxbai_1024_entities GROUP ALL;
   ```

   If a table is empty but the substrate has rows, run `robin embeddings backfill <profile>`.

3. **HNSW index is actually being used by the planner:**

   ```surql
   EXPLAIN FULL SELECT record, vector::distance::knn() AS dist
     FROM embeddings_mxbai_1024_events
     WHERE vector <|6, 64|> $qvec
     ORDER BY dist LIMIT 6;
   ```

   Look for `Iterate Index` referencing `embeddings_mxbai_1024_events_vec`. If you see `Iterate Table` instead, the index is missing or the query shape didn't match — re-prepare the profile.

For a quick ad-hoc recall: `node scripts/dev-recall.js "your query"`.

### Reinforcement loop not running

The `reinforce-recall` internal job runs every 5 minutes. If `recall_log` rows pile up with `outcome='pending'`, the loop is stalled.

```surql
-- Is the job present + enabled + not stuck in_flight?
SELECT name, enabled, schedule, in_flight, last_run_at, last_run_at_success, last_error
FROM runtime_jobs WHERE name = 'reinforce-recall';

-- Pending rows older than the eval window:
SELECT count() AS pending FROM recall_log WHERE outcome = 'pending' AND ts < time::now() - 5m GROUP ALL;

-- Outcome distribution over the last day:
SELECT outcome, count() AS n FROM recall_log WHERE ts > time::now() - 1d GROUP BY outcome;
```

Common causes:

- `in_flight = true` but daemon was killed mid-run → reset:

  ```sh
  robin jobs run reinforce-recall --force
  ```

- Job disabled in `runtime_jobs`: `robin jobs enable reinforce-recall`.
- Job missing entirely: `robin jobs reload` re-syncs from `src/jobs/builtin/`.

### A memo isn't surfacing in recall

The substrate keeps superseded and contradicted memos; ranking suppresses them. Check the three usual suspects:

```surql
-- Was it superseded? (inbound supersedes edge → fn::freshness returns 0)
SELECT * FROM edges WHERE kind = 'supersedes' AND to = $memo_id;

-- What is its current freshness?
SELECT id, content, fn::freshness(id) AS fresh FROM $memo_id;

-- Is it under an ephemeral scope (filtered by default)?
SELECT id, scope FROM $memo_id;
-- scope:'session:*' / 'temp:*' is excluded from default recall;
-- pass { scopes: ['*'] } for admin queries.

-- How many contradictions does it carry?
SELECT count() AS n FROM edges
WHERE kind = 'contradicts' AND (from = $memo_id OR to = $memo_id) GROUP ALL;
```

A memo with `fresh = 0` has been superseded. To see what replaced it:

```surql
SELECT id, content, derived_at FROM memos
WHERE id IN (SELECT VALUE from FROM edges WHERE kind = 'supersedes' AND to = $memo_id);
```

### `robin journal` is empty after a session

Possible causes:

- Biographer never ran. Check `<robinHome>/cache/logs/biographer.log`. Manually drain: `robin biographer-catchup`.
- Stop hook didn't fire. `robin doctor --lint-hooks` should list a `Stop → stop` entry.
- The conversation-capture pipeline skipped the turn. Skip log lines are in `biographer.log` with a `skip_reason` field: `no_transcript_path`, `no_assistant_turn`, `single_word_ack`, `pure_tool_turn`, `empty_turn`, `dedup_hit`, `pii_refused`.

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

Reflection requires ≥ 3 correction events clustering (cosine ≥ 0.85, within 30 days):

```surql
SELECT count() AS n FROM events
WHERE meta.kind = 'correction' AND ts >= time::now() - 30d;
```

If `n < 3`, you simply don't have enough correction signal yet.

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

- **Unintentional change**: investigate before rebaselining. The finding includes `expected` and `actual` sha256s; `git status` and `git diff` against the tracked file will usually explain.

The `no_baseline` finding (`baselined=false`) means `<robinHome>/manifest.json` is missing — run `robin install` to write one. The daemon still runs without it.

## Integrations

### `robin integrations list` shows an integration as `unavailable`

Each integration's manifest declares the env keys it needs. Missing keys → `unavailable`. Check what it wants:

```sh
robin secrets list
cat src/integrations/<name>/manifest.json
robin secrets set <KEY_NAME>
```

### `next_run_at` keeps slipping into the future

Backoff is active — the integration is failing repeatedly:

```surql
SELECT name, consecutive_failures, last_error, next_run_at
FROM type::record('runtime', 'integrations');
```

Fix and reset:

```sh
robin integrations run <name>    # one manual run (clears backoff on success)
```

### OAuth tokens expired

```sh
robin auth <google|spotify|whoop>     # re-runs the loopback flow
robin auth google --code              # headless box variant
```

## Schema migrations

### `robin migrate` claims pending migrations but the DB looks current

The `_migrations` table tracks applied versions. After v2 there are far fewer files — `0001-init.surql` plus one `0002-embeddings-<profile>.surql` matching the configured profile:

```surql
SELECT version, name, applied_at, checksum FROM _migrations ORDER BY version;
```

The runner refuses on checksum mismatch — already-applied migrations must never be edited. Create a new migration instead.

### Migration runner crashes with "Transaction conflict"

SurrealDB embedded engine surfaces this when two processes touch the same record. The migration runner is single-process (cooperative lock); this usually means the daemon is still running. Stop it:

```sh
robin mcp stop
robin migrate
```

### DB migration failed mid-flight

The migration runner tars `<robinHome>/db/` into `<robinHome>/backup/<timestamp>.tar` before applying each migration. If a migration aborts and leaves the DB in a weird state:

```sh
robin mcp stop
ls <robinHome>/backup/          # find the pre-migration archive
rm -rf <robinHome>/db/*
tar -xf <robinHome>/backup/<timestamp>.tar -C <robinHome>/db/
# inspect / fix the migration .surql, then:
robin migrate
```

## Common SurrealQL footguns

These corrections came out of the v2 redesign verification gates and have bitten people in production:

- **`type::thing` was renamed to `type::record`** in SurrealDB v3.
- **`math::log(x, 2)` is the two-arg form** for log_2; the one-arg variant is rejected.
- **`math::min([a, b])` takes an array**, not multiple args.
- **`SET field += 1` is the canonical UPSERT counter idiom.** `weight = (weight ?? 0) + 1` doesn't increment on existing rows under MERGE.
- **`RecordId.table` returns a `Table` object**, not a string — coerce with `String(rec.table)` in JS.
- **JS `null` binds as SurrealDB `NULL`**, not `NONE` — optional fields should be omitted from SET clauses, not bound as null.
- **`value` is a SurrealQL keyword.** Use `SELECT VALUE value FROM …` (the flattener consumes the keyword in the projection position).
- **`TYPE NORMAL` is incompatible with graph arrows** (`->edges->entities`). The v2 schema uses `TYPE NORMAL` on `edges` for composite-ID idempotent UPSERT; therefore traversals use explicit `SELECT … FROM edges WHERE kind = X AND from = $id`, not arrow syntax.
- **`FLEXIBLE` comes after `TYPE`** in `DEFINE FIELD`: write `TYPE object FLEXIBLE`, not `FLEXIBLE TYPE object`.
- **`array<object>` doesn't accept `FLEXIBLE` on the parent.** Use `array` (untyped) plus `array[*] TYPE object FLEXIBLE` for nested object arrays.

## Failure modes added in alpha.16

- **`Cannot execute UPSERT statement using value: NONE`** — when seeding a
  `runtime:*` row whose key contains a `.`, wrap in backticks:
  `UPSERT runtime:\`evidence.config\` SET value = {...}`. Affects all
  alpha.16 config rows.
- **`Found 'DENY' for field state ... must conform to ['AUTO','ASK','NEVER']`** —
  `action_trust.state` enum was widened to include `DENY`. Pre-existing
  DBs without `0001-init.surql` reapplied will reject writes from the new
  code. Destructive reset required.
- **`The field 'in' already exists`** — `TYPE RELATION` tables auto-define
  `in` and `out` as `record`. Don't redefine them in your own DDL.
- **`Cannot perform subtraction with '<datetime>' and 'NONE'`** — SurrealDB
  v3 doesn't short-circuit OR conditions cleanly. If a WHERE clause is
  `last_used_at IS NONE OR last_used_at < cutoff`, split into two queries
  and union the results in JS. See `runActionTrustDecay`.
- **`SELECT kind FROM action_trust_ledger` → "Idiom missing here"** —
  field-name choice matters. We renamed `action` to `kind` because
  `action` is reserved in `SELECT` projection contexts.
- **`outcome='private_scope'` refusals appearing where they didn't before** —
  Theme 1c fixed an unenforced spec promise. Outbound tools now refuse
  payloads that reference private memos directly or transitively. If a
  legitimate flow refuses, mark the source memo's scope to `global` or
  `project:*` explicitly.

## When in doubt

```sh
robin doctor                         # status overview
robin doctor --health                # alpha.16 — token budget, pending triggers,
                                     # dream freshness, faculty errors. Exit 0/1/2.
robin doctor --health --json         # machine-readable for cron
robin doctor --lint-hooks            # hook entries by host
robin doctor --purge-stale-sessions  # clean runtime_sessions
robin doctor --rebaseline            # rewrite introspection manifest
robin sessions --stale               # active vs stale sessions
robin refusals list                  # recent in/outbound refusal audit
robin embeddings list                # active/read profile + tables + counts
```

Via the MCP introspection tools (alpha.16):

```
explain_recall {query_id?, last_n?}    # why did Robin rank these hits?
explain_belief {memo_id}               # how did confidence get to its value?
explain_action_trust {class}           # full ledger history for tool:action
show_pending_triggers {step?}          # cadence queue depth
show_step_health {since?}              # per-step success rate + cost
recent_refusals {direction?, since?}   # outbound block audit
archive_history {memo_id?}             # archive / restore trail
```

If a faculty is misbehaving and the audit doesn't explain it, the per-faculty deep dive in [`faculties.md`](faculties.md) lists the relevant files, tables, and disable knobs.
