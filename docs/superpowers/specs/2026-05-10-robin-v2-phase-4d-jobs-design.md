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

Built-in jobs ship at `src/jobs/builtin/<name>.md` (in the npm package). User-defined jobs live at `<robinHome>/jobs/<name>.md`. The loader globs **both** directories on every heartbeat tick (parsed once, cached for the tick). When the same `name` appears in both, the user copy wins. **No copy-on-boot step** — this avoids two failure modes: (a) a built-in the user deleted getting re-copied next boot, (b) divergence between the package's built-in and the user's stale copy after an `npm update`. To shadow a built-in, write `<robinHome>/jobs/<name>.md` with whatever frontmatter you want (commonly `enabled: false`); to revert, delete the user copy and the package's built-in surfaces again.

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
manually_runnable: true            # default true; set false for destructive jobs
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
DEFINE FIELD manually_runnable ON runtime_jobs TYPE bool DEFAULT true;
DEFINE FIELD updated_at        ON runtime_jobs TYPE datetime DEFAULT time::now();
DEFINE INDEX runtime_jobs_name ON runtime_jobs FIELDS name UNIQUE;
```

Why a real table and not a sub-object of `runtime:scheduler`: jobs need per-job durability for `consecutive_failures` and `in_flight` across daemon restarts, and the manifest-shaped sub-object pattern at `runtime:scheduler.value.integrations` was already getting awkward. Two `events.source` values used: `job_output` (successful agent-runtime output captured per `notify`) and `job_notification` (failure surfaced via `notify_on_failure`). Migration `0007-source-relax.surql` already loosened the `events.source` ASSERT to allow integration sources without a hardcoded list; `0011` validates the assumption with a CREATE-then-DELETE roundtrip rather than touching the ASSERT.

## 5. Heartbeat integration

`src/daemon/scheduler.js` (the existing `createScheduler` factory) already surveys integrations + dream cursor on each tick. Add a third surface: jobs.

On each tick:

1. **Discover** — read both `src/jobs/builtin/*.md` (package) and `<robinHome>/jobs/*.md` (user); merge with user-wins-by-name (single readdir + parse, cached for the duration of the tick).
2. **UPSERT** — for each discovered job, ensure a `runtime_jobs` row exists; update fields the markdown is authoritative for at row-creation time only (`schedule`, `runtime`, `catch_up`, `notify`, `notify_on_failure`, `timeout_minutes`, `manually_runnable`). The `enabled` field is **DB-authoritative after creation** — initial value comes from frontmatter, but subsequent CLI `enable`/`disable` writes only to the DB and ignores the markdown. This decouples user customization of the markdown body from runtime-toggle state.
3. **Garbage-collect** — `runtime_jobs` rows whose name no longer exists in either source directory get `enabled = false` (not deleted, so audit trail survives). Reactivation = re-adding the file.
4. **Plan** — for each enabled job, compute `next_run_at` from `schedule` if it's missing or stale. Catch-up rules:
   - `last_run_at IS NONE` (job never fired) + `catch_up: true` → fire on this tick.
   - `last_run_at IS NONE` + `catch_up: false` → schedule to `nextFire(schedule, now)` and wait.
   - `last_run_at` exists, behind by more than 1.5× the cadence interval + `catch_up: true` → fire once on this tick (single catch-up, not one per missed slot).
   - `last_run_at` exists, behind by more than 1.5× + `catch_up: false` → silently skip the missed slots; schedule to `nextFire(schedule, now)`.
5. **Dispatch** — for each job where `next_run_at <= now` and `in_flight = false`, set `in_flight = true`, then fire `runOneJob(name)`. **Tick dispatch order:** integrations first, dream next, jobs last — preserves the existing pre-jobs behavior. **Within the jobs phase**, fires are sequential and awaited in alphabetical job-name order: `await runOneJob(name)` inside the loop. A long agent job blocks the rest of the jobs in *that* tick but not other surfaces in the *next* tick (60s later). Cross-tick: `in_flight = true` survives, so a job that takes longer than its cadence won't double-fire.

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

- `discord_dm` — look up `'discord_send'` in the daemon's registered `tools[]` array (built in `src/daemon/server.js`) and call its `handler` directly. No MCP roundtrip; the tool's already-wired `{db, capture, getGatewayClient}` ctx is shared. Target = first user in `DISCORD_ALLOWED_USER_IDS`. If the env var is empty, the job fails with `last_error: 'no discord notify target'`; the failure path then also has no target, so the failure surfaces in `<robinHome>/cache/logs/jobs.log` and `runtime_jobs.last_error` only. Subject to existing 2000-char cap; over-cap is truncated to 1996 + `…` (different policy from agent-driven `discord_send`, which refuses — for jobs we want delivery). Outbound policy + rate-limit still apply; a policy refusal becomes a job failure surfaced through `notify_on_failure`.
- `capture` — `recordEvent` with `source: 'job_output'`, `external_id: '<name>:<iso8601>'`, content = output (first 4000 chars to stay sane).
- `both` — both.
- `none` — output logged to daemon stdout, nothing else.

`notify_on_failure`: on failure, send `[<name>] failed: <last_error>` via the same `notify` channel, but with `source: 'job_notification'` on the capture path. Failures are always also written to `<robinHome>/cache/logs/jobs.log` (new) regardless of `notify` — same shape as biographer.log. The failure-notification path is itself subject to the rate limit; a job stuck in fast-failing mode that exhausts the bucket will simply stop emitting Discord pings (and `runtime:outbound_rate.discord_send` makes the saturation visible via `robin doctor`).

## 7. Cron parser (minimal, in-tree)

`src/jobs/cron.js`. Subset:

- 5-field: `<minute> <hour> <day-of-month> <month> <day-of-week>`.
- Operators per field: `*`, single int, `a,b,c` list, `a-b` range, `*/n` step. No `L`/`#`/named day-of-week.
- Aliases: `@daily` → `0 0 * * *`, `@hourly` → `0 * * * *`, `@weekly` → `0 0 * * 0`, `@monthly` → `0 0 1 * *`, `@yearly` → `0 0 1 1 *`.
- TZ: parser operates in `process.env.TZ` (matches dream). Date arithmetic uses JS native Date, which handles DST transitions opaquely with the known caveats (a daily 2-AM-local job may fire 0 or 2 times on a transition day at 60s tick granularity). Tests pin TZ explicitly with `process.env.TZ = 'America/Los_Angeles'` to lock determinism. Default `Etc/UTC` if unset.

