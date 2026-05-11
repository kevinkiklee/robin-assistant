import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { loadVectorsForHits } from '../../cognition/intuition/vectors.js';
import * as store from '../../cognition/memory/store.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

async function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'robin-vectors-test-'));
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db
    .query(surql`UPSERT runtime:embedder SET value = { active_profile: 'mxbai-1024' }`)
    .collect();
  return db;
}

test('loadVectorsForHits returns Float32Arrays keyed by string id', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ev = await recordEvent(db, e, { source: 'cli', content: 'planted tomatoes' });
  const memo = await store.note(db, e, 'knowledge', {
    content: 'kevin loves sourdough',
    derived_by: 'manual',
  });
  const map = await loadVectorsForHits(db, {
    eventIds: [ev.id],
    memoIds: [memo.id],
  });
  assert.ok(map instanceof Map);
  assert.ok(map.has(String(ev.id)));
  assert.ok(map.has(String(memo.id)));
  assert.ok(map.get(String(ev.id)) instanceof Float32Array);
  await close(db);
});

test('loadVectorsForHits returns empty Map when both id lists are empty', async () => {
  const db = await fresh();
  const map = await loadVectorsForHits(db, { eventIds: [], memoIds: [] });
  assert.equal(map.size, 0);
  await close(db);
});
