# Robin v2 — Cognition C2: Dream DAG + parallelism

**Status:** Design (working draft)
**Date:** 2026-05-11
**Umbrella:** `2026-05-11-robin-v2-evolution-roadmap.md` (Cognition cost track)
**Depends on:** nothing structural; lands on top of the current dream
pipeline at `system/cognition/dream/pipeline.js`.

## Why

`dreamProcess(db, host, embedder, opts)` in
`system/cognition/dream/pipeline.js` (lines 26–92) runs **ten steps in
strict source order** under independent try/catch blocks: knowledge →
patterns → reflection → confidence → profile → arcs → comm-style →
calibration → scope-cleanup → compaction, then a unified
`dreamed_at` UPDATE and a `runtime:dream` upsert. The order is implicit
in the source text; nothing about the steps themselves says they have to
run sequentially. Several pairs are obviously independent — calibration
reads `foresight` predictions and writes a calibration row, while comm-style
reads communication telemetry and writes `persona.comm_style`; they share
no input, no output, and no on-disk state.

The cost is wall-clock: nightly dream runs serially even when its
constituent steps could safely overlap, and steps that wait on LLM calls
(knowledge, reflection, profile) block steps that don't (confidence,
arcs, scope-cleanup, compaction). For Kevin's instance today the
pipeline is fast enough not to be a daily pain — but the same pattern
underpins the trigger-eligible cadence path
(`docs/faculties.md` §cadence), and the dream pipeline is the canonical
example for "do these LLM-shaped steps fan out concurrently?" Settling
this now keeps the answer cheap when telemetry shows the pipeline drift
upward — and removes a class of "we serialized this for no reason"
inefficiencies from the codebase.

**C2 goal:** declare the dependency graph between the ten steps,
introduce a tiny in-process scheduler that runs each topological layer
concurrently, preserve the existing failure-isolation contract (per-step
try/catch with errors captured into `summary.<step>.error`), preserve
the unified `dreamed_at` mark, and gate the new behaviour behind a
runtime flag so the schema-and-code change is reversible by a one-line
config flip.

## Goals

- Explicit dependency graph for the ten dream steps — written once,
  read by the scheduler, surfaced in telemetry.
- Topological-layer parallelism: steps with no remaining dependencies
  run concurrently within their layer; subsequent layers start only
  after the previous layer settles.
- Per-step failure isolation preserved bit-for-bit: a thrown step
  populates `summary.<step>.error`, never aborts the run, never poisons
  sibling steps.
- The unified `dreamed_at = time::now()` UPDATE and
  `runtime:dream.last_run_at*` upsert still run **exactly once, after
  every step settles** (success or failure).
- Token-budget enforcement: a dream run that exhausts the daily token
  budget mid-flight halts cleanly between steps (not mid-step); the
  summary records `budget_exhausted: true`.
- Backward compat: `dreamProcess(db, host, embedder, opts)` keeps its
  current signature and return shape. Existing tests (`dream-pipeline.*`,
  per-step tests) pass unchanged.
- Behind a flag: `runtime:dream.config.parallelism_enabled` (default
  `false`); flip to `true` after one clean nightly run on Kevin's
  instance.

## Non-goals

- Cross-night parallelism (running two `dreamProcess` invocations in
  parallel). The existing serial barrier — `dispatcher-tick.js` uses
  `inFlight.add('__dream__')` to gate re-entry — is unchanged. Parallelism
  is **within** one nightly run.
- Process-level parallelism (worker threads, child processes). The
  scheduler is a `Promise.all`-per-layer in the same Node process; the
  DB connection is shared, the host LLM client is shared.
- Replacing `dispatch.js` / `cadence-consumer.js`. Trigger-eligible
  steps still fire one-at-a-time through the heartbeat consumer; C2's
  scheduler is per-night, not per-event.
- Step-internal parallelism (e.g., parallelising the per-entity LLM
  calls inside `step-knowledge`). That's a separate refactor; C2 only
  parallelises across steps.
- Reordering for output-equivalence theory. The DAG documents observed
  read/write sets; if two steps in different layers happen to produce
  the same end state regardless of order, that's a property of the
  steps, not a constraint we encode here.
- Migration-time data shape changes. C2 is purely an orchestration
  change with one new runtime config row.

## Anchoring decisions

**Why topological-layer parallelism instead of fine-grained DAG
scheduling:**

Two shapes are on the table. **Layered** (sometimes called Kahn-by-layer):
group steps into levels where everything at level N has its dependencies
in level <N, then run all of level N in parallel before starting
N+1. **Fine-grained DAG**: each step starts the moment its dependencies
settle, independent of layer. Fine-grained extracts marginally more
parallelism (a fast step in level 1 can release a step in level 2 while
slow siblings finish), but for ten steps with a shallow DAG (max depth
3 — see §1), the extra concurrency is bounded by the longest path. The
layered shape is also far easier to reason about: each layer is a single
`Promise.all`, the summary order is layer-stable, telemetry can report
per-layer wall-clock without a separate event log. We pick layered.

**Why a hand-rolled scheduler rather than a library:**

The pipeline has ten nodes, three layers, and a maximum branching
factor of seven within a layer. Pulling in `p-graph` or similar adds an
npm dependency, an import path, and a non-trivial code-read for anyone
trying to understand what dream does. A ~25-line `runDag(steps, deps,
opts)` that wraps `Promise.all` per layer is enough — and it can be
unit-tested in one file without spinning up dream.

**Why "per-step recheck on entry" for budget enforcement instead of
inline cancellation:**

`runtime:cadence.config.daily_token_budget` (faculties.md §cadence) is
already enforced inside the heartbeat consumer (`cadence-consumer.js`
lines 43–44, 92–97). The dream pipeline also consumes tokens but
**doesn't currently check the budget**. With ten serial steps that's
arguably fine — a single nightly run is bounded and rare. With parallel
steps inside a layer, several can each fire LLM calls at the same time;
exhausting the budget mid-layer is plausible. The cheapest correct
solution is "each step checks budget on entry, halts cleanly if
exhausted, summary records the halt." We don't try to interrupt an
in-flight LLM call — that requires `AbortController` plumbing through
`host.invokeLLM` that we don't have today, and the half-token of waste
from letting in-flight calls finish is irrelevant compared to a
correctness bug from mid-stream abort.

**Why preserve the unified `dreamed_at` mark:**

Today's pipeline marks **every undreamed event** as `dreamed_at` at the
end of the run (`pipeline.js` lines 79–81). The mark is intentionally
unified — re-running the pipeline observes an empty un-dreamed set and
is naturally idempotent. With parallel steps, the mark still happens
**after `Promise.all` resolves** for the last layer, so there is no race
between a step reading `WHERE dreamed_at IS NONE` and the mark itself.
This invariant is load-bearing — every step that filters `WHERE
dreamed_at IS NONE` (today: `step-knowledge`) depends on it being a
barrier, and the DAG must keep it a barrier. C2 makes this explicit in
§6.

**Why a runtime flag rather than landing parallelism unconditionally:**

The parallel scheduler is a behaviour change even when the dependency
graph is correct. SurrealDB connection pooling, embedder concurrency,
and host LLM rate limits all matter. Flag-gating lets us land the code
in `off` mode (identical to today's behaviour — pipeline runs serially,
just through the new scheduler), watch one clean nightly run, then flip
to `on` for the wall-clock win. The runtime config is one
backtick-quoted record (`runtime:dream.config`) per house style; flag
flip is one `UPDATE`.

## Section 1 — The dependency graph

Each step is summarised by its **read-set** (tables/edges it `SELECT`s
from) and **write-set** (tables/edges/runtime rows it `UPDATE`s,
`CREATE`s, or otherwise mutates). The dependency edges below follow the
rule **A depends on B iff A's read-set intersects B's write-set, or A
needs B's mutation to be observed before it runs**. Read-only siblings
have no edge; pure-writer siblings to disjoint tables have no edge.

### 1.1 — Per-step read/write sets (observed from source)

- **`step-knowledge`** (`step-knowledge.js`):
  - **Reads:** `events WHERE dreamed_at IS NONE`, `edges[kind='mentions']`
    (un-dreamed mention counts per entity), `entities` (name/type
    lookup), `memos[kind='knowledge']` filtered by `edges[kind='about']`
    (existing-knowledge context for LLM superseding).
  - **Writes:** `memos[kind='knowledge']` (via `store.note('knowledge',
    …)`), `edges[kind='derived_from']` (lineage from event ids), `edges
    [kind='about']` (subjects), `edges[kind='supersedes']` (via
    `store.supersede`) when promoting contradicting facts.

