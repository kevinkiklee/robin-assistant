# Robin v2 — Cognition B2: Contradiction surfacing at recall

**Status:** Design (working draft)
**Date:** 2026-05-11
**Umbrella:** `2026-05-11-robin-v2-evolution-roadmap.md` (post-alpha.16, "Cognition B" track)
**Depends on:** alpha.16 Theme 2a (`evidence_ledger` + `fn::derived_confidence`); `2026-05-11-cognition-d1-state-inference-design.md` for block ordering.

## Why

Today the recall pipeline knows about `contradicts` edges but the *agent* never does. `rank.score` consumes a per-hit `contradictionCount` and applies `contraPenalty = max(0.1, 1 - 0.3 × contradictionCount)` — so a memo with three live contradictors gets its rank multiplied by 0.1. That's the *only* thing the contradiction signal does on the recall path. The agent sees a lower-ranked single memo and has no idea its claim is disputed.

Two consequences:

1. **The agent can't adjudicate.** When the user asks "wait, when did I switch banks?", the freshest memo wins and Robin confidently reports the loser of an unresolved dispute. The contradicting memo exists in the substrate; the agent never gets to weigh it.
2. **The penalty is dormant anyway.** `inject.js` calls `score(h, { session_id: undefined })` (the first `score()` call, building the `merged` array from `[...eventHits, ...memoHits]`) with `h = {record, distance, _kind}` — no `contradictionCount` field. `score()` in `rank.js` defaults the missing field to `0`, so `contraPenalty` is *always* `1.0` on the intuition path today. The penalty exists in code but the input is never wired. Surfacing the conflict is also the natural occasion to fix that.

We want a deterministic, cost-controlled mechanism that:

- Detects, at recall time, which top-K hits have live contradictors.
- Pulls the *other side* of each contradiction into the prompt under a dedicated marker so the agent can see both claims.
- Suppresses noise (low-confidence, superseded, private, stale, capped).
- Preserves the existing ranking and outcome-bucketing semantics.

This is a strict superset of today's behavior: when no contradictions are detected, the prompt is byte-identical to today.

## Goals

- Surface both sides of a contradiction in the agent prompt as a separate, capped block — `<!-- conflicts -->`.
- One extra batched roundtrip per recall on the intuition path; zero net LLM/embedding tokens; zero additional cost when the substrate has no `contradicts` edges in the top-K's neighborhood.
- Preserve ranking semantics: the existing `contraPenalty` continues to deprioritize the contradicted side; contradicting refs are *separately* hydrated into the conflicts block.
- Fail-soft on every step. A failure of the conflicts hydration must not break the relevant-memory block or the `recall_log` write.
- Per-turn cap (default 3) so a pathological topic with N contradicting memos doesn't blow the prompt budget.
- Behind a runtime flag (`runtime:recall` row, `value.conflict_surfacing_enabled`, default `false`) until a dogfood week confirms quality. The row identifier is `runtime:recall` per `store.js:479`; the field nests under `value` like every other key in that singleton.

## Non-goals

- Adjudicating contradictions in Robin code (writing `supersedes`, resolving). The agent does that work — and when it asserts a resolution, biographer + reflection produce the next `supersedes`/`contradicts` edge naturally. We expose; we don't decide.
- Surfacing contradictions for *event* hits. `contradicts` is a `memos`→`memos` edge per `edge-registry.js:32`. Events cannot be contradicted; only the distilled `memos[kind=knowledge]` claims about them can.
- Re-computing freshness or evidence-ledger derived confidence inline. We read the already-stored `memos.confidence` and the already-stored freshness via `fn::freshness`. Theme 2a's nightly `step-confidence-recompute` already keeps `confidence` in sync.
- Extending `contradicts` to non-memo surfaces or N-way conflicts. Today an N-way conflict is N(N-1)/2 pairwise edges; the suppression cap (default 3 conflicts surfaced) handles dense webs gracefully.
- Replacing the dormant `contraPenalty` math. We continue to penalize *in addition to* surfacing.

## Anchoring decisions

**Why one extra batched query rather than fetching at engine-level alongside the hit:**

The substrate today serves `_surfaceSearch` (`store.js:500-640`) over a HNSW kNN + BM25 fusion path. That function is the workhorse for recall, MCP tools, and lenses (`searchKnowledge`, `searchEvents`, etc.). Adding contradiction expansion *inside* `_surfaceSearch` would:

- Pay the cost on every caller (MCP `recall`, biographer's `searchKnowledge`, dream's `searchKnowledge`) — most of which don't surface results to the agent and therefore don't need the contradicting refs.
- Couple the engine's contract (`{record, distance, _sources, ...}`) to a feature that's only meaningful in the intuition path.

The cleaner placement is *one* batched expansion query inside `intuitionEndpoint` (`inject.js`), gated on the top-K hits the agent is actually about to see. It runs after MMR-lite and the greedy-pack step (so we expand only what fits the relevant-memory budget). One SurrealDB roundtrip — two `SELECT`s sequenced via a multi-statement `BoundQuery` returning two result sets — keeps the cost per recall at +1 roundtrip regardless of `k`.

**Why a separate `<!-- conflicts -->` block, not inline pair markers or per-hit suffixes:**

Three formats were considered:

1. **Inline pair** — `[event 2026-04-30] X is true <-> [memo conflicts 3d ago] Y is true (conf 0.6)` inside the relevant-memory block. Compact, but: (a) muddles the relevant-memory block's contract (one fact per line, agent-readable as a flat list); (b) makes greedy-pack budgeting weird (a "line" is now sometimes 2× normal length); (c) the contradicting side ends up sharing the relevant-memory token budget — which contradicts the rest of the design (we want a *separate* cap).
2. **Per-hit suffix** — `[event 2026-04-30] X is true (contradicted by [memo 2026-04-22])`. Tells the agent there's a conflict but *not what the other claim is*. Worst of both worlds: pays a tiny formatting cost for no adjudication signal.
3. **Separate block** — `<!-- conflicts -->\n[memo 2026-04-30] X is true <-> [memo 2026-04-22] Y is true (conf 0.60 <-> 0.55)\n<!-- /conflicts -->`. Distinct contract (the agent can be instructed to adjudicate this block specifically); independent token budget; no impact on the relevant-memory line shape; trivially omitted when empty.

The separate block wins. It mirrors the precedent set by D1's `<!-- current focus -->`: privileged, capped, distinct contract, top-of-prompt placement.

**Why pull the contradicting memo even if it didn't rank into top-K, rather than relaxing `contraPenalty`:**

`contraPenalty` is a ranking penalty: "this hit is disputed, so be less confident about it." Relaxing it to "let both sides rank" would change ranking outcomes for every consumer of `rank.score` — including biographer's own searches, dream steps, and MCP `recall`. That's a large blast radius for a feature that only matters at agent-prompt-surfacing time.

