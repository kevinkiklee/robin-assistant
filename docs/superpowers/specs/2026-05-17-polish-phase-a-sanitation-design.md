# Polish Program — Phase A: Sanitation Design

**Author:** Kevin (with Claude during /superpowers:brainstorming, 2026-05-17)
**Status:** Draft, awaiting user review before /superpowers:writing-plans
**Sibling spec:** `docs/superpowers/specs/2026-05-17-polish-phase-b-ux-design.md` (Phase B; depends on Phase A audit notes)
**Parallel lane (out of scope):** `docs/superpowers/specs/2026-05-17-cognition-e1-self-improvement-design.md`

---

## TL;DR

Two-phase polish program runs parallel to in-flight cognition-e1 work. Phase A (this spec) is a four-sub-area sanitation sweep: silent-failure hunt, dead-code purge, test gaps + slow-test cleanup, observability + invariant hardening. Output: a committed audit notes file + landed fix commits + new detect-only invariants. Time-box ~22–34 working hours. Exit gate is concrete (test suites green, doctor JSON schema test green, CLAUDE.md "recurring bugs" coverage table signed off, audit notes user-reviewed). Phase B's UX work is finalized only after Phase A's audit notes land so it cites concrete findings.

---

## Background

### Why polish, why now

Robin v2 boot in early May. The substrate is stable (daemon, MCP, integrations, cognition pipeline) but accreted complexity:

- Eight known recurring-bug classes are catalogued in `CLAUDE.md` — some have invariants, some don't.
- Daemon log volume hasn't been audited against a baseline.
- Test suite has known speed-rule violations (real timers, subprocess spawns in unit tests, embedder loads not gated by `ROBIN_SKIP_SLOW`).
- Dead code and orphan files accumulated through the v1→v2 migration and rapid feature work.
- Silent-failure paths (try/catch returning fallback) exist across the cognition, IO, and runtime trees with no systematic audit.

Polish-as-program (rather than ad-hoc fixes) treats this as one coherent sweep with a structured output (audit notes) that seeds Phase B's UX work.

### Parallel cognition-e1 lane

`cognition-e1` is mid-implementation (commits `c984b0b`, `8314db5`, `a925aa4` etc. and a large uncommitted WIP). It owns its own files (listed in "Cognition-e1 conflict policy" below). Polish is forbidden from modifying these. Defects found in cognition-e1 files during audit are filed to the "Open for cognition-e1 lane" section of the audit notes and surfaced to the user at Phase A exit.

### Decisions taken during brainstorm

| Decision | Choice | Rationale |
|---|---|---|
| Program shape | Two phases (A + B) running parallel to cognition-e1 | User chose "all three sequenced" but cognition-e1 has its own spec/execution; polish runs alongside without absorbing it. |
| Sequencing | A fully → audit bridge → B | Sanitation findings reshape UX scope; sequential keeps Phase B sharper. |
| Sub-area dispatch within A | A.1 + A.4 parallel; A.2 after A.1; A.3 after A.2 | A.2 deletes files; A.3 writes tests; ordering avoids stomping. |
| Scope per sub-area | Comprehensive — all four sub-areas at full breadth | User chose comprehensive default per `feedback_communication-style`. |
| Madge dependency | Add as devDependency | Confirmed during brainstorm. |
| Logger location | `system/runtime/log/index.js` | Confirmed during brainstorm. |
| Existing CLI exit codes | Preserved | Confirmed during brainstorm. Standardization only applies to commands with no prior contract. |
| Discord retry policy | Exp backoff, max 3 retries, then surface | Confirmed during brainstorm (Phase B detail). |
| CHANGELOG format | Keep-a-Changelog | Default; correct during spec review if wanted otherwise. |

---

## Cognition-e1 conflict policy

The following files are owned by cognition-e1 during the polish program. Phase A may **read** them (audit only) but must **not modify** them. Defects file to the audit notes under "Open for cognition-e1 lane":

