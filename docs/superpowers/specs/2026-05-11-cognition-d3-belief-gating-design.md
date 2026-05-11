# Robin v2 — Cognition D3: confidence-gated assertion (`belief` tool) + calibration meta-narrative

**Status:** Design (working draft; ships behind a shadow flag — see §9)
**Date:** 2026-05-11
**Umbrella:** `2026-05-11-robin-v2-evolution-roadmap.md` (post-alpha.16, "Cognition D" track)
**Depends on:**
- `2026-05-11-robin-v2-theme-2a-evidence-ledger-design.md` — `evidence_ledger` + `fn::derived_confidence`.
- `2026-05-11-robin-v2-theme-3-cognition-cadence-design.md` — `dream_triggers` / `cadence_telemetry` (read-only here).
- `2026-05-11-runtime-layer-hardening-design.md` — Phase R-3 routes/tools split; D3 lands the MCP tool through `system/runtime/daemon/tools.js`.
**Coordinates with:**
- `2026-05-11-cognition-d2-recall-failures-meta-cognition-design.md` (sibling — same round; both write `kind='reasoning'` memos; both schedule weekly meta-cognition writers; share the `meta.from_signal = 'meta_cognition'` namespace and disjoint `meta.dimension` values).
- `2026-05-11-cognition-a3-recall-eval-and-mmr-design.md` (eval harness; `belief()` must not regress recall metrics — it reuses `searchMemos` and the recall harness picks that up automatically).

## Why

Today, calibration runs but the output goes nowhere actionable:

1. `system/cognition/dream/step-calibration.js` calls `computeCalibration(db)` (in `system/cognition/jobs/predictions.js`, delegating to `system/cognition/memory/foresight.js:95`), then `setCalibration(db, c)` — which writes `persona:singleton.calibration` (see `predictions.js:135-138`). Nothing in the recall / assertion path reads it. The agent receives no signal about how calibrated it has been on a topic.
2. `derived_confidence` is per-memo (Theme 2a) — but agents have no aggregate. When the user asks "what's the f-stop of the GFX 100 II at native ISO?" the agent has six memos with confidences `[0.9, 0.8, 0.4, 0.7, 0.2, 0.9]` and no way to ask "should I assert or soften?".
3. There is no feedback loop from calibration drift to behavior change. If Robin's confidence on "API library versions" is consistently +0.15 brier off (over-confident), nothing tells it to stop. `step-reflection` looks at corrections, not calibration metrics.

D3 closes both gaps:

- **Part 1.** A new MCP tool `belief({query, domain?})` that aggregates evidence-backed confidence over recalled memos, applies a per-domain calibration adjustment (when available), and returns an `assert | soften | unknown` recommendation. The agent reads this **before** committing to a high-confidence assertion. Cost-bounded: no LLM call, no extra embed beyond the one `searchMemos` already does.
- **Part 2.** A weekly meta-narrative writer that summarizes per-domain calibration drift as a `kind='reasoning'` memo (with `meta.dimension='calibration'`) so the trend is visible to recall and to the user (`get_knowledge --kind=reasoning`); if drift is sustained-large, emits a `rule_candidate` recommending soften-by-default for that domain.

This sits in the "Cognition D" track of the post-alpha.16 evolution roadmap. D1 (state inference) is a memo *producer*; D2 (recall failures meta-cognition) is a meta-cognition *writer*; D3 is a calibration *consumer* + meta-cognition *writer*. D2 and D3 share the `reasoning` kind and a writer cadence — coordination spelled out in §10.

## Goals

- One read-only MCP tool that returns aggregate, calibration-adjusted confidence + a recommendation in < 100ms (target P95).
- Zero new LLM tokens per `belief()` call. Zero new embed tokens per call beyond what `searchMemos` already does.
- Private-scope memos never leak through `belief()` — direct or transitive. Reuse the outbound-policy pattern.
- Weekly calibration meta-narrative written automatically; surfaces as a recallable `kind='reasoning'` memo and (if drift sustained-large) emits a `rule_candidate`.
- Schema-additive only: no destructive migration. Ships in shadow first; agent-facing usage pattern flips on after one dogfood week.
- Fail-soft everywhere: missing calibration data → `calibrated = aggregate`; missing evidence → `recommendation = 'unknown'`; tool error → empty payload with `error` field, never a thrown.

## Non-goals

- Training a calibrator from scratch (LLM-judged per-claim correctness). Brier-style drift derived from `foresight.computeCalibration` is the input; we adjust, we don't relearn.
- Replacing `explain_belief` (per-memo) — `belief()` is the aggregate. `explain_belief({memo_id})` continues to answer "why does Robin believe memo X at confidence c". `belief({query})` answers "what's Robin's aggregate confidence about topic X right now".
- Decision authority over the agent. `belief()` returns a *recommendation*; the agent reads the kind-`reasoning` memo and decides. The agent-side usage pattern lives in `AGENTS.md` (§9.3) as a doc, not a check.
- Per-claim calibration (would require LLM-judged ground-truth labels per assertion). Domain-level drift is the unit; per-claim is an open question (§11).
- Real-time drift detection. Meta-narrative is **weekly** by design — cheap, smooth, low-noise. Triggered cadence is reserved for `reflection` / `comm-style` / `calibration` (Theme 3); the meta-narrative writer is a fourth, slower lane.

## Anchoring decisions

**Why aggregate over `searchMemos(kind='knowledge')` rather than walk `evidence_ledger` directly:**

`evidence_ledger` rows are per-memo; without a vector recall first, we'd need a text-match path to find "memos about this topic", which duplicates `_surfaceSearch`'s shape (HNSW + BM25 + filters). `searchMemos` is the single-source-of-truth retrieval; reusing it means `belief()` inherits A1 (real-cosine MMR), A2 (entity boost), and A3 (eval harness) for free. The cost is one extra recall call per `belief()` — bounded by the existing recall cost envelope.

**Why a separate MCP tool rather than extending `recall` with a confidence rollup:**

Three reasons. (a) `recall` is the everyday read; `belief` is an explicit, conscious "should I assert this?" check. Bundling would inflate every `recall` response payload. (b) `recall` is hit on every UserPromptSubmit by intuition; `belief` is intent-bearing, agent-issued. Different invariants, different latency budgets. (c) Theme 4's introspection tools (`explain_recall`, `explain_belief`) set the precedent: a separate read-only tool per question. `belief` joins them.

**Why apply calibration adjustment server-side instead of returning raw + drift and letting the agent compute:**

The agent isn't trusted to do the math reliably — that's the whole point of a centralised, observable adjustment. By returning both `aggregate_confidence` and `calibrated_confidence`, we expose the underlying signal *and* the recommended interpretation. Telemetry on `(aggregate − calibrated)` lets us tell whether the adjustment is actually firing in production.

**Why store the meta-narrative as a `kind='reasoning'` memo, not a singleton runtime row:**

A memo can be recalled — the next time the agent asks about API library versions, `searchMemos(kind='knowledge')` plus a small `searchMemos(kind='reasoning')` slot can return both the fact and Robin's own meta-comment on its track record there. A runtime row can't. Storing it as a memo also gives us `signal_count`, decay, and the rest of the existing memory machinery for free. Cost: one row per week per domain (typically 5-10 rows/week total).

**Why weekly cadence, not daily, not triggered:**

Brier deltas over one day are noisy (~1-3 resolved predictions a day, per `foresight.listOpen` typical sizes). One week smooths the noise without making the loop irrelevant. Triggered cadence (Theme 3) is for *immediate-feedback* loops (correction → reflection in 60s). Calibration drift is a slow signal — weekly is the right scale, and the daily-cost overhead of a scheduled job is one cheap SELECT per day before the writer is due.

**Why D2 at Sunday 05:00 local and D3 at Sunday 05:30 local (not the same minute):**

Both writers are weekly internal jobs producing `reasoning` memos. The runner is single-threaded per-job; running them concurrently isn't a correctness risk, but it does mean two LLM-free batch reads against the same DB at the same instant — wasteful. 30-minute offset gives each writer the host to itself. The cron parser at `system/cognition/jobs/cron.js:77-83` uses `getMinutes()` / `getHours()` / `getDay()` — all **local** time, not UTC. D2 and D3 both schedule in local time; the 30-minute gap is large enough that DST shifts won't collide. Sunday 05:00 picked to land after the nightly dream run (4 AM local) — so the calibration row that `step-calibration` writes Saturday night is already fresh.

## Section 1 — `belief()` MCP tool surface

