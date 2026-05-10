# Robin v2 Phase 4d — Daemon-Internal Job Runner

**Status:** Design (pre-implementation)
**Date:** 2026-05-10
**Phase:** 4d (Phase 4 envelope from `2026-05-10-robin-v2-phase-4a-safety-floor-design.md`)
**Predecessors:** Phase 2d (integrations framework + heartbeat scheduler), Phase 2c (dream agent), Phase 4a (multi-session registry).
**Sibling-aware:** Coordinates with the in-flight Phase 4f conversation-capture work — jobs do NOT read `transcript_path`, do NOT write `runtime_sessions`, do NOT touch `recordEvent`'s source whitelist beyond declaring two new sources (`job_output`, `job_notification`).

---

## 1. Goal

Restore v1's markdown-defined job system on top of v2's daemon-internal pattern. Jobs run inside the daemon's heartbeat scheduler — same shape as integrations and dream — not via launchd/cron/Task Scheduler. v1's OS-scheduled runner + reconciler are dropped; v2's daemon supervision (launchd plist on macOS, systemd unit on Linux) already keeps the daemon alive, and 60s tick granularity is enough for every v1 job that ever fired.

Ship the runtime + one ported job (daily-briefing) as proof. Other v1 jobs port in follow-up work as the user surfaces a need.

## 2. Out of scope

- OS-scheduled jobs (launchd/cron/TaskScheduler per-job adapters from v1). Dropped — daemon-internal only.
- v1's full reconciler. We re-scan the jobs directory on each heartbeat tick instead (markdown files are cheap to glob + parse).
- Porting jobs beyond daily-briefing. Each port is a small follow-up, not part of this phase.
- Cross-process job locking. Daemon is single-process; one `in_flight` flag per job is sufficient.
- A new schema for "job categories" or "tags." Jobs are flat.

## 3. Job format (markdown + YAML frontmatter)

Built-in jobs ship at `src/jobs/builtin/<name>.md`. Daemon copies built-ins into `<robinHome>/jobs/<name>.md` on first boot if absent, so user can override locally. User-defined jobs live alongside; loader globs `<robinHome>/jobs/*.md`.

Frontmatter:

```yaml
---
name: daily-briefing               # required; must match filename
schedule: "0 7 * * *"              # required; 5-field cron in process.env.TZ
runtime: agent                     # required; 'agent' | 'internal'
enabled: true                      # default false (drop-in jobs are off until you flip)
catch_up: true                     # default false
timeout_minutes: 15                # default 10
notify: both                       # 'discord_dm' | 'capture' | 'both' | 'none'
notify_on_failure: true            # default true
description: Morning brief         # one-line summary
---
```

Body: free-form. For `runtime: agent`, the body is the LLM prompt; passed verbatim with `cache_control` annotations identical to dream's. For `runtime: internal`, the body is documentation and the daemon dispatches to `src/jobs/internal/<name>.js` by name match.

## 4. Schema (migration 0011)

Single new table `runtime_jobs`. Mirror of `runtime:scheduler.value.integrations` shape:

```surql
DEFINE TABLE runtime_jobs SCHEMAFULL;
DEFINE FIELD name             ON runtime_jobs TYPE string;
DEFINE FIELD enabled          ON runtime_jobs TYPE bool;
DEFINE FIELD schedule         ON runtime_jobs TYPE string;
DEFINE FIELD runtime          ON runtime_jobs TYPE string ASSERT $value IN ['agent', 'internal'];
DEFINE FIELD catch_up         ON runtime_jobs TYPE bool;
DEFINE FIELD notify           ON runtime_jobs TYPE string;
DEFINE FIELD notify_on_failure ON runtime_jobs TYPE bool;
DEFINE FIELD timeout_minutes  ON runtime_jobs TYPE int;
DEFINE FIELD last_run_at      ON runtime_jobs TYPE option<datetime>;
DEFINE FIELD last_run_ok      ON runtime_jobs TYPE option<bool>;
DEFINE FIELD last_error       ON runtime_jobs TYPE option<string>;
DEFINE FIELD last_duration_ms ON runtime_jobs TYPE option<int>;
DEFINE FIELD next_run_at      ON runtime_jobs TYPE option<datetime>;
DEFINE FIELD consecutive_failures ON runtime_jobs TYPE int DEFAULT 0;
DEFINE FIELD in_flight         ON runtime_jobs TYPE bool DEFAULT false;
DEFINE FIELD updated_at        ON runtime_jobs TYPE datetime DEFAULT time::now();
DEFINE INDEX runtime_jobs_name ON runtime_jobs FIELDS name UNIQUE;
```

