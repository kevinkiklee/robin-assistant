import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { resetInFlightFlags } from '../../io/integrations/_framework/boot-cleanup.js';

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

test('resetInFlightFlags clears stale in_flight: true rows', async () => {
  const db = await fresh();
  await db
    .query(
      surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{
        integrations: {
          gmail: { in_flight: true, last_sync_at: new Date() },
          lunch_money: { in_flight: false },
        },
      }}`,
    )
    .collect();
  const r = await resetInFlightFlags(db);
  assert.equal(r.reset, 1);
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
    .collect();
  assert.equal(rows[0].value.integrations.gmail.in_flight, false);
  await close(db);
});

test('resetInFlightFlags is no-op when no scheduler row', async () => {
  const db = await fresh();
  const r = await resetInFlightFlags(db);
  assert.equal(r.reset, 0);
  await close(db);
});

test('resetInFlightFlags is no-op when integrations empty', async () => {
  const db = await fresh();
  await db
    .query(surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{ integrations: {} }}`)
    .collect();
  const r = await resetInFlightFlags(db);
  assert.equal(r.reset, 0);
  await close(db);
});
