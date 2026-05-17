# Polish Phase A — Audit Notes

**Date range:** 2026-05-17 → <end>
**Phase A complete:** <date>

## A.1 Silent-failure hunt

### Inventory

### A1-Inventory (seed scan)

Seed scan run 2026-05-17 against `system/` with cognition-e1 and prompt-injection
exclude lists applied. Raw output in `tmp/polish-a1-seed.txt` (gitignored).

Suspect-site counts per static pattern:

- EMPTY_CATCHES: 0
- COMMENTED_CATCHES: 12
- CATCH_RETURN_FALLBACK: 49
- PROMISE_CATCH_FALLBACK: 17
- LOG_AND_SWALLOW: 6
- PROMISE_ALLSETTLED_DISCARDED: 2

Total raw seed sites: 86 (manual sweep will widen scope beyond grep).

Exclude-list filter confirmed: `OK: no cognition-e1 leakage` and all
prompt-injection-owned paths (`runtime/daemon/server.js`, `lifecycle.js`,
`http.js`, `log-scrub.js`, `cli/commands/web.js`, `mcp/tools/ingest.js`,
`io/integrations/_framework/capture.js`, `config/daemon-state.js`,
`config/data-store.js`, `config/mcp-token.js`, `runtime/web/server.js`,
`runtime/invariants/mcp.wiring-{global,project}-present.js`) excluded
from grep hits.

### Modules swept (Task 7)

Manual full-file read of every in-scope module (cognition-e1 and prompt-injection exclusions honored). Decision summary:

- **MCP server / tools:** `mcp/tools/audit.js`, `browser.js`, `explain-recall.js`, `explain-learning.js` *(fix)*, `explain-playbook.js` *(fix)*, `macos-notify.js`, `recall.js`, `record-correction.js` *(fix)*, `run-biographer.js`, `predict.js`. (`server.js` was refactored; MCP transport lives at `runtime/daemon/mcp-sse.js` — covered there.)
- **Integration adapters:** `io/integrations/gmail/sync.js`, `gmail/tools/*.js`, `google_calendar/tools/calendar-get-event.js`, `weather/sync.js` (no catches). Integrations have no `index.js` — manifest-driven discovery via `_framework/manifest-loader.js` (read-only sweep).
- **Capture:** `io/capture/record-event.js` (resilient-by-design — `keep`).
- **Daemon (non-prompt-injection-owned):** `runtime/daemon/boot.js`, `cadence-consumer.js` *(document)*, `dispatcher-tick.js`, `heartbeat.js`, `idle-embedder.js`, `introspection.js`, `job-hot-reload.js`, `lock.js`, `mcp-sse.js`, `port.js`, `retry.js`, `schema.js`, `sessions.js`, `tools.js`, `version-handshake.js`, `routes/biographer.js`, `routes/intuition.js`, `routes/remember.js`, `routes/session.js`.
- **Data layer:** `data/db/migrate.js`, `data/db/backup.js`, `data/db/lock.js`. (`client.js` excluded.)
- **Invariants:** all 25 (excluding `mcp.wiring-{global,project}-present.js`). Every catch follows the documented `{ok:false, error}` contract; gate-style `enabled()` catches return false on probe failure by design.
- **CLI commands:** all 76 (excluding `_doctor-*` and `web.js`). Includes `bin.js`, `index.js`, `health.js` *(fix)*, `daemon-request.js`, `recall-eval.js`, `mcp-ensure-running.js`, `dream-run.js`, `surreal-ensure-running.js`, `install.js`, `uninstall.js`, `migrate.js`, `mcp-install.js`, `mcp-start.js`, `mcp-restart.js`, `mcp-stop.js`, `mcp-uninstall.js`, `secrets-import.js`, `import-v1.js`, `version.js`, `publish.js`, `embeddings.js`, `auth-google.js`, `auth-spotify.js`, `auth-whoop.js`, `integrations-{enable,disable,list,run,status,discord-register,migrate}.js`, `jobs-{enable,disable,list,reload,run,status}.js`, `biographer-{catchup,process-pending}.js`, `brief-{calibrate,feedback,gallery,regenerate}.js`, `calibration-show.js`, `commstyle-{refresh,show}.js`, `pre-commit-{install,run,uninstall}.js`, `predictions-list.js`, `hooks-{enable,disable}.js`, `hook.js`, `hot.js`, `journal.js`, `ingest.js`, `actions-*.js`, `sessions-purge.js`, `migrate-user-data.js`, `audit.js`, `lint.js`, `help.js`.
- **Cognition (non-e1-owned):** `cognition/jobs/runner.js`, `db.js`, `scheduler-ext.js`, `cron.js`, `notify.js`, `loader.js`, `cost-monitor.js` *(document)*, `embeddings-ops.js`, `task-outcome-drift-watchdog.js`, `predictions.js`, `resolve-due-predictions.js`, `action-trust.js`, `ingest-prompt.js`, `audit-prompt.js`, `lint-checks.js`; `cognition/memory/store.js` (resilient-by-design — `keep`), `archive.js` *(document)*, `episodes.js`, `rules.js`, `chronicle.js`, `decay.js`, `scope-registry.js`, `edge-registry.js`, `kind-registry.js`, `habits.js`, `persona.js`, `foresight.js`, `attention.js`, `state_inference.js`, `tx.js`; `cognition/intuition/handler.js`, `entities.js`, `turn-classifier.js`, `inject.js`, `eval.js`, `engine.js`; `cognition/triggers/loader.js`; `cognition/discretion/handler.js`, `inbound-guard.js`; `cognition/briefing/feedback.js`; `cognition/telemetry/rollup.js`.
- **Runtime/install + hosts:** `runtime/install/manifest.js`, `current-state.js`, `seed-rules.js`, `agents-md-refresh.js`, `layout-migrator.js`; `runtime/hosts/claude-code.js`, `gemini.js`; `runtime/config/self-improvement-v2.js`; `runtime/cli/health.js` *(fix)*.