- **`step-patterns`** (`step-patterns.js`):
  - **Reads:** `edges[kind='occurs_with']` (last_seen ≥ cutoff, weight ≥
    min), `entities` (name lookup).
  - **Writes:** `memos[kind='habit']` (via `habits.upsert` — dedup by
    `meta.name`, increments `signal_count` on re-observation).

- **`step-reflection`** (`step-reflection.js`):
  - **Reads:** `events WHERE meta.kind = 'correction'` (within lookback),
    `embeddings_<profile>_events` (record + vector for clustering),
    `rule_candidates WHERE status = 'pending'` (overlap dedup via
    `findOverlappingPendingCandidate`).
  - **Writes:** `rule_candidates` (via `createCandidate`).

- **`step-confidence-recompute`** (`step-confidence-recompute.js`):
  - **Reads:** `evidence_ledger` (`SELECT VALUE memo_id … GROUP BY
    memo_id`), per-memo `meta.evidence_recomputed_at`,
    `fn::derived_confidence` per memo (server-side function reads the
    ledger).
  - **Writes:** `memos.confidence` and `memos.meta.evidence_recomputed_at`
    for memos with ledger activity since the marker.

- **`step-profile`** (`step-profile.js`):
  - **Reads:** `events WHERE biographed_at IS NOT NONE` (200-row recent
    window), `persona` (singleton — via `getProfile`), `rule_candidates`
    (overlap dedup via `findIdenticalProfileCandidate`).
  - **Writes:** `rule_candidates` (kind `profile_update`).

- **`step-arcs`** (`step-arcs.js`):
  - **Reads:** `runtime:arcs.config`, `episodes` (recent window),
    `events.episode_id` (membership), `edges[kind='mentions']` (entities
    per episode), `arcs WHERE status IN ['active','paused']` (dedup).
  - **Writes:** `arcs` (`createArc`/`extendArc` — `entity_ids`,
    `episode_ids`, `summary`, state transitions paused/closed).

- **`step-comm-style`** (`step-comm-style.js`):
  - **Reads:** communication telemetry (consumed inside
    `synthesizeCommStyle`; see `system/cognition/jobs/comm-style.js`).
  - **Writes:** `persona.comm_style` (singleton field).

- **`step-calibration`** (`step-calibration.js`):
  - **Reads:** `memos[kind='prediction']` with resolution (consumed
    inside `computeCalibration`).
  - **Writes:** `persona.calibration` (singleton field — via
    `setCalibration`).

- **`step-scope-cleanup`** (`step-scope-cleanup.js`):
  - **Reads:** `memos WHERE scope` matches an ephemeral pattern, plus
    `edges[kind='derived_from']` to detect lineage into persistent scope
    memos.
  - **Writes:** `memos.scope` (promote ephemeral → global), `DELETE
    memos` (prune past TTL).

- **`step-compaction`** (`step-compaction.js`):
  - **Reads:** `memos GROUP BY content_hash` (dedup pass on
    kind='knowledge'), `memos` filtered by `kind/age/signal_count`
    (archive pass per kind), `runtime:compaction.config`.
  - **Writes:** `edges[kind='supersedes']` (dedup canonicalisation),
    `archive_memos`/`archive_edges`/`archive_log` (via `archiveMemo`),
    `compaction_telemetry` (per-run summary).

### 1.2 — Dependency edges

We name edges as **`depends_on`**: A depends on B (so A must run
**after** B) iff one of:

- **Read-write overlap.** A reads from a table/edge/runtime row that B
  writes, AND A's correctness benefits from B's writes being visible.
- **Stated source-order invariant.** Today's source explicitly comments
  the order (e.g., "Runs in dream pipeline after step-scope-cleanup")
  and the order encodes a behavioural property we want to preserve.

Two pure-writer siblings to disjoint tables have no edge. Two writers
to the *same* surface (e.g., `step-knowledge` and `step-compaction`
both emit `edges[kind='supersedes']`) have no edge if both operations
are idempotent — composite-ID `INSERT RELATION … ON DUPLICATE KEY
UPDATE`, per `docs/architecture.md` §"One edges RELATION table" — so
co-writers don't induce an edge unless one also *reads* the other's
writes.

Edges (read direction → "after"):

1. **`step-scope-cleanup` after `step-knowledge`** — scope cleanup's
   promote pass reads `edges[kind='derived_from']` to detect ephemeral
   memos whose lineage reaches a persistent-scope memo (see
   `step-scope-cleanup.js` lines 30–41). `step-knowledge` writes
   `derived_from` edges for new knowledge lineage (via
   `store.note(..., {lineage})`). Without the edge, a same-night
   promotion into knowledge wouldn't propagate through scope cleanup
   for one cycle. **Real read/write overlap.**

2. **`step-compaction` after `step-scope-cleanup`** — explicit
   source-order invariant: `step-compaction.js` line 1 reads "Runs in
   dream pipeline after step-scope-cleanup." Scope cleanup may `DELETE`
   ephemeral memos past TTL that compaction would otherwise read in
   its dedup-by-`content_hash` group; the delete shrinks compaction's
   read-set. This is **behavioural** rather than strict-data-dependency
   (compaction wouldn't crash on the pre-delete set; it'd just
   canonicalise a memo that was about to be pruned). Preserved.

3. **`step-compaction` after `step-knowledge`** — `step-knowledge`
   creates new `kind='knowledge'` memos with `content_hash`.
   `step-compaction`'s dedup pass groups `kind='knowledge'` by
   `content_hash` (`step-compaction.js` lines 31–38). If the steps run
   concurrently, freshly minted memos miss the nightly dedup cycle
   (one-night lag — still arguably acceptable, but today's serial
   order doesn't impose it and we have no reason to introduce the lag
   now). **Behavioural** (lag-vs-now trade-off favours the edge.)

That's the full edge set: three edges, all incident on the two
post-layer nodes.

**Edges intentionally NOT drawn** (called out so future readers don't
re-introduce them without thinking):

- **`step-confidence-recompute` after `step-knowledge`.** Considered
  and rejected. Confidence recompute reads `evidence_ledger` (`SELECT
  VALUE memo_id … GROUP BY memo_id`) — not memos. A brand-new
  knowledge memo created by `step-knowledge` has zero `evidence_ledger`
  rows: ledger rows are produced by the reinforcement loop (B1) when a
  recall hits and by `store.relate(..., 'contradicts')` — neither
  applies at promotion time. Confidence recompute therefore finds no
  rows for the new memo and correctly does nothing. No edge.

- **`step-arcs` after `step-knowledge`.** Today's serial pipeline runs
  arcs *after* knowledge, but arcs reads `episodes`,
  `events.episode_id`, and `edges[kind='mentions']` (`step-arcs.js`
  lines 18–47) — none of which `step-knowledge` writes (knowledge
  writes `derived_from`, `about`, `supersedes`). No edge. Arcs runs in
  level 1. The §10 output-equivalence test catches any regression
  from this re-ordering.

- **`step-patterns` after anything.** Reads `edges[kind='occurs_with']`
  (written by biographer per-event) and `entities` (same). Writes
  `memos[kind='habit']` — no dream step reads `kind='habit'`. No edge.

- **`step-reflection` after anything.** Reads `events.meta.kind =
  'correction'` and `embeddings_<profile>_events`. Neither is written
  by a dream step. No edge.

- **`step-profile` against {`step-comm-style`, `step-calibration`}.**
  `step-profile` writes `rule_candidates` (not persona — it only
  *reads* persona via `getProfile`). It does not race the persona
  writers. No edge against `step-profile`.

