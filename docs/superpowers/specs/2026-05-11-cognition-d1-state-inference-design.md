# Robin v2 — D1: state_inference activation

**Status:** Design (working draft)
**Date:** 2026-05-11
**Umbrella:** `2026-05-11-robin-v2-evolution-roadmap.md` (D-series — cognition layer activations)
**Depends on:** alpha.16 themes already merged (1b arcs, 2a evidence ledger, 3 cadence, 4 introspection).
**Branch target:** `refactor/system-restructure` (already on the new `system/cognition/` tree).

## Why

`memos.kind = 'state_inference'` is registered in
`system/cognition/memory/kind-registry.js` lines 31–37 (today: `required: ['content', 'derived_by']`, optional `meta.dimension`, `meta.from_signal`) but no faculty produces it. The intuition pipeline composes a `<!-- relevant memory -->` block that reads like a soup of related events plus knowledge memos — the agent has to do the work of inferring "what is the user up to right now?" from that soup.

The biggest perceived-capability bump on the table is to make that inference Robin's job. The first line the agent reads at every `UserPromptSubmit` should be:

```
<!-- current focus -->
[focus, last active 23m ago, conf 0.80] Kevin is iterating on the cognition
layer refactor in robin-assistant-v2 — arc:01J… , 4 episodes, 9 events in
last 24h.
<!-- /current focus -->
```

Same `<!-- relevant memory -->` block follows underneath, unchanged.

## Goals

- Stand up `state_inference` as a first-class memo kind with at least one writer (a faculty), one half-life, one consumer (intuition), one introspection surface.
- Make the inference *cheap by default*: short-circuit the LLM when nothing material has changed since the last write.
- Surface the inference as a privileged context block above `<!-- relevant memory -->` under a small dedicated token cap.
- Hold the line on cost: zero net increase in steady-state LLM tokens when the user's focus hasn't moved; capped O(1) calls per heartbeat tick otherwise.
- Roll out behind a runtime flag with telemetry-only mode.

## Non-goals

