import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createLrcSummaryTool } from '../../io/integrations/lrc/tools/lrc-summary.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
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
