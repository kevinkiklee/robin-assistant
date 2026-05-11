# Theme 1b — Episodes + Arcs · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make multi-episode arcs first-class via a new `arcs` table. Add incremental episode summaries (zero LLM cost), recall-targetable arcs (FTS+vector), stale-episode close-out (heartbeat job), and dissolve `kind='thread'` memos into arcs.

**Architecture:** Episodes stay as per-source time-bins. Arcs are a new container layer above them, created by `step-arcs` (renamed from `step-threads`) via entity-set Jaccard dedup. Recall-in-arc is opt-in via new MCP tool. No implicit boost in `rank.score`.

**Tech Stack:** Node.js 18+, SurrealDB 3.0.5, `@surrealdb/node` 3.0.3.

**Spec:** `docs/superpowers/specs/2026-05-11-robin-v2-theme-1b-episodes-arcs-design.md`

**Dependencies:** `feat/surrealdb-improvements` (post-merge edge fields, arrow traversal, FTS analyzers).

---

## File structure

| File | Responsibility |
|---|---|
| `src/schema/migrations/0001-init.surql` | Add `arcs` table, `archive_arcs` (Theme 1a hook), `episodes` field additions, `participates_in` registry update, seed `runtime:arc.config` + `runtime:episode.config` |
| `src/schema/migrations/0002-embeddings-<profile>.surql` | Add `embeddings_<profile>_arcs` per profile |
| `src/memory/arcs.js` (new) | Only writer to `arcs` + `embeddings_<profile>_arcs`; `createArc`, `extendArc`, `searchArcs`, `getArc` |
| `src/memory/edge-registry.js` (modify) | Add `arc_contains`; extend `participates_in.to` |
| `src/memory/kind-registry.js` (modify) | Remove `thread` kind |
| `src/memory/narrative.js` (rewrite) | `add()` now writes arcs (not thread memos) |
| `src/memory/store.js` (modify) | Add `searchArcs`, `searchEpisodes`; FTS-only for episodes |
| `src/capture/biographer.js` (modify) | Per-event `last_event_at` + `summary_log` update |
| `src/dream/step-arcs.js` (rename from `step-threads.js`) | Cluster-by-entities; Jaccard dedup; create/extend arcs |
| `src/dream/pipeline.js` (modify) | Replace `step-threads` import with `step-arcs` |
| `src/jobs/internal/close-stale-episodes.js` (new) | Heartbeat job impl |
| `src/jobs/builtin/close-stale-episodes.md` (new) | Job manifest (every 10 min) |
| `src/mcp/tools/list-arcs.js`, `get-arc.js`, `recall-in-arc.js`, `recall-in-episode.js` (new) | MCP surface |
| `src/mcp/tools/list-threads.js` (delete) | replaced |
| `src/daemon/server.js` (modify) | Register new MCP tools; remove `list-threads` |
| `tests/unit/arcs-lifecycle.test.js` (new) | Active→paused→closed transitions |
| `tests/unit/step-arcs-dedup.test.js` (new) | Jaccard merge vs fork |
| `tests/unit/close-stale-episodes.test.js` (new) | Per-source idle thresholds |
| `tests/integration/arc-recall.test.js` (new) | recall_in_arc end-to-end |

---

## Phase 1 — Schema additions

### Task 1: arcs table + indexes

**Files:** `src/schema/migrations/0001-init.surql`

- [ ] **Step 1: Append arcs DDL**

```surql
DEFINE TABLE arcs SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name             ON arcs TYPE option<string>;
DEFINE FIELD summary           ON arcs TYPE option<string>;
DEFINE FIELD started_at        ON arcs TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD last_activity_at  ON arcs TYPE datetime DEFAULT time::now();
DEFINE FIELD ended_at          ON arcs TYPE option<datetime>;
DEFINE FIELD status            ON arcs TYPE string DEFAULT 'active';
DEFINE FIELD scope             ON arcs TYPE string DEFAULT 'global';
DEFINE FIELD tags              ON arcs TYPE array<string> DEFAULT [];
DEFINE FIELD entity_ids        ON arcs TYPE array<record<entities>> DEFAULT [];
DEFINE FIELD meta              ON arcs TYPE option<object> FLEXIBLE;
DEFINE INDEX arcs_status        ON arcs FIELDS status;
DEFINE INDEX arcs_last_activity ON arcs FIELDS last_activity_at;
DEFINE INDEX arcs_name_fts      ON arcs FIELDS name    FULLTEXT ANALYZER english BM25 HIGHLIGHTS;
DEFINE INDEX arcs_summary_fts   ON arcs FIELDS summary FULLTEXT ANALYZER english BM25 HIGHLIGHTS;
```

