# Phase 4c — Knowledge Ops MCP Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship three agent-callable MCP tools — `ingest`, `lint`, `audit` — for memory hygiene over the existing knowledge/entities/edges schema.

**Architecture:** Each tool is a single factory in `src/mcp/tools/`. Shared helpers live in `src/jobs/` (resolver, lint checks, audit prompt). Daemon registers the tools + adds three `/internal/knowledge/*` POST endpoints. CLI dispatches to the endpoints via the existing `daemon-request.js`. No schema migration.

**Tech Stack:** Node 22+, SurrealDB v3, biome, node:test.

**Spec:** `docs/superpowers/specs/2026-05-10-robin-v2-phase-4c-knowledge-ops-design.md` (commit `6da0eeb`).

**Coordination note (CRITICAL for every subagent):**
- Avoid Phase 4f territory: `src/capture/`, `src/hooks/handlers/`, `src/daemon/sessions.js`, `runtime_sessions`, `runtime_auto_recall_telemetry`, `src/cli/commands/biographer-*`.
- **A renaming pass is in flight in the working tree** affecting hooks, dream, daemon, install, schema migration files (tamper-check→introspection, bash-policy→discretion, auto-recall→intuition, step-corrections→step-reflection). DO NOT stage or modify any of those files. Only stage files you authored as part of your task by **explicit path**. Never `git add -A` or `git add .`.

---

## File map

**New:**
```
src/jobs/ingest-resolver.js
src/jobs/ingest-prompt.js
src/jobs/lint-checks.js
src/jobs/audit-prompt.js
src/mcp/tools/ingest.js
src/mcp/tools/lint.js
src/mcp/tools/audit.js
src/cli/commands/ingest.js
src/cli/commands/lint.js
src/cli/commands/audit.js
tests/unit/ingest-resolver.test.js
tests/unit/ingest.test.js
tests/unit/lint-checks.test.js
tests/unit/lint.test.js
tests/unit/audit.test.js
tests/unit/agents-md-knowledge-ops.test.js
tests/unit/knowledge-cli.test.js
tests/integration/knowledge-ops-roundtrip.test.js
```

**Modified (additive only):**
```
src/cli/index.js                  # add 3 dispatcher branches
src/daemon/server.js              # add 3 tool factory registrations + 3 /internal endpoints
src/install/agents-md.js          # add knowledge-ops section
```

---

## Task 1: `ingest-resolver` helper

**Files:**
- Create: `src/jobs/ingest-resolver.js`
- Test: `tests/unit/ingest-resolver.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/unit/ingest-resolver.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { resolveOrCreateEntity } from '../../src/jobs/ingest-resolver.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return { db, embedder: createStubEmbedder({ dimension: 1024 }) };
}

test('resolveOrCreateEntity — exact name+type match returns existing', async () => {
  const { db, embedder } = await fresh();
  const created = await resolveOrCreateEntity(db, embedder, {
    name: 'Acme', type: 'project',
  });
  const reused = await resolveOrCreateEntity(db, embedder, {
    name: 'acme', type: 'project',   // different case but name_lower matches
  });
  assert.equal(String(created), String(reused));
  await close(db);
});

test('resolveOrCreateEntity — alias-as-name match returns existing', async () => {
  const { db, embedder } = await fresh();
  const first = await resolveOrCreateEntity(db, embedder, {
    name: 'Acme Corp', type: 'project', aliases: ['Acme', 'AC'],
  });
  // Subsequent ingest sees just 'Acme' — match via alias-as-name
  const second = await resolveOrCreateEntity(db, embedder, {
    name: 'Acme', type: 'project',
  });
  // The alias 'Acme' was stored in meta on the first entity
  // BUT the resolver matches by name_lower against existing entities' names
  // not against meta.aliases. To match by alias, the resolver tries each
  // alias as a name lookup — so the second call where aliases:['Acme Corp']
  // would match. With name='Acme' and no aliases, second call CREATES a new
  // entity. This test verifies the alias-as-name codepath instead:
  const third = await resolveOrCreateEntity(db, embedder, {
    name: 'New Brand', type: 'project', aliases: ['Acme'],
  });
  // 'Acme' exists from second call → alias match → reuse second
  assert.equal(String(third), String(second));
  assert.notEqual(String(first), String(second));
  await close(db);
});

test('resolveOrCreateEntity — creates new when no match', async () => {
  const { db, embedder } = await fresh();
  const id = await resolveOrCreateEntity(db, embedder, {
    name: 'NewThing', type: 'thing',
  });
  const [[row]] = await db.query(`SELECT * FROM ${id}`).collect();
  assert.equal(row.name, 'NewThing');
  assert.equal(row.type, 'thing');
  assert.equal(row.meta?.aliases?.length ?? 0, 0);
  await close(db);
});

test('resolveOrCreateEntity — preserves aliases in meta on create', async () => {
  const { db, embedder } = await fresh();
  const id = await resolveOrCreateEntity(db, embedder, {
    name: 'BigCo', type: 'project', aliases: ['BC', 'Big'],
  });
  const [[row]] = await db.query(`SELECT * FROM ${id}`).collect();
  assert.deepEqual(row.meta.aliases.sort(), ['BC', 'Big'].sort());
  await close(db);
});

test('resolveOrCreateEntity — different type → different entity', async () => {
  const { db, embedder } = await fresh();
  const proj = await resolveOrCreateEntity(db, embedder, { name: 'Mercury', type: 'project' });
  const place = await resolveOrCreateEntity(db, embedder, { name: 'Mercury', type: 'place' });
  assert.notEqual(String(proj), String(place));
  await close(db);
});
```

- [ ] **Step 2: Run — fail (Cannot find module)**
```
node --test --test-force-exit tests/unit/ingest-resolver.test.js
```

- [ ] **Step 3: Implement**

```js
// src/jobs/ingest-resolver.js
import { surql } from 'surrealdb';

async function findByNameLower(db, name, type) {
  const [rows] = await db
    .query(
      surql`SELECT id, meta FROM entities WHERE name_lower = ${name.toLowerCase()} AND type = ${type} LIMIT 1`,
    )
    .collect();
  return rows?.[0] ?? null;
}

export async function resolveOrCreateEntity(db, embedder, { name, type, aliases = [] }) {
  // 1. Exact name match (composite index entities_name_lower covers this).
  const exact = await findByNameLower(db, name, type);
  if (exact) return exact.id;

  // 2. Alias-as-name match — each alias tried as a name lookup.
  for (const alias of aliases) {
    if (!alias || alias === name) continue;
    const hit = await findByNameLower(db, alias, type);
    if (hit) return hit.id;
  }

  // 3. Create new entity. Aliases preserved in meta for future passes.
  const embedding = await embedder.embed(name);
  const [rows] = await db
    .query(
      surql`CREATE entities CONTENT ${{
        name,
        type,
        embedding,
        meta: { aliases: aliases.filter((a) => a && a !== name) },
      }}`,
    )
    .collect();
  return rows[0].id;
}
```