### Decisions

| Site | Classification | Rationale | Commit |
|---|---|---|---|
| `system/runtime/cli/health.js:38-61` (rollupFacultyErrors) | fix | DB query failures previously swallowed; faculty rollup falsely reported clean. Now surfaces a `faculty_rollup` row with `status: 'fail'` and `error.message`. | 57b511b |
| `system/runtime/cli/health.js:63-73` (rollupPendingTriggers) | fix | Same — silent fail returned count=0/status=ok; now returns status=fail + error. | 57b511b |
| `system/runtime/cli/health.js:75-87` (rollupStaleDream) | fix | Distinguish "never ran" (warn) from "query failed" (fail). | 57b511b |
| `system/runtime/cli/health.js:126-155` (rollupStateInference) | fix | Telemetry failure now bumps status to `fail` and attaches `error` to the rollup. | 57b511b |
| `system/io/mcp/tools/explain-learning.js:9-47` (fetchMemo/fetchRule/fetchPrediction) | fix | DB error vs not_found ambiguity made debugging recall failures impossible. Primary fetches now propagate DB errors; only the secondary source-event lineage hydration degrades quietly. | c8018cd |
| `system/io/mcp/tools/explain-playbook.js:9-16` (fetchMemo) | fix | Same DB-error-vs-not-found fix as explain-learning. fetchCitedRules keeps its tolerant catch (deleted rule is acceptable). | 6e10c8b |
| `system/io/mcp/tools/record-correction.js:52-66` (rule retractability guard) | fix | Fail-closed on guard read. A DB error during the not_retractable check previously allowed the correction through, bypassing the guard. Now propagates the error. | 103e65d |
| `system/cognition/memory/archive.js:56-77` (edge-copy catch) | document | Edge-copy failure is fail-soft while the subsequent DELETE runs unconditionally — flagged as known risk in the comment. Acceptable today (edges largely re-derivable), worth flipping fail-closed if retention rules tighten. | a52ad5c |
| `system/runtime/daemon/cadence-consumer.js:48-55` (stale-pending UPDATE) | document | Empty catch acknowledged: next tick retries, consume SELECT still picks up the rows in age order. No data loss. | 26b0026 |
| `system/cognition/jobs/cost-monitor.js:142-164` (queryCostUsd Source 2 fallback) | document | Documented as informational-tier: cost=$0 when both telemetry sources fail. Long telemetry outages will surface via db.* invariants, so cost-monitor isn't the sole signal. | 073a99b |
| `system/cognition/jobs/runner.js` (notify-failures, in_flight clear) | keep | Documented in CLAUDE.md "Job stays wedged" — finally clause re-clears in_flight; notify is best-effort. | — |
| `system/cognition/jobs/scheduler-ext.js:38-42,49-51` (tracking writes) | keep | "Tracking is best-effort. A failed write must not turn a successful tick into a failure" — explicit contract. | — |
| `system/runtime/invariants/runner.js:99-101,269-272` (enabled gate catches) | keep | Documented: broken `inv.enabled()` gate must not block the runner; "skip" is the safe default for an unknown probe result. | — |
| `system/runtime/invariants/index.js:102-105,112-114,126-128` (manifest scan) | keep | Documented in the function comment — one broken integration must not block discovery of the others. | — |
| `system/runtime/daemon/heartbeat.js:38-41,45-49` (gate/tick) | keep | Module docstring documents the catch-and-log contract. | — |
| `system/runtime/daemon/heartbeat.js:74` (Promise.allSettled drain) | keep | Drains tick promises that have already self-logged; results discarded by design. | — |
| `system/runtime/invariants/runner.js:175` (Promise.allSettled heartbeat) | keep | Per-invariant outcome read out of `settled[i]` immediately after — not discarded. | — |
| `system/io/hooks/dispatcher.js:46-48,68-75` | keep | Hook outer catch documented as fail-soft because hooks run inside host stdio. ROBIN_DEBUG-gated surfacing exists. | — |
| `system/io/capture/record-event.js:77-91` (embedding failure) | keep | The canonical resilient-by-design catch documented in CLAUDE.md. Reverting it re-introduces InternalError to MCP clients. | — |
| `system/cognition/memory/store.js:98-102,162-166,820-826` (embedding writes) | keep | Same resilient-by-design pattern, applied to memos/entities. Comments explicitly cite recordEvent rationale. | — |
| `system/cognition/memory/store.js:386-399` (per-slice tx retry) | keep | Per-slice retry with TX-conflict handling; documented in the surrounding comment. | — |
| `system/cognition/memory/store.js:542-558` (getRecallConfig) | keep | runtime:recall row may legitimately be absent; HYBRID_DEFAULTS is the fallback. Prior silent throw was the bug; the new SELECT VALUE + catch is the fix. | — |
| `system/cognition/memory/store.js:611` (BM25 .catch) | keep | "Fail-soft — vector-only recall still works" — documented. | — |
| `system/cognition/intuition/handler.js:165-167,188-190,196-198` (host-side hook) | keep | Hook handler running in host stdio; must never throw. | — |
| `system/cognition/intuition/turn-classifier.js:99-101,199-200,275-276` | keep | Gate/classifier failures default to "don't classify" — fail-open documented. | — |
| `system/cognition/jobs/embeddings-ops.js:126-128` | keep | Catches per-surface table-missing → records `gaps[]` entry with error. Surfaced. | — |
| `system/cognition/triggers/loader.js:47-49,75-77,141-144,199-200` | keep | Per-expression / per-query / per-trigger best-effort; errors collected or returned as `false`/`null` to keep loading robust. | — |
| `system/runtime/daemon/cadence-consumer.js:35-37,128-...` | keep | countSince fallback to 0 is informational; error-path writes telemetry row before continuing. | — |
| `system/runtime/daemon/boot.js:129-...,155-156,163-166,238-240,322-340` | keep | Each catch logs explicitly; daemon boot continues so one bad integration doesn't lock everyone out. | — |
| `system/runtime/daemon/lock.js:7-10,69-80,99,109-112` | keep | Lock-acquisition: EPERM-detect, race-resolution, idempotent unlink. All correct. | — |
| `system/runtime/daemon/mcp-sse.js:51-...` | keep | Tool-error sanitisation before sending to MCP client — comment is detailed. | — |
| `system/runtime/daemon/retry.js:20-30` | keep | Inner onRetry catch is best-effort callback notification. Lock-step retry pattern. | — |
| `system/runtime/daemon/tools.js:99-101,148-150` | keep | session-id read fallback null; integration tool-factory failure warn+skip. | — |
| `system/runtime/daemon/introspection.js:136-139` | keep | "does not exist" branch returns null; other errors re-throw. | — |
| `system/runtime/daemon/routes/intuition.js:25-28` | keep | Best-effort prior-assistant lookup. Caller treats null as no prior. | — |
| `system/runtime/daemon/routes/session.js:21-24` | keep | introspection_findings hydration fallback to []. Bounded to one route. | — |
| `system/runtime/daemon/routes/biographer.js:71-74,202-207,235-238,242-245,258-261,277-280` | keep | Each catch explicitly logs with the failed event_id; "Never block the biographer pipeline on correction-inference failure" is stated. | — |
| `system/runtime/daemon/routes/remember.js:27-36` | keep | Outer catch differentiates PII vs internal error and shapes the response envelope. Inner accumulator catch logs and continues. | — |
| `system/runtime/invariants/*` (all enabled/check/repair catches) | keep | Each invariant's catches match the documented `{ok:false, error}` or `{repaired:false, error}` contract. | — |
| `system/runtime/cli/commands/*.js` (CLI-level catches) | keep | All catches surface a user-facing error message and either set process.exitCode or exit explicitly. | — |
| `system/runtime/install/*.js` (current-state, manifest, seed-rules, agents-md-refresh, layout-migrator) | keep | ENOENT and not-yet-installed branches return null/[]; install errors propagate. | — |
| `system/runtime/hosts/{claude-code,gemini}.js` | keep | Spawn-error reject, kill-after-exit ignore — standard subprocess pattern. | — |
| `system/io/integrations/gmail/sync.js:51-82` | keep | history_expired → first-sync fallback (documented contract). Other errors re-throw. | — |
| `system/io/integrations/gmail/tools/*.js,calendar-get-event.js` | keep | Missing-secret error translated to actionable hint; other errors re-throw. | — |
| `system/io/mcp/tools/audit.js:90-97` | keep | parseLLMVerdict: unparseable JSON yields `<llm output unparseable>` summary. | — |
| `system/io/mcp/tools/browser.js:31,50-52,67-72,131,140-142,196` | keep | Pool teardown ignores; URL parse fail → fail-closed (block); selector-level error attached to result. | — |
| `system/io/mcp/tools/explain-recall.js:47-49` | keep | Per-hit scope hydration: hit included without scope on failure (vs. dropping all hits). | — |
| `system/io/mcp/tools/macos-notify.js` | keep | Backend chain: terminal-notifier → osascript → fail with error. | — |
| `system/io/mcp/tools/recall.js:128-130` | keep | "recall_log write is advisory — never fail the recall on telemetry errors" — comment in place. | — |
| `system/io/mcp/tools/run-biographer.js:38-43` | keep | Fire-and-forget contract; .catch logs the enqueue failure. | — |
| `system/data/db/migrate.js`, `data/db/backup.js` | keep | All catches ENOENT or stat-fall-through; rest propagate. | — |
| `system/runtime/cli/commands/dream-run.js,recall-eval.js,...` (host/db open) | keep | Failure exits with code 3 and a stderr message. | — |
| `system/runtime/daemon/job-hot-reload.js:48-51,73-76,87-91` | keep | Watcher attach + signal-self failures logged; "already-closed" branches ignored. | — |
| `system/runtime/daemon/dispatcher-tick.js:127-129,147-149` | keep | "No active profile yet" silent-skip is documented; per-item .catch logs. | — |
| `system/cognition/biographer/upsert-entity.js:71-72` | keep | "Stage 2 is best-effort during the schema-redesign transition" — explicit comment. | — |
| `system/io/publish/blob.js:43,82` | keep | not-found-as-success for `head` / `del` are idempotent semantics documented in the comments. | — |
| `system/io/publish/orchestrate.js:73,383` | keep | Source-file stat failure → null path branch; blob delete idempotent. | — |
| `system/runtime/daemon/cadence-consumer.js:20-22` (mark) | keep | Best-effort log; the next consume reads pending rows and retries. | — |