- [ ] **Step 2: Run migration**

Run: `node scripts/migrate-fresh.mjs --target mem`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/schema/migrations/0001-init.surql
git commit -m "feat(schema): add arcs table"
```

### Task 2: episodes additions + arc_contains edge support

**Files:** `src/schema/migrations/0001-init.surql`, `src/memory/edge-registry.js`

- [ ] **Step 1: Append to migration**

```surql
DEFINE FIELD last_event_at ON episodes TYPE option<datetime>;
DEFINE FIELD summary_log   ON episodes TYPE array<string> DEFAULT [];
DEFINE INDEX episodes_last_event_at ON episodes FIELDS last_event_at;
```

- [ ] **Step 2: Update edge registry**

In `src/memory/edge-registry.js`:

```js
arc_contains:    { from: ['arcs'],     to: ['episodes'] },
participates_in: { from: ['entities'], to: ['entities', 'episodes', 'arcs'] },  // extend `to`
```

- [ ] **Step 3: Write registry test**

```js
test('arc_contains edge accepted; participates_in extended to arcs', async () => {
  const db = await openMemDb();
  const e = stubEmbedder();
  const arc = await createArc(db, e, { name: 'test', entity_ids: [] });
  const { id: epId } = await createEpisode(db, { source: 'manual' });
  await store.relate(db, arc.id, epId, 'arc_contains');
  const [edges] = await db.query(`SELECT * FROM edges WHERE kind='arc_contains'`).collect();
  assert.equal(edges.length, 1);
});
```

- [ ] **Step 4: Run → pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(schema,registry): episode fields + arc_contains edge"
```

### Task 3: archive_arcs table (Theme 1a hook)

**Files:** `src/schema/migrations/0001-init.surql`

- [ ] **Step 1: Append**

```surql
DEFINE TABLE archive_arcs SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name              ON archive_arcs TYPE option<string>;
DEFINE FIELD summary           ON archive_arcs TYPE option<string>;
DEFINE FIELD started_at        ON archive_arcs TYPE datetime;
DEFINE FIELD ended_at          ON archive_arcs TYPE option<datetime>;
DEFINE FIELD entity_ids        ON archive_arcs TYPE array<record<entities>> DEFAULT [];
DEFINE FIELD meta              ON archive_arcs TYPE option<object> FLEXIBLE;
DEFINE FIELD archived_at       ON archive_arcs TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD archive_reason    ON archive_arcs TYPE string;
DEFINE INDEX archive_arcs_archived_at ON archive_arcs FIELDS archived_at;
```

- [ ] **Step 2: Run + commit**

```bash
git commit -m "feat(schema): archive_arcs (Theme 1a hook)"
```

### Task 4: embeddings_<profile>_arcs per active profile

**Files:** `src/schema/migrations/0002-embeddings-<profile>.surql` (each profile variant)

- [ ] **Step 1: Append per profile**

For each `0002-embeddings-{mxbai_1024,gemini_3072,qwen3_4096}.surql`:

```surql
DEFINE TABLE embeddings_<profile>_arcs SCHEMAFULL TYPE NORMAL;
DEFINE FIELD record ON embeddings_<profile>_arcs TYPE record<arcs>;
DEFINE FIELD vector ON embeddings_<profile>_arcs TYPE array<float> ASSERT array::len($value) = <dim>;
DEFINE FIELD ts     ON embeddings_<profile>_arcs TYPE datetime DEFAULT time::now();
DEFINE INDEX embeddings_<profile>_arcs_record ON embeddings_<profile>_arcs FIELDS record UNIQUE;
DEFINE INDEX embeddings_<profile>_arcs_vec    ON embeddings_<profile>_arcs FIELDS vector
  HNSW DIMENSION <dim> DIST COSINE TYPE F32 EFC 200 M 16;
```

Substitute the actual profile name + dimension for each file.

- [ ] **Step 2: Verify per-profile DDLs apply**

