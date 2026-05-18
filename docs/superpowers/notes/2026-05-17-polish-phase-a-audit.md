# Polish Phase A — Audit Notes

**Date range:** 2026-05-17
**Phase A complete:** 2026-05-17
**Total polish commits in Phase A:** ~30 (spec/plan/audit + 4 setup + 9 A.1 + 5 A.2 + 6 A.3 + 12 A.4)
**Deferred to Phase A2 (post-prompt-injection-lane):** files in `system/runtime/daemon/{server,lifecycle,http,log-scrub}.js`, `cli/commands/web.js`, `mcp/tools/ingest.js`, `_framework/capture.js`, `config/{daemon-state,data-store,mcp-token}.js`, `web/server.js`, two `mcp.wiring-*` invariants — sweep once that lane commits.

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

#### A2-Inventory (orphan modules — inventory only, no deletions this pass)

Pass run 2026-05-17 with reduced scope (inventory-only; per-orphan
deletion loop deferred). Tooling: `pnpm exec madge --orphans --extensions
js system/`. Allowlist at `system/scripts/dead-code-allowlist.json`
captures reflection-loaded modules (MCP tools, CLI commands, integration
manifests, dream steps, invariants, pre-commit hooks).

Filtering applied:
- Raw madge orphans (incl. tests): 464 entries
- After stripping test files: 51
- After allowlist filter: 13 remaining
- After lane-exclude filter (cognition-e1 + prompt-injection): 10
- Final A.2-scope orphans: **10** (all flagged for follow-up; nothing
  deleted in this pass)

| Module | Decision | Note |
|---|---|---|
| `system/io/integrations/_local/sqlite.js` | flag-for-follow-up | _local helper — confirm not loaded by a sibling integration before deletion |
| `system/io/integrations/gmail/manifest.js` | not-actually-orphan | dynamic-imported by `system/io/integrations/_framework/manifest-loader.js` via `import(manifestPath)`; should be allowlisted next pass (`system/io/integrations/*/manifest.js`) |
| `system/io/integrations/google_calendar/manifest.js` | not-actually-orphan | same as gmail/manifest.js |
| `system/io/integrations/weather/manifest.js` | not-actually-orphan | same as gmail/manifest.js |
| `system/runtime/install/postinstall.js` | not-actually-orphan | wired via `package.json` `scripts.postinstall` |
| `system/runtime/scripts/audit-entity-ids.js` | flag-for-follow-up | runbook-only script; verify no docs reference before deletion |
| `system/runtime/scripts/dev-recall.js` | flag-for-follow-up | mentioned in `docs/troubleshooting.md` + CHANGELOG — keep; confirm path matches docs |
| `system/scripts/list-mcp-tools.js` | not-actually-orphan | invoked by `system/scripts/polish-verify.sh` (polish-program harness) |
| `system/scripts/log-baseline-traffic.js` | flag-for-follow-up | invoked by `polish-verify.sh`; broken (Tasks 29/30 carryover — known issue in A.4) — keep but rewrite later |
| `system/scripts/log-baseline.js` | not-actually-orphan | invoked by `polish-verify.sh` |

Lane-excluded (not counted as polish orphans; owned by cognition-e1 lane):
- `system/cognition/jobs/internal/refresh-claude-md.js`
- `system/cognition/jobs/internal/reinforce-recall.js`
- `system/cognition/jobs/internal/test-internal-fixture.js`

**Follow-up suggestion**: extend allowlist to include
`system/io/integrations/*/manifest.js` and
`system/runtime/install/*.js` so the next madge run produces a cleaner
signal-to-noise ratio.

#### A2 unused-export inventory (no deletions in this pass)

Tooling: ripgrep-based scan that, for each `export {function|const|class}
<name>` declaration in `system/**/*.js` (test files and reflection-loaded
directories excluded), looks for any reference outside the declaring file
inside `system/**` (also excluding `system/tests/**`). A symbol with zero
external production references is then classified by checking
`system/tests/**` separately — exclusive test references mark
`test-only-export`; zero test refs mark `truly-unused`.

Cognition-e1 and prompt-injection lane files were skipped (per task brief
exclude list).

