import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createLunchMoneyQueryTool } from '../../io/integrations/lunch_money/tools/lunch-money-query.js';

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

test('lunch_money_query returns rows filtered by payee', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'lunch_money',
        content: 'Coffee · -$5 · Food',
        ts: new Date('2026-05-09'),
        meta: { payee: 'Coffee Co', amount: 5, date: '2026-05-09', category: 'Food' },
      }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'lunch_money',
        content: 'Gas · -$30 · Auto',
        ts: new Date('2026-05-08'),
        meta: { payee: 'Shell', amount: 30, date: '2026-05-08', category: 'Auto' },
      }}`,
    )
    .collect();
  const t = createLunchMoneyQueryTool({ db });
  const r = await t.handler({ payee_contains: 'coffee' });
  assert.equal(r.transactions.length, 1);
  assert.match(r.transactions[0].content, /Coffee/);
  await close(db);
});

test('lunch_money_query filters by min_amount', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'lunch_money',
        content: 'a',
        ts: new Date(),
        meta: { amount: 5 },
      }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'lunch_money',
        content: 'b',
        ts: new Date(),
        meta: { amount: 50 },
      }}`,
    )
    .collect();
  const t = createLunchMoneyQueryTool({ db });
  const r = await t.handler({ min_amount: 10 });
  assert.equal(r.transactions.length, 1);
  await close(db);
});