## A.2 Dead-code + unused-file purge

### Inventory

(populated by A.2 tasks)

### Decisions

| Item | Decision | Rationale | Commit |
|---|---|---|---|

## A.3 Test gaps + slow-test cleanup

### Inventory

(populated by A.3 tasks)

### Decisions

| Module / Test | Decision | Rationale | Commit |
|---|---|---|---|

## A.4 Observability + invariant hardening

### Baseline metrics

See `docs/superpowers/notes/2026-05-17-polish-phase-a-log-baseline.md`

### Logger module + selective conversions

| Site | Event class | Commit |
|---|---|---|
| `system/runtime/log/index.js` (module + test) | n/a — primitive | `9e23b10` |
| `system/runtime/daemon/heartbeat.js` (gate + tick throw) | `scheduler.gate_failed`, `scheduler.tick_failed` | `7b17d1e` |
| `system/runtime/daemon/dispatcher-tick.js` (item + __dream__ dispatch catch) | `scheduler.dispatch_failed` | `fd8e453` |
| `system/io/integrations/_framework/run-sync.js` (finally-cleanup) | `integration.sync_cleanup_failed` | `d656892` |
| `system/cognition/jobs/scheduler-ext.js` (tracking writes + bad-schedule) | `scheduler.tracking_write_failed`, `jobs.bad_schedule` | `ef30e1b` |