**Tool name:** `belief`. Registered alongside the read-only introspection tools in `system/runtime/daemon/tools.js` (post-R-3; see §10 for the file delta).

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "query":  { "type": "string", "minLength": 1, "maxLength": 500 },
    "domain": { "type": "string", "minLength": 1, "maxLength": 80 },
    "k":      { "type": "integer", "minimum": 1, "maximum": 20, "default": 8 }
  },
  "required": ["query"],
  "additionalProperties": false
}
```

Unrecognized inputs are rejected explicitly — keeps the tool surface tight and prevents callers from passing fields the server silently ignores.

`k` bounds the number of evidence-bearing memos returned. Default 8 is one more than `intuition`'s default `k=6` — `belief()` is intent-bearing, so a slightly wider net is acceptable.

**Output shape:**

```json
{
  "query": "f-stop of the GFX 100 II at native ISO",
  "domain": "photography",
  "aggregate_confidence":  0.74,
  "calibrated_confidence": 0.61,
  "evidence": [
    {
      "memo_id": "memos:abc",
      "content_snippet": "GFX 100 II base ISO is 80; f/2 lenses available are the 80mm and 110mm.",
      "derived_confidence": 0.88,
      "last_observed": "2026-05-09T14:22:00Z",
      "weight": 0.34
    }
  ],
  "calibration": {
    "domain": "photography",
    "brier": 0.18,
    "drift": -0.12,
    "samples_count": 17,
    "as_of": "2026-05-10T05:02:11Z",
    "source": "persona.calibration"
  },
  "recommendation": "soften",
  "meta": {
    "k_requested": 8,
    "k_returned": 4,
    "hits_dropped_private": 0,
    "hits_dropped_relevance": 2,
    "elapsed_ms": 67,
    "fallback_path": null,
    "shadow": true,
    "shadow_recommendation_would_have_been": "soften"
  }
}
```

Field meanings:

- `aggregate_confidence`: weighted average of per-hit `derived_confidence`, in `[0, 1]`. Weight = `(signal_count × decay × relevance)` (§2.3 — see the note there on why we deliberately keep confidence out of the weight to avoid double-counting).
- `calibrated_confidence`: `aggregate_confidence` adjusted by domain calibration. Equal to `aggregate_confidence` when calibration is absent. Always in `[0, 1]`.
- `evidence[]`: up to `k` rows, in descending weight order. `content_snippet` is the memo content truncated to 200 chars (sentence-aware truncation — slice to the last `[.!?]` if any in the first 200, else hard cut + `…`). `weight` is the per-hit `(freshness × relevance)` value, post-normalisation (sums to 1.0 across returned evidence). `last_observed` is the more recent of `memos.decay_anchor` (bumped by the reinforcement loop on every used recall) and `memos.derived_at` — so it reflects "when did this memo last fire", not "when was it born". Both fields are already in the hit row from `searchMemos`; no extra query.
- `calibration`: present when calibration data exists for the domain; otherwise omitted (not null — keep the payload narrow). `drift` is signed (positive = over-confident, negative = under-confident); `source` is one of `'persona.calibration'` (current path) or `'meta_narrative'` (when the weekly writer is producing direct drift rows — see §3.4).
- `recommendation`: `'assert' | 'soften' | 'unknown'`, per §2.4 thresholds.
- `meta`: telemetry surfaced inline for the agent (k accounting, redaction counts, latency). `fallback_path` is `null` on the happy path; otherwise one of `'no_hits'`, `'all_below_relevance'`, `'all_private'`, `'calibration_unavailable'`, `'error'`. `shadow` is `true` whenever `cfg.shadow_mode` is on (§5); during shadow, `recommendation` is forced to `'unknown'` and `shadow_recommendation_would_have_been` carries the raw value (`'assert' | 'soften' | 'unknown'`) the gate would have produced — used by the dogfood telemetry (§9.2) to dashboard the would-be distribution. When `shadow = false`, `shadow_recommendation_would_have_been` is omitted.

**Error envelope.** On internal error, return `{ error: 'belief_internal', query, domain, recommendation: 'unknown', meta: { ... } }` — never a thrown. Keeps the tool fail-soft against the same invariants `recall` / `find_entity` already meet.

## Section 2 — Aggregation pipeline

### 2.1 Recall stage

Run `store.searchMemos(db, embedder, query, opts)` with:

```js
const opts = {
  kind: 'knowledge',
  limit: k_overfetch,                        // see below
  // scopes intentionally omitted: defaults to the persistent-scopes filter,
  // which includes `private`. We filter private explicitly in §2.5 because
  // searchMemos returns it (per scope-registry.js:74-83) and the §2.5 filter
  // also needs to catch *transitive* private leakage that searchMemos can't
  // express in one SQL filter.
};
```

`k_overfetch = ceil(k * cfg.belief_overfetch_factor)` where `cfg.belief_overfetch_factor = 2.0` (default). Rationale: post-recall, we drop hits below `relevance_threshold` (§2.2), drop hits in `private` scope direct or transitive (§2.5), and drop hits with `derived_confidence < cfg.confidence_floor` (§2.4). An overfetch factor of 2 keeps the returned set from collapsing on lossy queries.

A2's entity-boost already applies if the engine is wired to use the boosted scorer for memo recalls (per A2 §3.3). `belief()` does not override this — the same scoring the agent sees in everyday recall is the scoring `belief()` returns evidence against. This keeps the displayed confidence aligned with the recall pipeline and avoids a second tuning surface.

### 2.2 Relevance filtering

Hits below `cfg.relevance_threshold` (default `0.30` cosine — same defensible-low value the A3 spec uses for its eval relevance cut) are dropped *before* aggregation. Cosine is available as `1 - hit.dist` from the HNSW `vector::distance::knn()` field (`store.js:527-532`).

A hit dropped by relevance counts against `meta.hits_dropped_relevance`. If *every* hit gets dropped, `fallback_path = 'all_below_relevance'`, `aggregate_confidence = 0`, `recommendation = 'unknown'`.

### 2.3 Per-hit weight

For each surviving hit:

```js
weight_raw     = signal_count(hit) * decay(hit) * relevance(hit)
relevance(hit) = 1 - hit.dist                       // [0, 1] (HNSW cosine)
signal_count   = memos[hit.id].signal_count         // integer ≥ 1
decay(hit)     = exp(-age_days / half_life_for_kind) * (reinforced_or_1)  // [0, 1]
```

Then weights are normalised: `weight[i] = weight_raw[i] / Σ weight_raw[j]`. Sum-to-1 makes the weighted average a well-formed expectation.

**Why not `fn::freshness` directly.** `fn::freshness` (defined in `0001-init.surql:188-191`) returns `confidence × decay × reinforced` and zeros out superseded memos. Using it for the weight while *also* using `derived_confidence` as the value would multiply the memo's own confidence into the aggregate twice — once in the weight (via `freshness`) and once in the value (via `derived_confidence`, which is built from `confidence` as its prior). The aggregate would be biased toward `confidence²`, which silently rewards already-confident memos.

To avoid this double-count, D3 computes the weight from the *structural* components of `fn::freshness` minus the confidence term: `signal_count` (frequency proxy), `decay` (recency), and `reinforced` (per-hit reinforcement; folded into `decay` here for the same single-batch lookup pattern). The supersedes-zero rule still applies — we materialise it by setting `decay = 0` when the memo has an inbound `supersedes` edge. Implementation: a single batched query `SELECT id, signal_count, decay_anchor, reinforced, count(<-supersedes<-memos) AS sup FROM memos WHERE id IN $ids`, then compute `decay` in JS using the same half-life table `fn::freshness` uses internally (kept aligned via a shared constants file — open in §11 to extract).

**Divide-by-zero guard.** When every surviving hit has `weight_raw = 0` (e.g., every memo is superseded → `decay = 0` for all), `Σ weight_raw = 0`. We treat this as the same shape as "no hits": `aggregate_confidence = 0`, `recommendation = 'unknown'`, `fallback_path = 'no_hits'` (collapsed for simplicity — separate `'all_zero_weight'` is over-specified for a path that's effectively "we found things but the freshness machine says none of them count"). Unit test §8.1 #2 covers this.

### 2.4 Aggregate, derived, calibrated

```js
derived[i]            = await fn::derived_confidence(memos[i].id)
                        // batched: SELECT VALUE fn::derived_confidence(id) FROM $ids
                        // fallback to memos[i].confidence if the function errors
