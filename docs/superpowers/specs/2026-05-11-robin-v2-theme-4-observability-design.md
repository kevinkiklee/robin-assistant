# Robin v2 — Theme 4: Observability & introspection

**Status:** Design (working draft; impl waits for predecessor themes 1a–3 to land)
**Date:** 2026-05-11
**Umbrella:** `2026-05-11-robin-v2-evolution-roadmap.md` (Theme 4)
**Depends on:** Themes 1a / 1b / 1c / 2a / 2b / 3 — Theme 4 reads tables they introduce.

## Why

After Themes 1–3 land, Robin will have eight append-only telemetry/audit tables and several derived state caches. **The data is all there. Theme 4 is the read layer.**

Two gaps to fill:

1. **Agent-facing introspection.** Robin can't (today) answer "why did you retrieve this?", "what do you believe about X and how confident?", or "show me how this trust state evolved." All the data exists; no MCP tool surfaces it.
2. **Operator health view.** `robin doctor` runs point checks (DB connection, schema version, embedder reachability). No continuous-health rollup over the telemetry tables; no thresholded warnings.

## Goals

- Add seven read-only MCP introspection tools.
- Extend `robin doctor` with a `--health` rollup view + exit codes for cron monitoring.
- Stay read-only (no new write paths; no new schema beyond a single config row).
- Lazy reads — no materialisation in v1 (single-user scale makes ad-hoc queries fast enough).

## Non-goals

- Web dashboard.
- Real-time streaming subscriptions (`LIVE SELECT`).
- Unifying the eight telemetry tables into one. Their shapes diverge; the join cost at read time is small; unifying is schema cost without read-side win.
- Persistent `health_rollups` materialisation in v1.
- `show_reasoning` MCP tool — depends on `kind='reasoning'` memo writer, which is still deferred from the redesign.

## Anchoring decisions

**Why keep the eight tables separate:**
- Each has different shape (`evidence_ledger.memo_id` vs `action_trust_ledger.class` vs `refusals.direction`).
- Each has different write frequency and index requirements.
- A unified table forces lowest-common-denominator schema or a giant `FLEXIBLE meta`.
- Union-at-read is fast at single-user volumes; cheap to refactor later if needed.

**Why lazy reads, not materialised rollups:**
- Single-user telemetry volume tops out around 100k rows/year. Indexed SELECTs return in ms.
- Materialised rollups add a daily write path and a freshness question (stale vs current).
- If volume blows up, drop a `health_rollups` table in as cache without touching the read API. Lazy first.

**Why CLI for operator health, not a web UI:**
- Robin is a CLI-first tool. `robin doctor --health` matches existing UX.
- Exit codes (0/1/2) enable cron-watching with no extra plumbing.
- A web UI can layer on later via `--json` output as the stable API.

**Why introspection tools are agent-facing (not CLI-only):**
- The agent (Claude/Gemini in a session) often needs to know why Robin retrieved or believes something to give the user a good answer.
- Read-only and bounded; no risk of agent abuse.
- CLI commands are added as thin wrappers around the same logic.

## Section 1 — MCP introspection tools

All read-only. All bounded by a `limit` parameter where applicable.

