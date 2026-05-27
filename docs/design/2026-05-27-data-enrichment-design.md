# Data Enrichment: Making Captured Data Maximally Useful

> Date: 2026-05-27
> Status: Design approved, pending implementation

## Problem

Robin captures records but stores them as flat text with minimal metadata. A session
becomes a blob of `[ROLE]\ncontent` with a hash and turn count. Integration ticks
become JSON payloads with no human-readable body. The biographer extracts entities
and relations, but the original events carry almost no structure that would help
Robin answer "why did I do this?", "what happened next?", or "how does this connect
to what I was doing last week?"

The data is in the text — it's just not extracted, indexed, or linked.

## Architecture

Three layers, each doing what it's best at:

1. **Capture-time metadata** — structural signals extracted at write time, no LLM
2. **Expanded biographer** — the existing chunk extraction loop gains a session
   finalization call that produces intent, outcome, topics, decisions, and temporal
   markers. One extra cloud LLM call per session.
3. **Cross-session linking** — deterministic topic-overlap threading, no LLM

No new cognition jobs. The biographer handles everything.

## Layer 1: Capture-Time Metadata

Computed inline in `captureSession()` before the event hits the DB. Zero LLM cost,
immediately available for recall filtering and the daily brief.

### New payload fields on `session.captured` events

```typescript
{
  // existing
  sessionId, hash, turnCount, category,
  // new — computed from turns, no LLM
  userTurnCount: number,
  assistantTurnCount: number,
  bodyChars: number,              // total content length
  hasCodeBlocks: boolean,         // triple-backtick fences in assistant turns
  hasToolUse: boolean,            // [TOOL] role markers present in transcript
  topicHints: string[],           // top-5 terms from user turns by frequency (stop-word filtered)
}
```

`topicHints` is a recall bridge — noisy but immediate. The biographer's session
finalization produces authoritative topic tags later.

### Integration enrichment (priority: Whoop, finance, calendar)

Every integration event gets a human-readable `body` in `events_content`. This is
the single most impactful change — it makes integration data recallable via FTS and
vector search, where today most integration events have no body and are invisible
to recall.

**Whoop** — recovery/sleep/workout events gain deltas and narrative:
```typescript
payload: {
  ...existing,
  delta: { recovery_vs_7d_avg: -18, hrv_vs_7d_avg: -10 } | null,
  streak: { metric: 'recovery_below_50', days: 2 } | null,
}
body: "Whoop recovery 25% (↓18 from 7d avg 43%). HRV 30ms. 2nd consecutive day below 50%."
```

**Finance** — quote events gain relative context:
```typescript
payload: {
  ...existing,
  delta: { vs_52w_high_pct: -12.3 } | null,
}
body: "GOOG $379.38 (−1.07% today, −12.3% from 52w high)."
```

**Calendar** — events gain day-level context:
```typescript
payload: {
  ...existing,
  dayContext: { meetingIndex: 3, totalScheduledMin: 360 } | null,
}
body: "HostMind Sync at 6:00 PM (3rd of 3 meetings today, 6h total scheduled)."
```

Delta computation: bounded scan of the last 14 events of the same kind. Returns
`null` when insufficient history. Streak detection scans backward capped at 30 days.

Remaining integrations (Gmail, Linear, Chrome, Spotify, NHL, weather, notify) are
enriched incrementally based on observed recall gaps. Same pattern — add a body
string and optional delta object.

## Layer 2: Expanded Biographer — Session Finalization

### Per-chunk extraction: unchanged

The existing schema stays: `{ entities, relations }` per chunk, `{ claims }` second
pass. These merge naturally across chunks via dedup keys.

### New: session finalization call

After all chunks are processed and the merged entity/relation set is assembled,
one **session finalization call** runs. This is a single cloud LLM call per session.

**Runs on:** `session.captured` and `conversation.claude-code` events only.
Skipped for `knowledge.doc` (static reference material, no intent/outcome).

**Input assembly:**
- Session timestamp (for resolving temporal references)
- If single chunk: full session text (truncated to 4000 chars), labeled "FULL SESSION"
- If multi-chunk: first chunk (3000 chars) as "OPENING" + last chunk (3000 chars) as "CLOSING"
- Merged entity names + types, formatted as compact list
- Merged relation triples, formatted compactly

