# Robin v2 — Cognition B1: Per-hit reinforcement attribution

**Status:** Design (working draft; impl waits for Theme 2a integration check)
**Date:** 2026-05-11
**Umbrella:** `2026-05-11-robin-v2-evolution-roadmap.md` (post-alpha.16, "Cognition B" track)
**Depends on:** `2026-05-11-robin-v2-theme-2a-evidence-ledger-design.md` (ledger writer site)

## Why

Today's reinforcement loop labels too generously.

`system/cognition/intuition/inject.js` emits a `<!-- relevant memory -->` block containing up to `k=6` formatted hits (`[event YYYY-MM-DD] content` / `[episode YYYY-MM-DD] content` lines) and writes a `recall_log` row with `ranked_hits[]`. Five minutes later, `system/cognition/intuition/reinforcement.js:evaluatePending` looks at each `outcome='pending'` row, checks for a `meta.kind='correction'` event in the 5-min window, and — if none — calls every hit "reinforced": each `memos:*` hit gets `signal_count += 1` and `decay_anchor = time::now()`, and (Theme 2a) one `evidence_ledger` corroborate row.

If recall returned six hits and the agent's next reply only relied on one, the other five still get full credit. The reinforcement signal is per-row, not per-hit. That:

- Inflates `signal_count` on memos that happen to co-occur with useful ones.
- Inflates `evidence_ledger` corroborates, weakening derived confidence as a discriminator.
- Pollutes `recall_log` as labeled training data for a future reranker — the keystone reason the loop exists at all (`docs/architecture.md` §A typical agent turn).

We want `recall_log.ranked_hits[].used: bool` to mean *the agent actually used this hit in the subsequent reply* — and signal_count / evidence rows to mirror that.

## Goals

