# Theme 2a — Evidence ledger · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `evidence_ledger` (append-only corroborations/refutations per memo). Confidence becomes derivable from the ledger via `fn::derived_confidence`; stored `memos.confidence` updates lazily in dream. Reinforcement loop gains a refute path on `outcome='corrected'`.

**Architecture:** New table + new SurrealQL function + dream recompute step. Producers: reinforcement loop, `contradicts` edge auto-emit, biographer optional output, manual MCP tools (`endorse`, `refute`). `signal_count` stays as cached corroboration count for `fn::freshness` hot path.

**Tech Stack:** Node.js 18+, SurrealDB 3.0.5.

**Spec:** `docs/superpowers/specs/2026-05-11-robin-v2-theme-2a-evidence-ledger-design.md`

**Dependencies:** `feat/surrealdb-improvements` merge.

---

## File structure

| File | Responsibility |
|---|---|
| `src/schema/migrations/0001-init.surql` | `evidence_ledger` table, `fn::derived_confidence`, seed `runtime:evidence.config` |
| `src/memory/evidence.js` (new) | `addEvidence`, `recomputeConfidence`, `evidenceFor` |
| `src/recall/reinforcement.js` (modify) | Write ledger row on reinforce + on correction (new behavior) |
| `src/memory/store.js` (modify) | `relate(..., 'contradicts')` auto-emits two refutes rows |
| `src/capture/biographer-output.js` (modify) | Validate optional `evidence_signals` array |
| `src/capture/biographer-prompt.js` (modify) | Prompt mentions `evidence_signals` |
| `src/capture/biographer.js` (modify) | When LLM returns `evidence_signals`, emit ledger rows |
| `src/dream/step-confidence-recompute.js` (new) | Lazy recompute stored `memos.confidence` |
| `src/dream/pipeline.js` (modify) | Wire step after `step-reflection` |
| `src/mcp/tools/endorse.js`, `refute.js` (new) | Manual evidence signals |
| `src/daemon/server.js` (modify) | Register endorse/refute |
| Tests: ledger, formula, replay, biographer integration |

---

## Phase 1 — Schema + function

### Task 1: evidence_ledger table

**Files:** `src/schema/migrations/0001-init.surql`

- [ ] **Step 1: Append DDL**

```surql
DEFINE TABLE evidence_ledger SCHEMAFULL TYPE NORMAL;
DEFINE FIELD memo_id      ON evidence_ledger TYPE record<memos>;
DEFINE FIELD source_event ON evidence_ledger TYPE option<record<events>>;
DEFINE FIELD source_memo  ON evidence_ledger TYPE option<record<memos>>;
DEFINE FIELD polarity     ON evidence_ledger TYPE string;
DEFINE FIELD weight       ON evidence_ledger TYPE float DEFAULT 1.0;
DEFINE FIELD reason       ON evidence_ledger TYPE string;
DEFINE FIELD ts           ON evidence_ledger TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta         ON evidence_ledger TYPE option<object> FLEXIBLE;
DEFINE INDEX evidence_memo_ts   ON evidence_ledger FIELDS memo_id, ts;
DEFINE INDEX evidence_polarity  ON evidence_ledger FIELDS memo_id, polarity;
DEFINE INDEX evidence_reason    ON evidence_ledger FIELDS reason;
```

- [ ] **Step 2: Run migration → clean**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat(schema): evidence_ledger table"
```

### Task 2: fn::derived_confidence

**Files:** `src/schema/migrations/0001-init.surql`

- [ ] **Step 1: Append function**

```surql
DEFINE FUNCTION fn::derived_confidence($memo: record<memos>) {
  LET $m = $memo.*;
  LET $cfg = (SELECT VALUE value FROM runtime:evidence.config)[0];
  LET $prior_w = $cfg.prior_weight ?? 3.0;
  LET $cor = (SELECT VALUE math::sum(weight) FROM evidence_ledger
              WHERE memo_id = $memo AND polarity = 'corroborates' GROUP ALL)[0] ?? 0;
  LET $ref = (SELECT VALUE math::sum(weight) FROM evidence_ledger
              WHERE memo_id = $memo AND polarity = 'refutes' GROUP ALL)[0] ?? 0;
  LET $num = $m.confidence * $prior_w + $cor;
  LET $den = $prior_w + $cor + $ref;
  RETURN math::min([1.0, math::max([0.0, $num / $den])]);
};
```

- [ ] **Step 2: Seed `runtime:evidence.config`**

```surql
UPSERT runtime:evidence.config CONTENT {
  value: {
    prior_weight: 3.0,
    biographer_weight: 0.5,
    manual_weight: 2.0
  }
};
```

- [ ] **Step 3: Verify**

Run a script: create memo with `confidence=0.5`; insert 2 corroborates + 1 refutes; call `fn::derived_confidence`; expect 0.5833 ± 0.001.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(schema): fn::derived_confidence + runtime:evidence.config"
```

