# Robin v2 — Cognition C1: Biographer event batching

**Status:** Design (working draft)
**Date:** 2026-05-11
**Umbrella:** `2026-05-11-robin-v2-evolution-roadmap.md` (Cognition cost track)
**Depends on:** nothing structural; lands on top of the current biographer at `system/cognition/biographer/pipeline.js`.

## Why

`biographerProcess(db, embedder, host, eventId, ...)` in
`system/cognition/biographer/pipeline.js` runs **one LLM call per event**
(`invokeWithRetry(host, messages, …)` at lines 109–115). A single long
Claude Code turn can mint dozens of events (Stop hook drains up to 50
pending events per call — see `system/runtime/daemon/server.js:679-686`),
and each one currently re-pays:

- a "fast"-tier LLM call to extract entities + edges + episode signal,
- a fresh entity catalog read,
- a fresh `findActiveEpisode(db, source)` round-trip,
- (when stage 2 escalates) one Stage-3 disambig LLM call per ambiguous
  candidate name,
- per-event runtime row upserts.

Outside of nightly dream, biographer is now the dominant LLM cost. The
events queued in one drain typically share entity vocabulary (same
project, same people, same conversation), so the catalog and the bulk of
the prompt are duplicated work across them.

**C1 goal:** collapse N events from the queue into one LLM call (with
per-event output) while preserving the existing semantics — the 3-stage
entity cascade, episode determination, `evidence_signals`, idempotent
edge writes, race tolerance, and `events.biographed_at` per-event marks.

## Goals

- One LLM call per batch instead of N (typical N = 4–10 from a Stop-hook
  drain; capped).
- Per-event output validation: a malformed entry for event #4 must not
  poison the other 9.
- Dedup entity resolution across the batch: Stage 1 / Stage 2 / Stage 3
  run once per *name*, not once per *mention*.
- Episode boundaries still respect `episode_window_minutes`; a batch can
  cross an episode break without losing the close+open transition.
- Bounded latency: a batched event must still be biographed within a
  small wall-clock window of its arrival (cap below).
- Backward-compat: single-event `biographerProcess` keeps its current
  signature and contract so existing tests (`biographer-pipeline.test.js`,
  `biographer-failure.test.js`, `biographer-dedupe.test.js`) keep
  passing without rewrite.

## Non-goals

- Cross-source batching (CLI + Discord + ingest in one LLM call). Source
  is part of the prompt context, episode lookup is per-source, and
  mixing surfaces would degrade the LLM's signal quality without saving
  meaningful tokens.
- Cross-session event reasoning (`before` edges across batch). The
  current code already declines to emit `before` for a single event;
  batched mode can emit them within the batch (see §6) but does not try
  to stitch to history.
- Streaming mid-batch results. Output is one LLM call → one JSON object
  → fan out.
- Replacing `createBiographerQueue` semantics (FIFO with optional
  dedupe). Only the `worker` it calls changes shape.
- Touching Theme 2a's `evidence_signals` schema — same per-event
  structure carries over to the batched output.

## Anchoring decisions

**Why a windowed accumulator instead of "always batch the whole queue":**

The Stop-hook caller already enqueues up to 50 events in one burst
(`server.js:679-686`). Without a flush window the queue would either
LLM-call them as fast as `createBiographerQueue` ticks (one per turn —
no batching), or wait for the queue to drain fully before any LLM call
(no biographing until the drain ends). A small flush window
(`debounce_ms`) lets the accumulator pick up the burst and call once.

**Why source-scoped batches:**

`findActiveEpisode(db, event.source)` is per-source. The catalog is
global so catalog-sharing is fine across sources, but episode
determination and `occurs_with` semantics tied to "the same surface
talking about the same thing" deteriorate when CLI events and Discord
events are mixed. Splitting by source is a one-line group-by that
preserves intent.

**Why per-event output blocks (array indexed by `event_id`) rather than
one merged output:**

A merged output (one entity set, one edge set, one episode flag for the
batch) collapses semantics: per-event `mentions` edges, per-event `about`
tagging, per-event episode-continuation decisions, and the per-event
`evidence_signals` all want the LLM to think *about each event*. The
prompt asks the LLM to emit one object per input event, indexed by the
event's id. Cross-event signals (`occurs_with` over the batch, `before`
within the batch) can be added in code without asking the LLM to
duplicate them.

**Why "all-or-nothing per LLM-call, individual marks at DB time":**

If the LLM call fails after retries we fall back (see §8); we don't have
partial output to commit. Once the LLM returns and the batch validates,
entity upserts + edges + episode rows are written, and only then are
`biographed_at` marks applied per event. A DB hiccup mid-loop leaves the
unmarked events for the next drain; entity upserts are idempotent (stable
record IDs by `(type, name_lower)`) and edges are composite-ID UPSERTs,
so re-processing is safe.

**Why keep single-event `biographerProcess` exported:**

Tests, the `biographer-catchup` CLI, and `biographer-process-pending`
CLI all loop `biographerProcess(db, e, host, row.id)` over results. We
add a sibling `biographerProcessBatch(db, embedder, host, eventIds[],
opts)` that single-event `biographerProcess` calls with `[eventId]`.
That preserves the old surface bit-for-bit while routing the hot path
through batching.

## Section 1 — Batch trigger

The accumulator sits between `queueWrap.enqueue(id)` in
`system/runtime/daemon/server.js` and the worker. It supersedes the
1-call-per-`enqueue` path inside `createBiographerQueue`.

Three triggers, whichever first:

| Trigger | Default | Notes |
|---|---|---|
| Count threshold | `max_batch_size = 8` | Conservative for "fast"-tier prompt size (see §2 envelope). |
| Time window | `debounce_ms = 750` | Reset on every new `enqueue` until threshold or `max_wait_ms` hits. |
| Hard cap | `max_wait_ms = 3000` | Even if events keep arriving, fire after this many ms since the first event in the current batch. Bounds tail latency for downstream recall / edge counts. Also applies to a "lonely" event — a single event in a quiet bucket waits no more than `debounce_ms` before firing (the debounce timer expires; not the hard cap). |

Source scoping:

- Accumulator keeps **one in-flight bucket per `event.source`**.
- When the daemon enqueues event id `e`, the accumulator reads
  `event.source` first (single-row fetch already done in
  `biographerProcess` step 1; we hoist it to the accumulator).
- Buckets fire independently. CLI burst and a parallel Discord burst
  produce two LLM calls, not one mixed call.

Tunables live in `runtime:biographer.value.batch_config` (a sibling
key on the existing biographer runtime row — its sibling is the
existing `config` object that already holds `stage2_high_threshold`,
`episode_window_minutes`, etc.):

```json
{
  "max_batch_size": 8,
  "debounce_ms": 750,
  "max_wait_ms": 3000,
  "disable": false
}
```