aggregate_confidence  = Σ (weight[i] × derived[i])      // [0, 1] by construction
calibration           = readCalibration(db, domain)     // §3
calibrated_confidence = applyCalibration(aggregate_confidence, calibration, cfg)
```

`applyCalibration` (pure, in `system/cognition/memory/belief.js`):

```js
function applyCalibration(agg, cal, cfg) {
  if (!cal || cal.samples_count < cfg.min_calibration_samples) return agg;
  if (typeof cal.drift !== 'number' || Number.isNaN(cal.drift)) return agg;
  // drift > 0 → over-confident → push the aggregate DOWN.
  // drift < 0 → under-confident → push UP.
  const adjusted = agg - cal.drift * cfg.calibration_adjustment_gain;
  return Math.max(0, Math.min(1, adjusted));      // clamp to [0, 1]
}
```

Defaults: `min_calibration_samples = 5`, `calibration_adjustment_gain = 1.0`. Both tunable in `runtime:belief.config` (§5).

A sigmoid feels tempting but is wrong here: drift is already in confidence-space (a measured offset between predicted and observed accuracy), so a linear correction with a clamp is the right shape. We can swap to sigmoid behind the gain knob if telemetry shows the linear correction overshooting in the tails.

### 2.5 Privacy filter

Reuse the `outbound-policy.js` pattern, but inlined as a filter (not a refusal) because `belief()` is a read tool and the natural failure mode is "drop, don't reject":

**Direct + transitive (stricter than D1).** D1 (`state inference`) filters direct-private only (per D1 spec §6.3) because D1's inference output is downstream-scoped — anything D1 emits passes through other guards before it can leak. D3 is different: `belief()` is a read whose payload (the `evidence[]` block) exposes memo content *directly* to the caller. A transitive-private memo (e.g., a public memo `derived_from` a private one) carries content the user expects to stay private. Stricter filtering is acceptable here; the cost is one extra arrow-path query.

1. After hits land, compute `refs = hits.map(h => h.id)`.
2. Direct-scope check: `SELECT id, scope FROM memos WHERE id IN $refs`. Drop any with `isOutboundBlocked(scope)` true.
3. Transitive check: `SELECT id FROM memos WHERE id IN $refs AND count(<-derived_from<-memos[WHERE scope = 'private']) > 0`. Drop those too. (Same `<-derived_from<-memos` arrow path `checkOutboundScope` uses, but on the `memos` surface — `belief()` doesn't reference events.)
4. Increment `meta.hits_dropped_private` per drop.
5. If *all* hits were private: `fallback_path = 'all_private'`, `aggregate_confidence = 0`, `recommendation = 'unknown'`.

**Why no refusal log.** `outbound-policy.js`'s `checkOutboundScope` writes a `refusals` row when a write would have leaked a private memo to an external destination. `belief()` is different: it's a read tool with redaction-by-omission, and the agent never sees the dropped row's content or ID. Logging a refusal per dropped private memo would (a) blow up the `refusals` table size (each `belief()` call could drop multiple private memos), (b) leak private memo IDs into the very table downstream consumers read for "what did Robin refuse?", and (c) noise out the genuine outbound-refusal signal. The aggregate-level `meta.hits_dropped_private` is the right granularity — visible to the agent (so it knows redaction happened) without per-memo identity exposure. The same pattern is used by `explain_belief` and `explain_recall` (Theme 4) — they redact-by-content, log nothing extra.

### 2.6 Recommendation

Per-domain threshold lookup. Order of precedence:

1. `cfg.domain_thresholds[domain]` if set (e.g. `{ photography: 0.55, "api versions": 0.7 }`).
2. Else `cfg.default_threshold` (default `0.6`).

```js
const t = domainThresholdFor(domain, cfg);
if (k_returned === 0 || calibrated_confidence <= cfg.soften_floor) {
  recommendation = 'unknown';
} else if (calibrated_confidence >= t) {
  recommendation = 'assert';
} else if (calibrated_confidence > cfg.soften_floor) {
  recommendation = 'soften';
} else {
  recommendation = 'unknown';
}
```

Defaults: `default_threshold = 0.6`, `soften_floor = 0.4`. So:

- `≥ 0.6` → `assert`.
- `(0.4, 0.6)` → `soften`.
- `≤ 0.4` or zero hits → `unknown`.

Zero hits *always* yields `unknown` regardless of confidence (defensive — a zero aggregate shouldn't shade into `soften`).

### 2.7 Domain inference

When the caller passes `domain`, use it verbatim. When omitted:

1. Tokenise the query with `tokensOf(query)` (same matcher A2 uses — `system/cognition/intuition/entities.js:tokensOf`).
2. Read the in-process entity catalog (already cached by A2 with 60s TTL keyed on `runtime:embedder.active_profile`). Match against `tokensOf(catalog[i].name)`.
3. Inferred `domain`:
   - If exactly one entity matched and `entity.type ∈ cfg.domain_entity_types` (default `['topic','project','library']`): use `entity.name.toLowerCase()`.
   - If multiple matched of those types: use `null` (no domain — falls back to `default_threshold` and no calibration adjustment). Telemetry: `meta.domain_inferred = 'ambiguous'`.
   - If none: `null`. Telemetry: `meta.domain_inferred = 'none'`.

A2's catalog cache is the only path that touches the entities table — `belief()` reuses it via `getCatalog()`. No extra DB load.

Domain inference is intentionally weak: it's a *hint* to look up a sharper threshold, not authoritative. The caller's explicit `domain` always wins.

## Section 3 — Reading calibration

### 3.1 Today's calibration shape

`computeCalibration` (`predictions.js:115-133`) returns:

```js
{
  by_kind:        { [statement_kind]: { resolved, correct, accuracy } },
  total_open:     int,
  total_resolved: int,
  last_computed_at: Date,
}
```

`step-calibration` writes this to `persona:singleton.calibration` via `updateCalibration`. No per-domain rollup, no brier, no drift — only per-`statement_kind` accuracy. This is the current source of truth and `belief()` must read it on day 1.

**Day-1 expectations.** `statement_kind` is a free string the prediction memos carry — there is no enum, and existing values are coarse (typical examples: `'prediction'`, `'forecast'`, things written by `step-foresight`). User-facing `domain='photography'` is unlikely to match any current `statement_kind`. Therefore, on day 1, **most `belief()` calls fall through to `aggregateAcrossKinds` (cross-kind drift only)** — the per-domain path is aspirational and largely inactive until the meta-narrative writer (Part 2) has produced at least one row per domain (typically two weeks after land, the first one for each domain). The persona path provides cross-kind drift as a placeholder during that warm-up window; we surface this in `calibration.source = 'persona.calibration'` so the agent can see when it's running on the fallback.

### 3.2 `readCalibration(db, domain)` — day-1 path

```js
async function readCalibration(db, domain, cfg) {
  const [rows] = await db.query('SELECT calibration FROM persona:singleton').collect();
  const cal = rows?.[0]?.calibration;
  if (!cal || !cal.by_kind) return null;

  // Match `domain` against statement_kind, case-insensitive.
  const key = domain
    ? Object.keys(cal.by_kind).find(k => k.toLowerCase() === domain.toLowerCase())
    : null;
  if (!key) {
    // Cross-kind aggregate fallback when domain absent or unmatched.
    return aggregateAcrossKinds(cal.by_kind, cal.last_computed_at, cfg);
  }
  const v = cal.by_kind[key];
  return {
    domain: key,
    samples_count: v.resolved,
    accuracy: v.accuracy ?? 0,
    // Drift = (claimed accuracy if model is well-calibrated) − observed accuracy.
    // We use the macro proxy: assume agents who claim a fact at confidence c
    // are right c-fraction of the time; we don't have per-claim confidence in
    // persona.calibration, so drift here is `expected_accuracy − v.accuracy`
    // with `expected_accuracy = cfg.expected_accuracy_baseline` (default 0.75).
    drift: (cfg.expected_accuracy_baseline ?? 0.75) - (v.accuracy ?? 0),
    as_of: cal.last_computed_at,
    source: 'persona.calibration',
  };
}
```

This is a deliberately conservative mapping — `persona.calibration` was never designed as a brier feed, so we approximate. The meta-narrative writer (Part 2) is where proper brier lands, and `readCalibration` upgrades to read it directly once the writer has at least one row (§3.4).

### 3.3 Aggregate across kinds (no domain)

```js
function aggregateAcrossKinds(by_kind, ts, cfg) {
  let total = 0, correct = 0;
  for (const v of Object.values(by_kind)) { total += v.resolved; correct += v.correct; }
  if (total === 0) return null;
  return {
    domain: null,
    samples_count: total,
    accuracy: correct / total,
    drift: (cfg.expected_accuracy_baseline ?? 0.75) - (correct / total),
    as_of: ts,
    source: 'persona.calibration',
  };
}
```

### 3.4 Meta-narrative upgrade

Once Part 2 lands, `readCalibration` first looks for a recent `kind='reasoning'`, `meta.dimension='calibration'`, `meta.domain=<domain>` memo (most recent ≤ 14 days old). If found, use *its* embedded brier/drift directly:

```surql
SELECT meta, content, derived_at
FROM memos
WHERE kind = 'reasoning'
  AND meta.dimension = 'calibration'
  AND meta.domain = $domain
  AND derived_at >= time::now() - 14d
