import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import runMetaRecallNarrative from '../../cognition/jobs/internal/meta-recall-narrative.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-d2-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

function fakeHost(returnContent) {
  let calls = 0;
  return {
    invokeLLM: async () => {
      calls += 1;
      return { content: returnContent, usage: { input_tokens: 100, output_tokens: 200 } };
    },
    get calls() {
      return calls;
    },
  };
}

async function seedCorrected(db, n, opts = {}) {
  for (let i = 0; i < n; i++) {
    await db
      .query(
        surql`CREATE recall_log CONTENT {
        ts: time::now() - 1d,
        session_id: ${`s${i}`},
        query: ${`q${i}`},
        k: 5,
        ranked_hits: ${opts.hits ?? []},
        outcome: 'corrected',
      }`,
      )
      .collect();
  }
}

test('T1 — disabled flag short-circuits', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await seedCorrected(db, 10);
  const result = await runMetaRecallNarrative({ db, embedder: e, host: fakeHost('{}') });
  const summary = JSON.parse(result);
  assert.equal(summary.ran, false);
  assert.equal(summary.reason, 'disabled');
  const [tel] = await db
    .query('SELECT outcome, ts FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1')
    .collect();
  assert.equal(tel?.[0]?.outcome, 'skipped_disabled');
  await close(db);
});

test('T2 — below-threshold short-circuits even when enabled', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await db.query('UPDATE runtime:`meta_cognition.config` SET value.enabled = true').collect();
  await seedCorrected(db, 3); // < default 5
  const result = await runMetaRecallNarrative({ db, embedder: e, host: fakeHost('{}') });
  const summary = JSON.parse(result);
  assert.equal(summary.ran, false);
  assert.equal(summary.reason, 'below_threshold');
  assert.equal(summary.corrected_count, 3);
  const [tel] = await db
    .query(
      'SELECT outcome, corrected_count, ts FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1',
    )
    .collect();
  assert.equal(tel?.[0]?.outcome, 'skipped_below_threshold');
  assert.equal(tel?.[0]?.corrected_count, 3);
  await close(db);
});