`disable: true` is the rollback bypass (see §9). When set, the
accumulator's `add(id, source)` short-circuits to
`queue.enqueue(id)` directly (skipping the per-source bucket + timers
entirely) and the worker routes the single-id payload through the
pre-C1 `biographerProcess` path.

Re-read on every accumulator flush. A new `DEFAULT_BATCH_CONFIG`
constant in `pipeline.js` provides fallback values; `ensureRuntime`
merges this constant into the stored row on first boot after the
upgrade (additive only — never overwrites operator-set values; see
§13).

Backpressure: a bucket "seals" the instant the accumulator calls
`fire(...)`. While the sealed bucket is in-flight, new events for the
same source open a *new* bucket (per-source). The underlying
`createBiographerQueue` is a single global FIFO — it serialises *all*
fired batches across sources (CLI batch finishes its LLM call before
Discord batch starts). This preserves enqueue order globally and
matches today's single-call serialisation. It also means a slow LLM
call on one source blocks biographing on others — a known cost
inherited from today's queue, not introduced by C1. (A per-source
queue is a possible future optimisation; out of scope.)

## Section 2 — Prompt structure

System prompt grows by one paragraph clarifying that input is now an
array and output must mirror it indexed by `event_id`. Existing rules
(entity types vocabulary, edge vocabulary, episode-continuation rule)
carry over unchanged.

```
You are Robin's biographer. For each event in `events[]`, extract
structured information about the people, places, projects, topics, and
things mentioned, plus their relationships.

Output JSON only, with this exact shape:
{
  "events": [
    {
      "event_id": "<copied from input>",
      "entities": [{ "name": string, "type": "person"|"place"|"project"|"topic"|"thing" }],
      "edges":    [{ "from": entity-name, "type": "...", "to": entity-name }],
      "about":    [entity-name],
      "episode_continues_previous": boolean,
      "episode_summary": string | null,
      "evidence_signals": [{ "memo_id": string, "polarity": "corroborates"|"refutes" }]  // optional
    },
    ...
  ]
}

Rules:
- Output one object per input event, in the same order, with the same event_id.
- Per-event entities/edges/about scoped to that event's content only.
- Names that reference the same real-world thing across events should use
  the SAME spelling so resolution can dedup.
- Prefer names from the existing-entities catalog when applicable.
- episode_continues_previous reflects whether this event continues the
  active episode for the source; the active episode may close mid-batch
  if an earlier event in the batch already broke continuity.
- Be conservative.
```

User-message payload (one user turn, not one per event):

```
Active episode (source=<source>): <summary or "(no summary yet)"> [<id>]

Events:
[
  { "event_id": "events:abc", "ts": "...", "source": "cli", "content": "..." },
  { "event_id": "events:def", "ts": "...", "source": "cli", "content": "..." },
  ...
]

Output JSON only.
```

Catalog stays as a separate cached system block (today
`buildBiographerPrompt` already marks the catalog with `cache_control:
ephemeral` — preserved). Result: catalog tokens are paid once per LLM
call regardless of batch size, and the cache hit rate goes up because
the catalog string is unchanged across consecutive Stop-hook drains.

Token envelope (rough — actual values pinned at impl time):

- Catalog (system block, cached): `config.catalog_size = 100` entries
  × ~6 tokens = ~600 tokens.
- System prompt: ~250 tokens.
- Per event in user payload: full `event.content` (today's single-event
  prompt also passes full content, see `prompt.js:47`). Typical event
  content from CLI/Discord is short (≤ ~600 chars ≈ ~200 tokens);
  envelope/meta ~30 tokens. Budget ~230 input tokens per event for
  planning, with a hard truncate at 2000 chars (~650 tokens) as a
  safety belt for outlier payloads — see §13 implementation note.
- Per event in output: ~150 tokens.

At `max_batch_size = 8` with typical-size events:

- Input: ~600 (catalog) + ~250 (system) + 8 × ~230 (events) ≈ 2700.
- Output: 8 × ~150 ≈ 1200.
- Total round-trip: ~3900 tokens. Comfortably under any provider's
  per-call limit and well within "fast"-tier context.

Worst-case (8 outlier events truncated at 2000 chars): 8 × ~650 input
≈ 5200 + catalog/system ≈ 6050 input + 1200 output ≈ 7250 tokens.
Still bounded.

**Default batch size justification:** the LLM has to reason about each
event independently inside one call; at 8 events its working-memory
load is still moderate. Bigger batches save calls linearly but compound
risk per failure (one malformed output ruins more work). 8 is the
starting point; tunable up if telemetry confirms quality holds.

## Section 3 — Output validation

`validateBiographerOutput` (today in
`system/cognition/biographer/output.js`) becomes the per-event
validator. A new `validateBiographerBatchOutput(o)` wrapper:

1. Checks `o.events` is an array.
2. Builds a set of expected event IDs from the input batch.
3. For each entry: confirms `event_id` is a string and a member of the
   expected set; validates the rest with the existing
   `validateBiographerOutput` (which already knows `entities`, `edges`,
   `about`, `episode_continues_previous`, `episode_summary`,
   `evidence_signals`).
4. Returns `{ ok: true, events: Map<event_id, validated_output>,
   missing: event_id[], malformed: { event_id, error }[] }`.

**Per-entry failure policy:**

- If `o.events` itself is malformed (not an array, JSON parse fails):
  treat as a batch-level failure → fall back per §8.
- If one entry is malformed but others are valid:
  - The valid entries are processed normally.
  - The malformed entry's `event_id` is added to
    `runtime:biographer.failed_event_ids` via the existing
    `recordFailure(db, eventId, error)` flow (same row shape, same
    error message style), and the event is **not** marked
    `biographed_at`. Next drain picks it up; if it fails the same way a
    second time, the per-event single-call fallback (§8) handles it.
  - If the LLM omits an event_id that was in the input
    (`missing[]` non-empty), each omitted id is recorded as
    `missing_in_batch_output` and left unmarked for the next drain.
- The valid subset's DB writes are sequenced as: all entity upserts
  → `store.relateAll` for all edges → the post-batch mark step. The
  mark step groups valid events by their final `episodeIdForEvent`
  (typically 1 group; 2 if an episode broke mid-batch; rarely more) and
  issues **one `UPDATE` per group**:
  `UPDATE events SET biographed_at = time::now(), episode_id = $epId
  WHERE id IN $idsForEpisode AND biographed_at IS NONE`. Each
  per-group UPDATE runs inside a single `withTxRetry`. No per-event
  `UPDATE` loop. This is not a single SurrealDB transaction (see §7 —
  `relateAll` chunks have their own inner BEGIN/COMMIT, and each
  per-episode UPDATE is its own statement); the guarantee is "writes
  happen in this order under `withTxRetry`," and partial-batch failures
  are recovered on re-drain via idempotent semantics described in §7.