ORDER BY derived_at DESC
LIMIT 1;
```

`source = 'meta_narrative'`. Falls back to `persona.calibration` when no recent memo exists. The 14-day window is intentional: the writer is weekly, so a 14d window covers two missed cycles before we declare the meta-narrative stale.

**Index considerations.** `meta.dimension` and `meta.domain` are flexible-meta fields, not first-class columns; SurrealDB v3 can't INDEX `meta.<x>` directly without a computed column. The existing `(kind, derived_at)` filter narrows the scan to *only* `kind='reasoning'` memos in the last 14 days — by design, an extremely small set (D2 + D3 weekly writers produce ~10-20 rows total per week). A full table scan over that subset is fine. If the `reasoning` memo count ever balloons (e.g., a future writer goes per-session), revisit by adding a computed `meta_dimension` field with `DEFINE FIELD meta_dimension VALUE meta.dimension` + index. Out of scope for D3.

## Section 4 — Cost & performance envelope

Per `belief()` call:

- **1 embed.** Already paid by `searchMemos` for the query. No second embed.
- **1 HNSW + BM25 fused recall.** Same cost as a `recall` call (already in budget).
- **1 batched structural-weight query over `k_overfetch` ids** (`signal_count`, `decay_anchor`, `reinforced`, supersedes-count — see §2.3). One round-trip; avoids `fn::freshness` to prevent confidence double-counting.
- **1 batched `fn::derived_confidence` over `k_overfetch` ids.** One round-trip.
- **1-2 scope filter queries.** Direct + transitive (mirror of `checkOutboundScope`'s two SELECTs).
- **1 SELECT on `persona:singleton`.** Cached for 30s in-process (calibration is a slow signal — see §3.1; explicit cache invalidation on `step-calibration` not necessary at this cadence).
- **0-1 SELECT on `memos` for meta-narrative override.** Only after Part 2 lands; bounded by index `(kind, derived_at)`.

Target P95 latency: < 100ms (measured end-to-end at the MCP boundary; daemon-internal). LLM calls: **0**. Embed calls: **0** beyond the recall. Memory: O(k_overfetch).

The recall harness (A3 §2) treats `belief()` as just another consumer of `searchMemos`; A3's regression detector picks up any latency / quality drift in the underlying recall without further wiring. We do *not* run `belief()` itself through the harness in v1 — there's no labeled "true aggregate confidence" set to compare against. (Open question §11.)

## Section 5 — `runtime:belief.config`

Seeded by `0019-belief-gating.surql` (§7.1). Read once per call (cached 5s).

```json
{
  "default_threshold":              0.6,
  "soften_floor":                   0.4,
  "domain_thresholds":              {},
  "relevance_threshold":            0.30,
  "confidence_floor":               0.05,
  "belief_overfetch_factor":        2.0,
  "min_calibration_samples":        5,
  "calibration_adjustment_gain":    1.0,
  "expected_accuracy_baseline":     0.75,
  "domain_entity_types":            ["topic", "project", "library"],
  "shadow_mode":                    true,
  "telemetry_enabled":              true,
  "telemetry_sample_rate":          1.0,

  "meta_narrative_enabled":         true,
  "meta_narrative_min_samples":     5,
  "meta_narrative_drift_threshold": 0.15,
  "meta_narrative_window_days":     7,
  "meta_narrative_rule_threshold":  0.15,
  "meta_narrative_rule_min_weeks":  2
}
```

- `shadow_mode = true` (default at land): the tool returns its full payload but `recommendation` is overridden to `'unknown'` and an extra `meta.shadow = true` flag is added. The agent's instructions in `AGENTS.md` are unchanged until the flag flips. This lets us land + measure without changing behavior. Telemetry observes how *raw* recommendations would have distributed; we flip when the distribution looks healthy (per §9.3).
- `confidence_floor`: drop hits whose `derived_confidence < floor` *before* aggregation. Prevents one tail-zero memo from dragging the aggregate. Floor at 0.05, not 0, so memos refuted to "almost zero" still count toward `meta.hits_dropped_*` telemetry.
- `meta_narrative_*` knobs configure Part 2 (§6); kept on the same row for one cache hit.
- `meta_narrative_drift_threshold = 0.15` and `meta_narrative_rule_threshold = 0.15` align with the §1 motivating example (`+0.15 brier` is the smallest drift we want to call out). v1 keeps both at this level; if telemetry shows the threshold catching too much short-term noise after one month of data, relax to `0.20` (two-sigma over typical week-to-week brier noise in v0 data is the next reasonable stop).

## Section 6 — Part 2: weekly calibration meta-narrative

### 6.1 The writer

New internal job: `system/cognition/jobs/internal/weekly-calibration-narrative.js`, registered via `system/cognition/jobs/builtin/weekly-calibration-narrative.md`:

```yaml
---
name: weekly-calibration-narrative
schedule: "30 5 * * 0"          # Sunday 05:30 local time (D2 is 05:00 local — see §10)
runtime: internal
enabled: true
catch_up: false
timeout_minutes: 5
notify: none
notify_on_failure: true
manually_runnable: true
description: Weekly per-domain calibration drift summary as a kind='reasoning' memo; emits a rule_candidate when drift is sustained-large.
---
```

The cron parser (`system/cognition/jobs/cron.js:77-83`) interprets `getMinutes()` / `getHours()` / `getDay()` in **local** time. `30 5 * * 0` therefore fires at Sunday 05:30 local — not UTC. D2's `0 5 * * 0` fires at Sunday 05:00 local. Both align with the cron parser's local-time semantics.

### 6.2 What it reads

```surql
-- 1. Resolved predictions in the past 7d, grouped by statement_kind.
SELECT
  meta.statement_kind AS domain,
  meta.correct        AS correct,
  confidence          AS predicted_confidence,
  meta.resolved_at    AS resolved_at
FROM memos
WHERE kind = 'prediction'
  AND meta.resolved_at IS NOT NONE
  AND meta.resolved_at >= time::now() - 7d;

-- 2. Same query for the previous 7d window (for week-over-week delta).
--    cutoff_a = now - 14d; cutoff_b = now - 7d
SELECT meta.statement_kind AS domain, meta.correct AS correct, confidence AS pc
FROM memos
WHERE kind = 'prediction'
  AND meta.resolved_at >= $cutoff_a
  AND meta.resolved_at <  $cutoff_b;

-- 3. The most recent prior-week meta-narrative per domain (for sustained-drift
--    tracking — see §6.6 rule emission rule).
SELECT meta.domain AS domain, meta.brier AS brier, meta.drift AS drift
FROM memos
WHERE kind = 'reasoning'
  AND meta.dimension = 'calibration'
  AND meta.from_signal = 'meta_cognition'
  AND derived_at >= time::now() - 21d
ORDER BY derived_at DESC;
```

(All three queries fail-soft. If any returns `[]`, that bucket contributes nothing — no crash.)

### 6.3 What it computes (per domain)

```js
const N = preds_this_week.length;
if (N < cfg.meta_narrative_min_samples) skipDomain();         // sparse; skip
const brier =
  preds_this_week.reduce((acc, p) =>
    acc + Math.pow(p.predicted_confidence - (p.correct ? 1 : 0), 2),
  0) / N;
const accuracy = preds_this_week.filter(p => p.correct).length / N;
const mean_confidence = preds_this_week.reduce((s, p) => s + p.predicted_confidence, 0) / N;
const drift = mean_confidence - accuracy;                     // signed
const trend =
  prev_week_brier == null ? 'new' :
  brier - prev_week_brier >  0.05 ? 'worsening' :
  brier - prev_week_brier < -0.05 ? 'improving' : 'flat';
