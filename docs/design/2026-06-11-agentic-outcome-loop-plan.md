# Agentic Outcome Loop (Phase B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every autonomous agent run reports a structured outcome envelope, gets verified deterministically (no LLM judge), and the scheduler adapts — pre-checks skip pointless runs, 3-strike failures bench a handler and fire a Phase-A alert, and `robin metrics --agents` answers "which handlers earn their budget".

**Architecture:** All 12 handlers declare a shared `outputFormat` envelope (the SDK structured-output path in `run-agent.ts` → `result.structured` already works). `agent_usage` (migration 011) gains outcome columns; `runner-entry.ts` parses the envelope after each autonomous run, runs a deterministic per-handler verifier, persists outcome+verified onto the run's ledger row, and writes a learning record. The `agent-runner` job gains pre-checks (cheap DB/file queries before spawning the SDK) and bench state (3 consecutive failures → benched 3 rotations → Phase-A alert via `recordAlert`). New surfaces read the ledger.

**Tech Stack:** TypeScript ESM (Node 24), better-sqlite3 via `RobinDb`, `node:test` + `node:assert/strict` collocated tests, zod v4, alert-store from Phase A (`system/kernel/runtime/alert-store.ts`).

**Spec:** `docs/design/2026-06-10-trust-feedback-memory-design.md` (Phase B, §B1–B5).

**Conventions for every task:** run a single test file with `pnpm exec tsx --test <file>`; full gates at the end are `pnpm lint && pnpm typecheck && pnpm test` (4 pre-existing failures are known and not ours: spotify ×2, ebird, recall). Commit after each task to `main`, author email `kevin.kik.lee@gmail.com`. The pre-commit hook auto-formats — **never `git add -A`** (the autonomous daemon edits this tree concurrently and has its own uncommitted WIP, e.g. `weather/*`); always stage explicit paths.

**Decisions baked into this plan** (read before implementing; each is deliberate):