- Predicting the *next* focus (foresight's job).
- Maintaining a queue of past focuses or "focus history" beyond `supersedes` lineage. The full audit trail is the memo chain itself.
- Replacing `attention.getAttention()` — that lens stays, and is in fact the primary input.
- A general-purpose "agent state" — `state_inference` here means *what the user is currently working on*. Other dimensions (mood, energy, time-of-day-pattern) are deferred; the `meta.dimension` field is already in the registry so they can land later without schema work.
- Cross-source consolidation (e.g., "Kevin is working on X across Claude Code + Cursor"). Per-source first; multi-source consolidation is a follow-up under the same `dimension` machinery.

## Anchoring decisions

**Why one inference per source (`source = 'agent:claude-code'`, `source = 'agent:gemini-cli'`, etc.) rather than a global singleton or top-K concurrent focuses:**

- An agent turn happens inside *one* source. The hook (`system/cognition/intuition/handler.js`) doesn't know what other sources are active. Showing focuses for sources the agent isn't running in is noise.
- One-per-source maps cleanly to the existing `episodes.source` model and to `attention.getAttention({ source })` which already takes the same parameter.
- Top-K concurrent within a source is over-engineered for v1; one privileged "what you're working on right now" is the high-value signal. If the data shows the user reliably context-switches mid-session, we revisit (open question §12).

**Why a faculty (separate writer) over a substrate lens:**

- The inference is produced by writing through `store.note(db, embedder, 'state_inference', ...)`. The `state_inference.js` lens (created by this spec) is a thin wrapper around `store.note` + a read API; the actual *computation* is a faculty.
- Following the two-name convention from `docs/faculties.md` lines 6–8: code does, data is. The data is `kind='state_inference'`; the code is the internal job (`jobs/internal/state-inference.js`) plus the lens (`memory/state_inference.js`). We deliberately do **not** make it a dream step — see "Why heartbeat-driven" below.

**Why heartbeat-driven, *not* a nightly dream step and *not* a cadence trigger:**

- Nightly is too stale — a focus inference at 4 AM and surfaced at 10 AM is useless. The label "last active 23m ago" is the whole point.
- Cadence triggers (`dream_triggers` consumed by `cadence-consumer.js`) are designed for *event-driven* cognition (prediction resolved, correction landed). State inference is driven by *time + change detection* — the natural fit is a heartbeat-paced job, like `close-stale-episodes` (10 min cadence) but with its own slower interval.
- Concretely: a new `state-inference` internal job, paced at one tick per 5 minutes per source, gated by a cheap "has anything material changed?" check. The check decides whether to invoke the LLM. Most ticks: no-op.

**Why the LLM (a small fast-tier call) over a pure template:**

- Template-only: cheap, but the framing of "Kevin is iterating on the cognition layer refactor" is exactly what makes this high-perceived-capability. A template would produce something like "active arc: cognition-refactor; entities: store.js, dream-pipeline; recent events: 4" — useful, but not the headline.
- LLM-only-every-tick: too expensive (one call every 5 min × N sources × indefinitely).
- Recommended: **LLM call, gated by an entity-set-delta + episode-progress check**. If the delta is empty *and* `last_inference.last_active_at` is within the look-back window, no call. If the delta is non-empty *or* the look-back window has expired, one fast-tier call. Steady state = no calls; active work = ≤1 call per heartbeat-job period (5 min).

**Why store as a memo (not a `runtime:` row):**

- `runtime:` is for tunables and ephemeral KV (config, cursors, daemon state). State inferences want lineage (`derived_from` → contributing events/arcs), provenance (`supersedes` → prior inference), evidence-ledger participation (corroborate when the next biographed events fit the inference; refute when they pivot), recall surface (an introspection MCP tool reads the latest).
- All of that is what `memos` is for. `runtime:state_inference.latest_by_source` is unnecessary indirection; a small kind-+-meta-+-source filter on `memos` is enough.

## What a state_inference is

**Shape.** A `memos` row with:

| Field | Type | Source |
|---|---|---|
| `kind` | `'state_inference'` | hardcoded |
| `content` | `string` | LLM short narrative, ≤ 240 chars |
| `confidence` | `float` ∈ [0, 1] | LLM-emitted, clamped |
| `derived_by` | `'state-inference'` | faculty name |
| `scope` | `'global'` (default) — see §6 | caller |
| `tags` | `[]` | reserved for future |
| `meta.dimension` | `'current_focus'` (v1 fixes this) | hardcoded for v1 |
| `meta.source` | `'agent:claude-code'` etc. | from the heartbeat job's per-source loop |
| `meta.entities` | `string[]` record refs | top-N entities from attention lens |
| `meta.arc_id` | `string \| null` | record ref of the dominant active arc, if any |
| `meta.evidence_snippet` | `string` ≤ 120 chars | one-line excerpt from the most recent biographed event |
| `meta.last_active_at` | `datetime` | the max `ts` over `meta.entities`-and-arc-grounding events |
| `meta.from_signal` | `string[]` | which inputs fired — e.g. `['attention', 'arcs', 'biographer']` |
| `meta.signal_hash` | `string` | sha256 of the inputs at write time; the change-detect gate compares the new hash to `prior.meta.signal_hash` |

`subjects` (= `about` edges): emitted for each entity in `meta.entities`. Same shape as a knowledge memo about that entity.

`lineage` (= `derived_from` edges): pointing to up to 5 recent contributing events (top by recency among those that touch the entities/arc).

**Examples** (illustrative content; exact phrasing is LLM-shaped):

1.
   - `content`: "Kevin is iterating on the cognition layer refactor in robin-assistant-v2, currently shaping a state_inference faculty design spec."
   - `confidence`: `0.82`
   - `meta.dimension`: `'current_focus'`
   - `meta.source`: `'agent:claude-code'`
   - `meta.entities`: `['entities:robin_assistant_v2', 'entities:state_inference', 'entities:cognition_refactor']`
   - `meta.arc_id`: `'arcs:01HZ…cognition-refactor'`
   - `meta.evidence_snippet`: "wrote `step-state-inference.js` design spec; reviewing kind-registry entry"
   - `meta.last_active_at`: `2026-05-11T18:37:12Z`
   - `meta.from_signal`: `['attention', 'arcs', 'biographer']`

2.
   - `content`: "Kevin is debugging an HNSW kNN timeout under filtered recall in robin-assistant-v2; comparing knn_overfetch tuning."
   - `confidence`: `0.66`
   - `meta.arc_id`: `null` (no qualifying arc yet)
   - `meta.from_signal`: `['attention', 'biographer']`

3.
   - `content`: "Kevin is reviewing the askrobin.io VM bootstrap script — pivoted from cognition layer ~12 min ago."
   - `confidence`: `0.45` (low — the pivot just happened, evidence shallow)
   - `meta.from_signal`: `['attention']`
   - Note: example 3 deliberately illustrates the *low-confidence* boundary; the surfacing rule (§4) will suppress this one.

## Section 1 — Production faculty

### 1.1 Where it lives

- New file: `system/cognition/jobs/internal/state-inference.js` — the heartbeat-paced job entry point (`evaluateStateInference(db, host, embedder)`).
- New file: `system/cognition/memory/state_inference.js` — the lens. Exports `latestForSource(db, source)`, `listRecent(db, opts)`, `noteStateInference(db, embedder, input)` (thin wrapper that bakes `kind='state_inference'` into `store.note`).
- Modified: `system/runtime/daemon/server.js` — register the heartbeat interval (mirrors the `close-stale-episodes` and `action-trust-decay` blocks at lines 607–636).

### 1.2 Cadence

- Mounted as a `setInterval` in `system/runtime/daemon/server.js`, mirroring the existing `closeStaleEpisodes` and `runActionTrustDecay` ticker blocks (server.js lines 607–636).
- Default tick interval: **5 min** (300_000 ms). Tunable via `runtime:state_inference.config.tick_ms`. The 60-second heartbeat *itself* stays at 60s; this is an independent ticker, like the 10-minute `close-stale-episodes` ticker. We call it heartbeat-paced (vs. nightly) to distinguish from `dreamProcess`.
- Per tick, the job iterates over **active episode sources** (one inference per source). "Active" = any episode row with `ended_at IS NONE` AND `started_at >= now - 24h`. (Closed-and-stale episodes don't qualify — those are exactly the ones `closeStaleEpisodes` is finalising.) This keeps the per-tick fan-out bounded by # of agent surfaces with recent activity (typically 1–2).
- Skip the entire job if `cfg.enabled` is `false` (read pattern in §3.2).

### 1.3 Per-source pipeline

For each active source `S`:

1. **Read the prior inference.** `latestForSource(db, S)` returns the most-recent `state_inference` memo for `S` (most-recent = highest `derived_at` with no inbound `supersedes`), or `null` if none.
2. **Read the current attention lens.** `getAttention(db, { source: S, windowMinutes: cfg.attention_window_min })`. Default window: 90 min (longer than the lens default of 30 so we don't reset to "no focus" during a coffee break).
3. **Read the top active arc for this source.** Query `arcs` where `status = 'active'` AND `last_activity_at >= now - 24h`, joined against the attention lens's entity set via `entity_ids` overlap. If multiple, pick the one with the highest `|attention.entities ∩ arc.entity_ids|`. If none qualifies, `arc = null`.
4. **Read top-N recently biographed events.** Up to 5 events from the attention window, `events.biographed_at IS NOT NONE`, ordered by `ts DESC`, only those whose `mentions`-edges intersect the attention entity set. These become candidate lineage rows and the `evidence_snippet` source.
5. **Change-detection gate.** Compute the *current signal hash* with the existing `sha256` helper imported by `store.js` (`system/data/embed/hash.js`): hash a stable string built from `JSON.stringify({ entities: sorted entity record-refs as strings, arc_id: String(arc?.id ?? null), last_event_id: String(events[0]?.id ?? null) })`. Compare to `prior.meta.signal_hash`.
   - **No prior** OR **signal_hash differs** OR **`prior.meta.last_active_at` older than `cfg.refresh_after_minutes` (default 30)** → proceed to step 6 (calibration sub-step + LLM call).
   - Else → **no-op** for this tick. Append one row to `state_inference_telemetry` with `outcome: 'skipped_unchanged'`, `signal_hash: <hash>`, `source: S`. Return for this source.
6. **Calibration sub-step.** See §5.1. If `prior` exists and step 5 said "change detected," classify and (conditionally) emit one `evidence_ledger` row before invoking the LLM. Subject to the dedup guard in §5.1.
7. **LLM call** (fast tier; `host.invokeLLM`, mirroring `step-knowledge.js` style). Prompt (sketch):

   ```text
   SYSTEM: You produce a one-sentence statement of what the user is currently
   working on, based on recent activity. Stay grounded in the evidence; do
   not speculate beyond what the inputs support. Output strict JSON.

   USER:
   Active arc: {arc.summary or "none"}
   Recent entities: {entity names + types, max 10}
   Recent events (latest first):
   - [ts] {content, first 120 chars}
   - ...
   Prior inference (for context, may be stale): {prior.content or "none"}

   Respond JSON only:
   { "focus_statement": string,
     "confidence": number,
     "evidence_snippet": string,
     "ambiguous": boolean,
     "drop": boolean }
   ```

   - `drop = true` means "the evidence is too thin to assert a focus." When drop is true: no write; the prior memo stands (or no memo is created if none existed).
   - `confidence` is clamped to `[0.05, 0.95]` (we never claim certainty; we never assert with zero confidence — that's what `drop` is for).
   - `ambiguous = true` is a soft signal: confidence is shrunk by 0.5× before storage (multiple plausible focuses → low confidence).
8. **Write.** Call `noteStateInference` which delegates to `store.note(db, embedder, 'state_inference', { … })` with the fields per the shape above. Subjects are the entity refs (→ `about` edges). Lineage is the chosen event IDs (→ `derived_from` edges). Skipped when LLM returned `drop: true`.
9. **Supersede.** If a prior inference existed for the source AND step 8 wrote a new memo: `store.supersede(db, prior.id, new.id)`. `fn::freshness` will return 0 for the prior, keeping recall clean; `<-supersedes` chain remains queryable for introspection.
10. **Telemetry.** Append a row to `state_inference_telemetry` with `outcome ∈ {'wrote','dropped_thin','error'}`, `signal_hash`, `tokens_in`, `tokens_out`, `latency_ms`, `reason`. One row per source per tick (in addition to the early-return rows from step 5).

### 1.4 LLM token budget

- One call per *changed* source per tick. Steady state with no movement: zero calls.
- Cap fan-out per tick at 4 sources (the realistic ceiling). Excess sources defer to the next tick.
- Per-call ceiling: ~400 input tokens (the prompt + capped event lines), ~100 output. At one call per 5 min per active source over an 8-hour work day: ≤ 96 calls/day across all sources. At fast-tier pricing this is rounding noise relative to biographer + dream.

## Section 2 — Storage details

### 2.1 Scope

- Default `scope = 'global'`. State inferences are about the user's work, not bound to a single session.
- **Privacy interplay:** if any `meta.entities` resolves to an entity with `scope='private'`, *or* any chosen lineage event has `scope='private'`, *or* any `derived_from`-reachable memo is `scope='private'` — the inference itself gets `scope='private'`. This propagates the privacy tier upward: a state inference grounded in private evidence is itself private and never surfaces via outbound. See §6 for the full rule.
- Per-source segregation lives in `meta.source`, *not* in `scope`. Two reasons: (a) `scope` is for visibility tier; source identity is metadata. (b) Filtering by source uses an indexed `meta.source` query (we'll add the index, §3.2), which is precisely how `arcs` is structured.

### 2.2 Half-life

- Add to `system/cognition/memory/decay.js` `HALF_LIFE_BY_KIND_MS`:
  ```js
  state_inference: 6 * 60 * 60 * 1000, // 6h
  ```
- **Justification:** Focus shifts over hours, not days. After 24h of no reinforcement the freshness contribution should be near-zero (≈ `0.5^4 = 0.0625`). 24h half-life would let stale inferences linger and pollute recall. 1h is too aggressive — a lunch break should not wipe the prior focus.
- 6h gives `0.5` at 6h, `0.25` at 12h, `0.125` at 18h. Matches a workday's natural rhythm.
- Mirror the constant in the SurrealDB schema at next migration so `fn::freshness` agrees. Until then, `decay.js` (used by `rank.score`) is authoritative on the recall-ranking path.

### 2.3 Indexes

Add to the schema (next migration; until merged, lens queries use existing indexes + `meta.source` scan):

```surql
DEFINE INDEX memos_state_inference_source
  ON memos FIELDS kind, meta.source, derived_at;
```

This makes "latest for source" an indexed lookup. Without it, `latestForSource` does a per-kind scan; tolerable at v1 volume but cheap to fix.

### 2.4 `supersedes` chain

Identical to the pattern in `step-knowledge.js` lines 132 (`store.supersede(db, prior.id, created.id)`). The old memo row is preserved; `fn::freshness` returns 0 via its inbound-supersedes check (mirrored in `decay.js` freshness function at lines 34–36).

This means the introspection MCP tool can replay history: "show me how Kevin's focus has shifted today" = walk `<-supersedes` from the latest.

## Section 3 — Configuration, telemetry, schema

### 3.1 `runtime:state_inference.config`

Seeded in the next migration; readable via the standard `SELECT VALUE value FROM runtime:\`state_inference.config\`` pattern (verbatim from `arcs.js` lines 67–69 and `evidence.js` lines 51–53).

```json
{
  "enabled": false,
  "tick_ms": 300000,
  "attention_window_min": 90,
  "refresh_after_minutes": 30,
  "min_events_for_inference": 2,
  "max_sources_per_tick": 4,
  "min_confidence_to_surface": 0.5,
  "stale_after_minutes": 120
}
```

`enabled` is the three-valued rollout flag — `false` (default) | `'shadow'` (faculty runs, no writes, telemetry only) | `true` (full path; focus block surfaces in the prompt). See §9.

### 3.2 Reading and flipping the flag

`enabled` lives **inside** the config object (not as a separate `runtime:` key). Read pattern, mirroring `evidence.js` and `arcs.js`:

```js
const [rows] = await db
  .query('SELECT VALUE value FROM runtime:`state_inference.config`')
  .collect();
const cfg = rows?.[0] ?? DEFAULTS;
if (cfg.enabled === false) return { outcome: 'skipped_disabled' };
// cfg.enabled === 'shadow' or true: faculty runs.
// Surfacing in the intuition path requires cfg.enabled === true.
```

Cache at the job level (read once per tick) and on the intuition path (5-second TTL, mirroring `getRecallConfig` in `store.js` lines 471–487). Flip via `robin state-inference enable|disable|shadow` (CLI shortcut, follow-up) which does the equivalent of `UPDATE runtime:\`state_inference.config\` SET value.enabled = <new>` — no daemon restart required.

### 3.3 `state_inference_telemetry` table

```surql
DEFINE TABLE state_inference_telemetry SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts        ON state_inference_telemetry TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD source    ON state_inference_telemetry TYPE string;
DEFINE FIELD outcome   ON state_inference_telemetry TYPE string;
  -- 'wrote' | 'skipped_unchanged' | 'skipped_disabled' | 'dropped_thin' | 'error'
DEFINE FIELD signal_hash ON state_inference_telemetry TYPE option<string>;
DEFINE FIELD tokens_in   ON state_inference_telemetry TYPE option<int>;
DEFINE FIELD tokens_out  ON state_inference_telemetry TYPE option<int>;
DEFINE FIELD latency_ms  ON state_inference_telemetry TYPE option<int>;
DEFINE FIELD reason      ON state_inference_telemetry TYPE option<string>;
DEFINE INDEX si_tel_ts ON state_inference_telemetry FIELDS ts;
```

Used by `show_step_health` introspection (§7) and by the rollout decision (§9).

### 3.4 Migration

A single new migration file `system/data/db/migrations/0009-state-inference.surql` (the next available number; existing migrations go through `0008-doctor.surql`) adds:
- The `state_inference_telemetry` table.
- The `memos_state_inference_source` index.
- The `runtime:state_inference.config` seed row (with `enabled: false`).

No changes to `memos` itself — `state_inference` is already a valid kind by registry (`kind-registry.js` lines 31–37).

**`fn::freshness` interplay.** The server-side `fn::freshness` (defined in `0001-init.surql`) has a kind→half-life table. Adding `state_inference: 6h` there would let server-side `ORDER BY fn::freshness(id)` correctly decay this kind. **However**, the recall pipeline never calls `searchMemos` with `kind='state_inference'` (state inferences don't participate in vector recall, §4.6). The only freshness-aware reads of state_inference go through `decay.js` on the client side via `rank.score`, but only if the introspection tool sorts by freshness — and that tool sorts by `derived_at`. **Conclusion:** v1 ships the client-side half-life only (`decay.js` change). The DB-side mirror is deferred until a path emerges that needs it. Add a TODO comment to `0001-init.surql` so the constants stay paired.

## Section 4 — Surfacing at recall

### 4.1 New `<!-- current focus -->` block

In `system/cognition/intuition/inject.js` (the `intuitionEndpoint` function, lines 74–218), prepend a new block above the existing `<!-- relevant memory -->`:

```
<!-- current focus -->
[focus, last active {dur} ago, conf {c.cc}] {content} — arc:{arc_short_id}
<!-- /current focus -->
<!-- relevant memory -->
...
<!-- /relevant memory -->
```

`dur` is humanised (`23m`, `4h`, `2d`) from `now - meta.last_active_at`. `c.cc` is `confidence.toFixed(2)`. `arc:{short}` is omitted if `meta.arc_id` is null.

### 4.2 Source inference for the block

The handler (`system/cognition/intuition/handler.js`) runs as a one-shot script invoked by the host hook; it has no `host` runtime object. The handler **does** see:

- `process.env.CLAUDE_PROJECT_DIR` (set by Claude Code per project, used today to detect v1 hooks at handler.js lines 90–98).
- `stdin.transcript_path` and `stdin.session_id` (per the existing `pickQuery` / `pickTranscriptPath` shape).
- The handler binary's own invocation path (`process.argv[1]`).

The daemon, on the other hand, **does** know `host?.name` (server.js line 672). The cleanest plumbing is:

1. **Handler-side**: read `process.env.ROBIN_SOURCE` if set (a small new env var that hosts can set). Fall back to a heuristic: if `CLAUDE_PROJECT_DIR` is set → `'agent:claude-code'`; else if `GEMINI_CLI_SESSION` (or whatever Gemini sets) → `'agent:gemini-cli'`; else `null`.
2. **POST body**: include `source` in the `/internal/intuition` request body alongside `query` and `prior_assistant`.
3. **Daemon-side fallback**: if the request body has no `source`, the daemon uses its registered `host?.name` to derive one. If still nothing, the daemon resolves the most recently active episode's `source` for this session. If still nothing, **skip the focus block** — never guess.

This makes the handler→daemon source signal a soft chain (env → request body → daemon host → episode lookup → skip). The handler change is purely additive; old daemons ignoring the new body field continue to work (no source → no focus block).

### 4.3 Token budget

- Dedicated cap: **200 tokens** for the focus block (frame + body).
- Carved *in addition to* the existing 1500-token cap for `<!-- relevant memory -->`. Total ceiling per turn rises from 1500 to ≤ 1700 tokens. Justified by the perceived-capability return.
- A single state_inference memo at the targets above (`content` ≤ 240 chars + framing + arc id) fits in ≤ 80 tokens. The 200-token cap is room to grow into multi-dimension surfacing in v2.

### 4.4 Wire format

`intuitionEndpoint` (inject.js lines 74–218) today returns `{ block, hits, tokens, latency_ms, truncated }`. Extend to:

```js
{
  // existing
  block,             // unchanged: the <!-- relevant memory --> body (may be '')
  hits,
  tokens,            // tokens used by the relevant-memory block
  latency_ms,
  truncated,
  // new
  focus_block,       // string: the <!-- current focus --> body, or '' if suppressed
  focus_tokens,      // number: tokens used by focus_block
  focus_suppressed_reason, // string|null: 'disabled'|'no_memo'|'low_confidence'|
                           // 'stale'|'superseded'|'pivot'|'private'|null
}
```

The handler (handler.js lines 168–172) concatenates `payload.focus_block + payload.block` (focus first) and writes the result to stdout. Both halves are independently optional. Old daemons returning only `{ block, … }` continue to work (`focus_block` is `undefined` → coerce to `''`).

### 4.5 Suppression rules

Skip the block entirely (do not emit even the open/close markers) when **any** of:

1. `cfg.enabled !== true` (the boolean `false` AND the `'shadow'` string both suppress; only the literal `true` surfaces the block).
2. No `state_inference` memo exists for the resolved source.
3. The latest memo for the source has `confidence < cfg.min_confidence_to_surface` (default 0.5).
4. `now - meta.last_active_at > cfg.stale_after_minutes` (default 120). Stale focus is worse than no focus.
5. **(Defensive.)** The retrieved memo has any inbound `supersedes` edge. This should be unreachable given `latestForSource` already filters those out, but suppress and log a `state_inference_telemetry { outcome: 'error', reason: 'supersedes_leak' }` row if it ever fires — it would indicate a `latestForSource` bug.
6. **Pivot detection.** The current user prompt contradicts the focus statement. v1 implementation: cheap — if the prompt's top-N keywords (case-folded, length>3) share *zero* overlap with `meta.entities` names AND zero overlap with `content` tokens, skip the block. The user is starting a fresh thread; do not paint the screen with an unrelated stale focus.
7. **Privacy.** If the memo's `scope` is `private`, skip the block — the focus block is itself an outbound surface from the agent's perspective; we never expose private-scoped evidence outside its boundary. (`checkOutboundScope` semantics: the agent prompt is *the* outbound channel here.)

### 4.6 Recall ranking interplay

`state_inference` memos otherwise participate in `searchMemos` only when callers explicitly pass `kind: 'state_inference'`. The intuition pipeline today (`inject.js` line 106) searches `kind: 'knowledge'` only — state_inference does **not** join the vector-recall flow. It's purely the focus block; mixing it into general memory recall would muddle two different signals.

For introspection (`explain_recall` and friends, Theme 4) the kind is allowlisted to surface in audits.

## Section 5 — Calibration loop

### 5.1 Compare to subsequent activity

Calibration is **step 6** of the per-source pipeline (§1.3) — runs after the change-detect gate (step 5) passes AND before the LLM call (step 7). It only fires when a prior memo exists AND step 5 produced a `change-detected` outcome (i.e., we already decided we're going to write something new this tick).

When `prior` exists, classify it against the new snapshot:

- **Corroborated** = entity overlap (`|prior.meta.entities ∩ new.entities| / max(|prior.meta.entities|, |new.entities|)`) ≥ 0.5 AND `prior.meta.arc_id` matches new `arc.id` (or both null). Emit one row: `CREATE evidence_ledger CONTENT { memo_id: prior.id, polarity: 'corroborates', reason: 'state_inference_held', weight: 1.0 }`. (The prior is then superseded by the new write in step 9, but with a corroboration logged for audit.)
- **Refuted** = `arc_id` changed AND entity overlap < 0.25. Emit `{ memo_id: prior.id, polarity: 'refutes', reason: 'state_inference_pivoted', weight: 1.0 }`.
- **Ambiguous** = anything in between. No ledger emission.

If step 7's LLM returns `drop: true` (insufficient evidence) the write (step 8) is aborted *but* the calibration ledger row from step 6 is **not** rolled back — the comparison was still valid (prior either held or pivoted relative to what we observed). The prior memo also is **not** superseded in that case (step 9 is skipped).

**Dedup against repeat ticks.** Drop=true followed by drop=true on subsequent ticks would emit one calibration row per tick against the same prior, which is double-counting. Guard at step 6: skip the emission if the prior memo has any `evidence_ledger` row with `reason IN ('state_inference_held', 'state_inference_pivoted')` whose `ts > prior.derived_at`. One calibration per prior is the invariant; later confirmations are redundant.

`step-confidence-recompute` (nightly, already in pipeline) picks up the ledger rows and updates the (now-superseded) memo's stored `confidence` for audit replay correctness. The superseded memo's freshness is already 0 via `decay.js` lines 35–36, so the updated confidence is purely audit-trail value — it does not re-enter ranking.

`memo_id: prior.id` is the record-ref form (e.g. `memos:01HZ…`); `prior.id` from the SELECT is already a SurrealDB record ref so it slots into the bind directly (cf. `reinforcement.js` lines 144–149 which builds it from a string key — we're starting from the ref so no rebuild needed).

### 5.2 Boundary against foresight

| | `state_inference` | `foresight` (`prediction`) |
|---|---|---|
| Subject of claim | What the user is doing **now** | What will happen **later** |
| Resolution | Implicit, via the next observation cycle | Explicit, via `foresight.resolve(...)` |
| Calibration | Lightweight ledger rows (this spec, §5.1) | `computeCalibration` over resolved rows |
| Half-life | 6h | 365d |
| Surfacing | Privileged `<!-- current focus -->` block | Not surfaced at recall directly |

They share the calibration *mechanism* (evidence ledger + confidence recompute) but the *subjects* are disjoint. The boundary is timestamp-anchored: a prediction's claim references a future event; a state_inference's claim references the present.

## Section 6 — Privacy

`checkOutboundScope` (`system/cognition/discretion/outbound-policy.js` lines 78–128) refuses outbound payloads referencing `scope='private'` records *or* events transitively `derived_from` a private memo. State inferences must respect this on **both** the inbound (write-time scope assignment) and outbound (block-time check) axes.

### 6.1 Write-time scope inheritance

When the faculty writes a state_inference, before calling `store.note`:

1. Hydrate the candidate `meta.entities` rows and chosen lineage event rows (single batched `SELECT id, scope FROM entities WHERE id IN $ids` + same for events).
2. If any of those rows has a scope whose `policyFor(scope).outbound === 'block'` (i.e., `private`), set the new memo's `scope = 'private'`.
3. Otherwise default to `'global'`.

This means a focus inferred from private-scope events is itself private, and §4.5 rule 7 will suppress it from the agent prompt.

### 6.2 Outbound-aware introspection

The `explain_state_inference` MCP tool (§7) must redact the memo's content and entity refs when the *caller* lacks permission to see private scope. Today no Theme 4 tool exposes private content (verified in audit test `audit-introspection-readonly.test.js`). The new tool mirrors that policy: if the memo is private, return `{ private: true, id, derived_at }` only.

### 6.3 What this does *not* cover

The faculty does not currently check `entities` for transitive `derived_from` paths into private memos. The path is unbounded and the v1 worth-it tradeoff is direct-only. If a non-private entity is *associated with* a private memo via `about` edges from elsewhere in the graph, that memo is still considered for inference. We accept this; the symmetric `<-derived_from<-memos[WHERE scope='private']` pattern from `outbound-policy.js` lines 100–108 can be ported in if telemetry shows leakage.

## Section 7 — Introspection

New Theme-4 read-only MCP tool: `explain_state_inference`.

- File: `system/io/mcp/tools/explain-state-inference.js`.
- Signature: `({ source?: string }) => { current, history, evidence_replay }`.
- `current`: the latest non-superseded `state_inference` memo for the source (or for *all* sources if none specified), with `meta` fully expanded.
- `history`: walk `<-supersedes` from `current` back up to 10 hops; return `[{ id, derived_at, content, confidence }]`.
- `evidence_replay`: ledger rows for every memo in `history` (chronological).
- Private-scope redaction per §6.2.
- Listed in `docs/faculties.md` alongside the other seven Theme-4 tools.

`robin doctor --health` (file `system/runtime/cli/health.js`) gains a `state_inference` rollup: count of writes in the last 24h, average confidence, and the count of `state_inference_telemetry.outcome = 'error'` rows in the last hour (exit code 2 if ≥ 3, code 1 if ≥ 1, code 0 otherwise).

## Section 8 — Test plan

### 8.1 Unit tests

`system/tests/unit/state-inference-compose.test.js`

- **U1 — empty attention → no write.** `getAttention` returns `{ episodes: [], recent_events: [], entities: [] }` → faculty returns `{ outcome: 'dropped_thin' }`; no memo created.
- **U2 — no change → no LLM call, no write.** Seed a prior memo whose `meta.signal_hash` matches the next computation; assert the LLM mock isn't invoked; `outcome: 'skipped_unchanged'`.
- **U3 — entity-set change → LLM call, new memo + supersedes.** Seed prior; flip the attention entities; assert one LLM invocation, one new memo, one `supersedes` edge from new → prior.
- **U4 — LLM returns `drop: true` → no write.** With LLM mocked to drop, no memo writes; prior (if any) remains current; telemetry row `outcome: 'dropped_thin'`.
- **U5 — confidence clamping.** LLM returns `confidence: 1.5` → stored value is `0.95`. `-0.3` → `0.05`. Ambiguous=true with `0.8` → `0.4`.
- **U6 — privacy inheritance.** Seed an entity with `scope='private'`; faculty picks it up in `meta.entities` → new memo's `scope` is `private`.

### 8.2 Integration tests

`system/tests/integration/state-inference-cycle.test.js`

- **I1 — write → recall surfaces.** Run one tick (LLM mocked to produce a focus). Call `intuitionEndpoint`. Assert the returned block contains `<!-- current focus -->` with the expected content and an inline `last active … ago` substring.
- **I2 — suppression on low confidence.** Latest memo has `confidence: 0.3`. Intuition returns no focus block; relevant-memory block unchanged.
- **I3 — suppression on staleness.** `meta.last_active_at` is 4h ago, `cfg.stale_after_minutes = 120`. No focus block.
- **I4 — pivot suppression.** Query has zero keyword overlap with focus content. No focus block.
- **I5 — supersedes wins.** Two memos exist, B supersedes A. `latestForSource` returns B; A's content does not appear in the block.
- **I6 — privacy block.** Latest memo has `scope='private'`. No focus block in the intuition response.
- **I7 — calibration emission.** Run two consecutive ticks where the second represents a pivot (different arc_id, < 25% entity overlap). Assert one `evidence_ledger` refute row for the prior memo with `reason='state_inference_pivoted'`. Same for the corroborate path (low-overlap inverse).
- **I8 — disabled flag respected.** With `cfg.enabled = false`, the heartbeat job returns without invoking LLM; intuition skips the block.
- **I9 — shadow mode.** With `cfg.enabled = 'shadow'`, the heartbeat job runs the full pipeline (including LLM if change is detected) but writes **no** memo; one telemetry row is appended per source per tick. Intuition still skips the block (per §4.5 rule 1).

### 8.3 End-to-end (folded into `integration/`)

`system/tests` does not have a separate `e2e/` directory — full-pipeline tests live under `integration/`. Add to the same `state-inference-cycle.test.js`:

- **E1** — full cycle on an in-memory DB: capture events, run biographer, run state-inference job, hit `intuitionEndpoint` → assert the focus block appears and is well-formed. Compare token count against the 200-cap.
- **E2** — concurrency: simulate the heartbeat firing twice within the same tick window for the same source. Assert exactly one memo is written (idempotence — the change-detect gate (§1.3 step 5) makes the second call a `skipped_unchanged` no-op because the `signal_hash` matches).

### 8.4 Privacy audit

Extend the existing `system/tests/unit/audit-introspection-readonly.test.js` allowlist (lines 12–20) by adding `'system/io/mcp/tools/explain-state-inference.js'`. This re-uses the existing read-only invariant test — no separate file.

Add a sibling unit test `system/tests/unit/state-inference-privacy.test.js`:

- **A1** — write a `state_inference` memo with `scope='private'`, call `explain_state_inference`, assert the returned shape is `{ private: true, id, derived_at }` only.
- **A2** — run the faculty with an entity in `meta.entities` whose scope is `private`; assert the produced memo has `scope='private'`.

## Section 9 — Rollout

### 9.1 Phase 0 — schema + dark-launch

1. Land migration `0009-state-inference.surql`: new index, new telemetry table, seeded `runtime:state_inference.config` with `enabled: false`. Half-life entry in `decay.js`.
2. Land faculty code (`jobs/internal/state-inference.js`, `memory/state_inference.js`). Heartbeat ticker registered in `server.js` — on each fire it reads `cfg.enabled`; if `false`, returns immediately.
3. Land intuition modification (focus block emission, response wire-format change). Suppression rule 1 (`cfg.enabled !== true`) gates the focus block.
4. Land MCP introspection tool (`explain_state_inference`).
5. Land tests.

Outcome at phase 0: production behavior is **byte-identical** to today (no focus block surfaced, no LLM calls made). Telemetry table is empty.

### 9.2 Phase 1 — telemetry-only (shadow mode)

`runtime:state_inference.config.enabled` is a three-valued state: `false` | `'shadow'` | `true`. (Yes, we said "behind a flag" — this *is* the flag, with one extra trace level.) Read pattern stays a single config row; the value is a string. Naming kept to one runtime key.

When `enabled === 'shadow'`:

- The faculty runs end-to-end *except* it does not write the memo. It writes a telemetry row per would-be-outcome.
- The intuition path treats `'shadow'` like `false`: no focus block emitted to the agent.
- This surfaces the change-detect skip rate, the candidate confidence distribution, and the LLM-call rate per active source — without affecting the agent prompt or the recall path.

Run for ~3 days. Verify:

- `skipped_unchanged / wrote ≥ 4:1` (steady-state cost target).
- `tokens_in` median ≤ 500; max ≤ 1200.
- No errors in the last 24h.

### 9.3 Phase 2 — Kevin-only enable

Set `enabled = true` only on Kevin's `robin-personal` instance. Observe for 1 week. The focus block now appears in the prompt; verify it doesn't degrade Claude Code interactions (no spike in correction events, no spike in recall_log refutes).

### 9.4 Phase 3 — default-on

Flip the seed default in the migration / runtime config so new installs get `enabled: true`. Document in CHANGELOG. Keep the flag — power users will want to disable.

### 9.5 Kill switch

`robin state-inference disable` (CLI shortcut) flips the runtime row and the next intuition turn skips the block. No restart required (5-second cache on the runtime read, mirroring `getRecallConfig` in `store.js` lines 471–487 — adjust to a similar TTL or read-once-per-tick for the heartbeat job).

## Section 10 — Cost envelope

- **Steady state (no movement):** zero LLM calls, zero embed calls (no `store.note` invocation → no embedding write). One short SELECT per tick per source (`latestForSource`) + one attention lens call (~3 indexed queries) + one arcs lookup. << 5ms per tick per source.
- **Active state (focus shift):** one fast-tier LLM call per affected source per tick (capped at `max_sources_per_tick = 4`). Memo write + one embedding (small content, ~240 chars). One `supersedes` edge. Telemetry row.
- **Per write:** ~1 LLM call (~500 in / ~100 out tokens), ~1 embed call, ~3 DB inserts. ~150ms at p50.
- **Recall path:** the focus block adds one synchronous `latestForSource` query inside `intuitionEndpoint` (single indexed SELECT, ~1ms). The token budget grows by up to 200; the wall-clock impact is negligible relative to the existing kNN call.

Within the cadence-budget framework (`runtime:cadence.config.daily_token_budget`) the state-inference faculty is **not** trigger-eligible — it has its own pacing and its own cost. We do not consume cadence budget; we *do* surface our totals in the same `cadence_telemetry`-shaped table so the operator dashboards stay coherent (separate row, separate aggregation key `step='state-inference'`).

## Section 11 — File-by-file changes

**Created:**

- `system/cognition/memory/state_inference.js` — lens (`latestForSource`, `listRecent`, `noteStateInference`).
- `system/cognition/jobs/internal/state-inference.js` — heartbeat job entry (`evaluateStateInference`, `composeForSource`).
- `system/cognition/jobs/builtin/state-inference.md` — operator-facing description (mirrors `reinforce-recall.md`).
- `system/io/mcp/tools/explain-state-inference.js` — Theme-4 read-only tool.
- `system/data/db/migrations/0009-state-inference.surql` — new index + telemetry table + config seed (the next available migration number; existing migrations run through `0008-doctor.surql`).
- `system/tests/unit/state-inference-compose.test.js`
- `system/tests/unit/state-inference-privacy.test.js`
- `system/tests/integration/state-inference-cycle.test.js` — includes the end-to-end scenarios E1/E2 (the test tree has only `unit/` and `integration/`; full-pipeline tests live in `integration/`).

**Modified:**

- `system/cognition/memory/decay.js` — add `state_inference: 6h` to `HALF_LIFE_BY_KIND_MS`.
- `system/cognition/intuition/inject.js` — prepend `<!-- current focus -->` block per §4.1; consume `source` from the request; widen the response per §4.4 wire format; apply §4.5 suppression rules.
- `system/cognition/intuition/handler.js` — resolve `source` via `process.env.ROBIN_SOURCE` → CLAUDE_PROJECT_DIR heuristic → null (§4.2); include in the POST body; concatenate `payload.focus_block + payload.block` and write to stdout.
- `system/runtime/daemon/server.js`:
  - Register the heartbeat ticker (default 5 min) gated by the runtime flag; mirror the existing `closeStaleEpisodes`-style block at lines 607–636.
  - Import `createExplainStateInferenceTool` and call `tools.push(createExplainStateInferenceTool({ db: dbHandle }))` alongside other Theme-4 tools near line 472 (verified pattern via `createExplainRecallTool`, server.js lines 39 + 472). There is no separate `mcp/registry.js`; tools wire directly here.
  - On `/internal/intuition` (server.js line 897), forward `body.source` (and fall back to `host?.name` / episode-source lookup per §4.2) into the `intuitionEndpoint` call.
- `system/runtime/cli/health.js` — add `state_inference` rollup per §7.
- `system/tests/unit/audit-introspection-readonly.test.js` — add `'system/io/mcp/tools/explain-state-inference.js'` to the `INTROSPECTION_TOOLS` array (lines 12–20).
- `docs/architecture.md` — mention `state_inference` in the faculty list; note the new ticker in the heartbeat description.
- `docs/faculties.md` — new "state inference" subsection under Process faculties + new MCP tool in the introspection list.

## Section 12 — Open questions

These are explicitly *not* blockers. They are followups we expect to resolve from telemetry after the spec lands.

- **Top-K vs singleton per source.** v1 is singleton. If telemetry shows the user rapidly toggling between two arcs within a session, surfacing both (with the dominant one first) may be worth a v2 pass.
- **Multi-source consolidation.** Should "Kevin is working on X" appear identically across Claude Code and Cursor when both are active in the same arc? Probably yes, eventually, via a `dimension='current_focus_global'` row that consumes the per-source rows. Defer until per-source proves out.
- **Pivot suppression heuristic.** §4.5 rule 6 uses a cheap keyword-overlap check. False positives ("Kevin asks an unrelated question mid-flow") are tolerable — we just skip the focus block for that turn. False negatives (Kevin pivots but the block stays) are more annoying. If telemetry shows the heuristic is wrong > 10% of turns, swap for an embedding-overlap check.
- **`refresh_after_minutes` tuning.** 30 min is a guess. If LLM-call rate is too high, raise; if "last active … ago" feels stale, lower.
- **Manual override.** Should the agent be able to call a tool like `set_focus({ statement })` to override Robin's inference? Likely yes for "Kevin tells Robin I'm now working on Y." Defer to a small follow-up; the `derived_by='manual'` path through `store.note` already supports it. Would also feed the evidence ledger as a strong corroboration.
- **Server-side `fn::freshness` mirror.** The half-life lives in `decay.js` for client-side ranking. The migration `0001-init.surql` has the same constants; they should agree. v1: client-side authoritative. Follow-up: mirror to the function.

## See also

- `2026-05-11-robin-v2-database-and-memory-redesign-design.md` — substrate, kinds, edges.
- `2026-05-11-robin-v2-theme-1b-episodes-arcs-design.md` — `arcs`, the primary structural input.
- `2026-05-11-robin-v2-theme-2a-evidence-ledger-design.md` — the calibration substrate we plug into.
- `2026-05-11-robin-v2-theme-3-cognition-cadence-design.md` — why heartbeat-paced, not trigger-eligible.
- `2026-05-11-robin-v2-theme-4-observability-design.md` — introspection tool template.
- `system/cognition/memory/kind-registry.js` lines 31–37 — registry entry (already present).
- `system/cognition/memory/attention.js` — primary input lens.
- `system/cognition/intuition/inject.js` — surface site.