```

`drift > 0` → over-confident (mean confidence higher than observed accuracy). `drift < 0` → under-confident. This is the same drift sign convention `belief()`'s `applyCalibration` uses.

### 6.4 What it writes

One memo per domain meeting `N ≥ meta_narrative_min_samples`:

```js
await store.note(db, embedder, 'reasoning', {
  content:
    `Calibration drift for ${domain} this week: ` +
    `brier=${brier.toFixed(3)}, drift=${drift.toFixed(2)} ` +
    `(mean confidence ${mean_confidence.toFixed(2)} vs accuracy ${accuracy.toFixed(2)}), ` +
    `samples=${N}, trend=${trend} vs prior week (${prev_week_brier?.toFixed(3) ?? 'n/a'}).`,
  derived_by: 'auto',
  scope: 'global',
  meta: {
    dimension:      'calibration',                  // §10 coordination — disjoint from D2
    from_signal:    'meta_cognition',               // shared with D2
    domain,
    brier,
    drift,
    accuracy,
    mean_confidence,
    samples:        N,
    trend,
    week_starting:  weekStartISO(),                 // YYYY-MM-DD of the Sunday at 00:00 local time
                                                     // (matches the cron firing day; ISO date string
                                                     // is timezone-implicit which is fine here — the
                                                     // dedup key only needs to be stable per writer run)
  },
});
```

Notable choices:

- `kind='reasoning'` (already in `MEMO_KIND_REGISTRY`; see `kind-registry.js:39-45`). No registry edit needed — D2 reuses the same kind; both are valid against the existing `meta_schema` (`session_id?` `step?` are both optional). We co-opt `meta.dimension` and `meta.from_signal` as informal — open-enum policy applies.
- `scope='global'`: this is Robin's own reasoning, not the user's data. Belongs in the unscoped pool so recall can find it.
- `derived_by='auto'`: required by `MEMO_KIND_REGISTRY.reasoning`.
- One row per `(domain, week_starting)`. Idempotent if re-run within the same week: dedup by checking an existing row with the same `(meta.dimension, meta.domain, meta.week_starting)` — skip if present (UPSERT-ish; we don't actually need UPSERT, just a `LIMIT 1` check). The probe query:

  ```surql
  SELECT 1
  FROM memos
  WHERE kind = 'reasoning'
    AND meta.dimension = 'calibration'
    AND meta.domain = $domain
    AND meta.week_starting = $week
  LIMIT 1;
  ```

  Run before the `store.note` call; if it returns a row, the writer skips emission for that domain. Cheap (≤ one row, narrow filter on `kind`); the writer's overall fast-path stays a couple of bounded queries.

### 6.5 Drift highlighting (in content)

When `|drift| > cfg.meta_narrative_drift_threshold` (default `0.15`), prepend a clause to `content` to make the memo retrievable on the keyword:

```
Notable calibration drift: ${domain} is trending ${drift > 0 ? 'over-confident' : 'under-confident'}.
${baseContent}
```

Plain text — no markdown — so it shows up cleanly in any consumer that doesn't render markdown.

### 6.6 Rule candidate emission

When `|drift| > cfg.meta_narrative_rule_threshold` (default `0.15`) **and** at least `meta_narrative_rule_min_weeks` (default `2`) consecutive prior weekly memos for this domain also crossed the threshold in the same direction, emit a `rule_candidate`:

```js
await createCandidate(db, {
  content:
    drift > 0
      ? `Soften assertions about ${domain}: over-confident by drift=${drift.toFixed(2)} for ${weeks}+ consecutive weeks.`
      : `Trust assertions about ${domain} more: under-confident by drift=${drift.toFixed(2)} for ${weeks}+ consecutive weeks.`,
  kind: 'behavior',                         // matches D2; the enum on `rule_candidates`
                                            // is ['behavior','profile_update','conflict_warning','reinforce_behavior']
                                            // — 'comm_style' would fail the ASSERT.
  signal_events: [],                        // no events back this; signal is the meta-narrative
  confidence: Math.min(0.9, 0.5 + Math.abs(drift)),
  payload: {
    source: 'meta_cognition_calibration',   // D2 puts the writer-discriminator on `payload.source`;
                                            // D3 follows the same convention. The longer
                                            // 'meta_cognition_calibration' name namespaces the
                                            // calibration writer specifically (vs D2's
                                            // 'meta_cognition' baseline value on the same field).
  },
  meta: {
    dimension: 'calibration',               // reserved D3 value — see §7.4
    domain,
    drift,
    weeks_in_drift: weeks,
  },
});
```

**Shape coordination with D2.**

- `kind`: the `rule_candidates` schema (`0001-init.surql:346`) asserts `kind IN ['behavior', 'profile_update', 'conflict_warning', 'reinforce_behavior']`. `'comm_style'` is NOT a legal value — emitting it would throw the ASSERT on every D3 run. D3 uses `'behavior'` and pushes the writer-discriminator into `payload.source`, matching D2.
- `payload.source`: D2 uses `payload.source = 'meta_cognition'` (string value, on the `payload` column — not on `meta`). D3 uses `payload.source = 'meta_cognition_calibration'` for the same column, keeping the longer name to namespace its specific writer. The discriminator lives on `payload`, never on `meta`. (`meta` is not a declared field on the SCHEMAFULL `rule_candidates` table — writing to it would silently drop the value on a `SCHEMAFULL` row.)
- `signal_events: []`: shared with D2 — both writers signal off the meta-narrative memo, not off raw events.
- `createCandidate` (`system/cognition/dream/candidates.js`) is the shared entrypoint.

The enum is **not** extended for D3 — re-using `'behavior'` with a discriminator avoids touching a deployed `ASSERT` clause on a SCHEMAFULL table.

The `weeks_in_drift` rule is the simplest "sustained" detector that won't trigger on a single noisy week. Two-week threshold means the earliest rule_candidate fires three weeks after the writer starts running. Open question §11 covers tightening / loosening this.

### 6.7 Telemetry

Per-run row in `cadence_telemetry` (existing table; reusing because the writer is dream-adjacent in lifecycle):

```js
{
  step: 'meta-cal-narrative',
  ts: now,
  tokens_in: 0,
  tokens_out: 0,
  duration_ms: <elapsed>,
  success: true,
  error: null,
}
```

No LLM tokens — fields stay zero. Indexes (`ct_step_ts`, `ct_ts`) already exist. `step` value `meta-cal-narrative` is intentionally distinct from D2's `meta-recall-narrative` so the dashboards in `show_step_health` separate them.

## Section 7 — Schema

### 7.1 Migration

`system/data/db/migrations/0019-belief-gating.surql`. Slot verification:

| Slot | Owner |
|------|-------|
| 0001-0008 | shipped |
| 0009 | B1 (per-hit reinforcement) — declared in its spec §10 |
| 0010 | A3 (recall eval + MMR) — declared in its spec §6 |
| 0011 | C1 (cadence telemetry) |
| 0012-0014 | D1 (state inference: initial-off, shadow-flip, default-on) — declared in its spec |
| 0015 | B2 (per-hit reinforcement follow-up) |
| 0016 | B2-followup (reinforcement tuning) |
| 0017 | C3 (observability rollups) |
| 0018 | D2 (recall failures meta-cognition) |
| 0019 | **D3 (this spec)** |
| 0020 | C2 (cadence follow-up) |

D3 sits at 0019, directly after D2's 0018. The pre-D3 slot allocation is now stable for this wave; the migration runner is checksum-pinned on already-applied files (per B1 §9.2 step 5), so the slot below 0019 won't shift after merge. If land-order shifts D2 elsewhere, D3 follows (mechanical edit at PR review).

```surql
-- ============================================================================
-- Cognition D3: belief() gating tool config + meta-narrative writer config.
-- Additive only. No table changes; only a runtime config row.
-- ============================================================================

UPSERT runtime:`belief.config` SET value = {
  default_threshold:              0.6,
  soften_floor:                   0.4,
  domain_thresholds:              {},
  relevance_threshold:            0.30,
  confidence_floor:               0.05,
  belief_overfetch_factor:        2.0,
  min_calibration_samples:        5,
  calibration_adjustment_gain:    1.0,
  expected_accuracy_baseline:     0.75,
  domain_entity_types:            ['topic', 'project', 'library'],
  shadow_mode:                    true,
  telemetry_enabled:              true,
  telemetry_sample_rate:          1.0,

  meta_narrative_enabled:         true,
  meta_narrative_min_samples:     5,
  meta_narrative_drift_threshold: 0.15,
  meta_narrative_window_days:     7,
  meta_narrative_rule_threshold:  0.15,
  meta_narrative_rule_min_weeks:  2
};

-- Optional index — speeds the §3.4 meta-narrative override lookup.
-- (kind, derived_at) already supports the WHERE; add meta.domain only if
-- telemetry shows the per-domain filter is a hot path. Deferred.
```

No table-level changes. No `kind` / `meta` shape mutation. No new edges. The migration is the most additive possible — a single runtime row UPSERT, idempotent, reversible (`DELETE runtime:\`belief.config\``).

### 7.2 Why no `belief_log` table

Considered: `belief_log` as a sibling to `recall_log`, with `(query, aggregate, calibrated, recommendation, k_returned, fallback_path, ts)`. **Deferred**, because:

- C3 (`docs/superpowers/specs/2026-05-11-robin-v2-theme-4-observability-design.md` — observability rollups) is where telemetry persistence belongs by-design; D3 should not pre-allocate a table that C3 might define differently.
- For the shadow period we want a log; until C3 lands we use `cadence_telemetry` with a dedicated `step = 'belief.call'` value (zero tokens; only `duration_ms` and `success` matter). This piggy-backs on an indexed table that already exists.

