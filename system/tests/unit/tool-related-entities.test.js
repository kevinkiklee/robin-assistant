import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeCoOccursWith } from '../../cognition/biographer/edges.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createRelatedEntitiesTool } from '../../io/mcp/tools/related-entities.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

test('related_entities returns co_occurs_with neighbors', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
  const ids = [];
  for (const n of ['Alice', 'Bob', 'Charlie']) {
    const _v = Array.from(await e.embed(`person: ${n}`));
    const [c] = await db
      .query(surql`CREATE entities CONTENT ${{ name: n, type: 'person' }}`)
      .collect();
    ids.push((Array.isArray(c) ? c[0] : c).id);
  }
  await writeCoOccursWith(db, ids);
  const tool = createRelatedEntitiesTool({ db });
  const r = await tool.handler({ id: String(ids[0]), depth: 1, limit: 10 });
  assert.ok(r.related.length >= 2);
  await close(db);
});

test('related_entities depth=2 reaches second-hop neighbors via arrow traversal', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
  const ids = [];
  for (const n of ['A', 'B', 'C', 'D']) {
    const _v = Array.from(await e.embed(`person: ${n}`));
    const [c] = await db
      .query(surql`CREATE entities CONTENT ${{ name: n, type: 'person' }}`)
      .collect();
    ids.push((Array.isArray(c) ? c[0] : c).id);
  }
  // Build chain: A — B — C — D via occurs_with.
  await writeCoOccursWith(db, [ids[0], ids[1]]);
  await writeCoOccursWith(db, [ids[1], ids[2]]);
  await writeCoOccursWith(db, [ids[2], ids[3]]);

  const tool = createRelatedEntitiesTool({ db });
  const r1 = await tool.handler({ id: String(ids[0]), depth: 1, limit: 10 });
  // Depth 1 from A reaches only B.
  assert.equal(r1.related.length, 1);
  assert.equal(r1.related[0].entity.name, 'B');
  assert.equal(r1.related[0].distance, 1);

  const r2 = await tool.handler({ id: String(ids[0]), depth: 2, limit: 10 });
  // Depth 2 reaches B (d=1) and C (d=2).
  const names = r2.related.map((x) => x.entity.name).sort();
  assert.deepEqual(names, ['B', 'C']);
  const cHit = r2.related.find((x) => x.entity.name === 'C');
  assert.equal(cHit.distance, 2);
  await close(db);
});

test('related_entities returns empty for entity with no edges', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
  const _v = Array.from(await e.embed('person: Solo'));
  const [c] = await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Solo', type: 'person' }}`)
    .collect();
  const id = (Array.isArray(c) ? c[0] : c).id;
  const tool = createRelatedEntitiesTool({ db });
  const r = await tool.handler({ id: String(id) });
  assert.deepEqual(r.related, []);
  await close(db);
});
