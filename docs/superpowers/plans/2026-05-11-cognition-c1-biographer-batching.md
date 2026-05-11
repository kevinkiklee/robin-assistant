# Cognition C1 — Biographer event batching · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the spec end-to-end before starting Phase 1; every section of the spec is referenced by phase number below.

**Goal:** Collapse the N-events-per-Stop-hook-drain biographer hot path into one LLM call per source-scoped batch while preserving every existing semantic: 3-stage entity cascade, per-event episode determination, `evidence_signals`, idempotent edges, race tolerance, and per-event `events.biographed_at` marks.

**Architecture:** Add a windowed source-bucketed accumulator between `queueWrap.enqueue` and `createBiographerQueue`'s worker; introduce `biographerProcessBatch(db, embedder, host, eventIds, opts)` that issues one batched LLM call, fans out per-event resolution / edges / episode / marks under existing `withTxRetry` boundaries, with a per-event fallback to today's `biographerProcess` on outer-envelope failure. Existing `biographerProcess(db, embedder, host, eventId)` becomes a one-line wrapper around the batch path so all current tests pass byte-for-byte.

**Tech Stack:** Node.js 18+ (ES modules) · `node:test` runner · SurrealDB v3 embedded via `surrealdb` JS SDK · existing `recordEvent` + `withTxRetry` + `store.relateAll` + `store.upsertEntity` + `findActiveEpisode`/`createEpisode`/`closeEpisode`.

**Spec:** `docs/superpowers/specs/2026-05-11-cognition-c1-biographer-batching-design.md`

**Dependencies:** None structural. Lands on top of `system/cognition/biographer/pipeline.js` as it is on `refactor/system-restructure`. The `evidence_signals` integration (Theme 2a) ships unchanged through the batched per-event path.

**Migration numbering:** Next free file in `system/data/db/migrations/` is `0009-*.surql` (existing files: `0001..0008`). The umbrella roadmap warns of parallel work also reaching for `0009`; **this plan claims `0011-biographer-batch-config.surql`** to keep clear of v1 leftover names (`0010-runtime-sessions` and `0011-jobs` exist as references in source comments / older plans). Verify free at start of Phase 1; if `0011` collides with another in-flight branch, bump to the next free number and update every reference in this plan.

---

## File structure

| File | Action | Purpose |
|---|---|---|
| `system/data/db/migrations/0011-biographer-batch-config.surql` | Create | Merge `batch_config` defaults onto `runtime:biographer.value` without overwriting operator-set keys. |
| `system/cognition/biographer/pipeline.js` | Modify | Add `DEFAULT_BATCH_CONFIG`, `readBatchConfig`, `biographerProcessBatch`; refactor `biographerProcess` into a wrapper; extend `recordFailure`; write batch telemetry counters. |
| `system/cognition/biographer/batch-prompt.js` | Create | `buildBiographerBatchPrompt({ events, catalog, activeEpisode })` (parallel to `prompt.js`). |
| `system/cognition/biographer/batch-output.js` | Create | `validateBiographerBatchOutput(o, expectedIds)` wrapping `validateBiographerOutput`. |
| `system/cognition/biographer/accumulator.js` | Create | `createBatchAccumulator({ config, fire })` — source-bucketed, three-trigger flush. |
| `system/cognition/biographer/queue.js` | Modify (additive) | Dedupe key falls back to `payload.__queueKey` when payload is an object. Coordinate with R-1: preserve `maxPending` + `skippedSinceBoot` if already present. |
| `system/runtime/daemon/server.js` (pre-R-3) OR `boot.js` + `routes/biographer.js` + `routes/remember.js` (post-R-3) | Modify | Worker branches on payload shape; SELECT `source`; accumulator wired between enqueue sites and queue; `queueWrap.enqueue` accepts object payloads. Detect layout via `test -f system/runtime/daemon/routes/biographer.js`. |
| `system/tests/unit/biographer-batch-prompt.test.js` | Create | Unit tests for `buildBiographerBatchPrompt` (shape, catalog cache control, truncation at 2000 chars). |
| `system/tests/unit/biographer-batch-validate.test.js` | Create | Unit tests for `validateBiographerBatchOutput`. |
| `system/tests/unit/biographer-batch-accumulator.test.js` | Create | Unit tests for the accumulator (count, debounce, hard-cap, source separation, sealed buckets). |
| `system/tests/unit/biographer-queue.test.js` | Modify | Add `__queueKey` dedupe case (existing tests untouched). |
| `system/tests/integration/biographer-batch-pipeline.test.js` | Create | End-to-end batch pipeline tests (equivalence with N=1, entity dedup, episode break, per-event failure isolation, fallback). |
| `system/tests/integration/biographer-batch-race.test.js` | Create | Two-batch race serialisation. |
| `system/tests/integration/biographer-batch-occurs-with.test.js` | Create | Per-event `occurs_with` semantics preserved at batch scale. |
| `system/tests/integration/biographer-batch-before-edges.test.js` | Create | Within-batch consecutive `before` edges respect episode boundaries. |
| `docs/faculties.md` | Modify | "biographer" section: batch trigger, per-event isolation, fallback. |
| `docs/architecture.md` | Modify | "A typical agent turn" step 6 reflects batching + `max_batch_size`. |

---

## Phase 1 — Schema migration for `batch_config`

Covers spec §1 (trigger config keys), §13 ("Modified" notes about `ensureRuntime` not back-filling new keys).

### Task 1.1: Create migration `0011-biographer-batch-config.surql`

**Files:** `system/data/db/migrations/0011-biographer-batch-config.surql`

- [ ] **Step 1: Verify migration slot is free**

```bash
ls system/data/db/migrations/
```

Expected: filenames `0001-init.surql … 0008-doctor.surql`. **If `0009-*.surql`, `0010-*.surql`, or `0011-*.surql` already exist**, pick the next free integer ≥ existing max and rename every reference in this plan accordingly.

- [ ] **Step 2: Write the migration**

Create `system/data/db/migrations/0011-biographer-batch-config.surql`:

```surql
-- ============================================================================
-- C1: Biographer event batching. Merge default batch_config keys onto the
-- existing runtime:biographer row without overwriting operator-set values.
-- The pipeline.js `ensureRuntime` early-returns when `config` is already set,
-- so installs with existing runtime rows would otherwise never pick up
-- batch_config. This migration adds the defaults idempotently.
-- ============================================================================

-- 1. Seed an empty runtime:biographer row if none exists. The pipeline's
--    ensureRuntime would do this on first call, but pre-seeding lets the
--    merge below run unconditionally and lets fresh installs boot the daemon
--    with batch defaults already present.
UPSERT type::record('runtime', 'biographer')
  SET value = {
    config: {
      stage2_high_threshold: 0.92,
      stage2_low_threshold:  0.8,
      episode_window_minutes: 30,
      catalog_size: 100,
      cooccur_cap: 8
    },
    entity_catalog_version: 0,
    batch_config: {
      max_batch_size: 8,
      debounce_ms: 750,
      max_wait_ms: 3000,
      disable: false
    }
  }
  WHERE value IS NONE;

-- 2. Merge batch_config defaults into existing rows. SET nested fields
--    individually so operator-set values are preserved. The IS NONE guard
--    on each leaf field means re-running this migration is a no-op once
--    keys are present.
UPDATE type::record('runtime', 'biographer')
   SET value.batch_config.max_batch_size = 8
 WHERE value.batch_config.max_batch_size IS NONE;

UPDATE type::record('runtime', 'biographer')
   SET value.batch_config.debounce_ms = 750
 WHERE value.batch_config.debounce_ms IS NONE;

UPDATE type::record('runtime', 'biographer')
   SET value.batch_config.max_wait_ms = 3000
 WHERE value.batch_config.max_wait_ms IS NONE;

UPDATE type::record('runtime', 'biographer')
   SET value.batch_config.disable = false
 WHERE value.batch_config.disable IS NONE;
```

- [ ] **Step 3: Run lint and existing tests**

```bash
npm run lint
```

Expected: zero errors. The `.surql` file is not linted by Biome (file-extension filter).

```bash
npm run test:integration -- --test-name-pattern 'migrat'
```

Expected: existing migration tests pass; this migration applies cleanly via `runMigrations`.

- [ ] **Step 4: Commit**

```bash
git add system/data/db/migrations/0011-biographer-batch-config.surql
git commit -m "feat(c1): migration 0011 seeds runtime:biographer.batch_config defaults"
```

---

## Phase 2 — Batched prompt module

Covers spec §2 (prompt structure, catalog `cache_control: ephemeral`, 2000-char content truncation safety belt).

### Task 2.1: Failing test for `buildBiographerBatchPrompt`

**Files:** `system/tests/unit/biographer-batch-prompt.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `system/tests/unit/biographer-batch-prompt.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBiographerBatchPrompt } from '../../cognition/biographer/batch-prompt.js';

test('returns system + user messages with cache control on catalog', () => {
  const r = buildBiographerBatchPrompt({
    events: [
      { id: 'events:a', source: 'cli', content: 'Met Alice.', ts: '2026-05-09T12:00:00Z' },
      { id: 'events:b', source: 'cli', content: 'Discussed Atlas.', ts: '2026-05-09T12:01:00Z' },
    ],
    catalog: [{ name: 'Alice', type: 'person' }],
    activeEpisode: null,
  });
  assert.ok(Array.isArray(r.system));
  assert.equal(r.system.length, 2);
  assert.deepEqual(r.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(r.system[1].cache_control, { type: 'ephemeral' });
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0].content, /events:a/);
  assert.match(r.messages[0].content, /events:b/);
});

test('system prompt declares events[] input + per-event output indexing', () => {
  const r = buildBiographerBatchPrompt({
    events: [{ id: 'events:1', source: 'cli', content: 'x', ts: '2026-05-09T12:00:00Z' }],
    catalog: [],
    activeEpisode: null,
  });
  const sys = r.system[0].content;
  assert.match(sys, /events\[\]/);
  assert.match(sys, /event_id/);
  assert.match(sys, /one object per input event/i);
  assert.match(sys, /episode_continues_previous/);
});

test('truncates event content above 2000 chars (safety belt)', () => {
  const longContent = 'x'.repeat(3000);
  const r = buildBiographerBatchPrompt({
    events: [{ id: 'events:big', source: 'cli', content: longContent, ts: '2026-05-09T12:00:00Z' }],
    catalog: [],
    activeEpisode: null,
  });
  const userMsg = r.messages[0].content;
  // The included content should be truncated to 2000 chars (the safety belt).
  // We can't grep for an arbitrary indicator, but we can assert the user
  // message does not contain the full 3000-char sequence.
  assert.equal(userMsg.includes('x'.repeat(2001)), false);
  assert.equal(userMsg.includes('x'.repeat(2000)), true);
});

test('activeEpisode appears in user message but not in system blocks', () => {
  const r = buildBiographerBatchPrompt({
    events: [{ id: 'events:1', source: 'cli', content: 'q', ts: '2026-05-09T12:00:00Z' }],
    catalog: [],
    activeEpisode: { id: 'episodes:1', summary: 'Atlas planning' },
  });
  for (const m of r.system) {
    assert.doesNotMatch(m.content, /Atlas planning/);
  }
  assert.match(r.messages[0].content, /Atlas planning/);
});

test('source line in user message uses first event source (batches are source-scoped)', () => {
  const r = buildBiographerBatchPrompt({
    events: [{ id: 'events:1', source: 'discord', content: 'q', ts: '2026-05-09T12:00:00Z' }],
    catalog: [],
    activeEpisode: null,
  });
  assert.match(r.messages[0].content, /source=discord/);
});

test('catalog message groups entities by type', () => {
  const r = buildBiographerBatchPrompt({
    events: [{ id: 'events:1', source: 'cli', content: 'q', ts: '2026-05-09T12:00:00Z' }],
    catalog: [
      { name: 'Alice', type: 'person' },
      { name: 'Bob', type: 'person' },
      { name: 'Atlas', type: 'project' },
    ],
    activeEpisode: null,
  });
  const catalogMsg = r.system[1].content;
  assert.match(catalogMsg, /person/);
  assert.match(catalogMsg, /Alice/);
  assert.match(catalogMsg, /Bob/);
  assert.match(catalogMsg, /Atlas/);
});
```

- [ ] **Step 2: Run the test (expect file-not-found / module-not-found)**

```bash
npm run test:unit -- --test-name-pattern 'buildBiographerBatchPrompt|truncates|activeEpisode appears in user|source line|catalog message groups'
```

Expected: failure with `Cannot find module '.../biographer/batch-prompt.js'`.

- [ ] **Step 3: Implement `batch-prompt.js`**

Create `system/cognition/biographer/batch-prompt.js`:

```js
// batch-prompt.js — multi-event biographer prompt.
//
// Parallel to prompt.js, but accepts an array of events and asks the LLM to
// emit one structured output per input event keyed by event_id. The catalog
// system block keeps cache_control: ephemeral so the catalog tokens are paid
// once per LLM call (and reused by the provider's prompt cache across
// consecutive drains). See spec §2.

const SYSTEM_PROMPT = `You are Robin's biographer. For each event in events[], extract structured information about the people, places, projects, topics, and things mentioned, plus their relationships.

Output JSON only, with this exact shape:
{
  "events": [
    {
      "event_id": "<copied verbatim from the input>",
      "entities": [{ "name": string, "type": "person" | "place" | "project" | "topic" | "thing" }],
      "edges":    [{ "from": entity-name, "type": "mentions" | "about" | "precedes" | "works_on" | "participates_in" | "co_occurs_with", "to": entity-name }],
      "about":    [entity-name],
      "episode_continues_previous": boolean,
      "episode_summary": string | null,
      "evidence_signals": [{ "memo_id": string, "polarity": "corroborates" | "refutes" }]
    }
  ]
}

Rules:
- Output one object per input event, in the same order, with the same event_id.
- Per-event entities/edges/about are scoped to that event's content only.
- Names that reference the same real-world thing across events should use the SAME spelling so resolution can dedup.
- Prefer names from the existing-entities catalog when applicable.
- episode_continues_previous reflects whether this event continues the active episode for the source; the active episode may close mid-batch if an earlier event in the batch already broke continuity.
- Set episode_summary only when episode_continues_previous=false AND there is an active episode for this source.
- evidence_signals is optional; emit only when the event clearly corroborates/refutes an existing memo.
- Be conservative: extract only entities clearly named in the event content.`;