When C3 lands its observability schema, the `belief.call` rows in `cadence_telemetry` are either migrated or left in-place (read-only history). Either is a follow-up — D3 doesn't gate on C3.

**`belief.call` and C3's hot-step rollup.** C3's revised spec adds a hot-side bridge for `step LIKE 'belief.%'` so that `belief.call` rows automatically participate in the cadence-telemetry rollup without C3 having to know about each `belief.*` step name explicitly. From D3's side: `belief.call` rows live in `cadence_telemetry` with `step='belief.call'`; C3's rollup picks them up via the hot-step bridge. Sampling fidelity in the rollup is preserved by writing `meta.sample_rate` on each `belief.call` row (matches `cfg.telemetry_sample_rate` at write time) — C3's rollup multiplies counts by `1/sample_rate` to recover the unbiased rate.

### 7.3 Volume cap on `belief.call` telemetry rows

`cadence_telemetry` is sized for one row per dream step (low-cardinality). `belief()` is agent-invoked and *could* be high-cardinality. To prevent telemetry bloat during the shadow week, cap writes:

- Drop `belief.call` rows when `cfg.telemetry_enabled = false` (default true).
- Sample 1-in-N when shadow off (`cfg.telemetry_sample_rate`, default `1.0` during shadow → drop to `0.1` after flip). Sampling is per-call, deterministic on `hash(query) % N` so identical queries are either always logged or always not.
- Rolling delete: a heartbeat sub-tick (per-day) prunes `belief.call` rows older than 30 days. Implemented as a one-liner in the existing `cadence-consumer.js` tick. (Or, simpler: add `step = 'belief.call'` to the cadence retention sweep if one exists; if not, defer until C3 lands its policy.)

These caps keep `cadence_telemetry` from outgrowing its current shape under heavy `belief()` usage.

### 7.4 Kind-registry coordination

D2 (sibling) and D3 (this) both write `kind='reasoning'` memos. Both rely on `meta.dimension` to namespace.

**Reserved `meta.dimension` values for `kind='reasoning'` memos.**

| Value | Owner | Purpose |
|-------|-------|---------|
| `recall_failures` | D2 | Weekly summary of failed recall events (recall harness misses, agent self-correction loops). |
| `calibration`     | D3 (this spec) | Weekly per-domain calibration drift summary. |

Future `kind='reasoning'` writers **must not** reuse either value for a different purpose. Each new writer claims a new `meta.dimension` string. D2's spec (`2026-05-11-cognition-d2-recall-failures-meta-cognition-design.md`) mirrors this table — both specs treat it as canonical and cross-link.

**Reserved `meta.from_signal` values for `kind='reasoning'` memos.**

