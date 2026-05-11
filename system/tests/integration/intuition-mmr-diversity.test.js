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
  const home = mkdtempSync(join(tmpdir(), 'robin-diversity-'));
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db
    .query(surql`UPSERT runtime:embedder SET value = { active_profile: 'mxbai-1024' }`)
    .collect();
  return db;
}

test('lowering mmr_threshold increases MMR drops on a near-duplicate corpus', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  // Stub embedder hashes content deterministically — identical content yields
  // identical vectors → cosine ≈ 1.0 between all pairs.
  for (let i = 0; i < 4; i++) {
    await recordEvent(db, e, { source: 'cli', content: 'sourdough recipe' });
  }

  await db.query(surql`UPDATE runtime:recall SET value.mmr_threshold = 0.92`).collect();
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

  await db.query(surql`UPDATE runtime:recall SET value.mmr_threshold = 0.99`).collect();
  __resetRecallConfigCacheForTests();
  await intuitionEndpoint({
    db,
    embedder: e,
    query: 'sourdough',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
    sessionId: 's2',
  });

  const [rows] = await db
    .query(surql`SELECT meta, ts FROM intuition_telemetry ORDER BY ts ASC`)
    .collect();
  assert.equal(rows.length, 2);
  assert.ok(
    rows[0].meta.mmr_drops >= rows[1].meta.mmr_drops,
    `expected drops(0.92)=${rows[0].meta.mmr_drops} >= drops(0.99)=${rows[1].meta.mmr_drops}`,
  );

  await close(db);
});