const MAX_EVENT_CONTENT_CHARS = 2000;

function formatCatalog(catalog) {
  if (catalog.length === 0) return 'Existing entities catalog: (no existing entities yet)';
  const byType = {};
  for (const e of catalog) {
    if (!byType[e.type]) byType[e.type] = [];
    byType[e.type].push(e.name);
  }
  const sections = [];
  for (const [type, names] of Object.entries(byType)) {
    sections.push(`${type}: ${names.join(', ')}`);
  }
  return `Existing entities catalog:\n${sections.join('\n')}`;
}

function formatActiveEpisode(activeEpisode, source) {
  if (!activeEpisode) return `Active episode (source=${source}): (none)`;
  return `Active episode (source=${source}): ${activeEpisode.summary ?? '(no summary yet)'} [${activeEpisode.id}]`;
}

function truncateContent(content) {
  if (typeof content !== 'string') return '';
  if (content.length <= MAX_EVENT_CONTENT_CHARS) return content;
  return content.slice(0, MAX_EVENT_CONTENT_CHARS);
}

export function buildBiographerBatchPrompt({ events, catalog, activeEpisode }) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('buildBiographerBatchPrompt: events[] must be non-empty');
  }
  const source = events[0].source;
  const system = [
    { role: 'system', content: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { role: 'system', content: formatCatalog(catalog), cache_control: { type: 'ephemeral' } },
  ];
  const lines = events.map((e) => ({
    event_id: String(e.id),
    ts: typeof e.ts === 'string' ? e.ts : new Date(e.ts ?? Date.now()).toISOString(),
    source: e.source,
    content: truncateContent(e.content),
  }));
  const userContent = `${formatActiveEpisode(activeEpisode, source)}

Events:
${JSON.stringify(lines, null, 2)}

Output JSON only.`;
  const messages = [{ role: 'user', content: userContent }];
  return { system, messages };
}
```

- [ ] **Step 4: Run the test (expect pass)**

```bash
npm run test:unit -- --test-name-pattern 'buildBiographerBatchPrompt|truncates|activeEpisode appears in user|source line|catalog message groups'
```

Expected: 6 passing assertions.

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add system/cognition/biographer/batch-prompt.js system/tests/unit/biographer-batch-prompt.test.js
git commit -m "feat(c1): buildBiographerBatchPrompt with 2000-char content truncation"
```

---

## Phase 3 — Batched output validator

Covers spec §3 (per-event isolation, missing/malformed/extra `event_id` handling).

### Task 3.1: Failing tests for `validateBiographerBatchOutput`

**Files:** `system/tests/unit/biographer-batch-validate.test.js` (new)

- [ ] **Step 1: Write the failing tests**

Create `system/tests/unit/biographer-batch-validate.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBiographerBatchOutput } from '../../cognition/biographer/batch-output.js';

function validPerEvent(id) {
  return {
    event_id: id,
    entities: [{ name: 'Alice', type: 'person' }],
    edges: [],
    about: [],
    episode_continues_previous: false,
    episode_summary: null,
  };
}

test('well-formed batch with 3 entries → ok, 3 entries', () => {
  const r = validateBiographerBatchOutput(
    {
      events: [
        validPerEvent('events:a'),
        validPerEvent('events:b'),
        validPerEvent('events:c'),
      ],
    },
    ['events:a', 'events:b', 'events:c'],
  );
  assert.equal(r.ok, true);
  assert.equal(r.events.size, 3);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.malformed, []);
});

test('missing event_id in output → recorded as missing', () => {
  const r = validateBiographerBatchOutput(
    { events: [validPerEvent('events:a')] },
    ['events:a', 'events:b'],
  );
  assert.equal(r.ok, true);
  assert.equal(r.events.size, 1);
  assert.deepEqual(r.missing, ['events:b']);
});

test('malformed entry → recorded as malformed; valid ones still returned', () => {
  const bad = { event_id: 'events:b', entities: [{ name: 'X', type: 'unicorn' }], edges: [], about: [], episode_continues_previous: false };
  const r = validateBiographerBatchOutput(
    { events: [validPerEvent('events:a'), bad, validPerEvent('events:c')] },
    ['events:a', 'events:b', 'events:c'],
  );
  assert.equal(r.ok, true);
  assert.equal(r.events.size, 2);
  assert.ok(r.events.has('events:a'));
  assert.ok(r.events.has('events:c'));
  assert.equal(r.malformed.length, 1);
  assert.equal(r.malformed[0].event_id, 'events:b');
  assert.match(r.malformed[0].error, /type/);
});

test('non-array events → batch-level fail', () => {
  const r = validateBiographerBatchOutput({ events: 'oops' }, ['events:a']);
  assert.equal(r.ok, false);
  assert.match(r.error, /events.*array/i);
});

test('non-object outer → batch-level fail', () => {
  const r = validateBiographerBatchOutput(null, ['events:a']);
  assert.equal(r.ok, false);
});

test('extra event_id in output not in expected → ignored', () => {
  const r = validateBiographerBatchOutput(
    {
      events: [validPerEvent('events:a'), validPerEvent('events:rogue')],
    },
    ['events:a'],
  );
  assert.equal(r.ok, true);
  assert.equal(r.events.size, 1);
  assert.ok(r.events.has('events:a'));
  // Extras must NOT be in malformed (they're simply discarded).
  assert.deepEqual(r.malformed, []);
});

test('entry missing event_id → malformed with descriptive error', () => {
  const noId = { entities: [], edges: [], about: [], episode_continues_previous: false };
  const r = validateBiographerBatchOutput({ events: [noId] }, ['events:a']);
  assert.equal(r.ok, true);
  assert.equal(r.events.size, 0);
  // No event_id → can't pin malformed[].event_id. Use sentinel '<missing event_id>'.
  assert.equal(r.malformed.length, 1);
  assert.equal(r.malformed[0].event_id, '<missing event_id>');
});
```

- [ ] **Step 2: Run the test (expect module-not-found)**

```bash
npm run test:unit -- --test-name-pattern 'well-formed batch|missing event_id|malformed entry|non-array events|non-object outer|extra event_id|entry missing event_id'
```

Expected: failure with `Cannot find module '.../biographer/batch-output.js'`.

- [ ] **Step 3: Implement `batch-output.js`**

Create `system/cognition/biographer/batch-output.js`:

```js
// batch-output.js — validates the batched biographer LLM response.
//
// Wraps `validateBiographerOutput` per entry. Returns:
//   { ok: true, events: Map<event_id, validated_entry>, missing: [], malformed: [] }
// for any batch whose outer envelope (`events` is an array) is well-formed.
// A non-array `events` (or non-object outer) is a batch-level failure that
// the caller should treat as the §8 fallback path.

import { validateBiographerOutput } from './output.js';

export function validateBiographerBatchOutput(o, expectedIds) {
  if (!o || typeof o !== 'object') {
    return { ok: false, error: 'output must be an object' };
  }
  if (!Array.isArray(o.events)) {
    return { ok: false, error: 'output.events must be an array' };
  }
  const expected = new Set(expectedIds.map(String));
  const events = new Map();
  const malformed = [];
  for (const entry of o.events) {
    if (!entry || typeof entry !== 'object') {
      malformed.push({ event_id: '<missing event_id>', error: 'entry not an object' });
      continue;
    }
    const id = entry.event_id;
    if (typeof id !== 'string' || id.length === 0) {
      malformed.push({ event_id: '<missing event_id>', error: 'event_id must be non-empty string' });
      continue;
    }
    if (!expected.has(id)) {
      // Extra entries the LLM produced for ids we didn't ask about: silently drop.
      continue;
    }
    const v = validateBiographerOutput(entry);
    if (!v.ok) {
      malformed.push({ event_id: id, error: v.error });
      continue;
    }
    events.set(id, entry);
  }
  const seen = new Set(events.keys());
  for (const id of malformed) seen.add(id.event_id);
  const missing = expectedIds
    .map(String)
    .filter((id) => !seen.has(id));
  return { ok: true, events, missing, malformed };
}
```

- [ ] **Step 4: Run the test (expect pass)**

```bash
npm run test:unit -- --test-name-pattern 'well-formed batch|missing event_id|malformed entry|non-array events|non-object outer|extra event_id|entry missing event_id'
```

Expected: 7 passing assertions.

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add system/cognition/biographer/batch-output.js system/tests/unit/biographer-batch-validate.test.js
git commit -m "feat(c1): validateBiographerBatchOutput with per-entry isolation"
```

---

## Phase 4 — Accumulator

Covers spec §1 (three triggers, source-scoped buckets, in-flight sealing).

### Task 4.1: Failing tests for `createBatchAccumulator`

**Files:** `system/tests/unit/biographer-batch-accumulator.test.js` (new)

- [ ] **Step 1: Write the failing tests**

Create `system/tests/unit/biographer-batch-accumulator.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBatchAccumulator } from '../../cognition/biographer/accumulator.js';

function makeConfig(overrides = {}) {
  return () => ({ max_batch_size: 8, debounce_ms: 50, max_wait_ms: 300, disable: false, ...overrides });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('count threshold fires at N events', async () => {
  const fires = [];
  const acc = createBatchAccumulator({
    config: makeConfig({ max_batch_size: 3 }),
    fire: async (eventIds, source) => {
      fires.push({ eventIds: [...eventIds], source });
    },
  });
  acc.add('e1', 'cli');
  acc.add('e2', 'cli');
  acc.add('e3', 'cli');
  await sleep(10);
  assert.equal(fires.length, 1);
  assert.deepEqual(fires[0].eventIds, ['e1', 'e2', 'e3']);
  assert.equal(fires[0].source, 'cli');
});

test('debounce fires after silence', async () => {
  const fires = [];
  const acc = createBatchAccumulator({
    config: makeConfig({ debounce_ms: 30, max_wait_ms: 1000 }),
    fire: async (ids, source) => fires.push({ ids: [...ids], source }),
  });
  acc.add('e1', 'cli');
  await sleep(60);
  assert.equal(fires.length, 1);
  assert.deepEqual(fires[0].ids, ['e1']);
});

test('hard cap fires even under sustained input', async () => {
  const fires = [];
  const acc = createBatchAccumulator({
    config: makeConfig({ debounce_ms: 25, max_wait_ms: 100, max_batch_size: 100 }),
    fire: async (ids, source) => fires.push({ ids: [...ids], source }),
  });
  // Trickle in events every 10 ms so the debounce never expires.
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < 150) {
    acc.add(`e${i++}`, 'cli');
    await sleep(10);
  }
  // After ~150 ms, the hard cap (100 ms) must have fired at least once.
  assert.ok(fires.length >= 1, `expected ≥1 fire, got ${fires.length}`);
});

test('source separation: cli and discord events produce two fires', async () => {
  const fires = [];
  const acc = createBatchAccumulator({
    config: makeConfig({ debounce_ms: 30 }),
    fire: async (ids, source) => fires.push({ ids: [...ids], source }),
  });
  acc.add('a', 'cli');
  acc.add('b', 'discord');
  acc.add('c', 'cli');
  acc.add('d', 'discord');
  await sleep(80);
  assert.equal(fires.length, 2);
  const cli = fires.find((f) => f.source === 'cli');
  const disc = fires.find((f) => f.source === 'discord');
  assert.deepEqual(cli.ids, ['a', 'c']);
  assert.deepEqual(disc.ids, ['b', 'd']);
});

test('in-flight bucket does not accept new events; a new bucket opens', async () => {
  const fires = [];
  let resolveFirst;
  const acc = createBatchAccumulator({
    config: makeConfig({ debounce_ms: 20, max_wait_ms: 200 }),
    fire: async (ids, source) => {
      fires.push({ ids: [...ids], source });
      if (fires.length === 1) {
        await new Promise((r) => {
          resolveFirst = r;
        });
      }
    },
  });
  acc.add('a', 'cli');
  await sleep(40);
  // First bucket is in-flight (fire awaiting resolveFirst). Adds open a new bucket.
  acc.add('b', 'cli');
  acc.add('c', 'cli');
  await sleep(50);
  // Second bucket should have queued but not fired yet (queue waits for first).
  assert.equal(fires.length, 1);
  resolveFirst();
  await sleep(50);
  assert.equal(fires.length, 2);
  assert.deepEqual(fires[1].ids, ['b', 'c']);
});

test('reads config callback on every flush (operator-tunable at runtime)', async () => {
  const fires = [];
  let cap = 2;
  const acc = createBatchAccumulator({
    config: () => ({ max_batch_size: cap, debounce_ms: 200, max_wait_ms: 500, disable: false }),
    fire: async (ids) => fires.push([...ids]),
  });
  acc.add('a', 'cli');
  acc.add('b', 'cli');
  await sleep(10);
  assert.equal(fires.length, 1);
  cap = 4;
  acc.add('c', 'cli');
  acc.add('d', 'cli');
  acc.add('e', 'cli');
  await sleep(10);
  // Cap is now 4; not yet hit.
  assert.equal(fires.length, 1);
  acc.add('f', 'cli');
  await sleep(10);
  assert.equal(fires.length, 2);
  assert.deepEqual(fires[1], ['c', 'd', 'e', 'f']);
});

