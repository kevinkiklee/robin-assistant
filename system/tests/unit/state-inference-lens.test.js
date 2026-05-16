import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  latestForSource,
  listRecent,
  noteStateInference,
} from '../../cognition/memory/state_inference.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-lens-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('noteStateInference writes a kind=state_inference memo with derived_by=state-inference', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const { id } = await noteStateInference(db, e, {
    source: 'agent:claude-code',
    content: 'Alice is reviewing the cognition refactor.',
    confidence: 0.8,
    entities: [],
    arc_id: null,
    last_event_id: null,
    evidence_snippet: 'reviewing inject.js',
    last_active_at: new Date(),
    from_signal: ['attention'],
    signal_hash: 'abc',
    scope: 'global',
  });
  const [rows] = await db.query(`SELECT * FROM ONLY $id`, { id }).collect();
  const memo = rows?.[0] ?? rows;
  assert.equal(memo.kind, 'state_inference');
  assert.equal(memo.derived_by, 'state-inference');
  assert.equal(memo.scope, 'global');
  assert.equal(memo.meta.dimension, 'current_focus');
  assert.equal(memo.meta.source, 'agent:claude-code');
  assert.equal(memo.meta.signal_hash, 'abc');
  assert.deepEqual(memo.meta.from_signal, ['attention']);
  await close(db);
});

test('latestForSource returns most-recent non-superseded memo', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const a = await noteStateInference(db, e, {
    source: 'agent:claude-code',
    content: 'A',
    confidence: 0.5,
    entities: [],
    last_active_at: new Date(Date.now() - 60_000),
    signal_hash: 'h1',
  });
  const b = await noteStateInference(db, e, {
    source: 'agent:claude-code',
    content: 'B',
    confidence: 0.6,
    entities: [],
    last_active_at: new Date(),
    signal_hash: 'h2',
  });
  // Mark a as superseded by b.
  await db
    .query(`RELATE $from->supersedes->$to CONTENT { kind: 'supersedes' }`, { from: b.id, to: a.id })
    .collect();
  const latest = await latestForSource(db, 'agent:claude-code');
  assert.ok(latest);
  assert.equal(String(latest.id), String(b.id));
  await close(db);
});

test('latestForSource returns null when source has no memo', async () => {
  const db = await fresh();
  const latest = await latestForSource(db, 'agent:nope');
  assert.equal(latest, null);
  await close(db);
});

test('listRecent returns all state_inference rows ordered by derived_at desc, limited', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  for (let i = 0; i < 4; i++) {
    await noteStateInference(db, e, {
      source: 'agent:claude-code',
      content: `c${i}`,
      confidence: 0.5,
      entities: [],
      last_active_at: new Date(Date.now() - (4 - i) * 1000),
      signal_hash: `h${i}`,
    });
  }
  const rows = await listRecent(db, { limit: 2 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].content, 'c3');
  await close(db);
});