- `system/cognition/dream/dag.js`
- `system/cognition/dream/step-knowledge.js`
- `system/cognition/dream/step-profile.js`
- `system/cognition/dream/step-reflection.js`
- `system/cognition/dream/telemetry.js`
- `system/cognition/dream/step-registry.js`
- `system/cognition/dream/step-calibration-bucket.js`
- `system/cognition/dream/step-outcome-grading.js`
- `system/cognition/dream/step-playbook-synthesis.js`
- `system/cognition/dream/step-prediction-taxonomy.js`
- `system/cognition/dream/step-self-improvement-rollup.js`
- `system/cognition/introspection/*`
- `system/cognition/intuition/reinforcement.js`
- `system/cognition/intuition/correction-inference.js`
- `system/cognition/intuition/playbook-inject.js`
- `system/cognition/jobs/comm-style.js`
- `system/cognition/jobs/internal/*`
- `system/cognition/telemetry/rollup-registry.js`
- `system/cognition/memory/arcs.js`
- `system/cognition/biographer/pipeline.js`
- `system/io/mcp/tools/health.js`
- `system/io/mcp/tools/remember.js`
- `system/data/db/migrations/0017-telemetry-umbrella.surql`
- `system/data/db/migrations/0026-telemetry-add-faculties.surql`
- `system/data/embed/factory.js`
- `system/data/db/client.js`
- `system/io/capture/session-capture.js`

If cognition-e1's exclude list changes mid-program, this list is updated by amendment and the audit notes record the change.

---

## Architecture overview

```
                    ┌──────────────────────────────────────────┐
                    │   Phase A: Sanitation (this spec)        │
                    │                                          │
                    │  ┌────────────┐    ┌──────────────────┐  │
                    │  │ A.1 silent │    │ A.4 observ. +    │  │
                    │  │  failures  │    │  invariants      │  │
                    │  └─────┬──────┘    └────────┬─────────┘  │
                    │        │                    │            │
                    │        ▼                    │            │
                    │  ┌────────────┐             │            │
                    │  │ A.2 dead   │             │            │
                    │  │  code      │             │            │
                    │  └─────┬──────┘             │            │
                    │        │                    │            │
                    │        ▼                    ▼            │
                    │  ┌────────────┐    ┌──────────────────┐  │
                    │  │ A.3 test   │◄───┤ Audit notes      │  │
                    │  │  gaps      │    │ (committed)      │  │
                    │  └─────┬──────┘    └────────┬─────────┘  │
                    │        │                    │            │
                    └────────┼────────────────────┼────────────┘
                             │                    │
                             ▼                    ▼
                    ┌──────────────────────────────────────────┐
                    │   User review of audit notes (gate)      │
                    └────────────────────┬─────────────────────┘
                                         │
                                         ▼
                    ┌──────────────────────────────────────────┐
                    │   Phase B: UX polish (separate spec)     │
                    └──────────────────────────────────────────┘
```

**Subagent parallel-dispatch:**
- A.1 (silent-failure hunt) and A.4 (observability + invariants) are independent (one reads source files, the other reads logs and runtime state) — dispatched in parallel.
- A.2 (dead-code purge) runs **after** A.1 finishes so it doesn't delete a file A.1 is auditing.
- A.3 (test gaps) runs **after** A.2 finishes so it doesn't write tests for code A.2 deletes.
- A.1 and A.4 commits land independently; A.2 and A.3 commits land in serial waves.

**Time-box (rough, anchors abort criteria):**
- A.1: 6–10 working hours
- A.2: 4–6
- A.3: 6–10
- A.4: 4–6
- Audit notes write-up + bridge population: 2

A sub-area is paused (not rolled back) if any of: (a) complexity 2× its slot; (b) the fix requires touching cognition-e1-owned files; (c) `pnpm test` cannot stay green for >2 consecutive attempts; (d) user pauses. Pause is recorded in audit notes with rationale; shipped commits stay shipped.

---

## A.1 Silent-failure hunt

**Method.**

