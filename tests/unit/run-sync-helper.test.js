import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { runIntegrationSync } from '../../src/integrations/_framework/run-sync.js';

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

async function seedIntegration(db, name, fields = {}) {
  const merged = { cadence_ms: 60_000, consecutive_failures: 0, ...fields };
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
    .collect();
  const value = rows[0]?.value ?? {};
  const integrations = { ...(value.integrations ?? {}), [name]: merged };
  await db
    .query(
      surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{ ...value, integrations }}`,
    )
    .collect();
}

test('runIntegrationSync success path stamps cursor and clears failures', async () => {
  const db = await fresh();
  await seedIntegration(db, 'gmail', { consecutive_failures: 2 });
  const registry = new Map([
    [
      'gmail',
      {
        cadence_ms: 60_000,
        sync: async () => ({ count: 3, cursor: { history_id: 'h1' } }),
      },
    ],
  ]);
  const r = await runIntegrationSync(db, registry, 'gmail');
  assert.equal(r.ok, true);
  assert.equal(r.count, 3);
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
    .collect();
  const row = rows[0].value.integrations.gmail;
  assert.equal(row.consecutive_failures, 0);
  assert.deepEqual(row.cursor, { history_id: 'h1' });
  await close(db);
});

test('runIntegrationSync scheduled failure increments consecutive_failures', async () => {
  const db = await fresh();
  await seedIntegration(db, 'gmail');
  const registry = new Map([
    [
      'gmail',
      {
        cadence_ms: 60_000,
        sync: async () => {
          throw new Error('boom');
        },
      },
    ],
  ]);
  await runIntegrationSync(db, registry, 'gmail');
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
    .collect();
  assert.equal(rows[0].value.integrations.gmail.consecutive_failures, 1);
  await close(db);
});

test('runIntegrationSync manual failure does NOT increment consecutive_failures', async () => {
  const db = await fresh();
  await seedIntegration(db, 'gmail', { consecutive_failures: 2 });
  const registry = new Map([
    [
      'gmail',
      {
        cadence_ms: 60_000,
        sync: async () => {
          throw new Error('boom');
        },
      },
    ],
  ]);
  await runIntegrationSync(db, registry, 'gmail', { manual: true });
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
    .collect();
  const row = rows[0].value.integrations.gmail;
  assert.equal(row.consecutive_failures, 2);
  assert.equal(row.last_sync_ok, false);
  assert.match(row.last_sync_error, /boom/);
  await close(db);
});

test('runIntegrationSync returns in_flight when concurrent', async () => {
  const db = await fresh();
  await seedIntegration(db, 'gmail', { in_flight: true, in_flight_started_at: new Date() });
  const registry = new Map([['gmail', { cadence_ms: 60_000, sync: async () => ({}) }]]);
  const r = await runIntegrationSync(db, registry, 'gmail');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'in_flight');
  await close(db);
});

test('runIntegrationSync rejects gateway integration', async () => {
  const db = await fresh();
  await seedIntegration(db, 'discord', { cadence_ms: null });
  const registry = new Map([['discord', { cadence_ms: null }]]);
  const r = await runIntegrationSync(db, registry, 'discord');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'gateway_no_sync');
  await close(db);
});