---

## Phase 2 — `src/memory/evidence.js`

### Task 3: addEvidence + evidenceFor

**Files:** `src/memory/evidence.js`, `tests/unit/evidence-ledger.test.js`

- [ ] **Step 1: Failing test**

```js
test('addEvidence inserts ledger row; evidenceFor returns by memo', async () => {
  const db = await openMemDb();
  const e = stubEmbedder();
  const { id } = await store.note(db, e, 'knowledge', { content: 'x', derived_by: 'manual' });
  await addEvidence(db, { memo_id: id, polarity: 'corroborates', reason: 'manual', weight: 1.0 });
  const rows = await evidenceFor(db, id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].polarity, 'corroborates');
});
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement**

```js
// src/memory/evidence.js
import { surql } from 'surrealdb';

export async function addEvidence(db, { memo_id, polarity, reason, weight = 1.0, source_event, source_memo, meta }) {
  if (polarity !== 'corroborates' && polarity !== 'refutes') throw new Error(`bad polarity: ${polarity}`);
  await db.query(surql`
    CREATE evidence_ledger CONTENT ${{
      memo_id, polarity, reason, weight, source_event, source_memo, meta,
    }}
  `).collect();
}

export async function evidenceFor(db, memo_id) {
  const [rows] = await db.query(surql`
    SELECT * FROM evidence_ledger WHERE memo_id = ${memo_id} ORDER BY ts ASC
  `).collect();
  return rows ?? [];
}
```

- [ ] **Step 4: Run → pass; commit**

```bash
git commit -m "feat(memory): evidence.js addEvidence + evidenceFor"
```

### Task 4: recomputeConfidence — JS-side helper

**Files:** `src/memory/evidence.js`, `tests/unit/derived-confidence-formula.test.js`

- [ ] **Step 1: Failing test for formula**

```js
test('recomputeConfidence applies prior_weight blend correctly', async () => {
  const db = await openMemDb();
  const e = stubEmbedder();
  const { id } = await store.note(db, e, 'knowledge', {
    content: 'x', derived_by: 'manual', confidence: 0.5,
  });
  await addEvidence(db, { memo_id: id, polarity: 'corroborates', reason: 'manual', weight: 1 });
  await addEvidence(db, { memo_id: id, polarity: 'corroborates', reason: 'manual', weight: 1 });
  await addEvidence(db, { memo_id: id, polarity: 'refutes',      reason: 'manual', weight: 1 });

  const c = await recomputeConfidence(db, id);
  // (0.5*3 + 2) / (3 + 2 + 1) = 3.5 / 6 ≈ 0.5833
  assert.ok(Math.abs(c - 0.5833) < 0.001);
});
```

- [ ] **Step 2: Implement**

```js
export async function recomputeConfidence(db, memo_id) {
  const [rows] = await db.query(surql`
    SELECT fn::derived_confidence(id) AS c FROM ONLY ${memo_id}
  `).collect();
  const c = rows?.[0]?.c;
  if (c == null) return null;
  await db.query(surql`
    UPDATE ${memo_id} SET confidence = ${c}, meta.evidence_recomputed_at = time::now()
  `).collect();
  return c;
}
```

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "feat(memory): recomputeConfidence wrapper"
```

---

## Phase 3 — Producers

### Task 5: reinforcement.js — corroborate on reinforce; refute on correction (NEW)

**Files:** `src/recall/reinforcement.js`, `tests/unit/reinforcement-emits-evidence.test.js`

- [ ] **Step 1: Failing test (the keystone)**

