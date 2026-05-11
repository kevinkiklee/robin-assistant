# Theme 4 — Observability & introspection · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seven read-only MCP introspection tools (`explain_recall`, `explain_belief`, `explain_action_trust`, `show_pending_triggers`, `show_step_health`, `recent_refusals`, `archive_history`) and a `robin doctor --health` rollup view with thresholded exit codes. Zero new write paths.

**Architecture:** Read layer over the eight telemetry/audit tables produced by Themes 1–3 (and pre-existing ones). Lazy queries — no materialised rollups in v1. CLI-only health surface with `--json` for automation.

**Tech Stack:** Node.js 18+, SurrealDB 3.0.5.

**Spec:** `docs/superpowers/specs/2026-05-11-robin-v2-theme-4-observability-design.md`

**Dependencies:** All of Themes 1a, 1b, 1c, 2a, 2b, 3 must have landed (their tables are what this theme reads).

---

## File structure

| File | Responsibility |
|---|---|
| `src/schema/migrations/0001-init.surql` | Seed `runtime:doctor.config` |
| `src/cli/health.js` (new) | Rollup helpers; `robin doctor --health` implementation |
| `src/cli/commands/doctor.js` (modify) | Wire `--health` flag |
| `src/mcp/tools/explain-recall.js` (new) | Read `recall_log` + `intuition_telemetry` |
| `src/mcp/tools/explain-belief.js` (new) | Read memo + `evidence_ledger` + edges |
| `src/mcp/tools/explain-action-trust.js` (new) | Read `action_trust` + `action_trust_ledger` |
| `src/mcp/tools/show-pending-triggers.js` (new) | Read `dream_triggers WHERE processed_at IS NONE` |
| `src/mcp/tools/show-step-health.js` (new) | Aggregate `cadence_telemetry` |
| `src/mcp/tools/recent-refusals.js` (new) | Read `refusals` |
| `src/mcp/tools/archive-history.js` (new) | Read `archive_log` |
| `src/daemon/server.js` (modify) | Register seven new MCP tools |
| Tests for each tool + readonly-audit + privacy-redaction + exit-codes |

---

## Phase 1 — Config + audit safety nets

### Task 1: Seed runtime:doctor.config

**Files:** `src/schema/migrations/0001-init.surql`

- [ ] **Step 1: Append seed**

```surql
UPSERT runtime:doctor.config CONTENT {
  value: {
    budget_warn_pct: 0.85,
    budget_fail_pct: 0.98,
    pending_triggers_warn: 50,
    faculty_error_rate_warn: 0.01,
    faculty_error_rate_fail: 0.05,
    stale_dream_warn_hours: 30
  }
};
```

- [ ] **Step 2: Run migration → clean; commit**

```bash
git commit -m "feat(schema): seed runtime:doctor.config"
```

### Task 2: Audit-grep test for read-only enforcement

**Files:** `tests/unit/introspection-tools-readonly.test.js`

- [ ] **Step 1: Write the audit test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const INTROSPECTION_TOOL_FILES = [
  'src/mcp/tools/explain-recall.js',
  'src/mcp/tools/explain-belief.js',
  'src/mcp/tools/explain-action-trust.js',
  'src/mcp/tools/show-pending-triggers.js',
  'src/mcp/tools/show-step-health.js',
  'src/mcp/tools/recent-refusals.js',
  'src/mcp/tools/archive-history.js',
];

const FORBIDDEN = ['CREATE ', 'UPDATE ', 'DELETE ', 'UPSERT '];

test('introspection tools never write to DB', () => {
  for (const f of INTROSPECTION_TOOL_FILES) {
    if (!fs.existsSync(f)) continue;            // tool not yet created; skip
    const src = fs.readFileSync(f, 'utf8');
    for (const kw of FORBIDDEN) {
      assert.ok(!src.includes(kw),
        `${f} contains forbidden write keyword '${kw.trim()}'`);
    }
  }
});
```

The test is skip-tolerant initially (tools created in later tasks). Once a tool lands, the file is checked.

- [ ] **Step 2: Commit**

```bash
git commit -m "test(introspection): readonly-audit gate"
```

---

## Phase 2 — Per-tool implementations

### Task 3: explain_recall

**Files:** `src/mcp/tools/explain-recall.js`, `tests/unit/explain-recall.test.js`

- [ ] **Step 1: Failing test**

```js
test('explain_recall returns ranked hits + score components + sources for last_n=1', async () => {
  const db = await openMemDb();
  // seed: one recall_log row + matching intuition_telemetry row
  const tool = createExplainRecallTool({ db });
  const out = await tool.handler({});
  assert.ok(Array.isArray(out.queries));
  assert.equal(out.queries.length, 1);
  assert.ok('ranked_hits' in out.queries[0]);
  assert.ok('score_components' in out.queries[0].ranked_hits[0]);
});

