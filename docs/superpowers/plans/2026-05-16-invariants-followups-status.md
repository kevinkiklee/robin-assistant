# Invariants Framework — Follow-up Status

**Date:** 2026-05-16
**Predecessor spec:** `docs/superpowers/specs/2026-05-15-invariants-framework-design.md`
**Predecessor plan:** `docs/superpowers/plans/2026-05-15-invariants-framework-implementation.md`

This document records the disposition of every deferred item from the invariants framework rollout and the rationale for what shipped and what didn't.

## Doctor.js refactor — DONE

Spec §7 acceptance #3 required `doctor.js ≤ 250 LOC`. Refactor landed in `d88c4f1`:

| File | LOC | Role |
|---|---|---|
| `doctor.js` | 202 | dispatcher + new flag handlers (`--invariants`, `--emit-runbook`, `--diff-legacy`) |
| `_doctor-probes.js` | 178 | read-only probe helpers (better-sqlite3, port, supervisor, surreal, biographer log, integration freshness, layout) |
| `_doctor-special-commands.js` | 116 | `--rebaseline` / `--purge-stale-sessions` / `--lint-hooks` |
| `_doctor-status.js` | 222 | default status renderer + `doctorData` drift inspector |

Public surface unchanged. All 10 doctor tests pass.

## B-candidates — disposition

### B-1 · Env-var path discovery (kills `install.pointer_present`) — **DEFERRED**

**Why deferred.** Spec explicitly orders this last: "biggest blast radius; save until other moves prove the framework's value." Touches ~15–20 CLI entry-point files. Bricking path discovery bricks the entire `robin` command, which is the worst-possible regression to ship unsupervised.

**Trigger for revisit.** `install.pointer_present` rolling counter ≥ 1 firing in 30 days. With the framework just landed, the counter is meaningless until the soak completes. Re-evaluate after stage-2 soak (7 days of `enabled='shadow'`).

**Implementation sketch when ready.**
1. Install adds idempotent `export ROBIN_HOME=...` stanza to user's shell rc (zsh + bash + fish, sentinel-block delimited).
2. `resolveHomeStrict` already reads `ROBIN_HOME` first — no code change there.
3. Migration window: 30 days of `ROBIN_HOME` set AND pointer files coexisting. After window, `robin install --upgrade` retires the pointer files.

### B-2 · Drop global ~/.claude.json write (kills `mcp.wiring_global_present` repair) — **DONE**

**Action taken.** `mcp.wiring_global_present` now has no `repair()` function. The invariant is detection-only. The race-prone global write is gone.

The `check()` and `explain()` remain. When the global file's `mcpServers.robin` entry is missing or wrong, doctor surfaces a warn and the explain() includes the manual fix recipe. Project-local `.mcp.json` (a critical-level invariant with auto-repair) remains the source of truth for in-project agent sessions.

**Behavior change for users.** No automatic recovery of `~/.claude.json` after Claude Code clobbers Robin's entry. They'll see it in `robin doctor --invariants` as warn and can re-add manually.

### B-3 · LM dedup prevention-only — **ALREADY DONE**

The stage-3 implementation of `integrations.lunch_money_no_dupes` shipped without a `repair()` function. The endpoint state B-3 describes (prevention via `lm-stable:<key>` external_id, detection-only check, manual dedupe script for legacy) is the current state. No further action needed.

### B-4 · Self-installing hooks at SessionStart — **DEFERRED**

**Why deferred.** Spec explicitly says: "Performance budget must be set and measured during implementation — SessionStart latency is user-perceptible. Baseline first, budget derived from baseline." I have no baseline.

The current behavior is operationally sufficient: `runtime.hooks_settings_present` runs on heartbeat (5-min cooldown), boot, and postInstall. Hook drift is detected within 5 minutes and auto-repaired by re-invoking `installHooksToSettings`. The B-4 prize is reducing detection latency from minutes to zero, which is real but not urgent.

**Trigger for revisit.** Any `runtime.hooks_settings_present` firing (spec). Plus: a SessionStart latency baseline measured under realistic conditions. The work itself is small (one verify step in the SessionStart hook); the gate is the measurement.

### B-5 · Atomic embedder profile swap (drops `db.embedder_profile_match` warn) — **DONE**

**Action taken.** `cognition/jobs/embeddings-ops.js` `activateProfile` now refuses unless backfill is verified complete. Verification: per-surface row count equality between source table (`events`/`memos`/`entities`) and target embedding table (`embeddings_<profile>_<surface>`). Override via `force: true` on the wire / `--force` on the CLI for operators in dual-read or known-partial state.

When activation refuses, the response includes:
- `reason: 'backfill_incomplete'`
- `gaps: [{ surface, source_count, target_count, missing }]`
- `hint`: pointer at `robin embeddings backfill <profile>` or `--force`

The `db.embedder_profile_match` invariant remains in the catalog as a regression canary. Any firing now means either (a) someone bypassed activate with `--force` and didn't backfill afterward, or (b) a row was inserted to a source table without an embedding (the canary's intended scope). The class is no longer reachable through normal CLI use.

## Net result of this follow-up pass

| | Before | After |
|---|---|---|
| Catalog size | 16 | 16 |
| Invariants with auto-repair | 8 | 7 (-1 from B-2) |
| Invariants reachable via in-product action | 16 | 15 (-1 from B-5) |
| Manual escalation paths | 4 | 5 (+1 from B-2) |
| `doctor.js` LOC | 699 | 202 |

## Spec acceptance criteria — current status

1. ✓ All 16 invariants pass unit + integration tests in CI (full unit suite 1685 pass / 8 skip / 0 fail).
2. ✓ `pnpm lint:runbook` passes.
3. ✓ `doctor.js` ≤ 250 LOC (202).
4. ✓ Pointer-file deletion not in scope (B-1 deferred).
5. ⏸ HEALTH_ALERT.md gated synthetic test — not written. Defer until flag flip to `enabled='shadow'`; the path is exercised end-to-end through manualAlertSet's existing tests.
6. ⏸ 7-day soak — cannot complete during the implementation session; pending live operation with `runtime:invariants.config.enabled = 'shadow'` then `true`.
7. ⏸ Framework overhead measurement (daemon RSS delta < 5 MB; per-tick wall-time delta < 50 ms) — pending live operation.

Items 5–7 require time and live operation. The implementation itself is complete; observation is the remaining work.

## What's still genuinely pending

- **Flip the flag.** `config.json` → `invariants.enabled = 'shadow'` for stage-2 soak, then `'true'` after 7 days clean.
- **B-4 baseline.** Measure SessionStart hook latency under normal Robin use; derive a budget for the self-verify step.
- **B-1 risk pass.** After the framework has demonstrated value (`install.pointer_present` repair counter ≥ 1, framework has caught at least one real silent-degradation event), reconsider B-1 with a transition feature flag.