```js
test('reinforce → corroborates ledger row + signal_count++', async () => {
  // seed memo, recall_log{outcome:pending}, no correction → run evaluatePending
  // assert: one evidence_ledger row, polarity=corroborates; signal_count=2
});

test('correction → refutes ledger row per hit memo (NEW BEHAVIOR)', async () => {
  // seed memo, recall_log{outcome:pending}, correction event in window → run evaluatePending
  // assert: one evidence_ledger row per hit memo, polarity=refutes, reason=correction
});
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Modify reinforcement.js**

In the reinforce branch (after `signal_count += 1`), add:

```js
await db.query(surql`
  CREATE evidence_ledger CONTENT {
    memo_id: ${hitId}, polarity: 'corroborates', reason: 'reinforcement', weight: 1.0
  }
`).collect();
```

In the corrected branch (before/instead of just marking outcome), add per-hit refute:

```js
for (const hit of row.ranked_hits) {
  const hitId = extractMemoId(hit);
  if (!hitId) continue;
  await db.query(surql`
    CREATE evidence_ledger CONTENT {
      memo_id: ${hitId}, polarity: 'refutes', reason: 'correction', weight: 1.0
    }
  `).collect();
}
```

- [ ] **Step 4: Run → pass; commit**

```bash
git commit -m "feat(reinforcement): emit corroborate/refute ledger rows"
```

### Task 6: store.relate(..., 'contradicts') auto-emits refutes rows

**Files:** `src/memory/store.js`, `tests/unit/contradicts-emits-evidence.test.js`

- [ ] **Step 1: Failing test**

```js
test('contradicts edge creates two refute ledger rows', async () => {
  const db = await openMemDb();
  const e = stubEmbedder();
  const a = await store.note(db, e, 'knowledge', { content: 'X', derived_by: 'manual' });
  const b = await store.note(db, e, 'knowledge', { content: 'Y', derived_by: 'manual' });
  await store.relate(db, a.id, b.id, 'contradicts');
  const [aL] = await db.query(`SELECT * FROM evidence_ledger WHERE memo_id = ${a.id}`).collect();
  const [bL] = await db.query(`SELECT * FROM evidence_ledger WHERE memo_id = ${b.id}`).collect();
  assert.equal(aL.length, 1);
  assert.equal(bL.length, 1);
  assert.equal(aL[0].polarity, 'refutes');
  assert.equal(aL[0].reason, 'contradicts_edge');
});
```

- [ ] **Step 2: Implement post-relate hook**

In `store.js`'s `relate`:

```js
const result = await _relateInternal(db, from, to, kind, opts);
if (kind === 'contradicts') {
  await db.query(surql`
    CREATE evidence_ledger CONTENT { memo_id: ${from}, polarity: 'refutes', reason: 'contradicts_edge', weight: 1.0 };
    CREATE evidence_ledger CONTENT { memo_id: ${to},   polarity: 'refutes', reason: 'contradicts_edge', weight: 1.0 };
  `).collect();
}
return result;
```

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "feat(store): contradicts edge auto-emits refute ledger rows"
```

### Task 7: Biographer optional `evidence_signals` output

**Files:** `src/capture/biographer-output.js`, `biographer-prompt.js`, `biographer.js`

- [ ] **Step 1: Update validator**

In `biographer-output.js`:

```js
function validateBiographerOutput(out) {
  // existing checks …
  if (out.evidence_signals !== undefined && !Array.isArray(out.evidence_signals)) {
    return { ok: false, error: 'evidence_signals must be array' };
  }
  for (const s of out.evidence_signals ?? []) {
    if (typeof s.memo_id !== 'string' || (s.polarity !== 'corroborates' && s.polarity !== 'refutes')) {
      return { ok: false, error: 'malformed evidence_signal' };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 2: Update prompt**

Extend the JSON-schema example in `biographer-prompt.js` to include `evidence_signals` with explanation: "Optional. When this event provides evidence about an existing memo, list it here."

- [ ] **Step 3: biographer.js processes signals**

```js
import { addEvidence } from '../memory/evidence.js';
import { policyFor } from '../memory/scope-registry.js';   // (Theme 1c if landed)

for (const s of output.evidence_signals ?? []) {
  await addEvidence(db, {
    memo_id: s.memo_id,
    polarity: s.polarity,
    reason: 'biographer',
    weight: 0.5,
    source_event: eventId,
  });
}
```

- [ ] **Step 4: Test + commit**

```bash
git commit -m "feat(biographer): optional evidence_signals output"
```

---

## Phase 4 — Dream recompute step

### Task 8: step-confidence-recompute

**Files:** `src/dream/step-confidence-recompute.js`, `src/dream/pipeline.js`, `tests/unit/step-confidence-recompute.test.js`

- [ ] **Step 1: Failing test**

```js
test('recompute updates only memos with recent ledger activity', async () => {
  const db = await openMemDb();
  const e = stubEmbedder();
  const a = await store.note(db, e, 'knowledge', { content: 'A', derived_by: 'manual', confidence: 0.5 });
  const b = await store.note(db, e, 'knowledge', { content: 'B', derived_by: 'manual', confidence: 0.5 });
  // Only A gets a ledger row
  await addEvidence(db, { memo_id: a.id, polarity: 'corroborates', reason: 'reinforcement' });

  await dreamStepConfidenceRecompute(db);

  const [aRow] = await db.query(`SELECT confidence FROM ${a.id}`).collect();
  const [bRow] = await db.query(`SELECT confidence FROM ${b.id}`).collect();
  // A's confidence shifted; B's unchanged
  assert.ok(aRow[0].confidence > 0.5);
  assert.equal(bRow[0].confidence, 0.5);
});
```

- [ ] **Step 2: Implement**

```js
// src/dream/step-confidence-recompute.js
import { surql } from 'surrealdb';