Reconciliation with current `recordFailure`:

- Today `recordFailure` writes one `failed_event_ids` entry per event
  plus the most recent `value.last_error` (the raw `error.message`).
- Batched mode calls `recordFailure(db, eventId, err)` once per
  malformed/missing entry (existing function reused — `array::distinct`
  on the runtime field already dedups). The `err.message` is prefixed
  with the failure-kind so `value.last_error` retains the cause:
  `missing_in_batch_output: <event_id>` for entries the LLM dropped,
  and `batch_malformed: <validator-error>` for entries that failed
  per-event validation. Without the prefix the kinds are indistinguishable
  from network/JSON errors written by the single-event path.
- Batch-level LLM failure (all retries exhausted): the *fallback* runs
  per-event (§8); recordFailure happens inside each per-event path as
  it does today.

## Section 4 — Episode determination across a batch

Two surface decisions:

1. **One source per batch (enforced by §1).** No mixed-source episode
   reasoning to handle.
2. **Episodes can break mid-batch.** Today `findActiveEpisode` returns
   one row; we have to honour the case where event #1 closes the
   episode and events #2..N open and extend a new one.

Algorithm (in-code, after the LLM returns and per-event validation
passes):

```
activeEpisode = findActiveEpisode(db, source)        // once at batch start
currentEpisodeId = activeEpisode?.id ?? null
lastEpisodeStart = activeEpisode?.started_at ?? null

for each event in order (sorted by event.ts asc):
  eventTs = new Date(event.ts)
  llmSaysContinues = perEvent.episode_continues_previous
  withinWindow = currentEpisodeId
    ? (eventTs - lastEpisodeStart) / 60000 <= episode_window_minutes
    : false
  if currentEpisodeId && llmSaysContinues && withinWindow:
    episodeIdForEvent = currentEpisodeId
  else:
    if currentEpisodeId:
      closeEpisode(db, currentEpisodeId, {
        endedAt: eventTs,
        summary: perEvent.episode_summary ?? undefined,
      })
    newEp = createEpisode(db, { source })
    currentEpisodeId = newEp.id
    lastEpisodeStart = eventTs   // start at the breaking event's ts
    episodeIdForEvent = currentEpisodeId
```

Property: this exactly reproduces today's single-event behaviour when
`batch.length === 1` (the loop runs once with the same inputs). For
batch.length > 1 the second iteration uses the just-created episode as
`activeEpisode` — *without* re-querying the DB — which is the optimization
relative to "call `findActiveEpisode` N times."

**Semantics of `episode_continues_previous` per entry**:
the prompt frames it as "continues the active episode for this source
*at the time of this event*" — i.e., it answers about continuity from
the event's own perspective. The code interprets it relative to
`currentEpisodeId` at the moment of the loop iteration, which may be
a new episode opened earlier in the batch. So an LLM answer of
`continues_previous=true` for event #3 means "continues whatever
episode is active right now," and the code resolves that to whichever
episode the previous iteration left current. This avoids asking the
LLM to reason about batch-internal closes. The prompt rule in §2
already states "the active episode may close mid-batch if an earlier
event in the batch already broke continuity."

`createEpisode` and `closeEpisode` are existing (`memory/episodes.js`)
and are idempotent enough for our needs: `CREATE` always makes a new
row; `closeEpisode` is an `UPDATE … MERGE` keyed by id. Concurrent
batches on the same source can briefly produce two active episodes; the
next drain's `findActiveEpisode` `LIMIT 1` picks one and the other is
swept by the existing `closeStaleEpisodes` heartbeat (10 min, per
`docs/architecture.md`). Tolerable; documented in §7.