test('disable: true short-circuits buckets — each add fires a single-id batch immediately', async () => {
  const fires = [];
  const acc = createBatchAccumulator({
    config: () => ({ max_batch_size: 8, debounce_ms: 200, max_wait_ms: 500, disable: true }),
    fire: async (ids, source) => fires.push({ ids: [...ids], source }),
  });
  acc.add('a', 'cli');
  acc.add('b', 'cli');
  acc.add('c', 'cli');
  await sleep(10);
  // No bucket batching; each event fires on its own.
  assert.equal(fires.length, 3);
  assert.deepEqual(fires.map((f) => f.ids), [['a'], ['b'], ['c']]);
});
```

- [ ] **Step 2: Run the test (expect module-not-found)**

```bash
npm run test:unit -- --test-name-pattern 'count threshold fires|debounce fires|hard cap fires|source separation|in-flight bucket|reads config callback|disable: true short-circuits'
```

Expected: failure with `Cannot find module '.../biographer/accumulator.js'`.

- [ ] **Step 3: Implement `accumulator.js`**

Create `system/cognition/biographer/accumulator.js`:

```js
// accumulator.js — windowed source-bucketed batch accumulator.
//
// Sits between queueWrap.enqueue and the biographer worker. Three triggers:
//   - count: max_batch_size hit → fire immediately
//   - debounce: debounce_ms of silence on this bucket → fire
//   - hard cap: max_wait_ms since first event in this bucket → fire even under
//     sustained input
//
// Per-source buckets so CLI / Discord / ingest don't mix in one LLM call.
// When a bucket is fired the accumulator opens a fresh bucket for that source
// while the in-flight one awaits its fire() handler. The underlying queue is
// expected to serialise fired batches globally (see §1, §7 in the spec).

export function createBatchAccumulator({ config, fire }) {
  if (typeof config !== 'function') throw new Error('createBatchAccumulator: config must be a function');
  if (typeof fire !== 'function') throw new Error('createBatchAccumulator: fire must be a function');

  // source -> { ids: string[], firstEnqueuedAt: number, debounceTimer, capTimer }
  const buckets = new Map();

  function clearTimers(b) {
    if (b.debounceTimer) clearTimeout(b.debounceTimer);
    if (b.capTimer) clearTimeout(b.capTimer);
    b.debounceTimer = null;
    b.capTimer = null;
  }

  function flush(source) {
    const b = buckets.get(source);
    if (!b || b.ids.length === 0) return;
    clearTimers(b);
    const ids = b.ids;
    // Open a fresh bucket immediately — new adds for this source while the
    // fired batch is in-flight go into the new bucket.
    buckets.delete(source);
    // fire returns a promise; we don't await — the queue serialises.
    Promise.resolve()
      .then(() => fire(ids, source))
      .catch((e) => {
        // Surface but don't crash the accumulator.
        console.warn(`[biographer accumulator] fire failed for source=${source}: ${e.message}`);
      });
  }

  function add(eventId, source) {
    if (!eventId) throw new Error('accumulator.add: eventId required');
    if (!source) throw new Error('accumulator.add: source required');
    const cfg = config();
    const maxBatch = cfg.max_batch_size ?? 8;
    const debounceMs = cfg.debounce_ms ?? 750;
    const maxWaitMs = cfg.max_wait_ms ?? 3000;

    // Disable bypass (spec §9): short-circuit the bucket/timer entirely so
    // events flow straight to fire() one at a time. Used as the operator
    // rollback lever — restores pre-C1 behaviour byte-for-byte.
    if (cfg.disable === true) {
      Promise.resolve()
        .then(() => fire([String(eventId)], source))
        .catch((e) => {
          console.warn(`[biographer accumulator] fire (disabled mode) failed: ${e.message}`);
        });
      return;
    }

    let b = buckets.get(source);
    if (!b) {
      b = { ids: [], firstEnqueuedAt: Date.now(), debounceTimer: null, capTimer: null };
      buckets.set(source, b);
      b.capTimer = setTimeout(() => flush(source), maxWaitMs);
    }
    b.ids.push(String(eventId));
    if (b.debounceTimer) clearTimeout(b.debounceTimer);
    b.debounceTimer = setTimeout(() => flush(source), debounceMs);
    if (b.ids.length >= maxBatch) {
      flush(source);
    }
  }

  return { add };
}
```

- [ ] **Step 4: Run the test (expect pass)**

```bash
npm run test:unit -- --test-name-pattern 'count threshold fires|debounce fires|hard cap fires|source separation|in-flight bucket|reads config callback|disable: true short-circuits'
```

Expected: 7 passing assertions.

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add system/cognition/biographer/accumulator.js system/tests/unit/biographer-batch-accumulator.test.js
git commit -m "feat(c1): createBatchAccumulator (count/debounce/cap, source-scoped buckets, disable bypass)"
```

---

## Phase 5 — Queue dedupe key extension

Covers spec §9 (additive `__queueKey` on payload object).

### Task 5.1: Extend queue dedupe to honour `payload.__queueKey`

**Files:** `system/cognition/biographer/queue.js`, `system/tests/unit/biographer-queue.test.js`

- [ ] **Step 1: Add a failing test in the existing file**

Open `system/tests/unit/biographer-queue.test.js` and append:

```js
test('payload object with __queueKey dedupes by that key', async () => {
  let calls = 0;
  const worker = async () => {
    calls++;
    return { processed: 1 };
  };
  const q = createBiographerQueue({ worker, dedupe: true });
  const p1 = { kind: 'batch', source: 'cli', eventIds: ['e1', 'e2'], __queueKey: 'cli:e1,e2' };
  const p2 = { kind: 'batch', source: 'cli', eventIds: ['e1', 'e2'], __queueKey: 'cli:e1,e2' };
  const r1 = q.enqueue(p1);
  const r2 = q.enqueue(p2);
  await Promise.all([r1, r2]);
  assert.equal(calls, 1, 'identical __queueKey should coalesce');
});

test('payload objects with different __queueKey run independently', async () => {
  let calls = 0;
  const worker = async () => {
    calls++;
    return { processed: 1 };
  };
  const q = createBiographerQueue({ worker, dedupe: true });
  const a = { kind: 'batch', source: 'cli', eventIds: ['e1'], __queueKey: 'cli:e1' };
  const b = { kind: 'batch', source: 'discord', eventIds: ['e1'], __queueKey: 'discord:e1' };
  await Promise.all([q.enqueue(a), q.enqueue(b)]);
  assert.equal(calls, 2);
});
```

- [ ] **Step 2: Run the new tests (expect fail)**

```bash
npm run test:unit -- --test-name-pattern 'payload object with __queueKey|payload objects with different __queueKey'
```

Expected: failure (dedupe map keys on the object reference today, so two separate object literals never dedupe).

- [ ] **Step 3: Apply additive edits to `system/cognition/biographer/queue.js`**

**This step is intentionally ADDITIVE, not a wholesale replacement.** The
runtime-layer-hardening plan (R-1, see
`docs/superpowers/plans/2026-05-11-runtime-layer-hardening.md`) adds
`maxPending` canary + `skippedSinceBoot` accessors to the same file
on a parallel branch. Read the current file first; if R-1 has already
landed, preserve those accessors and overlay the per-source dedupe-key
change on top. If R-1 has not yet landed, the same additive edits still
apply (no R-1 fields exist to preserve).

Read the file:

```bash
sed -n '1,80p' system/cognition/biographer/queue.js
```

Then apply the two Edit-tool patches below. They modify only the
dedupe-key derivation and leave queue concurrency / maxPending /
`skippedSinceBoot` (if present from R-1) untouched.

**Edit 1 — introduce `dedupeKey` helper above `createBiographerQueue`.**

Find the line just before `export function createBiographerQueue(` and
insert the helper. Use the Edit tool with:

```js
// old_string (anchor before the existing export):
export function createBiographerQueue({
```

```js
// new_string:
function dedupeKey(payload) {
  if (payload && typeof payload === 'object' && typeof payload.__queueKey === 'string') {
    return payload.__queueKey;
  }
  return payload;
}

export function createBiographerQueue({
```

**Edit 2 — route the dedupe map through `dedupeKey(payload)`.**

The existing single-id key derivation looks like
`const key = dedupe ? String(payload) : undefined;` (or similar — adapt
to whatever the current code shows). Replace it with the helper call:

```js
// old_string (exact current text, e.g.):
    const key = dedupe ? String(payload) : undefined;
```

```js
// new_string:
    const key = dedupe ? dedupeKey(payload) : undefined;
```

If R-1's `maxPending` canary adds an early-return inflate path **before**
the key derivation, leave the canary code intact — the `dedupeKey`
helper just changes the *value* placed into the inflight map.

If the existing code computes the key inline at multiple call sites
(very unlikely on `queue.js` today), repeat Edit 2 at each site or
hoist the derivation into a single `const key = ...` near the top of
`enqueue`.

- [ ] **Step 4: Run full unit tests (expect all biographer-queue tests pass)**

```bash
npm run test:unit -- --test-name-pattern 'queue processes events sequentially|concurrent enqueue of same id|worker errors propagate|payload object with __queueKey|payload objects with different __queueKey'
```

Expected: 5 passing assertions (3 original + 2 new).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add system/cognition/biographer/queue.js system/tests/unit/biographer-queue.test.js
git commit -m "feat(c1): queue dedupe honours payload.__queueKey for batch payloads"
```

---

## Phase 6 — `biographerProcessBatch` core (no LLM batching yet)

Covers spec rollout PR 2: a `biographerProcessBatch` that initially loops single-event internally so we can validate equivalence + wiring. Spec §9 (wrapper shape).

### Task 6.1: Add a loop-equivalent `biographerProcessBatch`

**Files:** `system/cognition/biographer/pipeline.js`, `system/tests/integration/biographer-batch-pipeline.test.js`

- [ ] **Step 1: Write the equivalence-with-N=1 failing test**

Create `system/tests/integration/biographer-batch-pipeline.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import {
  biographerProcess,
  biographerProcessBatch,
} from '../../cognition/biographer/pipeline.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

function fakeHost(scriptedResponses) {
  let i = 0;
  return {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => ({
      content: scriptedResponses[i++ % scriptedResponses.length],
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
  };
}

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('biographerProcessBatch with [evt.id] matches single-event end-to-end behaviour', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const evt = await recordEvent(db, e, {
    source: 'cli',
    content: 'Alice met Bob about project Atlas.',
  });
  const host = fakeHost([
    JSON.stringify({
      entities: [
        { name: 'Alice', type: 'person' },
        { name: 'Bob', type: 'person' },
        { name: 'Atlas', type: 'project' },
      ],
      edges: [
        { from: 'Alice', type: 'works_on', to: 'Atlas' },
        { from: 'Bob', type: 'works_on', to: 'Atlas' },
      ],
      about: ['Atlas'],
      episode_continues_previous: false,
      episode_summary: null,
    }),
  ]);
  await biographerProcessBatch(db, e, host, [evt.id]);

  const [evRows] = await db.query(surql`SELECT * FROM ${evt.id}`).collect();
  assert.ok(evRows[0].biographed_at);
  assert.ok(evRows[0].episode_id);

  const [entRows] = await db.query('SELECT count() AS n FROM entities GROUP ALL').collect();
  assert.equal(entRows[0].n, 3);

  const [mentRows] = await db
    .query("SELECT count() AS n FROM edges WHERE kind = 'mentions' GROUP ALL")
    .collect();
  assert.equal(mentRows[0].n, 3);

  const [aboutRows] = await db
    .query("SELECT count() AS n FROM edges WHERE kind = 'about' GROUP ALL")
    .collect();
  assert.equal(aboutRows[0].n, 1);

  const [worksRows] = await db
    .query("SELECT count() AS n FROM edges WHERE kind = 'works_on' GROUP ALL")
    .collect();
  assert.equal(worksRows[0].n, 2);

  await close(db);
});

test('biographerProcess is now a wrapper that delegates to biographerProcessBatch', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const evt = await recordEvent(db, e, { source: 'cli', content: 'Just Alice.' });
  const host = fakeHost([
    JSON.stringify({
      entities: [{ name: 'Alice', type: 'person' }],
      edges: [],
      about: [],
      episode_continues_previous: false,
      episode_summary: null,
    }),
  ]);
  const r = await biographerProcess(db, e, host, evt.id);
  assert.equal(r.processed, true);
  assert.ok(r.episodeId);
  assert.equal(r.entitiesCount, 1);
  await close(db);
});
```

- [ ] **Step 2: Run the test (expect fail — `biographerProcessBatch` not exported)**

```bash
npm run test:integration -- --test-name-pattern 'biographerProcessBatch with \[evt.id\]|biographerProcess is now a wrapper'
```

Expected: failure with `does not provide an export named 'biographerProcessBatch'`.

- [ ] **Step 3: Extract `biographerProcess` body into `_processOne` and add a looping `biographerProcessBatch`**

Edit `system/cognition/biographer/pipeline.js`:

1. Above the existing exported `biographerProcess` (line 90), introduce a private `_processOne` containing the current body (lines 91–278). Keep all imports unchanged.
2. Replace exported `biographerProcess` with a wrapper that forwards to `biographerProcessBatch`.
3. Add a new exported `biographerProcessBatch` that loops `_processOne` over each id, gathering per-event results into a Map.

**Explicit `_processOne` signature**: `async function _processOne(db, embedder, host, eventId, opts)`. The body is the current `biographerProcess` body **verbatim**, lines 90–278 of `system/cognition/biographer/pipeline.js`. Only the function name (declaration line) changes; nothing else inside.

**Verification step**: after the rename, diff the new `_processOne` body against the original to confirm it is byte-identical except for the function-name line:

```bash
# Compare the new _processOne body against the original biographerProcess.
git show HEAD:system/cognition/biographer/pipeline.js | sed -n '90,278p' > /tmp/c1-original-body.txt
# Strip the declaration line from both versions and diff (declaration line is
# "export async function biographerProcess(..." in the original and
# "async function _processOne(..." in the new). Lines 2..end must match.
sed -n '91,278p' /tmp/c1-original-body.txt > /tmp/c1-original-rest.txt
sed -n '91,278p' system/cognition/biographer/pipeline.js > /tmp/c1-new-rest.txt
diff /tmp/c1-original-rest.txt /tmp/c1-new-rest.txt
```

Expected: empty diff (only the declaration line at L90 differs).

The final shape of the new exports (the loop-only stage; Phase 7 swaps in a real batched LLM call):

```js
async function _processOne(db, embedder, host, eventId, opts = {}) {
  // Body copied verbatim from the previous `biographerProcess` body
  // (lines 90–278 of system/cognition/biographer/pipeline.js, original).
  // Only the function declaration changed.
  // ... full body here ...
}

export async function biographerProcess(db, embedder, host, eventId, opts = {}) {
  const r = await biographerProcessBatch(db, embedder, host, [eventId], opts);
  return r.perEvent.get(String(eventId)) ?? { skipped: true, reason: 'unknown' };
}

