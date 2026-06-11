import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { integrationDegradedInvariant } from './integration-degraded.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-degraded-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function setKv(db: RobinDb, integration: string, key: string, value: string) {
  db.prepare(
    `INSERT INTO integration_state (integration_name, key, value, updated_at)
     VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')
     ON CONFLICT(integration_name, key) DO UPDATE SET value = excluded.value`,
  ).run(integration, key, value);
}

test('degraded: empty DB → ok', async () => {
  const db = freshDb();
  const r = await integrationDegradedInvariant(db).check();
  assert.equal(r.ok, true, JSON.stringify(r));
  closeDb(db);
});

test('degraded: count 2 (below threshold) → ok', async () => {
  const db = freshDb();
  setKv(db, 'whoop', 'degraded:recovery', '2');
  const r = await integrationDegradedInvariant(db).check();
  assert.equal(r.ok, true, 'count 2 is below the threshold of 3');
  closeDb(db);
});

test('degraded: count 3 → fires with integration/stream and count in message', async () => {
  const db = freshDb();
  setKv(db, 'whoop', 'degraded:recovery', '3');
  const r = await integrationDegradedInvariant(db).check();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(r.message?.includes('whoop/recovery'), `expected whoop/recovery in: ${r.message}`);
  assert.ok(r.message?.includes('3 consecutive ticks'), `expected count in: ${r.message}`);
  closeDb(db);
});

test('degraded: count 5 → fires with correct message', async () => {
  const db = freshDb();
  setKv(db, 'whoop', 'degraded:workout', '5');
  const r = await integrationDegradedInvariant(db).check();
  assert.equal(r.ok, false);
  assert.ok(r.message?.includes('whoop/workout'), `expected whoop/workout in: ${r.message}`);
  assert.ok(r.message?.includes('5 consecutive ticks'), `expected count in: ${r.message}`);
  closeDb(db);
});

test('degraded: count reset to 0 (previously degraded, now healthy) → ok', async () => {
  const db = freshDb();
  setKv(db, 'whoop', 'degraded:recovery', '0');
  const r = await integrationDegradedInvariant(db).check();
  assert.equal(r.ok, true, 'a zeroed counter is not degraded');
  closeDb(db);
});

test('degraded: multiple integrations — only those at 3+ fire', async () => {
  const db = freshDb();
  setKv(db, 'whoop', 'degraded:recovery', '3');
  setKv(db, 'whoop', 'degraded:sleep', '1');
  setKv(db, 'linear', 'degraded:issues', '5');
  const r = await integrationDegradedInvariant(db).check();
  assert.equal(r.ok, false);
  assert.ok(r.message?.includes('whoop/recovery'), `expected whoop/recovery: ${r.message}`);
  assert.ok(r.message?.includes('linear/issues'), `expected linear/issues: ${r.message}`);
  assert.ok(
    !r.message?.includes('whoop/sleep'),
    `must not include whoop/sleep (count=1): ${r.message}`,
  );
  closeDb(db);
});

test('degraded: non-degraded keys are not matched (key must start with degraded:)', async () => {
  const db = freshDb();
  // consecutive_errors of 5 must NOT trigger the degraded invariant
  setKv(db, 'whoop', 'consecutive_errors', '5');
  const r = await integrationDegradedInvariant(db).check();
  assert.equal(r.ok, true, 'consecutive_errors is not a degraded: key');
  closeDb(db);
});
