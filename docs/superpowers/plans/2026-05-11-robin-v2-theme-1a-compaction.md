# Theme 1a — Compaction & forgetting · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a nightly `step-compaction` dream step that (a) merges semantic-duplicate `kind='knowledge'` memos via existing `supersedes` edges and (b) moves aged-out low-signal memos into a parallel `archive_*` tier, preserving them for audit but excluding them from default recall.

**Architecture:** Two mechanisms under one dream step. Dedup uses the existing `supersedes` machinery — zero new infra. Archive uses three new tables (`archive_memos`, `archive_edges`, `archive_log`) plus one telemetry table (`compaction_telemetry`). The whole step runs in nightly dream after `step-scope-cleanup`. CLI command `robin memo restore` is the explicit reversibility path.

**Tech Stack:** Node.js 18+, SurrealDB 3.0.5 via `@surrealdb/node` 3.0.3, `node --test` runner, Biome lint.

**Spec:** `docs/superpowers/specs/2026-05-11-robin-v2-theme-1a-compaction-design.md`

**Dependencies:** Waits for `feat/surrealdb-improvements` merge (uses post-merge edge fields `in`/`out`, arrow traversal in eligibility queries).

---

## File structure

| File | Responsibility |
|---|---|
| `src/schema/migrations/0001-init.surql` (modify) | Add archive tables, `compaction_telemetry`, seed `runtime:compaction.config` |
| `src/memory/archive.js` (new) | Only writer to archive tables; `archiveMemo`, `restoreMemo`, helpers |
| `src/dream/step-compaction.js` (new) | The dream step; reads config, runs dedup pass + archive pass, writes telemetry |
| `src/dream/pipeline.js` (modify) | Wire `step-compaction` after `step-scope-cleanup` |
| `src/memory/store.js` (modify) | Audit-only: confirm `_surfaceSearch` queries hot tables only |
| `src/cli/commands/compaction.js` (new) | `robin compaction config get|set`, `robin memo restore`, `robin memo list --include-archived` |
| `tests/unit/archive.test.js` (new) | Per-memo archive round-trip; idempotence |
| `tests/unit/step-compaction-dedup.test.js` (new) | Pass 1 + pass 2 dedup behavior |
| `tests/unit/step-compaction-archive.test.js` (new) | Per-kind eligibility predicates |
| `tests/integration/step-compaction-roundtrip.test.js` (new) | End-to-end: archive → restore identity |
| `tests/fixtures/compaction-golden.json` (new) | Six semantic-pair fixtures for dedup gate 2 |

---

## Phase 1 — Schema + config row

### Task 1: Add archive_memos table

**Files:**
- Modify: `src/schema/migrations/0001-init.surql` (end of file)

- [ ] **Step 1: Add archive_memos DDL**

Append to `0001-init.surql`:

```surql
-- THEME 1A: archive tier (out of hot recall, kept for audit)
DEFINE TABLE archive_memos SCHEMAFULL TYPE NORMAL;
DEFINE FIELD kind            ON archive_memos TYPE string;
DEFINE FIELD content         ON archive_memos TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD content_hash    ON archive_memos TYPE option<string>;
DEFINE FIELD confidence      ON archive_memos TYPE float DEFAULT 0.5;
DEFINE FIELD signal_count    ON archive_memos TYPE int DEFAULT 1;
DEFINE FIELD decay_anchor    ON archive_memos TYPE datetime DEFAULT time::now();
DEFINE FIELD derived_by      ON archive_memos TYPE string;
DEFINE FIELD derived_at      ON archive_memos TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at      ON archive_memos TYPE datetime DEFAULT time::now();
DEFINE FIELD last_active     ON archive_memos TYPE datetime DEFAULT time::now();
DEFINE FIELD scope           ON archive_memos TYPE string DEFAULT 'global';
DEFINE FIELD tags            ON archive_memos TYPE array<string> DEFAULT [];
DEFINE FIELD meta            ON archive_memos TYPE option<object> FLEXIBLE;
DEFINE FIELD archived_at     ON archive_memos TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD archive_reason  ON archive_memos TYPE string;
-- NO FTS / vector index — recall structurally cannot reach in
DEFINE INDEX archive_memos_kind         ON archive_memos FIELDS kind;
DEFINE INDEX archive_memos_archived_at  ON archive_memos FIELDS archived_at;
DEFINE INDEX archive_memos_chash        ON archive_memos FIELDS content_hash;
```