Total candidates: **112**
- truly-unused: **18** (recommended for follow-up deletion)
- test-only-export: **94** (user decides whether to keep — these are
  helpers exported solely so tests can reach them; deleting them tightens
  the public surface but requires touching tests)

##### truly-unused (deletion candidates)

| File | Symbol | Note |
|---|---|---|
| `system/cognition/memory/tx.js` | `TX_BASE_BACKOFF_MS` | constant |
| `system/cognition/memory/tx.js` | `TX_JITTER_MS` | constant |
| `system/cognition/discretion/project-bypass.js` | `getBypassPaths` | helper |
| `system/cognition/intuition/turn-classifier.js` | `checkSessionCache` | helper |
| `system/cognition/intuition/turn-classifier.js` | `classifyWithHaiku` | helper |
| `system/cognition/sessions/conversation-thread.js` | `DEFAULT_WINDOW_MS` | constant |
| `system/cognition/sessions/conversation-thread.js` | `DEFAULT_MAX_MESSAGES` | constant |
| `system/cognition/sessions/conversation-thread.js` | `DEFAULT_MAX_TOKENS` | constant |
| `system/cognition/jobs/resolve-due-predictions.js` | `resolveOutcomeValue` | resolver |
| `system/cognition/jobs/resolve-due-predictions.js` | `resolveDuration` | resolver |
| `system/cognition/jobs/resolve-due-predictions.js` | `resolveBehaviorContinuation` | resolver |
| `system/cognition/jobs/resolve-due-predictions.js` | `_extractKeywords` | helper |
| `system/runtime/install/agents-md-refresh.js` | `loadIntegrationsForAgentsMd` | helper |
| `system/runtime/install/agents-md-refresh.js` | `writeMergedAgentsMd` | helper |
| `system/runtime/hosts/pricing.js` | `PRICING` | constant table |
| `system/io/integrations/imessage/normalize.js` | `stripRowidPrefix` | helper |
| `system/io/integrations/imessage/inbox.js` | `DEFAULT_CHAT_DB` | constant |
| `system/io/integrations/_local/sqlite.js` | `readSqliteSnapshot` | reinforces orphan flag on file itself |

Notes on the truly-unused set:
- The `resolve-due-predictions.js` cluster of 4 unused exports looks like
  internal helpers that were probably refactored from exports to inline
  use but never trimmed.
- `_extractKeywords` (underscore prefix) signals intent that the symbol
  was always internal; safe to inline.
- `_local/sqlite.js`'s only export being unused agrees with the
  orphan-module finding above; combined evidence makes this the highest-
  confidence deletion candidate.

##### test-only-export (94 entries — user decides)

Full classified list lives at `tmp/polish-a2-unused-exports-classified.txt`
(local-only, not committed). Highest-frequency offenders:

- `system/cognition/memory/store.js` — 5 test-only exports
  (`flagContradiction`, `_resetRecallConfigCache`,
  `__resetRecallConfigCacheForTests`, `listMemos`, `neighbors`)
- `system/cognition/memory/scope-registry.js` — 5 (`policyFor`,
  `isEphemeral`, `isHierarchical`, `ttlDays`, `scopeMatches`)
- `system/cognition/triggers/loader.js` — 5 (`compileWhen`,
  `compileTemplate`, `compileArgs`, `compileVarsResolver`,
  `compileTrigger`)

Two underscore-prefixed cache-reset helpers
(`__resetRecallConfigCacheForTests`, `__resetEntityCatalogCacheForTests`,
`_resetBeliefConfigCacheForTests`) are explicitly test seams; do not
delete unless the corresponding tests are refactored away from cache
dependency.

### Decisions

