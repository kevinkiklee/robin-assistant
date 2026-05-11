import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { evaluateStateInference } from '../../cognition/jobs/internal/state-inference.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-ev-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('evaluateStateInference returns skipped_disabled when cfg.enabled=false', async () => {
  const db = await fresh();
  // Rollout migrations 0013/0014 may pre-flip the seed; force false here.
  await db
    .query(`UPDATE runtime:\`state_inference.config\` SET value.enabled = false`)
    .collect();
  const e = createStubEmbedder({ dimension: 1024 });
  const host = { invokeLLM: async () => ({ content: '{}', tokens_in: 0, tokens_out: 0 }) };
  const r = await evaluateStateInference({ db, host, embedder: e });
  assert.equal(r.outcome, 'skipped_disabled');
  await close(db);
});

test('evaluateStateInference no active sources → outcome=no_active_sources', async () => {
  const db = await fresh();
  await db
    .query(
      `UPDATE runtime:\`state_inference.config\` SET value.enabled = 'shadow'`,
    )
    .collect();
  const e = createStubEmbedder({ dimension: 1024 });
  const host = { invokeLLM: async () => ({ content: '{}' }) };
  const r = await evaluateStateInference({ db, host, embedder: e });
  assert.equal(r.outcome, 'no_active_sources');
  await close(db);
});

test('evaluateStateInference caps fan-out to cfg.max_sources_per_tick', async () => {
  const db = await fresh();
  await db
    .query(
      `UPDATE runtime:\`state_inference.config\` SET value.enabled = 'shadow', value.max_sources_per_tick = 2`,
    )
    .collect();
  for (const s of ['a', 'b', 'c', 'd', 'e']) {
    await db
      .query(
        `CREATE episodes CONTENT { source: $s, started_at: time::now() - 1m, last_event_at: time::now() }`,
        { s },
      )
      .collect();
  }
  const emb = createStubEmbedder({ dimension: 1024 });
  const host = { invokeLLM: async () => ({ content: '{}' }) };
  const r = await evaluateStateInference({ db, host, embedder: emb });
  assert.equal(r.sources_evaluated, 2);
  await close(db);
});
