import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { resetInFlightFlags } from '../../src/integrations/_framework/boot-cleanup.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
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
