# Robin v2 — Theme 2a: Evidence ledger

**Status:** Design (working draft; impl waits for `feat/surrealdb-improvements` merge)
**Date:** 2026-05-11
**Umbrella:** `2026-05-11-robin-v2-evolution-roadmap.md` (Theme 2a)
**Depends on:** `2026-05-11-surrealdb-improvements-design.md` (engine swap; nothing structural)

## Why

Today's confidence model is asymmetric and frozen:

- `memos.confidence: float` is set at write time and **never updates after.**
- `signal_count` is incremented by the reinforcement loop on recall hits that go uncorrected — but this only feeds `fn::freshness` (the *ranking* function). The stored `confidence` stays put.
- When a recall hit is corrected (`recall_log.outcome = 'corrected'`), the loop marks the row and **does nothing to the memo.** No symmetric refutation.

Net effect: belief never weakens via lightweight signals. The only way to reduce a memo's standing is the all-or-nothing `supersedes` edge or the symmetric `contradicts` edge — both heavy mechanisms requiring an LLM judgement or explicit user action.

## Goals

- Add the missing refutation path: `corrected` recall outcomes should weaken confidence in the memos that were hit.
- Make confidence derivable from accumulated evidence (corroborations + refutations) at any point in time.
- Preserve the full evidence history so audits can answer "why does Robin believe X with this confidence?"
- Zero new LLM tokens in v1.

## Non-goals

