// Snapshot test for find_entity: validates formatEntity helper wiring.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createFindEntityTool } from '../../io/mcp/tools/find-entity.js';

const __robinTestHome = join(
  tmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('find_entity returns matches wrapped by formatEntity (id/kind/name/summary/edges/events/meta)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await db.query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person' }}`).collect();
  const tool = createFindEntityTool({ db, embedder: e });
  const r = await tool.handler({ name: 'alice', type: 'person', fuzzy: false });
  assert.equal(r.entities.length, 1);
  const ent = r.entities[0];
  assert.ok(ent.id);
  assert.equal(ent.kind, 'person');
  assert.equal(ent.name, 'Alice');
  // Helper-defined shape:
  assert.equal(ent.summary, null);
  assert.deepEqual(ent.edges, []);
  assert.deepEqual(ent.events, []);
  assert.equal(ent.meta.total_edges, 0);
  assert.equal(ent.meta.total_events, 0);
  assert.equal(ent.meta.trimmed, false);
  await close(db);
});

test('find_entity full:true preserves shape (no edges/events to trim)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await db.query(surql`CREATE entities CONTENT ${{ name: 'Bob', type: 'person' }}`).collect();
  const tool = createFindEntityTool({ db, embedder: e });
  const r = await tool.handler({ name: 'bob', type: 'person', fuzzy: false, full: true });
  assert.equal(r.entities.length, 1);
  assert.equal(r.entities[0].meta.trimmed, false);
  await close(db);
});

test('find_entity returns empty array when no matches', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const tool = createFindEntityTool({ db, embedder: e });
  const r = await tool.handler({ name: 'missing', fuzzy: false });
  assert.deepEqual(r.entities, []);
  await close(db);
});