- **`step-comm-style` against `step-calibration` — DRAWN, plus a
  durable fix.** Both funnel through `updatePersonaFields(db, fields)`
  which issues `UPSERT persona:singleton MERGE ${fields}` (see
  `system/cognition/memory/persona.js` lines 11–12). MERGE is
  **record-level**, not field-level: under concurrent MERGEs, the
  engine reads the record, merges, writes back; the second writer can
  overwrite the first's sibling key (classic last-writer-wins on the
  record value). Two concurrent dream steps both `MERGE`ing into
  `persona:singleton` therefore can lose a write.

  **The race is wider than within-dream.** `dispatcher-tick.js`'s
  in-flight gate (`inFlight.add('__dream__')`) only prevents a second
  `dreamProcess` re-entering while one is running. It does **not** gate
  the cadence consumer's trigger-eligible single-step dispatches:
  `cadence-consumer.js` can dispatch `synthesizeCommStyle` or
  `setCalibration` as Theme 3 steps **while dream is mid-flight**,
  hitting `updatePersonaFields` from a different async surface. The
  in-dream edge alone does not close this cross-process race.

  C2 therefore takes **both** fixes — belt and suspenders:

    1. **Refactor `updatePersonaFields` (durable).** Rewrite
       `UPSERT persona:singleton MERGE ${fields}` to a field-scoped
       statement: `UPDATE persona:singleton SET field1 = $v1, field2 =
       $v2, …`. SurrealDB SET on a top-level field is field-local;
       concurrent writers to disjoint fields no longer overwrite each
       other's sibling keys. This makes the cross-process case safe.
       Listed as a C2-scope prereq task in §11 modified files;
       implemented in `system/cognition/memory/persona.js` before the
       parallel flag flips.
    2. **Add the in-dream edge** `step-comm-style → step-calibration`
       so the two persona-writers serialise within a dream run. Cheap,
       reduces blast radius if the SET refactor regresses, and the
       edge lives in §1.3: `calibration` (chosen lexically; both are
       layer-1 candidates otherwise) becomes a dependent of
       `commStyle`.

- **`step-reflection` after `step-profile`.** Both write
  `rule_candidates` but with disjoint `kind` filters (`behavior` vs
  `profile_update`). The overlap check is keyed by kind. No edge.

- **`step-compaction` after `step-confidence-recompute`.** Considered
  and rejected. Compaction's archive predicate filters on
  `signal_count` and `derived_at`, not `confidence`. A future predicate
  tightening (suggested by the `archive_thresholds` shape) could
  introduce the dependency — at that point the edge moves into the
  DAG in a follow-up. Not today.

- **`step-compaction` after `step-arcs`.** Compaction can archive
  `kind='thread'` memos (legacy narrative). Arcs writes `arcs` records,
  not `kind='thread'` memos (post-Theme 1b — see `docs/faculties.md`
  §arcs). No edge.

### 1.3 — The graph

Node names below match the camelCase summary keys (`knowledge`,
`commStyle`, etc.) used by `byName` and `DREAM_DAG_DEPS` — see §4.

```
Layer 1 (no incoming edges):
  knowledge
  patterns
  reflection
  profile
  arcs
  commStyle
  confidence

Layer 2 (depends on layer-1 only):
  scopeCleanup    ← knowledge
  calibration     ← commStyle (persona MERGE serial)

Layer 3 (depends on layer-1 or layer-2):
  compaction      ← knowledge, scopeCleanup
```

Three layers. Layer 1 has seven steps; layer 2 has two; layer 3 has
one. Max depth along the longest path is three nodes
(`knowledge → scopeCleanup → compaction`).

`confidence` is in **layer 1** (no edge to `knowledge`, per §1.2
rationale). `calibration` is in **layer 2** behind `commStyle` because
both write through `updatePersonaFields` and today's MERGE is
record-level — see §1.2 "persona MERGE serial" entry. The persona
SET refactor in §11 closes the cross-process race; the in-dream edge
remains as belt-and-suspenders.

A graphical view:

```
   ┌───────────────┐         ┌──────────────────┐
   │   knowledge   │         │    commStyle     │
   └───┬───────┬───┘         └────────┬─────────┘
       │       │                      │
       ▼       │                      ▼
 ┌────────────┴──────┐         ┌──────────────────┐
 │   scopeCleanup    │         │   calibration    │
 └────────┬──────────┘         └──────────────────┘
          │
          ▼
   ┌──────────────────┐
   │    compaction    │
   └──────────────────┘

   Layer 1 (parallel siblings — seven):
     knowledge, patterns, reflection, profile, arcs,
     commStyle, confidence
   Layer 2 (two): scopeCleanup, calibration
   Layer 3 (one): compaction
```

## Section 2 — The scheduler

```js
// system/cognition/dream/scheduler.js (new file)

/**
 * Run a DAG of named steps in topological-layer order.
 *
 * Each layer runs its steps concurrently via Promise.all; subsequent
 * layers start only after the previous layer settles. Per-step errors
 * are captured into the returned summary; they do not propagate.
 *
 * @param {Record<string, (ctx) => Promise<any>>} steps   name → fn(ctx)
 * @param {Record<string, string[]>}             deps    name → [dep, …]
 * @param {object} opts
 *   @param {object}  opts.ctx              passed to every step fn
 *   @param {number}  opts.maxConcurrent   per-layer cap (default ∞)
 *   @param {(name, ms, err?) => void}     opts.onStepSettled  (optional)
 *   @param {() => Promise<bool>}          opts.shouldHalt    layer-gate
 * @returns {{summary, layers, halted}}
 *   summary: { [name]: result | { error: string } }
 *   layers : [{ names: [], started_at, ended_at, duration_ms }]
 *   halted : 'budget_exhausted' | null
 */
export async function runDag(steps, deps, opts = {}) {
  const layers = topoLayers(steps, deps);   // [['step-a','step-b'], …]
  const summary = {};
  const layerLog = [];
  let halted = null;

  for (const layer of layers) {
    if (opts.shouldHalt && (await opts.shouldHalt())) {
      halted = 'budget_exhausted';
      for (const name of layer) summary[name] = { skipped: 'budget_exhausted' };
      continue;  // record skip rows for every remaining layer's steps
    }
    const t0 = Date.now();
    const slots = chunkByLimit(layer, opts.maxConcurrent ?? Infinity);
    for (const slot of slots) {
      await Promise.all(slot.map(async (name) => {
        const stepT0 = Date.now();
        try {
          summary[name] = await steps[name](opts.ctx);
          opts.onStepSettled?.(name, Date.now() - stepT0);
        } catch (e) {
          summary[name] = { error: e.message };
          opts.onStepSettled?.(name, Date.now() - stepT0, e);
        }
      }));
    }
    layerLog.push({ names: layer, started_at: t0, ended_at: Date.now(),
                    duration_ms: Date.now() - t0 });
  }

  // Sort summary keys for deterministic insertion order: by DAG
  // layer index (smallest first), then lexically within a layer.
  // Consumers must not depend on insertion order, but a deterministic
  // order makes JSON-stringified summaries diff-stable across runs and
  // matches today's source-order behaviour as closely as possible.
  // `layers` here is the topological grouping from topoLayers, not
  // the layerLog returned to callers.
  const orderedSummary = {};
  layers.forEach((layerNames) => {
    [...layerNames].sort().forEach((name) => {
      if (name in summary) orderedSummary[name] = summary[name];
    });
  });

  return { summary: orderedSummary, layers: layerLog, halted };
}
```

Two helpers, both local to `scheduler.js`:

- `topoLayers(steps, deps)` — Kahn's algorithm with layer grouping. Run
  one pass: collect all names with zero in-degree → that's layer 1.
  Remove their out-edges. Repeat. Cycle detection: if a pass produces
  no new names while names remain, throw — but for C2 the graph is
  static and validated by a unit test at boot.

- `chunkByLimit(arr, limit)` — when `limit < arr.length`, splits into
  chunks of size `limit`. Default unlimited. The C2 default is
  unlimited within a layer (the layer cardinality is the cap); the
  flag below lets us bound it.

The scheduler is **~25 LOC plus the two helpers**. No deps. Single
test file (`scheduler.test.js`).

## Section 3 — The new `dreamProcess`