Why a real table and not a sub-object of `runtime:scheduler`: jobs need per-job durability for `consecutive_failures` and `in_flight` across daemon restarts, and the manifest-shaped sub-object pattern at `runtime:scheduler.value.integrations` was already getting awkward. Two `events.source` values added: `job_output` (successful agent-runtime output captured per `notify`) and `job_notification` (failure surfaced via `notify_on_failure`).

## 5. Heartbeat integration

`src/daemon/scheduler.js` (the existing `createScheduler` factory) already surveys integrations + dream cursor on each tick. Add a third surface: jobs.

On each tick:

1. **Discover** — read `<robinHome>/jobs/*.md` (single readdir + parse, cached for the duration of the tick).
2. **UPSERT** — for each discovered job, ensure a `runtime_jobs` row exists; update fields the markdown is authoritative for (`schedule`, `runtime`, `catch_up`, `notify`, `notify_on_failure`, `timeout_minutes`). Toggling `enabled` in the markdown also writes through.
3. **Garbage-collect** — `runtime_jobs` rows whose name no longer exists in the markdown directory get `enabled = false` set (not deleted, so audit trail survives). Reactivation = re-adding the file.
4. **Plan** — for each enabled job, compute `next_run_at` from `schedule` if it's missing or stale. Catch-up rule: if `catch_up: true` and `last_run_at` is more than 1.5× cadence behind `now`, set `next_run_at = now` (one catch-up, not many).
5. **Dispatch** — for each job where `next_run_at <= now` and `in_flight = false`, set `in_flight = true`, then fire `runOneJob(name)`. The scheduler limits concurrent fires to 1 per tick by default; if jobs collide, the loser slips a tick (fine at 60s granularity).

`runOneJob(name)` wraps:

- `runtime: agent`: `await host.invokeLLM([{ role: 'user', content: body }], { tier: 'deep' })`. Output is the agent's reply string.
- `runtime: internal`: dynamic-import `src/jobs/internal/${name}.js`, call its default export with `{ db, host, capture, getGatewayClient }`. Returns a string for `notify`-style output, or `null` for silent.

Wrapped in:

- `setTimeout` against `timeout_minutes * 60_000`. Timeout → failure with `last_error = 'timeout'`.
- try/catch. Any throw → failure, `consecutive_failures += 1`, `last_error = e.message`.
- On success: `consecutive_failures = 0`, `last_run_ok = true`, `last_duration_ms`, recompute `next_run_at`.
- On failure: `last_run_ok = false`, `last_duration_ms`. Backoff for next fire: capped exponential, same shape as integrations (3× consecutive doubles next interval up to 24h).
- Always: `in_flight = false`, `updated_at = now`.

## 6. Notification dispatch

For agent-runtime jobs, the LLM output is the briefing content. For internal jobs, the function returns the message string (or null).

`notify` semantics:

- `discord_dm` — call `discord_send` tool's handler directly (not via MCP roundtrip; daemon-internal). Target = first user in `DISCORD_ALLOWED_USER_IDS`. Subject to existing 2000-char cap; over-cap is truncated to 1996 + `…` (different policy from agent-driven `discord_send`, which refuses — for jobs we want delivery). Outbound policy + rate-limit still apply; a policy refusal becomes a job failure surfaced through `notify_on_failure`.
- `capture` — `recordEvent` with `source: 'job_output'`, `external_id: '<name>:<iso8601>'`, content = output (first 4000 chars to stay sane).
- `both` — both.
- `none` — output logged to daemon stdout, nothing else.

`notify_on_failure`: on failure, send `[<name>] failed: <last_error>` via the same `notify` channel, but with `source: 'job_notification'` on the capture path. Failures are always also written to `<robinHome>/cache/logs/jobs.log` (new) regardless of `notify` — same shape as biographer.log.

## 7. Cron parser (minimal, in-tree)

`src/jobs/cron.js`. Subset:

