import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { intuitionEndpoint } from '../../cognition/intuition/inject.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

async function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'robin-intuition-cos-'));
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db
    .query(surql`UPSERT runtime:embedder SET value = { active_profile: 'mxbai-1024' }`)
    .collect();
  return db;
}

test('intuitionEndpoint records mmr_path=cosine when vectors are available', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, { source: 'cli', content: 'sourdough hydration ratio 62%' });
  await recordEvent(db, e, { source: 'cli', content: 'baked another sourdough loaf today' });

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
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta?.mmr_path, 'cosine');
  assert.ok(typeof rows[0].meta?.mmr_drops === 'number');
  assert.ok(rows[0].meta?.mmr_vec_coverage > 0);

  const [recallRows] = await db.query(surql`SELECT meta FROM recall_log`).collect();
  assert.equal(recallRows[0].meta?.from, 'intuition');
  assert.ok(typeof recallRows[0].meta?.latency_ms === 'number');

  // Spec §7 regression guard (not a budget): the new vector-hydration
  // round-trip must not blow the endpoint past 200 ms on the embedded
  // engine. Large jumps indicate a second round-trip or an unintended
  // network call.
  assert.ok(
    recallRows[0].meta.latency_ms < 200,
    `latency_ms = ${recallRows[0].meta.latency_ms}; expected < 200 (regression guard)`,
  );

  // Phase 11 contract: D1 has not shipped yet → focus_block_present
  // must default to false on the recall_log row.
  assert.equal(recallRows[0].meta?.focus_block_present, false);
  assert.equal(recallRows[0].meta?.focus_block_tokens, 0);

  await close(db);
});