`started_at` divergence note: the DB schema sets
`started_at DEFAULT time::now()` (per `0001-init.surql:127`), so a
newly created episode in this loop carries the wall-clock `now` as its
`started_at`, while the in-code `lastEpisodeStart = eventTs` reflects
the event's `ts`. For batches over fresh events these match closely;
for catchup over very old events they diverge. **Accepted divergence**:
C1 does not change `createEpisode`. The divergence is isolated to the
in-loop window check for the current batch only — the next batch reads
the DB value via `findActiveEpisode` — so it does not accumulate.
A regression test in Phase 7 pins today's behaviour: after a mid-batch
break, the new episode row's `started_at` equals the DB-side
`time::now()` (not the breaking event's `ts`), and the next batch's
window check reads that DB value via `findActiveEpisode`.

**Rejected alternative:** ask the LLM to mark break points. Worse signal
quality (LLM doesn't know `episode_window_minutes`), more prompt tokens
to explain the rule, and harder to test deterministically. The LLM
keeps its current per-event `episode_continues_previous` boolean; the
window check stays in code.

## Section 5 — Entity cascade across the batch

The 3-stage cascade in `upsert-entity.js` is the second-biggest cost
after the main LLM call. Today it runs once per `(name, type)` *per
event*. Batched mode dedups by `(type, name_lower)` across the whole
batch.

Phase 1 — collect:

```
desiredEntities = Map<`${type}__${name_lower}`, { name, type, firstSeenIdx }>
for each (eventIdx, perEvent) in batch.eventsInOrder:
  for each ent in perEvent.entities:
    key = `${ent.type}__${ent.name.toLowerCase()}`
    if !desiredEntities.has(key):
      desiredEntities.set(key, { name: ent.name, type: ent.type, firstSeenIdx: eventIdx })
```

Phase 2 — resolve (each unique key once):

```
keyToId = new Map()
for each [key, { name, type }] in desiredEntities:
  result = await withTxRetry(() => store.upsertEntity(db, embedder, { name, type, host, config }))
  keyToId.set(key, result.id)
```

`store.upsertEntity` already runs the cascade:

- Stage 1: exact `name_lower + type` lookup (cheap; one query each).
- Stage 2: embedding HNSW. The embedder client is called once per
  unique key (today's per-event loop already paid this; the win is
  N-event mentions of "Atlas" → one embedding instead of N).
- Stage 3: Stage-3 disambig LLM call only fires when Stage 2 returns
  `escalate`. Dedup at the key level means at most one Stage-3 call per
  unique candidate name in the batch — already the natural shape.

We do **not** parallelize entity upserts inside one batch. The cascade
inside `upsertEntityCascade` does its own `UPSERT` with a deterministic
record id by `(type, name_lower)` (line 81 — `stableKey =
${type}__${name.toLowerCase()}`). Sequential calls are safe; parallel
calls compete for the same row and rely on UPSERT idempotency. We keep
sequential for predictability.

Phase 3 — fan back out:

```
perEventResolved = []
for each perEvent in order:
  nameToId = new Map()
  for each ent in perEvent.entities:
    key = `${ent.type}__${ent.name.toLowerCase()}`
    nameToId.set(ent.name, keyToId.get(key))
  perEventResolved.push({ perEvent, nameToId })
```

Each event keeps its own `nameToId` for downstream edge emission (so
the per-event `mentions` / `about` edge sets stay event-scoped).

## Section 6 — Edge writes

All edges for the batch concatenate into one `edgeRows` array and ship
in a single `store.relateAll(db, edgeRows)` call. `relateAll` already
chunks at 50 (`RELATE_CHUNK = 50` in `memory/store.js:302`) and wraps
each chunk in `BEGIN/COMMIT`, so this is exactly the shape it was
written for.

Per-event edge sets follow current rules (`pipeline.js:171-205`):

- `mentions`: for each resolved entity in the event → `(eventId, entId,
  'mentions', context=contentSnippet)`. **Per-event scope preserved.**
- `about`: for each name in `perEvent.about` → `(eventId, entId,
  'about')`. **Per-event scope preserved.**
- `works_on` / `participates_in`: from `perEvent.edges` → entity-to-entity.
  **Per-event scope preserved.** `normalizeEdgeKind` (already in
  pipeline.js) handles legacy aliases.

Batch-level edges:

- `occurs_with`: **per-event** in v1. Rationale below.
- `before`: emit `(events:[i].id, events:[i+1].id, 'before')` for
  consecutive pairs *within the same episode* in the batch. Today this
  is dead code (line 207–213) because biographer sees one event. The
  registry already accepts `before` event→event; we just gain the call
  site.

**`occurs_with` design choice:**

Two options were considered:

1. *Per-event*: every ordered pair among that event's resolved entities
   gets one `occurs_with` row. Symmetric counter increments. **Matches
   current behaviour exactly.**
2. *Per-batch*: every ordered pair among *all* resolved entities in the
   batch increments. Wider co-occurrence signal; one mention of Atlas
   in event A and one of Bob in event B counts as co-occurrence.

**Choice: per-event** (option 1). Reasons:

- `occurs_with` weight feeds `step-habits` / dream pattern detection.
  Per-batch widening inflates weights linearly with batch size, biasing
  habits toward "Stop hooks fire often." Per-event keeps the signal
  proportional to actual textual co-mention.
- A behaviour-preserving v1 keeps the migration cheap — entity habits
  built on six months of per-event `occurs_with` history shouldn't see
  a step change in their weights the day batching turns on.
- Cap `cooccur_cap` (default 8) still applies per event. With N=8
  events at the cap, worst case is N × C(8, 2) = 8 × 28 = 224
  `occurs_with` rows; plus per-event `mentions` (≤ N × 8 = 64),
  `about` (≤ N), and entity→entity `works_on`/`participates_in` (~N).
  `relateAll`'s 50-row chunk size means this fans out to ~6 internal
  chunks. Still one *call site* (`store.relateAll(db, edgeRows)`),
  still cheaper than today's per-event `relateAll` per event. The
  chunking is transparent to the caller.

`before` is **batch-internal-only** in v1: pairs of consecutive events
*from the same source within the same final episode*. Code ordering:
§4's episode loop runs first and labels each event with its assigned
`episodeIdForEvent`; §6 then groups events by that label and emits
`before` edges within each group, in `ts` ascending order. No `before`
edge crosses an episode boundary. We do not look across batches.
Cross-batch `before` stitching is left to a future spec (it requires a
per-source "last biographed event in this episode" cursor, not just
batch awareness).

## Section 7 — Idempotency + race

`biographed_at` marks remain per-event. Because different events in
the same batch can land in different episodes (mid-batch break, §4), a
single `WHERE id IN …` UPDATE cannot bind one `episode_id` for all of
them. The mark step instead groups valid events by their final
`episodeIdForEvent` and issues one UPDATE per group:

```
UPDATE events
   SET biographed_at = time::now(), episode_id = $epId
 WHERE id IN $idsForEpisode AND biographed_at IS NONE
```

Typical batches yield one group; mid-batch episode breaks yield two.
Each per-group UPDATE runs inside `withTxRetry`. The UPDATE returns
the rows it actually modified (those whose `biographed_at` was `NONE`
at update time); any input id absent from the returned set was raced
— biographed by another path between our read and our write. Race
counting sums the gap across all per-episode groups. The log extends
the existing single-event message:
`biographer race detected on <raced_count>/<intended_count> events in
batch <batchKey>`, where `batchKey = payload.__queueKey` (see §9 —
`__queueKey = '<source>:<sorted_ids_joined>'`). Raced events are not
re-attempted (they're already biographed); the entity / edge writes
we did for them are redundant but idempotent.

**Idempotent-mark invariant**: for each distinct episode `$epId` in the
batch, exactly one `UPDATE events SET biographed_at = time::now(),
episode_id = $epId WHERE id IN $idsForEpisode AND biographed_at IS NONE`
runs inside `withTxRetry`. The `IS NONE` guard makes the UPDATE safe to
re-run on retry — already-marked events are silently filtered out.

**Race expansion analysis.**

Two daemons biographing the same source is unsupported (the daemon
acquires `paths.data.daemonLock()` — `biographer-process-pending.js:18`
and `biographer-catchup.js:15`). But within one daemon, concurrent
biographer batches *on the same source* can briefly overlap (the
in-process FIFO `createBiographerQueue` keeps them serial today; the
new accumulator must not break that).

Required guarantee: per source, at most one batch is in-flight at a
time. Achieved by keeping `createBiographerQueue`'s serial drain and
making the accumulator's "fire" call go *through* the queue — the
accumulator pushes one "batch token" into the queue, and the queue's
worker resolves the batch and calls `biographerProcessBatch`. The
queue's existing `running` flag (`queue.js:6`) keeps it serial.

Concurrent batches from different sources are fine (no shared episode
state).

Idempotency under retry of a whole batch (e.g., daemon crash mid-write
and the next boot re-queues the unmarked events):

- Entity upserts: deterministic id by `(type, name_lower)` →
  re-running converges.
- Edge writes: composite-ID `INSERT RELATION … ON DUPLICATE KEY UPDATE`
  → re-running increments `weight` for counter kinds (`occurs_with`).
  This **does** mean a half-applied batch followed by a full retry
  would double-count `occurs_with` for the events that already wrote.

Mitigation: write `biographed_at` and the edges in the **same
`withTxRetry` boundary**. `relateAll` already wraps each ≤50-row chunk
in `BEGIN/COMMIT` internally. We add a *post-batch* mark statement
under the same outer retry wrapper: if the mark UPDATE throws, the
whole `withTxRetry` retries; if it eventually fails terminally, the
unmarked events get re-drained next tick. Because edges are
composite-ID UPSERTs, the worst case is one extra `occurs_with` weight
increment on a re-drain after a partial commit (entity upserts
converge, `mentions` / `about` / `works_on` edges are idempotent by
composite id, only the counter edges double-count). Documented cost.

Note: putting edges *and* the mark inside one outer SurrealDB
transaction would be ideal but `relateAll` chunks at 50 with its own
inner BEGIN/COMMIT today (`memory/store.js` line 301 const, function at
line 302). The spec does not redesign `relateAll`; it only orders the
mark statement *after* `relateAll` returns successfully, under the
same outer retry. This is consistent with how the existing single-event
pipeline writes (`pipeline.js:215-217` for edges, `:248-257` for the
mark).

**Per-event `biographed_at` marking is still individual**: the
per-episode `WHERE id IN $idsForEpisode` form (see §3, §7 invariant
above) just batches the writes within an episode group; each event row
still gets its own `biographed_at` timestamp. Tests that count
`SELECT biographed_at FROM events` see no shape change.

**`evidence_signals` ordering**: `addEvidence` rows are append-only and
are *not* idempotent on `(memo_id, source_event, reason)` today.
Calling `addEvidence` before the gated mark UPDATE would double-count
the ledger if the mark fails terminally and the events get re-queued
(the second drain re-runs `addEvidence` and adds another row per
signal). To keep `evidence_signals` consistent with the
"writes-then-mark" ordering used everywhere else, the batched path
calls `addEvidence` **after** the successful per-episode mark UPDATE
returns, inside the same `withTxRetry` flow. (The pre-existing
single-event path at `pipeline.js:222-245` has the same ordering bug;
C1 magnifies the blast radius because one batched call can write N
signals at once. The fix lands in both paths — see Phase 7 of the
plan.)

**Partial-batch DB failure** (entity upserts succeeded, edges partially
wrote, mark step crashed):

- The unmarked events are re-drained next tick.
- The redundant entity upserts converge (idempotent by record id).
- The redundant `mentions` / `about` / `works_on` edges UPSERT to the
  same composite ids — idempotent.
- The redundant `occurs_with` writes increment weight a second time.
  Spec accepts this as the worst-case for partial-batch retry; the
  alternative (track per-edge "committed_in_batch" markers) is too
  much machinery for an unlikely path. The mitigation above keeps it
  rare.

## Section 8 — Fallback

The batched LLM call has three failure modes:

1. **Network / provider error (all 3 retries exhausted).** Single
   `host.invokeLLM` rejection in `invokeWithRetry`.
2. **JSON parse failure at the outer envelope.**
3. **Batch validator rejection** (`o.events` not array, etc.).

In all three: the batch falls back to **single-event mode** by looping
the existing `biographerProcess(db, embedder, host, eventId)` over the
batch's event ids. This:

- Preserves today's recovery shape (per-event retry, per-event
  `recordFailure`, per-event terminal-malformed-JSON behaviour).
- Costs at most N LLM calls — i.e., we're never worse than the
  pre-batching baseline.
- Records a `batch_fallback_reason` on `runtime:biographer.value`
  (`network` | `outer_json` | `batch_validation`) for telemetry.

Per-entry failure inside a successful batch call uses the partial-success
path from §3 (not this fallback) — only the bad entries get
re-attempted next drain.

Telemetry counters (added to `runtime:biographer.value`). The
batched-LLM `response.usage` shape is the existing `invokeLLM` return
contract — `r.usage.input_tokens` / `r.usage.output_tokens` (see
`system/cognition/biographer/pipeline.js:109-115` and
`system/runtime/hosts/claude-code.js:77-94`). Token sums let downstream
queries derive cost-per-batch and cache-hit ratios:

```json
{
  "batches_total": <n>,
  "batches_fallback": <n>,
  "last_batch_size": <n>,
  "last_fallback_reason": "network" | "outer_json" | "batch_validation",
  "last_fallback_at": <iso>,

  "events_biographed_via_batch": <n>,
  "events_biographed_via_fallback": <n>,

  "batch_input_tokens_total": <n>,
  "batch_output_tokens_total": <n>,
  "last_batch_input_tokens": <n>,
  "last_batch_output_tokens": <n>
}
```

`events_biographed_via_batch` increments by `validEvents.length` on a
successful batched call; `events_biographed_via_fallback` increments by
the count of events that the per-event fallback successfully biographed.
Their ratio is the headline cost-savings metric ("how many events did
we biography through the batch hot path vs. fall back to single
calls"). Token sums update only on the successful batched call (the
per-event fallback path already updates its own `last_run_at` on each
single call but does not need separate counters — the existing
single-event behaviour is preserved). See §11 for example SurrealQL
that reads the recent-window averages.

## Section 9 — Backwards-compat

**Export surface after C1:**

- `biographerProcess(db, embedder, host, eventId, opts)` — *kept,
  unchanged signature*. Internally becomes a one-line wrapper:
  `biographerProcessBatch(db, embedder, host, [eventId], opts).then(r =>
  r.perEvent[String(eventId)])`. Existing tests pass without
  modification. The CLI commands (`biographer-catchup`,
  `biographer-process-pending`) keep their per-event loops; performance
  there is non-critical (catchup tools), and rewriting them is left to
  a follow-up.
- `biographerProcessBatch(db, embedder, host, eventIds, opts)` — **new**.
  Public so the daemon accumulator and future call sites can use it
  directly.
- `createBiographerQueue` — *small additive change*. Its worker now
  receives either a single-id payload (current shape; from MCP-tool
  callers) or a batch payload object `{ kind: 'batch', source,
  eventIds, __queueKey }` (from the accumulator). The dedupe map keys
  on `payload.__queueKey` when present and on `payload` itself
  otherwise — exactly preserving the current dedupe behaviour for
  single-id payloads. Existing tests in `biographer-queue.test.js`
  pass single-id payloads and don't exercise `__queueKey`, so they
  continue to work unchanged. See the daemon-wiring snippet below for
  the exact key shape.

**Daemon wiring change** (in `system/runtime/daemon/server.js` around
lines 237–261):

```js
const queue = createBiographerQueue({
  worker: async (payload) => {
    const e = await idleEmbedder.get();
    const h = await getHost();
    if (Array.isArray(payload?.eventIds)) {
      // Pass __queueKey through opts so the race-warn log can quote the
      // batch identity (see §7 idempotent-mark invariant).
      await biographerProcessBatch(dbHandle, e, h, payload.eventIds, {
        __queueKey: payload.__queueKey,
      });
    } else {
      // single-id payload — for MCP-tool callers that bypass the accumulator.
      await biographerProcess(dbHandle, e, h, payload);
    }
  },
  dedupe: true,    // unchanged; see "queue dedupe" below
});

const accumulator = createBatchAccumulator({
  config: () => readBatchConfig(dbHandle),       // runtime:biographer.batch_config
  fire: (eventIds, source) => {
    const sorted = [...eventIds].sort();
    const payload = {
      kind: 'batch',
      source,
      eventIds: sorted,
      // batchKey = source + ':' + sorted eventIds joined; stable across
      // duplicate-fire of the same batch.
      __queueKey: `${source}:${sorted.join(',')}`,
    };
    return queueWrap.enqueue(payload);
  },
});
```

Updates needed in `queueWrap` and `createBiographerQueue`:

- `createBiographerQueue`'s dedupe map keys on the payload's
  `__queueKey` if present, else on the payload value itself (today
  it's an event-id string — keeps current single-id behaviour).
- `queueWrap.enqueue` accepts a payload object (today it takes
  `String(id)`). Pure shape change; the wrapper still records
  `lastBiographerRunAt` on the promise's `then`.

The two main enqueue sites in `server.js`
(`pendingRows` loop at 682–686 inside the
`/internal/biographer/process-pending` handler, and
`/internal/remember` at 709) switch from `queueWrap.enqueue(id)` to
`accumulator.add(eventId, source)`. The accumulator needs the source
for each id:

- `pendingRows` path (line 680): change the SELECT to include
  `source` (`SELECT id, ts, source FROM events WHERE biographed_at
  IS NONE ORDER BY ts ASC LIMIT 50`) — one extra column on an
  already-running query, zero round-trip cost.
- `/internal/remember` path (line 709): the source is in
  `body.source` (read at line 704 — already destructured from the
  request body). Pass it through.

The two MCP-tool call sites
(`createRunBiographerTool` at 394 and another at 402) pass
`queueWrap.enqueue` as a `processor` callback. **They keep the
single-id path** (one MCP-triggered event is not a batch candidate);
the queue's `Array.isArray(payload?.eventIds)` branch above routes
single-id payloads through the old `biographerProcess` directly. This
is intentional: MCP `run_biographer` is a manual/test tool and should
keep its current semantics.

**Hard-cut versus gradual rollout:** hard-cut to batched as the default
path *with* the single-event fallback still wired through the same
worker. There's no flag-flip period; the fallback covers correctness.

Tunables (`runtime:biographer.batch_config`) provide two rollback levers:

- `max_batch_size = 1` makes every batch degenerate to N=1, so each LLM
  call carries one event. Events still flow through the accumulator
  (paying the bucket + debounce/cap timer cost) before reaching the
  queue.
- `disable: true` short-circuits the accumulator entirely:
  `accumulator.add(id, source)` calls `queue.enqueue(id)` directly,
  bypassing the bucket and timers. The worker's
  `Array.isArray(payload?.eventIds)` check then routes the single-id
  payload through the existing `biographerProcess` path. This is the
  true bypass — useful when debugging the accumulator itself or when
  the operator wants the pre-C1 behaviour byte-for-byte.

The `batch_config` row defaults to `disable: false`. Both knobs are
re-read per flush.

## Section 10 — Test plan + rollout

New unit tests (`system/tests/unit/`):

- `biographer-batch-accumulator.test.js`
  - count threshold fires at N events
  - debounce fires after silence
  - hard cap fires even under sustained input
  - source separation: CLI + Discord enqueued interleaved produces two
    independent fires
  - in-flight bucket doesn't accept new events mid-flight
- `biographer-batch-validate.test.js`
  - well-formed batch with 3 entries → ok, 3 entries
  - missing event_id in output → recorded as missing
  - malformed event in output → recorded as malformed, others ok
  - non-array `events` → batch-level fail
  - extra event_id in output (not in input) → ignored
  - existing single-event validator semantics still apply per entry

New integration tests (`system/tests/integration/`):

- `biographer-batch-pipeline.test.js`
  1. **Equivalence with N=1:** record one event, drive batch path with
     `[evt.id]`; assert results equal the existing
     `biographer-pipeline.test.js` "single event end-to-end" assertions
     byte-for-byte (entity count, edge counts, episode marker,
     `biographed_at` set).
  2. **Cross-event entity dedup:** record three events all mentioning
     "Atlas"; assert exactly one Atlas entity row, one upsertEntity
     call per name (mock the cascade), three `mentions` edges, one
     `about` edge if applicable per event.
  3. **Episode break mid-batch:** events at t, t + 5min, t + 45min;
     LLM marks event #3 `episode_continues_previous=false`. Assert two
     episodes, event #3 in the new one, event #1+#2 in the old one
     (closed).
  4. **Per-event failure isolation:** LLM returns valid output for
     events #1, #2, #4, #5 and malformed for #3 (e.g., entity.type =
     "unicorn"). Assert: events #1, #2, #4, #5 biographed; event #3
     unbiographed, added to `failed_event_ids`; entity rows from valid
     events present.
  5. **Outer JSON failure → fallback:** LLM returns `"not json"`.
     Stub fallback to count single-event calls. Assert N single-event
     calls happen, `batches_fallback` increments.
- `biographer-batch-race.test.js`
  - Two batches for the same source enqueued concurrently → queue
    serialises them, no double-mark, idempotent edges (`occurs_with`
    weights add up to the expected sum across the two batches without
    double-counting within one).
- `biographer-batch-occurs-with.test.js`
  - Batch of 3 events each mentioning {Alice, Bob, Atlas}. Assert
    `occurs_with` weight on (Alice, Bob) === 3 (one per event,
    per-event semantics — option 1 from §6).

Modified tests:

- `biographer-queue.test.js`: **no change needed**. Existing tests pass
  string ids and rely on the dedupe map keying on the value itself —
  which still works under the additive `__queueKey` shortcut in §9.
  A new test is added below covering the batch-payload key path.

Added test:

- `biographer-queue.test.js` (additive case): a payload with
  `__queueKey = 'cli:e1,e2'` enqueued twice in a row is deduped to one
  worker call; two payloads with different `__queueKey` (e.g.,
  different sources) run independently.

Rollout sequence:

1. **PR 1 — accumulator only**: introduce `createBatchAccumulator`
   with tests; not yet wired into the daemon. No behaviour change.
2. **PR 2 — batch pipeline**: `biographerProcessBatch` (loops
   single-event internally to start). Validate equivalence. Still
   one LLM call per event in this PR.
3. **PR 3 — batched prompt**: switch `biographerProcessBatch` to issue
   one LLM call with the batched prompt shape from §2 + per-event
   validator (§3) + cascade dedup (§5). Wire the accumulator into the
   daemon enqueue sites. Hard-cut.
4. **PR 4 — `before` edge + telemetry counters**: emit batch-internal
   `before` edges (§6) and the full telemetry suite on
   `runtime:biographer.value` — `batches_total`, `batches_fallback`,
   `last_batch_size`, `last_fallback_reason`, `last_fallback_at`,
   `events_biographed_via_batch`, `events_biographed_via_fallback`,
   `batch_input_tokens_total`, `batch_output_tokens_total`,
   `last_batch_input_tokens`, `last_batch_output_tokens` (§8).
   `DEFAULT_BATCH_CONFIG` tunables already shipped in PR 3; this PR
   exposes the per-PR telemetry surface for later analysis.

Each PR is independently revertable. PRs 1–2 are no-op behaviourally;
PR 3 is the real switch.

## Section 11 — Cost envelope

Per Stop-hook drain of N events (assume N=8, the default batch size):

| Quantity | Pre-batching | Batched | Delta |
|---|---|---|---|
| LLM "fast" calls (biographer main) | 8 | 1 | **−7** |
| LLM "fast" calls (stage-3 disambig) | ≤ 8 (one per ambiguous name per event) | ≤ U (one per unique ambiguous name) | typically **−4 to −7** |
| Catalog reads | 8 | 1 | −7 |
| `findActiveEpisode` queries | 8 | 1 | −7 |
| Embedder calls (entity surface) | one per new-or-unresolved name across all events (cascade Stage 2 only) | one per unique new-or-unresolved name in the batch | small win when same name reappears across events |
| `relateAll` chunks (DB round-trips) | 8 (one per event, ~1 chunk each) | ~3–6 (one batched call, internal chunking) | net negative |
| `recordFailure` writes (worst case) | per-event | per malformed entry | unchanged at worst |
| `runtime:biographer` writes | 8 | 1 | −7 |

Tail latency cost: at most `max_wait_ms = 3s` between event arrival and
biographing. Downstream recall sees the entity after that delay. Within
the heartbeat-driven recall cadence (60s ticks for habits) this is
negligible; for immediate `recall` MCP calls from the agent it's a one-
to three-second freshness lag that did not exist before. **Documented
trade-off.**

Token envelope: §2 shows total ≈ 3900 tokens at N=8 vs ≈
8 × (~600 catalog + ~250 system + ~230 input + ~150 output) ≈ 9840
tokens for today's 8-call sequence. ~60% total-token reduction
(driven mostly by catalog + system block dedup), in addition to the
7× call reduction. Prompt-cache hits across consecutive drains shave
more off the input side; current single-event prompt also benefits
from cache but pays a per-call invocation overhead that batching
eliminates.

**Recent-window telemetry queries** (use these in a 1-week health
check; the counters land via §8 telemetry):

```surql
-- Average batch size + average input tokens per batch:
SELECT
  (value.events_biographed_via_batch    / value.batches_total) AS avg_batch_size,
  (value.batch_input_tokens_total       / value.batches_total) AS avg_input_tokens,
  (value.batch_output_tokens_total      / value.batches_total) AS avg_output_tokens,
  (value.batches_fallback               / value.batches_total) AS fallback_ratio,
  (value.events_biographed_via_batch    /
    (value.events_biographed_via_batch + value.events_biographed_via_fallback)) AS batch_share
FROM runtime:biographer LIMIT 1;
```

`batch_share` close to 1 confirms the hot path is dominated by batched
calls; a falling `avg_batch_size` over a week signals the
`max_batch_size` cap is leaving headroom (consider bumping). A rising
`fallback_ratio` (> 0.05) signals prompt-shape or output-shape issues
that need investigation.

## Section 12 — Verification gates

1. **Equivalence at N=1:** existing
   `biographer-pipeline.test.js`'s "single event end-to-end" assertions
   pass when driven through `biographerProcessBatch(db, e, host,
   [evt.id])`. Same entity count, same edge counts, same `episode_id`.
2. **Cross-event entity dedup:** N events mentioning the same entity
   produce one entity row; `upsertEntity` is invoked once per unique
   `(type, name_lower)` in the batch.
3. **Per-event output isolation:** one malformed entry among N valid
   ones biographes the N-1 valid events and adds the malformed event
   id to `runtime:biographer.failed_event_ids` exactly once.
4. **Episode break mid-batch:** an LLM-marked episode break inside the
   batch closes the active episode at the breaking event's `ts` and
   opens a new episode containing the remaining events.
5. **Source separation:** interleaved CLI + Discord enqueues produce
   two LLM calls, each with its source's events only.
6. **Fallback on outer JSON parse:** LLM returns non-JSON → N
   single-event calls run, `batches_fallback += 1`, `last_fallback_reason
   = 'outer_json'`.
7. **Fallback on retries exhausted:** LLM throws on all 3 retries → N
   single-event calls run, `batches_fallback += 1`, `last_fallback_reason
   = 'network'`.
8. **`occurs_with` per-event semantics preserved:** batch of 3 events
   each mentioning {Alice, Bob} produces `weight = 3` on the (Alice,
   Bob) edge, identical to running three single-event pipelines.
9. **Idempotent batch retry:** simulated DB hiccup at the mark step
   (the `UPDATE events SET biographed_at` throws after `relateAll`
   succeeded); next drain re-runs the same event ids. Final state:
   entity rows count unchanged, `mentions` edge count unchanged,
   `about` edge count unchanged, `works_on` edge count unchanged.
   `occurs_with` weights may be doubled for affected pairs (documented
   cost from §7; assert weight ≤ 2× baseline).
10. **Race serialisation:** the queue's `worker()` is never called twice
    concurrently for the same source. Verified by instrumenting an
    in-test `createBiographerQueue({ worker })` with a peak-inflight
    counter and asserting `peakInflight === 1` after two batches enqueue
    concurrently. All events in both batches end up biographed exactly
    once (no duplicate `biographed_at` updates, no double-emitted
    `mentions` rows for the same `(event, entity)` pair).
11. **`before` edges within batch:** consecutive events in the same
    final episode produce a chain of `before` edges connecting them
    in `ts` order; no `before` edges cross an episode boundary.
12. **Tunable disables batching:** two tunables let operators dial back.
    `max_batch_size = 1` collapses every batch to N=1 — one LLM call per
    event, no `before` edges within batch — but events still pay the
    accumulator round-trip. `disable: true` is the full bypass:
    `accumulator.add(id, source)` short-circuits to `queue.enqueue(id)`
    directly, skipping the bucket + debounce/cap timers; the worker
    routes the single-id payload through the pre-C1
    `biographerProcess` path, restoring byte-for-byte the prior
    behaviour. Use `disable: true` for incident rollback;
    `max_batch_size = 1` for debugging.

## Section 13 — File-by-file changes

**Created:**

- `system/cognition/biographer/accumulator.js` —
  `createBatchAccumulator({ config, fire })` with `add(eventId, source)`,
  internal timers + buckets. The `config` callback returns the current
  `runtime:biographer.value.batch_config` merged with
  `DEFAULT_BATCH_CONFIG` fallbacks; the accumulator does not query
  the DB directly (keeps it test-friendly).
- A new `readBatchConfig(db)` helper in `pipeline.js` (exported) that
  the daemon-wiring code calls to construct the accumulator's
  `config` callback. Reads + caches (5s TTL) so flush-time access is
  cheap.
- `system/cognition/biographer/batch-output.js` —
  `validateBiographerBatchOutput(o, expectedIds)` wrapping
  `validateBiographerOutput`.
- `system/cognition/biographer/batch-prompt.js` —
  `buildBiographerBatchPrompt({ events, catalog, activeEpisode })`
  (parallel to `prompt.js`'s `buildBiographerPrompt`). Truncates each
  event's `content` at 2000 chars before including in the user payload
  (safety belt for outlier events; current single-event prompt does
  not truncate but events at that scale are rare).
- `system/tests/unit/biographer-batch-accumulator.test.js`
- `system/tests/unit/biographer-batch-validate.test.js`
- `system/tests/integration/biographer-batch-pipeline.test.js`
- `system/tests/integration/biographer-batch-race.test.js`
- `system/tests/integration/biographer-batch-occurs-with.test.js`

**Modified:**

- `system/cognition/biographer/pipeline.js` — extract the existing
  body into a private `_processOne` helper, add
  `biographerProcessBatch(db, embedder, host, eventIds, opts)`, rewrite
  exported `biographerProcess` as a wrapper. Add `recordFailure` reuse
  for per-entry batch failures with kind-prefixed error messages
  (`missing_in_batch_output:` / `batch_malformed:`). Add telemetry
  counter writes (`batches_total`, `batches_fallback`,
  `last_batch_size`, `last_fallback_reason`, `last_fallback_at`,
  `events_biographed_via_batch`, `events_biographed_via_fallback`,
  `batch_input_tokens_total`, `batch_output_tokens_total`,
  `last_batch_input_tokens`, `last_batch_output_tokens`) onto the
  existing `runtime:biographer.value` row (no schema change — the row
  is a flexible `value` object today). The token sums read from
  `response.usage.input_tokens` / `response.usage.output_tokens` —
  the existing `invokeLLM` return shape (see
  `system/runtime/hosts/claude-code.js:77-94`).
- New `DEFAULT_BATCH_CONFIG` constant in `pipeline.js` with
  `max_batch_size`, `debounce_ms`, `max_wait_ms`. The existing
  `DEFAULT_CONFIG` is untouched — `batch_config` is a sibling, not a
  rename. `ensureRuntime`'s early-return at
  `if (existing?.config) return existing` means installs that already
  have `runtime:biographer` will *not* pick up `batch_config`
  automatically. We update `ensureRuntime` to **merge** missing keys
  (`batch_config` etc.) into the stored value (additive only — never
  overwrites operator-set values), so existing installs get the
  defaults on first boot after the upgrade. Tested as part of
  `biographer-batch-pipeline.test.js`.
- The accumulator reads `runtime:biographer.value.batch_config` on
  every flush. If unset for any reason, it falls back to
  `DEFAULT_BATCH_CONFIG` in code so the daemon can boot even if the
  merge above hasn't run yet.
- `system/cognition/biographer/output.js` — no changes; per-entry
  validator stays the same shape.
- `system/cognition/biographer/queue.js` — internal change only: the
  dedupe map keys on `payload.__queueKey` when present, otherwise on
  the payload value itself. No exported-API shape change; existing
  single-id payloads behave identically. See §9. **R-1 coordination**:
  the runtime-layer-hardening plan (R-1) adds `maxPending` canary +
  `skippedSinceBoot` accessors to this file on a parallel branch. The
  C1 edit must be additive: introduce a `dedupeKey(payload)` helper
  and route the dedupe-map key through it. Do **not** rewrite the
  whole file — preserve R-1 fields if they have already landed.
- `system/runtime/daemon/server.js` — wire the accumulator between
  the two enqueue call sites (lines 683 and 709) and the queue
  worker. Extend the pending-events `SELECT` at line 680 to include
  `source`, so per-id pre-fetch is not needed. Update `queueWrap` to
  accept payload objects (not just `String(id)`) per §9. The MCP-tool
  enqueue sites at 394/402 continue to pass single-id payloads.
  **R-3 coordination**: if the runtime-layer-hardening plan's R-3 has
  already split `server.js` into per-route modules
  (see `docs/superpowers/plans/2026-05-11-runtime-layer-hardening.md`),
  the same conceptual edits land in different files instead — queue +
  `queueWrap` wiring moves to `boot.js`, the Stop-hook drain handler
  to `routes/biographer.js`, the `/internal/remember` enqueue to
  `routes/remember.js`. Detect with
  `test -f system/runtime/daemon/routes/biographer.js`; if R-3 has
  shipped, edit in the new file homes using the `handler({ ctx, body })`
  signature R-3 introduces.
- `docs/architecture.md` — "A typical agent turn" step 6 updated to
  mention batching and `max_batch_size`.
- `docs/faculties.md` — biographer section: batch trigger summary,
  per-event isolation, fallback path.

## Section 14 — Open questions

- **`max_batch_size` default value (8 vs 10).** Pinning at 8 keeps
  prompt comfortably small and reduces blast radius of a single
  malformed output. Telemetry from production drains can justify 10
  or 12 after a week.
- **Should `biographer-process-pending` / `biographer-catchup` CLI
  commands also batch?** They loop today and aren't latency-critical,
  but a long-deferred catchup hits the same LLM-call cliff. Cheapest
  win: have those CLIs build a list and call
  `biographerProcessBatch` in chunks of `max_batch_size`. Left out of
  the C1 hard-cut scope (no behaviour change to the daemon's hot path
  needed); easy follow-up.
- **Cross-batch `before` edges.** Stitching the last event of batch K
  to the first event of batch K+1 (same source, same episode) would
  give a fuller temporal chain. Requires a per-source "last
  biographed event" cursor. Defer.
- **Per-batch evidence-ledger writes.** Theme 2a's `evidence_signals`
  output stays per-event; nothing to change. But should the LLM be
  *allowed* to emit batch-level evidence ("event A refutes memo M,
  and so do events B and C")? Cheaper to keep per-event; revisit only
  if telemetry shows the LLM is wasting tokens redundantly tagging
  the same memo across events in one batch.

## See also

- `2026-05-11-robin-v2-evolution-roadmap.md` — umbrella, cognition
  cost track.
- `2026-05-11-robin-v2-theme-2a-evidence-ledger-design.md` — supplies
  the per-event `evidence_signals` field that carries through this
  spec unchanged.
- `2026-05-11-robin-v2-theme-3-cognition-cadence-design.md` — sibling
  cost-control work for trigger-eligible dream steps.
- `system/cognition/biographer/pipeline.js` — the file this spec
  refactors.
- `system/cognition/biographer/queue.js`, `system/runtime/daemon/server.js`
  — the queue + daemon wiring touched by the accumulator change.