- 5-field: `<minute> <hour> <day-of-month> <month> <day-of-week>`.
- Operators per field: `*`, single int, `a,b,c` list, `a-b` range, `*/n` step. No `L`/`#`/named day-of-week.
- Aliases: `@daily` → `0 0 * * *`, `@hourly` → `0 * * * *`, `@weekly` → `0 0 * * 0`, `@monthly` → `0 0 1 * *`, `@yearly` → `0 0 1 1 *`.
- TZ: respects `process.env.TZ` (matches dream's behavior). Default Etc/UTC if unset.

Public API:

```ts
parseCron(expr: string): CronParts
nextFire(parts: CronParts, after: Date): Date
prevFire(parts: CronParts, before: Date): Date  // for catch-up
expectedIntervalMs(parts: CronParts, around: Date): number  // approximate, used for catch-up window
```

Implementation: brute-force forward minute-scan capped at 10000 iterations (≈1 week of minutes — enough for any cron expression that fires more than weekly). Fits in ~80 lines including tests.

## 8. CLI surface

```
robin jobs <list|status|run|enable|disable|reload>

robin jobs list                       # all jobs: name · enabled · schedule · last-run · next-run · OK/FAIL
robin jobs status <name>              # one job in detail (above + last_error, consecutive_failures, in_flight)
robin jobs run <name> [--force]       # manual fire (refuses if in_flight unless --force; --force still locks)
robin jobs enable <name>              # markdown frontmatter rewrite (enabled: true) + DB UPSERT
robin jobs disable <name>             # mirror
robin jobs reload                     # force a re-scan of <robinHome>/jobs/*.md without waiting for a tick
```

`robin jobs run` routes through the daemon HTTP server (`POST /internal/jobs/run`) so it shares the same `in_flight` interlock as scheduled fires.

## 9. MCP tools

Two new tools surfaced via the daemon's MCP registration:

- `list_jobs(filter?: { enabled?: bool })` — return array of `{ name, enabled, schedule, runtime, last_run_at, last_run_ok, next_run_at, consecutive_failures }`.
- `run_job({ name, dry_run?: bool })` — manual trigger. `dry_run: true` resolves the job, validates frontmatter, but doesn't dispatch. Same in_flight semantics as the CLI.

Both go through the existing `outbound_refusals(direction='inbound')` PII guard? No — these are read/trigger surfaces, not memory writes. They don't go through the PII guard. They DO require the agent to use them sensibly: `run_job` should be reserved for user-requested catch-ups ("run daily briefing now"), not autonomous loops.

## 10. Built-in: daily-briefing

Port of v1's `system/jobs/daily-briefing.md`. Adapted body so the LLM (Claude or Gemini, via existing host adapter) produces a tight morning summary covering:

- Calendar events for today (via `calendar_list_events` MCP tool, called from within the prompt — let the agent figure it out)
- Any flagged unread emails (via `gmail_search`)
- Recent corrections that haven't been acted on yet (via `recall` over events with source='correction')
- Open Linear issues assigned to user (via `linear` recall)

Frontmatter:

```yaml
name: daily-briefing
schedule: "0 7 * * *"
runtime: agent
enabled: false           # ships disabled — user flips on via `robin jobs enable daily-briefing`
catch_up: true
timeout_minutes: 15
notify: both
notify_on_failure: true
description: Morning brief — calendar, mail, corrections, open work.
```

Why ships disabled: the user needs functioning discord_send + an allowlist + working Gmail/calendar integrations before this is useful. Flipping `enabled: true` is the user's deliberate opt-in once their setup is ready.

The body lifts v1's prompt with two changes: (1) drop v1's `system/rules/` references (those rules are now in CLAUDE.md/GEMINI.md), (2) refer to v2 MCP tool names (`calendar_list_events`, not v1's `calendar.list_events()`). The literal prompt text is finalized at implementation time, not specified here — there's no single canonical wording, and the integration tests use stubbed LLM responses so the prompt's exact phrasing isn't load-bearing for correctness.

## 11. AGENTS.md updates

New regenerable block `<!-- robin-jobs:start/end -->` describing the jobs surface:

- One-line per known job (name + enabled/disabled + schedule + next_run_at) so the user sees what's available to enable, not just what's already enabled.
- Note that the agent CAN call `run_job` but SHOULD only do so on user request.
- Note that scheduled fires happen autonomously inside the daemon — the agent does not need to (and should not) drive them.

Inserted between the integrations section and the memory tools section.

**Regenerator plumbing:** `agentsMdContent()` currently isn't passed a `jobs` array by `mcp-install.js`. The fix is a small additive change to `mcp-install.js`: connect to the DB, read `runtime_jobs`, pass the array through alongside the (currently empty) `integrations` array. Fail-soft: if the DB can't be read at install time, the block renders `(jobs surface unavailable — daemon not initialized)`. This pattern also unblocks fixing the existing not-implemented `integrations` data path; out of scope for 4d but worth tracking.

## 12. Tests

Unit:

- `cron-parser.test.js` — parses each field operator, `@`-aliases, TZ handling, edge cases (Feb 29, DST transitions deliberately tolerated as approximate at 60s tick granularity).
- `jobs-loader.test.js` — markdown frontmatter parse, validation, error paths (missing required fields, invalid runtime, unknown notify value), name/filename mismatch.
- `jobs-scheduler.test.js` — `listDue` returns jobs whose `next_run_at <= now`, ignores `in_flight: true`, respects `enabled: false`. Catch-up rule: job missing for 2× cadence with `catch_up: true` fires once; without `catch_up`, doesn't fire.
- `jobs-run-agent.test.js` — agent runtime: LLM stub returns canned output, `notify: capture` writes one `job_output` event, `notify: discord_dm` calls discord_send with the output, `notify: both` does both. Timeout test: LLM stub hangs, job fails with `last_error: 'timeout'`. Throw test: LLM stub throws, failure logged + notified.
- `jobs-cli.test.js` — list, status, enable/disable round-trip (markdown rewrite + DB update), run --force passes through to daemon.
- `jobs-mcp-list.test.js`, `jobs-mcp-run.test.js` — MCP tool shape + behavior with stubbed daemon ctx.

Integration:

- `jobs-roundtrip.test.js` — built-in daily-briefing markdown is copied into `<robinHome>/jobs/` on first daemon boot; toggling enabled via CLI is observed by next heartbeat tick; manual `run_job` writes a `job_output` event with the agent's canned reply.

Approx test count: ~40 unit + 1 integration. Brings full suite to ~852.

## 13. Migration / rollout

Order:

1. New schema migration `0011-jobs.surql`. Runs automatically on next `robin migrate` (or installer).
2. Built-in daily-briefing markdown lives in the npm package at `src/jobs/builtin/daily-briefing.md`. On daemon boot, copy any built-in not present in `<robinHome>/jobs/` (no overwrite if present — user copies are sacred).
3. Daemon picks up the new scheduler surface on next restart.
4. AGENTS.md gets the new jobs section on next host-CLI install or manual `robin install --hooks-only`-shaped step (note: hooks-only doesn't currently regenerate AGENTS.md — a separate `robin install --agents-md-only` flag could be added later; not in scope for 4d).

No data migration needed. v1 jobs aren't ported by code — user enables them by dropping v1's markdown into `<robinHome>/jobs/` and editing as needed.

## 14. Risk register

- **Cron edge cases.** Brute-force scan + Date arithmetic + DST means a daily job around 2 AM clock-shift can fire either 0 or 2 times in the transition day. Tolerated; 60s tick granularity already makes us imprecise.
- **Agent jobs runaway via host.invokeLLM.** A 15min timeout is the hard cap. The `tier: 'deep'` mode is the same one dream uses, so cost is bounded.
- **Discord delivery during outbound block.** A daily briefing whose content trips PII patterns refuses send → user gets a job failure notification instead. The failure notification ITSELF goes through the same channel, so a persistently-failing job would surface daily. This is fine and self-stopping (it becomes obvious there's a problem).
- **Markdown drift between built-in and user copy.** After `npm update` bumps the built-in, the user-side copy is stale. Detection: daemon-boot diff log line if `<robinHome>/jobs/<name>.md` differs from `src/jobs/builtin/<name>.md`. No auto-overwrite; user reconciles by hand or deletes the user copy.

## 15. Open questions (deferred)

1. **Per-job notification channels.** Currently `notify: discord_dm` always targets the first allowlisted user. Future: `notify: discord_dm:<user_id>` lets a job target a different user (e.g., team morning briefing → designated recipient). Deferred until we have >1 daily-briefing-shaped job.
2. **Internal-runtime job library.** No internal jobs ship in 4d. Future ports: `db-backup` (lifted from v1 db-backup.md), `prune` (RocksDB compaction), `health-check` (cross-integration sanity sweep). Deferred to follow-up.
3. **Job dependencies (run B after A succeeds).** Out of scope. v1 had it; usage was rare.

## 16. Phase exit criteria

- All tests green.
- `robin jobs list` returns the built-in daily-briefing as disabled.
- `robin jobs enable daily-briefing` flips it in markdown + DB.
- `robin jobs run daily-briefing` produces an output, captures it, sends it to Discord (when allowlist + bot are configured), all wrapped in outbound policy + rate limit.
- Heartbeat fires the job on schedule (verifiable by setting `schedule: "*/2 * * * *"` and watching for two-minute fires in the integration test).
- AGENTS.md `<!-- robin-jobs:start -->` block renders.

Phase 4d is intentionally narrow. The big surface — porting many v1 jobs — happens incrementally after.
