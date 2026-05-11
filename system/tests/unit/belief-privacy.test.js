import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { filterPrivateRefs } from '../../cognition/belief/privacy.js';
import * as store from '../../cognition/memory/store.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-priv-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('filterPrivateRefs: direct private scope drop', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const a = await store.note(db, e, 'knowledge', {
    content: 'A',
    derived_by: 'auto',
    scope: 'global',
  });
  const b = await store.note(db, e, 'knowledge', {
    content: 'B',
    derived_by: 'auto',
    scope: 'private',
  });
  const r = await filterPrivateRefs(db, [a.id, b.id]);
  assert.deepEqual(r.kept_ids.map(String), [String(a.id)]);
  assert.deepEqual(r.dropped_ids.map(String), [String(b.id)]);
  await close(db);
});

test('filterPrivateRefs: transitive private (public derived_from private)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const priv = await store.note(db, e, 'knowledge', {
    content: 'PRIV',
    derived_by: 'auto',
    scope: 'private',
  });
  const pub = await store.note(db, e, 'knowledge', {
    content: 'derived public',
    derived_by: 'auto',
    scope: 'global',
    lineage: [{ id: priv.id }],
  });
  const r = await filterPrivateRefs(db, [pub.id]);
  assert.deepEqual(r.kept_ids, []);
  assert.deepEqual(r.dropped_ids.map(String), [String(pub.id)]);
  await close(db);
});

test('filterPrivateRefs: all-public passthrough', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const a = await store.note(db, e, 'knowledge', {
    content: 'A',
    derived_by: 'auto',
    scope: 'global',
  });
  const b = await store.note(db, e, 'knowledge', {
    content: 'B',
    derived_by: 'auto',
    scope: 'global',
  });
  const r = await filterPrivateRefs(db, [a.id, b.id]);
  assert.equal(r.kept_ids.length, 2);
  assert.equal(r.dropped_ids.length, 0);
  await close(db);
});

test('filterPrivateRefs: empty input → empty output', async () => {
  const db = await fresh();
  const r = await filterPrivateRefs(db, []);
  assert.deepEqual(r.kept_ids, []);
  assert.deepEqual(r.dropped_ids, []);
  await close(db);
});