test('explain_recall strips private-scope hits (Theme 1c gate)', async () => {
  // seed recall_log including a private memo hit
  // assert that hit absent from agent-facing payload
});
```

- [ ] **Step 2: Implement**

```js
// src/mcp/tools/explain-recall.js
import { surql } from 'surrealdb';
import { isOutboundBlocked } from '../../memory/scope-registry.js';

export function createExplainRecallTool({ db }) {
  return {
    name: 'explain_recall',
    description: 'Explain how Robin selected hits for a recall query.',
    inputSchema: {
      type: 'object',
      properties: {
        query_id: { type: 'string' },
        last_n:   { type: 'integer', default: 1 },
      },
    },
    async handler({ query_id, last_n = 1 }) {
      const rowsQuery = query_id
        ? surql`SELECT * FROM ${query_id}`
        : surql`SELECT * FROM recall_log ORDER BY ts DESC LIMIT ${last_n}`;
      const [rows] = await db.query(rowsQuery).collect();
      const queries = [];
      for (const r of rows ?? []) {
        // hydrate scope per hit; redact private
        const hits = [];
        for (const h of r.ranked_hits ?? []) {
          const recId = h.record_id ?? h.memo_id ?? h.record;
          if (!recId) continue;
          const [m] = await db.query(surql`SELECT id, scope FROM ${recId}`).collect();
          if (m?.[0] && isOutboundBlocked(m[0].scope)) continue;   // private skipped
          hits.push({ ...h, scope: m?.[0]?.scope ?? 'unknown' });
        }
        queries.push({
          query_id: String(r.id),
          ts: r.ts,
          query: r.query,
          outcome: r.outcome,
          ranked_hits: hits,
        });
      }
      return { queries };
    },
  };
}
```

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "feat(mcp): explain_recall introspection tool"
```

### Task 4: explain_belief

**Files:** `src/mcp/tools/explain-belief.js`, `tests/unit/explain-belief.test.js`

- [ ] **Step 1: Failing test**

```js
test('explain_belief returns memo + ledger replay + supersedes/contradicts edges', async () => {
  // seed memo + 2 corroborates + 1 refutes
  const out = await tool.handler({ memo_id: id });
  assert.equal(out.evidence.length, 3);
  assert.ok(out.derived_confidence >= 0 && out.derived_confidence <= 1);
  assert.ok('formula' in out);
});

test('private memo content redacted in explain_belief', async () => { … });
```

- [ ] **Step 2: Implement**