1. **Handler B leaves `plan` mode.** The spec says "plan-mode stays otherwise", but the Agent SDK's permission pipeline evaluates plan mode *before* `allowedTools`, so an allowlisted MCP write tool is still intercepted in plan mode (verified against the SDK permissions docs, 2026-06-11). The equivalent guarantee uses the pattern already documented in `run-agent.ts` lines 13–16: `permissionMode: 'default'` + the write builtins in `disallowedTools`. Net capability is exactly the spec's intent: web+read+ingest, no file or shell writes.
2. **E's verifier also accepts corrections.** Spec table says "belief_candidates rows appeared", but E's allowlist includes `mcp__robin__record_correction`, and a run that only recorded corrections did real work. Verifier E passes on candidates OR corrections; H stays candidates-only per spec.
3. **Autonomous K gets a worktree.** The spec's K verifier ("worktree branch exists with a diff") is only checkable if the detached runner creates one — today only the on-demand CLI does, so autonomous K currently edits the live checkout. `runner-entry` gains the same create/prune-if-unchanged worktree flow as `robin agent`, applied to write handlers whose cwd is the repo root (K; not D/G, whose cwd is the gitignored knowledge dir).
4. **Vocabulary:** `outcome` ∈ `did-work | no-op | blocked | unparseable` (envelope; `unparseable` when structured output is missing/invalid — the spec's fallback). `verified` ∈ `verified | outcome-mismatch | unverifiable | NULL` (NULL when outcome ≠ did-work, i.e. nothing was claimed). A benching "failure" is `status IN ('error','timeout') OR verified = 'outcome-mismatch'`.
5. **Timestamp normalization:** `events.ts`/`belief_candidates.created_at` use sqlite `datetime('now')` (`YYYY-MM-DD HH:MM:SS`, no zone) while `predictions.resolved_at` and the ledger use JS `toISOString()` (`...T...Z`). Every verifier/pre-check time comparison goes through sqlite `datetime(col) >= datetime(?)`, which parses both as UTC. This is the same bug class commit 1ae60f0-era "defensive UTC parse" fixed in the alerts CLI — do not compare these strings lexically.

---

### Task 1: Migration 025 — outcome columns on `agent_usage`

**Files:**
- Create: `system/brain/memory/migrations/025-agent-outcomes.ts`
- Modify: `system/brain/memory/migrations/index.ts`

Slot 025 is the next free number as of plan-writing (024 = alerts). **The autonomous loop also lands migrations — re-check `ls system/brain/memory/migrations/` before starting and renumber everywhere in this plan if taken.**

- [ ] **Step 1: Write the migration**

```typescript
// system/brain/memory/migrations/025-agent-outcomes.ts
import type { Migration } from './types.ts';

/**
 * Phase B (agentic outcome loop): structured outcome per agent run.
 *  - outcome:        did-work | no-op | blocked | unparseable (from the envelope)
 *  - impact:         high | medium | low (from the envelope)
 *  - structured_json: the raw structured output, verbatim, for audit
 *  - verified:       verified | outcome-mismatch | unverifiable (deterministic
 *                    post-condition check; NULL when nothing was claimed)
 * The (label, ts) index serves per-handler rollups (metrics --agents) and the
 * consecutive-failure streak query in the agent-runner's benching pass.
 */
export const migration025: Migration = {
  version: 25,
  name: 'agent-outcomes',
  up: (db) => {
    db.exec(`
      ALTER TABLE agent_usage ADD COLUMN outcome TEXT;
      ALTER TABLE agent_usage ADD COLUMN impact TEXT;
      ALTER TABLE agent_usage ADD COLUMN structured_json TEXT;
      ALTER TABLE agent_usage ADD COLUMN verified TEXT;
      CREATE INDEX IF NOT EXISTS idx_agent_usage_label_ts ON agent_usage(label, ts);
    `);
  },
};
```

- [ ] **Step 2: Register it**

In `system/brain/memory/migrations/index.ts`, add `import { migration025 } from './025-agent-outcomes.ts';` and append `migration025` to `allMigrations`.

- [ ] **Step 3: Verify migrations apply**

Run: `pnpm exec tsx --test system/brain/memory/migrations/runner.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add system/brain/memory/migrations/025-agent-outcomes.ts system/brain/memory/migrations/index.ts
git commit -m "feat(agents): agent_usage outcome columns + label index (migration 025)"
```

---

### Task 2: Outcome envelope module

**Files:**
- Create: `system/agent/outcome.ts`
- Test: `system/agent/outcome.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// system/agent/outcome.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OUTCOME_ENVELOPE_FORMAT, parseOutcomeEnvelope } from './outcome.ts';

test('format is an SDK json_schema outputFormat requiring outcome + impact', () => {
  assert.equal(OUTCOME_ENVELOPE_FORMAT.type, 'json_schema');
  const schema = OUTCOME_ENVELOPE_FORMAT.schema as Record<string, unknown>;
  assert.deepEqual(schema.required, ['outcome', 'impact']);
});

test('parses a full valid envelope', () => {
  const env = parseOutcomeEnvelope({
    outcome: 'did-work',
    changes: [{ type: 'note', summary: 'rewrote stale section' }],
    impact: 'medium',
    notes: 'one file touched',
  });
  assert.ok(env);
  assert.equal(env.outcome, 'did-work');
  assert.equal(env.impact, 'medium');
  assert.equal(env.changes?.length, 1);
});

test('parses a minimal envelope (outcome + impact only)', () => {
  const env = parseOutcomeEnvelope({ outcome: 'no-op', impact: 'low' });
  assert.ok(env);
  assert.equal(env.outcome, 'no-op');
});

test('handler-specific extension fields are tolerated', () => {
  const env = parseOutcomeEnvelope({ outcome: 'blocked', impact: 'low', sources: ['x'] });
  assert.ok(env);
});

test('invalid shapes return null, never throw', () => {
  assert.equal(parseOutcomeEnvelope(undefined), null);
  assert.equal(parseOutcomeEnvelope(null), null);
  assert.equal(parseOutcomeEnvelope('did-work'), null);
  assert.equal(parseOutcomeEnvelope({ outcome: 'partied', impact: 'low' }), null);
  assert.equal(parseOutcomeEnvelope({ outcome: 'did-work' }), null); // impact missing
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm exec tsx --test system/agent/outcome.test.ts`
Expected: FAIL — module `./outcome.ts` not found.

- [ ] **Step 3: Implement**

```typescript
// system/agent/outcome.ts
import { z } from 'zod';

/**
 * Common structured-outcome envelope every handler (A–L) requests via the SDK's
 * `outputFormat` (spec §B1). The same run is forced to summarize structurally at
 * the end — no extra LLM call. `additionalProperties: true` lets handlers extend
 * the envelope with handler-specific fields without schema churn.
 */
export const OUTCOME_ENVELOPE_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['did-work', 'no-op', 'blocked'] },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: { type: { type: 'string' }, summary: { type: 'string' } },
          required: ['type', 'summary'],
          additionalProperties: false,
        },
      },
      impact: { type: 'string', enum: ['high', 'medium', 'low'] },
      notes: { type: 'string' },
    },
    required: ['outcome', 'impact'],
    additionalProperties: true,
  },
} as const;

// zod v4: looseObject = tolerate unknown keys (handler-specific extensions).
const envelopeSchema = z.looseObject({
  outcome: z.enum(['did-work', 'no-op', 'blocked']),
  changes: z.array(z.object({ type: z.string(), summary: z.string() })).optional(),
  impact: z.enum(['high', 'medium', 'low']),
  notes: z.string().optional(),
});

export type OutcomeEnvelope = z.infer<typeof envelopeSchema>;

/** Validate a run's `result.structured` into an envelope; null on any mismatch (never throws). */
export function parseOutcomeEnvelope(structured: unknown): OutcomeEnvelope | null {
  const r = envelopeSchema.safeParse(structured);
  return r.success ? r.data : null;
}
```

- [ ] **Step 4: Run to verify pass** — same command, expected 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add system/agent/outcome.ts system/agent/outcome.test.ts
git commit -m "feat(agents): shared structured-outcome envelope (schema + parser)"
```

---

### Task 3: All handlers declare the envelope + turn headroom

**Files:**
- Modify: all 12 of `system/agent/handlers/{a-self-improvement,b-research,c-integration,d-kb-curation,e-belief-reconcile,f-prediction-calibrate,g-gap-fill,h-dream-enrich,i-life-executor,j-integration-author,k-health-remediate,l-daily-brief}.ts`
- Modify: their 12 collocated `*.test.ts` files

The SDK consumes extra turns to emit structured output (empirically ≥4 total; the 2026-06-09 structured-output fixes hit exactly this) — every handler's `maxTurns` gets **+2 headroom** as part of declaring the envelope (spec §B1). Current values: 20 → 22 (B, D, E, F, H, L), 25 → 27 (G, K), 30 → 32 (A). C, I, J: read the current value and add 2.

- [ ] **Step 1: Update each handler's test first.** Each test file asserts the exact `build()` config (see `b-research.test.ts` for the pattern). In each, bump the `maxTurns` expectation by 2 and add:

```typescript
import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
// inside the build() config test:
assert.equal(out.outputFormat, OUTCOME_ENVELOPE_FORMAT);
```

- [ ] **Step 2: Run one to verify fail** — `pnpm exec tsx --test system/agent/handlers/b-research.test.ts`
Expected: FAIL (outputFormat undefined, maxTurns 20 ≠ 22).

- [ ] **Step 3: Implement.** In each handler's `build()` return, add the import and two changes:

```typescript
import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
// in the returned object:
      maxTurns: 22,            // was 20: +2 structured-output headroom (spec §B1)
      outputFormat: OUTCOME_ENVELOPE_FORMAT,
```

Do NOT change anything else in this task (B's permission change is Task 4).

- [ ] **Step 4: Run all handler tests** — `pnpm exec tsx --test system/agent/handlers/*.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add system/agent/handlers/*.ts
git commit -m "feat(agents): all handlers emit the outcome envelope (+2 maxTurns headroom)"
```

---

### Task 4: Handler B — ingest-only write capability

**Files:**
- Modify: `system/agent/handlers/b-research.ts` + `b-research.test.ts`
- Modify: `system/agent/runner-entry.ts` (DEFAULT_GOALS.B)

Spec §B3's deliberate permission change: B's research briefs currently die in stderr (plan mode, no write surface), so no verifier could ever pass. B gains exactly one write: the `ingest` MCP action (writes a memory event; flows through the normal biographer pipeline). See plan decision 1 for why this swaps `plan` → `default`+`disallowedTools` rather than keeping plan mode.

- [ ] **Step 1: Update the test**

```typescript
// b-research.test.ts — replace the build() config test body
test('B: build() config — read-only except the ingest MCP action', () => {
  const out = handler.build('research SQLite WAL', { repoRoot: '/repo' });
  assert.equal(handler.trigger, 'autonomous');
  assert.equal(out.permissionMode, 'default');
  assert.deepEqual(out.allowedTools, [
    'WebSearch',
    'WebFetch',
    'Read',
    'mcp__robin-extension__ingest',
  ]);
  // Structurally read-only: every write builtin is denied (allowedTools does not gate builtins).
  assert.deepEqual(out.disallowedTools, [
    'Write',
    'Edit',
    'MultiEdit',
    'NotebookEdit',
    'Bash',
    'KillBash',
  ]);
  assert.equal(out.cwd, '/repo');
  assert.equal(out.maxTurns, 22);
  assert.equal(out.timeoutMs, 1_800_000);
  assert.equal(out.maxBudgetUsd, 3);
});
```

- [ ] **Step 2: Run to verify fail**, then implement:

```typescript
// b-research.ts — replace the handler doc comment + build() body
/**
 * B — Deep research (autonomous). Web + Read, plus exactly ONE write surface:
 * the `ingest` MCP action, so research briefs land in memory as events instead
 * of dying in stderr (spec §B3, deliberate permission change — ingested briefs
 * flow through the normal biographer/hygiene pipeline, never directly into
 * beliefs). NOT plan mode: the SDK evaluates plan mode before allowedTools, so
 * an allowlisted MCP write tool is still blocked there; `default` mode with all
 * write builtins denied gives the same read-only guarantee structurally.
 */
export const handler: HandlerDef = {
  id: 'B',
  name: 'research',
  trigger: 'autonomous',
  build(goal: string, ctx: HandlerCtx) {
    return {
      goal,
      cwd: ctx.repoRoot,
      allowedTools: ['WebSearch', 'WebFetch', 'Read', 'mcp__robin-extension__ingest'],
      disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'KillBash'],
      permissionMode: 'default' as const,
      maxTurns: 22,
      timeoutMs: 1_800_000,
      maxBudgetUsd: 3,
      outputFormat: OUTCOME_ENVELOPE_FORMAT,
    };
  },
};
```

- [ ] **Step 3: Teach the default goal to ingest.** In `runner-entry.ts` `DEFAULT_GOALS`, replace the `B` entry (the verifier in Task 7 keys on this exact `kind`):

```typescript
  B: 'Pick the most valuable open research thread for Robin and produce a concise, sourced brief. When the brief is ready, SAVE it by calling the robin-extension `ingest` tool with kind="research.brief", source="agent:B", and the full brief markdown as `content` — an un-ingested brief is lost work.',
```

- [ ] **Step 4: Run** — `pnpm exec tsx --test system/agent/handlers/b-research.test.ts system/agent/runner-entry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add system/agent/handlers/b-research.ts system/agent/handlers/b-research.test.ts system/agent/runner-entry.ts
git commit -m "feat(agents): handler B gains ingest-only write so briefs land in memory"
```

---

### Task 5: Ledger — `record()` returns the row id; `recordOutcome()`

**Files:**
- Modify: `system/agent/usage-ledger.ts`
- Test: `system/agent/usage-ledger.test.ts` (extend)

- [ ] **Step 1: Write the failing tests** (follow the file's existing in-memory-DB setup):

```typescript
test('record() returns the inserted row id', () => {
  const id = ledger.record({ surface: 's', costUsd: 1, inputTokens: 1, outputTokens: 1, turns: 1 });
  assert.equal(typeof id, 'number');
  assert.ok(id > 0);
});

