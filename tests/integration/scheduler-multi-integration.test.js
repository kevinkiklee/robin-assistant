import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { runIntegrationSync } from '../../src/integrations/_framework/run-sync.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

async function seed(db, name, fields = {}) {
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

test('two integrations sync independently without cross-blocking', async () => {
  const db = await fresh();
  await seed(db, 'gmail');
  await seed(db, 'lunch_money', { cadence_ms: 86_400_000 });
  const calls = [];
  const registry = new Map([
    [
      'gmail',
      {
        cadence_ms: 60_000,
        sync: async () => {
          calls.push('gmail');
          return { count: 0, cursor: null };
        },
      },
    ],
    [
      'lunch_money',
      {
        cadence_ms: 86_400_000,
        sync: async () => {
          calls.push('lunch_money');
          return { count: 0, cursor: null };
        },
      },
    ],
  ]);

  const r1 = await runIntegrationSync(db, registry, 'gmail');
  const r2 = await runIntegrationSync(db, registry, 'lunch_money');
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.deepEqual(calls.sort(), ['gmail', 'lunch_money']);

  // Both rows updated with last_sync_ok
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
    .collect();
  assert.equal(rows[0].value.integrations.gmail.last_sync_ok, true);
  assert.equal(rows[0].value.integrations.lunch_money.last_sync_ok, true);
  await close(db);
});