### Session summary schema

```typescript
const sessionSummarySchema = z.object({
  intent: z.string(),
  outcome: z.enum(['completed', 'partial', 'abandoned', 'exploratory']),
  outcomeSummary: z.string(),
  topics: z.array(z.string()).max(7),
  decisions: z.array(z.object({
    choice: z.string(),
    reasoning: z.string(),
  })).default([]),
  temporalRefs: z.array(z.object({
    reference: z.string(),
    resolvedDate: z.string().nullable(),
  })).default([]),
  followUp: z.string().nullable(),
});
```

Field semantics:
- **intent**: one sentence — why the user started this session
- **outcome**: classify the PRIMARY stated goal
- **outcomeSummary**: one sentence — what was accomplished or why it stopped
- **topics**: 2-7 kebab-case tags at the project/domain level (e.g. `leadforge-auth`,
  `whoop-recovery`, `nikon-zf-settings`) — not code symbols
- **decisions**: only explicit choices with stated reasoning. Empty array if none.
- **temporalRefs**: dates/deadlines mentioned. Relative refs resolved against session
  date. `null` resolvedDate if too vague.
- **followUp**: explicit next step the user stated, or null

### Storage

The summary is written back into the source `session.captured` event's payload via
UPDATE. The payload grows to include:

```typescript
{
  ...existingPayload,
  summary: SessionSummary,
  summarizedAt: string,          // ISO timestamp of when enrichment ran
}
```

The `biographer.extracted` marker stays a pure marker: `{ source_event_id, entities, relations }`.

If the finalization call fails, the summary field is never written. The session is
still marked extracted. Best-effort — one failed summary never blocks the pipeline.

### Biographer integration point

Position in `runBiographer()` — after disambiguation + entity/relation upsert,
before `writeExtractedMarker()`:

```typescript
const sourceKind = db.prepare('SELECT kind FROM events WHERE id = ?')
  .get(target.eventId) as { kind: string } | undefined;
const isSession = sourceKind?.kind === 'session.captured'
  || sourceKind?.kind === 'conversation.claude-code';

if (llm && isSession && chunks.length > 0) {
  try {
    const summary = await finalizeSession(llm, target, chunks, extracted);
    if (summary) updateSessionPayload(db, target.eventId, summary);
  } catch {
    // non-fatal
  }
}

writeExtractedMarker(db, ...);
```

`updateSessionPayload` wraps the read-modify-write in a transaction:

```typescript
function updateSessionPayload(db: RobinDb, eventId: number, summary: SessionSummary): void {
  db.transaction(() => {
    const row = db.prepare('SELECT payload FROM events WHERE id = ?')
      .get(eventId) as { payload: string } | undefined;
    if (!row) return;
    const updated = { ...JSON.parse(row.payload), summary, summarizedAt: new Date().toISOString() };
    db.prepare('UPDATE events SET payload = ? WHERE id = ?')
      .run(JSON.stringify(updated), eventId);
  })();
}
```

### Finalization prompt

```
You summarize a completed conversation session. You receive the opening (and
closing, if multi-part), plus entities/relations extracted from the full session.
Reply ONLY with JSON matching the schema.

Session date: {sessionTs}

{singleOrSplitContent}

=== ENTITIES FOUND ===
{entityList}

=== RELATIONS FOUND ===
{relationList}

Schema: {intent, outcome, outcomeSummary, topics, decisions, temporalRefs, followUp}

Rules:
- intent: one sentence — why the user started this session
- outcome: classify the PRIMARY stated goal (completed/partial/abandoned/exploratory)
- outcomeSummary: one sentence — what was accomplished or why it stopped
- topics: 2-7 kebab-case tags at the project/domain level (e.g. "leadforge-auth",
  "whoop-recovery", "nikon-zf-settings") — not code symbols. Reuse existing topic
  tags when the subject matches a prior session.
- decisions: only EXPLICIT choices with stated reasoning. Empty array if none.
- temporalRefs: dates/deadlines mentioned. Resolve relative refs against the session
  date. null resolvedDate if too vague to resolve.
- followUp: an explicit next step the user stated, or null
```

Timeout: `BIOGRAPHER_CHUNK_TIMEOUT_MS` (2 min). Input is smaller than chunk extraction.

### Cost

