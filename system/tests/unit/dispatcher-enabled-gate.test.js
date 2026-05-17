import { strict as assert } from 'node:assert';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import test from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { setIntegrationEnabled } from '../../data/runtime/integrations-state.js';
import { createDispatcherTick } from '../../runtime/daemon/dispatcher-tick.js';

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

async function seedSchedulerDue(db, name, cadenceMs = 60_000) {
  await db
    .query(
      surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{
        integrations: {
          [name]: {
            cadence_ms: cadenceMs,
            next_run_at: new Date(Date.now() - 1000),
            consecutive_failures: 0,
            in_flight: false,
          },
        },
      }}`,
    )
    .collect();
}

function makeRegistry(name, syncFn) {
  return new Map([
    [
      name,
      {
        name,
        cadence_ms: 60_000,
        capture: () => {},
        sync: syncFn,
      },
    ],
  ]);
}

function makeCtx(db, registry) {
  return {
    db,
    jobs: { cache: { current: [] }, refresh: async () => {} },
    registry,
    capture: { forJobs: () => {} },
    host: {},
    embedder: { wrap: {}, idle: { get: async () => ({}) } },
  };
}

// runOneItem is dispatched without await inside the tick. Give the microtask
// queue + DB writes a moment to settle before asserting.
async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs).unref());
  }
  throw new Error('waitFor: timed out');
}

test('dispatcher skips disabled integration even when due', async () => {
  const db = await freshDb();
  try {
    let ranFor = null;
    const registry = makeRegistry('spotify', async () => {
      ranFor = 'spotify';
      return { count: 0 };
    });
    await seedSchedulerDue(db, 'spotify');
    // spotify is NOT in runtime:integrations.states → disabled by default.
    const tick = createDispatcherTick(makeCtx(db, registry), []);
    await tick();
    // Give any (incorrectly) dispatched sync a chance to run; assert it did not.
    await new Promise((r) => setTimeout(r, 100).unref());
    assert.equal(ranFor, null, 'sync should NOT have run for disabled integration');
  } finally {
    await close(db);
  }
});

test('dispatcher runs enabled integration when due', async () => {
  const db = await freshDb();
  try {
    let ranFor = null;
    const registry = makeRegistry('spotify', async () => {
      ranFor = 'spotify';
      return { count: 0 };
    });
    await seedSchedulerDue(db, 'spotify');
    await setIntegrationEnabled(db, 'spotify', { enabled: true, source: 'user-data' });
    const tick = createDispatcherTick(makeCtx(db, registry), []);
    await tick();
    await waitFor(() => ranFor === 'spotify');
    assert.equal(ranFor, 'spotify');
  } finally {
    await close(db);
  }
});

test('dispatcher re-reads state when rev advances', async () => {
  const db = await freshDb();
  try {
    let runCount = 0;
    const registry = makeRegistry('spotify', async () => {
      runCount += 1;
      return { count: 0 };
    });
    await seedSchedulerDue(db, 'spotify');
    // First tick: disabled → does not run.
    const tick = createDispatcherTick(makeCtx(db, registry), []);
    await tick();
    await new Promise((r) => setTimeout(r, 50).unref());
    assert.equal(runCount, 0);

    // Enable. Rev advances. Reseed `next_run_at` because the previous tick
    // didn't run, so the scheduler row wasn't updated — already due. Then
    // tick again; cache should refresh on rev change.
    await setIntegrationEnabled(db, 'spotify', { enabled: true, source: 'user-data' });
    await seedSchedulerDue(db, 'spotify');
    await tick();
    await waitFor(() => runCount === 1);
    assert.equal(runCount, 1);
  } finally {
    await close(db);
  }
});
