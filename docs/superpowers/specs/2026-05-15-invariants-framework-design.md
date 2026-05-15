# Operational Invariants Framework

**Status:** Proposed design
**Date:** 2026-05-15
**Scope:** Local single-user instance (Kevin's machine). Out of scope: askrobin.io VM deployment, npm-package-consumer install flows, multi-tenant fragility.
**Strategy:** Defensive simplification with explicit structural follow-ups (Approach C in brainstorm). No changes to cognition pipelines, daemon supervision model, or embedded DB choice.

## 1. Motivation

Robin's recurring operational failures are not feature-interference bugs — they are *shared-state-under-concurrent-access* bugs at the runtime boundary. The CLAUDE.md "Recurring bugs to watch for" runbook lists five distinct fragility classes (install pointer disappearance, MCP plist KeepAlive loop, DB anonymous-access flood, Lunch Money pending↔cleared duplicates, NAPI handle leak), each previously firefought one at a time.

Each runbook entry is, at heart, an *operational invariant that broke* — and the framework that detects, repairs, and documents these invariants does not exist as a codified system. It exists as hand-curated prose in CLAUDE.md, with ad-hoc probes in `system/runtime/cli/commands/doctor.js` (560 LOC) that overlap inconsistently with the runbook entries.

This design codifies every recurring fragility class as a typed registry entry with `check()`, `repair()`, and `explain()`. A single runner evaluates entries at defined moments, persists state-over-time, owns the only place that mutates operational state, and auto-generates the CLAUDE.md runbook from the registry.

The framework is the long-missed prevention surface for the silent-degradation class — most notably the `~/.claude/settings.json` hooks-drift failure mode, which has no current detection path and produces no error, only reduced Robin helpfulness.

## 2. Architecture & invariant shape

### Invariant entry

Each invariant lives in `system/runtime/invariants/<name>.js` and default-exports:

```js
export default {
  name: 'install.pointer_present',     // dotted; stable id used in state + telemetry
  level: 'critical',                    // 'critical' | 'warn' | 'info'
  surface: 'install',                   // open enum; surfaces.js for registered values
  phase: 'paths',                       // 'paths' | 'db' | 'mcp' | 'integrations' | 'runtime' | 'meta'

  description: 'Robin install pointer file exists and parses.',

  runWhen: {
    boot:        { enabled: true },
    heartbeat:   { enabled: true, cooldownMs: 60_000 },
    doctor:      { enabled: true },
    postInstall: { enabled: true }
  },

  // Optional. false → "skip; not applicable for this instance" (distinct from failure).
  async enabled(ctx) { return true; },

  // Read-only. IO permitted; state mutation forbidden.
  // Returns { ok: true, evidence? } or { ok: false, error, evidence? }.
  async check(ctx) { /* ... */ },

  // Idempotent fix. Respects ctx.dryRun (no side effects when true).
  // Returns { repaired: boolean, action: string, error? }.
  async repair(ctx) { /* ... */ },

  // Markdown for runbook generation. Optional lastResult interpolates concrete evidence.
  explain(lastResult?) { /* returns markdown */ }
};
```

### Registry

`system/runtime/invariants/index.js` is an explicit manifest. No directory globbing — adding an invariant is one import + one array entry:

```js
import installPointerPresent from './install.pointer-present.js';
import mcpWiringProjectPresent from './mcp.wiring-project-present.js';
// ... one import per invariant ...

export const INVARIANTS = [
  installPointerPresent,
  mcpWiringProjectPresent,
  // ...
];
export const byName = new Map(INVARIANTS.map((i) => [i.name, i]));
```

### ctx shape

Passed to `enabled`, `check`, `repair`:

```js
{
  db,            // SurrealDB handle, or null when the DB itself is the invariant under test
  dbFactory,     // () => Promise<DB>: raw, unauthed connection for db.* invariants
  log,           // structured logger; falls back to process.stderr if user-data log path broken
  paths,         // resolved paths (may be partial when path resolution is the broken invariant)
  state,         // read/write helper for the persisted invariant-state store
  dryRun,        // boolean; repair() must respect
  trigger        // 'boot' | 'heartbeat' | 'doctor' | 'postInstall' | 'cli'
}
```

### State persistence

`user-data/runtime/invariants-state.json` — atomically written via tmpfile-rename. Per invariant:

```json
{
  "last_checked_at": "...",
  "last_pass_at": "...",
  "last_failure_at": "...",
  "last_repair_at": "...",
  "last_repair_outcome": "succeeded | failed | skipped",
  "consecutive_failures": 0,
  "pending_repair_at": null,
  "last_result_summary": { /* check result snapshot */ },
  "repair_history_30d": [/* unix-ms; rolling */]
}
```

When `user-data/runtime/` is unwritable, runner degrades to in-memory state and logs the degradation. All read paths handle missing/corrupt files by treating state as empty (try/catch around `JSON.parse`; re-run everything).

### Concurrency

Per-invariant repair lock at `user-data/runtime/locks/invariants/<name>.lock`, contents `{pid, started_at, heartbeat_at}`. Repair functions capped at 30s wall time; runner refreshes lock `heartbeat_at` every 10s. Stale locks (heartbeat older than 30s) reclaimed with a warning. `check()` never locks.

## 3. Runner lifecycle

Triggers operate over a phase-ordered set. Within a phase the order is registry-order; across phases the order is fixed: `paths → db → mcp → integrations → runtime → meta`.

### Trigger: boot

- Run all invariants where `runWhen.boot.enabled` AND `await enabled(ctx)`.
- Iterate by phase: complete phase N before any of phase N+1. Sequential within a phase.
- **Boot resets `consecutive_failures` counters** — boot is an explicit "fresh world" event.
- **Critical failure → abort with structured error.** Daemon exits non-zero; CLI exits with a one-line message pointing at `robin doctor`. No repair at boot…
- …except `bootRepairAllowlist`: one auto-repair attempt allowed for entries in this set. Initial allowlist: `['install.pointer_present']` — carved out because failing loud means "daemon never starts with no recovery path."
- Total boot budget: 5s. Per-invariant slow log threshold: 500ms.

### Trigger: heartbeat (daemon tick, every 60s)

- For each invariant with `runWhen.heartbeat.enabled`, compute `due = (state.last_checked_at ?? 0) + (runWhen.heartbeat.cooldownMs ?? 0) <= now`. Cooldown reads from persisted state, not in-memory — daemon restarts don't trigger a stampede.
- `Promise.allSettled(due.map(i => Promise.race([check(i), timeout(2000, i.name)])))`. One slow invariant cannot block the tick.
- `check()` failure → repair policy (below).
- One atomic write of `invariants-state.json` per tick.

### Trigger: doctor

- **Default = render.** Read state file. If `mtime` within 120s, render cached results. Otherwise the doctor process re-runs checks itself, **bypassing cooldowns**. State staleness is rendered as its own finding via the `daemon.heartbeating` invariant.
- `--repair`: **always** re-runs `check()` (ignores cache and cooldown). Without `--apply`, repair runs with `ctx.dryRun = true` and renders the planned action.
- `--repair --apply`: commits.
- `--surface <name>` / `--name <fqn>`: scope.
- `--json`: machine-readable.
- Exit codes: `0` clean · `1` warnings · `2` critical · `3` daemon unreachable · `4` runner errored.

### Trigger: postInstall

- `robin install` calls `runner.run({ trigger: 'postInstall' })` synchronously after its own work. Install's exit code is bounded above by the runner's — a half-installed Robin can no longer exit 0.
- Subset: `runWhen.postInstall.enabled`. Auto-repair allowed for this trigger only.
- Resets `consecutive_failures` (same logic as boot).

### Trigger: cli (preflight on every CLI command)

- **Read-only path.** Reads `invariants-state.json`; never runs `check()` unless the invariant is in `cliBlockingSet` AND its cached state is stale (>30s) or missing.
- Hard budget: 30ms cached-read path, 200ms when a `cliBlockingSet` re-check fires.
- Failure → render a one-liner pointing at `robin doctor`; blocks the command only for `cliBlockingSet` failures.

### Repair policy

`decideRepair(invariant, history) → 'auto' | 'manual' | 'skip'`:

- `level === 'info'` → `'auto'`.
- `level === 'warn'` → `'auto'` while last 3 repairs succeeded; `'manual'` otherwise.
- `level === 'critical'` → `'auto'` on consecutive-failure counts of 1 or 2; `'manual'` at 3+.
- `'manual'` writes `user-data/runtime/HEALTH_ALERT.md` (overwritten when alert set changes). `robin doctor` reads this file and surfaces it at the top of output; CLI preflight prints a one-liner.
- Boot and postInstall reset `consecutive_failures` — an environmental hiccup doesn't lock an invariant out of repair permanently.

### Telemetry

New SurrealDB table `invariants_telemetry { name, trigger, started_at, duration_ms, outcome, error?, repaired? }`. `telemetry-rollup.js` learns one new source via its existing per-source cursor pattern. Cold rows pruned at 30d.

## 4. Initial invariant catalog

16 invariants across 6 phases. `bootRepairAllowlist = ['install.pointer_present']`; `cliBlockingSet = ['install.pointer_present', 'mcp.wiring_project_present']`. Both live in `system/runtime/invariants/policy.js`.

### Phase: paths

**`install.pointer_present`** · critical · install · boot, heartbeat (5m), doctor, postInstall. In `bootRepairAllowlist` and `cliBlockingSet`.
- `check`: read `<packageRoot>/.robin-home` AND `~/Library/Application Support/Robin/install.json`; validate JSON; ensure both point to the same `home`.
- `repair`: one missing → copy from the other. Divergent → write OS-fallback to match `.robin-home`. Both missing → no auto-repair; check fails critical; daemon and CLI exit 2 with `Robin is not installed. Run: robin install`.
- B-flag: B-1 (env-var discovery eliminates this invariant).

**`install.user_data_writable`** · critical · install · boot, doctor, postInstall.
- `check`: tmpfile probe in `user-data/runtime/` (write + rename + read + unlink).
- `repair`: none — surfaces filesystem-level problems (permissions, disk full).

### Phase: db

**`db.daemon_reachable`** · critical · db · boot, heartbeat (60s), doctor. Uses `dbFactory`.
- `check`: open WebSocket without signin; 1s timeout.
- `repair`: none. Manual is the correct outcome.

**`db.authenticated`** · critical · db · boot, heartbeat (60s), doctor. Uses `dbFactory` if `ctx.db` is unauthed.
- `check`: namespaced `SELECT 1` on the shared client.
- `repair`: call `reauth()` single-flight in `system/data/db/client.js`. Codifies the existing fix.

**`db.embedder_profile_match`** · warn · db · boot, heartbeat (1h), doctor.
- `check`: compare `runtime:embedder.active_profile` against the dimension of `embeddings_<profile>_events`.
- `repair`: none — destructive otherwise. `explain(lastResult)` interpolates the exact remediation CLI.
- B-flag: B-5 (atomic profile swap renders mismatch unrepresentable).

**`db.pending_recall_log_bounded`** · warn · db · heartbeat (15m), doctor.
- `check`: count `recall_log WHERE outcome='pending' AND ts < now - 7d`; threshold > 100.
- `repair`: none.

### Phase: mcp

**`mcp.wiring_project_present`** · critical · mcp · boot, heartbeat (5m), doctor, postInstall. In `cliBlockingSet`.
- `check`: `.mcp.json` at package root parses, `mcpServers.robin.type === 'sse'`, URL matches `runtime:config.mcp.port`.
- `repair`: write canonical entry. Project-local; no race.

**`mcp.wiring_global_present`** · warn (intentionally) · mcp · heartbeat (5m), doctor, postInstall.
- `check`: `~/.claude.json` `mcpServers.robin` entry valid.
- `repair`: read → modify → tmpfile-rename. **We accept the race with Claude Code's own writer.** Project-local invariant is the source of truth.
- B-flag: B-2 (drop global write entirely).

**`mcp.daemon_responds`** · critical · mcp · boot, heartbeat (60s), doctor.
- `check`: `GET /healthz` returns `{ok:true}` within 1s. Add endpoint if missing.
- `repair`: SIGTERM daemon, let launchd respawn. One attempt; subsequent → manual. Prevents plist KeepAlive loop.

### Phase: integrations

**`integrations.sync_freshness`** · warn · integrations · heartbeat (10m), doctor.
- `enabled(ctx)`: true only when ≥1 integration is registered, enabled, and authed.
- `check`: one batch query reads `(name, last_sync_at, cadence_ms, freshness_threshold_x)` for all enabled+authed integrations. `freshness_threshold_x` defaults to 2× cadence; overridable per integration (a monthly integration shouldn't trip at day 8). Evidence: `evidence.stale_integrations: Array<{name, last_sync_at, threshold_at}>`.
- `repair`: trigger `integration_run` for stale integrations **sequentially**, max 2 per tick. Respects existing 30s min-interval.

**`integrations.lunch_money_no_dupes`** · warn · integrations · heartbeat (1h), doctor.
- `check`: GROUP BY `plaid_metadata.transaction_id` HAVING count > 1.
- `repair`: lift `dedupe-lunch-money.mjs` into `system/io/integrations/lunch_money/dedupe.js`; invariant calls function directly.
- B-flag: B-3 (after 30d zero firings, remove repair body; keep check as regression canary).

### Phase: runtime

**`runtime.hooks_settings_present`** · critical · runtime · boot, heartbeat (5m), doctor, postInstall.
- `check`: `~/.claude/settings.json` has Robin SessionStart/Stop/UserPromptSubmit/PreToolUse hooks with command paths resolving inside the current install.
- `repair`: re-invoke the relevant slice of `system/runtime/install/hooks-settings.js` (already idempotent).
- **The single biggest catch the framework adds** — detects a silent-degradation class no current probe covers.
- B-flag: B-4 (self-installing hooks at SessionStart drop this to detection-only).

**`runtime.node_version_pinned`** · warn · runtime · boot, doctor.
- `check`: `process.version` matches `.npmrc` `use-node-version`.
- `repair`: none.

**`runtime.no_orphan_node_test_procs`** · info · runtime · doctor only.
- `check`: processes where `ppid === 1` AND command-line contains `--test` AND age > 10m.
- `repair`: doctor-only AND requires `--apply`. Dry-run lists PIDs and tmpdirs.

**`scheduler.no_stuck_in_flight`** · warn · runtime · heartbeat (15m), doctor.
- `check`: `runtime_jobs WHERE in_flight=true AND started_at < now - 30m`. Threshold > 0.
- `repair`: none from the invariant; evidence lists stuck job names. Logged to HEALTH_ALERT.md after 3 consecutive failures.

### Phase: meta

**`daemon.heartbeating`** · critical · daemon · doctor only.
- `check`: `Date.now() - mtime(invariants-state.json) <= 2 × heartbeat_interval_ms`.
- `repair`: SIGTERM + launchd respawn; same one-shot rule as `mcp.daemon_responds`.
- Keystone for "doctor when daemon is down" — every other invariant's cached-read trust depends on this.

### Catalog summary

| Phase | Count | Critical | Warn | Info |
|---|---|---|---|---|
| paths | 2 | 2 | 0 | 0 |
| db | 4 | 2 | 2 | 0 |
| mcp | 3 | 2 | 1 | 0 |
| integrations | 2 | 0 | 2 | 0 |
| runtime | 4 | 1 | 2 | 1 |
| meta | 1 | 1 | 0 | 0 |
| **Total** | **16** | **8** | **7** | **1** |

## 5. Doctor integration & runbook generation

Post-migration, `system/runtime/cli/commands/doctor.js` becomes a thin renderer over the registry. The **probe logic and dispatch** leave (replaced by registry traversal); the **rendering layer** (TTY detection, color, terminal-width handling, JSON formatter) stays. Target file size after migration: ≤ 250 LOC (current: 560).

### Migration mapping (draft — reconcile against actual doctor.js during implementation)

| Existing probe (best-guess name) | Becomes |
|---|---|
| pointer-file check | `install.pointer_present` |
| user-data writable check | `install.user_data_writable` |
| db connect check | `db.daemon_reachable` |
| db auth check | `db.authenticated` (codified) |
| pending recall_log check | `db.pending_recall_log_bounded` |
| MCP project-file check | `mcp.wiring_project_present` |
| MCP global-file check | `mcp.wiring_global_present` |
| daemon /healthz check | `mcp.daemon_responds` |
| integrations freshness check | `integrations.sync_freshness` |
| orphan test-proc check | `runtime.no_orphan_node_test_procs` |
| embedder profile check | `db.embedder_profile_match` |
| stuck in_flight jobs check | `scheduler.no_stuck_in_flight` |
| (new) | `runtime.hooks_settings_present` |
| (new) | `runtime.node_version_pinned` |
| (new) | `daemon.heartbeating` |

### Doctor CLI surface

```
robin doctor                        # render cached state; re-check if state >120s stale
robin doctor --repair               # dry-run: render planned repairs
robin doctor --repair --apply       # commit (always re-runs check() first, ignores cooldown)
robin doctor --name <fqn>           # scope to one invariant
robin doctor --surface <name>       # scope to a surface
robin doctor --json                 # machine-readable
robin doctor --emit-runbook         # write generated runbook to stdout
robin doctor --emit-runbook --write # in-place CLAUDE.md replacement
robin doctor --emit-runbook --check # CI mode; exits non-zero on drift
```

`--phase` considered and dropped — surfaces and phases overlap in three names; two flags doing similar things is a UX trap. Phase is a runner-internal axis only.

### Default output structure

```
Robin doctor · 2026-05-15 09:14:23

⚠ HEALTH_ALERT.md present — see top of file.
  Failing: runtime.hooks_settings_present (critical, 4 consecutive)

paths
  ✓ install.pointer_present              (checked 12s ago)
  ✓ install.user_data_writable           (checked 12s ago)
db
  ✓ db.daemon_reachable                  (checked 12s ago)
  ✓ db.authenticated                     (checked 12s ago)
  ! db.embedder_profile_match     warn   (since 2h ago)
      profile=mxbai_1024 active=bge_768
      → run: robin embeddings activate mxbai_1024
mcp
  ✓ mcp.wiring_project_present
  ✓ mcp.wiring_global_present
  ✓ mcp.daemon_responds
integrations
  ! integrations.sync_freshness    warn  (since 18m ago)
      stale: github (last 3h, threshold 2h)
      pending_repair_at: 2026-05-15T09:16:00Z
runtime
  X runtime.hooks_settings_present crit  (since 4h ago, 4 consecutive)
      hooks missing: SessionStart
      → run: robin install --repair-hooks
  ✓ runtime.node_version_pinned
  ✓ runtime.no_orphan_node_test_procs
  ✓ scheduler.no_stuck_in_flight
meta
  ✓ daemon.heartbeating

Summary: 13 ok · 1 warn auto-repairing · 1 critical needing attention
Exit code: 2
```

Two-line max per invariant in standard mode (status + one evidence line). Richer detail via `--json` or `--name`.

### JSON mode shape

```json
{
  "generated_at": "2026-05-15T09:14:23Z",
  "exit_code": 2,
  "summary": { "ok": 13, "warn": 1, "critical": 1, "info": 0 },
  "alerts": ["runtime.hooks_settings_present"],
  "invariants": [
    {
      "name": "runtime.hooks_settings_present",
      "phase": "runtime",
      "surface": "runtime",
      "level": "critical",
      "status": "fail",
      "last_pass_at": "2026-05-15T05:11:00Z",
      "last_failure_at": "2026-05-15T09:14:11Z",
      "last_repair_at": "2026-05-15T09:13:08Z",
      "last_repair_outcome": "succeeded",
      "consecutive_failures": 4,
      "pending_repair_at": null,
      "policy_decision": "manual",
      "evidence": { "missing_hooks": ["SessionStart"] },
      "explain": "## Hooks settings missing\n\nSymptom: ..."
    }
  ]
}
```

### Runbook generation

`robin doctor --emit-runbook` walks the registry (phase order, then registry order), calls each invariant's `explain()` without `lastResult`, emits a single markdown block. Sentinel pair in package-level `CLAUDE.md`:

```markdown
<!-- robin:runbook:begin -->
... auto-generated ...
<!-- robin:runbook:end -->
```

`--emit-runbook --write` does in-place replacement; `--emit-runbook --check` exits non-zero on drift (prettier-style).

**Two guards against drift:**
1. CI lint: `pnpm lint:runbook` runs `--emit-runbook --check`; added to the existing test chain.
2. Project-level precommit hook `.githooks/pre-commit`: if any file under `system/runtime/invariants/` is staged, run `--emit-runbook --write` and stage the resulting `CLAUDE.md` diff.

Together, these make runbook drift practically impossible.

## 6. Structural follow-ups (B-candidates)

**Not part of this spec's implementation scope.** This section captures structural fixes the defensive design surfaces but explicitly defers. The Section 4 B-flag set is not exhaustive — any invariant whose `repair()` is missing, non-trivial, or repeatedly firing is a B-candidate, regardless of explicit flag.

**Detection mechanism.** Every `repair()` corresponding to a B-candidate emits a log line tagged `b_candidate=<id>` and updates the `repair_history_30d` rolling counter on the invariant's state row. `doctor --b-candidates` ranks invariants by counter and renders structural fixes from this section.

**Trigger criteria** are *observed-in-the-live-system* thresholds, actionable once 30 days of data accumulates.

**Review cadence.** Reviewed when: (a) framework gains ≥ 5 new invariants since last review, (b) any B-candidate clears its trigger, or (c) major release.

### B-1 · Env-var path discovery (kills `install.pointer_present`)

Replace pointer-file lookup with `ROBIN_HOME` env var written to user shell rc at install. Touches ~15-20 entry-point files. Migration is **not flag-day**: read env first, fall back to pointer files during transition; pointer paths deprecated after 30 days of env-only operation.
**Trigger:** `install.pointer_present` rolling counter ≥ 1.

### B-2 · Drop the global `~/.claude.json` write (kills `mcp.wiring_global_present`)

Stop writing the global file from Robin. Project-local `.mcp.json` is sufficient.
**Prerequisites:** Verify sufficiency — fresh Claude Code session with only `.mcp.json`, confirm Robin's MCP tools surface.
**Trigger:** `mcp.wiring_global_present` rolling counter ≥ 4 in 30d.

### B-3 · LM dedup prevention-only (drops `integrations.lunch_money_no_dupes` repair half)

Remove repair body; keep check as regression canary. Any post-prevention firing indicates the `lm-stable:<key>` strategy regressed.
**Trigger:** 30 days of zero repair firings.

### B-4 · Self-installing hooks (drops `runtime.hooks_settings_present` to detection-only)

Daemon's `SessionStart` hook verifies *other* hooks at session start and self-repairs idempotently. Drift becomes self-healing at the natural moment.
**Prerequisites:** Performance budget must be set and measured during implementation — SessionStart latency is user-perceptible. Baseline first, budget derived from baseline.
**Trigger:** any `runtime.hooks_settings_present` firing.

### B-5 · Atomic embedder profile swap (drops `db.embedder_profile_match` warn)

`robin embeddings activate <profile>` refuses unless backfill is verified complete. Mismatch becomes unrepresentable.
**Trigger:** any `db.embedder_profile_match` firing.

### Sequencing

If multiple candidates clear their triggers:

1. B-4 — silent-degradation prevention, highest daily-reliability impact.
2. B-5 — small, removes perma-warn.
3. B-2 — small, removes noisy invariant.
4. B-1 — biggest blast radius; do after framework value is demonstrated.
5. B-3 — opportunistic; do when LM counter confirms 30d quiet.

## 7. Testing & rollout

### Test taxonomy

Each invariant gets three test layers:

1. **Unit (per invariant)**: `system/tests/unit/invariants/<name>.test.js`. Stubs `ctx`. Covers `check()` happy + failure paths, `repair()` idempotency, dry-run respect, `enabled()` skip, `explain()` returns markdown. Per-invariant target: <50ms.
2. **Integration (runner)**: `system/tests/integration/invariants-runner.test.js`. Lifecycle: phase order, `Promise.allSettled` slow-check isolation, file-backed cooldown survives restart, repair lock prevents concurrency, repair-policy thresholds, boot resets counter. Uses `mem://` SurrealDB; paired `await close(db)`. Per-test target: <500ms.
3. **End-to-end (CLI)**: `system/tests/integration/doctor-cli.test.js`. Spawns CLI in temp `ROBIN_HOME`, asserts output shape, exit codes, sentinel-block manipulation. `ROBIN_SKIP_SLOW=1`-eligible.

### Fixture helpers

`system/tests/helpers/invariant-fixtures.js` exports:
- `makeCtx(overrides)` — stub ctx with no-op defaults.
- `runOneInvariant(invariant, ctx)` — direct check + repair + explain.
- `withTempStateFile(fn)` — tempdir for state-file tests; cleans up on exit.

### Policy config location

`system/runtime/invariants/policy.js`:
```js
export const BOOT_REPAIR_ALLOWLIST = ['install.pointer_present'];
export const CLI_BLOCKING_SET = ['install.pointer_present', 'mcp.wiring_project_present'];
```
Hand-curated. Audit unit test asserts every listed name resolves to a real invariant entry.

### Test discipline (carrying forward CLAUDE.md guidance)

- All unit tests use `mem://`; `await close(db)` in `afterEach`.
- No `setTimeout` without `.unref()`; prefer `mock.timers` for cooldown logic.
- No subprocess spawns from unit tests — runner is callable as a function.
- `ROBIN_SKIP_SLOW=1` on doctor-CLI E2E.
- `invariants_telemetry` test rows cleaned implicitly by `mem://` connection close.

### Rollout phasing

Five stages, each independently shippable.

**Stage 1 · Skeleton.** Land runner, state file, `ctx`, registry index with empty `INVARIANTS = []`. Runner exports `run(trigger)` but is **not yet called** from doctor or daemon boot. Goal: code exists, unit tests pass, zero behavior change.

**Stage 2 · First invariant + parallel-run validation.** Port `install.pointer_present`. Wire `runtime:invariants.config.enabled` semantics:
- `false` — runner not invoked.
- `'shadow'` — runner executes; state file populated; doctor renders legacy probe.
- `true` — runner is source of truth.

Doctor gains `--diff-legacy`: runs both, reports per-invariant disagreement to `user-data/runtime/divergence_log.json` (one JSON line per diff; rotated weekly; retained 30d). Stage complete when 7 days of normal use yields zero divergences.

**Stage 3 · Migrate the catalog.** Port remaining probes in **phase order**: paths (continues) → db → mcp → integrations → runtime (existing) → meta. One probe per session; each port includes unit tests + 1-day soak with `--diff-legacy`.

**Stage 4 · New invariants.** Add `runtime.hooks_settings_present`, `runtime.node_version_pinned`, `daemon.heartbeating`. No legacy probe to compare. `runtime.hooks_settings_present` ships at `level: warn` for 7 days, then promoted to `critical` once `check()` is confirmed not to false-positive.

**Stage 5 · Runbook generation + drift guard.** Wire `--emit-runbook --write/--check`, regenerate CLAUDE.md sentinel block, add `pnpm lint:runbook`, install `.githooks/pre-commit`. After this stage, recurring-bugs section is no longer hand-edited.

### Backout

Flip `runtime:invariants.config.enabled` to `false`. No code revert needed. Doctor falls back to legacy probes (kept in tree through stage 4; deletable after stage 4 retires the last one).

### Observability during rollout

- `invariants_telemetry` populated from stage 2.
- `--diff-legacy` persists divergences to `divergence_log.json` (gitignored).
- After stage 5: `--diff-legacy` and `divergence_log.json` are removed.

### Acceptance criteria

Spec is done when:
1. All 16 invariants pass unit + integration tests in CI.
2. `pnpm lint:runbook` passes.
3. `system/runtime/cli/commands/doctor.js` ≤ 250 LOC.
4. Pointer-file deletion is *not* in scope (carved out as B-1).
5. HEALTH_ALERT.md surface verified via a gated synthetic invariant under `process.env.ROBIN_INVARIANT_HEALTH_ALERT_TEST` (integration suite, not the registry).
6. 7-day soak with `enabled = true` shows zero `manual` escalations lacking either (a) a HEALTH_ALERT.md entry + matching `b_candidate` log tag, or (b) a written incident note in `docs/superpowers/incidents/`.
7. Framework overhead measured: daemon RSS delta < 5 MB; per-tick wall-time delta < 50 ms. Documented in spec PR description.

## 8. Open questions

- Storage backing for `repair_history_30d`: flat state file vs. SurrealDB row. (Trade-off: flat file works when DB is broken; DB row simplifies multi-process access.) Decide during stage 2.
- Conflict surface if husky/lefthook is added later — `.githooks/pre-commit` may need to chain through the official hook manager.
- Whether `divergence_log.json` should be checked into git or stay user-local. (Probable: user-local, gitignored.)

## 9. Summary

Sixteen invariants across six phases, each with `check`/`repair`/`explain`, evaluated by a single runner at five well-defined triggers. The framework codifies what CLAUDE.md's runbook describes in prose, replaces ad-hoc probes in `doctor.js`, and auto-generates the runbook itself. Five-stage rollout makes every step independently revertible. The single biggest catch is `runtime.hooks_settings_present` — the silent-degradation class no current probe covers. Five structural follow-ups (B-1 through B-5) are identified with observable promotion criteria, but deferred to subsequent specs.