test('recordOutcome() stamps outcome columns on an existing row', () => {
  const id = ledger.record({ surface: 's', costUsd: 1, inputTokens: 1, outputTokens: 1, turns: 1, label: 'B' });
  ledger.recordOutcome(id, {
    outcome: 'did-work',
    impact: 'medium',
    structuredJson: '{"outcome":"did-work"}',
    verified: 'verified',
  });
  const row = db.prepare('SELECT outcome, impact, structured_json, verified FROM agent_usage WHERE id=?').get(id) as Record<string, string>;
  assert.equal(row.outcome, 'did-work');
  assert.equal(row.impact, 'medium');
  assert.equal(row.verified, 'verified');
});

test('recordOutcome() with partial fields leaves the rest NULL', () => {
  const id = ledger.record({ surface: 's', costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 });
  ledger.recordOutcome(id, { outcome: 'unparseable' });
  const row = db.prepare('SELECT outcome, impact, verified FROM agent_usage WHERE id=?').get(id) as Record<string, string | null>;
  assert.equal(row.outcome, 'unparseable');
  assert.equal(row.impact, null);
  assert.equal(row.verified, null);
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm exec tsx --test system/agent/usage-ledger.test.ts`

- [ ] **Step 3: Implement.** Change `record()`'s return type from `void` to `number` (return `Number(result.lastInsertRowid)` from the `.run(...)` result) and add:

```typescript
export interface OutcomeRecord {
  outcome: string;
  impact?: string;
  structuredJson?: string;
  verified?: string;
}

/** Stamp Phase-B outcome columns onto a previously recorded run row. */
recordOutcome(id: number, o: OutcomeRecord): void {
  this.db
    .prepare(
      `UPDATE agent_usage SET outcome=?, impact=?, structured_json=?, verified=? WHERE id=?`,
    )
    .run(o.outcome, o.impact ?? null, o.structuredJson ?? null, o.verified ?? null, id);
}
```

- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit**

```bash
git add system/agent/usage-ledger.ts system/agent/usage-ledger.test.ts
git commit -m "feat(agents): ledger returns row id + recordOutcome for Phase-B columns"
```

---

### Task 6: `runAgent` — label passthrough + `ledgerId` in the result

**Files:**
- Modify: `system/agent/run-agent.ts`
- Test: `system/agent/run-agent.test.ts` (extend)

Today no caller populates `agent_usage.label`, so per-handler rollups and the benching streak query have nothing to key on. The handler id rides in as `label`.

- [ ] **Step 1: Write the failing tests** (the file's existing tests build a fake ledger — extend that fake so `record` returns a number, e.g. `42`):

```typescript
test('passes input.label through to the ledger row', async () => {
  // run with { ...baseInput, label: 'B' }; assert the fake ledger captured label 'B'
});

test('returns ledgerId from the recorded row', async () => {
  // fake ledger record() returns 42; assert result.ledgerId === 42
});

test('pre-flight capped run has no ledgerId', async () => {
  // fake ledger overCap() → true; assert result.status === 'capped' && result.ledgerId === undefined
});
```

Write these concretely against the test file's existing fake-ledger/fake-sdk fixtures (copy the nearest status-mapping test and adapt).

- [ ] **Step 2: Run to verify fail** — `pnpm exec tsx --test system/agent/run-agent.test.ts`

- [ ] **Step 3: Implement.** Three edits in `run-agent.ts`:

(a) `RunAgentInput` gains:

```typescript
  /** Ledger label for this run (the handler id for handler runs). */
  label?: string;
```

(b) `RunAgentResult` gains:

```typescript
  /** agent_usage row id for this run (absent when the pre-flight cap skipped the SDK). */
  ledgerId?: number;
```

(c) the ledger write captures the id and passes the label:

```typescript
  const ledgerId = deps.ledger.record({
    surface: input.surface,
    ...(input.label ? { label: input.label } : {}),
    costUsd: result.costUsd,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    turns: result.turns,
    status,
    subtype: threw ? 'threw' : undefined,
  });

  return {
    status,
    summary: result.text,
    ...(result.structured !== undefined ? { structured: result.structured } : {}),
    turns: result.turns,
    usage: result.usage,
    costUsd: result.costUsd,
    ledgerId,
    ...(transcriptPath ? { transcriptPath } : {}),
  };
```

- [ ] **Step 4: Run to verify pass** (whole file — the existing tests must still pass).
- [ ] **Step 5: Commit**

```bash
git add system/agent/run-agent.ts system/agent/run-agent.test.ts
git commit -m "feat(agents): runAgent labels ledger rows and returns the row id"
```

---

### Task 7: Deterministic verifiers

**Files:**
- Create: `system/agent/verifiers.ts`
- Test: `system/agent/verifiers.test.ts`

Per-handler post-condition checks, run after the SDK exits — no LLM (spec §B3). All time comparisons via `datetime()` (plan decision 5).

- [ ] **Step 1: Write the failing tests.** Setup: in-memory `RobinDb` with all migrations (copy the open/migrate pattern from `system/kernel/runtime/alert-store.test.ts`), plus `mkdtempSync` temp dirs for the file-based verifiers.

```typescript
// system/agent/verifiers.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
// + the in-memory-db helper imports used by alert-store.test.ts
import { verifyOutcome } from './verifiers.ts';

const RUN_START = '2026-06-11T12:00:00.000Z';
const BEFORE = '2026-06-11 11:00:00'; // sqlite format, pre-run
const AFTER = '2026-06-11 12:30:00'; // sqlite format, post-run

test('B: passes when a research.brief event landed after run start (sqlite ts format)', () => {
  // INSERT INTO events (ts, kind, source, status, payload) VALUES (AFTER, 'research.brief', 'agent:B', 'ok', '{}')
  // assert verifyOutcome('B', { db, runStartIso: RUN_START, knowledgeDir }) === 'pass'
});
test('B: fails when the only brief predates the run', () => { /* seed BEFORE → 'fail' */ });
test('D: passes when a knowledge file mtime >= run start', () => {
  // write a file in tmp knowledgeDir, utimesSync it to after RUN_START → 'pass'
});
test('D: fails when no file changed since run start', () => { /* utimesSync all files to before → 'fail' */ });
test('G: same check as D', () => { /* one pass case */ });
test('E: passes on a new belief candidate', () => { /* belief_candidates created_at = AFTER → 'pass' */ });
test('E: passes on a new correction (record_correction is in E\'s allowlist)', () => { /* corrections ts = AFTER → 'pass' */ });
test('E: fails when neither appeared', () => { /* only BEFORE rows → 'fail' */ });
test('H: candidates only — a correction alone does not pass H', () => { /* corrections AFTER, no candidates → 'fail' */ });
test('F: passes when a prediction resolved during the run (ISO ts format)', () => {
  // predictions row with resolved_at = '2026-06-11T12:30:00.000Z' → 'pass'
});
test('F: fails when resolutions all predate the run', () => { /* → 'fail' */ });
test('K: passes when the worktree has a diff', () => {
  // inject worktreeHasChanges: () => true, worktree: '/wt' → 'pass'
});
test('K: fails when no worktree or no diff', () => {
  // no worktree → 'fail'; worktree + hasChanges false → 'fail'
});
test('L and unknown handlers are unverifiable', () => {
  // verifyOutcome('L', ...) === 'unverifiable'; verifyOutcome('Z', ...) === 'unverifiable'
});
test('verifier exceptions degrade to unverifiable, never throw', () => {
  // knowledgeDir pointing at a nonexistent path for D → 'unverifiable' (or pass a db whose table is dropped)
});
```

Write every body concretely. Seed helper for events: `db.prepare("INSERT INTO events (ts, kind, source, status, payload) VALUES (?,?,?,?,?)").run(ts, kind, source, 'ok', '{}')`. For `belief_candidates`: `(topic, claim, status, created_at)`. For `corrections`: `(ts, what, correction)`. For `predictions`: `(claim, confidence, resolved_at, outcome)`.

- [ ] **Step 2: Run to verify fail** — `pnpm exec tsx --test system/agent/verifiers.test.ts`

- [ ] **Step 3: Implement**

```typescript
// system/agent/verifiers.ts
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RobinDb } from '../brain/memory/db.ts';

export type VerifierResult = 'pass' | 'fail' | 'unverifiable';

export interface VerifierDeps {
  db: RobinDb;
  /** ISO timestamp captured immediately before runAgent was invoked. */
  runStartIso: string;
  /** Absolute path to user-data/content/knowledge (D/G check it for changed files). */
  knowledgeDir: string;
  /** The run's worktree, when one was created (K). */
  worktree?: string;
  /** K's diff check. REQUIRED so this module stays free of git — the caller
   * (runner-entry) passes the real `worktreeHasChanges`; tests pass a fake. */
  worktreeHasChanges: (worktree: string) => boolean;
}

/** True when any row of `table` has `datetime(col) >= datetime(runStart)`. Both
 * sqlite ('YYYY-MM-DD HH:MM:SS') and JS ISO ('...T...Z') formats parse as UTC. */
function rowsSince(db: RobinDb, table: string, col: string, runStartIso: string, extra = ''): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE datetime(${col}) >= datetime(?) ${extra}`)
    .get(runStartIso) as { n: number };
  return row.n > 0;
}

/** True when any file under `dir` (recursive) was modified at/after runStart. */
function filesChangedSince(dir: string, runStartIso: string): boolean {
  const cutoff = Date.parse(runStartIso);
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath, e.name);
    if (statSync(p).mtimeMs >= cutoff) return true;
  }
  return false;
}

/**
 * Deterministic post-condition check per handler (spec §B3) — no LLM. 'pass'
 * means the handler's claimed work is observable in the world; 'fail' means a
 * did-work claim could not be confirmed (the caller records `outcome-mismatch`
 * and fires a Phase-A alert). Handlers without a checkable post-condition (L)
 * and verifier crashes are 'unverifiable' — never thrown.
 */
export function verifyOutcome(handlerId: string, deps: VerifierDeps): VerifierResult {
  try {
    switch (handlerId) {
      case 'B':
        return rowsSince(deps.db, 'events', 'ts', deps.runStartIso, `AND kind='research.brief'`)
          ? 'pass'
          : 'fail';
      case 'D':
      case 'G':
        return filesChangedSince(deps.knowledgeDir, deps.runStartIso) ? 'pass' : 'fail';
      case 'E':
        // E proposes via belief candidates OR corrections (both in its allowlist).
        return rowsSince(deps.db, 'belief_candidates', 'created_at', deps.runStartIso) ||
          rowsSince(deps.db, 'corrections', 'ts', deps.runStartIso)
          ? 'pass'
          : 'fail';
      case 'H':
        return rowsSince(deps.db, 'belief_candidates', 'created_at', deps.runStartIso)
          ? 'pass'
          : 'fail';
      case 'F':
        return rowsSince(deps.db, 'predictions', 'resolved_at', deps.runStartIso) ? 'pass' : 'fail';
      case 'K':
        return deps.worktree && deps.worktreeHasChanges(deps.worktree) ? 'pass' : 'fail';
      default:
        return 'unverifiable'; // L (read-only brief) and unknown ids
    }
  } catch {
    return 'unverifiable';
  }
}
```

Note: `rowsSince` interpolates `table`/`col` into SQL — they come only from the literal switch above, never caller input. Keep it that way (add a comment saying so).

- [ ] **Step 4: Run to verify pass** — `pnpm exec tsx --test system/agent/verifiers.test.ts` (the K tests inject a fake `worktreeHasChanges`, so this task has no git dependency).

- [ ] **Step 5: Commit**

```bash
git add system/agent/verifiers.ts system/agent/verifiers.test.ts
git commit -m "feat(agents): deterministic per-handler outcome verifiers"
```

---

### Task 8: Worktree + learning-record modules (moved out of the CLI surface)

`runner-entry.ts` (system/agent) must not import from `system/surfaces/cli/` — move the two pieces it needs down into the agent layer, leaving the CLI importing from the new home.

**Files:**
- Create: `system/agent/worktree.ts` (move `createWorktree`, `pruneWorktree`, `worktreeHasChanges` from `system/surfaces/cli/agent.ts`, verbatim bodies)
- Create: `system/agent/learning-record.ts` (generalized `writeLearningRecord`)
- Test: `system/agent/learning-record.test.ts`
- Modify: `system/surfaces/cli/agent.ts` (import from the new modules; delete the moved bodies; keep re-exports so `agent.test.ts` imports stay valid: `export { createWorktree, pruneWorktree, worktreeHasChanges } from '../../agent/worktree.ts';`)

- [ ] **Step 1: Move the worktree helpers.** Cut the three functions (and their `execFileSync`/`join` imports) from `agent.ts` into `system/agent/worktree.ts` unchanged. In `agent.ts`, add the re-export line above. Run `pnpm exec tsx --test system/surfaces/cli/agent.test.ts` — expected PASS (pure move).

- [ ] **Step 2: Write the failing learning-record tests**

```typescript
// system/agent/learning-record.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeLearningRecord } from './learning-record.ts';

test('writes a per-handler record with outcome fields in frontmatter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-'));
  const path = writeLearningRecord(dir, {
    handler: 'D',
    goal: 'curate',
    status: 'success',
    outcome: 'did-work',
    impact: 'low',
    verified: 'verified',
    turns: 7,
    costUsd: 1.23,
    ts: '2026-06-11T12:00:00.000Z',
  });
  assert.ok(path.endsWith('-D.md'));
  const body = readFileSync(path, 'utf8');
  assert.match(body, /handler: D/);
  assert.match(body, /outcome: did-work/);
  assert.match(body, /verified: verified/);
});

test('branch and outcome fields are optional (handler-A back-compat)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-'));
  const path = writeLearningRecord(dir, {
    handler: 'A', goal: 'g', status: 'success', turns: 1, costUsd: 0, ts: '2026-06-11T12:00:00.000Z',
  });
  assert.match(readFileSync(path, 'utf8'), /handler: A/);
});
```

- [ ] **Step 3: Run to verify fail**, then implement:

```typescript
// system/agent/learning-record.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LearningRecord {
  handler: string;
  goal: string;
  status: string;
  outcome?: string;
  impact?: string;
  verified?: string;
  branch?: string;
  turns: number;
  costUsd: number;
  ts: string;
}

/**
 * Append a learning-loop outcome record for a handler run (spec §B2 generalizes
 * this from A-only to every autonomous handler; no-op runs are skipped by the
 * caller to avoid clutter).
 *
 * NOTE: this dir is deliberately NOT under `content/knowledge/` so `ingest-docs`
 * never indexes it into general recall — otherwise Robin's memory floods with
 * run logs. The self-improvement primer reads it directly.
 */
export function writeLearningRecord(userDataDir: string, r: LearningRecord): string {
  const dir = join(userDataDir, 'agent-runs');
  mkdirSync(dir, { recursive: true });
  const slug = r.ts.replace(/[:.]/g, '-');
  const path = join(dir, `${slug}-${r.handler}.md`);
  const body = `---
node_type: agent_run
handler: ${r.handler}
ts: ${r.ts}
status: ${r.status}
outcome: ${r.outcome ?? ''}
impact: ${r.impact ?? ''}
verified: ${r.verified ?? ''}
branch: ${r.branch ?? ''}
turns: ${r.turns}
cost_usd: ${r.costUsd}
---

# Agent run — handler ${r.handler}

**Goal:** ${r.goal}

**Status:** ${r.status}
**Outcome:** ${r.outcome ?? '(none)'} (impact: ${r.impact ?? '?'}, verified: ${r.verified ?? 'n/a'})
**Branch:** ${r.branch ?? '(none)'}
**Turns:** ${r.turns}
**Cost (USD):** ${r.costUsd}
`;
  writeFileSync(path, body);
  return path;
}
```

In `system/surfaces/cli/agent.ts`: delete the local `writeLearningRecord`, import the new one, and adapt the handler-A call site to pass `handler: 'A'` (its existing args otherwise map 1:1). Update `agent.test.ts` if it asserted the old record body (the `-A.md` suffix and frontmatter keys are preserved, so most assertions should hold).

- [ ] **Step 4: Run** — `pnpm exec tsx --test system/agent/learning-record.test.ts system/surfaces/cli/agent.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add system/agent/worktree.ts system/agent/learning-record.ts system/agent/learning-record.test.ts \
        system/surfaces/cli/agent.ts system/surfaces/cli/agent.test.ts
git commit -m "refactor(agents): worktree + learning-record live in the agent layer"
```

---

### Task 9: `runner-entry` — outcome persistence, verification, mismatch alert, worktree for K

**Files:**
- Modify: `system/agent/runner-entry.ts`
- Test: `system/agent/runner-entry.test.ts` (extend)

This is the integration point for B2 + B3. After `runAgent` returns, the runner: parses the envelope → stamps the ledger row → verifies → fires the mismatch alert → writes the learning record (skipping no-ops) → reports/prunes the worktree.

- [ ] **Step 1: Write the failing tests.** The file already drives `runRunnerEntry` with a fake `runAgent` + injected `openLedger`. Extend the fakes: `openLedger` must now also return `db` (give it a real in-memory `RobinDb` with migrations applied — outcome columns and the `alerts` table are asserted against it), and the fake `runAgent` must capture its `input` and return configurable `{ structured, ledgerId }`.

```typescript
test('autonomous run passes the handler id as the ledger label', async () => {
  // run --handler=L with fake runAgent; assert captured input.label === 'L'
});

test('did-work + verifier pass → outcome columns stamped verified', async () => {
  // handler E; fake runAgent returns { status:'success', structured:{outcome:'did-work',impact:'low'}, ledgerId } 
  // AND the fake (or a pre-seeded belief_candidates row dated post-run) makes the verifier pass.
  // assert agent_usage row: outcome='did-work', verified='verified', structured_json set.
});

test('did-work + verifier fail → outcome-mismatch + Phase-A alert', async () => {
  // handler E, structured did-work, NO candidate rows seeded.
  // assert verified='outcome-mismatch' on the row AND one open alert
  // (source='agent-runner', key='outcome-mismatch:E') exists in the alerts table.
});

test('missing/invalid structured output → outcome=unparseable, no alert', async () => {
  // fake runAgent returns structured: undefined → outcome 'unparseable', verified NULL, alerts empty.
});

test('no-op runs skip the learning record; did-work runs write one', async () => {
  // temp userDataDir; structured {outcome:'no-op',impact:'low'} → no agent-runs/*-E.md file;
  // structured did-work (verifier pass) → file exists with outcome in frontmatter.
});

test('L records verified=unverifiable on did-work', async () => {});

test('write-to-repo handler (K) gets a worktree; unchanged → pruned, changed → kept', async () => {
  // inject fake createWorktree/pruneWorktree/worktreeHasChanges via deps (added in Step 2);
  // assert createWorktree called for K, not for E; hasChanges false → pruneWorktree called;
  // hasChanges true → branch reported and pruneWorktree NOT called.
});

test('pre-flight capped run (no ledgerId) skips outcome persistence without crashing', async () => {
  // fake runAgent returns { status:'capped', ledgerId: undefined } → no throw, no outcome row update.
});
```

Write all bodies concretely against the file's existing fixture style.

- [ ] **Step 2: Implement.** Changes to `runner-entry.ts`:

(a) **Deps**: extend `RunnerEntryDeps` with the worktree trio (for tests) and change `openLedger`'s return shape:

```typescript
  openLedger?: (userDataDir: string) => { ledger: UsageLedger; db: RobinDb; close: () => void };
  createWorktree?: typeof createWorktree;
  pruneWorktree?: typeof pruneWorktree;
  worktreeHasChanges?: typeof worktreeHasChanges;
```

`defaultOpenLedger` returns `{ ledger: new UsageLedger(db), db, close: () => closeDb(db) }`. Reuse this `db` for the learning digest too (drop the second `openDb` block — one handle, opened once, closed in the final `finally`).

(b) **Worktree for write-to-repo handlers** (K). After resolving `def`, probe and branch:

```typescript
import { createWorktree as realCreateWorktree, pruneWorktree as realPruneWorktree, worktreeHasChanges as realWorktreeHasChanges } from './worktree.ts';

  // Write handlers whose cwd is the repo root edit code — isolate them in a
  // throwaway worktree exactly like `robin agent` does (spec §B3: K's verifier
  // is "worktree branch exists with a diff"). D/G write only to the gitignored
  // knowledge dir (cwd != repoRoot) and need no worktree.
  const probe = def.build(baseGoal, { repoRoot });
  let worktree: string | undefined;
  let branch: string | undefined;
  if (probe.permissionMode === 'acceptEdits' && probe.cwd === repoRoot) {
    try {
      const wt = mkWorktree(repoRoot, now);
      worktree = wt.worktree;
      branch = wt.branch;
      log(`worktree: ${worktree} (branch ${branch})`);
    } catch (err) {
      return { status: 'error', message: `failed to create worktree: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
    }
  }
  const built = def.build(goal, { repoRoot, ...(worktree ? { worktree } : {}) });