- [ ] **Step 2: Run migration on a throwaway DB**

Run: `node scripts/migrate-fresh.mjs --target mem`
Expected: migration applies cleanly; no errors.

- [ ] **Step 3: Commit**

```bash
git add src/schema/migrations/0001-init.surql
git commit -m "feat(schema): add archive_memos table"
```

### Task 2: Add archive_edges, archive_log, compaction_telemetry tables

**Files:**
- Modify: `src/schema/migrations/0001-init.surql`

- [ ] **Step 1: Append archive_edges + archive_log + compaction_telemetry**

```surql
DEFINE TABLE archive_edges SCHEMAFULL TYPE RELATION;
DEFINE FIELD kind         ON archive_edges TYPE string;
DEFINE FIELD in           ON archive_edges TYPE record;
DEFINE FIELD out          ON archive_edges TYPE record;
DEFINE FIELD weight       ON archive_edges TYPE option<float>;
DEFINE FIELD last_seen    ON archive_edges TYPE option<datetime>;
DEFINE FIELD valid_from   ON archive_edges TYPE option<datetime>;
DEFINE FIELD valid_until  ON archive_edges TYPE option<datetime>;
DEFINE FIELD context      ON archive_edges TYPE option<string>;
DEFINE FIELD created_at   ON archive_edges TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta         ON archive_edges TYPE option<object> FLEXIBLE;
DEFINE INDEX archive_edges_kind_in   ON archive_edges FIELDS kind, in;
DEFINE INDEX archive_edges_kind_out  ON archive_edges FIELDS kind, out;

DEFINE TABLE archive_log SCHEMAFULL TYPE NORMAL;
DEFINE FIELD memo_id  ON archive_log TYPE record;
DEFINE FIELD action   ON archive_log TYPE string;
DEFINE FIELD reason   ON archive_log TYPE string;
DEFINE FIELD ts       ON archive_log TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta     ON archive_log TYPE option<object> FLEXIBLE;
DEFINE INDEX archive_log_memo_ts ON archive_log FIELDS memo_id, ts;

DEFINE TABLE compaction_telemetry SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts             ON compaction_telemetry TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD dedup_clusters ON compaction_telemetry TYPE int DEFAULT 0;
DEFINE FIELD dedup_merged   ON compaction_telemetry TYPE int DEFAULT 0;
DEFINE FIELD archived       ON compaction_telemetry TYPE int DEFAULT 0;
DEFINE FIELD by_kind        ON compaction_telemetry TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD duration_ms    ON compaction_telemetry TYPE int DEFAULT 0;
DEFINE FIELD errors         ON compaction_telemetry TYPE array<string> DEFAULT [];
DEFINE INDEX compaction_telemetry_ts ON compaction_telemetry FIELDS ts;
```

- [ ] **Step 2: Run migration**

Run: `node scripts/migrate-fresh.mjs --target mem`
Expected: applies cleanly.

- [ ] **Step 3: Commit**

```bash
git add src/schema/migrations/0001-init.surql
git commit -m "feat(schema): add archive_edges, archive_log, compaction_telemetry"
```

### Task 3: Seed runtime:compaction.config

**Files:**
- Modify: `src/schema/migrations/0001-init.surql` (or a follow-on seed file if the migration is sealed)

- [ ] **Step 1: Add seed statement at end of migration**

```surql
UPSERT runtime:compaction.config CONTENT {
  value: {
    semantic_threshold: 0.93,
    cluster_max_size: 8,
    dedup_enabled: true,
    archive_enabled: true,
    archive_thresholds: {
      knowledge:  { age_days: 360, signal_max: 1 },
      habit:      { age_days: 120, signal_max: 1 },
      thread:     { age_days: 60 },
      prediction: { resolved_age_days: 730 }
    }
  }
};
```

- [ ] **Step 2: Verify seed**

Run a test script that opens the DB and reads `runtime:compaction.config`:
Expected: `value.semantic_threshold === 0.93`.

- [ ] **Step 3: Commit**

```bash
git add src/schema/migrations/0001-init.surql
git commit -m "feat(schema): seed runtime:compaction.config defaults"
```

---

## Phase 2 — `src/memory/archive.js`

### Task 4: archiveMemo helper + unit test

**Files:**
- Create: `src/memory/archive.js`
- Create: `tests/unit/archive.test.js`

