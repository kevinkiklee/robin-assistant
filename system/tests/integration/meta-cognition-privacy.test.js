import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import runMetaRecallNarrative from '../../cognition/jobs/internal/meta-recall-narrative.js';
import { note } from '../../cognition/memory/store.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-d2priv-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

function fakeHost() {
  return {
    invokeLLM: async () => ({ content: '{}', usage: { input_tokens: 0, output_tokens: 0 } }),
    calls: 0,
  };
}

async function seedRowWithHit(db, memoId) {
  await db
    .query(
      surql`CREATE recall_log CONTENT {
      ts: time::now() - 1d,
      session_id: 's',
      query: 'q',
      k: 5,
      ranked_hits: [{ record: ${memoId}, kind: 'memo' }],
      outcome: 'corrected',
    }`,
    )
    .collect();
}

test('P1 — row whose hit is a private-scope memo is dropped', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await db.query('UPDATE runtime:`meta_cognition.config` SET value.enabled = true').collect();

  // 4 non-private rows + 1 private = 5 corrected (gate passes).
  const m1 = await note(db, e, 'knowledge', {
    content: 'k1',
    derived_by: 'agent',
    scope: 'global',
  });
  const mp = await note(db, e, 'knowledge', {
    content: 'private secret',
    derived_by: 'agent',
    scope: 'private',
  });
  for (let i = 0; i < 4; i++) await seedRowWithHit(db, m1.id);
  await seedRowWithHit(db, mp.id);

  await runMetaRecallNarrative({ db, embedder: e, host: fakeHost() });
  const [tel] = await db
    .query(
      'SELECT outcome, rows_after_privacy, dropped_private, ts FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1',
    )
    .collect();
  assert.equal(tel?.[0]?.dropped_private, 1, 'one row should be dropped');
  assert.equal(tel?.[0]?.rows_after_privacy, 4, 'four rows survive');
  await close(db);
});

test('P2 — row whose hit memo is derived_from a private memo is dropped (transitive)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await db.query('UPDATE runtime:`meta_cognition.config` SET value.enabled = true').collect();

  const mPriv = await note(db, e, 'knowledge', {
    content: 'private',
    derived_by: 'agent',
    scope: 'private',
  });
  const mDerived = await note(db, e, 'knowledge', {
    content: 'derived',
    derived_by: 'agent',
    scope: 'global',
    lineage: [{ id: mPriv.id, kind: 'memo' }],
  });
  const mClean = await note(db, e, 'knowledge', {
    content: 'clean',
    derived_by: 'agent',
    scope: 'global',
  });

  // 4 clean rows + 1 transitively-private row = 5 corrected.
  for (let i = 0; i < 4; i++) await seedRowWithHit(db, mClean.id);
  await seedRowWithHit(db, mDerived.id);

  await runMetaRecallNarrative({ db, embedder: e, host: fakeHost() });
  const [tel] = await db
    .query(
      'SELECT dropped_private, rows_after_privacy, ts FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1',
    )
    .collect();
  assert.equal(tel?.[0]?.dropped_private, 1);
  assert.equal(tel?.[0]?.rows_after_privacy, 4);
  await close(db);
});

test('P3 — private_scope_action=fail aborts the run', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await db
    .query(
      "UPDATE runtime:`meta_cognition.config` SET value.enabled = true, value.private_scope_action = 'fail'",
    )
    .collect();

  const m1 = await note(db, e, 'knowledge', {
    content: 'k1',
    derived_by: 'agent',
    scope: 'global',
  });
  const mp = await note(db, e, 'knowledge', {
    content: 'private',
    derived_by: 'agent',
    scope: 'private',
  });
  for (let i = 0; i < 4; i++) await seedRowWithHit(db, m1.id);
  await seedRowWithHit(db, mp.id);

  const result = await runMetaRecallNarrative({ db, embedder: e, host: fakeHost() });
  const summary = JSON.parse(result);
  assert.equal(summary.ran, false);
  assert.equal(summary.reason, 'private_scope_contamination');
  const [tel] = await db
    .query('SELECT outcome, error, ts FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1')
    .collect();
  assert.equal(tel?.[0]?.outcome, 'error');
  assert.equal(tel?.[0]?.error, 'private_scope_contamination');
  await close(db);
});