```

(`mkWorktree` etc. resolved from deps with the real defaults, mirroring `agent.ts`.)

(c) **Label + run start**:

```typescript
  const runStartIso = now().toISOString();
  const input: RunAgentInput = { ...built, surface: 'agentic-autonomous', mcpServers, label: def.id };
```

(d) **Post-run block** (after `result` is assigned, before `close()` — restructure the `try/finally` so the ledger/db stay open through this block):

```typescript
import { recordAlert } from '../kernel/runtime/alert-store.ts';
import { writeLearningRecord } from './learning-record.ts';
import { parseOutcomeEnvelope } from './outcome.ts';
import { verifyOutcome } from './verifiers.ts';

  // Worktree disposition first (K): keep a branch with changes for review, prune otherwise.
  let worktreeChanged = false;
  if (worktree && branch) {
    try {
      worktreeChanged = hasChanges(worktree);
    } catch {
      worktreeChanged = true; // can't tell → keep for inspection
    }
    if (worktreeChanged) log(`branch ${branch} left for review — diff: git -C ${worktree} diff`);
    else {
      rmWorktree(repoRoot, worktree, branch);
      branch = undefined;
    }
  }

  // Structured outcome → ledger columns (spec §B2). Best-effort: outcome
  // bookkeeping must never turn a completed run into a failure.
  const envelope = parseOutcomeEnvelope(result.structured);
  const outcome = envelope?.outcome ?? 'unparseable';
  let verified: string | undefined;
  if (envelope?.outcome === 'did-work') {
    const v = verifyOutcome(def.id, {
      db,
      runStartIso,
      knowledgeDir: join(userDataDir, 'content', 'knowledge'),
      ...(worktree ? { worktree } : {}),
      worktreeHasChanges: hasChanges, // the dep-resolved fn (real or test fake)
    });
    verified = v === 'pass' ? 'verified' : v === 'fail' ? 'outcome-mismatch' : 'unverifiable';
    if (verified === 'outcome-mismatch') {
      try {
        recordAlert(db, {
          severity: 'warning',
          source: 'agent-runner',
          key: `outcome-mismatch:${def.id}`,
          message: `handler ${def.id} claimed did-work but its verifier found no evidence`,
        });
      } catch { /* alerting never breaks the runner */ }
    }
  }
  if (result.ledgerId !== undefined) {
    try {
      ledger.recordOutcome(result.ledgerId, {
        outcome,
        ...(envelope?.impact ? { impact: envelope.impact } : {}),
        ...(result.structured !== undefined ? { structuredJson: JSON.stringify(result.structured) } : {}),
        ...(verified ? { verified } : {}),
      });
    } catch { /* best-effort */ }
  }

  // Learning record for every autonomous handler except no-ops (spec §B2).
  if (outcome !== 'no-op') {
    try {
      const path = writeLearningRecord(userDataDir, {
        handler: def.id,
        goal: baseGoal,
        status: result.status,
        outcome,
        ...(envelope?.impact ? { impact: envelope.impact } : {}),
        ...(verified ? { verified } : {}),
        ...(branch ? { branch } : {}),
        turns: result.turns,
        costUsd: result.costUsd,
        ts: runStartIso,
      });
      log(`learning record: ${path}`);
    } catch { /* best-effort */ }
  }