- [ ] **Step 1: Write failing test for archiveMemo**

`tests/unit/archive.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemDb } from './helpers/db.js';   // existing test helper
import { archiveMemo } from '../../src/memory/archive.js';
import * as store from '../../src/memory/store.js';
import { stubEmbedder } from './helpers/embedder.js';

test('archiveMemo moves a memo + incident edges atomically', async () => {
  const db = await openMemDb();
  const embedder = stubEmbedder();
  const { id } = await store.note(db, embedder, 'knowledge', {
    content: 'kevin likes coffee',
    derived_by: 'manual',
  });
  // attach one outgoing edge via store.relate
  const { id: entId } = await store.upsertEntity(db, embedder, { name: 'kevin', type: 'person' });
  await store.relate(db, id, entId, 'about');

  await archiveMemo(db, id, 'stale_age');

  // hot table empty
  const [hot] = await db.query(`SELECT * FROM ${id}`).collect();
  assert.equal(hot.length, 0, 'memo removed from hot');
  // archive table populated
  const [arch] = await db.query('SELECT * FROM archive_memos').collect();
  assert.equal(arch.length, 1);
  assert.equal(arch[0].archive_reason, 'stale_age');
  // incident edge moved
  const [aEdges] = await db.query('SELECT * FROM archive_edges').collect();
  assert.equal(aEdges.length, 1);
  const [hotEdges] = await db.query(`SELECT * FROM edges WHERE in = ${id} OR out = ${id}`).collect();
  assert.equal(hotEdges.length, 0);
  // archive_log row
  const [log] = await db.query('SELECT * FROM archive_log').collect();
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'archived');
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --test tests/unit/archive.test.js`
Expected: FAIL — `archiveMemo` not defined.

- [ ] **Step 3: Implement archiveMemo**

`src/memory/archive.js`:

```js
import { surql } from 'surrealdb';

const ARCHIVE_MEMO_FIELDS = [
  'kind', 'content', 'content_hash', 'confidence', 'signal_count',
  'decay_anchor', 'derived_by', 'derived_at', 'updated_at',
  'last_active', 'scope', 'tags', 'meta',
];

export async function archiveMemo(db, id, reason) {
  // Single transaction: copy memo + incident edges to archive tables, delete from hot, log
  const sql = `
    BEGIN;
      LET $row = (SELECT * FROM ONLY ${id});
      LET $archived = (CREATE archive_memos CONTENT
        object::from_entries(array::filter(
          object::entries($row),
          |$kv| array::any([${ARCHIVE_MEMO_FIELDS.map(f => `'${f}'`).join(',')}], |$k| $k = $kv[0])
        ))
        MERGE { archived_at: time::now(), archive_reason: $reason }
        RETURN id
      )[0];
      INSERT INTO archive_edges (SELECT * FROM edges WHERE in = ${id} OR out = ${id});
      DELETE edges WHERE in = ${id} OR out = ${id};
      DELETE ${id};
      CREATE archive_log CONTENT { memo_id: $archived, action: 'archived', reason: $reason };
    COMMIT;
  `;
  await db.query(sql, { reason }).collect();
}
```

Note: the exact SurrealQL idiom for "copy selected fields" may need tweaking against 3.0.5. If `object::from_entries`/`object::entries` aren't available, fall back to constructing the CONTENT object in JS and parameterising. The test pins the behavior — adjust until green.

- [ ] **Step 4: Run test to verify passes**

Run: `node --test tests/unit/archive.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/archive.js tests/unit/archive.test.js
git commit -m "feat(memory): archiveMemo with edge co-relocation"
```

### Task 5: restoreMemo helper + unit test

**Files:**
- Modify: `src/memory/archive.js`
- Modify: `tests/unit/archive.test.js`

- [ ] **Step 1: Write failing round-trip test**

Append to `archive.test.js`:

