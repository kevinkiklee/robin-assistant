import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createChromeRecentVisitsTool } from '../../src/integrations/chrome/tools/chrome-recent-visits.js';
import { createChromeTopDomainsTool } from '../../src/integrations/chrome/tools/chrome-top-domains.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('chrome_recent_visits filters by meta.kind = visit', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'chrome',
        content: 'visit: foo',
        ts: new Date('2026-05-10T12:00:00Z'),
        external_id: 'chrome:visit:1',
        meta: { kind: 'visit' },
      }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'chrome',
        content: 'top domains today: a (1)',
        ts: new Date('2026-05-10T12:00:00Z'),
        external_id: 'chrome:top_domains:2026-05-10',
        meta: { kind: 'top_domains', date: '2026-05-10' },
      }}`,
    )
    .collect();
  const t = createChromeRecentVisitsTool({ db });
  const r = await t.handler({});
  assert.equal(r.visits.length, 1);
  assert.match(r.visits[0].content, /visit/);
  await close(db);
});

test('chrome_top_domains returns only aggregation events', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'chrome',
        content: 'visit: bar',
        ts: new Date('2026-05-10T12:00:00Z'),
        external_id: 'chrome:visit:42',
        meta: { kind: 'visit' },
      }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'chrome',
        content: 'top domains today: a, b',
        ts: new Date('2026-05-10T12:00:00Z'),
        external_id: 'chrome:top_domains:2026-05-10',
        meta: {
          kind: 'top_domains',
          date: '2026-05-10',
          domains: [{ domain: 'a', count: 1 }],
        },
      }}`,
    )
    .collect();
  const t = createChromeTopDomainsTool({ db });
  const r = await t.handler({});
  assert.equal(r.aggregations.length, 1);
  assert.equal(r.aggregations[0].meta.kind, 'top_domains');
  assert.equal(r.aggregations[0].meta.date, '2026-05-10');
  await close(db);
});

test('chrome_recent_visits respects limit argument', async () => {
  const db = await fresh();
  for (let i = 1; i <= 5; i++) {
    await db
      .query(
        surql`CREATE events CONTENT ${{
          source: 'chrome',
          content: `visit ${i}`,
          ts: new Date(`2026-05-10T12:00:0${i}Z`),
          external_id: `chrome:visit:${i}`,
          meta: { kind: 'visit' },
        }}`,
      )
      .collect();
  }
  const t = createChromeRecentVisitsTool({ db });
  const r = await t.handler({ limit: 3 });
  assert.equal(r.visits.length, 3);
  await close(db);
});