```

K's verifier consumes `worktreeChanged` indirectly via `verifyOutcome` — pass the injected `worktreeHasChanges` so tests control it; in production the second `hasChanges` call is cheap (one `git status --porcelain`).

- [ ] **Step 3: Run** — `pnpm exec tsx --test system/agent/runner-entry.test.ts`
Expected: PASS (new + all pre-existing tests).

- [ ] **Step 4: Commit**

```bash
git add system/agent/runner-entry.ts system/agent/runner-entry.test.ts
git commit -m "feat(agents): runner persists outcomes, verifies deterministically, alerts on mismatch, isolates K in a worktree"
```

---

### Task 10: Pre-checks — skip the SDK when there's nothing to do

**Files:**
- Create: `system/jobs/builtin/agent-runner/pre-checks.ts`
- Test: `system/jobs/builtin/agent-runner/pre-checks.test.ts`

Cheap deterministic queries run in the job tick *before* spawning the SDK subprocess (spec §B4 — the main quota saver). A standalone module (not on `HandlerDef`) keeps the job free of handler-module import side-effects, matching the existing constant-list rationale in `index.ts`.

- [ ] **Step 1: Write the failing tests** (in-memory db + temp knowledge dir, fixed `now`):

```typescript
test('F: skips when no prediction is past deadline; runs when one is due', () => {});
test('F: predictions with NULL deadline never make F due', () => {});
test('E: skips when no pending belief candidates; runs when one exists', () => {});
test('K: skips when no open alerts; runs when one is open (resolved rows ignored)', () => {});
test('D: runs when a knowledge file is older than 14 days; skips when all files are fresh', () => {});
test('H: runs when events exist in the last 48h; skips on a silent window', () => {});
test('B, G, L always run', () => {});
test('a throwing check fails OPEN (run:true) — a broken pre-check must not silence a handler', () => {
  // e.g. knowledgeDir pointing at a nonexistent path for D → { run: true }
});
```

Write the bodies concretely (seed rows exactly as in Task 7's seed helpers; use `utimesSync` for D's file ages).

- [ ] **Step 2: Run to verify fail**, then implement:

```typescript
// system/jobs/builtin/agent-runner/pre-checks.ts
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RobinDb } from '../../../brain/memory/db.ts';

