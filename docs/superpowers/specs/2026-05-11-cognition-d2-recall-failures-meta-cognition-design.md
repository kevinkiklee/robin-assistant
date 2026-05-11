# Robin v2 — Cognition D2: Meta-cognition over recall failures

**Status:** Design (working draft; impl waits for B1's `used` field + B1's `attribution.mode` to settle in production)
**Date:** 2026-05-11
**Umbrella:** `2026-05-11-robin-v2-evolution-roadmap.md` (post-alpha.16, "Cognition D" track)
**Depends on:**
- `2026-05-11-cognition-b1-per-hit-reinforcement-design.md` — `recall_log.ranked_hits[].used` flag, `recall_log.attribution.mode`.
- `2026-05-11-robin-v2-theme-2a-evidence-ledger-design.md` — refute path (`corrected` rows already write refutes; D2 only reads).
- `2026-05-11-robin-v2-theme-3-cognition-cadence-design.md` — D2 lives *outside* the trigger queue (internal job, not trigger-eligible); cost framing borrows the same vocabulary.

## Why

Robin already learns from corrections at *two* time-scales:

1. **5 minutes** — `reinforcement.js` flips `recall_log.outcome` to `corrected` and writes a `dream_triggers` row that the cadence loop drains into a `step-reflection` run within minutes (Theme 3).
2. **Nightly** — `step-reflection` (`system/cognition/dream/step-reflection.js`) clusters correction events from the last 30 days by embedding similarity and proposes `rule_candidates` of `kind='behavior'`.

Both passes ask "what did the user correct?". Neither asks "**what did Robin *recall* in the corrected turn, and is that pattern recurring across many turns?**". The information sits in `recall_log.ranked_hits` (which memos were injected before each corrected reply) and — post-B1 — in `recall_log.ranked_hits[].used` (which of those memos actually got cited or paraphrased). Today nothing reads it.

Concretely, the recurring failure mode looks like this: Robin is asked about Kevin's photo-tools project; recall surfaces a stale memo about a different photography toolkit; the agent acts on it; Kevin corrects. Two weeks later the same stale memo surfaces, the agent acts on it again, Kevin corrects again. `step-reflection` *might* cluster the two correction events if their text rhymes — but the correction events themselves don't carry which memos triggered them. The signal "this memo is poison to recall" is one join away and structurally unreachable from `step-reflection`'s current inputs.

D2 closes that loop. A weekly LLM pass over the recent `recall_log` history asks: "in the last 7 days of recall failures, which *retrieved* memos cluster around which topics, and what should the agent do differently?" The output is a `kind='reasoning'` memo summarising the patterns plus one or more `rule_candidates` with `payload.source = 'meta_cognition'` that the existing approval workflow (`system/cognition/memory/rules.js`) already handles.

This is the *meta* in meta-cognition: Robin reflects on its own recall behavior, not on the user's corrections in isolation. The two reflection mechanisms are complementary — `step-reflection` clusters by what the user said; D2 clusters by what *Robin* surfaced and got wrong about. They produce candidates with distinct provenance and the approval workflow keeps them separate.

## Goals

- Periodic (weekly) LLM analysis of `recall_log` rows where the agent's recall demonstrably failed: `outcome='corrected'`, and — post-B1 — rows with `ranked_hits[*].used = false` (hits that were injected but unused, a softer signal of "recall surfaced noise").
- Output: one `kind='reasoning'` memo per analysis run, plus 1–N `rule_candidates` of `kind='behavior'` carrying `payload.source = 'meta_cognition'`.
- In-Node clustering (zero LLM tokens) before the single bounded LLM call: by `about` edge endpoints across retrieved memos, with `meta.from` (intuition vs mcp_recall) as a coarse fallback.
- Cost envelope: one `tier:'fast'` LLM call per week, gated by a min-corrections threshold. Skip the run entirely if the signal is below threshold.
- Privacy: never analyse rows that touch `private`-scope memos, transitively (mirror `outbound-policy.js:checkOutboundScope`). Never emit a memo whose evidence chain touches private scope.
- Zero new write paths into existing tables. New surfaces: `meta_cognition_telemetry` (Section 11; storage shape defers to C3) and `runtime:\`meta_cognition.config\``.

## Non-goals

- **Real-time meta-cognition.** D2 is weekly. The 5-minute reflection trigger (Theme 3) already exists for fresh corrections. D2 looks at *patterns* across a week — that's a different time-scale and a different output shape.
- **A new rule-candidate kind.** `rule_candidates.kind` is already constrained to `['behavior', 'profile_update', 'conflict_warning', 'reinforce_behavior']` (`0001-init.surql:345-346`). D2's candidates are `kind='behavior'` with provenance recorded in `payload.source`. Adding a new enum value would force a migration for a distinction the approval UI can already render from the payload.
- **Auto-applying rules.** D2 only proposes. The existing `rule_candidates` approval workflow (`listCandidates` / `updateCandidateStatus` in `candidates.js`) is the human gate; D2 produces inputs to it.
- **Replacing `step-reflection`.** Both producers continue to write `rule_candidates`. Their `signal_events` arrays and `payload.source` discriminator let the dedup pass (`findOverlappingPendingCandidate`) keep each producer's stream separate. See §6.
- **A reranker.** D2 reads `recall_log` for pattern-level summaries, not for per-hit labels. The reranker training data lives in the same table but is consumed by the (still-future) reranker pipeline; D2 doesn't move the needle on that work.
- **Backfilling reasoning memos for past corrections.** D2 starts producing at the first weekly fire after rollout. No historical sweep.

## Anchoring decisions

**Why weekly, not on-trigger:**

Theme 3's cadence loop is purpose-built for "an event landed → run reflection in 5 min." It's correct for `step-reflection` because *one* correction event is enough signal to consider proposing a rule. D2's input is fundamentally a *distribution* over many recall failures — what changes between two runs of the analysis is the *shape* of recurring patterns, which doesn't shift meaningfully turn-to-turn. Running it on every correction would burn tokens on noise; running it nightly would compete with the dream pipeline's budget for marginal incremental value over weekly. Weekly is the natural cadence: it lets a full work-week of correction patterns accumulate, gives recurring failures time to recur, and falls on Sunday when token budgets are otherwise idle. Trigger-eligibility (`runtime:\`cadence.config\``) is deliberately *not* added — see §1 for the cron-vs-trigger reasoning.

**Why a `kind='reasoning'` memo as the primary artefact, not "just rule_candidates":**

`rule_candidates` are atomic ("here's one rule"). The interesting thing about a meta-cognition pass is the *narrative*: "across this week, recall about photography projects keeps pulling in a stale memo about a different project; the underlying error is X; the proposed mitigations are A, B, C." That narrative is a memo (durable, queryable, surfaceable at recall). The rules are derived from it. Storing only the rules loses the explanation; storing only the memo loses the actionable hooks. We write both, with `lineage` on the rule_candidates pointing back at the reasoning memo so the approval UI can render "here's *why* this rule was proposed." `kind='reasoning'` is already registered (`kind-registry.js` lines 39-44) so this is a writer-activation, not a new kind.

**Why in-Node clustering (zero LLM tokens) for the pre-pass:**

D2's input ceiling is up to one week of corrected rows. At an order-of-magnitude estimate (10 corrections/day = 70/week worst case at sustained heavy use), each carrying up to `k=6` memo hits, that's ~420 memo-hit instances. Asking an LLM to cluster them would be a non-trivial cost and would hide the clustering criterion. Counting `about` edge endpoints across the retrieved memos is cheap (one SELECT per `about` edge bucket, capped at the top-3 clusters), deterministic, and — crucially — produces clusters whose *identity* (the shared entities or topics) is interpretable in the prompt. The LLM then only does what it's irreducibly good at: pattern naming and rule writing.

**Why post-B1 `used=false` rows are a secondary input, not the primary:**