export async function dreamStepConfidenceRecompute(db) {
  // memos with ledger rows newer than their meta.evidence_recomputed_at (or never recomputed)
  const [stale] = await db.query(surql`
    SELECT DISTINCT VALUE memo_id FROM evidence_ledger
    WHERE ts > (SELECT VALUE meta.evidence_recomputed_at FROM ONLY $parent.memo_id)
       OR (SELECT VALUE meta.evidence_recomputed_at FROM ONLY $parent.memo_id) IS NONE
  `).collect();

  let updated = 0;
  for (const id of stale ?? []) {
    await db.query(surql`
      UPDATE ${id} SET
        confidence = fn::derived_confidence(id),
        meta.evidence_recomputed_at = time::now()
    `).collect();
    updated++;
  }
  return { updated };
}
```

(If the subquery form doesn't work as-written, fall back to a JS-side loop: read distinct memo_ids, read each memo's `meta.evidence_recomputed_at`, filter.)

- [ ] **Step 3: Wire into pipeline.js**

```js
import { dreamStepConfidenceRecompute } from './step-confidence-recompute.js';
// after step-reflection:
try { summary.confidence = await dreamStepConfidenceRecompute(db); } catch (e) { summary.confidence = { error: e.message }; }
```

- [ ] **Step 4: Run → pass; commit**

```bash
git commit -m "feat(dream): step-confidence-recompute"
```

---

## Phase 5 — MCP tools

### Task 9: endorse + refute

**Files:** `src/mcp/tools/endorse.js`, `refute.js`, `src/daemon/server.js`

- [ ] **Step 1: Failing test**

```js
test('endorse adds corroborates row with weight=2.0', async () => {
  // call handler, assert ledger row
});
```

- [ ] **Step 2: Implement**

```js
// src/mcp/tools/endorse.js
import { addEvidence } from '../../memory/evidence.js';

export function createEndorseTool({ db }) {
  return {
    name: 'endorse',
    description: 'Add a positive evidence signal for a memo (raises confidence over time).',
    inputSchema: {
      type: 'object',
      properties: { memo_id: { type: 'string' }, reason: { type: 'string' } },
      required: ['memo_id'],
    },
    async handler({ memo_id, reason }) {
      const cfg = await readEvidenceConfig(db);
      await addEvidence(db, {
        memo_id, polarity: 'corroborates', reason: reason ?? 'manual',
        weight: cfg.manual_weight ?? 2.0,
      });
      return { ok: true };
    },
  };
}
```

`refute.js` mirrors with `polarity: 'refutes'`.

- [ ] **Step 3: Register + commit**

```bash
git commit -m "feat(mcp): endorse + refute tools"
```

---

## Phase 6 — Verification gates + docs

Spec §8 gates (one test each):

1. Corroborate-on-reinforce (Task 5)
2. Refute-on-correction (Task 5)
3. Derivation correctness (Task 4)
4. Bounded [0,1] (new test with extreme fixtures)
5. Recompute idempotent (Task 8)
6. Recompute selective (Task 8)
7. contradicts auto-emits (Task 6)
8. Manual weight higher (Task 9)
9. Replay consistency — chronological replay reproduces stored confidence
10. Biographer signals optional (Task 7)

One commit per remaining gate.

### Task 10: Docs

- [ ] Update `docs/architecture.md` confidence-as-derived section.
- [ ] Update `docs/faculties.md` reinforcement+evidence interplay.

```bash
git commit -m "docs(evidence): ledger + derivation + reinforcement interplay"
```

## Self-review

- [ ] All 10 spec gates covered.
- [ ] No placeholders.
- [ ] `addEvidence`, `recomputeConfidence`, `evidenceFor`, `dreamStepConfidenceRecompute` consistently named.

## Final commit

```bash
git push -u origin feat/theme-2a-evidence-ledger
gh pr create --title "Theme 2a: Evidence ledger → derived confidence"
```