- [ ] **Step 4: Run — pass**
```
node --test --test-force-exit tests/unit/ingest-resolver.test.js
```

- [ ] **Step 5: Lint + commit (explicit paths only)**
```
npm run lint
git add src/jobs/ingest-resolver.js tests/unit/ingest-resolver.test.js
git commit -m "feat(4c): ingest-resolver — resolveOrCreateEntity (name+alias matching)"
```

---

## Task 2: `lint-checks` helper

**Files:**
- Create: `src/jobs/lint-checks.js`
- Test: `tests/unit/lint-checks.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/unit/lint-checks.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { runLintChecks } from '../../src/jobs/lint-checks.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return { db, embedder: createStubEmbedder({ dimension: 1024 }) };
}

test('orphan_entity — entity with no inbound edges is flagged', async () => {
  const { db, embedder } = await fresh();
  const emb = await embedder.embed('orphan');
  await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Orphan', type: 'thing', embedding: emb }}`)
    .collect();
  const issues = await runLintChecks(db);
  assert.ok(issues.some((i) => i.kind === 'orphan_entity'));
});

test('duplicate_entity — same name+type creates a duplicate-alias issue', async () => {
  const { db, embedder } = await fresh();
  const emb = await embedder.embed('dup');
  await db.query(surql`CREATE entities CONTENT ${{ name: 'X', type: 'thing', embedding: emb }}`).collect();
  await db.query(surql`CREATE entities CONTENT ${{ name: 'x', type: 'thing', embedding: emb }}`).collect();
  const issues = await runLintChecks(db);
  assert.ok(issues.some((i) => i.kind === 'duplicate_entity'));
});

test('stale_knowledge — low confidence + old triggers stale', async () => {
  const { db, embedder } = await fresh();
  const emb = await embedder.embed('stale');
  const long_ago = new Date(Date.now() - 60 * 86_400_000);
  await db
    .query(
      surql`CREATE knowledge CONTENT ${{
        content: 'old stale claim',
        content_hash: 'h1',
        confidence: 0.1,
        source_events: [],
        source_episodes: [],
        embedding: emb,
      }}`,
    )
    .collect();
  // Backdate updated_at (SurrealDB VALUE clause sets it on every UPDATE,
  // so we have to write directly with no UPDATE)
  await db.query(`UPDATE knowledge SET updated_at = '${long_ago.toISOString()}' RETURN BEFORE`).collect();
  const issues = await runLintChecks(db);
  assert.ok(issues.some((i) => i.kind === 'stale_knowledge'));
});

test('runLintChecks — issues sorted severity desc, kind asc, ref asc', async () => {
  const { db, embedder } = await fresh();
  const emb = await embedder.embed('a');
  await db.query(surql`CREATE entities CONTENT ${{ name: 'A', type: 'thing', embedding: emb }}`).collect();
  await db.query(surql`CREATE entities CONTENT ${{ name: 'B', type: 'thing', embedding: emb }}`).collect();
  const issues = await runLintChecks(db);
  // Both are orphans; severity 4 each
  assert.ok(issues.every((i) => typeof i.severity === 'number'));
  for (let i = 1; i < issues.length; i++) {
    assert.ok(issues[i - 1].severity >= issues[i].severity);
  }
});
```

(Plus the `surql` import at the top of the test file: `import { surql } from 'surrealdb';`)

- [ ] **Step 2: Run — fail**
```
node --test --test-force-exit tests/unit/lint-checks.test.js
```

- [ ] **Step 3: Implement**

```js
// src/jobs/lint-checks.js
// Mechanical health checks over knowledge/entities/edges. No LLM.
// IMPORTANT: when adding a new edge table to the schema, add it to
// EDGE_TABLES below — orphan + dead-edge checks walk this list.
import { surql } from 'surrealdb';

const EDGE_TABLES = ['mentions', 'about', 'precedes', 'works_on', 'participates_in', 'co_occurs_with'];

const SEVERITY = {
  dead_edge: 5,
  orphan_entity: 4,
  duplicate_entity: 3,
  near_duplicate_knowledge: 2,
  stale_knowledge: 1,
};

async function checkOrphanEntities(db) {
  const issues = [];
  const [entities] = await db.query(surql`SELECT id, name, type FROM entities`).collect();
  for (const ent of entities ?? []) {
    let hasInbound = false;
    for (const edgeTable of EDGE_TABLES) {
      const [[row]] = await db
        .query(`SELECT count() AS n FROM ${edgeTable} WHERE out = ${String(ent.id)} GROUP ALL`)
        .collect();
      if ((row?.n ?? 0) > 0) {
        hasInbound = true;
        break;
      }
    }
    if (!hasInbound) {
      issues.push({
        kind: 'orphan_entity',
        severity: SEVERITY.orphan_entity,
        ref: String(ent.id),
        message: `entity '${ent.name}' (${ent.type}) has no inbound edges`,
      });
    }
  }
  return issues;
}

async function checkDuplicateEntities(db) {
  const [rows] = await db
    .query(
      surql`SELECT name_lower, type, array::group(id) AS ids, count() AS n
            FROM entities GROUP BY name_lower, type HAVING n > 1`,
    )
    .collect();
  return (rows ?? []).map((r) => ({
    kind: 'duplicate_entity',
    severity: SEVERITY.duplicate_entity,
    ref: r.ids.map(String).sort().join(','),
    message: `entity name '${r.name_lower}' (${r.type}) appears ${r.n} times`,
  }));
}

async function checkStaleKnowledge(db) {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const [rows] = await db
    .query(
      surql`SELECT id, content FROM knowledge WHERE confidence < 0.3 AND updated_at < ${cutoff}`,
    )
    .collect();
  return (rows ?? []).map((r) => ({
    kind: 'stale_knowledge',
    severity: SEVERITY.stale_knowledge,
    ref: String(r.id),
    message: `low-confidence knowledge older than 30d: ${r.content.slice(0, 80)}`,
  }));
}