| Value | Owners | Purpose |
|-------|--------|---------|
| `meta_cognition` | D2, D3 | The shared family of weekly meta-cognition writers. Any new writer joining this family (a third weekly `reasoning` writer summarising some other faculty's drift) uses the same `from_signal` and adds a new `meta.dimension` to disambiguate. |

`from_signal` is *not* a discriminator — it's a family tag. The discriminator is `meta.dimension`. Future non-meta-cognition `reasoning` writers (e.g. a session-level reasoning trace from a tool-use loop) MUST use a different `from_signal` (e.g., `'tool_trace'`), not `meta_cognition`. Both D2 and D3 specs treat this table as canonical and cross-link.

`kind-registry.js`'s `reasoning` entry (`kind-registry.js:39-45`) currently lists `session_id?` and `step?` as optional meta keys. Neither D2 nor D3 conflicts; both add new informal keys (`dimension`, `from_signal`, `domain`, `brier`, `drift`, `samples`, `week_starting`, `accuracy`, `mean_confidence`, `trend`). Open-enum policy applies — the validator (`validateMemoKind`) is keyed on `required` and the declared `meta_schema`, both of which remain satisfied.

**Coordination rule**: when adding a new `meta.dimension` value here or in D2 (or in any future `kind='reasoning'` writer), both specs must update this table to keep the listing canonical. No code change required — purely documentary.

`meta_schema` extension on `kind-registry.js`. D3's own migration `0019-belief-gating.surql` declares the optional `meta` keys it uses directly — D3 does not depend on D2 landing first. If both ship in the same wave, the registry-side `meta_schema` extension (declaring `dimension?`, `from_signal?`, `domain?`, `brier?`, `drift?`, `samples?`, `week_starting?` for type-checker friendliness) is captured in whichever migration runs first. Open-enum tolerance means both writers remain valid even if neither migration extends the schema explicitly.

## Section 8 — Test plan

### 8.1 Unit tests

`system/tests/unit/belief-aggregate.test.js` (new):

1. **Aggregate math.** Three hits with `derived = [0.9, 0.6, 0.3]` and structural weight `signal_count × decay × relevance = [0.5, 0.3, 0.2]` (already normalised — sum=1). Expect `aggregate = 0.5×0.9 + 0.3×0.6 + 0.2×0.3 = 0.69` (within 1e-6).
2. **All-zero weights (divide-by-zero guard).** Every hit is superseded (supersedes_count > 0 → `decay = 0`). `Σ weight_raw = 0`. Expect `aggregate = 0`, `recommendation = 'unknown'`, `fallback_path = 'no_hits'` (collapsed per §2.3). No NaN in the payload.
3. **Relevance filter drop.** Hits at `dist ∈ [0.5, 0.7, 0.85]` (cosine `[0.5, 0.3, 0.15]`); `relevance_threshold = 0.30`. Two pass, one dropped; `meta.hits_dropped_relevance = 1`.
4. **All hits below relevance.** Every hit `dist > 1 - relevance_threshold`. Expect `aggregate = 0`, `recommendation = 'unknown'`, `fallback_path = 'all_below_relevance'`.
5. **Confidence floor drop.** A hit with `derived_confidence = 0.02` is dropped before aggregation when `confidence_floor = 0.05`. v1 keeps the meta payload narrow: confidence-floor drops are folded into `meta.hits_dropped_relevance` (the catch-all "dropped during the pre-aggregation pass" counter); only `hits_dropped_private` stays separate (privacy is the boundary-relevant counter — see §2.5). Test asserts the drop is counted *and* the hit does not appear in `evidence[]`; does **not** assert separate attribution.
6. **Empty hits.** `searchMemos` returns `[]`. Expect `k_returned = 0`, `recommendation = 'unknown'`, `fallback_path = 'no_hits'`, `aggregate_confidence = 0`.

`system/tests/unit/belief-calibration.test.js` (new):

7. **Calibration adjustment.** `aggregate = 0.75`, `cal.drift = 0.15` (over-confident), `gain = 1.0` → `calibrated = 0.60`. Then with `drift = -0.10` → `calibrated = 0.85`. Clamp test: `drift = 0.90` (extreme), `aggregate = 0.5` → `calibrated = 0` (clamped).
8. **Calibration absent.** `readCalibration` returns null. Expect `calibrated = aggregate`, output `calibration` key omitted.
9. **Calibration below `min_calibration_samples`.** `samples_count = 3`, `min = 5`. Expect `calibrated = aggregate`, calibration object still returned (so the agent can see *why* no adjustment fired).
10. **Recommendation thresholds.** `calibrated ∈ {0.30, 0.39, 0.40, 0.41, 0.59, 0.60, 0.61}` with default config → `['unknown', 'unknown', 'unknown', 'soften', 'soften', 'assert', 'assert']`. (Boundaries: `≤ soften_floor` is `unknown`; `≥ default_threshold` is `assert`.)
11. **Domain-specific threshold.** `cfg.domain_thresholds = { photography: 0.55 }`. `calibrated = 0.56`, `domain = 'photography'` → `assert`. Same input with `domain = null` (default `0.6`) → `soften`.
12. **Cross-kind aggregate when domain absent.** Two `by_kind` entries; `readCalibration(null)` returns the union with weighted accuracy.

`system/tests/unit/belief-privacy.test.js` (new):

13. **Direct private drop.** Hit's scope is `'private'`. Dropped; `meta.hits_dropped_private = 1`. Other hits aggregated normally.
14. **Transitive private drop.** Hit's `<-derived_from<-memos` includes a `scope='private'` memo. Dropped via transitive arrow path. Same counter.
15. **All hits private.** Expect `fallback_path = 'all_private'`, `recommendation = 'unknown'`.

`system/tests/unit/belief-domain.test.js` (new):

16. **Domain inference miss.** Query `"f-stop of the GFX 100 II"` against catalog containing only `{name: 'photography', type: 'topic'}` — no overlap between catalog name tokens (`{photography}`) and query tokens (`{f-stop, of, the, gfx, 100, ii}`). Assert: inferred `domain = null`; `meta.domain_inferred = 'none'`.
17. **Domain from catalog match (positive).** Catalog has `{name: 'GFX', type: 'topic'}`; query "specs of the GFX 100" → inferred `domain = 'gfx'`. Asserts case-insensitive lowering.
18. **Multiple matches → ambiguous.** Catalog has both `{name: 'photography'}` and `{name: 'fujifilm'}` with type `topic`; query mentions both. Inferred `domain = null`, `meta.domain_inferred = 'ambiguous'`.
19. **Explicit domain wins.** Caller passes `domain = 'photography'` while query would have inferred `null`. Final `domain = 'photography'`.

`system/tests/unit/meta-cal-narrative.test.js` (new):

20. **Empty week.** No resolved predictions in the past 7d. Writer no-ops (no row written); `cadence_telemetry` row with `success: true` and a metadata note (`error: 'no_samples'` is *not* set — success path with zero work).
21. **Single domain, well-calibrated.** 10 resolved predictions, accuracy = mean_confidence = 0.7. `drift ≈ 0`. Writer emits one memo with `meta.trend = 'new'`, no rule_candidate (drift < 0.15).
22. **Sustained over-confidence.** Three consecutive weeks of `drift > 0.15` for `domain='api versions'`. Writer emits the third memo *and* a rule_candidate with `kind='behavior'` and `payload.source='meta_cognition_calibration'`, `meta.weeks_in_drift = 3`. Asserts: only one rule_candidate per domain per run (no double-emit), and that `kind='behavior'` passes the `rule_candidates.kind` ASSERT (would throw on `'comm_style'`).
23. **Mixed domains.** Two domains in the week — one over-confident, one under-confident, one with `< min_samples` (skipped). Writer emits two memos. Each has the right `drift` sign.
24. **Idempotence within a week.** Run twice in the same week. Second run finds the existing `(domain, week_starting)` row and skips. No duplicate writes.

### 8.2 Integration tests

`system/tests/integration/belief-tool.test.js` (new):

25. **End-to-end happy path.** Seed three knowledge memos about "photography" with varying confidences and freshnesses. Call the MCP tool. Assert: returns the expected shape, `recommendation` matches §2.6 rule, `meta.elapsed_ms` set, `meta.shadow = true` (shadow default).
26. **Private memo filtered.** Mix a `scope='private'` memo into the seed. Assert: it does not appear in `evidence[]`; `meta.hits_dropped_private = 1`.
27. **Calibration round-trip.** Seed `persona:singleton.calibration = { by_kind: { photography: { resolved: 10, correct: 6, accuracy: 0.6 } } }`. Call `belief({query: 'photography stuff', domain: 'photography'})`. Assert: `calibration.drift = 0.15` (with default baseline `0.75`); `calibrated < aggregate`.
28. **Meta-narrative override path.** Seed both `persona.calibration` and a recent `kind='reasoning', meta.dimension='calibration', meta.domain='photography'` memo with `meta.drift = -0.05`. Call `belief({domain: 'photography'})`. Assert: `calibration.source = 'meta_narrative'`, `calibration.drift = -0.05` (memo wins over persona).
29. **Shadow mode override.** With `shadow_mode = true`, `aggregate = 0.85`, calibration absent. Assert: `recommendation = 'unknown'` (overridden); but the payload also includes `meta.shadow_recommendation_would_have_been = 'assert'` (so we can dashboard the would-be distribution).
30. **Recall harness compatibility.** A3's eval harness reads `recall_log`; `belief()` writes `recall_log` (it goes through `searchMemos`, which writes telemetry via the intuition path? — **No**: `belief()`'s recall path does **not** write `recall_log`; that's specific to `intuitionEndpoint`. Verify by asserting zero new `recall_log` rows after a `belief()` call. This is intentional — `belief()` is intent-bearing, not part of the reranker training surface.)

`system/tests/integration/meta-cal-narrative-loop.test.js` (new):

31. **Writer + reader round-trip.** Seed resolved predictions for `domain='photography'`. Run the writer. Then call `belief({domain: 'photography'})` and assert `calibration.source = 'meta_narrative'`.
32. **D2/D3 disjoint dimensions.** Run both writers in the same test (D2 writes one `recall_failures` memo, D3 writes one `calibration` memo). Assert: both memos exist, neither overwrites the other, `meta.dimension` is the namespacing field.

### 8.3 Regression / verification gates

33. **Recall not regressed by `belief()`.** A3's recall eval harness (`system/runtime/scripts/recall-eval.js`, per A3 §6) is run before and after D3 lands; expected: no change in P95 / quality. (The harness exists; D3 only requires it to be runnable in CI — A3 owns the addition.)
34. **`verify-design-assumptions.js` gate.** New gate: under `shadow_mode = true`, the persisted `recommendation` value on every dashboard sample row is `'unknown'`. Catches accidental flag flips.
35. **Audit: `belief()` has no untrusted write keywords.** Same audit Theme 4 runs on `explain_*` tools — `system/tests/unit/audit-introspection-readonly.test.js` — extended to cover `belief.js`. (Strictly, `belief()` writes `cadence_telemetry` for its per-call log; the audit must allow that single table and forbid the rest. Add `cadence_telemetry` to the audit's allow-list when the writer is `belief.js` or `weekly-calibration-narrative.js`.)

## Section 9 — Rollout

Three-stage ship. Each step is reversible.

### 9.1 Migration land

Land `0019-belief-gating.surql` with `shadow_mode = true`. Land `belief.js`, `meta-cal-narrative.js`, the new tool wiring (§10). No agent-side instructions yet. The MCP tool is callable manually (`claude-mcp call robin-mcp belief --query="..."`); the agent does not know to consult it.

### 9.2 Shadow-mode dogfood

One week minimum. Watch:

- **Distribution of would-be recommendations.** `cadence_telemetry` rows under `step='belief.call'` plus the in-payload `meta.shadow_recommendation_would_have_been` tell us how often we'd say `assert`/`soften`/`unknown`. Healthy: majority `assert` on common queries (Robin generally knows what it knows), a non-trivial minority `soften` (the gating point), low `unknown` outside zero-hit cases.
- **Privacy filter rate.** `meta.hits_dropped_private` should match the rate of private-scope memos in the user's data (rough sanity check — non-zero only if user has private memos at all).
- **Latency.** P95 < 100ms. Anything higher → investigate the freshness/derived_confidence batched lookups.

### 9.3 Flip to active mode

`UPDATE runtime:\`belief.config\` SET value.shadow_mode = false;`. Same tick, update `AGENTS.md` to recommend `belief()` as a soften-check before high-confidence assertions:

```md
Before asserting a fact with high confidence — especially in domains where you've been corrected before — call `belief({query, domain?})`. If `recommendation === 'soften'`, hedge the assertion ("I think…", "as far as I recall…"). If `'unknown'`, ask before claiming.
```

**Note on `AGENTS.md` modification.** The repo CLAUDE.md flags AGENTS.md as part of the package skeleton — generic, not Kevin-specific. The doc-only change to recommend a tool is generic; the wording above is portable across hosts (Claude Code, Gemini CLI) and doesn't bake in any user-specific behavior. Safe to modify.

Rollback: `UPDATE runtime:\`belief.config\` SET value.shadow_mode = true;` and revert the `AGENTS.md` paragraph. The tool stays callable; the agent stops being told to consult it.

### 9.4 Meta-narrative writer enablement

The writer's `enabled: true` ships in §6.1's job manifest, so it starts running on the next Sunday after land. To delay, manually set `runtime:\`belief.config\`.value.meta_narrative_enabled = false`. The writer reads that flag and no-ops when false. Rule-candidate emission is independently gated by `meta_narrative_rule_threshold` and `_min_weeks`; set either to `Infinity` (or a high value) to silence rule emission while keeping the memos.

### 9.5 Coordinated rollout with D2

If D2 lands the same week, sequence:

1. Both migrations (0018 D2, 0019 D3) land in the same wave.
2. Both writers enabled in shadow / off mode initially.
3. First Sunday: D2 writes at 05:00 local time, D3 at 05:30 local time. No collision.
4. Watch one week. If both look healthy, flip `shadow_mode` and add the AGENTS.md paragraph in one PR.

## Section 10 — File-by-file changes

**Created:**

- `system/data/db/migrations/0019-belief-gating.surql` — runtime row seed (§7.1). No table mutations.
- `system/cognition/memory/belief.js` — pure functions: `aggregate(hits, derivedMap, structuralMap, cfg)` (where `structuralMap` carries `{ signal_count, decay, supersedes_count }` per id; the function applies `decay = 0` for supersedes-positive rows), `applyCalibration(agg, cal, cfg)`, `recommend(calibrated, domain, cfg)`, `inferDomain(query, catalog, cfg)`. No DB imports.
- `system/cognition/memory/belief-config.js` — `readBeliefConfig(db)`, 5s in-process cache; defaults baked in (mirrors `readEvidenceConfig` shape).
- `system/io/mcp/tools/belief.js` — MCP tool factory `createBeliefTool({ db, embedder, catalog })`. Wires recall → filter → aggregate → calibrate → recommend → respond. Shadow override applied here.
- `system/cognition/jobs/internal/weekly-calibration-narrative.js` — the §6 writer.
- `system/cognition/jobs/builtin/weekly-calibration-narrative.md` — job manifest (§6.1).
- `system/tests/unit/belief-aggregate.test.js` — §8.1 #1-6.
- `system/tests/unit/belief-calibration.test.js` — §8.1 #7-12.
- `system/tests/unit/belief-privacy.test.js` — §8.1 #13-15.
- `system/tests/unit/belief-domain.test.js` — §8.1 #16-19.
- `system/tests/unit/meta-cal-narrative.test.js` — §8.1 #20-24.
- `system/tests/integration/belief-tool.test.js` — §8.2 #25-30.
- `system/tests/integration/meta-cal-narrative-loop.test.js` — §8.2 #31-32.

**Modified:**

- `system/runtime/daemon/tools.js`:
  - Import `createBeliefTool`.
  - Push `createBeliefTool({ db: ctx.db, embedder: ctx.embedder.wrap, catalog: ctx.catalog })` into the read-only tools block (next to `createExplainRecallTool` / `createExplainBeliefTool`). **R-3 coordination**: D3 lands *after* R-3, so the new tool is added to `tools.js` (not `server.js`). If land-order shifts (D3 ahead of R-3), the tool is added to `server.js`'s pre-R-3 push instead — single-line change either way.
  - **`ctx.catalog` does not yet exist** on R-3's `ctx` shape (see runtime-hardening §5.2). Either (a) A2 has already grown `ctx.catalog` by D3 land time (preferred — they're in the same wave), or (b) D3 reads the catalog inline via `getCatalog(db)` (slightly more allocation per call). Pick (a) if A2 lands first; pick (b) otherwise. Documented as a single-line conditional in `belief.js`.
- `system/cognition/jobs/builtin/` — adds the new `.md` manifest only; `loader.js` discovers it automatically.
- `docs/architecture.md`:
  - Add a bullet under "Evolution layer (alpha.16)" describing the `belief()` tool.
  - Add the meta-narrative writer to the "A typical agent turn" section under a new step 10: "Weekly Sunday 05:30 local time, `weekly-calibration-narrative` summarises per-domain calibration drift as a `kind='reasoning'` memo".
- `docs/faculties.md`:
  - Extend the `foresight` section to mention that calibration output now also feeds the `belief()` MCP tool and the weekly meta-narrative writer.
  - Add a new sub-section "belief (alpha.17, Cognition D3)" between `evidence` and `cadence`.
- `AGENTS.md`:
  - Add a one-paragraph section "Soften gating with `belief()`" (the §9.3 wording). Doc-only. Generic across hosts.

**Coordination touches (no D3 code change required):**

- `system/cognition/memory/kind-registry.js` — optional `meta_schema` extension on `reasoning` (`dimension?`, `from_signal?`, `domain?`, etc., per §7.4). D3 does **not** depend on D2 landing first for this — D3's own migration `0019-belief-gating.surql` declares the optional keys it uses inline. If D2 lands first and extends the registry, D3 inherits; if D3 lands first, the registry extension happens in `0019` (or D2's later migration, whichever ships first). Open-enum tolerance covers either order.
- `system/runtime/daemon/tools.js` — verify the `tools.js` site reflects R-3's final layout at merge time. If R-3 redrew the layout, port D3's push to the new structure (one-line change).