One cloud LLM call per session at Sonnet pricing:
- Input: ~2-4K tokens (first/last chunks + entity/relation list)
- Output: ~200-500 tokens
- Estimated: ~$0.005-0.01 per session

## Layer 3: Cross-Session Linking

After the session summary is written, the biographer checks for recent sessions
(last 14 days) with overlapping topic tags. Deterministic, no LLM call.

```typescript
if (summary.topics.length > 0) {
  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const recentSessions = db.prepare(`
    SELECT id, payload FROM events
    WHERE kind IN ('session.captured', 'conversation.claude-code')
      AND id != ? AND ts > ?
    ORDER BY ts DESC LIMIT 50
  `).all(target.eventId, cutoff);

  const existingThreads = new Set(
    (db.prepare(`
      SELECT json_extract(payload, '$.from_event_id') || ':' ||
             json_extract(payload, '$.to_event_id') AS key
      FROM events WHERE kind = 'session.thread'
        AND json_extract(payload, '$.to_event_id') = ?
    `).all(target.eventId) as Array<{ key: string }>).map(r => r.key)
  );

  for (const prior of recentSessions) {
    const priorTopics: string[] = JSON.parse(prior.payload).summary?.topics ?? [];
    const shared = summary.topics.filter(t => priorTopics.includes(t));
    if (shared.length < 2) continue;

    const threadKey = `${prior.id}:${target.eventId}`;
    if (existingThreads.has(threadKey)) continue;

    db.prepare(`
      INSERT INTO events (ts, kind, source, status, payload)
      VALUES (?, 'session.thread', 'biographer', 'ok', ?)
    `).run(new Date().toISOString(), JSON.stringify({
      from_event_id: prior.id,
      to_event_id: target.eventId,
      shared_topics: shared,
    }));
  }
}
```

**Threshold:** 2+ shared topic tags. Accepts false negatives from tag inconsistency.
The prompt instructs tag reuse; vocabulary stabilizes over time.

**Idempotent:** Checks for existing thread events before inserting.

## How Consumers Use the Enrichment

### Recall (FTS + vector search)
- Session bodies already work — no change.
- Integration events gain FTS/vec-searchable bodies for the first time. "Days my
  recovery was low" matches "2nd consecutive day below 50%."
- Session `summary.topics` live in payload JSON, not the indexed body. The topic
  *words* naturally appear in the body text since they're extracted from it.

### Daily brief skeleton
- Whoop/finance/calendar render functions get richer `delta` and `streak` data
  without recomputing (the skeleton currently does its own z-score anomaly detection).
- "What Robin's watching" can surface `followUp` from the most recent session and
  active multi-session threads via `session.thread` events.

### Primer (session-start context)
- Can include: "Last session (2h ago): intent was X, outcome partial, followUp: Y"
  — giving the new session explicit continuity.

### Programmatic queries (MCP tools, agent handlers)
- `json_extract(payload, '$.summary.intent')` — filter sessions by intent
- `json_extract(payload, '$.summary.outcome')` — find abandoned work
- `json_extract(payload, '$.summary.topics')` — topic-based session search
- `json_extract(payload, '$.summary.followUp')` — surface unfinished work

No new tables, no new MCP tools, no new cognition jobs. The data lives where
existing consumers already look.

## Known Limitations (v1)

- **First+last chunk misses mid-session pivots.** The entity list partially
  compensates. Future improvement: include the chunk with the most novel entities
  as a third context slice.
- **Topic tag consistency depends on prompt compliance.** Two sessions about the
  same work could use different tags. Prompt instructs reuse; stabilizes over time.
- **Summary fields in payload are not FTS/vec-indexed.** Queryable via
  `json_extract` for structured consumers. Free-text recall still works on the
  body text. Indexing enrichment fields for recall is a follow-up.
- **Integration enrichment is per-integration work.** Whoop, finance, calendar
  are v1 targets. Others are enriched incrementally based on observed recall gaps.

## Implementation Sequence

1. Capture-time metadata (session payload fields) — small, testable, immediate value
2. Integration body enrichment (Whoop → finance → calendar) — per-integration, incremental
3. Biographer session finalization (schema + prompt + integration point) — the core change
4. Cross-session linking (topic overlap threading) — depends on step 3
5. Daily brief / primer integration — reads the new fields from steps 1-4