async function checkDeadEdges(db) {
  // TYPE RELATION ENFORCED means SurrealDB rejects edge creates with missing
  // targets — so dead edges shouldn't accumulate organically. Still scan for
  // historical or test-injected ones. Use SELECT against each edge table.
  const issues = [];
  for (const edgeTable of EDGE_TABLES) {
    const [edges] = await db.query(`SELECT id, in, out FROM ${edgeTable}`).collect();
    for (const e of edges ?? []) {
      const [[inExists]] = await db.query(`SELECT count() AS n FROM ${e.in} GROUP ALL`).collect();
      const [[outExists]] = await db.query(`SELECT count() AS n FROM ${e.out} GROUP ALL`).collect();
      if ((inExists?.n ?? 0) === 0 || (outExists?.n ?? 0) === 0) {
        issues.push({
          kind: 'dead_edge',
          severity: SEVERITY.dead_edge,
          ref: String(e.id),
          message: `edge ${edgeTable} points to missing record(s)`,
        });
      }
    }
  }
  return issues;
}

async function checkNearDuplicateKnowledge(db) {
  // HNSW: for each row, fetch its single nearest neighbor.
  const [rows] = await db.query(surql`SELECT id, content, embedding FROM knowledge`).collect();
  const issues = [];
  const seen = new Set();
  for (const r of rows ?? []) {
    const [neighbors] = await db
      .query(
        `SELECT id, content, vector::similarity::cosine(embedding, $emb) AS sim
         FROM knowledge WHERE id != ${String(r.id)}
         ORDER BY embedding <|1|> $emb LIMIT 1`,
        { emb: r.embedding },
      )
      .collect();
    const nb = neighbors?.[0];
    if (!nb || nb.sim < 0.95) continue;
    const pair = [String(r.id), String(nb.id)].sort().join('::');
    if (seen.has(pair)) continue;
    seen.add(pair);
    issues.push({
      kind: 'near_duplicate_knowledge',
      severity: SEVERITY.near_duplicate_knowledge,
      ref: pair,
      message: `near-duplicate knowledge: cosine ${nb.sim.toFixed(3)}`,
    });
  }
  return issues;
}

export async function runLintChecks(db) {
  const all = [
    ...(await checkDeadEdges(db)),
    ...(await checkOrphanEntities(db)),
    ...(await checkDuplicateEntities(db)),
    ...(await checkNearDuplicateKnowledge(db)),
    ...(await checkStaleKnowledge(db)),
  ];
  all.sort((a, b) => {
    if (a.severity !== b.severity) return b.severity - a.severity;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.ref < b.ref ? -1 : 1;
  });
  return all;
}
```

- [ ] **Step 4: Run — pass**
```
node --test --test-force-exit tests/unit/lint-checks.test.js
```

- [ ] **Step 5: Lint + commit (explicit paths)**
```
npm run lint
git add src/jobs/lint-checks.js tests/unit/lint-checks.test.js
git commit -m "feat(4c): lint-checks — orphans, duplicates, stale, dead edges, near-dupes"
```

---

## Task 3: `ingest` + `lint` + `audit` MCP tool factories

This is one task because the three factories are small (~30-60 lines each) and share no logic, only the dependencies built in Tasks 1+2. Tests for each tool in a single combined file.

**Files:**
- Create: `src/mcp/tools/ingest.js`, `src/mcp/tools/lint.js`, `src/mcp/tools/audit.js`
- Create: `src/jobs/ingest-prompt.js`, `src/jobs/audit-prompt.js`
- Test: `tests/unit/ingest.test.js`, `tests/unit/lint.test.js`, `tests/unit/audit.test.js`

- [ ] **Step 1: Write failing tests for `ingest.test.js`**

```js
// tests/unit/ingest.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createIngestTool } from '../../src/mcp/tools/ingest.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return { db, embedder: createStubEmbedder({ dimension: 1024 }) };
}

const stubLLM = (output) => ({ invokeLLM: async () => ({ content: output }) });