export async function biographerProcessBatch(db, embedder, host, eventIds, opts = {}) {
  const perEvent = new Map();
  for (const eventId of eventIds) {
    try {
      const r = await _processOne(db, embedder, host, eventId, opts);
      perEvent.set(String(eventId), r);
    } catch (e) {
      perEvent.set(String(eventId), { failed: true, error: e.message });
      throw e;
    }
  }
  return { perEvent };
}
```

- [ ] **Step 4: Run the new test + the legacy tests (expect all pass)**

Run by explicit file path — `--test-name-pattern 'biographer'` can miss tests whose names don't contain the literal word "biographer":

```bash
node --test \
  system/tests/integration/biographer-pipeline.test.js \
  system/tests/integration/biographer-failure.test.js \
  system/tests/integration/biographer-dedupe.test.js \
  system/tests/integration/biographer-batch-pipeline.test.js
```

Expected: existing `biographer-pipeline`, `biographer-failure`, `biographer-dedupe` tests pass unchanged plus the two new equivalence tests in `biographer-batch-pipeline.test.js`. Also rerun the daemon-touching integration suites (`biographer-catchup`, `biographer-process-pending-captures`) if they exist in your tree.

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add system/cognition/biographer/pipeline.js system/tests/integration/biographer-batch-pipeline.test.js
git commit -m "feat(c1): biographerProcessBatch (loop-only); biographerProcess becomes wrapper"
```

---

## Phase 7 — Real batched LLM call inside `biographerProcessBatch`

This is the keystone refactor. Covers spec §2 (prompt), §3 (per-event isolation), §5 (entity cascade dedup), §4 (episode loop), §6 (edges + within-batch `before`), §7 (idempotent mark), §8 (fallback).

### Task 7.1: Add `DEFAULT_BATCH_CONFIG` + `readBatchConfig`

**Files:** `system/cognition/biographer/pipeline.js`

- [ ] **Step 1: Write a unit test for `readBatchConfig`**

Append to `system/tests/integration/biographer-batch-pipeline.test.js`:

```js
test('readBatchConfig returns DEFAULT_BATCH_CONFIG on an empty runtime row', async () => {
  const { readBatchConfig, DEFAULT_BATCH_CONFIG } = await import('../../cognition/biographer/pipeline.js');
  const db = await fresh();
  const cfg = await readBatchConfig(db);
  assert.deepEqual(cfg, DEFAULT_BATCH_CONFIG);
  await close(db);
});

test('readBatchConfig merges stored values over defaults', async () => {
  const { readBatchConfig } = await import('../../cognition/biographer/pipeline.js');
  const db = await fresh();
  await db
    .query(surql`UPSERT type::record('runtime', 'biographer') SET value.batch_config = ${{ max_batch_size: 16 }}`)
    .collect();
  const cfg = await readBatchConfig(db);
  assert.equal(cfg.max_batch_size, 16);
  assert.equal(cfg.debounce_ms, 750);
  assert.equal(cfg.max_wait_ms, 3000);
  await close(db);
});
```

- [ ] **Step 2: Run the new tests (expect fail — not yet exported)**

```bash
npm run test:integration -- --test-name-pattern 'readBatchConfig returns DEFAULT|readBatchConfig merges'
```

- [ ] **Step 3: Add exports to `pipeline.js`**

In `system/cognition/biographer/pipeline.js`, after the existing `DEFAULT_CONFIG` block, add:

```js
export const DEFAULT_BATCH_CONFIG = {
  max_batch_size: 8,
  debounce_ms: 750,
  max_wait_ms: 3000,
};

let _batchConfigCache = null;
let _batchConfigCachedAt = 0;
const BATCH_CONFIG_TTL_MS = 5000;

export async function readBatchConfig(db) {
  const now = Date.now();
  if (_batchConfigCache && now - _batchConfigCachedAt < BATCH_CONFIG_TTL_MS) {
    return _batchConfigCache;
  }
  const runtime = await loadRuntime(db);
  const stored = runtime?.batch_config ?? {};
  const cfg = { ...DEFAULT_BATCH_CONFIG, ...stored };
  _batchConfigCache = cfg;
  _batchConfigCachedAt = now;
  return cfg;
}
```

Also extend `ensureRuntime` to merge `batch_config` defaults on first call (additive, never overwriting). Replace the existing function with:

```js
async function ensureRuntime(db) {
  const existing = await loadRuntime(db);
  if (existing?.config && existing?.batch_config) return existing;
  const initial = existing ?? { config: DEFAULT_CONFIG, entity_catalog_version: 0 };
  if (!initial.config) initial.config = DEFAULT_CONFIG;
  if (!initial.batch_config) initial.batch_config = DEFAULT_BATCH_CONFIG;
  await withTxRetry(async () => {
    const current = await loadRuntime(db);
    if (current?.config && current?.batch_config) return;
    const merged = {
      ...(current ?? {}),
      config: current?.config ?? DEFAULT_CONFIG,
      batch_config: current?.batch_config ?? DEFAULT_BATCH_CONFIG,
      entity_catalog_version: current?.entity_catalog_version ?? 0,
    };
    await db
      .query(surql`UPSERT type::record('runtime', 'biographer') SET value = ${merged}`)
      .collect();
  });
  return (await loadRuntime(db)) ?? initial;
}
```

- [ ] **Step 4: Run the tests + lint**

```bash
npm run test:integration -- --test-name-pattern 'readBatchConfig|ensureRuntime|biographer processes a single event'
npm run lint
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add system/cognition/biographer/pipeline.js system/tests/integration/biographer-batch-pipeline.test.js
git commit -m "feat(c1): DEFAULT_BATCH_CONFIG + readBatchConfig + ensureRuntime merge"
```

### Task 7.2: Cross-event entity-cascade dedup test (failing first)

**Files:** `system/tests/integration/biographer-batch-pipeline.test.js`

- [ ] **Step 1: Write the failing test**

Append:

```js
test('cross-event entity dedup: 3 events × "Atlas" → 1 entity row + 1 upsertEntity call', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const evt1 = await recordEvent(db, e, { source: 'cli', content: 'Atlas planning' });
  const evt2 = await recordEvent(db, e, { source: 'cli', content: 'Atlas update' });
  const evt3 = await recordEvent(db, e, { source: 'cli', content: 'Atlas review' });
  // Single LLM response carries all three events in one batch.
  const host = fakeHost([
    JSON.stringify({
      events: [
        {
          event_id: String(evt1.id),
          entities: [{ name: 'Atlas', type: 'project' }],
          edges: [],
          about: ['Atlas'],
          episode_continues_previous: false,
          episode_summary: null,
        },
        {
          event_id: String(evt2.id),
          entities: [{ name: 'Atlas', type: 'project' }],
          edges: [],
          about: ['Atlas'],
          episode_continues_previous: true,
          episode_summary: null,
        },
        {
          event_id: String(evt3.id),
          entities: [{ name: 'Atlas', type: 'project' }],
          edges: [],
          about: ['Atlas'],
          episode_continues_previous: true,
          episode_summary: null,
        },
      ],
    }),
  ]);
  await biographerProcessBatch(db, e, host, [evt1.id, evt2.id, evt3.id]);

  const [entRows] = await db.query('SELECT count() AS n FROM entities GROUP ALL').collect();
  assert.equal(entRows[0].n, 1, 'expected 1 Atlas entity');

  const [mentRows] = await db
    .query("SELECT count() AS n FROM edges WHERE kind = 'mentions' GROUP ALL")
    .collect();
  assert.equal(mentRows[0].n, 3, 'expected 3 mentions edges (one per event)');

  const [aboutRows] = await db
    .query("SELECT count() AS n FROM edges WHERE kind = 'about' GROUP ALL")
    .collect();
  assert.equal(aboutRows[0].n, 3);
  await close(db);
});
```

- [ ] **Step 2: Run the test (expect fail — current batch impl loops one-by-one and the scripted response is a batch envelope, not three single-event envelopes)**

```bash
npm run test:integration -- --test-name-pattern 'cross-event entity dedup'
```

- [ ] **Step 3: Rewrite `biographerProcessBatch` to issue one batched LLM call**

In `system/cognition/biographer/pipeline.js`, replace the loop-only `biographerProcessBatch` with the real batched implementation. Import the new modules at the top of the file:

```js
import { buildBiographerBatchPrompt } from './batch-prompt.js';
import { validateBiographerBatchOutput } from './batch-output.js';
```

Replace `biographerProcessBatch` with:

```js
export async function biographerProcessBatch(db, embedder, host, eventIds, opts = {}) {
  const perEvent = new Map();
  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    return { perEvent };
  }

  // 1. Single-event fast path stays as-is — short-circuits to _processOne for
  //    behaviour-identical N=1 calls (MCP-tool callers, biographer-catchup CLI).
  //    Batch overhead saves nothing at N=1 and would change observable counter
  //    semantics (per-event recordFailure shapes).
  if (eventIds.length === 1) {
    try {
      const r = await _processOne(db, embedder, host, eventIds[0], opts);
      perEvent.set(String(eventIds[0]), r);
    } catch (e) {
      perEvent.set(String(eventIds[0]), { failed: true, error: e.message });
      throw e;
    }
    return { perEvent };
  }

  const retryBaseDelayMs = opts.retryBaseDelayMs ?? 1000;
  const runtime = await ensureRuntime(db);
  const config = runtime.config ?? DEFAULT_CONFIG;

  // 2. Load events; filter out already-biographed.
  //    The IN-clause SELECT is the fast path. We catch the SurrealQL error
  //    rather than inferring failure from an empty result set — `length === 0`
  //    could legitimately mean "all events are biographed and were filtered
  //    out at the SELECT level" depending on the WHERE clause, which would
  //    spuriously trigger the per-id cold path. `.catch(...)` is the only
  //    accurate failure signal.
  const idList = eventIds.map(String);
  let events;
  try {
    const [eventRows] = await db
      .query(
        surql`SELECT * FROM events WHERE id IN ${idList.map((id) => ({ tb: 'events', id: id.split(':')[1] ?? id }))}`,
      )
      .collect();
    events = Array.isArray(eventRows) ? eventRows : [];
  } catch {
    // Defensive: if the IN-clause shape above is unsupported by this SurrealDB
    // build, fall back to one SELECT per id (still one round-trip per id,
    // but only on the cold path).
    events = [];
    for (const id of idList) {
      const [rows] = await db
        .query(surql`SELECT * FROM type::thing('events', ${id.split(':')[1] ?? id})`)
        .collect();
      if (rows.length > 0) events.push(rows[0]);
    }
  }
  const toProcess = events
    .filter((ev) => !ev.biographed_at)
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  for (const ev of events) {
    if (ev.biographed_at) perEvent.set(String(ev.id), { skipped: true, reason: 'already_biographed' });
  }
  if (toProcess.length === 0) return { perEvent };

  // 3. Build prompt; the active episode + catalog are read once per batch.
  const source = toProcess[0].source;
  const catalog = await getCatalog(db, config.catalog_size);
  const activeEpisode = await findActiveEpisode(db, source);
  const { system, messages } = buildBiographerBatchPrompt({
    events: toProcess,
    catalog,
    activeEpisode,
  });

  // 4. Invoke LLM (one call for the whole batch). On retries-exhausted /
  //    parse failure / batch-validation failure, fall back to per-event
  //    single-call processing (§8).
  let response;
  let fallbackReason = null;
  try {
    response = await invokeWithRetry(
      host,
      messages,
      { tier: 'fast', json: true, system },
      3,
      retryBaseDelayMs,
    );
  } catch (e) {
    fallbackReason = 'network';
    await _recordBatchFallback(db, fallbackReason);
    return _fallbackPerEvent(db, embedder, host, toProcess.map((e) => e.id), perEvent, opts, e);
  }
  let parsed;
  try {
    parsed = JSON.parse(response.content);
  } catch (e) {
    fallbackReason = 'outer_json';
    await _recordBatchFallback(db, fallbackReason);
    return _fallbackPerEvent(db, embedder, host, toProcess.map((e) => e.id), perEvent, opts, e);
  }
  const expectedIds = toProcess.map((ev) => String(ev.id));
  const validation = validateBiographerBatchOutput(parsed, expectedIds);
  if (!validation.ok) {
    fallbackReason = 'batch_validation';
    await _recordBatchFallback(db, fallbackReason);
    return _fallbackPerEvent(db, embedder, host, expectedIds, perEvent, opts, new Error(validation.error));
  }

  // 5. Per-entry failure handling — record missing/malformed via recordFailure
  //    with kind-prefixed messages so `value.last_error` retains the cause
  //    (recordFailure writes error.message verbatim to value.last_error;
  //    without a prefix, missing vs malformed are indistinguishable from
  //    network/JSON errors written by the single-event path). Do NOT include
  //    these events in the valid subset below.
  for (const id of validation.missing) {
    const msg = `missing_in_batch_output: ${id}`;
    await recordFailure(db, id, new Error(msg));
    perEvent.set(id, { failed: true, error: msg });
  }
  for (const { event_id, error } of validation.malformed) {
    if (event_id !== '<missing event_id>') {
      const msg = `batch_malformed: ${error}`;
      await recordFailure(db, event_id, new Error(msg));
      perEvent.set(event_id, { failed: true, error: msg });
    }
  }

  const validEvents = toProcess.filter((ev) => validation.events.has(String(ev.id)));
  if (validEvents.length === 0) {
    await _recordBatchTelemetry(db, { batches_total_delta: 1 });
    return { perEvent };
  }

  // 6. Entity cascade dedup across the whole batch (spec §5).
  //    Collect unique (type, name_lower) keys; resolve once each via
  //    store.upsertEntity (which runs the existing 3-stage cascade).
  const desiredEntities = new Map(); // key -> { name, type }
  for (const ev of validEvents) {
    const perOut = validation.events.get(String(ev.id));
    for (const ent of perOut.entities) {
      const key = `${ent.type}__${ent.name.toLowerCase()}`;
      if (!desiredEntities.has(key)) desiredEntities.set(key, { name: ent.name, type: ent.type });
    }
  }
  const keyToId = new Map();
  for (const [key, { name, type }] of desiredEntities) {
    const r = await withTxRetry(() =>
      store.upsertEntity(db, embedder, { name, type, host, config }),
    );
    keyToId.set(key, r.id);
  }

  // 7. Episode determination across the batch (spec §4).
  //    Walk events in ts-ascending order; carry currentEpisodeId; close+open
  //    in-loop without re-querying the DB.
  let currentEpisodeId = activeEpisode?.id ?? null;
  let lastEpisodeStart = activeEpisode?.started_at ? new Date(activeEpisode.started_at) : null;
  const episodeIdForEvent = new Map();
  for (const ev of validEvents) {
    const perOut = validation.events.get(String(ev.id));
    const eventTs = ev.ts ? new Date(ev.ts) : new Date();
    const llmSaysContinues = perOut.episode_continues_previous === true;
    const withinWindow =
      currentEpisodeId && lastEpisodeStart
        ? (eventTs.getTime() - lastEpisodeStart.getTime()) / 60000 <= config.episode_window_minutes
        : false;
    if (currentEpisodeId && llmSaysContinues && withinWindow) {
      episodeIdForEvent.set(String(ev.id), currentEpisodeId);
    } else {
      if (currentEpisodeId) {
        await closeEpisode(db, currentEpisodeId, {
          endedAt: eventTs,
          summary: perOut.episode_summary ?? undefined,
        });
      }
      const newEp = await createEpisode(db, { source: ev.source });
      currentEpisodeId = newEp.id;
      lastEpisodeStart = eventTs;
      episodeIdForEvent.set(String(ev.id), currentEpisodeId);
    }
  }

  // 8. Edge collection (spec §6). Per-event scope for mentions/about/edges
  //    /occurs_with; within-batch `before` chained inside each episode group.
  const edgeRows = [];
  const evidenceJobs = [];
  for (const ev of validEvents) {
    const perOut = validation.events.get(String(ev.id));
    const contextSnippet = (ev.content ?? '').slice(0, 200);
    const nameToId = new Map();
    for (const ent of perOut.entities) {
      const key = `${ent.type}__${ent.name.toLowerCase()}`;
      const id = keyToId.get(key);
      if (id) nameToId.set(ent.name, id);
    }
    for (const ent of perOut.entities) {
      const eid = nameToId.get(ent.name);
      if (eid) edgeRows.push({ from: ev.id, to: eid, kind: 'mentions', context: contextSnippet });
    }
    for (const aboutName of perOut.about) {
      const eid = nameToId.get(aboutName);
      if (eid) edgeRows.push({ from: ev.id, to: eid, kind: 'about' });
    }
    for (const edge of perOut.edges) {
      const kind = normalizeEdgeKind(edge.type);
      if (!kind) continue;
      const fromId = nameToId.get(edge.from);
      const toId = nameToId.get(edge.to);
      if (!fromId || !toId) continue;
      if (ENTITY_EDGE_KINDS.has(kind)) {
        edgeRows.push({ from: fromId, to: toId, kind });
      }
    }
    const entityIds = Array.from(nameToId.values()).slice(0, config.cooccur_cap);
    for (let i = 0; i < entityIds.length; i++) {
      for (let j = i + 1; j < entityIds.length; j++) {
        edgeRows.push({ from: entityIds[i], to: entityIds[j], kind: 'occurs_with' });
      }
    }
    if (Array.isArray(perOut.evidence_signals) && perOut.evidence_signals.length > 0) {
      evidenceJobs.push({ ev, signals: perOut.evidence_signals });
    }
  }

  // within-batch `before` edges: group by episodeIdForEvent, chain in ts asc.
  const byEpisode = new Map();
  for (const ev of validEvents) {
    const epId = String(episodeIdForEvent.get(String(ev.id)));
    if (!byEpisode.has(epId)) byEpisode.set(epId, []);
    byEpisode.get(epId).push(ev);
  }
  for (const group of byEpisode.values()) {
    group.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    for (let i = 0; i < group.length - 1; i++) {
      edgeRows.push({ from: group[i].id, to: group[i + 1].id, kind: 'before' });
    }
  }

  // 9. Write edges (one batched relateAll call; chunks at 50 internally).
  if (edgeRows.length > 0) {
    await withTxRetry(() => store.relateAll(db, edgeRows));
  }

  // 10. (Evidence signals run AFTER the mark — see step 12 below. Putting
  //     them before the mark would double-count the ledger on retry.)

  // 11. Per-episode-group gated mark step (spec §3, §7 invariant).
  //     For each distinct episode in the batch, one UPDATE with
  //     WHERE id IN $idsForEpisode AND biographed_at IS NONE.
  //     Typical batches yield one group; mid-batch episode breaks yield two.
  //     The `IS NONE` guard makes each UPDATE idempotent under withTxRetry.
  const validIdStrs = validEvents.map((ev) => String(ev.id));
  const idsByEpisode = new Map(); // episodeId -> string[] (event ids)
  for (const ev of validEvents) {
    const epId = episodeIdForEvent.get(String(ev.id));
    if (!idsByEpisode.has(epId)) idsByEpisode.set(epId, []);
    idsByEpisode.get(epId).push(ev.id);
  }
  const markedSet = new Set();
  await withTxRetry(async () => {
    for (const [epId, idsForEpisode] of idsByEpisode) {
      const [rows] = await db
        .query(surql`
          UPDATE events
            SET biographed_at = time::now(), episode_id = ${epId}
            WHERE id IN ${idsForEpisode} AND biographed_at IS NONE
        `)
        .collect();
      // SurrealDB returns the updated rows; pull their ids into markedSet.
      for (const r of rows) markedSet.add(String(r.id));
    }
  });
  const racedCount = validIdStrs.length - markedSet.size;
  const batchKey = opts.__queueKey ?? `${source}:${[...validIdStrs].sort().join(',')}`;
  if (racedCount > 0) {
    console.warn(
      `biographer race detected on ${racedCount}/${validIdStrs.length} events in batch ${batchKey}`,
    );
  }
  for (const ev of validEvents) {
    perEvent.set(String(ev.id), {
      processed: true,
      episodeId: episodeIdForEvent.get(String(ev.id)),
      entitiesCount: keyToId.size,
    });
  }

  // 12. Evidence signals (Theme 2a) — AFTER the gated mark UPDATE succeeds.
  //     Running addEvidence BEFORE the mark would double-count the ledger on
  //     retry: a terminal mark failure leaves events unmarked, the re-drain
  //     re-runs the batched pipeline, and the second addEvidence call appends
  //     a fresh row per signal (addEvidence is not idempotent on
  //     (memo_id, source_event, reason) today). Ordering this after the mark
  //     keeps `evidence_signals` consistent with every other batched write.
  //     Limit to events whose mark actually landed (markedSet) — for raced
  //     events the other path already biographed them and may have already
  //     written their signals.
  if (evidenceJobs.length > 0) {
    try {
      const { addEvidence, readEvidenceConfig } = await import('../memory/evidence.js');
      const { RecordId } = await import('surrealdb');
      const evCfg = await readEvidenceConfig(db);
      for (const { ev, signals } of evidenceJobs) {
        if (!markedSet.has(String(ev.id))) continue;
        for (const sig of signals) {
          try {
            const idStr = String(sig.memo_id);
            const key = idStr.startsWith('memos:') ? idStr.slice('memos:'.length) : idStr;
            await addEvidence(db, {
              memo_id: new RecordId('memos', key),
              polarity: sig.polarity,
              reason: 'biographer',
              weight: evCfg.biographer_weight ?? 0.5,
              source_event: ev.id,
            });
          } catch (e) {
            console.warn(`[biographer evidence_signal] ${sig?.memo_id}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      console.warn(`[biographer evidence_signals] ${e.message}`);
    }
  }

  // 13. Runtime row: telemetry + last_run housekeeping. Capture the LLM
  //     usage object from `response.usage` (shape is provider-uniform:
  //     `input_tokens` / `output_tokens` — see
  //     system/runtime/hosts/claude-code.js:77-94 and pipeline.js:109-115).
  const inputTokens = Number(response?.usage?.input_tokens ?? 0);
  const outputTokens = Number(response?.usage?.output_tokens ?? 0);
  await _recordBatchTelemetry(db, {
    batches_total_delta: 1,
    batch_size: validEvents.length,
    events_biographed_via_batch_delta: markedSet.size,
    batch_input_tokens_delta: inputTokens,
    batch_output_tokens_delta: outputTokens,
    last_batch_input_tokens: inputTokens,
    last_batch_output_tokens: outputTokens,
  });

  return { perEvent };
}

async function _fallbackPerEvent(db, embedder, host, eventIds, perEvent, opts, batchError) {
  // Single-event fallback. Spec §8: never worse than today's baseline.
  let successCount = 0;
  for (const id of eventIds) {
    try {
      const r = await _processOne(db, embedder, host, id, opts);
      perEvent.set(String(id), r);
      if (r?.processed) successCount++;
    } catch (e) {
      perEvent.set(String(id), { failed: true, error: e.message });
    }
  }
  await _recordBatchTelemetry(db, {
    batches_total_delta: 1,
    batches_fallback_delta: 1,
    events_biographed_via_fallback_delta: successCount,
  });
  return { perEvent };
}

async function _recordBatchFallback(db, reason) {
  await withTxRetry(async () => {
    await db
      .query(surql`
        UPSERT type::record('runtime', 'biographer')
        SET value.last_fallback_reason = ${reason},
            value.last_fallback_at     = time::now()
      `)
      .collect();
  });
}

async function _recordBatchTelemetry(
  db,
  {
    batches_total_delta = 0,
    batches_fallback_delta = 0,
    events_biographed_via_batch_delta = 0,
    events_biographed_via_fallback_delta = 0,
    batch_input_tokens_delta = 0,
    batch_output_tokens_delta = 0,
    last_batch_input_tokens,
    last_batch_output_tokens,
    batch_size,
  },
) {
  await withTxRetry(async () => {
    await db
      .query(surql`
        UPSERT type::record('runtime', 'biographer')
        SET value.batches_total                  = (value.batches_total                  ?? 0) + ${batches_total_delta},
            value.batches_fallback               = (value.batches_fallback               ?? 0) + ${batches_fallback_delta},
            value.events_biographed_via_batch    = (value.events_biographed_via_batch    ?? 0) + ${events_biographed_via_batch_delta},
            value.events_biographed_via_fallback = (value.events_biographed_via_fallback ?? 0) + ${events_biographed_via_fallback_delta},
            value.batch_input_tokens_total       = (value.batch_input_tokens_total       ?? 0) + ${batch_input_tokens_delta},
            value.batch_output_tokens_total      = (value.batch_output_tokens_total      ?? 0) + ${batch_output_tokens_delta},
            value.last_batch_size                = ${batch_size ?? null},
            value.last_batch_input_tokens        = ${last_batch_input_tokens ?? null},
            value.last_batch_output_tokens       = ${last_batch_output_tokens ?? null}
      `)
      .collect();
  });
}
```

Rename the original 297-line body wrapped at lines 90–278 of `pipeline.js` to `_processOne(db, embedder, host, eventId, opts)` (signature unchanged); leave its internals byte-for-byte identical so the fallback path and the N=1 fast-path keep current semantics.

- [ ] **Step 4: Run all biographer integration tests by file path**

```bash
node --test \
  system/tests/integration/biographer-pipeline.test.js \
  system/tests/integration/biographer-failure.test.js \
  system/tests/integration/biographer-dedupe.test.js \
  system/tests/integration/biographer-batch-pipeline.test.js
```

Expected: all existing tests pass + new `cross-event entity dedup` test passes.

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add system/cognition/biographer/pipeline.js system/tests/integration/biographer-batch-pipeline.test.js
git commit -m "feat(c1): biographerProcessBatch issues one batched LLM call with per-event fan-out"
```

### Task 7.3: Per-event failure isolation test

**Files:** `system/tests/integration/biographer-batch-pipeline.test.js`

- [ ] **Step 1: Add the test**

