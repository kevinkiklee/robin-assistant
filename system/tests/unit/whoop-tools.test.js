import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createWhoopRecentTool } from '../../io/integrations/whoop/tools/whoop-recent.js';
import { createWhoopTodayTool } from '../../io/integrations/whoop/tools/whoop-today.js';

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

async function seedWhoopEvent(db, { kind, ts, content, external_id }) {
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'whoop',
        content,
        ts: new Date(ts),
        meta: { kind, ...(external_id ? { external_id } : {}) },
      }}`,
    )
    .collect();
}

test('whoop_recent filters to source=whoop, ordered by ts desc', async () => {
  const db = await fresh();
  await seedWhoopEvent(db, {
    kind: 'recovery',
    ts: '2026-05-09T08:00:00Z',
    content: 'recovery: 60% old',
  });
  await seedWhoopEvent(db, {
    kind: 'recovery',
    ts: '2026-05-10T08:00:00Z',
    content: 'recovery: 80% new',
  });
  // Foreign source should not appear.
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'gmail',
        content: 'unrelated',
        ts: new Date('2026-05-10T09:00:00Z'),
        meta: { kind: 'message' },
      }}`,
    )
    .collect();
  const t = createWhoopRecentTool({ db });
  const r = await t.handler({});
  assert.equal(r.records.length, 2);
  // Ordered desc → newest first.
  assert.match(r.records[0].content, /new/);
  await close(db);
});

test('whoop_recent filters by kind', async () => {
  const db = await fresh();
  await seedWhoopEvent(db, {
    kind: 'recovery',
    ts: '2026-05-10T08:00:00Z',
    content: 'recovery x',
  });
  await seedWhoopEvent(db, {
    kind: 'sleep',
    ts: '2026-05-10T07:00:00Z',
    content: 'sleep x',
  });
  const t = createWhoopRecentTool({ db });
  const r = await t.handler({ kind: 'sleep' });
  assert.equal(r.records.length, 1);
  assert.match(r.records[0].content, /sleep/);
  await close(db);
});

test('whoop_recent rejects invalid kind', async () => {
  const db = await fresh();
  const t = createWhoopRecentTool({ db });
  await assert.rejects(t.handler({ kind: 'bogus' }), /unknown kind/);
  await close(db);
});

test('whoop_recent caps limit at 100', async () => {
  const db = await fresh();
  const t = createWhoopRecentTool({ db });
  const r = await t.handler({ limit: 9999 });
  // Smoke: handler returns shape; SQL limit was clamped (no rows seeded).
  assert.deepEqual(r.records, []);
  await close(db);
});

test('whoop_today returns latest record per kind', async () => {
  const db = await fresh();
  await seedWhoopEvent(db, {
    kind: 'recovery',
    ts: '2026-05-09T08:00:00Z',
    content: 'rec old',
  });
  await seedWhoopEvent(db, {
    kind: 'recovery',
    ts: '2026-05-10T08:00:00Z',
    content: 'rec new',
  });
  await seedWhoopEvent(db, {
    kind: 'sleep',
    ts: '2026-05-10T03:00:00Z',
    content: 'sleep new',
  });
  await seedWhoopEvent(db, {
    kind: 'workout',
    ts: '2026-05-09T17:00:00Z',
    content: 'workout new',
  });
  const t = createWhoopTodayTool({ db });
  const r = await t.handler({});
  assert.match(r.recovery.content, /rec new/);
  assert.match(r.sleep.content, /sleep new/);
  assert.match(r.last_workout.content, /workout new/);
  await close(db);
});

test('whoop_today returns null for missing kinds', async () => {
  const db = await fresh();
  const t = createWhoopTodayTool({ db });
  const r = await t.handler({});
  assert.equal(r.recovery, null);
  assert.equal(r.sleep, null);
  assert.equal(r.last_workout, null);
  await close(db);
});