```js
import { restoreMemo } from '../../src/memory/archive.js';

test('restoreMemo reverses archiveMemo bit-for-bit (edges preserved)', async () => {
  const db = await openMemDb();
  const embedder = stubEmbedder();
  const { id } = await store.note(db, embedder, 'knowledge', {
    content: 'kevin likes tea',
    derived_by: 'manual',
  });
  const { id: entId } = await store.upsertEntity(db, embedder, { name: 'kevin', type: 'person' });
  await store.relate(db, id, entId, 'about');

  const [before] = await db.query(`SELECT * FROM ${id}`).collect();
  const beforeEdges = await db.query(`SELECT * FROM edges WHERE in = ${id} OR out = ${id}`).collect();

  await archiveMemo(db, id, 'stale_age');
  const [archived] = await db.query('SELECT id FROM archive_memos').collect();
  await restoreMemo(db, archived[0].id);

  const [after] = await db.query(`SELECT * FROM memos WHERE content = 'kevin likes tea'`).collect();
  assert.equal(after.length, 1);
  // content + scope + tags + kind preserved
  assert.equal(after[0].content, before[0].content);
  assert.equal(after[0].kind, before[0].kind);
  // edges restored
  const afterEdges = await db.query(`SELECT * FROM edges WHERE in = ${after[0].id} OR out = ${after[0].id}`).collect();
  assert.equal(afterEdges[0].length, beforeEdges[0].length);
  // archive tables empty
  const [arch] = await db.query('SELECT * FROM archive_memos').collect();
  assert.equal(arch.length, 0);
  // archive_log has two rows (archived + restored)
  const [log] = await db.query('SELECT * FROM archive_log').collect();
  assert.equal(log.length, 2);
  assert.equal(log[1].action, 'restored');
});
```

- [ ] **Step 2: Run test to verify failure**

Expected: FAIL — `restoreMemo` not defined.

- [ ] **Step 3: Implement restoreMemo**

In `src/memory/archive.js`:

```js
export async function restoreMemo(db, archivedId) {
  const sql = `
    BEGIN;
      LET $row = (SELECT * OMIT archived_at, archive_reason FROM ONLY ${archivedId});
      LET $restored = (CREATE memos CONTENT $row RETURN id)[0];
      INSERT INTO edges (SELECT * FROM archive_edges WHERE in = ${archivedId} OR out = ${archivedId});
      DELETE archive_edges WHERE in = ${archivedId} OR out = ${archivedId};
      DELETE ${archivedId};
      CREATE archive_log CONTENT { memo_id: $restored, action: 'restored', reason: 'restored_by_user' };
    COMMIT;
  `;
  await db.query(sql).collect();
}
```

- [ ] **Step 4: Run test to verify passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/archive.js tests/unit/archive.test.js
git commit -m "feat(memory): restoreMemo round-trip"
```

---

## Phase 3 — `src/dream/step-compaction.js`

### Task 6: Dedup pass 1 (exact content_hash)

**Files:**
- Create: `src/dream/step-compaction.js`
- Create: `tests/unit/step-compaction-dedup.test.js`

- [ ] **Step 1: Write failing test for exact dedup**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemDb } from './helpers/db.js';
import { dreamStepCompaction } from '../../src/dream/step-compaction.js';
import { stubEmbedder } from './helpers/embedder.js';
import * as store from '../../src/memory/store.js';

test('dedup pass 1 merges memos sharing content_hash via supersedes', async () => {
  const db = await openMemDb();
  const e = stubEmbedder();
  // Two memos with identical content → same content_hash
  const a = await store.note(db, e, 'knowledge', { content: 'kevin likes tea', derived_by: 'manual' });
  const b = await store.note(db, e, 'knowledge', { content: 'kevin likes tea', derived_by: 'manual' });

  const summary = await dreamStepCompaction(db, e);

  assert.equal(summary.dedup_merged, 1);
  // One memo superseded; freshness=0 on the non-canonical
  const [supEdges] = await db.query(`SELECT * FROM edges WHERE kind = 'supersedes'`).collect();
  assert.equal(supEdges.length, 1);
});
```

- [ ] **Step 2: Run test → fail (no module)**

- [ ] **Step 3: Implement skeleton + pass 1**

`src/dream/step-compaction.js`:

