# Trust, Feedback & Memory-Quality Design

**Date:** 2026-06-10
**Status:** Approved (audit-driven; Kevin approved all three phases)
**Sequencing:** Phase A → Phase B → Phase C. Each phase is independently shippable; B and C deliver their warnings through A's alert channel.

## Context

A six-subsystem audit (kernel, brain, agentic layer, surfaces, integrations, spec-vs-built gap) found Robin structurally healthy — 1,056 passing tests, ~90% of recent specs built — but converged on three weakness themes:

1. **Silent failure invisibility.** Integrations that lose auth skip silently forever; degraded syncs report "ok"; scheduler tick exceptions are swallowed; the only notification is a transient macOS toast on critical invariants, with no history. This failure class has bitten repeatedly (the `loadEnvFile` silent-skip trap documented in CLAUDE.md, OAuth expiry, "is Whoop feeding the brief?").
2. **No outcome measurement.** The autonomous agent loop runs handlers round-robin with hardcoded goals, never verifies outcomes, never adapts to failure streaks, and only handler A writes a learning record. The usage ledger tracks spend but not value.
3. **Memory-quality leaks.** Belief candidates merge across topics but heads are topic-keyed, so one fact can spawn multiple heads (observed live: 7 heads for one fact; the 2026-06-10 Fable re-synthesis cleaned existing duplicates but the generator persists). Claim-extraction timeouts silently lose data. Stale-belief re-verification picks targets by lottery.

**Cost stance (binding constraint):** subscription quota is tight — Fable was cut back to one role this morning over burn rate. All three phases are designed to add **zero new LLM spend**. Phase B's pre-checks should *reduce* spend by not spawning SDK runs that would discover "nothing to do".

---

## Phase A — Trust & Alerting layer

**Core move:** implement detection as *invariants in the existing health monitor* (`system/kernel/runtime/health-monitor.ts`), which already runs every minute, classifies warn/critical, and toasts criticals via the notify builtin (`system/integrations/builtin/notify/`). New machinery is limited to persistence and surfaces.

### A1. `alerts` table (migration 024)

`alerts(id, ts, severity, source, key, message, context_json, resolved_at, acked_at)`.

- Writers dedup on `(source, key)`: an open (unresolved) alert for the same key is refreshed, not duplicated — a 3-day-stale integration is one row, not 4,320.
- **Auto-resolve:** when the underlying invariant passes again, the open alert gets `resolved_at` stamped.
- Retention: prune resolved alerts older than 30 days (piggyback on the existing nightly maintenance pass).
- Alert writes are best-effort: failures log and never throw into the caller.

### A2. Integration staleness invariant

For each enabled integration, derive expected cadence from its `integration.yaml` schedule:

- No successful ingest for **3× cadence** → warning; **10× cadence** → critical.
- Per-integration override in `policies.yaml` (e.g. manual-only integrations exempt; `lrc` daily cadence tolerated longer).
- **Consecutive skips-with-reason ≥ 3** (the OAuth-revoked / missing-secret class, recorded today in `integration_state.last_skip_reason`) → warning alert carrying the skip reason verbatim.

### A3. Degraded-stream detection

Extend the integration tick-result contract with optional `degraded: string[]` (Whoop already composes this into its message text — it becomes structured). The runtime records degraded streams in `integration_state`; the invariant fires a warning when the same stream is degraded ≥ 3 consecutive ticks.

### A4. Tick & job error capture

- The swallowed `catch` in the daemon run loop (`system/kernel/daemon.ts`, tick failure path) writes an alert row and applies a short backoff-retry before resuming.
- Job handler failures (biographer, dream, embedder, user jobs) write alert rows with the job name as `key`.

### A5. Health-check timeouts

Each invariant check wraps in a 5-second `Promise.race` timeout; a timed-out check reports `{ok: false, message: 'check timed out'}` instead of wedging the monitor.

### A6. Surfaces

- **CLI:** `robin alerts` (open alerts), `robin alerts --all` (include resolved), `robin alerts ack <id>`.
- **MCP:** new `alerts` tool on the core server (list/ack), so Claude Code sessions see system health without shelling out.
- **Morning brief:** the daily-brief generator (user-data job, pre-generated 4:30am) gains a deterministic "⚠ System health" section rendering open alerts; the section is omitted when there are none.
- **Doctor:** `robin doctor` gains a freshness table — integration, last success, age, status.
- macOS toast behavior is unchanged (criticals only) and comes free via the existing invariant→notify path.

---

## Phase B — Agentic outcome loop

**Core move:** make every autonomous run report a structured outcome, verify it deterministically, and let the scheduler adapt — with no LLM judge and no added spend.

### B1. Structured outputs for all handlers

Every handler (a–l) declares an `outputFormat` JSON schema (already supported end-to-end by `run-agent.ts` → `result.structured`). Common envelope:

```json
{ "outcome": "did-work | no-op | blocked",
  "changes": [{ "type": "...", "summary": "..." }],
  "impact": "high | medium | low",
  "notes": "..." }
```

