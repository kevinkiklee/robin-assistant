import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { intuitionEndpoint } from '../../cognition/intuition/inject.js';
import { note } from '../../cognition/memory/store.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-d2recall-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('S1 — reasoning memo surfaces at intuition recall', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  // Write a reasoning memo about photo-tools.
  await note(db, e, 'reasoning', {
    content:
      'Across this week, recall about photo-tools surfaced stale memos about a different toolkit.',
    derived_by: 'meta_cognition',
    scope: 'global',
    meta: {
      dimension: 'recall_failures',
      from_signal: 'meta_cognition',
      period: 'weekly',
      signal_count: 5,
      week_starting: '2026-05-04',
    },
  });
  // And a knowledge memo as a control.
  await note(db, e, 'knowledge', {
    content: 'photo-tools is a Next.js 16 photography toolkit',
    derived_by: 'agent',
    scope: 'global',
  });

  const out = await intuitionEndpoint({
    db,
    embedder: e,
    query: 'tell me about photo-tools recall failures',
    priorAssistant: '',
    k: 10,
    recencyDays: 30,
  });
  // The reasoning memo should be present in the rendered block.
  const block = typeof out === 'string' ? out : (out?.block ?? '');
  assert.ok(
    block.includes('photo-tools surfaced stale memos'),
    `reasoning memo content should appear in injected block; got: ${block.slice(0, 200)}`,
  );
  await close(db);
});