```js
import { surql } from 'surrealdb';
import * as store from '../memory/store.js';

const DEFAULT_CONFIG = {
  semantic_threshold: 0.93,
  cluster_max_size: 8,
  dedup_enabled: true,
  archive_enabled: true,
  archive_thresholds: {
    knowledge: { age_days: 360, signal_max: 1 },
    habit:     { age_days: 120, signal_max: 1 },
    thread:    { age_days: 60 },
    prediction:{ resolved_age_days: 730 },
  },
};

async function readConfig(db) {
  const [rows] = await db.query(surql`SELECT value FROM runtime:compaction.config`).collect();
  return rows?.[0]?.value ?? DEFAULT_CONFIG;
}

export async function dreamStepCompaction(db, embedder) {
  const t0 = Date.now();
  const cfg = await readConfig(db);
  const summary = { dedup_clusters: 0, dedup_merged: 0, archived: 0, by_kind: {}, errors: [] };

  if (cfg.dedup_enabled) {
    summary.dedup_merged += await dedupExact(db);
    // pass 2 added in Task 7
  }
  // archive pass added in Tasks 8-9

  summary.duration_ms = Date.now() - t0;
  await db.query(surql`CREATE compaction_telemetry CONTENT ${summary}`).collect();
  return summary;
}

async function dedupExact(db) {
  const [clusters] = await db.query(surql`
    SELECT content_hash, array::group(id) AS ids
    FROM memos
    WHERE kind = 'knowledge' AND content_hash IS NOT NONE
    GROUP BY content_hash
  `).collect();
  let merged = 0;
  for (const c of clusters ?? []) {
    if ((c.ids?.length ?? 0) < 2) continue;
    const [rows] = await db.query(surql`
      SELECT id, signal_count, confidence, derived_at FROM memos
      WHERE id IN ${c.ids}
      ORDER BY (signal_count * confidence) DESC, derived_at ASC
    `).collect();
    const [canonical, ...rest] = rows;
    for (const r of rest) {
      await store.supersede(db, canonical.id, r.id);
      merged++;
    }
  }
  return merged;
}
```

- [ ] **Step 4: Run test → pass**

- [ ] **Step 5: Commit**

```bash
git add src/dream/step-compaction.js tests/unit/step-compaction-dedup.test.js
git commit -m "feat(dream): step-compaction skeleton + dedup pass 1"
```

### Task 7: Dedup pass 2 (semantic via kNN, pairwise to candidate)

**Files:**
- Modify: `src/dream/step-compaction.js`
- Modify: `tests/unit/step-compaction-dedup.test.js`
- Create: `tests/fixtures/compaction-golden.json`

- [ ] **Step 1: Write golden fixture**

`tests/fixtures/compaction-golden.json`:

```json
{
  "semantic_pairs": [
    { "a": "kevin uses chromascope for plugin work", "b": "chromascope is kevin's plugin tool",      "should_merge": true  },
    { "a": "kevin works on robin-assistant",          "b": "kevin's main project is robin",          "should_merge": true  },
    { "a": "kevin's office is on the third floor",    "b": "kevin works from the third-floor office","should_merge": true  },
    { "a": "kevin likes coffee",                       "b": "kevin likes tea",                        "should_merge": false },
    { "a": "kevin works at company A",                 "b": "kevin works at company B",               "should_merge": false },
    { "a": "kevin is 30 years old",                    "b": "kevin's birthday is in march",           "should_merge": false }
  ]
}
```

(Embeddings are stubbed in test — assert based on `should_merge` flag, not real cosines. Real-cosine threshold tuning happens during impl.)

- [ ] **Step 2: Write failing test for semantic dedup + no-transitive guard**

```js
test('dedup pass 2 merges semantic dupes pairwise, no transitive over-merge', async () => {
  const db = await openMemDb();
  // controlled embedder: returns vectors with fixed cosines per content
  const e = controlledEmbedder({
    'A': [1, 0, 0],
    'B': [0.97, 0.243, 0],     // cos(A,B) ≈ 0.97
    'C': [0.84, 0, 0.542],     // cos(B,C) ≈ 0.815; cos(A,C) ≈ 0.84
  });
  await store.note(db, e, 'knowledge', { content: 'A', derived_by: 'manual' });
  await store.note(db, e, 'knowledge', { content: 'B', derived_by: 'manual' });
  await store.note(db, e, 'knowledge', { content: 'C', derived_by: 'manual' });

  const summary = await dreamStepCompaction(db, e);
  // A↔B merge (≥0.93); C stays separate
  assert.equal(summary.dedup_merged, 1);
});
```

- [ ] **Step 3: Run test → fail**

- [ ] **Step 4: Implement pass 2**

Add to `step-compaction.js`:

```js
async function dedupSemantic(db, embedder, cfg) {
  // Iterate unprocessed knowledge memos; for each, kNN; cluster pairwise to candidate
  const [memos] = await db.query(surql`
    SELECT id, content FROM memos
    WHERE kind = 'knowledge'
      AND id NOT IN (SELECT VALUE in FROM edges WHERE kind = 'supersedes')
      AND id NOT IN (SELECT VALUE out FROM edges WHERE kind = 'supersedes')
  `).collect();
  const processed = new Set();
  let merged = 0, clusters = 0;
  for (const m of memos ?? []) {
    if (processed.has(String(m.id))) continue;
    const neighbours = await store.searchMemos(db, embedder, m.content, {
      kind: 'knowledge',
      limit: cfg.cluster_max_size,
    });
    const cluster = [m];
    for (const n of neighbours.hits ?? []) {
      if (String(n.record.id) === String(m.id)) continue;
      if (processed.has(String(n.record.id))) continue;
      if ((1 - (n.distance ?? 1)) < cfg.semantic_threshold) continue;
      cluster.push(n.record);
    }
    if (cluster.length < 2) { processed.add(String(m.id)); continue; }

    // canonical: max signal_count*confidence; tiebreak earliest derived_at
    cluster.sort((a, b) => {
      const sa = (a.signal_count ?? 1) * (a.confidence ?? 0.5);
      const sb = (b.signal_count ?? 1) * (b.confidence ?? 0.5);
      if (sa !== sb) return sb - sa;
      return new Date(a.derived_at) - new Date(b.derived_at);
    });
    const canonical = cluster[0];
    for (const other of cluster.slice(1)) {
      await store.supersede(db, canonical.id, other.id);
      merged++;
      processed.add(String(other.id));
    }
    processed.add(String(canonical.id));
    clusters++;
  }
  return { merged, clusters };
}
```

Call it from `dreamStepCompaction`:

```js
if (cfg.dedup_enabled) {
  summary.dedup_merged += await dedupExact(db);
  const sem = await dedupSemantic(db, embedder, cfg);
  summary.dedup_merged += sem.merged;
  summary.dedup_clusters += sem.clusters;
}
```

- [ ] **Step 5: Run test → pass**

- [ ] **Step 6: Commit**

```bash
git add src/dream/step-compaction.js tests/unit/step-compaction-dedup.test.js tests/fixtures/compaction-golden.json
git commit -m "feat(dream): step-compaction dedup pass 2 (semantic, pairwise)"
```

### Task 8: Archive pass — per-kind eligibility queries

**Files:**
- Modify: `src/dream/step-compaction.js`
- Create: `tests/unit/step-compaction-archive.test.js`

- [ ] **Step 1: Write failing test per kind**

```js
test('archive pass: knowledge eligibility = old + low signal + no derived_from inbound', async () => {
  const db = await openMemDb();
  const e = stubEmbedder();
  // memo aged 400d ago, signal_count=0 → eligible
  const { id: stale } = await store.note(db, e, 'knowledge', { content: 'stale', derived_by: 'manual' });
  await db.query(surql`UPDATE ${stale} SET derived_at = time::now() - 400d, signal_count = 0`).collect();
  // memo aged 400d ago but signal_count=5 → NOT eligible
  const { id: hot } = await store.note(db, e, 'knowledge', { content: 'hot', derived_by: 'manual' });
  await db.query(surql`UPDATE ${hot} SET derived_at = time::now() - 400d, signal_count = 5`).collect();

  const summary = await dreamStepCompaction(db, e);
  assert.equal(summary.archived, 1);
  const [arch] = await db.query('SELECT content FROM archive_memos').collect();
  assert.equal(arch[0].content, 'stale');
});
```

- [ ] **Step 2: Run test → fail**

- [ ] **Step 3: Implement archive pass**

Add to `step-compaction.js`:

```js
import { archiveMemo } from '../memory/archive.js';

async function archivePass(db, cfg) {
  const t = cfg.archive_thresholds;
  const by = { knowledge: 0, habit: 0, thread: 0, prediction: 0 };

  // knowledge
  const [k] = await db.query(surql`
    SELECT id FROM memos
    WHERE kind = 'knowledge'
      AND derived_at < time::now() - ${t.knowledge.age_days}d
      AND signal_count <= ${t.knowledge.signal_max}
      AND count(<-derived_from<-memos) = 0
    LIMIT 200
  `).collect();
  for (const m of k ?? []) { await archiveMemo(db, m.id, 'stale_age'); by.knowledge++; }

  // habit
  const [h] = await db.query(surql`
    SELECT id FROM memos
    WHERE kind = 'habit'
      AND derived_at < time::now() - ${t.habit.age_days}d
      AND signal_count <= ${t.habit.signal_max}
    LIMIT 200
  `).collect();
  for (const m of h ?? []) { await archiveMemo(db, m.id, 'stale_age'); by.habit++; }

  // thread (no episode/arc reference)
  const [th] = await db.query(surql`
    SELECT id FROM memos
    WHERE kind = 'thread'
      AND derived_at < time::now() - ${t.thread.age_days}d
      AND count(meta.episode_ids) = 0
    LIMIT 200
  `).collect();
  for (const m of th ?? []) { await archiveMemo(db, m.id, 'stale_age'); by.thread++; }

  // prediction (resolved only)
  const [p] = await db.query(surql`
    SELECT id FROM memos
    WHERE kind = 'prediction'
      AND meta.resolved_at IS NOT NONE
      AND meta.resolved_at < time::now() - ${t.prediction.resolved_age_days}d
    LIMIT 200
  `).collect();
  for (const m of p ?? []) { await archiveMemo(db, m.id, 'resolved_aged'); by.prediction++; }

  return by;
}
```

And wire into `dreamStepCompaction`:

```js
if (cfg.archive_enabled) {
  summary.by_kind = await archivePass(db, cfg);
  summary.archived = Object.values(summary.by_kind).reduce((a, b) => a + b, 0);
}
```

- [ ] **Step 4: Run test → pass**

- [ ] **Step 5: Commit**

```bash
git add src/dream/step-compaction.js tests/unit/step-compaction-archive.test.js
git commit -m "feat(dream): step-compaction archive pass per-kind"
```

### Task 9: Wire step-compaction into pipeline

**Files:**
- Modify: `src/dream/pipeline.js`

- [ ] **Step 1: Add import + call**

In `pipeline.js`:

```js
import { dreamStepCompaction } from './step-compaction.js';
// …
try {
  summary.compaction = await dreamStepCompaction(db, embedder);
} catch (e) {
  summary.compaction = { error: e.message };
}
```

Place after `dreamStepScopeCleanup`.

- [ ] **Step 2: Run existing dream pipeline test**

Run: `node --test tests/integration/dream-pipeline.test.js`
Expected: passes (new step is fail-soft; no behavior break).

- [ ] **Step 3: Commit**

```bash
git add src/dream/pipeline.js
git commit -m "feat(dream): wire step-compaction after step-scope-cleanup"
```

---

## Phase 4 — CLI commands

### Task 10: `robin memo restore` CLI

**Files:**
- Create: `src/cli/commands/compaction.js`
- Modify: `bin/robin` or wherever commands register
- Create: `tests/integration/compaction-cli.test.js`

- [ ] **Step 1: Write failing test for restore CLI**

```js
test('robin memo restore round-trips a previously archived memo', async () => {
  const { db, run } = await openTempInstance();
  // archive a memo
  const { id } = await store.note(db, stubEmbedder(), 'knowledge', { content: 'x', derived_by: 'manual' });
  await archiveMemo(db, id, 'manual');
  const [arch] = await db.query('SELECT id FROM archive_memos').collect();

  const out = await run(['memo', 'restore', String(arch[0].id)]);
  assert.match(out, /restored/);

  const [hot] = await db.query(`SELECT * FROM memos WHERE content = 'x'`).collect();
  assert.equal(hot.length, 1);
});
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement CLI**

`src/cli/commands/compaction.js`:

```js
import { restoreMemo, archiveMemo } from '../../memory/archive.js';
import { openDb } from '../../db/client.js';

export async function memoRestore(args) {
  const archivedId = args[0];
  if (!archivedId) throw new Error('usage: robin memo restore <id>');
  const db = await openDb();
  await restoreMemo(db, archivedId);
  console.log(`restored ${archivedId}`);
}

export async function compactionConfigGet() {
  const db = await openDb();
  const [rows] = await db.query('SELECT value FROM runtime:compaction.config').collect();
  console.log(JSON.stringify(rows?.[0]?.value ?? {}, null, 2));
}