- Per-hit attribution: every reinforcement row (`signal_count` bump and `evidence_ledger` corroborate) corresponds to a hit the agent demonstrably used.
- Cheap path that works without agent cooperation (we can't unilaterally retrain every CLI/MCP client at once).
- A forward-compatible hook for an opt-in explicit-attribution path (an MCP tool or reply trailer). Wiring is part of B1; the agent-facing tool itself is a follow-up — see §5.
- Fail-soft everywhere: missing attribution data falls back to a documented, conservative behavior — never breaks the existing loop.
- Preserve the corroborate-on-reinforce / refute-on-correction shape introduced by Theme 2a.

## Non-goals

- Training a reranker. (B1 only labels; the consumer is later.)
- Replacing the row-level outcome semantics. We extend the enum by exactly one value (`evaluated_no_used`, §4) to keep `outcome` meaningful when attribution matches zero hits; otherwise per-hit `used`-ness is hit-level metadata layered on top.
- Per-hit refutation on correction. (The corrected row already refutes *every* hit; narrowing refutation to the misused hit needs LLM judgement and is out of scope — already an open question in Theme 2a §12.)
- New embedding profiles or LLM tools — zero net token cost.
- Backfilling attribution onto already-evaluated `recall_log` rows. (Migration adds the new fields with no values for old rows; pending rows older than the cutoff are evaluated by the new path on first tick — typically falling back to legacy semantics because they pre-date conversation-event indexing.)

## Anchoring decisions

**Why hybrid (explicit → citation → similarity), not "explicit only":**

The injected block already carries deterministic citation markers — every line is `[event YYYY-MM-DD] content` or `[episode YYYY-MM-DD] content`, produced by `inject.js:formatHit`. If the agent paraphrases a hit, the date stamp and a content shingle usually leak through. That's a free signal we already pay for in the prompt. An explicit `recall_used` tool would be cleanest but (a) requires every host (Claude Code, Gemini CLI, future agents) to know about the tool, (b) only triggers when the agent thinks to call it, and (c) the agent is the very same surface whose alignment we're trying to verify — making it the lone source of truth introduces a circular signal.

So the precedence is: prefer explicit attribution when present; else parse citation markers; else use lexical-similarity inference; else — only when all three fail — fall back to today's row-level behavior (so we never regress to "no signal at all").

**Why lexical similarity rather than an embedding call or LLM judgement:**

The "embedding similarity" option named in the design brief was the right family but the wrong tool. A per-turn embedding call against each of `k=6` hits would still cost one extra embed per recall on the intuition path; a per-turn LLM call to decide "which hit was used" would be even more expensive and is explicitly forbidden by the cadence/cost envelope (`docs/faculties.md` §cadence). Lexical Jaccard overlap is enough: we already have the agent's reply text in the events firehose (captured by `system/io/capture/session-capture.js` as a `source='conversation'` event whose content is `"USER: ...\n\nASSISTANT: ..."`), and we have hit content. Tokenised set overlap (`/\W+/`-split, length > 3, lowercased — the same idiom `inject.js:substringOverlap` uses for MMR-lite) is cheap, deterministic, and a robust proxy for "this hit shows up in the reply." Upgrading to a vector cosine later is a drop-in replacement inside `attribute()`; the persistence shape (`used`, `used_via`, `used_score`) is technique-agnostic.

**Why run attribution inside the reinforcement loop, not biographer:**

Biographer runs per-event with a single-event LLM call. Coupling attribution into it would (a) tie reinforcement to the biographer queue's lag (which can spike under load — see `runtime:biographer.failed_event_ids`), (b) require biographer to know about `recall_log` shape (cross-faculty entanglement), and (c) leak attribution emission into a place that is fail-soft per event (one bad event silently drops attribution).

The reinforcement loop is the natural fit: it's already keyed by the 5-min window during which the agent's reply must have landed; it already reads `recall_log`; it already emits `evidence_ledger` rows. Adding the lookup of the matching conversation event(s) keeps every behavior the loop owns in one file.

**Why per-hit boolean on `recall_log`, not per-hit `evidence_ledger` rows:**

Two reasons. First, `recall_log` is the labeled-training-data surface — a reranker training pipeline reads `ranked_hits` and asks "which were used?". Storing `used:bool` next to each hit makes that one SELECT. Second, `evidence_ledger` already exists for memos; events have no ledger. Per-hit attribution must work for both memo and event hits (the injection block contains both — `inject.js` lines 110-119). A `used` flag on `ranked_hits[]` works for both surfaces; the corroborate ledger row is then emitted only for memo hits, only when `used=true`.

**Why keep the row-level loop as a fail-soft fallback:**

If transcript capture missed (e.g., Stop hook fires with no assistant turn — `captureFromTranscript` returns `{captured:false, skippedReason:'no_assistant_turn'}` and no conversation event lands), we have no reply text to match against. Better to fall back to today's "no correction means reinforce all" than to silently drop the signal. Configurable via `runtime:\`reinforcement.config\`.value.fallback_when_no_reply` (default `true` — preserves current behavior). Telemetry on `recall_log.attribution.mode = 'fallback_no_reply'` lets us watch how often this fires.

## Section 1 — Schema deltas

```surql
-- recall_log.ranked_hits[*] already TYPE object FLEXIBLE — no new field
-- definition needed for `used`, but document the new keys explicitly.

-- Each ranked_hits[] entry MAY now carry:
--   used:       bool      -- true if attribution matched this hit
--   used_via:   string    -- 'explicit'|'citation'|'similarity'|'fallback'|'hit_missing'
--   used_score: float     -- present when used_via='similarity' (Jaccard, [0,1])
-- Absence of these fields = "not evaluated" (e.g. rows pre-dating B1).

-- recall_log gains two top-level optional fields:
DEFINE FIELD reply_event_id ON recall_log TYPE option<record<events>>;
-- ^ the conversation event whose ASSISTANT block was used for attribution.
--   NONE when fallback path fired or no reply was found.

DEFINE FIELD attribution    ON recall_log TYPE option<object> FLEXIBLE;
-- Shape (informational; FLEXIBLE leaves room for evolution):
--   { mode: 'explicit'|'citation'|'similarity'
--          |'fallback_no_reply'|'fallback_zero_used'
--          |'corrected'|'no_hits'|'off',
--     used_count: int, total: int,
--     similarity_threshold: float, jaccard_min_overlap_tokens: int,
--     dropped_hits: int, elapsed_ms: int }

-- Optional index — not required for correctness, but speeds explain_recall:
DEFINE INDEX recall_log_reply ON recall_log FIELDS reply_event_id;
```

No table-level migration is required for the `ranked_hits[*]` keys because that field is already `TYPE object FLEXIBLE` (`system/data/db/migrations/0001-init.surql:298`). The two new top-level fields (`reply_event_id`, `attribution`) are added in a new migration `system/data/db/migrations/0009-per-hit-reinforcement.surql`.

## Section 2 — `runtime:reinforcement.config`

New singleton runtime row, read once per `evaluatePending` call (no per-row hit):

```json
{
  "attribution_mode": "hybrid",
  "similarity_threshold": 0.35,
  "jaccard_min_overlap_tokens": 2,
  "citation_date_window_days": 2,
  "fallback_when_no_reply": true,
  "fallback_when_zero_used": true,
  "reply_lookup_window_ms": 600000
}
```

Field meanings:

- `attribution_mode`: `"hybrid"` (run all three passes — explicit → citation → similarity, in that order, on every row) or `"off"` (kill switch — every hit marked `used=true,used_via='off'` so the legacy bucketing reproduces today's behavior exactly). Two modes is enough for B1; the pseudocode in §3 is gated only on `mode == 'off'` vs not. Adding `"explicit_only"` / `"similarity_only"` later is one extra branch each; deliberately omitted to keep the surface minimal.
- `similarity_threshold`: minimum Jaccard overlap for `used_via='similarity'`. Tuned at impl time on telemetry; 0.35 chosen because `inject.js`'s MMR-lite uses 0.85 for *de-duplication*, and "did the agent quote/paraphrase this?" is a strictly weaker test.
- `jaccard_min_overlap_tokens`: floor on the absolute intersection size, regardless of ratio (default 2). Prevents short hits from getting credited via two random connective words.
- `citation_date_window_days`: when matching `[event YYYY-MM-DD]` markers in the reply, allow the date to be ±N days off (handles timezone/format drift; default 2).
- `fallback_when_no_reply`: if `true`, when no conversation event lands in `reply_lookup_window_ms`, fall back to the old row-level reinforcement on all memo hits. If `false`, mark all hits `used=false` (no reinforcement happens; useful for evaluation runs).
- `fallback_when_zero_used`: if attribution ran but matched zero hits, treat the same way as `no_reply` (default `true`). Without this, a paraphrasing agent could starve the loop entirely.
- `reply_lookup_window_ms`: how long after the recall to wait for a matching reply event. Default 10 min — wider than the 5-min reinforcement window because the `Stop` hook can lag.

Seeded by `0009-per-hit-reinforcement.surql`. Tunable without code change. Cached for the lifetime of a single `evaluatePending` invocation (re-read every loop tick).

## Section 3 — Attribution pipeline

`evaluatePending` (in `system/cognition/intuition/reinforcement.js`) gains a new step that runs *before* the existing bucketing logic. Per-row pseudocode:

```
config = readReinforcementConfig(db)                     # one query, cached per tick
mode = config.attribution_mode                           # 'hybrid' by default

# Short-circuit: corrected rows are evaluated for outcome=corrected without
# needing a reply lookup. The bucketing path skips them for reinforcement
# anyway (Theme 2a writes refutes for every memo in the corrected row).
# `correctedRowIds` is computed by the existing correction pre-pass
# (`reinforcement.js` lines 52-81 + the row-walk at 88-109); the B1 pre-pass
# runs AFTER it so we can short-circuit here.
if row.id in correctedRowIds:
  row.attribution = { mode: 'corrected', total: len(row.ranked_hits),
                      used_count: 0 }
  continue

# Empty-hits row: still evaluated_no_signal, just labelled.
if len(row.ranked_hits) == 0:
  row.attribution = { mode: 'no_hits', total: 0, used_count: 0 }
  continue

# Kill switch: legacy bucketing path. Mark every hit used=true, used_via='off'
# so the downstream §4 filter ("used === true") still produces the legacy
# semantics. This is the load-bearing reason `off` must SET used, not omit it.
if mode == 'off':
  for hit in row.ranked_hits: hit.used = true; hit.used_via = 'off'
  row.attribution = { mode: 'off', total: len(row.ranked_hits),
                      used_count: len(row.ranked_hits) }
  continue

reply = findReplyEvent(db, row)                          # § 3.1
if reply is null or extractAssistantBody(reply) == '':
  if config.fallback_when_no_reply:
    for hit in row.ranked_hits: hit.used = true; hit.used_via = 'fallback'
    row.attribution = { mode: 'fallback_no_reply',
                        total: len(row.ranked_hits),
                        used_count: len(row.ranked_hits) }
  else:
    for hit in row.ranked_hits: hit.used = false
    row.attribution = { mode: 'fallback_no_reply',
                        total: len(row.ranked_hits), used_count: 0 }
  continue

hits = attribute(row.ranked_hits, reply, config)         # § 3.2 — pure function
used_count = count(h.used == true for h in hits)
if used_count == 0 and config.fallback_when_zero_used:
  for hit in hits: hit.used = true; hit.used_via = 'fallback'
  row.attribution = { mode: 'fallback_zero_used',
                      total: len(hits), used_count: len(hits) }
else:
  # dominant_mode: explicit > citation > similarity. When used_count == 0
  # and fallback is off, the mode reflects which pass last ran (always
  # 'similarity' since the passes are gated by used-already-set, but they
  # all ran). Used only for telemetry.
  row.attribution = { mode: dominant_used_via(hits) ?? 'similarity',
                      total: len(hits), used_count: used_count }
row.ranked_hits = hits
row.reply_event_id = reply.id                            # always set when reply found
```

The downstream bucketing (memo `signal_count += N`, `evidence_ledger` corroborate) is then driven by `used === true` *only*. Under `attribution_mode='off'`, every hit is marked `used=true, used_via='off'` — so the same filter produces legacy semantics. Under `fallback_*`, every hit is marked `used=true, used_via='fallback'` — same effect for one row.

### 3.1 — `findReplyEvent(db, row)`

The Stop hook causes `captureFromTranscript` to write a conversation event with `source='conversation'` and `meta.session_id` set (`system/io/capture/session-capture.js` lines 114-125). The reply text appears after the literal marker `\n\nASSISTANT: ` inside `event.content`. So:

```surql
SELECT id, content, ts FROM events
WHERE source = 'conversation'
  AND meta.session_id = $sid
  AND ts >= $row_ts
  AND ts <= $row_ts + duration::from::millis($win)
ORDER BY ts ASC
LIMIT 1;
```

Parameters: `$sid = row.session_id`; `$row_ts = row.ts`; `$win = config.reply_lookup_window_ms`.

Edge cases handled by `findReplyEvent`:

- **`row.session_id IS NULL`**: many `recall_log` rows have null `session_id` today because `inject.js` never sets it (see `intuitionEndpoint` lines 202-212 — only `query`, `k`, `ranked_hits`, `outcome`, `meta` are written, and `handler.js` doesn't fetch `session_id` from stdin either). Under B1, for any null-session row we use the **process-bound fallback**: pick the earliest `source='conversation'` event in `[row.ts, row.ts + win]` regardless of `meta.session_id`. This is correct for the dominant case (one active Robin-instrumented host on the box) and degrades — never *incorrectly* attributes — for the multi-host edge case (worst case: similarity threshold rejects the wrong reply's content, falling through to `fallback_zero_used`). A separate work item B1.1 — out of scope for this spec — plumbs `session_id` through the intuition path so the fallback is dead code on new rows. See §11.
- **Multiple replies in the window**: not currently possible because `captureFromTranscript` writes at most one event per Stop-hook invocation, but if it ever does, `LIMIT 1 ORDER BY ts ASC` makes the choice deterministic.
- **Reply exists but is empty/tool-only**: the captured event content is `"USER: ...\n\nASSISTANT: "` (empty assistant text) for tool-only turns. Treated identically to "no reply" — `extractAssistantBody` (§3.2) returns `''` and attribution falls through to the `fallback_no_reply` branch (per §3 pseudocode).

`findReplyEvent` would be one query per pending row if done naively. For a 200-row batch (the existing `LIMIT 200` in `evaluatePending`), that's 200 queries — undesirable. Batch as follows:

```surql
-- Single query: every candidate conversation event in the union window.
SELECT id, content, ts, meta.session_id AS sid
FROM events
WHERE source = 'conversation'
  AND ts >= $min_ts
  AND ts <= $max_ts
ORDER BY ts ASC;
```

`$min_ts = min(row.ts for row in pending)`; `$max_ts = max(row.ts + reply_lookup_window_ms)`. Bucket the returned events by `sid` (using `'__null__'` for null sids) in JS. For each pending row, in the same JS pass:

1. Sort `pending` by `(session_id ?? '__null__', ts)` ascending — already grouped by the existing pre-pass shape; explicit sort makes the windowing deterministic.
2. For pending row R at `(sid, ts_R)`, take the candidate list for `sid` (or the `'__null__'` list if `sid` is null), advance a per-bucket cursor past events with `ts < ts_R`, and pick the first event with `ts ≤ ts_R + window` — *unless* that event's `ts` is `≥` the next pending row's `ts` in the same bucket (§7.3 mitigation: a later recall in the same session/bucket "claims" the next reply).

Single SELECT per `evaluatePending` tick regardless of `pending.length`. Same cost shape as the existing correction pre-fetch (`reinforcement.js` lines 52-60). Index-wise: this query reads on `events_source` and filters by `ts`; the existing `events_ts` index makes the ts range cheap, and `events_source` narrows by source. A composite `(source, ts)` index is *not* strictly needed but recommended if telemetry shows the scan being a hot spot — listed in §12 cost envelope.

### 3.2 — `attribute(hits, reply, config)`

`reply.content` is `"USER: <q>\n\nASSISTANT: <a>"`. Extract `<a>`:

```js
const SPLIT = '\n\nASSISTANT: ';
const idx = reply.content.indexOf(SPLIT);
const body = idx >= 0 ? reply.content.slice(idx + SPLIT.length) : reply.content;
```

Lowercase the body once. Then for each hit:

**Tag determination per hit.** Each `ranked_hits[]` entry has `kind` (set by `inject.js` line 197 to either `'event'` or `'memo'`) and `record` (a SurrealDB record reference; `hitRecordId` from `reinforcement.js:14-19` already normalises it to a string id like `"memos:xyz"` or `"events:abc"`). For citation matching: event hits always map to the `[event YYYY-MM-DD]` tag. Memo hits map to the `[episode YYYY-MM-DD]` tag only when the *hydrated memo row's* `meta.kind === 'episode_summary'` (mirroring `inject.js:formatHit` lines 30-32, which inspects `hit?.meta?.kind` on the recall hit at format-time). All other memo hits do not produce citation lines in the prompt and therefore cannot be citation-matched here; they can still be matched by the similarity pass. The hydration SELECT (`SELECT id, content, ts, meta FROM memos WHERE id IN $memo_ids`) pulls the memo `meta`, so this check runs entirely against the in-memory hydration map.

1. **Explicit pass.** If the reply contains a structured marker `<!-- recall_used: ID1,ID2,... -->` (introduced by the future `recall_used` MCP tool — see §5), and the hit's normalised id string is in the comma-separated list, mark `used=true, used_via='explicit'`. This skips the rest of the passes for that hit.
2. **Citation pass.** Parse the reply for `[event YYYY-MM-DD]` and `[episode YYYY-MM-DD]` substrings (regex `/\[(event|episode) (\d{4}-\d{2}-\d{2})\]/g`). For each citation in source order, find the *not-yet-matched* hit whose tag matches the citation's keyword (`event` vs `episode` per the rule above) and whose `|hit.ts - citation.date|` (in whole days, UTC) is `≤ citation_date_window_days`. If multiple hits qualify, pick the one with the smallest day-delta (ties broken by the hit's existing rank — `ranked_hits[].rank`, set by `inject.js` line 201). Mark `used=true, used_via='citation'`.
3. **Similarity pass.** For any hit still unmarked, compute Jaccard over content-word tokens (`/\W+/`-split, length > 3, lowercased — same set construction `inject.js:substringOverlap` uses). Numerator: `|tokens(hit.content) ∩ tokens(reply_body)|`. Denominator: `|tokens(hit.content)|` (asymmetric — we ask "how much of the hit shows up in the reply"). If `score ≥ similarity_threshold` AND intersection size `≥ jaccard_min_overlap_tokens`, mark `used=true, used_via='similarity', used_score=score`. The asymmetric Jaccard is deliberate: a long reply against a short hit shouldn't be penalised by the long reply's volume.

After all three passes, any remaining hits get `used=false` (with no `used_via` field set).

Pure function — no DB access in any pass. All hits in a row are scored against the same reply body, so we tokenise the reply once and reuse.

**Hit content must be hydrated.** `ranked_hits[]` today stores only `{record, kind, score_components, rank}` from the intuition path (`inject.js` lines 196-201) or `{record, kind, dist, rank}` from the MCP `recall` tool path (`system/io/mcp/tools/recall.js:106-111`) — neither carries content or `ts`. Hydrate via the caller-batched maps:

```surql
SELECT id, content, ts, meta FROM events  WHERE id IN $event_ids;
SELECT id, content, ts, meta FROM memos   WHERE id IN $memo_ids;
```

The caller (the new pre-pass in `evaluatePending`) splits `ranked_hits` across the whole 200-row batch into two id sets by `String(hitRecordId(hit)).startsWith('memos:')`, executes the two SELECTs, and builds a `Map<id_str, {content, ts, meta}>`. Two queries per `evaluatePending` tick regardless of batch size. Same idiom as the existing correction pre-fetch.

Deleted hits (memo archived by `step-compaction`, event purged, or otherwise missing) drop out of the map. `attribute()` marks them `used=false, used_via='hit_missing'` and increments `row.attribution.dropped_hits` — these cannot be reinforced anyway because the downstream `signal_count` UPDATE was already silent-on-not-found (`reinforcement.js:206-211`).

### 3.3 — Persisting attribution

After `attribute` runs, each pending row carries the updated `ranked_hits` (with new `used`, `used_via`, `used_score` keys per entry), plus the top-level `attribution` and `reply_event_id` fields. These have to be written back.

The existing `reinforcement.js` lines 215-233 already issue one `UPDATE recall_log` per outcome bucket (typically three: `reinforced`, `corrected`, `evaluated_no_signal`). Those UPDATEs only set `outcome` and `evaluated_at`, which is bucket-uniform. With B1, each row's `ranked_hits`/`attribution`/`reply_event_id` payload is row-specific — they cannot be expressed as a bucketed UPDATE.

We send them as a single multi-statement query batched per `evaluatePending` tick:

```surql
-- One statement per row, sent in a single round-trip.
UPDATE $row_id_1 SET ranked_hits = $hits_1, attribution = $attr_1, reply_event_id = $rid_1;
UPDATE $row_id_2 SET ranked_hits = $hits_2, attribution = $attr_2, reply_event_id = $rid_2;
-- ...
```

Built via the existing `BoundQuery` pattern (one `BoundQuery` carries all 200 statements; SurrealDB executes them sequentially in one connection turn). One round-trip per tick, regardless of batch size — same shape as the existing outcome-bucket UPDATEs. The outcome UPDATEs (lines 215-233) remain separate and unchanged because they are still bucket-uniform.

Build pseudocode:

```
sql_parts = []
params = {}
for i, row in enumerate(evaluated_rows):
  sql_parts.append(`UPDATE $row_id_${i} SET ranked_hits = $hits_${i}, attribution = $attr_${i}, reply_event_id = $rid_${i};`)
  params[`row_id_${i}`] = row.id
  params[`hits_${i}`]   = row.ranked_hits
  params[`attr_${i}`]   = row.attribution
  params[`rid_${i}`]    = row.reply_event_id    # may be null (corrected/no_hits/no_reply paths)
db.query(new BoundQuery(sql_parts.join('\n'), params))
```

200 statements per tick × ~150 bytes per statement ≈ 30 KB query string. Within SurrealDB's accepted query size. If a future scaling concern appears (e.g., LIMIT 200 raised), partition into chunks of 50 statements each.

Each row is touched by **two** UPDATEs in the same tick under B1: the existing outcome-bucket UPDATE (`reinforcement.js:215-233`, sets `outcome` + `evaluated_at`) plus the new per-row attribution UPDATE above. We could fold them by giving up the outcome bucketing, but that trades three bucketed UPDATEs for an extra 200 row-specific UPDATEs — a net loss. Keep them separate. The two UPDATEs do not race because both run inside the same `evaluatePending` invocation, sequentially.

## Section 4 — Reinforcement bucketing changes

After §3 runs, `evaluatePending` continues with the existing loop (`reinforcement.js` lines 84-108) — but the `memoHitCount` Map is now built from `hit.used === true` only, not from "every memo in a non-corrected row":

```diff
- for (const hit of row.ranked_hits) {
-   const id = hitRecordId(hit);
-   if (!id?.startsWith('memos:')) continue;
-   memoHitCount.set(id, (memoHitCount.get(id) ?? 0) + 1);
- }
+ for (const hit of row.ranked_hits) {
+   if (hit.used !== true) continue;
+   const id = hitRecordId(hit);
+   if (!id?.startsWith('memos:')) continue;
+   memoHitCount.set(id, (memoHitCount.get(id) ?? 0) + 1);
+ }
```

**Outcome enum: one new value.** A row whose hits all ended with `used=false` (no correction in the window) would be marked `reinforced` under today's enum even though no memo was actually bumped. To keep `outcome` meaningful (and to make `explain_recall` distinguishable from a true reinforce), introduce `outcome = 'evaluated_no_used'`. The assignment now becomes (post-§3 pre-pass, replacing the cascade at `reinforcement.js` lines 91-108):

```
if row corrected:                          outcome = 'corrected'
elif len(row.ranked_hits) == 0:            outcome = 'evaluated_no_signal'
elif used_count(row.ranked_hits) == 0:     outcome = 'evaluated_no_used'   # NEW
else:                                       outcome = 'reinforced'
```

Where `used_count` filters on `hit.used === true`. The previously-implicit "any hit means reinforce" is now "any *used* hit means reinforce". Paths that mass-mark `used=true` (`off`, `fallback_no_reply`+on, `fallback_zero_used`+on) still land in `reinforced`. Paths that mass-mark `used=false` (`fallback_no_reply`+off, `fallback_zero_used`+off) land in `evaluated_no_used`. `pending` is unchanged (rows newer than the window).

Migration: extend the `ASSERT` on `recall_log.outcome` (line 299-300 of `0001-init.surql`) in `0009-per-hit-reinforcement.surql`.

```surql
REMOVE FIELD outcome ON recall_log;
DEFINE FIELD outcome ON recall_log TYPE string DEFAULT 'pending'
  ASSERT $value IN ['pending', 'reinforced', 'corrected', 'evaluated_no_signal', 'evaluated_no_used'];
```

(SurrealDB v3 lets you `REMOVE FIELD` and re-`DEFINE FIELD` in the same migration; existing rows keep their string value.)

## Section 5 — Explicit attribution: the `recall_used` MCP tool (optional, opt-in)

Out of scope for the first cut of B1 — but the schema and `attribute()`'s "explicit pass" are designed so an opt-in MCP tool can be added without further migration.

Shape (for forward-reference; not implemented in B1):

```js
// system/io/mcp/tools/recall-used.js
{
  name: 'recall_used',
  description: 'Acknowledge which recall hits were used in the current reply. Improves Robin\'s learning signal.',
  inputSchema: {
    type: 'object',
    properties: {
      memo_ids: { type: 'array', items: { type: 'string' } },
    },
    required: ['memo_ids'],
  },
}
```

When implemented, the tool would emit `<!-- recall_used: ID1,ID2 -->` as a trailer that the agent appends to its reply. The trailer is captured into the conversation event by `captureFromTranscript` like any other reply text, and §3.2's explicit pass already parses it. (An alternative — writing a separate `events` row of `meta.kind='recall_used'` — would require additional lookup logic; we explicitly choose the inline-trailer route so attribution stays a single-event read.)

Listed here for completeness because the *plumbing* in `attribute()` is part of B1 even though the agent-facing tool is a follow-up.

## Section 6 — Evidence ledger integration

Theme 2a (`docs/superpowers/specs/2026-05-11-robin-v2-theme-2a-evidence-ledger-design.md` §4.1) defined the producer site as:

> `reinforcement.js` (`recall_log → reinforced`) → corroborate per memo recalled, `weight = N` where N is the row's hit-count for that memo.

B1 changes the *meaning of N* — from "times recalled in this batch" to "times *actually used* in this batch". The emission site is unchanged. Concretely, in `reinforcement.js` lines 161-182:

- `memoHitCount` now reflects `used=true` only (§4).
- The existing `CREATE evidence_ledger CONTENT { ... weight: $w }` query still fires.
- Result: corroborate weight per memo = number of pending rows in this batch where that memo was both injected *and* used. Closer to truth.

Refute path (correction) stays as-is. Per Theme 2a §12 open question, refutation today still hits every memo in the corrected row — narrowing it requires LLM judgement and is out of scope here.

`addEvidence` (`system/cognition/memory/evidence.js` lines 7-19) is the canonical writer; reinforcement.js today inlines the SurrealQL. We could route through `addEvidence` for consistency, but that's a separable refactor (see §10 — "Modified" file list flags it as a small refactor; behavior-equivalent to the inlined CREATE). The B1 spec only requires the *count* feeding the ledger row to come from `used=true` hits.

## Section 7 — Edge cases

Every case below is reachable in the wild; each has a documented behavior.

### 7.1 — Stop hook fires with no assistant turn

`captureFromTranscript` returns `{captured:false, skippedReason:'no_assistant_turn'}` — no conversation event lands. `findReplyEvent` returns null. Behavior: governed by `fallback_when_no_reply` (default `true` → reinforce-all, preserves today's behavior; `false` → mark all hits unused). Telemetry: `attribution.mode = 'fallback_no_reply'` (same value in both fallback branches; `used_count` differentiates).

### 7.2 — Agent paraphrases without citation markers

Reply has no `[event YYYY-MM-DD]` markers. Citation pass yields zero matches. Similarity pass picks up hits whose content tokens leak through (≥ `similarity_threshold`). Hits whose phrasing diverges entirely get `used=false`. This is the *intended* failure mode of similarity: false negatives, never false positives at the threshold we picked. We accept the false negatives because `fallback_when_zero_used = true` (default) catches the degenerate "matched nothing at all" case.

### 7.3 — Multiple recalls in one session

Each UserPromptSubmit creates its own `recall_log` row. Each pending row finds its own reply event (the earliest `source='conversation'` event in `[row.ts, row.ts + win]`). If two recalls happen back-to-back (e.g., user sends two prompts within 2 minutes), `findReplyEvent` returns the *first* reply for both — wrong attribution for the second.

Mitigation: when picking the reply for row R, also require `reply.ts ≥ R.ts` AND `reply.ts < (next pending row in same session).ts` if such a row exists. Compute by sorting `pending` by `(session_id, ts)` and walking the windows in JS (one pass; no extra queries). Documented in §3.1's batch pseudocode; left out of the simple form for clarity.

### 7.4 — Correction landed AND some hits were used

The row is `corrected`. Today, *all* memos in the row are refuted (Theme 2a). Under B1, that does not change — we don't narrow refutation. `used` is still computed and stored on `ranked_hits[]` for explainability, but the bucketing logic (lines 113-159 of `reinforcement.js`) skips `used`-ness for the corrected branch. Telemetry: `attribution.mode = 'corrected'` (set as a short-circuit before §3 runs — saves the reply lookup for corrected rows).

### 7.5 — Hit references a `private` scope memo

Scope is irrelevant to attribution: `attribute()` reads only `hit.content` (already in the prompt the agent saw — so the agent's reply may legitimately quote it) and reply body. `signal_count` and `evidence_ledger` writes are scope-blind today and stay that way. Theme 4's `explain_recall` redacts private hits at *read* time (`system/io/mcp/tools/explain-recall.js` lines 35-49). That redaction continues to work because it operates on hit `scope` after hydration, untouched by B1.

### 7.6 — Hit is an event, not a memo

The injection block includes both event and memo hits (`inject.js` lines 110-119, `_kind` in `{event, memo}`). Today's reinforcement loop *already* skips non-`memos:` hits (`reinforcement.js` line 101 — `if (!id?.startsWith('memos:')) continue;`). Under B1: event hits still get `used` computed and stored on `ranked_hits[]` (useful for the reranker training data), but no reinforcement is applied (no `signal_count` on events; no `evidence_ledger` row — events have no ledger). Spec is explicit: `evidence_ledger.memo_id` is `TYPE record<memos>` per Theme 2a §1 — events cannot land in it.

### 7.7 — Hit was deleted between recall and reinforcement

Memo was archived by `step-compaction` (`docs/faculties.md` §compaction), or superseded, or directly deleted. The hydration query in §3.2 returns no row for that ID. `attribute()` marks it `used=false, used_via='hit_missing'`. No `signal_count` bump (it would have failed silently with "does not exist" anyway — already swallowed at lines 178-181 of `reinforcement.js`). Counter `attribution.dropped_hits += 1` on the row meta.

### 7.8 — Empty `ranked_hits`

Same as today: `outcome = 'evaluated_no_signal'`, no attribution work performed (§3 skips empty-hit rows). `attribution.mode = 'no_hits'`.

### 7.9 — `attribution_mode = 'off'` (kill switch)

§3 still runs but takes the kill-switch branch: every hit is marked `used=true,used_via='off'`, no reply lookup happens, no `attribute()` call. Downstream §4 bucketing then filters on `used===true` and reproduces today's "every memo in a non-corrected row gets credit" behavior. `attribution.mode = 'off'`. This is the rollback path described in §9.

### 7.10 — Same memo in `ranked_hits` twice

Can't happen in `inject.js` (the merge + MMR-lite dedupe by content overlap), but `recall.js` MCP tool path is independent. If duplicate occurs, attribution scores each entry independently; `memoHitCount` would over-count by the duplicate factor *for used hits only*. Acceptable, but document in §10 as a follow-up cleanup if telemetry shows it happening at scale.

## Section 8 — Test plan

### 8.1 — Unit tests

`system/tests/unit/reinforcement-attribute.test.js` (new):

1. **Explicit marker**: reply containing `<!-- recall_used: memos:abc -->` → that hit `used=true, used_via='explicit'`; others `used=false`.
2. **Citation match**: reply containing `[event 2026-05-10]`; hit with `ts = 2026-05-10T...`, `_kind='event'` → `used=true, used_via='citation'`. Hit with `ts = 2026-05-08` is *not* matched (outside default 2d window). Hit with `_kind='memo'` is *not* matched (tag mismatch).
3. **Citation date window**: with `citation_date_window_days=0`, the 2026-05-10 hit is matched but a hit with `ts = 2026-05-09` is not.
4. **Similarity asymmetric**: reply contains 80% of hit's tokens-over-3-chars → `used=true, used_via='similarity', used_score ≥ 0.8`. With reply much longer than hit (e.g., 10x), Jaccard ratio uses `|tokens(hit)|` denominator → still passes.
5. **Similarity threshold floor**: hit with 1 unique token of overlap to reply, ratio = 0.5 (1/2 hit tokens) — fails `jaccard_min_overlap_tokens=2`. `used=false`.
6. **Combined**: reply has one cited hit, two paraphrased hits, three unrelated. Asserts: `hits.map(h => h.used)` is `[true, true, true, false, false, false]`; `hits.map(h => h.used_via ?? null)` is `['citation', 'similarity', 'similarity', null, null, null]`.
7. **Empty reply body**: `used=false` for all hits.

`system/tests/unit/reinforcement-config.test.js` (new):

8. Default config used when `runtime:\`reinforcement.config\`` row is missing.
9. Partial config merges with defaults (only `similarity_threshold` set → other fields default).
10. `attribution_mode = 'off'` → §3 pipeline skipped (verifies via stub `attribute` is never called).

### 8.2 — Integration tests

Extend `system/tests/integration/reinforcement-loop.test.js`:

11. **Per-hit reinforce**: seed memo M with content "the eclipse on tuesday"; seed `recall_log` with two hits (M and an unrelated memo N) at `ts=now-10min`; seed `events:conversation` with content `"USER: ...\n\nASSISTANT: yeah the eclipse on tuesday was cool"` at `ts=now-9min`. Run `evaluatePending`. Assert: M.signal_count += 1; N.signal_count unchanged; M has one `evidence_ledger` corroborate row; N has zero.
12. **Citation match**: reply contains literal `[event 2026-05-10]` referencing event E1 (with matching ts). Assert E1 `used=true, used_via='citation'` in the persisted `ranked_hits`. (E1 is an event, so no signal_count change — but the persisted `used` flag must be set.)
13. **Correction supersedes attribution**: same setup as test 11 plus a `meta.kind='correction'` event landing in the window. Assert: row outcome = `corrected`; both memos get `evidence_ledger` refute (Theme 2a behavior); no corroborate written.
14. **No reply event, fallback on**: seed pending row but no conversation event. Default config. Assert: row outcome = `reinforced`; M.signal_count += 1; `attribution.mode='fallback_no_reply'`; each hit has `used=true, used_via='fallback'`.
15. **No reply event, fallback off**: same as 14 but `fallback_when_no_reply=false`. Assert: row outcome = `evaluated_no_used`; M.signal_count unchanged; `attribution.mode='fallback_no_reply'`; each hit has `used=false`.
16. **Zero used + fallback on**: reply is `"USER: hi\n\nASSISTANT: cool"`; hits are about eclipses. With `fallback_when_zero_used=true`, falls back; `attribution.mode='fallback_zero_used'`. With it `false`, `outcome='evaluated_no_used'`.
17. **Multiple recalls one session**: two pending rows in same session, two conversation events. Each row attributes against its own reply. Verify pairing by the §7.3 windowing rule.
18. **Backward compat**: `recall_log` rows pre-dating B1 (with no `attribution_mode` set anywhere) still get processed by today's bucketing when `attribution_mode='off'` is set. Specifically: pre-existing rows with `outcome='pending'` and old `ranked_hits` shape (no `used` field) → with mode `off`, treated exactly as before. (See §9.)

### 8.3 — Verification gates (mirror Theme 2a §8)

19. **Per-hit corroborate**: with one used memo hit and one unused, exactly one `evidence_ledger` corroborate row is written (the used one).
20. **Mode telemetry recorded**: every evaluated row has `attribution.mode` set; values in `{explicit, citation, similarity, no_reply, fallback_zero_used, fallback_no_reply, no_hits, corrected, off}`.
21. **Idempotence**: running `evaluatePending` twice with no new pending rows is a no-op (already guarded by `outcome != 'pending'` filter — verify it still holds).
22. **Verify-design-assumptions guard 12 carried forward** (`system/runtime/scripts/verify-design-assumptions.js:381-456` — function `gateReinforceCountBucket`): the existing test (3 pending rows referencing the same memo, no reply event) currently expects `signal_count += 3` regardless of B1. To preserve that invariant in `attribution_mode='off'` mode (the default seeded value at land time), the gate is run with the runtime config explicitly set to `'off'`. Add a new gate 12b that runs the same setup under `attribution_mode='hybrid'`, seeds a matching conversation event with reply body containing the memo content (so similarity matches across all three rows), and asserts `signal_count += 3` again. A second variant of 12b seeds an empty reply with `fallback_when_zero_used=false` and asserts `signal_count` is **unchanged**.

## Section 9 — Rollout / migration

**Two-stage ship.** The migration seeds `attribution_mode = 'off'` (legacy-equivalent — verified by integration test 18). The rollout sequence below then flips the runtime config to `'hybrid'` once telemetry is in place. This split is deliberate: it lets the schema land with zero behavior change, so the code-and-config flip is a single one-line operation reversible by another one-line operation.

The eventual steady-state defaults are `attribution_mode = 'hybrid'`, `fallback_when_no_reply = true`, `fallback_when_zero_used = true`. That combination is a strict subset of today's reinforcement for any row where attribution fails (it falls back to the same all-hits-credited behavior) and a stricter, more accurate version for any row where it succeeds. We accept the asymmetry because gradually narrowing credit is the point of the change.

### 9.1 — Migration

`system/data/db/migrations/0009-per-hit-reinforcement.surql`:

```surql
-- Top-level optional fields on recall_log.
DEFINE FIELD reply_event_id ON recall_log TYPE option<record<events>>;
DEFINE FIELD attribution    ON recall_log TYPE option<object> FLEXIBLE;
DEFINE INDEX recall_log_reply ON recall_log FIELDS reply_event_id;

-- Extend outcome enum.
REMOVE FIELD outcome ON recall_log;
DEFINE FIELD outcome ON recall_log TYPE string DEFAULT 'pending'
  ASSERT $value IN ['pending', 'reinforced', 'corrected', 'evaluated_no_signal', 'evaluated_no_used'];

-- Seed config — ships in 'off' mode for the schema-only land step
-- (rollout step 1 in §9.2). Flipped to 'hybrid' via UPDATE in rollout step 4.
-- Backtick-quoted record ID matches the house style established by
-- 0003/0005/0006/0007/0008 (`evidence.config`, `cadence.config`, etc.).
UPSERT runtime:`reinforcement.config` SET value = {
  attribution_mode: 'off',
  similarity_threshold: 0.35,
  jaccard_min_overlap_tokens: 2,
  citation_date_window_days: 2,
  fallback_when_no_reply: true,
  fallback_when_zero_used: true,
  reply_lookup_window_ms: 600000
};
```

No backfill on existing `recall_log` rows. Rows with `outcome='pending'` written before the upgrade get evaluated by the new code path — they will hit "no reply event" almost certainly (the conversation event predates the indexing) and fall back to today's behavior. Net effect: nothing for old rows; new rows get attribution. (Verified by integration test 18.)

### 9.2 — Rollout sequence

1. Land migration `0009-per-hit-reinforcement.surql` with seed `attribution_mode='off'` (§9.1). Code path is dormant; existing reinforcement tests pass unchanged. Verified by integration test 18.
2. Land the attribution pipeline (§3) + `attribute.js` + `reinforcement-config.js`. With `attribution_mode='off'` still in the runtime row, the new code marks every hit `used=true, used_via='off'` and the bucketing logic (§4) reproduces today's behavior bit-for-bit (verified by integration test 18 again, post-pipeline).
3. Land the Theme 4 hook extension: extend `explain_recall` to surface `used`, `used_via`, `attribution.mode` per row. Add `show_attribution_health` introspection rollup (`{mode: count}` over last 24 h) keyed off `recall_log.attribution.mode`.
4. On Kevin's instance, flip the runtime config: `UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid';`. Watch `show_attribution_health` for one week. Healthy distribution looks like: majority of rows in `citation` + `similarity`, low single-digit-% in `fallback_no_reply` and `fallback_zero_used`, near-zero in `hit_missing`-dominated rows.
5. After the week, flip the seed value in `0009-per-hit-reinforcement.surql` *for new installs only* — existing installs already have their runtime row written and the migration is checksum-pinned (`migrate.js:51-55` rejects edits to already-applied migrations). Bumping the seed therefore only affects fresh installs.  (Optional: emit a one-off "config drift" migration `0010-reinforcement-mode-default-hybrid.surql` that runs `UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid' WHERE value.attribution_mode = 'off';` if we want existing instances to roll forward too.)
6. Track B1.1 (`session_id` plumbing — §11) as a separate PR; revisit timing when the `fallback_no_reply` rate stays elevated or when multi-host scenarios become common.

### 9.3 — Rollback path

`UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'off';` — instant. The next `evaluatePending` tick reverts to legacy behavior (every hit marked `used=true,used_via='off'`; downstream bucketing matches today). New attribution metadata persists on already-processed rows but is ignored by downstream consumers under `off`.

## Section 10 — File-by-file changes

**Created:**

- `system/data/db/migrations/0009-per-hit-reinforcement.surql` — schema + seed (§9.1).
- `system/cognition/intuition/attribute.js` — pure module exporting `attribute(hits, replyBody, config)`. No DB imports.
- `system/cognition/intuition/reinforcement-config.js` — `readReinforcementConfig(db)`, cached per tick.
- `system/tests/unit/reinforcement-attribute.test.js` — §8.1 tests 1-7.
- `system/tests/unit/reinforcement-config.test.js` — §8.1 tests 8-10.
- (Integration tests live in the existing `reinforcement-loop.test.js`.)

**Modified:**

- `system/cognition/intuition/reinforcement.js`:
  - Add batched reply-event lookup pre-pass (§3.1 batched form).
  - Add hit-content hydration pre-pass (§3.2).
  - Call `attribute()` per row; merge into `ranked_hits` in memory.
  - Change `memoHitCount` build to filter on `hit.used === true` (§4 diff).
  - Persist `ranked_hits`, `attribution`, `reply_event_id` in the outcome UPDATE (§3.3).
  - Short-circuit attribution for `corrected` rows (set `attribution.mode='corrected'`).
- `system/cognition/intuition/inject.js`:
  - **No behavior change required for B1.** The hit content is still hydrated from `events`/`memos` at reinforcement time (§3.2). Storing `content` in `ranked_hits` at recall time would save the hydration query but inflates `recall_log` row size — defer until telemetry justifies it.
  - **Recommended ancillary fix (B1.1, separable PR):** pass `session_id` through `intuitionEndpoint` and into the `recall_log` CREATE. Today the CREATE statement (`inject.js` lines 202-212) omits `session_id`, and `intuitionHandler` (`handler.js`) doesn't even fetch it from stdin despite Claude Code providing it (see `system/io/hooks/session-start.js:22-26` for the canonical extraction). Plumbing it through: extract from stdin in `handler.js`, include in the POST body to `/internal/intuition`, accept in the daemon endpoint (`server.js:897-920`), pass into `intuitionEndpoint`, include `session_id` in the recall_log CREATE. Same fix unblocks `getSessionId: () => null` in `server.js:391`. Tracked separately because it touches the hook surface.
- `system/data/db/migrate.js`: no change needed. The runner reads `*.surql` files filtered + sorted alphabetically (`migrate.js:36`), extracts the leading version digits (`parseVersion`, `migrate.js:21-25`), and applies new files in order. Versions `0001..0008` are already taken (`0001-init`, three profile-specific `0002-embeddings-*`, plus `0003`..`0008` for evidence-ledger, action-trust-ledger, cadence, compaction, arcs, doctor). B1's migration must therefore use version `0009` — hence the filename `0009-per-hit-reinforcement.surql`.
- `system/io/mcp/tools/explain-recall.js`: surface `used`, `used_via`, `used_score`, `attribution`, `reply_event_id` in the response. Continue redacting private hits as today.
- `system/runtime/scripts/verify-design-assumptions.js`: add gate 12b (per-hit-used invariant, §8.3-22).
- `docs/architecture.md`: update the §"A typical agent turn" item 9 to mention per-hit attribution. Update the diagram "Reinforcement" line to reference per-hit credit.
- `docs/faculties.md`: extend §reinforcement to describe the attribution pass and config knobs.

## Section 11 — Open questions

These are real ambiguities the design *acknowledges and defers*; not gaps the author missed.

- **`recall_log.session_id` plumbing (B1.1).** The intuition hook never sets `session_id` on the `recall_log` row (verified: `inject.js` line 204-210; `handler.js` doesn't fetch it from stdin either, despite Claude Code passing it). This makes §3.1's session-bucketed reply lookup degrade to a global `ts` window scan. Fix is mechanical but touches the hook surface — split into a separate PR (B1.1) so B1 doesn't grow. Until B1.1 lands, attribution still works but is less precise (uses earliest conversation event in the time window regardless of session, which is fine for the typical one-active-session-per-host case).
- **`getSessionId: () => null` in the MCP recall tool path.** `system/runtime/daemon/server.js:391` passes a stub. Same root cause as B1.1; same fix.
- **Hit content storage at recall time.** Storing `content` directly in `ranked_hits[]` would eliminate the hydration query in §3.2 but inflate `recall_log` row size (each row caps at `k=6` hits × up to ~600 chars per hit = ~4KB more per row). Defer until either (a) hydration becomes a measurable hot spot, or (b) we want to evaluate against memos that have since been deleted (archived hits are currently lost from attribution per §7.7).
- **Per-hit refutation on correction.** Theme 2a's open question #2 — same status. B1 deliberately does not narrow refutation.
- **Per-session reinforcement dedup.** Theme 2a open question #1 carries over: a memo cited twice in one session still gets two corroborates. Validate against telemetry first.
- **Tuning `similarity_threshold`.** 0.35 is a starting guess. Tune after one week of `hybrid` mode telemetry — look at the distribution of `used_score` and the false-positive rate (compare against hand-labeled samples from `explain_recall`).
- **`recall_used` MCP tool (§5).** Designed-around but not implemented in B1. Listed as a follow-up once we see which hosts (Claude Code, Gemini CLI) can/should be taught to call it.

## Section 12 — Cost envelope

- Per `evaluatePending` tick (200 pending rows max, default heartbeat):
  - +1 SELECT on `runtime:\`reinforcement.config\`` (cached per tick).
  - +1 SELECT on `events` for batched reply lookup (uses `events_source` + `events_ts`; an optional composite `events_source_ts` index can be added later if benchmarks show a hot spot — not load-bearing for B1).
  - +2 SELECTs (events + memos) for batched hit hydration (one per surface, regardless of batch size).
  - Per-row inside `attribute()`: zero DB calls (pure JS over the hydrated maps).
  - +1 multi-statement UPDATE on `recall_log` (one round-trip, ≤200 statements per tick — see §3.3).
  - Existing outcome-bucket UPDATEs (3 max) and memo `signal_count` UPDATEs (one per distinct hit-count bucket): unchanged in count; bucket sizes are **smaller or equal** to today because `used=true` is now the filter.
  - `evidence_ledger` writes: at most as many as today (only `used=true` triggers them; corrected refute path unchanged).
- New LLM tokens: **zero**.
- New embedding tokens: **zero**.
- Memory: tokenized reply body is ~few KB per row × 200 rows max per tick = <1MB transient.

Within the post-alpha.16 cost envelope (no Theme 3 cadence impact — this is not a cadence-eligible step).

## Section 13 — Sequencing within B1

Short engineering view (the operational rollout sequence lives in §9.2). Land-order is:

1. Schema migration `0009-per-hit-reinforcement.surql` (additive; seed `attribution_mode='off'`).
2. `attribute.js` + `reinforcement-config.js` + unit tests (§8.1). No production behavior change.
3. Wire into `reinforcement.js` behind the `off`/`hybrid` switch. Integration tests (§8.2 #11-18). Production still in `off`.
4. Verify gate 12b (§8.3-22).
5. `explain_recall` extension + `show_attribution_health` rollup (Theme 4 follow-up).
6. Runtime config flip on Kevin's instance via `UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid';` (after one week of dogfood under #5). See §9.2 step 5 for the question of whether to ship a follow-up "config drift" migration for existing instances.

## See also

- `2026-05-11-robin-v2-theme-2a-evidence-ledger-design.md` — corroborate/refute producer, the layer this spec narrows.
- `2026-05-11-robin-v2-database-and-memory-redesign-design.md` — `signal_count`, `recall_log`, `fn::freshness`.
- `2026-05-11-robin-v2-theme-4-observability-design.md` — `explain_recall` is the read surface for the new `used`/`used_via` fields.
- `2026-05-11-robin-v2-evolution-roadmap.md` — umbrella; B1 sits in the "Cognition B" track post-alpha.16.
- `system/cognition/intuition/inject.js` — citation marker producer (`[event YYYY-MM-DD]`, `[episode YYYY-MM-DD]`).
- `system/cognition/intuition/reinforcement.js` — the file most modified by B1.
- `system/io/capture/session-capture.js` — the conversation-event writer whose output `findReplyEvent` reads.