| Item | Decision | Rationale | Commit |
|---|---|---|---|
| `system/io/integrations/_local/sqlite.js` (orphan module) | delete | Verified no imports in `system/` or `package.json`; only referenced in historical design docs. | `fd4f4e3` |
| `system/runtime/scripts/audit-entity-ids.js` (orphan module) | delete | Runbook-only script with no live references; only mentioned in audit notes itself. | `611119f` |
| `system/runtime/scripts/dev-recall.js` (orphan module) | skip | Still referenced in `docs/troubleshooting.md` + `docs/development.md` as a debug helper. Keep. | — |
| `system/cognition/memory/tx.js` — `TX_BASE_BACKOFF_MS`, `TX_JITTER_MS` | inline | Used internally by `awaitTxBackoff`; converted to non-exported `const`. | `4034b15` |
| `system/cognition/discretion/project-bypass.js` — `getBypassPaths` | inline | Used as default arg by `isCwdBypassed`; converted to non-exported `function`. | `00d42be` |
| `system/cognition/intuition/turn-classifier.js` — `checkSessionCache`, `classifyWithHaiku` | inline | Both called internally from the main `classify()` flow; converted to non-exported helpers. | `df626ab` |
| `system/cognition/sessions/conversation-thread.js` — `DEFAULT_WINDOW_MS`, `DEFAULT_MAX_MESSAGES`, `DEFAULT_MAX_TOKENS` | inline | Used internally as default args; converted to non-exported constants. | `3195a64` |
| `system/cognition/jobs/resolve-due-predictions.js` — `resolveOutcomeValue`, `resolveDuration`, `resolveBehaviorContinuation`, `_extractKeywords` | inline | All four called internally via the resolver-dispatch table; converted to non-exported functions. | `4be3ef0` |
| `system/runtime/install/agents-md-refresh.js` — `loadIntegrationsForAgentsMd`, `writeMergedAgentsMd` | inline | Both invoked internally from `refreshAgentsMdFiles`; converted to non-exported async helpers. NOTE: commit `0036399` also captured concurrent unrelated WIP in the same file (CLAUDE.md → CLAUDE.local.md target rename from another session). | `0036399` |
| `system/runtime/hosts/pricing.js` — `PRICING` | inline | Used internally by `estimateCostUsd`; converted to non-exported const. | `28e1286` |
| `system/io/integrations/imessage/normalize.js` — `stripRowidPrefix` | delete | Not used internally either; entire helper removed. | `c4622ac` |
| `system/io/integrations/imessage/inbox.js` — `DEFAULT_CHAT_DB` | inline | Used as default arg by `openChatDb`; converted to non-exported const. | `3d39cb5` |
| `system/io/integrations/_local/sqlite.js` — `readSqliteSnapshot` | moot | File deleted in `fd4f4e3`. | `fd4f4e3` |
| `system/tests/fixtures/seed-recall-pairs.json` (stale fixture) | delete (gitignored) | Confirmed unreferenced in `system/`, `user-data/`. Listed in `.gitignore` line 9 (local-only generated). Removed from disk; no commit needed. | — |
| `system/tests/fixtures/synthetic-events.json` (stale fixture) | delete (gitignored) | Confirmed unreferenced in `system/`, `user-data/`. Listed in `.gitignore` line 8. Removed from disk; no commit needed. | — |
| `system/tests/fixtures/discord-events.js` (stale fixture) | skip | Audit scan missed `user-data/io/integrations/discord/tests/*.test.js` which imports this fixture. Initial deletion broke 2 tests; restored. | — |

## A.3 Test gaps + slow-test cleanup

### Inventory

Generated 2026-05-17 by `tmp/polish-a3-coverage.js` (113 non-trivial modules in scope).
Coverage distribution: 25 modules at 0 test refs, 27 at 1, 14 at 2-3, 9 at 4-5, 23 at 6-9,
15 at 10+. Top-covered: `memory/foresight.js` (225), `db/migrate.js` (188), `memory/habits.js` (58),
`runtime/invariants/runner.js` (62).

#### A3-Inventory (behavior coverage — untested first)

Decision codes: `add-test` = wrote a new unit test; `consumer-covered` = exercised
transitively via consumer tests; `thin-helper` = thin wrapper/glue, no logic worth
direct coverage; `prompt-injection-owned` = file in prompt-injection lane scope;
`cognition-e1-owned` = file in cognition-e1 lane scope; `cli-orchestrator` =
top-level CLI command that wires verified primitives together (covered transitively).