export async function compactionConfigSet(args) {
  const [key, val] = args;
  if (!key) throw new Error('usage: robin compaction config set <key> <value>');
  const db = await openDb();
  // simple top-level set (no nested path support in v1)
  const parsed = isNaN(Number(val)) ? val : Number(val);
  await db.query(`UPDATE runtime:compaction.config SET value.${key} = ${JSON.stringify(parsed)}`).collect();
  console.log(`set ${key} = ${parsed}`);
}
```

Register in CLI dispatcher (follow existing pattern in `src/cli/commands/*`).

- [ ] **Step 4: Run → pass**

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/compaction.js bin/robin tests/integration/compaction-cli.test.js
git commit -m "feat(cli): robin memo restore + compaction config"
```

### Task 11: `robin memo list --include-archived` flag

**Files:**
- Modify: existing `robin memo list` command (or create if not present)
- Modify: `tests/integration/compaction-cli.test.js`

- [ ] **Step 1: Write failing test**

```js
test('memo list --include-archived unions archive_memos', async () => {
  // seed one hot memo + one archived memo
  // run `robin memo list --include-archived`
  // assert both appear; without flag, only hot appears
});
```

- [ ] **Step 2: Implement flag**

In the memo-list CLI handler:

```js
async function memoList({ includeArchived }) {
  const db = await openDb();
  if (includeArchived) {
    const [hot]  = await db.query('SELECT id, content, kind FROM memos').collect();
    const [arch] = await db.query('SELECT id, content, kind, archived_at FROM archive_memos').collect();
    return [...hot, ...arch];
  }
  const [hot] = await db.query('SELECT id, content, kind FROM memos').collect();
  return hot;
}
```

- [ ] **Step 3: Run → pass**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(cli): memo list --include-archived flag"
```

---

## Phase 5 — Integration test + remaining gates

### Task 12: End-to-end roundtrip integration test

**Files:**
- Create: `tests/integration/step-compaction-roundtrip.test.js`

- [ ] **Step 1: Write the test**

Synthetic 10k-memo fixture; run `dreamStepCompaction`; assert completes in <60s on mem://; verify telemetry row written.

- [ ] **Step 2: Run → pass**

- [ ] **Step 3: Commit**

```bash
git commit -m "test(compaction): full roundtrip integration"
```

### Task 13: Verification gates 1-12 from spec §5

For each gate, write a focused unit test asserting the gate's invariant. List from spec:

1. Dedup pass 1 idempotent
2. Pass 2 finds known semantic dupes (uses golden fixture)
3. No transitive over-merge (Task 7 covers this)
4. Canonical selection deterministic
5. Archive eligibility stable (run twice — same set archived)
6. Archive transaction atomic (inject failure mid-statement, confirm rollback)
7. No double-delete on edges (run on rocksdb, not just mem://)
8. Recall ignores archive
9. Restore round-trips (Task 5 covers this)
10. Telemetry written
11. No graph leak into archive
12. Cost gate (Task 12 covers this)

- [ ] **Step 1-12: One commit per gate**

```bash
git commit -m "test(compaction): gate N <description>"
```

---

## Phase 6 — Docs

### Task 14: Update architecture + faculties docs

**Files:**
- Modify: `docs/architecture.md` — add "Memory lifecycle" section
- Modify: `docs/faculties.md` — extend dream section with step-compaction

- [ ] **Step 1: Edit architecture.md**

Add a section after "Database shape" describing the hot/archive two-tier model, when memos get archived, how to restore.

- [ ] **Step 2: Edit faculties.md**

Add `step-compaction` to the dream-step list with one-paragraph summary.

- [ ] **Step 3: Run docs sanity (manual)**

- [ ] **Step 4: Commit**

```bash
git commit -m "docs(memory): hot/archive tier + step-compaction"
```

---

## Self-review checklist (run before declaring done)

- [ ] All 12 verification gates from spec §5 covered by a test.
- [ ] No placeholders in this plan ("TBD", "TODO", "Similar to…").
- [ ] All file paths exact.
- [ ] Every "if a step changes code, show the code" step shows real code.
- [ ] Type/method names consistent across tasks (`archiveMemo`, `restoreMemo`, `dreamStepCompaction`).
- [ ] Cost-gate test (Task 12) asserts <60s on mem://.

## Final commit

After all phases:

```bash
git push -u origin feat/theme-1a-compaction
gh pr create --title "Theme 1a: Memory compaction & forgetting" --body "$(cat docs/superpowers/specs/2026-05-11-robin-v2-theme-1a-compaction-design.md | head -30)"
```