Run: `node scripts/verify-hnsw-plan.mjs` (existing) — should now include arcs surface.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(schema): per-profile embeddings_<profile>_arcs"
```

### Task 5: Remove `thread` kind, seed configs

**Files:** `src/memory/kind-registry.js`, `src/schema/migrations/0001-init.surql`

- [ ] **Step 1: Remove kind**

In `kind-registry.js`, delete the `thread:` entry from `MEMO_KIND_REGISTRY`.

- [ ] **Step 2: Seed configs**

Append to migration:

```surql
UPSERT runtime:arc.config CONTENT {
  value: {
    auto_create_enabled: true,
    min_episodes: 2,
    min_shared_entities: 3,
    dedup_jaccard_threshold: 0.7,
    pause_after_idle_days: 14,
    close_after_idle_days: 60,
    name_derive_from_top_n_entities: 3
  }
};

UPSERT runtime:episode.config CONTENT {
  value: {
    summary_log_size: 20,
    idle_minutes_by_source: {
      "claude-code": 360,
      "gemini": 360,
      "integration": 1440,
      "default": 720
    }
  }
};
```

- [ ] **Step 3: Audit test for removed kind**

```js
test('kind=thread rejected', () => {
  assert.throws(() => validateMemoKind('thread'));
});
```

- [ ] **Step 4: Run → pass; commit**

```bash
git commit -m "feat(registry,schema): drop kind=thread; seed arc+episode configs"
```

---

## Phase 2 — `src/memory/arcs.js`

### Task 6: createArc + searchArcs

**Files:** `src/memory/arcs.js`, `tests/unit/arcs-lifecycle.test.js`

- [ ] **Step 1: Failing test for createArc**

```js
test('createArc inserts row, embeds summary, returns id', async () => {
  const db = await openMemDb();
  const e = stubEmbedder();
  const { id } = await createArc(db, e, {
    name: 'chromascope',
    summary: 'project arc',
    entity_ids: [],
  });
  const [rows] = await db.query(`SELECT * FROM ${id}`).collect();
  assert.equal(rows[0].name, 'chromascope');
  // embedding row exists in active profile's arcs table
  const profile = await getActiveProfile(db);
  const [emb] = await db.query(`SELECT * FROM embeddings_${profile}_arcs WHERE record = ${id}`).collect();
  assert.equal(emb.length, 1);
});
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement**

`src/memory/arcs.js`:

```js
import { surql } from 'surrealdb';
import { activeProfile, embeddingTable } from '../embed/profile-router.js';

export async function createArc(db, embedder, { name, summary, entity_ids = [], tags = [], meta }) {
  const [rows] = await db.query(surql`
    CREATE arcs CONTENT ${{ name, summary, entity_ids, tags, meta }}
  `).collect();
  const id = rows[0].id;
  if (summary) {
    const vector = await embedder.embed(summary);
    const profile = await activeProfile(db);
    const tbl = embeddingTable(profile, 'arcs');
    await db.query(surql`
      CREATE ${tbl} CONTENT ${{ record: id, vector: Array.from(vector) }}
    `).collect();
  }
  return { id };
}

export async function getArc(db, id) {
  const [rows] = await db.query(surql`
    SELECT *,
      (SELECT VALUE out FROM edges WHERE kind = 'arc_contains' AND in = ${id}) AS episode_ids
    FROM ONLY ${id}
  `).collect();
  return rows[0];
}

export async function searchArcs(db, embedder, query, { status, limit = 10 } = {}) {
  // Hybrid BM25 + vector — leans on Theme 0 (feat/surrealdb-improvements) plumbing
  const filters = [];
  const bindings = { q: query, limit };
  if (status) { filters.push('status = $status'); bindings.status = status; }
  // BM25 path
  const [bm25] = await db.query(surql`
    SELECT id, name, summary, search::score(0) AS bm25
    FROM arcs WITH INDEX arcs_summary_fts
    WHERE summary @0@ $q ${filters.length ? 'AND ' + filters.join(' AND ') : ''}
    ORDER BY bm25 DESC LIMIT $limit
  `, bindings).collect();
  // Vector path
  const profile = await activeProfile(db);
  const tbl = embeddingTable(profile, 'arcs');
  const qvec = Array.from(await embedder.embed(query));
  const [knn] = await db.query(surql`
    SELECT record, vector::distance::knn() AS dist FROM ${tbl}
    WHERE vector <|$k, $ef|> $qvec ORDER BY dist LIMIT $k
  `, { k: limit, ef: limit * 4, qvec }).collect();
  // RRF fuse — reuse src/recall/fusion.js from feat/surrealdb-improvements
  return fuseAndHydrate(db, [bm25, knn]);
}
```

- [ ] **Step 4: Run → pass; commit**

```bash
git commit -m "feat(memory): arcs.js with createArc + searchArcs"
```

### Task 7: extendArc with Jaccard match