Grep is a seed to prioritize, not a method. Manual full-file read of every module in scope is the work.

1. **Static seed patterns** (ripgrep, populate the suspect list):
   - Empty catches: `catch\s*\([^)]*\)\s*\{\s*\}`
   - Commented-out catches: `catch\s*\([^)]*\)\s*\{\s*//`
   - Promise catch-fallback: `\.catch\(\s*\(?\)?\s*=>\s*(null|undefined|\{\}|\[\]|false|0)\)`
   - Try-catch-return-falsy: `try\s*\{[\s\S]*?\}\s*catch[\s\S]*?return\s+(null|undefined|\[\]|\{\}|false|0)`
   - Log-and-swallow: `console\.(warn|error)\([^)]*\)[\s;]*return`
   - Discarded settled results: `Promise\.allSettled` without subsequent `.status === 'rejected'` inspection
   - Async-fallback masking: `await [^;]+ \|\| ` or `await [^;]+ \?\? ` near top-level statements

2. **Module sweep — manual full-read, regardless of grep hits.** The grep seed prioritizes which to read first.

   In-scope directories (full sweep):
   - `system/runtime/daemon/**`
   - `system/runtime/cli/commands/**`
   - `system/io/mcp/server.js`
   - `system/io/mcp/tools/**` *(excluding cognition-e1-owned `health.js`, `remember.js`)*
   - `system/io/integrations/**` (every adapter)
   - `system/io/capture/**` *(excluding cognition-e1-owned `session-capture.js`)*
   - `system/data/db/**` *(excluding cognition-e1-owned `client.js`)*
   - `system/runtime/invariants/**`
   - `system/cognition/jobs/runner.js`, `scheduler.js`, `db.js`
   - `system/cognition/memory/events.js`, `entities.js`, `edges.js`, `knowledge.js` *(excluding cognition-e1-owned `arcs.js`)*

3. **Per-site classification:**
   - `fix` — rethrow / log structured / surface to caller / propagate to MCP error reason. Requires one-line "why this catch should surface" justification.
   - `keep` — fallback is correct and obvious; no change.
   - `document` — correct fallback, add a one-line comment explaining why.
   - `defer` — file under "Open for cognition-e1 lane".

4. **Dead-code-within-module subsweep** (folded in from A.2):
   While reading a module, flag any private function or const that isn't called. Lands as a separate commit from the silent-failure fix commits.

**Validation per fix commit.**

- `pnpm test:fast` green (3 consecutive runs for flakiness check)
- For fixes touching MCP tool error paths: `node system/scripts/list-mcp-tools.js` shows no regressions

**Threshold.**

A site is a defect if any of:
- Unexpected branch returns a falsy fallback without logging or surfacing.
- Catch ignores an error the caller's contract says it should know about.
- Fallback path has its own latent bug.

Borderline cases default to `document` (no behavior change, but comment lands).

**Output.**

Audit notes sections `A1-Inventory` (modules scanned + grep hits) and `A1-Decisions` (per-site classification + commit shas). Commits land per-module via atomic `git commit -- file1 file2`.

**Risk + rollback.**

Resilient-by-design catches (e.g., `recordEvent` embedding try/catch documented in CLAUDE.md) misclassified as defects re-introduce `InternalError` to MCP clients. Mitigation: every `fix` decision needs a one-line "why this catch should surface" justification, reviewed against CLAUDE.md "Memory writes — resilient by design" rule before landing. Per-commit revert is the rollback procedure; each fix is its own commit; `git revert <sha>` reverses without affecting siblings.

---

## A.2 Dead-code + unused-file purge

**Method.**

1. **Module graph.** `pnpm add -D madge`, then `madge --orphans --extensions js system/` for unimported modules.

