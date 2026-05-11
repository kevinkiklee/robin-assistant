import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { resolveOrCreateEntity } from '../../cognition/jobs/ingest-resolver.js';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

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
    name: 'Acme',
    type: 'project',
  });
  const reused = await resolveOrCreateEntity(db, embedder, {
    name: 'acme',
    type: 'project',
  });
  assert.equal(String(created), String(reused));
  await close(db);
});

test('resolveOrCreateEntity — alias-as-name match returns existing', async () => {
  const { db, embedder } = await fresh();
  const first = await resolveOrCreateEntity(db, embedder, {
    name: 'Acme Corp',
    type: 'project',
    aliases: ['Acme', 'AC'],
  });
  const second = await resolveOrCreateEntity(db, embedder, {
    name: 'Acme',
    type: 'project',
  });
  const third = await resolveOrCreateEntity(db, embedder, {
    name: 'New Brand',
    type: 'project',
    aliases: ['Acme'],
  });
  assert.equal(String(third), String(second));
  assert.notEqual(String(first), String(second));
  await close(db);
});

test('resolveOrCreateEntity — creates new when no match', async () => {
  const { db, embedder } = await fresh();
  const id = await resolveOrCreateEntity(db, embedder, {
    name: 'NewThing',
    type: 'thing',
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
    name: 'BigCo',
    type: 'project',
    aliases: ['BC', 'Big'],
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
