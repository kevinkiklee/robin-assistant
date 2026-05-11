import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  garbageCollect,
  listAllJobs,
  recordFailure,
  recordSuccess,
  setEnabled,
  setInFlight,
  upsertFromDiscovered,
} from '../../cognition/jobs/db.js';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

const SAMPLE = {
  name: 'foo',
  schedule: '@daily',
  runtime: 'agent',
  enabled: true,
  catch_up: true,
  notify: 'capture',
  notify_on_failure: true,
  timeout_minutes: 10,
  manually_runnable: true,
};

test('upsertFromDiscovered — first call creates row with defaults', async () => {
  const db = await fresh();
  await upsertFromDiscovered(db, [SAMPLE]);
  const rows = await listAllJobs(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'foo');
  assert.equal(rows[0].in_flight, false);
  assert.equal(rows[0].consecutive_failures, 0);
  await close(db);
});

test('upsertFromDiscovered — markdown-authoritative fields update; enabled does NOT', async () => {
  const db = await fresh();
  await upsertFromDiscovered(db, [SAMPLE]);
  await setEnabled(db, 'foo', false); // DB flip
  await upsertFromDiscovered(db, [{ ...SAMPLE, schedule: '@hourly', enabled: true }]);
  const [row] = await listAllJobs(db);
  assert.equal(row.schedule, '@hourly', 'schedule updated from markdown');
  assert.equal(row.enabled, false, 'enabled preserved from DB');
  await close(db);
});

test('garbageCollect — disables rows whose file is gone', async () => {
  const db = await fresh();
  await upsertFromDiscovered(db, [SAMPLE, { ...SAMPLE, name: 'bar' }]);
  await garbageCollect(db, new Set(['foo']));
  const rows = await listAllJobs(db);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(byName.foo.enabled, true);
  assert.equal(byName.bar.enabled, false);
  await close(db);
});

test('setInFlight + recordSuccess', async () => {
  const db = await fresh();
  await upsertFromDiscovered(db, [SAMPLE]);
  await setInFlight(db, 'foo', true);
  let [row] = await listAllJobs(db);
  assert.equal(row.in_flight, true);
  await recordSuccess(db, 'foo', {
    duration_ms: 250,
    next_run_at: new Date(Date.now() + 86_400_000),
  });
  [row] = await listAllJobs(db);
  assert.equal(row.in_flight, false);
  assert.equal(row.last_run_ok, true);
  assert.equal(row.last_duration_ms, 250);
  assert.equal(row.consecutive_failures, 0);
  await close(db);
});

test('recordFailure — bumps consecutive_failures, sets last_error', async () => {
  const db = await fresh();
  await upsertFromDiscovered(db, [SAMPLE]);
  await setInFlight(db, 'foo', true);
  await recordFailure(db, 'foo', {
    error: 'boom',
    duration_ms: 100,
    next_run_at: new Date(Date.now() + 3_600_000),
  });
  const [row] = await listAllJobs(db);
  assert.equal(row.last_run_ok, false);
  assert.equal(row.last_error, 'boom');
  assert.equal(row.consecutive_failures, 1);
  assert.equal(row.in_flight, false);
  await close(db);
});
