// Snapshot test for related_entities: validates formatEntity wrapping per neighbor.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeCoOccursWith } from '../../cognition/biographer/edges.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createRelatedEntitiesTool } from '../../io/mcp/tools/related-entities.js';

const __robinTestHome = join(
  tmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function makeChain(names) {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
  const ids = [];
  for (const n of names) {
    const _v = Array.from(await e.embed(`person: ${n}`));
    const [c] = await db
      .query(surql`CREATE entities CONTENT ${{ name: n, type: 'person' }}`)
      .collect();
    ids.push((Array.isArray(c) ? c[0] : c).id);
  }
  for (let i = 0; i < ids.length - 1; i++) {
    await writeCoOccursWith(db, [ids[i], ids[i + 1]]);
  }
  return { db, ids };
}

test('related_entities wraps each neighbor entity in formatEntity shape', async () => {
  const { db, ids } = await makeChain(['A', 'B', 'C']);
  const tool = createRelatedEntitiesTool({ db });
  const r = await tool.handler({ id: String(ids[0]), depth: 1, limit: 10 });
  assert.equal(r.related.length, 1);
  const hit = r.related[0];
  assert.ok(hit.entity.id);
  assert.equal(hit.entity.kind, 'person');
  assert.equal(hit.entity.name, 'B');
  assert.deepEqual(hit.entity.edges, []);
  assert.deepEqual(hit.entity.events, []);
  assert.equal(hit.entity.meta.trimmed, false);
  // Legacy connector fields preserved:
  assert.equal(hit.distance, 1);
  assert.equal(hit.edge_type, 'occurs_with');
  await close(db);
});

test('related_entities full:true preserves shape', async () => {
  const { db, ids } = await makeChain(['A', 'B']);
  const tool = createRelatedEntitiesTool({ db });
  const r = await tool.handler({ id: String(ids[0]), depth: 1, limit: 10, full: true });
  assert.equal(r.related.length, 1);
  assert.equal(r.related[0].entity.meta.trimmed, false);
  await close(db);
});

test('related_entities returns empty for isolated entity', async () => {
  const { db, ids } = await makeChain(['Solo']);
  const tool = createRelatedEntitiesTool({ db });
  const r = await tool.handler({ id: String(ids[0]) });
  assert.deepEqual(r.related, []);
  await close(db);
});
