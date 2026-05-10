import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createLrcSummaryTool } from '../../src/integrations/lrc/tools/lrc-summary.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('lrc_summary returns latest captured snapshot', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'lrc',
        content: 'lightroom catalog: 200 photos',
        ts: new Date(),
        external_id: 'lrc:2026-05-10',
        meta: { total_photos: 200 },
      }}`,
    )
    .collect();
  const t = createLrcSummaryTool({ db });
  const r = await t.handler({});
  assert.match(r.summary.content, /200 photos/);
  await close(db);
});

test('lrc_summary returns null on empty DB', async () => {
  const db = await fresh();
  const t = createLrcSummaryTool({ db });
  const r = await t.handler({});
  assert.equal(r.summary, null);
  await close(db);
});