- Replacing `signal_count` (it stays as a cached corroboration count for `fn::freshness`'s hot path).
- Replacing `contradicts` edges (they stay; ledger rows derive from them).
- Bayesian update with full posterior tracking — a pseudocount-prior Beta-ish blend is sufficient and explainable.
- Reranker training on ledger data (out of scope; consumes ledger but doesn't shape it).
- Multi-tier evidence (e.g., "weak / moderate / strong") — `weight` field captures this scalar-ly.
- Per-session reinforcement deduplication (open question; defer to telemetry).

## Anchoring decisions

**Why a new `evidence_ledger` table, not edges:**

- Edges have an identity (kind, in, out) optimised for graph traversal. Evidence rows have a *temporal* identity (memo, polarity, ts) optimised for replay and aggregation.
- The producer of evidence is often *not the source memo or event* — it's a derived signal ("the recall loop noticed no correction"). Stuffing this into the edge graph adds noise to entity-relationship queries.
- Ledger is append-only; rows accumulate. Edges by composite ID are idempotent UPSERTs. Different semantics.

**Why a derivation function, not COMPUTED:**

- `fn::freshness` reads `confidence` in the hot recall path. COMPUTED `confidence` would issue per-row subqueries; recall@10 latency would tank.
- Stored column with lazy recompute keeps reads cheap and writes bounded.

**Why pseudocount-prior over true Bayesian posterior:**

- Explainability. `(initial × prior_weight + cor) / (prior_weight + cor + ref)` reads as "initial confidence equivalent to N votes; new evidence drifts it." Beta posteriors require explaining alpha/beta.
- Bounded behavior matches intuition: confidence trends toward `cor / (cor + ref)` as evidence accumulates.
- Tuneable via single `prior_weight` config knob.

**Why backward-compat with `signal_count`:**

- `fn::freshness` is on the recall hot path; we don't want to add a subquery there.
- `signal_count` is a cached corroboration count — the ledger is its source of truth.
- Pure addition; no migration cost.

## Section 1 — Schema

```surql
DEFINE TABLE evidence_ledger SCHEMAFULL TYPE NORMAL;
DEFINE FIELD memo_id      ON evidence_ledger TYPE record<memos>;
DEFINE FIELD source_event ON evidence_ledger TYPE option<record<events>>;
DEFINE FIELD source_memo  ON evidence_ledger TYPE option<record<memos>>;
DEFINE FIELD polarity     ON evidence_ledger TYPE string;       -- 'corroborates' | 'refutes'
DEFINE FIELD weight       ON evidence_ledger TYPE float DEFAULT 1.0;
DEFINE FIELD reason       ON evidence_ledger TYPE string;       -- 'reinforcement' | 'correction' | 'biographer' | 'manual' | 'contradicts_edge'
DEFINE FIELD ts           ON evidence_ledger TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta         ON evidence_ledger TYPE option<object> FLEXIBLE;
DEFINE INDEX evidence_memo_ts   ON evidence_ledger FIELDS memo_id, ts;
DEFINE INDEX evidence_polarity  ON evidence_ledger FIELDS memo_id, polarity;
DEFINE INDEX evidence_reason    ON evidence_ledger FIELDS reason;
```

Add `memos.meta.evidence_recomputed_at: option<datetime>` (no schema change required — `meta` is FLEXIBLE).

## Section 2 — Derivation function

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

**Properties:**

- With no evidence: `derived = initial` (prior wins, numerator = initial × prior_w, denominator = prior_w).
- With many corroborations, no refutations: `derived → 1.0` asymptotically.
- With many refutations, no corroborations: `derived → 0.0` asymptotically.
- Bounded [0, 1] by clamp.

## Section 3 — Lazy update path

New dream step `step-confidence-recompute` (or fold into existing `step-reflection`). Runs nightly:

```surql
UPDATE memos SET
  confidence = fn::derived_confidence(id),
  meta.evidence_recomputed_at = time::now()
WHERE id IN (
  SELECT VALUE memo_id FROM evidence_ledger
  WHERE ts > (SELECT VALUE meta.evidence_recomputed_at FROM memos WHERE id = $parent.memo_id)
     OR (SELECT VALUE meta.evidence_recomputed_at FROM memos WHERE id = $parent.memo_id) IS NONE
);
```

(Exact SurrealQL idiom pinned at impl time — illustrative. The goal: recompute only memos with ledger activity since their last recompute.)

## Section 4 — Producers

| Path | When | Polarity | Reason | Weight | New in 2a? |
|---|---|---|---|---|---|
| `reinforcement.js` (`recall_log → reinforced`) | recall hit, no correction in 5-min window | `corroborates` | `reinforcement` | 1.0 | yes — ledger insert added |
| `reinforcement.js` (`recall_log → corrected`) | recall hit, correction landed | `refutes` | `correction` | 1.0 | **yes — new behavior** |
| `store.js` (`relate(..., 'contradicts')`) | symmetric memo↔memo contradiction created | `refutes` (×2; one per memo) | `contradicts_edge` | 1.0 | yes — auto-emit on edge create |
| `biographer.js` (optional output field) | LLM judges new event as evidence for/against an existing memo | as judged | `biographer` | 0.5 | yes — new optional output field |
| MCP `endorse` / `refute` | explicit user/agent signal | as named | `manual` | 2.0 | yes — new tools |

### 4.1 Reinforcement loop changes

`src/recall/reinforcement.js`:

```js
// Existing reinforce path
for (const hit of row.ranked_hits) {
  if (!hitId.startsWith('memos:')) continue;
  await db.query(surql`UPDATE ${hitId} SET signal_count += 1, decay_anchor = time::now()`);
  // NEW: insert ledger row
  await db.query(surql`
    CREATE evidence_ledger CONTENT {
      memo_id: ${hitId},
      polarity: 'corroborates',
      reason: 'reinforcement',
      weight: 1.0
    }
  `);
}

// NEW: refute path on corrected outcome
if (correctionCount > 0) {
  outcome = 'corrected';
  for (const hit of row.ranked_hits) {
    if (!hitId.startsWith('memos:')) continue;
    await db.query(surql`
      CREATE evidence_ledger CONTENT {
        memo_id: ${hitId},
        polarity: 'refutes',
        reason: 'correction',
        weight: 1.0
      }
    `);
  }
}
```

Both can be batched into one multi-statement query per loop iteration (cost optimisation from surrealdb-improvements §3 carries over).

### 4.2 `contradicts` auto-emission

`src/memory/store.js`'s `relate()` and `flagContradiction()` paths gain a post-relate hook:

```js
async function relate(db, from, to, kind, opts) {
  const result = await _relate(db, from, to, kind, opts);
  if (kind === 'contradicts') {
    // both endpoints are memos by registry constraint
    await db.query(surql`
      CREATE evidence_ledger CONTENT { memo_id: ${from}, polarity: 'refutes', reason: 'contradicts_edge', weight: 1.0 };
      CREATE evidence_ledger CONTENT { memo_id: ${to},   polarity: 'refutes', reason: 'contradicts_edge', weight: 1.0 };
    `);
  }
  return result;
}
```

### 4.3 Biographer optional output

`biographer-output.js` schema extends:

```json
{
  "entities": [...],
  "about": [...],
  "edges": [...],
  "evidence_signals": [
    { "memo_id": "memos:abc", "polarity": "corroborates", "reason": "new fact aligns" },
    { "memo_id": "memos:xyz", "polarity": "refutes", "reason": "contradicts earlier claim" }
  ]
}
```

Prompt updated to encourage emission when relevant. `evidence_signals` defaults to `[]`; existing biographer behavior unchanged when LLM omits the field.

## Section 5 — `runtime:evidence.config`

```json
{
  "prior_weight": 3.0,
  "biographer_weight": 0.5,
  "manual_weight": 2.0
}
```

Seeded by schema bootstrap. Re-read by `step-confidence-recompute`.

## Section 6 — MCP tools

```js
// src/mcp/tools/endorse.js
export function createEndorseTool({ db }) {
  return {
    name: 'endorse',
    description: 'Add a positive evidence signal for a memo (raises its confidence over time).',
    inputSchema: {
      type: 'object',
      properties: {
        memo_id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['memo_id'],
    },
    async handler({ memo_id, reason }) {
      await addEvidence(db, { memo_id, polarity: 'corroborates', reason: reason ?? 'manual', weight: 2.0 });
      return { ok: true };
    },
  };
}

// src/mcp/tools/refute.js
// (mirror; polarity='refutes')
```

Agent-facing. Agent can `endorse(M)` when it observes confirming evidence in a session, `refute(M)` when it sees disconfirming evidence.

## Section 7 — Cost envelope

- Per reinforcement: +1 INSERT (ledger row). Microseconds.
- Per correction: +N INSERTs (N ≤ recall.k, typically ≤ 10). Sub-millisecond batch.
- Per `contradicts` edge: +2 INSERTs.
- `step-confidence-recompute` nightly: 2 SUM queries per memo with ledger activity since last recompute. Bounded by activity rate.
- New LLM tokens: **zero** (biographer's existing call gains an optional output field; no new invocation).
- New embedding cost: **zero**.

Within roadmap §4 envelope.

## Section 8 — Verification gates

1. **Corroborate-on-reinforce:** simulated `recall_log → reinforced` flow produces one `evidence_ledger` row per hit memo (`polarity='corroborates'`, `reason='reinforcement'`); `signal_count` also incremented.
2. **Refute-on-correction:** simulated `recall_log → corrected` flow produces one row per hit memo (`polarity='refutes'`, `reason='correction'`).
3. **Derivation correctness:** with fixture (initial=0.5, prior_weight=3, cor=2, ref=1), `fn::derived_confidence` returns `(0.5*3 + 2)/(3 + 2 + 1) = 0.5833…` within ±0.001.
4. **Bounded:** `derived_confidence` stays in [0, 1] for fixtures with extreme cor/ref counts (1000 vs 0; 0 vs 1000).
5. **Recompute idempotent:** running `step-confidence-recompute` twice with no new ledger rows → no `memos.confidence` change.
6. **Recompute selective:** ledger row written for memo A → only A's confidence updates; unrelated memos untouched (verified via `meta.evidence_recomputed_at`).
7. **`contradicts` auto-emits:** `store.relate(M1, M2, 'contradicts')` → two ledger rows (one per memo).
8. **Manual weight is higher:** one `endorse(M)` followed by recompute → confidence rises more than a single reinforcement row would.
9. **Replay consistency:** for any memo, chronologically applying the derivation formula across its ledger rows reproduces current `confidence` within ±0.001.
10. **Biographer signals optional:** biographer LLM output missing `evidence_signals` field is accepted (no ledger emission).

## Section 9 — File-by-file changes

**Created:**

- `src/memory/evidence.js` — `addEvidence(db, opts)`, `recomputeConfidence(db, memoId)`, `evidenceFor(db, memoId)`.
- `src/dream/step-confidence-recompute.js`
- `src/mcp/tools/endorse.js`, `refute.js`.
- `tests/unit/evidence-ledger.test.js`
- `tests/unit/derived-confidence-formula.test.js`
- `tests/integration/evidence-replay.test.js`
- `tests/fixtures/evidence-golden.json`

**Modified:**

- `src/schema/migrations/0001-init.surql` — add `evidence_ledger` table, `fn::derived_confidence` function, seed `runtime:evidence.config`.
- `src/recall/reinforcement.js` — ledger emission on reinforce (additive); refute emission on correction (new behavior).
- `src/memory/store.js` — `relate(..., 'contradicts')` auto-emits ledger rows; new exports for `addEvidence`.
- `src/capture/biographer-prompt.js` — prompt extension encouraging `evidence_signals` output.
- `src/capture/biographer-output.js` — validator allows `evidence_signals: array<object> default []`.
- `src/capture/biographer.js` — when LLM returns `evidence_signals`, emit ledger rows.
- `src/dream/pipeline.js` — register `step-confidence-recompute` after `step-reflection`.
- `src/daemon/server.js` — register `endorse` / `refute` MCP tools.
- `docs/architecture.md` — "Confidence as a derived signal" section.
- `docs/faculties.md` — reinforcement + evidence ledger interplay.

## Section 10 — Sequencing within Theme 2a

1. Schema: `evidence_ledger` + `fn::derived_confidence` + config row.
2. Reinforcement loop: ledger writes (corroborate + refute) — schema-additive.
3. `contradicts` edge auto-emission.
4. `step-confidence-recompute` dream step.
5. MCP tools (`endorse`, `refute`).
6. Biographer output extension (optional field).
7. Tests + verification gates.

## Section 11 — Dependencies

- **Waits for** `feat/surrealdb-improvements` merge (engine swap to `surrealkv+versioned` enables free time-travel reads of the ledger; not load-bearing for impl).
- Independent of Themes 1a / 1b / 1c.
- **Feeds Theme 4 (observability):** `explain_confidence(memo_id)` introspection MCP tool — designed in Theme 4 — reads `evidence_ledger`.

## Section 12 — Open questions (post-impl review)

- **Per-session reinforcement dedup.** A memo hit multiple times in one session accumulates multiple corroborates rows. Should we dedup by `(memo_id, session_id, day)` to avoid runaway confidence? Validate against telemetry; tighten if data shows confidence climbing unrealistically fast.
- **Targeted refutation on `corrected` outcome.** Today the refute path penalises *all* hits in the corrected row. Real correction may only refute one. Future reranker work could narrow. Acceptable v1 cost.
- **Manual weight (2.0) vs config knob.** Default is fine; tunable via `runtime:evidence.config.manual_weight`. Re-tune if endorsements feel under- or over-weighted in practice.
- **Should `supersedes` emit a ledger row on the superseded memo?** It already gets `fn::freshness=0` via the edge; ledger row would also crater confidence. Probably redundant; defer.

## See also

- `2026-05-11-robin-v2-evolution-roadmap.md` — umbrella, Theme 2.
- `2026-05-11-robin-v2-database-and-memory-redesign-design.md` — `signal_count`, reinforcement loop, `fn::freshness`.
- `2026-05-11-robin-v2-theme-1a-compaction-design.md` — sibling; uses `signal_count × confidence` for canonical selection.
- `src/recall/reinforcement.js` — the main producer site for ledger writes.