Handler-specific fields may extend the envelope. This adds no extra LLM calls — the same run is forced to summarize structurally at the end.

### B2. Outcome persistence (migration 025)

Extend `agent_usage` (one row per run already exists) with `outcome`, `impact`, `structured_json`, `verified` columns. Generalize `writeLearningRecord` (today A-only, `system/surfaces/cli/agent.ts`) to all autonomous handlers via `runner-entry.ts`.

### B3. Deterministic verification

Per-handler post-condition checks run after the SDK exits — no LLM:

| Handler | Verifier |
|---|---|
| B research | a sourced brief event was ingested |
| D KB curation | files changed under `user-data/content/knowledge/` |
| E belief reconcile | `belief_candidates` rows appeared |
| F prediction calibrate | predictions transitioned to resolved |
| G gap-fill | KB file created/extended |
| K health remediate | worktree branch exists with a diff |

Where no deterministic check exists (H dream-enrich, L brief), record `verified: 'unverifiable'`. A run claiming `did-work` that fails verification is recorded as `outcome-mismatch` — and fires a Phase-A alert.

### B4. Pre-checks + adaptive scheduling

- **Pre-checks:** cheap deterministic queries run *before* spawning the SDK subprocess (D: any stale notes? F: any due predictions? E: any conflicted candidates?). Nothing to do → skip the run entirely. This is the main quota saver.
- **Failure budget:** after 3 consecutive `error`/`outcome-mismatch` results, a handler is benched for the next 3 full rotations (soft backoff; clears on the first successful run) and a Phase-A alert fires ("handler B failed 3 consecutive runs").
- Round-robin survives as the base order; pre-checks and benching modulate it. No ML, no weights to tune.

### B5. ROI surface

`robin metrics --agents` and the MCP `metrics` tool gain per-handler: runs, spend, outcome distribution, last did-work timestamp. Makes "which handlers earn their budget" a one-command question.

---

## Phase C — Memory-quality pack

### C1. Belief canonicalization on promote

- Deterministic topic normalizer: extract the domain entity, strip negation/modifier tokens, slugify ("aerospace-corp-claim", "no-aerospace-internship" → "aerospace-internship").
- At promotion (`believe()` path), look up existing heads by normalized slug + claim-text similarity (the levenshtein machinery already used at candidate merge). Match → supersede that head (append to its chain) instead of creating a new head.
- One-time merge pass over existing duplicate heads (small — the re-synthesis cleaned most).

### C2. Risk-weighted freshness re-query

Score stale heads by low confidence + age since last verification + correction history on the topic; `belief-freshness.ts` re-queries the top-N by score instead of the first-N lottery. Stays within the existing nightly `maxRequeries` cap — same spend, better targets.

### C3. Claim dead-letter retry (migration 026)

`claim_failures(event_id, chunk_idx, attempts, last_error, ts)`. The biographer writes a row when claim extraction times out or fails validation; the nightly pass retries (max 3 attempts, within the existing biographer budget). Accumulating failures (> 10 open) fire a Phase-A alert.

### C4. Entity profile staleness

Add `profile_generated_at` to entities. Auto-recall skips profiles older than 30 days (falls back to relation summary); the dream pass regenerates stale profiles for hot entities under its existing budget.

---

## Shared infrastructure & sequencing

- A ships first: alert table + invariants + surfaces. B3/B4 and C3 emit through it.
- Migrations: 024 (alerts), 025 (agent_usage columns), 026 (claim_failures + entity profile timestamp).
- All phases follow existing conventions: collocated `*.test.ts` with `node:test`, integration-tick contract changes mirrored in skeleton docs where applicable.

## Non-goals

- Push channels beyond the macOS toast (ntfy/email) — alert history makes them easy later.
- LLM-judged run verification or recall-precision grading — valuable, but costs quota; revisit after the June billing change.
- Belief-head visualization tooling, `explain`/`update` MCP stubs, GitHub integration — separate efforts.
- Kuzu projection scheduling, interactive `robin init`.

## Testing

- Per-invariant unit tests with fault injection (clock-skewed staleness, skip streaks, persistent degraded streams, timed-out checks).
- Verifier tests per handler with synthetic post-states.
- Canonicalizer table-driven tests (slug pairs → expected merge/no-merge).
- One end-to-end test per phase: stale integration → open alert → recovery → auto-resolve; no-op pre-check → run skipped; duplicate-topic promote → single head.

## Risks

- **Alert fatigue:** thresholds deliberately loose (3×/10× cadence) + dedup-by-key + auto-resolve. Tune via policies.yaml, not code.
- **Structured-output regressions:** the Agent SDK structured-output path was only recently fixed (3 fixes, 2026-06-09); B1 leans on it heavily. Mitigation: envelope kept flat/simple; handlers fall back to prose summary + `outcome: unparseable` rather than failing the run.
- **Canonicalizer over-merge:** false merges are worse than duplicates. Mitigation: require BOTH slug match AND claim-text similarity; log every merge decision to the journal for the first two weeks.