```js
// src/mcp/tools/explain-recall.js
{
  name: 'explain_recall',
  description: "Explain how Robin selected hits for a recall query (ranked hits, score components, sources, reinforcement outcome).",
  inputSchema: {
    type: 'object',
    properties: {
      query_id: { type: 'string', description: 'recall_log row id; omit for most recent' },
      last_n:   { type: 'integer', default: 1 },
    },
  },
}

// explain-belief.js
{
  name: 'explain_belief',
  description: 'For a memo, show how its confidence got to its current value: evidence ledger replay, supersedes/contradicts edges, derivation formula.',
  inputSchema: { type: 'object', properties: { memo_id: { type: 'string' } }, required: ['memo_id'] },
}

// explain-action-trust.js
{
  name: 'explain_action_trust',
  description: 'For a tool:action class, return current state and full ledger history with reasons.',
  inputSchema: { type: 'object', properties: { class: { type: 'string' } }, required: ['class'] },
}

// show-pending-triggers.js
{
  name: 'show_pending_triggers',
  description: 'List unprocessed dream_triggers (queue depth + ages).',
  inputSchema: { type: 'object', properties: { step: { type: 'string' }, limit: { type: 'integer', default: 50 } } },
}

// show-step-health.js
{
  name: 'show_step_health',
  description: 'Per-step rollup of cadence_telemetry over a recent window: success rate, avg duration, avg tokens.',
  inputSchema: { type: 'object', properties: { since: { type: 'string', description: 'ISO datetime; default now-7d' } } },
}

// recent-refusals.js
{
  name: 'recent_refusals',
  description: 'List recent discretion refusals (inbound/outbound), with reason and tool.',
  inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['inbound','outbound'] }, since: { type: 'string' }, limit: { type: 'integer', default: 50 } } },
}

// archive-history.js
{
  name: 'archive_history',
  description: 'Audit trail of archive/restore events for memos.',
  inputSchema: { type: 'object', properties: { memo_id: { type: 'string' }, limit: { type: 'integer', default: 100 } } },
}
```

### Privacy guard