```js
test('per-event failure isolation: malformed event #3 of 5 → 4 biographed, 1 in failed_event_ids', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ev1 = await recordEvent(db, e, { source: 'cli', content: 'one' });
  const ev2 = await recordEvent(db, e, { source: 'cli', content: 'two' });
  const ev3 = await recordEvent(db, e, { source: 'cli', content: 'three' });
  const ev4 = await recordEvent(db, e, { source: 'cli', content: 'four' });
  const ev5 = await recordEvent(db, e, { source: 'cli', content: 'five' });
  const host = fakeHost([
    JSON.stringify({
      events: [
        {
          event_id: String(ev1.id),
          entities: [{ name: 'A', type: 'person' }],
          edges: [],
          about: [],
          episode_continues_previous: false,
          episode_summary: null,
        },
        {
          event_id: String(ev2.id),
          entities: [{ name: 'B', type: 'person' }],
          edges: [],
          about: [],
          episode_continues_previous: true,
          episode_summary: null,
        },
        // ev3 malformed: bogus entity type.
        {
          event_id: String(ev3.id),
          entities: [{ name: 'C', type: 'unicorn' }],
          edges: [],
          about: [],
          episode_continues_previous: true,
          episode_summary: null,
        },
        {
          event_id: String(ev4.id),
          entities: [{ name: 'D', type: 'person' }],
          edges: [],
          about: [],
          episode_continues_previous: true,
          episode_summary: null,
        },
        {
          event_id: String(ev5.id),
          entities: [{ name: 'E', type: 'person' }],
          edges: [],
          about: [],
          episode_continues_previous: true,
          episode_summary: null,
        },
      ],
    }),
  ]);
  await biographerProcessBatch(db, e, host, [ev1.id, ev2.id, ev3.id, ev4.id, ev5.id]);

  const [rows] = await db
    .query('SELECT id, biographed_at FROM events ORDER BY ts ASC')
    .collect();
  const marked = rows.filter((r) => r.biographed_at);
  assert.equal(marked.length, 4);
  assert.equal(String(rows[2].id), String(ev3.id));
  assert.equal(rows[2].biographed_at, null);

  const [rt] = await db
    .query("SELECT value FROM type::record('runtime', 'biographer') LIMIT 1")
    .collect();
  const failed = rt[0]?.value?.failed_event_ids ?? [];
  assert.ok(
    failed.some((id) => String(id) === String(ev3.id)),
    `failed_event_ids should contain ${ev3.id}; got ${JSON.stringify(failed)}`,
  );
  // Last error must be kind-prefixed (spec §3 reconciliation) so it can be
  // distinguished from single-event network/JSON failures.
  const lastError = rt[0]?.value?.last_error;
  assert.match(
    lastError ?? '',
    /^batch_malformed:/,
    `expected last_error prefixed with 'batch_malformed:', got ${JSON.stringify(lastError)}`,
  );

  // Failure-isolation assertions: the malformed entity ("C", type "unicorn")
  // and any edges originating from event #3 must NOT be present.
  const [unicornRows] = await db
    .query("SELECT count() AS n FROM entities WHERE name = 'C' GROUP ALL")
    .collect();
  assert.equal(unicornRows?.[0]?.n ?? 0, 0, 'entity "C" must not exist');

  // No mentions / about / works_on / participates_in edges originate from ev3.
  for (const kind of ['mentions', 'about', 'works_on', 'participates_in']) {
    const [edgeRows] = await db
      .query(
        `SELECT count() AS n FROM edges WHERE kind = '${kind}' AND in = $eid GROUP ALL`,
        { eid: ev3.id },
      )
      .collect();
    assert.equal(
      edgeRows?.[0]?.n ?? 0,
      0,
      `expected 0 ${kind} edges originating from ${ev3.id}, found ${edgeRows?.[0]?.n}`,
    );
  }

  // occurs_with edges: any entity referenced only by ev3 must not appear at
  // either endpoint. The only entity referenced solely by ev3 was "C"
  // (already asserted absent above), so any (X, "C") occurs_with row would
  // also be evidence of leakage. Direct check:
  const [leakedOcw] = await db
    .query(
      "SELECT count() AS n FROM edges WHERE kind = 'occurs_with' AND " +
        "(in.name = 'C' OR out.name = 'C') GROUP ALL",
    )
    .collect();
  assert.equal(leakedOcw?.[0]?.n ?? 0, 0, 'no occurs_with edge may reference "C"');

  await close(db);
});

test('outer JSON parse failure triggers single-event fallback (5 LLM calls)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ev1 = await recordEvent(db, e, { source: 'cli', content: 'one' });
  const ev2 = await recordEvent(db, e, { source: 'cli', content: 'two' });
  let i = 0;
  const host = {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => {
      i++;
      if (i === 1) {
        // Batch call: not JSON.
        return { content: 'this is not JSON', usage: {} };
      }
      // Fallback per-event calls succeed.
      return {
        content: JSON.stringify({
          entities: [],
          edges: [],
          about: [],
          episode_continues_previous: false,
          episode_summary: null,
        }),
        usage: {},
      };
    },
  };
  await biographerProcessBatch(db, e, host, [ev1.id, ev2.id], { retryBaseDelayMs: 0 });
  assert.equal(i, 3, 'expected 1 batch attempt + 2 per-event fallback attempts');

  const [rt] = await db
    .query("SELECT value FROM type::record('runtime', 'biographer') LIMIT 1")
    .collect();
  assert.equal(rt[0]?.value?.last_fallback_reason, 'outer_json');
  assert.ok((rt[0]?.value?.batches_fallback ?? 0) >= 1);
  await close(db);
});
```

- [ ] **Step 2: Run the tests (expect pass — the implementation from Task 7.2 already handles this)**

```bash
npm run test:integration -- --test-name-pattern 'per-event failure isolation|outer JSON parse failure triggers'
```

If either fails, root-cause and fix `_recordBatchFallback` / `validateBiographerBatchOutput` / per-event `recordFailure` shape until they pass.

- [ ] **Step 3: Commit**

```bash
git add system/tests/integration/biographer-batch-pipeline.test.js
git commit -m "test(c1): per-event failure isolation + outer-JSON fallback paths"
```

### Task 7.4: Episode-break-mid-batch test

**Files:** `system/tests/integration/biographer-batch-pipeline.test.js`

- [ ] **Step 1: Add the test**

```js
test('episode break mid-batch: event #3 with continues_previous=false opens new episode', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const baseTs = Date.now();
  // Three events 0 / 5 min / 45 min apart. Default episode_window_minutes=30.
  const ev1 = await recordEvent(db, e, {
    source: 'cli',
    content: 'one',
    ts: new Date(baseTs).toISOString(),
  });
  const ev2 = await recordEvent(db, e, {
    source: 'cli',
    content: 'two',
    ts: new Date(baseTs + 5 * 60_000).toISOString(),
  });
  const ev3 = await recordEvent(db, e, {
    source: 'cli',
    content: 'three',
    ts: new Date(baseTs + 45 * 60_000).toISOString(),
  });
  const host = fakeHost([
    JSON.stringify({
      events: [
        {
          event_id: String(ev1.id),
          entities: [],
          edges: [],
          about: [],
          episode_continues_previous: false,
          episode_summary: null,
        },
        {
          event_id: String(ev2.id),
          entities: [],
          edges: [],
          about: [],
          episode_continues_previous: true,
          episode_summary: null,
        },
        {
          event_id: String(ev3.id),
          entities: [],
          edges: [],
          about: [],
          episode_continues_previous: false,
          episode_summary: 'first session ended',
        },
      ],
    }),
  ]);
  const tBeforeBatch = Date.now();
  await biographerProcessBatch(db, e, host, [ev1.id, ev2.id, ev3.id]);
  const [rows] = await db
    .query('SELECT id, episode_id FROM events ORDER BY ts ASC')
    .collect();
  assert.equal(String(rows[0].episode_id), String(rows[1].episode_id), 'ev1+ev2 same episode');
  assert.notEqual(String(rows[1].episode_id), String(rows[2].episode_id), 'ev3 new episode');

  const [epRows] = await db.query('SELECT count() AS n FROM episodes GROUP ALL').collect();
  assert.equal(epRows[0].n, 2);

  // Pin the accepted `started_at` divergence (spec §4 "Accepted divergence"):
  // the new episode's `started_at` is DB-side time::now(), NOT ev3.ts. This
  // regression test guards against an accidental change that wired
  // `lastEpisodeStart = eventTs` into a `createEpisode` override.
  const [newEpRows] = await db
    .query(
      `SELECT started_at FROM episodes WHERE id = $epId LIMIT 1`,
      { epId: rows[2].episode_id },
    )
    .collect();
  const newEpStartedAt = new Date(newEpRows[0].started_at).getTime();
  const ev3Ts = new Date(baseTs + 45 * 60_000).getTime();
  // started_at should be wall-clock-near-now, not 45 min in the past.
  assert.ok(
    newEpStartedAt >= tBeforeBatch,
    `new episode started_at (${newEpRows[0].started_at}) should be >= test wall-clock at batch start (${new Date(tBeforeBatch).toISOString()}); divergence from ev3.ts (${new Date(ev3Ts).toISOString()}) is the accepted behaviour`,
  );
  assert.ok(
    newEpStartedAt - ev3Ts > 60_000,
    'new episode.started_at must NOT equal ev3.ts — confirms accepted DB-side time::now() divergence',
  );

  await close(db);
});
```

Note: `recordEvent` may not accept a `ts` override — check `system/io/capture/record-event.js`. If `ts` is not honoured, replace the inline `ts` overrides with post-insert SurrealQL `UPDATE events SET ts = ${...}` calls, like:

```js
await db.query(surql`UPDATE ${ev1.id} SET ts = ${new Date(baseTs)}`).collect();
```

- [ ] **Step 2: Add the per-episode-group mark-UPDATE assertion**

