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

test('scheduled failure increments consecutive_failures; manual failure does not', async () => {
  const db = await fresh();
  await seed(db, 'gmail', { consecutive_failures: 2 });

  const registry = new Map([
    [
      'gmail',
      {
        cadence_ms: 60_000,
        sync: async () => {
          throw new Error('fail');
        },
      },
    ],
  ]);

  // Scheduled run (no manual flag)
  await runIntegrationSync(db, registry, 'gmail');
  let [rows] = await db.query(surql`SELECT * FROM type::record('runtime', 'scheduler')`).collect();
  assert.equal(rows[0].value.integrations.gmail.consecutive_failures, 3);

  // Manual run — does NOT increment
  await runIntegrationSync(db, registry, 'gmail', { manual: true });
  [rows] = await db.query(surql`SELECT * FROM type::record('runtime', 'scheduler')`).collect();
  assert.equal(rows[0].value.integrations.gmail.consecutive_failures, 3);
  assert.equal(rows[0].value.integrations.gmail.last_sync_ok, false);
  assert.match(rows[0].value.integrations.gmail.last_sync_error, /fail/);
  await close(db);
});
