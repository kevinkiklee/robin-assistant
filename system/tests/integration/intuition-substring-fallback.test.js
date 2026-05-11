import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { intuitionEndpoint } from '../../cognition/intuition/inject.js';
import { __resetRecallConfigCacheForTests } from '../../cognition/memory/store.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

async function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'robin-fallback-'));
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db
    .query(surql`UPSERT runtime:embedder SET value = { active_profile: 'mxbai-1024' }`)
    .collect();
  return db;
}

test('intuitionEndpoint falls back to substring MMR when mmr_use_cosine=false', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, { source: 'cli', content: 'sourdough recipe one' });
  await recordEvent(db, e, { source: 'cli', content: 'sourdough recipe two' });
  await db.query(surql`UPDATE runtime:recall SET value.mmr_use_cosine = false`).collect();
  __resetRecallConfigCacheForTests();

  await intuitionEndpoint({
    db,
    embedder: e,
    query: 'sourdough',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
    sessionId: 's1',
  });

  const [rows] = await db.query(surql`SELECT meta FROM intuition_telemetry`).collect();
  assert.equal(rows[0].meta?.mmr_path, 'substring');

  await close(db);
});