```js
// system/cognition/dream/pipeline.js (rewritten)

import { surql } from 'surrealdb';
import { runDag } from './scheduler.js';
import { readDreamConfig, shouldHalt } from './dream-budget.js';
import * as steps from './step-registry.js';      // wraps the ten step fns
import { DREAM_DAG_DEPS } from './dag.js';        // the deps map from §1.3

export async function dreamProcess(db, host, embedder, opts = {}) {
  const cfg = await readDreamConfig(db);
  const ctx = { db, host, embedder, opts, cfg };

  // Legacy serial path: identical to today's pipeline. Used while the
  // flag is off and for one-line rollback.
  if (!cfg.parallelism_enabled) {
    return await runDreamSerial(ctx);
  }

  let schedulerError = null;
  let summary = {};
  let layers = [];
  let halted = null;
  try {
    ({ summary, layers, halted } = await runDag(steps.byName, DREAM_DAG_DEPS, {
      ctx,
      maxConcurrent: cfg.max_concurrent ?? Infinity,
      shouldHalt: () => shouldHalt(db, cfg),         // §5
      onStepSettled: (name, ms, err) =>
        recordStepTelemetry(db, name, ms, err).catch(() => {}),
    }));
  } catch (e) {
    // §7 — defence-in-depth. runDag's per-step catch normally guarantees
    // we never get here. If we do, skip the unified mark so a re-run can
    // try again on the same un-dreamed set.
    schedulerError = e;
  }

  if (!schedulerError) {
    await db
      .query(surql`UPDATE events SET dreamed_at = time::now() WHERE dreamed_at IS NONE`)
      .collect();
  } else {
    console.warn(`[dream] scheduler threw uncaught: ${schedulerError.message} — skipping dreamed_at mark`);
  }

  // Build the runtime:dream upsert. last_run_at always advances;
  // last_run_at_success only advances on a clean (non-halted,
  // non-thrown) run. Field-scoped SETs preserve any other keys (like
  // last_run_at_jobs) set elsewhere.
  const success = !halted && !schedulerError;
  const layersForRow = layers.map((l) => ({ names: l.names, duration_ms: l.duration_ms }));
  if (success) {
    await db
      .query(
        surql`UPSERT type::record('runtime', 'dream')
              SET value.last_run_at = time::now(),
                  value.last_run_at_success = time::now(),
                  value.last_layers = ${layersForRow},
                  value.last_halted = NONE`,
      )
      .collect();
  } else {
    await db
      .query(
        surql`UPSERT type::record('runtime', 'dream')
              SET value.last_run_at = time::now(),
                  value.last_layers = ${layersForRow},
                  value.last_halted = ${halted ?? 'scheduler_error'}`,
      )
      .collect();
  }

  summary._meta = { layers, halted, mode: 'parallel', scheduler_error: schedulerError?.message ?? null };
  return summary;
}

async function runDreamSerial(ctx) {
  // Verbatim copy of today's pipeline body (lines 27-89). Kept for
  // exact-equivalence under flag=off. The duplication is deliberate
  // and bounded — both branches eventually converge once parallel mode
  // is the default. §9 plans the converge step.
  …
}
```

Two notes:

- The `_meta` field on the summary is **purely additive** and is
  written **only in parallel mode** (the serial branch returns today's
  exact summary shape). Every existing consumer (`dispatcher-tick.js`,
  doctor's `show_step_health`) reads named-step keys
  (`summary.knowledge`, `summary.compaction`, …) which match today's
  camelCase contract (see §4). Adding `_meta` is safe; existing tests
  that JSON-stringify the summary will see one extra key in parallel
  mode. §10.2 #12's output-equivalence test strips `_meta` via
  `normalizeSummary` before comparing.
- `runtime:dream`'s `last_run_at_success` is now `null` when the run
  halted (consistent with the doctor's exit-code-2 rollup — partial
  failure is not "success at this timestamp").

## Section 4 — `step-registry.js` and `dag.js`

**Key naming — load-bearing.** The keys in `byName` and `DREAM_DAG_DEPS`
**must match the existing `summary.<key>` shape produced by today's
`pipeline.js`**: `knowledge`, `patterns`, `reflection`, `confidence`,
`profile`, `arcs`, `commStyle`, `calibration`, `scopeCleanup`,
`compaction` (camelCase, no `step-` prefix). Every consumer reads
named keys: `dispatcher-tick.js`'s success/failure rollup,
`show-step-health.js`, `run-dream.js`, the existing `dream-pipeline.*`
integration tests, and §10.2 test #12's bit-equivalence assertion. Using
kebab-case (`'step-comm-style'`) would silently break every one of those
surfaces. C2 is an orchestration change; the summary contract is
unchanged.

```js
// system/cognition/dream/dag.js
export const DREAM_DAG_DEPS = {
  knowledge:    [],
  patterns:     [],
  reflection:   [],
  profile:      [],
  arcs:         [],
  commStyle:    [],
  confidence:   [],                            // §1.2 — no edge to knowledge
  scopeCleanup: ['knowledge'],
  calibration:  ['commStyle'],                 // §1.2 — persona MERGE serial
  compaction:   ['knowledge', 'scopeCleanup'],
};
```

```js
// system/cognition/dream/step-registry.js
import { dreamStepArcs } from './step-arcs.js';
import { dreamStepCalibration } from './step-calibration.js';
import { dreamStepCommStyle } from './step-comm-style.js';
import { dreamStepCompaction } from './step-compaction.js';
import { dreamStepConfidenceRecompute } from './step-confidence-recompute.js';
import { dreamStepKnowledge } from './step-knowledge.js';
import { dreamStepPatterns } from './step-patterns.js';
import { dreamStepProfile } from './step-profile.js';
import { dreamStepReflection } from './step-reflection.js';
import { dreamStepScopeCleanup } from './step-scope-cleanup.js';

// Each entry is the same shape: `(ctx) => Promise<result>`. ctx unpacks
// db/host/embedder/opts the way the existing steps expect. Keys MUST
// match the camelCase summary contract (see §4 preamble).
export const byName = {
  knowledge: ({ db, host, embedder, opts }) =>
    dreamStepKnowledge(db, host, embedder, opts?.knowledge),
  patterns: ({ db, host, opts }) =>
    dreamStepPatterns(db, host, { ...(opts?.patterns ?? {}),
                                   embedder: opts?.embedder }),
  reflection: ({ db, host, opts }) =>
    dreamStepReflection(db, host, opts?.reflection),
  confidence: ({ db }) => dreamStepConfidenceRecompute(db),
  profile: ({ db, host, opts }) => dreamStepProfile(db, host, opts?.profile),
  arcs: ({ db, opts }) => dreamStepArcs(db, opts?.arcs),
  commStyle: ({ db, host }) => dreamStepCommStyle(db, host),
  calibration: ({ db }) => dreamStepCalibration(db),
  scopeCleanup: ({ db, host, opts }) =>
    dreamStepScopeCleanup(db, host, opts?.scopeCleanup),
  compaction: ({ db }) => dreamStepCompaction(db),
};
```

The step modules themselves are **unchanged**. C2 is an orchestration
change.

## Section 5 — Token-budget enforcement

`runtime:cadence.config.daily_token_budget` is the only daily budget
today. C2 does **not** introduce a separate dream-only budget; instead
the dream run participates in the shared budget. Three reasons:

1. The cadence consumer and the dream pipeline are two sources of LLM
   cost on the same wall-clock day. Splitting budgets means the dream
   pipeline could finish "in budget" while leaving zero room for any
   trigger-eligible step until the next day.
2. The implementation already exists. `currentBudget(db, cfg)` in
   `budget.js` reads `cadence_telemetry`'s 24-h sum and subtracts from
   the safe budget. Dream's per-step telemetry rows
   (`recordStepTelemetry`, see §8) write to the same
   `cadence_telemetry` table — i.e., budget accounting is unified by
   construction.
3. The reverse-coupling — "dream goes over and starves cadence" — is
   the failure mode we explicitly *want* to prevent. Letting dream
   detect budget exhaustion mid-flight reserves the day's headroom for
   the next morning's heartbeat consumer.

The check itself:

```js
// system/cognition/dream/dream-budget.js (new file)
import { currentBudget } from './budget.js';

export async function readDreamConfig(db) {
  try {
    const [rows] = await db.query('SELECT VALUE value FROM runtime:`dream.config`').collect();
    return rows?.[0] ?? DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export async function shouldHalt(db, cfg, cadenceCfg) {
  if (!cfg.budget_check_enabled) return false;
  const { remaining } = await currentBudget(db, cadenceCfg);
  const floor = cfg.budget_floor ?? defaultFloor(cadenceCfg);
  return remaining <= floor;
}

// §5.1 — when budget_floor is null, reserve 20% of the daily budget
// for the cadence consumer. Operators can override with a number.
function defaultFloor(cadenceCfg) {
  const daily = cadenceCfg?.daily_token_budget ?? 0;
  return Math.floor(daily * 0.2);
}

const DEFAULTS = {
  parallelism_enabled: false,
  max_concurrent: null,        // null → unlimited within a layer
  budget_check_enabled: true,
  budget_floor: null,          // null → defaultFloor() = 20% reserve
};
```

The scheduler calls `shouldHalt()` **between layers**, not between
steps within a layer. This is the right granularity because:

- Within a layer, several steps fire in parallel; interrupting one
  mid-call requires `AbortController` plumbing that we don't have. The
  half-token of waste from letting in-flight steps finish is irrelevant
  next to a correctness bug from mid-step abort.
- Between layers, the budget check is a single `currentBudget` query —
  cheap, deterministic, and **observes the writes from the just-settled
  layer's `cadence_telemetry` rows**, so the remaining budget reflects
  reality.

When `shouldHalt()` returns true, the scheduler records every
remaining step as `{ skipped: 'budget_exhausted' }` and returns
`halted: 'budget_exhausted'`. The pipeline then proceeds to the
unified `dreamed_at` mark and the `runtime:dream` upsert (§3, §6 —
`last_run_at_success` is `null`, `last_halted` is `'budget_exhausted'`).

### 5.1 — Budget coupling: dream cost lives in the same 24-h window as cadence

Per-step telemetry writes (§8 #1) land in `cadence_telemetry`, the
same table the cadence consumer reads via `currentBudget(db, cfg)`'s
24-hour rolling sum. **A heavy dream night therefore subtracts from
the next morning's cadence headroom.** Worst case: a parallel run that
fires every LLM-bound step at its upper bound (knowledge, patterns,
reflection, profile, commStyle, calibration — six steps at ~50k
tokens each plus per-entity LLM calls inside knowledge) can push dream
to ~250–300k tokens in one night. With a baseline daily budget of,
say, 500k tokens, that leaves ~200k for the heartbeat consumer's
trigger-eligible work over the next 24 h — visible cadence starvation.

C2 adopts the explicit-split approach (v1 simplicity):

- **Dream may consume up to 80% of the daily budget.** Cadence is
  reserved the remaining 20%. The dream-side `shouldHalt(db, cfg)`
  check (§5) treats `budget_floor` as `0.2 × daily_token_budget` by
  default — i.e., dream halts when the 24-h rolling sum (which
  already includes its own writes) would push the remaining headroom
  below the cadence reserve.
- **Cadence's `currentBudget` is unchanged.** It already reads the
  full `cadence_telemetry` 24-h sum; with dream writing into the same
  table, cadence sees the unified picture for free. No separate
  `dream_telemetry` table.
- **Configurable.** `runtime:`dream.config`.budget_floor` defaults to
  `null` (interpreted as `0.2 × daily_token_budget`); operators can
  override with an explicit integer for tighter or looser splits.
- **Tested.** §10.2 adds test #15b asserting `currentBudget(db, cfg)`
  correctly sums dream's per-step rows alongside cadence's own
  trigger-eligible step rows (i.e., the 24-h sum reflects both
  surfaces).

The alternative (option b: separate `dream_telemetry` table that
`currentBudget` also sums) is cleaner but lands more code and a
second migration. Defer until telemetry shows the 80/20 split is the
wrong knob.

### 5.2 — Deviation from the design brief: layer-gated, not per-step

**Note on the brief.** The C2 design brief recommends: "each step
rechecks the budget on entry, halts cleanly if exhausted, summary
records `budget_exhausted: true`. No mid-step interruption." This spec
substitutes a **layer-gated** check (between layers, not on every step
entry) and keeps the rest of the recommendation intact. The deviation
is intentional and minor; we flag it here so it shows up in review.

Reason for the deviation: per-step entry checks within a layer produce
a **non-deterministic step status across the layer**. If three of
seven layer-1 steps observe `remaining = 500` and call their LLMs
while four observe `remaining = 0` (because the first three's
`cadence_telemetry` rows landed first) and skip, the summary's
`skipped` set is non-reproducible across runs even on identical input.
Layer-gating keeps the boundary clean: a layer either runs entirely or
skips entirely, and the boundary is the same data-dependency boundary
the scheduler already enforces.

The cost is one extra `currentBudget` query per layer — three queries
per night. Within the cost envelope.

**Over-shoot magnitude — explicit.** Layer-gated halting means a layer
that crosses the floor mid-flight still **finishes** before the next
boundary check. Worst case: every LLM-bound step in the busiest layer
fires concurrently and overshoots together. Layer 1 has up to **five
LLM-bound steps** (`knowledge`, `patterns`, `reflection`, `profile`,
`commStyle`) at a generous per-step cap of ~50k tokens =
**~250k-token over-shoot** before the layer-2 boundary check fires.
This is acceptable for v1 — it's bounded, it's a once-per-night event,
and it's preferable to mid-step abort plumbing. Documented in §13 cost
envelope.

If reviewers prefer the brief's exact shape, the change is one-line:
move `shouldHalt()` from `runDag`'s between-layer position into the
per-step wrapper inside the `Promise.all` map. The recorded summary
shape is identical; only the schedule of where the check happens
moves. We can flip this back in review without re-architecting.

## Section 6 — The unified `dreamed_at` mark

Today's mark (`pipeline.js:79-81`):

```surql
UPDATE events SET dreamed_at = time::now() WHERE dreamed_at IS NONE
```

is a **barrier**: it runs after every step has had a chance to read
`WHERE dreamed_at IS NONE`. The ten steps that filter on this flag
today are: `step-knowledge` (explicit). All others read other tables
(memos, edges, episodes, ledger). `step-knowledge` is in layer 1, so
under layered parallelism every step still sees the same un-dreamed
set as it does today.

The mark continues to run **exactly once, after every layer settles**.
With the scheduler:

1. `runDag` returns once the last layer's `Promise.all` resolves.
2. Then the unified UPDATE fires (sequentially, in the main async
   function).
3. Then the `runtime:dream` upsert fires.

There is **no race** between a parallel step reading `WHERE dreamed_at
IS NONE` and the mark, because the mark is sequenced after every
step's promise has settled. The scheduler's per-step try/catch
guarantees every step settles (success or `{error}`) before
`runDag` returns.

The §10 test plan asserts the post-condition: after `dreamProcess`,
`SELECT count() FROM events WHERE dreamed_at IS NONE` is zero (for a
non-halted run).

## Section 7 — Cursor advance / mark idempotency

Today the mark runs unconditionally at the end of the pipeline. If
re-run, the second invocation observes an empty un-dreamed set and is
a no-op — the property the comment in `pipeline.js` calls "naturally
idempotent."

Under parallelism, the per-step try/catch in `runDag` captures **any**
thrown error into `summary.<step>.error`. A step can only escape this
try/catch in three failure shapes:

1. A synchronous throw outside the awaited promise (e.g., `steps[name]`
   itself is undefined — caught by §10's DAG-completeness invariant
   test, gates 20).
2. An async throw inside `onStepSettled` itself (impossible: the
   telemetry call is wrapped in `.catch(() => {})` in §3).
3. A throw inside `topoLayers` or `chunkByLimit` (constructor-time
   failure — caught by §10 unit tests 10, 11).

Practically: with the unit-test safety net, uncaught throws from inside
`runDag` should be impossible. **Defence-in-depth**: the pipeline-level
try/catch around `runDag` (§3) sets `schedulerError`. When set, the
unified `dreamed_at` mark is **skipped**, so a re-run sees the same
un-dreamed set and gets another chance. The `runtime:dream` upsert
still runs (with `last_run_at_success` unchanged, `last_halted` set to
`'scheduler_error'`) so the doctor sees the partial-failure state.

Two failure modes spelt out:

- **Per-step error captured by `runDag`**: mark **runs** (the step
  errored, but the layer settled — every other step had a chance to
  observe its un-dreamed set; today's serial pipeline behaves the
  same way). `summary.<step>.error` is set.
- **Scheduler-level error** (the §7 guard above): mark **skipped**.
  Next run re-attempts on the same un-dreamed set.

**Budget-halted runs**: the mark **runs** (halt is not a failure — it's
a graceful early stop, and re-running the next night would dredge the
same un-dreamed set; we don't want to re-process them). This matches
today's serial behaviour, which would also mark on the way out from a
successful-but-skipped run.

Cursor side: `runtime:cadence.cursors` (advanced by `advanceCursor` in
`cursors.js`) is **not** touched by `dreamProcess`. The cadence
consumer manages cursors per-step; dream's full-pipeline runs do not.
This is unchanged by C2.

**Two `runtime` rows, two semantics.** `runtime:dream` is the per-run
ledger (`last_run_at`, `last_run_at_success`, the new `last_layers` and
`last_halted`). `runtime:scheduler.value.dream.next_run_at` is the
*next-run cursor* maintained by `dispatcher-tick.js` (lines 53–65) for
the daily 4 AM schedule. The two rows are independent; C2 only writes
to `runtime:dream` and `dispatcher-tick.js` is unchanged.

## Section 8 — Telemetry

C2 adds three new telemetry dimensions. The **storage layout defers to
the C3 telemetry-umbrella spec** when it lands; the dimensions named
here are the contract for that spec.

1. **Per-step duration.** `recordStepTelemetry(db, name, ms, err?)` —
   one row per step settle. Today this would be a `cadence_telemetry`
   row (matching the cadence consumer's shape exactly — `step`,
   `tokens_in`, `tokens_out`, `duration_ms`, `success`,
   `trigger_id: null`). The unified budget accounting (§5) requires
   this. C3 will likely rename or split this table; C2 commits only
   to the dimension names.

2. **Layer-level wall-clock.** `runtime:dream.last_layers` —
   `[{ names, duration_ms }, …]`. One row per nightly run; replaces no
   existing data. Surfaced by Theme 4's `show_step_health`.

3. **Layer-level parallelism factor.** A derivation, not a primary
   field: `parallelism_factor = sum(step_duration_ms) /
   layer_duration_ms` for a layer. A layer of N steps run perfectly in
   parallel has factor ≈ N; serial-equivalent runs (one step active at
   a time) yield ≈ 1. Computed at read time by `show_step_health`. The
   primary inputs are #1 and #2.

4. **Mid-run halts.** `runtime:dream.last_halted` is one of `NONE
   | 'budget_exhausted' | 'scheduler_error'`. A separate `dream_halts`
   row in C3's chosen telemetry table records (per occurrence)
   `{ at, reason, remaining_layers: [names…] }`. C2 captures the data;
   C3 owns the table.

Existing `runtime:dream.last_run_at` semantics:

- `last_run_at` — always set, even for halted runs.
- `last_run_at_success` — set only when `halted === null`.
- The doctor exit code is already `2` when `last_run_at_success` lags
  more than 36 h. With C2, halted runs leave `last_run_at_success`
  unchanged from the previous run, so a single halted night doesn't
  trip the doctor; two halted nights do.

**C3 coordination — required.** C3 owns the storage layout for
telemetry. C2's per-step writes are **net-new dimensions** that C3's
inventory must enumerate:

- `cadence_telemetry` rows discriminated by `step ∈ { knowledge,
  patterns, reflection, profile, arcs, commStyle, confidence,
  scopeCleanup, calibration, compaction }` — ten new step values that
  did not exist before C2.
- `runtime:dream.value.last_layers` and `runtime:dream.value.last_halted`
  — new fields on an existing runtime row (additive, no schema
  enforcement).
- Implicit: C3's hourly aggregator must roll up `step LIKE 'dream.%'`
  (or whatever discriminator prefix C3 picks) into its
  freshness/cost dashboards. If C3's current draft claims
  `system/cognition/dream/*` writes are "unchanged", that's an
  oversight to fix during the C3 revision pass.

The C3 spec is being revised in parallel; the dimensions named here
are the contract C3's inventory must adopt. Coordination is via
written specs, not subagent dispatch.

## Section 9 — Rollout / migration

### 9.1 — Migration

`system/data/db/migrations/0020-dream-dag.surql`:

```surql
-- Seed runtime:dream.config (this spec's *config* row — distinct from
-- runtime:dream, the per-run ledger written by dreamProcess on every
-- nightly run; the backtick in the record id is the separator and
-- carries no semantic meaning beyond grouping these two rows under the
-- "dream" namespace). Shipped in legacy-serial mode (flag off);
-- flipped to parallel via UPDATE in rollout step 4 (§9.2).
UPSERT runtime:`dream.config` SET value = {
  parallelism_enabled: false,
  max_concurrent: NONE,         -- NONE → unlimited within a layer
  budget_check_enabled: true,
  budget_floor: NONE            -- NONE → defaultFloor() = 20% of daily budget (§5.1)
};

-- Extend runtime:dream's value shape (no schema enforcement —
-- runtime.value is FLEXIBLE). Note added here for grep-ability:
-- runtime:dream.value MAY now carry:
--   last_layers : [{names: [string], duration_ms: int}]
--   last_halted : option<string>   -- 'budget_exhausted' | NONE
```

(Version `0020` reserves the next-free slot above the umbrella's
allocations. Current head on disk is `0008-doctor.surql`. The roadmap
allocates: B1=`0009`, A3=`0010`, C1=`0011`, D1=`0012`/`0013`/`0014`,
B2=`0015`, B2-follow-up=`0016`, C3=`0017`, D2=`0018`, D3=`0019`, C2=
`0020`. Pinned at design time to avoid a clash with B2's
`0016-conflict-surfacing-default-on.surql`.)

**No backfill.** Existing `runtime:dream` rows keep their `last_run_at`
/ `last_run_at_success` fields; the new keys appear on the next run.

### 9.2 — Rollout sequence

1. Land migration `0020-dream-dag.surql` (seed `parallelism_enabled =
   false`). No behaviour change.
2. Land `scheduler.js`, `dag.js`, `step-registry.js`, `dream-budget.js`
   + the rewrite of `dreamProcess` (§3) with the serial branch
   preserved verbatim. Existing tests pass (the serial branch is
   identical to today's pipeline).
3. Land per-step telemetry (§8 #1) and `show_step_health`
   updates. Surface `parallelism_factor` (read-time derivation) and
   `last_halted`.
4. On Kevin's instance, run one clean nightly run with
   `parallelism_enabled = false` (proves the new scheduler's serial
   path is observably identical to today). Then flip:
   `UPDATE runtime:`dream.config` SET value.parallelism_enabled = true;`.
5. Watch one nightly parallel run. Healthy looks like: ten step keys
   in summary; no `error` rows that weren't present in the prior
   serial run; layer-1 duration ≈ max(layer-1 step durations);
   `dreamed_at IS NONE` count zero post-run.
6. After two weeks of clean parallel runs, flip the seed value in
   `0020-dream-dag.surql` for fresh installs only — existing installs
   already have their runtime row written and the migration runner
   pins checksums (idiom mirrors B1 §9.2 step 5: never edit a landed
   migration; ship a follow-up `0021-…surql` that sets the seed via
   `UPSERT` if a future change needs to alter the on-disk default).

### 9.3 — Rollback path

`UPDATE runtime:\`dream.config\` SET value.parallelism_enabled = false;`
— instant. The next `dreamProcess` invocation takes the serial branch
(verbatim copy of today's pipeline). The scheduler code remains
imported but unused; per-step telemetry continues to be recorded
(useful even in serial mode for cost tracking).

## Section 10 — Test plan

### 10.1 — Unit tests

`system/tests/unit/dream-scheduler.test.js` (new):

1. **Empty graph.** `runDag({}, {})` returns `{summary:{}, layers:[],
   halted:null}`.
2. **Single step.** `runDag({a: () => 1}, {a: []})` returns
   `summary.a === 1`, one layer.
3. **Linear chain a → b → c.** Three layers, each of one step.
   Asserts `b` only starts after `a`'s promise resolves (uses fake
   timers to detect concurrent starts).
4. **Diamond a → {b,c} → d.** Three layers; `b` and `c` run
   concurrently (asserted by recording start timestamps with a 10ms
   sleep in each).
5. **Step throws.** Throw inside step `a` (which has dependent `b`).
   `summary.a === {error: 'msg'}`, `summary.b` runs normally (the
   per-step catch keeps the layer going for siblings; `b` is in the
   next layer and runs because the DAG's dependency is "after `a`
   *settles*", not "after `a` succeeds" — preserves today's behaviour
   where a failed step doesn't abort downstream).
6. **Step throws non-Error.** `summary.<name>.error === String(value)`.
7. **`shouldHalt` true at layer boundary.** All remaining steps get
   `{skipped: 'budget_exhausted'}`, return `halted: 'budget_exhausted'`.
8. **`shouldHalt` true at first call.** Every step skipped; `summary`
   has only `skipped` entries.
9. **`maxConcurrent` cap.** Layer of five steps with `maxConcurrent
   = 2`: assert at most two start within any 10ms window (timestamp
   ledger), three slot batches in order.
10. **Cycle detection.** `runDag({a, b}, {a: ['b'], b: ['a']})` throws
    a clear `Cycle in DAG: a, b` error at startup.

`system/tests/unit/dream-dag.test.js` (new):

11. **DAG validates against registry.** `topoLayers(steps.byName,
    DREAM_DAG_DEPS)` returns three layers with the expected
    membership; no cycles; the set of keys in `byName` equals the set
    of keys in `DREAM_DAG_DEPS` (symmetric difference is empty).
    Asymmetry in either direction is fatal: a name in `byName` missing
    from `DREAM_DAG_DEPS` is excluded from the topo and never runs; a
    name in `DREAM_DAG_DEPS` missing from `byName` makes
    `topoLayers` return a name that `steps[name]` resolves to
    `undefined`, throwing `steps[name] is not a function` inside the
    scheduler (§7 failure-mode 1).

### 10.2 — Integration tests

`system/tests/integration/dream-parallel.test.js` (new):

12. **Output equivalence on synthetic input.** Seed a fixed corpus of
    events + memos + edges. Run `dreamProcess` once with
    `parallelism_enabled=false` and capture `summary` (today's
    camelCase shape: `summary.knowledge`, `summary.commStyle`, etc.).
    Reset DB; run again with `parallelism_enabled=true` and capture the
    parallel-mode `summary` (same camelCase shape plus a `_meta` key).
    Define a `normalizeSummary(s)` helper that strips `_meta` and
    non-deterministic timestamp fields:

    ```js
    function normalizeSummary(s) {
      const { _meta, ...named } = s;
      return JSON.parse(JSON.stringify(named, (k, v) => {
        if (k === 'derived_at' || k === 'last_seen' ||
            k === 'duration_ms' || k === 'at') return undefined;
        return v;
      }));
    }
    ```

    Assert `normalizeSummary(serialResult)` deep-equals
    `normalizeSummary(parallelResult)`. Assert the final state of
    `memos`, `arcs`, `archive_memos`, `rule_candidates`,
    `evidence_ledger`, `persona` is structurally equal between runs.
13. **Failure isolation across layers.** Stub `step-knowledge` to
    throw. Assert: `summary.knowledge === {error: '...'}`, layer-2
    steps run (their `summary.<name>` is present and not an error),
    layer-3 `step-compaction` runs (because its deps "settle", not
    "succeed"). `dreamed_at IS NONE` count is zero post-run (mark ran).
14. **Failure isolation within a layer.** Stub `step-patterns` and
    `step-reflection` (both layer-1) to throw. Assert other layer-1
    steps complete normally, layer 2 and 3 run normally.
15. **Budget exhausted at layer boundary.** Two variants — note that
    in-flight halt-mid-layer is **not** a tested behaviour because the
    scheduler only checks `shouldHalt` *between* layers (§5.2). A
    stubbed step recording a large `cadence_telemetry` row partway
    through layer 1 does not trip anything until the layer-1 → layer-2
    boundary check.

    - **Variant A (budget zero before run).** Seed
      `cadence_telemetry` so `currentBudget.remaining ≤ budget_floor`
      *before* `dreamProcess` is called. Run with
      `parallelism_enabled=true`. Assert: every step in every layer
      has `summary.<name> === {skipped: 'budget_exhausted'}`,
      `runtime:dream.last_halted === 'budget_exhausted'`, no LLM
      calls were dispatched.
    - **Variant B (budget crosses floor during layer 1).** Seed
      `cadence_telemetry` so layer 1 starts above the floor but at
      least one layer-1 step's recorded telemetry pushes the 24-h
      sum below it. Run with `parallelism_enabled=true`. Assert:
      every layer-1 step ran (its `summary.<name>` is a real result,
      not `skipped`) **even** for steps that started after the floor
      was crossed (layer-gated, not per-step); the layer-1 → layer-2
      boundary check fires; layer 2 and layer 3 every step is
      `{skipped: 'budget_exhausted'}`;
      `runtime:dream.last_halted === 'budget_exhausted'`.

15b. **Unified 24-h sum across cadence + dream.** Seed
    `cadence_telemetry` with a mix of cadence consumer rows
    (`step: 'reflection'` from a trigger-eligible single-step run) and
    dream's per-step rows (`step: 'knowledge'` from a parallel-mode
    `dreamProcess`). Call `currentBudget(db, cfg)`. Assert the
    `remaining` value reflects the **sum of both surfaces**, not just
    one, confirming the budget-coupling design from §5.1.
16. **Mark idempotency under partial failure.** Stub `step-arcs` to
    throw; rerun. Assert the mark UPDATE still ran (no `dreamed_at IS
    NONE` after run). Run a second time. Assert the second run sees no
    un-dreamed events and the steps still complete; `summary.knowledge`
    legitimately reports `eligible: 0, promoted: 0, superseded: 0`.
17. **`dreamed_at` barrier.** `step-knowledge` is the only step that
    filters on `dreamed_at IS NONE`. Run `dreamProcess` with one
    pre-recorded undreamed event and an instrumentation hook in
    `step-knowledge` that records the count it observes. Assert: the
    count it sees equals the count seeded at start (not zero — i.e.,
    the mark UPDATE didn't fire while step-knowledge was reading).
    After `dreamProcess` returns, assert `SELECT count() FROM events
    WHERE dreamed_at IS NONE` returns zero.
18. **Persona singleton — serial writes.** Seed an instrumented
    spy on `updatePersonaFields` that records (call timestamp, fields
    set) on each invocation. Run `dreamProcess` with
    `parallelism_enabled=true`. Assert: `step-comm-style` and
    `step-calibration` calls do **not** overlap in wall-clock (their
    `[start, end]` intervals are disjoint). Assert post-run: both
    `persona.comm_style` and `persona.calibration` updated (no
    last-writer-wins — both keys present on the singleton). This is
    the integration counterpart to the DAG edge in §1.2.

### 10.3 — Verification gates

19. **Output equivalence gate.** Wire test #12 into
    `system/runtime/scripts/verify-design-assumptions.js` as a
    boot-time check. Runs only in CI (skip on Kevin's instance to
    avoid an extra nightly dream).
20. **DAG completeness — bidirectional.** A boot-time invariant:
    `setOf(Object.keys(byName))` equals `setOf(Object.keys(DREAM_DAG_DEPS))`
    (symmetric-difference is empty). Both directions matter — see
    test #11's rationale. Implementation:

    ```js
    function assertDagComplete(byName, deps) {
      const a = new Set(Object.keys(byName));
      const b = new Set(Object.keys(deps));
      const missingFromDeps = [...a].filter(k => !b.has(k));
      const missingFromRegistry = [...b].filter(k => !a.has(k));
      if (missingFromDeps.length || missingFromRegistry.length) {
        throw new Error(
          `DAG/registry mismatch: missing from deps=[${missingFromDeps}], ` +
          `missing from registry=[${missingFromRegistry}]`,
        );
      }
    }
    ```

    Failing invariant throws at boot; fail-fast.

## Section 11 — File-by-file changes

**Created:**

- `system/cognition/dream/scheduler.js` — `runDag`, `topoLayers`,
  `chunkByLimit` (§2). ~80 LOC.
- `system/cognition/dream/dag.js` — `DREAM_DAG_DEPS` constant (§4).
  ~20 LOC.
- `system/cognition/dream/step-registry.js` — `byName` map (§4). ~40 LOC.
- `system/cognition/dream/dream-budget.js` — `readDreamConfig`,
  `shouldHalt` (§5). ~30 LOC.
- `system/cognition/dream/telemetry.js` — `recordStepTelemetry(db,
  name, ms, err?)` writing one `cadence_telemetry` row per step
  settle (§8 #1). C3 will likely take this over; until then this is
  the home. ~25 LOC.
- `system/data/db/migrations/0020-dream-dag.surql` — runtime config
  seed (§9.1).
- `system/tests/unit/dream-scheduler.test.js` — §10.1 tests 1–10.
- `system/tests/unit/dream-dag.test.js` — §10.1 test 11.
- `system/tests/integration/dream-parallel.test.js` — §10.2 tests 12–18.

**Modified:**

- `system/cognition/dream/pipeline.js` — rewrite per §3. Preserve the
  serial branch verbatim under `parallelism_enabled === false`. Top-level
  signature unchanged.
- `system/cognition/memory/persona.js` — refactor
  `updatePersonaFields` from `UPSERT persona:singleton MERGE
  ${fields}` to `UPDATE persona:singleton SET <field1> = $v1, <field2>
  = $v2, …` (one SET clause per provided field, built dynamically).
  Closes the cross-process MERGE race between dream and
  `cadence-consumer.js`'s trigger-eligible
  `synthesizeCommStyle`/`setCalibration` dispatches (§1.2 "persona
  MERGE serial"). Prereq: must land before the parallel flag flips on
  Kevin's instance (rollout step 4 in §9.2).
- `system/runtime/scripts/verify-design-assumptions.js` — add gates
  19 and 20 (§10.3).
- `docs/architecture.md` — update the "Dream nightly" item to mention
  layered parallelism; note that the unified `dreamed_at` mark is a
  post-layer barrier.
- `docs/faculties.md` — extend §dream to describe the DAG and the
  three layers; link to this spec.

**Untouched:**

- Every step module (`step-*.js`). C2 is orchestration.
- `dispatch.js`, `cadence-consumer.js`. Trigger-eligible single-step
  runs still go through the heartbeat consumer one at a time.
- `cursors.js`, `budget.js`. The scheduler imports `currentBudget`
  read-only; no changes to budget internals.

## Section 12 — Open questions

These are real ambiguities the design *acknowledges and defers*; not
gaps the author missed.

- **Should `step-compaction` actually depend on
  `step-confidence-recompute`?** The strict-overlap case is empty
  today (compaction's archive predicate filters on `signal_count`, not
  `confidence`). The edge is documentary — encoding a planned tightening
  of the predicate. Alternative: drop the edge, let layer 2 contain
  only `step-scope-cleanup`, and put `step-compaction` in layer 2
  alongside `step-confidence-recompute`. Defer the call to impl time;
  the integration test for output equivalence catches any regression.
- **Per-step concurrency caps.** Some steps (`step-knowledge`,
  `step-reflection`, `step-profile`) make LLM calls; others
  (`step-confidence-recompute`, `step-scope-cleanup`,
  `step-compaction`) don't. The C2 default is a single global
  `max_concurrent` — but a layer with 4 LLM-bound steps and 3
  CPU/DB-bound steps could benefit from separate caps. Defer until
  telemetry shows host rate-limiting.
- **Cross-night re-entry.** `dispatcher-tick.js` already gates with
  `inFlight.add('__dream__')` (one in-flight dream at a time). With
  parallelism, a single dream run is still one in-flight token. If a
  future feature wants two dream runs back-to-back (e.g.,
  morning-after retry of a halted night), the in-flight gate would
  need a version field. Not a C2 concern.
- **Integration with `dispatcher-tick.js`'s overflow fallback.**
  `dispatcher-tick.js:118-127` kicks dream when biographer backlog ≥
  500. Under C2 the overflow-triggered dream now runs in parallel mode
  (assuming the flag is on). The overflow path doesn't pass any extra
  context to `dreamProcess`, so this is mechanically free, but it
  means a backlog-induced dream now runs at full parallel concurrency
  — which might be what we want (drain faster) or might be too
  aggressive on a stressed daemon. Defer telemetry-driven tuning.
- **`max_concurrent` interaction with the embedder.** `step-knowledge`
  calls the embedder via `store.note(...)`. Multiple concurrent
  embedder calls go through `idle-embedder.js` (single embedder
  instance, serialised internally?). Verify at impl time that the
  embedder is safe under parallel callers; if not, `max_concurrent: 1`
  for layer 1 is the conservative default.

## Section 13 — Cost envelope

- Per nightly run (with `parallelism_enabled=true`):
  - +3 `currentBudget` queries (one per layer boundary) — each is the
    same 7-day-rolling-median read the cadence consumer makes once per
    tick. ≈ negligible.
  - +1 `readDreamConfig` query (per run, not per step).
  - +10 per-step telemetry CREATEs (today's pipeline writes zero;
    matches the cadence consumer's per-step write shape).
  - +1 `runtime:dream` upsert (existing — extended with `last_layers`
    and `last_halted` fields; same UPSERT shape).
- Per nightly run, **savings**:
  - Layer-1 wall-clock drops from `sum(seven step durations)` to
    `max(seven step durations)`. For Kevin's instance today, layer 1
    is the LLM-bound steps; a typical drop is the difference between
    summed-and-serial (~120s) and max-and-parallel (~40s). Numbers are
    illustrative; the telemetry from rollout step 5 (§9.2) is the real
    measurement.
- New LLM tokens: **zero**. The same ten steps make the same LLM
  calls; only the wall-clock changes.
- New embedding tokens: **zero**.
- Memory: ten in-flight Promises and per-layer collectibles; <1MB
  transient.
- **Worst-case budget over-shoot (accepted):** ~250k tokens —
  `count(LLM-bound steps in the busiest layer) × per-step cap` ≈ 5 ×
  50k. Layer-gated halting (§5.2) means the layer-1 boundary check
  fires *after* all five LLM-bound layer-1 steps settle, so this
  over-shoot is a property of layer 1, not a bug. Within the daily
  budget for any plausible cadence-friendly split (§5.1 reserves 20%
  for cadence; 80% of a 500k daily budget = 400k, comfortably above
  250k).

Within the post-alpha.16 cost envelope.

## Section 14 — Cross-design notes

- **C1 (biographer batching) is a per-event queue-driven surface.** C2
  is a per-night DAG-driven surface. The two scheduling shapes
  intentionally do not share code: C1's `worker(batch)` runs inside
  `createBiographerQueue` (one batch per tick, FIFO with optional
  dedupe); C2's `runDag` runs inside `dreamProcess` (one DAG per
  night). The two might converge later if a "DAG queue" abstraction
  earns its keep, but at impl time both ship in their natural shape.
- **B1 (per-hit reinforcement)** writes to `recall_log` and
  `evidence_ledger`; neither is read by any dream step except
  indirectly (`step-confidence-recompute` reads `evidence_ledger`).
  B1 lands earlier and is unaffected by C2.
- **Theme 3 (cadence)** owns trigger-eligible step dispatch
  (`reflection`, `comm-style`, `calibration`). Those three steps run
  one-at-a-time through the heartbeat consumer **and** as layer-1
  steps inside dream. C2 does not change the cadence consumer; the
  single-step paths are unaffected.
- **Theme 4 (observability / doctor)** consumes
  `runtime:dream.last_run_at_success` for the doctor's
  freshness rollup. C2 extends `runtime:dream.value` with
  `last_layers` and `last_halted` — additive; the doctor's existing
  freshness check still works. `show_step_health` gets a new view
  (per-layer wall-clock and parallelism factor — §8 #3).

## See also

- **Runtime-hardening R-2 (`runtime:`scheduler.config``).** R-2's
  bucket scheduler runs **periodic tickers** at the daemon level —
  picking which faculty (biographer, dream, doctor, sweep) fires on
  each tick. C2's `runDag` orchestrates step concurrency **within one
  dream tick**. Different concept, different layer, different file:
  R-2 lives in `dispatcher-tick.js`; C2 lives in `dream/scheduler.js`.
  Don't confuse them.
- `2026-05-11-cognition-c1-biographer-batching-design.md` — sibling
  scheduling surface (per-event batching, not per-night DAG).
- `2026-05-11-cognition-b1-per-hit-reinforcement-design.md` — style
  anchor for this spec; producer of `evidence_ledger` rows that
  `step-confidence-recompute` reads.
- `2026-05-11-robin-v2-theme-3-cognition-cadence-design.md` — owner of
  the `daily_token_budget` C2 enforces between layers.
- `2026-05-11-robin-v2-theme-4-observability-design.md` — owner of
  `show_step_health` and doctor rollups that C2 extends.
- `2026-05-11-robin-v2-evolution-roadmap.md` — umbrella; C2 sits in the
  "Cognition cost" track alongside C1 and C3 (telemetry umbrella).
- `system/cognition/dream/pipeline.js` — the file C2 rewrites.
- `system/cognition/dream/budget.js` — `currentBudget`,
  `readCadenceConfig`; C2 reuses the read path.
- `system/runtime/daemon/dispatcher-tick.js` — the daemon-side caller
  of `dreamProcess`; unchanged by C2 except via the new
  `runtime:dream.value` fields it consumes for the next-run cadence.
