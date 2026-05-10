import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mock, test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createCapture } from '../../src/integrations/_framework/capture.js';
import { sync } from '../../src/integrations/lunch_money/sync.js';

import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';
import { writeConfig as __robinWriteConfig } from '../../src/runtime/config.js';

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

test('lunch_money sync upserts edits to existing transactions', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const capture = createCapture({
    db,
    embedder: e,
    source: 'lunch_money',
    embed: true,
    mode: 'upsert',
  });

  let payload = [
    {
      id: 1,
      amount: '5.00',
      date: '2026-05-09',
      is_income: false,
      payee: 'Coffee',
      category_name: 'Food',
      currency: 'USD',
    },
  ];
  const fetchFn = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ transactions: payload }),
  }));

  const ctx1 = { secrets: { api_key: 'k' }, log: () => {}, cursor: null, capture, fetchFn };
  const r1 = await sync(ctx1);
  assert.equal(r1.count, 1);

  // Edit the transaction (same id, different payee)
  payload = [
    {
      id: 1,
      amount: '5.00',
      date: '2026-05-09',
      is_income: false,
      payee: 'Coffee Shop',
      category_name: 'Food',
      currency: 'USD',
    },
  ];
  const ctx2 = {
    secrets: { api_key: 'k' },
    log: () => {},
    cursor: { start_date: '2026-05-08' },
    capture,
    fetchFn,
  };
  await sync(ctx2);

  const [rows] = await db
    .query(surql`SELECT content FROM events WHERE source = 'lunch_money'`)
    .collect();
  assert.equal(rows.length, 1);
  assert.match(rows[0].content, /Coffee Shop/);
  await close(db);
});