```js
// src/mcp/tools/explain-belief.js
import { surql } from 'surrealdb';
import { isOutboundBlocked } from '../../memory/scope-registry.js';

export function createExplainBeliefTool({ db }) {
  return {
    name: 'explain_belief',
    description: 'For a memo, show how its confidence got to its current value.',
    inputSchema: { type: 'object', properties: { memo_id: { type: 'string' } }, required: ['memo_id'] },
    async handler({ memo_id }) {
      const [memo] = await db.query(surql`SELECT * FROM ${memo_id}`).collect();
      const m = memo?.[0];
      if (!m) return { error: 'memo not found' };
      const redacted = isOutboundBlocked(m.scope);
      const [evidence] = await db.query(surql`
        SELECT * FROM evidence_ledger WHERE memo_id = ${memo_id} ORDER BY ts ASC
      `).collect();
      const [supersedes] = await db.query(surql`
        SELECT * FROM edges WHERE (in = ${memo_id} OR out = ${memo_id}) AND kind IN ['supersedes','contradicts']
      `).collect();
      const [derived] = await db.query(surql`SELECT VALUE fn::derived_confidence(${memo_id})`).collect();
      return {
        memo_id: String(m.id),
        kind: m.kind,
        content: redacted ? '<redacted: private scope>' : m.content,
        confidence_stored: m.confidence,
        derived_confidence: derived?.[0] ?? null,
        signal_count: m.signal_count,
        evidence: (evidence ?? []).map(e => ({
          polarity: e.polarity, reason: e.reason, weight: e.weight, ts: e.ts,
        })),
        edges: supersedes ?? [],
        formula: '(initial × prior_weight + Σcor)/(prior_weight + Σcor + Σref)',
      };
    },
  };
}
```

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "feat(mcp): explain_belief introspection tool"
```

### Task 5: explain_action_trust

**Files:** `src/mcp/tools/explain-action-trust.js`, `tests/unit/explain-action-trust.test.js`

- [ ] **Step 1: Failing test**

```js
test('explain_action_trust returns current state + full ledger', async () => {
  // seed setActionTrust + recordOutcome sequence
  const out = await tool.handler({ class: 'gmail:send' });
  assert.equal(out.current.state, /* expected */);
  assert.ok(out.history.length >= 2);
});
```

- [ ] **Step 2: Implement**

```js
export function createExplainActionTrustTool({ db }) {
  return {
    name: 'explain_action_trust',
    description: 'For a tool:action class, return current state + ledger history.',
    inputSchema: { type: 'object', properties: { class: { type: 'string' } }, required: ['class'] },
    async handler({ class: cls }) {
      const [cur] = await db.query(surql`SELECT * FROM action_trust WHERE class = ${cls}`).collect();
      const [hist] = await db.query(surql`
        SELECT * FROM action_trust_ledger WHERE class = ${cls} ORDER BY ts ASC
      `).collect();
      return { current: cur?.[0] ?? null, history: hist ?? [] };
    },
  };
}
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(mcp): explain_action_trust introspection tool"
```

### Task 6: show_pending_triggers

**Files:** `src/mcp/tools/show-pending-triggers.js`, `tests/unit/show-pending-triggers.test.js`

- [ ] **Step 1: Test + impl**

```js
export function createShowPendingTriggersTool({ db }) {
  return {
    name: 'show_pending_triggers',
    description: 'List unprocessed dream_triggers (queue depth + ages).',
    inputSchema: { type: 'object', properties: { step: { type: 'string' }, limit: { type: 'integer', default: 50 } } },
    async handler({ step, limit = 50 }) {
      const where = step ? `AND step = '${step}'` : '';
      const [rows] = await db.query(`
        SELECT * FROM dream_triggers WHERE processed_at IS NONE ${where}
        ORDER BY requested_at ASC LIMIT ${limit}
      `).collect();
      return { pending: rows, count: rows?.length ?? 0 };
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(mcp): show_pending_triggers"
```

### Task 7: show_step_health

**Files:** `src/mcp/tools/show-step-health.js`, `tests/unit/show-step-health.test.js`

- [ ] **Step 1: Test + impl**

```js
export function createShowStepHealthTool({ db }) {
  return {
    name: 'show_step_health',
    description: 'Per-step rollup of cadence_telemetry over a window.',
    inputSchema: { type: 'object', properties: { since: { type: 'string' } } },
    async handler({ since }) {
      const cutoff = since ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
      const [rows] = await db.query(surql`
        SELECT step,
               count() AS n,
               math::sum(IF success THEN 1 ELSE 0 END) AS successes,
               math::mean(duration_ms) AS avg_duration_ms,
               math::mean(tokens_in + tokens_out) AS avg_tokens
        FROM cadence_telemetry
        WHERE ts > ${cutoff}
        GROUP BY step
      `).collect();
      return { since: cutoff, steps: rows ?? [] };
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(mcp): show_step_health"
```

### Task 8: recent_refusals + archive_history

**Files:** `src/mcp/tools/recent-refusals.js`, `archive-history.js`

- [ ] **Step 1: Tests**

- [ ] **Step 2: Implement**

```js
// recent-refusals.js
export function createRecentRefusalsTool({ db }) {
  return {
    name: 'recent_refusals',
    description: 'List recent discretion refusals.',
    inputSchema: { type: 'object', properties: { direction: { type: 'string' }, since: { type: 'string' }, limit: { type: 'integer', default: 50 } } },
    async handler({ direction, since, limit = 50 }) {
      const filters = [];
      const bindings = { limit };
      if (direction) { filters.push('direction = $direction'); bindings.direction = direction; }
      if (since)     { filters.push('created_at > $since');    bindings.since = since; }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const [rows] = await db.query(`SELECT * FROM refusals ${where} ORDER BY created_at DESC LIMIT $limit`, bindings).collect();
      return { refusals: rows };
    },
  };
}

// archive-history.js
export function createArchiveHistoryTool({ db }) {
  return {
    name: 'archive_history',
    description: 'Audit trail of archive/restore events for memos.',
    inputSchema: { type: 'object', properties: { memo_id: { type: 'string' }, limit: { type: 'integer', default: 100 } } },
    async handler({ memo_id, limit = 100 }) {
      const where = memo_id ? `WHERE memo_id = ${memo_id}` : '';
      const [rows] = await db.query(`SELECT * FROM archive_log ${where} ORDER BY ts DESC LIMIT ${limit}`).collect();
      return { history: rows };
    },
  };
}
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(mcp): recent_refusals + archive_history"
```

### Task 9: Register all seven tools in daemon

**Files:** `src/daemon/server.js`

- [ ] **Step 1: Add imports + register calls**

```js
import { createExplainRecallTool } from '../mcp/tools/explain-recall.js';
// ... (six more)

const tools = [
  // existing tools …
  createExplainRecallTool({ db }),
  createExplainBeliefTool({ db }),
  createExplainActionTrustTool({ db }),
  createShowPendingTriggersTool({ db }),
  createShowStepHealthTool({ db }),
  createRecentRefusalsTool({ db }),
  createArchiveHistoryTool({ db }),
];
```

- [ ] **Step 2: Run audit test (Task 2) → should now check all seven files**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(daemon): register Theme 4 introspection tools"
```

---

## Phase 3 — `robin doctor --health`

### Task 10: Rollup helpers

**Files:** `src/cli/health.js`, `tests/unit/health-rollups.test.js`

- [ ] **Step 1: Failing tests**

```js
test('rollupTokenBudget returns consumed + remaining + status (ok/warn/fail)', async () => { … });
test('rollupFacultyErrors aggregates cadence_telemetry per step over window', async () => { … });
test('rollupPendingTriggers counts unprocessed', async () => { … });
test('rollupStaleDream computes hours since last nightly run', async () => { … });
```

- [ ] **Step 2: Implement helpers**

```js
// src/cli/health.js
import { surql } from 'surrealdb';
import { currentBudget } from '../dream/budget.js';

async function readDoctorConfig(db) {
  const [r] = await db.query(`SELECT VALUE value FROM runtime:doctor.config`).collect();
  return r?.[0];
}

export async function rollupTokenBudget(db) {
  const cfg = await readDoctorConfig(db);
  const [cadenceCfg] = await db.query(`SELECT VALUE value FROM runtime:cadence.config`).collect();
  const budget = await currentBudget(db, cadenceCfg?.[0] ?? {});
  const pct = budget.daily === 0 ? 0 : budget.consumed / budget.daily;
  let status = 'ok';
  if (pct >= cfg.budget_fail_pct) status = 'fail';
  else if (pct >= cfg.budget_warn_pct) status = 'warn';
  return { consumed: budget.consumed, daily: budget.daily, pct, status };
}

export async function rollupFacultyErrors(db, hours = 7 * 24) {
  const [rows] = await db.query(surql`
    SELECT step,
           count() AS n,
           math::sum(IF success THEN 0 ELSE 1 END) AS errors
    FROM cadence_telemetry
    WHERE ts > time::now() - ${hours}h
    GROUP BY step
  `).collect();
  const cfg = await readDoctorConfig(db);
  return (rows ?? []).map(r => {
    const rate = r.n === 0 ? 0 : r.errors / r.n;
    let status = 'ok';
    if (rate >= cfg.faculty_error_rate_fail) status = 'fail';
    else if (rate >= cfg.faculty_error_rate_warn) status = 'warn';
    return { ...r, rate, status };
  });
}

export async function rollupPendingTriggers(db) {
  const cfg = await readDoctorConfig(db);
  const [r] = await db.query(`SELECT count() AS n FROM dream_triggers WHERE processed_at IS NONE GROUP ALL`).collect();
  const n = r?.[0]?.n ?? 0;
  return { count: n, status: n >= cfg.pending_triggers_warn ? 'warn' : 'ok' };
}

export async function rollupStaleDream(db) {
  const cfg = await readDoctorConfig(db);
  const [r] = await db.query(`SELECT value.last_run_at_success AS ts FROM runtime:dream`).collect();
  const lastRun = r?.[0]?.ts;
  if (!lastRun) return { hours_since: null, status: 'warn' };
  const hours = (Date.now() - new Date(lastRun).getTime()) / 3_600_000;
  return { hours_since: hours, status: hours >= cfg.stale_dream_warn_hours ? 'warn' : 'ok' };
}

export function aggregateExitCode(rollups) {
  if (rollups.some(r => r.status === 'fail')) return 2;
  if (rollups.some(r => r.status === 'warn')) return 1;
  return 0;
}
```

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "feat(cli): health.js rollup helpers"
```

### Task 11: doctor --health command

**Files:** `src/cli/commands/doctor.js`, `tests/integration/doctor-health-exit-codes.test.js`

- [ ] **Step 1: Failing test (exit codes 0/1/2)**

```js
test('doctor --health exits 0 with all-OK fixture', async () => { … });
test('doctor --health exits 1 with warn fixture (one faculty above warn threshold)', async () => { … });
test('doctor --health exits 2 with fail fixture (budget above fail threshold)', async () => { … });
test('doctor --health --json outputs stable schema', async () => { … });
```

- [ ] **Step 2: Implement**

In `doctor.js`:

```js
import {
  rollupTokenBudget, rollupFacultyErrors, rollupPendingTriggers, rollupStaleDream, aggregateExitCode,
} from '../health.js';

export async function doctor(args) {
  if (args.includes('--health')) {
    return await healthMode(args);
  }
  // existing doctor checks …
}

async function healthMode(args) {
  const db = await openDb();
  const rollups = await Promise.all([
    rollupTokenBudget(db),
    rollupFacultyErrors(db),
    rollupPendingTriggers(db),
    rollupStaleDream(db),
  ]);
  const exitCode = aggregateExitCode([rollups[0], ...rollups[1], rollups[2], rollups[3]]);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ budget: rollups[0], faculties: rollups[1], pending: rollups[2], dream: rollups[3] }, null, 2));
  } else {
    printHealthReport(rollups);
  }
  process.exit(exitCode);
}

function printHealthReport([budget, faculties, pending, dream]) {
  console.log(`=== Robin health · ${new Date().toISOString().slice(0,10)} ===`);
  console.log(`Token budget:        ${statusGlyph(budget.status)} ${Math.round(budget.consumed)}k / ${Math.round(budget.daily)}k used (${Math.round(budget.pct * 100)}%)`);
  console.log(`Pending triggers:    ${statusGlyph(pending.status)} ${pending.count}`);
  console.log(`Dream nightly:       ${statusGlyph(dream.status)} ${dream.hours_since == null ? 'never' : `${Math.round(dream.hours_since)}h ago`}`);
  console.log('Faculty error rate (7d):');
  for (const f of faculties) {
    console.log(`  ${f.step.padEnd(20)} ${statusGlyph(f.status)} ${f.errors}/${f.n} errors`);
  }
}

const statusGlyph = (s) => ({ ok: '✓', warn: '⚠', fail: '✗' })[s] ?? '?';
```

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "feat(cli): robin doctor --health with exit codes"
```

---

## Phase 4 — Privacy + gates + docs

### Task 12: introspection-private-redaction test

**Files:** `tests/unit/introspection-private-redaction.test.js`

- [ ] **Step 1: Comprehensive test**

For each of `explain_recall`, `explain_belief`, `archive_history` (the three that touch memo content):

```js
test('<tool> redacts/strips private-scope memos', async () => {
  // seed private memo + recall_log/evidence_ledger/archive_log reference
  // call tool
  // assert content masked OR memo skipped
});
```

- [ ] **Step 2: Commit**

```bash
git commit -m "test(introspection): private-scope redaction across tools"
```

### Task 13: Lazy-rollup latency gate

**Files:** `tests/integration/doctor-health-latency.test.js`

- [ ] **Step 1: Test**

```js
test('robin doctor --health completes in ≤500ms at 100k telemetry rows', async () => {
  const db = await openMemDb();
  // seed 100k synthetic cadence_telemetry rows
  const t0 = Date.now();
  await healthMode(['--health', '--json']);
  assert.ok(Date.now() - t0 <= 500);
});
```

- [ ] **Step 2: Commit**

```bash
git commit -m "test(health): lazy rollup latency gate"
```

### Task 14: Verification gates 1–10 from spec §4

1. `explain_recall` shape (Task 3)
2. `explain_belief` reproduces derived_confidence (Task 4)
3. `explain_action_trust` shape (Task 5)
4. `show_pending_triggers` count matches DB (Task 6)
5. `show_step_health` rates match (Task 7)
6. `--health` exit codes (Task 11)
7. Latency (Task 13)
8. Read-only audit (Task 2)
9. Private redaction (Task 12)
10. `--json` schema stable (snapshot test)

One commit per remaining gate.

### Task 15: Docs

**Files:** `docs/architecture.md`, `docs/faculties.md`

- [ ] Add "Observability" section to architecture.
- [ ] Add introspection-tools overview to faculties.

```bash
git commit -m "docs(observability): introspection + health surface"
```

## Self-review

- [ ] 10 spec gates covered.
- [ ] No placeholders.
- [ ] Seven MCP tools registered in daemon.
- [ ] Audit test enforces zero writes from introspection files.
- [ ] `--json` output schema snapshot test exists.

## Final commit

```bash
git push -u origin feat/theme-4-observability
gh pr create --title "Theme 4: Observability + introspection"
```