Rate-limit refusals NOT converted: `system/io/outbound/rate-limit.js` does not
log refusals — it returns structured `{ok:false, reason:'rate_limited'}` to
callers. No log site to convert.

Embedder failure paths NOT converted: `system/data/embed/factory.js` is on the
cognition-e1 exclude list. Filed to "Open for cognition-e1 lane" below.

Reauth (proactive + reactive) NOT converted: `system/data/db/client.js` is on
the cognition-e1 exclude list. Filed below.

### Log noise decisions

| Pattern | Count | Classification | Action | Commit |
|---|---|---|---|---|
| Task 29 (broad noise reduction pass) | n/a | deferred | Task 5 baseline came back empty (helper bug, see "known issue" below). Deltas can't be measured until the helper is rewritten. Bridged to Phase B. | — |

### Invariant coverage decisions

Mirrors spec A.4 invariant coverage table. `[A]` = added this lane.

| Bug class | Existing invariant | New invariant? | Detect-only first? | Status (Phase A) |
|---|---|---|---|---|
| ESM cache drift | none | `runtime.hot_reload_watcher_active` `[A]` | yes | shipped detect-only (`bd6e8e3`) |
| Job in_flight wedge | `scheduler.no_stuck_in_flight` ✓ | — | — | n/a |
| `.robin-home` pointer | `install.pointer_present` ✓ | — | — | n/a |
| LM pending↔cleared dupes | `integrations.lunch_money_no_dupes` ✓ | — | — | n/a |
| plist KeepAlive loop | structural fix shipped | not invariant-able | — | rationale documented (no daemon-readable post-fix signal) |
| SurrealDB anon access | `db.authenticated` ✓ | — | — | n/a |
| pnpm Node mismatch | `runtime.node_version_pinned` ✓ | — | — | n/a |
| Orphan `node --test` procs | `runtime.no_orphan_node_test_procs` ✓ | — | — | n/a |
| MCP wiring race | `mcp.wiring_*` ✓ | — | — | n/a |
| Multi-agent git-index race | none | not invariant-able | — | warning shipped in `.githooks/pre-commit` (`1ab07a8`) |
| Embedder load staleness | `db.embedder_profile_match` ✓ | `daemon.embedder_load_age` `[A]` | yes | shipped detect-only (`e0d8e1c`); probe writer filed to e1 lane |
| Reauth handler post-reconnect | `db.authenticated` (reactive) | `mcp.daemon_authenticated_after_reconnect` `[A]` | yes | shipped detect-only, weekly cadence (`a0f676c`) |