The targeted fix is: keep the penalty (and finally wire `contradictionCount` into the score call site so it does what it's documented to do), and *separately* pull the contradicting memo into the conflicts block at the surfacing step. Ranking semantics are unchanged across all callers; only the intuition path gets the new block.

The corollary: a contradicting memo may surface in the conflicts block *without* appearing in the relevant-memory block. That's intended — the conflicts block has its own contract (pairs, with both sides shown) and its own budget.

**Why fetch contradictors per top-K hit, not per all recalled hits:**

MMR-lite + greedy-pack (the `inject.js` block after the rank.score call, before telemetry emission) already trims merged hits down to what the agent will see. Hydrating contradictors for trimmed-out hits would waste roundtrip bytes (and DB cycles binding the lookup). We run conflict expansion *after* MMR-lite + greedy-pack so the input set is exactly the `lines` the relevant-memory block will contain — strict superset of the agent's view.

**Why apply suppression rules at hydration time, not via SurrealQL `WHERE`:**

The five suppression rules (§5) read both sides of the pair: e.g., "either memo has `confidence < threshold`" needs the hydrated `confidence` from *both* memos. Pushing that into SurrealQL would require a self-join + a freshness call per row + a scope predicate that handles `private` symmetrically. Hydrate once, filter in JS — straightforward, deterministic, and the only sensitive cost (round-trips) doesn't change.

**Why a per-turn cap rather than per-topic or session-cumulative:**

The cap is a budget guard, not a content guard. Surfacing 3 distinct conflicts in one turn uses ~300 tokens; surfacing 30 uses ~3000. The harm scales with surfaced count, and surfaced count maps cleanly to per-turn prompt budget. Per-topic / per-session caps would require state we don't otherwise need; deferred to telemetry-driven future iteration if needed.

## Section 1 — Detection at recall

### 1.1 Where the work lives

In `system/cognition/intuition/inject.js`, split across two insertion points:

- **Hydration** (`fetchContradictors`): between the `memoHits` construction (inside the intuition fan-out `Promise.all`) and the first `score()` call (the one that builds the `merged` array). Must run before ranking so the `contradictionCount` input wires (§1.3).
- **Block assembly** (`buildConflictBlock` + suppression): after greedy-pack hits computed, so we know which memos survived MMR-lite and the per-line budget — only those memos may be a pair's "hit side" (§1.2).

The conflicts block, when produced, is concatenated *above* the relevant-memory block (and *below* D1's focus block when D1 has shipped). Fail-soft is enforced *inside* `fetchContradictors` and `buildConflictBlock` themselves — both wrap their bodies in try/catch and return safe defaults (`{pairs: []}` and `''` respectively) on any error. This keeps the call sites in `inject.js` clean (no extra try blocks needed) and matches the existing pattern for the `intuition_telemetry` `CREATE` and the `recall_log` `CREATE` blocks (in `inject.js`'s telemetry-emission tail), which are also internally fail-soft.

A new helper module `system/cognition/intuition/conflicts.js` exports:

```js
// Pure functions where possible; the one DB-touching function (`fetchContradictors`)
// is fail-soft and returns `{ pairs: [], pairs_precap: 0 }` on any error.
// `now` is injected (not Date.now()) for testability — pure functions all the
// way down from buildConflictBlock onward.
export async function fetchContradictors(db, hitIds, config) { … }   // §1.2
export function applySuppression(pair, now, config) { … }            // §5 — returns {keep:bool, reason?:string, redactSide?:'side'|'other'}
export function buildConflictBlock(pairs, visibleHitIdSet, now, config) { … }  // §2.1
```

The `visibleHitIdSet` parameter is the JS `Set` of `String(record.id)` for memos that made it into greedy-packed `hits`. `buildConflictBlock` uses it to enforce the §1.1 filter (`hitSide ∈ greedy-packed hits`).

Why a separate module: keeps `inject.js` linear (it already does fan-out + merge + MMR + pack + telemetry + recall_log); the conflicts logic is independently unit-testable as a pure function over hydrated pairs.

### 1.2 Hydration: one batched roundtrip

After the recall fan-out builds `memoHits` (inside the intuition fan-out `Promise.all`), extract the memo-side record IDs *before* the first `score()` call is invoked so `contradictionCount` can be wired (§1.3). Implementation:

```js
const memoIds = memoHits.map((h) => h.record.id);
```

(Per the shape produced by the fan-out, `memoHits[i].record` is the hydrated memo row from `searchMemos`, and `.id` is the SurrealDB record reference.) Skip the entire conflicts step when `memoIds.length === 0` — no memo hits means no contradictions can exist among the in-view set.

When `memoIds.length > 0`, issue **one** multi-statement BoundQuery returning two result sets:

```surql
-- Statement 1: contradict-edge endpoints for any hit memo.
-- contradicts is symmetric (edge-registry.js:32) → canonicalised at write
-- (canonicalEndpoints in edge-registry.js:96-102) so we must scan both
-- in/out sides. Each pair returns once because the composite PK
-- [kind, in, out] is unique per canonical pair.
SELECT in, out FROM edges
WHERE kind = 'contradicts'
  AND (in IN $hits OR out IN $hits);

-- Statement 2: hydrate every distinct memo on either side of a returned
-- edge plus the hit-side memo (we already have hit content, but we need
-- the confidence + ts + scope + meta of the contradictor we DID NOT rank).
-- The caller computes the union id list from statement 1's result and
-- substitutes it as $ids in a second BoundQuery.
SELECT id, content, ts, scope, confidence, derived_at, meta,
       fn::freshness(id) AS freshness
FROM memos WHERE id IN $ids;
```

In practice we cannot know `$ids` for statement 2 until statement 1 returns, so the hydration is two roundtrips if executed naively. We collapse to one roundtrip with SurrealQL `LET` blocks plus a final `RETURN`:

```surql
-- $hits is bound by the caller. contradicts is symmetric and canonicalised
-- at write time (edge-registry.js:96-102), so a pair (A,B) where A<B in
-- string order is stored once as (in=A, out=B). Two SELECTs (one per
-- "side") cover both orientations; we tag each row with which side of the
-- canonical pair the hit was on.
LET $contras_in = (
  SELECT { side: in, other: out } AS pair FROM edges
  WHERE kind = 'contradicts' AND in IN $hits
);
LET $contras_out = (
  SELECT { side: out, other: in } AS pair FROM edges
  WHERE kind = 'contradicts' AND out IN $hits
);
-- Concatenate. A "self-pair" (both A and B in $hits) will appear in BOTH
-- result sets — we'll dedup in JS by canonicalising (min,max) of (side,other).
LET $contras = array::concat($contras_in, $contras_out);
LET $ids = array::distinct(array::concat(
  $contras.pair.side,
  $contras.pair.other
));
RETURN {
  pairs: $contras,
  memos: (SELECT id, content, ts, scope, confidence, derived_at, meta,
                 fn::freshness(id) AS freshness
          FROM memos WHERE id IN $ids)
};
```

One roundtrip; three `LET`s + one `RETURN` projection. `array::concat` and `array::distinct` are the same SurrealQL helpers used elsewhere in the codebase (e.g., `biographer/pipeline.js:83`). The `.pair.side` access uses SurrealDB's "projection over array of objects" idiom — same shape as `$contras.id` for record-array results.

**JS-side dedup for self-pairs.** When both endpoints of a contradicts edge are in `$hits`, both `$contras_in` and `$contras_out` return that row. After fetching, JS canonicalises each pair to a sorted-string-id tuple and de-duplicates by tuple key:

```js
const seen = new Set();
const deduped = [];
for (const row of pairs) {
  const sideId = String(row.pair.side);
  const otherId = String(row.pair.other);
  const key = sideId < otherId ? `${sideId}|${otherId}` : `${otherId}|${sideId}`;
  if (seen.has(key)) continue;
  seen.add(key);
  deduped.push(row.pair);
}
```

The kept row's `side` is the orientation we'll use for the "hit side" choice in §2.4 (self-pair: re-pick by confidence/ts; one-in-view: the in-view memo is the side).

Bind: `$hits = memoIds` (array of `RecordId` refs as returned by `searchMemos`; the SDK serializes them transparently).

JS-side: build `memosById = new Map(memos.map(m => [String(m.id), m]))`. For each deduped `{side, other}` pair, look up both rows in `memosById` and produce `{hitSide, otherSide}` records carrying the full hydrated memo on each side. (We don't need `last_seen` on the edge for surfacing; the contradiction is by definition "still live" because `relate(...,'contradicts')` is idempotent UPSERT and `supersedes` short-circuits the conflict at the freshness layer — covered in §5 rule 2.)

The pairs returned by `fetchContradictors` are scoped to `memoHits` (the pre-MMR memo set). The conflict block builder (§2) filters further: it only emits a pair when `String(hitSide.id)` is in the post-greedy-pack `hits` set (a memo the agent will actually see in `<!-- relevant memory -->`). The `otherSide` is *not* required to be in `hits` — that's the explicit "pull the contradictor in even if it didn't rank" semantic of §4. This separation lets `contradictionCount` populate from the wider set (§1.3 — every memo recalled, contradictor counts towards ranking) while the conflict-surfacing decision uses the narrower agent-visible set (only memos the agent reads can be "the hit side" of a surfaced pair).

**Self-pair dedup.** If two of the agent's top-K hits *are themselves* contradicting (e.g., two memos in the agent's view contradict each other), the statement 1 query returns each pair once (composite PK). After hydration, we have one `{hitSide, otherSide}` row where both sides are *also* in the recall block. Treat exactly like any other pair: both will get the conflict-block line; ranking-wise both already paid `contraPenalty` independently. The agent sees the same fact emitted twice in different surfaces (relevant memory + conflicts) — that's the intent. Suppression rule 6 (§5) handles the runaway case where many pairwise edges fan out from the same dense cluster.

### 1.3 Wiring the dormant `contraPenalty`

Independently of the surfacing path, B2 fixes the never-populated `contradictionCount` input to the first `score()` call in `inject.js` (the one that constructs `merged` from `[...eventHits, ...memoHits]`). The fetch and the wiring are gated together by the flag — when off, the existing behavior (zero contradictionCount) is preserved bit-for-bit:

```js
const cfg = await getRecallConfig(db);

// Hydrate contradictors only when the feature is on. fetchContradictors is
// itself fail-soft, but we also skip it entirely when the flag is off to
// avoid paying the roundtrip for a feature that won't be used.
let conflicts = { pairs: [], pairs_precap: 0 };
if (cfg.conflict_surfacing_enabled === true && memoIds.length > 0) {
  conflicts = await fetchContradictors(db, memoIds, cfg);
}

// Build per-hit contradictor counts (empty when flag off).
const contraByHit = new Map();
for (const p of conflicts.pairs) {
  const k = String(p.side);
  contraByHit.set(k, (contraByHit.get(k) ?? 0) + 1);
}

// merged is built immediately below — pass the count in:
const merged = [...eventHits, ...memoHits].map((h) => ({
  ...h,
  _scored: score(
    { record: h.record, distance: h.distance,
      contradictionCount: contraByHit.get(String(h.record.id)) ?? 0 },
    { session_id: undefined },
  ),
}));
```

The flag gates *both* the fetch and the wiring atomically. Toggling the flag off restores today's behavior exactly: `contraByHit` empty → `contradictionCount === 0` → `contraPenalty === 1.0`.

This means ordering in §1.1 changes: the hydration step (§1.2) must run **before** the rank.score call, not after MMR-lite. Two consequences:

1. `memoIds` is built from `memoHits` (raw recall) rather than from greedy-packed `hits`. That's slightly wider — at most `k` memo hits instead of however many survived MMR — but the cardinality is unchanged in the worst case (`k=6`). The wider set is fine; the conflict block still filters by what survived MMR before emission.
2. The conflicts JSON returned by `fetchContradictors` is reused twice: once to populate `contradictionCount` for ranking; once to build the conflict block (§2). One DB roundtrip, two consumers.

This re-ordering is the only structural change to `inject.js`. It is fail-soft: if `fetchContradictors` throws (or the flag is off), `contraByHit` is an empty `Map` and `contradictionCount` defaults to `0` per existing `rank.js:40` — identical to today's behavior.

### 1.4 Cost

Per recall, conditional on `memoIds.length > 0`:

- +1 multi-statement SurrealDB roundtrip (LET + projection).
- Index usage: the `edges` table has the composite PK `[kind, in, out]` (per `0001-init.surql`). `WHERE kind = 'contradicts' AND in IN $hits` is a range scan on the PK prefix `('contradicts', in_value)` — strictly index-backed. Same for `out IN $hits`. The hydration `SELECT FROM memos WHERE id IN $ids` is a PK lookup. No `events_*` / `memos_*` index touched.
- Worst-case row count: `cfg.conflict_max_pairs_hydrated` (default 24) edge rows + ≤ `2 × 24 = 48` distinct memo rows for hydration. The cap is applied JS-side by truncating the deduped `pairs` array to the limit before the suppression/builder passes; under adversarial fan-out (e.g., a single memo with 100 contradictors) we never spend cycles or tokens beyond the cap.
- JS-side filter cost: `O(pairs × suppression_rules)` — single-digit microseconds.

**Where the cap is enforced.** The DB-side query in §1.2 has no `LIMIT` — bounding row count entirely in SurrealQL would complicate the symmetric-edge cover (each side needs its own scan). Instead, `fetchContradictors` truncates `deduped` to `cfg.conflict_max_pairs_hydrated` after the JS dedup step. It returns both `pairs_precap` (length pre-truncation) and `pairs` (length ≤ cap); the call site emits `conflicts_hydrated_precap`, `conflicts_hydrated_postcap`, and `conflicts_hydration_capped` from these (§6.1) so dashboards see both the un-capped fan-out shape and the active cap.

No new LLM tokens. No new embedding calls.

## Section 2 — Surface format

### 2.1 The `<!-- conflicts -->` block

Format (one line per surfaced pair, in deterministic order):

```
<!-- conflicts -->
[memo 2026-04-30] X is true <-> [memo 2026-04-22] Y is true (conf 0.60 <-> 0.55)
[memo 2026-05-02] Z is the case <-> [memo 2026-04-12] not-Z (conf 0.70 <-> 0.40)
<!-- /conflicts -->
```

Line shape: `[memo YYYY-MM-DD] <hit-content> <-> [memo YYYY-MM-DD] <other-content> (conf X.XX <-> Y.YY)`

Components:

- Date prefix uses the same `YYYY-MM-DD` shape as `formatHit`; the tag is `memo` (new — contradicts apply only to memos, so there's no `event` variant here).
- Content is `trimLine(content, LINE_CONTENT_CHARS)` per the existing helper — applied to *both* sides. So a long content on either side gets the same single-line collapse.
- The separator is the ASCII string ` <-> ` (space + less-than + dash + greater-than + space). ASCII-only for two reasons: (a) the tokenizer cost of multi-byte UTF-8 separators varies across hosts (Claude/Gemini handle `<->` but tokenisation is implementation-defined); (b) we already restrict content to single-line trimmed strings, and an ASCII separator is grep-friendly for telemetry parsers. Implementation: one constant `CONFLICT_SEPARATOR = ' <-> '` in `conflicts.js`. Tests assert exact byte match.
- Confidence values: `confidence.toFixed(2)` for both sides. Always emitted; we don't try to hide low confidence (rule §5 already filters; if we surface, the agent should see why).

Markers `<!-- conflicts -->` / `<!-- /conflicts -->` mirror the existing markers' style. Frame token budget computed exactly like the existing `FRAME_TOKENS` constant in `inject.js` for the relevant-memory block.

### 2.2 Worked example

Substrate state (illustrative):

- `memos:abc` — `kind='knowledge'`, `content="Switched primary bank to Mercury 2026-04-12"`, `confidence=0.85`, `ts=2026-04-12`.
- `memos:def` — `kind='knowledge'`, `content="Primary bank is Chase as of 2026-05-02"`, `confidence=0.75`, `ts=2026-05-02`.
- `edges:[contradicts, memos:abc, memos:def]` (canonical order: abc < def).
- User query: "what bank am I using right now"

Recall returns both memos in top-K (vector + BM25 lanes both promote them). MMR-lite keeps both (overlap below threshold because content differs). Hydration finds one pair. Both confidences ≥ 0.4 default. Neither is superseded. Both `scope='global'`. Within 30 days.

Output block:

```
<!-- conflicts -->
[memo 2026-05-02] Primary bank is Chase as of 2026-05-02 <-> [memo 2026-04-12] Switched primary bank to Mercury 2026-04-12 (conf 0.75 <-> 0.85)
<!-- /conflicts -->
<!-- relevant memory -->
[memo 2026-05-02] Primary bank is Chase as of 2026-05-02
[memo 2026-04-12] Switched primary bank to Mercury 2026-04-12
...
<!-- /relevant memory -->
```

Both sides appear in `<!-- relevant memory -->` because both ranked into top-K (their per-pair `contraPenalty = 1 - 0.3 × 1 = 0.7` shaves rank but doesn't push them out). The conflicts block flags the dispute explicitly. Without B2, today's prompt would show only the relevant-memory block — the agent would pattern-match to the latest date and assert "Chase" with no awareness it's disputed.

### 2.3 Ordering of surfaced pairs

Deterministic, by:

1. Higher of `(hitSide.confidence, otherSide.confidence)` descending — surface high-confidence disputes first.
2. Tie-broken by `max(hitSide.ts, otherSide.ts)` descending — newer dispute first.
3. Tie-broken by canonical pair id (string comparison of `[contradicts, in, out]`) — fully deterministic.

This ordering is computed in `buildConflictBlock` after suppression (so the cap applies to surface-worthy pairs only).

### 2.4 Determining the hit-side

Two cases (note: self-loops on `contradicts` are rejected at write time per `edge-registry.js:83-88`, so the two endpoints of a pair are always distinct memos; the "self-pair" terminology below refers to *both endpoints being in the agent's in-view set*, not to a literal self-loop):

- **Both endpoints in view** (both in greedy-packed `hits`): pick the side with higher `confidence` as the "hit side" (left of `<->`); ties broken by newer `ts`; further ties by canonical id sort. Keeps the leading slot on the side the agent is most likely to anchor on.
- **One endpoint in view, one not** (the common case): the in-view memo is always the left/hit side. The out-of-view memo (which we pulled in specifically because of this contradiction) sits on the right.

The block-builder gate (filter from §1.1) requires `hitSide ∈ greedy-packed hits`, *not* both sides. That asymmetry is what enables the "pull the out-of-view contradictor in" semantic — if we required both sides to be in view, the pair would be suppressed in the (common) case where only one side ranked.

## Section 3 — Block ordering and budget envelope

### 3.1 Block ordering

Prompt order, top to bottom (when all three blocks have content):

1. `<!-- current focus -->` (D1) — at most 200 tokens.
2. `<!-- conflicts -->` (B2, new) — at most 300 tokens.
3. `<!-- relevant memory -->` (existing) — at most 1500 tokens (unchanged; see §3.2).

Ordering rationale: focus tells the agent *what the user is doing*; conflicts tell the agent *what about that domain is disputed*; relevant memory provides the broader context. Reading top-to-bottom, the agent forms a picture of "current task → known disputes → general background" — the natural cognitive frame for adjudicating a question.

Each block is independently optional (suppressed → omitted entirely, including its markers). The handler concatenates whichever subset is non-empty in the order above.

### 3.2 Budget envelope (additive, not reallocated)

B2 layers a separate `<!-- conflicts -->` block (cap 300 tok) above relevant-memory, below D1's `<!-- current focus -->` (cap 200 tok). Relevant-memory budget stays at 1500. Total ceiling: 2000 tok when all three flags on.

This is a cross-cutting decision shared with D1: the prompt-budget ceiling after D1+B2 both ship is **1500 baseline + 200 (D1 focus block) + 300 (B2 conflict block) = up to 2000 tokens** — and only on turns where both blocks have content to surface. On a typical turn (no current focus inferred, no contradictions in top-K), both new blocks are empty, both markers are omitted, and the prompt is byte-identical to today's 1500-token relevant-memory output.

Why additive instead of reallocated:

- The +300 conflicts block is conditional. On turns with no contradictions in the top-K's neighborhood (the common case), it's empty and costs 0 tokens. Shrinking relevant-memory unconditionally to fund a block that's empty most of the time would degrade relevant-memory quality on every turn to save tokens on a minority of turns.
- The relevant-memory block today is rarely token-bound (typical recall surfaces 6 hits × ~120 chars = ~180 tokens of content + frame). The 1500-token cap is loose — but it's also the agent's *safety margin* for unusually rich recalls. Preserving it leaves headroom for the long tail.
- D1 and B2 are designed as *capped additions*, not redistributions. Stacking the caps (200 + 300) bounds worst-case growth at +500 tok/turn; the typical growth is closer to +0 tok/turn because both blocks are conditional.

Concretely, the daemon's `/internal/intuition` handler reads both budgets from `runtime:recall`:

```js
const cfg = await getRecallConfig(db);
const surfacingOn = cfg.conflict_surfacing_enabled === true;
const tokenBudget         = cfg.relevant_memory_token_budget ?? 1500;          // unchanged from today
const conflictTokenBudget = surfacingOn ? (cfg.conflict_block_token_budget ?? 300) : 0;
intuitionEndpoint({ db, embedder, query, priorAssistant, k, recencyDays, tokenBudget, conflictTokenBudget });
```

- `intuitionEndpoint` gains a `conflictTokenBudget` arg (default `0` — when called without an explicit arg, behavior matches today's prompt; pre-B2 callers don't know about the new arg).
- `tokenBudget`'s function-default stays at 1500 (the existing `intuitionEndpoint` signature in `inject.js`). Relevant-memory keeps its full 1500-tok budget regardless of the conflict-surfacing flag — the flag only flips the conflicts block on/off, not the relevant-memory budget.
- The flag is the *single* gate for the conflicts block. Toggling it flips `conflictTokenBudget` between 0 and 300; relevant-memory's budget is untouched.
- The `?? 1500` / `?? 300` fallbacks guard against a migration that seeded only some keys; defensive against partial config rows in dev.

The 300-token conflicts cap is enforced by the same greedy-pack idiom as today's block. A pair line is at most `2 × LINE_CONTENT_CHARS + ~40 chars of frame = ~280 chars ≈ 70 tokens`. Three pairs (the default `conflict_max_pairs_surfaced`) fits comfortably under 300 with frame. If a pair doesn't fit, drop it (and increment `conflicts_block_truncated` telemetry) rather than truncating a line.

## Section 4 — Score interaction

We pursue option (c) from the design brief: **keep the penalty, pull the contradicting memo into the conflicts block separately.** Rationale per the anchoring-decisions section above. Concretely:

| Behavior | Today | B2 |
|---|---|---|
| `contraPenalty` math | `max(0.1, 1 - 0.3 × contradictionCount)` | unchanged |
| `contradictionCount` populated at intuition path | Never (always 0) | Computed from §1.2 pairs |
| Effect on recall ranking | None (penalty math runs but input is always 0) | A memo with N contradictors gets penalty `max(0.1, 1 - 0.3 N)` — finally active |
| Contradicting memo presence in `<!-- relevant memory -->` | Whatever the rank pipeline decides | Unchanged — same rank pipeline |
| Contradicting memo presence in `<!-- conflicts -->` | n/a | Always (for surface-worthy pairs, after suppression + cap) |

So a memo can appear in the conflicts block without appearing in the relevant-memory block — that's the explicit pull semantic. The conflicts block has its own budget and its own contract; it does not double-count against relevant-memory's slots.

**One implication of wiring `contradictionCount`:** ranking outcomes will shift for any recall that hits a memo with live contradictors. This is a *behavior change*, not just a surfacing addition. We accept it because today's ranking is silently broken (the penalty was supposed to be live, per the design and the source comment at `rank.js:7-8`). Telemetry: log the `contraPenalty` value per hit in `recall_log.ranked_hits[].score_components.contraPenalty` — already emitted by `score()`; nothing to add.

**Cross-design note (B1):** B1 (`2026-05-11-cognition-b1-per-hit-reinforcement-design.md`) introduces `recall_log.ranked_hits[*].used`, `used_via`, `used_score`, plus top-level `attribution` and `reply_event_id`. B2 does not touch any of those — it only reads/writes the existing `score_components`. The two specs are orthogonal on `ranked_hits[*]`.

## Section 5 — Suppression rules

A pair `{hitSide, otherSide}` is suppressed (not emitted to the conflicts block) when **any** of the following holds:

1. **Low confidence.** Either side's `confidence < cfg.min_confidence` (default `0.4`). A faded claim isn't worth highlighting; if the agent never confidently believed it, there's no contradiction to adjudicate.
2. **Superseded.** Either side has `freshness == 0`. `fn::freshness` returns 0 for any memo with an inbound `supersedes` edge (`0001-init.surql`'s function definition, also mirrored at `decay.js:34-36`). A superseded claim has already been resolved; the conflict is dormant. We use `fn::freshness` rather than a direct `<-supersedes` count because freshness already accounts for the half-life decay plus the supersedes check; one server-side function call per row gives us both signals.
3. **Both outbound-blocked.** `isOutboundBlocked(hitSide.scope) && isOutboundBlocked(otherSide.scope)` — using the `isOutboundBlocked` predicate exported from `system/cognition/memory/scope-registry.js` (line 53) rather than a literal `'private'` string. The agent prompt is an outbound surface (per the scope-registry policy that drives `checkOutboundScope`); but if at least one side is outbound-eligible, *that* side is fair game in the surface. Concretely: if hit is outbound-blocked and other is outbound-eligible, we surface the pair *with the blocked side redacted* (line shape: `[memo 2026-05-02] <private memo redacted> <-> [memo 2026-04-12] not-Z (conf 0.70 <-> 0.40)`). If both blocked, the entire pair drops. This mirrors the half-redacted pattern used by `explain_recall`. Routing the check through `isOutboundBlocked` keeps B2 forward-compatible with any future scope additions that the registry classifies as outbound-blocked (the conflicts surface inherits the registry's policy automatically). (See §5.1 for the redaction shape.)
4. **Stale contradiction.** `now - max(hitSide.ts, otherSide.ts) > cfg.max_age_days` (default `30`). A 6-month-old dispute that nothing has touched is noise; either the user moved on or biographer/dream resolved it (via `supersedes`) and we just haven't promoted it yet. Stale conflicts are an introspection target (`explain_belief`), not an in-turn surfacing target.
5. **Per-turn cap reached.** `surfaced_count >= cfg.conflict_max_pairs_surfaced` (default `3`). Applied in the deterministic ordering from §2.3 — best 3 pairs win, rest drop with `conflicts_suppressed_capped += 1`.

### 5.1 Outbound-blocked-side redaction

When exactly one side of an otherwise-surfaceable pair is outbound-blocked per `isOutboundBlocked(side.scope)` (from `system/cognition/memory/scope-registry.js`), and rule 3 did not fire because the other side is outbound-eligible:

```
[memo 2026-05-02] <private memo redacted> <-> [memo 2026-04-12] not-Z (conf 0.70 <-> 0.40)
```

- The date stamp is preserved (it's not confidential by itself and the agent needs *some* anchor to ask about).
- The blocked side's content is replaced by `<private memo redacted>` (constant string — the user-facing label uses "private" since that's the most common blocked scope today; the *check* uses the policy predicate, not the string).
- Confidence on the blocked side is preserved (a single float; no leak; the agent learning "a private memo contradicts at 0.70" is acceptable — that's not the protected payload).
- The outbound-eligible side is rendered normally.

The both-blocked case never reaches this redaction path; rule 3 short-circuits to drop the pair entirely. The both-eligible case skips redaction; both sides render normally.

Telemetry: `conflicts_redacted_one_side += 1` for partial-redaction pairs (§6).

### 5.2 Rule precedence

Rules are checked in the order listed above. The first matching rule short-circuits to its telemetry counter and the pair drops. This matters for rule 3 vs rule 1: a low-confidence private memo gets attributed to rule 1, not rule 3 — which is the correct precedence (low-confidence is the more informative signal). The deterministic counter assignment makes the dashboard interpretable.

### 5.3 Defaults rationale

| Knob | Default | Why |
|---|---|---|
| `min_confidence` | 0.4 | Below 0.4 a memo is below `kind='knowledge'`'s typical write floor (biographer writes at 0.5-0.7; dream at 0.6-0.8). 0.4 leaves headroom for ledger-decayed memos that have been refuted but not yet superseded. |
| `max_age_days` | 30 | Matches the existing intuition `recencyDays` default in the `intuitionEndpoint` signature. If we wouldn't pull the memo into the relevant-memory block by recency, we shouldn't surface its contradiction either. |
| `conflict_max_pairs_surfaced` | 3 | A turn with 3 surfaced disputes uses ~210 tokens of content (3 × 70 token lines), well under the 300-token block budget. Beyond 3, the agent is unlikely to adjudicate them all in a single turn; the cap prevents stacking. |
| `conflict_max_pairs_hydrated` | 24 | Hard ceiling on the JS-side filter input. Caps the post-DB blast radius from a pathological fan-out (e.g., 6 hits × 4 contradictors each). |

All exposed in `runtime:recall` (§7).

## Section 6 — Telemetry

### 6.1 Metrics emitted per recall

The intuition path already writes `intuition_telemetry` (the `CREATE intuition_telemetry CONTENT` block near the end of `inject.js`) and `recall_log` (the `CREATE recall_log CONTENT` block immediately after it). Extend `intuition_telemetry` with the following B2 fields:

- `conflicts_surfaced: int` — number of pairs in the emitted `<!-- conflicts -->` block (0 when block omitted).
- `conflicts_block_tokens: int` — tokens in the conflicts block (0 when omitted; same idiom as the existing `tokens` field for relevant-memory).
- `conflicts_hydrated_precap: int` — total *deduped* pairs returned by `fetchContradictors` **before** the `conflict_max_pairs_hydrated` truncation. May exceed the cap; that's the signal we want for "is the cap too tight?"
- `conflicts_hydrated_postcap: int` — pairs after the hydration cap and before any suppression rule fires. Equals `min(conflicts_hydrated_precap, conflict_max_pairs_hydrated)`.
- `conflicts_hydration_capped: bool` — `true` iff `conflicts_hydrated_precap > conflict_max_pairs_hydrated` (i.e., truncation occurred).
- `conflicts_suppressed_by_rule: object` — counts per rule: `{ low_confidence: int, superseded: int, both_private: int, stale: int, capped: int }`. The `both_private` counter name is retained for telemetry continuity even though the §5 rule 3 check now uses the `isOutboundBlocked` predicate (the predicate today returns true only for the `private` scope, so the dashboard label and the check agree in practice). (The `redacted_one_side` case is a co-emit, not a suppression — split out separately below.)
- `conflicts_redacted_one_side: int` — count of pairs that were surfaced *with* one-side redaction (rule 3's partial-redaction branch from §5.1). Distinct from a suppression because the pair *is* emitted; the count helps separate "we showed it (redacted)" from "we dropped it."
- `conflicts_block_truncated: bool` — `true` if a pair survived suppression but didn't fit the 300-token block budget and was dropped during greedy-pack. Same semantic as the existing `truncated` field for the relevant-memory block.

These are emitted as additional fields on the existing single `CREATE intuition_telemetry CONTENT` block in `inject.js`. **Important:** `intuition_telemetry` is `SCHEMAFULL TYPE NORMAL` per `0001-init.surql:279` — SurrealDB rejects undefined fields in schemafull mode. The B2 migration (§9.1) must therefore `DEFINE FIELD` each new key explicitly:

```surql
DEFINE FIELD conflicts_surfaced            ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_block_tokens        ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_hydrated_precap     ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_hydrated_postcap    ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_hydration_capped    ON intuition_telemetry TYPE option<bool>;
DEFINE FIELD conflicts_suppressed_by_rule  ON intuition_telemetry TYPE option<object> FLEXIBLE;
DEFINE FIELD conflicts_redacted_one_side   ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_block_truncated     ON intuition_telemetry TYPE option<bool>;
```

All `option<...>` so flag-off rows (which never write these keys) remain valid against the schema — the field is simply absent, which matches `option<T>`'s null/missing semantics. `conflicts_suppressed_by_rule` uses `option<object> FLEXIBLE` so the rule-name keys (`low_confidence`, `superseded`, etc.) live inside a sub-object without needing one DEFINE FIELD each.

`recall_log.meta` is already `option<object> FLEXIBLE` (per `0001-init.surql:302`), so adding `conflicts_surfaced` inside it requires no schema change — only the data write does.

**Cross-spec precondition on `intuition_telemetry.meta`.** A3 owns adding `DEFINE FIELD meta ON intuition_telemetry TYPE option<object> FLEXIBLE` (A3 needs the FLEXIBLE `meta` container on the same table for its own stratification keys). B2 piggybacks on it for `meta.conflicts_surfaced`. If A3 has not landed that DEFINE before B2's migration runs, B2's migration must include it as a precondition — add the same `DEFINE FIELD meta ON intuition_telemetry TYPE option<object> FLEXIBLE` statement to `0015-conflict-surfacing.surql`. SurrealDB's `DEFINE FIELD … IF NOT EXISTS` semantic makes the duplication safe in either order.

### 6.2 Per-row stratification

`recall_log.meta` gains one field:

- `conflicts_surfaced: int` — same value as the `intuition_telemetry` field, mirrored onto the per-row recall log for A3's eval-harness stratification. A3 reads `recall_log` rows and computes recall-quality metrics; this field lets it stratify "queries that surfaced N disputes" against "queries with no disputes" without joining against `intuition_telemetry`.

Field name matches the metric name in §6.1 exactly. Read-only consumer is A3's `system/tests/eval/` harness (`docs/superpowers/specs/2026-05-11-cognition-a3-recall-eval-and-mmr-design.md` §2-3). No field-name collision: A3 today defines `recall_log.meta.from` and `recall_log.meta.latency_ms` (per A3 §2 line 199, 229) — `conflicts_surfaced` is new.

### 6.3 Storage layout

**Defers to C3 telemetry-umbrella spec.** B2 emits the metrics into `intuition_telemetry` (existing table, FLEXIBLE meta) and `recall_log.meta` (existing field, FLEXIBLE) — *requirement-level*, not schema-level. The C3 spec is the place where the long-term telemetry surface (rollups, retention, query patterns) is unified. B2 names the metrics and the emission sites; C3 owns the table layout. If C3 lands a new dedicated `conflicts_telemetry` table, the field names in §6.1 transfer verbatim.

## Section 7 — Configuration

New runtime singleton row `runtime:recall` is *extended* (not replaced — it already exists for `rrf_k` / `knn_overfetch_*` / `mmr_threshold` per `store.js:464-487`). Migration §9.1 adds the new keys to the existing seed.

```json
{
  // existing fields — unchanged
  "rrf_k": 60,
  "knn_overfetch_base": 1.5,
  "knn_overfetch_per_filter": 1.5,
  "mmr_threshold": 0.92,
  // new B2 fields
  "conflict_surfacing_enabled": false,
  "conflict_min_confidence": 0.4,
  "conflict_max_age_days": 30,
  "conflict_max_pairs_surfaced": 3,
  "conflict_max_pairs_hydrated": 24,
  "conflict_block_token_budget": 300,
  "relevant_memory_token_budget": 1500
}
```

`relevant_memory_token_budget` is seeded at 1500 (unchanged from today's hard-coded default in the `intuitionEndpoint` signature in `inject.js`). It is exposed as a config row so future tuning doesn't require a code change, *not* because B2 changes its value. `conflict_block_token_budget` is the new 300-token cap for the additive conflicts block (§3.2): when `conflict_surfacing_enabled === true`, the daemon's `/internal/intuition` handler reads it and passes it to `intuitionEndpoint`; when `false`, it falls back to `0` so the conflicts block is suppressed entirely.

Reads cached for 5s, same idiom as `getRecallConfig` in `store.js:471-487`. The existing cache is reused — we read the same row; the new fields just join the same `_recallConfigCache` object via the `{ ...HYBRID_DEFAULTS, ...value }` spread (so a missing key falls back to a default added to the local `HYBRID_DEFAULTS` constant).

**Exposing the read.** `getRecallConfig` is module-private in `store.js`. B2 promotes it to an exported helper (`export async function getRecallConfig(db)`) so `inject.js` can read the same cached config. Alternative considered: a new dedicated `runtime:recall.b2` row — rejected because there's already exactly one runtime config row for recall, and splitting on theme would fragment the read pattern. The export is a minor surface widening, not a behavior change for any existing caller.

### 7.1 Hot-flip semantics

`UPDATE runtime:recall SET value.conflict_surfacing_enabled = true;` — instant. The next recall (after the 5-s TTL expires; bounded) starts surfacing. The 5-s TTL is acceptable for a rollout flag; if we want true instant we'd need to invalidate the cache, but no observed need.

Reverse direction symmetric: `value.conflict_surfacing_enabled = false` → next-tick the block stops being emitted.

## Section 8 — Test plan

### 8.1 Unit tests — suppression rules

`system/tests/unit/conflicts-suppression.test.js` (new). Each rule, in isolation, on a synthetic pair input — no DB.

1. **Low confidence (rule 1)** — pair with `hitSide.confidence=0.3` is suppressed; `conflicts_suppressed_by_rule.low_confidence === 1`. Pair with `hitSide=0.5, otherSide=0.35` also suppressed (rule fires when **either** side fails).
2. **Superseded (rule 2)** — pair with `hitSide.freshness === 0` suppressed; `conflicts_suppressed_by_rule.superseded === 1`. Same for `otherSide.freshness === 0`.
3. **Both private (rule 3)** — both sides `scope='private'` → entire pair drops; `both_private === 1`. One side private → pair surfaces with the private side redacted to `<private memo redacted>`; `redacted_one_side === 1`. Both global → no redaction.
4. **Stale (rule 4)** — pair where `max(hitSide.ts, otherSide.ts)` is 31 days ago and `max_age_days=30`: dropped, `stale === 1`. 29-day-old pair surfaces.
5. **Per-turn cap (rule 5)** — feed 5 surfaceable pairs with `conflict_max_pairs_surfaced=3`: 3 surface, 2 drop with `capped === 2`. Ordering matches §2.3.
6. **Rule precedence (§5.2)** — low-confidence + private pair → attributed to `low_confidence`, not `both_private`. Stale + capped pair (pair survives the stale check but is the 4th by ordering) → attributed to `capped`, not `stale`.

### 8.2 Unit tests — block builder

`system/tests/unit/conflicts-block.test.js` (new).

7. **Empty pairs → empty block.** `buildConflictBlock([], …)` returns `''`. Asserts the function doesn't emit markers for an empty input — saves a token-budget leak on no-conflict turns.
8. **Single pair → well-formed block.** One pair with both confidences and content → output matches the §2.1 line shape exactly (asserts the `<->` glyph, the date format, the `conf X.XX <-> Y.YY` suffix).
9. **Ordering deterministic.** Three pairs with distinct confidence/ts → output order matches §2.3 (asserts a fixed substring sequence).
10. **Budget overflow → drop tail.** `conflict_block_token_budget=80` with three 70-token pairs → output contains 1 pair, `conflicts_block_truncated === true` is reported.
11. **Self-pair hit-side selection.** Both sides in `hits` → higher-confidence side appears left.

The dedup + cap logic that lives inside `fetchContradictors` (the post-query JS pass from §1.2) is testable as a pure helper if we extract it to a named export — e.g., `dedupeAndCapPairs(rawRows, cap)`. Recommend extracting; the resulting two tests:

11a. **Self-pair dedup.** Input: `[{pair:{side:'memos:A', other:'memos:B'}}, {pair:{side:'memos:B', other:'memos:A'}}]` (the same canonical edge from both `$contras_in` and `$contras_out`). Output: one pair only. Asserts the JS dedup logic in §1.2's last paragraph collapses the duplicate.
11b. **Hydration cap.** Input: 7 distinct pre-deduped pairs, `cap=3`. Output: `{pairs: <3 entries>, pairs_precap: 7}`. Telemetry consumer reading these values would emit `conflicts_hydration_capped === true`.

### 8.3 Integration tests — full pipeline

Extend `system/tests/integration/intuition.test.js` (or create `intuition-conflicts.test.js` if cleaner — the existing intuition tests are tight).

12. **Recall surfaces conflict pair.** Seed two contradicting memos M and N (with a `contradicts` edge). Issue a query whose vector recall pulls both into top-K. With `conflict_surfacing_enabled=true`, assert: response contains both `<!-- conflicts -->` and `<!-- relevant memory -->`; the conflicts block has exactly one pair line matching §2.1's shape; `intuition_telemetry.conflicts_surfaced === 1`; `recall_log.meta.conflicts_surfaced === 1`; `recall_log.ranked_hits[].score_components.contraPenalty` is `< 1.0` for both M and N **on the persisted recall_log row** (verifies that the recall_log rebuild call — or the `merged[i]._scored.components` reuse — also sees the wired `contradictionCount`, not just the live ranking call).
13. **No contradictions → block omitted.** Same setup minus the `contradicts` edge. Assert no `<!-- conflicts -->` markers in the response; `intuition_telemetry.conflicts_surfaced === 0`; `recall_log.meta.conflicts_surfaced === 0`. Output is byte-identical to today's (gates the no-regression invariant).
14. **Suppression by low confidence.** Pair where M.confidence=0.3 — assert block omitted but `conflicts_suppressed_by_rule.low_confidence === 1` recorded in `intuition_telemetry`.
15. **Contradictor not in top-K but pulled in.** Seed M in top-K, seed N (M's contradictor) deliberately *below* top-K by giving it a high distance / older ts. Assert N's content appears in `<!-- conflicts -->` line; assert N is **not** in `<!-- relevant memory -->`.
16. **Private redaction one side.** Pair where M is `scope='global'`, N is `scope='private'`. Assert conflicts block contains the pair with N redacted to `<private memo redacted>`; `redacted_one_side === 1`.
17. **Flag off → byte-identical behavior.** `conflict_surfacing_enabled=false` with the same contradiction-present substrate as test 12: assert response equals what today's code (pre-B2) would emit. Gate: no `<!-- conflicts -->` markers; no `meta.conflicts_surfaced` field on `recall_log`; no B2 telemetry fields on `intuition_telemetry`; `recall_log.ranked_hits[].score_components.contraPenalty === 1.0` for both M and N (verifies the `contradictionCount` wiring is also gated by the flag — when off, `fetchContradictors` is not invoked, so `contraByHit` is empty and the penalty defaults to no-op).
18. **`recall_log.meta.conflicts_surfaced` populated** for both flag states: present and `0` when flag on + no conflicts; absent when flag off (we never write the field when the feature is dormant — keeps `recall_log` rows clean for A3's stratification).

### 8.4 Regression tests

19. **Existing `<!-- relevant memory -->` shape unchanged when no conflicts.** Re-run the existing `intuition.test.js` golden cases with the flag enabled but no contradicting memos in the substrate. Assert that the relevant-memory block output bytes match the pre-B2 baseline. (`tokenBudget` stays at 1500 in both pre- and post-B2 worlds — B2 is additive per §3.2, not redistributive — so output is unchanged for any recall.)
20. **Existing `intuition_telemetry` row shape unchanged for non-conflict turns.** Assert no surplus B2 fields when flag off. With flag on but no conflicts, fields are present and zero — not absent — so dashboards see a consistent schema.
21. **Existing `recall_log.outcome` and `ranked_hits[].score_components` shape unchanged.** Assert B2 doesn't accidentally drop or rename any pre-existing field. (`contraPenalty` value will change from `1.0` baseline to `<1.0` for hits with contradictors — that's the intentional wiring, not a shape change.)

## Section 9 — Rollout

### 9.1 Migration

Slot: `system/data/db/migrations/0015-conflict-surfacing.surql`. Optional B2 follow-up (default-on flip, §9.2 step 6): `0016-conflict-surfacing-default-on.surql`.

Cross-cutting migration numbering (shared across the alpha.16+ specs, applied consistently):

- `0009` — B1 per-hit-reinforcement.
- `0010` — A3 recall-eval-and-mmr (per A3 §11).
- `0010-reinforcement-mode-default-hybrid` — B1 follow-up (optional, §9.2 step 5 of B1).
- `0011` — open at design time.
- `0012`, `0013`, `0014` — D1 state-inference (initial-off, shadow-flip, default-on).
- **`0015` — B2 conflict-surfacing (this spec).**
- **`0016` — B2 follow-up (optional default-on flip).**
- `0017` — C3.
- `0018` — D2.
- `0019` — D3.
- `0020` — C2 (moved from `0016` after B2 + B2 follow-up claimed `0015`/`0016`).

B2 takes `0015` deliberately: B2 surfaces *both sides of a contradiction*, which implies the contradicting memo may itself be a `state_inference` memo once D1 lands (D1 §4.6 keeps state_inference out of vector recall, but the agent can still `note` contradictions through MCP). Landing B2 after D1 ensures the suppression rule for outbound-blocked state_inferences (D1 §6.1 propagates private upward) is testable with realistic data. The `0015` slot leaves `0011` open for any other interleaved spec.

Migration contents:

```surql
-- Extend the existing runtime:recall config row (created by 0001-init.surql:222).
-- The original seed uses `UPSERT ... CONTENT {value: {...}}` which REPLACES
-- value wholesale. We must instead use field-level SET (additive) so the
-- existing recall keys (rrf_k, knn_overfetch_base, knn_overfetch_per_filter,
-- mmr_threshold) are preserved. The runtime.value field is `object FLEXIBLE`
-- (0001-init.surql:217) so dotted-path SET is supported.
--
-- UPSERT (not UPDATE) is defensive — if 0001-init somehow didn't run before
-- this migration (rare; the runner enforces order — see migrate.js:36 — but
-- restoring partial dumps in dev is a real path), UPSERT creates the row
-- with these keys and an empty rest of the recall config. Subsequent reads
-- via getRecallConfig will fall back to HYBRID_DEFAULTS for the missing
-- legacy keys (store.js:481).
UPSERT runtime:recall SET
  value.conflict_surfacing_enabled     = false,
  value.conflict_min_confidence        = 0.4,
  value.conflict_max_age_days          = 30,
  value.conflict_max_pairs_surfaced    = 3,
  value.conflict_max_pairs_hydrated    = 24,
  value.conflict_block_token_budget    = 300,
  value.relevant_memory_token_budget   = 1500;

-- intuition_telemetry is SCHEMAFULL TYPE NORMAL (0001-init.surql:279) so each
-- new field needs an explicit DEFINE FIELD. All `option<...>` so flag-off rows
-- (which omit these keys) remain schema-valid.
--
-- Precondition: A3 owns adding `DEFINE FIELD meta ON intuition_telemetry`. If
-- A3 has not landed first, B2 must include this DEFINE so its own
-- `meta.conflicts_surfaced` writes (and A3's future meta keys) land on a
-- valid schema. `IF NOT EXISTS` makes the duplication safe in either order.
DEFINE FIELD IF NOT EXISTS meta ON intuition_telemetry TYPE option<object> FLEXIBLE;
DEFINE FIELD conflicts_surfaced            ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_block_tokens        ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_hydrated_precap     ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_hydrated_postcap    ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_hydration_capped    ON intuition_telemetry TYPE option<bool>;
DEFINE FIELD conflicts_suppressed_by_rule  ON intuition_telemetry TYPE option<object> FLEXIBLE;
DEFINE FIELD conflicts_redacted_one_side   ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_block_truncated     ON intuition_telemetry TYPE option<bool>;

-- recall_log.meta is already option<object> FLEXIBLE (0001-init.surql:302).
-- No DDL needed for meta.conflicts_surfaced — the FLEXIBLE container accepts
-- it. Documented here for discoverability.
```

No DDL changes to `recall_log`, `memos`, or `edges`. `0015` is an additive schema + config-seed migration; existing rows remain valid (every new field is `option<>` so absence is OK).

### 9.2 Rollout sequence

1. Land migration `0015-conflict-surfacing.surql` with `conflict_surfacing_enabled=false`. Production behavior is byte-identical to today (verified by regression test 17 + 19).
2. Land the code: `conflicts.js` module + `inject.js` wiring + the `contradictionCount` plumbing into `rank.score`. With the flag still off at `runtime:recall`, the `contraPenalty` plumbing is also dormant (we gate the contradictor-fetch query on the flag — when off, `contraByHit` is empty and `contradictionCount` defaults to 0, matching today).
3. Land tests (§8). All pass with flag off.
4. **On Kevin's instance**, flip the flag: `UPDATE runtime:recall SET value.conflict_surfacing_enabled = true;`. Wait 5 seconds (cache TTL); next recall surfaces the block. Watch `intuition_telemetry.conflicts_surfaced` and `intuition_telemetry.conflicts_suppressed_by_rule` for one week.
5. Healthy distribution looks like: low single-digit `conflicts_surfaced` per day, most turns have `conflicts_surfaced=0` (no contradictions in top-K), suppression rule counts roughly balanced (no single rule firing >80% of all suppressions — would indicate a tuning issue with that rule's default). The wired-up `contraPenalty` should show in `recall_log.ranked_hits[].score_components.contraPenalty < 1.0` for ~5-15% of memo hits (rough working estimate; revise from data).
6. After the dogfood week, optionally land follow-up migration `0016-conflict-surfacing-default-on.surql` running `UPDATE runtime:recall SET value.conflict_surfacing_enabled = true` for existing installs *if* we choose to flip the default. New installs flip via editing the seed in `0015` (the migration runner checksums applied migrations, so editing `0015` only affects fresh installs — same pattern B1 uses in §9.2 step 5). Numbering is reserved at design time (§9.1 lists `0015`/`0016` as the B2 + B2-follow-up pair; C2 moves to `0020` accordingly).

### 9.3 Rollback path

`UPDATE runtime:recall SET value.conflict_surfacing_enabled = false;` — instant (bounded by the 5-s cache TTL). The next recall reverts to today's behavior: no conflicts block, no `contradictionCount` plumbing on the score call, no extra telemetry fields. Already-written `recall_log` rows retain their `meta.conflicts_surfaced` field; new rows omit it.

### 9.4 Surfacing & telemetry sequencing

B2 ships before A3's eval harness consumes `recall_log.meta.conflicts_surfaced`. Until A3 stratification lands, the field is emitted but unread; harmless. After A3 lands, A3's golden fixtures already expect the field name per §6.2 — no renaming needed.

If C3 (telemetry umbrella) lands first, the field names from §6 transfer verbatim to whatever consolidated table C3 defines.

## Section 10 — File-by-file changes

**Created:**

- `system/cognition/intuition/conflicts.js` — `fetchContradictors`, `buildConflictBlock`, `applySuppression`. Pure functions where possible; one DB-touching function (`fetchContradictors`) fail-soft.
- `system/data/db/migrations/0015-conflict-surfacing.surql` — config seed extension (§9.1).
- `system/tests/unit/conflicts-suppression.test.js` — §8.1 tests 1-6.
- `system/tests/unit/conflicts-block.test.js` — §8.2 tests 7-11.
- `system/tests/integration/intuition-conflicts.test.js` — §8.3 tests 12-18 (split from `intuition.test.js` for clarity).

**Modified:**

- `system/cognition/intuition/inject.js`:
  - Import `fetchContradictors`, `buildConflictBlock` from `./conflicts.js`.
  - Read `conflict_*` keys from `runtime:recall` via the existing 5-s cache.
  - Inside the intuition fan-out `Promise.all`, after the recall fan-out builds `memoHits` and before the first `score()` call that constructs `merged`, invoke `fetchContradictors(db, memoIds, cfg)` (fail-soft, returns `{pairs: []}` on error). This computes `contraByHit` (per-hit contradictor counts) for use by *every* downstream `score()` invocation in this turn.
  - At the first `score()` call (the one building `merged` from `[...eventHits, ...memoHits]`), pass `contradictionCount: contraByHit.get(String(h.record.id)) ?? 0` so `contraPenalty` finally fires for ranking.
  - **At the recall_log rebuild call** — the second `score()` invocation, which rebuilds score components for `recall_log.ranked_hits[*].score_components` — also wire `contradictionCount` from the same `contraByHit` map. **Cleaner alternative (recommended):** instead of re-invoking `score()`, reuse `_scored.components` already attached to each entry of the `merged` array. The first `score()` call has already computed the components with the correct `contradictionCount`; reading them off `merged` for the `recall_log` write avoids a redundant recomputation and structurally guarantees the persisted row matches the live ranking. State this explicitly in the implementation: prefer `merged[i]._scored.components` over a second `score()` call.
  - After the greedy-pack step (where the per-line token budget is enforced), invoke `buildConflictBlock(pairs, callerScope, callerNow, cfg)`.
  - Concatenate `focusBlock + conflictBlock + block` in the final return (focusBlock comes from D1; for B2 in isolation, the prefix is `conflictBlock + block`).
  - Extend `intuition_telemetry` CONTENT with the §6.1 fields (top-level scalars + the FLEXIBLE `conflicts_suppressed_by_rule` object). If A3 has not yet landed `DEFINE FIELD meta ON intuition_telemetry TYPE option<object> FLEXIBLE`, B2's migration (§9.1) must add it as a precondition so any future B2 write under `meta.conflicts_surfaced` (and A3's own meta fields) lands on a valid schema.
  - Extend `recall_log.meta` CONTENT with `conflicts_surfaced` (§6.2).
  - When `cfg.conflict_surfacing_enabled === false`: skip the fetchContradictors call entirely (single `if` early-return on the conflicts path); `tokenBudget` stays at its current value (1500) — the conflicts block being off does not change relevant-memory's budget (§3.2); do not emit B2 fields to telemetry or recall_log.meta — keeps row shape backwards-compatible.

  Note: `inject.js` is touched by B2, D1, and D2 in overlapping ways (recall-pipeline prologue, telemetry write, recall_log write). Refer to insertion points by structural anchor (e.g., "after greedy-pack hits computed", "inside the intuition fan-out `Promise.all`", "the recall_log `CREATE` block") rather than line numbers, since line numbers will drift as those specs land.
- `system/cognition/intuition/rank.js`: no code change required — `contradictionCount` is already an accepted parameter (line 35, 40). B2 just starts populating it from the call site.
- `system/runtime/daemon/server.js` (or, post-R-3, `system/runtime/daemon/routes/intuition.js`):
  - Read `relevant_memory_token_budget` and `conflict_block_token_budget` from `runtime:recall` at request-handling time (reuse `getRecallConfig`).
  - Pass `tokenBudget` and `conflictTokenBudget` to `intuitionEndpoint`. When `conflict_surfacing_enabled === false`, force `tokenBudget=1500` and `conflictTokenBudget=0`.
- `docs/architecture.md`: mention `<!-- conflicts -->` block in "A typical agent turn" item 2 and the high-level pipeline diagram (recall pipeline → conflicts block).
- `docs/faculties.md`: add a paragraph under "intuition" describing the conflicts block + the wired-up `contradictionCount`.

**Not modified (intentional):**

- `system/cognition/memory/store.js` — `_surfaceSearch` does not learn about contradictions. The new query lives in `conflicts.js` per the anchoring decision.
- `system/cognition/memory/edge-registry.js` — `contradicts` symmetry already correct.
- `system/cognition/memory/decay.js` — `freshness` already returns 0 on superseded; we just call it server-side via `fn::freshness`.

## Section 11 — Cross-design coordination

### 11.1 No collision with B1

B1 (`2026-05-11-cognition-b1-per-hit-reinforcement-design.md`) extends `recall_log.ranked_hits[*]` with `used`, `used_via`, `used_score`, and adds top-level `attribution` and `reply_event_id`. B2 only:

- Reads `score_components.contraPenalty` (already present, never touched by B1).
- Writes `recall_log.meta.conflicts_surfaced` (new; B1 never touches `recall_log.meta`).

No field overlap. Both specs can land in either order. If B1 lands first, B2's `recall_log.meta` extension co-exists with B1's `attribution` / `reply_event_id` fields without further work. If B2 lands first, B1 reads `recall_log.meta` and ignores `conflicts_surfaced` (it's not in B1's attribution input set).

### 11.2 D1 block ordering

D1 introduces `<!-- current focus -->` *above* `<!-- relevant memory -->` with a 200-token cap. B2 introduces `<!-- conflicts -->` *between* them with a 300-token cap. Final ordering (§3.1): focus → conflicts → relevant-memory. Both new blocks are *additive* to the existing 1500-token relevant-memory budget — neither shrinks the others (§3.2).

The handler-side concatenation needs to know which block goes where. Per D1 §4.4, `intuitionEndpoint` now returns `{block, focus_block, focus_tokens, focus_suppressed_reason, …}`; B2 extends with `{conflict_block, conflict_tokens, conflict_suppressed_count}` (no per-rule reason field on the return — that lives only in telemetry):

```js
{
  // existing
  block, hits, tokens, latency_ms, truncated,
  // D1
  focus_block, focus_tokens, focus_suppressed_reason,
  // B2 (new)
  conflict_block, conflict_tokens, conflict_suppressed_count,
}
```

The handler (`system/cognition/intuition/handler.js`) concatenates in order: `payload.focus_block + payload.conflict_block + payload.block`. Each segment is independently optional (`'' || undefined → ''`). Old daemons returning fewer fields continue to work.

**R-4 envelope merge compatibility:** B2 introduces no `ok` key on the response envelope and does not alter `payload.focus_block` / `payload.conflict_block` access semantics. The new `conflict_*` fields nest alongside D1's `focus_*` fields on the same payload object, so any R-4 envelope-merge logic that already handles D1's surface handles B2's identically — no envelope-level change.

### 11.3 A3 eval harness

A3 (`2026-05-11-cognition-a3-recall-eval-and-mmr-design.md`) reads `recall_log.meta` for stratification. B2 adds `meta.conflicts_surfaced: int` — useful as a stratification key for "does Robin's recall quality degrade in contradiction-heavy turns?" Field name was chosen to match A3's golden-fixture naming convention (snake_case, descriptive, mirrors the `intuition_telemetry` field name).

A3's `recall_log.meta.from` (`'intuition' | 'mcp_recall'`) is orthogonal — B2 only fires on the `'intuition'` surface (the MCP `recall` tool path does not invoke `intuitionEndpoint`; it goes through `recall.js` directly). When A3 stratifies by `from`, the `'mcp_recall'` bucket will have `conflicts_surfaced` absent or zero — expected behavior.

### 11.4 C3 telemetry umbrella

B2's telemetry fields (§6.1) are emission-site specifications. If C3 introduces a new dedicated `conflicts_telemetry` table or normalizes `intuition_telemetry` into a different shape, the field names transfer verbatim. B2 does not pre-empt C3's storage decisions.

## Section 12 — Open questions

These are real ambiguities the design *acknowledges and defers*; not gaps the author missed.

- **`min_confidence` default.** 0.4 is a starting guess from the kind-level confidence write floors. Tune from `conflicts_suppressed_by_rule.low_confidence` rate after the dogfood week — if it dominates, lower to 0.3; if it never fires, raise to 0.5.
- **Self-pair frequency.** How often are *both* sides of a contradiction in the agent's top-K? If frequent, the conflict block largely duplicates relevant-memory content and the new block is mostly redundant. If rare, the "pull contradictor in even if not ranked" semantic does the heavy lifting. Telemetry: count pairs where `String(hitSide.id)` and `String(otherSide.id)` are both in the emitted relevant-memory block, log as `conflicts_both_sides_in_view`. Decide after one week.
- **`contraPenalty` value impact on ranking.** Wiring `contradictionCount` may push contradicted memos *out* of top-K, which means we'd lose the "pull contradictor in" hook (the hit-side memo wouldn't be in the block to trigger expansion). Mitigation if observed: hydrate contradictors from `memoHits` *pre-rank-truncation* — already what §1.3 does (we fetch from `memoIds` built off `memoHits`, not the post-rank list). If telemetry shows pairs disappearing because both sides got penalized below the cut, we'd need to either relax the penalty floor (0.1) or expand `memoIds` to include `searchMemos` over-fetch results.
- **Cross-kind contradictions.** Today `contradicts` is only declared for `memos→memos` in the registry. A future `state_inference` vs `knowledge` contradiction would be valid by the registry (both are `memos`). The conflict block already handles this — it filters by `_kind === 'memo'`. No spec change needed; flagged for awareness.
- **Asymmetric "→ but I'm not sure" cases.** If memo A "contradicts" memo B but A.confidence is 0.9 and B is 0.5, surfacing both as a peer dispute might overstate B. Argument for showing anyway: the agent can adjudicate with the confidences in hand (we emit both `conf X.XX <-> Y.YY`). Defer until we see what kinds of asymmetries dogfood produces.
- **Freshness-asymmetric pairs.** A separate dimension from confidence-asymmetric: a pair where A.ts is 2 days ago and B.ts is 28 days ago (both inside the 30-day staleness window) is dispute-shaped data but the freshness gap is doing a lot of the agent's adjudication work for it. Today the conflicts block shows both dates; the agent can read the gap. Open question: should the surfacing logic explicitly mark "newer side leads" as a hint, or rely on the agent's own reasoning over the date prefix? Defer until dogfood shows whether the agent reliably uses the freshness signal without explicit prompting.
- **Conflicts block + recall_used.** B1's future `recall_used` MCP tool (B1 §5) lets the agent acknowledge which hits it used. Should the conflicts block participate in that ack ("I used the dispute info, which side did I lean on")? Open question — likely the agent's reply already encodes which side it chose; B1's similarity pass would catch that without new wiring. Revisit when the tool ships.

## Section 13 — Cost envelope

- Per recall, conditional on `conflict_surfacing_enabled=true` AND `memoIds.length > 0`:
  - +1 SurrealDB roundtrip (multi-statement LET + projection, §1.2).
  - DB rows scanned: ≤ `k × max_pairs_per_memo` edges (PK index range scan) + ≤ `2 × that` memos (PK lookup).
  - JS-side: O(pairs) suppression + O(pairs log pairs) sort for §2.3 ordering — single-digit microseconds.
- Per recall when `conflict_surfacing_enabled=false`: zero new DB work (the gate short-circuits before `fetchContradictors`). Zero new telemetry fields written. Zero behavior change.
- Per recall when flag on but `memoIds.length === 0`: zero new DB work (the `memoIds.length > 0` guard short-circuits hydration); the conflicts block is omitted, telemetry fields emit as zeros.
- Per recall when flag on, memo hits present, but no contradictors exist: +1 DB roundtrip returning empty `pairs`. Telemetry emits zeros. Block omitted.
- New LLM tokens: **zero**.
- New embedding tokens: **zero**.
- Prompt tokens net change: ≤ +300 (conflicts block) on turns with surfaced conflicts; **0** on turns without conflicts (the block is empty and its markers are omitted entirely). Practical net change on a typical turn (no conflicts): **-0 tokens vs today** — the conflicts block is empty when no conflicts. Practical net change on a conflict-surfacing turn: +0 to +300 (additive, no shrink of relevant-memory). Total prompt-budget ceiling after D1+B2 both ship: 1500 baseline + 200 (D1 focus) + 300 (B2 conflicts) = up to 2000 tok when all three flags on, and only when both new blocks have content to surface.

Within the post-alpha.16 cost envelope. Not cadence-eligible (intuition is the synchronous recall path).

## See also

- `2026-05-11-cognition-b1-per-hit-reinforcement-design.md` — sibling B-track spec; shares `recall_log` but no field overlap.
- `2026-05-11-cognition-d1-state-inference-design.md` — sibling D-track spec; defines `<!-- current focus -->` block ordering above B2's `<!-- conflicts -->`.
- `2026-05-11-cognition-a3-recall-eval-and-mmr-design.md` — reads `recall_log.meta.conflicts_surfaced` for stratification.
- `2026-05-11-robin-v2-theme-2a-evidence-ledger-design.md` — `contradicts` edge auto-emits refute rows; B2 reads the resulting `confidence`.
- `2026-05-11-robin-v2-database-and-memory-redesign-design.md` — `edges` table shape, composite PK, symmetric-edge canonicalization.
- `system/cognition/intuition/inject.js` — the file most modified by B2.
- `system/cognition/intuition/rank.js` — finally has its `contradictionCount` parameter populated.
- `system/cognition/memory/edge-registry.js` — confirms `contradicts` symmetry.
- `system/cognition/memory/store.js` — `flagContradiction`, `searchMemos`, `relateAll` (the producer side, unchanged by B2).
