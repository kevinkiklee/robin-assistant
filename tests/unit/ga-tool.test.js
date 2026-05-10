import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createGaRecentTool } from '../../src/integrations/ga/tools/ga-recent.js';

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
        external_id: 'ga:12345:2026-05-09',
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
        external_id: 'ga:12345:2026-05-10',
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
        external_id: 'ga:1:2026-05-09',
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
        external_id: 'sub:c1',
        meta: { kind: 'subscription' },
      }}`,
    )
    .collect();
  const t = createGaRecentTool({ db });
  const r = await t.handler({});
  assert.equal(r.metrics.length, 1);
  await close(db);
});