Schema extension: invariant interface accepts an optional `remediation: string | string[]`
field (`52603b7`). Phase B will tighten to required + backfill all existing invariants.

Doctor `--health --json` schema snapshot test landed at `system/tests/unit/doctor-json-schema.test.js` (`9fdf9b2`).
NOTE: plan referenced `doctor --json`; reality is `doctor --health --json` produces
the JSON envelope. Locked-in keys: `exit_code`, `ts`, `budget`, `faculties`, `pending`,
`dream`, `state_inference`, `pending_recall_log`. Test gated behind `ROBIN_SKIP_SLOW`
since it spawns the CLI subprocess.

### A.4 known issue carried from Task 5

The active-traffic helper at `system/scripts/log-baseline-traffic.js`
invokes a CLI subcommand `robin recall` that does not exist (and uses
JSON-as-arg for `robin remember` which actually accepts positional
content). Result: both 3-min captures in the initial baseline
(`docs/superpowers/notes/2026-05-17-polish-phase-a-log-baseline.md`)
returned zero log lines. **Tasks 29 (log noise reduction pass) and 30
(re-baseline + delta check) are deferred to Phase B carryover** — the
baseline can't be compared against itself when it was empty. Helper
rewrite is filed below.

## Open for cognition-e1 lane

| File | Finding | Suggested fix |
|---|---|---|
| `system/data/embed/factory.js` | A.4 needs a daily synthetic-embed probe to drive `daemon.embedder_load_age`. Currently the invariant ships detect-only and reports `no_probe_record` until wired. | Wire a probe writer: on each daily heartbeat, embed a 1-token sentinel string and UPSERT `runtime_state:embed_probe` with `last_success_ts`. The invariant already reads from that row. |
| `system/data/db/client.js` | Reauth proactive + reactive paths still use `console.warn` for diagnostic logging. Spec lists these as logger-conversion targets. | Convert `console.warn("[db] reauth …")` etc. to `log.warn({event:'db.reauth_*', …})` using `system/runtime/log/index.js`. |
| `system/runtime/daemon/server.js` (prompt-injection lane) + ctx wiring | `mcp.daemon_authenticated_after_reconnect` invariant probes weekly but cannot tell whether a workload is in flight; `ctx.activeQueryCount` is currently undefined (treated as 0). | Surface an `activeQueryCount` counter from `db/client.js` through `ctx` so the invariant can skip during real traffic. |
| `system/runtime/daemon/server.js` (prompt-injection lane) | `startJobHotReload` now accepts an optional `db` parameter that writes `runtime:hot_reload_watcher` state. Caller does not pass `db` today — so the new `runtime.hot_reload_watcher_active` invariant will report `watcher_not_registered`. | Pass the daemon's `db` handle to `startJobHotReload({…, db})` in server.js when constructing the watcher. |

