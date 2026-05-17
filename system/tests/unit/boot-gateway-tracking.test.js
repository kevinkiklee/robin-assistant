import { strict as assert } from 'node:assert';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import test from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

// Test fixture: every test in this file talks to a fresh mem:// DB but
// still calls runMigrations() which reads ROBIN_HOME/config/config.json.
// Without this setup the test inherits whatever ROBIN_HOME is in the env
// (and breaks when the install pointer was deleted by another test).
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

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
    const [rows] = await db
      .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
      .collect();
    const value = rows[0]?.value ?? {};
    const gateways = value.gateways ?? {};
    gateways[name] = { booted_at: new Date() };
    await db
      .query(
        surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{ ...value, gateways }}`,
      )
      .collect();
    const [verify] = await db
      .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
      .collect();
    const bootedAt = verify[0]?.value?.gateways?.[name]?.booted_at;
    // SurrealDB deserializes datetimes to its own DateTime class, not JS Date —
    // assert that a timestamp value is present and parseable instead.
    assert.ok(bootedAt, 'booted_at should be present');
    assert.ok(
      !Number.isNaN(new Date(String(bootedAt)).getTime()),
      'booted_at should be a valid timestamp',
    );
  } finally {
    await close(db);
  }
});

test('multiple gateway boots accumulate in runtime:scheduler.gateways', async () => {
  const db = await freshDb();
  try {
    for (const name of ['discord', 'foo', 'bar']) {
      const [rows] = await db
        .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
        .collect();
      const value = rows[0]?.value ?? {};
      const gateways = value.gateways ?? {};
      gateways[name] = { booted_at: new Date() };
      await db
        .query(
          surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{ ...value, gateways }}`,
        )
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