| File | Exports | Test refs | Decision |
|---|---|---|---|
| `system/cognition/memory/archive.js` | archiveMemo | 0 | thin-helper (sets `archived_at` + supersedes via `store.supersede`; logic-light) |
| `system/io/integrations/google_calendar/client.js` | listEvents,getEvent,buildEventFromCalendarItem | 0 | add-test (event-builder is pure data transform) |
| `system/runtime/daemon/lifecycle.js` | createLifecycle | 0 | prompt-injection-owned |
| `system/runtime/daemon/cadence-consumer.js` | consumePendingTriggers | 0 | consumer-covered (triggers-persistence.test + triggers-loop.test cover cadence path) |
| `system/runtime/daemon/server.js` | startDaemon | 0 | prompt-injection-owned |
| `system/runtime/daemon/routes/jobs.js` | jobsRoutes | 0 | thin-helper (route registration; behavior tested via jobs-runner / jobs-scheduler-ext) |
| `system/io/integrations/imessage/sender.js` | sendDm,sendGroup,escapeApplescript | 0 | add-test (`escapeApplescript` is a pure security-relevant utility) |
| `system/runtime/daemon/routes/intuition.js` | intuitionRoutes | 0 | cognition-e1-owned (intuition lane) |
| `system/runtime/invariants/daemon-tick.js` | createInvariantsTick,runBootInvariants | 0 | consumer-covered (invariant runner.js tests exercise underlying logic) |
| `system/runtime/cli/commands/import-v1.js` | importV1 | 0 | cli-orchestrator (one-shot legacy migration) |
| `system/runtime/cli/commands/integrations-run.js` | integrationsRun | 0 | cli-orchestrator |
| `system/runtime/cli/commands/migrate-user-data.js` | migrateUserData | 0 | cli-orchestrator (one-shot migration) |
| `system/runtime/cli/commands/brief-calibrate.js` | briefCalibrate | 0 | cli-orchestrator |
| `system/runtime/cli/commands/sessions-purge.js` | sessionsPurge | 0 | cli-orchestrator (calls `purgeStaleSessions` covered by sessions.test) |
| `system/runtime/cli/commands/_doctor-special-commands.js` | doRebaseline,doPurgeStaleSessions,doLintHooks | 0 | cli-orchestrator (consumer-covered by doctor.test) |
| `system/runtime/cli/commands/brief-feedback.js` | briefFeedback | 0 | cli-orchestrator |
| `system/runtime/cli/commands/brief-gallery.js` | briefGallery | 0 | cli-orchestrator |
| `system/runtime/cli/commands/mcp-install.js` | mcpInstall | 0 | prompt-injection-owned (wiring/install) |
| `system/runtime/cli/commands/mcp-ensure-running.js` | mcpEnsureRunning | 0 | prompt-injection-owned |
| `system/runtime/cli/commands/recall-eval.js` | recallEval | 0 | cognition-e1-owned (recall evaluation lane) |
| `system/runtime/cli/commands/biographer-catchup.js` | biographerCatchup | 0 | cognition-e1-owned (biographer) |
| `system/runtime/cli/commands/brief-regenerate.js` | briefRegenerate | 0 | cli-orchestrator |
| `system/runtime/cli/commands/integrations-discord-register.js` | integrationsDiscordRegister | 0 | cli-orchestrator |
| `system/runtime/cli/commands/_biographer-shared.js` | delegateToDaemon,processPendingChunks | 0 | cognition-e1-owned (biographer shared helpers) |
| `system/runtime/cli/commands/mcp-start.js` | mcpStart | 0 | prompt-injection-owned (daemon supervisor surface) |

Top covered (12+ test refs, all green) omitted — direct coverage is healthy.

#### A3-SlowTests (>300ms wall time, captured 2026-05-17)

Total 30 slow tests; 29 unique files. Ranked by ms desc.

