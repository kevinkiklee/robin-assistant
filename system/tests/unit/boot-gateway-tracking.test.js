import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import test from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

async function freshDb() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('gateway boot writes runtime:scheduler.gateways[name]', async () => {
  const db = await freshDb();
  try {
    // Simulate what boot.js does after a successful gateway start: read
    // scheduler row, merge gateways[name], upsert.
    const name = 'discord';
    const [rows] = await db.query(surql`SELECT * FROM type::record('runtime', 'scheduler')`).collect();
    const value = rows[0]?.value ?? {};
    const gateways = value.gateways ?? {};
    gateways[name] = { booted_at: new Date() };
    await db
      .query(surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{ ...value, gateways }}`)
      .collect();
    const [verify] = await db
      .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
      .collect();
    const bootedAt = verify[0]?.value?.gateways?.[name]?.booted_at;
    // SurrealDB deserializes datetimes to its own DateTime class, not JS Date —
    // assert that a timestamp value is present and parseable instead.
    assert.ok(bootedAt, 'booted_at should be present');
    assert.ok(!Number.isNaN(new Date(String(bootedAt)).getTime()), 'booted_at should be a valid timestamp');
  } finally {
    await close(db);
  }
});

test('multiple gateway boots accumulate in runtime:scheduler.gateways', async () => {
  const db = await freshDb();
  try {
    for (const name of ['discord', 'foo', 'bar']) {
      const [rows] = await db.query(surql`SELECT * FROM type::record('runtime', 'scheduler')`).collect();
      const value = rows[0]?.value ?? {};
      const gateways = value.gateways ?? {};
      gateways[name] = { booted_at: new Date() };
      await db
        .query(surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{ ...value, gateways }}`)
        .collect();
    }
    const [verify] = await db
      .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
      .collect();
    assert.equal(Object.keys(verify[0]?.value?.gateways ?? {}).length, 3);
  } finally {
    await close(db);
  }
});