2. **Reflection allowlist.** `system/scripts/dead-code-allowlist.json` (new, hand-maintained). Modules referenced by reflection or dynamic import are exempt:
   - MCP tool auto-registration: `system/io/mcp/tools/*.js`
   - CLI subcommand auto-discovery: `system/runtime/cli/commands/*.js`
   - Integration adapter loading: `system/io/integrations/*/index.js`
   - Migration runner discovery: `system/data/db/migrations/*.surql`
   - Pre-commit hook scripts: `system/scripts/pre-commit/*.js`
   - Skill scripts under `system/skeleton/`

3. **Exported-but-unused symbols.** For each `export function X` / `export const X` in non-allowlisted modules, ripgrep `\bX\b` across `system/` (excluding the defining file). Zero hits → delete.

4. **Stale fixtures.** Files in `system/tests/fixtures/**` not referenced by any test file → delete.

5. **Abandoned migrations.** `.surql` files in `system/data/db/migrations/` not listed in the manifest → flag for user (DB schema deletions never automatic).

6. **Orphan scripts.** `system/scripts/**` not referenced by `package.json` scripts, CI workflows, docs, or other scripts → flag for user (some are runbook-only).

**Validation per deletion commit.**

Smoke battery, all must stay green:

- `pnpm test` (full suite)
- `robin --help` runs and exits 0
- `robin doctor --json` parses; no schema errors
- `node system/scripts/list-mcp-tools.js` (new one-off script that lists MCP tools registered by the live daemon vs. the file inventory) shows no regressions
- `robin daemon-start; sleep 2; robin doctor; robin daemon-stop` exits clean; no orphan daemon

**Scope exclusions.**