## Section 11 — Open questions

- **Per-claim calibration.** Domain-level drift is coarse. A future improvement would label individual assertions (post-hoc, via correction events) and use them as per-claim ground truth. Requires an LLM judge in the loop — costs need to be measured against the value. Deferred.
- **Calibration adjustment shape.** Linear with a clamp (current) vs sigmoid vs piecewise. Run six months and inspect the `(aggregate − calibrated)` distribution before changing.
- **Belief-in-recall.** Currently `belief()` and `intuition` are independent. A future variant might surface `aggregate_confidence` per hit in the `<!-- relevant memory -->` block ("[event 2026-05-10] X (Robin is 64% confident on this domain)"). Hold for one shadow week before considering — agent legibility might suffer.
- **Multi-domain queries.** A query that spans two domains (e.g. "photography software on macOS") gets `domain_inferred = 'ambiguous'` today. Could weight per-domain thresholds by token overlap. Defer until telemetry says this is a common path.
- **Eval harness coverage.** A3 evaluates recall; nothing evaluates `belief()` end-to-end. Adding a "would the recommendation match a human's read?" labeling pass is a follow-up — requires hand-labeled samples or an LLM judge.
- **`weeks_in_drift` window.** Two weeks default; might be too eager. Tighten to three after a quarter if rule-candidates from this path are noisy.
- **Persistence of `belief.call` rows in `cadence_telemetry`.** Until C3 lands a dedicated observability schema, the `belief.call` step in `cadence_telemetry` is the dashboard. When C3 lands, decide: migrate, leave, or purge.
- **D2 slot.** This spec pins D3 at migration `0019`; D2 is pinned at `0018`. If land-order changes D2's slot, D3 follows to the next free slot (mechanical).
- **Half-life constants shared with `fn::freshness`.** §2.3 computes `decay` in JS using the same half-life table `fn::freshness` uses server-side. Today the half-life values live inside `0001-init.surql` — duplicating them in JS introduces drift risk if either side changes without the other. Extract to a shared `system/cognition/memory/half-life-constants.js` (referenced from JS, and from the server-side function via a build-time include if SurrealDB supports it; otherwise documented as a "change both together" rule). Out of scope for D3 itself; tracked here so the bookkeeping doesn't get lost.

## Section 12 — Sequencing

Land order within D3, given R-3 ships first:

1. Migration `0019-belief-gating.surql` (additive runtime row only).
2. `belief.js` + `belief-config.js` + unit tests (§8.1 #1-19). Pure functions; no MCP wiring yet.
3. `belief.js` MCP factory in `system/io/mcp/tools/`. Add to `tools.js`. Integration tests (§8.2 #25-30) pass. `shadow_mode = true` still — agent doesn't know to call it.
4. `weekly-calibration-narrative.js` + manifest + unit tests (§8.1 #20-24). Writer runs on the next Sunday automatically; idempotent.
5. Integration tests for the writer (§8.2 #31-32) + audit extension (§8.3 #35).
6. One-week shadow dogfood (§9.2).
7. `shadow_mode = false` + `AGENTS.md` paragraph (§9.3).
8. Watch one more week; tune `default_threshold` / `domain_thresholds` per telemetry.

If D2 ships in parallel, steps 1-5 happen in lockstep, step 6 covers both writers, step 7 ships both AGENTS.md paragraphs in one PR.

## See also

- `2026-05-11-cognition-d2-recall-failures-meta-cognition-design.md` — sibling spec; shared `reasoning`/`meta_cognition` namespace, disjoint `meta.dimension` values.
- `2026-05-11-cognition-a3-recall-eval-and-mmr-design.md` — A1/A2/A3 recall pipeline `belief()` consumes via `searchMemos`; A3 eval harness must not regress on D3 land.
- `2026-05-11-runtime-layer-hardening-design.md` — Phase R-3 routes/tools split; D3 wires the MCP tool through `tools.js`.
- `2026-05-11-robin-v2-theme-2a-evidence-ledger-design.md` — `evidence_ledger` + `fn::derived_confidence` (the per-hit confidence `belief()` aggregates).
- `2026-05-11-robin-v2-theme-3-cognition-cadence-design.md` — `cadence_telemetry` reused for `belief.call` and `meta-cal-narrative` step rows.
- `2026-05-11-robin-v2-theme-4-observability-design.md` — context for the future `belief_log` table (deferred to C3).
- `system/cognition/dream/step-calibration.js` — current calibration writer; D3 reads its output.
- `system/cognition/memory/foresight.js` — `computeCalibration`; the brier feedstock.
- `system/cognition/memory/evidence.js` — `fn::derived_confidence` invocation pattern; D3 reuses.
- `system/cognition/discretion/outbound-policy.js` — private-scope filter pattern reused inline by `belief()`.