Public API:

```ts
parseCron(expr: string): CronParts
nextFire(parts: CronParts, after: Date): Date
prevFire(parts: CronParts, before: Date): Date  // for catch-up
expectedIntervalMs(parts: CronParts, around: Date): number  // approximate, used for catch-up window
```

Implementation: brute-force forward minute-scan capped at `5_000_000` iterations (≈10 years of minutes — enough for `@yearly` and Feb-29 patterns). 5M JS Date increments stays under a second on hot path; not on hot path anyway (only called when planning `next_run_at`, typically once per job per fire). Fits in ~80 lines including tests.

## 8. CLI surface

```
robin jobs <list|status|run|enable|disable|reload>

robin jobs list                       # all jobs: name · enabled · schedule · last-run · next-run · OK/FAIL
robin jobs status <name>              # one job in detail (above + last_error, consecutive_failures, in_flight)
robin jobs run <name> [--force]       # manual fire (refuses if in_flight unless --force; refuses if !manually_runnable unless --force; --force still locks)
robin jobs enable <name>              # writes runtime_jobs.enabled = true (DB only — never modifies markdown)
robin jobs disable <name>             # mirror
robin jobs reload                     # force a re-scan of jobs dirs without waiting for a tick
```

`enable`/`disable` are DB-only by design (see §5 step 2). To permanently disable a job in a way that survives a DB nuke or reinstall, edit `enabled: false` in the user-side markdown directly.

`robin jobs run` routes through the daemon HTTP server (`POST /internal/jobs/run`) so it shares the same `in_flight` interlock as scheduled fires.

## 9. MCP tools

Two new tools surfaced via the daemon's MCP registration:

- `list_jobs(filter?: { enabled?: bool })` — return array of `{ name, enabled, schedule, runtime, manually_runnable, last_run_at, last_run_ok, next_run_at, consecutive_failures }`.
- `run_job({ name, dry_run?: bool })` — manual trigger. `dry_run: true` resolves the job, validates frontmatter, but doesn't dispatch. Same in_flight semantics as the CLI. Refuses with `{ ok: false, reason: 'not_manually_runnable' }` if the job's frontmatter declared `manually_runnable: false`. This is the gate that keeps destructive jobs (future: `db-backup`, `prune`, `compact`) from being agent-fireable.

Neither tool goes through the PII guard — they're read/trigger surfaces, not memory writes. `run_job` should be reserved for user-requested catch-ups ("run daily briefing now"), not autonomous loops; AGENTS.md restates this rule (§11).

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
- `jobs-cli.test.js` — list, status, enable/disable round-trip (DB-only — verify markdown is untouched on disk), run --force passes through to daemon. Negative: `run` on a `manually_runnable: false` job refuses without `--force`.
- `jobs-mcp-list.test.js`, `jobs-mcp-run.test.js` — MCP tool shape + behavior with stubbed daemon ctx, including `not_manually_runnable` refusal.
- `jobs-discord-notify.test.js` — `notify: discord_dm` with empty `DISCORD_ALLOWED_USER_IDS` fails with `'no discord notify target'`; over-2000-char output is truncated to 1996+`…`; rate-limit refusal is captured as job failure.
- `agents-md-jobs.test.js` — new `<!-- robin-jobs:start -->` block renders, includes both enabled and disabled jobs, falls back to `(jobs surface unavailable — daemon not initialized)` when no `jobs` array is passed.

Integration:

- `jobs-roundtrip.test.js` — daily-briefing built-in is discovered (no copy step — globbed from `src/jobs/builtin/`); toggling `enabled` via CLI is observed by next heartbeat tick; manual `run_job` writes a `job_output` event with the agent's canned reply. Second sub-case: write a user-side override at `<robinHome>/jobs/daily-briefing.md` with a different schedule; verify the merged loader uses the user copy's frontmatter.