test('ingest — missing all inputs', async () => {
  const { db, embedder } = await fresh();
  const t = createIngestTool({ db, embedder, host: stubLLM('{}') });
  const r = await t.handler({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing_arg');
  await close(db);
});

test('ingest — ambiguous inputs (content + url)', async () => {
  const { db, embedder } = await fresh();
  const t = createIngestTool({ db, embedder, host: stubLLM('{}') });
  const r = await t.handler({ content: 'x', url: 'https://x' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous_input');
  await close(db);
});

test('ingest — too_large content', async () => {
  const { db, embedder } = await fresh();
  const t = createIngestTool({ db, embedder, host: stubLLM('{}') });
  const r = await t.handler({ content: 'x'.repeat(1_048_577) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too_large');
  await close(db);
});

test('ingest — happy path inline content with stub LLM', async () => {
  const { db, embedder } = await fresh();
  const llm = stubLLM(JSON.stringify({
    entities: [{ name: 'Acme', type: 'project', confidence: 0.9 }],
    edges: [],
    knowledge: [{ content: 'Acme is a project', confidence: 0.8 }],
  }));
  const t = createIngestTool({ db, embedder, host: llm });
  const r = await t.handler({ content: 'Acme is a small project that does X.' });
  assert.equal(r.ok, true);
  assert.equal(r.deduped, false);
  assert.equal(r.entities_created, 1);
  assert.equal(r.knowledge_created, 1);
  await close(db);
});

test('ingest — dedup returns deduped:true', async () => {
  const { db, embedder } = await fresh();
  const llm = stubLLM(JSON.stringify({ entities: [], edges: [], knowledge: [] }));
  const t = createIngestTool({ db, embedder, host: llm });
  await t.handler({ content: 'same content here' });
  const r = await t.handler({ content: 'same content here' });
  assert.equal(r.ok, true);
  assert.equal(r.deduped, true);
  await close(db);
});

test('ingest — malformed LLM output → extraction_failed', async () => {
  const { db, embedder } = await fresh();
  const t = createIngestTool({ db, embedder, host: stubLLM('not json') });
  const r = await t.handler({ content: 'fresh content for parse-fail test' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'extraction_failed');
  await close(db);
});

test('ingest — PII content refused', async () => {
  const { db, embedder } = await fresh();
  const t = createIngestTool({ db, embedder, host: stubLLM(JSON.stringify({ entities: [], edges: [], knowledge: [] })) });
  // Trip the inbound PII guard with a credential-shaped value
  const r = await t.handler({
    content: 'AKIAIOSFODNN7EXAMPLE is the access key',
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^pii:/);
  await close(db);
});
```

- [ ] **Step 2: Write failing tests for `lint.test.js`**

```js
// tests/unit/lint.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createLintTool } from '../../src/mcp/tools/lint.js';
import { surql } from 'surrealdb';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return { db, embedder: createStubEmbedder({ dimension: 1024 }) };
}

test('lint — empty DB → no issues', async () => {
  const { db } = await fresh();
  const t = createLintTool({ db });
  const r = await t.handler({});
  assert.equal(r.ok, true);
  assert.equal(r.total, 0);
  assert.equal(r.returned, 0);
  assert.equal(r.issues.length, 0);
  await close(db);
});

test('lint — orphan entity is reported', async () => {
  const { db, embedder } = await fresh();
  const emb = await embedder.embed('orph');
  await db.query(surql`CREATE entities CONTENT ${{ name: 'Orph', type: 'thing', embedding: emb }}`).collect();
  const t = createLintTool({ db });
  const r = await t.handler({});
  assert.equal(r.total, 1);
  assert.equal(r.issues[0].kind, 'orphan_entity');
  await close(db);
});

test('lint — limit caps issues', async () => {
  const { db, embedder } = await fresh();
  for (let i = 0; i < 5; i++) {
    const emb = await embedder.embed(`x${i}`);
    await db.query(surql`CREATE entities CONTENT ${{ name: `X${i}`, type: 'thing', embedding: emb }}`).collect();
  }
  const t = createLintTool({ db });
  const r = await t.handler({ limit: 2 });
  assert.equal(r.total, 5);
  assert.equal(r.returned, 2);
  await close(db);
});
```

- [ ] **Step 3: Write failing tests for `audit.test.js`**

```js
// tests/unit/audit.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createAuditTool } from '../../src/mcp/tools/audit.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return { db, embedder: createStubEmbedder({ dimension: 1024 }) };
}

const stubLLM = (output) => ({ invokeLLM: async () => ({ content: output }) });

test('audit — empty knowledge → 0 pairs checked', async () => {
  const { db } = await fresh();
  const t = createAuditTool({ db, host: stubLLM('{"contradict":false,"summary":""}') });
  const r = await t.handler({});
  assert.equal(r.ok, true);
  assert.equal(r.pairs_checked, 0);
  assert.equal(r.contradictions.length, 0);
  await close(db);
});

test('audit — stub LLM returns no contradiction → empty result', async () => {
  const { db, embedder } = await fresh();
  const emb1 = await embedder.embed('first claim');
  const emb2 = await embedder.embed('second claim');
  await db.query(surql`CREATE knowledge CONTENT ${{ content: 'a', content_hash: 'h1', confidence: 0.8, source_events: [], source_episodes: [], embedding: emb1 }}`).collect();
  await db.query(surql`CREATE knowledge CONTENT ${{ content: 'b', content_hash: 'h2', confidence: 0.8, source_events: [], source_episodes: [], embedding: emb2 }}`).collect();
  const t = createAuditTool({ db, host: stubLLM('{"contradict":false,"summary":"different topics"}') });
  const r = await t.handler({ pair_count: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.contradictions.length, 0);
  await close(db);
});

test('audit — malformed LLM output treated as no contradiction', async () => {
  const { db, embedder } = await fresh();
  const emb1 = await embedder.embed('claim a');
  const emb2 = await embedder.embed('claim a');  // same vector — high cosine
  await db.query(surql`CREATE knowledge CONTENT ${{ content: 'a', content_hash: 'h1', confidence: 0.8, source_events: [], source_episodes: [], embedding: emb1 }}`).collect();
  await db.query(surql`CREATE knowledge CONTENT ${{ content: 'b', content_hash: 'h2', confidence: 0.8, source_events: [], source_episodes: [], embedding: emb2 }}`).collect();
  const t = createAuditTool({ db, host: stubLLM('not json at all') });
  const r = await t.handler({});
  assert.equal(r.ok, true);
  assert.equal(r.contradictions.length, 0);
  await close(db);
});

test('audit — stub LLM marks contradiction → reported', async () => {
  const { db, embedder } = await fresh();
  const emb = await embedder.embed('shared');
  await db.query(surql`CREATE knowledge CONTENT ${{ content: 'X is alive', content_hash: 'h1', confidence: 0.8, source_events: [], source_episodes: [], embedding: emb }}`).collect();
  await db.query(surql`CREATE knowledge CONTENT ${{ content: 'X is dead', content_hash: 'h2', confidence: 0.8, source_events: [], source_episodes: [], embedding: emb }}`).collect();
  const t = createAuditTool({ db, host: stubLLM('{"contradict":true,"summary":"alive vs dead"}') });
  const r = await t.handler({});
  assert.ok(r.contradictions.length > 0);
  assert.match(r.contradictions[0].summary, /alive vs dead/);
  await close(db);
});
```

- [ ] **Step 4: Run — all three test files fail (modules don't exist)**

- [ ] **Step 5: Implement `ingest-prompt.js` and `audit-prompt.js`**

```js
// src/jobs/ingest-prompt.js
export function buildIngestPrompt(content) {
  return `You are extracting structured memory from a source document.

Document:
"""
${content.slice(0, 200_000)}
"""

Extract entities, relationships, and knowledge claims. Respond with strict JSON only:

{
  "entities": [{"name": "string", "type": "person|place|project|topic|thing", "aliases": ["..."], "confidence": 0.0-1.0}],
  "edges": [{"src_name": "string", "dst_name": "string", "kind": "mentions|about|works_on|participates_in|co_occurs_with", "meta": {}}],
  "knowledge": [{"content": "string (one fact, one sentence)", "subject_name": "string (an entity name above, optional)", "confidence": 0.0-1.0}]
}

Rules:
- Be conservative — only extract claims directly supported by the text.
- Entity types must be one of: person, place, project, topic, thing.
- Edge kinds must be one of the 5 listed (the 'precedes' kind is for events-only and is reserved).
- Knowledge claims should be single sentences with subject + predicate.
- If nothing extractable, return empty arrays. Do not invent.
- Output JSON only — no commentary, no markdown fences.`;
}
```

```js
// src/jobs/audit-prompt.js
export function buildAuditPrompt(a_content, b_content) {
  return `Two memory claims:

Claim A: ${a_content}
Claim B: ${b_content}

Do these contradict each other? Respond with strict JSON only:

{"contradict": true|false, "summary": "one sentence"}`;
}
```

- [ ] **Step 6: Implement `lint.js` tool**

```js
// src/mcp/tools/lint.js
import { runLintChecks } from '../../jobs/lint-checks.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

export function createLintTool({ db }) {
  return {
    name: 'lint',
    description: 'Mechanical health check of memory: orphans, dead edges, duplicates, near-dupes, stale knowledge. Read-only. User-triggered.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT } },
    },
    handler: async (input = {}) => {
      const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
      const issues = await runLintChecks(db);
      return {
        ok: true,
        issues: issues.slice(0, limit),
        total: issues.length,
        returned: Math.min(issues.length, limit),
      };
    },
  };
}
```

- [ ] **Step 7: Implement `audit.js` tool**

```js
// src/mcp/tools/audit.js
import { surql } from 'surrealdb';
import { buildAuditPrompt } from '../../jobs/audit-prompt.js';

const DEFAULT_PAIR_COUNT = 8;
const MAX_PAIR_COUNT = 32;
const COSINE_THRESHOLD = 0.7;
const RECENCY_MS = 30 * 86_400_000;

async function selectPairs(db, pairCount) {
  const cutoff = new Date(Date.now() - RECENCY_MS);
  const [candidates] = await db
    .query(surql`SELECT id, content, embedding FROM knowledge WHERE updated_at > ${cutoff}`)
    .collect();
  const seenPairs = new Set();
  const pairs = [];
  for (const c of candidates ?? []) {
    const [neighbors] = await db
      .query(
        `SELECT id, content, vector::similarity::cosine(embedding, $emb) AS sim
         FROM knowledge WHERE id != ${String(c.id)}
         ORDER BY embedding <|1|> $emb LIMIT 1`,
        { emb: c.embedding },
      )
      .collect();
    const nb = neighbors?.[0];
    if (!nb || nb.sim < COSINE_THRESHOLD) continue;
    const key = [String(c.id), String(nb.id)].sort().join('::');
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    const [a_id, b_id] = key.split('::');
    pairs.push({
      a_id,
      b_id,
      a_content: String(a_id) === String(c.id) ? c.content : nb.content,
      b_content: String(b_id) === String(c.id) ? c.content : nb.content,
      sim: nb.sim,
    });
  }
  pairs.sort((a, b) => b.sim - a.sim);
  return pairs.slice(0, pairCount);
}

function parseLLMVerdict(text) {
  try {
    const v = JSON.parse(text);
    if (typeof v?.contradict === 'boolean' && typeof v?.summary === 'string') return v;
  } catch {
    /* fallthrough */
  }
  return { contradict: false, summary: '<llm output unparseable>' };
}

export function createAuditTool({ db, host }) {
  return {
    name: 'audit',
    description: 'LLM-driven contradiction-pair scan over recent knowledge. ~8 LLM calls/invocation (balanced tier). User-triggered.',
    inputSchema: {
      type: 'object',
      properties: { pair_count: { type: 'integer', minimum: 1, maximum: MAX_PAIR_COUNT } },
    },
    handler: async (input = {}) => {
      const pairCount = Math.min(MAX_PAIR_COUNT, Math.max(1, input.pair_count ?? DEFAULT_PAIR_COUNT));
      const pairs = await selectPairs(db, pairCount);
      const contradictions = [];
      for (const p of pairs) {
        if (!host?.invokeLLM) return { ok: false, reason: 'no_host' };
        const out = await host.invokeLLM(
          [{ role: 'user', content: buildAuditPrompt(p.a_content, p.b_content) }],
          { tier: 'balanced' },
        );
        const v = parseLLMVerdict(out?.content ?? '');
        if (v.contradict) {
          contradictions.push({ a_id: p.a_id, b_id: p.b_id, summary: v.summary });
        }
      }
      return { ok: true, pairs_checked: pairs.length, contradictions };
    },
  };
}
```

- [ ] **Step 8: Implement `ingest.js` tool**

```js
// src/mcp/tools/ingest.js
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { surql } from 'surrealdb';
import { recordEvent } from '../../capture/record-event.js';
import { inboundGuard } from '../../hooks/inbound-guard.js';
import { writeKnowledge } from '../../memory/knowledge.js';
import { buildIngestPrompt } from '../../jobs/ingest-prompt.js';
import { resolveOrCreateEntity } from '../../jobs/ingest-resolver.js';

const MAX_BYTES = 1_048_576;
const URL_FETCH_TIMEOUT_MS = 30_000;
const ALLOWED_CONTENT_TYPES = /^(text\/|application\/json)/;
const VALID_EDGE_KINDS = new Set(['mentions', 'about', 'works_on', 'participates_in', 'co_occurs_with']);

function hashContent(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

async function acquireContent({ content, url, file_path }) {
  if (content !== undefined) {
    if (content.length > MAX_BYTES) return { error: { reason: 'too_large', max_bytes: MAX_BYTES, given: content.length } };
    return { content, source_kind: 'inline', source_ref: null };
  }
  if (url !== undefined) {
    const res = await fetch(url, { signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS) });
    if (!res.ok) return { error: { reason: 'fetch_failed', status: res.status } };
    const ct = res.headers.get('content-type') ?? '';
    if (!ALLOWED_CONTENT_TYPES.test(ct)) return { error: { reason: 'unsupported_content_type', content_type: ct } };
    const body = await res.text();
    if (body.length > MAX_BYTES) return { error: { reason: 'too_large', max_bytes: MAX_BYTES, given: body.length } };
    return { content: body, source_kind: 'url', source_ref: url };
  }
  if (file_path !== undefined) {
    if (!existsSync(file_path)) return { error: { reason: 'not_found' } };
    const st = statSync(file_path);
    if (!st.isFile()) return { error: { reason: 'not_a_file' } };
    if (st.size > MAX_BYTES) return { error: { reason: 'too_large', max_bytes: MAX_BYTES, given: st.size } };
    return { content: readFileSync(file_path, 'utf8'), source_kind: 'file', source_ref: file_path };
  }
  return { error: { reason: 'missing_arg' } };
}

export function createIngestTool({ db, embedder, host }) {
  return {
    name: 'ingest',
    description: 'Write a source document into events + entities + edges + knowledge. User-triggered only.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        url: { type: 'string' },
        file_path: { type: 'string' },
      },
    },
    handler: async (input = {}) => {
      const provided = ['content', 'url', 'file_path'].filter((k) => input[k] !== undefined);
      if (provided.length === 0) return { ok: false, reason: 'missing_arg' };
      if (provided.length > 1) return { ok: false, reason: 'ambiguous_input' };

      const acquired = await acquireContent(input);
      if (acquired.error) return { ok: false, ...acquired.error };
      const { content, source_kind, source_ref } = acquired;

      // PII guard
      try {
        inboundGuard(db, { content, source: 'ingest' });
      } catch (e) {
        // inboundGuard throws RobinPiiRefusedError with the pattern name
        return { ok: false, reason: e?.message ?? 'pii' };
      }

      // Dedup by hash
      const hash = hashContent(content);
      const [existing] = await db
        .query(surql`SELECT id FROM events WHERE content_hash = ${hash} LIMIT 1`)
        .collect();
      if (existing?.[0]) {
        return { ok: true, deduped: true, event_id: String(existing[0].id) };
      }

      // Write the event
      const event_id = await recordEvent(db, embedder, {
        source: 'ingest',
        content,
        meta: { kind: 'document', source_kind, source_ref },
      });

      // LLM extraction
      if (!host?.invokeLLM) return { ok: false, reason: 'no_host' };
      const llm = await host.invokeLLM(
        [{ role: 'user', content: buildIngestPrompt(content) }],
        { tier: 'deep' },
      );
      let parsed;
      try {
        parsed = JSON.parse(llm?.content ?? '');
        if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      } catch (e) {
        return { ok: false, reason: 'extraction_failed', detail: e.message };
      }

      // Apply outputs
      const entitiesCreatedBefore = (await db.query(surql`SELECT count() AS n FROM entities GROUP ALL`).collect())[0]?.[0]?.n ?? 0;
      const entityIds = {};
      for (const e of parsed.entities ?? []) {
        if (!e?.name || !e?.type) continue;
        const id = await resolveOrCreateEntity(db, embedder, e);
        entityIds[e.name.toLowerCase()] = id;
      }
      const entitiesCreatedAfter = (await db.query(surql`SELECT count() AS n FROM entities GROUP ALL`).collect())[0]?.[0]?.n ?? 0;
      const entities_created = entitiesCreatedAfter - entitiesCreatedBefore;

      let edges_created = 0;
      for (const edge of parsed.edges ?? []) {
        if (!edge?.kind || !VALID_EDGE_KINDS.has(edge.kind)) {
          console.warn(`[ingest] skipping unknown edge kind: ${edge?.kind}`);
          continue;
        }
        const src = entityIds[edge.src_name?.toLowerCase?.()];
        const dst = entityIds[edge.dst_name?.toLowerCase?.()];
        if (!src || !dst) continue;
        try {
          // RELATE src->kind->dst CONTENT meta; mentions/about/etc. require events->entities,
          // but the spec restricts ingest-extracted edges to entity-target tables.
          // works_on, participates_in, co_occurs_with are events->entities too — we
          // pass the source event as the "in" record.
          await db
            .query(
              `RELATE ${event_id}->${edge.kind}->${String(dst)} CONTENT ${JSON.stringify(edge.meta ?? {})}`,
            )
            .collect();
          edges_created += 1;
        } catch (e) {
          console.warn(`[ingest] edge create failed: ${e.message}`);
        }
      }

      let knowledge_created = 0;
      for (const k of parsed.knowledge ?? []) {
        if (!k?.content) continue;
        const subject_id = k.subject_name ? entityIds[k.subject_name.toLowerCase()] : null;
        const id = await writeKnowledge(db, embedder, {
          content: k.content,
          subject_id: subject_id ?? null,
          confidence: typeof k.confidence === 'number' ? k.confidence : 0.5,
          source_events: [event_id],
          source_episodes: [],
        });
        if (id) knowledge_created += 1;
      }

      return {
        ok: true,
        deduped: false,
        event_id: String(event_id),
        entities_created,
        edges_created,
        knowledge_created,
      };
    },
  };
}
```

Note on `inboundGuard` and `recordEvent`: these live in `src/hooks/inbound-guard.js` and `src/capture/record-event.js`. **The capture file is in the 4f agent's territory** — do NOT modify it. Just import. If the import shape has changed (e.g. due to the in-flight rename pass), adapt the import path; do NOT rewrite the function. If `inboundGuard` doesn't exist by that name, fall back to a no-op with `console.warn` and report this as a `DONE_WITH_CONCERNS` so the controller knows to revisit.

- [ ] **Step 9: Run all three test files — pass**

```
node --test --test-force-exit tests/unit/ingest.test.js tests/unit/lint.test.js tests/unit/audit.test.js
```

- [ ] **Step 10: Lint + commit (explicit paths)**

```
npm run lint
git add src/mcp/tools/ingest.js src/mcp/tools/lint.js src/mcp/tools/audit.js \
        src/jobs/ingest-prompt.js src/jobs/audit-prompt.js \
        tests/unit/ingest.test.js tests/unit/lint.test.js tests/unit/audit.test.js
git commit -m "feat(4c): ingest + lint + audit MCP tools"
```

---

## Task 4: AGENTS.md knowledge-ops section

**Files:**
- Modify: `src/install/agents-md.js` (additive — insert new `jobsSection`-style function)
- Test: `tests/unit/agents-md-knowledge-ops.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/unit/agents-md-knowledge-ops.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent } from '../../src/install/agents-md.js';

test('agentsMdContent — knowledge-ops block present', () => {
  const md = agentsMdContent({});
  assert.match(md, /<!-- robin-knowledge-ops:start/);
  assert.match(md, /<!-- robin-knowledge-ops:end -->/);
});

test('agentsMdContent — knowledge-ops mentions all three tools by name', () => {
  const md = agentsMdContent({});
  assert.match(md, /\bingest\b/);
  assert.match(md, /\blint\b/);
  assert.match(md, /\baudit\b/);
});

test('agentsMdContent — knowledge-ops emphasizes user-triggered', () => {
  const md = agentsMdContent({});
  assert.match(md, /user-triggered/i);
  assert.match(md, /never.*autonomous/i);
});
```

- [ ] **Step 2: Run — fail**
```
node --test --test-force-exit tests/unit/agents-md-knowledge-ops.test.js
```

- [ ] **Step 3: Read `src/install/agents-md.js`** to find the insertion point. The `agentsMdContent({ integrations, jobs })` function has a template literal that places sections in order. The new block goes between `${jobsSection(jobs)}` and the memory-tools content. Add the new exported function near the existing `jobsSection`:

```js
export function knowledgeOpsSection() {
  return `<!-- robin-knowledge-ops:start (auto-generated, do not hand-edit) -->
## Knowledge ops

Three tools for memory hygiene. ALL are user-triggered — never call
autonomously, never on a loop.

- \`ingest({content|url|file_path})\` — write a source document into
  events + entities + edges + knowledge in one shot. Call only when the
  user says "ingest this", "add this to memory", "process this document",
  or pastes a file/URL.
- \`lint({limit})\` — read-only mechanical sweep (orphans, dead edges,
  duplicates, near-dupes, stale). Cheap, no LLM calls. Call when the user
  says "check memory", "memory health", "lint memory".
- \`audit({pair_count})\` — read-only LLM scan for contradictions across
  recent knowledge. ~8 LLM calls per invocation (balanced tier). Call when
  the user says "audit memory" — never on a loop.
<!-- robin-knowledge-ops:end -->`;
}
```

In the existing `agentsMdContent` template literal, add `\n${knowledgeOpsSection()}\n` after the existing `${jobsSection(jobs)}` reference. Do not change the order of any other sections.

- [ ] **Step 4: Run — pass**
```
node --test --test-force-exit tests/unit/agents-md-knowledge-ops.test.js tests/unit/agents-md-jobs.test.js tests/unit/agents-md-2e.test.js
```

All three must pass — your additions are insertion-point-stable.

- [ ] **Step 5: Lint + commit (explicit paths)**

```
npm run lint
git add src/install/agents-md.js tests/unit/agents-md-knowledge-ops.test.js
git commit -m "feat(4c): AGENTS.md knowledge-ops section"
```

---

## Task 5: Daemon wiring + CLI commands

This task is bigger but tightly coupled — both pieces depend on Tasks 1-3 being committed. Doing them together avoids two sequential PRs.

**Files:**
- Modify: `src/daemon/server.js` (additive: 3 tool registrations + 3 `/internal/knowledge/*` endpoints)
- Modify: `src/cli/index.js` (additive: 3 dispatcher branches)
- Create: `src/cli/commands/ingest.js`, `src/cli/commands/lint.js`, `src/cli/commands/audit.js`
- Test: `tests/unit/knowledge-cli.test.js`

- [ ] **Step 1: Write failing CLI tests**

```js
// tests/unit/knowledge-cli.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

const { ingestCmd } = await import('../../src/cli/commands/ingest.js');
const { lintCmd } = await import('../../src/cli/commands/lint.js');
const { auditCmd } = await import('../../src/cli/commands/audit.js');

function capture() {
  const lines = [];
  return { lines, fn: (s) => lines.push(s) };
}

test('ingest CLI — content arg POSTs content', async () => {
  const out = capture();
  let posted;
  await ingestCmd(['hello world'], {
    out: out.fn,
    daemonRequest: async (path, body) => {
      posted = { path, body };
      return { ok: true, event_id: 'evt:1', entities_created: 0, edges_created: 0, knowledge_created: 0 };
    },
  });
  assert.equal(posted.path, '/internal/knowledge/ingest');
  assert.equal(posted.body.content, 'hello world');
});

test('ingest CLI — --url passes url', async () => {
  let posted;
  await ingestCmd(['--url', 'https://example.com/x'], {
    out: () => {},
    daemonRequest: async (_path, body) => { posted = body; return { ok: true }; },
  });
  assert.equal(posted.url, 'https://example.com/x');
});

test('ingest CLI — --file passes file_path', async () => {
  let posted;
  await ingestCmd(['--file', '/tmp/x.md'], {
    out: () => {},
    daemonRequest: async (_path, body) => { posted = body; return { ok: true }; },
  });
  assert.equal(posted.file_path, '/tmp/x.md');
});

test('lint CLI — POSTs limit', async () => {
  const out = capture();
  let posted;
  await lintCmd(['--limit', '5'], {
    out: out.fn,
    daemonRequest: async (path, body) => {
      posted = { path, body };
      return { ok: true, issues: [], total: 0, returned: 0 };
    },
  });
  assert.equal(posted.path, '/internal/knowledge/lint');
  assert.equal(posted.body.limit, 5);
});

test('audit CLI — POSTs pair_count', async () => {
  let posted;
  await auditCmd(['--pairs', '4'], {
    out: () => {},
    daemonRequest: async (path, body) => {
      posted = { path, body };
      return { ok: true, pairs_checked: 0, contradictions: [] };
    },
  });
  assert.equal(posted.path, '/internal/knowledge/audit');
  assert.equal(posted.body.pair_count, 4);
});
```

- [ ] **Step 2: Run — fail**

```
node --test --test-force-exit tests/unit/knowledge-cli.test.js
```

- [ ] **Step 3: Implement the three CLI commands**

```js
// src/cli/commands/ingest.js
import { daemonRequest as defaultRequest } from '../daemon-request.js';

export async function ingestCmd(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const request = deps.daemonRequest ?? defaultRequest;

  // Parse --url <URL> or --file <PATH>; everything else treated as content
  const body = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') {
      body.url = argv[++i];
    } else if (a === '--file') {
      body.file_path = argv[++i];
    } else if (!body.content) {
      body.content = a;
    }
  }
  if (!body.content && !body.url && !body.file_path) {
    err('usage: robin ingest <content> | --url <URL> | --file <PATH>');
    process.exitCode = 1;
    return;
  }

  const result = await request('/internal/knowledge/ingest', body);
  if (result?.ok) {
    if (result.deduped) {
      out(`ok — deduped (event ${result.event_id})`);
    } else {
      out(
        `ok — event=${result.event_id} entities=${result.entities_created} edges=${result.edges_created} knowledge=${result.knowledge_created}`,
      );
    }
  } else {
    err(`ingest failed: ${result?.reason ?? 'unknown'}${result?.detail ? ` (${result.detail})` : ''}`);
    process.exitCode = 1;
  }
}
```

```js
// src/cli/commands/lint.js
import { daemonRequest as defaultRequest } from '../daemon-request.js';

export async function lintCmd(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const request = deps.daemonRequest ?? defaultRequest;

  let limit;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') limit = Number.parseInt(argv[++i], 10);
  }

  const result = await request('/internal/knowledge/lint', limit ? { limit } : {});
  if (!result?.ok) {
    err(`lint failed: ${result?.reason ?? 'unknown'}`);
    process.exitCode = 1;
    return;
  }
  out(`lint: ${result.returned}/${result.total} issues`);
  for (const i of result.issues ?? []) {
    out(`  [${i.severity}] ${i.kind} ${i.ref} — ${i.message}`);
  }
}
```

```js
// src/cli/commands/audit.js
import { daemonRequest as defaultRequest } from '../daemon-request.js';

export async function auditCmd(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const request = deps.daemonRequest ?? defaultRequest;

  let pair_count;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pairs') pair_count = Number.parseInt(argv[++i], 10);
  }

  const result = await request('/internal/knowledge/audit', pair_count ? { pair_count } : {});
  if (!result?.ok) {
    err(`audit failed: ${result?.reason ?? 'unknown'}`);
    process.exitCode = 1;
    return;
  }
  out(`audit: ${result.contradictions.length}/${result.pairs_checked} pairs flagged`);
  for (const c of result.contradictions ?? []) {
    out(`  ${c.a_id} vs ${c.b_id}: ${c.summary}`);
  }
}
```

- [ ] **Step 4: Wire dispatcher in `src/cli/index.js`**

Find the existing `if (cmd === 'jobs')` block. AFTER it, add:

```js
if (cmd === 'ingest') {
  const { ingestCmd } = await import('./commands/ingest.js');
  return ingestCmd(argv.slice(1));
}
if (cmd === 'lint') {
  const { lintCmd } = await import('./commands/lint.js');
  return lintCmd(argv.slice(1));
}
if (cmd === 'audit') {
  const { auditCmd } = await import('./commands/audit.js');
  return auditCmd(argv.slice(1));
}
```

- [ ] **Step 5: Wire daemon endpoints + tool registration in `src/daemon/server.js`**

Find the existing `createListJobsTool`, `createRunJobTool` imports near the top. Add:

```js
import { createIngestTool } from '../mcp/tools/ingest.js';
import { createLintTool } from '../mcp/tools/lint.js';
import { createAuditTool } from '../mcp/tools/audit.js';
```

Find the existing `createListJobsTool({ db: dbHandle })` registration in the `tools` array. AFTER the run-job entry, add:

```js
createIngestTool({ db: dbHandle, embedder: embedderWrap, host }),
createLintTool({ db: dbHandle }),
createAuditTool({ db: dbHandle, host }),
```

Find the existing `/internal/jobs/reload` endpoint handler. AFTER it, add (matching the existing pattern in this file — use whatever `readJsonBody` / response helper names this file uses):

```js
if (req.method === 'POST' && req.url === '/internal/knowledge/ingest') {
  const body = await readJsonBody(req);
  const tool = tools.find((t) => t.name === 'ingest');
  if (!tool) return json(res, 500, { ok: false, reason: 'ingest_tool_not_registered' });
  const result = await tool.handler(body);
  return json(res, 200, result);
}
if (req.method === 'POST' && req.url === '/internal/knowledge/lint') {
  const body = await readJsonBody(req);
  const tool = tools.find((t) => t.name === 'lint');
  if (!tool) return json(res, 500, { ok: false, reason: 'lint_tool_not_registered' });
  const result = await tool.handler(body);
  return json(res, 200, result);
}
if (req.method === 'POST' && req.url === '/internal/knowledge/audit') {
  const body = await readJsonBody(req);
  const tool = tools.find((t) => t.name === 'audit');
  if (!tool) return json(res, 500, { ok: false, reason: 'audit_tool_not_registered' });
  const result = await tool.handler(body);
  return json(res, 200, result);
}
```

Match the existing `readJsonBody` / response helper names in `server.js`. If they differ (e.g. `parseBody` / `sendJson` / inline `res.writeHead`/`res.end`), adapt to match the existing convention.

- [ ] **Step 6: Run tests + verify daemon integration tests still pass**

```
node --test --test-force-exit tests/unit/knowledge-cli.test.js tests/integration/scheduler-multi-integration.test.js tests/integration/mcp-end-to-end.test.js
```

Expected: all pass. If a daemon test breaks, you mis-wired something — read the error and fix before committing.

- [ ] **Step 7: Lint + commit (explicit paths)**

```
npm run lint
git status                                # verify only the 7 files modified by you
git add src/daemon/server.js src/cli/index.js \
        src/cli/commands/ingest.js src/cli/commands/lint.js src/cli/commands/audit.js \
        tests/unit/knowledge-cli.test.js
git commit -m "feat(4c): daemon wires knowledge ops + robin ingest/lint/audit CLI"
```

---

## Task 6: Integration roundtrip

**Files:**
- Create: `tests/integration/knowledge-ops-roundtrip.test.js`

- [ ] **Step 1: Write the integration test**

```js
// tests/integration/knowledge-ops-roundtrip.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createIngestTool } from '../../src/mcp/tools/ingest.js';
import { createLintTool } from '../../src/mcp/tools/lint.js';
import { createAuditTool } from '../../src/mcp/tools/audit.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

test('knowledge ops roundtrip: ingest → lint sees orphan → audit sees no pairs', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const embedder = createStubEmbedder({ dimension: 1024 });

  const llmStub = {
    invokeLLM: async (msgs, opts) => {
      if (opts?.tier === 'balanced') {
        return { content: '{"contradict":false,"summary":"no overlap"}' };
      }
      // deep tier: ingest extraction
      return {
        content: JSON.stringify({
          entities: [{ name: 'Mercury', type: 'project', confidence: 0.9 }],
          edges: [],
          knowledge: [{ content: 'Mercury is a project that launched in 2026', subject_name: 'Mercury', confidence: 0.8 }],
        }),
      };
    },
  };

  const ingest = createIngestTool({ db, embedder, host: llmStub });
  const lint = createLintTool({ db });
  const audit = createAuditTool({ db, host: llmStub });

  // 1. Ingest a document
  const ing = await ingest.handler({ content: 'Project Mercury launched in early 2026. It was led by the platform team.' });
  assert.equal(ing.ok, true);
  assert.equal(ing.entities_created, 1);
  assert.equal(ing.knowledge_created, 1);

  // 2. Lint should find an orphan entity (the Mercury entity has no inbound edges
  // because the LLM stub returned no edges)
  const lr = await lint.handler({});
  const orphans = lr.issues.filter((i) => i.kind === 'orphan_entity');
  assert.ok(orphans.length >= 1);

  // 3. Audit with only one knowledge row: no pairs possible
  const ar = await audit.handler({});
  assert.equal(ar.ok, true);
  assert.equal(ar.pairs_checked, 0);

  await close(db);
});
```

- [ ] **Step 2: Run — pass**

```
node --test --test-force-exit tests/integration/knowledge-ops-roundtrip.test.js
```

- [ ] **Step 3: Full test suite smoke (skipping the 4f agent's hung file)**

```
node --test --test-force-exit $(find tests -name "*.test.js" | grep -v biographer-process-pending-captures | tr '\n' ' ') 2>&1 | tail -5
```

Expected: All pass. Any new failure traceable to 4c is yours to fix.

- [ ] **Step 4: Lint + commit (explicit path)**

```
npm run lint
git add tests/integration/knowledge-ops-roundtrip.test.js
git commit -m "test(4c): integration roundtrip — ingest, lint, audit end-to-end"
```

---

## Self-review checklist (filled)

**Spec coverage:**
- §3 ingest → Task 3
- §4 lint → Tasks 2 (helper) + 3 (tool factory)
- §5 audit → Task 3
- §7 daemon endpoints → Task 5
- §8 MCP tool registration → Task 5
- §9 CLI → Task 5
- §10 AGENTS.md → Task 4
- §11 tests — each named file appears in Tasks 1-6
- §13 risk register — `audit` cap (Task 3), file_path daemon-user trust model (Task 3), PII guard (Task 3)
- §15 phase exit criteria → Task 6 + per-task commits

**Placeholder scan:** No TBDs, no vague "handle errors appropriately". All steps have concrete code or commands.

**Type consistency:** `runOneJob`-style signatures don't apply here; tool factory shapes are `createXxxTool({ db, host, embedder? })`. Verified in Tasks 3, 5, 6.