## Open for prompt-injection lane

| File | Finding | Suggested fix |
|---|---|---|

## Open for user

| Item | Question | Recommended action |
|---|---|---|

## Won't fix

| Item | Rationale |
|---|---|

## Bridge to Phase B

_Priority enum: `high` (blocker for Phase B) / `med` (do early) / `low` (do later)._

| Phase B target | Type | Provenance | Priority |
|---|---|---|---|
| Tighten `remediation` field on invariant schema to required; backfill existing invariants | invariant-schema | A.4 (`52603b7`) | med |
| Doctor display must render `daemon.embedder_load_age`, `runtime.hot_reload_watcher_active`, `mcp.daemon_authenticated_after_reconnect` with their `remediation` hints | doctor-display | A.4 | med |
| Rewrite `system/scripts/log-baseline-traffic.js` to use real CLI surfaces (`hot`, `jobs run`, correct `remember` signature); then re-baseline + delta check (Tasks 29-30 carryover) | log-baseline | A.4 (Task 5 known issue) | med |
| Promote `daemon.embedder_load_age`, `runtime.hot_reload_watcher_active`, `mcp.daemon_authenticated_after_reconnect` out of detect-only after 7 days of clean runs | invariant-promotion | A.4 | low |
| Add `repair` actions for the three new detect-only invariants once promoted | invariant-repair | A.4 | low |
