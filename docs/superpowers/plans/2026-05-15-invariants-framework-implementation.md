# Invariants Framework — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-15-invariants-framework-design.md`
**Date:** 2026-05-15

Five stages, each a logical commit. Stage 1+2 land first as the foundation; stages 3-5 layer on top.

## Stage 1 · Skeleton (this PR)

### Files to create

- `system/runtime/invariants/index.js` — registry manifest (empty array initially).
- `system/runtime/invariants/policy.js` — `BOOT_REPAIR_ALLOWLIST`, `CLI_BLOCKING_SET`.
- `system/runtime/invariants/state.js` — atomic read/write of `invariants-state.json`.
- `system/runtime/invariants/lock.js` — per-invariant repair lock with heartbeat.
- `system/runtime/invariants/runner.js` — `run({ trigger, options })` orchestrator.
- `system/runtime/invariants/policy-decisions.js` — `decideRepair(invariant, history)`.
- `system/runtime/invariants/ctx.js` — `makeCtx({ db, dbFactory, log, paths, trigger, dryRun })`.

### Path additions in `system/config/data-store.js`

```js
invariantsState: () => join(robinHome(), 'runtime', 'invariants-state.json'),
invariantsLocks: () => join(robinHome(), 'runtime', 'locks', 'invariants'),
divergenceLog: () => join(robinHome(), 'runtime', 'divergence_log.json'),
healthAlert: () => join(robinHome(), 'runtime', 'HEALTH_ALERT.md'),
```

### Tests

- `system/tests/unit/invariants/state.test.js` — atomic write, corrupt-file fallback.
- `system/tests/unit/invariants/lock.test.js` — acquire/release/stale-reclaim.
- `system/tests/unit/invariants/policy-decisions.test.js` — repair-policy thresholds.
- `system/tests/unit/invariants/runner.test.js` — phase ordering, allSettled isolation, cooldown from state, trigger semantics.
- `system/tests/helpers/invariant-fixtures.js` — `makeCtx`, `runOneInvariant`, `withTempStateFile`.

Stage 1 ships with empty `INVARIANTS = []`. No production code path calls the runner yet.

## Stage 2 · First invariant + flag wiring

### Files

- `system/runtime/invariants/install.pointer-present.js` — first concrete invariant.
- `system/tests/unit/invariants/install.pointer-present.test.js`.
- Add `runtime:invariants.config.enabled` config flag handling.
- Wire runner invocation into daemon heartbeat (only when flag is `'shadow'` or `true`).
- Wire runner invocation into daemon boot (only when flag is `true`).
- Add `--diff-legacy` flag to doctor (only operative on `install.pointer_present` for stage 2).
- Add `system/runtime/invariants/divergence-log.js` — append-only divergence persistence.

Stage 2 ships with the flag defaulting to `false`. Manually flip to `'shadow'` for soak.

## Stage 3 · Migrate the catalog (existing probes → invariants)

Port in phase order. One commit per probe + unit test.

1. `install.user_data_writable`
2. `db.daemon_reachable`
3. `db.authenticated`
4. `db.embedder_profile_match`
5. `db.pending_recall_log_bounded`
6. `mcp.wiring_project_present`
7. `mcp.wiring_global_present`
8. `mcp.daemon_responds` (adds `/healthz` endpoint to daemon if missing)
9. `integrations.sync_freshness`
10. `integrations.lunch_money_no_dupes`
11. `runtime.no_orphan_node_test_procs`
12. `scheduler.no_stuck_in_flight`

Each is added to `INVARIANTS` array in registry.

## Stage 4 · New invariants

13. `runtime.hooks_settings_present` — initially `level: 'warn'`; promoted later.
14. `runtime.node_version_pinned`
15. `daemon.heartbeating`

## Stage 5 · Runbook + drift guard

- `system/runtime/invariants/runbook.js` — generates markdown from registry.
- Wire `--emit-runbook`, `--emit-runbook --write`, `--emit-runbook --check` into doctor.
- Sentinel block in `CLAUDE.md`.
- `pnpm lint:runbook` script in `package.json`.
- `.githooks/pre-commit` script.
- Doctor refactor: probe logic moved into invariants; doctor becomes thin renderer.

## Acceptance per spec §7

1. All 16 invariants pass tests in CI.
2. `pnpm lint:runbook` passes.
3. `doctor.js` ≤ 250 LOC.
4. Pointer-file deletion not in scope.
5. HEALTH_ALERT.md verified via gated synthetic invariant.
6. Soak criterion (cannot complete in implementation alone; deferred to post-merge observation).
7. Framework overhead measured (deferred to post-merge measurement).