The spec §3 / §7 invariant requires **exactly one UPDATE per distinct episode in the batch**. A batch spanning two episodes (this test's setup: ev1+ev2 in one episode, ev3 in another) must land exactly two `UPDATE events SET biographed_at … WHERE id IN …` statements. Add a sibling test that wraps `db.query` to count UPDATEs:

```js
test('mark step issues exactly one UPDATE per episode group (2 episodes → 2 UPDATEs)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const baseTs = Date.now();
  const ev1 = await recordEvent(db, e, { source: 'cli', content: 'one' });
  const ev2 = await recordEvent(db, e, { source: 'cli', content: 'two' });
  const ev3 = await recordEvent(db, e, { source: 'cli', content: 'three' });
  // Force episode break: ev3 is 45 min after ev1; default window is 30 min.
  await db.query(surql`UPDATE ${ev1.id} SET ts = ${new Date(baseTs)}`).collect();
  await db.query(surql`UPDATE ${ev2.id} SET ts = ${new Date(baseTs + 5 * 60_000)}`).collect();
  await db.query(surql`UPDATE ${ev3.id} SET ts = ${new Date(baseTs + 45 * 60_000)}`).collect();

  // Wrap db.query to capture every UPDATE-mark statement issued.
  const origQuery = db.query.bind(db);
  const markUpdates = [];
  db.query = (q, ...rest) => {
    // The mark step uses a tagged-template with the literal string fragment
    // `UPDATE events\n            SET biographed_at = time::now()` — check
    // the rendered SQL (passing through surql tags exposes a `query` string
    // on the QueryFuture; the cleanest match is on the raw substring).
    const text = String(q?.text ?? q ?? '');
    if (/UPDATE\s+events[\s\S]*biographed_at\s*=\s*time::now\(\)/i.test(text)) {
      markUpdates.push(text);
    }
    return origQuery(q, ...rest);
  };

  const host = fakeHost([
    JSON.stringify({
      events: [
        { event_id: String(ev1.id), entities: [], edges: [], about: [], episode_continues_previous: false, episode_summary: null },
        { event_id: String(ev2.id), entities: [], edges: [], about: [], episode_continues_previous: true,  episode_summary: null },
        { event_id: String(ev3.id), entities: [], edges: [], about: [], episode_continues_previous: false, episode_summary: 'closed' },
      ],
    }),
  ]);
  await biographerProcessBatch(db, e, host, [ev1.id, ev2.id, ev3.id]);

  // Restore db.query so cleanup doesn't double-count.
  db.query = origQuery;

  assert.equal(
    markUpdates.length,
    2,
    `expected 2 mark UPDATEs (one per episode group), got ${markUpdates.length}`,
  );
  await close(db);
});
```

Note: the exact mechanism to capture rendered SQL depends on the SurrealDB client's `surql` tag implementation. If `q.text` is not exposed by the JS SDK, instrument inside `_recordBatchTelemetry` callers or add a temporary counter export on `pipeline.js`. The assertion target — "exactly two UPDATEs" — is what matters; the capture mechanism is secondary.

- [ ] **Step 3: Run the tests**

```bash
npm run test:integration -- --test-name-pattern 'episode break mid-batch|mark step issues exactly one UPDATE per episode group'
```

If the first fails because of `ts` override semantics, apply the SurrealQL fix above and re-run. If the second fails because `q.text` is not the right field on `QueryFuture`, switch to instrumenting the production code with a counter and asserting on that.

- [ ] **Step 4: Commit**

```bash
git add system/tests/integration/biographer-batch-pipeline.test.js
git commit -m "test(c1): episode break mid-batch + per-episode-group mark UPDATE invariant"
```

---

## Phase 8 — `occurs_with` semantics + `before` edges

Covers spec §6 (per-event `occurs_with`, batch-internal `before`).

### Task 8.1: Per-event `occurs_with` semantics preserved

**Files:** `system/tests/integration/biographer-batch-occurs-with.test.js` (new)

- [ ] **Step 1: Write the test**

Create `system/tests/integration/biographer-batch-occurs-with.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { biographerProcessBatch } from '../../cognition/biographer/pipeline.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

function host(content) {
  return {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => ({ content, usage: {} }),
  };
}

test('per-event occurs_with: 3 events each mentioning {Alice, Bob} → weight 3 on (Alice, Bob)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ev1 = await recordEvent(db, e, { source: 'cli', content: 'one' });
  const ev2 = await recordEvent(db, e, { source: 'cli', content: 'two' });
  const ev3 = await recordEvent(db, e, { source: 'cli', content: 'three' });
  const perEventBlock = (id) => ({
    event_id: String(id),
    entities: [
      { name: 'Alice', type: 'person' },
      { name: 'Bob', type: 'person' },
    ],
    edges: [],
    about: [],
    episode_continues_previous: id === String(ev1.id) ? false : true,
    episode_summary: null,
  });
  const h = host(
    JSON.stringify({
      events: [perEventBlock(ev1.id), perEventBlock(ev2.id), perEventBlock(ev3.id)],
    }),
  );
  await biographerProcessBatch(db, e, h, [ev1.id, ev2.id, ev3.id]);

  const [rows] = await db
    .query("SELECT weight FROM edges WHERE kind = 'occurs_with'")
    .collect();
  assert.equal(rows.length, 1, 'expected exactly one (Alice, Bob) occurs_with edge');
  assert.equal(rows[0].weight, 3, 'expected weight 3 — one increment per event');
  await close(db);
});
```

- [ ] **Step 2: Run the test (expect pass — Task 7.2 already emits per-event)**

```bash
npm run test:integration -- --test-name-pattern 'per-event occurs_with'
```

- [ ] **Step 3: Commit**

```bash
git add system/tests/integration/biographer-batch-occurs-with.test.js
git commit -m "test(c1): per-event occurs_with semantics preserved across batch"
```

### Task 8.2: Within-batch `before` edges

**Files:** `system/tests/integration/biographer-batch-before-edges.test.js` (new)

- [ ] **Step 1: Write the test**

Create `system/tests/integration/biographer-batch-before-edges.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { biographerProcessBatch } from '../../cognition/biographer/pipeline.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

function host(content) {
  return {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => ({ content, usage: {} }),
  };
}

test('within-batch before edges chain consecutive events in the same episode', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ev1 = await recordEvent(db, e, { source: 'cli', content: 'one' });
  const ev2 = await recordEvent(db, e, { source: 'cli', content: 'two' });
  const ev3 = await recordEvent(db, e, { source: 'cli', content: 'three' });
  const h = host(
    JSON.stringify({
      events: [
        { event_id: String(ev1.id), entities: [], edges: [], about: [], episode_continues_previous: false, episode_summary: null },
        { event_id: String(ev2.id), entities: [], edges: [], about: [], episode_continues_previous: true,  episode_summary: null },
        { event_id: String(ev3.id), entities: [], edges: [], about: [], episode_continues_previous: true,  episode_summary: null },
      ],
    }),
  );
  await biographerProcessBatch(db, e, h, [ev1.id, ev2.id, ev3.id]);

  const [rows] = await db
    .query("SELECT in, out FROM edges WHERE kind = 'before'")
    .collect();
  assert.equal(rows.length, 2, 'expected 2 before edges (ev1→ev2, ev2→ev3)');
  await close(db);
});

test('within-batch before edges do not cross episode boundaries', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const baseTs = Date.now();
  const ev1 = await recordEvent(db, e, { source: 'cli', content: 'one' });
  const ev2 = await recordEvent(db, e, { source: 'cli', content: 'two' });
  const ev3 = await recordEvent(db, e, { source: 'cli', content: 'three' });
  // Adjust ts so ev3 is > 30 min after ev1 (forces episode break).
  await db.query(surql`UPDATE ${ev1.id} SET ts = ${new Date(baseTs)}`).collect();
  await db.query(surql`UPDATE ${ev2.id} SET ts = ${new Date(baseTs + 5 * 60_000)}`).collect();
  await db.query(surql`UPDATE ${ev3.id} SET ts = ${new Date(baseTs + 45 * 60_000)}`).collect();
  const h = host(
    JSON.stringify({
      events: [
        { event_id: String(ev1.id), entities: [], edges: [], about: [], episode_continues_previous: false, episode_summary: null },
        { event_id: String(ev2.id), entities: [], edges: [], about: [], episode_continues_previous: true,  episode_summary: null },
        { event_id: String(ev3.id), entities: [], edges: [], about: [], episode_continues_previous: false, episode_summary: 'closed' },
      ],
    }),
  );
  await biographerProcessBatch(db, e, h, [ev1.id, ev2.id, ev3.id]);
  const [rows] = await db
    .query("SELECT count() AS n FROM edges WHERE kind = 'before' GROUP ALL")
    .collect();
  assert.equal(rows[0].n, 1, 'expected exactly 1 before edge (ev1→ev2) — no cross-episode chain');
  await close(db);
});
```

- [ ] **Step 2: Run the tests**

```bash
npm run test:integration -- --test-name-pattern 'within-batch before edges'
```

Expected: 2 passing assertions. If `recordEvent` does not accept a `ts` override and the `UPDATE … SET ts` form is rejected by SurrealDB (e.g., `ts` is read-only), the second test must update events through `db.query(surql`UPDATE ${id} MERGE { ts: ${new Date(...)} }`)` instead.

- [ ] **Step 3: Commit**

```bash
git add system/tests/integration/biographer-batch-before-edges.test.js
git commit -m "test(c1): within-batch before edges chain consecutive same-episode events"
```

---

## Phase 9 — Daemon wiring

Covers spec §1 (accumulator placement), §9 (daemon wiring change at server.js around 237–261 + 660–720), MCP-tool path preserved.

**R-3 coordination.** The runtime-layer-hardening plan (R-3, see
`docs/superpowers/plans/2026-05-11-runtime-layer-hardening.md`) splits
`system/runtime/daemon/server.js` into per-route modules. If R-3 has
shipped before this Phase runs, the regions cited below have moved:

- Lines 237–261 (queue wiring + `queueWrap`) move to `system/runtime/daemon/boot.js` (the boot module that constructs the queue + accumulator at daemon start).
- Lines 679–686 (Stop-hook `pendingRows` drain inside `/internal/biographer/process-pending`) move to `system/runtime/daemon/routes/biographer.js`. Edit there using the equivalent `handler({ ctx, body })` signature that R-3 introduces.
- Lines 691–711 (`/internal/remember` handler) move to `system/runtime/daemon/routes/remember.js`. Same `handler({ ctx, body })` form.

Detect R-3's presence by checking for `system/runtime/daemon/routes/biographer.js`. If the file exists, edit each piece in its new home; otherwise apply the inline edits at the line ranges cited below in `server.js`. The conceptual change is identical in both layouts — only the file paths differ.

### Task 9.1: Daemon worker accepts both payload shapes; SELECT includes `source`; accumulator wired in

**Files:** `system/runtime/daemon/server.js` (pre-R-3), OR `system/runtime/daemon/boot.js` + `system/runtime/daemon/routes/biographer.js` + `system/runtime/daemon/routes/remember.js` (post-R-3).

- [ ] **Step 0: Detect R-3 layout**

```bash
test -f system/runtime/daemon/routes/biographer.js && echo "R-3 has shipped" || echo "pre-R-3"
```

- [ ] **Step 1: Read the file(s) to confirm current line numbers**

```bash
# Pre-R-3: everything is in server.js.
grep -n "createBiographerQueue\|queueWrap\|biographerProcess\|process-pending\|/internal/remember" system/runtime/daemon/server.js | head -20
# Post-R-3: split across boot.js + routes/biographer.js + routes/remember.js.
grep -n "createBiographerQueue\|queueWrap" system/runtime/daemon/boot.js 2>/dev/null | head -10
grep -n "biographerProcess\|process-pending" system/runtime/daemon/routes/biographer.js 2>/dev/null | head -10
grep -n "biographerProcess\|remember" system/runtime/daemon/routes/remember.js 2>/dev/null | head -10
```

Note the line numbers — they may have drifted from the spec's `679-686`. The plan below uses **`pendingRows` SELECT site** and **`/internal/remember` enqueue site** as anchors instead of fixed line numbers so it remains correct under drift.

- [ ] **Step 2: Add imports**

Add `biographerProcessBatch`, `readBatchConfig` to the existing `biographer/pipeline.js` import; add `createBatchAccumulator` import:

```js
import {
  biographerProcess,
  biographerProcessBatch,
  readBatchConfig,
} from '../../cognition/biographer/pipeline.js';
import { createBatchAccumulator } from '../../cognition/biographer/accumulator.js';
```

- [ ] **Step 3: Update the queue worker + queueWrap + add accumulator**

Replace the existing block (currently at server.js:237–261):

```js
const queue = createBiographerQueue({
  worker: async (eventId) => {
    const e = await idleEmbedder.get();
    const h = await getHost();
    await biographerProcess(dbHandle, e, h, eventId);
  },
  dedupe: true,
});
let lastBiographerRunAt = null;
const queueWrap = {
  enqueue: (id) => {
    const promise = queue.enqueue(id);
    promise
      .then(() => {
        lastBiographerRunAt = new Date().toISOString();
      })
      .catch((e) =>
        console.warn(`[biographer] enqueue/process failed for ${id}: ${e.message}`),
      );
    return promise;
  },
  get lastRunAt() {
    return lastBiographerRunAt;
  },
};
```

with:

```js
const queue = createBiographerQueue({
  worker: async (payload) => {
    const e = await idleEmbedder.get();
    const h = await getHost();
    if (payload && typeof payload === 'object' && Array.isArray(payload.eventIds)) {
      // Pass __queueKey through opts so the race-warn log can quote the
      // batch identity (spec §7).
      await biographerProcessBatch(dbHandle, e, h, payload.eventIds, {
        __queueKey: payload.__queueKey,
      });
    } else {
      // Single-id payload (MCP-tool callers + single-event fast path).
      await biographerProcess(dbHandle, e, h, payload);
    }
  },
  dedupe: true,
});
let lastBiographerRunAt = null;
const queueWrap = {
  enqueue: (payload) => {
    const promise = queue.enqueue(payload);
    const tag =
      payload && typeof payload === 'object' && Array.isArray(payload.eventIds)
        ? `batch(${payload.source}:${payload.eventIds.length})`
        : String(payload);
    promise
      .then(() => {
        lastBiographerRunAt = new Date().toISOString();
      })
      .catch((e) =>
        console.warn(`[biographer] enqueue/process failed for ${tag}: ${e.message}`),
      );
    return promise;
  },
  get lastRunAt() {
    return lastBiographerRunAt;
  },
};
const accumulator = createBatchAccumulator({
  config: () => _accumulatorConfigSnapshot,
  fire: (eventIds, source) => {
    const sorted = [...eventIds].sort();
    const payload = {
      kind: 'batch',
      source,
      eventIds: sorted,
      __queueKey: `${source}:${sorted.join(',')}`,
    };
    return queueWrap.enqueue(payload);
  },
});
let _accumulatorConfigSnapshot = { max_batch_size: 8, debounce_ms: 750, max_wait_ms: 3000 };
// Refresh the snapshot before each enqueue, lazily — readBatchConfig already caches 5 s.
async function refreshAccumulatorConfig() {
  try {
    _accumulatorConfigSnapshot = await readBatchConfig(dbHandle);
  } catch {
    // Keep last good snapshot; fall through to defaults if first read fails.
  }
}
await refreshAccumulatorConfig();
```

- [ ] **Step 4: Update `/internal/biographer/process-pending` to use accumulator + include `source`**

Find the `pendingRows` SELECT (currently at server.js:679) and the loop below it (server.js:682–686). Replace:

```js
const [pendingRows] = await dbHandle
  .query('SELECT id, ts FROM events WHERE biographed_at IS NONE ORDER BY ts ASC LIMIT 50')
  .collect();
for (const row of pendingRows) {
  queueWrap.enqueue(String(row.id)).catch(() => {
    // queueWrap already logs; swallow here to keep loop going.
  });
}
```

with:

```js
await refreshAccumulatorConfig();
const [pendingRows] = await dbHandle
  .query(
    'SELECT id, ts, source FROM events WHERE biographed_at IS NONE ORDER BY ts ASC LIMIT 50',
  )
  .collect();
for (const row of pendingRows) {
  try {
    accumulator.add(String(row.id), String(row.source ?? 'cli'));
  } catch (e) {
    console.warn(`[biographer] accumulator.add failed for ${row.id}: ${e.message}`);
  }
}
```

- [ ] **Step 5: Update `/internal/remember` to use accumulator**

Find the `queueWrap.enqueue(String(result.id))` line in the `/internal/remember` handler. Replace:

```js
queueWrap.enqueue(String(result.id)).catch(() => {
  // queueWrap already logs.
});
```

with:

```js
try {
  accumulator.add(String(result.id), String(body.source ?? 'cli'));
} catch (e) {
  console.warn(`[biographer] accumulator.add failed for ${result.id}: ${e.message}`);
}
```

- [ ] **Step 6: Leave the MCP-tool sites alone**

At server.js:394 (`createRunBiographerTool({ ... processor: queueWrap.enqueue })`) and server.js:402 (`createRecordCorrectionTool({ ... processor: queueWrap.enqueue })`): no change. They pass single-id payloads; the worker's `Array.isArray` check routes them through the original `biographerProcess` path.

- [ ] **Step 7: Run existing daemon-touching integration tests**

Run by file path (the `--test-name-pattern 'biographer'` filter would miss `process-pending-captures` and `conversation-capture` tests whose names don't include "biographer"):

```bash
node --test \
  system/tests/integration/biographer-pipeline.test.js \
  system/tests/integration/biographer-failure.test.js \
  system/tests/integration/biographer-dedupe.test.js \
  system/tests/integration/biographer-batch-pipeline.test.js
# Then any process-pending / conversation-capture tests that exist in your tree:
node --test $(ls system/tests/integration/*process-pending* system/tests/integration/*conversation-capture* 2>/dev/null)
```

Expected: all pass. The `process-pending` capture and biographer-catchup tests exercise the daemon wiring end-to-end.

- [ ] **Step 8: Lint + commit**

Adapt the `git add` target to the layout R-3 leaves behind (one file pre-R-3, three files post-R-3):

```bash
npm run lint
# Pre-R-3:
git add system/runtime/daemon/server.js
# Post-R-3:
# git add system/runtime/daemon/boot.js system/runtime/daemon/routes/biographer.js system/runtime/daemon/routes/remember.js
git commit -m "feat(c1): wire batch accumulator between enqueue sites and biographer queue"
```

---

## Phase 10 — Race-serialisation test (cross-batch)

Covers spec §7 (race), §12 verification gate #10.

### Task 10.1: Two-batch same-source serialisation through the queue

**Files:** `system/tests/integration/biographer-batch-race.test.js` (new)

The production "per source, at most one batch in-flight at a time"
invariant is enforced by `createBiographerQueue`, **not** by
`biographerProcessBatch` itself. Calling `biographerProcessBatch`
directly via `Promise.all` would only exercise SurrealDB's row-level
concurrency and the gated mark — it would silently bypass the queue
serialisation guarantee under test. This test instead instantiates
`createBiographerQueue` with an instrumented worker that asserts no
two `worker()` invocations overlap.

- [ ] **Step 1: Write the test**

Create `system/tests/integration/biographer-batch-race.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { biographerProcessBatch } from '../../cognition/biographer/pipeline.js';
import { createBiographerQueue } from '../../cognition/biographer/queue.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

function hostFor(seqContents) {
  let i = 0;
  return {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => ({ content: seqContents[i++ % seqContents.length], usage: {} }),
  };
}

test('queue serialises two same-source batches: no overlapping worker() calls; second waits for first', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ev1 = await recordEvent(db, e, { source: 'cli', content: 'one' });
  const ev2 = await recordEvent(db, e, { source: 'cli', content: 'two' });
  const ev3 = await recordEvent(db, e, { source: 'cli', content: 'three' });
  const ev4 = await recordEvent(db, e, { source: 'cli', content: 'four' });
  const batchAResp = JSON.stringify({
    events: [
      { event_id: String(ev1.id), entities: [{ name: 'A', type: 'person' }, { name: 'B', type: 'person' }], edges: [], about: [], episode_continues_previous: false, episode_summary: null },
      { event_id: String(ev2.id), entities: [{ name: 'A', type: 'person' }, { name: 'B', type: 'person' }], edges: [], about: [], episode_continues_previous: true,  episode_summary: null },
    ],
  });
  const batchBResp = JSON.stringify({
    events: [
      { event_id: String(ev3.id), entities: [{ name: 'A', type: 'person' }, { name: 'B', type: 'person' }], edges: [], about: [], episode_continues_previous: true, episode_summary: null },
      { event_id: String(ev4.id), entities: [{ name: 'A', type: 'person' }, { name: 'B', type: 'person' }], edges: [], about: [], episode_continues_previous: true, episode_summary: null },
    ],
  });
  const h = hostFor([batchAResp, batchBResp]);

  // Instrumented worker: tracks the number of in-flight worker() calls.
  // The invariant the queue is supposed to enforce is `inflight <= 1` at all
  // times. We add a small setTimeout inside each worker() call to give a
  // would-be parallel invocation a chance to violate the invariant if the
  // queue is broken.
  let inflight = 0;
  let peakInflight = 0;
  const workerCallOrder = [];
  const worker = async (payload) => {
    inflight++;
    peakInflight = Math.max(peakInflight, inflight);
    workerCallOrder.push(payload.__queueKey ?? String(payload));
    try {
      await new Promise((r) => setTimeout(r, 30));
      await biographerProcessBatch(db, e, h, payload.eventIds);
    } finally {
      inflight--;
    }
  };
  const queue = createBiographerQueue({ worker, dedupe: true });

  // Enqueue two batch payloads through the production dedupe shape (__queueKey
  // per spec §7 / §9). Calling enqueue twice in a row mirrors the daemon's
  // accumulator.fire() flow.
  const p1 = queue.enqueue({
    kind: 'batch',
    source: 'cli',
    eventIds: [ev1.id, ev2.id],
    __queueKey: `cli:${[ev1.id, ev2.id].map(String).sort().join(',')}`,
  });
  const p2 = queue.enqueue({
    kind: 'batch',
    source: 'cli',
    eventIds: [ev3.id, ev4.id],
    __queueKey: `cli:${[ev3.id, ev4.id].map(String).sort().join(',')}`,
  });
  await Promise.all([p1, p2]);

  // Serialisation assertions (the keystone of this test):
  assert.equal(
    peakInflight,
    1,
    `queue must serialise worker() invocations; observed peak inflight = ${peakInflight}`,
  );
  assert.equal(workerCallOrder.length, 2, 'expected exactly 2 worker() invocations');

  // Convergence assertions (the second-order properties that justify the
  // serialisation invariant in production).
  const [evRows] = await db
    .query('SELECT id, biographed_at FROM events ORDER BY ts ASC')
    .collect();
  for (const r of evRows) assert.ok(r.biographed_at, `${r.id} not biographed`);

  const [entRows] = await db.query('SELECT count() AS n FROM entities GROUP ALL').collect();
  assert.equal(entRows[0].n, 2);

  const [ocwRows] = await db
    .query("SELECT weight FROM edges WHERE kind = 'occurs_with'")
    .collect();
  assert.equal(ocwRows.length, 1, 'expected exactly one (A, B) occurs_with edge');
  assert.equal(ocwRows[0].weight, 4, 'expected weight 4 — one per event');
  await close(db);
});
```

- [ ] **Step 2: Run the test**

```bash
npm run test:integration -- --test-name-pattern 'queue serialises two same-source batches'
```

Expected: passing. The keystone assertion is `peakInflight === 1` — if it observes `2`, the queue is allowing parallel `worker()` calls and the production "one-batch-per-source-in-flight" invariant is broken. If `occurs_with` weight is `<4`, the entity-cascade dedup or the per-event edge emission is dropping mentions — debug `keyToId` resolution.

- [ ] **Step 3: Commit**

```bash
git add system/tests/integration/biographer-batch-race.test.js
git commit -m "test(c1): two concurrent batches converge — every event biographed exactly once"
```

---

## Phase 11 — Documentation updates

Covers spec §13 ("Modified" docs entries).

### Task 11.1: Update `docs/faculties.md` biographer section

**Files:** `docs/faculties.md`

- [ ] **Step 1: Read the section**

```bash
grep -n "### biographer" docs/faculties.md
```

- [ ] **Step 2: Replace the section body**

Replace lines 65–69 (current `### biographer` block) with:

```md
### biographer
**Per-turn consolidation: turns raw events into structured entities, edges, and (rarely) memos. Batched across consecutive events from the same source.**
- Files: `system/cognition/biographer/pipeline.js`, `system/cognition/biographer/batch-prompt.js`, `system/cognition/biographer/batch-output.js`, `system/cognition/biographer/accumulator.js`, `system/cognition/biographer/queue.js`, `system/cognition/biographer/output.js`, `system/cognition/biographer/prompt.js`, `system/cognition/biographer/` (edges/stage1-exact/stage2-embedding/stage3-disambig/upsert-entity).
- Trigger: `createBatchAccumulator` (source-bucketed) fires when `max_batch_size` (default 8), `debounce_ms` (default 750ms), or `max_wait_ms` (default 3000ms) hits — whichever first. Tunables live in `runtime:biographer.value.batch_config` and are re-read per flush. Rollback: set `batch_config.disable = true` to short-circuit the accumulator and route every event through the pre-C1 single-event path.
- One LLM call per batch via `biographerProcessBatch`. Per-event validation isolates failures: a malformed entry for one event does not poison the others.
- Fallback: outer-envelope JSON parse failure, batch-validation failure, or retries-exhausted on the LLM call all fall back to looping the original single-event `biographerProcess` — never worse than today's baseline. Telemetry: `runtime:biographer.value.{batches_total, batches_fallback, last_fallback_reason, events_biographed_via_batch, events_biographed_via_fallback, batch_input_tokens_total, batch_output_tokens_total}`.
- Writes: `entities` (upserted via 3-stage cascade, deduped by `(type, name_lower)` across the batch), `edges` (mentions/about/works_on/participates_in/occurs_with/before via one `store.relateAll` call), `events.biographed_at = time::now()` and `events.episode_id` (gated by `WHERE biographed_at IS NONE`).
```

- [ ] **Step 3: Commit**

```bash
git add docs/faculties.md
git commit -m "docs(faculties): biographer section reflects batching + fallback"
```

### Task 11.2: Update `docs/architecture.md` agent-turn step 6

**Files:** `docs/architecture.md`

- [ ] **Step 1: Replace step 6**

Replace line 127:

```md
6. **Stop hook** spawns biographer in detached subprocess. Reads new events, makes one LLM call per event, UPSERTs entities + emits `edges` via `store.relateAll(...)`, sets `events.biographed_at`.
```

with:

```md
6. **Stop hook** spawns biographer in detached subprocess. Pending events flow into a source-bucketed accumulator (defaults: `max_batch_size=8`, `debounce_ms=750`, `max_wait_ms=3000`; `disable=false`). One LLM call per batch resolves entities + edges + per-event episode boundaries; the underlying queue serialises batches across sources. UPSERTs entities (deduped per `(type, name_lower)` per batch) + emits `edges` via `store.relateAll(...)`, sets `events.biographed_at` + `events.episode_id` per event under one gated UPDATE *per episode group* in the batch (typically one group; two on mid-batch episode break). Rollback knob: `batch_config.disable=true` reverts the daemon to the per-event path.
```

- [ ] **Step 2: Commit**

```bash
git add docs/architecture.md
git commit -m "docs(architecture): agent-turn step 6 reflects batched biographer"
```

---

## Phase 12 — Final verification + spec-coverage sweep

### Task 12.1: Run the complete test suite

- [ ] **Step 1: Run lint**

```bash
npm run lint
```

Expected: zero errors.

- [ ] **Step 2: Run unit tests**

```bash
npm run test:unit
```

Expected: every existing test still passes plus four new files:
- `biographer-batch-prompt.test.js`
- `biographer-batch-validate.test.js`
- `biographer-batch-accumulator.test.js`
- `biographer-queue.test.js` (extended with two new cases)

- [ ] **Step 3: Run integration tests**

```bash
npm run test:integration
```

Plus explicit backwards-compat run by file path (in case `npm run test:integration` skips files whose names don't match an internal filter):

```bash
node --test \
  system/tests/integration/biographer-pipeline.test.js \
  system/tests/integration/biographer-failure.test.js \
  system/tests/integration/biographer-dedupe.test.js \
  system/tests/integration/biographer-batch-pipeline.test.js \
  system/tests/integration/biographer-batch-occurs-with.test.js \
  system/tests/integration/biographer-batch-before-edges.test.js \
  system/tests/integration/biographer-batch-race.test.js
```

Expected: every existing test still passes (specifically `biographer-pipeline`, `biographer-failure`, `biographer-dedupe`, `biographer-catchup`, `biographer-process-pending-captures`) plus four new files:
- `biographer-batch-pipeline.test.js`
- `biographer-batch-occurs-with.test.js`
- `biographer-batch-before-edges.test.js`
- `biographer-batch-race.test.js`

- [ ] **Step 4: Spec-coverage sweep**

Walk the spec section by section and confirm each is exercised. Use this table as a checklist:

| Spec §  | Covered by |
|---------|-----------|
| §1 Batch trigger (count / debounce / cap / source-scope / bucket sealing / runtime config read) | Phase 4 accumulator tests; Phase 9 daemon wiring; migration 0011 |
| §2 Prompt structure (system+catalog cache_control, JSON envelope, 2000-char truncation) | Phase 2 batch-prompt + tests |
| §3 Output validation (per-event isolation, missing/malformed/extra ids, batch-level fail) | Phase 3 batch-output + tests |
| §4 Episode determination across batch | Phase 7 episode-loop implementation + Task 7.4 mid-batch break test |
| §5 Entity cascade dedup by `(type, name_lower)` | Phase 7 entity dedup + Task 7.2 dedup test |
| §6 Edges (per-event mentions/about/works_on/occurs_with; within-batch before; cap=cooccur_cap) | Phase 7 + Phase 8 occurs_with + Phase 8 before-edges tests |
| §7 Idempotency + race (single mark statement, gated UPDATE, race-warn log) | Phase 7 mark step + Phase 10 race test |
| §8 Fallback (network / outer_json / batch_validation → per-event loop + telemetry) | Phase 7 fallback impl + outer-JSON test |
| §9 Backwards-compat (`biographerProcess` wrapper, queue dedupe via `__queueKey`, MCP single-id path) | Phase 5 queue + Phase 6 wrapper + Phase 9 daemon wiring |
| §10 Test plan + rollout | All Phase 7–10 tests |
| §11 Cost envelope | Covered by telemetry counters added in Phase 7 |
| §12 Verification gates (1–12) | Mapped below |
| §13 File-by-file changes | Matches "File structure" table above |
| §14 Open questions | Carried forward (no implementation) — see "Open items" below |

- [ ] **Step 5: Verification gates check (spec §12)**

Verify each gate has a corresponding test or runtime check:

1. Equivalence at N=1 → `biographerProcessBatch with [evt.id] matches single-event end-to-end behaviour` (Phase 6)
2. Cross-event entity dedup → `cross-event entity dedup: 3 events × "Atlas"` (Phase 7)
3. Per-event output isolation → `per-event failure isolation: malformed event #3 of 5` (Phase 7)
4. Episode break mid-batch → `episode break mid-batch: event #3 with continues_previous=false opens new episode` AND `mark step issues exactly one UPDATE per episode group (2 episodes → 2 UPDATEs)` (Phase 7)
5. Source separation → `source separation: cli and discord events produce two fires` (Phase 4 accumulator)
6. Fallback on outer JSON parse → `outer JSON parse failure triggers single-event fallback` (Phase 7)
7. Fallback on retries exhausted → covered by the same fallback path; add a follow-up test if telemetry shows insufficient confidence (open item below)
8. `occurs_with` per-event semantics preserved → `per-event occurs_with: 3 events each mentioning {Alice, Bob}` (Phase 8)
9. Idempotent batch retry → covered by gated UPDATE in mark step + composite-id UPSERTs in `relateAll`; documented cost on `occurs_with` (open item below)
10. Race serialisation → `queue serialises two same-source batches: no overlapping worker() calls; second waits for first` (Phase 10)
11. `before` edges within batch → `within-batch before edges chain` + `do not cross episode boundaries` (Phase 8)
12. Tunable disables batching → covered by `readBatchConfig` + accumulator `config()` callback re-reading per flush. **Rollback procedure**: set `batch_config.disable = true` on `runtime:biographer` (not `max_batch_size = 1`). The `disable: true` knob is the true bypass — it short-circuits the bucket/timer in `accumulator.add(id, source)` so events flow straight to `queue.enqueue(id)`, and the worker's `Array.isArray(payload?.eventIds)` check routes them through the pre-C1 `biographerProcess` path. `max_batch_size = 1` only collapses batches to size 1 — events still pay the accumulator round-trip (bucket open, debounce/cap timer, flush) and the worker still goes through `biographerProcessBatch`. Sanity rollback command (against a running daemon's DB):

```surql
-- Disable batching at runtime; takes effect within the 5s readBatchConfig
-- cache TTL.
UPDATE type::record('runtime', 'biographer')
   SET value.batch_config.disable = true;

-- To re-enable:
UPDATE type::record('runtime', 'biographer')
   SET value.batch_config.disable = false;
```

- [ ] **Step 6: Final commit if any docs/tests changed during the sweep**

```bash
git status
# If clean, no commit needed.
# If any changes accumulated from the sweep, commit them.
```

---

## Open items (not implemented in this plan; tracked from spec §14)

- **Default `max_batch_size` of 8 vs 10 vs 12.** Pinned at 8 here; revisit after a week of `runtime:biographer.value.batches_total` + `last_batch_size` telemetry.
- **`biographer-process-pending` and `biographer-catchup` CLIs still loop single-event.** Easy follow-up: chunk the id list and call `biographerProcessBatch` directly. Left out of the hot-path-only C1 scope.
- **Cross-batch `before` edges (last event of batch K → first event of batch K+1).** Requires a per-source "last biographed event" cursor. Defer.
- **Per-batch `evidence_signals`.** Today they remain per-event; revisit only if telemetry shows redundant tagging.
- **Gate #7 (retries-exhausted explicit test).** Add an integration test in a follow-up that makes the host throw 3 times on the batch call and then succeed per-event, asserting `last_fallback_reason='network'`.
- **Gate #9 (idempotent retry with simulated DB hiccup on mark step).** Requires a fault-injection harness on `withTxRetry`; defer to a dedicated reliability PR.
- **Telemetry table** (optional `biographer_telemetry` table beyond the runtime-row counters). Not strictly required for C1 cost-saving claims; sketch a follow-up if downstream tooling needs structured history.