export interface PreCheckDeps {
  db: RobinDb;
  /** Absolute path to user-data/content/knowledge. */
  knowledgeDir: string;
  now: () => Date;
}

export interface PreCheckResult {
  run: boolean;
  /** Human-readable skip reason, for the tick log. */
  reason?: string;
}

const STALE_NOTE_DAYS = 14;

function count(db: RobinDb, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

/**
 * Deterministic nothing-to-do checks per handler (spec §B4). `run:false` means
 * the tick skips the SDK spawn entirely — zero spend. Checks FAIL OPEN: any
 * error means "run the handler" (a broken pre-check must never silence one).
 * B/G/L have no cheap deterministic emptiness signal and always run.
 */
export function preCheck(handler: string, deps: PreCheckDeps): PreCheckResult {
  try {
    switch (handler) {
      case 'D': {
        // Curation targets stale notes: any knowledge file untouched for 14+ days.
        const cutoff = deps.now().getTime() - STALE_NOTE_DAYS * 86_400_000;
        const entries = readdirSync(deps.knowledgeDir, { recursive: true, withFileTypes: true });
        for (const e of entries) {
          if (e.isFile() && statSync(join(e.parentPath, e.name)).mtimeMs < cutoff) {
            return { run: true };
          }
        }
        return { run: false, reason: 'no knowledge notes older than 14d' };
      }
      case 'E':
        return count(deps.db, `SELECT COUNT(*) AS n FROM belief_candidates WHERE status='pending'`) > 0
          ? { run: true }
          : { run: false, reason: 'no pending belief candidates' };
      case 'F':
        return count(
          deps.db,
          `SELECT COUNT(*) AS n FROM predictions
            WHERE outcome IS NULL AND deadline IS NOT NULL AND datetime(deadline) <= datetime(?)`,
          deps.now().toISOString(),
        ) > 0
          ? { run: true }
          : { run: false, reason: 'no predictions past deadline' };
      case 'H':
        return count(
          deps.db,
          `SELECT COUNT(*) AS n FROM events WHERE datetime(ts) >= datetime(?)`,
          new Date(deps.now().getTime() - 48 * 3_600_000).toISOString(),
        ) > 0
          ? { run: true }
          : { run: false, reason: 'no events in the last 48h' };
      case 'K':
        return count(deps.db, `SELECT COUNT(*) AS n FROM alerts WHERE resolved_at IS NULL`) > 0
          ? { run: true }
          : { run: false, reason: 'no open alerts to remediate' };
      default:
        return { run: true }; // B, G, L: no deterministic emptiness signal
    }
  } catch {
    return { run: true };
  }
}
```

- [ ] **Step 3: Run to verify pass.**
- [ ] **Step 4: Commit**

```bash
git add system/jobs/builtin/agent-runner/pre-checks.ts system/jobs/builtin/agent-runner/pre-checks.test.ts
git commit -m "feat(agents): deterministic pre-checks skip SDK spawns with nothing to do"
```

---

### Task 11: Adaptive dispatch — pre-checks + 3-strikes benching in the agent-runner job

**Files:**
- Modify: `system/jobs/builtin/agent-runner/index.ts`
- Test: `system/jobs/builtin/agent-runner/index.test.ts` (extend; follow its existing fake-spawn/ctx pattern — the test ctx needs a real in-memory `RobinDb` now, since benching reads `agent_usage` and writes `alerts`)

Round-robin survives as the base order; pre-checks and benching modulate it (spec §B4). No ML, no tunables beyond two constants.

- [ ] **Step 1: Write the failing tests**

```typescript
test('pre-check skip advances to the next handler in the same tick', () => {
  // cursor at F, F's pre-check says skip (no due predictions), G runs → spawn called with --handler=G,
  // cursor ends past G, adaptive state records skips.F === 1
});
test('all handlers skipped → tick returns skipped, no spawn, lock released', () => {});
test('3 consecutive failures bench a handler for 3 rotations + fire an alert', () => {
  // seed agent_usage: 3 rows label='B', surface='agentic-autonomous', status='error'
  // tick with cursor at B → B not spawned; adaptive file has benches.B.until = rotation+3;
  // alerts table has open (source='agent-runner', key='handler-benched:B')
});
test('outcome-mismatch rows count as failures for the streak', () => {
  // 3 rows with status='success' but verified='outcome-mismatch' → benched
});
test('benched handler is skipped until the bench expires, then runs again', () => {
  // benches.B.until = rotation+3 → B skipped; set rotation >= until → B dispatched
});
test('expired bench does not instantly re-bench on the same old failures', () => {
  // the streak query must ignore rows with ts <= benches.B.at
});
test('a success after the bench resolves the alert and clears the bench entry', () => {
  // seed a post-bench success row → tick resolves alert (resolved_at set) + benches.B removed
});
test('rotation counter increments when the cursor wraps', () => {});
test('corrupt adaptive-state file resets cleanly (no throw)', () => {});
```

- [ ] **Step 2: Implement.** In `index.ts`:

(a) **Constants + state file** next to the cursor helpers:

```typescript
/** Bench policy (spec §B4): 3 consecutive failures bench a handler for the next
 * 3 full rotations. The bench expires on its own; the streak query only counts
 * rows newer than the bench timestamp, so an expired bench can't instantly
 * re-trigger on the same three old failures. */
const BENCH_AFTER_FAILURES = 3;
const BENCH_ROTATIONS = 3;

interface AdaptiveState {
  rotation: number;
  /** handler → bench: skipped while rotation < until; `at` is the streak watermark. */
  benches: Record<string, { until: number; at: string }>;
  /** handler → lifetime count of pre-check skips (surfaced by metrics --agents). */
  skips: Record<string, number>;
}

function adaptivePath(userDataDir: string): string {
  return join(userDataDir, 'state', 'runtime', 'agent-runner-adaptive.json');
}

function readAdaptive(userDataDir: string): AdaptiveState {
  try {
    const raw = JSON.parse(readFileSync(adaptivePath(userDataDir), 'utf8')) as Partial<AdaptiveState>;
    return {
      rotation: typeof raw.rotation === 'number' ? raw.rotation : 0,
      benches: raw.benches && typeof raw.benches === 'object' ? raw.benches : {},
      skips: raw.skips && typeof raw.skips === 'object' ? raw.skips : {},
    };
  } catch {
    return { rotation: 0, benches: {}, skips: {} };
  }
}

function writeAdaptive(userDataDir: string, s: AdaptiveState): void {
  const p = adaptivePath(userDataDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(s), 'utf8');
}
```

(b) **Streak query** (uses `ctx.db`):

```typescript
/** Last-N consecutive-failure check for a handler, ignoring rows at/before the
 * given watermark (the handler's last bench). Failure = error/timeout status or
 * a did-work claim its verifier rejected. */
function hasFailureStreak(db: RobinDb, handler: string, sinceTs: string | undefined): boolean {
  const rows = db
    .prepare(
      `SELECT status, verified FROM agent_usage
        WHERE surface='agentic-autonomous' AND label=? AND (? IS NULL OR ts > ?)
        ORDER BY ts DESC LIMIT ?`,
    )
    .all(handler, sinceTs ?? null, sinceTs ?? null, BENCH_AFTER_FAILURES) as Array<{
    status: string | null;
    verified: string | null;
  }>;
  if (rows.length < BENCH_AFTER_FAILURES) return false;
  return rows.every(
    (r) => r.status === 'error' || r.status === 'timeout' || r.verified === 'outcome-mismatch',
  );
}

/** True when the handler's most recent run (post-watermark) was not a failure. */
function latestRunSucceeded(db: RobinDb, handler: string, sinceTs: string | undefined): boolean {
  const r = db
    .prepare(
      `SELECT status, verified FROM agent_usage
        WHERE surface='agentic-autonomous' AND label=? AND (? IS NULL OR ts > ?)
        ORDER BY ts DESC LIMIT 1`,
    )
    .get(handler, sinceTs ?? null, sinceTs ?? null) as
    | { status: string | null; verified: string | null }
    | undefined;
  if (!r) return false;
  return !(r.status === 'error' || r.status === 'timeout' || r.verified === 'outcome-mismatch');
}
```

(c) **Dispatch loop** replacing the current read-cursor/pick/advance block (after the lock is acquired). Alert writes go through try/catch — alerting never throws into the job:

```typescript
import { recordAlert, resolveAlert } from '../../../kernel/runtime/alert-store.ts';
import { preCheck } from './pre-checks.ts';

  const adaptive = readAdaptive(userDataDir);
  const knowledgeDir = join(userDataDir, 'content', 'knowledge');
  const cursor = readCursor(userDataDir);
  let picked: string | undefined;
  let steps = 0;

  for (let i = 0; i < AUTONOMOUS_HANDLERS.length && !picked; i++) {
    const h = AUTONOMOUS_HANDLERS[(cursor + i) % AUTONOMOUS_HANDLERS.length] as string;
    steps = i + 1;
    const bench = adaptive.benches[h];

    if (bench && adaptive.rotation < bench.until) {
      ctx.log.info({ handler: h, until: bench.until }, 'agent-runner: benched, skipping');
      continue;
    }
    // Bench expired (or none): a post-watermark success clears the bench + its alert.
    if (bench && latestRunSucceeded(ctx.db, h, bench.at)) {
      delete adaptive.benches[h];
      try {
        resolveAlert(ctx.db, 'agent-runner', `handler-benched:${h}`);
      } catch { /* best-effort */ }
    }
    // 3-strikes: bench instead of dispatching (counts only runs after the last bench).
    if (hasFailureStreak(ctx.db, h, adaptive.benches[h]?.at)) {
      adaptive.benches[h] = { until: adaptive.rotation + BENCH_ROTATIONS, at: ctx.now().toISOString() };
      try {
        recordAlert(ctx.db, {
          severity: 'warning',
          source: 'agent-runner',
          key: `handler-benched:${h}`,
          message: `handler ${h} failed ${BENCH_AFTER_FAILURES} consecutive runs — benched for ${BENCH_ROTATIONS} rotations`,
        });
      } catch { /* best-effort */ }
      ctx.log.warn({ handler: h }, 'agent-runner: benched after failure streak');
      continue;
    }
    const pc = preCheck(h, { db: ctx.db, knowledgeDir, now: ctx.now });
    if (!pc.run) {
      adaptive.skips[h] = (adaptive.skips[h] ?? 0) + 1;
      ctx.log.info({ handler: h, reason: pc.reason }, 'agent-runner: pre-check skip');
      continue;
    }
    picked = h;
  }

  // Advance cursor past everything examined; count completed rotations.
  adaptive.rotation += Math.floor((cursor + steps) / AUTONOMOUS_HANDLERS.length);
  writeCursor(userDataDir, (cursor + steps) % AUTONOMOUS_HANDLERS.length);
  writeAdaptive(userDataDir, adaptive);

  if (!picked) {
    release(lock);
    return { status: 'skipped', message: 'all handlers benched or pre-check-skipped' };
  }
  const handler = picked;
```

(The spawn block below stays as-is.) `JobContext` provides `db`, `now`, `log` — no new wiring needed. Add `RobinDb` to the imports from `../../../brain/memory/db.ts`.

- [ ] **Step 3: Run** — `pnpm exec tsx --test system/jobs/builtin/agent-runner/index.test.ts system/jobs/builtin/agent-runner/pre-checks.test.ts`
Expected: PASS (new + pre-existing).

- [ ] **Step 4: Commit**

```bash
git add system/jobs/builtin/agent-runner/index.ts system/jobs/builtin/agent-runner/index.test.ts
git commit -m "feat(agents): adaptive dispatch — pre-check skips + 3-strikes benching with Phase-A alerts"
```

---

### Task 12: ROI surface — `robin metrics --agents` + MCP

**Files:**
- Create: `system/surfaces/cli/metrics.ts`
- Test: `system/surfaces/cli/metrics.test.ts`
- Modify: `system/surfaces/cli/index.ts` (new `metrics` case, same dynamic-import pattern as `alerts`)
- Modify: `system/surfaces/mcp/core/server.ts` (extend the existing `metrics` tool)

- [ ] **Step 1: Write the failing tests** (pure functions against an in-memory db, like `alerts.test.ts`):

```typescript
test('agentMetricsRows aggregates per handler label', () => {
  // seed agent_usage: B ×3 (2 did-work verified, 1 error), D ×1 (no-op), one legacy row (label NULL, ignored)
  // assert rows: B → runs 3, cost summed, didWork 2, lastDidWork = max ts of did-work rows; D → noOp 1
});
test('agentMetricsText renders a line per handler and totals', () => {});
test('agentMetricsText says no runs when the ledger is empty', () => {});
```

- [ ] **Step 2: Run to verify fail**, then implement:

```typescript
// system/surfaces/cli/metrics.ts
import type { RobinDb } from '../../brain/memory/db.ts';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

export interface AgentMetricsRow {
  label: string;
  runs: number;
  costUsd: number;
  didWork: number;
  noOp: number;
  blocked: number;
  unparseable: number;
  verified: number;
  mismatches: number;
  lastDidWork: string | null;
}

/** Per-handler ROI rollup over the agent_usage ledger (spec §B5). */
export function agentMetricsRows(db: RobinDb): AgentMetricsRow[] {
  return db
    .prepare(
      `SELECT label,
              COUNT(*)                                            AS runs,
              ROUND(COALESCE(SUM(cost_usd), 0), 4)                AS costUsd,
              SUM(CASE WHEN outcome='did-work' THEN 1 ELSE 0 END) AS didWork,
              SUM(CASE WHEN outcome='no-op' THEN 1 ELSE 0 END)    AS noOp,
              SUM(CASE WHEN outcome='blocked' THEN 1 ELSE 0 END)  AS blocked,
              SUM(CASE WHEN outcome='unparseable' THEN 1 ELSE 0 END) AS unparseable,
              SUM(CASE WHEN verified='verified' THEN 1 ELSE 0 END)   AS verified,
              SUM(CASE WHEN verified='outcome-mismatch' THEN 1 ELSE 0 END) AS mismatches,
              MAX(CASE WHEN outcome='did-work' THEN ts END)       AS lastDidWork
         FROM agent_usage
        WHERE label IS NOT NULL AND surface LIKE 'agentic-%'
        GROUP BY label ORDER BY label`,
    )
    .all() as AgentMetricsRow[];
}

export function agentMetricsText(db: RobinDb): string {
  const rows = agentMetricsRows(db);
  if (rows.length === 0) return 'No labeled agent runs recorded yet.';
  const lines = rows.map(
    (r) =>
      `${r.label}  runs:${r.runs}  $${r.costUsd.toFixed(2)}  did-work:${r.didWork} (verified ${r.verified}, mismatch ${r.mismatches})  no-op:${r.noOp}  blocked:${r.blocked}  unparseable:${r.unparseable}  last did-work: ${r.lastDidWork ?? 'never'}`,
  );
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
  return [...lines, `total: ${rows.reduce((s, r) => s + r.runs, 0)} runs, $${totalCost.toFixed(2)}`].join('\n');
}

export async function runMetricsCommand(args: string[]): Promise<void> {
  if (!args.includes('--agents')) {
    console.error('usage: robin metrics --agents');
    process.exit(2);
  }
  const userData = resolveUserDataDir();
  const db = openDb(dbFilePath(userData));
  applyMigrations(db, allMigrations);
  try {
    console.log(agentMetricsText(db));
  } finally {
    closeDb(db);
  }
}
```

Note legacy rows (pre-migration, `outcome` NULL) still count in `runs`/`costUsd` but in no outcome bucket — that's correct (spend predates outcome tracking).

- [ ] **Step 3: Wire the CLI.** In `system/surfaces/cli/index.ts`, next to the `alerts` case:

```typescript
    case 'metrics': {
      const { runMetricsCommand } = await import('./metrics.ts');
      await runMetricsCommand(rest);
      break;
    }
```

(Match the surrounding cases exactly for how args/`rest` and exit are handled — copy the `alerts` case shape. Add `metrics --agents` to the help text where `alerts` is listed.)

- [ ] **Step 4: Extend the MCP `metrics` tool.** In `system/surfaces/mcp/core/server.ts`, add to the tool's `inputSchema`:

```typescript
        agents: z.boolean().optional().describe('Per-handler agent ROI: runs, spend, outcomes, last did-work'),
```

and at the top of the tool handler:

```typescript
      if (agents) {
        const { agentMetricsRows } = await import('../../cli/metrics.ts');
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(agentMetricsRows(deps.db), null, 2) },
          ],
        };
      }