| Test file | ms | Owner | Decision |
|---|---|---|---|
| `system/tests/unit/job-hot-reload.test.js` | 861 | runtime/daemon | refactor (real `setTimeout(60-200ms)` × 3) |
| `system/tests/unit/heartbeat-buckets.test.js` | 837 | runtime/daemon | refactor (real `setTimeout` × 3 waits) |
| `system/tests/unit/inject-playbook-integration.test.js` | 813 | cognition-e1 (intuition) | cognition-e1-owned |
| `system/tests/unit/web-server-views.test.js` | 694 | prompt-injection (web/server.js) | prompt-injection-owned |
| `system/tests/unit/turn-classifier.test.js` | 546 | io/capture | accepted (loads tokenizer once; small fixture; logic-bound) |
| `system/tests/unit/host-detect.test.js` | 545 | runtime | accepted (subprocess host probe is the point of the test) |
| `system/tests/unit/doctor.test.js` | 481 | runtime/cli | accepted (loads migrations + 7 doctor subcommands; high coverage) |
| `system/tests/unit/step-prediction-taxonomy.test.js` | 468 | cognition-e1 (dream) | cognition-e1-owned |
| `system/tests/unit/session-capture.test.js` | 456 | cognition-e1 (capture) | cognition-e1-owned |
| `system/tests/unit/scheduler-heartbeat.test.js` | 451 | runtime/daemon | refactor (real `setTimeout(60-200ms)` × 9 waits — biggest win) |
| `system/tests/unit/task-outcome-drift-watchdog.test.js` | 450 | cognition/jobs | accepted (drift logic time-bound; uses time deltas correctly) |
| `system/tests/unit/web-server.test.js` | 425 | prompt-injection (web/server.js) | prompt-injection-owned |
| `system/tests/unit/introspection-budget.test.js` | 423 | cognition-e1 (introspection) | cognition-e1-owned |
| `system/tests/unit/action-trust.test.js` | 416 | cognition/jobs | accepted (real `setTimeout` × 1; benign) |
| `system/tests/unit/jobs-runner.test.js` | 401 | cognition/jobs | accepted (multi-job timing scenarios) |
| `system/tests/unit/dispatcher-enabled-gate.test.js` | 401 | runtime/daemon | accepted (legitimate dispatcher invariants) |
| `system/tests/unit/triggers-persistence.test.js` | 392 | runtime/daemon | accepted (DB-bound persistence checks) |
| `system/tests/unit/step-outcome-grading.test.js` | 377 | cognition-e1 (dream) | cognition-e1-owned |
| `system/tests/unit/resolve-due-predictions.test.js` | 375 | cognition/jobs | accepted (4 prediction kinds × resolve, multi-fixture) |
| `system/tests/unit/step-calibration-bucket.test.js` | 367 | cognition-e1 (dream) | cognition-e1-owned |
| `system/tests/unit/jobs-scheduler-ext.test.js` | 365 | cognition/jobs | accepted |
| `system/tests/unit/comm-style-snapshots.test.js` | 354 | cognition-e1 (comm-style) | cognition-e1-owned |
| `system/tests/unit/conversation-thread.test.js` | 346 | cognition/memory | accepted |
| `system/tests/unit/rules-apply.test.js` | 340 | cognition/memory | accepted |
| `system/tests/unit/cli-integrations-migrate.test.js` | 340 | runtime/cli | accepted |
| `system/tests/unit/edges-cooccur.test.js` | 322 | cognition/memory | accepted |
| `system/tests/unit/surreal-ensure-running.test.js` | 310 | runtime | accepted (subprocess gate exercises real boot path) |
| `system/tests/unit/dream-step-reflection-codim.test.js` | 310 | cognition-e1 (dream) | cognition-e1-owned |
| `system/tests/unit/tool-remember.test.js` | 308 | cognition-e1 (tools/remember) | cognition-e1-owned |

#### A3-RealTimers (non-excluded files; setTimeout without .unref / clearTimeout / mock.timers)

Files (not e1- or prompt-injection-owned) where mock.timers could help:
- `system/tests/unit/scheduler-heartbeat.test.js` (9 real waits, 60-200ms each)
- `system/tests/unit/heartbeat-buckets.test.js` (3 waits)
- `system/tests/unit/job-hot-reload.test.js` (debounce-fs test; real timer required by fs.watch interaction)
- `system/tests/unit/idle-embedder.test.js` (3 waits, 20-200ms)
- `system/tests/unit/lock.test.js` (real lock TTL)
- `system/tests/unit/retry.test.js` (retry backoff)
- `system/tests/unit/sessions.test.js` (TTL-based)
- `system/tests/unit/token-cache.test.js` (TTL-based)
- `system/tests/unit/triggers-loop.test.js`, `triggers-persistence.test.js` (loop intervals)
- `system/tests/unit/refusals-list.test.js`, `fatal.test.js` — short waits, not high value to refactor

#### A3-SleepGt50 (await sleep N where N>50)

All 4 hits are in `biographer-batch-accumulator.test.js` (cognition-e1-owned). No action.