Approx test count: ~40 unit + 1 integration. Brings full suite to ~852.

## 13. Migration / rollout

Order:

1. New schema migration `0011-jobs.surql`. Runs automatically on next `robin migrate` (or installer).
2. Built-in daily-briefing markdown lives in the npm package at `src/jobs/builtin/daily-briefing.md`. The loader globs both `src/jobs/builtin/` (package) and `<robinHome>/jobs/` (user) on every tick — no boot-time copy, user copy overrides built-in by name.
3. Daemon picks up the new scheduler surface on next restart.
4. AGENTS.md gets the new jobs section on next host-CLI install or manual `robin install --hooks-only`-shaped step (note: hooks-only doesn't currently regenerate AGENTS.md — a separate `robin install --agents-md-only` flag could be added later; not in scope for 4d).

No data migration needed. v1 jobs aren't ported by code — user enables them by dropping v1's markdown into `<robinHome>/jobs/` and editing as needed.

## 14. Risk register

- **Cron edge cases.** Brute-force scan + Date arithmetic + DST means a daily job around 2 AM clock-shift can fire either 0 or 2 times in the transition day. Tolerated; 60s tick granularity already makes us imprecise.
- **Agent jobs runaway via host.invokeLLM.** A 15min timeout is the hard cap. The `tier: 'deep'` mode is the same one dream uses, so cost is bounded.
- **Discord delivery during outbound block.** A daily briefing whose content trips PII patterns refuses send → user gets a job failure notification instead. The failure notification ITSELF goes through the same channel, so a persistently-failing job would surface daily. This is fine and self-stopping (it becomes obvious there's a problem).
- **Failure cascade saturates the discord_send rate limit.** A frequently-failing job with `notify_on_failure: true` could send up to 10 failure pings/hr (default cap), at which point the rate limiter shuts that bucket. Mitigations: rate-limit refusals are themselves recorded in `runtime_jobs.last_error`, the existing `runtime:outbound_rate` row makes the saturation visible to `robin doctor`, and `DISCORD_SEND_RATE_LIMIT` is env-tunable. Job-driven and agent-driven `discord_send` share the bucket; splitting is deferred (see §15).
- **Long agent job blocks intra-tick job queue.** Within one heartbeat tick, jobs fire sequentially. A 14-minute LLM call (just under timeout) blocks any other job that would have fired in the same tick. Acceptable at v2 scale (single user, ≤ small handful of enabled jobs); the next tick (60s after the long job completes) catches up. Not acceptable if jobs surface grows >20 enabled items; revisit then.

## 15. Open questions (deferred)

1. **Per-job notification channels.** Currently `notify: discord_dm` always targets the first allowlisted user. Future: `notify: discord_dm:<user_id>` lets a job target a different user (e.g., team morning briefing → designated recipient). Deferred until we have >1 daily-briefing-shaped job.
2. **Internal-runtime job library.** No internal jobs ship in 4d. Future ports: `db-backup` (lifted from v1 db-backup.md), `prune` (RocksDB compaction), `health-check` (cross-integration sanity sweep). All would ship with `manually_runnable: false`. Deferred to follow-up.
3. **Job dependencies (run B after A succeeds).** Out of scope. v1 had it; usage was rare.
4. **Per-job rate-limit bucket.** All job-driven discord_send fires share the agent-driven `discord_send` rate bucket. Splitting (`discord_send:agent` vs `discord_send:jobs`) would let a chatty job not starve agent-driven sends. Defer until we observe contention.
5. **AGENTS.md regenerator + integrations data.** Spec §11 adds a small DB-read pass to populate the new jobs block. The existing integrations block has the same gap (renderer accepts a `jobs` / `integrations` array but the install-time caller passes neither). Tracked here; fix lands when the AGENTS.md regenerator gets its own deliberate refactor.

## 16. Phase exit criteria

- All tests green.
- `robin jobs list` returns the built-in daily-briefing as disabled.
- `robin jobs enable daily-briefing` flips it in DB only (markdown on disk byte-identical before and after).
- `robin jobs run daily-briefing` produces an output, captures it, sends it to Discord (when allowlist + bot are configured), all wrapped in outbound policy + rate limit.
- `robin jobs run` refuses a `manually_runnable: false` job without `--force`.
- Heartbeat fires the job on schedule (verifiable by setting `schedule: "*/2 * * * *"` and watching for two-minute fires in the integration test).
- Catch-up semantics verified: a `catch_up: true` job that has never fired runs on the next tick after enable; a `catch_up: false` job waits for the next scheduled minute.
- User-side override at `<robinHome>/jobs/daily-briefing.md` takes precedence over the package built-in.
- AGENTS.md `<!-- robin-jobs:start -->` block renders, includes disabled jobs, and falls back gracefully when DB is unavailable at install time.

Phase 4d is intentionally narrow. The big surface — porting many v1 jobs — happens incrementally after.