A `used=false` hit means the agent saw the memo in its context but didn't use it. That's a recall-quality signal (the memo wasn't useful enough to mention) — *not* a recall-failure signal. False is the agent's quiet rejection; `corrected` is the user's loud one. Both are interesting, but at different weights. The §3 cluster-counting weighs `corrected` rows higher than `used=false` rows (default 3×) so the LLM input isn't dominated by the larger but lower-information signal. The two-source design is also forward-compatible: if B1 hasn't shipped at D2 time, the `used=false` query is empty and the pass runs on `corrected` rows alone.

**Why a fresh `kind='reasoning'` memo per run, not append-to-prior:**

Each weekly run is a snapshot. Reading "week of 2026-05-04: top error was X; week of 2026-05-11: top error has shifted to Y" is more informative than maintaining one perpetual document. The supersedes/freshness machinery applies normally: rerunning the analysis with a similar conclusion next week emits a *new* memo; if the pattern is genuinely resolved, the next run's memo will state that and the old one decays naturally (half-life: §9). No `supersedes` edge is emitted automatically — weekly summaries are temporally distinct facts, not corrections of each other.

**Why the recall-failures analysis lives in `cognition/jobs/internal`, not `cognition/dream`:**

Two reasons. First, the dream pipeline (`step-knowledge → step-habits → ...`) runs nightly as a single token-budgeted unit; adding a weekly-only step would force every consumer of `dream/pipeline.js` to special-case it. Second, internal jobs are already the right abstraction for "scheduled work that reads/writes the DB and emits telemetry" (e.g., `reinforce-recall.js`, `log-rotate.js`). The internal-job runner handles scheduling via cron expressions, timeout enforcement, and audit (§1.3). The job *internally* calls one LLM through the runtime daemon's host (the same `host.invokeLLM` interface `step-reflection.js` uses), but the orchestration shell is the internal-job pattern.

## Section 1 — Cadence and the internal job

### 1.1 Schedule

`0 5 * * 0` — every Sunday at 05:00 *local* time (cron's standard semantics; the existing parser, `system/cognition/jobs/cron.js`, evaluates against `Date#getDay()` which is local). 05:00 Sunday is the trough of Robin's activity envelope: nightly dream has finished (~04:00 + jitter), heartbeat-driven syncs are at minimum, no human is mid-session. The choice mirrors the existing `daily-briefing.md` slot pattern (07:00 daily) — a fixed-hour internal job at a quiet time.

`@weekly` would also work (it expands to `0 0 * * 0`, midnight Sunday) but 00:00 collides with the nightly dream rollover on instances whose dream cron is `0 0 * * *` rather than `0 4 * * *`. Pick 05:00 to give dream a full hour even with worst-case overrun. The schedule is tunable via the job manifest — see §1.3 — so an instance with a non-default dream slot can re-tune.

### 1.2 Min-corrections threshold gate

Before doing anything else the job runs the gate query:

```surql
-- Count distinct corrected recall_log rows in the trailing 7 days.
SELECT count() AS n FROM recall_log
  WHERE outcome = 'corrected'
    AND ts > time::now() - 7d
  GROUP ALL;
```

If `n < runtime:\`meta_cognition.config\`.value.min_corrections_threshold` (default `5`), the job exits with `{ran:false, reason:'below_threshold', corrected_count:n}` and emits one `meta_cognition_telemetry` row with `outcome='skipped_below_threshold'`. No memo, no rule_candidates, zero LLM tokens.

Threshold rationale: 5 corrections in a week is the smallest sample size at which "three clusters of two each" is even *conceptually* possible. Below that, anything the LLM produces is overfit to a tiny sample, and the prompt would be padded with low-signal context. The threshold is tunable; on a quiet week the right answer is "skip", not "produce a weakly-grounded memo."

### 1.3 Job manifest

`system/cognition/jobs/builtin/meta-cognition.md`:

```yaml
---
name: meta-cognition
schedule: "0 5 * * 0"
runtime: internal
enabled: false                       # ship dark; enable per-instance after rollout (§13)
catch_up: false                      # if the Sunday tick is missed, wait for next Sunday
timeout_minutes: 5                   # LLM call + clustering + writes
notify: none
notify_on_failure: true
manually_runnable: true
description: Weekly meta-cognition pass over recall failures (kind='reasoning' memo + rule_candidates).
---

Internal job. Implementation in `cognition/jobs/internal/meta-cognition.js`. Reads `recall_log` rows from the trailing 7 days where `outcome='corrected'` (primary) and `ranked_hits[*].used CONTAINS false` (secondary, post-B1). Clusters retrieved memos by shared `about` edges in-Node; calls one `tier:'fast'` LLM to name the error patterns and suggest behavior rules. Writes a `kind='reasoning'` memo summarising the run plus one `rule_candidates` row per suggested rule with `payload.source='meta_cognition'`. Gated by `runtime:\`meta_cognition.enabled\`` and the min-corrections threshold (default 5/week).
```

`enabled: false` matches the existing dark-launch pattern (`daily-briefing.md` ships with `enabled: false` too). Operator flips it after rollout.

### 1.4 Internal job entrypoint

`system/cognition/jobs/internal/meta-cognition.js` — single default export, same shape as `reinforce-recall.js`:

```js
import { runMetaCognition } from '../../meta-cognition/run.js';

export default async function metaCognition({ db, embedder, host }) {
  const summary = await runMetaCognition({ db, embedder, host });
  return JSON.stringify(summary);
}
```

The runtime job wrapper provides `db`, `embedder`, and `host` (which exposes `host.invokeLLM(messages, opts)` — the same interface `step-reflection.js` uses). Returning a JSON string mirrors `log-rotate.js`'s pattern; runtime audit logs capture it.

The actual orchestration logic lives in a peer module (`system/cognition/meta-cognition/run.js`) so the internal-job file stays a 5-line shim. `meta-cognition/` becomes a small faculty directory alongside `dream/`, `intuition/`, etc.; rationale in §10.

## Section 2 — Configuration

`runtime:\`meta_cognition.config\`` — singleton runtime row, seeded by the §13 migration, read once per job invocation (no per-row hit):

```json
{
  "enabled": false,
  "min_corrections_threshold": 5,
  "lookback_days": 7,
  "max_corrected_rows": 200,
  "max_unused_rows": 200,
  "top_k_clusters": 3,
  "min_cluster_size": 2,
  "unused_signal_weight": 0.33,
  "tier": "fast",
  "max_tokens_in": 3000,
  "max_tokens_out": 1200,
  "max_rules_per_run": 3,
  "weekly_token_budget": 6000,
  "private_scope_action": "drop",
  "reasoning_memo_scope": "global"
}
```

Field meanings:

- `enabled` — three-valued flag: `false` (default; job exits immediately), `'shadow'` (job runs clustering + telemetry but skips LLM and writes), `true` (full path). Same shape as D1's `runtime:\`state_inference.config\`.value.enabled` and intentionally mirrors it so the rollout sequence (§13) is identical.
- `min_corrections_threshold` — §1.2.
- `lookback_days` — window for the corrected-rows and unused-hits SELECTs. 7 matches the weekly cadence; tunable for backfill experiments.
- `max_corrected_rows` / `max_unused_rows` — caps on each input SELECT. Defaults of 200 fit the 3000-token input budget at ~15 tokens per row of summary. Exceeding the cap triggers a deterministic sample-by-recency truncation (§3.1).
- `top_k_clusters` — clusters fed to the LLM (default 3). Matches the spec's "pick top-3 clusters" requirement and keeps the prompt bounded.
- `min_cluster_size` — clusters smaller than this are dropped before LLM input. A 1-row "cluster" is just a single failure; not pattern-worthy.
- `unused_signal_weight` — secondary-input downweight in cluster counting (§3.2). 0.33 means three `used=false` hits weigh as much as one `corrected` row.
- `tier`, `max_tokens_in`, `max_tokens_out` — LLM bounds; `fast` keeps cost in proportion to weekly cadence. `max_tokens_in` is the prompt size budget (clustering output is truncated to fit); `max_tokens_out` caps the response.
- `max_rules_per_run` — even if the LLM proposes more, only the top-N by confidence land as rule_candidates. Bounds the approval queue.
- `weekly_token_budget` — read-only cost cap; if the run is on track to exceed it (rare, but possible if the LLM streams beyond `max_tokens_out`), the job aborts and writes a telemetry row.
- `private_scope_action` — `'drop'` (default — exclude rows touching private scope from input) or `'fail'` (refuse to run and emit telemetry). See §7.
- `reasoning_memo_scope` — scope for the output memo. Default `'global'`. If any input row touched private scope but wasn't dropped (e.g., `private_scope_action='fail'` was overridden manually), this would be the place to set `'private'`; under the default `'drop'` policy the output is always grounded only in non-private evidence.

Cached for the lifetime of one job invocation. Tunable without code change.

## Section 3 — Pipeline

`runMetaCognition({ db, embedder, host })` is the top-level orchestrator. Pseudocode (the actual code structure mirrors `step-reflection.js`'s shape):

```
config = readMetaCognitionConfig(db)                       # §2; one query
if config.enabled === false:
  emit_telemetry({outcome: 'skipped_disabled'}); return {ran:false}

# §1.2: min-corrections threshold gate.
corrected_count = countCorrectedInWindow(db, config.lookback_days)  # 1 query
if corrected_count < config.min_corrections_threshold:
  emit_telemetry({outcome: 'skipped_below_threshold', corrected_count})
  return {ran:false, reason:'below_threshold', corrected_count}

# §3.1: input gathering.
corrected_rows = selectCorrectedRows(db, config)           # 1 query
unused_rows    = selectUnusedHitRows(db, config)           # 1 query, may be empty pre-B1
input_rows     = mergeAndDedupRows(corrected_rows, unused_rows)

# §3.1 again: privacy gate. Drops rows whose ranked_hits transitively touch private.
clean_rows, dropped_private = filterPrivateScopeRows(db, input_rows, config)

# §3.1c: hydrate ranked_hits → memo rows + about-edge endpoints.
hydrated = hydrateRetrievedMemos(db, clean_rows)           # 2 queries (memos + edges)

# §3.2: in-Node clustering — zero LLM tokens.
clusters = clusterByAboutEndpoints(hydrated, config)       # pure JS

if clusters.length === 0:
  emit_telemetry({outcome: 'no_clusters', rows: clean_rows.length, dropped_private})
  return {ran:false, reason:'no_clusters'}

if config.enabled === 'shadow':
  # No LLM call, no writes. Telemetry only.
  emit_telemetry({outcome: 'shadow_complete', rows: clean_rows.length, clusters: clusters.length, dropped_private})
  return {ran:false, reason:'shadow_mode', cluster_count: clusters.length}

# §3.3: single LLM call.
llm_response = await host.invokeLLM(
  buildMessages(clusters, config),                         # 1 system + 1 user
  { tier: config.tier, json: true, system: [{...META_COG_SYSTEM, cache_control:{type:'ephemeral'}}] },
)
parsed = parseLLMResponse(llm_response, config)            # JSON shape: §3.3

# §3.4: write outputs.
reasoning_memo = await writeReasoningMemo(db, embedder, parsed, clean_rows, config)
candidate_ids  = await writeRuleCandidates(db, parsed, reasoning_memo, clean_rows, config)

emit_telemetry({
  outcome: 'complete',
  rows: clean_rows.length, dropped_private,
  clusters: clusters.length,
  rules_proposed: candidate_ids.length,
  tokens_in: llm_response.usage.input_tokens,
  tokens_out: llm_response.usage.output_tokens,
})
return {ran:true, reasoning_memo_id: reasoning_memo.id, rules: candidate_ids.length}
```

Every branch emits exactly one telemetry row. The shape is `{outcome, rows, dropped_private, clusters, rules_proposed, tokens_in, tokens_out, duration_ms, error?}` — telemetry table shape in §11.

### 3.1 — Input gathering

**Primary query — corrected rows.** Indexed by `recall_log_outcome` (existing) and `recall_log_ts` (existing). Hits the index even at scale.

```surql
SELECT id, ts, session_id, query, ranked_hits, attribution, meta
FROM recall_log
WHERE outcome = 'corrected'
  AND ts > time::now() - duration::from::days($lookback)
ORDER BY ts DESC
LIMIT $cap;
```

Parameters: `$lookback = config.lookback_days`, `$cap = config.max_corrected_rows`. Ordering by `ts DESC` makes the cap a deterministic "most-recent N" truncation.

**Secondary query — unused-hit rows (post-B1).** Reads rows where any `ranked_hits[].used` is false. The `attribution.mode != 'corrected'` clause excludes rows already in the primary query (B1 sets `attribution.mode='corrected'` as a short-circuit before the §3 attribution pipeline runs — `b1-design.md` §3 pseudocode). It also excludes the legacy `attribution.mode='off'` rows where `used` is meaningless.

```surql
SELECT id, ts, session_id, query, ranked_hits, attribution, meta
FROM recall_log
WHERE ts > time::now() - duration::from::days($lookback)
  AND attribution.mode != 'corrected'
  AND attribution.mode != 'off'
  AND ranked_hits[*].used CONTAINS false
ORDER BY ts DESC
LIMIT $cap;
```

`ranked_hits[*].used CONTAINS false` is the SurrealQL array-projection idiom for "at least one element matches"; verified against v3.0.5 syntax. Pre-B1 (no `used` field on `ranked_hits[]`), the projection yields an empty list and the `CONTAINS` is false on every row — secondary query is empty by construction until B1 lands, so D2 degrades cleanly to corrected-only mode.

**Merge + dedup.** A row appearing in both queries (rare — B1 short-circuits `corrected` before computing `used`, so this should be empty, but the spec is defensive) is kept once with the corrected-row signal-weight (1.0 in §3.2). Dedup by `recall_log.id`.

**Privacy filter.** For every row in the merged set, every memo referenced by `ranked_hits[*].record` is checked: is the memo itself `scope='private'`? Is the memo `derived_from` a `private`-scope memo? The check mirrors `outbound-policy.js:checkOutboundScope` (lines 78–128) exactly. We *batch* the check:

```surql
-- One SELECT for direct private-scope memos in the union of all ranked_hits records.
SELECT id FROM memos WHERE id IN $all_memo_ids AND scope = 'private';

-- One SELECT for memos grounded transitively in private evidence.
-- Arrow direction: `derived_from`'s registry is `in:[memos], out:[events,episodes,memos,entities]`.
-- For a memo M, M -[derived_from]-> X means X is the *source* M was derived from. So
-- `->derived_from->memos[WHERE scope='private']` walks from M outward to find any
-- upstream private-scope memo. (This is the inverse arrow of outbound-policy.js's
-- `<-derived_from<-memos[…]`, which queries events asking "what memos are derived
-- from this event"; we're querying memos asking "what is this memo derived from".)
SELECT id FROM memos
WHERE id IN $all_memo_ids
  AND count(->derived_from->memos[WHERE scope = 'private']) > 0;
```

`$all_memo_ids` is the union of every memo id in every row's `ranked_hits[]`. If a row's set intersects the union of the two query results, that *row* is dropped from the analysis (not just the offending hit — once an evidence chain is contaminated we can't safely surface conclusions grounded in any of its hits). Telemetry counter: `dropped_private`.

The transitive check covers one hop. A deeper chain (M derives_from X derives_from Y[private]) would not be caught. This matches `outbound-policy.js`'s one-hop closure — Robin's lineage chains in practice are shallow (biographer-derived memos have one parent event; dream-derived memos have a small set of source memos and events). If a deeper-chain leak is observed in telemetry, replace the one-hop count with a depth-bounded traversal (`->derived_from->memos{1..5}[WHERE scope='private']`). Documented in §12 as a privacy precision question.

`private_scope_action='fail'` reverses the policy: any privacy hit aborts the run. Useful for instances where a privacy hit indicates an unexpected lineage and operator wants a hard stop. Default `'drop'` is the right policy because Kevin's normal use *will* mix scopes within a session.

### 3.1c — Hydrating `ranked_hits` to memos + about-edges

`ranked_hits[].record` is a record ref (`memos:xyz` or `events:abc`). For clustering we need each *memo* hit's `about` edge endpoints (the entities the memo is "about"). Event hits are skipped at this stage — events don't carry `about` edges in the v2 substrate; their topical grouping happens at the memo-derivation layer.

```surql
-- Memos hit in the analysis batch — content and meta for the prompt later.
SELECT id, content, kind, scope, meta FROM memos WHERE id IN $memo_ids;

-- About-edge endpoints: for each retrieved memo, which entities does it index?
SELECT in, out FROM edges WHERE kind = 'about' AND in IN $memo_ids;
```

Two queries per run regardless of input size. Build:

- `memoById: Map<id_str, {content, kind, scope, meta}>`
- `aboutByMemoId: Map<id_str, string[]>` (list of entity record ids)

This is the same hydration shape `_surfaceSearch` uses internally; reusing the idiom keeps the query shape recognisable.

### 3.2 — In-Node clustering

The clustering criterion is **shared `about` endpoints across retrieved memos in failure rows**. Concretely:

```
entityScore = Map<entity_id, float>  // weighted count of failure-row touches

for each row in input_rows:
  weight = (row.outcome === 'corrected') ? 1.0 : config.unused_signal_weight
  // row.outcome here is the recall_log outcome; for the unused-hits secondary
  // query we use weight `unused_signal_weight` regardless of recall_log.outcome.

  touched = new Set()
  for each hit in row.ranked_hits where hit.kind === 'memo' (or hit.record startsWith 'memos:'):
    for each entity_id in aboutByMemoId.get(String(hit.record)) ?? []:
      touched.add(entity_id)
  for each entity_id in touched:
    entityScore.set(entity_id, (entityScore.get(entity_id) ?? 0) + weight)

// Build clusters: each top entity becomes a cluster of the failure rows that touched it.
top = topNByScore(entityScore, config.top_k_clusters)
clusters = []
for each entity_id in top:
  member_rows = input_rows.filter(row touches entity_id)
  if member_rows.length < config.min_cluster_size: continue
  clusters.push({
    entity_id,
    entity_name: lookupEntityName(entity_id),
    score: entityScore.get(entity_id),
    rows: member_rows.slice(0, 10),     // up to 10 rows per cluster for the prompt
    memos: dedupRetrievedMemosForRows(member_rows),  // ≤ 5 representative memos
  })
```

A row that touches *multiple* top entities lands in each of their clusters. Acceptable — the LLM prompt sees one cluster per topic; redundancy is contained by the per-cluster row cap of 10.

**Fallback grouping by `meta.from`.** If `entityScore` is empty after the pass (no retrieved memos had `about` edges — unusual but possible for memo kinds that don't get biographed, e.g., older `kind='knowledge'` memos written before the entity-extraction loop matured), fall back to grouping by `recall_log.meta.from`:

```
if clusters.length === 0:
  by_surface = group input_rows by row.meta?.from ?? 'unknown'  // 'intuition' | 'mcp_recall' | 'unknown'
  clusters = [for each (surface, rows) where rows.length >= min_cluster_size: {
    surface, rows: rows.slice(0, 10), memos: ...
  }]
```

This keeps the pipeline producing *something* even when the topical signal is too diffuse to cluster. The LLM prompt template branches on `cluster.entity_id` vs `cluster.surface` to phrase the question correctly. If even the fallback is empty (no `min_cluster_size`-sized buckets), the run exits with `outcome='no_clusters'` and writes no memo — see §3 pseudocode.

`lookupEntityName(entity_id)` is one extra `SELECT name FROM entities WHERE id IN $ids` for the top-3 entity ids — one query per run.

### 3.3 — Single LLM call

System prompt (added to `system/cognition/dream/prompts.js` — the shared prompts module):

```js
export const META_COGNITION_SYSTEM = `You analyze patterns in Robin's recall failures.

You will see clusters of recall events where Robin retrieved memos that led to a user correction (or surfaced memos the agent didn't use). Each cluster groups failure events by a shared topic (an entity Robin's memos are "about") or by surface (intuition vs MCP recall).

For each cluster, output:
- error_pattern: one sentence naming what Robin got wrong (not what the user said — what Robin's recall surfaced incorrectly).
- suggested_rules: 0–3 rule strings, second person, behavioral, one sentence each. Empty array if the cluster is too thin to support a confident rule.
- rule_confidence: number in [0,1] per rule (parallel array to suggested_rules).

Output JSON only:
{
  "narrative": string,            // 2–4 sentence summary across all clusters (becomes the reasoning memo body)
  "clusters": [
    {
      "cluster_id": string,                 // echoes the input cluster identifier (entity_id or surface)
      "error_pattern": string,
      "suggested_rules": string[],
      "rule_confidence": number[]
    }
  ]
}

Rules:
- Be conservative. If a cluster has only 2–3 rows and the failures rhyme by coincidence, output suggested_rules: [].
- Distinguish "the memo content was wrong" (the underlying fact is stale) from "the memo was right but irrelevant" (recall surfaced it inappropriately) from "the agent acted on the right memo but in the wrong way" (this is upstream of recall — out of scope here).
- Rules should be actionable in recall ranking or in agent behavior. Avoid rules that require new infrastructure (e.g. "build a classifier").
- Never invent a cluster the input didn't contain.
`;
```

User prompt (templated):

```
Week of {week_starting}. {n_corrected} corrected rows + {n_unused} unused-hit rows in the trailing 7 days. {n_clusters} clusters below (top-{top_k_clusters} by failure-weighted touch count).

---
Cluster 1: {entity_name or 'surface=' + surface_name} (score: {score})
Rows in this cluster:
  - {row.ts} | query: "{row.query.slice(0,120)}" | retrieved: [{row.retrieved_summary}]
  - ...
Representative retrieved memos:
  - [memo {memo.kind} {memo.derived_at}] {memo.content.slice(0,200)}
  - ...

---
Cluster 2: ...
```

`row.retrieved_summary` is a flattened list of the retrieved memo ids' short content fragments (≤ 30 chars each). The whole prompt is built greedily up to `config.max_tokens_in` tokens; if a cluster overflows it's truncated to fewer rows (down to `min_cluster_size`) before being dropped entirely. The dropped-cluster count is telemetry.

Call shape — same as `step-reflection.js` lines 109–119:

```js
const r = await host.invokeLLM(
  [{ role: 'user', content: userPrompt }],
  {
    tier: config.tier,        // 'fast'
    json: true,
    system: [{
      role: 'system',
      content: META_COGNITION_SYSTEM,
      cache_control: { type: 'ephemeral' },
    }],
  },
);
const parsed = JSON.parse(r.content);
```

Parse-failure handling mirrors `step-reflection.js` lines 121–123: on JSON parse error, the run records `outcome='llm_parse_error'` in telemetry and exits without writing memo or rule_candidates. No retry — the next weekly tick is the natural retry.

### 3.4 — Writes

**One `kind='reasoning'` memo per run.** Via `store.note`:

```js
const memoResult = await note(db, embedder, 'reasoning', {
  content: parsed.narrative,
  scope: config.reasoning_memo_scope,           // 'global' by default
  derived_by: 'meta_cognition',                 // memos.derived_by is open string (0001-init.surql:82)
  subjects: cluster_entity_ids,                 // entity ids from §3.2 (top-k cluster entities). [] if §3.2 fell back to surface grouping.
  lineage: [],                                  // see note below — no `derived_from` edges to recall_log
  meta: {
    dimension: 'recall_failures',
    from_signal: 'meta_cognition',
    period: 'weekly',
    signal_count: clean_rows.length,
    week_starting: new Date(Date.now() - config.lookback_days * 86400_000).toISOString().slice(0, 10),
    clusters: parsed.clusters.length,
    recall_log_ids: clean_rows.map((r) => String(r.id)),   // provenance — see below
  },
});
```

**Lineage encoding: `meta.recall_log_ids`, not `derived_from` edges.** `edge-registry.js` constrains `derived_from` to `out: ['events', 'episodes', 'memos', 'entities']` (verified at `edge-registry.js:27-30`). `recall_log` is intentionally absent — it's a behavioral-telemetry table, not a substrate node. Widening the registry to include `recall_log` would set a precedent that any telemetry table can hang off the substrate, which conflicts with the redesign's "events/memos/entities are the substrate" principle. The cleaner choice is to encode the provenance as `meta.recall_log_ids` (an array of stringified `recall_log:*` ids); a downstream consumer (the approval UI, an `explain_reasoning` introspection tool) reads `meta.recall_log_ids` and runs its own SELECT to hydrate. Edge-based traversal is not needed for D2's use cases. (`derived_from`'s graph-reachability story is preserved for substrate-to-substrate lineage where it actually matters — memos derived from events, memos derived from earlier memos.)

**Hydration round-trip.** `String(r.id)` produces strings like `"recall_log:abc"` — full table-qualified textual ids. SurrealDB will **not** auto-coerce those strings to `RecordId` references when binding to `WHERE id IN $ids`. Consumers must reconstruct record refs client-side before binding. Two equivalent options:

```js
// Option A — type::thing in surql:
db.query(surql`SELECT * FROM recall_log WHERE id IN ${ids.map((s) => {
  const [tbl, key] = s.split(':');
  return new RecordId(tbl, key);
})}`);

// Option B — string split + RecordId at the JS layer:
const refs = ids.map((s) => {
  const [tbl, key] = s.split(':');
  return new RecordId(tbl, key);
});
db.query(surql`SELECT * FROM recall_log WHERE id IN ${refs}`);
```

Either path produces typed record refs that the engine recognises. Plain strings in `$ids` will silently miss every row.

Subject edges (`about`) point the reasoning memo at the entities the failure clusters were about. This *is* graph-reachable: a downstream recall query about `<entity>` could surface the reasoning memo via §5's recall-surfacing path. The asymmetry is deliberate — subjects are substrate (entities), lineage is telemetry (recall_log).

**One `rule_candidates` row per suggested rule.** Via `createCandidate`:

```js
for (const cluster of parsed.clusters) {
  for (let i = 0; i < Math.min(cluster.suggested_rules.length, remaining_rule_budget); i++) {
    await createCandidate(db, {
      content: cluster.suggested_rules[i],
      kind: 'behavior',                           // existing enum value
      signal_events: [],                          // no events back this; recall_log isn't `events`
      confidence: clamp01(cluster.rule_confidence[i] ?? 0.7),
      payload: {
        source: 'meta_cognition',                 // discriminator — distinguishes from step-reflection
        cluster_id: cluster.cluster_id,
        reasoning_memo_id: String(memoResult.id),
        week_starting: meta.week_starting,
      },
    });
  }
}
```

`signal_events` stays empty because `recall_log` rows are not `events`. The `rule_candidates.signal_events` field is `array<record<events>>` (`0001-init.surql:349`); we can't put `recall_log:abc` in there. The provenance lives in `payload.cluster_id` + `payload.reasoning_memo_id` so the approval UI (whenever it ships) can chase from candidate → memo → recall_log lineage. See §6 for the dedup interplay with `findOverlappingPendingCandidate`, which today keys on `signal_events`.

**`max_rules_per_run` enforcement.** `remaining_rule_budget` starts at `config.max_rules_per_run` and decrements per write. The LLM is asked to confidence-rank its suggestions; we keep the top-N by descending `rule_confidence`. Discarded suggestions are recorded in telemetry as `rules_dropped_over_cap`.

## Section 4 — `reasoning` kind: writer activation, not new schema

`MEMO_KIND_REGISTRY.reasoning` is already defined (`kind-registry.js` lines 39–44):

```js
reasoning: {
  required: ['content', 'derived_by'],
  meta_schema: {
    session_id: 'string?',
    step: 'string?',
  },
},
```

D2 needs `meta_schema` to also tolerate `dimension`, `from_signal`, `period`, `signal_count`, `week_starting`, `clusters`. The registry's `validateMemoKind` treats *known* meta keys with declared types; *unknown* meta keys pass through silently (no per-key strictness in the validator at `kind-registry.js` line 81–95 — it only iterates `Object.entries(spec.meta_schema)`, checking presence and type, but doesn't reject extra keys). So `period`/`signal_count`/etc. are passed through without registry changes.

For cleanliness, we *extend* the `meta_schema` entry so the conventional keys are documented:

```js
reasoning: {
  required: ['content', 'derived_by'],
  meta_schema: {
    session_id: 'string?',           // legacy from existing registry — kept for back-compat
    step: 'string?',                 // legacy
    dimension: 'string?',            // 'recall_failures' (D2), future others — see reserved values below
    from_signal: 'string?',          // 'meta_cognition' for D2; future producers can pick their own
    period: 'string?',               // 'weekly', future 'daily'/'monthly'
    signal_count: 'number?',
    week_starting: 'string?',        // ISO date string
    clusters: 'number?',
  },
},
```

All optional — D2 sets them, hypothetical other reasoning-memo writers (e.g., a future "agent reasoned about action X" capture path) can set a different subset without registry changes. The registry edit is part of the §10 file changes; no migration needed (the table is open-enum and `meta` is `FLEXIBLE`).

**Cross-spec `from_signal` type note.** D1's `state_inference.meta_schema.from_signal` is declared as `'string[]?'` (D1 §"What a state_inference is": `['attention', 'arcs', 'biographer']`). D2's `reasoning.meta_schema.from_signal` is declared as `'string?'` (the single producer name, e.g., `'meta_cognition'`). Same key name, different types — but they live on different `kind` entries in the registry, so the `validateMemoKind` typecheck reads the correct shape for each kind and there's no collision. Consumers that read `meta.from_signal` across kinds (none today, but future introspection tools) must handle both shapes: array for `state_inference`, string for `reasoning`. We deliberately do **not** harmonise the two: D1's array carries genuine multi-source semantics (one inference is fed by multiple sources); D2's string carries a single producer identity. Forcing one shape would either inflate D2's metadata with single-element arrays or collapse D1's multi-source signal into a comma-joined string. Defensive handling at the consumer is the lighter touch.

**Reserved `meta.dimension` values.** Active reservations: `'recall_failures'` (D2, this spec) and `'calibration'` (D3, after revision). Future writers of `kind='reasoning'` MUST NOT use these dimension values for unrelated content. New dimensions are added by extending the comment in this section; the registry itself stays open.

**Half-life: 30 days.** Add to `decay.js`'s `HALF_LIFE_BY_KIND_MS`:

```js
reasoning: 30 * 24 * 60 * 60 * 1000,  // 30d
```

Justification: a weekly recall-failures summary is a "this is what was true *this week*" artefact. After 30 days the freshness contribution should be near-zero (0.5^1 = 0.5 at 30d, 0.5^2 = 0.25 at 60d). The 90-day `DEFAULT_HALF_LIFE_MS` is too long — a 3-month-old summary describes failures that may have been entirely resolved by intervening corrections. The 60-day suggestion in the design brief was reasonable but biases toward keeping stale meta-summaries surfaceable; 30 days matches the weekly-snapshot mental model. If telemetry shows the memos getting deranked too aggressively (e.g., recall surfaces relevant reasoning memos rarely because freshness is already below threshold), the constant can be raised.

Mirror in `0001-init.surql`'s `fn::freshness` half-life table at next migration — same TODO comment as the D1 spec uses (D1 §3.4). Until then, `decay.js` (used by `rank.score`) is the only path; v2's `searchMemos` doesn't call `fn::freshness` server-side, it ranks client-side.

## Section 5 — Recall surfacing

Question: should the freshly-written reasoning memo surface in subsequent recalls?

**Yes — but it requires an inject.js change.** `intuitionEndpoint` currently fans out to `searchEvents` + `searchMemos(kind='knowledge')` via a `Promise.all([recall(...), store.searchMemos(...)])` call in `inject.js`. Only `kind='knowledge'` memos surface via intuition. Without a change, a `kind='reasoning'` memo about a recall pattern would be retrievable via MCP `recall` (any-kind) but invisible to the intuition path.

**Coordination with neighbouring specs.** Three in-flight specs touch the `inject.js` prologue: B2 inserts a conflict-warnings block above the recall fan-out, D1 inserts a focus block (also above the fan-out), and D2 changes the `kind` argument *inside* the `searchMemos` call. The three edits target different structural points and don't conflict, but landing them in arbitrary order can produce small merge churn. The implementer should anchor edits to the `Promise.all` fan-out site and the prologue insertion points respectively, not to absolute line numbers (which will shift as each of B2/D1/D2 lands).

**Why `reasoning` surfaces here but D1's `state_inference` does not.** D1 explicitly keeps `state_inference` *out* of the recall fan-out (D1 §4.6) and instead consumes it as a focus-block primitive. The two kinds have different volume and ownership: `state_inference` is high-volume per source (every heartbeat tick can write one) and is owned by the focus block, where the latest inference is summarised once and inlined as agent context. A `reasoning` memo, by contrast, is **one row per week** — low volume, narrative content, and exactly the shape the agent should be able to recall later when a query lands on the cluster's entity. Surfacing it as a recall-eligible memo is the natural fit; treating it like another focus-block primitive would force the focus block to special-case yet another kind. Hence D2 extends the intuition fan-out where D1 deliberately did not.

The right behavior is for the reasoning memo to surface at recall *like a knowledge memo* — that is the whole point of writing it as a queryable memo. Extend the intuition fan-out to include `kind='reasoning'` (edit the `searchMemos` call inside the `Promise.all([recall(...), store.searchMemos(...)])` fan-out):

```diff
- store.searchMemos(db, embedder, combined, { kind: 'knowledge', limit: k, since })
+ store.searchMemos(db, embedder, combined, { kind: ['knowledge', 'reasoning'], limit: k, since })
```

`searchMemos`'s `opts.kind` currently expects a single string and emits `kind = $kind` in the post-filter SELECT inside `_surfaceSearch`. To accept an array, change the filter construction to:

```diff
- if (surface === 'memos' && opts.kind) {
-   bindings.kind = opts.kind;
-   filters.push('kind = $kind');
- }
+ if (surface === 'memos' && opts.kind) {
+   bindings.kind = opts.kind;
+   filters.push(Array.isArray(opts.kind) ? 'kind IN $kind' : 'kind = $kind');
+ }
```

One line, backward-compatible (string callers unchanged). `_surfaceSearch` is the read primitive; the change ripples to every caller that passes `kind`.

**Internal sites in `store.js` that build a `kind` filter** (audited at design time via `grep -n "kind = \$kind" system/cognition/memory/store.js`):

1. `_surfaceSearch` — the post-filter SELECT after kNN+BM25 fusion (the site the diff above targets).
2. `listMemos` — the lens-facing chronological list path. Same `kind = $kind` shape, same one-line conditional needed.
3. `relate`/`relateAll` — the edge-creation paths use `kind = $kind` to identify the edge kind, **not** a memo kind. Unrelated; leave untouched.

Sites #1 and #2 must both accept array `$kind` for the array-kind contract to hold across the public API of `store.js`. The cleanest implementation is a tiny shared helper:

```js
function kindFilter(kind, bindings) {
  bindings.kind = kind;
  return Array.isArray(kind) ? 'kind IN $kind' : 'kind = $kind';
}
```

`_surfaceSearch` and `listMemos` both call `filters.push(kindFilter(opts.kind, bindings))` instead of duplicating the conditional. Neither of D2's read sites (the inject.js change and any future MCP `recall` extension) will hit BM25 or kNN fragments that need updating — those don't filter on `kind` at the SurrealQL layer (`_bm25Retrieve` doesn't take a `kind` arg; the kNN `WHERE vector <|k,ef|> $qvec` clause has no kind predicate either). The post-filter SELECT is the only place memo `kind` is enforced.

**Citation-tag rendering for `reasoning` memos.** `inject.js:formatHit` (lines 27–33) tags hits as `[episode ...]` only when `meta.kind === 'episode_summary'`, else `[event ...]`. A `reasoning` memo hit will render as `[event YYYY-MM-DD] <content>`. That's the right call — the agent doesn't need a distinct citation tag to use the content. If telemetry later shows the agent over-citing reasoning memos, add `kind === 'reasoning' → [reasoning ...]` and teach B1's citation-attribution to recognise it.

**TRUST_FACTOR for `derived_by='meta_cognition'`.** `rank.js`'s `TRUST_FACTOR` table is keyed by `derived_by` first, `source` second (line 53). `meta_cognition` is not in the table, so it falls through to the default `0.9` (line 54). That's the right starting value — it sits between `dream` (0.9) and `derived` (0.85), matching the intent: a meta-cognition memo is a synthesised summary like a dream-step output, with slightly higher trust than a generic derived memo because the input signal (a week of confirmed corrections) is itself a high-trust feedback channel.

**Add `meta_cognition: 0.9` to TRUST_FACTOR explicitly** — not strictly necessary (the default lands on the same value) but documenting it in the table prevents drift if the default is ever lowered:

```diff
const TRUST_FACTOR = {
  manual: 1.0,
  trusted: 1.0,
  biographer: 0.95,
  dream: 0.9,
  reflection: 0.9,
+ meta_cognition: 0.9,
  ingest: 0.95,
  derived: 0.85,
  action_outcome: 0.85,
  agent: 0.85,
  untrusted: 0.5,
};
```

Listed in the §10 file edits.

## Section 6 — No double-counting with `step-reflection`

Both `step-reflection` (`system/cognition/dream/step-reflection.js`) and D2 produce `rule_candidates` of `kind='behavior'`. The two pipelines differ in input, criterion, and dedup key:

| Producer | Input | Cluster criterion | `signal_events` | `payload.source` (new) |
|---|---|---|---|---|
| `step-reflection` | `events` where `meta.kind='correction'` in last 30d | Single-link cosine over event embeddings (≥ 0.85) | Correction event ids (cluster members) | (unset) |
| D2 (`meta_cognition`) | `recall_log` rows in last 7d (corrected + unused-hit) | Top-3 entities by failure-weighted touch count over retrieved memos' `about` edges | (empty — `recall_log` rows aren't `events`) | `'meta_cognition'` |

**Why these can't double-count today.** `step-reflection`'s `findOverlappingPendingCandidate` (`candidates.js:64-83`) keys on `signal_events` intersection. D2's `signal_events` is always `[]` (recall_log isn't an events ref), so D2's candidates have zero overlap with `step-reflection`'s in the existing dedup pass. They land alongside each other in `rule_candidates`, distinguishable by `payload.source`.

**Why we don't need to teach `findOverlappingPendingCandidate` about `payload.source`.** Two reasons. First, D2's lookback (7d) is shorter than step-reflection's (30d), so even if both producers eventually proposed semantically identical rules, the human approval workflow is the right deduplication layer — a "duplicate" rule from D2 with a different cluster id is informative ("the pattern is recurring at week-1 cadence AND at month-1 cadence"). Second, intersecting `signal_events` arrays across producers with disjoint domains (events vs recall_log) is structurally undefined and would silently miss most actual duplicates.

**Future dedup.** If telemetry shows the two producers regularly proposing rules with near-identical content, the right move is to add a *content-similarity* dedup pass to `findOverlappingPendingCandidate` (cosine over `content` text). That's a separable improvement on the approval pipeline, not a D2 surface. Listed as an open question in §12.

**Approval UI rendering.** The MCP introspection tool that will eventually surface pending candidates (Theme 4 successor; not yet specified) reads `payload.source` and renders provenance. For D2 candidates, the chain is `candidate.payload.reasoning_memo_id → memos.meta.recall_log_ids → recall_log.id → recall_log.query`. That four-hop replay is *exactly* the "show me why" view the approval workflow wants. Recommended (but not blocking D2) is adding a `--source` filter to a future `list_candidates` CLI.

**Coordination with D3.** Both D2 and D3 (`meta-cognition-calibration`) write into the same `rule_candidates` table, so the `payload.source` discriminator carries the producer identity for *both*. The current state at design time:

- **D2 (this spec):** `kind = 'behavior'`, `payload.source = 'meta_cognition'`.
- **D3 (after its parallel revision):** `kind = 'behavior'`, `payload.source = 'meta_cognition_calibration'`. (D3's current draft writes `meta.source` — but `rule_candidates` has no `meta` field; and it sets `kind = 'comm_style'` — but the enum is restricted to `['behavior','profile_update','conflict_warning','reinforce_behavior']`. The D3 revision aligns it with the constraints D2 already obeys.)

Both producers use the **same column** (`payload.source`) with **distinct values** for dedup discrimination. `findOverlappingPendingCandidate` continues to key on `signal_events` only; cross-producer convergence is left to the human approval queue (and, eventually, a content-similarity pass — §12).

The matching reservation on the `kind='reasoning'` memos written by each producer is on `meta.dimension`: D2 owns `'recall_failures'`, D3 (after revision) owns `'calibration'`. See §4's "Reserved `meta.dimension` values" note.

## Section 7 — Privacy

The transitive private-scope rule mirrors `outbound-policy.js:checkOutboundScope` (lines 78–128):

1. Direct: any `recall_log.ranked_hits[].record` is a `memos:*` with `scope='private'`.
2. Transitive: any such memo has `->derived_from->memos[WHERE scope='private']` — i.e. walking outbound from the retrieved memo along `derived_from` reaches an upstream private-scope memo. Arrow direction here is the *inverse* of `outbound-policy.js`'s `<-derived_from<-memos[…]`, because that helper interrogates *events* asking "what memos are derived from this event?" while D2 interrogates *memos* asking "what is this memo derived from?". Same registry, same edge, opposite traversal direction — exactly the asymmetry §3.1 already documents.

If either matches for *any* hit in a row, the whole row is excluded from D2's input (under default `private_scope_action='drop'`). The §3.1 batched SELECT does both checks in two queries regardless of row count.

**Why row-level drop, not hit-level drop.** A row's recall failure is a single event in time; we can't safely cluster on partial evidence. If a row's failure is "Robin recalled memo A (private) and memo B (global) and got corrected," we don't know which memo caused the correction. Dropping A leaves B as evidence in a cluster, which would attribute the failure to B alone — wrong. Dropping the whole row keeps the analysis honest.

**Reasoning memo scope.** Default `'global'`. Because *all input rows* survived the privacy filter, the resulting memo's evidence chain (via `derived_from` edges to `recall_log` rows whose `ranked_hits` were all non-private) cannot transitively reach a private-scope memo. The `checkOutboundScope` guard at outbound time would never flag the reasoning memo. This is the same closure property D1's state_inference design relies on (D1 §6).

**Reasoning memo lineage.** Provenance to the source `recall_log` rows is encoded as `meta.recall_log_ids` (an array of stringified `recall_log:*` ids), **not** as `derived_from` edges. `edge-registry.js`'s `derived_from` registry is intentionally restricted to substrate endpoints (`out: ['events','episodes','memos','entities']`) — `recall_log` is behavioral telemetry, not substrate, and the redesign keeps those layers separated (§3.4 lays out the full rationale). Downstream consumers (approval UI replay, `explain_reasoning` introspection) read `meta.recall_log_ids` and hydrate via a SELECT. No `derived_from` edge widening is required and §10 does not include one. Graph-reachability for substrate-to-substrate lineage (memo→event, memo→memo) is preserved untouched.

**Telemetry rows.** `meta_cognition_telemetry` does NOT contain `private`-scope content. It contains counts and outcomes (§11), no row content, no entity names. Safe to surface in `show_step_health` (Theme 4) without redaction.

**Rule candidate content.** The LLM is prompted to write rules that are *behavioral and topical*, not quoting specific memos. The prompt template's "Cluster N" header uses `entity_name` (e.g., "photo-tools") but the body uses memo `content.slice(0, 200)`. If a memo's content contains private-flavoured text — even though its `scope` is `'global'`, content can carry sensitive substrings — that text could leak into the LLM input. The §3.1 private-scope filter is the structural gate; content-level PII scrubbing is out of scope for D2 (would replicate `outbound-policy.js`'s PII patterns; the inbound LLM call to a local-tier model isn't "outbound" in the discretion sense, but if the `tier='fast'` host is a remote provider for a given installation, this matters). Listed in §12 as an open question pending the cross-cutting decision in C3 / Theme 5.

## Section 8 — Cost envelope

Per weekly run (after threshold gate):

- **5 SELECTs at most before LLM call:**
  - 1 × `meta_cognition.config` read
  - 1 × min-corrections gate (`COUNT(*) FROM recall_log WHERE outcome='corrected' AND ts > now-7d`)
  - 1 × corrected-rows fetch (`LIMIT 200`)
  - 1 × unused-rows fetch (`LIMIT 200`; empty pre-B1)
  - 1 × privacy gate (two queries combined into one BoundQuery — direct + transitive)
- **2 SELECTs for hydration:**
  - 1 × memo content/meta (one query for all batched memo ids)
  - 1 × about-edges (one query for all batched memo ids)
  - 0–1 × entity-name lookup for top-3 cluster entity ids
- **1 LLM call:** `tier:'fast'`, ≤ `max_tokens_in` (3000) in + `max_tokens_out` (1200) out. Budget: ~4200 tokens × 1 call/week = ~18K tokens/month. At fast-tier pricing, sub-cent per month.
- **3 writes at most:**
  - 1 × `note(reasoning)` → `memos` CREATE + 1 embedding write + ≤(top_k_clusters) `about` edges (batched via `relateAll`, one round-trip). No `derived_from` edges to `recall_log` — provenance is encoded as `meta.recall_log_ids` per §3.4.
  - 0–3 × `createCandidate` → `rule_candidates` CREATE. One query each.
  - 1 × `meta_cognition_telemetry` write.

**Weekly token budget enforcement.** Defensive cap: if `host.invokeLLM` returns `usage.output_tokens > config.max_tokens_out * 2` (e.g., a misbehaving model streaming past the cap), the run still completes (the response is parsed if valid JSON) but emits `outcome='budget_exceeded'` in telemetry alongside the normal `complete` flow. The fix is then a config tighten, not a code change.

**Cadence config interplay.** D2 is *not* `trigger_eligible` (§Anchoring). The `runtime:\`cadence.config\``.value.daily_token_budget governs trigger-driven steps; D2's `weekly_token_budget` is independent. There's no double-counting because the cadence consumer never dispatches D2. If a future "include all LLM work in a single budget" decision lands (e.g., C3 introduces a unified budget header), D2 plugs into it by reporting `tokens_in + tokens_out` to the same telemetry header `cadence_telemetry` writes to.

**Compared to step-reflection.** `step-reflection.js` does up to *N* LLM calls per dream run (one per cluster of correction events). At 30-day lookback and modest correction volume that's typically 1–5 calls/night = 7–35 calls/week. D2 adds exactly 1 call/week. The marginal cost is small.

**Worst-case scenario.** Sustained 50 corrections/day for a heavy user (Kevin's instance, busy week): 350 corrected rows in 7 days. Capped at 200 input rows by `max_corrected_rows`. Privacy filter drops ~10%. Clustering yields 3 clusters with up to 10 rows each = 30 rows shown in prompt + 5 memos per cluster = ~6KB of prompt text ≈ 1500 tokens. Comfortably within `max_tokens_in=3000`.

## Section 9 — Telemetry

The metrics the design must produce (per task requirement #13):
- `analysis_runs` — count of fires (gated, skipped, completed).
- `clusters_emitted` — per run.
- `suggested_rules_count` — per run.
- `tokens_used` — per run (`tokens_in + tokens_out`).

**Storage:** defers to C3 telemetry-umbrella spec (not yet written). D2 reserves a `meta_cognition_telemetry` table; the table's surql shape lives in D2's migration (§13) and gets folded into the umbrella when C3 lands. The migration is additive and won't conflict because the table name is D2-specific.

Provisional shape (locked-in by D2's migration, ratified by C3):

```surql
DEFINE TABLE meta_cognition_telemetry SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts                  ON meta_cognition_telemetry TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD outcome             ON meta_cognition_telemetry TYPE string;
  -- 'skipped_disabled' | 'skipped_below_threshold' | 'no_clusters'
  -- | 'shadow_complete' | 'complete' | 'llm_parse_error' | 'budget_exceeded' | 'error'
DEFINE FIELD corrected_count     ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD unused_count        ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD rows_after_privacy  ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD dropped_private     ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD clusters            ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD rules_proposed      ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD rules_dropped_over_cap ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD tokens_in           ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD tokens_out          ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD duration_ms         ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD week_starting       ON meta_cognition_telemetry TYPE option<string>;
DEFINE FIELD reasoning_memo_id   ON meta_cognition_telemetry TYPE option<record<memos>>;
DEFINE FIELD error               ON meta_cognition_telemetry TYPE option<string>;
DEFINE INDEX mct_ts              ON meta_cognition_telemetry FIELDS ts;
```

One row per job invocation. `show_step_health` (Theme 4 follow-up) can rollup this table the same way it rolls up `cadence_telemetry`.

**Mapping to the four metrics the task requires:**

| Metric | Query |
|---|---|
| `analysis_runs` | `SELECT count() FROM meta_cognition_telemetry WHERE ts > $since GROUP ALL` |
| `clusters_emitted` | `SELECT math::sum(clusters) FROM meta_cognition_telemetry WHERE ts > $since GROUP ALL` |
| `suggested_rules_count` | `SELECT math::sum(rules_proposed) FROM meta_cognition_telemetry WHERE outcome = 'complete' AND ts > $since GROUP ALL` |
| `tokens_used` | `SELECT math::sum(tokens_in + tokens_out) FROM meta_cognition_telemetry WHERE ts > $since GROUP ALL` |

All four are one-line SurrealQL aggregates. No materialised rollup needed at v1 volume.

## Section 10 — File-by-file changes

**Created:**

- `system/data/db/migrations/0018-meta-cognition.surql` — schema additions: `meta_cognition_telemetry` table + `runtime:\`meta_cognition.config\`` seed row. D2 owns slot `0018` per the cross-spec allocation map in §13.1; verify against the actual `migrations/` directory at land time.
- `system/cognition/meta-cognition/run.js` — `runMetaCognition({db, embedder, host})`. Module-level orchestration; one file.
- `system/cognition/meta-cognition/cluster.js` — pure function `clusterByAboutEndpoints(hydrated, config)`. No DB imports. Exported for unit testing (§11.1).
- `system/cognition/meta-cognition/prompts.js` — `META_COGNITION_SYSTEM` constant + user-prompt builder. Same shape as the dream `prompts.js`. (Alternatively: add `META_COGNITION_SYSTEM` directly to `dream/prompts.js`. The faculty-private file is cleaner; if `dream/prompts.js` grows much further, refactor at C3 time.)
- `system/cognition/meta-cognition/config.js` — `readMetaCognitionConfig(db)`, cached per invocation.
- `system/cognition/jobs/internal/meta-cognition.js` — 5-line shim that imports `runMetaCognition` and exports the internal-job default.
- `system/cognition/jobs/builtin/meta-cognition.md` — job manifest (§1.3).
- `system/tests/unit/meta-cognition-cluster.test.js` — clustering unit tests (§11.1).
- `system/tests/integration/meta-cognition-run.test.js` — full run integration tests (§11.2).
- `system/tests/e2e/meta-cognition-recall.test.js` — output memo surfaces at intuition recall (§11.3).

**Modified:**

- `system/cognition/memory/kind-registry.js`:
  - Extend `MEMO_KIND_REGISTRY.reasoning.meta_schema` to include `dimension`, `from_signal`, `period`, `signal_count`, `week_starting`, `clusters` (all optional). §4.
- `system/cognition/memory/decay.js`:
  - Add `reasoning: 30 * 24 * 60 * 60 * 1000` to `HALF_LIFE_BY_KIND_MS`. §4.
- `system/cognition/intuition/inject.js`:
  - In the `Promise.all([recall(...), store.searchMemos(...)])` fan-out, change the `searchMemos` `opts.kind` from `'knowledge'` to `['knowledge', 'reasoning']`. §5. (Coordinate with B2's conflict-block insertion and D1's focus-block insertion — both edit different points in the same file prologue; see §5's coordination note.)
- `system/cognition/memory/store.js`:
  - Introduce a `kindFilter(opts.kind, bindings)` helper and call it from both `_surfaceSearch`'s post-filter SELECT and `listMemos`'s WHERE-construction so array `opts.kind` works through the public API. §5.
- `system/cognition/intuition/rank.js`:
  - Add `meta_cognition: 0.9` to `TRUST_FACTOR`. §5.
- `system/cognition/dream/prompts.js` (or new `meta-cognition/prompts.js` — see "Created"):
  - Add `META_COGNITION_SYSTEM` system prompt.
- `system/cognition/jobs/runner.js`:
  - No code change required. The runner already imports `internal/<name>.js` (line 19–22). The new manifest is picked up by the manifest loader.
- `docs/faculties.md`:
  - Add `### meta-cognition (alpha.17+, Cognition D2)` faculty entry under "Process faculties" (after `reflection`), summarising input/output/cadence.
- `docs/architecture.md`:
  - Update "A typical agent turn" to add an item 11: "**Meta-cognition** (weekly Sunday 05:00) walks `recall_log` for the last 7 days of failure patterns and emits a `kind='reasoning'` memo plus `rule_candidates`. Skipped when corrections < 5/week."

## Section 11 — Test plan

### 11.1 — Unit tests

`system/tests/unit/meta-cognition-cluster.test.js` (new):

1. **Empty input** — `clusterByAboutEndpoints([], config)` returns `[]`.
2. **No about edges** — input rows whose retrieved memos have no `about` edges. Result: empty clusters (fallback to surface grouping happens in the caller, not in this pure function).
3. **Single dominant entity** — 5 rows all touching the same entity. Returns one cluster with score `5.0` (corrected weight 1.0 each), `rows.length = 5`.
4. **Top-3 cap** — 6 entities each touched by 3 rows. Returns 3 clusters (`top_k_clusters=3`), tied entities broken by entity id stable sort.
5. **Min-cluster-size filter** — `min_cluster_size=2`; entities touched by exactly 1 row are excluded.
6. **Weighted secondary signal** — 4 corrected rows touching entity A; 6 unused-hit rows touching entity B. With `unused_signal_weight=0.33`: A score = 4.0, B score = 1.98. A ranks first.
7. **Row in multiple clusters** — row touches both A and B (its retrieved memos span entity sets). Counted in both clusters.
8. **Per-cluster row cap** — cluster with 20 member rows is truncated to 10 in `cluster.rows`.

`system/tests/unit/meta-cognition-config.test.js` (new):

9. **Default config when row missing** — `readMetaCognitionConfig` with no `runtime:\`meta_cognition.config\`` row returns the defaults.
10. **Partial merge** — runtime row sets only `min_corrections_threshold`; others default.
11. **`enabled: 'shadow'`** — config-shape test: pipeline branches on `enabled === 'shadow'` without writing.

### 11.2 — Integration tests

`system/tests/integration/meta-cognition-run.test.js` (new):

12. **Below threshold short-circuits** — seed 3 `corrected` recall_log rows. `min_corrections_threshold=5`. Run `runMetaCognition`. Assert: returns `{ran:false, reason:'below_threshold'}`. Telemetry row with `outcome='skipped_below_threshold', corrected_count=3`. No memo, no rule_candidates.
13. **Empty clusters → no memo** — seed 5 corrected rows whose retrieved memos have *no* `about` edges and no `meta.from`. Run. Assert: `outcome='no_clusters'`, no memo, no rule_candidates.
14. **Happy path single cluster** — seed 5 corrected rows, all retrieving memos with shared `about` entity E1; mock `host.invokeLLM` to return JSON with one cluster suggesting 2 rules. Run. Assert: one `kind='reasoning'` memo exists with `meta.dimension='recall_failures'`, `meta.signal_count=5`, `meta.recall_log_ids.length === 5`, `about` edge to E1; two `rule_candidates` rows with `kind='behavior'`, `payload.source='meta_cognition'`, `payload.reasoning_memo_id` pointing at the new memo.
15. **`max_rules_per_run` cap** — same setup as #14 but LLM returns 5 rules. With `max_rules_per_run=3`, exactly 3 candidates land. Telemetry `rules_dropped_over_cap=2`.
16. **Private-scope row drop** — seed 5 corrected rows; one row's `ranked_hits[0]` references a `scope='private'` memo. Run with `private_scope_action='drop'`. Assert: input drops to 4 rows; telemetry `dropped_private=1`. If the remaining 4 still cluster, the run proceeds; otherwise `outcome='no_clusters'`.
17. **Private-scope transitive** — seed a corrected row whose ranked memo M is `scope='global'` but `M->derived_from->memos[WHERE scope='private']` returns a non-empty set (M was derived from an upstream private-scope memo). M's row is dropped.
18. **Private-scope fail mode** — same as #16 but `private_scope_action='fail'`. Run aborts with `outcome='error'`, error message `'private_scope_contamination'`. No writes.
19. **B1 not landed (no `used` field)** — seed corrected rows; secondary query for `ranked_hits[*].used CONTAINS false` returns empty. Run proceeds on corrected-only signal. Memo `meta.signal_count` reflects only the corrected rows.
20. **LLM parse error** — mock `host.invokeLLM` to return invalid JSON. Run records `outcome='llm_parse_error'`. No memo, no rule_candidates. Job returns non-throw (audit log gets the JSON string anyway).
21. **Shadow mode** — `enabled='shadow'`. Pipeline runs clustering + telemetry, never calls `host.invokeLLM`, never writes a memo or candidate. Telemetry `outcome='shadow_complete'`.
22. **Idempotence under repeat invocation** — run twice in a row with no new data. The second run sees the same input (no `processed_until` cursor — D2 is "look at the last 7 days" each time). Assert: a *second* reasoning memo is created, and rule_candidates have content overlap with the first run. This is *intended* — weekly snapshots are temporally distinct artefacts (§Anchoring). The dedup happens at human-approval time, not at write time.

### 11.3 — End-to-end

`system/tests/e2e/meta-cognition-recall.test.js` (new):

23. **Recall surfacing** — after a successful run that writes a reasoning memo about entity E1, a subsequent intuition recall with a query mentioning E1 returns the reasoning memo in the `<!-- relevant memory -->` block. Verifies §5's `inject.js` + `store._surfaceSearch` changes.
24. **TRUST_FACTOR application** — same setup; `recall_log.ranked_hits[].score_components.trustFactor === 0.9` for the reasoning-memo hit (assuming `derived_by='meta_cognition'`).
25. **Private outbound block** — if a future caller asked outbound about the reasoning memo via the discretion layer, `checkOutboundScope({refs: [reasoning_memo_id]})` returns `ok:true` (the memo is `scope='global'` and its lineage doesn't reach private). Sanity check on §7's closure claim.

### 11.4 — Verification gates

26. **Schema migration applied** — after `0018-meta-cognition.surql` runs, `meta_cognition_telemetry` table exists with the expected fields; `runtime:\`meta_cognition.config\`` row exists with `enabled: false`.
27. **Internal-job manifest loadable** — the manifest loader picks up `meta-cognition.md`; `jobs/runner.js`'s `internal/<name>.js` import resolves.
28. **No dependency on B1 to compile/run** — the integration test #19 covers runtime; this gate is a compile-time check (the `attribution.mode != 'corrected'` filter in the secondary query is valid SurrealQL against a `recall_log` whose `attribution` field doesn't exist — the WHERE clause yields no rows but doesn't error).

## Section 12 — Open questions

- **Cross-producer dedup on rule_candidates content.** If `step-reflection` and D2 converge on near-identical rule wording (separate `signal_events` but same intent), the approval queue gets a duplicate. Today's `findOverlappingPendingCandidate` keys on `signal_events` intersection only. Fix is a content-similarity pass; out of scope for D2 (it's an approval-pipeline improvement). Listed against the eventual approval-tooling spec.
- **Reasoning memo aging when patterns recur.** A pattern still active next week emits a fresh reasoning memo. No `supersedes` edge is written. The right behavior is debatable: argument for `supersedes` is that the older memo is "stale" once the pattern recurs; argument against is that they're snapshots, not corrections. D2 ships *without* `supersedes` and revisits if the proliferation of reasoning memos becomes a recall-noise issue (telemetry: count active reasoning memos per dimension).
- **PII in LLM input.** §7 notes that memo content may carry sensitive substrings even at `scope='global'`. A pre-LLM PII scrub (mirroring `outbound-patterns.js`) would close this. Pending the cross-cutting decision on whether the `tier:'fast'` host is "outbound" for discretion purposes; see C3 / Theme 5.
- **Privacy-check depth.** §3.1's transitive check is one hop (`->derived_from->memos[WHERE scope='private']`). A deeper chain (M derives_from X derives_from Y[private]) is not caught. Matches `outbound-policy.js`'s one-hop closure. Replace with `{1..5}` traversal if telemetry shows leak (none expected — Robin's lineage chains are shallow today).
- **`unused_signal_weight = 0.33` calibration.** Starting guess. Tune after one month of `enabled=true` telemetry against hand-labelled samples (does dropping unused-hit signal entirely change cluster identity meaningfully? Does raising weight to 0.5 introduce spurious clusters?).
- **Window length.** 7 days is the natural pairing with weekly cadence. A 14-day window catches more recurrence at the cost of higher input volume and noisier clusters. Tunable via `lookback_days`; no plan to change the default in v1.
- **Provenance encoded in `meta`, not edges.** §3.4 chooses `meta.recall_log_ids` over a `derived_from` edge widening. The trade-off: graph traversal from the reasoning memo (`reasoning_memo->derived_from->...`) won't reach the recall_log rows; `meta.recall_log_ids` requires the consumer to issue an extra `SELECT FROM recall_log WHERE id IN $ids` (with `$ids` reconstructed as `RecordId` refs — see §3.4 hydration round-trip note) to hydrate. For D2's known consumers (approval UI replay, `explain_reasoning` introspection), the extra SELECT is fine. If a future faculty wants to do graph-shaped reasoning across reasoning memos and the recall_logs that grounded them, revisit the registry widening then.
- **D2 disabled at install.** §1.3 ships `enabled: false`. The rollout sequence in §13 enables it on Kevin's instance first. Open question: should a fresh install eventually default to `enabled: true`? Decision deferred until one quarter of dogfood telemetry on Kevin's instance.
- **No self-dedup across weeks.** D2 does not deduplicate `rule_candidates` against its own prior-week output. If the same failure pattern persists across two successive Sundays, two near-identical `rule_candidates` rows land — one per run, each with its own `payload.cluster_id` and `payload.reasoning_memo_id`. The approval UI is the human deduper. Listed here because the obvious "just key dedup on `payload.source + content_hash`" extension would let the queue collapse genuinely recurring patterns into a single row, losing the recurrence signal. Revisit only if the approval queue gets noisy enough to warrant it.

## Section 13 — Rollout

Behind `runtime:\`meta_cognition.config\`.value.enabled`. Three-valued: `false` (default) → `'shadow'` → `true`. Mirror of the D1 rollout pattern (`docs/superpowers/specs/2026-05-11-cognition-d1-state-inference-design.md` §9).

### 13.1 — Migration

`system/data/db/migrations/0018-meta-cognition.surql`:

```surql
-- Migration number: 0018, pinned at design time. The full allocation map
-- across the 2026-05-11 cognition-track specs:
--   0001..0008 — shipped (init, embeddings-{384,1024,3584}, evidence-ledger,
--                action-trust-ledger, cadence, compaction, arcs, doctor).
--   0009       — B1 per-hit-reinforcement.
--   0010       — A3 recall-eval-and-mmr.
--   0011       — C1 (recall-config consolidation).
--   0012/0013/0014 — D1 state-inference (initial-off / shadow-flip / default-on).
--   0015       — B2 conflict-surfacing.
--   0016       — B2 follow-up (conflict-surfacing-default-on).
--   0017       — C3 telemetry-umbrella.
--   0018       — D2 meta-cognition (this migration).
--   0019       — D3 meta-cognition-calibration.
--   0020       — C2 dream-dag.
-- Verify against `system/data/db/migrations/` at land time; if a slot below
-- 0018 has been taken by an unlisted spec, renumber here (D2's migration is
-- order-independent — it touches only its own table and runtime row).

DEFINE TABLE meta_cognition_telemetry SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts                  ON meta_cognition_telemetry TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD outcome             ON meta_cognition_telemetry TYPE string;
DEFINE FIELD corrected_count     ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD unused_count        ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD rows_after_privacy  ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD dropped_private     ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD clusters            ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD rules_proposed      ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD rules_dropped_over_cap ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD tokens_in           ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD tokens_out          ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD duration_ms         ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD week_starting       ON meta_cognition_telemetry TYPE option<string>;
DEFINE FIELD reasoning_memo_id   ON meta_cognition_telemetry TYPE option<record<memos>>;
DEFINE FIELD error               ON meta_cognition_telemetry TYPE option<string>;
DEFINE INDEX mct_ts              ON meta_cognition_telemetry FIELDS ts;

-- Seed config — ships disabled. Operator flips to 'shadow' then 'true' per §13.2.
UPSERT runtime:`meta_cognition.config` SET value = {
  enabled: false,
  min_corrections_threshold: 5,
  lookback_days: 7,
  max_corrected_rows: 200,
  max_unused_rows: 200,
  top_k_clusters: 3,
  min_cluster_size: 2,
  unused_signal_weight: 0.33,
  tier: 'fast',
  max_tokens_in: 3000,
  max_tokens_out: 1200,
  max_rules_per_run: 3,
  weekly_token_budget: 6000,
  private_scope_action: 'drop',
  reasoning_memo_scope: 'global'
};
```

Migration is additive — no `recall_log` changes, no `memos` changes, no edges-table changes. Verify-free in the sense that existing `verify-design-assumptions` gates don't have anything to assert (D2 doesn't modify existing flows).

### 13.2 — Sequence

1. **Land migration** `0018-meta-cognition.surql` and the code path (§10 files). `enabled=false` means the job is parked even if `runtime:` were missing — the §3 guard `if config.enabled === false: return` short-circuits. Verified by integration test #21 (shadow) and the `enabled=false` short-circuit (tested implicitly via the job's idempotent no-op behavior; an explicit test "false skips" could be #21b).
2. **Flip to `'shadow'`** on Kevin's instance: `UPDATE runtime:\`meta_cognition.config\` SET value.enabled = 'shadow';`. Watch one week of `meta_cognition_telemetry`. Expected: `outcome='shadow_complete'` weekly, telemetry populated with cluster counts and zero LLM tokens. **Use the shadow week's `corrected_count` to validate the threshold.** If the row records `corrected_count < 5` and the `outcome` is `'skipped_below_threshold'`, the threshold may be permanently above production rate on this instance and the next flip to `true` would never fire — tune `min_corrections_threshold` downward (e.g., to 3) before promoting to `enabled: true`.
3. **Flip to `true`**: `UPDATE runtime:\`meta_cognition.config\` SET value.enabled = true;`. Watch four weekly runs. Expected outcomes: a mix of `complete`, `skipped_below_threshold` (quiet weeks), `no_clusters` (diffuse weeks).
4. **Reasoning-memo recall verification**: after a `complete` run, confirm via `explain_recall` (Theme 4) that the reasoning memo appears at intuition recall for queries about the cluster's entity.
5. **Rule approval**: the approval workflow surfaces D2 candidates. Operator approves or rejects manually; the existing `rules.js` machinery applies them.
6. **Open: default-on for new installs.** Decision deferred per §12.

### 13.3 — Rollback path

Two levers:
- **Disable globally:** `UPDATE runtime:\`meta_cognition.config\` SET value.enabled = false;` — next Sunday tick exits at the first config check. Reasoning memos and rule_candidates already written remain; recall surfacing of reasoning memos continues unless §5's `inject.js` change is reverted.
- **Disable the internal job:** edit `meta-cognition.md` manifest `enabled: false` and reload manifests. The Sunday tick stops firing at all.

The config flag is the lighter-touch lever; the manifest flag is the harder kill switch. Recommend the config flag for rollback unless a downstream bug requires preventing the code path from running at all.

## Section 14 — Sequencing

Land-order (short engineering view):

1. **Migration** `0018-meta-cognition.surql` (additive; seeds `enabled=false`).
2. **`meta-cognition/cluster.js` + unit tests** (§11.1). Pure function; no production behavior change.
3. **`meta-cognition/config.js` + `meta-cognition/prompts.js`**. Still no production behavior change.
4. **`meta-cognition/run.js`** — the orchestrator. Internal job manifest + shim. Integration tests (§11.2).
5. **§5 recall-surfacing changes** — `inject.js` array-kind, `store._surfaceSearch` array-kind, `rank.js` TRUST_FACTOR entry. End-to-end tests (§11.3).
6. **§10 registry/decay edits** — `kind-registry.js` (extend `reasoning.meta_schema`), `decay.js` (add `reasoning` to `HALF_LIFE_BY_KIND_MS`). No `edge-registry.js` changes needed — provenance is encoded as `meta.recall_log_ids` per §3.4.
7. **Docs** — `faculties.md`, `architecture.md` updates.
8. **Shadow flip on Kevin's instance** (§13.2 step 2). One week soak.
9. **Full enable** (§13.2 step 3).

## See also

- `2026-05-11-cognition-b1-per-hit-reinforcement-design.md` — provides the `recall_log.ranked_hits[].used` flag D2 reads in its secondary input. D2 degrades cleanly when B1 hasn't shipped.
- `2026-05-11-cognition-a3-recall-eval-and-mmr-design.md` — reads the same `recall_log` rows for offline evaluation. The two pipelines don't share code but agree on the row shape.
- `2026-05-11-cognition-d1-state-inference-design.md` — same rollout shape (config-flag `enabled: false|'shadow'|true`); D2 follows the pattern.
- `2026-05-11-robin-v2-theme-2a-evidence-ledger-design.md` — `corrected` rows already write refutes to `evidence_ledger`. D2 reads `recall_log` directly, not the ledger; the two paths are independent.
- `2026-05-11-robin-v2-theme-3-cognition-cadence-design.md` — explains why D2 is *not* trigger-eligible (different time-scale, different cost shape).
- `system/cognition/dream/step-reflection.js` — the other rule_candidate producer; D2 sits alongside it, distinguished by `payload.source`.
- `system/cognition/intuition/reinforcement.js` — the producer of the `recall_log.outcome='corrected'` rows D2 consumes.
- `system/cognition/memory/kind-registry.js` — `reasoning` kind registry entry that D2 activates.