**Files:** `src/memory/arcs.js`, `tests/unit/arcs-lifecycle.test.js`

- [ ] **Step 1: Failing test for extendArc Jaccard**

```js
test('extendArc merges into existing when entity Jaccard >= threshold', async () => {
  const db = await openMemDb();
  const e = stubEmbedder();
  const ents = await Promise.all(['a','b','c'].map(n => store.upsertEntity(db, e, { name: n, type: 'thing' })));
  const arc = await createArc(db, e, { name: 'x', entity_ids: [ents[0].id, ents[1].id] });
  const ext = await extendArc(db, arc.id, { entity_ids: [ents[1].id, ents[2].id] });
  // Jaccard({a,b}, {b,c}) = 1/3 = 0.33 < 0.7 default → returns null (no merge)
  assert.equal(ext, null);
});
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement**

```js
export function jaccard(a, b) {
  const A = new Set(a.map(String));
  const B = new Set(b.map(String));
  const inter = [...A].filter(x => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 0 : inter / union;
}

export async function extendArc(db, arcId, { entity_ids, episode_ids = [] }) {
  const [rows] = await db.query(surql`SELECT * FROM ONLY ${arcId}`).collect();
  const arc = rows[0];
  if (!arc) return null;
  const cfg = await readArcConfig(db);
  if (jaccard(arc.entity_ids, entity_ids) < cfg.dedup_jaccard_threshold) return null;
  // merge entity_ids, advance last_activity_at, reactivate if paused
  const merged = [...new Set([...arc.entity_ids.map(String), ...entity_ids.map(String)])];
  await db.query(surql`
    UPDATE ${arcId} SET
      entity_ids = ${merged},
      last_activity_at = time::now(),
      status = IF status = 'paused' THEN 'active' ELSE status END
  `).collect();
  for (const epId of episode_ids) {
    await store.relate(db, arcId, epId, 'arc_contains');
  }
  return arc;
}
```

- [ ] **Step 4: Run → pass; commit**

```bash
git commit -m "feat(memory): arc Jaccard dedup + extension"
```

---

## Phase 3 — Episode lifecycle

### Task 8: Biographer writes `last_event_at` + `summary_log`

**Files:** `src/capture/biographer.js`, `tests/unit/biographer-episode-update.test.js`

- [ ] **Step 1: Failing test**

```js
test('biographer updates episode last_event_at + summary_log per event', async () => {
  // … seed event, run biographer, assert ep.last_event_at and summary_log length
});
```

- [ ] **Step 2: Implement in biographer**

After existing episode-id determination, add:

```js
const preview = (event.content ?? '').slice(0, 80);
await db.query(surql`
  UPDATE ${episodeId} SET
    last_event_at = ${eventTs},
    summary_log = array::slice(array::insert(summary_log, ${preview}, 0), 0, 20)
`).collect();
```

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "feat(biographer): per-event last_event_at + summary_log"
```

### Task 9: closeStaleEpisodes heartbeat job

**Files:** `src/jobs/internal/close-stale-episodes.js`, `src/jobs/builtin/close-stale-episodes.md`, `tests/unit/close-stale-episodes.test.js`

- [ ] **Step 1: Failing test**

```js
test('closeStaleEpisodes closes idle but not active episodes', async () => {
  const db = await openMemDb();
  const ep1 = await createEpisode(db, { source: 'claude-code' });
  await db.query(surql`UPDATE ${ep1.id} SET last_event_at = time::now() - 7h`).collect();
  const ep2 = await createEpisode(db, { source: 'claude-code' });
  await db.query(surql`UPDATE ${ep2.id} SET last_event_at = time::now() - 1h`).collect();

  await closeStaleEpisodes(db);

  const [r1] = await db.query(`SELECT * FROM ${ep1.id}`).collect();
  const [r2] = await db.query(`SELECT * FROM ${ep2.id}`).collect();
  assert.ok(r1[0].ended_at);
  assert.equal(r2[0].ended_at, null);
});
```

- [ ] **Step 2: Implement**

```js
export async function closeStaleEpisodes(db) {
  const cfg = await readEpisodeConfig(db);
  const map = cfg.idle_minutes_by_source;
  for (const [source, minutes] of Object.entries(map)) {
    if (source === 'default') continue;
    await db.query(surql`
      UPDATE episodes SET ended_at = time::now()
      WHERE ended_at IS NONE
        AND source = ${source}
        AND last_event_at < time::now() - ${minutes}m
    `).collect();
  }
  // default for unmatched sources
  await db.query(surql`
    UPDATE episodes SET ended_at = time::now()
    WHERE ended_at IS NONE
      AND source NOT IN ${Object.keys(map).filter(k => k !== 'default')}
      AND last_event_at < time::now() - ${map.default}m
  `).collect();
}
```

- [ ] **Step 3: Add manifest** `src/jobs/builtin/close-stale-episodes.md`

```md
---
name: close-stale-episodes
schedule: "*/10 * * * *"
runtime: internal
catch_up: false
---
```

- [ ] **Step 4: Run + commit**

```bash
git commit -m "feat(jobs): close-stale-episodes heartbeat job"
```

---

## Phase 4 — `step-arcs` (rename + rewrite)

### Task 10: Rename step-threads → step-arcs; write to arcs table

**Files:** `src/dream/step-arcs.js` (rename + rewrite), `src/dream/pipeline.js`, `src/memory/narrative.js`, `tests/unit/step-arcs-dedup.test.js`

- [ ] **Step 1: Rename file**

```bash
git mv src/dream/step-threads.js src/dream/step-arcs.js
```

- [ ] **Step 2: Failing test**

```js
test('step-arcs creates arc from clustered episodes; rerun extends not duplicates', async () => {
  // seed 2 episodes sharing 3+ entities
  // run step-arcs → 1 arc created
  // rerun → no new arc; entity_ids extended, last_activity_at advanced
});
```

- [ ] **Step 3: Implement step-arcs**

```js
import { surql } from 'surrealdb';
import { createArc, extendArc } from '../memory/arcs.js';
import * as store from '../memory/store.js';

export async function dreamStepArcs(db, embedder, host) {
  const cfg = await readArcConfig(db);
  // 1. recently closed episodes
  const [eps] = await db.query(surql`
    SELECT id, source, started_at, ended_at FROM episodes
    WHERE ended_at >= time::now() - 7d
  `).collect();
  // 2. cluster by participating entities (uses participates_in edges + mentions edges via biographer)
  const clusters = await clusterEpisodesByEntities(db, eps, cfg);
  // 3. for each cluster ≥ min_episodes, dedup-or-create
  let created = 0, extended = 0;
  for (const c of clusters) {
    if (c.episodes.length < cfg.min_episodes) continue;
    // attempt extend on any active/paused arc whose Jaccard with our entity set ≥ threshold
    const [candidates] = await db.query(surql`
      SELECT id, entity_ids FROM arcs WHERE status IN ['active','paused']
    `).collect();
    let chosen = null;
    let bestJ = 0;
    for (const a of candidates ?? []) {
      const j = jaccard(a.entity_ids, c.entity_ids);
      if (j >= cfg.dedup_jaccard_threshold && j > bestJ) { chosen = a; bestJ = j; }
    }
    if (chosen) {
      await extendArc(db, chosen.id, { entity_ids: c.entity_ids, episode_ids: c.episodes.map(e => e.id) });
      extended++;
    } else {
      const name = await deriveArcName(c.entity_ids.slice(0, cfg.name_derive_from_top_n_entities), db);
      const summary = await summarizeArc(host, c.episodes);  // one LLM call
      const arc = await createArc(db, embedder, { name, summary, entity_ids: c.entity_ids });
      for (const ep of c.episodes) await store.relate(db, arc.id, ep.id, 'arc_contains');
      created++;
    }
  }
  // 4. state transitions
  await db.query(surql`
    UPDATE arcs SET status = 'paused'
    WHERE status = 'active' AND last_activity_at < time::now() - ${cfg.pause_after_idle_days}d
  `).collect();
  await db.query(surql`
    UPDATE arcs SET status = 'closed', ended_at = time::now()
    WHERE status = 'paused' AND last_activity_at < time::now() - ${cfg.close_after_idle_days}d
  `).collect();
  return { created, extended };
}
```

(Helper functions `clusterEpisodesByEntities`, `deriveArcName`, `summarizeArc` defined in same file — full bodies in the impl session.)

- [ ] **Step 4: Update pipeline.js import**

In `pipeline.js`: replace `dreamStepThreads` import + call with `dreamStepArcs`.

- [ ] **Step 5: Rewrite narrative.js**

```js
import { createArc, extendArc, searchArcs } from './arcs.js';
export const add = (db, embedder, input) => createArc(db, embedder, input);
export const search = searchArcs;
```

- [ ] **Step 6: Run tests + commit**

```bash
git commit -m "feat(dream): step-arcs replaces step-threads; arcs first-class"
```

---

## Phase 5 — MCP tools

### Task 11: list_arcs, get_arc

**Files:** `src/mcp/tools/list-arcs.js`, `get-arc.js`, `src/daemon/server.js`, tests

- [ ] **Step 1: Failing test**

```js
test('list_arcs returns active arcs ordered by last_activity_at DESC', async () => {
  // seed 3 arcs
  // call handler
  // assert order + count
});
```

- [ ] **Step 2: Implement** (factory pattern matching existing tools)

```js
export function createListArcsTool({ db }) {
  return {
    name: 'list_arcs',
    description: 'List arcs (multi-episode arcs of activity).',
    inputSchema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'integer', default: 20 } } },
    async handler({ status, limit = 20 }) {
      const filter = status ? `WHERE status = '${status}'` : '';
      const [rows] = await db.query(`SELECT * FROM arcs ${filter} ORDER BY last_activity_at DESC LIMIT ${limit}`).collect();
      return { arcs: rows };
    },
  };
}
```

`get_arc` analogous, returns arc + member episodes + entities.

- [ ] **Step 3: Register in `daemon/server.js`** + remove `list-threads`

- [ ] **Step 4: Run → pass; commit**

```bash
git commit -m "feat(mcp): list_arcs + get_arc; remove list-threads"
```

### Task 12: recall_in_arc, recall_in_episode

**Files:** `src/mcp/tools/recall-in-arc.js`, `recall-in-episode.js`, `src/memory/store.js`, `tests/integration/arc-recall.test.js`

- [ ] **Step 1: Add `searchEpisodes` helper in `store.js`**

```js
export async function searchEpisodes(db, query, { limit = 10 } = {}) {
  const [rows] = await db.query(surql`
    SELECT id, source, summary, search::score(0) AS bm25
    FROM episodes WITH INDEX episodes_summary_fts
    WHERE summary @0@ ${query}
    ORDER BY bm25 DESC LIMIT ${limit}
  `).collect();
  return { hits: rows };
}
```

(Note: requires adding `episodes_summary_fts` index in Task 2 if not already.)

- [ ] **Step 2: Implement recall_in_arc**

```js
export function createRecallInArcTool({ db, embedder }) {
  return {
    name: 'recall_in_arc',
    description: 'Hybrid recall over events belonging to an arc.',
    inputSchema: { type: 'object', properties: { arc_id: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer', default: 10 } }, required: ['arc_id','query'] },
    async handler({ arc_id, query, limit = 10 }) {
      // 1. fetch member episode ids via arc_contains arrow traversal
      const [eps] = await db.query(surql`
        SELECT VALUE out FROM edges WHERE kind = 'arc_contains' AND in = ${arc_id}
      `).collect();
      if (!eps?.length) return { hits: [] };
      // 2. scoped recall on events
      const hits = await store.searchEvents(db, embedder, query, { episode_ids: eps, limit });
      return hits;
    },
  };
}
```

`recall_in_episode` analogous.

- [ ] **Step 3: Run tests + commit**

```bash
git commit -m "feat(mcp): recall_in_arc + recall_in_episode"
```

---

## Phase 6 — Tests, gates, docs

### Task 13: Verification gates 1–14

For each gate from spec §8:

1. Arc auto-creation idempotent
2. Jaccard dedup correct
3. arc_contains composite IDs
4. Stale episode sweep selective
5. Per-source idle thresholds applied
6. Arc state transitions match thresholds
7. recall_in_arc correctness
8. recall_in_episode correctness
9. kind=thread rejected
10. Embedding parity
11. Cascade-delete safety
12. Theme 1a archive eligibility (test against archive pass)
13. summary_log bounded
14. participates_in polymorphic

One commit per gate test.

### Task 14: Docs update

**Files:** `docs/architecture.md`, `docs/faculties.md`

Add "Arcs" section to architecture; rewrite narrative section in faculties.

```bash
git commit -m "docs(arcs): architecture + faculties updates"
```

---

## Self-review

- [ ] 14 gates from spec §8 covered.
- [ ] No "TBD" placeholders.
- [ ] `createArc`, `extendArc`, `searchArcs`, `searchEpisodes` referenced consistently.
- [ ] `dreamStepArcs` name used throughout.
- [ ] kind=thread audit test passes.

## Final commit

```bash
git push -u origin feat/theme-1b-episodes-arcs
gh pr create --title "Theme 1b: Episodes + Arcs"
```
