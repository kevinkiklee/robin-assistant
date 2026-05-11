import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { batchStructuralWeights } from '../../cognition/belief/structural-weights.js';
import * as store from '../../cognition/memory/store.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-sw-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('batchStructuralWeights: supersedes_count>0 -> structural=0', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const a = await store.note(db, e, 'knowledge', { content: 'A', derived_by: 'auto' });
  const b = await store.note(db, e, 'knowledge', { content: 'B', derived_by: 'auto' });
  // b supersedes a. Edge: from = b, to = a, kind = 'supersedes'.
  await store.relateAll(db, [{ from: b.id, to: a.id, kind: 'supersedes' }]);
  const map = await batchStructuralWeights(db, [a.id, b.id]);
  assert.equal(map.get(String(a.id)).structural, 0, 'a is superseded -> 0');
  assert.ok(map.get(String(b.id)).structural > 0, 'b not superseded -> >0');
  await close(db);
});

test('batchStructuralWeights: empty ids -> empty map', async () => {
  const db = await fresh();
  const map = await batchStructuralWeights(db, []);
  assert.equal(map.size, 0);
  await close(db);
});
