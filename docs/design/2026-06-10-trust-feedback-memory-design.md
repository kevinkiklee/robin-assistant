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

**Migrations:** phases consume the next three migration slots (024–026 at time of writing; renumber at implementation time — the autonomous loop also lands migrations).

---

## Phase A — Trust & Alerting layer

**Core move:** implement detection as *invariants in the existing health monitor* (`system/kernel/runtime/health-monitor.ts`), which already runs every minute, classifies warn/critical, and toasts criticals via the notify builtin (`system/integrations/builtin/notify/`). New machinery is limited to persistence and surfaces.

### A1. `alerts` table (first migration slot)

`alerts(id, severity, source, key, message, context_json, first_seen_at, last_seen_at, fire_count, resolved_at, acked_at)`.

- **Dedup on `(source, key)`:** while an alert with the same key is open (unresolved), re-fires update `last_seen_at` and increment `fire_count` — a 3-day-stale integration is one row whose age is readable from `first_seen_at`, not 4,320 rows.
- **Severity escalation** (e.g. staleness crossing 3×→10× cadence) updates the open row's severity in place; the warning→critical transition triggers the toast exactly once.
- **Auto-resolve:** when the underlying invariant passes again, the open alert gets `resolved_at` stamped. A later recurrence opens a **new row** (fresh `first_seen_at`); resolved rows are immutable history.
- **Ack** applies to the open row only: acked alerts drop out of the default CLI/brief views but keep updating until resolved.
- Retention: prune resolved alerts older than 30 days (piggyback on the existing nightly maintenance pass).
- Alert writes are best-effort: failures log and never throw into the caller.

### A2. Integration staleness invariant

For each enabled integration with a declared schedule, derive expected cadence from its `integration.yaml`:

