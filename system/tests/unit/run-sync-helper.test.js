import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { runIntegrationSync } from '../../io/integrations/_framework/run-sync.js';

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

test('finally fallback clears in_flight if catch-path write throws', async () => {
  // Scenario: sync() throws, AND the catch path's writeIntegrationRow throws
  // (simulated transient DB error). Without the finally fallback, in_flight
  // would stay true and wedge the dispatcher. With it, the row is restored.
  const db = await fresh();
  await seedIntegration(db, 'gmail');
  const registry = new Map([
    ['gmail', { cadence_ms: 60_000, sync: async () => { throw new Error('sync boom'); } }],
  ]);

  // Wrap db so the first UPSERT after the in_flight=true setter (i.e. the
  // catch-path write) throws once. The finally fallback's UPSERT then
  // succeeds, restoring the row.
  const realQuery = db.query.bind(db);
  let upsertCount = 0;
  let failedOnce = false;
  db.query = (sql, ...rest) => {
    const text = typeof sql === 'string' ? sql : sql?.query ?? '';
    const isUpsert = /UPSERT|UPDATE/i.test(text);
    if (isUpsert) {
      upsertCount++;
      // 1st upsert = in_flight=true setter (line 78). 2nd = catch path. Fail #2.
      if (upsertCount === 2 && !failedOnce) {
        failedOnce = true;
        return {
          collect: async () => {
            throw new Error('simulated catch-path DB failure');
          },
        };
      }
    }
    return realQuery(sql, ...rest);
  };

  // The catch-path write throws inside runIntegrationSync's catch block,
  // bubbling up. Dispatcher already catches this; what matters is that the
  // finally fallback ran AND restored in_flight before the throw propagated.
  await assert.rejects(
    () => runIntegrationSync(db, registry, 'gmail'),
    /simulated catch-path DB failure/,
  );

  db.query = realQuery; // restore so we can read
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
    .collect();
  const row = rows[0].value.integrations.gmail;
  assert.equal(row.in_flight, false, 'finally fallback must clear in_flight');
  assert.equal(row.in_flight_started_at, null);
  assert.match(row.last_sync_error, /finally-cleanup/);
  assert.equal(failedOnce, true, 'sanity: catch-path failure was simulated');
  await close(db);
});
