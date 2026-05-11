import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { listMemos, note, searchMemos } from '../../cognition/memory/store.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-kf-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('listMemos: single-kind string filter still works (backward-compat)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await note(db, e, 'knowledge', { content: 'k1', derived_by: 'agent' });
  await note(db, e, 'reasoning', { content: 'r1', derived_by: 'meta_cognition' });
  const rows = await listMemos(db, { kind: 'knowledge', limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'knowledge');
  await close(db);
});

test('listMemos: array-kind filter returns matching rows for both kinds', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await note(db, e, 'knowledge', { content: 'k1', derived_by: 'agent' });
  await note(db, e, 'reasoning', { content: 'r1', derived_by: 'meta_cognition' });
  await note(db, e, 'habit', { content: 'h1', derived_by: 'dream', meta: { name: 'h1' } });
  const rows = await listMemos(db, { kind: ['knowledge', 'reasoning'], limit: 10 });
  assert.equal(rows.length, 2);
  const kinds = rows.map((r) => r.kind).sort();
  assert.deepEqual(kinds, ['knowledge', 'reasoning']);
  await close(db);
});

test('searchMemos: single-kind string filter still works', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await note(db, e, 'knowledge', { content: 'photo-tools is a Next.js app', derived_by: 'agent' });
  await note(db, e, 'reasoning', {
    content: 'A weekly meta note about photo-tools',
    derived_by: 'meta_cognition',
  });
  const r = await searchMemos(db, e, 'photo-tools', { kind: 'knowledge', limit: 5 });
  const kinds = (r?.hits ?? []).map((h) => h.record.kind);
  assert.ok(kinds.length > 0);
  for (const k of kinds) assert.equal(k, 'knowledge');
  await close(db);
});

test('searchMemos: array-kind filter returns both kinds', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await note(db, e, 'knowledge', { content: 'photo-tools is a Next.js app', derived_by: 'agent' });
  await note(db, e, 'reasoning', {
    content: 'photo-tools weekly meta note',
    derived_by: 'meta_cognition',
  });
  await note(db, e, 'habit', {
    content: 'photo-tools habit',
    derived_by: 'dream',
    meta: { name: 'h1' },
  });
  const r = await searchMemos(db, e, 'photo-tools', {
    kind: ['knowledge', 'reasoning'],
    limit: 5,
  });
  const kinds = new Set((r?.hits ?? []).map((h) => h.record.kind));
  assert.ok(kinds.has('knowledge') || kinds.has('reasoning'), 'at least one expected kind present');
  for (const k of kinds) assert.ok(['knowledge', 'reasoning'].includes(k), `unexpected kind: ${k}`);
  await close(db);
});