```

(Update the destructured handler args to include `agents`; mention agents mode in the tool description. Reusing the CLI's pure rollup keeps one query path, same as the alerts tool.)

- [ ] **Step 5: Run** — `pnpm exec tsx --test system/surfaces/cli/metrics.test.ts` then `pnpm typecheck`.
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add system/surfaces/cli/metrics.ts system/surfaces/cli/metrics.test.ts \
        system/surfaces/cli/index.ts system/surfaces/mcp/core/server.ts
git commit -m "feat(agents): robin metrics --agents + MCP agents-ROI view"
```

---

### Task 13: Finalize — gates, build, daemon restart, live verification

- [ ] **Step 1: Full gates.** `pnpm lint && pnpm typecheck && pnpm test`
Expected: clean except the 4 known pre-existing failures (spotify ×2, ebird, recall); **zero new failures**.

- [ ] **Step 2: Build + restart.** `pnpm build && launchctl kickstart -k gui/$(id -u)/io.robin-assistant.daemon`
(The daemon picks up new code only after this; MCP servers in any open Claude session stay stale until that session restarts — verify via CLI/daemon, not MCP tools.)

- [ ] **Step 3: Live verification.**
  - `node dist/surfaces/cli/index.js metrics --agents` → renders (legacy rows have no outcome buckets — expected).
  - Spawn ONE real autonomous run through the runner (this is the sanctioned real-spend verification): pick a cheap propose-only handler whose pre-check would pass, e.g. `node dist/agent/runner-entry.js --handler=E` (E: propose-only, $3 budget cap). Watch stderr for the handler/status/learning-record lines.
  - Then: `sqlite3 <user-data db> "SELECT label, status, outcome, impact, verified, ROUND(cost_usd,2) FROM agent_usage ORDER BY id DESC LIMIT 3"` → the new row has `label='E'` and a populated `outcome` (+ `verified` when it claimed did-work).
  - `node dist/surfaces/cli/index.js alerts` → no unexpected `agent-runner` alerts (an `outcome-mismatch:E` here means the verifier disagreed with the claim — investigate before calling it done; that path firing on a genuinely-empty run is the feature working).
  - Confirm `user-data/state/runtime/agent-runner-adaptive.json` appears after the next scheduled agent-runner tick (3-hourly at :00) with `rotation`/`skips` advancing — or trigger one tick by waiting; do not force extra paid runs for this.
  - `ls user-data/agent-runs/ | tail` → a fresh `*-E.md` learning record exists (unless the run was a no-op).