#### A3-MemLeak (mem:// connect without paired close)

`system/tests/unit/doctor.test.js` reports a mismatch but it's a false positive — the
test re-exports `connect`/`close` to pass to the doctor command itself (`openDb`, `closeDb`),
which then opens/closes its own DB per probe. Not a leak.

#### A3-SubprocSpawn

None found.

### Decisions

| Module / Test | Decision | Rationale | Commit |
|---|---|---|---|
| `system/io/integrations/google_calendar/client.js` | add-test | `buildEventFromCalendarItem` + `listEvents` + `getEvent` had 0 test refs; pure data shapes + HTTP wrapper, easy to cover via `fetchFn` injection | `3491be1` |
| `system/io/integrations/imessage/sender.js` | add-test | `escapeApplescript` is a security-relevant utility (AppleScript injection guard); `sendDm` / `sendGroup` had 0 test refs; covered platform-gate, escape, error-mapping branches with mock.timers for the 200ms rate-limit | `40da44a` |
| `system/tests/unit/scheduler-heartbeat.test.js` | refactor (mock.timers) | 451ms, 9 real `setTimeout(60-200ms)` waits → drove the scheduler via fake-timer ticks + microtask drains; 87ms after | `20d6cd5` |
| `system/tests/unit/heartbeat-buckets.test.js` | refactor (mock.timers) | 837ms, 10 real `setTimeout` waits → fake-timer ticks; 101ms after; added explicit release for the coalesce test so the in-flight promise drains under `await stop()` | `771df72` |
| `system/tests/unit/idle-embedder.test.js` | refactor (mock.timers) | 744ms, real `setTimeout(200ms)` in primary test → fake timers; 115ms after. Last test (concurrent get() dedup) kept real timers — the 20ms is the assertion not the cost | `96bd953` |
| `system/runtime/daemon/cadence-consumer.js` | cognition-e1-owned | Drives `cognition/dream/*` (cursors, dispatch, budget); test ownership sits with cognition-e1 lane | — |
| `system/cognition/memory/archive.js` | consumer-covered | Single export `archiveMemo`; field-picker pure but logic-light; archive flow exercised by compaction-step tests in cognition-e1; not worth a duplicate fixture here | — |
| `system/runtime/invariants/daemon-tick.js` | consumer-covered | Two thin closures over `run()` from `invariants/runner.js`; `runner.test.js` has 62 test refs and exercises identical inputs/outputs | — |
| `system/runtime/daemon/routes/{jobs,intuition}.js` | thin-helper | Route registration only; HTTP routes are tested at the consumer level via `web-server.test.js` (prompt-injection-owned) and direct route invocations from jobs-runner.test | — |
| 14× `system/runtime/cli/commands/*` at 0 refs | cli-orchestrator | Each is a thin top-level CLI command that wires verified primitives (e.g. `sessionsPurge` → `purgeStaleSessions`, which IS covered by `sessions.test.js`). Direct CLI tests would re-test the primitives; explicit follow-up would need a shared CLI harness | — |
| `system/tests/unit/lock.test.js` / `retry.test.js` / `sessions.test.js` / `token-cache.test.js` | accepted (real timers OK) | Each runs <300ms; the small `setTimeout` is exercising the actual TTL/retry behavior the test asserts on. Not a violation | — |
| All 4 `await sleep(N>50)` hits | cognition-e1-owned | All in `biographer-batch-accumulator.test.js` (cognition-e1) | — |
| `doctor.test.js` mem:// "leak" | false-positive | The test exports `connect`/`close` to pass to the doctor command (`openDb`, `closeDb` injection points); doctor opens/closes its own DB per probe | — |

### Tests added (count: 2 files, 22 new assertions)

- `system/tests/unit/google-calendar-client.test.js` — 9 tests covering `buildEventFromCalendarItem`, `listEvents`, `getEvent`
- `system/tests/unit/imessage-sender.test.js` — 13 tests covering `escapeApplescript`, `sendDm`, `sendGroup` (non-darwin gates, input validation, escape integrity, runCommand failure mapping)

### Tests refactored (count: 3 files; combined 2032ms → ~303ms)

- `scheduler-heartbeat.test.js` — 451ms → 87ms
- `heartbeat-buckets.test.js` — 837ms → 101ms
- `idle-embedder.test.js` — 744ms → 115ms