- **Staleness keys on the last successful *tick* (status ok or degraded), not last ingest.** Zero-new-data runs are healthy — Gmail on a quiet weekend must not alarm. Data-level staleness ("ticks fine but suspiciously empty for weeks") is explicitly out of scope.
- No successful tick for **3× cadence** → warning; **10× cadence** → escalate the open alert to critical.
- Manual-only / unscheduled integrations (notify, spotify_write) are exempt by default; per-integration overrides live in `policies.yaml`.
- **Consecutive skips-with-reason ≥ 3** (the OAuth-revoked / missing-secret class, recorded today in `integration_state.last_skip_reason`) → warning alert carrying the skip reason verbatim.
- **Power-state suppression:** while the daemon is paused, offline, or in incognito, staleness and skip-streak invariants do not fire (ticks aren't running or are expected to skip); after returning to normal, each integration gets one full cadence of grace before staleness is evaluated. Without this, `robin offline` becomes an alert storm.

### A3. Degraded-stream detection

Extend the integration tick-result contract with optional `degraded: string[]` (Whoop already composes this into its message text — it becomes structured). The runtime records per-stream consecutive-degraded counts in `integration_state`; the invariant fires a warning when the same stream is degraded ≥ 3 consecutive ticks.

### A4. Tick, job, and crash-loop capture

- The swallowed `catch` in the daemon run loop (`system/kernel/daemon.ts`, tick failure path) writes an alert row and applies a short backoff-retry before resuming.
- Job handler failures (biographer, dream, embedder, user jobs) write alert rows with the job name as `key`.
- **Crash-loop visibility:** on boot the daemon appends a boot timestamp to runtime state; ≥3 boots within an hour → warning alert ("daemon restarted N times in the last hour"). launchd respawn currently hides crash loops entirely.

### A5. Health-check timeouts

Each invariant check wraps in a 5-second `Promise.race` timeout; a timed-out check reports `{ok: false, message: 'check timed out'}` instead of wedging the monitor. Because the underlying promise cannot be cancelled, the monitor also **skips a check whose previous run is still in flight** — timed-out checks must not pile up concurrent executions.

### A6. Surfaces

- **CLI:** `robin alerts` (open alerts), `robin alerts --all` (include resolved), `robin alerts ack <id>`.
- **MCP:** new `alerts` tool on the core server (list/ack), so Claude Code sessions see system health without shelling out.
- **Morning brief:** the daily-brief generator (user-data job, pre-generated 4:30am) gains a deterministic "⚠ System health" section rendering open unacked alerts; the section is omitted when there are none. Intraday alerts are covered by CLI/MCP/toast — the brief only reflects state at generation time.
- **Doctor:** `robin doctor` gains a freshness table — integration, last successful tick, age, status.
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

Handler-specific fields may extend the envelope. This adds no extra LLM calls — the same run is forced to summarize structurally at the end. **Turn headroom:** the SDK consumes extra turns to emit structured output (empirically ≥4 total; the 2026-06-09 structured-output fixes hit exactly this) — each handler's `maxTurns` gets +2 headroom as part of this change.

### B2. Outcome persistence (second migration slot)

Extend `agent_usage` (one row per run already exists) with `outcome`, `impact`, `structured_json`, `verified` columns. Generalize `writeLearningRecord` (today A-only, `system/surfaces/cli/agent.ts`) to all autonomous handlers via `runner-entry.ts`; skip records for `no-op` runs to avoid clutter.

### B3. Deterministic verification

Per-handler post-condition checks run after the SDK exits — no LLM:

| Handler | Verifier |
|---|---|
| B research | a research-brief event exists in memory from this run (see permission change below) |
| D KB curation | files changed under `user-data/content/knowledge/` |
| E belief reconcile | `belief_candidates` rows appeared |
| F prediction calibrate | predictions transitioned to resolved |
| G gap-fill | KB file created/extended |
| H dream enrich | `belief_candidates` rows appeared (H proposes via `believe()` — same check as E) |
| K health remediate | worktree branch exists with a diff |

**Deliberate permission change:** handler B currently runs plan-mode read-only, so its research briefs die in stderr (audit finding) and no verifier could ever pass. B gains exactly one write capability — the `ingest` MCP action — so briefs land in memory as events. No file or shell writes; plan-mode stays otherwise.

L (daily brief) remains read-only and is recorded `verified: 'unverifiable'`. A run claiming `did-work` that fails its verifier is recorded as `outcome-mismatch` — and fires a Phase-A alert.

### B4. Pre-checks + adaptive scheduling

- **Pre-checks:** cheap deterministic queries run *before* spawning the SDK subprocess (D: any stale notes? F: any due predictions? E: any conflicted candidates?). Nothing to do → skip the run entirely. This is the main quota saver.
- **Failure budget:** after 3 consecutive `error`/`outcome-mismatch` results, a handler is benched for the next 3 full rotations and a Phase-A alert fires ("handler B failed 3 consecutive runs"). The bench expires on its own; the first successful run afterwards resets the failure counter.
- Round-robin survives as the base order; pre-checks and benching modulate it. No ML, no weights to tune.

### B5. ROI surface

`robin metrics --agents` and the MCP `metrics` tool gain per-handler: runs, spend, outcome distribution, last did-work timestamp. Makes "which handlers earn their budget" a one-command question.

---

## Phase C — Memory-quality pack

### C1. Belief canonicalization in `believe()`

- Deterministic topic normalizer: extract the domain entity, strip negation/modifier tokens, slugify ("aerospace-corp-claim", "no-aerospace-internship" → "aerospace-internship"). Negation-stripping is intentional: opposing claims about one fact belong on one head's supersession chain.
- **The normalizer lives inside `believe()` itself** — the single choke point — so every writer (promotion path, MCP `believe` tool, agent handlers) canonicalizes. Normalizing only at promotion would leave MCP/agent writers generating duplicates around it.
- Matching requires **both** normalized-slug match **and** claim-text similarity (the levenshtein machinery already used at candidate merge) before superseding an existing head — false merges are worse than duplicates.
- **Lookup symmetry, no alias table:** `recall_belief` normalizes the query topic through the same function before lookup, so historical and future topics resolve to the same head by construction. The one-time merge pass over existing duplicate heads uses the same normalizer, preserving this invariant.

### C2. Risk-weighted freshness re-query

Score stale heads by low confidence + age since last verification + correction history on the topic; `belief-freshness.ts` re-queries the top-N by score instead of the first-N lottery. Stays within the existing nightly `maxRequeries` cap — same spend, better targets.

### C3. Claim dead-letter retry (third migration slot)

`claim_failures(event_id, chunk_idx, chunk_body, attempts, last_error, ts)`. The biographer writes a row when claim extraction times out or fails validation; the nightly pass retries (max 3 attempts, within the existing biographer budget). `chunk_body` is stored verbatim — retries must not depend on the chunker reproducing identical boundaries across code changes. Accumulating failures (> 10 open) fire a Phase-A alert.

### C4. Entity profile staleness

Add `profile_generated_at` to entities. Auto-recall skips profiles older than 30 days (falls back to relation summary); the dream pass regenerates stale profiles for hot entities under its existing budget. Backfill: existing rows get the migration date — accurate in practice, since profiles were re-synthesized 2026-06-10.

---

## Shared infrastructure & sequencing

- A ships first: alert table + invariants + surfaces. B3/B4 and C3 emit through it.
- All phases follow existing conventions: collocated `*.test.ts` with `node:test`, integration-tick contract changes mirrored in skeleton docs where applicable.

## Non-goals

- Push channels beyond the macOS toast (ntfy/email) — alert history makes them easy later.
- Data-level staleness detection (healthy ticks, suspiciously empty data) — needs per-integration baselines; revisit with real alert-history data.
- LLM-judged run verification or recall-precision grading — valuable, but costs quota; revisit after the June billing change.
- Belief-head visualization tooling, `explain`/`update` MCP stubs, GitHub integration — separate efforts.
- Kuzu projection scheduling, interactive `robin init`.

## Testing

- Per-invariant unit tests with fault injection (clock-skewed staleness, skip streaks, persistent degraded streams, timed-out checks, boot-loop timestamps).
- **Power-state suppression tests:** offline/paused/incognito fire no staleness alerts; post-resume grace window honored.
- Verifier tests per handler with synthetic post-states, including the `did-work`-but-unverified mismatch path.
- Canonicalizer table-driven tests (slug pairs → expected merge/no-merge), plus lookup-symmetry tests (`recall_belief` on pre-merge topic strings resolves post-merge heads).
- One end-to-end test per phase: stale integration → open alert → recovery → auto-resolve; no-op pre-check → run skipped; duplicate-topic promote → single head.

## Risks

- **Alert fatigue:** thresholds deliberately loose (3×/10× cadence) + dedup-by-key + auto-resolve + power-state suppression. Tune via policies.yaml, not code.
- **Structured-output regressions:** the Agent SDK structured-output path was only recently fixed (3 fixes, 2026-06-09); B1 leans on it heavily. Mitigation: envelope kept flat/simple; `maxTurns` headroom; handlers fall back to prose summary + `outcome: unparseable` rather than failing the run.
- **Canonicalizer over-merge:** false merges are worse than duplicates. Mitigation: require BOTH slug match AND claim-text similarity; log every merge decision to the journal for the first two weeks.
- **B's new write capability:** granting handler B the `ingest` action widens an autonomous read-only surface. Scope is one MCP tool that writes memory events only (no files, no shell); ingested briefs flow through the normal biographer/hygiene pipeline rather than directly into beliefs.
