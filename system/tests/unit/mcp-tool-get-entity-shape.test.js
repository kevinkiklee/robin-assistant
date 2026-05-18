// Snapshot test for get_entity: validates formatEntity helper wiring.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createGetEntityTool } from '../../io/mcp/tools/get-entity.js';

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

test('get_entity returns formatEntity-wrapped entity with helper-defined keys', async () => {
  const db = await fresh();
  const [c] = await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person' }}`)
    .collect();
  const id = String((Array.isArray(c) ? c[0] : c).id);
  const tool = createGetEntityTool({ db });
  const r = await tool.handler({ id });
  // Helper-defined keys:
  assert.equal(r.entity.id, id);
  assert.equal(r.entity.kind, 'person');
  assert.equal(r.entity.name, 'Alice');
  assert.deepEqual(r.entity.edges, []);
  assert.deepEqual(r.entity.events, []);
  assert.equal(r.entity.meta.total_edges, 0);
  assert.equal(r.entity.meta.total_events, 0);
  assert.equal(r.entity.meta.trimmed, false);
  // Legacy fields preserved:
  assert.equal(r.entity.type, 'person');
  assert.ok(r.entity.edge_summary);
  await close(db);
});

test('get_entity full:true does not change shape when no edges/events to trim', async () => {
  const db = await fresh();
  const [c] = await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Bob', type: 'person' }}`)
    .collect();
  const id = String((Array.isArray(c) ? c[0] : c).id);
  const tool = createGetEntityTool({ db });
  const r = await tool.handler({ id, full: true });
  assert.equal(r.entity.meta.trimmed, false);
  assert.equal(r.entity.name, 'Bob');
  await close(db);
});