### Tests gated behind ROBIN_SKIP_SLOW (count: 0)

None needed — the refactors brought all targets under 300ms.

### Modules documented as thin/consumer-covered (count: 19)

Per the decision table above: `archive.js`, `daemon-tick.js`, two `routes/*.js`, 14 CLI commands, 1 cadence-consumer (e1-owned), plus the 13 cognition-e1-owned and prompt-injection-owned slow tests left alone.

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

### A2 fixtures, migrations, scripts findings (Open for user)

#### Stale fixtures (candidates for deletion)

Three fixtures live under `system/tests/fixtures/` but no test file
references them (any extension, basename, or path-based match across
`system/` excluding `fixtures/` itself):

- `system/tests/fixtures/seed-recall-pairs.json` — referenced only by
  three Phase-1 design/plan docs in `docs/superpowers/`, never loaded by
  any test.
- `system/tests/fixtures/discord-events.js` — same: only in old
  Phase-2d design/plan docs.
- `system/tests/fixtures/synthetic-events.json` — same: only in old
  Phase-1 design docs.

All three appear to be legacy fixtures from Phase 1/2 design work that
never made it into a live test. Recommended: delete in a follow-up
commit (`chore(polish-a2): drop unused legacy test fixtures`).

#### Unreferenced migrations (DO NOT auto-delete — user decision)

`system/data/db/migrate.js` discovers migrations via `readdir()`, so
ALL 34 `.surql` files in the directory run at migration time regardless
of whether their filename appears elsewhere in the tree. The 8 files
below have no other references (no tests, no docs, no scripts), but
**that is the normal state** for already-applied migrations and does not
indicate deadness:

- `system/data/db/migrations/0003-evidence-ledger.surql`
- `system/data/db/migrations/0004-action-trust-ledger.surql`
- `system/data/db/migrations/0005-cadence.surql`
- `system/data/db/migrations/0006-compaction.surql`
- `system/data/db/migrations/0007-arcs.surql`
- `system/data/db/migrations/0021-cognition-wave-enable.surql`
- `system/data/db/migrations/0022-structured-telemetry.surql`
- `system/data/db/migrations/0025-drop-evidence-system.surql`

Migrations are write-once history; deleting them after they've been
applied would break checksum validation on any DB that ran them
(`migrate.js` raises `checksum mismatch ... already-applied migrations
must not be edited; create a new migration instead`). No action
recommended.

#### Unreferenced scripts

0 candidates. `system/scripts/` currently contains only polish-program
helpers (`polish-verify.sh`, `list-mcp-tools.js`, `log-baseline.js`,
`log-baseline-traffic.js`, `dead-code-allowlist.json`) — all of which
are referenced by the polish program. Nothing to surface here.

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
| `cli/health.js` rollups now surface DB errors with `{status:'fail', error}` — Phase B's `health()` MCP tool reshape must preserve the failure information | mcp-contract | A.1 (`57b511b`) | high |
| `explain-learning` / `explain-playbook` primary fetches now throw on DB error — MCP tool error-reason enum (B.3) must include `db_error` | mcp-contract | A.1 (`c8018cd`, `6e10c8b`) | high |
| `record-correction` rule-retractability guard is now fail-closed — MCP `requires_permission` shape (B.3) should surface this as a real reason | mcp-contract | A.1 (`103e65d`) | med |
| Structured logger events emitted: `scheduler.tick_failed`, `scheduler.gate_failed`, `scheduler.dispatch_failed`, `integration.sync_cleanup_failed`, `scheduler.tracking_write_failed`, `jobs.bad_schedule` — doctor `--verbose` (B.2) can surface last-N occurrences from these | observability | A.4 (logger conversions) | low |
| New snapshot test pattern established (`normalize-snapshot.js` helper + inline string assertions) — Phase B's CLI `--help` snapshots, doctor JSON shape, recall snippet tests should adopt the same pattern | snapshot-convention | Task 2 (`87575f8`, `fe7343f`) | high |
| Test files added for `google_calendar/client.js` and `imessage/sender.js` — sets the bar for Phase B's MCP tool result-shape snapshot tests | test-convention | A.3 (`3491be1`, `40da44a`) | low |