`explain_recall` strips `scope='private'` hits before returning to the agent (consistent with Theme 1c's outbound-block policy). Other tools that may surface private memo IDs (`explain_belief`, `archive_history`) include a `redacted: true` flag in place of content when the memo is private.

Audit test (`introspection-private-redaction.test.js`) seeds private memos in each surface and asserts they're masked.

## Section 2 — `robin doctor --health`

Extends the existing `src/cli/commands/doctor.js` with a `--health` mode:

```
$ robin doctor --health

=== Robin health · 2026-05-11 ===
Reinforcement loop:           ✓ 142 pending → reinforced (last 24h)
Cadence consumer:             ✓ 18 triggers processed, 2 budget-skipped (last 24h)
Token budget:                 ⚠ 89k / 100k used (89%; budget at 100k)
Dream nightly:                ✓ last run 2026-05-10T04:00Z (8 steps OK)
Schema migrations:            ✓ up to date (0001-init applied)
Engine:                       ✓ surrealkv+versioned at <robinHome>/db/
Faculty error rate (7d):
  reflection                  ✓ 0/12 errors
  comm-style                  ✓ 0/4 errors
  calibration                 ✓ 0/2 errors
  biographer                  ⚠ 2/142 errors (1.4%)
Pending action_trust DENYs:   1 class blocked (spotify_write:queue, since 2026-05-09)
Archive growth:               ✓ 47 memos archived this month (within bounds)

Exit code: 1 (one ⚠ warning)
```

Exit codes:
- 0 — all green
- 1 — at least one warning (yellow)
- 2 — at least one failure (red)

Thresholds in `runtime:doctor.config`:

```json
{
  "budget_warn_pct": 0.85,
  "budget_fail_pct": 0.98,
  "pending_triggers_warn": 50,
  "faculty_error_rate_warn": 0.01,
  "faculty_error_rate_fail": 0.05,
  "stale_dream_warn_hours": 30
}
```

`--health --json` outputs the same data as machine-readable JSON for cron/dashboard consumption.

## Section 3 — Cost envelope

- Zero new LLM tokens.
- Zero new embeddings.
- Per `explain_*` invocation: a few indexed SELECTs + JS-side aggregation. Sub-200ms at 100k row scale.
- `robin doctor --health`: ~10 queries; ~500ms total at 100k row scale.
- No write path; no per-tick overhead.

Well within roadmap §4 envelope (which it would be anyway, since the envelope is about LLM tokens).

## Section 4 — Verification gates

1. **`explain_recall(query_id)` returns** ranked hits, score components, sources, reinforcement outcome.
2. **`explain_belief(memo_id)` reproduces `fn::derived_confidence`** from ledger replay (matches stored `confidence` ±0.001).
3. **`explain_action_trust(class)` returns** current state + every ledger row in chronological order + reasons.
4. **`show_pending_triggers` count** matches `SELECT count() FROM dream_triggers WHERE processed_at IS NONE`.
5. **`show_step_health` per-step rates** match hand-aggregated `cadence_telemetry` over the window.
6. **`robin doctor --health` exit codes:** synthetic fixtures cover all three (0/1/2).
7. **Lazy rollup latency:** with 100k synthetic telemetry rows, `robin doctor --health` ≤ 500ms.
8. **Read-only:** audit-grep test (`introspection-tools-readonly.test.js`) forbids `CREATE`/`UPDATE`/`DELETE` in introspection-tool source files.
9. **No sensitive-scope leak:** `explain_recall` strips `private` hits; `explain_belief` / `archive_history` redact private memo content.
10. **`--health --json` schema-stable:** snapshot test on a synthetic fixture; future schema changes deliberately break the test.

## Section 5 — File-by-file

**Created:**
- `src/mcp/tools/explain-recall.js`, `explain-belief.js`, `explain-action-trust.js`.
- `src/mcp/tools/show-pending-triggers.js`, `show-step-health.js`.
- `src/mcp/tools/recent-refusals.js`, `archive-history.js`.
- `src/cli/health.js` — `robin doctor --health` implementation.
- `tests/unit/explain-recall.test.js`
- `tests/unit/explain-belief.test.js`
- `tests/unit/explain-action-trust.test.js`
- `tests/unit/introspection-private-redaction.test.js`
- `tests/unit/introspection-tools-readonly.test.js`
- `tests/integration/doctor-health-exit-codes.test.js`

**Modified:**
- `src/schema/migrations/0001-init.surql` — seed `runtime:doctor.config`.
- `src/cli/commands/doctor.js` — add `--health` and `--health --json` flags.
- `src/daemon/server.js` — register the seven new MCP tools.
- `docs/architecture.md` — observability section.
- `docs/faculties.md` — introspection overview.

## Section 6 — Sequencing within Theme 4

1. **Lazy rollup helpers** — `src/cli/health.js`. SELECTs + aggregation; testable standalone.
2. **`robin doctor --health`** flag + JSON output.
3. **MCP introspection tools** — seven files; one PR per cluster (recall/belief/action-trust as one; queue/health as another; refusals/archive as the third).
4. **Privacy redaction** — `introspection-private-redaction.test.js` + per-tool guards.
5. **Audit grep test** — readonly enforcement.
6. **`runtime:doctor.config` seed** + threshold defaults.

Earlier waves can land independently — none are co-dependent.

## Section 7 — Dependencies

- **Waits for Themes 1a, 1b, 1c, 2a, 2b, 3** — Theme 4 reads their tables. Landing 4 first means most tools have nothing to read.
- **Last in the roadmap §6 sequence.** Or can land in slices alongside each theme: `explain_recall` after Theme 3, `explain_belief` after 2a, etc.
- Independent of `feat/surrealdb-improvements` mechanically, but the predecessor themes are all gated on it.

## Section 8 — Open questions (post-impl review)

- **Web dashboard.** Out of scope v1. If Next.js dashboard later, `robin doctor --health --json` is the stable API.
- **Streaming subscriptions.** SurrealDB v3 `LIVE SELECT` could power real-time views. Out of scope; flag.
- **`show_reasoning` MCP tool.** Reserved for when `kind='reasoning'` memo writer lands (deferred from redesign).
- **Materialised rollups.** Add `health_rollups` table later if lazy queries slow down past acceptable.
- **Per-tool sensitive-scope policy.** v1: `explain_recall` strips private; other tools redact content but expose IDs. Tighten per-tool as use cases surface.
- **Agent memory-hygiene tools.** Theme 1c roadmap mentioned `mark-private`, `flag-duplicate`, `request-deletion` agent tools. Decided to skip in v1 (every write tool the agent has should already be auditable; one more layer is gilt). Defer.

## See also

- `2026-05-11-robin-v2-evolution-roadmap.md` — umbrella.
- All Theme 1–3 specs — each describes the table this theme reads.
- `src/cli/commands/doctor.js` — current health surface that gets extended.