- [ ] **Step 4: Update `docs/STATUS.md`** if it tracks shipped features; commit stragglers with explicit paths only.

---

## Self-review notes (already applied)

- Spec §B1 → Tasks 2, 3 (envelope + headroom, all 12 handlers; unparseable fallback in Task 9). §B2 → Tasks 1, 5, 6, 8, 9 (columns, ledger id, label, learning-record generalization, no-op skip). §B3 → Tasks 4, 7, 8, 9 (B's ingest write, verifiers, worktree module + autonomous-K isolation, mismatch → Phase-A alert). §B4 → Tasks 10, 11 (pre-checks, 3-strikes bench + alert, round-robin preserved). §B5 → Task 12.
- Spec deviations are all enumerated in "Decisions baked into this plan" (B's permission mode mechanics, E's corrections-accepting verifier, autonomous-K worktree) — each is the minimum change that makes the spec's own requirements satisfiable.
- Zero new LLM spend: the envelope rides the same run (B1), verifiers and pre-checks are SQL/file checks, benching reads the ledger. The only paid action in this plan is the single live-verification run in Task 13, explicitly requested.
- Type consistency checked: `verified` values (`verified`/`outcome-mismatch`/`unverifiable`) match between Task 9 (writer), Task 11 (streak reader), and Task 12 (rollup); `label` flows runner-entry → runAgent → ledger → metrics/benching; `openLedger` return shape change is confined to runner-entry + its tests (the CLI's `defaultOpenLedger` in agent.ts is a separate function and unchanged).
