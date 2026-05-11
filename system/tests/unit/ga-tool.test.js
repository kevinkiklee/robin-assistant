import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createGaRecentTool } from '../../io/integrations/ga/tools/ga-recent.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';

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
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('ga_recent returns latest captured ga events', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'ga',
        content: 'GA4 · 2026-05-09',
        ts: new Date('2026-05-09T00:00:00Z'),
        meta: { date: '2026-05-09', users: 100 },
      }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'ga',
        content: 'GA4 · 2026-05-10',
        ts: new Date('2026-05-10T00:00:00Z'),
        meta: { date: '2026-05-10', users: 200 },
      }}`,
    )
    .collect();
  const t = createGaRecentTool({ db });
  const r = await t.handler({ days: 7 });
  assert.ok(r.metrics.length >= 2);
  assert.equal(r.metrics[0].meta.date, '2026-05-10');
  await close(db);
});

test('ga_recent only returns ga-source events', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'ga',
        content: 'GA4 · 2026-05-09',
        ts: new Date('2026-05-09T00:00:00Z'),
        meta: { date: '2026-05-09' },
      }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'youtube',
        content: 'sub: A',
        ts: new Date('2026-05-09T00:00:00Z'),
        meta: { kind: 'subscription' },
      }}`,
    )
    .collect();
  const t = createGaRecentTool({ db });
  const r = await t.handler({});
  assert.equal(r.metrics.length, 1);
  await close(db);
});