Cognition-e1-owned files. `user-data/` (gitignored; findings surface to user). `system/skeleton/` (npm-published; deletion needs explicit user approval — flag, don't delete).

**Threshold.**

CLAUDE.md "default to maximum reduction." Zero references AND not on allowlist → delete. Chain-references (A used only by B, B unused) → delete chain.

**Output.**

Deletion commits, atomic per area. A2 inventory + decisions in audit notes.

**Risk + rollback.**

False-positive deletion of a public package surface. Mitigation: cross-check against `package.json` `files` and the skeleton's exported surface before delete. Per-commit revert for rollback.

---

## A.3 Test gaps + slow-test cleanup

**Method.**

1. **Behavior-coverage inventory.** For every non-trivial module (>50 LOC, has branches or async I/O) in `system/cognition/`, `system/io/`, `system/data/`, `system/runtime/`:
   - Extract primary exported names.
   - Ripgrep them across `system/tests/`.
   - Zero hits = behavior not tested anywhere.
   - Some hits = covered by consumer tests (acceptable for thin helpers).

2. **Slow-test scan.**
   - Tests using `setTimeout` without `.unref()` and without `clearTimeout` on every path.
   - Tests with `await sleep(N)` where N > 50.
   - Tests spawning `node`/`pnpm`/`robin` subprocesses (unit-test scope only — `system/tests/integration/**` exempt).
   - Tests >300ms (measured via `pnpm test:file --reporter=spec`, parse durations) not gated by `ROBIN_SKIP_SLOW`.
   - `mem://` connections without paired `await close(db)`.

3. **Setup-leak scan.**
   - `setInterval` started in test setup without `.unref()` and no `stop()` call.

**Scope exclusions.**

Cognition-e1-owned files (cognition-e1 owns its own test plan). `system/tests/integration/**` for the subprocess-spawn rule. `system/skeleton/**` (separate test config).

**Threshold.**

- Every behavior-untested module with non-trivial logic → add a test OR document why not (thin re-export, IO wrapper, etc.) in audit notes.
- Every slow-test violation → either refactor under 300ms with `mock.timers` or gate behind `ROBIN_SKIP_SLOW`.
- No regression of current `pnpm test:fast` time. Measured before/after; current floor is ~5s. Net new tests may push it up by ≤2s total; if more, the new tests get `ROBIN_SKIP_SLOW`-gated.

**Validation per test commit.**

- 3 consecutive `pnpm test:fast` greens before commit (flakiness regression check).

**Output.**

New test files under `system/tests/unit/`; fixes to existing tests. List in audit notes A3. Commits per-module.

**Risk + rollback.**

Adding tests can surface latent bugs (good — file them). The test commit lands with `test.skip` + an audit-notes entry; the underlying fix is filed as a separate task, not blocking Phase A.

Flaky-test regression check: 3 consecutive greens before each test commit.

---

## A.4 Observability + invariant hardening

**Step 0 — baseline (required before changes).**

Capture two daemon log samples:
- `idle-baseline.log`: 10 minutes of daemon-running, no traffic.
- `active-baseline.log`: 10 minutes of `mcp__robin__recall` + `remember` traffic (drive via `system/scripts/log-baseline.js`, a new harness).

Compute baseline metrics:
- Total line count
- Unique pattern count (group by tokenized template; replace timestamps, IDs, durations)
- Top-10 repeating patterns with counts

Baseline file committed to `docs/superpowers/notes/2026-05-17-polish-phase-a-log-baseline.md`. Deltas in Phase A exit gate are measured against this file.

**Method.**

1. **Log noise audit (from baseline).**
   Identify patterns repeating >5× per minute or contributing >5% of total line volume. Classify per pattern:
   - `silence` — move to debug level.
   - `reduce` — sample 1-of-N (`if (counter++ % N === 0) log(...)`).
   - `keep` — genuinely useful at info; rationale required.
   - `promote` — currently log-only, should be invariant.

2. **Structured-logging module.**
   Add `system/runtime/log/index.js` (~50 LOC). Exports `log.info/warn/error/debug({event, ...fields})` that emits a JSON line with prefix. Convert ONLY known-noisy + known-class-of-event sites:
   - Reauth (proactive + reactive)
   - Rate-limit refusals
   - Embedder failure paths
   - Scheduler tick failure
   - Integration sync result
   
   No bulk conversion of every `console.*` call.

3. **Invariant coverage decisions.** Against CLAUDE.md "recurring bugs":

| Bug class | Existing invariant | New invariant? | Detect-only first? |
|---|---|---|---|
| ESM cache drift | none | `runtime.hot_reload_watcher_active` | yes |
| Job in_flight wedge | `scheduler.no_stuck_in_flight` ✓ | — | — |
| `.robin-home` pointer | `install.pointer_present` ✓ | — | — |
| LM pending↔cleared dupes | `integrations.lunch_money_no_dupes` ✓ | — | — |
| plist KeepAlive loop | structural fix shipped | not invariant-able (write rationale to audit notes) | — |
| SurrealDB anon access | `db.authenticated` ✓ | — | — |
| pnpm Node mismatch | `runtime.node_version_pinned` ✓ | — | — |
| Orphan `node --test` procs | `runtime.no_orphan_node_test_procs` ✓ | — | — |
| MCP wiring race | `mcp.wiring_*` ✓ | — | — |
| Multi-agent git-index race | none | not invariant-able (no daemon-readable signal); extend `.githooks/pre-commit` to refuse commits invoked with `-a`/`-am` and warn on staged-set drift between consecutive `git add` and `git commit` invocations within the same shell session | — |
| Embedder load staleness | `db.embedder_profile_match` ✓ | `daemon.embedder_load_age` — warn if a write that should have embedded has had no successful embed in >24h. Distinguished from "no traffic": the invariant writes a synthetic embed-only test row daily (cheap) and tracks its outcome, so silent embedder breakage surfaces even when memory traffic is light. | yes |
| Reauth handler registered after reconnect | `db.authenticated` covers detection of the anonymous-access symptom in production traffic | `mcp.daemon_authenticated_after_reconnect` — weekly probe (cadence chosen to avoid disturbing live workload; the existing reactive `installQueryRetry` catches in-the-moment regressions). The probe forces a WS reconnect via `db.close() + db.connect()` and asserts a follow-up `SELECT 1` succeeds without anonymous-access errors. | yes |

   **"Detect-only first"** means: invariant fires status `warn` but its `repair --apply` is a no-op for 7 days of clean detection. After 7 days of zero false positives, auto-repair gets enabled (per-invariant config flag).

4. **Doctor `--json` schema.** Tighten the JSON output shape; snapshot-test in `system/tests/unit/doctor-json-schema.test.js`. Larger doctor display redesign deferred to Phase B.

**Scope exclusions.**

Cognition-e1's `rollup-registry.js`. `show_telemetry_rollup` MCP tool display (deferred to Phase B).

**Threshold.**

- Idle daemon: ≥50% reduction in log-line-count vs. baseline; no pattern repeating >2× per minute.
- Active daemon: no pattern repeating >5× per minute; total volume ≤2× idle.
- Every CLAUDE.md "recurring bugs" entry has either an invariant (existing or new) or a documented "not-invariant-able" rationale.

**Output.**

- New invariants in `system/runtime/invariants/` (detect-only mode).
- Logger module `system/runtime/log/index.js` + selective conversions.
- Doctor `--json` schema snapshot test.
- `.githooks/pre-commit` extension for atomic-commit enforcement (refuse `-a`/`-am`; warn on staged-set drift).
- Audit notes A4 inventory + decisions.

**Risk + rollback.**

Auto-repairing invariants masking deeper issues → detect-only first. Logger module is additive; existing `console.*` calls untouched outside the targeted classes. Per-commit revert for rollback.

---

## Audit notes file

**Location:** `docs/superpowers/notes/2026-05-17-polish-phase-a-audit.md` (committed at Phase A exit).

**Structure:**

```markdown
# Polish Phase A — Audit Notes

**Date range:** 2026-05-17 → <end>
**Phase A complete:** <date>

## A.1 Silent-failure hunt

### Inventory
<modules scanned + grep hits>

### Decisions
| Site | Classification | Rationale | Commit |
|---|---|---|---|
| `system/runtime/daemon/server.js:142` | fix | catch hides ECONNREFUSED from caller; should surface | <sha> |
| ... | ... | ... | ... |

## A.2 Dead-code + unused-file purge

### Inventory
<madge orphan list, exported-but-unused list, fixtures, migrations, scripts>

### Decisions
<delete / keep / flag-to-user>

## A.3 Test gaps + slow-test cleanup

### Inventory
<behavior-untested modules, slow-test violations, setup leaks>

### Decisions
<add-test / refactor / gate-with-skip-slow / document>

## A.4 Observability + invariant hardening

### Baseline metrics
<reference to log-baseline file>

### Log noise decisions
| Pattern | Count | Classification | Action |
|---|---|---|---|

### Invariant coverage table
<the table from this spec, with status>

## Open for cognition-e1 lane
<defects in e1-owned files; e1 lane triages>

## Open for user
<user-data findings, abandoned migrations, orphan scripts requiring user decision>

## Won't fix
| Item | Rationale |

## Bridge to Phase B
| Phase B target | Type | Provenance (audit section) | Priority |
|---|---|---|---|
| Add error message at `<file>:<line>` | error-message | A.1 | high/med/low |
| Drop `<surface>` from B.1 scope (deleted) | scope-reduction | A.2 | — |
| Doctor must render invariant `<id>` | doctor-display | A.4 | high/med/low |
| MCP tool `<name>` returns `<shape>` | mcp-contract | A.1/A.3 | high/med/low |
| Daemon log event `<name>` structured; surface in doctor | observability | A.4 | low |
```

---

## Cross-cutting decisions

### Snapshot test convention

**Decision:** inline snapshots via dedicated test files; no separate `__snapshots__/` directory.

- Snapshots live as multi-line string literals in the test file, asserted via `assert.strictEqual` against normalized output.
- Easier to diff in PRs; no orphan snapshot files; single source of truth per test.
- Helper: `system/tests/helpers/normalize-snapshot.js` (new).

**Normalization layer** replaces dynamic fields with stable tokens before comparison:
- Timestamps: `2026-05-17T13:42:01.123Z` → `<TIMESTAMP>`
- Surreal IDs: `events:abc123def` → `events:<ID>`
- PIDs: `pid=12345` → `pid=<PID>`
- Durations: `took_ms: 47` → `took_ms: <MS>`
- Random suffixes: `polish-7` → `polish-<SUFFIX>`

Helper exports: `normalize(output: string): string` (generic) plus per-surface helpers (`normalizeDoctorOutput`, `normalizeRecallEvents`, etc.).

### CHANGELOG

**Decision:** maintain `CHANGELOG.md` at the package root (root of `robin-assistant-v2`). Format: Keep-a-Changelog.

- One section per landed phase (`## [unreleased] - Phase A`, `## [unreleased] - Phase B`).
- Categorize: `Added`, `Changed`, `Fixed`, `Removed`, `Deprecated`.
- Convert to a version section (`## [0.x.0] - 2026-05-XX`) at program end when the package version bumps.
- Per-sub-area summary required; per-commit entries optional.

### Commit hygiene

Every commit in this program: `git commit -m "msg" -- file1 file2 …` (CLAUDE.md atomic-commit rule). No `-a`/`-am`. Per-area atomic commits; no "fix 8 unrelated things" mega-commits.

### Test cadence

- Inner loop: `pnpm test:fast` (5s).
- Before any phase exit: `pnpm test` (full suite) green.
- New tests follow CLAUDE.md speed rules (timer mocks, `mem://` for DB, `ROBIN_SKIP_SLOW` gate for >300ms).

### Verification gate script

`system/scripts/polish-verify.sh` (new) runs the per-phase exit gate commands. Phase A invokes with `--phase=a`.

Contents:
```bash
#!/usr/bin/env bash
set -euo pipefail
pnpm test
pnpm test:integration
robin doctor --json | jq -e '.exit_code == 0' > /dev/null
robin --help > /dev/null
node system/scripts/list-mcp-tools.js
test -z "$(git status --porcelain | grep -v '^?? user-data/')"
echo "Phase A verify: PASS"
```

---

## Phase A exit gate (concrete)

1. `pnpm test` exits 0.
2. `pnpm test:integration` exits 0.
3. `robin doctor --json | jq -e '.exit_code == 0'` succeeds.
4. `robin daemon-start && sleep 5 && robin doctor && robin daemon-stop` exits clean; no daemon orphans (`pgrep -f "robin.*daemon"` returns nothing after stop).
5. `robin --help` and every `robin <subcmd> --help` exits 0.
6. Audit notes committed; bridge table populated; baseline log file committed.
7. **User reviews audit notes** (explicit gate) — user confirms Phase B scope reductions and bridge table priorities. Phase B spec finalization waits on this.
8. CLAUDE.md "recurring bugs" coverage table from A.4 lives in audit notes and is signed off.

Only after gate 7 (user review) does Phase B spec move from draft to final.

---

## Out of scope

- Cognition-e1 (separate spec, separate lane).
- v1 quarantine (`~/workspace/robin/robin-assistant-v1/`).
- `robin-cursor/`, `robin-gemini/` test instances.
- `askrobin.io/` (separate web product).
- `archive/robin-assistant-app/` (deprecated).
- Any commit to `user-data/` (gitignored, personal — findings surface to user).
- New features.
- Refactors that don't serve a Phase A sub-area goal.
- Touching the SurrealDB storage engine.
- Touching the embedder model selection.
- Multi-tenant or web-product work.

---

## Open issues for /superpowers:writing-plans

(To be resolved in the implementation plan, not the spec.)

- Which subagent type runs A.1's manual sweep — `Explore` (read-only) for inventory, then a writing-capable agent for fix commits? Or a single `general-purpose` agent per sub-area?
- How is the time-box monitored during execution? Manual checkpoints, or a wall-clock budget enforced by the plan?
- For new invariants in detect-only mode: where does the "7 days of clean detection" timer live? Per-invariant in its definition file, or in a global config?
